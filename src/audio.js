// Audio DSP + buffering for the Discord <-> GPT-Live bridge.
//
// Formats involved:
//   Discord receive : Opus -> PCM s16le, 48000 Hz, stereo (we decode with prism-media)
//   GPT-Live        : PCM s16le, 24000 Hz, mono  (session.audio.format = audio/pcm @ 24000)
//   Discord playback: PCM s16le, 48000 Hz, stereo (StreamType.Raw)
//
// No ffmpeg is used on the voice path; all conversions are the small integer routines below.
// (Music playback decodes through ffmpeg separately, see music.js.)

import { t } from './i18n/index.js';

export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME_24K = 480; // 20 ms @ 24 kHz
export const SAMPLES_PER_FRAME_48K = 960; // 20 ms @ 48 kHz
export const STEREO_SAMPLES_PER_FRAME_48K = SAMPLES_PER_FRAME_48K * 2; // interleaved L/R

/** Peak value (absolute int16). The loop that would otherwise be repeated everywhere, kept in one place. */
export function peakOf(samples, count = samples.length) {
	let peak = 0;
	for (let i = 0; i < count; i++) {
		const value = samples[i];
		const abs = value < 0 ? -value : value;
		if (abs > peak) peak = abs;
	}
	return peak;
}

/** out[i] += src[i] * gain (clamped to the int16 range). */
export function mixInto(out, src, count = src.length, gain = 1) {
	for (let i = 0; i < count; i++) {
		const sum = out[i] + src[i] * gain;
		out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum | 0;
	}
}

/**
 * The decoder's Buffer as Int16Array, copied: a Buffer from the pool can start at an odd byte and a
 * view over it would throw, and the mixer's ring and the local ear both keep what they are given.
 */
export function int16From(buf) {
	return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1)));
}

/** Root mean square of the first `count` samples. */
export function rmsOf(samples, count = samples.length) {
	if (count <= 0) return 0;
	let acc = 0;
	for (let i = 0; i < count; i++) acc += samples[i] * samples[i];
	return Math.sqrt(acc / count);
}

// Above the knee a sample is squashed, not cut: a loud syllable through the gain comes out rounded
// instead of as the buzz of a flat top.
const SOFT_KNEE = 26000;
export function softClip(v) {
	const a = v < 0 ? -v : v;
	if (a <= SOFT_KNEE) return v | 0;
	const y = SOFT_KNEE + (a - SOFT_KNEE) * 0.25;
	const c = y > 32767 ? 32767 : y;
	return (v < 0 ? -c : c) | 0;
}

/**
 * Int16Array(mono 24k) -> Int16Array(stereo 48k, interleaved) with linear interpolation.
 * `state.last` carries the previous sample across calls so interpolation is continuous.
 * If `out` is given it is reused, so no allocation happens.
 */
export function upsampleMono24kToStereo48k(src, state = { last: 0 }, out = null) {
	const n = src.length;
	const target = out && out.length >= n * 4 ? out : new Int16Array(n * 4);
	let prev = state.last ?? (n > 0 ? src[0] : 0);
	for (let i = 0; i < n; i++) {
		const b = src[i];
		const mid = (prev + b) >> 1;
		const o = i * 4;
		target[o] = mid;
		target[o + 1] = mid;
		target[o + 2] = b;
		target[o + 3] = b;
		prev = b;
	}
	state.last = prev;
	return target;
}

/** Int16Array(mono 24k) -> Buffer(s16le stereo 48k). */
export function mono24kToStereo48k(src, state = { last: 0 }) {
	const out = upsampleMono24kToStereo48k(src, state);
	return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/** Silence frame for Discord playback (20 ms worth by default). */
export function silenceStereo48k(samples = SAMPLES_PER_FRAME_48K) {
	return Buffer.alloc(samples * 4);
}

/** Fixed-capacity sample ring. Overflows drop the OLDEST samples (keeps audio fresh). */
export class Ring {
	constructor(capacity) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(t('voice.ring_capacity', { capacity }));
		this.cap = capacity;
		this.buf = new Int16Array(capacity);
		this.r = 0;
		this.size = 0;
	}

	get length() {
		return this.size;
	}

	get free() {
		return this.cap - this.size;
	}

	/** Appends; on overflow the oldest samples go. Returns how many were dropped, so that a full ring is counted. */
	push(src) {
		const n = src.length;
		if (n <= 0) return 0;
		if (n >= this.cap) {
			const dropped = this.size + n - this.cap;
			this.buf.set(src.subarray(n - this.cap), 0);
			this.r = 0;
			this.size = this.cap;
			return dropped;
		}
		const w = (this.r + this.size) % this.cap;
		const first = Math.min(n, this.cap - w);
		this.buf.set(src.subarray(0, first), w);
		if (n > first) this.buf.set(src.subarray(first), 0);
		this.size += n;
		if (this.size > this.cap) {
			const drop = this.size - this.cap;
			this.r = (this.r + drop) % this.cap;
			this.size = this.cap;
			return drop;
		}
		return 0;
	}

	/** Read up to `max` samples into `dst`; returns how many were written. */
	read(dst, max = dst.length) {
		const n = Math.min(max, this.size, dst.length);
		if (n <= 0) return 0;
		const first = Math.min(n, this.cap - this.r);
		dst.set(this.buf.subarray(this.r, this.r + first), 0);
		if (n > first) dst.set(this.buf.subarray(0, n - first), first);
		this.r = (this.r + n) % this.cap;
		this.size -= n;
		return n;
	}

	clear() {
		this.r = 0;
		this.size = 0;
	}
}

