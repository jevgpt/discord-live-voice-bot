// Environment-backed configuration. Fails loudly instead of half-working: a missing required variable
// stops the start, and a value that cannot be read as written keeps its default and is reported (see
// report() below), so a typo in .env is visible instead of silently meaning something else.

import { FALLBACK_LOCALE, SUPPORTED_LOCALES, resolveLocale, t, tList } from './i18n/index.js';
import { normalize } from './text.js';

/** Fallback persona of the assistant: the lines are joined with spaces, exactly as they were written. */
function DEFAULT_INSTRUCTIONS() {
	return tList('config.default_instructions').join(' ');
}

/**
 * Cleans up an .env value: when a line from .env.example such as "KEY=value   (note)" or
 * "KEY=value  # note" is copied verbatim, Node treats the note as part of the value; the "(...)" or
 * "#..." tail that follows two or more spaces is dropped. Quoted values come back unquoted.
 */
export function cleanEnvValue(value) {
	if (value === undefined || value === null) return '';
	let text = String(value).replace(/\s{2,}(?:\(.*\)?|#.*)$/u, '').trim();
	if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
		text = text.slice(1, -1).trim();
	}
	return text;
}

// ---------------------------------------------------------------- warnings

// What one loadConfig() call found wrong with the values it was given. Nothing here throws; the list is
// handed back on the configuration (a non-enumerable `warnings`) and index.js prints it once at start.
//
// The helpers below are handed a value, not a variable name (`bool(env.PANEL, true)`), so that every
// line of the configuration reads the same way and a newly added line is checked without being written
// differently. The name is recovered from the read itself: loadConfig() reads the environment through a
// view that notes each variable as it is read, and a helper with something to report names the most
// recent read that produced its value, which is the argument it was just called with.
let parsing = null;

function report(value, key, params = {}) {
	if (!parsing) return;
	const name = parsing.reads.findLast(([, read]) => read === value)?.[0] ?? '?';
	const text = t(key, { key: name, value: cleanEnvValue(value), ...params });
	if (!parsing.warnings.includes(text)) parsing.warnings.push(text);
}

// ---------------------------------------------------------------- values

// Spellings of on and off, and of "leave this field out". Every bundled language contributes its words
// and all of them are accepted whatever BOT_LANGUAGE says, so switching the interface language never
// changes what an existing .env means: "kapalı" is off in an English session and "off" in a Turkish one.
// A word is compared as written (lower-cased) and folded (normalize() drops the Turkish letters, so
// "KAPALI", "kapali" and "kapalı" are the same word).
function spellings(key) {
	const words = SUPPORTED_LOCALES.flatMap((code) => tList(key, null, code)).map((word) => String(word));
	return new Set(words.flatMap((word) => [word.toLowerCase(), normalize(word)]).filter(Boolean));
}
const ON_WORDS = spellings('config.on_words');
const OFF_WORDS = spellings('config.off_words');
const NONE_WORDS = spellings('config.none_words');

function spelled(words, text) {
	return words.has(text.toLowerCase()) || words.has(normalize(text));
}

/** true / false for a recognised on/off spelling, null for anything else. */
function onOff(text) {
	if (spelled(ON_WORDS, text)) return true;
	if (spelled(OFF_WORDS, text)) return false;
	return null;
}

/** On/off setting. A value that is neither ("of", "maybe") keeps the default and is reported. */
function bool(value, fallback = false) {
	const text = cleanEnvValue(value);
	if (!text) return fallback;
	const parsed = onOff(text);
	if (parsed !== null) return parsed;
	report(value, 'config.warn_bool', { fallback: t(fallback ? 'boot.on' : 'boot.off') });
	return fallback;
}

/**
 * Numeric setting: empty falls back to the default (no NaN leaks), with an optional range. A value that
 * is not a number keeps the default, and one outside the range is moved to its edge; both are reported.
 */
function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
	const text = cleanEnvValue(value);
	if (!text) return fallback;
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) {
		report(value, 'config.warn_number', { fallback });
		return fallback;
	}
	if (parsed < min) report(value, 'config.warn_below', { limit: min });
	if (parsed > max) report(value, 'config.warn_above', { limit: max });
	return Math.min(max, Math.max(min, parsed));
}

