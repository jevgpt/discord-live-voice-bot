// Updating the .env file from the panel: in place (comments and the order of the other lines survive),
// atomically (tmp + rename, like every store here), and with a timestamped copy kept before the first
// change, so a pasted-wrong key can be undone by hand. No value ever comes back out of this module.

import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { t } from './i18n/index.js';

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * No value may carry a line break: it would end the line and start one of its own, which is a new
 * setting of the writer's choosing. The other control characters are nothing a key or a setting is made of.
 */
function hasControlCharacter(text) {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Writes `patch` ({ KEY: value }) into the file, replacing those keys where they are already there and
 * appending the rest. Values containing anything the format would misread are quoted, as dotenv expects;
 * a key that is not a plain name, or a value no quoting can carry, throws and nothing is written.
 * @returns {{ changed: string[], backup: string|null }}
 */
export async function updateEnvFile(file, patch = {}) {
	const remaining = new Map(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null));
	// Every entry is checked before the file is touched, so one bad entry leaves it exactly as it was.
	for (const [key, value] of remaining) {
		if (!KEY_NAME.test(key)) throw new Error(t('runtime.env_key_invalid'));
		quote(value);
	}
	let raw = '';
	try {
		raw = await readFile(file, 'utf8');
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
	}
	const lines = raw.split(/\r?\n/u);
	const changed = [];
	for (let index = 0; index < lines.length; index++) {
		const match = KEY_LINE.exec(lines[index]);
		if (!match) continue;
		const key = match[1];
		if (!remaining.has(key)) continue;
		lines[index] = `${key}=${quote(remaining.get(key))}`;
		remaining.delete(key);
		changed.push(key);
	}
	for (const [key, value] of remaining) {
		lines.push(`${key}=${quote(value)}`);
		changed.push(key);
	}
	if (!changed.length) return { changed, backup: null };

	const backup = `${file}.${Date.now()}.bak`;
	await copyFile(file, backup).catch(() => {});
	const body = `${lines.join('\n').replace(/\n+$/u, '')}\n`;
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, body, 'utf8');
	await rename(tmp, file);
	return { changed, backup };
}

/**
 * A value plain enough to sit bare in the file stays bare; anything else is quoted. Node's parser has no
 * escapes: a quoted value ends at the first matching quote, and between double quotes it turns the two
 * characters "\n" into a line break. So the value is wrapped in a quote it does not contain (double only
 * when it has no backslash either), and one that holds all three kinds is refused rather than mangled.
 */
function quote(value) {
	const text = String(value);
	if (hasControlCharacter(text)) throw new Error(t('runtime.env_value_invalid'));
	if (/^[A-Za-z0-9_./:@+-]*$/u.test(text)) return text;
	if (!/["\\]/u.test(text)) return `"${text}"`;
	if (!text.includes("'")) return `'${text}'`;
	if (!text.includes('`')) return `\`${text}\``;
	throw new Error(t('runtime.env_value_invalid'));
}

/** `sk-proj-…4f9a`: enough to recognise which key this is, not enough to use one. */
export function maskSecret(value) {
	const text = String(value ?? '').trim();
	if (!text) return '';
	if (text.length <= 8) return '…';
	return `${text.slice(0, 6)}…${text.slice(-4)}`;
}
