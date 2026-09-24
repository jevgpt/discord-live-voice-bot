// Local TTS client (Chatterbox): sends the text, receives raw PCM.
// The audio is pushed straight to Discord — no cloud TTS, everything stays local.

import { t } from './i18n/index.js';
import { speechHeaders } from './localserver.js';

const SENTENCE_END = /^\s*(.*?[.!?…]+)(?=\s|$)/su;

/**
 * Splits the text into finished sentences; returns whatever is left over as `rest`.
 * End of sentence = punctuation + whitespace/end of text; inner dots such as in "3.5", "12.30" or
 * "example.com/x" do not break a sentence. Long sentences are cut on a word boundary even when they
 * do end with punctuation.
 */
/**
 * The longest opening piece of `text` that can be said on its own: up to the last comma, semicolon,
 * colon or dash, and failing that up to the last space. Returns '' when there is no clean place to cut,
 * because half a word is worse than a moment's wait.
 */
export function firstClause(text, { minChars = 24 } = {}) {
	const body = String(text ?? '');
	if (body.length <= minChars) return '';
	// The EARLIEST place worth cutting, not the latest: the whole point is to be speaking sooner.
	const breaks = /[,;:—–]\s/g;
	for (let match = breaks.exec(body); match; match = breaks.exec(body)) {
		if (match.index + 1 >= minChars) return body.slice(0, match.index + 1).trim();
	}
	const space = body.indexOf(' ', minChars);
	if (space < 0) return '';
	return body.slice(0, space).trim();
}

export function splitSentences(text, { maxLength = 220 } = {}) {
	const sentences = [];
	let rest = String(text ?? '');
	for (;;) {
		const match = SENTENCE_END.exec(rest);
		if (!match) break;
		rest = rest.slice(match[0].length);
		for (const piece of chunk(match[1].trim(), maxLength)) if (piece) sentences.push(piece);
	}
	let pending = rest.trim();
	while (pending.length > maxLength) {
		const cut = pending.lastIndexOf(' ', maxLength);
		const at = cut > 40 ? cut : maxLength;
		sentences.push(pending.slice(0, at).trim());
		pending = pending.slice(at).trim();
	}
	return { sentences, rest: pending };
}

function chunk(sentence, maxLength) {
	if (sentence.length <= maxLength) return [sentence];
	const parts = [];
	let remaining = sentence;
	while (remaining.length > maxLength) {
		const comma = remaining.lastIndexOf(', ', maxLength);
		const space = remaining.lastIndexOf(' ', maxLength);
		const at = comma > 40 ? comma + 1 : space > 40 ? space : maxLength;
		parts.push(remaining.slice(0, at).trim());
		remaining = remaining.slice(at).trim();
	}
	if (remaining) parts.push(remaining);
	return parts;
}

/** Plain linear resampling (int16). Leaves the samples untouched when the rates already match. */
export function resampleLinear(pcm, fromRate, toRate) {
	if (!pcm?.length || fromRate === toRate) return pcm;
	const ratio = toRate / fromRate;
	const out = new Int16Array(Math.max(1, Math.round(pcm.length * ratio)));
	for (let i = 0; i < out.length; i++) {
		const position = i / ratio;
		const index = Math.floor(position);
		const next = Math.min(index + 1, pcm.length - 1);
		const frac = position - index;
		out[i] = Math.round(pcm[index] * (1 - frac) + pcm[next] * frac);
	}
	return out;
}

// Language guess: character and common-word hints. Falls back when a short text stays ambiguous.
// This is detection data, not UI text, so it is the same in every locale; letters that also occur in
// Turkish are written as \u escapes to keep the source itself free of Turkish characters.
const LANG_HINTS = [
	{
		id: 'tr',
		chars: /[\u00e7\u011f\u0131\u0130\u00f6\u015f\u00fc]/i,
		words:
			/\b(ve|bir|bu|i\u00e7in|ile|ama|\u00e7ok|gibi|de\u011fil|ben|sen|evet|hay\u0131r|nas\u0131l|ne|var|yok|tamam|can\u0131m|a\u015fko)\b/i,
	},
	{ id: 'de', chars: /[ä\u00f6\u00fcß]/i, words: /\b(und|ich|nicht|das|ist|sie|ein|eine|wir|auch|mit|f\u00fcr|aber|ja|nein)\b/i },
	{ id: 'fr', chars: /[àâ\u00e7éèêëîïôûù\u00fcÿœ]/i, words: /\b(le|la|les|et|est|une|des|pas|que|pour|vous|nous|oui|non|avec)\b/i },
	{ id: 'es', chars: /[áéíñóú¿¡]/i, words: /\b(el|la|los|las|y|es|una|que|para|con|pero|sí|no|gracias|hola)\b/i },
	{ id: 'it', chars: /[àèéìòù]/i, words: /\b(il|la|che|non|una|per|con|sono|anche|ciao|grazie|sì)\b/i },
	{ id: 'pt', chars: /[ãõ\u00e7áéíóúâê]/i, words: /\b(o|a|os|as|e|não|uma|para|com|mas|sim|obrigado|você)\b/i },
	{ id: 'ru', chars: /[а-яё]/i, words: /\b(и|не|это|что|как|да|нет|привет|спасибо)\b/i },
	{ id: 'en', chars: /^$/, words: /\b(the|and|you|is|are|this|that|with|not|but|yes|no|hello|thanks|what|how)\b/i },
];

