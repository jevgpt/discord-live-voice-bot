import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { PlaybackQueue, SpeakerMixer, STEREO_SAMPLES_PER_FRAME_48K } from '../../src/audio.js';
import { AudioBridge } from '../../src/bridge.js';
import {
	LOOP_MODES,
	MAX_SEEK_SECONDS,
	MusicPlayer,
	SEEK_OUT_OF_RANGE,
	SEEK_PAST_END,
	SEEK_UNSUPPORTED,
	decoderArgs,
	parseSeekTarget,
} from '../../src/music.js';
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

// ---------------------------------------------------------------- a saved queue nobody can trust

describe('MusicPlayer: a saved queue is read as data, whatever is in it', () => {
	// Found in review: a link with a NUL byte in it passed the host check (URL() percent-encodes it), was
	// handed to spawn() raw, and spawn() threw inside the bridge's tick: the process shut down, the shutdown
	// saved the same link as the one playing, and the next start crashed on it again.
	it('drops a link with a control character in it, and keeps every other link in the form the check read it in', () => {
		const player = new MusicPlayer({ spawnImpl: () => assert.fail('nothing may be started by a restore'), log: () => {} });
		const result = player.restore({
			current: { kind: 'url', url: 'https://www.youtube.com/watch?v=aaa', title: 'A', duration: 100 },
			queue: [
				{ kind: 'url', url: 'https://www.youtube.com/watch?v=bbb\u0000', title: 'NUL' },
				{ kind: 'url', url: 'https://evil.example\t@youtube.com/x', title: 'Tab' },
				{ kind: 'url', url: 'https://www.youtube.com/watch?v=c\r\nd', title: 'Line break' },
				{ kind: 'url', url: 'HTTPS://YouTube.com/watch?v=Kept', title: 'Kept' },
			],
		});
		assert.deepEqual([result.restored, result.dropped], [2, 3]);
		assert.deepEqual(
			player.queue.map((track) => [track.title, track.url]),
			[['Kept', 'https://youtube.com/watch?v=Kept']],
			'the written-out form is what will be played',
		);
	});

	it('takes nothing but the types it wrote: objects in any field neither throw nor get through', () => {
		const dir = musicDir('a.wav');
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: () => assert.fail('nothing may be started by a restore'), log: () => {} });
		const trap = { toString: 1, valueOf: 1 };
		let result;
		assert.doesNotThrow(() => {
			result = player.restore({
				volume: trap,
				loop: trap,
				current: { kind: 'url', url: 'https://youtu.be/x', title: trap, uploader: trap, duration: trap, position: trap },
				queue: [
					{ kind: 'url', url: trap, title: 'Link object' },
					{ kind: 'file', url: trap, title: 'Path object' },
					{ kind: 'file', url: path.join(dir, 'a.wav\u0000'), title: 'Path with a NUL' },
					['not', 'an', 'entry'],
					{ kind: 'url', url: 'https://youtu.be/y', title: 'Line\u0000one\nand two', uploader: 'Band\u0007' },
				],
			});
		});
		assert.deepEqual([result.restored, result.dropped], [2, 4]);
		assert.deepEqual([player.current.title, player.current.duration, player.current.uploader], ['x', null, null]);
		assert.equal(player.elapsed, 0, 'an object is no position');
		assert.deepEqual([player.volume, player.loop], [0.35, 'off'], 'nor a volume or a loop mode');
		assert.deepEqual([player.queue[0].title, player.queue[0].uploader], ['Line one and two', 'Band'], 'a title is kept, without its control characters');
	});

	it('keeps a saved place only where a decoder can start from it', () => {
		const dir = musicDir('a.wav');
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fakeSpawn(() => null).spawn, log: () => {} });
		player.restore({
			current: { kind: 'file', url: path.join(dir, 'a.wav'), title: 'a', position: 1e300 },
			queue: [
				{ kind: 'url', url: 'https://www.twitch.tv/somebody', title: 'Live', position: 1800 },
				{ kind: 'url', url: 'https://youtu.be/known', title: 'Known', duration: 200, position: 60 },
			],
		});
		assert.equal(player.elapsed, 0, 'no track is 1e300 seconds long');
		assert.equal(player.queue[0].startAt, undefined, 'a stream of no known length starts from now');
		assert.equal(player.queue[1].startAt, 60);
	});
});

