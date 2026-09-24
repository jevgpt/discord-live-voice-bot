// One guild's whole voice life: the audio path (mixer, playback, ducker, music), the GPT-Live session,
// the local brain (whisper -> text model -> Chatterbox), the speaker attribution the owner gate rests
// on, and every timer that belongs to them. The process holds ONE of these per server instead of one
// set of module-level variables, so a second guild is a second instance and nothing else.
//
//   channel -> per-user Opus -> decode -> mono 24k -> mixer -> GPT-Live (gpt-live-1)
//   channel <- Opus encode <- 48k stereo <- [bot audio + ducked music] <- playback / music
//
// The process-wide services (config, Discord client, character store, memory, quota, activity log,
// text provider, the local Chatterbox server) are handed in by src/index.js; nothing here reaches for
// a singleton of its own.
//
// The class is split by concern. (It was one file of nearly 2,900 lines; it is the same class, it just
// no longer needs a table of contents.) This file keeps the constructor, where every field starts, the
// wiring (buildVoice, wireLocalEars, buildDeps), the voice channel (join, leave, rejoin), the health
// report and the lifecycle (start, status, stop, dispose). The method groups live in src/session/ and
// are installed on the prototype at the bottom of this file: speakers.js, transcript.js, replygate.js,
// livelink.js, localvoice.js and settings.js, each opening with the fields it writes and the ones it
// only reads. The tuning constants are in src/session/constants.js.
//
// Outside the constructor this file writes lastSpeakerId, lastVoiceChannelId, voiceJoin, rejoinTimers,
// lastDm, lastTextChannelId, memberRefreshTimer, healthTimer and shuttingDown. It also reaches into the
// groups' state: stop() flushes and clears transcriptBuffers and clears the reply gate's, the live
// link's, the idle watch's and the STT poll's timers; dispose() lets go of live; onVoiceStateUpdate
// resets lastAnnouncedUser, enterVoice clears memoryHinted, and the member refresh drops memberNameMap.

import { ChannelType } from 'discord.js';
import { createTaskRunner } from './agent.js';
import { FRAME_MS, PlaybackQueue, SpeakerMixer } from './audio.js';
import { createJev } from './jev.js';
import { SpeakerAttribution } from './attribution.js';
import { t } from './i18n/index.js';
import { IdleGovernor } from './idle.js';
import { LatencyMeter } from './latency.js';
import { LiveSession } from './live.js';
import { LocalBrain } from './localbrain.js';
import { SpeechSegmenter } from './localstt.js';
import { LocalTts } from './localtts.js';
import { MemberIndex } from './matcher.js';
import { Ducker, MusicPlayer } from './music.js';
import { stripDictationTail } from './text.js';
import { callTool, toolDefinitions, toolOutput } from './tools.js';
import { VoiceSession } from './voice.js';
import { toolDescription } from './tools/index.js';
import { speakerOfTurn } from './tools/access.js';
import { SessionHealth } from './health.js';
import { AudioTrace, SessionTrace } from './trace.js';
import { BARGE_IN_MS, HEALTH_EVERY_MS, HEALTH_MIN_FRAGMENTS, RECOVERY_DELAYS_MS, REJOIN_DELAYS_MS, SETTING_NAMES } from './session/constants.js';
import { liveLinkMethods } from './session/livelink.js';
import { localVoiceMethods } from './session/localvoice.js';
import { replyGateMethods } from './session/replygate.js';
import { settingsMethods } from './session/settings.js';
import { speakerMethods } from './session/speakers.js';
import { transcriptMethods } from './session/transcript.js';

