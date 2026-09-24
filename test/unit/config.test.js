import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, panelSettings } from '../../src/config.js';
import { hasLocale, locale, resolveLocale, setLocale, SUPPORTED_LOCALES } from '../../src/i18n/index.js';
import { LocalStt } from '../../src/localstt.js';

// The required four, with IDs that have the shape of real Discord IDs, so that a warning in these tests
// is always about the value the test is looking at.
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const USER = '333333333333333333';
const baseEnv = { DISCORD_TOKEN: 't', GUILD_ID: GUILD, CHANNEL_ID: CHANNEL, OPENAI_API_KEY: 'k' };

/** The one warning that names `key`, or undefined. */
function warningFor(cfg, key) {
	const found = cfg.warnings.filter((line) => line.includes(key));
	assert.ok(found.length <= 1, `one warning per variable: ${found.join(' | ')}`);
	return found[0];
}

/** Runs `check` under every bundled locale and puts English back afterwards. */
function inEveryLocale(check) {
	try {
		for (const code of SUPPORTED_LOCALES) {
			setLocale(code);
			check(code);
		}
	} finally {
		setLocale('en');
	}
}

describe('config.js: the returned object', () => {
	it('carries its warnings without changing the fields it always had', () => {
		const cfg = loadConfig(baseEnv);
		assert.deepEqual(cfg.warnings, [], 'a clean .env says nothing');
		assert.equal(Object.keys(cfg).includes('warnings'), false, 'not enumerable');
		assert.equal('warnings' in JSON.parse(JSON.stringify(cfg)), false, 'and not serialised with the rest');
		assert.equal(cfg.guildId, GUILD);
		assert.equal(cfg.panelEnabled, true);
	});
	it('still throws, and only throws, when a required variable is missing', () => {
		assert.throws(() => loadConfig({ ...baseEnv, OPENAI_API_KEY: '' }), /OPENAI_API_KEY/);
		assert.doesNotThrow(() => loadConfig({ ...baseEnv, PANEL: 'of', GUILD_ID: 'nope', MUSIC_VOLUME: 'loud', BRAIN_MODE: 'x' }));
	});
});

describe('config.js: on/off settings', () => {
	it('reads the same .env the same way in every language', () => {
		inEveryLocale((code) => {
			const off = loadConfig({ ...baseEnv, PANEL: 'kapalı', MEMORY: 'hayır', MUSIC: 'off', JEV: 'disabled', AGC: 'KAPALI', TRANSCRIPTS: 'no' });
			for (const field of ['panelEnabled', 'memoryEnabled', 'musicEnabled', 'jev', 'agc', 'transcripts']) {
				assert.equal(off[field], false, `${field} under ${code}`);
			}
			const on = loadConfig({ ...baseEnv, TRACE: 'evet', DEBUG: 'açık', TRACE_AUDIO: 'enabled', JOIN_NOTICE: 'Yes', LOCAL_TTS: 'TRUE' });
			for (const field of ['trace', 'debug', 'traceAudio', 'joinNotice', 'localTtsEnabled']) {
				assert.equal(on[field], true, `${field} under ${code}`);
			}
			assert.deepEqual(off.warnings, []);
			assert.deepEqual(on.warnings, []);
		});
	});
	it('keeps the default for a word that is neither, and says which variable it was', () => {
		const cfg = loadConfig({ ...baseEnv, PANEL: 'of', TRACE: 'maybe' });
		assert.equal(cfg.panelEnabled, true, '"of" used to switch the panel ON; now the default stands');
		assert.equal(cfg.trace, false);
		assert.match(warningFor(cfg, 'PANEL'), /^PANEL=of\b/);
		assert.match(warningFor(cfg, 'TRACE'), /^TRACE=maybe\b/);
	});
	it('names each variable even when two of them hold the same mistake', () => {
		const cfg = loadConfig({ ...baseEnv, MUSIC: 'of', MEMORY: 'of' });
		assert.ok(warningFor(cfg, 'MUSIC='));
		assert.ok(warningFor(cfg, 'MEMORY='));
	});
	it('writes the warning in the active language', () => {
		setLocale('tr');
		try {
			assert.match(loadConfig({ ...baseEnv, PANEL: 'of' }).warnings[0], /değil/);
		} finally {
			setLocale('en');
		}
	});
	it('accepts every language\'s "leave it out" word for the backend effort', () => {
		assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_EFFORT: 'kapalı' }).backendEffort, null);
		assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_EFFORT: '-' }).backendEffort, null);
		assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_EFFORT: 'medium' }).backendEffort, 'medium');
	});
});

