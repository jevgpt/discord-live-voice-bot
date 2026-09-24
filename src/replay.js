// The transcript pipeline without a session: the same onTranscript / flushTranscript / resolveLine that a
// live session runs (src/session/transcript.js), on a host that has no Discord, no model and no timer that
// fires on its own. Two things drive it offline. The flight recorder's replay runs a recorded trace
// through it, so that a change to how lines are cut and named is judged against real rooms and not only
// against the fragments; and the attribution benchmark (bench/) runs simulated rooms through it, where
// every word's speaker is known.
//
// Nothing here decides anything. It is plumbing around the real methods, and every stub is a place the
// live session would talk to somebody -- the model, the panel, Jev -- which is exactly what an offline run
// must not do.
import { SpeakerAttribution } from './attribution.js';
import { NO_AUDIO_SAMPLE } from './session/constants.js';
import { transcriptMethods } from './session/transcript.js';

// Longer than any offline run: the line timer is never meant to fire on its own here. Whoever drives the
// host closes lines itself (the recorded flushes, or the benchmark's own clock), and flushTranscript
// clears the timer it armed. Node's limit for a timer is 2^31 - 1 ms; this stays under it.
const NEVER_MS = 1_000_000_000;

/**
 * A host for the transcript methods.
 * @param {{ attribution: SpeakerAttribution, mode?: 'vote'|'hmm', ownerId?: string|null, onLine?: Function, onFragment?: Function, trace?: object|null }} options
 *   onLine receives every finished line as runVoiceCommand would, with `parts` (the fragments it was cut
 *   from, as the line pass saw them); onFragment receives what the recorder would write for a fragment;
 *   trace is a flight recorder (SessionTrace) to write the fragments and lines to, as a live session does.
 */
export function transcriptHost({ attribution, mode = 'vote', ownerId = attribution?.ownerId ?? null, onLine = null, onFragment = null, trace = null }) {
	const owner = ownerId ? String(ownerId) : null;
	const host = {
		...transcriptMethods,
		cfg: { transcripts: false, debug: false, announceSpeaker: false, transcriptFlushMs: NEVER_MS, attribution: mode },
		attribution,
		transcriptBuffers: new Map(),
		health: { fragment() {}, driftNow() {}, line() {} },
		latency: { userSpeechEnd() {} },
		trace: {
			delta(record) {
				trace?.delta(record);
				onFragment?.(record);
			},
			line: (item) => trace?.line(item),
			assistant: (line, suppressed) => trace?.assistant(line, suppressed),
		},
		live: null,
		localMode: false,
		recentUserText: '',
		recentUserTextAt: 0,
		lastUserDeltaAt: 0,
		lastSuppressedAt: 0,
		lastHeardAssistantLine: '',
		// The "no audio under this line" detail is a log line for a person; nobody reads it here.
		noAudioSaid: NO_AUDIO_SAMPLE,
		log() {},
		record() {},
		judgeLine() {},
		judgeEarly() {},
		interruptLocalSpeech() {},
		maybeWakeByVoiceName() {},
		enqueueLocalSpeech() {},
		speakerLabel: (id) => String(id),
		isOwnerId: (id) => Boolean(owner && id && String(id) === owner),
		persona: () => ({ name: 'bot' }),
		runVoiceCommand: (item) => onLine?.(item),
		/** The live method; the line timer it arms is never meant to fire here, nor to keep the process up. */
		onTranscript(event) {
			transcriptMethods.onTranscript.call(this, event);
			this.transcriptBuffers.get(event?.speaker)?.timer?.unref?.();
		},
		/** The live method, with the fragments the line was cut from handed along to whoever is watching. */
		resolveLine(run, options) {
			return { ...transcriptMethods.resolveLine.call(this, run, options), parts: run.parts };
		},
	};
	// The reply gate's early judgment is a timer the live session arms on every fragment. Offline there is
	// nothing to judge with, so the timer is cancelled the moment it is set.
	Object.defineProperty(host, 'earlyJudgeTimer', {
		get: () => null,
		set: (timer) => clearTimeout(timer),
	});
	return host;
}

