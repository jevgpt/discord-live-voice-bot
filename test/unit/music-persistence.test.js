import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { MusicPlayer } from '../../src/music.js';
import { ActivityLog } from '../../src/panel.js';
import { QueueStore } from '../../src/queuestore.js';
import { ChannelReader } from '../../src/reader.js';

// The music queue kept between runs: the store under data/ (one entry per server, tmp+rename writes), and
// the session around it, which takes a server's queue back when it starts and writes it on every change.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'music-queues-'));
const idle = () => ({ spawn: () => assert.fail('nothing may be started by a restore') });

describe('QueueStore', () => {
	it('round-trips one entry per server through the file, stamped with when it was saved', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		const store = new QueueStore(file, { now: () => 1234 });
		const snapshot = { volume: 0.3, loop: 'queue', current: { kind: 'url', url: 'https://youtu.be/a', title: 'A', position: 12 }, queue: [] };
		store.put('alpha', snapshot);
		store.put('beta', { volume: 1, loop: 'off', current: null, queue: [] });
		await store.save();
		const loaded = await new QueueStore(file).load();
		assert.deepEqual(loaded.get('alpha'), { ...snapshot, savedAt: 1234 });
		assert.equal(loaded.get('beta').volume, 1);
		assert.equal(loaded.get('gamma'), null);
		loaded.get('alpha').queue.push('changed');
		assert.deepEqual(loaded.get('alpha').queue, [], 'get() hands out a copy');
		assert.deepEqual(readdirSync(path.dirname(file)), ['music-queues.json'], 'no .tmp file is left behind');
	});

	it('coalesces a burst of saves, and the file ends up with the last state', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		const store = new QueueStore(file);
		const writes = [];
		for (let i = 0; i < 20; i++) {
			store.put('alpha', { volume: i / 20, loop: 'off', current: null, queue: [] });
			writes.push(store.save());
		}
		assert.ok(new Set(writes).size <= 2, 'one write running and one queued behind it, however many were asked for');
		await Promise.all(writes);
		await store.flush();
		assert.equal(JSON.parse(readFileSync(file, 'utf8')).guilds.alpha.volume, 19 / 20);
	});

	it('starts empty from a missing file, and keeps a broken one aside instead of refusing to start', async () => {
		const dir = tmp();
		assert.equal((await new QueueStore(path.join(dir, 'none.json')).load()).get('alpha'), null);
		const file = path.join(dir, 'broken.json');
		writeFileSync(file, '{ not json');
		const lines = [];
		const store = await new QueueStore(file, { log: (line) => lines.push(line) }).load();
		assert.equal(store.get('alpha'), null);
		assert.equal(lines.length, 1);
		assert.ok(readdirSync(dir).some((name) => name.startsWith('broken.json.') && name !== 'broken.json'), 'the broken file was kept');
	});

	it('a player snapshot survives the file and comes back paused, with the disallowed links dropped', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		const before = new MusicPlayer({ spawnImpl: idle().spawn, log: () => {} });
		before.restore({
			volume: 0.6,
			loop: 'queue',
			current: { kind: 'url', url: 'https://www.youtube.com/watch?v=one', title: 'One', duration: 180, position: 61 },
			queue: [{ kind: 'url', url: 'https://soundcloud.com/two', title: 'Two', duration: 200 }],
		});
		const store = new QueueStore(file);
		store.put('alpha', before.snapshot());
		// Somebody edits the file by hand: a link to a machine on the owner's own network.
		const raw = JSON.parse(JSON.stringify(Object.fromEntries(store.guilds)));
		raw.alpha.queue.push({ kind: 'url', url: 'http://10.0.0.5:8080/admin', title: 'Sneaky' });
		writeFileSync(file, JSON.stringify({ guilds: raw }));

		const after = new MusicPlayer({ spawnImpl: idle().spawn, log: () => {} });
		const result = after.restore((await new QueueStore(file).load()).get('alpha'));
		assert.deepEqual([result.restored, result.dropped], [2, 1]);
		assert.deepEqual([after.current.title, after.elapsed, after.paused, after.parked], ['One', 61, true, true]);
		assert.deepEqual(after.queue.map((track) => track.title), ['Two']);
		assert.deepEqual([after.volume, after.loop], [0.6, 'queue']);
	});
});