// "There is audio here" and "this person is speaking" are two different questions, and answering the
// second with the first is what puts one person's sentence in somebody else's mouth. A peak of 50 out
// of 32767 is a quiet room through an open microphone: breathing, a fan, a keyboard. The bar for
// speech is the one the per-user transcriber already uses.
const SPEECH_PEAK = 400;
// Speech has to clear that bar for two frames (40 ms) before it counts, so one click is not a speaker.
const SPEECH_ONSET_FRAMES = 2;
// It then stays that person's turn for 200 ms after their last loud frame, which covers the gaps
// between words and the jitter Discord delivers packets with.
//
// This number was half a second at first, borrowed from where a recording bot stops calling a gap
// jitter. That was the wrong thing to borrow: a gap is EXCLUDED from the audible time downstream, so a
// long hold buys nothing there, while it does put two people who merely take turns in the same frame.
// Measured in a real channel, a quarter of a second between turns was enough to have the whole room
// reading as "everybody talking at once", and every voice command in the session was refused for it.
const SPEECH_HOLD_FRAMES = 10;
// The priority speaker keeps the channel to themselves for the same half second of quiet, but only
// while their packets are still arriving...
const FLOOR_HOLD_FRAMES = 25;
// ...where "still arriving" tolerates 100 ms, which is where Craig stops calling a gap jitter. The old
// code gave the floor away on a single missing packet, so a sentence was cut into pieces that were
// then shared out between the people who happened to be breathing at the time.
const FLOOR_JITTER_FRAMES = 5;
// "Somebody else's voice is in this frame" is a third question, and it needs its own bar. Not the
// speech bar: a voice below that is still summed into the frame the model transcribes, so treating it
// as absent let somebody speak quietly and have their words land under another person's name. Not the
// audio bar either, which is a fan or a keyboard. This is the level the barge-in check already uses
// for "there is real sound here". It stays this bar under the adaptive detector (VAD_TUNING): presence
// is the attacker's question, and a bar that follows a person's own noise floor is one they can raise
// with a noise of their own and then murmur under.
//
// And it is asked of what goes INTO the frame, after the gain, not of what the microphone sent. The frame
// the model transcribes holds every voice times its AGC gain, and a peak bar on the way in let a voice
// through twice over: a guest whose gain had been set to +18 dB by an earlier sentence could whisper at a
// peak of 100 and go out at 800, "absent"; and a whisper has little peak for its energy, so one at -60
// dBFS cleared a peak of 200 on 5 of its 35 frames and was nobody on the other 30. So a voice is also
// present when its energy after the gain is PRESENCE_DB or more -- which is the adaptive detector's
// digital silence (VAD_TUNING.silenceDb), not a level of speech. Any bar above that leaves a band the
// transcriber can hear and the gate cannot: at -60 dBFS a whisper compressed to -63 was present on none of
// its frames and a command in it opened the gate; at -80 a whisper at -78 in a -90 room is present on 9 of
// its 35 frames (24 compressed) and the gate stays shut. What this costs is measured on npm run bench,
// whose open microphones all carry their room above either bar: the owner's commands opened as before.
const PRESENCE_PEAK = 200;
const PRESENCE_DB = -80;
const PRESENCE_RMS = 32768 * 10 ** (PRESENCE_DB / 20);
// Floor control: one voice at a time. The model hears a SUM and cannot pull it apart, so two people at
// once is the one thing every downstream step is worst at -- the transcript comes back garbled, the line
// is nobody's, the gate refuses, the command is not run. The owner's priority path proves the cure: while
// one voice is sent, everything about that stretch is exact. With floor control that is the rule for
// everybody: the person holding the floor is the only one sent, the floor passes at their pause to
// whoever has been waiting longest, and a monologue this long can be taken from them by somebody who has
// been talking over it for this long. What is lost is the interrupter's first seconds, which the model
// was not understanding anyway.
const FLOOR_MAX_FRAMES = 400;
const BARGE_FRAMES = 75;
// While somebody holds the floor, everybody else's frames are discarded -- including the first frames of
// whoever speaks next, until the holder pauses. To a transcriber the onset of a word is the word:
// "adamsın" without its "a" is anybody's guess. So the last few frames of every speaker are kept, and
// when the floor passes to somebody whose frames were being discarded, those frames go out first and
// the live ones queue behind them until they pause. Nothing is lost, and the stream stays one frame
// per tick. 360 ms: the holder's hold after their last loud frame, the frames the decoder may have made
// up for them, the jitter allowance, and the onset on top of it -- measured, 240 ms lost two frames of
// the newcomer's onset at a warm handover.
const PREROLL_FRAMES = 18;
// The tick that catches a talk-spurt's first packet is late by a random part of a frame (the Windows
// timer alone is 0-16 ms). Reading that packet at once fixes the ring's phase to that tick, and the next
// packet, on time, arrives just after the next tick: 20 ms of nothing as the second frame of the word.
// Simulated on the real mixer, a quarter of two-second utterances got a hole at 2 ms of jitter and most
// of them at 10 ms, nearly all in the first frames. So a spurt is read from its second frame: every
// packet after that has a frame's margin over the tick's lateness. A spurt of a single frame is not held
// for longer than PRIME_TICKS. Live the margin is two frames (PRIME_FRAMES in the config); the constructor's
// default is none, so that what the tests push on one tick comes out on that tick.
const PRIME_TICKS = 1;
// A packet late or lost in the middle of a sentence used to go out as 20 ms of nothing: a click and a
// missing syllable, and the transcriber guessing the word. The decoder can make up a frame from what it
// heard last (Opus packet loss concealment); that is used for up to this many frames in a row, then the
// gap is real.
const CONCEAL_FRAMES = 3;
// A ring this deep at tick time means that speaker's audio is running behind by that much.
const DEEP_FRAMES = 3;
// Per-speaker loudness: one person's quiet microphone was arriving at a fifth of the level of the next
// person's, and the transcriber hears the mix. Speech is brought towards -20 dBFS RMS, slowly up (a quiet
// person is raised over a second or so), quickly down (a shout is caught within a few frames), by no
// more than +18 / -6 dB, and squashed above the knee rather than clipped. Only speech moves the estimate,
// so a pause does not pump the gain.
const AGC_TARGET_RMS = 3277; // -20 dBFS
const AGC_MAX_GAIN = 8;
const AGC_MIN_GAIN = 0.5;
const AGC_LEVEL_ALPHA = 0.05;
const AGC_UP = 1.02;
const AGC_DOWN = 0.8;
const LONG_AGO = -1e9;

