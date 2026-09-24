import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { ActivityLog } from '../../src/panel.js';
import { ChannelReader } from '../../src/reader.js';
import { channelFilterFor, guildScope, summarizeConversation, transcriptFromEvents } from '../../src/summary.js';
import { callTool } from '../../src/tools.js';
import { listenersOf } from '../../src/tools/summary.js';

// The panel log is one buffer for every server and every text channel, so a summary has to be cut down
// to the server it is asked in and to the channels its audience could read. What is under test here is
// what must NOT come out: a moderator channel for a plain member, and anything from another server.

const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/**
 * A server with #general (everyone reads it), #mods (the "mod" role only), #announcements (visible, but
 * its history is closed to @everyone) and a private thread under #general that only "insider" is in.
 */
function makeGuild(id = 'alpha', name = 'Alpha') {
	const guild = { id, name, roles: { everyone: { id: `${id}-everyone`, everyone: true } } };
	const can = (subject, rule) => {
		const roles = subject?.everyone ? [] : [...(subject?.roles?.cache?.keys?.() ?? [])];
		return rule({ roles, everyone: Boolean(subject?.everyone) });
	};
	const text = (channelId, channelName, rule, extra = {}) => ({
		id: channelId,
		name: channelName,
		type: ChannelType.GuildText,
		guild,
		permissionsFor: (subject) => new PermissionsBitField(can(subject, rule)),
		...extra,
	});
	const general = text(`${id}-general`, 'general', () => READ);
	const mods = text(`${id}-mods`, 'mods', ({ roles }) => (roles.includes('mod') ? READ : []));
	const announcements = text(`${id}-news`, 'announcements', ({ everyone }) => (everyone ? [PermissionFlagsBits.ViewChannel] : READ));
	const thread = text(`${id}-thread`, 'secret-thread', () => READ, {
		type: ChannelType.PrivateThread,
		members: { cache: new Map([['insider', {}]]) },
	});
	guild.channels = { cache: new Map([general, mods, announcements, thread].map((channel) => [channel.id, channel])) };
	return guild;
}

/** A member holding `roles` (role ids). */
function member(id, roles = [], { bot = false } = {}) {
	return { id, displayName: id, user: { id, username: id, bot }, roles: { cache: new Map(roles.map((role) => [role, { id: role }])) } };
}

const now = () => new Date().toISOString();
const say = (guildLabel, text, extra = {}) => ({ kind: 'voice', direction: 'in', whoName: 'Jane', text, at: now(), meta: { guild: guildLabel }, ...extra });
const wrote = (guildId, channelId, text) => ({
	kind: 'channel',
	direction: 'in',
	whoName: 'Sam',
	text,
	at: now(),
	meta: { channel: '#x', channelId, guildId, guild: guildId === 'alpha' ? 'Alpha' : 'Beta' },
});

describe('channelFilterFor', () => {
	const guild = makeGuild();

	it('keeps a channel only when every reader may see it and read its history', () => {
		const plain = member('plain');
		const moderator = member('moderator', ['mod']);
		const alone = channelFilterFor(guild, [moderator]);
		assert.equal(alone('alpha-general'), true);
		assert.equal(alone('alpha-mods'), true);
		const together = channelFilterFor(guild, [moderator, plain]);
		assert.equal(together('alpha-general'), true);
		assert.equal(together('alpha-mods'), false, 'a plain member listening closes the moderator channel');
	});

	it('judges nobody, or somebody it cannot place, as @everyone, which needs Read Message History too', () => {
		for (const readers of [[], [null], undefined]) {
			const filter = channelFilterFor(guild, readers);
			assert.equal(filter('alpha-general'), true);
			assert.equal(filter('alpha-mods'), false);
			assert.equal(filter('alpha-news'), false, 'View Channel alone is not enough to read the past');
		}
		assert.equal(channelFilterFor(guild, [member('plain')])('alpha-news'), true);
	});

	it('leaves out a private thread for anyone not in it, and anything it cannot find', () => {
		assert.equal(channelFilterFor(guild, [member('insider')])('alpha-thread'), true);
		assert.equal(channelFilterFor(guild, [member('outsider')])('alpha-thread'), false);
		const filter = channelFilterFor(guild, [member('insider')]);
		assert.equal(filter('deleted-channel'), false);
		assert.equal(filter(null), false, 'a message logged without its channel id cannot be placed');
	});
});

