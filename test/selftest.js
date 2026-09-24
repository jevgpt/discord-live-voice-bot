// Offline self-test: no Discord token and no OpenAI key needed.
//
//   node test/selftest.js
//
// Covers: DSP conversions, ring/mixer/playback buffering, an Opus
// encode->decode round trip through prism-media, and a full LiveSession
// conversation against a local mock of the GPT-Live WebSocket.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { AuditLogEvent, ChannelType } from 'discord.js';
import { WebSocketServer } from 'ws';
import prism from 'prism-media';
import { AudioBridge } from '../src/bridge.js';
import { findMember } from '../src/tools/helpers.js';
import { SpeakerAttribution } from '../src/attribution.js';
import { createTaskRunner, executeAction } from '../src/agent.js';
import {
	characterModal,
	commandData,
	findChannel,
	normalize,
	panelView,
	parseVoiceCommand,
	RecentActions,
	routeDelegation,
	stripDictationTail,
} from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { setLocale } from '../src/i18n/index.js';
import { IdleGovernor } from '../src/idle.js';
import { LatencyMeter } from '../src/latency.js';
import { LocalTts, resampleLinear, splitSentences } from '../src/localtts.js';
import { ActivityLog, startPanel } from '../src/panel.js';
import { balanceCodeFences, buildReplyPrompt, handleMessage, imageAttachments, shouldReply } from '../src/messages.js';
import { ChannelReader, formatMessages } from '../src/reader.js';
import { CharacterStore } from '../src/store.js';
import {
	callTool,
	mentionVariants,
	pickRelativeVoiceChannel,
	replaceNameWithMention,
	toolDefinitions,
	toolOutput,
} from '../src/tools.js';
import { VoiceSession } from '../src/voice.js';
import { fuzzyThreshold, MemberIndex, memberNames, nameScore, similarity } from '../src/matcher.js';
import {
	PlaybackQueue,
	Ring,
	SAMPLES_PER_FRAME_24K,
	SAMPLES_PER_FRAME_48K,
	SpeakerMixer,
	mono24kToStereo48k,
	silenceStereo48k,
} from '../src/audio.js';
import { LiveSession } from '../src/live.js';

// src/commands.js freezes its voice-command tables from the locale at IMPORT time, so the Turkish
// grammar needs a second copy of the module loaded while Turkish is active. The query string gives it
// its own entry in the module cache; src/i18n itself stays a single shared instance.
setLocale('tr');
const { parseVoiceCommand: trParseVoiceCommand } = await import('../src/commands.js?locale=tr');
setLocale('en');

let failures = 0;
const watchdog = setTimeout(() => {
	console.error('Test suite timed out (90 s)');
	process.exit(1);
}, 90_000);

function ok(name) {
	console.log(`  ok  ${name}`);
}
function check(name, fn) {
	try {
		fn();
		ok(name);
	} catch (err) {
		failures++;
		console.error(`FAIL  ${name}\n      ${err.message}`);
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		ok(name);
	} catch (err) {
		failures++;
		console.error(`FAIL  ${name}\n      ${String(err?.message ?? err).split('\n').slice(0, 10).join('\n      ')}`);
	}
}
const withTimeout = (promise, ms, label) =>
	Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))]);
async function waitFor(predicate, ms, label) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`${label} timed out`);
}

/** Fake Discord channel/guild: backs the send, read and member/role/emoji/sticker resolution tests. */
function makeToolDeps({ messages = new Map(), emojis = [], stickers = [] } = {}) {
	const sent = [];
	const channel = {
		id: '10',
		name: 'general',
		type: ChannelType.GuildText,
		// A public channel: anybody may see it and read its history.
		permissionsFor: () => ({ has: () => true }),
		send: async (payload) => {
			sent.push(payload);
			return { id: 'm1' };
		},
		messages: {
			fetch: async (options = {}) => {
				if (typeof options === 'string') {
					const found = messages.get(options);
					return new Map(found ? [[options, found]] : []);
				}
				const { limit = 5, after } = options;
				const all = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
				const filtered = after ? all.filter((m) => m.id > after) : all;
				return new Map(filtered.slice(-limit).map((m) => [m.id, m]));
			},
		},
	};
	const guild = {
		channels: { cache: new Map([['10', channel]]) },
		voiceStates: { cache: new Map() },
		members: {
			cache: new Map([
				['1', { id: '1', displayName: 'Ali Veli', user: { username: 'ali', bot: false } }],
				[
					'5',
					{
						id: '5',
						displayName: 'Görkem',
						nickname: 'Görkem',
						user: { username: 'gorko123', globalName: 'Görkem A', bot: false },
					},
				],
			]),
			fetch: async () => new Map(),
		},
		roles: { cache: new Map([['2', { id: '2', name: 'Moderator' }]]), everyone: { id: 'everyone' } },
		emojis: { cache: new Map(emojis.map((e) => [e.id, e])) },
		stickers: { cache: new Map(stickers.map((s) => [s.id, s])), fetch: async () => {} },
	};
	return {
		sent,
		channel,
		guild,
		deps: {
			guild,
			cfg: { textChannelId: null, readLimit: 5 },
			log: () => {},
			reader: new ChannelReader(),
			recentActions: new RecentActions(),
			store: { list: () => [], getActive: () => null, setActive: async () => true },
			joinVoice: async () => {},
			leaveVoice: async () => {},
			currentSpeakerChannel: () => null,
			refreshPersona: async () => {},
		},
	};
}

// ------------------------------------------------------------------ DSP

console.log('DSP');
check('mono24kToStereo48k: upsamples 4x, interpolates and carries state across calls', () => {
	const state = { last: 0 };
	const out1 = mono24kToStereo48k(Int16Array.from([0, 1000]), state);
	assert.equal(out1.length, 2 * 4 * 2); // 2 samples -> 4 frames (48k) -> 8 int16
	// sample pairs: (0+0)/2, 0 | (0+1000)/2, 1000
	assert.deepEqual(Array.from(new Int16Array(out1.buffer, out1.byteOffset, 8)), [0, 0, 0, 0, 500, 500, 1000, 1000]);
	// the second call continues from the previous last sample: (1000+2000)/2, 2000
	const out2 = mono24kToStereo48k(Int16Array.from([2000]), state);
	assert.deepEqual(Array.from(new Int16Array(out2.buffer, out2.byteOffset, 4)), [1500, 1500, 2000, 2000]);
	assert.equal(state.last, 2000);
});
check('silenceStereo48k: returns a correctly sized all-zero frame', () => {
	const s = silenceStereo48k();
	assert.equal(s.length, SAMPLES_PER_FRAME_48K * 4);
	assert.equal(
		s.every((b) => b === 0),
		true,
	);
});
check('Ring: writes and reads, dropping the oldest samples on overflow', () => {
	const r = new Ring(5);
	r.push(Int16Array.from([1, 2, 3]));
	assert.equal(r.length, 3);
	r.push(Int16Array.from([4, 5, 6, 7]));
	assert.equal(r.length, 5); // 1 and 2 were dropped
	const dst = new Int16Array(5);
	assert.equal(r.read(dst), 5);
	assert.deepEqual(Array.from(dst), [3, 4, 5, 6, 7]);
	assert.equal(r.length, 0);
});
check('Ring: reads correctly across the wrap point', () => {
	const r = new Ring(4);
	r.push(Int16Array.from([1, 2, 3]));
	let dst = new Int16Array(2);
	r.read(dst, 2); // r=2
	r.push(Int16Array.from([4, 5, 6])); // wraps, 1 is dropped
	dst = new Int16Array(3);
	assert.equal(r.read(dst, 3), 3);
	assert.deepEqual(Array.from(dst), [3, 4, 5]);
});

check('SpeakerMixer: while the priority speaker talks, only their audio is sent', () => {
	const m = new SpeakerMixer();
	m.setPriority('owner');
	m.addUser('owner');
	// Speech is established over two frames: one loud frame is a click, not a speaker.
	let frame = null;
	for (let i = 0; i < 2; i++) {
		m.push('owner', new Int16Array(SAMPLES_PER_FRAME_24K).fill(5000));
		m.push('other', new Int16Array(SAMPLES_PER_FRAME_24K).fill(3000));
		frame = m.tick();
	}
	assert.equal(frame.priority, true);
	assert.deepEqual(frame.active, ['owner']);
	assert.equal(frame.pcm[0], 5000, 'the other speaker must not be mixed in');

	// The owner keeps the room through the gaps between words; once they have really stopped (half a
	// second, the point where a pause stops being jitter) mixing is normal again.
	for (let i = 0; i < 26; i++) m.tick();
	for (let i = 0; i < 2; i++) {
		m.push('other', new Int16Array(SAMPLES_PER_FRAME_24K).fill(3000));
		frame = m.tick();
	}
	assert.equal(frame.priority, false);
	assert.equal(frame.pcm[0], 3000);
	assert.deepEqual(frame.active, ['other']);
});

console.log('MIXER');
check('SpeakerMixer: sums two speakers and orders them by loudness', () => {
	const m = new SpeakerMixer();
	m.addUser('a');
	m.addUser('b');
	let frame = null;
	for (let i = 0; i < 2; i++) {
		m.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(1000));
		m.push('b', Int16Array.from([20000, ...new Int16Array(SAMPLES_PER_FRAME_24K - 1).fill(30000)]));
		frame = m.tick();
	}
	assert.equal(frame.pcm[0], 21000);
	assert.equal(frame.pcm[1], 31000);
	assert.deepEqual(frame.active, ['b', 'a'], 'the loudest (dominant) speaker comes first');
});
check('SpeakerMixer: a microphone that is merely open is not a speaker', () => {
	const m = new SpeakerMixer();
	m.addUser('speaking');
	m.addUser('breathing');
	let frame = null;
	for (let i = 0; i < 4; i++) {
		m.push('speaking', new Int16Array(SAMPLES_PER_FRAME_24K).fill(3000));
		m.push('breathing', new Int16Array(SAMPLES_PER_FRAME_24K).fill(120));
		frame = m.tick();
	}
	assert.deepEqual(frame.active, ['speaking'], 'room noise must not be credited with the sentence');
});
check('SpeakerMixer: clips a sum that overflows int16', () => {
	const m = new SpeakerMixer();
	m.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(30000));
	m.push('b', new Int16Array(SAMPLES_PER_FRAME_24K).fill(30000));
	assert.equal(m.tick().pcm[0], 32767);
	m.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(-30000));
	m.push('b', new Int16Array(SAMPLES_PER_FRAME_24K).fill(-30000));
	assert.equal(m.tick().pcm[0], -32768);
});
check('SpeakerMixer: a user below the activity peak is not listed as active', () => {
	const m = new SpeakerMixer();
	m.addUser('a');
	m.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(10));
	const { pcm, active } = m.tick();
	assert.equal(active.length, 0);
	assert.equal(pcm[0], 10);
});
check('PlaybackQueue: drops the oldest frame once capacity is exceeded', () => {
	const q = new PlaybackQueue({ maxFrames: 2 });
	assert.equal(q.frameSamples, SAMPLES_PER_FRAME_24K);
	q.push(new Int16Array(SAMPLES_PER_FRAME_24K).fill(1));
	q.push(new Int16Array(SAMPLES_PER_FRAME_24K).fill(2));
	q.push(new Int16Array(SAMPLES_PER_FRAME_24K).fill(3));
	assert.equal(q.length, SAMPLES_PER_FRAME_24K * 2);
	const dst = new Int16Array(SAMPLES_PER_FRAME_24K * 2);
	assert.equal(q.read(dst, dst.length), SAMPLES_PER_FRAME_24K * 2);
	assert.equal(dst[0], 2); // the oldest frame (1) was dropped
	assert.equal(dst[SAMPLES_PER_FRAME_24K], 3);
});

console.log('IDLE');
check('IdleGovernor: pauses once the idle time is up, and touch() resets it', () => {
	let now = 0;
	const g = new IdleGovernor({ idleMs: 600_000, now: () => now });
	assert.equal(g.shouldPause(true), false);
	now = 599_999;
	assert.equal(g.shouldPause(true), false);
	now = 600_000;
	assert.equal(g.shouldPause(true), true);
	assert.equal(g.shouldPause(false), false); // nothing to pause when no session is open
	g.touch();
	assert.equal(g.shouldPause(true), false);
});
check('IdleGovernor: never pauses when idleMs is 0', () => {
	const g = new IdleGovernor({ idleMs: 0, now: () => 10 ** 9 });
	assert.equal(g.shouldPause(true), false);
});

console.log('STORE');
await checkAsync('CharacterStore: creates, selects, updates and removes characters, and persists them', async () => {
	const file = path.join(os.tmpdir(), `characters-test-${process.pid}-${Date.now()}.json`);
	try {
		const store = await new CharacterStore(file).load();
		assert.equal(store.list().length, 0);

		const pirate = await store.create({ name: 'Pirate', prompt: 'Talk like a sailor', voice: 'marin' });
		const detective = await store.create({ name: 'Detective', prompt: 'Talk seriously' });
		assert.equal(store.list().length, 2);
		assert.equal(store.getActive().id, pirate.id, 'the first character becomes active on its own');

		await store.setActive(detective.id);
		await store.update(detective.id, { prompt: 'Talk very seriously' });

		const reloaded = await new CharacterStore(file).load();
		assert.equal(reloaded.getActive().id, detective.id);
		assert.equal(reloaded.get(detective.id).prompt, 'Talk very seriously');

		await store.remove(detective.id);
		assert.equal(store.list().length, 1);
		assert.equal(store.getActive().id, pirate.id, 'removing the active character promotes another one');
	} finally {
		await rm(file, { force: true });
	}
});

console.log('VOICE COMMANDS');
check('parseVoiceCommand: switches to a saved character', () => {
	const characters = [
		{ id: '1', name: 'Pirate' },
		{ id: '2', name: 'Detective' },
	];
	const command = parseVoiceCommand('switch to the Pirate character', characters);
	assert.equal(command.type, 'character');
	assert.equal(command.character.id, '1');
	assert.equal(parseVoiceCommand('can you switch to the detective character now', characters).character.id, '2');
	assert.equal(parseVoiceCommand('change the character to Detective', characters).character.id, '2');
});
check('parseVoiceCommand: reports a character that is not saved', () => {
	const command = parseVoiceCommand('switch to the Chef character', [{ id: '1', name: 'Pirate' }]);
	assert.equal(command.type, 'character-miss');
	assert.equal(command.name, 'Chef');
});
check('parseVoiceCommand: sends a message to a text channel', () => {
	const channels = {
		text: [
			{ id: '10', name: 'general' },
			{ id: '11', name: 'announcements' },
		],
		voice: [],
	};

	const direct = parseVoiceCommand('write hello everyone in the general channel', [], channels);
	assert.equal(direct.type, 'send');
	assert.equal(direct.channel.id, '10');
	assert.equal(direct.text, 'hello everyone');

	const explicit = parseVoiceCommand('send there is a meeting tomorrow to the announcements channel', [], channels);
	assert.equal(explicit.channel.id, '11');
	assert.equal(explicit.text, 'there is a meeting tomorrow');

	// without the word "channel", on the channel name alone
	const noWord = parseVoiceCommand('write hello in general chat', [], { text: [{ id: '12', name: 'general chat' }], voice: [] });
	assert.equal(noWord.type, 'send');
	assert.equal(noWord.channel.id, '12');
	assert.equal(noWord.text, 'hello');

	// no channel name said -> the default channel (channel null)
	const bare = parseVoiceCommand('write good night everyone in the channel', [], channels);
	assert.equal(bare.type, 'send');
	assert.equal(bare.channel, null);
	assert.equal(bare.text, 'good night everyone');

	// a name that is not in the list -> the channel stays unresolved and the name is reported
	const unknown = parseVoiceCommand('write hi in the nowhere channel', [], channels);
	assert.equal(unknown.type, 'send');
	assert.equal(unknown.channel, null);
	assert.equal(unknown.name, 'nowhere');
	assert.equal(unknown.text, 'hi');
});
check('parseVoiceCommand: reads a channel', () => {
	const channels = { text: [{ id: '10', name: 'general' }], voice: [] };
	assert.equal(parseVoiceCommand('read the last messages in the general channel', [], channels).channel.id, '10');
	assert.equal(parseVoiceCommand("what's new in the general channel", [], channels).channel.id, '10');
	const noChannel = parseVoiceCommand('can you read the last messages', [], channels);
	assert.equal(noChannel.type, 'read');
	assert.equal(noChannel.channel, null);
	// not a read: a send sentence must not be taken for a read
	assert.equal(parseVoiceCommand('write hello in the general channel', [], channels).type, 'send');
});
check('parseVoiceCommand: joins and leaves a voice channel', () => {
	const channels = { text: [], voice: [{ id: '20', name: 'General' }] };
	assert.equal(parseVoiceCommand('join the General voice channel', [], channels).channel.id, '20');
	assert.deepEqual(parseVoiceCommand('join the voice channel', [], channels), { type: 'join', channel: null, name: null });
	assert.equal(
		parseVoiceCommand('come into the testo voice channel', [], { text: [], voice: [{ id: '21', name: 'testo' }] }).channel.id,
		'21',
	);
	assert.equal(
		parseVoiceCommand('can you hop into the blue room', [], { text: [], voice: [{ id: '22', name: 'blue room' }] }).channel.id,
		'22',
	);
	assert.deepEqual(parseVoiceCommand('join the channel', [], channels), { type: 'join', channel: null, name: null });
	assert.equal(parseVoiceCommand('I joined the channel', [], channels), null, 'a past tense sentence is not a command');
	assert.equal(parseVoiceCommand('leave the channel', [], channels).type, 'leave');
	assert.equal(parseVoiceCommand('the weather is lovely today', [], channels), null);
});
check('parseVoiceCommand: music control', () => {
	const channels = { text: [], voice: [] };
	assert.deepEqual(parseVoiceCommand('play Daft Punk Around the World', [], channels), {
		type: 'music',
		action: 'play',
		query: 'Daft Punk Around the World',
	});
	assert.deepEqual(parseVoiceCommand('put on some jazz', [], channels), { type: 'music', action: 'play', query: 'some jazz' });
	assert.equal(parseVoiceCommand('stop the music', [], channels).action, 'stop');
	assert.equal(parseVoiceCommand('pause the music', [], channels).action, 'pause');
	assert.equal(parseVoiceCommand('resume the music', [], channels).action, 'resume');
	assert.equal(parseVoiceCommand('skip the song', [], channels).action, 'skip');
	assert.equal(parseVoiceCommand("what's playing", [], channels).action, 'status');
	assert.deepEqual(parseVoiceCommand('set the music volume to 20 percent', [], channels), {
		type: 'music',
		action: 'volume',
		percent: 20,
	});
});

