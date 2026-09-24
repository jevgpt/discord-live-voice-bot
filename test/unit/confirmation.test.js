import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { SpeakerAttribution, readAnswer } from '../../src/attribution.js';
import { RecentActions } from '../../src/commands.js';
import { loadConfig } from '../../src/config.js';
import { GuildSession } from '../../src/guildsession.js';
import { setLocale } from '../../src/i18n/index.js';
import { LocalBrain } from '../../src/localbrain.js';
import { ActivityLog } from '../../src/panel.js';
import { ChannelReader } from '../../src/reader.js';
import { callTool, toolOutput } from '../../src/tools.js';

// The two-step confirmation used to take the model's word for it: a second call with confirm:true and
// the same target was the whole of the "answer". On the realtime path the backend is told to carry on
// the moment a tool result is in, so a ban could be asked and confirmed in one response with nobody
// saying anything. These tests hold it to the owner's own voice, after the question, in a later turn.

let guildCounter = 0;

/**
 * One stretch of audio from `who` with its transcript, placed after everything so far. The transcript
 * starts with a space, as a new word does in the realtime stream; without it a piece that touches the
 * last one is read as the rest of that word.
 */
function talk(a, who, text, { turn = true, frames = 40 } = {}) {
	const from = a.audioMs;
	const frame = who === 'owner' ? { priority: true, active: ['owner'], present: ['owner'] } : { priority: false, active: [who], present: [who] };
	for (let i = 0; i < frames; i++) a.onFrame(frame);
	a.noteTranscript(` ${text}`, { startMs: from, endMs: a.audioMs });
	return turn ? a.markTurn() : null;
}

function makeGuild() {
	const banned = [];
	const jane = { id: '1', displayName: 'Jane Doe', user: { id: '1', username: 'jane', bot: false }, bannable: true };
	const guild = {
		id: `confirm-${++guildCounter}`,
		name: 'Confirm',
		channels: { cache: new Map() },
		members: { cache: new Map([['1', jane]]), fetch: async () => new Map(), ban: async (member) => banned.push(member.id) },
		voiceStates: { cache: new Map() },
		roles: { cache: new Map(), everyone: { id: 'everyone' } },
	};
	return { guild, banned };
}

/** Deps wired to one SpeakerAttribution the way GuildSession.buildDeps wires them. */
function voiceDeps(a, guild, extra = {}) {
	return {
		guild,
		cfg: { ownerId: 'owner' },
		log: () => {},
		activity: () => {},
		pendingConfirmations: new Map(),
		isOwnerActive: () => a.isOwnerActive(),
		commandSpeaker: (words, opts) => a.commandSpeaker(words, opts),
		lastUtterance: (opts) => a.lastUtterance(opts),
		transcriptLagging: (opts) => a.transcriptLagging(opts),
		awaitTranscript: async () => {},
		currentTurn: () => a.turn,
		speechMark: () => a.mark(),
		ownerSpeechSince: (mark, opts) => a.ownerSpeechSince(mark, opts),
		...extra,
	};
}

// The realtime path: every call gets its own deps, pinned to the turn its request was born in.
const pinned = (deps, turn) => ({ ...deps, currentTurn: () => turn });

