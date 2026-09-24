// Thin wrapper around OpenAI's GPT-Live WebSocket API (wss://api.openai.com/v1/live/sessions).
//
// Protocol notes (developers.openai.com/api/docs/guides/voice-websockets?api=live):
//  - first client message MUST be `session.start`, server answers `session.started`
//  - audio in : `session.input_audio.append` { audio: base64(mono PCM16 @ 24 kHz) }, no ack
//  - audio out: `session.output_audio.delta`   { delta: base64(mono PCM16 @ 24 kHz) }
//  - no output-audio-done event: playback is tracked locally
//  - graceful stop: send `session.close`, wait for `session.closed`, then close the socket

import { EventEmitter } from 'node:events';
import { OpenAI } from 'openai';
import { LiveWS } from 'openai/resources/live/ws';
import { t } from './i18n/index.js';

const START_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 15_000;
// WebSocket readyState of an open socket (the same number in ws and in the browser API).
const SOCKET_OPEN = 1;

// Append events (instructions/thinking/commentary) are plain text and limited to ~500 tokens per event.
// Turkish runs at ~3.5 characters per token, so 1500 characters is a safe ceiling; longer text is rejected by the server.
const APPEND_CHAR_LIMIT = 1500;

// Errors that retrying cannot fix: billing/quota/key. For these we wait a long interval instead of
// retrying every second, and the owner is told about it.
const FATAL_CODES = new Set([
	'credit_balance_exhausted',
	'insufficient_quota',
	'billing_hard_limit_reached',
	'billing_not_active',
	'invalid_api_key',
	'account_deactivated',
	'access_terminated',
	'model_not_found',
	'unsupported_model',
]);
const FATAL_TYPES = new Set(['authentication_error', 'permission_error']);

// The same wall arrives under several codes, and sometimes under none: a run out of credit has been seen
// as a plain invalid_request_error whose only clue is the sentence itself. Reading the sentence keeps the
// session from spending ten minutes failing silently while the assistant claims it did the work.
const FATAL_MESSAGE = /\b(?:no credits? remaining|credit balance is too low|billing|quota|exceeded your current quota|payment required|insufficient funds)\b/i;

// Error codes that come with an actionable hint for the owner; the text itself lives in the locale.
const FATAL_HINT_KEYS = {
	credit_balance_exhausted: 'live.hint_credit_balance',
	insufficient_quota: 'live.hint_quota',
	billing_hard_limit_reached: 'live.hint_billing_limit',
	invalid_api_key: 'live.hint_invalid_key',
	model_not_found: 'live.hint_model_missing',
};

/**
 * Turns a GPT-Live error into something readable: { code, type, message, fatal, hint }.
 * LiveWS usually hands the error over as raw JSON text; it is parsed here.
 */
export function describeLiveError(err) {
	const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '');
	let payload = null;
	if (err && typeof err === 'object' && !(err instanceof Error) && err.error) payload = err;
	else {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') payload = parsed;
		} catch {
			/* plain text */
		}
	}
	const inner = payload?.error && typeof payload.error === 'object' ? payload.error : payload ?? {};
	const code = inner.code ?? payload?.code ?? null;
	const type = inner.type ?? payload?.type ?? null;
	const message = inner.message ?? (typeof raw === 'string' && !payload ? raw : null) ?? t('live.unknown_error');
	const fatal = Boolean((code && FATAL_CODES.has(code)) || (type && FATAL_TYPES.has(type)) || FATAL_MESSAGE.test(String(message)));
	const hintKey = (code && FATAL_HINT_KEYS[code]) ?? (fatal && /credit|billing|quota|funds/i.test(String(message)) ? 'live.hint_credit_balance' : null);
	return { code, type, message: String(message).slice(0, 300), fatal, hint: hintKey ? t(hintKey) : null };
}

/** Cuts long content at a sentence/word boundary; the ellipsis makes the cut visible. */
export function clampAppend(content) {
	const text = String(content ?? '').trim();
	if (text.length <= APPEND_CHAR_LIMIT) return text;
	const cut = text.slice(0, APPEND_CHAR_LIMIT);
	const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf(' '));
	return `${cut.slice(0, at > 200 ? at + 1 : APPEND_CHAR_LIMIT).trim()}…`;
}

/**
 * Instruction block for the live model — laid out the way the guide suggests: identity/tone, backchannel,
 * interruption, then the "Delegation policy" (backend capabilities + when to delegate and when not to).
 * Long workflows belong to the backend (delegation.responses.instructions).
 */
