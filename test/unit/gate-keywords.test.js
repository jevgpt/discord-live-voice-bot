import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpeakerAttribution } from '../../src/attribution.js';
import { setLocale, tList } from '../../src/i18n/index.js';
import { toolMeta } from '../../src/tools.js';

// The gate asks whether the owner said the command word. That question only means something when the
// command word is not also half of everyday speech: in English a keyword used to match anything that
// began with it, so "banana" opened the ban tools, "clearly" the deletions and "sounds good" the voice
// ones; in Turkish "bana" (to me) opened the ban tools and "konusalim" the thread ones.

/** Did the owner, alone in the audio, say one of these words in `text`? */
function said(text, words) {
	const a = new SpeakerAttribution({ ownerId: 'o' });
	for (let i = 0; i < 40; i++) a.onFrame({ priority: true, active: ['o'], present: ['o'], sent: true });
	a.noteTranscript(text, { startMs: 0, endMs: 800 });
	return a.commandSpeaker(words)?.owner === true;
}

const group = (name) => tList(`keywords.words.${name}`);
const gateOf = (tool) => toolMeta().find((entry) => entry.name === tool)?.keywords ?? [];

function inTurkish(fn) {
	setLocale('tr');
	try {
		fn();
	} finally {
		setLocale('en');
	}
}

describe('English gate words: whole words and their forms', () => {
	it('does not hear a command in everyday words that merely start with one', () => {
		const cases = [
			['ban', 'I had a banana for lunch'],
			['ban', 'my band plays on friday'],
			['ban', 'I went to the bank'],
			['ban', 'pardon? I did not catch that'],
			['ban', 'please forgive me'],
			['voice', 'that sounds good to me'],
			['delete', 'clearly that was a joke'],
			['event', 'we will get there eventually'],
			['everyone', 'I am over here'],
			['kick', 'the kickoff is at nine'],
		];
		for (const [name, text] of cases) assert.equal(said(text, group(name)), false, `${name}: ${text}`);
	});

	it('still hears the command word and its ordinary forms', () => {
		const cases = [
			['ban', 'ban him'],
			['ban', 'he should be banned'],
			['ban', 'banning Sam now'],
			['ban', 'unban Chris'],
			['kick', 'kick Sam out'],
			['kick', 'kicking him'],
			['delete', 'delete the channel'],
			['delete', 'deleting it now'],
			['delete', 'removed the role'],
			['delete', 'clear the reactions'],
			['voice', 'mute Jane'],
			['event', 'events this week'],
			['everyone', 'ping everyone'],
			['move', 'moving Jane to the lounge'],
			['cancel', 'cancel movie night'],
			['prune', 'prune the inactive members'],
		];
		for (const [name, text] of cases) assert.equal(said(text, group(name)), true, `${name}: ${text}`);
	});

	it('hears the commands that went quiet when the words stopped being prefixes', () => {
		assert.equal(said('configure the bot', group('setting')), true);
		assert.equal(said('can you reconfigure nothing', group('setting')), false);
		assert.equal(said('get rid of the role', gateOf('delete_role')), true);
		assert.equal(said('get rid of movie night', gateOf('cancel_event')), true);
		assert.equal(said('that riddle again', gateOf('delete_role')), false);
	});

	it('does not hear a command in a set phrase that holds the word', () => {
		const cases = [
			['kick', 'we kick off at nine'],
			['kick', 'the match kicked off late'],
			['kick', 'boot up the computer first'],
			['kick', 'it is booting up'],
			['timeout', 'silence is golden'],
			['setting', 'silence is golden'],
		];
		for (const [name, text] of cases) assert.equal(said(text, group(name)), false, `${name}: ${text}`);
		assert.equal(said('kick him off the server', group('kick')), true, 'the verb with its object between is still the verb');
		assert.equal(said('boot him', group('kick')), true);
		assert.equal(said('silence him', group('timeout')), true);
	});

	it('keeps a pinned entry to the word and its plural', () => {
		assert.equal(said('make a new room', group('channel')), true);
		assert.equal(said('two rooms', group('channel')), true);
		assert.equal(said('a roomy lounge', group('channel')), false);
		assert.equal(said('my roommate', group('channel')), false);
	});
});

