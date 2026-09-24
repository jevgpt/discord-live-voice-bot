// Reaction, pin and poll tools: react to a message, take a reaction back, clear other people's
// reactions, pin / unpin, list the pins, open a poll and close one early.
//
// Discord permissions used here (discord.js 14.27 / API v10):
//   react            AddReactions (+ ReadMessageHistory to see the message at all)
//   own reaction off nothing beyond seeing the message
//   somebody else's  ManageMessages
//   pin / unpin      PinMessages (split out of ManageMessages on 2025-08-20 and required on its own
//                    since 2026-02-23; ManageMessages is still accepted here for servers that never
//                    re-granted the new node)
//   read the pins    ViewChannel + ReadMessageHistory
//   open a poll      SendPolls (on top of the usual SendMessages)
//   end a poll       none, but only the author of the poll may end it

import {
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	displayName,
	failure,
	findMember,
	ownerGate,
	resolveAnyChannel,
	resolveEmojis,
	resolveTextChannel,
	selfIdOf,
	trDate,
} from './helpers.js';
import { t } from '../i18n/index.js';
import { normalize } from '../text.js';
import { P, defineTool } from './registry.js';

// Poll limits straight from the API reference: at most 10 answers, 300 characters of question,
// 55 per answer, and a duration in whole hours of up to 32 days.
const POLL_MAX_ANSWERS = 10;
const POLL_QUESTION_MAX = 300;
const POLL_ANSWER_MAX = 55;
const POLL_MAX_HOURS = 768;
const POLL_DEFAULT_HOURS = 24;

// How far back we look when no message id was given, and how many pins one call reads.
const RECENT_LIMIT = 25;
const PIN_LIMIT = 50;

const CUSTOM_EMOJI_RE = /^<(a)?:([A-Za-z0-9_]{2,32}):(\d{17,20})>$/u;
const EMOJI_NAME_RE = /^:?([A-Za-z0-9_]{2,32}):?$/u;

/**
 * Does the bot hold ANY of these permissions in the channel? A channel object that cannot answer
 * (a partial, or a thread whose parent is not cached) counts as "yes": in that case the API call
 * itself gets the last word, and its error is explained instead.
 */
function botHas(deps, channel, ...flags) {
	const me = deps.guild.members?.me ?? null;
	const mine = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
	if (!mine?.has) return true;
	if (mine.has(PermissionFlagsBits.Administrator)) return true;
	return flags.some((flag) => mine.has(PermissionFlagsBits[flag]));
}

/**
 * The channel a message lives in. A plain name resolves as a text channel the usual way; anything
 * else the speaker names (a thread, the text chat of a voice room) is accepted as long as it
 * actually carries messages.
 * @returns {{ channel: object }|{ error: string }}
 */
function resolveMessageChannel(deps, name) {
	const wanted = typeof name === 'string' ? name.trim() : name;
	const channel = resolveTextChannel(deps, wanted || null) ?? (wanted ? resolveAnyChannel(deps, String(wanted)) : null);
	if (!channel) {
		return { error: wanted ? t('tools.reactions.channel_not_found', { name: wanted }) : t('tools.reactions.no_channel') };
	}
	if (typeof channel.messages?.fetch !== 'function') {
		return { error: t('tools.reactions.not_text_channel', { channel: channel.name }) };
	}
	return { channel };
}

/**
 * Target message, resolved the way edit_message does: by id, by the latest message holding a piece
 * of text, or the most recent message when nothing is given. An id that does not resolve is an
 * error rather than a silent fall back to the newest message -- reacting to or pinning the wrong
 * message is worse than refusing.
 * @returns {Promise<{ channel: object, message: object }|{ error: string }>}
 */
