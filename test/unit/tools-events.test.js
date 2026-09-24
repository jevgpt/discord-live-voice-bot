import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ChannelType,
	GuildScheduledEventEntityType,
	GuildScheduledEventStatus,
	PermissionFlagsBits,
} from 'discord.js';
import { callTool, toolMeta } from '../../src/tools.js';
import { ownerVoice } from '../owner-voice.js';

const HOUR = 3_600_000;
let guildCounter = 0;

/** A permissions object shaped like the one discord.js hands back (only .has is ever called). */
function permissions(names) {
	const bits = new Set(names.map((name) => PermissionFlagsBits[name]));
	return { has: (flag) => bits.has(flag) };
}

/**
 * A server with two scheduled events: one coming up in a voice channel, one already cancelled.
 * `guildPermissions` / `channelPermissions` are the bot's own, so a test can take one away and check
 * that the tool refuses with a reason instead of letting the API fail.
 */
function makeDeps({
	owner = false,
	guildPermissions = ['ManageEvents', 'CreateEvents'],
	channelPermissions = ['ViewChannel', 'Connect'],
	events = null,
} = {}) {
	const log = [];
	const calls = [];
	const channelPerms = permissions(channelPermissions);
	const mkChannel = (id, name, type) => ({ id, name, type, permissionsFor: () => channelPerms });
	const voice = mkChannel('v1', 'General', ChannelType.GuildVoice);
	const stage = mkChannel('v2', 'Main Stage', ChannelType.GuildStageVoice);
	const text = mkChannel('t1', 'chat', ChannelType.GuildText);

	const mkEvent = (patch) => {
		const event = {
			id: 'e1',
			name: 'Movie night',
			description: null,
			channelId: 'v1',
			creatorId: 'bot',
			entityType: GuildScheduledEventEntityType.Voice,
			entityMetadata: null,
			status: GuildScheduledEventStatus.Scheduled,
			scheduledStartTimestamp: Date.now() + 24 * HOUR,
			scheduledEndTimestamp: null,
			userCount: 3,
			url: 'https://discord.com/events/1/e1',
			...patch,
		};
		event.edit = async (options) => {
			calls.push({ edit: event.id, options });
			Object.assign(event, {
				name: options.name ?? event.name,
				description: options.description ?? event.description,
				status: options.status ?? event.status,
				channelId: options.channel?.id ?? event.channelId,
				entityMetadata: options.entityMetadata ?? event.entityMetadata,
				scheduledStartTimestamp: options.scheduledStartTime ? new Date(options.scheduledStartTime).getTime() : event.scheduledStartTimestamp,
				scheduledEndTimestamp: options.scheduledEndTime ? new Date(options.scheduledEndTime).getTime() : event.scheduledEndTimestamp,
			});
			return event;
		};
		return event;
	};
	const seeded = events ?? [mkEvent({}), mkEvent({ id: 'e2', name: 'Old quiz', status: GuildScheduledEventStatus.Canceled })];
	const store = new Map(seeded.map((event) => [event.id, event]));

	const guild = {
		id: `guild-${++guildCounter}`,
		channels: { cache: new Map([['v1', voice], ['v2', stage], ['t1', text]]) },
		voiceStates: { cache: new Map() },
		members: { cache: new Map(), fetch: async () => new Map(), me: { id: 'bot', permissions: permissions(guildPermissions) } },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		scheduledEvents: {
			fetch: async (options) => {
				if (options?.guildScheduledEvent) return store.get(options.guildScheduledEvent) ?? null;
				return new Map(store);
			},
			create: async (options) => {
				calls.push({ create: options });
				const created = mkEvent({
					id: 'new',
					name: options.name,
					entityType: options.entityType,
					channelId: options.channel?.id ?? null,
					entityMetadata: options.entityMetadata ?? null,
					scheduledStartTimestamp: new Date(options.scheduledStartTime).getTime(),
					scheduledEndTimestamp: options.scheduledEndTime ? new Date(options.scheduledEndTime).getTime() : null,
					userCount: 0,
				});
				store.set(created.id, created);
				return created;
			},
			fetchSubscribers: async (id, options) => {
				calls.push({ subscribers: id, options });
				return new Map([
					['u1', { user: { id: 'u1', username: 'jane' }, member: { id: 'u1', displayName: 'Jane Doe' } }],
					['u2', { user: { id: 'u2', username: 'sam' }, member: null }],
				]);
			},
		},
	};
	const deps = {
		guild,
		cfg: { textChannelId: null },
		selfId: 'bot',
		log: (line) => log.push(line),
		activity: () => {},
		// The realtime path builds a fresh deps per tool call; the two-step confirmation has to survive that.
		currentTurn: () => null,
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (list) => list[0];
	}
	return { deps, guild, store, calls, log, mkEvent };
}

