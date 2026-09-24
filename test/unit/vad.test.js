import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { NoiseFloor, SAMPLES_PER_FRAME_24K, SpeakerMixer, VAD_TUNING } from '../../src/audio.js';
import { SpeakerAttribution } from '../../src/attribution.js';
import { add, detect, fan, hiss, rng, scenarios, score, speech, toFrames } from '../../bench/vad-signals.mjs';

// The per-person voice detector (VAD=adaptive). A fixed peak bar for every microphone heard a quiet
// speaker on 71% of their speech and a desk fan on all of its frames; these are the promises the
// detector that replaces it makes, and the rooms of bench/vad.mjs, shortened, as a check that it keeps
// making them.

const N = SAMPLES_PER_FRAME_24K;
const amplitude = (db) => 32768 * 10 ** (db / 20);

/** White noise at `db` dBFS RMS, one frame at a time, from a fixed seed. */
function noiseSource(seed = 1) {
	const r = rng(seed);
	return (db) => Int16Array.from({ length: N }, () => Math.round(r.gauss() * amplitude(db)));
}

/** A 1 kHz tone at `db` dBFS RMS, continuous across frames (the high-pass leaves 1 kHz alone). */
function toneSource() {
	let phase = 0;
	return (db) =>
		Int16Array.from({ length: N }, () => {
			phase += (2 * Math.PI * 1000) / 24000;
			return Math.round(Math.sin(phase) * amplitude(db) * Math.SQRT2);
		});
}

const adaptive = (options = {}) => new SpeakerMixer({ vad: 'adaptive', ...options });

describe('the noise floor', () => {
	it('sits at the level of the room, falls at once, and rises within its window', () => {
		const noise = noiseSource();
		const floor = new NoiseFloor();
		const feed = (db, frames) => {
			for (let i = 0; i < frames; i++) floor.track(floor.measure(noise(db), N));
		};
		feed(-60, 100);
		assert.ok(floor.floor > -62 && floor.floor < -59.5, `a -60 dBFS room: ${floor.floor.toFixed(1)}`);
		feed(-70, 1);
		assert.ok(floor.floor < -69, `one quieter frame takes it down at once: ${floor.floor.toFixed(1)}`);

		// A louder sound that keeps moving (not a steady one: see the next test) takes the whole window.
		const tone = toneSource();
		const moving = (frames) => {
			for (let i = 0; i < frames; i++) floor.track(floor.measure(tone(i % 2 ? -50 : -40), N));
		};
		moving(70);
		assert.ok(floor.floor < -69, `1.4 s later the quiet frame is still in the window: ${floor.floor.toFixed(1)}`);
		moving(30);
		assert.ok(floor.floor > -51, `after 2 s the window holds only the louder sound: ${floor.floor.toFixed(1)}`);
	});

	it('is lifted at once to a sound that holds steady above it', () => {
		const noise = noiseSource(2);
		const floor = new NoiseFloor();
		for (let i = 0; i < 100; i++) floor.track(floor.measure(noise(-70), N));
		const before = floor.floor;
		let lifted = -1;
		for (let i = 0; i < 40 && lifted < 0; i++) {
			floor.track(floor.measure(noise(-45), N));
			if (floor.floor > -47) lifted = i + 1;
		}
		assert.ok(before < -69);
		assert.equal(lifted, VAD_TUNING.steadyFrames, `lifted after ${VAD_TUNING.steadyFrames} steady frames, not after the 1.6 s window`);
	});

	it('is kept per person, and reported with the bar it sets', () => {
		const m = adaptive({ agc: true });
		const quiet = noiseSource(3);
		const loud = noiseSource(4);
		for (let i = 0; i < 120; i++) {
			m.push('a', quiet(-72));
			m.push('b', loud(-45));
			m.tick();
		}
		const levels = Object.fromEntries(m.levels().map((entry) => [entry.id, entry]));
		assert.ok(levels.a.floorDb <= -71 && levels.a.floorDb >= -74, `a's floor: ${levels.a.floorDb}`);
		assert.equal(levels.a.thresholdDb, VAD_TUNING.minOnsetDb, 'a quiet room is judged by the absolute bar');
		assert.ok(levels.b.floorDb >= -47 && levels.b.floorDb <= -44, `b's floor: ${levels.b.floorDb}`);
		assert.equal(levels.b.thresholdDb, levels.b.floorDb + VAD_TUNING.onsetDb);
		assert.equal(levels.a.levelDb, null, 'nobody spoke, so the AGC has measured no speech level');
	});
});