export class GuildSession {
	/**
	 * @param {object} services the process-wide services; everything that belongs to this one guild is
	 * built right here, in the constructor.
	 */
	constructor({
		cfg,
		client,
		guild,
		channelId = null,
		store,
		memory,
		quota,
		reader,
		recentActions,
		reminders,
		savedTracks,
		activity,
		record,
		provider,
		openai,
		localStt,
		localServer,
		log,
		summarize,
		presenceEnabled = false,
		canOpenLive = null,
		onLiveSlotFreed = null,
		createLive = null,
		onPermanentLeave = null,
		joinChannel = null,
	}) {
		// One cfg object is shared by every server. The settings the owner can change at runtime (brain,
		// transcripts, announce_speaker, owner_priority, idle_close_minutes, the default voice) belong to
		// the server they were changed in, so this guild reads cfg through a view of its own: a read finds
		// this guild's override first and the shared value otherwise, and a write lands here only. Being a
		// prototype view, it must be read field by field -- a spread ({ ...this.cfg }) would drop every
		// value it has not overridden. What is process-wide on purpose is written to sharedCfg instead.
		this.sharedCfg = cfg;
		this.cfg = Object.create(cfg);
		this.client = client;
		this.guild = guild;
		// The voice channel of THIS guild; cfg.channelId belongs to the primary target only.
		this.channelId = channelId ?? cfg.channelId ?? null;
		this.store = store;
		this.memory = memory;
		this.quota = quota;
		this.reader = reader;
		this.recentActions = recentActions;
		this.reminders = reminders;
		this.savedTracks = savedTracks;
		// Which guild an event came from is stamped on HERE, once, instead of at every push() call site:
		// the panel needs it to tell two servers apart, and a new call site cannot forget it.
		const guildLabel = guild?.name ?? guild?.id ?? null;
		const guildId = guild?.id ? String(guild.id) : null;
		const tagGuild = (event) => {
			const meta = { ...(event.meta ?? null), guild: guildLabel };
			// A voice line also carries the server's id and the voice channel it was said in. A summary keeps a
			// line only for people who could have been in that channel (src/summary.js); without the channel a
			// line from a staff voice room was quoted to anybody who asked what was said today.
			if (event.kind === 'voice') {
				if (guildId && meta.guildId === undefined) meta.guildId = guildId;
				const voiceChannelId = this.voice?.channelId ?? this.channelId ?? null;
				if (voiceChannelId && meta.channelId === undefined) meta.channelId = String(voiceChannelId);
			}
			return { ...event, meta };
		};
		this.activity = {
			push: (event) => activity.push(tagGuild(event)),
			// summarize() reads the shared event buffer through this wrapper.
			get events() {
				return activity.events;
			},
		};
		this.record = (event) => record(tagGuild(event));
		// May this guild open a realtime session right now (MAX_LIVE_SESSIONS)? The registry answers.
		this.canOpenLive = canOpenLive ?? (() => true);
		// Told to the registry when one of this guild's realtime sockets is gone, so a guild held back by
		// the cap can have the slot.
		this.onLiveSlotFreed = onLiveSlotFreed;
		// How a realtime session is made; the tests hand in a stand-in that never opens a socket.
		this.createLive = createLive ?? ((options) => new LiveSession(options));
		// Told to the registry when the guild is left for good, so the session can be dropped.
		this.onPermanentLeave = onPermanentLeave;
		// The join the tools use. Through the registry it can also reach a server that has no session yet
		// (one is built on the spot); without a registry it is this guild's own join.
		this.joinChannel = joinChannel;
		// Why this guild is NOT holding a realtime session, when that is a decision rather than a failure,
		// and since when: the slot that frees first goes to the guild that has waited longest.
		this.liveBlockedReason = null;
		this.liveBlockedSince = 0;
		this.provider = provider;
		this.openai = openai;
		this.localStt = localStt;
		this.localServer = localServer;
		this.log = log;
		this.summarizeConversation = summarize;
		this.presenceEnabled = presenceEnabled;

		// ---------------------------------------------------------------- audio path
		// One voice at a time (see SpeakerMixer): the model hears a sum and cannot pull it apart, so while
		// somebody holds the floor only their audio goes out. FLOOR_CONTROL=0 sends the sum as before.
		this.mixer = new SpeakerMixer({ floorControl: cfg.floorControl, agc: cfg.agc, primeFrames: cfg.primeFrames });
		if (cfg.floorControl) this.log(t('runtime.floor_control_on'));
		if (cfg.ownerPriority && cfg.ownerId) this.mixer.setPriority(cfg.ownerId);
		this.playback = new PlaybackQueue();
		this.idle = new IdleGovernor({ idleMs: cfg.idleCloseMs });
		this.attribution = new SpeakerAttribution({ ownerId: cfg.ownerId, frameMs: FRAME_MS });
		this.latency = new LatencyMeter();
		// What the session knows about itself (reportHealth), and, with TRACE=1, the flight recorder.
		this.health = new SessionHealth();
		this.healthTimer = setInterval(() => this.reportHealth(t('runtime.health_why_periodic', { minutes: HEALTH_EVERY_MS / 60_000 })), HEALTH_EVERY_MS);
		this.healthTimer.unref?.();
		this.trace = cfg.trace ? new SessionTrace({ dir: 'data/traces', text: cfg.recordTranscripts !== false, owner: cfg.ownerId ?? null, attribution: cfg.attribution ?? null, log: (line) => this.log(line) }) : null;
		if (this.trace) this.log(t('runtime.log_trace_started', { file: this.trace.file }));
		this.audioTrace = cfg.traceAudio ? new AudioTrace({ dir: 'data/traces', log: (line) => this.log(line) }) : null;
		if (this.audioTrace) this.log(t('runtime.log_trace_audio', { file: this.audioTrace.file }));
		this.memberIndex = new MemberIndex();

		// ---------------------------------------------------------------- music
		this.music = cfg.musicEnabled
			? new MusicPlayer({
					ffmpegPath: cfg.ffmpegPath,
					ytDlpPath: cfg.ytDlpPath,
					autoDownload: cfg.ytDlpAutoDownload,
					musicDir: cfg.musicDir,
					volume: cfg.musicVolume,
					duckVolume: cfg.musicDuckVolume,
					maxMinutes: cfg.musicMaxMinutes,
					log,
					// this.activity is the guild-tagged wrapper built above, not the process-wide log.
					onTrackStart: (track) => {
						// The track goes under the bot's name as well, so people see what is playing.
						this.showPresence(track);
						this.activity.push({
							kind: 'music',
							whoName: track.requestedBy ?? null,
							text: t('runtime.music_playing', { title: track.title }),
							meta: { source: track.kind },
						});
					},
					onTrackEnd: (track, { queueEmpty, stopped }) => {
						if (!queueEmpty) return;
						this.showPresence(null);
						// A track that was stopped has already been logged as stopped; saying it "finished" as
						// well would be two different accounts of the same moment.
						if (!stopped) this.activity.push({ kind: 'music', text: t('runtime.music_finished', { title: track.title }) });
					},
					onError: (track, message) =>
						this.activity.push({ kind: 'music', text: t('runtime.music_failed', { title: track.title, error: message }) }),
				})
			: null;
		this.ducker = new Ducker({ duck: this.music ? this.music.duckRatio : 0.12, holdMs: cfg.musicDuckHoldMs, frameMs: FRAME_MS });

		// ---------------------------------------------------------------- local TTS
		// Local TTS (Chatterbox): while it is on the GPT-Live audio is not pushed to Discord; the text is
		// turned into speech locally instead.
		this.localTts = new LocalTts({
			url: cfg.localTtsUrl,
			voiceRef: cfg.localTtsVoice,
			languageId: cfg.localTtsLang,
			log: (message) => cfg.debug && log(message),
		});
		this.localMode = cfg.localTtsOn;
		this.ttsPending = '';
		this.ttsFlushTimer = null;
		this.ttsQueue = [];
		this.ttsBusy = false;
		this.ttsAbort = null;

		// ---------------------------------------------------------------- local brain (voice chat without OpenAI)
		// ears = whisper (/stt on the Chatterbox server), brain = DeepSeek/OpenAI chat + tools, mouth = Chatterbox.
		this.brain = 'live'; // 'live' | 'local'
		this.sttPollTimer = null;
		this.localModeBeforeBrain = null;
		this.localBrainWarnedAt = 0;
		this.localBrainRetryTimer = null;
		this.localBrainRetryCount = 0;
		this.segmenter = new SpeechSegmenter({ silenceMs: cfg.sttSilenceMs });
		this.localBrain = new LocalBrain({
			provider,
			persona: () => ({ name: this.persona().name, instructions: this.persona().instructions }),
			tools: toolDefinitions(),
			// context = the dependencies specific to this utterance (the owner-gate turn); the shared taskDeps otherwise.
			callTool: (name, args, context) => callTool(name, args, context ? { ...this.taskDeps, ...context } : this.taskDeps),
			toolOutput,
			respondPolicy: cfg.localBrainRespond,
			participants: () => this.humansInVoice(),
			log,
		});

		// ---------------------------------------------------------------- GPT-Live session and reconnect state
		this.live = null;
		// Sessions this guild has let go of whose sockets are not closed yet, each with its close; they
		// still count against MAX_LIVE_SESSIONS (see retireLive), and dispose() waits for every one of them.
		this.closingLive = new Map();
		// A persona rebuild in progress (refreshPersona): between closing the old session and opening the new
		// one the guild holds no socket, but the slot is still its own (see holdsLiveSlot).
		this.rebuildingLive = 0;
		this.liveReconnectTimer = null;
		// Armed when a session is ready; the failure count is forgiven only once a session has stayed up.
		this.liveStableTimer = null;
		this.liveFailures = 0;
		this.lastFatalCode = null; // tell the owner about the same permanent error only once
		this.lastLiveError = null; // the reason for the 'closed' that follows an 'error' event
		this.lastUsageMinute = -1;
		this.greeted = false;
		this.pendingIntro = false;
		this.paused = false;
		this.quotaBlocked = false;
		this.shuttingDown = false;
		this.idleTimer = null;
		this.memberRefreshTimer = null;
		this.rejoinTimers = new Set();
		// The join under way ({ channelId, promise }), so that one join has one set of consequences (joinVoice).
		this.voiceJoin = null;

		// ---------------------------------------------------------------- turns, speakers, transcripts
		this.turnsByDelegation = new Map();
		this.lastTurn = null;
		this.lastSpeakerId = null;
		this.lastAnnouncedUser = null;
		this.lastVoiceChannelId = null;
		this.memberNameMap = null;
		this.memoryHinted = new Set();
		this.recentUserText = '';
		this.recentUserTextAt = 0;
		this.lastAssistantSpokeAt = 0;
		this.lastWakeNudgeAt = 0;
		this.transcriptBuffers = new Map();
		this.lastUserDeltaAt = 0;
		this.sentCandidate = null;
		this.sentCandidateFrames = 0;
		this.sentSilentFrames = 0;
		// userId -> when we last heard them; used to tell a quiet channel from a crowded one.
		this.recentSpeakers = new Map();
		// The private conversation the bot most recently wrote in, and the status line to return to.
		this.lastDm = null;
		this.lastTextChannelId = null;
		// The reply gate (see judgeEarly): the current early judgment of the line being spoken, the bot's
		// audio held back while Jev answers, the reply being kept off the channel, and what the bot last
		// said that the channel actually heard.
		this.earlyJudge = null;
		this.earlyJudgeTimer = null;
		this.speakingNow = []; // who the mixer said was speaking on the last frame (noteSpeechEnd)
		this.closedLineToJudge = null; // a line that closed while a judgment was still pending
		this.asideUntil = 0; // while the room is talking among themselves, the bot needs a clear invitation
		this.replyHold = null;
		this.suppress = null;
		this.lastSuppressedAt = 0;
		this.lastHeardAssistantLine = '';
		this.presence = null;
		// Told to be quiet by the owner. This is a state, not a request to the model: while it is on, the
		// bot's audio is dropped before it reaches the channel, so nobody else can talk it into speaking.
		this.silenced = false;
		this.noAudioSaid = 0; // how many times this session has spelled out a line with no audio under it
		// A realtime session can stay connected while every request on it fails; these count that.
		this.liveErrorCount = 0;
		this.liveErrorSince = 0;

		// Jev: typed judgments about each finished line (said to the bot? banter or a real request?). Off
		// without a key, and a failure never reaches the line, which was handed to the model regardless.
		this.jev = createJev(this.cfg, { log: (line) => this.log(line) });
		if (this.jev.enabled) this.log(t('runtime.jev_ready', { model: this.jev.model }));
		this.taskDeps = this.buildDeps();
		this.runTask = createTaskRunner(this.taskDeps);
		this.voice = this.buildVoice();
		this.wireLocalEars();
	}

