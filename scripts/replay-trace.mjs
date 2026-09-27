// Replays a trace file (TRACE=1 writes them under data/traces/) through the transcript pipeline as it
// is now, and reports where it decides differently from what was decided live.
//
//   node scripts/replay-trace.mjs data/traces/<file>.jsonl [--all] [--mode vote|hmm|both]
//
// The recorded frames rebuild the audio track and every recorded fragment goes back in through the
// session's own onTranscript -- the drift fitted, the window cut, the fragment placed -- and every
// fragment decided differently is listed. The flushes close where they closed live, once per assignment
// mode (ATTRIBUTION), and every flush whose lines came out differently from the recorded ones, or from
// the other mode, is listed as well; "?" marks a line told as possibly holding somebody else's words.
// Without --all only the changes are listed. A trace written without the words (RECORD_TRANSCRIPTS=0)
// cannot show where a word ends, so its lines are cut as if every fragment began a new word.
import { readFile } from 'node:fs/promises';
import { replaySession } from '../src/replay.js';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
	console.error('usage: node scripts/replay-trace.mjs <trace.jsonl> [--all] [--mode vote|hmm|both]');
	process.exit(2);
}
const all = flags.includes('--all');
const modeFlag = flags.includes('--mode') ? flags[flags.indexOf('--mode') + 1] : 'both';
const modes = modeFlag === 'both' ? ['vote', 'hmm'] : [modeFlag];
if (!modes.every((mode) => mode === 'vote' || mode === 'hmm')) {
	console.error(`unknown mode: ${modeFlag} (vote, hmm or both)`);
	process.exit(2);
}
const records = (await readFile(file, 'utf8'))
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const meta = records.find((record) => record.t === 'm');
const replayed = Object.fromEntries(modes.map((mode) => [mode, replaySession(records, { mode })]));
// The fragments are decided before any line is cut, so they come out the same in either mode.
const decisions = replayed[modes[0]].fragments;
const matched = decisions.filter((entry) => entry.same).length;
const frames = records.filter((record) => record.t === 'a').length;
console.log(`${file}: ${records.length} records, ${frames} voice changes, ${decisions.length} fragments; ${matched}/${decisions.length} decided the same`);
for (const entry of decisions) {
	if (!all && entry.same) continue;
	const mark = entry.same ? ' ' : '!';
	console.log(`${mark} ${entry.rs}-${entry.re} (drift ${entry.drift}) recorded=${entry.recorded ?? '-'} now=${entry.replayed ?? '-'} ${entry.text ? JSON.stringify(entry.text.slice(0, 40)) : ''}`);
}

// ---------------------------------------------------------------- lines, per mode

const byFlush = (lines) => {
	const map = new Map();
	for (const line of lines) {
		if (!map.has(line.flush)) map.set(line.flush, []);
		map.get(line.flush).push(line);
	}
	return map;
};
const shape = (lines) => (lines ?? []).map((line) => `${line.id ?? '-'}${line.mixed ? '?' : ''}${line.text ? ` ${JSON.stringify(line.text.slice(0, 50))}` : ''}`).join(' | ');
const recorded = byFlush(replayed[modes[0]].recorded);
const perMode = Object.fromEntries(modes.map((mode) => [mode, byFlush(replayed[mode].lines)]));
const flushes = [...new Set([...recorded.keys(), ...modes.flatMap((mode) => [...perMode[mode].keys()])])].sort((a, b) => a - b);
const counts = Object.fromEntries(modes.map((mode) => [mode, 0]));
let between = 0;
const listed = [];
for (const flush of flushes) {
	const live = shape(recorded.get(flush));
	const now = Object.fromEntries(modes.map((mode) => [mode, shape(perMode[mode].get(flush))]));
	for (const mode of modes) if (now[mode] === live) counts[mode]++;
	const modesDiffer = modes.length > 1 && now.vote !== now.hmm;
	if (modesDiffer) between++;
	if (all || modesDiffer || modes.some((mode) => now[mode] !== live)) listed.push({ flush, live, now, modesDiffer });
}
const liveMode = meta?.attribution ? ` (recorded live with ATTRIBUTION=${meta.attribution})` : '';
console.log(
	`\n${flushes.length} flushes${liveMode}; the same lines as recorded: ${modes.map((mode) => `${mode} ${counts[mode]}/${flushes.length}`).join(', ')}${modes.length > 1 ? `; vote and hmm differ on ${between}` : ''}`,
);
for (const entry of listed) {
	console.log(`${entry.modesDiffer ? '!' : ' '} flush ${entry.flush}`);
	console.log(`    recorded: ${entry.live || '(none)'}`);
	for (const mode of modes) console.log(`    ${mode.padEnd(8)}: ${entry.now[mode] || '(none)'}`);
}
