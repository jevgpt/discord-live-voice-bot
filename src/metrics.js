// The panel's memory of the last hour: per server, one row every ten seconds of how the session was
// doing, so a spike in the response time or a burst of gate refusals can be seen for what it is -- a
// moment, or the whole evening -- instead of being read off the current number and guessed at.
//
// Nothing here reaches into a session. src/index.js reads each one (through the panel's accessors) and
// hands over a plain reading: gauges as they stand, running totals as they stand, and the recent window
// of each timing sample with how many were ever taken. The ring turns totals into "how many in these ten
// seconds" and windows into "the median of the ones taken in these ten seconds" itself, which is why a
// reading can come in as often as the caller likes: two readings in one slot add up, none leaves a gap.
//
// The memory is fixed up front: every series is a Float64Array of one hour's slots, per server, and the
// number of servers kept is capped. Words never come in here; the readings are numbers only.

const DEFAULT_RESOLUTION_MS = 10_000;
const DEFAULT_RETENTION_MS = 60 * 60_000;
const DEFAULT_MAX_GUILDS = 32;
// Timing samples a slot keeps to take its percentiles from. A slot is ten seconds; nothing the bot times
// happens this often, so the cap only matters to a caller gone wrong.
const SLOT_SAMPLE_CAP = 500;

/**
 * The series, in the order they are listed. `gauge` is the value as read, `counter` the growth of a
 * running total within the slot, `ratio` the growth of one total over another's (times `scale`), and
 * `samples` a percentile of the timings taken within the slot.
 */
export const HISTORY_SERIES = Object.freeze([
	{ name: 'response_p50_ms', from: 'samples', of: 'response', q: 0.5 },
	{ name: 'live_state', from: 'gauge' },
	{ name: 'drift_ms', from: 'gauge' },
	{ name: 'placed_pct', from: 'ratio', num: 'fragments_placed', den: 'fragments', scale: 100 },
	{ name: 'gate_allowed', from: 'counter' },
	{ name: 'gate_refused', from: 'counter' },
	{ name: 'jev_calls', from: 'counter' },
	{ name: 'jev_not_for_bot', from: 'counter' },
	{ name: 'jev_banter', from: 'counter' },
	{ name: 'jev_failed', from: 'counter' },
	{ name: 'jev_p50_ms', from: 'samples', of: 'jev', q: 0.5 },
	{ name: 'tool_p50_ms', from: 'samples', of: 'tool', q: 0.5 },
	{ name: 'tool_p95_ms', from: 'samples', of: 'tool', q: 0.95 },
	{ name: 'loop_late_ms', from: 'ratio', num: 'loop_late_total_ms', den: 'loop_wakes', scale: 1 },
	{ name: 'dropped_frames', from: 'counter' },
	{ name: 'quota_used_s', from: 'gauge' },
	{ name: 'people', from: 'gauge' },
]);

/** What the live_state gauge holds; the panel draws it as a strip rather than a line. */
export const LIVE_STATE = Object.freeze({ off: 0, connecting: 1, ready: 2, local: 3 });

