// A guard against local speech that came out wrong.
//
// The local voices are autoregressive: they generate sound one step at a time from the text and from
// what they have generated so far, and every so often -- more often on a weak GPU, and most often on a
// very short line -- they run on past the end of the sentence, repeat part of it, stop halfway, or say
// something that was never written. Nothing downstream can tell: the audio is played as it is. So before a
// sentence is played it is checked, and made again when the check fails:
//
//   1. Its length (cheap, always): a sentence has an expected length, given by how many letters it has
//      and how fast the language is spoken. Audio far longer than that ran on or repeated itself; audio
//      far shorter lost part of the sentence. Silence at the edges is not counted.
//   2. What it says (LOCAL_TTS_VERIFY): the audio is transcribed with the local brain's own ears (/stt,
//      faster-whisper) and compared with the text it was made from, as a character error rate. By default
//      only audio whose length already looks wrong is transcribed: that costs nothing on the sentences that
//      are fine, and it keeps a sentence that is merely slow from being thrown away.
//
// A sentence that fails is made once more with another seed and a lower temperature (the server hands
// both to engines that take them), then, if LOCAL_TTS_FALLBACK_ENGINE names one for the language, by
// that engine; and if every attempt fails, the one closest to right is played and the failure is logged.
// None of this may hold speech up for long: the transcription has its own short timeout and is left out
// for a minute when the transcriber does not answer, and no further attempt starts once the guard has
// spent MAX_EXTRA_MS on a sentence.
//
// The counters (per engine: checked, suspicious, failed the round trip, retried, fell back) go into the
// session health report.

import { t } from './i18n/index.js';
import { speechLanguage, toSpeech } from './speechtext.js';

const SAMPLE_RATE = 24_000;

// How fast speech goes, in letters per second of the spoken form (numbers already written out, spaces
// and punctuation not counted). Turkish is spoken at about five and a half syllables a second by a
// synthesiser, a syllable being about 2.4 letters: 13 letters, or 15 characters with the spaces, the middle
// of the usual 13-17 characters a second. English at 150-170 words a minute with words of about 4.5
// letters comes to 11-13 letters. The thresholds below are ratios, so these only have to be the middle
// of the range, not its edges.
const LETTERS_PER_SECOND = { tr: 13, en: 12 };
const DEFAULT_LETTERS_PER_SECOND = 12.5;
// A comma is a short breath, a full stop inside the text a longer one; the text's own last mark is
// followed by nothing (the trailing silence is trimmed off the audio before it is measured).
const COMMA_PAUSE_S = 0.2;
const STOP_PAUSE_S = 0.35;
// Longer than 2.2 times the expected length plus 1.2 s is running on: a slow voice speaks at half its
// usual pace at worst, which is 2x, and the fixed second covers the breath before a short line ("Evet."
// is expected to take a third of a second). Shorter than 0.35 times is two thirds of the sentence gone:
// a fast voice does not speak three times its usual pace.
const LONG_FACTOR = 2.2;
const LONG_SLACK_S = 1.2;
const SHORT_FACTOR = 0.35;
// The transcript differs from the text by more than a third of its letters: something else was said.
// faster-whisper reads clean synthetic speech at a few percent character error rate, and a little more
// where a name or a number is spelled another way; a repeated sentence, a lost half or a made-up tail is
// 50% and up. A text shorter than eight letters is measured against eight, so one misheard letter of
// "Evet." is not a quarter of it.
const CER_LIMIT = 0.35;
const CER_MIN_LENGTH = 8;
// 20 ms frames. A frame is silent below 4% (-28 dB) of the level of the loud frames (the 90th percentile),
// and always below 100 (-50 dBFS), which is breath and hiss, not a word.
const FRAME_S = 0.02;
const SILENCE_RELATIVE = 0.04;
const SILENCE_FLOOR = 100;
const LOUD_PERCENTILE = 0.9;
// Trailing silence past this is cut off what is played, down to a quarter of a second: a voice that went
// quiet for two seconds at the end of a sentence would otherwise hold the next one back by two seconds.
const TAIL_TRIM_OVER_S = 0.6;
const TAIL_KEEP_S = 0.25;
// The transcription of a few seconds of audio takes a few hundred milliseconds on a GPU and a second or
// two on a CPU; past four it is not worth waiting for. A transcriber that failed is left alone for a minute.
const VERIFY_TIMEOUT_MS = 4000;
const STT_PAUSE_MS = 60_000;
// The second attempt: another seed and a lower temperature than Chatterbox's 0.8, which makes the
// sampling that produced the bad audio less adventurous without making the voice flat.
const RETRY_TEMPERATURE = 0.6;
// No further attempt starts once this much time has gone into one sentence: by then a wrong sentence now
// is better than a right one much later.
const MAX_EXTRA_MS = 12_000;

