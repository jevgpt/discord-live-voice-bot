// The settings the owner can change while the bot runs (applySetting), the owner's silence behind
// "quiet" (setSilenced), and the idle watch that idle_close_minutes arms (armIdleTimer).
//
// Writes: silenced, and this guild's cfg view (transcripts, announceSpeaker, ownerPriority,
// idleCloseMs, brainMode); for `record` only, the shared cfg.
// Shared: idleTimer is armed and cleared here and cleared by stop() as well.
// Reads only: brain and localMode (localvoice.js), live, paused (livelink.js), shuttingDown, sharedCfg.
// Drives the mixer's priority, the idle governor, playback (clear), the local brain and the live link.

import { t, tList } from '../i18n/index.js';
import { normalize, parseBool } from '../text.js';
import { SETTING_ALIASES } from './constants.js';

export const settingsMethods = {
	/**
	 * The settings the owner is allowed to change (in memory; a restart brings the .env values back).
	 * Returns: the new value, null (unknown setting) or { ok:false, spoken } (could not be applied).
	 *
	 * They apply to this server only: `cfg` is this guild's own view of the configuration (see the
	 * constructor), so writing to it leaves the other servers as they were. `record` is the exception, on
	 * purpose: RECORD_TRANSCRIPTS decides what the one activity log shared by every server writes to disk,
	 * and a log cannot keep one server's transcripts private while writing another's.
	 */
	async applySetting(name, value) {
		const cfg = this.cfg;
		const alias = normalize(String(name ?? '')).replace(/ /g, '_');
		const key = SETTING_ALIASES[alias] ?? alias;
		const asBool = (input, fallback) => parseBool(input, fallback);
		switch (key) {
			case 'quiet':
			case 'silence': {
				const quiet = asBool(value, !this.silenced);
				this.setSilenced(quiet);
				return { value: quiet, spoken: t(quiet ? 'runtime.quiet_on_spoken' : 'runtime.quiet_off_spoken') };
			}
			case 'transcripts':
				cfg.transcripts = asBool(value, cfg.transcripts);
				return cfg.transcripts;
			case 'announce_speaker':
				cfg.announceSpeaker = asBool(value, cfg.announceSpeaker);
				return cfg.announceSpeaker;
			case 'owner_priority':
				cfg.ownerPriority = asBool(value, cfg.ownerPriority);
				this.mixer.setPriority(cfg.ownerPriority ? cfg.ownerId : null);
				return cfg.ownerPriority;
			case 'idle_close_minutes':
				cfg.idleCloseMs = Math.max(0, Number(value) || 0) * 60_000;
				this.idle.idleMs = cfg.idleCloseMs;
				// The wait is counted from the change, not from whenever somebody last spoke.
				this.idle.touch();
				// Turned on from 0 at runtime there was no timer to act on it: start() only made one when the
				// value was set at boot.
				this.armIdleTimer();
				return Math.round(cfg.idleCloseMs / 60_000);
			case 'record': {
				const shared = this.sharedCfg;
				shared.recordTranscripts = asBool(value, shared.recordTranscripts);
				this.activity.push({ kind: 'session', text: shared.recordTranscripts ? t('runtime.record_on') : t('runtime.record_off') });
				return shared.recordTranscripts;
			}
			case 'local_tts': {
				if (this.brain === 'local') return { ok: false, spoken: t('runtime.local_brain_busy') };
				const enabled = asBool(value, !this.localMode);
				const result = await this.setLocalMode(enabled);
				return result.ok ? result.value : { ok: false, spoken: result.reason };
			}
			case 'brain': {
				const raw = normalize(String(value ?? ''));
				const wanted = tList('runtime.brain_local_words').includes(raw)
					? 'local'
					: tList('runtime.brain_live_words').includes(raw)
						? 'live'
						: tList('runtime.brain_auto_words').includes(raw)
							? 'auto'
							: null;
				if (!wanted) return { ok: false, spoken: t('runtime.brain_setting_help') };
				cfg.brainMode = wanted;
				if (wanted === 'local') {
					const ok = await this.enterLocalBrain(t('runtime.reason_setting'));
					if (!ok) return { ok: false, spoken: t('runtime.brain_local_failed') };
					this.pauseLive(t('runtime.reason_local_brain_selected'));
					return t('runtime.brain_value_local');
				}
				this.exitLocalBrain(wanted === 'auto' ? t('runtime.reason_auto_mode') : t('runtime.reason_live_selected'));
				if (!this.live) this.resumeLive();
				return wanted === 'auto' ? t('runtime.brain_value_auto') : t('runtime.brain_value_live');
			}
			default:
				return null;
		}
	},

	/**
	 * The idle watch: while idle_close_minutes is above zero, a session nobody has spoken to for that long is
	 * closed. Called at start and whenever the setting changes, so turning it on at runtime takes effect and
	 * turning it off stops the watch.
	 */
	armIdleTimer() {
		if (!(this.cfg.idleCloseMs > 0) || this.shuttingDown) {
			if (this.idleTimer) clearInterval(this.idleTimer);
			this.idleTimer = null;
			return;
		}
		if (this.idleTimer) return;
		this.idleTimer = setInterval(() => {
			if (this.paused || !this.idle.shouldPause(Boolean(this.live))) return;
			this.log(t('runtime.idle_close'));
			this.pauseLive(t('runtime.reason_idle'));
		}, 30_000);
		this.idleTimer.unref?.();
	},

	/**
	 * Owner's silence. While it is on the bot listens and still runs tools, it just does not speak; the
	 * model carrying the conversation is told so that it stops trying -- the live session through a
	 * context note, the local brain through its history -- and the audio is dropped anyway if it does.
	 */
	setSilenced(quiet) {
		const next = quiet !== false;
		if (next === this.silenced) return this.silenced;
		this.silenced = next;
		if (next) this.playback.clear();
		this.log(t(next ? 'runtime.silenced_on' : 'runtime.silenced_off'));
		this.activity.push({ kind: 'session', text: t(next ? 'runtime.silenced_on' : 'runtime.silenced_off') });
		const note = t(next ? 'runtime.silenced_note_on' : 'runtime.silenced_note_off');
		this.live?.appendContext('instructions', note);
		if (this.brain === 'local') this.localBrain.note(note);
		return this.silenced;
	},
};
