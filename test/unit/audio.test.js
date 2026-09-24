import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { PlaybackQueue, Ring, SAMPLES_PER_FRAME_24K, SpeakerMixer, STEREO_SAMPLES_PER_FRAME_48K, int16From, mixInto, peakOf, softClip } from '../../src/audio.js';
import { AudioBridge } from '../../src/bridge.js';
import { Ducker } from '../../src/music.js';
import { SpeakerAttribution } from '../../src/attribution.js';

const sink = () => {
	const written = [];
	const out = new Writable({
		write(chunk, _enc, cb) {
			written.push(chunk);
			cb();
		},
	});
	return { out, written };
};

describe('audio.js', () => {
	it('holds 30 s by default so a local TTS sentence fits in the playback queue', () => {
		const q = new PlaybackQueue();
		assert.equal(q.cap, 1500 * SAMPLES_PER_FRAME_24K);
		const sentence = new Int16Array(24_000 * 12).fill(1); // 12 s
		q.push(sentence);
		assert.equal(q.length, sentence.length, 'no sample may be dropped');
		assert.ok(q.free > 0);
	});

	it('rejects an invalid ring capacity', () => {
		assert.throws(() => new Ring(0));
	});

	it('drains the other speakers while the priority speaker is talking', () => {
		const m = new SpeakerMixer();
		m.setPriority('o');
		for (let i = 0; i < 5; i++) {
			m.push('o', new Int16Array(480).fill(1000));
			m.push('x', new Int16Array(480).fill(900));
			m.tick();
		}
		assert.equal(m.rings.get('x').length, 0, 'the other buffers must be emptied while the priority speaker talks');
	});

	// Live failure: four people in the channel, the owner speaks, and the line came back attributed to
	// whoever else had a microphone open. Two causes, both here: "somebody is speaking" was decided at a
	// peak of 50 (a fan, breathing, a keyboard), and the owner lost the floor on the first missing packet.
	it('does not mistake an open microphone for a speaker', () => {
		const m = new SpeakerMixer();
		const speech = new Int16Array(480).fill(3000);
		const roomNoise = new Int16Array(480).fill(120); // well above the old bar of 50, far below speech
		for (let i = 0; i < 10; i++) {
			m.push('speaker', speech);
			m.push('noisy', roomNoise);
			m.push('quiet', new Int16Array(480).fill(20));
			m.tick();
		}
		const { active } = m.tick();
		assert.deepEqual(active, ['speaker'], 'only the person actually speaking is on the list');
	});

	it('keeps the sentence with its speaker across the gaps between words', () => {
		const m = new SpeakerMixer();
		const speech = new Int16Array(480).fill(3000);
		const roomNoise = new Int16Array(480).fill(120);
		const seen = [];
		for (let i = 0; i < 40; i++) {
			// The speaker's packets arrive in bursts with 60 ms of jitter in between, which is what a
			// sentence really looks like coming out of Discord; the other microphone is open throughout.
			if (i % 6 < 3) m.push('speaker', speech);
			m.push('noisy', roomNoise);
			seen.push(m.tick().active[0] ?? null);
		}
		assert.deepEqual([...new Set(seen.slice(4))], ['speaker'], 'the floor must not change hands inside a sentence');
	});

	// A review finding: holding somebody in the list on "spoke recently" alone wrote a stale second name
	// onto the first fragment of the next person's turn, which is what made a handover read as an overlap.
	it('drops a speaker whose packets have stopped, without waiting out the whole hold', () => {
		const m = new SpeakerMixer();
		const speech = new Int16Array(480).fill(3000);
		for (let i = 0; i < 6; i++) {
			m.push('a', speech);
			m.tick();
		}
		assert.deepEqual(m.tick().active, ['a'], 'one frame without a packet is jitter');
		for (let i = 0; i < 5; i++) m.tick(); // 100 ms of nothing arriving at all
		assert.deepEqual(m.tick().active, [], 'a speaker who has stopped transmitting has stopped talking');
	});

	it('hands the room over once the speaker really stops', () => {
		const m = new SpeakerMixer();
		const speech = new Int16Array(480).fill(3000);
		for (let i = 0; i < 6; i++) {
			m.push('first', speech);
			m.tick();
		}
		for (let i = 0; i < 30; i++) m.tick(); // 600 ms of silence: past the half second that ends a turn
		for (let i = 0; i < 4; i++) {
			m.push('second', speech);
			m.tick();
		}
		assert.deepEqual(m.tick().active, ['second'], 'the next person to speak owns the line');
	});

	it('the priority speaker rides out packet jitter but gives the room back after a real pause', () => {
		const m = new SpeakerMixer();
		m.setPriority('o');
		const speech = new Int16Array(480).fill(3000);
		for (let i = 0; i < 4; i++) {
			m.push('o', speech);
			m.tick();
		}
		m.push('x', speech);
		assert.equal(m.tick().priority, true, '80 ms without a packet is jitter, not the end of the sentence');
		for (let i = 0; i < 30; i++) m.tick(); // the owner really has stopped
		let frame = null;
		for (let i = 0; i < 3; i++) {
			m.push('x', speech);
			frame = m.tick();
		}
		assert.equal(frame.priority, false, 'the room is handed back');
		assert.ok(frame.active.includes('x'), 'and the person now talking is the one on the line');
	});

	// The worst finding of the adversarial review, and it is an attack, not an accident: speak quietly
	// enough to stay under the speech bar and your voice is still summed into the frame the model
	// transcribes, while the frame is recorded as holding one person, alone. Your words then land under
	// their name, with their authority.
	it('counts a voice too quiet to be called speech as being in the frame all the same', () => {
		const m = new SpeakerMixer();
		const speech = new Int16Array(480).fill(3000);
		const murmur = new Int16Array(480).fill(260); // above "there is real sound here", below speech
		let frame = null;
		for (let i = 0; i < 6; i++) {
			m.push('owner', speech);
			m.push('attacker', murmur);
			frame = m.tick();
		}
		assert.deepEqual(frame.active, ['owner'], 'only one of them is speaking');
		assert.deepEqual(frame.present.sort(), ['attacker', 'owner'], 'but both of them are in the sound');
	});

	it('does not let a murmur under the speech bar open the owner gate', () => {
		const m = new SpeakerMixer();
		const attribution = new SpeakerAttribution({ ownerId: 'owner' });
		const speech = new Int16Array(480).fill(3000);
		const murmur = new Int16Array(480).fill(260);
		for (let i = 0; i < 40; i++) {
			m.push('owner', speech);
			m.push('attacker', murmur);
			const frame = m.tick();
			attribution.onFrame({ priority: frame.priority, active: frame.active, present: frame.present, sent: true });
		}
		assert.equal(attribution.speakerAt(0, 800), false, 'a frame with two voices in it cannot say whose word it was');
		assert.equal(attribution.noteTranscript('ban dana', { startMs: 0, endMs: 800 }).owner, false);

		// The same run of frames with nobody murmuring does open it, so the test is about the murmur.
		const clean = new SpeakerMixer();
		const alone = new SpeakerAttribution({ ownerId: 'owner' });
		for (let i = 0; i < 40; i++) {
			clean.push('owner', speech);
			const frame = clean.tick();
			alone.onFrame({ priority: frame.priority, active: frame.active, present: frame.present, sent: true });
		}
		assert.equal(alone.speakerAt(0, 800), true);
	});

	it('reports the absolute peak and clips the mix at the int16 ceiling', () => {
		assert.equal(peakOf(new Int16Array([1, -7, 3])), 7);
		const out = new Int16Array([30000, 0]);
		mixInto(out, new Int16Array([10000, 100]), 2, 1);
		assert.deepEqual([...out], [32767, 100], 'clipped');
	});
});

