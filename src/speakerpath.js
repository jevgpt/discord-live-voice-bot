// Fragment assignment as inference: one path of speakers through a flush of transcript fragments,
// instead of a vote per fragment.
//
// The vote asks each fragment on its own "whose audio is under you?", and at the edges of a turn that is
// the wrong question. A fragment is a few hundred milliseconds of audio at most, its window is where the
// far end SAYS it was (late, jittered, on a clock that drifts), and at a handover that window takes in
// some of the next voice. On the benchmark (bench/) nearly every fragment the vote gives to the wrong
// person is the last or first piece of a turn, or the second half of a word ("gel" / "dim,") whose
// window ran into the next speaker. People do not change every fragment; they hold the floor for a
// sentence. So the speakers of a flush are read as one path: a fragment's own audio (every candidate's
// share of it, exactly as the vote measured it) is its evidence, staying with the same speaker is cheap,
// changing is not, and two people sharing one word is all but ruled out. A boundary fragment whose audio
// is split then goes with its neighbours, and one whose audio is clear still goes where the audio says.
// One answer of the vote's is final: audio that nobody held alone is two voices at once, and the path
// does not replace that "nobody" with a guess from the neighbours -- the model is told so instead.
//
// The owner is a different matter, because a line under the owner's name can carry the owner's
// authority. The path names the owner only on a fragment the vote itself gave the owner -- and the vote
// gives the owner every fragment the owner had to themselves -- so it can take the owner's name OFF a
// fragment and can never put it on one. Short of the gate's own test (the owner alone for GATE_SOLO of the
// stretch) the owner's name also costs something, so a fragment the owner merely leaned on goes to a
// neighbour whose turn it plainly is. Nothing here reaches the gate: commandSpeaker, lastUtterance,
// requestSpeaker and ownerSpeechSince read the attribution's own record, which this never touches.
//
// Decoding is Viterbi over (the few people the flush is about + nobody), linear in the fragments.

// How much a fragment's own audio counts, by where its answer came from (see resolveSpeaker): the audio
// under it, a murmur under it, or the audio either side of a pause. Silence is no evidence at all.
const EVIDENCE = { direct: 1, quiet: 0.6, nearby: 0.5, silence: 0 };

// Viterbi costs fragments x states x states, and the states were everybody the audio heard in the flush:
// at the 2000-fragment cap (PARTS_MAX) with 50 people in every fragment's window that was 35 ms, on the
// event loop the 20 ms audio tick shares. So the path runs over at most this many people (those the vote
// named most, then those with the most audio across the flush) and nobody, and of each fragment's
// candidates only the loudest few are read -- a fragment's window seldom holds more than three voices.
// Measured on the same flush: 1.0 ms, 1.5 at the 95th percentile. A fragment the vote gave to somebody
// outside the states keeps the vote's answer and is only passed through.
const MAX_NAMED = 5;
const MAX_RANKED = 4;

// Scores are natural logs of evidence mass. Tuned on the benchmark's rooms with another seed than the
// one it reports (npm run bench -- --seed 2), never on the unit tests. `change` is the one that
// matters: at 1.2 the path swallowed a listener's "evet" into the sentence around it, and anywhere from
// 0.3 to 0.6 the rooms come out within a few fragments of each other. `shared` stays under `nobody`:
// having been in the audio with somebody else is weaker evidence than making no claim at all.
export const PATH_WEIGHTS = Object.freeze({
	floor: 0.05, // the least mass any candidate is given: nothing is impossible from the audio alone
	shared: 0.25, // credit for having been in the audio with somebody else, against being in it alone
	nobody: 0.3, // "none of them", as a candidate: wins where nobody held the audio alone
	change: 0.4, // cost of the speaker changing between two fragments
	changeNobody: 0.7, // cost of going to or from nobody (not a claim about anybody)
	word: 8, // cost of two people sharing one word
	owner: 0.5, // cost of the owner's name on a fragment short of the gate's own test
	quietNobody: 0.05, // with no evidence at all, nobody is very slightly preferred
});

