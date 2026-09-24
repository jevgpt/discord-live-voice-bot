import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it } from 'node:test';
import { setLocale } from '../../src/i18n/index.js';
import { MetricsHistory } from '../../src/metrics.js';
import { ActivityLog, StreamHub, filterGateRows, gateRow, startPanel } from '../../src/panel.js';
import { panelPage } from '../../src/panelpage.js';

// The live panel: the event stream, the gate audit, the hour of history, the new /metrics lines and the
// page that shows them. The stream is a request like any other, so every rule the panel already had --
// the Host check, the token, the Origin -- is asserted against it and the other new routes here.

const TOKEN = 'a-panel-token-of-some-length';
const NEW_ROUTES = ['/api/stream', '/api/dashboard', '/api/metrics/history', '/api/gate'];

/** A raw request, so the Host, Origin, cookie and auth headers are exactly what the test says. */
function send(url, { method = 'GET', headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers }, (res) => {
			let text = '';
			res.setEncoding('utf8');
			// A stream that was let in would never end on its own: the status is all that is asked for.
			if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
				req.destroy();
				resolve({ status: res.statusCode, headers: res.headers, text: '' });
				return;
			}
			res.on('data', (chunk) => (text += chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** An open stream: its text so far, a way to wait for something in it, and a way to hang up. */
function connect(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { headers }, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (text += chunk));
			res.on('error', () => {});
			resolve({
				status: res.statusCode,
				headers: res.headers,
				ended: new Promise((done) => res.on('close', done)),
				get text() {
					return text;
				},
				async until(test, ms = 3000) {
					const started = Date.now();
					while (!test(text)) {
						if (Date.now() - started > ms) throw new Error(`stream never showed it; got:\n${text}`);
						await new Promise((done) => setTimeout(done, 10));
					}
					return text;
				},
				close: () => req.destroy(),
			});
		});
		req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
		req.end();
	});
}

/** The frames of a stream's text: { id, event, data, comment } each. */
function frames(text) {
	return text
		.split('\n\n')
		.filter(Boolean)
		.map((block) => {
			const frame = {};
			for (const line of block.split('\n')) {
				if (line.startsWith(':')) frame.comment = line.slice(1).trim();
				const [, field, value] = /^(\w+): ?(.*)$/u.exec(line) ?? [];
				if (field === 'data') frame.data = JSON.parse(value);
				else if (field === 'id') frame.id = Number(value);
				else if (field) frame[field] = value;
			}
			return frame;
		});
}

const waitUntil = async (test, ms = 3000) => {
	const started = Date.now();
	while (!test()) {
		if (Date.now() - started > ms) throw new Error('condition never held');
		await new Promise((done) => setTimeout(done, 10));
	}
};

describe('the new routes keep every lock the panel had', () => {
	it('refuse without the token, refuse a foreign Host, refuse a page from another site, and take GET only', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, token: TOKEN, log: () => {}, history: new MetricsHistory() });
		const bearer = { authorization: `Bearer ${TOKEN}` };
		try {
			for (const route of NEW_ROUTES) {
				const bare = await send(`${panel.url}${route}`);
				assert.equal(bare.status, 401, `${route} without the token`);
				assert.equal(bare.headers['www-authenticate'], 'Bearer');
				assert.equal((await send(`${panel.url}${route}`, { headers: { authorization: 'Bearer wrong-token-of-some-length' } })).status, 401, `${route}, wrong token`);
				assert.equal((await send(`${panel.url}${route}`, { headers: { ...bearer, host: 'evil.example.com' } })).status, 403, `${route}, foreign Host`);
				assert.equal((await send(`${panel.url}${route}`, { headers: { ...bearer, origin: 'https://evil.example' } })).status, 403, `${route}, foreign Origin`);
				assert.equal((await send(`${panel.url}${route}`, { method: 'POST', headers: bearer })).status, 405, `${route} is read-only`);
				assert.equal((await send(`${panel.url}${route}`, { headers: bearer })).status, 200, `${route} with the token`);
				assert.equal((await send(`${panel.url}${route}`, { headers: { ...bearer, origin: panel.url } })).status, 200, `${route} from the panel's own page`);
			}
			// The cookie /login sets opens the stream too: that is how a browser's EventSource gets in.
			const login = await send(`${panel.url}/login?token=${TOKEN}`);
			const cookie = login.headers['set-cookie'][0].split(';')[0];
			const stream = await connect(`${panel.url}/api/stream`, { cookie });
			assert.equal(stream.status, 200);
			assert.match(stream.headers['content-type'], /^text\/event-stream/u);
			assert.equal(stream.headers['cache-control'], 'no-store');
			stream.close();
		} finally {
			await panel.close();
		}
	});

	it('on loopback without a token, a page from another site still cannot open a stream slot', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, log: () => {} });
		try {
			assert.equal((await send(`${panel.url}/api/stream`, { headers: { origin: 'http://evil.example' } })).status, 403);
			assert.equal((await send(`${panel.url}/api/stream`, { headers: { host: 'evil.example.com' } })).status, 403, 'DNS rebinding');
			assert.equal((await send(`${panel.url}/api/stream`, { headers: { origin: `http://localhost:${panel.port}` } })).status, 200);
		} finally {
			await panel.close();
		}
	});
});