describe('Ducker', () => {
	it('drops fast while someone speaks and recovers slowly after the hold', () => {
		const d = new Ducker({ duck: 0.1, holdMs: 100, frameMs: 20 });
		d.tick(true);
		d.tick(true);
		const ducked = d.tick(true);
		assert.ok(ducked < 0.5, `should fall fast: ${ducked}`);
		for (let i = 0; i < 5; i++) d.tick(false); // hold
		const held = d.gain;
		assert.ok(held <= 0.25, `should stay low during the hold: ${held}`);
		for (let i = 0; i < 200; i++) d.tick(false);
		assert.equal(d.gain, 1, 'returns to normal in the end');
	});
});

describe('AudioBridge', () => {
	it('mixes music with the bot voice and ducks it while the bot speaks', () => {
		const { out, written } = sink();
		const music = { active: true, volume: 0.5, duckRatio: 0.2, readFrame: (dst, n) => (dst.fill(2000, 0, n), n) };
		const playback = new PlaybackQueue();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback, output: out, getLive: () => null, music });
		let r = bridge.tick();
		assert.equal(r.music, true);
		assert.equal(r.played, false);
		assert.equal(written.at(-1).readInt16LE(0), 1000, 'music only: 2000 x 0.5');

		playback.push(new Int16Array(SAMPLES_PER_FRAME_24K * 5).fill(10000));
		r = bridge.tick();
		assert.equal(r.played, true);
		assert.ok(r.gain < 1, 'the gain drops while the bot speaks');
		const sample = written.at(-1).readInt16LE(0);
		assert.ok(sample > 5000 && sample < 6000, `voice + ducked music: ${sample}`);
		assert.equal(written.at(-1).length, STEREO_SAMPLES_PER_FRAME_48K * 2);
	});

	it('pads a partial frame with zeros and plays it, so the last 19 ms are not lost', () => {
		const { out } = sink();
		const playback = new PlaybackQueue();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback, output: out, getLive: () => null });
		playback.push(new Int16Array(SAMPLES_PER_FRAME_24K * 4 + 100).fill(500));
		const results = [];
		for (let i = 0; i < 6; i++) results.push(bridge.tick().played);
		assert.deepEqual(results, [true, true, true, true, true, false], 'the 5th frame is partial but still played');
	});

	// Live failure: the voice connection dropped with code 4014, came back a second later, and the bot was
	// silent for the rest of the session while transcription and speech generation both kept reporting
	// success. A PassThrough that has errored is finished; every later write disappears.
	it('writes to a replacement output after the old one dies', () => {
		const first = sink();
		const playback = new PlaybackQueue();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback, output: first.out, getLive: () => null });
		playback.push(new Int16Array(SAMPLES_PER_FRAME_24K * 4).fill(500));
		bridge.tick();
		assert.equal(first.written.length, 1);

		const second = sink();
		bridge.setOutput(second.out);
		bridge.tick();
		assert.equal(first.written.length, 1, 'nothing more goes to the dead stream');
		assert.equal(second.written.length, 1, 'and the new one is spoken to');
	});

	it('forgets that the old output was blocked when it is replaced', async () => {
		const blocked = new Writable({
			highWaterMark: 1,
			write(_chunk, _enc, cb) {
				setTimeout(cb, 50);
			},
		});
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: blocked, getLive: () => null });
		bridge.tick(); // fills the queue
		assert.equal(bridge.tick().dropped, 1, 'the old stream is blocked');
		const fresh = sink();
		bridge.setOutput(fresh.out);
		bridge.tick();
		assert.equal(fresh.written.length, 1, 'the block belonged to the stream that is gone');
		bridge.stop();
	});

	// A review finding: start() armed a timer and also ran the first wake, which armed its own, so two
	// chains ran from then on. The second never ticked, but every wake of it was counted: 101 wakes for
	// 51 ticks in a second, and the health report's lateness averaged over both.
	it('runs one timer chain: one wake per tick, and nothing left armed after stop', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 0 });
		// Every timer the loop arms, kept until it fires or is cleared.
		const armed = new Set();
		const { setTimeout: arm, clearTimeout: disarm } = globalThis;
		globalThis.setTimeout = (fn, ms) => {
			const handle = arm(() => {
				armed.delete(handle);
				fn();
			}, ms);
			armed.add(handle);
			return handle;
		};
		globalThis.clearTimeout = (handle) => {
			armed.delete(handle);
			disarm(handle);
		};
		try {
			const out = { write: () => true, once: () => {} };
			const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => null, clock: () => Date.now() });
			bridge.start();
			for (let i = 0; i < 50; i++) t.mock.timers.tick(20);
			assert.equal(bridge.stats.ticks, 51, 'the first tick at once, then one every 20 ms');
			assert.equal(bridge.stats.wakes, 51, 'and the loop woke once for each of them');
			assert.equal(armed.size, 1, 'with one timer armed at a time');
			bridge.stop();
			assert.equal(bridge.running, false);
			assert.equal(armed.size, 0, 'and none once stopped');
			t.mock.timers.tick(1000);
			assert.equal(bridge.stats.ticks, 51, 'nothing ticks after stop');

			bridge.start();
			for (let i = 0; i < 10; i++) t.mock.timers.tick(20);
			assert.equal(bridge.stats.wakes - 51, bridge.stats.ticks - 51, 'a restart is one chain too');
			bridge.stop();
			assert.equal(armed.size, 0);
		} finally {
			globalThis.setTimeout = arm;
			globalThis.clearTimeout = disarm;
		}
	});

	it('cancels a late wake s catch-up on stop', async (t) => {
		// Only the clock and the timer are mocked: the catch-up goes through the real setImmediate.
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
		const out = { write: () => true, once: () => {} };
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => null, clock: () => Date.now() });
		bridge.start();
		t.mock.timers.tick(100); // the wake due at 20 ms runs 80 ms late and hands its catch-up to setImmediate
		assert.ok(bridge.immediate, 'the catch-up is waiting behind the poll phase');
		bridge.stop();
		assert.equal(bridge.immediate, null);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(bridge.stats.ticks, 1, 'and it never ran');
	});

	// A review finding, and the bot's voice was gone for the rest of the session: a destroyed stream takes
	// every write without an 'error' or a 'drain', so the latch held for good and every frame was dropped.
	it('asks for a new output on every tick the old one is dead, and writes to the new one', () => {
		const dead = new PassThrough();
		dead.on('error', () => {});
		dead.destroy();
		const fresh = sink();
		let asked = 0;
		let renew = false;
		const bridge = new AudioBridge({
			mixer: new SpeakerMixer(),
			playback: new PlaybackQueue(),
			output: dead,
			getLive: () => null,
			onOutputDead: () => {
				asked++;
				if (renew) bridge.setOutput(fresh.out);
			},
		});
		bridge.tick();
		bridge.tick();
		assert.equal(asked, 2, 'asked again on every tick, since the owner may have had to put it off');
		assert.equal(bridge.backpressure, false, 'a dead stream is not a blocked one: nothing latched');
		assert.equal(bridge.dropped, 2, 'the frames in between are dropped');
		renew = true;
		bridge.tick();
		assert.equal(asked, 3);
		assert.equal(fresh.written.length, 1, 'renewed inside the tick, and the frame went to the new stream');
		bridge.tick();
		assert.equal(asked, 3, 'a live output is not asked about');
		assert.equal(fresh.written.length, 2);
	});

	it('does not let a replaced stream s drain clear the new stream s block', async () => {
		const blocked = () =>
			new Writable({
				highWaterMark: 1,
				write(_chunk, _enc, cb) {
					setTimeout(cb, 20);
				},
			});
		const old = blocked();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: old, getLive: () => null });
		bridge.tick(); // old is full
		const next = blocked();
		bridge.setOutput(next);
		bridge.tick(); // next is full
		assert.equal(bridge.backpressure, true);
		await new Promise((resolve) => old.once('drain', resolve));
		assert.equal(bridge.backpressure, true, 'the old stream draining says nothing about the new one');
		await new Promise((resolve) => next.once('drain', resolve));
		assert.equal(bridge.backpressure, false);
	});

	it('does not burst through ticks after a long pause', () => {
		const { out } = sink();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => null });
		let ticks = 0;
		bridge.tick = () => {
			ticks++;
		};
		bridge.nextAt = Date.now() - 10_000; // 10 s behind
		const now = Date.now();
		// Run the loop logic from start() directly.
		if (now - bridge.nextAt > 1000) bridge.nextAt = now;
		while (bridge.nextAt <= now) {
			bridge.tick();
			bridge.nextAt += 20;
		}
		assert.ok(ticks <= 2, `should realign instead of running 500 frames: ${ticks}`);
	});
});

