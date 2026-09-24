import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { callTool, resetDmLimiter, toolDefinitions, toolMeta, toolOutput } from '../../src/tools.js';
import { ChannelReader } from '../../src/reader.js';
import { RecentActions } from '../../src/commands.js';
import { SpeakerAttribution } from '../../src/attribution.js';
import { parsePermissions } from '../../src/tools/helpers.js';

function makeDeps({ owner = false } = {}) {
	const sent = [];
	const channel = {
		id: '10',
		name: 'chat',
		type: ChannelType.GuildText,
		send: async (payload) => (sent.push(payload), { id: 'm1' }),
		messages: { fetch: async () => new Map() },
		permissionOverwrites: {
			edit: async (target, patch) => sent.push({ overwrite: patch, target: target?.id ?? target }),
			delete: async (id) => sent.push({ deleted: id }),
		},
	};
	const voiceChannel = {
		id: 'v1',
		name: 'General',
		type: ChannelType.GuildVoice,
		parent: null,
		parentId: null,
		rawPosition: 0,
		edit: async (patch) => sent.push({ edited: patch }),
		setParent: async (parent, options) => sent.push({ parent: parent?.name ?? null, lock: options?.lockPermissions === true }),
		setPosition: async (position) => sent.push({ position }),
		lockPermissions: async () => sent.push({ synced: true }),
		permissionOverwrites: {
			edit: async (target, patch) => sent.push({ overwrite: patch, target: target?.id ?? target }),
			delete: async (id) => sent.push({ deleted: id }),
		},
	};
	const guild = {
		channels: { cache: new Map([['10', channel], ['v1', voiceChannel]]) },
		voiceStates: { cache: new Map() },
		members: {
			cache: new Map([
				['1', { id: '1', displayName: 'Jane Doe', user: { username: 'jane', bot: false }, send: async (p) => sent.push({ dm: p.content }), kickable: true, kick: async () => sent.push({ kick: '1' }), voice: { channelId: 'v1', channel: voiceChannel, setChannel: async (c) => sent.push({ moved: c.name }) } }],
			]),
			fetch: async () => new Map(),
		},
		roles: { cache: new Map([['r1', { id: 'r1', name: 'chillz', position: 2, managed: false, editable: true }]]), everyone: { id: 'everyone' } },
		emojis: { cache: new Map() },
		stickers: { cache: new Map(), fetch: async () => {} },
	};
	const deps = {
		guild,
		cfg: { textChannelId: null, readLimit: 5, dmPerMinute: 10, dmPerTargetPerMinute: 2 },
		log: () => {},
		activity: () => {},
		reader: new ChannelReader(),
		recentActions: new RecentActions(),
		store: { list: () => [], getActive: () => null, setActive: async () => true },
		joinVoice: async (c) => sent.push({ joined: c.name }),
		leaveVoice: async () => {},
		currentSpeakerChannel: () => null,
		refreshPersona: async () => {},
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, sent, guild, channel };
}

describe('tool registry', () => {
	it('keeps the schemas and the meta table in step, and every gated tool refuses without an owner', async () => {
		const meta = toolMeta();
		const defs = toolDefinitions();
		assert.equal(new Set(defs.map((d) => d.name)).size, defs.length, 'tool names are unique');
		const gated = meta.filter((m) => m.gated).map((m) => m.name);
		assert.ok(gated.includes('ban_member') && gated.includes('move_member') && gated.includes('lock_channel'));
		assert.ok(!gated.includes('play_music') && !gated.includes('send_dm'));
		for (const name of gated) {
			const { deps } = makeDeps();
			const result = await callTool(name, {}, deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.denied, true, `${name} must come back refused by the gate`);
		}
	});

	it('reports an unknown tool and packs a result into the toolOutput shape', async () => {
		const { deps } = makeDeps();
		assert.equal((await callTool('no_such_tool', {}, deps)).ok, false);
		const out = JSON.parse(toolOutput({ ok: false, spoken: 'question', needs_confirmation: true, error: 'x' }));
		assert.deepEqual(out, { ok: false, summary: 'question', needs_confirmation: true, error: 'x' });
	});
});