describe('Turkish gate words: prefixes without their look-alikes', () => {
	it('does not hear a command in a word that only starts like one', () => {
		inTurkish(() => {
			const cases = [
				['ban', 'banyoya gidiyorum'],
				['ban', 'bana bir şarkı aç'],
				['ban', 'bankaya uğradım'],
				['ban', 'beni affet'],
				['channel', 'odaklanamıyorum'],
				['delete', 'silah sesi geldi'],
				['thread', 'biraz konuşalım'],
				['move', 'toplantı uzun sürdü'],
				['kick', 'kediyi kovaladı'],
				['voice', 'sesli kanala gel'],
				['kick', 'yeni bir çıkartma yükledim'],
				['delete', 'silmiyorum merak etme'],
			];
			for (const [name, text] of cases) assert.equal(said(text, group(name)), false, `${name}: ${text}`);
		});
	});

	it('still hears the command through its suffixes', () => {
		inTurkish(() => {
			const cases = [
				['ban', 'şunu banla'],
				['ban', 'banlasana onu'],
				['ban', 'banını kaldır'],
				['ban', 'yasağını kaldır'],
				['channel', 'odaya gel'],
				['delete', 'mesajları sil'],
				['delete', 'silinsin hepsi'],
				['delete', 'silmek istiyorum'],
				['kick', 'kovsana onu'],
				['kick', 'onu kovar mısın'],
				['kick', 'onu sesten at'],
				['thread', 'konuyu kapat'],
				['move', 'herkesi buraya topla'],
				['voice', 'sesini kapat'],
				['cancel', 'etkinliği iptal et'],
			];
			for (const [name, text] of cases) assert.equal(said(text, group(name)), true, `${name}: ${text}`);
		});
	});

	// The verbal noun is made with the same -ma/-me as the negative, and is asking for the thing, not
	// refusing it: "I want you to delete the channel".
	it('hears the command in its verbal noun, which only looks like the negative', () => {
		inTurkish(() => {
			const cases = [
				['delete', 'kanalı silmeni istiyorum'],
				['delete', 'rolü silmen lazım'],
				['delete', 'mesajları silmeni rica ediyorum'],
				['delete', 'silmesini istiyorum'],
				['delete', 'silmeyi unutma'],
				['ban', 'onu banlaman lazım'],
			];
			for (const [name, text] of cases) assert.equal(said(text, group(name)), true, `${name}: ${text}`);
		});
	});

	// "Banlama" is "do not ban": the negative sits after the -la that makes a verb of "ban", and the
	// prefix match on "ban" never looked past it.
	it('does not hear a command in its negative, after a verb made from a noun either', () => {
		inTurkish(() => {
			const cases = [
				['ban', 'onu banlama'],
				['ban', 'yasaklama onu'],
				['channel', 'sakın kilitleme'],
				['delete', 'silmesin'],
				['delete', 'silmeyin lütfen'],
				['delete', 'pardon, silme'],
				['pin', 'sabitleme'],
			];
			for (const [name, text] of cases) assert.equal(said(text, group(name)), false, `${name}: ${text}`);
			assert.equal(said('banlamak istiyorum', group('ban')), true, 'the infinitive is not a negative');
			assert.equal(said('kanalı kilitle', group('channel')), true);
		});
	});
});

describe('destructive tools gate on the verb, not on the thing', () => {
	// Naming a thing is not asking for it to go: "this room is too loud" must not be what opens a
	// channel deletion, "the role list" a role deletion.
	const TOOLS = {
		delete_channel: { object: 'this channel is too loud', verb: 'delete the spam channel' },
		delete_role: { object: 'what role do I have', verb: 'delete the old role' },
		delete_thread: { object: 'that thread was funny', verb: 'delete that thread' },
		delete_emoji: { object: 'nice emoji', verb: 'remove that emoji' },
		delete_sticker: { object: 'nice sticker', verb: 'delete the sticker' },
		delete_webhook: { object: 'the webhook posts news', verb: 'delete the webhook' },
		delete_automod_rule: { object: 'the automod rule is strict', verb: 'delete the swearing rule' },
		clear_reactions: { object: 'so many reactions', verb: 'clear the reactions' },
		cancel_event: { object: 'the event starts at nine', verb: 'cancel the event' },
		prune_members: { object: 'this server is big', verb: 'prune the inactive members' },
		voice_disconnect: { object: 'your voice is nice', verb: 'disconnect Sam' },
	};

	it('opens each one on its verb and not on its object', () => {
		for (const [tool, { object, verb }] of Object.entries(TOOLS)) {
			const words = gateOf(tool);
			assert.ok(words.length, `${tool} must be gated`);
			assert.equal(said(object, words), false, `${tool} must not open on "${object}"`);
			assert.equal(said(verb, words), true, `${tool} must open on "${verb}"`);
		}
	});

	it('does the same in Turkish', () => {
		inTurkish(() => {
			const turkish = {
				delete_channel: { object: 'bu kanal çok gürültülü', verb: 'spam kanalını sil' },
				delete_role: { object: 'rolüm ne', verb: 'eski rolü sil' },
				cancel_event: { object: 'etkinlik dokuzda', verb: 'etkinliği iptal et' },
				voice_disconnect: { object: 'sesin çok güzel', verb: 'onu sesten çıkar' },
			};
			// The gate lists were read when the tools loaded, in English; the Turkish groups are the ones a
			// Turkish bot loads, so they are read here by the same group names.
			const groups = { delete_channel: 'delete', delete_role: 'delete', cancel_event: 'cancel', voice_disconnect: 'kick' };
			for (const [tool, { object, verb }] of Object.entries(turkish)) {
				assert.equal(said(object, group(groups[tool])), false, `${tool} must not open on "${object}"`);
				assert.equal(said(verb, group(groups[tool])), true, `${tool} must open on "${verb}"`);
			}
		});
	});

	it('names in the gate the same group the Turkish case reads', () => {
		assert.deepEqual(gateOf('delete_channel'), group('delete'));
		assert.deepEqual(gateOf('delete_role'), group('delete'));
		assert.deepEqual(gateOf('cancel_event'), group('cancel'));
		assert.deepEqual(gateOf('voice_disconnect'), group('kick'));
		assert.deepEqual(gateOf('prune_members'), group('prune'));
	});
});
