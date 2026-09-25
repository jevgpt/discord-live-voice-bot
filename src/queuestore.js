// Music queues that outlive the process: one entry per server, read back when that server's session
// starts (GuildSession.restoreMusicQueue), so a restart or a crash does not throw away what people had
// lined up. A plain JSON file under data/ with the same serialised tmp+rename write as the other stores.
//
// Schema: { guilds: { [guildId]: { savedAt, volume, loop, current: track|null, queue: [track] } } }
//   track: { kind: 'url'|'file', url, title, uploader, duration, position? }
//
// The entries are exactly what MusicPlayer.snapshot() hands over, and they are not trusted on the way
// back: MusicPlayer.restore() checks every track again (an allowed media link, a file still inside
// MUSIC_DIR, a length still under the limit) before any of it reaches yt-dlp or ffmpeg.

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { t } from './i18n/index.js';

export class QueueStore {
	constructor(file, { log = null, now = Date.now } = {}) {
		this.file = file;
		this.log = log;
		this.now = now;
		this.guilds = new Map();
		this.pending = Promise.resolve();
		this.queued = null;
	}

	async load() {
		let raw = null;
		try {
			raw = await readFile(this.file, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
		if (raw === null) return this;
		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			// A queue is not worth refusing to start over; the broken file is kept beside it for a look.
			const backup = `${this.file}.${t('store.backup_suffix')}-${Date.now()}.json`;
			await copyFile(this.file, backup).catch(() => {});
			this.log?.(t('store.load_failed', { error: err.message, backup }));
		}
		const guilds = parsed?.guilds;
		if (guilds && typeof guilds === 'object' && !Array.isArray(guilds)) {
			for (const [guildId, entry] of Object.entries(guilds)) {
				if (entry && typeof entry === 'object' && !Array.isArray(entry)) this.guilds.set(String(guildId), entry);
			}
		}
		return this;
	}

	/** One server's saved queue, as a copy; null when there is none. */
	get(guildId) {
		const entry = this.guilds.get(String(guildId ?? ''));
		return entry ? structuredClone(entry) : null;
	}

	/** Replaces one server's entry in memory; save() writes it. */
	put(guildId, snapshot) {
		if (!guildId || !snapshot) return;
		this.guilds.set(String(guildId), { ...structuredClone(snapshot), savedAt: this.now() });
	}

	/**
	 * Writes the file. Serialised like the other stores, and coalesced: the player reports every change
	 * (a queue of fifty saved tracks is fifty of them), and while one write is running every further
	 * request joins the single write queued behind it, which takes its snapshot when it starts.
	 */
	save() {
		if (this.queued) return this.queued;
		const run = this.pending.then(async () => {
			this.queued = null;
			const snapshot = `${JSON.stringify({ guilds: Object.fromEntries(this.guilds) }, null, '\t')}\n`;
			await mkdir(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			await writeFile(tmp, snapshot, 'utf8');
			await rename(tmp, this.file);
		});
		this.queued = run;
		this.pending = run.catch(() => {});
		return run;
	}

	/** Resolves once every write asked for so far is on disk (or has failed); shutdown waits on it. */
	flush() {
		return this.pending;
	}
}
