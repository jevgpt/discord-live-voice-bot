import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BotChain, handleMessage, messageText, shouldReply } from '../../src/messages.js';

const target = { botId: 'me', guildId: 'g1' };
const mention = (author, extra = {}) => ({ author, guild: { id: 'g1' }, mentions: { users: new Map([['me', {}]]) }, ...extra });

describe('which bot messages are answered', () => {
	const bot = { id: 'other-bot', bot: true };

	it('none unless answering bots is on', () => {
		assert.equal(shouldReply(mention(bot), target), false);
		assert.equal(shouldReply(mention(bot), { ...target, respondToBots: true }), true);
	});

	it('a bot that replies to one of ours, like a person would', () => {
		const reply = { author: bot, guild: { id: 'g1' }, mentions: { users: new Map(), repliedUser: { id: 'me' } } };
		assert.equal(shouldReply(reply, { ...target, respondToBots: true }), true);
	});

	it('never a bot message that is not addressed to it', () => {
		const chatter = { author: bot, guild: { id: 'g1' }, mentions: { users: new Map() } };
		assert.equal(shouldReply(chatter, { ...target, respondToBots: true }), false);
	});

	it('never its own message, nor a system message', () => {
		assert.equal(shouldReply(mention({ id: 'me', bot: true }), { ...target, respondToBots: true }), false);
		assert.equal(shouldReply(mention({ id: 'u1', bot: false }, { system: true }), target), false);
	});
});

describe('the text of a bot message', () => {
	it('includes its embeds, where most bots put their answer', () => {
		const message = {
			author: { id: 'b', bot: true },
			content: '',
			embeds: [{ title: 'Hava', description: 'Bugün   yağmurlu', fields: [{ name: 'Sıcaklık', value: '14°C' }], footer: { text: 'kaynak' } }],
		};
		assert.equal(messageText(message), 'Hava Bugün yağmurlu Sıcaklık: 14°C kaynak');
	});

	it('is only what a person wrote, for a person: a link preview is not their words', () => {
		const message = { author: { id: 'u', bot: false }, content: ' bak  buna ', embeds: [{ title: 'Some site' }] };
		assert.equal(messageText(message), 'bak buna');
	});
});

describe('the chain of replies to bots', () => {
	it('stops after the cap, and a person writing in the channel opens it again', () => {
		const chain = new BotChain({ max: 3 });
		assert.deepEqual([chain.allow('c'), chain.allow('c'), chain.allow('c'), chain.allow('c')], [true, true, true, false]);
		assert.equal(chain.allow('other'), true, 'another channel has its own count');
		chain.noteHuman('c');
		assert.equal(chain.allow('c'), true);
	});

	it('opens again after the chain has been quiet, and a bot that keeps going keeps it shut', () => {
		let now = 0;
		const chain = new BotChain({ max: 1, idleMs: 1000, now: () => now });
		assert.equal(chain.allow('c'), true);
		now = 900;
		assert.equal(chain.allow('c'), false);
		now = 1800;
		assert.equal(chain.allow('c'), false, 'the last attempt was 900 ms ago: still the same chain');
		now = 2900;
		assert.equal(chain.allow('c'), true, 'a second of nothing: a new chain');
	});
});

describe('answering a bot', () => {
	const setup = ({ replyText = 'selam bot', fail = false } = {}) => {
		const inputs = [];
		const sent = [];
		const logs = [];
		const deps = {
			client: { user: { id: 'me' } },
			cfg: { guildId: 'g1', respondToDms: true, respondToMentions: true, respondToBots: true },
			provider: {
				complete: async ({ input }) => {
					inputs.push(input);
					if (fail) throw new Error('down');
					return replyText;
				},
			},
			persona: () => ({ name: 'Melis', prompt: 'Sen Melis.' }),
			log: (line) => logs.push(line),
			botChain: new BotChain({ max: 2 }),
		};
		const message = (author, content = 'Melis naber') => ({
			author,
			guild: { id: 'g1' },
			channel: { id: 'c1', name: 'genel' },
			content,
			embeds: [],
			mentions: { users: new Map([['me', {}]]) },
			reply: async (payload) => {
				sent.push(payload.content);
				return { id: 'r' };
			},
		});
		return { deps, message, inputs, sent, logs };
	};
	const bot = { id: 'b1', bot: true, username: 'Hava' };
	const person = { id: 'u1', bot: false, username: 'Ali' };

	it('replies, and tells the model it is a bot it is answering', async () => {
		const { deps, message, inputs, sent } = setup();
		assert.equal(await handleMessage(message(bot), deps), 'selam bot');
		assert.deepEqual(sent, ['selam bot']);
		assert.match(inputs[0], /Hava \(bot\)/);
	});

	it('stops at the chain cap until a person writes in the channel', async () => {
		const { deps, message, sent, logs } = setup();
		await handleMessage(message(bot), deps);
		await handleMessage(message(bot), deps);
		assert.equal(await handleMessage(message(bot), deps), null, 'the third in a row is not answered');
		assert.equal(sent.length, 2);
		assert.ok(logs.some((line) => /b1/.test(line)), logs.join('\n'));
		await handleMessage(message(person, 'naber millet'), deps); // a person writes in the channel
		assert.equal(await handleMessage(message(bot), deps), 'selam bot', 'answered again');
	});

	it('does not send a bot the "try again later" apology when the reply fails', async () => {
		const { deps, message, sent } = setup({ fail: true });
		assert.equal(await handleMessage(message(bot), deps), null);
		assert.deepEqual(sent, []);
		await handleMessage(message(person), deps);
		assert.equal(sent.length, 1, 'a person still gets it');
	});

	it('does nothing for bots when it is off', async () => {
		const { deps, message, sent } = setup();
		deps.cfg.respondToBots = false;
		assert.equal(await handleMessage(message(bot), deps), null);
		assert.deepEqual(sent, []);
	});
});
