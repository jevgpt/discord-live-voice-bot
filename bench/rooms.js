// Synthetic rooms with the answers written down. A room is a script (who says which word when), turned
// into what the bot would really receive: every speaker's 20 ms packets, with network jitter and loss,
// through the real SpeakerMixer (floor control, owner priority, pre-roll, AGC, all as a live session
// builds it); and the transcript a far end would send back for what the mixer actually sent, as
// sub-word pieces with positions on the far end's own clock, late, jittered and drifting.
//
// The ground truth survives the mixer because it rides in the audio. Every packet carries its serial
// number in the signs of thirty samples of its own, a window no other speaker writes to: a gain keeps a
// sign, the soft clip keeps a sign, and a sum of voices adds nothing to a window only one of them uses.
// So for every frame that went out, the decoder below reads back which speaker's which word it held --
// including the pre-roll paid back two frames a tick after a handover, which no model of the mixer
// written from the outside would get right.
//
// Everything is seeded. The same scenario and seed give the same room, byte for byte.
import { SAMPLES_PER_FRAME_24K, SpeakerMixer } from '../src/audio.js';

export const FRAME_MS = 20;
const TAG_SAMPLES = 30; // one window per speaker: a marker, 28 serial bits, a parity bit
const TAG_LEVEL = 90; // under the presence bar, so the tag never makes anybody "present"
const MAX_VOICES = 6;
const VOICE_FROM = TAG_SAMPLES * MAX_VOICES; // the audible part of a frame starts after the tag windows
// The far end's own voice activity: how long a silence ends one of its utterances.
const FAR_END_SILENCE_MS = 550;
// The model starts answering this long after the last word it heard (its silence detection, then the
// first audio of the answer); the tool call behind a command arrives this long after that.
const TURN_AFTER_MS = 900;
const GATE_AFTER_MS = 1500;

// ---------------------------------------------------------------- random numbers

/** A small seeded generator (mulberry32) with the draws the rooms need. */
export function rng(seed) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		range: (a, b) => a + (b - a) * next(),
		int: (a, b) => a + Math.floor((b - a + 1) * next()),
		chance: (p) => next() < p,
		pick: (list) => list[Math.floor(next() * list.length)],
		/** Normal, by Box-Muller, cut at three deviations: a position is never wildly off. */
		normal(sd) {
			const u = Math.max(1e-9, next());
			const v = next();
			const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
			return Math.max(-3, Math.min(3, z)) * sd;
		},
	};
}

// ---------------------------------------------------------------- the script

const letters = (token) => token.replace(/[^\p{L}\p{N}]/gu, '').length;

/** Who says which word when, on the wall clock. */
export class Script {
	constructor(rand) {
		this.rand = rand;
		this.words = [];
		this.utterances = [];
	}

	/**
	 * One stretch of speech. Returns when it ends, so that a script reads as a conversation.
	 * @param {string} speaker
	 * @param {string} text
	 * @param {number} at wall ms
	 * @param {{ rate?: number, quiet?: boolean, command?: string|null }} [options]
	 *   quiet: under the speech bar (a murmur); command: the gate keyword group this line asks for
	 */
	say(speaker, text, at, { rate = 1, quiet = false, command = null } = {}) {
		const tokens = String(text).split(/\s+/u).filter(Boolean);
		// One mouth says one thing at a time: a stretch that would start inside the same person's previous
		// one starts just after it instead.
		const own = this.utterances.findLast((utt) => utt.speaker === speaker);
		if (own && own.end + 150 > at) at = own.end + 150;
		const utt = { index: this.utterances.length, speaker, text, at: Math.round(at), words: [], command, quiet };
		let t = Math.round(at);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			// About what a syllable and a half takes per letter, with a floor for the shortest words.
			const duration = Math.round((80 + 58 * Math.max(1, letters(token))) * rate * this.rand.range(0.85, 1.15));
			const word = { id: this.words.length, speaker, text: token, start: t, end: t + duration, utt: utt.index, quiet };
			this.words.push(word);
			utt.words.push(word);
			t += duration;
			if (i < tokens.length - 1) {
				const pause = /[,;:]$/u.test(token) ? this.rand.range(180, 320) : /[.!?]$/u.test(token) ? this.rand.range(300, 450) : this.rand.range(40, 140);
				t += Math.round(pause);
			}
		}
		utt.end = t;
		this.utterances.push(utt);
		return t;
	}
}