describe('the adaptive detector: onset, hold and release', () => {
	// A quiet room: the floor is near -70, so the bars are the absolute ones, -55 to start, -60 to keep.
	const room = () => {
		const m = adaptive();
		const noise = noiseSource(5);
		for (let i = 0; i < 100; i++) {
			m.push('a', noise(-70));
			m.tick();
		}
		return { m, noise };
	};
	const speaking = (m, frame) => {
		m.push('a', frame);
		return m.tick().active.includes('a');
	};

	it('needs two frames above the bar to start: one is a click, not a speaker', () => {
		const { m, noise } = room();
		const tone = toneSource();
		assert.equal(speaking(m, tone(-40)), false, 'one frame');
		assert.equal(speaking(m, noise(-70)), false);
		assert.equal(speaking(m, tone(-40)), false);
		assert.equal(speaking(m, tone(-40)), true, 'the second in a row');
	});

	it('keeps a turn going on a word s tail between the two bars, then holds it for 200 ms', () => {
		const { m, noise } = room();
		const tone = toneSource();
		speaking(m, tone(-40));
		assert.equal(speaking(m, tone(-40)), true);
		// Under the bar to start (-55), over the bar to keep going (-60), and moving by 4 dB, so that it is
		// not taken for a steady sound that the floor should rise to.
		for (let i = 0; i < 30; i++) assert.equal(speaking(m, tone(i % 2 ? -55.5 : -59.5)), true, `tail frame ${i}`);
		const after = [];
		for (let i = 0; i < 12; i++) after.push(speaking(m, noise(-70)));
		assert.deepEqual(after.slice(0, 10), Array(10).fill(true), 'the hold: 200 ms of room after the last frame over the lower bar');
		assert.equal(after[10], false, 'and then it is over');
	});

	it('does not let the lower bar start a turn', () => {
		const { m } = room();
		const tone = toneSource();
		for (let i = 0; i < 12; i++) assert.equal(speaking(m, tone(i % 2 ? -55.5 : -59.5)), false);
	});

	it('does not take a key click for a voice, however loud', () => {
		const { m, noise } = room();
		const r = rng(9);
		for (let k = 0; k < 20; k++) {
			// A click: 2 ms of decaying noise, peaking around -10 dBFS, straddling two frames, over the room.
			const click = new Int16Array(2 * N);
			click.set(noise(-70), 0);
			click.set(noise(-70), N);
			for (let i = N - 30; i < click.length; i++) click[i] += Math.round(r.gauss() * 10000 * Math.exp(-(i - N + 30) / 48));
			assert.equal(speaking(m, click.subarray(0, N)), false);
			assert.equal(speaking(m, click.subarray(N)), false, `click ${k}`);
			for (let i = 0; i < 4; i++) speaking(m, noise(-70));
		}
	});
});

describe('the absolute floor', () => {
	it('never counts digital silence, and silence does not become the floor', () => {
		const m = adaptive();
		for (let i = 0; i < 100; i++) {
			m.push('a', new Int16Array(N));
			assert.deepEqual(m.tick().active, []);
		}
		assert.equal(m.voices.get('a').vad.floor, VAD_TUNING.initialFloorDb, 'Discord s silence frames say nothing about the room');
		assert.deepEqual(m.levels(), [], 'and there is no floor to report');
	});

	it('does not call a breath on a near-silent microphone speech, and does call a quiet voice', () => {
		const m = adaptive();
		const noise = noiseSource(6);
		for (let i = 0; i < 100; i++) {
			m.push('a', noise(-78));
			m.tick();
		}
		assert.ok(m.voices.get('a').vad.floor < -76, 'the floor is the hiss of a noise-suppressed microphone');
		for (let i = 0; i < 20; i++) {
			m.push('a', noise(-62)); // 16 dB over that floor, and still under -55
			assert.deepEqual(m.tick().active, [], `breath frame ${i}`);
		}
		const tone = toneSource();
		let heard = false;
		for (let i = 0; i < 4; i++) {
			m.push('a', tone(i % 2 ? -50 : -52));
			heard = m.tick().active.includes('a');
		}
		assert.equal(heard, true, 'a voice at -50 dBFS is a voice');
	});
});