// ---------------------------------------------------------------- who is speaking, per microphone
//
// SPEECH_PEAK above is one bar for every microphone, and a microphone is not a room. Measured on the
// synthetic rooms in bench/vad.mjs (npm run bench:vad): a quiet speaker at -42 dBFS was heard on 71% of
// their speech frames and one at -48 dBFS on 45%, while a desk fan at -40 dBFS cleared it on every frame
// it made -- a fan's owner was a speaker for as long as the fan ran, and under floor control the fan held
// the floor 98% of the time against somebody who was actually talking. VAD=adaptive judges each person
// against their own microphone instead: the energy of a frame in dB, against the noise floor tracked on
// that person's frames alone. VAD=peak is the bar above, exactly as it was.
export const VAD_TUNING = Object.freeze({
	// The energy is measured through two first-order high-passes (-3 dB at 170 Hz, -16 dB at 50 Hz).
	// What a fan, an air conditioner and the mains put into a microphone lives mostly below the voice,
	// and it is also what makes their level wander from frame to frame: through the high-pass the frame
	// energy of the fan above spreads 0.9 dB instead of 2.2, and a brown rumble 1.1 dB instead of 4.2. A
	// floor that wanders less needs less of a margin above it, and the margin is what a quiet voice has to
	// clear. The voice loses little: its energy is in the formants, and at 270 Hz the loss is 1.2 dB.
	highPass: 0.97,
	// The floor is the quietest frame of the last 1.6 s of this person's audio, kept as four blocks of
	// 400 ms so that it costs four comparisons a frame. A voice dips back to the room between words and in
	// the closure of every p, t and k, many times in 1.6 s; a fan never dips below itself. So a lower frame
	// takes the floor down at once, and a louder room takes it up within 1.6 s.
	blockFrames: 20,
	blocks: 4,
	// A frame starts a talk-spurt 6 dB above the floor (with SPEECH_ONSET_FRAMES of them in a row, as
	// before) and keeps one going 5 dB above it: the tail of a word decays through the bar it rose through,
	// and the lower bar keeps the hold running from the end of the tail rather than from the last stressed
	// syllable. The hold after that is SPEECH_HOLD_FRAMES, unchanged (see _speaking for what now lets it run
	// its length in a quiet room). Swept on the rooms of the bench: 7 dB to start cost a quiet speaker over a fan 0.8 frames of onset and 1.6
	// points of recall; 4 dB to keep going let a brown rumble hold turns open (16% false speech against 4%).
	onsetDb: 6,
	keepDb: 5,
	// And never below -55 dBFS to start, -60 to keep going, whatever the floor: a microphone after noise
	// suppression can sit at -90, where a floor-relative bar alone would call a breath a sentence. -55 is
	// a voice the AGC can still bring to -37 dBFS; a -48 dBFS speaker is heard on 86% of their frames.
	minOnsetDb: -55,
	minKeepDb: -60,
	// Below this a frame is digital silence: nothing was transmitted (the decoded silence frames Discord
	// ends a talk-spurt with), so it says nothing about the room and does not enter the floor.
	silenceDb: -80,
	// Before a person has sent anything, their room is assumed quiet. Starting the floor at the first
	// frame instead would judge the first word of the session against itself, and Discord sends nothing
	// until somebody speaks, so the first frame usually is a word.
	initialFloorDb: -70,
	// The sanity ceiling: a sound that has held within 3 dB for 300 ms, well above the floor, is not a
	// voice -- in the bench's speech even the steadiest tenth of 300 ms stretches spans 29 dB -- and the
	// floor is lifted to it at once instead of after 1.6 s. A fan switched on in a quiet room is a speaker
	// for 0.5 s (300 ms, and the hold) instead of 1.8 s; the same for a hum or a held chord. A held "mmmm"
	// is the one voice it catches, and only its tail.
	steadyFrames: 15,
	steadyDb: 3,
	// A key click puts its energy into a few milliseconds of the frame, a voice spreads it over the whole
	// of it: peak against RMS (after the high-pass), a click frame is 15-19 dB (10th to 90th percentile), a
	// speech frame 6-12, and 3% of speech frames are above 15, mostly the burst of a p or a t. A frame above
	// 15 dB neither starts nor holds a turn. Without this, adaptive mode was worse than the peak bar at
	// typing, 42% of a typist's frames against 18%, because every click is far above a quiet room's floor;
	// with it, 0.1%. Letting such a frame hold a turn it did not start saved a few word boundaries, and
	// called somebody who types between sentences a speaker on 30% of the frames they were not talking.
	crestDb: 15,
});
const DBFS = 10 * Math.log10(32768 * 32768);

