// The GPT-Live link: opening a realtime session and every handler on it (startLive), letting one go
// (retireLive), the MAX_LIVE_SESSIONS slot, the reconnect plan, pause and resume, the persona rebuild,
// delegation, the turn each tool call is judged under, and the model's audio as it arrives.
//
// Writes: live, closingLive, rebuildingLive, liveReconnectTimer, liveStableTimer, liveFailures,
// lastFatalCode, lastLiveError, lastUsageMinute, liveErrorCount, liveErrorSince, liveBlockedReason,
// liveBlockedSince, paused, quotaBlocked, greeted, pendingIntro, turnsByDelegation, lastTurn.
// Shared: lastAssistantSpokeAt is written here by onAssistantAudio and by runTtsQueue (localvoice.js).
// dispose() lets go of live and stop() clears liveReconnectTimer as well. The 'ready' handler reaches
// into other modules' state on purpose: it flushes and clears transcriptBuffers (transcript.js),
// resets lastAnnouncedUser and clears memoryHinted (speakers.js), and leaves the local brain
// (localvoice.js).
// Reads only: cfg, quota, canOpenLive, createLive, onLiveSlotFreed, shuttingDown, brain and localMode
// (localvoice.js), voice, guild, attribution, idle, latency, trace, music, recentSpeakers
// (speakers.js), taskDeps, runTask.

import { peakOf } from '../audio.js';
import { t } from '../i18n/index.js';
import { describeLiveError } from '../live.js';
import { SessionUsage } from '../quota.js';
import { callTool, toolDefinitions, toolOutput } from '../tools.js';
import {
	AUDIO_PEAK_MIN,
	FATAL_RETRY_MS,
	INTRO_QUIET_MS,
	LIVE_ERROR_LIMIT,
	LIVE_ERROR_WINDOW_MS,
	LIVE_STABLE_MS,
	MIN_LOGGED_MS,
	SILENCE_GAP_MS,
	TURN_MEMORY,
} from './constants.js';

