import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { STEREO_SAMPLES_PER_FRAME_48K } from '../../src/audio.js';
import { LOOP_MODES, MusicPlayer, SEEK_PAST_END, decoderArgs, parseSeekTarget } from '../../src/music.js';
import { formatClock, parseClock } from '../../src/text.js';

// The queue, the repeat modes, the shuffle, seeking and the saved queue of the music player. The decoder
// is a stand-in: every "ffmpeg" writes the PCM it is handed for its input and closes, and every process
// is recorded with its arguments, so what a seek asks of ffmpeg and yt-dlp can be read back exactly.

const RATE_SAMPLES = 48_000 * 2; // interleaved int16 samples per second

const pcmSeconds = (seconds, value = 1234) => Buffer.from(new Int16Array(Math.round(RATE_SAMPLES * seconds)).fill(value).buffer);

/**
 * A spawn that records every process. ffmpeg writes pcmFor(input, args) (a file path, or "pipe:0" for a
 * link) and closes; yt-dlp just sits there, the way it does while it streams into ffmpeg.
 */
function fakeSpawn(pcmFor) {
	const spawned = [];
	return {
		spawned,
		ffmpegCalls: () => spawned.filter((entry) => entry.args.includes('pipe:1')),
		spawn: (binary, args) => {
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.stdin = new PassThrough();
			child.killed = false;
			child.kill = () => {
				child.killed = true;
				return true;
			};
			spawned.push({ binary, args, child });
			if (args.includes('pipe:1')) {
				const input = args[args.indexOf('-i') + 1];
				const pcm = pcmFor(input, args) ?? Buffer.alloc(0);
				setImmediate(() => {
					if (pcm.length) child.stdout.write(pcm);
					child.stdout.end();
					child.emit('close', 0);
				});
			}
			return child;
		},
	};
}

function musicDir(...names) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'music-queue-'));
	for (const name of names) writeFileSync(path.join(dir, name), 'x');
	return dir;
}