// ---------------------------------------------------------------- packets

/** Writes a packet serial into this speaker's tag window, signs only. */
function writeTag(pcm, slot, serial) {
	const base = slot * TAG_SAMPLES;
	let parity = 0;
	pcm[base] = TAG_LEVEL;
	for (let bit = 0; bit < 28; bit++) {
		const one = (serial >>> bit) & 1;
		parity ^= one;
		pcm[base + 1 + bit] = one ? TAG_LEVEL : -TAG_LEVEL;
	}
	pcm[base + 29] = parity ? TAG_LEVEL : -TAG_LEVEL;
}

/** Every serial in one 20 ms chunk of what the mixer sent. */
function readTags(chunk, voices) {
	const found = [];
	for (let slot = 0; slot < voices; slot++) {
		const base = slot * TAG_SAMPLES;
		if (Math.abs(chunk[base]) < 8) continue;
		let serial = 0;
		let parity = 0;
		for (let bit = 0; bit < 28; bit++) {
			if (chunk[base + 1 + bit] > 0) {
				serial |= 1 << bit;
				parity ^= 1;
			}
		}
		if ((chunk[base + 29] > 0 ? 1 : 0) !== parity) continue; // a window two voices wrote to: never happens
		found.push(serial);
	}
	return found;
}

/**
 * One packet's audio. Speech is a tone at the speaker's own pitch well over the speech bar; a murmur sits
 * between the presence bar and the speech bar; the room between words is under both.
 */
function packet(slot, serial, kind, rand) {
	const pcm = new Int16Array(SAMPLES_PER_FRAME_24K);
	writeTag(pcm, slot, serial);
	const level = kind === 'speech' ? rand.range(2400, 3400) : kind === 'murmur' ? rand.range(260, 340) : rand.range(70, 110);
	const pitch = 140 + 35 * slot;
	const phase = rand.range(0, 2 * Math.PI);
	for (let i = VOICE_FROM; i < SAMPLES_PER_FRAME_24K; i++) pcm[i] = Math.round(level * Math.sin(phase + (2 * Math.PI * pitch * i) / 24_000));
	return pcm;
}

/**
 * Every speaker's packets: what they send and when it arrives. A speaker transmits from the start of
 * what they say to a tenth of a second after it, and nothing in between their stretches of speech, which
 * is how Discord behaves: no packets while somebody is silent.
 */
function packetsFor(script, speakers, rand, { jitter = 0.04, maxDelay = 2, loss = 0.002 } = {}) {
	const serials = [null]; // serial -> { speaker, word } (0 is never used)
	const byTick = new Map(); // arrival tick -> [{ speaker, pcm }]
	for (const [slot, speaker] of speakers.entries()) {
		const spans = script.utterances.filter((utt) => utt.speaker === speaker).map((utt) => ({ from: utt.at, to: utt.end + 100, quiet: utt.quiet, words: utt.words }));
		let lastArrival = -1;
		for (const span of spans) {
			for (let tick = Math.floor(span.from / FRAME_MS); tick * FRAME_MS < span.to; tick++) {
				const from = tick * FRAME_MS;
				const word = span.words.find((w) => Math.min(w.end, from + FRAME_MS) - Math.max(w.start, from) >= FRAME_MS / 2) ?? null;
				const kind = word ? (span.quiet ? 'murmur' : 'speech') : 'room';
				const serial = serials.length;
				serials.push({ speaker, word: word ? word.id : null, kind });
				if (rand.chance(loss)) continue;
				const delay = rand.chance(jitter) ? rand.int(1, maxDelay) : 0;
				const arrival = Math.max(lastArrival, tick + delay);
				lastArrival = arrival;
				let list = byTick.get(arrival);
				if (!list) byTick.set(arrival, (list = []));
				list.push({ speaker, pcm: packet(slot, serial, kind, rand) });
			}
		}
	}
	return { serials, byTick };
}

// ---------------------------------------------------------------- the audio path

/**
 * The real mixer over the room, configured the way GuildSession configures it. Returns every frame the
 * attribution would be handed and, for every 20 ms of audio that went out, whose words were in it.
 */
