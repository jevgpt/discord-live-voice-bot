// The voice detector, measured. Every room of bench/vad-signals.mjs goes through a real SpeakerMixer
// twice, once with the peak bar every microphone shared (VAD=peak, the baseline) and once with the
// per-person adaptive detector (VAD=adaptive); then two people and a fan under floor control; then what
// the detector costs inside one 20 ms tick with ten people in the channel.
//
//   npm run bench:vad                                 two minutes of every room, three seeds
//   npm run bench:vad -- --seconds 30 --seeds 1       a quicker look
//
// Per room and mode:
//   recall  share of speech frames the mixer called speech (utterances with their word gaps)
//   false   share of non-speech frames called speech (the 220 ms after an utterance are left out: that is
//           the hold, by design, the same in both modes)
//   onset   mean frames (20 ms) from an utterance's first frame to the first frame called speech
//   chops   utterances broken in two or more by the detector, counted per break
//
// "Meaningfully worse", for the verdict at the end: recall down by more than 2 points, false speech up by
// more than 1 point, onset later by more than 2 frames (the old detector's own onset requirement, and
// well inside the 360 ms of pre-roll a floor handover sends first), or more chops.

import { performance } from 'node:perf_hooks';
import { SpeakerMixer } from '../src/audio.js';
import { FRAME, add, detect, fan, hiss, pool, scenarios, score, speech, toFrames } from './vad-signals.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && at + 1 < args.length ? Number(args[at + 1]) : fallback;
};
const SECONDS = arg('seconds', 120);
const SEEDS = arg('seeds', 3);
const MODES = ['peak', 'adaptive'];

const pct = (v) => (v === null ? '    -' : `${(v * 100).toFixed(1)}%`.padStart(6));
const frames1 = (v) => (v === null ? '   -' : v.toFixed(1).padStart(5));
const int = (v) => String(v).padStart(5);

// ---------------------------------------------------------------- the rooms
const started = performance.now();
const rooms = scenarios();
const results = rooms.map((room) => ({ room, scores: Object.fromEntries(MODES.map((mode) => [mode, []])) }));
for (let seed = 0; seed < SEEDS; seed++) {
	const seeded = scenarios({ seed });
	seeded.forEach((room, index) => {
		const built = room.build(SECONDS);
		const frames = toFrames(built.x);
		for (const mode of MODES) {
			const detected = detect(SpeakerMixer, frames, { vad: mode });
			results[index].scores[mode].push(score(built.truth, detected, { utterances: built.utterances }));
		}
	});
}

console.log(`Voice detector: ${rooms.length} rooms x ${SEEDS} seed(s) x ${SECONDS} s, 20 ms frames, through SpeakerMixer (floor control + AGC)\n`);
const head = `${'room'.padEnd(38)} | ${'peak (baseline)'.padEnd(31)} | adaptive`;
console.log(head);
console.log(`${''.padEnd(38)} | recall  false onset chops miss | recall  false onset chops miss`);
console.log('-'.repeat(head.length + 24));
const summary = Object.fromEntries(MODES.map((mode) => [mode, { level: [], noise: [], noiseFalse: [], none: [], chops: 0, onset: [] }]));
const worse = [];
const noBaseline = [];
for (const { room, scores } of results) {
	const pooled = Object.fromEntries(MODES.map((mode) => [mode, pool(scores[mode])]));
	const cells = MODES.map((mode) => {
		const s = pooled[mode];
		return `${pct(s.recall)} ${pct(s.falseRate)} ${frames1(s.onset)} ${int(s.chops)} ${int(s.missed).slice(1)}`;
	});
	console.log(`${room.name.padEnd(38)} | ${cells.join(' | ')}`);
	for (const mode of MODES) {
		const s = pooled[mode];
		const sum = summary[mode];
		if (room.group === 'level') sum.level.push(s.recall);
		if (room.group === 'noise') {
			sum.noise.push(s.recall);
			sum.noiseFalse.push(s.falseRate);
		}
		if (room.group === 'none') sum.none.push(s.falseRate);
		sum.chops += s.chops;
		if (s.onset !== null) sum.onset.push(s.onset);
	}
	const [p, a] = [pooled.peak, pooled.adaptive];
	const why = [];
	if (p.falseRate !== null && a.falseRate > p.falseRate + 0.01) why.push(`false ${pct(p.falseRate).trim()} -> ${pct(a.falseRate).trim()}`);
	// Where the peak bar calls the noise itself speech, its recall, onset and chops are those of "always
	// speech": there is no detector there to be worse than.
	if (p.falseRate === null || p.falseRate < 0.5) {
		if (p.recall !== null && a.recall < p.recall - 0.02) why.push(`recall ${pct(p.recall).trim()} -> ${pct(a.recall).trim()}`);
		if (p.onset !== null && a.onset !== null && a.onset > p.onset + 2) why.push(`onset ${p.onset.toFixed(1)} -> ${a.onset.toFixed(1)} frames`);
		if (a.chops > p.chops) why.push(`chops ${p.chops} -> ${a.chops}`);
	} else {
		noBaseline.push(room.name);
	}
	if (why.length) worse.push(`${room.name}: ${why.join(', ')}`);
}
const mean = (list) => (list.length ? list.reduce((x, y) => x + y, 0) / list.length : null);
console.log('');
for (const mode of MODES) {
	const s = summary[mode];
	console.log(
		`${mode.padEnd(9)} speech alone: recall ${pct(mean(s.level)).trim()} · speech over noise: recall ${pct(mean(s.noise)).trim()}, false ${pct(mean(s.noiseFalse)).trim()} · no speech: false ${pct(mean(s.none)).trim()} · chops ${s.chops} · onset ${mean(s.onset).toFixed(2)} frames`,
	);
}
console.log(`\nWhere adaptive is meaningfully worse than peak: ${worse.length ? `\n  ${worse.join('\n  ')}` : 'nowhere'}`);
const speechOverNoise = noBaseline.filter((name) => results.find((entry) => entry.room.name === name).room.group !== 'none');
if (speechOverNoise.length) console.log(`(recall, onset and chops not compared where the peak bar called the noise speech: ${speechOverNoise.join('; ')})`);