/**
 * One person's microphone as the adaptive detector sees it: each frame's peak, its energy in dBFS after
 * the high-pass and its crest, and the noise floor of the last 1.6 s. A few multiply-adds per sample, in
 * the pass that finds the peak anyway, and a few dozen comparisons per frame. Measured with ten people
 * sending every frame, a tick costs 64 µs against 37 µs with the peak bar: a third of a percent of the
 * 20 ms it has.
 */
export class NoiseFloor {
	constructor(tuning = VAD_TUNING) {
		this.tuning = tuning;
		this.blocks = new Float64Array(tuning.blocks).fill(tuning.initialFloorDb);
		this.block = 0;
		this.blockMin = Infinity;
		this.blockFill = 0;
		this.recent = new Float64Array(tuning.steadyFrames);
		this.recentAt = 0;
		this.recentFill = 0;
		this.floor = tuning.initialFloorDb;
		this.tracked = 0; // frames taken into the floor
		// The two high-pass sections carry their last input and output across frames.
		this.x1 = 0;
		this.y1 = 0;
		this.z1 = 0;
		this.w1 = 0;
		this.db = -Infinity;
		this.peak = 0;
		this.voiced = false;
		this.crestRatio = 10 ** (tuning.crestDb / 10); // crestDb as a ratio of powers, so a frame needs no log for it
	}

	/** Measures a frame: its peak (absolute int16, as peakOf), energy in dBFS and whether it can be a voice. */
	measure(samples, count) {
		const r = this.tuning.highPass;
		let x1 = this.x1;
		let y1 = this.y1;
		let z1 = this.z1;
		let w1 = this.w1;
		let peak = 0;
		let top = 0;
		let acc = 0;
		for (let i = 0; i < count; i++) {
			const x = samples[i];
			const abs = x < 0 ? -x : x;
			if (abs > peak) peak = abs;
			const y = x - x1 + r * y1;
			x1 = x;
			y1 = y;
			const w = y - z1 + r * w1;
			z1 = y;
			w1 = w;
			acc += w * w;
			const a = w < 0 ? -w : w;
			if (a > top) top = a;
		}
		this.x1 = x1;
		this.y1 = y1;
		this.z1 = z1;
		this.w1 = w1;
		this.peak = peak;
		this.db = acc > 0 && count > 0 ? 10 * Math.log10(acc / count) - DBFS : -Infinity;
		// The crest, peak² against the mean square (see crestDb).
		this.voiced = acc > 0 && top * top * count <= acc * this.crestRatio;
		return this.db;
	}

	/** The bar a frame has to clear to start a talk-spurt. */
	get onset() {
		return Math.max(this.floor + this.tuning.onsetDb, this.tuning.minOnsetDb);
	}

	/** The lower bar that keeps one going. */
	get keep() {
		return Math.max(this.floor + this.tuning.keepDb, this.tuning.minKeepDb);
	}

