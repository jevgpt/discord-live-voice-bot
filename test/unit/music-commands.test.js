import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { executeAction, toolCallFor } from '../../src/agent.js';
import { setLocale } from '../../src/i18n/index.js';
import enCommands from '../../src/locales/en/commands.js';
import trCommands from '../../src/locales/tr/commands.js';
import { MusicPlayer } from '../../src/music.js';
import { callTool, toolMeta } from '../../src/tools.js';

// The queue commands from the outside: the spoken grammar in both languages, the tool calls it turns
// into, the /music subcommands, and the tools themselves against a real player with a stand-in decoder.
//
// src/commands.js compiles the ACTIVE locale's grammar at import time, so it is evaluated once per
// language (the query string only makes the specifier unique), exactly as in commands.test.js.
setLocale('tr');
const turkish = await import('../../src/commands.js?music-locale=tr');
setLocale('en');
const english = await import('../../src/commands.js?music-locale=en');

const music = (fields) => ({ type: 'music', ...fields });

describe('queue voice commands (en)', () => {
	const cases = [
		['loop this song', music({ action: 'loop', mode: 'track' })],
		['repeat this song', music({ action: 'loop', mode: 'track' })],
		['put this song on repeat', music({ action: 'loop', mode: 'track' })],
		['repeat the queue', music({ action: 'loop', mode: 'queue' })],
		['loop the playlist', music({ action: 'loop', mode: 'queue' })],
		['stop repeating', music({ action: 'loop', mode: 'off' })],
		['stop looping the song', music({ action: 'loop', mode: 'off' })],
		['turn off repeat', music({ action: 'loop', mode: 'off' })],
		['shuffle', music({ action: 'shuffle' })],
		['Aria, shuffle', music({ action: 'shuffle' })],
		['shuffle the queue', music({ action: 'shuffle' })],
		['clear the queue', music({ action: 'clear' })],
		['empty the playlist', music({ action: 'clear' })],
		['move 3 to 1', music({ action: 'move', from: 3, to: 1 })],
		['move song 3 to position 1', music({ action: 'move', from: 3, to: 1 })],
		['move three to one', music({ action: 'move', from: 3, to: 1 })],
		['move the third song to the top', music({ action: 'move', from: 3, to: 1 })],
		['move 5 to the end of the queue', music({ action: 'move', from: 5, to: Number.MAX_SAFE_INTEGER })],
		['remove 3 from the queue', music({ action: 'remove', position: 3 })],
		['remove song 4', music({ action: 'remove', position: 4 })],
		['take the second one out of the queue', music({ action: 'remove', position: 2 })],
		['go to 1:30', music({ action: 'seek', to: 90 })],
		['jump to 2:15 please', music({ action: 'seek', to: 135 })],
		['skip to 1:30', music({ action: 'seek', to: 90 })],
		['skip to the 2 minute mark', music({ action: 'seek', to: 120 })],
		['skip ahead 30 seconds', music({ action: 'seek', by: 30 })],
		['fast forward 1 minute', music({ action: 'seek', by: 60 })],
		['go forward thirty seconds', music({ action: 'seek', by: 30 })],
		['rewind 10 seconds', music({ action: 'seek', by: -10 })],
		['go back ten seconds', music({ action: 'seek', by: -10 })],
		['skip back a minute', music({ action: 'seek', by: -60 })],
		['rewind to the start', music({ action: 'seek', to: 0 })],
		['start the song over', music({ action: 'seek', to: 0 })],
		['play Daft Punk Around the World next', music({ action: 'play', query: 'Daft Punk Around the World', next: true })],
		['play bohemian rhapsody after this one', music({ action: 'play', query: 'bohemian rhapsody', next: true })],
		['add Smells Like Teen Spirit to the front of the queue', music({ action: 'play', query: 'Smells Like Teen Spirit', next: true })],
	];
	for (const [line, expected] of cases) {
		it(`"${line}"`, () => assert.deepEqual(english.extractMusic(line), expected));
	}

	it('leaves the old commands as they were, and ordinary sentences alone', () => {
		assert.equal(english.extractMusic('skip the song')?.action, 'skip');
		assert.equal(english.extractMusic('next song')?.action, 'skip');
		assert.deepEqual(english.extractMusic('play Daft Punk'), music({ action: 'play', query: 'Daft Punk' }));
		assert.equal(english.extractMusic("what's playing")?.action, 'status');
		// Stopping clears the queue too, so a sentence asking for both is a stop, not a clear that plays on.
		assert.equal(english.extractMusic('stop the music and clear the queue')?.action, 'stop');
		for (const line of ['can you repeat that', 'the deck needs a shuffle', "let's go to the 2:30 showing", 'I went back 10 minutes ago', 'the weather is lovely today']) {
			assert.equal(english.extractMusic(line), null, line);
		}
		assert.deepEqual(english.parseVoiceCommand('move 3 to 1', [], { text: [], voice: [] }), music({ action: 'move', from: 3, to: 1 }));
	});

	// Found in review: these commands run with no wake word, and every one of these everyday sentences ran
	// one. A command has to be the sentence, and has to name the music where the words alone do not.
	it('leaves people talking alone', () => {
		const talk = [
			"let's go back to the beginning",
			'we should take it from the top',
			'I will go to 3:30',
			'I had to go back 10 seconds',
			'ok take two out',
			'remove the third one from the list',
			'I keep looping this in my head',
			'could you go to 3:30?',
			'stop repeating yourself',
			'I put it on repeat all day',
			'can you repeat that one more time',
			'add milk to the top of the list',
		];
		for (const line of talk) {
			assert.equal(english.extractMusic(line), null, line);
			assert.equal(english.parseVoiceCommand(line, [], { text: [], voice: [] }), null, line);
		}
	});

	it('still takes the command after the bot\'s name, with a comma or without, and put as a question where it names the music', () => {
		const aria = [{ name: 'Aria' }];
		assert.deepEqual(english.parseVoiceCommand('Aria shuffle', aria, { text: [], voice: [] }), music({ action: 'shuffle' }));
		assert.deepEqual(english.parseVoiceCommand('Aria, go back ten seconds', aria, { text: [], voice: [] }), music({ action: 'seek', by: -10 }));
		assert.deepEqual(english.extractMusic('bot, go to 1:30'), music({ action: 'seek', to: 90 }), 'a wake word is a name too');
		assert.deepEqual(english.extractMusic('can you loop this song?'), music({ action: 'loop', mode: 'track' }));
		assert.deepEqual(english.extractMusic('could you remove song 2 please'), music({ action: 'remove', position: 2 }));
		assert.deepEqual(english.extractMusic('go back to the beginning of the song'), music({ action: 'seek', to: 0 }));
		assert.deepEqual(english.extractMusic('take the third song out'), music({ action: 'remove', position: 3 }));
		assert.equal(english.extractMusic('Dana shuffle'), null, 'somebody else\'s name, with no comma, is not the bot being asked');
	});
});

