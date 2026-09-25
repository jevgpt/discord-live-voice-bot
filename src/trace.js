// The flight recorder. Everything the attribution decides is decided from two streams -- who the
// mixer heard on each 20 ms frame, and where the transcript said each fragment sat -- and once a
// session is over both are gone; a pasted log is a description of the decisions, not the material
// they were made from. With TRACE=1 that material is written to a local file, in run-length form for
// the frames (one record whenever the set of voices changes), together with each decision as it was
// taken. `replayTrace` runs the same code over a trace offline and says where it now decides
// differently: a live failure becomes a test, and a change to the attribution is judged against real
// rooms rather than the cases somebody thought of.
//
// Nothing here is audio. The transcript text is included only when transcripts may be recorded at all
// (RECORD_TRANSCRIPTS), and the file lives under data/, which stays out of the repository.
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SpeakerAttribution } from './attribution.js';
import { t } from './i18n/index.js';

const FLUSH_MS = 1000;

export class SessionTrace {
	/**
	 * @param {{ dir: string, name?: string, text?: boolean, owner?: string|null, attribution?: string|null, log?: Function, now?: Function }} options
	 *   text = whether transcript text may be written (RECORD_TRANSCRIPTS); attribution = the ATTRIBUTION the
	 *   lines were named under, so that a replay can say which of its modes the live lines came from
	 */
	constructor({ dir, name = null, text = true, owner = null, attribution = null, log = () => {}, now = Date.now } = {}) {
		this.dir = dir;
		this.text = text;
		this.log = log;
		this.now = now;
		const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
		this.file = path.join(dir, `${name ? `${name}-` : ''}${stamp}.jsonl`);
		this.pending = [];
		this.lastKey = null;
		this.closed = false;
		this.timer = null;
		this.chain = Promise.resolve();
		this.ready = mkdir(dir, { recursive: true }).catch(() => {});
		this.write({ t: 'm', owner: owner ? String(owner) : null, started: now(), text, attribution });
	}

