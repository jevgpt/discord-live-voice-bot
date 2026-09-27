import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { handleInteraction, isConfiguredGuild, mayStartSession, summaryAudience } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { t } from '../../src/i18n/index.js';

// Who may make the bot open a session in a server, and who a /summary is written for. A session is a
// realtime connection on the owner's keys: in a server the owner never configured, the admins of that
// server (whoever invited a public bot) must not be able to start one.

const cfg = loadConfig({
	DISCORD_TOKEN: 't',
	GUILD_ID: 'home',
	CHANNEL_ID: 'home-voice',
	OPENAI_API_KEY: 'k',
	OWNER_ID: 'owner',
	ADMIN_USER_IDS: 'helper',
	ADMIN_ROLE_IDS: 'mod-role',
	VOICE_TARGETS: 'second:second-voice',
});

/** A member; `manager` holds Manage Server, `roles` are role ids. */
function member(id, { manager = false, roles = [], voiceChannel = null } = {}) {
	return {
		id,
		displayName: id,
		user: { id, username: id, bot: false },
		permissions: { has: () => manager },
		roles: { cache: new Map(roles.map((role) => [role, { id: role }])) },
		voice: { channel: voiceChannel },
	};
}

/** A slash command interaction in `guildId` (null = a DM). Replies land in `replies`. */
function slash(commandName, { guildId = 'foreign', userId = 'stranger', who = null, channel = null } = {}) {
	const interaction = {
		commandName,
		guildId,
		guild: guildId ? { id: guildId, name: `${guildId} server` } : null,
		user: { id: userId, username: userId },
		member: guildId ? (who ?? member(userId)) : null,
		options: { getChannel: () => channel, getInteger: () => null },
		deferred: false,
		replied: false,
		replies: [],
		isAutocomplete: () => false,
		isChatInputCommand: () => true,
		async reply(payload) {
			interaction.replied = true;
			interaction.replies.push(payload);
		},
		async deferReply() {
			interaction.deferred = true;
		},
		async editReply(payload) {
			interaction.replies.push(payload);
		},
	};
	return interaction;
}

/** The command context of one server: `session` says whether the bot has one there. */
function context({ session = false } = {}) {
	const joins = [];
	const events = [];
	const summaries = [];
	const ctx = {
		config: cfg,
		log: () => {},
		hasSession: () => session,
		joinVoice: async (channel, options) => joins.push({ channel: channel.id, options }),
		activity: (event) => events.push(event),
		summarize: async (options) => (summaries.push(options), { summary: 'the summary', count: 1 }),
	};
	return { ctx, joins, events, summaries };
}

const voiceIn = (guildId) => ({ id: `${guildId}-lounge`, name: 'Lounge', guildId, type: ChannelType.GuildVoice });

describe('isConfiguredGuild / mayStartSession', () => {
	it('knows the GUILD_ID pair and every VOICE_TARGETS server, and nothing else', () => {
		assert.equal(isConfiguredGuild(cfg, 'home'), true);
		assert.equal(isConfiguredGuild(cfg, 'second'), true);
		assert.equal(isConfiguredGuild(cfg, 'foreign'), false);
		assert.equal(isConfiguredGuild(cfg, null), false);
	});

	it('lets anybody start a session in a configured server, as before', () => {
		assert.equal(mayStartSession({ cfg, guildId: 'home', userId: 'stranger' }), true);
		assert.equal(mayStartSession({ cfg, guildId: 'second', userId: null }), true);
	});

	it('in any other server only the owner and ADMIN_USER_IDS may, and a join nobody asked for may not', () => {
		assert.equal(mayStartSession({ cfg, guildId: 'foreign', userId: 'owner' }), true);
		assert.equal(mayStartSession({ cfg, guildId: 'foreign', userId: 'helper' }), true);
		assert.equal(mayStartSession({ cfg, guildId: 'foreign', userId: 'stranger' }), false);
		// The tool path passes no requester: it cannot rebuild a dropped session in a foreign server.
		assert.equal(mayStartSession({ cfg, guildId: 'foreign', userId: null }), false);
	});
});

