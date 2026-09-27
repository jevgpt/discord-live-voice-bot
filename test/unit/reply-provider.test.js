import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReplyProvider, createTextProvider, stripThinking } from '../../src/provider.js';

describe('a thinking model s answer', () => {
	it('loses its reasoning before it is posted', () => {
		assert.equal(stripThinking('<think>kullanıcı selam dedi, kısa tut</think>\nSelam canım'), 'Selam canım');
		assert.equal(stripThinking('<thinking>a</thinking>bir<think>b</think> iki'), 'bir iki');
		assert.equal(stripThinking('uzun uzun düşündüm... </think> Naber'), 'Naber', 'a closing tag alone: all before it was thinking');
		assert.equal(stripThinking('Cevap bu <think>yarım kalan düşünce'), 'Cevap bu', 'an unclosed tag: nothing after it is the answer');
		assert.equal(stripThinking('düz cevap'), 'düz cevap');
		assert.equal(stripThinking(null), '');
	});
});

describe('the provider for written replies', () => {
	const chatClient = (content, calls) => ({
		chat: {
			completions: {
				create: async (body, options) => {
					calls.push({ body, options });
					return { choices: [{ message: { content } }] };
				},
			},
		},
	});
	const openai = { responses: { create: async (body, options) => ({ output_text: `openai:${body.model}:${options.timeout}` }) } };
	const fallback = createTextProvider({ openai, textModel: 'gpt-x' });

	it('is the text provider when no reply model is set', () => {
		assert.equal(createReplyProvider({ cfg: {}, openai, fallback, makeClient: () => null }), fallback);
	});

	it('goes to the endpoint and model it is given, waits for a thinking model, and posts no thinking', async () => {
		const made = [];
		const calls = [];
		const provider = createReplyProvider({
			cfg: { textModel: 'gpt-x', replyModel: 'deepseek/deepseek-v4-pro:thinking', replyBaseUrl: 'https://nano-gpt.com/api/v1', replyApiKey: 'sk-nano-x', replyTimeoutMs: 120_000, deepseekApiKey: 'sk-ds', deepseekBaseUrl: 'https://api.deepseek.com' },
			openai,
			fallback,
			makeClient: (options) => (made.push(options), chatClient('<think>plan</think>Selam!', calls)),
		});
		assert.deepEqual(made, [{ apiKey: 'sk-nano-x', baseURL: 'https://nano-gpt.com/api/v1' }], 'its own key, not the DeepSeek one');
		assert.equal(await provider.complete({ instructions: 'i', input: 'x' }), 'Selam!');
		assert.equal(calls[0].body.model, 'deepseek/deepseek-v4-pro:thinking');
		assert.equal(calls[0].options.timeout, 120_000);
		assert.equal(await provider.completeWithImages({ instructions: 'i', input: [] }), 'openai:gpt-x:120000', 'images still go to OpenAI');
	});

	it('is not used with a URL and no key: replies carry on with the text provider, and the log says why', () => {
		const logs = [];
		const provider = createReplyProvider({
			cfg: { replyModel: 'deepseek/deepseek-v4-pro:thinking', replyBaseUrl: 'https://nano-gpt.com/api/v1' },
			openai,
			fallback,
			makeClient: () => {
				throw new Error('no client should be made');
			},
			log: (line) => logs.push(line),
		});
		assert.equal(provider, fallback);
		assert.equal(logs.length, 1);
		assert.match(logs[0], /REPLY_API_KEY/);
	});

	it('uses the DeepSeek connection when it has no URL of its own, and OpenAI when there is none', async () => {
		const made = [];
		createReplyProvider({
			cfg: { replyModel: 'deepseek-reasoner', deepseekApiKey: 'sk-ds', deepseekBaseUrl: 'https://api.deepseek.com' },
			openai,
			fallback,
			makeClient: (options) => (made.push(options), chatClient('ok', [])),
		});
		assert.deepEqual(made, [{ apiKey: 'sk-ds', baseURL: 'https://api.deepseek.com' }]);
		const onOpenai = createReplyProvider({ cfg: { replyModel: 'gpt-y', replyTimeoutMs: 60_000 }, openai, fallback, makeClient: () => null });
		assert.equal(await onOpenai.complete({ instructions: 'i', input: 'x' }), 'openai:gpt-y:60000');
	});

	it('keeps the old thirty seconds for everything else', async () => {
		const calls = [];
		const provider = createTextProvider({ openai, textModel: 'gpt-x', deepseek: { client: chatClient('ok', calls), model: 'deepseek-chat' } });
		await provider.complete({ instructions: 'i', input: 'x' });
		assert.equal(calls[0].options.timeout, 30_000);
	});
});
