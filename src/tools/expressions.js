// Expression tools: the server's custom emojis and stickers -- list them, add one from a picture that is
// already on Discord, rename one, delete one (two-step).
//
// Pictures are only ever downloaded from Discord's own CDN. The address arrives here because somebody SAID
// it (or the model read it out of a message), so it is untrusted input: fetching an arbitrary host would
// turn the bot into an SSRF probe on whatever network it runs in. The download goes through
// fetchImageAsDataUrl() in src/messages.js, which enforces https + a Discord host with redirects disabled --
// the same rule imageAttachments() relies on. The host is checked here FIRST as well, so a non-Discord link
// comes back as a sentence the speaker can act on rather than as a thrown error.

import { Buffer } from 'node:buffer';
import {
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	failure,
} from './helpers.js';
import { t } from '../i18n/index.js';
import { P, defineTool } from './registry.js';
import { fetchImageAsDataUrl } from '../messages.js';
import { normalize } from '../text.js';

// Discord's documented limits (developer docs: resources/emoji and resources/sticker).
const EMOJI_MAX_BYTES = 256 * 1024; // 256 KiB per emoji image
const STICKER_MAX_BYTES = 512 * 1024; // 512 KiB per sticker file
const EMOJI_NAME_MIN = 2;
const EMOJI_NAME_MAX = 32;
const STICKER_NAME_MIN = 2;
const STICKER_NAME_MAX = 30;
const STICKER_DESCRIPTION_MAX = 100;
const STICKER_TAGS_MAX = 200;
// Stickers accept PNG / APNG / GIF only. Lottie needs a verified or partnered server and a .json file,
// which is not a picture the bot could be handed over voice.
const STICKER_MIME_EXTENSIONS = { 'image/png': 'png', 'image/apng': 'png', 'image/gif': 'gif' };
// How many names a spoken list reads out before it starts counting instead.
const SPOKEN_LIST_MAX = 25;

// Same rule as ALLOWED_IMAGE_HOSTS in src/messages.js. It is repeated rather than shared because this
// module owns only its own file; the real guard is still the one inside fetchImageAsDataUrl, so drift here
// can only make a refusal clearer -- it can never widen what actually gets fetched.
const DISCORD_CDN_HOSTS = /(?:^|\.)(?:discordapp\.com|discordapp\.net|discord\.com)$/i;

const kilobytes = (bytes) => Math.max(1, Math.round(Number(bytes ?? 0) / 1024));

/**
 * Discord answers a refused upload with a code that names the limit. Turning it into the sentence the
 * speaker hears is the difference between "it did not work" and "the server is out of emoji slots".
 * @param {object} err the rejected API error
 * @param {string} fallback what to say when the code means nothing in particular
 * @param {Record<number, string>} extra per-tool overrides (a generic code means different things per endpoint)
 */
function limitReason(err, fallback, extra = {}) {
	const code = Number(err?.code ?? err?.rawError?.code ?? 0);
	const known = {
		30008: t('tools.expressions.limit_emoji_count'),
		30018: t('tools.expressions.limit_animated_emoji_count'),
		30039: t('tools.expressions.limit_sticker_count'),
		50045: t('tools.expressions.limit_file_size'),
		50046: t('tools.expressions.limit_invalid_file'),
		50138: t('tools.expressions.limit_resize'),
		...extra,
	};
	return known[code] ?? fallback;
}

// ---------------------------------------------------------------- permissions

/**
 * Which permission the bot is missing for this operation, as a spoken sentence (null = it may proceed).
 *
 * Creating needs CreateGuildExpressions. Editing or deleting needs ManageGuildExpressions, EXCEPT for an
 * expression the bot uploaded itself, where CreateGuildExpressions is enough. `permissions.has` already
 * lets Administrator through.
 * @param {object} deps
 * @param {{ manage?: boolean, mine?: boolean }} options manage = edit/delete, mine = the bot uploaded it
 */
function permissionProblem(deps, { manage = false, mine = false } = {}) {
	const permissions = deps.guild?.members?.me?.permissions ?? null;
	// No cached "me" (a partial guild, or a caller that does not model permissions): let the API decide.
	if (typeof permissions?.has !== 'function') return null;
	const canCreate = permissions.has(PermissionFlagsBits.CreateGuildExpressions);
	const canManage = permissions.has(PermissionFlagsBits.ManageGuildExpressions);
	if (!manage) return canCreate || canManage ? null : t('tools.expressions.need_create');
	if (canManage || (mine && canCreate)) return null;
	return t('tools.expressions.need_manage');
}

