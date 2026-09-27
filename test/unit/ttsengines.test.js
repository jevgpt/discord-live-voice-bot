import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleInteraction } from '../../src/commands.js';
import { setLocale } from '../../src/i18n/index.js';
import { detectLanguage } from '../../src/localtts.js';
import { localVoiceMethods } from '../../src/session/localvoice.js';
import {
	DETECTED_LANGUAGES,
	TTS_ENGINES,
	TTS_ENGINE_CHOICES,
	describeVoices,
	panelVoices,
	unspokenLanguages,
	voicesByLanguage,
} from '../../src/ttsengines.js';

/** What LocalTts holds after some lines and a /health: the engines that answered, and the server's routing. */
function ttsAfter(answered = [], { engine = 'auto', routing = null } = {}) {
	return { engine, engines: new Map(answered), routing };
}

const ROUTING = { tr: 'freya', en: 'pocket', de: 'pocket', '*': 'chatterbox' };

describe('ttsengines: the engines and their languages', () => {
	it('names the engines the server knows, and auto', () => {
		assert.deepEqual(TTS_ENGINES, ['chatterbox', 'freya', 'pocket']);
		assert.deepEqual(TTS_ENGINE_CHOICES, ['auto', 'chatterbox', 'freya', 'pocket']);
	});

	it('knows what a fixed engine cannot say', () => {
		assert.deepEqual(unspokenLanguages('freya', ['tr', 'en']), ['en']);
		assert.deepEqual(unspokenLanguages('pocket', DETECTED_LANGUAGES), ['tr', 'ru']);
		assert.deepEqual(unspokenLanguages('chatterbox', DETECTED_LANGUAGES), [], 'the catch-all');
		assert.deepEqual(unspokenLanguages('auto', DETECTED_LANGUAGES), []);
	});

	it('lists every language LOCAL_TTS_LANG=auto can pick', () => {
		const samples = [
			'Merhaba, bu cümle Türkçe ve çok güzel bir gün.',
			'Hello there, this is the thing and you are fine.',
			'Ich bin nicht müde und das ist gut für uns.',
			'Bonjour, nous sommes très contents avec vous.',
			'Hola, gracias por la ayuda, es una buena idea para el día.',
			'Ciao, sono molto contento, grazie anche per questo.',
			'Olá, obrigado, você não sabe como estou feliz com isso.',
			'Привет, спасибо, это да.',
		];
		const found = new Set(samples.map((text) => detectLanguage(text, 'none')));
		assert.deepEqual([...found].sort(), [...DETECTED_LANGUAGES].sort());
	});
});

describe('ttsengines: which engine speaks each language', () => {
	it('shows what answered, then what is planned for the language the bot speaks', () => {
		assert.deepEqual(voicesByLanguage(ttsAfter([], { routing: ROUTING }), 'tr'), { tr: 'freya' });
		assert.deepEqual(voicesByLanguage(ttsAfter([['en', 'pocket']], { routing: ROUTING }), 'tr'), { en: 'pocket', tr: 'freya' });
		assert.deepEqual(voicesByLanguage(ttsAfter([['tr', 'chatterbox']], { routing: ROUTING }), 'tr'), { tr: 'chatterbox' }, 'what answered wins');
		assert.deepEqual(voicesByLanguage(ttsAfter([], { routing: ROUTING }), 'ja'), { ja: 'chatterbox' }, 'any other language');
		assert.deepEqual(voicesByLanguage(ttsAfter([], { engine: 'pocket', routing: ROUTING }), 'tr'), { tr: 'pocket' }, 'a fixed engine is the plan');
		assert.deepEqual(voicesByLanguage(ttsAfter([], { routing: ROUTING }), 'auto'), {});
		assert.deepEqual(voicesByLanguage(ttsAfter(), 'tr'), {}, 'nothing known before the first /health');
		assert.deepEqual(voicesByLanguage(null, 'tr'), {});
	});

	it('the panel line and the log say it the same way, in the active language', () => {
		assert.equal(describeVoices({ tr: 'freya', en: 'pocket' }), 'tr freya, en pocket');
		assert.equal(describeVoices({}), '');
		assert.equal(panelVoices({ voices: { tr: 'freya', en: 'pocket' } }), ' · Voices: tr freya, en pocket');
		assert.equal(panelVoices({ voices: {} }), '', 'nothing known: no empty label');
		assert.equal(panelVoices({}), '');
		setLocale('tr');
		try {
			assert.equal(panelVoices({ voices: { tr: 'freya' } }), ' · Sesler: tr freya');
		} finally {
			setLocale('en');
		}
	});
});

describe('/status names the engines of the local voice', () => {
	async function status({ localMode, voices }) {
		const replies = [];
		const interaction = {
			commandName: 'status',
			isAutocomplete: () => false,
			isChatInputCommand: () => true,
			reply: async (payload) => replies.push(payload.content),
		};
		const ctx = {
			config: { recordTranscripts: true },
			store: { getActive: () => null },
			getLive: () => null,
			voice: { connected: false },
			brain: () => 'live',
			localMode: () => localMode,
			chatterbox: () => null,
			music: null,
			sessions: () => [{ voices }],
			log: () => {},
		};
		await handleInteraction(interaction, ctx);
		return replies[0].split('\n').find((line) => line.startsWith('Voice: '));
	}

	it('by language once they are known, and as it always did before', async () => {
		assert.equal(await status({ localMode: true, voices: { tr: 'freya', en: 'pocket' } }), 'Voice: local (tr freya, en pocket)');
		assert.equal(await status({ localMode: true, voices: {} }), 'Voice: local (Chatterbox)');
		assert.equal(await status({ localMode: false, voices: { tr: 'freya' } }), 'Voice: GPT-Live');
	});
});

describe('the session reports its voices', () => {
	function session({ lang = 'auto', language = 'tr', tts = ttsAfter([], { routing: ROUTING }) } = {}) {
		const logs = [];
		return {
			...localVoiceMethods,
			cfg: { localTtsLang: lang, language, localTtsEnabled: true },
			localTts: tts,
			localMode: false,
			activity: { push() {} },
			playback: { clear() {} },
			ttsQueue: [],
			ttsPending: '',
			log: (line) => logs.push(line),
			logs,
		};
	}

	it('by the language it speaks: LOCAL_TTS_LANG, or its own language when that is auto', () => {
		assert.deepEqual(session({ lang: 'auto', language: 'tr' }).localVoices(), { tr: 'freya' });
		assert.deepEqual(session({ lang: 'en', language: 'tr' }).localVoices(), { en: 'pocket' });
	});

	it('in the line that says local voice mode is on', async () => {
		const tts = ttsAfter();
		tts.health = async () => {
			tts.routing = ROUTING;
			return { ok: true, model: 'multilingual', device: 'cuda', sr: 24_000, routing: ROUTING };
		};
		const bot = session({ lang: 'tr', tts });
		assert.equal((await bot.setLocalMode(true)).ok, true);
		assert.equal(bot.logs.at(-1), 'Local voice mode ON — voices: tr freya; Chatterbox model multilingual (cuda), 24000 Hz.');
	});
});
