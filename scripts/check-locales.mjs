// Locale integrity check.
//
// Walks the source tree, collects every key passed to t() / tList() / tRaw(), and verifies that each one
// resolves in every bundled locale. A key is found when it is written as a literal (t('a.b')), as a
// branch of a ternary (t(cond ? 'a.b' : 'a.c')), as a template (t(`a.${x}.b`): a pattern that stands for
// every key it can match, at least one of which has to exist), or in a variable or table defined in the
// same file (t(rule.label), t(hintKey)). A key the scan cannot follow is listed, never guessed.
//
// Across locales it compares the key sets, the {placeholders} of every entry (including the parameters
// a function entry reads) and the shape of the vocabulary and grammar tables: the words differ per
// language, but a table one locale has, every other locale needs too.
//
// Keys that exist in a bundle but are never referenced are listed for information only: a key can be
// reached in ways a text scan does not see, so an unused key does not fail the check.
//
// Run with: npm run check:locales

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from '../src/i18n/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const localesDir = path.join(srcDir, 'locales');
const i18nDir = path.join(srcDir, 'i18n');

// A call of one of the lookup functions; not a method of something else (".t(", though a spread
// "...tList(" is a call) and not a definition.
const KEY_CALL = /(?<![\w$])(?<![^.]\.)(?<!function\s+)(t|tList|tRaw)\(/g;
const PLACEHOLDER = /\{(\w+)\}/g;
// A string that has the form of a locale key: dotted identifiers.
const KEY_SHAPE = /^[a-z_][\w-]*(?:\.[\w-]+)+$/i;

async function walk(dir) {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walk(full)));
		else if (entry.name.endsWith('.js')) found.push(full);
	}
	return found;
}

/** Plain objects with keys are walked; everything else (strings, arrays, functions, null) is a leaf. */
function flatten(node, prefix = '', out = new Map(), stop = () => false) {
	for (const [key, value] of Object.entries(node ?? {})) {
		const full = prefix ? `${prefix}.${key}` : key;
		const nested = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp) && Object.keys(value).length > 0;
		if (nested && !stop(full, value)) flatten(value, full, out, stop);
		else out.set(full, value);
	}
	return out;
}

/**
 * The {placeholders} of an entry. Strings are read directly, lists and objects through every string they
 * hold, and a function entry (plural or conditional wording) is called once with a parameter object
 * that notes which names it reads: those are its placeholders.
 */
function placeholdersOf(value, names = new Set()) {
	if (typeof value === 'string') {
		for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1]);
	} else if (typeof value === 'function') {
		const params = new Proxy(
			{},
			{
				get(_target, name) {
					if (typeof name === 'string') names.add(name);
					return '';
				},
			},
		);
		try {
			value(params);
		} catch {
			/* the names read before it gave up are still the ones it uses */
		}
	} else if (Array.isArray(value)) {
		for (const item of value) placeholdersOf(item, names);
	} else if (value && typeof value === 'object' && !(value instanceof RegExp)) {
		for (const item of Object.values(value)) placeholdersOf(item, names);
	}
	return names;
}

// ---------------------------------------------------------------- reading JavaScript

// Just enough of a JavaScript reader to take one expression apart: it steps over strings, templates,
// regular expressions and comments, and keeps count of brackets. An expression is read from inside its
// call or right after its definition, so an unusual construct elsewhere in a file cannot throw it off;
// the one whole-file pass (the { } blocks, for scoping) is dropped when its braces do not balance.

const BEFORE_REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'throw', 'yield', 'await', 'delete', 'new', 'else', 'do']);

/** Whether a "/" at `index` starts a regular expression rather than dividing: decided by what precedes it. */
function regexCanStart(text, index) {
	let i = index - 1;
	while (i >= 0 && /\s/.test(text[i])) i--;
	if (i < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(text[i])) return true;
	const word = /[\w$]+$/.exec(text.slice(Math.max(0, i - 11), i + 1))?.[0];
	return BEFORE_REGEX_WORDS.has(word);
}

