// The bot itself starts and stops the Chatterbox (TTS + whisper STT) server.
// When it has to switch to the local brain and the server is not up, tools/chatterbox_server.py is
// run with the Python inside .venv-chatterbox; its output lands in the bot log as "[chatterbox] …".
//
// The server listens on loopback, which every web page the owner opens can reach as well, so each
// launch is given a random token and only requests carrying it are served. The TTS and STT clients
// add it to every request through speechHeaders().
//
// A bot that is killed outright (a crash, a closed console, kill -9) leaves its server running, still
// holding the port and the token of that launch. The next start knew neither: its requests were refused,
// and the servers it launched in their place could not bind the port, until it gave up. So the token of
// the last launch is kept in a file only the owner can read (data/chatterbox.token), and a start that
// finds one uses it, for its requests and for its own launches: a server left behind answers again, and
// if there is none, a launch takes the port with the same token. Stopping a server of ours that held the
// port deletes the file, so the next clean start draws a fresh token.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { t } from './i18n/index.js';

const NOISE = /Sampling:|it\/s\]|Fetching \d+ files|^\s*$|FutureWarning|self\.gen = func|"GET \/health HTTP|unauthenticated requests to the HF Hub|generation flags are not valid/;

/** The Python of the virtual environment in the project root (null when there is none). */
export function detectVenvPython(root) {
	const candidates =
		process.platform === 'win32'
			? [path.join(root, '.venv-chatterbox', 'Scripts', 'python.exe')]
			: [path.join(root, '.venv-chatterbox', 'bin', 'python3'), path.join(root, '.venv-chatterbox', 'bin', 'python')];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** The header the speech server reads its token from (tools/chatterbox_server.py). */
export const SPEECH_TOKEN_HEADER = 'x-chatterbox-token';

// One token for the whole process: the server is one per machine, while the TTS client lives in every
// guild session and the STT client in index.js. LOCAL_TTS_TOKEN sets it for a server started by hand;
// a launch from here replaces it with the one that launch was given.
let speechToken = null;

/** Sets the token requests to the speech server carry (null: none). */
export function setSpeechToken(token) {
	speechToken = token ? String(token) : null;
}

/** `headers` plus the speech server's token, when there is one; `token` overrides the shared one. */
export function speechHeaders(headers = {}, token = null) {
	const value = token ?? speechToken;
	return value ? { ...headers, [SPEECH_TOKEN_HEADER]: value } : { ...headers };
}

/** The environment the speech server is started with: paths and tuning only, never our secrets. */
function childEnv(token) {
	const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'CUDA_PATH', 'HF_HOME', 'TRANSFORMERS_CACHE'];
	const env = {};
	for (const name of keep) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	// Through the environment rather than --token: a command line is visible to every account on the
	// machine, the environment of a process only to its owner.
	return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '2', CHATTERBOX_TOKEN: token };
}

// What a launch token looks like (randomBytes(32) as hex); a file holding anything else is not ours.
const LAUNCH_TOKEN = /^[0-9a-f]{64}$/u;
// The line tools/chatterbox_server.py prints once it has bound its port.
const LISTENING = /^\[chatterbox\] listening on:/u;

/** The token an earlier start of the bot left in `file`, or null. */
function readKeptToken(file) {
	try {
		const text = readFileSync(file, 'utf8').trim();
		return LAUNCH_TOKEN.test(text) ? text : null;
	} catch {
		return null;
	}
}

export class LocalServerManager {
	constructor({
		python,
		script,
		args = [],
		token = null,
		tokenFile = null,
		cwd = process.cwd(),
		log = () => {},
		spawnImpl = spawn,
		maxRestarts = 3,
		now = Date.now,
	}) {
		this.python = python;
		this.script = script;
		this.args = args;
		// LOCAL_TTS_TOKEN, when set, is used for every launch, so a server started by hand with the same
		// value and one started from here are interchangeable; otherwise each launch draws its own.
		this.token = token ? String(token) : null;
		// Where the token of the last launch is kept, for the next start (see the top of this file). Not
		// used with LOCAL_TTS_TOKEN, which the owner keeps already.
		this.tokenFile = this.token ? null : tokenFile;
		// A token an earlier start left behind: its server may still be running, and it is the one the
		// requests carry from the beginning.
		this.keptToken = this.tokenFile ? readKeptToken(this.tokenFile) : null;
		if (this.keptToken) setSpeechToken(this.keptToken);
		this.cwd = cwd;
		this.log = log;
		this.spawn = spawnImpl;
		this.maxRestarts = maxRestarts;
		this.now = now;
		this.child = null;
		// Whether this child has bound the port (see ensureRunning).
		this.childListening = false;
		this.startedAt = 0;
		this.exits = 0;
		this.lastExit = null;
		this.lastError = null;
		this.stopping = false;
	}

