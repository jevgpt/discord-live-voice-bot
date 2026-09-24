import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { SpeakerAttribution } from '../../src/attribution.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { MemoryStore } from '../../src/memory.js';
import { ActivityLog } from '../../src/panel.js';
import { callTool, resetDmLimiter } from '../../src/tools.js';
import { canReadChannel, speakerOfTurn } from '../../src/tools/access.js';
import { riskyPermissionsOf } from '../../src/tools/roles.js';

// The checks an open tool makes about the person asking, before it acts in the bot's name. Three people:
// the owner ("o"), an administrator ("a", listed in ADMIN_USER_IDS) and a guest ("g"). #general is open to
// everybody, #staff only to the owner and the administrator, and in #news the guest can see the channel
// but not read what was written before.

const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/** A channel whose permissions say who may do what: { subjectId: [flags] }. */
function textChannel(id, name, access, sent) {
	return {
		id,
		name,
		type: ChannelType.GuildText,
		permissionsFor: (subject) => {
			const flags = access[subject?.id] ?? [];
			return { has: (flag) => flags.includes(flag) };
		},
		send: async (payload) => (sent.push({ channel: name, ...payload }), { id: `sent-${sent.length}` }),
		messages: { fetch: async () => new Map() },
	};
}

function message(id, authorId, content, sent) {
	return {
		id,
		content,
		createdTimestamp: Number(id.replace(/\D/g, '')) || 1,
		author: { id: authorId, bot: authorId === 'bot', displayName: authorId },
		stickers: new Map(),
		attachments: new Map(),
		embeds: [],
		delete: async () => sent.push({ deleted: id }),
		edit: async (payload) => (sent.push({ edited: id, content: payload.content }), { id }),
	};
}

function member(id, displayName, sent, extra = {}) {
	return {
		id,
		displayName,
		user: { id, username: displayName.toLowerCase(), bot: false },
		send: async (payload) => (sent.push({ dm: id, content: payload.content }), { id: `dm-${id}`, channelId: `dm-${id}` }),
		createDM: async () => {
			sent.push({ openedDm: id });
			return { id: `dm-${id}`, name: null, recipient: { displayName }, messages: { fetch: async () => new Map() } };
		},
		roles: { cache: new Map(), add: async (role) => sent.push({ roleAdded: role.name, to: id }), remove: async (role) => sent.push({ roleRemoved: role.name, to: id }) },
		...extra,
	};
}

/**
 * @param {object} options
 * @param {string|null} options.speaker who the line behind the request belongs to (null = nobody could be named)
 * @param {boolean} options.gate whether the owner gate opens (the legacy "the owner is speaking" path)
 */
function makeDeps({ speaker = 'g', gate = false } = {}) {
	const sent = [];
	const read = [];
	const general = textChannel('c1', 'general', { everyone: READ, o: READ, a: READ, g: READ }, sent);
	const staff = textChannel('c2', 'staff', { o: READ, a: READ }, sent);
	const news = textChannel('c3', 'news', { everyone: [PermissionFlagsBits.ViewChannel], g: [PermissionFlagsBits.ViewChannel] }, sent);
	const history = [message('m1', 'g', 'hello from the guest', sent), message('m2', 'bot', 'the owner announcement', sent), message('m3', 'o', 'staff only', sent)];
	for (const channel of [general, staff, news]) {
		channel.messages.fetch = async (options) => {
			if (typeof options === 'string') return history.find((entry) => entry.id === options) ?? null;
			return new Map(history.map((entry) => [entry.id, entry]));
		};
	}
	const members = new Map([
		['o', member('o', 'Olga', sent)],
		['a', member('a', 'Ada', sent)],
		['g', member('g', 'Gus', sent)],
	]);
	const roles = new Map([
		['r1', { id: 'r1', name: 'chillz', position: 1, managed: false, permissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]) }],
		['r2', { id: 'r2', name: 'Moderator', position: 2, managed: false, permissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers]) }],
		['r3', { id: 'r3', name: 'Boss', position: 3, managed: false, permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) }],
	]);
	const guild = {
		id: 'guild-access',
		channels: { cache: new Map([[general.id, general], [staff.id, staff], [news.id, news]]) },
		voiceStates: { cache: new Map() },
		members: {
			cache: members,
			fetch: async () => new Map(),
			me: { id: 'bot', permissions: { has: () => true }, roles: { highest: { name: 'Bot', position: 10 } } },
		},
		roles: { cache: roles, everyone: { id: 'everyone' } },
		emojis: { cache: new Map() },
		stickers: { cache: new Map(), fetch: async () => {} },
	};
	const reader = {
		read: async (channel) => (read.push(channel.name ?? channel.id), { messages: history.slice(0, 1), isNew: true, firstTime: true }),
		readHistory: async (channel) => (read.push(channel.name ?? channel.id), { messages: history.slice(0, 1), oldestId: 'm1' }),
	};
	const deps = {
		guild,
		selfId: 'bot',
		cfg: { ownerId: 'o', adminUserIds: ['a'], adminRoleIds: [], textChannelId: 'c1', readLimit: 5, dmPerMinute: 10, dmPerTargetPerMinute: 5 },
		log: () => {},
		activity: () => {},
		reader,
		pendingConfirmations: new Map(),
		currentSpeakerId: () => speaker,
		currentSpeakerName: () => (speaker ? (members.get(speaker)?.displayName ?? speaker) : null),
		store: { list: () => [{ id: 'c-aria', name: 'Aria' }], getActive: () => null, setActive: async (id) => sent.push({ character: id }) },
		refreshPersona: async () => {},
	};
	// The legacy gate path: open when the owner is the one speaking, closed otherwise.
	deps.isOwnerActive = () => gate;
	if (gate) {
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, sent, read, guild, members };
}