/** Index of the last character of the literal or comment starting at `i`, or `i` itself if none does. */
function skipLiteral(text, i) {
	const ch = text[i];
	if (ch === "'" || ch === '"') {
		for (let j = i + 1; j < text.length; j++) {
			if (text[j] === '\\') j++;
			else if (text[j] === ch || text[j] === '\n') return j;
		}
		return text.length - 1;
	}
	if (ch === '`') {
		for (let j = i + 1; j < text.length; j++) {
			if (text[j] === '\\') j++;
			else if (text[j] === '`') return j;
			else if (text[j] === '$' && text[j + 1] === '{') j = walkCode(text, j + 2, () => false);
		}
		return text.length - 1;
	}
	if (ch === '/' && text[i + 1] === '/') {
		const end = text.indexOf('\n', i);
		return end === -1 ? text.length - 1 : end;
	}
	if (ch === '/' && text[i + 1] === '*') {
		const end = text.indexOf('*/', i + 2);
		return end === -1 ? text.length - 1 : end + 1;
	}
	if (ch === '/' && regexCanStart(text, i)) {
		let inClass = false;
		for (let j = i + 1; j < text.length; j++) {
			const c = text[j];
			if (c === '\\') j++;
			else if (c === '\n') return i;
			else if (inClass) inClass = c !== ']';
			else if (c === '[') inClass = true;
			else if (c === '/') return j;
		}
	}
	return i;
}

/**
 * Walks code from `start`, calling visit(index, depth) for every character outside literals. Stops and
 * returns the index where visit returned true, or where a bracket closed that was opened before `start`.
 */
function walkCode(text, start, visit) {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const skipped = skipLiteral(text, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const ch = text[i];
		if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch) && --depth < 0) return i;
		if (visit(i, depth)) return i;
	}
	return text.length;
}

/** The expression that starts at `start` and runs to the first `,` or `;` outside brackets. */
function expressionAt(text, start) {
	const end = walkCode(text, start, (i, depth) => depth === 0 && (text[i] === ',' || text[i] === ';'));
	return text.slice(start, end).trim();
}

/** Positions of the operators that sit at depth 0 of `expr`, outside every literal. */
function topLevel(expr, test) {
	const found = [];
	walkCode(expr, 0, (i, depth) => {
		if (depth === 0 && test(i)) found.push(i);
		return false;
	});
	return found;
}

function unwrap(expr) {
	let text = expr.trim();
	while (text.startsWith('(') && walkCode(text, 1, () => false) === text.length - 1) text = text.slice(1, -1).trim();
	return text;
}

const isTernaryMark = (expr, i) => expr[i] === '?' && expr[i + 1] !== '?' && expr[i + 1] !== '.' && expr[i - 1] !== '?';

/** `cond ? a : b` at the top level of `expr` -> [a, b], or null. */
function ternary(expr) {
	const [mark] = topLevel(expr, (i) => isTernaryMark(expr, i));
	if (mark === undefined) return null;
	let open = 0;
	const [colon] = topLevel(expr, (i) => {
		if (i <= mark) return false;
		if (isTernaryMark(expr, i)) open++;
		else if (expr[i] === ':') {
			if (open === 0) return true;
			open--;
		}
		return false;
	});
	if (colon === undefined) return null;
	return [expr.slice(mark + 1, colon), expr.slice(colon + 1)];
}

/** Splits `expr` at a top-level binary operator (`??`, `||`, `&&`); a single part when there is none. */
function splitOn(expr, operator) {
	const marks = topLevel(expr, (i) => expr.startsWith(operator, i) && !(operator === '??' && expr[i + 2] === '='));
	const parts = [];
	let from = 0;
	for (const mark of marks) {
		if (mark < from) continue;
		parts.push(expr.slice(from, mark));
		from = mark + operator.length;
	}
	parts.push(expr.slice(from));
	return parts;
}