describe('events: the owner gate', () => {
	it('refuses every tool that changes an event when the owner did not ask, and leaves the read-only ones open', async () => {
		const meta = new Map(toolMeta().map((entry) => [entry.name, entry]));
		for (const name of ['create_event', 'edit_event', 'cancel_event']) {
			assert.equal(meta.get(name)?.gated, true, `${name} must be gated`);
			const { deps, calls } = makeDeps();
			const result = await callTool(name, { event: 'Movie night', name: 'Party', start_time: 'in 2 hours', channel: 'General' }, deps);
			assert.equal(result.denied, true, name);
			assert.deepEqual(calls, [], 'nothing may reach Discord');
		}
		for (const name of ['list_events', 'event_interest']) {
			assert.equal(meta.get(name)?.gated, false, `${name} is a question, not a change`);
		}
	});
});

describe('list_events', () => {
	it('lists what is coming up and leaves out what is over', async () => {
		const { deps } = makeDeps();
		const result = await callTool('list_events', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(result.data.events.map((event) => event.name), ['Movie night']);
		assert.match(result.spoken, /Movie night/);
		assert.match(result.spoken, /General/, 'says where it is held');
		const all = await callTool('list_events', { include_finished: true }, deps);
		assert.deepEqual(all.data.events.map((event) => event.name), ['Movie night', 'Old quiz']);
	});

	it('says so instead of throwing when the server has no scheduled events at all', async () => {
		const { deps } = makeDeps();
		delete deps.guild.scheduledEvents;
		const result = await callTool('list_events', {}, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /cannot reach/i);
	});
});

describe('create_event', () => {
	it('creates a voice event from a spoken offset', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('create_event', { name: 'Game night', start_time: 'in 2 hours', channel: 'General' }, deps);
		assert.equal(result.ok, true, result.spoken);
		const options = calls.find((call) => call.create)?.create;
		assert.equal(options.entityType, GuildScheduledEventEntityType.Voice);
		assert.equal(options.channel.id, 'v1');
		const drift = Math.abs(new Date(options.scheduledStartTime).getTime() - (Date.now() + 2 * HOUR));
		assert.ok(drift < 60_000, `start should be two hours out, drifted ${drift}ms`);
		assert.equal(result.data.name, 'Game night');
	});

	it('holds an event on a stage channel and measures the end time from the start', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool(
			'create_event',
			{ name: 'Town hall', start_time: 'tomorrow at 21:00', end_time: '2 hours', channel: 'Main Stage', type: 'stage' },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		const options = calls.find((call) => call.create)?.create;
		assert.equal(options.entityType, GuildScheduledEventEntityType.StageInstance);
		const start = new Date(options.scheduledStartTime);
		const end = new Date(options.scheduledEndTime);
		assert.equal(start.getHours(), 21);
		assert.equal(end.getTime() - start.getTime(), 2 * HOUR, 'an offset end time is how long the event lasts');
	});

	it('creates an event outside Discord when it is given both a place and an end time', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool(
			'create_event',
			{ name: 'Picnic', start_time: 'tomorrow at 12:00', end_time: 'tomorrow at 16:00', location: 'Kugulu Park' },
			deps,
		);
		assert.equal(result.ok, true, result.spoken);
		const options = calls.find((call) => call.create)?.create;
		assert.equal(options.entityType, GuildScheduledEventEntityType.External);
		assert.deepEqual(options.entityMetadata, { location: 'Kugulu Park' });
		assert.equal(options.channel, undefined, 'an external event has no channel');
	});

	it('asks rather than inventing a time it could not read, and refuses one that has already passed', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const vague = await callTool('create_event', { name: 'Game night', start_time: 'sometime soonish', channel: 'General' }, deps);
		assert.equal(vague.ok, false);
		assert.match(vague.spoken, /could not work out a time/i);

		const dayOnly = await callTool('create_event', { name: 'Game night', start_time: 'tomorrow', channel: 'General' }, deps);
		assert.equal(dayOnly.ok, false);
		assert.match(dayOnly.spoken, /at what time/i);

		const past = await callTool('create_event', { name: 'Game night', start_time: '2020-01-01T10:00', channel: 'General' }, deps);
		assert.equal(past.ok, false);
		assert.match(past.spoken, /already passed/i);
		assert.deepEqual(calls, [], 'no event may be created from a time I had to guess');
	});

	it('refuses a text channel, and an external event that is missing its place or its end', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const wrongChannel = await callTool('create_event', { name: 'Game night', start_time: 'in 3 hours', channel: 'chat' }, deps);
		assert.equal(wrongChannel.ok, false);
		assert.match(wrongChannel.spoken, /not a voice or a stage channel/i);

		const noLocation = await callTool('create_event', { name: 'Picnic', start_time: 'in 3 hours', type: 'external' }, deps);
		assert.equal(noLocation.ok, false);
		assert.match(noLocation.spoken, /where is it happening/i);

		const noEnd = await callTool('create_event', { name: 'Picnic', start_time: 'in 3 hours', location: 'Kugulu Park' }, deps);
		assert.equal(noEnd.ok, false);
		assert.match(noEnd.spoken, /end time/i);
		assert.deepEqual(calls, []);
	});

	it('names the permission it is missing instead of letting Discord fail', async () => {
		const noEvents = makeDeps({ owner: true, guildPermissions: [] });
		const refused = await callTool('create_event', { name: 'Game night', start_time: 'in 2 hours', channel: 'General' }, noEvents.deps);
		assert.equal(refused.ok, false);
		assert.match(refused.spoken, /Create Events/);

		const noChannel = makeDeps({ owner: true, channelPermissions: ['ViewChannel'] });
		const blocked = await callTool('create_event', { name: 'Game night', start_time: 'in 2 hours', channel: 'General' }, noChannel.deps);
		assert.equal(blocked.ok, false);
		assert.match(blocked.spoken, /Connect/);
		assert.deepEqual(noChannel.calls, []);
	});
});

