// Channel tools: create, edit, delete (confirmed), lock, permissions, invite, list, server summary.

import {
	ChannelType,
	findMemberDetailed,
	PERMISSION_EVERYONE_WORDS,
	PERMISSION_HELP,
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	displayName,
	failure,
	noteGate,
	parsePermissions,
	permissionLabels,
	resolveAnyChannel,
	resolveRole,
	resolveTextChannel,
	textChannels,
	trDate,
	voiceChannels,
} from './helpers.js';
import { t, tList } from '../i18n/index.js';
import { normalize } from '../text.js';
import { P, defineTool } from './registry.js';
import { riskyFlagsOf, riskyLabels } from './roles.js';

/** Channel permission target: everyone (@everyone), a role or a single person. */
/**
 * Resolves "who" a permission applies to: everyone, a role, or a member.
 *
 * Exact matches are tried FIRST across both kinds. Role matching is fuzzy (similarity >= 0.7), so
 * searching roles before members used to let a person's name land on an unrelated role -- "Ali" would
 * match a role called "Kalite" and the permission would be applied to the wrong target.
 */
async function resolvePermissionTarget(deps, rawTarget, kind) {
	const text = String(rawTarget ?? '').trim();
	const key = normalize(text);
	const everyone = deps.guild.roles?.everyone ?? null;
	if (kind === 'everyone' || (!kind && (PERMISSION_EVERYONE_WORDS.includes(key) || key.startsWith('everyone')))) {
		return everyone ? { target: everyone, label: t('tools.channels.target_everyone'), type: 'everyone' } : null;
	}
	const asRole = (role, exact) => ({ target: role, label: t('tools.channels.target_role', { role: role.name }), type: 'role', exact });
	const asMember = (member, exact) => ({
		target: member,
		label: t('tools.channels.target_member', { name: displayName(member) }),
		type: 'member',
		exact,
	});

	const exactRole = kind === 'member' ? null : [...(deps.guild.roles?.cache?.values() ?? [])].find((role) => normalize(role.name) === key);
	if (exactRole) return asRole(exactRole, true);
	const found = kind === 'role' ? null : await findMemberDetailed(deps, text);
	if (found?.member && found.exact !== false) return asMember(found.member, true);

	if (kind !== 'member') {
		const role = resolveRole(deps, text);
		if (role) return asRole(role, false);
	}
	if (found?.member) return asMember(found.member, false);
	return null;
}

/**
 * Resolves the `parent` argument of edit_channel: a category, or an explicit "no category".
 * @returns {{ parent: object|null }|{ error: string }|null} null = the argument was not given
 */
function resolveParentArgument(deps, raw) {
	if (raw === undefined || raw === null) return null;
	const text = String(raw).trim();
	if (!text) return null;
	const key = normalize(text);
	if (!key || tList('keywords.no_category_words').includes(key)) return { parent: null };
	const found = resolveAnyChannel(deps, text);
	if (!found) return { error: t('tools.channels.category_not_found', { name: text }) };
	if (found.type !== ChannelType.GuildCategory) return { error: t('tools.channels.not_a_category', { name: found.name }) };
	return { parent: found };
}