describe('speakerOfTurn: who the line behind a request belongs to', () => {
	it('names the speaker of the line before the turn, not whoever made a sound afterwards', () => {
		const attribution = new SpeakerAttribution({ ownerId: 'o', now: () => 10_000 });
		attribution.noteTranscript('remember that I like tea', { id: 'g' });
		const turn = attribution.markTurn();
		// The owner coughs while the model works: Discord reports the owner as the last speaker.
		assert.equal(speakerOfTurn(attribution, turn, 'o'), 'g');
	});

	it('falls back to the speaking event only when there is no line to go on', () => {
		assert.equal(speakerOfTurn(null, null, 'o'), 'o', 'no attribution at all');
		const attribution = new SpeakerAttribution({ ownerId: 'o', now: () => 10_000 });
		assert.equal(speakerOfTurn(attribution, null, 'g'), 'g', 'no turn pinned');
		assert.equal(speakerOfTurn(attribution, attribution.markTurn(), 'g'), 'g', 'nothing heard before the turn');
		const lagging = { transcriptLagging: () => true, lastUtterance: () => ({ id: 'someone-earlier' }) };
		assert.equal(speakerOfTurn(lagging, { at: 1 }, 'g'), 'g', 'the line that triggered the turn has not arrived yet');
	});

	it('names nobody when the line itself could not be named, rather than guessing', () => {
		const overlap = { transcriptLagging: () => false, lastUtterance: () => ({ id: null, owner: false, sure: false }) };
		assert.equal(speakerOfTurn(overlap, { at: 1 }, 'o'), null);
		const ownerOnly = { ownerId: 'o', transcriptLagging: () => false, lastUtterance: () => ({ id: null, owner: true }) };
		assert.equal(speakerOfTurn(ownerOnly, { at: 1 }, 'g'), 'o', 'a line that is the owner s carries the owner s id');
	});
});