export const VERIFY_MODES = Object.freeze(['off', 'suspicious', 'always']);
// The name the counters use for requests that name no engine: whatever the server runs by default.
const DEFAULT_ENGINE = 'default';

/** How long the spoken form of `text` should take, in seconds. */
export function expectedSeconds(text, language = null) {
	const spoken = toSpeech(text, language);
	const letters = spoken.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
	const inner = spoken.replace(/[\s.!?…,;:]+$/u, '');
	const commas = inner.match(/[,;:—–]/gu)?.length ?? 0;
	const stops = inner.match(/[.!?…]+(?=\s)/gu)?.length ?? 0;
	const rate = LETTERS_PER_SECOND[speechLanguage(language)] ?? DEFAULT_LETTERS_PER_SECOND;
	return letters / rate + commas * COMMA_PAUSE_S + stops * STOP_PAUSE_S;
}

/** Where the sound is: the first and last sample of the frames above the silence line ({ start, end }). */
export function speechSpan(pcm, sampleRate = SAMPLE_RATE) {
	const length = pcm?.length ?? 0;
	const frame = Math.max(1, Math.round(sampleRate * FRAME_S));
	const frames = Math.ceil(length / frame);
	if (!frames) return { start: 0, end: 0 };
	const levels = new Float64Array(frames);
	for (let index = 0; index < frames; index++) {
		const from = index * frame;
		const to = Math.min(length, from + frame);
		let sum = 0;
		for (let i = from; i < to; i++) sum += pcm[i] * pcm[i];
		levels[index] = Math.sqrt(sum / (to - from));
	}
	const sorted = Float64Array.from(levels).sort();
	const loud = sorted[Math.floor((sorted.length - 1) * LOUD_PERCENTILE)];
	const line = Math.max(SILENCE_FLOOR, loud * SILENCE_RELATIVE);
	const first = levels.findIndex((level) => level > line);
	if (first < 0) return { start: 0, end: 0 };
	let last = frames - 1;
	while (last > first && levels[last] <= line) last--;
	return { start: first * frame, end: Math.min(length, (last + 1) * frame) };
}

/**
 * Is the audio as long as the text says it should be? `seconds` is the sound without the silence at its
 * edges, `expected` the length the text should take; `reason` is 'long' or 'short' when it is not.
 */
export function checkDuration(pcm, text, language = null, { sampleRate = SAMPLE_RATE } = {}) {
	const expected = expectedSeconds(text, language);
	const { start, end } = speechSpan(pcm, sampleRate);
	const seconds = (end - start) / sampleRate;
	const long = seconds > LONG_FACTOR * expected + LONG_SLACK_S;
	const short = expected > 0 && seconds < SHORT_FACTOR * expected;
	return { suspicious: long || short, reason: long ? 'long' : short ? 'short' : null, seconds, expected };
}

/**
 * The letters of a text as a transcript and the text it was made from can be compared by: its spoken
 * form (the transcriber writes "14:45" where the voice was given "on dört kırk beş"), lower case the way
 * the language does it (Turkish I and İ), accents and the dots of ı/İ dropped (a transcriber that writes
 * "sacma" for "saçma" heard the right word), and no spaces or punctuation.
 */
export function foldForComparison(text, language = null) {
	const code = speechLanguage(language);
	return toSpeech(text, language)
		.toLocaleLowerCase(code ?? 'en')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/ı/gu, 'i')
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Edit distance between two strings, by code point. */
function editDistance(a, b) {
	const left = [...a];
	const right = [...b];
	if (!left.length) return right.length;
	if (!right.length) return left.length;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[right.length];
}

/** Edits needed to turn `reference` into `hypothesis`, per letter of the reference (at least `minLength`). */
export function characterErrorRate(reference, hypothesis, { minLength = 1 } = {}) {
	const ref = String(reference ?? '');
	const hyp = String(hypothesis ?? '');
	if (!ref && !hyp) return 0;
	return editDistance(ref, hyp) / Math.max(minLength, [...ref].length, 1);
}

