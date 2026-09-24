// Local admin panel: what is the bot doing, who wrote what, who said what in voice?
//
// Events are kept in an in-memory ring buffer and, when asked for, appended to a JSONL file; the
// panel binds to 127.0.0.1 by default and validates the Host header (closed to DNS rebinding). It
// answers beyond loopback (PANEL_HOST, for a container or a reverse proxy) only behind PANEL_TOKEN.
// User data reaches the HTML only through textContent/setAttribute (no XSS).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { dirname } from 'node:path';
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';

import { t } from './i18n/index.js';

const FILE_ROTATE_BYTES = 5 * 1024 * 1024;
const BACKUPS = 2;

// Personal text can arrive in `text` (a transcript, a DM, a note) or hidden inside `meta` (the owner's
// words behind a gate decision, a tool's arguments, a spoken music query). While recording is off all of
// it is replaced by its length, so the event is still counted and timed but says nothing.
const REDACT_TEXT_KINDS = new Set(['voice', 'dm', 'channel', 'memory']);
const REDACT_META_FIELDS = ['text', 'args', 'query', 'note', 'result'];

function redactEntry(entry) {
	if (REDACT_TEXT_KINDS.has(entry.kind) && entry.text) entry.text = `[${String(entry.text).length} characters, not recorded]`;
	if (entry.meta && typeof entry.meta === 'object') {
		for (const field of REDACT_META_FIELDS) {
			if (entry.meta[field] !== undefined && entry.meta[field] !== null) {
				entry.meta = { ...entry.meta, [field]: `[${String(entry.meta[field]).length} characters, not recorded]` };
			}
		}
	}
	return entry;
}

/** Event kinds: dm | channel | voice | tool | gate | safety | session | latency | music | memory */
export class ActivityLog {
	constructor({ file = null, limit = 3000, log = null, redact = () => false } = {}) {
		this.file = file;
		this.limit = limit;
		this.log = log;
		// Privacy is enforced HERE rather than at each call site: every producer reaches push(), so a new
		// one cannot forget to redact. `redact()` is read per event so the setting can change at runtime.
		this.redact = redact;
		this.events = [];
		this.nextId = 1;
		this.counts = Object.create(null);
		this.loaded = false;
		this.dirReady = false;
		this.writeFailed = false;
		this.pending = Promise.resolve();
		this.bytesSinceStat = 0;
	}

	push(event) {
		const entry = {
			id: this.nextId++,
			at: new Date().toISOString(),
			kind: event.kind ?? 'session',
			direction: event.direction ?? null,
			who: event.who ?? null,
			whoName: event.whoName ?? null,
			text: event.text ?? '',
			meta: event.meta ?? null,
		};
		if (this.redact()) redactEntry(entry);
		this.events.push(entry);
		this.counts[entry.kind] = (this.counts[entry.kind] ?? 0) + 1;
		if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
		if (this.file && event.persist !== false) void this._append(entry);
		return entry;
	}

	async _append(entry) {
		const line = `${JSON.stringify(entry)}\n`;
		this.pending = this.pending
			.then(async () => {
				try {
					if (!this.dirReady) {
						await mkdir(dirname(this.file), { recursive: true });
						this.dirReady = true;
					}
					// Check rarely against an approximate byte counter instead of calling stat() on every event.
					this.bytesSinceStat += line.length;
					if (this.bytesSinceStat > 256 * 1024) {
						this.bytesSinceStat = 0;
						await this._rotateIfNeeded();
					}
					await appendFile(this.file, line, 'utf8');
				} catch (err) {
					if (!this.writeFailed) {
						this.writeFailed = true;
						this.log?.(t('panel.log_write_failed', { file: this.file, error: err.message }));
					}
				}
			})
			.catch(() => {});
		return this.pending;
	}

