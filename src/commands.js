// Slash commands, the character panel (embed + modal + menu) and the voice-command parser.
//
// Panel flow:
//   /panel -> embed + character picker + buttons (new / edit / delete / refresh / join / leave)
//   "New character" modal: name, prompt (long text), voice (optional)
// Permissions: changing/deleting a character, sending a message, reading a channel, leaving and the
//   recording switch are limited to the owner / ADMIN_USER_IDS / ADMIN_ROLE_IDS / members with the
//   "Manage Server" permission (src/auth.js). /join in a server outside GUILD_ID/VOICE_TARGETS builds a
//   new session there, so it takes the owner or ADMIN_USER_IDS (mayStartSession). /summary covers only
//   the channels the member could read themselves (the owner excepted), and so does /read.
// Voice commands (picked up from what is said in the channel) -- the phrasings themselves live in
//   src/locales/<code>/grammar.js, so every language brings its own:
//   "switch to the <name> character"     -> change character (the live session is rebuilt)
//   "write ... in the <channel> channel" -> send a message to a text channel
//   "join the <channel> channel"         -> join a voice channel
//   "leave the channel"                  -> leave the voice channel
//   "play <song>", "stop/pause/resume the music", "skip the song", "turn the music down/up",
//   "what's playing", and the queue: "play <song> next", "loop this song", "repeat the queue",
//   "shuffle", "go to 1:30", "skip ahead 30 seconds", "move 3 to 1", "remove 3", "clear the queue"

import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
} from 'discord.js';
import { NOT_ALLOWED, interactionPrivileged } from './auth.js';
import { t, tRaw } from './i18n/index.js';
import enCommands from './locales/en/commands.js';
import trCommands from './locales/tr/commands.js';
import { findCharacter, findChannelByName, normalize, parseClock, stripDictationTail } from './text.js';
import { VOICES } from './voices.js';

export { VOICES, findCharacter, findChannelByName, normalize, stripDictationTail };

const MAX_SELECT_OPTIONS = 25;
const MODAL_PROMPT_MAX = 4000; // Discord modal field limit; the store allows 8000

// ---------------------------------------------------------------- slash commands

// Discord shows a command in the VIEWER's client language, which has nothing to do with the bot's
// own BOT_LANGUAGE, so every command carries a Turkish localisation next to its default text. The
// names are identifiers -- Discord registers them and handleCommand() switches on them -- so they
// always come out of the English bundle; the Turkish bundle only supplies what a Turkish client reads.
const EN_SLASH = enCommands.slash;
const TR_SLASH = trCommands.slash;

const RECORD_STATES = ['on', 'off', 'status'];
// The repeat modes /music loop offers; the same three the player knows (LOOP_MODES in src/music.js).
const LOOP_CHOICES = ['off', 'track', 'queue'];
// How many queued titles /music status lists under the now-playing line.
const STATUS_QUEUE_LINES = 10;

/** "music.subcommands.play.options.query" -> that entry of a locale's slash tree. */
function slashEntry(tree, key) {
	let node = tree;
	for (const part of key.split('.')) node = node?.[part];
	return node ?? null;
}

/** Name + description (and their Turkish localisations) of a command, subcommand or option. */
function named(builder, key) {
	const tr = slashEntry(TR_SLASH, key);
	builder.setName(slashEntry(EN_SLASH, key).name).setDescription(t(`commands.slash.${key}.description`));
	if (tr?.name) builder.setNameLocalizations({ tr: tr.name });
	if (tr?.description) builder.setDescriptionLocalizations({ tr: tr.description });
	return builder;
}

/** Choices of an option: the label in the bot's language plus the Turkish one for Turkish clients. */
function choicesFor(key, values) {
	const tr = slashEntry(TR_SLASH, key)?.choices ?? {};
	return values.map((value) => ({
		name: t(`commands.slash.${key}.choices.${value}`),
		...(tr[value] ? { name_localizations: { tr: tr[value] } } : {}),
		value,
	}));
}

export function commandData() {
	const admin = (builder) => builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
	return [
		named(new SlashCommandBuilder(), 'join').addChannelOption((option) =>
			named(option, 'join.options.channel').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
		),
		admin(named(new SlashCommandBuilder(), 'leave')),
		named(new SlashCommandBuilder(), 'panel'),
		admin(
			named(new SlashCommandBuilder(), 'character').addStringOption((option) =>
				named(option, 'character.options.name').setRequired(true).setAutocomplete(true),
			),
		),
		admin(
			named(new SlashCommandBuilder(), 'send')
				.addChannelOption((option) =>
					named(option, 'send.options.channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
				)
				.addStringOption((option) => named(option, 'send.options.message').setRequired(true)),
		),
		admin(
			named(new SlashCommandBuilder(), 'read')
				.addChannelOption((option) =>
					named(option, 'read.options.channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
				)
				.addIntegerOption((option) => named(option, 'read.options.count').setMinValue(1).setMaxValue(10)),
		),
		named(new SlashCommandBuilder(), 'status'),
		named(new SlashCommandBuilder(), 'help'),
		// Fourteen subcommands of the twenty-five Discord allows; none takes more than two options.
		named(new SlashCommandBuilder(), 'music')
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.play').addStringOption((option) =>
					named(option, 'music.subcommands.play.options.query').setRequired(true),
				),
			)
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.playnext').addStringOption((option) =>
					named(option, 'music.subcommands.playnext.options.query').setRequired(true),
				),
			)
			.addSubcommand((sub) => named(sub, 'music.subcommands.stop'))
			.addSubcommand((sub) => named(sub, 'music.subcommands.pause'))
			.addSubcommand((sub) => named(sub, 'music.subcommands.resume'))
			.addSubcommand((sub) => named(sub, 'music.subcommands.skip'))
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.volume').addIntegerOption((option) =>
					named(option, 'music.subcommands.volume.options.percent').setRequired(true).setMinValue(0).setMaxValue(100),
				),
			)
			.addSubcommand((sub) => named(sub, 'music.subcommands.status'))
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.seek').addStringOption((option) =>
					named(option, 'music.subcommands.seek.options.position').setRequired(true).setMaxLength(12),
				),
			)
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.loop').addStringOption((option) =>
					named(option, 'music.subcommands.loop.options.mode')
						.setRequired(true)
						.addChoices(...choicesFor('music.subcommands.loop.options.mode', LOOP_CHOICES)),
				),
			)
			.addSubcommand((sub) => named(sub, 'music.subcommands.shuffle'))
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.move')
					.addIntegerOption((option) => named(option, 'music.subcommands.move.options.from').setRequired(true).setMinValue(1))
					.addIntegerOption((option) => named(option, 'music.subcommands.move.options.to').setRequired(true).setMinValue(1)),
			)
			.addSubcommand((sub) =>
				named(sub, 'music.subcommands.remove').addIntegerOption((option) =>
					named(option, 'music.subcommands.remove.options.position').setRequired(true).setMinValue(1),
				),
			)
			.addSubcommand((sub) => named(sub, 'music.subcommands.clear')),
		named(new SlashCommandBuilder(), 'summary').addIntegerOption((option) =>
			named(option, 'summary.options.hours').setMinValue(1).setMaxValue(72),
		),
		admin(
			named(new SlashCommandBuilder(), 'recording').addStringOption((option) =>
				named(option, 'recording.options.status').addChoices(...choicesFor('recording.options.status', RECORD_STATES)),
			),
		),
	];
}