	/**
	 * Takes a frame, already judged against the floor as it stood, into the floor. Returns true when the
	 * steady check lifted the floor on this frame: the sound of the last 300 ms was a room, not a voice.
	 */
	track(db) {
		const tuning = this.tuning;
		if (!(db >= tuning.silenceDb)) return false;
		let lifted = false;
		this.tracked++;
		if (db < this.blockMin) this.blockMin = db;
		if (++this.blockFill >= tuning.blockFrames) {
			this.blocks[this.block] = this.blockMin;
			this.block = (this.block + 1) % this.blocks.length;
			this.blockMin = Infinity;
			this.blockFill = 0;
		}
		let floor = this.blockMin;
		for (let i = 0; i < this.blocks.length; i++) if (this.blocks[i] < floor) floor = this.blocks[i];
		const recent = this.recent;
		recent[this.recentAt] = db;
		this.recentAt = (this.recentAt + 1) % recent.length;
		if (this.recentFill < recent.length) this.recentFill++;
		if (this.recentFill === recent.length) {
			let lo = Infinity;
			let hi = -Infinity;
			for (let i = 0; i < recent.length; i++) {
				const v = recent[i];
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
			// Steady and well above the floor: the room got louder (see steadyFrames). Whatever the window
			// remembered from before it is no longer the room; a quieter frame later brings the floor back.
			if (hi - lo <= tuning.steadyDb && lo > floor + tuning.keepDb) {
				this.blocks.fill(lo);
				if (this.blockMin < lo) this.blockMin = lo;
				floor = lo;
				lifted = true;
			}
		}
		this.floor = floor;
		return lifted;
	}
}

/**
 * Per-speaker buffers summed into one 20 ms frame per tick.
 * Keeps each speaker's audio separate until the very last step so that
 * per-user features (solo listening, speaker announcements) stay possible.
 *
 * Each speaker also gets a small voice-activity state machine. The model is sent ONE mixed stream, so
 * the `active` list returned here is the only record of who said what: it is what later decides whose
 * sentence a transcript line was. It therefore has to answer "who is speaking", not "whose microphone
 * is open". What it is fed per frame is the peak bar (VAD=peak) or, with VAD=adaptive, the frame against
 * that person's own NoiseFloor; the onset, the hold and everything downstream of them are the same.
 */
export class SpeakerMixer {
	constructor({
		frameSamples = SAMPLES_PER_FRAME_24K,
		bufferFrames = 50, // a second: only an event-loop stall fills it, and then it must hold what arrived
		activityPeak = 50,
		presencePeak = PRESENCE_PEAK,
		presenceRms = PRESENCE_RMS,
		speechPeak = SPEECH_PEAK,
		onsetFrames = SPEECH_ONSET_FRAMES,
		holdFrames = SPEECH_HOLD_FRAMES,
		floorHoldFrames = FLOOR_HOLD_FRAMES,
		jitterFrames = FLOOR_JITTER_FRAMES,
		floorControl = false,
		floorMaxFrames = FLOOR_MAX_FRAMES,
		bargeFrames = BARGE_FRAMES,
		prerollFrames = PREROLL_FRAMES,
		agc = false,
		concealFrames = CONCEAL_FRAMES,
		primeFrames = 1,
		// Who is speaking: 'adaptive' (per person, against their own noise floor) or 'peak' (SPEECH_PEAK for
		// everybody). Live it is VAD in the config; the constructor keeps the peak bar, which is what the
		// tests' flat frames of 3000 were written against. `vadTuning` overrides VAD_TUNING, for the bench.
		vad = 'peak',
		vadTuning = null,
	} = {}) {
		this.adaptive = vad === 'adaptive';
		this.vadTuning = vadTuning ? Object.freeze({ ...VAD_TUNING, ...vadTuning }) : VAD_TUNING;
		this.primeFrames = Math.max(1, primeFrames | 0);
		this.floorControl = floorControl;
		this.floorMaxFrames = floorMaxFrames;
		this.bargeFrames = bargeFrames;
		this.prerollFrames = prerollFrames;
		this.agc = agc;
		this.concealFrames = concealFrames;
		this.concealers = new Map(); // id -> () => Int16Array | null, the decoder's guess at a missing frame
		// What the audio path did to the sound, for the health report: holes mid-sentence (and how many
		// the decoder filled), frames a full ring threw away, and how deep a ring has been at tick time.
		this.stats = { holes: 0, concealed: 0, overflow: 0, maxDepth: 0, deep: 0 };
		this.floorId = null; // who holds the floor under floor control (or the priority speaker)
		this.floorSince = 0;
		this.floorTakeovers = 0; // how often the floor was taken from somebody still speaking
		this.frameBufs = new Map();
		this.frameSamples = frameSamples;
		this.bufferSamples = frameSamples * bufferFrames;
		this.activityPeak = activityPeak;
		this.presencePeak = presencePeak;
		this.presenceRms = presenceRms;
		this.speechPeak = speechPeak;
		this.onsetFrames = onsetFrames;
		this.holdFrames = holdFrames;
		this.floorHoldFrames = floorHoldFrames;
		this.jitterFrames = jitterFrames;
		this.rings = new Map();
		this.voices = new Map(); // id -> { loud, speechAt, audioAt, energy, vad }
		this.frames = 0;
		this.priorityId = null;
		this.tmp = new Int16Array(frameSamples);
		this.out = new Int16Array(frameSamples * 2); // a backlog frame and the live one (see _emitFloor)
	}

	addUser(id) {
		if (!this.rings.has(id)) this.rings.set(id, new Ring(this.bufferSamples));
	}

	removeUser(id) {
		this.rings.delete(id);
		this.voices.delete(id);
		this.concealers.delete(id);
		this.frameBufs.delete(id); // 960 bytes a speaker, kept for good by everyone who ever spoke
	}

	/** How this speaker's decoder fills a frame that never arrived; null or a throw means it cannot. */
	setConcealer(id, fn) {
		if (typeof fn === 'function') this.concealers.set(id, fn);
		else this.concealers.delete(id);
	}

	_conceal(id) {
		const fn = this.concealers.get(id);
		if (!fn) return null;
		try {
			const fill = fn();
			return fill?.length ? fill : null;
		} catch {
			return null;
		}
	}

	/**
	 * The gain this speaker's frame goes out with. The level estimate moves only on frames that are speech
	 * in their own right (see _note), so silence and breath do not drag it down and pump the gain up. Under
	 * the peak bar a fan counted as speech here too: its -40 dBFS became the "voice" the gain was set for,
	 * and it went out 18 dB louder. The adaptive detector gives the estimate nothing but talk-spurts, and
	 * takes back what the first 300 ms of a steady noise gave it before it was known for one (see _note).
	 *
	 * A tick with no frame of theirs still has a gain: the backlog of a handover drains after they stop
	 * sending (see _emitFloor), and those frames are the tail of the same sentence. Unity there put the
	 * last words of a shouted sentence back up by 6 dB, and a quiet one's down by up to 18.
	 */
	_gain(f) {
		if (!this.agc) return 1;
		if (f.n <= 0) return f.voice.gain;
		const voice = f.voice;
		if (f.strong) {
			const rms = rmsOf(f.buf, f.n);
			voice.level = voice.level > 0 ? voice.level + (rms - voice.level) * AGC_LEVEL_ALPHA : rms;
		}
		if (voice.level <= 0) return voice.gain;
		const wanted = Math.min(AGC_MAX_GAIN, Math.max(AGC_MIN_GAIN, AGC_TARGET_RMS / voice.level));
		voice.gain = wanted < voice.gain ? Math.max(wanted, voice.gain * AGC_DOWN) : Math.min(wanted, voice.gain * AGC_UP);
		return voice.gain;
	}

