import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import prism from 'prism-media';
import { PlaybackQueue, SAMPLES_PER_FRAME_24K, SpeakerMixer, int16From, rmsOf } from '../../src/audio.js';
import { AudioBridge } from '../../src/bridge.js';
import { Concealment, VoiceSession } from '../../src/voice.js';

const require = createRequire(import.meta.url);

// Both codecs the decoder can end up with: @discordjs/opus when it installed (it is optional), and the
// opusscript fallback. Each takes a packet to decode and nothing else, so neither can be asked for less
// concealment than its whole output buffer.
const codecs = [];
try {
	const { OpusEncoder } = require('@discordjs/opus');
	codecs.push({ name: '@discordjs/opus', make: () => new OpusEncoder(24000, 1), encode: (codec, pcm) => codec.encode(pcm), plcMs: 240 });
} catch {
	/* optional dependency not built here */
}
const OpusScript = require('opusscript');
codecs.push({ name: 'opusscript', make: () => new OpusScript(24000, 1), encode: (codec, pcm) => codec.encode(pcm, SAMPLES_PER_FRAME_24K), plcMs: 120 });

/** 20 ms packets of a 300 Hz tone, the codec's own. */
function tonePackets(codec, count = 20) {
	const encoder = codec.make();
	const packets = [];
	for (let f = 0; f < count; f++) {
		const pcm = Buffer.alloc(SAMPLES_PER_FRAME_24K * 2);
		for (let i = 0; i < SAMPLES_PER_FRAME_24K; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 300 * (f * SAMPLES_PER_FRAME_24K + i)) / 24000)), i * 2);
		packets.push(codec.encode(encoder, pcm));
	}
	return packets;
}

const fakeSession = () => {
	const session = new VoiceSession({
		client: { user: { id: 'bot' } },
		mixer: new SpeakerMixer(),
		playback: new PlaybackQueue(),
		getLive: () => null,
		log: () => {},
	});
	session.connection = { state: { status: 'ready' }, joinConfig: { channelId: 'c' }, subscribe() {}, destroy() {} };
	const played = [];
	session.player = { play: (resource) => played.push(resource), stop() {} };
	return { session, played };
};

describe('a speaker s missing frames', () => {
	for (const codec of codecs) {
		// A review finding: decoding an empty packet fills the codec's whole buffer (240 ms with the native
		// one), so asking again for every missing frame took the second and third frames from 240 and 480
		// ms into the fade, at a tenth of the level, and ran the decoder 720 ms past the next packet.
		it(`are one decode per gap, served 20 ms at a time (${codec.name})`, () => {
			const decoder = codec.make();
			let last = null;
			for (const packet of tonePackets(codec)) last = decoder.decode(packet);
			const heard = rmsOf(int16From(last));
			let decodes = 0;
			let size = 0;
			const concealment = new Concealment((packet) => {
				decodes++;
				const raw = decoder.decode(packet);
				size = raw.length / 2;
				return raw;
			});
			const frames = [concealment.next(), concealment.next(), concealment.next()];
			assert.equal(decodes, 1, 'the whole gap came out of one decode');
			assert.equal(size, (codec.plcMs * 24000) / 1000, 'which is the codec s whole buffer, not a frame');
			for (const frame of frames) assert.equal(frame.length, SAMPLES_PER_FRAME_24K);
			const levels = frames.map((frame) => rmsOf(frame));
			assert.ok(levels[0] > heard * 0.8, `the first frame carries on at the level heard: ${levels[0]} / ${heard}`);
			assert.ok(levels[2] > levels[0] * 0.4, `and the third is the same fade 40 ms on, not 480: ${levels.join(', ')}`);

			concealment.reset(); // a real packet came
			concealment.next();
			assert.equal(decodes, 2, 'the next gap starts from a fresh decode');
		});
	}

	it('are served in order from the one decode, and a new decode only once it is used up', () => {
		let decodes = 0;
		const concealment = new Concealment(() => {
			decodes++;
			const pcm = Int16Array.from({ length: 1200 }, (_, i) => i);
			return Buffer.from(pcm.buffer);
		});
		const first = concealment.next();
		const second = concealment.next();
		const third = concealment.next();
		assert.deepEqual([first[0], second[0], third[0]], [0, 480, 960]);
		assert.equal(third.length, 240, 'what is left of the decode, not a frame from the next one');
		concealment.next();
		assert.equal(decodes, 2);
	});

	it('are not made up once the decoder is gone', () => {
		const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: SAMPLES_PER_FRAME_24K });
		const concealment = new Concealment((packet) => decoder.encoder?.decode(packet));
		assert.equal(concealment.next()?.length, SAMPLES_PER_FRAME_24K, 'prism s codec object conceals');
		decoder.destroy();
		concealment.reset();
		assert.equal(concealment.next(), null, 'and a destroyed stream has none');
	});
});