describe('the event stream', () => {
	it('replays what was missed, then sends every event as it happens, a metrics tick and heartbeats', async () => {
		const activity = new ActivityLog();
		activity.push({ kind: 'voice', direction: 'in', who: 'u1', whoName: 'Ada', text: 'first' });
		activity.push({ kind: 'dm', direction: 'in', who: 'u1', text: 'second' });
		const panel = await startPanel({
			activity,
			port: 0,
			log: () => {},
			nameFor: (id) => (id === 'u1' ? 'Ada from the index' : null),
			guilds: () => [{ id: 'g1', name: 'Alpha', live: 'ready' }],
			state: () => ({ status: 'fine' }),
			tickMs: 40,
			heartbeatMs: 40,
		});
		try {
			const stream = await connect(`${panel.url}/api/stream?since=1`);
			await stream.until((text) => text.includes('event: metrics'));
			assert.ok(stream.text.startsWith('retry: 3000\n\n'), 'the browser is told how soon to come back');
			const [replayed] = frames(stream.text).filter((frame) => frame.event === 'activity');
			assert.equal(replayed.id, 2, 'only what came after `since`');
			assert.equal(replayed.data.text, 'second');
			assert.equal(replayed.data.badge, 'DM');
			assert.equal(replayed.data.whoName, 'Ada from the index', 'a name for the id, the way /api/events gives one');
			const metrics = frames(stream.text).find((frame) => frame.event === 'metrics');
			assert.deepEqual(metrics.data.guilds, [{ id: 'g1', name: 'Alpha', live: 'ready' }]);
			assert.equal(metrics.data.state.status, 'fine');

			activity.push({ kind: 'gate', whoName: 'Melis', text: 'ban_member: denied', meta: { tool: 'ban_member', result: 'denied', code: 'not_owner', reason: 'not them', askerName: 'Gus', guild: 'Alpha' } });
			await stream.until((text) => text.includes('id: 3\n'));
			const gate = frames(stream.text).find((frame) => frame.id === 3);
			assert.equal(gate.event, 'activity');
			assert.deepEqual(
				{ tool: gate.data.gate.tool, decision: gate.data.gate.decision, code: gate.data.gate.code, asker: gate.data.gate.asker, guild: gate.data.gate.guild },
				{ tool: 'ban_member', decision: 'denied', code: 'not_owner', asker: 'Gus', guild: 'Alpha' },
				'a gate decision carries its audit row',
			);
			await stream.until((text) => text.includes(': ping\n\n'));
			await stream.until((text) => frames(text).filter((frame) => frame.event === 'metrics').length >= 3);
			// Every frame is whole: a data line holds one JSON value, and a frame ends in a blank line.
			assert.ok(stream.text.endsWith('\n\n'));
			stream.close();

			// A browser coming back sends the last id it had; that wins over the query string.
			const back = await connect(`${panel.url}/api/stream?since=0`, { 'last-event-id': '2' });
			await back.until((text) => text.includes('event: metrics'));
			assert.deepEqual(
				frames(back.text)
					.filter((frame) => frame.event === 'activity')
					.map((frame) => frame.id),
				[3],
			);
			back.close();
		} finally {
			await panel.close();
		}
	});

	it('tells a page that missed more than it can replay to load again', async () => {
		const activity = new ActivityLog();
		for (let i = 0; i < 520; i++) activity.push({ kind: 'tool', text: `call ${i}` });
		const panel = await startPanel({ activity, port: 0, log: () => {} });
		try {
			const stream = await connect(`${panel.url}/api/stream?since=0`);
			await stream.until((text) => text.includes('event: resync'));
			const resync = frames(stream.text).find((frame) => frame.event === 'resync');
			assert.equal(resync.data.full, true);
			assert.equal(frames(stream.text).filter((frame) => frame.event === 'activity').length, 0, 'no replay to crowd the notice out');
			stream.close();

			// A page left open across a restart holds ids the new log has not reached: it is told to load again.
			const stale = await connect(`${panel.url}/api/stream`, { 'last-event-id': '99999' });
			await stale.until((text) => text.includes('event: resync'));
			assert.equal(frames(stale.text).find((frame) => frame.event === 'resync').data.full, true);
			stale.close();
		} finally {
			await panel.close();
		}
	});

	it('refuses a stream past the cap (the page polls instead) and frees the slot when a page leaves', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, log: () => {}, stream: { maxClients: 1 } });
		try {
			const first = await connect(`${panel.url}/api/stream`);
			assert.equal(first.status, 200);
			await waitUntil(() => panel.stream.size === 1);
			const second = await send(`${panel.url}/api/stream`);
			assert.equal(second.status, 503);
			assert.equal(second.headers['retry-after'], '30');
			first.close();
			await waitUntil(() => panel.stream.size === 0);
			const third = await connect(`${panel.url}/api/stream`);
			assert.equal(third.status, 200);
			third.close();
			const metrics = await send(`${panel.url}/metrics`);
			assert.match(metrics.text, /^voicebot_panel_stream_refused_total 1$/mu);
		} finally {
			await panel.close();
		}
	});

	it('ends every open stream on close, so shutting down does not wait on them', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, log: () => {} });
		const stream = await connect(`${panel.url}/api/stream`);
		await waitUntil(() => panel.stream.size === 1);
		await panel.close();
		await stream.ended;
		assert.equal(panel.stream.size, 0);
	});

	it('never sends words while recording is off, even words kept from before it was switched off', async () => {
		let recording = true;
		const activity = new ActivityLog({ redact: () => !recording });
		activity.push({ kind: 'voice', direction: 'in', who: 'u1', whoName: 'Ada', text: 'the secret plan' });
		recording = false;
		activity.push({ kind: 'dm', direction: 'in', who: 'u1', text: 'a secret message' });
		activity.push({
			kind: 'gate',
			whoName: 'Melis',
			text: 'ban_member: denied (Gus spoke after the owner)',
			// An event from before the reasons stopped quoting people, and the words where they now go.
			meta: { tool: 'ban_member', result: 'denied', reason: 'Gus spoke after the owner: "secret stuff"', text: 'secret words', args: '{"text":"secret"}' },
		});
		const panel = await startPanel({ activity, port: 0, log: () => {} });
		try {
			const stream = await connect(`${panel.url}/api/stream?since=0`);
			await stream.until((text) => text.includes('event: metrics'));
			activity.push({ kind: 'voice', direction: 'in', who: 'u1', text: 'a live secret' });
			activity.push({ kind: 'tool', text: 'send_message ok', meta: { tool: 'send_message', args: '{"text":"secret"}', result: 'sent the secret' } });
			await stream.until((text) => text.includes('id: 5\n'));
			assert.ok(!/secret/iu.test(stream.text), stream.text);
			const voice = frames(stream.text).find((frame) => frame.id === 1);
			assert.equal(voice.data.text, '[15 characters, not recorded]', 'the words are counted, not sent');
			assert.equal(voice.data.whoName, 'Ada', 'who spoke is not the words');
			const decision = frames(stream.text).find((frame) => frame.id === 3);
			assert.equal(decision.data.meta.result, 'denied', 'a decision is not somebody\'s words and stays readable');
			assert.equal(decision.data.gate.decision, 'denied');
			stream.close();

			const gate = await send(`${panel.url}/api/gate`);
			assert.equal(gate.status, 200);
			assert.ok(!/secret/iu.test(gate.text), gate.text);
			assert.equal(JSON.parse(gate.text).rows[0].reason, 'Gus spoke after the owner: "…"');
		} finally {
			await panel.close();
		}
	});
});

