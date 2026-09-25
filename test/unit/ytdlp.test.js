import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { MusicPlayer, UNSUPPORTED_LINK, YTDLP_MISSING, ensureYtDlpPath, ytDlpArgs } from '../../src/music.js';
import { downloadYtDlp, parseSha256Sums, resolveYtDlpRelease, ytDlpAssetName } from '../../src/ytdlp.js';

const TAG = '2026.08.19';
const BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}`;
const onWindows = process.platform === 'win32';

/**
 * GitHub as far as the downloader sees it: "latest" redirects to a tag, and that tag has the checksum
 * list and the binary. Nothing leaves the machine.
 */
function fakeGithub({ asset = 'yt-dlp', body = Buffer.from('#!/bin/sh\necho yt-dlp\n'), sums = null, binaryStatus = 200 } = {}) {
	const calls = [];
	const digest = createHash('sha256').update(body).digest('hex');
	const sumsText = sums ?? `${'0'.repeat(64)}  yt-dlp.exe\n${digest}  ${asset}\n`;
	const fetchImpl = async (url, options = {}) => {
		calls.push({ url, options });
		if (url === 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS') {
			return new Response(null, { status: 302, headers: { location: `${BASE}/SHA2-256SUMS` } });
		}
		if (url === `${BASE}/SHA2-256SUMS`) return new Response(sumsText);
		if (url === `${BASE}/${asset}`) return binaryStatus === 200 ? new Response(body) : new Response('gone', { status: binaryStatus });
		return new Response('not found', { status: 404 });
	};
	return { calls, fetchImpl, body, digest };
}

/** No yt-dlp on PATH: the `--version` probe fails to start. */
function nothingOnPath() {
	return () => {
		const child = new EventEmitter();
		setImmediate(() => child.emit('error', new Error('spawn yt-dlp ENOENT')));
		return child;
	};
}

const leftovers = (dir) => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

describe('ytDlpAssetName', () => {
	it('picks the standalone build for this platform, and the zipapp where there is none', () => {
		assert.equal(ytDlpAssetName({ platform: 'win32', arch: 'x64' }), 'yt-dlp.exe');
		assert.equal(ytDlpAssetName({ platform: 'win32', arch: 'ia32' }), 'yt-dlp_x86.exe');
		assert.equal(ytDlpAssetName({ platform: 'win32', arch: 'arm64' }), 'yt-dlp_arm64.exe');
		assert.equal(ytDlpAssetName({ platform: 'darwin', arch: 'arm64' }), 'yt-dlp_macos');
		assert.equal(ytDlpAssetName({ platform: 'linux', arch: 'x64', musl: false }), 'yt-dlp_linux');
		assert.equal(ytDlpAssetName({ platform: 'linux', arch: 'arm64', musl: false }), 'yt-dlp_linux_aarch64');
		assert.equal(ytDlpAssetName({ platform: 'linux', arch: 'x64', musl: true }), 'yt-dlp_musllinux');
		assert.equal(ytDlpAssetName({ platform: 'linux', arch: 'arm64', musl: true }), 'yt-dlp_musllinux_aarch64');
		assert.equal(ytDlpAssetName({ platform: 'linux', arch: 'arm' }), 'yt-dlp');
		assert.equal(ytDlpAssetName({ platform: 'freebsd', arch: 'x64' }), 'yt-dlp');
	});
});

describe('parseSha256Sums', () => {
	it('reads "hash  name" lines, drops a binary-mode star and skips anything else', () => {
		const sums = parseSha256Sums(`${'A'.repeat(64)}  yt-dlp\r\n${'b'.repeat(64)} *yt-dlp.exe\nnot a line\n${'c'.repeat(63)}  short\n`);
		assert.equal(sums.get('yt-dlp'), 'a'.repeat(64));
		assert.equal(sums.get('yt-dlp.exe'), 'b'.repeat(64));
		assert.equal(sums.size, 2);
	});
});

describe('resolveYtDlpRelease', () => {
	it('takes a pinned tag as it is and asks the network nothing', async () => {
		const fetchImpl = async () => assert.fail('a pinned version needs no lookup');
		assert.equal(await resolveYtDlpRelease('2025.09.05', { fetchImpl }), '2025.09.05');
	});

	it('refuses a pinned value that is not a tag, so it cannot reach the URL as a path', async () => {
		for (const version of ['../../evil', '2025/09/05', '-rf', 'a b']) {
			await assert.rejects(() => resolveYtDlpRelease(version, { fetchImpl: async () => assert.fail() }), /not a release tag/u, version);
		}
	});

	it('reads the newest tag from where the "latest" link redirects, without following it', async () => {
		const github = fakeGithub();
		assert.equal(await resolveYtDlpRelease(null, { fetchImpl: github.fetchImpl }), TAG);
		assert.equal(await resolveYtDlpRelease('latest', { fetchImpl: github.fetchImpl }), TAG);
		assert.equal(github.calls[0].options.redirect, 'manual');
	});

	it('says so when the redirect names no tag', async () => {
		const fetchImpl = async () => new Response('rate limited', { status: 403 });
		await assert.rejects(() => resolveYtDlpRelease(null, { fetchImpl }), /could not find the yt-dlp release.*HTTP 403/u);
	});
});

describe('downloadYtDlp', () => {
	it('downloads the asset of one tag, checks it against that tag\'s SHA2-256SUMS and moves it into place as 0755', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
		const target = path.join(dir, 'bin', 'yt-dlp');
		const github = fakeGithub({ asset: 'yt-dlp_linux' });
		const logs = [];
		const result = await downloadYtDlp(target, { asset: 'yt-dlp_linux', fetchImpl: github.fetchImpl, log: (line) => logs.push(line) });
		assert.deepEqual(result, { tag: TAG, asset: 'yt-dlp_linux', sha256: github.digest, target });
		assert.deepEqual(readFileSync(target), github.body);
		if (!onWindows) assert.equal(statSync(target).mode & 0o777, 0o755, 'nobody but the owner may change what the bot runs');
		assert.deepEqual(
			github.calls.map((call) => call.url),
			[
				'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
				`${BASE}/SHA2-256SUMS`,
				`${BASE}/yt-dlp_linux`,
			],
			'the checksums and the binary come from the same tag',
		);
		assert.deepEqual(leftovers(path.dirname(target)), []);
		assert.ok(logs.some((line) => line.includes(TAG) && line.includes('SHA-256')), logs.join(' | '));
	});

	it('deletes a download whose hash does not match and leaves nothing behind', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
		const target = path.join(dir, 'yt-dlp');
		const github = fakeGithub({ sums: `${'f'.repeat(64)}  yt-dlp\n` });
		await assert.rejects(() => downloadYtDlp(target, { asset: 'yt-dlp', fetchImpl: github.fetchImpl }), /does not match the SHA-256/u);
		assert.equal(existsSync(target), false);
		assert.deepEqual(leftovers(dir), []);
	});

	it('refuses an asset the checksum list does not mention, before downloading it', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
		const github = fakeGithub({ sums: `${'f'.repeat(64)}  yt-dlp.exe\n` });
		await assert.rejects(() => downloadYtDlp(path.join(dir, 'yt-dlp'), { asset: 'yt-dlp', fetchImpl: github.fetchImpl }), /lists no checksum for yt-dlp/u);
		assert.ok(!github.calls.some((call) => call.url.endsWith('/yt-dlp')), 'the binary itself was never requested');
	});

	it('reports a failed download by status and file', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
		const github = fakeGithub({ binaryStatus: 404 });
		await assert.rejects(() => downloadYtDlp(path.join(dir, 'yt-dlp'), { asset: 'yt-dlp', version: TAG, fetchImpl: github.fetchImpl }), /HTTP 404 for yt-dlp/u);
		assert.deepEqual(leftovers(dir), []);
	});

	it('shares one download between two callers that want the same file at once', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
		const target = path.join(dir, 'yt-dlp');
		const github = fakeGithub();
		const [first, second] = await Promise.all([
			downloadYtDlp(target, { asset: 'yt-dlp', fetchImpl: github.fetchImpl }),
			downloadYtDlp(target, { asset: 'yt-dlp', fetchImpl: github.fetchImpl }),
		]);
		assert.equal(first, second);
		assert.equal(github.calls.filter((call) => call.url === `${BASE}/yt-dlp`).length, 1);
	});
});

describe('ensureYtDlpPath', () => {
	const asset = ytDlpAssetName();
	const name = onWindows ? 'yt-dlp.exe' : 'yt-dlp';

	it('downloads a checked copy into tools/bin when nothing else provides one', async () => {
		const binDir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-bin-'));
		const github = fakeGithub({ asset });
		const found = await ensureYtDlpPath({ binDir, version: TAG, spawnImpl: nothingOnPath(), fetchImpl: github.fetchImpl });
		assert.equal(found, path.join(binDir, name));
		assert.deepEqual(readFileSync(found), github.body);
	});

	it('downloads nothing when downloading is off', async () => {
		const binDir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-bin-'));
		const fetchImpl = async () => assert.fail('nothing may be fetched');
		await assert.rejects(() => ensureYtDlpPath({ binDir, autoDownload: false, spawnImpl: nothingOnPath(), fetchImpl }), new RegExp(YTDLP_MISSING));
	});

	it('replaces a tools/bin copy other accounts could have written, with a checked one', { skip: onWindows }, async () => {
		const binDir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-bin-'));
		const stale = path.join(binDir, name);
		writeFileSync(stale, 'left mode 777 by the old downloader');
		chmodSync(stale, 0o777);
		const github = fakeGithub({ asset });
		const logs = [];
		const found = await ensureYtDlpPath({ binDir, version: TAG, spawnImpl: nothingOnPath(), fetchImpl: github.fetchImpl, log: (line) => logs.push(line) });
		assert.equal(found, stale);
		assert.deepEqual(readFileSync(stale), github.body);
		assert.equal(statSync(stale).mode & 0o777, 0o755);
		assert.ok(logs.some((line) => line.includes('any account')), logs.join(' | '));
	});

	it('only closes such a copy when downloading is off, and says how to replace it', { skip: onWindows }, async () => {
		const binDir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-bin-'));
		const stale = path.join(binDir, name);
		writeFileSync(stale, 'installed earlier');
		chmodSync(stale, 0o777);
		const logs = [];
		const fetchImpl = async () => assert.fail('nothing may be fetched');
		const found = await ensureYtDlpPath({ binDir, autoDownload: false, spawnImpl: nothingOnPath(), fetchImpl, log: (line) => logs.push(line) });
		assert.equal(found, stale);
		assert.equal(readFileSync(stale, 'utf8'), 'installed earlier');
		assert.equal(statSync(stale).mode & 0o777, 0o755);
		assert.ok(logs.some((line) => line.includes('Delete it')), logs.join(' | '));
	});

	it('leaves a copy that only its owner can write alone', { skip: onWindows }, async () => {
		const binDir = mkdtempSync(path.join(os.tmpdir(), 'ytdlp-bin-'));
		const own = path.join(binDir, name);
		writeFileSync(own, 'fine');
		chmodSync(own, 0o755);
		const fetchImpl = async () => assert.fail('nothing may be fetched');
		assert.equal(await ensureYtDlpPath({ binDir, spawnImpl: nothingOnPath(), fetchImpl }), own);
		assert.equal(readFileSync(own, 'utf8'), 'fine');
	});
});

/** yt-dlp and ffmpeg doubles: the lookup answers with `info`, ffmpeg with a little silence. */
function mediaSpawn(info) {
	const spawned = [];
	const spawn = (binary, args) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough();
		child.kill = () => {
			child.killed = true;
			setImmediate(() => child.emit('close', 0));
		};
		spawned.push({ binary, args, child });
		setImmediate(() => {
			if (args.includes('-j')) {
				child.stdout.write(JSON.stringify(info));
				child.emit('close', 0);
			} else if (args.includes('pipe:1')) {
				child.stdout.write(Buffer.alloc(48_000 * 2 * 2));
			}
		});
		return child;
	};
	return { spawned, spawn };
}

describe('MusicPlayer and yt-dlp', () => {
	it('builds every call with --ignore-config and ends the options before the target', () => {
		assert.deepEqual(ytDlpArgs(['-j'], '-exec'), ['--ignore-config', '-j', '--', '-exec']);
	});

	it('looks a track up and plays it without reading a yt-dlp config, the target always positional', async () => {
		const info = { title: 'Skyline', webpage_url: 'https://www.youtube.com/watch?v=abc', duration: 200 };
		const media = mediaSpawn(info);
		const player = new MusicPlayer({ ytDlpPath: process.execPath, spawnImpl: media.spawn, log: () => {} });
		const { track } = await player.enqueue('--exec rm skyline');
		assert.equal(track.url, info.webpage_url);
		const [lookup, stream] = media.spawned.filter((entry) => entry.binary === process.execPath);
		assert.equal(lookup.args[0], '--ignore-config');
		assert.deepEqual(lookup.args.slice(-2), ['--', 'ytsearch1:--exec rm skyline']);
		assert.equal(stream.args[0], '--ignore-config');
		assert.deepEqual(stream.args.slice(-2), ['--', info.webpage_url]);
		player.stop();
	});

	it('refuses to play a page yt-dlp answered with on a host a spoken link could not name', async () => {
		for (const webpage_url of ['http://192.168.1.1/admin', 'https://evil.example/watch', 'file:///etc/passwd']) {
			const media = mediaSpawn({ title: 'x', webpage_url });
			const player = new MusicPlayer({ ytDlpPath: process.execPath, spawnImpl: media.spawn, log: () => {} });
			await assert.rejects(() => player.enqueue('https://youtu.be/abc'), new RegExp(UNSUPPORTED_LINK), webpage_url);
			assert.equal(player.current, null);
			assert.equal(media.spawned.filter((entry) => entry.args.includes('-o')).length, 0, 'nothing was streamed');
		}
	});

	it('turns a link to a host it will not fetch away before looking for yt-dlp at all', async () => {
		const media = mediaSpawn({});
		const player = new MusicPlayer({ ytDlpPath: null, binDir: path.join(os.tmpdir(), 'no-such-bin'), autoDownload: true, spawnImpl: media.spawn, log: () => {} });
		await assert.rejects(() => player.enqueue('http://10.0.0.1/stream'), new RegExp(UNSUPPORTED_LINK));
		assert.equal(media.spawned.length, 0, 'no --version probe, no download');
	});
});