describe('the rooms: adaptive against the peak bar', () => {
	const SECONDS = 20;
	const run = (name, mode) => {
		const room = scenarios().find((entry) => entry.name === name);
		const built = room.build(SECONDS);
		return score(built.truth, detect(SpeakerMixer, toFrames(built.x), { vad: mode }), { utterances: built.utterances });
	};

	it('hears a quiet speaker the peak bar mostly missed', () => {
		const quietPeak = run('quiet speaker, quiet room (-42)', 'peak');
		const quiet = run('quiet speaker, quiet room (-42)', 'adaptive');
		assert.ok(quietPeak.recall < 0.8, `the baseline: ${quietPeak.recall}`);
		assert.ok(quiet.recall > 0.9, `adaptive: ${quiet.recall}`);
		assert.equal(quiet.falseRate, 0);
		assert.ok(quiet.onset <= quietPeak.onset, 'and hears it no later');
		const faint = run('very quiet speaker (-48)', 'adaptive');
		assert.ok(faint.recall > 0.75 && faint.missed === 0, `-48 dBFS: ${faint.recall}`);
	});

	it('is not worse than the peak bar for a loud or a normal speaker', () => {
		for (const name of ['loud speaker, quiet room (-18 dBFS)', 'normal speaker, quiet room (-30)']) {
			const peak = run(name, 'peak');
			const own = run(name, 'adaptive');
			assert.ok(own.recall >= peak.recall - 0.02, `${name}: recall ${own.recall} against ${peak.recall}`);
			assert.ok(own.onset <= peak.onset + 2, `${name}: onset ${own.onset} against ${peak.onset}`);
			assert.ok(own.chops <= peak.chops, `${name}: chops ${own.chops} against ${peak.chops}`);
			assert.equal(own.falseRate, 0);
		}
	});

	it('does not call a fan, a hum, music or typing speech, where the peak bar called most of it speech', () => {
		for (const [name, limit] of [
			['fan alone (-40)', 0.03],
			['mains hum alone (-40)', 0.03],
			['music bleed alone (-35)', 0.05],
			['typing alone (clicks at -20 peak)', 0.02],
			['silence (digital zero)', 0],
		]) {
			const own = run(name, 'adaptive');
			const peak = run(name, 'peak');
			assert.ok(own.falseRate <= limit, `${name}: ${own.falseRate}`);
			assert.ok(own.falseRate <= peak.falseRate, `${name}: no worse than the peak bar (${peak.falseRate})`);
		}
		assert.ok(run('fan alone (-40)', 'peak').falseRate > 0.9, 'the baseline: a fan was a speaker');
	});

	it('hears a quiet speaker over a fan', () => {
		const own = run('quiet speaker + fan at -55', 'adaptive');
		const peak = run('quiet speaker + fan at -55', 'peak');
		assert.ok(own.recall > peak.recall + 0.1, `${own.recall} against ${peak.recall}`);
		assert.equal(own.falseRate, 0);
	});
});

describe('a fan that turns on mid-session', () => {
	it('is a speaker for half a second at most, and the person talking over it is still heard', () => {
		const seconds = 16;
		const quietThenFan = toFrames(add(hiss({ seconds, levelDb: -72, seed: 11 }), fan({ seconds, levelDb: -40, seed: 5 }), { from: 8 }));
		const own = detect(SpeakerMixer, quietThenFan, { vad: 'adaptive' });
		const peak = detect(SpeakerMixer, quietThenFan, { vad: 'peak' });
		const switched = 8 * 50;
		const called = own.reduce((sum, v) => sum + v, 0);
		assert.ok(called > 0, 'the moment it starts, it is new and loud');
		assert.ok(called <= 25, `called speech for ${called * 20} ms`);
		assert.equal(own.slice(0, switched).reduce((sum, v) => sum + v, 0), 0, 'nothing before it');
		assert.equal(own.slice(switched + 50).reduce((sum, v) => sum + v, 0), 0, 'nothing a second after it started');
		assert.ok(peak.slice(switched).reduce((sum, v) => sum + v, 0) > 0.95 * (quietThenFan.length - switched), 'the peak bar: speech until it is switched off');

		const talk = speech({ seconds, levelDb: -30, seed: 21 });
		const over = toFrames(add(talk.x, add(hiss({ seconds, levelDb: -72, seed: 11 }), fan({ seconds, levelDb: -40, seed: 5 }), { from: 8 })));
		const scored = score(talk.truth, detect(SpeakerMixer, over, { vad: 'adaptive' }), { utterances: talk.utterances });
		assert.ok(scored.recall > 0.9, `recall ${scored.recall}`);
		assert.ok(scored.falseRate < 0.05, `false ${scored.falseRate}`);
	});

	it('does not take the floor from somebody who is talking', () => {
		const seconds = 16;
		const talk = speech({ seconds, levelDb: -30, seed: 21 });
		const aFrames = toFrames(add(talk.x, hiss({ seconds, levelDb: -72, seed: 11 })));
		const bFrames = toFrames(add(hiss({ seconds, levelDb: -72, seed: 12 }), fan({ seconds, levelDb: -40, seed: 5 }), { from: 4 }));
		const sentAsA = (mode) => {
			const m = new SpeakerMixer({ vad: mode, floorControl: true, agc: true });
			let sent = 0;
			let spoken = 0;
			for (let i = 0; i < aFrames.length; i++) {
				m.push('a', aFrames[i]);
				m.push('b', bFrames[i]);
				const { active } = m.tick();
				if (talk.truth[i] && i >= 5 * 50) {
					spoken++;
					if (active[0] === 'a') sent++;
				}
			}
			return sent / spoken;
		};
		assert.ok(sentAsA('adaptive') > 0.9, `adaptive: ${sentAsA('adaptive')}`);
		assert.ok(sentAsA('peak') < 0.2, `the baseline, where the fan held the floor: ${sentAsA('peak')}`);
	});
});