describe('StreamHub: a page that stops reading costs a resync, not the bot memory', () => {
	/** A response that takes writes and holds them, with a buffer the test fills and drains by hand. */
	function fakeResponse() {
		const response = new EventEmitter();
		response.writes = [];
		response.writableLength = 0;
		response.writableHighWaterMark = 16;
		response.destroyed = false;
		response.write = (text) => response.writes.push(text);
		response.end = () => response.emit('close');
		response.destroy = () => {
			response.destroyed = true;
			response.emit('close');
		};
		return response;
	}

	it('drops what a client cannot take, then tells it to resync from the last event it got', () => {
		let now = 0;
		const hub = new StreamHub({ bufferBytes: 100, stallMs: 1000, now: () => now });
		const response = fakeResponse();
		const client = hub.open(response, { lastId: 4 });
		hub.broadcast({ id: 5, event: 'activity', data: { text: 'one' } });
		assert.equal(response.writes.length, 1);
		assert.match(response.writes[0], /^id: 5\nevent: activity\ndata: \{"text":"one"\}\n\n$/u);

		response.writableLength = 500; // the socket stops taking data
		hub.broadcast({ id: 6, event: 'activity', data: { text: 'two' } });
		assert.equal(client.lagging, true, 'past the buffer, the client is behind');
		hub.broadcast({ id: 7, event: 'activity', data: { text: 'three' } });
		hub.broadcast({ event: 'metrics', data: {} });
		hub.heartbeat();
		assert.equal(response.writes.length, 2, 'nothing more is queued for it');
		assert.equal(hub.counts.dropped, 2);

		response.writableLength = 0;
		response.emit('drain');
		assert.equal(client.lagging, false);
		assert.equal(hub.counts.resyncs, 1);
		assert.deepEqual(frames(response.writes[2]), [{ event: 'resync', data: { lastId: 6 } }], 'from the last event that went out');
		hub.broadcast({ id: 8, event: 'activity', data: {} });
		assert.equal(response.writes.length, 4, 'and it is live again');
	});

	it('closes a client that stays behind, and refuses one past the cap', () => {
		let now = 0;
		const hub = new StreamHub({ bufferBytes: 10, stallMs: 1000, maxClients: 1, now: () => now });
		const response = fakeResponse();
		hub.open(response);
		assert.equal(hub.open(fakeResponse()), null);
		assert.equal(hub.counts.refused, 1);
		response.writableLength = 50;
		hub.broadcast({ id: 1, event: 'activity', data: {} });
		now = 500;
		hub.heartbeat();
		assert.equal(response.destroyed, false, 'a moment behind is not stuck');
		now = 1600;
		hub.heartbeat();
		assert.equal(response.destroyed, true);
		assert.equal(hub.size, 0);
		assert.equal(hub.counts.stalled, 1);
	});
});