	/** Copies a frame into `out` through the gain. */
	_write(out, samples, n, gain) {
		if (gain === 1) {
			out.set(n === samples.length ? samples : samples.subarray(0, n));
			return;
		}
		for (let i = 0; i < n; i++) out[i] = softClip(samples[i] * gain);
	}

	/** Every speaker's measured speech level and the gain in effect, for the health report. */
	levels() {
		const list = [];
		for (const [id, voice] of this.voices) {
			// The detector's view as well, in adaptive mode: the floor this person is judged against and the
			// bar a frame of theirs has to clear to start a turn.
			const vad = voice.vad?.tracked > 0 ? voice.vad : null;
			if (voice.level <= 0 && !vad) continue;
			list.push({
				id,
				levelDb: voice.level > 0 ? Math.round(20 * Math.log10(voice.level / 32768)) : null,
				gainDb: Math.round(20 * Math.log10(voice.gain)),
				floorDb: vad ? Math.round(vad.floor) : null,
				thresholdDb: vad ? Math.round(vad.onset) : null,
			});
		}
		return list;
	}

	_voice(id) {
		let voice = this.voices.get(id);
		if (!voice) {
			voice = { loud: 0, speechAt: LONG_AGO, audioAt: LONG_AGO, energy: 0, runStart: LONG_AGO, wasSpeaking: false, recent: [], pending: [], concealed: 0, level: 0, gain: 1, primed: false, primeSince: LONG_AGO, vad: this.adaptive ? new NoiseFloor(this.vadTuning) : null, sendingAt: LONG_AGO };
			this.voices.set(id, voice);
		}
		return voice;
	}

	/**
	 * One frame of this speaker's audio, loud or not. Every known speaker is noted on every tick, so
	 * that a hold runs out on its own when somebody simply stops sending packets. `db` is the frame's
	 * energy as their NoiseFloor measured it (adaptive mode only). Returns whether the frame is speech in
	 * its own right, which is what moves the AGC's estimate: a pause inside a turn is not.
	 */
	_note(voice, peak, db) {
		// A smoothed level, so that "the loudest person" is the one holding the floor and not whoever
		// produced the sharpest transient inside these 20 ms.
		voice.energy = voice.energy * 0.7 + peak * 0.3;
		const vad = voice.vad;
		if (!vad) {
			if (peak >= this.speechPeak) {
				voice.loud++;
				if (voice.loud >= this.onsetFrames) voice.speechAt = this.frames;
			} else {
				voice.loud = 0;
			}
			if (peak > this.activityPeak) voice.audioAt = this.frames;
			return peak >= this.speechPeak;
		}
		// Judged against the floor as it stood before this frame, then taken into it.
		if (vad.voiced && db >= vad.onset) voice.loud++;
		else voice.loud = 0;
		const strong = voice.loud >= this.onsetFrames;
		if (strong || (vad.voiced && db >= vad.keep && this.frames - voice.speechAt <= this.holdFrames)) voice.speechAt = this.frames;
		const lifted = vad.track(db);
		if (peak > this.activityPeak) voice.audioAt = this.frames;
		// For their turn, "still sending" is any frame that is not digital silence (see _speaking).
		if (db >= vad.tuning.silenceDb) voice.sendingAt = this.frames;
		// The steady check has just found that the last 300 ms were a room, not a voice -- and those frames
		// were a talk-spurt until it did, which is all the AGC's estimate listens to. A fan switched on was
		// "speech" for its first 24 frames, long enough to become the level the gain is set for; then it was
		// never strong again, so nothing moved the estimate back: the gain stayed at +18 dB, and a -40 dBFS
		// fan went out at -21.6 whenever the floor was free. What the estimate learned from the steady sound
		// is thrown away with it: the level and the gain start again, as for somebody new, and the same fan
		// goes out at -39.7. The cost would be a held "mmmm", the one voice the check catches, whose next
		// words start at unity and climb back; over the 46 minutes of speech in bench:vad's rooms it fired
		// once per room with a steady noise in it, as the noise began, and never inside speech.
		if (lifted) {
			voice.level = 0;
			voice.gain = 1;
			return false;
		}
		return strong;
	}

	/**
	 * Is this person mid-sentence (the gaps between their words included)?
	 *
	 * Two conditions, not one. They must have spoken recently, AND their packets must still be arriving:
	 * somebody who has stopped transmitting altogether has stopped talking, and holding them in the list
	 * on the strength of the first condition alone is what wrote a stale second name onto the first
	 * fragment of the next person's turn. While the level merely dips, through a quiet syllable, the
	 * packets keep coming and the turn is still theirs.
	 *
	 * Under the peak bar "still arriving" is a peak over 50, and in a quiet room the pause between two
	 * words is under 50: the turn ended 100 ms into it, before the 200 ms hold could cover it. Over six
	 * minutes of the bench's speech that broke a -30 dBFS speaker's utterances 150 times and a -42 dBFS
	 * speaker's 171. The adaptive detector counts any frame that is not digital silence (sendingAt), which
	 * Discord's own end-of-speech frames are, and the same speech broke 18 and 25 times. The owner's
	 * priority hold below keeps the old test: its 500 ms held in full kept a guest who answered the owner
	 * at once waiting 440 ms, and lost the first 80 ms of the answer past the pre-roll. As it is, the guest
	 * has the floor 100-140 ms into their answer (the owner's 200 ms hold, where it was 20-40), and the
	 * pre-roll sends what they said meanwhile.
	 */
	_speaking(voice) {
		return this.frames - voice.speechAt <= this.holdFrames && this.frames - (voice.vad ? voice.sendingAt : voice.audioAt) <= this.jitterFrames;
	}

