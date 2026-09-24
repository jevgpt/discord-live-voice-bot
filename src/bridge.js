// The 20 ms audio bridge between Discord and the Live session.
//
// One tick does three things:
//   1. mixer -> model : every tick sends one 20 ms frame (silence included) so the
//                       Live input stream stays continuous, as the API expects.
//   2. model -> Discord: drains the playback queue (model voice or local TTS) into 48 kHz stereo.
//   3. music -> Discord: mixes the music player's frame underneath, ducked while the bot speaks.

import {
	FRAME_MS,
	SAMPLES_PER_FRAME_24K,
	STEREO_SAMPLES_PER_FRAME_48K,
	mixInto,
	upsampleMono24kToStereo48k,
} from './audio.js';
import { t } from './i18n/index.js';
import { Ducker } from './music.js';

const JITTER_FRAMES = 4; // ~80 ms of pre-buffered model audio before playback starts
const SILENCE = Buffer.alloc(STEREO_SAMPLES_PER_FRAME_48K * 2); // shared; the stream never mutates it
// A wake this late means the event loop was blocked, and the packets that arrived meanwhile are still in
// the poll phase, behind this timer: bursting now would send empty ticks and then find the rings full.
// One setImmediate lets the poll phase deliver them first.
const LATE_WAKE_MS = 2 * FRAME_MS;
// The far end's buffer is given a lead of silence at the start of every session (and after a realign).
// If it places each chunk at its arrival when its buffer is empty and never trims, every late chunk of
// ours becomes padding in its timeline -- a mechanism that fits the drift the transcript's clock shows.
// A lead is slack against that: lateness up to its length pads nothing. Harmless if the far end does not
// pad; the attribution counts the frames like any others.
const LEAD_FRAMES = 5;
const LEAD_SILENCE = new Int16Array(SAMPLES_PER_FRAME_24K);

export class AudioBridge {
	constructor({
		mixer,
		playback,
		output,
		getLive,
		music = null,
		ducker = null,
		debug = false,
		log = () => {},
		onFrame = null,
		onOutputDead = null,
		clock = () => performance.now(),
	}) {
		this.clock = clock; // monotonic: a system clock step neither parks the loop nor bursts it
		this.mixer = mixer;
		this.playback = playback;
		this.output = output;
		this.getLive = getLive;
		this.music = music;
		this.ducker = ducker ?? new Ducker();
		this.debug = debug;
		this.log = log;
		this.onFrame = onFrame;
		this.onOutputDead = onOutputDead; // asked on every tick the output is dead; the owner builds a new one

		this.frameBuf = new Int16Array(SAMPLES_PER_FRAME_24K);
		this.voiceOut = new Int16Array(STEREO_SAMPLES_PER_FRAME_48K);
		this.musicOut = new Int16Array(STEREO_SAMPLES_PER_FRAME_48K);
		this.upState = { last: 0 };
		this.primed = false;
		this.backpressure = false;
		this.dropped = 0; // every frame ever dropped (the panel reads this)
		this.dropRun = 0; // frames dropped in the stall going on right now
		this.nextAt = 0;
		this.timer = null;
		this.immediate = null; // a late wake's catch-up, waiting behind the poll phase (see LATE_WAKE_MS)
		this.lastActive = '';
		// How the 20 ms loop is keeping time: frames the model took, the wall clock those spanned (gaps
		// of a second or more, a reconnect, left out), the latest a tick ever ran, and how often the loop
		// had to run more than one tick to catch up. sent * 20 ms against sentSpanMs is the test of whether
		// this side sends audio at the rate of the clock; the transcript's drift is measured against it.
		this.stats = { ticks: 0, sent: 0, extra: 0, lead: 0, sentSpanMs: 0, lastSentAt: 0, wakes: 0, lateMsTotal: 0, maxLateMs: 0, bursts: 0, realigns: 0, padMs: 0 };
		this.padEnd = 0; // the far end's buffer end, in our clock, under the padding model (see LEAD_FRAMES)
		this.leadDue = true; // the lead goes out on the first ready tick, and again after the session was not ready
		this.gen = 0; // start() generation, so a deferred run after stop() does nothing
	}