describe('MusicPlayer: a decoder that cannot even be started', () => {
	it('fails the track, a moment later, when spawn() throws instead of reporting, and plays the next one', async () => {
		const fake = fakeSpawn(() => pcmSeconds(1));
		const failed = [];
		const player = new MusicPlayer({
			log: () => {},
			onError: (track, message) => failed.push([track.title, message]),
			spawnImpl: (binary, args, options) => {
				if (args.at(-1) === 'https://www.youtube.com/watch?v=Broken') {
					throw Object.assign(new TypeError('The argument must be a string without null bytes'), { code: 'ERR_INVALID_ARG_VALUE' });
				}
				return fake.spawn(binary, args, options);
			},
		});
		player.ytDlp = 'yt-dlp';
		player.queue.push(urlTrack('Broken', { duration: 100 }), urlTrack('Fine', { duration: 100 }));
		assert.doesNotThrow(() => player.startNext(), 'the throw does not travel up into whoever asked for the next track');
		assert.equal(player.parked, false, 'waiting on its failure, not parked');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(failed.length, 1);
		assert.equal(failed[0][0], 'Broken');
		assert.match(failed[0][1], /null bytes/u);
		assert.equal(player.current.title, 'Fine', 'the next track plays');
		player.stop();
	});

	it('does the same with the real spawn(): a NUL in a link never reaches a process', async () => {
		const failed = [];
		const player = new MusicPlayer({ ytDlpPath: '/nonexistent/yt-dlp', ffmpegPath: '/nonexistent/ffmpeg', log: () => {}, onError: (track) => failed.push(track.title) });
		player.ytDlp = '/nonexistent/yt-dlp';
		player.queue.push({ kind: 'url', url: 'https://www.youtube.com/watch?v=bbb\u0000', title: 'Poisoned', id: 1 });
		player.startNext();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(failed, ['Poisoned']);
		assert.equal(player.current, null);
	});

	it('a skip before the failure lands is not undone by it', async () => {
		const fake = fakeSpawn(() => pcmSeconds(1));
		const failed = [];
		const player = new MusicPlayer({
			log: () => {},
			onError: (track) => failed.push(track.title),
			spawnImpl: (binary, args, options) => {
				if (args.at(-1).endsWith('Broken')) throw new TypeError('refused');
				return fake.spawn(binary, args, options);
			},
		});
		player.ytDlp = 'yt-dlp';
		player.queue.push(urlTrack('Broken'), urlTrack('Next'));
		player.startNext();
		player.skip();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(failed, [], 'the refused track was already gone');
		assert.equal(player.current.title, 'Next');
		player.stop();
	});
});

describe('AudioBridge: a music player that throws costs the music, not the process', () => {
	const sink = () => {
		const written = [];
		const out = new Writable({
			write(chunk, _enc, cb) {
				written.push(chunk);
				cb();
			},
		});
		return { out, written };
	};

	it('treats the throw as silence, logs it once per run of failures, and plays again when the player recovers', () => {
		const logged = [];
		let failing = true;
		const music = {
			active: true,
			volume: 1,
			duckRatio: 0.2,
			readFrame: (dst, n) => {
				if (failing) throw new TypeError('The argument must be a string without null bytes');
				dst.fill(1000, 0, n);
				return n;
			},
		};
		const { out, written } = sink();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => null, music, log: (line) => logged.push(line) });
		for (let i = 0; i < 5; i++) assert.equal(bridge.tick().music, false);
		assert.equal(written.length, 5, 'the output kept getting its frames');
		assert.equal(logged.length, 1, 'said once, not fifty times a second');
		assert.match(logged[0], /null bytes/u);
		failing = false;
		assert.equal(bridge.tick().music, true);
		failing = true;
		bridge.tick();
		assert.equal(logged.length, 2, 'a new failure after a recovery is news again');
	});

	it('keeps ticking over a link with a NUL byte in it, from resume to the failure', async () => {
		const failed = [];
		const player = new MusicPlayer({ ytDlpPath: '/nonexistent/yt-dlp', ffmpegPath: '/nonexistent/ffmpeg', log: () => {}, onError: (track) => failed.push(track.title) });
		// What restore() can no longer produce, put in place by hand: the pipeline is the last line of defence.
		player.ytDlp = '/nonexistent/yt-dlp';
		player.current = { kind: 'url', url: 'https://www.youtube.com/watch?v=bbb\u0000', title: 'Poisoned', id: 1, duration: 10 };
		player.paused = true;
		const { out } = sink();
		const bridge = new AudioBridge({ mixer: new SpeakerMixer(), playback: new PlaybackQueue(), output: out, getLive: () => null, music: player, log: () => {} });
		assert.doesNotThrow(() => {
			player.resume();
			bridge.tick();
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.doesNotThrow(() => bridge.tick());
		assert.deepEqual(failed, ['Poisoned']);
	});
});

