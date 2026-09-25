// Discord voice bot: joins a channel, listens to whoever is speaking, holds a spoken conversation
// over GPT-Live, and is driven from slash commands and the panel; voice commands (switch character,
// send a message to a channel, join a channel, play music) let it operate Discord.
//
//   channel -> per-user Opus -> decode -> mono 24k -> mixer -> GPT-Live (gpt-live-1)
//   channel <- Opus encode <- 48k stereo <- [bot audio + ducked music] <- playback / music
//
// This file keeps the process-wide half only: configuration, the shared services, the Discord client
// and its events, the panel and the shutdown path. Everything that belongs to ONE server lives in a
// GuildSession (src/guildsession.js), and the registry below holds one per server the bot serves
// (cfg.targets: GUILD_ID/CHANNEL_ID plus VOICE_TARGETS). Every Discord event is handed to the session
// of the guild it came from, DMs go to the primary one, and a server the bot has no session for is
// ignored.
//
// Slash commands: join, leave, panel, character, send, read, status, music, summary, record, help

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { OpenAI } from 'openai';
import { handleInteraction, mayStartSession, RecentActions, registerCommands } from './commands.js';
import { loadConfig } from './config.js';
import { maskSecret, updateEnvFile } from './envfile.js';
import { GuildSession } from './guildsession.js';
import { t, tList } from './i18n/index.js';
import { liveSlotsTaken, offerLiveSlots } from './liveslots.js';
import { LocalServerManager, detectVenvPython, setSpeechToken } from './localserver.js';
import { LocalStt } from './localstt.js';
import { MemoryStore } from './memory.js';
import { ReplyLimiter, handleMessage } from './messages.js';
import { LIVE_STATE, MetricsHistory } from './metrics.js';
import { ActivityLog, startPanel } from './panel.js';
import { createTextProvider } from './provider.js';
import { QueueStore } from './queuestore.js';
import { DailyQuota } from './quota.js';
import { ChannelReader } from './reader.js';
import { ReminderStore } from './reminders.js';
import { SavedTracks } from './savedtracks.js';
import { CharacterStore } from './store.js';
import { summarizeConversation } from './summary.js';
import { callTool, toolDefinitions } from './tools.js';
import { roomMayRead } from './tools/access.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

const startedAt = Date.now();

let cfg;
try {
	cfg = loadConfig();
} catch (err) {
	console.error(t('boot.config_failed', { error: err.message }));
	process.exit(1);
}
// A value that was not read as written (a typo in an on/off word, an ID that cannot be one, a number
// moved into its range) is said once, here, before anything acts on it.
for (const warning of cfg.warnings ?? []) console.warn(t('boot.config_warning', { warning }));
// And a default that changed under an existing .env, with how to keep the old behaviour.
for (const note of cfg.notes ?? []) console.warn(t('boot.config_warning', { warning: note }));

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...args) => console.log(`[${stamp()}]`, ...args);

const store = await new CharacterStore(path.join(dataDir, 'characters.json'), { log }).load();
const memory = cfg.memoryEnabled ? await new MemoryStore(path.join(dataDir, 'memory.json')).load() : null;
const quota = await new DailyQuota({ limitSeconds: cfg.dailyLiveSeconds, file: path.join(dataDir, 'quota.json') }).load();
// Reminders outlive the process: they are read back on start and spoken by the ticker further down.
const reminders = await new ReminderStore(path.join(dataDir, 'reminders.json'), { log }).load();
// Saved tracks: one list per person, to be played again by name later.
const savedTracks = await new SavedTracks(path.join(dataDir, 'saved-tracks.json'), { log }).load();
// Music queues, one per server, kept across restarts and taken back (paused) when that server's session
// starts. It holds tracks, not speech, so it is written whatever RECORD_TRANSCRIPTS says (see
// MusicPlayer.snapshot for what is deliberately left out).
const queueStore = cfg.musicEnabled ? await new QueueStore(path.join(dataDir, 'music-queues.json'), { log }).load() : null;
const recentActions = new RecentActions();
const reader = new ChannelReader({ defaultLimit: cfg.readLimit });
const replyLimiter = new ReplyLimiter({ perMinute: 6 });
// The event stream the panel shows: voice transcripts, DM/channel messages, tool calls, gate decisions.
const activity = new ActivityLog({ file: path.join(dataDir, 'activity.jsonl'), log, redact: () => !cfg.recordTranscripts });

/** Privacy: while recording is off, personal text (voice transcript, DM, channel message) is counted, not stored. */
function record(event) {
	if (!cfg.recordTranscripts && ['voice', 'dm', 'channel'].includes(event.kind) && event.text) {
		// The meta of a redacted event is dropped (it can hold personal text too); which server it came
		// from is not personal, and the panel needs it to keep the servers apart.
		const meta = event.meta?.guild ? { guild: event.meta.guild } : null;
		return activity.push({ ...event, text: t('runtime.record_off_placeholder', { count: String(event.text).length }), meta, persist: false });
	}
	return activity.push(event);
}

// ---------------------------------------------------------------- text provider
const openai = new OpenAI({ apiKey: cfg.openaiApiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });
const provider = createTextProvider({
	openai,
	textModel: cfg.textModel,
	deepseek: cfg.deepseekApiKey
		? { client: new OpenAI({ apiKey: cfg.deepseekApiKey, baseURL: cfg.deepseekBaseUrl }), model: cfg.deepseekModel }
		: null,
	log,
});