describe('readAnswer: what counts as a yes', () => {
	it('reads English yes and no words as whole words', () => {
		for (const text of ['yes', 'yeah do it', 'go ahead', 'sure', 'okay', 'confirmed', 'yes please ban her']) {
			assert.deepEqual(readAnswer(text), { yes: true, no: false }, text);
		}
		for (const text of ['no', 'nope', "don't", 'not now', 'wait', 'hold on']) {
			assert.deepEqual(readAnswer(text), { yes: false, no: true }, text);
		}
		for (const text of ['yesterday', 'nobody asked', 'what time is it', 'surely', 'notable', '']) {
			assert.deepEqual(readAnswer(text), { yes: false, no: false }, text);
		}
		assert.deepEqual(readAnswer("yes... no, don't do it"), { yes: true, no: true }, 'a yes taken back is both');
		assert.deepEqual(readAnswer('yes, cancel it'), { yes: true, no: false }, 'the verb of the action is not a no');
	});

	it('reads Turkish answers, with the negative glued onto the verb', () => {
		setLocale('tr');
		try {
			for (const text of ['evet', 'evet yap', 'tamam', 'tamamdır', 'olur', 'aynen', 'onaylıyorum', 'onayla', 'yapabilirsin', 'evet iptal et']) {
				assert.deepEqual(readAnswer(text), { yes: true, no: false }, text);
			}
			for (const text of ['hayır', 'yok', 'vazgeç', 'dur', 'bekle', 'yapma', 'onaylamıyorum', 'olmaz', 'yapmıyoruz']) {
				assert.deepEqual(readAnswer(text), { yes: false, no: true }, text);
			}
			assert.equal(readAnswer('tamamen yanlış anladın').yes, false, '"tamamen" is not "tamam"');
			assert.equal(readAnswer('yapay zeka').yes, false, '"yapay" is not "yap"');
			assert.deepEqual(readAnswer('hayırlı olsun aslanım'), { yes: false, no: false }, 'a blessing and a pet name are not a no');
			assert.deepEqual(readAnswer('evet... yok yapma'), { yes: true, no: true });
		} finally {
			setLocale('en');
		}
	});
});

describe('SpeakerAttribution: what the owner said since the question', () => {
	it('counts only the owner s own words, and only those after the mark', () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		talk(a, 'owner', 'ban Jane yes');
		const mark = a.mark();
		assert.equal(a.ownerSpeechSince(mark), null, 'a yes said before the question is not an answer to it');
		talk(a, 'guest', 'yes do it');
		assert.equal(a.ownerSpeechSince(mark, { turn: a.turn }), null, 'somebody else s yes is not the owner s');
		talk(a, 'owner', 'yes');
		assert.equal(a.ownerSpeechSince(mark, { turn: a.turn })?.text, 'yes');
	});

	it('goes by where the words were spoken, not when their transcript arrived', () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const from = a.audioMs;
		for (let i = 0; i < 40; i++) a.onFrame({ priority: true, active: ['owner'], present: ['owner'] });
		const said = a.audioMs;
		const mark = a.mark(); // the question is put here; the transcript of what came before is still on its way
		a.noteTranscript(' ban her yes', { startMs: from, endMs: said });
		assert.equal(a.ownerSpeechSince(mark), null);
	});

	it('leaves no answer when somebody else speaks cleanly after the owner s yes', () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		talk(a, 'owner', 'ban Jane');
		const mark = a.mark();
		talk(a, 'owner', 'yes', { turn: false });
		talk(a, 'guest', 'no wait that is my friend', { turn: false });
		const turn = a.markTurn();
		assert.equal(a.ownerSpeechSince(mark, { turn }), null);
	});

	it('does not read words spoken after the turn into it', () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		talk(a, 'owner', 'ban Jane');
		const mark = a.mark();
		const turn = talk(a, 'owner', 'hmm');
		talk(a, 'owner', 'yes', { turn: false });
		assert.equal(a.ownerSpeechSince(mark, { turn })?.text, 'hmm', 'the yes came after this turn began');
	});

	it('falls back to the order of the fragments on the local path and across a session restart', () => {
		const local = new SpeakerAttribution({ ownerId: 'owner' });
		local.noteTranscript('ban Jane', { owner: true, id: 'owner' });
		const mark = local.mark();
		local.noteTranscript('evet', { owner: false, id: 'guest' });
		local.noteTranscript('yes', { owner: true, id: 'owner' });
		assert.equal(local.ownerSpeechSince(mark)?.text, 'yes');

		const restarted = new SpeakerAttribution({ ownerId: 'owner' });
		talk(restarted, 'owner', 'ban Jane');
		const before = restarted.mark();
		restarted.resetSession(); // a new Live session: positions start again from 0
		talk(restarted, 'owner', 'yes');
		assert.equal(restarted.ownerSpeechSince(before, { turn: restarted.turn })?.text, 'yes');
	});
});

