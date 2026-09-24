import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionHealth } from '../../src/health.js';

// The session's own account of itself. Nine minutes of one live session went by with every line
// nobody's before anybody could see it in the log; the report is there to say so at the second minute.

describe('the session health report', () => {
	it('counts what the session decided and says it in a few lines', () => {
		let now = 0;
		const health = new SessionHealth({ now: () => now });
		for (let i = 0; i < 6; i++) health.fragment({ confidence: 'sure', reason: 'direct' });
		for (let i = 0; i < 3; i++) health.fragment({ confidence: 'leaning', reason: 'nearby' });
		health.fragment({ confidence: 'unsure', reason: 'silence' });
		health.line({ id: 'a', mixed: false });
		health.line({ id: 'a', mixed: true });
		health.line({ id: null, mixed: false });
		health.gateResult('allowed');
		health.gateResult('denied', 'the owner did not say the keyword');
		health.gateResult('denied', 'the owner did not say the keyword');
		health.jevVerdict({ addressed: 0.1, kind: 'chat', kindP: 0.8 }, 400, { notForBot: true });
		health.jevVerdict({ addressed: 0.9, kind: 'banter', kindP: 0.9 }, 600, { banter: true });
		health.jevVerdict(null, 2500);
		health.jevSuppressed();
		health.tool('play_music', 5500);
		health.tool('play_music', 6100);
		health.tool('send_message', 300);
		health.driftNow(1200);
		health.driftNow(900);
		now = 5 * 60_000;

		const s = health.snapshot();
		assert.equal(s.fragments, 10);
		assert.equal(s.surePct, 60);
		assert.equal(s.silentPct, 10);
		assert.equal(s.lines, 3);
		assert.equal(s.unknownPct, 33);
		assert.deepEqual([s.gateAllowed, s.gateDenied], [1, 2]);
		assert.deepEqual(s.gateReasons, [{ reason: 'the owner did not say the keyword', count: 2 }]);
		assert.deepEqual([s.jevCalls, s.jevFailed, s.jevBanter, s.jevNotForBot, s.jevSuppressed, s.jevMedianMs], [3, 1, 1, 1, 1, 600]);
		assert.deepEqual([s.driftMs, s.driftMaxMs], [900, 1200]);
		assert.deepEqual(s.slowTools, [{ name: 'play_music', count: 2, slow: 2, avgMs: 5800 }]);
		assert.equal(s.minutes, 5);

		const lines = health.report({ why: 'test', latency: 'P50 1.0 s' });
		assert.equal(lines.length, 4, lines.join('\n'));
		assert.match(lines[0], /10/);
		assert.match(lines[0], /60/);
		assert.match(lines[1], /×2/);
		assert.match(lines[2], /600/);
		assert.match(lines[3], /play_music ×2/);
		assert.match(lines[3], /5\.8/);
	});

	it('warns when the drift is large and when most lines belong to nobody', () => {
		const health = new SessionHealth();
		health.driftNow(7660);
		for (let i = 0; i < 12; i++) health.line({ id: null, mixed: false });
		const lines = health.report();
		assert.equal(lines.length, 4, lines.join('\n'));
		assert.match(lines[2], /7660/);
		assert.match(lines[3], /100/);
	});

	it('has nothing to warn about on a healthy session', () => {
		const health = new SessionHealth();
		health.driftNow(400);
		for (let i = 0; i < 12; i++) health.line({ id: 'a', mixed: false });
		assert.equal(health.report().length, 2);
	});
});

describe('the audio line of the report', () => {
	it('is there when the audio path reports, with a warning when the clock is off or the packets are', () => {
		const health = new SessionHealth();
		const audio = { holes: 3, concealed: 3, overflow: 0, maxDepth: 2, sent: 3000, sentRatio: 1.001, padRate: 0.4, avgLateMs: 3.14, maxLateMs: 12, bursts: 1, levels: [{ id: 'a', name: 'Ada', levelDb: -31, gainDb: 11 }] };
		const lines = health.report({ audio });
		assert.equal(lines.length, 3, lines.join('\n'));
		assert.match(lines[2], /Ada -31 dB \(\+11 dB\)/);
		assert.match(lines[2], /100\.1/);
		assert.match(lines[2], /0\.4/);
		assert.match(lines[2], /3\.1/);
		const uneven = health.report({ audio: { ...audio, padRate: 13.2 } });
		assert.equal(uneven.length, 4, uneven.join('\n'));
		assert.match(uneven[3], /13\.2/);
		const off = health.report({ audio: { ...audio, sentRatio: 0.9, holes: 200, concealed: 100 } });
		assert.equal(off.length, 5, off.join('\n'));
		assert.match(off[3], /90/);
		assert.match(off[4], /200/);
		const young = health.report({ audio: { ...audio, sentRatio: 0.9, sent: 100 } });
		assert.equal(young.length, 3, 'the rate means nothing before 30 s of audio');
	});

	// VAD=adaptive: what the detector sees of each microphone is on the same line, so that a live session
	// says whose floor is a fan (-40) and whose voice only just clears their bar.
	it('shows each person s noise floor and speech bar under the adaptive detector', () => {
		const health = new SessionHealth();
		const levels = [
			{ id: 'a', name: 'Ada', levelDb: -31, gainDb: 11, floorDb: -58, thresholdDb: -52 },
			{ id: 'b', name: 'Bo', levelDb: null, gainDb: 0, floorDb: -41, thresholdDb: -35 },
			{ id: 'c', name: 'Cem', levelDb: -24, gainDb: -4, floorDb: null, thresholdDb: null },
		];
		const line = health.report({ audio: { holes: 0, sent: 10, levels } })[2];
		assert.match(line, /Ada -31 dB \(\+11 dB; floor -58 dB, speech from -52 dB\)/);
		assert.match(line, /Bo \? dB \(\+0 dB; floor -41 dB, speech from -35 dB\)/, 'no AGC level measured yet: a question mark, not a number');
		assert.match(line, /Cem -24 dB \(-4 dB\)(,|$)/, 'the peak bar has no floor to show');
	});
});