describe('a session names the person whose line asked, not the last sound Discord reported', () => {
	/** A server with the owner and a guest in one voice channel, and a session with a notebook. */
	function makeSession() {
		const voice = { id: 'v1', name: 'Lounge', type: ChannelType.GuildVoice, parent: null, parentId: null, rawPosition: 0 };
		const person = (id, name) => ({ id, displayName: name, user: { id, username: name.toLowerCase(), bot: false }, voice: { channelId: voice.id, channel: voice } });
		const guild = {
			id: 'guild-session-speaker',
			name: 'Speaker',
			channels: { cache: new Map([[voice.id, voice]]) },
			members: { cache: new Map([['owner', person('owner', 'Olga')], ['guest', person('guest', 'Gus')]]), fetch: async () => new Map() },
			voiceStates: { cache: new Map() },
			roles: { cache: new Map(), everyone: { id: 'everyone' } },
		};
		const memory = new MemoryStore('unused.json');
		memory.save = () => Promise.resolve();
		const cfg = loadConfig({ DISCORD_TOKEN: 't', GUILD_ID: guild.id, CHANNEL_ID: voice.id, OPENAI_API_KEY: 'k', OWNER_ID: 'owner' });
		const activity = new ActivityLog();
		const session = new GuildSession({
			cfg,
			client: { user: { id: 'bot' } },
			guild,
			channelId: voice.id,
			store: { getActive: () => null, list: () => [], setActive: async () => true },
			memory,
			quota: { enabled: false, status: () => ({ used: 0, limit: 0, exceeded: false }), sessionStarted() {}, shouldWarn: () => false },
			reader: { read: async () => ({ messages: [] }), readHistory: async () => ({ messages: [] }) },
			recentActions: new RecentActions(),
			activity,
			record: (event) => activity.push(event),
			provider: { textClient: {}, textApi: 'responses', textModel: 'm', describe: () => 'mock' },
			openai: {},
			localStt: {},
			localServer: null,
			log: () => {},
			summarize: async () => ({ summary: '' }),
		});
		return { session, memory };
	}

	/** One second of the guest's audio and the transcript of it; the model starts answering right after. */
	function guestAsks(session, text) {
		for (let index = 0; index < 50; index++) session.attribution.onFrame({ priority: false, active: ['guest'] });
		session.attribution.noteTranscript(text, { startMs: 0, endMs: 1000 });
		return session.attribution.markTurn();
	}

	it('files a guest s note under the guest when the owner makes a sound while the model works', async () => {
		const { session, memory } = makeSession();
		const turn = guestAsks(session, 'remember that I am in charge here');
		session.lastSpeakerId = 'owner'; // the owner coughs: Discord's last speaking event is the owner's
		// The transcript is all here already; the gate need not wait for more of it.
		const deps = { ...session.deps(), currentTurn: () => turn, awaitTranscript: async () => {} };
		assert.equal(deps.currentSpeakerId(), 'guest');
		assert.equal(deps.currentSpeakerName(), 'Gus');

		const noted = await callTool('remember_note', { note: 'is in charge here' }, deps);
		assert.equal(noted.ok, true, noted.spoken);
		assert.deepEqual(memory.notesFor('owner'), [], 'nothing was written about the owner');
		assert.equal(memory.notesFor('guest').length, 1);

		await memory.add('owner', 'exam on Friday', { name: 'Olga' });
		const cleared = await callTool('forget_note', { member: 'Olga', note: 'all' }, deps);
		assert.equal(cleared.denied, true, cleared.spoken);
		assert.equal(memory.notesFor('owner').length, 1, "the owner's notes are still there");
	});

	it('still uses the speaking event when no turn has been pinned', () => {
		const { session } = makeSession();
		session.lastSpeakerId = 'guest';
		assert.equal(session.deps().currentSpeakerId(), 'guest');
	});
});

