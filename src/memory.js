// Persistent memory: a few short notes per person (data/memory.json).
// When the model is told "keep this in mind" it writes a note with the remember_note tool; as soon as
// someone starts talking those notes come back as silent context (thinking) -- that is where the
// "do you remember me" experience comes from.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalize } from './text.js';

const MAX_NOTES_PER_USER = 30;
const MAX_NOTE_LENGTH = 240;

export class MemoryStore {
	constructor(file, { now = Date.now } = {}) {
		this.file = file;
		this.now = now;
		this.data = { users: {} };
		this.pending = Promise.resolve();
	}

	async load() {
		try {
			const parsed = JSON.parse(await readFile(this.file, 'utf8'));
			if (parsed && typeof parsed.users === 'object' && parsed.users) this.data = { users: parsed.users };
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
		return this;
	}

	_user(userId, name = null) {
		const id = String(userId);
		if (!this.data.users[id]) this.data.users[id] = { name: name ?? null, notes: [] };
		else if (name && !this.data.users[id].name) this.data.users[id].name = name;
		return this.data.users[id];
	}

	notesFor(userId) {
		return [...(this.data.users[String(userId)]?.notes ?? [])];
	}

	nameFor(userId) {
		return this.data.users[String(userId)]?.name ?? null;
	}

	/** Adds a note; the same text is not stored twice. */
	async add(userId, text, { by = null, name = null } = {}) {
		const note = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH);
		if (!note) return null;
		const user = this._user(userId, name);
		const key = normalize(note);
		const existing = user.notes.find((entry) => normalize(entry.text) === key);
		if (existing) return existing;
		const entry = { text: note, at: this.now(), by: by ?? null };
		user.notes.push(entry);
		if (user.notes.length > MAX_NOTES_PER_USER) user.notes.splice(0, user.notes.length - MAX_NOTES_PER_USER);
		await this.save();
		return entry;
	}

	/** Deletes the note that contains the text, or the one at the given position (1-based). */
	async remove(userId, needle) {
		const user = this.data.users[String(userId)];
		if (!user) return false;
		let index = -1;
		if (Number.isInteger(needle)) index = needle - 1;
		else {
			const key = normalize(needle);
			index = key ? user.notes.findIndex((entry) => normalize(entry.text).includes(key)) : -1;
		}
		if (index < 0 || index >= user.notes.length) return false;
		user.notes.splice(index, 1);
		await this.save();
		return true;
	}

	async clear(userId) {
		const id = String(userId);
		if (!this.data.users[id]) return false;
		delete this.data.users[id];
		await this.save();
		return true;
	}

	/** Short summary handed to the model (newest notes first). */
	summaryFor(userId, { max = 6 } = {}) {
		const notes = this.notesFor(userId);
		if (!notes.length) return null;
		const picked = notes.slice(-max).reverse();
		return picked.map((entry) => `- ${entry.text}`).join('\n');
	}

	/**
	 * Searches every note of every person. Without a query it returns the most recent notes, so
	 * "look in your memory" has something to answer with instead of a bare "nothing found".
	 * `userId` keeps the search to one person's notes: somebody who is not the owner may only look
	 * through what is kept about themselves, and filtering after the limit would leave them with
	 * whatever of theirs happened to survive among everybody else's.
	 * @returns {Array<{ id: string, name: string|null, text: string, at: number }>}
	 */
	search(query = '', { limit = 12, userId = null } = {}) {
		const needle = normalize(String(query ?? '').replace(/['’"“”]/gu, ' '));
		// Two-letter words are ordinary words in Turkish ("ev", "su"), so they are kept: the length limit
		// below applies to PREFIX matching only, not to matching a whole word.
		const words = needle.split(' ').filter(Boolean);
		const hits = [];
		const only = userId === null || userId === undefined ? null : String(userId);
		for (const [id, user] of Object.entries(this.data.users)) {
			if (only !== null && id !== only) continue;
			for (const note of user.notes ?? []) {
				// Quotes become spaces first: normalize() strips a short apostrophe suffix (for "Ali'ye" -> "ali"),
				// which would otherwise swallow a quoted keyword such as 'muz' out of the note.
				const haystack = normalize(`${note.text} ${user.name ?? ''}`.replace(/['’"“”]/gu, ' '));
				// Whole words, not raw substrings: searching for "muz" must not match "sunucumuzda".
				const tokens = haystack.split(' ').filter(Boolean);
				const matches = (word) => tokens.some((token) => token === word || (word.length >= 4 && token.startsWith(word)));
				// The phrase bonus compares against the padded haystack so a match at the very end counts too.
				const padded = ` ${tokens.join(' ')} `;
				const score = !needle ? 0 : words.filter(matches).length + (padded.includes(` ${needle} `) ? 2 : 0);
				if (needle && score === 0) continue;
				hits.push({ id, name: user.name ?? null, text: note.text, at: note.at ?? 0, score });
			}
		}
		hits.sort((a, b) => b.score - a.score || b.at - a.at);
		return hits.slice(0, limit).map((hit) => ({ id: hit.id, name: hit.name, text: hit.text, at: hit.at }));
	}

	stats() {
		const users = Object.keys(this.data.users).length;
		const notes = Object.values(this.data.users).reduce((sum, user) => sum + user.notes.length, 0);
		return { users, notes };
	}

	save() {
		this.pending = this.pending
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				const tmp = `${this.file}.${process.pid}.tmp`;
				await writeFile(tmp, `${JSON.stringify(this.data, null, '\t')}\n`, 'utf8');
				await rename(tmp, this.file);
			})
			.catch(() => {});
		return this.pending;
	}
}
