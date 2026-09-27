import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SAMPLES_PER_FRAME_24K, SpeakerMixer } from '../../src/audio.js';
import { SpeakerAttribution } from '../../src/attribution.js';
import { locale, setLocale } from '../../src/i18n/index.js';
import { transcriptHost } from '../../src/replay.js';
import { ownerGate } from '../../src/tools/helpers.js';
import { add, fan, hiss, rng, speech, toFrames } from '../../bench/vad-signals.mjs';

// A guest who is in the sound and never "speaking": a murmur under every speech bar, or a command spoken a
// few dB over a fan in their own microphone, which the adaptive detector has made their floor. Their
// words come back as a fragment with no speaker's audio under it ('quiet', 'nearby'), and for those the
// owner's authority used to come from the frame-level test, which only knew about speakers. Found by an
// adversarial review and reproduced through the real mixer; these are its cases.

const O = 'o';
const G = 'g';
const N = SAMPLES_PER_FRAME_24K;

/** Frames straight into the attribution, on a clock that moves 20 ms a frame. */
function room() {
	let now = 1_000_000;
	const a = new SpeakerAttribution({ ownerId: O, now: () => now });
	const frames = (count, frame) => {
		for (let i = 0; i < count; i++) {
			now += 20;
			a.onFrame({ sent: true, ...frame });
		}
	};
	const owner = (count) => frames(count, { priority: true, active: [O], present: [O] });
	return { a, frames, owner, wait: (ms) => (now += ms) };
}

describe('somebody else in the sound, speaking or not', () => {
	it('counts as somebody after the owner for the frame-level test', () => {
		const { a, frames, owner } = room();
		owner(20);
		assert.equal(a.ownerSpeakingNow(), true);
		frames(5, { active: [], present: [G] }); // a murmur, under the speech bar
		assert.equal(a.ownerSpeakingNow(), false, 'the murmur came after the owner');
		assert.equal(a.isOwnerActive(), false, 'and the older gate sees it too');
	});

	it('does not lend the owner authority for a fragment on a guest s murmur', () => {
		const { a, frames, owner } = room();
		frames(20, { active: [], present: [G] }); // 0 - 400 ms: the guest murmurs
		owner(40); // 400 - 1200 ms: then the owner speaks, and is the latest voice
		assert.equal(a.ownerSpeakingNow(), true, 'by the clock the owner is speaking now');
		const hit = a.noteTranscript(' ban', { startMs: 100, endMs: 300 });
		assert.equal(hit.reason, 'quiet');
		assert.equal(hit.owner, false, 'the words are on the guest s audio, not the owner s');
	});

	it('does not lend it for a fragment in a pause somebody else murmured near', () => {
		const { a, frames, owner } = room();
		owner(40); // 0 - 800 ms
		frames(10, { active: [], present: [] }); // 800 - 1000 ms: the pause
		frames(10, { active: [], present: ['x', 'y'] }); // two murmurs at once: the track keeps no name for them
		owner(20); // the owner goes on
		const hit = a.noteTranscript(' ban', { startMs: 820, endMs: 980 });
		assert.equal(hit.reason, 'nearby');
		assert.deepEqual(hit.ids, [O], 'the track names only the owner around the pause');
		assert.equal(hit.owner, false, 'but two other voices were in the sound beside it');
	});

	it('still gives the owner their own pause, with nobody else anywhere near it', () => {
		const { a, frames, owner } = room();
		owner(40);
		frames(10, { active: [], present: [] });
		owner(20);
		const hit = a.noteTranscript(' ban', { startMs: 820, endMs: 980 });
		assert.equal(hit.reason, 'nearby');
		assert.equal(hit.owner, true);
	});

	it('closes a fragment with no position at all while anybody else was in the sound lately', () => {
		const { a, frames, owner, wait } = room();
		frames(5, { active: [], present: [G] });
		owner(20);
		assert.equal(a.noteTranscript(' ban').owner, false, 'the guest was in the sound 400 ms before');
		wait(1600);
		owner(10);
		assert.equal(a.noteTranscript(' ban').owner, true, 'the owner alone for the last 1.5 s');
	});
});

describe('presence is what goes into the frame', () => {
	const noise = (seed) => {
		const r = rng(seed);
		return (db) => Int16Array.from({ length: N }, () => Math.round(r.gauss() * 32768 * 10 ** (db / 20)));
	};

	it('hears a whisper under every speech bar as present, down to the edge of digital silence', () => {
		for (const vad of ['peak', 'adaptive']) {
			const m = new SpeakerMixer({ vad, agc: true, floorControl: true });
			const whisper = noise(3);
			let frame = null;
			for (let i = 0; i < 10; i++) {
				m.push(G, whisper(-72));
				frame = m.tick();
			}
			assert.deepEqual(frame.active, [], `${vad}: nobody is speaking`);
			assert.deepEqual(frame.present, [G], `${vad}: a -72 dBFS whisper is still in the sound`);
			m.push(G, new Int16Array(N));
			assert.deepEqual(m.tick().present, [], `${vad}: digital silence is not`);
		}
	});

	it('measures it after the gain the voice goes out with', () => {
		// The energy bar off, so that only the peak bar is left: a peak of 100 is under it at unity, and a
		// guest whose gain an earlier sentence raised to +18 dB goes out at 800.
		const m = new SpeakerMixer({ agc: true, presenceRms: Infinity });
		const low = new Int16Array(N).fill(100);
		m.push(G, low);
		assert.deepEqual(m.tick().present, [], 'at unity');
		m.voices.get(G).gain = 8;
		m.voices.get(G).level = 400;
		m.push(G, low);
		assert.deepEqual(m.tick().present, [G], 'at +18 dB');
	});
});