describe('two-step confirmation: the owner has to say yes', () => {
	it('does not let the model answer its own question in the turn that asked it', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		const deps = voiceDeps(a, guild);
		const turn = talk(a, 'owner', 'ban Jane');
		const asked = await callTool('ban_member', { member: 'Jane' }, pinned(deps, turn));
		assert.equal(asked.needs_confirmation, true, asked.spoken);
		// What the realtime backend used to be able to do: the confirmation straight after the question.
		const self = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, turn));
		assert.equal(self.ok, false, self.spoken);
		assert.equal(self.needs_confirmation, true, 'the question stands');
		assert.deepEqual(banned, []);
		assert.equal(JSON.parse(toolOutput(self)).needs_confirmation, true);
	});

	it('does not act in a later turn until the owner s words hold a yes', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		const deps = voiceDeps(a, guild);
		await callTool('ban_member', { member: 'Jane' }, pinned(deps, talk(a, 'owner', 'ban Jane')));
		const unrelated = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', 'what time is it')));
		assert.equal(unrelated.ok, false, unrelated.spoken);
		assert.match(unrelated.spoken, /not heard the owner say yes/);
		assert.deepEqual(banned, []);
		const yes = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', 'yes')));
		assert.equal(yes.ok, true, yes.spoken);
		assert.deepEqual(banned, ['1']);
	});

	it('takes a no as a no, and still hears a yes said after it', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		const deps = voiceDeps(a, guild);
		await callTool('ban_member', { member: 'Jane' }, pinned(deps, talk(a, 'owner', 'ban Jane')));
		const no = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', "no don't")));
		assert.equal(no.ok, false);
		assert.match(no.spoken, /said no/);
		const unclear = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', 'yes no wait')));
		assert.equal(unclear.ok, false, 'a yes taken back in the same breath is not a yes');
		assert.deepEqual(banned, []);
		const yes = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', 'okay go ahead')));
		assert.equal(yes.ok, true, yes.spoken);
		assert.deepEqual(banned, ['1']);
	});

	it('does not take a yes said before the question as the answer to it', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		const deps = voiceDeps(a, guild);
		await callTool('ban_member', { member: 'Jane' }, pinned(deps, talk(a, 'owner', 'ban Jane yes I am sure')));
		const result = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', 'hmm')));
		assert.equal(result.ok, false, result.spoken);
		assert.deepEqual(banned, []);
	});

	it('does not take somebody else s yes, even when the gate has nothing against the call', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		// The older gate path (no attribution for the command word) stands open here, so what is tested is
		// the confirmation on its own.
		const deps = voiceDeps(a, guild, { commandSpeaker: undefined, isOwnerActive: () => true, ownerSaidRecently: () => true, ownerMatch: (w) => w[0] });
		await callTool('ban_member', { member: 'Jane' }, pinned(deps, talk(a, 'owner', 'ban Jane')));
		const guest = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'guest', 'yes yes do it')));
		assert.equal(guest.ok, false, guest.spoken);
		assert.deepEqual(banned, []);
		const owner = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, talk(a, 'owner', 'yes')));
		assert.equal(owner.ok, true, owner.spoken);
	});

	it('waits once for an answer whose transcript is still on its way', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		let waited = 0;
		const deps = voiceDeps(a, guild);
		await callTool('ban_member', { member: 'Jane' }, pinned(deps, talk(a, 'owner', 'ban Jane')));
		// The owner's "yes" is heard and the model starts answering before its transcript is in.
		const from = a.audioMs;
		for (let i = 0; i < 30; i++) a.onFrame({ priority: true, active: ['owner'], present: ['owner'] });
		const turn = a.markTurn();
		deps.awaitTranscript = async () => {
			waited++;
			a.noteTranscript(' yes', { startMs: from, endMs: turn.audioMs });
		};
		const result = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, turn));
		assert.equal(waited, 1);
		assert.equal(result.ok, true, result.spoken);
		assert.deepEqual(banned, ['1']);
	});

	it('never acts when the deps cannot say what the owner answered', async () => {
		const { guild, banned } = makeGuild();
		let turn = { at: 1 };
		const deps = {
			guild,
			cfg: {},
			log: () => {},
			pendingConfirmations: new Map(),
			isOwnerActive: () => true,
			ownerSaidRecently: () => true,
			ownerMatch: (w) => w[0],
			currentTurn: () => turn,
		};
		await callTool('ban_member', { member: 'Jane' }, deps);
		turn = { at: 2 };
		const result = await callTool('ban_member', { member: 'Jane', confirm: true }, deps);
		assert.equal(result.ok, false, result.spoken);
		assert.deepEqual(banned, []);
	});
});