	/** Does the priority speaker still own the channel: spoke recently AND is still sending packets. */
	_holdsFloor(voice) {
		return this.frames - voice.speechAt <= this.floorHoldFrames && this.frames - voice.audioAt <= this.jitterFrames;
	}

	push(id, samples) {
		let ring = this.rings.get(id);
		if (!ring) {
			ring = new Ring(this.bufferSamples);
			this.rings.set(id, ring);
		}
		const dropped = ring.push(samples);
		if (dropped > 0) this.stats.overflow += dropped / this.frameSamples;
	}

	/**
	 * Priority speaker (e.g. the bot owner): while they talk only their audio is sent, and once they
	 * go quiet the normal mix comes back.
	 */
	setPriority(userId) {
		this.priorityId = userId;
	}

	/** Adds the samples to the output frame and returns their peak value. */
	_addToOut(out, samples, count) {
		mixInto(out, samples, count, 1);
		return peakOf(samples, count);
	}

	/** This speaker's own frame buffer, so that every ring can be read before anything is summed. */
	_buf(id) {
		let buf = this.frameBufs.get(id);
		if (!buf) {
			buf = new Int16Array(this.frameSamples);
			this.frameBufs.set(id, buf);
		}
		return buf;
	}

	/** The floor changes hands. A takeover is the floor taken from somebody still speaking; a pause is not one. */
	_takeFloor(id, takeover = false) {
		if (this.floorId === id) return;
		if (takeover) this.floorTakeovers++;
		// Their first frames were discarded while the previous holder had the floor: those go out first, and
		// the frame read this tick goes out in its turn behind them. From a free floor nothing was lost, and
		// whatever an earlier turn left queued is not theirs to say now.
		const voice = this._voice(id);
		voice.pending = this.floorId !== null ? voice.recent.slice(0, -1) : [];
		this.floorId = id;
		this.floorSince = this.frames;
	}

	/**
	 * The floor holder's audio for this tick, and how many frames of it there are: one, or two while a
	 * backlog is being paid back. The backlog is the pre-roll (see _takeFloor); paid back one frame a
	 * tick it stayed the same length for the whole turn, and at the holder's pause the next speaker's
	 * first frames were discarded while it drained -- the handover came 200 ms late and took a word start
	 * with it. So two queued frames go out a tick, oldest first, the live frame joining the back of the
	 * queue: in order, nothing dropped, and the backlog gone within its own length.
	 */
	_emitFloor(out, f) {
		const voice = f.voice;
		const gain = this._gain(f);
		const n = this.frameSamples;
		if (!voice.pending.length) {
			if (f.n > 0) this._write(out, f.buf, f.n, gain);
			return 1;
		}
		if (f.n > 0) voice.pending.push(voice.recent[voice.recent.length - 1] ?? f.buf.slice(0, f.n)); // this tick, already kept
		const first = voice.pending.shift();
		this._write(out, first, Math.min(first.length, n), gain);
		const second = voice.pending.shift();
		if (!second) return 1;
		this._write(out.subarray(n, 2 * n), second, Math.min(second.length, n), gain);
		return 2;
	}