	// ---------------------------------------------------------------- wiring

	/** The voice session of this guild: the 20 ms bridge, the per-speaker subscriptions and the frame hooks. */
	buildVoice() {
		return new VoiceSession({
			getClient: () => this.client,
			mixer: this.mixer,
			playback: this.playback,
			music: this.music,
			ducker: this.ducker,
			getLive: () => this.live,
			log: this.log,
			debug: this.cfg.debug,
			soloUserId: this.cfg.soloUserId,
			onFrame: (frame) => {
				this.trace?.frame(frame, this.attribution.audioMs);
				if (frame.sent && this.audioTrace) this.audioTrace.write(frame.pcm);
				if (frame.others?.length) this.health.overlap(frame.others);
				this.attribution.onFrame(frame);
				this.trackSentSpeaker(frame);
				this.noteSpeechEnd(frame);
				if (this.cfg.debug) this.logSpeaking(frame.active);
			},
			onUserPcm: (userId, pcm) => {
				if (this.brain === 'local') this.segmenter.push(userId, pcm);
			},
			onSpeaking: (userId) => {
				this.lastSpeakerId = userId;
				this.idle.touch();
				if ((this.paused || this.liveBlockedReason) && this.brain !== 'local') this.resumeOnSpeech();
				// The speaker announcement now follows the audio that is sent (trackSentSpeaker); only the memory hint here.
				void this.hintMemory(userId);
			},
			onLost: () => {
				// The voice connection could not be recovered: instead of killing the whole bot, leave the channel,
				// pause the session, and try to rejoin the same channel with growing delays.
				this.log(t('runtime.voice_lost'));
				void (async () => {
					try {
						await this.voice.destroy();
					} catch {
						/* ignore */
					}
					this.pauseLive(t('runtime.reason_voice_lost'));
					const targetId = this.lastVoiceChannelId;
					if (!targetId || this.shuttingDown) return;
					this.scheduleRejoin(targetId, RECOVERY_DELAYS_MS, t('runtime.rejoin_label_recover'));
				})();
			},
		});
	}

