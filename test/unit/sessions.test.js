import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { ActivityLog } from '../../src/panel.js';
import { ChannelReader } from '../../src/reader.js';
import { callTool } from '../../src/tools.js';

// Two servers at once. The point of these tests is what must NOT leak: the owner gate rests on each
// session's own SpeakerAttribution, so a command spoken in server A may not authorise a tool call in
// server B, and the audio path, the music player and deps.guild belong to one server only.
//
// The sessions are built by hand (no start(), no Discord, no sockets): the constructor is where every
// per-guild object is created, which is exactly what is under test here.

const baseEnv = { DISCORD_TOKEN: 't', GUILD_ID: 'alpha', CHANNEL_ID: 'alpha-voice', OPENAI_API_KEY: 'k', OWNER_ID: 'owner' };

/** A mock server with one voice channel called "Lounge" and one member called "Jane" inside it. */
function makeGuild(id, name) {
	const moved = [];
	const voice = { id: `${id}-voice`, name: 'Lounge', type: ChannelType.GuildVoice, parent: null, parentId: null, rawPosition: 0 };
	const member = {
		id: `${id}-jane`,
		displayName: 'Jane',
		user: { id: `${id}-jane`, username: 'jane', bot: false },
		voice: { channelId: voice.id, channel: voice, setChannel: async (channel) => moved.push(`${id}:${channel.name}`) },
	};
	const guild = {
		id,
		name,
		channels: { cache: new Map([[voice.id, voice]]) },
		members: { cache: new Map([[member.id, member]]), fetch: async () => new Map() },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
	};
	return { guild, voice, member, moved };
}

function makeSession(guild, { cfg, activity, canOpenLive = null, onPermanentLeave = null }) {
	const lines = [];
	const session = new GuildSession({
		cfg,
		client: { user: { id: 'bot' } },
		guild,
		channelId: `${guild.id}-voice`,
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
		log: (line) => lines.push(String(line)),
		summarize: async () => ({ summary: '' }),
		canOpenLive,
		onPermanentLeave,
	});
	return { session, lines };
}

/** One second of audio from the owner (or from somebody else) plus the transcript of that utterance. */
function speak(session, { owner, text }) {
	const frame = { priority: owner, active: [owner ? 'owner' : 'guest'] };
	for (let index = 0; index < 50; index++) session.attribution.onFrame(frame);
	session.attribution.noteTranscript(text, { startMs: 0, endMs: 1000 });
	session.attribution.markTurn(); // the request was born here: the gate looks at this moment
}

function twoSessions(options = {}) {
	const cfg = loadConfig({ ...baseEnv, ...options.env });
	// The process-wide services are shared, exactly as src/index.js shares them.
	const activity = new ActivityLog();
	const alpha = makeGuild('alpha', 'Alpha');
	const beta = makeGuild('beta', 'Beta');
	const a = makeSession(alpha.guild, { cfg, activity, ...options.a });
	const b = makeSession(beta.guild, { cfg, activity, ...options.b });
	return { cfg, activity, alpha, beta, a: a.session, b: b.session, aLines: a.lines, bLines: b.lines };
}

