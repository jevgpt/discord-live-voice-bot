import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { checkHealth, healthTarget } from '../../src/healthcheck.js';
import { ActivityLog, isLoopbackHost, parseAllowedHosts, startPanel } from '../../src/panel.js';
import { transcriptFromEvents } from '../../src/summary.js';

describe('panel', () => {
	it('serves the page, validates the Host header and answers healthz, metrics, export and the date filter', async () => {
		const activity = new ActivityLog();
		activity.push({ kind: 'dm', direction: 'in', who: 'u1', whoName: '<img src=x onerror=alert(1)>', text: 'how is it going' });
		activity.push({ kind: 'voice', direction: 'in', who: 'u1', text: 'hello' });
		const panel = await startPanel({
			activity,
			port: 0,
			log: () => {},
			state: () => ({ status: 's', metrics: [] }),
			metrics: () => ({ up: 1, response_p50_ms: 420, 'bad name!': 3 }),
			health: () => ({ ok: true, voice: false }),
		});
		try {
			const page = await fetch(panel.url);
			const html = await page.text();
			assert.ok(html.includes('Local panel'), 'the panel heading comes from the English bundle');
			assert.ok(!html.includes('innerHTML'), 'user data must not be written through innerHTML');

			const events = await (await fetch(`${panel.url}/api/events`)).json();
			assert.equal(
				events.events[0].whoName,
				'<img src=x onerror=alert(1)>',
				'the data comes back untouched; the escaping happens on the client through textContent',
			);

			const rebindingStatus = await new Promise((resolve, reject) => {
				const req = http.request(`${panel.url}/api/events`, { headers: { host: 'evil.example.com' } }, (res) => {
					res.resume();
					res.on('end', () => resolve(res.statusCode));
				});
				req.on('error', reject);
				req.end();
			});
			assert.equal(rebindingStatus, 403, 'a foreign Host header must be rejected');

			const health = await (await fetch(`${panel.url}/healthz`)).json();
			assert.equal(health.ok, true);

			const metrics = await (await fetch(`${panel.url}/metrics`)).text();
			assert.ok(metrics.includes('voicebot_response_p50_ms 420'));
			assert.ok(metrics.includes('voicebot_bad_name_ 3'));

			const exported = await (await fetch(`${panel.url}/api/export?kinds=voice`)).text();
			assert.equal(exported.split('\n').length, 1);

			const future = await (await fetch(`${panel.url}/api/events?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).json();
			assert.equal(future.events.length, 0, 'the date filter drops everything older than "from"');

			const negative = await (await fetch(`${panel.url}/api/events?limit=-5`)).json();
			assert.ok(negative.events.length >= 1, 'a negative limit must not turn the query inside out');
		} finally {
			await panel.close();
		}
	});

	it('still returns and counts an event that is pushed with persist:false', async () => {
		const activity = new ActivityLog();
		const entry = activity.push({ kind: 'voice', text: 'x', persist: false });
		assert.equal(entry.kind, 'voice');
		assert.equal(activity.stats().voice, 1);
	});
});

/** A raw request, so the Host, Origin, cookie and auth headers are exactly what the test says. */
function send(url, { method = 'GET', headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers }, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (text += chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
		});
		req.on('error', reject);
		req.end(body ?? undefined);
	});
}

const TOKEN = 'a-panel-token-of-some-length';
// The four variables loadConfig insists on, for comparing its reading of PANEL with the health check's.
const CONFIG_ENV = { DISCORD_TOKEN: 't', GUILD_ID: '111111111111111111', CHANNEL_ID: '222222222222222222', OPENAI_API_KEY: 'k' };

describe('panel access', () => {
	it('knows which bind addresses stay on the machine and reads PANEL_ALLOWED_HOSTS', () => {
		for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackHost(host), true, host);
		for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '']) assert.equal(isLoopbackHost(host), false, host);
		assert.deepEqual(parseAllowedHosts(' Panel.Example.com, https://b.example.com:8443/x ,, c:99 , bad host'), [
			{ name: 'panel.example.com', port: null },
			{ name: 'b.example.com', port: 8443 },
			{ name: 'c', port: 99 },
		]);
	});

	it('on loopback without a token answers as it always did: no login, the same CSRF checks', async () => {
		const applied = [];
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, log: () => {}, applyKeys: (patch) => (applied.push(patch), { ok: true }) });
		try {
			assert.equal((await send(`${panel.url}/`)).status, 200);
			assert.equal((await send(`${panel.url}/login?token=${TOKEN}`)).status, 404, 'there is nothing to log in to');
			const keys = (headers) => send(`${panel.url}/api/keys`, { method: 'POST', headers, body: '{"openai":"sk-x"}' });
			assert.equal((await keys({ 'content-type': 'application/json', origin: `http://localhost:${panel.port}` })).status, 200);
			assert.equal((await keys({ 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403);
			assert.equal((await keys({ 'content-type': 'text/plain' })).status, 403, 'a form or text post from another page is refused');
			assert.equal(applied.length, 1);
		} finally {
			await panel.close();
		}
	});

	it('refuses to start beyond loopback without a token, and refuses a short token anywhere', async () => {
		const base = { activity: new ActivityLog(), port: 0, log: () => {} };
		await assert.rejects(() => startPanel({ ...base, host: '0.0.0.0' }), /PANEL_HOST=0\.0\.0\.0.*PANEL_TOKEN is not set/u);
		await assert.rejects(() => startPanel({ ...base, allowedHosts: ['panel.example.com'] }), /PANEL_ALLOWED_HOSTS=panel\.example\.com/u);
		await assert.rejects(() => startPanel({ ...base, host: '0.0.0.0', token: 'short' }), /at least 16 characters/u);
		// Another port for a loopback name (a published container port) is still this machine.
		const local = await startPanel({ ...base, allowedHosts: ['localhost:9000'] });
		try {
			assert.equal((await send(`${local.url}/healthz`, { headers: { host: 'localhost:9000' } })).status, 200);
		} finally {
			await local.close();
		}
	});

	it('with a token, every request needs the Bearer header or the cookie /login sets', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, token: TOKEN, log: () => {} });
		try {
			const bare = await send(`${panel.url}/api/events`);
			assert.equal(bare.status, 401);
			assert.equal(bare.headers['www-authenticate'], 'Bearer');
			assert.equal((await send(`${panel.url}/healthz`)).status, 401);
			assert.equal((await send(`${panel.url}/`, { headers: { authorization: 'Bearer wrong-token-of-some-length' } })).status, 401);
			assert.equal((await send(`${panel.url}/api/events`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);

			const wrong = await send(`${panel.url}/login?token=nope`);
			assert.equal(wrong.status, 403);
			assert.equal(wrong.headers['set-cookie'], undefined);
			assert.equal((await send(`${panel.url}/login?token=${TOKEN}`, { method: 'POST' })).status, 403, 'logging in is a visit, not a post');

			const login = await send(`${panel.url}/login?token=${encodeURIComponent(TOKEN)}`);
			assert.equal(login.status, 303);
			assert.equal(login.headers.location, '/');
			const [cookie] = login.headers['set-cookie'];
			assert.match(cookie, /; HttpOnly/u);
			assert.match(cookie, /; SameSite=Strict/u);
			assert.match(cookie, /; Path=\//u);
			assert.doesNotMatch(cookie, /; Secure/u, 'plain http cannot carry a Secure cookie');
			assert.ok(!cookie.includes(TOKEN), 'the cookie is derived from the token, not the token itself');
			const session = cookie.split(';')[0];
			assert.equal((await send(`${panel.url}/`, { headers: { cookie: `other=1; ${session}` } })).status, 200);
			assert.equal((await send(`${panel.url}/api/events`, { headers: { cookie: session } })).status, 200);
			assert.equal((await send(`${panel.url}/api/events`, { headers: { cookie: `${session}x` } })).status, 401);
			assert.equal((await send(`${panel.url}/api/events`, { headers: { cookie: `panel_session=${TOKEN}` } })).status, 401);

			const proxied = await send(`${panel.url}/login?token=${TOKEN}`, { headers: { 'x-forwarded-proto': 'https' } });
			assert.match(proxied.headers['set-cookie'][0], /; Secure/u, 'behind a TLS proxy the cookie is https-only');

			const rebinding = await send(`${panel.url}/api/events`, { headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` } });
			assert.equal(rebinding.status, 403, 'the Host check still comes first');
		} finally {
			await panel.close();
		}
	});

	it('with a token, a name in PANEL_ALLOWED_HOSTS is served and its own Origin may save keys', async () => {
		const applied = [];
		const panel = await startPanel({
			activity: new ActivityLog(),
			port: 0,
			token: TOKEN,
			allowedHosts: ['panel.example.com', 'proxy.example.com:8443'],
			applyKeys: (patch) => (applied.push(patch), { ok: true }),
			log: () => {},
		});
		const auth = { authorization: `Bearer ${TOKEN}` };
		try {
			const at = (host) => send(`${panel.url}/healthz`, { headers: { ...auth, host } });
			assert.equal((await at('panel.example.com')).status, 200);
			assert.equal((await at('panel.example.com:9443')).status, 200, 'an entry without a port takes any');
			assert.equal((await at('proxy.example.com:8443')).status, 200);
			assert.equal((await at('proxy.example.com:9000')).status, 403, 'an entry with a port takes only that one');
			assert.equal((await at('proxy.example.com')).status, 403);
			assert.equal((await at('other.example.com')).status, 403);

			const keys = (headers) =>
				send(`${panel.url}/api/keys`, { method: 'POST', headers: { ...auth, host: 'panel.example.com', ...headers }, body: '{}' });
			assert.equal((await keys({ 'content-type': 'application/json', origin: 'https://panel.example.com' })).status, 200);
			assert.equal((await keys({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
			assert.equal((await keys({ 'content-type': 'application/json', origin: 'null' })).status, 403);
			assert.equal((await keys({ 'content-type': 'text/plain', origin: 'https://panel.example.com' })).status, 403);
			assert.equal(applied.length, 1);
		} finally {
			await panel.close();
		}
	});

	it('binds beyond loopback once there is a token, and still answers the loopback health check', async () => {
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, host: '0.0.0.0', token: TOKEN, log: () => {} });
		try {
			assert.match(panel.url, /^http:\/\/0\.0\.0\.0:\d+$/u);
			const health = await send(`http://127.0.0.1:${panel.port}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } });
			assert.equal(health.status, 200);
			assert.equal((await send(`http://127.0.0.1:${panel.port}/healthz`)).status, 401);
		} finally {
			await panel.close();
		}
	});

	it('/login takes a token with + and / in it as pasted, and percent-encoded as well', async () => {
		// base64 has both; read as a form, every '+' became a space and the login failed.
		const token = 'k2V+9mQ/xZ3a+Lp0Rw8sTq==';
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, token, log: () => {} });
		try {
			assert.equal((await send(`${panel.url}/login?token=${token}`)).status, 303, 'pasted as it is');
			assert.equal((await send(`${panel.url}/login?token=${encodeURIComponent(token)}`)).status, 303, 'percent-encoded');
			assert.equal((await send(`${panel.url}/login?next=%2F&token=${encodeURIComponent(token)}`)).status, 303, 'wherever it stands in the query');
			assert.equal((await send(`${panel.url}/login?token=${token.replaceAll('+', '%20')}`)).status, 403, 'a space is not a +');
			assert.equal((await send(`${panel.url}/login?token=%E0%A4%A`)).status, 403, 'a broken escape is a wrong token, not an error');
			assert.equal((await send(`${panel.url}/login`)).status, 403);
		} finally {
			await panel.close();
		}
	});
});

describe('the container health check (src/healthcheck.js)', () => {
	it('reads PANEL the way the bot does: every off word, quoted or not, means there is no panel to ask', () => {
		for (const off of ['0', '"0"', "'0'", 'off', 'disabled', 'kapalı', 'KAPALI', 'kapali', 'hayır', 'false', ' no ']) {
			assert.equal(loadConfig({ ...CONFIG_ENV, PANEL: off }).panelEnabled, false, `the bot: PANEL=${off}`);
			assert.equal(healthTarget({ PANEL: off }), null, `the check: PANEL=${off}`);
		}
		assert.equal(healthTarget({ PANEL_PORT: '0' }), null, 'a random port is one nothing outside the bot can know');
		assert.equal(healthTarget({ PANEL: 'of' })?.url, 'http://127.0.0.1:8787/healthz', 'a word that is neither keeps the default, as in the bot');
	});

	it('asks where the panel listens, with its token', () => {
		assert.deepEqual(healthTarget({}), { url: 'http://127.0.0.1:8787/healthz', headers: {} });
		for (const wildcard of ['0.0.0.0', '::', '[::]']) {
			assert.equal(healthTarget({ PANEL_HOST: wildcard, PANEL_PORT: '9000' }).url, 'http://127.0.0.1:9000/healthz', wildcard);
		}
		assert.equal(healthTarget({ PANEL_HOST: '::1' }).url, 'http://[::1]:8787/healthz');
		assert.equal(healthTarget({ PANEL_HOST: '192.168.1.10' }).url, 'http://192.168.1.10:8787/healthz');
		const quoted = healthTarget({ PANEL_TOKEN: `"${TOKEN}"` });
		assert.deepEqual(quoted.headers, { authorization: `Bearer ${TOKEN}` }, 'the quotes an --env-file keeps are not part of it');
	});

	it('passes a panel that says it is well, and fails one that refuses, is down or says it is not', async () => {
		let healthy = true;
		const panel = await startPanel({ activity: new ActivityLog(), port: 0, host: '0.0.0.0', token: TOKEN, log: () => {}, health: () => ({ ok: healthy }) });
		try {
			const env = { PANEL_HOST: '0.0.0.0', PANEL_PORT: String(panel.port), PANEL_TOKEN: `"${TOKEN}"` };
			assert.equal(await checkHealth(env), 0);
			assert.equal(await checkHealth({ ...env, PANEL_TOKEN: 'wrong-token-of-some-length' }), 1);
			healthy = false;
			assert.equal(await checkHealth(env), 1, '/healthz answering 503');
		} finally {
			await panel.close();
		}
		let asked = 0;
		const fetchImpl = async () => (asked++, new Response('{}'));
		assert.equal(await checkHealth({ PANEL: 'disabled', PANEL_PORT: '9' }, { fetchImpl }), 0);
		assert.equal(asked, 0, 'no panel, nothing asked');
		assert.equal(await checkHealth({ PANEL_PORT: '9' }, { fetchImpl: async () => Promise.reject(new Error('ECONNREFUSED')) }), 1);
	});

	it('is what the image runs, and exits with its verdict when run as a script', () => {
		const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
		assert.match(dockerfile, /HEALTHCHECK[^\n]*\\\n\s*CMD \["node", "src\/healthcheck\.js"\]/u);
		const script = fileURLToPath(new URL('../../src/healthcheck.js', import.meta.url));
		const run = (env) => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, timeout: 20_000 }).status;
		assert.equal(run({ PANEL: '"0"' }), 0);
		assert.equal(run({ PANEL: 'kapalı' }), 0);
		assert.equal(run({ PANEL_PORT: '1' }), 1, 'nothing listens there');
	});
});

describe('summary.transcriptFromEvents', () => {
	it('takes only the spoken kinds, leaves DMs out unless asked, and trims to length', () => {
		const now = new Date().toISOString();
		const events = [
			{ kind: 'voice', direction: 'in', whoName: 'Alice', text: 'hello', at: now },
			{ kind: 'dm', direction: 'in', whoName: 'Bob', text: 'secret', at: now },
			{ kind: 'tool', text: 'send_message', at: now },
			{ kind: 'voice', direction: 'out', text: 'hi there', at: now },
		];
		const { text, count } = transcriptFromEvents(events);
		assert.equal(count, 2);
		assert.ok(text.includes('Alice: hello') && text.includes('bot: hi there'));
		assert.ok(!text.includes('secret'));
		assert.equal(transcriptFromEvents(events, { includeDm: true }).count, 3);
		assert.ok(transcriptFromEvents(events, { maxChars: 10 }).text.startsWith('…'));
	});
});
