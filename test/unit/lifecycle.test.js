import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { LiveSession } from '../../src/live.js';
import { liveSlotsTaken, offerLiveSlots } from '../../src/liveslots.js';
import { ActivityLog } from '../../src/panel.js';
import { DailyQuota } from '../../src/quota.js';
import { ChannelReader } from '../../src/reader.js';

// The realtime session's life inside one guild: opening, failing, being retried, being replaced, being
// closed, and the slot it holds under MAX_LIVE_SESSIONS. The GuildSession is real; the realtime session
// is a stand-in (createLive) that never opens a socket, driven by hand through the events LiveSession
// emits: 'ready', 'error', 'closed', 'usage', 'turn', 'delegation'.

const baseEnv = { DISCORD_TOKEN: 't', GUILD_ID: 'alpha', CHANNEL_ID: 'alpha-voice', OPENAI_API_KEY: 'k', OWNER_ID: 'owner' };

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/** Behaves like LiveSession as far as GuildSession can tell, and is moved along by the test. */
class FakeLive extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.ready = false;
		this.sessionId = null;
		this.ended = false;
		this.closeCalls = 0;
		this.replies = [];
		this.context = [];
		this.connecting = deferred();
		this.closing = deferred();
	}

	connect() {
		return this.connecting.promise;
	}

	/** The handshake worked. */
	open(sessionId = 'sess') {
		this.sessionId = sessionId;
		this.ready = true;
		this.emit('ready', { sessionId });
		this.connecting.resolve(sessionId);
	}

	/** The socket is gone; `expected` is what LiveSession reports (true once close() was called). */
	drop({ code = 1006, reason = '', expected = this.closeCalls > 0 } = {}) {
		this.ready = false;
		this.ended = true;
		this.emit('closed', { code, reason, expected });
	}

	close() {
		this.closeCalls++;
		this.ready = false;
		if (this.ended) return Promise.resolve(false);
		return this.closing.promise;
	}

	/** The close the guild asked for has finished. */
	finishClose() {
		this.drop({ code: 1000, expected: true });
		this.closing.resolve(true);
	}

	replyDelegation(id, text) {
		this.replies.push({ id, text });
		return this.ready;
	}

	appendContext(kind, text) {
		this.context.push({ kind, text });
		return this.ready;
	}
}

function makeGuild(id) {
	const voice = { id: `${id}-voice`, name: 'Lounge', type: ChannelType.GuildVoice, parent: null, parentId: null, rawPosition: 0 };
	const member = { id: `${id}-jane`, displayName: 'Jane', user: { id: `${id}-jane`, username: 'jane', bot: false } };
	return {
		id,
		name: id,
		channels: { cache: new Map([[voice.id, voice]]) },
		members: { cache: new Map([[member.id, member]]), fetch: async () => member },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
		voice,
		member,
	};
}

function build({ env = {}, cfg = null, guildId = 'alpha', quota = null, canOpenLive = null, onLiveSlotFreed = null } = {}) {
	const config = cfg ?? loadConfig({ ...baseEnv, ...env });
	const guild = makeGuild(guildId);
	const lives = [];
	const lines = [];
	const dms = [];
	const activity = new ActivityLog();
	const session = new GuildSession({
		cfg: config,
		client: { user: { id: 'bot' }, users: { fetch: async () => ({ send: async (text) => dms.push(text) }) } },
		guild,
		channelId: guild.voice.id,
		store: { getActive: () => null, list: () => [], setActive: async () => true },
		memory: null,
		quota: quota ?? new DailyQuota(),
		reader: new ChannelReader(),
		recentActions: new RecentActions(),
		activity,
		record: (event) => activity.push(event),
		provider: { textClient: {}, textApi: 'responses', textModel: 'm', describe: () => 'mock' },
		openai: {},
		localStt: {},
		localServer: null,
		log: (...parts) => lines.push(parts.join(' ')),
		summarize: async () => ({ summary: '' }),
		canOpenLive,
		onLiveSlotFreed,
		createLive: (options) => {
			const live = new FakeLive(options);
			lives.push(live);
			return live;
		},
	});
	return { session, lives, lines, dms, guild, cfg: config };
}