describe('floor control: one voice at a time', () => {
	const speech = (level) => new Int16Array(480).fill(level);

	it('sends only the floor holder while somebody talks over them', () => {
		const m = new SpeakerMixer({ floorControl: true });
		for (let i = 0; i < 10; i++) {
			m.push('a', speech(3000));
			m.tick();
		}
		let frame = null;
		for (let i = 0; i < 10; i++) {
			m.push('a', speech(3000));
			m.push('b', speech(2000));
			frame = m.tick();
		}
		assert.deepEqual(frame.active, ['a'], 'the floor is a s');
		assert.deepEqual(frame.others, ['b'], 'and b is on record as talking over it');
		assert.equal(frame.pcm[0], 3000, 'the frame holds a s audio, not the sum');
		assert.deepEqual(frame.present, ['a'], 'nobody else is in the sound');
	});

	it('passes the floor at the holder s pause to whoever has been waiting', () => {
		const m = new SpeakerMixer({ floorControl: true });
		for (let i = 0; i < 10; i++) {
			m.push('a', speech(3000));
			m.tick();
		}
		for (let i = 0; i < 10; i++) {
			m.push('a', speech(3000));
			m.push('b', speech(2000));
			assert.deepEqual(m.tick().active, ['a']);
		}
		let frame = null;
		for (let i = 0; i < 8; i++) {
			m.push('b', speech(2000)); // a has stopped sending
			frame = m.tick();
		}
		assert.deepEqual(frame.active, ['b'], 'b has been waiting and gets the floor');
		assert.equal(frame.pcm[0], 2000);
		assert.equal(m.floorTakeovers, 0, 'a pause is not a takeover');
	});

	it('lets a persistent interrupter take a long monologue, and never a short one', () => {
		const m = new SpeakerMixer({ floorControl: true });
		let at450 = null;
		let frame = null;
		for (let i = 0; i < 480; i++) {
			m.push('a', speech(3000));
			if (i >= 400) m.push('b', speech(2000));
			frame = m.tick();
			if (i === 450) at450 = frame.active;
		}
		assert.deepEqual(at450, ['a'], 'a second of interruption changes nothing');
		assert.deepEqual(frame.active, ['b'], 'after 1.5 s over an 8 s monologue the floor is taken');
		assert.equal(m.floorTakeovers, 1);

		const short = new SpeakerMixer({ floorControl: true });
		let last = null;
		for (let i = 0; i < 200; i++) {
			short.push('a', speech(3000));
			if (i >= 100) short.push('b', speech(2000));
			last = short.tick();
		}
		assert.deepEqual(last.active, ['a'], 'a four second turn is not a monologue');
	});

	it('gives the owner the floor at once, whoever holds it', () => {
		const m = new SpeakerMixer({ floorControl: true });
		m.setPriority('o');
		for (let i = 0; i < 10; i++) {
			m.push('b', speech(2000));
			m.tick();
		}
		let frame = null;
		for (let i = 0; i < 3; i++) {
			m.push('b', speech(2000));
			m.push('o', speech(3000));
			frame = m.tick();
		}
		assert.equal(frame.priority, true);
		assert.deepEqual(frame.active, ['o']);
		assert.deepEqual(frame.others, ['b']);
	});

	it('keeps a murmur out of the frame entirely, so the holder s words really are theirs alone', () => {
		const m = new SpeakerMixer({ floorControl: true });
		const attribution = new SpeakerAttribution({ ownerId: 'owner' });
		for (let i = 0; i < 40; i++) {
			m.push('owner', speech(3000));
			m.push('attacker', speech(260));
			const frame = m.tick();
			attribution.onFrame({ priority: frame.priority, active: frame.active, present: frame.present, sent: true });
		}
		assert.equal(attribution.speakerAt(0, 800), true, 'the murmur was never in the audio');
	});

	it('still sums everybody when nobody clears the speech bar', () => {
		const m = new SpeakerMixer({ floorControl: true });
		let frame = null;
		for (let i = 0; i < 6; i++) {
			m.push('a', speech(260));
			m.push('b', speech(260));
			frame = m.tick();
		}
		assert.deepEqual(frame.active, []);
		assert.deepEqual(frame.present.sort(), ['a', 'b']);
		assert.equal(frame.pcm[0], 520, 'the sum, as without floor control');
	});
});