/** The audio without the part of its trailing silence that would only hold the next sentence back. */
export function trimTrailingSilence(pcm, sampleRate = SAMPLE_RATE) {
	if (!pcm?.length) return pcm;
	const { end } = speechSpan(pcm, sampleRate);
	if (!end || pcm.length - end <= TAIL_TRIM_OVER_S * sampleRate) return pcm;
	return pcm.subarray(0, Math.min(pcm.length, end + Math.round(TAIL_KEEP_S * sampleRate)));
}

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const quote = (text) => (String(text).length > 80 ? `${String(text).slice(0, 77)}...` : String(text));

export class TtsGuard {
	/**
	 * @param {object} options
	 * @param {{ transcribe: Function }|null} [options.stt] the local ears (LocalStt); null: no round trip
	 * @param {'off'|'suspicious'|'always'} [options.verify] when the audio is transcribed and compared
	 * @param {string|Record<string, string>|null} [options.fallbackEngines] the engine to fall back to: one
	 *   name, or a table by language code with '*' for every other language
	 */
	constructor({
		stt = null,
		verify = 'suspicious',
		fallbackEngines = null,
		log = () => {},
		now = Date.now,
		random = Math.random,
		sampleRate = SAMPLE_RATE,
		verifyTimeoutMs = VERIFY_TIMEOUT_MS,
		maxExtraMs = MAX_EXTRA_MS,
	} = {}) {
		this.stt = stt;
		this.verify = VERIFY_MODES.includes(verify) ? verify : 'suspicious';
		this.fallbackEngines = fallbackEngines;
		this.log = log;
		this.now = now;
		this.random = random;
		this.sampleRate = sampleRate;
		this.verifyTimeoutMs = verifyTimeoutMs;
		this.maxExtraMs = maxExtraMs;
		// Until when the round trip is left out, after the transcriber failed to answer.
		this.sttPausedUntil = 0;
		this.counters = new Map();
	}

	/** The engine to fall back to for this language, or null. */
	fallbackFor(language) {
		const table = this.fallbackEngines;
		if (!table) return null;
		if (typeof table === 'string') return table || null;
		const code = String(language ?? '').toLowerCase().match(/^[a-z]+/u)?.[0] ?? '';
		return table[code] ?? table['*'] ?? null;
	}

	count(engine, field) {
		const key = engine || DEFAULT_ENGINE;
		let entry = this.counters.get(key);
		if (!entry) {
			entry = { checked: 0, suspicious: 0, failedRoundTrip: 0, retried: 0, fellBack: 0 };
			this.counters.set(key, entry);
		}
		entry[field]++;
	}

	/** The counters per engine, for the health report: { engine: { checked, suspicious, ... } }. */
	stats() {
		return Object.fromEntries([...this.counters].map(([engine, entry]) => [engine, { ...entry }]));
	}

	/** Sentences checked so far, over every engine. */
	get checkedTotal() {
		let total = 0;
		for (const entry of this.counters.values()) total += entry.checked;
		return total;
	}