// Two pieces run into each other inside a word when one ends and the next begins with a letter or a digit
// (no space or punctuation between them).
const ENDS_IN_WORD = /[\p{L}\p{N}]$/u;
const STARTS_IN_WORD = /^[\p{L}\p{N}]/u;

/** The name the vote put on a part, or null. */
function votedId(part) {
	return part.confidence === 'unsure' || part.id === null || part.id === undefined ? null : String(part.id);
}

/**
 * The path.
 * @param {Array<{ text: string, id: string|null, owner?: boolean, confidence: string, reason?: string, ranked?: Array<{ id: string, solo: number, share: number }> }>} parts
 *   one flush's deltas in the order they arrived, as onTranscript builds them
 * @param {{ ownerId?: string|null, weights?: object }} [options]
 * @returns {Array<object>} the same parts in the same order. A fragment the path names differently from
 *   the vote is a copy with its new `id`, `confidence` 'leaning' ('unsure' for nobody), `owner` and `sure`
 *   false, and `path` saying why ('neighbours' or 'nobody'); every other part is the object it was given.
 */
export function speakerPath(parts, { ownerId = null, weights = PATH_WEIGHTS } = {}) {
	const w = { ...PATH_WEIGHTS, ...weights };
	const owner = ownerId ? String(ownerId) : null;
	// Whitespace says nothing about who is talking (see buildRuns): it is not on the path at all.
	const spoken = [];
	for (let i = 0; i < parts.length; i++) if (String(parts[i].text ?? '').trim()) spoken.push(i);
	if (spoken.length < 2) return parts;

	// The candidates: named by the vote first, then by audio across the flush (see MAX_NAMED), kept in the
	// order they first appear, which is the order ties are broken in.
	const seen = new Set();
	const votes = new Map();
	const mass = new Map();
	for (const i of spoken) {
		const part = parts[i];
		const voted = votedId(part);
		if (voted !== null) {
			seen.add(voted);
			votes.set(voted, (votes.get(voted) ?? 0) + 1);
		}
		const weight = EVIDENCE[part.reason] ?? 1;
		const ranked = part.ranked ?? [];
		for (let k = 0; k < ranked.length && k < MAX_RANKED; k++) {
			const id = String(ranked[k].id);
			seen.add(id);
			mass.set(id, (mass.get(id) ?? 0) + weight * (ranked[k].solo ?? 0));
		}
	}
	let named = [...seen];
	if (named.length > MAX_NAMED) {
		const kept = new Set(
			[...named]
				.sort((a, b) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0) || (mass.get(b) ?? 0) - (mass.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
				.slice(0, MAX_NAMED),
		);
		named = named.filter((id) => kept.has(id));
	}
	const states = [...named, null];
	const S = states.length;
	if (S === 1) return parts;
	const index = new Map(named.map((id, s) => [id, s]));

	// Everything per fragment is laid out flat, [t * S + s], and written once: at the cap, an array per
	// fragment and per step was a quarter of the time.
	const T = spoken.length;
	const passed = new Uint8Array(T); // voted for somebody outside the states: kept as voted
	const emission = new Float64Array(T * S);
	const solo = new Float64Array(S);
	const share = new Float64Array(S);
	for (let t = 0; t < T; t++) {
		const part = parts[spoken[t]];
		const voted = votedId(part);
		if (voted !== null && !index.has(voted)) {
			passed[t] = 1; // no evidence either way: the path goes through it as it is
			continue;
		}
		const weight = EVIDENCE[part.reason] ?? (part.ranked?.length ? 1 : 0);
		const ranked = part.ranked ?? [];
		solo.fill(0);
		share.fill(0);
		for (let k = 0; k < ranked.length && k < MAX_RANKED; k++) {
			const s = index.get(String(ranked[k].id));
			if (s === undefined) continue;
			solo[s] = ranked[k].solo ?? 0;
			share[s] = ranked[k].share ?? 0;
		}
		// The gate's own test, as the vote applied it -- and it is the gate's test only where the answer came
		// from the audio under the fragment. For a murmur, a pause or nothing at all, `owner` was the
		// frame-level fallback, a guess about whose turn it was, and letting it stand for "the owner alone"
		// put the owner's name on fragments the vote had given to a guest or to nobody: 36,336 of 200,000
		// random flushes, every one of them with a reason other than 'direct'.
		const ownersAlone = part.owner === true && part.reason === 'direct';
		// Audio under the fragment that nobody held alone is two voices at once, and the vote's "nobody" is
		// then an answer, not a gap: the path does not overrule it with a guess from the neighbours.
		const tangled = voted === null && weight > 0 && ranked.length > 1;
		const row = t * S;
		for (let s = 0; s < S; s++) {
			const state = states[s];
			if (state === null) {
				emission[row + s] = weight ? weight * Math.log(w.floor + w.nobody) : w.quietNobody;
				continue;
			}
			if (tangled) {
				emission[row + s] = -Infinity;
				continue;
			}
			const isOwner = owner !== null && state === owner;
			// The owner's name only where the vote put it: see the top of this file.
			if (isOwner && voted !== owner && !ownersAlone) {
				emission[row + s] = -Infinity;
				continue;
			}
			let score = weight ? weight * Math.log(w.floor + solo[s] + w.shared * Math.max(0, share[s] - solo[s])) : 0;
			if (isOwner && !ownersAlone) score -= w.owner;
			emission[row + s] = score;
		}
	}
	// Whether each fragment starts and ends inside a word, asked once rather than once a step.
	const starts = new Uint8Array(T);
	const ends = new Uint8Array(T);
	for (let t = 0; t < T; t++) {
		const text = String(parts[spoken[t]].text ?? '');
		starts[t] = STARTS_IN_WORD.test(text) ? 1 : 0;
		ends[t] = ENDS_IN_WORD.test(text) ? 1 : 0;
	}

	// Viterbi. back[t * S + s] is the state at t - 1 on the best path into state s at t.
	let score = emission.slice(0, S);
	let next = new Float64Array(S);
	const back = new Int32Array(T * S);
	for (let t = 1; t < T; t++) {
		const glued = ends[t - 1] === 1 && starts[t] === 1;
		const row = t * S;
		for (let s = 0; s < S; s++) {
			let best = -Infinity;
			let arg = s;
			for (let p = 0; p < S; p++) {
				if (score[p] === -Infinity) continue;
				// Nobody is not a claim about anybody, so going to or from it costs the same inside a word as
				// anywhere else: half a word the audio cannot place stays unplaced, and the half it can place
				// keeps its name. Between two people, a word is one person's.
				const cost = p === s ? 0 : states[p] === null || states[s] === null ? w.changeNobody : glued ? w.word : w.change;
				const value = score[p] - cost;
				// Ties go to staying: deterministic, and never a change for nothing.
				if (value > best || (value === best && p === s)) {
					best = value;
					arg = p;
				}
			}
			next[s] = best + emission[row + s];
			back[row + s] = arg;
		}
		const done = score;
		score = next;
		next = done;
	}
	let last = 0;
	for (let s = 1; s < S; s++) if (score[s] > score[last]) last = s;
	const path = new Int32Array(T);
	path[T - 1] = last;
	for (let t = T - 1; t > 0; t--) path[t - 1] = back[t * S + path[t]];

	const out = parts.slice();
	for (let t = 0; t < T; t++) {
		if (passed[t]) continue;
		const i = spoken[t];
		const part = parts[i];
		const label = states[path[t]];
		if (label === votedId(part)) continue;
		out[i] =
			label === null
				? { ...part, id: null, confidence: 'unsure', owner: false, sure: false, path: 'nobody' }
				: { ...part, id: label, confidence: 'leaning', owner: false, sure: false, path: 'neighbours' };
	}
	return out;
}