describe('guildScope', () => {
	const alpha = makeGuild('alpha', 'Alpha');

	it('matches a logged message on its guild id and a voice line on the label its session stamps', () => {
		const inAlpha = guildScope(alpha);
		assert.equal(inAlpha(wrote('alpha', 'alpha-general', 'x')), true);
		assert.equal(inAlpha(wrote('beta', 'beta-general', 'x')), false);
		assert.equal(inAlpha(say('Alpha', 'x')), true);
		assert.equal(inAlpha(say('Beta', 'x')), false);
		// The id wins over the label: a stale or shared name cannot pull another server's message in.
		assert.equal(inAlpha({ kind: 'channel', meta: { guild: 'Alpha', guildId: 'beta' } }), false);
	});

	it('never matches a DM, an untagged event, or anything when there is no server', () => {
		const inAlpha = guildScope(alpha);
		assert.equal(inAlpha({ kind: 'dm', text: 'secret', meta: null }), false);
		assert.equal(inAlpha({ kind: 'voice', text: 'old line' }), false);
		assert.equal(guildScope(null)(say('Alpha', 'x')), false);
	});

	it('does not trust a label that another server the bot is in shares', () => {
		const twin = { id: 'twin', name: 'Alpha' };
		const client = { guilds: { cache: new Map([['alpha', alpha], ['twin', twin]]) } };
		const inAlpha = guildScope(alpha, client);
		assert.equal(inAlpha(say('Alpha', 'x')), false);
		assert.equal(inAlpha(wrote('alpha', 'alpha-general', 'x')), true, 'the id still places a logged message');
	});
});

describe('transcriptFromEvents / summarizeConversation: scoped', () => {
	const events = () => [
		say('Alpha', 'alpha voice line'),
		say('Beta', 'beta voice line'),
		wrote('alpha', 'alpha-general', 'general hello'),
		wrote('alpha', 'alpha-mods', 'ban the troll quietly'),
		wrote('beta', 'beta-general', 'beta chatter'),
		{ kind: 'dm', direction: 'in', whoName: 'Bob', text: 'private dm', at: now(), meta: null },
	];

	it('keeps this server\'s voice lines and only the readable channels', () => {
		const guild = makeGuild();
		const { text } = transcriptFromEvents(events(), { inGuild: guildScope(guild), canRead: channelFilterFor(guild, [member('plain')]) });
		assert.ok(text.includes('alpha voice line'));
		assert.ok(text.includes('general hello'));
		for (const hidden of ['ban the troll', 'beta voice line', 'beta chatter', 'private dm']) assert.ok(!text.includes(hidden), hidden);
	});

	it('summarizeConversation scopes to deps.guild, and a caller that names no audience gets @everyone', async () => {
		const guild = makeGuild();
		const inputs = [];
		const deps = { guild, provider: { available: true, complete: async ({ input }) => (inputs.push(input), 'ok') } };
		await summarizeConversation(deps, { events: events(), hours: 0 });
		assert.ok(inputs[0].includes('general hello') && inputs[0].includes('alpha voice line'));
		assert.ok(!inputs[0].includes('ban the troll') && !inputs[0].includes('beta'));

		await summarizeConversation(deps, { events: events(), hours: 0, audience: { everything: true } });
		assert.ok(inputs[1].includes('ban the troll'), 'a privileged requester gets every channel of this server');
		assert.ok(!inputs[1].includes('beta') && !inputs[1].includes('private dm'), '...and still nothing from another server');

		await summarizeConversation(deps, { events: events(), hours: 0, audience: { readers: [member('moderator', ['mod'])] } });
		assert.ok(inputs[2].includes('ban the troll'));
	});
});

