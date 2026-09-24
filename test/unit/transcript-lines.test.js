import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { ActivityLog } from '../../src/panel.js';
import { ChannelReader } from '../../src/reader.js';
import { SAMPLES_PER_FRAME_24K, SpeakerMixer } from '../../src/audio.js';

// What reaches the model as "X said this" is decided in GuildSession.onTranscript, and until now
// nothing drove that path end to end: the fake realtime server in the selftest only ever sends the
// bot's own audio back, never an input transcript. These tests put real audio through the real mixer,
// hand the resulting frames to the real attribution, then feed transcript fragments in the way the
// realtime API delivers them (as deltas with their own start/end) and read what the model was told.

// PRIME_FRAMES 1: what a test pushes on a tick comes out on that tick, so the positions it writes are the audio's.
const ENV = { DISCORD_TOKEN: 't', GUILD_ID: 'g', CHANNEL_ID: 'g-voice', OPENAI_API_KEY: 'k', OWNER_ID: 'owner', PRIME_FRAMES: '1' };

// The accounts behind the display names, so that a test can make two people share a name.
const ACCOUNTS = { owner: 'serefsiz', guest: 'pompomlatte', third: 'itsbluzerxs' };

function makeRoom(names = { owner: 'Kaan', guest: 'Adem', third: 'Melis' }) {
	const voice = { id: 'g-voice', name: 'Lounge', type: ChannelType.GuildVoice, parent: null, parentId: null, rawPosition: 0 };
	const members = new Map(
		Object.entries(names).map(([id, displayName]) => [
			id,
			{
				id,
				displayName,
				user: { id, username: ACCOUNTS[id] ?? displayName.toLowerCase(), bot: false },
				voice: { channelId: voice.id, channel: voice },
			},
		]),
	);
	return {
		id: 'g',
		name: 'Guild',
		channels: { cache: new Map([[voice.id, voice]]) },
		members: { cache: members, fetch: async () => new Map() },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
	};
}

/**
 * A session with a fake realtime socket: everything the model would be told is collected instead of
 * being sent. The audio path is real (SpeakerMixer -> SpeakerAttribution).
 */
function makeRoomSession({ names, ...env } = {}) {
	const activity = new ActivityLog();
	const told = [];
	const logged = [];
	const cfg = loadConfig({ ...ENV, ...env });
	const session = new GuildSession({
		cfg,
		client: { user: { id: 'bot' } },
		guild: names ? makeRoom(names) : makeRoom(),
		channelId: 'g-voice',
		store: { getActive: () => null, list: () => [], setActive: async () => true },
		memory: null,
		quota: { enabled: false, status: () => ({ used: 0, limit: 0, exceeded: false }), sessionStarted() {}, shouldWarn: () => false },
		reader: new ChannelReader(),
		recentActions: new RecentActions(),
		activity,
		record: (event) => activity.push(event),
		provider: { textClient: {}, textApi: 'responses', textModel: 'm', describe: () => 'mock' },
		openai: {},
		localStt: {},
		localServer: null,
		log: (line) => logged.push(String(line)),
		summarize: async () => ({ summary: '' }),
	});
	session.live = { ready: true, appendContext: (kind, text) => told.push({ kind, text }), sendAudio: () => true };

	const mixer = new SpeakerMixer();
	// Exactly what the session does: the owner only holds the floor when OWNER_PRIORITY says so.
	if (cfg.ownerPriority && cfg.ownerId) mixer.setPriority(cfg.ownerId);
	const speech = new Int16Array(SAMPLES_PER_FRAME_24K).fill(3000);
	/** `who` speaks for `frames` 20 ms frames; several ids at once means they talk over each other. */
	const voices = (who, frames) => {
		const ids = Array.isArray(who) ? who : [who];
		for (let i = 0; i < frames; i++) {
			for (const id of ids) mixer.push(id, speech);
			const frame = mixer.tick();
			session.attribution.onFrame({ priority: frame.priority, active: frame.active, sent: true });
		}
	};
	/** Nobody is talking: the audio position still advances, which is what the transcript is timed against. */
	const quiet = (frames) => {
		for (let i = 0; i < frames; i++) {
			const frame = mixer.tick();
			session.attribution.onFrame({ priority: frame.priority, active: frame.active, sent: true });
		}
	};
	const at = () => session.attribution.audioMs;
	/** What the command shortcut did with each finished line (it bypasses the model entirely). */
	const commanded = [];
	session.runVoiceCommand = (item) => commanded.push(item);
	const delta = (text, startMs, endMs) => session.onTranscript({ speaker: 'user', text, startMs, endMs });
	const lines = () => told.filter((entry) => entry.kind === 'thinking').map((entry) => entry.text);
	const spoken = () =>
		activity.events
			.filter((event) => event.kind === 'voice' && event.direction === 'in')
			.map((event) => ({ who: event.who, text: event.text }));
	/** The same lines with the uncertainty the record carries alongside them. */
	const spokenMeta = () =>
		activity.events
			.filter((event) => event.kind === 'voice' && event.direction === 'in')
			.map((event) => ({ who: event.who, unclear: event.meta?.unclear ?? false, speakers: event.meta?.speakers ?? null }));
	const flush = () => session.flushTranscript('user');
	return { session, cfg, told, logged, voices, quiet, at, delta, flush, lines, spoken, spokenMeta, commanded, activity };
}