// ---------------------------------------------------------------- local speech server (ears + mouth)

function safePort(url, fallback) {
	try {
		return Number(new URL(url).port) || fallback;
	} catch {
		return fallback;
	}
}

// The Chatterbox server (TTS + whisper): the bot starts it itself when it is needed. Every request to
// it carries a token: LOCAL_TTS_TOKEN for a server started by hand, or the one each launch is given.
setSpeechToken(cfg.localTtsToken);
const localServer = cfg.localTtsAutostart
	? new LocalServerManager({
			python: cfg.localTtsPython ?? detectVenvPython(path.join(here, '..')),
			script: path.join(here, '..', 'tools', 'chatterbox_server.py'),
			args: ['--port', String(safePort(cfg.localTtsUrl, 8020)), '--model', cfg.localTtsModel, '--stt', cfg.localSttModel],
			token: cfg.localTtsToken,
			// The token of the last launch, for the next start: a server outlives a bot that is killed outright.
			tokenFile: path.join(dataDir, 'chatterbox.token'),
			cwd: path.join(here, '..'),
			log,
		})
	: null;
const localStt = new LocalStt({ url: cfg.localSttUrl, language: cfg.localSttLang, log: (message) => cfg.debug && log(message) });

let client = null;
let panel = null;
let shuttingDown = false;
// The panel's last hour of every server, one row per ten seconds (src/metrics.js). Its memory is fixed
// when it is made: about 52 KB per server, for at most 32 servers.
const panelHistory = new MetricsHistory();

// ---------------------------------------------------------------- keys

// The panel can write the two API keys into .env, the file they are read from at start. A new voice
// session picks a changed OpenAI key up on its own; the clients built above (text, drawing) are the old
// key until the next start, which is what the panel's answer says.
const envFile = path.join(here, '..', '.env');
const KEY_RULES = [
	{ key: 'OPENAI_API_KEY', field: 'openai', pattern: /^sk-[A-Za-z0-9_-]{20,}$/u, label: 'runtime.key_bad_openai' },
	{ key: 'DEEPSEEK_API_KEY', field: 'deepseek', pattern: /^sk-[A-Za-z0-9_-]{20,}$/u, label: 'runtime.key_bad_deepseek' },
];

/** Writes the keys the panel was given; returns what the panel should say back. */
async function applyKeys(patch = {}) {
	const writes = {};
	for (const rule of KEY_RULES) {
		const value = String(patch?.[rule.field] ?? '').trim();
		if (!value) continue;
		if (!rule.pattern.test(value)) return { ok: false, error: t(rule.label) };
		writes[rule.key] = value;
	}
	if (!Object.keys(writes).length) return { ok: false, error: t('runtime.key_nothing') };
	let result;
	try {
		result = await updateEnvFile(envFile, writes);
	} catch (err) {
		log(t('runtime.key_write_failed', { error: err.message }));
		return { ok: false, error: t('runtime.key_write_failed', { error: err.message }) };
	}
	if (writes.OPENAI_API_KEY) cfg.openaiApiKey = writes.OPENAI_API_KEY;
	if (writes.DEEPSEEK_API_KEY) cfg.deepseekApiKey = writes.DEEPSEEK_API_KEY;
	const hints = Object.values(writes).map((value) => maskSecret(value)).join(' ');
	log(t('runtime.keys_updated', { keys: result.changed.join(', '), hints }));
	activity.push({ kind: 'session', text: t('runtime.keys_updated', { keys: result.changed.join(', '), hints }) });
	return { ok: true, changed: result.changed, message: t('runtime.keys_saved') };
}

// ---------------------------------------------------------------- session registry

// One GuildSession per server the bot serves, keyed by guild id. Everything that belongs to a server
// (conversation, model session, audio path, music, speaker attribution) lives inside its own session,
// so the registry is the only place that knows there is more than one.
const sessions = new Map();
// Sessions dropped from the registry whose realtime socket is still closing: they are no longer
// anybody's server, but until the socket is gone they still hold a slot.
const retiring = new Set();

/** The session of one guild, or null when the bot is not set up for that server. */
function sessionFor(guildId) {
	return (guildId ? sessions.get(String(guildId)) : null) ?? null;
}

/** How many guilds hold a realtime connection right now (open, connecting or closing) — what MAX_LIVE_SESSIONS counts. */
function liveSessionCount(except = null) {
	return liveSlotsTaken([...sessions.values(), ...retiring], except);
}

/**
 * A realtime socket has closed somewhere. A server held back by the cap never hears of it on its own —
 * it is not paused, so speech does not reopen it — which is why the registry hands the slot on here.
 */
function offerFreedSlots() {
	// A dropped session is forgotten once its sockets are gone, and not before (see dropSession).
	for (const session of retiring) {
		if (!session.holdsLiveSlot()) retiring.delete(session);
	}
	if (shuttingDown) return;
	for (const session of offerLiveSlots([...sessions.values(), ...retiring], cfg.maxLiveSessions)) {
		log(t('runtime.live_slot_taken', { guild: session.guild?.name ?? session.guild?.id ?? '?' }));
	}
}

/**
 * Builds one guild's session and brings it up: used for every cfg.targets entry at boot, and on demand
 * when /join or the join_voice tool names a channel in a server that has no session yet.
 */