function mixRoom(script, speakers, ownerId, config, rand) {
	if (speakers.length > MAX_VOICES) throw new Error(`a room has room for ${MAX_VOICES} voices, not ${speakers.length}`);
	const { serials, byTick } = packetsFor(script, speakers, rand, config.packets);
	const mixer = new SpeakerMixer({ floorControl: config.floorControl, agc: config.agc, primeFrames: config.primeFrames, vad: config.vad });
	if (config.ownerPriority && ownerId) mixer.setPriority(ownerId);
	// The decoder's concealment: the last packet again, fading, for the few frames the mixer asks for. The
	// tag fades with it and still reads back, as the same word: that is what the decoder's guess is.
	const lastPacket = new Map();
	for (const speaker of speakers) {
		mixer.setConcealer(speaker, () => {
			const last = lastPacket.get(speaker);
			if (!last) return null;
			const faded = last.map((v) => Math.round(v * 0.7));
			lastPacket.set(speaker, faded);
			return faded;
		});
	}
	const endTick = Math.ceil((Math.max(0, ...script.utterances.map((utt) => utt.end)) + 4000) / FRAME_MS);
	const frames = [];
	const slots = []; // { pos, wall, voices: [{ speaker, word, kind }] }
	let pos = 0;
	for (let tick = 0; tick <= endTick; tick++) {
		for (const { speaker, pcm } of byTick.get(tick) ?? []) {
			mixer.push(speaker, pcm);
			lastPacket.set(speaker, pcm);
		}
		const frame = mixer.tick();
		const count = frame.frames ?? 1;
		frames.push({ priority: frame.priority, active: [...frame.active], present: [...(frame.present ?? [])], others: [...(frame.others ?? [])], frames: count });
		for (let c = 0; c < count; c++) {
			const chunk = frame.pcm.subarray(c * SAMPLES_PER_FRAME_24K, (c + 1) * SAMPLES_PER_FRAME_24K);
			const voices = readTags(chunk, speakers.length)
				.map((serial) => serials[serial])
				.filter(Boolean);
			slots.push({ pos, wall: tick * FRAME_MS, voices });
			pos += FRAME_MS;
		}
	}
	return { frames, slots };
}

// ---------------------------------------------------------------- the far end

/**
 * What the transcriber sends back for the audio it was sent. Words that mostly never went out (floor
 * control dropped them) are not heard; words that went out under another voice are heard only some of
 * the time. The far end cuts its own utterances at its own silences, splits words into pieces, and sends
 * every piece once it has heard `lookahead` past it, reporting the window of the utterance so far (see
 * onTranscript) on its own clock: `drift` faster than ours and `positionSd` off either way. The last
 * piece before a pause is, `lateInPause` of the time, only sent from well inside the pause -- the
 * fragments measured live 500 to 1000 ms past the last audio heard. Every piece arrives `lag` after the
 * far end had the audio it reports.
 */
