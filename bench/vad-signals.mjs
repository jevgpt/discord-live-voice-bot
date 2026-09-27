// Synthetic rooms for the voice detector: speech, the things a microphone hears when nobody is speaking,
// and the frame-by-frame truth to score a detector against. Everything is generated from a seed, so a
// number in the report is the same number on every machine.
//
// Speech is a source-filter model, the way a vowel is made: a glottal pulse train (a pitch that drifts
// and falls over the utterance) through two low-passes for the spectral tilt, three formant resonators
// for the vowel, and a first difference for the lips. Syllables are 110-280 ms with a rise and a decay,
// stressed and unstressed a few dB apart; some start with a fricative or a plosive, words are separated
// by 30-150 ms of nothing, utterances by 0.4-1.8 s. The level of a speech signal is its RMS over the
// utterances, pauses between words included.
//
// The truth is per 20 ms frame: 1 from the first sample of an utterance to its last, word gaps included,
// because to the rest of the bot a sentence with its pauses is one person's turn.
//
// These are not recorded rooms: no real microphone, no Opus, no noise suppression on the client. They put
// two detectors on the same footing, which is what they are for; the absolute numbers are this
// generator's, and a trace of a real room (TRACE=1) is still the final word.

export const RATE = 24_000;
export const FRAME = 480;

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	next.range = (lo, hi) => lo + (hi - lo) * next();
	next.pick = (list) => list[Math.floor(next() * list.length)];
	next.gauss = () => {
		const u = next() || 1e-12;
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
	};
	return next;
}

const dbToAmp = (db) => 10 ** (db / 20);
const FULL = 32768;

/** Scales `x` in place so that its RMS (over `spans`, or all of it) is `db` dBFS. */
function setLevel(x, db, spans = null) {
	let acc = 0;
	let count = 0;
	for (const [from, to] of spans ?? [[0, x.length]]) {
		for (let i = from; i < to; i++) acc += x[i] * x[i];
		count += to - from;
	}
	const now = Math.sqrt(acc / Math.max(1, count));
	if (now > 0) {
		const k = (dbToAmp(db) * FULL) / now;
		for (let i = 0; i < x.length; i++) x[i] *= k;
	}
	return x;
}

// Klatt's two-pole resonator: centre `f`, bandwidth `bw`, unity gain at DC.
function resonator(f, bw) {
	const c = -Math.exp((-2 * Math.PI * bw) / RATE);
	const b = 2 * Math.exp((-Math.PI * bw) / RATE) * Math.cos((2 * Math.PI * f) / RATE);
	return { a: 1 - b - c, b, c, y1: 0, y2: 0 };
}
function resonate(r, x) {
	const y = r.a * x + r.b * r.y1 + r.c * r.y2;
	r.y2 = r.y1;
	r.y1 = y;
	return y;
}
function retune(r, f, bw) {
	const next = resonator(f, bw);
	r.a = next.a;
	r.b = next.b;
	r.c = next.c;
}

const VOWELS = [
	[730, 1090, 2440], // a
	[530, 1840, 2480], // e
	[270, 2290, 3010], // i
	[570, 840, 2410], // o
	[300, 870, 2240], // u
	[660, 1720, 2410], // ae
];

/** Raised-cosine rise and fall: 0..1 over `n` samples. */
const rise = (i, n) => (n <= 0 ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * Math.min(i, n)) / n));

/**
 * Speech-like signal of `seconds`, starting after `lead` seconds of nothing, at `levelDb` dBFS (RMS over
 * the utterances). Returns { x: Float64Array (int16 scale), truth: Uint8Array per frame, utterances }.
 */