async function ensureSession(guildId, channelId = null) {
	const existing = sessionFor(guildId);
	if (existing) return existing;
	const guild = await client.guilds.fetch(String(guildId));
	const session = new GuildSession({
		cfg,
		client,
		guild,
		channelId,
		store,
		memory,
		quota,
		reader,
		recentActions,
		reminders,
		savedTracks,
		queueStore,
		activity,
		record,
		provider,
		openai,
		localStt,
		localServer,
		log,
		summarize: summarizeConversation,
		presenceEnabled: usePresence,
		// The cost cap lives in the registry because only it can see the other guilds.
		canOpenLive: (asking) => liveSessionCount(asking) < cfg.maxLiveSessions,
		onLiveSlotFreed: () => offerFreedSlots(),
		onPermanentLeave: (left) => dropSession(left),
		joinChannel: (channel) => joinChannel(channel),
	});
	// Stored before start(): joining the channel already produces voice events, and those have to find
	// their session in here.
	sessions.set(guild.id, session);
	try {
		await session.start();
	} catch (err) {
		sessions.delete(guild.id);
		session.stop();
		throw err;
	}
	return session;
}

/** The primary target's session (cfg.guildId), or the first one there is; null when there are none. */
function primarySession() {
	return sessions.get(cfg.guildId) ?? sessions.values().next().value ?? null;
}

/**
 * A permanent leave: an extra server is forgotten (its timers, audio and model session go with it),
 * while the primary target keeps its session exactly as it did before there were several servers.
 */
function dropSession(session) {
	const guildId = session.guild?.id ?? null;
	if (!guildId || guildId === cfg.guildId || sessions.get(guildId) !== session) return;
	sessions.delete(guildId);
	log(t('runtime.session_dropped', { guild: session.guild?.name ?? guildId }));
	session.stop();
	retiring.add(session);
	// dispose() is over when every socket of the session is closed, and offerFreedSlots() then forgets the
	// session. It is not simply deleted here: should a socket outlive dispose() after all, the session keeps
	// its slot until that socket's own close reports in (onLiveSlotFreed) and the slot is really free.
	void session
		.dispose()
		.catch(() => {})
		.finally(() => offerFreedSlots());
}

/** Snapshot of every session; `first` (usually the guild being asked about) is put in front. */
function sessionSnapshots(first = null) {
	const ordered = [...sessions.values()];
	const index = first ? ordered.indexOf(first) : -1;
	if (index > 0) {
		ordered.splice(index, 1);
		ordered.unshift(first);
	}
	return ordered.map((session) => session.status());
}

// What the panel reads while no server has come up (every guild failed, or it is being built): the
// shape of GuildSession.status() with nothing in it, so /healthz and the panel still answer.
const EMPTY_STATUS = {
	guildId: null,
	guildName: null,
	personaName: null,
	voiceConnected: false,
	voiceChannelName: null,
	brain: 'live',
	liveReady: false,
	liveOpen: false,
	liveBlocked: null,
	localMode: false,
	paused: false,
	latency: { count: 0, responseP50: null, responseP90: null, delegationP50: null, toolP50: null, text: '' },
	memberIndexSize: 0,
	music: null,
};

/** One server on the panel's status line: its name, the voice channel it sits in and its brain. */
function describeSessionForPanel(entry) {
	return (
		t('runtime.panel_status_guild', {
			guild: entry.guildName ?? '?',
			channel: entry.voiceConnected ? `#${entry.voiceChannelName ?? '?'}` : t('runtime.panel_off'),
			brain: entry.brain === 'local' ? t('runtime.panel_local') : 'GPT-Live',
		}) + (entry.liveBlocked ? t('runtime.panel_status_guild_silent', { reason: entry.liveBlocked }) : '')
	);
}

// ---------------------------------------------------------------- panel: servers, history, metrics
//
// What the panel's dashboard, its hour of history and /metrics read off the sessions. Everything here
// only reads, and reads numbers and names: no transcript, no message, no reason with words in it.

/** Where a server's realtime session stands, in the words the dashboard uses (see LIVE_STATE). */
function liveStateOf(entry) {
	if (entry.brain === 'local') return 'local';
	if (entry.liveReady) return 'ready';
	if (entry.liveOpen) return 'connecting';
	if (entry.liveBlocked) return 'waiting';
	if (entry.paused) return 'paused';
	return 'off';
}

/** The people (not bots) in the voice channel the bot sits in on that server. */
function voiceMembersOf(session) {
	const channelId = session.voice?.channelId;
	if (!channelId || !session.guild?.voiceStates) return [];
	const people = [];
	for (const state of session.guild.voiceStates.cache.values()) {
		if (state.channelId !== channelId) continue;
		const member = state.member ?? session.guild.members?.cache.get(state.id);
		if (member?.user?.bot) continue;
		people.push(member?.displayName ?? session.nameFor(state.id));
	}
	return people;
}

/** One server as its dashboard card shows it. */
function guildCard(session) {
	const status = session.status();
	// Who the mixer is sending right now under floor control; nobody when the room is quiet.
	const floorId = session.mixer?.floorId ?? null;
	const people = voiceMembersOf(session);
	const quotaStatus = quota.status();
	return {
		id: status.guildId,
		name: status.guildName,
		persona: status.personaName,
		voiceConnected: status.voiceConnected,
		voiceChannel: status.voiceChannelName,
		brain: status.brain,
		live: liveStateOf(status),
		liveBlocked: status.liveBlocked,
		floor: floorId ? session.nameFor(String(floorId)) : null,
		people: people.slice(0, 24),
		peopleCount: people.length,
		music: status.music ? { playing: status.music.playing, text: status.music.text, volume: status.music.volume, queue: status.music.queue } : null,
		quota: { enabled: quota.enabled, used: quotaStatus.used, limit: quotaStatus.limit },
	};
}