describe('the frames a newcomer lost while somebody else held the floor', () => {
	const marker = (v) => new Int16Array(480).fill(v);

	// To a transcriber the onset of a word is the word: "adamsın" without its "a" came back as "ağlar
	// mısın". The frames discarded while the previous holder had the floor go out first, and the live
	// ones queue behind them until the speaker pauses.
	it('are sent first, in order, with nothing lost, and drain after they stop', () => {
		const m = new SpeakerMixer({ floorControl: true });
		for (let i = 0; i < 20; i++) {
			m.push('a', marker(3000));
			if (i >= 12) m.push('b', marker(2000 + i)); // b starts over a at frame 12
			m.tick();
		}
		// Every frame of every tick, in the order the model receives them.
		const framesOf = (frame) => Array.from({ length: frame.frames ?? 1 }, (_, k) => frame.pcm[k * 480]);
		const after = [];
		for (let i = 20; i < 40; i++) {
			m.push('b', marker(2000 + i)); // a has stopped sending
			const frame = m.tick();
			after.push({ who: frame.active[0] ?? null, frames: framesOf(frame) });
		}
		const first = after.findIndex((entry) => entry.who === 'b');
		assert.ok(first > 0 && first <= 7, `b gets the floor once the frames of a have stopped: ${first}`);
		const values = after.slice(first).flatMap((entry) => entry.frames);
		assert.ok(values[0] < 2000 + 20 + first, `the first thing sent is an earlier frame of b: ${values[0]}`);
		for (let i = 1; i < values.length; i++) assert.equal(values[i], values[i - 1] + 1, 'and nothing after it is lost or reordered');
		assert.ok(after.slice(first).some((entry) => entry.frames.length === 2), 'the backlog is paid back at two frames a tick');

		assert.equal(values[values.length - 1], 2039, 'down to the last frame they sent, while they were still sending');
		assert.equal(m.voices.get('b').pending.length, 0, 'nothing is left owed by then');
		let who = 'b';
		for (let i = 0; i < 16 && who !== null; i++) who = m.tick().active[0] ?? null; // b has stopped too
		assert.equal(who, null, 'and then the floor is free');
	});

	it('are paid back within their own length, so the next handover is not late', () => {
		const m = new SpeakerMixer({ floorControl: true });
		for (let i = 0; i < 30; i++) {
			m.push('a', marker(3000));
			if (i >= 10) m.push('b', marker(2000 + i)); // b talks over a from frame 10
			m.tick();
		}
		let handover = -1;
		let cleared = -1;
		for (let i = 30; i < 80; i++) {
			m.push('b', marker(2000 + i)); // a has stopped; b keeps talking
			const frame = m.tick();
			if (handover < 0 && frame.active[0] === 'b') handover = i;
			if (handover >= 0 && cleared < 0 && m.voices.get('b').pending.length === 0) cleared = i;
		}
		assert.ok(handover > 0, 'b got the floor');
		assert.ok(cleared - handover <= 18, `the backlog was gone within its own length: ${cleared - handover} ticks`);
		const frame = m.tick();
		assert.equal(frame.frames, 1, 'and b is live again, one frame a tick');
	});

	it('are not needed when the floor was free: the live frame goes straight out', () => {
		const m = new SpeakerMixer({ floorControl: true });
		let frame = null;
		for (let i = 0; i < 4; i++) {
			m.push('b', marker(2000 + i));
			frame = m.tick();
		}
		assert.equal(frame.pcm[0], 2003, 'nothing of theirs was ever discarded');
	});
});