	/** The local ears: barge-in and finished utterances from the segmenter, tool calls from the local brain. */
	wireLocalEars() {
		this.segmenter.on('start', ({ userId }) => {
			this.lastSpeakerId = userId;
			this.idle.touch();
			if (this.playback.length === 0) return; // the bot is not playing: let any generation carry on
			setTimeout(() => {
				if (!this.segmenter.speakingUsers.includes(userId)) return; // a short noise (a cough, a click)
				if (this.playback.length === 0) return;
				this.log(t('runtime.barge_in'));
				this.interruptLocalSpeech();
			}, BARGE_IN_MS);
		});
		this.segmenter.on('segment', (segment) => void this.onLocalSegment(segment));
		this.localBrain.on('tool', (event) => this.onToolEvent(event, t('runtime.source_local_brain')));
	}

	/**
	 * Task dependencies: the voice-command path, the delegation path and the slash commands all use these.
	 * Values that change while the bot runs (the live session, the speaker, the guild) are read through a
	 * getter/closure.
	 */
	buildDeps() {
		const session = this;
		const { cfg, log, openai, provider, store } = this;
		return {
			store,
			cfg,
			log,
			client: this.client,
			// The last private conversation the bot started, so "delete that" can find it again: a DM has
			// its own channel and cannot be looked up by name.
			noteDirectMessage: (entry) => {
				session.lastDm = entry;
			},
			lastDirectMessage: () => session.lastDm ?? null,
			// The text channel the conversation was last happening in (see noteTextChannel).
			lastTextChannel: () => (session.lastTextChannelId ? (session.guild?.channels.cache.get(session.lastTextChannelId) ?? null) : null),
			// What the status line should say when no music is playing.
			setDefaultPresence: (presence) => session.setDefaultPresence(presence),
			defaultPresence: () => session.presence ?? null,
			openai,
			provider,
			textClient: provider.textClient,
			textApi: provider.textApi,
			textModel: provider.textModel,
			visionClient: openai,
			visionModel: cfg.textModel,
			model: provider.textModel,
			recentActions: this.recentActions,
			reader: this.reader,
			memberIndex: this.memberIndex,
			memory: this.memory,
			music: this.music,
			quota: this.quota,
			now: Date.now,
			nameFor: (userId) => session.nameFor(userId),
			personaName: () => session.persona().name ?? 'bot',
			summarize: (options = {}) => session.summarizeConversation(session.taskDeps, { events: session.activity.events, ...options }),
			get presenceEnabled() {
				return session.presenceEnabled;
			},
			get selfId() {
				return session.client?.user?.id ?? null;
			},
			get guild() {
				return session.guild;
			},
			getUserText: () => (Date.now() - session.recentUserTextAt < 60_000 ? session.recentUserText.trim() : ''),
			channelLists: () => session.channelLists(),
			joinVoice: (channel) => (session.joinChannel ? session.joinChannel(channel) : session.joinVoice(channel)),
			leaveVoice: (options) => session.leaveVoice(options),
			// Who is asking: the person whose line produced the request, read from the turn the request is
			// pinned to, and only when the audio is sure of them (see speakerOfTurn). lastSpeakerId is only
			// Discord's latest speaking event -- whoever made any sound while the model worked -- and it is no
			// longer the answer even when there is no line to go on: a guest's request passed as the owner's
			// own whenever the owner made a sound at the right moment. Nobody is judged as @everyone. These are
			// methods rather than arrow functions so that a copy of the deps carrying a pinned `currentTurn`
			// (the realtime and local paths make one per request) reads its own turn.
			currentSpeakerId() {
				const turn = typeof this?.currentTurn === 'function' ? this.currentTurn() : session.attribution.turn;
				return speakerOfTurn(session.attribution, turn ?? null);
			},
			currentSpeakerName() {
				const id = typeof this?.currentSpeakerId === 'function' ? this.currentSpeakerId() : null;
				return id ? session.nameFor(id) : null;
			},
			currentSpeakerChannel() {
				const id = typeof this?.currentSpeakerId === 'function' ? this.currentSpeakerId() : null;
				return id ? (session.guild?.voiceStates.cache.get(id)?.channel ?? null) : null;
			},
			currentVoiceChannel: () => (session.voice.channelId ? (session.guild?.channels.cache.get(session.voice.channelId) ?? null) : null),
			// Did the bot owner speak just now? Admin commands go through this gate.
			// The audio path can tell the owner's speech apart, so the gate rests on "was the last voice heard the owner's".
			isOwnerActive: () => session.attribution.isOwnerActive(),
			ownerSaidRecently: (words, ms) => session.attribution.ownerSaidRecently(words, ms),
			ownerMatch: (words, ms) => session.attribution.ownerMatch(words, ms),
			ownerTextTail: () => session.attribution.state().ownerText,
			// The gate's real question: who said the command word LAST, and did anyone speak after the owner (before
			// the turn started)? Default turn: the last turn read when entering the gate (a turn pinned per request wins).
			currentTurn: () => session.attribution.turn,
			commandSpeaker: (words, opts) => session.attribution.commandSpeaker(words, opts),
			lastUtterance: (opts) => session.attribution.lastUtterance(opts),
			transcriptLagging: (opts) => session.attribution.transcriptLagging(opts),
			awaitTranscript: (maxMs) => session.awaitTranscript(maxMs),
			// For the gate's second opinion: what the owner said last, what the tool does, and Jev to ask.
			ownerUtterance: (opts) => session.attribution.ownerUtterance(opts),
			// For the two-step confirmation: where the conversation was when the question was put, and what the
			// owner has said since. The answer is read from the same attribution the gate trusts, so only the
			// owner's own voice can say yes; a confirm:true from the model on its own is not an answer.
			speechMark: () => session.attribution.mark(),
			ownerSpeechSince: (mark, opts) => session.attribution.ownerSpeechSince(mark, opts),
			toolDescription: (name) => toolDescription(name),
			get jev() {
				return session.jev;
			},
			activity: (event) => {
				// The gate's decisions are counted for the health report and kept by the recorder.
				if (event?.kind === 'gate') {
					session.health.gateResult(event.meta?.result, event.meta?.reason ?? null);
					session.trace?.gate(event);
				}
				session.activity.push(event);
			},
			reminders: session.reminders,
			savedTracks: session.savedTracks,
			setDefaultVoice: (voiceName) => {
				// this.cfg is this guild's own view (see the constructor): the other servers keep their voice.
				cfg.liveVoice = voiceName;
			},
			applySetting: (name, value) => session.applySetting(name, value),
			settingNames: () => SETTING_NAMES,
			refreshPersona: (reason) => session.refreshPersona(reason),
		};
	}

