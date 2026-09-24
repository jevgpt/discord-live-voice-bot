// Drives the real code with a simulated room and scores what it decided against the room's script.
//
// Nothing of the attribution is re-implemented here. Every frame the mixer produced goes into
// SpeakerAttribution.onFrame, every transcript piece goes in through the session's own onTranscript
// (drift fitting, the straddle rule, noteTranscript), lines are closed by the session's own
// flushTranscript when its silence timer would have fired, commands are answered with markTurn and
// judged by the real owner gate (ownerGate in src/tools/helpers.js) and the real speakerOfTurn. The
// clock is the room's: Date.now is the simulated wall clock while a room runs, so the eight-second line
// cap and the glue window count simulated milliseconds, and it is put back afterwards.
//
// Every mode runs over the same frames and pieces in the same pass, so a difference between two modes
// is the modes and nothing else.
import { SpeakerAttribution } from '../src/attribution.js';
import { locale, setLocale, tRaw } from '../src/i18n/index.js';
import { transcriptHost } from '../src/replay.js';
import { SessionTrace } from '../src/trace.js';
import { TRANSCRIPT_FLUSH_MS } from '../src/session/constants.js';
import { speakerOfTurn } from '../src/tools/access.js';
import { ownerGate } from '../src/tools/helpers.js';
import { FRAME_MS, SCENARIOS, buildRoom } from './rooms.js';

const EPOCH = Date.UTC(2026, 0, 1);

/** Each counter the scores are made of; addScore sums them across rooms. */
export function emptyScore() {
	return {
		rooms: 0,
		fragments: 0,
		fragRight: 0,
		fragNobody: 0,
		fragWrong: 0,
		fragFalseOwner: 0,
		guestFrags: 0,
		lines: 0,
		lineRight: 0,
		lineNobody: 0,
		lineWrong: 0,
		lineFalseOwner: 0,
		lineMixed: 0,
		guestLines: 0,
		ownerGrade: 0,
		ownerGradeFalse: 0,
		chars: 0,
		charsRight: 0,
		ownerCommands: 0,
		ownerShouldOpen: 0,
		ownerOpened: 0,
		guestCommands: 0,
		guestOpened: 0,
		guestAsOwner: 0,
	};
}

export function addScore(into, from) {
	for (const key of Object.keys(into)) into[key] += from[key] ?? 0;
	return into;
}

/** The speaker holding most of the letters of these fragments (ties to the earlier one). */
function majority(fragments) {
	const chars = new Map();
	for (const fragment of fragments) chars.set(fragment.truth, (chars.get(fragment.truth) ?? 0) + fragment.text.trim().length);
	let best = null;
	for (const [speaker, count] of chars) if (best === null || count > chars.get(best)) best = speaker;
	return best;
}

/** The gate's dependencies as buildDeps (src/guildsession.js) hands them over, read off one attribution. */
function gateDeps(attribution, turn, trace = null) {
	return {
		currentTurn: () => turn,
		commandSpeaker: (words, options) => attribution.commandSpeaker(words, options),
		lastUtterance: (options) => attribution.lastUtterance(options),
		transcriptLagging: (options) => attribution.transcriptLagging(options),
		// The gate is judged GATE_AFTER_MS after the turn: the wait for a late transcript has happened.
		awaitTranscript: async () => {},
		ownerUtterance: (options) => attribution.ownerUtterance(options),
		isOwnerActive: () => attribution.isOwnerActive(),
		ownerTextTail: () => '',
		pendingConfirmations: new Map(),
		log() {},
		activity: (event) => {
			if (event?.kind === 'gate') trace?.gate(event);
		},
	};
}

/**
 * One room through the real pipeline, once per mode.
 * @param {object} room from buildRoom
 * @param {{ modes?: string[], traceDir?: string|null }} [options] traceDir: where the first mode writes a
 *   flight-recorder trace (src/trace.js) exactly as a live session would -- frames, fragments, lines and
 *   gate decisions -- for scripts/replay-trace.mjs
 * @returns {Promise<Record<string, { score: object, lines: object[], gates: object[], labels: Map, votes: Map, attribution: SpeakerAttribution }> & { traceFile?: string }>}
 */
