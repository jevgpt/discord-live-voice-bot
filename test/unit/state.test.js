import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLocale, tList } from '../../src/i18n/index.js';
import { cleanEnvValue, loadConfig } from '../../src/config.js';
import { MemoryStore } from '../../src/memory.js';
import { DailyQuota, SessionUsage } from '../../src/quota.js';
import { CharacterStore } from '../../src/store.js';
import { SpeakerAttribution } from '../../src/attribution.js';
import { createTextProvider, providerFromDeps } from '../../src/provider.js';

// Where the locale really decides what happens, the test switches it: config.js reads its on/off
// words out of the bundle, and the owner-gate keyword table is language data too, so those two tests
// call setLocale('tr') and put it back afterwards.
// MemoryStore and SpeakerAttribution match through normalize() (src/text.js), which folds Turkish
// letters whatever the interface language is; the Turkish fixtures there are deliberate input.

let dir;
before(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), 'bot-state-'));
});
after(async () => {
	await rm(dir, { recursive: true, force: true });
});

const baseEnv = { DISCORD_TOKEN: 't', GUILD_ID: 'g', CHANNEL_ID: 'c', OPENAI_API_KEY: 'k' };

describe('config.js', () => {
	it('lists every missing variable in one go', () => {
		assert.throws(() => loadConfig({}), /DISCORD_TOKEN, GUILD_ID, CHANNEL_ID, OPENAI_API_KEY/);
	});
	it('has no default owner, and falls back to the default on an unreadable number', () => {
		const cfg = loadConfig({ ...baseEnv, IDLE_CLOSE_MINUTES: 'abc', PANEL_PORT: '0', MUSIC_VOLUME: '250' });
		assert.equal(cfg.ownerId, null);
		assert.equal(cfg.idleCloseMs, 10 * 60_000);
		assert.equal(cfg.panelPort, 0);
		assert.equal(cfg.musicVolume, 1);
	});
	it('tool backend: a research model picks Responses even when DeepSeek is configured', () => {
		assert.equal(loadConfig({ ...baseEnv, DEEPSEEK_API_KEY: 'd', DELEGATION_MODEL: 'm' }).useResponsesDelegation, true);
		assert.equal(loadConfig({ ...baseEnv, DEEPSEEK_API_KEY: 'd' }).useResponsesDelegation, false);
		assert.equal(loadConfig({ ...baseEnv, DELEGATION_MODEL: 'm', TOOLS_BACKEND: 'client' }).useResponsesDelegation, false);
	});
	it('keeps the value intact when an .env.example line is copied with its note', () => {
		assert.equal(cleanEnvValue('small                        (tiny/base/small/medium/large-v3)'), 'small');
		assert.equal(cleanEnvValue('35  # percent'), '35');
		assert.equal(cleanEnvValue('"C:/path (a)"'), 'C:/path (a)', 'a quoted value is taken as it stands');
		assert.equal(cleanEnvValue('Hello (how are you)'), 'Hello (how are you)', 'a bracket after a single space is part of the value');
		const cfg = loadConfig({ ...baseEnv, LOCAL_STT_MODEL: 'small   (tiny/base)', MUSIC_VOLUME: '40  (percent)', LOCAL_TTS_AUTOSTART: '0   (by hand)' });
		assert.equal(cfg.localSttModel, 'small');
		assert.equal(cfg.musicVolume, 0.4);
		assert.equal(cfg.localTtsAutostart, false);
	});
	it('parses lists and the newer settings', () => {
		const cfg = loadConfig({ ...baseEnv, ADMIN_ROLE_IDS: '1, 2 ,', DAILY_LIVE_SECONDS: '3600', RECORD_TRANSCRIPTS: '0' });
		assert.deepEqual(cfg.adminRoleIds, ['1', '2']);
		assert.equal(cfg.dailyLiveSeconds, 3600);
		assert.equal(cfg.recordTranscripts, false);
	});
	it('VOICE_TARGETS: the primary pair comes first, duplicates and malformed entries are dropped', () => {
		assert.deepEqual(loadConfig(baseEnv).targets, [{ guildId: 'g', channelId: 'c' }], 'with none given there is exactly one target');
		const cfg = loadConfig({ ...baseEnv, VOICE_TARGETS: 'g2:c2, g:other, nonsense, g3:, :c4, g4:c4 ,, g2:c9' });
		assert.deepEqual(cfg.targets, [
			{ guildId: 'g', channelId: 'c' },
			{ guildId: 'g2', channelId: 'c2' },
			{ guildId: 'g4', channelId: 'c4' },
		]);
		assert.equal(cfg.guildId, 'g', 'GUILD_ID / CHANNEL_ID keep meaning the primary server');
		assert.equal(cfg.channelId, 'c');
	});
	it('MAX_LIVE_SESSIONS: defaults to 2, never drops below 1 and stays a whole number', () => {
		assert.equal(loadConfig(baseEnv).maxLiveSessions, 2);
		assert.equal(loadConfig({ ...baseEnv, MAX_LIVE_SESSIONS: '0' }).maxLiveSessions, 1);
		assert.equal(loadConfig({ ...baseEnv, MAX_LIVE_SESSIONS: '4' }).maxLiveSessions, 4);
		assert.equal(loadConfig({ ...baseEnv, MAX_LIVE_SESSIONS: '2.7' }).maxLiveSessions, 2);
		assert.equal(loadConfig({ ...baseEnv, MAX_LIVE_SESSIONS: 'abc' }).maxLiveSessions, 2);
	});
	it('understands the Turkish spelling of "off" under the Turkish locale', () => {
		setLocale('tr');
		try {
			const cfg = loadConfig({ ...baseEnv, RECORD_TRANSCRIPTS: 'kapalı', MEMORY: 'hayır' });
			assert.equal(cfg.recordTranscripts, false);
			assert.equal(cfg.memoryEnabled, false);
		} finally {
			setLocale('en');
		}
		assert.equal(loadConfig({ ...baseEnv, RECORD_TRANSCRIPTS: 'kapalı' }).recordTranscripts, true, 'the English bundle does not know that word');
	});
});