function transcribe(script, slots, rand, config) {
	const {
		drift = 0.013,
		lookahead = [0, 150],
		positionSd = 40,
		lag = [80, 60],
		split = 0.15,
		lateInPause = 0.3,
		windows = 'cumulative',
	} = config.transcript ?? {};
	const cover = new Map(); // word id -> { first, last, count, crowded }: its first and last slot, how many went out, how many under another voice
	for (const slot of slots) {
		const speech = slot.voices.filter((voice) => voice.word !== null);
		for (const voice of speech) {
			let entry = cover.get(voice.word);
			if (!entry) cover.set(voice.word, (entry = { first: slot, last: slot, count: 0, crowded: 0 }));
			entry.last = slot;
			entry.count++;
			if (speech.length > 1) entry.crowded++;
		}
	}
	const heard = [];
	for (const word of script.words) {
		const entry = cover.get(word.id);
		if (!entry) continue;
		const sentMs = entry.count * FRAME_MS;
		if (sentMs < Math.max(40, 0.5 * (word.end - word.start))) continue; // mostly never went out
		if (entry.crowded > entry.count / 2 && !rand.chance(0.5)) continue; // lost under another voice
		if (word.quiet && !rand.chance(0.7)) continue; // a murmur is transcribed only some of the time
		heard.push({ word, from: entry.first.pos, to: entry.last.pos + FRAME_MS });
	}
	heard.sort((a, b) => a.from - b.from || a.word.id - b.word.id);
	const wallAt = (pos) => {
		const index = Math.min(slots.length - 1, Math.max(0, Math.floor(pos / FRAME_MS)));
		return slots[index].wall;
	};
	const far = (pos) => pos * (1 + drift);
	const lastPos = slots.at(-1).pos;
	const fragments = [];
	let uttStart = null;
	let prevTo = -Infinity;
	let prevEnd = null;
	let arrival = 0;
	for (let i = 0; i < heard.length; i++) {
		const { word, from, to } = heard[i];
		if (from - prevTo >= FAR_END_SILENCE_MS) {
			uttStart = Math.max(0, prevTo, from - 150);
			prevEnd = null;
		}
		prevTo = to;
		const nextFrom = heard[i + 1]?.from ?? Infinity;
		// Pieces: a longer word sometimes arrives as two ("edebilirs" + "in").
		const n = letters(word.text);
		const cuts = [];
		if (n >= 5 && rand.chance(split)) cuts.push(rand.int(2, n - 2));
		const pieces = [];
		let at = 0;
		for (const cut of [...cuts, null]) {
			// Cut after the `cut`-th letter, punctuation included where it falls.
			let end = word.text.length;
			if (cut !== null) {
				let seen = 0;
				for (end = 0; end < word.text.length && seen < cut; end++) if (/[\p{L}\p{N}]/u.test(word.text[end])) seen++;
			}
			pieces.push({ text: word.text.slice(at, end), share: (cut ?? n) / n });
			at = end;
		}
		for (const [k, piece] of pieces.entries()) {
			let end = from + (to - from) * piece.share + rand.range(lookahead[0], lookahead[1]) + rand.normal(positionSd);
			const last = k === pieces.length - 1;
			if (last && nextFrom - to >= 700 && rand.chance(lateInPause)) end = to + rand.range(300, Math.min(1000, nextFrom - to - 100));
			// "How far the utterance has got" only moves forward.
			const start = windows === 'cumulative' || prevEnd === null ? uttStart : prevEnd;
			end = Math.min(lastPos, Math.max(end, prevEnd ?? from + FRAME_MS));
			arrival = Math.max(arrival, wallAt(end) + lag[0] + Math.abs(rand.normal(lag[1])));
			fragments.push({ text: `${k === 0 ? ' ' : ''}${piece.text}`, rs: Math.round(far(start)), re: Math.round(far(end)), arrival: Math.round(arrival), truth: word.speaker, word: word.id });
			prevEnd = end;
		}
	}
	return fragments;
}

// ---------------------------------------------------------------- turns

/**
 * Where the model answers a command and where the tool call behind it is judged, and what the answer
 * should be: the gate opens when the owner said it and nobody else was heard between it and the answer.
 */
function turnsFor(script, fragments, slots, ownerId) {
	const heardWords = new Set(fragments.map((fragment) => fragment.word));
	const lastSlot = new Map();
	for (const slot of slots) for (const voice of slot.voices) if (voice.word !== null) lastSlot.set(voice.word, slot);
	const turns = [];
	for (const utt of script.utterances) {
		if (!utt.command) continue;
		const said = utt.words.filter((word) => heardWords.has(word.id));
		if (!said.length) continue; // never reached the model: nothing to answer
		const end = lastSlot.get(said.at(-1).id);
		const turnWall = end.wall + TURN_AFTER_MS;
		const turnPos = end.pos + TURN_AFTER_MS;
		const interrupted = fragments.some((fragment) => {
			const word = script.words[fragment.word];
			const slot = lastSlot.get(word.id);
			return word.speaker !== utt.speaker && word.utt !== utt.index && slot && slot.pos > end.pos && slot.pos < turnPos;
		});
		turns.push({
			speaker: utt.speaker,
			text: utt.text,
			group: utt.command,
			turnWall,
			gateWall: turnWall + GATE_AFTER_MS,
			owner: utt.speaker === ownerId,
			shouldOpen: utt.speaker === ownerId && !interrupted,
		});
	}
	return turns;
}

// ---------------------------------------------------------------- scenarios

