import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { callTool, toolMeta } from '../../src/tools.js';
import { t } from '../../src/i18n/index.js';
import { ownerVoice } from '../owner-voice.js';

// The tools that change the server; each one has to be closed to everybody but the owner.
const GATED = ['create_webhook', 'rename_webhook', 'delete_webhook', 'send_webhook_url'];

// A webhook address is a credential. Every result is run through this: the token and the URL must not
// appear in `spoken`, in `data`, in a log line or anywhere else the model or the room can see them.
const SECRETS = ['tok-alpha', 'tok-beta', 'https://discord.com/api/webhooks'];

function assertNoSecret(payload, where) {
	const text = JSON.stringify(payload ?? null);
	for (const secret of SECRETS) assert.ok(!text.includes(secret), `${where} must not carry the webhook address`);
}

function makeWebhook({ id, name, channelId, token = 'tok-alpha', type = 1, creator = 'jane' }, actions) {
	const hook = {
		id,
		name,
		channelId,
		token,
		type,
		owner: creator ? { username: creator, displayName: creator } : null,
		createdAt: new Date('2024-01-02T00:00:00Z'),
		get url() {
			return `https://discord.com/api/webhooks/${id}/${token}`;
		},
		edit: async ({ name: next }) => {
			hook.name = next;
			actions.push({ renamed: `${id}->${next}` });
			return hook;
		},
		delete: async () => actions.push({ deleted: id }),
	};
	return hook;
}

/**
 * Server with a text channel (#chat), a voice channel (General), a category (Lounge) and two webhooks.
 * `permitted: false` takes the bot's Manage Webhooks permission away.
 */
function makeDeps({ owner = false, permitted = true, hooks = null, guildId = String(Math.random()) } = {}) {
	const actions = [];
	const perms = { has: () => permitted };
	const channelOf = (id, name, type) => ({
		id,
		name,
		type,
		permissionsFor: () => perms,
		fetchWebhooks: async () => new Map(webhooks.filter((hook) => hook.channelId === id).map((hook) => [hook.id, hook])),
		createWebhook: async ({ name: hookName }) => {
			const created = makeWebhook({ id: `w${webhooks.length + 1}`, name: hookName, channelId: id }, actions);
			webhooks.push(created);
			actions.push({ created: `${hookName}@${name}` });
			return created;
		},
	});
	const webhooks = [];
	const chat = channelOf('10', 'chat', ChannelType.GuildText);
	const voice = channelOf('v1', 'General', ChannelType.GuildVoice);
	const lounge = { id: 'c1', name: 'Lounge', type: ChannelType.GuildCategory, permissionsFor: () => perms };
	webhooks.push(
		...(hooks ?? [
			{ id: 'w1', name: 'News Hook', channelId: '10' },
			{ id: 'w2', name: 'Alerts', channelId: 'v1', token: 'tok-beta', creator: 'sam' },
		]).map((spec) => makeWebhook(spec, actions)),
	);
	const ownerMember = { id: 'owner1', displayName: 'Owner', user: { username: 'owner' }, send: async (payload) => actions.push({ dm: payload.content }) };
	const guild = {
		id: guildId,
		channels: { cache: new Map([['10', chat], ['v1', voice], ['c1', lounge]]) },
		members: { cache: new Map([['owner1', ownerMember]]), me: { id: 'bot', permissions: perms }, fetch: async () => new Map() },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		fetchWebhooks: async () => new Map(webhooks.map((hook) => [hook.id, hook])),
	};
	const deps = {
		guild,
		cfg: { ownerId: 'owner1' },
		log: (line) => actions.push({ log: line }),
		activity: (event) => actions.push({ activity: event }),
		pendingConfirmations: new Map(),
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, actions, guild, webhooks };
}

describe('webhook tools: the gate', () => {
	it('refuses every tool that changes the server when the owner did not ask, and leaves the listing open', async () => {
		const meta = new Map(toolMeta().map((entry) => [entry.name, entry]));
		assert.equal(meta.get('list_webhooks')?.gated, false, 'listing is read-only and stays ungated');
		for (const name of GATED) {
			assert.equal(meta.get(name)?.gated, true, `${name} must be gated`);
			const { deps, actions } = makeDeps();
			const result = await callTool(name, { channel: 'chat', webhook: 'News Hook', name: 'Renamed' }, deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.denied, true, `${name} must come back refused by the gate`);
			assert.ok(!actions.some((entry) => entry.created || entry.renamed || entry.deleted), `${name} must not touch the server`);
		}
	});
});