describe('the gate audit', () => {
	function gateLog() {
		const activity = new ActivityLog();
		const gate = (meta, extra = {}) => activity.push({ kind: 'gate', whoName: 'Melis', text: 'x', meta, ...extra });
		gate({ tool: 'ban_member', result: 'denied', code: 'not_owner', reason: 'the command was not said by the owner (Gus)', askerId: 'g', askerName: 'Gus', guild: 'Alpha' });
		gate({ tool: 'ban_member', result: 'denied', code: 'interrupted', reason: 'Gus spoke after the owner', askerId: 'o', guild: 'Alpha', text: 'wait no' });
		gate({ tool: 'kick_member', result: 'asked', code: 'untrusted_read', reason: "other people's words were read in this turn", guild: 'Beta' });
		gate({ tool: 'kick_member', result: 'confirmed', code: 'spoken_yes', reason: 'the owner said yes out loud', guild: 'Beta' });
		gate({ tool: 'grant_role', result: 'denied', code: 'risky_role', reason: 'Mods carries Ban Members', guild: 'Beta' });
		gate({ result: 'denied', code: 'not_privileged', command: 'join', guild: 'Beta' }, { who: 'u9', whoName: 'Someone' });
		activity.push({ kind: 'tool', text: 'not a gate decision' });
		return activity;
	}

	it('turns every kind:"gate" event into a row: time, server, tool, who asked, decision, reason', () => {
		const rows = gateLog()
			.events.filter((event) => event.kind === 'gate')
			.map((event) => gateRow(event, { nameFor: (id) => (id === 'o' ? 'Olga' : null) }));
		assert.equal(rows.length, 6);
		assert.deepEqual(
			rows.map((row) => [row.tool, row.asker, row.decision, row.code]),
			[
				['ban_member', 'Gus', 'denied', 'not_owner'],
				['ban_member', 'Olga', 'denied', 'interrupted'],
				['kick_member', null, 'asked', 'untrusted_read'],
				['kick_member', null, 'confirmed', 'spoken_yes'],
				['grant_role', null, 'denied', 'risky_role'],
				['/join', 'Someone', 'denied', 'not_privileged'],
			],
		);
		assert.ok(!('text' in rows[1]), 'what somebody said is not part of the row');
		assert.equal(filterGateRows(rows, { decision: 'denied', guild: 'Beta' }).length, 2);
		assert.deepEqual(filterGateRows(rows, { q: 'GUS' }).map((row) => row.code), ['not_owner', 'interrupted']);
	});

	it('/api/gate filters by server, tool, decision and reason, and lists what there is to filter by', async () => {
		const panel = await startPanel({ activity: gateLog(), port: 0, log: () => {} });
		try {
			const get = async (query = '') => JSON.parse((await send(`${panel.url}/api/gate${query}`)).text);
			const all = await get();
			assert.equal(all.total, 6);
			assert.deepEqual(all.facets.decision, ['asked', 'confirmed', 'denied']);
			assert.deepEqual(all.facets.tool, ['/join', 'ban_member', 'grant_role', 'kick_member']);
			assert.deepEqual(all.facets.guild, ['Alpha', 'Beta']);
			assert.deepEqual((await get('?decision=denied&guild=Alpha')).rows.map((row) => row.code), ['not_owner', 'interrupted']);
			assert.deepEqual((await get('?code=risky_role')).rows.map((row) => row.tool), ['grant_role']);
			assert.deepEqual((await get('?tool=kick_member')).rows.map((row) => row.decision), ['asked', 'confirmed']);
			assert.deepEqual((await get('?q=owner+said+yes')).rows.map((row) => row.code), ['spoken_yes']);
			const last = await get('?limit=2');
			assert.equal(last.total, 6);
			assert.deepEqual(last.rows.map((row) => row.code), ['risky_role', 'not_privileged'], 'the newest, oldest first');
		} finally {
			await panel.close();
		}
	});
});