/** The comma-separated parts of a list: an object or array body, a parameter list, call arguments. */
function entries(body) {
	return splitOn(body, ',').map((part) => part.trim()).filter(Boolean);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What an expression can produce, as far as a reader of this one file can tell:
 *   strings  - exact values, each with the index where it was written when that is not the call itself
 *   patterns - templates with a part that could not be followed: { source, label, at }
 *   dynamic  - true when some part could not be followed at all
 */
function noValues() {
	return { strings: new Map(), patterns: [], dynamic: false };
}

function mergeValues(target, other, at) {
	for (const [value, origin] of other.strings) if (!target.strings.has(value)) target.strings.set(value, origin ?? at);
	for (const pattern of other.patterns) {
		if (!target.patterns.some((known) => known.label === pattern.label)) target.patterns.push({ ...pattern, at: pattern.at ?? at });
	}
	target.dynamic ||= other.dynamic;
	return target;
}

/**
 * The values of `expr`. `scope` is the file text and the index of the call being read, so that a name
 * resolves to the definition in scope there.
 */
function valuesOf(expr, scope, seen = new Set()) {
	const result = noValues();
	const text = unwrap(expr);
	if (!text || /^(?:null|undefined|false|true|''|""|``)$/.test(text) || /^[\d.]+$/.test(text)) return result;

	const branches = ternary(text);
	if (branches) {
		for (const branch of branches) mergeValues(result, valuesOf(branch, scope, seen));
		return result;
	}
	for (const operator of ['??', '||']) {
		const parts = splitOn(text, operator);
		if (parts.length > 1) {
			for (const part of parts) mergeValues(result, valuesOf(part, scope, seen));
			return result;
		}
	}
	const conjunction = splitOn(text, '&&');
	if (conjunction.length > 1) return valuesOf(conjunction.at(-1), scope, seen);

	const quoted = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1$/.exec(text);
	if (quoted) {
		result.strings.set(quoted[2], undefined);
		return result;
	}
	if (text.startsWith('`') && skipLiteral(text, 0) === text.length - 1) return templateValues(text, scope, seen);
	if (text.startsWith('{') && walkCode(text, 1, () => false) === text.length - 1) {
		for (const entry of entries(text.slice(1, -1))) {
			const colon = topLevel(entry, (i) => entry[i] === ':')[0];
			if (colon !== undefined) mergeValues(result, valuesOf(entry.slice(colon + 1), scope, seen));
		}
		return result;
	}
	if (text.startsWith('[') && walkCode(text, 1, () => false) === text.length - 1) {
		for (const entry of entries(text.slice(1, -1))) mergeValues(result, valuesOf(entry, scope, seen));
		return result;
	}

	// TABLE[x]: whatever the table holds.
	const lookup = /^([A-Za-z_$][\w$]*)\s*\[[^\]]*\]$/.exec(text);
	if (lookup) return definitionValues(lookup[1], 'variable', scope, seen);
	// something.label: the values written for that property in this file.
	const member = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.([A-Za-z_$][\w$]*)$/.exec(text);
	if (member) return definitionValues(member[1], 'property', scope, seen);
	const name = /^[A-Za-z_$][\w$]*$/.exec(text);
	if (name) return definitionValues(name[0], 'variable', scope, seen);

	result.dynamic = true;
	return result;
}

const WILDCARD = Symbol('wildcard');
const MAX_EXPANSION = 64;

function templateValues(text, scope, seen) {
	// Split into static text and ${...} parts. A part becomes the strings it can be, plus a wildcard when
	// it can also be something the scan could not follow; every combination without a wildcard is an
	// exact key, every combination with one a pattern. Options are [text, origin] pairs.
	const pieces = [];
	let from = 1;
	for (let i = 1; i < text.length - 1; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === '$' && text[i + 1] === '{') {
			pieces.push([[text.slice(from, i)]]);
			const end = walkCode(text, i + 2, () => false);
			const inner = valuesOf(text.slice(i + 2, end), scope, seen);
			const open = inner.dynamic || inner.patterns.length > 0 || inner.strings.size === 0;
			pieces.push([...inner.strings, ...(open ? [[WILDCARD]] : [])]);
			i = end;
			from = end + 1;
		}
	}
	pieces.push([[text.slice(from, text.length - 1)]]);

	const result = noValues();
	let combos = [[]];
	for (const options of pieces) combos = combos.flatMap((head) => options.map((option) => [...head, option]));
	if (combos.length > MAX_EXPANSION) combos = [pieces.map((options) => (options.length > 1 ? [WILDCARD] : options[0]))];
	for (const combo of combos) {
		const parts = combo.map(([part]) => part);
		const at = combo.find(([, origin]) => origin !== undefined)?.[1];
		if (!parts.includes(WILDCARD)) {
			if (!result.strings.has(parts.join(''))) result.strings.set(parts.join(''), at);
			continue;
		}
		const source = parts.map((part) => (part === WILDCARD ? '.+' : escapeRegExp(part))).join('');
		const label = parts.map((part) => (part === WILDCARD ? '*' : part)).join('');
		mergeValues(result, { strings: new Map(), patterns: [{ source, label, at }], dynamic: false });
	}
	return result;
}

/**
 * The { ... } blocks of a file as [open, close] pairs, or null when the braces do not balance (the
 * reader lost its place somewhere, and block scoping is then not attempted).
 */