// The same stream double the local brain's own tests use: tool calls arrive in fragments.
function streamOf(message) {
	const chunks = [];
	if (message.content) chunks.push({ choices: [{ delta: { content: message.content } }] });
	(message.tool_calls ?? []).forEach((call, index) => {
		chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
	});
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

function scriptedProvider(script) {
	let i = 0;
	return {
		available: true,
		textModel: 'local',
		textClient: { chat: { completions: { create: async () => streamOf(script[Math.min(i++, script.length - 1)] ?? {}) } } },
	};
}

describe('two-step confirmation on the local brain', () => {
	it('does not let several tool rounds of one utterance confirm their own question', async () => {
		const a = new SpeakerAttribution({ ownerId: 'owner' });
		const { guild, banned } = makeGuild();
		const base = voiceDeps(a, guild);
		const outputs = [];
		const brain = new LocalBrain({
			provider: scriptedProvider([
				{ tool_calls: [{ id: 'c1', name: 'ban_member', args: { member: 'Jane' } }] },
				{ tool_calls: [{ id: 'c2', name: 'ban_member', args: { member: 'Jane', confirm: true } }] },
				{ content: 'Should I ban Jane?' },
				{ tool_calls: [{ id: 'c3', name: 'ban_member', args: { member: 'Jane', confirm: true } }] },
				{ content: 'Done.' },
			]),
			tools: [],
			callTool: (name, args, context) => callTool(name, args, { ...base, ...context }),
			toolOutput,
			respondPolicy: 'always',
		});
		brain.tools = [{ type: 'function', function: { name: 'ban_member', parameters: {} } }];
		brain.on('tool', (event) => outputs.push(JSON.parse(event.output)));

		// On the local path the speaker of a line is known for certain and handed over whole.
		const utter = (text) => {
			a.noteTranscript(text, { owner: true, id: 'owner' });
			const turn = a.markTurn();
			return brain.handleUtterance({ userName: 'Owner', text, context: { currentTurn: () => turn } });
		};
		await utter('ban Jane');
		assert.equal(outputs.length, 2);
		assert.equal(outputs[1].ok, false, 'the second round is the model confirming itself');
		assert.equal(outputs[1].needs_confirmation, true);
		assert.deepEqual(banned, []);

		await utter('yes');
		assert.equal(outputs[2].ok, true, outputs[2].summary);
		assert.deepEqual(banned, ['1']);
	});
});

describe('two-step confirmation through a real GuildSession', () => {
	it('reads the owner s answer from the session s own attribution', async () => {
		const cfg = loadConfig({ DISCORD_TOKEN: 't', GUILD_ID: 'g', CHANNEL_ID: 'v', OPENAI_API_KEY: 'k', OWNER_ID: 'owner' });
		const { guild, banned } = makeGuild();
		guild.channels.cache.set('v', { id: 'v', name: 'Lounge', type: ChannelType.GuildVoice, parent: null, parentId: null, rawPosition: 0 });
		const activity = new ActivityLog();
		const session = new GuildSession({
			cfg,
			client: { user: { id: 'bot' } },
			guild,
			channelId: 'v',
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
			log: () => {},
			summarize: async () => ({ summary: '' }),
		});
		try {
			session.awaitTranscript = async () => {}; // nothing more is coming in this test
			const deps = session.deps();
			assert.equal(typeof deps.speechMark, 'function');
			assert.equal(typeof deps.ownerSpeechSince, 'function');
			const a = session.attribution;
			const first = talk(a, 'owner', 'ban Jane');
			assert.equal((await callTool('ban_member', { member: 'Jane' }, pinned(deps, first))).needs_confirmation, true);
			assert.equal((await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, first))).ok, false);
			const answer = talk(a, 'owner', 'yes');
			const done = await callTool('ban_member', { member: 'Jane', confirm: true }, pinned(deps, answer));
			assert.equal(done.ok, true, done.spoken);
			assert.deepEqual(banned, ['1']);
		} finally {
			session.stop();
		}
	});
});