// The Turkish grammar is a separate code path: the same parser, driven by the Turkish locale data.
check('parseVoiceCommand (tr): Turkish speech patterns are parsed with the Turkish grammar', () => {
	setLocale('tr');
	try {
		const characters = [
			{ id: '1', name: 'Korsan' },
			{ id: '2', name: 'Dedektif' },
		];
		assert.equal(trParseVoiceCommand('Korsan karakterine geç', characters).character.id, '1');
		assert.equal(trParseVoiceCommand('Şimdi dedektif karakterine geçebilir misin', characters).character.id, '2');
		const miss = trParseVoiceCommand('Aşçı karakterine geç', [{ id: '1', name: 'Korsan' }]);
		assert.equal(miss.type, 'character-miss');
		assert.equal(miss.name, 'Aşçı');

		const channels = {
			text: [
				{ id: '10', name: 'genel' },
				{ id: '11', name: 'duyurular' },
			],
			voice: [{ id: '20', name: 'Genel' }],
		};
		const send = trParseVoiceCommand('genel kanalına merhaba arkadaşlar yaz', [], channels);
		assert.equal(send.type, 'send');
		assert.equal(send.channel.id, '10');
		assert.equal(send.text, 'merhaba arkadaşlar');

		const explicit = trParseVoiceCommand('duyurular kanalına mesaj gönder: yarın toplantı var', [], channels);
		assert.equal(explicit.channel.id, '11');
		assert.equal(explicit.text, 'yarın toplantı var');

		const bare = trParseVoiceCommand('kanala mesaj gönder: herkese iyi geceler', [], channels);
		assert.equal(bare.channel, null);
		assert.equal(bare.text, 'herkese iyi geceler');

		// The channel is marked by a case suffix alone, without the word "kanal"
		const noWord = trParseVoiceCommand('genel sohbete merhaba yaz', [], { text: [{ id: '12', name: 'genel sohbet' }], voice: [] });
		assert.equal(noWord.type, 'send');
		assert.equal(noWord.channel.id, '12');
		assert.equal(noWord.text, 'merhaba');

		const unknown = trParseVoiceCommand('olmayan kanalına selam yaz', [], channels);
		assert.equal(unknown.type, 'send');
		assert.equal(unknown.channel, null);
		assert.equal(unknown.name, 'olmayan');
		assert.equal(unknown.text, 'selam');

		assert.equal(trParseVoiceCommand('genel kanalındaki son mesajları oku', [], channels).type, 'read');
		assert.equal(trParseVoiceCommand('genel kanalında ne yazıyor', [], channels).channel.id, '10');
		const noReadChannel = trParseVoiceCommand('son mesajları okuyabilir misin', [], channels);
		assert.equal(noReadChannel.type, 'read');
		assert.equal(noReadChannel.channel, null);
		// not a read: a send sentence must not be taken for a read
		assert.equal(trParseVoiceCommand('genel kanalına merhaba yaz', [], channels).type, 'send');

		assert.equal(trParseVoiceCommand('Genel sesli kanalına katıl', [], channels).channel.id, '20');
		assert.deepEqual(trParseVoiceCommand('sesli kanala katıl', [], channels), { type: 'join', channel: null, name: null });
		assert.equal(
			trParseVoiceCommand('testo isminde sesli kanala gir', [], { text: [], voice: [{ id: '21', name: 'testo' }] }).channel.id,
			'21',
		);
		assert.equal(
			trParseVoiceCommand('mavi odaya geçer misin', [], { text: [], voice: [{ id: '22', name: 'mavi oda' }] }).channel.id,
			'22',
		);
		assert.deepEqual(trParseVoiceCommand('kanala gir', [], channels), { type: 'join', channel: null, name: null });
		assert.equal(trParseVoiceCommand('kanala girdim', [], channels), null, 'a past tense sentence is not a command');
		assert.equal(trParseVoiceCommand('kanaldan ayrıl', [], channels).type, 'leave');
		assert.equal(trParseVoiceCommand('bugün hava çok güzel', [], channels), null);

		assert.deepEqual(trParseVoiceCommand('Daft Punk Around the World çal', [], channels), {
			type: 'music',
			action: 'play',
			query: 'Daft Punk Around the World',
		});
		assert.equal(trParseVoiceCommand('müziği durdur', [], channels).action, 'stop');
		assert.equal(trParseVoiceCommand('şarkıyı atla', [], channels).action, 'skip');
	} finally {
		setLocale('en');
	}
});
check('panel and modals stay inside the Discord limits (no serialisation error)', () => {
	const character = { id: '1', name: 'Pirate Captain', prompt: 'x'.repeat(1200), voice: 'marin' };
	const longStore = {
		list: () => Array.from({ length: 30 }, (_, i) => ({ ...character, id: `id${i}`, name: `Character ${i}` })),
		getActive: () => character,
		get: () => character,
	};
	const view = panelView(longStore);
	assert.doesNotThrow(() => view.embeds[0].toJSON());
	for (const row of view.components) assert.doesNotThrow(() => row.toJSON());

	// Modal field labels cannot exceed 45 characters (this limit once produced an "Invalid string length" error).
	for (const modal of [characterModal({ mode: 'new' }), characterModal({ mode: 'edit', character })]) {
		const json = modal.toJSON();
		for (const row of json.components) {
			for (const component of row.components) {
				assert.ok(component.label.length <= 45, `label must be <=45: "${component.label}" (${component.label.length})`);
			}
		}
	}
});
check('findChannel: matches names loosely and honours the channel kind', () => {
	const guild = {
		channels: {
			cache: new Map([
				['1', { name: 'general', type: ChannelType.GuildText }],
				['2', { name: 'General Chat', type: ChannelType.GuildText }],
				['3', { name: 'Voice General', type: ChannelType.GuildVoice }],
			]),
		},
	};
	assert.equal(findChannel(guild, 'General', 'text').name, 'general');
	assert.equal(findChannel(guild, 'general chat', 'text').name, 'General Chat');
	assert.equal(findChannel(guild, 'Voice General', 'voice').name, 'Voice General');
	assert.equal(findChannel(guild, 'no such channel', 'text'), null);
});
check('commandData + panelView shape', () => {
	const data = commandData();
	assert.deepEqual(
		data.map((command) => command.name).sort(),
		['character', 'help', 'join', 'leave', 'music', 'panel', 'read', 'recording', 'send', 'status', 'summary'],
	);
	assert.doesNotThrow(() => JSON.stringify(data)); // the payload sent to the REST API must serialise

	const character = { id: '1', name: 'Pirate', prompt: 'Talk like a sailor', voice: 'marin' };
	const fakeStore = {
		list: () => [character],
		getActive: () => character,
		get: () => character,
	};
	const view = panelView(fakeStore);
	assert.equal(view.embeds.length, 1);
	const customIds = view.components.flatMap((row) => row.components.map((component) => component.data.custom_id));
	assert.ok(customIds.includes('char:select'));
	assert.ok(customIds.includes('char:new'));
	assert.ok(customIds.includes('char:edit'));
	assert.ok(customIds.includes('voice:join'));
	assert.ok(customIds.includes('voice:leave'));
});

console.log('AGENT (delegation)');
await checkAsync('executeAction: sends, reads, switches character and blocks a repeat', async () => {
	const fixture = makeToolDeps();
	const { deps, channel, sent } = fixture;
	const character = { id: 'c1', name: 'Pirate', prompt: 'sailor' };
	let active = null;
	deps.store = {
		list: () => [character],
		getActive: () => (active ? character : null),
		setActive: async (id) => {
			active = id;
			return true;
		},
	};

	const sendResult = await executeAction({ type: 'send', channel, text: 'hello' }, deps);
	assert.equal(sendResult.text, 'I sent the message to #general.');
	assert.deepEqual(
		sent.map((payload) => payload.content),
		['hello'],
	);

	const again = await executeAction({ type: 'send', channel, text: 'hello' }, deps);
	assert.equal(again.reused, true);
	assert.equal(sent.length, 1, 'it must not be sent a second time');

	const readResult = await executeAction({ type: 'read', channel, count: 5 }, deps);
	assert.equal(readResult.speak, true);

	// Switching the character is for the owner and the administrators, as /character is.
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	const characterResult = await executeAction({ type: 'character', character }, deps);
	assert.equal(active, 'c1', 'the character must become active');
	assert.equal(characterResult.speak, false, 'the model must stay quiet on a character switch (the session is rebuilt)');
});
await checkAsync('routeDelegation + createTaskRunner: action or research?', async () => {
	const fixture = makeToolDeps();
	const { deps, channel } = fixture;
	const lists = { text: [channel], voice: [] };
	assert.equal(routeDelegation('write hello in the general channel', [], lists).kind, 'action');
	assert.equal(routeDelegation('what is the weather like today', [], lists).kind, 'research');

	const runnerDeps = {
		...deps,
		recentActions: new RecentActions(),
		channelLists: () => lists,
		getUserText: () => 'write hello in the general channel',
		textModel: null,
		textApi: 'responses',
		textClient: null,
	};
	const actionAnswer = await createTaskRunner(runnerDeps)();
	assert.equal(actionAnswer.mode, 'commentary');
	assert.ok(actionAnswer.text.includes('I sent the message'), actionAnswer.text);

	const researchAnswer = await createTaskRunner({
		...runnerDeps,
		recentActions: new RecentActions(),
		getUserText: () => 'what is the weather like today',
	})();
	assert.ok(
		researchAnswer.text.includes('RESEARCH_MODEL') || researchAnswer.text.includes('DEEPSEEK_API_KEY'),
		`with no model configured the answer must point the way: ${researchAnswer.text}`,
	);

	// DeepSeek: research goes through plain chat completions
	const chatCalls = [];
	const chatAnswer = await createTaskRunner({
		...runnerDeps,
		recentActions: new RecentActions(),
		getUserText: () => 'what is the weather like today',
		textModel: 'deepseek-chat',
		textApi: 'chat',
		textClient: {
			chat: {
				completions: {
					create: async (payload) => {
						chatCalls.push(payload);
						return { choices: [{ message: { content: 'The weather is nice, 22 degrees.' } }] };
					},
				},
			},
		},
	})();
	assert.equal(chatAnswer.text, 'The weather is nice, 22 degrees.');
	assert.equal(chatCalls.length, 1, 'DeepSeek chat completions must be called');
	assert.equal(chatCalls[0].model, 'deepseek-chat');

	const emptyAnswer = await createTaskRunner({ ...runnerDeps, recentActions: new RecentActions(), getUserText: () => '' })();
	assert.equal(emptyAnswer.mode, 'commentary');
});

console.log('TOOLS (function calling)');
await checkAsync('send_message: resolves member, role and everyone mentions plus emoji and stickers', async () => {
	const emoji = { id: '3', name: 'pogchamp', toString: () => '<:pogchamp:3>' };
	const sticker = { id: '4', name: 'cat' };
	const { deps, sent } = makeToolDeps({ emojis: [emoji], stickers: [sticker] });
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];

	const result = await callTool(
		'send_message',
		{ channel: 'general', text: 'hi :pogchamp:', mentions: ['Ali', 'Moderator', 'everyone'], stickers: ['cat'] },
		deps,
	);
	assert.equal(result.ok, true);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].content, '<@1> <@&2> @everyone hi <:pogchamp:3>');
	assert.deepEqual(sent[0].stickers, ['4']);
	assert.ok(result.spoken.includes('#general'));
});
await checkAsync('send_message: a name already in the body becomes the mention (it is not repeated)', async () => {
	const { deps, sent } = makeToolDeps();
	const result = await callTool('send_message', { channel: 'general', text: 'Görkem come to voice', mentions: ['Görkem'] }, deps);
	assert.equal(result.ok, true, result.spoken);
	assert.equal(sent[0].content, '<@5> come to voice', sent[0].content);
	assert.ok(!sent[0].content.includes('Görkem'), 'the name must not be written a second time');
});
await checkAsync('send_message: a name missing from the body is prepended as a mention', async () => {
	const { deps, sent } = makeToolDeps();
	await callTool('send_message', { channel: 'general', text: 'come to voice', mentions: ['Görkem'] }, deps);
	assert.equal(sent[0].content, '<@5> come to voice');
});
// The Turkish case suffixes below are deliberate fixtures: normalize() strips them whatever the locale is.
check('replaceNameWithMention: handles Turkish case suffixes and multi-word names', () => {
	assert.deepEqual(replaceNameWithMention('Görkem sese gelsene', 'Görkem', '<@5>'), { text: '<@5> sese gelsene', replaced: true });
	assert.deepEqual(replaceNameWithMention("Görkem'e söyle", 'Görkem', '<@5>'), { text: '<@5> söyle', replaced: true });
	assert.deepEqual(replaceNameWithMention('ali veli gel', 'Ali Veli', '<@1>'), { text: '<@1> gel', replaced: true });
	assert.deepEqual(replaceNameWithMention('Ali Baba geldi', 'Ali', '<@1>'), { text: '<@1> Baba geldi', replaced: true });
	assert.deepEqual(replaceNameWithMention('selam millet', 'Görkem', '<@5>'), { text: 'selam millet', replaced: false });
	assert.equal(replaceNameWithMention('alp geldi', 'al', '<@9>').replaced, false, 'a short name must not match loosely');
});
check('mentionVariants: sliding word windows and the short-name filter', () => {
	const variants = mentionVariants([], ['Ben Yazılım Falan Bilmem', 'yazilim', 'Ben']);
	assert.equal(variants[0], 'ben yazilim falan bilmem', 'the longest variant is tried first');
	assert.ok(variants.includes('yazilim falan bilmem'), 'a slice of a multi-word name must be tried');
	assert.ok(!variants.includes('ben'), 'a single short word must be dropped');
	// A name handed over by the model is a trusted source: it is tried even when it is short
	assert.deepEqual(mentionVariants(['Ali']), ['ali']);
});

await checkAsync('send_message: matches when the body uses another of the member\'s name variants', async () => {
	const { deps, sent, guild } = makeToolDeps();
	guild.members.cache.set('9', {
		id: '9',
		displayName: 'Ben Yazılım Falan Bilmem',
		nickname: 'Ben Yazılım Falan Bilmem',
		user: { username: 'yazilim', globalName: 'Ben Yazılım Falan Bilmem', bot: false },
	});
	await callTool(
		'send_message',
		{ channel: 'general', text: '@yazılım falan bilmem sese gelsene', mentions: ['Ben Yazılım Falan Bilmem'] },
		deps,
	);
	assert.equal(sent[0].content, '<@9> sese gelsene', sent[0].content);
});

await checkAsync('send_message: pings only what was asked for; a literal @everyone in the text is inert', async () => {
	const { deps, sent } = makeToolDeps();
	// Nobody was asked for: even a literal "@everyone" in the text must not ping
	await callTool('send_message', { channel: 'general', text: '@everyone I am not writing that' }, deps);
	assert.deepEqual(sent[0].allowedMentions.parse, [], 'an @everyone inside the text must not ping');
	assert.deepEqual(sent[0].allowedMentions.users, []);
	assert.ok(sent[0].content.includes('@everyone'), 'the text goes out unchanged');

	// When a member is asked for, only that person is pinged
	await callTool('send_message', { channel: 'general', text: 'hi', mentions: ['Ali'] }, deps);
	assert.deepEqual(sent[1].allowedMentions.users, ['1']);
	assert.deepEqual(sent[1].allowedMentions.parse, []);

	// "everyone" asked for while the owner is NOT speaking: no ping, the tag is dropped and a warning comes back
	const noOwner = await callTool('send_message', { channel: 'general', text: 'announcement', mentions: ['everyone'] }, deps);
	assert.deepEqual(sent[2].allowedMentions.parse, [], '@everyone must not be pinged without the owner');
	assert.equal(sent[2].content, 'announcement', '@everyone must not reach the text either');
	assert.ok(noOwner.warnings.some((w) => w.includes('owner')), noOwner.warnings.join('; '));

	// "everyone" asked for by the owner: @everyone is pinged
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	await callTool('send_message', { channel: 'general', text: 'announcement', mentions: ['everyone'] }, deps);
	assert.deepEqual(sent[3].allowedMentions.parse, ['everyone']);

	// When a role is asked for, the role is pinged
	await callTool('send_message', { channel: 'general', text: 'announcement', mentions: ['Moderator'] }, deps);
	assert.deepEqual(sent[4].allowedMentions.roles, ['2']);
});

await checkAsync('send_message: an unresolved mention/emoji comes back as a warning and the message still goes out', async () => {
	const { deps, sent } = makeToolDeps();
	const result = await callTool('send_message', { channel: 'general', text: 'hello', mentions: ['No Such Person'], emojis: ['nosuchemoji'] }, deps);
	assert.equal(result.ok, true);
	assert.equal(sent[0].content, 'hello');
	assert.equal(result.warnings.length, 2);
});
await checkAsync('send_message: an unknown channel gives ok:false and something to say', async () => {
	const { deps, sent } = makeToolDeps();
	const result = await callTool('send_message', { channel: 'nowhere', text: 'hello' }, deps);
	assert.equal(result.ok, false);
	assert.equal(sent.length, 0);
	assert.ok(result.spoken.includes('could not find a text channel'), result.spoken);
});
await checkAsync('read_messages: the first read returns the last messages, later reads only the new ones', async () => {
	const messages = new Map([
		[1, { id: 1, createdTimestamp: 1, content: 'old message', author: { bot: false, displayName: 'Ali' }, stickers: new Map(), attachments: new Map(), embeds: [] }],
		[2, { id: 2, createdTimestamp: 2, content: 'new message', author: { bot: false, displayName: 'Veli' }, stickers: new Map(), attachments: new Map(), embeds: [] }],
	]);
	const { deps, channel } = makeToolDeps({ messages });
	await deps.reader.warmUp([channel]);

	const first = await callTool('read_messages', { channel: 'general' }, deps);
	assert.equal(first.ok, true);
	assert.ok(first.spoken.includes('old message') && first.spoken.includes('new message'), 'the first read returns the last messages');
	assert.equal(first.data.new, false);

	messages.set(3, { id: 3, createdTimestamp: 3, content: 'the newest one', author: { bot: false, displayName: 'Ali' }, stickers: new Map(), attachments: new Map(), embeds: [] });
	const second = await callTool('read_messages', { channel: 'general' }, deps);
	assert.equal(second.data.new, true);
	assert.equal(second.data.count, 1);
	assert.ok(second.spoken.includes('the newest one'));

	const third = await callTool('read_messages', { channel: 'general' }, deps);
	assert.equal(third.data.count, 0);
	assert.ok(third.spoken.includes('no new messages'), third.spoken);
});
// Live failure: "read the DM I just sent you" came back as "I could not tell which channel to read".
// This was the only tool in the messaging family that could not look at a private conversation, while
// the bot was perfectly able to send one.
// "What are my roles" arrives with an empty name; looking up an empty string used to fail with
// "I could not find anyone called ''".
// "Write to me from the DM" was answered with "'me' does not appear as a name in the system". It is not
// a name; it is the person saying it.
await checkAsync('a member called "me" is whoever is speaking, and a real name still wins', async () => {
	const { deps, guild } = makeToolDeps();
	guild.members.cache.set('9', { id: '9', displayName: 'Kaan', user: { username: 'kaan', bot: false }, roles: { cache: new Map() } });
	guild.members.cache.set('10', { id: '10', displayName: 'Ben', user: { username: 'ben', bot: false }, roles: { cache: new Map() } });
	deps.currentSpeakerId = () => '9';

	// The suite runs in English, so the English words for oneself are the ones under test here; the
	// Turkish list is the same mechanism with different data.
	const me = await findMember(deps, 'me');
	assert.equal(me?.id, '9', 'the person talking is what "me" means');
	const alsoMe = await findMember(deps, 'myself');
	assert.equal(alsoMe?.id, '9');
	// Somebody really called Ben keeps their own name: the self words are the LAST thing tried.
	const named = await findMember(deps, 'Ben');
	assert.equal(named?.id, '10', 'a real name wins over the word for oneself');
});

