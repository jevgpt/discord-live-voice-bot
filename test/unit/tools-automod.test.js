import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutoModerationActionType, AutoModerationRuleTriggerType, ChannelType, PermissionFlagsBits } from 'discord.js';
import { callTool, toolMeta } from '../../src/tools.js';
import { ownerVoice } from '../owner-voice.js';

const AUTOMOD_TOOLS = [
	'list_automod_rules',
	'create_automod_keyword_rule',
	'set_automod_rule_enabled',
	'update_automod_keywords',
	'delete_automod_rule',
];

const keywordRule = () => ({
	id: 'rule-keyword',
	name: 'Swearing',
	enabled: true,
	triggerType: AutoModerationRuleTriggerType.Keyword,
	triggerMetadata: { keywordFilter: ['spam', 'scam'], allowList: [], regexPatterns: [], presets: [], mentionTotalLimit: null },
	actions: [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: null, channelId: null, durationSeconds: null } }],
	exemptRoles: new Map(),
	exemptChannels: new Map(),
});

const spamRule = () => ({
	id: 'rule-spam',
	name: 'Spam guard',
	enabled: false,
	triggerType: AutoModerationRuleTriggerType.Spam,
	triggerMetadata: { keywordFilter: [], allowList: [], regexPatterns: [], presets: [], mentionTotalLimit: null },
	actions: [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: null, channelId: null, durationSeconds: null } }],
	exemptRoles: new Map(),
	exemptChannels: new Map(),
});

function makeDeps({ owner = true, rules = [keywordRule(), spamRule()], permissions = ['ManageGuild', 'ModerateMembers'], manager = true } = {}) {
	const calls = [];
	const granted = new Set(permissions.map((name) => PermissionFlagsBits[name]));
	const textChannel = { id: '10', name: 'mod-log', type: ChannelType.GuildText };
	const voiceChannel = { id: 'v1', name: 'General', type: ChannelType.GuildVoice };
	const autoModerationRules = {
		fetch: async () => {
			calls.push({ fetch: true });
			return new Map(rules.map((rule) => [rule.id, rule]));
		},
		create: async (options) => {
			calls.push({ create: options });
			return { id: 'rule-new', name: options.name, enabled: options.enabled };
		},
		edit: async (id, options) => {
			calls.push({ edit: { id, ...options } });
			return rules.find((rule) => rule.id === id) ?? null;
		},
		delete: async (id, reason) => {
			calls.push({ delete: id, reason });
		},
	};
	const guild = {
		id: `g-${Math.random().toString(36).slice(2)}`, // its own confirmation store per test
		name: 'Test',
		channels: { cache: new Map([['10', textChannel], ['v1', voiceChannel]]) },
		voiceStates: { cache: new Map() },
		members: { me: { permissions: { has: (flag) => granted.has(flag) } }, cache: new Map(), fetch: async () => new Map() },
		roles: { cache: new Map([['r1', { id: 'r1', name: 'Mods' }]]), everyone: { id: 'everyone' } },
		emojis: { cache: new Map() },
		stickers: { cache: new Map(), fetch: async () => {} },
		...(manager ? { autoModerationRules } : {}),
	};
	const deps = {
		guild,
		cfg: { textChannelId: null },
		log: () => {},
		activity: () => {},
		pendingConfirmations: new Map(),
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, calls, rules, textChannel, voiceChannel };
}

const created = (calls) => calls.find((call) => call.create)?.create ?? null;
const edited = (calls) => calls.find((call) => call.edit)?.edit ?? null;

describe('automod tools: the owner gate', () => {
	it('registers every automod tool as gated and refuses each one without an owner', async () => {
		const meta = new Map(toolMeta().map((entry) => [entry.name, entry]));
		for (const name of AUTOMOD_TOOLS) {
			assert.ok(meta.has(name), `${name} is missing from the registry`);
			assert.equal(meta.get(name).gated, true, `${name} must be owner-gated`);
			const { deps, calls } = makeDeps({ owner: false });
			const result = await callTool(name, { rule: 'Swearing', keywords: ['spam'], name: 'x', enabled: false }, deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.denied, true, `${name} must come back refused by the gate`);
			assert.equal(calls.length, 0, `${name} must not touch Discord when the gate is shut`);
		}
	});
});

