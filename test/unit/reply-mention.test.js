import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleMessage } from '../../src/messages.js';

const setup = ({ replyMention, fail = false } = {}) => {
	const sent = [];
	const cfg = { guildId: 'g1', respondToDms: true, respondToMentions: true };
	if (replyMention !== undefined) cfg.replyMention = replyMention;
	const deps = {
		client: { user: { id: 'me' } },
		cfg,
		provider: {
			complete: async () => {
				if (fail) throw new Error('down');
				return 'selam @everyone';
			},
		},
		persona: () => ({ name: 'Melis', prompt: 'Sen Melis.' }),
		log: () => {},
	};
	const message = {
		author: { id: 'u1', bot: false, username: 'Ali' },
		guild: { id: 'g1' },
		channel: { id: 'c1', name: 'genel' },
		content: 'Melis naber',
		embeds: [],
		mentions: { users: new Map([['me', {}]]) },
		reply: async (payload) => {
			sent.push(payload);
			return { id: 'r' };
		},
	};
	return { deps, message, sent };
};

describe('a written reply and the person it answers', () => {
	it('pings them, and nothing typed in the text pings anybody', async () => {
		const { deps, message, sent } = setup();
		await handleMessage(message, deps);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].allowedMentions.repliedUser, true);
		assert.deepEqual(sent[0].allowedMentions.parse, [], 'the "@everyone" in the reply stays inert');
	});

	it('pings them with the apology too', async () => {
		const { deps, message, sent } = setup({ fail: true });
		await handleMessage(message, deps);
		assert.equal(sent[0].allowedMentions.repliedUser, true);
	});

	it('does not ping them when REPLY_MENTION is off', async () => {
		const { deps, message, sent } = setup({ replyMention: false });
		await handleMessage(message, deps);
		assert.equal(sent[0].allowedMentions.repliedUser, false);
	});
});