describe('two people with the same display name', () => {
	// Seen live: the owner and somebody else both showed as the same word, so "X said this" identified
	// nobody and the model had no way to question it.
	it('says which account it was, and only where the name really clashes', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ names: { owner: 'absolutely livid', guest: 'absolutely livid', third: 'itsbluzer' } });
		// channelId is read off the live connection; the session is built without one here.
		room.session.voice.connection = { joinConfig: { channelId: 'g-voice' } };
		for (const id of ['owner', 'guest', 'third']) {
			room.session.guild.voiceStates.cache.set(id, { id, channelId: 'g-voice', member: room.session.guild.members.cache.get(id) });
		}
		assert.match(room.session.speakerLabel('owner'), /serefsiz/, 'the clashing name carries its account');
		assert.match(room.session.speakerLabel('guest'), /pompomlatte/);
		assert.equal(room.session.speakerLabel('third'), 'itsbluzer', 'a name nobody shares is left alone');

		room.voices('guest', 40);
		room.delta('ben soyledim', 0, 800);
		t.mock.timers.tick(1300);
		assert.match(room.lines().join(' '), /pompomlatte/, 'and the model is told which one spoke');
	});
});

describe('who the model is told said a line', () => {
	it('puts one speaker on their own line', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession();
		room.voices('guest', 30); // 600 ms
		room.delta('merhaba', 0, 600);
		t.mock.timers.tick(1300);

		const said = room.lines();
		assert.equal(said.length, 1, `exactly one line reached the model: ${JSON.stringify(said)}`);
		assert.match(said[0], /Adem/, 'and it carries the name of the person who actually spoke');
		assert.deepEqual(room.spoken(), [{ who: 'guest', text: 'merhaba' }]);
	});

	// The reported bug: the owner gave a command, somebody else spoke in the same breath, and the whole
	// line came back with the other person's name on it, because the buffer kept only the LAST fragment's
	// speaker. Two people in one flush are two lines now.
	it('splits one flush into a line each when two people take turns', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession();
		room.voices('owner', 45);
		room.delta('purna odasindakileri buraya cek ', 0, 900);
		room.voices('guest', 45);
		room.delta('ben gelmiyorum ama', 900, 1800);
		t.mock.timers.tick(1300);

		assert.deepEqual(room.spoken(), [
			{ who: 'owner', text: 'purna odasindakileri buraya cek' },
			{ who: 'guest', text: 'ben gelmiyorum ama' },
		]);
		const said = room.lines();
		assert.equal(said.length, 2, 'the model is told about two lines, not one');
		assert.match(said[0], /Kaan/);
		assert.match(said[1], /Adem/);
	});

	it('names nobody when the two voices are on top of each other, and says who they were', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		room.voices(['owner', 'guest'], 50); // a full second of both at once
		room.delta('melisi banla', 0, 1000);
		t.mock.timers.tick(1300);

		assert.deepEqual(room.spoken(), [{ who: null, text: 'melisi banla' }]);
		const said = room.lines().join(' ');
		assert.match(said, /Kaan/, 'both candidates are named');
		assert.match(said, /Adem/);
		// The command shortcut bypasses the model entirely, so it is the one path with no second check.
		assert.deepEqual(
			room.commanded.map((item) => item.id),
			[null],
			'the line is handed on with nobody owning it',
		);
		const before = room.logged.length;
		GuildSession.prototype.runVoiceCommand.call(room.session, room.commanded[0]);
		assert.ok(
			room.logged.slice(before).some((line) => /not run/.test(line)),
			'and the real guard refuses to run anything from it',
		);
	});

	it('records the uncertainty of a tangled line, and tells the model no name at all', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		// One clean line first, so that there is a name on the record to go stale.
		room.voices('guest', 40);
		room.delta('once ben', 0, 800);
		t.mock.timers.tick(1300);
		assert.equal(room.session.lastAnnouncedUser, 'guest');

		room.voices(['owner', 'guest'], 50);
		room.delta('sonra ikimiz', 800, 1800);
		t.mock.timers.tick(1300);

		assert.deepEqual(room.spokenMeta().at(-1), {
			who: null,
			unclear: true,
			speakers: ['guest', 'owner'],
		});
		assert.equal(room.session.lastAnnouncedUser, 'guest', 'the model was told no name, so none has been remembered');
	});

	// How clean a line has to be depends on what the command would do. Refusing every mixed line took the
	// music controls away from a lively channel: "skip the queue", asked four times in a row, was answered
	// four times and never done. The worst case of a mixed "skip" is the wrong song.
	it('weighs a mixed line against what the command would actually do', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		// 600 ms alone then 800 ms shared: the owner holds three sevenths of it on their own, which is
		// enough to be the likeliest voice and not enough to be the only one.
		room.voices('owner', 30);
		room.voices(['owner', 'guest'], 40);
		room.delta('skip the song', 0, 1400);
		t.mock.timers.tick(1300);

		const item = room.commanded.at(-1);
		assert.equal(item.id, 'owner', 'the line still carries the likeliest name');
		assert.equal(item.mixed, true);

		const before = room.logged.length;
		GuildSession.prototype.runVoiceCommand.call(room.session, item);
		assert.equal(
			room.logged.slice(before).filter((line) => /not run/.test(line)).length,
			0,
			'a mixed line may still skip a song',
		);

		// The same line, a command that changes something outside the bot's own playback.
		const after = room.logged.length;
		GuildSession.prototype.runVoiceCommand.call(room.session, { ...item, line: 'leave the channel' });
		assert.ok(
			room.logged.slice(after).some((line) => /not run/.test(line)),
			'and may not move the bot out of the channel',
		);
	});

	// A mixed "read the staff channel" is harmless only as far as the person asking may read it, and on a
	// line two voices share, whose request it was is the one thing not known. The owner's authority goes
	// only on a line that was the owner's alone.
	it('runs a mixed line s harmless command for nobody in particular', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		room.voices('owner', 30);
		room.voices(['owner', 'guest'], 40);
		room.delta('read the general channel', 0, 1400);
		t.mock.timers.tick(1300);
		const item = room.commanded.at(-1);
		assert.equal(item.id, 'owner');
		assert.equal(item.mixed, true);
		assert.equal(item.owner, false, 'the owner was not alone in it');

		// The read is remembered per person asking; what it was remembered under says who that was.
		const asked = [];
		room.session.taskDeps = { ...room.session.taskDeps, recentActions: { recall: (signature) => (asked.push(signature), { speak: false, text: '', ok: true }), remember() {} } };
		GuildSession.prototype.runVoiceCommand.call(room.session, item);
		GuildSession.prototype.runVoiceCommand.call(room.session, { ...item, mixed: false, owner: true });
		GuildSession.prototype.runVoiceCommand.call(room.session, { ...item, mixed: false, owner: false });
		t.mock.timers.reset();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(asked, ['read:general:-', 'read:general:owner', 'read:general:-']);
	});

	it('runs nothing at all off a line nobody owns', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		const before = room.logged.length;
		GuildSession.prototype.runVoiceCommand.call(room.session, { line: 'skip the song', id: null, mixed: true, endMs: 100, candidates: [] });
		assert.ok(
			room.logged.slice(before).some((line) => /not run/.test(line)),
			'no name, no command, however harmless',
		);
	});

	it('gives a line the turn of its own last position', () => {
		const room = makeRoomSession();
		assert.equal(room.session.lineTurn({ endMs: 900 }).audioMs, 900);
		assert.equal(room.session.lineTurn({ endMs: 1800 }).audioMs, 1800);
		// No position at all: the current head of the audio is the only honest answer.
		room.voices('guest', 10);
		assert.equal(room.session.lineTurn({ endMs: null }).audioMs, room.at());
	});

	it('finishes the half-said line when the session is stopped', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession();
		room.voices('guest', 30);
		room.delta('yarim kalan', 0, 600);
		room.session.stop();
		assert.deepEqual(room.spoken(), [{ who: 'guest', text: 'yarim kalan' }]);
		assert.equal(room.session.transcriptBuffers.size, 0, 'and no timer is left armed on a buffer nobody owns');
		t.mock.timers.tick(2000);
		assert.equal(room.spoken().length, 1, 'nor is it recorded twice');
	});

	it('gives each line its own end position, so one speaker cannot borrow another line s turn', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession();
		room.voices('owner', 45);
		room.delta('birinci ', 0, 900);
		room.voices('guest', 45);
		room.delta('ikinci', 900, 1800);
		t.mock.timers.tick(1300);
		// Reusing the whole flush's final position would let the SECOND speaker's audio count as "before
		// the turn" for the FIRST line's command, which is the widest possible window and exactly the hole
		// the owner gate exists to close.
		assert.deepEqual(
			room.commanded.map((item) => [item.id, item.endMs]),
			[
				['owner', 900],
				['guest', 1800],
			],
		);
	});

	it('stops waiting for silence once a line has run too long', (t) => {
		// The silence timer is left at its real length on purpose: a delta arrives every second, so that
		// timer never fires and the only thing that can close this line is the cap. The previous version of
		// this test ticked straight past 1200 ms, so it was the ordinary timer being measured, not the cap.
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
		const room = makeRoomSession();
		let position = 0;
		for (let i = 0; i < 10; i++) {
			room.voices('guest', 15);
			room.delta(`soz${i} `, position, position + 300);
			position += 300;
			if (room.spoken().length) break;
			t.mock.timers.tick(1000); // under the 1200 ms silence timer, so it is re-armed rather than fired
		}
		assert.equal(room.spoken().length, 1, 'the line closed on the cap, without the room ever falling silent');
		assert.ok(room.spoken()[0].text.split(' ').length >= 8, `and it holds what was said: ${room.spoken()[0].text}`);
	});

	it('finishes the half-said line before the audio timeline restarts', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession();
		room.voices('guest', 30);
		room.delta('yarim kalan', 0, 600);
		room.session.flushTranscript('user'); // what the live 'ready' path does before resetSession
		assert.deepEqual(room.spoken(), [{ who: 'guest', text: 'yarim kalan' }]);
		room.session.attribution.resetSession();
		t.mock.timers.tick(1300);
		assert.equal(room.spoken().length, 1, 'and it is not recorded a second time by a stale timer');
	});

	// Measured in a real session: three people taking turns, and every single line came back as "two
	// voices at once", so not one voice command ran all evening. Two causes, both of them ours: the mixer
	// kept somebody in the speaking list for half a second after they stopped, so a handover looked like
	// an overlap; and one contaminated fragment condemned the whole line it sat in.
	it('does not call an ordinary handover an overlap', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		// A talks in bursts, the way speech really arrives, then a quarter second later B answers.
		const burst = (who, bursts) => {
			for (let b = 0; b < bursts; b++) {
				room.voices(who, 10);
				room.quiet(4);
			}
		};
		const start = room.at();
		burst('guest', 5);
		const guestEnd = room.at();
		room.quiet(13); // 260 ms between the turns
		const thirdStart = room.at();
		burst('third', 5);
		const thirdEnd = room.at();

		// The transcript arrives in fragments, including one right at the start of the second turn.
		room.delta('bence ', start, start + 400);
		room.delta('olmaz oyle ', start + 400, guestEnd);
		room.delta('neden ', thirdStart, thirdStart + 300);
		room.delta('olmasin ki', thirdStart + 300, thirdEnd);
		t.mock.timers.tick(1300);

		assert.deepEqual(
			room.spoken(),
			[
				{ who: 'guest', text: 'bence olmaz oyle' },
				{ who: 'third', text: 'neden olmasin ki' },
			],
			'two turns, two names, no overlap anywhere',
		);
		assert.deepEqual(
			room.commanded.map((item) => item.mixed),
			[false, false],
			'and both lines are clean enough to run a command',
		);
	});

	// Measured live: in every flush that produced two lines, the SECOND one came back as "two voices at
	// once", four times out of four. The realtime API reports how far the utterance has got, not what
	// this fragment covers, so the second fragment's window swallowed the first speaker's audio.
	it('judges a fragment on the audio that is new since the last one', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		room.voices('guest', 45); // 0 - 900 ms
		room.voices('third', 45); // 900 - 1800 ms
		// Both fragments carry the same start, which is how the API really reports them.
		room.delta('bence olmaz ', 0, 900);
		room.delta('neden olmasin', 0, 1800);
		t.mock.timers.tick(1300);

		assert.deepEqual(
			room.spoken(),
			[
				{ who: 'guest', text: 'bence olmaz' },
				{ who: 'third', text: 'neden olmasin' },
			],
			'the second fragment belongs to whoever spoke during ITS stretch of audio',
		);
	});

	// Three independent reviewers found the same hole: a line that holds a piece of somebody else's words
	// was handed to the model under one confident name. The application refuses to run a command off such
	// a line, but the model answers it and could not see what we knew about it.
	it('tells the model when a line holds somebody else s words too', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		room.voices('guest', 40);
		// A 100 ms interjection from the third person: too short to be a turn, so it is folded in and the
		// line stops being purely one person's.
		room.voices('third', 5);
		room.voices('guest', 40);
		room.delta('bunu ', 0, 800);
		room.delta('he ', 800, 900);
		room.delta('yapalim', 900, 1700);
		t.mock.timers.tick(1300);

		const said = room.lines();
		assert.equal(said.length, 1, said.join(' | '));
		assert.match(said[0], /Adem/, 'the line still carries the likeliest name');
		assert.match(said[0], /karışmış|run into/, 'and says somebody else may be in it');
		assert.deepEqual(
			room.commanded.map((item) => item.mixed),
			[true],
			'and the command shortcut still refuses it',
		);
	});

	// A review finding: the eight second cap fired on whichever fragment happened to arrive, so it could
	// split "banla" into "ban" and "la" -- and then the command parser recognises neither half.
	it('waits for a word to finish before closing an overlong line', (t) => {
		// Date as well as setTimeout: the cap is measured against the wall clock, so the clock has to move.
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
		const room = makeRoomSession();
		room.session.cfg.transcriptFlushMs = 60_000; // the silence timer is not what is under test here
		room.voices('guest', 20);
		room.delta('bir ', 0, 400);
		t.mock.timers.tick(8500); // past the cap
		room.voices('guest', 20);
		room.delta('ban', 400, 800); // mid-word: the line must not be closed here
		assert.deepEqual(room.spoken(), [], 'nothing is recorded in the middle of a word');
		room.delta('la ', 800, 1000); // the word is finished: now it may close
		assert.deepEqual(
			room.spoken().map((entry) => entry.text),
			['bir banla'],
			'and the word arrives in one piece',
		);
	});

	// Everything about whose words a line is rests on what the transcript's time windows mean, and which
	// shape they arrive in was worked out from a pattern across four lines of a pasted log. The bot now
	// counts it and says so, once, so the next log is evidence instead of another inference.
	it('says out loud which shape the transcript windows arrive in', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const cumulative = makeRoomSession();
		cumulative.session.cfg.transcriptFlushMs = 60_000;
		for (let i = 0; i < 24; i++) {
			cumulative.voices('guest', 10);
			cumulative.delta(`soz${i} `, 0, (i + 1) * 200); // every window starts at zero
		}
		assert.ok(
			cumulative.logged.some((line) => /kümülatif|cumulative/.test(line)),
			`the cumulative shape is reported: ${cumulative.logged.join(' | ')}`,
		);

		const perFragment = makeRoomSession();
		perFragment.session.cfg.transcriptFlushMs = 60_000;
		for (let i = 0; i < 24; i++) {
			perFragment.voices('guest', 10);
			perFragment.delta(`soz${i} `, i * 200, (i + 1) * 200); // each window starts where the last ended
		}
		assert.ok(
			perFragment.logged.some((line) => /parça başına|per fragment/.test(line)),
			`the per-fragment shape is reported: ${perFragment.logged.join(' | ')}`,
		);
	});

	it('keeps the owner as the owner while somebody else has a microphone open', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession();
		room.voices('owner', 40);
		room.delta('beni asagi tasi', 0, 800);
		t.mock.timers.tick(1300);
		assert.match(room.lines().join(' '), /Kaan/, 'the owner said it');
		assert.deepEqual(room.spoken(), [{ who: 'owner', text: 'beni asagi tasi' }]);
	});
});