describe('several servers at once: isolation', () => {
	it('the owner gate is per server: a command spoken in one does not authorise the other', async () => {
		const { alpha, beta, a, b } = twoSessions();

		// The owner says it in Alpha; in Beta somebody else says exactly the same words about the same name.
		speak(a, { owner: true, text: 'move Jane to Lounge' });
		speak(b, { owner: false, text: 'move Jane to Lounge' });

		const allowed = await callTool('move_member', { member: 'Jane', channel: 'Lounge', come_along: false }, a.deps());
		assert.equal(allowed.ok, true, allowed.spoken);
		assert.deepEqual(alpha.moved, ['alpha:Lounge'], 'the member of the server the owner spoke in was moved');

		const refused = await callTool('move_member', { member: 'Jane', channel: 'Lounge', come_along: false }, b.deps());
		assert.equal(refused.ok, false);
		assert.equal(refused.denied, true, "the other server's gate must refuse: its own last speaker is not the owner");
		assert.deepEqual(beta.moved, [], 'nothing happened in the other server');

		// The two attributions really are separate objects with separate state.
		assert.notEqual(a.attribution, b.attribution);
		assert.equal(a.attribution.isOwnerActive(), true);
		assert.equal(b.attribution.isOwnerActive(), false);
	});

	it('a silent server does not inherit the other one\'s command, even without any speech of its own', async () => {
		const { beta, a, b } = twoSessions();
		speak(a, { owner: true, text: 'move Jane to Lounge' });
		// b heard nothing at all: no frames, no transcript.
		const refused = await callTool('move_member', { member: 'Jane', channel: 'Lounge', come_along: false }, b.deps());
		assert.equal(refused.denied, true);
		assert.deepEqual(beta.moved, []);
	});

	it('each server has its own audio path, music player and guild in deps', () => {
		const { alpha, beta, a, b } = twoSessions();
		assert.equal(a.deps().guild, alpha.guild, 'deps.guild is this server, and nothing else');
		assert.equal(b.deps().guild, beta.guild);
		for (const key of ['mixer', 'playback', 'attribution', 'latency', 'memberIndex', 'voice', 'music', 'localBrain', 'segmenter']) {
			assert.notEqual(a[key], b[key], `${key} must not be shared between two servers`);
		}

		// Music: a queue and a volume change in one server are invisible in the other.
		a.music.queue.push({ title: 'a track', kind: 'file' });
		a.music.volume = 0.8;
		assert.equal(a.status().music.queue, 1);
		assert.equal(b.status().music.queue, 0);
		assert.equal(b.music.volume, a.cfg.musicVolume);
		assert.equal(a.status().guildName, 'Alpha');
		assert.equal(b.status().guildName, 'Beta');
	});

	it('every event a session pushes says which server it came from', async () => {
		const { activity, a, b } = twoSessions();
		a.onToolEvent({ name: 'play_music', args: { query: 'x' }, output: '{}', ms: 12 }, 'test');
		b.record({ kind: 'voice', direction: 'in', who: 'someone', text: 'hello' });
		// The gate writes through the same wiring, so its decision is tagged too.
		speak(a, { owner: true, text: 'move Jane to Lounge' });
		await callTool('move_member', { member: 'Jane', channel: 'Lounge', come_along: false }, a.deps());

		const events = activity.events;
		assert.equal(events.find((event) => event.kind === 'tool')?.meta?.guild, 'Alpha');
		assert.equal(events.find((event) => event.kind === 'voice')?.meta?.guild, 'Beta');
		const gate = events.find((event) => event.kind === 'gate');
		assert.equal(gate?.meta?.guild, 'Alpha');
		assert.equal(gate?.meta?.result, 'allowed', 'the meta the gate itself writes survives the guild tag');
	});
});

describe('speaker announcements', () => {
	it('still tells the model who is talking once a crowded channel goes quiet', async () => {
		const said = [];
		const session = Object.create(GuildSession.prototype);
		Object.assign(session, {
			cfg: { announceSpeaker: true, ownerId: 'owner', transcripts: false },
			recentSpeakers: new Map(),
			sentCandidate: null,
			sentCandidateFrames: 0,
			sentSilentFrames: 0,
			lastAnnouncedUser: null,
			live: { ready: true, appendContext: (kind, text) => said.push({ kind, text }) },
			log: () => {},
			memory: null,
			memoryHinted: new Set(),
			nameFor: (id) => `user-${id}`,
			memberName: async (id) => `user-${id}`,
			isOwnerId: (id) => id === 'owner',
		});
		const hold = (id) => {
			for (let index = 0; index < 8; index++) session.trackSentSpeaker({ priority: false, active: [id], sent: true });
		};

		hold('a');
		hold('b');
		hold('c'); // the third speaker makes the channel crowded, so this one is not announced
		const announced = said.length;
		// An ambiguous frame announces nobody: this writes to the channel the model treats as hard fact,
		// so naming one of two voices here is the most expensive version of getting a speaker wrong. The
		// frame is neither counted towards a candidate nor treated as silence -- the announcement waits.
		const candidate = session.sentCandidate;
		const frames = session.sentCandidateFrames;
		for (let index = 0; index < 8; index++) session.trackSentSpeaker({ priority: false, active: ['a', 'b'], sent: true });
		assert.equal(said.length, announced, 'two voices in one frame announce nobody');
		assert.equal(session.sentCandidate, candidate, 'and the frame does not become anybody s evidence');
		assert.equal(session.sentCandidateFrames, frames);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(said.length, 2, 'only the first two are announced');
		assert.notEqual(session.lastAnnouncedUser, 'c', 'an announcement that was skipped must not be recorded as made');

		// a and b fall out of the twenty second window and c keeps talking on its own
		session.recentSpeakers.delete('a');
		session.recentSpeakers.delete('b');
		const crowded = session.recentSpeakerCount() >= 3;
		const contradicts = session.lastAnnouncedUser && String('c') !== String(session.lastAnnouncedUser);
		assert.equal(crowded, false, 'the channel is quiet again');
		assert.ok(contradicts, 'a line from c still disagrees with what the model was told, so it gets labelled');
	});
});

