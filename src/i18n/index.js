// Localisation: every string the user can see (console logs, spoken replies, panel UI, slash
// command descriptions, model instructions) is looked up here. Model-facing schema text (tool
// names, parameter descriptions) stays in English and is NOT localised.
//
// Locale bundles live in src/locales/<code>/ and are plain objects, so a missing key is a
// programming error that shows up as the key itself rather than as silence.

import en from '../locales/en/index.js';
import tr from '../locales/tr/index.js';

// The one list of bundled languages. Everything else asks this module: src/config.js checks
// BOT_LANGUAGE against it, and scripts/check-locales.mjs fails when a directory under src/locales is
// not registered here (or a registered language has no directory).
const BUNDLES = { en, tr };
const FALLBACK = 'en';

export const SUPPORTED_LOCALES = Object.freeze(Object.keys(BUNDLES));
export const FALLBACK_LOCALE = FALLBACK;

let currentCode = FALLBACK;
let currentBundle = BUNDLES[FALLBACK];

// Picked up at import time so module-level constants are built in the right language even before
// the configuration is parsed; setLocale() can still override it afterwards. An unknown value falls
// back quietly here, because nothing can be printed in a language that is not chosen yet; src/config.js
// resolves the same value the same way and reports it once the bot starts.
initFromEnv();

function initFromEnv() {
	const fromEnv = String(process.env.BOT_LANGUAGE ?? '').trim().toLowerCase();
	if (fromEnv) setLocale(fromEnv);
}

/**
 * Which bundle a language code stands for, without selecting it. The language is the first run of
 * letters, so "tr", "tr-TR", "tr_TR.UTF-8" and a quoted "tr" all name Turkish. `known` is false when
 * nothing bundled matched and the fallback was taken instead.
 * @returns {{ code: string, known: boolean }}
 */
export function resolveLocale(code) {
	const raw = String(code ?? '').trim().toLowerCase();
	if (BUNDLES[raw]) return { code: raw, known: true };
	const language = raw.match(/[a-z]+/u)?.[0] ?? '';
	if (BUNDLES[language]) return { code: language, known: true };
	return { code: FALLBACK, known: false };
}

/**
 * Selects the active locale. Accepts "en", "tr", "tr-TR"; unknown codes fall back to English.
 * @returns {string} the code that ended up active
 */
export function setLocale(code) {
	const picked = resolveLocale(code).code;
	currentCode = picked;
	currentBundle = BUNDLES[picked];
	return picked;
}

/** Currently active locale code. */
export function locale() {
	return currentCode;
}

/** Is this locale bundled? */
export function hasLocale(code) {
	return resolveLocale(code).known;
}

function lookup(bundle, key) {
	let node = bundle;
	for (const part of String(key).split('.')) {
		if (node === null || node === undefined || typeof node !== 'object') return undefined;
		node = node[part];
	}
	return node;
}

/** Replaces {name} placeholders; an unknown placeholder is left untouched so it is visible. */
function fill(text, params) {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

function resolve(key) {
	const value = lookup(currentBundle, key);
	return value === undefined ? lookup(BUNDLES[FALLBACK], key) : value;
}

/**
 * Translated string. Arrays are joined with newlines (multi-line notes), functions are called with
 * the parameters (plurals, conditional wording). A missing key returns the key itself.
 */
export function t(key, params = null) {
	const value = resolve(key);
	if (typeof value === 'function') return String(value(params ?? {}));
	if (Array.isArray(value)) return value.map((line) => fill(String(line), params)).join('\n');
	if (typeof value === 'string') return fill(value, params);
	return String(key);
}

/**
 * Translated list (keyword tables, note lines, help entries). Always a fresh array.
 * `code` reads a specific locale instead of the active one -- used where a value may arrive in English
 * because the model-facing schema is English, whatever language the conversation is in.
 */
export function tList(key, params = null, code = null) {
	const value = code ? (lookup(BUNDLES[code] ?? {}, key) ?? lookup(BUNDLES[FALLBACK], key)) : resolve(key);
	if (typeof value === 'function') {
		const produced = value(params ?? {});
		return Array.isArray(produced) ? [...produced] : [];
	}
	if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? fill(item, params) : item));
	return [];
}

/** Raw locale value (objects: alias tables, grammars). Falls back to English, then null. */
export function tRaw(key) {
	const value = resolve(key);
	return value === undefined ? null : value;
}