describe('owner gate: who said the command', () => {
	function withAttribution(deps, clock) {
		const attribution = new SpeakerAttribution({ ownerId: 'o', now: () => clock.now });
		deps.isOwnerActive = () => attribution.isOwnerActive();
		deps.ownerMatch = (words, ms) => attribution.ownerMatch(words, ms);
		deps.ownerSaidRecently = (words, ms) => attribution.ownerSaidRecently(words, ms);
		deps.commandSpeaker = (words, opts) => attribution.commandSpeaker(words, opts);
		deps.lastUtterance = (opts) => attribution.lastUtterance(opts);
		deps.transcriptLagging = (opts) => attribution.transcriptLagging(opts);
		deps.nameFor = (id) => (id === 'z' ? 'Sam' : id);
		deps.awaitTranscript = async () => {};
		return attribution;
	}
	const frames = (a, n, frame) => {
		for (let i = 0; i < n; i++) a.onFrame(frame);
	};

	// Live failure, the owner drowned out: in a busy room somebody's voice bleeds into the tail of the
	// owner's command at the hand-off, the transcript notes that tangled fragment as somebody else's, and
	// this check counted it as "somebody cut in" and refused the owner. A tangled (leaning) fragment is
	// not somebody taking the floor; only a clean interjection is (the test below still refuses that).
	it('does not let a voice bleeding into the owner s tail veto the owner s command', async () => {
		const { deps, sent } = makeDeps();
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 50, { priority: true, active: ['o'] });
		a.noteTranscript('move Jane to General', { startMs: 0, endMs: 1000 });
		clock.now += 200;
		frames(a, 10, { priority: false, active: ['o', 'z'] }); // Sam starts while the owner is still finishing
		const tangled = a.noteTranscript('ok', { startMs: 1000, endMs: 1200 });
		assert.equal(tangled.sure, false, 'the fragment is tangled, so it is not anybody s clean word');
		a.markTurn();
		const result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { moved: 'General' });
	});

	it('someone cutting in while the backend works does not drop the command the owner gave', async () => {
		const { deps, sent } = makeDeps();
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 50, { priority: true, active: ['o'] });
		a.noteTranscript('move Jane to General', { startMs: 0, endMs: 1000 });
		a.markTurn(); // the backend started working on it
		clock.now += 4000;
		frames(a, 20, { priority: false, active: ['z'] }); // Sam: "sorry what was that"
		a.noteTranscript('sorry what was that', { startMs: 1000, endMs: 1400 });
		assert.equal(a.isOwnerActive(), false, 'at frame level Sam spoke last (the old gate would have refused)');
		const result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { moved: 'General' });
	});

	it('refuses a request from someone else, whether it leans on the owner\'s earlier keyword or repeats it', async () => {
		const { deps, sent } = makeDeps();
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 30, { priority: true, active: ['o'] });
		a.noteTranscript('move Alex over', { startMs: 0, endMs: 600 });
		a.markTurn();
		clock.now += 5000;
		frames(a, 20, { priority: false, active: ['z'] });
		a.noteTranscript('me too', { startMs: 600, endMs: 1000 }); // a request without the keyword, from somebody else
		a.markTurn(); // the model is answering Sam
		let result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.denied, true);
		assert.match(result.spoken, /Somebody else cut in/);
		assert.ok(!sent.some((s) => s.moved), 'nobody may be moved');

		clock.now += 2000;
		frames(a, 20, { priority: false, active: ['z'] });
		a.noteTranscript('move Jane to General', { startMs: 1000, endMs: 1400 });
		a.markTurn();
		result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.denied, true);
		assert.match(result.spoken, /Only the bot owner/);
		assert.ok(!sent.some((s) => s.moved));
	});

	it('pins the turn to the moment of the request, so a later word from the owner cannot authorise someone else', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 30, { priority: true, active: ['o'] });
		a.noteTranscript('move Alex over', { startMs: 0, endMs: 600 }); // the owner's EARLIER (finished) request
		a.markTurn();
		clock.now += 3000;
		frames(a, 20, { priority: false, active: ['z'] });
		a.noteTranscript('me too', { startMs: 600, endMs: 1000 }); // Sam is asking, without saying the keyword
		const samTurn = a.markTurn(); // the brain started working on Sam's request
		clock.now += 4000;
		frames(a, 20, { priority: true, active: ['o'] });
		a.noteTranscript('all right', { startMs: 1000, endMs: 1400 }); // the owner threw in a remark
		a.markTurn();

		// Without the pin (the old behaviour) the owner's remark would have authorised Sam's request.
		assert.equal((await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps)).ok, true);
		sent.length = 0;

		deps.currentTurn = () => samTurn; // the moment the request was born
		const pinned = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(pinned.denied, true, pinned.spoken);
		assert.ok(!sent.some((s) => s.moved), "Sam's request must not be carried out");
	});

	it('keeps the pinned turn while it waits for the transcript', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 20, { priority: false, active: ['z'] });
		a.noteTranscript('move Jane', { startMs: 0, endMs: 400 }); // Sam asked for it
		const samTurn = a.markTurn();
		deps.currentTurn = () => samTurn;
		deps.awaitTranscript = async () => {
			// While we wait the owner speaks and a new turn opens
			clock.now += 500;
			frames(a, 20, { priority: true, active: ['o'] });
			a.noteTranscript('move Jane', { startMs: 400, endMs: 800 });
			a.markTurn();
		};
		const result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.denied, true, result.spoken);
		assert.ok(!sent.some((s) => s.moved));
	});

	it('refuses rather than deciding on an older command when the transcript never arrives', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 30, { priority: true, active: ['o'] });
		a.noteTranscript('move Jane to General', { startMs: 0, endMs: 600 }); // an earlier, finished request
		clock.now += 5000;
		frames(a, 300, { priority: false, active: ['z'] }); // six seconds of someone else, never transcribed
		a.markTurn();
		deps.awaitTranscript = async () => {}; // the transcript still does not turn up
		const result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.denied, true, result.spoken);
		assert.ok(!sent.some((entry) => entry.moved), 'nothing is moved on a stale command');
	});

	it('waits a moment for a late transcript before deciding', async () => {
		const { deps, sent } = makeDeps();
		const clock = { now: 50_000 };
		const a = withAttribution(deps, clock);
		frames(a, 50, { priority: true, active: ['o'] });
		a.markTurn();
		let waited = 0;
		deps.awaitTranscript = async () => {
			waited++;
			a.noteTranscript('move Jane to General', { startMs: 0, endMs: 1000 });
		};
		const result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(waited, 1, 'the gate has to wait for the transcript');
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { moved: 'General' });
	});
});

