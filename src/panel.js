// Local admin panel: what is the bot doing, who wrote what, who said what in voice?
//
// Events are kept in an in-memory ring buffer and, when asked for, appended to a JSONL file; the
// panel binds to 127.0.0.1 by default and validates the Host header (closed to DNS rebinding). It
// answers beyond loopback (PANEL_HOST, for a container or a reverse proxy) only behind PANEL_TOKEN.
// User data reaches the HTML only through textContent/setAttribute (no XSS).
//
// New events reach an open page over Server-Sent Events (/api/stream) with a metrics tick every few
// seconds; a page that cannot hold a stream polls /api/events as it always did. Every route, the stream
// included, sits behind the same Host check and the same token, and a page from another site cannot read
// or hold any of them open. The page itself is in src/panelpage.js; the hour of history it draws is kept
// by src/metrics.js.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { dirname } from 'node:path';
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';

import { t, tRaw } from './i18n/index.js';
import { ACTIVITY_KINDS, panelPage } from './panelpage.js';

const FILE_ROTATE_BYTES = 5 * 1024 * 1024;
const BACKUPS = 2;

// Personal text can arrive in `text` (a transcript, a DM, a note) or hidden inside `meta` (the owner's
// words behind a gate decision, a tool's arguments, a spoken music query). While recording is off all of
// it is replaced by its length, so the event is still counted and timed but says nothing.
const REDACT_TEXT_KINDS = new Set(['voice', 'dm', 'channel', 'memory']);
const REDACT_META_FIELDS = ['text', 'args', 'query', 'note', 'result'];

// What a redacted value becomes. A value that already is one is left alone, so redacting twice (at push
// time, and again when the stream serves an event recorded before recording was switched off) keeps the
// count of the original words instead of counting the placeholder's.
const REDACTED = /^\[\d+ characters, not recorded\]$/u;
const hidden = (value) => (REDACTED.test(String(value)) ? value : `[${String(value).length} characters, not recorded]`);

// A gate decision's line and reason quoted what somebody said until the gate stopped doing that (the
// words now go in meta.text); an older event, or one read back from the file, may still hold a quotation.
const unquoted = (value) => String(value).replace(/"[^"]*"/gu, '"…"');

function redactEntry(entry) {
	if (REDACT_TEXT_KINDS.has(entry.kind) && entry.text) entry.text = hidden(entry.text);
	const gate = entry.kind === 'gate';
	if (gate && entry.text) entry.text = unquoted(entry.text);
	if (entry.meta && typeof entry.meta === 'object') {
		for (const field of REDACT_META_FIELDS) {
			// A gate's `result` is the decision (allowed, denied...), a word the gate chose rather than
			// anybody's text; `result` is personal only where a tool's output is kept under it.
			if (gate && field === 'result' && GATE_DECISIONS.includes(entry.meta.result)) continue;
			if (entry.meta[field] !== undefined && entry.meta[field] !== null) {
				entry.meta = { ...entry.meta, [field]: hidden(entry.meta[field]) };
			}
		}
		if (gate && typeof entry.meta.reason === 'string') entry.meta = { ...entry.meta, reason: unquoted(entry.meta.reason) };
	}
	return entry;
}