export async function runRoom(room, { modes = ['vote', 'hmm'], traceDir = null } = {}) {
	const previousLocale = locale();
	const realNow = Date.now;
	let now = EPOCH;
	setLocale(room.locale);
	Date.now = () => now;
	const trace = traceDir ? new SessionTrace({ dir: traceDir, name: `${room.name}-${room.seed}`, owner: room.ownerId, attribution: modes[0], now: () => now }) : null;
	try {
		const keywords = tRaw('keywords.words') ?? {};
		const runs = modes.map((mode, index) => {
			const attribution = new SpeakerAttribution({ ownerId: room.ownerId, frameMs: FRAME_MS, now: () => now });
			const run = { mode, attribution, lines: [], gates: [], votes: new Map(), turns: new Map(), lastDeltaAt: null, trace: index ? null : trace };
			run.host = transcriptHost({
				attribution,
				mode,
				trace: run.trace,
				onLine: (item) => run.lines.push(item),
				onFragment: (record) => run.votes.set(record.hit?.seq, record.hit?.id ?? null),
			});
			return run;
		});
		const fragments = room.fragments;
		let next = 0;
		const turns = room.turns.map((turn) => ({ ...turn, marked: false, judged: false }));
		for (let tick = 0; tick < room.frames.length; tick++) {
			now = EPOCH + tick * FRAME_MS;
			const frame = room.frames[tick];
			for (const run of runs) {
				run.trace?.frame({ ...frame, sent: true }, run.attribution.audioMs);
				run.attribution.onFrame({ ...frame, sent: true });
			}
			while (next < fragments.length && EPOCH + fragments[next].arrival <= now) {
				const fragment = fragments[next++];
				for (const run of runs) {
					run.host.onTranscript({ speaker: 'user', text: fragment.text, startMs: fragment.rs, endMs: fragment.re });
					run.lastDeltaAt = now;
				}
			}
			for (const run of runs) {
				// The session's silence timer (TRANSCRIPT_FLUSH_MS after the last piece), on the room's clock.
				if (run.lastDeltaAt !== null && now - run.lastDeltaAt >= TRANSCRIPT_FLUSH_MS) {
					run.host.flushTranscript('user');
					run.lastDeltaAt = null;
				}
			}
			for (const [index, turn] of turns.entries()) {
				if (!turn.marked && now >= EPOCH + turn.turnWall) {
					turn.marked = true;
					for (const run of runs) run.turns.set(index, run.attribution.markTurn());
				}
				if (turn.marked && !turn.judged && now >= EPOCH + turn.gateWall) {
					turn.judged = true;
					for (const run of runs) {
						const pinned = run.turns.get(index);
						const denied = await ownerGate(gateDeps(run.attribution, pinned, run.trace), keywords[turn.group] ?? [], 'bench');
						run.gates.push({ ...turn, opened: !denied, requester: speakerOfTurn(run.attribution, pinned) });
					}
				}
			}
		}
		for (const run of runs) run.host.flushTranscript('user');
		const out = {};
		for (const run of runs) out[run.mode] = score(room, run);
		if (trace) {
			await trace.close();
			out.traceFile = trace.file;
		}
		return out;
	} finally {
		Date.now = realNow;
		setLocale(previousLocale);
	}
}