describe('config.js: privileged intents', () => {
	it('comes back as auto, on or off, which index.js reads the same in every language', () => {
		const cfg = loadConfig({ ...baseEnv, MESSAGE_CONTENT: 'disabled', GUILD_MEMBERS: 'evet' });
		assert.equal(cfg.messageContent, 'off', '"disabled" is off here as it is everywhere else');
		assert.equal(cfg.guildMembers, 'on');
		assert.equal(cfg.presence, 'auto');
		assert.deepEqual(cfg.warnings, []);
	});
	it('falls back to auto on an unknown word, and says so', () => {
		const cfg = loadConfig({ ...baseEnv, PRESENCE: 'sometimes' });
		assert.equal(cfg.presence, 'auto');
		assert.match(warningFor(cfg, 'PRESENCE'), /PRESENCE=sometimes/);
	});
});

describe('config.js: fixed choices', () => {
	it('takes a known value in any case and reports anything else', () => {
		const cfg = loadConfig({ ...baseEnv, BRAIN_MODE: 'LOCAL', TOOLS_BACKEND: 'Responses', LOCAL_BRAIN_RESPOND: 'Always' });
		assert.equal(cfg.brainMode, 'local');
		assert.equal(cfg.toolsBackend, 'responses');
		assert.equal(cfg.localBrainRespond, 'always');
		assert.deepEqual(cfg.warnings, []);

		const wrong = loadConfig({ ...baseEnv, BRAIN_MODE: 'locale', TOOLS_BACKEND: 'server', LOCAL_BRAIN_RESPOND: 'sometimes' });
		assert.equal(wrong.brainMode, 'auto');
		assert.equal(wrong.toolsBackend, 'auto');
		assert.equal(wrong.localBrainRespond, 'auto');
		assert.match(warningFor(wrong, 'BRAIN_MODE'), /auto, local, live/);
		assert.match(warningFor(wrong, 'TOOLS_BACKEND'), /auto, responses, client/);
		assert.match(warningFor(wrong, 'LOCAL_BRAIN_RESPOND'), /auto, addressed, always/);
	});
});

describe('config.js: numbers', () => {
	it('moves a number into its range and reports the edge it used', () => {
		const cfg = loadConfig({ ...baseEnv, MUSIC_VOLUME: '250', MAX_LIVE_SESSIONS: '0', PANEL_PORT: '70000' });
		assert.equal(cfg.musicVolume, 1);
		assert.equal(cfg.maxLiveSessions, 1);
		assert.equal(cfg.panelPort, 65_535);
		assert.match(warningFor(cfg, 'MUSIC_VOLUME'), /MUSIC_VOLUME=250 .*100/);
		assert.match(warningFor(cfg, 'MAX_LIVE_SESSIONS'), /MAX_LIVE_SESSIONS=0 .*1/);
		assert.match(warningFor(cfg, 'PANEL_PORT'), /65535/);
	});
	it('keeps the default for something that is not a number', () => {
		const cfg = loadConfig({ ...baseEnv, IDLE_CLOSE_MINUTES: 'ten' });
		assert.equal(cfg.idleCloseMs, 10 * 60_000);
		assert.match(warningFor(cfg, 'IDLE_CLOSE_MINUTES'), /IDLE_CLOSE_MINUTES=ten .*10/);
	});
	it('says nothing about a number inside its range, or one that is only rounded', () => {
		const cfg = loadConfig({ ...baseEnv, MUSIC_VOLUME: '40', MAX_LIVE_SESSIONS: '2.7', READ_LIMIT: '10' });
		assert.equal(cfg.maxLiveSessions, 2);
		assert.deepEqual(cfg.warnings, []);
	});
});