export const liveLinkMethods = {
	startLive() {
		if (this.shuttingDown || this.live || this.paused) return;
		if (this.cfg.brainMode === 'local') return; // GPT-Live is never used
		if (this.quotaBlocked && this.quota.status().exceeded) return;
		// Cost cap (MAX_LIVE_SESSIONS): the decision belongs here, where the session would open the socket,
		// so every path into a realtime connection (join, resume, retry, persona rebuild) passes it. A guild
		// over the cap stays silent — music and tools still work — and gets its turn when a session closes.
		if (!this.canOpenLive(this)) {
			if (!this.liveBlockedReason) {
				const guild = this.guild?.name ?? this.guild?.id ?? '?';
				this.log(t('runtime.live_cap_reached', { guild, max: this.cfg.maxLiveSessions }));
				this.liveBlockedSince = Date.now();
			}
			this.liveBlockedReason = t('runtime.live_cap_reason', { max: this.cfg.maxLiveSessions });
			return;
		}
		this.liveBlockedReason = null;
		this.liveBlockedSince = 0;
		this.quotaBlocked = false;
		if (this.liveReconnectTimer) {
			clearTimeout(this.liveReconnectTimer);
			this.liveReconnectTimer = null;
		}
		const cfg = this.cfg;
		const current = this.persona();
		const session = this.createLive({
			apiKey: cfg.openaiApiKey,
			baseURL: cfg.baseURL,
			model: cfg.liveModel,
			voice: current.voice,
			instructions: current.instructions,
			debug: cfg.debug,
			name: current.name,
			// Responses delegation: the tools live in the backend model. When it is off (client delegation) only
			// the regex voice commands and research through the provider work.
			delegationModel: cfg.useResponsesDelegation ? cfg.researchModel : null,
			backendEffort: cfg.backendEffort,
			backendTier: cfg.backendTier,
			tools: toolDefinitions(),
			toolExecutor: async (name, args, meta = {}) => {
				// The gate looks at the moment the tool call was born in (so people cutting in cannot change it).
				const turn = this.turnFor(meta.delegationId);
				return toolOutput(await callTool(name, args, turn ? { ...this.taskDeps, currentTurn: () => turn } : this.taskDeps));
			},
		});
		this.live = session;
		// Every handler below first asks whether this is still the guild's session. A session that was
		// replaced (a persona rebuild), paused or given up on keeps emitting until its socket is gone: a late
		// 'ready' from it reset the attribution under the new session, a late 'turn' marked a turn on the new
		// session's clock, and a late 'usage' could close the new session over the quota.
		const isCurrent = () => this.live === session;
		// This session's running usage total; the shared quota takes only the difference (see quota.js).
		const usage = new SessionUsage(this.quota);
		// A session ends once. A handshake failure is seen twice -- as 'closed' and as connect()'s rejection
		// -- and planning the retry from both doubled the back-off and the log line; whichever comes first
		// decides, and the other finds the session already ended.
		let ended = false;
		const end = (why, err) => {
			if (ended) return;
			ended = true;
			if (!isCurrent()) return; // replaced or paused on purpose: whoever did that decides what comes next
			this.live = null;
			this.clearLiveStableTimer();
			this.reportHealth(t('runtime.health_why_closed'));
			this.lastLiveError = null;
			if (this.shuttingDown || this.paused) return;
			this.scheduleLiveRetry(why, err);
		};

		session.on('ready', ({ sessionId }) => {
			if (!isCurrent()) return;
			// The failure count is forgiven only once the session has stayed up for a while: a server that
			// accepts and then drops the session at once would otherwise be retried every second forever.
			this.clearLiveStableTimer();
			this.liveStableTimer = setTimeout(() => {
				this.liveStableTimer = null;
				if (!isCurrent() || !session.ready) return;
				this.liveFailures = 0;
				this.lastFatalCode = null;
			}, LIVE_STABLE_MS);
			this.liveStableTimer.unref?.();
			this.idle.touch();
			this.exitLocalBrain(t('runtime.reason_live_back'));
			// Half-said lines belong to the timeline that is ending: finish them while the old track can
			// still say who spoke them, then drop the buffers, so that no position from the old timeline is
			// ever compared against the new counter.
			for (const key of this.transcriptBuffers.keys()) this.flushTranscript(key);
			this.transcriptBuffers.clear();
			this.attribution.resetSession(); // in a new session the audio position starts from 0
			this.trace?.session(this.live?.sessionId ?? null);
			this.activity.push({ kind: 'session', text: t('runtime.live_session_open', { sessionId: sessionId ?? '?' }), meta: { sessionId } });
			this.log(
				t('runtime.live_ready', {
					sessionId,
					model: cfg.liveModel,
					voice: current.voice,
					character: current.name ? t('runtime.live_ready_character', { name: current.name }) : '',
					tools: cfg.useResponsesDelegation ? t('runtime.tools_backend') : t('runtime.tools_client'),
				}),
			);
			if (this.pendingIntro) {
				this.pendingIntro = false;
				const lastHeard = this.recentSpeakers.size ? Math.max(...this.recentSpeakers.values()) : 0;
				// The introduction is a reply of its own. If somebody has just spoken to the bot, the answer
				// to them is the reply for this moment; saying both is how two voices land on one turn.
				if (lastHeard && Date.now() - lastHeard < INTRO_QUIET_MS) this.log(t('runtime.log_intro_skipped'));
				else session.appendContext('commentary', t('runtime.intro_prompt'));
			} else if (cfg.greetText && !this.greeted) {
				this.greeted = true;
				session.appendContext('instructions', t('runtime.greet_prompt', { text: cfg.greetText }));
				// A nudge: after the instruction a short commentary gets the model talking.
				session.appendContext('commentary', t('runtime.greet_nudge'));
			}
			if (this.music?.playing) session.appendContext('thinking', t('runtime.music_context', { title: this.music.current?.title ?? '' }));
			this.lastAnnouncedUser = null; // a new session: announce the speaker again
			this.memoryHinted.clear();
			this.announceRoster();
		});
		session.on('audio', (buffer) => {
			if (isCurrent()) this.onAssistantAudio(buffer);
		});
		session.on('transcript', (event) => {
			if (!isCurrent()) return; // a trailing delta from a socket that has already been replaced
			this.onTranscript(event);
		});
		session.on('tool', (event) => this.onToolEvent(event, 'backend'));
		session.on('backend', ({ ms }) => {
			this.activity.push({
				kind: 'latency',
				whoName: 'backend',
				text: t('runtime.seconds_value', { seconds: (ms / 1000).toFixed(1) }),
				meta: { type: t('runtime.latency_kind_backend') },
			});
			this.log(t('runtime.log_latency_backend', { seconds: (ms / 1000).toFixed(1) }));
		});
		session.on('turn', ({ delegationId = null } = {}) => {
			if (!isCurrent()) return;
			// The model started replying: from here on, people cutting in do not affect this turn's owner gate.
			this.rememberTurn(delegationId, this.attribution.markTurn());
		});
		session.on('delegation', (delegation) => {
			if (!isCurrent()) return;
			// The answer goes back on the session that asked, never on whichever one is current by then.
			void this.handleDelegation(delegation, session);
		});
		session.on('usage', ({ seconds }) => {
			// The seconds were really used, so they are charged whichever session reported them: against
			// this session's own running total, which is what keeps a late report from counting twice.
			const { status } = usage.report(seconds);
			// Everything else -- the log line, the warning, closing on an exhausted quota -- is about the
			// session the guild holds now, and a stale one would pause its successor.
			if (!isCurrent()) return;
			const minute = Math.floor(seconds / 60);
			if (minute !== this.lastUsageMinute) {
				this.lastUsageMinute = minute;
				this.log(
					t('runtime.live_session_seconds', {
						seconds: Math.round(seconds),
						quota: this.quota.enabled
							? t('runtime.live_session_quota_suffix', { used: Math.round(status.used / 60), limit: Math.round(status.limit / 60) })
							: '',
					}),
				);
			}
			if (this.quota.shouldWarn()) {
				this.notifyOwner(t('runtime.quota_warning', { used: Math.round(status.used / 60), limit: Math.round(status.limit / 60) }));
			}
			if (status.exceeded && !this.quotaBlocked) {
				this.quotaBlocked = true;
				this.activity.push({ kind: 'session', text: t('runtime.quota_exceeded_activity', { limit: Math.round(status.limit / 60) }) });
				this.notifyOwner(t('runtime.quota_exceeded_dm'));
				this.pauseLive(t('runtime.reason_quota_exceeded'));
			}
		});
		session.on('error', (err) => {
			// A session the guild has let go of is closing anyway; its errors say nothing about the new one
			// and must not count towards the new one's limit.
			if (!isCurrent()) return;
			const info = describeLiveError(err);
			this.lastLiveError = err; // if the connection closes next, the retry plan should know the reason
			// Permanent errors are written as one line when the retry is planned; they are not printed again here.
			if (!info.fatal) this.log(t('runtime.live_error', { code: info.code ? ` (${info.code})` : '', message: info.message }));
			// A socket that stays open while every request on it fails is worse than one that closes: the
			// assistant keeps answering as if the work were done. After a few failures in a row the session
			// is treated as gone, which is what starts the retry and the fallback to the local brain.
			const now = Date.now();
			if (now - this.liveErrorSince > LIVE_ERROR_WINDOW_MS) {
				this.liveErrorSince = now;
				this.liveErrorCount = 0;
			}
			this.liveErrorCount++;
			if (info.fatal || this.liveErrorCount >= LIVE_ERROR_LIMIT) {
				this.liveErrorCount = 0;
				this.log(t('runtime.live_unusable', { message: info.message }));
				// Closing it ourselves makes its 'closed' an expected one, which used to be the end of it: no
				// retry, no local brain, and not paused either, so speech did not bring it back. The end is
				// therefore planned here, with the error that caused it, before the socket is let go of.
				end(t('runtime.reason_live_unusable'), err);
				void this.retireLive(session);
			}
		});
		session.on('warning', (message) => this.log(t('runtime.live_warning', { message })));
		// The realtime protocol's own events, under their own switch. DEBUG is for reading what the bot
		// decided about who said what; this is the wire, and at several lines a second it buries that.
		// DEBUG_LIVE=1 turns it on, still without the streaming chunks, which are a chunk of a larger
		// thing rather than an event worth a line.
		if (cfg.debugLive) {
			session.on('debug', (event) => {
				const type = String(event?.type ?? '');
				if (type.endsWith('.delta') || type.endsWith('.event')) return;
				this.log('live>', type);
			});
		}

		session.on('closed', ({ code, reason }) => {
			// Every close that reaches here while the session is still the guild's own is one nobody asked
			// for: a pause, a rebuild or an unusable session has already let go of it (and planned what next).
			end(t('runtime.retry_why_closed', { detail: `${code}${reason ? ` ${reason}` : ''}` }), this.lastLiveError);
			this.releaseLiveSlot();
		});

		session.connect().catch((err) => {
			end(t('runtime.retry_why_connect_failed'), err);
			void this.retireLive(session);
		});
	},

	/**
	 * Lets go of a realtime session that is no longer this.live and closes it. Until its socket is gone it
	 * still holds the guild's MAX_LIVE_SESSIONS slot: a close can take seconds, and a slot counted free from
	 * the moment the session was told to close let another server open while this one was still connected.
	 */
	retireLive(session) {
		if (!session) return Promise.resolve(false);
		// Let go of twice (an unusable session, then the guild disposed): the second caller waits for the
		// same close rather than being told at once that it is over.
		const pending = this.closingLive.get(session);
		if (pending) return pending;
		// Called synchronously (an async function runs up to its first await), so the session stops taking
		// audio at once; a throw becomes a rejection like any other failure to close.
		const closing = (async () => session.close())()
			.catch(() => false)
			.finally(() => {
				this.closingLive.delete(session);
				this.releaseLiveSlot();
			});
		this.closingLive.set(session, closing);
		return closing;
	},

	/** A socket of this guild is gone: when that leaves no slot held, the registry may hand it on. */
	releaseLiveSlot() {
		if (this.holdsLiveSlot()) return;
		this.onLiveSlotFreed?.(this);
	},

	/**
	 * Whether this guild counts against MAX_LIVE_SESSIONS: a session open, connecting, or still closing, or
	 * one being rebuilt with a new persona.
	 */
	holdsLiveSlot() {
		return Boolean(this.live) || this.closingLive.size > 0 || this.rebuildingLive > 0;
	},

	/**
	 * The registry offers a slot that came free. It is taken only by a guild that is waiting for one and has
	 * somebody in its channel to talk to; an empty channel leaves it for a busier one and asks again when
	 * somebody speaks.
	 * @returns {boolean} whether a session is now being opened here
	 */
	takeLiveSlot() {
		if (!this.liveBlockedReason || this.live || this.paused || this.shuttingDown || this.brain === 'local') return false;
		if (!this.voice.connected || !this.peopleInVoice()) return false;
		this.startLive();
		return Boolean(this.live);
	},

	clearLiveStableTimer() {
		if (this.liveStableTimer) clearTimeout(this.liveStableTimer);
		this.liveStableTimer = null;
	},

	/**
	 * The reconnection plan. Temporary errors back off exponentially (1 s -> 30 s); permanent ones (credit,
	 * key) use a 10 min interval, one readable log line and a single DM to the owner (so the log stays clean).
	 */
	scheduleLiveRetry(why, err = null) {
		const info = err ? describeLiveError(err) : null;
		let delay;
		if (info?.fatal) {
			delay = FATAL_RETRY_MS;
			const detail = `${info.code ?? info.type}: ${info.message}`;
			this.log(
				t('runtime.live_retry_fatal', {
					why,
					detail,
					hint: info.hint ? `\n            ${info.hint}` : '',
					minutes: Math.round(delay / 60_000),
				}),
			);
			if (this.lastFatalCode !== info.code) {
				this.lastFatalCode = info.code;
				this.activity.push({ kind: 'session', text: t('runtime.live_fatal_activity', { detail }), meta: { code: info.code, hint: info.hint } });
				this.notifyOwner(
					t('runtime.live_fatal_dm', { code: info.code ?? info.type, message: info.message, hint: info.hint ? `\n${info.hint}` : '' }),
				);
			}
			// Voice chat without OpenAI: fall back to the local brain (whisper + DeepSeek + Chatterbox) when it is ready.
			if (this.cfg.brainMode === 'auto' && this.voice.connected) void this.enterLocalBrain(info.code ?? t('runtime.reason_live_down'));
		} else {
			this.lastFatalCode = null;
			delay = Math.min(30_000, 1000 * 2 ** Math.min(this.liveFailures++, 5));
			const detail = info ? ` (${info.code ? `${info.code}: ` : ''}${info.message})` : '';
			this.log(t('runtime.live_retry_soon', { why, detail, seconds: Math.round(delay / 1000) }));
		}
		if (this.liveReconnectTimer) clearTimeout(this.liveReconnectTimer);
		this.liveReconnectTimer = setTimeout(() => {
			this.liveReconnectTimer = null;
			if (!this.paused) this.startLive();
		}, delay);
		if (info?.fatal && typeof this.liveReconnectTimer.unref === 'function') this.liveReconnectTimer.unref();
	},

	pauseLive(reason) {
		this.paused = true;
		// Paused is a state of its own: a guild that was waiting for a slot is not waiting any more, and the
		// registry must not hand it one.
		this.liveBlockedReason = null;
		this.liveBlockedSince = 0;
		if (this.liveReconnectTimer) {
			clearTimeout(this.liveReconnectTimer);
			this.liveReconnectTimer = null;
		}
		if (!this.live) return;
		const session = this.live;
		this.live = null;
		this.clearLiveStableTimer();
		void this.retireLive(session);
		this.activity.push({ kind: 'session', text: t('runtime.live_paused', { reason }) });
		this.log(t('runtime.live_paused_log', { reason }));
	},

	/**
	 * Somebody started speaking while no realtime session is open on purpose: paused (idle, quota) or held
	 * back by MAX_LIVE_SESSIONS. A paused guild reopens; a guild over the cap was not paused, so speech used
	 * to change nothing for it -- it asks the registry again, quietly, and opens only when a slot is free.
	 */
	resumeOnSpeech() {
		if (this.live || this.shuttingDown) return;
		if (this.quotaBlocked && this.quota.status().exceeded) return;
		if (!this.paused && !this.canOpenLive(this)) return;
		this.log(t('runtime.speech_detected'));
		this.resumeLive();
	},

	resumeLive() {
		if (this.live) return;
		if (this.quotaBlocked) {
			if (this.quota.status().exceeded) return; // stays closed until the day rolls over
			this.quotaBlocked = false;
		}
		this.paused = false;
		this.startLive();
	},

	/** The character changed: the live session is rebuilt with the new instructions. */
	async refreshPersona(reason) {
		const current = this.persona();
		this.log(t('runtime.persona_updated', { reason, name: current.name ?? t('runtime.persona_default') }));
		if (!this.live) {
			if (!this.paused) this.startLive();
			return;
		}
		this.pendingIntro = true;
		const session = this.live;
		this.live = null;
		this.clearLiveStableTimer();
		// The slot stays this guild's through the rebuild. The old socket closing is not the guild giving
		// its slot up, but it looked like it: the close handed the slot to a guild held back by the cap
		// before the new session could open, and the guild that only changed its voice went silent.
		this.rebuildingLive++;
		try {
			await this.retireLive(session);
			if (!this.paused && !this.shuttingDown) this.startLive();
		} finally {
			this.rebuildingLive--;
		}
		// Paused or stopped meanwhile, or the new session could not open: now the slot is free.
		this.releaseLiveSlot();
	},

	/**
	 * Runs when the model asks for help: local Discord work or web research, with the result going back.
	 * `session` is the one that asked: a delegation id means nothing to any other session, and sending it to
	 * a successor that opened while the task ran came back as an error counted against that successor.
	 */
	async handleDelegation(delegation, session = this.live) {
		const question = this.taskDeps.getUserText();
		this.log(t('runtime.delegation_requested', { id: delegation.id, question: question.slice(0, 140) }));
		this.latency.delegationStart();
		try {
			const answer = await this.runTask();
			const ms = this.latency.delegationDone();
			if (answer.mode !== 'none' && answer.text) session?.replyDelegation(delegation.id, answer.text, { mode: answer.mode });
			this.log(
				t('runtime.delegation_answered', {
					id: delegation.id,
					timing: ms === null ? '' : t('runtime.delegation_timing', { seconds: (ms / 1000).toFixed(1) }),
				}),
			);
		} catch (err) {
			this.latency.delegationDone();
			this.log(t('runtime.delegation_error', { error: err.message }));
			session?.replyDelegation(delegation.id, t('runtime.delegation_failed_spoken'), { mode: 'commentary' });
		}
	},

	/** The model's voice, one chunk at a time. Kept as a method so that the reply gate can be tested without a socket. */
	onAssistantAudio(buffer) {
		// In local mode the GPT-Live audio is not used: the text is turned into speech locally.
		if (this.localMode) return;
		const usable = buffer.length & ~1;
		if (usable === 0) return;
		if (buffer.byteOffset % 2 !== 0) buffer = Buffer.from(buffer.subarray(0, usable));
		const samples = new Int16Array(buffer.buffer, buffer.byteOffset, usable >> 1);

		// The model can send audio frames during silence too; real audio is required before it counts as
		// "speaking", otherwise the latency measurement (and the 5 s rule) fires constantly and means nothing.
		const loud = peakOf(samples) > AUDIO_PEAK_MIN;
		if (loud) {
			// The measurement only makes sense for a reply that starts after a silence (full-duplex stream).
			if (Date.now() - this.lastAssistantSpokeAt > SILENCE_GAP_MS) {
				const responseMs = this.latency.assistantAudio();
				if (responseMs !== null && responseMs >= MIN_LOGGED_MS) {
					this.activity.push({
						kind: 'latency',
						whoName: this.persona().name ?? 'bot',
						text: t('runtime.seconds_value', { seconds: (responseMs / 1000).toFixed(1) }),
						meta: { type: t('runtime.latency_kind_response'), note: t('runtime.latency_note_response') },
					});
					this.log(t('runtime.log_latency_response', { seconds: (responseMs / 1000).toFixed(1) }));
				}
			}
			this.lastAssistantSpokeAt = Date.now();
			this.idle.touch(); // while the bot is speaking the session must not count as "idle"
		}
		// Silenced by the owner: the audio is thrown away here, at the last step before the channel, so
		// that no amount of persuasion inside the conversation can put it back.
		this.deliverAssistantAudio(samples, loud);
	},

	// ---------------------------------------------------------------- turn bookkeeping

	rememberTurn(delegationId, turn) {
		this.lastTurn = turn;
		if (!delegationId) return;
		this.turnsByDelegation.set(String(delegationId), turn);
		while (this.turnsByDelegation.size > TURN_MEMORY) this.turnsByDelegation.delete(this.turnsByDelegation.keys().next().value);
	},

	turnFor(delegationId) {
		if (delegationId && this.turnsByDelegation.has(String(delegationId))) return this.turnsByDelegation.get(String(delegationId));
		return this.lastTurn;
	},
};