await checkAsync('member_roles: an empty name means whoever is speaking', async () => {
	const { deps, guild } = makeToolDeps();
	guild.members.cache.set('7', {
		id: '7',
		displayName: 'Kaan',
		user: { username: 'kaan', bot: false },
		roles: { cache: new Map([['r1', { name: 'Chillz', position: 2 }]]) },
	});
	deps.currentSpeakerId = () => '7';
	const result = await callTool('member_roles', {}, deps);
	assert.equal(result.ok, true, result.spoken);
	assert.deepEqual(result.data.roles, ['Chillz']);
});

await checkAsync('read_messages: reads the private conversation the bot was last in', async () => {
	const dmMessages = new Map([
		[9, { id: 9, createdTimestamp: 9, content: 'here is the invite', author: { bot: false, displayName: 'Kaan' }, stickers: new Map(), attachments: new Map(), embeds: [] }],
	]);
	const dmChannel = {
		id: 'dm-1',
		name: null,
		messages: { fetch: async () => dmMessages },
	};
	const { deps } = makeToolDeps();
	// Private conversations are read for the owner only, so the owner is the one asking here.
	deps.cfg.ownerId = '9';
	deps.currentSpeakerId = () => '9';
	deps.lastDirectMessage = () => ({ channelId: 'dm-1', name: 'Kaan' });
	deps.client = { ...deps.client, channels: { cache: new Map([['dm-1', dmChannel]]), fetch: async () => dmChannel } };

	const result = await callTool('read_messages', { dm: 'last' }, deps);
	assert.equal(result.ok, true, result.spoken);
	assert.ok(result.spoken.includes('here is the invite'), result.spoken);
	// A conversation has no channel NAME, and every sentence about one used to come out with the
	// placeholder still in it: "#{channel} history read: 1 messages".
	assert.ok(!result.spoken.includes('{channel}'), `the conversation needs a name of its own: ${result.spoken}`);
	assert.equal(result.data.channel.includes('{'), false, result.data.channel);

	// Asked again, it gives the latest again. The new-messages-only path would answer "nothing new" to
	// somebody pointing at a message they can see on their own screen.
	const again = await callTool('read_messages', { dm: 'last' }, deps);
	assert.ok(again.spoken.includes('here is the invite'), `a second read still shows the latest: ${again.spoken}`);

	// An id the model invented must not read as "there is nothing older".
	const bogus = await callTool('read_messages', { dm: 'last', all: true, before: 'the last one' }, deps);
	assert.ok(bogus.spoken.includes('here is the invite'), `an invented id is ignored, not obeyed: ${bogus.spoken}`);
});

await checkAsync('read_messages: warns when the message content is hidden (intent off)', async () => {
	const messages = new Map([
		[1, { id: 1, createdTimestamp: 1, content: '', author: { bot: false, displayName: 'Ali' }, stickers: new Map(), attachments: new Map(), embeds: [] }],
	]);
	const { deps, channel } = makeToolDeps({ messages });
	await deps.reader.warmUp([channel]);
	const result = await callTool('read_messages', { channel: 'general' }, deps);
	assert.ok(result.spoken.includes('MESSAGE_CONTENT'), 'the intent warning must be given');
});
check('toolOutput: the JSON handed back to the model', () => {
	const output = JSON.parse(toolOutput({ ok: true, spoken: 'sent it', data: { channel: 'x' }, warnings: ['w'] }));
	assert.equal(output.ok, true);
	assert.equal(output.summary, 'sent it');
	assert.deepEqual(output.data, { channel: 'x' });
	assert.deepEqual(output.warnings, ['w']);
});

console.log('CHANNEL READER');
check('formatMessages: describes files, stickers, embeds and empty content', () => {
	const line = formatMessages(
		[
			{ id: 1, createdTimestamp: 1, content: 'hello', author: { bot: false, displayName: 'Ali' }, stickers: new Map(), attachments: new Map(), embeds: [] },
			{
				id: 2,
				createdTimestamp: 2,
				content: '',
				author: { bot: true, displayName: 'Bot' },
				stickers: new Map([['s', { name: 'cat' }]]),
				attachments: new Map([['a', {}]]),
				embeds: [{}, {}],
			},
		],
		'general',
	);
	assert.ok(line.includes('Ali: hello'));
	assert.ok(line.includes('Bot (bot)'));
	assert.ok(line.includes('[sticker: cat]'));
	assert.ok(line.includes('[1 file/image]'));
	assert.ok(line.includes('[2 embed]'));
	assert.ok(formatMessages([], 'general').includes('No new messages'));
});
await checkAsync('ChannelReader: sets a baseline on warm-up and then tracks new messages', async () => {
	const messages = new Map([
		[1, { id: 1, createdTimestamp: 1, content: 'a', author: { bot: false, displayName: 'A' }, stickers: new Map(), attachments: new Map(), embeds: [] }],
		[2, { id: 2, createdTimestamp: 2, content: 'b', author: { bot: false, displayName: 'B' }, stickers: new Map(), attachments: new Map(), embeds: [] }],
	]);
	const { deps, channel } = makeToolDeps({ messages });
	await deps.reader.warmUp([channel]);
	assert.equal(deps.reader.lastReadId('10'), 2, 'the baseline must be set to the newest message');

	messages.set(5, { id: 5, createdTimestamp: 3, content: 'c', author: { bot: false, displayName: 'C' }, stickers: new Map(), attachments: new Map(), embeds: [] });
	const result = await deps.reader.read(channel, 5);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].content, 'c');
	assert.equal(deps.reader.lastReadId('10'), 5);
});

await checkAsync('list_voice_members: names the people in the channel and skips bots', async () => {
	const fixture = makeToolDeps();
	const { deps, guild } = fixture;
	const voiceChannel = { id: 'v1', name: 'General', type: ChannelType.GuildVoice, members: new Map() };
	guild.channels.cache.set('v1', voiceChannel);
	guild.members.cache.set('9', { id: '9', displayName: 'Helper Bot', user: { username: 'helper', bot: true } });
	guild.voiceStates.cache.set('1', { id: '1', channelId: 'v1' });
	guild.voiceStates.cache.set('5', { id: '5', channelId: 'v1' });
	guild.voiceStates.cache.set('9', { id: '9', channelId: 'v1' });
	deps.currentVoiceChannel = () => voiceChannel;

	const result = await callTool('list_voice_members', {}, deps);
	assert.equal(result.ok, true);
	assert.deepEqual(result.data.members, ['Ali Veli (account: ali)', 'Görkem (account: gorko123)']);
	assert.ok(result.spoken.includes('Ali Veli'));
	assert.ok(result.spoken.includes('account: gorko123'), 'the account name is said too when it differs from the server name');
	assert.ok(!result.spoken.includes('Helper Bot'), 'bots must not be listed');
});

await checkAsync('leave_voice: returns at once and leaves on a delay so a goodbye can be said', async () => {
	const calls = [];
	const started = Date.now();
	const result = await callTool(
		'leave_voice',
		{},
		{
			cfg: { leaveDelayMs: 40 },
			log: () => {},
			leaveVoice: async () => {
				calls.push(Date.now() - started);
			},
		},
	);
	assert.equal(result.ok, true);
	assert.equal(result.data.leave_in_ms, 40);
	assert.equal(calls.length, 0, 'leaving must be delayed (the tool itself returns immediately)');
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(calls.length, 1, 'it must leave the channel once the delay is over');
	assert.ok(calls[0] >= 30, `leaving must happen no sooner than the delay (${calls[0]} ms)`);
});

await checkAsync('send_dm + move_member: sends a DM, moves the member and comes along', async () => {
	const fixture = makeToolDeps();
	const { deps, guild } = fixture;
	const dms = [];
	const moved = [];
	const joined = [];
	const human = {
		id: '1',
		displayName: 'Ali Veli',
		user: { username: 'ali', bot: false },
		voice: { channel: null, setChannel: async (channel) => { moved.push(channel.name); human.voice.channel = channel; } },
		send: async (payload) => { dms.push(payload.content); return { id: 'dm1' }; },
	};
	guild.members.cache.set('1', human);
	const home = { id: 'v1', name: 'General', type: ChannelType.GuildVoice, rawPosition: 1, parentId: 'cat', members: new Map() };
	const below = { id: 'v2', name: 'lounge', type: ChannelType.GuildVoice, rawPosition: 2, parentId: 'cat', members: new Map() };
	guild.channels.cache.set('v1', home);
	guild.channels.cache.set('v2', below);
	human.voice.channel = home;
	deps.joinVoice = async (channel) => { joined.push(channel.name); };
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];

	const dm = await callTool('send_dm', { to: 'Ali', text: 'hi, this is a private message' }, deps);
	assert.equal(dm.ok, true);
	assert.deepEqual(dms, ['hi, this is a private message']);
	assert.ok(dm.spoken.includes('Ali Veli'));

	const move = await callTool('move_member', { member: 'Ali', channel: 'lounge', come_along: true }, deps);
	assert.equal(move.ok, true);
	assert.deepEqual(moved, ['lounge'], 'the person must be moved to the lounge');
	assert.deepEqual(joined, ['lounge'], 'the bot must come along');
	assert.equal(move.data.came_along, true);

	const missing = await callTool('send_dm', { to: 'No Such Person', text: 'x' }, deps);
	assert.equal(missing.ok, false);

	// A relative "below" target fails when there is no channel below (they are in the bottom one)
	const noNeighbor = await callTool('move_member', { member: 'Ali', channel: 'below' }, deps);
	assert.equal(noNeighbor.ok, false);
	assert.ok(noNeighbor.spoken.includes('below theirs'), `unexpected message: ${noNeighbor.spoken}`);

	// Somebody who is not in a voice channel cannot be moved
	const idle = { id: '3', displayName: 'Idle Person', user: { username: 'idle', bot: false }, voice: { channel: null } };
	guild.members.cache.set('3', idle);
	const notInVoice = await callTool('move_member', { member: 'Idle', channel: 'General' }, deps);
	assert.equal(notInVoice.ok, false);
	assert.ok(notInVoice.spoken.includes('not in a voice channel'), notInVoice.spoken);
});
check('pickRelativeVoiceChannel: picks the neighbour below or above', () => {
	const voice = (id, name, rawPosition, parentId = 'cat') => ({ id, name, type: ChannelType.GuildVoice, rawPosition, parentId });
	const guild = {
		channels: {
			cache: new Map([
				['a', voice('a', 'A', 1)],
				['b', voice('b', 'B', 2)],
				['c', voice('c', 'C', 3)],
				['t', { id: 't', name: 'text-room', type: ChannelType.GuildText, rawPosition: 4, parentId: 'cat' }],
			]),
		},
	};
	const cache = guild.channels.cache;
	assert.equal(pickRelativeVoiceChannel(guild, cache.get('a'), 'down').id, 'b');
	assert.equal(pickRelativeVoiceChannel(guild, cache.get('b'), 'up').id, 'a');
	assert.equal(pickRelativeVoiceChannel(guild, cache.get('c'), 'down'), null);
});

await checkAsync('send_dm: finds the member by account name as well as by server nickname', async () => {
	const fixture = makeToolDeps();
	const { deps } = fixture;
	// A DM to somebody other than the person asking is the owner's to ask for.
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	const dms = [];
	fixture.guild.members.cache.get('5').send = async (payload) => {
		dms.push(payload.content);
		return { id: 'dm5' };
	};

	// By the server profile name
	const byDisplay = await callTool('send_dm', { to: 'Görkem', text: 'one' }, deps);
	assert.equal(byDisplay.ok, true, 'the server profile name must resolve');
	// By the account name (username)
	const byAccount = await callTool('send_dm', { to: 'gorko123', text: 'two' }, deps);
	assert.equal(byAccount.ok, true, 'the account name must resolve');
	assert.deepEqual(dms, ['one', 'two']);
});

check('memberNames + nameScore: account name, display name and nickname together', () => {
	const member = {
		displayName: 'Görkem',
		nickname: 'Görkem',
		user: { username: 'gorko123', globalName: 'Görkem A' },
	};
	const names = memberNames(member);
	assert.ok(names.includes('gorko123'), 'account name');
	assert.ok(names.includes('gorkem a'), 'account display name');
	assert.ok(names.includes('gorkem'), 'server nickname');
	assert.equal(nameScore(names, 'gorko123'), 3, 'exact match');
	assert.equal(nameScore(names, 'gork'), 2, 'prefix match');
	assert.equal(nameScore(names, 'orko'), 1, 'substring match');
	assert.equal(nameScore(names, 'absent'), 0);
	assert.equal(nameScore(memberNames({ user: {} }), 'x'), 0);
});

// The garbled Turkish name is a deliberate fixture: it is what speech-to-text produces for "peche".
await checkAsync('name similarity: "peçeye" resolves to "peche", and the person in the room wins', async () => {
	const fixture = makeToolDeps();
	const { deps, guild } = fixture;
	const moved = [];
	const room = { id: 'v1', name: 'General', type: ChannelType.GuildVoice, rawPosition: 1, parentId: 'cat', members: new Map() };
	const below = { id: 'v2', name: 'lounge', type: ChannelType.GuildVoice, rawPosition: 2, parentId: 'cat', members: new Map() };
	guild.channels.cache.set('v1', room);
	guild.channels.cache.set('v2', below);

	const makeHuman = (id, display, username, channel) => ({
		id,
		displayName: display,
		user: { username, bot: false },
		voice: {
			channel,
			channelId: channel?.id ?? null,
			setChannel: async (target) => {
				moved.push(`${display}->${target.name}`);
			},
		},
	});
	const inRoom = makeHuman('7', 'peche', 'peche', room);
	const elsewhere = makeHuman('8', 'Peçeli', 'peceli', null);
	guild.members.cache.set('7', inRoom);
	guild.members.cache.set('8', elsewhere);
	guild.voiceStates.cache.set('7', { id: '7', channelId: 'v1', member: inRoom });
	deps.currentVoiceChannel = () => room;
	deps.joinVoice = async () => {};

	assert.ok(similarity('peceye', 'peche') >= fuzzyThreshold('peceye'), 'the similarity threshold must be met');
	assert.ok(similarity('peceye', 'peche') < 1, 'it is not an exact match');
	assert.ok(similarity('tamamen', 'farkli') < fuzzyThreshold('tamamen'), 'an unrelated name must not match');

	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	const result = await callTool('move_member', { member: 'peçeye', channel: 'lounge' }, deps);
	assert.equal(result.ok, true, result.spoken);
	assert.deepEqual(moved, ['peche->lounge'], 'the similar person already in the room must be picked');
	assert.ok(result.spoken.includes('peche'));
});

