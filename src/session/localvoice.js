// The local voice: the Chatterbox queue that turns text into speech (enqueueLocalSpeech, runTtsQueue),
// the local TTS switch, and the local brain -- whisper, a text model and Chatterbox -- with its way in,
// its way out, the retry while the server is still loading, and the utterance path it runs.
//
// Writes: localMode, ttsPending, ttsQueue, ttsFlushTimer, ttsBusy, ttsAbort, brain, localModeBeforeBrain,
// localBrainWarnedAt, localBrainRetryTimer, localBrainRetryCount, and ttsSaidThisTurn (created on
// first use, not in the constructor).
// Shared: lastAssistantSpokeAt is written here by runTtsQueue and by onAssistantAudio (livelink.js);
// recentUserText and recentUserTextAt here by onLocalSegment and by flushTranscript (transcript.js).
// sttPollTimer is armed and cleared here and cleared by stop() as well.
// Reads only: cfg, silenced (settings.js), shuttingDown, live, voice, guild, store, taskDeps,
// attribution, latency, provider, localTts, localStt, localServer, localBrain, segmenter. Drives
// playback (push, clear).

import { executeAction } from '../agent.js';
import { FRAME_MS } from '../audio.js';
import { parseVoiceCommand } from '../commands.js';
import { t } from '../i18n/index.js';
import { firstClause, splitSentences } from '../localtts.js';
import { FIRST_CHUNK_CHARS, MIN_LOGGED_MS, SILENCE_GAP_MS, TTS_FLUSH_MS, TTS_SLOW_MS } from './constants.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const localVoiceMethods = {
	/** Empties the local audio queue and cancels the generation in flight: the bot goes quiet when cut off. */
	interruptLocalSpeech() {
		this.ttsPending = '';
		this.ttsQueue.length = 0;
		if (this.ttsFlushTimer) {
			clearTimeout(this.ttsFlushTimer);
			this.ttsFlushTimer = null;
		}
		if (this.ttsAbort) {
			this.ttsAbort.abort();
			this.ttsAbort = null;
		}
		if (this.localMode) this.playback.clear();
	},

	/** Splits the model's spoken text into sentences and turns them into audio (local mode). */
	enqueueLocalSpeech(text) {
		if (this.silenced) return;
		this.ttsPending += text;
		const { sentences, rest } = splitSentences(this.ttsPending);
		this.ttsPending = rest;
		for (const sentence of sentences) if (sentence) this.ttsQueue.push(sentence);
		// Nothing said yet this turn and a sentence that is taking its time: start on the first clause
		// rather than on the full stop.
		if (!this.ttsSaidThisTurn && !this.ttsQueue.length && this.ttsPending.length >= FIRST_CHUNK_CHARS) {
			const head = firstClause(this.ttsPending);
			if (head) {
				this.ttsQueue.push(head);
				this.ttsPending = this.ttsPending.slice(head.length);
			}
		}
		if (this.ttsQueue.length) this.ttsSaidThisTurn = true;
		if (this.ttsFlushTimer) clearTimeout(this.ttsFlushTimer);
		this.ttsFlushTimer = null;
		if (this.ttsPending.trim()) {
			// A tail left without punctuation: speak it as it is after a short silence.
			this.ttsFlushTimer = setTimeout(() => {
				this.ttsFlushTimer = null;
				const tail = this.ttsPending.trim();
				this.ttsPending = '';
				if (tail) {
					this.ttsQueue.push(tail);
					if (!this.ttsBusy) void this.runTtsQueue();
				}
			}, TTS_FLUSH_MS);
		}
		if (this.ttsQueue.length && !this.ttsBusy) void this.runTtsQueue();
	},

	async runTtsQueue() {
		if (this.ttsBusy) return;
		this.ttsBusy = true;
		try {
			while (this.ttsQueue.length) {
				const sentence = this.ttsQueue.shift();
				const controller = new AbortController();
				this.ttsAbort = controller;
				try {
					const spokeAt = Date.now();
					const { pcm, language } = await this.localTts.speak(sentence, { signal: controller.signal });
					const voiceMs = Date.now() - spokeAt;
					if (controller.signal.aborted || !pcm.length) continue;
					// Only when it is worth knowing about: a sentence that took longer to say than it takes to
					// hear is the thing standing between somebody and an answer.
					const audioMs = (pcm.length / this.playback.frameSamples) * FRAME_MS;
					if (voiceMs > TTS_SLOW_MS) {
						this.log(t('runtime.log_tts_slow', { seconds: (voiceMs / 1000).toFixed(1), audio: (audioMs / 1000).toFixed(1) }));
					}
					// Back pressure: wait until the queue has room (the old 2 s buffer swallowed the start of a sentence).
					let offset = 0;
					while (offset < pcm.length && !controller.signal.aborted && this.localMode) {
						const room = this.playback.free;
						if (room < this.playback.frameSamples) {
							await sleep(100);
							continue;
						}
						const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + room));
						this.playback.push(chunk);
						offset += chunk.length;
					}
					if (controller.signal.aborted) continue;
					// The same measurement the realtime path reports: from the moment somebody stopped talking
					// to the moment they hear something back. It was never taken in local mode, which is the
					// mode where it matters most.
					if (Date.now() - this.lastAssistantSpokeAt > SILENCE_GAP_MS) {
						const responseMs = this.latency.assistantAudio();
						if (responseMs !== null && responseMs >= MIN_LOGGED_MS) {
							this.log(t('runtime.log_latency_response', { seconds: (responseMs / 1000).toFixed(1) }));
						}
					}
					this.lastAssistantSpokeAt = Date.now();
					this.record({
						kind: 'voice',
						direction: 'out',
						whoName: this.persona().name ?? 'bot',
						text: sentence,
						meta: { source: t('runtime.meta_voice_local'), language },
					});
				} catch (err) {
					if (!controller.signal.aborted) this.log(t('runtime.local_tts_failed', { error: err.message }));
				} finally {
					if (this.ttsAbort === controller) this.ttsAbort = null;
				}
			}
		} finally {
			this.ttsBusy = false;
		}
	},

	/** The tail of a streamed reply: speak what is left even though it never got its punctuation. */
	flushLocalSpeech() {
		if (this.ttsFlushTimer) clearTimeout(this.ttsFlushTimer);
		this.ttsFlushTimer = null;
		const tail = this.ttsPending.trim();
		this.ttsPending = '';
		if (!tail) return;
		this.ttsQueue.push(tail);
		if (!this.ttsBusy) void this.runTtsQueue();
	},

	/**
	 * Local TTS mode: the GPT-Live audio is not pushed to Discord; the spoken text is turned into audio by
	 * Chatterbox and played from the local machine (no cloud voice is used).
	 * @returns {Promise<{ ok: boolean, value: boolean, reason?: string }>}
	 */
	async setLocalMode(enabled) {
		if (enabled && !this.cfg.localTtsEnabled) {
			this.log(t('runtime.local_tts_disabled_log'));
			return { ok: false, value: this.localMode, reason: t('runtime.local_tts_disabled') };
		}
		if (enabled) {
			const info = await this.localTts.health();
			if (!info) {
				if (this.localServer?.ensureRunning()) {
					this.log(t('runtime.local_tts_server_started_log'));
					return { ok: false, value: this.localMode, reason: t('runtime.local_tts_server_started') };
				}
				this.log(t('runtime.local_tts_server_down_log'));
				return { ok: false, value: this.localMode, reason: t('runtime.local_tts_server_down') };
			}
			if (!info.ok) {
				this.log(
					t('runtime.local_tts_not_ready_log', {
						status: info.status ?? t('runtime.local_tts_status_unknown'),
						error: info.error ? `: ${info.error}` : '',
					}),
				);
				const reason = t('runtime.local_tts_not_ready', { status: info.status ?? t('runtime.local_tts_status_loading') });
				return { ok: false, value: this.localMode, reason };
			}
			this.log(t('runtime.local_tts_on_log', { model: info.model, device: info.device, rate: info.sr }));
		} else if (this.localMode) {
			this.log(t('runtime.local_tts_off_log'));
		}
		this.localMode = enabled;
		this.interruptLocalSpeech();
		this.activity.push({ kind: 'session', text: enabled ? t('runtime.local_tts_mode_on') : t('runtime.local_tts_mode_off') });
		return { ok: true, value: this.localMode };
	},

	// ---------------------------------------------------------------- local brain

	/**
	 * Switches over to the local brain, if Chatterbox (TTS + /stt) and a text model are ready. When it cannot,
	 * it says why -- once.
	 * @returns {Promise<boolean>}
	 */
	async enterLocalBrain(reason, { quiet = false } = {}) {
		if (this.brain === 'local') return true;
		const [tts, stt] = await Promise.all([this.localTts.health(), this.localStt.health()]);
		const problems = [];
		if (!this.localBrain.available) problems.push(t('runtime.local_brain_no_text_model'));
		const serverProblem = !tts?.ok || !stt?.sttReady;
		if (!tts) problems.push(t('runtime.local_brain_server_down'));
		else if (!tts.ok) problems.push(t('runtime.local_brain_server_loading', { status: tts.status ?? '…' }));
		if (tts && !stt?.sttReady) problems.push(t('runtime.local_brain_no_stt'));
		if (problems.length) {
			if (serverProblem && this.localBrain.available) this.scheduleLocalBrainRetry(reason);
			if (!quiet && Date.now() - this.localBrainWarnedAt > 10 * 60_000) {
				this.localBrainWarnedAt = Date.now();
				const hint = this.localServer
					? this.localServer.running
						? t('runtime.local_brain_hint_started')
						: t('runtime.local_brain_hint_status', { status: this.localServer.status })
					: t('runtime.local_brain_hint_manual');
				this.log(t('runtime.local_brain_not_yet', { reason, problems: problems.join('; '), hint }));
				this.activity.push({ kind: 'session', text: t('runtime.local_brain_failed', { problems: problems.join('; ') }) });
			}
			return false;
		}
		this.stopLocalBrainRetry();
		this.brain = 'local';
		this.localModeBeforeBrain = this.localMode;
		this.localMode = true; // the mouth is Chatterbox
		this.localBrain.reset();
		this.segmenter.reset();
		if (this.sttPollTimer) clearInterval(this.sttPollTimer);
		this.sttPollTimer = setInterval(() => this.segmenter.poll(), 100);
		if (typeof this.sttPollTimer.unref === 'function') this.sttPollTimer.unref();
		const text = t('runtime.local_brain_active', {
			reason,
			stt: stt.stt,
			brain: this.provider.describe().split(' —')[0],
			tts: tts.model,
		});
		this.log(text);
		this.activity.push({ kind: 'session', text });
		return true;
	},

	/**
	 * While Chatterbox is not ready: start the server (when there is one) and retry every 15 s until it is
	 * (at most 40 attempts, about 10 min; loading the model takes 1-2 min).
	 */
	scheduleLocalBrainRetry(reason) {
		if (this.localServer && !this.localServer.running) {
			if (this.localServer.ensureRunning()) this.activity.push({ kind: 'session', text: t('runtime.chatterbox_started') });
		}
		if (this.localBrainRetryTimer) return;
		this.localBrainRetryCount = 0;
		this.localBrainRetryTimer = setInterval(() => {
			void (async () => {
				if (this.brain === 'local' || this.shuttingDown || !this.voice.connected || (this.cfg.brainMode === 'auto' && this.live?.ready)) {
					this.stopLocalBrainRetry();
					return;
				}
				if (++this.localBrainRetryCount > 40) {
					this.stopLocalBrainRetry();
					this.log(t('runtime.local_brain_gave_up'));
					return;
				}
				if (await this.enterLocalBrain(reason, { quiet: true })) this.stopLocalBrainRetry();
			})();
		}, 15_000);
		if (typeof this.localBrainRetryTimer.unref === 'function') this.localBrainRetryTimer.unref();
	},

	stopLocalBrainRetry() {
		if (this.localBrainRetryTimer) clearInterval(this.localBrainRetryTimer);
		this.localBrainRetryTimer = null;
	},

	exitLocalBrain(reason) {
		if (this.brain !== 'local') return;
		this.brain = 'live';
		if (this.sttPollTimer) clearInterval(this.sttPollTimer);
		this.sttPollTimer = null;
		this.segmenter.reset();
		this.interruptLocalSpeech();
		this.localMode = this.localModeBeforeBrain ?? this.cfg.localTtsOn;
		this.localModeBeforeBrain = null;
		this.log(t('runtime.local_brain_off_log', { reason }));
		this.activity.push({ kind: 'session', text: t('runtime.local_brain_off', { reason }) });
	},

	/** A hint for whisper: the character name and the names in the channel (so the transcript gets "Aria" right). */
	sttPrompt() {
		const names = new Set();
		const active = this.persona().name;
		if (active) names.add(active);
		for (const member of this.membersInVoice()) {
			names.add(member.displayName);
			if (names.size >= 8) break;
		}
		return [...names].join(', ').slice(0, 200);
	},

	/** An utterance from the local ear: transcript -> record -> voice command -> local brain -> Chatterbox. */
	async onLocalSegment({ userId, pcm, durationMs }) {
		if (this.brain !== 'local') return;
		if (this.cfg.soloUserId && userId !== this.cfg.soloUserId) return;
		let result;
		const heardAt = Date.now();
		try {
			result = await this.localStt.transcribe(pcm, { prompt: this.sttPrompt() });
		} catch (err) {
			this.log(t('runtime.local_stt_error', { error: err.message }));
			return;
		}
		const sttMs = Date.now() - heardAt;
		const line = result.text;
		if (!line || line.length < 2) return;
		const name = this.nameFor(userId) ?? t('runtime.someone');
		const isOwner = this.isOwnerId(userId);
		this.attribution.noteTranscript(line, { owner: isOwner, id: userId });
		// The turn of this utterance: whoever speaks afterwards does not change this request's owner-gate decision.
		const turn = this.attribution.markTurn();
		const turnDeps = { currentTurn: () => turn };
		this.latency.userSpeechEnd(Date.now());
		if (this.cfg.transcripts) this.log(t('runtime.transcript_user_line', { name, line }));
		this.record({ kind: 'voice', direction: 'in', who: userId, text: line, meta: { source: 'whisper', language: result.language, durationMs } });
		this.recentUserText = `${this.recentUserText} ${line}`.slice(-700).trim();
		this.recentUserTextAt = Date.now();

		// Unambiguous voice commands run here; the brain is only told about it so it does not do the work twice.
		const command = parseVoiceCommand(line, this.store.list(), this.channelLists());
		if (command) {
			try {
				const outcome = await executeAction(command, { ...this.taskDeps, ...turnDeps });
				if (outcome) {
					this.localBrain.note(t('runtime.note_action', { name, text: outcome.text }));
					if (outcome.speak && outcome.text && !outcome.reused) this.enqueueLocalSpeech(outcome.text);
					return;
				}
			} catch (err) {
				this.log(t('runtime.command_error', { error: err.message }));
			}
		}
		// Was it for the bot at all? With Jev the question is put directly; without it, as before, everything is.
		if (!(await this.localLineForBot(line, userId))) return;
		// Speak it as it is written, not after it is finished. The brain hands over each piece of the reply
		// as it arrives and enqueueLocalSpeech already cuts on sentence endings, so the first sentence is on
		// its way to Chatterbox while the rest is still being generated. Whatever the stream produced is
		// therefore already queued by the time the call returns.
		let streamed = false;
		this.ttsSaidThisTurn = false; // a new answer: its first piece may be cut early again
		const thoughtAt = Date.now();
		let firstWordMs = null;
		const onDelta = (piece) => {
			streamed = true;
			if (firstWordMs === null) firstWordMs = Date.now() - thoughtAt;
			this.enqueueLocalSpeech(piece);
		};
		this.localBrain.on('delta', onDelta);
		let reply;
		try {
			reply = await this.localBrain.handleUtterance({ userName: name, text: line, context: turnDeps });
		} finally {
			this.localBrain.off('delta', onDelta);
		}
		// Where the wait actually goes. Two of the three are somebody else's machine -- a remote model and
		// a local speech synthesiser -- so knowing which one is the slow half is the whole of the answer to
		// "can it be faster", and guessing at it has cost enough rounds already.
		if (reply.responded || streamed) {
			this.log(
				t('runtime.log_local_timing', {
					stt: (sttMs / 1000).toFixed(1),
					firstWord: firstWordMs === null ? '-' : (firstWordMs / 1000).toFixed(1),
					brain: ((Date.now() - thoughtAt) / 1000).toFixed(1),
				}),
			);
		}
		if (reply.error) this.log(t('runtime.local_brain_no_reply', { error: reply.error }));
		// The tail of the last sentence, if it never got its punctuation; or the whole reply on a path that
		// did not stream at all.
		if (streamed) this.flushLocalSpeech();
		else if (reply.responded && reply.text) this.enqueueLocalSpeech(reply.text);
	},
};