describe('Jev: what the model is told a line was', () => {
	const fakeJev = (verdict) => ({ enabled: true, model: 'fake', judge: async (input) => verdict(input) });
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	// Friends give the bot absurd "orders" as a joke. The keyword grammar cannot tell "play X" from "meow
	// for me"; Jev can, and the model is told so in a SECOND line -- after the first one, never instead of
	// it, so a slow or dead Jev costs nothing.
	it('adds "that was banter" after the line, and nothing after a real request', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const asked = [];
		room.session.jev = fakeJev((input) => {
			asked.push(input.line);
			return input.line.includes('miyavla')
				? { addressed: 0.9, kind: 'banter', kindP: 0.9, confidence: 0.9 }
				: { addressed: 0.95, kind: 'command', kindP: 0.9, confidence: 0.9 };
		});
		room.voices('guest', 40);
		room.delta('melis bana miyavla', 0, 800);
		t.mock.timers.tick(1300);
		await settle();
		assert.deepEqual(asked, ['melis bana miyavla']);
		const said = room.lines();
		assert.equal(said.length, 2, said.join(' | '));
		assert.match(said[0], /miyavla/, 'the line goes to the model first, under its name');
		assert.match(said[1], /şaka|banter/, 'and the verdict follows it');

		room.voices('guest', 40);
		room.delta('melis bir sarki ac', 800, 1600);
		t.mock.timers.tick(1300);
		await settle();
		assert.equal(room.lines().length, 3, 'a real request gets no second line');
	});

	it('says "not said to you" when people are talking among themselves', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		room.session.jev = fakeJev(() => ({ addressed: 0.1, kind: 'chat', kindP: 0.8, confidence: 0.8 }));
		room.voices('guest', 40);
		room.delta('ya dun macta ne oldu', 0, 800);
		t.mock.timers.tick(1300);
		await settle();
		const said = room.lines();
		assert.equal(said.length, 2, said.join(' | '));
		assert.match(said[1], /söylenmedi|not said to you/);
	});

	it('asks nothing when Jev is off', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		assert.equal(room.session.jev.enabled, false);
		room.voices('guest', 40);
		room.delta('merhaba', 0, 800);
		t.mock.timers.tick(1300);
		await settle();
		assert.equal(room.lines().length, 1);
	});
});