	/** Audio sent per wall-clock second, as a ratio (1 = exactly real time); null until there is enough of it. */
	get sentRatio() {
		if (this.stats.sentSpanMs < 1000) return null;
		return (this.stats.sent * FRAME_MS) / this.stats.sentSpanMs;
	}

	/** Under the padding model, the silence the far end would have added per second of ours, in ms; null until known. */
	get padRate() {
		if (this.stats.sentSpanMs < 1000) return null;
		return (this.stats.padMs / this.stats.sentSpanMs) * 1000;
	}

	/** How late the loop wakes on average, in ms. */
	get avgLateMs() {
		return this.stats.wakes ? this.stats.lateMsTotal / this.stats.wakes : 0;
	}

	/** One send noted: the clock it spanned, the frames it carried, and what the padding model makes of its timing. */
	noteSent(frames, lead = false) {
		const now = this.clock();
		if (!lead) {
			const gap = now - this.stats.lastSentAt;
			if (this.stats.sent > 0 && gap < 1000) this.stats.sentSpanMs += gap;
			this.stats.lastSentAt = now;
			this.stats.sent++;
			if (frames > 1) this.stats.extra += frames - 1;
		}
		if (!this.padEnd || now - this.padEnd >= 1000) this.padEnd = now; // a second's gap is a reconnect, not padding
		if (now > this.padEnd) {
			this.stats.padMs += now - this.padEnd;
			this.padEnd = now;
		}
		this.padEnd += frames * FRAME_MS;
	}

	/** The lead of silence: on the first ready tick, and again whenever the session comes back. */
	sendLead(live) {
		this.leadDue = false;
		for (let i = 0; i < LEAD_FRAMES; i++) {
			if (!live.sendAudio(LEAD_SILENCE)) return;
			this.stats.lead++;
			this.noteSent(1, true);
			this.onFrame?.({ priority: false, active: [], present: [], others: [], sent: true, frames: 1, pcm: LEAD_SILENCE, lead: true });
		}
	}

	get running() {
		return this.timer !== null;
	}

	/**
	 * Point at a fresh output. The old one is gone -- a voice reconnect destroys it -- and everything the
	 * bridge remembered about it (that it was blocked, how much had been dropped while it was) belongs to
	 * that dead stream, not to this one.
	 */
	setOutput(output) {
		this.output = output;
		this.backpressure = false;
		this.dropRun = 0;
	}

	/**
	 * Is the output finished? A destroyed stream takes every write without a word: write() returns false,
	 * and neither 'error' nor 'drain' ever follows. The player tears its input down when it goes idle
	 * (100 ms without a packet); that raises one 'error' (a premature close) and then nothing ever again,
	 * so a renewal that had to wait was, until this check, never asked for a second time.
	 */
	get outputDead() {
		return this.output?.destroyed === true || this.output?.writable === false;
	}