describe('list_webhooks', () => {
	it('lists the whole server with the channel and the creator, and never the address', async () => {
		const { deps } = makeDeps();
		const result = await callTool('list_webhooks', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.count, 2);
		assert.deepEqual(
			result.data.webhooks.map((hook) => [hook.name, hook.channel, hook.creator]),
			[['News Hook', 'chat', 'jane'], ['Alerts', 'General', 'sam']],
		);
		assert.ok(result.spoken.includes('News Hook') && result.spoken.includes('chat'));
		assertNoSecret(result, 'the listing result');
	});

	it('lists one channel on its own and says so when it is empty', async () => {
		const { deps } = makeDeps();
		const chat = await callTool('list_webhooks', { channel: 'chat' }, deps);
		assert.equal(chat.ok, true, chat.spoken);
		assert.deepEqual(chat.data.webhooks.map((hook) => hook.name), ['News Hook']);
		const empty = await callTool('list_webhooks', { channel: 'chat' }, makeDeps({ hooks: [] }).deps);
		assert.equal(empty.ok, true, empty.spoken);
		assert.deepEqual(empty.data.webhooks, []);
	});

	it('refuses when the bot does not hold Manage Webhooks, and says which permission it needs', async () => {
		const { deps } = makeDeps({ permitted: false });
		const server = await callTool('list_webhooks', {}, deps);
		assert.equal(server.ok, false);
		assert.equal(server.spoken, t('tools.webhooks.no_permission'));
		const channel = await callTool('list_webhooks', { channel: 'chat' }, deps);
		assert.equal(channel.spoken, t('tools.webhooks.no_permission_channel', { channel: 'chat' }));
	});

	it('refuses a category: a channel kind that cannot hold a webhook at all', async () => {
		const { deps } = makeDeps();
		const result = await callTool('list_webhooks', { channel: 'Lounge' }, deps);
		assert.equal(result.ok, false);
		assert.equal(result.spoken, t('tools.webhooks.not_webhook_channel', { name: 'Lounge' }));
	});
});