/** Scores one mode's decisions against the script. */
function score(room, run) {
	const result = emptyScore();
	result.rooms = 1;
	const owner = room.ownerId;
	const bySeq = new Map(room.fragments.map((fragment, index) => [index + 1, fragment]));
	const labels = new Map(); // seq -> the speaker the fragment ended up with, before the line was named
	const lineOf = new Map(); // seq -> the line it landed in
	for (const line of run.lines) {
		for (const part of line.parts ?? []) {
			if (!Number.isFinite(part.seq)) continue;
			labels.set(part.seq, part.confidence === 'unsure' ? null : (part.id ?? null));
			lineOf.set(part.seq, line);
		}
	}
	for (const [seq, fragment] of bySeq) {
		const label = labels.has(seq) ? labels.get(seq) : (run.votes.get(seq) ?? null);
		result.fragments++;
		if (fragment.truth !== owner) result.guestFrags++;
		if (label === null) result.fragNobody++;
		else if (label === fragment.truth) result.fragRight++;
		else result.fragWrong++;
		if (label === owner && fragment.truth !== owner) result.fragFalseOwner++;
		const chars = fragment.text.trim().length;
		result.chars += chars;
		const line = lineOf.get(seq);
		if (line && (line.id ?? null) === fragment.truth) result.charsRight += chars;
	}
	for (const line of run.lines) {
		const parts = (line.parts ?? []).map((part) => bySeq.get(part.seq)).filter(Boolean);
		if (!parts.length) continue;
		const truth = majority(parts);
		const id = line.id ?? null;
		result.lines++;
		if (truth !== owner) result.guestLines++;
		if (id === null) result.lineNobody++;
		else if (id === truth) result.lineRight++;
		else result.lineWrong++;
		if (id === owner && truth !== owner) result.lineFalseOwner++;
		if (id !== null && line.mixed) result.lineMixed++;
		if (line.owner === true) {
			result.ownerGrade++;
			if (truth !== owner) result.ownerGradeFalse++;
		}
	}
	for (const gate of run.gates) {
		if (gate.owner) {
			result.ownerCommands++;
			if (gate.shouldOpen) result.ownerShouldOpen++;
			if (gate.opened) result.ownerOpened++;
		} else {
			result.guestCommands++;
			if (gate.opened) result.guestOpened++;
			if (gate.requester === owner) result.guestAsOwner++;
		}
	}
	return { score: result, lines: run.lines, gates: run.gates, labels, votes: run.votes, attribution: run.attribution };
}

/**
 * Every scenario (or the named ones), `reps` rooms each, seeds counted up from the scenario's own.
 * @returns {Promise<{ scenarios: Array<{ name: string, about: string, modes: Record<string, object> }>, overall: Record<string, object> }>}
 */
export async function runBench({ reps = 8, only = null, modes = ['vote', 'hmm'], seed = 1, traceDir = null } = {}) {
	const scenarios = [];
	const overall = Object.fromEntries(modes.map((mode) => [mode, emptyScore()]));
	for (const [index, scenario] of SCENARIOS.entries()) {
		if (only && !only.includes(scenario.name)) continue;
		const totals = Object.fromEntries(modes.map((mode) => [mode, emptyScore()]));
		for (let rep = 0; rep < reps; rep++) {
			const room = buildRoom(scenario, seed * 100_003 + index * 1009 + rep);
			const result = await runRoom(room, { modes, traceDir });
			for (const mode of modes) addScore(totals[mode], result[mode].score);
		}
		for (const mode of modes) addScore(overall[mode], totals[mode]);
		scenarios.push({ name: scenario.name, about: scenario.about, modes: totals });
	}
	return { scenarios, overall };
}

const pct = (part, total) => (total ? (100 * part) / total : 0);

/** The numbers a table row shows, as plain values (also what --json prints). */
export function summarize(score) {
	return {
		fragments: score.fragments,
		fragAccuracy: pct(score.fragRight, score.fragments),
		fragNobody: pct(score.fragNobody, score.fragments),
		fragWrong: pct(score.fragWrong, score.fragments),
		fragFalseOwner: score.fragFalseOwner,
		// Of the fragments that were not the owner's, how many carried the owner's name.
		fragFalseOwnerRate: pct(score.fragFalseOwner, score.guestFrags),
		lines: score.lines,
		lineAccuracy: pct(score.lineRight, score.lines),
		lineNobody: pct(score.lineNobody, score.lines),
		lineWrong: pct(score.lineWrong, score.lines),
		lineMixed: pct(score.lineMixed, score.lines - score.lineNobody),
		lineFalseOwner: score.lineFalseOwner,
		lineFalseOwnerRate: pct(score.lineFalseOwner, score.guestLines),
		ownerGradeFalse: score.ownerGradeFalse,
		textRight: pct(score.charsRight, score.chars),
		ownerCommands: score.ownerCommands,
		ownerShouldOpen: score.ownerShouldOpen,
		ownerOpened: score.ownerOpened,
		guestCommands: score.guestCommands,
		guestOpened: score.guestOpened,
		guestAsOwner: score.guestAsOwner,
	};
}