	// ---------------------------------------------------------------- character / people

	persona() {
		const character = this.store.getActive();
		return {
			name: character?.name ?? null,
			instructions: character?.prompt?.trim() || this.cfg.instructions,
			voice: character?.voice || this.cfg.liveVoice,
		};
	}

	channelLists() {
		const text = [];
		const voice = [];
		for (const channel of this.guild?.channels.cache.values() ?? []) {
			if (channel.type === ChannelType.GuildText) text.push(channel);
			else if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) voice.push(channel);
		}
		return { text, voice };
	}

	/** Can the bot say something right now: connected (or local) and not silenced by the owner? */
	canSpeak() {
		return !this.silenced && (Boolean(this.live?.ready) || this.brain === 'local');
	}

	/**
	 * Says a line that has to be heard now — a reminder, a greeting — rather than something the model may
	 * fold into the conversation. In live mode that is an instruction plus the same short nudge the
	 * greeting uses: an instruction is guidance, and guidance on its own does not make the model speak.
	 * Returns false when nothing was handed over, so the caller can keep the line for later.
	 */
	sayNow(text) {
		const line = String(text ?? '').trim();
		if (!line || !this.canSpeak()) return false;
		if (this.brain === 'local') {
			this.enqueueLocalSpeech(line);
			this.localBrain.note(t('runtime.note_self_said', { text: line }));
			return true;
		}
		this.live.appendContext('instructions', t('runtime.speak_now', { text: line }));
		this.live.appendContext('commentary', t('runtime.speak_nudge'));
		return true;
	}

	/** Tells the model to "say this" (it comes out in the channel); with the local brain Chatterbox reads it. */
	say(text) {
		if (this.silenced) return;
		if (this.brain === 'local') {
			this.enqueueLocalSpeech(String(text ?? ''));
			this.localBrain.note(t('runtime.note_self_said', { text }));
			return;
		}
		if (!this.live?.ready) return;
		this.live.appendContext('commentary', text);
	}

	/** A DM to the owner (quota warnings and so on); with no owner set it is only logged. */
	notifyOwner(text) {
		this.log(t('runtime.owner_log', { text }));
		if (!this.cfg.ownerId || !this.client) return;
		this.client.users
			.fetch(this.cfg.ownerId)
			.then((user) => user.send(text))
			.catch((err) => this.log(t('runtime.owner_dm_failed', { error: err.message })));
	}

	/** Writes a tool event to the panel/log (the GPT-Live backend and the local brain share this path). */
	onToolEvent({ name, args, output, ms }, source = 'backend') {
		this.latency.toolDone(ms);
		this.health.tool(name, ms);
		let ok = true;
		try {
			ok = JSON.parse(output).ok !== false;
		} catch {
			/* ignore */
		}
		this.activity.push({
			kind: 'tool',
			whoName: this.persona().name ?? 'bot',
			text:
				`${name} ${ok ? t('runtime.tool_ok') : t('runtime.tool_failed')}` +
				`${Number.isFinite(ms) ? t('runtime.tool_timing', { seconds: (ms / 1000).toFixed(1) }) : ''}`,
			meta: { tool: name, ok, ms, source, args: JSON.stringify(args ?? {}).slice(0, 300), result: String(output).slice(0, 200) },
		});
		// A message a tool wrote to a channel/DM should show up in the panel as a conversation line too.
		if (ok && (name === 'send_message' || name === 'send_dm') && args?.text) {
			this.record({
				kind: name === 'send_dm' ? 'dm' : 'channel',
				direction: 'out',
				whoName: this.persona().name ?? 'bot',
				text: stripDictationTail(String(args.text)),
				meta: name === 'send_dm' ? { to: args.to ?? null } : { channel: args.channel ? `#${args.channel}` : null },
			});
		}
		const timing = Number.isFinite(ms) ? t('runtime.tool_timing', { seconds: (ms / 1000).toFixed(1) }) : '';
		if (!ok) this.log(t('runtime.log_tool_failed', { name, timing, output: String(output).slice(0, 160) }));
		else if (ms > 1500) this.log(t('runtime.log_tool_slow', { name, timing }));
	}

	/** The text channel somebody last spoke to the bot in; send_message falls back to it. */
	noteTextChannel(channelId) {
		this.lastTextChannelId = channelId ? String(channelId) : null;
	}

	// ---------------------------------------------------------------- health

	/**
	 * The session's own account of how it is doing, on a few lines: every few minutes, when the live
	 * session closes, and when the session stops. What the last few hundred lines of a pasted log used
	 * to be read for -- the drift, the share of fragments the audio could place, the lines nobody owned,
	 * the gate's refusals and their reasons, Jev's verdicts and latency, the slow tools -- said by the
	 * bot itself, before anybody has to ask. Nothing is said until enough has happened to mean anything.
	 */
	/** What the audio path did to the sound, for the health report: the mixer's counters and the send loop's clock. */
	audioStats() {
		const bridge = this.voice?.bridge ?? null;
		const mixer = this.mixer;
		return {
			...mixer?.stats,
			levels: (mixer?.levels?.() ?? []).map((entry) => ({ ...entry, name: this.nameFor(entry.id) })),
			sent: bridge?.stats.sent ?? 0,
			sentRatio: bridge?.sentRatio ?? null,
			padRate: bridge?.padRate ?? null,
			avgLateMs: bridge?.avgLateMs ?? 0,
			maxLateMs: bridge?.stats.maxLateMs ?? 0,
			bursts: bridge?.stats.bursts ?? 0,
			lead: bridge?.stats.lead ?? 0,
			extra: bridge?.stats.extra ?? 0,
		};
	}

	reportHealth(why) {
		if (this.health.fragmentCount - this.health.reportedAt < HEALTH_MIN_FRAGMENTS) return;
		this.health.reportedAt = this.health.fragmentCount;
		const lines = this.health.report({ why, latency: this.latency.summary().text, takeovers: this.mixer?.floorTakeovers ?? 0, audio: this.audioStats() });
		for (const line of lines) this.log(line);
		this.activity.push({ kind: 'health', whoName: this.persona().name ?? 'bot', text: lines.join('\n'), meta: this.health.snapshot() });
	}

	// ---------------------------------------------------------------- voice channel

	scheduleTimer(fn, delayMs) {
		const timer = setTimeout(() => {
			this.rejoinTimers.delete(timer);
			fn();
		}, delayMs);
		if (typeof timer.unref === 'function') timer.unref();
		this.rejoinTimers.add(timer);
		return timer;
	}

	clearRejoinTimers() {
		for (const timer of this.rejoinTimers) clearTimeout(timer);
		this.rejoinTimers.clear();
	}

	/** When the bot left the channel on its own it tries to come back shortly after (no one-way door). */
	scheduleRejoin(targetId, delays, label) {
		for (const delayMs of delays) {
			this.scheduleTimer(() => {
				void (async () => {
					if (this.shuttingDown || this.voice.connected || this.lastVoiceChannelId !== targetId) return;
					// A join still under way is this attempt: a join can take longer than the gap to the next
					// timer, and every timer that fired meanwhile used to pile onto it. If it fails, the later
					// timers are still standing.
					if (this.voiceJoin) return;
					const channel = this.guild?.channels.cache.get(targetId);
					if (!channel) return;
					this.log(`${label} (${channel.name}).`);
					try {
						await this.joinVoice(channel, { rejoin: true });
					} catch (err) {
						this.log(t('runtime.rejoin_failed', { error: err.message }));
					}
				})();
			}, delayMs);
		}
	}

	/**
	 * `rejoin` marks one of the planned attempts to come back. A join somebody asked for replaces that plan
	 * at once; a planned attempt leaves the later ones standing until a join has worked, because clearing
	 * them first made the first attempt the only one -- and when it failed the bot never came back.
	 */
	async joinVoice(channel, { rejoin = false } = {}) {
		if (!rejoin) this.clearRejoinTimers();
		// One join, one set of consequences. voice.join() lets a second caller wait on a join to the same
		// channel that is already under way, and each caller then went on to resume the session, log the
		// join and post JOIN_NOTICE: one join, three notices. A caller that finds such a join waits for it
		// and leaves the rest to the one that started it.
		if (this.voiceJoin?.channelId === channel.id) return this.voiceJoin.promise;
		const join = { channelId: channel.id, promise: this.enterVoice(channel) };
		this.voiceJoin = join;
		try {
			await join.promise;
		} finally {
			if (this.voiceJoin === join) this.voiceJoin = null;
		}
	}

	/** The join itself and what follows it: resuming the brain, the activity entry and JOIN_NOTICE. */
	async enterVoice(channel) {
		await this.voice.join(this.guild, channel);
		this.clearRejoinTimers();
		this.lastVoiceChannelId = channel.id;
		this.memoryHinted.clear();
		if (this.cfg.brainMode === 'local') void this.enterLocalBrain('BRAIN_MODE=local');
		else this.resumeLive();
		this.activity.push({ kind: 'session', text: t('runtime.joined_voice', { channel: channel.name }), meta: { channel: channel.name } });
		if (this.cfg.joinNotice && this.cfg.textChannelId) {
			const textChannel = this.guild?.channels.cache.get(this.cfg.textChannelId);
			textChannel
				?.send({
					content: t('runtime.join_notice', {
						channel: channel.name,
						recording: this.cfg.recordTranscripts ? t('runtime.join_notice_recording_on') : t('runtime.join_notice_recording_off'),
					}),
					allowedMentions: { parse: [] },
				})
				.catch(() => {});
		}
	}

	async leaveVoice({ permanent = false } = {}) {
		this.clearRejoinTimers();
		this.music?.stop();
		this.exitLocalBrain(t('runtime.reason_left_voice'));
		await this.voice.destroy();
		this.pauseLive(t('runtime.reason_left_voice'));
		this.activity.push({ kind: 'session', text: permanent ? t('runtime.left_voice_permanent') : t('runtime.left_voice_temporary') });
		// If the owner did not throw it out (the model left on its own) it comes back; a permanent exit sets no timer.
		if (permanent) {
			this.lastVoiceChannelId = null;
			// The registry decides what a permanent departure means: an extra server is dropped, the primary
			// target keeps its session (and its timers) exactly as it did before there were several servers.
			this.onPermanentLeave?.(this);
		} else if (this.lastVoiceChannelId) {
			this.scheduleRejoin(this.lastVoiceChannelId, REJOIN_DELAYS_MS, t('runtime.rejoin_label_return'));
		}
	}

	/** Somebody moved in or out of the bot's channel (Discord event): drop their audio and tell the model. */
	onVoiceStateUpdate(oldState, newState) {
		const botChannelId = this.voice.channelId;
		if (!botChannelId || !oldState?.id) return;
		const member = newState.member ?? oldState.member ?? this.guild?.members.cache.get(oldState.id);
		if (member?.user?.bot) return;
		const name = member?.displayName ?? this.nameFor(oldState.id);
		// The user left the bot's channel: drop the audio subscription and buffer (no leak), and tell the model.
		if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
			this.voice.dropUser(oldState.id);
			if (this.lastAnnouncedUser === oldState.id) this.lastAnnouncedUser = null;
			this.live?.appendContext('thinking', t('runtime.member_left_voice', { name }));
		} else if (newState.channelId === botChannelId && oldState.channelId !== botChannelId) {
			this.live?.appendContext(
				'thinking',
				t('runtime.member_joined_voice', { name, owner: this.isOwnerId(oldState.id) ? t('runtime.owner_suffix') : '' }),
			);
		}
	}

	// ---------------------------------------------------------------- lifecycle

	/**
	 * Brings this guild up: join the configured voice channel, warm the message baseline, load the member
	 * index (and keep it fresh), and watch for an idle live session.
	 */
	async start() {
		const cfg = this.cfg;
		if (this.channelId) {
			const channel = await this.guild.channels.fetch(this.channelId).catch(() => null);
			if (channel?.isVoiceBased()) {
				await this.joinVoice(channel);
				this.log(t('boot.joined_channel', { channel: channel.name }));
			} else {
				this.log(t('boot.voice_channel_missing', { channel: this.channelId }));
			}
		}

		const textChannels = [...this.guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildText);
		await this.reader.warmUp(textChannels);
		this.log(t('boot.message_baseline', { count: textChannels.length }));

		this.memberIndex.selfId = this.client.user.id;
		try {
			await this.memberIndex.load({ token: cfg.discordToken, guildId: this.guild.id, log: this.log });
		} catch (err) {
			this.log(t('boot.member_index_failed', { error: err.message }));
		}
		this.memberRefreshTimer = setInterval(
			() => {
				void this.memberIndex
					.load({ token: cfg.discordToken, guildId: this.guild.id })
					.then(() => {
						this.memberNameMap = null;
					})
					.catch(() => {});
			},
			30 * 60_000,
		);
		if (typeof this.memberRefreshTimer.unref === 'function') this.memberRefreshTimer.unref();

		this.armIdleTimer();
	}

	/** The per-guild dependencies handed to callTool / executeAction / the task runner. */
	deps() {
		return this.taskDeps;
	}

	/** What /status and the panel read: one snapshot of this guild's session. */
	status() {
		return {
			guildId: this.guild?.id ?? null,
			guildName: this.guild?.name ?? this.guild?.id ?? null,
			personaName: this.persona().name,
			voiceConnected: this.voice.connected,
			voiceChannelName: this.voice.channelId ? (this.guild?.channels.cache.get(this.voice.channelId)?.name ?? null) : null,
			brain: this.brain,
			liveReady: Boolean(this.live?.ready),
			// Holding a connection (open, still connecting or still closing) is what counts against MAX_LIVE_SESSIONS.
			liveOpen: this.holdsLiveSlot(),
			// Filled in when the session is deliberately silent (over the cap) rather than failing.
			liveBlocked: this.liveBlockedReason,
			localMode: this.localMode,
			paused: this.paused,
			latency: this.latency.summary(),
			memberIndexSize: this.memberIndex.size ?? 0,
			music: this.music
				? { playing: this.music.playing, queue: this.music.queue.length, text: this.music.nowPlayingText(), volume: this.music.volume }
				: null,
		};
	}

	/** Stops every timer this guild owns and silences it; safe to call more than once. */
	stop() {
		this.shuttingDown = true;
		// A line that was still being said belongs in the record; a pending flush timer does not outlive
		// the session that armed it.
		for (const key of this.transcriptBuffers.keys()) this.flushTranscript(key);
		this.reportHealth(t('runtime.health_why_stop'));
		if (this.healthTimer) clearInterval(this.healthTimer);
		this.healthTimer = null;
		void this.trace?.close();
		void this.audioTrace?.close();
		this.transcriptBuffers.clear();
		if (this.liveReconnectTimer) clearTimeout(this.liveReconnectTimer);
		this.liveReconnectTimer = null;
		this.clearLiveStableTimer();
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.idleTimer = null;
		if (this.memberRefreshTimer) clearInterval(this.memberRefreshTimer);
		this.memberRefreshTimer = null;
		if (this.sttPollTimer) clearInterval(this.sttPollTimer);
		this.sttPollTimer = null;
		// The reply gate's timers: a judgment still to be asked for and the bot's audio still being held.
		if (this.earlyJudgeTimer) clearTimeout(this.earlyJudgeTimer);
		this.earlyJudgeTimer = null;
		this.dropReplyHold();
		this.stopLocalBrainRetry();
		this.clearRejoinTimers();
		this.interruptLocalSpeech();
		try {
			this.music?.destroy();
		} catch {
			/* ignore */
		}
	}

	/** stop(), and then leave the voice channel and close the live session. */
	async dispose() {
		this.stop();
		try {
			await this.voice.destroy();
		} catch {
			/* ignore */
		}
		// Through retireLive, like every other close, so the slot stays counted until the socket is gone.
		const session = this.live;
		this.live = null;
		if (session) void this.retireLive(session);
		// Every socket still closing, not only the one held last. A permanent leave has already let go of
		// its session (pauseLive), so waiting for this.live alone was over at once: the registry forgot
		// the guild and handed its slot on while the old socket was still open.
		await Promise.allSettled(this.closingLive.values());
	}
}

// The method groups go onto the prototype the way the class body would have put them there: by
// descriptor, so an accessor would be copied rather than read once, and not enumerable, like a method
// written in the class. They stay ordinary instance methods: the tests call them on a session and
// replace them on one, and the rest of the process never needs to know which file a method is in.
for (const methods of [speakerMethods, transcriptMethods, replyGateMethods, liveLinkMethods, localVoiceMethods, settingsMethods]) {
	for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
		Object.defineProperty(GuildSession.prototype, name, { ...descriptor, enumerable: false });
	}
}