describe('the decoder s buffer as samples', () => {
	it('copies, and copes with a buffer that starts at an odd byte', () => {
		const backing = Buffer.alloc(7);
		backing.writeInt16LE(-5, 1);
		backing.writeInt16LE(9, 3);
		const odd = backing.subarray(1, 6); // byteOffset 1, length 5: two samples and a stray byte
		assert.throws(() => new Int16Array(odd.buffer, odd.byteOffset, 2), 'a view would throw');
		const samples = int16From(odd);
		assert.deepEqual(Array.from(samples), [-5, 9]);
		backing.writeInt16LE(1, 1);
		assert.equal(samples[0], -5, 'a copy, not a view');
	});
});

describe('a ring that overflows', () => {
	it('says how many samples it threw away', () => {
		const ring = new Ring(10);
		assert.equal(ring.push(new Int16Array(6)), 0);
		assert.equal(ring.push(new Int16Array(6)), 2, 'two of the oldest went');
		assert.equal(ring.length, 10);
		assert.equal(ring.push(new Int16Array(25)), 25, 'a push larger than the ring keeps only its tail: all it held and the head of the push went');
	});

	it('is counted by the mixer in frames', () => {
		const m = new SpeakerMixer({ bufferFrames: 2 });
		for (let i = 0; i < 4; i++) m.push('a', new Int16Array(480).fill(100));
		assert.equal(m.stats.overflow, 2);
	});
});

