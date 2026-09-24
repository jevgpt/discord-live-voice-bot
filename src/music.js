// The bot's own music player: yt-dlp (search/download) + ffmpeg (decoding to 48 kHz stereo s16le).
//
// Flow:  yt-dlp -o - <url>  --stdout-->  ffmpeg -i pipe:0 -f s16le -ar 48000 -ac 2  --stdout--> Ring
// The bridge pulls one frame (960 stereo samples) every 20 ms and mixes it into the bot's voice; while
// the bot speaks the music is ducked (turned down) and, after a short hold once it falls silent, rises
// back to its previous level.
//
// Local files (MUSIC_DIR) are played straight through ffmpeg, without yt-dlp.
//
// Seeking restarts that pipeline with ffmpeg's -ss (see decoderArgs), and the position in the track is
// counted from the frames the bridge actually took, so it stands still while the music is paused.
// The queue, the loop mode and the volume can be saved between runs (snapshot/restore, src/queuestore.js);
// a restored queue waits, paused, until somebody asks for music.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ring, STEREO_SAMPLES_PER_FRAME_48K } from './audio.js';
import { cleanEnvValue } from './config.js';
import { t } from './i18n/index.js';
import { formatClock, normalize, parseClock } from './text.js';
import { downloadYtDlp } from './ytdlp.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const RATE = 48_000;
const CHANNELS = 2;
const RING_SECONDS = 8; // decoded audio buffer
const HIGH_WATER = RATE * CHANNELS * 6; // ffmpeg pause threshold (6 s)
const LOW_WATER = RATE * CHANNELS * 3; // resume threshold (3 s)
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.flac', '.aac', '.webm', '.mp4', '.mkv']);

/**
 * Gain envelope that turns the music down while someone speaks. Called once per tick (20 ms) and
 * deterministic (it never reads the clock).
 *  - speaking=true  -> drops quickly to the duck level (attack)
 *  - speaking=false -> waits holdTicks, then climbs slowly back to the normal level (release)
 */
export class Ducker {
	constructor({ duck = 0.12, holdMs = 700, frameMs = 20, attack = 0.35, release = 0.05 } = {}) {
		this.duck = duck;
		this.holdTicks = Math.max(0, Math.round(holdMs / frameMs));
		this.attack = attack;
		this.release = release;
		this.gain = 1;
		this.sinceSpeech = Infinity;
	}

	tick(speaking) {
		if (speaking) this.sinceSpeech = 0;
		else if (this.sinceSpeech !== Infinity) this.sinceSpeech++;
		const target = speaking || this.sinceSpeech < this.holdTicks ? this.duck : 1;
		const rate = target < this.gain ? this.attack : this.release;
		this.gain += (target - this.gain) * rate;
		if (Math.abs(this.gain - target) < 0.002) this.gain = target;
		return this.gain;
	}

	reset() {
		this.gain = 1;
		this.sinceSpeech = Infinity;
	}
}

/** ffmpeg binary: FFMPEG_PATH -> ffmpeg-static -> "ffmpeg" from PATH. */
export function resolveFfmpeg(preferred = null) {
	if (preferred && existsSync(preferred)) return preferred;
	try {
		const bundled = require('ffmpeg-static');
		if (bundled && existsSync(bundled)) return bundled;
	} catch {
		/* package not installed */
	}
	return 'ffmpeg';
}

// Hosts a spoken "play X" link may point at. The query comes from whoever is speaking, and yt-dlp would
// happily fetch an address on the owner's own network, so anything else is treated as search text.
const MEDIA_HOSTS = [
	'youtube.com',
	'youtu.be',
	'soundcloud.com',
	'bandcamp.com',
	'vimeo.com',
	'twitch.tv',
	'spotify.com',
	'mixcloud.com',
	'audius.co',
	'archive.org',
	'dailymotion.com',
];

// Failure reasons the caller turns into spoken text; they are matched, not shown raw.
export const UNSUPPORTED_LINK = 'unsupported-link';
export const QUEUE_FULL = 'queue-full';
export const YTDLP_MISSING = 'ytdlp-missing';
export const SEEK_PAST_END = 'seek-past-end';

// "track" plays the current track again when it ends; "queue" sends every finished track to the back of
// the queue, so the whole list comes round again.
export const LOOP_MODES = Object.freeze(['off', 'track', 'queue']);

const isUrl = (text) => /^https?:\/\//i.test(String(text ?? '').trim());

/** Where a downloaded yt-dlp lives when nothing else points at one. */
export const DEFAULT_YTDLP_DIR = path.join(here, '..', 'tools', 'bin');

/** Can an account other than the owner write this file? Always false on Windows, which has no such bits. */
async function writableByOthers(file) {
	if (process.platform === 'win32') return false;
	try {
		return ((await stat(file)).mode & 0o022) !== 0;
	} catch {
		return false;
	}
}