	/** Runs exactly one 20 ms step. Returns what happened (used by tests). */
	tick() {
		const { pcm, active, present, priority, others, frames = 1 } = this.mixer.tick();
		const live = this.getLive();
		if (!live?.ready) this.leadDue = true;
		else if (this.leadDue) this.sendLead(live);
		const sent = Boolean(live?.ready && live.sendAudio(pcm));
		this.stats.ticks++;
		if (sent) this.noteSent(frames);
		this.onFrame?.({ priority, active, present, others, sent, frames, pcm });
		// The "who is speaking" debug line is printed by the session (GuildSession.logSpeaking), which can
		// turn an id into a name; the bridge cannot, and printing raw ids here was most of the debug log.

		// --- bot voice (model or local TTS) ---
		if (!this.primed && this.playback.length >= SAMPLES_PER_FRAME_24K * JITTER_FRAMES) this.primed = true;
		let voice = false;
		if (this.primed) {
			const n = this.playback.read(this.frameBuf, SAMPLES_PER_FRAME_24K);
			if (n > 0) {
				// Partial frame (the queue is running dry): pad it with zeros and play it so the last ~19 ms is not lost.
				if (n < SAMPLES_PER_FRAME_24K) this.frameBuf.fill(0, n);
				upsampleMono24kToStereo48k(this.frameBuf, this.upState, this.voiceOut);
				voice = true;
				if (n < SAMPLES_PER_FRAME_24K) this.primed = false;
			} else {
				this.primed = false;
			}
		}

		// --- music (ducked while the bot is speaking) ---
		let musicPlayed = false;
		let gain = 1;
		if (this.music?.active) {
			const n = this.music.readFrame(this.musicOut, STEREO_SAMPLES_PER_FRAME_48K);
			if (typeof this.music.duckRatio === 'number') this.ducker.duck = this.music.duckRatio;
			gain = this.ducker.tick(voice);
			if (n > 0) {
				musicPlayed = true;
				if (!voice) this.voiceOut.fill(0);
				mixInto(this.voiceOut, this.musicOut, STEREO_SAMPLES_PER_FRAME_48K, gain * this.music.volume);
			}
		} else if (this.ducker.gain !== 1) {
			this.ducker.reset();
		}

		const frame = voice || musicPlayed ? Buffer.from(this.voiceOut.buffer, this.voiceOut.byteOffset, this.voiceOut.byteLength) : null;

		// A dead output is replaced, not waited on: written to, it latched the backpressure below for good,
		// since the 'drain' that clears it never comes, and the bot was silent until the next reconnect.
		// Asked on every tick it stays dead, because the owner may have to put the renewal off for a while.
		if (this.outputDead) this.onOutputDead?.();

		// If the consumer stalled (Discord reconnecting, player idle) drop frames instead of
		// buffering stale audio forever; 'drain' resumes the flow.
		if (this.backpressure || this.outputDead) {
			this.dropped++;
			this.dropRun++;
		} else {
			// PassThrough keeps a view onto the buffer it is given: hand it a copy of the shared buffer.
			const output = this.output;
			const ok = output.write(frame ? Buffer.from(frame) : SILENCE);
			if (!ok) {
				this.backpressure = true;
				output.once('drain', () => {
					// A stream that has since been replaced says nothing about the one written to now.
					if (this.output !== output) return;
					this.backpressure = false;
					// Reported per stall, with how much speech it cost. A running total said "501 frames
					// dropped" hours into a session and read as a ten second outage that had never happened.
					if (this.dropRun > 0) {
						this.log(t('voice.output_blocked', { count: this.dropRun, ms: this.dropRun * FRAME_MS }));
						this.dropRun = 0;
					}
				});
			}
		}
		return { active, sent, played: voice, music: musicPlayed, gain, dropped: this.dropped, priority };
	}

	start() {
		if (this.timer) return;
		const gen = ++this.gen;
		this.nextAt = this.clock();
		const run = () => {
			this.immediate = null;
			if (gen !== this.gen) return;
			const now = this.clock();
			let ran = 0;
			while (this.nextAt <= now) {
				this.tick();
				this.nextAt += FRAME_MS;
				ran++;
			}
			if (ran > 1) this.stats.bursts++;
			this.timer = setTimeout(loop, Math.max(0, this.nextAt - this.clock()));
		};
		const loop = () => {
			if (gen !== this.gen) return;
			const now = this.clock();
			const late = now - this.nextAt;
			this.stats.wakes++;
			if (late > 0) this.stats.lateMsTotal += late;
			if (late > this.stats.maxLateMs) this.stats.maxLateMs = late;
			if (late > 1000) {
				// Long pause (GC, sleep, a blocked event loop): do not burst out the missed frames, realign instead.
				this.nextAt = now;
				this.stats.realigns++;
				this.leadDue = true; // the far end's slack is spent; a fresh lead
			} else if (late >= LATE_WAKE_MS) {
				// The packets that arrived during the stall are behind this timer: let them in, then catch up.
				this.immediate = setImmediate(run);
				return;
			}
			run();
		};
		// One chain: every wake arms exactly the next one. This used to arm a timer here as well as run the
		// first wake at once, and the first wake armed its own: two chains from then on, the second waking
		// for nothing (the nextAt check kept it from ticking) but counted all the same, so the health
		// report's wakes and average lateness described a loop waking twice as often as it ticked.
		loop();
	}

	stop() {
		this.gen++;
		if (this.timer) clearTimeout(this.timer);
		if (this.immediate) clearImmediate(this.immediate);
		this.timer = null;
		this.immediate = null;
		this.primed = false;
		this.backpressure = false;
	}
}
