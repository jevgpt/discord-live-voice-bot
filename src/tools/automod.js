// Auto-moderation tools: list the rules, create a keyword filter, turn a rule on or off, change the
// words it watches, delete one (confirmed).
//
// Every operation here needs the Manage Server permission (Discord: MANAGE_GUILD), and a rule that
// times people out additionally needs Moderate Members. One rule can silence a whole server, so all
// of these tools are owner-gated -- the listing one included, because reading the rules already
// requires Manage Server anyway.

import {
	AutoModerationActionType,
	AutoModerationRuleEventType,
	AutoModerationRuleKeywordPresetType,
	AutoModerationRuleTriggerType,
} from 'discord.js';
import {
	ChannelType,
	PermissionFlagsBits,
	STALE_CONFIRMATION,
	WORDS,
	askConfirmation,
	checkConfirmation,
	failure,
	resolveAnyChannel,
	resolveRole,
} from './helpers.js';
import { t } from '../i18n/index.js';
import { normalize } from '../text.js';
import { P, defineTool } from './registry.js';

// Discord's own limits: https://discord.com/developers/docs/resources/auto-moderation
const MAX_KEYWORD_RULES = 6; // Keyword-trigger rules per guild
const MAX_KEYWORDS = 1000; // keywords per rule
const MAX_KEYWORD_LENGTH = 60; // characters per keyword
const MAX_TIMEOUT_MINUTES = 40_320; // 4 weeks (2_419_200 seconds)
const MAX_CUSTOM_MESSAGE = 150;
const MAX_EXEMPT_ROLES = 20;
const MAX_EXEMPT_CHANNELS = 50;
const MAX_RULE_NAME = 100;

// A one-letter keyword (or a bare wildcard) matches inside almost every word, so a rule built on one
// blocks the entire server. That is the single most damaging mistake this surface allows, so it is
// refused before the request ever reaches Discord.
const MIN_KEYWORD_LETTERS = 2;

// Where an alert can be posted. Voice and category channels cannot receive the log message.
const ALERT_CHANNEL_TYPES = new Set([
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
]);

const WORDS_SHOWN = 5;

/** The rule manager, or null when this guild object does not carry one (old cache, test double). */
function ruleManager(deps) {
	return deps.guild?.autoModerationRules ?? null;
}

/** Every rule on the server, as a plain array (the manager answers with a Collection). */
async function fetchRules(deps) {
	const fetched = await ruleManager(deps).fetch();
	return [...(fetched?.values?.() ?? [])];
}

/** Rule id or (loosely matched) rule name -> rule. */
function findRule(rules, needle) {
	const raw = String(needle ?? '').trim();
	if (!raw) return null;
	const byId = rules.find((rule) => rule.id === raw);
	if (byId) return byId;
	const key = normalize(raw);
	if (!key) return null;
	const keyed = rules.map((rule) => ({ rule, key: normalize(rule.name) }));
	const hit =
		keyed.find((entry) => entry.key === key) ??
		keyed.find((entry) => entry.key.startsWith(key)) ??
		keyed.find((entry) => entry.key.includes(key));
	return hit?.rule ?? null;
}

/**
 * Does the bot hold what this operation needs?
 * @returns {string|null} the spoken reason, or null when everything is in place
 */
function permissionProblem(deps, { timeout = false } = {}) {
	const permissions = deps.guild?.members?.me?.permissions ?? null;
	if (typeof permissions?.has !== 'function') return null; // unknown -- let the API answer instead of guessing
	if (!permissions.has(PermissionFlagsBits.ManageGuild)) return t('tools.automod.no_manage_guild');
	if (timeout && !permissions.has(PermissionFlagsBits.ModerateMembers)) return t('tools.automod.no_moderate_members');
	return null;
}

/**
 * Reads a spoken word list into keyword filter entries.
 * One spoken answer often carries several words ("spam, scam and slur"), so separators are split too.
 * @returns {{ keywords: string[], tooShort: string[], tooLong: string[] }}
 */
