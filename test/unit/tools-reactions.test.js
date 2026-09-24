import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { callTool, toolMeta } from '../../src/tools.js';
import { ownerVoice } from '../owner-voice.js';

const SELF = 'bot';
const PARTY = '123456789012345678'; // a server emoji id has to look like a snowflake

// Every permission the module ever asks about; a test takes one away to get the refusal.
const ALL_PERMISSIONS = ['AddReactions', 'ManageMessages', 'PinMessages', 'ReadMessageHistory', 'SendPolls', 'SendMessages'];

let guildCounter = 0;

/** One reaction on a message; every call it receives is written into `sent`. */
function makeReaction(key, { count = 1, me = false } = {}, sent) {
	return {
		count,
		me,
		users: { remove: async (user) => sent.push({ reactionRemoved: key, user: user ?? 'self' }) },
		remove: async () => sent.push({ reactionCleared: key }),
	};
}

function makeMessage({ id, content = '', authorId = '1', pinned = false, reactions = new Map(), poll = null, createdAt = 1000 }, sent) {
	return {
		id,
		content,
		pinned,
		createdTimestamp: createdAt,
		author: { id: authorId, displayName: authorId === SELF ? 'Melis' : 'Jane Doe', username: 'jane', bot: authorId === SELF },
		member: null,
		reactions: { cache: reactions, removeAll: async () => sent.push({ reactionsCleared: id }) },
		poll,
		react: async (emoji) => sent.push({ reacted: emoji, message: id }),
		pin: async (reason) => sent.push({ pinned: id, reason }),
		unpin: async (reason) => sent.push({ unpinned: id, reason }),
	};
}

/**
 * Mock guild with one text channel. By default it holds two messages, "m2" being the newest.
 * `messages` and `pins` are factories so the message mocks can write into the same `sent` array.
 */
