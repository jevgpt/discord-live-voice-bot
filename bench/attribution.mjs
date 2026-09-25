// The attribution benchmark: simulated rooms with the answers written down, run through the real
// attribution, line pipeline and owner gate, once per assignment mode (see bench/rooms.js, bench/run.js).
//
//   npm run bench                         every scenario, both modes, a table
//   npm run bench -- --json               the same numbers as JSON
//   npm run bench -- --reps 12            more rooms per scenario (default 8)
//   npm run bench -- --only overlap,lag   some scenarios
//   npm run bench -- --modes vote         one mode
//   npm run bench -- --seed 7             another set of rooms
//   npm run bench -- --vad peak           every room with the peak bar instead of VAD=adaptive
//   npm run bench -- --trace data/traces  write every room as a flight-recorder trace (the first mode's
//                                         lines), for scripts/replay-trace.mjs
//
// Columns, fragments and lines alike: ok = given to the right person, none = given to nobody (the audio
// could not tell), wrong = given to somebody else. mixed = named lines told as possibly holding somebody
// else's words (they run no command that changes anything). text = letters that ended up under the right
// name. FO = false owner: fragments / lines named the owner that were not the owner's / lines the owner's
// authority was put on that were not the owner's. gate = the owner's commands the gate opened for, out of
// those it should have / guests' commands it opened for, out of all of them. esc = guests' requests the
// bot would have taken as the owner's.
import { runBench, summarize } from './run.js';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const json = args.includes('--json');
const reps = Math.max(1, Number(value('--reps', 8)) || 8);
const seed = Math.max(1, Number(value('--seed', 1)) || 1);
const only = value('--only', null)?.split(',').filter(Boolean) ?? null;
const modes = value('--modes', 'vote,hmm').split(',').filter(Boolean);
const traceDir = value('--trace', null);
const vad = value('--vad', null);
if (vad !== null && vad !== 'peak' && vad !== 'adaptive') throw new Error(`--vad is peak or adaptive, not ${vad}`);

const started = performance.now();
const result = await runBench({ reps, only, modes, seed, traceDir, vad });
const seconds = ((performance.now() - started) / 1000).toFixed(1);

if (json) {
	const out = {
		reps,
		seed,
		vad: vad ?? 'as each scenario runs',
		modes,
		scenarios: result.scenarios.map((scenario) => ({
			name: scenario.name,
			about: scenario.about,
			...Object.fromEntries(modes.map((mode) => [mode, summarize(scenario.modes[mode])])),
		})),
		overall: Object.fromEntries(modes.map((mode) => [mode, summarize(result.overall[mode])])),
	};
	console.log(JSON.stringify(out, null, 2));
} else {
	const f = (n) => n.toFixed(1);
	const header = ['scenario', 'mode', 'frags', 'ok', 'none', 'wrong', 'lines', 'ok', 'none', 'wrong', 'mixed', 'text', 'FO f/l/auth', 'gate own', 'guest', 'esc'];
	const rows = [];
	const add = (name, mode, score) => {
		const s = summarize(score);
		rows.push([
			name,
			mode,
			String(s.fragments),
			f(s.fragAccuracy),
			f(s.fragNobody),
			f(s.fragWrong),
			String(s.lines),
			f(s.lineAccuracy),
			f(s.lineNobody),
			f(s.lineWrong),
			f(s.lineMixed),
			f(s.textRight),
			`${s.fragFalseOwner}/${s.lineFalseOwner}/${s.ownerGradeFalse}`,
			`${s.ownerOpened}/${s.ownerShouldOpen}`,
			`${s.guestOpened}/${s.guestCommands}`,
			String(s.guestAsOwner),
		]);
	};
	for (const scenario of result.scenarios) {
		for (const [i, mode] of modes.entries()) add(i ? '' : scenario.name, mode, scenario.modes[mode]);
	}
	for (const [i, mode] of modes.entries()) add(i ? '' : 'OVERALL', mode, result.overall[mode]);
	const widths = header.map((title, col) => Math.max(title.length, ...rows.map((row) => row[col].length)));
	const line = (cells) => cells.map((cell, col) => (col < 2 ? cell.padEnd(widths[col]) : cell.padStart(widths[col]))).join('  ');
	console.log(line(header));
	for (const [i, row] of rows.entries()) {
		if (row[0] && i) console.log('');
		console.log(line(row));
	}
	console.log(`\npercentages; ${result.scenarios.length} scenarios x ${reps} rooms, seed ${seed}${vad ? `, VAD=${vad}` : ''}, ${seconds} s`);
}
