// The bot's own music player: yt-dlp (search/download) + ffmpeg (decoding to 48 kHz stereo s16le).
//
// Flow:  yt-dlp -o - <url>  --stdout-->  ffmpeg -i pipe:0 -f s16le -ar 48000 -ac 2  --stdout--> Ring
// The bridge pulls one frame (960 stereo samples) every 20 ms and mixes it into the bot's voice; while
// the bot speaks the music is ducked (turned down) and, after a short hold once it falls silent, rises
// back to its previous level.
//
// Local files (MUSIC_DIR) are played straight through ffmpeg, without yt-dlp.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ring, STEREO_SAMPLES_PER_FRAME_48K } from './audio.js';
import { cleanEnvValue } from './config.js';
import { t } from './i18n/index.js';
import { normalize } from './text.js';
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
	}

	/** The only flag the bridge has to look at: is a track playing/decoding? */
	get active() {
		return Boolean(this.current);
	}

	get playing() {
		return Boolean(this.current) && !this.paused;
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

	/** Puts the track in the queue; starts playing straight away when nothing is playing. */
	async enqueue(query, { requestedBy = null } = {}) {
		const track = await this.resolve(query);
		track.requestedBy = requestedBy;
		track.id = ++this.seq;
		if (this.queue.length >= this.maxQueue) throw new Error(QUEUE_FULL);
		// Already playing, or already waiting? Then this is the same request arriving twice, which is what
		// a model answering "sure, changing it" and then both skipping AND queueing produces. The song came
		// back round on its own when it finished, and from the outside it looked like the music would not
		// end. Saying so is more use than a second copy nobody asked for.
		const same = (other) => other && (other.url ? other.url === track.url : other.title === track.title);
		const duplicate = same(this.current) || this.queue.some(same);
		if (duplicate) return { track, position: this.queue.length, startedNow: false, duplicate: true };
		this.queue.push(track);
		const position = this.queue.length;
		if (!this.current) {
			this.startNext();
			return { track, position: 0, startedNow: true };
		}
		return { track, position, startedNow: false };
	}

	startNext() {
		this._killProcs();
		this.ring.clear();
		this.leftover = null;
		this.decodeDone = false;
		this.paused = false;
		const next = this.queue.shift();
		if (!next) {
			const ended = this.current;
			this.current = null;
			if (ended) this.onTrackEnd?.(ended, { queueEmpty: true });
			return null;
		}
		this.current = next;
		this.stopping = false;
		this._startPipeline(next);
		this.onTrackStart?.(next);
		this.log(t('music.log_playing', { title: next.title, duration: next.duration ? ` (${formatDuration(next.duration)})` : '' }));
		return next;
	}

	_startPipeline(track) {
		const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
		let ytdlp = null;
		if (track.kind === 'file') {
			ffArgs.push('-i', track.url);
		} else {
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
			ffArgs.push('-i', 'pipe:0');
		}
		ffArgs.push('-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1');
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
		if (n < count) {
			if (this.decodeDone && this.ring.length === 0) {
				const finished = this.current;
				this.onTrackEnd?.(finished, { queueEmpty: this.queue.length === 0 });
				this.log(t('music.log_finished', { title: finished.title }));
				this.history.push(finished);
				if (this.history.length > 20) this.history.shift();
				// Reported above, so startNext() must not report it again: it reports whatever is still current
				// when the queue is empty (the end of a skip or a failure), and the last track of a queue was
				// said to have finished twice. this.procs is left for it to find and kill, as in _fail.
				this.current = null;
				this.startNext();
			}
			if (n > 0) dst.fill(0, n, count);
		}
		if (this.procs?.ffmpeg?.stdout?.isPaused?.() && this.ring.length <= LOW_WATER) this.procs.ffmpeg.stdout.resume();
		return n;
	}

	skip() {
		if (!this.current) return null;
		const skipped = this.current;
		this.log(t('music.log_skipped', { title: skipped.title }));
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
		if (had) {
			this.log(t('music.log_stopped', { title: had.title }));
			// Whoever is watching the bot's profile is told what it is listening to when a track starts, and
			// that only ever came back off when a track ENDED. Stopping the music left "listening to" sitting
			// on the profile with a song nobody could hear. `stopped` lets the listener tell the two apart.
			this.onTrackEnd?.(had, { queueEmpty: true, stopped: true });
		}
		return had;
	}

	pause() {
		if (!this.current) return false;
		this.paused = true;
		return true;
	}

	resume() {
		if (!this.current) return false;
		this.paused = false;
		return true;
	}

	setVolume(value) {
		this.volume = Math.max(0, Math.min(1, Number(value) || 0));
		return this.volume;
	}

	/** Removes a track from the queue by position number or title. */
	remove(indexOrTitle) {
		const index = Number.isInteger(indexOrTitle)
			? indexOrTitle - 1
			: this.queue.findIndex((track) => normalize(track.title).includes(normalize(indexOrTitle)));
		if (index < 0 || index >= this.queue.length) return null;
		return this.queue.splice(index, 1)[0];
	}

	state() {
		return {
			playing: this.playing,
			paused: this.paused,
			volume: this.volume,
			current: this.current ? describe(this.current) : null,
			queue: this.queue.map((track, i) => ({ position: i + 1, ...describe(track) })),
			bufferedMs: Math.round((this.ring.length / (RATE * CHANNELS)) * 1000),
		};
	}

	/** Short status sentence, meant to be read out loud. */
	nowPlayingText() {
		if (!this.current) return t('music.nothing_playing');
		const track = this.current;
		const extra = [track.uploader, formatDuration(track.duration)].filter(Boolean).join(', ');
		const state = this.paused ? t('music.state_paused') : t('music.state_playing');
		return (
			t('music.now_playing', { state, title: track.title, extra: extra ? ` (${extra})` : '' }) +
			(this.queue.length ? t('music.queue_suffix', { count: this.queue.length }) : '')
		);
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

	destroy() {
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