function parseKeywords(raw) {
	const keywords = [];
	const tooShort = [];
	const tooLong = [];
	const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	for (const value of values) {
		for (const part of String(value).split(/\s*(?:,|;|\/)\s*/u)) {
			const word = part.trim();
			if (!word) continue;
			// Wildcards do not count as letters: "a*" filters every word starting with "a", which is the
			// same trap as a one-letter keyword.
			const letters = word.replaceAll('*', '').trim();
			if (letters.length < MIN_KEYWORD_LETTERS) {
				tooShort.push(word);
				continue;
			}
			if (word.length > MAX_KEYWORD_LENGTH) {
				tooLong.push(word);
				continue;
			}
			if (!keywords.some((existing) => existing.toLowerCase() === word.toLowerCase())) keywords.push(word);
		}
	}
	return { keywords: keywords.slice(0, MAX_KEYWORDS), tooShort, tooLong };
}

/** The first few words, with "and N more" when the list is long. */
function wordList(words = []) {
	const shown = words.slice(0, WORDS_SHOWN);
	const rest = words.length - shown.length;
	return rest > 0 ? `${shown.join(', ')} ${t('tools.automod.and_more', { more: rest })}` : shown.join(', ');
}

function presetLabel(preset) {
	if (preset === AutoModerationRuleKeywordPresetType.Profanity) return t('tools.automod.preset_profanity');
	if (preset === AutoModerationRuleKeywordPresetType.SexualContent) return t('tools.automod.preset_sexual');
	if (preset === AutoModerationRuleKeywordPresetType.Slurs) return t('tools.automod.preset_slurs');
	return String(preset);
}

/** What the rule looks for. */
function triggerText(rule) {
	const meta = rule.triggerMetadata ?? {};
	const words = meta.keywordFilter ?? [];
	switch (rule.triggerType) {
		case AutoModerationRuleTriggerType.Keyword: {
			// A spoken sentence has to agree with itself: "1 blocked words" is not something to read out.
			const parts = [];
			if (words.length === 1) parts.push(t('tools.automod.trigger_keyword_one', { words: wordList(words) }));
			else if (words.length) parts.push(t('tools.automod.trigger_keyword', { count: words.length, words: wordList(words) }));
			const patterns = meta.regexPatterns?.length ?? 0;
			if (patterns === 1) parts.push(t('tools.automod.trigger_regex_one'));
			else if (patterns) parts.push(t('tools.automod.trigger_regex', { count: patterns }));
			return parts.length ? parts.join(', ') : t('tools.automod.trigger_empty');
		}
		case AutoModerationRuleTriggerType.Spam:
			return t('tools.automod.trigger_spam');
		case AutoModerationRuleTriggerType.KeywordPreset:
			return t('tools.automod.trigger_preset', { presets: (meta.presets ?? []).map(presetLabel).join(', ') });
		case AutoModerationRuleTriggerType.MentionSpam:
			return t('tools.automod.trigger_mention_spam', { limit: meta.mentionTotalLimit ?? 0 });
		case AutoModerationRuleTriggerType.MemberProfile:
			return t('tools.automod.trigger_member_profile', { words: wordList(words) });
		default:
			return t('tools.automod.trigger_unknown');
	}
}

/** What happens when it triggers. */
function actionText(deps, actions = []) {
	const parts = [];
	for (const action of actions) {
		const meta = action?.metadata ?? {};
		switch (action?.type) {
			case AutoModerationActionType.BlockMessage:
				parts.push(t('tools.automod.action_block'));
				break;
			case AutoModerationActionType.SendAlertMessage: {
				const channel = meta.channelId ? (deps.guild?.channels?.cache?.get(meta.channelId) ?? null) : null;
				parts.push(channel ? t('tools.automod.action_alert', { channel: channel.name }) : t('tools.automod.action_alert_unknown'));
				break;
			}
			case AutoModerationActionType.Timeout: {
				// Sub-minute timeouts exist; rounding them to "0 minutes" would misreport the rule.
				const minutes = Math.max(1, Math.round((meta.durationSeconds ?? 0) / 60));
				parts.push(minutes === 1 ? t('tools.automod.action_timeout_one') : t('tools.automod.action_timeout', { minutes }));
				break;
			}
			case AutoModerationActionType.BlockMemberInteraction:
				parts.push(t('tools.automod.action_block_interaction'));
				break;
			default:
				break;
		}
	}
	return parts.length ? parts.join(', ') : t('tools.automod.action_none');
}