export function speech({ seconds, levelDb, seed = 1, lead = 2 }) {
	const r = rng(seed);
	const total = Math.round(seconds * RATE);
	const x = new Float64Array(total);
	const utterances = []; // [fromSample, toSample)
	let at = Math.round(lead * RATE);
	const f1 = resonator(500, 60);
	const f2 = resonator(1500, 90);
	const f3 = resonator(2500, 120);
	const fric = resonator(4500, 2500);
	let lp1 = 0;
	let lp2 = 0;
	let prev = 0;
	let phase = 0;
	while (at < total - RATE) {
		const utteranceEnd = Math.min(total - Math.round(0.3 * RATE), at + Math.round(r.range(0.6, 2.6) * RATE));
		const start = at;
		const baseF0 = r.range(95, 230);
		let last = at;
		while (at < utteranceEnd) {
			// A word: one to three syllables, run together.
			const syllables = 1 + Math.floor(r() * 3);
			for (let s = 0; s < syllables && at < utteranceEnd; s++) {
				const vowel = r.pick(VOWELS);
				retune(f1, vowel[0], 60);
				retune(f2, vowel[1], 90);
				retune(f3, vowel[2], 120);
				const stress = dbToAmp(r.range(-7, 0));
				const len = Math.round(r.range(0.11, 0.28) * RATE);
				const attack = Math.round(r.range(0.015, 0.04) * RATE);
				const decay = Math.round(r.range(0.04, 0.09) * RATE);
				// An onset consonant: a fricative (40-100 ms of hiss), a plosive (a closure, then a burst), or none.
				const kind = r();
				if (kind < 0.25) {
					const n = Math.round(r.range(0.04, 0.1) * RATE);
					const level = stress * dbToAmp(r.range(-16, -8)) * 6;
					for (let i = 0; i < n && at + i < total; i++) x[at + i] += resonate(fric, r.gauss()) * level * rise(i, 240) * rise(n - i, 240);
					at += n;
				} else if (kind < 0.45) {
					at += Math.round(r.range(0.03, 0.06) * RATE); // the closure: silence
					const n = Math.round(0.008 * RATE);
					const level = stress * dbToAmp(r.range(-10, -4)) * 6;
					for (let i = 0; i < n && at + i < total; i++) x[at + i] += resonate(fric, r.gauss()) * level * (1 - i / n);
					at += n;
				}
				// The vowel: a pulse train at a pitch that falls over the utterance, through the tract.
				for (let i = 0; i < len && at + i < total; i++) {
					const progress = (at + i - start) / Math.max(1, utteranceEnd - start);
					const f0 = baseF0 * (1.08 - 0.2 * progress) * (1 + 0.03 * Math.sin((2 * Math.PI * (at + i)) / 9000));
					phase += f0 / RATE;
					let pulse = 0;
					if (phase >= 1) {
						phase -= 1;
						pulse = 1;
					}
					lp1 += 0.12 * (pulse - lp1);
					lp2 += 0.12 * (lp1 - lp2);
					const tract = resonate(f3, resonate(f2, resonate(f1, lp2)));
					const lips = tract - prev;
					prev = tract;
					const env = rise(i, attack) * rise(len - i, decay) * stress;
					x[at + i] += lips * env * 400;
				}
				at += len;
				last = at;
				// Syllables inside a word touch or nearly touch.
				at += Math.round(r.range(0, 0.03) * RATE);
			}
			// Between words: 30-150 ms of nothing.
			at += Math.round(r.range(0.03, 0.15) * RATE);
		}
		utterances.push([start, Math.min(total, last)]);
		at = last + Math.round(r.range(0.4, 1.8) * RATE);
	}
	setLevel(x, levelDb, utterances);
	const frames = Math.floor(total / FRAME);
	const truth = new Uint8Array(frames);
	const spans = [];
	for (const [from, to] of utterances) {
		const a = Math.floor(from / FRAME);
		const b = Math.min(frames - 1, Math.ceil(to / FRAME) - 1);
		for (let f = a; f <= b; f++) truth[f] = 1;
		spans.push([a, b]);
	}
	return { x, truth, utterances: spans };
}

/** White noise, a microphone's own hiss. */
export function hiss({ seconds, levelDb, seed = 2 }) {
	const r = rng(seed);
	const x = new Float64Array(Math.round(seconds * RATE));
	for (let i = 0; i < x.length; i++) x[i] = r.gauss();
	return setLevel(x, levelDb);
}

/** Pink noise (Paul Kellet's filter): equal energy per octave, the shape of most fans and air. */
export function pink({ seconds, levelDb, seed = 3 }) {
	const r = rng(seed);
	const x = new Float64Array(Math.round(seconds * RATE));
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < x.length; i++) {
		const w = r.gauss();
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
		b6 = w * 0.115926;
	}
	return setLevel(x, levelDb);
}

/** Brown noise (integrated white, leaky): the rumble of a big fan or an air conditioner. */
export function brown({ seconds, levelDb, seed = 4 }) {
	const r = rng(seed);
	const x = new Float64Array(Math.round(seconds * RATE));
	let y = 0;
	for (let i = 0; i < x.length; i++) {
		y = 0.998 * y + r.gauss() * 0.05;
		x[i] = y;
	}
	return setLevel(x, levelDb);
}

