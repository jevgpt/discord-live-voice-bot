import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { LocalServerManager, SPEECH_TOKEN_HEADER, detectVenvPython, setSpeechToken, speechHeaders } from '../../src/localserver.js';
import { LocalStt } from '../../src/localstt.js';
import { LocalTts } from '../../src/localtts.js';

function fakeSpawn() {
	const calls = [];
	return {
		calls,
		spawn: (bin, args, opts) => {
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = () => {
				child.killed = true;
				setImmediate(() => child.emit('exit', null, 'SIGTERM'));
			};
			calls.push({ bin, args, opts, child });
			return child;
		},
	};
}

describe('LocalServerManager', () => {
	it('starts the server once, filters the noisy output, counts the exits and gives up at the limit', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'srv-'));
		const python = path.join(dir, 'python.exe');
		const script = path.join(dir, 'server.py');
		writeFileSync(python, '');
		writeFileSync(script, '');
		const logs = [];
		const fake = fakeSpawn();
		const manager = new LocalServerManager({ python, script, args: ['--stt', 'small'], log: (m) => logs.push(m), spawnImpl: fake.spawn, maxRestarts: 2 });
		assert.equal(manager.status, 'off');
		assert.equal(manager.ensureRunning(), true);
		assert.equal(manager.ensureRunning(), true, 'a second call must not spawn another process');
		assert.equal(fake.calls.length, 1);
		assert.deepEqual(fake.calls[0].args.slice(-2), ['--stt', 'small']);
		assert.equal(fake.calls[0].opts.env.PYTHONUTF8, '1');

		const { child } = fake.calls[0];
		child.stdout.write('[chatterbox] ready — sr=24000\n');
		child.stdout.write('Sampling:  8%|▊ | 76/1000 [00:12<02:31,  6.08it/s]\n');
		child.stderr.write('Traceback: error\n');
		await new Promise((r) => setImmediate(r));
		assert.ok(logs.some((m) => m === '[chatterbox] ready — sr=24000'), logs.join(' | '));
		assert.ok(!logs.some((m) => m.includes('Sampling')), 'the progress bar must be filtered out');
		assert.ok(logs.some((m) => m.includes('Traceback')));

		child.emit('exit', 1, null);
		assert.equal(manager.running, false);
		assert.equal(manager.exits, 1);
		assert.equal(manager.ensureRunning(), true, 'it tries one more time');
		fake.calls[1].child.emit('exit', 1, null);
		assert.equal(manager.ensureRunning(), false, 'it gives up once the limit is reached');
		assert.ok(manager.status.includes('stopped 2 times'), manager.status);
	});

	it('refuses to start without a virtual environment, and finds no python in a missing directory', () => {
		const fake = fakeSpawn();
		const manager = new LocalServerManager({ python: null, script: 'x.py', spawnImpl: fake.spawn });
		assert.equal(manager.ensureRunning(), false);
		assert.ok(manager.status.includes('no virtual environment'), manager.status);
		assert.equal(detectVenvPython(path.join(os.tmpdir(), 'no-such-directory')), null);
	});
});

/** Stands in for the speech server: records what each request carried and answers like it would. */
async function withFakeSpeechServer(run) {
	const seen = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const headers = new Headers(options.headers ?? {});
		seen.push({ path: new URL(url).pathname, token: headers.get(SPEECH_TOKEN_HEADER), type: headers.get('content-type') });
		if (headers.get(SPEECH_TOKEN_HEADER) === 'stale') return new Response('{"ok":false,"error":"missing or wrong token"}', { status: 403 });
		if (url.endsWith('/health')) return Response.json({ ok: true, model: 'multilingual', sr: 24_000, stt: 'small' });
		if (url.includes('/stt')) return Response.json({ ok: true, text: 'merhaba', language: 'tr' });
		return new Response(Buffer.alloc(4), { headers: { 'x-sample-rate': '24000' } });
	};
	try {
		await run(seen);
	} finally {
		globalThis.fetch = original;
		setSpeechToken(null);
	}
}