	async _rotateIfNeeded() {
		try {
			const info = await stat(this.file);
			if (info.size < FILE_ROTATE_BYTES) return;
			await unlink(`${this.file}.${BACKUPS}`).catch(() => {});
			for (let i = BACKUPS - 1; i >= 1; i--) {
				await rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => {});
			}
			await rename(this.file, `${this.file}.1`);
		} catch {
			/* no file, nothing to rotate */
		}
	}

	/** On start-up, pulls earlier sessions into the panel (the file's last lines; if too few, the .1 backup as well). */
	async load(limit = 500) {
		if (!this.file || this.loaded) return this.events.length;
		this.loaded = true;
		const lines = [];
		for (const candidate of [`${this.file}.1`, this.file]) {
			try {
				lines.push(...(await readFile(candidate, 'utf8')).split('\n').filter(Boolean));
			} catch {
				/* skip it if it is not there */
			}
		}
		const restored = [];
		for (const line of lines.slice(-limit)) {
			try {
				restored.push(JSON.parse(line));
			} catch {
				/* skip a corrupt line */
			}
		}
		// Events pushed before the load (the gateway can come up early) belong at the end.
		const fresh = this.events;
		this.events = [];
		this.counts = Object.create(null);
		for (const entry of [...restored, ...fresh]) {
			entry.id = this.nextId++;
			this.events.push(entry);
			this.counts[entry.kind] = (this.counts[entry.kind] ?? 0) + 1;
		}
		while (this.events.length > this.limit) this.events.shift();
		return restored.length;
	}

	/** For the panel: the latest events (kind/text/date filter). */
	list({ since = 0, kinds = [], q = '', limit = 300, from = null, to = null } = {}) {
		const needle = String(q ?? '').trim().toLowerCase();
		const fromMs = from ? Date.parse(from) : null;
		const toMs = to ? Date.parse(to) : null;
		const filtered = this.events.filter((event) => {
			if (event.id <= since) return false;
			if (kinds.length && !kinds.includes(event.kind)) return false;
			if (Number.isFinite(fromMs) && Date.parse(event.at) < fromMs) return false;
			if (Number.isFinite(toMs) && Date.parse(event.at) > toMs) return false;
			if (!needle) return true;
			return `${event.whoName ?? ''} ${event.text} ${event.meta ? JSON.stringify(event.meta) : ''}`.toLowerCase().includes(needle);
		});
		const take = Math.max(1, Math.min(5000, Number(limit) || 300));
		const events = filtered.slice(-take);
		return { events, lastId: this.events.length ? this.events[this.events.length - 1].id : since, total: filtered.length };
	}

	stats() {
		return { ...this.counts, total: this.events.length };
	}
}

// Displayed labels only: the `kind` values themselves are an API and stay as they are.
const KIND_LABELS = {
	dm: t('panel.kinds.dm'),
	channel: t('panel.kinds.channel'),
	voice: t('panel.kinds.voice'),
	tool: t('panel.kinds.tool'),
	gate: t('panel.kinds.gate'),
	safety: t('panel.kinds.safety'),
	session: t('panel.kinds.session'),
	latency: t('panel.kinds.latency'),
	music: t('panel.kinds.music'),
	memory: t('panel.kinds.memory'),
};

// Filter tabs, in the order they appear in the header: "all" first, then the kinds.
const TAB_KINDS = [
	['', t('panel.kinds.all')],
	['dm', KIND_LABELS.dm],
	['channel', KIND_LABELS.channel],
	['voice', KIND_LABELS.voice],
	['tool', KIND_LABELS.tool],
	['gate', KIND_LABELS.gate],
	['safety', KIND_LABELS.safety],
	['music', KIND_LABELS.music],
	['memory', KIND_LABELS.memory],
	['latency', KIND_LABELS.latency],
	['session', KIND_LABELS.session],
];