describe('MemoryStore', () => {
	it('adds a note, refuses a duplicate, deletes one and summarises the rest', async () => {
		const store = await new MemoryStore(path.join(dir, 'memory.json'), { now: () => 1000 }).load();
		// The note comes from speech, so it can arrive in Turkish even in an English session: a Turkish
		// capital I lower-cases to an i with a combining dot, and the dedup key folds it back onto the
		// note that is already there.
		await store.add('u1', 'kedisi Duman', { name: 'Jane' });
		await store.add('u1', 'KEDİSİ DUMAN'.toLowerCase());
		assert.equal(store.notesFor('u1').length, 1, 'the same note is not stored twice');
		await store.add('u1', 'exam on Friday');
		assert.ok(store.summaryFor('u1').includes('exam on Friday'));
		assert.equal(store.nameFor('u1'), 'Jane');
		assert.equal(await store.remove('u1', 'duman'), true);
		assert.equal(store.notesFor('u1').length, 1);
		await store.save();
		const reloaded = await new MemoryStore(path.join(dir, 'memory.json')).load();
		assert.equal(reloaded.notesFor('u1')[0].text, 'exam on Friday');
		assert.equal(await reloaded.clear('u1'), true);
	});
});

describe('DailyQuota', () => {
	it('adds the cumulative session seconds to the quota and starts again when the day rolls over', async () => {
		let now = Date.parse('2026-09-12T10:00:00Z');
		const quota = new DailyQuota({ limitSeconds: 100, now: () => now });
		const first = new SessionUsage(quota);
		assert.equal(first.report(40).status.exceeded, false);
		assert.equal(first.report(90).status.used, 90);
		assert.equal(quota.shouldWarn(), true);
		assert.equal(quota.shouldWarn(), false, 'the warning is given once');
		const second = new SessionUsage(quota);
		assert.equal(second.report(20).status.exceeded, true, 'a new session of 20 s -> 110 in total');
		now += 24 * 3_600_000;
		assert.equal(quota.status().exceeded, false, 'the next day starts from zero');
		assert.equal(quota.status().used, 0);
	});

	it('two servers reporting in turn are each charged their own seconds, not each other s totals', () => {
		// One base used to be shared by every session and compared against every server's running total,
		// so two servers reporting in turn were charged each other's totals as well as their own.
		const quota = new DailyQuota({ limitSeconds: 0, now: () => Date.parse('2026-09-12T10:00:00Z') });
		const alpha = new SessionUsage(quota);
		const beta = new SessionUsage(quota);
		for (let seconds = 50; seconds <= 750; seconds += 50) {
			alpha.report(seconds);
			beta.report(seconds);
		}
		assert.equal(quota.status().used, 1500);
	});

	it('a repeated or late report from a session adds nothing it has already added', () => {
		const quota = new DailyQuota({ limitSeconds: 0, now: () => Date.parse('2026-09-12T10:00:00Z') });
		const old = new SessionUsage(quota);
		old.report(300);
		const replacement = new SessionUsage(quota);
		replacement.report(10);
		assert.equal(old.report(300).delta, 0, 'the old session repeating its total is not charged again');
		assert.equal(old.report(290).delta, 0, 'nor is a total that went back');
		assert.equal(old.report(305).delta, 5, 'only what is new since its last report');
		assert.equal(quota.status().used, 315);
	});

	it('does not charge the whole session so far to the new day at midnight', () => {
		let now = Date.parse('2026-09-12T23:59:00Z');
		const quota = new DailyQuota({ limitSeconds: 0, now: () => now });
		const session = new SessionUsage(quota);
		session.report(3000);
		assert.equal(quota.status().used, 3000);
		now = Date.parse('2026-09-13T00:01:00Z');
		session.report(3120);
		assert.equal(quota.status().used, 120, 'the new day holds the two minutes after midnight, not 52 minutes');
	});

	it('keeps the file format: { day, usedSeconds }, read back after a restart', async () => {
		const file = path.join(dir, 'quota.json');
		const now = () => Date.parse('2026-09-12T10:00:00Z');
		const quota = await new DailyQuota({ limitSeconds: 600, file, now }).load();
		quota.add(61.4);
		await quota.pending;
		assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { day: '2026-09-12', usedSeconds: 61 });
		const reloaded = await new DailyQuota({ limitSeconds: 600, file, now }).load();
		assert.equal(reloaded.status().used, 61);
	});
});

