// Webhook tools: list, create, rename, delete (two-step) and handing the address to the owner by DM.
//
// A webhook URL is a CREDENTIAL: it carries the webhook token, and anyone holding it can post into that
// channel under that name forever, with no bot, no account and no permission check. Nothing in this
// module puts the token or the URL into `spoken`, into `data`, into a log line or into an activity
// event -- the single way one leaves here is a direct message to the bot owner (send_webhook_url).

import { WebhookType } from 'discord.js';
import {
	ChannelType,
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	failure,
	findMember,
	resolveAnyChannel,
	trDate,
} from './helpers.js';
import { t } from '../i18n/index.js';
import { normalize } from '../text.js';
import { P, defineTool } from './registry.js';

// Channel kinds that can hold a webhook. A category, a thread or a DM cannot: Discord has no webhook
// endpoint for them (a thread is posted into through its parent channel's webhook and a thread_id).
const WEBHOOK_CHANNEL_TYPES = new Set([
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildVoice,
	ChannelType.GuildStageVoice,
	ChannelType.GuildForum,
	ChannelType.GuildMedia,
]);

// Discord's own limits: at most 15 webhooks in one channel (error 30007) and a name of 1-80 characters
// that may not contain "clyde" or "discord" (rejected as error 50035). Checking them here turns a raw
// API error into a sentence the owner can act on.
const MAX_PER_CHANNEL = 15;
const MAX_NAME_LENGTH = 80;
const RESERVED_NAME = /clyde|discord/i;

// How many webhooks are read out before the sentence is cut short; `data` always carries all of them.
const SPOKEN_LIMIT = 10;

/** Machine-readable webhook kind for `data` (the model reads this, it is not said out loud). */
function kindOf(hook) {
	if (hook.type === WebhookType.ChannelFollower) return 'channel_follower';
	if (hook.type === WebhookType.Application) return 'application';
	return 'incoming';
}

/** Name of the channel a webhook posts into; the cache is the only place a name can come from. */
function channelNameOf(deps, hook) {
	const cached = deps.guild.channels?.cache?.get(hook.channelId) ?? null;
	return cached?.name ?? hook.channel?.name ?? t('tools.webhooks.channel_unknown');
}

/** Who created the webhook. `owner` is a User, or the raw API user when that user is not cached. */
function creatorOf(hook) {
	const owner = hook.owner ?? null;
	if (!owner) return t('tools.webhooks.creator_unknown');
	return owner.displayName ?? owner.globalName ?? owner.global_name ?? owner.username ?? t('tools.webhooks.creator_unknown');
}

/**
 * The bot's own Manage Webhooks permission. Every webhook endpoint needs it, so it is checked before
 * the call and reported as a reason instead of surfacing "Missing Permissions".
 * @param {object|null} channel a channel, or null for the server-wide check (guild.fetchWebhooks)
 * @returns {string|null} the refusal to speak, or null when the permission is there
 */
function missingManageWebhooks(deps, channel) {
	const me = deps.guild.members?.me ?? null;
	if (!me) return null; // the bot's own member is not cached: let Discord answer
	const perms = channel && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : me.permissions;
	if (!perms?.has) return null;
	if (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageWebhooks)) return null;
	return channel ? t('tools.webhooks.no_permission_channel', { channel: channel.name }) : t('tools.webhooks.no_permission');
}

/** Resolves the channel argument and checks it can hold webhooks at all. */
function resolveWebhookChannel(deps, rawChannel) {
	const text = String(rawChannel ?? '').trim();
	if (!text) return { spoken: t('tools.webhooks.which_channel') };
	const channel = resolveAnyChannel(deps, text);
	if (!channel) return { spoken: t('tools.webhooks.channel_not_found', { name: text }) };
	if (!WEBHOOK_CHANNEL_TYPES.has(channel.type)) return { spoken: t('tools.webhooks.not_webhook_channel', { name: channel.name }) };
	const missing = missingManageWebhooks(deps, channel);
	if (missing) return { spoken: missing };
	return { channel };
}