describe('list_automod_rules', () => {
	it('says what each rule looks for, what it does and whether it is on', async () => {
		const { deps } = makeDeps();
		const result = await callTool('list_automod_rules', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.match(result.spoken, /Swearing \(on\)/);
		assert.match(result.spoken, /2 blocked words \(spam, scam\)/);
		assert.match(result.spoken, /blocks the message/);
		assert.match(result.spoken, /Spam guard \(off\)/);
		assert.match(result.spoken, /catches generic spam/);
		assert.equal(result.data.rules.length, 2);
		assert.deepEqual(result.data.rules[0].keywords, ['spam', 'scam']);
	});

	it('refuses with the missing permission named instead of letting the API throw', async () => {
		const { deps, calls } = makeDeps({ permissions: [] });
		const result = await callTool('list_automod_rules', {}, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Server/);
		assert.equal(calls.length, 0, 'nothing is fetched when the permission is missing');
	});
});

describe('create_automod_keyword_rule', () => {
	it('creates a keyword rule with an alert channel and a timeout, and says plainly what it now does', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool(
			'create_automod_keyword_rule',
			{ name: 'Insults', keywords: ['idiot, moron'], alert_channel: 'mod-log', timeout_minutes: 10, exempt_roles: ['Mods'] },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		const payload = created(calls);
		assert.equal(payload.triggerType, AutoModerationRuleTriggerType.Keyword);
		assert.deepEqual(payload.triggerMetadata.keywordFilter, ['idiot', 'moron'], 'one spoken answer may carry several words');
		assert.deepEqual(
			payload.actions.map((action) => action.type),
			[AutoModerationActionType.BlockMessage, AutoModerationActionType.SendAlertMessage, AutoModerationActionType.Timeout],
		);
		assert.equal(payload.actions[1].metadata.channel, '10');
		assert.equal(payload.actions[2].metadata.durationSeconds, 600);
		assert.deepEqual(payload.exemptRoles.map((role) => role.id), ['r1']);
		assert.match(result.spoken, /Insults rule is ready and it is on/);
		assert.match(result.spoken, /2 blocked words \(idiot, moron\)/);
		assert.match(result.spoken, /reports it in #mod-log/);
		assert.match(result.spoken, /times the person out for 10 minutes/);
		assert.match(result.spoken, /skips Mods/);
		assert.equal(result.data.timeout_minutes, 10);
	});

	it('refuses a one-character keyword, which would block nearly every message', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('create_automod_keyword_rule', { name: 'Everything', keywords: ['a', 'idiot'] }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /"a"/);
		assert.match(result.spoken, /2 letters/);
		assert.equal(created(calls), null, 'nothing may be created');
	});

	it('refuses a bare wildcard the same way', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('create_automod_keyword_rule', { name: 'Everything', keywords: ['*'] }, deps);
		assert.equal(result.ok, false);
		assert.equal(created(calls), null);
	});

	it('refuses a timeout action when the bot lacks Moderate Members, and names the permission', async () => {
		const { deps, calls } = makeDeps({ permissions: ['ManageGuild'] });
		const result = await callTool('create_automod_keyword_rule', { name: 'Insults', keywords: ['idiot'], timeout_minutes: 5 }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Moderate Members/);
		assert.equal(created(calls), null);
	});

	it('refuses an alert channel that cannot receive messages', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('create_automod_keyword_rule', { name: 'Insults', keywords: ['idiot'], alert_channel: 'General' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /not a text channel/);
		assert.equal(created(calls), null);
	});

	it('refuses a name another rule already uses, so later commands stay unambiguous', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('create_automod_keyword_rule', { name: 'Swearing', keywords: ['idiot'] }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /already a rule/);
		assert.equal(created(calls), null);
	});
});