describe('CharacterStore', () => {
	it('serialises concurrent saves, and backs a corrupt file up before starting from an empty schema', async () => {
		const file = path.join(dir, 'characters.json');
		const store = await new CharacterStore(file).load();
		await Promise.all([store.create({ name: 'A' }), store.create({ name: 'B' }), store.create({ name: 'C' })]);
		const parsed = JSON.parse(await readFile(file, 'utf8'));
		assert.equal(parsed.characters.length, 3);

		await writeFile(file, '{broken json', 'utf8');
		const logs = [];
		const recovered = await new CharacterStore(file, { log: (m) => logs.push(m) }).load();
		assert.equal(recovered.list().length, 0);
		assert.ok(logs.some((m) => m.includes('backup:')), logs.join(' | '));
	});
	it('validation: an empty name and an unknown voice are refused', async () => {
		const store = new CharacterStore(path.join(dir, 'c2.json'));
		await assert.rejects(() => store.create({ name: '  ' }), /name cannot be empty/);
		await assert.rejects(() => store.create({ name: 'X', voice: 'nope' }, { voices: ['marin'] }), /unknown voice/);
	});
});

describe('SpeakerAttribution', () => {
	it('lets an old keyword expire, and still recognises the owner by id when priority is off', () => {
		let now = 1000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		a.onFrame({ priority: true, active: ['o'] });
		a.noteTranscript('he got banned yesterday', { startMs: 0, endMs: 20 });
		assert.equal(a.ownerMatch(['ban']), 'ban', '"banned" matches the "ban" stem as a prefix');
		now += 20_000;
		a.onFrame({ priority: true, active: ['o'] });
		a.noteTranscript('hmm', { startMs: 20, endMs: 40 });
		assert.equal(a.ownerMatch(['ban']), null, 'the "banned" from 20 s ago no longer counts');

		const b = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		b.onFrame({ priority: false, active: ['o'] });
		assert.equal(b.isOwnerActive(), true, 'with priority off the owner is recognised by id');
		b.onFrame({ priority: false, active: ['z'] });
		assert.equal(b.isOwnerActive(), false);
	});

	it('matches the Turkish gate keywords against Turkish speech', () => {
		setLocale('tr');
		try {
			const a = new SpeakerAttribution({ ownerId: 'o' });
			a.onFrame({ priority: true, active: ['o'] });
			a.noteTranscript('şunu banla', { startMs: 0, endMs: 20 });
			assert.equal(a.ownerMatch(tList('keywords.words.ban')), 'ban', '"banla" matches the "ban" stem as a prefix');
			assert.equal(a.ownerMatch(tList('keywords.words.kick')), null, 'none of the kick keywords were said');
			assert.equal(a.ownerMatch(['=ban']), null, 'an "=word" entry only matches the bare word');
		} finally {
			setLocale('en');
		}
	});

	it('does not credit a transcript to the owner when the two speakers split it evenly', () => {
		const a = new SpeakerAttribution({ ownerId: 'o' });
		for (let i = 0; i < 10; i++) a.onFrame({ priority: true, active: ['o'] }); // 0-200
		for (let i = 0; i < 10; i++) a.onFrame({ priority: false, active: ['z'] }); // 200-400
		assert.equal(a.speakerAt(0, 400), false);
	});

	it('who said the command: somebody cutting in after the turn started does not change the answer', () => {
		let now = 10_000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		const frames = (n, frame) => {
			for (let i = 0; i < n; i++) a.onFrame(frame);
		};
		frames(50, { priority: true, active: ['o'] }); // 0-1000 ms: the owner
		a.noteTranscript('move Sam to that room', { startMs: 0, endMs: 1000 });
		now += 1200;
		frames(10, { priority: false, active: [] }); // silence, 1000-1200
		a.markTurn(); // the model started answering (audioMs 1200)
		now += 3000;
		frames(20, { priority: false, active: ['z'] }); // 1200-1600: somebody cut in
		a.noteTranscript('sorry what', { startMs: 1200, endMs: 1600 });

		const hit = a.commandSpeaker(['move']);
		assert.equal(hit?.owner, true, 'the owner said the command');
		const last = a.lastUtterance();
		assert.equal(last?.owner, true, 'a remark made after the turn does not count as the last word');
		assert.equal(a.lastUtterance({ turn: null })?.owner, false, 'without the cut-off the last word belongs to somebody else');
		assert.equal(a.lastUtterance({ turn: null })?.id, 'z');
	});

	it('closes the gate when somebody else says the keyword later, or rides on the keyword the owner said earlier', () => {
		let now = 10_000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] }); // 0-600
		a.noteTranscript('ban Alex', { startMs: 0, endMs: 600 });
		a.markTurn();
		now += 6000;
		for (let i = 0; i < 20; i++) a.onFrame({ priority: false, active: ['z'] }); // 600-1000
		a.noteTranscript('and Chris too', { startMs: 600, endMs: 1000 });
		a.markTurn(); // the model is answering somebody else
		const hit = a.commandSpeaker(['ban']);
		assert.equal(hit?.owner, true, 'the owner said the keyword last');
		const last = a.lastUtterance();
		assert.equal(last?.owner, false, 'but the last word was somebody else -> the gate has to refuse');
		assert.ok(last.at > hit.at);

		now += 1000;
		for (let i = 0; i < 20; i++) a.onFrame({ priority: false, active: ['z'] }); // 1000-1400
		a.noteTranscript('no do not ban him', { startMs: 1000, endMs: 1400 });
		a.markTurn();
		assert.equal(a.commandSpeaker(['ban'])?.owner, false, 'somebody else said the keyword most recently');
		assert.equal(a.commandSpeaker(['ban'])?.id, 'z');
	});

	it('reports a lagging transcript, and keeps the owner word across a session reset', () => {
		let now = 10_000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] }); // 0-600
		a.noteTranscript('hello', { startMs: 0, endMs: 600 });
		for (let i = 0; i < 250; i++) a.onFrame({ priority: true, active: ['o'] }); // 600-5600
		a.markTurn(); // the turn is at 5600 but the last words ended at 600 -> the transcript is still on its way
		assert.equal(a.transcriptLagging(), true);
		a.noteTranscript('ban him', { startMs: 4800, endMs: 5500 });
		assert.equal(a.transcriptLagging(), false);
		assert.equal(a.commandSpeaker(['ban'])?.owner, true);

		a.resetSession();
		assert.equal(a.audioMs, 0);
		assert.equal(a.turn, null);
		assert.equal(a.commandSpeaker(['ban'])?.owner, true, 'the owner word survives a short drop');
		now += 20_000;
		assert.equal(a.commandSpeaker(['ban'])?.owner, true, 'outside the window, but nobody cut in (continuity)');
		now += 45_000;
		assert.equal(a.commandSpeaker(['ban']), null, 'past the continuity limit (60 s)');
	});

	it('continuity: the owner answers the question 20 s later with a bare name, unless somebody else cuts in', () => {
		let now = 10_000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] }); // 0-600
		a.noteTranscript('give me the twin role', { startMs: 0, endMs: 600 });
		now += 20_000;
		for (let i = 0; i < 20; i++) a.onFrame({ priority: true, active: ['o'] }); // 600-1000
		a.noteTranscript('chillz', { startMs: 600, endMs: 1000 });
		a.markTurn();
		assert.equal(a.commandSpeaker(['role'])?.owner, true, 'the "role" the owner said 20 s ago still counts');

		const b = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) b.onFrame({ priority: true, active: ['o'] });
		b.noteTranscript('give me the twin role', { startMs: 0, endMs: 600 });
		now += 10_000;
		for (let i = 0; i < 20; i++) b.onFrame({ priority: false, active: ['z'] }); // 600-1000
		b.noteTranscript('me too please', { startMs: 600, endMs: 1000 });
		now += 10_000;
		for (let i = 0; i < 20; i++) b.onFrame({ priority: true, active: ['o'] }); // 1000-1400
		b.noteTranscript('chillz', { startMs: 1000, endMs: 1400 });
		b.markTurn();
		assert.equal(b.commandSpeaker(['role']), null, 'somebody cut in: the old keyword is void');
	});
});