export async function registerCommands(client, guildId, log) {
	try {
		await client.application.commands.set(commandData(), guildId);
		log(t('commands.log_registered'));
	} catch (err) {
		log(t('commands.log_register_failed', { error: err.message }));
	}
}

// ---------------------------------------------------------------- panel view

/**
 * Character creation/editing modal.
 * Note: Discord modal field LABELS are at most 45 characters; the voice list does not fit there, so
 * it is shown in the footer of the panel embed instead. The prompt field is capped at 4000: of a
 * longer prompt the first 4000 characters are shown, and if they are saved untouched the original
 * is kept.
 */
export function characterModal({ mode = 'new', character = null } = {}) {
	const modal = new ModalBuilder()
		.setCustomId(mode === 'edit' ? 'char:edit:modal' : 'char:new:modal')
		.setTitle(
			mode === 'edit' ? t('commands.modal_edit_title', { name: character?.name ?? '' }).slice(0, 45) : t('commands.modal_new_title'),
		);
	const name = new TextInputBuilder()
		.setCustomId('name')
		.setLabel(t('commands.modal_name_label'))
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(80);
	const prompt = new TextInputBuilder()
		.setCustomId('prompt')
		.setLabel(t('commands.modal_prompt_label'))
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(false)
		.setMaxLength(MODAL_PROMPT_MAX);
	const voice = new TextInputBuilder()
		.setCustomId('voice')
		.setLabel(t('commands.modal_voice_label'))
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(40);
	if (character) {
		name.setValue(character.name ?? '');
		if (character.prompt) prompt.setValue(String(character.prompt).slice(0, MODAL_PROMPT_MAX));
		if (character.voice) voice.setValue(character.voice);
	}
	modal.addComponents(
		new ActionRowBuilder().addComponents(name),
		new ActionRowBuilder().addComponents(prompt),
		new ActionRowBuilder().addComponents(voice),
	);
	return modal;
}

export function panelView(store) {
	const characters = store.list();
	const active = store.getActive();
	const embed = new EmbedBuilder()
		.setTitle(t('commands.panel_title'))
		.setDescription(
			characters.length
				? characters
						.map(
							(c) =>
								`${c.id === active?.id ? '▶ ' : '• '}**${c.name}**${c.voice ? t('commands.panel_voice_suffix', { voice: c.voice }) : ''}`,
						)
						.join('\n')
				: t('commands.panel_empty'),
		)
		.setFooter({ text: t('commands.panel_voices_footer', { voices: VOICES.join(', ') }) });
	if (active?.prompt) {
		embed.addFields({ name: t('commands.panel_active_field', { name: active.name }), value: active.prompt.slice(0, 1000) });
	}

	const rows = [];
	if (characters.length) {
		const select = new StringSelectMenuBuilder()
			.setCustomId('char:select')
			.setPlaceholder(t('commands.panel_select_placeholder'))
			.addOptions(
				characters.slice(0, MAX_SELECT_OPTIONS).map((c) => ({
					label: c.name.slice(0, 100),
					value: c.id,
					description: (c.prompt || t('commands.panel_no_prompt')).slice(0, 90),
					default: c.id === active?.id,
				})),
			);
		rows.push(new ActionRowBuilder().addComponents(select));
	}
	rows.push(
		new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId('char:new').setLabel(t('commands.button_new')).setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId('char:edit').setLabel(t('commands.button_edit')).setStyle(ButtonStyle.Primary).setDisabled(!active),
			new ButtonBuilder().setCustomId('char:delete').setLabel(t('commands.button_delete')).setStyle(ButtonStyle.Danger).setDisabled(!active),
			new ButtonBuilder().setCustomId('panel:refresh').setLabel(t('commands.button_refresh')).setStyle(ButtonStyle.Secondary),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId('voice:join').setLabel(t('commands.button_join')).setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId('voice:leave').setLabel(t('commands.button_leave')).setStyle(ButtonStyle.Secondary),
		),
	);
	return { embeds: [embed], components: rows };
}

// ---------------------------------------------------------------- /music

/**
 * /music <subcommand> -> [tool, args]. Every entry reads only its own options, and only when it is the
 * one asked for: discord.js throws for a required option the interaction does not carry, and the table
 * this replaced read /music play's query for every subcommand, so all of them but play failed.
 */
const MUSIC_SLASH = {
	play: (options) => ['play_music', { query: options.getString('query', true) }],
	playnext: (options) => ['play_next', { query: options.getString('query', true) }],
	stop: () => ['stop_music', {}],
	pause: () => ['pause_music', {}],
	resume: () => ['resume_music', {}],
	skip: () => ['skip_music', {}],
	volume: (options) => ['set_music_volume', { percent: options.getInteger('percent', true) }],
	status: () => ['music_status', {}],
	// The text goes to the tool as typed: "1:30", "90", "+30" and "-10" are all read there (parseSeekTarget).
	seek: (options) => ['seek_music', { to: options.getString('position', true) }],
	loop: (options) => ['loop_music', { mode: options.getString('mode', true) }],
	shuffle: () => ['shuffle_queue', {}],
	move: (options) => ['move_in_queue', { from: options.getInteger('from', true), to: options.getInteger('to', true) }],
	remove: (options) => ['remove_from_queue', { position: options.getInteger('position', true) }],
	clear: () => ['clear_queue', {}],
};

/** The tool call behind a /music subcommand, or null for one this build does not know. */
export function musicSlashCall(sub, options) {
	const build = MUSIC_SLASH[sub];
	return build ? build(options) : null;
}

