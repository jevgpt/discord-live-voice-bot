import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HISTORY_SERIES, LIVE_STATE, MetricsHistory } from '../../src/metrics.js';

// The panel's last hour: one row per server every ten seconds, made from readings that can come in as
// often as the caller likes. The numbers below are what the dashboard's charts are drawn from.

const SLOT = 10_000;
// A round starting point, so slot boundaries fall where the test says they do.
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % SLOT);

function reading({ allowed = 0, refused = 0, placed = 0, fragments = 0, response = [], responses = 0, live = LIVE_STATE.ready, drift = 0 } = {}) {
	return {
		gauges: { live_state: live, drift_ms: drift, quota_used_s: 60, people: 2 },
		counters: { gate_allowed: allowed, gate_refused: refused, fragments_placed: placed, fragments },
		samples: { response: { list: response, total: responses } },
	};
}

describe('MetricsHistory', () => {
	it('keeps one row per ten-second slot, counting totals from the first reading on', () => {
		const history = new MetricsHistory({ now: () => T0 + 60_000 });
		history.record('g1', reading({ allowed: 5, refused: 2 }), T0 + 1000);
		// Two readings in the next slot: what happened in both adds up, the gauge is the latest.
		history.record('g1', reading({ allowed: 6, refused: 2, drift: 100 }), T0 + SLOT + 1000);
		history.record('g1', reading({ allowed: 8, refused: 3, drift: 250 }), T0 + SLOT + 6000);
		// The third slot is skipped entirely; the fourth has one reading.
		history.record('g1', reading({ allowed: 8, refused: 4, drift: 90 }), T0 + 3 * SLOT + 500);

		const rows = history.query('g1', { at: T0 + 60_000 });
		assert.deepEqual(rows.t, [T0, T0 + SLOT, T0 + 3 * SLOT], 'slot starts, oldest first, with the missing slot left out');
		assert.deepEqual(rows.values.gate_allowed, [null, 3, 0], 'the first reading is the baseline, not a burst');
		assert.deepEqual(rows.values.gate_refused, [null, 1, 1]);
		assert.deepEqual(rows.values.drift_ms, [0, 250, 90]);
		assert.equal(rows.resolutionMs, SLOT);
		assert.equal(rows.retentionMs, 60 * 60_000);
		assert.deepEqual(rows.series, HISTORY_SERIES.map((series) => series.name));
	});

	it('takes percentiles of the timings taken in the slot only, and ratios of what grew in it', () => {
		const history = new MetricsHistory({ now: () => T0 + 60_000 });
		history.record('g1', reading({ response: [9000, 9000], responses: 2, placed: 10, fragments: 20 }), T0);
		// Three new responses; the window still holds the two old ones, which must not count again.
		history.record('g1', reading({ response: [9000, 9000, 400, 600, 800], responses: 5, placed: 19, fragments: 30 }), T0 + SLOT);
		history.record('g1', reading({ response: [9000, 9000, 400, 600, 800], responses: 5, placed: 19, fragments: 30 }), T0 + 2 * SLOT);
		const rows = history.query('g1', { at: T0 + 60_000 });
		assert.deepEqual(rows.values.response_p50_ms, [null, 600, null], 'a slot with nobody answered has no latency, not zero');
		assert.deepEqual(rows.values.placed_pct, [null, 90, null], '9 of the 10 new fragments were placed');
	});

	it('reads a total that went down as counted from zero again (a rebuilt audio bridge)', () => {
		const history = new MetricsHistory({ now: () => T0 + 60_000 });
		history.record('g1', reading({ refused: 40 }), T0);
		history.record('g1', reading({ refused: 3 }), T0 + SLOT);
		assert.deepEqual(history.query('g1', { at: T0 + 60_000 }).values.gate_refused, [null, 3]);
	});

	it('forgets what is older than an hour and never holds more than an hour of slots', () => {
		let now = T0;
		const history = new MetricsHistory({ now: () => now });
		assert.equal(history.capacity, 360);
		for (let step = 0; step < 400; step++) history.record('g1', reading({ allowed: step }), T0 + step * SLOT);
		now = T0 + 399 * SLOT;
		const rows = history.query('g1');
		assert.equal(rows.t.length, 360, 'one hour at ten seconds');
		assert.equal(rows.t[0], T0 + 40 * SLOT);
		assert.equal(rows.t.at(-1), T0 + 399 * SLOT);
		assert.ok(rows.values.gate_allowed.every((value) => value === 1));
		// Nothing heard from a server for more than an hour: it is gone.
		now += 61 * 60_000;
		assert.equal(history.query('g1').t.length, 0);
		assert.deepEqual(history.guilds(), []);
	});

	it('keeps every server apart, returns only what is new, and caps how many servers it keeps', () => {
		const history = new MetricsHistory({ maxGuilds: 2, now: () => T0 + 60_000 });
		history.record('a', { ...reading({ allowed: 1 }), name: 'Alpha' }, T0);
		history.record('b', { ...reading({ allowed: 100 }), name: 'Beta' }, T0);
		history.record('b', reading({ allowed: 150 }), T0 + SLOT);
		history.record('a', reading({ allowed: 2 }), T0 + SLOT + 1000);
		assert.deepEqual(history.query('a', { at: T0 + 60_000 }).values.gate_allowed, [null, 1]);
		assert.deepEqual(history.query('b', { at: T0 + 60_000 }).values.gate_allowed, [null, 50]);
		assert.equal(history.query('b', { at: T0 + 60_000 }).name, 'Beta');
		assert.deepEqual(history.query('a', { since: T0, at: T0 + 60_000 }).t, [T0 + SLOT], 'since leaves out what the page has');
		assert.equal(history.latestAt(), T0 + SLOT);

		// A third server over a cap of two: the one heard from longest ago (b) makes room.
		history.record('c', reading(), T0 + 2 * SLOT);
		assert.deepEqual(history.guilds().map((guild) => guild.id).sort(), ['a', 'c']);
		assert.equal(history.query('b').t.length, 0);
		assert.equal(history.query('unknown').t.length, 0);
	});

	it('has a fixed memory bound: every series and the slot times, one hour, per server', () => {
		const history = new MetricsHistory();
		assert.equal(history.bytesPerGuild, (HISTORY_SERIES.length + 1) * 360 * 8);
		assert.ok(history.bytesPerGuild * history.maxGuilds < 2 * 1024 * 1024, 'under 2 MB for every server it will keep');
	});
});