describe('queue voice commands (tr)', () => {
	const cases = [
		['şarkıyı tekrarla', music({ action: 'loop', mode: 'track' })],
		['bu şarkıyı döngüye al', music({ action: 'loop', mode: 'track' })],
		['listeyi döngüye al', music({ action: 'loop', mode: 'queue' })],
		['sırayı tekrarla', music({ action: 'loop', mode: 'queue' })],
		['tekrarı kapat', music({ action: 'loop', mode: 'off' })],
		['döngüyü kapat', music({ action: 'loop', mode: 'off' })],
		['şarkıyı tekrarlama', music({ action: 'loop', mode: 'off' })],
		['karıştır', music({ action: 'shuffle' })],
		['sırayı karıştır', music({ action: 'shuffle' })],
		['karışık çal', music({ action: 'shuffle' })],
		['sırayı temizle', music({ action: 'clear' })],
		['listeyi boşalt', music({ action: 'clear' })],
		['3. şarkıyı 1. sıraya al', music({ action: 'move', from: 3, to: 1 })],
		["3'ü 1'e taşı", music({ action: 'move', from: 3, to: 1 })],
		['üçüncü şarkıyı başa al', music({ action: 'move', from: 3, to: 1 })],
		["5'i sona at", music({ action: 'move', from: 5, to: Number.MAX_SAFE_INTEGER })],
		['3. şarkıyı sıradan çıkar', music({ action: 'remove', position: 3 })],
		["sıradan 3'ü sil", music({ action: 'remove', position: 3 })],
		["1:30'a git", music({ action: 'seek', to: 90 })],
		["2:15'e atla", music({ action: 'seek', to: 135 })],
		['90. saniyeye git', music({ action: 'seek', to: 90 })],
		['iki dakika on beş saniyeye git', music({ action: 'seek', to: 135 })],
		['30 saniye ileri sar', music({ action: 'seek', by: 30 })],
		['otuz saniye ileri sar', music({ action: 'seek', by: 30 })],
		['1 dakika ileri sar', music({ action: 'seek', by: 60 })],
		['10 saniye geri sar', music({ action: 'seek', by: -10 })],
		['on saniye geri al', music({ action: 'seek', by: -10 })],
		['başa sar', music({ action: 'seek', to: 0 })],
		['şarkıyı başa sar', music({ action: 'seek', to: 0 })],
		['bundan sonra Tarkan Şımarık çal', music({ action: 'play', query: 'Tarkan Şımarık', next: true })],
		['bundan sonra Tarkan şımarık şarkısını çal', music({ action: 'play', query: 'Tarkan şımarık', next: true })],
		['sıradaki şarkı Sezen Aksu Gülümse olsun', music({ action: 'play', query: 'Sezen Aksu Gülümse', next: true })],
		["Tarkan Şımarık'ı sıranın başına ekle", music({ action: 'play', query: 'Tarkan Şımarık', next: true })],
	];
	for (const [line, expected] of cases) {
		it(`"${line}"`, () => assert.deepEqual(turkish.extractMusic(line), expected));
	}

	it('leaves the old commands as they were, and ordinary sentences alone', () => {
		assert.equal(turkish.extractMusic('şarkıyı atla')?.action, 'skip');
		assert.equal(turkish.extractMusic('sonraki şarkıya geç')?.action, 'skip');
		assert.deepEqual(turkish.extractMusic('Tarkan şımarık şarkısını çal'), music({ action: 'play', query: 'Tarkan şımarık' }));
		assert.equal(turkish.extractMusic('müziğe devam et')?.action, 'resume');
		assert.equal(turkish.extractMusic('müziği durdur ve sırayı temizle')?.action, 'stop');
		// "Bunu tekrarla" is also "say that again", and "kafamı karıştır" is not about the queue.
		for (const line of ['bunu tekrarla', 'kafamı karıştır', 'on dakika sonra gel', 'bugün hava çok güzel']) {
			assert.equal(turkish.extractMusic(line), null, line);
		}
	});

	// Found in review: every one of these ran a command with no wake word. "Onu" (him, it) was read as "on"
	// (ten) with a case ending, "gel" (come) as a way of going to a place in the song, and "araya koy", "hadi
	// karıştır" and "bir daha tekrarlama" as being about music at all.
	it('leaves people talking alone', () => {
		const talk = [
			'on dakikaya gelirim',
			'beş dakikaya geliyorum',
			'saat 9.30 a gel',
			'akşam 8.30a gelirim',
			'onu sıradan çıkar',
			'onu en başa al',
			'çayı araya koy',
			'hadi karıştır',
			'bir daha tekrarlama',
			'hadi, karıştır',
			'30 saniye geri sardım',
			'bundan sonra kapıyı aç',
			'bunu en başa al',
			'biri sıradan çıkar',
			'şarkıları karıştırdım',
			'saat 1:30a git',
		];
		for (const line of talk) {
			assert.equal(turkish.extractMusic(line), null, line);
			assert.equal(turkish.parseVoiceCommand(line, [], { text: [], voice: [] }), null, line);
		}
	});

	it('still takes the command after the bot\'s name, and put as a question', () => {
		const melis = [{ name: 'Melis' }];
		assert.deepEqual(turkish.parseVoiceCommand('Melis karıştır', melis, { text: [], voice: [] }), music({ action: 'shuffle' }));
		assert.deepEqual(turkish.extractMusic('Melis, karıştır'), music({ action: 'shuffle' }));
		assert.deepEqual(turkish.extractMusic('karıştırır mısın'), music({ action: 'shuffle' }));
		assert.deepEqual(turkish.extractMusic('şarkıyı 30 saniye ileri sarar mısın'), music({ action: 'seek', by: 30 }));
		assert.deepEqual(turkish.extractMusic('bu şarkıyı döngüye alır mısın'), music({ action: 'loop', mode: 'track' }));
		assert.deepEqual(turkish.extractMusic('üç numaralı şarkıyı sıradan çıkar'), music({ action: 'remove', position: 3 }));
		assert.deepEqual(turkish.extractMusic('hadi 10 saniye geri sarsana'), music({ action: 'seek', by: -10 }));
		assert.deepEqual(turkish.extractMusic('Tarkan şımarık şarkısını araya koy'), music({ action: 'play', query: 'Tarkan şımarık', next: true }));
		assert.deepEqual(turkish.extractMusic('bundan sonra Tarkan şımarık şarkısını aç'), music({ action: 'play', query: 'Tarkan şımarık', next: true }));
	});
});

