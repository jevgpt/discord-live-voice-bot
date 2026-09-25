// MAX_LIVE_SESSIONS, counted and handed out. The registry in src/index.js owns the sessions; these two
// functions are the whole of its rule, kept apart so that the rule can be tested without a Discord
// client.
//
// A server holds a slot while it has a realtime session open, still connecting, or still closing: a
// session that has been told to close keeps its socket (and its bill) until the socket is gone, which can
// take seconds, and counting it only from the moment it was told to close let a second server open while
// the first was still connected.

/**
 * How many servers hold a realtime slot, not counting `except` (the server asking: its own session,
 * open or closing, never stands in its own way).
 * @param {Iterable<object>} sessions GuildSession-like objects with holdsLiveSlot()
 */
export function liveSlotsTaken(sessions, except = null) {
	let count = 0;
	for (const session of sessions) {
		if (session !== except && session.holdsLiveSlot()) count++;
	}
	return count;
}

/**
 * A slot came free: it is offered to the servers that were held back by the cap, the one that has waited
 * longest first. A server takes it only when somebody is there to talk to (takeLiveSlot decides), so an
 * empty channel does not spend a slot that a busy one is waiting for; it asks again when somebody speaks.
 * Several slots may have come free at once, so the offer goes on until the cap is reached again.
 * @returns {object[]} the servers that took a slot
 */
export function offerLiveSlots(sessions, max) {
	const all = [...sessions];
	const waiting = all.filter((session) => session.liveBlockedReason).sort((a, b) => (a.liveBlockedSince ?? 0) - (b.liveBlockedSince ?? 0));
	const taken = [];
	for (const session of waiting) {
		if (liveSlotsTaken(all, session) >= max) break;
		if (session.takeLiveSlot()) taken.push(session);
	}
	return taken;
}