describe('read_messages: the person asking has to be able to read the channel', () => {
	it('refuses a guest a channel they cannot see, and reads one they can', async () => {
		const { deps, read } = makeDeps({ speaker: 'g' });
		const refused = await callTool('read_messages', { channel: 'staff', all: true }, deps);
		assert.equal(refused.ok, false);
		assert.equal(refused.denied, true);
		assert.match(refused.spoken, /#staff/);
		assert.deepEqual(read, [], 'nothing was fetched from the staff channel');

		const allowed = await callTool('read_messages', { channel: 'general' }, deps);
		assert.equal(allowed.ok, true, allowed.spoken);
		assert.deepEqual(read, ['general']);
	});

	it('needs the history permission as well as the view permission', async () => {
		const { deps, read } = makeDeps({ speaker: 'g' });
		const result = await callTool('read_messages', { channel: 'news', all: true }, deps);
		assert.equal(result.denied, true, result.spoken);
		assert.deepEqual(read, []);
	});

	it('lets the owner and a member with access read the staff channel', async () => {
		for (const speaker of ['o', 'a']) {
			const { deps, read } = makeDeps({ speaker });
			const result = await callTool('read_messages', { channel: 'staff', all: true }, deps);
			assert.equal(result.ok, true, `${speaker}: ${result.spoken}`);
			assert.deepEqual(read, ['staff']);
		}
	});

	it('measures somebody who cannot be named against @everyone', async () => {
		const { deps, read } = makeDeps({ speaker: null });
		const staff = await callTool('read_messages', { channel: 'staff', all: true }, deps);
		assert.equal(staff.denied, true);
		assert.match(staff.spoken, /could not tell who asked/);
		const general = await callTool('read_messages', { channel: 'general', all: true }, deps);
		assert.equal(general.ok, true, general.spoken);
		assert.deepEqual(read, ['general']);
	});

	it('reads private conversations for the owner only, and refuses before opening one', async () => {
		const guest = makeDeps({ speaker: 'g' });
		const refused = await callTool('read_messages', { dm: 'Olga' }, guest.deps);
		assert.equal(refused.denied, true);
		assert.match(refused.spoken, /Only the bot owner/);
		assert.ok(!guest.sent.some((entry) => entry.openedDm), 'no private channel was opened for the refusal');

		// The fallback to the last private conversation is covered too, not just the dm argument.
		guest.deps.cfg.textChannelId = null;
		guest.deps.lastDirectMessage = () => ({ channelId: 'dm-o', name: 'Olga' });
		guest.deps.client = { channels: { cache: new Map([['dm-o', { id: 'dm-o', name: null, messages: { fetch: async () => new Map() } }]]) } };
		assert.equal((await callTool('read_messages', {}, guest.deps)).denied, true);
		assert.deepEqual(guest.read, []);

		const owner = makeDeps({ speaker: 'o' });
		const allowed = await callTool('read_messages', { dm: 'Gus' }, owner.deps);
		assert.equal(allowed.ok, true, allowed.spoken);
		assert.equal(owner.read.length, 1);
	});

	it('leaves a slash command to the check commands.js already made', async () => {
		const { deps, read } = makeDeps({ speaker: 'g' });
		deps.fromSlashCommand = true;
		const result = await callTool('read_messages', { channel: 'staff', all: true }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(read, ['staff']);
	});
});

describe('recall_notes: notes about other people are the owner s', () => {
	function withMemory(deps) {
		const store = new MemoryStore('unused.json');
		store.save = () => Promise.resolve();
		deps.memory = store;
		return store;
	}

	it('keeps a guest s search and recall to their own notes', async () => {
		const { deps } = makeDeps({ speaker: 'g' });
		const store = withMemory(deps);
		await store.add('o', 'exam on Friday', { name: 'Olga' });
		await store.add('g', 'likes tea', { name: 'Gus' });

		const everything = await callTool('recall_notes', { search: '' }, deps);
		assert.equal(everything.ok, true);
		assert.deepEqual(everything.data.notes.map((note) => note.id), ['g'], everything.spoken);
		assert.doesNotMatch(everything.spoken, /exam/);

		const aboutOwner = await callTool('recall_notes', { member: 'Olga' }, deps);
		assert.equal(aboutOwner.denied, true);
		assert.doesNotMatch(aboutOwner.spoken, /exam/);

		const own = await callTool('recall_notes', {}, deps);
		assert.match(own.spoken, /likes tea/);
	});

	it('lets the owner search everyone and recall anybody', async () => {
		const { deps } = makeDeps({ speaker: 'o' });
		const store = withMemory(deps);
		await store.add('o', 'exam on Friday', { name: 'Olga' });
		await store.add('g', 'likes tea', { name: 'Gus' });
		const everything = await callTool('recall_notes', { search: '' }, deps);
		assert.deepEqual(everything.data.notes.map((note) => note.id).sort(), ['g', 'o']);
		const aboutGuest = await callTool('recall_notes', { member: 'Gus' }, deps);
		assert.match(aboutGuest.spoken, /likes tea/);
	});

	it('does not search at all for somebody who cannot be named', async () => {
		const { deps } = makeDeps({ speaker: null });
		const store = withMemory(deps);
		await store.add('o', 'exam on Friday', { name: 'Olga' });
		const result = await callTool('recall_notes', { search: '' }, deps);
		assert.equal(result.ok, false);
		assert.doesNotMatch(result.spoken, /exam/);
	});

	it('MemoryStore.search keeps to one person when asked to', async () => {
		const store = new MemoryStore('unused.json');
		store.save = () => Promise.resolve();
		await store.add('o', 'tea at five', { name: 'Olga' });
		await store.add('g', 'tea with milk', { name: 'Gus' });
		assert.equal(store.search('tea').length, 2);
		assert.deepEqual(store.search('tea', { userId: 'g' }).map((hit) => hit.text), ['tea with milk']);
	});
});

describe('send_dm: anyone may be written to themselves, anybody else is the owner s call', () => {
	it('sends a guest their own DM, and refuses one to somebody else', async () => {
		resetDmLimiter();
		const { deps, sent } = makeDeps({ speaker: 'g' });
		const own = await callTool('send_dm', { to: 'Gus', text: 'the link' }, deps);
		assert.equal(own.ok, true, own.spoken);
		const other = await callTool('send_dm', { to: 'Olga', text: 'you are fired' }, deps);
		assert.equal(other.denied, true);
		assert.deepEqual(
			sent.filter((entry) => entry.dm).map((entry) => entry.dm),
			['g'],
			'only the guest s own DM went out',
		);
		resetDmLimiter();
	});

	it('writes to somebody else when the owner asks', async () => {
		resetDmLimiter();
		const { deps, sent } = makeDeps({ speaker: 'o', gate: true });
		const result = await callTool('send_dm', { to: 'Gus', text: 'welcome' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.filter((entry) => entry.dm), [{ dm: 'g', content: 'welcome' }]);
		resetDmLimiter();
	});
});

describe('send_message: a role tag is a crowd ping, like @everyone', () => {
	it('drops a role tag a guest asked for and still sends the message', async () => {
		const { deps, sent } = makeDeps({ speaker: 'g' });
		const result = await callTool('send_message', { channel: 'general', text: 'help please', mentions: ['Moderator'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent[0].allowedMentions.roles, []);
		assert.doesNotMatch(sent[0].content, /<@&r2>/);
		assert.ok(result.warnings.some((warning) => warning.includes('Moderator')), result.warnings.join('; '));
	});

	it('pings the role when the owner named it, even without saying "ping"', async () => {
		const clock = { now: 20_000 };
		const attribution = new SpeakerAttribution({ ownerId: 'o', now: () => clock.now });
		const { deps, sent } = makeDeps({ speaker: 'o' });
		deps.commandSpeaker = (words, opts) => attribution.commandSpeaker(words, opts);
		deps.lastUtterance = (opts) => attribution.lastUtterance(opts);
		attribution.noteTranscript('tell the moderators the stream starts', { owner: true, id: 'o' });
		const turn = attribution.markTurn();
		deps.currentTurn = () => turn;
		const result = await callTool('send_message', { channel: 'general', text: 'the stream starts', mentions: ['Moderator'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent[0].allowedMentions.roles, ['r2']);

		// The same words from a guest do not open it.
		const guestAttribution = new SpeakerAttribution({ ownerId: 'o', now: () => clock.now });
		const guest = makeDeps({ speaker: 'g' });
		guest.deps.commandSpeaker = (words, opts) => guestAttribution.commandSpeaker(words, opts);
		guest.deps.lastUtterance = (opts) => guestAttribution.lastUtterance(opts);
		guestAttribution.noteTranscript('ping the moderators', { owner: false, id: 'g' });
		const guestTurn = guestAttribution.markTurn();
		guest.deps.currentTurn = () => guestTurn;
		await callTool('send_message', { channel: 'general', text: 'hi', mentions: ['Moderator'] }, guest.deps);
		assert.deepEqual(guest.sent[0].allowedMentions.roles, []);
	});
});

describe('edit_message and delete_messages: the bot s own posts are the owner s', () => {
	it('refuses a guest editing or deleting even the bot s own message', async () => {
		const { deps, sent } = makeDeps({ speaker: 'g' });
		const edit = await callTool('edit_message', { channel: 'general', text: 'rewritten' }, deps);
		assert.equal(edit.denied, true);
		const own = await callTool('delete_messages', { channel: 'general', own: true }, deps);
		assert.equal(own.denied, true);
		assert.deepEqual(sent, [], 'nothing was edited or deleted');
	});

	it('lets the owner edit and delete the bot s own message without a question', async () => {
		const { deps, sent } = makeDeps({ speaker: 'o', gate: true });
		const edit = await callTool('edit_message', { channel: 'general', text: 'rewritten' }, deps);
		assert.equal(edit.ok, true, edit.spoken);
		const own = await callTool('delete_messages', { channel: 'general', own: true }, deps);
		assert.equal(own.ok, true, own.spoken);
		assert.deepEqual(sent, [{ edited: 'm2', content: 'rewritten' }, { deleted: 'm2' }]);
	});

	it('asks before deleting several of other people s messages, and deletes on the confirmation', async () => {
		const { deps, sent } = makeDeps({ speaker: 'o', gate: true });
		const asked = await callTool('delete_messages', { channel: 'general', count: 3 }, deps);
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.match(asked.spoken, /last 3 messages in #general/);
		assert.deepEqual(sent, [], 'nothing is deleted before the answer');

		// A different request is not confirmed by the answer to this one.
		const other = await callTool('delete_messages', { channel: 'general', count: 2, confirm: true }, deps);
		assert.equal(other.needs_confirmation, true);
		assert.deepEqual(sent, []);

		await callTool('delete_messages', { channel: 'general', count: 3 }, deps);
		const done = await callTool('delete_messages', { channel: 'general', count: 3, confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(sent.map((entry) => entry.deleted).sort(), ['m1', 'm2', 'm3']);
	});

	it('deletes a single message of somebody else s without a question', async () => {
		const { deps, sent } = makeDeps({ speaker: 'o', gate: true });
		const result = await callTool('delete_messages', { channel: 'general', from: 'Gus', count: 1 }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent, [{ deleted: 'm1' }]);
	});
});

describe('switch_character: held to the standard of /character', () => {
	it('refuses a guest', async () => {
		const { deps, sent } = makeDeps({ speaker: 'g' });
		const result = await callTool('switch_character', { name: 'Aria' }, deps);
		assert.equal(result.denied, true);
		assert.deepEqual(sent, []);
	});

	it('lets an administrator through the way the slash commands recognise one', async () => {
		const listed = makeDeps({ speaker: 'a' });
		assert.equal((await callTool('switch_character', { name: 'Aria' }, listed.deps)).ok, true);
		assert.deepEqual(listed.sent, [{ character: 'c-aria' }]);

		const manager = makeDeps({ speaker: 'g' });
		manager.members.get('g').permissions = { has: (flag) => flag === PermissionFlagsBits.ManageGuild };
		assert.equal((await callTool('switch_character', { name: 'Aria' }, manager.deps)).ok, true);
	});

	it('lets the owner through the owner gate when their line was not named', async () => {
		const { deps, sent } = makeDeps({ speaker: null, gate: true });
		const result = await callTool('switch_character', { name: 'Aria' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent, [{ character: 'c-aria' }]);
	});
});

describe('grant_role: no keys to the server by voice', () => {
	it('names the risky permissions a role carries', () => {
		const admin = { permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) };
		assert.deepEqual(riskyPermissionsOf(admin), ['Administrator'], 'an Administrator role is reported as that, not as everything');
		const moderator = { permissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers]) };
		assert.deepEqual(riskyPermissionsOf(moderator), ['BanMembers', 'ManageMessages']);
		assert.deepEqual(riskyPermissionsOf({ permissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]) }), []);
	});

	it('refuses a role carrying Administrator or moderation permissions, even for the owner', async () => {
		for (const role of ['Boss', 'Moderator']) {
			const { deps, sent } = makeDeps({ speaker: 'o', gate: true });
			const result = await callTool('grant_role', { member: 'Gus', role }, deps);
			assert.equal(result.ok, false, role);
			assert.equal(result.denied, true, role);
			assert.match(result.spoken, /by voice/);
			assert.deepEqual(sent, [], `${role} was not granted`);
		}
	});

	it('still takes a risky role away', async () => {
		const { deps, sent } = makeDeps({ speaker: 'o', gate: true });
		const result = await callTool('revoke_role', { member: 'Gus', role: 'Moderator' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent, [{ roleRemoved: 'Moderator', to: 'g' }]);
	});

	it('grants an exact match at once and asks about an approximate one', async () => {
		const exact = makeDeps({ speaker: 'o', gate: true });
		assert.equal((await callTool('grant_role', { member: 'Gus', role: 'chillz' }, exact.deps)).ok, true);
		assert.deepEqual(exact.sent, [{ roleAdded: 'chillz', to: 'g' }]);

		const fuzzy = makeDeps({ speaker: 'o', gate: true });
		const asked = await callTool('grant_role', { member: 'Gus', role: 'chill' }, fuzzy.deps);
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.match(asked.spoken, /chillz/);
		assert.deepEqual(fuzzy.sent, []);
		const done = await callTool('grant_role', { member: 'Gus', role: 'chill', confirm: true }, fuzzy.deps);
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(fuzzy.sent, [{ roleAdded: 'chillz', to: 'g' }]);
	});
});

describe('canReadChannel', () => {
	it('refuses a channel with no permissions to check', async () => {
		const { deps } = makeDeps();
		assert.equal(await canReadChannel(deps, { id: 'x', name: 'x' }, 'g'), false);
	});
});