describe('a packet that never arrived mid-sentence', () => {
	const marker = (v) => new Int16Array(480).fill(v);

	// 20 ms of nothing in the middle of a word is a click and a missing syllable to the transcriber. The
	// decoder's own guess at the frame (Opus packet loss concealment) goes out in its place, a few frames
	// at most; after that the gap is real.
	it('is filled by the decoder a few times, then the silence is real', () => {
		const m = new SpeakerMixer();
		let asked = 0;
		m.setConcealer('a', () => {
			asked++;
			return marker(1234);
		});
		for (let i = 0; i < 3; i++) {
			m.push('a', marker(3000));
			m.tick();
		}
		const holes = [];
		for (let i = 0; i < 5; i++) holes.push(m.tick().pcm[0]); // a's packets stop
		assert.deepEqual(holes, [1234, 1234, 1234, 0, 0], 'three the decoder made, then silence');
		assert.equal(asked, 3);
		assert.equal(m.stats.holes, 5, 'every one of them was a hole; only three were filled');
		assert.equal(m.stats.concealed, 3);
	});

	it('is not filled when they were not speaking', () => {
		const m = new SpeakerMixer();
		let asked = 0;
		m.setConcealer('a', () => {
			asked++;
			return marker(1234);
		});
		m.push('a', marker(100)); // below the speech bar
		m.tick();
		m.tick();
		assert.equal(asked, 0);
		assert.equal(m.stats.holes, 0);
	});

	it('goes out as silence when the decoder cannot help', () => {
		const m = new SpeakerMixer();
		m.setConcealer('a', () => {
			throw new Error('no');
		});
		for (let i = 0; i < 3; i++) {
			m.push('a', marker(3000));
			m.tick();
		}
		assert.equal(m.tick().pcm[0], 0);
		assert.equal(m.stats.holes, 1);
		assert.equal(m.stats.concealed, 0);
	});
});