describe('edit_event', () => {
	it('renames an event and moves its start time', async () => {
		const { deps, store, log } = makeDeps({ owner: true });
		const result = await callTool('edit_event', { event: 'movie night', name: 'Film night', start_time: 'tomorrow at 20:00' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(store.get('e1').name, 'Film night');
		assert.equal(new Date(store.get('e1').scheduledStartTimestamp).getHours(), 20);
		assert.ok(log.some((line) => line.includes('scheduled event edited')), 'the change is logged');
	});

	it('refuses an event it cannot find, a location on a channel event, and a change with nothing in it', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const missing = await callTool('edit_event', { event: 'karaoke', name: 'Whatever' }, deps);
		assert.equal(missing.ok, false);
		assert.match(missing.spoken, /could not find an event/i);

		const wrongKind = await callTool('edit_event', { event: 'Movie night', location: 'Kugulu Park' }, deps);
		assert.equal(wrongKind.ok, false);
		assert.match(wrongKind.spoken, /held in a channel/i);

		const empty = await callTool('edit_event', { event: 'Movie night' }, deps);
		assert.equal(empty.ok, false);
		assert.match(empty.spoken, /what to change/i);
		assert.deepEqual(calls, []);
	});

	it('needs "Manage Events" for an event somebody else created', async () => {
		const { deps, store, calls } = makeDeps({ owner: true, guildPermissions: ['CreateEvents'] });
		store.get('e1').creatorId = 'someone-else';
		const result = await callTool('edit_event', { event: 'Movie night', name: 'Film night' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Events/);
		assert.deepEqual(calls, []);
	});
});

describe('cancel_event', () => {
	it('asks first and only cancels on the second call', async () => {
		const { deps, store, calls } = makeDeps({ owner: true });
		const owner = ownerVoice(deps);
		const asked = await callTool('cancel_event', { event: 'Movie night' }, deps);
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		assert.deepEqual(calls, [], 'nothing is cancelled before the answer');
		assert.equal(store.get('e1').status, GuildScheduledEventStatus.Scheduled);

		owner.says('yes, cancel it');
		const done = await callTool('cancel_event', { event: 'Movie night', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.equal(store.get('e1').status, GuildScheduledEventStatus.Canceled);
	});

	it('ends an event that has already started, because Discord cannot cancel one', async () => {
		const { deps, store } = makeDeps({ owner: true });
		store.get('e1').status = GuildScheduledEventStatus.Active;
		const owner = ownerVoice(deps);
		await callTool('cancel_event', { event: 'Movie night' }, deps);
		owner.says('go ahead');
		const done = await callTool('cancel_event', { event: 'Movie night', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.match(done.spoken, /already started/i);
		assert.equal(store.get('e1').status, GuildScheduledEventStatus.Completed);
	});

	it('refuses an event that is already cancelled', async () => {
		const { deps, calls } = makeDeps({ owner: true });
		const result = await callTool('cancel_event', { event: 'Old quiz', confirm: true }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /already cancelled/i);
		assert.deepEqual(calls, []);
	});
});

describe('event_interest', () => {
	it('says how many are interested and names a few of them', async () => {
		const { deps, calls } = makeDeps();
		const result = await callTool('event_interest', { event: 'Movie night' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.data.interested, 3);
		assert.deepEqual(result.data.names, ['Jane Doe', 'sam']);
		assert.match(result.spoken, /Jane Doe/);
		assert.equal(calls.find((call) => call.subscribers)?.options.limit, 5);
	});

	it('still gives the count when the list of people cannot be read', async () => {
		const { deps, store, log } = makeDeps();
		deps.guild.scheduledEvents.fetchSubscribers = async () => {
			throw new Error('Missing Permissions');
		};
		store.get('e1').userCount = 0;
		const result = await callTool('event_interest', { event: 'Movie night' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.match(result.spoken, /Nobody/i);
		assert.ok(log.some((line) => line.includes('interested-list unavailable')));
	});

	it('refuses when the event does not exist', async () => {
		const { deps } = makeDeps();
		const result = await callTool('event_interest', { event: 'karaoke' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /could not find an event/i);
	});
});