describe('config.js: Discord IDs', () => {
	it('keeps every ID as written but reports one that cannot be a Discord ID', () => {
		const cfg = loadConfig({
			...baseEnv,
			GUILD_ID: '1234',
			CHANNEL_ID: 'general',
			OWNER_ID: '@me',
			ADMIN_USER_IDS: `${USER}, bob`,
			ADMIN_ROLE_IDS: '12345678901234567890123',
		});
		assert.equal(cfg.guildId, '1234', 'a warning, not a rewrite');
		assert.deepEqual(cfg.adminUserIds, [USER, 'bob']);
		assert.ok(warningFor(cfg, 'GUILD_ID'));
		assert.ok(warningFor(cfg, 'CHANNEL_ID'));
		assert.ok(warningFor(cfg, 'OWNER_ID'));
		assert.match(warningFor(cfg, 'ADMIN_USER_IDS'), /"bob"/);
		assert.ok(warningFor(cfg, 'ADMIN_ROLE_IDS'), 'more than 20 digits is not an ID either');
	});
	it('accepts 17 to 20 digits', () => {
		const cfg = loadConfig({ ...baseEnv, OWNER_ID: '12345678901234567', SOLO_USER_ID: '12345678901234567890', ADMIN_ROLE_IDS: `${USER},${GUILD}` });
		assert.deepEqual(cfg.warnings, []);
	});
	it('VOICE_TARGETS: reports a broken pair, a server listed twice and a bad ID, but not a harmless repeat', () => {
		const other = '444444444444444444';
		const cfg = loadConfig({
			...baseEnv,
			VOICE_TARGETS: `${GUILD}:${CHANNEL}, ${other}:${USER}, nonsense, ${other}:555555555555555555, 666666666666666666:lounge`,
		});
		assert.deepEqual(
			cfg.targets.map((target) => target.guildId),
			[GUILD, other, '666666666666666666'],
		);
		const lines = cfg.warnings.filter((line) => line.startsWith('VOICE_TARGETS'));
		assert.equal(lines.length, 3, lines.join(' | '));
		assert.ok(lines.some((line) => line.includes('"nonsense"')));
		assert.ok(lines.some((line) => line.includes(`${other}:555555555555555555`)), 'the second channel for a server is skipped');
		assert.ok(lines.some((line) => line.includes('"lounge"')));
	});
});

