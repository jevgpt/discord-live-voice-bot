import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRuns, runText } from '../../src/runs.js';
import { PATH_WEIGHTS, speakerPath } from '../../src/speakerpath.js';

// The speaker path over one flush of fragments (ATTRIBUTION=hmm). Pure: no audio, no clock. A part here
// is what onTranscript builds from noteTranscript's answer: the vote's name and confidence, whether the
// owner was alone under it (`owner`), and every candidate's share of the audio (`ranked`).

const OWNER = 'o';

/** A fragment whose audio held these solo shares (the rest of the time shared or empty). */
const frag = (text, shares, { reason = 'direct', shared = {} } = {}) => {
	const ranked = Object.entries(shares)
		.map(([id, solo]) => ({ id, solo, share: Math.min(1, solo + (shared[id] ?? 0)) }))
		.sort((a, b) => b.solo - a.solo);
	const top = ranked[0];
	// The vote, as _rank decides it.
	const confidence = !top ? 'unsure' : top.solo >= 0.6 ? 'sure' : top.solo >= 0.25 ? 'leaning' : 'unsure';
	const id = confidence === 'unsure' ? null : top.id;
	return { text, startMs: 0, endMs: 0, id, confidence, sure: confidence === 'sure', owner: id === OWNER && reason === 'direct' && top.solo >= 0.8, reason, ranked, ids: ranked.map((entry) => entry.id) };
};
const names = (parts) => parts.map((part) => (part.confidence === 'unsure' ? null : part.id));

describe('the speaker path: neighbours and evidence', () => {
	it('keeps a clear flush exactly as the vote had it, the same objects', () => {
		const parts = [frag(' bence', { a: 1 }), frag(' olmaz', { a: 1 }), frag(' neden', { b: 1 }), frag(' ki', { b: 0.9 })];
		const out = speakerPath(parts, { ownerId: OWNER });
		assert.deepEqual(names(out), ['a', 'a', 'b', 'b']);
		out.forEach((part, i) => assert.equal(part, parts[i], 'nothing the path agrees with is copied'));
	});

	it('gives a boundary fragment whose audio is split to the neighbours around it', () => {
		// The window of " yeni" reaches into b's audio (0.55 against a's 0.45): the vote names b; the
		// sentence around it is a's.
		const parts = [frag(' bu', { a: 1 }), frag(' oyunun', { a: 1 }), frag(' yeni', { b: 0.55, a: 0.45 }), frag(' sezonu', { a: 1 }), frag(' geliyor', { a: 1 })];
		assert.deepEqual(names(parts), ['a', 'a', 'b', 'a', 'a'], 'the vote');
		const out = speakerPath(parts, { ownerId: OWNER });
		assert.deepEqual(names(out), ['a', 'a', 'a', 'a', 'a']);
		assert.equal(out[2].confidence, 'leaning', 'a name the audio did not give is never more than leaning');
		assert.equal(out[2].path, 'neighbours', 'and it says where it came from');
	});

	it('lets clear audio win over the neighbours: somebody else really did say one word', () => {
		const parts = [frag(' bu', { a: 1 }), frag(' oyunun', { a: 1 }), frag(' evet', { b: 0.95, a: 0.05 }), frag(' sezonu', { a: 1 }), frag(' geliyor', { a: 1 })];
		assert.deepEqual(names(speakerPath(parts, { ownerId: OWNER })), ['a', 'a', 'b', 'a', 'a']);
	});

	it('does not let two people share one word', () => {
		// "gel" / "dim,": the second piece's window ran into the next speaker. Across a space it is two words
		// and may be two people; without one it is one word, and one person's.
		const glued = [frag(' ben', { a: 1 }), frag(' gel', { a: 1 }), frag('dim,', { b: 0.7, a: 0.3 }), frag(' neden', { b: 1 })];
		assert.deepEqual(names(speakerPath(glued, { ownerId: OWNER })), ['a', 'a', 'a', 'b']);
		const spaced = [frag(' ben', { a: 1 }), frag(' gel', { a: 1 }), frag(' dim,', { b: 1 }), frag(' neden', { b: 1 })];
		assert.deepEqual(names(speakerPath(spaced, { ownerId: OWNER })), ['a', 'a', 'b', 'b']);
	});

	it('names nobody on a stretch that was two voices at once, however it is surrounded', () => {
		const tangled = (text) => frag(text, { a: 0, b: 0 }, { shared: { a: 1, b: 1 } });
		const parts = [frag(' once', { a: 1 }), tangled(' ayni'), tangled(' anda'), tangled(' konusuyoruz'), frag(' sonra', { a: 1 })];
		assert.deepEqual(names(speakerPath(parts, { ownerId: OWNER })), ['a', null, null, null, 'a']);
	});

	it('carries a fragment with no audio at all on the voice around it', () => {
		const parts = [frag(' bu', { a: 1 }), { ...frag(' sarkiyi', {}, { reason: 'silence' }), ranked: [] }, frag(' acsana', { a: 1 })];
		assert.deepEqual(names(speakerPath(parts, { ownerId: OWNER })), ['a', 'a', 'a']);
	});

	it('passes whitespace through where it was, and a flush of one fragment untouched', () => {
		const parts = [frag(' bir', { a: 1 }), { text: ' ', startMs: 0, endMs: 0, id: null, confidence: 'unsure', ids: [] }, frag(' iki', { b: 0.52, a: 0.48 }), frag(' uc', { a: 1 })];
		const out = speakerPath(parts, { ownerId: OWNER });
		assert.equal(out[1], parts[1]);
		assert.deepEqual(names(out), ['a', null, 'a', 'a']);
		const one = [frag(' tek', { b: 0.4, a: 0.3 })];
		assert.equal(speakerPath(one, { ownerId: OWNER }), one);
	});

	it('holds the tuned numbers to the rule that keeps tangled audio nobody s', () => {
		assert.ok(PATH_WEIGHTS.shared < PATH_WEIGHTS.nobody, 'a fragment nobody held alone must not go to whoever is beside it');
		assert.ok(Object.isFrozen(PATH_WEIGHTS));
	});
});

