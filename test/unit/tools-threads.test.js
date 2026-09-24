import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { callTool, toolMeta } from '../../src/tools.js';
import { ownerVoice } from '../owner-voice.js';

const SELF = 'bot-1';

/** Permission double: `held` is the list of PermissionFlagsBits keys the bot has in this channel. */
function permissions(held) {
	const bits = held.map((flag) => PermissionFlagsBits[flag]);
	return { has: (flag) => bits.includes(flag) };
}

/**
 * Mock guild with a text channel, a forum channel and one live thread in each.
 * `held` is what the bot may do; every tool checks it before touching the API.
 */
function makeDeps({ owner = false, held = ['ManageThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessages', 'SendMessagesInThreads'] } = {}) {
	const calls = [];
	const perms = permissions(held);
	const me = { id: SELF };

	const thread = {
		id: 't1',
		name: 'lunch plans',
		type: ChannelType.PublicThread,
		parentId: '10',
		ownerId: 'someone-else',
		archived: false,
		locked: false,
		memberCount: 3,
		messageCount: 7,
		permissionsFor: () => perms,
		setName: async (name) => calls.push({ renamed: name }),
		setArchived: async (archived) => calls.push({ archived }),
		setLocked: async (locked) => calls.push({ locked }),
		join: async () => calls.push({ joined: 't1' }),
		leave: async () => calls.push({ left: 't1' }),
		delete: async () => calls.push({ deleted: 't1' }),
		members: {
			add: async (id) => calls.push({ added: id }),
			remove: async (id) => calls.push({ removed: id }),
		},
	};
	const post = { ...thread, id: 't2', name: 'bug reports', parentId: '20' };

	const channel = {
		id: '10',
		name: 'chat',
		type: ChannelType.GuildText,
		permissionsFor: () => perms,
		messages: { fetch: async (id) => (id === 'm1' ? { id: 'm1', hasThread: false } : Promise.reject(new Error('Unknown Message'))) },
		threads: {
			create: async (options) => {
				calls.push({ created: options });
				return { ...thread, id: 't9', name: options.name, type: options.type ?? ChannelType.PublicThread };
			},
			fetchActive: async () => ({ threads: new Map([['t1', thread]]) }),
			fetchArchived: async () => ({ threads: new Map() }),
		},
	};
	const forum = {
		id: '20',
		name: 'help',
		type: ChannelType.GuildForum,
		availableTags: [{ id: 'tag1', name: 'question' }, { id: 'tag2', name: 'bug' }],
		permissionsFor: () => perms,
		threads: {
			create: async (options) => {
				calls.push({ posted: options });
				return { ...post, id: 't8', name: options.name };
			},
			fetchActive: async () => ({ threads: new Map([['t2', post]]) }),
			fetchArchived: async () => ({ threads: new Map() }),
		},
	};
	const voice = { id: 'v1', name: 'General', type: ChannelType.GuildVoice };

	const guild = {
		id: 'g1',
		channels: {
			cache: new Map([['10', channel], ['20', forum], ['v1', voice], ['t1', thread], ['t2', post]]),
			fetchActiveThreads: async () => ({ threads: new Map([['t1', thread], ['t2', post]]) }),
		},
		voiceStates: { cache: new Map() },
		members: {
			me,
			cache: new Map([['1', { id: '1', displayName: 'Jane Doe', user: { username: 'jane', bot: false } }]]),
			fetch: async () => new Map(),
		},
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		emojis: { cache: new Map() },
		stickers: { cache: new Map(), fetch: async () => {} },
	};
	const deps = {
		guild,
		selfId: SELF,
		cfg: { textChannelId: null },
		log: () => {},
		activity: () => {},
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, calls, guild, channel, forum, thread };
}

// The realtime path builds a fresh deps object for every call, so two-step confirmation has to survive that.
const perCall = (base) => ({ ...base });

const THREAD_TOOLS = [
	'list_threads',
	'start_thread',
	'create_forum_post',
	'rename_thread',
	'archive_thread',
	'lock_thread',
	'add_thread_member',
	'remove_thread_member',
	'join_thread',
	'leave_thread',
	'delete_thread',
];

describe('thread tools: registration and the owner gate', () => {
	it('registers every thread tool, gates the ones that change the server and leaves the listing open', () => {
		const meta = new Map(toolMeta().map((entry) => [entry.name, entry]));
		for (const name of THREAD_TOOLS) assert.ok(meta.has(name), `${name} is missing from the registry`);
		assert.equal(meta.get('list_threads').gated, false, 'listing threads is read-only');
		for (const name of THREAD_TOOLS.filter((tool) => tool !== 'list_threads')) {
			assert.equal(meta.get(name).gated, true, `${name} must be gated`);
			// Deleting gates on the verb: saying "thread" is not asking for one to go.
			const verb = name === 'delete_thread' ? 'delete' : 'thread';
			assert.ok(meta.get(name).keywords?.includes(verb), `${name} must be gated on the ${verb} keywords`);
		}
	});

	it('refuses every gated thread tool when the owner did not ask', async () => {
		for (const name of THREAD_TOOLS.filter((tool) => tool !== 'list_threads')) {
			const { deps, calls } = makeDeps();
			const result = await callTool(name, { thread: 'lunch plans', channel: 'chat', name: 'x', member: 'Jane', message: 'hi' }, deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.denied, true, `${name} must come back refused by the gate`);
			assert.deepEqual(calls, [], `${name} must not touch the API when it is refused`);
		}
	});
});