describe('/join in a server without a session', () => {
	it('refuses a foreign server\'s own admin (Manage Server, ADMIN_ROLE_IDS) and never reaches the join', async () => {
		const { ctx, joins, events } = context();
		const admin = member('their-admin', { manager: true, roles: ['mod-role'] });
		const interaction = slash('join', { userId: 'their-admin', who: admin, channel: voiceIn('foreign') });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(joins, []);
		assert.equal(interaction.replies.length, 1);
		assert.equal(interaction.replies[0].content, t('commands.join_unconfigured_denied'));
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, 'gate');
		assert.equal(events[0].meta.result, 'denied');
	});

	it('lets the owner in, and tells the registry who asked', async () => {
		const { ctx, joins } = context();
		const interaction = slash('join', { userId: 'owner', channel: voiceIn('foreign') });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(joins, [{ channel: 'foreign-lounge', options: { requesterId: 'owner' } }]);
		assert.equal(interaction.replies.at(-1).content, t('commands.joined', { channel: 'Lounge' }));
	});

	it('keeps /join open to everyone in a configured server whose session is not up', async () => {
		const { ctx, joins } = context();
		const interaction = slash('join', { guildId: 'second', userId: 'stranger', channel: voiceIn('second') });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(joins, [{ channel: 'second-lounge', options: { requesterId: 'stranger' } }]);
	});

	it('does not ask again where a session already exists: moving the bot is what /join always did', async () => {
		const { ctx, joins } = context({ session: true });
		const interaction = slash('join', { userId: 'stranger', channel: voiceIn('foreign') });
		await handleInteraction(interaction, ctx);
		assert.equal(joins.length, 1);
	});

	it('turns the registry\'s own refusal into a join failure instead of a crash', async () => {
		const { ctx } = context();
		ctx.joinVoice = async () => {
			throw new Error(t('runtime.session_start_refused_reason'));
		};
		const interaction = slash('join', { userId: 'owner', channel: voiceIn('foreign') });
		await handleInteraction(interaction, ctx);
		assert.equal(interaction.replies.at(-1).content, t('commands.join_failed', { error: t('runtime.session_start_refused_reason') }));
	});
});

describe('/read: read as the person who ran it, and aloud only to people who may hear it', () => {
	function readContext({ roomMayRead }) {
		const { ctx } = context({ session: true });
		const calls = [];
		const said = [];
		ctx.callTool = async (name, args, options) => (calls.push({ name, args, options }), { ok: true, spoken: 'mod1: ban Sam tomorrow', data: { count: 1 } });
		ctx.say = (text) => said.push(text);
		ctx.roomMayRead = async () => roomMayRead;
		return { ctx, calls, said };
	}
	const staff = { id: 'staff', name: 'staff', type: ChannelType.GuildText };

	it('hands the person who ran it to the tool, which reads what THEY may read', async () => {
		const { ctx, calls } = readContext({ roomMayRead: true });
		const interaction = slash('read', { guildId: 'home', userId: 'helper', channel: staff });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(calls.map((call) => [call.name, call.options]), [['read_messages', { userId: 'helper' }]]);
	});

	it('reads it out when everybody in the voice channel may read the channel', async () => {
		const { ctx, said } = readContext({ roomMayRead: true });
		const interaction = slash('read', { guildId: 'home', userId: 'owner', channel: staff });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(said, ['mod1: ban Sam tomorrow']);
	});

	it('shows it to the person alone when somebody listening may not read it', async () => {
		const { ctx, said } = readContext({ roomMayRead: false });
		const interaction = slash('read', { guildId: 'home', userId: 'owner', channel: staff });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(said, [], 'nothing was said to the room');
		assert.match(interaction.replies.at(-1).content, /ban Sam tomorrow/);
		assert.match(interaction.replies.at(-1).content, /for you only/);
	});
});

describe('/summary: who it is written for', () => {
	it('a member gets the channels they can read: the command hands their member object on', async () => {
		const { ctx, summaries } = context({ session: true });
		const reader = member('reader');
		const interaction = slash('summary', { guildId: 'home', userId: 'reader', who: reader });
		await handleInteraction(interaction, ctx);
		assert.equal(summaries.length, 1);
		assert.deepEqual(summaries[0].audience, { readers: [reader] });
		assert.equal(summaries[0].spoken, false);
		assert.equal(interaction.replies.at(-1).content, 'the summary');
	});

	it('the owner gets every channel of this server; an admin gets what their own account can read', () => {
		assert.deepEqual(summaryAudience(slash('summary', { guildId: 'home', userId: 'owner' }), cfg), { everything: true });
		const manager = member('manager', { manager: true });
		assert.deepEqual(summaryAudience(slash('summary', { guildId: 'home', userId: 'manager', who: manager }), cfg), { readers: [manager] });
		const moderator = member('moderator', { roles: ['mod-role'] });
		assert.deepEqual(summaryAudience(slash('summary', { guildId: 'home', userId: 'moderator', who: moderator }), cfg), {
			readers: [moderator],
		});
	});

	it('in a DM a non-admin is sent to the server instead, and nothing is summarised', async () => {
		const { ctx, summaries } = context({ session: true });
		const interaction = slash('summary', { guildId: null, userId: 'stranger' });
		await handleInteraction(interaction, ctx);
		assert.deepEqual(summaries, []);
		assert.equal(interaction.replies[0].content, t('commands.summary_guild_only'));
		assert.equal(summaryAudience(slash('summary', { guildId: null, userId: 'owner' }), cfg)?.everything, true);
	});
});