describe('the metrics history and the dashboard', () => {
	it('records a reading of every server each tick and serves one server at a time', async () => {
		const history = new MetricsHistory();
		let allowed = 0;
		const panel = await startPanel({
			activity: new ActivityLog(),
			port: 0,
			log: () => {},
			history,
			tickMs: 30,
			guilds: () => [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }],
			sample: () => [
				{ id: 'a', reading: { name: 'Alpha', gauges: { drift_ms: 120 }, counters: { gate_allowed: (allowed += 2) } } },
				{ id: 'b', reading: { name: 'Beta', gauges: { drift_ms: 900 }, counters: { gate_allowed: 0 } } },
			],
		});
		try {
			await waitUntil(() => history.guilds().length === 2 && allowed >= 6);
			const alpha = JSON.parse((await send(`${panel.url}/api/metrics/history?guild=a`)).text);
			assert.equal(alpha.guild, 'a');
			assert.equal(alpha.name, 'Alpha');
			assert.equal(alpha.values.drift_ms.at(-1), 120);
			assert.ok(alpha.values.gate_allowed.some((value) => value > 0), 'the totals turned into what happened in each slot');
			assert.deepEqual(alpha.guilds.map((guild) => guild.id).sort(), ['a', 'b']);
			const first = JSON.parse((await send(`${panel.url}/api/metrics/history`)).text);
			assert.equal(first.guild, 'b', 'without a server named, the first card (the primary) is the one');
			const later = JSON.parse((await send(`${panel.url}/api/metrics/history?guild=a&since=${alpha.t.at(-1)}`)).text);
			assert.ok(later.t.every((at) => at > alpha.t.at(-1)));

			const dashboard = JSON.parse((await send(`${panel.url}/api/dashboard`)).text);
			assert.deepEqual(dashboard.guilds, [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }]);
			assert.equal(dashboard.resolutionMs, 10_000);
			assert.ok(dashboard.historyAt > 0);
		} finally {
			await panel.close();
		}
		const bare = await startPanel({ activity: new ActivityLog(), port: 0, log: () => {} });
		try {
			assert.equal((await send(`${bare.url}/api/metrics/history`)).status, 404, 'no history kept, nothing to serve');
		} finally {
			await bare.close();
		}
	});
});