// ---------------------------------------------------------------- the session around it

function makeGuild(id) {
	const voice = { id: `${id}-voice`, name: 'Lounge', type: ChannelType.GuildVoice, parent: null, parentId: null, rawPosition: 0 };
	return {
		id,
		name: id,
		channels: { cache: new Map([[voice.id, voice]]) },
		members: { cache: new Map(), fetch: async () => new Map() },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
	};
}

function makeSession({ queueStore, guildId = 'alpha' }) {
	const cfg = loadConfig({ DISCORD_TOKEN: 't', GUILD_ID: guildId, CHANNEL_ID: `${guildId}-voice`, OPENAI_API_KEY: 'k', OWNER_ID: 'owner' });
	const activity = new ActivityLog();
	const lines = [];
	const session = new GuildSession({
		cfg,
		client: { user: { id: 'bot' } },
		guild: makeGuild(guildId),
		channelId: `${guildId}-voice`,
		store: { getActive: () => null, list: () => [], setActive: async () => true },
		memory: null,
		quota: { enabled: false, status: () => ({ used: 0, limit: 0, exceeded: false }), sessionStarted() {}, shouldWarn: () => false },
		reader: new ChannelReader(),
		recentActions: new RecentActions(),
		queueStore,
		activity,
		record: (event) => activity.push(event),
		provider: { textClient: {}, textApi: 'responses', textModel: 'm', describe: () => 'mock' },
		openai: {},
		localStt: {},
		localServer: null,
		log: (line) => lines.push(String(line)),
		summarize: async () => ({ summary: '' }),
	});
	return { session, lines };
}