export const tools = [
	defineTool({
		name: 'create_channel',
		description: 'Creates a new channel (text, voice or category). Owner only.',
		parameters: P.obj(
			{
				name: P.str('Channel name'),
				type: { type: 'string', enum: ['text', 'voice', 'category'], description: 'Channel type (default: text)' },
				parent: P.str('Category name (optional)'),
				topic: P.str('Channel topic (for text channels)'),
			},
			['name'],
		),
		gate: { keywords: WORDS.channel },
		async handler(args, deps) {
			const kind = String(args.type ?? 'text').toLowerCase();
			const type =
				kind === 'voice' ? ChannelType.GuildVoice : kind === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText;
			const parent = args.parent ? resolveAnyChannel(deps, String(args.parent)) : null;
			try {
				const channel = await deps.guild.channels.create({
					name: String(args.name ?? '').trim().slice(0, 90) || t('tools.channels.default_name'),
					type,
					...(parent && parent.type === ChannelType.GuildCategory ? { parent: parent.id } : {}),
					...(args.topic && type === ChannelType.GuildText ? { topic: String(args.topic).slice(0, 1024) } : {}),
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.channels.log_created', { channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.channels.created', { channel: channel.name }),
					data: { id: channel.id, name: channel.name },
				};
			} catch (err) {
				return failure(deps, 'channel creation failed', err, t('tools.channels.create_failed'));
			}
		},
	}),

	defineTool({
		name: 'edit_channel',
		description:
			'Edits a channel or a category: rename it, change its topic, slowmode, user limit or NSFW flag, move it into ' +
			'another category (parent), reorder it (position), or make it inherit the category permissions ' +
			'(sync_permissions). Use this for "move this channel under that category", "drag it to the top" and ' +
			'"rename the channel". Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Channel or category name'),
				name: P.str('New name'),
				topic: P.str('New topic'),
				slowmode_seconds: P.int('Slowmode (seconds; 0 = off)'),
				user_limit: P.int('User limit in a voice channel (0 = unlimited)'),
				nsfw: P.bool('NSFW flag'),
				parent: P.str('Category to move the channel into; a word meaning "none" moves it out of every category'),
				position: P.int('New position inside the category: 0 puts it first, a large number such as 99 puts it last'),
				sync_permissions: P.bool('true = drop the channel\'s own permissions and follow its category'),
			},
			['channel'],
		),
		gate: { keywords: WORDS.channel },
		async handler(args, deps) {
			const channel = resolveAnyChannel(deps, String(args.channel ?? ''));
			if (!channel) return { ok: false, spoken: t('tools.channels.not_found', { name: args.channel }) };
			const patch = {};
			if (args.name) patch.name = String(args.name).trim().slice(0, 90);
			if (args.topic !== undefined) patch.topic = String(args.topic).slice(0, 1024);
			if (Number.isFinite(Number(args.slowmode_seconds))) {
				patch.rateLimitPerUser = Math.max(0, Math.min(21_600, Math.round(Number(args.slowmode_seconds))));
			}
			if (Number.isFinite(Number(args.user_limit))) {
				patch.userLimit = Math.max(0, Math.min(99, Math.round(Number(args.user_limit))));
			}
			if (typeof args.nsfw === 'boolean') patch.nsfw = args.nsfw;

			const parentArg = resolveParentArgument(deps, args.parent);
			if (parentArg?.error) return { ok: false, spoken: parentArg.error };
			if (parentArg && channel.type === ChannelType.GuildCategory) {
				return { ok: false, spoken: t('tools.channels.category_has_no_parent', { channel: channel.name }) };
			}
			const position = Number.isFinite(Number(args.position)) ? Math.max(0, Math.round(Number(args.position))) : null;
			const sync = args.sync_permissions === true;
			if (!Object.keys(patch).length && !parentArg && position === null && !sync) {
				return { ok: false, spoken: t('tools.channels.nothing_to_change') };
			}
			const reason = t('tools.helpers.audit_reason');
			const done = [];
			try {
				if (Object.keys(patch).length) {
					await channel.edit({ ...patch, reason });
					if (patch.name) done.push(t('tools.channels.part_renamed', { name: patch.name }));
				}
				// Moving and reordering are their own endpoints in Discord, so they are applied separately;
				// setParent carries the "inherit the category permissions" flag with it.
				if (parentArg) {
					await channel.setParent(parentArg.parent, { lockPermissions: sync, reason });
					done.push(
						parentArg.parent
							? t('tools.channels.part_moved', { category: parentArg.parent.name })
							: t('tools.channels.part_detached'),
					);
				}
				if (position !== null) {
					await channel.setPosition(position, { reason });
					done.push(t('tools.channels.part_positioned', { position }));
				}
				if (sync && !parentArg) {
					if (!channel.parent) return { ok: false, spoken: t('tools.channels.no_category_to_sync', { channel: channel.name }) };
					await channel.lockPermissions();
					done.push(t('tools.channels.part_synced', { category: channel.parent.name }));
				}
				const summary = done.length ? `${channel.name}: ${done.join(', ')}` : channel.name;
				deps.log?.(t('tools.channels.log_edited', { channel: summary }));
				return {
					ok: true,
					spoken: done.length
						? t('tools.channels.edited_details', { channel: channel.name, details: done.join(', ') })
						: t('tools.channels.edited', { channel: channel.name }),
					data: { id: channel.id, changes: patch, parent: parentArg ? (parentArg.parent?.name ?? null) : undefined, position, synced: sync },
				};
			} catch (err) {
				// Renaming, moving and reordering are separate API calls, so an error can arrive with some of
				// them already applied. Saying only "it failed" would send the speaker looking for a change
				// that did happen, so what went through is reported alongside the failure.
				if (done.length) {
					return failure(deps, 'channel edit partly failed', err, t('tools.channels.edit_partial', { details: done.join(', ') }));
				}
				return failure(deps, 'channel edit failed', err, t('tools.channels.edit_failed'));
			}
		},
	}),

	defineTool({
		name: 'delete_channel',
		description: 'Deletes a channel. Owner only; two-step (asks first, deletes with confirm:true).',
		parameters: P.obj({ channel: P.str('Channel name'), reason: P.str('Reason (optional)'), confirm: P.confirm() }, ['channel']),
		// The verb, not the thing: "channel" or "room" in passing must not be what opens a deletion.
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const channel = resolveAnyChannel(deps, String(args.channel ?? ''));
			if (!channel) return { ok: false, spoken: t('tools.channels.not_found', { name: args.channel }) };
			const decision = checkConfirmation(deps, {
				key: name,
				target: channel.id,
				confirm: args.confirm,
				question: t('tools.channels.delete_question', { channel: channel.name }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { channel: channel.name });
			if (decision.stale) return STALE_CONFIRMATION();
			try {
				const channelName = channel.name;
				await channel.delete(args.reason ? String(args.reason).slice(0, 400) : t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.channels.log_deleted', { channel: channelName }));
				return { ok: true, spoken: t('tools.channels.deleted', { channel: channelName }), data: { name: channelName } };
			} catch (err) {
				return failure(deps, 'channel deletion failed', err, t('tools.channels.delete_failed'));
			}
		},
	}),

	defineTool({
		name: 'lock_channel',
		description:
			'Locks or unlocks a channel (everyone\'s permission to write). Unlocking only restores the write permission; the channel\'s other restrictions are kept. Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Channel name'),
				locked: P.bool('true = lock (default), false = unlock'),
			},
			['channel'],
		),
		gate: { keywords: WORDS.channel },
		async handler(args, deps) {
			const channel = resolveAnyChannel(deps, String(args.channel ?? ''));
			const everyone = deps.guild.roles?.everyone;
			if (!channel) return { ok: false, spoken: t('tools.channels.not_found', { name: args.channel }) };
			if (!everyone) return { ok: false, spoken: t('tools.channels.no_roles') };
			const locked = args.locked !== false;
			try {
				// While unlocking we do NOT delete the overwrite: a hidden channel must not lose restrictions such
				// as ViewChannel:false; only the SendMessages field is neutralised.
				await channel.permissionOverwrites.edit(
					everyone,
					{ SendMessages: locked ? false : null },
					{ reason: t('tools.helpers.audit_reason') },
				);
				deps.log?.(t(locked ? 'tools.channels.log_locked' : 'tools.channels.log_unlocked', { channel: channel.name }));
				return {
					ok: true,
					spoken: locked ? t('tools.channels.locked', { channel: channel.name }) : t('tools.channels.unlocked', { channel: channel.name }),
					data: { id: channel.id, locked },
				};
			} catch (err) {
				return failure(deps, 'channel lock unchanged', err, t('tools.channels.lock_failed'));
			}
		},
	}),

	defineTool({
		name: 'set_channel_permission',
		description:
			'Turns permissions on, off or back to default for a role / person / everyone in a channel (channel permission overwrite: view, connect, speak, write…). ' +
			'For "only role X may join this room" use target=X, allow=["connect","view"], only=true (the same permissions are turned off for everyone). ' +
			'For "X must not see this channel" use target=X, deny=["view"]. Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Channel name (may also be a category)'),
				target: P.str('Role name, person name or "everyone"'),
				target_type: { type: 'string', enum: ['role', 'member', 'everyone'], description: 'Target kind (when empty: everyone / role / person are tried in that order)' },
				allow: P.list(`Permissions to turn on: ${PERMISSION_HELP}`),
				deny: P.list('Permissions to turn off (same names)'),
				reset: P.bool('true = put the given permissions back to default for the target; with no permission given, drop every custom permission the target has in this channel (for everyone a permission list is required)'),
				only: P.bool('true = "only this target": the permissions in the allow list are turned off for everyone (@everyone)'),
			},
			['channel', 'target'],
		),
		gate: { keywords: WORDS.permission },
		async handler(args, deps) {
			const channel = resolveAnyChannel(deps, String(args.channel ?? ''));
			if (!channel) return { ok: false, spoken: t('tools.channels.not_found', { name: args.channel }) };
			if (!channel.permissionOverwrites) return { ok: false, spoken: t('tools.channels.permissions_unavailable', { channel: channel.name }) };
			const resolved = await resolvePermissionTarget(deps, args.target, args.target_type ? String(args.target_type) : null);
			if (!resolved) return { ok: false, spoken: t('tools.channels.target_not_found', { name: args.target }) };
			const { target, label, type } = resolved;
			const allow = parsePermissions(args.allow);
			const deny = parsePermissions(args.deny);
			const unknown = [...allow.unknown, ...deny.unknown];
			if (unknown.length) {
				return { ok: false, spoken: t('tools.channels.unknown_permissions', { unknown: unknown.join(', '), help: PERMISSION_HELP }) };
			}
			const reset = args.reset === true;
			// A moderator's powers in this channel (Manage Messages, Move Members, Mention @everyone...) given
			// to a person or a role are a moderator role by another road, and grant_role refuses those by
			// voice (RISKY_ROLE_PERMISSIONS in roles.js). Taking them away, or putting them back to default,
			// is still fine.
			const risky = reset ? [] : riskyFlagsOf(allow.flags);
			if (risky.length) {
				const permissions = riskyLabels(risky);
				deps.log?.(t('tools.channels.log_risky_permission_refused', { channel: channel.name, target: label, permissions }));
				const reason = t('tools.helpers.gate_reason_risky_permission', { permissions });
				const tool = 'set_channel_permission';
				noteGate(deps, t('tools.helpers.gate_denied_activity', { tool, reason }), { tool, result: 'denied', reason, code: 'risky_permission' });
				return { ok: false, denied: true, spoken: t('tools.channels.risky_permission', { permissions }) };
			}
			const touched = [...new Set([...allow.flags, ...deny.flags])];
			const reason = t('tools.helpers.audit_reason');
			try {
				if (reset && !touched.length) {
					if (type === 'everyone') {
						return { ok: false, spoken: t('tools.channels.reset_everyone_blocked') };
					}
					await channel.permissionOverwrites.delete(target.id, reason);
					deps.log?.(t('tools.channels.log_permissions_reset', { channel: channel.name, target: label }));
					return {
						ok: true,
						spoken: t('tools.channels.permissions_reset', { channel: channel.name, target: label }),
						data: { channel: channel.name, target: label, type, reset: true },
					};
				}
				if (!touched.length) return { ok: false, spoken: t('tools.channels.which_permission') };
				// The bot can only turn permissions it holds itself on and off; check first so the reason is spoken
				// instead of surfacing an API error.
				const me = deps.guild.members?.me ?? null;
				const mine = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
				if (mine?.has && !mine.has(PermissionFlagsBits.ManageRoles) && !mine.has(PermissionFlagsBits.Administrator)) {
					return { ok: false, spoken: t('tools.channels.no_manage_roles', { channel: channel.name }) };
				}
				// Discord allows a bot to grant or deny only the permissions it holds AT GUILD OR PARENT level --
				// not the ones left after this channel's own overwrites. Checking the channel's effective set would
				// refuse legitimate edits in a channel the bot has deliberately restricted for itself.
				const reference = me?.permissions?.has ? me.permissions : mine;
				const parentPerms = channel.parent && typeof channel.parent.permissionsFor === 'function' ? channel.parent.permissionsFor(me) : null;
				const holds = (flag) =>
					Boolean(reference?.has?.(PermissionFlagsBits[flag])) || Boolean(parentPerms?.has?.(PermissionFlagsBits[flag]));
				if (reference?.has && !reference.has(PermissionFlagsBits.Administrator)) {
					const missing = touched.filter((flag) => PermissionFlagsBits[flag] !== undefined && !holds(flag));
					if (missing.length) {
						return { ok: false, spoken: t('tools.channels.missing_own_permission', { permissions: permissionLabels(missing) }) };
					}
				}
				const patch = {};
				for (const flag of allow.flags) patch[flag] = reset ? null : true;
				for (const flag of deny.flags) patch[flag] = reset ? null : false; // if the same permission is in both lists, denying wins
				// "only this target": the bot has to keep its own access FIRST. Once @everyone loses ViewChannel,
				// Discord implicitly denies everything else in the channel, and the bot could no longer edit it.
				const exclusive = args.only === true && !reset && allow.flags.length && type !== 'everyone' && deps.guild.roles?.everyone;
				if (exclusive && me && !(mine?.has && mine.has(PermissionFlagsBits.Administrator))) {
					const selfPatch = {};
					for (const flag of allow.flags) selfPatch[flag] = true;
					await channel.permissionOverwrites.edit(me, selfPatch, { reason: t('tools.channels.self_access_reason', { reason }) });
				}
				await channel.permissionOverwrites.edit(target, patch, { reason });
				const parts = [];
				if (reset) parts.push(t('tools.channels.part_reset', { target: label, permissions: permissionLabels(touched) }));
				else {
					if (allow.flags.length) parts.push(t('tools.channels.part_allow', { target: label, permissions: permissionLabels(allow.flags) }));
					if (deny.flags.length) {
						parts.push(
							t('tools.channels.part_deny', {
								target: label,
								permissions: permissionLabels(deny.flags.filter((f) => !allow.flags.includes(f))),
							}),
						);
					}
				}
				if (exclusive) {
					const everyonePatch = {};
					for (const flag of allow.flags) everyonePatch[flag] = false;
					await channel.permissionOverwrites.edit(deps.guild.roles.everyone, everyonePatch, { reason });
					parts.push(t('tools.channels.part_everyone_deny', { permissions: permissionLabels(allow.flags) }));
				}
				deps.log?.(t('tools.channels.log_permissions_set', { channel: channel.name, target: label, parts: parts.join('; ') }));
				return {
					ok: true,
					spoken: t('tools.channels.permissions_set', { channel: channel.name, parts: parts.join('; ') }),
					data: { channel: channel.name, target: label, type, allow: allow.flags, deny: deny.flags, reset, only: args.only === true },
				};
			} catch (err) {
				return failure(deps, 'channel permission unchanged', err, t('tools.channels.permission_failed', { channel: channel.name }));
			}
		},
	}),

	defineTool({
		name: 'create_invite',
		description: 'Creates an invite link for a channel. Owner only.',
		parameters: P.obj({
			channel: P.str('Channel name (when empty: the default text channel)'),
			max_age_minutes: P.int('How many minutes it stays valid (0 = never expires)'),
			max_uses: P.int('How many times it can be used (0 = unlimited)'),
		}),
		gate: { keywords: WORDS.invite },
		async handler(args, deps) {
			const channel = resolveTextChannel(deps, args.channel ? String(args.channel) : null);
			if (!channel) return { ok: false, spoken: t('tools.channels.invite_channel_not_found') };
			try {
				const invite = await channel.createInvite({
					maxAge: Math.max(0, Math.min(604_800, Math.round(Number(args.max_age_minutes ?? 0) * 60))),
					maxUses: Math.max(0, Math.min(100, Math.round(Number(args.max_uses ?? 0)))),
					unique: true,
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.channels.log_invite', { code: invite.code }));
				return {
					ok: true,
					spoken: t('tools.channels.invite_ready', { url: invite.url }),
					data: { code: invite.code, url: invite.url },
				};
			} catch (err) {
				return failure(deps, 'invite creation failed', err, t('tools.channels.invite_failed'));
			}
		},
	}),

	defineTool({
		name: 'list_channels',
		description: 'Lists the categories, text channels and voice channels on the server, and which category each one sits in.',
		async handler(args, deps) {
			const text = textChannels(deps).map((c) => c.name);
			const voice = voiceChannels(deps).map((c) => c.name);
			const categories = [...deps.guild.channels.cache.values()]
				.filter((c) => c.type === ChannelType.GuildCategory)
				.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
				.map((category) => ({
					name: category.name,
					channels: [...deps.guild.channels.cache.values()]
						.filter((c) => c.parentId === category.id)
						.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
						.map((c) => c.name),
				}));
			return {
				ok: true,
				spoken: categories.length
					? t('tools.channels.list_with_categories', {
							text: text.join(', '),
							voice: voice.join(', '),
							categories: categories.map((c) => `${c.name} (${c.channels.join(', ') || '-'})`).join('; '),
						})
					: t('tools.channels.list', { text: text.join(', '), voice: voice.join(', ') }),
				data: { text, voice, categories },
			};
		},
	}),

	defineTool({
		name: 'server_info',
		description: 'Gives a summary of the server: member count, channel count, boosts, creation date, owner.',
		async handler(args, deps) {
			const boost = deps.guild.premiumSubscriptionCount ?? 0;
			return {
				ok: true,
				spoken: t('tools.channels.server_info', {
					name: deps.guild.name,
					members: deps.guild.memberCount,
					textChannels: textChannels(deps).length,
					voiceChannels: voiceChannels(deps).length,
					boosts: boost,
				}),
				data: {
					name: deps.guild.name,
					members: deps.guild.memberCount,
					textChannels: textChannels(deps).length,
					voiceChannels: voiceChannels(deps).length,
					boosts: boost,
					createdOn: trDate(deps.guild.createdAt),
					ownerId: deps.guild.ownerId ?? null,
				},
			};
		},
	}),
];