/** Did the bot itself upload this expression? (`author` on an emoji, `user` on a sticker.) */
function uploadedByBot(deps, expression) {
	const selfId = deps.guild?.members?.me?.id ?? deps.client?.user?.id ?? null;
	const authorId = expression?.author?.id ?? expression?.user?.id ?? null;
	return Boolean(selfId && authorId && selfId === authorId);
}

// ---------------------------------------------------------------- names and lookup

/** Comparison key: "Party_Blob", "party blob" and ":partyblob:" all collapse to "partyblob". */
const expressionKey = (text) => normalize(text).replaceAll(' ', '');

/** Cleans a spoken emoji name into what Discord accepts (letters, digits, underscore; 2-32). */
function emojiName(raw) {
	const cleaned = String(raw ?? '')
		.trim()
		.replace(/[^A-Za-z0-9_]+/g, '_')
		.slice(0, EMOJI_NAME_MAX)
		.replace(/^_+|_+$/g, '');
	return cleaned.length >= EMOJI_NAME_MIN ? cleaned : null;
}

/** Sticker names are free text; only the length is fixed (2-30). */
function stickerName(raw) {
	const cleaned = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, STICKER_NAME_MAX).trim();
	return cleaned.length >= STICKER_NAME_MIN ? cleaned : null;
}

const emojiList = (deps) => [...(deps.guild?.emojis?.cache?.values?.() ?? [])];

/**
 * Name, id, `:name:` or a written-out `<:name:id>` -> the guild emoji.
 * Exact match first, then prefix, then substring -- the transcript drops underscores often enough that a
 * strict comparison would miss half the server's emojis.
 */
function resolveGuildEmoji(deps, raw) {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	const all = emojiList(deps);
	const written = /^<a?:([A-Za-z0-9_]{2,32}):(\d{16,20})>$/u.exec(text);
	const id = written ? written[2] : /^\d{16,20}$/u.test(text) ? text : null;
	if (id) {
		const byId = all.find((emoji) => emoji.id === id);
		if (byId) return byId;
	}
	const needle = expressionKey(written ? written[1] : text.replace(/^:|:$/g, ''));
	if (!needle) return null;
	const keyed = all.map((emoji) => ({ emoji, key: expressionKey(emoji.name) }));
	const hit =
		keyed.find((entry) => entry.key === needle) ??
		keyed.find((entry) => entry.key.startsWith(needle)) ??
		keyed.find((entry) => entry.key.includes(needle));
	return hit?.emoji ?? null;
}

/**
 * The server's stickers. Unlike emojis they are not always in the cache, so an empty cache is filled once.
 * The fetch is NOT swallowed here: a listing that quietly returns nothing reads as "there are no stickers".
 */
async function stickerList(deps) {
	const manager = deps.guild?.stickers ?? null;
	if (!manager) return [];
	if (!manager.cache?.size && typeof manager.fetch === 'function') await manager.fetch();
	return [...(manager.cache?.values?.() ?? [])];
}

/**
 * Sticker by name or id. Filling an empty cache can fail (it is an API call), and the caller has to be
 * able to tell "there is no such sticker" apart from "I could not look": an error is thrown, not swallowed.
 */
async function resolveSticker(deps, raw) {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	const all = await stickerList(deps);
	if (/^\d{16,20}$/u.test(text)) {
		const byId = all.find((sticker) => sticker.id === text);
		if (byId) return byId;
	}
	const needle = expressionKey(text);
	if (!needle) return null;
	const keyed = all.map((sticker) => ({ sticker, key: expressionKey(sticker.name) }));
	const hit =
		keyed.find((entry) => entry.key === needle) ??
		keyed.find((entry) => entry.key.startsWith(needle)) ??
		keyed.find((entry) => entry.key.includes(needle));
	return hit?.sticker ?? null;
}

// ---------------------------------------------------------------- the picture

/**
 * Downloads the picture for an expression from Discord's CDN.
 * @returns {Promise<{ dataUrl: string, buffer: Buffer, mime: string } | { error: string }>} error = a spoken refusal
 * @throws whatever the download itself threw (network, timeout, HTTP status); the caller turns it into failure()
 */