/** Reads frames (a tick at a time, with the event loop let through) until `done()` or the budget runs out. */
async function play(player, { frames = 200, done = () => false } = {}) {
	const dst = new Int16Array(STEREO_SAMPLES_PER_FRAME_48K);
	for (let i = 0; i < frames && !done(); i++) {
		player.readFrame(dst);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

async function waitForFrame(player, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (player.ring.length < STEREO_SAMPLES_PER_FRAME_48K) {
		if (Date.now() > deadline) throw new Error('the player never buffered a frame');
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

/** Reads exactly `count` whole frames, waiting for each to be buffered first. */
async function readFrames(player, count) {
	const dst = new Int16Array(STEREO_SAMPLES_PER_FRAME_48K);
	for (let i = 0; i < count; i++) {
		await waitForFrame(player);
		assert.equal(player.readFrame(dst), STEREO_SAMPLES_PER_FRAME_48K);
	}
}

const urlTrack = (title, extra = {}) => ({ kind: 'url', url: `https://www.youtube.com/watch?v=${title}`, title, id: title, ...extra });

describe('clock and seek text', () => {
	it('reads the times people say and write, and refuses what is not one', () => {
		assert.equal(parseClock('1:30'), 90);
		assert.equal(parseClock('1.30'), 90);
		assert.equal(parseClock('1:02:03'), 3723);
		assert.equal(parseClock('90'), 90);
		assert.equal(parseClock('1:75'), null);
		assert.equal(parseClock('soon'), null);
		assert.equal(formatClock(0), '0:00');
		assert.equal(formatClock(119.9), '1:59');
		assert.equal(formatClock(3723), '1:02:03');
		assert.deepEqual(parseSeekTarget('1:30'), { to: 90 });
		assert.deepEqual(parseSeekTarget('+30'), { by: 30 });
		assert.deepEqual(parseSeekTarget('-0:10'), { by: -10 });
		assert.deepEqual(parseSeekTarget(0), { to: 0 });
		assert.equal(parseSeekTarget('later'), null);
	});
});

describe('decoderArgs: where -ss goes', () => {
	it('puts -ss before -i for a file (input seeking) and after the yt-dlp pipe for a link', () => {
		const file = decoderArgs({ kind: 'file', url: '/music/a.mp3' }, 90);
		assert.ok(file.indexOf('-ss') < file.indexOf('-i'), 'a file is sought before it is opened');
		assert.equal(file[file.indexOf('-ss') + 1], '90.000');
		assert.equal(file[file.indexOf('-i') + 1], '/music/a.mp3');
		const stream = decoderArgs({ kind: 'url', url: 'https://youtu.be/x' }, 90);
		assert.equal(stream[stream.indexOf('-i') + 1], 'pipe:0');
		assert.ok(stream.indexOf('-ss') > stream.indexOf('-i'), 'a pipe cannot seek, so ffmpeg decodes and drops up to the place');
		assert.equal(decoderArgs({ kind: 'file', url: '/music/a.mp3' }).includes('-ss'), false, 'no seek, no -ss');
		assert.equal(stream.at(-1), 'pipe:1');
	});
});

describe('MusicPlayer: queue operations', () => {
	it('"play X next" goes to the front, and one already waiting moves up instead of being added twice', async () => {
		const dir = musicDir('a.wav', 'b.wav', 'c.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {} });
		assert.equal((await player.enqueue('a')).startedNow, true);
		await player.enqueue('b');
		const next = await player.enqueue('c', { next: true });
		assert.deepEqual([next.position, next.startedNow], [1, false]);
		assert.deepEqual(player.queue.map((track) => track.title), ['c', 'b']);
		const moved = await player.enqueue('b', { next: true });
		assert.equal(moved.moved, true);
		assert.deepEqual(player.queue.map((track) => track.title), ['b', 'c'], 'the same track, moved up, not a second copy');
		assert.equal((await player.enqueue('a', { next: true })).duplicate, true, 'what is playing now is not queued again');
		player.stop();
	});

	it('moves by position ("move 3 to 1"), clamps a target past the end, and clears the queue but not the current track', () => {
		const player = new MusicPlayer({ spawnImpl: fakeSpawn(() => null).spawn, log: () => {} });
		player.current = urlTrack('Now');
		player.procs = { ffmpeg: null };
		player.queue.push(urlTrack('One'), urlTrack('Two'), urlTrack('Three'));
		const moved = player.move(3, 1);
		assert.deepEqual([moved.track.title, moved.from, moved.to], ['Three', 3, 1]);
		assert.deepEqual(player.queue.map((track) => track.title), ['Three', 'One', 'Two']);
		assert.equal(player.move(1, 99).to, 3, 'past the end means the end');
		assert.deepEqual(player.queue.map((track) => track.title), ['One', 'Two', 'Three']);
		assert.equal(player.move(7, 1), null, 'no such position');
		assert.equal(player.remove(2).title, 'Two');
		assert.equal(player.clear(), 2);
		assert.deepEqual(player.queue, []);
		assert.equal(player.current.title, 'Now', 'the track playing now is left alone');
		assert.equal(player.clear(), 0);
	});

	it('shuffles the waiting tracks the same way for the same dice, and never touches the current track', () => {
		const rolls = () => {
			const sequence = [0.5, 0.2, 0.9, 0];
			let index = 0;
			return () => sequence[index++ % sequence.length];
		};
		const order = () => {
			const player = new MusicPlayer({ spawnImpl: fakeSpawn(() => null).spawn, log: () => {}, random: rolls() });
			player.current = urlTrack('Now');
			player.queue.push(...['T1', 'T2', 'T3', 'T4', 'T5'].map((title) => urlTrack(title)));
			assert.equal(player.shuffle(), 5);
			assert.equal(player.current.title, 'Now');
			return player.queue.map((track) => track.title);
		};
		// Fisher-Yates with 0.5, 0.2, 0.9, 0: swap(4,2), swap(3,0), keep 2, swap(1,0).
		assert.deepEqual(order(), ['T2', 'T4', 'T5', 'T1', 'T3']);
		assert.deepEqual(order(), order(), 'the same dice, the same order');
		const edge = new MusicPlayer({ spawnImpl: fakeSpawn(() => null).spawn, log: () => {}, random: () => 1 });
		edge.queue.push(urlTrack('A'), urlTrack('B'));
		edge.shuffle();
		assert.deepEqual(edge.queue.map((track) => track.title).sort(), ['A', 'B'], 'a die that rolls 1 cannot reach past the end');
	});
});

describe('MusicPlayer: repeat modes at the end of a track', () => {
	it('loop "track" plays the same track again, reports each lap once, and marks the restart as a repeat', async () => {
		const dir = musicDir('a.wav');
		const fake = fakeSpawn(() => pcmSeconds(0.06));
		const starts = [];
		const ends = [];
		const player = new MusicPlayer({
			musicDir: dir,
			spawnImpl: fake.spawn,
			log: () => {},
			onTrackStart: (track, info) => starts.push({ title: track.title, repeat: info?.repeat ?? false }),
			onTrackEnd: (track, info) => ends.push({ title: track.title, ...info }),
		});
		await player.enqueue('a');
		assert.equal(player.setLoop('track'), 'track');
		await play(player, { done: () => starts.length >= 3 });
		assert.deepEqual(
			starts.slice(0, 3),
			[
				{ title: 'a', repeat: false },
				{ title: 'a', repeat: true },
				{ title: 'a', repeat: true },
			],
		);
		assert.ok(ends.length >= 2);
		assert.ok(
			ends.every((end) => end.queueEmpty === false),
			'a track on repeat is never the end of the queue',
		);
		assert.equal(player.history.length, ends.length, 'each lap is in the history once');
		player.stop();
	});

	it('loop "queue" sends every finished track to the back, so the list comes round again', async () => {
		const dir = musicDir('a.wav', 'b.wav');
		const fake = fakeSpawn(() => pcmSeconds(0.06));
		const starts = [];
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {}, onTrackStart: (track) => starts.push(track.title) });
		await player.enqueue('a');
		await player.enqueue('b');
		player.setLoop('queue');
		await play(player, { done: () => starts.length >= 4 });
		assert.deepEqual(starts.slice(0, 4), ['a', 'b', 'a', 'b']);
		player.stop();
	});

	it('loop "off" ends the last track once, as before', async () => {
		const dir = musicDir('a.wav');
		const fake = fakeSpawn(() => pcmSeconds(0.06));
		const ends = [];
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {}, onTrackEnd: (track, info) => ends.push({ title: track.title, ...info }) });
		await player.enqueue('a');
		await play(player, { done: () => !player.current });
		assert.deepEqual(ends, [{ title: 'a', queueEmpty: true }]);
		assert.equal(player.setLoop('sideways'), null, 'an unknown mode changes nothing');
		assert.deepEqual(LOOP_MODES, ['off', 'track', 'queue']);
	});

	it('skip moves on even when the track is on repeat; in a looped queue the skipped track goes to the back', async () => {
		const dir = musicDir('a.wav', 'b.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const ends = [];
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {}, onTrackEnd: (track, info) => ends.push({ title: track.title, ...info }) });
		await player.enqueue('a');
		await player.enqueue('b');
		player.setLoop('track');
		assert.equal(player.skip().title, 'a');
		assert.equal(player.current.title, 'b', 'skip is not overruled by the repeat');
		assert.deepEqual(player.queue, [], 'and the skipped track is not put back');
		assert.equal(player.skip().title, 'b');
		assert.equal(player.current, null, 'nothing else waiting: the music ends');
		assert.deepEqual(ends, [{ title: 'b', queueEmpty: true }], 'reported once, at the end');

		await player.enqueue('a');
		await player.enqueue('b');
		player.setLoop('queue');
		player.skip();
		assert.equal(player.current.title, 'b');
		assert.deepEqual(player.queue.map((track) => track.title), ['a'], 'still part of the rotation');
		player.stop();
		assert.equal(player.loop, 'off', 'stopping the music ends the repeat as well');
	});
});

