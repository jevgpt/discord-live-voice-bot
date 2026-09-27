// Persistent character (persona) store. Plain JSON file + atomic, SERIALISED writes.
// Schema: { activeId: string|null, characters: [{ id, name, prompt, voice, createdAt, updatedAt }] }

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { t } from './i18n/index.js';

const MAX_NAME = 80;
// A persona can be long; this is a guard against a runaway paste, not a style limit. The /panel modal
// takes 12,000 of it (three fields), data/characters.json the rest.
const MAX_PROMPT = 32_000;
const MAX_VOICE = 40;

export class CharacterStore {
	constructor(file, { log = null } = {}) {
		this.file = file;
		this.log = log;
		this.data = { activeId: null, characters: [] };
		this.pending = Promise.resolve();
		this.dropped = 0;
	}

	async load() {
		let raw = null;
		try {
			raw = await readFile(this.file, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
		if (raw !== null) {
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (err) {
				// Corrupt file: keep a backup, carry on with an empty schema; the bot must still start up.
				const backup = `${this.file}.${t('store.backup_suffix')}-${Date.now()}.json`;
				await copyFile(this.file, backup).catch(() => {});
				this.log?.(t('store.load_failed', { error: err.message, backup }));
				parsed = null;
			}
			if (parsed && Array.isArray(parsed.characters)) {
				const valid = parsed.characters.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string');
				this.dropped = parsed.characters.length - valid.length;
				if (this.dropped > 0) this.log?.(t('store.dropped_entries', { count: this.dropped }));
				this.data = {
					activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
					characters: valid.map((c) => ({
						id: c.id,
						name: c.name,
						prompt: typeof c.prompt === 'string' ? c.prompt : '',
						voice: typeof c.voice === 'string' && c.voice ? c.voice : null,
						createdAt: Number.isFinite(c.createdAt) ? c.createdAt : Date.now(),
						updatedAt: Number.isFinite(c.updatedAt) ? c.updatedAt : null,
					})),
				};
			}
		}
		if (!this.get(this.data.activeId)) this.data.activeId = this.data.characters[0]?.id ?? null;
		return this;
	}

	list() {
		return this.data.characters.map((c) => ({ ...c }));
	}

	get(id) {
		const found = this.data.characters.find((c) => c.id === id);
		return found ? { ...found } : null;
	}

	getActive() {
		return this.get(this.data.activeId);
	}

	static validate({ name, prompt, voice }, { voices = null } = {}) {
		const cleanName = String(name ?? '').trim().slice(0, MAX_NAME);
		if (!cleanName) throw new Error(t('store.name_required'));
		const cleanVoice = voice ? String(voice).trim().toLowerCase().slice(0, MAX_VOICE) : null;
		if (cleanVoice && voices && !voices.includes(cleanVoice)) throw new Error(t('store.unknown_voice', { voice: cleanVoice }));
		return { name: cleanName, prompt: String(prompt ?? '').slice(0, MAX_PROMPT), voice: cleanVoice };
	}

	async create({ name, prompt = '', voice = null }, options = {}) {
		const clean = CharacterStore.validate({ name, prompt, voice }, options);
		const character = { id: randomUUID(), ...clean, createdAt: Date.now(), updatedAt: null };
		this.data.characters.push(character);
		if (!this.data.activeId) this.data.activeId = character.id;
		await this.save();
		return { ...character };
	}

	async update(id, patch, options = {}) {
		const character = this.data.characters.find((c) => c.id === id);
		if (!character) return null;
		const merged = CharacterStore.validate(
			{
				name: patch.name !== undefined ? patch.name : character.name,
				prompt: patch.prompt !== undefined ? patch.prompt : character.prompt,
				voice: patch.voice !== undefined ? patch.voice : character.voice,
			},
			options,
		);
		Object.assign(character, merged, { updatedAt: Date.now() });
		await this.save();
		return { ...character };
	}

	async remove(id) {
		const before = this.data.characters.length;
		this.data.characters = this.data.characters.filter((c) => c.id !== id);
		if (this.data.characters.length === before) return false;
		if (this.data.activeId === id) this.data.activeId = this.data.characters[0]?.id ?? null;
		await this.save();
		return true;
	}

	async setActive(id) {
		if (!this.get(id)) return false;
		this.data.activeId = id;
		await this.save();
		return true;
	}

	/** Writes are queued: two saves never collide on the same .tmp file. */
	save() {
		const snapshot = `${JSON.stringify(this.data, null, '\t')}\n`;
		const run = this.pending.then(async () => {
			await mkdir(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			await writeFile(tmp, snapshot, 'utf8');
			await rename(tmp, this.file);
		});
		this.pending = run.catch(() => {});
		return run;
	}
}
