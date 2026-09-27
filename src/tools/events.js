// Scheduled-event tools: list what is coming up, create one (voice channel, stage or somewhere outside
// Discord), edit it, cancel it (two-step) and say how many people are interested.
//
// Permissions (Discord): creating an event -- and editing or cancelling one the BOT itself created --
// needs "Create Events"; touching an event somebody else made needs "Manage Events". A voice or stage
// event additionally needs View Channel + Connect in that channel. Missing permissions are refused with
// the name of the permission instead of being sent to the API to fail.

import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventStatus } from 'discord.js';
import {
	ChannelType,
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	displayName,
	failure,
	resolveAnyChannel,
	selfIdOf,
} from './helpers.js';
import { t, tList } from '../i18n/index.js';
import { normalize } from '../text.js';
import { similarity } from '../matcher.js';
import { P, defineTool } from './registry.js';

// Discord's own limits (guild scheduled event object).
const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;
const LOCATION_MAX = 100;

// An event that has not happened yet, or is happening now; the rest is history.
const LIVE_STATUS = new Set([GuildScheduledEventStatus.Scheduled, GuildScheduledEventStatus.Active]);

// ---------------------------------------------------------------- speech -> time
//
// The time arrives through a microphone, so "in 2 hours" and "tomorrow at 21:00" have to work as well as
// an ISO timestamp. Everything below runs over normalize()d text (see src/text.js): that folds accents and
// strips punctuation, so the vocabulary can be written naturally in the locale files ("yarın") and still
// match what was heard ("yarin"), and no regex escaping is needed -- only [a-z0-9 ] survives normalisation.

/**
 * A vocabulary list from the locale bundle, normalised and longest-first.
 * The tool schemas are English, so the model often answers in English even when the conversation is not;
 * the active locale's words and the English ones are both accepted.
 */
