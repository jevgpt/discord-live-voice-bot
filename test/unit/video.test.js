import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { UNSUPPORTED_LINK } from '../../src/music.js';
import { callTool } from '../../src/tools/index.js';
import { fetchVideo, forgetVideos, recallVideo, rememberVideo, srtToText } from '../../src/video.js';

/** A yt-dlp double: metadata to stdout, and (unless it fails) one subtitle file where -o points. */
function fakeSpawn({ info, withSubtitles = true }) {
	return (binary, args) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		setImmediate(() => {
			const done = (code) => {
				// A real child emits both; the path probe listens for "exit", the runner for "close".
				child.emit('exit', code);
				child.emit('close', code);
			};
			if (args.includes('-j')) {
				child.stdout.emit('data', Buffer.from(JSON.stringify(info)));
				done(0);
				return;
			}
			if (args.includes('--write-subs')) {
				if (!withSubtitles) {
					done(1);
					return;
				}
				const out = args[args.indexOf('-o') + 1];
				const srt = ['1', '00:00:00,000 --> 00:00:02,000', '<i>ilk</i> satır', '', '2', '00:00:02,000 --> 00:00:04,000', 'ikinci satır', ''].join('\n');
				writeFileSync(path.join(path.dirname(out), `${info.id}.tr.srt`), srt, 'utf8');
				done(0);
				return;
			}
			done(0);
		});
		return child;
	};
}

// The binary the reader is pointed at: one that exists everywhere, so no test asks for a download and
// none depends on yt-dlp being installed on the machine.
const BINARY = process.execPath;

const INFO = { id: 'abc123', title: 'Bir video', duration: 300, webpage_url: 'https://www.youtube.com/watch?v=abc123' };
const VIDEO = {
	id: 'abc123',
	title: 'Bir video',
	url: 'https://youtu.be/abc123',
	duration: 300,
	uploader: null,
	lang: 'tr',
	transcript: 'bir iki üç dört beş',
	chars: 20,
	fetchedAt: Date.now(),
};

describe('srtToText', () => {
	it('keeps the words and drops the cue numbers, the times and the tags', () => {
		const srt = ['1', '00:00:01,000 --> 00:00:03,000', '<i>Merhaba</i> dünya', '', '2', '00:00:03,100 --> 00:00:05,000', 'ikinci satır', ''].join('\n');
		assert.equal(srtToText(srt), 'Merhaba dünya ikinci satır');
	});
});

describe('fetchVideo', () => {
	it('reads the subtitles into a transcript, and remembers it by id and by title', async () => {
		forgetVideos();
		const video = await fetchVideo('https://www.youtube.com/watch?v=abc123', {
			ytDlpPath: BINARY,
			autoDownload: false,
			spawnImpl: fakeSpawn({ info: INFO }),
			log: () => {},
		});
		assert.equal(video.id, 'abc123');
		assert.equal(video.title, 'Bir video');
		assert.match(video.transcript, /ilk satır ikinci satır/);
		assert.equal(recallVideo().id, 'abc123', 'the newest read is what a follow-up question means');
		assert.equal(recallVideo('bir video').id, 'abc123');
	});

	it('reads no yt-dlp config, keeps the target positional and takes the subtitles from the page it settled on', async () => {
		forgetVideos();
		const calls = [];
		const spawn = fakeSpawn({ info: INFO });
		const video = await fetchVideo('--exec touch bir video', {
			ytDlpPath: BINARY,
			autoDownload: false,
			spawnImpl: (binary, args) => {
				calls.push(args);
				return spawn(binary, args);
			},
			log: () => {},
		});
		assert.equal(calls.length, 2);
		for (const args of calls) assert.equal(args[0], '--ignore-config');
		assert.deepEqual(calls[0].slice(-2), ['--', 'ytsearch1:--exec touch bir video']);
		assert.deepEqual(calls[1].slice(-2), ['--', INFO.webpage_url], 'the second call fetches the page the search found, not the search again');
		assert.equal(video.url, INFO.webpage_url);
	});

	it('refuses a page yt-dlp answered with on a host a link could not name', async () => {
		forgetVideos();
		const calls = [];
		const spawn = fakeSpawn({ info: { ...INFO, webpage_url: 'http://169.254.169.254/latest/meta-data' } });
		await assert.rejects(
			() =>
				fetchVideo('https://youtu.be/abc123', {
					ytDlpPath: BINARY,
					autoDownload: false,
					spawnImpl: (binary, args) => {
						calls.push(args);
						return spawn(binary, args);
					},
					log: () => {},
				}),
			new RegExp(UNSUPPORTED_LINK),
		);
		assert.equal(calls.length, 1, 'the subtitles were never fetched');
		assert.equal(recallVideo(), null);
	});

	it('says there are no subtitles rather than inventing a transcript', async () => {
		forgetVideos();
		await assert.rejects(
			() =>
				fetchVideo('https://www.youtube.com/watch?v=abc123', {
					ytDlpPath: BINARY,
					autoDownload: false,
					spawnImpl: fakeSpawn({ info: INFO, withSubtitles: false }),
					log: () => {},
				}),
			(err) => err.reason === 'no-subtitles',
		);
	});
});

describe('video tools', () => {
	function toolDeps({ provider = true } = {}) {
		return {
			guild: { channels: { cache: new Map() } },
			cfg: { textChannelId: null },
			fetchVideo: async () => rememberVideo(VIDEO),
			provider: provider
				? { available: true, complete: async ({ instructions }) => (instructions.includes('part') ? 'parça özeti' : 'tam özet') }
				: null,
			currentSpeakerId: () => 'u1',
			personaName: () => 'Aria',
			activity: () => {},
			log: () => {},
		};
	}

	it('reads a video, hands out the transcript and summarises it', async () => {
		forgetVideos();
		const deps = toolDeps();
		const watched = await callTool('watch_video', { video: 'bir video' }, deps);
		assert.equal(watched.ok, true, watched.spoken);
		assert.match(watched.spoken, /Bir video/);

		const part = await callTool('video_transcript', { limit: 5 }, deps);
		assert.equal(part.ok, true, part.spoken);
		assert.match(part.data.transcript, /^bir /);

		const summary = await callTool('summarize_video', {}, deps);
		assert.equal(summary.ok, true, summary.spoken);
		assert.equal(summary.data.summary, 'parça özeti');
	});

	it('answers when nothing has been read, and when there is no text model', async () => {
		forgetVideos();
		const deps = toolDeps();
		assert.equal((await callTool('video_transcript', {}, deps)).ok, false);
		assert.equal((await callTool('summarize_video', {}, toolDeps({ provider: false }))).ok, false);
	});
});