// Text injected into the inline <script> goes through JSON.stringify so quotes cannot break it.
const PAGE = `<!doctype html>
<html lang="${t('panel.html_lang')}">
<head>
<meta charset="utf-8" />
<title>${t('panel.page_title')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
	:root { color-scheme: dark; --bg:#0f1115; --card:#171a21; --line:#242835; --fg:#e6e8ee; --dim:#98a0b3; --accent:#7aa2f7; }
	* { box-sizing: border-box; }
	body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
	header { position:sticky; top:0; z-index:2; background:rgba(15,17,21,.95); border-bottom:1px solid var(--line); padding:12px 16px; }
	h1 { font-size:16px; margin:0 0 10px; }
	.bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
	button, input, a.btn { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:6px 10px; font:inherit; text-decoration:none; }
	button.active { border-color:var(--accent); color:var(--accent); }
	input[type=search] { min-width:240px; }
	main { padding:12px 16px 40px; display:flex; flex-direction:column; gap:6px; }
	.ev { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 10px; display:grid; grid-template-columns:74px 88px 150px 1fr; gap:10px; align-items:start; }
	.ev time { color:var(--dim); font-variant-numeric:tabular-nums; }
	.badge { color:var(--dim); }
	.who { color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.text { white-space:pre-wrap; word-break:break-word; }
	.dir-in .text { border-left:3px solid #3d5a80; padding-left:8px; }
	.dir-out .text { border-left:3px solid #6b8f71; padding-left:8px; }
	.kind-gate .text, .kind-safety .text { border-left:3px solid #e0a458; padding-left:8px; }
	.status { color:var(--dim); font-size:12px; margin-left:auto; display:flex; gap:12px; }
	.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:8px; margin-top:10px; }
	.metric { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 10px; }
	.metric b { display:block; font-size:18px; }
	.metric span { color:var(--dim); font-size:12px; }
	.music { margin-top:8px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
	<h1 id="title">${t('panel.heading')}</h1>
	<div class="bar" id="tabs"></div>
	<div class="bar" style="margin-top:8px">
		<input type="search" id="q" placeholder="${t('panel.search_placeholder')}" />
		<input type="datetime-local" id="from" title="${t('panel.filter_from')}" />
		<input type="datetime-local" id="to" title="${t('panel.filter_to')}" />
		<button id="pause">${t('panel.pause')}</button>
		<button id="clear">${t('panel.clear')}</button>
		<a class="btn" id="export" href="/api/export" target="_blank">${t('panel.export')}</a>
		<span class="status" id="status"></span>
	</div>
	<div class="grid" id="metrics"></div>
	<div class="music" id="music"></div>
	<div class="music" id="keys">
		<form id="keysForm">
			<input type="password" id="kOpenAI" placeholder="${t('panel.key_openai')}" autocomplete="off" />
			<input type="password" id="kDeepSeek" placeholder="${t('panel.key_deepseek')}" autocomplete="off" />
			<button type="submit">${t('panel.key_save')}</button>
			<span id="keyStatus" title="${t('panel.key_hint')}"></span>
		</form>
	</div>
</header>
<main id="list"></main>
<script>
const kinds = ${JSON.stringify(TAB_KINDS)};
let kind = '', paused = false, lastId = 0;
const list = document.getElementById('list');
const tabs = document.getElementById('tabs');
const q = document.getElementById('q');
const from = document.getElementById('from');
const to = document.getElementById('to');
for (const [value, label] of kinds) {
	const b = document.createElement('button');
	b.textContent = label;
	b.className = value === kind ? 'active' : '';
	b.onclick = () => { kind = value; [...tabs.children].forEach((c) => c.classList.remove('active')); b.classList.add('active'); reset(); };
	tabs.appendChild(b);
}
document.getElementById('pause').onclick = (e) => { paused = !paused; e.target.textContent = paused ? ${JSON.stringify(t('panel.resume'))} : ${JSON.stringify(t('panel.pause'))}; };
document.getElementById('clear').onclick = () => { list.replaceChildren(); };
const keyForm = document.getElementById('keysForm');
const keyStatus = document.getElementById('keyStatus');
async function loadKeys() {
	try {
		const res = await fetch('/api/keys', { cache: 'no-store' });
		const data = await res.json();
		document.getElementById('kOpenAI').placeholder = data.openai ? ${JSON.stringify(t('panel.key_set'))} + ' ' + data.openai : ${JSON.stringify(t('panel.key_openai'))};
		document.getElementById('kDeepSeek').placeholder = data.deepseek ? ${JSON.stringify(t('panel.key_set'))} + ' ' + data.deepseek : ${JSON.stringify(t('panel.key_deepseek'))};
	} catch { /* the rest of the panel works without the key status */ }
}
keyForm.onsubmit = async (event) => {
	event.preventDefault();
	keyStatus.textContent = ${JSON.stringify(t('panel.key_saving'))};
	const body = JSON.stringify({ openai: document.getElementById('kOpenAI').value.trim(), deepseek: document.getElementById('kDeepSeek').value.trim() });
	try {
		const res = await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		const data = await res.json();
		keyStatus.textContent = data.ok ? data.message : data.error;
		if (data.ok) {
			document.getElementById('kOpenAI').value = '';
			document.getElementById('kDeepSeek').value = '';
			loadKeys();
		}
	} catch {
		keyStatus.textContent = ${JSON.stringify(t('panel.key_failed'))};
	}
};
loadKeys();
q.oninput = () => reset();
from.onchange = () => reset();
to.onchange = () => reset();
function params(extra) {
	const p = new URLSearchParams({ q: q.value, ...extra });
	if (kind) p.set('kinds', kind);
	if (from.value) p.set('from', new Date(from.value).toISOString());
	if (to.value) p.set('to', new Date(to.value).toISOString());
	return p;
}
function reset() { list.replaceChildren(); lastId = 0; document.getElementById('export').href = '/api/export?' + params({}); }
function metric(value, label) {
	const box = document.createElement('div'); box.className = 'metric';
	const b = document.createElement('b'); b.textContent = String(value);
	const s = document.createElement('span'); s.textContent = label;
	box.append(b, s);
	return box;
}
let multiGuild = false;
function render(state) {
	document.getElementById('status').textContent = state.status ?? '';
	if (state.title) document.getElementById('title').textContent = state.title;
	document.getElementById('metrics').replaceChildren(...(state.metrics ?? []).map((m) => metric(m.value, m.label)));
	document.getElementById('music').textContent = state.music ?? '';
}
async function tick() {
	if (!paused) {
		try {
			const response = await fetch('/api/events?' + params({ since: String(lastId), limit: '200' }));
			const payload = await response.json();
			// Read before the rows are built: it decides whether they carry a server name.
			multiGuild = Boolean(payload.state && payload.state.multiGuild);
			for (const event of payload.events) {
				lastId = Math.max(lastId, event.id);
				list.appendChild(row(event));
			}
			while (list.children.length > 800) list.firstChild.remove();
			if (payload.events.length) window.scrollTo({ top: document.body.scrollHeight });
			render(payload.state);
		} catch { /* stay quiet if the server is gone */ }
	}
	setTimeout(tick, 1500);
}
function row(event) {
	const el = document.createElement('div');
	el.className = 'ev dir-' + (event.direction ?? 'none') + ' kind-' + event.kind;
	const time = document.createElement('time');
	time.textContent = new Date(event.at).toLocaleTimeString(${JSON.stringify(t('panel.time_locale'))});
	const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = event.badge ?? '';
	const who = document.createElement('span'); who.className = 'who';
	const whoText = event.whoName ? event.whoName : (event.who ?? '');
	who.textContent = whoText; who.setAttribute('title', whoText);
	const text = document.createElement('span'); text.className = 'text';
	// Which server an event came from is stamped on every session event. It is shown as a [name] prefix
	// only while the bot serves more than one, so a single-server panel reads exactly as it always did.
	const meta = { ...(event.meta ?? {}) };
	const guild = meta.guild ?? null;
	delete meta.guild;
	const prefix = multiGuild && guild ? '[' + guild + '] ' : '';
	text.textContent = prefix + event.text + (Object.keys(meta).length ? '  ' + JSON.stringify(meta) : '');
	el.append(time, badge, who, text);
	return el;
}
reset();
tick();
</script>
</body>
</html>`;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// Addresses that mean "every interface": nobody types them into a browser, so they name no Host.
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