// Found in review: "Nothing is playing right now" was the bot's answer to every sentence the grammar took
// for a music command while no music was on. With nothing for it to act on, a command nobody woke the bot
// for is most likely not one.
describe('a music command heard with no music to act on', () => {
	// Nothing is remembered between the cases: each one runs as if it were the first.
	const recorder = () => ({ remember: () => {}, recall: () => null });
	const idleDeps = (overrides = {}) => ({ music: { current: null, queue: [], volume: 0.5, state: () => ({}), nowPlayingText: () => 'Nothing is playing right now.' }, recentActions: recorder(), log: () => {}, ...overrides });

	it('stays quiet, and runs nothing, when it came from the grammar', async () => {
		for (const command of [
			music({ action: 'seek', by: -10 }),
			music({ action: 'seek', to: 0 }),
			music({ action: 'loop', mode: 'off' }),
			music({ action: 'skip' }),
			music({ action: 'pause' }),
			music({ action: 'stop' }),
			music({ action: 'remove', position: 10 }),
			music({ action: 'move', from: 10, to: 1 }),
			music({ action: 'shuffle' }),
			music({ action: 'clear' }),
			music({ action: 'status' }),
			music({ action: 'volume', delta: -15 }),
		]) {
			assert.equal(await executeAction(command, idleDeps()), null, command.action);
		}
	});

	it('acts on the queue commands only when something is waiting, and on the track ones only when something plays', async () => {
		const playingNothingWaiting = idleDeps({ music: { current: { title: 'x' }, queue: [], volume: 0.5 } });
		assert.equal(await executeAction(music({ action: 'shuffle' }), playingNothingWaiting), null);
		const shuffle = await executeAction(music({ action: 'shuffle' }), idleDeps({ music: { current: null, queue: [{ title: 'a' }], volume: 0.5, shuffle: () => 1 } }));
		assert.notEqual(shuffle, null, 'something is waiting');
	});

	it('still takes a request to play, answers about music that is there, and answers the model whatever it asks', async () => {
		const { deps, player } = toolDeps();
		const heard = { ...deps, recentActions: recorder() };
		const play = await executeAction(music({ action: 'play', query: 'alpha' }), heard);
		assert.equal(play.text, 'Playing: alpha.');
		assert.match((await executeAction(music({ action: 'status' }), heard)).text, /^Playing: alpha/u);
		player.stop();
		const asked = await executeAction(music({ action: 'skip' }), heard, { delegated: true });
		assert.equal(asked.text, 'There is no track to skip.', 'the model asked, and is owed an answer');
	});
});

