import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HumanPace, handleMessage } from '../../src/messages.js';

/** A clock that only moves when told to, firing the timers it passes in order. */
function fakeClock() {
	let now = 0;
	const timers = [];
	const add = (at, fn, every = 0) => {
		const timer = { at, fn, every, dead: false };
		timers.push(timer);
		return () => {
			timer.dead = true;
		};
	};
	const clock = {
		now: () => now,
		advance(ms) {
			const end = now + ms;
			for (;;) {
				const next = timers.filter((timer) => !timer.dead && timer.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				now = next.at;
				if (next.every) next.at += next.every;
				else next.dead = true;
				next.fn();
			}
			now = end;
		},
		sleep: async (ms) => clock.advance(ms),
		after: (ms, fn) => add(now + ms, fn),
		every: (ms, fn) => add(now + ms, fn, ms),
	};
	return clock;
}

const channelOn = (clock) => {
	const typed = [];
	return { typed, sendTyping: () => (typed.push(clock.now()), Promise.resolve()) };
};
const steady = () => 0.5; // no jitter

describe('a written reply at a person s pace', () => {
	it('reads first, shows typing, and answers when the reply could have been typed', async () => {
		const clock = fakeClock();
		const channel = channelOn(clock);
		const pace = new HumanPace(channel, { incoming: 'Melis naber', cps: 10, clock, random: steady });
		await pace.done('İyiyim, sen nasılsın?'); // the model was instant; 21 characters at 10 a second
		pace.stop();
		assert.deepEqual(channel.typed, [500], 'typing shows after half a second of reading');
		assert.equal(clock.now(), 500 + 2100);
	});

	it('adds nothing when the model was slow: that was the typing', async () => {
		const clock = fakeClock();
		const channel = channelOn(clock);
		const pace = new HumanPace(channel, { incoming: 'Melis naber', cps: 10, clock, random: steady });
		clock.advance(12_000); // the model takes twelve seconds
		await pace.done('İyiyim, sen nasılsın?');
		pace.stop();
		assert.equal(clock.now(), 12_000, 'the reply goes out at once');
		assert.deepEqual(channel.typed, [500, 8500], 'and the indicator was renewed while it wrote');
	});

	it('is never held back longer than the cap, nor shorter than a moment', async () => {
		const clock = fakeClock();
		const pace = new HumanPace(channelOn(clock), { incoming: 'x', cps: 10, maxMs: 8000, clock, random: steady });
		assert.equal(pace.typingMs('a'.repeat(500)), 8000);
		assert.equal(pace.typingMs('ok'), 1500);
		await pace.done('a'.repeat(500));
		assert.equal(clock.now(), 500 + 8000);
		pace.stop();
	});

	it('reads a long message for longer', () => {
		const clock = fakeClock();
		const short = new HumanPace(channelOn(clock), { incoming: 'selam', clock, random: steady });
		const long = new HumanPace(channelOn(clock), { incoming: 'x'.repeat(100), clock, random: steady });
		const huge = new HumanPace(channelOn(clock), { incoming: 'x'.repeat(1000), clock, random: steady });
		assert.deepEqual([short.readMs, long.readMs, huge.readMs], [500, 2250, 2500]);
		for (const pace of [short, long, huge]) pace.stop();
	});

	it('does nothing when it is off, or the channel cannot show typing', async () => {
		const clock = fakeClock();
		const channel = channelOn(clock);
		const off = new HumanPace(channel, { enabled: false, clock, random: steady });
		await off.done('bir cevap');
		const mute = new HumanPace({}, { clock, random: steady });
		await mute.done('bir cevap');
		clock.advance(20_000);
		assert.equal(clock.now(), 20_000);
		assert.deepEqual(channel.typed, []);
	});

	it('stops typing when stopped, whatever was still to come', () => {
		const clock = fakeClock();
		const channel = channelOn(clock);
		const pace = new HumanPace(channel, { incoming: 'Melis naber', clock, random: steady });
		clock.advance(600);
		pace.stop();
		clock.advance(30_000);
		assert.deepEqual(channel.typed, [500], 'no renewal after the stop');
	});

	it('survives a channel that refuses to show typing', async () => {
		const clock = fakeClock();
		const pace = new HumanPace(
			{
				sendTyping: () => {
					throw new Error('Missing Permissions');
				},
			},
			{ incoming: 'Melis naber', clock, random: steady },
		);
		await pace.done('tamam');
		pace.stop();
		assert.equal(clock.now(), 500 + 1500);
	});
});

describe('answering a message at that pace', () => {
	const setup = ({ fail = false } = {}) => {
		const clock = fakeClock();
		const channel = { id: 'c1', name: 'genel', ...channelOn(clock) };
		const sent = [];
		const deps = {
			client: { user: { id: 'me' } },
			cfg: { guildId: 'g1', respondToDms: true, respondToMentions: true, humanTyping: true, typingCps: 10, typingMaxMs: 8000 },
			provider: {
				complete: async () => {
					clock.advance(1000); // the model takes a second
					if (fail) throw new Error('down');
					return 'Bugün iyiyim, sen?';
				},
			},
			persona: () => ({ name: 'Melis', prompt: 'Sen Melis.' }),
			log: () => {},
			clock,
			random: steady,
		};
		const message = {
			author: { id: 'u1', bot: false, username: 'Ali' },
			guild: { id: 'g1' },
			channel,
			content: 'Melis naber',
			embeds: [],
			mentions: { users: new Map([['me', {}]]) },
			reply: async (payload) => {
				sent.push({ at: clock.now(), content: payload.content });
				return { id: 'r' };
			},
		};
		return { clock, channel, deps, message, sent };
	};

	it('shows typing while the model writes and sends when a person could have typed the reply', async () => {
		const { clock, channel, deps, message, sent } = setup();
		assert.equal(await handleMessage(message, deps), 'Bugün iyiyim, sen?');
		// read 500 ms, typing from then; 18 characters at 10 a second is 1.8 s of typing
		assert.deepEqual(sent, [{ at: 500 + 1800, content: 'Bugün iyiyim, sen?' }]);
		assert.deepEqual(channel.typed, [500]);
		clock.advance(60_000);
		assert.deepEqual(channel.typed, [500], 'and the indicator is not renewed after the reply');
	});

	it('stops typing when the reply fails, and apologises at once', async () => {
		const { clock, channel, deps, message, sent } = setup({ fail: true });
		assert.equal(await handleMessage(message, deps), null);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].at, 1000, 'the apology does not wait for a typing time');
		clock.advance(60_000);
		assert.deepEqual(channel.typed, [500]);
	});
});