	/** One mixer frame; written only when the set of voices (or the priority flag) changes. */
	frame({ active, present, priority, others, sent }, audioMs) {
		if (!sent) return;
		const ids = (active ?? []).map(String);
		const pr = (present ?? []).map(String);
		const o = (others ?? []).map(String);
		const key = `${priority ? 1 : 0}|${[...ids].sort().join(',')}|${[...pr].sort().join(',')}|${[...o].sort().join(',')}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.write({ t: 'a', ms: audioMs, ids, pr, p: Boolean(priority), o });
	}

	/** One user transcript fragment: where the transcript put it, where we looked, and what the audio said. */
	delta({ audio, rawStart, rawEnd, start, end, drift, text, hit }) {
		this.write({
			t: 'd',
			audio,
			rs: rawStart,
			re: rawEnd,
			s: start,
			e: end,
			drift,
			text: this.text ? String(text ?? '') : undefined,
			id: hit?.id ?? null,
			c: hit?.confidence ?? null,
			r: hit?.reason ?? null,
			solo: hit ? Number(hit.solo.toFixed(2)) : null,
		});
	}

	/** One finished line. */
	line({ line, id, mixed, candidates }) {
		this.write({ t: 'l', id: id ?? null, mixed: Boolean(mixed), cands: candidates ?? [], text: this.text ? line : undefined });
	}

	/** One Jev verdict. */
	jev({ text, id, ms, hit, notForBot, banter }) {
		this.write({
			t: 'j',
			id: id ?? null,
			ms,
			addressed: hit?.addressed ?? null,
			kind: hit?.kind ?? null,
			kindP: hit?.kindP ?? null,
			notForBot: Boolean(notForBot),
			banter: Boolean(banter),
			text: this.text ? text : undefined,
		});
	}

	/** One owner-gate decision (the activity event the gate emits). */
	gate(event) {
		this.write({ t: 'g', tool: event?.meta?.tool ?? null, result: event?.meta?.result ?? null, reason: event?.meta?.reason ?? null });
	}

	/** One line the bot said (or would have said). */
	assistant(line, suppressed) {
		this.write({ t: 'o', suppressed: Boolean(suppressed), text: this.text ? line : undefined });
	}

	/** A new live session: the audio position starts again from zero. */
	session(id) {
		this.lastKey = null;
		this.write({ t: 's', id: id ?? null });
	}

	write(record) {
		if (this.closed) return;
		this.pending.push(JSON.stringify({ at: this.now(), ...record }));
		if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), FLUSH_MS);
			this.timer.unref?.();
		}
	}

	/** Appends what is pending; writes are chained so the file stays in order. */
	flush() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (!this.pending.length) return this.chain;
		const chunk = `${this.pending.join('\n')}\n`;
		this.pending = [];
		this.chain = this.chain
			.then(() => this.ready)
			.then(() => appendFile(this.file, chunk))
			.catch((err) => this.log(String(err?.message ?? err)));
		return this.chain;
	}

	/** The last flush; nothing is written after it. */
	async close() {
		const done = this.flush();
		this.closed = true;
		await done;
	}
}

function wavHeader(sampleRate, dataBytes) {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(dataBytes, 40);
	return header;
}

/**
 * With TRACE_AUDIO=1: exactly the audio sent to the model, as a WAV file, so that "what did it hear" has
 * an answer that can be listened to -- a transcript that reads "ağlar mısın" for "adamsın" is either the
 * far end's ear or something this side did to the sound, and this is how to tell. 24 kHz mono, 2.9 MB a
 * minute, local only.
 */
export class AudioTrace {
	constructor({ dir, name = 'sent', sampleRate = 24_000, log = () => {}, now = Date.now } = {}) {
		const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
		this.file = path.join(dir, `${name}-${stamp}.wav`);
		this.sampleRate = sampleRate;
		this.log = log;
		this.pending = [];
		this.bytes = 0;
		this.closed = false;
		this.timer = null;
		this.now = now;
		this.firstAt = 0;
		this.lastAt = 0;
		this.chain = mkdir(dir, { recursive: true })
			.then(() => writeFile(this.file, wavHeader(sampleRate, 0)))
			.catch((err) => this.log(String(err?.message ?? err)));
	}

	/** One frame of what was sent; copied at once, the buffer is the mixer's and is overwritten next tick. */
	write(samples) {
		if (this.closed || !samples?.length) return;
		this.lastAt = this.now();
		if (!this.firstAt) this.firstAt = this.lastAt;
		this.pending.push(Buffer.from(Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)));
		if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), FLUSH_MS);
			this.timer.unref?.();
		}
	}

	flush() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (!this.pending.length) return this.chain;
		const chunk = Buffer.concat(this.pending);
		this.pending = [];
		this.bytes += chunk.length;
		this.chain = this.chain.then(() => appendFile(this.file, chunk)).catch((err) => this.log(String(err?.message ?? err)));
		return this.chain;
	}

	/** The last flush, and the header rewritten with the sizes now known. */
	async close() {
		const done = this.flush();
		this.closed = true;
		await done;
		try {
			const handle = await open(this.file, 'r+');
			await handle.write(wavHeader(this.sampleRate, this.bytes), 0, 44, 0);
			await handle.close();
		} catch (err) {
			this.log(String(err?.message ?? err));
		}
		// Audio seconds against wall-clock seconds: if these differ, the drift between the transcript's
		// clock and ours starts on this side.
		if (this.bytes > 0) {
			const seconds = (this.bytes / (2 * this.sampleRate)).toFixed(1);
			const wall = ((this.lastAt - this.firstAt) / 1000 + 0.02).toFixed(1);
			this.log(t('runtime.log_trace_audio_closed', { file: this.file, seconds, wall }));
		}
	}
}

/**
 * Runs the attribution over a trace's records and compares what it decides now with what was decided
 * then. The straddle handling of onTranscript (a fragment judged on the audio new since the last one)
 * is not replayed: the recorded positions are the ones actually looked up. replaySession (src/replay.js)
 * replays the whole transcript pipeline instead, windows and lines included, in either ATTRIBUTION mode;
 * scripts/replay-trace.mjs uses that.
 * @param {object[]} records parsed lines of a trace file
 * @returns {{ total: number, matched: number, decisions: Array<{ text?: string, recorded: string|null, replayed: string|null, same: boolean, rs: number, re: number, drift: number }> }}
 */
export function replayTrace(records, { frameMs = 20 } = {}) {
	const meta = records.find((record) => record.t === 'm');
	const attribution = new SpeakerAttribution({ ownerId: meta?.owner ?? null, frameMs });
	let current = { ids: [], pr: [], p: false };
	const advanceTo = (ms) => {
		if (!Number.isFinite(ms)) return;
		while (attribution.audioMs + frameMs <= ms) attribution.onFrame({ active: current.ids, present: current.pr, priority: current.p, sent: true });
	};
	const decisions = [];
	for (const record of records) {
		if (record.t === 'a') {
			advanceTo(record.ms);
			current = { ids: record.ids ?? [], pr: record.pr ?? [], p: Boolean(record.p) };
		} else if (record.t === 's') {
			attribution.resetSession();
			current = { ids: [], pr: [], p: false };
		} else if (record.t === 'd') {
			advanceTo(record.audio);
			const drift = attribution.observeTranscript(record.re);
			const hit = attribution.noteTranscript(record.text ?? 'x', {
				startMs: attribution.mapTranscriptMs(record.rs),
				endMs: attribution.mapTranscriptMs(record.re),
			});
			const replayed = hit?.id ?? null;
			decisions.push({ text: record.text, recorded: record.id ?? null, replayed, same: replayed === (record.id ?? null), rs: record.rs, re: record.re, drift });
		}
	}
	return { total: decisions.length, matched: decisions.filter((entry) => entry.same).length, decisions };
}