	get running() {
		return Boolean(this.child);
	}

	get status() {
		if (this.child) return t('brain.local_server_running');
		if (this.lastError) return t('brain.local_server_start_failed', { error: this.lastError });
		if (this.lastExit !== null) return t('brain.local_server_exited', { code: this.lastExit });
		return t('brain.local_server_off');
	}

	/** Starts the server when it is not up. Returns false when it cannot be started (no venv, crashed too often). */
	ensureRunning() {
		if (this.child) return true;
		if (!this.python || !existsSync(this.python)) {
			this.lastError = t('brain.local_server_no_venv');
			return false;
		}
		if (!existsSync(this.script)) {
			this.lastError = t('brain.local_server_no_script', { script: this.script });
			return false;
		}
		if (this.exits >= this.maxRestarts) {
			this.lastError = t('brain.local_server_gave_up', { count: this.exits });
			return false;
		}
		this.stopping = false;
		this.lastError = null;
		// While a server of an earlier start may hold the port, every launch uses its token: a launch that
		// cannot bind then exits without taking the requests away from the server that answers them.
		const token = this.token ?? this.keptToken ?? randomBytes(32).toString('hex');
		let child;
		try {
			child = this.spawn(this.python, ['-u', this.script, ...this.args], {
				cwd: this.cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				// OPENBLAS: numpy's thread buffers give "allocation failed" on a memory-tight machine; pointless on the GPU path.
				// Only what Python needs to run. Spreading process.env would hand the Discord token and the
				// OpenAI/DeepSeek keys to third-party model code that has no use for them.
				env: childEnv(token),
			});
		} catch (err) {
			this.lastError = err.message;
			return false;
		}
		setSpeechToken(token);
		this.keepToken(token);
		this.child = child;
		this.childListening = false;
		this.startedAt = this.now();
		this.log(
			t('brain.local_server_starting', {
				python: path.basename(this.python),
				script: path.basename(this.script),
				args: this.args.join(' '),
			}),
		);
		for (const stream of [child.stdout, child.stderr]) {
			if (!stream) continue;
			readline.createInterface({ input: stream }).on('line', (line) => {
				// The server says so once it has bound the port. From then on the port is ours, so no server
				// of an earlier start is holding it, and its token has done its job.
				if (this.child === child && LISTENING.test(line)) {
					this.childListening = true;
					this.keptToken = null;
				}
				if (NOISE.test(line)) return;
				this.log(`[chatterbox] ${line.replace(/^\[chatterbox\]\s*/, '').trim()}`);
			});
		}
		child.once('error', (err) => {
			this.lastError = err.message;
			this.log(t('brain.local_server_spawn_failed', { error: err.message }));
			if (this.child === child) this.child = null;
		});
		child.once('exit', (code, signal) => {
			if (this.child === child) this.child = null;
			this.lastExit = code ?? signal ?? null;
			if (!this.stopping) {
				this.exits++;
				this.log(t('brain.local_server_exit_log', { code: this.lastExit, count: this.exits, max: this.maxRestarts }));
			}
		});
		return true;
	}

	/** Writes the launch token where the next start finds it, readable by the owner only (0600). */
	keepToken(token) {
		if (!this.tokenFile) return;
		try {
			writeFileSync(this.tokenFile, token, { mode: 0o600 });
			// The mode above applies to a new file only; one left by an earlier start keeps its own.
			chmodSync(this.tokenFile, 0o600);
		} catch (err) {
			this.log(t('brain.local_server_token_not_kept', { file: this.tokenFile, error: err.message }));
		}
	}

	stop() {
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		try {
			child.kill();
		} catch {
			/* ignore */
		}
		this.child = null;
		// A server of ours that held the port goes with the bot, and so does its token. Otherwise the file
		// stays: the launch may have found the port taken by a server an earlier start left behind, which is
		// still answering with that token.
		if (this.tokenFile && this.childListening) rmSync(this.tokenFile, { force: true });
	}
}