async function downloadExpressionImage(rawUrl, maxBytes) {
	const text = String(rawUrl ?? '').trim();
	if (!text) return { error: t('tools.expressions.no_image') };
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		return { error: t('tools.expressions.bad_url', { url: text.slice(0, 80) }) };
	}
	if (parsed.protocol !== 'https:' || !DISCORD_CDN_HOSTS.test(parsed.hostname)) {
		return { error: t('tools.expressions.not_discord_url') };
	}
	// Downloaded with the shared guard and its own (larger) cap, then measured here: refusing AFTER the
	// download is what lets the refusal name the real size, which is the only number the speaker can act on.
	const dataUrl = await fetchImageAsDataUrl(text);
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
	if (!match) return { error: t('tools.expressions.download_unreadable') };
	const buffer = Buffer.from(match[2], 'base64');
	if (!buffer.length) return { error: t('tools.expressions.download_unreadable') };
	if (buffer.length > maxBytes) {
		return { error: t('tools.expressions.image_too_large', { size: kilobytes(buffer.length), limit: kilobytes(maxBytes) }) };
	}
	return { dataUrl, buffer, mime: match[1] };
}

/** Reads a spoken list back: at most SPOKEN_LIST_MAX names, then a count. */
function spokenNames(names) {
	if (names.length <= SPOKEN_LIST_MAX) return names.join(', ');
	return t('tools.expressions.list_more', {
		names: names.slice(0, SPOKEN_LIST_MAX).join(', '),
		count: names.length - SPOKEN_LIST_MAX,
	});
}