describe('create_webhook', () => {
	it('creates one in a text channel and does not read the address out loud', async () => {
		const { deps, actions } = makeDeps({ owner: true });
		const result = await callTool('create_webhook', { channel: 'chat', name: 'Deploys' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(result.data, { id: 'w3', name: 'Deploys', channel: 'chat' });
		assert.ok(actions.some((entry) => entry.created === 'Deploys@chat'));
		assertNoSecret(result, 'the create result');
		assertNoSecret(actions.filter((entry) => entry.log), 'the log line');
	});

	it('creates one in a voice channel too', async () => {
		const { deps } = makeDeps({ owner: true });
		const result = await callTool('create_webhook', { channel: 'General', name: 'Radio' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.channel, 'General');
	});

	it('refuses a name Discord would reject, a category, and a channel that is already full', async () => {
		const { deps, actions } = makeDeps({ owner: true });
		const reserved = await callTool('create_webhook', { channel: 'chat', name: 'Discord News' }, deps);
		assert.equal(reserved.ok, false);
		assert.equal(reserved.spoken, t('tools.webhooks.name_reserved'));
		const tooLong = await callTool('create_webhook', { channel: 'chat', name: 'x'.repeat(81) }, deps);
		assert.equal(tooLong.spoken, t('tools.webhooks.name_too_long', { limit: 80 }));
		const category = await callTool('create_webhook', { channel: 'Lounge', name: 'Deploys' }, deps);
		assert.equal(category.spoken, t('tools.webhooks.not_webhook_channel', { name: 'Lounge' }));
		assert.ok(!actions.some((entry) => entry.created), 'nothing is created by a refused call');

		const full = makeDeps({
			owner: true,
			hooks: Array.from({ length: 15 }, (unused, index) => ({ id: `f${index}`, name: `hook ${index}`, channelId: '10' })),
		});
		const result = await callTool('create_webhook', { channel: 'chat', name: 'Deploys' }, full.deps);
		assert.equal(result.ok, false);
		assert.equal(result.spoken, t('tools.webhooks.channel_full', { channel: 'chat', limit: 15 }));
	});
});

describe('rename_webhook', () => {
	it('renames the one that was named', async () => {
		const { deps, actions, webhooks } = makeDeps({ owner: true });
		const result = await callTool('rename_webhook', { webhook: 'News Hook', name: 'Release Notes' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.previous_name, 'News Hook');
		assert.equal(webhooks[0].name, 'Release Notes');
		assert.ok(actions.some((entry) => entry.renamed === 'w1->Release Notes'));
		assertNoSecret(result, 'the rename result');
	});

	it('refuses a webhook that is not there and one that could be either of two', async () => {
		const { deps, actions } = makeDeps({ owner: true });
		const missing = await callTool('rename_webhook', { webhook: 'Nope', name: 'Release Notes' }, deps);
		assert.equal(missing.ok, false);
		assert.equal(missing.spoken, t('tools.webhooks.not_found', { name: 'Nope' }));

		const twins = makeDeps({
			owner: true,
			hooks: [
				{ id: 'w1', name: 'Alerts', channelId: '10' },
				{ id: 'w2', name: 'Alerts', channelId: 'v1' },
			],
		});
		const ambiguous = await callTool('rename_webhook', { webhook: 'Alerts', name: 'Release Notes' }, twins.deps);
		assert.equal(ambiguous.ok, false);
		assert.ok(ambiguous.spoken.includes('chat') && ambiguous.spoken.includes('General'), ambiguous.spoken);
		// naming the channel settles it
		const settled = await callTool('rename_webhook', { webhook: 'Alerts', channel: 'chat', name: 'Release Notes' }, twins.deps);
		assert.equal(settled.ok, true, settled.spoken);
		assert.ok(!actions.some((entry) => entry.renamed), 'the refused calls changed nothing');
	});
});

describe('delete_webhook', () => {
	it('asks first and only deletes on the second call', async () => {
		const { deps, actions } = makeDeps({ owner: true });
		const owner = ownerVoice(deps);
		const asked = await callTool('delete_webhook', { webhook: 'News Hook' }, deps);
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.ok(!actions.some((entry) => entry.deleted), 'nothing is deleted before the answer');
		owner.says('yes');
		const done = await callTool('delete_webhook', { webhook: 'News Hook', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.deepEqual(actions.filter((entry) => entry.deleted), [{ deleted: 'w1' }]);
		assertNoSecret(done, 'the delete result');
	});

	it('refuses a confirmation that names a different webhook', async () => {
		const { deps, actions } = makeDeps({ owner: true });
		const owner = ownerVoice(deps);
		await callTool('delete_webhook', { webhook: 'News Hook' }, deps);
		owner.says('yes');
		const other = await callTool('delete_webhook', { webhook: 'Alerts', confirm: true }, deps);
		assert.equal(other.ok, false, 'the answer belongs to the other webhook');
		assert.ok(!actions.some((entry) => entry.deleted));
	});
});

describe('send_webhook_url', () => {
	it('sends the address to the owner by direct message and keeps it out of everything else', async () => {
		const { deps, actions } = makeDeps({ owner: true });
		const result = await callTool('send_webhook_url', { webhook: 'News Hook' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.delivered, true);
		const dm = actions.find((entry) => entry.dm);
		assert.ok(dm?.dm.includes('https://discord.com/api/webhooks/w1/tok-alpha'), 'the owner gets the real address');
		assertNoSecret(result, 'the result of send_webhook_url');
		assertNoSecret(actions.filter((entry) => entry.log || entry.activity), 'the log and the activity feed');
	});

	it('refuses when there is no token to build an address from, and when no owner is configured', async () => {
		const { deps, actions } = makeDeps({
			owner: true,
			hooks: [{ id: 'w1', name: 'Follower', channelId: '10', token: null, type: 2, creator: null }],
		});
		const noToken = await callTool('send_webhook_url', { webhook: 'Follower' }, deps);
		assert.equal(noToken.ok, false);
		assert.equal(noToken.spoken, t('tools.webhooks.url_unavailable', { webhook: 'Follower' }));

		const ownerless = makeDeps({ owner: true });
		ownerless.deps.cfg.ownerId = '';
		const noOwner = await callTool('send_webhook_url', { webhook: 'News Hook' }, ownerless.deps);
		assert.equal(noOwner.ok, false);
		assert.equal(noOwner.spoken, t('tools.webhooks.no_owner'));
		assert.ok(!actions.some((entry) => entry.dm) && !ownerless.actions.some((entry) => entry.dm), 'nothing was sent');
	});

	it('says the direct message did not go through instead of reading the address out loud', async () => {
		const { deps } = makeDeps({ owner: true });
		deps.guild.members.cache.get('owner1').send = async () => {
			throw new Error('Cannot send messages to this user');
		};
		const result = await callTool('send_webhook_url', { webhook: 'News Hook' }, deps);
		assert.equal(result.ok, false);
		assert.ok(result.spoken.startsWith(t('tools.webhooks.url_failed')), result.spoken);
		assertNoSecret(result, 'the failed send result');
	});
});