describe('MemoryStore.search', () => {
	it('finds a note by whole words, across everybody, and ignores a coincidental substring', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-search-'));
		const store = await new MemoryStore(path.join(dir, 'memory.json')).load();
		await store.add('1', "the user wants me to laugh when somebody says 'banana'", { name: 'Kaan' });
		await store.add('2', 'a member of our server', { name: 'Hasan' });
		await store.add('1', 'favourite song: Rammstein - Puppe', { name: 'Kaan' });

		assert.deepEqual(
			store.search('favourite song').map((hit) => hit.text),
			['favourite song: Rammstein - Puppe'],
		);
		assert.equal(store.search('banana')[0]?.name, 'Kaan', 'a quoted keyword is still searchable');
		assert.equal(store.search('erver').length, 0, 'a substring of a word is not a match');
		assert.equal(store.search('nothing like this at all').length, 0);
		assert.equal(store.search('').length, 3, 'no query returns the most recent notes');
		await rm(dir, { recursive: true, force: true });
	});
});

describe('SpeakerAttribution: keyword matching', () => {
	it('matches an inflected form of a stem but not an unrelated word that shares it', () => {
		let now = 10_000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] });
		a.noteTranscript('ban that troublemaker', { startMs: 0, endMs: 600 });
		assert.equal(a.commandSpeaker(['ban'])?.owner, true, '"ban" is a real command word here');

		const b = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) b.onFrame({ priority: true, active: ['o'] });
		b.noteTranscript('we went there last week', { startMs: 0, endMs: 600 });
		assert.equal(b.commandSpeaker(['=go', 'move']), null, 'everyday speech is not a move command');
	});

	it('honours an "=word" entry as a stem, not as a prefix', () => {
		const a = new SpeakerAttribution({ ownerId: 'o' });
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] });
		a.noteTranscript('taking the long way', { startMs: 0, endMs: 600 });
		assert.equal(a.commandSpeaker(['=take']), null, '"taking" must not satisfy an exact "take"');
		assert.equal(a.commandSpeaker(['take']), null, 'a three letter prefix still needs the stem at the start');

		const b = new SpeakerAttribution({ ownerId: 'o' });
		for (let i = 0; i < 30; i++) b.onFrame({ priority: true, active: ['o'] });
		b.noteTranscript('take him to the lounge', { startMs: 0, endMs: 600 });
		assert.equal(b.commandSpeaker(['=take'])?.word, 'take');
	});

	// Live failure: the owner said "herkesi bu odaya ceksene" and "work zone odasina tasir misin", and
	// the gate answered "the owner did not say the word" to both. A Turkish verb is almost never heard
	// bare, so a stem has to match the mood glued onto it -- without letting an unrelated word that
	// merely starts with the same three letters through.
	// Heard live: "pardon, silme" -- do not delete -- and fifty more messages went. In Turkish the
	// negative is built by gluing -ma/-me onto the verb, so the negated word CONTAINS the positive one
	// and a prefix match finds it. Saying "do not" has to be the end of it.
	it('does not read a negated verb as the command', () => {
		setLocale('tr');
		try {
			const said = (text, words) => {
				const a = new SpeakerAttribution({ ownerId: 'o' });
				for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'], present: ['o'], sent: true });
				a.noteTranscript(text, { startMs: 0, endMs: 900 });
				return a.commandSpeaker(words);
			};
			const del = tList('keywords.words.delete');
			const move = tList('keywords.words.move');
			for (const text of ['pardon silme', 'sakin silme onu', 'silmeyin onlari']) {
				assert.equal(said(text, del), null, `telling it NOT to must not open the gate: ${text}`);
			}
			assert.equal(said('onu tasima', move), null, 'the same for a stem entry');
			// And the words that merely begin the same way are still the command: -meli is "should" and
			// -mek is the infinitive, neither of them a negative.
			for (const text of ['mesajlari sil', 'silmek istiyorum', 'silmeli miyiz']) {
				assert.ok(said(text, del), `this one really is a request to delete: ${text}`);
			}
		} finally {
			setLocale('en');
		}
	});

	it('matches a Turkish command stem through its suffixes, and not through a look-alike word', () => {
		setLocale('tr');
		try {
			const move = tList('keywords.words.move');
			const said = (text) => {
				const a = new SpeakerAttribution({ ownerId: 'o' });
				for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] });
				a.noteTranscript(text, { startMs: 0, endMs: 900 });
				return a.commandSpeaker(move);
			};
			for (const text of [
				'purna odasindakilerin hepsini buraya ceksene',
				'zxcaotic i alip asagi odaya indir',
				'dorduncu kisiyi work zone odasina tasir misin',
				'beni yanina cekebilir misin',
				'hadi sunu buraya cekelim',
				'onu ustteki odaya cikar',
			]) {
				assert.ok(said(text)?.owner, `the owner really said a move word in: ${text}`);
			}
			for (const text of [
				'cekirdek yiyorum',
				'cok cekingen biri',
				'gecen hafta gelmisti',
				'gecmis olsun',
				'burasi genis bir alan',
				'atlar kosuyor',
			]) {
				assert.equal(said(text), null, `ordinary speech must not open the gate: ${text}`);
			}
		} finally {
			setLocale('en');
		}
	});

	it('stamps a sequence on every fragment so two in the same millisecond stay ordered', () => {
		const now = 10_000;
		const a = new SpeakerAttribution({ ownerId: 'o', now: () => now });
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['o'] });
		a.noteTranscript('move him to the lounge', { startMs: 0, endMs: 600 });
		for (let i = 0; i < 20; i++) a.onFrame({ priority: false, active: ['z'] });
		a.noteTranscript('no do not', { startMs: 600, endMs: 1000 });
		const hit = a.commandSpeaker(['move']);
		const last = a.lastUtterance();
		assert.equal(hit.at, last.at, 'the wall clock cannot separate them');
		assert.ok(last.seq > hit.seq, 'the sequence still puts the interjection after the command');
	});
});