console.log('ADMIN TOOLS');
check('tool schemas: every argument the handler reads is declared in the schema', () => {
	// If a handler reads a field such as args.confirm without declaring it, the model can never send
	// it and the tool turns into one that "asks a question and then locks up"; the tests call callTool
	// directly, so they cannot catch that class of bug. We read the handler sources and compare.
	const dir = fileURLToPath(new URL('../src/tools/', import.meta.url));
	const bodies = new Map();
	for (const file of readdirSync(dir).filter((name) => name.endsWith('.js'))) {
		const source = readFileSync(path.join(dir, file), 'utf8');
		// Every tool is one defineTool({ ... }) block; the block is the handler body plus its schema.
		for (const chunk of source.split('defineTool({').slice(1)) {
			const name = chunk.match(/^\s*name:\s*'([a-z_]+)'/m)?.[1];
			if (name) bodies.set(name, chunk);
		}
	}
	const missing = [];
	const unscanned = [];
	for (const tool of toolDefinitions()) {
		const body = bodies.get(tool.name);
		if (!body) {
			unscanned.push(tool.name);
			continue;
		}
		const declared = new Set(Object.keys(tool.parameters?.properties ?? {}));
		for (const match of body.matchAll(/args\.([a-z_][a-z0-9_]*)/gi)) {
			if (!declared.has(match[1])) missing.push(`${tool.name}.${match[1]}`);
		}
	}
	assert.deepEqual(unscanned, [], `no handler source found for: ${unscanned.join(', ')}`);
	assert.deepEqual(missing, [], `arguments missing from the schema: ${missing.join(', ')}`);
});
await checkAsync('admin: channel create/edit/lock/delete, role create/edit/delete, nickname, voice, invite, audit log', async () => {
	const { deps, guild } = makeToolDeps();
	const actions = [];
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	deps.ownerTextTail = () => 'open a channel and give a role';

	// Server/member information: no owner gate (anybody may ask)
	guild.name = 'Test Server';
	guild.memberCount = 42;
	guild.premiumSubscriptionCount = 3;
	guild.createdAt = new Date('2020-01-02');
	guild.ownerId = 'owner1';
	const info = await callTool('server_info', {}, deps);
	assert.equal(info.ok, true, info.spoken);
	assert.ok(info.spoken.includes('42 members'), info.spoken);

	const userInfo = await callTool('user_info', { member: 'Ali' }, deps);
	assert.equal(userInfo.ok, true, userInfo.spoken);
	assert.ok(userInfo.spoken.includes('Ali Veli'), userInfo.spoken);

	// Creating a channel: the kind is mapped through
	guild.channels.create = async (payload) => {
		actions.push(`create-channel:${payload.type}:${payload.name}`);
		return { id: 'c9', name: payload.name };
	};
	const created = await callTool('create_channel', { name: 'gaming', type: 'voice' }, deps);
	assert.equal(created.ok, true, created.spoken);
	assert.deepEqual(actions, [`create-channel:${ChannelType.GuildVoice}:gaming`], 'it must be created as a voice channel');

	// Editing / locking / deleting a channel
	let edited = null;
	let deleted = null;
	guild.channels.cache.set('c1', {
		id: 'c1',
		name: 'general-test',
		type: ChannelType.GuildText,
		edit: async (patch) => {
			edited = patch;
		},
		delete: async (reason) => {
			deleted = reason;
		},
		permissionOverwrites: {
			edit: async (target, patch) => actions.push(`lock:${target.id}:${patch.SendMessages}`),
			delete: async (target) => actions.push(`unlock:${target.id}`),
		},
	});
	guild.roles.everyone = { id: 'everyone' };
	const edit = await callTool('edit_channel', { channel: 'general-test', slowmode_seconds: 30, name: 'general-test2' }, deps);
	assert.equal(edit.ok, true, edit.spoken);
	assert.equal(edited.rateLimitPerUser, 30, 'slow mode must be applied');
	assert.equal(edited.name, 'general-test2');

	assert.equal((await callTool('lock_channel', { channel: 'general-test' }, deps)).ok, true);
	assert.ok(actions.includes('lock:everyone:false'), actions.join(' | '));
	assert.equal((await callTool('lock_channel', { channel: 'general-test', locked: false }, deps)).ok, true);
	assert.ok(actions.includes('lock:everyone:null'), `unlocking must neutralise SendMessages, not drop the overwrite: ${actions.join(' | ')}`);
	assert.ok(!actions.includes('unlock:everyone'), 'the overwrite must not be deleted outright (that would expose a hidden channel)');

	// Roles: create (colour name), edit (hex), delete
	guild.roles.create = async (payload) => {
		actions.push(`create-role:${payload.name}:${payload.color}`);
		return { id: 'r9', name: payload.name };
	};
	const roleCreated = await callTool('create_role', { name: 'Mod', color: 'red', mentionable: true }, deps);
	assert.equal(roleCreated.ok, true, roleCreated.spoken);
	assert.ok(actions.includes('create-role:Mod:15548997'), actions.join(' | '));

	guild.roles.cache.set('r5', {
		id: 'r5',
		name: 'Sample',
		editable: true,
		managed: false,
		position: 1,
		edit: async (patch) => actions.push(`edit-role:${patch.color}`),
		delete: async () => actions.push('delete-role'),
	});
	assert.equal((await callTool('edit_role', { role: 'Sample', color: '#ff8800' }, deps)).ok, true);
	assert.ok(actions.includes('edit-role:16746496'), actions.join(' | '));

	// Two-step confirmation: a channel is never deleted without one
	guild.channels.cache.set('c2', {
		id: 'c2',
		name: 'second-channel',
		type: ChannelType.GuildText,
		delete: async () => actions.push('delete:c2'),
	});
	const asked = await callTool('delete_channel', { channel: 'general-test' }, deps);
	assert.equal(asked.ok, false, 'the first call must only ask');
	assert.equal(asked.needs_confirmation, true, asked.spoken);
	assert.equal(deleted, null, 'nothing may be deleted without a confirmation');

	// Confirming a DIFFERENT target does nothing (a garbled transcript can change the name)
	const wrongTarget = await callTool('delete_channel', { channel: 'second-channel', confirm: true }, deps);
	assert.equal(wrongTarget.ok, false, wrongTarget.spoken);
	assert.equal(deleted, null, 'general-test must not be deleted');
	assert.ok(!actions.includes('delete:c2'), 'the wrong target must not be deleted either');

	// Right target + confirm -> deletes (it asks again first, because the wrong attempt consumed the confirmation)
	assert.equal((await callTool('delete_channel', { channel: 'general-test', confirm: true }, deps)).ok, false);
	assert.equal((await callTool('delete_channel', { channel: 'general-test' }, deps)).needs_confirmation, true);
	const confirmedDelete = await callTool('delete_channel', { channel: 'general-test', confirm: true, reason: 'test' }, deps);
	assert.equal(confirmedDelete.ok, true, confirmedDelete.spoken);
	assert.equal(deleted, 'test');

	// An expired confirmation does not act. Pending questions live in a per-guild store of their own (they
	// have to outlive the per-call deps object), so the test injects one to age it by hand.
	deps.pendingConfirmations = new Map();
	assert.equal((await callTool('delete_role', { role: 'Sample' }, deps)).needs_confirmation, true);
	deps.pendingConfirmations.set('delete_role', { target: 'r5', at: Date.now() - 120_000 });
	const expired = await callTool('delete_role', { role: 'Sample', confirm: true }, deps);
	assert.equal(expired.ok, false, 'an expired confirmation does not delete anything');
	// ...and it asks again rather than refusing for ever. Seen live: the owner confirmed a channel
	// deletion four times and every attempt came back "I could not match that", because the record was
	// thrown away on each refusal and the model kept sending the confirmation it had been given.
	assert.equal(expired.needs_confirmation, true, 'the question is put again, so there is a way forward');
	const second = await callTool('delete_role', { role: 'Sample', confirm: true }, deps);
	assert.equal(second.ok, true, `and answering the new question works: ${second.spoken}`);
	assert.equal((await callTool('delete_role', { role: 'Sample' }, deps)).needs_confirmation, true);
	assert.equal((await callTool('delete_role', { role: 'Sample', confirm: true }, deps)).ok, true);
	assert.ok(actions.includes('delete-role'), actions.join(' | '));

	// Nickname: set and reset
	const human = guild.members.cache.get('1');
	human.setNickname = async (value) => actions.push(`nick:${value}`);
	assert.equal((await callTool('set_nickname', { member: 'Ali', nickname: 'Ali Baba' }, deps)).ok, true);
	assert.equal((await callTool('set_nickname', { member: 'Ali' }, deps)).ok, true);
	assert.ok(actions.includes('nick:Ali Baba') && actions.includes('nick:null'), actions.join(' | '));

	// Voice mute: refused when the member is not in a voice channel
	const noVoice = await callTool('voice_mute', { member: 'Ali' }, deps);
	assert.equal(noVoice.ok, false, noVoice.spoken);
	human.voice = {
		channelId: 'v1', // in discord.js a VoiceState always exists; being in a channel shows up as channelId
		setMute: async (value) => actions.push(`mute:${value}`),
		setDeafen: async () => {},
	};
	assert.equal((await callTool('voice_mute', { member: 'Ali' }, deps)).ok, true);
	assert.ok(actions.includes('mute:true'), actions.join(' | '));

	// Lifting a timeout
	human.timeout = async (value) => actions.push(`timeout:${value}`);
	assert.equal((await callTool('untimeout_member', { member: 'Ali' }, deps)).ok, true);
	assert.ok(actions.includes('timeout:null'), actions.join(' | '));

	// Invite link
	guild.channels.cache.get('10').createInvite = async () => ({ code: 'abc', url: 'https://discord.gg/abc' });
	const invite = await callTool('create_invite', { channel: 'general' }, deps);
	assert.equal(invite.ok, true, invite.spoken);
	assert.ok(invite.spoken.includes('discord.gg/abc'), invite.spoken);

	// Audit log
	guild.fetchAuditLogs = async () => ({
		entries: new Map([
			[
				'e1',
				{
					action: AuditLogEvent.MemberMove,
					executor: { username: 'moduser' },
					target: { username: 'someone' },
					createdTimestamp: Date.now(),
				},
			],
		]),
	});
	const logs = await callTool('audit_log', { limit: 5 }, deps);
	assert.equal(logs.ok, true, logs.spoken);
	assert.ok(logs.spoken.includes('moduser'), logs.spoken);
	assert.ok(logs.spoken.includes('voice channel move'), `the action must be readable: ${logs.spoken}`);

	// While the owner is not speaking, no destructive action may run
	deps.isOwnerActive = () => false;
	const denied = await callTool('delete_channel', { channel: 'general-test' }, deps);
	assert.equal(denied.ok, false, denied.spoken);
	assert.ok(denied.spoken.includes('Only the bot owner'), denied.spoken);
});

await checkAsync('moderation tools: refused without the owner, applied with them', async () => {
	const fixture = makeToolDeps();
	const { deps, guild } = fixture;
	const actions = [];
	const human = {
		id: '1',
		displayName: 'Ali Veli',
		user: { username: 'ali', bot: false },
		moderatable: true,
		manageable: true,
		bannable: true,
		timeout: async (ms, reason) => actions.push(`timeout:${ms}:${reason}`),
		roles: {
			add: async (role) => actions.push(`add:${role.name}`),
			remove: async (role) => actions.push(`remove:${role.name}`),
		},
	};
	guild.members.cache.set('1', human);
	guild.roles.cache.set('r1', { id: 'r1', name: 'Moderator', editable: true, managed: false, position: 1 });
	guild.members.ban = async (member, options) => actions.push(`ban:${member.displayName}:${options.reason}`);

	// While the owner is not speaking, moderation commands are refused
	deps.isOwnerActive = () => false;
	const denied = await callTool('timeout_member', { member: 'Ali', minutes: 5 }, deps);
	assert.equal(denied.ok, false);
	assert.ok(denied.spoken.includes('Only the bot owner'), denied.spoken);
	assert.equal(actions.length, 0);

	// The owner spoke but did NOT say the ban word -> refused (nobody else's words may ban)
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => false;
	const notSaid = await callTool('ban_member', { member: 'Ali' }, deps);
	assert.equal(notSaid.ok, false);
	assert.ok(notSaid.spoken.includes('could not be sure the owner'), notSaid.spoken);
	assert.equal(actions.length, 0, 'nothing may happen unless the owner said it');

	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	deps.ownerTextTail = () => 'melis ban garko';
	const gateLogs = [];
	deps.log = (line) => gateLogs.push(line);
	const timeout = await callTool('timeout_member', { member: 'Ali', minutes: 5, reason: 'spam' }, deps);
	assert.equal(timeout.ok, true, timeout.spoken);
	assert.ok(
		gateLogs.some((line) => line.includes('[gate] timeout_member') && line.includes('"timeout"')),
		`the evidence for allowing it must be logged: ${gateLogs.join(' | ')}`,
	);
	assert.deepEqual(actions, ['timeout:300000:spam']);

	assert.equal((await callTool('grant_role', { member: 'Ali', role: 'Moderator' }, deps)).ok, true);
	assert.equal((await callTool('revoke_role', { member: 'Ali', role: 'Moderator' }, deps)).ok, true);
	// Banning and kicking always name the target and wait for the answer, however exact the name was.
	const banAsk = await callTool('ban_member', { member: 'Ali', reason: 'test' }, deps);
	assert.equal(banAsk.needs_confirmation, true, banAsk.spoken);
	assert.ok(banAsk.spoken.includes('Ali Veli'), banAsk.spoken);
	assert.ok(!actions.some((entry) => entry.startsWith('ban:')), 'nothing is banned before the answer');
	assert.equal((await callTool('ban_member', { member: 'Ali', reason: 'test', confirm: true }, deps)).ok, true);
	human.kick = async (reason) => actions.push(`kick:${reason}`);
	assert.equal((await callTool('kick_member', { member: 'Ali', reason: 'behaviour' }, deps)).needs_confirmation, true);
	assert.equal((await callTool('kick_member', { member: 'Ali', reason: 'behaviour', confirm: true }, deps)).ok, true);
	assert.equal(actions.at(-1), 'kick:behaviour');
	assert.deepEqual(actions.slice(0, 4), ['timeout:300000:spam', 'add:Moderator', 'remove:Moderator', 'ban:Ali Veli:test']);

	// Ban list + lifting a ban
	guild.bans = {
		fetch: async () => new Map([['u1', { user: { id: 'u1', username: 'baduser' } }]]),
		remove: async (id) => actions.push(`unban:${id}`),
	};
	const banList = await callTool('list_bans', {}, deps);
	assert.equal(banList.ok, true, banList.spoken);
	assert.ok(banList.spoken.includes('baduser'), banList.spoken);
	const unban = await callTool('unban_member', { user: 'bad user' }, deps);
	assert.equal(unban.ok, true, unban.spoken);
	assert.equal(actions.at(-1), 'unban:u1');

	// Changing a setting and the voice
	deps.applySetting = (name) => (name === 'transcripts' ? true : null);
	deps.settingNames = () => ['transcripts'];
	assert.equal((await callTool('set_setting', { name: 'nosuch', value: '1' }, deps)).ok, false);
	assert.equal((await callTool('set_setting', { name: 'transcripts', value: '1' }, deps)).ok, true);

	let refreshed = null;
	const voiceDeps = {
		...deps,
		store: { ...deps.store, getActive: () => ({ id: 'c1', name: 'Melis' }), update: async (id, patch) => actions.push(`voice:${patch.voice}`) },
		refreshPersona: async (reason) => {
			refreshed = reason;
		},
	};
	assert.equal((await callTool('set_voice', { voice: 'quartz' }, voiceDeps)).ok, true);
	assert.equal(actions.at(-1), 'voice:quartz');
	assert.ok(refreshed?.includes('quartz'));
	assert.equal((await callTool('set_voice', { voice: 'nosuchvoice' }, voiceDeps)).ok, false);
});

await checkAsync('message management: deletes/edits its own messages, somebody else\'s only for the owner', async () => {
	const fixture = makeToolDeps();
	const { deps } = fixture;
	const deleted = [];
	const edited = [];
	const makeMessage = (id, authorId, content) => ({
		id,
		createdTimestamp: Number(id),
		content,
		author: { id: authorId, bot: authorId === 'self' },
		delete: async () => {
			deleted.push(id);
		},
		edit: async (payload) => {
			edited.push({ id, content: payload.content });
			return { id };
		},
	});
	const messages = new Map([
		['1', makeMessage('1', 'other', "somebody else's message")],
		['2', makeMessage('2', 'self', 'my own message')],
		['3', makeMessage('3', 'other', 'last message')],
	]);
	// the fixture uses its own message map; inject a fresh one
	fixture.deps.guild.channels.cache.get('10').messages.fetch = async (options = {}) => {
		if (typeof options === 'string') {
			const found = messages.get(options);
			return new Map(found ? [[options, found]] : []);
		}
		const { limit = 5 } = options;
		const all = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
		return new Map(all.slice(-limit).map((m) => [m.id, m]));
	};
	deps.selfId = 'self';
	deps.cfg.textChannelId = '10';
	deps.isOwnerActive = () => false;

	// Even the bot's own posts need the owner: one of them may be an announcement the owner had it make
	const ownRefused = await callTool('delete_messages', { own: true, count: 1 }, deps);
	assert.equal(ownRefused.ok, false);
	assert.ok(ownRefused.spoken.includes('Only the bot owner'), ownRefused.spoken);
	assert.deepEqual(deleted, [], 'nothing is deleted without the owner');

	// Deleting somebody else's message needs the owner
	const denied = await callTool('delete_messages', { count: 1 }, deps);
	assert.equal(denied.ok, false);
	assert.ok(denied.spoken.includes('Only the bot owner'), denied.spoken);

	deps.isOwnerActive = () => true;
	const own = await callTool('delete_messages', { own: true, count: 1 }, deps);
	assert.equal(own.ok, true, own.spoken);
	assert.deepEqual(deleted, ['2'], "only the bot's own message may be deleted");

	const removed = await callTool('delete_messages', { count: 1 }, deps);
	assert.equal(removed.ok, true, removed.spoken);
	assert.deepEqual(deleted, ['2', '3'], "with the owner asking, somebody else's last message is deleted");

	// Editing its own message
	messages.set('4', makeMessage('4', 'self', 'old text'));
	const edit = await callTool('edit_message', { channel: 'general', text: 'new text' }, deps);
	assert.equal(edit.ok, true, edit.spoken);
	assert.deepEqual(edited, [{ id: '4', content: 'new text' }]);

	// Trying to edit somebody else's message is refused
	const foreign = await callTool('edit_message', { channel: 'general', message_id: '1', text: 'nope' }, deps);
	assert.equal(foreign.ok, false);
	assert.ok(foreign.spoken.includes('only edit my own'), foreign.spoken);
});

// The decorated and Turkish-suffixed names below are deliberate fixtures for the normaliser.
check('normalize: reduces decorated role names to plain letters', () => {
	assert.equal(normalize('ᴄʜɪʟʟ'), 'chill', 'small caps');
	assert.equal(normalize('𝓒𝓱𝓲𝓵𝓵'), 'chill', 'mathematical script');
	assert.equal(normalize('Ｃｈｉｌｌ'), 'chill', 'full width');
	assert.equal(normalize('・Chill・'), 'chill', 'decorative marks');
	assert.equal(normalize('İÇĞÜŞÖ'), 'icguso', 'Turkish letters');
	// Case suffixes are dropped (a voice command says things like "message X" with a suffix on the name)
	assert.equal(normalize("şerefsiz'e"), 'serefsiz', 'name with a suffix');
	assert.equal(normalize("Serefsiz'e mesaj gönder"), 'serefsiz mesaj gonder');
	assert.equal(normalize("Hasan Sangül'ento"), 'hasan sangul', 'garbled suffix');
	assert.equal(normalize("Ali'ye"), 'ali');
});

await checkAsync('member_roles + role matching: finds a role from a decorated or garbled name', async () => {
	const fixture = makeToolDeps();
	const { deps, guild } = fixture;
	const granted = [];
	const member = {
		id: '1',
		displayName: 'Naci',
		user: { username: 'naci', bot: false },
		moderatable: true,
		manageable: true,
		roles: {
			cache: new Map([
				['r1', { id: 'r1', name: 'Chill', position: 3 }],
				['r2', { id: 'r2', name: 'Member', position: 1 }],
			]),
			add: async (role) => granted.push(role.name),
			remove: async () => {},
		},
	};
	guild.members.cache.set('1', member);
	guild.roles.cache.set('r1', { id: 'r1', name: 'ᴄʜɪʟʟ', editable: true, managed: false, position: 3 });

	const roles = await callTool('member_roles', { member: 'Naci' }, deps);
	assert.equal(roles.ok, true, roles.spoken);
	assert.deepEqual(roles.data.roles, ['Chill', 'Member'], 'the higher role comes first');
	assert.ok(roles.spoken.includes('Chill'));

	deps.isOwnerActive = () => true;
	// "chillz" is only close to the role's name, so the role that was found is named and waits for a yes.
	const asked = await callTool('grant_role', { member: 'Naci', role: 'chillz' }, deps);
	assert.equal(asked.needs_confirmation, true, asked.spoken);
	assert.ok(asked.spoken.includes('ᴄʜɪʟʟ'), asked.spoken);
	assert.deepEqual(granted, [], 'nothing is granted before the answer');
	const grant = await callTool('grant_role', { member: 'Naci', role: 'chillz', confirm: true }, deps);
	assert.equal(grant.ok, true, grant.spoken);
	assert.deepEqual(granted, ['ᴄʜɪʟʟ'], 'the role with the decorated name must be found and granted');
});

