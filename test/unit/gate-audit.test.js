import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActivityLog, gateRow } from '../../src/panel.js';
import { checkConfirmation, ownerGate } from '../../src/tools/helpers.js';

// What the gate writes down for the panel's gate audit: a stable code for why, who asked, and the words
// anybody said kept to the one field the log leaves out while recording is off.

/** A gate with the owner's command heard, and whatever `last` says about who spoke after it. */
function gateDeps({ hit, last = null, speaker = 'o', events = [] }) {
	return {
		events,
		personaName: () => 'Melis',
		nameFor: (id) => ({ o: 'Olga', g: 'Gus' })[id] ?? null,
		currentSpeakerId: () => speaker,
		commandSpeaker: () => hit,
		lastUtterance: () => last,
		ownerTextTail: () => 'ban Jane',
		activity: (event) => events.push(event),
		log: () => {},
	};
}

describe('the owner gate, as the gate audit reads it', () => {
	it('says the owner was obeyed with a code and names who asked', async () => {
		const deps = gateDeps({ hit: { owner: true, word: 'ban', at: 1, seq: 1 } });
		assert.equal(await ownerGate(deps, ['ban'], 'ban_member'), null);
		const [event] = deps.events;
		assert.equal(event.kind, 'gate');
		assert.equal(event.meta.result, 'allowed');
		assert.equal(event.meta.code, 'owner_said');
		assert.equal(event.meta.askerId, 'o');
		assert.equal(event.meta.askerName, 'Olga');
	});

	it('names the one who said the word when it was not the owner', async () => {
		const deps = gateDeps({ hit: { owner: false, id: 'g', word: 'ban', at: 1, seq: 1 }, speaker: null });
		assert.equal((await ownerGate(deps, ['ban'], 'ban_member')).denied, true);
		const [event] = deps.events;
		assert.equal(event.meta.code, 'not_owner');
		assert.deepEqual([event.meta.askerId, event.meta.askerName], ['g', 'Gus']);
	});

	it('keeps what the interrupter said out of the reason, where recording off can reach it', async () => {
		const deps = gateDeps({
			hit: { owner: true, word: 'ban', at: 1, seq: 1 },
			last: { owner: false, sure: true, id: 'g', text: 'the secret plan', at: 2, seq: 2 },
		});
		assert.equal((await ownerGate(deps, ['ban'], 'ban_member')).denied, true);
		const [event] = deps.events;
		assert.equal(event.meta.code, 'interrupted');
		assert.equal(event.meta.reason, 'Gus spoke after the owner');
		assert.ok(!event.text.includes('secret'), event.text);
		assert.equal(event.meta.text, 'the secret plan');

		const log = new ActivityLog({ redact: () => true });
		const stored = log.push(event);
		assert.ok(!JSON.stringify(stored).includes('secret'), JSON.stringify(stored));
		assert.equal(stored.meta.result, 'denied', 'the decision itself is not redacted');
		const row = gateRow(stored);
		assert.deepEqual([row.decision, row.code, row.reason], ['denied', 'interrupted', 'Gus spoke after the owner']);
	});
});

describe('two-step questions in the gate audit', () => {
	function questionDeps(said) {
		const events = [];
		let turn = { at: 1 };
		return {
			events,
			next: () => (turn = { at: turn.at + 1 }),
			deps: {
				pendingConfirmations: new Map(),
				personaName: () => 'Melis',
				activity: (event) => events.push(event),
				log: () => {},
				currentTurn: () => turn,
				speechMark: () => ({ mark: 1 }),
				ownerSpeechSince: () => ({ text: said }),
			},
		};
	}

	it('writes the question down without its arguments, then the spoken yes', () => {
		const { deps, events, next } = questionDeps('yes');
		const question = 'Ban Jane Doe for "posting my address"?';
		assert.ok(checkConfirmation(deps, { key: 'ban_member', target: 'j', confirm: undefined, question }).ask);
		next();
		assert.equal(checkConfirmation(deps, { key: 'ban_member', target: 'j', confirm: true, question }).ok, true);
		assert.deepEqual(
			events.map((event) => [event.meta.tool, event.meta.result, event.meta.code]),
			[
				['ban_member', 'asked', 'awaiting_yes'],
				['ban_member', 'confirmed', 'spoken_yes'],
			],
		);
		assert.ok(!JSON.stringify(events).includes('address'), 'the question is not in the audit');
		assert.equal(events[1].meta.text, 'yes', "the owner's answer goes where recording off can reach it");
	});

	it('says why the rule about other people s words asked, and that a no closed it', () => {
		const { deps, events, next } = questionDeps('no');
		const call = { key: 'untrusted:kick_member', target: 't', question: 'Kick Gus?' };
		checkConfirmation(deps, { ...call, confirm: undefined });
		next();
		assert.equal(checkConfirmation(deps, { ...call, confirm: true }).declined, true);
		assert.deepEqual(
			events.map((event) => [event.meta.tool, event.meta.result, event.meta.code]),
			[
				['kick_member', 'asked', 'untrusted_read'],
				['kick_member', 'declined', 'declined'],
			],
		);
		assert.equal(events[0].meta.reason, "other people's words were read in this turn");
	});
});