function words(key) {
	const both = [...tList(`tools.events.${key}`), ...tList(`tools.events.${key}`, null, 'en')];
	return [...new Set(both.map((word) => normalize(word)).filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Matches any of `list` as a whole word, tolerating up to three letters of suffix ("gün" -> "güne"). */
function anyWord(text, list) {
	if (!list.length) return false;
	return new RegExp(String.raw`\b(?:${list.join('|')})[a-z]{0,3}\b`, 'u').test(text);
}

const UNITS = [
	['unit_week_words', 604_800_000],
	['unit_day_words', 86_400_000],
	['unit_hour_words', 3_600_000],
	['unit_minute_words', 60_000],
];

/** "in 2 hours", "1 saat 30 dakika sonra" -> milliseconds; null when no unit is named. */
function relativeOffsetMs(text) {
	const one = words('one_words');
	let total = 0;
	let found = false;
	for (const [key, ms] of UNITS) {
		const list = words(key);
		if (!list.length) continue;
		// One alternation per unit, longest spelling first, so "minutes" is not counted again as "min".
		const amount = String.raw`\d+(?:[.,]\d+)?${one.length ? `|${one.join('|')}` : ''}`;
		const hit = new RegExp(String.raw`\b(${amount})\s*(?:${list.join('|')})[a-z]{0,3}\b`, 'u').exec(text);
		if (!hit) continue;
		const value = /^\d/u.test(hit[1]) ? Number.parseFloat(hit[1].replace(',', '.')) : 1;
		if (!Number.isFinite(value)) continue;
		total += value * ms;
		found = true;
	}
	return found ? total : null;
}

/** "21:00", "9 pm", "saat 21" -> {hour, minute}; null when the text carries no clock time. */
function clockOf(raw, text) {
	const shift = (hour, meridiem) => {
		const marker = String(meridiem ?? '').toLowerCase();
		if (marker === 'pm' && hour < 12) return hour + 12;
		if (marker === 'am' && hour === 12) return 0;
		return hour;
	};
	// Punctuation is gone from the normalised text, so the clock is read off the raw string.
	const exact = /(?:^|[^\d])(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)?/iu.exec(raw);
	if (exact) {
		const hour = shift(Number(exact[1]), exact[3]);
		const minute = Number(exact[2]);
		if (hour <= 23 && minute <= 59) return { hour, minute };
	}
	const meridiem = /(?:^|[^\d])(\d{1,2})\s*(am|pm)\b/iu.exec(raw);
	if (meridiem) {
		const hour = shift(Number(meridiem[1]), meridiem[2]);
		if (hour <= 23) return { hour, minute: 0 };
	}
	// A bare hour only counts after a word that announces one ("at 9", "saat 9"); a loose number elsewhere
	// in the sentence is far more likely to be a count than a time.
	const at = words('at_words');
	if (at.length) {
		const bare = new RegExp(String.raw`\b(?:${at.join('|')})\s+(\d{1,2})\b`, 'u').exec(text);
		if (bare && Number(bare[1]) <= 23) return { hour: Number(bare[1]), minute: 0 };
	}
	return null;
}

/**
 * The day the text points at, as local midnight.
 * `roll` is how many days to add when the resulting moment has already passed: a named weekday rolls to
 * next week, a bare clock time rolls to tomorrow, and an explicit "today" does not roll at all (saying
 * "today at 9" when it is 10 is a mistake worth reporting, not a silent jump to tomorrow).
 * @returns {{date: Date, roll: number}|null}
 */
function dayAnchor(text, now) {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const plus = (days) => {
		const date = new Date(midnight);
		date.setDate(date.getDate() + days);
		return date;
	};
	// "the day after tomorrow" contains "tomorrow", so the longer phrase has to be tested first.
	if (anyWord(text, words('day_after_words'))) return { date: plus(2), roll: 0 };
	if (anyWord(text, words('tomorrow_words'))) return { date: plus(1), roll: 0 };
	if (anyWord(text, words('today_words'))) return { date: midnight, roll: 0 };
	const weekdays = [tList('tools.events.weekday_names'), tList('tools.events.weekday_names', null, 'en')];
	for (let index = 0; index < 7; index++) {
		const list = [...new Set(weekdays.flatMap((table) => table[index] ?? []).map((word) => normalize(word)).filter(Boolean))];
		if (anyWord(text, list.sort((a, b) => b.length - a.length))) return { date: plus((index - now.getDay() + 7) % 7), roll: 7 };
	}
	return null;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/iu;
// Day-first written date ("20.09.2026", "20/9/26"). The year is required: without it "10.05" is far more
// likely to be five past ten than the tenth of May, and guessing wrong moves an event by months.
const DOTTED_DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/u;

/** @returns {{match: string, date: Date}|null} local midnight of a day-first written date */
function dottedDate(raw) {
	const hit = DOTTED_DATE_RE.exec(raw);
	if (!hit) return null;
	const [day, month] = [Number(hit[1]), Number(hit[2])];
	const year = Number(hit[3]) < 100 ? 2000 + Number(hit[3]) : Number(hit[3]);
	if (day < 1 || day > 31 || month < 1 || month > 12) return null;
	const date = new Date(year, month - 1, day);
	return date.getMonth() === month - 1 && date.getDate() === day ? { match: hit[0], date } : null;
}

/**
 * Turns a written or spoken time into a Date. Relative wording is measured from `now`, which is why an end
 * time is parsed with the start as its `now`: "2 hours" then means two hours OF EVENT.
 * @returns {{date: Date}|{error: 'missing'|'clock'|'unreadable'}} the caller turns the error into a spoken refusal
 */
export function parseWhen(raw, now = new Date()) {
	const original = String(raw ?? '').trim();
	if (!original) return { error: 'missing' };
	const iso = ISO_RE.exec(original);
	if (iso) {
		// With a zone (Z or +03:00) the string is already absolute; without one it means local wall-clock
		// time, and Date.parse would read a bare "2026-09-20" as UTC midnight and shift the day.
		const date = iso[7]
			? new Date(Date.parse(original))
			: new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0));
		return Number.isNaN(date.getTime()) ? { error: 'unreadable' } : { date };
	}
	const text = normalize(original);
	const offset = relativeOffsetMs(text);
	if (offset !== null) return { date: new Date(now.getTime() + offset) };
	// A written date is taken out of the string first, so its numbers cannot be read as a clock time.
	const dotted = dottedDate(original);
	const rest = dotted ? original.replace(dotted.match, ' ') : original;
	const clock = clockOf(rest, normalize(rest));
	const day = dotted ? { date: dotted.date, roll: 0 } : dayAnchor(text, now);
	if (day && !clock) return { error: 'clock' };
	if (!clock) return { error: 'unreadable' };
	const date = new Date(day?.date ?? now);
	date.setHours(clock.hour, clock.minute, 0, 0);
	const roll = day?.roll ?? 1;
	if (roll && date.getTime() <= now.getTime()) date.setDate(date.getDate() + roll);
	return { date };
}

/** Spoken refusal for a time that could not be read. `field` is 'time' (the start) or 'end'. */
function timeRefusal(field, error, text) {
	if (error === 'missing') return { ok: false, spoken: t('tools.events.time_missing') };
	const key = error === 'clock' ? `tools.events.${field}_needs_clock` : `tools.events.${field}_unreadable`;
	return { ok: false, spoken: t(key, { text: String(text ?? '').slice(0, 60) }) };
}

// ---------------------------------------------------------------- events

/** A start/end time in the locale's own wording. */
function whenText(value) {
	const date = value instanceof Date ? value : (value ?? null) === null ? null : new Date(value);
	if (!date || Number.isNaN(date.getTime())) return t('tools.events.when_unknown');
	return date.toLocaleString(t('tools.helpers.date_locale'), {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/** "in General" for a voice/stage event, "at Ankara" for one held outside Discord. */
function whereText(deps, event) {
	if (event.entityType === GuildScheduledEventEntityType.External) {
		const location = event.entityMetadata?.location;
		return location ? t('tools.events.where_location', { location }) : t('tools.events.where_unknown');
	}
	const channel = event.channel ?? (event.channelId ? (deps.guild?.channels?.cache?.get(event.channelId) ?? null) : null);
	return channel?.name ? t('tools.events.where_channel', { channel: channel.name }) : t('tools.events.where_unknown');
}

/** The structured half of every answer, so the model can follow up without a second lookup. */
function eventData(deps, event) {
	return {
		id: event.id,
		name: event.name,
		start: event.scheduledStartTimestamp ? new Date(event.scheduledStartTimestamp).toISOString() : null,
		end: event.scheduledEndTimestamp ? new Date(event.scheduledEndTimestamp).toISOString() : null,
		type: GuildScheduledEventEntityType[event.entityType] ?? null,
		status: GuildScheduledEventStatus[event.status] ?? null,
		channel: event.channel?.name ?? deps.guild?.channels?.cache?.get(event.channelId ?? '')?.name ?? null,
		location: event.entityMetadata?.location ?? null,
		interested: event.userCount ?? null,
		url: event.url ?? null,
	};
}

/** Every scheduled event on the server, earliest first. Throws so the caller can report the API reason. */
async function allEvents(deps) {
	const fetched = await deps.guild.scheduledEvents.fetch();
	const list = [...(fetched?.values?.() ?? fetched ?? [])];
	return list.sort((a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0));
}

/**
 * Finds one event by id or by name. Names come out of a transcript, so matching goes exact -> prefix ->
 * contains -> similar, the same ladder the other tools use for channels and roles.
 * @returns {Promise<{event: object}|{refusal: object}>}
 */
async function findEvent(deps, raw) {
	if (!deps.guild?.scheduledEvents?.fetch) return { refusal: { ok: false, spoken: t('tools.events.unavailable') } };
	const needle = String(raw ?? '').trim();
	if (!needle) return { refusal: { ok: false, spoken: t('tools.events.which_event') } };
	let list;
	try {
		list = await allEvents(deps);
	} catch (err) {
		return { refusal: failure(deps, 'scheduled event lookup failed', err, t('tools.events.lookup_failed')) };
	}
	const byId = list.find((event) => event.id === needle);
	if (byId) return { event: byId };
	const key = normalize(needle);
	if (!key) return { refusal: { ok: false, spoken: t('tools.events.which_event') } };
	const keyed = list.map((event) => ({ event, key: normalize(event.name ?? '') }));
	const hit =
		keyed.find((entry) => entry.key === key) ??
		keyed.find((entry) => entry.key.startsWith(key)) ??
		keyed.find((entry) => entry.key.includes(key));
	if (hit) return { event: hit.event };
	let best = null;
	let bestScore = 0;
	for (const entry of keyed) {
		const score = similarity(entry.key, key);
		if (score > bestScore) {
			best = entry.event;
			bestScore = score;
		}
	}
	if (best && bestScore >= 0.7) return { event: best };
	return { refusal: { ok: false, spoken: t('tools.events.event_not_found', { name: needle }) } };
}

/**
 * Refuses when the bot cannot manage events at all.
 * `own` = the event was created by the bot (or is about to be), which "Create Events" alone already covers.
 * When the bot's own permissions cannot be read (an uncached member) the call goes ahead and Discord answers.
 */
function permissionRefusal(deps, own) {
	const permissions = deps.guild?.members?.me?.permissions;
	if (!permissions?.has) return null;
	if (permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageEvents)) return null;
	if (own && permissions.has(PermissionFlagsBits.CreateEvents)) return null;
	return { ok: false, spoken: t(own ? 'tools.events.no_create_permission' : 'tools.events.no_manage_permission') };
}

/** Refuses when the bot cannot see or join the channel the event would be held in. */
function channelRefusal(deps, channel) {
	const me = deps.guild?.members?.me ?? null;
	const mine = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
	if (!mine?.has || mine.has(PermissionFlagsBits.Administrator)) return null;
	if (mine.has(PermissionFlagsBits.ViewChannel) && mine.has(PermissionFlagsBits.Connect)) return null;
	return { ok: false, spoken: t('tools.events.no_channel_access', { channel: channel.name }) };
}

/**
 * Resolves the voice or stage channel an event is held in.
 * @returns {{channel: object}|{refusal: object}}
 */
function resolveEventChannel(deps, raw, wantsStage) {
	const channel = resolveAnyChannel(deps, String(raw ?? ''));
	if (!channel) return { refusal: { ok: false, spoken: t('tools.events.channel_not_found', { name: raw }) } };
	if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
		return { refusal: { ok: false, spoken: t('tools.events.not_a_voice_channel', { name: channel.name }) } };
	}
	if (wantsStage && channel.type !== ChannelType.GuildStageVoice) {
		return { refusal: { ok: false, spoken: t('tools.events.not_a_stage', { name: channel.name }) } };
	}
	const denied = channelRefusal(deps, channel);
	if (denied) return { refusal: denied };
	return { channel };
}

export const tools = [
	defineTool({
		name: 'list_events',
		description:
			'Lists the scheduled events on the server: what each one is called, when it starts, where it is held and how ' +
			'many people are interested. Use this before editing or cancelling an event, to learn its exact name.',
		parameters: P.obj({
			include_finished: P.bool('true = also list the events that already ended or were cancelled (default: false)'),
		}),
		async handler(args, deps) {
			if (!deps.guild?.scheduledEvents?.fetch) return { ok: false, spoken: t('tools.events.unavailable') };
			let list;
			try {
				list = await allEvents(deps);
			} catch (err) {
				return failure(deps, 'scheduled event list failed', err, t('tools.events.lookup_failed'));
			}
			const all = args.include_finished === true;
			const shown = all ? list : list.filter((event) => LIVE_STATUS.has(event.status));
			if (!shown.length) return { ok: true, spoken: t('tools.events.no_events'), data: { events: [] } };
			const lines = shown.map((event) =>
				t('tools.events.list_entry', {
					name: event.name,
					when: whenText(event.scheduledStartTimestamp),
					where: whereText(deps, event),
					interested: event.userCount ?? 0,
				}),
			);
			return {
				ok: true,
				spoken: t('tools.events.events_list', { count: shown.length, events: lines.join('; ') }),
				data: { events: shown.map((event) => eventData(deps, event)) },
			};
		},
	}),

	defineTool({
		name: 'create_event',
		description:
			'Creates a scheduled event. It is held either in a voice channel, on a stage channel, or somewhere outside ' +
			'Discord ("external"), which needs both a location and an end time. Times may be an ISO timestamp ' +
			'("2026-09-20T21:00") or everyday wording ("in 2 hours", "tomorrow at 21:00", "friday 9 pm"); say the hour ' +
			'in 24-hour form when there is no am/pm. Owner only.',
		parameters: P.obj(
			{
				name: P.str('Event name (up to 100 characters)'),
				start_time: P.str('When it starts: an ISO timestamp, or wording such as "in 2 hours" / "tomorrow at 21:00"'),
				end_time: P.str(
					'When it ends (required for an external event). Same wording as start_time; a plain offset such as ' +
						'"2 hours" is measured from the start, so it means how long the event lasts',
				),
				channel: P.str('Voice or stage channel the event is held in'),
				location: P.str('Where it happens when it is not in a channel (an address, a place, a link); makes the event external'),
				description: P.str('What the event is about (up to 1000 characters)'),
				type: {
					type: 'string',
					enum: ['voice', 'stage', 'external'],
					description: 'Kind of event; when empty it follows from whether a channel or a location was given',
				},
			},
			['name', 'start_time'],
		),
		gate: { keywords: WORDS.event },
		async handler(args, deps) {
			if (!deps.guild?.scheduledEvents?.create) return { ok: false, spoken: t('tools.events.unavailable') };
			const name = String(args.name ?? '').trim().slice(0, NAME_MAX);
			if (!name) return { ok: false, spoken: t('tools.events.name_missing') };
			const denied = permissionRefusal(deps, true);
			if (denied) return denied;

			const now = new Date();
			const start = parseWhen(args.start_time, now);
			if (start.error) return timeRefusal('time', start.error, args.start_time);
			if (start.date.getTime() <= now.getTime()) {
				return { ok: false, spoken: t('tools.events.time_in_past', { when: whenText(start.date) }) };
			}

			const kind = String(args.type ?? '').trim().toLowerCase();
			const location = String(args.location ?? '').trim().slice(0, LOCATION_MAX);
			// With no explicit type, a location and no channel means "somewhere outside Discord".
			const external = kind === 'external' || (!kind && !args.channel && Boolean(location));
			let channel = null;
			if (external) {
				if (!location) return { ok: false, spoken: t('tools.events.location_missing') };
			} else {
				if (!args.channel) return { ok: false, spoken: t('tools.events.which_place') };
				const resolved = resolveEventChannel(deps, args.channel, kind === 'stage');
				if (resolved.refusal) return resolved.refusal;
				channel = resolved.channel;
			}

			// An external event has no channel to fall silent in, so Discord insists on knowing when it ends.
			let end = null;
			if (args.end_time) {
				const parsed = parseWhen(args.end_time, start.date);
				if (parsed.error) return timeRefusal('end', parsed.error, args.end_time);
				end = parsed.date;
				if (end.getTime() <= start.date.getTime()) return { ok: false, spoken: t('tools.events.end_before_start') };
			} else if (external) {
				return { ok: false, spoken: t('tools.events.end_missing') };
			}

			const entityType = external
				? GuildScheduledEventEntityType.External
				: channel.type === ChannelType.GuildStageVoice
					? GuildScheduledEventEntityType.StageInstance
					: GuildScheduledEventEntityType.Voice;
			try {
				const event = await deps.guild.scheduledEvents.create({
					name,
					entityType,
					// GuildOnly is the only privacy level Discord accepts for a guild scheduled event.
					privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
					scheduledStartTime: start.date,
					...(end ? { scheduledEndTime: end } : {}),
					...(external ? { entityMetadata: { location } } : { channel }),
					...(args.description ? { description: String(args.description).slice(0, DESCRIPTION_MAX) } : {}),
					reason: t('tools.helpers.audit_reason'),
				});
				const when = whenText(event?.scheduledStartTimestamp ?? start.date);
				deps.log?.(t('tools.events.log_created', { name: event?.name ?? name, when }));
				return {
					ok: true,
					spoken: t('tools.events.created', { name: event?.name ?? name, when, where: event ? whereText(deps, event) : '' }),
					data: event ? eventData(deps, event) : { name, start: start.date.toISOString() },
				};
			} catch (err) {
				return failure(deps, 'scheduled event creation failed', err, t('tools.events.create_failed'));
			}
		},
	}),

	defineTool({
		name: 'edit_event',
		description:
			'Changes a scheduled event: its name, description, start or end time, the channel it is held in, or the ' +
			'location of an external event. An event held in a channel cannot be given a location and an external one ' +
			'cannot be given a channel -- make a new event for that. Owner only.',
		parameters: P.obj(
			{
				event: P.str('Name (or id) of the event to change'),
				name: P.str('New name'),
				description: P.str('New description'),
				start_time: P.str('New start time: an ISO timestamp, or wording such as "in 2 hours" / "tomorrow at 21:00"'),
				end_time: P.str('New end time; a plain offset such as "2 hours" is measured from the start time'),
				channel: P.str('New voice or stage channel (only for an event that is already held in a channel)'),
				location: P.str('New location (only for an event held outside Discord)'),
			},
			['event'],
		),
		gate: { keywords: WORDS.event },
		async handler(args, deps) {
			const found = await findEvent(deps, args.event);
			if (found.refusal) return found.refusal;
			const event = found.event;
			if (!LIVE_STATUS.has(event.status)) return { ok: false, spoken: t('tools.events.event_over', { name: event.name }) };
			const denied = permissionRefusal(deps, Boolean(event.creatorId) && event.creatorId === selfIdOf(deps));
			if (denied) return denied;

			const external = event.entityType === GuildScheduledEventEntityType.External;
			const patch = {};
			const parts = [];
			if (args.name) {
				patch.name = String(args.name).trim().slice(0, NAME_MAX);
				parts.push(t('tools.events.part_renamed', { name: patch.name }));
			}
			if (args.description !== undefined) {
				patch.description = String(args.description).slice(0, DESCRIPTION_MAX);
				parts.push(t('tools.events.part_description'));
			}

			const now = new Date();
			let start = event.scheduledStartTimestamp ? new Date(event.scheduledStartTimestamp) : now;
			if (args.start_time) {
				const parsed = parseWhen(args.start_time, now);
				if (parsed.error) return timeRefusal('time', parsed.error, args.start_time);
				if (parsed.date.getTime() <= now.getTime()) {
					return { ok: false, spoken: t('tools.events.time_in_past', { when: whenText(parsed.date) }) };
				}
				start = parsed.date;
				patch.scheduledStartTime = start;
				parts.push(t('tools.events.part_start', { when: whenText(start) }));
			}
			if (args.end_time) {
				// Measured from the (possibly brand new) start, so "2 hours" means two hours of event.
				const parsed = parseWhen(args.end_time, start);
				if (parsed.error) return timeRefusal('end', parsed.error, args.end_time);
				if (parsed.date.getTime() <= start.getTime()) return { ok: false, spoken: t('tools.events.end_before_start') };
				patch.scheduledEndTime = parsed.date;
				parts.push(t('tools.events.part_end', { when: whenText(parsed.date) }));
			}

			if (args.channel) {
				if (external) return { ok: false, spoken: t('tools.events.external_has_no_channel', { name: event.name }) };
				const resolved = resolveEventChannel(deps, args.channel, event.entityType === GuildScheduledEventEntityType.StageInstance);
				if (resolved.refusal) return resolved.refusal;
				patch.channel = resolved.channel;
				parts.push(t('tools.events.part_channel', { channel: resolved.channel.name }));
			}
			if (args.location) {
				if (!external) return { ok: false, spoken: t('tools.events.not_an_external_event', { name: event.name }) };
				patch.entityMetadata = { location: String(args.location).trim().slice(0, LOCATION_MAX) };
				parts.push(t('tools.events.part_location', { location: patch.entityMetadata.location }));
			}
			if (!parts.length) return { ok: false, spoken: t('tools.events.nothing_to_change') };

			try {
				const updated = await event.edit({ ...patch, reason: t('tools.helpers.audit_reason') });
				const name = updated?.name ?? patch.name ?? event.name;
				deps.log?.(t('tools.events.log_edited', { name, details: parts.join(', ') }));
				return {
					ok: true,
					spoken: t('tools.events.edited', { name, details: parts.join(', ') }),
					data: updated ? eventData(deps, updated) : { id: event.id, name },
				};
			} catch (err) {
				return failure(deps, 'scheduled event edit failed', err, t('tools.events.edit_failed'));
			}
		},
	}),

	defineTool({
		name: 'cancel_event',
		description:
			'Cancels a scheduled event. An event that has already started cannot be cancelled, only ended, and this does ' +
			'that instead. Owner only; two-step (asks first, acts with confirm:true). Cancelling cannot be undone.',
		parameters: P.obj({ event: P.str('Name (or id) of the event'), confirm: P.confirm() }, ['event']),
		gate: { keywords: WORDS.cancel },
		async handler(args, deps, { name }) {
			const found = await findEvent(deps, args.event);
			if (found.refusal) return found.refusal;
			const event = found.event;
			if (event.status === GuildScheduledEventStatus.Canceled) {
				return { ok: false, spoken: t('tools.events.already_cancelled', { name: event.name }) };
			}
			if (event.status === GuildScheduledEventStatus.Completed) {
				return { ok: false, spoken: t('tools.events.already_finished', { name: event.name }) };
			}
			const denied = permissionRefusal(deps, Boolean(event.creatorId) && event.creatorId === selfIdOf(deps));
			if (denied) return denied;

			const decision = checkConfirmation(deps, {
				key: name,
				target: event.id,
				confirm: args.confirm,
				question: t('tools.events.cancel_question', { name: event.name, when: whenText(event.scheduledStartTimestamp) }),
			});
			if (decision.ask) return askConfirmation(decision.ask, { event: event.name });
			if (decision.stale) return STALE_CONFIRMATION();

			// Discord only allows SCHEDULED -> CANCELED and ACTIVE -> COMPLETED; an event that is already
			// running is therefore ended rather than cancelled, and the answer says so.
			const running = event.status === GuildScheduledEventStatus.Active;
			const status = running ? GuildScheduledEventStatus.Completed : GuildScheduledEventStatus.Canceled;
			try {
				await event.edit({ status, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t(running ? 'tools.events.log_ended' : 'tools.events.log_cancelled', { name: event.name }));
				return {
					ok: true,
					spoken: t(running ? 'tools.events.ended' : 'tools.events.cancelled', { name: event.name }),
					data: { id: event.id, name: event.name, status: GuildScheduledEventStatus[status] },
				};
			} catch (err) {
				return failure(deps, 'scheduled event cancel failed', err, t('tools.events.cancel_failed'));
			}
		},
	}),

	defineTool({
		name: 'event_interest',
		description: 'Says how many people marked themselves interested in a scheduled event, and names a few of them.',
		parameters: P.obj({ event: P.str('Name (or id) of the event') }, ['event']),
		async handler(args, deps) {
			const found = await findEvent(deps, args.event);
			if (found.refusal) return found.refusal;
			let event = found.event;
			try {
				// The cached copy can be stale, and the count only arrives when it is asked for.
				event = (await deps.guild.scheduledEvents.fetch({ guildScheduledEvent: event.id, withUserCount: true, force: true })) ?? event;
			} catch (err) {
				return failure(deps, 'scheduled event interest lookup failed', err, t('tools.events.interest_failed'));
			}
			const count = event.userCount ?? 0;
			// Naming a few of them is a bonus; if the subscriber list is refused, the count still stands.
			let names = [];
			try {
				const subscribers = await deps.guild.scheduledEvents.fetchSubscribers(event.id, { limit: 5, withMember: true });
				names = [...(subscribers?.values?.() ?? subscribers ?? [])]
					.map((entry) => (entry.member ? displayName(entry.member) : (entry.user?.username ?? null)))
					.filter(Boolean);
			} catch (err) {
				deps.log?.(t('tools.events.log_subscribers_failed', { error: String(err?.message ?? err) }));
			}
			const spoken = !count
				? t('tools.events.interest_none', { name: event.name })
				: names.length
					? t('tools.events.interest', { name: event.name, count, names: names.join(', ') })
					: t('tools.events.interest_count', { name: event.name, count });
			return { ok: true, spoken, data: { ...eventData(deps, event), interested: count, names } };
		},
	}),
];
