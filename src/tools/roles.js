// Role tools: create, edit, delete (confirmed), grant/revoke, list.

import { t, tRaw } from '../i18n/index.js';
import { normalize } from '../text.js';
import {
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	displayName,
	failure,
	findMember,
	parseColor,
	resolveRole,
} from './helpers.js';
import { P, defineTool } from './registry.js';

/**
 * Permissions that make a role a key to the server rather than a label on a member: running it,
 * handing out roles or channels, removing people, and reaching everybody at once. A role carrying any
 * of them is not handed out by voice at all. The owner gate proves who said the command word, and a
 * spoken confirmation proves what was heard, but both rest on the same audio: if that audio can be
 * fooled once it can be fooled twice, and what is lost here is the server itself. Giving such a role
 * takes a click in Discord, where the person doing it is who they say they are.
 *
 * Moderating voice (moving, muting, deafening people), renaming them, managing threads, events and the
 * server's emojis and stickers, and reading the audit log are the powers of a moderator role too, and a
 * "voice mod" role carrying only those used to go out like any other. The same list stands in front of
 * a channel permission given to a person or a role (set_channel_permission), which is the other way to
 * hand these out: Manage Messages in one channel is the moderator's delete button there.
 */
export const RISKY_ROLE_PERMISSIONS = [
	'Administrator',
	'ManageGuild',
	'ManageRoles',
	'ManageChannels',
	'ManageWebhooks',
	'BanMembers',
	'KickMembers',
	'ModerateMembers',
	'MentionEveryone',
	'ManageMessages',
	'MoveMembers',
	'MuteMembers',
	'DeafenMembers',
	'ManageNicknames',
	'ManageThreads',
	'ManageEvents',
	'ManageGuildExpressions',
	'ViewAuditLog',
];

/** The flags of this list (PermissionFlagsBits keys) that are on the risky list, in the list's order. */
export function riskyFlagsOf(flags) {
	const given = new Set(flags ?? []);
	return RISKY_ROLE_PERMISSIONS.filter((flag) => given.has(flag));
}

/** The risky permissions this role carries, by flag name (none when it carries no permission data). */
export function riskyPermissionsOf(role) {
	const permissions = role?.permissions;
	if (typeof permissions?.has !== 'function') return [];
	return RISKY_ROLE_PERMISSIONS.filter((flag) => {
		try {
			// checkAdmin off: an Administrator role is reported as Administrator, not as all ten.
			return Boolean(permissions.has(PermissionFlagsBits[flag], false));
		} catch {
			return false;
		}
	});
}

/** The risky permissions as they are said out loud. */
export function riskyLabels(flags) {
	const names = tRaw('tools.roles.risky_permission_names') ?? {};
	return flags.map((flag) => names[flag] ?? flag).join(', ');
}

/**
 * Did the owner name this role in their own words? A role found only approximately is asked about, and
 * "approximately" used to be judged against `args.role`, which the model writes: the owner says "give
 * Ali mod", the model writes "Moderator", and the question was never put. So the role's name is looked
 * for in what the owner actually said in this request, word by word. In a language that glues its case
 * endings on (the locale has no word_forms) the last word may carry one ("moderatoru ver"); elsewhere
 * only a plural "s", so a transcript's "chillz" is still a guess at "Chill". Without a record of speech
 * (no attribution, a test) the argument is all there is.
 */
function roleNamedByOwner(deps, role, asked) {
	const wanted = normalize(role?.name ?? '').split(' ').filter(Boolean);
	if (!wanted.length) return false;
	if (typeof deps.ownerUtterance !== 'function') return normalize(role.name) === normalize(asked);
	const opts = typeof deps.currentTurn === 'function' ? { turn: deps.currentTurn() ?? null } : {};
	const said = normalize(deps.ownerUtterance(opts)?.text ?? '').split(' ').filter(Boolean);
	const suffixing = !tRaw('keywords.word_forms');
	const last = (heard, word) => heard === word || heard === `${word}s` || (suffixing && heard.startsWith(word));
	for (let start = 0; start + wanted.length <= said.length; start++) {
		const fits = wanted.every((word, k) => (k === wanted.length - 1 ? last(said[start + k], word) : said[start + k] === word));
		if (fits) return true;
	}
	return false;
}

