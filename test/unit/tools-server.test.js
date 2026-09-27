import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, GuildDefaultMessageNotifications, GuildFeature, PermissionFlagsBits } from 'discord.js';
import { callTool, toolMeta } from '../../src/tools.js';
import { ownerVoice } from '../owner-voice.js';

// Every tool in src/tools/server.js, so the gate test cannot silently miss a newly added one.
const SERVER_TOOLS = [
	'edit_server',
	'server_settings',
	'set_server_settings',
	'list_integrations',
	'prune_count',
	'prune_members',
	'start_stage',
	'end_stage',
	'invite_to_stage',
];

const FULL_PERMISSIONS = [
	PermissionFlagsBits.ManageGuild,
	PermissionFlagsBits.KickMembers,
	PermissionFlagsBits.ManageChannels,
	PermissionFlagsBits.MuteMembers,
	PermissionFlagsBits.MoveMembers,
];

/** A PermissionsBitField stand-in: only the bits handed in are held. */
function permissions(bits) {
	return { has: (bit) => bits.includes(bit) };
}

/**
 * Mock guild in the shape src/tools/server.js reads: a text, a voice and a stage channel, one member
 * sitting in the stage channel, and every write recorded in `calls` so a refusal can be told apart
 * from a silent success.
 */
function makeDeps({ owner = false, held = FULL_PERMISSIONS, features = [], pruneCount = 5, stageInstances = [] } = {}) {
	const calls = [];
	const me = { id: 'bot', permissions: permissions(held) };
	const permissionsFor = () => permissions(held);
	const text = { id: '10', name: 'chat', type: ChannelType.GuildText, permissionsFor };
	const voice = { id: 'v1', name: 'General', type: ChannelType.GuildVoice, permissionsFor };
	const stage = { id: 's1', name: 'Podium', type: ChannelType.GuildStageVoice, permissionsFor };
	const jane = {
		id: '1',
		displayName: 'Jane Doe',
		user: { username: 'jane', bot: false },
		voice: {
			channelId: 's1',
			channel: stage,
			setSuppressed: async (suppressed) => calls.push({ suppressed }),
		},
	};
	const guild = {
		id: 'g1',
		name: 'Test Server',
		description: 'a server',
		features,
		afkChannelId: 'v1',
		afkTimeout: 900,
		systemChannelId: '10',
		defaultMessageNotifications: GuildDefaultMessageNotifications.AllMessages,
		channels: { cache: new Map([['10', text], ['v1', voice], ['s1', stage]]) },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		emojis: { cache: new Map() },
		members: {
			me,
			cache: new Map([['1', jane]]),
			fetch: async () => new Map(),
			prune: async (options) => {
				calls.push({ prune: options });
				return options.dry ? guild.__pruneCount : guild.__pruneCount;
			},
		},
		stageInstances: {
			cache: new Map(stageInstances.map((instance) => [instance.id, instance])),
			create: async (channelId, options) => (calls.push({ stageCreate: { channelId, ...options } }), { id: 'si1', ...options }),
			delete: async (channelId) => calls.push({ stageDelete: channelId }),
			fetch: async () => null,
		},
		edit: async (patch) => calls.push({ edit: patch }),
		fetchIntegrations: async () =>
			new Map([
				['i1', { id: 'i1', name: 'Jukebox', type: 'discord', enabled: true, application: { id: 'a1', name: 'Jukebox', bot: { username: 'jukebox' } } }],
				['i2', { id: 'i2', name: 'twitchy', type: 'twitch', enabled: true, account: { name: 'twitchy' } }],
			]),
		__pruneCount: pruneCount,
	};
	const deps = {
		guild,
		cfg: { textChannelId: null },
		log: () => {},
		activity: () => {},
		currentVoiceChannel: () => stage,
		// Pending confirmations are module-level per guild; a private map keeps the tests independent.
		pendingConfirmations: new Map(),
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, guild, calls, stage, voice };
}

describe('server tools: the gate', () => {
	it('refuses every gated server tool when the owner did not ask', async () => {
		const gated = new Set(toolMeta().filter((tool) => tool.gated).map((tool) => tool.name));
		const expected = ['edit_server', 'set_server_settings', 'prune_members', 'start_stage', 'end_stage', 'invite_to_stage'];
		for (const name of expected) {
			assert.ok(gated.has(name), `${name} has to be owner-gated`);
			const { deps, calls } = makeDeps();
			const result = await callTool(name, {}, deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.denied, true, `${name} must come back refused by the gate`);
			assert.deepEqual(calls, [], `${name} must not touch the server when the gate is closed`);
		}
		for (const name of SERVER_TOOLS.filter((tool) => !expected.includes(tool))) {
			assert.ok(!gated.has(name), `${name} only reads, so it stays ungated`);
		}
	});
});

