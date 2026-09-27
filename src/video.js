// Reading a video: yt-dlp fetches the metadata and whatever subtitles the video carries (the ones
// somebody wrote first, machine-made ones when there are none), and the transcript is kept in memory
// so follow-up questions and a summary do not fetch anything again.
//
// Nothing is written to disk: a transcript is public text and can be long, while re-reading it is one
// command.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { locale } from './i18n/index.js';
import { DEFAULT_YTDLP_DIR, UNSUPPORTED_LINK, YTDLP_MISSING, ensureYtDlpPath, isAllowedMediaUrl, runCommand, ytDlpArgs } from './music.js';

const MAX_TRANSCRIPT = 120_000;
const MAX_VIDEOS = 8;
const TIMEOUT_MS = 60_000;

/** A failure the caller can word itself; `reason` is the identity, the message is for the log. */
function fail(reason, message) {
	return Object.assign(new Error(message), { reason });
}

/** srt -> plain text: cue numbers and time lines go, subtitle tags go, what is left joins up. */
export function srtToText(srt) {
	return String(srt ?? '')
		.split(/\r?\n/u)
		.filter((line) => !/^\s*\d+\s*$/u.test(line) && !line.includes('-->'))
		.map((line) => line.replace(/<[^>]*>/gu, '').trim())
		.filter(Boolean)
		.join(' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

/** The videos read this session, newest last. Memory only: a transcript is not a note. */
const videos = new Map();

export function rememberVideo(video) {
	videos.delete(video.id);
	videos.set(video.id, video);
	while (videos.size > MAX_VIDEOS) videos.delete(videos.keys().next().value);
	return video;
}

/** The video a follow-up question is about: the newest one, or the one named by id or a piece of title. */
export function recallVideo(needle = null) {
	if (!needle) return [...videos.values()].at(-1) ?? null;
	const text = String(needle).trim();
	if (!text) return recallVideo(null);
	const lower = text.toLowerCase();
	return videos.get(text) ?? [...videos.values()].reverse().find((video) => video.title.toLowerCase().includes(lower)) ?? null;
}

/** Only tests empty this. */
export function forgetVideos() {
	videos.clear();
}

/** The subtitle languages to ask for: the bot's own first, English after it. */
function languages() {
	const code = locale();
	return code === 'en' ? 'en.*' : `${code}.*,en.*`;
}

/**
 * Reads a video: metadata first (title, length), then subtitles into a temporary directory, and the
 * longest file that came back is the transcript. A name instead of a link is searched for by yt-dlp.
 */
export async function fetchVideo(input, { ytDlpPath = null, binDir = DEFAULT_YTDLP_DIR, autoDownload = true, log = () => {}, spawnImpl = undefined } = {}) {
	const text = String(input ?? '').trim();
	if (!text) throw fail('no-input', 'no video given');
	const url = /^https?:\/\//iu.test(text) ? text : `ytsearch1:${text}`;
	if (!isAllowedMediaUrl(url) && !url.startsWith('ytsearch1:')) throw new Error(UNSUPPORTED_LINK);
	const binary = await ensureYtDlpPath({ preferred: ytDlpPath, binDir, autoDownload, log, spawnImpl });
	const dir = await mkdtemp(path.join(tmpdir(), 'video-'));
	try {
		let raw;
		try {
			raw = await runCommand(binary, ytDlpArgs(['-j', '--no-playlist', '--no-warnings', '--skip-download'], url), { timeoutMs: TIMEOUT_MS, spawnImpl });
		} catch (err) {
			if (err.reason === 'spawn') throw new Error(YTDLP_MISSING);
			throw fail('no-result', err.message);
		}
		const line = raw.split('\n').find((candidate) => candidate.trim().startsWith('{'));
		if (!line) throw fail('no-result', 'no metadata');
		const info = JSON.parse(line);
		// The page yt-dlp settled on (a search result, or where an allowed link redirected to) is the one the
		// subtitles come from, so it passes the same host check the input did. Fetching that page rather
		// than the input again also keeps a search from landing on a different video the second time.
		const page = String(info.webpage_url ?? (url.startsWith('ytsearch1:') ? '' : url));
		if (!isAllowedMediaUrl(page)) throw new Error(UNSUPPORTED_LINK);
		try {
			await runCommand(
				binary,
				ytDlpArgs(
					[
						'--skip-download', '--no-playlist', '--no-warnings',
						'--write-subs', '--write-auto-subs', '--sub-langs', languages(),
						'--convert-subs', 'srt',
						'-o', path.join(dir, '%(id)s.%(ext)s'),
					],
					page,
				),
				{ timeoutMs: TIMEOUT_MS, spawnImpl },
			);
		} catch {
			// A video with no subtitles at all exits non-zero as well; the directory decides which it was.
		}
		const files = (await readdir(dir)).filter((name) => name.endsWith('.srt'));
		if (!files.length) throw fail('no-subtitles', 'no subtitle files');
		let transcript = '';
		let lang = null;
		for (const name of files) {
			const body = srtToText(await readFile(path.join(dir, name), 'utf8'));
			if (body.length > transcript.length) {
				transcript = body;
				lang = name.replace(/\.srt$/u, '').split('.').pop() ?? null;
			}
		}
		if (!transcript) throw fail('no-subtitles', 'subtitles were empty');
		return rememberVideo({
			id: String(info.id ?? url),
			title: String(info.title ?? text),
			url: page,
			duration: Number(info.duration) || null,
			uploader: info.uploader ?? info.channel ?? null,
			lang,
			transcript: transcript.slice(0, MAX_TRANSCRIPT),
			chars: Math.min(transcript.length, MAX_TRANSCRIPT),
			fetchedAt: Date.now(),
		});
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