/**
 * Every webhook of one channel, or of the whole server when no channel is named.
 * @returns {Promise<{channel: object|null, webhooks: object[]} | {spoken: string} | {err: Error}>}
 */
async function collectWebhooks(deps, rawChannel) {
	const named = String(rawChannel ?? '').trim();
	try {
		if (named) {
			const found = resolveWebhookChannel(deps, named);
			if (found.spoken) return found;
			return { channel: found.channel, webhooks: [...(await found.channel.fetchWebhooks()).values()] };
		}
		const missing = missingManageWebhooks(deps, null);
		if (missing) return { spoken: missing };
		return { channel: null, webhooks: [...(await deps.guild.fetchWebhooks()).values()] };
	} catch (err) {
		return { err };
	}
}

/** Webhooks matching what was said: an id is exact, a name matches in full first and loosely after. */
function matchWebhooks(webhooks, needle) {
	const raw = String(needle ?? '').trim();
	const byId = webhooks.filter((hook) => hook.id === raw);
	if (byId.length) return byId;
	const key = normalize(raw);
	if (!key) return [];
	const exact = webhooks.filter((hook) => normalize(hook.name) === key);
	if (exact.length) return exact;
	return webhooks.filter((hook) => normalize(hook.name).includes(key));
}

/**
 * The one webhook the speaker meant. Two webhooks may carry the same name in different channels, so an
 * ambiguous answer is refused rather than guessed: renaming or deleting the wrong one is not undoable.
 * @returns {Promise<{hook: object, channelName: string} | {spoken: string} | {err: Error}>}
 */
async function resolveWebhook(deps, rawWebhook, rawChannel) {
	const found = await collectWebhooks(deps, rawChannel);
	if (found.spoken || found.err) return found;
	const needle = String(rawWebhook ?? '').trim();
	if (!needle) return { spoken: t('tools.webhooks.which_webhook') };
	const matches = matchWebhooks(found.webhooks, needle);
	if (!matches.length) {
		return {
			spoken: found.channel
				? t('tools.webhooks.not_found_in_channel', { name: needle, channel: found.channel.name })
				: t('tools.webhooks.not_found', { name: needle }),
		};
	}
	if (matches.length > 1) {
		const list = matches.map((hook) => t('tools.webhooks.ambiguous_entry', { name: hook.name, channel: channelNameOf(deps, hook) }));
		return { spoken: t('tools.webhooks.ambiguous', { name: needle, list: list.join(', ') }) };
	}
	return { hook: matches[0], channelName: channelNameOf(deps, matches[0]) };
}

/** Discord rejects an empty name, one over 80 characters, and anything containing "clyde"/"discord". */
function checkName(raw) {
	const name = String(raw ?? '').trim();
	if (!name) return { spoken: t('tools.webhooks.no_name') };
	if (name.length > MAX_NAME_LENGTH) return { spoken: t('tools.webhooks.name_too_long', { limit: MAX_NAME_LENGTH }) };
	if (RESERVED_NAME.test(name)) return { spoken: t('tools.webhooks.name_reserved') };
	return { name };
}