/**
 * One server's numbers as they stand, for the history (see MetricsHistory.record) and for /metrics:
 * gauges, running totals, and the recent timing windows with how many were ever taken.
 */
function readingOf(session) {
	const status = session.status();
	const totals = session.health?.totals?.() ?? {};
	const audio = session.audioStats?.() ?? {};
	const bridge = session.voice?.bridge ?? null;
	const placed = (totals.fragmentsSure ?? 0) + (totals.fragmentsLeaning ?? 0);
	return {
		name: status.guildName,
		status,
		totals,
		audio,
		gauges: {
			live_state: LIVE_STATE[liveStateOf(status)] ?? LIVE_STATE.off,
			drift_ms: totals.driftMs ?? 0,
			quota_used_s: quota.status().used,
			people: voiceMembersOf(session).length,
		},
		counters: {
			gate_allowed: totals.gateAllowed ?? 0,
			gate_refused: totals.gateDenied ?? 0,
			jev_calls: totals.jevCalls ?? 0,
			jev_not_for_bot: totals.jevNotForBot ?? 0,
			jev_banter: totals.jevBanter ?? 0,
			jev_failed: totals.jevFailed ?? 0,
			fragments_placed: placed,
			fragments: placed + (totals.fragmentsUnsure ?? 0),
			loop_late_total_ms: bridge?.stats?.lateMsTotal ?? 0,
			loop_wakes: bridge?.stats?.wakes ?? 0,
			// Frames the output could not take, and frames a full input ring threw away.
			dropped_frames: (bridge?.dropped ?? 0) + Math.round(audio.overflow ?? 0),
		},
		samples: {
			response: session.latency?.recent?.('response') ?? { list: [], total: 0 },
			tool: session.latency?.recent?.('tool') ?? { list: [], total: 0 },
			jev: session.health?.jevTimes?.() ?? { list: [], total: 0 },
		},
	};
}