describe('MusicPlayer: seeking and the position in the track', () => {
	it('counts the frames the bridge took: a pause stands still, a seek starts the count at its new place', async () => {
		const dir = musicDir('a.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {} });
		await player.enqueue('a');
		await readFrames(player, 10);
		assert.equal(player.elapsed, 0.2);
		player.pause();
		const dst = new Int16Array(STEREO_SAMPLES_PER_FRAME_48K);
		for (let i = 0; i < 20; i++) player.readFrame(dst);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(player.elapsed, 0.2, 'paused: the wall clock moved, the track did not');
		player.resume();
		await readFrames(player, 5);
		assert.equal(Math.round(player.elapsed * 1000), 300);

		const result = player.seek(60);
		assert.deepEqual([Math.round(result.from * 1000), result.to], [300, 60]);
		assert.equal(player.elapsed, 60, 'the new place, before a frame of it has played');
		const decoder = fake.ffmpegCalls().at(-1).args;
		assert.deepEqual(decoder.slice(decoder.indexOf('-ss'), decoder.indexOf('-i') + 2), ['-ss', '60.000', '-i', path.join(dir, 'a.wav')]);
		await readFrames(player, 5);
		assert.equal(Math.round(player.elapsed * 1000), 60_100);

		player.seekBy(-100);
		assert.equal(player.elapsed, 0, 'a step back past the start lands on the start');
		assert.equal(fake.ffmpegCalls().at(-1).args.includes('-ss'), false);
		assert.match(player.nowPlayingText(), /\(0:00 in\)/);
		player.stop();
		assert.equal(player.elapsed, 0);
	});

	it('restarts a link through a fresh, unchanged yt-dlp call and seeks after the pipe; a paused track stays paused', async () => {
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ spawnImpl: fake.spawn, log: () => {} });
		player.queue.push(urlTrack('Song', { duration: 240 }));
		player.startNext();
		const first = fake.spawned.find((entry) => !entry.args.includes('pipe:1'));
		player.pause();
		player.seek(95);
		assert.equal(first.child.killed, true, 'the old download goes');
		const downloads = fake.spawned.filter((entry) => !entry.args.includes('pipe:1'));
		assert.equal(downloads.length, 2);
		const again = downloads[1].args;
		assert.equal(again[0], '--ignore-config');
		assert.deepEqual(again.slice(-2), ['--', 'https://www.youtube.com/watch?v=Song'], 'the link stays the one positional argument');
		assert.equal(again.includes('-ss'), false, 'yt-dlp is asked for the same thing as before');
		const decoder = fake.ffmpegCalls().at(-1).args;
		assert.deepEqual(decoder.slice(decoder.indexOf('-i'), decoder.indexOf('-i') + 4), ['-i', 'pipe:0', '-ss', '95.000']);
		assert.equal(player.paused, true, 'seeking does not unpause');
		assert.match(player.nowPlayingText(), /^Paused: Song \(1:35 \/ 4:00\)\./);
		assert.throws(() => player.seek(240), new RegExp(SEEK_PAST_END), 'past the end of a known length is refused');
		assert.equal(player.elapsed, 95, 'and nothing moved');
		player.stop();
	});

	it('a seek past the end of a local file (length unknown) ends the track instead of failing it', async () => {
		const dir = musicDir('a.wav', 'b.wav');
		const fake = fakeSpawn((input, args) => (args.includes('-ss') ? null : pcmSeconds(1)));
		const failed = [];
		const starts = [];
		const player = new MusicPlayer({
			musicDir: dir,
			spawnImpl: fake.spawn,
			log: () => {},
			onError: (track) => failed.push(track.title),
			onTrackStart: (track) => starts.push(track.title),
		});
		await player.enqueue('a');
		await player.enqueue('b');
		player.seek(3600);
		await play(player, { done: () => starts.length >= 2 });
		assert.deepEqual(failed, []);
		assert.deepEqual(starts, ['a', 'b'], 'over, so the next track plays');
		assert.equal(player.history.at(-1).title, 'a');
		player.stop();
	});
});

