// Server-wide administration: identity (name, description, icon, banner), the AFK/system channel
// settings, integrations, member pruning and stage channel control.
//
// Everything here reaches past a single channel and touches the whole guild, so every tool that
// writes is owner-gated and the prune -- the only tool in the project that can remove a crowd of
// people in one call -- always says the dry-run number out loud before it is allowed to run.

import {
	ChannelType,
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	displayName,
	failure,
	findMember,
	resolveAnyChannel,
	resolveTextChannel,
	resolveVoiceChannel,
} from './helpers.js';
import { GuildDefaultMessageNotifications, GuildFeature, StageInstancePrivacyLevel } from 'discord.js';
import { t, tList } from '../i18n/index.js';
import { normalize } from '../text.js';
import { P, defineTool } from './registry.js';

// ---------------------------------------------------------------- permissions

/** Permission name for a refusal. Written out here because the shared table only covers the ones that can be handed out by voice. */
function permissionName(flag) {
	switch (flag) {
		case 'ManageGuild':
			return t('tools.server.perm_manage_guild');
		case 'KickMembers':
			return t('tools.server.perm_kick_members');
		case 'ManageChannels':
			return t('tools.server.perm_manage_channels');
		case 'MuteMembers':
			return t('tools.server.perm_mute_members');
		case 'MoveMembers':
			return t('tools.server.perm_move_members');
		default:
			return flag;
	}
}

/**
 * Guild-level permissions the bot does not hold.
 *
 * An empty list also means "cannot tell": a guild whose own member entry has not been cached has no
 * `members.me`, and refusing on a missing cache entry would block calls Discord would have accepted.
 * The API error is explained by `failure()` in that case.
 */
function missingGuildPermissions(deps, flags) {
	const held = deps.guild?.members?.me?.permissions ?? null;
	if (typeof held?.has !== 'function') return [];
	if (held.has(PermissionFlagsBits.Administrator)) return [];
	return flags.filter((flag) => !held.has(PermissionFlagsBits[flag]));
}

/** The same check inside one channel: a stage moderator is defined by the permissions held IN the stage channel. */
function missingChannelPermissions(deps, channel, flags) {
	const me = deps.guild?.members?.me ?? null;
	const held = me && typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
	if (typeof held?.has !== 'function') return missingGuildPermissions(deps, flags);
	if (held.has(PermissionFlagsBits.Administrator)) return [];
	return flags.filter((flag) => !held.has(PermissionFlagsBits[flag]));
}

/** One shape for "I am missing a permission", so the speaker is told what to grant instead of hearing an API code. */
function permissionRefusal(missing) {
	return { ok: false, spoken: t('tools.server.missing_permission', { permissions: missing.map(permissionName).join(', ') }) };
}

// ---------------------------------------------------------------- images

// Discord's own CDN, and nothing else. discord.js downloads an icon/banner URL itself
// (DataResolver.resolveImage) before uploading it, so any other host would turn "set the server icon"
// into an outbound request to an address that came out of a chat message. Same restriction the
// expression tools put on emoji and sticker images.
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** @returns {string|null} the URL when it is an https Discord CDN address, null otherwise. */
function cdnImageUrl(raw) {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	let url = null;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	return DISCORD_CDN_HOSTS.has(url.hostname) ? url.toString() : null;
}

// "none" / "nowhere" and their translations: the shared vocabulary for "no target at all".
const NONE_WORDS = tList('keywords.no_category_words');

/** Does this argument mean "clear it" rather than name something? */
function meansNone(raw) {
	const key = normalize(raw);
	return Boolean(key) && NONE_WORDS.includes(key);
}

// ---------------------------------------------------------------- settings

// Discord only accepts these AFK timeouts (seconds); anything else is rejected outright, so a spoken
// number is snapped to the nearest one instead of being sent and refused.
const AFK_TIMEOUTS = [60, 300, 900, 1800, 3600];

function nearestAfkTimeout(minutes) {
	const wanted = Math.max(1, Math.round(Number(minutes))) * 60;
	return AFK_TIMEOUTS.reduce((best, value) => (Math.abs(value - wanted) < Math.abs(best - wanted) ? value : best), AFK_TIMEOUTS[0]);
}