describe('seek_music at the tool boundary', () => {
	it('answers a number that is no place in any track in words, and leaves the player alone', async () => {
		const { deps, player } = toolDeps();
		await callTool('play_music', { query: 'alpha' }, deps);
		for (const args of [{ by: 1e308 }, { by: -1e308 }, { to: 1e308 }, { to: '999999' }, { by: 'Infinity' }]) {
			const result = await callTool('seek_music', args, deps);
			assert.equal(result.ok, false, JSON.stringify(args));
			assert.match(result.spoken, /^I could not work out where to go/u, JSON.stringify(args));
		}
		assert.equal(player.elapsed, 0);
		assert.equal(player.current.title, 'alpha', 'the track was not dropped');
		player.stop();
	});

	it('will only start a live stream over, and says why in both languages', async () => {
		const { deps, player } = toolDeps();
		player.ytDlp = 'yt-dlp';
		player.queue.push({ kind: 'url', url: 'https://www.twitch.tv/somebody', title: 'Live radio', id: 1, duration: null });
		player.startNext();
		player.samplesRead = 48_000 * 2 * 1800;
		let result = await callTool('seek_music', { by: -10 }, deps);
		assert.deepEqual([result.ok, result.spoken], [false, 'Live radio has no known length, a live stream most likely, so I can start it over but not jump around in it.']);
		setLocale('tr');
		try {
			result = await callTool('seek_music', { to: '1:30' }, deps);
			assert.equal(result.spoken, 'Live radio parçasının uzunluğu belli değil, büyük ihtimalle canlı yayın; baştan başlatabilirim ama içinde ileri geri gidemem.');
		} finally {
			setLocale('en');
		}
		assert.equal(Math.round(player.elapsed), 1800);
		result = await callTool('seek_music', { to: '0' }, deps);
		assert.equal(result.ok, true, 'starting it over is fine');
		player.stop();
	});
});