describe('MusicPlayer: saving and restoring the queue', () => {
	it('snapshots what the tracks are and where the current one is, without who asked or what they said', async () => {
		const dir = musicDir('a.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {} });
		await player.enqueue('a', { requestedBy: 'Jane' });
		player.queue.push(urlTrack('Next', { duration: 200, requestedBy: 'Ali', query: 'next please' }));
		player.setLoop('queue');
		player.setVolume(0.5);
		await readFrames(player, 50);
		const snapshot = player.snapshot();
		assert.deepEqual(snapshot, {
			volume: 0.5,
			loop: 'queue',
			current: { kind: 'file', url: path.join(dir, 'a.wav'), title: 'a', uploader: null, duration: null, position: 1 },
			queue: [{ kind: 'url', url: 'https://www.youtube.com/watch?v=Next', title: 'Next', uploader: null, duration: 200 }],
		});
		assert.doesNotMatch(JSON.stringify(snapshot), /Jane|Ali|please/);
		player.stop();
	});

	it('restores paused and silent, drops what can no longer be played, and starts only on resume, from the saved place', async () => {
		const dir = musicDir('a.wav');
		const elsewhere = musicDir('outside.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const starts = [];
		const player = new MusicPlayer({ musicDir: dir, maxMinutes: 20, spawnImpl: fake.spawn, log: () => {}, onTrackStart: (track) => starts.push(track.title) });
		const result = player.restore({
			volume: 0.4,
			loop: 'track',
			current: { kind: 'file', url: path.join(dir, 'a.wav'), title: 'a', position: 42 },
			queue: [
				{ kind: 'url', url: 'https://www.youtube.com/watch?v=ok', title: 'Kept', duration: 200 },
				{ kind: 'url', url: 'http://192.168.1.10/stream', title: 'Not a media site' },
				{ kind: 'url', url: 'file:///etc/passwd', title: 'Not a link' },
				{ kind: 'file', url: path.join(elsewhere, 'outside.wav'), title: 'Outside MUSIC_DIR' },
				{ kind: 'file', url: path.join(dir, 'gone.wav'), title: 'Deleted since' },
				{ kind: 'url', url: 'https://youtu.be/long', title: 'Over the limit now', duration: 3600 },
				{ kind: 'script', url: 'x', title: 'Unknown kind' },
			],
		});
		assert.deepEqual([result.restored, result.dropped, result.current.title], [2, 6, 'a']);
		assert.deepEqual(player.queue.map((track) => track.title), ['Kept']);
		assert.deepEqual([player.volume, player.loop, player.paused, player.parked], [0.4, 'track', true, true]);
		assert.equal(player.elapsed, 42);
		assert.equal(fake.spawned.length, 0, 'nothing is started by a restore');
		assert.deepEqual(starts, [], 'and nothing is announced');
		assert.match(player.nowPlayingText(), /^Paused: a \(0:42 in\)\./);
		const dst = new Int16Array(STEREO_SAMPLES_PER_FRAME_48K);
		assert.equal(player.readFrame(dst), 0, 'the bridge gets silence');

		assert.equal(player.resume(), true);
		assert.deepEqual(starts, ['a']);
		const decoder = fake.ffmpegCalls()[0].args;
		assert.deepEqual(decoder.slice(decoder.indexOf('-ss'), decoder.indexOf('-i') + 2), ['-ss', '42.000', '-i', path.join(dir, 'a.wav')]);
		await readFrames(player, 5);
		assert.equal(Math.round(player.elapsed * 10), 421);
		player.stop();
	});

	it('a play request while a restored queue waits plays at once, with the restored track right behind it', async () => {
		const dir = musicDir('a.wav', 'new.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {} });
		player.restore({ current: { kind: 'file', url: path.join(dir, 'a.wav'), title: 'a', position: 30 }, queue: [urlTrack('Later')] });
		const played = await player.enqueue('new');
		assert.equal(played.startedNow, true);
		assert.equal(player.current.title, 'new');
		assert.equal(player.paused, false);
		assert.deepEqual(player.queue.map((track) => track.title), ['a', 'Later']);
		assert.equal(player.snapshot().queue[0].position, 30, 'the restored track keeps its place in itself too');
		player.skip();
		const decoder = fake.ffmpegCalls().at(-1).args;
		assert.equal(decoder[decoder.indexOf('-ss') + 1], '30.000', 'and carries on from there when its turn comes');
		player.stop();
	});

	it('finds yt-dlp the proper way before resuming a restored link, which never went through a lookup this run', async () => {
		const bin = path.join(musicDir('yt-dlp'), 'yt-dlp');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ ytDlpPath: bin, spawnImpl: fake.spawn, log: () => {} });
		player.restore({ current: { kind: 'url', url: 'https://www.youtube.com/watch?v=one', title: 'One', duration: 200, position: 20 }, queue: [] });
		player.resume();
		assert.equal(player.parked, false, 'on its way, no longer waiting');
		await new Promise((resolve) => setImmediate(resolve));
		const download = fake.spawned.find((entry) => !entry.args.includes('pipe:1'));
		assert.equal(download.binary, bin, 'the configured yt-dlp, not whatever "yt-dlp" PATH holds');
		assert.deepEqual(download.args.slice(-2), ['--', 'https://www.youtube.com/watch?v=one']);
		const decoder = fake.ffmpegCalls()[0].args;
		assert.deepEqual(decoder.slice(decoder.indexOf('-i'), decoder.indexOf('-i') + 4), ['-i', 'pipe:0', '-ss', '20.000']);

		// Skipped while the lookup is still under way: the lookup's answer must not start the old track.
		const late = new MusicPlayer({ ytDlpPath: bin, spawnImpl: fake.spawn, log: () => {} });
		late.restore({ current: { kind: 'url', url: 'https://www.youtube.com/watch?v=two', title: 'Two' }, queue: [] });
		late.resume();
		late.stop();
		const before = fake.spawned.length;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fake.spawned.length, before);
		player.stop();
	});

	it('leaves a player that already holds music alone', () => {
		const player = new MusicPlayer({ spawnImpl: fakeSpawn(() => null).spawn, log: () => {} });
		player.queue.push(urlTrack('Mine'));
		const result = player.restore({ queue: [urlTrack('Saved')] });
		assert.equal(result.restored, 0);
		assert.deepEqual(player.queue.map((track) => track.title), ['Mine']);
	});

	it('tells the saved queue about every change, and on shutdown hands it the last snapshot before emptying itself', async () => {
		const dir = musicDir('a.wav', 'b.wav');
		const fake = fakeSpawn(() => pcmSeconds(1));
		const saved = [];
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {} });
		player.onChange = () => saved.push(player.snapshot());
		await player.enqueue('a');
		await player.enqueue('b');
		player.setLoop('queue');
		player.shuffle();
		player.move(1, 1);
		const count = saved.length;
		assert.ok(count >= 4, `every change was reported (${count})`);
		player.destroy();
		assert.equal(saved.length, count + 1, 'one last snapshot, and nothing after it');
		assert.equal(saved.at(-1).current.title, 'a');
		assert.deepEqual(saved.at(-1).queue.map((track) => track.title), ['b']);
		assert.equal(player.current, null);
	});
});