await checkAsync('member_activity: reads Spotify/game/status, and says so when presence is off', async () => {
	const fixture = makeToolDeps();
	const { deps } = fixture;
	const member = {
		id: '1',
		displayName: 'Naci',
		user: { username: 'naci', bot: false },
		presence: { activities: [{ name: 'Spotify', type: 2, details: 'Insomnia', state: 'Faithless' }] },
	};
	fixture.guild.members.cache.set('1', member);
	deps.presenceEnabled = true;

	const listening = await callTool('member_activity', { member: 'Naci' }, deps);
	assert.equal(listening.ok, true, listening.spoken);
	assert.equal(listening.data.kind, 'listening');
	assert.equal(listening.data.track, 'Insomnia');
	assert.equal(listening.data.artist, 'Faithless');
	assert.ok(listening.spoken.includes('Spotify'), listening.spoken);

	member.presence = { activities: [{ name: 'Counter-Strike 2', type: 0 }] };
	assert.equal((await callTool('member_activity', { member: 'Naci' }, deps)).data.kind, 'playing');

	member.presence = { activities: [{ type: 4, state: 'writing code' }] };
	assert.equal((await callTool('member_activity', { member: 'Naci' }, deps)).data.kind, 'status');

	member.presence = { activities: [] };
	assert.equal((await callTool('member_activity', { member: 'Naci' }, deps)).data.kind, null);

	deps.presenceEnabled = false;
	const off = await callTool('member_activity', { member: 'Naci' }, deps);
	assert.equal(off.ok, false);
	assert.ok(off.spoken.includes('PRESENCE'), off.spoken);
});

check('SpeakerAttribution: the gate opens while the owner speaks and closes when somebody else does', () => {
	let now = 1000;
	const attribution = new SpeakerAttribution({ windowMs: 5000, now: () => now });

	// The owner is speaking (priority frames)
	attribution.onFrame({ priority: true, active: ['owner'] });
	assert.equal(attribution.isOwnerActive(), true);

	// The owner stopped and somebody else spoke -> the gate closes
	attribution.onFrame({ priority: false, active: ['other'] });
	assert.equal(attribution.isOwnerActive(), false, 'the gate must close when somebody else speaks');

	// It opens again when the owner speaks again
	attribution.onFrame({ priority: true, active: ['owner'] });
	assert.equal(attribution.isOwnerActive(), true);

	// Time-out
	now += 6000;
	assert.equal(attribution.isOwnerActive(), false, 'it must close after long enough');

	// Silence does not close the gate (as long as nobody else spoke)
	now = 1000 + 1000;
	attribution.onFrame({ priority: true, active: ['owner'] });
	assert.equal(attribution.isOwnerActive(), true);
	attribution.onFrame({ priority: false, active: [] });
	assert.equal(attribution.isOwnerActive(), true, 'silence must not close the gate');
});

check('SpeakerAttribution: transcript attribution — "did the owner say this?"', () => {
	let now = 0;
	const attribution = new SpeakerAttribution({ now: () => now });

	// A transcript that arrives while somebody else is speaking is not credited to the owner
	attribution.onFrame({ priority: false, active: ['other'] });
	now += 100;
	attribution.noteTranscript('melis ban that guy');
	assert.equal(attribution.ownerSaidRecently(['ban']), false, "somebody else's words must not be credited to the owner");

	// A transcript that arrives while the owner is speaking is credited to the owner
	now += 100;
	attribution.onFrame({ priority: true, active: ['owner'] });
	attribution.noteTranscript('melis ban garko');
	assert.equal(attribution.ownerSaidRecently(['ban']), true, "the owner's words must be recognised");
	assert.equal(attribution.ownerSaidRecently(['timeout']), false, 'a word that was not said must not match');

	// An old utterance times out
	now += 16_000;
	assert.equal(attribution.ownerSaidRecently(['ban']), false, 'an old utterance must stop counting');
});

check('SpeakerAttribution: a LATE transcript is attributed by its audio position', () => {
	let now = 0;
	const attribution = new SpeakerAttribution({ ownerId: 'owner', now: () => now });

	// 0-400 ms: the owner spoke; 400-800 ms: somebody else spoke
	for (let i = 0; i < 20; i++) attribution.onFrame({ priority: true, active: ['owner'] });
	for (let i = 0; i < 20; i++) attribution.onFrame({ priority: false, active: ['other'] });

	// The transcript arrives 5 s late and SOMEBODY ELSE is speaking by then: it must still go to the owner
	now = 5000;
	attribution.onFrame({ priority: false, active: ['other'] });
	attribution.noteTranscript('melis ban garko', { startMs: 100, endMs: 400 });
	assert.equal(attribution.ownerSaidRecently(['ban']), true, 'a late transcript must still be credited to the owner');

	// A transcript whose audio position falls where somebody else spoke is not credited to the owner
	const other = new SpeakerAttribution({ ownerId: 'owner', now: () => now });
	for (let i = 0; i < 20; i++) other.onFrame({ priority: false, active: ['other'] });
	other.noteTranscript('melis ban that guy', { startMs: 0, endMs: 400 });
	assert.equal(other.ownerSaidRecently(['ban']), false, "somebody else's words must not be credited to the owner");

	// With no audio position, the arrival time is used instead (the fallback path)
	const noOffset = new SpeakerAttribution({ now: () => now });
	noOffset.onFrame({ priority: true, active: ['owner'] });
	noOffset.noteTranscript('melis ban them');
	assert.equal(noOffset.ownerSaidRecently(['ban']), true, 'with no position the arrival time must be used');
});

await checkAsync('END TO END: real audio -> transcript attribution -> ban allowed/refused', async () => {
	const { deps, guild } = makeToolDeps();
	const actions = [];
	const OWNER_ID = '999';
	const OTHER_ID = '555';
	guild.members.cache.set('1', {
		id: '1',
		displayName: 'Ali',
		user: { username: 'ali', bot: false },
		bannable: true,
	});
	guild.members.ban = async (member) => actions.push(`ban:${member.displayName}`);

	const loud = new Int16Array(SAMPLES_PER_FRAME_24K).fill(4000);
	const attribution = new SpeakerAttribution({ ownerId: OWNER_ID });
	const mixer = new SpeakerMixer({ activityPeak: 1 });
	mixer.addUser(OWNER_ID);
	mixer.addUser(OTHER_ID);
	mixer.setPriority(OWNER_ID);
	const bridge = new AudioBridge({
		mixer,
		playback: new PlaybackQueue(),
		output: { write: () => true, once: () => {} },
		getLive: () => ({ ready: true, sendAudio: () => true }),
		onFrame: (frame) => attribution.onFrame(frame),
	});
	deps.isOwnerActive = () => attribution.isOwnerActive();
	deps.ownerSaidRecently = (words, ms) => attribution.ownerSaidRecently(words, ms);

	// 0-600 ms the owner speaks, 600-1200 ms somebody else does
	for (let i = 0; i < 30; i++) {
		mixer.push(OWNER_ID, loud);
		bridge.tick();
	}
	for (let i = 0; i < 30; i++) {
		mixer.push(OTHER_ID, loud);
		bridge.tick();
	}

	// The transcript arrives late: attribution must go by the audio position
	attribution.noteTranscript('melis ban garko', { startMs: 100, endMs: 500 });
	assert.equal(attribution.ownerSaidRecently(['ban']), true, "the owner's words must be credited to the owner");
	assert.equal(attribution.isOwnerActive(), false, 'somebody else spoke last');
	const early = await callTool('ban_member', { member: 'Ali' }, deps);
	assert.equal(early.ok, false, 'the ban must be refused when somebody else spoke last');
	assert.equal(actions.length, 0, 'nothing may happen');

	// The owner gives the command themselves (1200-1600 ms) -> the gate opens
	for (let i = 0; i < 20; i++) {
		mixer.push(OWNER_ID, loud);
		bridge.tick();
	}
	attribution.noteTranscript('okay ban garko', { startMs: 1200, endMs: 1500 });
	assert.equal(attribution.isOwnerActive(), true, 'the owner spoke last');
	// The gate lets it through, and then the tool still names the target and waits for the answer.
	const asked = await callTool('ban_member', { member: 'Ali' }, deps);
	assert.equal(asked.needs_confirmation, true, asked.spoken);
	assert.deepEqual(actions, [], 'the gate opening is not the same as being told to do it');
	const allowed = await callTool('ban_member', { member: 'Ali', confirm: true }, deps);
	assert.equal(allowed.ok, true, allowed.spoken);
	assert.deepEqual(actions, ['ban:Ali']);

	// Somebody else's words are not credited to the owner: same flow, the owner never speaks
	const other = new SpeakerAttribution({ ownerId: OWNER_ID });
	const mixer2 = new SpeakerMixer({ activityPeak: 1 });
	mixer2.addUser(OTHER_ID);
	mixer2.setPriority(OWNER_ID);
	const bridge2 = new AudioBridge({
		mixer: mixer2,
		playback: new PlaybackQueue(),
		output: { write: () => true, once: () => {} },
		getLive: () => ({ ready: true, sendAudio: () => true }),
		onFrame: (frame) => other.onFrame(frame),
	});
	for (let i = 0; i < 30; i++) {
		mixer2.push(OTHER_ID, loud);
		bridge2.tick();
	}
	other.noteTranscript('melis ban that guy', { startMs: 100, endMs: 500 });
	deps.isOwnerActive = () => other.isOwnerActive();
	deps.ownerSaidRecently = (words, ms) => other.ownerSaidRecently(words, ms);
	const denied = await callTool('ban_member', { member: 'Ali' }, deps);
	assert.equal(denied.ok, false, "somebody else's words must not trigger a ban");
	assert.deepEqual(actions, ['ban:Ali'], 'nothing further may happen after the refusal');
});

// The whole point of the change, at the level the owner actually feels it: a ban asked for while
// somebody is talking over the owner does not happen. The model is sent the SUM of the two voices, so
// nothing downstream can say whose word "ban" was -- and this gate runs bans, kicks and deletions.
await checkAsync('END TO END: a ban is refused when somebody talks over the owner, and allowed when nobody does', async () => {
	const actions = [];
	const OWNER_ID = '999';
	const OTHER_ID = '555';
	const { deps, guild } = makeToolDeps();
	guild.members.cache.set('1', { id: '1', displayName: 'Ali', user: { username: 'ali', bot: false }, bannable: true });
	guild.members.ban = async (member) => actions.push(`ban:${member.displayName}`);
	const loud = new Int16Array(SAMPLES_PER_FRAME_24K).fill(4000);

	const run = ({ priority }) => {
		const attribution = new SpeakerAttribution({ ownerId: OWNER_ID });
		const mixer = new SpeakerMixer({ activityPeak: 1 });
		mixer.addUser(OWNER_ID);
		mixer.addUser(OTHER_ID);
		if (priority) mixer.setPriority(OWNER_ID);
		const bridge = new AudioBridge({
			mixer,
			playback: new PlaybackQueue(),
			output: { write: () => true, once: () => {} },
			getLive: () => ({ ready: true, sendAudio: () => true }),
			onFrame: (frame) => attribution.onFrame(frame),
		});
		// Both of them transmitting for the whole second.
		for (let i = 0; i < 50; i++) {
			mixer.push(OWNER_ID, loud);
			mixer.push(OTHER_ID, loud);
			bridge.tick();
		}
		attribution.noteTranscript('ban Ali', { startMs: 0, endMs: 1000 });
		attribution.markTurn();
		deps.commandSpeaker = (words, options) => attribution.commandSpeaker(words, options);
		deps.lastUtterance = (options) => attribution.lastUtterance(options);
		deps.transcriptLagging = (options) => attribution.transcriptLagging(options);
		deps.isOwnerActive = () => attribution.isOwnerActive();
		deps.ownerSaidRecently = (words, ms) => attribution.ownerSaidRecently(words, ms);
		return attribution;
	};

	// Priority off: the guest's voice really is in the frame the model transcribed.
	run({ priority: false });
	const refused = await callTool('ban_member', { member: 'Ali', confirm: true }, deps);
	assert.equal(refused.ok, false, 'an overlap must never open the gate');
	assert.deepEqual(actions, [], 'and nothing may happen');
	assert.match(String(refused.reason ?? refused.spoken ?? ''), /over|üst/i, 'the refusal says it was an overlap');

	// Priority on (the default): the mixer physically discarded the guest's audio before summing the
	// frame, so the model only ever heard the owner. Tightened where it was wrong, untouched where it
	// was right.
	run({ priority: true });
	const asked = await callTool('ban_member', { member: 'Ali' }, deps);
	assert.equal(asked.needs_confirmation, true, asked.spoken);
	const allowed = await callTool('ban_member', { member: 'Ali', confirm: true }, deps);
	assert.equal(allowed.ok, true, allowed.spoken);
	assert.deepEqual(actions, ['ban:Ali']);
});

check('SpeakerAttribution: no run of frames lets a shared stretch of audio open the gate', () => {
	// A property rather than an example: the arithmetic behind `solo` is a union over segments, and the
	// kind of mistake that matters there (counting a shared frame as somebody's own) does not show up in
	// any single hand-written case.
	// The generator has to reach the regime under test. Frames drawn independently almost never leave the
	// owner alone for four fifths of a stretch, so the gate never opened and every assertion below was
	// skipped: the test passed by never testing anything. Here one person holds the floor for a stretch
	// at a time and somebody else only sometimes joins in, which is what a conversation looks like, and
	// the count at the end refuses to let it go quiet again.
	let seed = 987654321;
	const rnd = (n) => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return Math.floor(((seed >>> 16) / 65536) * n);
	};
	const cast = ['owner', 'x', 'y'];
	let opened = 0;
	for (let round = 0; round < 200; round++) {
		const attribution = new SpeakerAttribution({ ownerId: 'owner' });
		let frame = 0;
		while (frame < 60) {
			const holder = cast[rnd(3)];
			const guest = rnd(4) === 0 ? cast[rnd(3)] : null;
			const length = 5 + rnd(20);
			const active = guest && guest !== holder ? [holder, guest] : [holder];
			for (let i = 0; i < length && frame < 60; i++, frame++) attribution.onFrame({ active, sent: true });
		}
		const from = rnd(800);
		const to = from + 100 + rnd(600);
		const share = attribution.speakerShareAt(from, to);
		const owner = share.ranked.find((entry) => entry.id === 'owner');
		if (attribution.speakerAt(from, to) !== true) continue;
		opened++;
		assert.ok(owner, `round ${round}: the gate opened with no owner audio at all`);
		// The gate opened, so the owner was alone for at least 80% of it, which bounds everybody else at
		// 20% by construction. Anyone above that share means the arithmetic is wrong.
		for (const entry of share.ranked) {
			if (entry.id === 'owner') continue;
			assert.ok(entry.share <= 0.2 + 1e-9, `round ${round}: ${entry.id} held ${entry.share} of a stretch the gate opened on`);
		}
	}
	assert.ok(opened > 20, `the gate has to open sometimes or nothing is being tested: it opened ${opened} times in 200 rounds`);
});

check('SpeakerAttribution: a new session resets the audio position (no drift after a reconnect)', () => {
	const attribution = new SpeakerAttribution({ ownerId: 'owner' });
	for (let i = 0; i < 50; i++) attribution.onFrame({ priority: true, active: ['owner'] });
	assert.equal(attribution.audioMs, 1000, 'the audio position must advance');
	attribution.resetSession();
	assert.equal(attribution.audioMs, 0, 'a new session starts the position at zero');
	assert.equal(attribution.track.length, 0, 'the old records must be cleared');
	for (let i = 0; i < 25; i++) attribution.onFrame({ priority: true, active: ['owner'] });
	attribution.noteTranscript('melis ban them', { startMs: 100, endMs: 400 });
	assert.equal(attribution.ownerSaidRecently(['ban']), true, 'the owner must still be recognised in a new session');
});

check('LatencyMeter: P50-P90 for response, delegation and tool latency', () => {
	const meter = new LatencyMeter({ window: 3 });
	assert.equal(meter.assistantAudio(1500), null, 'nothing is measured until the user has spoken');

	meter.userSpeechEnd(2000);
	assert.equal(meter.assistantAudio(2300), 300, 'the user stopped -> first audio out');
	assert.equal(meter.assistantAudio(2400), null, 'the same response is not counted twice');

	meter.userSpeechEnd(3000);
	meter.assistantAudio(4000); // 1000
	meter.userSpeechEnd(5000);
	meter.assistantAudio(7000); // 2000
	meter.userSpeechEnd(8000);
	meter.assistantAudio(9000); // 1000 -> pencere [1000, 1000, 2000]

	const summary = meter.summary();
	assert.equal(summary.count, 3, 'the window keeps the most recent samples');
	assert.equal(summary.responseP50, 1000);
	assert.equal(summary.responseP90, 2000);
	assert.ok(summary.text.includes('P50') && summary.text.includes('P90'), summary.text);

	meter.delegationStart(10_000);
	assert.equal(meter.delegationDone(12_500), 2500);
	assert.equal(meter.delegationDone(13_000), null, 'a single delegation is not closed twice');
	assert.equal(meter.summary().delegationP50, 2500);

	meter.toolDone(400);
	assert.equal(meter.summary().toolP50, 400);
});