const TR = [
	'bence bu akşam maç çok iyi geçecek',
	'dün akşam siz ne yaptınız',
	'ben işten yeni geldim, çok yorgunum',
	'şu şarkıyı bir daha açsana',
	'yarın sabah erkenden çıkmamız lazım',
	'bu oyunun yeni sezonu ne zaman geliyor',
	'haftaya hep birlikte sinemaya gidelim',
	'o zaman ben de gelirim valla',
	'hava bugün gerçekten çok güzel',
	'annemler bu hafta sonu bize gelecek',
	'sen de mi o diziyi izliyorsun',
	'toplantı yine uzadı, bitmek bilmedi',
	'kardeşim bu işi halledebilirsin bence',
	'akşam yemeğinde ne yiyeceğiz',
];
const EN = [
	'i think the match tonight is going to be great',
	'what did you guys do last night',
	'i just got back from work, i am exhausted',
	'can you play that song again',
	'we should leave early tomorrow morning',
	'when is the new season coming out',
	'let us all go to the cinema next week',
	'honestly the weather is really nice today',
	'are you watching that show as well',
	'my parents are coming over this weekend',
	'the meeting ran long again, it never ended',
	'what are we having for dinner tonight',
];
const BACKCHANNEL_TR = ['hı hı', 'evet', 'aynen', 'mm', 'tabii'];
const BACKCHANNEL_EN = ['mm', 'yeah', 'right', 'uh huh', 'sure'];

const OWNER = 'o';
const GUEST = 'a';
const THIRD = 'b';
const FOURTH = 'c';
const DEFAULTS = {
	ownerId: OWNER,
	speakers: [OWNER, GUEST, THIRD],
	locale: 'en',
	floorControl: true,
	ownerPriority: true,
	agc: true,
	primeFrames: 2,
	// The voice detector the live session uses by default (VAD in .env): the rooms are scored on the audio
	// path as it runs, not as it ran before the detector changed.
	vad: 'adaptive',
	packets: {},
	transcript: {},
};

/** A few people taking turns, `gap` apart, each saying one or two sentences from `pool`. */
function turns(script, rand, { pool, people, count, gap = [250, 700], at = 300 }) {
	let t = at;
	let previous = null;
	for (let i = 0; i < count; i++) {
		const choices = people.filter((person) => person !== previous);
		const who = rand.pick(choices);
		previous = who;
		t = script.say(who, rand.pick(pool), t);
		if (rand.chance(0.3)) t = script.say(who, rand.pick(pool), t + rand.range(200, 400));
		t += rand.range(gap[0], gap[1]);
	}
	return t;
}