async function grantOrRevoke(args, deps, { name }) {
	const member = await findMember(deps, String(args.member ?? ''));
	const role = resolveRole(deps, String(args.role ?? ''));
	if (!member) return { ok: false, spoken: t('tools.roles.member_not_found', { name: args.member }) };
	if (!role) return { ok: false, spoken: t('tools.roles.role_not_found', { name: args.role }) };
	if (role.managed) {
		// Bot/integration roles cannot be assigned by hand; do not make it look like a hierarchy error.
		return { ok: false, spoken: t('tools.roles.managed_role', { role: role.name }) };
	}
	const granting = name === 'grant_role';
	if (granting) {
		const risky = riskyPermissionsOf(role);
		if (risky.length) {
			const permissions = riskyLabels(risky);
			deps.log?.(t('tools.roles.log_risky_refused', { role: role.name, permissions }));
			return { ok: false, denied: true, spoken: t('tools.roles.risky_role', { role: role.name, permissions }) };
		}
	}
	const me = deps.guild.members.me;
	const highest = me?.roles?.highest;
	const isSelf = Boolean(me?.id) && member.id === me.id;
	const who = displayName(member);
	if (me?.permissions?.has && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
		return { ok: false, spoken: t('tools.roles.no_manage_roles') };
	}
	// Granting a role depends only on the ROLE's position (Discord: you may assign any role below your
	// own highest one). The target's own position, or being the guild owner, is NOT a blocker here --
	// unlike kick/ban/nickname. discord.js always reports `manageable: false` for the bot's own member,
	// so the hierarchy is computed from positions instead.
	const canManageRole = highest && Number.isFinite(role.position) ? highest.position > role.position : role.editable !== false;
	if (!canManageRole) {
		return {
			ok: false,
			spoken: t('tools.roles.role_above_me', {
				role: role.name,
				mine: highest?.name ?? '?',
				rolePosition: Number.isFinite(role.position) ? role.position : '?',
				myPosition: highest?.position ?? '?',
			}),
		};
	}
	// A role that only matched approximately ("mod" for "Moderator", a transcript's "chillz" for "Chill")
	// is a guess at what the owner meant, and a wrong role is access the member keeps until somebody
	// notices. The role that was found is named out loud, and the grant waits for a yes, unless the owner
	// said its name themselves (roleNamedByOwner).
	if (granting && !roleNamedByOwner(deps, role, args.role)) {
		// The model may have written the role's exact name for a word the owner said differently; then
		// there is no "closest match" to talk about, only a name the owner did not say.
		const exact = normalize(role.name) === normalize(args.role);
		const decision = checkConfirmation(deps, {
			key: name,
			target: `${member.id}:${role.id}`,
			confirm: args.confirm,
			question: exact
				? t('tools.roles.unheard_role_question', { role: role.name, who })
				: t('tools.roles.fuzzy_role_question', { name: String(args.role ?? ''), role: role.name, who }),
		});
		if (decision.ask) return askConfirmation(decision.ask, { member: who, role: role.name, fuzzy: true });
	}
	try {
		if (granting) {
			await member.roles.add(role, t('tools.helpers.audit_reason'));
			deps.log?.(t('tools.roles.log_granted', { who, role: role.name }));
			return {
				ok: true,
				spoken: isSelf ? t('tools.roles.granted_self', { role: role.name }) : t('tools.roles.granted', { who, role: role.name }),
				data: { member: who, role: role.name },
			};
		}
		await member.roles.remove(role, t('tools.helpers.audit_reason'));
		deps.log?.(t('tools.roles.log_revoked', { who, role: role.name }));
		return {
			ok: true,
			spoken: isSelf ? t('tools.roles.revoked_self', { role: role.name }) : t('tools.roles.revoked', { who, role: role.name }),
			data: { member: who, role: role.name },
		};
	} catch (err) {
		return failure(deps, 'role update failed', err, t('tools.roles.update_failed'));
	}
}