describe('the owner s priority under the adaptive detector', () => {
	// The priority hold is 500 ms while the owner's packets arrive, and "arriving" there keeps the peak
	// test it always had: a quiet-room hiss counted as arriving held a guest's answer back by 440 ms.
	it('ends when it did under the peak bar, and the guest s answer is sent whole', () => {
		const seconds = 6;
		const owner = speech({ seconds, levelDb: -30, seed: 21, lead: 0.5 });
		const [[, end]] = owner.utterances;
		// The owner's first sentence, then their microphone goes on sending the room.
		const ownerX = hiss({ seconds, levelDb: -72, seed: 11 });
		for (let i = 0; i < (end + 1) * 480; i++) ownerX[i] += owner.x[i];
		const ownerFrames = toFrames(ownerX);
		const guestFrames = toFrames(add(speech({ seconds, levelDb: -30, seed: 33, lead: 0 }).x, hiss({ seconds, levelDb: -72, seed: 12 })));
		const answerAt = end + 4; // 80 ms after the owner's last word
		const run = (mode) => {
			const m = new SpeakerMixer({ vad: mode, floorControl: true });
			m.setPriority('o');
			let released = -1;
			let floor = -1;
			for (let i = 0; i < end + 60; i++) {
				m.push('o', ownerFrames[i]);
				if (i >= answerAt) m.push('g', guestFrames[i - answerAt]);
				const frame = m.tick();
				if (i > end && released < 0 && !frame.priority) released = i;
				if (floor < 0 && frame.active[0] === 'g') floor = i;
			}
			return { released, floor: floor - answerAt, backlog: m.voices.get('g').pending.length };
		};
		const peak = run('peak');
		const own = run('adaptive');
		assert.equal(own.released, peak.released, 'the priority is given up on the same frame');
		assert.ok(own.floor <= 10, `the guest has the floor within the owner s 200 ms hold: ${own.floor * 20} ms`);
		assert.equal(own.backlog, 0, 'and what they said while waiting has gone out');
	});
});

describe('presence under the adaptive detector', () => {
	// A murmur held steady lifts its owner's floor until it is no longer speech. It is still in the sound,
	// and the frame is not the other person's alone.
	it('still counts a steady murmur as being in the frame', () => {
		const m = adaptive();
		const attribution = new SpeakerAttribution({ ownerId: 'owner' });
		const owner = toneSource();
		const murmur = noiseSource(7);
		let frame = null;
		for (let i = 0; i < 60; i++) {
			m.push('owner', owner(i % 3 ? -25 : -32));
			m.push('attacker', murmur(-40));
			frame = m.tick();
			attribution.onFrame({ priority: frame.priority, active: frame.active, present: frame.present, sent: true });
		}
		assert.deepEqual(frame.active, ['owner'], 'the murmur is no longer called speech');
		assert.ok(frame.present.includes('attacker'), 'but it is in the sound');
		assert.equal(attribution.speakerAt(0, 1200), false);
	});
});

describe('the cost of the detector', () => {
	it('keeps a tick of ten people far inside the 20 ms frame', () => {
		const people = 10;
		const clips = Array.from({ length: people }, (_, k) => toFrames(add(speech({ seconds: 4, levelDb: -30 - k, seed: 50 + k, lead: 0.2 }).x, hiss({ seconds: 4, levelDb: -60, seed: 60 + k }))));
		const m = adaptive({ floorControl: true, agc: true });
		const times = [];
		for (let t = 0; t < 600; t++) {
			for (let k = 0; k < people; k++) m.push(`p${k}`, clips[k][(t + 13 * k) % clips[k].length]);
			const at = performance.now();
			m.tick();
			if (t >= 100) times.push(performance.now() - at);
		}
		times.sort((x, y) => x - y);
		const median = times[times.length >> 1];
		// Measured at about 0.07 ms (bench:vad); the bound leaves room for a slow CI machine.
		assert.ok(median < 2, `median tick with ten people: ${median.toFixed(3)} ms`);
	});
});

describe('VAD=peak', () => {
	it('is the constructor s default and has no floor to keep', () => {
		const m = new SpeakerMixer({ agc: true });
		assert.equal(m.adaptive, false);
		m.push('a', new Int16Array(N).fill(3000));
		m.push('a', new Int16Array(N).fill(3000));
		m.tick();
		assert.deepEqual(m.tick().active, ['a']);
		assert.equal(m.voices.get('a').vad, null);
		assert.equal(m.levels()[0].floorDb, null);
	});
});