await checkAsync('VoiceSession: rejoining the same channel does not tear the connection down', async () => {
	const session = new VoiceSession({
		client: { user: { id: 'bot' } },
		mixer: { addUser() {}, removeUser() {}, setPriority() {} },
		playback: new PlaybackQueue(),
		getLive: () => null,
		log: () => {},
	});
	let joins = 0;
	session._join = async (_guild, channel) => {
		joins++;
		session.connection = { state: { status: 'ready' }, joinConfig: { channelId: channel.id } };
	};

	await session.join({ id: 'g' }, { id: 'c1' });
	await session.join({ id: 'g' }, { id: 'c1' });
	assert.equal(joins, 1, 'no new connection may be opened while one is already up');

	// Two concurrent requests for the same channel collapse into a single join
	let slowJoins = 0;
	const concurrent = new VoiceSession({
		client: { user: { id: 'bot' } },
		mixer: { addUser() {}, removeUser() {}, setPriority() {} },
		playback: new PlaybackQueue(),
		getLive: () => null,
		log: () => {},
	});
	concurrent._join = async (_guild, channel) => {
		slowJoins++;
		await new Promise((r) => setTimeout(r, 50));
		concurrent.connection = { state: { status: 'ready' }, joinConfig: { channelId: channel.id } };
	};
	await Promise.all([concurrent.join({ id: 'g' }, { id: 'c2' }), concurrent.join({ id: 'g' }, { id: 'c2' })]);
	assert.equal(slowJoins, 1, 'concurrent requests must be merged');

	// Moving to a different channel really does open a new connection
	await session.join({ id: 'g' }, { id: 'c3' });
	assert.equal(joins, 2, 'a channel change must open a new connection');
});

await checkAsync('leave_voice: permanent when the owner asks, marked for return when it was kicked out', async () => {
	const { deps } = makeToolDeps();
	const calls = [];
	deps.leaveVoice = (options) => {
		calls.push(options);
	};
	deps.cfg.leaveDelayMs = 5; // keep the wait short in the test
	const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

	deps.isOwnerActive = () => true;
	await callTool('leave_voice', {}, deps);
	await settle();
	assert.deepEqual(calls, [{ permanent: true }], 'it must be permanent when the owner asked for it');

	deps.isOwnerActive = () => false;
	await callTool('leave_voice', {}, deps);
	await settle();
	assert.deepEqual(calls[1], { permanent: false }, 'a return must be planned when it was kicked out');
});

check('stripDictationTail: the quoting tail does not end up in the message', () => {
	assert.equal(stripDictationTail('come to the voice channel say that'), 'come to the voice channel');
	assert.equal(stripDictationTail('come to the voice channel please say that'), 'come to the voice channel');
	assert.equal(stripDictationTail('"hello, how are you?"'), 'hello, how are you?');
	assert.equal(stripDictationTail('say that'), 'say that', 'a very short message is left alone');
	assert.equal(stripDictationTail('write this down in the notebook'), 'write this down in the notebook', 'a verb in the middle is kept');
	assert.equal(stripDictationTail('tell them something nice'), 'tell them something nice', 'a bare "tell" is the message itself');
});

// The Turkish dictation particles come from the Turkish locale, so the parser is switched to it.
check('stripDictationTail (tr): the Turkish "de/diye" tail does not end up in the message', () => {
	setLocale('tr');
	try {
		assert.equal(stripDictationTail('sese gel de'), 'sese gel');
		assert.equal(stripDictationTail('sese gel diye yaz'), 'sese gel');
		assert.equal(stripDictationTail('"selam nasılsın?"'), 'selam nasılsın?');
		assert.equal(stripDictationTail('gel de'), 'gel de', 'a very short message is left alone');
		assert.equal(stripDictationTail('yarın da orada olurum'), 'yarın da orada olurum', 'a conjunction mid-sentence is kept');
		assert.equal(stripDictationTail('bunu gruba yaz'), 'bunu gruba yaz', 'a bare "yaz" is the message itself');
		assert.equal(stripDictationTail('ona bir şey söyle'), 'ona bir şey söyle', 'a bare "söyle" is the message itself');
	} finally {
		setLocale('en');
	}
});

await checkAsync('send_message: the dictation tail is not sent', async () => {
	const { deps, sent } = makeToolDeps();
	await callTool('send_message', { channel: 'general', text: 'come to the voice channel say that' }, deps);
	assert.equal(sent[0].content, 'come to the voice channel', sent[0].content);
});

await checkAsync('send_message (tr): the Turkish "… de" tail is not sent', async () => {
	setLocale('tr');
	try {
		const { deps, sent } = makeToolDeps();
		await callTool('send_message', { channel: 'general', text: 'sese gel de' }, deps);
		assert.equal(sent[0].content, 'sese gel', sent[0].content);
	} finally {
		setLocale('en');
	}
});

await checkAsync('edit_message: with no id, or a deleted one, it edits the bot\'s own last message', async () => {
	const fixture = makeToolDeps();
	const { deps } = fixture;
	deps.selfId = 'bot1'; // the bot's own id (the fixture does not provide it)
	// Editing what the bot posted is the owner's to ask for.
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	const edited = [];
	const others = { id: 'm1', author: { id: '1' }, content: "somebody else's message", createdTimestamp: 100, edit: async () => edited.push('other') };
	const mineOld = { id: 'm2', author: { id: 'bot1' }, content: 'my older message', createdTimestamp: 200, edit: async (payload) => edited.push(payload.content) };
	const mineNew = { id: 'm3', author: { id: 'bot1' }, content: 'greetings from Ankara', createdTimestamp: 300, edit: async (payload) => edited.push(payload.content) };
	const channel = fixture.guild.channels.cache.get('10');
	channel.messages.fetch = async (options = {}) => {
		if (typeof options === 'string') return null; // the id was not found
		return new Map([
			['m1', others],
			['m2', mineOld],
			['m3', mineNew],
		]);
	};

	// No id given -> the bot's OWN most recent message
	const result = await callTool('edit_message', { channel: 'general', text: 'the current wording' }, deps);
	assert.equal(result.ok, true, result.spoken);
	assert.deepEqual(edited, ['the current wording'], edited.join(' | '));
	assert.ok(result.spoken.includes('the current wording'), result.spoken);

	// Picking the message by its content
	edited.length = 0;
	await callTool('edit_message', { channel: 'general', text: 'corrected', contains: 'my older message' }, deps);
	assert.deepEqual(edited, ['corrected']);

	// An id that cannot be found falls back to the own last message (a made-up id must not stall it)
	edited.length = 0;
	const fallback = await callTool('edit_message', { channel: 'general', text: 'corrected again', message_id: 'no-such-id' }, deps);
	assert.equal(fallback.ok, true, fallback.spoken);
	assert.deepEqual(edited, ['corrected again']);
});

await checkAsync('roles: grants a role to itself, and explains managed roles and hierarchy correctly', async () => {
	const { deps, guild } = makeToolDeps();
	const actions = [];
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	deps.ownerTextTail = () => 'give a role';

	guild.members.me = { id: 'bot1', roles: { highest: { id: 'rbot', name: 'Melis', position: 10 } } };
	guild.roles.cache.set('r7', {
		id: 'r7',
		name: 'Chillz',
		position: 5,
		managed: false,
		editable: true,
	});
	// Our own membership: in discord.js "manageable" is always false, yet the role must still be grantable
	const self = {
		id: 'bot1',
		displayName: 'Melis',
		manageable: false,
		user: { username: 'melis', bot: true },
		roles: { add: async (role) => actions.push(`self+${role.name}`), remove: async () => {} },
	};
	guild.members.cache.set('bot1', self);
	deps.memberIndex = null;

	const granted = await callTool('grant_role', { member: 'Melis', role: 'Chillz' }, deps);
	assert.equal(granted.ok, true, granted.spoken);
	assert.deepEqual(actions, ['self+Chillz']);

	// A managed (bot/integration) role: this must not look like a hierarchy error
	guild.roles.cache.set('r8', { id: 'r8', name: 'BOT', position: 3, managed: true, editable: true });
	const managed = await callTool('grant_role', { member: 'Ali', role: 'BOT' }, deps);
	assert.equal(managed.ok, false, managed.spoken);
	assert.ok(managed.spoken.includes('bot/integration role'), managed.spoken);

	// The server owner CAN be given a role too: Discord's rule is about role order, not about who the target is
	const ali = [...guild.members.cache.values()].find((m) => /ali/i.test(m.displayName ?? ''));
	assert.ok(ali, 'the Ali test member must be present');
	guild.ownerId = ali.id;
	const aliRoles = ali.roles;
	ali.manageable = false;
	ali.roles = { add: async (role) => actions.push(`ali+${role.name}`), remove: async () => {} };
	const owner = await callTool('grant_role', { member: 'Ali', role: 'Chillz' }, deps);
	assert.equal(owner.ok, true, owner.spoken);
	assert.ok(actions.includes('ali+Chillz'), 'the owner must get the role');
	ali.roles = aliRoles;
	guild.ownerId = null;

	// Without the "Manage Roles" permission: a permission message, not a hierarchy one
	guild.members.me = { id: 'bot1', roles: { highest: { id: 'rbot', name: 'Melis', position: 10 } }, permissions: { has: () => false } };
	const noPerm = await callTool('grant_role', { member: 'Ali', role: 'Chillz' }, deps);
	assert.equal(noPerm.ok, false, noPerm.spoken);
	assert.ok(noPerm.spoken.includes('Manage Roles'), noPerm.spoken);

	// Hierarchy: the target role sits above the bot's highest role (the permission is in place)
	guild.members.me = { id: 'bot1', roles: { highest: { id: 'rbot', name: 'Melis', position: 10 } }, permissions: { has: () => true } };
	guild.roles.cache.set('r9', { id: 'r9', name: 'Super', position: 20, managed: false, editable: false });
	const higher = await callTool('grant_role', { member: 'Ali', role: 'Super' }, deps);
	assert.equal(higher.ok, false, higher.spoken);
	assert.ok(higher.spoken.includes('above my highest role'), higher.spoken);
	assert.ok(higher.spoken.includes('20') && higher.spoken.includes('10'), `the positions must be reported: ${higher.spoken}`);
});

console.log('LOCAL PANEL');
check('ActivityLog: ring buffer, filtering and counters', () => {
	const log = new ActivityLog({ limit: 3 });
	log.push({ kind: 'dm', direction: 'in', whoName: 'Ali', text: 'hi' });
	log.push({ kind: 'voice', direction: 'out', whoName: 'Melis', text: 'hello' });
	log.push({ kind: 'tool', whoName: 'Melis', text: 'send_message succeeded' });
	log.push({ kind: 'gate', whoName: 'Melis', text: 'ban_member: denied' });
	const all = log.list({});
	assert.equal(all.events.length, 3, 'the window keeps the last 3 events');
	assert.equal(all.events[0].kind, 'voice', 'the oldest event is dropped');
	assert.equal(log.stats().dm, 1, 'the counters are kept');
	assert.equal(log.list({ q: 'ban_member' }).events.length, 1, 'the text search works');
	assert.equal(log.list({ since: log.events.at(-1).id }).events.length, 0, 'since returns only newer events');
});

await checkAsync('ActivityLog: writes to a JSONL file', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'melis-panel-'));
	const file = path.join(dir, 'activity.jsonl');
	try {
		const log = new ActivityLog({ file });
		log.push({ kind: 'dm', text: 'a record' });
		await log.pending;
		const saved = readFileSync(file, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		assert.equal(saved.length, 1);
		assert.equal(saved[0].text, 'a record');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await checkAsync('ActivityLog: loads the history back from the file on restart', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'melis-panel-'));
	const file = path.join(dir, 'activity.jsonl');
	try {
		const first = new ActivityLog({ file });
		first.push({ kind: 'dm', direction: 'in', whoName: 'Ali', text: 'previous session' });
		await first.pending;

		const second = new ActivityLog({ file });
		assert.equal(second.events.length, 0, 'empty before loading');
		const loaded = await second.load(10);
		assert.equal(loaded, 1, 'the history must be read');
		assert.equal(second.list({}).events[0].text, 'previous session');
		assert.equal(second.stats().dm, 1, 'the counters must come back too');
		assert.equal(await second.load(10), 1, 'loading again must not duplicate');

		// The production order: the history is loaded first, then this session's events are appended
		const third = new ActivityLog({ file });
		assert.equal(await third.load(10), 1, 'the history is loaded first');
		third.push({ kind: 'session', text: "this session's event" });
		assert.equal(third.list({}).events.length, 2, 'the new event is appended at the end');
		assert.equal(third.list({}).events[0].text, 'previous session', 'the history stays at the front');
		assert.equal(await third.load(10), 2, 'loading happens once: no duplicates');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await checkAsync('panel: the home page and /api/events work over real HTTP', async () => {
	const activity = new ActivityLog();
	activity.push({ kind: 'dm', direction: 'in', who: 'u1', whoName: 'Ali', text: 'how are you' });
	activity.push({ kind: 'tool', whoName: 'Melis', text: 'send_message succeeded' });
	const panel = await startPanel({
		activity,
		port: 0,
		log: () => {},
		nameFor: (id) => (id === 'u1' ? 'Ali Veli' : null),
		state: () => ({ status: 'test status', metrics: [{ label: 'DM', value: 1 }] }),
	});
	try {
		const page = await fetch(panel.url);
		assert.equal(page.status, 200);
		assert.ok((await page.text()).includes('Local panel'), 'the HTML page must come back');

		const response = await fetch(`${panel.url}/api/events?kinds=dm`);
		const payload = await response.json();
		assert.equal(payload.events.length, 1, 'the kind filter must work');
		assert.equal(payload.events[0].badge, 'DM', 'the kind label must be added');
		assert.equal(payload.events[0].whoName, 'Ali', 'the recorded name must be shown');
		assert.equal(payload.state.status, 'test status', 'the state must come back');

		const resolved = await fetch(`${panel.url}/api/events?kinds=voice`);
		assert.equal((await resolved.json()).events.length, 0);

		const missing = await fetch(`${panel.url}/no-such-page`);
		assert.equal(missing.status, 404);
	} finally {
		await panel.close();
	}
});

check('SpeakerAttribution: the speaker id is resolved from the audio position', () => {
	const attribution = new SpeakerAttribution({ ownerId: '999' });
	for (let i = 0; i < 10; i++) attribution.onFrame({ priority: false, active: ['111'] }); // 0-200 ms
	for (let i = 0; i < 10; i++) attribution.onFrame({ priority: false, active: ['222'] }); // 200-400 ms
	assert.equal(attribution.speakerIdAt(0, 150), '111', 'the first speaker');
	assert.equal(attribution.speakerIdAt(250, 400), '222', 'the next speaker');
	assert.equal(attribution.speakerIdAt(900, 1000), null, 'null when there is no record');
	for (let i = 0; i < 10; i++) attribution.onFrame({ priority: true, active: ['999'] });
	assert.equal(attribution.speakerIdAt(400, 600), '999', 'the priority speaker (the owner)');
	// One uninterrupted speaker stays a single segment
	const before = attribution.track.length;
	for (let i = 0; i < 5; i++) attribution.onFrame({ priority: false, active: ['333'] });
	for (let i = 0; i < 5; i++) attribution.onFrame({ priority: false, active: ['333'] });
	assert.equal(attribution.track.length, before + 1, 'uninterrupted speech is merged');
});

console.log('LOCAL VOICE (CHATTERBOX)');
check('splitSentences: splits finished sentences and holds back a partial one', () => {
	assert.deepEqual(splitSentences('Hi love. How are you?').sentences, ['Hi love.', 'How are you?']);
	assert.deepEqual(splitSentences('Hi love.').sentences, ['Hi love.']);
	const partial = splitSentences('An unfinished sentence');
	assert.deepEqual(partial.sentences, [], 'an unfinished sentence waits');
	assert.equal(partial.rest, 'An unfinished sentence');
	const long = splitSentences('word '.repeat(60));
	assert.ok(long.sentences.length >= 1 && long.sentences.every((sentence) => sentence.length <= 220), 'long text is split up');
	assert.ok(long.rest.length <= 220);
});

check('resampleLinear: leaves an unchanged rate alone and scales a different one', () => {
	const input = Int16Array.from([0, 1000, 2000, 3000]);
	assert.equal(resampleLinear(input, 24_000, 24_000), input, 'same rate: the same array');
	const up = resampleLinear(input, 24_000, 48_000);
	assert.equal(up.length, 8);
	assert.equal(up[up.length - 1], 3000, 'the last sample is preserved');
});

await checkAsync('LocalTts: reads the health information and gets the text back as PCM', async () => {
	const requests = [];
	const server = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => {
			body += chunk;
		});
		request.on('end', () => {
			if (request.url === '/health') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ ok: true, model: 'multilingual', sr: 24_000, device: 'cuda' }));
				return;
			}
			requests.push({ url: request.url, body: JSON.parse(body || '{}') });
			const pcm = Buffer.alloc(4);
			pcm.writeInt16LE(1000, 0);
			pcm.writeInt16LE(-1000, 2);
			response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-sample-rate': '24000' });
			response.end(pcm);
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const tts = new LocalTts({ url: `http://127.0.0.1:${server.address().port}`, voiceRef: 'melis.wav', languageId: 'en' });
	try {
		const health = await tts.health();
		assert.equal(health.ok, true);
		assert.equal(health.model, 'multilingual');
		const result = await tts.speak('Hello love.');
		assert.deepEqual(Array.from(result.pcm), [1000, -1000], 'the raw int16 PCM must be read');
		assert.deepEqual(requests[0], { url: '/tts', body: { text: 'Hello love.', language_id: 'en', voice_ref: 'melis.wav' } });
	} finally {
		// fetch leaves keep-alive sockets open; without closing them the suite hangs.
		server.closeAllConnections?.();
		server.close();
	}
});

await checkAsync('LocalTts: throws a visible error when the server fails', async () => {
	const server = createServer((request, response) => {
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ ok: false, error: 'model not loaded' }));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const tts = new LocalTts({ url: `http://127.0.0.1:${server.address().port}` });
	try {
		await assert.rejects(() => tts.speak('test'), /local TTS error \(500\)/);
		assert.equal(await tts.health(), null, 'the health query returns null quietly');
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
});

console.log('NAME MATCHING');
// Turkish names are deliberate fixtures here: they are what speech-to-text garbles in practice.
check('MemberIndex: a garbled multi-word name still resolves to the right person', () => {
	const index = new MemberIndex();
	index.upsert({ id: 'h1', displayName: 'Hasan Sangül', user: { username: 'hasan_sangul' } });
	index.upsert({ id: 'm1', displayName: 'Murat Dugan', user: { username: 'muratdugan' } });
	assert.equal(index.size, 2);
	assert.equal(index.search("Hasan Sangül'ento")?.id, 'h1', 'a garbled name must land on the right person');
	assert.equal(index.search('hasan')?.id, 'h1');
	assert.equal(index.search('murat dugan')?.id, 'm1');
	assert.equal(index.search('a completely unrelated name')?.id, undefined);
});
check('MemberIndex: the person in the room wins', () => {
	const index = new MemberIndex();
	index.upsert({ id: 'a', displayName: 'Peçeli', user: { username: 'peceli' } }); // not in the room
	index.upsert({ id: 'b', displayName: 'peche', user: { username: 'peche' } }); // in the room
	const hit = index.search('peçeye', { voiceChannelOf: (id) => (id === 'b' ? 'v1' : null), botChannelId: 'v1' });
	assert.equal(hit?.id, 'b', 'the person already in the room must be picked');
});

