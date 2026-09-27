// The panel's one page: a dashboard of every server (state, who holds the floor, who is in voice, what is
// playing, the quota) with the last hour drawn as small charts, the activity log, and the owner gate's
// decisions as a table. It is served from 127.0.0.1 and has to work with no network at all, so there is
// nothing to fetch: no fonts, no chart library, no script from anywhere. The charts are a few SVG paths.
//
// Everything a user or a server can name -- display names, message text, track titles, server names --
// reaches the page as data and is put on it with textContent or setAttribute, never parsed as markup.
// The page's script and style are hashed into a Content-Security-Policy, so even a mistake there could
// not make an injected script run.

import { createHash } from 'node:crypto';

import { locale, t, tRaw } from './i18n/index.js';

/** The activity kinds, in the order the kind filter lists them; the values are an API and stay as they are. */
export const ACTIVITY_KINDS = ['dm', 'channel', 'voice', 'tool', 'gate', 'safety', 'music', 'memory', 'latency', 'health', 'session'];

/** Locale text for HTML: the bundles are ours, but a quote or an ampersand in a translation must not break the markup. */
function esc(text) {
	return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** A value for the inline script: JSON, with nothing in it that could close the script element. */
function scriptJson(value) {
	return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const STYLE = `
:root {
	color-scheme: light dark;
	--bg:#f5f6f8; --card:#ffffff; --line:#dde1e8; --fg:#14171c; --dim:#566070; --accent:#2257b8; --focus:#2257b8;
	--s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --quiet:#aab2bf; --track:#eceff3;
	--in:#6f93c4; --out:#6fa37b; --flag:#c98a2e; --header:rgba(245,246,248,.96);
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg:#0f1115; --card:#171a21; --line:#262b37; --fg:#e6e8ee; --dim:#9aa2b4; --accent:#8fb1f8; --focus:#8fb1f8;
		--s1:#3987e5; --s2:#d95926; --s3:#199e70; --quiet:#4d5567; --track:#1f232c;
		--in:#3d5a80; --out:#6b8f71; --flag:#e0a458; --header:rgba(15,17,21,.96);
	}
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; overflow-wrap:anywhere; }
[hidden] { display:none !important; }
.sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.skip { position:absolute; left:-9999px; top:0; }
.skip:focus { left:8px; top:8px; z-index:10; background:var(--card); color:var(--fg); padding:6px 10px; border-radius:8px; }
:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
header.top { position:sticky; top:0; z-index:3; background:var(--header); border-bottom:1px solid var(--line); padding:10px 16px 0; }
.titlebar { display:flex; align-items:center; gap:6px 12px; flex-wrap:wrap; }
h1 { font-size:16px; margin:0; }
h2 { font-size:14px; margin:18px 0 8px; }
h3 { font-size:13px; margin:0; font-weight:600; }
.conn { font-size:12px; color:var(--dim); display:inline-flex; align-items:center; gap:6px; }
.conn::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--quiet); }
.conn.live::before { background:var(--s3); }
.status { margin:4px 0 6px; color:var(--dim); font-size:12px; }
.views { display:flex; gap:2px; }
.views button { border:0; border-bottom:2px solid transparent; border-radius:0; background:none; padding:8px 10px; color:var(--dim); min-height:40px; }
.views button[aria-selected="true"] { color:var(--fg); border-bottom-color:var(--accent); }
main { padding:12px 16px 72px; max-width:1400px; margin:0 auto; }
button, input, select, a.btn { font:inherit; color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; min-height:36px; text-decoration:none; max-width:100%; }
a.btn { display:inline-flex; align-items:center; }
button { cursor:pointer; }
button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-bottom:10px; }
.toolbar label { display:flex; flex-direction:column; font-size:12px; color:var(--dim); gap:2px; min-width:0; }
.toolbar label.grow { flex:1 1 200px; }
.toolbar label.grow input { width:100%; }
.hint { color:var(--dim); font-size:12px; margin:0 0 8px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 10px; min-width:0; }
.tile b { display:block; font-size:18px; font-variant-numeric:tabular-nums; }
.tile span { color:var(--dim); font-size:12px; }
.music { margin-top:8px; color:var(--dim); font-size:12px; }
.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap:10px; }
.gcard { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; min-width:0; }
.gcard.selected { border-color:var(--accent); }
.ghead { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.gcard dl { display:grid; grid-template-columns:auto minmax(0, 1fr); gap:4px 12px; margin:8px 0; }
.gcard dt { color:var(--dim); }
.gcard dd { margin:0; min-width:0; }
.state { display:inline-flex; align-items:center; gap:6px; font-size:12px; }
.state::before { content:""; width:8px; height:8px; border-radius:50%; border:1px solid var(--quiet); }
.state.ready::before { background:var(--s1); border-color:var(--s1); }
.state.local::before { background:var(--s3); border-color:var(--s3); }
.state.connecting::before { background:var(--quiet); }
.meter { height:8px; background:var(--track); border-radius:4px; overflow:hidden; margin-top:4px; }
.meter .fill { height:100%; background:var(--s1); border-radius:4px; }
.meter .fill.high { background:var(--s2); }
.charthead { display:flex; justify-content:space-between; align-items:flex-end; gap:8px; flex-wrap:wrap; }
.charthead h2 { margin-bottom:0; }
.charts { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap:10px; margin-top:10px; }
.chart { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; min-width:0; }
.chart .top { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
.chart .value { font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
.chart .plot { height:64px; margin:6px 0 4px; border-radius:4px; }
.chart svg { display:block; width:100%; height:64px; overflow:visible; }
.readout { color:var(--dim); font-size:12px; margin:0; min-height:18px; font-variant-numeric:tabular-nums; }
.legend { list-style:none; display:flex; flex-wrap:wrap; gap:4px 12px; margin:4px 0 0; padding:0; font-size:12px; color:var(--dim); }
.legend li { display:inline-flex; align-items:center; gap:6px; }
.sw { width:10px; height:10px; border-radius:2px; background:var(--quiet); display:inline-block; }
.sw.s1 { background:var(--s1); } .sw.s2 { background:var(--s2); } .sw.s3 { background:var(--s3); }
.sw.st1 { background:var(--quiet); } .sw.st2 { background:var(--s1); } .sw.st3 { background:var(--s3); } .sw.st0 { background:var(--track); border:1px solid var(--line); }
svg .line { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
svg .line.s1 { stroke:var(--s1); } svg .line.s2 { stroke:var(--s2); } svg .line.s3 { stroke:var(--s3); }
svg .area { stroke:none; opacity:.12; }
svg .area.s1 { fill:var(--s1); }
svg .bar.s1, svg .dot.s1 { fill:var(--s1); } svg .bar.s2, svg .dot.s2 { fill:var(--s2); } svg .bar.s3, svg .dot.s3 { fill:var(--s3); }
svg .dot { stroke:var(--card); stroke-width:2; }
svg .axis { stroke:var(--line); stroke-width:1; }
svg .cursor { stroke:var(--dim); stroke-width:1; }
svg .track { fill:var(--track); }
svg .st1 { fill:var(--quiet); } svg .st2 { fill:var(--s1); } svg .st3 { fill:var(--s3); }
svg .hit { fill:transparent; }
details { margin-top:14px; }
summary { cursor:pointer; color:var(--dim); min-height:32px; }
.tablewrap { overflow-x:auto; max-width:100%; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--dim); font-weight:600; white-space:nowrap; }
td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
.decision { white-space:nowrap; }
.decision::before { content:""; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:var(--quiet); }
.decision.allowed::before { background:var(--s1); }
.decision.denied::before, .decision.declined::before { background:var(--s2); }
.decision.confirmed::before { background:var(--s3); }
.muted { color:var(--dim); font-size:12px; display:block; }
.log { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.ev { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 10px; display:grid; grid-template-columns:74px 88px minmax(0, 150px) minmax(0, 1fr); gap:10px; align-items:start; }
.ev time { color:var(--dim); font-variant-numeric:tabular-nums; }
.badge { color:var(--dim); }
.who { color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.text { white-space:pre-wrap; word-break:break-word; min-width:0; }
.dir-in .text { border-left:3px solid var(--in); padding-left:8px; }
.dir-out .text { border-left:3px solid var(--out); padding-left:8px; }
.kind-gate .text, .kind-safety .text { border-left:3px solid var(--flag); padding-left:8px; }
.jump { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); z-index:4; border-color:var(--accent); box-shadow:0 2px 12px rgba(0,0,0,.25); }
.keys form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:8px; }
.keys input { flex:1 1 200px; min-width:0; }
@media (max-width: 640px) {
	header.top { position:static; }
	.ev { grid-template-columns:auto auto minmax(0, 1fr); gap:2px 8px; }
	.ev .text { grid-column:1 / -1; }
	table.audit thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
	table.audit, table.audit tbody, table.audit tr, table.audit td { display:block; width:100%; }
	table.audit tr { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:8px; padding:6px 10px; }
	table.audit td { border:0; padding:2px 0; display:grid; grid-template-columns:7.5em minmax(0, 1fr); gap:8px; }
	table.audit td::before { content:attr(data-label); color:var(--dim); }
}
`;

// The client, as plain script text. It is written without template placeholders and without backticks,
// so String.raw hands it over exactly as it reads here; the strings and the kind list come in as JSON.
const CLIENT = String.raw`
'use strict';
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------- building DOM without markup
function h(tag, props) {
	const el = document.createElement(tag);
	if (props) {
		for (const key of Object.keys(props)) {
			const value = props[key];
			if (value === null || value === undefined || value === false) continue;
			if (key === 'className') el.className = value;
			else if (key === 'text') el.textContent = String(value);
			else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
			else el.setAttribute(key, value === true ? '' : String(value));
		}
	}
	for (let i = 2; i < arguments.length; i++) {
		const child = arguments[i];
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return el;
}
function svg(tag, attrs) {
	const el = document.createElementNS(NS, tag);
	for (const key of Object.keys(attrs || {})) el.setAttribute(key, String(attrs[key]));
	return el;
}
function fmt(template, params) {
	return String(template === undefined ? '' : template).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined ? String(params[name]) : match));
}
const number = new Intl.NumberFormat(L.time_locale, { maximumFractionDigits: 1 });
function withUnit(value, unit) {
	if (value === null || value === undefined || !isFinite(value)) return '\u2014';
	if (unit === 'ms' && Math.abs(value) >= 1000) return fmt(L.unit_s, { value: number.format(value / 1000) });
	if (unit === 'ms') return fmt(L.unit_ms, { value: number.format(Math.round(value)) });
	if (unit === 'min') return fmt(L.unit_min, { value: number.format(value) });
	if (unit === 'pct') return fmt(L.unit_pct, { value: number.format(Math.round(value)) });
	return number.format(value);
}
const clock = (at) => new Date(at).toLocaleTimeString(L.time_locale);
const safeId = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '');
async function getJson(path) {
	const response = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
	if (!response.ok) throw new Error(String(response.status));
	return response.json();
}

// ---------------------------------------------------------------- views
const VIEWS = ['dashboard', 'activity', 'gate'];
let view = 'dashboard';
function showView(name, focus) {
	view = VIEWS.includes(name) ? name : 'dashboard';
	for (const each of VIEWS) {
		const on = each === view;
		const tab = $('tab-' + each);
		tab.setAttribute('aria-selected', on ? 'true' : 'false');
		tab.tabIndex = on ? 0 : -1;
		$('view-' + each).hidden = !on;
	}
	if (focus) $('tab-' + view).focus();
	try { window.history.replaceState(null, '', '#' + view); } catch (err) { /* a file:// copy has no history to write */ }
	if (view === 'activity') { follow = true; if (!paused) flushHeld(); scrollToEnd(); }
	if (view === 'dashboard') drawCharts();
	if (view === 'gate') renderGate();
	updateCounts();
}
for (const each of VIEWS) $('tab-' + each).addEventListener('click', () => showView(each, false));
$('tabs').addEventListener('keydown', (event) => {
	const index = VIEWS.indexOf(view);
	let next = null;
	if (event.key === 'ArrowRight') next = VIEWS[(index + 1) % VIEWS.length];
	else if (event.key === 'ArrowLeft') next = VIEWS[(index + VIEWS.length - 1) % VIEWS.length];
	else if (event.key === 'Home') next = VIEWS[0];
	else if (event.key === 'End') next = VIEWS[VIEWS.length - 1];
	if (next) { event.preventDefault(); showView(next, true); }
});

// ---------------------------------------------------------------- connection
let lastSeen = 0; // the newest activity event this page has taken in, from any source
let source = null;
let pollTimer = null;
let polls = 0;
function setConn(mode) {
	const el = $('conn');
	el.className = 'conn ' + mode;
	el.textContent = L['conn_' + mode] || mode;
}
/** Every activity event, however it arrived, goes through here once. */
function take(event) {
	if (!event || typeof event.id !== 'number') return;
	lastSeen = Math.max(lastSeen, event.id);
	activityTake(event);
	if (event.kind === 'gate' && event.gate) gateTake(event.gate);
}
function connect() {
	if (source || typeof window.EventSource !== 'function') { if (!source) startPolling(); return; }
	try {
		source = new EventSource('/api/stream?since=' + lastSeen);
	} catch (err) {
		source = null;
		startPolling();
		return;
	}
	source.addEventListener('activity', (event) => { try { take(JSON.parse(event.data)); } catch (err) { /* one bad frame is not the stream */ } });
	source.addEventListener('metrics', (event) => { try { onMetrics(JSON.parse(event.data)); } catch (err) { /* the next tick will do */ } });
	source.addEventListener('resync', (event) => {
		let full = false;
		try { full = Boolean(JSON.parse(event.data).full); } catch (err) { full = true; }
		catchUp(full);
	});
	source.onopen = () => { stopPolling(); setConn('live'); };
	source.onerror = () => {
		// A refusal (the stream is full, the login has run out) closes it for good: poll instead, and try
		// the stream again now and then. Anything else the browser retries on its own.
		if (source && source.readyState === 2) {
			source.close();
			source = null;
			startPolling();
		} else {
			setConn('reconnecting');
		}
	};
}
/** Fetches what the stream could not deliver: from where this page is, or everything again. */
let catching = false;
async function catchUp(full) {
	if (full) { await Promise.all([reset(), loadGate()]); return; }
	if (catching) return;
	catching = true;
	try {
		const payload = await getJson('/api/events?since=' + lastSeen + '&limit=500');
		for (const event of payload.events) take(event);
		// More missed than one answer holds, or the log is behind this page (the bot restarted): load again.
		if (payload.total > payload.events.length || (payload.lastId || 0) < lastSeen) await Promise.all([reset(), loadGate()]);
	} catch (err) { /* the next resync or poll picks it up */ }
	catching = false;
}
function stopPolling() {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
}
function startPolling() {
	if (pollTimer) return;
	setConn('polling');
	const step = async () => {
		pollTimer = setTimeout(step, 2000);
		try {
			const payload = await getJson('/api/events?since=' + lastSeen + '&limit=500');
			for (const event of payload.events) take(event);
			if (payload.total > payload.events.length || (payload.lastId || 0) < lastSeen) { reset(); loadGate(); }
			if (payload.state) renderState(payload.state);
			setConn('polling');
		} catch (err) {
			setConn('offline');
		}
		polls++;
		if (polls % 3 === 0) loadDashboard();
		if (polls % 15 === 0 && !source && typeof window.EventSource === 'function') connect();
	};
	step();
}

// ---------------------------------------------------------------- state line and tiles
let multiGuild = false;
function renderState(state) {
	if (!state) return;
	$('status').textContent = state.status || '';
	if (state.title) { $('title').textContent = state.title; document.title = state.title; }
	multiGuild = Boolean(state.multiGuild);
	$('tiles').replaceChildren(...(state.metrics || []).map((entry) => h('div', { className: 'tile' }, h('b', { text: entry.value }), h('span', { text: entry.label }))));
	$('music').textContent = state.music || '';
}

// ---------------------------------------------------------------- dashboard: server cards
let guilds = [];
let selected = null;
function onMetrics(data) {
	if (!data) return;
	renderState(data.state);
	if (Array.isArray(data.guilds)) renderCards(data.guilds);
	if (data.historyAt && (!hist || !hist.t.length || data.historyAt >= hist.t[hist.t.length - 1])) loadHistory(true);
}
async function loadDashboard() {
	try { onMetrics(await getJson('/api/dashboard')); } catch (err) { /* stays as it was */ }
}
function fillSelect(select, options, keep) {
	const current = keep === undefined ? select.value : keep;
	select.replaceChildren(...options.map(([value, label]) => h('option', { value, text: label })));
	if (options.some(([value]) => value === current)) select.value = current;
}
function renderCards(list) {
	guilds = list;
	if (!selected || !list.some((g) => String(g.id) === selected)) selected = list.length ? String(list[0].id) : null;
	const box = $('cards');
	if (!list.length) { box.replaceChildren(h('p', { className: 'hint', text: L.no_servers })); }
	else box.replaceChildren(...list.map(card));
	fillSelect($('guildSel'), list.map((g) => [String(g.id), g.name || String(g.id)]), selected || '');
	refreshGuildFilter();
}
function card(g) {
	const id = String(g.id);
	const live = L.live_states[g.live] || g.live || '';
	const people = Array.isArray(g.people) ? g.people : [];
	const more = (g.peopleCount || 0) - people.length;
	const voice = g.voiceConnected ? '#' + (g.voiceChannel || '?') + ' \u00b7 ' + fmt(L.card_people_count, { count: g.peopleCount || 0 }) : L.card_not_in_voice;
	const music = g.music && g.music.text ? fmt(L.card_music_value, { text: g.music.text, volume: Math.round((g.music.volume || 0) * 100) }) : L.card_no_music;
	const quota = g.quota || {};
	const usedMin = Math.round((quota.used || 0) / 60);
	const limitMin = Math.round((quota.limit || 0) / 60);
	const limited = quota.enabled && quota.limit > 0;
	const share = limited ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
	const fill = h('div', { className: 'fill' + (share >= 90 ? ' high' : '') });
	fill.style.width = share + '%';
	const meter = limited ? h('div', { className: 'meter', role: 'meter', 'aria-label': L.card_quota, 'aria-valuemin': '0', 'aria-valuemax': String(limitMin), 'aria-valuenow': String(usedMin) }, fill) : null;
	const isSelected = id === selected;
	const button = h('button', { type: 'button', 'aria-pressed': isSelected ? 'true' : 'false', text: isSelected ? L.card_charts_shown : L.card_show_charts, onclick: () => selectGuild(id) });
	return h('article', { className: 'gcard' + (isSelected ? ' selected' : ''), 'aria-labelledby': 'g-' + safeId(id) },
		h('div', { className: 'ghead' }, h('h3', { id: 'g-' + safeId(id), text: g.name || id }), h('span', { className: 'state ' + safeId(g.live || 'off'), text: live })),
		h('dl', null,
			h('dt', { text: L.card_voice }), h('dd', { text: voice }),
			h('dt', { text: L.card_floor }), h('dd', { text: g.floor || L.card_nobody }),
			h('dt', { text: L.card_people }), h('dd', { text: people.length ? people.join(', ') + (more > 0 ? ' ' + fmt(L.card_more, { count: more }) : '') : L.card_nobody }),
			h('dt', { text: L.card_music }), h('dd', { text: music }),
			h('dt', { text: L.card_quota }), h('dd', null, limited ? fmt(L.card_quota_value, { used: usedMin, limit: limitMin }) : fmt(L.card_quota_unlimited, { used: usedMin }), meter),
		),
		g.liveBlocked ? h('p', { className: 'hint', text: g.liveBlocked }) : null,
		button,
	);
}
function selectGuild(id) {
	if (id === selected) return;
	selected = id;
	hist = null;
	renderCards(guilds);
	drawCharts();
	loadHistory(false);
}
$('guildSel').addEventListener('change', (event) => selectGuild(event.target.value));

// ---------------------------------------------------------------- dashboard: the last hour
let hist = null;
let histLoading = false;
async function loadHistory(incremental) {
	if (!selected || histLoading) return;
	histLoading = true;
	const guild = selected;
	try {
		const since = incremental && hist && hist.t.length > 1 ? hist.t[hist.t.length - 2] : 0;
		const data = await getJson('/api/metrics/history?guild=' + encodeURIComponent(guild) + (since ? '&since=' + since : ''));
		if (guild !== selected) return;
		if (!since || !hist) hist = data;
		else {
			// The newest slot is still filling while its ten seconds last, so it is taken again each time.
			const first = data.t.length ? data.t[0] : Infinity;
			let keep = hist.t.length;
			while (keep > 0 && hist.t[keep - 1] >= first) keep--;
			hist.t = hist.t.slice(0, keep).concat(data.t);
			for (const name of Object.keys(data.values)) hist.values[name] = (hist.values[name] || []).slice(0, keep).concat(data.values[name]);
			const oldest = hist.t.length ? hist.t[hist.t.length - 1] - hist.retentionMs : 0;
			let drop = 0;
			while (drop < hist.t.length && hist.t[drop] <= oldest) drop++;
			if (drop) {
				hist.t = hist.t.slice(drop);
				for (const name of Object.keys(hist.values)) hist.values[name] = hist.values[name].slice(drop);
			}
		}
		drawCharts();
	} catch (err) {
		/* the charts keep what they had */
	} finally {
		histLoading = false;
	}
}

const CHARTS = [
	{ id: 'response', title: L.chart_response, kind: 'line', unit: 'ms', series: [{ key: 'response_p50_ms', slot: 1 }] },
	{ id: 'live', title: L.chart_live, kind: 'strip', series: [{ key: 'live_state' }] },
	{ id: 'drift', title: L.chart_drift, kind: 'line', unit: 'ms', series: [{ key: 'drift_ms', slot: 1 }] },
	{ id: 'placed', title: L.chart_placed, kind: 'line', unit: 'pct', max: 100, series: [{ key: 'placed_pct', slot: 1 }] },
	{ id: 'gate', title: L.chart_gate, kind: 'bars', series: [{ key: 'gate_allowed', slot: 1, label: L.legend_allowed }, { key: 'gate_refused', slot: 2, label: L.legend_refused }] },
	{ id: 'jev', title: L.chart_jev, kind: 'bars', series: [{ key: 'jev_for_bot', slot: 1, label: L.legend_for_bot }, { key: 'jev_not_for_bot', slot: 2, label: L.legend_not_for_bot }, { key: 'jev_failed', slot: 3, label: L.legend_failed }] },
	{ id: 'jevms', title: L.chart_jev_ms, kind: 'line', unit: 'ms', series: [{ key: 'jev_p50_ms', slot: 1 }] },
	{ id: 'tools', title: L.chart_tools, kind: 'line', unit: 'ms', series: [{ key: 'tool_p50_ms', slot: 1, label: L.legend_p50 }, { key: 'tool_p95_ms', slot: 2, label: L.legend_p95 }] },
	{ id: 'loop', title: L.chart_loop, kind: 'line', unit: 'ms', series: [{ key: 'loop_late_ms', slot: 1 }] },
	{ id: 'dropped', title: L.chart_dropped, kind: 'bars', series: [{ key: 'dropped_frames', slot: 1 }] },
	{ id: 'quota', title: L.chart_quota, kind: 'line', unit: 'min', series: [{ key: 'quota_used_s', slot: 1, scale: 1 / 60 }] },
];
const STATES = [[2, L.live_states.ready], [3, L.live_states.local], [1, L.live_states.connecting], [0, L.live_states.off]];
const hover = {};

function valuesOf(series) {
	if (!hist) return [];
	if (series.key === 'jev_for_bot') {
		const calls = hist.values.jev_calls || [];
		const not = hist.values.jev_not_for_bot || [];
		const failed = hist.values.jev_failed || [];
		return calls.map((value, i) => (value === null ? null : Math.max(0, value - (not[i] || 0) - (failed[i] || 0))));
	}
	const raw = hist.values[series.key] || [];
	return series.scale ? raw.map((value) => (value === null ? null : value * series.scale)) : raw;
}
function lastValue(list) {
	for (let i = list.length - 1; i >= 0; i--) if (list[i] !== null) return list[i];
	return null;
}
function niceMax(value) {
	if (!(value > 0)) return 1;
	const power = Math.pow(10, Math.floor(Math.log10(value)));
	for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
	return 10 * power;
}
function sumOf(list) { return list.reduce((total, value) => total + (value || 0), 0); }

/** What a chart says when nobody is pointing at it: the latest value, the peak, or the hour's totals. */
function summary(chart, columns) {
	if (chart.kind === 'strip') {
		const now = lastValue(columns[0]);
		const state = STATES.find(([value]) => value === now);
		return { value: state ? state[1] : '\u2014', note: '' };
	}
	if (chart.kind === 'bars') {
		const parts = chart.series.map((series, i) => (series.label ? series.label + ' ' : '') + number.format(sumOf(columns[i])));
		return { value: number.format(columns.reduce((total, list) => total + sumOf(list), 0)), note: fmt(L.total_hour, { value: parts.join(' \u00b7 ') }) };
	}
	const peak = Math.max(...columns[columns.length - 1].filter((value) => value !== null), -Infinity);
	return {
		value: withUnit(lastValue(columns[0]), chart.unit),
		note: isFinite(peak) ? fmt(L.peak, { value: withUnit(peak, chart.unit) }) : '',
	};
}
function pointText(chart, columns, index) {
	const parts = [clock(hist.t[index])];
	if (chart.kind === 'strip') {
		const state = STATES.find(([value]) => value === columns[0][index]);
		parts.push(state ? state[1] : '\u2014');
	} else {
		chart.series.forEach((series, i) => {
			const value = columns[i][index];
			parts.push((series.label ? series.label + ' ' : '') + (chart.kind === 'bars' ? (value === null ? '\u2014' : number.format(value)) : withUnit(value, chart.unit)));
		});
	}
	return parts.join(' \u00b7 ');
}

function plot(chart, columns, holder, readout, rest) {
	const width = Math.max(160, Math.floor(holder.clientWidth || 280));
	const height = 64;
	const pad = { l: 1, r: 6, t: 6, b: 5 };
	const res = hist.resolutionMs;
	const end = hist.t.length ? hist.t[hist.t.length - 1] + res : Date.now();
	const start = end - hist.retentionMs;
	const span = width - pad.l - pad.r;
	const x = (at) => pad.l + ((at + res / 2 - start) / (end - start)) * span;
	const slotWidth = (span * res) / (end - start);
	let top = chart.max || 0;
	if (!top) {
		let max = 0;
		if (chart.kind === 'bars') hist.t.forEach((_, i) => { max = Math.max(max, columns.reduce((total, list) => total + (list[i] || 0), 0)); });
		else columns.forEach((list) => list.forEach((value) => { if (value !== null && value > max) max = value; }));
		top = niceMax(max);
	}
	const y = (value) => height - pad.b - (Math.max(0, value) / top) * (height - pad.t - pad.b);
	const box = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, width, height, role: 'img', 'aria-label': chart.title + ': ' + rest.value + (rest.note ? ', ' + rest.note : ''), focusable: 'false' });
	if (chart.kind === 'strip') {
		box.append(svg('rect', { class: 'track', x: pad.l, y: height / 2 - 8, width: span, height: 16, rx: 3 }));
		columns[0].forEach((value, i) => {
			if (!(value > 0)) return;
			box.append(svg('rect', { class: 'st' + value, x: x(hist.t[i]) - slotWidth / 2, y: height / 2 - 8, width: slotWidth + 0.5, height: 16 }));
		});
	} else {
		box.append(svg('line', { class: 'axis', x1: pad.l, x2: width - pad.r, y1: y(0), y2: y(0) }));
	}
	if (chart.kind === 'bars') {
		const barWidth = Math.max(1, Math.min(24, slotWidth - (slotWidth >= 4 ? 1 : 0)));
		hist.t.forEach((at, i) => {
			let base = 0;
			chart.series.forEach((series, k) => {
				const value = columns[k][i];
				if (!(value > 0)) return;
				box.append(svg('rect', { class: 'bar s' + series.slot, x: x(at) - barWidth / 2, y: y(base + value), width: barWidth, height: Math.max(0.5, y(base) - y(base + value)) }));
				base += value;
			});
		});
	}
	if (chart.kind === 'line') {
		// Drawn last to first, so the first series (P50 beside P95) is the one on top where they meet.
		chart.series.map((series, k) => [series, k]).reverse().forEach(([series, k]) => {
			const list = columns[k];
			let line = '';
			let area = '';
			let run = [];
			const lone = [];
			const close = () => {
				if (run.length === 1) lone.push(run[0]);
				if (run.length && chart.series.length === 1) area += 'M' + run[0][0] + ',' + y(0) + run.map(([px, py]) => 'L' + px + ',' + py).join('') + 'L' + run[run.length - 1][0] + ',' + y(0) + 'Z';
				run = [];
			};
			// A slot where nothing was timed (nobody spoke, no tool ran) says nothing, so the line carries on
			// across it. A slot that is missing altogether -- the bot was down -- is a real gap and breaks it.
			let broken = false;
			list.forEach((value, i) => {
				if (i > 0 && hist.t[i] - hist.t[i - 1] > res * 1.5) broken = true;
				if (value === null) return;
				if (broken) { close(); broken = false; }
				const point = [Math.round(x(hist.t[i]) * 10) / 10, Math.round(y(value) * 10) / 10];
				line += (run.length ? 'L' : 'M') + point[0] + ',' + point[1];
				run.push(point);
			});
			close();
			if (area) box.append(svg('path', { class: 'area s' + series.slot, d: area }));
			if (line) box.append(svg('path', { class: 'line s' + series.slot, d: line }));
			for (const [px, py] of lone) box.append(svg('circle', { class: 'dot s' + series.slot, cx: px, cy: py, r: 2.5 }));
			for (let i = list.length - 1; i >= 0; i--) {
				if (list[i] === null) continue;
				box.append(svg('circle', { class: 'dot s' + series.slot, cx: x(hist.t[i]), cy: y(list[i]), r: 4 }));
				break;
			}
		});
	}
	const index = hover[chart.id];
	if (index !== undefined && index < hist.t.length) {
		box.append(svg('line', { class: 'cursor', x1: x(hist.t[index]), x2: x(hist.t[index]), y1: pad.t - 4, y2: height - pad.b }));
		readout.textContent = pointText(chart, columns, index);
	} else {
		readout.textContent = rest.note;
	}
	const hit = svg('rect', { class: 'hit', x: 0, y: 0, width, height });
	box.append(hit);
	const nearest = (clientX) => {
		const rect = box.getBoundingClientRect();
		const at = start + ((clientX - rect.left - pad.l) / span) * (end - start) - res / 2;
		let best = 0;
		for (let i = 1; i < hist.t.length; i++) if (Math.abs(hist.t[i] - at) < Math.abs(hist.t[best] - at)) best = i;
		return best;
	};
	hit.addEventListener('pointermove', (event) => { if (!hist.t.length) return; hover[chart.id] = nearest(event.clientX); redraw(chart.id); });
	hit.addEventListener('pointerleave', () => { delete hover[chart.id]; redraw(chart.id); });
	return box;
}

const chartNodes = {};
function chartCard(chart) {
	const holder = h('div', { className: 'plot', tabindex: '0', 'aria-describedby': 'r-' + chart.id + ' charts-help' });
	const readout = h('p', { className: 'readout', id: 'r-' + chart.id, 'aria-live': 'polite' });
	const value = h('span', { className: 'value' });
	const legend = chart.kind === 'strip'
		? h('ul', { className: 'legend' }, ...STATES.map(([state, label]) => h('li', null, h('span', { className: 'sw st' + state, 'aria-hidden': 'true' }), label)))
		: chart.series.length > 1
			? h('ul', { className: 'legend' }, ...chart.series.map((series) => h('li', null, h('span', { className: 'sw s' + series.slot, 'aria-hidden': 'true' }), series.label)))
			: null;
	holder.addEventListener('keydown', (event) => {
		if (!hist || !hist.t.length) return;
		const last = hist.t.length - 1;
		const current = hover[chart.id] === undefined ? last : hover[chart.id];
		let next = null;
		if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
		else if (event.key === 'ArrowRight') next = Math.min(last, current + 1);
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = last;
		else if (event.key === 'Escape') { delete hover[chart.id]; redraw(chart.id); return; }
		if (next === null) return;
		event.preventDefault();
		hover[chart.id] = next;
		redraw(chart.id);
	});
	holder.addEventListener('blur', () => { if (hover[chart.id] !== undefined) { delete hover[chart.id]; redraw(chart.id); } });
	const node = h('section', { className: 'chart', 'aria-labelledby': 'c-' + chart.id },
		h('div', { className: 'top' }, h('h3', { id: 'c-' + chart.id, text: chart.title }), value),
		holder, readout, legend);
	chartNodes[chart.id] = { node, holder, readout, value };
	return node;
}
function redraw(id) {
	const chart = CHARTS.find((each) => each.id === id);
	const nodes = chartNodes[id];
	if (!chart || !nodes) return;
	if (!hist || !hist.t.length) {
		nodes.holder.replaceChildren();
		nodes.value.textContent = '\u2014';
		nodes.readout.textContent = '';
		return;
	}
	const columns = chart.series.map(valuesOf);
	const rest = summary(chart, columns);
	nodes.value.textContent = rest.value;
	nodes.holder.replaceChildren(plot(chart, columns, nodes.holder, nodes.readout, rest));
}
function drawCharts() {
	const box = $('charts');
	if (!box.children.length) box.replaceChildren(...CHARTS.map(chartCard));
	$('chartsEmpty').hidden = Boolean(hist && hist.t.length);
	if (view !== 'dashboard') return;
	for (const chart of CHARTS) redraw(chart.id);
	if ($('tableView').open) renderTable();
}
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

/** The same numbers as a table, for a screen reader and for anybody who wants the values themselves. */
function renderTable() {
	const table = $('histTable');
	if (!hist || !hist.t.length) { table.replaceChildren(); return; }
	const columns = [
		[L.col_time, null],
		[L.chart_response, { key: 'response_p50_ms', unit: 'ms' }],
		[L.chart_drift, { key: 'drift_ms', unit: 'ms' }],
		[L.chart_placed, { key: 'placed_pct', unit: 'pct' }],
		[L.chart_gate + ' (' + L.legend_allowed + ')', { key: 'gate_allowed' }],
		[L.chart_gate + ' (' + L.legend_refused + ')', { key: 'gate_refused' }],
		[L.chart_jev, { key: 'jev_calls' }],
		[L.chart_jev_ms, { key: 'jev_p50_ms', unit: 'ms' }],
		[L.chart_tools + ' ' + L.legend_p50, { key: 'tool_p50_ms', unit: 'ms' }],
		[L.chart_tools + ' ' + L.legend_p95, { key: 'tool_p95_ms', unit: 'ms' }],
		[L.chart_loop, { key: 'loop_late_ms', unit: 'ms' }],
		[L.chart_dropped, { key: 'dropped_frames' }],
		[L.chart_quota, { key: 'quota_used_s', unit: 'min', scale: 1 / 60 }],
	];
	const rows = [];
	const from = Math.max(0, hist.t.length - 30);
	for (let i = hist.t.length - 1; i >= from; i--) {
		rows.push(h('tr', null, ...columns.map(([, spec]) => {
			if (!spec) return h('td', { className: 'num', text: clock(hist.t[i]) });
			const raw = (hist.values[spec.key] || [])[i];
			const value = raw === null || raw === undefined ? null : spec.scale ? raw * spec.scale : raw;
			return h('td', { className: 'num', text: spec.unit ? withUnit(value, spec.unit) : value === null ? '\u2014' : number.format(value) });
		})));
	}
	table.replaceChildren(
		h('caption', { className: 'sr', text: fmt(L.data_table, { count: rows.length }) }),
		h('thead', null, h('tr', null, ...columns.map(([label]) => h('th', { scope: 'col', text: label })))),
		h('tbody', null, ...rows));
}
$('tableView').addEventListener('toggle', () => { if ($('tableView').open) renderTable(); });

// ---------------------------------------------------------------- activity log
const MAX_ROWS = 800;
const list = $('list');
const shown = [];
let activityMax = 0;
let loading = false;
let pending = [];
let paused = false;
let follow = true;
let held = [];
let heldOverflow = false;
let current = null;
let resetGeneration = 0;

fillSelect($('kind'), [['', L.kinds.all]].concat(KINDS.map((kind) => [kind, L.kinds[kind] || kind])));
function guildNames() {
	const names = new Set(guilds.map((g) => g.name).filter(Boolean));
	for (const event of shown) if (event.meta && event.meta.guild) names.add(String(event.meta.guild));
	return [...names].sort();
}
function refreshGuildFilter() {
	const names = guildNames();
	fillSelect($('guildFilter'), [['', L.guild_all]].concat(names.map((name) => [name, name])));
	$('guildFilterWrap').hidden = names.length < 2 && !$('guildFilter').value;
}
function readFilters() {
	const from = $('from').value ? new Date($('from').value).getTime() : null;
	const to = $('to').value ? new Date($('to').value).getTime() : null;
	return { kind: $('kind').value, guild: $('guildFilter').value, q: $('q').value.trim().toLowerCase(), from: isFinite(from) ? from : null, to: isFinite(to) ? to : null };
}
/** The same test the server applies to /api/events, for the events the stream brings in. */
function matches(event, f) {
	if (f.kind && event.kind !== f.kind) return false;
	if (f.guild && !(event.meta && event.meta.guild === f.guild)) return false;
	const at = Date.parse(event.at);
	if (f.from !== null && at < f.from) return false;
	if (f.to !== null && at > f.to) return false;
	if (!f.q) return true;
	return ((event.whoName || '') + ' ' + event.text + ' ' + (event.meta ? JSON.stringify(event.meta) : '')).toLowerCase().includes(f.q);
}
function params(extra) {
	const f = readFilters();
	const p = new URLSearchParams(Object.assign({ q: $('q').value }, extra || {}));
	if (f.kind) p.set('kinds', f.kind);
	if (f.guild) p.set('guild', f.guild);
	if (f.from !== null) p.set('from', new Date(f.from).toISOString());
	if (f.to !== null) p.set('to', new Date(f.to).toISOString());
	return p;
}
function row(event) {
	const meta = Object.assign({}, event.meta || {});
	const guild = meta.guild || null;
	delete meta.guild;
	// Which server an event came from is on every session event; it is shown as a [name] prefix only while
	// the bot serves more than one, so a single-server panel reads as it always did.
	const prefix = multiGuild && guild ? '[' + guild + '] ' : '';
	const whoText = event.whoName ? event.whoName : event.who || '';
	return h('li', { className: 'ev dir-' + safeId(event.direction || 'none') + ' kind-' + safeId(event.kind) },
		h('time', { datetime: event.at, text: clock(event.at) }),
		h('span', { className: 'badge', text: event.badge || event.kind }),
		h('span', { className: 'who', title: whoText, text: whoText }),
		h('span', { className: 'text', text: prefix + (event.text || '') + (Object.keys(meta).length ? '  ' + JSON.stringify(meta) : '') }));
}
function appendRow(event) {
	list.append(row(event));
	shown.push(event);
	while (shown.length > MAX_ROWS) { shown.shift(); list.firstChild.remove(); }
}
function atBottom() {
	return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;
}
function scrollToEnd() {
	if (view === 'activity') window.scrollTo({ top: document.documentElement.scrollHeight });
}
function updateCounts() {
	$('activityCount').textContent = fmt(L.activity_count, { count: shown.length });
	const jump = $('jump');
	const waiting = held.length > 0 || heldOverflow;
	jump.hidden = !waiting || view !== 'activity';
	jump.textContent = heldOverflow ? L.held_overflow : fmt(paused ? L.paused_waiting : L.new_events, { count: held.length });
}
async function reset() {
	const generation = ++resetGeneration;
	current = readFilters();
	loading = true;
	pending = [];
	held = [];
	heldOverflow = false;
	$('export').href = '/api/export?' + params();
	try {
		const payload = await getJson('/api/events?' + params({ since: '0', limit: '500' }));
		if (generation !== resetGeneration) return;
		list.replaceChildren();
		shown.length = 0;
		renderState(payload.state);
		for (const event of payload.events) appendRow(event);
		// Where the log is now, not the most this page has ever seen: after a restart the ids begin again.
		activityMax = payload.lastId || 0;
		lastSeen = payload.lastId || 0;
	} catch (err) {
		/* keeps what it had; the stream or the next poll fills in */
	} finally {
		if (generation === resetGeneration) {
			loading = false;
			const queued = pending;
			pending = [];
			for (const event of queued) activityTake(event);
			refreshGuildFilter();
			updateCounts();
			follow = true;
			scrollToEnd();
		}
	}
}
function activityTake(event) {
	if (loading) { if (pending.length < 5000) pending.push(event); return; }
	if (event.id <= activityMax) return;
	activityMax = event.id;
	if (!current || !matches(event, current)) return;
	// Scrolled up to read something, or paused: the new lines wait, so nothing moves under the reader.
	if (paused || (view === 'activity' && !follow)) {
		if (held.length >= 2000) heldOverflow = true;
		else held.push(event);
		updateCounts();
		return;
	}
	appendRow(event);
	if (event.meta && event.meta.guild && !guildNames().includes(String(event.meta.guild))) refreshGuildFilter();
	updateCounts();
	scrollToEnd();
}
function flushHeld() {
	if (heldOverflow) { reset(); return; }
	const waiting = held;
	held = [];
	for (const event of waiting) appendRow(event);
	updateCounts();
	scrollToEnd();
}
window.addEventListener('scroll', () => {
	if (view !== 'activity') return;
	const bottom = atBottom();
	if (bottom === follow) return;
	follow = bottom;
	if (follow && !paused) flushHeld();
	updateCounts();
}, { passive: true });
$('pause').addEventListener('click', (event) => {
	paused = !paused;
	event.currentTarget.setAttribute('aria-pressed', paused ? 'true' : 'false');
	event.currentTarget.textContent = paused ? L.resume : L.pause;
	if (!paused) { follow = true; flushHeld(); }
	updateCounts();
});
$('jump').addEventListener('click', () => {
	if (paused) $('pause').click();
	else { follow = true; flushHeld(); }
	$('list').focus({ preventScroll: true });
});
$('clear').addEventListener('click', () => { list.replaceChildren(); shown.length = 0; held = []; heldOverflow = false; updateCounts(); });
let searchTimer = null;
$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(reset, 250); });
for (const id of ['kind', 'guildFilter', 'from', 'to']) $(id).addEventListener('change', () => reset());
$('exportView').addEventListener('click', () => {
	// Exactly what is on the screen, filters and all, as one JSON object per line.
	const lines = shown.map((event) => JSON.stringify({ id: event.id, at: event.at, kind: event.kind, direction: event.direction, who: event.who, whoName: event.whoName, text: event.text, meta: event.meta })).join('\n');
	const url = URL.createObjectURL(new Blob([lines], { type: 'application/x-ndjson' }));
	const link = h('a', { href: url, download: 'activity-view-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.jsonl' });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------------------------------------------------------------- gate audit
let gateRows = [];
let gateMax = 0;
let gateTimer = null;
const GATE_FILTERS = [['gGuild', 'guild'], ['gTool', 'tool'], ['gDecision', 'decision'], ['gCode', 'code']];
function decisionLabel(value) { return (L.decisions && L.decisions[value]) || value || ''; }
function codeLabel(value) { return (L.gate_codes && L.gate_codes[value]) || value || ''; }
function gateTake(entry) {
	if (!entry || entry.id <= gateMax) return;
	gateMax = entry.id;
	gateRows.push(entry);
	if (gateRows.length > 2000) gateRows.shift();
	clearTimeout(gateTimer);
	gateTimer = setTimeout(() => { gateFacets(); if (view === 'gate') renderGate(); }, 200);
}
async function loadGate() {
	try {
		const data = await getJson('/api/gate?limit=2000');
		gateRows = data.rows || [];
		gateMax = gateRows.reduce((max, entry) => Math.max(max, entry.id), 0);
	} catch (err) {
		/* the stream still brings new decisions */
	}
	gateFacets();
	renderGate();
}
function gateFacets() {
	const seen = { guild: new Set(), tool: new Set(), decision: new Set(), code: new Set() };
	for (const entry of gateRows) for (const key of Object.keys(seen)) if (entry[key]) seen[key].add(String(entry[key]));
	const label = { guild: (v) => v, tool: (v) => v, decision: decisionLabel, code: codeLabel };
	for (const [id, key] of GATE_FILTERS) {
		fillSelect($(id), [['', L.any]].concat([...seen[key]].sort().map((value) => [value, label[key](value)])));
	}
}
function renderGate() {
	const want = {};
	for (const [id, key] of GATE_FILTERS) want[key] = $(id).value;
	const q = $('gq').value.trim().toLowerCase();
	const matching = gateRows.filter((entry) => {
		for (const key of Object.keys(want)) if (want[key] && String(entry[key] || '') !== want[key]) return false;
		if (!q) return true;
		return [entry.tool, entry.asker, entry.reason, entry.guild, codeLabel(entry.code), decisionLabel(entry.decision)].join(' ').toLowerCase().includes(q);
	});
	const rows = matching.slice(-500).reverse().map((entry) => {
		const reason = entry.reason || codeLabel(entry.code);
		const detail = entry.reason && entry.code && codeLabel(entry.code) !== entry.reason ? codeLabel(entry.code) : null;
		return h('tr', null,
			h('td', { className: 'num', 'data-label': L.col_time }, h('time', { datetime: entry.at, title: new Date(entry.at).toLocaleString(L.time_locale), text: clock(entry.at) })),
			h('td', { 'data-label': L.col_server, text: entry.guild || '\u2014' }),
			h('td', { 'data-label': L.col_tool, text: entry.tool || '\u2014' }),
			h('td', { 'data-label': L.col_asker, text: entry.asker || '\u2014' }),
			h('td', { 'data-label': L.col_decision }, h('span', { className: 'decision ' + safeId(entry.decision), text: decisionLabel(entry.decision) })),
			h('td', { 'data-label': L.col_reason }, h('div', null, reason || '\u2014', detail ? h('span', { className: 'muted', text: detail }) : null)));
	});
	$('gateRows').replaceChildren(...rows);
	$('gateEmpty').hidden = rows.length > 0;
	$('gateCount').textContent = fmt(L.gate_count, { shown: rows.length, total: gateRows.length });
}
for (const [id] of GATE_FILTERS) $(id).addEventListener('change', renderGate);
let gateSearchTimer = null;
$('gq').addEventListener('input', () => { clearTimeout(gateSearchTimer); gateSearchTimer = setTimeout(renderGate, 150); });

// ---------------------------------------------------------------- keys
async function loadKeys() {
	try {
		const data = await getJson('/api/keys');
		$('kOpenAI').placeholder = data.openai ? L.key_set + ' ' + data.openai : L.key_openai;
		$('kDeepSeek').placeholder = data.deepseek ? L.key_set + ' ' + data.deepseek : L.key_deepseek;
	} catch (err) { /* the rest of the panel works without the key status */ }
}
$('keysForm').addEventListener('submit', async (event) => {
	event.preventDefault();
	const status = $('keyStatus');
	status.textContent = L.key_saving;
	const body = JSON.stringify({ openai: $('kOpenAI').value.trim(), deepseek: $('kDeepSeek').value.trim() });
	try {
		const response = await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		const data = await response.json();
		status.textContent = data.ok ? data.message : data.error;
		if (data.ok) { $('kOpenAI').value = ''; $('kDeepSeek').value = ''; loadKeys(); }
	} catch (err) {
		status.textContent = L.key_failed;
	}
});

// ---------------------------------------------------------------- start
(async () => {
	showView((window.location.hash || '').slice(1) || 'dashboard', false);
	drawCharts();
	await loadDashboard();
	await Promise.all([reset(), loadGate(), loadKeys()]);
	loadHistory(false);
	connect();
})();
`;

/** The strings the client reads, in the active language. */
function clientStrings() {
	return {
		...tRaw('panel.ui'),
		kinds: tRaw('panel.kinds'),
		time_locale: t('panel.time_locale'),
		pause: t('panel.pause'),
		resume: t('panel.resume'),
		key_openai: t('panel.key_openai'),
		key_deepseek: t('panel.key_deepseek'),
		key_set: t('panel.key_set'),
		key_saving: t('panel.key_saving'),
		key_failed: t('panel.key_failed'),
	};
}

function build() {
	const script = `const L = ${scriptJson(clientStrings())};\nconst KINDS = ${scriptJson(ACTIVITY_KINDS)};\n${CLIENT}`;
	const ui = (key) => esc(t(`panel.ui.${key}`));
	const html = `<!doctype html>
<html lang="${esc(t('panel.html_lang'))}">
<head>
<meta charset="utf-8" />
<title>${esc(t('panel.page_title'))}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">${ui('skip')}</a>
<header class="top">
	<div class="titlebar">
		<h1 id="title">${esc(t('panel.heading'))}</h1>
		<span class="conn" id="conn" role="status" aria-live="polite"></span>
	</div>
	<p class="status" id="status"></p>
	<div class="views" id="tabs" role="tablist" aria-label="${ui('views_label')}">
		<button type="button" role="tab" id="tab-dashboard" aria-controls="view-dashboard" aria-selected="true">${ui('view_dashboard')}</button>
		<button type="button" role="tab" id="tab-activity" aria-controls="view-activity" aria-selected="false" tabindex="-1">${ui('view_activity')}</button>
		<button type="button" role="tab" id="tab-gate" aria-controls="view-gate" aria-selected="false" tabindex="-1">${ui('view_gate')}</button>
	</div>
</header>
<main id="main" tabindex="-1">
<section id="view-dashboard" role="tabpanel" aria-labelledby="tab-dashboard">
	<div class="tiles" id="tiles"></div>
	<div class="music" id="music"></div>
	<h2>${ui('servers')}</h2>
	<div class="cards" id="cards"></div>
	<div class="charthead">
		<h2>${ui('last_hour')}</h2>
		<label class="hint">${ui('server')} <select id="guildSel"></select></label>
	</div>
	<p class="hint" id="charts-help">${ui('charts_help')}</p>
	<p class="hint" id="chartsEmpty">${ui('charts_empty')}</p>
	<div class="charts" id="charts"></div>
	<details id="tableView">
		<summary>${ui('data_table_summary')}</summary>
		<div class="tablewrap"><table id="histTable"></table></div>
	</details>
	<details class="keys">
		<summary>${ui('keys_title')}</summary>
		<form id="keysForm">
			<input type="password" id="kOpenAI" aria-label="${esc(t('panel.key_openai'))}" placeholder="${esc(t('panel.key_openai'))}" autocomplete="off" />
			<input type="password" id="kDeepSeek" aria-label="${esc(t('panel.key_deepseek'))}" placeholder="${esc(t('panel.key_deepseek'))}" autocomplete="off" />
			<button type="submit">${esc(t('panel.key_save'))}</button>
			<span id="keyStatus" role="status" title="${esc(t('panel.key_hint'))}"></span>
		</form>
		<p class="hint">${esc(t('panel.key_hint'))}</p>
	</details>
</section>
<section id="view-activity" role="tabpanel" aria-labelledby="tab-activity" hidden>
	<div class="toolbar">
		<label>${ui('kind')} <select id="kind"></select></label>
		<label id="guildFilterWrap">${ui('server')} <select id="guildFilter"></select></label>
		<label class="grow">${ui('search')} <input type="search" id="q" placeholder="${esc(t('panel.search_placeholder'))}" /></label>
		<label>${esc(t('panel.filter_from'))} <input type="datetime-local" id="from" /></label>
		<label>${esc(t('panel.filter_to'))} <input type="datetime-local" id="to" /></label>
		<button type="button" id="pause" aria-pressed="false">${esc(t('panel.pause'))}</button>
		<button type="button" id="clear">${esc(t('panel.clear'))}</button>
		<a class="btn" id="export" href="/api/export" download title="${ui('export_all_hint')}">${esc(t('panel.export'))}</a>
		<button type="button" id="exportView" title="${ui('export_view_hint')}">${ui('export_view')}</button>
	</div>
	<p class="hint" id="activityCount" aria-live="polite"></p>
	<ol class="log" id="list" tabindex="-1" aria-label="${ui('view_activity')}"></ol>
	<button type="button" class="jump" id="jump" hidden></button>
</section>
<section id="view-gate" role="tabpanel" aria-labelledby="tab-gate" hidden>
	<div class="toolbar">
		<label>${ui('server')} <select id="gGuild"></select></label>
		<label>${ui('col_tool')} <select id="gTool"></select></label>
		<label>${ui('col_decision')} <select id="gDecision"></select></label>
		<label>${ui('col_reason')} <select id="gCode"></select></label>
		<label class="grow">${ui('search')} <input type="search" id="gq" /></label>
	</div>
	<p class="hint" id="gateCount" aria-live="polite"></p>
	<p class="hint" id="gateEmpty">${ui('gate_empty')}</p>
	<div class="tablewrap">
		<table class="audit">
			<caption class="sr">${ui('gate_caption')}</caption>
			<thead><tr>
				<th scope="col">${ui('col_time')}</th><th scope="col">${ui('col_server')}</th><th scope="col">${ui('col_tool')}</th>
				<th scope="col">${ui('col_asker')}</th><th scope="col">${ui('col_decision')}</th><th scope="col">${ui('col_reason')}</th>
			</tr></thead>
			<tbody id="gateRows"></tbody>
		</table>
	</div>
</section>
</main>
<script>${script}</script>
</body>
</html>`;
	// Only this page's own script and style may run; nothing may be loaded from anywhere but the panel,
	// and no other site may frame it.
	const csp = [
		"default-src 'none'",
		`script-src ${sha256(script)}`,
		`style-src ${sha256(STYLE)}`,
		"connect-src 'self'",
		"img-src 'self'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join('; ');
	return { html, csp, script };
}

// Built once per language: the page is the same for every request, and so is its hash.
const built = new Map();

/** The page in the active language: { html, csp, script }. */
export function panelPage() {
	const code = locale();
	if (!built.has(code)) built.set(code, build());
	return built.get(code);
}
