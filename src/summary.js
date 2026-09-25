// Conversation summary: builds a short summary from the voice transcripts and the channel/DM messages in
// the panel log. "What was talked about today?" (the voice tool) and the summary slash command both go through here.
//
// The panel log is ONE buffer for the whole process: every text channel of every server the bot serves
// lands in it, moderator channels included, next to the voice transcripts of every session. A summary is
// therefore always cut down to the server it was asked in (guildScope) and, message by message, to the
// channels the people it is for could read themselves (channelFilterFor). A voice line is placed by the
// voice channel it was said in, and the bot's own spoken lines, which repeat whatever it was asked to
// read, are left out for anybody not trusted with everything. All of it fails closed: an event that
// cannot be placed is left out rather than guessed into somebody's summary.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { t } from './i18n/index.js';
import { providerFromDeps } from './provider.js';

const KINDS = new Set(['voice', 'channel', 'dm']);

// Reading a channel's past is what a summary does, so both are needed: View Channel alone shows only
// what arrives while the member is looking.
const READ_HISTORY = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
// What was said in a voice channel was heard by the people who could go in: see it, and connect.
const HEAR_VOICE = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];

/**
 * May this reader read the channel's history (or, for a voice line, have been in the voice channel)?
 * `reader` is a GuildMember; null stands for somebody the bot cannot place (no speaker known, a member it
 * has not cached) and is judged as @everyone, the least anyone in the server can see.
 */
function mayRead(channel, reader, need = READ_HISTORY) {
	const subject = reader ?? channel.guild?.roles?.everyone ?? null;
	if (!subject) return false;
	let permissions = null;
	try {
		permissions = channel.permissionsFor?.(subject) ?? null;
	} catch {
		// Something that is not a whole member (a raw interaction payload) cannot be judged, so it reads nothing.
		return false;
	}
	if (!permissions?.has?.(need)) return false;
	// A private thread takes more than its parent's permissions: being in it, or managing threads.
	if (channel.type === ChannelType.PrivateThread) {
		if (permissions.has(PermissionFlagsBits.ManageThreads)) return true;
		return Boolean(reader?.id && channel.members?.cache?.has?.(reader.id));
	}
	return true;
}

/**
 * The channels a summary may quote for `readers`: a channel message is kept only when EVERY one of them
 * may read that channel, because a spoken summary is heard by the whole room and not just the person who
 * asked. A voice line is kept the same way, by its voice channel, which they must all be able to see and
 * connect to (`{ voice: true }`). An empty list is judged as @everyone. A channel the server no longer
 * has (deleted, or never cached) and an event logged without its channel id are left out.
 * @returns {(channelId: string|null, options?: { voice?: boolean }) => boolean}
 */
export function channelFilterFor(guild, readers = []) {
	const list = readers?.length ? readers : [null];
	const verdicts = new Map();
	return (channelId, { voice = false } = {}) => {
		if (!channelId) return false;
		const id = String(channelId);
		const key = `${voice ? 'voice' : 'text'}:${id}`;
		if (!verdicts.has(key)) {
			const channel = guild?.channels?.cache?.get?.(id) ?? null;
			verdicts.set(key, Boolean(channel) && list.every((reader) => mayRead(channel, reader, voice ? HEAR_VOICE : READ_HISTORY)));
		}
		return verdicts.get(key);
	};
}

/**
 * Does an event belong to this server? A message logged by src/index.js carries the guild id and is
 * matched on it. A voice line carries only the label GuildSession stamps on everything it records (the
 * server's name, or its id when it has none), so it is matched on that, unless another server the bot is
 * in goes by the same label: then a label says nothing about which of the two it came from, and such
 * lines are left out. A DM belongs to no server and never matches.
 * @returns {(event: object) => boolean}
 */