describe('queue commands -> tool calls', () => {
	const deps = { music: { volume: 0.5 } };
	it('names the tool and passes exactly what was heard', () => {
		assert.deepEqual(toolCallFor(music({ action: 'loop', mode: 'queue' }), deps), { name: 'loop_music', args: { mode: 'queue' } });
		assert.deepEqual(toolCallFor(music({ action: 'shuffle' }), deps), { name: 'shuffle_queue', args: {} });
		assert.deepEqual(toolCallFor(music({ action: 'clear' }), deps), { name: 'clear_queue', args: {} });
		assert.deepEqual(toolCallFor(music({ action: 'move', from: 3, to: 1 }), deps), { name: 'move_in_queue', args: { from: 3, to: 1 } });
		assert.deepEqual(toolCallFor(music({ action: 'remove', position: 3 }), deps), { name: 'remove_from_queue', args: { position: 3 } });
		assert.deepEqual(toolCallFor(music({ action: 'seek', to: 0 }), deps), { name: 'seek_music', args: { to: 0 } });
		assert.deepEqual(toolCallFor(music({ action: 'seek', by: -10 }), deps), { name: 'seek_music', args: { by: -10 } });
		assert.deepEqual(toolCallFor(music({ action: 'play', query: 'x', next: true }), deps), { name: 'play_next', args: { query: 'x' } });
		assert.deepEqual(toolCallFor(music({ action: 'play', query: 'x' }), deps), { name: 'play_music', args: { query: 'x' } });
	});

	it('"turn the music down" becomes a level the volume tool can take', () => {
		assert.deepEqual(toolCallFor(music({ action: 'volume', delta: -15 }), deps), { name: 'set_music_volume', args: { percent: 35 } });
		assert.deepEqual(toolCallFor(music({ action: 'volume', delta: 15 }), { music: { volume: 0.95 } }).args, { percent: 100 });
	});

	it('keeps "play X next" apart from "play X" and a seek apart from another seek', () => {
		assert.notEqual(english.actionSignature(music({ action: 'play', query: 'x' })), english.actionSignature(music({ action: 'play', query: 'x', next: true })));
		assert.notEqual(english.actionSignature(music({ action: 'seek', to: 90 }), 0), english.actionSignature(music({ action: 'seek', by: 90 }), 0));
		assert.notEqual(english.actionSignature(music({ action: 'move', from: 3, to: 1 }), 0), english.actionSignature(music({ action: 'move', from: 1, to: 3 }), 0));
	});
});