/**
 * Finds yt-dlp: the configured path, then tools/bin, then PATH. With autoDownload off it says what to
 * install instead of fetching anything; when it is on, the binary comes from the GitHub release that
 * `version` names (YTDLP_VERSION, the newest when empty) and is checked against that release's SHA-256
 * list before it is used. Shared by the music player and the video reader, so both find the same one.
 */
export async function ensureYtDlpPath({
	preferred = null,
	binDir = DEFAULT_YTDLP_DIR,
	autoDownload = true,
	// Read here rather than handed down: the player and the video reader are built in different places,
	// and both must fetch the same pinned release.
	version = cleanEnvValue(process.env.YTDLP_VERSION) || null,
	log = () => {},
	spawnImpl = spawn,
	fetchImpl = globalThis.fetch,
} = {}) {
	const downloaded = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
	const candidates = [preferred, downloaded].filter(Boolean);
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		// Earlier versions downloaded into tools/bin with mode 777, so any account on the machine could have
		// swapped that file. It is fetched again, checked, when downloading is allowed; otherwise it is at
		// least closed to further changes and the log says how to replace it.
		if (candidate === downloaded && (await writableByOthers(candidate))) {
			if (autoDownload) {
				log(t('music.log_ytdlp_replacing', { target: candidate }));
				await downloadYtDlp(candidate, { version, log, fetchImpl });
			} else {
				await chmod(candidate, 0o755).catch(() => {});
				log(t('music.log_ytdlp_tightened', { target: candidate }));
			}
		}
		return candidate;
	}
	if (await onPath('yt-dlp', spawnImpl)) return 'yt-dlp';
	if (!autoDownload) throw new Error(YTDLP_MISSING);
	log(t('music.log_ytdlp_download', { target: downloaded }));
	await downloadYtDlp(downloaded, { version, log, fetchImpl });
	return downloaded;
}

/** Is this binary runnable? `--version` is the whole test. */
function onPath(binary, spawnImpl) {
	return new Promise((resolve) => {
		try {
			const child = spawnImpl(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
			child.once('error', () => resolve(false));
			child.once('exit', (code) => resolve(code === 0));
		} catch {
			resolve(false);
		}
	});
}

/**
 * Runs a command and collects its output; the caller decides what a failure means. `reason` tells a
 * timeout from a spawn failure from a non-zero exit, so each caller can word the answer its own way.
 * Shared by the music player's lookups and the video reader.
 */
export function runCommand(binary, args, { timeoutMs = 30_000, spawnImpl = spawn } = {}) {
	return new Promise((resolve, reject) => {
		let out = '';
		let err = '';
		const child = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			reject(Object.assign(new Error('timed out'), { reason: 'timeout' }));
		}, timeoutMs);
		child.stdout?.on('data', (chunk) => (out += chunk));
		child.stderr?.on('data', (chunk) => (err += chunk));
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(Object.assign(new Error(error.message), { reason: 'spawn' }));
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(out);
				return;
			}
			const detail = (err.trim().split('\n').pop() ?? '').replace(/^ERROR:\s*/u, '');
			reject(Object.assign(new Error(detail || `exit ${code}`), { reason: 'exit', code }));
		});
	});
}

/**
 * yt-dlp's arguments for one call. yt-dlp reads yt-dlp.conf from its working directory, from beside its
 * binary and from the user's configuration directory, and any of those files can add options to every
 * run (an --exec, a proxy, another output path); the bot's calls are complete as written, so none is read.
 * "--" ends the options, so the one positional argument is never taken for an option whatever it starts with.
 */
export function ytDlpArgs(options, target) {
	return ['--ignore-config', ...options, '--', target];
}