export function guildScope(guild, client = null) {
	const id = guild?.id ? String(guild.id) : null;
	if (!id) return () => false;
	const label = guild.name ?? guild.id;
	const others = [...(client?.guilds?.cache?.values?.() ?? [])];
	const labelIsUnique = !others.some((other) => String(other?.id) !== id && (other?.name ?? other?.id) === label);
	return (event) => {
		const meta = event?.meta ?? null;
		if (meta?.guildId) return String(meta.guildId) === id;
		return labelIsUnique && meta?.guild !== undefined && meta?.guild !== null && meta.guild === label;
	};
}

/**
 * Turns the events to be summarised into plain text (maxChars at most). `inGuild` and `canRead` narrow it
 * down to one server and to the channels the audience may read; summarizeConversation always passes both,
 * and passes no `canRead` only for an audience trusted with everything.
 */
export function transcriptFromEvents(
	events,
	{ sinceMs = null, maxChars = 6000, includeDm = false, nameFor = null, inGuild = null, canRead = null } = {},
) {
	const lines = [];
	for (const event of events) {
		if (!KINDS.has(event.kind)) continue;
		if (event.kind === 'dm' && !includeDm) continue;
		if (inGuild && !inGuild(event)) continue;
		if (canRead && event.kind === 'channel' && !canRead(event.meta?.channelId ?? null)) continue;
		if (canRead && event.kind === 'voice') {
			// A voice line is from a room too: a voice channel the audience may not be able to go into, placed
			// by the channel id GuildSession stamps on it (a line without one cannot be placed and stays out).
			// And the bot's own lines are left out altogether: what it said out loud includes whatever it was
			// asked to read, and "In #mod-chat, mod1 wrote..." read to the owner is #mod-chat by another road.
			if (event.direction === 'out') continue;
			if (!canRead(event.meta?.channelId ?? null, { voice: true })) continue;
		}
		if (sinceMs && Date.parse(event.at) < sinceMs) continue;
		const text = String(event.text ?? '').trim();
		if (!text) continue;
		const who = event.whoName ?? (event.who ? (nameFor?.(event.who) ?? event.who) : event.direction === 'out' ? 'bot' : '?');
		const time = new Date(event.at).toISOString().slice(11, 16);
		lines.push(`[${time}] ${who}: ${text}`);
	}
	let body = lines.join('\n');
	if (body.length > maxChars) body = `…${body.slice(-maxChars)}`;
	return { text: body, count: lines.length };
}

/**
 * Produces the summary. `events` is ActivityLog.events; `hours` is the window to look back over (0 = everything).
 *
 * Only the events of deps.guild (the session's own server) are used. `audience` says who the summary is
 * for: `{ everything: true }` takes every channel of that server (the people /read already trusts),
 * `{ readers: [GuildMember|null, ...] }` only the channels all of them may read. Left out, it is judged
 * as @everyone, so a caller that forgets to say gets the least, not the most.
 * @returns {Promise<{ summary: string, count: number }>}
 */
export async function summarizeConversation(deps, { events, hours = 3, spoken = true, audience = null } = {}) {
	const provider = providerFromDeps(deps);
	const sinceMs = hours > 0 ? Date.now() - hours * 3_600_000 : null;
	const guild = deps.guild ?? null;
	const { text, count } = transcriptFromEvents(events ?? [], {
		sinceMs,
		nameFor: deps.nameFor ?? null,
		inGuild: guildScope(guild, deps.client ?? null),
		canRead: audience?.everything === true ? null : channelFilterFor(guild, audience?.readers ?? []),
	});
	if (!count) return { summary: t('summary.nothing_to_summarize'), count: 0 };
	if (!provider.available) return { summary: t('summary.provider_missing'), count };
	const instructions = spoken ? t('summary.instructions_spoken') : t('summary.instructions_written');
	try {
		const summary = await provider.complete({
			instructions,
			input: `<transcript>\n${text}\n</transcript>`,
			timeoutMs: 45_000,
			maxTokens: spoken ? 300 : 600,
		});
		return { summary: String(summary ?? '').trim() || t('summary.empty'), count };
	} catch (err) {
		deps.log?.(t('summary.log_failed', { error: err.message }));
		return { summary: t('summary.failed'), count };
	}
}
