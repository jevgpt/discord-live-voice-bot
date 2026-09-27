// Written text -> the words a speech synthesiser should say.
//
// A reply from the text model is written for the eye: "%20", "14:45", "$3.99", "e.g.", "**bold**", a
// link, an emoji. The local voice is autoregressive: it predicts the next sound from the text it was
// given, and a string it has no spoken form for is where it improvises -- a digit read as some other
// number, a link spelled into a minute of noise, a sentence that does not end. The Turkish engine cuts a
// number left as digits off altogether. So what the voice is given is what should be SAID, and this
// module is the one place that decides it, one sentence at a time (src/localtts.js calls it).
//
// toSpeech(text, language) knows Turkish and English; their words live in src/locales/<code>/speech.js.
// Any other language gets only the cleanup that does not depend on the language (markup, emoji, control
// characters, links). It never throws, and it never hands back nothing for something that can be said:
// at worst a word is left as it was. Running it twice changes nothing, which the round-trip check in
// src/ttsguard.js relies on when it runs a transcript through it to compare with what was sent.
//
// The work is a fixed sequence of rewrites, each turning one kind of written thing into words. The
// order matters and is the main thing to keep in mind when adding one: the most specific shapes go
// first (a phone number, a date, an amount of money) because a later, general rule would read their
// digits as plain numbers.

import { FALLBACK_LOCALE, SUPPORTED_LOCALES, tRaw } from './i18n/index.js';

// Stands right after the words a number was turned into, until the ending written after the number
// ("3'te", "%20'si", "the 1990s") has been joined to them. A private-use character: the cleanup removes
// every one of them from the input first, so none can be smuggled in.
const MARK = '\uE000';
const MARKS = /\uE000/gu;

/** A table of the speech namespace, in the language `code` (not the bot's own language). */
function speechData(key, code) {
	return tRaw(`speech.${key}`, code);
}

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
/** Longest first, so "km/h" is tried before "km" and "km" before "m". */
const alternation = (list) => [...new Set(list)].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
const fill = (template, params) =>
	String(template ?? '')
		.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])))
		.replace(/\s+/gu, ' ')
		.trim();

/** "tr", "tr-TR", "TR" -> "tr"; null for a language without a speech table (only the cleanup applies). */
export function speechLanguage(language) {
	const code = String(language ?? '').toLowerCase().match(/^[a-z]+/u)?.[0] ?? '';
	return SUPPORTED_LOCALES.includes(code) ? code : null;
}

// ---------------------------------------------------------------- cleanup (every language)

