// Who is asking, and what that person may have the bot do for them.
//
// The owner gate answers one question: did the owner ask for this? Most tools are open to everybody,
// and an open tool still has a narrower question to answer before it acts in the bot's name: may THIS
// person read that channel, is this note theirs, is that the person they want the bot to write to. The
// bot can see and send far more than any member can, so every answer here is measured against the person
// asking, never against the bot.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isPrivileged } from '../auth.js';

// How far back the line behind a turn may lie. A tool call can arrive well after the model started
// answering (the backend thinks first, and a second call follows the first), and the attribution keeps a
// minute of lines. The gate's fifteen-second window would drop the line and leave the request unnamed.
const TURN_LINE_WINDOW_MS = 60_000;

/**
 * The person whose request a turn answers: the last line heard before the model started answering, and
 * whatever ran straight into it, as the attribution named them. That is the name the model itself was
 * given for the line, so a tool acting for "me" acts for the same person the model thinks it is talking to.
 *
 * Whatever this names reads staff channels, recalls notes and writes to people as that person, and the
 * owner's name reads everything, so it names somebody only when the audio is sure, and nobody otherwise:
 *  - a line that was only leaning towards somebody (the owner alone for part of it and a guest talking
 *    over the rest) names nobody, although the owner's voice is in it;
 *  - the owner's name goes only on a line that was the owner's by the gate's own test (alone in the
 *    audio), never on one that merely carries the owner's id;
 *  - a request whose lines are two people's (a guest asks, the owner says "hmm" before the model
 *    answers) names nobody: whose request it was cannot be heard;
 *  - no turn, a transcript still on its way, nothing heard: nobody. Discord's last speaking event used to
 *    stand in here, and it is whoever made a sound while the model worked, a cough included.
 * Nobody is judged as @everyone by every check that asks, which is the least anybody present can do.
 * @param {{ requestSpeaker?: Function, lastUtterance?: Function, transcriptLagging?: Function, ownerId?: string|null }|null} attribution
 * @param {object|null} turn the pinned turn ({ at, audioMs })
 * @returns {string|null}
 */
export function speakerOfTurn(attribution, turn) {
	if (!turn || !attribution) return null;
	const lineOf =
		typeof attribution.requestSpeaker === 'function'
			? (options) => attribution.requestSpeaker(options)
			: typeof attribution.lastUtterance === 'function'
				? (options) => attribution.lastUtterance(options)
				: null;
	if (!lineOf) return null;
	// The transcript of the line that triggered the turn has not arrived yet, so the newest line on
	// record belongs to an earlier turn and would name whoever spoke before.
	if (typeof attribution.transcriptLagging === 'function' && attribution.transcriptLagging({ turn })) return null;
	const line = lineOf({ turn, windowMs: TURN_LINE_WINDOW_MS });
	if (!line || line.shared || line.sure === false) return null;
	const ownerId = attribution.ownerId ? String(attribution.ownerId) : null;
	if (line.owner) return ownerId ?? (line.id ? String(line.id) : null);
	if (!line.id) return null;
	// The owner's id on a line that was not the owner's alone: the owner's authority does not go on it,
	// and neither does anybody else's name.
	if (ownerId && String(line.id) === ownerId) return null;
	return String(line.id);
}

/** The person asking, as an id string, or null when nobody can be named. */
export function requesterId(deps) {
	const id = deps?.currentSpeakerId?.() ?? null;
	return id === null || id === undefined || id === '' ? null : String(id);
}

/** Is this id the bot owner (OWNER_ID)? */
export function isOwnerId(deps, id) {
	const owner = String(deps?.cfg?.ownerId ?? '').trim();
	return Boolean(owner && id && String(id) === owner);
}

/** Is the person asking the bot owner? */
export function requesterIsOwner(deps) {
	return isOwnerId(deps, requesterId(deps));
}

/** The member behind an id, from the cache or Discord; null when they cannot be found. */
async function memberFor(deps, id) {
	if (!id) return null;
	const members = deps?.guild?.members;
	const cached = members?.cache?.get?.(String(id));
	if (cached) return cached;
	if (typeof members?.fetch !== 'function') return null;
	const fetched = await members.fetch(String(id)).catch(() => null);
	// A fetch by id answers with that member; anything else (a collection, nothing) is not them.
	return fetched && String(fetched.id) === String(id) ? fetched : null;
}

/**
 * Is the person asking an administrator the way the slash commands count one (src/auth.js): the owner,
 * ADMIN_USER_IDS, a holder of one of ADMIN_ROLE_IDS, or a member with Manage Server?
 */
export async function requesterPrivileged(deps) {
	const id = requesterId(deps);
	if (!id) return false;
	return isPrivileged({ userId: id, member: await memberFor(deps, id), cfg: deps?.cfg ?? {} });
}

/**
 * Could this person read the channel on their own: see it, and read what was written before? The bot
 * reading a channel out loud hands its contents to whoever asked, so the asker's own permissions decide.
 * Somebody who cannot be named, or cannot be found on the server, is measured against @everyone: what
 * anybody in the room could read anyway. A channel that carries no permissions to check is refused.
 *
 * A private thread answers permissionsFor with its parent's permissions, which everybody in the parent
 * channel has; the thread itself is for the people in it. So it also takes membership, or Manage Threads
 * (the same rule src/summary.js reads a thread by).
 */
export async function canReadChannel(deps, channel, userId) {
	if (typeof channel?.permissionsFor !== 'function') return false;
	const member = await memberFor(deps, userId);
	const subject = member ?? deps?.guild?.roles?.everyone ?? null;
	if (!subject) return false;
	let permissions = null;
	try {
		permissions = channel.permissionsFor(subject);
	} catch {
		permissions = null;
	}
	if (typeof permissions?.has !== 'function') return false;
	if (!permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) return false;
	if (channel.type === ChannelType.PrivateThread) {
		if (permissions.has(PermissionFlagsBits.ManageThreads)) return true;
		if (!member?.id) return false;
		const id = String(member.id);
		if (channel.members?.cache?.has?.(id)) return true;
		// The thread's member list is not always cached; asking Discord answers a member who is not in it
		// with an error, which is a no.
		if (typeof channel.members?.fetch !== 'function') return false;
		return Boolean(await channel.members.fetch(id).catch(() => null));
	}
	return true;
}

/** Could anybody on the server read this channel: is it open to @everyone? */
export async function everyoneMayRead(deps, channel) {
	return canReadChannel(deps, channel, null);
}

/**
 * May everybody in the bot's voice channel read this channel? Whatever the bot says there is heard by all
 * of them, so reading a channel out loud is reading it to each of them. Nobody in the room (the bot is not
 * in one) holds nobody back.
 */
export async function roomMayRead(deps, channel) {
	const room = typeof deps?.currentVoiceChannel === 'function' ? deps.currentVoiceChannel() : null;
	for (const member of room?.members?.values?.() ?? []) {
		if (!member || member.user?.bot) continue;
		if (!(await canReadChannel(deps, channel, member.id))) return false;
	}
	return true;
}