	/**
	 * The audio transcribed and compared with the text: { cer, heard }, or null when there is no
	 * transcriber, it is resting after a failure, or it did not answer in time. Throws only when `signal`
	 * was aborted (the listener cut in), like the request it is part of.
	 */
	async roundTrip(pcm, text, language, signal = null) {
		if (typeof this.stt?.transcribe !== 'function' || this.now() < this.sttPausedUntil) return null;
		const reference = foldForComparison(text, language);
		if (!reference) return null;
		const timeout = AbortSignal.timeout(this.verifyTimeoutMs);
		// The transcriber is told the language the voice was asked to speak, not left to guess it.
		const code = String(language ?? '').toLowerCase().match(/^[a-z]+/u)?.[0] ?? 'auto';
		try {
			const heard = await this.stt.transcribe(pcm, { language: code, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
			const said = String(heard?.text ?? '');
			return { cer: characterErrorRate(reference, foldForComparison(said, language), { minLength: CER_MIN_LENGTH }), heard: said };
		} catch (err) {
			if (signal?.aborted) throw err;
			this.sttPausedUntil = this.now() + STT_PAUSE_MS;
			this.log(t('brain.tts_guard_stt_skipped', { error: timeout.aborted ? t('brain.tts_guard_timeout') : (err?.message ?? String(err)) }));
			return null;
		}
	}

	/** Checks one attempt: { ok, reason, duration, trip }. */
	async check(pcm, text, language, engine, signal = null) {
		this.count(engine, 'checked');
		const duration = checkDuration(pcm, text, language, { sampleRate: this.sampleRate });
		if (duration.suspicious) this.count(engine, 'suspicious');
		const wanted = this.verify === 'always' || (this.verify === 'suspicious' && duration.suspicious);
		const trip = wanted ? await this.roundTrip(pcm, text, language, signal) : null;
		if (trip) {
			const failed = trip.cer > CER_LIMIT;
			if (failed) this.count(engine, 'failedRoundTrip');
			return { ok: !failed, reason: failed ? 'heard' : null, duration, trip };
		}
		// Without a transcript the length decides alone.
		return { ok: !duration.suspicious, reason: duration.reason, duration, trip: null };
	}

	/** Why an attempt failed, in words for the log. */
	describe(verdict) {
		if (verdict.reason === 'heard') return t('brain.tts_guard_heard', { heard: quote(verdict.trip.heard), cer: round(verdict.trip.cer, 2) });
		const params = { seconds: round(verdict.duration.seconds), expected: round(verdict.duration.expected) };
		return t(verdict.reason === 'long' ? 'brain.tts_guard_long' : 'brain.tts_guard_short', params);
	}

	/**
	 * Makes the audio for `text` through `synthesize(extra)` -- which sends the request with `extra`
	 * merged into it and resolves to { pcm (24 kHz int16), ... } -- checks it, and makes it again when the
	 * check fails (see the top of the file). Resolves to the chosen attempt's result with `ok` (whether it
	 * passed), `attempts` and `engine` added and its trailing silence trimmed. The first attempt's errors
	 * are the caller's; a later attempt that fails leaves the ones already made to choose from.
	 */
	async run(synthesize, { text, language = null, engine = null, signal = null } = {}) {
		const started = this.now();
		const primary = engine || DEFAULT_ENGINE;
		const plan = [
			{ extra: {}, engine: primary },
			{ extra: { seed: Math.floor(this.random() * 2 ** 31), temperature: RETRY_TEMPERATURE }, engine: primary, counter: 'retried' },
		];
		const fallback = this.fallbackFor(language);
		if (fallback && fallback !== primary) plan.push({ extra: { engine: fallback }, engine: fallback, counter: 'fellBack' });

		const attempts = [];
		for (const step of plan) {
			if (attempts.length && this.now() - started > this.maxExtraMs) break;
			if (step.counter) this.count(primary, step.counter);
			let audio;
			try {
				audio = await synthesize(step.extra);
			} catch (err) {
				if (!attempts.length || signal?.aborted) throw err;
				this.log(t('brain.tts_guard_retry_failed', { engine: step.engine, text: quote(text), error: err?.message ?? String(err) }));
				continue;
			}
			const verdict = await this.check(audio.pcm, text, language, step.engine, signal);
			attempts.push({ audio, verdict, engine: step.engine });
			if (verdict.ok) break;
			this.log(t('brain.tts_guard_suspicious', { engine: step.engine, text: quote(text), why: this.describe(verdict) }));
		}

		const chosen = attempts.find((attempt) => attempt.verdict.ok) ?? closest(attempts);
		if (!chosen.verdict.ok) this.log(t('brain.tts_guard_gave_up', { engine: chosen.engine, text: quote(text), attempts: attempts.length }));
		return { ...chosen.audio, pcm: trimTrailingSilence(chosen.audio.pcm, this.sampleRate), ok: chosen.verdict.ok, attempts: attempts.length, engine: chosen.engine };
	}
}

/** Of attempts that all failed, the one closest to right: the lowest error rate, or the length nearest the expected one. */
function closest(attempts) {
	const distance = ({ verdict }) => {
		if (verdict.trip) return verdict.trip.cer;
		const { seconds, expected } = verdict.duration;
		return Math.abs(Math.log(Math.max(seconds, 0.01) / Math.max(expected, 0.01)));
	};
	return attempts.reduce((best, attempt) => (distance(attempt) < distance(best) ? attempt : best));
}