await checkAsync('bots: list_bots separates authorised from unauthorised, use_bot writes the command', async () => {
	const fixture = makeToolDeps();
	const { deps } = fixture;
	const index = new MemberIndex();
	index.upsert({ id: 'b1', displayName: 'MusicBot', user: { username: 'musicbot', bot: true } });
	index.upsert({ id: 'b2', displayName: 'Helper', user: { username: 'helperbot', bot: true } });
	index.upsert({ id: 'h1', displayName: 'Ali', user: { username: 'ali', bot: false } });
	deps.memberIndex = index;
	deps.cfg.allowedBots = ['MusicBot'];
	deps.cfg.botPrefix = '!';
	deps.cfg.textChannelId = '10';

	const list = await callTool('list_bots', {}, deps);
	assert.equal(list.ok, true);
	assert.equal(list.data.bots.length, 2, 'only bots are listed (not humans)');
	assert.ok(list.spoken.includes('authorised: MusicBot'), list.spoken);
	assert.ok(list.spoken.includes('not authorised: Helper'), list.spoken);

	const sent = [];
	fixture.channel.send = async (payload) => {
		sent.push(payload.content);
		return { id: 'm9' };
	};

	// use_bot relays a command that the other bot runs on our behalf, so it is owner-gated.
	const outsider = await callTool('use_bot', { command: 'play Faithless Insomnia' }, deps);
	assert.equal(outsider.denied, true, 'a non-owner cannot drive another bot');
	deps.isOwnerActive = () => true;
	deps.ownerSaidRecently = () => true;
	deps.ownerMatch = (words) => words[0];
	deps.ownerTextTail = () => 'use the bot';
	const used = await callTool('use_bot', { command: 'play Faithless Insomnia' }, deps);
	assert.equal(used.ok, true, used.spoken);
	assert.deepEqual(sent, ['<@b1> !play Faithless Insomnia']);
	assert.equal(used.data.bot, 'MusicBot');

	// A bot that is not on the authorised list is refused
	const denied = await callTool('use_bot', { bot: 'Helper', command: 'x' }, deps);
	assert.equal(denied.ok, false);
	assert.ok(denied.spoken.includes('not on the authorised list'), denied.spoken);

	// The prefix is not added twice when it is already there
	await callTool('use_bot', { command: '!skip' }, deps);
	assert.equal(sent[1], '<@b1> !skip');
});
await checkAsync('MemberIndex.load: parses the REST response, pages through it and collects the names', async () => {
	const index = new MemberIndex();
	const pages = [
		[
			{ user: { id: '1', username: 'ali', global_name: 'Ali V', bot: false }, nick: 'Ali' },
			{ user: { id: '2', username: 'helperbot', bot: true }, nick: null },
		],
		[],
	];
	let calls = 0;
	const fetchImpl = async () => ({ ok: true, json: async () => pages[calls++] ?? [] });
	const total = await index.load({ token: 't', guildId: 'g', fetchImpl, pageSize: 2 });
	assert.equal(total, 2);
	assert.equal(index.size, 2);
	assert.equal(index.get('1').display, 'Ali', 'the nickname takes priority');
	assert.ok(index.get('1').names.includes('ali'), 'account name');
	assert.ok(index.get('1').names.includes('ali v'), 'account display name');
	assert.equal(index.get('2').display, 'helperbot');
});

console.log('TEXT MESSAGES');
function makeMessageDeps({
	replyText = "I'm good babe ❤️",
	flagged = false,
	moderationFails = false,
	ownerId = null,
	textApi = 'responses',
} = {}) {
	const replies = [];
	const commentary = [];
	const responseCalls = [];
	const chatCalls = [];
	const ownerDms = [];
	const events = [];
	return {
		replies,
		commentary,
		responseCalls,
		chatCalls,
		ownerDms,
		events,
		deps: {
			client: {
				user: { id: 'bot1' },
				users: {
					fetch: async (id) => ({
						id,
						send: async (content) => {
							ownerDms.push({ id, content });
						},
					}),
				},
			},
			cfg: { guildId: 'g1', respondToDms: true, respondToMentions: true, ownerId },
			log: () => {},
			textModel: 'test-model',
			textApi,
			activity: (event) => events.push(event),
			visionClient: {
				moderations: {
					create: async () => {
						if (moderationFails) throw new Error('moderation unavailable');
						return { results: [{ categories: { sexual: flagged } }] };
					},
				},
				// The image path always goes through the OpenAI (vision) client; both land in the same counter.
				responses: {
					create: async (payload) => {
						responseCalls.push(payload);
						return { output_text: replyText };
					},
				},
			},
			textClient: {
				responses: {
					create: async (payload) => {
						responseCalls.push(payload);
						return { output_text: replyText };
					},
				},
				chat: {
					completions: {
						create: async (payload) => {
							chatCalls.push(payload);
							return { choices: [{ message: { content: replyText } }] };
						},
					},
				},
			},
			persona: () => ({ name: 'Melis', prompt: 'You are Melis, playing the girlfriend role.' }),
			getLive: () => ({ ready: true, appendContext: (kind, text) => commentary.push({ kind, text }) }),
		},
	};
}
check('shouldReply: yes to DMs and mentions, no to everything else', () => {
	const base = { author: { id: 'u1', bot: false } };
	assert.equal(shouldReply({ ...base, guild: null, mentions: { users: new Map() } }, { botId: 'bot1', guildId: 'g1' }), true);
	assert.equal(
		shouldReply({ ...base, guild: { id: 'g1' }, mentions: { users: new Map([['bot1', {}]]) } }, { botId: 'bot1', guildId: 'g1' }),
		true,
	);
	assert.equal(
		shouldReply({ ...base, guild: { id: 'g1' }, mentions: { users: new Map(), repliedUser: { id: 'bot1' } } }, { botId: 'bot1', guildId: 'g1' }),
		true,
	);
	assert.equal(shouldReply({ ...base, guild: { id: 'g1' }, mentions: { users: new Map() } }, { botId: 'bot1', guildId: 'g1' }), false);
	assert.equal(shouldReply({ ...base, guild: { id: 'other' }, mentions: { users: new Map([['bot1', {}]]) } }, { botId: 'bot1', guildId: 'g1' }), false);
	assert.equal(
		shouldReply({ author: { id: 'bot2', bot: true }, guild: null, mentions: { users: new Map() } }, { botId: 'bot1', guildId: 'g1' }),
		false,
	);
});
check('imageAttachments: keeps only suitable images (type + size)', () => {
	const message = {
		attachments: new Map([
			['a', { contentType: 'image/png', url: 'https://cdn/a.png', size: 1000 }],
			['b', { contentType: 'application/pdf', url: 'https://cdn/b.pdf', size: 1000 }],
			['c', { contentType: 'image/jpeg', url: 'https://cdn/c.jpg', size: 20 * 1024 * 1024 }],
			['d', { contentType: 'image/gif', url: 'https://cdn/d.gif', size: 500 }],
		]),
	};
	const images = imageAttachments(message);
	assert.deepEqual(images.map((image) => image.url), ['https://cdn/a.png', 'https://cdn/d.gif'], 'the pdf and the huge file must be skipped');
	assert.deepEqual(imageAttachments({ attachments: new Map() }), []);
});

function imageMessage({ sent, ...overrides } = {}) {
	return {
		author: { id: 'u9', bot: false, username: 'someone', displayName: 'Someone' },
		guild: null,
		channel: { name: 'DM' },
		content: '',
		mentions: { users: new Map() },
		attachments: new Map([['a', { contentType: 'image/jpeg', url: 'https://cdn.discordapp.com/attachments/1/2/x.jpg', size: 1000 }]]),
		reply: async (payload) => {
			sent.push(payload.content);
			return { id: 'r1' };
		},
		...overrides,
	};
}

/** Fakes the image download (without touching the network). */
function stubImageFetch({ fail = false, bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) } = {}) {
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		if (fail) throw new Error('no network');
		return {
			ok: true,
			status: 200,
			headers: { get: () => 'image/png' },
			arrayBuffer: async () => bytes,
		};
	};
	return () => {
		globalThis.fetch = original;
	};
}

await checkAsync('DM image (flagged): not commented on, never sent to the model, NO DM sent, logged to the panel', async () => {
	const restore = stubImageFetch();
	try {
		const { deps, replies, responseCalls, ownerDms, events } = makeMessageDeps({ flagged: true, ownerId: 'owner1' });
		const reply = await handleMessage(imageMessage({ sent: replies, content: 'look what I sent' }), deps);
		assert.equal(reply, null, 'no reply may be produced');
		assert.equal(responseCalls.length, 0, 'the image must never reach the model');
		assert.ok(replies[0].includes('not commenting on this'), replies[0]);
		assert.equal(ownerDms.length, 0, 'the bot must not DM anybody on its own');
		assert.equal(events.length, 1, 'the event must reach the panel');
		assert.equal(events[0].kind, 'safety', events[0].kind);
		assert.ok(events[0].text.includes('image not commented on'), events[0].text);
	} finally {
		restore();
	}
});

await checkAsync('DM image (moderation unavailable): fails closed', async () => {
	const restore = stubImageFetch();
	try {
		const { deps, replies, responseCalls } = makeMessageDeps({ moderationFails: true });
		await handleMessage(imageMessage({ sent: replies, content: 'look' }), deps);
		assert.equal(responseCalls.length, 0, 'an image that could not be checked must not reach the model');
		assert.ok(replies[0].includes('not commenting on this'), replies[0]);
	} finally {
		restore();
	}
});

await checkAsync('DM image (download failed): asks politely for another try, does not call the model', async () => {
	const restore = stubImageFetch({ fail: true });
	try {
		const { deps, replies, responseCalls } = makeMessageDeps();
		await handleMessage(imageMessage({ sent: replies }), deps);
		assert.equal(responseCalls.length, 0, 'an image that could not be downloaded must not reach the model');
		assert.ok(replies[0].includes('could you send it again'), replies[0]);
	} finally {
		restore();
	}
});

await checkAsync('DM image (clean): the downloaded bytes go out as a data URL', async () => {
	const restore = stubImageFetch();
	try {
		const { deps, replies, responseCalls } = makeMessageDeps();
		await handleMessage(imageMessage({ sent: replies }), deps);
		assert.equal(responseCalls.length, 1, 'the image must reach the model');
		const content = responseCalls[0].input[0].content;
		assert.equal(content[0].type, 'input_text');
		assert.equal(content[1].type, 'input_image');
		assert.ok(content[1].image_url.startsWith('data:image/png;base64,'), `a data URL was expected: ${content[1].image_url.slice(0, 40)}`);
		assert.ok(responseCalls[0].instructions.includes('do not comment on it at all'), 'the image safety rule must be added to the instructions');
		assert.equal(replies.length, 1, 'a reply must be written');
	} finally {
		restore();
	}
});

check('balanceCodeFences: closes an unclosed code fence', () => {
	assert.equal(balanceCodeFences('hello'), 'hello', 'text without a fence is left alone');
	assert.equal(balanceCodeFences('```js\nnpm i x\n```'), '```js\nnpm i x\n```', 'a balanced fence is left alone');
	assert.equal(balanceCodeFences('```js\nnpm i x'), '```js\nnpm i x\n```', 'the closing fence is added');
	assert.equal(balanceCodeFences('a ``` b ``` c'), 'a ``` b ``` c');
});

await checkAsync('handleMessage: a code block keeps its fences and its line breaks', async () => {
	const { deps, replies } = makeMessageDeps({ replyText: 'Do it like this love:\n```js\nnpm i discord.js\nclient.login(TOKEN);\n```' });
	const message = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: null,
		channel: { name: 'DM' },
		content: 'how do I write a bot',
		mentions: { users: new Map() },
		reply: async (payload) => {
			replies.push(payload.content);
			return { id: 'r1' };
		},
	};
	const reply = await handleMessage(message, deps);
	assert.ok(reply.includes('```js'), reply);
	assert.ok(reply.includes('client.login(TOKEN);'), 'the code itself must survive');
	assert.ok(reply.includes('\n'), 'the line breaks inside the code block must survive');
	assert.deepEqual(replies, [reply]);
});

await checkAsync('handleMessage: a reply containing code is not read out loud, only summarised', async () => {
	const { deps, commentary } = makeMessageDeps({ replyText: '```js\nnpm i x\n```' });
	deps.cfg.voiceEchoTextReplies = true;
	const message = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: { id: 'g1' },
		channel: { name: 'general' },
		content: 'melis can you send me some code',
		mentions: { users: new Map([['bot1', {}]]) },
		reply: async () => ({ id: 'r1' }),
	};
	await handleMessage(message, deps);
	assert.equal(commentary.length, 1);
	assert.ok(commentary[0].text.includes('in writing'), `code must not be read out loud: ${commentary[0].text}`);
});

await checkAsync('the DM reply is produced through DeepSeek (chat completions)', async () => {
	const { deps, replies, chatCalls, responseCalls } = makeMessageDeps({ textApi: 'chat', replyText: 'deepseek reply' });
	const message = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: null,
		channel: { name: 'DM' },
		content: 'how are you',
		mentions: { users: new Map() },
		reply: async (payload) => {
			replies.push(payload.content);
			return { id: 'r1' };
		},
	};
	const reply = await handleMessage(message, deps);
	assert.equal(reply, 'deepseek reply');
	assert.equal(chatCalls.length, 1, 'chat completions must be used');
	assert.equal(responseCalls.length, 0, 'the OpenAI responses API must not be called');
	assert.equal(chatCalls[0].messages[0].role, 'system', 'the persona goes out as the system message');
	assert.ok(chatCalls[0].messages[1].content.includes('how are you'), chatCalls[0].messages[1].content);
});

await checkAsync('a message with an image still goes through the OpenAI (vision) path in DeepSeek mode', async () => {
	const restore = stubImageFetch();
	try {
		const { deps, replies, chatCalls, responseCalls } = makeMessageDeps({ textApi: 'chat' });
		await handleMessage(imageMessage({ sent: replies }), deps);
		assert.equal(chatCalls.length, 0, 'DeepSeek cannot see images');
		assert.equal(responseCalls.length, 1, 'the image must be handled through OpenAI');
	} finally {
		restore();
	}
});

await checkAsync('handleMessage: sends the DM reply but does NOT read it out loud', async () => {
	const { deps, replies, commentary } = makeMessageDeps();
	deps.cfg.voiceEchoTextReplies = true; // echoing in voice is opt-in (off by default)
	const message = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: null,
		channel: { name: 'DM' },
		content: 'how are you',
		mentions: { users: new Map() },
		reply: async (payload) => {
			replies.push(payload.content);
			return { id: 'r1' };
		},
	};
	const reply = await handleMessage(message, deps);
	assert.equal(reply, "I'm good babe ❤️");
	assert.deepEqual(replies, ["I'm good babe ❤️"]);
	assert.equal(commentary.length, 0, 'a DM reply must not be read out loud');
});
await checkAsync('handleMessage: replies to a channel mention and reads it out loud too', async () => {
	const { deps, replies, commentary } = makeMessageDeps();
	deps.cfg.voiceEchoTextReplies = true; // echoing in voice is opt-in (off by default)
	const message = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: { id: 'g1' },
		channel: { name: 'general' },
		content: 'melis how are you',
		mentions: { users: new Map([['bot1', {}]]) },
		reply: async (payload) => {
			replies.push(payload.content);
			return { id: 'r2' };
		},
	};
	await handleMessage(message, deps);
	assert.equal(replies.length, 1);
	assert.equal(commentary.length, 1, 'a channel reply must be read out loud');
	assert.equal(commentary[0].kind, 'commentary');
});
await checkAsync('handleMessage: with VOICE_ECHO_TEXT_REPLIES off (the default) a channel reply is not read out loud', async () => {
	const { deps, replies, commentary } = makeMessageDeps();
	const message = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: { id: 'g1' },
		channel: { name: 'general' },
		content: 'melis how are you',
		mentions: { users: new Map([['bot1', {}]]) },
		reply: async (payload) => {
			replies.push(payload.content);
			return { id: 'r3' };
		},
	};
	await handleMessage(message, deps);
	assert.equal(replies.length, 1, 'the written reply must still be sent');
	assert.equal(commentary.length, 0, 'the default: nothing is read out loud');
});
await checkAsync('handleMessage: stays out of an unmentioned channel message and replies once mentioned', async () => {
	const { deps, replies } = makeMessageDeps();
	const base = {
		author: { id: 'u1', bot: false, username: 'ali', displayName: 'Ali' },
		guild: { id: 'g1' },
		channel: { name: 'general' },
		content: 'hi',
		reply: async (payload) => {
			replies.push(payload.content);
			return { id: 'r1' };
		},
	};

	assert.equal(await handleMessage({ ...base, mentions: { users: new Map() } }, deps), null);
	assert.equal(replies.length, 0, 'an unmentioned message must not be replied to');

	await handleMessage({ ...base, mentions: { users: new Map([['bot1', {}]]) } }, deps);
	assert.equal(replies.length, 1, 'a mention must be replied to');
});
check('buildReplyPrompt: the persona and the context reach the instructions', () => {
	const prompt = buildReplyPrompt({
		personaName: 'Melis',
		personaPrompt: 'GIRLFRIEND PERSONA',
		authorName: 'Ali',
		channelName: 'general',
		isDm: false,
		text: 'how are you',
	});
	assert.ok(prompt.instructions.includes('GIRLFRIEND PERSONA'));
	assert.ok(prompt.instructions.includes('#general'));
	assert.ok(prompt.input.includes('how are you') && prompt.input.includes('Ali'), prompt.input);
	assert.ok(prompt.instructions.includes('<message>'), 'the user text must be given inside a delimiter');
});