describe('edit_server', () => {
	it('renames the server and takes an icon from Discord\'s CDN', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool(
			'edit_server',
			{ name: 'Quiet Room', icon_url: 'https://cdn.discordapp.com/icons/1/abc.png' },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(calls.at(-1).edit.name, 'Quiet Room');
		assert.equal(calls.at(-1).edit.icon, 'https://cdn.discordapp.com/icons/1/abc.png');
		assert.match(result.spoken, /Quiet Room/);
	});

	it('refuses an image that does not come from Discord\'s CDN', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('edit_server', { icon_url: 'https://example.com/evil.png' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /cdn\.discordapp\.com/);
		assert.deepEqual(calls, [], 'nothing is sent when the link is refused');
	});

	it('refuses a banner on a server without the banner feature, and takes one when it has it', async () => {
		const url = 'https://media.discordapp.net/banners/1/abc.png';
		const without = makeDeps({ owner: true });
		const refused = await callTool('edit_server', { banner_url: url }, without.deps);
		assert.equal(refused.ok, false);
		assert.deepEqual(without.calls, []);

		const withFeature = makeDeps({ owner: true, features: [GuildFeature.Banner] });
		const done = await callTool('edit_server', { banner_url: url }, withFeature.deps);
		assert.equal(done.ok, true, done.spoken);
		assert.equal(withFeature.calls.at(-1).edit.banner, url);
	});

	it('clears the description when the argument means "none", and says so when nothing was asked for', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const cleared = await callTool('edit_server', { description: 'none' }, deps);
		assert.equal(cleared.ok, true, cleared.spoken);
		assert.equal(calls.at(-1).edit.description, null);

		const nothing = await callTool('edit_server', {}, deps);
		assert.equal(nothing.ok, false);
		assert.equal(calls.length, 1, 'an empty edit is not sent to Discord');
	});

	it('asks for the Manage Server permission instead of failing at the API', async () => {
		const { deps, calls } = makeDeps({ owner: true, held: [] });
		const result = await callTool('edit_server', { name: 'Quiet Room' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Server/);
		assert.deepEqual(calls, []);
	});
});

describe('server settings', () => {
	it('reads the AFK channel, the system channel and the notification level', async () => {
		const { deps } = makeDeps();
		const result = await callTool('server_settings', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.afkChannel, 'General');
		assert.equal(result.data.afkTimeoutMinutes, 15);
		assert.equal(result.data.systemChannel, 'chat');
		assert.match(result.spoken, /General/);
	});

	it('sets the AFK channel, snaps the timeout to a value Discord accepts and switches the notification level', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool(
			'set_server_settings',
			{ afk_channel: 'General', afk_timeout_minutes: 4, notifications: 'mentions' },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		const patch = calls.at(-1).edit;
		assert.equal(patch.afkChannel, 'v1');
		assert.equal(patch.afkTimeout, 300, '4 minutes snaps to the nearest allowed timeout');
		assert.equal(patch.defaultMessageNotifications, GuildDefaultMessageNotifications.OnlyMentions);
	});

	it('turns the system channel off on a word meaning "none"', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('set_server_settings', { system_channel: 'none' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(calls.at(-1).edit.systemChannel, null);
	});

	it('refuses an AFK channel it cannot find', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('set_server_settings', { afk_channel: 'Nowhere Land' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Nowhere Land/);
		assert.deepEqual(calls, []);
	});

	it('refuses a stage channel as the AFK channel', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('set_server_settings', { afk_channel: 'Podium' }, deps);
		assert.equal(result.ok, false);
		assert.deepEqual(calls, []);
	});
});

describe('list_integrations', () => {
	it('names the bots by their application and keeps the other integrations apart', async () => {
		const { deps } = makeDeps();
		const result = await callTool('list_integrations', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.count, 2);
		assert.equal(result.data.integrations[0].application, 'Jukebox');
		assert.equal(result.data.integrations[0].bot, 'jukebox');
		assert.match(result.spoken, /Jukebox/);
		assert.match(result.spoken, /twitchy/);
	});

	it('says which permission it needs instead of reading nothing', async () => {
		const { deps } = makeDeps({ held: [] });
		const result = await callTool('list_integrations', {}, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Server/);
	});
});