const blockCache = new Map();
function blocksOf(text) {
	if (!blockCache.has(text)) blockCache.set(text, readBlocks(text));
	return blockCache.get(text);
}

function readBlocks(text) {
	const open = [];
	const blocks = [];
	const end = walkCode(text, 0, (i) => {
		if (text[i] === '{') open.push(i);
		else if (text[i] === '}') blocks.push([open.pop(), i]);
		return false;
	});
	return end === text.length && open.length === 0 ? blocks : null;
}

/** A definition at `index` is visible from `at` when the innermost block around it also holds `at`. */
function visible(blocks, index, at) {
	if (!blocks) return true;
	let inner = null;
	for (const [open, close] of blocks) {
		if (open < index && index < close && (!inner || open > inner[0])) inner = [open, close];
	}
	return !inner || (inner[0] < at && at < inner[1]);
}

/**
 * The values a name can hold in this file. A variable resolves to its nearest definition before the
 * call that is in scope there (`const key = ...`, `key = ...`), or, when it is a parameter of the
 * function around the call, to what this file's calls of that function pass for it. A property resolves
 * to every place the file writes it (`label: ...`); it counts as followed once any of those is a string.
 */
function definitionValues(name, kind, scope, seen) {
	const result = noValues();
	// The same name at another call is another variable; a property is one set for the whole file.
	const tag = kind === 'property' ? `property:${name}` : `variable:${name}@${scope.at}`;
	if (seen.has(tag)) return result;
	const inner = new Set(seen).add(tag);
	const escaped = escapeRegExp(name);
	const pattern =
		kind === 'property'
			? new RegExp(String.raw`(?:^|[{,])\s*${escaped}\s*:(?!:)`, 'gm')
			: new RegExp(String.raw`(?<![\w$.])(?:(?:const|let|var)\s+)?${escaped}\s*=(?![=>])`, 'g');
	let found = [...scope.text.matchAll(pattern)].map((match) => match.index + match[0].length);
	if (kind === 'variable') {
		const blocks = blocksOf(scope.text);
		const before = found.filter((index) => index < scope.at && visible(blocks, index, scope.at));
		found = before.length ? [before.at(-1)] : [];
		if (!found.length) return parameterValues(name, scope, inner) ?? { ...result, dynamic: true };
	}
	if (!found.length) return { ...result, dynamic: true };
	// The values carry where they were written, which is where a typo in one of them has to be fixed.
	for (const index of found) mergeValues(result, valuesOf(expressionAt(scope.text, index), scope, inner), index);
	if (kind === 'property' && (result.strings.size || result.patterns.length)) result.dynamic = false;
	return result;
}

const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof']);
const FUNCTION_HEAD =
	/(?:(?:function\s*\*?\s*|(?<![\w$.]))([A-Za-z_$][\w$]*)\s*|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?)\(([^()]*)\)\s*(?:=>\s*)?$/;

/**
 * `name` as a parameter of a function around the call (`function words(key)`, a method, or
 * `const f = (key) => {`): the values the calls of that function in this file pass in its place, each
 * carrying the call it came from. null when the name is not such a parameter, or nothing here calls it.
 */