/**
 * A desk fan: pink noise, some rumble, the blade-pass tone and its harmonics, and a slow wobble of a
 * decibel as the air moves.
 */
export function fan({ seconds, levelDb, seed = 5 }) {
	const air = pink({ seconds, levelDb: -20, seed });
	const rumble = brown({ seconds, levelDb: -26, seed: seed + 1 });
	const x = new Float64Array(air.length);
	const blade = 87 + (seed % 7);
	for (let i = 0; i < x.length; i++) {
		const t = i / RATE;
		const tone = Math.sin(2 * Math.PI * blade * t) + 0.5 * Math.sin(2 * Math.PI * 2 * blade * t) + 0.25 * Math.sin(2 * Math.PI * 3 * blade * t);
		const wobble = 1 + 0.12 * Math.sin(2 * Math.PI * 0.3 * t);
		x[i] = (air[i] + rumble[i] + tone * 0.05 * FULL * dbToAmp(-20)) * wobble;
	}
	return setLevel(x, levelDb);
}

/** Mains hum with its buzz: 50 Hz and the harmonics a ground loop adds. */
export function hum({ seconds, levelDb }) {
	const x = new Float64Array(Math.round(seconds * RATE));
	const partials = [1, 0.6, 0.45, 0.3, 0.25, 0.15, 0.12, 0.08];
	for (let i = 0; i < x.length; i++) {
		const t = i / RATE;
		let v = 0;
		for (let k = 0; k < partials.length; k++) v += partials[k] * Math.sin(2 * Math.PI * 50 * (k + 1) * t + k);
		x[i] = v;
	}
	return setLevel(x, levelDb);
}

/**
 * Typing: bursts of 3-9 keys 70-220 ms apart, 0.3-1 s between words. Each key is a click (a few
 * milliseconds of bright noise) on a thump (a damped 180 Hz ring), at `peakDb` dBFS peak, give or take.
 */
export function keyboard({ seconds, peakDb, seed = 6 }) {
	const r = rng(seed);
	const x = new Float64Array(Math.round(seconds * RATE));
	const bright = resonator(3500, 3000);
	let at = Math.round(r.range(0.1, 0.5) * RATE);
	while (at < x.length) {
		const keys = 3 + Math.floor(r() * 7);
		for (let k = 0; k < keys && at < x.length; k++) {
			const peak = dbToAmp(peakDb + r.range(-4, 2)) * FULL;
			const tau = r.range(0.0012, 0.003) * RATE;
			const n = Math.min(x.length - at, Math.round(0.03 * RATE));
			const click = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				click[i] = resonate(bright, r.gauss()) * Math.exp(-i / tau) + 0.6 * Math.sin((2 * Math.PI * 180 * i) / RATE) * Math.exp(-i / (0.004 * RATE));
			}
			let top = 0;
			for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(click[i]));
			for (let i = 0; i < n; i++) x[at + i] += (click[i] / (top || 1)) * peak;
			at += Math.round(r.range(0.07, 0.22) * RATE);
		}
		at += Math.round(r.range(0.3, 1) * RATE);
	}
	return x;
}

/**
 * Music bleeding into a microphone: 112 bpm, a chord per bar on a few harmonics, a bass note per beat, a
 * kick on every beat, a snare on two and four, eighth-note hats.
 */
export function music({ seconds, levelDb, seed = 7 }) {
	const r = rng(seed);
	const x = new Float64Array(Math.round(seconds * RATE));
	const beat = Math.round((60 / 112) * RATE);
	const chords = [
		[220, 277.2, 329.6],
		[196, 246.9, 293.7],
		[174.6, 220, 261.6],
		[196, 246.9, 311.1],
	];
	const snare = resonator(1800, 2500);
	const hat = resonator(8000, 3000);
	for (let i = 0; i < x.length; i++) {
		const b = Math.floor(i / beat);
		const inBeat = i - b * beat;
		const t = i / RATE;
		const chord = chords[Math.floor(b / 4) % chords.length];
		let v = 0;
		for (const f of chord) for (let h = 1; h <= 4; h++) v += (0.18 / h) * Math.sin(2 * Math.PI * f * h * t);
		const bass = chord[0] / 2;
		v += 0.5 * Math.sin(2 * Math.PI * bass * t) * Math.exp(-inBeat / (0.25 * RATE));
		v += 1.2 * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-inBeat / 800)) * (inBeat / RATE)) * Math.exp(-inBeat / (0.07 * RATE));
		if (b % 2 === 1) v += 0.5 * resonate(snare, r.gauss()) * Math.exp(-inBeat / (0.06 * RATE));
		const eighth = inBeat % (beat >> 1);
		v += 0.15 * resonate(hat, r.gauss()) * Math.exp(-eighth / (0.012 * RATE));
		x[i] = v;
	}
	return setLevel(x, levelDb);
}