describe('a transcript whose clock has run ahead of the audio', () => {
	it('still names the speaker, because the fragment is looked up where the audio really is', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0' });
		room.voices('guest', 50); // 0 - 1000 ms
		// The transcript reports the words 900 ms further on than any audio we have sent.
		room.delta('merhaba', 1100, 1900);
		t.mock.timers.tick(1300);
		assert.deepEqual(room.spoken(), [{ who: 'guest', text: 'merhaba' }]);
		assert.ok(!room.lines().some((line) => /anlaşılmıyor|does not say who/.test(line)), room.lines().join(' | '));
	});
});

describe('the reply gate: a line that was not for the bot gets no reply on the channel', () => {
	// Live failure: the owner, alone in the channel with the bot, said "Adem naber" -- to Adem, who was
	// not there -- and the bot answered "valla bilmiyorum canım", then "o cevap versin o zaman". Telling
	// the model afterwards changes nothing: it answers about a second after the person stops. So the line
	// is judged the moment its pieces stop arriving, the bot's audio is held while Jev answers, and a
	// reply to a line that was not for the bot never reaches the channel.
	const loud = () => Buffer.from(new Int16Array(480).fill(3000).buffer);
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const gated = (verdict) => {
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const pushed = [];
		room.session.playback = {
			push: (samples) => pushed.push(samples.length),
			clear() {
				pushed.length = 0;
				room.session.playbackCleared = (room.session.playbackCleared ?? 0) + 1;
			},
		};
		const asked = [];
		room.session.jev = { enabled: true, model: 'fake', judge: (input) => (asked.push(input), verdict(input)) };
		return { room, pushed, asked };
	};

	it('holds the reply while Jev answers, then keeps it off the channel and tells the model', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const { room, pushed, asked } = gated(async () => ({ addressed: 0.1, kind: 'chat', kindP: 0.8, confidence: 0.8 }));
		room.voices('guest', 40);
		room.delta('adem naber', 0, 800);
		room.session.onUserSpeechEnd('guest'); // the mixer: they stopped -- the hold starts here, before any reply
		t.mock.timers.tick(200); // and the question goes out from what the transcript has delivered
		assert.equal(asked.length, 1);
		assert.equal(asked[0].line, 'adem naber');
		room.session.onAssistantAudio(loud()); // the model starts answering before the verdict is in
		assert.deepEqual(pushed, [], 'held, not played');
		await settle(); // the verdict: not for the bot
		assert.deepEqual(pushed, [], 'dropped');
		assert.equal(room.session.playbackCleared, 1, 'and whatever the reply had already queued is thrown away');
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [], 'and the rest of that reply too');
		assert.match(room.lines().join(' '), /söylenmedi|not said to you/, 'the model is told its reply was not played');
		assert.ok(room.logged.some((line) => /kanala verilmedi|kept off the channel/.test(line)), room.logged.join(' | '));

		room.session.onTranscript({ speaker: 'assistant', text: 'valla bilmiyorum', startMs: 900, endMs: 1500 });
		t.mock.timers.tick(1300); // closes both lines
		assert.equal(asked.length, 1, 'the closed line is not judged a second time');
		const out = room.activity.events.find((event) => event.kind === 'voice' && event.direction === 'out');
		assert.equal(out?.meta?.suppressed, true, 'the reply is on the record as one nobody heard');
		assert.equal(room.session.lastHeardAssistantLine, '', 'and is not what the bot "last said"');
	});

	it('lets a reply to a line that was for the bot out, in order, once the verdict is in', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const { room, pushed } = gated(async () => ({ addressed: 0.9, kind: 'question', kindP: 0.8, confidence: 0.8 }));
		room.voices('guest', 40);
		room.delta('bugun hava nasil', 0, 800);
		room.session.onUserSpeechEnd('guest');
		t.mock.timers.tick(200);
		room.session.onAssistantAudio(Buffer.from(new Int16Array(480).fill(3000).buffer));
		room.session.onAssistantAudio(Buffer.from(new Int16Array(240).fill(3000).buffer));
		assert.deepEqual(pushed, [], 'held');
		await settle();
		assert.deepEqual(pushed, [480, 240], 'released, in order');
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480, 240, 480], 'and the gate is open again');
	});

	it('never makes a line that names the bot wait', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const { room, pushed, asked } = gated(async () => ({ addressed: 0.1, kind: 'chat', kindP: 0.8, confidence: 0.8 }));
		room.session.store = { getActive: () => ({ name: 'Melis' }), list: () => [], setActive: async () => true };
		room.voices('guest', 40);
		room.delta('melis naber', 0, 800);
		room.session.onUserSpeechEnd('guest');
		t.mock.timers.tick(200);
		assert.equal(asked.length, 0, 'the name is the answer');
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480]);
	});

	it('plays the reply anyway when Jev is too slow', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const { room, pushed } = gated(() => new Promise(() => {}));
		room.voices('guest', 40);
		room.delta('adem naber', 0, 800);
		room.session.onUserSpeechEnd('guest');
		t.mock.timers.tick(200);
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [], 'held');
		t.mock.timers.tick(2000);
		assert.deepEqual(pushed, [480], 'a slow Jev costs a moment, never the reply');
	});

	it('does nothing at all when the gate is switched off', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0', JEV_REPLY_GATE: '0' });
		const pushed = [];
		room.session.playback = { push: (samples) => pushed.push(samples.length), clear() {} };
		room.session.jev = { enabled: true, model: 'fake', judge: async () => ({ addressed: 0.1, kind: 'chat', kindP: 0.8, confidence: 0.8 }) };
		room.voices('guest', 40);
		room.delta('adem naber', 0, 800);
		room.session.onUserSpeechEnd('guest'); // does nothing with the gate off
		t.mock.timers.tick(450); // the pieces paused: judged, for the model's information only
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480], 'not held');
		await settle();
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480, 480], 'not kept off either; the model is only told');
		assert.match(room.lines().join(' '), /söylenmedi|not said to you/);
	});

	it('local brain: a line that was not for the bot gets no reply, a line that names it always does', async () => {
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const asked = [];
		room.session.jev = { enabled: true, model: 'fake', judge: async (input) => (asked.push(input.line), { addressed: input.line.includes('adem') ? 0.1 : 0.9, kind: 'chat', kindP: 0.8, confidence: 0.8 }) };
		room.session.store = { getActive: () => ({ name: 'Melis' }), list: () => [], setActive: async () => true };
		assert.equal(await room.session.localLineForBot('adem naber', 'guest'), false);
		assert.equal(await room.session.localLineForBot('bugun hava nasil', 'guest'), true);
		assert.equal(await room.session.localLineForBot('melis naber', 'guest'), true);
		assert.deepEqual(asked, ['adem naber', 'bugun hava nasil'], 'the name is never asked about');
		assert.ok(room.logged.some((line) => /yerel: cevap yok|local: no reply/.test(line)));
	});
});

