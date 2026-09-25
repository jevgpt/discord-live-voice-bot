// Daily GPT-Live quota (in seconds). Session time is fed in from the 'usage' event; once the quota is
// used up the guild's session is closed and not reopened until the day rolls over. It is written to
// data/quota.json so that a restart does not reset the quota.
//
// One quota is shared by every server, while each realtime session reports its OWN running total. The
// running total therefore belongs to the session that reports it (GuildSession keeps a SessionUsage, below,
// per LiveSession) and only the difference reaches this class, through add(). A base kept here, for all
// sessions at once, was reset by every server's new session and read against every other server's
// totals: two servers taking turns counted 1,500 s of use as 18,600.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export class DailyQuota {
	constructor({ limitSeconds = 0, file = null, now = Date.now } = {}) {
		this.limitSeconds = Math.max(0, Number(limitSeconds) || 0);
		this.file = file;
		this.now = now;
		this.day = dayKey(now());
		this.usedSeconds = 0;
		this.pending = Promise.resolve();
		this.warnedAt = null;
	}

	async load() {
		if (!this.file) return this;
		try {
			const parsed = JSON.parse(await readFile(this.file, 'utf8'));
			if (parsed?.day === this.day && Number.isFinite(parsed.usedSeconds)) this.usedSeconds = parsed.usedSeconds;
		} catch {
			/* no file: start from zero */
		}
		return this;
	}

	get enabled() {
		return this.limitSeconds > 0;
	}

	/**
	 * A new day starts from zero. Only the count is reset: what a session used before midnight stays on
	 * yesterday, because the next add() carries only the seconds since its previous report.
	 */
	_rollover() {
		const today = dayKey(this.now());
		if (today !== this.day) {
			this.day = today;
			this.usedSeconds = 0;
			this.warnedAt = null;
		}
	}

	/**
	 * Seconds of realtime session time that have not been counted yet (a difference, never a running total).
	 * @returns {{ used: number, limit: number, exceeded: boolean, remaining: number }}
	 */
	add(seconds) {
		this._rollover();
		const delta = Math.max(0, Number(seconds) || 0);
		this.usedSeconds += delta;
		if (delta > 0) void this.save();
		return this.status();
	}

	status() {
		this._rollover();
		const remaining = this.enabled ? Math.max(0, this.limitSeconds - this.usedSeconds) : Infinity;
		return {
			day: this.day,
			used: Math.round(this.usedSeconds),
			limit: this.limitSeconds,
			remaining,
			exceeded: this.enabled && this.usedSeconds >= this.limitSeconds,
		};
	}

	/** True when 90% of the quota has been passed and no warning was issued yet (one-shot). */
	shouldWarn() {
		if (!this.enabled || this.warnedAt) return false;
		if (this.usedSeconds < this.limitSeconds * 0.9) return false;
		this.warnedAt = this.now();
		return true;
	}

	save() {
		if (!this.file) return Promise.resolve();
		const snapshot = { day: this.day, usedSeconds: Math.round(this.usedSeconds) };
		this.pending = this.pending
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				const tmp = `${this.file}.${process.pid}.tmp`;
				await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
				await rename(tmp, this.file);
			})
			.catch(() => {});
		return this.pending;
	}
}

/**
 * One realtime session's running total, turned into the differences the shared quota takes. The server
 * reports the seconds the session has used so far; a report that repeats or goes back adds nothing.
 */
export class SessionUsage {
	constructor(quota) {
		this.quota = quota;
		this.seconds = 0;
	}

	/** @returns {{ delta: number, status: object }} what this report added and the quota after it */
	report(totalSeconds) {
		const total = Math.max(0, Number(totalSeconds) || 0);
		const delta = Math.max(0, total - this.seconds);
		this.seconds = Math.max(this.seconds, total);
		return { delta, status: delta > 0 ? this.quota.add(delta) : this.quota.status() };
	}
}