/** Who the rule skips, by name where the roles and channels are in the cache. */
function exemptText(rule) {
	const roles = [...(rule.exemptRoles?.values?.() ?? [])];
	const channels = [...(rule.exemptChannels?.values?.() ?? [])];
	if (!roles.length && !channels.length) return '';
	const names = [
		...roles.filter(Boolean).map((role) => role.name),
		...channels.filter(Boolean).map((channel) => `#${channel.name}`),
	];
	// The exempt collections map ids to cached objects, so a role the bot has never seen comes back
	// undefined. Reading an id out loud helps nobody; say that something is exempt and leave it there.
	return names.length ? t('tools.automod.exempt_suffix', { targets: names.join(', ') }) : t('tools.automod.exempt_suffix_unknown');
}

/** One plain phrase covering what the rule does right now. */
function ruleEffect(deps, rule) {
	return t('tools.automod.effect', {
		trigger: triggerText(rule),
		actions: actionText(deps, rule.actions ?? []),
		exempt: exemptText(rule),
	});
}

const stateText = (enabled) => (enabled === false ? t('tools.automod.state_off') : t('tools.automod.state_on'));

/** The structured half of a result: the same shape for every tool here. */
function ruleData(rule) {
	return {
		id: rule.id ?? null,
		name: rule.name,
		enabled: rule.enabled !== false,
		trigger: rule.triggerType ?? null,
		keywords: rule.triggerMetadata?.keywordFilter ?? [],
		actions: (rule.actions ?? []).map((action) => action?.type).filter((type) => type !== undefined),
	};
}

/** Role names -> roles, refusing (rather than silently skipping) a name that resolves to nothing. */
function resolveExemptRoles(deps, names) {
	const roles = [];
	for (const raw of Array.isArray(names) ? names : names ? [names] : []) {
		const text = String(raw ?? '').trim();
		if (!text) continue;
		const role = resolveRole(deps, text);
		if (!role) return { error: t('tools.automod.exempt_role_not_found', { name: text }) };
		if (!roles.some((existing) => existing.id === role.id)) roles.push(role);
	}
	return { roles: roles.slice(0, MAX_EXEMPT_ROLES) };
}

function resolveExemptChannels(deps, names) {
	const channels = [];
	for (const raw of Array.isArray(names) ? names : names ? [names] : []) {
		const text = String(raw ?? '').trim();
		if (!text) continue;
		const channel = resolveAnyChannel(deps, text);
		if (!channel) return { error: t('tools.automod.exempt_channel_not_found', { name: text }) };
		if (!channels.some((existing) => existing.id === channel.id)) channels.push(channel);
	}
	return { channels: channels.slice(0, MAX_EXEMPT_CHANNELS) };
}

