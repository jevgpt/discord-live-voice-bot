// Speaker attribution: tracks who the audio we send out belongs to.
//
// The audio path is priority based: while the bot owner speaks the mixer sends ONLY their audio
// (priority=true). That is why we can answer "was the audio we sent the owner's, or a mix of
// somebody else's" with certainty — the gate in front of the admin commands rests on it.
// With priority off the owner is recognised by their id among the active speakers in the mix.
//
// The real question for the gate is not "who is speaking right now" but "who said the COMMAND":
// transcript fragments are attributed to a person by audio position (word + utterance list), the
// moment the model starts answering (the turn) is marked, and voices that cut in AFTER the turn
// started do not affect that turn's decision.

import { normalize } from './text.js';
import { locale, tRaw } from './i18n/index.js';

// How much of a stretch of audio one voice has to hold ALONE before we are willing to put their name
// on the words. Below NAME_LEAN nobody is named at all.
const NAME_SOLO = 0.6;
const NAME_LEAN = 0.25;
// Authority is a different question from naming, so it gets its own number, and a stricter one: the
// model transcribes the SUM of the voices in a frame, so while two people overlap a word in that
// stretch may belong to either of them. At solo >= 0.8 everybody else is bounded at 0.2 by
// construction, so this one constant does the whole job.
const GATE_SOLO = 0.8;
// The rest of a word: a transcript piece that starts with a letter, follows a piece that ended with
// one, begins in the audio exactly where that piece ended, and arrives within this of it on the
// clock. The clock bound is what keeps two things said back to back, whose positions touch, apart.
const GLUE_MS = 1500;
// A pause inside one request from the owner ("melis... artik konusabilirsin"). Longer than that is
// two things said, and only the last one is the request.
const OWNER_SPEECH_GAP_MS = 2500;
// The transcript's clock against ours (see observeTranscript). The samples are "end minus our position"
// over this much of our audio; the offset is the upper envelope of them -- the largest per bucket -- and
// once there are enough buckets a line through those maxima, so that the offset is known at any moment,
// silence or not, and its rate is a number of its own. Anything beyond the sanity bound is a bug, not a
// clock, and no clock runs more than five percent fast.
const DRIFT_WINDOW_MS = 60_000;
const DRIFT_BUCKET_MS = 5000;
const DRIFT_MIN_BUCKETS = 3;
const DRIFT_MAX_RATE = 0.05;
const DRIFT_MAX_MS = 120_000;
const EMPTY_SHARE = Object.freeze({ heardMs: 0, ranked: Object.freeze([]), id: null, share: 0, speakers: 0 });
// How far outside a stretch to look when the stretch itself holds no audio at all. A fragment can land
// in the pause between two of somebody's own words: Discord sends no packets while they draw breath, so
// nothing is tracked there, and the honest answer is written just to either side of it.
// The size is measured, not guessed: six of these were logged with their numbers in one live session
// and the fragment's window sat between 500 and 1000 ms past the last audio heard, so half a second
// missed five of the six. Widening it cannot put words in the wrong mouth, because a neighbourhood
// holding two voices still names nobody.
const NEAR_MS = 1500;
// In a hand-off, the nearer voice has to be nearer by this much before the words are given to it: a
// fragment sitting in the middle of the pause is anybody's.
const CLOSE_MARGIN_MS = 250;

const TURN_TTL_MS = 30_000; // the turn marker counts as stale after this long
const UTTERANCE_GAP_MS = 1500; // fragments from the same person within this gap count as one utterance
const MAX_UTTERANCES = 60;

/**
 * Gate keyword entries. An entry written as "=word" is a STEM: it matches the bare word and the
 * inflections its own language allows, and nothing else. A plain entry is read the way its language
 * builds words. Turkish glues whole moods onto a verb, so there a plain entry of three letters or more
 * matches as a PREFIX ("ban" also matches "banla", "banlasana"). English does not, and a prefix there
 * was matching whatever happened to start with the same letters: "banana", "band" and "bank" all
 * opened the ban tools. So in English a plain entry matches the whole word and the forms the locale
 * lists for it ("ban", "bans", "banned", "banning"). Short everyday stems ("go", "gec", "al") would
 * swallow half of ordinary speech as a prefix, but a bare-word-only test is just as wrong in a
 * suffixing language, where the command word is almost never heard bare: "cek" arrives as "ceksene",
 * "cekelim", "cekebilir misin".
 */
function parseKeywords(keywords) {
	const parsed = [];
	for (const raw of keywords ?? []) {
		const text = String(raw ?? '');
		const stem = text.startsWith('=');
		const word = stem ? text.slice(1) : text;
		const needle = normalize(word);
		if (needle) parsed.push({ word, needle, stem });
	}
	return parsed;
}

// Which tails a stem may pick up is grammar, so the locale owns it: English adds a plural/third
// person "s" to an imperative and little else, Turkish glues a whole mood onto the verb. Cached per
// language; the pattern is read once and kept.
const inflections = new Map();
const negations = new Map();
function patternFor(key, cache) {
	const code = locale();
	if (!cache.has(code)) {
		const entry = tRaw(key);
		cache.set(code, entry?.pattern ? new RegExp(entry.pattern, entry.flags ?? 'u') : null);
	}
	return cache.get(code);
}
const inflectionFor = () => patternFor('keywords.inflection', inflections);
const negationFor = () => patternFor('keywords.negation', negations);
const negativeWords = new Map();
const negativeWordFor = () => patternFor('keywords.negative_word', negativeWords);

