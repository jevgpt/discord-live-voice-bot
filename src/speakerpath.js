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
// Decoding is Viterbi over (everybody the audio heard in the flush + nobody), linear in the fragments.

// How much a fragment's own audio counts, by where its answer came from (see resolveSpeaker): the audio
// under it, a murmur under it, or the audio either side of a pause. Silence is no evidence at all.
const EVIDENCE = { direct: 1, quiet: 0.6, nearby: 0.5, silence: 0 };

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

/** Do these two pieces run into each other inside a word (no space or punctuation between them)? */
function inWord(prevText, text) {
	if (!prevText) return false;
	return /[\p{L}\p{N}]$/u.test(prevText) && /^[\p{L}\p{N}]/u.test(text);
}

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

	const ids = new Set();
	for (const i of spoken) {
		const voted = votedId(parts[i]);
		if (voted !== null) ids.add(voted);
		for (const entry of parts[i].ranked ?? []) ids.add(String(entry.id));
	}
	const states = [...ids, null];
	const S = states.length;
	if (S === 1) return parts;

	const emission = spoken.map((i) => {
		const part = parts[i];
		const weight = EVIDENCE[part.reason] ?? (part.ranked?.length ? 1 : 0);
		const ranked = new Map((part.ranked ?? []).map((entry) => [String(entry.id), entry]));
		const ownersAlone = part.owner === true; // the gate's own test, as the vote applied it
		const voted = votedId(part);
		// Audio under the fragment that nobody held alone is two voices at once, and the vote's "nobody" is
		// then an answer, not a gap: the path does not overrule it with a guess from the neighbours.
		const tangled = voted === null && weight > 0 && ranked.size > 1;
		return states.map((state) => {
			if (state === null) return weight ? weight * Math.log(w.floor + w.nobody) : w.quietNobody;
			if (tangled) return -Infinity;
			const isOwner = owner !== null && state === owner;
			// The owner's name only where the vote put it: see the top of this file.
			if (isOwner && voted !== owner && !ownersAlone) return -Infinity;
			const entry = ranked.get(state);
			const solo = entry?.solo ?? 0;
			const share = entry?.share ?? 0;
			let score = weight ? weight * Math.log(w.floor + solo + w.shared * Math.max(0, share - solo)) : 0;
			if (isOwner && !ownersAlone) score -= w.owner;
			return score;
		});
	});

	// Viterbi. back[t - 1][s] is the state at t - 1 on the best path into state s at t.
	const T = spoken.length;
	let score = Float64Array.from(emission[0]);
	const back = [];
	for (let t = 1; t < T; t++) {
		const glued = inWord(String(parts[spoken[t - 1]].text ?? ''), String(parts[spoken[t]].text ?? ''));
		const next = new Float64Array(S);
		const from = new Int32Array(S);
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
			next[s] = best + emission[t][s];
			from[s] = arg;
		}
		back.push(from);
		score = next;
	}
	let last = 0;
	for (let s = 1; s < S; s++) if (score[s] > score[last]) last = s;
	const path = new Int32Array(T);
	path[T - 1] = last;
	for (let t = T - 1; t > 0; t--) path[t - 1] = back[t - 1][path[t]];

	const out = parts.slice();
	for (let t = 0; t < T; t++) {
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