// ---------------------------------------------------------------- end to end
//
// The owner talks from 0.2 s to about 2 s, then the guest says "ban Dave" from 2.3 s over whatever their
// microphone hears; the transcript of it arrives 300 ms after the words end. Real mixer (floor control,
// AGC, owner priority, two frames of priming as live), real attribution, the session's own onTranscript
// on the offline host, and the real owner gate.

function attack({ vad, guestDb, noise = null, compress = false, ownerSays = false }) {
	const FR = N;
	const seconds = 6;
	let now = 1_000_000;
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const ownerVoice = speech({ seconds: 2.2, levelDb: -30, seed: 11, lead: 0.2 });
		const room = noise ?? hiss({ seconds, levelDb: -90, seed: 4 });
		const cmd = speech({ seconds: 3.4, levelDb: guestDb, seed: 23, lead: 2.3 });
		if (compress) {
			// The attacker's own compressor: every 20 ms of their speech at the same level, pauses kept.
			const target = 32768 * 10 ** (guestDb / 20);
			for (let i = 0; i + FR <= cmd.x.length; i += FR) {
				let acc = 0;
				for (let k = 0; k < FR; k++) acc += cmd.x[i + k] ** 2;
				const rms = Math.sqrt(acc / FR);
				if (rms < 1) continue;
				for (let k = 0; k < FR; k++) cmd.x[i + k] *= target / rms;
			}
		}
		const ownerFrames = toFrames(ownerVoice.x);
		const guestFrames = toFrames(add(room, cmd.x));
		const mixer = new SpeakerMixer({ floorControl: true, agc: true, primeFrames: 2, vad });
		mixer.setPriority(O);
		const attribution = new SpeakerAttribution({ ownerId: O, frameMs: 20, now: () => now });
		const host = transcriptHost({ attribution, mode: 'hmm' });
		const [from, to] = ownerSays ? ownerVoice.utterances[0] : cmd.utterances[0];
		let posFrom = null;
		let posTo = null;
		let turn = null;
		for (let f = 0; f < seconds / 0.02; f++) {
			now = 1_000_000 + f * 20;
			if (f < ownerFrames.length && f * 20 < 2100) mixer.push(O, ownerFrames[f]);
			mixer.push(G, guestFrames[f]);
			const frame = mixer.tick();
			if (f === from) posFrom = attribution.audioMs;
			attribution.onFrame({ ...frame, sent: true });
			if (f === to) posTo = attribution.audioMs;
			if (f === to + 15) {
				host.onTranscript({ speaker: 'user', text: ' ban', startMs: posFrom, endMs: posFrom + 300 });
				host.onTranscript({ speaker: 'user', text: ' Dave', startMs: posFrom, endMs: posTo });
			}
			// The model answers 900 ms after the words end, as the bench's rooms have it.
			if (f === to + 45) turn = attribution.markTurn();
		}
		host.flushTranscript('user');
		return {
			currentTurn: () => turn,
			commandSpeaker: (words, options) => attribution.commandSpeaker(words, options),
			lastUtterance: (options) => attribution.lastUtterance(options),
			transcriptLagging: (options) => attribution.transcriptLagging(options),
			awaitTranscript: async () => {},
			ownerUtterance: (options) => attribution.ownerUtterance(options),
			isOwnerActive: () => attribution.isOwnerActive(),
			ownerTextTail: () => '',
			pendingConfirmations: new Map(),
			log() {},
			activity() {},
		};
	} finally {
		Date.now = realNow;
	}
}

describe('a guest s command the detector never called speech, through the whole path', () => {
	let previous;
	before(() => {
		previous = locale();
		setLocale('en');
	});
	after(() => setLocale(previous));
	const opens = async (options) => !(await ownerGate(attack(options), ['ban', 'banned'], 'ban'));

	it('stays shut for a command spoken just over the guest s own fan', async () => {
		// The review's case, under VAD=adaptive: the fan is the guest's floor, their speech never clears it
		// by 6 dB, and it was recorded as a murmur and given the owner's authority.
		for (const [noiseDb, guestDb] of [
			[-40, -47],
			[-40, -43],
			[-30, -36],
			[-30, -33],
		]) {
			const noise = fan({ seconds: 6, levelDb: noiseDb, seed: 5 });
			for (const vad of ['adaptive', 'peak']) {
				assert.equal(await opens({ vad, guestDb, noise, compress: true }), false, `${vad}: speech at ${guestDb} over a fan at ${noiseDb}`);
			}
		}
	});

	it('stays shut for a murmur or a whisper in a quiet room, under either detector', async () => {
		for (const guestDb of [-57, -51, -66, -72]) {
			for (const vad of ['peak', 'adaptive']) {
				assert.equal(await opens({ vad, guestDb }), false, `${vad}: a command at ${guestDb} dBFS`);
				assert.equal(await opens({ vad, guestDb, compress: true }), false, `${vad}: a command compressed to ${guestDb} dBFS`);
			}
		}
	});

	it('still opens for the owner s own command, with the guest s fan running', async () => {
		for (const vad of ['peak', 'adaptive']) {
			const noise = fan({ seconds: 6, levelDb: -40, seed: 5 });
			assert.equal(await opens({ vad, guestDb: -47, noise, compress: true, ownerSays: true }), true, vad);
			assert.equal(await opens({ vad, guestDb: -57, ownerSays: true }), true, `${vad}, a quiet room`);
		}
	});
});