/**
 * Replays a trace's fragments and lines through the transcript pipeline in one mode. The frames rebuild
 * the audio track; every recorded fragment goes back in through onTranscript with the transcript's own
 * positions (so the drift is fitted and the windows are cut exactly as they are cut live, which
 * replayTrace in src/trace.js does not do), and the recorded lines say where each flush happened: every
 * fragment recorded since the last line belongs to the next group of lines, because a flush writes its
 * lines together, after its fragments. The clock is the recorded one.
 * @param {object[]} records parsed lines of a trace file
 * @param {{ mode?: 'vote'|'hmm', frameMs?: number }} [options]
 * @returns {{
 *   fragments: Array<{ text?: string, recorded: string|null, replayed: string|null, same: boolean, rs: number, re: number, drift: number }>,
 *   lines: Array<{ flush: number, text?: string, id: string|null, mixed: boolean, owner: boolean }>,
 *   recorded: Array<{ flush: number, text?: string, id: string|null, mixed: boolean }>,
 * }}
 */
export function replaySession(records, { mode = 'vote', frameMs = 20 } = {}) {
	const meta = records.find((record) => record.t === 'm');
	const words = meta?.text !== false;
	let clock = Number(meta?.started) || 0;
	const attribution = new SpeakerAttribution({ ownerId: meta?.owner ?? null, frameMs, now: () => clock });
	const lines = [];
	const recorded = [];
	const fragments = [];
	let flush = 0;
	let delta = null; // the recorded fragment going in, to set against what the replay decided for it
	const host = transcriptHost({
		attribution,
		mode,
		onLine: (item) => lines.push({ flush, text: words ? item.line : undefined, id: item.id ?? null, mixed: Boolean(item.mixed), owner: item.owner === true }),
		onFragment: ({ hit, drift }) => {
			const replayed = hit?.id ?? null;
			const was = delta?.id ?? null;
			fragments.push({ text: delta?.text, recorded: was, replayed, same: replayed === was, rs: delta?.rs, re: delta?.re, drift });
		},
	});
	let current = { ids: [], pr: [], p: false };
	const advanceTo = (ms) => {
		if (!Number.isFinite(ms)) return;
		while (attribution.audioMs + frameMs <= ms) attribution.onFrame({ active: current.ids, present: current.pr, priority: current.p, sent: true });
	};
	let pending = 0; // fragments since the last flush
	for (const record of records) {
		if (Number.isFinite(record.at)) clock = record.at;
		if (record.t === 'a') {
			advanceTo(record.ms);
			current = { ids: record.ids ?? [], pr: record.pr ?? [], p: Boolean(record.p) };
		} else if (record.t === 's') {
			// What the live 'ready' handler does (src/session/livelink.js): finish the half-said lines on the
			// old timeline, drop the buffers, then start the positions again from zero.
			if (pending) {
				host.flushTranscript('user');
				pending = 0;
				flush++;
			}
			host.transcriptBuffers.clear();
			attribution.resetSession();
			current = { ids: [], pr: [], p: false };
		} else if (record.t === 'd') {
			advanceTo(record.audio);
			// Without the words every fragment stands for one word of its own: a space in front, so none is glued.
			delta = record;
			host.onTranscript({ speaker: 'user', text: words ? (record.text ?? '') : ' x', startMs: record.rs, endMs: record.re });
			pending++;
		} else if (record.t === 'l') {
			if (pending) {
				host.flushTranscript('user');
				pending = 0;
				flush++;
			}
			recorded.push({ flush: flush - 1, text: record.text, id: record.id ?? null, mixed: Boolean(record.mixed) });
		}
	}
	if (pending) host.flushTranscript('user');
	return { fragments, lines, recorded };
}