/** `a + b`, shorter one zero-padded; `from`/`to` (seconds) keep `b` to a stretch of the timeline. */
export function add(a, b, { from = 0, to = Infinity } = {}) {
	const out = Float64Array.from(a);
	const start = Math.round(from * RATE);
	const end = Math.min(a.length, Math.round(to * RATE));
	for (let i = start; i < end && i < b.length; i++) out[i] += b[i];
	return out;
}

/** Float signal (int16 scale) -> 20 ms Int16Array frames, clipped. */
export function toFrames(x) {
	const frames = [];
	for (let at = 0; at + FRAME <= x.length; at += FRAME) {
		const frame = new Int16Array(FRAME);
		for (let i = 0; i < FRAME; i++) {
			const v = Math.round(x[at + i]);
			frame[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
		}
		frames.push(frame);
	}
	return frames;
}

/**
 * Runs one speaker's frames through a real SpeakerMixer and returns, per frame, whether the mixer called
 * them speaking. `Mixer` is passed in so that this file does not pin a path into src/.
 */
export function detect(Mixer, frames, options = {}) {
	const mixer = new Mixer({ floorControl: true, agc: true, ...options });
	const out = new Uint8Array(frames.length);
	for (let i = 0; i < frames.length; i++) {
		mixer.push('a', frames[i]);
		out[i] = mixer.tick().active.includes('a') ? 1 : 0;
	}
	return out;
}

/**
 * Scores a detector against the truth:
 *   recall   share of speech frames called speech
 *   falseRate share of non-speech frames called speech; the `graceFrames` after an utterance are left
 *            out, because a hold after the last word is the design, and it is the same hold in both modes
 *   onset    mean frames from an utterance's first frame to the first frame called speech (the utterances
 *            never called speech at all are `missed`)
 *   chops    breaks inside an utterance: called speech, then not, then speech again before it ends
 */
export function score(truth, detected, { graceFrames = 11, utterances = [] } = {}) {
	let speechFrames = 0;
	let hits = 0;
	let quiet = 0;
	let falseHits = 0;
	const grace = new Uint8Array(truth.length);
	for (const [, to] of utterances) for (let f = to + 1; f <= to + graceFrames && f < truth.length; f++) grace[f] = 1;
	for (let i = 0; i < truth.length; i++) {
		if (truth[i]) {
			speechFrames++;
			hits += detected[i];
		} else if (!grace[i]) {
			quiet++;
			falseHits += detected[i];
		}
	}
	let onsetSum = 0;
	let found = 0;
	let missed = 0;
	let chops = 0;
	for (const [from, to] of utterances) {
		let first = -1;
		for (let f = from; f <= to; f++) {
			if (detected[f]) {
				first = f;
				break;
			}
		}
		if (first < 0) {
			missed++;
			continue;
		}
		found++;
		onsetSum += first - from;
		for (let f = first + 1; f <= to; f++) if (detected[f] && !detected[f - 1]) chops++;
	}
	return rates({ speechFrames, hits, quiet, falseHits, onsetSum, found, missed, chops, utterances: utterances.length });
}

/** The rates of a score, or of several scores' counts added together (see pool). */
export function rates(counts) {
	return {
		...counts,
		recall: counts.speechFrames ? counts.hits / counts.speechFrames : null,
		falseRate: counts.quiet ? counts.falseHits / counts.quiet : null,
		onset: counts.found ? counts.onsetSum / counts.found : null,
	};
}

/** Several scores (other seeds of the same room) as one. */
export function pool(scores) {
	const keys = ['speechFrames', 'hits', 'quiet', 'falseHits', 'onsetSum', 'found', 'missed', 'chops', 'utterances'];
	const counts = Object.fromEntries(keys.map((key) => [key, scores.reduce((sum, s) => sum + s[key], 0)]));
	return rates(counts);
}

/**
 * The rooms. Each is { name, group, build(seconds) -> { x, truth, utterances } }: `group` says what it
 * tests (`level`: one speaker in a quiet room; `noise`: a speaker over something that is not speech;
 * `none`: no speech at all, all-zero truth). `seed` moves every generator to other random choices, so a
 * detector tuned on one set of rooms can be checked on rooms it has not seen.
 */
export function scenarios({ seed = 0 } = {}) {
	const k = seed * 1000;
	const quietRoom = (seconds) => hiss({ seconds, levelDb: -72, seed: 11 + k });
	const talk = (levelDb) => (seconds) => speech({ seconds, levelDb, seed: 21 + k });
	const withNoise = (voice, noise) => (seconds) => {
		const s = voice(seconds);
		return { ...s, x: add(s.x, noise(seconds)) };
	};
	const alone = (noise) => (seconds) => {
		const x = noise(seconds);
		return { x, truth: new Uint8Array(Math.floor(x.length / FRAME)), utterances: [] };
	};
	const inRoom = (noise) => (seconds) => add(noise(seconds), quietRoom(seconds));
	const fanAt = (levelDb) => inRoom((seconds) => fan({ seconds, levelDb, seed: 5 + k }));
	const rumble = inRoom((seconds) => brown({ seconds, levelDb: -40, seed: 4 + k }));
	const mains = (levelDb) => (seconds) => hum({ seconds, levelDb });
	const typing = inRoom((seconds) => keyboard({ seconds, peakDb: -20, seed: 6 + k }));
	const bleed = (levelDb) => inRoom((seconds) => music({ seconds, levelDb, seed: 7 + k }));
	const fanFromHalfway = (seconds) => add(quietRoom(seconds), fan({ seconds, levelDb: -40, seed: 5 + k }), { from: seconds / 2 });
	return [
		{ name: 'loud speaker, quiet room (-18 dBFS)', group: 'level', build: withNoise(talk(-18), quietRoom) },
		{ name: 'normal speaker, quiet room (-30)', group: 'level', build: withNoise(talk(-30), quietRoom) },
		{ name: 'quiet speaker, quiet room (-42)', group: 'level', build: withNoise(talk(-42), quietRoom) },
		{ name: 'very quiet speaker (-48)', group: 'level', build: withNoise(talk(-48), quietRoom) },
		{ name: 'normal speaker + fan at -50', group: 'noise', build: withNoise(talk(-30), fanAt(-50)) },
		{ name: 'normal speaker + fan at -40', group: 'noise', build: withNoise(talk(-30), fanAt(-40)) },
		{ name: 'quiet speaker + fan at -55', group: 'noise', build: withNoise(talk(-42), fanAt(-55)) },
		{ name: 'quiet speaker + fan at -50', group: 'noise', build: withNoise(talk(-42), fanAt(-50)) },
		{ name: 'normal speaker + brown rumble at -40', group: 'noise', build: withNoise(talk(-30), rumble) },
		{ name: 'normal speaker + mains hum at -40', group: 'noise', build: withNoise(talk(-30), inRoom(mains(-40))) },
		{ name: 'normal speaker + music bleed at -40', group: 'noise', build: withNoise(talk(-30), bleed(-40)) },
		{ name: 'normal speaker + typing', group: 'noise', build: withNoise(talk(-30), typing) },
		{ name: 'fan turns on mid-session (-40)', group: 'noise', build: withNoise(talk(-30), fanFromHalfway) },
		{ name: 'silence (digital zero)', group: 'none', build: alone((s) => new Float64Array(Math.round(s * RATE))) },
		{ name: 'near-silence (hiss at -72)', group: 'none', build: alone(quietRoom) },
		{ name: 'fan alone (-40)', group: 'none', build: alone(fanAt(-40)) },
		{ name: 'fan alone (-30)', group: 'none', build: alone(fanAt(-30)) },
		{ name: 'mains hum alone (-40)', group: 'none', build: alone(mains(-40)) },
		{ name: 'typing alone (clicks at -20 peak)', group: 'none', build: alone(typing) },
		{ name: 'music bleed alone (-35)', group: 'none', build: alone(bleed(-35)) },
	];
}
