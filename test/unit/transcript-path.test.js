import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpeakerAttribution } from '../../src/attribution.js';
import { transcriptHost } from '../../src/replay.js';

// The transcript pipeline (onTranscript -> flushTranscript -> resolveLine) on the offline host the
// benchmark and the trace replay use, with the frames handed straight to the attribution: what a line
// is cut from, whose name it carries, and what the gate reads underneath it.

const OWNER = 'o';

function pipeline(mode) {
	const attribution = new SpeakerAttribution({ ownerId: OWNER });
	const lines = [];
	const host = transcriptHost({ attribution, mode, onLine: (item) => lines.push(item) });
	const frames = (active, count, { priority = false, present = active } = {}) => {
		for (let i = 0; i < count; i++) attribution.onFrame({ active, present, priority, sent: true });
	};
	// Windows as the realtime API reports them: from the start of the utterance to how far it has got.
	const delta = (text, endMs, startMs = 0) => host.onTranscript({ speaker: 'user', text, startMs, endMs });
	const flush = () => host.flushTranscript('user');
	const said = () => lines.map((line) => ({ who: line.id ?? null, text: line.line }));
	return { attribution, lines, frames, delta, flush, said };
}

describe('a fragment that brings no audio of its own', () => {
	// Found by the benchmark, in the overlap rooms (FLOOR_CONTROL=0): the far end sent a guest's "ban" from
	// the same point of the stream as the fragment before it. Such a fragment was judged on the whole
	// utterance so far, which the owner had held alone for most of, so the guest's word went into the
	// record as the owner's -- and opened the gate for a guest's command.
	it('is judged on the stretch the last fragment covered, not on the whole utterance', () => {
		for (const mode of ['vote', 'hmm']) {
			const room = pipeline(mode);
			room.frames([OWNER], 200); // 0 - 4000 ms, the owner alone
			room.frames([OWNER, 'g'], 25); // 4000 - 4500 ms, a guest talking over the owner
			room.delta(' bugun hava cok', 4000);
			room.delta(' guzel', 4500);
			room.delta(' ban', 4500); // no further than the fragment before it
			assert.equal(room.attribution.commandSpeaker(['ban'])?.owner, false, `${mode}: the guest's "ban" is not the owner's word`);
			room.flush();
			assert.ok(!room.lines.some((line) => line.owner === true && /ban/.test(line.line)), `${mode}: and no line carrying it is acted on as the owner's`);
		}
	});

	it('still leaves the owner s own words the owner s', () => {
		const room = pipeline('hmm');
		room.frames([OWNER], 60, { priority: true }); // 0 - 1200 ms
		room.delta(' melis', 600);
		room.delta(' ban', 1000);
		room.delta(' dana', 1000); // sent from the same point as the word before it
		assert.deepEqual(
			room.attribution.words.map((entry) => [entry.word, entry.owner]),
			[
				['melis', true],
				['ban', true],
				['dana', true],
			],
		);
		assert.equal(room.attribution.commandSpeaker(['ban'])?.owner, true);
	});

	// The same rule the other way round, found in review: a quick guest, owner, guest exchange, and the far
	// end (whose end only moves forward) reporting the guest's last word at the end of the owner's. Judged
	// on the last stretch alone, the guest's word sat on the owner's audio (0.83 of it) and opened the gate.
	it('does not lend the owner s stretch to a guest s word reported at the same end', () => {
		for (const mode of ['vote', 'hmm']) {
			const room = pipeline(mode);
			room.frames(['g'], 20); // 0 - 400 ms, the guest
			room.frames([OWNER], 50, { priority: true }); // 400 - 1400 ms, the owner alone
			room.frames(['g'], 10); // 1400 - 1600 ms, the guest again
			room.delta(' hey', 450);
			room.delta(' listen', 1590);
			room.delta(' ban', 1590); // the guest's word, its end pushed to the owner's
			const words = room.attribution.words.map((entry) => [entry.word, entry.owner]);
			assert.deepEqual(words, [
				['hey', false],
				['listen', true],
				['ban', false],
			], mode);
			assert.equal(room.attribution.commandSpeaker(['ban'])?.owner, false, `${mode}: the guest's "ban" is not the owner's word`);
		}
	});

	it('nor when the owner began the utterance and holds 0.88 of both windows', () => {
		// The owner's words alone for [0, 1400), the guest's for [1400, 1600): the fragment's own window and
		// the last stretch are the same [0, 1590], and both pass the gate's 0.8. The words of a fragment sent
		// that way are at the end of the stretch, which is where the guest is.
		const room = pipeline('hmm');
		room.frames([OWNER], 70, { priority: true });
		room.frames(['g'], 10);
		room.delta(' listen', 1590);
		room.delta(' ban', 1590);
		assert.equal(room.attribution.words.find((entry) => entry.word === 'listen')?.owner, true);
		assert.equal(room.attribution.commandSpeaker(['ban'])?.owner, false);
	});
});

describe('ATTRIBUTION: the vote against the path', () => {
	/** A guest's sentence with the owner's cough in the middle of it: 200 ms of the owner alone. */
	const coughRoom = (mode) => {
		const room = pipeline(mode);
		room.frames(['g'], 60); // 0 - 1200 ms
		room.frames([OWNER], 10, { priority: true }); // 1200 - 1400 ms: the owner takes the floor for a cough
		room.frames(['g'], 80); // 1400 - 3000 ms
		room.delta(' bu', 600);
		room.delta(' oyunun', 1150);
		room.delta(' yeni', 1500); // 50 ms of the guest, the owner's 200, 100 of the guest again
		room.delta(' sezonu', 2200);
		room.delta(' geliyor', 3000);
		room.flush();
		return room;
	};

	it('vote: the word under the cough becomes a line of the owner s', () => {
		const room = coughRoom('vote');
		assert.deepEqual(room.said(), [
			{ who: 'g', text: 'bu oyunun' },
			{ who: OWNER, text: 'yeni' },
			{ who: 'g', text: 'sezonu geliyor' },
		]);
	});

	it('hmm: the word goes with the sentence it belongs to, told as possibly holding somebody else s', () => {
		const room = coughRoom('hmm');
		assert.deepEqual(room.said(), [{ who: 'g', text: 'bu oyunun yeni sezonu geliyor' }]);
		assert.equal(room.lines[0].mixed, true, 'the path named that word, not its audio');
		assert.equal(room.lines[0].owner, false);
		// What the gate reads is the vote's, whatever the lines say.
		assert.equal(room.attribution.words.find((entry) => entry.word === 'yeni')?.id, OWNER);
		assert.equal(room.attribution.words.find((entry) => entry.word === 'yeni')?.owner, false);
	});

	it('hmm: the owner saying a word of their own, alone, keeps it -- and its line is the owner s to act on', () => {
		const room = pipeline('hmm');
		room.frames(['g'], 60); // 0 - 1200 ms
		room.frames([OWNER], 20, { priority: true }); // 1200 - 1600 ms: the owner's "evet"
		room.frames(['g'], 70); // 1600 - 3000 ms
		room.delta(' bu', 600);
		room.delta(' oyunun', 1150);
		room.delta(' evet', 1600);
		room.delta(' sezonu', 2200);
		room.delta(' geliyor', 3000);
		room.flush();
		assert.deepEqual(room.said(), [
			{ who: 'g', text: 'bu oyunun' },
			{ who: OWNER, text: 'evet' },
			{ who: 'g', text: 'sezonu geliyor' },
		]);
		assert.equal(room.lines[1].owner, true);
	});
});
