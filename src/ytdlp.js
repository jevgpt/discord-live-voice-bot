// Fetching yt-dlp when nothing on the machine provides one.
//
// The release is the one YTDLP_VERSION names, or the newest; the binary built for this platform is
// hashed while it downloads and compared with the SHA2-256SUMS published in the same release, and only a
// copy that matches is made executable and renamed into place. A half-written, truncated or swapped
// download is therefore never the file the music player starts, and the file that lands is 0755: the
// package this replaces left it writable by every account on the machine, which let any of them change
// what the bot runs.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { t } from './i18n/index.js';

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases';
// The standalone builds are around 35 MB; anything far beyond that is not a yt-dlp binary.
const MAX_BINARY_BYTES = 200 * 1024 * 1024;
const MAX_SUMS_BYTES = 256 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 30_000;
// yt-dlp tags are dates ("2025.09.05"); the pattern also keeps a pinned value from reaching the URL as a path.
const TAG = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;

/** Only a musl libc (Alpine) lacks the glibc version in the process report. */
function isMusl() {
	if (process.platform !== 'linux') return false;
	try {
		return !process.report?.getReport?.()?.header?.glibcVersionRuntime;
	} catch {
		return false;
	}
}

/**
 * The release asset built for this machine. The standalone builds need no Python; every other platform
 * gets the zipapp ("yt-dlp"), which runs wherever python3 does.
 */
export function ytDlpAssetName({ platform = process.platform, arch = process.arch, musl = null } = {}) {
	if (platform === 'win32') {
		if (arch === 'arm64') return 'yt-dlp_arm64.exe';
		if (arch === 'ia32') return 'yt-dlp_x86.exe';
		return 'yt-dlp.exe';
	}
	if (platform === 'darwin') return 'yt-dlp_macos';
	if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
		const onMusl = musl ?? isMusl();
		const base = onMusl ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
		return arch === 'arm64' ? `${base}_aarch64` : base;
	}
	return 'yt-dlp';
}

/** "<sha256>  <file>" lines -> Map(file -> sha256). A leading "*" (binary mode) is not part of the name. */
export function parseSha256Sums(text) {
	const sums = new Map();
	for (const line of String(text ?? '').split(/\r?\n/u)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/u.exec(line.trim());
		if (match) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

/**
 * The tag to download from: a pinned YTDLP_VERSION as it is, or the newest release. The newest is read
 * from where the "latest" download link redirects to rather than from the API, which is rate limited per
 * address; the checksums and the binary are then both taken from that one tag, so a release published in
 * between cannot pair one version's binary with the other's checksums.
 */
export async function resolveYtDlpRelease(version = null, { fetchImpl = fetch } = {}) {
	const wanted = String(version ?? '').trim();
	if (wanted && wanted.toLowerCase() !== 'latest') {
		if (!TAG.test(wanted)) throw new Error(t('music.error_ytdlp_version', { version: wanted }));
		return wanted;
	}
	let response;
	try {
		response = await fetchImpl(`${RELEASES}/latest/download/SHA2-256SUMS`, {
			redirect: 'manual',
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
	} catch (err) {
		throw new Error(t('music.error_ytdlp_release', { detail: err.message }));
	}
	const location = response.headers.get('location') ?? '';
	const tag = /\/releases\/download\/([^/?#]+)\//u.exec(location)?.[1];
	if (!tag || !TAG.test(tag)) throw new Error(t('music.error_ytdlp_release', { detail: `HTTP ${response.status}` }));
	return tag;
}

async function fetchChecked(url, fetchImpl, timeoutMs) {
	const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok || !response.body) {
		throw new Error(t('music.error_ytdlp_http', { status: response.status, file: path.basename(new URL(url).pathname) }));
	}
	return response;
}

/** Streams the body into `file` (created fresh, owner-only) and returns its SHA-256. */
async function streamToFile(response, file) {
	const hash = createHash('sha256');
	const handle = await open(file, 'wx', 0o600);
	let size = 0;
	try {
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > MAX_BINARY_BYTES) throw new Error(t('music.error_ytdlp_too_large'));
			hash.update(chunk);
			await handle.write(chunk);
		}
	} finally {
		await handle.close();
	}
	return hash.digest('hex');
}

async function download(target, { version, asset, fetchImpl, log }) {
	const tag = await resolveYtDlpRelease(version, { fetchImpl });
	const base = `${RELEASES}/download/${encodeURIComponent(tag)}`;
	const sumsResponse = await fetchChecked(`${base}/SHA2-256SUMS`, fetchImpl, LOOKUP_TIMEOUT_MS);
	const sumsText = await sumsResponse.text();
	if (sumsText.length > MAX_SUMS_BYTES) throw new Error(t('music.error_ytdlp_too_large'));
	const expected = parseSha256Sums(sumsText).get(asset);
	if (!expected) throw new Error(t('music.error_ytdlp_no_checksum', { tag, asset }));

	const dir = path.dirname(target);
	await mkdir(dir, { recursive: true });
	// Same directory as the target, so the final rename cannot cross a file system and is atomic.
	const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
	try {
		const actual = await streamToFile(await fetchChecked(`${base}/${asset}`, fetchImpl, DOWNLOAD_TIMEOUT_MS), tmp);
		if (actual !== expected) throw new Error(t('music.error_ytdlp_checksum', { tag, asset }));
		await chmod(tmp, 0o755);
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
	log(t('music.log_ytdlp_verified', { tag, asset, target }));
	return { tag, asset, sha256: expected, target };
}

// The music player and the video reader can both find yt-dlp missing at the same moment; they share
// one download instead of racing two into the same directory.
const inflight = new Map();

/**
 * Downloads yt-dlp into `target` and verifies it before it is put there.
 * @returns {Promise<{ tag: string, asset: string, sha256: string, target: string }>}
 */
export function downloadYtDlp(target, { version = null, asset = ytDlpAssetName(), fetchImpl = fetch, log = () => {} } = {}) {
	const key = path.resolve(target);
	const running = inflight.get(key);
	if (running) return running;
	const job = download(target, { version, asset, fetchImpl, log }).finally(() => inflight.delete(key));
	inflight.set(key, job);
	return job;
}