/** The bot sits in its channel, and Jane is in there with it. */
function seat(session, guild, { people = true } = {}) {
	Object.defineProperty(session.voice, 'connected', { get: () => true, configurable: true });
	Object.defineProperty(session.voice, 'channelId', { get: () => guild.voice.id, configurable: true });
	if (people) guild.voiceStates.cache.set(guild.member.id, { id: guild.member.id, channelId: guild.voice.id, member: guild.member });
}

const count = (lines, pattern) => lines.filter((line) => pattern.test(line)).length;

describe('a realtime session that fails is retried', () => {
	it('a permanent error closes the session and still plans the retry and the local brain', async () => {
		const { session, lives, lines, guild } = build();
		seat(session, guild);
		const fallback = [];
		session.enterLocalBrain = async (reason) => (fallback.push(reason), false);
		session.startLive();
		const [live] = lives;
		live.open();

		live.emit('error', { error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota' } });
		assert.equal(session.live, null, 'the session is let go of');
		assert.equal(live.closeCalls, 1);
		assert.ok(session.liveReconnectTimer, 'a reconnect is planned although the close was our own');
		assert.equal(fallback.length, 1, 'and the local brain is asked to take over');
		assert.equal(count(lines, /Retrying in 10 min/), 1);

		// The close we asked for arrives as an expected one: it changes nothing any more.
		live.finishClose();
		await settle();
		assert.equal(count(lines, /Retrying in/), 1, 'the retry is planned once');
		session.stop();
	});

	it('too many errors on a socket that stays open end in a retry, not in silence', () => {
		const { session, lives, lines } = build();
		session.startLive();
		const [live] = lives;
		live.open();
		for (let index = 0; index < 3; index++) live.emit('error', new Error('response failed'));
		assert.equal(session.live, null);
		assert.equal(session.paused, false);
		assert.equal(count(lines, /retrying in 1 s/), 1, lines.join('\n'));
		session.stop();
	});

	it('a handshake failure is planned once: one log line, one step of back-off', async () => {
		const { session, lives, lines } = build();
		session.startLive();
		const [live] = lives;
		// A refused handshake is seen twice: the socket closes, and connect() rejects.
		live.drop({ code: 1008, reason: 'policy' });
		live.connecting.reject(new Error('closed before the handshake'));
		await settle();
		assert.equal(session.liveFailures, 1);
		assert.equal(count(lines, /retrying in/), 1, lines.join('\n'));
		session.stop();
	});

	it('a session that dies right after it opens keeps backing off; one that stays up is forgiven', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const { session, lives } = build();
		session.startLive();
		lives[0].open();
		lives[0].drop();
		assert.equal(session.liveFailures, 1);
		t.mock.timers.tick(1000);
		lives[1].open();
		assert.equal(session.liveFailures, 1, 'being accepted is not enough to forgive the failures');
		lives[1].drop();
		assert.equal(session.liveFailures, 2, 'the next wait is longer, not one second again');
		t.mock.timers.tick(2000);
		lives[2].open();
		t.mock.timers.tick(30_000);
		assert.equal(session.liveFailures, 0, 'thirty seconds up: the back-off starts from the beginning');
		session.stop();
	});
});

describe('events from a session the guild has let go of', () => {
	async function rebuilt(options) {
		const built = build(options);
		const { session, lives } = built;
		session.startLive();
		lives[0].open('old');
		const refreshing = session.refreshPersona('test');
		lives[0].finishClose();
		await refreshing;
		lives[1].open('new');
		return built;
	}

	it('a late ready, turn or error from the old session does not touch the new one', async () => {
		const { session, lives } = await rebuilt();
		const [old, current] = lives;
		for (let index = 0; index < 10; index++) session.attribution.onFrame({ priority: false, active: ['someone'] });
		const position = session.attribution.audioMs;
		const turn = session.lastTurn;
		old.emit('ready', { sessionId: 'old' });
		old.emit('turn', { delegationId: 'from-old' });
		for (let index = 0; index < 3; index++) old.emit('error', new Error('cannot send on a closed WebSocket'));
		assert.equal(session.attribution.audioMs, position, 'the new session s clock was not reset');
		assert.equal(session.lastTurn, turn, 'no turn was marked for the old session');
		assert.equal(session.live, current, 'the old session s errors do not condemn the new one');
		assert.equal(session.liveErrorCount, 0);
		session.stop();
	});

	it('a delegation is answered on the session that asked, even when another one opened meanwhile', async () => {
		const { session, lives } = await rebuilt();
		const asking = lives[1];
		let finish;
		session.runTask = () => new Promise((resolve) => (finish = resolve));
		asking.emit('delegation', { id: 'dg_1' });
		const refreshing = session.refreshPersona('again');
		asking.finishClose();
		await refreshing;
		const successor = lives[2];
		successor.open('newest');
		finish({ mode: 'commentary', text: 'done' });
		await settle();
		assert.deepEqual(
			asking.replies.map((reply) => reply.id),
			['dg_1'],
		);
		assert.equal(successor.replies.length, 0, 'the successor never hears of a delegation id it does not know');
		session.stop();
	});

	it('usage: each session is charged its own seconds, and only the current one can close over the quota', async () => {
		const quota = new DailyQuota({ limitSeconds: 100 });
		const { session, lives } = build({ quota });
		session.startLive();
		const old = lives[0];
		old.open('old');
		old.emit('usage', { seconds: 50 });
		const refreshing = session.refreshPersona('test');
		old.finishClose();
		await refreshing;
		const current = lives[1];
		current.open('new');
		current.emit('usage', { seconds: 10 });
		old.emit('usage', { seconds: 60 }); // a late report: 10 s the old session really used
		assert.equal(quota.status().used, 70, 'nothing is counted twice');
		old.emit('usage', { seconds: 200 });
		assert.equal(quota.status().exceeded, true);
		assert.equal(session.paused, false, 'a report from the old session does not close the new one');
		assert.equal(session.live, current);
		current.emit('usage', { seconds: 20 });
		assert.equal(session.paused, true, 'the current session reporting over the quota does');
		assert.equal(current.closeCalls, 1);
		session.stop();
	});
});

describe('MAX_LIVE_SESSIONS', () => {
	function fleet(max = 1) {
		const cfg = loadConfig({ ...baseEnv, MAX_LIVE_SESSIONS: String(max) });
		const registry = [];
		const canOpenLive = (asking) => liveSlotsTaken(registry, asking) < cfg.maxLiveSessions;
		const onLiveSlotFreed = () => offerLiveSlots(registry, cfg.maxLiveSessions);
		const a = build({ cfg, guildId: 'alpha', canOpenLive, onLiveSlotFreed });
		const b = build({ cfg, guildId: 'beta', canOpenLive, onLiveSlotFreed });
		registry.push(a.session, b.session);
		return { a, b, registry, canOpenLive };
	}

	it('a guild held back by the cap gets the slot once the other session s socket is gone, not before', async () => {
		const { a, b, canOpenLive } = fleet(1);
		seat(b.session, b.guild);
		a.session.startLive();
		a.lives[0].open();
		b.session.startLive();
		assert.equal(b.session.live, null);
		assert.ok(b.session.liveBlockedReason);

		a.session.pauseLive('idle');
		assert.equal(a.session.live, null);
		assert.equal(a.session.holdsLiveSlot(), true, 'told to close is not closed');
		assert.equal(canOpenLive(b.session), false, 'the cap still counts it');
		assert.equal(b.session.live, null);

		a.lives[0].finishClose();
		await settle();
		assert.equal(a.session.holdsLiveSlot(), false);
		assert.ok(b.session.live, 'the waiting guild was handed the slot');
		assert.equal(b.session.liveBlockedReason, null);
		a.session.stop();
		b.session.stop();
	});

	it('a waiting guild with nobody in its channel leaves the slot and takes it when somebody speaks', async () => {
		const { a, b } = fleet(1);
		seat(b.session, b.guild, { people: false });
		a.session.startLive();
		a.lives[0].open();
		b.session.startLive();
		b.session.resumeOnSpeech();
		assert.equal(b.lives.length, 0, 'speech while the cap is full opens nothing');
		assert.equal(count(b.lines, /Speech detected/), 0, 'and says nothing about it');

		a.session.pauseLive('idle');
		a.lives[0].finishClose();
		await settle();
		assert.equal(b.lives.length, 0, 'an empty channel is not worth a slot');

		b.session.resumeOnSpeech();
		assert.equal(b.lives.length, 1, 'somebody spoke: the free slot is taken');
		a.session.stop();
		b.session.stop();
	});

	it('offers a freed slot to the guild that has waited longest, and only as many as there are', () => {
		const taken = [];
		const guild = (name, since, { people = true, live = false } = {}) => ({
			name,
			live,
			liveBlockedReason: live ? null : 'waiting',
			liveBlockedSince: since,
			holdsLiveSlot() {
				return this.live;
			},
			takeLiveSlot() {
				if (!people) return false;
				this.live = true;
				this.liveBlockedReason = null;
				taken.push(name);
				return true;
			},
		});
		const sessions = [guild('open', 0, { live: true }), guild('late', 300), guild('empty', 100, { people: false }), guild('early', 200)];
		assert.deepEqual(
			offerLiveSlots(sessions, 2).map((session) => session.name),
			['early'],
		);
		assert.deepEqual(taken, ['early'], 'the empty channel was passed over and the cap was reached again');
		assert.equal(liveSlotsTaken(sessions), 2);
		assert.equal(liveSlotsTaken(sessions, sessions[0]), 1, 'the asking guild never counts against itself');
	});
});

describe('rejoining the voice channel', () => {
	function withFakeVoice(built, { failures = 1 } = {}) {
		const { session, guild } = built;
		let attempts = 0;
		const voice = {
			connected: false,
			channelId: null,
			async join(_guild, channel) {
				attempts++;
				if (attempts <= failures) throw new Error('voice timeout');
				voice.connected = true;
				voice.channelId = channel.id;
			},
			async destroy() {
				voice.connected = false;
			},
			dropUser() {},
		};
		session.voice = voice;
		session.lastVoiceChannelId = guild.voice.id;
		return { voice, attempts: () => attempts };
	}

	it('a failed first attempt is not the last one', async () => {
		const built = build({ env: { BRAIN_MODE: 'live' } });
		const { session, guild, lines } = built;
		const { voice, attempts } = withFakeVoice(built, { failures: 1 });
		session.scheduleRejoin(guild.voice.id, [5, 30, 400], 'back');
		await wait(80);
		assert.equal(attempts(), 2, 'the second attempt ran after the first failed');
		assert.equal(voice.connected, true);
		assert.equal(count(lines, /could not get back/), 1);
		assert.equal(session.rejoinTimers.size, 0, 'once it worked the remaining attempts are dropped');
		session.stop();
	});

	it('a join somebody asked for replaces the plan', async () => {
		const built = build({ env: { BRAIN_MODE: 'live' } });
		const { session, guild } = built;
		withFakeVoice(built, { failures: 0 });
		session.scheduleRejoin(guild.voice.id, [5_000, 10_000], 'back');
		assert.equal(session.rejoinTimers.size, 2);
		await session.joinVoice(guild.voice);
		assert.equal(session.rejoinTimers.size, 0);
		session.stop();
	});
});

describe('runtime settings belong to the guild they were changed in', () => {
	it('transcripts, owner priority, idle, brain and the default voice change one server; record is process-wide', async () => {
		const cfg = loadConfig(baseEnv);
		const a = build({ cfg, guildId: 'alpha' });
		const b = build({ cfg, guildId: 'beta' });

		await a.session.applySetting('transcripts', 'off');
		await a.session.applySetting('announce_speaker', 'off');
		await a.session.applySetting('owner_priority', 'off');
		await a.session.applySetting('idle_close_minutes', '3');
		await a.session.applySetting('brain', 'gpt');
		a.session.deps().setDefaultVoice('cedar');

		assert.equal(a.session.cfg.transcripts, false);
		assert.equal(a.session.cfg.announceSpeaker, false);
		assert.equal(a.session.cfg.ownerPriority, false);
		assert.equal(a.session.cfg.idleCloseMs, 3 * 60_000);
		assert.equal(a.session.cfg.brainMode, 'live');
		assert.equal(a.session.persona().voice, 'cedar');
		for (const other of [b.session.cfg, cfg]) {
			assert.equal(other.transcripts, true);
			assert.equal(other.announceSpeaker, true);
			assert.equal(other.ownerPriority, true);
			assert.equal(other.idleCloseMs, 10 * 60_000);
			assert.equal(other.brainMode, 'auto');
			assert.equal(other.liveVoice, 'marin');
		}
		assert.equal(b.session.persona().voice, 'marin');
		assert.equal(a.session.cfg.guildId, 'alpha', 'everything not overridden still reads through');

		await a.session.applySetting('record', 'off');
		assert.equal(cfg.recordTranscripts, false, 'the shared activity log follows the change');
		assert.equal(b.session.cfg.recordTranscripts, false);
		a.session.stop();
		b.session.stop();
	});

	it('idle_close_minutes turned on at runtime starts the watch, and turned off stops it', async (t) => {
		t.mock.timers.enable({ apis: ['setInterval'] });
		const { session, lives } = build({ env: { IDLE_CLOSE_MINUTES: '0' } });
		session.armIdleTimer();
		assert.equal(session.idleTimer, null);
		session.startLive();
		lives[0].open();
		await session.applySetting('idle_close_minutes', '5');
		assert.ok(session.idleTimer);
		session.idle.lastActivity -= 6 * 60_000;
		t.mock.timers.tick(30_000);
		assert.equal(session.paused, true, 'nobody spoke for longer than the new limit: the session was closed');
		await session.applySetting('idle_close_minutes', '0');
		assert.equal(session.idleTimer, null);
		session.stop();
	});
});

describe('stopping and closing', () => {
	it('stop() clears the reply gate s timers', async () => {
		const { session } = build();
		let fired = false;
		session.earlyJudgeTimer = setTimeout(() => (fired = true), 20);
		session.holdReply();
		assert.ok(session.replyHold, 'the bot s audio is being held');
		const releasing = session.replyHold.timer;
		assert.ok(releasing);
		session.stop();
		assert.equal(session.earlyJudgeTimer, null);
		assert.equal(session.replyHold, null);
		await wait(40);
		assert.equal(fired, false);
	});

	it('a memory hint whose session closed while the name was being fetched does not throw', async () => {
		const { session, lives } = build();
		session.memory = { summaryFor: () => 'likes tea', nameFor: () => null };
		session.startLive();
		lives[0].open();
		let answer;
		session.memberName = () => new Promise((resolve) => (answer = resolve));
		const hinting = session.hintMemory('someone');
		session.pauseLive('test');
		answer('Jane');
		await hinting;
		session.stop();
	});
});

describe('LiveSession: the end of a session', () => {
	function wired() {
		const session = new LiveSession({ apiKey: 'x' });
		const ws = new EventEmitter();
		ws.socket = { readyState: 1 };
		ws.sent = [];
		ws.closedWith = [];
		ws.send = (payload) => ws.sent.push(payload);
		ws.close = (props) => {
			ws.closedWith.push(props);
			ws.socket.readyState = 2;
		};
		session.ws = ws;
		session._wire(ws);
		session.ready = true;
		const errors = [];
		session.on('error', (err) => errors.push(err));
		return { session, ws, errors };
	}

	it('the server ending the session makes it not ready and closes the socket from this side', () => {
		const { session, ws } = wired();
		const closed = [];
		session.on('closed', (event) => closed.push(event));
		ws.emit('session.closed', { type: 'session.closed' });
		assert.equal(session.ready, false);
		assert.equal(ws.closedWith.length, 1, 'the socket is closed so that the end is reported');
		ws.emit('close', 1000, 'session closed by server');
		assert.deepEqual(closed, [{ code: 1000, reason: 'session closed by server', expected: false }], 'and it is not an expected end');
	});

	it('writes nothing into a socket that is closing', () => {
		const { session, ws, errors } = wired();
		ws.socket.readyState = 2;
		assert.equal(session.sendAudio(new Int16Array(480)), false);
		assert.equal(session.appendContext('thinking', 'x'), false);
		assert.equal(ws.sent.length, 0);
		assert.equal(errors.length, 0);
	});

	it('close() is done when the socket dies, without waiting for an acknowledgement that cannot come', async () => {
		const { session, ws } = wired();
		const closing = session.close();
		assert.equal(ws.sent.at(-1)?.type, 'session.close');
		ws.emit('close', 1006, '');
		const result = await Promise.race([closing, wait(1000).then(() => 'timeout')]);
		assert.equal(result, false, 'finished, unacknowledged');
	});

	it('close() after the server already ended the session does not wait at all', async () => {
		const { session, ws } = wired();
		ws.socket.readyState = 1;
		session._sessionClosed = true;
		const result = await Promise.race([session.close(), wait(1000).then(() => 'timeout')]);
		assert.equal(result, true);
		assert.equal(ws.closedWith.length, 1);
	});
});