describe('several servers at once: the session cap', () => {
	it('a server over MAX_LIVE_SESSIONS stays silent, says why, and logs it once', () => {
		// The registry's rule, as src/index.js asks it: how many OTHER sessions hold a connection?
		const registry = [];
		const canOpenLive = (asking) => registry.filter((session) => session !== asking && session.live).length < 1;
		const { a, b, bLines } = twoSessions({ env: { MAX_LIVE_SESSIONS: '1' }, a: { canOpenLive }, b: { canOpenLive } });
		registry.push(a, b);

		a.live = { ready: true }; // Alpha holds the only allowed connection
		b.startLive();
		assert.equal(b.live, null, 'the second server must not open a connection');
		assert.ok(b.status().liveBlocked, 'and status() says why it is silent');
		assert.equal(b.status().liveOpen, false);
		assert.equal(bLines.filter((line) => line.includes('MAX_LIVE_SESSIONS')).length, 1);
		b.startLive();
		assert.equal(bLines.filter((line) => line.includes('MAX_LIVE_SESSIONS')).length, 1, 'the same notice is not repeated');

		// Alpha's connection closed: the cap lets Beta through again (startLive itself would open a socket).
		a.live = null;
		assert.equal(canOpenLive(b), true);
	});

	it('the cap counts the other servers only, so a session is never blocked by itself', () => {
		const registry = [];
		const canOpenLive = (asking) => registry.filter((session) => session !== asking && session.live).length < 2;
		const { a, b } = twoSessions({ env: { MAX_LIVE_SESSIONS: '2' }, a: { canOpenLive }, b: { canOpenLive } });
		registry.push(a, b);
		a.live = { ready: true };
		assert.equal(canOpenLive(a), true, 'its own connection does not count against it');
		assert.equal(canOpenLive(b), true, 'one of the two slots is still free');
	});

	it('a permanent leave hands the session back to the registry; a temporary one does not', async () => {
		const dropped = [];
		const { a, b } = twoSessions({ a: { onPermanentLeave: (session) => dropped.push(session.guild.id) }, b: {} });
		await a.leaveVoice({ permanent: false });
		assert.deepEqual(dropped, [], 'the bot means to come back: the session stays');
		await a.leaveVoice({ permanent: true });
		assert.deepEqual(dropped, ['alpha']);
		assert.equal(b.voice.connected, false, 'the other server was not touched');
	});
});

describe('the local voice in a session', () => {
	it('is built with the settings for what it is given and how it is checked', () => {
		const { a, b } = twoSessions({ env: { LOCAL_TTS_NORMALIZE: '0', LOCAL_TTS_VERIFY: 'always', LOCAL_TTS_FALLBACK_ENGINE: 'tr:chatterbox' } });
		assert.equal(a.localTts.normalize, false);
		assert.equal(a.localTts.guard.verify, 'always');
		assert.equal(a.localTts.guard.fallbackFor('tr'), 'chatterbox');
		assert.notEqual(a.localTts.guard, b.localTts.guard, 'each server counts its own');
	});

	// The local brain has no transcript fragments, which is what the report used to wait for: a session that
	// only ever spoke through the local voice never reported on it.
	it('reports on its checks even when there were no transcript fragments', () => {
		const { a, aLines } = twoSessions();
		for (let i = 0; i < 19; i++) a.localTts.guard.count('default', 'checked');
		a.reportHealth('test');
		assert.equal(aLines.filter((line) => line.startsWith('[health')).length, 0, 'not yet: 19 checks');
		a.localTts.guard.count('default', 'checked');
		a.localTts.guard.count('default', 'retried');
		a.reportHealth('test');
		assert.ok(aLines.includes('[health] local voice: default 20 checked, 0 suspicious, 0 failed the round trip, 1 retried, 0 fell back'), aLines.join('\n'));
		const reports = aLines.filter((line) => line.startsWith('[health: test]')).length;
		a.reportHealth('test');
		assert.equal(aLines.filter((line) => line.startsWith('[health: test]')).length, reports, 'nothing new, no second report');
	});
});
