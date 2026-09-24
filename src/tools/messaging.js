// Messaging tools: send, read, edit, delete, DM, commands to other bots.

import { t, tList } from '../i18n/index.js';
import { formatMessages } from '../reader.js';
import { balanceCodeFences, normalize, stripDictationTail } from '../text.js';
import {
	SlidingLimiter,
	WORDS,
	askConfirmation,
	authorizedBotSet,
	checkConfirmation,
	displayName,
	failure,
	findMember,
	ownerAllowed,
	ownerGate,
	replaceNameWithMention,
	resolveEmojis,
	resolveMentions,
	resolveStickers,
	resolveTextChannel,
	selfIdOf,
	textChannels,
} from './helpers.js';
import { canReadChannel, requesterId, requesterIsOwner } from './access.js';
import { P, defineTool } from './registry.js';
import { pickBest } from '../matcher.js';
import { findChannelByName } from '../text.js';

// The DM rate limit is kept process-wide (so the model cannot fire off DMs back to back); tests reset it via resetDmLimiter.
const dmLimiter = new SlidingLimiter();
export const resetDmLimiter = () => dmLimiter.reset();

// What the owner says when asking the bot to write to somebody privately, and when asking it to change
// something it already wrote. The owner gate looks for one of these in the owner's own speech before
// either happens.
const DM_WORDS = tList('tools.messaging.dm_words');
const EDIT_WORDS = tList('tools.messaging.edit_words');

/**
 * The channel a message tool should act on. A DM is not a guild channel, so resolveTextChannel can never
 * find one by name; when the request is about a private conversation we look it up by person, or fall
 * back to the last DM the bot sent, which is what "I wrote to the wrong person, delete it" means.
 */
/**
 * What to call this channel out loud and in the log. A private conversation has no `name`, so every
 * message about one came out as a literal "#{channel}" with the placeholder still in it.
 */
function channelLabel(channel) {
	if (!channel) return '';
	if (channel.name) return channel.name;
	const who = channel.recipient?.displayName ?? channel.recipient?.username ?? null;
	return who ? t('tools.messaging.dm_with', { who }) : t('tools.messaging.dm_label');
}

/** A real Discord id, so that an id the model invented cannot silently turn into "no messages". */
const looksLikeId = (value) => /^\d{17,20}$/.test(String(value ?? '').trim());

function isDirect(channel) {
	return Boolean(channel) && !channel.name;
}

/** How a channel is named in a sentence: "#general", or "the private conversation with Ali". */
function placeOf(channel) {
	return isDirect(channel) ? channelLabel(channel) : `#${channel.name}`;
}

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/** Who a refusal was for, in the log. Somebody who cannot be named is measured against @everyone. */
function askerLabel(deps) {
	const id = requesterId(deps);
	return id ? (deps.currentSpeakerName?.() ?? id) : '@everyone';
}

/**
 * Private conversations are the owner's to read. The bot's DMs with a member are between the bot and
 * that member, and the owner's own DMs with the bot are nobody else's business.
 */
function refuseDirectRead(deps) {
	deps.log?.(t('tools.messaging.log_dm_read_refused', { who: askerLabel(deps) }));
	return { ok: false, denied: true, spoken: t('tools.messaging.dm_read_owner_only') };
}

/**
 * May the person asking have this channel read out to them? The bot sees every channel it was let
 * into, staff rooms included, and reading one aloud hands its contents to whoever asked, so the asker
 * has to be able to read it on their own: see it and read its history. The owner may read anything the
 * bot can; somebody who cannot be named gets what @everyone can read.
 * @returns {Promise<object|null>} the refusal, or null when reading is fine
 */
async function readRefusal(deps, channel) {
	// A slash command is not a voice: commands.js checked the person who ran it against their own
	// Discord account, and whoever last spoke in the voice channel has nothing to do with it.
	if (deps.fromSlashCommand === true) return null;
	if (requesterIsOwner(deps)) return null;
	if (isDirect(channel)) return refuseDirectRead(deps);
	const speakerId = requesterId(deps);
	if (await canReadChannel(deps, channel, speakerId)) return null;
	const label = channelLabel(channel);
	deps.log?.(t('tools.messaging.log_read_refused', { channel: label, who: askerLabel(deps) }));
	return {
		ok: false,
		denied: true,
		spoken: speakerId ? t('tools.messaging.read_not_allowed', { channel: label }) : t('tools.messaging.read_not_allowed_unknown', { channel: label }),
	};
}