// "Don't", "shouldn't", "can't": English glues its negative onto the word before it, and normalize() cuts
// a short tail off at the apostrophe, so "shouldn't" became "shouldn" and "can't" became "can", which is
// halfway to a yes. The negative is written out as a word of its own before anything else is done to the
// text, and it survives as "not" wherever the words go. A piece of a streamed transcript can begin with
// the "'t" of a word the previous piece ended ("didn" / "'t"), so a "'t" at the very start is one too.
// Spelling, like the Turkish letters normalize() folds, so it applies whatever language the bot runs in.
const CONTRACTED_NOT = [
	[/\bcan['’]t\b/giu, 'can not'],
	[/\bwon['’]t\b/giu, 'will not'],
	[/\bshan['’]t\b/giu, 'shall not'],
	[/n['’]t\b/giu, ' not'],
	[/^\s*['’]t\b/iu, ' not'],
];

/** The words of a stretch of speech, as the gate and the confirmation compare them (see CONTRACTED_NOT). */
export function spokenTokens(text) {
	let value = String(text ?? '');
	for (const [pattern, replacement] of CONTRACTED_NOT) value = value.replace(pattern, replacement);
	return normalize(value).split(' ').filter(Boolean);
}

// Set phrases that hold a command word and are not a command: "kick off" is a start, "boot up" a
// computer, "silence is golden" a saying. The locale lists them; a command word heard as part of one
// does not count. Cached per language.
const phraseLookalikeLists = new Map();
function phraseLookalikesFor() {
	const code = locale();
	if (!phraseLookalikeLists.has(code)) {
		const list = tRaw('keywords.phrase_lookalikes');
		phraseLookalikeLists.set(code, Array.isArray(list) ? list.map((phrase) => normalize(phrase).split(' ').filter(Boolean)).filter((words) => words.length > 1) : []);
	}
	return phraseLookalikeLists.get(code);
}

/** Is the token at `index` part of one of the locale's set phrases (see phraseLookalikesFor)? */
function inLookalikePhrase(tokens, index) {
	for (const phrase of phraseLookalikesFor()) {
		for (let at = 0; at < phrase.length; at++) {
			if (phrase[at] !== tokens[index]) continue;
			const start = index - at;
			if (start < 0 || start + phrase.length > tokens.length) continue;
			if (phrase.every((word, k) => tokens[start + k] === word)) return true;
		}
	}
	return false;
}

// Words that begin with a keyword and are a different word: "banyo" is not "ban", "odak" is not "oda".
// A prefix match cannot tell them apart, so the locale names them. Cached per language.
const lookalikeLists = new Map();
function lookalikesFor() {
	const code = locale();
	if (!lookalikeLists.has(code)) {
		const list = tRaw('keywords.lookalikes');
		lookalikeLists.set(code, Array.isArray(list) ? list.map((word) => normalize(word)).filter(Boolean) : []);
	}
	return lookalikeLists.get(code);
}

function isLookalike(token, needle) {
	return lookalikesFor().some((word) => word.length > needle.length && word.startsWith(needle) && token.startsWith(word));
}

// The forms a plain entry takes in a language that does not glue suffixes on (see parseKeywords). The
// locale lists the tails; which of them applies depends on how the word ends, which is spelling rather
// than vocabulary. null for a language whose plain entries are prefixes. Cached per language and word.
const wordFormCache = new Map();
function wordFormsFor(needle) {
	const code = locale();
	let cache = wordFormCache.get(code);
	if (!cache) {
		cache = { spec: tRaw('keywords.word_forms') ?? null, forms: new Map() };
		wordFormCache.set(code, cache);
	}
	const spec = cache.spec;
	if (!spec || typeof spec !== 'object') return null;
	let forms = cache.forms.get(needle);
	if (forms) return forms;
	forms = new Set([needle]);
	const add = (base, tails) => {
		for (const tail of tails ?? []) forms.add(`${base}${tail}`);
	};
	if (needle.endsWith('e')) {
		add(needle, spec.after_e); // delete -> deletes, deleted
		add(needle.slice(0, -1), spec.drop_e); // delete -> deleting
	} else {
		add(needle, spec.suffixes); // kick -> kicks, kicked, kicking
		// One short vowel before one final consonant doubles it: ban -> banned, pin -> pinning.
		if (spec.double_after && new RegExp(spec.double_after, 'u').test(needle)) add(`${needle}${needle.at(-1)}`, spec.doubled);
	}
	cache.forms.set(needle, forms);
	return forms;
}

/**
 * How much this utterance counts as "somebody said something". Normally its token count, but a
 * sentence whose letters normalize() cannot represent still counts as one thing said: it is real
 * speech from a real person, and the checks that look for an interjection have to see it.
 */
function utteranceWeight(utt) {
	if (utt.tokens.length) return utt.tokens.length;
	const letters = String(utt.text ?? '').replace(/[\s.,!?;:…"'()[\]-]+/gu, '');
	return letters.length >= 2 ? 1 : 0;
}

function matchesNeedle(token, needle, stem) {
	if (isLookalike(token, needle)) return false;
	if (!stem) {
		const forms = wordFormsFor(needle);
		if (forms) return forms.has(token);
	}
	if (!token.startsWith(needle)) return false;
	const tail = token.slice(needle.length);
	// "Do not delete" must never read as "delete". In Turkish the negative is built by gluing -ma/-me
	// straight onto the verb, so the negated word CONTAINS the positive one and a prefix match finds it:
	// heard live, "pardon, silme" opened the gate and fifty more messages went. A word carrying the
	// negative is not the command word, whichever way it was matched. The locale's pattern also knows the
	// negative after a verb made from a noun ("banlama", "kilitleme") and the verbal nouns that begin the
	// same way and are not negative at all ("silmeni istiyorum": I want you to delete it).
	if (tail) {
		const negative = negationFor();
		if (negative && negative.test(tail)) return false;
	}
	if (!stem && needle.length >= 3) return true;
	if (!tail) return true;
	const allowed = inflectionFor();
	return Boolean(allowed && allowed.test(tail));
}

function containsPhrase(tokens, phrase) {
	for (let start = 0; start + phrase.length <= tokens.length; start++) {
		if (phrase.every((word, k) => tokens[start + k] === word)) return true;
	}
	return false;
}

/**
 * Does this stretch of speech say yes, say no, or neither? The two-step confirmation reads the owner's
 * answer with it. The word lists are the locale's (keywords.confirm_yes / confirm_no) and are matched the
 * way the gate matches its own words, so "yesterday" is not a yes and "banned" is not a no. Entries of
 * more than one word ("go ahead", "leave it") match as a phrase.
 *
 * A no is looked for in every form it takes, because a yes word next to a no is not a yes, and in both
 * languages the no is easily missed. English glues it onto the verb ("shouldn't", read as "should not"
 * by spokenTokens). Turkish glues it onto whatever verb the answer is about: "tamam, banlama" is okay
 * followed by "do not ban", and the ban is nowhere in the yes words, so the locale describes the shape
 * of a negated verb (keywords.negative_word) and any word of that shape is a no. A yes word carrying the
 * negative ("yapma", "onaylamiyorum") is one as well.
 *
 * `action` is the command words of the thing being asked about. A no word that is also one of them is
 * the verb of the request, not a refusal of it: "yes, cancel it" to "should I cancel movie night?" is a
 * yes, and "okay, cancel" to "should I ban Sam?" is not.
 * @param {string} text
 * @param {{ action?: string[] }} [options]
 * @returns {{ yes: boolean, no: boolean }}
 */
export function readAnswer(text, { action = [] } = {}) {
	const tokens = spokenTokens(text);
	if (!tokens.length) return { yes: false, no: false };
	const matches = (list, entries) =>
		entries.some(({ needle, stem }) =>
			needle.includes(' ') ? containsPhrase(list, needle.split(' ')) : list.some((token) => matchesNeedle(token, needle, stem)),
		);
	const yesWords = parseKeywords(tRaw('keywords.confirm_yes'));
	const negative = negationFor();
	const negatedYes =
		Boolean(negative) &&
		tokens.some((token) =>
			yesWords.some(({ needle }) => token.length > needle.length && token.startsWith(needle) && negative.test(token.slice(needle.length))),
		);
	const negatedVerb = negativeWordFor();
	const negatedWord = Boolean(negatedVerb) && tokens.some((token) => negatedVerb.test(token));
	// The request's own verb is blanked out before the no words are looked for, so it can neither be one
	// nor join the words around it into a phrase.
	const actionWords = parseKeywords(action);
	const rest = actionWords.length ? tokens.map((token) => (actionWords.some(({ needle, stem }) => matchesNeedle(token, needle, stem)) ? '' : token)) : tokens;
	const refused = matches(rest, parseKeywords(tRaw('keywords.confirm_no')));
	return { yes: matches(tokens, yesWords), no: negatedYes || negatedWord || refused };
}

export class SpeakerAttribution {
	constructor({
		windowMs = 6000,
		speakWindowMs = 1500,
		transcriptWindowMs = 15_000,
		continuityMs = 60_000,
		trackMs = 120_000,
		frameMs = 20,
		ownerId = null,
		maxText = 400,
		now = Date.now,
	} = {}) {
		this.windowMs = windowMs;
		this.speakWindowMs = speakWindowMs;
		this.transcriptWindowMs = transcriptWindowMs;
		this.continuityMs = continuityMs;
		this.maxText = maxText;
		this.now = now;
		this.ownerId = ownerId ? String(ownerId) : null;
		this.frameMs = frameMs;
		this.audioMs = 0;
		this.track = []; // the last ~2 min: { startMs, endMs, owner, id } — audio position -> speaker
		this.trackMs = trackMs;
		// Where somebody other than the owner was in the SOUND, spoken or murmured or a fan: { startMs,
		// endMs }, merged, over the same two minutes. The track above cannot answer that: it keeps the
		// voices it could name, and two murmurs at once, or a murmur under a speaker, leave no name there.
		this.othersTrack = [];
		this.ownerAt = 0;
		this.otherAt = 0;
		this.ownerSeq = 0;
		this.otherSeq = 0;
		this.seq = 0;
		this.ownerText = '';
		this.ownerTextAt = 0;
		this.otherText = '';
		this.otherTextAt = 0;
		// Word level window, for EVERYONE: { word, at, owner, id, pos } (pos = audio position, null if none)
		this.words = [];
		this.lastPiece = null; // the previous transcript piece, to tell the rest of a word from a new one
		this.driftSamples = []; // { at, diff }: how far the transcript's positions ran ahead of our audio position
		this.driftModel = null; // { fit: { a, c } | null, max, recent }
		// Monotonic counter stamped on every noted fragment: two fragments can share a millisecond, so
		// ordering by `at` alone would let an interjection tie with the owner's command and slip past the gate.
		this.noteSeq = 0;
		// Utterances (consecutive fragments from the same person merged): { owner, id, at, startMs, endMs, text, tokens }
		this.utterances = [];
		// The moment the model's answer/delegation turn started: { at, audioMs }
		this.turn = null;
		// Which audio timeline the positions belong to: a new Live session starts its own at 0, and a
		// position from before that cannot be compared with one after it (see mark()).
		this.epoch = 0;
	}

	/** Compatibility: the owner's words inside the window. */
	get ownerWords() {
		return this.words.filter((entry) => entry.owner);
	}

	/**
	 * Called for every 20 ms audio frame (from the bridge).
	 * `sent` = was the frame really appended to the Live session; the audio position only advances then.
	 */
	onFrame({ priority = false, active = [], present = null, sent = true, frames = 1 } = {}) {
		this.seq++;
		const activeIds = active.map((id) => String(id));
		// The mixer hands over EVERY simultaneous speaker, loudest first. Keeping only the loudest is what
		// made two people at once look like one person, and put one person's sentence in another's mouth.
		// On the priority path the mixer physically discarded everybody else's audio before the frame was
		// summed, so the frame really does hold one voice: that is a fact about the audio, not a guess.
		const ids = priority ? (this.ownerId ? [this.ownerId] : activeIds.slice(0, 1)) : activeIds;
		// Who was IN the frame is a different list from who was speaking in it, and a stricter one: a voice
		// too quiet to clear the speech bar is still summed into the audio the model transcribes. "Alone"
		// has to mean alone in the sound, or somebody can speak quietly and have their words land under
		// another person's name, with that person's authority.
		const presentIds = Array.isArray(present) ? present.map((id) => String(id)) : ids;
		const ownerInMix = !priority && this.ownerId ? activeIds.includes(this.ownerId) : false;
		// "Somebody else" is anybody else in the sound, not only somebody the detector called a speaker.
		// Counting the speaking list alone was the hole: a guest with a fan in their microphone, speaking a
		// command a few dB over it right after the owner stopped, is never speaking by the adaptive bar (the
		// fan is their floor) and always present, so the frame-level test below saw nobody after the owner,
		// and the guest's words went into the record as the owner's. Reproduced through the real mixer: a
		// -40 dBFS fan and speech at -47 opened the gate under VAD=adaptive.
		// On the priority path "the owner" is whoever the mixer gave priority, configured owner or not.
		const own = priority ? (ids[0] ?? this.ownerId) : this.ownerId;
		const othersInSound = (!priority && activeIds.some((id) => id !== own)) || presentIds.some((id) => id !== own);
		if (priority) {
			this.ownerAt = this.now();
			this.ownerSeq = this.seq;
		} else if (ownerInMix) {
			this.ownerAt = this.now();
			this.ownerSeq = this.seq;
		}
		if (othersInSound) {
			this.otherAt = this.now();
			this.otherSeq = this.seq;
		}
		if (!sent) return;
		const span = Math.max(1, frames | 0) * this.frameMs; // two frames while a handover's backlog is paid back
		this._track(this.audioMs, this.audioMs + span, ids, presentIds);
		if (othersInSound) this._trackOthers(this.audioMs, this.audioMs + span);
		this.audioMs += span;
	}

	/** Somebody other than the owner was in the sound over this stretch (see othersTrack). */
	_trackOthers(startMs, endMs) {
		const list = this.othersTrack;
		const last = list[list.length - 1];
		if (last && last.endMs === startMs) last.endMs = endMs;
		else list.push({ startMs, endMs });
		const cutoff = endMs - this.trackMs;
		let drop = 0;
		while (drop < list.length - 1 && list[drop].endMs < cutoff) drop++;
		if (drop > 0) list.splice(0, drop);
	}

	/** Was anybody other than the owner in the sound anywhere in [from, to)? Sorted by endMs, like the track. */
	_othersIn(from, to) {
		const list = this.othersTrack;
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].endMs <= from) lo = mid + 1;
			else hi = mid;
		}
		return lo < list.length && list[lo].startMs < to;
	}

	_track(startMs, endMs, ids, presentIds = ids) {
		// Nobody cleared the speech bar, but exactly one person's voice was in the frame. That is somebody
		// talking quietly, and the model transcribes it whether our own ear called it speech or not:
		// measured live, a fragment could sit two seconds past the last thing we had recorded while the
		// speaker had never stopped. Recorded as a weak stretch -- good enough to put a name on a line,
		// never good enough to act on. Two quiet voices at once stay unrecorded: that really is a guess.
		const weak = !ids.length && presentIds.length === 1;
		if (weak) ids = presentIds;
		if (!ids.length) return; // silence is not recorded; the track keeps its gaps
		// The mixer orders by loudness, and the louder of two people swaps several times a second, so
		// ['a','b'] and ['b','a'] are the same 20 ms and have to merge. Comparing the raw list would push a
		// new segment on every swap and turn the two minute window into thousands of entries.
		const key =
			ids.length === 1
				? ids[0]
				: ids.length === 2
					? ids[0] < ids[1]
						? `${ids[0]}\u0000${ids[1]}`
						: `${ids[1]}\u0000${ids[0]}`
					: [...ids].sort().join('\u0000');
		// Alone in the sound, not merely alone in the speaking list.
		const solo = ids.length === 1 && presentIds.filter((id) => id !== ids[0]).length === 0;
		const last = this.track[this.track.length - 1];
		if (last && last.endMs === startMs && last.key === key && last.solo === solo && last.weak === weak) {
			last.endMs = endMs;
			return;
		}
		this.track.push({
			startMs,
			endMs,
			ids,
			key,
			solo,
			weak,
			// A derived cache, never a primary fact: "the owner was in this frame" is not the same claim as
			// "the owner said this", and keeping them apart is the whole point of the change.
			owner: this.ownerId !== null && ids.includes(this.ownerId),
		});
		const cutoff = endMs - this.trackMs;
		let drop = 0;
		while (drop < this.track.length - 1 && this.track[drop].endMs < cutoff) drop++;
		if (drop > 0) this.track.splice(0, drop);
	}

	/**
	 * Index of the first segment that can overlap `from`. The track is built from a counter that only
	 * moves forward and is only ever trimmed from the front, so it is sorted by endMs. Without this,
	 * every transcript delta walks two minutes of history, and deltas are shorter than a word.
	 */
	_firstAfter(from) {
		let lo = 0;
		let hi = this.track.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.track[mid].endMs <= from) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/**
	 * Id of the speaker that lines up with the transcript window (whoever owns the most audio time in it).
	 * Labelling by arrival time points at the wrong person in a busy channel.
	 */
	speakerIdAt(startMs, endMs) {
		return this.speakerShareAt(startMs, endMs).id;
	}

	/**
	 * Who was audible in this stretch of audio, and how much of it each of them holds.
	 *
	 * Two numbers, because they answer two different questions:
	 *  - share: how much of the audible time this person was IN. Two people talking over each other
	 *           throughout BOTH score 1.0. It answers "was this person here at all".
	 *  - solo:  how much of it they were the ONLY voice. Everybody's solo adds up to at most 1. It
	 *           answers "could these words only have come from them", which is the question worth asking
	 *           before acting on somebody's words: the model transcribes ONE summed frame and cannot pull
	 *           two voices back apart inside it.
	 *
	 * `heardMs` is the UNION of the audible time, not the sum of each person's: with a sum, two people
	 * talking at once would each score 0.5 and look half-certain instead of wholly uncertain.
	 *
	 * `id`/`share`/`speakers` are kept for callers that only want the headline. `share` there is the
	 * dominant speaker's SOLO fraction, which is the honest reading of "how much of this is safely theirs".
	 *
	 * @returns {{ heardMs: number, ranked: Array, id: string|null, share: number, speakers: number }}
	 */
	speakerShareAt(startMs, endMs) {
		if (!Number.isFinite(startMs)) return EMPTY_SHARE;
		const from = Math.max(0, startMs);
		const to = Number.isFinite(endMs) && endMs > from ? endMs : from + 400;
		const totals = new Map();
		let heardMs = 0;
		let strongMs = 0; // of the audible time, how much of it we would call speech rather than a murmur
		for (let i = this._firstAfter(from); i < this.track.length; i++) {
			const seg = this.track[i];
			if (seg.startMs >= to) break;
			const overlap = Math.min(seg.endMs, to) - Math.max(seg.startMs, from);
			if (overlap <= 0) continue;
			heardMs += overlap;
			if (!seg.weak) strongMs += overlap;
			for (const id of seg.ids) {
				let entry = totals.get(id);
				if (!entry) {
					entry = { id, ms: 0, soloMs: 0, share: 0, solo: 0 };
					totals.set(id, entry);
				}
				entry.ms += overlap;
				if (seg.solo) entry.soloMs += overlap;
			}
		}
		if (heardMs <= 0) return EMPTY_SHARE;
		const ranked = [...totals.values()];
		for (const entry of ranked) {
			entry.share = entry.ms / heardMs;
			entry.solo = entry.soloMs / heardMs;
		}
		// Deterministic, including the ties: otherwise an exact tie silently keeps whoever went into the
		// map first, which is the order the mixer happened to list them in that frame.
		ranked.sort((a, b) => b.ms - a.ms || b.soloMs - a.soloMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return { heardMs, strongMs, ranked, id: ranked[0].id, share: ranked[0].solo, speakers: ranked.length };
	}

	/**
	 * Who said the fragment covering this stretch, and how sure we are.
	 *   'sure'    - one voice held it on its own: safe to name and, if it is the owner, safe to act on
	 *   'leaning' - one voice is ahead but somebody else was in the audio too, or the answer came from
	 *               just outside the stretch: safe to put on a transcript line, never safe to act on
	 *   'unsure'  - the voices are tangled, or there is nothing to go on: name nobody
	 *
	 * `reason` says where the answer came from, and the gate reads it: 'direct' means this stretch of
	 * audio itself, 'nearby' means the audio around a pause, 'silence' means there was nothing at all.
	 * Only 'direct' is evidence about who said these words; the other two are inference about whose turn
	 * it was, which is enough to put a name on a line and never enough to act on one.
	 */
	resolveSpeaker(startMs, endMs) {
		const direct = this.speakerShareAt(startMs, endMs);
		// A stretch made only of murmur is an answer about whose turn it was, not about who said these
		// words, so it is reported the same way as an answer taken from around a pause.
		if (direct.ranked.length) {
			if (direct.strongMs > 0) return this._rank(direct, 'direct');
			// Murmur only. It can carry a name and it can never carry certainty, so it is capped the same
			// way an answer taken from around a pause is: enough for a transcript line, never for a command.
			const quiet = this._rank(direct, 'quiet');
			return quiet.confidence === 'sure' ? { ...quiet, confidence: 'leaning' } : quiet;
		}
		// Nothing in the stretch at all. Before calling that an overlap -- which it is not, and which is
		// what the bot was telling people -- look at the audio on either side of it.
		if (!Number.isFinite(startMs)) return { id: null, confidence: 'unsure', reason: 'silence', solo: 0, share: 0, speakers: 0, ids: [], heardMs: 0 };
		const to = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs;
		const near = this.speakerShareAt(startMs - NEAR_MS, to + NEAR_MS);
		if (!near.ranked.length) return { id: null, confidence: 'unsure', reason: 'silence', solo: 0, share: 0, speakers: 0, ids: [], heardMs: 0 };
		const ranked = this._rank(near, 'nearby');
		// One voice either side of the pause is that voice's pause.
		if (ranked.confidence === 'sure') return { ...ranked, confidence: 'leaning' };
		// Two voices either side of it: a hand-off. One voice at a time is sent, so this is not an overlap
		// -- the words are the tail of the one who stopped or the first word of the one who started, and
		// they belong to whichever is nearer the pause. Equally near, and nobody is named.
		const closest = this._closestSpeaker(startMs, to, ranked.ids);
		if (closest) return { ...ranked, id: closest, confidence: 'leaning' };
		return { ...ranked, id: null, confidence: 'unsure' };
	}

	/** Of these speakers, the one whose audio comes nearest to the stretch -- by a clear margin, or nobody. */
	_closestSpeaker(from, to, ids) {
		const distance = new Map();
		for (let i = this._firstAfter(from - NEAR_MS); i < this.track.length; i++) {
			const seg = this.track[i];
			if (seg.startMs >= to + NEAR_MS) break;
			const gap = seg.startMs > to ? seg.startMs - to : seg.endMs < from ? from - seg.endMs : 0;
			for (const id of seg.ids) {
				if (!ids.includes(id)) continue;
				const known = distance.get(id);
				if (known === undefined || gap < known) distance.set(id, gap);
			}
		}
		const sorted = [...distance.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
		if (!sorted.length) return null;
		if (sorted.length > 1 && sorted[1][1] - sorted[0][1] < CLOSE_MARGIN_MS) return null;
		return sorted[0][0];
	}

	_rank({ heardMs, ranked }, reason) {
		const top = ranked[0];
		const confidence = top.solo >= NAME_SOLO ? 'sure' : top.solo >= NAME_LEAN ? 'leaning' : 'unsure';
		return {
			id: confidence === 'unsure' ? null : top.id,
			confidence,
			reason,
			solo: top.solo,
			share: top.share,
			speakers: ranked.length,
			ids: ranked.map((entry) => entry.id),
			// Every candidate's numbers, not just the headline: the line pass (src/speakerpath.js) weighs a
			// runner-up against the neighbours of the fragment, and it has to weigh the same audio this did.
			ranked: ranked.map(({ id, solo, share }) => ({ id, solo, share })),
			heardMs,
		};
	}

	/**
	 * Does this transcript fragment sit on the owner's OWN audio? true / false / null (no record).
	 *
	 * "The owner held most of it" is not good enough and never was: while two voices are in the same
	 * frame the model transcribes their sum, so a word in that stretch may belong to either of them. The
	 * gate in front of the admin tools rests on this answer, so it is true only when the owner was the
	 * sole voice for at least GATE_SOLO of the stretch, which also bounds everybody else at 0.2.
	 * Everything else is false: an overlap must never open a gate, and a tie goes against the owner.
	 */
	speakerAt(startMs, endMs) {
		const hit = this.resolveSpeaker(startMs, endMs);
		// Only the audio under these words can say whose words they are. An answer inferred from the audio
		// around a pause is enough to put a name on a transcript line and is not evidence about a command.
		if (hit.reason !== 'direct' || !hit.ids.length) return null; // nothing to go on: not the same as "no"
		// There WAS audio here. Whether it names the owner or nobody, the answer is a definite one.
		return hit.solo >= GATE_SOLO && hit.id === this.ownerId;
	}

	/**
	 * New Live session: the server's audio timeline restarts at 0, so our position counter has to be
	 * reset too — otherwise the position drifts after a drop and the owner's own words stop matching.
	 * The gate state (ownerAt/words) is kept on purpose: across short drops the owner's words from a
	 * moment ago should stay valid. Audio positions from the old session cannot be compared with the new
	 * counter, so the positions are cleared while the arrival time stays.
	 */
	resetSession() {
		this.driftSamples = [];
		this.driftModel = null;
		this.audioMs = 0;
		this.epoch++;
		this.track = [];
		this.othersTrack = [];
		for (const entry of this.words) entry.pos = null;
		for (const utt of this.utterances) {
			utt.startMs = null;
			utt.endMs = null;
		}
		this.turn = null;
	}

	/** Is the audio we are sending right now (the last ~1.5 s) the owner's, with nobody else in the sound after? */
	ownerSpeakingNow() {
		if (!this.ownerAt) return false;
		if (this.now() - this.ownerAt > this.speakWindowMs) return false;
		return this.ownerSeq > this.otherSeq;
	}

	/**
	 * The owner's authority for words whose own audio says nothing about them: they sit in a pause
	 * ('nearby'), on a murmur ('quiet'), or nowhere at all ('silence', or no position). That used to be
	 * the frame-level test alone, and the frame-level test only knew about people the detector called
	 * speakers; a guest murmuring a command, or speaking it just over their own fan, was nobody, and the
	 * words were the owner's. Inference is allowed to carry the owner's authority only where there is
	 * nothing to infer it against: the answer was drawn from nobody's audio but the owner's, the owner is
	 * still the latest voice in the sound, and nobody else was in the sound at all around these words --
	 * the neighbourhood resolveSpeaker looked in, or, with no position, the last speakWindowMs. When in
	 * doubt, it is not the owner's word.
	 */
	_ownerAloneAround(startMs, endMs, hit) {
		if ((hit.ids ?? []).some((id) => id !== this.ownerId)) return false;
		if (!this.ownerSpeakingNow()) return false;
		if (Number.isFinite(startMs)) {
			const to = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs;
			return !this._othersIn(startMs - NEAR_MS, to + NEAR_MS);
		}
		return !this.otherAt || this.now() - this.otherAt > this.speakWindowMs;
	}

	/**
	 * Attributes text coming from the Live transcript to its speaker. When `startMs/endMs` (the audio
	 * position) is given the attribution follows the audio position; otherwise the arrival time is used
	 * (fallback path). When `owner`/`id` is given (local STT: one fragment per user) it is used directly.
	 *
	 * `reportedMs` is the fragment's own window when the caller judged it on another stretch (onTranscript
	 * does, for a fragment that got no further than the one before it): the name comes from the stretch,
	 * and the owner's authority needs the owner alone under both by the gate's own test, and nobody else in
	 * the sound anywhere in the stretch.
	 */
	noteTranscript(text, { startMs = null, endMs = null, owner: ownerOverride = null, id: idOverride = null, reportedMs = null } = {}) {
		const raw = String(text ?? '');
		const fragment = raw.trim();
		if (!fragment) return null;
		const at = this.now();
		const pos = Number.isFinite(startMs) ? startMs : null;
		const end = Number.isFinite(endMs) ? endMs : null;
		// On the local STT path the speaker is known for certain (one transcription per user) and is
		// passed in; the realtime path has to work it out from the audio position, and is allowed to come
		// back with nobody at all.
		const forced = typeof ownerOverride === 'boolean' || Boolean(idOverride);
		const hit = forced
			? {
					id: idOverride ? String(idOverride) : ownerOverride ? this.ownerId : null,
					confidence: 'sure',
					solo: 1,
					share: 1,
					speakers: 1,
					ids: [],
				}
			: this.resolveSpeaker(startMs, endMs);
		// Authority. Anything short of "the owner alone, for GATE_SOLO of the stretch" is two people's
		// speech summed into one frame and must not count as the owner's word, however loud they were.
		// This is the line that stops somebody riding on the owner's authority by talking at the same time.
		const direct = hit.reason === 'direct' && hit.ids.length > 0;
		let owner =
			typeof ownerOverride === 'boolean'
				? ownerOverride
				: direct
					// There was audio under these words. It either was the owner alone or it was not, and a
					// tangled stretch answers "not" -- falling back to the frame-level test here would hand the
					// owner's authority to an overlap, which is the whole thing this is guarding.
					? hit.solo >= GATE_SOLO && hit.id === this.ownerId
					: // Inferred, or nothing at all: only where nobody else was there to have said it.
						!Array.isArray(reportedMs) && this._ownerAloneAround(startMs, endMs, hit);
		// A fragment judged on another stretch than its own (see reportedMs) is the owner's only when both
		// stretches were the owner's alone. Judged on the last stretch alone, a guest's word reported at the
		// same point as the owner's previous one landed on the owner's audio: guest [0, 400) ms, owner
		// [400, 1400), guest [1400, 1600), and the guest's " ban" came back as [0, 1590] after the owner's
		// word at [450, 1590] -- the owner alone for 0.83 of that, and the gate opened.
		//
		// And alone for ALL of the stretch, not GATE_SOLO of it. Such a fragment was sent after the one before
		// it, for audio up to the same point, so its words are at the end of the stretch -- which is exactly
		// where somebody who speaks straight after the owner is, and exactly the fifth GATE_SOLO leaves to
		// somebody else. Without this, the same guest with no word of their own before the owner's (owner
		// [0, 1400), guest [1400, 1600), both reported as [0, 1590]) passed both tests at 0.88.
		if (owner && !forced && Array.isArray(reportedMs)) {
			owner = this.speakerAt(reportedMs[0], reportedMs[1]) === true && !this._othersIn(startMs, Number.isFinite(endMs) ? endMs : startMs);
		}
		// The name we are willing to put on it. 'leaning' is enough for a transcript line and never for
		// the gate, which reads `owner` above and is the stricter test.
		const id = hit.id ?? null;
		const sure = hit.confidence === 'sure';
		// Was the owner's voice in this audio at all? Kept apart from `owner`, which is the question of
		// whose WORD it is. In a real overlap nobody can be named, so without this the refusal could not
		// tell "somebody talked over you" from "you did not say it".
		const ownerIn = typeof ownerOverride === 'boolean' ? ownerOverride : this.ownerId !== null && hit.ids.includes(this.ownerId);
		const tokens = spokenTokens(fragment);
		// A delta is shorter than a word, so a word can arrive in two pieces: "edebilirs" then "in". Each
		// piece used to become a word of its own, a keyword split that way was never matched, and the
		// gate then walked past the owner's real command to an older word of somebody else's. A piece that
		// starts with a letter, follows a piece that ended with one, sits exactly where that piece ended in
		// the audio and belongs to the same speaker is the REST of that word. Local STT hands over whole
		// utterances, so nothing is glued on that path.
		const glue = !forced && this._continuesLastWord(raw, { owner, id, pos });
		const joiner = glue ? '' : ' ';
		if (owner) {
			this.ownerText = `${this.ownerText}${joiner}${fragment}`.slice(-this.maxText);
			this.ownerTextAt = at;
		} else {
			this.otherText = `${this.otherText}${joiner}${fragment}`.slice(-this.maxText);
			this.otherTextAt = at;
		}
		const seq = ++this.noteSeq;
		let rest = tokens;
		if (glue && tokens.length && this.words.length) {
			const last = this.words[this.words.length - 1];
			last.word += tokens[0];
			last.at = at;
			if (!sure) last.sure = false; // a word is only sure when every piece of it was
			rest = tokens.slice(1);
		}
		for (const word of rest) this.words.push({ word, at, owner, id, sure, ownerIn, pos, seq });
		this._pruneWords(at);
		this._noteUtterance({ owner, id, sure, at, seq, startMs: pos, endMs: end, text: fragment, tokens, glue: glue && tokens.length ? tokens[0] : null, whole: forced });
		this.lastPiece = forced ? null : { raw, owner, id: id ?? null, endMs: end, at };
		// Handed back so that the caller builds its line out of the SAME answer. Resolving the track
		// again downstream is how two parts of the code ended up disagreeing about who was talking.
		return {
			id,
			owner,
			sure,
			ownerIn,
			confidence: hit.confidence,
			reason: hit.reason ?? 'silence',
			solo: hit.solo,
			share: hit.share,
			speakers: hit.speakers,
			ids: hit.ids,
			ranked: hit.ranked ?? [],
			seq,
		};
	}

	_noteUtterance({ owner, id, sure = true, at, seq, startMs, endMs, text, tokens, glue = null, whole = false }) {
		const last = this.utterances[this.utterances.length - 1];
		// `sure` is part of the identity: a fragment that only leans towards somebody must not merge into
		// a certain utterance and launder itself into a fact.
		const sameSpeaker = last && last.owner === owner && (last.id ?? null) === (id ?? null) && last.sure === sure;
		const close =
			sameSpeaker &&
			(at - last.at <= UTTERANCE_GAP_MS ||
				(startMs !== null && last.endMs !== null && startMs - last.endMs <= UTTERANCE_GAP_MS && startMs >= last.startMs));
		if (close) {
			last.at = at;
			last.seq = seq;
			last.whole = last.whole === true && whole === true;
			if (endMs !== null) last.endMs = endMs;
			last.text = `${last.text}${glue !== null ? '' : ' '}${text}`.slice(-this.maxText);
			if (glue !== null && last.tokens.length) {
				last.tokens[last.tokens.length - 1] += glue;
				last.tokens.push(...tokens.slice(1));
			} else {
				last.tokens.push(...tokens);
			}
			if (last.tokens.length > 80) last.tokens.splice(0, last.tokens.length - 80);
			return;
		}
		// `whole`: a line handed over complete with its speaker (the local path, one transcription per person
		// and utterance), which starts a turn of its own; see requestSpeaker.
		this.utterances.push({ owner, id: id ?? null, sure, at, seq, startMs, endMs, text, tokens: [...tokens], glued: glue !== null, whole: whole === true });
		const cutoff = at - Math.max(this.transcriptWindowMs * 2, this.continuityMs);
		let drop = 0;
		while (drop < this.utterances.length - 1 && this.utterances[drop].at < cutoff) drop++;
		if (drop > 0) this.utterances.splice(0, drop);
		if (this.utterances.length > MAX_UTTERANCES) this.utterances.splice(0, this.utterances.length - MAX_UTTERANCES);
	}

	/**
	 * The transcript's clock against ours. Its positions are meant to be milliseconds of the audio we
	 * sent, and they are not: measured live they run ahead by about 1.3% -- +0.2 s at 40 s, +1.3 s at two
	 * minutes, +7.7 s at nine -- and faster while music plays, which reads like the far end padding the
	 * gaps between our packets with silence. Past the "nearby" tolerance every fragment lands where the
	 * track has no audio, and every line is nobody's: no owner, no commands, no gate, for the rest of the
	 * session. A fragment's end can never be later than the audio the far end has, so end minus our own
	 * position, at its largest over a window, is the offset (less whatever the transcript lags, which
	 * measured close to nothing). Called with every user fragment's end, before anything is looked up.
	 * @returns {number} the current offset in ms
	 */
	observeTranscript(endMs) {
		if (!Number.isFinite(endMs)) return this.transcriptDrift;
		const diff = endMs - this.audioMs;
		if (Math.abs(diff) > DRIFT_MAX_MS) return this.transcriptDrift;
		this.driftSamples.push({ at: this.audioMs, diff });
		const cutoff = this.audioMs - DRIFT_WINDOW_MS;
		while (this.driftSamples.length && this.driftSamples[0].at < cutoff) this.driftSamples.shift();
		// The upper envelope: the largest sample per bucket of our audio. A line through those maxima is the
		// offset as a function of time, which is what makes it known after a silence and gives it a rate.
		const maxima = new Map();
		let max = -Infinity;
		let recent = -Infinity;
		for (const sample of this.driftSamples) {
			const bucket = Math.floor(sample.at / DRIFT_BUCKET_MS);
			const current = maxima.get(bucket);
			if (current === undefined || sample.diff > current) maxima.set(bucket, sample.diff);
			if (sample.diff > max) max = sample.diff;
			if (this.audioMs - sample.at <= 2 * DRIFT_BUCKET_MS && sample.diff > recent) recent = sample.diff;
		}
		let fit = null;
		if (maxima.size >= DRIFT_MIN_BUCKETS) {
			let n = 0;
			let sx = 0;
			let sy = 0;
			let sxx = 0;
			let sxy = 0;
			for (const [bucket, y] of maxima) {
				const x = (bucket + 0.5) * DRIFT_BUCKET_MS;
				n++;
				sx += x;
				sy += y;
				sxx += x * x;
				sxy += x * y;
			}
			const den = n * sxx - sx * sx;
			if (den > 0) {
				const a = Math.min(DRIFT_MAX_RATE, Math.max(0, (n * sxy - sx * sy) / den));
				fit = { a, c: (sy - a * sx) / n };
			}
		}
		this.driftModel = { fit, max: Math.max(0, max), recent: Math.max(0, recent) };
		return this.transcriptDrift;
	}

	/** The offset now: the line through the envelope when there is one, the largest recent sample otherwise. */
	get transcriptDrift() {
		const model = this.driftModel;
		if (!model) return 0;
		if (!model.fit) return model.max;
		// The recent maximum is a floor under the line: the clock only ever runs ahead, and a line that
		// averages through the envelope must not put a fragment back in front of the audio.
		return Math.max(0, model.fit.a * this.audioMs + model.fit.c, model.recent);
	}

	/** How fast the transcript's clock runs ahead of ours, in ms per second of audio (0 until it is known). */
	get driftRate() {
		const fit = this.driftModel?.fit;
		return fit ? fit.a * 1000 : 0;
	}

	/** A transcript position in our timeline. */
	mapTranscriptMs(ms) {
		return Number.isFinite(ms) ? ms - this.transcriptDrift : ms;
	}

	/** Is this piece the rest of the word the previous piece ended in? (See noteTranscript.) */	/** Is this piece the rest of the word the previous piece ended in? (See noteTranscript.) */
	_continuesLastWord(raw, { owner, id, pos }) {
		const prev = this.lastPiece;
		if (!prev) return false;
		if (!/^[\p{L}\p{N}]/u.test(raw) || !/[\p{L}\p{N}]$/u.test(prev.raw)) return false;
		// "didn" then "n't": the rest of that word is a word of its own, "not" (see spokenTokens).
		if (/^n['’]t\b/u.test(raw)) return false;
		if (prev.owner !== owner || prev.id !== (id ?? null)) return false;
		// Pieces of one word arrive together. A piece arriving much later is a new thing said, whatever the
		// positions say: they touch when somebody goes straight on without a pause.
		if (this.now() - prev.at > GLUE_MS) return false;
		return pos !== null && prev.endMs !== null ? Math.abs(pos - prev.endMs) <= 1 : true;
	}

	_pruneWords(now = this.now()) {
		// The continuity window (60 s) keeps words around longer than the 15 s window does.
		const cutoff = now - Math.max(this.transcriptWindowMs, this.continuityMs);
		let drop = 0;
		while (drop < this.words.length && this.words[drop].at < cutoff) drop++;
		if (drop > 0) this.words.splice(0, drop);
		if (this.words.length > 400) this.words.splice(0, this.words.length - 400);
	}

	// ---------------------------------------------------------------- turn (the model's answer moment)

	/**
	 * The model started an answer/delegation: the audio position sent so far and the clock are marked.
	 * Utterances arriving AFTER this moment (people cutting in) do not enter this turn's gate decision.
	 */
	markTurn({ audioMs = this.audioMs, at = this.now() } = {}) {
		this.turn = { at, audioMs: Number.isFinite(audioMs) ? audioMs : null };
		return this.turn;
	}

	/** The active turn (when not stale). If `turn` is given (not undefined) that one is used; null = no cut-off. */
	_resolveTurn(turn, now) {
		if (turn !== undefined) return turn;
		if (!this.turn) return null;
		if (now - this.turn.at > TURN_TTL_MS) return null;
		return this.turn;
	}

	/**
	 * Did this entry (word/utterance) arrive before the turn started? When an audio position exists it is
	 * the one compared: at the moment of the turn `audioMs` of audio had been sent, so audio starting at
	 * or after that position comes AFTER the turn (strictly <). Without a position (the local path) the
	 * arrival time decides: an utterance noted in the same instant as the mark belongs to the turn (<=).
	 */
	_beforeTurn(entry, turn) {
		if (!turn) return true;
		const pos = entry.pos ?? entry.startMs ?? null;
		if (pos !== null && Number.isFinite(turn.audioMs)) return pos < turn.audioMs;
		return entry.at <= turn.at;
	}

	/**
	 * Who said the command word LAST inside the window? { owner, id, word, at }, or null.
	 * When a turn is marked, words that arrived after it started do not count (somebody cutting in does
	 * not change the decision).
	 * Continuity: even when the owner's word is older than the window (15 s) it stays valid within
	 * `continuityMs` (60 s) as long as nobody else has spoken since (the bot asked a question and the
	 * owner answered: "which role?" -> "chillz").
	 */
	commandSpeaker(keywords, { windowMs = this.transcriptWindowMs, continuityMs = this.continuityMs, turn = undefined } = {}) {
		const now = this.now();
		const cut = this._resolveTurn(turn, now);
		const needles = parseKeywords(keywords);
		if (!needles.length) return null;
		const heard = this.words.map((entry) => entry.word);
		let sawOther = false; // did somebody else speak in the scanned range (before the turn)
		for (let i = this.words.length - 1; i >= 0; i--) {
			const entry = this.words[i];
			const age = now - entry.at;
			if (age > Math.max(windowMs, continuityMs)) break;
			if (!this._beforeTurn(entry, cut)) continue;
			if (age > windowMs && (!entry.owner || sawOther)) break; // outside the window: only uninterrupted owner words
			if (!entry.owner) sawOther = true;
			for (const { word, needle, stem } of needles) {
				if (!matchesNeedle(entry.word, needle, stem)) continue;
				if (inLookalikePhrase(heard, i)) continue;
				return {
					owner: entry.owner,
					id: entry.id,
					sure: entry.sure !== false,
					// The owner is the likeliest voice here, but not the only one. The refusal has to be able
					// to say that, or "only the owner can do that" is a correct decision in misleading words.
					ownerOverlap: !entry.owner && entry.ownerIn === true,
					word,
					at: entry.at,
					seq: entry.seq ?? 0,
				};
			}
		}
		return null;
	}

	/**
	 * The last utterance before the turn started (whose, and what). The gate: if somebody else spoke
	 * after the owner's command but before the model's answer, the command could be theirs -> we ask for
	 * it again.
	 */
	lastUtterance({ windowMs = this.transcriptWindowMs, turn = undefined, minTokens = 1 } = {}) {
		const now = this.now();
		const cut = this._resolveTurn(turn, now);
		for (let i = this.utterances.length - 1; i >= 0; i--) {
			const utt = this.utterances[i];
			if (now - utt.at > windowMs) break;
			if (!this._beforeTurn(utt, cut)) continue;
			// Tokens come out of normalize(), which keeps only a-z0-9, so a sentence in Cyrillic, Greek,
			// Arabic or Chinese tokenises to NOTHING. Skipping on the token count alone therefore made this
			// check -- the one that catches somebody cutting in between the owner's command and the answer
			// -- blind to every language that is not written in Latin letters, which is a way to get a ban
			// past the gate by talking over the owner in another alphabet. The text itself is the fallback.
			if (utteranceWeight(utt) < minTokens) continue;
			// `sure` travels with it so the gate can tell a clean interjection (somebody took the floor and
			// said their own thing) from a leaning one (their voice merely bled into the owner's at the
			// boundary). Only the first should be allowed to veto the owner's command.
			return { owner: utt.owner, id: utt.id, sure: utt.sure !== false, text: utt.text, at: utt.at, seq: utt.seq ?? 0, tokens: utt.tokens.length };
		}
		return null;
	}

	/**
	 * Whose request a turn answers. The last line before the turn is where the request ends, and the lines
	 * that ran into it (less than OWNER_SPEECH_GAP_MS apart, the pause ownerUtterance joins the owner's
	 * words across) are the rest of it. It is one person's only when every line of that run carries the
	 * same name: a guest asking and the owner saying "hmm" before the model answered is two people, and the
	 * audio cannot tell whose request it was. `sure` and `owner` are true only when they are true of every
	 * line of the run.
	 * @returns {{ id: string|null, owner: boolean, sure: boolean, shared: boolean }|null} null when nothing was heard
	 */
	requestSpeaker({ windowMs = this.transcriptWindowMs, turn = undefined } = {}) {
		const now = this.now();
		const cut = this._resolveTurn(turn, now);
		let run = null;
		let first = null; // the earliest line of the run so far
		for (let i = this.utterances.length - 1; i >= 0; i--) {
			const utt = this.utterances[i];
			if (now - utt.at > windowMs) break;
			if (!this._beforeTurn(utt, cut)) continue;
			if (utteranceWeight(utt) < 1) continue;
			if (!run) {
				run = { id: utt.id ?? null, owner: utt.owner === true, sure: utt.sure !== false, shared: false };
				// A line handed over whole with its speaker (the local path) was a turn of its own: the request
				// is that line, and whoever spoke a moment before it had a turn of their own too.
				if (utt.whole === true) return run;
				first = utt;
				continue;
			}
			const gap = Number.isFinite(first.startMs) && Number.isFinite(utt.endMs) ? first.startMs - utt.endMs : first.at - utt.at;
			if (gap > OWNER_SPEECH_GAP_MS) break;
			if ((utt.id ?? null) !== run.id) return { id: null, owner: false, sure: false, shared: true };
			if (utt.owner !== true) run.owner = false;
			if (utt.sure === false) run.sure = false;
			first = utt;
		}
		return run;
	}

	/**
	 * What the owner said last, before the turn: their most recent stretch of speech, in their own
	 * words. Consecutive owner utterances are joined; somebody else's voice merely bleeding in at a
	 * boundary (a leaning fragment) is skipped; a CLEAN utterance of somebody else's ends the search, and
	 * when it came after the owner's words the answer is null -- somebody cut in. This is what the gate
	 * hands to Jev when the keywords did not match: the phrasing the keyword list did not think of, in a
	 * language that inflects a verb out of a prefix match.
	 * @returns {{ text: string, at: number, seq: number, sure: true }|null}
	 */
	ownerUtterance({ windowMs = this.transcriptWindowMs, turn = undefined } = {}) {
		const now = this.now();
		const cut = this._resolveTurn(turn, now);
		const parts = [];
		let seq = 0;
		let latestAt = 0;
		let prevAt = 0;
		let sure = false;
		for (let i = this.utterances.length - 1; i >= 0; i--) {
			const utt = this.utterances[i];
			if (now - utt.at > windowMs) break;
			if (!this._beforeTurn(utt, cut)) continue;
			const owners = utt.owner || (this.ownerId !== null && utt.id === this.ownerId);
			if (!owners) {
				if (utt.sure === false) continue; // a voice bleeding into the owner's at the boundary
				if (!parts.length) return null; // somebody else spoke last, cleanly
				break;
			}
			if (parts.length && prevAt - utt.at > OWNER_SPEECH_GAP_MS) break;
			if (!parts.length) {
				seq = utt.seq ?? 0;
				latestAt = utt.at;
			}
			prevAt = utt.at;
			if (utt.owner) sure = true;
			parts.unshift({ text: utt.text, glued: utt.glued === true });
		}
		// Gate-grade requires at least one stretch that was the owner ALONE; a run of leaning fragments
		// that merely carry the owner's id is not evidence about a command.
		if (!parts.length || !sure) return null;
		let text = '';
		for (let i = 0; i < parts.length; i++) text += (i && !parts[i].glued ? ' ' : '') + parts[i].text;
		return { text: text.trim().slice(-300), at: latestAt, seq, sure: true };
	}

	/**
	 * A point in the conversation to measure "after" from: how far our audio had got, the clock, and the
	 * fragment counter. The two-step confirmation takes one when it asks its question, so that only what
	 * is said AFTER the question can answer it.
	 */
	mark() {
		return { at: this.now(), audioMs: this.audioMs, seq: this.noteSeq, epoch: this.epoch };
	}

	/**
	 * What the owner has said since `mark`, up to the turn: the answer to a question the bot put.
	 *
	 * Only the owner's own words count, by the gate's own test (the owner alone in the audio under them),
	 * so somebody else's "yes" is not an answer and neither is a "yes" said over the owner. "Since" goes by
	 * the audio position when the mark and the word share a timeline -- a transcript arriving late still
	 * belongs where it was spoken, and a "yes" said before the question was even asked is not an answer
	 * to it -- and by the fragment counter otherwise (the local path, or a Live session that restarted in
	 * between). A clean utterance of somebody else's after the owner's last word leaves no answer at all:
	 * the question may have been answered over the owner's head.
	 * @returns {{ text: string, at: number, seq: number }|null}
	 */
	ownerSpeechSince(mark, { turn = undefined } = {}) {
		if (!mark) return null;
		const cut = this._resolveTurn(turn, this.now());
		const positions = mark.epoch === this.epoch && Number.isFinite(mark.audioMs);
		const said = [];
		let at = 0;
		let seq = 0;
		for (const entry of this.words) {
			if (!entry.owner || !this._beforeTurn(entry, cut)) continue;
			const after = positions && entry.pos !== null ? entry.pos >= mark.audioMs : (entry.seq ?? 0) > (mark.seq ?? 0);
			if (!after) continue;
			said.push(entry.word);
			at = entry.at;
			seq = entry.seq ?? 0;
		}
		if (!said.length) return null;
		const last = this.lastUtterance({ turn: cut });
		if (last && !last.owner && last.sure !== false && last.seq > seq) return null;
		return { text: said.join(' '), at, seq };
	}

	/**
	 * Could the transcript of the utterance that triggered the turn still be on its way? (Yes when the
	 * last utterance's audio position is well behind the turn.) In that case the gate waits a moment.
	 */
	transcriptLagging({ turn = undefined, lagMs = 3000 } = {}) {
		const now = this.now();
		const cut = this._resolveTurn(turn, now);
		if (!cut) return false;
		const last = this.utterances[this.utterances.length - 1];
		if (!last) return true;
		if (Number.isFinite(cut.audioMs) && last.endMs !== null) return last.endMs < cut.audioMs - lagMs;
		return last.at < cut.at - lagMs;
	}

	// ---------------------------------------------------------------- legacy (frame level) gate helpers

	/**
	 * Which of these words did the owner say within the last `windowMs`? (null when none)
	 * Only words inside the window are looked at; a ban command spoken minutes ago does not open the gate.
	 * In a suffixing language a keyword rarely shows up bare (the root picks up inflections), so words of
	 * three letters or more are matched as a prefix while a stem entry matches its own inflections.
	 */
	ownerMatch(words, windowMs = this.transcriptWindowMs) {
		const now = this.now();
		const tokens = this.words.filter((entry) => entry.owner && now - entry.at <= windowMs).map((entry) => entry.word);
		if (!tokens.length) return null;
		for (const { word, needle, stem } of parseKeywords(words)) {
			if (tokens.some((token, index) => matchesNeedle(token, needle, stem) && !inLookalikePhrase(tokens, index))) return word;
		}
		return null;
	}

	/** Did the owner really say one of these words within the last `windowMs`? */
	ownerSaidRecently(words, windowMs = this.transcriptWindowMs) {
		return this.ownerMatch(words, windowMs) !== null;
	}

	/**
	 * Frame level gate: the most recently heard audio must be the owner's and must not be too old. It
	 * closes if somebody else spoke after the owner. The admin tools now decide with `commandSpeaker`
	 * (who said the command); this is left only for keyword-less/legacy callers.
	 */
	isOwnerActive() {
		if (!this.ownerSeq) return false;
		if (this.now() - this.ownerAt > this.windowMs) return false;
		return this.ownerSeq > this.otherSeq;
	}

	/** Short status snapshot for debugging/telemetry. */
	state() {
		return {
			ownerAt: this.ownerAt,
			otherAt: this.otherAt,
			ownerActive: this.isOwnerActive(),
			ownerText: this.ownerText.slice(-120),
			turn: this.turn,
		};
	}
}