// ---------------------------------------------------------------- two people and a fan
// A talks; B says nothing, and B's fan runs at -40 dBFS. Under floor control, whoever is "speaking" can
// hold the floor, and only the holder is sent.
{
	const seconds = SECONDS;
	const a = speech({ seconds, levelDb: -30, seed: 21 });
	const aFrames = toFrames(add(a.x, hiss({ seconds, levelDb: -72, seed: 11 })));
	const bFrames = toFrames(add(fan({ seconds, levelDb: -40, seed: 5 }), hiss({ seconds, levelDb: -72, seed: 12 })));
	console.log(`\nTwo people under floor control, ${seconds} s: A talks at -30 dBFS, B is silent with a fan at -40 dBFS`);
	for (const mode of MODES) {
		const mixer = new SpeakerMixer({ vad: mode, floorControl: true, agc: true });
		let aSpeech = 0;
		let aSent = 0;
		let bHeld = 0;
		for (let i = 0; i < aFrames.length; i++) {
			mixer.push('a', aFrames[i]);
			mixer.push('b', bFrames[i]);
			const { active } = mixer.tick();
			if (a.truth[i]) {
				aSpeech++;
				if (active[0] === 'a') aSent++;
			}
			if (active.includes('b')) bHeld++;
		}
		console.log(`  ${mode.padEnd(9)} A's speech sent as A's: ${pct(aSent / aSpeech).trim()} · B (the fan) held the floor: ${pct(bHeld / aFrames.length).trim()} of the time`);
	}
}

// ---------------------------------------------------------------- the cost
// Ten people, each a different second of speech over a fan, every one of them read on every tick.
{
	const people = 10;
	const ticks = 5000;
	const clips = Array.from({ length: people }, (_, k) => {
		const voice = speech({ seconds: 12, levelDb: -30 - 2 * k, seed: 100 + k, lead: 0.5 });
		return toFrames(add(voice.x, fan({ seconds: 12, levelDb: -50, seed: 200 + k })));
	});
	console.log(`\nCost of one tick, ${people} people sending every frame (${ticks} ticks, after a warm-up):`);
	for (const mode of MODES) {
		const mixer = new SpeakerMixer({ vad: mode, floorControl: true, agc: true });
		const times = new Float64Array(ticks);
		for (let t = -1000; t < ticks; t++) {
			for (let k = 0; k < people; k++) mixer.push(`p${k}`, clips[k][(t + 1000 + k * 37) % clips[k].length]);
			const at = performance.now();
			mixer.tick();
			if (t >= 0) times[t] = performance.now() - at;
		}
		const sorted = Array.from(times).sort((x, y) => x - y);
		const avg = sorted.reduce((x, y) => x + y, 0) / ticks;
		const p99 = sorted[Math.floor(ticks * 0.99)];
		console.log(`  ${mode.padEnd(9)} mean ${(avg * 1000).toFixed(1)} µs, p99 ${(p99 * 1000).toFixed(1)} µs · ${((avg / 20) * 100).toFixed(2)}% of the 20 ms frame`);
	}
}
console.log(`\n(${((performance.now() - started) / 1000).toFixed(0)} s; ${FRAME} samples a frame at 24 kHz)`);