async function resolveTargetMessage(deps, { channel: channelName, messageId, contains }) {
	const found = resolveMessageChannel(deps, channelName);
	if (found.error) return found;
	const { channel } = found;
	if (messageId) {
		const byId = await channel.messages.fetch(String(messageId)).catch(() => null);
		if (!byId) return { error: t('tools.reactions.message_id_not_found', { id: String(messageId), channel: channel.name }) };
		return { channel, message: byId };
	}
	const recent = await channel.messages.fetch({ limit: RECENT_LIMIT }).catch(() => null);
	if (!recent) return { error: t('tools.reactions.read_failed', { channel: channel.name }) };
	// Discord hands them back newest first; we sort ourselves rather than trusting that order.
	const ordered = [...recent.values()].sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0));
	const needle = normalize(String(contains ?? ''));
	const message = (needle ? ordered.find((candidate) => normalize(candidate.content ?? '').includes(needle)) : ordered[0]) ?? null;
	if (!message) return { error: t('tools.reactions.message_not_found', { channel: channel.name }) };
	return { channel, message };
}

/**
 * Spoken emoji name, written custom emoji, emoji id or a unicode character -> what the API wants.
 * `value` goes to Discord, `key` is how the reaction is keyed in the message's reaction cache
 * (the emoji id for a server emoji, the character itself for a unicode one) and `label` is what
 * gets said out loud.
 * @returns {{ value: string, key: string, label: string }|{ missing: string }|null} null = nothing was given
 */
function resolveReactionEmoji(deps, raw) {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	const written = CUSTOM_EMOJI_RE.exec(text);
	if (written) return { value: text, key: written[3], label: `:${written[2]}:` };
	// A bare emoji id, the way the model echoes one back out of an earlier listing.
	if (/^\d{17,20}$/u.test(text)) {
		const byId = deps.guild.emojis?.cache?.get(text) ?? null;
		return byId ? { value: byId.toString(), key: byId.id, label: `:${byId.name}:` } : { missing: text };
	}
	const named = EMOJI_NAME_RE.exec(text);
	if (named) {
		// Only letters, digits and underscores: this is a NAME, so it has to be one of the server's
		// own emojis. resolveEmojis writes it out as <:name:id> (or <a:name:id> when it is animated).
		const { body, used } = resolveEmojis(deps, [named[1]], '');
		const custom = CUSTOM_EMOJI_RE.exec(body.trim());
		if (custom) return { value: body.trim(), key: custom[3], label: `:${used[0]}:` };
		return { missing: named[1] };
	}
	// Anything else is taken as a unicode emoji; Discord rejects a string that is not one.
	return { value: text, key: text, label: text };
}

/** Who wrote a message (the nickname when the member is cached, otherwise the account name). */
function authorName(message) {
	return displayName(message?.member ?? message?.author);
}

/** Shortened message text for a listing. */
function preview(message, length = 60) {
	const text = String(message?.content ?? '').replace(/\s+/gu, ' ').trim();
	if (!text) return t('tools.reactions.empty_message');
	return text.length > length ? `${text.slice(0, length)}…` : text;
}

