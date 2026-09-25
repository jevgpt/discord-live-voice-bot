// The session's own account of how it is doing, so that a problem is read off a few lines instead of
// seven hundred: every fragment's confidence, every line's owner, every gate decision with its reason,
// every Jev verdict and how long it took, how far the transcript's clock has run, and which tools are
// slow. Nine minutes of a session went by with every line nobody's before anybody could see it in the
// log; this says so at the second minute.
import { t } from './i18n/index.js';

const SLOW_TOOL_MS = 1500;
// Above this the drift correction still works, but sending audio this far behind real time means the
// send loop is being starved, and that is worth a warning of its own.
const DRIFT_WARN_MS = 3000;
// Lines nobody owns are normal in a tangle of voices; this many of them means the audio is not under
// the words at all.
const UNKNOWN_WARN_PCT = 40;
const UNKNOWN_WARN_MIN_LINES = 10;
// The send loop's own rate against the clock: past this the transcript's drift is (partly) ours.
const AUDIO_RATE_WARN = 0.02;
const AUDIO_RATE_MIN_FRAMES = 1500; // 30 s of audio before the rate means anything
// Holes mid-sentence: a few are jitter; this many is packets not arriving.
const HOLES_WARN_MIN = 50;
const HOLES_WARN_FRACTION = 0.02;
// Under the padding model (see bridge.js LEAD_FRAMES) our send cadence alone would move the far end's clock
// this much per second: compare with the drift rate on the summary line.
const PAD_WARN_MS_PER_S = 5;