console.log('BRIDGE');
await checkAsync('mixer -> model: every tick sends a 20 ms frame, silence included', async () => {
	const mixer = new SpeakerMixer();
	const playback = new PlaybackQueue();
	const chunks = [];
	const output = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.from(chunk));
			cb();
		},
	});
	const sent = [];
	const bridge = new AudioBridge({
		mixer,
		playback,
		output,
		getLive: () => ({ ready: true, sendAudio: (pcm) => (sent.push(Int16Array.from(pcm)), true) }),
	});
	mixer.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(1234));
	const result = bridge.tick();
	assert.equal(result.sent, true);
	assert.equal(sent.length, 6, 'the lead of five silent frames, then the frame');
	assert.ok(sent.slice(0, 5).every((frame) => frame.every((v) => v === 0)));
	assert.equal(sent[5][0], 1234);
	assert.equal(sent[5].length, SAMPLES_PER_FRAME_24K);
	// with no model output, silence is written to Discord (an unbroken stream)
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].length, SAMPLES_PER_FRAME_48K * 4);
	assert.equal(
		chunks[0].every((b) => b === 0),
		true,
	);
	bridge.stop();
});
await checkAsync('model -> Discord: plays after ~80 ms of jitter buffer and returns to silence when it runs out', async () => {
	const mixer = new SpeakerMixer();
	const playback = new PlaybackQueue();
	const chunks = [];
	const output = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.from(chunk));
			cb();
		},
	});
	const bridge = new AudioBridge({ mixer, playback, output, getLive: () => null });

	const tone = new Int16Array(SAMPLES_PER_FRAME_24K).fill(1000);
	for (let i = 0; i < 4; i++) playback.push(tone); // 4 frame = 80 ms
	assert.equal(bridge.tick().played, true);
	const first = chunks.at(-1);
	assert.equal(first.length, SAMPLES_PER_FRAME_48K * 4);
	assert.equal(first.readInt16LE(0), 500); // (0 + 1000) / 2 interpolation
	assert.equal(first.readInt16LE(4), 1000);
	assert.equal(bridge.tick().played, true);
	assert.equal(bridge.tick().played, true);
	assert.equal(bridge.tick().played, true);
	assert.equal(playback.length, 0);
	assert.equal(bridge.tick().played, false); // the buffer is empty: silence
	assert.equal(chunks.at(-1).readInt16LE(0), 0);
	bridge.stop();
});
await checkAsync('nothing is sent while there is no GPT-Live session', async () => {
	const mixer = new SpeakerMixer();
	const playback = new PlaybackQueue();
	const output = new Writable({ write(_c, _e, cb) { cb(); } });
	const bridge = new AudioBridge({ mixer, playback, output, getLive: () => null });
	mixer.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(500));
	assert.equal(bridge.tick().sent, false);
	mixer.push('a', new Int16Array(SAMPLES_PER_FRAME_24K).fill(500));
	assert.equal(bridge.tick().sent, false);
	bridge.stop();
});

await checkAsync('a blocked output drops frames and carries on after drain', async () => {
	const mixer = new SpeakerMixer();
	const playback = new PlaybackQueue();
	let writes = 0;
	const output = new Writable({
		highWaterMark: 1,
		write(_chunk, _enc, cb) {
			writes++;
			setTimeout(cb, 40);
		},
	});
	const logged = [];
	const bridge = new AudioBridge({ mixer, playback, output, getLive: () => null, log: (line) => logged.push(String(line)) });
	bridge.tick(); // the first write fills the queue -> false
	assert.equal(writes, 1);
	assert.equal(bridge.tick().dropped, 1); // while blocked, the frame is dropped
	assert.equal(bridge.tick().dropped, 2);
	assert.equal(writes, 1);
	assert.deepEqual(logged, [], 'nothing is reported while the stall is still going on');
	await new Promise((r) => setTimeout(r, 80)); // the write completes and 'drain' fires
	// One line per stall, saying how much speech it cost. A running total read as a ten second outage
	// that had never happened.
	assert.equal(logged.length, 1, logged.join(' | '));
	assert.match(logged[0], /40/, 'two frames is 40 ms of speech');
	bridge.tick();
	assert.equal(writes, 2);
	bridge.stop();
});

console.log('OPUS (prism-media)');
await checkAsync('40 ms of stereo 48k survives an encode -> decode round trip', async () => {
	const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: SAMPLES_PER_FRAME_48K });
	const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: SAMPLES_PER_FRAME_48K });

	const total = SAMPLES_PER_FRAME_48K * 4; // 2 frame
	const pcm = Buffer.alloc(total * 2);
	for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 12)), i * 2);

	const frames = [];
	const firstFrame = new Promise((resolve) => encoder.once('data', resolve));
	encoder.on('data', (d) => frames.push(d));
	encoder.write(pcm.subarray(0, SAMPLES_PER_FRAME_48K * 4));
	encoder.write(pcm.subarray(SAMPLES_PER_FRAME_48K * 4));
	await withTimeout(firstFrame, 3000, 'encode');
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(frames.length >= 1, 'at least one opus packet must be produced');
	assert.ok(frames[0].length < 1500, `the opus packet must be smaller than the PCM (${frames[0].length} bytes vs 3840)`);

	const decoded = [];
	const firstDecoded = new Promise((resolve) => decoder.once('data', resolve));
	decoder.on('data', (d) => decoded.push(d));
	for (const frame of frames) decoder.write(frame);
	await withTimeout(firstDecoded, 3000, 'decode');
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(decoded.length >= 1);
	assert.equal(decoded[0].length, SAMPLES_PER_FRAME_48K * 4, 'each frame must come back as 20 ms of stereo 48k PCM');
});

// ------------------------------------------------------------------ GPT-Live session (mock server)

console.log('GPT-LIVE (local mock server)');
check('LiveSession: persona + capability note + tools + backend', () => {
	const withBackend = new LiveSession({
		apiKey: 'x',
		instructions: 'PIRATE PERSONA',
		voice: 'quartz',
		delegationModel: 'gpt-5.6-luna',
		tools: [{ type: 'function', name: 'send_message', parameters: { type: 'object', properties: {} } }],
	});
	const config = withBackend._sessionConfig();
	assert.ok(config.instructions.includes('PIRATE PERSONA'), 'the persona must reach the instructions');
	// The prompt template from the guide: tone + backchannel + interruption + delegation policy
	assert.ok(config.instructions.includes('Backchannel policy:'), 'the backchannel line must be there');
	assert.ok(config.instructions.includes('Interruption policy:'), 'the interruption line must be there');
	assert.ok(config.instructions.includes('Delegation policy:'), 'the delegation section must be there');
	assert.ok(config.instructions.includes('Backend capabilities:'), 'the capability list must be there');
	assert.ok(config.instructions.includes('Delegate to the backend when:'), 'the conditions for delegating must be there');
	assert.ok(config.instructions.includes('Do not delegate to the backend when:'), 'the conditions against delegating must be there');
	assert.ok(config.instructions.includes('- Bots: listing the bots on the server'), 'the capabilities must be listed');
	assert.equal(config.audio.output.voice, 'quartz');
	assert.equal(config.delegation.type, 'responses');
	assert.equal(config.delegation.responses.model, 'gpt-5.6-luna');
	assert.equal(config.delegation.responses.parallel_tool_calls, false, 'tool results are processed in order');
	assert.equal(config.delegation.responses.max_output_tokens, 1200);
	assert.ok(
		config.delegation.responses.instructions.includes('You are the backend of a Discord voice assistant'),
		'the backend prompt must carry the operating rules',
	);
	const toolNames = config.delegation.responses.tools.map((t) => t.name ?? t.type);
	assert.ok(toolNames.includes('send_message'));
	assert.ok(toolNames.includes('web_search'));

	const clientOnly = new LiveSession({ apiKey: 'x', instructions: 'X' });
	assert.deepEqual(clientOnly._sessionConfig().delegation, { type: 'client' });
});
await checkAsync('LiveSession: the backend effort/tier settings are only sent when they are given', async () => {
	const tuned = new LiveSession({ apiKey: 'x', delegationModel: 'm', backendEffort: 'low', backendTier: 'priority' });
	const tunedConfig = tuned._sessionConfig();
	assert.deepEqual(tunedConfig.delegation.responses.reasoning, { effort: 'low' });
	assert.equal(tunedConfig.delegation.responses.service_tier, 'priority');

	const plain = new LiveSession({ apiKey: 'x', delegationModel: 'm' });
	const plainConfig = plain._sessionConfig();
	assert.equal('reasoning' in plainConfig.delegation.responses, false, 'with no effort given the field is not sent');
	assert.equal('service_tier' in plainConfig.delegation.responses, false);

	// The escape hatch for a model that does not support them: the env var drops the field entirely
	const baseEnv = { DISCORD_TOKEN: 't', GUILD_ID: 'g', CHANNEL_ID: 'c', OPENAI_API_KEY: 'k' };
	assert.equal(loadConfig(baseEnv).backendEffort, 'low', 'the default when it is undefined');
	assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_EFFORT: '' }).backendEffort, null, 'empty -> no field');
	assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_EFFORT: 'off' }).backendEffort, null);
	assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_EFFORT: 'high' }).backendEffort, 'high');
	assert.equal(loadConfig({ ...baseEnv, LIVE_BACKEND_TIER: 'priority' }).backendTier, 'priority');
	assert.equal(loadConfig(baseEnv).backendTier, null, 'with no tier given nothing is sent');
});

check('LiveSession: appended content is trimmed to the 500 token limit', () => {
	const session = new LiveSession({ apiKey: 'x' });
	const sent = [];
	session.ws = { send: (payload) => sent.push(payload) };
	session.ready = true;

	const long = `${'word '.repeat(600)}end`; // ~3000 characters: over the limit
	assert.equal(session.appendContext('commentary', long), true);
	assert.equal(sent.length, 1);
	assert.ok(sent[0].content.length <= 1500, `it must be trimmed (${sent[0].content.length} characters)`);
	assert.ok(sent[0].content.endsWith('…'), 'the cut must be visible');
	assert.equal(sent[0].delegation_id, null, 'delegation_id is null for general context');

	session.appendContext('commentary', 'a short answer');
	assert.equal(sent[1].content, 'a short answer', 'short content goes out unchanged');

	// A delegation result is under the same limit (a long research answer must not be dropped silently)
	assert.equal(session.replyDelegation('item_1', long), true);
	assert.ok(sent[2].content.length <= 1500, 'a tool/delegation answer must be trimmed');
	assert.equal(sent[2].delegation_id, 'item_1');

	assert.equal(session.appendContext('commentary', '   '), false, 'empty content is not sent');
});
await checkAsync('tool call: function_call -> run it -> return the result -> continue', async () => {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	const { port } = server.address();
	const received = [];
	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const event = JSON.parse(data.toString());
			received.push(event);
			if (event.type === 'session.start') {
				socket.send(JSON.stringify({ type: 'session.started', event_id: 's1', session: { id: 'sess_tools' } }));
				// the backend called a tool, then its response completed
				socket.send(
					JSON.stringify({
						type: 'response.event',
						event_id: 'e1',
						delegation_id: 'item_1',
						event: {
							type: 'response.output_item.done',
							item: { type: 'function_call', call_id: 'call_1', name: 'test_tool', arguments: '{"x":1}' },
						},
					}),
				);
				socket.send(
					JSON.stringify({
						type: 'response.event',
						event_id: 'e2',
						delegation_id: 'item_1',
						event: { type: 'response.completed' },
					}),
				);
			} else if (event.type === 'session.close') {
				socket.send(JSON.stringify({ type: 'session.closed', event_id: 'c1', usage: { seconds: 1 } }));
			}
		});
	});

	const seen = [];
	const session = new LiveSession({
		apiKey: 'test-key',
		baseURL: `http://127.0.0.1:${port}/v1`,
		instructions: 'test',
		delegationModel: 'gpt-5.6-luna',
		tools: [{ type: 'function', name: 'test_tool', parameters: { type: 'object', properties: { x: { type: 'integer' } } } }],
		toolExecutor: async (name, args) => {
			seen.push({ name, args });
			return JSON.stringify({ ok: true, echo: args.x });
		},
	});

	try {
		await withTimeout(session.connect(), 10_000, 'connect');
		await waitFor(() => received.some((e) => e.type === 'response.item.create'), 5000, 'response.item.create');

		const startConfig = received.find((e) => e.type === 'session.start');
		assert.equal(startConfig.session.delegation.type, 'responses');
		assert.equal(startConfig.session.delegation.responses.model, 'gpt-5.6-luna');
		const toolNames = startConfig.session.delegation.responses.tools.map((t) => t.name ?? t.type);
		assert.ok(toolNames.includes('test_tool') && toolNames.includes('web_search'));

		const itemCreate = received.find((e) => e.type === 'response.item.create');
		assert.equal(itemCreate.item.type, 'function_call_output');
		assert.equal(itemCreate.item.call_id, 'call_1');
		assert.ok(itemCreate.item.output.includes('"ok":true'));

		await waitFor(() => received.some((e) => e.type === 'response.create'), 5000, 'response.create');
		assert.deepEqual(seen, [{ name: 'test_tool', args: { x: 1 } }]);
	} finally {
		try {
			await withTimeout(session.close(), 5000, 'close');
		} catch {
			/* ignore */
		}
		try {
			if (session.ws) session.ws.close({ code: 1000, reason: 'test over' });
		} catch {
			/* ignore */
		}
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
	}
});
await checkAsync('a tool that closes the session sends no result (no "session is closing" error)', async () => {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	const { port } = server.address();
	const received = [];
	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const event = JSON.parse(data.toString());
			received.push(event);
			if (event.type === 'session.start') {
				socket.send(JSON.stringify({ type: 'session.started', event_id: 's1', session: { id: 'sess_close' } }));
				socket.send(
					JSON.stringify({
						type: 'response.event',
						event_id: 'e1',
						delegation_id: 'item_9',
						event: {
							type: 'response.output_item.done',
							item: { type: 'function_call', call_id: 'call_9', name: 'leave_voice', arguments: '{}' },
						},
					}),
				);
				socket.send(
					JSON.stringify({ type: 'response.event', event_id: 'e2', delegation_id: 'item_9', event: { type: 'response.completed' } }),
				);
			} else if (event.type === 'session.close') {
				socket.send(JSON.stringify({ type: 'session.closed', event_id: 'c1', usage: { seconds: 1 } }));
			}
		});
	});

	let session = null;
	session = new LiveSession({
		apiKey: 'test-key',
		baseURL: `http://127.0.0.1:${port}/v1`,
		instructions: 'test',
		delegationModel: 'gpt-5.6-luna',
		tools: [{ type: 'function', name: 'leave_voice', parameters: { type: 'object', properties: {} } }],
		toolExecutor: async () => {
			// Mimic the real flow: "leave_voice -> pauseLive -> session.close()"
			session._closing = true;
			return JSON.stringify({ ok: true, summary: 'I left the voice channel.' });
		},
	});

	try {
		await withTimeout(session.connect(), 10_000, 'connect');
		await waitFor(() => received.some((e) => e.type === 'session.start'), 5000, 'session.start');
		await new Promise((r) => setTimeout(r, 150));
		assert.ok(!received.some((e) => e.type === 'response.item.create'), 'no tool result may be sent to a closing session');
		assert.ok(!received.some((e) => e.type === 'response.create'), 'no continuation request may be sent to a closing session');
	} finally {
		try {
			session._closing = false;
			if (session.ws) session.ws.close({ code: 1000, reason: 'test over' });
		} catch {
			/* ignore */
		}
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
	}
});

await checkAsync('session.start -> started -> audio both ways -> close', async () => {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	const { port } = server.address();
	let session = null;

	try {
		const received = [];
		let sentOutput = false;
		server.on('connection', (socket) => {
			socket.on('message', (data) => {
				const event = JSON.parse(data.toString());
				received.push(event);
				if (event.type === 'session.start') {
					socket.send(JSON.stringify({ type: 'session.started', event_id: 's1', session: { id: 'sess_test' } }));
				} else if (event.type === 'session.input_audio.append' && !sentOutput) {
					sentOutput = true;
					const pcm = Buffer.alloc(8);
					pcm.writeInt16LE(1000, 0);
					pcm.writeInt16LE(-1000, 2);
					pcm.writeInt16LE(32767, 4);
					pcm.writeInt16LE(-32768, 6);
					socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: pcm.toString('base64') }));
				} else if (event.type === 'session.close') {
					socket.send(JSON.stringify({ type: 'session.closed', event_id: 'c1', usage: { seconds: 2.5 } }));
				}
			});
		});

		session = new LiveSession({
			apiKey: 'test-key',
			baseURL: `http://127.0.0.1:${port}/v1`,
			model: 'gpt-live-1',
			voice: 'marin',
			instructions: 'test',
		});
		const audioEvents = [];
		session.on('audio', (buf) => audioEvents.push(buf));

		const id = await withTimeout(session.connect(), 10_000, 'connect');
		assert.equal(id, 'sess_test');
		assert.equal(session.ready, true);

		const startEvent = received.find((e) => e.type === 'session.start');
		assert.ok(startEvent, 'session.start must be sent');
		assert.equal(startEvent.session.model, 'gpt-live-1');
		assert.deepEqual(startEvent.session.audio.format, { type: 'audio/pcm', rate: 24000 });
		assert.equal(startEvent.session.audio.output.voice, 'marin');

		assert.equal(session.sendAudio(new Int16Array(SAMPLES_PER_FRAME_24K)), true);
		await waitFor(() => audioEvents.length > 0, 5000, 'output audio');
		const pcm = audioEvents[0];
		assert.equal(pcm.length, 8);
		assert.equal(pcm.readInt16LE(0), 1000);
		assert.equal(pcm.readInt16LE(6), -32768);

		const append = received.find((e) => e.type === 'session.input_audio.append');
		assert.ok(append, 'input_audio.append must be sent');
		assert.equal(Buffer.from(append.audio, 'base64').length, SAMPLES_PER_FRAME_24K * 2);

		assert.equal(session.appendContext('thinking', 'speaker: test'), true);
		await waitFor(() => received.some((e) => e.type === 'session.thinking.append'), 5000, 'thinking.append');
		const ctx = received.find((e) => e.type === 'session.thinking.append');
		assert.equal(ctx.delegation_id, null);
		assert.equal(ctx.content, 'speaker: test');

		const acknowledged = await withTimeout(session.close(), 10_000, 'close');
		assert.equal(acknowledged, true);
		assert.ok(
			received.some((e) => e.type === 'session.close'),
			'session.close must be sent',
		);
	} finally {
		try {
			if (session?.ws) session.ws.close({ code: 1000, reason: 'test over' });
		} catch {
			/* ignore */
		}
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
	}
});

// ------------------------------------------------------------------ result

clearTimeout(watchdog);
if (failures > 0) {
	console.error(`\n${failures} test(s) failed.`);
	process.exitCode = 1;
} else {
	console.log('\nAll tests passed.');
}
await new Promise((resolve) => setTimeout(resolve, 150)); // wait for stdout to drain
process.exit(failures > 0 ? 1 : 0);