export const tools = [
	defineTool({
		name: 'add_reaction',
		description:
			'Reacts to a message with an emoji. The emoji may be a unicode one ("👍") or the name of a server emoji ("party"). ' +
			'Without message_id it reacts to the most recent message in the channel; with contains, to the most recent message ' +
			'holding that text. This is how I show agreement or amusement without writing a message, so it needs no owner.',
		parameters: P.obj(
			{
				emoji: P.str('Emoji: a unicode emoji, or the name of a server emoji'),
				channel: P.str('Channel name (empty = the default channel)'),
				message_id: P.str('Id of the message to react to (optional)'),
				contains: P.str('React to the most recent message containing this text (optional)'),
			},
			['emoji'],
		),
		async handler(args, deps) {
			const emoji = resolveReactionEmoji(deps, args.emoji);
			if (!emoji) return { ok: false, spoken: t('tools.reactions.which_emoji') };
			if (emoji.missing) return { ok: false, spoken: t('tools.reactions.emoji_not_found', { name: emoji.missing }) };
			const found = await resolveTargetMessage(deps, { channel: args.channel, messageId: args.message_id, contains: args.contains });
			if (found.error) return { ok: false, spoken: found.error };
			const { channel, message } = found;
			// AddReactions is only needed for an emoji nobody has used yet, but we cannot tell that from a
			// cache that may be empty, so it is required up front: the refusal is more useful than a 50013.
			if (!botHas(deps, channel, 'AddReactions')) {
				return { ok: false, spoken: t('tools.reactions.no_add_reactions', { channel: channel.name }) };
			}
			try {
				await message.react(emoji.value);
				deps.log?.(t('tools.reactions.log_reacted', { emoji: emoji.label, channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.reactions.reacted', { emoji: emoji.label, who: authorName(message) }),
					data: { channel: channel.name, message_id: message.id, emoji: emoji.label },
				};
			} catch (err) {
				return failure(deps, 'reaction failed', err, t('tools.reactions.react_failed'));
			}
		},
	}),

	defineTool({
		name: 'remove_reaction',
		description:
			'Takes a single reaction off a message: mine by default, or one person\'s when member is given. ' +
			'Removing somebody else\'s reaction is owner only and needs the Manage Messages permission.',
		parameters: P.obj(
			{
				emoji: P.str('Emoji whose reaction should go: a unicode emoji, or the name of a server emoji'),
				channel: P.str('Channel name (empty = the default channel)'),
				message_id: P.str('Id of the message (optional; empty = the most recent message)'),
				contains: P.str('The most recent message containing this text (optional)'),
				member: P.str("Whose reaction to remove (optional; empty = my own). Owner only."),
			},
			['emoji'],
		),
		async handler(args, deps, { name }) {
			const emoji = resolveReactionEmoji(deps, args.emoji);
			if (!emoji) return { ok: false, spoken: t('tools.reactions.which_emoji') };
			if (emoji.missing) return { ok: false, spoken: t('tools.reactions.emoji_not_found', { name: emoji.missing }) };
			const selfId = selfIdOf(deps);
			const wanted = String(args.member ?? '').trim();
			const target = wanted ? await findMember(deps, wanted) : null;
			if (wanted && !target) return { ok: false, spoken: t('tools.reactions.member_not_found', { name: wanted }) };
			const someoneElse = Boolean(target) && target.id !== selfId;
			if (someoneElse) {
				// Taking a reaction off somebody else's behalf is moderation, not self-expression.
				const denied = await ownerGate(deps, WORDS.reaction, name);
				if (denied) return denied;
			}
			const found = await resolveTargetMessage(deps, { channel: args.channel, messageId: args.message_id, contains: args.contains });
			if (found.error) return { ok: false, spoken: found.error };
			const { channel, message } = found;
			if (someoneElse && !botHas(deps, channel, 'ManageMessages')) {
				return { ok: false, spoken: t('tools.reactions.need_manage_messages', { channel: channel.name }) };
			}
			const reaction = message.reactions?.cache?.get(emoji.key) ?? null;
			if (!reaction) return { ok: false, spoken: t('tools.reactions.no_such_reaction', { emoji: emoji.label }) };
			// `me` comes straight from the API for a fetched message; undefined only on a partial, and
			// then we simply try, because a wrong refusal is worse than a harmless 404.
			if (!someoneElse && reaction.me === false) {
				return { ok: false, spoken: t('tools.reactions.not_my_reaction', { emoji: emoji.label }) };
			}
			try {
				await reaction.users.remove(someoneElse ? target.id : undefined);
				if (someoneElse) {
					const who = displayName(target);
					deps.log?.(t('tools.reactions.log_removed_other', { emoji: emoji.label, who, channel: channel.name }));
					return {
						ok: true,
						spoken: t('tools.reactions.removed_other', { emoji: emoji.label, who }),
						data: { channel: channel.name, message_id: message.id, emoji: emoji.label, member: who },
					};
				}
				deps.log?.(t('tools.reactions.log_removed_own', { emoji: emoji.label, channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.reactions.removed_own', { emoji: emoji.label }),
					data: { channel: channel.name, message_id: message.id, emoji: emoji.label, member: null },
				};
			} catch (err) {
				return failure(deps, 'reaction removal failed', err, t('tools.reactions.remove_failed'));
			}
		},
	}),

	defineTool({
		name: 'clear_reactions',
		description:
			'Clears the reactions on a message: every reaction, or only the ones using one emoji when emoji is given. ' +
			'It throws away what other people left, so it is owner only and two-step (asks first, clears with confirm:true). ' +
			'Needs the Manage Messages permission.',
		parameters: P.obj({
			channel: P.str('Channel name (empty = the default channel)'),
			message_id: P.str('Id of the message (optional; empty = the most recent message)'),
			contains: P.str('The most recent message containing this text (optional)'),
			emoji: P.str('Clear only this emoji (optional; empty = every reaction)'),
			confirm: P.confirm(),
		}),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const emoji = resolveReactionEmoji(deps, args.emoji);
			if (emoji?.missing) return { ok: false, spoken: t('tools.reactions.emoji_not_found', { name: emoji.missing }) };
			const found = await resolveTargetMessage(deps, { channel: args.channel, messageId: args.message_id, contains: args.contains });
			if (found.error) return { ok: false, spoken: found.error };
			const { channel, message } = found;
			if (!botHas(deps, channel, 'ManageMessages')) {
				return { ok: false, spoken: t('tools.reactions.need_manage_messages', { channel: channel.name }) };
			}
			const reactions = [...(message.reactions?.cache?.values() ?? [])];
			if (!reactions.length) return { ok: false, spoken: t('tools.reactions.no_reactions') };
			const single = emoji ? (message.reactions?.cache?.get(emoji.key) ?? null) : null;
			if (emoji && !single) return { ok: false, spoken: t('tools.reactions.no_such_reaction', { emoji: emoji.label }) };
			const decision = checkConfirmation(deps, {
				key: name,
				target: `${message.id}:${emoji?.key ?? 'all'}`,
				confirm: args.confirm,
				question: emoji
					? t('tools.reactions.clear_question_emoji', { emoji: emoji.label, channel: channel.name })
					: t('tools.reactions.clear_question_all', { channel: channel.name }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { channel: channel.name, message_id: message.id });
			if (decision.stale) return STALE_CONFIRMATION();
			try {
				if (single) {
					const count = single.count ?? 0;
					await single.remove();
					deps.log?.(t('tools.reactions.log_cleared', { what: emoji.label, channel: channel.name }));
					return {
						ok: true,
						spoken: t('tools.reactions.cleared_emoji', { count, emoji: emoji.label }),
						data: { channel: channel.name, message_id: message.id, emoji: emoji.label, removed: count },
					};
				}
				const count = reactions.reduce((sum, entry) => sum + (entry.count ?? 0), 0);
				await message.reactions.removeAll();
				deps.log?.(t('tools.reactions.log_cleared', { what: t('tools.reactions.everything'), channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.reactions.cleared_all', { count }),
					data: { channel: channel.name, message_id: message.id, emoji: null, removed: count },
				};
			} catch (err) {
				return failure(deps, 'reaction clearing failed', err, t('tools.reactions.clear_failed'));
			}
		},
	}),

	defineTool({
		name: 'pin_message',
		description:
			'Pins a message to the channel, or unpins it with pinned:false. Without message_id it takes the most recent ' +
			'message in the channel; with contains, the most recent message holding that text. Owner only; needs the ' +
			'Pin Messages permission.',
		parameters: P.obj({
			channel: P.str('Channel name (empty = the default channel)'),
			message_id: P.str('Id of the message (optional; empty = the most recent message)'),
			contains: P.str('The most recent message containing this text (optional)'),
			pinned: P.bool('true = pin (default), false = unpin'),
			reason: P.str('Reason for the audit log (optional)'),
		}),
		gate: { keywords: WORDS.pin },
		async handler(args, deps) {
			const found = await resolveTargetMessage(deps, { channel: args.channel, messageId: args.message_id, contains: args.contains });
			if (found.error) return { ok: false, spoken: found.error };
			const { channel, message } = found;
			// PinMessages is the permission Discord requires now; ManageMessages is accepted as the older
			// spelling of the same right, so a server that never re-granted the new node still works.
			if (!botHas(deps, channel, 'PinMessages', 'ManageMessages')) {
				return { ok: false, spoken: t('tools.reactions.need_pin_messages', { channel: channel.name }) };
			}
			const pinning = args.pinned !== false;
			const who = authorName(message);
			if (pinning && message.pinned === true) {
				return {
					ok: true,
					spoken: t('tools.reactions.already_pinned', { channel: channel.name }),
					data: { channel: channel.name, message_id: message.id, pinned: true },
				};
			}
			if (!pinning && message.pinned === false) {
				return { ok: true, spoken: t('tools.reactions.not_pinned'), data: { channel: channel.name, message_id: message.id, pinned: false } };
			}
			const reason = args.reason ? String(args.reason).slice(0, 400) : t('tools.helpers.audit_reason');
			try {
				if (pinning) {
					await message.pin(reason);
					deps.log?.(t('tools.reactions.log_pinned', { channel: channel.name, who }));
					return {
						ok: true,
						spoken: t('tools.reactions.pinned', { who, channel: channel.name }),
						data: { channel: channel.name, message_id: message.id, pinned: true },
					};
				}
				await message.unpin(reason);
				deps.log?.(t('tools.reactions.log_unpinned', { channel: channel.name, who }));
				return {
					ok: true,
					spoken: t('tools.reactions.unpinned', { who, channel: channel.name }),
					data: { channel: channel.name, message_id: message.id, pinned: false },
				};
			} catch (err) {
				if (pinning) return failure(deps, 'pin failed', err, t('tools.reactions.pin_failed'));
				return failure(deps, 'unpin failed', err, t('tools.reactions.unpin_failed'));
			}
		},
	}),

	defineTool({
		name: 'list_pins',
		description: 'Lists the pinned messages of a channel: who wrote each one and how it starts.',
		parameters: P.obj({
			channel: P.str('Channel name (empty = the default channel)'),
			count: P.int('How many pins at most (1-50, default 10)'),
		}),
		async handler(args, deps) {
			const found = resolveMessageChannel(deps, args.channel);
			if (found.error) return { ok: false, spoken: found.error };
			const { channel } = found;
			if (!botHas(deps, channel, 'ReadMessageHistory')) {
				return { ok: false, spoken: t('tools.reactions.need_read_history', { channel: channel.name }) };
			}
			const limit = Math.max(1, Math.min(PIN_LIMIT, Math.round(Number(args.count ?? 10)) || 10));
			try {
				// fetchPins is the current, paginated endpoint; fetchPinned is deprecated in this version.
				const { items, hasMore } = await channel.messages.fetchPins({ limit });
				if (!items.length) {
					return { ok: true, spoken: t('tools.reactions.no_pins', { channel: channel.name }), data: { channel: channel.name, pins: [] } };
				}
				const pins = items.map((item) => ({
					message_id: item.message.id,
					author: authorName(item.message),
					text: preview(item.message),
					pinned_on: trDate(item.pinnedAt),
				}));
				const listed = pins.map((pin) => t('tools.reactions.pin_item', { who: pin.author, text: pin.text })).join(' | ');
				const spoken = t('tools.reactions.pins_list', { count: pins.length, channel: channel.name, items: listed });
				deps.log?.(t('tools.reactions.log_pins', { count: pins.length, channel: channel.name }));
				return {
					ok: true,
					spoken: hasMore ? `${spoken} ${t('tools.reactions.pins_more')}` : spoken,
					data: { channel: channel.name, pins, has_more: Boolean(hasMore) },
				};
			} catch (err) {
				return failure(deps, 'pin listing failed', err, t('tools.reactions.pins_failed', { channel: channel.name }));
			}
		},
	}),

	defineTool({
		name: 'create_poll',
		description:
			'Opens a Discord poll in a text channel: a question, two to ten answers and how many hours it stays open ' +
			'(default 24, at most 768 = 32 days). Set multiple:true to let people pick more than one answer. ' +
			'Needs the Send Polls permission.',
		parameters: P.obj(
			{
				question: P.str('The question (at most 300 characters)'),
				answers: P.list('The answers, 2 to 10 of them (at most 55 characters each)'),
				channel: P.str('Channel name (empty = the default channel)'),
				duration_hours: P.int('How many hours the poll stays open (1-768, default 24)'),
				multiple: P.bool('true = several answers may be picked (default false)'),
			},
			['question', 'answers'],
		),
		async handler(args, deps) {
			const found = resolveMessageChannel(deps, args.channel);
			if (found.error) return { ok: false, spoken: found.error };
			const { channel } = found;
			const question = String(args.question ?? '').trim().slice(0, POLL_QUESTION_MAX);
			if (!question) return { ok: false, spoken: t('tools.reactions.no_question') };
			const given = (Array.isArray(args.answers) ? args.answers : []).map((answer) => String(answer ?? '').trim()).filter(Boolean);
			const warnings = given.length > POLL_MAX_ANSWERS ? [t('tools.reactions.too_many_answers')] : [];
			const answers = given.slice(0, POLL_MAX_ANSWERS).map((text) => ({ text: text.slice(0, POLL_ANSWER_MAX) }));
			if (answers.length < 2) return { ok: false, spoken: t('tools.reactions.too_few_answers') };
			const asked = Math.round(Number(args.duration_hours ?? POLL_DEFAULT_HOURS));
			const hours = Number.isFinite(asked) && asked > 0 ? Math.min(POLL_MAX_HOURS, asked) : POLL_DEFAULT_HOURS;
			if (!botHas(deps, channel, 'SendPolls')) {
				return { ok: false, spoken: t('tools.reactions.need_send_polls', { channel: channel.name }) };
			}
			try {
				const message = await channel.send({
					poll: { question: { text: question }, answers, duration: hours, allowMultiselect: args.multiple === true },
				});
				const texts = answers.map((answer) => answer.text);
				deps.log?.(t('tools.reactions.log_poll', { channel: channel.name, question, answers: texts.length, hours }));
				return {
					ok: true,
					spoken: t('tools.reactions.poll_created', { channel: channel.name, question, answers: texts.join(', '), hours }),
					data: { channel: channel.name, message_id: message?.id ?? null, question, answers: texts, hours, multiple: args.multiple === true },
					warnings,
				};
			} catch (err) {
				return failure(deps, 'poll creation failed', err, t('tools.reactions.poll_failed'));
			}
		},
	}),

	defineTool({
		name: 'end_poll',
		description:
			'Ends a poll early and reads out the result. Discord only lets an author end their own poll, so this works on ' +
			'the polls I opened myself. Owner only.',
		parameters: P.obj({
			channel: P.str('Channel name (empty = the default channel)'),
			message_id: P.str('Id of the poll message (optional; empty = the most recent message)'),
			contains: P.str('The most recent message containing this text (optional)'),
		}),
		gate: { keywords: WORDS.delete },
		async handler(args, deps) {
			const found = await resolveTargetMessage(deps, { channel: args.channel, messageId: args.message_id, contains: args.contains });
			if (found.error) return { ok: false, spoken: found.error };
			const { channel, message } = found;
			const poll = message.poll ?? null;
			if (!poll) return { ok: false, spoken: t('tools.reactions.not_a_poll') };
			if (message.author?.id !== selfIdOf(deps)) {
				return { ok: false, spoken: t('tools.reactions.poll_not_mine', { who: authorName(message) }) };
			}
			// Discord refuses an expired poll with an error; saying so plainly is nicer than explaining a 400.
			const expired = Number.isFinite(poll.expiresTimestamp) && Date.now() > poll.expiresTimestamp;
			if (poll.resultsFinalized === true || expired) return { ok: false, spoken: t('tools.reactions.poll_already_ended') };
			try {
				const ended = await poll.end();
				const finished = ended?.poll ?? poll;
				const results = [...(finished.answers?.values?.() ?? [])].map((answer) => ({
					answer: answer.text ?? '',
					votes: answer.voteCount ?? 0,
				}));
				const spokenResults = results
					.map((entry) => t('tools.reactions.poll_result_item', { answer: entry.answer, votes: entry.votes }))
					.join(', ');
				deps.log?.(t('tools.reactions.log_poll_ended', { channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.reactions.poll_ended', { results: spokenResults || t('tools.reactions.no_votes') }),
					data: { channel: channel.name, message_id: message.id, results },
				};
			} catch (err) {
				return failure(deps, 'poll end failed', err, t('tools.reactions.end_failed'));
			}
		},
	}),
];