/**
 * The words that count as the owner asking for a crowd ping. @everyone/@here take the everyone words;
 * a role also takes its own name, since naming the role is how the owner asks for it, the way
 * "everyone" asks for @everyone.
 */
function pingWords(deps, entry) {
	if (entry.kind !== 'role') return WORDS.everyone;
	const role = deps.guild?.roles?.cache?.get(entry.id) ?? null;
	const own = [entry.name, role?.name].flatMap((name) => normalize(name ?? '').split(' ')).filter((word) => word.length >= 3);
	return [...new Set([...WORDS.everyone, ...own])];
}

async function resolveMessageChannel(deps, { channel, dm }) {
	if (channel) {
		const named = resolveTextChannel(deps, channel);
		if (named) return named;
	}
	const wantsDm = dm !== undefined && dm !== null && String(dm).trim() !== '';
	if (wantsDm) {
		const asked = String(dm).trim();
		const last = deps.lastDirectMessage?.() ?? null;
		// "the last one" / "that person" resolves to the conversation we just had.
		const useLast = last && (tList('keywords.last_dm_words').includes(normalize(asked)) || normalize(last.name ?? '') === normalize(asked));
		const member = useLast ? null : await findMember(deps, asked);
		const channelId = useLast ? last.channelId : null;
		if (channelId) return deps.client?.channels?.cache?.get(channelId) ?? (await deps.client?.channels?.fetch(channelId).catch(() => null)) ?? null;
		if (member) return await member.createDM().catch(() => null);
		return null;
	}
	// No channel and no person named: the configured default channel first, exactly as before, and only
	// when there is none do we fall back to the conversation the bot was last in.
	const fallback = resolveTextChannel(deps, null);
	if (fallback) return fallback;
	const last = deps.lastDirectMessage?.() ?? null;
	if (last?.channelId) {
		const cached = deps.client?.channels?.cache?.get(last.channelId);
		if (cached) return cached;
		return (await deps.client?.channels?.fetch(last.channelId).catch(() => null)) ?? null;
	}
	return null;
}

/**
 * Where a message goes when no channel is named and none is configured: the channel the conversation
 * has been happening in, and failing that the voice channel's own text chat -- "tell everyone in voice"
 * means the people who are actually there. Refusing outright left "send everyone a hello" with nowhere
 * to go.
 */
function sendableFallback(deps) {
	for (const pick of [deps.lastTextChannel, deps.currentVoiceChannel]) {
		const candidate = typeof pick === 'function' ? pick() : null;
		if (!candidate || typeof candidate.send !== 'function') continue;
		if (typeof candidate.isTextBased === 'function' && !candidate.isTextBased()) continue;
		return candidate;
	}
	return null;
}

