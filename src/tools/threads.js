// Thread tools: start a thread or a forum post, rename, archive, lock, membership, listing,
// join/leave, delete (confirmed).

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
	selfIdOf,
} from './helpers.js';
import { findChannelByName, normalize } from '../text.js';
import { t } from '../i18n/index.js';
import { P, defineTool } from './registry.js';

// The three kinds of thread Discord has. A forum/media post is a PublicThread whose parent is a forum.
const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
// Channels where a thread is started from a name alone (and, in a text channel, may be private).
const TEXT_PARENTS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
// Channels where every thread IS a post, so Discord demands a message body with it.
const POST_PARENTS = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);
// Discord accepts only these four auto-archive values (1 hour, 1 day, 3 days, 1 week), in minutes.
const AUTO_ARCHIVE_MINUTES = [60, 1440, 4320, 10080];
// Discord caps a thread name at 100 characters, a forum post body at 2000, and applied tags at 5.
const MAX_NAME = 100;
const MAX_BODY = 2000;
const MAX_APPLIED_TAGS = 5;
const MAX_LISTED = 40;

/** Permission flag -> the name said out loud in a refusal. Written with literal keys so the locale check sees them. */
function permissionName(flag) {
	const names = {
		ManageThreads: t('tools.threads.perm_manage_threads'),
		CreatePublicThreads: t('tools.threads.perm_create_public_threads'),
		CreatePrivateThreads: t('tools.threads.perm_create_private_threads'),
		SendMessagesInThreads: t('tools.threads.perm_send_messages_in_threads'),
		SendMessages: t('tools.threads.perm_send_messages'),
	};
	return names[flag] ?? flag;
}

/**
 * Does the bot hold `flag` here? `null` means "cannot tell" (no member cache, a channel object without
 * permissionsFor): the call is then attempted and the API gets the final word, because refusing on a
 * blind guess would block work the bot is actually allowed to do.
 */
function botHolds(deps, channel, flag) {
	const me = deps.guild.members?.me ?? null;
	if (!me || typeof channel?.permissionsFor !== 'function') return null;
	const permissions = channel.permissionsFor(me);
	if (!permissions?.has) return null;
	return permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits[flag]);
}

/** A refusal naming the permission the bot is missing, or null when it may go ahead. */
function permissionRefusal(deps, channel, flag) {
	if (botHolds(deps, channel, flag) !== false) return null;
	return { ok: false, spoken: t('tools.threads.need_permission', { permission: permissionName(flag), channel: channel.name }) };
}

/**
 * Editing a thread needs Manage Threads -- except for whoever started it, who may rename and archive
 * their own thread. The bot is that person whenever it opened the thread itself.
 */
function manageRefusal(deps, thread) {
	const self = selfIdOf(deps);
	if (self && thread.ownerId === self) return null;
	return permissionRefusal(deps, thread, 'ManageThreads');
}

/** Discord refuses every edit to an archived thread except reopening it, so say that instead of failing. */
function archivedRefusal(thread) {
	if (!thread.archived) return null;
	return { ok: false, spoken: t('tools.threads.thread_archived', { thread: thread.name }) };
}

function cachedThreads(deps) {
	return [...deps.guild.channels.cache.values()].filter((channel) => THREAD_TYPES.has(channel.type));
}

/**
 * Thread by name or id. A thread nobody has touched this session is often missing from the cache, so a
 * miss falls back to the guild's active-thread list. Archived threads are deliberately out of reach:
 * they are only listable per parent channel, and someone naming a thread out loud means a live one.
 */