describe('provider.js', () => {
	it('sends text to DeepSeek and images to OpenAI', async () => {
		const calls = [];
		const openai = { responses: { create: async (p) => (calls.push(['openai', p]), { output_text: 'o' }) } };
		const deepseek = { client: { chat: { completions: { create: async (p) => (calls.push(['deepseek', p]), { choices: [{ message: { content: 'd' } }] }) } } }, model: 'deepseek-chat' };
		const provider = createTextProvider({ openai, textModel: 'gpt-x', deepseek });
		assert.equal(provider.kind, 'deepseek');
		assert.equal(await provider.complete({ instructions: 'i', input: 'x' }), 'd');
		assert.equal(await provider.completeWithImages({ instructions: 'i', input: [] }), 'o');
		assert.equal(calls[1][1].model, 'gpt-x');
		assert.equal(await provider.research('question'), 'd');
		assert.ok(provider.describe().includes('DeepSeek'));
	});
	it('providerFromDeps works with the legacy deps bag and accepts a plain `model` field', async () => {
		const deps = { textApi: 'responses', model: 'm', textClient: { responses: { create: async () => ({ output_text: 'ok' }) } } };
		const provider = providerFromDeps(deps);
		assert.equal(provider.available, true);
		assert.equal(await provider.research('q'), 'ok');
	});
});