describe('list_threads', () => {
	it('lists the whole server without an owner', async () => {
		const { deps } = makeDeps();
		const result = await callTool('list_threads', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(result.data.threads.map((thread) => thread.name).sort(), ['bug reports', 'lunch plans']);
		assert.match(result.spoken, /lunch plans/);
	});

	it('lists one channel and reports a channel that cannot hold threads', async () => {
		const { deps } = makeDeps();
		const one = await callTool('list_threads', { channel: 'chat' }, deps);
		assert.equal(one.ok, true, one.spoken);
		assert.deepEqual(one.data.threads.map((thread) => thread.name), ['lunch plans']);

		const voice = await callTool('list_threads', { channel: 'General' }, deps);
		assert.equal(voice.ok, false);
		assert.match(voice.spoken, /cannot hold threads/);
	});

	it('falls back to the cache and warns when the archived list cannot be read', async () => {
		const { deps, channel } = makeDeps();
		channel.threads.fetchActive = async () => {
			throw new Error('Missing Access');
		};
		channel.threads.fetchArchived = async () => {
			throw new Error('Missing Access');
		};
		const result = await callTool('list_threads', { channel: 'chat', include_archived: true }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(result.data.threads.map((thread) => thread.name), ['lunch plans'], 'the cached thread is still listed');
		assert.match(result.warnings.join(' '), /Read Message History/);
	});
});

describe('start_thread', () => {
	it('starts a public thread in a text channel', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('start_thread', { channel: 'chat', name: 'weekend', auto_archive_hours: 24 }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(calls.at(-1).created.name, 'weekend');
		assert.equal(calls.at(-1).created.autoArchiveDuration, 1440);
		assert.equal(calls.at(-1).created.type, undefined, 'a public thread carries no explicit type');
	});

	it('starts a private thread and hangs one off a message', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const private_ = await callTool('start_thread', { channel: 'chat', name: 'mods', private: true, invitable: true }, deps);
		assert.equal(private_.ok, true, private_.spoken);
		assert.equal(calls.at(-1).created.type, ChannelType.PrivateThread);
		assert.equal(calls.at(-1).created.invitable, true);

		const onMessage = await callTool('start_thread', { channel: 'chat', name: 'about that', message_id: 'm1' }, deps);
		assert.equal(onMessage.ok, true, onMessage.spoken);
		assert.equal(calls.at(-1).created.startMessage.id, 'm1');
	});

	it('refuses a forum channel, a message it cannot find and a private thread that cannot be private', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const forum = await callTool('start_thread', { channel: 'help', name: 'x' }, deps);
		assert.equal(forum.ok, false);
		assert.match(forum.spoken, /forum/);

		const missing = await callTool('start_thread', { channel: 'chat', name: 'x', message_id: 'nope' }, deps);
		assert.equal(missing.ok, false);
		assert.match(missing.spoken, /could not find a message/);

		const impossible = await callTool('start_thread', { channel: 'chat', name: 'x', message_id: 'm1', private: true }, deps);
		assert.equal(impossible.ok, false);
		assert.match(impossible.spoken, /always public/);
		assert.deepEqual(calls, [], 'nothing was created');
	});

	it('says which permission it is missing instead of calling the API', async () => {
		const { deps, calls } = makeDeps({ owner: true, held: ['SendMessages'] });
		const result = await callTool('start_thread', { channel: 'chat', name: 'x' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Create Public Threads/);
		assert.deepEqual(calls, []);
	});
});

describe('create_forum_post', () => {
	it('creates a post with a body and the tags the forum offers', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('create_forum_post', { channel: 'help', name: 'crash on start', message: 'It dies on boot.', tags: ['bug', 'nonsense'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(calls.at(-1).posted.message.content, 'It dies on boot.');
		assert.deepEqual(calls.at(-1).posted.appliedTags, ['tag2']);
		assert.match(result.warnings.join(' '), /nonsense/);
	});

	it('refuses a channel that is not a forum, and a post with no body', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const wrongType = await callTool('create_forum_post', { channel: 'chat', name: 'x', message: 'hi' }, deps);
		assert.equal(wrongType.ok, false);
		assert.match(wrongType.spoken, /not a forum/);

		const empty = await callTool('create_forum_post', { channel: 'help', name: 'x', message: '   ' }, deps);
		assert.equal(empty.ok, false);
		assert.match(empty.spoken, /cannot be empty/);
		assert.deepEqual(calls, []);
	});
});

describe('rename, archive and lock', () => {
	it('renames a thread', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('rename_thread', { thread: 'lunch plans', name: 'dinner plans' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(calls, [{ renamed: 'dinner plans' }]);
	});

	it('archives and reopens', async () => {
		const { deps, calls, thread } = makeDeps({ owner: true });
		assert.equal((await callTool('archive_thread', { thread: 'lunch plans' }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { archived: true });
		thread.archived = true;
		const reopened = await callTool('archive_thread', { thread: 'lunch plans', archived: false }, deps);
		assert.equal(reopened.ok, true, reopened.spoken);
		assert.deepEqual(calls.at(-1), { archived: false });
	});

	it('locks and unlocks', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		assert.equal((await callTool('lock_thread', { thread: 'lunch plans' }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { locked: true });
		assert.equal((await callTool('lock_thread', { thread: 'lunch plans', locked: false }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { locked: false });
	});

	it('refuses a thread it cannot find, an archived thread and a missing permission', async () => {
		const { deps, calls, thread } = makeDeps({ owner: true });
		const missing = await callTool('rename_thread', { thread: 'no such thread', name: 'x' }, deps);
		assert.equal(missing.ok, false);
		assert.match(missing.spoken, /could not find an open thread/);

		thread.archived = true;
		const archived = await callTool('lock_thread', { thread: 'lunch plans' }, deps);
		assert.equal(archived.ok, false);
		assert.match(archived.spoken, /archived/);
		assert.deepEqual(calls, []);

		const weak = makeDeps({ owner: true, held: ['SendMessages'] });
		const denied = await callTool('rename_thread', { thread: 'lunch plans', name: 'x' }, weak.deps);
		assert.equal(denied.ok, false);
		assert.match(denied.spoken, /Manage Threads/);
		assert.deepEqual(weak.calls, []);
	});

	it('lets the bot rename a thread it started itself, with no Manage Threads', async () => {
		const { deps, calls, thread } = makeDeps({ owner: true, held: ['SendMessages'] });
		thread.ownerId = SELF;
		const result = await callTool('rename_thread', { thread: 'lunch plans', name: 'mine' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(calls, [{ renamed: 'mine' }]);
	});
});

describe('thread membership', () => {
	it('adds and removes a member, and joins and leaves the thread itself', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		assert.equal((await callTool('add_thread_member', { thread: 'lunch plans', member: 'Jane' }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { added: '1' });
		assert.equal((await callTool('remove_thread_member', { thread: 'lunch plans', member: 'Jane' }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { removed: '1' });
		assert.equal((await callTool('join_thread', { thread: 'lunch plans' }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { joined: 't1' });
		assert.equal((await callTool('leave_thread', { thread: 'lunch plans' }, deps)).ok, true);
		assert.deepEqual(calls.at(-1), { left: 't1' });
	});

	it('refuses a person it cannot find, a missing permission and a thread that is not there', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const nobody = await callTool('add_thread_member', { thread: 'lunch plans', member: 'Nobody At All' }, deps);
		assert.equal(nobody.ok, false);
		assert.match(nobody.spoken, /could not find anyone/);

		const weak = makeDeps({ owner: true, held: ['SendMessagesInThreads'] });
		const denied = await callTool('remove_thread_member', { thread: 'lunch plans', member: 'Jane' }, weak.deps);
		assert.equal(denied.ok, false);
		assert.match(denied.spoken, /Manage Threads/);
		assert.deepEqual(weak.calls, []);

		const gone = await callTool('leave_thread', { thread: 'not here' }, deps);
		assert.equal(gone.ok, false);
		assert.match(gone.spoken, /could not find an open thread/);
		assert.deepEqual(calls, []);
	});

	it('lets the bot clear out a private thread it started, with no Manage Threads', async () => {
		const { deps, calls, thread } = makeDeps({ owner: true, held: ['SendMessagesInThreads'] });
		thread.type = ChannelType.PrivateThread;
		thread.ownerId = SELF;
		const result = await callTool('remove_thread_member', { thread: 'lunch plans', member: 'Jane' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(calls, [{ removed: '1' }]);
	});
});

describe('delete_thread', () => {
	it('asks first and deletes on the second call', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const owner = ownerVoice(deps);
		const asked = await callTool('delete_thread', { thread: 'lunch plans' }, perCall(deps));
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.deepEqual(calls, [], 'nothing is deleted before the answer');
		owner.says('yes');
		const done = await callTool('delete_thread', { thread: 'lunch plans', confirm: true }, perCall(deps));
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(calls, [{ deleted: 't1' }]);
	});

	it('refuses a confirmation that names another thread, and a delete without Manage Threads', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const owner = ownerVoice(deps);
		await callTool('delete_thread', { thread: 'lunch plans' }, perCall(deps));
		owner.says('yes');
		const other = await callTool('delete_thread', { thread: 'bug reports', confirm: true }, perCall(deps));
		assert.equal(other.ok, false, 'the answer belongs to the other thread');
		assert.deepEqual(calls, []);

		const weak = makeDeps({ owner: true, held: ['SendMessages'] });
		const denied = await callTool('delete_thread', { thread: 'lunch plans' }, perCall(weak.deps));
		assert.equal(denied.ok, false);
		assert.match(denied.spoken, /Manage Threads/);
		assert.deepEqual(weak.calls, []);
	});
});