export const tools = [
	defineTool({
		name: 'list_automod_rules',
		description:
			'Lists the auto-moderation rules on the server: what each one looks for, what it does when it fires, ' +
			'whether it is on, and who it skips. Owner only (reading the rules needs the Manage Server permission).',
		gate: { keywords: WORDS.automod },
		async handler(args, deps) {
			if (!ruleManager(deps)?.fetch) return { ok: false, spoken: t('tools.automod.unavailable') };
			const problem = permissionProblem(deps);
			if (problem) return { ok: false, spoken: problem };
			try {
				const rules = await fetchRules(deps);
				if (!rules.length) return { ok: true, spoken: t('tools.automod.no_rules'), data: { rules: [] } };
				const lines = rules.map((rule) =>
					t('tools.automod.rule_line', { rule: rule.name, state: stateText(rule.enabled), effect: ruleEffect(deps, rule) }),
				);
				return {
					ok: true,
					spoken:
						rules.length === 1
							? t('tools.automod.list_one', { rules: lines.join('. ') })
							: t('tools.automod.list', { count: rules.length, rules: lines.join('. ') }),
					data: { rules: rules.map((rule) => ruleData(rule)) },
				};
			} catch (err) {
				return failure(deps, 'automod rule listing failed', err, t('tools.automod.list_failed'));
			}
		},
	}),

	defineTool({
		name: 'create_automod_keyword_rule',
		description:
			'Creates an auto-moderation rule that blocks every message containing one of the given words. Optionally ' +
			'reports each hit in a channel (alert_channel) and/or times the writer out (timeout_minutes), and can skip ' +
			'given roles and channels. Words of fewer than two letters, and bare wildcards, are refused because they ' +
			'would block almost every message. Needs the Manage Server permission, plus Moderate Members when ' +
			'timeout_minutes is used. Owner only.',
		parameters: P.obj(
			{
				name: P.str('Name of the rule (how the owner will refer to it later)'),
				keywords: P.list('The words or phrases to block; a "*" may be used as a wildcard, e.g. "spam*"'),
				alert_channel: P.str('Text channel to report every hit in (optional)'),
				timeout_minutes: P.int(`Also time the writer out for this many minutes (optional, at most ${MAX_TIMEOUT_MINUTES} = 4 weeks)`),
				custom_message: P.str(`Explanation shown to the person whose message was blocked (optional, ${MAX_CUSTOM_MESSAGE} characters at most)`),
				exempt_roles: P.list('Roles the rule does not apply to (optional)'),
				exempt_channels: P.list('Channels the rule does not apply to (optional)'),
				enabled: P.bool('Should the rule start switched on (default true)'),
			},
			['name', 'keywords'],
		),
		gate: { keywords: WORDS.automod },
		async handler(args, deps) {
			if (!ruleManager(deps)?.create) return { ok: false, spoken: t('tools.automod.unavailable') };
			const parsed = parseKeywords(args.keywords);
			if (parsed.tooShort.length) {
				return {
					ok: false,
					spoken: t('tools.automod.keyword_too_short', { words: parsed.tooShort.join(', '), min: MIN_KEYWORD_LETTERS }),
				};
			}
			if (parsed.tooLong.length) {
				return { ok: false, spoken: t('tools.automod.keyword_too_long', { words: parsed.tooLong.join(', '), limit: MAX_KEYWORD_LENGTH }) };
			}
			if (!parsed.keywords.length) return { ok: false, spoken: t('tools.automod.no_keywords', { min: MIN_KEYWORD_LETTERS }) };

			const requestedMinutes = Number(args.timeout_minutes);
			const minutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0 ? Math.min(MAX_TIMEOUT_MINUTES, Math.round(requestedMinutes)) : 0;
			const problem = permissionProblem(deps, { timeout: minutes > 0 });
			if (problem) return { ok: false, spoken: problem };

			let alert = null;
			if (args.alert_channel) {
				alert = resolveAnyChannel(deps, String(args.alert_channel));
				if (!alert) return { ok: false, spoken: t('tools.automod.alert_channel_not_found', { name: args.alert_channel }) };
				if (!ALERT_CHANNEL_TYPES.has(alert.type)) return { ok: false, spoken: t('tools.automod.alert_channel_not_text', { channel: alert.name }) };
			}
			const exemptRoles = resolveExemptRoles(deps, args.exempt_roles);
			if (exemptRoles.error) return { ok: false, spoken: exemptRoles.error };
			const exemptChannels = resolveExemptChannels(deps, args.exempt_channels);
			if (exemptChannels.error) return { ok: false, spoken: exemptChannels.error };

			const name = String(args.name ?? '').trim().slice(0, MAX_RULE_NAME) || t('tools.automod.default_name');
			const enabled = args.enabled !== false;
			// Built in the shape Discord echoes back, so the spoken summary and the API call cannot drift apart.
			const actions = [
				{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: args.custom_message ? String(args.custom_message).slice(0, MAX_CUSTOM_MESSAGE) : undefined } },
			];
			if (alert) actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channelId: alert.id } });
			if (minutes) actions.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: minutes * 60 } });

			try {
				const existing = await fetchRules(deps);
				const keywordRules = existing.filter((rule) => rule.triggerType === AutoModerationRuleTriggerType.Keyword);
				if (keywordRules.length >= MAX_KEYWORD_RULES) return { ok: false, spoken: t('tools.automod.too_many_rules', { limit: MAX_KEYWORD_RULES }) };
				// Two rules with the same name would make "turn X off" ambiguous for the rest of this module.
				if (existing.some((rule) => normalize(rule.name) === normalize(name))) return { ok: false, spoken: t('tools.automod.name_taken', { name }) };

				const created = await ruleManager(deps).create({
					name,
					eventType: AutoModerationRuleEventType.MessageSend,
					triggerType: AutoModerationRuleTriggerType.Keyword,
					triggerMetadata: { keywordFilter: parsed.keywords },
					actions: actions.map(({ type, metadata }) => ({
						type,
						metadata: { durationSeconds: metadata.durationSeconds, channel: metadata.channelId, customMessage: metadata.customMessage },
					})),
					enabled,
					exemptRoles: exemptRoles.roles,
					exemptChannels: exemptChannels.channels,
					reason: t('tools.helpers.audit_reason'),
				});
				const view = {
					id: created?.id ?? null,
					name: created?.name ?? name,
					enabled,
					triggerType: AutoModerationRuleTriggerType.Keyword,
					triggerMetadata: { keywordFilter: parsed.keywords },
					actions,
					exemptRoles: new Map(exemptRoles.roles.map((role) => [role.id, role])),
					exemptChannels: new Map(exemptChannels.channels.map((channel) => [channel.id, channel])),
				};
				deps.log?.(t('tools.automod.log_created', { rule: view.name, count: parsed.keywords.length }));
				return {
					ok: true,
					spoken: t('tools.automod.created', { rule: view.name, state: stateText(enabled), effect: ruleEffect(deps, view) }),
					data: { ...ruleData(view), alert_channel: alert?.name ?? null, timeout_minutes: minutes || null },
				};
			} catch (err) {
				return failure(deps, 'automod rule creation failed', err, t('tools.automod.create_failed'));
			}
		},
	}),

	defineTool({
		name: 'set_automod_rule_enabled',
		description:
			'Turns an existing auto-moderation rule on or off without changing what it filters. Switching it off stops ' +
			'it blocking anything until it is switched back on. Needs the Manage Server permission. Owner only.',
		parameters: P.obj(
			{
				rule: P.str('Name (or id) of the rule'),
				enabled: P.bool('true = turn it on, false = turn it off'),
			},
			['rule', 'enabled'],
		),
		gate: { keywords: WORDS.automod },
		async handler(args, deps) {
			if (!ruleManager(deps)?.edit) return { ok: false, spoken: t('tools.automod.unavailable') };
			const problem = permissionProblem(deps);
			if (problem) return { ok: false, spoken: problem };
			const enabled = args.enabled !== false;
			try {
				const rules = await fetchRules(deps);
				const rule = findRule(rules, args.rule);
				if (!rule) return { ok: false, spoken: t('tools.automod.rule_not_found', { name: args.rule }) };
				if ((rule.enabled !== false) === enabled) {
					return {
						ok: true,
						spoken: t(enabled ? 'tools.automod.already_on' : 'tools.automod.already_off', { rule: rule.name }),
						data: ruleData(rule),
					};
				}
				await ruleManager(deps).edit(rule.id, { enabled, reason: t('tools.helpers.audit_reason') });
				deps.log?.(t('tools.automod.log_toggled', { rule: rule.name, state: stateText(enabled) }));
				return {
					ok: true,
					spoken: enabled
						? t('tools.automod.turned_on', { rule: rule.name, effect: ruleEffect(deps, rule) })
						: t('tools.automod.turned_off', { rule: rule.name }),
					data: { ...ruleData(rule), enabled },
				};
			} catch (err) {
				return failure(deps, 'automod rule toggle failed', err, t('tools.automod.toggle_failed'));
			}
		},
	}),

	defineTool({
		name: 'update_automod_keywords',
		description:
			'Changes the blocked words of an existing keyword auto-moderation rule: add words, remove words, or replace ' +
			'the whole list. Words of fewer than two letters are refused, and the list may not be emptied (delete the ' +
			'rule instead). Needs the Manage Server permission. Owner only.',
		parameters: P.obj(
			{
				rule: P.str('Name (or id) of the rule'),
				add: P.list('Words to add to the filter'),
				remove: P.list('Words to take out of the filter'),
				replace: P.list('The complete new word list (replaces everything the rule had)'),
			},
			['rule'],
		),
		gate: { keywords: WORDS.automod },
		async handler(args, deps) {
			if (!ruleManager(deps)?.edit) return { ok: false, spoken: t('tools.automod.unavailable') };
			const problem = permissionProblem(deps);
			if (problem) return { ok: false, spoken: problem };
			const incoming = parseKeywords(args.replace ?? args.add);
			if (incoming.tooShort.length) {
				return { ok: false, spoken: t('tools.automod.keyword_too_short', { words: incoming.tooShort.join(', '), min: MIN_KEYWORD_LETTERS }) };
			}
			if (incoming.tooLong.length) {
				return { ok: false, spoken: t('tools.automod.keyword_too_long', { words: incoming.tooLong.join(', '), limit: MAX_KEYWORD_LENGTH }) };
			}
			const removals = (Array.isArray(args.remove) ? args.remove : args.remove ? [args.remove] : [])
				.flatMap((value) => String(value).split(/\s*(?:,|;|\/)\s*/u))
				.map((value) => value.trim().toLowerCase())
				.filter(Boolean);
			if (!incoming.keywords.length && !removals.length) return { ok: false, spoken: t('tools.automod.nothing_to_update') };

			try {
				const rules = await fetchRules(deps);
				const rule = findRule(rules, args.rule);
				if (!rule) return { ok: false, spoken: t('tools.automod.rule_not_found', { name: args.rule }) };
				if (rule.triggerType !== AutoModerationRuleTriggerType.Keyword) {
					return { ok: false, spoken: t('tools.automod.not_keyword_rule', { rule: rule.name, trigger: triggerText(rule) }) };
				}
				const current = rule.triggerMetadata?.keywordFilter ?? [];
				const base = args.replace ? incoming.keywords : [...current, ...incoming.keywords];
				const next = [];
				for (const word of base) {
					const key = word.toLowerCase();
					if (removals.includes(key)) continue;
					if (!next.some((existing) => existing.toLowerCase() === key)) next.push(word);
				}
				if (!next.length) return { ok: false, spoken: t('tools.automod.would_be_empty', { rule: rule.name }) };
				if (next.length === current.length && next.every((word, index) => word === current[index])) {
					return { ok: true, spoken: t('tools.automod.words_unchanged', { rule: rule.name }), data: ruleData(rule) };
				}
				const keywords = next.slice(0, MAX_KEYWORDS);
				// Only the fields that belong to a keyword trigger are sent back: passing the mention-spam fields
				// of the cached metadata along would describe the rule as something it is not.
				await ruleManager(deps).edit(rule.id, {
					triggerMetadata: {
						keywordFilter: keywords,
						allowList: rule.triggerMetadata?.allowList ?? [],
						regexPatterns: rule.triggerMetadata?.regexPatterns ?? [],
					},
					reason: t('tools.helpers.audit_reason'),
				});
				deps.log?.(t('tools.automod.log_updated', { rule: rule.name, count: keywords.length }));
				const spoken =
					keywords.length === 1
						? t('tools.automod.updated_one', { rule: rule.name, words: wordList(keywords), state: stateText(rule.enabled) })
						: t('tools.automod.updated', { rule: rule.name, count: keywords.length, words: wordList(keywords), state: stateText(rule.enabled) });
				return { ok: true, spoken, data: { ...ruleData(rule), keywords } };
			} catch (err) {
				return failure(deps, 'automod keyword update failed', err, t('tools.automod.update_failed'));
			}
		},
	}),

	defineTool({
		name: 'delete_automod_rule',
		description:
			'Deletes an auto-moderation rule for good; whatever it used to block is allowed again. Needs the Manage ' +
			'Server permission. Owner only; two-step (asks first, deletes with confirm:true).',
		parameters: P.obj({ rule: P.str('Name (or id) of the rule'), confirm: P.confirm() }, ['rule']),
		gate: { keywords: WORDS.delete },
		async handler(args, deps, { name }) {
			if (!ruleManager(deps)?.delete) return { ok: false, spoken: t('tools.automod.unavailable') };
			const problem = permissionProblem(deps);
			if (problem) return { ok: false, spoken: problem };
			try {
				const rules = await fetchRules(deps);
				const rule = findRule(rules, args.rule);
				if (!rule) return { ok: false, spoken: t('tools.automod.rule_not_found', { name: args.rule }) };
				const decision = checkConfirmation(deps, {
					key: name,
					target: rule.id,
					confirm: args.confirm,
					question: t('tools.automod.delete_question', { rule: rule.name, effect: ruleEffect(deps, rule) }),
				});
				if (decision.ask) return askConfirmation(decision.ask, { rule: rule.name });
				if (decision.stale) return STALE_CONFIRMATION();
				const ruleName = rule.name;
				await ruleManager(deps).delete(rule.id, t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.automod.log_deleted', { rule: ruleName }));
				return { ok: true, spoken: t('tools.automod.deleted', { rule: ruleName }), data: { name: ruleName, id: rule.id ?? null } };
			} catch (err) {
				return failure(deps, 'automod rule deletion failed', err, t('tools.automod.delete_failed'));
			}
		},
	}),
];