export const tools = [
	defineTool({
		name: 'list_webhooks',
		description:
			'Lists the webhooks of a channel, or of the whole server when no channel is given: the name, the channel each one posts ' +
			'into and who created it. The webhook address (URL) and token are a credential and are never returned. Needs the ' +
			'Manage Webhooks permission.',
		parameters: P.obj({ channel: P.str('Channel name (leave empty for the whole server)') }),
		async handler(args, deps) {
			const found = await collectWebhooks(deps, args.channel);
			if (found.spoken) return { ok: false, spoken: found.spoken };
			if (found.err) return failure(deps, 'webhook list failed', found.err, t('tools.webhooks.list_failed'));
			const channel = found.channel;
			const webhooks = found.webhooks.map((hook) => ({
				id: hook.id,
				name: hook.name,
				channel: channelNameOf(deps, hook),
				creator: creatorOf(hook),
				kind: kindOf(hook),
				created: trDate(hook.createdAt),
			}));
			if (!webhooks.length) {
				return {
					ok: true,
					spoken: channel ? t('tools.webhooks.none_in_channel', { channel: channel.name }) : t('tools.webhooks.none'),
					data: { channel: channel?.name ?? null, count: 0, webhooks: [] },
				};
			}
			const shown = webhooks
				.slice(0, SPOKEN_LIMIT)
				.map((hook) =>
					channel
						? t('tools.webhooks.entry_channel', { name: hook.name, creator: hook.creator })
						: t('tools.webhooks.entry_server', { name: hook.name, channel: hook.channel, creator: hook.creator }),
				);
			if (webhooks.length > shown.length) shown.push(t('tools.webhooks.and_more', { count: webhooks.length - shown.length }));
			const list = shown.join(', ');
			deps.log?.(
				channel
					? t('tools.webhooks.log_listed_channel', { channel: channel.name, count: webhooks.length })
					: t('tools.webhooks.log_listed_server', { count: webhooks.length }),
			);
			return {
				ok: true,
				spoken: channel ? t('tools.webhooks.list_channel', { channel: channel.name, list }) : t('tools.webhooks.list_server', { list }),
				data: { channel: channel?.name ?? null, count: webhooks.length, webhooks },
			};
		},
	}),

	defineTool({
		name: 'create_webhook',
		description:
			'Creates a webhook in a text, announcement, forum, media or voice channel. The name may be at most 80 characters and may ' +
			'not contain "discord" or "clyde". The address (URL) is deliberately NOT returned: ask send_webhook_url to send it to the ' +
			'owner by direct message. Needs the Manage Webhooks permission. Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Channel the webhook posts into'),
				name: P.str('Webhook name (1-80 characters)'),
			},
			['channel', 'name'],
		),
		gate: { keywords: WORDS.webhook },
		async handler(args, deps) {
			const target = resolveWebhookChannel(deps, args.channel);
			if (target.spoken) return { ok: false, spoken: target.spoken };
			const named = checkName(args.name);
			if (named.spoken) return { ok: false, spoken: named.spoken };
			const channel = target.channel;
			try {
				// The channel limit is read first: "that channel is full" is a reason somebody can act on,
				// where Discord's own answer is a bare error code.
				const existing = await channel.fetchWebhooks();
				if ((existing?.size ?? 0) >= MAX_PER_CHANNEL) {
					return { ok: false, spoken: t('tools.webhooks.channel_full', { channel: channel.name, limit: MAX_PER_CHANNEL }) };
				}
				const hook = await channel.createWebhook({ name: named.name, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.webhooks.log_created', { name: hook.name, channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.webhooks.created', { name: hook.name, channel: channel.name }),
					data: { id: hook.id, name: hook.name, channel: channel.name },
				};
			} catch (err) {
				return failure(deps, 'webhook creation failed', err, t('tools.webhooks.create_failed'));
			}
		},
	}),

	defineTool({
		name: 'rename_webhook',
		description:
			'Renames an existing webhook. Its address stays the same, so whatever posts through it keeps working. Name the channel too ' +
			'when two webhooks share a name. Needs the Manage Webhooks permission. Owner only.',
		parameters: P.obj(
			{
				webhook: P.str('Current webhook name (or its id)'),
				name: P.str('New name (1-80 characters)'),
				channel: P.str('Channel the webhook is in (optional; narrows the search)'),
			},
			['webhook', 'name'],
		),
		gate: { keywords: WORDS.webhook },
		async handler(args, deps) {
			const found = await resolveWebhook(deps, args.webhook, args.channel);
			if (found.spoken) return { ok: false, spoken: found.spoken };
			if (found.err) return failure(deps, 'webhook lookup failed', found.err, t('tools.webhooks.list_failed'));
			const named = checkName(args.name);
			if (named.spoken) return { ok: false, spoken: named.spoken };
			const previous = found.hook.name;
			if (normalize(previous) === normalize(named.name)) {
				return { ok: false, spoken: t('tools.webhooks.same_name', { name: previous }) };
			}
			try {
				await found.hook.edit({ name: named.name, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.webhooks.log_renamed', { old: previous, name: named.name }));
				return {
					ok: true,
					spoken: t('tools.webhooks.renamed', { old: previous, name: named.name }),
					data: { id: found.hook.id, name: named.name, previous_name: previous, channel: found.channelName },
				};
			} catch (err) {
				return failure(deps, 'webhook rename failed', err, t('tools.webhooks.rename_failed'));
			}
		},
	}),

	defineTool({
		name: 'delete_webhook',
		description:
			'Deletes a webhook. Everything posting through its address stops working and the address cannot be brought back. Needs the ' +
			'Manage Webhooks permission. Owner only; two-step (asks first, deletes with confirm:true).',
		parameters: P.obj(
			{
				webhook: P.str('Webhook name (or its id)'),
				channel: P.str('Channel the webhook is in (optional; narrows the search)'),
				confirm: P.confirm(),
			},
			['webhook'],
		),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const found = await resolveWebhook(deps, args.webhook, args.channel);
			if (found.spoken) return { ok: false, spoken: found.spoken };
			if (found.err) return failure(deps, 'webhook lookup failed', found.err, t('tools.webhooks.list_failed'));
			const hook = found.hook;
			const decision = checkConfirmation(deps, {
				key: name,
				target: hook.id,
				confirm: args.confirm,
				question: t('tools.webhooks.delete_question', { webhook: hook.name, channel: found.channelName }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { webhook: hook.name, channel: found.channelName });
			if (decision.stale) return STALE_CONFIRMATION();
			try {
				await hook.delete(t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.webhooks.log_deleted', { webhook: hook.name, channel: found.channelName }));
				return {
					ok: true,
					spoken: t('tools.webhooks.deleted', { webhook: hook.name, channel: found.channelName }),
					data: { id: hook.id, name: hook.name, channel: found.channelName },
				};
			} catch (err) {
				return failure(deps, 'webhook deletion failed', err, t('tools.webhooks.delete_failed'));
			}
		},
	}),

	defineTool({
		name: 'send_webhook_url',
		description:
			'Sends the address (URL) of a webhook to the bot owner as a direct message. The address carries the webhook token: anyone ' +
			'holding it can post into that channel as that webhook, so it is never spoken out loud and never handed back to you -- this ' +
			'tool only reports whether the direct message went through. Use it whenever the owner asks for a webhook link. Owner only.',
		parameters: P.obj(
			{
				webhook: P.str('Webhook name (or its id)'),
				channel: P.str('Channel the webhook is in (optional; narrows the search)'),
			},
			['webhook'],
		),
		gate: { keywords: WORDS.webhook },
		async handler(args, deps) {
			const found = await resolveWebhook(deps, args.webhook, args.channel);
			if (found.spoken) return { ok: false, spoken: found.spoken };
			if (found.err) return failure(deps, 'webhook lookup failed', found.err, t('tools.webhooks.list_failed'));
			const hook = found.hook;
			// Discord only returns a token for the incoming webhooks this application may manage; a channel
			// follower or another app's webhook has none, and its "URL" would be a broken string.
			if (!hook.token) return { ok: false, spoken: t('tools.webhooks.url_unavailable', { webhook: hook.name }) };
			const ownerId = String(deps.cfg?.ownerId ?? '').trim();
			if (!ownerId) return { ok: false, spoken: t('tools.webhooks.no_owner') };
			const owner = await findMember(deps, ownerId);
			if (!owner?.send) return { ok: false, spoken: t('tools.webhooks.owner_not_found') };
			try {
				// The URL exists only inside this call: it goes into the DM body and nowhere else -- not into
				// `spoken`, not into `data`, not into the log line below.
				await owner.send({ content: t('tools.webhooks.dm_body', { webhook: hook.name, channel: found.channelName, url: hook.url }) });
				deps.log?.(t('tools.webhooks.log_url_sent', { webhook: hook.name }));
				return {
					ok: true,
					spoken: t('tools.webhooks.url_sent', { webhook: hook.name }),
					data: { id: hook.id, name: hook.name, channel: found.channelName, delivered: true },
				};
			} catch (err) {
				return failure(deps, 'webhook url DM failed', err, t('tools.webhooks.url_failed'));
			}
		},
	}),
];