/** The same percentile the latency meter uses, so the panel and /status agree on what "P50" means. */
function percentile(list, q) {
	if (!list.length) return Number.NaN;
	const sorted = [...list].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

const finite = (value) => (value === null || value === undefined || value === '' ? Number.NaN : Number(value));

export class MetricsHistory {
	constructor({ resolutionMs = DEFAULT_RESOLUTION_MS, retentionMs = DEFAULT_RETENTION_MS, maxGuilds = DEFAULT_MAX_GUILDS, now = Date.now } = {}) {
		this.resolutionMs = Math.max(1, Math.round(resolutionMs));
		this.capacity = Math.max(1, Math.ceil(retentionMs / this.resolutionMs));
		this.retentionMs = this.capacity * this.resolutionMs;
		this.maxGuilds = Math.max(1, maxGuilds);
		this.now = now;
		this.guildsById = new Map();
	}

	/** The fixed cost of one server's ring, in bytes: every series and the slot times, one hour each. */
	get bytesPerGuild() {
		return (HISTORY_SERIES.length + 1) * this.capacity * Float64Array.BYTES_PER_ELEMENT;
	}

	/**
	 * One reading of one server: { name, gauges, counters, samples: { kind: { list, total } } }. The first
	 * reading of a server sets the baseline its totals are counted from, so a panel opened in the middle of
	 * an evening does not show the whole evening as one slot.
	 */
	record(id, reading = {}, at = this.now()) {
		const key = String(id);
		this.prune(at);
		let guild = this.guildsById.get(key);
		if (!guild) {
			guild = this.makeGuild(key);
			// Stamped before the cap is applied, or the newcomer would be the one that looks oldest.
			guild.updatedAt = at;
			this.guildsById.set(key, guild);
			this.evict();
		}
		if (reading.name) guild.name = String(reading.name);
		guild.updatedAt = at;
		const slot = Math.floor(at / this.resolutionMs);
		if (!guild.acc || guild.acc.slot !== slot) guild.acc = { slot, deltas: Object.create(null), samples: Object.create(null) };
		const acc = guild.acc;

		for (const [name, raw] of Object.entries(reading.counters ?? {})) {
			const value = finite(raw);
			if (!Number.isFinite(value)) continue;
			const previous = guild.baseline[name];
			guild.baseline[name] = value;
			if (previous === undefined) continue;
			// A total that went down belongs to something rebuilt (the audio bridge after a reconnect): it
			// has counted from zero since, so what it holds now is what happened.
			acc.deltas[name] = (acc.deltas[name] ?? 0) + (value >= previous ? value - previous : value);
		}
		for (const [kind, window] of Object.entries(reading.samples ?? {})) {
			const total = finite(window?.total);
			const list = Array.isArray(window?.list) ? window.list : [];
			if (!Number.isFinite(total)) continue;
			const previous = guild.taken[kind];
			guild.taken[kind] = total;
			if (previous === undefined) continue;
			const fresh = Math.min(list.length, total >= previous ? total - previous : total);
			if (fresh <= 0) continue;
			const into = (acc.samples[kind] ??= []);
			for (const value of list.slice(-fresh)) if (Number.isFinite(value) && into.length < SLOT_SAMPLE_CAP) into.push(value);
		}

		const index = slot % this.capacity;
		guild.times[index] = slot * this.resolutionMs;
		for (const series of HISTORY_SERIES) guild.columns.get(series.name)[index] = this.valueOf(series, reading, acc);
	}

	valueOf(series, reading, acc) {
		switch (series.from) {
			case 'gauge':
				return finite(reading.gauges?.[series.name]);
			case 'counter':
				return acc.deltas[series.name] ?? Number.NaN;
			case 'ratio': {
				const den = acc.deltas[series.den];
				return den > 0 ? ((acc.deltas[series.num] ?? 0) / den) * series.scale : Number.NaN;
			}
			case 'samples':
				return percentile(acc.samples[series.of] ?? [], series.q);
			default:
				return Number.NaN;
		}
	}

	makeGuild(id) {
		const columns = new Map();
		for (const series of HISTORY_SERIES) columns.set(series.name, new Float64Array(this.capacity).fill(Number.NaN));
		return { id, name: id, updatedAt: 0, times: new Float64Array(this.capacity), columns, baseline: Object.create(null), taken: Object.create(null), acc: null };
	}

	/** Servers nobody has reported on for longer than the ring reaches back have nothing left to show. */
	prune(at = this.now()) {
		for (const [id, guild] of this.guildsById) {
			if (at - guild.updatedAt > this.retentionMs) this.guildsById.delete(id);
		}
	}

	/** Past the cap, the server heard from longest ago goes first. */
	evict() {
		while (this.guildsById.size > this.maxGuilds) {
			let oldest = null;
			for (const guild of this.guildsById.values()) if (!oldest || guild.updatedAt < oldest.updatedAt) oldest = guild;
			this.guildsById.delete(oldest.id);
		}
	}

	/** The servers there is history for, most recently heard from first. */
	guilds(at = this.now()) {
		this.prune(at);
		return [...this.guildsById.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((guild) => ({ id: guild.id, name: guild.name }));
	}

	/** The newest slot any server has, in ms; 0 when there is none. The page asks for more only past it. */
	latestAt() {
		let latest = 0;
		for (const guild of this.guildsById.values()) {
			if (guild.acc) latest = Math.max(latest, guild.acc.slot * this.resolutionMs);
		}
		return latest;
	}

	/**
	 * One server's rows, oldest first, as columns: { t: [...], values: { series: [...] } }. `since` leaves
	 * out every slot at or before it, so the page can fetch only what is new. null marks a slot where a
	 * series had nothing to say (no response timed, nobody judged).
	 */
	query(id, { since = 0, at = this.now() } = {}) {
		const guild = this.guildsById.get(String(id));
		const result = {
			guild: guild ? guild.id : String(id ?? ''),
			name: guild?.name ?? null,
			resolutionMs: this.resolutionMs,
			retentionMs: this.retentionMs,
			series: HISTORY_SERIES.map((series) => series.name),
			t: [],
			values: Object.fromEntries(HISTORY_SERIES.map((series) => [series.name, []])),
		};
		if (!guild) return result;
		const oldest = at - this.retentionMs;
		const current = Math.floor(at / this.resolutionMs) % this.capacity;
		for (let step = 1; step <= this.capacity; step++) {
			const index = (current + step) % this.capacity;
			const time = guild.times[index];
			if (!time || time <= oldest || time > at || time <= since) continue;
			result.t.push(time);
			for (const series of HISTORY_SERIES) {
				const value = guild.columns.get(series.name)[index];
				result.values[series.name].push(Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
			}
		}
		return result;
	}
}
