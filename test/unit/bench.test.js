import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SCENARIOS, buildRoom } from '../../bench/rooms.js';
import { runRoom } from '../../bench/run.js';
import { replaySession } from '../../src/replay.js';

// The attribution benchmark (npm run bench) is kept out of the test run: it plays a hundred rooms. These
// play three small ones, so that the harness cannot rot unnoticed, and use them for what only a whole
// room can show: that ATTRIBUTION=hmm leaves the owner gate exactly where it was.

const room = (name, rep = 0) => {
	const index = SCENARIOS.findIndex((scenario) => scenario.name === name);
	assert.ok(index >= 0, name);
	return buildRoom(SCENARIOS[index], 100_003 + index * 1009 + rep);
};

/** What the gate reads, word by word and utterance by utterance. */
const gateRecord = (attribution) => ({
	words: attribution.words.map((entry) => [entry.word, entry.owner, entry.id, entry.sure, entry.pos]),
	utterances: attribution.utterances.map((utt) => [utt.text, utt.owner, utt.id, utt.sure, utt.startMs, utt.endMs]),
});

describe('the attribution benchmark', () => {
	it('builds the same room from the same seed, and a different one from another', () => {
		const a = room('handovers');
		const b = room('handovers');
		assert.deepEqual(a.fragments, b.fragments);
		assert.deepEqual(a.frames, b.frames);
		assert.notDeepEqual(room('handovers', 1).fragments, a.fragments);
		assert.ok(a.fragments.length > 50 && a.turns.length === 1, `${a.fragments.length} fragments, ${a.turns.length} commands`);
	});

	it('scores a room of clean turns as clean, and opens the gate for the owner s own command', async () => {
		const result = await runRoom(room('handovers'));
		for (const mode of ['vote', 'hmm']) {
			const { score } = result[mode];
			assert.ok(score.fragRight / score.fragments > 0.97, `${mode}: ${score.fragRight}/${score.fragments} fragments`);
			assert.ok(score.lineRight / score.lines > 0.95, `${mode}: ${score.lineRight}/${score.lines} lines`);
			assert.equal(score.ownerOpened, score.ownerShouldOpen, `${mode}: the owner's "Melis sus"`);
		}
	});

	// The safety invariant, on whole rooms: the hmm mode acts on lines only, so everything the gate reads
	// and decides is the same fragment for fragment, and the owner's name is on no more of other people's
	// words than under the vote.
	for (const name of ['guest-command', 'overlap', 'owner-cut-in']) {
		it(`leaves the gate where it was and the owner s name off other people s words (${name})`, async () => {
			const result = await runRoom(room(name));
			const vote = result.vote;
			const hmm = result.hmm;
			assert.deepEqual(gateRecord(hmm.attribution), gateRecord(vote.attribution), 'the record the gate reads');
			assert.deepEqual(
				hmm.gates.map((gate) => [gate.text, gate.opened, gate.requester]),
				vote.gates.map((gate) => [gate.text, gate.opened, gate.requester]),
				'every command decided the same, for the same person',
			);
			assert.equal(hmm.score.guestOpened, 0, 'no guest opened the gate');
			assert.equal(hmm.score.guestAsOwner, 0, 'and no guest was taken for the owner');
			assert.ok(hmm.score.fragFalseOwner <= vote.score.fragFalseOwner, `false owner fragments: hmm ${hmm.score.fragFalseOwner}, vote ${vote.score.fragFalseOwner}`);
			assert.ok(hmm.score.lineFalseOwner <= vote.score.lineFalseOwner, `false owner lines: hmm ${hmm.score.lineFalseOwner}, vote ${vote.score.lineFalseOwner}`);
			assert.ok(hmm.score.ownerGradeFalse <= vote.score.ownerGradeFalse);
			const owner = hmm.attribution.ownerId;
			for (const line of hmm.lines) {
				if (line.id === owner) {
					for (const part of line.parts) {
						if (!String(part.text).trim()) continue;
						const voted = hmm.votes.get(part.seq);
						assert.ok(voted === owner || part.id !== owner, `"${line.line}": "${part.text}" named the owner, the vote said ${voted}`);
					}
				}
				if (line.owner === true) {
					const spans = line.parts.filter((part) => Number.isFinite(part.startMs));
					const from = Math.min(...spans.map((part) => part.startMs));
					const to = Math.max(...spans.map((part) => part.endMs));
					assert.equal(hmm.attribution.speakerAt(from, to), true, `"${line.line}" acted on as the owner's without the owner alone under it`);
					assert.equal(line.id, owner);
				}
			}
		});
	}

	it('writes a flight-recorder trace that replays to the lines it recorded, in either mode', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'bench-trace-'));
		const played = room('busy-room');
		const result = await runRoom(played, { modes: ['hmm', 'vote'], traceDir: dir });
		const records = (await readFile(result.traceFile, 'utf8'))
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert.equal(records[0].attribution, 'hmm', 'the trace says which mode named its lines');
		const shape = (lines) => lines.map((line) => [line.flush, line.text, line.id, line.mixed]);
		const replayed = replaySession(records, { mode: 'hmm' });
		assert.equal(replayed.fragments.length, played.fragments.length);
		assert.ok(
			replayed.fragments.every((entry) => entry.same),
			'every fragment placed as it was',
		);
		assert.deepEqual(shape(replayed.lines), shape(replayed.recorded), 'and every line cut and named as it was');
		// The other mode, over the same trace, is the vote's lines exactly.
		const other = replaySession(records, { mode: 'vote' });
		assert.deepEqual(
			other.lines.map((line) => [line.text, line.id, line.mixed]),
			result.vote.lines.map((line) => [line.line, line.id ?? null, Boolean(line.mixed)]),
		);
		assert.ok(records.some((record) => record.t === 'g'), 'the gate decisions are in it too');
	});
});