/** Guesses the language of the text (tr/en/de/fr/es/it/pt/ru); falls back when it cannot tell. */
export function detectLanguage(text, fallback = t('brain.tts_fallback_language')) {
	const sample = String(text ?? '').trim();
	if (!sample) return fallback;
	let best = null;
	let bestScore = 0;
	for (const hint of LANG_HINTS) {
		let score = 0;
		const chars = sample.match(new RegExp(hint.chars.source, 'gi'))?.length ?? 0;
		const words = sample.match(new RegExp(hint.words.source, 'gi'))?.length ?? 0;
		score = chars * 2 + words * 3;
		if (hint.id === 'ru' && chars > 0) score += 10; // Cyrillic on its own is decisive
		if (score > bestScore) {
			best = hint.id;
			bestScore = score;
		}
	}
	return bestScore >= 3 ? best : fallback;
}

// Which generated lines are worth keeping. Short ones, because those are the ones that repeat: at
// 24 kHz mono a five second line is about 240 KB, so sixty of them is a few megabytes.
const CACHE_MAX_CHARS = 80;
const CACHE_MAX_ENTRIES = 60;

export class LocalTts {
	constructor({
		url = 'http://127.0.0.1:8020',
		voiceRef = null,
		languageId = t('brain.tts_fallback_language'),
		exaggeration = null,
		cfgWeight = null,
		timeoutMs = 60_000,
		// Null: the token the process shares (LOCAL_TTS_TOKEN, or the one the server was launched with).
		token = null,
		log = () => {},
	} = {}) {
		this.url = String(url).replace(/\/$/, '');
		this.token = token;
		this.voiceRef = voiceRef;
		this.languageId = languageId;
		this.exaggeration = exaggeration;
		this.cfgWeight = cfgWeight;
		this.timeoutMs = timeoutMs;
		this.log = log;
		// Short lines that have already been generated, newest last. See speak().
		this.cache = new Map();
		this.sampleRate = 24_000;
	}

	/** Is the server up, and which model/sample rate is it running with? */
	async health() {
		try {
			const response = await fetch(`${this.url}/health`, { headers: speechHeaders({}, this.token), signal: AbortSignal.timeout(5000) });
			if (response.status === 401 || response.status === 403) this.log(t('brain.speech_refused', { url: this.url, status: response.status }));
			if (!response.ok) return null;
			const info = await response.json();
			if (Number.isFinite(info?.sr) && info.sr > 0) this.sampleRate = info.sr;
			return info;
		} catch (err) {
			this.log(t('brain.tts_health_failed', { error: err?.message ?? err }));
			return null;
		}
	}

	/** The language code to use for this text (a guess when it is set to "auto"). */
	languageFor(text) {
		return this.languageId === 'auto' ? detectLanguage(text) : this.languageId;
	}

	/**
	 * Turns the text into audio; returns the 24 kHz mono int16 the Discord path expects.
	 * Can be cancelled through `signal` (barge-in).
	 */
	async speak(text, { signal = null } = {}) {
		const trimmed = String(text ?? '').trim();
		if (!trimmed) throw new Error(t('brain.tts_empty_text'));
		// This bot says the same handful of short things all evening: "here", "all right", "what is it?".
		// Each one costs seconds on the GPU every single time, for audio that is identical. Short lines are
		// kept, which is exactly the set that repeats; a long sentence is never said twice anyway.
		const cached = this.cache?.get(trimmed);
		if (cached) {
			// Most recently used goes to the end, so the oldest is the one dropped.
			this.cache.delete(trimmed);
			this.cache.set(trimmed, cached);
			return { pcm: cached.pcm, language: cached.language, cached: true };
		}
		const payload = { text: trimmed, language_id: this.languageFor(trimmed) };
		if (this.voiceRef) payload.voice_ref = this.voiceRef;
		if (Number.isFinite(this.exaggeration)) payload.exaggeration = this.exaggeration;
		if (Number.isFinite(this.cfgWeight)) payload.cfg_weight = this.cfgWeight;

		const timeout = AbortSignal.timeout(this.timeoutMs);
		const response = await fetch(`${this.url}/tts`, {
			method: 'POST',
			headers: speechHeaders({ 'content-type': 'application/json' }, this.token),
			body: JSON.stringify(payload),
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(
				detail
					? t('brain.tts_error_detail', { status: response.status, detail: detail.slice(0, 200) })
					: t('brain.tts_error', { status: response.status }),
			);
		}
		const sampleRate = Number(response.headers.get('x-sample-rate') ?? this.sampleRate) || this.sampleRate;
		this.sampleRate = sampleRate;
		const buffer = Buffer.from(await response.arrayBuffer());
		const usable = buffer.length & ~1;
		const aligned = buffer.byteOffset % 2 === 0 ? buffer : Buffer.from(buffer.subarray(0, usable));
		const pcm = new Int16Array(aligned.buffer, aligned.byteOffset, usable >> 1);
		const out = resampleLinear(pcm, sampleRate, 24_000);
		if (trimmed.length <= CACHE_MAX_CHARS) {
			this.cache.set(trimmed, { pcm: out, language: payload.language_id });
			// Oldest first in a Map, so the first key is the one to drop.
			while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
		}
		return { pcm: out, sampleRate, raw: pcm, language: payload.language_id };
	}
}