describe('MusicPlayer: seeking stays inside the track', () => {
	it('will not seek a link of no known length (a live stream) anywhere but its start', () => {
		const fake = fakeSpawn(() => null);
		const player = new MusicPlayer({ spawnImpl: fake.spawn, log: () => {} });
		player.ytDlp = 'yt-dlp';
		player.queue.push({ kind: 'url', url: 'https://www.twitch.tv/somebody', title: 'Live', id: 1, duration: null });
		player.startNext();
		// Half an hour into the stream: "rewind 10 seconds" was -ss 1790 on a stream that starts again at
		// now, which is half an hour of silence.
		player.samplesRead = RATE_SAMPLES * 1800;
		const spawnedBefore = fake.spawned.length;
		assert.throws(() => player.seekBy(-10), new RegExp(SEEK_UNSUPPORTED));
		assert.throws(() => player.seek(90), new RegExp(SEEK_UNSUPPORTED));
		assert.equal(fake.spawned.length, spawnedBefore, 'no new decoder was started');
		assert.equal(Math.round(player.elapsed), 1800, 'and nothing moved');
		assert.equal(player.seek(0).to, 0, 'starting it over is still fine');
		assert.equal(fake.ffmpegCalls().at(-1).args.includes('-ss'), false);
		player.stop();
	});

	it('refuses a place that is in no track: NaN, Infinity, 1e308, more than a day', () => {
		const dir = musicDir('a.wav');
		const fake = fakeSpawn(() => null);
		const player = new MusicPlayer({ musicDir: dir, spawnImpl: fake.spawn, log: () => {} });
		player.queue.push({ kind: 'file', url: path.join(dir, 'a.wav'), title: 'a', id: 1, duration: null });
		player.startNext();
		const spawnedBefore = fake.spawned.length;
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1e308, MAX_SEEK_SECONDS + 1]) {
			assert.throws(() => player.seek(value), new RegExp(SEEK_OUT_OF_RANGE), String(value));
			assert.throws(() => player.seekBy(value), new RegExp(SEEK_OUT_OF_RANGE), String(value));
		}
		assert.equal(fake.spawned.length, spawnedBefore);
		assert.equal(player.elapsed, 0);
		player.stop();
		for (const from of [Number.POSITIVE_INFINITY, Number.NaN, 1e21]) {
			assert.equal(decoderArgs({ kind: 'file', url: '/music/a.mp3' }, from).includes('-ss'), false, `no -ss for ${from}`);
		}
	});
});

describe('MusicPlayer: asking for the track a restored queue waits on', () => {
	it('plays it, from where it was left, instead of answering that it is already playing', async () => {
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ spawnImpl: fake.spawn, log: () => {} });
		player.ytDlp = 'yt-dlp';
		player.restore({ current: { kind: 'url', url: 'https://www.youtube.com/watch?v=abc', title: 'Song', duration: 200, position: 42 }, queue: [] });
		player.resolve = async () => ({ kind: 'url', url: 'https://www.youtube.com/watch?v=abc', title: 'Song', duration: 200 });
		const result = await player.enqueue('Song');
		assert.equal(result.duplicate, undefined);
		assert.equal(result.startedNow, true);
		assert.deepEqual([player.parked, player.playing, player.queue.length], [false, true, 0]);
		const decoder = fake.ffmpegCalls().at(-1).args;
		assert.equal(decoder[decoder.indexOf('-ss') + 1], '42.000', 'from where it was left');
		const again = await player.enqueue('Song');
		assert.equal(again.duplicate, true, 'once it plays, asking again is the same request twice');
		player.stop();
	});

	it('plays one waiting behind it at once, with the restored track right behind that, and no second copy', async () => {
		const fake = fakeSpawn(() => pcmSeconds(1));
		const player = new MusicPlayer({ spawnImpl: fake.spawn, log: () => {} });
		player.ytDlp = 'yt-dlp';
		player.restore({
			current: { kind: 'url', url: 'https://www.youtube.com/watch?v=one', title: 'One', duration: 200, position: 30 },
			queue: [{ kind: 'url', url: 'https://www.youtube.com/watch?v=two', title: 'Two', duration: 200 }],
		});
		player.resolve = async () => ({ kind: 'url', url: 'https://www.youtube.com/watch?v=two', title: 'Two', duration: 200 });
		const result = await player.enqueue('Two');
		assert.equal(result.startedNow, true);
		assert.equal(player.current.title, 'Two');
		assert.deepEqual(player.queue.map((track) => track.title), ['One']);
		assert.equal(player.snapshot().queue[0].position, 30);
		player.stop();
	});
});