export const tools = [
	defineTool({
		name: 'grant_role',
		description:
			'Gives a role to a member. Owner only. A role carrying moderation or administration permissions cannot be given by voice; ' +
			'a role name that only matched approximately is two-step (asks first, gives it with confirm:true).',
		parameters: P.obj({ member: P.str('Member name'), role: P.str('Role name'), confirm: P.confirm() }, ['member', 'role']),
		gate: { keywords: WORDS.role },
		handler: grantOrRevoke,
	}),
	defineTool({
		name: 'revoke_role',
		description: 'Takes a role away from a member. Owner only.',
		parameters: P.obj({ member: P.str('Member name'), role: P.str('Role name') }, ['member', 'role']),
		gate: { keywords: WORDS.role },
		handler: grantOrRevoke,
	}),

	defineTool({
		name: 'create_role',
		description: 'Creates a new role. Owner only.',
		parameters: P.obj(
			{
				name: P.str('Role name'),
				color: P.str('Colour (e.g. #ff8800 or a colour name)'),
				hoist: P.bool('Show members separately'),
				mentionable: P.bool('Allow the role to be mentioned'),
			},
			['name'],
		),
		gate: { keywords: WORDS.role },
		async handler(args, deps) {
			try {
				const color = parseColor(args.color);
				const role = await deps.guild.roles.create({
					name: String(args.name ?? '').trim().slice(0, 100) || t('tools.roles.default_name'),
					...(color === null ? {} : { color }),
					...(typeof args.hoist === 'boolean' ? { hoist: args.hoist } : {}),
					...(typeof args.mentionable === 'boolean' ? { mentionable: args.mentionable } : {}),
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.roles.log_created', { role: role.name }));
				return { ok: true, spoken: t('tools.roles.created', { role: role.name }), data: { id: role.id, name: role.name } };
			} catch (err) {
				return failure(deps, 'role creation failed', err, t('tools.roles.create_failed'));
			}
		},
	}),

	defineTool({
		name: 'edit_role',
		description: 'Edits an existing role: name, colour, hoist, mentionable. Owner only.',
		parameters: P.obj(
			{
				role: P.str('Role name'),
				name: P.str('New name'),
				color: P.str('New colour'),
				hoist: P.bool('Show members separately'),
				mentionable: P.bool('Allow the role to be mentioned'),
			},
			['role'],
		),
		gate: { keywords: WORDS.role },
		async handler(args, deps) {
			const role = resolveRole(deps, String(args.role ?? ''));
			if (!role) return { ok: false, spoken: t('tools.roles.role_not_found', { name: args.role }) };
			if (role.managed) return { ok: false, spoken: t('tools.roles.managed_role_edit', { role: role.name }) };
			const patch = {};
			if (args.name) patch.name = String(args.name).trim().slice(0, 100);
			const color = parseColor(args.color);
			if (color !== null) patch.color = color;
			if (typeof args.hoist === 'boolean') patch.hoist = args.hoist;
			if (typeof args.mentionable === 'boolean') patch.mentionable = args.mentionable;
			if (!Object.keys(patch).length) return { ok: false, spoken: t('tools.roles.nothing_to_change') };
			try {
				await role.edit({ ...patch, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.roles.log_edited', { role: role.name }));
				return { ok: true, spoken: t('tools.roles.edited', { role: role.name }), data: { id: role.id, changes: patch } };
			} catch (err) {
				return failure(deps, 'role edit failed', err, t('tools.roles.edit_failed'));
			}
		},
	}),

	defineTool({
		name: 'delete_role',
		description: 'Deletes a role. Owner only; two-step (asks first, deletes with confirm:true).',
		parameters: P.obj({ role: P.str('Role name'), reason: P.str('Reason (optional)'), confirm: P.confirm() }, ['role']),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const role = resolveRole(deps, String(args.role ?? ''));
			if (!role) return { ok: false, spoken: t('tools.roles.role_not_found', { name: args.role }) };
			if (role.managed) return { ok: false, spoken: t('tools.roles.managed_role_delete', { role: role.name }) };
			const decision = checkConfirmation(deps, {
				key: name,
				target: role.id,
				confirm: args.confirm,
				question: t('tools.roles.delete_question', { role: role.name }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { role: role.name });
			if (decision.stale) return STALE_CONFIRMATION();
			try {
				const roleName = role.name;
				await role.delete(args.reason ? String(args.reason).slice(0, 400) : t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.roles.log_deleted', { role: roleName }));
				return { ok: true, spoken: t('tools.roles.deleted', { role: roleName }), data: { name: roleName } };
			} catch (err) {
				return failure(deps, 'role deletion failed', err, t('tools.roles.delete_failed'));
			}
		},
	}),

	defineTool({
		name: 'list_roles',
		description: 'Lists the roles on the server.',
		async handler(args, deps) {
			const roles = [...deps.guild.roles.cache.values()]
				.filter((role) => role.name !== '@everyone')
				.sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
				.map((role) => role.name);
			deps.log?.(t('tools.roles.log_listed', { count: roles.length, sample: roles.slice(0, 10).join(', ') }));
			return {
				ok: true,
				spoken: roles.length ? t('tools.roles.list', { roles: roles.slice(0, 25).join(', ') }) : t('tools.roles.list_empty'),
				data: { roles },
			};
		},
	}),
];