describe('set_automod_rule_enabled', () => {
	it('switches a rule off and says it blocks nothing until it comes back', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('set_automod_rule_enabled', { rule: 'swearing', enabled: false }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(edited(calls).id, 'rule-keyword');
		assert.equal(edited(calls).enabled, false);
		assert.match(result.spoken, /off now/);
		assert.equal(result.data.enabled, false);
	});

	it('switches a rule on and repeats what it does', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('set_automod_rule_enabled', { rule: 'Spam guard', enabled: true }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(edited(calls).enabled, true);
		assert.match(result.spoken, /catches generic spam/);
	});

	it('refuses a rule that does not exist', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('set_automod_rule_enabled', { rule: 'no such thing', enabled: false }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /could not find/);
		assert.equal(edited(calls), null);
	});

	it('does not call Discord when the rule is already in the wanted state', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('set_automod_rule_enabled', { rule: 'Swearing', enabled: true }, deps);
		assert.equal(result.ok, true);
		assert.match(result.spoken, /already on/);
		assert.equal(edited(calls), null);
	});
});

describe('update_automod_keywords', () => {
	it('adds a word to the filter and reports the whole new list', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('update_automod_keywords', { rule: 'Swearing', add: ['scammer'] }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(edited(calls).triggerMetadata.keywordFilter, ['spam', 'scam', 'scammer']);
		assert.equal(edited(calls).triggerMetadata.mentionTotalLimit, undefined, 'only keyword fields are sent back');
		assert.match(result.spoken, /3 words: spam, scam, scammer/);
	});

	it('removes a word and replaces the list wholesale', async () => {
		const { deps, calls } = makeDeps();
		const removed = await callTool('update_automod_keywords', { rule: 'Swearing', remove: ['scam'] }, deps);
		assert.equal(removed.ok, true, removed.spoken);
		assert.deepEqual(edited(calls).triggerMetadata.keywordFilter, ['spam']);
		assert.match(removed.spoken, /one word: spam/, 'a single word is not read out as "1 words"');

		const second = makeDeps();
		const result = await callTool('update_automod_keywords', { rule: 'Swearing', replace: ['grift', 'fraud'] }, second.deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(edited(second.calls).triggerMetadata.keywordFilter, ['grift', 'fraud']);
	});

	it('refuses a rule that has no word list', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('update_automod_keywords', { rule: 'Spam guard', add: ['idiot'] }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /no words to change/);
		assert.equal(edited(calls), null);
	});

	it('refuses to empty the filter, and points at deleting the rule instead', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('update_automod_keywords', { rule: 'Swearing', remove: ['spam', 'scam'] }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /delete the rule/);
		assert.equal(edited(calls), null);
	});
});

describe('delete_automod_rule', () => {
	it('asks first and only deletes on the second, confirmed call', async () => {
		const { deps, calls } = makeDeps();
		const owner = ownerVoice(deps);
		const question = await callTool('delete_automod_rule', { rule: 'Swearing' }, deps);
		assert.equal(question.ok, false);
		assert.equal(question.needs_confirmation, true);
		assert.match(question.spoken, /Swearing/);
		assert.ok(!calls.some((call) => call.delete), 'the question alone must not delete anything');

		owner.says('yes');
		const done = await callTool('delete_automod_rule', { rule: 'Swearing', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.equal(calls.find((call) => call.delete)?.delete, 'rule-keyword');
		assert.match(done.spoken, /allowed again/);
	});

	it('refuses a confirmation that names a different rule than the question did', async () => {
		const { deps, calls } = makeDeps();
		const owner = ownerVoice(deps);
		await callTool('delete_automod_rule', { rule: 'Swearing' }, deps);
		owner.says('yes');
		const result = await callTool('delete_automod_rule', { rule: 'Spam guard', confirm: true }, deps);
		assert.equal(result.ok, false);
		assert.ok(!calls.some((call) => call.delete));
	});

	it('refuses a rule that does not exist', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('delete_automod_rule', { rule: 'ghost rule', confirm: true }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /could not find/);
		assert.ok(!calls.some((call) => call.delete));
	});

	it('refuses when the server has no auto-moderation manager at all', async () => {
		const { deps } = makeDeps({ manager: false });
		const result = await callTool('delete_automod_rule', { rule: 'Swearing', confirm: true }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /cannot reach/);
	});
});