/** The p-th percentile of a timing window, the way the latency meter takes it; null when it is empty. */
function percentileOf(list, q) {
	if (!list?.length) return null;
	const sorted = [...list].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/**
 * The per-server Prometheus families, one sample per server labelled with its id and name. The names
 * the panel had before stay as they were (they describe the primary server); these are added beside them.
 */
function guildFamilies(readings) {
	const families = {};
	const add = (name, type, labels, value) => {
		const family = (families[name] ??= { type, samples: [] });
		family.samples.push({ labels, value });
	};
	for (const { id, reading } of readings) {
		const guild = { guild: id, guild_name: reading.name ?? id };
		const { totals, audio, status } = reading;
		add('guild_live_state', 'gauge', guild, reading.gauges.live_state);
		add('guild_voice_members', 'gauge', guild, reading.gauges.people);
		add('guild_response_p50_ms', 'gauge', guild, status.latency?.responseP50 ?? 0);
		add('guild_response_p90_ms', 'gauge', guild, status.latency?.responseP90 ?? 0);
		add('guild_tool_p50_ms', 'gauge', guild, percentileOf(reading.samples.tool.list, 0.5) ?? 0);
		add('guild_tool_p95_ms', 'gauge', guild, percentileOf(reading.samples.tool.list, 0.95) ?? 0);
		add('gate_decisions_total', 'counter', { ...guild, result: 'allowed' }, totals.gateAllowed ?? 0);
		add('gate_decisions_total', 'counter', { ...guild, result: 'denied' }, totals.gateDenied ?? 0);
		add('jev_calls_total', 'counter', guild, totals.jevCalls ?? 0);
		add('jev_failed_total', 'counter', guild, totals.jevFailed ?? 0);
		add('jev_not_for_bot_total', 'counter', guild, totals.jevNotForBot ?? 0);
		add('jev_banter_total', 'counter', guild, totals.jevBanter ?? 0);
		add('jev_suppressed_total', 'counter', guild, totals.jevSuppressed ?? 0);
		add('jev_median_ms', 'gauge', guild, percentileOf(reading.samples.jev.list, 0.5) ?? 0);
		add('transcript_drift_ms', 'gauge', guild, totals.driftMs ?? 0);
		add('transcript_drift_max_ms', 'gauge', guild, totals.driftMaxMs ?? 0);
		for (const [placement, key] of [
			['sure', 'fragmentsSure'],
			['leaning', 'fragmentsLeaning'],
			['unsure', 'fragmentsUnsure'],
		]) {
			add('fragments_total', 'counter', { ...guild, placement }, totals[key] ?? 0);
		}
		const fragments = reading.counters.fragments;
		add('placed_fragment_ratio', 'gauge', guild, fragments ? reading.counters.fragments_placed / fragments : 0);
		for (const [owner, key] of [
			['named', 'linesNamed'],
			['mixed', 'linesMixed'],
			['unknown', 'linesUnknown'],
		]) {
			add('lines_total', 'counter', { ...guild, owner }, totals[key] ?? 0);
		}
		add('audio_loop_late_avg_ms', 'gauge', guild, audio.avgLateMs ?? 0);
		add('audio_loop_late_max_ms', 'gauge', guild, audio.maxLateMs ?? 0);
		add('audio_dropped_frames_total', 'counter', guild, reading.counters.dropped_frames);
		add('audio_holes_total', 'counter', guild, audio.holes ?? 0);
		add('audio_concealed_total', 'counter', guild, audio.concealed ?? 0);
	}
	return families;
}

/** A display name for a user id: the servers are asked in turn, since a speaker can be in any of them. */
function nameForUser(userId) {
	if (!userId) return null;
	const fallback = `id:${userId}`;
	for (const session of sessions.values()) {
		const name = session.nameFor(userId);
		if (name && name !== fallback) return name;
	}
	return fallback;
}

/**
 * Every join goes through here: /join, the join_voice tool and a rejoin after a permanent leave. A
 * channel in a server with no session gets that session built around it (start() does the join), so a
 * new server can be picked up without a restart.
 *
 * Building one costs a realtime connection on the owner's keys and a MAX_LIVE_SESSIONS slot, so outside
 * cfg.targets it happens only when `requesterId` is the owner or in ADMIN_USER_IDS (mayStartSession).
 * /join passes who asked; the tools pass nobody. They can only name channels of their own session's
 * server, so they reach this branch only once that session has been dropped (left for good), and then a
 * voice in the room must not be able to bring it back in a server nobody configured.
 */
async function joinChannel(channel, { requesterId = null } = {}) {
	const guildId = channel?.guildId ?? channel?.guild?.id ?? null;
	const existing = sessionFor(guildId);
	if (existing) return existing.joinVoice(channel);
	if (guildId) {
		if (!mayStartSession({ cfg, guildId, userId: requesterId })) {
			log(t('runtime.session_start_refused', { guild: channel?.guild?.name ?? guildId }));
			throw new Error(t('runtime.session_start_refused_reason'));
		}
		await ensureSession(guildId, channel.id);
		return undefined;
	}
	return primarySession()?.joinVoice(channel);
}

// ---------------------------------------------------------------- reminders

// A due reminder is spoken in the voice channel of the server it was set in. One that cannot be handed
// over right now — the bot is not in that server, the owner has silenced it — stays in the store and is
// tried again on the next tick: the one thing that must not happen is a reminder disappearing unsaid.
// This is also the only place in the process that writes on a timer, so nothing in it may throw out
// into the event loop.
const REMINDER_TICK_MS = 5_000;
const reminderTimer = setInterval(() => {
	try {
		const { spoken } = reminders.deliverDue({ sessionFor });
		if (spoken.length) reminders.save().catch((err) => log(t('runtime.reminder_save_failed', { error: err.message })));
	} catch (err) {
		log(t('runtime.reminder_tick_failed', { error: err.message }));
	}
}, REMINDER_TICK_MS);
if (typeof reminderTimer.unref === 'function') reminderTimer.unref();

// ---------------------------------------------------------------- command context

/**
 * What a slash command or a panel interaction works on is ONE server's session: the context is built
 * per interaction from the guild it came from, so a command given in server A cannot reach server B.
 * `session` is null when the bot has no session for that guild — then only /join works, and it builds one.
 */
function buildContext(session) {
	return {
		store,
		config: cfg,
		log,
		quota,
		memory,
		hasSession: () => Boolean(session),
		get voice() {
			return session?.voice ?? null;
		},
		get latency() {
			return session?.latency ?? null;
		},
		get music() {
			return session?.music ?? null;
		},
		localMode: () => session?.localMode ?? false,
		brain: () => session?.brain ?? 'live',
		chatterbox: () => localServer?.status ?? null,
		getLive: () => session?.live ?? null,
		refreshPersona: (reason) => session?.refreshPersona(reason),
		say: (text) => session?.say(text),
		applySetting: (name, value) => session?.applySetting(name, value),
		summarize: (options) => session?.deps().summarize(options),
		// Events from an interaction are tagged with the guild they belong to, like the session's own.
		activity: (event) => (session ? session.activity.push(event) : activity.push(event)),
		// Marked as a slash command, and asked for by the person who ran it: commands.js has checked them
		// against their own Discord account, so a tool measures the request against them and not against
		// whoever last spoke in voice. Being allowed to run /read is not being allowed into every channel,
		// so read_messages still asks whether THEY may read the one named. No voice turn is in flight
		// either: the rule about other people's words belongs to the voice turn that read them.
		callTool: (name, args, { userId = null } = {}) => {
			const invoker = userId ? String(userId) : null;
			const deps = session.deps();
			return callTool(name, args, {
				...deps,
				fromSlashCommand: true,
				currentTurn: () => null,
				currentSpeakerId: () => invoker,
				currentSpeakerName: () => (invoker ? session.nameFor(invoker) : null),
				currentSpeakerChannel: () => (invoker ? (session.guild?.voiceStates.cache.get(invoker)?.channel ?? null) : null),
			});
		},
		// May everybody in the bot's voice channel read this channel? /read speaks what it read to the room.
		roomMayRead: (channel) => (session ? roomMayRead(session.deps(), channel) : Promise.resolve(true)),
		joinVoice: (channel, options) => joinChannel(channel, options),
		leaveVoice: (options) => session?.leaveVoice(options),
		// /status reports every server, this one first.
		sessions: () => sessionSnapshots(session),
	};
}

// ---------------------------------------------------------------- lifecycle

async function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(t('runtime.shutting_down'));
	// Silence every server first (timers, audio), then tear the sessions down one by one.
	for (const session of sessions.values()) session.stop();
	try {
		localServer?.stop();
	} catch {
		/* ignore */
	}
	await panel?.close().catch(() => {});
	for (const session of sessions.values()) {
		await session.dispose().catch(() => {});
	}
	sessions.clear();
	try {
		client?.destroy();
	} catch {
		/* ignore */
	}
	process.exitCode = code;
	setTimeout(() => process.exit(code), 2000).unref();
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('unhandledRejection', (reason) =>
	log(t('runtime.unhandled_rejection'), reason instanceof Error ? (cfg.debug ? reason.stack : reason.message) : reason),
);
process.on('uncaughtException', (err) => {
	console.error(t('runtime.uncaught_exception'), err?.stack ?? err);
	void shutdown(1);
});

/**
 * Reads from the application flags which privileged intents are switched on in the portal.
 * (Flags: 12/13 presence, 14/15 members, 18/19 message content — "…_LIMITED" = on for <100 servers.)
 */
async function detectPrivilegedIntents() {
	try {
		const response = await fetch('https://discord.com/api/v10/applications/@me', {
			headers: { Authorization: `Bot ${cfg.discordToken}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const app = await response.json();
		const flags = BigInt(app.flags_new ?? app.flags ?? 0);
		return {
			presence: (flags & ((1n << 12n) | (1n << 13n))) !== 0n,
			guildMembers: (flags & ((1n << 14n) | (1n << 15n))) !== 0n,
			messageContent: (flags & ((1n << 18n) | (1n << 19n))) !== 0n,
		};
	} catch {
		return null;
	}
}

/** With 'auto' it takes the detected value, otherwise the on/off spelling that was written. */
function triState(raw, detected) {
	const value = String(raw ?? 'auto').trim().toLowerCase();
	if (tList('runtime.enabled_words').includes(value)) return true;
	if (tList('runtime.disabled_words').includes(value)) return false;
	return Boolean(detected);
}

const detectedIntents = await detectPrivilegedIntents();
const usePresence = triState(cfg.presence, detectedIntents?.presence);
const useGuildMembers = triState(cfg.guildMembers, detectedIntents?.guildMembers);
const useMessageContent = triState(cfg.messageContent, detectedIntents?.messageContent);

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages];
if (useMessageContent) intents.push(GatewayIntentBits.MessageContent);
if (useGuildMembers) intents.push(GatewayIntentBits.GuildMembers);
if (usePresence) intents.push(GatewayIntentBits.GuildPresences);
client = new Client({ intents, partials: [Partials.Channel] });
client.on(Events.Error, (err) => log(t('runtime.discord_error', { error: err.message })));

client.on(Events.InteractionCreate, (interaction) => {
	// The session of the guild the interaction came from; a guild with no session still gets /join (which
	// builds one) and a plain "not set up for this server" answer for everything else. A DM interaction
	// has no guild, so it works on the primary target.
	const session = interaction.guildId ? sessionFor(interaction.guildId) : primarySession();
	handleInteraction(interaction, buildContext(session)).catch((err) => log(t('runtime.interaction_error', { error: err.message })));
});

client.on(Events.MessageCreate, (message) => {
	const isDm = !message.guild;
	const session = isDm ? null : sessionFor(message.guild.id);
	// A server the bot has no session for does not reach the log, exactly as a foreign server did before.
	if (!isDm && !session) return;
	// A DM belongs to no server: it is answered through the primary session's live connection if there is
	// one, and keeps working when there is no session at all.
	const voiceSession = session ?? primarySession();
	// Guild events are tagged with their server; a DM has none to tag.
	const push = session ? (event) => session.record(event) : record;
	if (message.member) session?.rememberMember(message.member);
	// The ids are for src/summary.js: the log holds every channel of every server, and a summary may only
	// quote the server it is asked in and the channels its audience can read. The name is for the panel.
	const where = isDm
		? null
		: { channel: `#${message.channel?.name ?? '?'}`, channelId: message.channelId ?? message.channel?.id ?? null, guildId: message.guild.id };
	if (!message.author?.bot) {
		const text = String(message.content ?? '').trim() || (message.attachments?.size ? t('runtime.image_placeholder') : '');
		if (text) {
			push({
				kind: isDm ? 'dm' : 'channel',
				direction: 'in',
				who: message.author?.id ?? null,
				whoName: message.member?.displayName ?? message.author?.displayName ?? message.author?.username ?? null,
				text,
				meta: where,
			});
		}
	}
	handleMessage(message, {
		client,
		store,
		provider,
		visionClient: openai,
		cfg,
		// Which server this message may be answered in: the one it came from (it has a session), not the
		// primary target, so a mention in the second server is not dropped.
		guildId: session?.guild?.id ?? cfg.guildId,
		noteTextChannel: (channelId) => session?.noteTextChannel?.(channelId),
		log,
		memory,
		replyLimiter,
		activity: (event) => (session ? session.activity.push(event) : activity.push(event)),
		persona: () => {
			const active = store.getActive();
			return { name: active?.name ?? null, prompt: active?.prompt?.trim() || cfg.instructions };
		},
		getLive: () => voiceSession?.live ?? null,
	})
		.then((reply) => {
			if (!reply) return;
			push({
				kind: isDm ? 'dm' : 'channel',
				direction: 'out',
				whoName: voiceSession?.persona().name ?? 'bot',
				text: reply,
				meta: where,
			});
		})
		.catch((err) => log(t('runtime.message_error', { error: err.message })));
});

// Member and voice events are handed to the session of the server they happened in; a server without
// one is ignored.
client.on(Events.GuildMemberRemove, (member) => {
	sessionFor(member.guild?.id)?.forgetMember(member.id);
});
client.on(Events.GuildMemberUpdate, (_old, member) => {
	sessionFor(member.guild?.id)?.rememberMember(member, { stale: true });
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
	sessionFor(newState?.guild?.id ?? oldState?.guild?.id)?.onVoiceStateUpdate(oldState, newState);
});

client.once(Events.ClientReady, async () => {
	try {
		if (cfg.panelEnabled) {
			const past = await activity.load(500);
			if (past) log(t('boot.panel_history', { count: past }));
		}
		// Every configured server, in order, with the primary target first. One server failing (the bot is
		// not a member, the channel is gone) must not keep the others from coming up, so it is logged and
		// the loop carries on.
		for (const target of cfg.targets) {
			try {
				await registerCommands(client, target.guildId, log);
				await ensureSession(target.guildId, target.channelId);
			} catch (err) {
				log(t('boot.guild_failed', { guild: target.guildId, error: err.message }));
			}
		}
		if (!sessions.size) log(t('boot.no_guilds'));
		const primary = primarySession();

		log(
			t('boot.intents', {
				presence: usePresence ? t('boot.on') : t('boot.off'),
				members: useGuildMembers ? t('boot.on') : t('boot.off'),
				messageContent: useMessageContent ? t('boot.on') : t('boot.off'),
			}),
		);
		log(t('boot.text_generation', { provider: provider.describe() }));
		log(cfg.useResponsesDelegation ? t('boot.tools_backend', { model: cfg.researchModel, count: toolDefinitions().length }) : t('boot.tools_client'));
		if (cfg.ownerPriority && cfg.ownerId) log(t('boot.owner_priority', { owner: cfg.ownerId }));
		log(t(cfg.attribution === 'vote' ? 'boot.attribution_vote' : 'boot.attribution_path'));
		if (!cfg.ownerId) log(t('boot.no_owner_id'));
		if (primary?.music) {
			log(
				t('boot.music_on', {
					volume: Math.round(primary.music.volume * 100),
					duck: Math.round(cfg.musicDuckVolume * 100),
					folder: cfg.musicDir ? t('boot.music_folder', { dir: cfg.musicDir }) : '',
				}),
			);
		}
		log(cfg.brainMode === 'local' ? t('boot.brain_local') : cfg.brainMode === 'auto' ? t('boot.brain_auto') : t('boot.brain_live'));
		if (localServer) {
			log(
				localServer.python
					? t('boot.chatterbox_autostart', { model: cfg.localTtsModel, stt: cfg.localSttModel })
					: t('boot.chatterbox_missing_venv'),
			);
		}
		if (quota.enabled) log(t('boot.daily_quota', { limit: Math.round(cfg.dailyLiveSeconds / 60), used: Math.round(quota.status().used / 60) }));
		if (!cfg.recordTranscripts) log(t('boot.record_off'));
		if (memory) log(t('boot.memory_on', { users: memory.stats().users, notes: memory.stats().notes }));

		// The local admin panel: DM/channel messages, voice transcripts, tool and gate records, health/metric endpoints.
		if (cfg.panelEnabled) {
			try {
				panel = await startPanel({
					activity,
					port: cfg.panelPort,
					host: cfg.panelHost,
					token: cfg.panelToken,
					allowedHosts: cfg.panelAllowedHosts,
					log,
					// The keys may be entered here; they are written to .env, which is where they are read from.
					keys: () => ({ openai: maskSecret(cfg.openaiApiKey), deepseek: maskSecret(cfg.deepseekApiKey) }),
					applyKeys: (patch) => applyKeys(patch),
					// Who is speaking can be someone in any of the servers, so every session gets asked.
					nameFor: (userId) => nameForUser(userId),
					// The dashboard: one card per server, the primary first, and an hour of each server's numbers.
					guilds: () => {
						const primary = primarySession();
						return [...sessions.values()].sort((a, b) => (b === primary) - (a === primary)).map((session) => guildCard(session));
					},
					history: panelHistory,
					sample: () => [...sessions.values()].filter((session) => session.guild?.id).map((session) => ({ id: session.guild.id, reading: readingOf(session) })),
					state: () => {
						const snapshots = sessionSnapshots(primarySession());
						const snapshot = snapshots[0] ?? EMPTY_STATUS;
						const stats = snapshot.latency;
						const counts = activity.stats();
						const quotaStatus = quota.status();
						return {
							title: t('runtime.panel_title', { name: snapshot.personaName ?? t('runtime.panel_default_name') }),
							// Tells the panel to put the server name in front of each event; with one server the
							// events carry the tag in their meta but nothing about the page changes.
							multiGuild: snapshots.length > 1,
							status:
								// One server keeps the line it always had; with several, each of them is named with its
								// own channel and brain so the panel can be read at a glance.
								(snapshots.length > 1
									? snapshots.map((entry) => describeSessionForPanel(entry)).join(' | ')
									: t('runtime.panel_status_voice', {
											channel: snapshot.voiceConnected ? `#${snapshot.voiceChannelName ?? '?'}` : t('runtime.panel_off'),
										}) + t('runtime.panel_status_brain', { brain: snapshot.brain === 'local' ? t('runtime.panel_local') : 'GPT-Live' })) +
								(localServer ? t('runtime.panel_status_chatterbox', { status: localServer.status }) : '') +
								t('runtime.panel_status_live', {
									state: snapshots.some((entry) => entry.liveReady) ? t('runtime.panel_on') : t('runtime.panel_off'),
								}) +
								t('runtime.panel_status_record', { state: cfg.recordTranscripts ? t('runtime.panel_on') : t('runtime.panel_off') }) +
								t('runtime.panel_status_events', { count: counts.total ?? 0 }),
							metrics: [
								{ label: t('runtime.panel_metric_dm'), value: counts.dm ?? 0 },
								{ label: t('runtime.panel_metric_channel'), value: counts.channel ?? 0 },
								{ label: t('runtime.panel_metric_voice'), value: counts.voice ?? 0 },
								{ label: t('runtime.panel_metric_tool'), value: counts.tool ?? 0 },
								{ label: t('runtime.panel_metric_gate'), value: counts.gate ?? 0 },
								{
									label: t('runtime.panel_metric_response_p50'),
									value: stats.responseP50 === null ? '—' : t('runtime.seconds_value', { seconds: (stats.responseP50 / 1000).toFixed(1) }),
								},
								{ label: t('runtime.panel_metric_voice_source'), value: snapshot.localMode ? t('runtime.panel_local') : 'GPT-Live' },
								{
									label: t('runtime.panel_metric_sessions'),
									value: t('runtime.panel_metric_sessions_value', {
										count: snapshots.length,
										live: snapshots.filter((entry) => entry.liveOpen).length,
									}),
								},
								{ label: t('runtime.panel_metric_member_index'), value: snapshot.memberIndexSize },
								{ label: t('runtime.panel_metric_memory_notes'), value: memory?.stats().notes ?? 0 },
								{
									label: t('runtime.panel_metric_daily_live'),
									value: quota.enabled
										? t('runtime.minutes_pair', { used: Math.round(quotaStatus.used / 60), limit: Math.round(quotaStatus.limit / 60) })
										: t('runtime.minutes_value', { used: Math.round(quotaStatus.used / 60) }),
								},
							],
							// With one server this is the line it always was; with several, every server that is
							// playing something gets its own.
							music: snapshots
								.filter((entry) => entry.music)
								.map((entry) => t('runtime.panel_music', { now: entry.music.text, volume: Math.round(entry.music.volume * 100) }))
								.join(' · '),
						};
					},
					metrics: () => {
						const snapshots = sessionSnapshots(primarySession());
						const snapshot = snapshots[0] ?? EMPTY_STATUS;
						const stats = snapshot.latency;
						const counts = activity.stats();
						const quotaStatus = quota.status();
						return {
							up: 1,
							uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
							voice_connected: snapshot.voiceConnected ? 1 : 0,
							live_ready: snapshot.liveReady ? 1 : 0,
							events_total: counts.total ?? 0,
							events_voice: counts.voice ?? 0,
							events_dm: counts.dm ?? 0,
							events_channel: counts.channel ?? 0,
							events_tool: counts.tool ?? 0,
							events_gate: counts.gate ?? 0,
							response_p50_ms: stats.responseP50 ?? 0,
							response_p90_ms: stats.responseP90 ?? 0,
							delegation_p50_ms: stats.delegationP50 ?? 0,
							tool_p50_ms: stats.toolP50 ?? 0,
							live_seconds_today: quotaStatus.used,
							live_quota_seconds: quotaStatus.limit,
							music_playing: snapshot.music?.playing ? 1 : 0,
							music_queue: snapshot.music?.queue ?? 0,
							member_index_size: snapshot.memberIndexSize,
							memory_notes: memory?.stats().notes ?? 0,
							// Every metric name above keeps describing the primary target; these two are the whole fleet.
							sessions_total: snapshots.length,
							sessions_live: snapshots.filter((entry) => entry.liveOpen).length,
							// And these, one sample per server, labelled with it.
							...guildFamilies(
								[...sessions.values()].filter((session) => session.guild?.id).map((session) => ({ id: session.guild.id, reading: readingOf(session) })),
							),
						};
					},
					health: () => {
						const snapshot = primarySession()?.status() ?? EMPTY_STATUS;
						return {
							ok: Boolean(client?.isReady?.()),
							discord: Boolean(client?.isReady?.()),
							voice: snapshot.voiceConnected,
							brain: snapshot.brain,
							chatterbox: localServer?.status ?? null,
							live: snapshot.liveReady,
							paused: snapshot.paused,
							quotaExceeded: quota.status().exceeded,
							uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
						};
					},
				});
			} catch (err) {
				log(t('boot.panel_failed', { error: err.message }));
			}
		}
	} catch (err) {
		console.error(t('boot.setup_failed', { error: err.message }));
		void shutdown(1);
	}
});

client.login(cfg.discordToken).catch((err) => {
	console.error(t('boot.login_failed', { error: err.message }));
	process.exitCode = 1;
	client.destroy();
});