async function resolveThread(deps, nameOrThread) {
	if (nameOrThread && typeof nameOrThread === 'object') return nameOrThread;
	const needle = String(nameOrThread ?? '').trim();
	if (!needle) return null;
	const id = needle.replace(/^#/, '');
	const cached = cachedThreads(deps);
	const hit = cached.find((thread) => thread.id === id) ?? findChannelByName(cached, needle);
	if (hit) return hit;
	const fetched = (await deps.guild.channels.fetchActiveThreads?.().catch(() => null)) ?? null;
	const live = [...(fetched?.threads?.values?.() ?? [])];
	if (!live.length) return null;
	return live.find((thread) => thread.id === id) ?? findChannelByName(live, needle) ?? null;
}

/** Hours asked for -> the nearest value Discord accepts; anything else is rejected by the API. */
function autoArchiveMinutes(hours) {
	const value = Number(hours);
	if (!Number.isFinite(value) || value <= 0) return null;
	const minutes = value * 60;
	return AUTO_ARCHIVE_MINUTES.reduce((best, option) => (Math.abs(option - minutes) < Math.abs(best - minutes) ? option : best));
}

/** Forum tag names -> tag ids, plus the names that matched nothing. */
function resolveTags(channel, names) {
	const available = channel.availableTags ?? [];
	const ids = [];
	const unknown = [];
	for (const raw of Array.isArray(names) ? names : names ? [names] : []) {
		const key = normalize(raw);
		if (!key) continue;
		const tag =
			available.find((candidate) => normalize(candidate.name) === key) ??
			available.find((candidate) => normalize(candidate.name).startsWith(key));
		if (!tag) {
			unknown.push(String(raw));
			continue;
		}
		if (!ids.includes(tag.id) && ids.length < MAX_APPLIED_TAGS) ids.push(tag.id);
	}
	return { ids, unknown };
}

function threadSummary(thread) {
	return {
		id: thread.id,
		name: thread.name,
		parent: thread.parent?.name ?? null,
		parentId: thread.parentId ?? null,
		private: thread.type === ChannelType.PrivateThread,
		archived: thread.archived ?? null,
		locked: thread.locked ?? null,
		memberCount: thread.memberCount ?? null,
		messageCount: thread.messageCount ?? null,
	};
}

export const tools = [
	defineTool({
		name: 'list_threads',
		description:
			'Lists the threads and forum posts that are open right now, either in one channel or across the whole ' +
			'server. With a channel given, include_archived also brings back the closed (archived) ones. Read-only.',
		parameters: P.obj({
			channel: P.str('Channel to look in (leave empty for the whole server)'),
			include_archived: P.bool('true = also list that channel\'s archived threads (only works together with channel)'),
		}),
		async handler(args, deps) {
			const wanted = String(args.channel ?? '').trim();
			let parent = null;
			if (wanted) {
				parent = resolveAnyChannel(deps, wanted);
				if (!parent) return { ok: false, spoken: t('tools.threads.channel_not_found', { name: wanted }) };
				if (!parent.threads) return { ok: false, spoken: t('tools.threads.channel_has_no_threads', { channel: parent.name }) };
			}
			const found = new Map();
			const collect = (result) => {
				for (const thread of result?.threads?.values?.() ?? []) found.set(thread.id, thread);
			};
			const warnings = [];
			try {
				collect(parent ? await parent.threads.fetchActive() : await deps.guild.channels.fetchActiveThreads());
			} catch (err) {
				// A listing must not die on a fetch; fall back to whatever the cache already holds.
				deps.log?.(t('tools.threads.log_list_fetch_failed', { error: String(err?.message ?? err) }));
				for (const thread of cachedThreads(deps)) {
					if (!parent || thread.parentId === parent.id) found.set(thread.id, thread);
				}
			}
			if (parent && args.include_archived === true) {
				try {
					collect(await parent.threads.fetchArchived({ type: 'public' }));
				} catch (err) {
					deps.log?.(t('tools.threads.log_archived_failed', { error: String(err?.message ?? err) }));
					warnings.push(t('tools.threads.archived_unavailable'));
				}
			}
			const threads = [...found.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))).map(threadSummary);
			const spokenNames = threads
				.slice(0, MAX_LISTED)
				.map((thread) => (thread.archived ? t('tools.threads.list_entry_archived', { thread: thread.name }) : thread.name))
				.join(', ');
			const spoken = parent
				? threads.length
					? t('tools.threads.list_in_channel', { channel: parent.name, threads: spokenNames })
					: t('tools.threads.list_empty_channel', { channel: parent.name })
				: threads.length
					? t('tools.threads.list_server', { threads: spokenNames })
					: t('tools.threads.list_empty_server');
			return { ok: true, spoken, data: { channel: parent?.name ?? null, count: threads.length, threads }, ...(warnings.length ? { warnings } : {}) };
		},
	}),

	defineTool({
		name: 'start_thread',
		description:
			'Starts a thread in a text or announcement channel: on its own, or hanging off an existing message ' +
			'(message_id). private:true makes a thread only invited people can see. A forum or media channel needs ' +
			'create_forum_post instead, because a post there cannot exist without a message body. Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Channel to start the thread in'),
				name: P.str('Thread name (at most 100 characters)'),
				message_id: P.str('Id of the message the thread should hang off (optional; such a thread is always public)'),
				private: P.bool('true = private thread; only possible in a plain text channel and without message_id'),
				invitable: P.bool('Private thread only: may people without Manage Threads invite others (default false)'),
				auto_archive_hours: P.int('Close the thread after this many idle hours: 1, 24, 72 or 168 (default: the channel setting)'),
			},
			['channel', 'name'],
		),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const channel = resolveAnyChannel(deps, String(args.channel ?? ''));
			if (!channel) return { ok: false, spoken: t('tools.threads.channel_not_found', { name: args.channel }) };
			if (POST_PARENTS.has(channel.type)) return { ok: false, spoken: t('tools.threads.use_forum_post', { channel: channel.name }) };
			if (!TEXT_PARENTS.has(channel.type) || !channel.threads) {
				return { ok: false, spoken: t('tools.threads.not_a_text_channel', { channel: channel.name }) };
			}
			const name = String(args.name ?? '').trim().slice(0, MAX_NAME);
			if (!name) return { ok: false, spoken: t('tools.threads.name_required') };
			const fromMessage = String(args.message_id ?? '').trim();
			// A private thread that quietly comes out public would leak the conversation, so the two cases
			// where Discord cannot honour "private" are refused instead of downgraded.
			if (args.private === true && fromMessage) return { ok: false, spoken: t('tools.threads.private_from_message') };
			if (args.private === true && channel.type !== ChannelType.GuildText) {
				return { ok: false, spoken: t('tools.threads.private_needs_text', { channel: channel.name }) };
			}
			const wantsPrivate = args.private === true;
			const refusal = permissionRefusal(deps, channel, wantsPrivate ? 'CreatePrivateThreads' : 'CreatePublicThreads');
			if (refusal) return refusal;

			let startMessage = null;
			if (fromMessage) {
				startMessage = (await channel.messages?.fetch(fromMessage).catch(() => null)) ?? null;
				if (!startMessage) return { ok: false, spoken: t('tools.threads.message_not_found', { id: fromMessage }) };
				if (startMessage.hasThread) return { ok: false, spoken: t('tools.threads.message_has_thread') };
			}
			const minutes = autoArchiveMinutes(args.auto_archive_hours);
			try {
				const thread = await channel.threads.create({
					name,
					...(startMessage ? { startMessage } : {}),
					...(wantsPrivate ? { type: ChannelType.PrivateThread, invitable: args.invitable === true } : {}),
					...(minutes ? { autoArchiveDuration: minutes } : {}),
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.threads.log_started', { thread: thread.name, channel: channel.name }));
				return {
					ok: true,
					spoken: t(
						startMessage ? 'tools.threads.started_from_message' : wantsPrivate ? 'tools.threads.started_private' : 'tools.threads.started',
						{ thread: thread.name, channel: channel.name },
					),
					data: threadSummary(thread),
				};
			} catch (err) {
				return failure(deps, 'thread creation failed', err, t('tools.threads.start_failed'));
			}
		},
	}),

	defineTool({
		name: 'create_forum_post',
		description:
			'Creates a post in a forum or media channel. A post there is a thread with a message inside it, so the ' +
			'message body is required. tags picks from the tags that channel offers (at most five). Owner only.',
		parameters: P.obj(
			{
				channel: P.str('Forum or media channel'),
				name: P.str('Post title (at most 100 characters)'),
				message: P.str('The text of the first message in the post'),
				tags: P.list('Names of the forum tags to apply (at most five; unknown ones are reported back)'),
				auto_archive_hours: P.int('Close the post after this many idle hours: 1, 24, 72 or 168 (default: the channel setting)'),
			},
			['channel', 'name', 'message'],
		),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const channel = resolveAnyChannel(deps, String(args.channel ?? ''));
			if (!channel) return { ok: false, spoken: t('tools.threads.channel_not_found', { name: args.channel }) };
			if (!POST_PARENTS.has(channel.type) || !channel.threads) {
				return { ok: false, spoken: t('tools.threads.not_a_forum', { channel: channel.name }) };
			}
			const name = String(args.name ?? '').trim().slice(0, MAX_NAME);
			if (!name) return { ok: false, spoken: t('tools.threads.name_required') };
			const body = String(args.message ?? '').trim().slice(0, MAX_BODY);
			if (!body) return { ok: false, spoken: t('tools.threads.message_required') };
			// Discord ignores Create Public Threads in a forum: posting there is governed by Send Messages.
			const refusal = permissionRefusal(deps, channel, 'SendMessages');
			if (refusal) return refusal;

			const { ids, unknown } = resolveTags(channel, args.tags ?? []);
			const warnings = unknown.length ? [t('tools.threads.unknown_tags', { tags: unknown.join(', ') })] : [];
			const minutes = autoArchiveMinutes(args.auto_archive_hours);
			try {
				const thread = await channel.threads.create({
					name,
					message: { content: body },
					...(ids.length ? { appliedTags: ids } : {}),
					...(minutes ? { autoArchiveDuration: minutes } : {}),
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.threads.log_post_created', { thread: thread.name, channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.threads.post_created', { thread: thread.name, channel: channel.name }),
					data: { ...threadSummary(thread), tags: ids },
					...(warnings.length ? { warnings } : {}),
				};
			} catch (err) {
				return failure(deps, 'forum post creation failed', err, t('tools.threads.post_failed'));
			}
		},
	}),

	defineTool({
		name: 'rename_thread',
		description: 'Renames a thread or a forum post. The thread has to be open; an archived one is reopened first. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id'), name: P.str('New name (at most 100 characters)') }, ['thread', 'name']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const name = String(args.name ?? '').trim().slice(0, MAX_NAME);
			if (!name) return { ok: false, spoken: t('tools.threads.name_required') };
			const blocked = archivedRefusal(thread) ?? manageRefusal(deps, thread);
			if (blocked) return blocked;
			const before = thread.name;
			try {
				await thread.setName(name, t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.threads.log_renamed', { before, after: name }));
				return { ok: true, spoken: t('tools.threads.renamed', { thread: name }), data: { id: thread.id, before, name } };
			} catch (err) {
				return failure(deps, 'thread rename failed', err, t('tools.threads.rename_failed'));
			}
		},
	}),

	defineTool({
		name: 'archive_thread',
		description:
			'Archives a thread or forum post (closes it, keeping every message), or reopens an archived one with ' +
			'archived:false. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id'), archived: P.bool('true = archive (default), false = reopen') }, ['thread']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const archived = args.archived !== false;
			// Reopening an unlocked thread only needs Send Messages; everything else needs Manage Threads.
			const blocked = archived || thread.locked ? manageRefusal(deps, thread) : permissionRefusal(deps, thread, 'SendMessages');
			if (blocked) return blocked;
			try {
				await thread.setArchived(archived, t('tools.helpers.audit_reason'));
				deps.log?.(t(archived ? 'tools.threads.log_archived' : 'tools.threads.log_unarchived', { thread: thread.name }));
				return {
					ok: true,
					spoken: t(archived ? 'tools.threads.archived' : 'tools.threads.unarchived', { thread: thread.name }),
					data: { id: thread.id, name: thread.name, archived },
				};
			} catch (err) {
				return failure(deps, 'thread archive state unchanged', err, t('tools.threads.archive_failed'));
			}
		},
	}),

	defineTool({
		name: 'lock_thread',
		description:
			'Locks a thread or forum post so only moderators can reopen it, or unlocks it with locked:false. A locked ' +
			'thread still shows its messages. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id'), locked: P.bool('true = lock (default), false = unlock') }, ['thread']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const blocked = archivedRefusal(thread) ?? permissionRefusal(deps, thread, 'ManageThreads');
			if (blocked) return blocked;
			const locked = args.locked !== false;
			try {
				await thread.setLocked(locked, t('tools.helpers.audit_reason'));
				deps.log?.(t(locked ? 'tools.threads.log_locked' : 'tools.threads.log_unlocked', { thread: thread.name }));
				return {
					ok: true,
					spoken: t(locked ? 'tools.threads.locked' : 'tools.threads.unlocked', { thread: thread.name }),
					data: { id: thread.id, name: thread.name, locked },
				};
			} catch (err) {
				return failure(deps, 'thread lock unchanged', err, t('tools.threads.lock_failed'));
			}
		},
	}),

	defineTool({
		name: 'add_thread_member',
		description: 'Adds somebody to a thread, which is how a person gets into a private thread. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id'), member: P.str('Person name, mention or id') }, ['thread', 'member']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.threads.member_not_found', { name: args.member }) };
			const blocked = archivedRefusal(thread) ?? permissionRefusal(deps, thread, 'SendMessagesInThreads');
			if (blocked) return blocked;
			const who = displayName(member);
			try {
				// No reason is passed: Discord does not record one for thread membership and discord.js
				// warns that the parameter is deprecated.
				await thread.members.add(member.id);
				deps.log?.(t('tools.threads.log_member_added', { who, thread: thread.name }));
				return {
					ok: true,
					spoken: t('tools.threads.member_added', { who, thread: thread.name }),
					data: { id: thread.id, thread: thread.name, member: who, memberId: member.id },
				};
			} catch (err) {
				return failure(deps, 'thread member not added', err, t('tools.threads.add_member_failed'));
			}
		},
	}),

	defineTool({
		name: 'remove_thread_member',
		description: 'Removes somebody from a thread. They stay in the server and in every other channel. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id'), member: P.str('Person name, mention or id') }, ['thread', 'member']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.threads.member_not_found', { name: args.member }) };
			// Manage Threads is required, except in a private thread the bot started itself.
			const self = selfIdOf(deps);
			const ownsPrivate = thread.type === ChannelType.PrivateThread && self && thread.ownerId === self;
			const blocked = archivedRefusal(thread) ?? (ownsPrivate ? null : permissionRefusal(deps, thread, 'ManageThreads'));
			if (blocked) return blocked;
			const who = displayName(member);
			try {
				await thread.members.remove(member.id);
				deps.log?.(t('tools.threads.log_member_removed', { who, thread: thread.name }));
				return {
					ok: true,
					spoken: t('tools.threads.member_removed', { who, thread: thread.name }),
					data: { id: thread.id, thread: thread.name, member: who, memberId: member.id },
				};
			} catch (err) {
				return failure(deps, 'thread member not removed', err, t('tools.threads.remove_member_failed'));
			}
		},
	}),

	defineTool({
		name: 'join_thread',
		description: 'Makes the bot itself a member of a thread, so it follows and can write in it. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id') }, ['thread']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const blocked = archivedRefusal(thread);
			if (blocked) return blocked;
			try {
				await thread.join();
				deps.log?.(t('tools.threads.log_joined', { thread: thread.name }));
				return { ok: true, spoken: t('tools.threads.joined', { thread: thread.name }), data: { id: thread.id, name: thread.name } };
			} catch (err) {
				return failure(deps, 'thread join failed', err, t('tools.threads.join_failed'));
			}
		},
	}),

	defineTool({
		name: 'leave_thread',
		description: 'Takes the bot itself out of a thread. The thread and its messages stay exactly as they are. Owner only.',
		parameters: P.obj({ thread: P.str('Thread name or id') }, ['thread']),
		gate: { keywords: WORDS.thread },
		async handler(args, deps) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			try {
				await thread.leave();
				deps.log?.(t('tools.threads.log_left', { thread: thread.name }));
				return { ok: true, spoken: t('tools.threads.left', { thread: thread.name }), data: { id: thread.id, name: thread.name } };
			} catch (err) {
				return failure(deps, 'thread leave failed', err, t('tools.threads.leave_failed'));
			}
		},
	}),

	defineTool({
		name: 'delete_thread',
		description:
			'Deletes a thread or forum post along with everything written in it. Owner only; two-step (asks first, ' +
			'deletes with confirm:true).',
		parameters: P.obj(
			{ thread: P.str('Thread name or id'), reason: P.str('Reason (optional)'), confirm: P.confirm() },
			['thread'],
		),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			const thread = await resolveThread(deps, String(args.thread ?? ''));
			if (!thread) return { ok: false, spoken: t('tools.threads.thread_not_found', { name: args.thread }) };
			const blocked = permissionRefusal(deps, thread, 'ManageThreads');
			if (blocked) return blocked;
			const decision = checkConfirmation(deps, {
				key: name,
				target: thread.id,
				confirm: args.confirm,
				question: t('tools.threads.delete_question', { thread: thread.name }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { thread: thread.name });
			if (decision.stale) return STALE_CONFIRMATION();
			const threadName = thread.name;
			try {
				await thread.delete(args.reason ? String(args.reason).slice(0, 400) : t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.threads.log_deleted', { thread: threadName }));
				return { ok: true, spoken: t('tools.threads.deleted', { thread: threadName }), data: { name: threadName } };
			} catch (err) {
				return failure(deps, 'thread deletion failed', err, t('tools.threads.delete_failed'));
			}
		},
	}),
];