export const tools = [
	defineTool({
		name: 'send_message',
		description:
			'Sends a message to a Discord text channel. Use mentions to tag people, ":name:" inside the text or the emojis list for server ' +
			'emojis, and stickers for server stickers. "everyone" (@everyone) and roles are only pinged when the owner asks for it.',
		parameters: P.obj(
			{
				channel: P.str('Channel name (e.g. "chat"). Empty = the default channel, else the channel the conversation is in, else the voice channel chat.'),
				text: P.str('Message text. Write :name: for a server emoji.'),
				mentions: P.list('Member or role names to tag. "everyone" = @everyone; @everyone and roles are pinged for the owner only'),
				emojis: P.list('Server emojis to append to the message'),
				stickers: P.list('Server stickers to send'),
			},
			['text'],
		),
		async handler(args, deps) {
			let channel = resolveTextChannel(deps, args.channel);
			if (!channel && !args.channel) channel = sendableFallback(deps);
			if (!channel) {
				return {
					ok: false,
					spoken: args.channel ? t('tools.messaging.channel_not_found', { name: args.channel }) : t('tools.messaging.no_send_channel'),
				};
			}
			const text = balanceCodeFences(stripDictationTail(String(args.text ?? '')));
			const resolved = await resolveMentions(deps, args.mentions ?? []);
			const warnings = [...resolved.warnings];
			let entries = resolved.entries;
			// @everyone/@here: a real ping only when the owner asks for it; otherwise the tag is dropped.
			if (entries.some((entry) => entry.kind === 'everyone') && !ownerAllowed(deps, WORDS.everyone)) {
				entries = entries.filter((entry) => entry.kind !== 'everyone');
				warnings.push(t('tools.messaging.everyone_warning'));
				deps.activity?.({
					kind: 'gate',
					whoName: deps.personaName?.() ?? 'bot',
					text: t('tools.messaging.everyone_denied_activity'),
					meta: { tool: 'send_message', result: 'denied' },
				});
			}
			// A role tag reaches everybody who holds the role, which for a large role is @everyone under
			// another name, and roles like "moderators" exist precisely to be called on. The same rule
			// applies: the owner's request pings it, anybody else's goes out with the tag dropped.
			const refusedRoles = entries.filter((entry) => entry.kind === 'role' && !ownerAllowed(deps, pingWords(deps, entry)));
			if (refusedRoles.length) {
				entries = entries.filter((entry) => !refusedRoles.includes(entry));
				for (const entry of refusedRoles) {
					const role = deps.guild?.roles?.cache?.get(entry.id)?.name ?? entry.name;
					warnings.push(t('tools.messaging.role_ping_warning', { role }));
					deps.activity?.({
						kind: 'gate',
						whoName: deps.personaName?.() ?? 'bot',
						text: t('tools.messaging.role_ping_denied_activity', { role }),
						meta: { tool: 'send_message', result: 'denied' },
					});
				}
			}
			const { body, used, warnings: emojiWarnings } = resolveEmojis(deps, args.emojis ?? [], text);
			const { ids: stickerIds, warnings: stickerWarnings } = await resolveStickers(deps, args.stickers ?? []);
			warnings.push(...emojiWarnings, ...stickerWarnings);
			// If the name occurs in the body we put the mention right there; if it does not, we prepend it.
			let finalBody = body;
			const prefix = [];
			for (const entry of entries) {
				let placed = false;
				for (const variant of entry.variants ?? [entry.name]) {
					const result = replaceNameWithMention(finalBody, variant, entry.mention);
					if (!result.replaced) continue;
					finalBody = result.text;
					placed = true;
					break;
				}
				if (!placed) prefix.push(entry.mention);
			}
			const mentions = entries.map((entry) => entry.mention);
			const content = [prefix.join(' '), finalBody].filter(Boolean).join(' ').trim();
			if (!content && !stickerIds.length) {
				return { ok: false, spoken: t('tools.messaging.empty_message') };
			}
			try {
				const payload = {
					// Only EXPLICITLY requested mentions may ping; wording like "@everyone" typed into the text stays inert.
					allowedMentions: {
						parse: entries.some((entry) => entry.kind === 'everyone') ? ['everyone'] : [],
						users: entries.filter((entry) => entry.kind === 'user').map((entry) => entry.id),
						roles: entries.filter((entry) => entry.kind === 'role').map((entry) => entry.id),
						repliedUser: false,
					},
				};
				if (content) payload.content = content.slice(0, 2000);
				if (stickerIds.length) payload.stickers = stickerIds;
				const message = await channel.send(payload);
				deps.log?.(t('tools.messaging.log_sent', { channel: channel.name, warnings: warnings.length ? ` (${warnings.join('; ')})` : '' }));
				deps.recentActions?.remember(`send:${channel.id}:${normalize(text)}`, {
					speak: true,
					text: t('tools.messaging.sent', { channel: channel.name }),
					ok: true,
				});
				return {
					ok: true,
					spoken: t('tools.messaging.sent', { channel: channel.name }),
					data: { channel: `#${channel.name}`, message_id: message.id, mentions, emojis: used, stickers: stickerIds },
					warnings,
				};
			} catch (err) {
				return failure(deps, 'message send failed', err, t('tools.messaging.send_failed'));
			}
		},
	}),

	defineTool({
		name: 'read_messages',
		description:
			'Reads the NEW messages in a channel (the ones that arrived after the bot started up / after the last read). For requests such as ' +
			'older messages, "the recent messages", "who wrote last", "show me even older ones", pass all:true (the last N messages with no ' +
			"new/old distinction); to go further back, pass the previous result's oldest_id value as before. It only reads a channel the " +
			'person asking can read themselves; private conversations (dm) are read for the owner only.',
		parameters: P.obj({
			channel: P.str('Channel name. Empty = the default channel.'),
			dm: P.str('Read the private conversation with this person instead of a channel: their name, or "last" for the one you were just in. Owner only.'),
			count: P.int('How many messages at most (1-10, default 5; 20 with all:true)'),
			all: P.bool("true = read the channel's latest messages with no new-messages-only restriction (older messages included)"),
			before: P.str('With all:true: read the messages before this message id (pagination; the oldest_id value of the previous result)'),
		}),
		async handler(args, deps) {
			// Refused before the person is looked up: finding them opens a private channel with them.
			if (hasValue(args.dm) && deps.fromSlashCommand !== true && !requesterIsOwner(deps)) return refuseDirectRead(deps);
			// "Read the DM I just sent you" was answered with "I could not tell which channel to read":
			// this tool was the only one in the family that could not look at a private conversation, while
			// the bot was perfectly able to send one.
			const channel = await resolveMessageChannel(deps, { channel: args.channel, dm: args.dm });
			if (!channel) return { ok: false, spoken: t('tools.messaging.no_read_channel') };
			const refusal = await readRefusal(deps, channel);
			if (refusal) return refusal;
			const count = Number.isFinite(Number(args.count)) && Number(args.count) > 0 ? Number(args.count) : deps.cfg.readLimit;
			const label = channelLabel(channel);
			// An id the model made up reads as "there is nothing older", which is a lie about the channel
			// rather than about the id. Only a real one is passed on.
			const before = looksLikeId(args.before) ? String(args.before).trim() : null;
			// "Read our DM" means the latest of it. A private conversation has no baseline taken at startup,
			// and after one read the new-messages-only path answers "nothing new" to somebody who is pointing
			// at a message they can see on their own screen.
			const wantsLatest = args.all === true || isDirect(channel);
			try {
				if (wantsLatest) {
					const { messages, oldestId } = await deps.reader.readHistory(channel, { limit: count, before });
					deps.log?.(
						t('tools.messaging.log_history', {
							channel: label,
							count: messages.length,
							more: before ? t('tools.messaging.log_history_older') : '',
						}),
					);
					const spoken = messages.length
						? formatMessages(messages, label)
						: before
							? t('tools.messaging.no_older_messages', { channel: label })
							: t('tools.messaging.no_messages', { channel: label });
					return { ok: true, spoken, data: { channel: label, count: messages.length, all: true, oldest_id: oldestId } };
				}
				const { messages, isNew, firstTime } = await deps.reader.read(channel, count);
				if (!messages.length) {
					deps.log?.(t('tools.messaging.log_read_none', { channel: label }));
					return {
						ok: true,
						spoken: t('tools.messaging.no_new_messages', { channel: label }),
						data: { channel: label, count: 0, new: false, first_time: firstTime, hint: 'all:true for older messages' },
					};
				}
				const hidden = messages.filter((m) => !m.author?.bot && !String(m.content ?? '').trim()).length;
				const hint = hidden > 0 ? t('tools.messaging.empty_content_hint') : null;
				deps.log?.(
					t('tools.messaging.log_read', {
						channel: label,
						count: messages.length,
						fresh: isNew ? t('tools.messaging.log_read_new') : '',
					}),
				);
				const spoken = formatMessages(messages, label, { emptyHint: hint });
				return {
					ok: true,
					spoken: hint && messages.length ? `${spoken} ${hint}` : spoken,
					data: { channel: label, count: messages.length, new: isNew, first_time: firstTime },
					warnings: hint ? [hint] : [],
				};
			} catch (err) {
				return failure(deps, `read failed (${label})`, err, t('tools.messaging.read_failed', { channel: label }));
			}
		},
	}),

	defineTool({
		name: 'send_dm',
		description:
			'Sends a direct message (DM) to someone on the server. Anyone may have it DM themselves; a DM to anybody else is for the owner only. ' +
			'It is rate limited; do not fire off DMs back to back.',
		parameters: P.obj(
			{
				to: P.str('Person name (display name or username)'),
				text: P.str('The message to send'),
			},
			['to', 'text'],
		),
		async handler(args, deps, { name }) {
			const member = await findMember(deps, String(args.to ?? ''));
			const text = balanceCodeFences(stripDictationTail(String(args.text ?? '')));
			if (!member) return { ok: false, spoken: t('tools.messaging.member_not_found', { name: args.to }) };
			if (!text) return { ok: false, spoken: t('tools.messaging.no_dm_text') };
			// "Send me that link" is anybody's to ask. A DM to somebody else puts the bot's name on words the
			// recipient reads alone, with nothing to say who asked for them, so that one is the owner's.
			const speakerId = requesterId(deps);
			if (!speakerId || String(member.id) !== speakerId) {
				const denied = await ownerGate(deps, DM_WORDS, name);
				if (denied) return denied;
			}
			const now = deps.now?.() ?? Date.now();
			const perTarget = deps.cfg?.dmPerTargetPerMinute ?? 3;
			const perMinute = deps.cfg?.dmPerMinute ?? 10;
			if (!dmLimiter.take(`target:${member.id}`, perTarget, now) || !dmLimiter.take('all', perMinute, now)) {
				deps.log?.(t('tools.messaging.log_dm_rate_limited', { who: displayName(member) }));
				return { ok: false, spoken: t('tools.messaging.dm_rate_limited') };
			}
			try {
				const sentDm = await member.send({ content: text.slice(0, 2000) });
				// Remembered so "delete that" and "fix that" can find the private conversation again: a DM
				// lives in its own channel, which resolveTextChannel cannot reach by name.
				deps.noteDirectMessage?.({ channelId: sentDm?.channelId ?? sentDm?.channel?.id ?? null, memberId: member.id, name: displayName(member) });
				const who = displayName(member);
				deps.log?.(t('tools.messaging.log_dm_sent', { who }));
				return { ok: true, spoken: t('tools.messaging.dm_sent', { who }), data: { to: who } };
			} catch (err) {
				const who = displayName(member, t('tools.messaging.dm_failed_fallback_name'));
				return failure(deps, 'DM send failed', err, t('tools.messaging.dm_failed', { who }));
			}
		},
	}),

	defineTool({
		name: 'delete_messages',
		description:
			'Deletes messages. Owner only. With message_id a single message, otherwise the last N messages; own:true keeps to my own ' +
			"messages. Deleting several of other people's messages is two-step (asks first, deletes with confirm:true).",
		parameters: P.obj({
			channel: P.str('Channel name (empty = the default one, or the last direct message when dm is given)'),
			dm: P.str('Act in a private conversation instead of a channel: the person\'s name, or the word for "the last one"'),
			message_id: P.str('Id of the single message to delete (optional)'),
			count: P.int('How many messages (1-20, default 1)'),
			own: P.bool("Only the bot's own messages"),
			from: P.str("Only this person's messages (optional)"),
			confirm: P.confirm(),
		}),
		// The bot's own posts are not the bot's alone: an announcement the owner had it make is one of
		// them, and letting anyone remove those let anyone take the owner's words down.
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const channel = await resolveMessageChannel(deps, { channel: args.channel, dm: args.dm });
			if (!channel) return { ok: false, spoken: t('tools.messaging.no_delete_channel') };
			const selfId = selfIdOf(deps);

			// Single message: by its id
			if (args.message_id) {
				try {
					const message = await channel.messages.fetch(String(args.message_id));
					await message.delete();
					deps.log?.(t('tools.messaging.log_deleted_one', { channel: channel.name }));
					return { ok: true, spoken: t('tools.messaging.deleted_one'), data: { channel: channel.name, message_id: message.id } };
				} catch (err) {
					return failure(deps, 'message delete failed', err, t('tools.messaging.delete_one_failed'));
				}
			}

			const count = Math.min(Math.max(Number(args.count ?? 1) || 1, 1), 20);
			const ownOnly = args.own === true;
			const fromMember = args.from ? await findMember(deps, String(args.from)) : null;
			try {
				const fetched = await channel.messages.fetch({ limit: Math.max(count * 3, 10) });
				// Discord hands them back newest-first; we sort ourselves rather than trusting that order.
				let targets = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
				if (ownOnly) targets = targets.filter((message) => message.author?.id === selfId);
				else if (fromMember) targets = targets.filter((message) => message.author?.id === fromMember.id);
				targets = targets.slice(0, count);
				if (!targets.length) return { ok: false, spoken: t('tools.messaging.nothing_to_delete') };
				// Other people's words cannot be put back, and "the last five" is exactly what a transcript
				// gets wrong: the count, the person, the channel. Several at once are named out loud and wait
				// for a yes. The question is tied to what was asked for rather than to message ids, so a new
				// message arriving in a busy channel between the question and the answer does not void it.
				if (!ownOnly && targets.length > 1 && targets.some((message) => message.author?.id !== selfId)) {
					const who = fromMember ? displayName(fromMember) : null;
					const place = placeOf(channel);
					const decision = checkConfirmation(deps, {
						key: name,
						target: `${channel.id}:${fromMember?.id ?? '*'}:${count}`,
						confirm: args.confirm,
						question: who
							? t('tools.messaging.delete_many_from_question', { count: targets.length, who, channel: place })
							: t('tools.messaging.delete_many_question', { count: targets.length, channel: place }),
					});
					if (decision.ask) return askConfirmation(decision.ask, { channel: place, count: targets.length, from: who });
				}

				let deleted = 0;
				// Bulk delete for 2+ messages (a single request); one by one when they are older than 14 days or bulk delete is unsupported.
				if (targets.length > 1 && typeof channel.bulkDelete === 'function') {
					try {
						const result = await channel.bulkDelete(targets, true);
						deleted = typeof result?.size === 'number' ? result.size : targets.length;
					} catch {
						deleted = 0;
					}
				}
				if (!deleted) {
					for (const message of targets) {
						try {
							await message.delete();
							deleted++;
						} catch {
							/* try them one by one; if one fails, carry on */
						}
					}
				}
				deps.log?.(t('tools.messaging.log_deleted_many', { count: deleted, channel: channel.name }));
				if (!deleted) return { ok: false, spoken: t('tools.messaging.delete_none') };
				return {
					ok: true,
					spoken: t('tools.messaging.deleted_many', { count: deleted }),
					data: { channel: channel.name, deleted, own: ownOnly, from: fromMember ? displayName(fromMember) : null },
				};
			} catch (err) {
				return failure(deps, 'message deletion failed', err, t('tools.messaging.delete_failed'));
			}
		},
	}),

	defineTool({
		name: 'edit_message',
		description:
			"Edits one of the bot's own messages: by message_id, or (when that is empty) its latest own message in the channel; with contains, " +
			'the latest message holding that text. Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Channel name (empty = the default one, or the last direct message when dm is given)'),
				dm: P.str('Edit in a private conversation instead of a channel: the person, or the word for "the last one"'),
				message_id: P.str('Id of the message to edit (optional)'),
				contains: P.str('My latest own message containing this text (optional)'),
				text: P.str('The new message text'),
			},
			['text'],
		),
		// Rewriting what the bot already posted rewrites whatever the owner had it announce, under the
		// bot's name and after people have read the original.
		gate: { keywords: EDIT_WORDS },
		async handler(args, deps) {
			const channel = await resolveMessageChannel(deps, { channel: args.channel, dm: args.dm });
			if (!channel) return { ok: false, spoken: t('tools.messaging.no_edit_channel') };
			const selfId = selfIdOf(deps);
			const text = balanceCodeFences(stripDictationTail(String(args.text ?? '')));
			if (!text) return { ok: false, spoken: t('tools.messaging.no_edit_text') };
			const contains = normalize(String(args.contains ?? ''));
			try {
				let message = null;
				if (args.message_id) {
					message = await channel.messages.fetch(String(args.message_id)).catch(() => null);
				}
				if (!message) {
					const recent = await channel.messages.fetch({ limit: 25 });
					const mine = [...recent.values()]
						.filter((candidate) => candidate.author?.id === selfId)
						.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
					message = (contains ? mine.find((candidate) => normalize(candidate.content ?? '').includes(contains)) : mine[0]) ?? null;
				}
				if (!message) return { ok: false, spoken: t('tools.messaging.edit_target_not_found') };
				if (message.author?.id !== selfId) {
					return { ok: false, spoken: t('tools.messaging.edit_only_own') };
				}
				const before = String(message.content ?? '').slice(0, 100);
				const edited = await message.edit({ content: text.slice(0, 2000) });
				deps.log?.(t('tools.messaging.log_edited', { channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.messaging.edited', { text: text.slice(0, 90) }),
					data: { channel: channel.name, message_id: edited?.id ?? message.id, before },
				};
			} catch (err) {
				return failure(deps, 'message edit failed', err, t('tools.messaging.edit_failed'));
			}
		},
	}),

	defineTool({
		name: 'list_bots',
		description: 'Lists the bots on the server and which of them are authorised for use.',
		async handler(args, deps) {
			const bots = deps.memberIndex?.bots(authorizedBotSet(deps)) ?? [];
			if (!bots.length) return { ok: true, spoken: t('tools.messaging.no_bots'), data: { bots: [] } };
			const authorized = bots.filter((bot) => bot.authorized).map((bot) => bot.name);
			const others = bots.filter((bot) => !bot.authorized).map((bot) => bot.name);
			const parts = [];
			if (authorized.length) parts.push(t('tools.messaging.bots_authorized', { names: authorized.join(', ') }));
			if (others.length) parts.push(t('tools.messaging.bots_unauthorized', { names: others.join(', ') }));
			deps.log?.(t('tools.messaging.log_bots', { parts: parts.join(' | ') }));
			return { ok: true, spoken: t('tools.messaging.bots_list', { parts: parts.join('; ') }), data: { bots } };
		},
	}),

	defineTool({
		name: 'use_bot',
		description:
			'Uses an authorised bot on the server: writes the command into a text channel in the form that bot understands (e.g. "play song ' +
			'name" for a music bot). For music, prefer my own play_music tool first. Owner only: the other bot runs the ' +
			'command with this bot as the requester, so it must not become a way around the owner gate.',
		parameters: P.obj(
			{
				bot: P.str('Bot name (empty = the single authorised bot is used)'),
				command: P.str('Bot command; e.g. "play Faithless Insomnia"'),
				channel: P.str('Text channel to write the command into (default: the configured channel)'),
				mention: P.bool('Write the command tagging the bot (default true)'),
			},
			['command'],
		),
		gate: { keywords: WORDS.bot },
		async handler(args, deps) {
			const bots = deps.memberIndex?.bots(authorizedBotSet(deps)) ?? [];
			const authorized = bots.filter((bot) => bot.authorized);
			const wanted = String(args.bot ?? '').trim();

			let target = null;
			if (wanted) {
				target = pickBest(
					authorized.map((bot) => ({ id: bot.id, display: bot.name, names: [normalize(bot.name)] })),
					normalize(wanted),
				);
				if (!target) {
					const known = bots.find((bot) => normalize(bot.name) === normalize(wanted));
					return {
						ok: false,
						spoken: known
							? t('tools.messaging.bot_not_authorized', { bot: known.name })
							: t('tools.messaging.bot_not_found', { name: wanted }),
					};
				}
			} else if (authorized.length === 1) {
				target = { id: authorized[0].id, display: authorized[0].name, names: [normalize(authorized[0].name)] };
			} else if (!authorized.length) {
				return { ok: false, spoken: t('tools.messaging.no_authorized_bot') };
			} else {
				return {
					ok: false,
					spoken: t('tools.messaging.many_authorized_bots', { names: authorized.map((bot) => bot.name).join(', ') }),
				};
			}

			const channel =
				(typeof args.channel === 'string' && args.channel ? findChannelByName(textChannels(deps), args.channel) : null) ??
				(deps.cfg.botCommandChannelId ? (deps.guild.channels.cache.get(deps.cfg.botCommandChannelId) ?? null) : null) ??
				resolveTextChannel(deps, null);
			if (!channel) {
				return { ok: false, spoken: t('tools.messaging.no_command_channel') };
			}

			const raw = String(args.command ?? '').trim();
			if (!raw) return { ok: false, spoken: t('tools.messaging.no_bot_command') };
			const prefix = deps.cfg.botPrefix ?? '!';
			const body = prefix && !raw.startsWith(prefix) ? `${prefix}${raw}` : raw;
			const content = args.mention === false ? body : `<@${target.id}> ${body}`;

			try {
				const message = await channel.send({ content: content.slice(0, 2000) });
				deps.log?.(t('tools.messaging.log_bot_command', { bot: target.display, channel: channel.name, content }));
				return {
					ok: true,
					spoken: t('tools.messaging.bot_command_sent', { bot: target.display, channel: channel.name, command: body }),
					data: { bot: target.display, channel: channel.name, command: body, message_id: message.id },
				};
			} catch (err) {
				return failure(deps, 'bot command send failed', err, t('tools.messaging.bot_command_failed'));
			}
		},
	}),
];