/** One of a fixed set of words, case-insensitively; anything else keeps the default and is reported. */
function oneOf(value, choices, fallback) {
	const text = cleanEnvValue(value).toLowerCase();
	if (!text) return fallback;
	if (choices.includes(text)) return text;
	report(value, 'config.warn_choice', { choices: choices.join(', '), fallback });
	return fallback;
}

/**
 * A privileged intent: "auto" asks the Developer Portal (index.js), an on/off spelling forces it. The
 * value comes back as "auto", "on" or "off", which index.js reads the same in every language.
 */
function intent(value) {
	const text = cleanEnvValue(value);
	if (!text || text.toLowerCase() === 'auto') return 'auto';
	const parsed = onOff(text);
	if (parsed !== null) return parsed ? 'on' : 'off';
	report(value, 'config.warn_intent');
	return 'auto';
}

// A Discord ID (server, channel, user, role) is a snowflake: 17 to 20 digits. Anything else can never
// match, and would otherwise only show up as a bot that quietly ignores somebody.
const SNOWFLAKE = /^\d{17,20}$/u;

/** One Discord ID, kept as written; reported when it cannot be one. */
function id(value) {
	const text = str(value);
	if (text && !SNOWFLAKE.test(text)) report(value, 'config.warn_snowflake');
	return text;
}

/** A comma-separated list of Discord IDs; every entry that cannot be one is reported. */
function ids(value) {
	const entries = list(value);
	for (const entry of entries) {
		if (!SNOWFLAKE.test(entry)) report(value, 'config.warn_snowflake', { value: entry });
	}
	return entries;
}

/** BOT_LANGUAGE -> the bundled locale it picks (the same rule src/i18n applies at import time). */
function language(value) {
	const text = cleanEnvValue(value);
	if (!text) return FALLBACK_LOCALE;
	const { code, known } = resolveLocale(text);
	if (!known) report(value, 'config.warn_language', { supported: SUPPORTED_LOCALES.join(', '), fallback: code });
	return code;
}

/** Comma-separated list. */
function list(value) {
	return cleanEnvValue(value)
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * The servers the bot sits in. GUILD_ID/CHANNEL_ID is the PRIMARY pair and always comes first;
 * VOICE_TARGETS adds more servers as a comma-separated list of "guildId:channelId" pairs.
 *
 * A guild that appears twice keeps its FIRST channel (one voice channel per server), and an entry
 * that is not a "guild:channel" pair is skipped. Neither throws: one mistyped extra target must not keep
 * the primary server from booting. Both are reported instead, as is an ID that cannot be a Discord ID;
 * repeating a pair exactly as it already stands changes nothing and says nothing.
 */
function voiceTargets(value, primary) {
	const targets = [primary];
	const channels = new Map([[primary.guildId, primary.channelId]]);
	for (const entry of list(value)) {
		const parts = entry.split(':').map((part) => part.trim());
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			report(value, 'config.warn_target_pair', { entry });
			continue;
		}
		const [guildId, channelId] = parts;
		if (channels.has(guildId)) {
			const kept = channels.get(guildId);
			if (kept !== channelId) report(value, 'config.warn_target_repeat', { entry, guild: guildId, channel: kept });
			continue;
		}
		for (const part of parts) {
			if (!SNOWFLAKE.test(part)) report(value, 'config.warn_snowflake', { value: part });
		}
		channels.set(guildId, channelId);
		targets.push({ guildId, channelId });
	}
	return targets;
}