export const SCENARIOS = [
	{
		name: 'single',
		about: 'one guest talking, sentence after sentence',
		locale: 'tr',
		build(script, rand) {
			let t = 300;
			for (let i = 0; i < 8; i++) t = script.say(GUEST, rand.pick(TR), t) + rand.range(250, 900);
		},
	},
	{
		name: 'handovers',
		about: 'three people taking clean turns; the owner gives a command',
		locale: 'tr',
		build(script, rand) {
			let t = turns(script, rand, { pool: TR, people: [OWNER, GUEST, THIRD], count: 8 });
			t = script.say(OWNER, 'Melis sus', t, { command: 'setting' }) + 2600;
			turns(script, rand, { pool: TR, people: [GUEST, THIRD, OWNER], count: 5, at: t });
		},
	},
	{
		name: 'interruption',
		about: 'a monologue past eight seconds, taken over by somebody talking over it',
		locale: 'tr',
		build(script, rand) {
			let t = 300;
			for (let round = 0; round < 3; round++) {
				const start = t;
				for (let i = 0; i < 4; i++) t = script.say(GUEST, rand.pick(TR), t) + rand.range(120, 220);
				// Talking over the monologue near its ninth second, for long enough to take the floor.
				const cut = Math.max(start + 8500, t - 2600);
				const over = script.say(THIRD, `${rand.pick(TR)} ${rand.pick(TR)}`, cut);
				t = Math.max(t, over) + rand.range(500, 900);
			}
		},
	},
	{
		name: 'owner-cut-in',
		about: 'the owner cutting into a guest with a command (owner priority)',
		locale: 'tr',
		build(script, rand) {
			let t = 300;
			const commands = ['Melis sus', 'Adem\'i banla', 'Melis konuşmaya devam edebilirsin'];
			const groups = ['setting', 'ban', 'setting'];
			for (let i = 0; i < 3; i++) {
				const guestEnd = script.say(GUEST, `${rand.pick(TR)} ${rand.pick(TR)}`, t);
				const cut = t + (guestEnd - t) * rand.range(0.4, 0.7);
				t = script.say(OWNER, commands[i], cut, { command: groups[i] });
				t = Math.max(t, guestEnd) + 2600;
			}
		},
	},
	{
		name: 'overlap',
		about: 'two voices at once, summed (FLOOR_CONTROL=0, OWNER_PRIORITY=0); a guest command inside the overlap',
		locale: 'en',
		floorControl: false,
		ownerPriority: false,
		build(script, rand) {
			let t = 300;
			for (let i = 0; i < 3; i++) {
				const ownerEnd = script.say(OWNER, `${rand.pick(EN)} ${rand.pick(EN)}`, t);
				// The guest starts half way through and the two run over each other.
				const start = t + (ownerEnd - t) * rand.range(0.35, 0.6);
				const guestEnd = script.say(GUEST, i === 1 ? 'ban Dana right now' : rand.pick(EN), start, { command: i === 1 ? 'ban' : null });
				t = Math.max(ownerEnd, guestEnd) + 2600;
			}
			t = script.say(OWNER, 'be quiet for a while', t, { command: 'setting' }) + 2600;
			turns(script, rand, { pool: EN, people: [OWNER, GUEST], count: 4, at: t });
		},
	},
	{
		name: 'backchannel',
		about: '"mm", "evet" inside somebody else\'s turn, spoken and murmured',
		locale: 'tr',
		build(script, rand) {
			let t = 300;
			for (let i = 0; i < 6; i++) {
				const who = i % 2 ? THIRD : GUEST;
				const start = t;
				t = script.say(who, `${rand.pick(TR)}, ${rand.pick(TR)}`, t);
				// The owner's short "evet" takes the floor at once (priority); the other listener's murmur does not.
				const listener = rand.chance(0.5) ? OWNER : who === GUEST ? THIRD : GUEST;
				script.say(listener, rand.pick(BACKCHANNEL_TR), start + (t - start) * rand.range(0.3, 0.7), { quiet: listener !== OWNER && rand.chance(0.5) });
				t += rand.range(400, 900);
			}
		},
	},
	{
		name: 'split-words',
		about: 'words arriving in pieces ("edebilirs" + "in") across tight handovers',
		locale: 'tr',
		transcript: { split: 0.7 },
		build(script, rand) {
			turns(script, rand, { pool: TR, people: [OWNER, GUEST, THIRD], count: 12, gap: [90, 260] });
		},
	},
	{
		name: 'jitter',
		about: 'late and lost packets, and transcript positions off by a tenth of a second',
		locale: 'tr',
		packets: { jitter: 0.3, maxDelay: 3, loss: 0.02 },
		transcript: { positionSd: 110 },
		build(script, rand) {
			turns(script, rand, { pool: TR, people: [OWNER, GUEST, THIRD], count: 12 });
		},
	},
	{
		name: 'drift',
		about: 'four minutes on a transcript clock 1.3% fast, with long silences',
		locale: 'en',
		transcript: { drift: 0.013 },
		build(script, rand) {
			let t = 300;
			while (t < 240_000) {
				t = turns(script, rand, { pool: EN, people: [OWNER, GUEST, THIRD], count: rand.int(3, 6), at: t });
				t += rand.range(4000, 15_000);
			}
		},
	},
	{
		name: 'lag',
		about: 'the transcript arriving a second or more after the audio',
		locale: 'en',
		transcript: { lag: [1000, 300] },
		build(script, rand) {
			let t = turns(script, rand, { pool: EN, people: [OWNER, GUEST, THIRD], count: 8 });
			t = script.say(OWNER, 'ban Dana', t, { command: 'ban' }) + 3500;
			turns(script, rand, { pool: EN, people: [GUEST, THIRD], count: 4, at: t });
		},
	},
	{
		name: 'pauses',
		about: 'long pauses inside a turn, and pieces reported inside the pause',
		locale: 'tr',
		transcript: { lateInPause: 0.8 },
		build(script, rand) {
			let t = 300;
			for (let i = 0; i < 8; i++) {
				const who = [OWNER, GUEST, THIRD][i % 3];
				t = script.say(who, rand.pick(TR), t);
				t = script.say(who, rand.pick(TR), t + rand.range(800, 1400)); // no packets in between
				t += rand.range(300, 800);
			}
		},
	},
	{
		name: 'english',
		about: 'English turns with the owner\'s commands',
		locale: 'en',
		build(script, rand) {
			let t = turns(script, rand, { pool: EN, people: [OWNER, GUEST, THIRD], count: 6 });
			t = script.say(OWNER, 'ban Dana', t, { command: 'ban' }) + 2600;
			t = turns(script, rand, { pool: EN, people: [GUEST, THIRD], count: 3, at: t });
			t = script.say(OWNER, 'kick him out', t, { command: 'kick' }) + 2600;
			turns(script, rand, { pool: EN, people: [OWNER, GUEST, THIRD], count: 4, at: t });
		},
	},
	{
		name: 'busy-room',
		about: 'four people, quick turns in both languages, listeners chipping in, the owner\'s commands among them',
		locale: 'tr',
		speakers: [OWNER, GUEST, THIRD, FOURTH],
		build(script, rand) {
			let t = 300;
			const people = [OWNER, GUEST, THIRD, FOURTH];
			let previous = null;
			for (let i = 0; i < 16; i++) {
				const who = rand.pick(people.filter((person) => person !== previous));
				previous = who;
				const start = t;
				const command = who === OWNER && i % 5 === 4;
				t = script.say(who, command ? 'Melis sus' : rand.pick(rand.chance(0.5) ? TR : EN), t, { command: command ? 'setting' : null });
				if (!command && rand.chance(0.4)) {
					const listener = rand.pick(people.filter((person) => person !== who));
					script.say(listener, rand.pick(rand.chance(0.5) ? BACKCHANNEL_TR : BACKCHANNEL_EN), start + (t - start) * rand.range(0.3, 0.8), { quiet: listener !== OWNER && rand.chance(0.3) });
				}
				t += command ? 2600 : rand.range(60, 300);
			}
		},
	},
	{
		name: 'guest-command',
		about: 'guests saying the owner\'s commands: right after the owner, in the owner\'s pause, and with the owner\'s "evet" on the last word',
		locale: 'tr',
		build(script, rand) {
			let t = 300;
			const commands = [
				['Melis sus', 'setting'],
				['Dana\'yı banla', 'ban'],
				['Melis konuşmaya devam edebilirsin', 'setting'],
			];
			for (let i = 0; i < 9; i++) {
				const [text, group] = commands[i % commands.length];
				const who = i % 2 ? THIRD : GUEST;
				const ownerEnd = script.say(OWNER, rand.pick(TR), t);
				if (i % 3 === 0) {
					// Straight after the owner.
					t = script.say(who, text, ownerEnd + rand.range(120, 500), { command: group });
				} else if (i % 3 === 1) {
					// In the owner's pause, the owner going on afterwards.
					const end = script.say(who, text, ownerEnd + rand.range(300, 600), { command: group });
					t = script.say(OWNER, rand.pick(TR), end + rand.range(300, 600));
				} else {
					// The owner's "evet" landing on the guest's last word: owner priority cuts the guest off.
					const end = script.say(who, text, ownerEnd + rand.range(300, 600), { command: group });
					t = script.say(OWNER, rand.pick(BACKCHANNEL_TR), end - rand.range(40, 160));
				}
				t += 2600;
			}
		},
	},
];

/**
 * One room: the scenario played with this seed. Everything the benchmark feeds the real code, and the
 * truth to score it against.
 */
export function buildRoom(scenario, seed) {
	const config = { ...DEFAULTS, ...scenario, packets: { ...DEFAULTS.packets, ...scenario.packets }, transcript: { ...DEFAULTS.transcript, ...scenario.transcript } };
	const rand = rng(seed);
	const script = new Script(rand);
	scenario.build(script, rand);
	const { frames, slots } = mixRoom(script, config.speakers, config.ownerId, config, rand);
	const fragments = transcribe(script, slots, rand, config);
	const turns = turnsFor(script, fragments, slots, config.ownerId);
	return { name: scenario.name, seed, ownerId: config.ownerId, locale: config.locale, frames, fragments, turns, words: script.words, slots };
}