function makeDeps({ owner = false, permissions = ALL_PERMISSIONS, messages = null, pins = null } = {}) {
	const sent = [];
	const store = messages
		? messages(sent)
		: new Map([
				['m1', makeMessage({ id: 'm1', content: 'first one here', createdAt: 1000 }, sent)],
				['m2', makeMessage({ id: 'm2', content: 'the newest message', createdAt: 2000 }, sent)],
			]);
	const pinned = pins ? pins(sent) : [];
	const held = new Set(permissions);
	// `permissions` are the bot's own. Everybody else may see the channel and read it, so reading its pins
	// is nobody's privilege here and the refusals under test are the bot's.
	const open = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
	const channel = {
		id: '10',
		name: 'chat',
		type: ChannelType.GuildText,
		permissionsFor: (subject) =>
			subject?.id === SELF
				? { has: (flag) => [...held].some((flagName) => PermissionFlagsBits[flagName] === flag) }
				: { has: (flag) => open.includes(flag) },
		send: async (payload) => (sent.push({ send: payload }), { id: 'poll-message' }),
		messages: {
			fetch: async (options) => {
				if (typeof options === 'string') {
					const found = store.get(options);
					if (!found) throw new Error('Unknown Message');
					return found;
				}
				return store;
			},
			fetchPins: async ({ limit }) => ({
				items: pinned.slice(0, limit).map((message) => ({ message, pinnedTimestamp: 0, pinnedAt: new Date(0) })),
				hasMore: false,
			}),
		},
	};
	const guild = {
		id: `guild-${++guildCounter}`,
		channels: { cache: new Map([['10', channel]]) },
		voiceStates: { cache: new Map() },
		members: {
			cache: new Map([['1', { id: '1', displayName: 'Jane Doe', user: { username: 'jane', bot: false } }]]),
			me: { id: SELF },
			fetch: async () => new Map(),
		},
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		emojis: { cache: new Map([[PARTY, { id: PARTY, name: 'party', toString: () => `<:party:${PARTY}>` }]]) },
		stickers: { cache: new Map(), fetch: async () => {} },
	};
	const deps = {
		guild,
		selfId: SELF,
		cfg: { textChannelId: '10', readLimit: 5 },
		log: () => {},
		activity: () => {},
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	// The realtime path builds a fresh deps object for every call; two-step confirmation has to survive that.
	const perCall = () => ({ ...deps });
	return { deps, sent, guild, channel, perCall };
}

/** A message carrying reactions, as the factory makeDeps expects. */
const messagesWithReactions = (entries) => (sent) => {
	const reactions = new Map(entries.map(([key, options]) => [key, makeReaction(key, options, sent)]));
	return new Map([['m2', makeMessage({ id: 'm2', content: 'hello', reactions, createdAt: 2000 }, sent)]]);
};

describe('reaction tools: the owner gate', () => {
	it('refuses every gated tool of this module without an owner', async () => {
		const gated = toolMeta().filter((tool) => ['clear_reactions', 'pin_message', 'end_poll'].includes(tool.name));
		assert.equal(gated.length, 3, 'clear_reactions, pin_message and end_poll must be gated');
		for (const tool of gated) {
			assert.ok(tool.keywords?.length, `${tool.name} needs gate keywords`);
			const { deps, sent } = makeDeps();
			const result = await callTool(tool.name, { emoji: '👍' }, deps);
			assert.equal(result.denied, true, `${tool.name}: ${result.spoken}`);
			assert.deepEqual(sent, [], `${tool.name} must not touch Discord`);
		}
	});

	it('leaves reacting, taking my own reaction back, the pin list and opening a poll ungated', () => {
		const meta = new Map(toolMeta().map((tool) => [tool.name, tool.gated]));
		assert.equal(meta.get('add_reaction'), false);
		assert.equal(meta.get('remove_reaction'), false);
		assert.equal(meta.get('list_pins'), false);
		assert.equal(meta.get('create_poll'), false);
	});
});

describe('add_reaction', () => {
	it('reacts to the most recent message with a unicode emoji', async () => {
		const { deps, sent } = makeDeps();
		const result = await callTool('add_reaction', { emoji: '👍' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { reacted: '👍', message: 'm2' }, 'the newest message is the target');
		assert.equal(result.data.emoji, '👍');
	});

	it('reacts with a server emoji named out loud, and can aim at an older message by text', async () => {
		const { deps, sent } = makeDeps();
		const result = await callTool('add_reaction', { emoji: 'party', contains: 'first one' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { reacted: `<:party:${PARTY}>`, message: 'm1' });
		assert.match(result.spoken, /:party:/);
	});

	it('refuses without the Add Reactions permission, and says so when the emoji is not on the server', async () => {
		const { deps, sent } = makeDeps({ permissions: ALL_PERMISSIONS.filter((name) => name !== 'AddReactions') });
		const denied = await callTool('add_reaction', { emoji: '👍' }, deps);
		assert.equal(denied.ok, false);
		assert.match(denied.spoken, /Add Reactions/);
		assert.deepEqual(sent, [], 'nothing reaches Discord');

		const missing = await callTool('add_reaction', { emoji: 'nosuchemoji' }, makeDeps().deps);
		assert.equal(missing.ok, false);
		assert.match(missing.spoken, /nosuchemoji/);
	});

	it('refuses a message id that is not there instead of reacting to the newest message', async () => {
		const { deps, sent } = makeDeps();
		const result = await callTool('add_reaction', { emoji: '👍', message_id: '99' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /99/);
		assert.deepEqual(sent, []);
	});
});

describe('remove_reaction', () => {
	const oneThumb = messagesWithReactions([['👍', { count: 2, me: true }]]);

	it('takes its own reaction back without needing the owner', async () => {
		const { deps, sent } = makeDeps({ messages: oneThumb });
		const result = await callTool('remove_reaction', { emoji: '👍' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { reactionRemoved: '👍', user: 'self' });
	});

	it("needs the owner before it touches somebody else's reaction", async () => {
		const outsider = makeDeps({ messages: oneThumb });
		const denied = await callTool('remove_reaction', { emoji: '👍', member: 'Jane' }, outsider.deps);
		assert.equal(denied.denied, true, denied.spoken);
		assert.deepEqual(outsider.sent, [], 'nothing is removed');

		const { deps, sent } = makeDeps({ owner: true, messages: oneThumb });
		const allowed = await callTool('remove_reaction', { emoji: '👍', member: 'Jane' }, deps);
		assert.equal(allowed.ok, true, allowed.spoken);
		assert.deepEqual(sent.at(-1), { reactionRemoved: '👍', user: '1' });
	});

	it('refuses when the message carries no such reaction, and when the bot never reacted itself', async () => {
		const { deps, sent } = makeDeps({ messages: oneThumb });
		const wrongEmoji = await callTool('remove_reaction', { emoji: '😀' }, deps);
		assert.equal(wrongEmoji.ok, false);
		assert.match(wrongEmoji.spoken, /😀/);

		const others = makeDeps({ messages: messagesWithReactions([['👍', { count: 2, me: false }]]) });
		const notMine = await callTool('remove_reaction', { emoji: '👍' }, others.deps);
		assert.equal(notMine.ok, false, notMine.spoken);
		assert.deepEqual(sent, []);
		assert.deepEqual(others.sent, []);
	});

	it("refuses somebody else's reaction without the Manage Messages permission", async () => {
		const { deps, sent } = makeDeps({
			owner: true,
			messages: oneThumb,
			permissions: ALL_PERMISSIONS.filter((name) => name !== 'ManageMessages'),
		});
		const result = await callTool('remove_reaction', { emoji: '👍', member: 'Jane' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Messages/);
		assert.deepEqual(sent, []);
	});
});

describe('clear_reactions', () => {
	const twoKinds = messagesWithReactions([
		['👍', { count: 2 }],
		[PARTY, { count: 3 }],
	]);

	it('asks first and clears everything only after the confirmation', async () => {
		const { deps, perCall, sent } = makeDeps({ owner: true, messages: twoKinds });
		const owner = ownerVoice(deps);
		const asked = await callTool('clear_reactions', {}, perCall());
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.deepEqual(sent, [], 'nothing is cleared before the answer');
		owner.says('yes, clear them');
		const done = await callTool('clear_reactions', { confirm: true }, perCall());
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(sent.at(-1), { reactionsCleared: 'm2' });
		assert.equal(done.data.removed, 5, 'both reactions are counted');
	});

	it('clears a single emoji when one is named', async () => {
		const { deps, perCall, sent } = makeDeps({ owner: true, messages: twoKinds });
		const owner = ownerVoice(deps);
		await callTool('clear_reactions', { emoji: 'party' }, perCall());
		owner.says('yes');
		const done = await callTool('clear_reactions', { emoji: 'party', confirm: true }, perCall());
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(sent.at(-1), { reactionCleared: PARTY });
		assert.ok(!sent.some((entry) => entry.reactionsCleared), 'the other reactions stay');
	});

	it('refuses without the Manage Messages permission, and when there is nothing to clear', async () => {
		const blocked = makeDeps({ owner: true, messages: twoKinds, permissions: ALL_PERMISSIONS.filter((name) => name !== 'ManageMessages') });
		const result = await callTool('clear_reactions', { confirm: true }, blocked.deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Messages/);
		assert.deepEqual(blocked.sent, []);

		const bare = makeDeps({ owner: true });
		const empty = await callTool('clear_reactions', { confirm: true }, bare.deps);
		assert.equal(empty.ok, false);
		assert.match(empty.spoken, /no reactions/i);
	});
});

describe('pin_message', () => {
	it('pins the newest message', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		const result = await callTool('pin_message', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(sent.at(-1).pinned, 'm2');
	});

	it('unpins a message that really is pinned, and says so when it is not', async () => {
		const pinnedMessage = (sent) => new Map([['m2', makeMessage({ id: 'm2', content: 'rules', pinned: true, createdAt: 2000 }, sent)]]);
		const { deps, sent } = makeDeps({ owner: true, messages: pinnedMessage });
		const result = await callTool('pin_message', { pinned: false }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(sent.at(-1).unpinned, 'm2');

		const loose = makeDeps({ owner: true });
		const nothing = await callTool('pin_message', { pinned: false }, loose.deps);
		assert.match(nothing.spoken, /not pinned/i);
		assert.deepEqual(loose.sent, [], 'no pointless call to Discord');
	});

	it('refuses without the Pin Messages permission but accepts Manage Messages as its older spelling', async () => {
		const blocked = makeDeps({ owner: true, permissions: [] });
		const refused = await callTool('pin_message', {}, blocked.deps);
		assert.equal(refused.ok, false);
		assert.match(refused.spoken, /Pin Messages/);
		assert.deepEqual(blocked.sent, []);

		const legacy = makeDeps({ owner: true, permissions: ['ManageMessages'] });
		const result = await callTool('pin_message', {}, legacy.deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(legacy.sent.at(-1).pinned, 'm2');
	});
});

describe('list_pins', () => {
	const onePin = (sent) => [makeMessage({ id: 'm1', content: 'the server rules', createdAt: 1000 }, sent)];

	it('lists who wrote each pinned message', async () => {
		const { deps } = makeDeps({ pins: onePin });
		const result = await callTool('list_pins', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.pins.length, 1);
		assert.equal(result.data.pins[0].author, 'Jane Doe');
		assert.match(result.spoken, /server rules/);
	});

	it('says so when nothing is pinned, and refuses without Read Message History', async () => {
		const empty = await callTool('list_pins', {}, makeDeps().deps);
		assert.equal(empty.ok, true, empty.spoken);
		assert.deepEqual(empty.data.pins, []);

		const { deps } = makeDeps({ pins: onePin, permissions: ALL_PERMISSIONS.filter((name) => name !== 'ReadMessageHistory') });
		const result = await callTool('list_pins', {}, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Read Message History/);
	});
});

describe('create_poll', () => {
	it('opens a poll with the answers and the duration it was given', async () => {
		const { deps, sent } = makeDeps();
		const result = await callTool(
			'create_poll',
			{ question: 'Pizza tonight?', answers: ['yes', 'no', 'maybe'], duration_hours: 3, multiple: true },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		const { poll } = sent.at(-1).send;
		assert.equal(poll.question.text, 'Pizza tonight?');
		assert.deepEqual(poll.answers, [{ text: 'yes' }, { text: 'no' }, { text: 'maybe' }]);
		assert.equal(poll.duration, 3);
		assert.equal(poll.allowMultiselect, true);
		assert.equal(result.data.message_id, 'poll-message');
	});

	it('keeps at most ten answers and defaults to a day', async () => {
		const { deps, sent } = makeDeps();
		const answers = Array.from({ length: 12 }, (_, index) => `answer ${index}`);
		const result = await callTool('create_poll', { question: 'Which one?', answers }, deps);
		assert.equal(result.ok, true, result.spoken);
		const { poll } = sent.at(-1).send;
		assert.equal(poll.answers.length, 10);
		assert.equal(poll.duration, 24);
		assert.equal(result.warnings.length, 1, 'the dropped answers are reported');
	});

	it('refuses a poll with fewer than two answers, and one it is not allowed to send', async () => {
		const { deps, sent } = makeDeps();
		const thin = await callTool('create_poll', { question: 'Yes?', answers: ['yes'] }, deps);
		assert.equal(thin.ok, false);
		assert.match(thin.spoken, /two answers/i);
		assert.deepEqual(sent, []);

		const blocked = makeDeps({ permissions: ALL_PERMISSIONS.filter((name) => name !== 'SendPolls') });
		const result = await callTool('create_poll', { question: 'Yes?', answers: ['yes', 'no'] }, blocked.deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Send Polls/);
		assert.deepEqual(blocked.sent, []);
	});
});

describe('end_poll', () => {
	const pollMessage =
		({ authorId = SELF, expires = Date.now() + 3_600_000, finalized = false } = {}) =>
		(sent) => {
			const poll = {
				expiresTimestamp: expires,
				resultsFinalized: finalized,
				answers: new Map([
					[1, { text: 'yes', voteCount: 3 }],
					[2, { text: 'no', voteCount: 1 }],
				]),
				end: async () => (sent.push({ pollEnded: true }), null),
			};
			return new Map([['m2', makeMessage({ id: 'm2', content: 'poll', authorId, poll, createdAt: 2000 }, sent)]]);
		};

	it('ends its own poll and reads the result out', async () => {
		const { deps, sent } = makeDeps({ owner: true, messages: pollMessage() });
		const result = await callTool('end_poll', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { pollEnded: true });
		assert.match(result.spoken, /yes: 3/);
		assert.deepEqual(result.data.results, [
			{ answer: 'yes', votes: 3 },
			{ answer: 'no', votes: 1 },
		]);
	});

	it("refuses somebody else's poll, a message that is not a poll and one that already finished", async () => {
		const other = makeDeps({ owner: true, messages: pollMessage({ authorId: '1' }) });
		const foreign = await callTool('end_poll', {}, other.deps);
		assert.equal(foreign.ok, false);
		assert.match(foreign.spoken, /author/i);
		assert.deepEqual(other.sent, []);

		const plain = makeDeps({ owner: true });
		const notPoll = await callTool('end_poll', {}, plain.deps);
		assert.equal(notPoll.ok, false);
		assert.match(notPoll.spoken, /not a poll/i);

		const over = makeDeps({ owner: true, messages: pollMessage({ expires: Date.now() - 1000 }) });
		const finished = await callTool('end_poll', {}, over.deps);
		assert.equal(finished.ok, false);
		assert.match(finished.spoken, /already finished/i);
		assert.deepEqual(over.sent, []);
	});
});