describe('the reply gate on a line still being spoken', () => {
	const loud = () => Buffer.from(new Int16Array(480).fill(3000).buffer);
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	// Live failure: judged on its first word, "Adem" came back anywhere between 28% and 58% "for the bot",
	// the reply was let out, and the bot welcomed Adem itself. The first word of a line says little; the
	// gate now keeps holding on a doubt and asks again once there is more of the line.
	it('keeps holding on a doubt and lets the fuller line decide', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const pushed = [];
		room.session.playback = { push: (samples) => pushed.push(samples.length), clear() {} };
		const asked = [];
		room.session.jev = {
			enabled: true,
			model: 'fake',
			judge: async (input) => {
				asked.push(input.line);
				return input.line === 'adem' ? { addressed: 0.45, kind: 'chat', kindP: 0.6, confidence: 0.6 } : { addressed: 0.08, kind: 'chat', kindP: 0.9, confidence: 0.9 };
			},
		};
		room.voices('guest', 20); // 0 - 400 ms
		room.delta('adem', 0, 400);
		room.session.onUserSpeechEnd('guest');
		t.mock.timers.tick(200);
		assert.deepEqual(asked, ['adem']);
		room.session.onAssistantAudio(loud());
		await settle();
		assert.deepEqual(pushed, [], 'a doubt about one word does not let the reply out');
		room.voices('guest', 20); // 400 - 800 ms: the rest of the line
		room.delta(' naber', 400, 800);
		t.mock.timers.tick(450);
		assert.deepEqual(asked, ['adem', 'adem naber'], 'the fuller line is asked about');
		await settle();
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [], 'and it was not for the bot: nothing reaches the channel');
		assert.match(room.logged.join(' '), /kanala verilmedi|kept off the channel/);
	});

	it('lets a clear yes out at once, and a fuller yes calls off a doubtful no', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const pushed = [];
		room.session.playback = { push: (samples) => pushed.push(samples.length), clear() {} };
		room.session.jev = {
			enabled: true,
			model: 'fake',
			judge: async (input) => (input.line === 'sence' ? { addressed: 0.2, kind: 'chat', kindP: 0.5, confidence: 0.5 } : { addressed: 0.9, kind: 'question', kindP: 0.9, confidence: 0.9 }),
		};
		room.voices('guest', 20);
		room.delta('sence', 0, 400);
		room.session.onUserSpeechEnd('guest');
		t.mock.timers.tick(200);
		await settle();
		assert.ok(room.session.suppress, 'one word said no');
		room.voices('guest', 20);
		room.delta(' hava nasil olacak', 400, 800);
		t.mock.timers.tick(450);
		await settle();
		assert.equal(room.session.suppress, null, 'the whole line said yes before anything was dropped');
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480], 'and the reply goes out');
	});

	it('acts once per stop, from the frames the mixer hands over', () => {
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const ends = [];
		room.session.onUserSpeechEnd = (id) => ends.push(id);
		room.session.noteSpeechEnd({ active: ['a'] });
		room.session.noteSpeechEnd({ active: ['a'] });
		room.session.noteSpeechEnd({ active: ['a', 'b'] });
		room.session.noteSpeechEnd({ active: ['b'] });
		room.session.noteSpeechEnd({ active: [] });
		assert.deepEqual(ends, ['a', 'b']);
	});
});