describe('per-speaker loudness', () => {
	const sine = (amplitude) => Int16Array.from({ length: 480 }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 24000)));

	it('raises a quiet speaker over a second or so, no further than the cap', () => {
		const m = new SpeakerMixer({ agc: true });
		let last = null;
		for (let i = 0; i < 120; i++) {
			m.push('a', sine(500));
			last = m.tick();
		}
		const out = peakOf(last.pcm, 480);
		assert.ok(out > 2500 && out <= 4000, `500 in, about 8x out: ${out}`);
		const [level] = m.levels();
		assert.equal(level.id, 'a');
		assert.ok(level.levelDb < -35 && level.levelDb > -45, `their speech measured quiet: ${level.levelDb} dB`);
		assert.equal(level.gainDb, 18);
	});

	it('lowers a loud speaker within a few frames, no further than the floor', () => {
		const m = new SpeakerMixer({ agc: true });
		let last = null;
		for (let i = 0; i < 12; i++) {
			m.push('a', sine(20000));
			last = m.tick();
		}
		const out = peakOf(last.pcm, 480);
		assert.ok(out > 8000 && out < 12000, `20000 in, half out: ${out}`);
		assert.equal(m.levels()[0].gainDb, -6);
	});

	// A review finding: after a handover the newcomer's backlog keeps draining once they stop sending, and
	// those ticks have no frame of theirs, which the gain read as "unity". The tail of a shouted sentence
	// came out 6 dB louder than the rest of it.
	it('keeps the speaker s gain on the backlog that drains after they stop', () => {
		const m = new SpeakerMixer({ agc: true, floorControl: true });
		const peaks = [];
		for (let i = 0; i < 50; i++) {
			if (i < 20) m.push('a', new Int16Array(480).fill(3000));
			if (i >= 12 && i < 30) m.push('b', sine(20000)); // b talks over a, gets the floor, then stops at 30
			const frame = m.tick();
			if (frame.active[0] !== 'b') continue;
			for (let k = 0; k < frame.frames; k++) peaks.push({ tick: i, peak: peakOf(frame.pcm.subarray(k * 480, (k + 1) * 480)) });
		}
		const drained = peaks.filter((entry) => entry.tick >= 30);
		assert.ok(drained.length > 0, 'part of the backlog was still owed when b stopped');
		assert.equal(m.levels().find((level) => level.id === 'b').gainDb, -6, 'b is loud and has been turned down');
		for (const { tick, peak } of drained) assert.ok(peak < 11_000, `tick ${tick}: the tail goes out at b s gain, not at unity: ${peak}`);
	});

	it('forgets a speaker s frame buffer when they leave', () => {
		const m = new SpeakerMixer();
		m.push('a', sine(500));
		m.tick();
		assert.ok(m.frameBufs.has('a'));
		m.removeUser('a');
		assert.equal(m.frameBufs.has('a'), false);
	});

	it('leaves the sound alone when it is off, and squashes rather than clips above the knee', () => {
		const m = new SpeakerMixer();
		m.push('a', sine(500));
		assert.equal(peakOf(m.tick().pcm, 480), 500);
		assert.equal(softClip(1000), 1000);
		assert.ok(softClip(40000) > 26000 && softClip(40000) < 32767);
		assert.equal(softClip(-1e6), -32767);
	});
});

describe('the send loop s own numbers', () => {
	it('count the frames the model took', () => {
		const playback = new PlaybackQueue();
		const out = { write: () => true, once: () => {} };
		const live = { ready: true, sendAudio: () => true };
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback, output: out, getLive: () => live });
		bridge.tick();
		bridge.tick();
		bridge.tick();
		assert.equal(bridge.stats.ticks, 3);
		assert.equal(bridge.stats.sent, 3);
		assert.equal(bridge.sentRatio, null, 'nothing to say about the rate after 60 ms');
	});
});

