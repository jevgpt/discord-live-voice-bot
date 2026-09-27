// Pure text helpers: no dependency on Discord, and nothing beyond the locale tables.
// (normalize/findCharacter/findChannelByName/stripDictationTail used to live in commands.js and
//  balanceCodeFences in messages.js; they moved here so the layering points the right way.
//  The old locations re-export them for backwards compatibility.)

import { tList, tRaw } from './i18n/index.js';

// Turkish letters -> ASCII. Language data, kept in every language: the bot still has to match
// Turkish speech and Turkish channel/role names when it runs in English.

const TR_MAP = { ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', I: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u' };

// Fancy letters that are common in Discord role/channel names (like ᴄʜɪʟʟ).
const SMALL_CAPS = {
	ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l',
	ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ꞯ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w',
	ʏ: 'y', ᴢ: 'z',
};

/** Comparison key: strips accents/Turkish letters/suffixes, lower-cases, keeps only [a-z0-9 ]. */
export function normalize(text) {
	return String(text ?? '')
		// drop the suffix glued on after an apostrophe ("Ali'ye", "Sangul'ento") so the name core survives
		.replace(/['’]\s*[a-zçğıöşü]{1,4}(?![\p{L}])/giu, ' ')
		.normalize('NFKD') // 𝓒𝓱𝓲𝓵𝓵 / Ｃｈｉｌｌ -> Chill; a c-cedilla becomes c + a combining mark
		.replace(/[̀-ͯ]/g, '') // drop accents/combining marks
		.replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡʏᴢ]/g, (ch) => SMALL_CAPS[ch] ?? ch)
		.replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** Collapses whitespace and trims (a pattern repeated everywhere). */
export function squash(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Cleans a value that came from a channel member (a display name, a transcript, a saved note) before it
 * is handed to the model. Newlines and control characters are what let such a value pretend to be a new
 * instruction line, so they collapse to spaces; notes keep their line breaks because they are a list.
 * (It lived in guildsession.js; the text replies in messages.js hand the same notes to a model too.)
 */
export function safeContext(text, { keepLines = false } = {}) {
	const raw = String(text ?? '');
	const cleaned = keepLines ? raw.replace(/\r/gu, '') : raw.replace(/[\r\n]+/gu, ' ');
	// Control characters are stripped on purpose: they are the other way a value can fake a new line.
	// oxlint-disable-next-line no-control-regex
	return cleaned.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
}

/**
 * Takes off the part that has already been said. Some transcript streams re-send the text so far on
 * every delta, and a flush landing in between then records one sentence twice with the second copy
 * carrying the first — which reads, in the log and the panel, exactly like the bot repeating itself.
 * Returns the new part, or '' when nothing new arrived.
 */
export function stripSpokenPrefix(line, previous) {
	const full = squash(line);
	if (!full) return '';
	const said = squash(previous);
	if (!said || !full.startsWith(said)) return full;
	return full.slice(said.length).trim();
}

/**
 * Character name -> character. Four stages: exact, prefix, contains, reverse-contains.
 * Reverse-contains (the search text contains the character name) is limited to names of 3+ letters;
 * otherwise a character called "A" matches every sentence.
 */
export function findCharacter(characters, name) {
	const needle = normalize(name);
	if (!needle) return null;
	const normalized = (characters ?? []).map((c) => ({ character: c, key: normalize(c.name) }));
	return (
		normalized.find((entry) => entry.key === needle)?.character ??
		normalized.find((entry) => entry.key.startsWith(needle))?.character ??
		normalized.find((entry) => entry.key.includes(needle))?.character ??
		normalized.find((entry) => entry.key.length > 2 && needle.includes(entry.key))?.character ??
		null
	);
}

/** Channel name -> channel (loose matching; the transcript can be mangled). */
export function findChannelByName(channels, name) {
	const needle = normalize(name);
	if (!needle) return null;
	const keyed = (channels ?? []).map((channel) => ({ channel, key: normalize(channel.name) }));
	return (
		keyed.find((entry) => entry.key === needle)?.channel ??
		keyed.find((entry) => entry.key.startsWith(needle))?.channel ??
		keyed.find((entry) => entry.key.includes(needle))?.channel ??
		keyed.find((entry) => needle.includes(entry.key) && entry.key.length > 2)?.channel ??
		null
	);
}

/**
 * Strips the dictation tail: when a message is dictated ("tell them to join the voice channel"), the
 * message itself is only the quoted part, and the quoting particle at the end must not end up in it.
 * The particles are language data and come from the active locale (grammar.dictation_tail). Very short
 * messages (2 words or fewer) are left alone, and wrapping quotes are dropped.
 */
export function stripDictationTail(text) {
	let out = String(text ?? '').trim();
	out = out.replace(/^["'“”«»](.*)["'“”«»]$/su, '$1').trim();
	const pattern = tRaw('grammar.dictation_tail');
	if (!pattern) return out;
	const tail = new RegExp(pattern, 'iu');
	for (let pass = 0; pass < 3; pass++) {
		if (out.split(/\s+/).filter(Boolean).length < 3) break;
		const next = out.replace(tail, '').trim();
		if (next === out || !next) break;
		out = next;
	}
	return out;
}

/**
 * Closes an unclosed code fence: on Discord a single stray ``` turns everything after it into a code block.
 * When `maxLength` is given it trims first and balances afterwards (so the closing fence is not lost to the trim).
 */
export function balanceCodeFences(text, { maxLength = null } = {}) {
	let value = String(text ?? '');
	if (maxLength && value.length > maxLength) value = value.slice(0, maxLength - 4).trimEnd();
	const fences = value.match(/```/g)?.length ?? 0;
	if (fences % 2 === 0) return value;
	return `${value}\n\`\`\``;
}

/** HTML escaping (so user data does not reach innerHTML in places like the panel). */
export function escapeHtml(text) {
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * A place in a track as people write it: "1:30" -> 90, "1:02:03" -> 3723, a bare "90" -> 90 seconds.
 * A dot stands for the colon too ("1.30"), because a transcript writes it that way about as often.
 * null for anything that is not a time, including "1:75".
 */
export function parseClock(text) {
	const value = String(text ?? '').trim();
	if (/^\d{1,6}$/u.test(value)) return Number(value);
	const match = /^(\d{1,3})[:.](\d{2})(?:[:.](\d{2}))?$/u.exec(value);
	if (!match) return null;
	const [first, second, third] = [match[1], match[2], match[3]].map((part) => (part === undefined ? null : Number(part)));
	if (second >= 60 || (third !== null && third >= 60)) return null;
	return third === null ? first * 60 + second : first * 3600 + second * 60 + third;
}

/** Seconds -> "1:05", or "1:02:03" past the hour. Whole seconds, rounded down: 1:59.9 is still 1:59. */
export function formatClock(seconds) {
	const total = Math.max(0, Math.floor(Number(seconds) || 0));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = String(total % 60).padStart(2, '0');
	return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** "1", "yes", "on" and their Turkish equivalents -> true; "0", "no", "off" and theirs -> false; otherwise fallback. */
export function parseBool(value, fallback = false) {
	if (typeof value === 'boolean') return value;
	if (value === undefined || value === null) return fallback;
	const text = String(value).trim().toLowerCase();
	if (!text) return fallback;
	// Universal spellings first, then the ones people actually say in the active language.
	if (/^(?:1|true|yes|on|open|enable|enabled)$/i.test(text)) return true;
	if (/^(?:0|false|no|off|close|closed|disable|disabled)$/i.test(text)) return false;
	if (tList('keywords.bool_true').includes(text)) return true;
	if (tList('keywords.bool_false').includes(text)) return false;
	return fallback;
}