describe('summarize_conversation (voice tool): the room it is spoken to', () => {
	it('reads to the speaker and everyone else in the voice channel, bots left out', () => {
		const guild = makeGuild();
		const speaker = member('moderator', ['mod']);
		const listener = member('plain');
		guild.members = { cache: new Map([[speaker.id, speaker], [listener.id, listener]]) };
		const room = { members: new Map([[speaker.id, speaker], [listener.id, listener], ['bot', member('bot', [], { bot: true })]]) };
		const deps = { guild, currentSpeakerId: () => 'moderator', currentVoiceChannel: () => room };
		assert.deepEqual(listenersOf(deps), [speaker, listener]);
		deps.currentSpeakerId = () => null;
		deps.currentVoiceChannel = () => null;
		assert.deepEqual(listenersOf(deps), [null], 'nobody known: judged as @everyone');
	});

	it('hands that audience to deps.summarize', async () => {
		const guild = makeGuild();
		const speaker = member('moderator', ['mod']);
		guild.members = { cache: new Map([[speaker.id, speaker]]) };
		let asked = null;
		const deps = {
			guild,
			currentSpeakerId: () => 'moderator',
			summarize: async (options) => ((asked = options), { summary: 'done', count: 2 }),
		};
		const result = await callTool('summarize_conversation', { hours: 1 }, deps);
		assert.equal(result.ok, true);
		assert.deepEqual(asked, { hours: 1, spoken: true, audience: { readers: [speaker] } });
	});

	it('through a real session: a moderator asking with a member listening hears no moderator channel, no other server', async () => {
		const cfg = loadConfig({ DISCORD_TOKEN: 't', GUILD_ID: 'alpha', CHANNEL_ID: 'alpha-voice', OPENAI_API_KEY: 'k', OWNER_ID: 'owner' });
		const activity = new ActivityLog();
		const inputs = [];
		const provider = { available: true, textClient: {}, textApi: 'responses', textModel: 'm', describe: () => 'mock', complete: async ({ input }) => (inputs.push(input), 'ok') };
		const build = (guild) =>
			new GuildSession({
				cfg,
				client: { user: { id: 'bot' } },
				guild,
				channelId: `${guild.id}-voice`,
				store: { getActive: () => null, list: () => [], setActive: async () => true },
				memory: null,
				quota: { enabled: false, status: () => ({ used: 0, limit: 0, exceeded: false }), sessionStarted() {}, shouldWarn: () => false },
				reader: new ChannelReader(),
				recentActions: new RecentActions(),
				activity,
				record: (event) => activity.push(event),
				provider,
				openai: {},
				localStt: {},
				localServer: null,
				log: () => {},
				summarize: summarizeConversation,
			});
		const alphaGuild = makeGuild('alpha', 'Alpha');
		const betaGuild = makeGuild('beta', 'Beta');
		const moderator = member('moderator', ['mod']);
		const plain = member('plain');
		alphaGuild.members = { cache: new Map([[moderator.id, moderator], [plain.id, plain]]), fetch: async () => new Map() };
		alphaGuild.voiceStates = { cache: new Map() };
		betaGuild.members = { cache: new Map(), fetch: async () => new Map() };
		betaGuild.voiceStates = { cache: new Map() };
		const alpha = build(alphaGuild);
		const beta = build(betaGuild);

		// What src/index.js logs for a channel message, and what each session records for voice.
		alpha.record({ kind: 'voice', direction: 'in', who: 'plain', text: 'alpha voice line' });
		beta.record({ kind: 'voice', direction: 'in', who: 'x', text: 'beta voice line' });
		alpha.record({ kind: 'channel', direction: 'in', whoName: 'Sam', text: 'general hello', meta: { channel: '#general', channelId: 'alpha-general', guildId: 'alpha' } });
		alpha.record({ kind: 'channel', direction: 'in', whoName: 'Sam', text: 'ban the troll quietly', meta: { channel: '#mods', channelId: 'alpha-mods', guildId: 'alpha' } });
		beta.record({ kind: 'channel', direction: 'in', whoName: 'Kim', text: 'beta chatter', meta: { channel: '#general', channelId: 'beta-general', guildId: 'beta' } });

		const deps = alpha.deps();
		deps.currentSpeakerId = () => 'moderator';
		deps.currentVoiceChannel = () => ({ members: new Map([[moderator.id, moderator], [plain.id, plain]]) });
		await callTool('summarize_conversation', { hours: 1 }, deps);
		assert.equal(inputs.length, 1);
		assert.ok(inputs[0].includes('alpha voice line') && inputs[0].includes('general hello'), inputs[0]);
		for (const hidden of ['ban the troll', 'beta voice line', 'beta chatter']) assert.ok(!inputs[0].includes(hidden), hidden);

		// Alone in the room, the moderator does get the moderator channel.
		deps.currentVoiceChannel = () => ({ members: new Map([[moderator.id, moderator]]) });
		await callTool('summarize_conversation', { hours: 1 }, deps);
		assert.ok(inputs[1].includes('ban the troll'));
		assert.ok(!inputs[1].includes('beta'));
	});
});