function parameterValues(name, scope, seen) {
	const blocks = blocksOf(scope.text);
	if (!blocks) return null;
	const around = blocks.filter(([open, close]) => open < scope.at && scope.at < close).sort((a, b) => b[0] - a[0]);
	for (const [open] of around) {
		const head = FUNCTION_HEAD.exec(scope.text.slice(Math.max(0, open - 400), open));
		const fn = head && (head[1] ?? head[2]);
		if (!fn || NOT_FUNCTIONS.has(fn)) continue;
		const position = entries(head[3]).map((param) => param.replace(/\s*=[\s\S]*$/, '')).indexOf(name);
		if (position === -1) continue; // a closure over something further out
		const tag = `param:${fn}:${position}`;
		if (seen.has(tag)) return noValues();
		const inner = new Set(seen).add(tag);
		const result = noValues();
		let calls = 0;
		for (const call of scope.text.matchAll(new RegExp(String.raw`(?<![\w$])(?<!function\s*\*?\s*)${escapeRegExp(fn)}\s*\(`, 'g'))) {
			const start = call.index + call[0].length;
			const close = walkCode(scope.text, start, () => false);
			if (/^\s*(?:\{|=>)/.test(scope.text.slice(close + 1, close + 8))) continue; // the definition itself
			calls++;
			const argument = entries(scope.text.slice(start, close))[position];
			if (argument !== undefined) mergeValues(result, valuesOf(argument, { text: scope.text, at: call.index }, inner), call.index);
		}
		return calls ? result : null;
	}
	return null;
}

// ---------------------------------------------------------------- bundles

const problems = [];

// The languages are registered in src/i18n; a directory it does not know is a bundle nobody can select,
// and a registered language without a directory cannot load.
const directories = (await readdir(localesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
for (const code of directories) {
	if (!SUPPORTED_LOCALES.includes(code)) problems.push(`unregistered [${code}] src/locales/${code} is not in BUNDLES (src/i18n/index.js)`);
}
for (const code of SUPPORTED_LOCALES) {
	if (!directories.includes(code)) problems.push(`missing  [${code}] registered in src/i18n/index.js but src/locales/${code} does not exist`);
}

// The registered languages are compared, the fallback first: it is the reference the others must match.
const localeCodes = [FALLBACK_LOCALE, ...SUPPORTED_LOCALES.filter((code) => code !== FALLBACK_LOCALE)].filter((code) => directories.includes(code));
const raw = new Map();
const bundles = new Map();
for (const code of localeCodes) {
	const imported = (await import(`../src/locales/${code}/index.js`)).default;
	raw.set(code, imported);
	bundles.set(code, flatten(imported));
}
const [reference, ...others] = localeCodes;
const namespaces = new Set(Object.keys(raw.get(reference) ?? {}));

// ---------------------------------------------------------------- references in source

const files = (await walk(srcDir)).filter((file) => !file.startsWith(localesDir) && !file.startsWith(i18nDir));
const exact = new Map(); // key -> where it was first used
const patterns = new Map(); // label -> { regex, where }
const unfollowed = [];
const mentioned = new Set(); // key-shaped strings anywhere in source, for the unused-key listing
const subtrees = new Set(); // bundle parts read directly (import en from '.../locales/en/x.js')

for (const file of files) {
	const text = await readFile(file, 'utf8');
	const relative = path.relative(root, file);
	const where = (index) => `${relative}:${text.slice(0, index).split('\n').length}`;
	for (const match of text.matchAll(KEY_CALL)) {
		const lineStart = text.lastIndexOf('\n', match.index) + 1;
		if (/^\s*(?:\/\/|\/?\*)/.test(text.slice(lineStart, match.index))) continue;
		const argument = expressionAt(text, match.index + match[0].length);
		const direct = /^(['"])[^'"\n]*\1$/.test(argument);
		const values = valuesOf(argument, { text, at: match.index });
		for (const [value, origin] of values.strings) {
			// A literal handed to t() is a key whatever it looks like; one found further away has to look like one.
			if (!direct && !KEY_SHAPE.test(value)) continue;
			if (!exact.has(value)) exact.set(value, where(origin ?? match.index));
		}
		for (const { source, label, at } of values.patterns) {
			if (!patterns.has(label)) patterns.set(label, { regex: new RegExp(`^${source}(?:\\..+)?$`), where: where(at ?? match.index) });
		}
		if (values.dynamic || (!values.strings.size && !values.patterns.length)) {
			unfollowed.push(`${where(match.index)}  ${match[1]}(${argument.replace(/\s+/g, ' ').slice(0, 60)})`);
		}
	}
	for (const match of text.matchAll(/(['"`])([a-z_][\w-]*(?:\.[\w-]+)+)\1/gi)) {
		if (namespaces.has(match[2].split('.')[0])) mentioned.add(match[2]);
	}
	for (const match of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+'[./]*locales\/[\w-]+\/([\w-]+)\.js'/g)) {
		const namespace = match[2].replaceAll('-', '.');
		for (const access of text.matchAll(new RegExp(String.raw`\b${escapeRegExp(match[1])}\.([A-Za-z_$][\w$]*)`, 'g'))) {
			subtrees.add(`${namespace}.${access[1]}`);
		}
	}
}

const resolves = (table, key) => table.has(key) || [...table.keys()].some((candidate) => candidate.startsWith(`${key}.`));

for (const [key, where] of exact) {
	for (const [code, table] of bundles) {
		// A key may address a whole sub-tree (tRaw); accept it when something lives under that prefix.
		if (!resolves(table, key)) problems.push(`missing  [${code}] ${key}  (used in ${where})`);
	}
}
for (const [label, { regex, where }] of patterns) {
	for (const [code, table] of bundles) {
		if (![...table.keys()].some((key) => regex.test(key))) problems.push(`missing  [${code}] ${label}  (no key matches; used in ${where})`);
	}
}

// ---------------------------------------------------------------- locales against each other

// Vocabulary and grammar tables are genuinely different per language: English has "red", Turkish has
// "kirmizi", and each locale needs its own regular expressions, so their words and patterns are not
// compared. Their shape is: a keyword list, a grammar rule or a word table that one locale has and
// another lacks is a feature that silently stops working in that language.
const VOCABULARY = /^(?:keywords|grammar)\.|(?:_aliases|_words|_names|_variants)(?:\.|$)/;
const symmetric = (key) => !VOCABULARY.test(key);
// Tables whose KEYS are words or letters of the language (colour names, permission groups, spoken
// setting names, the letters that carry accents): only the table itself has to exist everywhere.
const WORD_KEYED = new Set(['keywords.color_names', 'keywords.permission_groups', 'grammar.letter_classes', 'runtime.setting_aliases']);
// A { pattern, flags } entry is one regular expression, and null says "this language has no such rule";
// both are a single entry of the table.
const tableLeaf = (key, value) => WORD_KEYED.has(key) || typeof value.pattern === 'string';
const shapes = new Map([...raw].map(([code, bundle]) => [code, new Set([...flatten(bundle, '', new Map(), tableLeaf).keys()].filter((key) => !symmetric(key)))]));

for (const code of others) {
	for (const key of shapes.get(reference)) {
		if (!shapes.get(code).has(key)) problems.push(`missing  [${code}] ${key}  (vocabulary table present in ${reference})`);
	}
	for (const key of shapes.get(code)) {
		if (!shapes.get(reference).has(key)) problems.push(`extra    [${code}] ${key}  (vocabulary table not in ${reference})`);
	}
}

for (const [key, value] of bundles.get(reference) ?? []) {
	if (!symmetric(key)) continue;
	const expected = placeholdersOf(value);
	for (const code of others) {
		const other = bundles.get(code);
		if (!other.has(key)) {
			problems.push(`missing  [${code}] ${key}  (present in ${reference})`);
			continue;
		}
		const actual = placeholdersOf(other.get(key));
		const lost = [...expected].filter((name) => !actual.has(name));
		const extra = [...actual].filter((name) => !expected.has(name));
		if (lost.length) problems.push(`placeholder [${code}] ${key}: missing {${lost.join('}, {')}}`);
		if (extra.length) problems.push(`placeholder [${code}] ${key}: unexpected {${extra.join('}, {')}}`);
	}
}
for (const code of others) {
	for (const key of bundles.get(code).keys()) {
		if (!symmetric(key)) continue;
		if (!bundles.get(reference).has(key)) problems.push(`extra    [${code}] ${key}  (not in ${reference})`);
	}
}

// ---------------------------------------------------------------- report

// Referenced: named exactly (or a sub-tree of it), matched by a template, read straight from a bundle
// module, or written as a string anywhere in the source (a key kept in a table and looked up later).
const named = [...exact.keys(), ...mentioned, ...subtrees];
const patternList = [...patterns.values()].map(({ regex }) => regex);
const referenced = (key) =>
	named.some((name) => key === name || key.startsWith(`${name}.`)) || patternList.some((regex) => regex.test(key));
// An empty namespace (a module with nothing to say yet) holds no text to forget about.
const empty = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
const unused = [...bundles.get(reference)].filter(([key, value]) => !empty(value) && !referenced(key)).map(([key]) => key);

const counts = [...bundles].map(([code, table]) => `${code}: ${table.size}`).join(', ');
console.log(`locales: ${counts} | keys referenced in source: ${exact.size} exact, ${patterns.size} patterns`);

if (unfollowed.length) {
	console.log(`\nnot followed (${unfollowed.length}, informational): the key could not be traced to a string, so it is not checked`);
	for (const line of unfollowed) console.log(`  ${line}`);
}
if (unused.length) {
	console.log(`\nunused (${unused.length}, informational): in ${reference} but not referenced in src/`);
	for (const key of unused) console.log(`  ${key}`);
}

if (problems.length) {
	console.error('');
	for (const line of problems.sort()) console.error(`  ${line}`);
	console.error(`\n${problems.length} locale problem(s).`);
	process.exit(1);
}
console.log('\nlocale bundles are consistent.');