export const tools = [
	defineTool({
		name: 'list_expressions',
		description:
			'Lists the custom emojis and the stickers on this server, with how many there are of each. ' +
			'Use it before renaming or deleting one, to find out what it is really called.',
		parameters: P.obj({
			kind: { type: 'string', enum: ['emoji', 'sticker', 'all'], description: 'What to list (default: all)' },
		}),
		async handler(args, deps) {
			const kind = ['emoji', 'sticker'].includes(String(args.kind ?? '')) ? String(args.kind) : 'all';
			let stickers = [];
			try {
				if (kind !== 'emoji') stickers = await stickerList(deps);
			} catch (err) {
				return failure(deps, 'expression listing failed', err, t('tools.expressions.list_failed'));
			}
			const emojis = kind === 'sticker' ? [] : emojiList(deps);
			const emojiData = emojis.map((emoji) => ({ id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) }));
			const stickerData = stickers.map((sticker) => ({
				id: sticker.id,
				name: sticker.name,
				description: sticker.description ?? null,
				tags: sticker.tags ?? null,
				available: sticker.available !== false,
			}));
			const parts = [];
			if (kind !== 'sticker') {
				parts.push(
					emojiData.length
						? t('tools.expressions.list_emojis', { count: emojiData.length, names: spokenNames(emojiData.map((e) => e.name)) })
						: t('tools.expressions.list_no_emojis'),
				);
			}
			if (kind !== 'emoji') {
				parts.push(
					stickerData.length
						? t('tools.expressions.list_stickers', { count: stickerData.length, names: spokenNames(stickerData.map((s) => s.name)) })
						: t('tools.expressions.list_no_stickers'),
				);
			}
			return {
				ok: true,
				spoken: parts.join(' '),
				data: {
					emojis: emojiData,
					stickers: stickerData,
					counts: {
						emojis: emojiData.length,
						animated: emojiData.filter((emoji) => emoji.animated).length,
						stickers: stickerData.length,
					},
				},
			};
		},
	}),

	defineTool({
		name: 'create_emoji',
		description:
			'Adds a custom emoji to the server from a picture that is ALREADY on Discord. image_url has to be a ' +
			'Discord address (an attachment somebody posted, an existing emoji or an avatar); any other host is ' +
			'refused, so ask the person to upload the picture to a channel first. The picture has to be 256 KB or ' +
			'smaller. Owner only.',
		parameters: P.obj(
			{
				name: P.str('Emoji name: 2-32 letters, digits or underscores (spaces become underscores)'),
				image_url: P.str('Link to the picture on Discord (cdn.discordapp.com / media.discordapp.net)'),
			},
			['name', 'image_url'],
		),
		gate: { keywords: WORDS.emoji },
		async handler(args, deps) {
			const problem = permissionProblem(deps, { manage: false });
			if (problem) return { ok: false, spoken: problem };
			const name = emojiName(args.name);
			if (!name) return { ok: false, spoken: t('tools.expressions.emoji_name_invalid', { name: String(args.name ?? '').slice(0, 40) }) };
			// Emojis are addressed BY NAME everywhere else in the bot (resolveEmojis in helpers.js maps :name:
			// onto the cache), so a second emoji with the same name would make every later mention ambiguous.
			// Discord itself allows the duplicate; we do not.
			const clash = emojiList(deps).find((emoji) => expressionKey(emoji.name) === expressionKey(name));
			if (clash) return { ok: false, spoken: t('tools.expressions.emoji_exists', { name: clash.name }) };

			let image;
			try {
				image = await downloadExpressionImage(args.image_url, EMOJI_MAX_BYTES);
			} catch (err) {
				return failure(deps, 'emoji image download failed', err, t('tools.expressions.download_failed'));
			}
			if (image.error) return { ok: false, spoken: image.error };

			try {
				// A data: URL is handed straight to the API by discord.js (resolveImage passes it through), so
				// nothing downloads the address a second time.
				const emoji = await deps.guild.emojis.create({
					attachment: image.dataUrl,
					name,
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.expressions.log_emoji_created', { name: emoji?.name ?? name }));
				return {
					ok: true,
					spoken: t('tools.expressions.emoji_created', { name: emoji?.name ?? name }),
					data: {
						id: emoji?.id ?? null,
						name: emoji?.name ?? name,
						animated: Boolean(emoji?.animated),
						bytes: image.buffer.length,
					},
				};
			} catch (err) {
				return failure(deps, 'emoji creation failed', err, limitReason(err, t('tools.expressions.create_emoji_failed')));
			}
		},
	}),

	defineTool({
		name: 'rename_emoji',
		description: 'Renames a custom server emoji. The picture stays the same. Owner only.',
		parameters: P.obj(
			{
				emoji: P.str('The emoji as it is called now (name, :name: or its id)'),
				name: P.str('New name: 2-32 letters, digits or underscores'),
			},
			['emoji', 'name'],
		),
		gate: { keywords: WORDS.emoji },
		async handler(args, deps) {
			const emoji = resolveGuildEmoji(deps, args.emoji);
			if (!emoji) return { ok: false, spoken: t('tools.expressions.emoji_not_found', { name: String(args.emoji ?? '').slice(0, 40) }) };
			// A "managed" emoji belongs to an integration (Twitch, another bot's set); Discord refuses every edit.
			if (emoji.managed) return { ok: false, spoken: t('tools.expressions.emoji_managed', { name: emoji.name }) };
			const problem = permissionProblem(deps, { manage: true, mine: uploadedByBot(deps, emoji) });
			if (problem) return { ok: false, spoken: problem };
			const name = emojiName(args.name);
			if (!name) return { ok: false, spoken: t('tools.expressions.emoji_name_invalid', { name: String(args.name ?? '').slice(0, 40) }) };
			if (expressionKey(name) === expressionKey(emoji.name)) {
				return { ok: false, spoken: t('tools.expressions.same_name', { name: emoji.name }) };
			}
			const clash = emojiList(deps).find((other) => other.id !== emoji.id && expressionKey(other.name) === expressionKey(name));
			if (clash) return { ok: false, spoken: t('tools.expressions.emoji_exists', { name: clash.name }) };

			const previous = emoji.name;
			try {
				const updated = await deps.guild.emojis.edit(emoji, { name, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.expressions.log_emoji_renamed', { old: previous, name }));
				return {
					ok: true,
					spoken: t('tools.expressions.emoji_renamed', { old: previous, name }),
					data: { id: updated?.id ?? emoji.id, name, previous },
				};
			} catch (err) {
				return failure(deps, 'emoji rename failed', err, limitReason(err, t('tools.expressions.rename_emoji_failed')));
			}
		},
	}),

	defineTool({
		name: 'delete_emoji',
		description:
			'Deletes a custom server emoji. Every message that used it loses the picture. ' +
			'Owner only; two-step (asks first, deletes with confirm:true).',
		parameters: P.obj({ emoji: P.str('The emoji (name, :name: or its id)'), confirm: P.confirm() }, ['emoji']),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const emoji = resolveGuildEmoji(deps, args.emoji);
			if (!emoji) return { ok: false, spoken: t('tools.expressions.emoji_not_found', { name: String(args.emoji ?? '').slice(0, 40) }) };
			if (emoji.managed) return { ok: false, spoken: t('tools.expressions.emoji_managed', { name: emoji.name }) };
			const problem = permissionProblem(deps, { manage: true, mine: uploadedByBot(deps, emoji) });
			if (problem) return { ok: false, spoken: problem };
			const decision = checkConfirmation(deps, {
				key: name,
				target: emoji.id,
				confirm: args.confirm,
				question: t('tools.expressions.emoji_delete_question', { name: emoji.name }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { emoji: emoji.name });
			if (decision.stale) return STALE_CONFIRMATION();
			const label = emoji.name;
			try {
				await deps.guild.emojis.delete(emoji, t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.expressions.log_emoji_deleted', { name: label }));
				return { ok: true, spoken: t('tools.expressions.emoji_deleted', { name: label }), data: { id: emoji.id, name: label } };
			} catch (err) {
				return failure(deps, 'emoji deletion failed', err, limitReason(err, t('tools.expressions.delete_emoji_failed')));
			}
		},
	}),

	defineTool({
		name: 'create_sticker',
		description:
			'Adds a sticker to the server from a picture that is ALREADY on Discord. image_url has to be a Discord ' +
			'address, exactly like create_emoji. The file has to be a PNG or a GIF, 320 by 320 pixels, 512 KB or ' +
			'smaller; Discord refuses anything else. Owner only.',
		parameters: P.obj(
			{
				name: P.str('Sticker name, 2-30 characters'),
				image_url: P.str('Link to the PNG or GIF on Discord (cdn.discordapp.com / media.discordapp.net)'),
				tags: P.str('Suggestion keyword, normally the name of a unicode emoji such as "joy" (default: the sticker name)'),
				description: P.str('Description, 2-100 characters (optional)'),
			},
			['name', 'image_url'],
		),
		gate: { keywords: WORDS.emoji },
		async handler(args, deps) {
			const problem = permissionProblem(deps, { manage: false });
			if (problem) return { ok: false, spoken: problem };
			const name = stickerName(args.name);
			if (!name) return { ok: false, spoken: t('tools.expressions.sticker_name_invalid', { name: String(args.name ?? '').slice(0, 40) }) };
			let existing = [];
			try {
				existing = await stickerList(deps);
			} catch (err) {
				return failure(deps, 'sticker listing failed', err, t('tools.expressions.list_failed'));
			}
			const clash = existing.find((sticker) => expressionKey(sticker.name) === expressionKey(name));
			if (clash) return { ok: false, spoken: t('tools.expressions.sticker_exists', { name: clash.name }) };
			const description = String(args.description ?? '').trim().slice(0, STICKER_DESCRIPTION_MAX);
			// Discord accepts an empty description or 2-100 characters; a single character is rejected by the API.
			if (description.length === 1) return { ok: false, spoken: t('tools.expressions.description_too_short') };
			const tags = (String(args.tags ?? '').trim() || name).slice(0, STICKER_TAGS_MAX);

			let image;
			try {
				image = await downloadExpressionImage(args.image_url, STICKER_MAX_BYTES);
			} catch (err) {
				return failure(deps, 'sticker image download failed', err, t('tools.expressions.download_failed'));
			}
			if (image.error) return { ok: false, spoken: image.error };
			const extension = STICKER_MIME_EXTENSIONS[String(image.mime).toLowerCase()];
			if (!extension) return { ok: false, spoken: t('tools.expressions.sticker_format', { type: image.mime }) };

			try {
				// The BYTES go to Discord, not the address: handed a URL string, discord.js would fetch it itself,
				// and that fetch has no host restriction at all.
				const sticker = await deps.guild.stickers.create({
					file: { attachment: image.buffer, name: `sticker.${extension}` },
					name,
					tags,
					description: description || null,
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.expressions.log_sticker_created', { name: sticker?.name ?? name }));
				return {
					ok: true,
					spoken: t('tools.expressions.sticker_created', { name: sticker?.name ?? name }),
					data: {
						id: sticker?.id ?? null,
						name: sticker?.name ?? name,
						tags,
						description: description || null,
						bytes: image.buffer.length,
					},
				};
			} catch (err) {
				// 50035 on this endpoint is almost always the 320x320 rule, which the bot cannot check itself.
				const reason = limitReason(err, t('tools.expressions.create_sticker_failed'), { 50035: t('tools.expressions.sticker_rejected') });
				return failure(deps, 'sticker creation failed', err, reason);
			}
		},
	}),

	defineTool({
		name: 'rename_sticker',
		description:
			'Renames a server sticker, and can change its description or its tags (the suggestion keyword) in the ' +
			'same call. The picture stays the same. Owner only.',
		parameters: P.obj(
			{
				sticker: P.str('The sticker as it is called now (name or id)'),
				name: P.str('New name, 2-30 characters'),
				description: P.str('New description, 2-100 characters (an empty string clears it)'),
				tags: P.str('New suggestion keyword, normally the name of a unicode emoji'),
			},
			['sticker'],
		),
		gate: { keywords: WORDS.emoji },
		async handler(args, deps) {
			let sticker;
			try {
				sticker = await resolveSticker(deps, args.sticker);
			} catch (err) {
				return failure(deps, 'sticker lookup failed', err, t('tools.expressions.list_failed'));
			}
			if (!sticker) return { ok: false, spoken: t('tools.expressions.sticker_not_found', { name: String(args.sticker ?? '').slice(0, 40) }) };
			const problem = permissionProblem(deps, { manage: true, mine: uploadedByBot(deps, sticker) });
			if (problem) return { ok: false, spoken: problem };

			const patch = {};
			const done = [];
			if (args.name !== undefined && String(args.name).trim()) {
				const name = stickerName(args.name);
				if (!name) return { ok: false, spoken: t('tools.expressions.sticker_name_invalid', { name: String(args.name).slice(0, 40) }) };
				if (expressionKey(name) !== expressionKey(sticker.name)) {
					const all = await stickerList(deps);
					const clash = all.find((other) => other.id !== sticker.id && expressionKey(other.name) === expressionKey(name));
					if (clash) return { ok: false, spoken: t('tools.expressions.sticker_exists', { name: clash.name }) };
					patch.name = name;
					done.push(t('tools.expressions.part_renamed', { name }));
				}
			}
			if (args.description !== undefined) {
				const description = String(args.description).trim().slice(0, STICKER_DESCRIPTION_MAX);
				if (description.length === 1) return { ok: false, spoken: t('tools.expressions.description_too_short') };
				patch.description = description || null;
				done.push(description ? t('tools.expressions.part_description') : t('tools.expressions.part_description_cleared'));
			}
			if (args.tags !== undefined && String(args.tags).trim()) {
				patch.tags = String(args.tags).trim().slice(0, STICKER_TAGS_MAX);
				done.push(t('tools.expressions.part_tags', { tags: patch.tags }));
			}
			if (!Object.keys(patch).length) return { ok: false, spoken: t('tools.expressions.nothing_to_change', { name: sticker.name }) };

			const previous = sticker.name;
			try {
				const updated = await deps.guild.stickers.edit(sticker, { ...patch, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.expressions.log_sticker_updated', { old: previous, details: done.join(', ') }));
				return {
					ok: true,
					spoken: t('tools.expressions.sticker_updated', { old: previous, details: done.join(', ') }),
					data: { id: updated?.id ?? sticker.id, name: patch.name ?? previous, previous, changes: patch },
				};
			} catch (err) {
				return failure(deps, 'sticker update failed', err, limitReason(err, t('tools.expressions.rename_sticker_failed')));
			}
		},
	}),

	defineTool({
		name: 'delete_sticker',
		description: 'Deletes a server sticker. Owner only; two-step (asks first, deletes with confirm:true).',
		parameters: P.obj({ sticker: P.str('The sticker (name or id)'), confirm: P.confirm() }, ['sticker']),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			let sticker;
			try {
				sticker = await resolveSticker(deps, args.sticker);
			} catch (err) {
				return failure(deps, 'sticker lookup failed', err, t('tools.expressions.list_failed'));
			}
			if (!sticker) return { ok: false, spoken: t('tools.expressions.sticker_not_found', { name: String(args.sticker ?? '').slice(0, 40) }) };
			const problem = permissionProblem(deps, { manage: true, mine: uploadedByBot(deps, sticker) });
			if (problem) return { ok: false, spoken: problem };
			const decision = checkConfirmation(deps, {
				key: name,
				target: sticker.id,
				confirm: args.confirm,
				question: t('tools.expressions.sticker_delete_question', { name: sticker.name }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { sticker: sticker.name });
			if (decision.stale) return STALE_CONFIRMATION();
			const label = sticker.name;
			try {
				await deps.guild.stickers.delete(sticker, t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.expressions.log_sticker_deleted', { name: label }));
				return { ok: true, spoken: t('tools.expressions.sticker_deleted', { name: label }), data: { id: sticker.id, name: label } };
			} catch (err) {
				return failure(deps, 'sticker deletion failed', err, limitReason(err, t('tools.expressions.delete_sticker_failed')));
			}
		},
	}),
];