/** Event kinds: dm | channel | voice | tool | gate | safety | session | latency | music | memory | health */
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
		// The live stream listens here; see subscribe().
		this.listeners = new Set();
	}

	/** Is personal text being kept out right now (RECORD_TRANSCRIPTS off)? */
	redacting() {
		return Boolean(this.redact());
	}

	/**
	 * Calls `listener(entry)` for every event pushed from now on, already redacted; returns the way to stop.
	 * A listener that throws is its own problem: whoever pushed the event never hears of it.
	 */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
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
		for (const listener of this.listeners) {
			try {
				listener(entry);
			} catch {
				/* the stream failing must not fail the event */
			}
		}
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

	/**
	 * For the panel: the latest events (kind/server/text/date filter). `guild` is a server as the events
	 * name it (its name, stamped on by the session), or its id.
	 */
	list({ since = 0, kinds = [], q = '', limit = 300, from = null, to = null, guild = null } = {}) {
		const needle = String(q ?? '').trim().toLowerCase();
		const fromMs = from ? Date.parse(from) : null;
		const toMs = to ? Date.parse(to) : null;
		const server = guild ? String(guild) : null;
		const filtered = this.events.filter((event) => {
			if (event.id <= since) return false;
			if (kinds.length && !kinds.includes(event.kind)) return false;
			if (server && event.meta?.guild !== server && event.meta?.guildId !== server) return false;
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

// Displayed labels only: the `kind` values themselves are an API and stay as they are. Read per call, so
// a language chosen after this module was loaded is the one the panel speaks.
function kindLabel(kind) {
	const labels = tRaw('panel.kinds') ?? {};
	return ACTIVITY_KINDS.includes(kind) && typeof labels[kind] === 'string' ? labels[kind] : kind;
}

// ---------------------------------------------------------------- gate audit

/** What an owner-gate decision can be; `code` (see noteGate in src/tools/helpers.js) says why. */
export const GATE_DECISIONS = ['allowed', 'denied', 'asked', 'confirmed', 'declined'];

/**
 * One kind:'gate' event as a row of the gate audit: when, which server, which tool, who asked, what was
 * decided and why. The owner's or anybody else's words are never part of it: they stay in the event's
 * meta.text, which the row does not carry. An event recorded before the reasons stopped quoting people
 * may still hold a quotation in its reason; while recording is off that is cut out here.
 */
export function gateRow(event, { redacting = false, nameFor = () => null } = {}) {
	const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
	let reason = meta.reason ? String(meta.reason) : null;
	if (reason && redacting) reason = unquoted(reason);
	const askerId = meta.askerId ? String(meta.askerId) : event.who ? String(event.who) : null;
	// A slash command's refusal names the person on the event itself; a tool's names the bot there, and
	// the person (when the audio could name them) in meta.
	const asker = meta.askerName ?? (meta.askerId ? nameFor(String(meta.askerId)) : event.who ? (event.whoName ?? nameFor(String(event.who))) : null);
	return {
		id: event.id,
		at: event.at,
		guild: meta.guild ?? null,
		tool: meta.tool ? String(meta.tool) : meta.command ? `/${meta.command}` : null,
		askerId,
		asker: asker ?? null,
		decision: meta.result ? String(meta.result) : 'denied',
		code: meta.code ? String(meta.code) : null,
		reason,
	};
}

/** The audit rows that pass every filter given; each filter is an exact value, `q` a piece of text. */
export function filterGateRows(rows, { guild = null, tool = null, decision = null, code = null, q = '' } = {}) {
	const needle = String(q ?? '').trim().toLowerCase();
	return rows.filter((row) => {
		if (guild && row.guild !== guild) return false;
		if (tool && row.tool !== tool) return false;
		if (decision && row.decision !== decision) return false;
		if (code && row.code !== code) return false;
		if (!needle) return true;
		return [row.tool, row.asker, row.reason, row.guild, row.code, row.decision].join(' ').toLowerCase().includes(needle);
	});
}

// ---------------------------------------------------------------- live stream

/** One Server-Sent Events frame. JSON carries no raw line breaks, so `data` is always one line. */
function sseFrame({ id = null, event, data }) {
	return `${id === null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The open streams, and what each of them can take. A page that stops reading (a laptop lid closed, a
 * phone on a bad network) must not make the bot hold every event for it: once a client has more than
 * `bufferBytes` waiting, what comes next for it is dropped and counted, and when its socket drains it is
 * told to resync -- to fetch what it missed from /api/events, which it can do in one request. A client
 * that does not drain within `stallMs` is closed; the browser reconnects and catches up the same way.
 */
export class StreamHub {
	constructor({ maxClients = 8, bufferBytes = 64 * 1024, stallMs = 30_000, now = Date.now } = {}) {
		this.maxClients = Math.max(1, maxClients);
		this.bufferBytes = bufferBytes;
		this.stallMs = stallMs;
		this.now = now;
		this.clients = new Set();
		this.counts = { opened: 0, refused: 0, dropped: 0, resyncs: 0, stalled: 0 };
	}

	get size() {
		return this.clients.size;
	}

	/** Takes a response as a client, or returns null when the stream is full. */
	open(response, { lastId = 0 } = {}) {
		if (this.clients.size >= this.maxClients) {
			this.counts.refused++;
			return null;
		}
		const client = { response, lastId, lagging: false, lagSince: 0, closed: false };
		this.clients.add(client);
		this.counts.opened++;
		const forget = () => {
			client.closed = true;
			this.clients.delete(client);
		};
		response.on('close', forget);
		response.on('error', forget);
		return client;
	}

	/** Writes text to one client unless it is behind; returns whether it went out. */
	write(client, text, id = null) {
		if (client.closed) return false;
		if (client.lagging) {
			this.counts.dropped++;
			return false;
		}
		client.response.write(text);
		if (id !== null) client.lastId = id;
		if (client.response.writableLength > Math.max(this.bufferBytes, client.response.writableHighWaterMark ?? 0)) this.lag(client);
		return true;
	}

	send(client, frame) {
		return this.write(client, sseFrame(frame), frame.id ?? null);
	}

	/** One frame to every client; built once. */
	broadcast(frame) {
		if (!this.clients.size) return;
		const text = sseFrame(frame);
		for (const client of this.clients) this.write(client, text, frame.id ?? null);
	}

	lag(client) {
		client.lagging = true;
		client.lagSince = this.now();
		client.response.once('drain', () => {
			if (client.closed) return;
			client.lagging = false;
			this.counts.resyncs++;
			this.send(client, { event: 'resync', data: { lastId: client.lastId } });
		});
	}

	/** A comment line keeps proxies from closing a quiet stream; a client stuck behind for too long is closed. */
	heartbeat() {
		const now = this.now();
		for (const client of this.clients) {
			if (client.lagging) {
				if (now - client.lagSince > this.stallMs) {
					this.counts.stalled++;
					client.closed = true;
					this.clients.delete(client);
					client.response.destroy();
				}
				continue;
			}
			client.response.write(': ping\n\n');
		}
	}

	closeAll() {
		for (const client of this.clients) {
			client.closed = true;
			try {
				client.response.end();
			} catch {
				/* already gone */
			}
		}
		this.clients.clear();
	}
}

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

/** A label value as the Prometheus text format writes it: backslash, quote and line break escaped. */
function labelValue(value) {
	return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelText(labels) {
	const entries = Object.entries(labels ?? {}).filter(([, value]) => value !== undefined && value !== null);
	if (!entries.length) return '';
	return `{${entries.map(([name, value]) => `${name.replace(/[^a-zA-Z0-9_]/g, '_')}="${labelValue(value)}"`).join(',')}}`;
}

/**
 * Prometheus text format. A plain number is a gauge, as every metric here always was; a family --
 * { type: 'gauge' | 'counter', samples: [{ labels, value }] } -- is written with its labels, one per
 * server, under one TYPE line.
 */
function promText(metrics = {}) {
	const lines = [];
	for (const [name, value] of Object.entries(metrics)) {
		const key = `voicebot_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
		if (value && typeof value === 'object' && Array.isArray(value.samples)) {
			const samples = value.samples.filter((sample) => Number.isFinite(Number(sample?.value)));
			if (!samples.length) continue;
			lines.push(`# TYPE ${key} ${value.type === 'counter' ? 'counter' : 'gauge'}`);
			for (const sample of samples) lines.push(`${key}${labelText(sample.labels)} ${Number(sample.value)}`);
			continue;
		}
		if (!Number.isFinite(Number(value))) continue;
		lines.push(`# TYPE ${key} gauge`, `${key} ${Number(value)}`);
	}
	return `${lines.join('\n')}\n`;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
// How many events a (re)connecting stream is sent from before it opened; more than that, and it is told
// to load the page's view again instead.
const STREAM_REPLAY = 500;

/**
 * Starts the panel. `state()` returns the live status metrics, `metrics()` the numeric measurements (for
 * the Prometheus /metrics endpoint), `health()` the health summary, `guilds()` one card per server for
 * the dashboard, and `sample()` one reading per server for `history` (a MetricsHistory), taken every
 * `tickMs` together with the stream's metrics tick.
 *
 * On loopback with no token it is open to whoever is on this machine, as it always was. Anywhere else
 * (`host` beyond loopback, or `allowedHosts` naming another machine) it refuses to start without a
 * `token`; with one, every request needs `Authorization: Bearer <token>` or the cookie that visiting
 * /login?token=<token> sets. The stream is a request like any other: the same Host check, the same token.
 * @returns {Promise<{url: string, port: number, stream: StreamHub, close: () => Promise<void>}>}
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
	guilds = () => [],
	history = null,
	sample = null,
	tickMs = 5_000,
	heartbeatMs = 15_000,
	stream: streamOptions = {},
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
	// A browser sends Origin on every cross-site request it makes on a page's behalf, a stream included,
	// and on none of the page's own GETs. No Origin (a script, curl, the page itself) or our own is fine.
	const originAllowed = (request) => {
		const origin = request.headers.origin;
		return (
			!origin ||
			origin === `http://${hostName}:${actualPort}` ||
			origin === `http://localhost:${actualPort}` ||
			(reachedByName && originMatchesHost(origin, request.headers.host))
		);
	};

	const hub = new StreamHub(streamOptions);
	const redacting = () => (typeof activity.redacting === 'function' ? activity.redacting() : false);
	/**
	 * An event as the page gets it: its kind's label, a name for whoever it is about, and for a gate
	 * decision its audit row. `strict` also redacts it again when recording is off now -- an event from
	 * before the switch still has its words in the buffer, and the newer routes never hand them out.
	 */
	const present = (event, { strict = false } = {}) => {
		const off = redacting();
		const view = {
			...event,
			badge: kindLabel(event.kind),
			whoName: event.whoName ?? (event.who ? nameFor(event.who) : null),
		};
		if (strict && off) redactEntry(view);
		if (event.kind === 'gate') view.gate = gateRow(event, { redacting: off, nameFor });
		return view;
	};
	const dashboard = () => ({
		state: state(),
		guilds: guilds(),
		historyAt: history?.latestAt() ?? 0,
		resolutionMs: history?.resolutionMs ?? null,
		retentionMs: history?.retentionMs ?? null,
		recording: !redacting(),
	});

	// Every event pushed from now on goes out to every open stream as it happens.
	const unsubscribe =
		typeof activity.subscribe === 'function'
			? activity.subscribe((event) => {
					if (hub.size) hub.broadcast({ id: event.id, event: 'activity', data: present(event, { strict: true }) });
				})
			: () => {};

	// One timer for both: a reading of every server into the history, then the dashboard to the streams.
	const tick = () => {
		try {
			if (history && sample) {
				for (const entry of sample() ?? []) if (entry?.id) history.record(entry.id, entry.reading ?? {});
			}
			if (hub.size) hub.broadcast({ event: 'metrics', data: dashboard() });
		} catch (err) {
			log(t('panel.request_failed', { error: err.message }));
		}
	};
	const tickTimer = setInterval(tick, Math.max(50, tickMs));
	tickTimer.unref?.();
	const heartbeatTimer = setInterval(() => hub.heartbeat(), Math.max(50, heartbeatMs));
	heartbeatTimer.unref?.();
	// The first reading is the baseline the history counts from; taking it now makes the first slot real.
	tick();

	/** The live stream: what was missed since `since` (or the browser's Last-Event-ID), then events as they come. */
	const openStream = (request, response, url) => {
		const since = Math.max(0, Number(request.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0) || 0);
		if (hub.size >= hub.maxClients) {
			hub.counts.refused++;
			response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
			response.end(t('panel.stream_full'));
			return;
		}
		response.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			// A reverse proxy in front would otherwise hold the frames back to fill its own buffer.
			'x-accel-buffering': 'no',
		});
		request.socket?.setNoDelay?.(true);
		const client = hub.open(response, { lastId: since });
		response.write('retry: 3000\n\n');
		const missed = activity.list({ since, limit: STREAM_REPLAY });
		// A page that has seen a later event than the log holds was open across a restart, when the ids
		// began again: nothing it knows lines up any more.
		const restarted = since > (activity.list({ limit: 1 }).lastId ?? 0);
		if (restarted || missed.total > missed.events.length) {
			// More than a replay should carry: the page loads its views again instead, which is one request
			// each. Said first and alone, so a replay filling the buffer cannot crowd it out.
			hub.send(client, { event: 'resync', data: { lastId: since, full: true } });
		} else {
			for (const event of missed.events) hub.send(client, { id: event.id, event: 'activity', data: present(event, { strict: true }) });
		}
		hub.send(client, { event: 'metrics', data: dashboard() });
	};

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
				guild: url.searchParams.get('guild') || null,
			});
			// The routes added with the live page answer reads only, and only to this panel's own page or a
			// client that is not a browser: a page on another site gets nothing, not even a stream slot.
			const NEWER = ['/api/stream', '/api/dashboard', '/api/metrics/history', '/api/gate'];
			if (NEWER.includes(url.pathname)) {
				if (request.method !== 'GET') {
					response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
					response.end(t('panel.not_found'));
					return;
				}
				if (!originAllowed(request)) {
					response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
					response.end(t('panel.local_only'));
					return;
				}
			}
			if (url.pathname === '/api/stream') {
				openStream(request, response, url);
				return;
			}
			if (url.pathname === '/api/dashboard') {
				response.writeHead(200, JSON_HEADERS);
				response.end(JSON.stringify(dashboard()));
				return;
			}
			if (url.pathname === '/api/metrics/history') {
				if (!history) {
					response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					response.end(t('panel.not_found'));
					return;
				}
				const known = history.guilds();
				const asked = String(url.searchParams.get('guild') ?? '').slice(0, 64);
				const guild = asked || (guilds()[0]?.id ? String(guilds()[0].id) : (known[0]?.id ?? ''));
				const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
				response.writeHead(200, JSON_HEADERS);
				response.end(JSON.stringify({ ...history.query(guild, { since }), guilds: known }));
				return;
			}
			if (url.pathname === '/api/gate') {
				const off = redacting();
				const rows = activity.list({ kinds: ['gate'], limit: 5000 }).events.map((event) => gateRow(event, { redacting: off, nameFor }));
				const param = (name) => url.searchParams.get(name) || null;
				const matching = filterGateRows(rows, { guild: param('guild'), tool: param('tool'), decision: param('decision'), code: param('code'), q: param('q') ?? '' });
				const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') ?? 500) || 500));
				const distinct = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort();
				response.writeHead(200, JSON_HEADERS);
				response.end(
					JSON.stringify({
						rows: matching.slice(-limit),
						total: matching.length,
						facets: { guild: distinct('guild'), tool: distinct('tool'), decision: distinct('decision'), code: distinct('code') },
					}),
				);
				return;
			}
			if (url.pathname === '/api/events') {
				const payload = activity.list({ ...filters(), limit: Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200) });
				payload.events = payload.events.map((event) => present(event));
				payload.state = state();
				response.writeHead(200, JSON_HEADERS);
				response.end(JSON.stringify(payload));
				return;
			}
			if (url.pathname === '/api/keys') {
				if (request.method === 'GET') {
					response.writeHead(200, JSON_HEADERS);
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
				if (!type.startsWith('application/json') || !originAllowed(request)) {
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
				response.writeHead(result.ok ? 200 : 400, JSON_HEADERS);
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
				response.writeHead(info.ok === false ? 503 : 200, JSON_HEADERS);
				response.end(JSON.stringify(info));
				return;
			}
			if (url.pathname === '/metrics') {
				response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
				response.end(
					promText({
						...metrics(),
						// The stream's own health: how many pages hold one, and how often one fell behind.
						panel_stream_clients: hub.size,
						panel_stream_dropped_frames_total: { type: 'counter', samples: [{ value: hub.counts.dropped }] },
						panel_stream_resyncs_total: { type: 'counter', samples: [{ value: hub.counts.resyncs }] },
						panel_stream_refused_total: { type: 'counter', samples: [{ value: hub.counts.refused }] },
					}),
				);
				return;
			}
			if (url.pathname === '/' || url.pathname === '/index.html') {
				const page = panelPage();
				response.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
					'content-security-policy': page.csp,
					'x-content-type-options': 'nosniff',
					'referrer-policy': 'no-referrer',
				});
				response.end(page.html);
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
		server.once('error', (err) => {
			clearInterval(tickTimer);
			clearInterval(heartbeatTimer);
			unsubscribe();
			reject(err);
		});
		server.listen(port, bindHost, () => {
			const address = server.address();
			actualPort = address.port;
			const url = `http://${hostName}:${actualPort}`;
			log(secret ? t('panel.ready_token', { url }) : t('panel.ready', { url }));
			resolve({
				url,
				port: actualPort,
				stream: hub,
				// The streams never end on their own, so they are ended here, or the server would wait on them.
				close: () =>
					new Promise((done) => {
						clearInterval(tickTimer);
						clearInterval(heartbeatTimer);
						unsubscribe();
						hub.closeAll();
						server.close(() => done());
						server.closeIdleConnections?.();
					}),
			});
		});
	});
}