describe('config.js: language', () => {
	it('resolves BOT_LANGUAGE the way src/i18n does, and the local voice follows it', () => {
		const tr = loadConfig({ ...baseEnv, BOT_LANGUAGE: 'tr-TR' });
		assert.equal(tr.language, 'tr');
		assert.equal(tr.localTtsLang, 'tr', 'unset, the voice speaks the bot language');
		assert.deepEqual(tr.warnings, []);
		const en = loadConfig(baseEnv);
		assert.equal(en.language, 'en');
		assert.equal(en.localTtsLang, 'en');
		assert.equal(loadConfig({ ...baseEnv, BOT_LANGUAGE: 'tr', LOCAL_TTS_LANG: 'auto' }).localTtsLang, 'auto');
	});
	it('tells a setup that never set the local languages how to keep the Turkish they used to default to', () => {
		const cfg = loadConfig(baseEnv);
		assert.equal(cfg.notes.length, 1);
		assert.match(cfg.notes[0], /no longer mean Turkish/u);
		assert.match(cfg.notes[0], /add LOCAL_TTS_LANG=tr LOCAL_STT_LANG=tr to \.env/u);
		assert.doesNotMatch(cfg.notes[0], /\n/u, 'one line');
		assert.deepEqual(cfg.warnings, [], 'a changed default is a note, not a value read wrong');
		assert.equal(Object.keys(cfg).includes('notes'), false, 'not enumerable');

		assert.match(loadConfig({ ...baseEnv, LOCAL_TTS_LANG: 'tr' }).notes[0], /add LOCAL_STT_LANG=tr to/u, 'only what is still unset');
		assert.match(loadConfig({ ...baseEnv, LOCAL_STT_LANG: '"auto"' }).notes[0], /add LOCAL_TTS_LANG=tr to/u);
		for (const env of [
			{ BOT_LANGUAGE: 'en' }, // a language chosen on purpose
			{ BOT_LANGUAGE: 'tr' },
			{ LOCAL_TTS_LANG: 'tr', LOCAL_STT_LANG: 'auto' },
			{ BRAIN_MODE: 'live' }, // no local voice and no local ears: the two keys mean nothing
		]) {
			assert.deepEqual(loadConfig({ ...baseEnv, ...env }).notes, [], JSON.stringify(env));
		}
		assert.equal(loadConfig({ ...baseEnv, BRAIN_MODE: 'live', LOCAL_TTS: '1' }).notes.length, 1, 'the local voice alone is enough');
	});
	it('reads the panel settings once, for the bot and for the container health check alike', () => {
		const env = { ...baseEnv, PANEL: '"kapalı"', PANEL_PORT: "'9000'", PANEL_HOST: '0.0.0.0', PANEL_TOKEN: '"a-panel-token-of-some-length"' };
		const cfg = loadConfig(env);
		assert.deepEqual(panelSettings(env), {
			panelEnabled: cfg.panelEnabled,
			panelPort: cfg.panelPort,
			panelHost: cfg.panelHost,
			panelToken: cfg.panelToken,
		});
		assert.deepEqual(panelSettings(env), { panelEnabled: false, panelPort: 9000, panelHost: '0.0.0.0', panelToken: 'a-panel-token-of-some-length' });
	});
	it('reports a language that is not bundled, and runs in English', () => {
		const cfg = loadConfig({ ...baseEnv, BOT_LANGUAGE: 'de' });
		assert.equal(cfg.language, 'en');
		assert.match(warningFor(cfg, 'BOT_LANGUAGE'), /BOT_LANGUAGE=de .*en, tr/);
	});
	it('lets whisper detect the language unless one is set, and then sends no language at all', async () => {
		assert.equal(loadConfig({ ...baseEnv, BOT_LANGUAGE: 'tr' }).localSttLang, 'auto');
		assert.equal(loadConfig({ ...baseEnv, LOCAL_STT_LANG: 'tr' }).localSttLang, 'tr');

		const original = globalThis.fetch;
		const urls = [];
		globalThis.fetch = async (url) => {
			urls.push(String(url));
			return { ok: true, json: async () => ({ text: 'merhaba', language: 'tr' }) };
		};
		try {
			const stt = new LocalStt({ url: 'http://127.0.0.1:8020', language: loadConfig(baseEnv).localSttLang });
			await stt.transcribe(new Int16Array(480));
			assert.equal(urls[0], 'http://127.0.0.1:8020/stt', 'auto-detect is the request without ?language=');
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('i18n: resolveLocale', () => {
	it('takes the language out of a region or encoding and says when nothing matched', () => {
		for (const code of ['tr', 'TR', 'tr-TR', 'tr_TR.UTF-8', '"tr"', '  tr   # Turkish']) {
			assert.deepEqual(resolveLocale(code), { code: 'tr', known: true }, code);
		}
		for (const code of ['de', 'english', '', null]) {
			assert.deepEqual(resolveLocale(code), { code: 'en', known: false }, String(code));
		}
		assert.equal(hasLocale('en-GB'), true);
		assert.equal(hasLocale('fr'), false);
	});
	it('setLocale picks what resolveLocale names', () => {
		try {
			assert.equal(setLocale('tr_TR'), 'tr');
			assert.equal(locale(), 'tr');
			assert.equal(setLocale('xx'), 'en');
		} finally {
			setLocale('en');
		}
	});
});