export function capabilityNote() {
	return t('live.capability_note');
}

/** Backend (delegation) prompt: the business rules live here so the live prompt stays short. */
export function backendNote() {
	return t('live.backend_note');
}

export class LiveSession extends EventEmitter {
	constructor({
		apiKey,
		baseURL,
		model = 'gpt-live-1',
		voice = 'marin',
		instructions,
		debug = false,
		name = null,
		delegationModel = null,
		backendInstructions = null,
		backendEffort = null,
		backendTier = null,
		tools = [],
		toolExecutor = null,
	}) {
		super();
		this.apiKey = apiKey;
		this.baseURL = baseURL;
		this.model = model;
		this.voice = voice;
		this.instructions = instructions;
		this.debug = debug;
		this.name = name;
		this.delegationModel = delegationModel;
		this.backendInstructions = backendInstructions;
		this.backendEffort = backendEffort;
		this.backendTier = backendTier;
		this.tools = tools;
		this.toolExecutor = toolExecutor;
		this._pendingCalls = [];
		this._flushing = null;

		this.ws = null;
		this.ready = false;
		this.sessionId = null;
		this._closing = false;
		// The server's session.closed: the conversation is over even while the socket is still open.
		this._sessionClosed = false;
		// The socket itself is gone: nothing is left to wait for.
		this.ended = false;
		this._ctxSeq = 0;
	}

	_sessionConfig() {
		const wakeNote = this.name ? t('live.wake_note', { name: this.name }) : '';
		const session = {
			model: this.model,
			instructions: [this.instructions, capabilityNote(), wakeNote].filter(Boolean).join('\n').trim() || null,
			audio: {
				format: { type: 'audio/pcm', rate: 24000 },
				output: { voice: this.voice },
			},
		};
		if (this.delegationModel) {
			// Backend (Responses) model: it calls the tools, we carry the results out.
			const tools = [...(this.tools ?? [])];
			tools.push({ type: 'web_search' });
			session.delegation = {
				type: 'responses',
				responses: {
					model: this.delegationModel,
					tools,
					tool_choice: 'auto',
					parallel_tool_calls: false,
					instructions: this.backendInstructions ?? backendNote(),
					max_output_tokens: 1200,
					// Latency knob: low effort speeds up tool selection (guide: "Reduce backend latency").
					...(this.backendEffort ? { reasoning: { effort: this.backendEffort } } : {}),
					...(this.backendTier ? { service_tier: this.backendTier } : {}),
				},
			};
		} else {
			// No tools: client delegation, where the app itself carries the tasks out.
			session.delegation = { type: 'client' };
		}
		return session;
	}

	async connect() {
		return this._connectOnce();
	}