// ---------------------------------------------------------------- /music

/** An options resolver that behaves like discord.js: a required option that is not there throws. */
function slashOptions(sub, values = {}) {
	const get = (name, required) => {
		if (Object.hasOwn(values, name)) return values[name];
		if (required) throw new Error(`Required option "${name}" not found.`);
		return null;
	};
	return { getSubcommand: () => sub, getString: get, getInteger: get };
}

describe('/music subcommands', () => {
	it('reads each subcommand\'s own options, and only those', () => {
		const call = (sub, values) => english.musicSlashCall(sub, slashOptions(sub, values));
		assert.deepEqual(call('play', { query: 'x' }), ['play_music', { query: 'x' }]);
		assert.deepEqual(call('playnext', { query: 'x' }), ['play_next', { query: 'x' }]);
		assert.deepEqual(call('seek', { position: '1:30' }), ['seek_music', { to: '1:30' }]);
		assert.deepEqual(call('seek', { position: '-10' }), ['seek_music', { to: '-10' }]);
		assert.deepEqual(call('loop', { mode: 'track' }), ['loop_music', { mode: 'track' }]);
		assert.deepEqual(call('move', { from: 3, to: 1 }), ['move_in_queue', { from: 3, to: 1 }]);
		assert.deepEqual(call('remove', { position: 2 }), ['remove_from_queue', { position: 2 }]);
		assert.deepEqual(call('volume', { percent: 40 }), ['set_music_volume', { percent: 40 }]);
		// The table this replaced read /music play's query for every subcommand, and discord.js throws for
		// a required option that is not there: /music stop, skip, status... all failed.
		for (const sub of ['stop', 'pause', 'resume', 'skip', 'status', 'shuffle', 'clear']) assert.ok(call(sub, {}), sub);
		assert.equal(call('dance', {}), null);
		assert.throws(() => call('move', { from: 3 }), /"to" not found/);
	});

	it('registers within Discord\'s limits, with a Turkish name and description for every entry', () => {
		const data = english.commandData().map((builder) => builder.toJSON());
		const command = data.find((entry) => entry.name === 'music');
		const NAME = /^[-_\p{Ll}\p{Lm}\p{Lo}\p{N}]{1,32}$/u;
		assert.ok(command.options.length <= 25, 'at most 25 subcommands');
		const subs = command.options.map((sub) => sub.name);
		for (const name of ['play', 'playnext', 'stop', 'pause', 'resume', 'skip', 'volume', 'status', 'seek', 'loop', 'shuffle', 'move', 'remove', 'clear']) {
			assert.ok(subs.includes(name), name);
		}
		const entries = [command, ...command.options, ...command.options.flatMap((sub) => sub.options ?? [])];
		for (const entry of entries) {
			assert.match(entry.name, NAME, entry.name);
			assert.match(entry.name_localizations?.tr ?? '', NAME, `${entry.name}: Turkish name`);
			assert.ok(entry.description.length >= 1 && entry.description.length <= 100, entry.name);
			assert.ok(entry.description_localizations?.tr?.length <= 100, `${entry.name}: Turkish description`);
			assert.ok((entry.options ?? []).length <= 25);
		}
		const loop = command.options.find((sub) => sub.name === 'loop').options[0];
		assert.deepEqual(loop.choices.map((choice) => choice.value), ['off', 'track', 'queue']);
		assert.ok(loop.choices.every((choice) => choice.name_localizations?.tr));
		// Every Turkish subcommand name is unique within /music.
		const trNames = Object.values(trCommands.slash.music.subcommands).map((sub) => sub.name);
		assert.equal(new Set(trNames).size, trNames.length);
		assert.equal(Object.keys(trCommands.slash.music.subcommands).length, Object.keys(enCommands.slash.music.subcommands).length);
	});

	it('/music status lists the queue with the positions move and remove take', async () => {
		const calls = [];
		const replies = [];
		const interaction = {
			commandName: 'music',
			user: { id: 'u1' },
			options: slashOptions('status'),
			isAutocomplete: () => false,
			isChatInputCommand: () => true,
			deferred: false,
			replied: false,
			async reply(payload) {
				replies.push(payload);
			},
			async deferReply() {
				interaction.deferred = true;
			},
			async editReply(payload) {
				replies.push(payload);
			},
		};
		const ctx = {
			music: {},
			log: () => {},
			callTool: async (name, args) => {
				calls.push([name, args]);
				return {
					ok: true,
					spoken: 'Playing: Now (0:42 / 3:00).',
					data: { queue: [{ position: 1, title: 'Next', durationText: '3:20' }, { position: 2, title: 'After', durationText: null }] },
				};
			},
		};
		await english.handleInteraction(interaction, ctx);
		assert.deepEqual(calls, [['music_status', {}]]);
		assert.equal(replies.at(-1).content, 'Playing: Now (0:42 / 3:00).\n**Up next:**\n1. Next (3:20)\n2. After');
	});
});