// Empty/off/none -> the field is not sent at all; undefined -> the default.
function effortValue(value, fallback) {
	if (value === undefined || value === null) return fallback;
	const text = cleanEnvValue(value);
	if (!text || spelled(NONE_WORDS, text)) return null;
	return text;
}

function str(value, fallback = null) {
	const text = cleanEnvValue(value);
	return text || fallback;
}

/**
 * The panel's switch, port, bind address and token, read exactly as loadConfig reads them. The
 * container's health check (src/healthcheck.js) reads them through here as well: with a rule of its own
 * for "off" it did not know PANEL=disabled, kapalı or a quoted "0", asked a panel that had never
 * started, and called a working bot unhealthy.
 */
export function panelSettings(env = process.env) {
	return {
		// Local admin panel (127.0.0.1 by default): PANEL=0 turns it off, PANEL_PORT picks the port (0 = random).
		panelEnabled: bool(env.PANEL, true),
		panelPort: num(env.PANEL_PORT, 8787, { min: 0, max: 65_535 }),
		// Where the panel listens; anything beyond loopback (a container, a reverse proxy) needs PANEL_TOKEN,
		// and PANEL_ALLOWED_HOSTS adds the names it is reached by to the Host-header check.
		panelHost: str(env.PANEL_HOST, '127.0.0.1'),
		panelToken: str(env.PANEL_TOKEN),
	};
}

/**
 * LOCAL_TTS_LANG and LOCAL_STT_LANG used to mean Turkish when unset. Now the local voice speaks the bot's
 * language and whisper detects the language of each line, so a Turkish setup that never wrote them down
 * would start speaking English without a word. It is told once, at start, how to keep what it had: when
 * one of them is unset, BOT_LANGUAGE is unset too (a language chosen there is a decision already made),
 * and the local voice or ears can be used at all.
 */
function languageDefaultsNote(env, config) {
	if (cleanEnvValue(env.BOT_LANGUAGE)) return null;
	const localSpeech = config.localTtsEnabled || config.localTtsOn || config.brainMode !== 'live';
	const unset = ['LOCAL_TTS_LANG', 'LOCAL_STT_LANG'].filter((key) => !cleanEnvValue(env[key]));
	if (!localSpeech || !unset.length) return null;
	return t('config.note_language_defaults', { fix: unset.map((key) => `${key}=tr`).join(' ') });
}

/**
 * Reads the configuration from `source` (process.env by default). Throws only when a required variable
 * is missing; every other problem is collected into `config.warnings`, a non-enumerable array of
 * sentences in the active language, so the returned object keeps exactly the fields it always had.
 * `config.notes`, non-enumerable as well, holds what an existing .env should know about a changed default.
 */
export function loadConfig(source = process.env) {
	const reads = [];
	const env = new Proxy(source, {
		get(target, name) {
			const value = Reflect.get(target, name);
			if (typeof name === 'string') reads.push([name, value]);
			return value;
		},
	});
	parsing = { reads, warnings: [] };
	try {
		const config = readConfig(env);
		Object.defineProperty(config, 'warnings', { value: parsing.warnings, enumerable: false });
		// Not a value misread but a default that changed under an existing .env; printed at start beside the
		// warnings, and kept apart from them, so that a clean .env still has no warnings to show.
		const note = languageDefaultsNote(env, config);
		Object.defineProperty(config, 'notes', { value: note ? [note] : [], enumerable: false });
		return config;
	} finally {
		parsing = null;
	}
}