describe('/metrics', () => {
	it('keeps every name it had and adds labelled families, one sample per server', async () => {
		const panel = await startPanel({
			activity: new ActivityLog(),
			port: 0,
			log: () => {},
			metrics: () => ({
				up: 1,
				response_p50_ms: 420,
				gate_decisions_total: {
					type: 'counter',
					samples: [
						{ labels: { guild: '1', guild_name: 'The "Quoted" \\ Server\nTwo', result: 'allowed' }, value: 7 },
						{ labels: { guild: '1', guild_name: 'x', result: 'denied' }, value: 2 },
					],
				},
				guild_live_state: { type: 'gauge', samples: [{ labels: { guild: '1' }, value: 2 }, { labels: { guild: '2' }, value: Number.NaN }] },
				empty_family: { type: 'gauge', samples: [] },
			}),
		});
		try {
			const text = (await send(`${panel.url}/metrics`)).text;
			assert.match(text, /^# TYPE voicebot_up gauge\nvoicebot_up 1$/mu);
			assert.match(text, /^voicebot_response_p50_ms 420$/mu);
			assert.equal(text.match(/# TYPE voicebot_gate_decisions_total counter/gu).length, 1, 'one TYPE line per family');
			assert.ok(text.includes('voicebot_gate_decisions_total{guild="1",guild_name="The \\"Quoted\\" \\\\ Server\\nTwo",result="allowed"} 7\n'));
			assert.ok(text.includes('voicebot_gate_decisions_total{guild="1",guild_name="x",result="denied"} 2\n'));
			assert.match(text, /^voicebot_guild_live_state\{guild="1"\} 2$/mu);
			assert.ok(!text.includes('guild="2"'), 'a value that is not a number is left out');
			assert.ok(!text.includes('empty_family'));
			assert.match(text, /^voicebot_panel_stream_clients 0$/mu);
			assert.match(text, /^# TYPE voicebot_panel_stream_resyncs_total counter$/mu);
			assert.match(text, /^voicebot_panel_stream_dropped_frames_total 0$/mu);
		} finally {
			await panel.close();
		}
	});
});

describe('the page', () => {
	it('builds everything with textContent: no markup from data anywhere in the served script', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, log: () => {} });
		try {
			const page = await send(`${panel.url}/`);
			assert.equal(page.status, 200);
			const html = page.text;
			for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'javascript:']) {
				assert.ok(!html.includes(sink), `the page must not use ${sink}`);
			}
			const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
			assert.equal(scripts.length, 1, 'one inline script');
			assert.equal(scripts[0][1].trim(), '', 'and no src: nothing is loaded from anywhere');
			assert.ok(!/<(?:link|img|iframe|object|embed)\b/iu.test(html), 'no stylesheet, font, image or frame from anywhere');
			assert.ok(!/@import|@font-face|url\(/iu.test(/<style>([\s\S]*?)<\/style>/u.exec(html)[1]), 'and nothing the stylesheet would fetch');
			assert.ok(!html.includes('panel.ui.'), 'every string the page asks for exists');

			// Only the page's own script and style run: their hashes are the policy.
			const csp = page.headers['content-security-policy'];
			const hash = (text) => createHash('sha256').update(text, 'utf8').digest('base64');
			assert.ok(csp.includes(`script-src 'sha256-${hash(scripts[0][2])}'`), csp);
			const style = /<style>([\s\S]*?)<\/style>/u.exec(html)[1];
			assert.ok(csp.includes(`style-src 'sha256-${hash(style)}'`), csp);
			assert.match(csp, /default-src 'none'/u);
			assert.match(csp, /connect-src 'self'/u);
			assert.match(csp, /frame-ancestors 'none'/u);
			assert.equal(page.headers['x-content-type-options'], 'nosniff');

			// Built for phones and keyboards as well: a viewport, the views as tabs, both colour schemes.
			assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/u);
			assert.equal((html.match(/role="tab"/gu) ?? []).length, 3);
			assert.match(html, /prefers-color-scheme: dark/u);
		} finally {
			await panel.close();
		}
	});

	it('speaks the active language', () => {
		try {
			setLocale('tr');
			const { html } = panelPage();
			assert.match(html, /<html lang="tr">/u);
			assert.ok(html.includes('Kapı denetimi'));
			assert.ok(!html.includes('panel.ui.'));
		} finally {
			setLocale('en');
		}
		assert.ok(panelPage().html.includes('Gate audit'));
	});
});
