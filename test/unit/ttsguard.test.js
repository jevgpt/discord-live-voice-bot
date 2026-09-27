import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { LocalStt } from '../../src/localstt.js';
import { LocalTts } from '../../src/localtts.js';
import {
	TtsGuard,
	characterErrorRate,
	checkDuration,
	expectedSeconds,
	foldForComparison,
	speechSpan,
	trimTrailingSilence,
} from '../../src/ttsguard.js';

// The other half of "it rambles and talks nonsense": an autoregressive voice that runs on past the end of
// a sentence, stops halfway, or says something else. Nothing downstream can tell, so every sentence is
// checked before it is played -- its length, and what it says -- and made again when it fails.

const RATE = 24_000;
const tone = (seconds, amplitude = 8000) => Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)));
const silence = (seconds) => new Int16Array(Math.round(seconds * RATE));
const join = (...parts) => {
	const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

// 32 letters and a comma: about 2.66 s at Turkish speed.
const SENTENCE = 'Bugün hava çok güzel, dışarı çıkalım mı?';
const RIGHT = () => tone(2.6);
const RAMBLING = () => tone(12);

/** A voice that answers each attempt from the script in turn (an Error is thrown), recording the extras. */
function fakeVoice(script) {
	const calls = [];
	return {
		calls,
		synthesize: async (extra) => {
			calls.push(extra);
			const next = script[Math.min(calls.length - 1, script.length - 1)];
			if (next instanceof Error) throw next;
			return { pcm: next, sampleRate: RATE, raw: next };
		},
	};
}

/** Ears that answer each transcription from the list in turn: a text, an Error, or 'hang' (until aborted). */
function fakeEars(answers) {
	const calls = [];
	return {
		calls,
		transcribe: async (pcm, options) => {
			calls.push({ samples: pcm.length, ...options });
			const next = answers[Math.min(calls.length - 1, answers.length - 1)];
			if (next instanceof Error) throw next;
			if (next === 'hang') {
				return new Promise((resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')));
				});
			}
			return { text: next, language: 'tr', durationMs: 0 };
		},
	};
}

describe('the expected length of a sentence', () => {
	it('comes from its letters, as they are said, and its pauses', () => {
		const seconds = expectedSeconds(SENTENCE, 'tr');
		assert.ok(seconds > 2.4 && seconds < 2.9, `${seconds.toFixed(2)} s`);
		assert.equal(expectedSeconds('%20', 'tr'), expectedSeconds('yüzde yirmi', 'tr'), 'a number counts as the words it is said with');
		assert.ok(expectedSeconds('Evet.', 'tr') < 0.4, 'the last full stop is not a pause inside the sentence');
		assert.ok(expectedSeconds('Evet. Tamam.', 'tr') > expectedSeconds('Evet tamam', 'tr'), 'a full stop inside it is');
		assert.ok(expectedSeconds('hello there friend', 'en') > expectedSeconds('hello there friend', 'tr'), 'English is counted a little slower');
		assert.equal(expectedSeconds('', 'tr'), 0);
	});
});

describe('where the sound is', () => {
	it('finds the speech between the silences, to the frame', () => {
		const { start, end } = speechSpan(join(silence(0.5), tone(1), silence(3)));
		assert.ok(Math.abs(start - 0.5 * RATE) <= 480, `start ${start}`);
		assert.ok(Math.abs(end - 1.5 * RATE) <= 480, `end ${end}`);
		assert.deepEqual(speechSpan(silence(2)), { start: 0, end: 0 }, 'silence has no speech in it');
		assert.deepEqual(speechSpan(tone(2, 60)), { start: 0, end: 0 }, 'nor does a hiss below -50 dBFS');
		assert.deepEqual(speechSpan(new Int16Array(0)), { start: 0, end: 0 });
	});

	it('cuts a long silence off the end of what is played, and leaves a short one alone', () => {
		const long = join(tone(1), silence(3));
		const trimmed = trimTrailingSilence(long);
		assert.ok(Math.abs(trimmed.length - 1.25 * RATE) <= 480, `${trimmed.length / RATE} s`);
		const short = join(tone(1), silence(0.3));
		assert.equal(trimTrailingSilence(short), short);
		assert.equal(trimTrailingSilence(silence(2)).length, 2 * RATE, 'nothing to measure against: left as it is');
	});
});

describe('the length check', () => {
	it('passes audio about as long as the sentence', () => {
		assert.equal(checkDuration(RIGHT(), SENTENCE, 'tr').suspicious, false);
		assert.equal(checkDuration(tone(5), SENTENCE, 'tr').suspicious, false, 'a slow voice is not a wrong one');
		assert.equal(checkDuration(tone(1.2), SENTENCE, 'tr').suspicious, false, 'nor is a fast one');
	});

	it('flags audio that ran on, and audio that lost most of the sentence', () => {
		const long = checkDuration(RAMBLING(), SENTENCE, 'tr');
		assert.deepEqual([long.suspicious, long.reason], [true, 'long']);
		const short = checkDuration(tone(0.5), SENTENCE, 'tr');
		assert.deepEqual([short.suspicious, short.reason], [true, 'short']);
		assert.equal(checkDuration(new Int16Array(0), SENTENCE, 'tr').reason, 'short', 'no audio at all');
		assert.equal(checkDuration(tone(3, 60), SENTENCE, 'tr').reason, 'short', 'a hiss is not speech');
	});

	it('does not count silence at either end', () => {
		assert.equal(checkDuration(join(RIGHT(), silence(8)), SENTENCE, 'tr').suspicious, false, 'eight seconds of trailing silence');
		assert.equal(checkDuration(join(silence(6), RIGHT()), SENTENCE, 'tr').suspicious, false, 'six seconds of leading silence');
	});

	it('gives a short line room to breathe, but not to ramble', () => {
		assert.equal(checkDuration(tone(0.6), 'Evet.', 'tr').suspicious, false);
		assert.equal(checkDuration(tone(1.5), 'Evet.', 'tr').suspicious, false);
		assert.equal(checkDuration(tone(4), 'Evet.', 'tr').reason, 'long', 'the "Yes?" that goes on for seconds');
	});
});

describe('comparing what was heard with what was sent', () => {
	it('counts character edits against the length of the text', () => {
		assert.equal(characterErrorRate('merhaba', 'merhaba'), 0);
		assert.equal(characterErrorRate('abc', 'abd'), 1 / 3);
		assert.equal(characterErrorRate('abc', ''), 1);
		assert.equal(characterErrorRate('', ''), 0);
		assert.equal(characterErrorRate('', 'abc'), 3);
		assert.equal(characterErrorRate('evet', 'evt', { minLength: 8 }), 1 / 8, 'a short text is measured against eight letters');
		assert.equal(characterErrorRate('çok', 'cok'), 1 / 3, 'by letter, not by byte');
	});

	it('folds case the Turkish way, and drops accents, spaces and punctuation', () => {
		assert.equal(foldForComparison('İSTANBUL', 'tr'), 'istanbul');
		assert.equal(foldForComparison('ISPARTA', 'tr'), 'isparta', 'I is ı in Turkish, and ı is compared as i');
		assert.equal(foldForComparison('Şeker, ÇOK güzel!', 'tr'), 'sekercokguzel');
		assert.equal(foldForComparison('saçma', 'tr'), foldForComparison('sacma', 'tr'));
		assert.equal(foldForComparison('Iğdır', 'tr'), 'igdir');
		assert.equal(foldForComparison('İstanbul', 'en'), 'istanbul', 'without a stray dot outside Turkish');
	});

	it('reads the digits a transcriber writes as the words that were sent', () => {
		assert.equal(foldForComparison('Saat 14:45', 'tr'), foldForComparison('saat on dört kırk beş', 'tr'));
		assert.equal(foldForComparison('%20 indirim', 'tr'), foldForComparison('yüzde yirmi indirim', 'tr'));
		assert.equal(foldForComparison("It's 20%.", 'en'), foldForComparison('its twenty percent', 'en'));
	});

	it('puts a repeated or a different sentence over the line, and a misheard ending under it', () => {
		const sent = foldForComparison(SENTENCE, 'tr');
		assert.ok(characterErrorRate(sent, foldForComparison(`${SENTENCE} ${SENTENCE}`, 'tr')) > 0.35, 'said twice');
		assert.ok(characterErrorRate(sent, foldForComparison('Bugün hava', 'tr')) > 0.35, 'stopped halfway');
		assert.ok(characterErrorRate(sent, foldForComparison('Yarın toplantıya gelmeyeceğim.', 'tr')) > 0.35, 'something else');
		assert.ok(characterErrorRate(sent, foldForComparison('Bugün hava çok güzeldi, dışarı çıkalım mı', 'tr')) < 0.35, 'one word misheard');
	});
});

describe('TtsGuard', () => {
	it('plays the first attempt when it passes, and counts it', async () => {
		const voice = fakeVoice([RIGHT()]);
		const guard = new TtsGuard();
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.deepEqual(voice.calls, [{}]);
		assert.equal(result.ok, true);
		assert.equal(result.attempts, 1);
		assert.equal(result.pcm.length, RIGHT().length);
		assert.deepEqual(guard.stats(), { default: { checked: 1, suspicious: 0, failedRoundTrip: 0, retried: 0, fellBack: 0 } });
		assert.equal(guard.checkedTotal, 1);
	});

	it('makes a sentence that ran on again, with another seed and a lower temperature', async () => {
		const voice = fakeVoice([RAMBLING(), RIGHT()]);
		const logs = [];
		const guard = new TtsGuard({ verify: 'off', log: (line) => logs.push(line), random: () => 0.5 });
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(voice.calls.length, 2);
		assert.deepEqual(voice.calls[1], { seed: 2 ** 30, temperature: 0.6 });
		assert.equal(result.ok, true);
		assert.equal(result.attempts, 2);
		assert.equal(result.pcm.length, RIGHT().length, 'the second attempt is the one played');
		assert.deepEqual(guard.stats().default, { checked: 2, suspicious: 1, failedRoundTrip: 0, retried: 1, fellBack: 0 });
		assert.equal(logs.length, 1);
		assert.match(logs[0], /came out wrong \(too long: 12 s where about 2\.\d s was expected\)/u);
	});

	it('falls back to the engine configured for the language when the second attempt fails too', async () => {
		const voice = fakeVoice([RAMBLING(), RAMBLING(), RIGHT()]);
		const guard = new TtsGuard({ verify: 'off', fallbackEngines: { tr: 'freya', '*': 'kokoro' } });
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(voice.calls.length, 3);
		assert.deepEqual(voice.calls[2], { engine: 'freya' }, 'only the engine changes');
		assert.deepEqual([result.ok, result.engine, result.attempts], [true, 'freya', 3]);
		assert.deepEqual(guard.stats(), {
			default: { checked: 2, suspicious: 2, failedRoundTrip: 0, retried: 1, fellBack: 1 },
			freya: { checked: 1, suspicious: 0, failedRoundTrip: 0, retried: 0, fellBack: 0 },
		});
	});

	it('knows which engine is configured for which language, and never falls back to the same one', async () => {
		const guard = new TtsGuard({ fallbackEngines: { tr: 'freya', '*': 'kokoro' } });
		assert.equal(guard.fallbackFor('tr'), 'freya');
		assert.equal(guard.fallbackFor('tr-TR'), 'freya');
		assert.equal(guard.fallbackFor('en'), 'kokoro');
		assert.equal(new TtsGuard({ fallbackEngines: { tr: 'freya' } }).fallbackFor('en'), null);
		assert.equal(new TtsGuard({ fallbackEngines: 'chatterbox' }).fallbackFor('de'), 'chatterbox');
		assert.equal(new TtsGuard().fallbackFor('tr'), null, 'none unless one is configured');

		const voice = fakeVoice([RAMBLING()]);
		await new TtsGuard({ verify: 'off', fallbackEngines: { tr: 'freya' } }).run(voice.synthesize, { text: SENTENCE, language: 'tr', engine: 'freya' });
		assert.equal(voice.calls.length, 2, 'freya was the engine that failed: a retry, and no fallback to itself');
		const none = fakeVoice([RAMBLING()]);
		await new TtsGuard({ verify: 'off', fallbackEngines: { tr: 'freya' } }).run(none.synthesize, { text: 'It is a lovely day.', language: 'en' });
		assert.equal(none.calls.length, 2, 'no fallback configured for English');
		assert.ok(none.calls.every((extra) => !('engine' in extra)), 'and no engine field is sent at all');
	});

	it('plays the attempt closest to right when none passes, and says so', async () => {
		const voice = fakeVoice([RAMBLING(), tone(9)]);
		const logs = [];
		const guard = new TtsGuard({ verify: 'off', log: (line) => logs.push(line) });
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(result.ok, false);
		assert.equal(result.pcm.length, tone(9).length, 'nine seconds is nearer 2.7 than twelve');
		assert.match(logs.at(-1), /none of 2 attempts .* passed the check; playing the closest one/u);
	});

	it('keeps what it has when a later attempt fails, and hands the first failure to the caller', async () => {
		const logs = [];
		const guard = new TtsGuard({ verify: 'off', log: (line) => logs.push(line) });
		const flaky = fakeVoice([RAMBLING(), new Error('server gone')]);
		const result = await guard.run(flaky.synthesize, { text: SENTENCE, language: 'tr' });
		assert.deepEqual([result.ok, result.attempts, result.pcm.length], [false, 1, RAMBLING().length]);
		assert.ok(logs.some((line) => line.includes('another attempt') && line.includes('server gone')), logs.join(' | '));
		const broken = fakeVoice([new Error('local TTS error (500)')]);
		await assert.rejects(() => guard.run(broken.synthesize, { text: SENTENCE, language: 'tr' }), /500/u);
	});

	it('trims a long trailing silence off what it plays', async () => {
		const voice = fakeVoice([join(RIGHT(), silence(3))]);
		const result = await new TtsGuard().run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(result.ok, true);
		assert.ok(Math.abs(result.pcm.length - 2.85 * RATE) <= 480, `${(result.pcm.length / RATE).toFixed(2)} s`);
	});

	it('stops trying once a sentence has taken long enough', async () => {
		let clock = 0;
		const voice = fakeVoice([RAMBLING(), RIGHT()]);
		const guard = new TtsGuard({ verify: 'off', now: () => clock, maxExtraMs: 12_000 });
		const slow = async (extra) => {
			clock += 13_000; // one attempt on a struggling GPU
			return voice.synthesize(extra);
		};
		const result = await guard.run(slow, { text: SENTENCE, language: 'tr' });
		assert.deepEqual([voice.calls.length, result.attempts, result.ok], [1, 1, false]);
	});
});

describe('TtsGuard: the round trip', () => {
	it('off: never transcribes, and the length decides alone', async () => {
		const ears = fakeEars([SENTENCE]);
		const voice = fakeVoice([RAMBLING(), RIGHT()]);
		const guard = new TtsGuard({ stt: ears, verify: 'off' });
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(ears.calls.length, 0);
		assert.equal(result.attempts, 2);
	});

	it('suspicious: transcribes only audio whose length looks wrong, and keeps it when it says the right thing', async () => {
		const ears = fakeEars([SENTENCE]);
		const fine = new TtsGuard({ stt: ears });
		await fine.run(fakeVoice([RIGHT()]).synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(ears.calls.length, 0, 'a sentence of the right length costs nothing');

		const slow = fakeVoice([tone(8)]);
		const result = await fine.run(slow.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(ears.calls.length, 1);
		assert.equal(ears.calls[0].language, 'tr', 'the transcriber is told the language');
		assert.deepEqual([result.ok, result.attempts, slow.calls.length], [true, 1, 1], 'a slow voice that said the right words is kept');
		assert.deepEqual(fine.stats().default, { checked: 2, suspicious: 1, failedRoundTrip: 0, retried: 0, fellBack: 0 });
	});

	it('suspicious: makes it again when the transcript says something else', async () => {
		const ears = fakeEars(['Yarın toplantıya gelmeyeceğim, bla bla bla bla.']);
		const voice = fakeVoice([RAMBLING(), RIGHT()]);
		const logs = [];
		const guard = new TtsGuard({ stt: ears, log: (line) => logs.push(line) });
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.deepEqual([result.ok, result.attempts], [true, 2]);
		assert.deepEqual(guard.stats().default, { checked: 2, suspicious: 1, failedRoundTrip: 1, retried: 1, fellBack: 0 });
		assert.match(logs[0], /heard as "Yarın toplantıya/u);
	});

	it('always: transcribes every sentence, and catches one of the right length that says the wrong thing', async () => {
		const ears = fakeEars(['Hiç alakası olmayan bambaşka bir cümle.', SENTENCE]);
		const voice = fakeVoice([RIGHT(), RIGHT()]);
		const guard = new TtsGuard({ stt: ears, verify: 'always' });
		const result = await guard.run(voice.synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(ears.calls.length, 2);
		assert.deepEqual([result.ok, result.attempts], [true, 2]);
		assert.deepEqual(guard.stats().default, { checked: 2, suspicious: 0, failedRoundTrip: 1, retried: 1, fellBack: 0 });
	});

	it('does without the transcriber when it is not there, and leaves it alone for a minute', async () => {
		let clock = 1_000_000;
		const ears = fakeEars([new Error('connect ECONNREFUSED 127.0.0.1:8020')]);
		const logs = [];
		const guard = new TtsGuard({ stt: ears, now: () => clock, log: (line) => logs.push(line) });
		const result = await guard.run(fakeVoice([RAMBLING(), RIGHT()]).synthesize, { text: SENTENCE, language: 'tr' });
		assert.deepEqual([result.ok, result.attempts], [true, 2], 'the length decided, and the sentence was made again');
		assert.equal(ears.calls.length, 1);
		assert.ok(logs.some((line) => line.includes('ECONNREFUSED') && line.includes('for a minute')), logs.join(' | '));

		await guard.run(fakeVoice([RAMBLING(), RIGHT()]).synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(ears.calls.length, 1, 'not asked again within the minute');
		clock += 61_000;
		await guard.run(fakeVoice([RAMBLING(), RIGHT()]).synthesize, { text: SENTENCE, language: 'tr' });
		assert.equal(ears.calls.length, 2, 'asked again after it');
		assert.equal(new TtsGuard({ stt: { busy: 0 } }).stt.transcribe, undefined, 'something without transcribe() is no transcriber');
	});

	it('does not wait long for a transcriber that does not answer', async () => {
		const ears = fakeEars(['hang']);
		const logs = [];
		const guard = new TtsGuard({ stt: ears, verifyTimeoutMs: 40, log: (line) => logs.push(line) });
		const started = Date.now();
		// AbortSignal.timeout does not hold the process open; the bot's own connections do, and this stands in.
		const alive = setTimeout(() => {}, 5000);
		const result = await guard.run(fakeVoice([RAMBLING(), RIGHT()]).synthesize, { text: SENTENCE, language: 'tr' }).finally(() => clearTimeout(alive));
		assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
		assert.deepEqual([result.ok, result.attempts], [true, 2]);
		assert.ok(logs.some((line) => line.includes('timed out')), logs.join(' | '));
	});

	it('stops everything when the listener cuts in', async () => {
		const ears = fakeEars(['hang']);
		const voice = fakeVoice([RAMBLING(), RIGHT()]);
		const controller = new AbortController();
		const guard = new TtsGuard({ stt: ears, verifyTimeoutMs: 10_000 });
		const running = guard.run(voice.synthesize, { text: SENTENCE, language: 'tr', signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(running);
		assert.equal(voice.calls.length, 1, 'no second attempt for a sentence nobody will hear');
	});
});

// ---------------------------------------------------------------- LocalTts against a speech server

/**
 * A speech server on a real port: /tts answers each request with the next audio of `voices` (the last one
 * again once they run out), /stt with the next of `heard` (a string, or a status number to fail with).
 */
async function withSpeechServer({ voices = [RIGHT()], heard = [] }, run) {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => {
			const body = Buffer.concat(chunks);
			const url = new URL(request.url, 'http://x');
			if (url.pathname === '/tts') {
				const payload = JSON.parse(body.toString('utf8'));
				const count = requests.filter((entry) => entry.path === '/tts').length;
				requests.push({ path: '/tts', payload });
				const audio = voices[Math.min(count, voices.length - 1)];
				response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-sample-rate': String(RATE) });
				response.end(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
				return;
			}
			if (url.pathname === '/stt') {
				const count = requests.filter((entry) => entry.path === '/stt').length;
				requests.push({ path: '/stt', language: url.searchParams.get('language'), rate: request.headers['x-sample-rate'], bytes: body.length });
				const answer = heard[Math.min(count, heard.length - 1)] ?? 503;
				if (typeof answer === 'number') {
					response.writeHead(answer, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ ok: false, error: 'the STT model is not loaded' }));
					return;
				}
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ ok: true, text: answer, language: 'tr' }));
				return;
			}
			response.writeHead(404);
			response.end();
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const url = `http://127.0.0.1:${server.address().port}`;
	try {
		await run({ url, requests });
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

const ttsRequests = (requests) => requests.filter((entry) => entry.path === '/tts');

describe('LocalTts: what it sends, and what it does with what comes back', () => {
	it('sends the words to say, and keeps a short line under those words', async () => {
		await withSpeechServer({ voices: [tone(2.4), tone(0.9)] }, async ({ url, requests }) => {
			const tts = new LocalTts({ url, languageId: 'tr', token: 'x' });
			await tts.speak("Saat 14:45'te geliyorum.");
			assert.deepEqual(ttsRequests(requests)[0].payload, { text: 'Saat on dört kırk beşte geliyorum.', language_id: 'tr' });
			const first = await tts.speak('%20');
			const second = await tts.speak('% 20');
			assert.equal(ttsRequests(requests).length, 2, '"%20" and "% 20" are the same words, made once');
			assert.equal(ttsRequests(requests)[1].payload.text, 'yüzde yirmi');
			assert.equal(second.cached, true);
			assert.equal(second.pcm, first.pcm);
		});
	});

	it('normalises in the language the request names: the guessed one when it is "auto"', async () => {
		await withSpeechServer({}, async ({ url, requests }) => {
			const tts = new LocalTts({ url, languageId: 'auto', token: 'x' });
			await tts.speak('Meet me at 14:45, okay?');
			await tts.speak("Saat 14:45'te geliyorum, tamam mı?");
			const [english, turkish] = ttsRequests(requests).map((entry) => entry.payload);
			assert.deepEqual(english, { text: 'Meet me at fourteen forty-five, okay?', language_id: 'en' });
			assert.deepEqual(turkish, { text: 'Saat on dört kırk beşte geliyorum, tamam mı?', language_id: 'tr' });
		});
	});

	it('sends the text as written with LOCAL_TTS_NORMALIZE=0, and nothing at all when there is nothing to say', async () => {
		await withSpeechServer({}, async ({ url, requests }) => {
			const raw = new LocalTts({ url, languageId: 'tr', normalize: false, token: 'x' });
			await raw.speak('Saat 14:45, **tamam**.');
			assert.equal(ttsRequests(requests)[0].payload.text, 'Saat 14:45, **tamam**.');
			const tts = new LocalTts({ url, languageId: 'tr', token: 'x' });
			const quiet = await tts.speak('😀👍');
			assert.equal(quiet.pcm.length, 0);
			assert.equal(ttsRequests(requests).length, 1, 'an emoji is not sent to be said');
		});
	});

	it('hears a sentence that ran on, makes it again with a new seed, and plays the second', async () => {
		await withSpeechServer({ voices: [RAMBLING(), RIGHT()], heard: ['Bugün hava çok güzel, bla bla bla bla bla bla bla bla.'] }, async ({ url, requests }) => {
			const stt = new LocalStt({ url, token: 'x' });
			const tts = new LocalTts({ url, languageId: 'tr', stt, token: 'x' });
			const result = await tts.speak(SENTENCE);
			const sent = ttsRequests(requests);
			assert.equal(sent.length, 2);
			assert.equal(sent[1].payload.text, sent[0].payload.text);
			assert.equal(sent[1].payload.temperature, 0.6);
			assert.ok(Number.isInteger(sent[1].payload.seed));
			const heard = requests.find((entry) => entry.path === '/stt');
			assert.deepEqual([heard.language, heard.rate, heard.bytes], ['tr', '16000', 12 * 16_000 * 2], 'twelve seconds, at 16 kHz');
			assert.equal(result.pcm.length, RIGHT().length);
			assert.deepEqual(tts.guard.stats().default, { checked: 2, suspicious: 1, failedRoundTrip: 1, retried: 1, fellBack: 0 });
		});
	});

	it('does not keep a short line that could not be made right', async () => {
		await withSpeechServer({ voices: [tone(6)] }, async ({ url, requests }) => {
			const tts = new LocalTts({ url, languageId: 'tr', verify: 'off', token: 'x' });
			await tts.speak('Evet.');
			await tts.speak('Evet.');
			assert.equal(ttsRequests(requests).length, 4, 'two attempts each time, and nothing cached in between');
		});
	});

	it('goes on by length alone when the server has no transcriber, and sends a fallback engine only when one is set', async () => {
		await withSpeechServer({ voices: [RAMBLING(), RAMBLING(), RIGHT()], heard: [503] }, async ({ url, requests }) => {
			const stt = new LocalStt({ url, token: 'x' });
			const tts = new LocalTts({ url, languageId: 'tr', stt, fallbackEngines: { '*': 'chatterbox' }, token: 'x', guardLog: () => {} });
			const result = await tts.speak(SENTENCE);
			const sent = ttsRequests(requests);
			assert.equal(sent.length, 3);
			assert.equal(sent[0].payload.engine, undefined);
			assert.equal(sent[1].payload.engine, undefined);
			assert.equal(sent[2].payload.engine, 'chatterbox');
			assert.equal(result.pcm.length, RIGHT().length);
			assert.equal(requests.filter((entry) => entry.path === '/stt').length, 1, 'asked once, then left alone');
		});
	});
});