// ---------------------------------------------------------------- the tools

function fakeSpawn() {
	return (binary, args) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough();
		child.kill = () => true;
		if (args.includes('pipe:1')) {
			setImmediate(() => {
				child.stdout.write(Buffer.alloc(48_000 * 4));
				child.stdout.end();
				child.emit('close', 0);
			});
		}
		return child;
	};
}

function toolDeps(options = {}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'music-tools-'));
	for (const name of ['alpha.wav', 'beta.wav', 'gamma.wav', 'delta.wav']) writeFileSync(path.join(dir, name), 'x');
	const events = [];
	const player = new MusicPlayer({ musicDir: dir, spawnImpl: fakeSpawn(), log: () => {}, ...options });
	return {
		events,
		player,
		deps: { music: player, activity: (event) => events.push(event.text), log: () => {}, personaName: () => 'Aria', currentSpeakerName: () => 'Jane' },
	};
}

describe('queue tools', () => {
	it('are open to everybody, like play and stop', () => {
		const meta = new Map(toolMeta().map((entry) => [entry.name, entry]));
		for (const name of ['play_next', 'loop_music', 'shuffle_queue', 'seek_music', 'move_in_queue', 'clear_queue']) {
			assert.ok(meta.has(name), name);
			assert.equal(meta.get(name).gated, false, name);
		}
	});

	it('play_next, move_in_queue, clear_queue and shuffle_queue say what they did', async () => {
		const sequence = [0, 0, 0];
		const { deps, player, events } = toolDeps({ random: () => sequence.shift() ?? 0 });
		await callTool('play_music', { query: 'alpha' }, deps);
		await callTool('play_music', { query: 'beta' }, deps);
		const next = await callTool('play_next', { query: 'gamma' }, deps);
		assert.equal(next.spoken, 'Up next: gamma.');
		assert.deepEqual(player.queue.map((track) => track.title), ['gamma', 'beta']);
		assert.equal((await callTool('play_next', { query: 'beta' }, deps)).spoken, 'beta was already waiting; it is up next now.');

		await callTool('play_music', { query: 'delta' }, deps);
		const moved = await callTool('move_in_queue', { from: 3, to: 1 }, deps);
		assert.equal(moved.spoken, 'Moved delta to position 1.');
		assert.deepEqual(player.queue.map((track) => track.title), ['delta', 'beta', 'gamma']);
		assert.equal((await callTool('move_in_queue', { from: 9, to: 1 }, deps)).ok, false);

		const shuffled = await callTool('shuffle_queue', {}, deps);
		assert.equal(shuffled.ok, true);
		assert.equal(shuffled.spoken, `I shuffled 3 tracks; next up is ${player.queue[0].title}.`);
		assert.equal(player.current.title, 'alpha', 'the shuffle left the current track alone');

		const cleared = await callTool('clear_queue', {}, deps);
		assert.equal(cleared.spoken, 'I cleared the queue (3 tracks); alpha keeps playing.');
		assert.equal((await callTool('clear_queue', {}, deps)).spoken, 'The queue was already empty.');
		assert.equal((await callTool('shuffle_queue', {}, deps)).ok, false, 'nothing to shuffle');
		assert.ok(events.some((text) => text.startsWith('moved in the queue: delta')));
		player.stop();
	});

	it('loop_music sets the mode, and will not repeat "this track" when there is none', async () => {
		const { deps, player } = toolDeps();
		assert.equal((await callTool('loop_music', { mode: 'track' }, deps)).ok, false);
		assert.equal((await callTool('loop_music', { mode: 'queue' }, deps)).spoken, 'The queue will start over when it gets to the end.');
		await callTool('play_music', { query: 'alpha' }, deps);
		assert.equal((await callTool('loop_music', { mode: 'track' }, deps)).spoken, 'I will keep repeating alpha.');
		assert.equal(player.loop, 'track');
		assert.match((await callTool('music_status', {}, deps)).spoken, /^Playing: alpha \(0:00 in\)\. This track is on repeat\.$/);
		assert.equal((await callTool('loop_music', { mode: 'sometimes' }, deps)).ok, false);
		assert.equal((await callTool('loop_music', { mode: 'off' }, deps)).spoken, 'Repeat is off.');
		player.stop();
	});

	it('seek_music takes a place or a step, as text or seconds, and refuses past the end', async () => {
		const { deps, player } = toolDeps();
		assert.equal((await callTool('seek_music', { to: '1:30' }, deps)).ok, false, 'nothing playing');
		await callTool('play_music', { query: 'alpha' }, deps);
		let result = await callTool('seek_music', { to: '1:30' }, deps);
		assert.equal(result.spoken, 'Jumped to 1:30 in alpha.');
		assert.equal(player.elapsed, 90);
		result = await callTool('seek_music', { to: '+30' }, deps);
		assert.equal(player.elapsed, 120);
		result = await callTool('seek_music', { by: -20 }, deps);
		assert.equal(player.elapsed, 100);
		player.pause();
		result = await callTool('seek_music', { to: 0 }, deps);
		assert.equal(result.spoken, 'Moved to 0:00 in alpha; it is still paused.');
		assert.equal((await callTool('seek_music', { to: 'later' }, deps)).spoken.startsWith('I could not work out where to go'), true);
		player.current.duration = 180;
		result = await callTool('seek_music', { to: '5:00' }, deps);
		assert.deepEqual([result.ok, result.spoken], [false, 'alpha is only 3:00 long, so I cannot go there.']);
		assert.equal(player.elapsed, 0, 'and it stayed where it was');
		player.stop();
	});

	it('answers in Turkish when the bot speaks Turkish', async () => {
		const { deps, player } = toolDeps();
		setLocale('tr');
		try {
			await callTool('play_music', { query: 'alpha' }, deps);
			assert.equal((await callTool('seek_music', { to: '1:30' }, deps)).spoken, 'alpha parçasında 1:30 noktasına geçtim.');
			assert.equal((await callTool('loop_music', { mode: 'off' }, deps)).spoken, 'Tekrarı kapattım.');
			assert.match(player.nowPlayingText(), /^Çalıyor: alpha \(1:30 geçti\)\.$/);
		} finally {
			setLocale('en');
			player.stop();
		}
	});
});