function venv() {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'srv-'));
	const python = path.join(dir, 'python.exe');
	const script = path.join(dir, 'server.py');
	writeFileSync(python, '');
	writeFileSync(script, '');
	return { python, script };
}

describe('speech server token', () => {
	it('gives every launch a fresh random token, through the environment and never the command line', () => {
		const fake = fakeSpawn();
		const manager = new LocalServerManager({ ...venv(), args: ['--port', '8020'], log: () => {}, spawnImpl: fake.spawn });
		try {
			assert.equal(manager.ensureRunning(), true);
			const first = fake.calls[0].opts.env.CHATTERBOX_TOKEN;
			assert.match(first, /^[0-9a-f]{64}$/u);
			assert.ok(!fake.calls[0].args.some((arg) => arg.includes(first)), 'a command line is readable by every account');
			assert.equal(speechHeaders()[SPEECH_TOKEN_HEADER], first, 'the clients send what this launch was given');
			fake.calls[0].child.emit('exit', 1, null);
			assert.equal(manager.ensureRunning(), true);
			const second = fake.calls[1].opts.env.CHATTERBOX_TOKEN;
			assert.notEqual(second, first);
			assert.equal(speechHeaders()[SPEECH_TOKEN_HEADER], second);
		} finally {
			setSpeechToken(null);
		}
	});

	it('uses LOCAL_TTS_TOKEN for every launch when one is set, so a server started by hand is the same', () => {
		const fake = fakeSpawn();
		const manager = new LocalServerManager({ ...venv(), token: 'configured-token', log: () => {}, spawnImpl: fake.spawn });
		try {
			manager.ensureRunning();
			fake.calls[0].child.emit('exit', 1, null);
			manager.ensureRunning();
			assert.deepEqual(
				fake.calls.map((call) => call.opts.env.CHATTERBOX_TOKEN),
				['configured-token', 'configured-token'],
			);
		} finally {
			setSpeechToken(null);
		}
	});

	it('adds nothing while there is no token, and a client token overrides the shared one', () => {
		setSpeechToken(null);
		assert.deepEqual(speechHeaders({ 'content-type': 'application/json' }), { 'content-type': 'application/json' });
		setSpeechToken('shared');
		assert.equal(speechHeaders({})[SPEECH_TOKEN_HEADER], 'shared');
		assert.equal(speechHeaders({}, 'own')[SPEECH_TOKEN_HEADER], 'own');
		setSpeechToken(null);
	});

	it('the TTS and STT clients send the token on every request, with the content type the server insists on', async () => {
		await withFakeSpeechServer(async (seen) => {
			setSpeechToken('launch-token');
			const tts = new LocalTts({ url: 'http://127.0.0.1:8020', languageId: 'en' });
			const stt = new LocalStt({ url: 'http://127.0.0.1:8020' });
			assert.equal((await tts.health()).ok, true);
			await tts.speak('Hello there.');
			assert.equal((await stt.health()).sttReady, true);
			assert.equal((await stt.transcribe(new Int16Array(2400))).text, 'merhaba');
			assert.deepEqual(
				seen.map(({ path: where, token, type }) => [where, token, type]),
				[
					['/health', 'launch-token', null],
					['/tts', 'launch-token', 'application/json'],
					['/health', 'launch-token', null],
					['/stt', 'launch-token', 'application/octet-stream'],
				],
			);
		});
	});

	it('says in the log when the server refuses the request, and reports it as down', async () => {
		await withFakeSpeechServer(async () => {
			const logs = [];
			const tts = new LocalTts({ url: 'http://127.0.0.1:8020', token: 'stale', log: (line) => logs.push(line) });
			const stt = new LocalStt({ url: 'http://127.0.0.1:8020', token: 'stale', log: (line) => logs.push(line) });
			assert.equal(await tts.health(), null);
			assert.equal(await stt.health(), null);
			assert.equal(logs.length, 2);
			assert.ok(logs.every((line) => line.includes('refused the request (403)') && line.includes('LOCAL_TTS_TOKEN')), logs.join(' | '));
		});
	});
});
