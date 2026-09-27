import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { characterModal, handleInteraction, joinPrompt, splitPrompt } from '../../src/commands.js';
import { CharacterStore } from '../../src/store.js';

const paragraphs = (count, size = 900) => Array.from({ length: count }, (_, i) => `${i}`.padEnd(size, ' kelime').trim()).join('\n');

describe('the character modal', () => {
	it('has three prompt fields of 4000 between the name and the voice, labels Discord accepts', () => {
		const rows = characterModal({ mode: 'new' }).toJSON().components;
		assert.deepEqual(
			rows.map((row) => row.components[0].custom_id),
			['name', 'prompt', 'prompt2', 'prompt3', 'voice'],
		);
		for (const row of rows.slice(1, 4)) assert.equal(row.components[0].max_length, 4000);
		for (const row of rows) assert.ok(row.components[0].label.length <= 45, row.components[0].label);
		for (const row of rows.slice(2, 4)) assert.ok(row.components[0].placeholder.length <= 100);
	});

	it('shows a long prompt across the fields for editing', () => {
		const prompt = paragraphs(11); // about 10,000 characters
		const rows = characterModal({ mode: 'edit', character: { name: 'Melis', prompt } }).toJSON().components;
		const values = rows.slice(1, 4).map((row) => row.components[0].value ?? '');
		assert.ok(values.every((value) => value.length <= 4000));
		assert.equal(joinPrompt(values), prompt, 'cut at line breaks, so nothing is lost or changed');
	});
});

describe('splitting and joining a prompt', () => {
	it('cuts at a line break, else a space, else where the field is full', () => {
		assert.deepEqual(splitPrompt('abc\ndef', { size: 5 }), ['abc', 'def']);
		assert.deepEqual(splitPrompt('ab cd ef', { size: 6 }), ['ab cd', 'ef']);
		assert.deepEqual(splitPrompt('abcdefgh', { size: 3, fields: 5 }), ['abc', 'def', 'gh']);
		assert.deepEqual(splitPrompt('', {}), []);
	});

	it('leaves out what does not fit, and joins the filled fields in order', () => {
		assert.deepEqual(splitPrompt('aa bb cc dd', { size: 2, fields: 2 }), ['aa', 'bb']);
		assert.equal(joinPrompt(['birinci', '', ' ikinci ']), 'birinci\n ikinci');
		assert.equal(joinPrompt(['', '', '']), '');
	});
});

describe('saving the character modal', () => {
	const setup = async () => {
		const store = new CharacterStore(path.join(await mkdtemp(path.join(tmpdir(), 'chars-')), 'characters.json'));
		await store.load();
		const ctx = { config: { ownerId: 'owner' }, store, refreshPersona: async () => {}, log: () => {} };
		const submit = async (customId, values) => {
			const replies = [];
			const interaction = {
				isAutocomplete: () => false,
				isChatInputCommand: () => false,
				isStringSelectMenu: () => false,
				isButton: () => false,
				isModalSubmit: () => true,
				customId,
				user: { id: 'owner' },
				fields: {
					getTextInputValue: (id) => {
						if (!(id in values)) throw new Error(`no field ${id}`);
						return values[id];
					},
				},
				update: async (view) => replies.push(view),
				reply: async (view) => replies.push(view),
			};
			await handleInteraction(interaction, ctx);
			return replies;
		};
		return { store, submit };
	};

	it('keeps a prompt longer than the old 8000 in full, from three fields', async () => {
		const { store, submit } = await setup();
		const parts = ['a'.repeat(3900), 'b'.repeat(3900), 'c'.repeat(3900)];
		await submit('char:new:modal', { name: 'Melis', prompt: parts[0], prompt2: parts[1], prompt3: parts[2], voice: '' });
		assert.equal(store.getActive().prompt, parts.join('\n'));
		assert.equal(store.getActive().prompt.length, 11_702);
	});

	it('keeps a prompt longer than the modal when the fields come back untouched', async () => {
		const { store, submit } = await setup();
		const prompt = paragraphs(25); // about 22,500 characters: more than the modal shows
		await store.create({ name: 'Melis', prompt });
		const rows = characterModal({ mode: 'edit', character: store.getActive() }).toJSON().components;
		const shown = Object.fromEntries(rows.map((row) => [row.components[0].custom_id, row.components[0].value ?? '']));
		await submit('char:edit:modal', { ...shown, name: 'Melis 2' });
		assert.equal(store.getActive().name, 'Melis 2');
		assert.equal(store.getActive().prompt, prompt, 'all of it, not what the modal showed');
	});

	it('takes the fields as the new prompt once they are changed', async () => {
		const { store, submit } = await setup();
		await store.create({ name: 'Melis', prompt: paragraphs(25) });
		await submit('char:edit:modal', { name: 'Melis', prompt: 'yeni prompt', prompt2: 'devamı', prompt3: '', voice: '' });
		assert.equal(store.getActive().prompt, 'yeni prompt\ndevamı');
	});

	it('reads a modal from before the update, with one prompt field, as before', async () => {
		const { store, submit } = await setup();
		await submit('char:new:modal', { name: 'Eski', prompt: 'tek alan', voice: '' });
		assert.equal(store.getActive().prompt, 'tek alan');
	});
});
