// Shared helpers for the tool modules: channel/member/role/emoji resolution, the owner gate,
// two-step confirmation, error explanation, rate limiting.

import { AuditLogEvent, ChannelType, PermissionFlagsBits } from 'discord.js';
import { entryFromMember, memberNames, nameScore, pickBest, similarity } from '../matcher.js';
import { t, tList, tRaw } from '../i18n/index.js';
import { findChannelByName, normalize } from '../text.js';

export { ChannelType, PermissionFlagsBits };

// ---------------------------------------------------------------- channels

export function textChannels(deps) {
	return [...deps.guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildText);
}

export function voiceChannels(deps) {
	return [...deps.guild.channels.cache.values()].filter(
		(channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice,
	);
}

export function resolveTextChannel(deps, nameOrChannel) {
	if (nameOrChannel && typeof nameOrChannel === 'object') return nameOrChannel;
	if (!nameOrChannel) {
		return deps.cfg.textChannelId ? (deps.guild.channels.cache.get(deps.cfg.textChannelId) ?? null) : null;
	}
	return findChannelByName(textChannels(deps), String(nameOrChannel));
}

/** Resolves a channel of any kind (categories and voice channels included) by name or id. */
export function resolveAnyChannel(deps, nameOrChannel) {
	if (nameOrChannel && typeof nameOrChannel === 'object') return nameOrChannel;
	const needle = String(nameOrChannel ?? '').trim();
	if (!needle) return null;
	const all = [...deps.guild.channels.cache.values()];
	const byId = all.find((channel) => channel.id === needle.replace(/^#/, ''));
	if (byId) return byId;
	return findChannelByName(all, needle);
}

/** Voice channel name (string) or object -> channel. */
export function resolveVoiceChannel(deps, nameOrChannel) {
	if (nameOrChannel && typeof nameOrChannel === 'object') return nameOrChannel;
	if (typeof nameOrChannel === 'string' && nameOrChannel.trim()) return findChannelByName(voiceChannels(deps), nameOrChannel);
	return null;
}

/**
 * Resolves relative targets such as "the room below" / "the room above".
 * Looks at the neighbouring voice channel inside the same category first, then at the neighbour in the overall order.
 */
export function pickRelativeVoiceChannel(guild, currentChannel, direction = 'down') {
	if (!currentChannel) return null;
	const isVoice = (channel) => channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
	const sorted = [...guild.channels.cache.values()]
		.filter(isVoice)
		.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
	const sameParent = sorted.filter((channel) => (channel.parentId ?? null) === (currentChannel.parentId ?? null));
	const pick = (list) => {
		const index = list.findIndex((channel) => channel.id === currentChannel.id);
		if (index === -1) return null;
		return direction === 'up' ? (list[index - 1] ?? null) : (list[index + 1] ?? null);
	};
	return pick(sameParent) ?? pick(sorted);
}

// Spoken words for a relative channel target, and the subset of them that means "upwards".
// The tool schemas are written in English, so the model often hands back an English phrase even while the
// conversation is in another language ("the room below" for "alt kanal"). Both vocabularies are accepted.
function relativeWords(key) {
	const active = tList(`keywords.${key}`);
	const english = tList(`keywords.${key}`, null, 'en');
	return [...new Set([...active, ...english])].map((word) => word.replaceAll('|', String.raw`\|`));
}

const RELATIVE_TARGET_RE = new RegExp(
	String.raw`^(?:the\s+)?(?:room\s+|channel\s+)?(?:` + relativeWords('relative_target_words').join('|') + String.raw`)(?:\s+(?:room|channel|one))?$`,
	'i',
);
const RELATIVE_UP_RE = new RegExp(`(?:${relativeWords('relative_up_words').join('|')})`, 'i');

export function isRelativeTarget(text) {
	return RELATIVE_TARGET_RE.test(String(text ?? '').trim());
}

/** Reads an "up"/"down" direction out of the text. */
export function relativeDirection(text) {
	return RELATIVE_UP_RE.test(String(text ?? '')) ? 'up' : 'down';
}

export function memberVoiceChannel(deps, member) {
	if (member?.voice?.channel) return member.voice.channel;
	const state = deps.guild.voiceStates.cache.get(member?.id ?? '');
	return state?.channel ?? null;
}

// ---------------------------------------------------------------- members

export const displayName = (member, fallback = t('tools.helpers.someone')) => member?.displayName ?? member?.user?.username ?? fallback;

/**
 * Resolves a member across every name variant, with fuzzy matching (see src/matcher.js).
 * @returns {Promise<{ member: object|null, exact: boolean }>} exact = the name matched fully/by prefix/by substring (not fuzzily)
 */
export async function findMemberDetailed(deps, name) {
	// A Discord id or a mention is an exact answer, and the model does pass one: the speaker context and
	// the configuration both carry raw ids. Name matching would never resolve it, so it is tried first.
	const raw = String(name ?? '').trim();
	// The member cache is keyed by id, so a hit here is unambiguous and no display name can produce one.
	const byKey = raw ? deps.guild.members.cache.get(raw) : null;
	if (byKey) return { member: byKey, exact: true };
	const id = userIdOf(raw);
	if (id) {
		const cached = deps.guild.members.cache.get(id);
		if (cached) return { member: cached, exact: true };
		const fetched = await deps.guild.members.fetch(id).catch(() => null);
		if (fetched) return { member: fetched, exact: true };
	}
	const needle = normalize(name);
	if (!needle) return { member: null, exact: false };
	const botChannelId = deps.currentVoiceChannel?.()?.id ?? null;

	// 1) In-memory member index (the whole server is loaded at start-up) -- account name + nickname + similarity.
	if (deps.memberIndex?.size) {
		const best = pickBest(deps.memberIndex.list(), needle, {
			botChannelId,
			voiceChannelOf: (id) => deps.guild.voiceStates.cache.get(id)?.channelId ?? null,
		});
		if (best) {
			const exact = nameScore(best.names, needle) > 0;
			if (!exact) deps.log?.(t('tools.helpers.log_member_fuzzy', { name, display: best.display }));
			const live = deps.guild.members.cache.get(best.id);
			if (live) return { member: live, exact };
			const fetched = await deps.guild.members.fetch(best.id).catch(() => null);
			if (fetched) return { member: fetched, exact };
		}
	}

	// 2) discord.js cache (members that arrived through voice states/messages).
	const cachedEntries = [...deps.guild.members.cache.values()].map((member) => entryFromMember(member)).filter(Boolean);
	const cached = pickBest(cachedEntries, needle, { botChannelId, voiceChannelOf: () => null });
	if (cached?.raw) return { member: cached.raw, exact: nameScore(cached.names, needle) > 0 };

	// 3) Last attempt over the partial members that come with voice states.
	const voiceMembers = [];
	for (const state of deps.guild.voiceStates.cache.values()) {
		const member = state.member ?? deps.guild.members.cache.get(state.id);
		if (member) voiceMembers.push(member);
	}
	const voiceEntries = voiceMembers.map((member) => entryFromMember(member)).filter(Boolean);
	const voiceHit = pickBest(voiceEntries, needle, { botChannelId, voiceChannelOf: () => null });
	if (voiceHit?.raw) return { member: voiceHit.raw, exact: nameScore(voiceHit.names, needle) > 0 };

	// 4) "Write to me", "my roles", "move me down". The person saying it is the answer, and no member is
	// called "me". Tried LAST so that somebody actually nicknamed "Ben" still wins the name they have.
	const speakerId = String(deps.currentSpeakerId?.() ?? '');
	if (speakerId && tList('keywords.self_words').includes(needle)) {
		const live = deps.guild.members.cache.get(speakerId);
		if (live) return { member: live, exact: true };
		const fetched = await deps.guild.members.fetch(speakerId).catch(() => null);
		if (fetched) return { member: fetched, exact: true };
	}

	deps.log?.(t('tools.helpers.log_member_not_found', { name }));
	return { member: null, exact: false };
}

/** "389223135133564939", "<@389223135133564939>", "<@!389…>" -> the id; anything else -> null. */
export function userIdOf(value) {
	const text = String(value ?? '').trim();
	const match = /^<@!?(\d{16,20})>$/u.exec(text) ?? /^(\d{16,20})$/u.exec(text);
	return match ? match[1] : null;
}

export async function findMember(deps, name) {
	return (await findMemberDetailed(deps, name)).member;
}

// ---------------------------------------------------------------- mentions / emojis / stickers

const EVERYONE_WORDS = new Set(tList('keywords.everyone_mention_words'));
const HERE_WORDS = new Set(tList('keywords.here_mention_words'));
const EVERYONE_MENTION_VARIANTS = tList('keywords.everyone_mention_variants');
const HERE_MENTION_VARIANTS = tList('keywords.here_mention_variants');

export async function resolveMentions(deps, names = []) {
	const mentions = [];
	const entries = [];
	const warnings = [];
	for (const raw of names) {
		const name = String(raw ?? '').trim();
		if (!name) continue;
		const key = normalize(name);
		if (EVERYONE_WORDS.has(key)) {
			mentions.push('@everyone');
			entries.push({ name, mention: '@everyone', kind: 'everyone', variants: mentionVariants([name, ...EVERYONE_MENTION_VARIANTS]) });
			continue;
		}
		if (HERE_WORDS.has(key)) {
			mentions.push('@here');
			entries.push({ name, mention: '@here', kind: 'everyone', variants: mentionVariants([name, ...HERE_MENTION_VARIANTS]) });
			continue;
		}
		const member = await findMember(deps, name);
		if (member) {
			mentions.push(`<@${member.id}>`);
			entries.push({
				name,
				mention: `<@${member.id}>`,
				kind: 'user',
				id: member.id,
				variants: mentionVariants([name], memberNames(member)),
			});
			continue;
		}
		const role = [...deps.guild.roles.cache.values()].find((r) => normalize(r.name) === key);
		if (role && role.name !== '@everyone') {
			mentions.push(`<@&${role.id}>`);
			entries.push({ name, mention: `<@&${role.id}>`, kind: 'role', id: role.id, variants: mentionVariants([name, role.name]) });
			continue;
		}
		warnings.push(t('tools.helpers.mention_not_found', { name }));
	}
	return { mentions, entries, warnings };
}

/**
 * Replaces a name that appears in the body with its mention. When the model writes the name in the
 * sentence AND also passes mentions:["Name"], this is what stops it being written twice (mention + name).
 * A token that merely starts with the name counts as a match, so a name carrying an inflectional
 * suffix still lines up (the same way "Sam" matches "Sam's").
 */
export function replaceNameWithMention(text, name, mention) {
	const needle = normalize(name).split(' ').filter(Boolean);
	if (!needle.length) return { text, replaced: false };
	const parts = text.split(/(\s+)/); // alternating word/whitespace
	const tokens = [];
	for (let i = 0; i < parts.length; i += 2) tokens.push({ index: i, norm: normalize(parts[i]) });
	for (let start = 0; start + needle.length <= tokens.length; start++) {
		let matches = true;
		for (let k = 0; k < needle.length; k++) {
			const token = tokens[start + k].norm;
			const expected = needle[k];
			if (!token) {
				matches = false;
				break;
			}
			if (token !== expected && !(expected.length >= 3 && token.startsWith(expected))) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		const first = tokens[start].index;
		const last = tokens[start + needle.length - 1].index;
		return { text: `${parts.slice(0, first).join('')}${mention}${parts.slice(last + 1).join('')}`, replaced: true };
	}
	return { text, replaced: false };
}

/**
 * Name variants used for matching (longest/most specific first).
 * `loose`: trustworthy sources such as the name the model gave or a role name -- every fragment is tried.
 * `strict`: the member's own names -- single-word fragments are only tried when they are 4+ letters,
 *   otherwise short words in the body (e.g. "me", "ali") would be turned into mentions by accident.
 */
export function mentionVariants(loose = [], strict = []) {
	const seen = new Set();
	const items = [];
	const add = (text, strictSingle = false) => {
		const key = normalize(text);
		if (!key || seen.has(key)) return;
		const tokens = key.split(' ').filter(Boolean);
		if (!tokens.length) return;
		if (tokens.length === 1 && strictSingle && tokens[0].length < 4) return;
		seen.add(key);
		items.push({ text: key, weight: tokens.length * 1000 + key.length });
	};
	const expand = (value, strictSource) => {
		const tokens = normalize(value).split(' ').filter(Boolean);
		for (let size = tokens.length; size >= 1; size--) {
			for (let start = 0; start + size <= tokens.length; start++) {
				add(tokens.slice(start, start + size).join(' '), strictSource && size === 1);
			}
		}
	};
	for (const value of loose) expand(value, false);
	for (const value of strict) expand(value, true);
	return items.sort((a, b) => b.weight - a.weight).map((item) => item.text);
}

function emojiMap(deps) {
	return new Map([...deps.guild.emojis.cache.values()].map((emoji) => [String(emoji.name).toLowerCase(), emoji]));
}

export function resolveEmojis(deps, names = [], text = '') {
	const byName = emojiMap(deps);
	const used = [];
	const warnings = [];
	let body = String(text ?? '');

	// :name: placeholders in the text (leave the ones already written as <:name:id> alone)
	body = body.replace(/<a?:[A-Za-z0-9_]{2,32}:\d+>|:([A-Za-z0-9_]{2,32}):/g, (whole, name) => {
		if (!name) return whole;
		const emoji = byName.get(name.toLowerCase());
		if (!emoji) {
			warnings.push(t('tools.helpers.emoji_missing', { name }));
			return whole;
		}
		used.push(emoji.name);
		return emoji.toString();
	});

	for (const raw of names) {
		const emoji = byName.get(String(raw ?? '').trim().toLowerCase());
		if (!emoji) {
			warnings.push(t('tools.helpers.emoji_missing', { name: String(raw) }));
			continue;
		}
		used.push(emoji.name);
		body = `${body} ${emoji.toString()}`.trim();
	}
	return { body, used, warnings };
}

export async function resolveStickers(deps, names = []) {
	const ids = [];
	const warnings = [];
	if (!names.length) return { ids, warnings };
	if (!deps.guild.stickers.cache.size) {
		await deps.guild.stickers.fetch().catch(() => {});
	}
	for (const raw of names) {
		const wanted = String(raw ?? '').trim().toLowerCase();
		const sticker = [...deps.guild.stickers.cache.values()].find((s) => String(s.name).toLowerCase() === wanted);
		if (!sticker) {
			warnings.push(t('tools.helpers.sticker_missing', { name: String(raw) }));
			continue;
		}
		if (ids.length < 3) ids.push(sticker.id);
	}
	return { ids, warnings };
}

// ---------------------------------------------------------------- roles / colours

/** Role name -> role (loose matching + similarity). */
export function resolveRole(deps, name) {
	const needle = normalize(name);
	if (!needle) return null;
	const roles = [...deps.guild.roles.cache.values()].filter((role) => role.name !== '@everyone');
	const keyed = roles.map((role) => ({ role, key: normalize(role.name) }));
	const hit =
		keyed.find((entry) => entry.key === needle) ??
		keyed.find((entry) => entry.key.startsWith(needle)) ??
		keyed.find((entry) => entry.key.includes(needle));
	if (hit) return hit.role;
	let best = null;
	let bestScore = 0;
	for (const role of roles) {
		const score = similarity(normalize(role.name), needle);
		if (score > bestScore) {
			best = role;
			bestScore = score;
		}
	}
	return bestScore >= 0.7 ? best : null;
}

const COLOR_NAMES = tRaw('keywords.color_names');

/** "#ff8800", "ff8800" or a spoken colour name -> colour number. */
export function parseColor(value) {
	if (value === undefined || value === null) return null;
	const text = String(value).trim();
	if (!text) return null;
	const hex = text.replace(/^#/, '');
	if (/^[0-9a-f]{6}$/i.test(hex)) return Number.parseInt(hex, 16);
	return COLOR_NAMES[normalize(text)] ?? null;
}

/** Date in the locale's own format; the name is historical (it used to be Turkish only). */
export const trDate = (date) =>
	date ? new Date(date).toLocaleDateString(t('tools.helpers.date_locale')) : t('tools.helpers.date_unknown');

// Audit-log actions: Discord enum name -> readable label.
const AUDIT_ACTIONS = tRaw('keywords.audit_actions');

/** Turns a Discord action code (number or name) into a readable label. */
export function auditActionLabel(action) {
	if (typeof action === 'string') return AUDIT_ACTIONS[action] ?? action;
	const name = Object.entries(AuditLogEvent).find(([, value]) => value === action)?.[0];
	return (name && AUDIT_ACTIONS[name]) ?? name ?? t('tools.helpers.audit_action_unknown', { action });
}

// ---------------------------------------------------------------- bots / identity

/** Turns the ALLOWED_BOTS list from .env (names or ids) into a set that is ready for comparison. */
export function authorizedBotSet(deps) {
	return new Set((deps.cfg?.allowedBots ?? []).flatMap((value) => [value, normalize(value)]));
}

/** The bot's own user id. */
export function selfIdOf(deps) {
	return deps.selfId ?? deps.client?.user?.id ?? null;
}

// ---------------------------------------------------------------- error explanation

const DISCORD_ERRORS = tRaw('tools.helpers.discord_errors');

/** Turns a Discord API error into a short reason that can be said out loud. */
export function explain(err) {
	const code = err?.code ?? err?.status ?? err?.rawError?.code;
	if (code && DISCORD_ERRORS[code]) return DISCORD_ERRORS[code];
	const message = String(err?.message ?? err ?? '').trim();
	if (/Missing Permissions/i.test(message)) return DISCORD_ERRORS[50013];
	if (/Missing Access/i.test(message)) return DISCORD_ERRORS[50001];
	if (/rate limit/i.test(message)) return DISCORD_ERRORS[429];
	if (/Cannot send messages to this user/i.test(message)) return DISCORD_ERRORS[50007];
	return message ? message.slice(0, 120) : t('tools.helpers.error_unknown');
}

/** One shape for every failure: the full error goes to the log, a short reason to the user. */
export function failure(deps, label, err, spokenPrefix) {
	deps.log?.(t('tools.helpers.log_failure', { label, error: String(err?.message ?? err) }));
	return { ok: false, spoken: t('tools.helpers.failure_spoken', { prefix: spokenPrefix, reason: explain(err) }), error: explain(err) };
}

// ---------------------------------------------------------------- owner gate

// Keywords used to check whether the owner really did ask for an admin command.
export const WORDS = tRaw('keywords.words');

// ---------------------------------------------------------------- channel permissions

/** The "everyone" target: the @everyone role. */
export const PERMISSION_EVERYONE_WORDS = tList('keywords.permission_everyone_words');

// Permission names that can be said out loud -> discord.js PermissionFlagsBits key. Dangerous, server-wide
// permissions (Administrator, ManageRoles, ManageGuild, ManageWebhooks, Ban/Kick) are deliberately absent:
// they cannot be handed out by voice. The other way to hand them out is a role that carries them, and
// grant_role refuses those (RISKY_ROLE_PERMISSIONS in roles.js).
const PERMISSION_ALIASES = tRaw('keywords.permission_aliases');
// Groups: one word, several permissions.
const PERMISSION_GROUPS = tRaw('keywords.permission_groups');
export const PERMISSION_LABELS = tRaw('keywords.permission_labels');
export const PERMISSION_HELP = t('keywords.permission_help');

/** Group lookup that cannot reach Object.prototype ("constructor", "toString"). */
function groupFor(key) {
	if (Object.hasOwn(PERMISSION_GROUPS, key)) return PERMISSION_GROUPS[key];
	// Groups take suffixes too ("access" -> "accessible", "erisim" -> "erisimini").
	let best = null;
	let bestLen = 0;
	for (const name of Object.keys(PERMISSION_GROUPS)) {
		if (name.length >= 3 && key.startsWith(name) && name.length > bestLen) {
			best = PERMISSION_GROUPS[name];
			bestLen = name.length;
		}
	}
	return best;
}

/** The longest alias the key starts with ("baglanabilsin" -> "baglan"). */
function longestAliasPrefixOf(key) {
	let flag = null;
	let bestLen = 0;
	for (const [alias, target] of permissionIndex) {
		if (alias.length >= 3 && key.startsWith(alias) && alias.length > bestLen) {
			flag = target;
			bestLen = alias.length;
		}
	}
	return flag;
}

/**
 * Fallback: the shortest alias that continues the key within the SAME word ("recon" -> "reconnect").
 * A continuation that starts a new word is rejected on purpose: "channel" must not silently become
 * "manage channels", which would hand out a far stronger permission than the speaker asked for.
 */
function aliasStartingWith(key) {
	let flag = null;
	let bestLen = Infinity;
	for (const [alias, target] of permissionIndex) {
		if (alias.length < 3 || !alias.startsWith(key) || alias.length >= bestLen) continue;
		if (alias.includes(' ')) continue; // a multi-word permission phrase, not a longer form of this word
		flag = target;
		bestLen = alias.length;
	}
	return flag;
}

const permissionIndex = (() => {
	const index = new Map();
	for (const [flag, aliases] of Object.entries(PERMISSION_ALIASES)) {
		index.set(normalize(flag), flag);
		index.set(normalize(flag.replace(/([a-z])([A-Z])/g, '$1 $2')), flag);
		for (const alias of aliases) index.set(normalize(alias), flag);
	}
	return index;
})();

/**
 * Turns permission names (any supported language, inflected, camelCase) into PermissionFlagsBits keys.
 * @returns {{ flags: string[], unknown: string[] }}
 */
export function parsePermissions(names) {
	const flags = [];
	const unknown = [];
	const add = (flag) => {
		if (flag && !flags.includes(flag)) flags.push(flag);
	};
	// A model may hand us one string holding several permissions ("connect and view", "baglan, gor").
	const requested = [];
	for (const raw of Array.isArray(names) ? names : names ? [names] : []) {
		const text = String(raw ?? '');
		const parts = text.split(/\s*(?:,|\/|;|\bve\b|\band\b)\s*/iu).filter((part) => part.trim());
		requested.push(...(parts.length ? parts : [text]));
	}
	for (const raw of requested) {
		const key = normalize(raw);
		if (!key) continue;
		const group = groupFor(key);
		if (group) {
			for (const flag of group) add(flag);
			continue;
		}
		let flag = permissionIndex.get(key) ?? null;
		if (!flag && key.length >= 3) {
			// Inflected forms first: "connectable" / "baglanabilsin" carry a real alias as their PREFIX, and the
			// longest such alias wins. Only if nothing matches that way do we accept the key as the prefix of a
			// longer alias -- otherwise "messages" would reach "manage messages" and hand out moderation rights.
			flag = longestAliasPrefixOf(key) ?? aliasStartingWith(key);
		}
		if (flag) add(flag);
		else unknown.push(raw);
	}
	return { flags, unknown };
}

/** Turns a permission list into text that can be read out loud. */
export function permissionLabels(flags) {
	return (flags ?? []).map((flag) => PERMISSION_LABELS[flag] ?? flag).join(', ');
}

/**
 * Admin tools may only be used by the bot owner. The question is not "who is speaking right now" but
 * "who said the COMMAND":
 *  1) the person who said the relevant word (e.g. "ban") LAST within the past 15 s must be the owner
 *     (the transcript is attributed to a person by voice position; if somebody else said the same word
 *     later, the gate closes),
 *  2) if somebody else spoke after the owner's command but BEFORE the model started answering, the
 *     command may have been theirs -> it is refused (the owner says it again). People who cut in AFTER
 *     the model started answering (someone saying "hmm" while the backend works) do NOT change the
 *     decision; the moment of the turn is marked with `markTurn`.
 * The transcript can arrive late: if the word is not found, we wait a short while (`awaitTranscript`).
 * @returns {Promise<null | { ok: false, spoken: string, denied: true }>} null = allowed
 */
// How sure Jev has to be that the owner's words ask for the tool before the gate opens on them alone.
// The keyword path is a string match; this one is a judgment, so it needs a clear majority, and it is
// only ever consulted when the keywords found nothing of the owner's.
const JEV_GATE_P = 0.8;

/**
 * The keywords did not find the owner's word (or found somebody else's). Before refusing, read what the
 * owner actually said last and ask Jev whether it asks for this tool. Who spoke is still the audio's
 * call: the words come from the owner's own attributed speech, and a clean interjection after them
 * closes this path the same way it closes the keyword path.
 * @returns {Promise<{ percent: number, text: string }|null>} the reason to allow, or null
 */
async function ownerAskedByJev(deps, tool, opts) {
	const jev = deps.jev;
	if (!jev?.enabled || typeof jev.asks !== 'function' || typeof deps.ownerUtterance !== 'function') return null;
	const said = deps.ownerUtterance(opts);
	if (!said?.text) return null;
	const last = typeof deps.lastUtterance === 'function' ? deps.lastUtterance(opts) : null;
	if (last && !last.owner && last.sure !== false && last.seq > said.seq) return null;
	const description = typeof deps.toolDescription === 'function' ? (deps.toolDescription(tool) ?? '') : '';
	const p = await jev.asks({ line: said.text, tool, description });
	if (typeof p !== 'number') return null;
	const percent = Math.round(p * 100);
	deps.log?.(t('tools.helpers.log_gate_jev', { tool, percent, text: said.text.slice(0, 60) }));
	return p >= JEV_GATE_P ? { percent, text: said.text } : null;
}

export async function ownerGate(deps, keywords = null, tool = t('tools.helpers.gate_default_tool')) {
	const deny = (spoken, reason) => {
		deps.log?.(t('tools.helpers.log_gate_denied', { tool, reason }));
		deps.activity?.({
			kind: 'gate',
			whoName: deps.personaName?.() ?? 'bot',
			text: t('tools.helpers.gate_denied_activity', { tool, reason }),
			meta: { tool, result: 'denied', reason },
		});
		return { ok: false, spoken, denied: true };
	};
	const allow = (detail, meta = {}) => {
		const tail = deps.ownerTextTail?.() ?? '';
		deps.log?.(t('tools.helpers.log_gate_allowed', { tool, detail, tail: tail ? t('tools.helpers.log_gate_tail', { text: tail }) : '' }));
		deps.activity?.({
			kind: 'gate',
			whoName: deps.personaName?.() ?? 'bot',
			text: t('tools.helpers.gate_allowed_activity', { tool, detail }),
			meta: { tool, result: 'allowed', text: tail, ...meta },
		});
		return null;
	};
	const hasCommandSpeaker = typeof deps.commandSpeaker === 'function';
	if (typeof deps.isOwnerActive !== 'function' && !hasCommandSpeaker) {
		return deny(t('tools.helpers.gate_disabled'), t('tools.helpers.gate_reason_disabled'));
	}
	if (keywords?.length && hasCommandSpeaker) {
		// The turn is PINNED to the moment the request arrived and resolved in one place: if the owner says
		// something new while we wait (awaitTranscript), the gate decision for this request must not change.
		const opts = typeof deps.currentTurn === 'function' ? { turn: deps.currentTurn() ?? null } : {};
		let hit = deps.commandSpeaker(keywords, opts);
		// The transcript may be late: wait if the word is missing, or if the transcript of the utterance that
		// triggered the turn has not arrived yet.
		const lagging = () => (typeof deps.transcriptLagging === 'function' ? deps.transcriptLagging(opts) : false);
		if ((!hit || lagging()) && typeof deps.awaitTranscript === 'function') {
			await deps.awaitTranscript(1500);
			hit = deps.commandSpeaker(keywords, opts);
			// Still waiting on the transcript of the utterance that triggered this turn: whatever we can
			// see is from an EARLIER turn, so approving it would let a stale command authorise this one.
			if (lagging()) return deny(t('tools.helpers.gate_transcript_missing'), t('tools.helpers.gate_reason_transcript_missing'));
		}
		// The keywords missed the owner's phrasing, or found the word in somebody else's mouth while the
		// owner asked in other words (heard live: "sus" from a guest eight seconds earlier, then the
		// owner's "konusmaya devam edebilirsin"). Jev reads the owner's own words before this refuses.
		if (!hit || (!hit.owner && !hit.ownerOverlap)) {
			const asked = await ownerAskedByJev(deps, tool, opts);
			if (asked) return allow(t('tools.helpers.gate_detail_jev', { percent: asked.percent }), { jev: asked.percent, text: asked.text });
		}
		if (!hit) {
			return deny(t('tools.helpers.gate_not_heard'), t('tools.helpers.gate_reason_not_said'));
		}
		if (!hit.owner) {
			if (hit.ownerOverlap) {
				// The owner did say the word, but somebody else's voice is in the same audio. The model
				// transcribes the SUM of the voices in a frame, so nothing downstream can say whose word it
				// was -- and this gate runs bans, kicks and deletions.
				return deny(t('tools.helpers.gate_overlap'), t('tools.helpers.gate_reason_overlap'));
			}
			const who = hit.id && typeof deps.nameFor === 'function' ? deps.nameFor(hit.id) : null;
			const reason = t('tools.helpers.gate_reason_not_owner') + (who ? t('tools.helpers.gate_reason_who', { who }) : '');
			return deny(t('tools.helpers.gate_not_owner'), reason);
		}
		const last = typeof deps.lastUtterance === 'function' ? deps.lastUtterance(opts) : null;
		// Compare by sequence when both sides carry one: transcript fragments can share a millisecond,
		// and a wall-clock tie used to let the interjection slip through this check.
		const after = last && (Number.isFinite(last.seq) && Number.isFinite(hit.seq) ? last.seq > hit.seq : last.at >= hit.at);
		// Only a CLEAN interjection vetoes the owner: somebody who took the floor and said their own thing
		// (`sure`). A leaning fragment is their voice bleeding into the owner's at the hand-off, and with
		// owner priority on the owner's audio is the only audio sent anyway -- in a busy room that boundary
		// bleed was cancelling the owner's own commands, which is exactly the owner being drowned out.
		if (last && !last.owner && last.sure !== false && after) {
			const who = last.id && typeof deps.nameFor === 'function' ? deps.nameFor(last.id) : t('tools.helpers.gate_someone_else');
			return deny(
				t('tools.helpers.gate_interrupted'),
				t('tools.helpers.gate_reason_interrupted', { who, text: String(last.text).slice(0, 60) }),
			);
		}
		return allow(t('tools.helpers.gate_detail_owner_said', { word: hit.word }), { matched: hit.word });
	}
	// Older path (a tool without keywords, or a setup without attribution): the last voice heard must be the owner's.
	if (typeof deps.isOwnerActive !== 'function' || !deps.isOwnerActive()) {
		return deny(t('tools.helpers.gate_owner_not_active'), t('tools.helpers.gate_reason_last_not_owner'));
	}
	if (!keywords?.length || typeof deps.ownerSaidRecently !== 'function') {
		return allow(t('tools.helpers.gate_detail_last_owner'));
	}
	const matched = typeof deps.ownerMatch === 'function' ? deps.ownerMatch(keywords) : deps.ownerSaidRecently(keywords) ? keywords[0] : null;
	if (!matched) {
		return deny(t('tools.helpers.gate_unsure'), t('tools.helpers.gate_reason_not_said'));
	}
	return allow(t('tools.helpers.gate_detail_owner_word', { word: matched }), { matched });
}

/** Is the owner gate open (quietly: no activity event, no waiting)? */
export function ownerAllowed(deps, keywords = null) {
	if (keywords?.length && typeof deps.commandSpeaker === 'function') {
		const turn = deps.currentTurn?.();
		const opts = turn === undefined ? {} : { turn };
		const hit = deps.commandSpeaker(keywords, opts);
		if (!hit?.owner) return false;
		const last = typeof deps.lastUtterance === 'function' ? deps.lastUtterance(opts) : null;
		// Same rule as ownerGate: only a clean (`sure`) interjection closes the gate; a boundary bleed does not.
		return !(last && !last.owner && last.sure !== false && last.at > hit.at);
	}
	if (typeof deps.isOwnerActive !== 'function' || !deps.isOwnerActive()) return false;
	if (!keywords?.length || typeof deps.ownerSaidRecently !== 'function') return true;
	return typeof deps.ownerMatch === 'function' ? Boolean(deps.ownerMatch(keywords)) : deps.ownerSaidRecently(keywords);
}

// ---------------------------------------------------------------- two-step confirmation

// The transcript layer can mangle names ("Ediz" -> "Editz"); the owner gate proves WHO spoke, not WHAT
// was heard. That is why irreversible operations are two-step.
// Half a minute is not long in a voice channel: the model takes a few seconds a turn, people talk over
// each other, and the owner's "yes, go ahead" can easily arrive later than that. Ninety seconds is still
// short enough that a confirmation cannot be given to a question nobody remembers asking.
const CONFIRM_TTL_MS = 90_000;

// Pending confirmations are kept HERE, per guild, not on the deps object: the realtime path builds a
// fresh deps for every tool call (so the owner gate can pin the turn to the request), and a question
// written onto that throwaway object could never be matched by the answer, which left every two-step
// action — channel and role deletion, a ban on a fuzzy name — asking forever. Keyed by guild so two
// servers cannot confirm each other's destructive action.
const confirmationsByGuild = new Map();

function confirmationStore(deps) {
	if (deps.pendingConfirmations instanceof Map) return deps.pendingConfirmations; // a test may inject one
	const guildId = String(deps.guild?.id ?? 'default');
	let store = confirmationsByGuild.get(guildId);
	if (!store) {
		store = new Map();
		confirmationsByGuild.set(guildId, store);
	}
	return store;
}

/**
 * Two-step confirmation: the first call asks, a second call naming the same target (confirm:true, within 30 s) does it.
 * @returns {{ask: string}|{stale: true}|{ok: true}}
 */
export function checkConfirmation(deps, { key, target, confirm, question }) {
	const pending = confirmationStore(deps);
	const now = Date.now();
	for (const [pendingKey, value] of pending) {
		if (now - value.at > CONFIRM_TTL_MS) pending.delete(pendingKey);
	}
	const previous = pending.get(key);
	if (confirm !== true) {
		pending.set(key, { target, at: now });
		return { ask: question };
	}
	if (!previous || previous.target !== target) {
		// Somebody said yes to a question that had expired, or to a different one. Refusing and throwing
		// the record away left no way forward at all: the model keeps sending the confirmation it was
		// given, and every attempt is answered "I could not match that" for ever. Seen live, the owner
		// confirmed four times and the channel was never deleted. So the question is asked again, which is
		// still two steps and still cannot act on its own.
		pending.set(key, { target, at: now });
		return { ask: question, stale: true };
	}
	pending.delete(key);
	return { ok: true };
}

/** Result of a confirmation question (goes back to the model with needs_confirmation:true). */
export function askConfirmation(question, data = {}) {
	return {
		ok: false,
		needs_confirmation: true,
		spoken: t('tools.helpers.confirm_prompt', { question }),
		data,
	};
}

/** Confirmation could not be matched (different target, or the 30 s window elapsed). */
export function STALE_CONFIRMATION() {
	return { ok: false, spoken: t('tools.helpers.stale_confirmation') };
}

// ---------------------------------------------------------------- rate limit

/** Sliding-window counter: at most N per key per minute. */
export class SlidingLimiter {
	constructor({ windowMs = 60_000 } = {}) {
		this.windowMs = windowMs;
		this.hits = new Map();
	}

	/** Records the hit and returns true when it is allowed. */
	take(key, limit, now = Date.now()) {
		const list = (this.hits.get(key) ?? []).filter((stamp) => now - stamp < this.windowMs);
		if (list.length >= limit) {
			this.hits.set(key, list);
			return false;
		}
		list.push(now);
		this.hits.set(key, list);
		return true;
	}

	reset() {
		this.hits.clear();
	}
}