/** A link we are willing to hand to yt-dlp. */
export function isAllowedMediaUrl(text) {
	let url;
	try {
		url = new URL(String(text ?? '').trim());
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	const host = url.hostname.toLowerCase().replace(/^www\./u, '');
	return MEDIA_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
const formatDuration = (seconds) => {
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * What a seek request asks for: { to } for a place in the track ("1:30", "90", 90), { by } for a step
 * from where it is now ("+30", "-10"). null when it is neither.
 */
export function parseSeekTarget(value) {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return null;
		return value < 0 ? { by: value } : { to: value };
	}
	const text = String(value ?? '').trim();
	const sign = /^[+-]/u.exec(text)?.[0] ?? null;
	const seconds = parseClock(sign ? text.slice(1).trim() : text);
	if (seconds === null) return null;
	if (!sign) return { to: seconds };
	return { by: sign === '-' ? -seconds : seconds };
}

/**
 * ffmpeg's arguments for one track, started `from` seconds in.
 *
 * A file can be sought, so -ss goes in front of -i and ffmpeg jumps straight to the place. yt-dlp's pipe
 * cannot: in front of it -ss would ask ffmpeg to seek a stream that has no way back, so for a link it goes
 * AFTER -i, where ffmpeg decodes from the start and drops everything before `from`. A far jump costs the
 * download up to that point, but it asks nothing of yt-dlp, whose call stays exactly as ytDlpArgs builds it.
 */
export function decoderArgs(track, from = 0) {
	const at = from > 0 ? ['-ss', (Math.round(from * 1000) / 1000).toFixed(3)] : [];
	const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
	if (track.kind === 'file') args.push(...at, '-i', track.url);
	else args.push('-i', 'pipe:0', ...at);
	args.push('-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1');
	return args;
}

export class MusicPlayer {
	constructor({
		ffmpegPath = null,
		ytDlpPath = null,
		musicDir = null,
		volume = 0.35,
		duckVolume = 0.12,
		maxMinutes = 20,
		maxQueue = 50,
		autoDownload = true,
		binDir = path.join(here, '..', 'tools', 'bin'),
		log = () => {},
		onTrackStart = null,
		onTrackEnd = null,
		onError = null,
		// Told after anything that the saved queue would have to reflect (src/queuestore.js).
		onChange = null,
		// The shuffle's dice; a test hands in its own so the order it expects is the order it gets.
		random = Math.random,
		spawnImpl = spawn,
	} = {}) {
		this.ffmpeg = resolveFfmpeg(ffmpegPath);
		this.ytDlpPreferred = ytDlpPath;
		this.ytDlp = null;
		this.binDir = binDir;
		this.musicDir = musicDir;
		this.volume = Math.max(0, Math.min(1, volume));
		this.duckVolume = Math.max(0, Math.min(1, duckVolume));
		this.maxMinutes = maxMinutes;
		// A queue nobody can cap is a way for one speaker to keep the machine busy indefinitely.
		this.maxQueue = Math.max(1, maxQueue);
		this.autoDownload = autoDownload !== false;
		this.log = log;
		this.onTrackStart = onTrackStart;
		this.onTrackEnd = onTrackEnd;
		this.onError = onError;
		this.onChange = onChange;
		this.random = random;
		this.spawn = spawnImpl;

		this.ring = new Ring(RATE * CHANNELS * RING_SECONDS);
		this.queue = [];
		this.current = null;
		this.paused = false;
		this.procs = null; // { ytdlp, ffmpeg }
		this.decodeDone = false;
		this.stopping = false;
		this.leftover = null;
		this.seq = 0;
		this.history = [];
		this.loop = 'off';
		// Where the current track is: the place its decoder was started from, plus every sample the bridge
		// has read since. Counting what was read, rather than the clock, is what keeps a pause, a stalled
		// download and a seek from moving the number on their own.
		this.offsetSeconds = 0;
		this.samplesRead = 0;
	}

	/** The only flag the bridge has to look at: is a track playing/decoding? */
	get active() {
		return Boolean(this.current);
	}

	get playing() {
		return Boolean(this.current) && !this.paused;
	}

	/**
	 * A current track with no decoder behind it: a restored queue waiting for somebody to ask for music.
	 * Everywhere else a current track has its processes (startNext and seek start them together).
	 */
	get parked() {
		return Boolean(this.current) && !this.procs;
	}

	/** Seconds into the current track (see offsetSeconds); 0 when nothing is playing. */
	get elapsed() {
		if (!this.current) return 0;
		return this.offsetSeconds + this.samplesRead / (RATE * CHANNELS);
	}

	/** Tells the saved queue something changed. Never allowed to break playback: it runs inside the bridge tick too. */
	_changed() {
		try {
			this.onChange?.();
		} catch (err) {
			this.log(t('music.log_queue_save_failed', { error: err.message }));
		}
	}

	/** How far the music drops while the bot speaks (absolute duckVolume / current volume). */
	get duckRatio() {
		if (this.volume <= 0) return 1;
		return Math.max(0, Math.min(1, this.duckVolume / this.volume));
	}

	// ---------------------------------------------------------------- yt-dlp

	/** Finds the yt-dlp path; if there is none, downloads it into tools/bin (once). */
	async ensureYtDlp() {
		if (this.ytDlp) return this.ytDlp;
		// Fetching a binary and running it is a supply-chain decision, so it is the operator's to make:
		// with autoDownload off we say what to install instead of doing it silently.
		this.ytDlp = await ensureYtDlpPath({
			preferred: this.ytDlpPreferred,
			binDir: this.binDir,
			autoDownload: this.autoDownload,
			log: this.log,
			spawnImpl: this.spawn,
		});
		return this.ytDlp;
	}

	/** Resolves text into track info: a local file, a URL or a YouTube search. */
	async resolve(query) {
		const text = String(query ?? '').trim();
		if (!text) throw new Error(t('music.error_empty_query'));

		const local = this.findLocal(text);
		if (local) return local;

		// Checked before yt-dlp is looked for, so a link that is refused anyway never starts a download.
		if (isUrl(text) && !isAllowedMediaUrl(text)) throw new Error(UNSUPPORTED_LINK);
		const ytDlp = await this.ensureYtDlp();
		const target = isUrl(text) ? text : `ytsearch1:${text}`;
		const args = ytDlpArgs(['-j', '--no-playlist', '--no-warnings', '--default-search', 'ytsearch', '--skip-download'], target);
		const raw = await this._run(ytDlp, args, 30_000);
		const line = raw.split('\n').find((candidate) => candidate.trim().startsWith('{'));
		if (!line) throw new Error(t('music.error_no_results'));
		let info;
		try {
			info = JSON.parse(line);
		} catch {
			throw new Error(t('music.error_bad_output'));
		}
		const url = info.webpage_url ?? info.original_url ?? info.url;
		if (!url) throw new Error(t('music.error_no_url'));
		// The page that gets played is the one yt-dlp answered with, not the text it was given: a search
		// result, or wherever an allowed link redirected to. It is held to the same hosts as a spoken link.
		if (!isAllowedMediaUrl(url)) throw new Error(UNSUPPORTED_LINK);
		const duration = Number(info.duration) || null;
		if (this.maxMinutes > 0 && duration && duration > this.maxMinutes * 60) {
			throw new Error(t('music.error_too_long', { duration: formatDuration(duration), minutes: this.maxMinutes }));
		}
		return {
			kind: 'url',
			url,
			title: info.title ?? text,
			uploader: info.uploader ?? info.channel ?? null,
			duration,
			query: text,
		};
	}

	/** A file inside MUSIC_DIR whose name matches (fuzzy: normalize + contains). */
	findLocal(query) {
		if (!this.musicDir || !existsSync(this.musicDir)) return null;
		const needle = normalize(query);
		if (!needle) return null;
		let files = [];
		try {
			files = readdirSync(this.musicDir).filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()));
		} catch {
			return null;
		}
		const keyed = files.map((name) => ({ name, key: normalize(path.parse(name).name) }));
		const hit =
			keyed.find((entry) => entry.key === needle) ??
			keyed.find((entry) => entry.key.includes(needle)) ??
			keyed.find((entry) => needle.includes(entry.key) && entry.key.length > 3);
		if (!hit) return null;
		const full = path.join(this.musicDir, hit.name);
		try {
			if (!statSync(full).isFile()) return null;
		} catch {
			return null;
		}
		return { kind: 'file', url: full, title: path.parse(hit.name).name, uploader: null, duration: null, query };
	}

	_run(binary, args, timeoutMs) {
		return runCommand(binary, args, { timeoutMs, spawnImpl: this.spawn }).catch((err) => {
			if (err.reason === 'timeout') throw new Error(t('music.error_search_timeout'));
			if (err.reason === 'spawn') {
				throw new Error(t('music.error_spawn_failed', { binary: path.basename(String(binary)), message: err.message }));
			}
			throw new Error(err.message || t('music.error_exit_code', { code: err.code }));
		});
	}

	// ---------------------------------------------------------------- queue

	/**
	 * Puts the track in the queue; starts playing straight away when nothing is playing. With `next` it goes
	 * to the front of the queue instead ("play X next").
	 */
	async enqueue(query, { requestedBy = null, next = false } = {}) {
		const track = await this.resolve(query);
		track.requestedBy = requestedBy;
		track.id = ++this.seq;
		// Already playing, or already waiting? Then this is the same request arriving twice, which is what
		// a model answering "sure, changing it" and then both skipping AND queueing produces. The song came
		// back round on its own when it finished, and from the outside it looked like the music would not
		// end. Saying so is more use than a second copy nobody asked for.
		const same = (other) => other && (other.url ? other.url === track.url : other.title === track.title);
		if (same(this.current)) return { track, position: this.queue.length, startedNow: false, duplicate: true };
		const waiting = this.queue.findIndex(same);
		if (waiting >= 0) {
			if (!next) return { track, position: this.queue.length, startedNow: false, duplicate: true };
			// "Play it next" about a track that is already waiting is a request to move it up, not a second copy.
			const [moved] = this.queue.splice(waiting, 1);
			this.queue.unshift(moved);
			this._changed();
			return { track: moved, position: 1, startedNow: false, moved: true };
		}
		if (this.queue.length >= this.maxQueue) throw new Error(QUEUE_FULL);
		if (this.parked) {
			// A restored queue waits for somebody to say "resume". A new request is somebody wanting music now:
			// it plays at once, and the track that was waiting keeps its place, and its position, right behind it.
			const held = this.current;
			held.startAt = this.elapsed;
			this.current = null;
			this.queue.unshift(track, held);
			this.startNext();
			return { track, position: 0, startedNow: true };
		}
		if (next) this.queue.unshift(track);
		else this.queue.push(track);
		if (!this.current) {
			this.startNext();
			return { track, position: 0, startedNow: true };
		}
		this._changed();
		return { track, position: next ? 1 : this.queue.length, startedNow: false };
	}

	/** `repeat` marks the same track starting over (loop "track"), so the listener can leave the announcement out. */
	startNext({ repeat = false } = {}) {
		this._killProcs();
		this.ring.clear();
		this.leftover = null;
		this.decodeDone = false;
		this.paused = false;
		this.offsetSeconds = 0;
		this.samplesRead = 0;
		const next = this.queue.shift();
		if (!next) {
			const ended = this.current;
			this.current = null;
			if (ended) this.onTrackEnd?.(ended, { queueEmpty: true });
			this._changed();
			return null;
		}
		// A track that was left part-way (a restored queue put back behind a new request) carries on where it was.
		const from = Math.max(0, Number(next.startAt) || 0);
		delete next.startAt;
		this.current = next;
		this.stopping = false;
		this.offsetSeconds = from;
		this._startPipeline(next, from);
		this.onTrackStart?.(next, { repeat });
		this.log(t('music.log_playing', { title: next.title, duration: next.duration ? ` (${formatDuration(next.duration)})` : '' }));
		this._changed();
		return next;
	}

	_startPipeline(track, from = 0) {
		if (track.restored && track.kind !== 'file' && !this.ytDlp) {
			// resolve() is what finds yt-dlp (the configured one, the checked download in tools/bin, PATH), and a
			// restored queue plays links that never went through it in this run. A bare "yt-dlp" here would be
			// whatever PATH holds, or nothing. The placeholder keeps the track from reading as parked meanwhile,
			// and a skip or a stop in between replaces it, which the checks below notice.
			const pending = { ytdlp: null, ffmpeg: null, track };
			this.procs = pending;
			this.ensureYtDlp().then(
				() => {
					if (this.procs === pending) this._startPipeline(track, from);
				},
				(err) => {
					if (this.procs === pending) this._fail(track, err.message);
				},
			);
			return;
		}
		const ffArgs = decoderArgs(track, from);
		let ytdlp = null;
		if (track.kind !== 'file') {
			ytdlp = this.spawn(
				this.ytDlp ?? 'yt-dlp',
				ytDlpArgs(['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--no-warnings', '-q'], track.url),
				{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
			);
			ytdlp.stderr.on('data', (chunk) => this.log(t('music.log_ytdlp', { message: String(chunk).trim().slice(0, 200) })));
			ytdlp.once('error', (err) => {
				// A yt-dlp of a track that has since been skipped or stopped can still report; failing on its
				// word would skip whatever is playing now.
				if (this.procs?.ytdlp !== ytdlp) return;
				this._fail(track, t('music.log_ytdlp', { message: err.message }));
			});
		}
		const ffmpeg = this.spawn(this.ffmpeg, ffArgs, {
			stdio: [ytdlp ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		if (ytdlp) {
			ytdlp.stdout.pipe(ffmpeg.stdin);
			ffmpeg.stdin.on('error', () => {}); // keeps EPIPE noise away when ffmpeg closes early
		}
		const procs = { ytdlp, ffmpeg, track };
		this.procs = procs;
		let gotData = false;
		ffmpeg.stdout.on('data', (chunk) => {
			if (this.procs !== procs) return;
			gotData = true;
			this._ingest(chunk);
			if (this.ring.length >= HIGH_WATER) ffmpeg.stdout.pause();
		});
		ffmpeg.stderr.on('data', (chunk) => this.log(t('music.log_ffmpeg', { message: String(chunk).trim().slice(0, 200) })));
		ffmpeg.once('error', (err) => {
			if (this.procs !== procs) return;
			this._fail(track, t('music.error_ffmpeg_spawn', { message: err.message }));
		});
		ffmpeg.once('close', (code) => {
			if (this.procs !== procs) return;
			if (!gotData && !this.stopping) {
				// A seek past the end of a track nobody knew the length of (a local file) decodes nothing and
				// exits cleanly: that is the track being over, not the track being broken.
				if (from > 0 && code === 0) {
					this.decodeDone = true;
					return;
				}
				this._fail(track, code === 0 ? t('music.error_no_audio') : t('music.error_decode', { code }));
				return;
			}
			this.decodeDone = true; // once the buffered remainder has played we move on to the next track
		});
	}

	_fail(track, message) {
		this.log(t('music.log_track_failed', { title: track.title, message }));
		this.onError?.(track, message);
		// startNext() kills the processes it finds in this.procs. Clearing it first left them running: when
		// ffmpeg failed to start, yt-dlp went on downloading into a pipe nobody would ever read.
		this.startNext();
	}

	/** Writes the ffmpeg output (s16le) into the ring; joins single leftover bytes onto the next chunk. */
	_ingest(chunk) {
		let buffer = chunk;
		if (this.leftover) {
			buffer = Buffer.concat([this.leftover, chunk]);
			this.leftover = null;
		}
		const usable = buffer.length & ~1;
		if (usable < buffer.length) this.leftover = buffer.subarray(usable);
		if (usable === 0) return;
		const aligned = buffer.byteOffset % 2 === 0 ? buffer : Buffer.from(buffer.subarray(0, usable));
		const samples = new Int16Array(aligned.buffer, aligned.byteOffset, usable >> 1);
		this.ring.push(samples);
	}

	/**
	 * For the bridge: reads one frame (960 stereo samples = 1920 int16) and returns how many samples
	 * were written. Moves on to the next track once this one is over.
	 */
	readFrame(dst, count = STEREO_SAMPLES_PER_FRAME_48K) {
		if (!this.current || this.paused) return 0;
		const n = this.ring.read(dst, count);
		this.samplesRead += n;
		if (n < count) {
			if (this.decodeDone && this.ring.length === 0) {
				const finished = this.current;
				// Where the finished track goes is settled before anybody hears it is over: a looped queue is not
				// empty, and a track on repeat is not the end of anything.
				const repeat = this.loop === 'track';
				if (repeat) this.queue.unshift(finished);
				else if (this.loop === 'queue') this.queue.push(finished);
				this.onTrackEnd?.(finished, { queueEmpty: this.queue.length === 0 });
				this.log(t('music.log_finished', { title: finished.title }));
				this.history.push(finished);
				if (this.history.length > 20) this.history.shift();
				// Reported above, so startNext() must not report it again: it reports whatever is still current
				// when the queue is empty (the end of a skip or a failure), and the last track of a queue was
				// said to have finished twice. this.procs is left for it to find and kill, as in _fail.
				this.current = null;
				this.startNext({ repeat });
			}
			if (n > 0) dst.fill(0, n, count);
		}
		if (this.procs?.ffmpeg?.stdout?.isPaused?.() && this.ring.length <= LOW_WATER) this.procs.ffmpeg.stdout.resume();
		return n;
	}

	/**
	 * Moves on to the next track, also when this one is on repeat: "skip" is somebody who has heard enough
	 * of it. In a looped queue the skipped track still belongs to the rotation, so it goes to the back.
	 */
	skip() {
		if (!this.current) return null;
		const skipped = this.current;
		this.log(t('music.log_skipped', { title: skipped.title }));
		if (this.loop === 'queue') this.queue.push(skipped);
		this.startNext();
		return skipped;
	}

	stop() {
		const had = this.current;
		this.stopping = true;
		this.queue.length = 0;
		this._killProcs();
		this.ring.clear();
		this.current = null;
		this.paused = false;
		this.decodeDone = false;
		this.offsetSeconds = 0;
		this.samplesRead = 0;
		// A loop belongs to the music it was set on. Left on, the next "play" days later would repeat for
		// ever without anybody having asked for that.
		this.loop = 'off';
		if (had) {
			this.log(t('music.log_stopped', { title: had.title }));
			// Whoever is watching the bot's profile is told what it is listening to when a track starts, and
			// that only ever came back off when a track ENDED. Stopping the music left "listening to" sitting
			// on the profile with a song nobody could hear. `stopped` lets the listener tell the two apart.
			this.onTrackEnd?.(had, { queueEmpty: true, stopped: true });
		}
		this._changed();
		return had;
	}

	pause() {
		if (!this.current) return false;
		this.paused = true;
		// Saved here as well: the place a pause leaves the track at is the place a restart should offer back.
		this._changed();
		return true;
	}

	resume() {
		if (!this.current) return false;
		const parked = this.parked;
		this.paused = false;
		if (parked) {
			// A restored track has no decoder yet: it starts here, from where it was left, and only now is
			// it "playing" for the profile and the activity log.
			this.stopping = false;
			this._startPipeline(this.current, this.offsetSeconds);
			this.onTrackStart?.(this.current, { repeat: false });
			this.log(t('music.log_resumed_at', { title: this.current.title, position: formatClock(this.offsetSeconds) }));
		}
		this._changed();
		return true;
	}

	setVolume(value) {
		this.volume = Math.max(0, Math.min(1, Number(value) || 0));
		this._changed();
		return this.volume;
	}

	/**
	 * Jumps to `seconds` into the current track by starting its decoder again from there (decoderArgs).
	 * A paused track stays paused at the new place. Past the end of a track whose length is known it
	 * refuses (SEEK_PAST_END) rather than quietly skipping it. Returns { track, from, to } or null when
	 * nothing is playing.
	 */
	seek(seconds) {
		if (!this.current) return null;
		const target = Math.max(0, Number(seconds) || 0);
		const duration = Number(this.current.duration) || 0;
		if (duration && target >= duration) throw new Error(SEEK_PAST_END);
		const from = this.elapsed;
		this.offsetSeconds = target;
		this.samplesRead = 0;
		if (!this.parked) {
			this._killProcs();
			this.ring.clear();
			this.leftover = null;
			this.decodeDone = false;
			this.stopping = false;
			this._startPipeline(this.current, target);
		}
		this.log(t('music.log_seek', { title: this.current.title, from: formatClock(from), to: formatClock(target) }));
		this._changed();
		return { track: this.current, from, to: target };
	}

	/** seek() by a step from where the track is now; a step back past the start lands on the start. */
	seekBy(delta) {
		if (!this.current) return null;
		return this.seek(Math.max(0, this.elapsed + (Number(delta) || 0)));
	}

	/** off / track / queue; null (and nothing changed) for anything else. */
	setLoop(mode) {
		const wanted = String(mode ?? '').trim().toLowerCase();
		if (!LOOP_MODES.includes(wanted)) return null;
		this.loop = wanted;
		this._changed();
		return wanted;
	}

	/** Shuffles the waiting tracks (Fisher-Yates); what is playing now keeps playing. Returns how many were shuffled. */
	shuffle() {
		for (let i = this.queue.length - 1; i > 0; i--) {
			// min(): an injected random() that returns 1 must not reach past the end.
			const j = Math.min(i, Math.floor(this.random() * (i + 1)));
			[this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
		}
		if (this.queue.length > 1) this._changed();
		return this.queue.length;
	}

	/** Empties the queue and leaves the current track playing. Returns how many tracks went. */
	clear() {
		const removed = this.queue.length;
		this.queue.length = 0;
		if (removed) this._changed();
		return removed;
	}

	/**
	 * Moves a waiting track from one queue position to another (1 = next up). A target past the end means
	 * the end. Returns { track, from, to } with the positions it really used, or null for no such track.
	 */
	move(from, to = 1) {
		const index = Number(from) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return null;
		const wanted = Number.isFinite(Number(to)) ? Math.round(Number(to)) : 1;
		const target = Math.max(1, Math.min(this.queue.length, wanted)) - 1;
		const [track] = this.queue.splice(index, 1);
		this.queue.splice(target, 0, track);
		this._changed();
		return { track, from: index + 1, to: target + 1 };
	}

	/** Removes a track from the queue by position number or title. */
	remove(indexOrTitle) {
		const index = Number.isInteger(indexOrTitle)
			? indexOrTitle - 1
			: this.queue.findIndex((track) => normalize(track.title).includes(normalize(indexOrTitle)));
		if (index < 0 || index >= this.queue.length) return null;
		const [removed] = this.queue.splice(index, 1);
		this._changed();
		return removed;
	}

	state() {
		const elapsed = this.elapsed;
		return {
			playing: this.playing,
			paused: this.paused,
			volume: this.volume,
			loop: this.loop,
			current: this.current ? { ...describe(this.current), elapsed: Math.floor(elapsed), elapsedText: formatClock(elapsed) } : null,
			queue: this.queue.map((track, i) => ({ position: i + 1, ...describe(track) })),
			bufferedMs: Math.round((this.ring.length / (RATE * CHANNELS)) * 1000),
		};
	}

	/** Short status sentence, meant to be read out loud: what, how far into it, and what the loop is doing. */
	nowPlayingText() {
		if (!this.current) return t('music.nothing_playing');
		const track = this.current;
		const elapsed = formatClock(this.elapsed);
		const duration = Number(track.duration) > 0 ? formatClock(track.duration) : null;
		const progress = duration ? t('music.progress', { elapsed, duration }) : t('music.progress_open', { elapsed });
		const extra = [track.uploader, progress].filter(Boolean).join(', ');
		const state = this.paused ? t('music.state_paused') : t('music.state_playing');
		const loop = this.loop === 'track' ? t('music.loop_suffix_track') : this.loop === 'queue' ? t('music.loop_suffix_queue') : '';
		return (
			t('music.now_playing', { state, title: track.title, extra: ` (${extra})` }) +
			loop +
			(this.queue.length ? t('music.queue_suffix', { count: this.queue.length }) : '')
		);
	}

	// ---------------------------------------------------------------- saved queue

	/**
	 * The queue as it is kept between runs (src/queuestore.js): what each track is, and where the current
	 * one had got to. Who asked for a track and the words they asked with stay out of it. The file is
	 * written whatever RECORD_TRANSCRIPTS says, because it is playback state like the saved tracks; what
	 * somebody said, and under which name, is exactly what that setting keeps off the disk, and a queue
	 * does not need it to play again.
	 */
	snapshot() {
		const entry = (track) => ({
			kind: track.kind,
			url: track.url,
			title: track.title,
			uploader: track.uploader ?? null,
			duration: track.duration ?? null,
		});
		return {
			volume: this.volume,
			loop: this.loop,
			current: this.current ? { ...entry(this.current), position: Math.floor(this.elapsed) } : null,
			queue: this.queue.map((track) => ({ ...entry(track), ...(track.startAt > 0 ? { position: Math.floor(track.startAt) } : {}) })),
		};
	}

	/**
	 * Takes a saved queue back (snapshot's shape). Nothing starts: the first track becomes the current one,
	 * paused where it was left and with no decoder behind it (parked), until somebody says "resume" or asks
	 * for something else. Every entry is checked again as if it were new -- a link must still be one we would
	 * hand yt-dlp, a file must still be an audio file directly inside MUSIC_DIR, a track must still be under
	 * the length limit -- and what fails is dropped. A player that already holds music is left alone.
	 * Returns { restored, dropped, current }.
	 */
	restore(saved) {
		const result = { restored: 0, dropped: 0, current: null };
		if (!saved || typeof saved !== 'object' || this.current || this.queue.length) return result;
		if (Number.isFinite(saved.volume)) this.volume = Math.max(0, Math.min(1, saved.volume));
		if (LOOP_MODES.includes(saved.loop)) this.loop = saved.loop;
		const entries = [saved.current, ...(Array.isArray(saved.queue) ? saved.queue : [])].filter(Boolean);
		const tracks = [];
		for (const entry of entries) {
			const track = tracks.length <= this.maxQueue ? this._restorable(entry) : null;
			if (track) tracks.push(track);
			else result.dropped += 1;
		}
		const [head, ...rest] = tracks;
		if (head) {
			this.current = head;
			this.paused = true;
			this.offsetSeconds = head.startAt ?? 0;
			this.samplesRead = 0;
			delete head.startAt;
			this.queue = rest;
		}
		result.restored = tracks.length;
		result.current = head ?? null;
		this._changed();
		return result;
	}

	/** One saved entry as a track, or null when it can no longer be played (see restore). */
	_restorable(entry) {
		if (!entry || typeof entry !== 'object') return null;
		const duration = Number(entry.duration) > 0 ? Number(entry.duration) : null;
		// The length limit may have been lowered since the queue was saved.
		if (this.maxMinutes > 0 && duration && duration > this.maxMinutes * 60) return null;
		let url = null;
		if (entry.kind === 'url' && isAllowedMediaUrl(entry.url)) url = String(entry.url).trim();
		else if (entry.kind === 'file') url = this._localFile(entry.url);
		if (!url) return null;
		const title = String(entry.title ?? '').trim().slice(0, 200) || path.basename(url);
		const position = Number(entry.position);
		return {
			kind: entry.kind,
			url,
			title,
			uploader: entry.uploader ? String(entry.uploader).slice(0, 200) : null,
			duration,
			query: title,
			requestedBy: null,
			id: ++this.seq,
			// It did not come through resolve() in this run (see _startPipeline).
			restored: true,
			...(position > 0 && (!duration || position < duration) ? { startAt: position } : {}),
		};
	}

	/**
	 * A saved path that is still an audio file directly inside MUSIC_DIR, which is the only place findLocal
	 * ever takes one from. The file under data/ is ours, but a path out of it is still not handed to ffmpeg
	 * on trust.
	 */
	_localFile(file) {
		if (!this.musicDir || typeof file !== 'string' || !file) return null;
		const full = path.resolve(file);
		if (path.dirname(full) !== path.resolve(this.musicDir)) return null;
		if (!AUDIO_EXTENSIONS.has(path.extname(full).toLowerCase())) return null;
		try {
			return statSync(full).isFile() ? full : null;
		} catch {
			return null;
		}
	}

	_killProcs() {
		const procs = this.procs;
		this.procs = null;
		if (!procs) return;
		for (const child of [procs.ytdlp, procs.ffmpeg]) {
			if (!child) continue;
			try {
				child.stdout?.removeAllListeners('data');
				child.kill();
			} catch {
				/* ignore */
			}
		}
	}

	/**
	 * Shutting down is not somebody stopping the music. The saved queue gets its last word first -- what
	 * was playing, where it had got to, what was waiting -- and is then let go, so the empty player the
	 * shutdown leaves behind is never written over it.
	 */
	destroy() {
		this._changed();
		this.onChange = null;
		this.stop();
	}
}

function describe(track) {
	return {
		title: track.title,
		uploader: track.uploader ?? null,
		duration: track.duration ?? null,
		durationText: formatDuration(track.duration),
		source: track.kind,
		requestedBy: track.requestedBy ?? null,
	};
}