	async _connectOnce() {
		const client = new OpenAI({ apiKey: this.apiKey, ...(this.baseURL ? { baseURL: this.baseURL } : {}) });
		const ws = new LiveWS(client, { reconnect: null, maxQueueSize: 4 * 1024 * 1024 });
		this.ws = ws;
		this._wire(ws);

		const started = new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				ws.off('session.started', onStarted);
				ws.off('error', onError);
				ws.off('close', onClose);
			};
			const onStarted = (event) => {
				cleanup();
				resolve(event);
			};
			const onError = (err) => {
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err?.message ?? err)));
			};
			// If the server closes before the handshake (permission/policy refusal), do not sit there for 20 s.
			const onClose = (code, reason) => {
				cleanup();
				reject(new Error(t('live.closed_before_handshake', { detail: `${code}${reason ? ` ${reason}` : ''}` })));
			};
			const timer = setTimeout(() => {
				cleanup();
				try {
					ws.close({ code: 1000, reason: 'start timeout' });
				} catch {
					/* ignore */
				}
				reject(new Error(t('live.start_timeout')));
			}, START_TIMEOUT_MS);
			ws.once('session.started', onStarted);
			ws.once('error', onError);
			ws.once('close', onClose);
		});

		// LiveWS queues sends until the socket is open, so this is safe right away.
		ws.send({ type: 'session.start', event_id: 'event_start', session: this._sessionConfig() });

		const event = await started;
		this.sessionId = event?.session?.id ?? null;
		// close() was called while the handshake was finishing: the session is on its way out and must
		// not be announced as ready, or the caller would start using a socket it has just let go of.
		if (this._closing || this.ended) return this.sessionId;
		this.ready = true;
		this.emit('ready', { sessionId: this.sessionId });
		// Tool calls may have arrived while the connection was being set up; handle them now.
		this._scheduleFlush();
		return this.sessionId;
	}

	_wire(ws) {
		ws.on('session.output_audio.delta', (event) => {
			this.emit('audio', Buffer.from(event.delta, 'base64'));
		});
		ws.on('session.input_transcript.delta', (event) => {
			this.emit('transcript', { speaker: 'user', text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
		});
		ws.on('session.output_transcript.delta', (event) => {
			this.emit('transcript', { speaker: 'assistant', text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
		});
		ws.on('session.usage.updated', (event) => {
			this.emit('usage', { seconds: event?.usage?.seconds ?? 0 });
		});
		ws.on('session.closed', (event) => {
			this.ready = false;
			this._sessionClosed = true;
			this.emit('sessionClosed', event);
			// The server ended the session on its own. Nothing more can be said on this socket, and a socket
			// left open here would keep the caller believing it still had a session; closing it from this side
			// turns the end into the one 'closed' event the caller already plans its reconnect around.
			if (!this._closing) {
				try {
					ws.close({ code: 1000, reason: 'session closed by server' });
				} catch {
					/* already gone */
				}
			}
		});
		ws.on('session.delegation.created', (event) => {
			const delegation = event?.delegation;
			if (delegation?.target === 'client' && delegation?.id) {
				this.emit('turn', { delegationId: delegation.id, kind: 'client' });
				this.emit('delegation', delegation);
			}
		});
		ws.on('response.event', (envelope) => this._onResponseEvent(envelope));
		ws.on('error', (err) => {
			this.emit('error', err);
		});
		ws.on('close', (code, reason) => {
			this.ready = false;
			this.ended = true;
			this.emit('closed', { code, reason, expected: this._closing });
		});
		if (this.debug) {
			ws.on('event', (event) => this.emit('debug', event));
		}
	}

	/** Nested Responses events: collect the tool calls and run them once the response is finished. */
	_onResponseEvent(envelope) {
		const nested = envelope?.event;
		if (!nested || typeof nested.type !== 'string') return;
		if (nested.type === 'response.created') {
			this._backendAt = Date.now();
			// Turn: the model started answering what the user said. The continuation response that follows a
			// tool result (the one we ask for with response.create) is NOT a new turn; the owner gate looks at
			// the moment of the first turn.
			const continuation = this._continuing === true;
			this._continuing = false;
			if (!continuation) this.emit('turn', { delegationId: envelope.delegation_id ?? null, kind: 'backend' });
			return;
		}
		if (nested.type === 'response.output_item.done' && nested.item?.type === 'function_call') {
			this._pendingCalls.push({
				callId: nested.item.call_id,
				name: nested.item.name,
				arguments: nested.item.arguments,
				delegationId: envelope.delegation_id,
			});
			return;
		}
		if (nested.type === 'response.failed' || nested.type === 'response.incomplete' || nested.type === 'response.cancelled') {
			// Do not let the tool calls of a failed response run by accident on the next response.
			const dropped = this._pendingCalls.length;
			this._pendingCalls.length = 0;
			this._backendAt = null;
			this._continuing = false;
			const reason = nested.response?.error?.message ?? nested.response?.incomplete_details?.reason ?? nested.type;
			const droppedNote = dropped ? t('live.tool_calls_dropped', { count: dropped }) : '';
			this.emit('warning', t('live.backend_incomplete', { reason, dropped: droppedNote }));
			return;
		}
		if (nested.type === 'response.completed') {
			if (this._backendAt) {
				this.emit('backend', { ms: Date.now() - this._backendAt });
				this._backendAt = null;
			}
			this._scheduleFlush();
		}
	}

	/** Serialises the flush and emits its error as an event (so no rejection goes unhandled). */
	_scheduleFlush() {
		const run = () =>
			this._flushToolCalls().catch((err) => {
				this.emit('error', err instanceof Error ? err : new Error(String(err)));
			});
		this._flushing = (this._flushing ?? Promise.resolve()).then(run, run);
		return this._flushing;
	}

	_canSend() {
		if (!this.ws || !this.ready || this._closing) return false;
		// A socket the server has started to close takes a moment to report 'close', and every 20 ms audio
		// frame written into it meanwhile came back as an error of its own -- three of those were enough
		// to condemn the session. Only an open socket is written to.
		const socket = this.ws.socket;
		return !socket || socket.readyState === SOCKET_OPEN;
	}

	_send(payload) {
		if (!this._canSend()) return false;
		try {
			this.ws.send(payload);
			return true;
		} catch (err) {
			this.emit('error', err instanceof Error ? err : new Error(String(err)));
			return false;
		}
	}

	/** Runs the pending tool calls, sends the results back to the backend and lets it carry on. */
	async _flushToolCalls() {
		// If the session is closing (e.g. the "leave" command) there is no point in sending new client
		// events; the API rejects them with a "session is closing" error.
		if (!this._canSend() || !this._pendingCalls.length || !this.toolExecutor) return;
		const calls = this._pendingCalls.splice(0, this._pendingCalls.length);
		let delivered = 0;
		for (const call of calls) {
			let args = {};
			let output;
			const startedAt = Date.now();
			try {
				args = call.arguments ? JSON.parse(call.arguments) : {};
			} catch {
				output = JSON.stringify({ ok: false, error: t('live.tool_args_unparsable') });
			}
			if (output === undefined) {
				try {
					output = await this.toolExecutor(call.name, args, { delegationId: call.delegationId ?? null, callId: call.callId });
				} catch (err) {
					output = JSON.stringify({ ok: false, error: err.message });
				}
			}
			this.emit('tool', { name: call.name, args, output, ms: Date.now() - startedAt });
			// The session may have closed while the tool was running (e.g. the "leave the channel" tool
			// itself); sending a result to a closed session produces an API error.
			if (!this._canSend()) {
				this._pendingCalls.length = 0;
				return;
			}
			if (
				this._send({
					type: 'response.item.create',
					event_id: `tool_${++this._ctxSeq}`,
					item: { type: 'function_call_output', call_id: call.callId, output },
				})
			) {
				delivered++;
			}
		}
		// The results are on their way; ask the backend explicitly to carry on.
		if (delivered > 0) {
			this._continuing = true;
			this._send({ type: 'response.create', event_id: `cont_${++this._ctxSeq}` });
		}
	}

	/** Returns the delegation result to the model: commentary = spoken out loud, thinking = silent context. */
	replyDelegation(delegationId, content, { mode = 'commentary' } = {}) {
		if (!this._canSend() || !delegationId) return false;
		const text = clampAppend(content);
		if (!text) return false;
		return this._send({
			type: mode === 'thinking' ? 'session.thinking.append' : 'session.commentary.append',
			event_id: `dg_${++this._ctxSeq}`,
			delegation_id: delegationId,
			content: text,
		});
	}

	/** Feed one 20 ms PCM16 mono @24 kHz frame (an Int16Array). */
	sendAudio(samples) {
		if (!this._canSend()) return false;
		const audio = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
		return this._send({ type: 'session.input_audio.append', audio });
	}

	/** Add context to a running session: kind = 'instructions' | 'thinking' | 'commentary'. */
	appendContext(kind, content) {
		if (!this._canSend()) return false;
		const text = clampAppend(content);
		if (!text) return false;
		const type =
			kind === 'instructions'
				? 'session.instructions.append'
				: kind === 'commentary'
					? 'session.commentary.append'
					: 'session.thinking.append';
		return this._send({ type, event_id: `ctx_${++this._ctxSeq}`, delegation_id: null, content: text });
	}

	async close() {
		const ws = this.ws;
		if (!ws || this._closing) return false;
		this._closing = true;
		this.ready = false;

		// Socket not open, or the server has already ended the session: there is nothing to finalize and no
		// session.closed still to come, so the socket is closed at once.
		if (ws.socket?.readyState !== SOCKET_OPEN || this.ended || this._sessionClosed) {
			try {
				ws.close({ code: 1000, reason: 'client shutdown' });
			} catch {
				/* ignore */
			}
			return this._sessionClosed;
		}

		// Done at the acknowledgement, or when the socket dies without one: a dead socket never sends
		// session.closed, and waiting out the full timeout for it kept the session counted as open.
		const closed = new Promise((resolve) => {
			const finish = (acknowledged) => {
				clearTimeout(timer);
				ws.off('session.closed', onClosed);
				ws.off('close', onSocketClosed);
				resolve(acknowledged);
			};
			const onClosed = () => finish(true);
			const onSocketClosed = () => finish(false);
			const timer = setTimeout(() => finish(false), CLOSE_TIMEOUT_MS);
			ws.once('session.closed', onClosed);
			ws.once('close', onSocketClosed);
		});

		try {
			ws.send({ type: 'session.close' });
		} catch {
			// socket already gone; nothing to finalize
		}
		const acknowledged = await closed;
		try {
			ws.close({ code: 1000, reason: 'client shutdown' });
		} catch {
			// ignore
		}
		return acknowledged;
	}
}