describe('edit_channel: layout', () => {
	function withCategory() {
		const made = makeDeps({ owner: true });
		const category = { id: 'c1', name: 'Lounge', type: ChannelType.GuildCategory, rawPosition: 0 };
		made.guild.channels.cache.set('c1', category);
		return made;
	}

	it('moves a channel into a category and can make it follow the category permissions', async () => {
		const { deps, sent } = withCategory();
		const result = await callTool('edit_channel', { channel: 'General', parent: 'Lounge', sync_permissions: true }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(
			sent.filter((entry) => entry.parent !== undefined),
			[{ parent: 'Lounge', lock: true }],
		);
		assert.match(result.spoken, /Lounge/);
	});

	it('takes a channel out of every category when the parent means "none"', async () => {
		const { deps, sent } = withCategory();
		const result = await callTool('edit_channel', { channel: 'General', parent: 'none' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(
			sent.filter((entry) => entry.parent !== undefined),
			[{ parent: null, lock: false }],
		);
	});

	it('reorders a channel and renames it in the same call', async () => {
		const { deps, sent } = withCategory();
		const result = await callTool('edit_channel', { channel: 'General', name: 'afk', position: 99 }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.find((entry) => entry.edited)?.edited?.name, 'afk');
		assert.equal(sent.find((entry) => entry.position !== undefined)?.position, 99);
	});

	it('refuses to put a category inside another one, and refuses an unknown category', async () => {
		const { deps } = withCategory();
		const nested = await callTool('edit_channel', { channel: 'Lounge', parent: 'Lounge' }, deps);
		assert.equal(nested.ok, false);
		assert.match(nested.spoken, /category/i);
		const missing = await callTool('edit_channel', { channel: 'General', parent: 'Nowhere Land' }, deps);
		assert.equal(missing.ok, false);
	});

	it('lists the categories and what is inside them', async () => {
		const { deps } = withCategory();
		deps.guild.channels.cache.get('v1').parentId = 'c1';
		const result = await callTool('list_channels', {}, deps);
		assert.equal(result.ok, true);
		assert.deepEqual(result.data.categories, [{ name: 'Lounge', channels: ['General'] }]);
	});
});

describe('voice_disconnect', () => {
	it('disconnects a member from voice without kicking them from the server', async () => {
		const { deps, sent, guild } = makeDeps({ owner: true });
		const member = guild.members.cache.get('1');
		member.voice.setChannel = async (channel) => sent.push({ voiceChannel: channel });
		const result = await callTool('voice_disconnect', { member: 'Jane' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { voiceChannel: null });
		assert.ok(!sent.some((entry) => entry.kick), 'the member is not kicked from the server');
	});

	it('says so when the member is not in a voice channel, and refuses without the owner', async () => {
		const { deps, guild } = makeDeps({ owner: true });
		guild.members.cache.get('1').voice = { channelId: null, channel: null };
		const idle = await callTool('voice_disconnect', { member: 'Jane' }, deps);
		assert.equal(idle.ok, false);
		const outsider = makeDeps();
		assert.equal((await callTool('voice_disconnect', { member: 'Jane' }, outsider.deps)).denied, true);
	});
});

describe('the bot acting on its own private messages', () => {
	function dmFixture() {
		const made = makeDeps({ owner: true });
		let messages = [{ id: 'm1', author: { id: 'bot' }, content: 'wrong person', createdTimestamp: 2, deletable: true, delete: async () => (messages = []) }];
		const dm = { id: 'dm1', name: 'DM', isDMBased: () => true, messages: { fetch: async () => new Map(messages.map((m) => [m.id, m])) } };
		made.deps.client = { user: { id: 'bot' }, channels: { cache: new Map([['dm1', dm]]), fetch: async () => dm } };
		made.deps.lastDirectMessage = () => ({ channelId: 'dm1', memberId: '1', name: 'Jane Doe' });
		made.deps.cfg = { ...made.deps.cfg, textChannelId: null };
		return { ...made, left: () => messages };
	}

	it('deletes a message it sent privately, which lives in no guild channel', async () => {
		const { deps, left } = dmFixture();
		const result = await callTool('delete_messages', { own: true, count: 1, dm: 'last' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(left().length, 0);
	});

	it('still uses the configured channel when nothing points at a private conversation', async () => {
		const { deps } = dmFixture();
		deps.cfg = { ...deps.cfg, textChannelId: '10' };
		const result = await callTool('delete_messages', { own: true, count: 1 }, deps);
		// That channel holds no message of ours, so it says so. What matters is that it looked THERE and
		// did not wander into the private conversation, and did not give up on which channel to use.
		assert.equal(result.ok, false);
		assert.doesNotMatch(result.spoken, /which channel/i, result.spoken);
	});
});

describe('two-step confirmation', () => {
	// The realtime path hands every tool call a FRESH deps object so the owner gate can pin the turn.
	// Anything the first call remembers has to survive that, or the question is asked forever.
	const perCall = (base) => ({ ...base, currentTurn: () => null });

	it('completes when each call gets its own deps object', async () => {
		const { deps, guild } = makeDeps({ owner: true });
		const deleted = [];
		guild.channels.cache.get('10').delete = async () => deleted.push('chat');
		const asked = await callTool('delete_channel', { channel: 'chat' }, perCall(deps));
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.deepEqual(deleted, [], 'nothing is deleted before the answer');
		const done = await callTool('delete_channel', { channel: 'chat', confirm: true }, perCall(deps));
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(deleted, ['chat']);
	});

	it('refuses a confirmation that names a different target', async () => {
		const { deps, guild } = makeDeps({ owner: true });
		const deleted = [];
		guild.channels.cache.get('10').delete = async () => deleted.push('chat');
		guild.channels.cache.get('v1').delete = async () => deleted.push('General');
		await callTool('delete_channel', { channel: 'chat' }, perCall(deps));
		const other = await callTool('delete_channel', { channel: 'General', confirm: true }, perCall(deps));
		assert.equal(other.ok, false, 'the answer belongs to the other channel');
		assert.deepEqual(deleted, []);
	});

	it("keeps one server from confirming another server's deletion", async () => {
		const alpha = makeDeps({ owner: true });
		const beta = makeDeps({ owner: true });
		alpha.guild.id = 'alpha';
		beta.guild.id = 'beta';
		const deleted = [];
		beta.guild.channels.cache.get('10').delete = async () => deleted.push('beta-chat');
		await callTool('delete_channel', { channel: 'chat' }, perCall(alpha.deps));
		const crossed = await callTool('delete_channel', { channel: 'chat', confirm: true }, perCall(beta.deps));
		assert.equal(crossed.ok, false, 'alpha asking must not let beta delete');
		assert.deepEqual(deleted, []);
	});
});

describe('member lookup', () => {
	it('resolves a raw user id and a mention, not just a name', async () => {
		const { deps, guild } = makeDeps({ owner: true });
		const jane = guild.members.cache.get('1');
		jane.roles = { cache: new Map() };
		jane.joinedAt = new Date(0);
		guild.members.cache.set('389223135133564939', { ...jane, id: '389223135133564939', displayName: 'Owner' });
		for (const value of ['389223135133564939', '<@389223135133564939>', '<@!389223135133564939>']) {
			const result = await callTool('user_info', { member: value }, deps);
			assert.equal(result.ok, true, `${value}: ${result.spoken}`);
			assert.match(result.spoken, /Owner/);
		}
	});

	it('falls back to whoever is speaking when no member is given', async () => {
		const { deps, guild } = makeDeps({ owner: true });
		const jane = guild.members.cache.get('1');
		jane.roles = { cache: new Map() };
		jane.joinedAt = new Date(0);
		deps.currentSpeakerId = () => '1';
		const result = await callTool('user_info', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.match(result.spoken, /Jane Doe/);
	});
});

describe('parsePermissions', () => {
	it('prefers the suffixed form of a real alias over a longer, stronger permission', () => {
		// "messages" used to reach the "manage messages" alias and hand out moderation rights.
		assert.deepEqual(parsePermissions(['messages']).flags, ['SendMessages']);
		assert.deepEqual(parsePermissions(['connectable']).flags, ['Connect']);
	});

	it('refuses a bare word that only matches a multi-word permission', () => {
		const result = parsePermissions(['channel']);
		assert.deepEqual(result.flags, [], 'a bare "channel" must not become Manage Channels');
		assert.deepEqual(result.unknown, ['channel']);
		assert.deepEqual(parsePermissions(['manage channels']).flags, ['ManageChannels'], 'the explicit phrase still works');
	});

	it('expands a group, including a suffixed spelling of it', () => {
		const expected = ['ViewChannel', 'Connect', 'SendMessages'];
		assert.deepEqual(parsePermissions(['access']).flags, expected);
		assert.deepEqual(parsePermissions(['accessible']).flags, expected);
	});

	it('splits a single string that names several permissions', () => {
		assert.deepEqual(parsePermissions(['view and connect']).flags, ['ViewChannel', 'Connect']);
		assert.deepEqual(parsePermissions('connect, view').flags, ['Connect', 'ViewChannel']);
	});

	it('reports an inherited object key as unknown instead of throwing', () => {
		const result = parsePermissions(['constructor', 'toString']);
		assert.deepEqual(result.flags, []);
		assert.deepEqual(result.unknown, ['constructor', 'toString']);
	});
});

describe('set_channel_permission: exclusive access', () => {
	it('keeps its own access before closing the channel for everyone', async () => {
		const { deps, sent, guild } = makeDeps({ owner: true });
		// A bot with Manage Roles but no Administrator: the case where the order actually matters, because
		// denying ViewChannel for @everyone would otherwise take the bot's own access away mid-operation.
		const notAdmin = { has: (bit) => bit !== PermissionFlagsBits.Administrator };
		guild.members.me = { id: 'bot', permissions: notAdmin };
		const voice = guild.channels.cache.get('v1');
		voice.permissionsFor = () => notAdmin;
		const result = await callTool(
			'set_channel_permission',
			{ channel: 'General', target: 'chillz', allow: ['connect', 'view'], only: true },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		const order = sent.filter((entry) => entry.overwrite).map((entry) => entry.target);
		assert.deepEqual(order, ['bot', 'r1', 'everyone'], 'the bot keeps access first, everyone is closed last');
		const byTarget = Object.fromEntries(sent.filter((e) => e.overwrite).map((e) => [e.target, e.overwrite]));
		assert.deepEqual(byTarget.bot, { Connect: true, ViewChannel: true });
		assert.deepEqual(byTarget.everyone, { Connect: false, ViewChannel: false });
	});

	it('prefers an exact member over a role that only matches loosely', async () => {
		const { deps, sent, guild } = makeDeps({ owner: true });
		guild.roles.cache.set('r2', { id: 'r2', name: 'Janitor', position: 1, managed: false, editable: true });
		const result = await callTool('set_channel_permission', { channel: 'chat', target: 'Jane Doe', deny: ['view'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { overwrite: { ViewChannel: false }, target: '1' }, 'the member, not the Janitor role');
	});
});

describe('send_message / send_dm', () => {
	it('drops the @everyone tag for anyone but the owner, and really pings for the owner', async () => {
		const { deps, sent } = makeDeps();
		const result = await callTool('send_message', { channel: 'chat', text: 'announcement', mentions: ['everyone'] }, deps);
		assert.equal(result.ok, true);
		assert.deepEqual(sent[0].allowedMentions.parse, []);
		assert.equal(sent[0].content, 'announcement');
		assert.ok(result.warnings.some((w) => w.includes('owner')));

		const owner = makeDeps({ owner: true });
		await callTool('send_message', { channel: 'chat', text: 'announcement', mentions: ['everyone'] }, owner.deps);
		assert.deepEqual(owner.sent[0].allowedMentions.parse, ['everyone']);
		assert.equal(owner.sent[0].content, '@everyone announcement');
	});

	it('send_dm obeys the rate limit', async () => {
		resetDmLimiter();
		// A DM to somebody other than the person asking is the owner's to ask for.
		const { deps, sent } = makeDeps({ owner: true });
		assert.equal((await callTool('send_dm', { to: 'Jane', text: 'one' }, deps)).ok, true);
		assert.equal((await callTool('send_dm', { to: 'Jane', text: 'two' }, deps)).ok, true);
		const third = await callTool('send_dm', { to: 'Jane', text: 'three' }, deps);
		assert.equal(third.ok, false, '2 per minute per target');
		assert.equal(sent.filter((s) => s.dm).length, 2);
		resetDmLimiter();
	});

	it('emoji: an already formatted <:name:id> is not wrapped a second time', async () => {
		const { deps, sent, guild } = makeDeps();
		guild.emojis.cache.set('3', { id: '3', name: 'wave', toString: () => '<:wave:3>' });
		await callTool('send_message', { channel: 'chat', text: 'hello <:wave:3> and :wave:' }, deps);
		assert.equal(sent[0].content, 'hello <:wave:3> and <:wave:3>');
	});
});

describe('channel and voice tools', () => {
	it('lock_channel neutralises SendMessages when unlocking instead of deleting the overwrite', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		await callTool('lock_channel', { channel: 'chat', locked: false }, deps);
		assert.deepEqual(sent.at(-1), { overwrite: { SendMessages: null }, target: 'everyone' });
		assert.ok(!sent.some((s) => s.deleted));
	});

	it('set_channel_permission: "only the chillz role may join" turns it on for the role and off for everyone', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		const result = await callTool('set_channel_permission', { channel: 'General', target: 'chillz', allow: ['connect', 'see'], only: true }, deps);
		assert.equal(result.ok, true, result.spoken);
		const byTarget = Object.fromEntries(sent.filter((s) => s.overwrite).map((s) => [s.target, s.overwrite]));
		assert.deepEqual(byTarget.r1, { Connect: true, ViewChannel: true });
		assert.deepEqual(byTarget.everyone, { Connect: false, ViewChannel: false });
		assert.match(result.spoken, /connect, view on for the chillz role/);
		assert.match(result.spoken, /off for everyone/);
	});

	it('set_channel_permission: handles a person target, raw flag names, an unknown permission and the protected everyone reset', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		let result = await callTool('set_channel_permission', { channel: 'chat', target: 'Jane', deny: ['send_messages', 'ViewChannel'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { overwrite: { SendMessages: false, ViewChannel: false }, target: '1' });

		result = await callTool('set_channel_permission', { channel: 'chat', target: 'everyone', allow: ['fly'] }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /do not recognise these permissions: fly/);

		result = await callTool('set_channel_permission', { channel: 'chat', target: 'everyone', reset: true }, deps);
		assert.equal(result.ok, false, 'resetting everything for everyone would expose a hidden channel');
		assert.ok(!sent.some((s) => s.deleted));

		result = await callTool('set_channel_permission', { channel: 'chat', target: 'Jane', reset: true }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { deleted: '1' });

		result = await callTool('set_channel_permission', { channel: 'chat', target: 'Jane', reset: true, deny: ['write'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { overwrite: { SendMessages: null }, target: '1' });

		const noOwner = makeDeps();
		assert.equal((await callTool('set_channel_permission', { channel: 'chat', target: 'Jane', deny: ['write'] }, noOwner.deps)).denied, true);
	});

	it('grant_role: the server owner can be given a role too (what counts is the position of the role)', async () => {
		const { deps, sent, guild } = makeDeps({ owner: true });
		guild.ownerId = '1';
		guild.members.me = { id: 'bot', permissions: { has: () => true }, roles: { highest: { name: 'Melis', position: 9 } } };
		const jane = guild.members.cache.get('1');
		jane.manageable = false;
		jane.roles = { add: async (role) => sent.push({ roleAdded: role.name }), remove: async () => {} };
		const result = await callTool('grant_role', { member: 'Jane', role: 'chillz' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { roleAdded: 'chillz' });
	});

	it('join_voice: resolves a channel name given as a string, and accepts a channel object as well', async () => {
		const { deps, sent } = makeDeps();
		assert.equal((await callTool('join_voice', { channel: 'general' }, deps)).ok, true);
		assert.deepEqual(sent.at(-1), { joined: 'General' });
		assert.equal((await callTool('join_voice', { channel: { id: 'v1', name: 'General' } }, deps)).ok, true);
	});

	it('move_member runs behind the owner gate', async () => {
		const noOwner = makeDeps();
		assert.equal((await callTool('move_member', { member: 'Jane', channel: 'General' }, noOwner.deps)).denied, true);
		const { deps, sent } = makeDeps({ owner: true });
		const result = await callTool('move_member', { member: 'Jane', channel: 'General', come_along: false }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.at(-1), { moved: 'General' });
	});
});

describe('moderation: confirmation on a fuzzy name match', () => {
	it('kick_member asks first when the name is not an exact match, and acts on confirm', async () => {
		const { deps, sent } = makeDeps({ owner: true });
		const asked = await callTool('kick_member', { member: 'Janee Doee' }, deps); // fuzzy
		assert.equal(asked.ok, false);
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.ok(!sent.some((s) => s.kick));
		const done = await callTool('kick_member', { member: 'Janee Doee', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.ok(sent.some((s) => s.kick === '1'));
	});

	it('kick_member names the target and waits, even when the name matched exactly', async () => {
		// Removing somebody from the server is not undone by saying sorry, and the assistant only has a
		// transcript of a room where people talk over each other, so it always asks first.
		const { deps, sent } = makeDeps({ owner: true });
		const asked = await callTool('kick_member', { member: 'Jane' }, deps);
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.match(asked.spoken, /Jane Doe/, 'the target is said out loud');
		assert.ok(!sent.some((s) => s.kick), 'nobody is removed before the answer');
		const done = await callTool('kick_member', { member: 'Jane', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.ok(sent.some((s) => s.kick === '1'));
	});
});

describe('set_setting', () => {
	it('awaits applySetting and passes an {ok:false} result straight through', async () => {
		const { deps } = makeDeps({ owner: true });
		deps.applySetting = async (name, value) => (name === 'local_tts' ? { ok: false, spoken: 'the local server is down' } : name === 'record' ? value === 'off' ? false : true : null);
		deps.settingNames = () => ['local_tts', 'record'];
		const failed = await callTool('set_setting', { name: 'local_tts', value: 'on' }, deps);
		assert.equal(failed.ok, false);
		assert.equal(failed.spoken, 'the local server is down');
		const off = await callTool('set_setting', { name: 'record', value: 'off' }, deps);
		assert.equal(off.ok, true);
		assert.ok(off.spoken.includes('off'), off.spoken);
	});
});

describe('music / memory / summary tools', () => {
	it('set_music_volume says the old and the new value, and logs the change', async () => {
		const { deps } = makeDeps();
		const logs = [];
		deps.log = (line) => logs.push(line);
		let volume = 0.35;
		deps.music = { setVolume: (v) => (volume = v), state: () => ({ playing: true, queue: [], volume }) };
		let result = await callTool('set_music_volume', { percent: 50 }, deps);
		assert.equal(result.ok, true);
		assert.equal(volume, 0.5);
		assert.match(result.spoken, /was 35 percent, I set it to 50 percent/);
		assert.ok(logs.some((l) => l.includes('[music] volume: 35% -> 50%')), logs.join(' | '));
		result = await callTool('set_music_volume', { percent: 50 }, deps);
		assert.match(result.spoken, /already 50 percent/);
	});

	it('play_music and its neighbours work against a fake player, and explain themselves without one', async () => {
		const { deps } = makeDeps();
		const calls = [];
		deps.music = {
			volume: 0.35,
			current: null,
			queue: [],
			enqueue: async (query) => (calls.push(query), { track: { title: `T:${query}`, kind: 'url' }, position: 0, startedNow: true }),
			stop: () => null,
			pause: () => false,
			resume: () => false,
			skip: () => null,
			setVolume: (v) => v,
			state: () => ({ playing: false, queue: [] }),
			nowPlayingText: () => 'Nothing is playing right now.',
			remove: () => null,
		};
		const played = await callTool('play_music', { query: 'moonlight sonata' }, deps);
		assert.equal(played.ok, true);
		assert.ok(played.spoken.includes('T:moonlight sonata'));
		assert.equal((await callTool('pause_music', {}, deps)).ok, false);
		assert.equal((await callTool('set_music_volume', { percent: 40 }, deps)).ok, true);
		assert.equal((await callTool('set_music_volume', { percent: 'abc' }, deps)).ok, false);
		delete deps.music;
		assert.equal((await callTool('play_music', { query: 'x' }, deps)).ok, false, 'it explains itself when music is switched off');
	});

	it('remember/recall/forget: anyone may delete their own note, only the owner may delete someone else\'s', async () => {
		const notes = new Map();
		const memory = {
			add: async (id, text) => (notes.set(id, [...(notes.get(id) ?? []), { text }]), { text }),
			notesFor: (id) => notes.get(id) ?? [],
			remove: async (id) => notes.delete(id),
			clear: async (id) => notes.delete(id),
		};
		const { deps } = makeDeps();
		deps.memory = memory;
		deps.currentSpeakerId = () => '1';
		deps.currentSpeakerName = () => 'Jane Doe';
		assert.equal((await callTool('remember_note', { note: 'has a cat called Smokey' }, deps)).ok, true);
		const recalled = await callTool('recall_notes', {}, deps);
		assert.ok(recalled.spoken.includes('Smokey'));
		// somebody else (speaker 2) cannot delete Jane's note
		deps.currentSpeakerId = () => '2';
		assert.equal((await callTool('forget_note', { member: 'Jane', note: 'all' }, deps)).denied, true);
		deps.currentSpeakerId = () => '1';
		assert.equal((await callTool('forget_note', { note: 'all' }, deps)).ok, true);
		assert.equal(notes.has('1'), false);
	});

	it('summarize_conversation speaks what deps.summarize returns', async () => {
		const { deps } = makeDeps();
		deps.summarize = async ({ hours }) => ({ summary: `summary ${hours}`, count: 3 });
		const result = await callTool('summarize_conversation', { hours: 2 }, deps);
		assert.equal(result.spoken, 'summary 2');
	});
});

describe('owner gate: Jev reads the owner s own words when the keywords miss', async () => {
	const { ownerGate } = await import('../../src/tools/helpers.js');
	const frames = (a, n, frame) => {
		for (let i = 0; i < n; i++) a.onFrame(frame);
	};
	const setup = (jev) => {
		const { deps } = makeDeps();
		const clock = { now: 50_000 };
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => clock.now });
		deps.commandSpeaker = (words, opts) => a.commandSpeaker(words, opts);
		deps.lastUtterance = (opts) => a.lastUtterance(opts);
		deps.transcriptLagging = (opts) => a.transcriptLagging(opts);
		deps.awaitTranscript = async () => {};
		deps.nameFor = (id) => id;
		deps.ownerUtterance = (opts) => a.ownerUtterance(opts);
		deps.toolDescription = () => 'Turns a bot setting on or off, such as quiet.';
		deps.jev = jev;
		return { deps, a, clock };
	};
	const ownerSays = (a, text) => {
		frames(a, 50, { priority: true, active: ['o'] });
		a.noteTranscript(text, { startMs: 0, endMs: 1000 });
	};

	// Live failure: the owner said "melis artik konusmaya devam edebilirsin", the keyword list knew
	// none of those words in that shape, and the gate refused with a guest's "sus" from eight seconds
	// earlier. The audio said the owner alone; Jev says the words ask for the tool; that is enough.
	it('lets the owner through when Jev is sure they asked, in words the list did not have', async () => {
		const asked = [];
		const { deps, a } = setup({ enabled: true, asks: async (input) => (asked.push(input), 0.93) });
		ownerSays(a, 'melis artik konusmaya devam edebilirsin');
		a.markTurn();
		assert.equal(await ownerGate(deps, ['zzz'], 'set_setting'), null, 'allowed');
		assert.equal(asked[0].line, 'melis artik konusmaya devam edebilirsin');
		assert.equal(asked[0].tool, 'set_setting');
		assert.match(asked[0].description, /quiet/);
	});

	it('still refuses when Jev is not sure, and when there is no Jev', async () => {
		const unsure = setup({ enabled: true, asks: async () => 0.4 });
		ownerSays(unsure.a, 'melis artik konusmaya devam edebilirsin');
		unsure.a.markTurn();
		assert.equal((await ownerGate(unsure.deps, ['zzz'], 'set_setting'))?.denied, true);
		const none = setup(null);
		ownerSays(none.a, 'melis artik konusmaya devam edebilirsin');
		none.a.markTurn();
		assert.equal((await ownerGate(none.deps, ['zzz'], 'set_setting'))?.denied, true);
	});

	it('never opens on somebody else s words, however sure Jev is', async () => {
		const { deps, a } = setup({ enabled: true, asks: async () => 0.99 });
		frames(a, 50, { priority: false, active: ['z'] });
		a.noteTranscript('melis artik konusmaya devam edebilirsin', { startMs: 0, endMs: 1000 });
		a.markTurn();
		assert.equal((await ownerGate(deps, ['zzz'], 'set_setting'))?.denied, true);
	});

	it('does not open when somebody cut in cleanly after the owner', async () => {
		const { deps, a, clock } = setup({ enabled: true, asks: async () => 0.99 });
		ownerSays(a, 'melis artik konusmaya devam edebilirsin');
		clock.now += 500;
		frames(a, 20, { priority: false, active: ['z'] });
		a.noteTranscript('hayir yapma', { startMs: 1000, endMs: 1400 });
		a.markTurn();
		assert.equal((await ownerGate(deps, ['zzz'], 'set_setting'))?.denied, true);
	});
});