describe('the first frame of a talk-spurt', () => {
	const marker = (v) => new Int16Array(480).fill(v);

	// The tick that catches the first packet is late by a random part of a frame, and the next packet,
	// on time, lands just after the next tick: read at once, the spurt's second frame was a hole.
	it('waits one tick for the second, and from then on the ring is read as it is', () => {
		const m = new SpeakerMixer({ primeFrames: 2 });
		m.push('a', marker(3001));
		assert.equal(m.tick().pcm[0], 0, 'held');
		m.push('a', marker(3002));
		assert.equal(m.tick().pcm[0], 3001);
		m.push('a', marker(3003));
		assert.equal(m.tick().pcm[0], 3002, 'a frame of margin stays in the ring');
		assert.equal(m.tick().pcm[0], 3003, 'a packet late by a tick is not a hole');
		assert.equal(m.stats.holes, 0);
	});

	it('is not held for longer than one tick when no second one comes', () => {
		const m = new SpeakerMixer({ primeFrames: 2 });
		m.push('a', marker(3001));
		assert.equal(m.tick().pcm[0], 0);
		assert.equal(m.tick().pcm[0], 3001);
	});

	it('is sent at once when the margin is off, which is the constructor default', () => {
		const m = new SpeakerMixer();
		m.push('a', marker(3001));
		assert.equal(m.tick().pcm[0], 3001);
	});

	it('is held again at the next spurt, not in the middle of one', () => {
		const m = new SpeakerMixer({ primeFrames: 2 });
		for (let i = 0; i < 4; i++) {
			m.push('a', marker(3000 + i));
			m.tick();
		}
		m.tick(); // the margin frame
		const dry = m.tick(); // a hole mid-spurt: no decoder here, so silence, and a is still speaking
		assert.equal(dry.pcm[0], 0);
		assert.equal(m.stats.holes, 1);
		m.push('a', marker(3010));
		assert.equal(m.tick().pcm[0], 3010, 'read at once: still their turn');
		for (let i = 0; i < 12; i++) m.tick(); // the spurt ends
		m.push('a', marker(3020));
		assert.equal(m.tick().pcm[0], 0, 'the next spurt is held for its second frame again');
	});
});

describe('the lead and the padding model', () => {
	const fakeLive = () => {
		const live = { ready: true, sent: [], sendAudio: (pcm) => (live.sent.push(pcm.length), true) };
		return live;
	};
	const out = { write: () => true, once: () => {} };

	it('give the far end a lead of silence once per session, counted by the attribution like any frame', () => {
		const live = fakeLive();
		const frames = [];
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => live, onFrame: (f) => frames.push(f) });
		bridge.tick();
		bridge.tick();
		assert.equal(live.sent.length, 7, 'five frames of lead, then the two ticks');
		assert.equal(bridge.stats.lead, 5);
		assert.equal(bridge.stats.sent, 2, 'the lead is not counted as sent audio against the clock');
		assert.equal(frames.filter((f) => f.lead).length, 5);
		assert.ok(frames.every((f) => f.sent && f.frames === 1));
	});

	it('measure what a far end that pads gaps and never trims would add', () => {
		let now = 0;
		const live = fakeLive();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => live, clock: () => now });
		bridge.leadDue = false; // no lead in this one: the model from a cold buffer
		for (const at of [0, 20, 40, 75, 80, 100, 120]) {
			now = at;
			bridge.tick();
		}
		// 0..60 on time; 75 is 15 late (padding 15); 80 arrives before the buffer end of 95 (no padding);
		// 100 before 115; 120 before 135.
		assert.equal(bridge.stats.padMs, 15);
		assert.equal(bridge.stats.sentSpanMs, 120);
		assert.equal(bridge.padRate, null, 'not until a second of audio');
	});

	it('are absorbed by the lead: lateness up to its length pads nothing', () => {
		let now = 0;
		const live = fakeLive();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => live, clock: () => now });
		for (const at of [0, 20, 40, 75, 80]) {
			now = at;
			bridge.tick();
		}
		assert.equal(bridge.stats.padMs, 0, 'the lead of 100 ms took the 15 ms of lateness');
	});

	it('goes out again when the session comes back, not on every tick', () => {
		const live = fakeLive();
		let ready = true;
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => ({ ...live, ready }) });
		bridge.tick();
		bridge.tick();
		assert.equal(bridge.stats.lead, 5, 'a fresh live object on every call is still one session');
		ready = false;
		bridge.tick();
		ready = true;
		bridge.tick();
		assert.equal(bridge.stats.lead, 10, 'back after a gap: a fresh lead');
	});
});

describe('the attribution across a two-frame tick', () => {
	it('advances the audio clock by the frames it was handed', () => {
		const attribution = new SpeakerAttribution({ ownerId: 'o' });
		attribution.onFrame({ active: ['a'], sent: true, frames: 2 });
		assert.equal(attribution.audioMs, 40);
		attribution.onFrame({ active: ['a'], sent: true });
		assert.equal(attribution.audioMs, 60);
	});
});
