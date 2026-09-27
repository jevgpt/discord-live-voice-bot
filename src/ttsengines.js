// The local speech engines as the bot sees them: their names, the languages each one speaks, and the
// few words the panel and the logs use to say which engine speaks which language. The routing itself
// is the speech server's (tools/voice_engines.py); nothing here decides where a line goes.

import { t } from './i18n/index.js';

/** The engines tools/chatterbox_server.py can load. */
export const TTS_ENGINES = ['chatterbox', 'freya', 'pocket'];

/** What LOCAL_TTS_ENGINE accepts: an engine, or auto (the server routes each line by its language). */
export const TTS_ENGINE_CHOICES = ['auto', ...TTS_ENGINES];

// The languages each engine speaks; null for Chatterbox, which takes every language the others do not
// (its multilingual model has 23, and the server has always sent it whatever it was given).
const ENGINE_LANGUAGES = {
	chatterbox: null,
	freya: ['tr'],
	pocket: ['en', 'fr', 'de', 'it', 'pt', 'es', 'nl'],
};

// The languages LOCAL_TTS_LANG=auto can pick: what detectLanguage in src/localtts.js tells apart.
export const DETECTED_LANGUAGES = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru'];

/**
 * The languages of `wanted` that `engine` does not speak: what a fixed LOCAL_TTS_ENGINE would be asked
 * for and refuse. Empty for auto and for Chatterbox.
 */
export function unspokenLanguages(engine, wanted) {
	const spoken = ENGINE_LANGUAGES[engine];
	if (!spoken) return [];
	return wanted.filter((language) => !spoken.includes(language));
}

/**
 * language -> engine, for the panel and the logs: every language the speech server has answered, by the
 * engine its x-engine header named, and `language` (the one the bot speaks) by what is planned for it
 * when it has not been spoken yet: the fixed LOCAL_TTS_ENGINE, or the server's routing from /health.
 */
export function voicesByLanguage(tts, language = null) {
	const voices = {};
	for (const [spoken, engine] of tts?.engines ?? []) voices[spoken] = engine;
	if (language && language !== 'auto' && !voices[language]) {
		const fixed = tts?.engine && tts.engine !== 'auto' ? tts.engine : null;
		const planned = fixed ?? tts?.routing?.[language] ?? tts?.routing?.['*'] ?? null;
		if (planned) voices[language] = planned;
	}
	return voices;
}

/** { tr: 'freya', en: 'pocket' } -> "tr freya, en pocket" (empty while nothing is known). */
export function describeVoices(voices) {
	return Object.entries(voices ?? {})
		.map(([language, engine]) => `${language} ${engine}`)
		.join(', ');
}

/** The panel status line's part for a session snapshot: " · Voices: tr freya, en pocket", or nothing. */
export function panelVoices(snapshot) {
	const voices = describeVoices(snapshot?.voices);
	return voices ? t('runtime.panel_status_voices', { voices }) : '';
}