/** Shortest PANEL_TOKEN accepted: beyond loopback the token is the whole lock, so it has to be a real one. */
export const MIN_TOKEN_LENGTH = 16;
const SESSION_COOKIE = 'panel_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Does this address keep the panel on the machine itself? */
export function isLoopbackHost(host) {
	const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/gu, '');
	return name === 'localhost' || name === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(name);
}

/** "name" or "name:port" as a Host header writes it -> { name, port }; an IPv6 name keeps its brackets. */
function splitHost(value) {
	const match = String(value ?? '').trim().toLowerCase().match(/^(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?$/u);
	return match ? { name: match[1], port: match[2] ? Number(match[2]) : null } : null;
}

/**
 * PANEL_ALLOWED_HOSTS -> [{ name, port }]. An entry with a port matches only that port, one without any:
 * a published container port or a proxy in front can put a different one in the browser's address bar.
 */
export function parseAllowedHosts(value) {
	const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
	const hosts = [];
	for (const raw of entries) {
		let text = String(raw ?? '').trim();
		if (!text) continue;
		if (text.includes('://')) {
			try {
				text = new URL(text).host;
			} catch {
				continue;
			}
		}
		const parsed = splitHost(text);
		if (parsed) hosts.push(parsed);
	}
	return hosts;
}

/**
 * The Host header check against DNS rebinding. The loopback names and the address the panel is bound to
 * pass on the panel's own port; PANEL_ALLOWED_HOSTS entries pass as they were written.
 */
function hostAllowed(hostHeader, port, { own = LOCAL_HOSTS, extra = [] } = {}) {
	const given = splitHost(hostHeader);
	if (!given) return false;
	if (own.has(given.name) && (!given.port || given.port === port || port === 0)) return true;
	return extra.some((entry) => entry.name === given.name && (entry.port === null || entry.port === given.port));
}

/** Constant-time comparison of two strings of any length (both are hashed to the same size first). */
function sameSecret(given, expected) {
	const a = createHash('sha256').update(String(given ?? '')).digest();
	const b = createHash('sha256').update(String(expected)).digest();
	return timingSafeEqual(a, b);
}

/**
 * One value of a query string, percent-decoded and nothing else. searchParams decodes a form, where '+'
 * is a space, and a base64 token pasted into /login?token=... lost every '+' it had; percent escapes
 * still work, so an encoded token logs in as well. Null when the name is missing or the escape is broken.
 */
function rawQueryValue(search, name) {
	for (const part of String(search ?? '').replace(/^\?/u, '').split('&')) {
		const index = part.indexOf('=');
		if ((index < 0 ? part : part.slice(0, index)) !== name) continue;
		try {
			return decodeURIComponent(index < 0 ? '' : part.slice(index + 1));
		} catch {
			return null;
		}
	}
	return null;
}

function bearerOf(request) {
	return /^Bearer\s+(\S+)\s*$/iu.exec(String(request.headers.authorization ?? ''))?.[1] ?? null;
}

function cookieOf(request, name) {
	for (const part of String(request.headers.cookie ?? '').split(';')) {
		const index = part.indexOf('=');
		if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return null;
}

/** Is the Origin the same site as the Host the request came in on (which has passed hostAllowed)? */
function originMatchesHost(origin, hostHeader) {
	try {
		return new URL(origin).host === String(hostHeader ?? '').trim().toLowerCase();
	} catch {
		return false;
	}
}

/** Prometheus text format. */
function promText(metrics = {}) {
	const lines = [];
	for (const [name, value] of Object.entries(metrics)) {
		if (!Number.isFinite(Number(value))) continue;
		const key = `voicebot_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
		lines.push(`# TYPE ${key} gauge`, `${key} ${Number(value)}`);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Starts the panel. `state()` returns the live status metrics, `metrics()` the numeric measurements (for
 * the Prometheus /metrics endpoint), `health()` the health summary.
 *
 * On loopback with no token it is open to whoever is on this machine, as it always was. Anywhere else
 * (`host` beyond loopback, or `allowedHosts` naming another machine) it refuses to start without a
 * `token`; with one, every request needs `Authorization: Bearer <token>` or the cookie that visiting
 * /login?token=<token> sets.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startPanel({
	activity,
	port = 8787,
	host = '127.0.0.1',
	token = null,
	allowedHosts = [],
	state = () => ({}),
	metrics = () => ({}),
	health = () => ({ ok: true }),
	keys = () => ({}),
	applyKeys = null,
	log = () => {},
	nameFor = () => null,
}) {
	const bindHost = String(host ?? '').trim() || '127.0.0.1';
	const secret = token ? String(token) : null;
	const extra = parseAllowedHosts(allowedHosts);
	if (secret && secret.length < MIN_TOKEN_LENGTH) {
		return Promise.reject(new Error(t('panel.token_too_short', { min: MIN_TOKEN_LENGTH })));
	}
	// A proxy or a published port that forwards another name is exposure as much as a public bind address.
	const exposedBy = !isLoopbackHost(bindHost)
		? `PANEL_HOST=${bindHost}`
		: extra.some((entry) => !isLoopbackHost(entry.name))
			? `PANEL_ALLOWED_HOSTS=${extra.map((entry) => entry.name).join(',')}`
			: null;
	if (exposedBy && !secret) return Promise.reject(new Error(t('panel.refused_no_token', { where: exposedBy, min: MIN_TOKEN_LENGTH })));

	// The bound address is a name the panel is reached by as well (a LAN address, say); a wildcard is not.
	const hostName = bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost;
	const own = WILDCARD_HOSTS.has(hostName.toLowerCase()) ? LOCAL_HOSTS : new Set([...LOCAL_HOSTS, hostName.toLowerCase()]);
	// The cookie holds a value derived from the token rather than the token itself, so the browser's
	// cookie store never has the one string that also works as a Bearer header.
	const session = secret ? createHmac('sha256', secret).update('panel-session').digest('base64url') : null;
	const authorized = (request) => sameSecret(bearerOf(request), secret) || sameSecret(cookieOf(request, SESSION_COOKIE), session);
	// Reached through a proxy or another name, the page's own Origin is that name rather than one of the
	// two loopback forms; it is accepted when it is the Host the request came in on, which has passed the
	// allow-list. A plain loopback panel keeps exactly the two forms it always had.
	const reachedByName = Boolean(secret) || extra.length > 0;

	let actualPort = port;
	const server = http.createServer(async (request, response) => {
		try {
			if (!hostAllowed(request.headers.host, actualPort, { own, extra })) {
				response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
				response.end(t('panel.local_only'));
				return;
			}
			// Only the path and the query are read, so the base is a placeholder.
			const url = new URL(request.url ?? '/', 'http://panel.invalid');
			if (secret && url.pathname === '/login') {
				if (request.method !== 'GET' || !sameSecret(rawQueryValue(url.search, 'token'), secret)) {
					response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
					response.end(t('panel.login_failed'));
					return;
				}
				// HttpOnly keeps it from page scripts, SameSite=Strict from requests another site starts; Secure
				// when a TLS proxy in front says the browser came in over https.
				const secure = String(request.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https' ? '; Secure' : '';
				response.writeHead(303, {
					location: '/',
					'set-cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}${secure}`,
					'cache-control': 'no-store',
					// The address bar held the token a moment ago; nothing should carry it on as a Referer.
					'referrer-policy': 'no-referrer',
				});
				response.end();
				return;
			}
			if (secret && !authorized(request)) {
				response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Bearer', 'cache-control': 'no-store' });
				response.end(t('panel.login_required'));
				return;
			}
			const filters = () => ({
				since: Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0),
				kinds: (url.searchParams.get('kinds') ?? '').split(',').filter(Boolean),
				q: url.searchParams.get('q') ?? '',
				from: url.searchParams.get('from') || null,
				to: url.searchParams.get('to') || null,
			});
			if (url.pathname === '/api/events') {
				const payload = activity.list({ ...filters(), limit: Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200) });
				payload.events = payload.events.map((event) => ({
					...event,
					badge: KIND_LABELS[event.kind] ?? event.kind,
					whoName: event.whoName ?? (event.who ? nameFor(event.who) : null),
				}));
				payload.state = state();
				response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				response.end(JSON.stringify(payload));
				return;
			}
			if (url.pathname === '/api/keys') {
				if (request.method === 'GET') {
					response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					response.end(JSON.stringify(keys()));
					return;
				}
				if (request.method !== 'POST' || !applyKeys) {
					response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
					response.end(t('panel.not_found'));
					return;
				}
				// The panel answers on loopback, so a page from somewhere else must not be able to drive it:
				// a JSON content type (only an explicit fetch sends one) plus a same-origin Origin when the
				// browser sends one keeps a drive-by form post out.
				const type = String(request.headers['content-type'] ?? '');
				const origin = request.headers.origin;
				const sameOrigin =
					!origin ||
					origin === `http://${hostName}:${actualPort}` ||
					origin === `http://localhost:${actualPort}` ||
					(reachedByName && originMatchesHost(origin, request.headers.host));
				if (!type.startsWith('application/json') || !sameOrigin) {
					response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
					response.end(t('panel.local_only'));
					return;
				}
				const body = await new Promise((resolve) => {
					let size = 0;
					let text = '';
					request.on('data', (chunk) => {
						size += chunk.length;
						if (size > 4096) {
							request.destroy();
							resolve(null);
							return;
						}
						text += chunk;
					});
					request.on('end', () => {
						try {
							resolve(JSON.parse(text || '{}'));
						} catch {
							resolve(null);
						}
					});
					request.on('error', () => resolve(null));
				});
				const result = (await applyKeys(body ?? {})) ?? { ok: false, error: t('panel.error') };
				response.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				response.end(JSON.stringify(result));
				return;
			}
			if (url.pathname === '/api/export') {
				const payload = activity.list({ ...filters(), since: 0, limit: 5000 });
				response.writeHead(200, {
					'content-type': 'application/x-ndjson; charset=utf-8',
					'content-disposition': `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.jsonl"`,
				});
				response.end(payload.events.map((event) => JSON.stringify(event)).join('\n'));
				return;
			}
			if (url.pathname === '/healthz') {
				const info = health();
				response.writeHead(info.ok === false ? 503 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				response.end(JSON.stringify(info));
				return;
			}
			if (url.pathname === '/metrics') {
				response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
				response.end(promText(metrics()));
				return;
			}
			if (url.pathname === '/' || url.pathname === '/index.html') {
				response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				response.end(PAGE);
				return;
			}
			response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(t('panel.not_found'));
		} catch (err) {
			log(t('panel.request_failed', { error: err.message }));
			if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(t('panel.error'));
		}
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, bindHost, () => {
			const address = server.address();
			actualPort = address.port;
			const url = `http://${hostName}:${actualPort}`;
			log(secret ? t('panel.ready_token', { url }) : t('panel.ready', { url }));
			resolve({
				url,
				port: actualPort,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}