describe('prune', () => {
	it('counts without removing anybody', async () => {
		const { deps, calls } = makeDeps({ pruneCount: 7 });
		const result = await callTool('prune_count', { days: 14 }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(result.data, { days: 14, count: 7 });
		assert.deepEqual(calls.map((call) => call.prune.dry), [true], 'only the dry run is allowed to happen');
		assert.match(result.spoken, /7/);
	});

	it('keeps the day count inside the 1-30 range, and never reads a bad value as "one day"', async () => {
		const { deps, calls } = makeDeps();
		await callTool('prune_count', { days: 400 }, deps);
		assert.equal(calls.at(-1).prune.days, 30);
		await callTool('prune_count', { days: 0 }, deps);
		assert.equal(calls.at(-1).prune.days, 30, 'zero falls back to the mildest setting, not the harshest');
		await callTool('prune_count', {}, deps);
		assert.equal(calls.at(-1).prune.days, 30);
		await callTool('prune_count', { days: 3 }, deps);
		assert.equal(calls.at(-1).prune.days, 3);
	});

	it('says the number and asks first, then removes the members once confirmed', async () => {
		const { deps, calls } = makeDeps({ owner: true, pruneCount: 12 });
		const owner = ownerVoice(deps);
		const asked = await callTool('prune_members', { days: 30 }, deps);
		assert.equal(asked.ok, false);
		assert.equal(asked.needs_confirmation, true);
		assert.match(asked.spoken, /12/, 'the dry-run count has to be said before anything happens');
		assert.deepEqual(calls.map((call) => call.prune.dry), [true], 'the question must not prune');

		owner.says('yes, do it');
		const done = await callTool('prune_members', { days: 30, confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.match(done.spoken, /12/);
		assert.deepEqual(calls.map((call) => call.prune.dry), [true, true, undefined]);
		assert.equal(calls.at(-1).prune.count, true);
		assert.equal(done.data.pruned, 12);
	});

	it('refuses a confirmation once the number has moved, and prunes nobody', async () => {
		const { deps, guild, calls } = makeDeps({ owner: true, pruneCount: 5 });
		const owner = ownerVoice(deps);
		const asked = await callTool('prune_members', { days: 30 }, deps);
		assert.equal(asked.needs_confirmation, true);
		guild.__pruneCount = 40; // forty people would go now, not five
		owner.says('yes');
		const result = await callTool('prune_members', { days: 30, confirm: true }, deps);
		assert.equal(result.ok, false, 'a confirmation for five must not remove forty');
		assert.ok(!calls.some((call) => call.prune.dry === undefined), 'nothing was actually pruned');
	});

	it('does nothing at all when the prune would remove nobody', async () => {
		const { deps, calls } = makeDeps({ owner: true, pruneCount: 0 });
		const result = await callTool('prune_members', { days: 30 }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.pruned, 0);
		assert.deepEqual(calls.map((call) => call.prune.dry), [true]);
	});

	it('needs Kick Members as well as Manage Server', async () => {
		const { deps, calls } = makeDeps({ owner: true, held: [PermissionFlagsBits.ManageGuild] });
		const result = await callTool('prune_members', { days: 30 }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Kick Members/);
		assert.deepEqual(calls, [], 'not even the dry run is attempted without the permission');
	});
});

describe('stage channels', () => {
	it('starts a stage with a topic in the channel the bot is in', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('start_stage', { topic: 'Friday questions' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(calls.at(-1).stageCreate.channelId, 's1');
		assert.equal(calls.at(-1).stageCreate.topic, 'Friday questions');
		assert.match(result.spoken, /Podium/);
	});

	it('refuses to start a stage in a channel that is not a stage channel', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('start_stage', { topic: 'hello', channel: 'General' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /General/);
		assert.deepEqual(calls, []);
	});

	it('refuses to start a second stage in the same channel', async () => {
		const { deps, calls } = makeDeps({ owner: true, stageInstances: [{ id: 'si0', channelId: 's1', topic: 'already going' }] });
		const result = await callTool('start_stage', { topic: 'hello' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /already going/);
		assert.deepEqual(calls, []);
	});

	it('says which stage permission is missing', async () => {
		const { deps, calls } = makeDeps({ owner: true, held: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers] });
		const result = await callTool('start_stage', { topic: 'hello' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Move Members/);
		assert.deepEqual(calls, []);
	});

	it('ends a running stage and refuses when there is none', async () => {
		const running = makeDeps({ owner: true, stageInstances: [{ id: 'si0', channelId: 's1', topic: 'going' }] });
		const ended = await callTool('end_stage', {}, running.deps);
		assert.equal(ended.ok, true, ended.spoken);
		assert.deepEqual(running.calls.at(-1), { stageDelete: 's1' });

		const idle = makeDeps({ owner: true });
		const result = await callTool('end_stage', {}, idle.deps);
		assert.equal(result.ok, false);
		assert.deepEqual(idle.calls, []);
	});

	it('invites somebody in the stage channel to speak and can put them back in the audience', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const up = await callTool('invite_to_stage', { member: 'Jane' }, deps);
		assert.equal(up.ok, true, up.spoken);
		assert.deepEqual(calls.at(-1), { suppressed: false });
		assert.match(up.spoken, /Jane Doe/);

		const down = await callTool('invite_to_stage', { member: 'Jane', speaker: false }, deps);
		assert.equal(down.ok, true, down.spoken);
		assert.deepEqual(calls.at(-1), { suppressed: true });
	});

	it('refuses when the person is not in a stage channel, and when there is no such person', async () => {
		const { deps, guild, calls } = makeDeps({ owner: true });
		guild.members.cache.get('1').voice.channel = { id: 'v1', name: 'General', type: ChannelType.GuildVoice };
		const wrongChannel = await callTool('invite_to_stage', { member: 'Jane' }, deps);
		assert.equal(wrongChannel.ok, false);
		assert.match(wrongChannel.spoken, /General/);

		const missing = await callTool('invite_to_stage', { member: 'Nobody At All' }, deps);
		assert.equal(missing.ok, false);
		assert.deepEqual(calls, []);
	});

	it('needs Mute Members before it can move somebody onto the stage', async () => {
		const { deps, calls } = makeDeps({ owner: true, held: [] });
		const result = await callTool('invite_to_stage', { member: 'Jane' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Mute Members/);
		assert.deepEqual(calls, []);
	});
});