const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);
const median = (list) => {
	if (!list.length) return 0;
	const sorted = [...list].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

export class SessionHealth {
	constructor({ now = Date.now } = {}) {
		this.now = now;
		this.reset();
	}

	reset() {
		this.since = this.now();
		this.fragments = { sure: 0, leaning: 0, unsure: 0, silent: 0 };
		this.lines = { named: 0, mixed: 0, unknown: 0 };
		this.gate = { allowed: 0, denied: 0, reasons: new Map() };
		this.jev = { calls: 0, failed: 0, banter: 0, notForBot: 0, suppressed: 0, ms: [] };
		this.tools = new Map(); // name -> { count, slow, total }
		this.drift = { now: 0, max: 0, rate: 0 };
		this.overlapFrames = 0; // frames on which somebody was speaking but was not sent (floor control)
		this.reportedAt = 0; // how many fragments had been seen at the last report
	}

	get fragmentCount() {
		return this.fragments.sure + this.fragments.leaning + this.fragments.unsure;
	}

	get lineCount() {
		return this.lines.named + this.lines.mixed + this.lines.unknown;
	}

	/** One transcript fragment, as the audio placed it (the answer noteTranscript handed back). */
	fragment(hit) {
		const confidence = hit?.confidence;
		if (confidence === 'sure') this.fragments.sure++;
		else if (confidence === 'leaning') this.fragments.leaning++;
		else this.fragments.unsure++;
		if (!hit || hit.reason === 'silence') this.fragments.silent++;
	}

	/** One finished line. */
	line({ id, mixed }) {
		if (!id) this.lines.unknown++;
		else if (mixed) this.lines.mixed++;
		else this.lines.named++;
	}

	/** One owner-gate decision. */
	gateResult(result, reason = null) {
		if (result === 'allowed') {
			this.gate.allowed++;
			return;
		}
		if (result !== 'denied') return;
		this.gate.denied++;
		if (reason) this.gate.reasons.set(reason, (this.gate.reasons.get(reason) ?? 0) + 1);
	}

	/** One Jev round trip; `hit` is null when it failed or was skipped. */
	jevVerdict(hit, ms, { notForBot = false, banter = false } = {}) {
		this.jev.calls++;
		if (Number.isFinite(ms)) this.jev.ms.push(ms);
		if (!hit) {
			this.jev.failed++;
			return;
		}
		if (banter) this.jev.banter++;
		if (notForBot) this.jev.notForBot++;
	}

	/** A reply kept off the channel because its line was not for the bot. */
	jevSuppressed() {
		this.jev.suppressed++;
	}

	/** One tool call. */
	tool(name, ms) {
		const entry = this.tools.get(name) ?? { count: 0, slow: 0, total: 0 };
		entry.count++;
		if (Number.isFinite(ms)) {
			entry.total += ms;
			if (ms > SLOW_TOOL_MS) entry.slow++;
		}
		this.tools.set(name, entry);
	}

	/** The transcript's clock against ours, as last measured. */
	driftNow(ms, ratePerSecond = null) {
		if (!Number.isFinite(ms)) return;
		this.drift.now = ms;
		if (ms > this.drift.max) this.drift.max = ms;
		if (Number.isFinite(ratePerSecond)) this.drift.rate = ratePerSecond;
	}

	/** One frame on which these people were speaking over the floor holder and were not sent. */
	overlap(ids) {
		if (ids?.length) this.overlapFrames++;
	}

	/**
	 * The running totals as they stand, for the panel's history and /metrics. The snapshot below is made
	 * for reading (percentages, a median); a graph needs the raw counts, so it can tell what happened in
	 * the last ten seconds from what happened all evening. Counts only: no reason, no words.
	 */
	totals() {
		return {
			fragmentsSure: this.fragments.sure,
			fragmentsLeaning: this.fragments.leaning,
			fragmentsUnsure: this.fragments.unsure,
			fragmentsSilent: this.fragments.silent,
			linesNamed: this.lines.named,
			linesMixed: this.lines.mixed,
			linesUnknown: this.lines.unknown,
			gateAllowed: this.gate.allowed,
			gateDenied: this.gate.denied,
			jevCalls: this.jev.calls,
			jevFailed: this.jev.failed,
			jevBanter: this.jev.banter,
			jevNotForBot: this.jev.notForBot,
			jevSuppressed: this.jev.suppressed,
			driftMs: this.drift.now,
			driftMaxMs: this.drift.max,
			overlapFrames: this.overlapFrames,
		};
	}

	/** Jev's round-trip times, in order, with how many there have been: the history takes the new ones. */
	jevTimes() {
		return { list: this.jev.ms, total: this.jev.ms.length };
	}

	/** The numbers, for the panel and for tests. */
	snapshot() {
		const fragments = this.fragmentCount;
		const lines = this.lineCount;
		const slowTools = [...this.tools.entries()]
			.filter(([, entry]) => entry.slow > 0)
			.map(([name, entry]) => ({ name, count: entry.count, slow: entry.slow, avgMs: Math.round(entry.total / entry.count) }))
			.sort((a, b) => b.avgMs - a.avgMs);
		return {
			minutes: Math.round((this.now() - this.since) / 60_000),
			fragments,
			surePct: pct(this.fragments.sure, fragments),
			leaningPct: pct(this.fragments.leaning, fragments),
			unsurePct: pct(this.fragments.unsure, fragments),
			silentPct: pct(this.fragments.silent, fragments),
			lines,
			namedPct: pct(this.lines.named, lines),
			mixedPct: pct(this.lines.mixed, lines),
			unknownPct: pct(this.lines.unknown, lines),
			driftMs: Math.round(this.drift.now),
			driftMaxMs: Math.round(this.drift.max),
			driftRate: Math.round(this.drift.rate * 10) / 10,
			overlapSeconds: Math.round((this.overlapFrames * 20) / 100) / 10,
			gateAllowed: this.gate.allowed,
			gateDenied: this.gate.denied,
			gateReasons: [...this.gate.reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
			jevCalls: this.jev.calls,
			jevFailed: this.jev.failed,
			jevMedianMs: Math.round(median(this.jev.ms)),
			jevBanter: this.jev.banter,
			jevNotForBot: this.jev.notForBot,
			jevSuppressed: this.jev.suppressed,
			slowTools,
		};
	}

	/**
	 * The report, as lines of text in the active locale: the numbers, then the warnings that are worth
	 * one line each. `latency` is the response latency summary the session already keeps.
	 */
	report({ why = '', latency = '', takeovers = 0, audio = null } = {}) {
		const s = this.snapshot();
		const lines = [
			t('runtime.health_summary', {
				why,
				minutes: s.minutes,
				fragments: s.fragments,
				sure: s.surePct,
				leaning: s.leaningPct,
				unsure: s.unsurePct,
				silent: s.silentPct,
				lines: s.lines,
				named: s.namedPct,
				mixed: s.mixedPct,
				unknown: s.unknownPct,
				drift: s.driftMs,
				driftMax: s.driftMaxMs,
				rate: s.driftRate,
			}),
		];
		if (s.overlapSeconds > 0 || takeovers > 0) lines.push(t('runtime.health_overlap', { seconds: s.overlapSeconds, takeovers }));
		if (s.gateAllowed || s.gateDenied) {
			const list = s.gateReasons.map((entry) => `${entry.reason} ×${entry.count}`).join(', ');
			lines.push(t('runtime.health_gate', { allowed: s.gateAllowed, denied: s.gateDenied, reasons: list ? t('runtime.health_gate_reasons', { list }) : '' }));
		}
		if (s.jevCalls) {
			lines.push(
				t('runtime.health_jev', {
					calls: s.jevCalls,
					ms: s.jevMedianMs,
					banter: s.jevBanter,
					notForBot: s.jevNotForBot,
					suppressed: s.jevSuppressed,
					failed: s.jevFailed,
				}),
			);
		}
		const tools = s.slowTools.length
			? s.slowTools.map((entry) => t('runtime.health_tool_item', { name: entry.name, count: entry.count, seconds: (entry.avgMs / 1000).toFixed(1) })).join(', ')
			: t('runtime.health_none');
		lines.push(t('runtime.health_latency', { latency: latency || t('runtime.health_none'), tools }));
		if (audio) {
			// Each person's speech level and gain, and under the adaptive detector what it sees: the noise floor
			// of their microphone and the bar a frame of theirs has to clear to count as speech. A floor of -40
			// is a fan or music in that microphone; a level near the bar is somebody the detector barely hears.
			// The level is only measured with AGC on, and "?" without it.
			const levels = (audio.levels ?? [])
				.map((entry) => {
					const params = { name: entry.name ?? entry.id, level: entry.levelDb ?? '?', gain: (entry.gainDb >= 0 ? '+' : '') + entry.gainDb };
					if (!Number.isFinite(entry.floorDb)) return t('runtime.health_audio_level', params);
					return t('runtime.health_audio_level_vad', { ...params, floor: entry.floorDb, threshold: entry.thresholdDb });
				})
				.join(', ');
			const ratio = Number.isFinite(audio.sentRatio) ? Math.round(audio.sentRatio * 1000) / 10 : '?';
			const pad = Number.isFinite(audio.padRate) ? Math.round(audio.padRate * 10) / 10 : '?';
			const holes = audio.holes ?? 0;
			lines.push(
				t('runtime.health_audio', {
					ratio,
					pad,
					avgLate: Math.round((audio.avgLateMs ?? 0) * 10) / 10,
					late: Math.round(audio.maxLateMs ?? 0),
					bursts: audio.bursts ?? 0,
					holes,
					concealed: audio.concealed ?? 0,
					overflow: Math.round(audio.overflow ?? 0),
					depth: Math.round(audio.maxDepth ?? 0),
					levels: levels || t('runtime.health_none'),
				}),
			);
			if (Number.isFinite(audio.sentRatio) && (audio.sent ?? 0) >= AUDIO_RATE_MIN_FRAMES && Math.abs(audio.sentRatio - 1) > AUDIO_RATE_WARN) {
				lines.push(t('runtime.health_warn_audio_rate', { ratio }));
			}
			if (holes >= HOLES_WARN_MIN && audio.sent > 0 && holes / audio.sent > HOLES_WARN_FRACTION) {
				lines.push(t('runtime.health_warn_holes', { holes, pct: Math.round((holes / audio.sent) * 100) }));
			}
			if (Number.isFinite(audio.padRate) && (audio.sent ?? 0) >= AUDIO_RATE_MIN_FRAMES && audio.padRate >= PAD_WARN_MS_PER_S) {
				lines.push(t('runtime.health_warn_cadence', { pad, rate: s.driftRate }));
			}
		}
		if (s.driftMs > DRIFT_WARN_MS) lines.push(t('runtime.health_warn_drift', { drift: s.driftMs }));
		if (s.lines >= UNKNOWN_WARN_MIN_LINES && s.unknownPct > UNKNOWN_WARN_PCT) lines.push(t('runtime.health_warn_unknown', { unknown: s.unknownPct }));
		return lines;
	}
}