/** Channel name from an id, read out of the cache so a mocked or partially cached guild still answers. */
function channelNameById(deps, id) {
	if (!id) return null;
	return deps.guild.channels?.cache?.get(id)?.name ?? null;
}

function notificationLabel(level) {
	return level === GuildDefaultMessageNotifications.OnlyMentions ? t('tools.server.notify_mentions') : t('tools.server.notify_all');
}

// ---------------------------------------------------------------- stage channels

/**
 * Resolves the stage channel a stage tool should act on: the named one, or the channel the bot is
 * sitting in when no name was given.
 * @returns {{ channel: object }|{ error: string }}
 */
function resolveStageChannel(deps, raw) {
	const asked = String(raw ?? '').trim();
	const channel = asked ? resolveAnyChannel(deps, asked) : (deps.currentVoiceChannel?.() ?? null);
	if (!channel) return { error: asked ? t('tools.server.channel_not_found', { name: asked }) : t('tools.server.which_stage') };
	if (channel.type !== ChannelType.GuildStageVoice) return { error: t('tools.server.not_a_stage', { name: channel.name }) };
	return { channel };
}

/** The live stage instance of a channel, from the cache first and from the API only if it is not cached. */
async function currentStageInstance(deps, channel) {
	const cached = [...(deps.guild.stageInstances?.cache?.values?.() ?? [])].find((instance) => instance.channelId === channel.id);
	if (cached) return cached;
	if (typeof deps.guild.stageInstances?.fetch !== 'function') return null;
	// A channel with no stage running answers 404, which is an answer and not a failure.
	return (await deps.guild.stageInstances.fetch(channel.id).catch(() => null)) ?? null;
}

// ---------------------------------------------------------------- prune

/**
 * Discord only prunes on 1-30 days of inactivity; 30 (the mildest setting) is the default.
 * An argument that is missing, zero, negative or not a number falls back to 30 rather than being
 * clamped up to 1: one day of inactivity is the most destructive reading a bad value could take.
 */
function pruneDays(raw) {
	const value = Math.round(Number(raw));
	if (!Number.isFinite(value) || value < 1) return 30;
	return Math.min(30, value);
}

/**
 * The member count out of a prune response, or null when Discord did not send one.
 * Coercing here would be wrong: `pruned: null` is a real answer from the API ("I did not count"),
 * and Number(null) is 0, which would be read out as "nobody would be removed".
 */
function pruneNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export const tools = [
	defineTool({
		name: 'edit_server',
		description:
			'Changes the server itself: its name, its description, its icon or its banner. Images must be links to ' +
			'Discord\'s own CDN (cdn.discordapp.com / media.discordapp.net); no other address is accepted. A word ' +
			'meaning "none" clears the description, the icon or the banner. Needs the Manage Server permission. Owner only.',
		parameters: P.obj({
			name: P.str('New server name (2-100 characters)'),
			description: P.str('New server description (up to 120 characters); a word meaning "none" clears it'),
			icon_url: P.str('Discord CDN link to the new icon; a word meaning "none" removes the icon'),
			banner_url: P.str('Discord CDN link to the new banner (the server must have the banner feature); a word meaning "none" removes it'),
		}),
		gate: { keywords: WORDS.server },
		async handler(args, deps) {
			const missing = missingGuildPermissions(deps, ['ManageGuild']);
			if (missing.length) return permissionRefusal(missing);

			const patch = {};
			const done = [];
			if (args.name !== undefined && String(args.name).trim()) {
				const name = String(args.name).trim().slice(0, 100);
				if (name.length < 2) return { ok: false, spoken: t('tools.server.name_too_short') };
				patch.name = name;
				done.push(t('tools.server.part_renamed', { name }));
			}
			if (args.description !== undefined) {
				const clear = meansNone(args.description) || !String(args.description).trim();
				patch.description = clear ? null : String(args.description).trim().slice(0, 120);
				done.push(clear ? t('tools.server.part_description_cleared') : t('tools.server.part_description_set'));
			}
			// The icon and the banner take the same shape, so they are resolved by the same few lines.
			for (const [key, raw] of [
				['icon', args.icon_url],
				['banner', args.banner_url],
			]) {
				if (raw === undefined) continue;
				const icon = key === 'icon';
				if (meansNone(raw) || !String(raw).trim()) {
					patch[key] = null;
					done.push(icon ? t('tools.server.part_icon_cleared') : t('tools.server.part_banner_cleared'));
					continue;
				}
				const url = cdnImageUrl(raw);
				if (!url) return { ok: false, spoken: t('tools.server.not_discord_cdn') };
				// A banner only exists on a server that has the feature (boost level 2, or a partnered server);
				// sending one anywhere else comes back as a bare "invalid form body".
				if (!icon && !(deps.guild.features ?? []).includes(GuildFeature.Banner)) {
					return { ok: false, spoken: t('tools.server.no_banner_feature') };
				}
				patch[key] = url;
				done.push(icon ? t('tools.server.part_icon_set') : t('tools.server.part_banner_set'));
			}
			if (!done.length) return { ok: false, spoken: t('tools.server.nothing_to_change') };

			try {
				await deps.guild.edit({ ...patch, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.server.log_edited', { details: done.join(', ') }));
				return {
					ok: true,
					spoken: t('tools.server.edited', { details: done.join(', ') }),
					data: { name: patch.name ?? null, description: patch.description, icon: patch.icon, banner: patch.banner },
				};
			} catch (err) {
				return failure(deps, 'server edit failed', err, t('tools.server.edit_failed'));
			}
		},
	}),

	defineTool({
		name: 'server_settings',
		description:
			'Reads the server-wide settings: the AFK channel and its timeout, the system channel where Discord posts ' +
			'join and boost notices, the default notification level, and the description.',
		async handler(args, deps) {
			const afkChannel = channelNameById(deps, deps.guild.afkChannelId);
			const systemChannel = channelNameById(deps, deps.guild.systemChannelId);
			const afkMinutes = Math.round(Number(deps.guild.afkTimeout ?? 0) / 60) || 0;
			const notifications = notificationLabel(deps.guild.defaultMessageNotifications);
			return {
				ok: true,
				spoken: t('tools.server.settings', {
					afk: afkChannel ? t('tools.server.afk_is', { channel: afkChannel, minutes: afkMinutes }) : t('tools.server.afk_none'),
					system: systemChannel ? t('tools.server.system_is', { channel: systemChannel }) : t('tools.server.system_none'),
					notifications,
				}),
				data: {
					afkChannel,
					afkTimeoutMinutes: afkMinutes,
					systemChannel,
					notifications,
					description: deps.guild.description ?? null,
					features: [...(deps.guild.features ?? [])],
				},
			};
		},
	}),

	defineTool({
		name: 'set_server_settings',
		description:
			'Sets the AFK channel and its timeout, the system channel, and the default notification level for the whole ' +
			'server. A word meaning "none" clears the AFK channel or the system channel. Needs the Manage Server ' +
			'permission. Owner only.',
		parameters: P.obj({
			afk_channel: P.str('Voice channel that idle members are dragged into; a word meaning "none" turns it off'),
			afk_timeout_minutes: P.int('Idle minutes before that move: 1, 5, 15, 30 or 60 (anything else is snapped to the nearest)'),
			system_channel: P.str('Text channel for Discord\'s own join and boost notices; a word meaning "none" turns it off'),
			notifications: {
				type: 'string',
				enum: ['all', 'mentions'],
				description: 'Default notification level: "all" messages, or only "mentions"',
			},
		}),
		gate: { keywords: WORDS.server },
		async handler(args, deps) {
			const missing = missingGuildPermissions(deps, ['ManageGuild']);
			if (missing.length) return permissionRefusal(missing);

			const patch = {};
			const done = [];
			if (args.afk_channel !== undefined) {
				if (meansNone(args.afk_channel) || !String(args.afk_channel).trim()) {
					patch.afkChannel = null;
					done.push(t('tools.server.part_afk_cleared'));
				} else {
					const channel = resolveVoiceChannel(deps, String(args.afk_channel));
					if (!channel) return { ok: false, spoken: t('tools.server.voice_not_found', { name: args.afk_channel }) };
					// Discord refuses a stage channel as the AFK target; say so rather than passing it on.
					if (channel.type !== ChannelType.GuildVoice) {
						return { ok: false, spoken: t('tools.server.afk_not_voice', { name: channel.name }) };
					}
					patch.afkChannel = channel.id;
					done.push(t('tools.server.part_afk_set', { channel: channel.name }));
				}
			}
			if (args.afk_timeout_minutes !== undefined && Number.isFinite(Number(args.afk_timeout_minutes))) {
				patch.afkTimeout = nearestAfkTimeout(args.afk_timeout_minutes);
				done.push(t('tools.server.part_afk_timeout', { minutes: Math.round(patch.afkTimeout / 60) }));
			}
			if (args.system_channel !== undefined) {
				if (meansNone(args.system_channel) || !String(args.system_channel).trim()) {
					patch.systemChannel = null;
					done.push(t('tools.server.part_system_cleared'));
				} else {
					const channel = resolveTextChannel(deps, String(args.system_channel));
					if (!channel) return { ok: false, spoken: t('tools.server.text_not_found', { name: args.system_channel }) };
					patch.systemChannel = channel.id;
					done.push(t('tools.server.part_system_set', { channel: channel.name }));
				}
			}
			if (args.notifications !== undefined && String(args.notifications).trim()) {
				const mentions = String(args.notifications).trim().toLowerCase().startsWith('m');
				patch.defaultMessageNotifications = mentions
					? GuildDefaultMessageNotifications.OnlyMentions
					: GuildDefaultMessageNotifications.AllMessages;
				done.push(t('tools.server.part_notifications', { level: notificationLabel(patch.defaultMessageNotifications) }));
			}
			if (!done.length) return { ok: false, spoken: t('tools.server.nothing_to_change') };

			try {
				await deps.guild.edit({ ...patch, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.server.log_settings', { details: done.join(', ') }));
				return { ok: true, spoken: t('tools.server.settings_saved', { details: done.join(', ') }), data: { changes: patch } };
			} catch (err) {
				return failure(deps, 'server settings unchanged', err, t('tools.server.settings_failed'));
			}
		},
	}),

	defineTool({
		name: 'list_integrations',
		description:
			'Lists the integrations connected to the server -- the bots with their applications, plus Twitch/YouTube ' +
			'subscriber links. Needs the Manage Server permission.',
		async handler(args, deps) {
			const missing = missingGuildPermissions(deps, ['ManageGuild']);
			if (missing.length) return permissionRefusal(missing);
			if (typeof deps.guild.fetchIntegrations !== 'function') return { ok: false, spoken: t('tools.server.integrations_unavailable') };
			try {
				const fetched = await deps.guild.fetchIntegrations();
				const entries = [...(fetched?.values?.() ?? [])].map((integration) => ({
					name: integration.name ?? null,
					type: integration.type ?? null,
					enabled: integration.enabled ?? null,
					// Only a "discord" integration carries an application; that is where a bot's real name lives.
					application: integration.application?.name ?? null,
					applicationId: integration.application?.id ?? null,
					bot: integration.application?.bot?.username ?? integration.user?.username ?? null,
					account: integration.account?.name ?? null,
				}));
				const bots = entries.filter((entry) => entry.application).map((entry) => entry.application);
				const others = entries.filter((entry) => !entry.application).map((entry) => `${entry.name} (${entry.type})`);
				return {
					ok: true,
					spoken: entries.length
						? t('tools.server.integrations', {
								count: entries.length,
								bots: bots.join(', ') || t('tools.server.integrations_no_bots'),
								others: others.join(', ') || t('tools.server.integrations_no_others'),
							})
						: t('tools.server.integrations_empty'),
					data: { count: entries.length, integrations: entries },
				};
			} catch (err) {
				return failure(deps, 'integration list failed', err, t('tools.server.integrations_failed'));
			}
		},
	}),

	defineTool({
		name: 'prune_count',
		description:
			'Counts how many members a prune WOULD remove, without removing anybody. A prune only ever touches members ' +
			'who have no role at all and who have not been seen for the given number of days. Needs the Manage Server ' +
			'and Kick Members permissions.',
		parameters: P.obj({ days: P.int('Days of inactivity, 1-30 (default 30)') }),
		async handler(args, deps) {
			const missing = missingGuildPermissions(deps, ['ManageGuild', 'KickMembers']);
			if (missing.length) return permissionRefusal(missing);
			const days = pruneDays(args.days);
			try {
				const count = pruneNumber(await deps.guild.members.prune({ days, dry: true }));
				if (count === null) return { ok: false, spoken: t('tools.server.prune_count_unknown') };
				return {
					ok: true,
					spoken: count > 0 ? t('tools.server.prune_would', { count, days }) : t('tools.server.prune_none', { days }),
					data: { days, count },
				};
			} catch (err) {
				return failure(deps, 'prune count failed', err, t('tools.server.prune_count_failed'));
			}
		},
	}),

	defineTool({
		name: 'prune_members',
		description:
			'Removes every member who has no role and has not been seen for the given number of days. This kicks people ' +
			'in bulk and cannot be undone. It always counts first and says the number, then asks; call it again with ' +
			'confirm:true to actually run it. Needs the Manage Server and Kick Members permissions. Owner only.',
		parameters: P.obj({
			days: P.int('Days of inactivity, 1-30 (default 30)'),
			reason: P.str('Reason for the audit log (optional)'),
			confirm: P.confirm(),
		}),
		gate: { keywords: WORDS.prune },
		async handler(args, deps, { name }) {
			const missing = missingGuildPermissions(deps, ['ManageGuild', 'KickMembers']);
			if (missing.length) return permissionRefusal(missing);
			const days = pruneDays(args.days);

			// The dry run comes first on BOTH steps. The number is what the owner is asked to confirm, so a count
			// that has moved since the question invalidates the confirmation instead of quietly kicking more people.
			let count = null;
			try {
				count = pruneNumber(await deps.guild.members.prune({ days, dry: true }));
			} catch (err) {
				return failure(deps, 'prune count failed', err, t('tools.server.prune_count_failed'));
			}
			if (count === null) return { ok: false, spoken: t('tools.server.prune_count_unknown') };
			if (count <= 0) return { ok: true, spoken: t('tools.server.prune_none', { days }), data: { days, count: 0, pruned: 0 } };

			const decision = checkConfirmation(deps, {
				key: name,
				target: `${days}:${count}`,
				confirm: args.confirm,
				question: t('tools.server.prune_question', { count, days }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { count, days });
			if (decision.stale) return STALE_CONFIRMATION();

			try {
				const pruned = await deps.guild.members.prune({
					days,
					count: true,
					reason: args.reason ? String(args.reason).slice(0, 400) : t('tools.helpers.audit_reason'),
				});
				const removed = pruneNumber(pruned) ?? count;
				deps.log?.(t('tools.server.log_pruned', { count: removed, days }));
				return { ok: true, spoken: t('tools.server.pruned', { count: removed, days }), data: { days, expected: count, pruned: removed } };
			} catch (err) {
				return failure(deps, 'prune failed', err, t('tools.server.prune_failed'));
			}
		},
	}),

	defineTool({
		name: 'start_stage',
		description:
			'Starts a stage in a stage channel with a topic, so the people in it become an audience and only speakers ' +
			'are heard. Needs the Manage Channels, Mute Members and Move Members permissions in that channel. Owner only.',
		parameters: P.obj(
			{
				topic: P.str('What the stage is about (1-120 characters)'),
				channel: P.str('Stage channel name (when empty: the stage channel the bot is in)'),
			},
			['topic'],
		),
		gate: { keywords: WORDS.server },
		async handler(args, deps) {
			const resolved = resolveStageChannel(deps, args.channel);
			if (resolved.error) return { ok: false, spoken: resolved.error };
			const { channel } = resolved;
			const topic = String(args.topic ?? '').trim().slice(0, 120);
			if (!topic) return { ok: false, spoken: t('tools.server.stage_needs_topic') };
			// A stage moderator is exactly these three permissions together; Discord checks all of them.
			const missing = missingChannelPermissions(deps, channel, ['ManageChannels', 'MuteMembers', 'MoveMembers']);
			if (missing.length) return permissionRefusal(missing);

			const running = await currentStageInstance(deps, channel);
			if (running) return { ok: false, spoken: t('tools.server.stage_already_live', { channel: channel.name, topic: running.topic ?? topic }) };
			try {
				// sendStartNotification is deliberately left off: it pings @everyone, which is not something a
				// spoken "start the stage" should ever do on its own.
				const instance = await deps.guild.stageInstances.create(channel.id, {
					topic,
					privacyLevel: StageInstancePrivacyLevel.GuildOnly,
				});
				deps.log?.(t('tools.server.log_stage_started', { channel: channel.name, topic }));
				return {
					ok: true,
					spoken: t('tools.server.stage_started', { channel: channel.name, topic }),
					data: { channel: channel.name, topic, id: instance?.id ?? null },
				};
			} catch (err) {
				return failure(deps, 'stage start failed', err, t('tools.server.stage_start_failed'));
			}
		},
	}),

	defineTool({
		name: 'end_stage',
		description:
			'Ends the stage that is running in a stage channel; everybody stays in the channel and can speak again. ' +
			'Needs the Manage Channels, Mute Members and Move Members permissions in that channel. Owner only.',
		parameters: P.obj({ channel: P.str('Stage channel name (when empty: the stage channel the bot is in)') }),
		gate: { keywords: WORDS.server },
		async handler(args, deps) {
			const resolved = resolveStageChannel(deps, args.channel);
			if (resolved.error) return { ok: false, spoken: resolved.error };
			const { channel } = resolved;
			const missing = missingChannelPermissions(deps, channel, ['ManageChannels', 'MuteMembers', 'MoveMembers']);
			if (missing.length) return permissionRefusal(missing);

			const running = await currentStageInstance(deps, channel);
			if (!running) return { ok: false, spoken: t('tools.server.stage_not_live', { channel: channel.name }) };
			try {
				await deps.guild.stageInstances.delete(channel.id);
				deps.log?.(t('tools.server.log_stage_ended', { channel: channel.name }));
				return { ok: true, spoken: t('tools.server.stage_ended', { channel: channel.name }), data: { channel: channel.name } };
			} catch (err) {
				return failure(deps, 'stage end failed', err, t('tools.server.stage_end_failed'));
			}
		},
	}),

	defineTool({
		name: 'invite_to_stage',
		description:
			'Invites somebody who is in a stage channel up onto the stage as a speaker, or (speaker:false) puts them ' +
			'back in the audience. They must already be in the stage channel. Needs the Mute Members permission in ' +
			'that channel. Owner only.',
		parameters: P.obj(
			{
				member: P.str('Person name'),
				speaker: P.bool('true = let them speak (default), false = back to the audience'),
			},
			['member'],
		),
		gate: { keywords: WORDS.server },
		async handler(args, deps) {
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.server.member_not_found', { name: args.member }) };
			const who = displayName(member);
			// The voice state carries the channel; a member who is not connected has no stage to be invited onto.
			const channel = member.voice?.channel ?? deps.guild.channels?.cache?.get(member.voice?.channelId ?? '') ?? null;
			if (!channel) return { ok: false, spoken: t('tools.server.not_in_voice', { who }) };
			if (channel.type !== ChannelType.GuildStageVoice) {
				return { ok: false, spoken: t('tools.server.not_in_stage', { who, channel: channel.name }) };
			}
			const missing = missingChannelPermissions(deps, channel, ['MuteMembers']);
			if (missing.length) return permissionRefusal(missing);

			const speaker = args.speaker !== false;
			try {
				// "Suppressed" is Discord's word for being in the audience, so a speaker is an unsuppressed member.
				await member.voice.setSuppressed(!speaker);
				deps.log?.(t(speaker ? 'tools.server.log_stage_speaker' : 'tools.server.log_stage_audience', { who, channel: channel.name }));
				return {
					ok: true,
					spoken: speaker
						? t('tools.server.stage_speaker', { who, channel: channel.name })
						: t('tools.server.stage_audience', { who, channel: channel.name }),
					data: { member: who, channel: channel.name, speaker },
				};
			} catch (err) {
				return failure(deps, 'stage speaker change failed', err, t('tools.server.stage_speaker_failed', { who }));
			}
		},
	}),
];