// Soft hyphen, zero-width spaces and joiners, direction marks and their isolates, the invisible
// operators, the byte-order mark, variation selectors: nothing to say, and each one is a token the voice
// has to make something of.
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\u034f|\u17b4|\u17b5|\p{Variation_Selector}/gu;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const PRIVATE = /[\p{Co}\p{Cs}]/gu;
const SPACES = /[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;
const FULLWIDTH = /[\uff01-\uff5e]/gu;
// Emoji and pictographs, their skin tones, flags, tags and keycap marks, and every other symbol that is a
// picture rather than a word (a note, a star, the trade mark sign, box drawing) -- except the degree sign.
const PICTOGRAPHS = /(?:(?!°)[\p{Extended_Pictographic}\p{So}])|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{E0020}-\u{E007F}]|\u20e3/gu;
// :) ;-) :D :P <3 xD ^_^ -_- , standing on their own.
const EMOTICONS = /(?<![\p{L}\p{N}])(?:[:;=][-'^]?[)(\][DPpOo3|/\\*$@]+|<\/?3+|[xX]D+|\^_*\^|[oO]_[oO]|-_-)(?![\p{L}\p{N}])/gu;
const CODE_FENCE = /(```|~~~)[\s\S]*?(?:\1|$)/gu;
const INLINE_CODE = /`([^`\n]*)`/gu;
// <:name:id>, <a:name:id>, <@id>, <@!id>, <@&id>, <#id>, <t:stamp:style>, </command:id>
const DISCORD_TOKEN = /<(?:a?:[\w~-]+:\d+|@[!&]?\d+|#\d+|t:-?\d+(?::[a-zA-Z])?|\/[\w -]+:\d+)>/gu;
const HTML_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/gu;
const HTML_BREAK = /<br\s*\/?>/giu;
const HTML_ENTITY = /&(amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/giu;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const MD_IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/gu;
const MD_LINK = /\[([^\]\n]+)\]\([^)\n]*\)/gu;
const URL = /(?:(?:https?|ftp):\/\/|\bwww\.)[^\s<>"`]+/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const URL_TAIL = /[.,;:!?)\]'"]+$/u;
// Superscripts other than ² and ³ (which say "squared" and "cubed") and the other number forms --
// circled digits, vulgar fractions -- in their plain spelling: "①" is "1", "½" is "1⁄2".
const NUMBER_FORMS = /[^\P{No}²³]/gu;

function decodeEntity(match, name) {
	const lower = name.toLowerCase();
	if (NAMED_ENTITIES[lower] !== undefined) return NAMED_ENTITIES[lower];
	const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
	if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
	return String.fromCodePoint(code);
}

/**
 * Markdown blocks, line by line: headings, quotes, rules, list markers and table rows lose their marks,
 * and the lines are joined with a pause between them, so a list is said as a list and not as one word
 * run into the next.
 */
function unfoldLines(text) {
	const lines = text.split('\n');
	const several = lines.filter((line) => line.trim()).length > 1;
	const kept = [];
	for (const raw of lines) {
		let line = raw.trim();
		if (!line || /^([-*_=])(?:\s*\1){2,}$/u.test(line) || /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/u.test(line)) continue;
		let heading = false;
		line = line.replace(/^#{1,6}\s+/u, () => {
			heading = true;
			return '';
		});
		line = line
			.replace(/\s+#+$/u, '')
			.replace(/^(?:>\s?)+/u, '')
			.replace(/^[-*+•\u25e6\u25aa‣]\s+/u, '');
		// "1. Apples" in a list; on a single line "3. sırada" is an ordinal and keeps its number.
		if (several) line = line.replace(/^\d{1,2}[.)]\s+/u, '');
		if (/^\|.*\|$/u.test(line)) {
			line = line
				.slice(1, -1)
				.split('|')
				.map((cell) => cell.trim())
				.filter(Boolean)
				.join(', ');
		}
		if (line) kept.push({ line, heading });
	}
	return kept
		.map(({ line, heading }, index) => (index === kept.length - 1 || /[.!?…:;,]$/u.test(line) ? line : `${line}${heading ? '.' : ','}`))
		.join(' ');
}

/** Bold, italics, strike-through and spoilers keep their words and lose their marks. */
function unmark(text) {
	return text
		.replace(/(\*{1,3}|_{1,3}|~~|\|\|)(?!\s)([^\n]*?[^\s\\])\1(?![\p{L}\p{N}])/gu, (match, marker, inner, offset, whole) => {
			// "2*3*4" is arithmetic and snake_case_name a name: a single marker must stand at a word edge.
			if (marker.length === 1 && /[\p{L}\p{N}]/u.test(whole[offset - 1] ?? '')) return match;
			return inner;
		});
}

/**
 * Everything that does not depend on the language: invisible and control characters, code, markup,
 * links and addresses (they become `words.url` / `words.email`), emoji and emoticons.
 */
function cleanup(text, words) {
	let out = String(text)
		.normalize('NFC')
		.replace(/\r\n?/gu, '\n')
		.replace(PRIVATE, '')
		.replace(INVISIBLE, '')
		.replace(CONTROL, ' ')
		.replace(SPACES, ' ')
		.replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
	// A block of code is not read out: a few words say that there was one.
	out = out.replace(CODE_FENCE, `\n${words.code}\n`).replace(INLINE_CODE, '$1');
	out = out
		.replace(DISCORD_TOKEN, ' ')
		.replace(HTML_BREAK, '\n')
		.replace(HTML_ENTITY, decodeEntity)
		.replace(HTML_TAG, ' ')
		.replace(MD_IMAGE, '$1')
		.replace(MD_LINK, '$1');
	out = out.replace(EMAIL, ` ${words.email} `).replace(URL, (match) => {
		const tail = URL_TAIL.exec(match)?.[0] ?? '';
		return ` ${words.url}${tail}`;
	});
	out = unmark(unfoldLines(out));
	out = out
		.replace(/℃/gu, '°C')
		.replace(/℉/gu, '°F')
		.replace(/№\s?/gu, 'No. ')
		.replace(/(?<=\d)\s?º/gu, '°')
		.replace(/[\u2010\u2011\u2012]/gu, '-')
		.replace(/\u2212/gu, '-')
		.replace(/\u2015/gu, '—')
		.replace(/[’ʼ´]/gu, "'")
		.replace(NUMBER_FORMS, (ch) => ch.normalize('NFKC'))
		.replace(/⁄/gu, '/')
		.replace(PICTOGRAPHS, ' ')
		.replace(EMOTICONS, ' ');
	return out.replace(/\s+/gu, ' ').trim();
}

/** Punctuation the voice can use (a comma for a pause) and none it has to guess at. Every language. */
function tidy(text) {
	// One pass can leave what an earlier step of the same pass would have taken ("_–" becomes " –" only
	// after the dash was looked at), so it runs until nothing changes; two passes nearly always do.
	let out = text;
	for (let pass = 0; pass < 4; pass++) {
		const next = tidyOnce(out);
		if (next === out) break;
		out = next;
	}
	return out;
}

function tidyOnce(text) {
	return text
		.replace(EMOTICONS, ' ')
		.replace(/[“”„‟«»‹›"]/gu, ' ')
		.replace(/[*_#|\\^<>~@`]/gu, ' ')
		.replace(/(?<![\p{L}\p{N}])['‘]+|['‘]+(?![\p{L}\p{N}])/gu, ' ')
		.replace(/[()[\]{}]/gu, ', ')
		.replace(/\s+[-–—]+\s+|—+/gu, ', ')
		// "..." is a pause: a full stop at the end, a comma inside. A voice given three dots tends to trail
		// off into breath or silence of its own choosing.
		.replace(/(?:\.{3,}|…)+(?=[\s'"]*$)/gu, '.')
		.replace(/\s*(?:\.{3,}|…)+\s*/gu, ', ')
		.replace(/\s+([,.!?;:])/gu, '$1')
		.replace(/([!?])[!?.]*/gu, '$1')
		.replace(/\.{2,}/gu, '.')
		.replace(/([,;:])(?=[^\s\d])/gu, '$1 ')
		.replace(/[,;:](?:\s*[,;:])+/gu, ',')
		.replace(/[,;:]\s*([.!?])/gu, '$1')
		.replace(/([.!?])(?:\s*[,;:])+/gu, '$1')
		.replace(/\s+/gu, ' ')
		// Nothing left at the start that the cleanup would take for punctuation or a list marker.
		.replace(/^(?:[\s,.;:!?]|[-*+•\u25e6\u25aa‣]\s)+/u, '')
		.replace(/[\s,;:-]+$/u, '')
		.trim();
}

// ---------------------------------------------------------------- number words

function digitWords(digits, L) {
	return [...String(digits)].map((digit) => L.ones[Number(digit)]).join(' ');
}

function belowHundred(value, L) {
	if (value < L.ones.length) return L.ones[value];
	const tens = L.tens[Math.floor(value / 10)];
	return value % 10 ? `${tens}${L.tensJoiner}${L.ones[value % 10]}` : tens;
}

function belowThousand(value, L) {
	const hundreds = Math.floor(value / 100);
	const words = [];
	if (hundreds) words.push(hundreds === 1 && L.silentOne.includes(L.hundred) ? L.hundred : `${L.ones[hundreds]} ${L.hundred}`);
	if (value % 100) words.push(belowHundred(value % 100, L));
	return words.join(' ');
}

/** A whole number, given as its digits, in words. Beyond the largest scale word it is read digit by digit. */
function cardinal(digits, L) {
	const clean = String(digits).replace(/^0+(?=\d)/u, '');
	if (clean === '0') return L.ones[0];
	if (clean.length > L.scales.length * 3) return digitWords(clean, L);
	const groups = Math.ceil(clean.length / 3);
	const words = [];
	for (let group = 0; group < groups; group++) {
		const end = clean.length - (groups - 1 - group) * 3;
		const value = Number(clean.slice(Math.max(0, end - 3), end));
		if (!value) continue;
		const scale = L.scales[groups - 1 - group];
		if (scale && value === 1 && L.silentOne.includes(scale)) words.push(scale);
		else words.push(scale ? `${belowThousand(value, L)} ${scale}` : belowThousand(value, L));
	}
	return words.join(' ');
}

/** The ordinal of a number already in words: only its last word changes ("twenty-one" -> "twenty-first"). */
function ordinalWords(words, L) {
	const match = /([^\s-]+)$/u.exec(words);
	if (!match) return words;
	return words.slice(0, match.index) + (L.ordinals.get(match[1]) ?? match[1]);
}

/**
 * The digits after the decimal separator: Turkish reads up to three of them as one number ("3,25" is
 * "üç virgül yirmi beş", its leading zeros one by one), English reads them one by one ("point two five").
 */
function fractionWords(digits, L) {
	if (digits.length > L.fractionAsNumber) return digitWords(digits, L);
	const zeros = /^0*/u.exec(digits)[0];
	const rest = digits.slice(zeros.length);
	return [zeros ? digitWords(zeros, L) : '', rest ? cardinal(rest, L) : ''].filter(Boolean).join(' ');
}

/** "1.250.000,5" (Turkish) / "1,250,000.5" (English) -> { negative, int: '1250000', frac: '5' }. */
function parseNumber(text, L) {
	let value = String(text).replace(/\s+/gu, ' ');
	let negative = false;
	if (/^[-−]/u.test(value)) {
		negative = true;
		value = value.slice(1);
	}
	const { thousands, decimal } = L.format;
	let int = value;
	let frac = '';
	const at = value.indexOf(decimal);
	if (at >= 0) {
		int = value.slice(0, at);
		frac = value.slice(at + 1);
	} else if (thousands === '.' && /^\d+\.\d+$/u.test(value) && !/^\d{1,3}(?:\.\d{3})+$/u.test(value)) {
		// A dot that cannot be a thousands separator ("1.5 GB") is a decimal point in Turkish text too.
		[int, frac] = value.split('.');
	}
	int = int.split(thousands).join('').replace(/ /gu, '');
	return { negative, int, frac };
}

function speakParsed({ negative, int, frac }, L) {
	// "007" and a run too long for the scale words are digits, not an amount.
	let words = (int.length > 1 && int.startsWith('0') && !frac) || int.length > L.scales.length * 3 ? digitWords(int, L) : cardinal(int, L);
	if (frac) words = `${words} ${L.decimalWord} ${fractionWords(frac, L)}`;
	return negative ? `${L.minus} ${words}` : words;
}

function speakNumber(text, L) {
	return speakParsed(parseNumber(text, L), L);
}

/** Whole and at most nine digits: a value that can be compared (ranges, units, plurals). */
function plainValue(text, L) {
	const parsed = parseNumber(text, L);
	return !parsed.frac && parsed.int.length <= 9 ? (parsed.negative ? -1 : 1) * Number(parsed.int) : null;
}

/** English years in pairs: "twenty twenty-six", "nineteen oh five", "nineteen hundred"; 2000-2009 as numbers. */
function yearWords(year, L) {
	if (L.yearStyle !== 'paired' || year < 1100 || year > 2099 || (year >= 2000 && year <= 2009)) return cardinal(String(year), L);
	const high = cardinal(String(Math.floor(year / 100)), L);
	const low = year % 100;
	if (!low) return `${high} ${L.hundred}`;
	return low < 10 ? `${high} ${L.timeZero} ${L.ones[low]}` : `${high} ${cardinal(String(low), L)}`;
}

/** Minutes and seconds of a clock: "05" -> "sıfır beş" / "oh five". */
function clockPart(value, L) {
	return value < 10 ? `${L.timeZero} ${L.ones[value]}` : cardinal(String(value), L);
}

function timeWords(hour, minute, second, L, { meridiem = false } = {}) {
	const parts = [cardinal(String(hour), L)];
	if (minute === 0 && second === null) {
		if (!meridiem) parts.push(hour >= 1 && hour <= 12 ? L.timeFullHour : L.timeFullHour24);
	} else {
		parts.push(clockPart(minute, L));
		if (second !== null) parts.push(clockPart(second, L));
	}
	return parts.filter(Boolean).join(' ');
}

function dateWords(day, month, year, L) {
	const dayWords = L.dateDay === 'ordinal' ? ordinalWords(cardinal(String(day), L), L) : cardinal(String(day), L);
	const monthName = L.months[month - 1][0];
	if (year === null) return fill(L.dateNoYear, { day: dayWords, month: monthName });
	return fill(L.date, { day: dayWords, month: monthName, year: yearWords(year, L) });
}

// ---------------------------------------------------------------- endings after a number

const VOWELS = 'aeıioöuü';
const BACK_VOWELS = 'aıou';
const VOICELESS = 'çfhkpsşt';

/**
 * Turkish: an ending said as part of a word ("üç" + "te" -> "üçte", "yirmi" + "si" -> "yirmisi"). The
 * ending was written for the number or abbreviation it followed, so it is fitted again to the word that is
 * actually said: its vowels follow the word's last vowel, a d/t or c/ç follows its last sound, a buffer
 * letter comes or goes with its last letter ("TL'ye" is "liraya"), and "dört" softens before a vowel.
 */
function attachTurkish(word, ending, L) {
	let host = word;
	const lower = () => host.toLocaleLowerCase('tr');
	let tail = ending.toLocaleLowerCase('tr');
	const vowelEnd = VOWELS.includes(lower().at(-1));
	if (vowelEnd && VOWELS.includes(tail[0])) tail = (/^[ıiuü]n$/u.test(tail) ? 'n' : 'y') + tail;
	else if (!vowelEnd && (/^y[aeıioöuül]/u.test(tail) || /^n[ıiuü]n$/u.test(tail) || /^s[ıiuü](?:n\p{L}*)?$/u.test(tail))) tail = tail.slice(1);
	if (VOWELS.includes(tail[0])) {
		const soft = L.softEndings.find(([from]) => lower().endsWith(from));
		if (soft) host = host.slice(0, host.length - soft[0].length) + soft[1];
	}
	// "-ki" keeps its vowel whatever stands before it: "2026'daki" is "altıdaki".
	const keep = /[dt][ae]ki$/u.test(tail) ? 'ki' : '';
	if (keep) tail = tail.slice(0, -2);
	let vowel = [...lower()].reverse().find((ch) => VOWELS.includes(ch)) ?? 'e';
	let previous = lower().at(-1);
	let out = '';
	for (const ch of tail) {
		let next = ch;
		if (ch === 'a' || ch === 'e') next = BACK_VOWELS.includes(vowel) ? 'a' : 'e';
		else if ('ıiuü'.includes(ch)) next = 'aı'.includes(vowel) ? 'ı' : 'ei'.includes(vowel) ? 'i' : 'ou'.includes(vowel) ? 'u' : 'ü';
		else if (ch === 'd' || ch === 't') next = VOICELESS.includes(previous) ? 't' : 'd';
		else if (ch === 'c' || ch === 'ç') next = VOICELESS.includes(previous) ? 'ç' : 'c';
		if (VOWELS.includes(next)) vowel = next;
		out += next;
		previous = next;
	}
	return host + out + keep;
}

/** English: "twenty" -> "twenties", "six" -> "sixes" ("in your 20s", "the 1990s"). */
function pluralEnglish(word) {
	if (/[^aeiou]y$/iu.test(word)) return `${word.slice(0, -1)}ies`;
	if (/(?:s|x|z|ch|sh)$/iu.test(word)) return `${word}es`;
	return `${word}s`;
}

/** Joins what was written after a spoken number (MARK) to it, in the way the language does. */
function joinEndings(text, L) {
	const pattern = L.suffixPattern;
	const joined =
		L.suffixStyle === 'harmony'
			? text.replace(/(\p{L}+)\uE000(?:'(\p{L}+)|(\p{L}+))?/gu, (match, host, written, bare) => {
					if (written) return attachTurkish(host, written, L);
					if (bare) return pattern?.test(bare) ? attachTurkish(host, bare, L) : `${host} ${bare}`;
					return host;
				})
			: text.replace(/(\p{L}+)\uE000(?:('?)(\p{L}+))?/gu, (match, host, apostrophe, tail) => {
					if (!tail) return host;
					if (pattern?.test(tail)) return pluralEnglish(host);
					return apostrophe ? `${host}'${tail}` : `${host} ${tail}`;
				});
	return joined.replace(MARKS, '');
}

// ---------------------------------------------------------------- the rules of one language

function upperFirst(text, code) {
	return text.charAt(0).toLocaleUpperCase(code) + text.slice(1);
}

function regexFrom(entry, extraFlags = 'g') {
	if (!entry?.pattern) return null;
	return new RegExp(entry.pattern, `${entry.flags ?? ''}${extraFlags}`.replace(/(.)(?=.*\1)/gu, ''));
}

const compiled = new Map();

function rulesFor(code) {
	if (!compiled.has(code)) compiled.set(code, compile(code));
	return compiled.get(code);
}

function compile(code) {
	const L = {
		code,
		format: speechData('number_format', code),
		ones: speechData('ones', code),
		tens: speechData('tens', code),
		hundred: speechData('hundred', code),
		scales: speechData('scales', code),
		silentOne: speechData('silent_one', code),
		tensJoiner: speechData('tens_joiner', code),
		ordinals: new Map(speechData('ordinals', code)),
		decimalWord: speechData('decimal_word', code),
		fractionAsNumber: speechData('fraction_as_number', code),
		minus: speechData('minus', code),
		plus: speechData('plus', code),
		times: speechData('times', code),
		divided: speechData('divided', code),
		equals: speechData('equals', code),
		and: speechData('and', code),
		point: speechData('point', code),
		dot: speechData('dot', code),
		about: speechData('about', code),
		squared: speechData('squared', code),
		cubed: speechData('cubed', code),
		percentWord: speechData('percent_word', code),
		per: speechData('per', code),
		ratio: speechData('ratio', code),
		ratioCase: speechData('ratio_case', code),
		degreesWord: speechData('degrees_word', code),
		percent: speechData('percent', code),
		multiple: speechData('multiple', code),
		range: speechData('range', code),
		rangeAdjacent: speechData('range_adjacent', code),
		score: speechData('score', code),
		version: speechData('version', code),
		numberSign: speechData('number_sign', code),
		timeZero: speechData('time_zero', code),
		timeFullHour: speechData('time_full_hour', code),
		timeFullHour24: speechData('time_full_hour_24', code),
		timeAm: speechData('time_am', code),
		timePm: speechData('time_pm', code),
		months: speechData('months', code),
		date: speechData('date', code),
		dateNoYear: speechData('date_no_year', code),
		dayMonth: speechData('day_month', code),
		dayMonthYear: speechData('day_month_year', code),
		dateDay: speechData('date_day', code),
		slashDates: speechData('slash_dates', code),
		yearStyle: speechData('year_style', code),
		fractionStyle: speechData('fraction_style', code),
		fractionSpecials: new Map(speechData('fraction_specials', code)),
		fractionDenominators: new Map((speechData('fraction_denominators', code) ?? []).map(([den, one, many]) => [den, { one, many }])),
		fractionOutOf: speechData('fraction_out_of', code),
		currencies: speechData('currencies', code),
		amountScales: new Map(speechData('amount_scales', code)),
		numberScales: new Map(speechData('number_scales', code)),
		money: speechData('money', code),
		units: speechData('units', code),
		abbreviations: speechData('abbreviations', code),
		suffixPattern: regexFrom(speechData('number_suffix', code), ''),
		suffixStyle: speechData('suffix_style', code),
		softEndings: speechData('soft_endings', code),
		words: { url: speechData('url', code), email: speechData('email', code), code: speechData('code', code) },
	};

	// ---- the shape of a number in this language
	const { thousands, decimal } = L.format;
	const T = escapeRegExp(thousands);
	const FRAC = `(?:${escapeRegExp(decimal)}\\d+)?`;
	// A dot that cannot group thousands is a decimal point even where the dot groups thousands ("1.5 GB").
	const DOTTED = thousands === '.' ? '|\\d+\\.(?!\\d{3}(?!\\d))\\d+' : '';
	// A minus sign only where it cannot be a dash between two things: "-5", not the one in "3-5" or "COVID-19".
	const SIGN = `(?:(?<![\\p{L}\\p{N}.,${MARK}])-)?`;
	// Thousands grouped by this language's separator, or by spaces ("10 000", "1 250 000"), or none.
	const NUM = `${SIGN}(?:\\d{1,3}(?:${T}\\d{3})+(?!\\d)${FRAC}${DOTTED}|\\d{2,3}(?: \\d{3})+(?!\\d)${FRAC}|\\d(?: \\d{3}){2,}(?!\\d)${FRAC}|\\d+${FRAC})`;
	const AMOUNT = `(${NUM})(?:\\s?[-–]\\s?(${NUM}))?`;
	// Not in the middle of a run of digits. ASCII digits only: "²9" is a square and then a nine.
	const B = '(?<![0-9])';

	const mark = (words) => `${words}${MARK}`;
	/** "3-5" as "üç ila beş" / "three to five"; neighbours side by side where the language says them so. */
	const rangeWords = (first, second, { scores = false } = {}) => {
		const a = plainValue(first, L);
		const b = plainValue(second, L);
		const from = speakNumber(first, L);
		const to = speakNumber(second, L);
		if (scores && a !== null && b !== null && a >= b) return fill(L.score, { from, to });
		const years = L.yearStyle === 'paired' && [a, b].every((value) => value !== null && value >= 1100 && value <= 2099);
		if (years) return fill(L.range, { from: yearWords(a, L), to: yearWords(b, L) });
		const adjacent = a !== null && b !== null && a >= 0 && b === a + 1 && b <= 10;
		return fill(adjacent ? L.rangeAdjacent : L.range, { from, to });
	};
	const amountWords = (first, second) => (second ? rangeWords(first, second) : speakNumber(first, L));
	const isOne = (first, second) => !second && plainValue(first, L) === 1;

	// ---- money
	const currencyBySymbol = new Map();
	for (const currency of L.currencies) for (const symbol of currency.symbols) currencyBySymbol.set(symbol, currency);
	const CUR = alternation([...currencyBySymbol.keys()]);
	const SCALE = alternation([...L.amountScales.keys()]);
	const moneyWords = (symbol, first, second, scale) => {
		const currency = currencyBySymbol.get(symbol);
		if (second) return `${rangeWords(first, second)}${scale ? ` ${L.amountScales.get(scale)}` : ''} ${currency.many}`;
		const parsed = parseNumber(first, L);
		if (scale) return `${speakParsed(parsed, L)} ${L.amountScales.get(scale)} ${currency.many}`;
		const whole = speakParsed({ ...parsed, frac: '' }, L);
		const unit = parsed.int.replace(/^0+(?=\d)/u, '') === '1' ? currency.one : currency.many;
		if (!parsed.frac || !/^\d{1,2}$/u.test(parsed.frac)) {
			return parsed.frac ? `${speakParsed(parsed, L)} ${currency.many}` : fill(L.money.whole, { amount: whole, unit });
		}
		const cents = Number(parsed.frac.padEnd(2, '0'));
		if (!cents) return fill(L.money.whole, { amount: whole, unit });
		const subunit = cents === 1 ? currency.cent_one : currency.cent_many;
		const centWords = cardinal(String(cents), L);
		if (!Number(parsed.int)) return fill(L.money.only_cents, { cents: centWords, subunit });
		return fill(cents < 10 ? L.money.small_cents : L.money.cents, { amount: whole, unit, cents: centWords, subunit });
	};

	// ---- units
	const unitByWritten = new Map(L.units.map(([written, one, many]) => [written, { one, many }]));
	const UNIT = alternation([...unitByWritten.keys()]);
	const unitWords = (first, second, written) => {
		const unit = unitByWritten.get(written);
		const word = isOne(first, second) ? unit.one : unit.many;
		const n = amountWords(first, second);
		return word.includes('{n}') ? fill(word, { n }) : `${n} ${word}`;
	};

	// ---- dates and times
	const monthIndex = new Map();
	L.months.forEach((forms, index) => forms.forEach((form) => monthIndex.set(form, index + 1)));
	const MONTH = `(${alternation([...monthIndex.keys()])})\\.?`;
	const ORDINAL_TAIL = '(?:st|nd|rd|th)?';
	const validDate = (day, month) => day >= 1 && day <= 31 && month >= 1 && month <= 12;
	const yearOf = (text) => (text === undefined ? null : Number(text));
	const TIME_SEP = thousands === '.' ? '[:.]' : ':';
	const MERIDIEM = '(?:\\s?([aApP])\\.?\\s?[mM]\\.?(?![\\p{L}]))';
	const meridiem = (letter, words) => fill(/[aA]/u.test(letter) ? L.timeAm : L.timePm, { time: words });

	// ---- fractions
	const fractionWords = (num, den) => {
		const special = L.fractionSpecials.get(`${Number(num)}/${Number(den)}`);
		if (special) return special;
		if (L.fractionStyle === 'locative') return `${attachTurkish(cardinal(den, L), 'da', L)} ${cardinal(num, L)}`;
		const named = L.fractionDenominators.get(Number(den));
		if (named) return `${cardinal(num, L)} ${Number(num) === 1 ? named.one : named.many}`;
		return fill(L.fractionOutOf, { num: cardinal(num, L), den: cardinal(den, L) });
	};

	// ---- dotted numbers: versions, addresses, and thousands grouped with dots in an English sentence
	const dottedWords = (text) => {
		const parts = text.split('.');
		if (parts[0].length <= 3 && parts.slice(1).every((part) => part.length === 3)) return cardinal(parts.join(''), L);
		return parts.map((part) => (part.length > 1 && part.startsWith('0') ? digitWords(part, L) : cardinal(part, L))).join(` ${L.point} `);
	};

	// ---- abbreviations: as written, and those starting with a small letter capitalised as well
	const abbreviations = new Map();
	for (const [written, said, ends = false] of L.abbreviations) abbreviations.set(written, { said, ends });
	for (const [written, said, ends = false] of L.abbreviations) {
		const capital = upperFirst(written, code);
		if (!abbreviations.has(capital)) abbreviations.set(capital, { said: upperFirst(said, code), ends });
	}
	const ABBREVIATION = [...abbreviations.keys()]
		.sort((a, b) => b.length - a.length)
		.map((written) => escapeRegExp(written) + (/[\p{L}\p{N}]$/u.test(written) ? '(?![\\p{L}\\p{N}])' : ''))
		.join('|');

	const TLD = '(?:com|net|org|io|dev|ai|co|app|gg|tv|me|edu|gov|info|biz|tr|uk|de|eu|us)';
	const ordinalMark = speechData('ordinal_mark', code);
	const ordinalDot = speechData('ordinal_dot', code);

	// Each rule: [pattern, replacement]. The order is the one described at the top of the file.
	const rules = [
		// A domain named in the sentence ("google.com") is said with its dots; a whole link was already
		// replaced by the cleanup.
		[new RegExp(`(?<![\\p{L}\\p{N}._-])((?:[\\p{Ll}\\p{N}-]+\\.)+${TLD})(?![\\p{L}])`, 'gu'), (match) => match.split('.').join(` ${L.dot} `)],
		// Phone numbers and long codes, digit by digit, a pause between the groups as written. A long run
		// is one of those: an amount of eight digits or more is written grouped ("12.500.000"), an order
		// number or a code is not, and said as an amount it is of no use to anybody.
		[
			/(?<![\p{L}\p{N}+])(\+?\(?\d[\d ()-]{5,}\d)(?![\p{N}])/gu,
			(match) => {
				const digits = match.replace(/\D/gu, '');
				const lead = /^[+(0]/u.test(match);
				const run = /^\d+$/u.test(match);
				if (!(lead ? digits.length >= 7 : digits.length >= (run ? 8 : 10))) return match;
				const groups = match.replace(/[()]/gu, ' ').trim().split(/[\s-]+/u).filter(Boolean);
				// "1 250 000 000" is an amount and "1990-2000-2010" a row of years.
				if (!lead && (/^\d{1,3}(?: \d{3})+$/u.test(match) || groups.every((group) => group.length === 4))) return match;
				const spoken = groups.map((group) => digitWords(group.replace(/\D/gu, ''), L)).join(', ');
				return mark(match.startsWith('+') ? `${L.plus} ${spoken}` : spoken);
			},
		],
		// Dates: 2026-09-24, 24.09.2026 (day first, always), 24/09/2026 (the language's order when both
		// could be a month), September 24, 2026 and 24 September 2026.
		[
			/(?<![\p{N}.])(\d{4})-(\d{1,2})-(\d{1,2})(?![\p{N}]|-\d)/gu,
			(match, year, month, day) => (validDate(Number(day), Number(month)) ? mark(dateWords(Number(day), Number(month), Number(year), L)) : match),
		],
		[
			/(?<![\p{N}.,/-])(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?![\p{N}]|[./-]\d)/gu,
			(match, first, separator, second, year) => {
				let [day, month] = [Number(first), Number(second)];
				const monthFirst = separator !== '.' && (day > 12 ? false : month > 12 ? true : L.slashDates === 'mdy');
				if (monthFirst) [day, month] = [month, day];
				if (!validDate(day, month)) return match;
				return mark(year.length === 2 ? `${dateWords(day, month, null, L)} ${cardinal(year, L)}` : dateWords(day, month, Number(year), L));
			},
		],
		[
			new RegExp(`(?<![\\p{L}])${MONTH}\\s(\\d{1,2})${ORDINAL_TAIL}(?![\\p{L}\\p{N}])(?:,?\\s(\\d{4})(?![\\p{N}]))?`, 'gu'),
			(match, month, day, year) => (validDate(Number(day), monthIndex.get(month)) ? mark(dateWords(Number(day), monthIndex.get(month), yearOf(year), L)) : match),
		],
		[
			new RegExp(`(?:(?<![\\p{L}])[Tt]he\\s)?${B}(\\d{1,2})(?:${ORDINAL_TAIL.slice(0, -1)}|\\.)?\\s(?:of\\s)?${MONTH}(?![\\p{L}])(?:,?\\s(\\d{4})(?![\\p{N}]))?`, 'gu'),
			(match, day, name, year) => {
				const index = monthIndex.get(name);
				if (!validDate(Number(day), index)) return match;
				const dayWords = L.dateDay === 'ordinal' ? ordinalWords(cardinal(day, L), L) : cardinal(day, L);
				const month = L.months[index - 1][0];
				if (year === undefined) return mark(fill(L.dayMonth, { day: dayWords, month }));
				return mark(fill(L.dayMonthYear, { day: dayWords, month, year: yearWords(Number(year), L) }));
			},
		],
		[new RegExp(`(?<![\\p{L}])${MONTH},?\\s(\\d{4})(?![\\p{N}])`, 'gu'), (match, month, year) => mark(`${L.months[monthIndex.get(month) - 1][0]} ${yearWords(Number(year), L)}`)],
		// Arithmetic: "2+2=4", "1920x1080", "10 ÷ 2", and a minus that stands in an equation.
		[/(?<=\d)\s?[x×*]\s?(?=\d)/gu, ` ${L.times} `],
		[/(?<=\d)\s?\+\s?(?=-?\d)/gu, ` ${L.plus} `],
		[/(?<=\d)\s?÷\s?(?=\d)/gu, ` ${L.divided} `],
		[/(?<=\d)\s?-\s?(?=\d+(?:[.,]\d+)?\s?=)/gu, ` ${L.minus} `],
		[/(?<=\d)\s?=\s?(?=-?\d)/gu, ` ${L.equals} `],
		// "~5 dk" -> "yaklaşık beş dakika".
		[/~\s?(?=-?\d)/gu, `${L.about} `],
		// Money: "₺50", "$3.99", "12,50 TL", "$1.5M", "5 milyon TL".
		[new RegExp(`(?<![\\p{L}\\p{N}])(${CUR})\\s?${AMOUNT}(?:\\s?(${SCALE})(?![\\p{L}]))?`, 'gu'), (match, symbol, first, second, scale) => mark(moneyWords(symbol, first, second, scale))],
		[new RegExp(`${B}${AMOUNT}(?:\\s?(${SCALE}))?\\s?(${CUR})(?![\\p{L}])`, 'gu'), (match, first, second, scale, symbol) => mark(moneyWords(symbol, first, second, scale))],
		// "1.5M users", "10k steps": a scale letter glued to a number, where the language writes one.
		...(L.numberScales.size
			? [
					[
						new RegExp(`${B}(${NUM})(${alternation([...L.numberScales.keys()])})(?![\\p{L}\\p{N}])`, 'gu'),
						(match, number, scale) => mark(`${speakNumber(number, L)} ${L.numberScales.get(scale)}`),
					],
				]
			: []),
		// Percentages, the sign on either side: "%20", "% 20", "20%", "%20-30".
		[new RegExp(`${B}%\\s?${AMOUNT}`, 'gu'), (match, first, second) => mark(fill(L.percent, { n: amountWords(first, second) }))],
		[new RegExp(`${B}${AMOUNT}\\s?%`, 'gu'), (match, first, second) => mark(fill(L.percent, { n: amountWords(first, second) }))],
		// Units after a number. The full stop of "5 dk. sonra" goes with the unit; before a capital it
		// stays, because there it ends a sentence.
		[/°\s+(?=[CF](?![\p{L}]))/gu, '°'],
		[new RegExp(`${B}${AMOUNT}\\s?(${UNIT})(?![\\p{L}\\p{N}])(?:\\.(?=\\s+\\p{Ll}))?`, 'gu'), (match, first, second, written) => mark(unitWords(first, second, written))],
		// Clock times: "14:45", "09:05", "9.30'da" (a dot in Turkish), "3:30 pm", "3pm", and from one to
		// another ("18:00-20:00").
		[
			new RegExp(`(?<![\\p{N}.:,])(\\d{1,2})(${TIME_SEP})(\\d{2})\\s?[-–]\\s?(\\d{1,2})\\2(\\d{2})(?![\\p{N}]|[.:,]\\d)`, 'gu'),
			(match, fromHour, separator, fromMinute, toHour, toMinute) => {
				const [a, b, c, d] = [fromHour, fromMinute, toHour, toMinute].map(Number);
				if (a > 24 || c > 24 || b > 59 || d > 59) return match;
				return mark(fill(L.range, { from: timeWords(a, b, null, L), to: timeWords(c, d, null, L) }));
			},
		],
		[
			new RegExp(`(?<![\\p{N}.:,])(\\d{1,2})(${TIME_SEP})(\\d{2})(?:\\2(\\d{2}))?(?![\\p{N}]|[.:,]\\d)${MERIDIEM}?`, 'gu'),
			(match, hour, separator, minute, second, am) => {
				const [h, m, s] = [Number(hour), Number(minute), second === undefined ? null : Number(second)];
				if (h > 24 || m > 59 || (s !== null && s > 59)) return match;
				const words = timeWords(h, m, s, L, { meridiem: Boolean(am) });
				return mark(am ? meridiem(am, words) : words);
			},
		],
		[new RegExp(`(?<![\\p{N}.:,])(\\d{1,2})${MERIDIEM}`, 'gu'), (match, hour, am) => (Number(hour) > 12 ? match : mark(meridiem(am, cardinal(hour, L))))],
		// What is left of a colon between two numbers is a ratio: "16:9", "4:3" ("on altıya dokuz", "four to three").
		[
			/(?<![\p{N}.:,])(\d{1,3}):(\d{1,3})(?![\p{N}]|[.:,]\d)/gu,
			(match, first, second) => {
				const from = L.ratioCase ? attachTurkish(cardinal(first, L), L.ratioCase, L) : cardinal(first, L);
				return mark(fill(L.ratio, { from, to: cardinal(second, L) }));
			},
		],
		// Versions and addresses: "v2.0" -> "sürüm iki nokta sıfır", "192.168.1.1" with its dots.
		[/(?<![\p{L}\p{N}])[vV](\d+(?:\.\d+)+)(?![\p{N}]|\.\d)/gu, (match, digits) => mark(fill(L.version, { n: dottedWords(digits) }))],
		[/(?<![\p{N}.,])(\d+(?:\.\d+){2,})(?![\p{N}]|\.\d)/gu, (match, digits) => mark(dottedWords(digits))],
		// Ordinals: "3'üncü", "3. sırada", "21st".
		[
			new RegExp(`${B}(\\d+)(?:${ordinalMark.pattern})(\\p{Ll}*)`, `${ordinalMark.flags}g`),
			(match, digits, rest) => {
				const words = ordinalWords(cardinal(digits, L), L);
				return rest && L.suffixStyle === 'harmony' ? mark(attachTurkish(words, rest, L)) : mark(rest ? `${words} ${rest}` : words);
			},
		],
		...(ordinalDot.pattern
			? [[new RegExp(`(?<![\\p{N}.,])(\\d+)(?:${ordinalDot.pattern})`, `${ordinalDot.flags}g`), (match, digits) => mark(ordinalWords(cardinal(digits, L), L))]]
			: []),
		// "3x" -> "üç kat" / "three times".
		[new RegExp(`${B}(${NUM})\\s?[x×](?![\\p{L}\\p{N}])`, 'gu'), (match, number) => mark(fill(L.multiple, { n: speakNumber(number, L) }))],
		// Ranges and scores: "3-5", "10–15", "3-1".
		[new RegExp(`${B}(${NUM})\\s?[-–]\\s?(${NUM})(?![\\p{N}])`, 'gu'), (match, first, second) => mark(rangeWords(first, second, { scores: true }))],
		// Fractions: "3/4", "1/2", "24/7".
		[/(?<![\p{N}/.,])(\d{1,4})\s?\/\s?(\d{1,4})(?![\p{N}/])/gu, (match, num, den) => (Number(den) ? mark(fractionWords(num, den)) : match)],
		// "#1", "No. 5".
		[new RegExp(`(?<![\\p{L}\\p{N}])(?:#\\s?|N[or]\\.\\s?)(\\d+)(?![\\p{N}])`, 'gu'), (match, digits) => mark(fill(L.numberSign, { n: cardinal(digits, L) }))],
		// "COVID-19", "3-D": the dash between a word and a number is only a join.
		[/(?<=\p{L})-(?=\d)|(?<=\d)-(?=\p{L})/gu, ' '],
		[/(?<=[\p{L}\p{N}])²/gu, ` ${L.squared}`],
		[/(?<=[\p{L}\p{N}])³/gu, ` ${L.cubed}`],
		// Every other number. In English a bare four-digit number from 1100 to 2099 is read the way a year is
		// ("twenty twenty-six", "fifteen hundred"): an amount that size is written with a comma ("1,500"),
		// and read as a year it is still said the way people say it. One glued to a word ("mp3", "H2O")
		// gets a space in front, so the word keeps its letters and the number its words.
		[
			new RegExp(`${B}(${NUM})`, 'gu'),
			(match, number, offset, whole) => {
				const space = /[\p{L}\p{N}']/u.test(whole[offset - 1] ?? '') ? ' ' : '';
				const year = /^\d{4}$/u.test(number) ? Number(number) : null;
				return `${space}${mark(year !== null && year >= 1100 && year <= 2099 ? yearWords(year, L) : speakNumber(number, L))}`;
			},
		],
	];

	const symbols = [
		[/\s*(?:->|=>|→|⇒|⟶|\u279c)\s*/gu, ', '],
		[/\s*&\s*/gu, ` ${L.and} `],
		[/\s*=\s*/gu, ` ${L.equals} `],
		[/\s*\+\s*/gu, ` ${L.plus} `],
		[/\//gu, ' '],
		[/\s*%\s*/gu, ` ${L.percentWord} `],
		[/\s*°\s*/gu, ` ${L.degreesWord} `],
		[/\s*[×\u2715]\s*/gu, ` ${L.times} `],
		[/\s*÷\s*/gu, ` ${L.divided} `],
		[/²/gu, ` ${L.squared}`],
		[/³/gu, ` ${L.cubed}`],
		[new RegExp(`[${[...currencyBySymbol.keys()].filter((symbol) => symbol.length === 1).map(escapeRegExp).join('')}]`, 'gu'), (symbol) => ` ${currencyBySymbol.get(symbol).many} `],
	];

	return {
		L,
		rules,
		symbols,
		abbreviation: new RegExp(`(?<![\\p{L}\\p{N}])(${ABBREVIATION})(?:'(\\p{L}+))?`, 'gu'),
		abbreviations,
		// "$19.99/month": a slash right after a spoken amount is "per", where the language says it so.
		per: L.per ? [new RegExp(`${MARK}\\s?/\\s?(?=\\p{L})`, 'gu'), `${MARK} ${L.per} `] : null,
	};
}

/**
 * A run of three or more words in capitals is shouting, not a row of acronyms: said in small letters
 * (with this language's İ/ı) it is read as words, where a voice might otherwise spell it or bark it.
 * Single capitals ("I") ride along without counting; one or two capitalised words (NASA, AB) stay.
 */
function lowerShouting(text, code) {
	// Words are runs of letters, whatever stands between them, so "PMİ;GB" is two words before the
	// punctuation is tidied and after.
	const parts = text.split(/(\P{L}+)/u);
	const shouting = (part) => {
		if (!part || /\p{Ll}/u.test(part)) return false;
		return [...part].length >= 2 ? 'word' : 'letter';
	};
	// Outside Turkish a dotted capital İ is an I: lower-cased as it is, it would keep its dot as a separate mark.
	const lower = (word) => (code === 'tr' ? word : word.replace(/İ/gu, 'I')).toLocaleLowerCase(code);
	let run = [];
	const flush = () => {
		const words = run.filter((index) => shouting(parts[index]) === 'word');
		if (words.length >= 3) for (const index of words) parts[index] = lower(parts[index]);
		run = [];
	};
	for (let index = 0; index < parts.length; index += 2) {
		if (shouting(parts[index])) run.push(index);
		else flush();
	}
	flush();
	return parts.join('');
}

function speakLanguage(text, compiledRules) {
	const { L, rules, symbols, abbreviation, abbreviations, per } = compiledRules;
	let out = text;
	for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
	out = lowerShouting(out, L.code);
	out = out.replace(abbreviation, (match, written, ending, offset, whole) => {
		const { said, ends } = abbreviations.get(written);
		if (ending) return `${said}${MARK}'${ending}`;
		// "elma, armut vb." ends the sentence with the abbreviation's own full stop.
		const rest = whole.slice(offset + match.length);
		return ends && written.endsWith('.') && (/^\s*$/u.test(rest) || /^\s+\p{Lu}/u.test(rest)) ? `${said}.` : said;
	});
	if (per) out = out.replace(per[0], per[1]);
	out = joinEndings(out, L);
	for (const [pattern, replacement] of symbols) out = out.replace(pattern, replacement);
	return out;
}

function lastResort(text) {
	return String(text ?? '')
		.replace(PRIVATE, '')
		.replace(CONTROL, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

/**
 * The words to say for `text`, in `language` ("tr", "en"; anything else gets only the cleanup).
 * Never throws; returns '' only when nothing in the text can be said (an emoji, a lone asterisk).
 */
export function toSpeech(text, language = null) {
	const source = String(text ?? '');
	if (!source.trim()) return '';
	try {
		const code = speechLanguage(language);
		const clean = cleanup(source, rulesFor(code ?? FALLBACK_LOCALE).L.words);
		if (!code || !clean) return tidy(clean);
		return tidy(speakLanguage(clean, rulesFor(code))) || tidy(clean);
	} catch {
		return lastResort(source);
	}
}

/** A whole number in words ("2026", "tr" -> "iki bin yirmi altı"); for tests and diagnostics. */
export function spellNumber(value, language) {
	const code = speechLanguage(language) ?? FALLBACK_LOCALE;
	return cardinal(String(value).replace(/\D/gu, '') || '0', rulesFor(code).L);
}
