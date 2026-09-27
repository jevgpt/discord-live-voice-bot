import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { callTool } from '../../src/tools.js';
import { tools as expressionTools } from '../../src/tools/expressions.js';
import { ownerVoice } from '../owner-voice.js';

const PNG_URL = 'https://cdn.discordapp.com/attachments/1/2/blob.png';
const SELF_ID = 'me';

/** A tiny stand-in for the bytes the CDN would hand back. */
const bytes = (size = 64) => Buffer.alloc(size, 7);

/**
 * Replaces the global fetch that src/messages.js uses to download a picture.
 * @returns {() => void} restores the real one
 */
function stubDownload({ body = bytes(), contentType = 'image/png', ok = true, throws = null } = {}) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (throws) throw throws;
		return {
			ok,
			status: ok ? 200 : 500,
			headers: { get: () => contentType },
			arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
		};
	};
	const restore = () => {
		globalThis.fetch = original;
	};
	restore.calls = calls;
	return restore;
}

function makeDeps({ owner = true, permissions = ['CreateGuildExpressions', 'ManageGuildExpressions'], emojis = [], stickers = [] } = {}) {
	const sent = [];
	const held = new Set(permissions.map((name) => PermissionFlagsBits[name]));
	const emojiCache = new Map(emojis.map((emoji) => [emoji.id, emoji]));
	const stickerCache = new Map(stickers.map((sticker) => [sticker.id, sticker]));
	const guild = {
		// A fresh id per guild is not enough on its own: the confirmation store is module level, so the
		// tests inject their own map (see deps.pendingConfirmations below).
		id: `g${Math.random().toString(36).slice(2)}`,
		channels: { cache: new Map() },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		members: {
			cache: new Map(),
			me: { id: SELF_ID, permissions: { has: (flag) => held.has(flag) } },
			fetch: async () => new Map(),
		},
		emojis: {
			cache: emojiCache,
			create: async (options) => {
				sent.push({ createdEmoji: options });
				const emoji = { id: 'new-emoji', name: options.name, animated: false };
				emojiCache.set(emoji.id, emoji);
				return emoji;
			},
			edit: async (emoji, options) => {
				sent.push({ editedEmoji: emoji.id, options });
				return { ...emoji, name: options.name };
			},
			delete: async (emoji, reason) => {
				sent.push({ deletedEmoji: emoji.id, reason });
				emojiCache.delete(emoji.id);
			},
		},
		stickers: {
			cache: stickerCache,
			fetch: async () => stickerCache,
			create: async (options) => {
				sent.push({ createdSticker: options });
				const sticker = { id: 'new-sticker', name: options.name, tags: options.tags, description: options.description };
				stickerCache.set(sticker.id, sticker);
				return sticker;
			},
			edit: async (sticker, options) => {
				sent.push({ editedSticker: sticker.id, options });
				return { ...sticker, ...options };
			},
			delete: async (sticker, reason) => {
				sent.push({ deletedSticker: sticker.id, reason });
				stickerCache.delete(sticker.id);
			},
		},
	};
	const deps = {
		guild,
		cfg: { textChannelId: null },
		log: () => {},
		activity: () => {},
		// Own confirmation store: the shared one lives for the life of the process and is keyed by guild.
		pendingConfirmations: new Map(),
	};
	if (owner) {
		deps.isOwnerActive = () => true;
		deps.ownerSaidRecently = () => true;
		deps.ownerMatch = (words) => words[0];
	}
	return { deps, sent, guild };
}

const emoji = (over = {}) => ({ id: 'e1', name: 'party_blob', animated: false, managed: false, ...over });
const sticker = (over = {}) => ({ id: 's1', name: 'shrug', tags: 'shrug', description: null, ...over });

