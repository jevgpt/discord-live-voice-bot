// Local TTS benchmark/test: turns text into speech, measures how long it takes, writes a WAV you can listen to.
//   node --env-file=.env scripts/tts-check.mjs "text to try"
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { LocalTts } from '../src/localtts.js';

const cfg = loadConfig();
const tts = new LocalTts({ url: cfg.localTtsUrl, languageId: cfg.localTtsLang, timeoutMs: 300_000, token: cfg.localTtsToken });

const health = await tts.health();
console.log('health:', JSON.stringify(health));
if (!health?.ok) {
	console.log('the model is not ready; try again later.');
	process.exit(1);
}

const text = process.argv[2] ?? 'Hello there, this is Aria. I generate my voice on my own computer now, how does it sound?';
const started = Date.now();
const { pcm } = await tts.speak(text);
const elapsed = (Date.now() - started) / 1000;
const seconds = pcm.length / 24_000;

// WAV (16-bit mono 24 kHz) -- so it can be listened to
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length * 2, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(24_000, 24);
header.writeUInt32LE(24_000 * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length * 2, 40);
const out = 'data/tts-test.wav';
writeFileSync(out, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]));

console.log(
	`text: ${text.length} characters | audio: ${seconds.toFixed(2)} s | synthesis: ${elapsed.toFixed(2)} s | ` +
		`speed: ${(seconds / elapsed).toFixed(2)}x real time | file: ${out}`,
);