describe('the bot s own output', () => {
	// A review finding: a second death inside the throttle's second had its renewal thrown away, and a
	// destroyed stream never says anything again, so the bot was silent until the next voice reconnect.
	it('is renewed at the end of the throttle s second when it dies inside it, not never', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
		const { session, played } = fakeSession();
		session.buildOutput();
		session.renewOutput();
		assert.equal(played.length, 2, 'the first renewal goes through at once');
		const second = session.pcmStream;
		second.destroy();
		for (let i = 0; i < 10; i++) session.renewOutput(); // the bridge asks on every tick
		assert.equal(played.length, 2, 'inside the second: put off');
		assert.equal(session.pcmStream, second);
		t.mock.timers.tick(999);
		assert.equal(played.length, 2);
		t.mock.timers.tick(1);
		assert.equal(played.length, 3, 'once, at the end of the second');
		assert.notEqual(session.pcmStream, second);
		assert.equal(session.pcmStream.destroyed, false);
		session.leave();
	});

	it('is renewed through the bridge, which then writes to the new stream and not the dead one', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
		const { session } = fakeSession();
		session.buildOutput();
		session.renewOutput(); // a first death, a moment ago
		session.bridge = new AudioBridge({
			mixer: session.mixer,
			playback: session.playback,
			output: session.pcmStream,
			getLive: () => null,
			onOutputDead: () => session.renewOutput(),
		});
		session.pcmStream.on('error', () => {});
		session.pcmStream.destroy();
		for (let i = 0; i < 5; i++) session.bridge.tick();
		assert.equal(session.bridge.backpressure, false, 'no latch on a dead stream');
		assert.equal(session.bridge.dropped, 5);
		t.mock.timers.tick(1000);
		const fresh = session.pcmStream;
		assert.equal(fresh.destroyed, false);
		assert.equal(session.bridge.output, fresh, 'the bridge was handed the new stream');
		let wrote = 0;
		const write = fresh.write.bind(fresh);
		fresh.write = (chunk) => {
			wrote += chunk.length;
			return write(chunk);
		};
		session.bridge.tick();
		assert.equal(wrote, 3840, 'and a 20 ms frame goes to it');
		assert.equal(session.bridge.dropped, 5, 'nothing more is dropped');
		session.leave();
	});

	it('is not renewed while the connection is down, and not after leaving', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
		const { session, played } = fakeSession();
		session.buildOutput();
		session.connection.state.status = 'disconnected';
		session.renewOutput();
		assert.equal(played.length, 1, 'nothing would be written to it: it would starve and die again');
		session.connection.state.status = 'ready';
		session.renewOutput();
		session.renewOutput();
		assert.equal(played.length, 2);
		assert.ok(session.renewTimer, 'the second is put off');
		session.leave();
		assert.equal(session.renewTimer, null);
		t.mock.timers.tick(2000);
		assert.equal(played.length, 2, 'and a session that has left does not get one');
	});
});