/** The waiting tracks under /music status, numbered the way /music move and /music remove count them. */
function musicQueueLines(queue) {
	if (!Array.isArray(queue) || !queue.length) return '';
	const lines = queue.slice(0, STATUS_QUEUE_LINES).map((track) =>
		t('commands.music_queue_line', {
			position: track.position,
			title: track.title,
			duration: track.durationText ? ` (${track.durationText})` : '',
		}),
	);
	if (queue.length > STATUS_QUEUE_LINES) lines.push(t('commands.music_queue_more', { count: queue.length - STATUS_QUEUE_LINES }));
	return `\n${t('commands.music_queue_header')}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------- interactions

export async function handleInteraction(interaction, ctx) {
	if (interaction.isAutocomplete()) return handleAutocomplete(interaction, ctx);
	// A server the bot has no session for: /join builds one, everything else has nothing to act on.
	if (ctx.hasSession?.() === false && !(interaction.isChatInputCommand() && interaction.commandName === 'join')) {
		return interaction.reply({ content: t('commands.no_guild_session'), flags: MessageFlags.Ephemeral }).catch(() => {});
	}
	if (interaction.isChatInputCommand()) return guarded(interaction, ctx, handleCommand);
	if (interaction.isStringSelectMenu() && interaction.customId === 'char:select') return guarded(interaction, ctx, handleSelect);
	if (interaction.isButton()) return guarded(interaction, ctx, handleButton);
	if (interaction.isModalSubmit()) return guarded(interaction, ctx, handleModal);
	return undefined;
}

/** Keeps the interaction from hanging in its "thinking" state when a handler throws. */
async function guarded(interaction, ctx, handler) {
	try {
		await handler(interaction, ctx);
	} catch (err) {
		ctx.log?.(t('commands.log_interaction_error', { command: interaction.commandName ?? interaction.customId ?? '?', error: err.message }));
		const content = t('commands.error_generic', { error: String(err.message).slice(0, 200) });
		try {
			if (interaction.deferred || interaction.replied) await interaction.editReply({ content, embeds: [], components: [] });
			else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
		} catch {
			/* the interaction may have expired */
		}
	}
}

async function denyUnlessPrivileged(interaction, ctx) {
	if (interactionPrivileged(interaction, ctx.config)) return false;
	ctx.activity?.({
		kind: 'gate',
		who: interaction.user?.id ?? null,
		whoName: interaction.member?.displayName ?? interaction.user?.username ?? null,
		text: t('commands.gate_denied_activity', { command: interaction.commandName ?? interaction.customId }),
		meta: { result: 'denied' },
	});
	await interaction.reply({ content: NOT_ALLOWED, flags: MessageFlags.Ephemeral }).catch(() => {});
	return true;
}

/** Is this one of the servers the bot was set up for: the GUILD_ID pair or a VOICE_TARGETS entry? */
export function isConfiguredGuild(cfg, guildId) {
	if (!guildId) return false;
	const id = String(guildId);
	if (cfg?.guildId && String(cfg.guildId) === id) return true;
	return Array.isArray(cfg?.targets) && cfg.targets.some((target) => target?.guildId && String(target.guildId) === id);
}

/**
 * May `userId` make the bot build a session for this server? A configured server keeps the rule it always
 * had: anybody who can reach /join there. Any other server gets one only from the owner or ADMIN_USER_IDS.
 * A new session is a realtime connection billed to the owner's API keys, one of the MAX_LIVE_SESSIONS
 * slots (a stranger filling them silences the owner's own server) and the tools that come with it; and
 * whoever invited a public bot into their own server holds Manage Server and every role there, so the
 * rest of isPrivileged() proves nothing about a foreign server.
 */
export function mayStartSession({ cfg, guildId, userId }) {
	if (isConfiguredGuild(cfg, guildId)) return true;
	const id = userId ? String(userId) : null;
	if (!id) return false;
	if (cfg?.ownerId && id === String(cfg.ownerId)) return true;
	return Array.isArray(cfg?.adminUserIds) && cfg.adminUserIds.includes(id);
}

/**
 * /join in a server that has no session builds one (see mayStartSession); this answers everybody else.
 * A server that already has a session is not asked about: moving the bot there is what /join always did.
 */
async function denyUnlessMayStartSession(interaction, ctx) {
	if (ctx.hasSession?.() !== false) return false;
	if (mayStartSession({ cfg: ctx.config, guildId: interaction.guildId, userId: interaction.user?.id })) return false;
	const guild = interaction.guild?.name ?? interaction.guildId ?? '?';
	ctx.activity?.({
		kind: 'gate',
		who: interaction.user?.id ?? null,
		whoName: interaction.member?.displayName ?? interaction.user?.username ?? null,
		text: t('commands.gate_unconfigured_activity', { guild }),
		meta: { result: 'denied', guild },
	});
	await interaction.reply({ content: t('commands.join_unconfigured_denied'), flags: MessageFlags.Ephemeral }).catch(() => {});
	return true;
}

/**
 * Who a written summary is for (see summarizeConversation in src/summary.js). The log it is made from
 * holds every text channel of the server, so a member gets the channels they could read themselves, and
 * that includes the admins: /read holds them to their own account as well, and Manage Server is a
 * permission people hand out more freely than the moderators' channel. Only the owner gets everything.
 * It is this server only either way. A DM has no member to judge, so there it is null (the owner aside):
 * the command answers that it needs a server.
 */
export function summaryAudience(interaction, cfg) {
	const userId = interaction.user?.id ? String(interaction.user.id) : null;
	if (userId && cfg?.ownerId && userId === String(cfg.ownerId)) return { everything: true };
	if (!interaction.guildId || !interaction.member) return null;
	return { readers: [interaction.member] };
}

async function handleAutocomplete(interaction, ctx) {
	const focused = interaction.options.getFocused(true);
	const needle = normalize(focused.value ?? '');
	const names = ctx.store
		.list()
		.filter((c) => !needle || normalize(c.name).includes(needle))
		.slice(0, MAX_SELECT_OPTIONS)
		.map((c) => ({ name: c.name, value: c.name }));
	await interaction.respond(names).catch(() => {});
}

async function joinFromInteraction(interaction, ctx, chosen) {
	if (!chosen) {
		await interaction.reply({ content: t('commands.join_no_channel'), flags: MessageFlags.Ephemeral });
		return;
	}
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	try {
		// Who asked travels with the join: the registry builds a session for an unconfigured server only
		// on the owner's word, and a join without a requester is taken as nobody's.
		await ctx.joinVoice(chosen, { requesterId: interaction.user?.id ?? null });
		await interaction.editReply({ content: t('commands.joined', { channel: chosen.name }) });
	} catch (err) {
		await interaction.editReply({ content: t('commands.join_failed', { error: err.message }) });
	}
}

async function handleCommand(interaction, ctx) {
	switch (interaction.commandName) {
		case 'join': {
			if (await denyUnlessMayStartSession(interaction, ctx)) return;
			const chosen = interaction.options.getChannel('channel') ?? interaction.member?.voice?.channel ?? null;
			await joinFromInteraction(interaction, ctx, chosen);
			return;
		}
		case 'leave': {
			if (await denyUnlessPrivileged(interaction, ctx)) return;
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await ctx.leaveVoice({ permanent: true });
			await interaction.editReply({ content: t('commands.left') });
			return;
		}
		case 'panel': {
			await interaction.reply({ ...panelView(ctx.store), flags: MessageFlags.Ephemeral });
			return;
		}
		case 'character': {
			if (await denyUnlessPrivileged(interaction, ctx)) return;
			const name = interaction.options.getString('name', true);
			const character = findCharacter(ctx.store.list(), name);
			if (!character) {
				await interaction.reply({ content: t('commands.character_not_found', { name }), flags: MessageFlags.Ephemeral });
				return;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await ctx.store.setActive(character.id);
			await ctx.refreshPersona(t('commands.persona_reason_character', { character: character.name }));
			await interaction.editReply({ content: t('commands.character_active', { name: character.name }) });
			return;
		}
		case 'send': {
			if (await denyUnlessPrivileged(interaction, ctx)) return;
			const channel = interaction.options.getChannel('channel', true);
			const message = interaction.options.getString('message', true);
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			const result = await ctx.callTool('send_message', { channel, text: message }, { userId: interaction.user?.id ?? null });
			await interaction.editReply({
				content: result.ok ? t('commands.sent', { channel: channel.name }) : t('commands.send_failed', { reason: result.spoken }),
			});
			return;
		}
		case 'read': {
			if (await denyUnlessPrivileged(interaction, ctx)) return;
			const channel = interaction.options.getChannel('channel', true);
			const count = interaction.options.getInteger('count') ?? ctx.config.readLimit;
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			// Read as the person who ran the command: read_messages checks that THEY may read the channel.
			const result = await ctx.callTool('read_messages', { channel, count }, { userId: interaction.user?.id ?? null });
			if (!result.ok) {
				await interaction.editReply({ content: t('commands.read_failed', { reason: result.spoken }) });
				return;
			}
			// Said out loud, it is read to everybody in the voice channel, and the person who ran /read may be
			// able to read a channel that somebody listening may not. Then it is shown to them alone, in this
			// reply, instead: the simplest answer that leaks nothing, and they still get what they asked for.
			// (Refusing would work as well and help nobody; waiting for the room to empty is not an answer.)
			const aloud = typeof ctx.roomMayRead === 'function' ? await ctx.roomMayRead(channel) : true;
			if (!aloud) {
				await interaction.editReply({
					content: t('commands.reading_private', { channel: channel.name, text: String(result.spoken ?? '') }).slice(0, 1900),
				});
				return;
			}
			ctx.say(result.spoken);
			await interaction.editReply({
				content: t('commands.reading', {
					channel: channel.name,
					count: result.data?.count ?? 0,
					suffix: result.data?.new ? t('commands.reading_new_suffix') : '',
				}),
			});
			return;
		}
		case 'status': {
			const active = ctx.store.getActive();
			const live = ctx.getLive();
			const stats = ctx.latency?.summary?.();
			const lines = [
				t('commands.status_voice', {
					channel: ctx.voice.connected ? `<#${ctx.voice.channelId}>` : t('commands.status_voice_none'),
				}),
				t('commands.status_brain', { brain: ctx.brain?.() === 'local' ? t('commands.status_brain_local') : 'GPT-Live' }),
				t('commands.status_live', { state: live?.ready ? t('commands.status_open') : t('commands.status_closed') }),
				t('commands.status_voice_engine', {
					engine: ctx.localMode?.() ? t('commands.status_voice_engine_local') : 'GPT-Live',
					server: ctx.chatterbox?.() ? t('commands.status_chatterbox_server', { url: ctx.chatterbox() }) : '',
				}),
				t('commands.status_character', { character: active ? `**${active.name}**` : t('commands.status_character_default') }),
				t('commands.status_music', { music: ctx.music ? ctx.music.nowPlayingText() : t('commands.status_music_off') }),
				t('commands.status_record', {
					state: ctx.config.recordTranscripts ? t('commands.status_record_on') : t('commands.status_record_off'),
				}),
			];
			const quota = ctx.quota?.status?.();
			if (quota?.limit) {
				lines.push(t('commands.status_quota', { used: Math.round(quota.used / 60), limit: Math.round(quota.limit / 60) }));
			}
			if (stats?.count) lines.push(stats.text);
			// The lines above are about the server the command was given in; when the bot serves more than
			// one, the others are listed underneath (a single server reports exactly what it always did).
			const others = (ctx.sessions?.() ?? []).slice(1);
			if (others.length) {
				lines.push(t('commands.status_sessions_header', { count: others.length + 1 }));
				for (const entry of others) {
					lines.push(
						t('commands.status_session_line', {
							guild: entry.guildName ?? '?',
							channel: entry.voiceConnected ? `#${entry.voiceChannelName ?? '?'}` : t('commands.status_voice_none'),
							brain: entry.brain === 'local' ? t('commands.status_brain_local') : 'GPT-Live',
							live: entry.liveReady ? t('commands.status_open') : (entry.liveBlocked ?? t('commands.status_closed')),
						}),
					);
				}
			}
			await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
			return;
		}
		case 'help': {
			await interaction.reply({ content: t('commands.help'), flags: MessageFlags.Ephemeral });
			return;
		}
		case 'music': {
			if (!ctx.music) {
				await interaction.reply({ content: t('commands.music_disabled'), flags: MessageFlags.Ephemeral });
				return;
			}
			const sub = interaction.options.getSubcommand();
			const [tool, args] = musicSlashCall(sub, interaction.options) ?? [];
			if (!tool) {
				await interaction.reply({ content: t('commands.music_unknown'), flags: MessageFlags.Ephemeral });
				return;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			const result = await ctx.callTool(tool, args, { userId: interaction.user?.id ?? null });
			let content = result.spoken ?? (result.ok ? t('commands.ok') : t('commands.failed'));
			// Written, the queue can be shown with its positions, which is what /music move and remove take.
			if (sub === 'status') content += musicQueueLines(result.data?.queue);
			await interaction.editReply({ content: content.slice(0, 1900) });
			return;
		}
		case 'summary': {
			const hours = interaction.options.getInteger('hours') ?? 3;
			const audience = summaryAudience(interaction, ctx.config);
			if (!audience) {
				await interaction.reply({ content: t('commands.summary_guild_only'), flags: MessageFlags.Ephemeral });
				return;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			if (typeof ctx.summarize !== 'function') {
				await interaction.editReply({ content: t('commands.summary_unavailable') });
				return;
			}
			const { summary } = await ctx.summarize({ hours, spoken: false, audience });
			await interaction.editReply({ content: summary.slice(0, 1900) });
			return;
		}
		case 'recording': {
			if (await denyUnlessPrivileged(interaction, ctx)) return;
			const wanted = interaction.options.getString('status') ?? 'status';
			if (wanted === 'status') {
				await interaction.reply({
					content: t('commands.record_status', {
						state: ctx.config.recordTranscripts ? t('commands.record_state_on') : t('commands.record_state_off'),
					}),
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			const value = await ctx.applySetting('record', wanted === 'on');
			await interaction.reply({
				content: t('commands.record_toggled', {
					state: value ? t('commands.record_turned_on') : t('commands.record_turned_off'),
				}),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		default:
			await interaction.reply({ content: t('commands.unknown_command'), flags: MessageFlags.Ephemeral });
	}
}

async function handleSelect(interaction, ctx) {
	if (await denyUnlessPrivileged(interaction, ctx)) return;
	const id = interaction.values[0];
	await interaction.deferUpdate();
	await ctx.store.setActive(id);
	const character = ctx.store.get(id);
	await ctx.refreshPersona(t('commands.persona_reason_character', { character: character?.name ?? id }));
	await interaction.editReply(panelView(ctx.store));
}

async function handleButton(interaction, ctx) {
	const id = interaction.customId;

	if (id === 'panel:refresh') {
		await interaction.update(panelView(ctx.store));
		return;
	}

	if (id === 'voice:join') {
		await joinFromInteraction(interaction, ctx, interaction.member?.voice?.channel ?? null);
		return;
	}

	if (id === 'voice:leave') {
		if (await denyUnlessPrivileged(interaction, ctx)) return;
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		await ctx.leaveVoice({ permanent: true });
		await interaction.editReply({ content: t('commands.left') });
		return;
	}

	if (id === 'char:new') {
		if (await denyUnlessPrivileged(interaction, ctx)) return;
		await interaction.showModal(characterModal({ mode: 'new' }));
		return;
	}

	if (id === 'char:edit') {
		if (await denyUnlessPrivileged(interaction, ctx)) return;
		const active = ctx.store.getActive();
		if (!active) {
			await interaction.reply({ content: t('commands.no_character_to_edit'), flags: MessageFlags.Ephemeral });
			return;
		}
		await interaction.showModal(characterModal({ mode: 'edit', character: active }));
		return;
	}

	if (id === 'char:delete') {
		if (await denyUnlessPrivileged(interaction, ctx)) return;
		const active = ctx.store.getActive();
		if (!active) {
			await interaction.reply({ content: t('commands.no_character_to_delete'), flags: MessageFlags.Ephemeral });
			return;
		}
		// Two steps: a confirmation button first
		await interaction.reply({
			content: t('commands.delete_confirm', { name: active.name }),
			components: [
				new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId(`char:delete:confirm:${active.id}`)
						.setLabel(t('commands.button_delete_yes'))
						.setStyle(ButtonStyle.Danger),
					new ButtonBuilder().setCustomId('char:delete:cancel').setLabel(t('commands.button_cancel')).setStyle(ButtonStyle.Secondary),
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (id.startsWith('char:delete:confirm:')) {
		if (await denyUnlessPrivileged(interaction, ctx)) return;
		const targetId = id.slice('char:delete:confirm:'.length);
		const target = ctx.store.get(targetId);
		if (!target) {
			await interaction.update({ content: t('commands.character_gone'), components: [] });
			return;
		}
		await ctx.store.remove(target.id);
		await ctx.refreshPersona(t('commands.persona_reason_character_deleted'));
		await interaction.update({ content: t('commands.character_deleted', { name: target.name }), components: [] });
		return;
	}

	if (id === 'char:delete:cancel') {
		await interaction.update({ content: t('commands.delete_cancelled'), components: [] });
	}
}

async function handleModal(interaction, ctx) {
	if (await denyUnlessPrivileged(interaction, ctx)) return;
	const name = interaction.fields.getTextInputValue('name').trim();
	let prompt = interaction.fields.getTextInputValue('prompt').trim();
	const voice = interaction.fields.getTextInputValue('voice').trim().toLowerCase();

	if (voice && !VOICES.includes(voice)) {
		await interaction.reply({
			content: t('commands.voice_unknown', { voice, voices: VOICES.join(', ') }),
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (interaction.customId === 'char:new:modal') {
		const character = await ctx.store.create({ name, prompt, voice: voice || null });
		await ctx.store.setActive(character.id);
		await ctx.refreshPersona(t('commands.persona_reason_character', { character: character.name }));
		await updatePanelMessage(interaction, ctx, t('commands.character_created', { name: character.name }));
		return;
	}

	if (interaction.customId === 'char:edit:modal') {
		const active = ctx.store.getActive();
		if (!active) {
			await interaction.reply({ content: t('commands.character_missing'), flags: MessageFlags.Ephemeral });
			return;
		}
		// The modal had cut the prompt at 4000; if the user did not touch that part, keep the long original.
		if (active.prompt.length > MODAL_PROMPT_MAX && prompt === active.prompt.slice(0, MODAL_PROMPT_MAX).trim()) prompt = active.prompt;
		await ctx.store.update(active.id, { name, prompt, voice: voice || null });
		await ctx.refreshPersona(t('commands.persona_reason_character_updated', { character: name }));
		await updatePanelMessage(interaction, ctx, t('commands.character_updated', { name }));
	}
}

async function updatePanelMessage(interaction, ctx, note) {
	const view = panelView(ctx.store);
	if (note) view.content = note;
	try {
		await interaction.update(view);
	} catch {
		await interaction.reply({ content: note ?? t('commands.saved'), flags: MessageFlags.Ephemeral });
	}
}

// ---------------------------------------------------------------- voice commands

/** Channel name -> channel (text/voice). Matches loosely, because the transcript can be garbled. */
export function findChannel(guild, name, kind) {
	const needle = normalize(name);
	const typeOk = (channel) =>
		kind === 'voice'
			? channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
			: channel.type === ChannelType.GuildText;
	const candidates = [...guild.channels.cache.values()].filter((channel) => typeOk(channel));
	if (!needle) return null;
	return findChannelByName(candidates.map((c) => ({ id: c.id, name: c.name, channel: c })), name)?.channel ?? null;
}

// The grammar of the spoken commands comes from the active locale (src/locales/<code>/grammar.js)
// and is compiled once at import time, like every other module-level constant here.

/** { pattern, flags } locale entry -> RegExp; that keeps the grammar tables plain data. */
function rx(entry) {
	return entry ? new RegExp(entry.pattern, entry.flags) : null;
}

const LETTER_CLASSES = tRaw('grammar.letter_classes') ?? {};
const CHARACTER_SWITCH = (tRaw('grammar.character_switch') ?? []).map(rx);
const LEAVE = rx(tRaw('grammar.leave'));
const QUIET_ON = rx(tRaw('grammar.quiet')?.on);
const QUIET_OFF = rx(tRaw('grammar.quiet')?.off);
const QUIET_OFF_NAMED = rx(tRaw('grammar.quiet')?.off_named);
const CHANNEL_SUFFIX = rx(tRaw('grammar.channel_suffix'));
const FILLERS = rx(tRaw('grammar.fillers'));
const MESSAGE_PREFIX = rx(tRaw('grammar.message_prefix'));
const CHANNEL_NAME_FILLERS = rx(tRaw('grammar.channel_name_fillers'));
const GENERIC_CHANNEL_WORDS = tRaw('grammar.generic_channel_words') ?? [];

const SEND = tRaw('grammar.send');
const SEND_VERB = rx(SEND.verb);
const SEND_CHANNEL_LEAD = rx(SEND.channel_lead);
const SEND_LEGACY = rx(SEND.legacy);
const SEND_BARE = rx(SEND.bare);

const READ = tRaw('grammar.read');
const READ_HINT = rx(READ.hint);
const READ_REQUIRES = rx(READ.requires);
const READ_LEGACY = rx(READ.legacy);

const JOIN = tRaw('grammar.join');
const JOIN_VERB = rx(JOIN.verb);
const JOIN_PLACE = rx(JOIN.place);
const JOIN_LEGACY = rx(JOIN.legacy);

const MUSIC = tRaw('grammar.music');
const MUSIC_PATTERNS = MUSIC.patterns.map((entry) => ({ action: entry.action, re: rx(entry) }));
const MUSIC_STOP = MUSIC_PATTERNS.find((entry) => entry.action === 'stop')?.re ?? null;
const VOLUME_SET = rx(MUSIC.volume_set);
const VOLUME_REQUIRES = rx(MUSIC.volume_requires);
const VOLUME_DOWN = rx(MUSIC.volume_down);
const VOLUME_UP = rx(MUSIC.volume_up);
const VOLUME_UP_EXCLUDE = rx(MUSIC.volume_up_exclude);
const SKIP_REQUIRES = rx(MUSIC.skip_requires);
const PLAY_PATTERNS = MUSIC.play_patterns.map(rx);
const QUERY_CLEANUP = MUSIC.query_cleanup.map(rx);
const NOT_A_QUERY = new Set(MUSIC.not_a_query);
// The queue and seek commands (loop, shuffle, clear, move, remove, seek, play next).
const NUMBER_WORDS = new Map((MUSIC.number_words ?? []).map(([word, value]) => [normalize(word), value]));
const TIME_UNITS = (MUSIC.time_units ?? []).map(([start, seconds]) => [normalize(start), seconds]);
const LOOP_PATTERNS = (MUSIC.loop ?? []).map((entry) => ({ mode: entry.mode, re: rx(entry) }));
const SHUFFLE = rx(MUSIC.shuffle);
const CLEAR_QUEUE = rx(MUSIC.clear);
const MOVE_PATTERNS = (MUSIC.move ?? []).map((entry) => ({ place: entry.place ?? null, re: rx(entry) }));
const REMOVE_PATTERNS = (MUSIC.remove ?? []).map(rx);
const SEEK_PATTERNS = (MUSIC.seek ?? []).map((entry) => ({ dir: entry.dir, re: rx(entry) }));
const PLAY_NEXT_PATTERNS = (MUSIC.play_next ?? []).map(rx);
// "Move it to the end": a place past any queue, which the player reads as the last one.
const QUEUE_END = Number.MAX_SAFE_INTEGER;

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Channel name -> a pattern tolerant of the locale's letter variants, e.g. "general chat" -> /general[\s_-]+chat/. */
function namePattern(name) {
	const tokens = normalize(name).split(' ').filter(Boolean);
	if (!tokens.length) return null;
	return tokens
		.map((token) => token.split('').map((ch) => LETTER_CLASSES[ch] ?? escapeRegExp(ch)).join(''))
		.join('[\\s_\\-]+');
}

/** Finds the channel name that occurs in the spoken text (longest name first). */
export function findChannelMention(text, channels) {
	const sorted = [...(channels ?? [])]
		.filter((channel) => normalize(channel.name).length >= 3)
		.sort((a, b) => normalize(b.name).length - normalize(a.name).length);
	for (const channel of sorted) {
		const pattern = namePattern(channel.name);
		if (!pattern) continue;
		const match = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}`, 'iu').exec(text);
		if (match) return { channel, start: match.index, end: match.index + match[0].length };
	}
	return null;
}

function consumeSuffix(text, index) {
	// After the channel name the language may add a marker word or a case suffix:
	// "write hello in the general channel" / a bare case suffix glued to the name.
	const match = text.slice(index).match(CHANNEL_SUFFIX);
	return match ? index + match[0].length : index;
}

function cleanMessage(raw) {
	let out = String(raw ?? '')
		.replace(/^[\s:,-]+/, '')
		.replace(MESSAGE_PREFIX, '')
		.replace(/[\s,.:;!?]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
	for (let i = 0; i < 3; i++) {
		const next = out.replace(FILLERS, '').trim();
		if (next === out) break;
		out = next;
	}
	return out;
}

function bodyAfterVerb(rest) {
	const verb = SEND_VERB.exec(rest);
	if (!verb) return null;
	const before = cleanMessage(rest.slice(0, verb.index));
	if (before) return before; // the message came before the verb
	return cleanMessage(rest.slice(verb.index + verb[0].length)) || null; // "… write: hello"
}

/**
 * The message that sits in FRONT of the channel name. Languages that name the target last ("write
 * hello in the general channel") need it, so the preposition that introduces the channel is trimmed
 * off first. Turkish marks the channel with a case suffix after its name and never puts the message
 * there, so the locale switches this off and nothing changes.
 */
function bodyBeforeChannel(text, start) {
	if (!SEND.body_before_channel) return null;
	const head = text.slice(0, start);
	return bodyAfterVerb(SEND_CHANNEL_LEAD ? head.replace(SEND_CHANNEL_LEAD, '') : head);
}

/** Generic words like "voice/channel/this" are not channel names; filler words are dropped. */
function cleanChannelName(raw) {
	let name = String(raw ?? '').trim();
	for (let i = 0; i < 3; i++) {
		const next = name.replace(CHANNEL_NAME_FILLERS, '').trim();
		if (next === name) break;
		name = next;
	}
	const key = normalize(name);
	if (!key || GENERIC_CHANNEL_WORDS.includes(key)) return null;
	return name;
}

function extractSend(text, channels) {
	if (!SEND_VERB.test(text)) return null;

	const mention = findChannelMention(text, channels);
	if (mention) {
		const rest = text.slice(consumeSuffix(text, mention.end));
		const body = bodyAfterVerb(rest) ?? bodyBeforeChannel(text, mention.start);
		if (body) return { type: 'send', channel: mention.channel, name: mention.channel.name, text: body };
		return null;
	}

	// The channel name is not in the list: read it out of the locale's "<name> channel" shape, then
	// match it loosely.
	const legacy = text.match(SEND_LEGACY);
	if (legacy) {
		const name = cleanChannelName(legacy[SEND.legacy.name]);
		const body = bodyAfterVerb(legacy[SEND.legacy.body].trim());
		if (name && body) return { type: 'send', channel: findChannelByName(channels, name), name, text: body };
	}

	// No name was said at all: "write hello in the channel" (the default channel is used)
	const bare = text.match(SEND_BARE);
	if (bare) {
		const body = bodyAfterVerb(text.slice(bare.index + bare[0].length)) ?? bodyBeforeChannel(text, bare.index);
		if (body) return { type: 'send', channel: null, name: null, text: body };
	}

	return null;
}

function extractRead(text, channels) {
	if (!READ_HINT.test(text)) return null;
	if (!READ_REQUIRES.test(text)) return null;

	const mention = findChannelMention(text, channels);
	if (mention) return { type: 'read', channel: mention.channel, name: mention.channel.name };

	const legacy = text.match(READ_LEGACY);
	if (legacy) {
		const name = cleanChannelName(legacy[1]);
		if (name) return { type: 'read', channel: findChannelByName(channels, name), name };
	}
	// No channel named: the caller falls back to the default channel or asks.
	return { type: 'read', channel: null, name: null };
}

/** The locale's imperative join verbs (not a past tense), tested word by word. */
function hasJoinVerb(text) {
	return normalize(text)
		.split(' ')
		.some((token) => JOIN_VERB.test(token));
}

function extractJoin(text, channels) {
	const mention = findChannelMention(text, channels);
	// A channel/room word or a known voice channel name has to be there; otherwise words like
	// "come/enter" fire on the wrong sentences.
	if (!mention && !JOIN_PLACE.test(text)) return null;
	if (!hasJoinVerb(text)) return null;

	if (mention) return { type: 'join', channel: mention.channel, name: mention.channel.name };

	const legacy = text.match(JOIN_LEGACY);
	if (legacy) {
		const name = cleanChannelName(legacy[1]);
		if (name) return { type: 'join', channel: findChannelByName(channels, name), name };
	}
	return { type: 'join', channel: null, name: null };
}

// ---------------------------------------------------------------- music commands

/** A captured play query, cleaned; null when what is left names nothing ("play something"). */
function cleanQuery(raw) {
	const query = QUERY_CLEANUP.reduce((value, cleanup) => value.replace(cleanup, ''), cleanMessage(raw)).trim();
	return query.length < 3 || NOT_A_QUERY.has(normalize(query)) ? null : query;
}

/** "3", "three", "üç", "üçüncü" -> 3, through the locale's number words; null for anything else. */
function spokenNumber(token) {
	const text = normalize(token);
	if (!text) return null;
	if (/^\d+$/u.test(text)) return Number(text);
	return NUMBER_WORDS.get(text) ?? null;
}

/** Seconds per unit for a spoken unit word, matched by how it starts ("seconds", "saniyeye"). */
function unitSeconds(word) {
	const text = normalize(word);
	return TIME_UNITS.find(([start]) => text.startsWith(start))?.[1] ?? null;
}

/** The seconds a seek pattern captured: a clock time ("1:30"), or one or two amounts with their units. */
function seekSeconds(groups) {
	if (groups.stamp) return parseClock(groups.stamp);
	let total = null;
	for (const [amount, unit] of [
		[groups.n1, groups.u1],
		[groups.n2, groups.u2],
	]) {
		if (amount === undefined) continue;
		const value = spokenNumber(amount);
		const seconds = unitSeconds(unit);
		if (value === null || seconds === null) return null;
		total = (total ?? 0) + value * seconds;
	}
	return total;
}

/**
 * The queue and seek commands. They are matched before the playback controls and the play requests,
 * which would otherwise take them for something else: "skip ahead 30 seconds" is not a skip, and
 * "play X next" is not a skip either (the word "next").
 */
function extractQueueCommand(line) {
	for (const { mode, re } of LOOP_PATTERNS) {
		if (re.test(line)) return { type: 'music', action: 'loop', mode };
	}
	if (SHUFFLE?.test(line)) return { type: 'music', action: 'shuffle' };
	if (CLEAR_QUEUE?.test(line)) return { type: 'music', action: 'clear' };
	for (const { place, re } of MOVE_PATTERNS) {
		const groups = re.exec(line)?.groups;
		if (!groups) continue;
		const from = spokenNumber(groups.from);
		const to = place === 'top' ? 1 : place === 'end' ? QUEUE_END : spokenNumber(groups.to);
		if (from && to) return { type: 'music', action: 'move', from, to };
	}
	for (const re of REMOVE_PATTERNS) {
		const position = spokenNumber(re.exec(line)?.groups?.pos);
		if (position) return { type: 'music', action: 'remove', position };
	}
	for (const { dir, re } of SEEK_PATTERNS) {
		const match = re.exec(line);
		if (!match) continue;
		if (dir === 'start') return { type: 'music', action: 'seek', to: 0 };
		const seconds = seekSeconds(match.groups ?? {});
		if (seconds === null) continue;
		if (dir === 'to') return { type: 'music', action: 'seek', to: seconds };
		return { type: 'music', action: 'seek', by: dir === 'back' ? -seconds : seconds };
	}
	for (const re of PLAY_NEXT_PATTERNS) {
		const match = re.exec(line);
		const query = match ? cleanQuery(match[1]) : null;
		if (query) return { type: 'music', action: 'play', query, next: true };
	}
	return null;
}

/**
 * Music command: { type:'music', action, ... } or null. Besides play (query, next?), volume (percent or
 * delta) and the bare controls, the queue commands: loop (mode), shuffle, clear, move (from, to),
 * remove (position) and seek (to, or by for a step).
 */
export function extractMusic(text) {
	const line = String(text ?? '');
	const setMatch = VOLUME_SET.exec(line);
	if (setMatch && VOLUME_REQUIRES.test(line)) {
		const percent = Math.max(0, Math.min(100, Number(setMatch[1])));
		return { type: 'music', action: 'volume', percent };
	}
	if (VOLUME_DOWN.test(line)) return { type: 'music', action: 'volume', delta: -15 };
	if (VOLUME_UP.test(line) && !VOLUME_UP_EXCLUDE.test(line)) {
		return { type: 'music', action: 'volume', delta: 15 };
	}
	// Stop still comes first: it clears the queue as well, so "stop the music and clear the queue" asks
	// for nothing that stopping does not do, and read as a clear it would leave the music playing.
	if (MUSIC_STOP?.test(line)) return { type: 'music', action: 'stop' };
	const queued = extractQueueCommand(line);
	if (queued) return queued;
	for (const { action, re } of MUSIC_PATTERNS) {
		if (action === 'skip' && !SKIP_REQUIRES.test(line)) continue;
		if (re.test(line)) return { type: 'music', action };
	}
	for (const re of PLAY_PATTERNS) {
		const match = re.exec(line);
		const query = match ? cleanQuery(match[1]) : null;
		if (query) return { type: 'music', action: 'play', query };
	}
	return null;
}

/**
 * Quiet on/off. The state belongs to the application, so the words that switch it are matched here
 * and run without the model; the owner gate still decides whether those words were the owner's.
 */
/** Is one of the bot's names in the line: the active characters', or the generic ones ("bot")? */
function namedIn(text, characters) {
	const tokens = new Set(normalize(text).split(' ').filter(Boolean));
	const names = [...(characters ?? []).map((character) => character?.name), ...(tRaw('runtime.wake_words') ?? [])];
	return names.some((name) => name && tokens.has(normalize(String(name))));
}

/**
 * Giving the voice back by mistake is the direction the owner minds -- they asked for silence -- so the
 * way back on the bare word alone needs the bot's name next to it. The bare word is the one the
 * transcript can hand over out of its own negation: "artık konuşma" (do not talk any more) arrived as
 * "Artık konuş", six seconds after the owner had asked for quiet.
 */
function extractQuiet(text, characters = []) {
	if (QUIET_OFF?.test(text)) return { type: 'quiet', value: 'off' };
	if (QUIET_OFF_NAMED?.test(text) && namedIn(text, characters)) return { type: 'quiet', value: 'off' };
	if (QUIET_ON?.test(text)) return { type: 'quiet', value: 'on' };
	return null;
}

/**
 * Extracts a command from what was said in the channel. Returns null when nothing matches.
 *
 * channels: { text: [{id,name}], voice: [{id,name}] } — channel names are matched loosely against
 * ASR errors, so the real channel list has to be passed in.
 *
 * Returned shape: { type: 'character', character } | { type: 'character-miss', name }
 *   | { type: 'send', channel, name, text } | { type: 'read', channel, name }
 *   | { type: 'join', channel, name } | { type: 'leave' } | { type: 'music', action, ... }
 *   | { type: 'quiet', value: 'on' | 'off' }
 */
export function parseVoiceCommand(text, characters = [], channels = { text: [], voice: [] }) {
	const line = String(text ?? '').replace(/\s+/g, ' ').trim();
	if (!line) return null;

	// Character switch, e.g. "switch to the <name> character"; capture group 1 is the name.
	for (const pattern of CHARACTER_SWITCH) {
		const characterMatch = line.match(pattern);
		if (!characterMatch) continue;
		const name = characterMatch[1].trim();
		const character = findCharacter(characters, name);
		return character ? { type: 'character', character } : { type: 'character-miss', name };
	}

	if (LEAVE.test(line)) return { type: 'leave' };

	const music = extractMusic(line);
	if (music) return music;

	const quiet = extractQuiet(line, characters);
	if (quiet) return quiet;

	const read = extractRead(line, channels.text ?? []);
	if (read) return read;

	const send = extractSend(line, channels.text ?? []);
	if (send) return send;

	const join = extractJoin(line, channels.voice ?? []);
	if (join) return join;

	return null;
}

// ---------------------------------------------------------------- action signature / routing

/** Command signature, so the same request is not executed twice. */
export function actionSignature(command, now = Date.now()) {
	if (!command) return null;
	switch (command.type) {
		case 'send':
			return `send:${command.channel?.id ?? command.name ?? '-'}:${normalize(command.text ?? '')}`;
		case 'read':
			return `read:${command.channel?.id ?? command.name ?? '-'}`;
		case 'join':
			return `join:${command.channel?.id ?? command.name ?? '-'}`;
		case 'leave':
			return 'leave';
		case 'quiet':
			// Repeated "sus" inside the same five seconds is the same request, not two.
			return `quiet:${command.value}:${Math.floor(now / 5000)}`;
		case 'character':
			return `character:${command.character?.id ?? command.name ?? '-'}`;
		case 'music': {
			// A play request is deduplicated for 30 s (the same request can arrive by two routes);
			// skip/volume and friends only within a 5 s window, so that "skip, skip" skips two tracks.
			// "Play X next" is its own request: said right after "play X", it moves X up rather than
			// being answered from the first one's result.
			if (command.action === 'play') return `music:play${command.next ? ':next' : ''}:${normalize(command.query ?? '')}`;
			// Named, not just listed: a seek "to 90" and a seek "by 90" are different requests.
			const detail = ['percent', 'delta', 'mode', 'from', 'to', 'by', 'position']
				.filter((key) => command[key] !== undefined)
				.map((key) => `${key}=${command[key]}`)
				.join(',');
			return `music:${command.action}:${detail}:${Math.floor(now / 5000)}`;
		}
		default:
			return null;
	}
}

/** Short-lived cache of the actions that ran most recently (blocks double submissions). */
export class RecentActions {
	constructor({ ttlMs = 30_000, max = 50 } = {}) {
		this.ttlMs = ttlMs;
		this.max = max;
		this.items = new Map();
	}

	remember(signature, result) {
		if (!signature) return;
		this.items.set(signature, { at: Date.now(), result });
		this.prune();
	}

	recall(signature) {
		if (!signature) return null;
		const entry = this.items.get(signature);
		if (!entry) return null;
		if (Date.now() - entry.at > this.ttlMs) {
			this.items.delete(signature);
			return null;
		}
		return entry.result;
	}

	prune() {
		const now = Date.now();
		for (const [key, entry] of this.items) {
			if (now - entry.at > this.ttlMs) this.items.delete(key);
		}
		while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
	}
}

/**
 * Routes a delegation text to a local Discord action or to research.
 * If an action pattern matches it is local work, otherwise it is taken as a question about
 * current information.
 */
export function routeDelegation(text, characters = [], channels = { text: [], voice: [] }) {
	const command = parseVoiceCommand(text, characters, channels);
	return command ? { kind: 'action', command } : { kind: 'research' };
}
