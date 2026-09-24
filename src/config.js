// Environment-backed configuration. Fails loudly instead of half-working.

import { t, tList } from './i18n/index.js';

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

function bool(value, fallback = false) {
	const text = cleanEnvValue(value);
	if (!text) return fallback;
	// The spellings that mean "off" come from the locale, so a translated .env keeps working.
	return !new RegExp(`^(?:${tList('config.off_words').join('|')})$`, 'i').test(text);
}

/** Numeric setting: empty/invalid falls back to the default (no NaN leaks), with an optional range. */
function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
	const text = cleanEnvValue(value);
	if (!text) return fallback;
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
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
 * that is not a "guild:channel" pair is skipped. Nothing is logged from here: config.js either throws
 * in the "missing variable" style (a whole unusable configuration) or stays quiet, and one mistyped
 * extra target must not keep the primary server from booting.
 */
function voiceTargets(value, primary) {
	const targets = [primary];
	const seen = new Set([primary.guildId]);
	for (const entry of list(value)) {
		const parts = entry.split(':').map((part) => part.trim());
		if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
		const [guildId, channelId] = parts;
		if (seen.has(guildId)) continue;
		seen.add(guildId);
		targets.push({ guildId, channelId });
	}
	return targets;
}

// Empty/off/none -> the field is not sent at all; undefined -> the default.
function effortValue(value, fallback) {
	if (value === undefined || value === null) return fallback;
	const text = cleanEnvValue(value);
	if (!text || new RegExp(`^(?:${tList('config.none_words').join('|')})$`, 'i').test(text)) return null;
	return text;
}

function str(value, fallback = null) {
	const text = cleanEnvValue(value);
	return text || fallback;
}

export function loadConfig(env = process.env) {
	const missing = ['DISCORD_TOKEN', 'GUILD_ID', 'CHANNEL_ID', 'OPENAI_API_KEY'].filter((key) => !str(env[key]));
	if (missing.length) {
		throw new Error(t(missing.length > 1 ? 'config.missing_env_many' : 'config.missing_env_one', { keys: missing.join(', ') }));
	}

	const deepseekApiKey = str(env.DEEPSEEK_API_KEY);
	const researchModel = str(env.RESEARCH_MODEL) ?? str(env.DELEGATION_MODEL);
	// Tool backend: auto = Responses (every tool + web search) when RESEARCH_MODEL/DELEGATION_MODEL is set,
	// otherwise client-side delegation (regex voice commands only + DeepSeek/OpenAI research).
	const toolsBackendRaw = str(env.TOOLS_BACKEND, 'auto').toLowerCase();
	const toolsBackend = ['auto', 'responses', 'client'].includes(toolsBackendRaw) ? toolsBackendRaw : 'auto';

	const config = {
		discordToken: str(env.DISCORD_TOKEN),
		guildId: str(env.GUILD_ID),
		channelId: str(env.CHANNEL_ID),
		// Every server the bot serves, the primary pair first (see voiceTargets above).
		targets: voiceTargets(env.VOICE_TARGETS, { guildId: str(env.GUILD_ID), channelId: str(env.CHANNEL_ID) }),
		// Cost cap: how many guilds may hold an OPEN realtime session at the same time. The bill grows
		// linearly with this number, so extra servers stay silent (music and tools still work) instead of
		// quietly multiplying the cost.
		maxLiveSessions: Math.floor(num(env.MAX_LIVE_SESSIONS, 2, { min: 1 })),
		openaiApiKey: str(env.OPENAI_API_KEY),

		// UI/voice language of the assistant: locale code from src/locales (default "en"; "tr" available).
		language: str(env.BOT_LANGUAGE, 'en'),
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
		// Local admin panel (127.0.0.1 by default): PANEL=0 turns it off, PANEL_PORT picks the port (0 = random).
		panelEnabled: bool(env.PANEL, true),
		panelPort: num(env.PANEL_PORT, 8787, { min: 0, max: 65_535 }),
		// Where the panel listens; anything beyond loopback (a container, a reverse proxy) needs PANEL_TOKEN,
		// and PANEL_ALLOWED_HOSTS adds the names it is reached by to the Host-header check.
		panelHost: str(env.PANEL_HOST, '127.0.0.1'),
		panelToken: str(env.PANEL_TOKEN),
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
		localTtsLang: str(env.LOCAL_TTS_LANG, 'tr'),
		// Let the bot start the Chatterbox server itself (when needed, from .venv-chatterbox). LOCAL_TTS_PYTHON can point at the interpreter.
		localTtsAutostart: bool(env.LOCAL_TTS_AUTOSTART, true),
		localTtsPython: str(env.LOCAL_TTS_PYTHON),
		localTtsModel: str(env.LOCAL_TTS_MODEL, 'multilingual'),
		localSttModel: str(env.LOCAL_STT_MODEL, 'small'),
		// Local brain (voice chat without OpenAI): ears = whisper (/stt), brain = DeepSeek/OpenAI chat, mouth = Chatterbox.
		// auto = switch to the local brain when GPT-Live reports a credit/key error and switch back once it recovers;
		// local = always local; live = never switch.
		brainMode: ['auto', 'local', 'live'].includes(str(env.BRAIN_MODE, 'auto').toLowerCase()) ? str(env.BRAIN_MODE, 'auto').toLowerCase() : 'auto',
		localSttUrl: str(env.LOCAL_STT_URL) ?? str(env.LOCAL_TTS_URL, 'http://127.0.0.1:8020'),
		localSttLang: str(env.LOCAL_STT_LANG, 'tr'),
		// Who the local brain answers: auto (name/single person/ongoing conversation/question), addressed (only when named), always
		localBrainRespond: ['auto', 'addressed', 'always'].includes(str(env.LOCAL_BRAIN_RESPOND, 'auto').toLowerCase())
			? str(env.LOCAL_BRAIN_RESPOND, 'auto').toLowerCase()
			: 'auto',
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

		soloUserId: str(env.SOLO_USER_ID),
		textChannelId: str(env.TEXT_CHANNEL_ID),
		readLimit: num(env.READ_LIMIT, 5, { min: 1, max: 10 }),
		allowedBots: list(env.ALLOWED_BOTS),
		botPrefix: str(env.BOT_PREFIX, '!'),
		botCommandChannelId: str(env.BOT_COMMAND_CHANNEL),
		messageContent: str(env.MESSAGE_CONTENT, 'auto'),
		guildMembers: str(env.GUILD_MEMBERS, 'auto'),
		presence: str(env.PRESENCE, 'auto'),

		// Authorisation: owner (voice admin tools + everything), extra admin user/role ids (slash/panel).
		// With OWNER_ID empty the voice admin tools are off; there is NO hard-coded default.
		ownerId: str(env.OWNER_ID),
		adminUserIds: list(env.ADMIN_USER_IDS),
		adminRoleIds: list(env.ADMIN_ROLE_IDS),
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