describe('the reply gate keeps a kept-off turn quiet, and an aside needs an invitation', () => {
	const loud = () => Buffer.from(new Int16Array(480).fill(3000).buffer);
	const quiet = () => Buffer.from(new Int16Array(480).fill(0).buffer);
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const gated = (verdict) => {
		const room = makeRoomSession({ OWNER_PRIORITY: '0', JEV: '0' });
		const pushed = [];
		room.session.playback = { push: (samples) => pushed.push(samples.length), clear() {} };
		room.session.store = { getActive: () => ({ name: 'Melis' }), list: () => [], setActive: async () => true };
		room.session.jev = { enabled: true, model: 'fake', judge: async (input) => verdict(input.line) };
		return { room, pushed };
	};
	/** One turn: the previous line closes, the person speaks this, stops, and the first question goes out. */
	const turn = async (t, room, line, from) => {
		room.flush();
		room.voices('guest', 20);
		room.delta(line, from, from + 400);
		room.session.onUserSpeechEnd('guest');
		t.mock.timers.tick(200);
		await settle();
	};

	// Live: "Adem hoş geldin" was kept off -- and five seconds later the bot said "that conversation is
	// yours, I will stay out of it", which is the same interruption in fewer words.
	it('keeps a second reply to the same line off the channel too, until the next turn', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const { room, pushed } = gated(() => ({ addressed: 0.1, kind: 'chat', kindP: 0.9, confidence: 0.9 }));
		await turn(t, room, 'adem hos geldin', 0);
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [], 'the first reply is kept off');
		room.session.suppress.lastLoud = Date.now() - 1000; // that reply ended a second ago
		room.session.onAssistantAudio(quiet());
		room.session.onAssistantAudio(loud()); // "hmm, that is your conversation"
		assert.deepEqual(pushed, [], 'and so is the next one');
		room.session.lastAssistantSpokeAt = 0; // the room has been quiet: a hold may start
		room.session.onUserSpeechEnd('guest'); // a new turn
		assert.equal(room.session.suppress, null, 'is judged anew');
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [], 'held while the new turn is judged');
		t.mock.timers.tick(2000); // nothing was asked (no new words), so the hold runs out
		assert.deepEqual(pushed, [480], 'and its reply plays');
	});

	// Live: with the owner talking to Adem, "İyi kanka ben de öyle takılıyorum" came back 49-52% and the
	// bot joined in. Once the room is talking among themselves, a doubt is a no.
	it('needs a clear invitation once the room is talking among themselves', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const verdicts = { 'adem naber': 0.1, 'iyi kanka ben de oyle': 0.5, 'sence hava nasil': 0.5 };
		const { room, pushed } = gated((line) => ({ addressed: verdicts[line] ?? 0.9, kind: 'chat', kindP: 0.8, confidence: 0.8 }));
		await turn(t, room, 'adem naber', 0);
		assert.ok(room.logged.some((line) => /kenar sohbet:|aside:/.test(line)), 'the aside begins');
		await turn(t, room, 'iyi kanka ben de oyle', 400);
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [], 'a doubt inside an aside is silence');
		await turn(t, room, 'melis naber', 800);
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480], 'the name is the invitation, and it plays at once');
		assert.ok(room.logged.some((line) => /kenar sohbet bitti|aside over/.test(line)), 'the aside is over');
		room.session.lastAssistantSpokeAt = 0; // quiet again: a hold may start
		await turn(t, room, 'sence hava nasil', 1200);
		room.session.onAssistantAudio(loud());
		assert.deepEqual(pushed, [480], 'outside an aside the same doubt waits');
		t.mock.timers.tick(2000);
		assert.deepEqual(pushed, [480, 480], 'and plays when the hold runs out');
	});
});
