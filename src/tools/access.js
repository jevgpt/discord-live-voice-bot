// Who is asking, and what that person may have the bot do for them.
//
// The owner gate answers one question: did the owner ask for this? Most tools are open to everybody,
// and an open tool still has a narrower question to answer before it acts in the bot's name: may THIS
// person read that channel, is this note theirs, is that the person they want the bot to write to. The
// bot can see and send far more than any member can, so every answer here is measured against the person
// asking, never against the bot.

import { PermissionFlagsBits } from 'discord.js';
import { isPrivileged } from '../auth.js';

// How far back the line behind a turn may lie. A tool call can arrive well after the model started
// answering (the backend thinks first, and a second call follows the first), and the attribution keeps a
// minute of lines. The gate's fifteen-second window would drop the line and hand the question back to
// Discord's speaking events, which is the guess this replaces.
const TURN_LINE_WINDOW_MS = 60_000;

/**
 * The person whose line produced a turn: the last line heard before the model started answering, as
 * the attribution named it. That is the name the model itself was given for the line, so a tool acting
 * for "me" acts for the same person the model thinks it is talking to.
 *
 * `fallback` (Discord's last speaking event) is used only when there is no line to go on: no turn, a
 * transcript still on its way, or nothing heard in the window. A line that names nobody (two voices at
 * once) gives null, not the fallback: the model was told the line could not be named, and guessing from
 * speaking events there is how a cough from somebody else became the author of a request.
 * @param {{ lastUtterance?: Function, transcriptLagging?: Function, ownerId?: string|null }|null} attribution
 * @param {object|null} turn the pinned turn ({ at, audioMs })
 * @param {string|null} fallback
 * @returns {string|null}
 */
export function speakerOfTurn(attribution, turn, fallback = null) {
	const guess = fallback === null || fallback === undefined || fallback === '' ? null : String(fallback);
	if (!turn || typeof attribution?.lastUtterance !== 'function') return guess;
	// The transcript of the line that triggered the turn has not arrived yet, so the newest line on
	// record belongs to an earlier turn and would name whoever spoke before.
	if (typeof attribution.transcriptLagging === 'function' && attribution.transcriptLagging({ turn })) return guess;
	const line = attribution.lastUtterance({ turn, windowMs: TURN_LINE_WINDOW_MS });
	if (!line) return guess;
	if (line.id) return String(line.id);
	if (line.owner && attribution.ownerId) return String(attribution.ownerId);
	return null;
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
 */
export async function canReadChannel(deps, channel, userId) {
	if (typeof channel?.permissionsFor !== 'function') return false;
	const subject = (await memberFor(deps, userId)) ?? deps?.guild?.roles?.everyone ?? null;
	if (!subject) return false;
	let permissions = null;
	try {
		permissions = channel.permissionsFor(subject);
	} catch {
		permissions = null;
	}
	if (typeof permissions?.has !== 'function') return false;
	return Boolean(permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory));
}