function readConfig(env) {
	const missing = ['DISCORD_TOKEN', 'GUILD_ID', 'CHANNEL_ID', 'OPENAI_API_KEY'].filter((key) => !str(env[key]));
	if (missing.length) {
		throw new Error(t(missing.length > 1 ? 'config.missing_env_many' : 'config.missing_env_one', { keys: missing.join(', ') }));
	}

	const deepseekApiKey = str(env.DEEPSEEK_API_KEY);
	const researchModel = str(env.RESEARCH_MODEL) ?? str(env.DELEGATION_MODEL);
	// Tool backend: auto = Responses (every tool + web search) when RESEARCH_MODEL/DELEGATION_MODEL is set,
	// otherwise client-side delegation (regex voice commands only + DeepSeek/OpenAI research).
	const toolsBackend = oneOf(env.TOOLS_BACKEND, ['auto', 'responses', 'client'], 'auto');
	// The locale BOT_LANGUAGE picks, resolved exactly as src/i18n resolved it at import time. Other
	// language settings default to it, so a Turkish bot speaks Turkish through Chatterbox as well.
	const botLanguage = language(env.BOT_LANGUAGE);

	const config = {
		discordToken: str(env.DISCORD_TOKEN),
		guildId: id(env.GUILD_ID),
		channelId: id(env.CHANNEL_ID),
		// Every server the bot serves, the primary pair first (see voiceTargets above).
		targets: voiceTargets(env.VOICE_TARGETS, { guildId: str(env.GUILD_ID), channelId: str(env.CHANNEL_ID) }),
		// Cost cap: how many guilds may hold an OPEN realtime session at the same time. The bill grows
		// linearly with this number, so extra servers stay silent (music and tools still work) instead of
		// quietly multiplying the cost.
		maxLiveSessions: Math.floor(num(env.MAX_LIVE_SESSIONS, 2, { min: 1 })),
		openaiApiKey: str(env.OPENAI_API_KEY),

		// UI/voice language of the assistant: the locale code BOT_LANGUAGE resolved to (default "en";
		// see SUPPORTED_LOCALES in src/i18n). An unknown value is reported and English is used.
		language: botLanguage,
		baseURL: str(env.OPENAI_BASE_URL) ?? undefined,
		liveModel: str(env.LIVE_MODEL, 'gpt-live-1'),
		liveVoice: str(env.LIVE_VOICE, 'marin'),
		instructions: str(env.LIVE_INSTRUCTIONS, DEFAULT_INSTRUCTIONS()),
		// Research / tool backend model (Responses API + web_search). Client delegation when empty.
		researchModel,
		toolsBackend,
		useResponsesDelegation: toolsBackend === 'responses' || (toolsBackend === 'auto' && Boolean(researchModel)),
		backendEffort: effortValue(env.LIVE_BACKEND_EFFORT, 'low'),
		backendTier: effortValue(env.LIVE_BACKEND_TIER, null),
		// The local admin panel (see panelSettings above).
		...panelSettings(env),
		panelAllowedHosts: list(env.PANEL_ALLOWED_HOSTS),
		// Local TTS (Chatterbox)
		localTtsEnabled: bool(env.LOCAL_TTS, false),
		localTtsOn: bool(env.LOCAL_TTS_START, false),
		localTtsUrl: str(env.LOCAL_TTS_URL, 'http://127.0.0.1:8020'),
		// Shared token for the speech server (X-Chatterbox-Token). Empty: the server the bot starts gets a
		// fresh random one at every launch, and one started by hand needs none.
		localTtsToken: str(env.LOCAL_TTS_TOKEN),
		localTtsVoice: str(env.LOCAL_TTS_VOICE),
		// "auto": guess the language of the text (tr/en/de/fr/es/it/pt/ru); any other value is a fixed language code.
		// Unset, the voice speaks the bot's own language.
		localTtsLang: str(env.LOCAL_TTS_LANG, botLanguage),
		// Let the bot start the Chatterbox server itself (when needed, from .venv-chatterbox). LOCAL_TTS_PYTHON can point at the interpreter.
		localTtsAutostart: bool(env.LOCAL_TTS_AUTOSTART, true),
		localTtsPython: str(env.LOCAL_TTS_PYTHON),
		localTtsModel: str(env.LOCAL_TTS_MODEL, 'multilingual'),
		localSttModel: str(env.LOCAL_STT_MODEL, 'small'),
		// Local brain (voice chat without OpenAI): ears = whisper (/stt), brain = DeepSeek/OpenAI chat, mouth = Chatterbox.
		// auto = switch to the local brain when GPT-Live reports a credit/key error and switch back once it recovers;
		// local = always local; live = never switch.
		brainMode: oneOf(env.BRAIN_MODE, ['auto', 'local', 'live'], 'auto'),
		localSttUrl: str(env.LOCAL_STT_URL) ?? str(env.LOCAL_TTS_URL, 'http://127.0.0.1:8020'),
		// A language code fixes what whisper listens for; "auto" (the default) lets it detect the language of
		// every line, which is what LocalStt does with any value it does not pass on.
		localSttLang: str(env.LOCAL_STT_LANG, 'auto'),
		// Who the local brain answers: auto (name/single person/ongoing conversation/question), addressed (only when named), always
		localBrainRespond: oneOf(env.LOCAL_BRAIN_RESPOND, ['auto', 'addressed', 'always'], 'auto'),
		// OpenAI model for written replies (DM / mention). With DeepSeek configured the text goes there,
		// while images are still handled by this OpenAI model.
		textModel: str(env.TEXT_MODEL) ?? str(env.DELEGATION_MODEL) ?? 'gpt-5.6-luna',
		// Drawing ("draw me X") goes to the OpenAI images API; model and size are passed straight through.
		imageModel: str(env.IMAGE_MODEL, 'gpt-image-1'),
		imageSize: str(env.IMAGE_SIZE, '1024x1024'),
		deepseekApiKey,
		deepseekBaseUrl: str(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com'),
		deepseekModel: str(env.DEEPSEEK_MODEL, 'deepseek-chat'),
		// Jev (TypeSafe System One): typed judgments about each finished line. Off without a key.
		jev: bool(env.JEV, true),
		jevApiKey: str(env.JEV_API_KEY),
		jevModel: str(env.JEV_MODEL, 'jev-latest'),
		// With Jev: a reply to a line that was not for the bot is kept off the channel (see GuildSession.judgeEarly).
		jevReplyGate: bool(env.JEV_REPLY_GATE, true),
		// Requests per session before Jev goes quiet; 0 = no cap.
		jevMaxCalls: num(env.JEV_MAX_CALLS, 3000, { min: 0 }),
		// The flight recorder: frames, fragments and decisions to data/traces/, for scripts/replay-trace.mjs.
		trace: bool(env.TRACE, false),
		// Exactly the audio sent to the model, as a WAV under data/traces/: what the far end heard.
		traceAudio: bool(env.TRACE_AUDIO, false),
		leaveDelayMs: num(env.LEAVE_DELAY_MS, 2500, { min: 0 }),
		respondToDms: bool(env.RESPOND_DMS, true),
		respondToMentions: bool(env.RESPOND_MENTIONS, true),
		// Should a written reply given in a text channel also be spoken in the voice channel (off: text stays text).
		voiceEchoTextReplies: bool(env.VOICE_ECHO_TEXT_REPLIES, false),
		greetText: str(env.GREET_TEXT),

		soloUserId: id(env.SOLO_USER_ID),
		textChannelId: id(env.TEXT_CHANNEL_ID),
		readLimit: num(env.READ_LIMIT, 5, { min: 1, max: 10 }),
		allowedBots: list(env.ALLOWED_BOTS),
		botPrefix: str(env.BOT_PREFIX, '!'),
		botCommandChannelId: id(env.BOT_COMMAND_CHANNEL),
		// Privileged intents: "auto", "on" or "off" (see intent() above).
		messageContent: intent(env.MESSAGE_CONTENT),
		guildMembers: intent(env.GUILD_MEMBERS),
		presence: intent(env.PRESENCE),

		// Authorisation: owner (voice admin tools + everything), extra admin user/role ids (slash/panel).
		// With OWNER_ID empty the voice admin tools are off; there is NO hard-coded default.
		ownerId: id(env.OWNER_ID),
		adminUserIds: ids(env.ADMIN_USER_IDS),
		adminRoleIds: ids(env.ADMIN_ROLE_IDS),
		ownerPriority: bool(env.OWNER_PRIORITY, true),
		// One voice at a time: while somebody holds the floor only their audio is sent (see SpeakerMixer).
		floorControl: bool(env.FLOOR_CONTROL, true),
		// Per-speaker loudness normalisation before the audio goes to the model (speech towards -20 dBFS).
		agc: bool(env.AGC, true),
		// A talk-spurt is read from this many frames in (a frame's margin against a late packet); 1 = read at once.
		primeFrames: num(env.PRIME_FRAMES, 2, { min: 1, max: 5 }),
		// Give the model silent context about who is speaking (name, owner or not, memory notes); off means it cannot tell people apart.
		announceSpeaker: bool(env.ANNOUNCE_SPEAKER, true),
		transcripts: bool(env.TRANSCRIPTS, true),
		debug: bool(env.DEBUG, false),
		// The realtime protocol's own events, separately: DEBUG is for understanding what the bot decided,
		// and the event stream is a different question that drowns it out at several lines a second.
		debugLive: bool(env.DEBUG_LIVE, false),
		// How long the local ear waits after the last packet before deciding somebody has stopped talking.
		// It sits in front of everything else in local mode, so it is the cheapest thing to trade against
		// being cut off mid-sentence. Left where it was by default.
		sttSilenceMs: num(env.LOCAL_STT_SILENCE_MS, 700, { min: 200, max: 3000 }),
		idleCloseMs: num(env.IDLE_CLOSE_MINUTES, 10, { min: 0 }) * 60_000,

		// Cost: daily GPT-Live quota in seconds (0 = unlimited). Once it is used up the session stays closed until the next day.
		dailyLiveSeconds: num(env.DAILY_LIVE_SECONDS, 0, { min: 0 }),
		// DM rate limit (total per minute / per target)
		dmPerMinute: num(env.DM_PER_MINUTE, 10, { min: 1 }),
		dmPerTargetPerMinute: num(env.DM_PER_TARGET_PER_MINUTE, 3, { min: 1 }),

		// Privacy: should voice transcripts and message texts be written to the panel log (off: they are only counted).
		recordTranscripts: bool(env.RECORD_TRANSCRIPTS, true),
		// Should a short notice be posted in the default text channel when the bot joins a channel.
		joinNotice: bool(env.JOIN_NOTICE, false),

		// Persistent memory (per-person notes, data/memory.json)
		memoryEnabled: bool(env.MEMORY, true),

		// Music: the bot playing tracks itself (yt-dlp + ffmpeg) and ducking while someone speaks.
		musicEnabled: bool(env.MUSIC, true),
		musicVolume: num(env.MUSIC_VOLUME, 35, { min: 0, max: 100 }) / 100,
		musicDuckVolume: num(env.MUSIC_DUCK_VOLUME, 12, { min: 0, max: 100 }) / 100,
		musicDuckHoldMs: num(env.MUSIC_DUCK_HOLD_MS, 700, { min: 0 }),
		musicDir: str(env.MUSIC_DIR),
		// Show the playing track under the bot's name; the status line comes back when the music stops.
		presenceMusic: bool(env.PRESENCE_MUSIC, true),
		musicMaxMinutes: num(env.MUSIC_MAX_MINUTES, 20, { min: 0 }),
		ytDlpPath: str(env.YTDLP_PATH),
		// Downloading yt-dlp and running it is a supply-chain decision; 0 makes the operator install it.
		ytDlpAutoDownload: bool(env.YTDLP_AUTO_DOWNLOAD, true),
		ffmpegPath: str(env.FFMPEG_PATH),
	};
	return config;
}