describe('list_expressions', () => {
	it('reads out the emojis and the stickers, and fills the sticker cache once', async () => {
		const { deps } = makeDeps({ owner: false, emojis: [emoji(), emoji({ id: 'e2', name: 'sadcat', animated: true })] });
		deps.guild.stickers.cache.clear();
		deps.guild.stickers.fetch = async () => {
			deps.guild.stickers.cache.set('s1', sticker());
			return deps.guild.stickers.cache;
		};
		const result = await callTool('list_expressions', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.match(result.spoken, /party_blob/);
		assert.match(result.spoken, /shrug/);
		assert.deepEqual(result.data.counts, { emojis: 2, animated: 1, stickers: 1 });
		assert.equal(deps.guild.stickers.cache.size, 1, 'the empty sticker cache was filled by the fetch');
	});

	it('needs no owner, and says so plainly when the server has neither', async () => {
		const { deps } = makeDeps({ owner: false });
		const result = await callTool('list_expressions', {}, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.equal(result.denied, undefined);
		assert.match(result.spoken, /no custom emojis/i);
		assert.match(result.spoken, /no stickers/i);
	});

	it('reports a failure instead of pretending the server has no stickers', async () => {
		const { deps } = makeDeps({ owner: false });
		deps.guild.stickers.fetch = async () => {
			throw new Error('network down');
		};
		const result = await callTool('list_expressions', { kind: 'sticker' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /could not read/i);
	});
});

describe('create_emoji', () => {
	it('downloads the picture from the Discord CDN and uploads the bytes as a data URL', async () => {
		const { deps, sent } = makeDeps();
		const restore = stubDownload();
		try {
			const result = await callTool('create_emoji', { name: 'party blob', image_url: PNG_URL }, deps);
			assert.equal(result.ok, true, result.spoken);
			assert.equal(restore.calls[0], PNG_URL);
			const created = sent.find((entry) => entry.createdEmoji)?.createdEmoji;
			assert.equal(created.name, 'party_blob', 'the spoken name is cleaned into what Discord accepts');
			assert.match(created.attachment, /^data:image\/png;base64,/);
			assert.match(result.spoken, /party_blob/);
		} finally {
			restore();
		}
	});

	it('refuses an address that is not on Discord, and never fetches it', async () => {
		const { deps, sent } = makeDeps();
		const restore = stubDownload();
		try {
			const result = await callTool('create_emoji', { name: 'evil', image_url: 'https://example.com/pic.png' }, deps);
			assert.equal(result.ok, false);
			assert.match(result.spoken, /only download pictures from Discord/i);
			assert.equal(restore.calls.length, 0, 'a foreign host must not be fetched at all');
			assert.equal(sent.length, 0);
		} finally {
			restore();
		}
	});

	it('names the size limit when the picture is over 256 KB', async () => {
		const { deps } = makeDeps();
		const restore = stubDownload({ body: bytes(300 * 1024) });
		try {
			const result = await callTool('create_emoji', { name: 'huge', image_url: PNG_URL }, deps);
			assert.equal(result.ok, false);
			assert.match(result.spoken, /300 KB/);
			assert.match(result.spoken, /256 KB/);
		} finally {
			restore();
		}
	});

	it('says which permission it is missing instead of calling the API', async () => {
		const { deps, sent } = makeDeps({ permissions: [] });
		const result = await callTool('create_emoji', { name: 'blob', image_url: PNG_URL }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Create Expressions/);
		assert.equal(sent.length, 0);
	});

	it('names the limit Discord hit when the emoji slots are full', async () => {
		const { deps } = makeDeps();
		deps.guild.emojis.create = async () => {
			throw Object.assign(new Error('Maximum number of emojis reached'), { code: 30008 });
		};
		const restore = stubDownload();
		try {
			const result = await callTool('create_emoji', { name: 'blob', image_url: PNG_URL }, deps);
			assert.equal(result.ok, false);
			assert.match(result.spoken, /no free emoji slots/i);
		} finally {
			restore();
		}
	});
});

describe('rename_emoji', () => {
	it('renames an emoji found by its spoken name', async () => {
		const { deps, sent } = makeDeps({ emojis: [emoji()] });
		const result = await callTool('rename_emoji', { emoji: 'party blob', name: 'partymax' }, deps);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(sent.find((entry) => entry.editedEmoji)?.options?.name, 'partymax');
		assert.equal(result.data.previous, 'party_blob');
	});

	it('refuses when there is no such emoji', async () => {
		const { deps, sent } = makeDeps({ emojis: [emoji()] });
		const result = await callTool('rename_emoji', { emoji: 'nothing like it', name: 'x_y' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /could not find an emoji/i);
		assert.equal(sent.length, 0);
	});

	it('refuses an emoji that belongs to an integration', async () => {
		const { deps } = makeDeps({ emojis: [emoji({ managed: true })] });
		const result = await callTool('rename_emoji', { emoji: 'party_blob', name: 'mine_now' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /integration/i);
	});
});

describe('delete_emoji', () => {
	it('asks first and deletes on the confirmed second call', async () => {
		const { deps, sent } = makeDeps({ emojis: [emoji()] });
		const owner = ownerVoice(deps);
		const asked = await callTool('delete_emoji', { emoji: 'party_blob' }, deps);
		assert.equal(asked.ok, false);
		assert.equal(asked.needs_confirmation, true);
		assert.equal(sent.length, 0, 'nothing is deleted on the first call');
		owner.says('yes');
		const done = await callTool('delete_emoji', { emoji: 'party_blob', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.equal(sent.find((entry) => entry.deletedEmoji)?.deletedEmoji, 'e1');
	});

	it('refuses without the Manage Expressions permission on somebody else\'s emoji', async () => {
		const { deps, sent } = makeDeps({ permissions: ['CreateGuildExpressions'], emojis: [emoji({ author: { id: 'someone' } })] });
		const result = await callTool('delete_emoji', { emoji: 'party_blob', confirm: true }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Expressions/);
		assert.equal(sent.length, 0);
	});

	it('lets the bot delete an emoji it uploaded itself with only Create Expressions', async () => {
		const { deps, sent } = makeDeps({ permissions: ['CreateGuildExpressions'], emojis: [emoji({ author: { id: SELF_ID } })] });
		const owner = ownerVoice(deps);
		await callTool('delete_emoji', { emoji: 'party_blob' }, deps);
		owner.says('yes');
		const done = await callTool('delete_emoji', { emoji: 'party_blob', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.equal(sent.find((entry) => entry.deletedEmoji)?.deletedEmoji, 'e1');
	});
});

describe('create_sticker', () => {
	it('uploads the downloaded bytes with a file name Discord can type-sniff', async () => {
		const { deps, sent } = makeDeps();
		const restore = stubDownload({ contentType: 'image/gif' });
		try {
			const result = await callTool('create_sticker', { name: 'shrug', image_url: PNG_URL, tags: 'shrug' }, deps);
			assert.equal(result.ok, true, result.spoken);
			const created = sent.find((entry) => entry.createdSticker)?.createdSticker;
			assert.equal(created.file.name, 'sticker.gif');
			assert.ok(Buffer.isBuffer(created.file.attachment), 'the bytes travel, not the address');
			assert.equal(created.tags, 'shrug');
		} finally {
			restore();
		}
	});

	it('refuses a picture format Discord does not take as a sticker', async () => {
		const { deps, sent } = makeDeps();
		const restore = stubDownload({ contentType: 'image/jpeg' });
		try {
			const result = await callTool('create_sticker', { name: 'shrug', image_url: PNG_URL }, deps);
			assert.equal(result.ok, false);
			assert.match(result.spoken, /PNG or a GIF/i);
			assert.equal(sent.length, 0);
		} finally {
			restore();
		}
	});

	it('names the 320 by 320 rule when Discord rejects the form body', async () => {
		const { deps } = makeDeps();
		deps.guild.stickers.create = async () => {
			throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
		};
		const restore = stubDownload();
		try {
			const result = await callTool('create_sticker', { name: 'shrug', image_url: PNG_URL }, deps);
			assert.equal(result.ok, false);
			assert.match(result.spoken, /320 by 320/);
		} finally {
			restore();
		}
	});
});

describe('rename_sticker', () => {
	it('renames a sticker and can change its description in the same call', async () => {
		const { deps, sent } = makeDeps({ stickers: [sticker()] });
		const result = await callTool('rename_sticker', { sticker: 'shrug', name: 'big shrug', description: 'a shrug' }, deps);
		assert.equal(result.ok, true, result.spoken);
		const options = sent.find((entry) => entry.editedSticker)?.options;
		assert.equal(options.name, 'big shrug');
		assert.equal(options.description, 'a shrug');
		assert.match(result.spoken, /big shrug/);
	});

	it('refuses when nothing was asked for', async () => {
		const { deps, sent } = makeDeps({ stickers: [sticker()] });
		const result = await callTool('rename_sticker', { sticker: 'shrug' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /what to change/i);
		assert.equal(sent.length, 0);
	});

	it('refuses an unknown sticker', async () => {
		const { deps } = makeDeps({ stickers: [sticker()] });
		const result = await callTool('rename_sticker', { sticker: 'nowhere near', name: 'other' }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /could not find a sticker/i);
	});
});

describe('delete_sticker', () => {
	it('asks first and deletes on the confirmed second call', async () => {
		const { deps, sent } = makeDeps({ stickers: [sticker()] });
		const owner = ownerVoice(deps);
		const asked = await callTool('delete_sticker', { sticker: 'shrug' }, deps);
		assert.equal(asked.needs_confirmation, true);
		assert.equal(sent.length, 0);
		owner.says('yes');
		const done = await callTool('delete_sticker', { sticker: 'shrug', confirm: true }, deps);
		assert.equal(done.ok, true, done.spoken);
		assert.equal(sent.find((entry) => entry.deletedSticker)?.deletedSticker, 's1');
	});

	it('does not act on a confirmation that names a different sticker', async () => {
		const { deps, sent } = makeDeps({ stickers: [sticker(), sticker({ id: 's2', name: 'oops' })] });
		const owner = ownerVoice(deps);
		await callTool('delete_sticker', { sticker: 'shrug' }, deps);
		owner.says('yes');
		const wrong = await callTool('delete_sticker', { sticker: 'oops', confirm: true }, deps);
		assert.equal(wrong.ok, false);
		assert.equal(sent.length, 0);
	});

	it('refuses without the Manage Expressions permission', async () => {
		const { deps, sent } = makeDeps({ permissions: [], stickers: [sticker()] });
		const result = await callTool('delete_sticker', { sticker: 'shrug', confirm: true }, deps);
		assert.equal(result.ok, false);
		assert.match(result.spoken, /Manage Expressions/);
		assert.equal(sent.length, 0);
	});
});

describe('the expression gate', () => {
	it('refuses every tool that changes the server when the owner did not ask', async () => {
		const gated = expressionTools.filter((tool) => tool.gate).map((tool) => tool.name);
		assert.deepEqual(gated.sort(), ['create_emoji', 'create_sticker', 'delete_emoji', 'delete_sticker', 'rename_emoji', 'rename_sticker']);
		for (const name of gated) {
			const { deps, sent } = makeDeps({ owner: false, emojis: [emoji()], stickers: [sticker()] });
			const result = await callTool(name, { emoji: 'party_blob', sticker: 'shrug', name: 'taken_over', image_url: PNG_URL, confirm: true }, deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.denied, true, `${name} must come back refused by the gate`);
			assert.equal(sent.length, 0, `${name} must not touch the server`);
		}
	});

	it('leaves the read-only listing ungated', async () => {
		assert.equal(expressionTools.find((tool) => tool.name === 'list_expressions').gate, null);
	});
});