	/**
	 * One tick. Returns { pcm, frames, active, present, priority, others }: pcm = 20 ms of audio, or 40 ms
	 * (frames = 2) while a handover's backlog is paid back; active = who the frame's audio
	 * belongs to, present = whose voice is in the sound, others = who was speaking but was NOT sent (floor
	 * control). The returned `pcm` is a shared buffer: the next tick overwrites it, so the caller must
	 * consume it right away.
	 */
	tick() {
		const out = this.out;
		out.fill(0);
		this.frames++;
		// Every speaker's frame is read first, whatever is then done with it: who is speaking has to be
		// known before anything is summed, and a ring that is not read piles up 200 ms of stale audio.
		const frames = [];
		for (const [id, ring] of this.rings) {
			const buf = this._buf(id);
			const voice = this._voice(id);
			const depth = ring.length / this.frameSamples;
			if (depth > this.stats.maxDepth) this.stats.maxDepth = depth;
			if (depth >= DEEP_FRAMES) this.stats.deep++;
			// A talk-spurt is read from its second frame (see PRIME_FRAMES), or after PRIME_TICKS if a second
			// never comes. From then on the ring is read as it is: a frame of margin is in it.
			if (!voice.primed && ring.length > 0) {
				if (voice.primeSince === LONG_AGO) voice.primeSince = this.frames;
				if (this.primeFrames <= 1 || ring.length >= this.primeFrames * this.frameSamples || this.frames - voice.primeSince >= PRIME_TICKS) {
					voice.primed = true;
					voice.primeSince = LONG_AGO;
				}
			}
			let n = voice.primed && ring.length > 0 ? ring.read(buf, this.frameSamples) : 0;
			if (n > 0) {
				voice.concealed = 0;
			} else if (ring.length === 0) {
				// Ran dry. At a spurt's end that is the end; the next spurt is read from its second frame again.
				if (voice.primed && !voice.wasSpeaking) voice.primed = false;
				if ((voice.wasSpeaking || voice.loud > 0) && this.frames - voice.audioAt <= this.jitterFrames) {
					// Mid-word and nothing arrived: a packet late or lost. The decoder's guess goes out in its
					// place, a few frames at most; after that the silence is real.
					this.stats.holes++;
					if (voice.concealed < this.concealFrames) {
						const fill = this._conceal(id);
						if (fill) {
							n = Math.min(fill.length, this.frameSamples);
							buf.set(fill.subarray(0, n));
							voice.concealed++;
							this.stats.concealed++;
						}
					}
				}
			}
			// The adaptive detector measures the peak in the same pass as the energy.
			let peak = 0;
			let db = -Infinity;
			if (n > 0 && voice.vad) {
				db = voice.vad.measure(buf, n);
				peak = voice.vad.peak;
			} else if (n > 0) {
				peak = peakOf(buf, n);
			}
			const strong = this._note(voice, peak, db);
			const speaking = this._speaking(voice);
			if (speaking && !voice.wasSpeaking) voice.runStart = this.frames; // the queue for the floor is by this
			voice.wasSpeaking = speaking;
			if (n > 0) {
				// Kept whether or not it is sent: the pre-roll if the floor passes to them (see _takeFloor).
				voice.recent.push(buf.slice(0, n));
				if (voice.recent.length > this.prerollFrames) voice.recent.shift();
			} else if (!speaking) {
				voice.recent.length = 0; // gone quiet: what they said minutes ago is no onset of anything
			}
			frames.push({ id, buf, n, peak, strong, voice, speaking });
		}
		const speakingBut = (holder) => frames.filter((f) => f.speaking && f.id !== holder).map((f) => f.id);

		// 1) The priority speaker: while they talk only their audio goes out, at once, whoever else is
		//    talking. Nobody else's samples reach `out`, so the frame really does hold one voice.
		if (this.priorityId) {
			const own = frames.find((f) => f.id === this.priorityId);
			if (own && this._holdsFloor(own.voice)) {
				this._takeFloor(this.priorityId, speakingBut(this.priorityId).length > 0);
				const sent = this._emitFloor(out, own);
				return { pcm: out.subarray(0, sent * this.frameSamples), frames: sent, active: [this.priorityId], present: [this.priorityId], priority: true, others: speakingBut(this.priorityId) };
			}
		}

		// 2) Floor control: one voice at a time. The holder keeps the floor while they are mid-sentence; at
		//    their pause it goes to whoever has been speaking longest; a monologue past FLOOR_MAX_FRAMES can
		//    be taken by somebody who has been talking over it for BARGE_FRAMES.
		const speaking = frames.filter((f) => f.speaking).sort((a, b) => a.voice.runStart - b.voice.runStart || b.voice.energy - a.voice.energy);
		if (this.floorControl) {
			let holder = speaking.find((f) => f.id === this.floorId) ?? null;
			let takeover = false;
			if (holder && this.frames - this.floorSince >= this.floorMaxFrames) {
				const barger = speaking.find((f) => f.id !== holder.id && this.frames - f.voice.runStart >= this.bargeFrames);
				if (barger) {
					holder = barger;
					takeover = true;
				}
			}
			if (!holder && this.floorId !== null) {
				// The holder has stopped, but frames of theirs are still queued: they keep the floor until the
				// queue is empty, so nothing of theirs is lost to the handover.
				const draining = frames.find((f) => f.id === this.floorId);
				if (draining?.voice.pending.length) holder = draining;
			}
			if (!holder && speaking.length) holder = speaking[0];
			if (holder) {
				this._takeFloor(holder.id, takeover);
				const sent = this._emitFloor(out, holder);
				return { pcm: out.subarray(0, sent * this.frameSamples), frames: sent, active: [holder.id], present: [holder.id], priority: false, others: speakingBut(holder.id) };
			}
		}

		// 3) Nobody is speaking (under floor control), or the plain sum: everybody's audio, loudest first.
		//    Somebody murmuring under the speech bar is still in the sound and still listed as present.
		this.floorId = null;
		const present = [];
		const heard = [];
		for (const f of frames) {
			if (f.n > 0) {
				const gain = this._gain(f);
				mixInto(out, f.buf, f.n, gain);
				// Present as it goes out, after the gain (see PRESENCE_DB). The peak is known already; the energy
				// costs one more pass over the frame, and only for a frame the peak did not settle.
				if (f.peak * gain > this.presencePeak || rmsOf(f.buf, f.n) * gain >= this.presenceRms) present.push(f.id);
			}
			if (f.speaking) heard.push({ id: f.id, energy: f.voice.energy });
		}
		heard.sort((a, b) => b.energy - a.energy);
		return { pcm: out.subarray(0, this.frameSamples), frames: 1, active: heard.map((entry) => entry.id), present, priority: false, others: [] };
	}
}

/**
 * Output buffer for the model / local TTS voice. The default is 30 s: local TTS pushes a whole
 * sentence in one go, so the old 2 s capacity swallowed the start of sentences. On overflow the
 * oldest samples are still the ones dropped.
 */
export class PlaybackQueue {
	constructor({ maxFrames = 1500, frameSamples = SAMPLES_PER_FRAME_24K } = {}) {
		this.frameSamples = frameSamples;
		this.cap = maxFrames * frameSamples;
		this.ring = new Ring(this.cap);
	}

	push(samples) {
		this.ring.push(samples);
	}

	read(dst, max = dst.length) {
		return this.ring.read(dst, max);
	}

	get length() {
		return this.ring.length;
	}

	/** How many more samples fit in the queue (used for local TTS backpressure). */
	get free() {
		return this.ring.free;
	}

	/** Duration of the audio sitting in the queue (ms). */
	get durationMs() {
		return (this.ring.length / this.frameSamples) * FRAME_MS;
	}

	clear() {
		this.ring.clear();
	}
}