describe('GuildSession: the saved music queue', () => {
	it('takes its own server\'s queue back paused, says so in the log, and writes every change after that', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		const store = new QueueStore(file);
		store.put('alpha', {
			volume: 0.5,
			loop: 'off',
			current: { kind: 'url', url: 'https://www.youtube.com/watch?v=one', title: 'One', duration: 180, position: 75 },
			queue: [
				{ kind: 'url', url: 'https://www.youtube.com/watch?v=two', title: 'Two', duration: 200 },
				{ kind: 'url', url: 'https://example.com/not-media', title: 'Nope' },
			],
		});
		store.put('beta', { volume: 0.9, loop: 'off', current: { kind: 'url', url: 'https://youtu.be/b', title: 'Beta song' }, queue: [] });
		const { session, lines } = makeSession({ queueStore: store });
		const result = session.restoreMusicQueue();
		assert.deepEqual([result.restored, result.dropped], [2, 1]);
		assert.equal(session.music.current.title, 'One', "this server's queue, not the other one's");
		assert.deepEqual([session.music.paused, session.music.parked, session.music.volume], [true, true, 0.5]);
		assert.ok(
			lines.some((line) => line.includes('restored the saved queue (2 tracks)') && line.includes('"One" at 1:15') && line.includes('1 dropped')),
			lines.join(' | '),
		);
		assert.equal(session.status().music.playing, false, 'nothing plays until somebody asks');

		session.music.setLoop('track');
		await store.flush();
		const written = JSON.parse(readFileSync(file, 'utf8')).guilds;
		assert.equal(written.alpha.loop, 'track');
		assert.deepEqual(written.alpha.queue.map((track) => track.title), ['Two'], 'the dropped link is gone from the file too');
		assert.equal(written.beta.current.title, 'Beta song', 'the other server is untouched');
	});

	it('shutting down keeps the queue on disk; somebody stopping the music clears it', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		const store = new QueueStore(file);
		store.put('alpha', { volume: 0.4, loop: 'queue', current: { kind: 'url', url: 'https://youtu.be/one', title: 'One', position: 10 }, queue: [] });
		const first = makeSession({ queueStore: store });
		first.session.restoreMusicQueue();
		first.session.stop();
		await store.flush();
		const kept = JSON.parse(readFileSync(file, 'utf8')).guilds.alpha;
		assert.equal(kept.current.title, 'One', 'the empty player a shutdown leaves is not written over the queue');
		assert.equal(kept.loop, 'queue');

		const second = makeSession({ queueStore: await new QueueStore(file).load() });
		second.session.restoreMusicQueue();
		assert.equal(second.session.music.current.title, 'One', 'and the next start finds it');
		second.session.music.stop();
		await second.session.queueStore.flush();
		const cleared = JSON.parse(readFileSync(file, 'utf8')).guilds.alpha;
		assert.deepEqual([cleared.current, cleared.queue, cleared.loop], [null, [], 'off']);
		second.session.stop();
	});

	// Found in review: {"title": {"toString": 1}} in the file made restore() throw inside start(), so the
	// server never came up, and the stop() after that wrote the empty player over the saved queue.
	it('a saved queue that cannot be read back costs the queue, not the server, and is not written over', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		const saved = { volume: 0.4, loop: 'off', current: { kind: 'url', url: 'https://youtu.be/one', title: 'One' }, queue: [] };
		const store = new QueueStore(file);
		store.put('alpha', saved);
		await store.save();
		const { session, lines } = makeSession({ queueStore: await new QueueStore(file).load() });
		session.music.restore = () => {
			throw new TypeError('Cannot convert object to primitive value');
		};
		assert.doesNotThrow(() => session.restoreMusicQueue());
		assert.equal(session.music.current, null, 'it starts with no queue');
		assert.ok(lines.some((line) => line.includes('could not be read back') && line.includes('Cannot convert')), lines.join(' | '));

		session.music.setVolume(0.9);
		session.stop();
		await session.queueStore.flush();
		assert.equal(JSON.parse(readFileSync(file, 'utf8')).guilds.alpha.current.title, 'One', 'neither a change to nothing nor the shutdown wrote over it');

		// The first time the player holds music again, that is the queue from then on.
		const next = makeSession({ queueStore: await new QueueStore(file).load() });
		next.session.music.restore = () => {
			throw new TypeError('still broken');
		};
		next.session.restoreMusicQueue();
		next.session.music.queue.push({ kind: 'url', url: 'https://youtu.be/two', title: 'Two', id: 2 });
		next.session.music.setVolume(0.5);
		await next.session.queueStore.flush();
		assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).guilds.alpha.queue.map((track) => track.title), ['Two']);
		next.session.music.queue.length = 0;
		next.session.stop();
	});

	it('restores a hand-edited queue with objects where the text should be, instead of failing the start', async () => {
		const file = path.join(tmp(), 'music-queues.json');
		writeFileSync(
			file,
			JSON.stringify({
				guilds: {
					alpha: {
						volume: 0.5,
						current: { kind: 'url', url: 'https://youtu.be/one', title: { toString: 1 }, duration: { valueOf: 1, toString: 1 } },
						queue: [{ kind: 'url', url: 'https://youtu.be/two\u0000', title: 'Poisoned' }],
					},
				},
			}),
		);
		const { session } = makeSession({ queueStore: await new QueueStore(file).load() });
		const result = session.restoreMusicQueue();
		assert.deepEqual([result.restored, result.dropped], [1, 1]);
		assert.deepEqual([session.music.current.url, session.music.current.duration], ['https://youtu.be/one', null]);
		session.stop();
	});

	it('without a store (the tests, MUSIC=0 builds) a change is simply not kept, and nothing is restored', () => {
		const { session } = makeSession({ queueStore: null });
		assert.equal(session.restoreMusicQueue(), null);
		assert.doesNotThrow(() => session.music.setVolume(0.2));
		assert.equal(session.music.volume, 0.2);
		session.stop();
	});
});