describe('the speaker path and the owner', () => {
	it('never puts the owner s name on a fragment the vote did not give the owner', () => {
		// The owner on both sides, and a fragment in between whose audio the vote could not place: the path
		// may not carry the owner across it.
		const parts = [frag(' melis', { o: 1 }), frag(' sey', { a: 0.2, o: 0.2 }, { shared: { a: 0.6, o: 0.6 } }), frag(' sus', { o: 1 })];
		assert.equal(parts[1].id, null, 'the vote named nobody');
		const out = speakerPath(parts, { ownerId: OWNER });
		assert.notEqual(out[1].id, OWNER);
		assert.equal(out[0].id, OWNER, 'the owner s own words stay the owner s');
		assert.equal(out[2].id, OWNER);
	});

	it('takes the owner s name off a guest s word at the edge of the owner s turn', () => {
		// The guest's last word, its window running into the owner's cut-in: the owner leads the audio
		// under it, but not alone enough for the gate, and the sentence it ends is the guest's.
		const parts = [frag(' yarin', { a: 1 }), frag(' sabah', { o: 0.62, a: 0.38 }), frag(' melis', { o: 1 }), frag(' sus', { o: 1 })];
		assert.deepEqual(names(parts), ['a', OWNER, OWNER, OWNER], 'the vote');
		const out = speakerPath(parts, { ownerId: OWNER });
		assert.deepEqual(names(out), ['a', 'a', OWNER, OWNER]);
		assert.equal(out[1].owner, false);
	});

	it('keeps a fragment the owner had to themselves the owner s, even inside a guest s turn', () => {
		// Owner priority: the owner's "evet" takes the floor at once, alone, in the middle of a guest's turn.
		const parts = [frag(' annemler', { a: 1 }), frag(' bu', { a: 1 }), frag(' evet', { o: 1 }), frag(' hafta', { a: 1 }), frag(' gelecek', { a: 1 })];
		const out = speakerPath(parts, { ownerId: OWNER });
		assert.deepEqual(names(out), ['a', 'a', OWNER, 'a', 'a']);
		assert.equal(out[2].owner, true, 'and the gate-grade flag is left as the vote set it');
	});

	// The invariant, over inputs nobody wrote by hand: whatever the audio and the vote were, the path's
	// owner is a subset of the vote's owner, the gate-grade flag is never raised, and nothing is lost,
	// added or moved.
	it('never names the owner where the vote did not, over two thousand random flushes', () => {
		let seed = 99;
		const rnd = () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return (seed >>> 8) / 16_777_216;
		};
		const people = [OWNER, 'a', 'b'];
		let relabelled = 0;
		let ownerTaken = 0;
		for (let round = 0; round < 2000; round++) {
			const parts = [];
			const count = 2 + Math.floor(rnd() * 10);
			for (let i = 0; i < count; i++) {
				if (rnd() < 0.08) {
					parts.push({ text: ' ', startMs: 0, endMs: 0, id: null, confidence: 'unsure', ids: [] });
					continue;
				}
				const shares = {};
				let left = 1;
				for (const person of people) {
					if (rnd() < 0.5) continue;
					const solo = Math.round(rnd() * left * 100) / 100;
					shares[person] = solo;
					left -= solo;
				}
				const reason = rnd() < 0.8 ? 'direct' : rnd() < 0.5 ? 'nearby' : 'silence';
				const text = `${rnd() < 0.7 ? ' ' : ''}w${round}_${i}`;
				parts.push(frag(text, reason === 'silence' ? {} : shares, { reason }));
			}
			const out = speakerPath(parts, { ownerId: OWNER });
			assert.equal(out.length, parts.length);
			for (let i = 0; i < parts.length; i++) {
				const before = parts[i];
				const after = out[i];
				assert.equal(after.text, before.text, 'the text is never touched');
				const ownerBefore = before.confidence !== 'unsure' && before.id === OWNER;
				const ownerAfter = after.confidence !== 'unsure' && after.id === OWNER;
				if (ownerAfter) assert.ok(ownerBefore || before.owner === true, `round ${round}: the owner named where the vote did not`);
				if (after.owner === true) assert.equal(before.owner, true, `round ${round}: the gate-grade flag raised`);
				if (after !== before) relabelled++;
				if (ownerBefore && !ownerAfter) ownerTaken++;
			}
			// And the runs it makes never lose a letter.
			assert.equal(buildRuns(out).map(runText).join(' ').replace(/\s+/g, ' '), buildRuns(parts).map(runText).join(' ').replace(/\s+/g, ' '));
		}
		// Without these the property would hold of a path that never does anything.
		assert.ok(relabelled > 500, `the path has to actually move fragments: ${relabelled}`);
		assert.ok(ownerTaken > 50, `and take the owner s name off some: ${ownerTaken}`);
	});
});
