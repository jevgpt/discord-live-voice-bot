// Voice session manager: join/leave a channel, receive audio per speaker, run the 20 ms bridge and
// push the bot's voice (and music) into the channel.
//
// DAVE/E2EE is handled automatically by @discordjs/voice 0.19+.

import { PassThrough } from 'node:stream';
import {
	EndBehaviorType,
	NoSubscriberBehavior,
	StreamType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import { SAMPLES_PER_FRAME_24K, int16From } from './audio.js';
import { AudioBridge } from './bridge.js';
import { t } from './i18n/index.js';

const READY_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RENEW_INTERVAL_MS = 1000;

/**
 * Resolves once the connection reaches `status`; if it goes Destroyed instead (and that is not the
 * target state) it rejects right away, so the 15 s timeout is not waited out for nothing.
 */
function waitForState(connection, status, timeoutMs) {
	if (connection.state.status === status) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			connection.off('stateChange', onState);
		};
		const onState = (_oldState, newState) => {
			if (newState.status === status) {
				cleanup();
				resolve();
			} else if (newState.status === VoiceConnectionStatus.Destroyed) {
				cleanup();
				reject(new Error(t('voice.connection_destroyed')));
			}
		};
		const timer = setTimeout(() => {
			connection.off('stateChange', onState);
			reject(new Error(t('voice.state_timeout', { status, current: connection.state.status })));
		}, timeoutMs);
		connection.on('stateChange', onState);
	});
}

const EMPTY_PACKET = Buffer.alloc(0);

/**
 * A speaker's missing frames, made up by their decoder (Opus packet loss concealment) and handed out
 * 20 ms at a time. Decoding an empty packet does not give one frame: it fills the whole output buffer,
 * 5760 samples with @discordjs/opus (240 ms at 24 kHz) and 2880 with opusscript (120 ms), fading as it
 * goes. Asking afresh for every missing frame threw all but the first 20 ms of each decode away, so the
 * second and third frames of a gap came from 240 and 480 ms into the fade -- measured on a 300 Hz tone,
 * the second at a tenth of the level of the first -- and the decoder had run up to 720 ms past the packet
 * that came next. Decoded once per gap and served in order, the frames are the continuation the codec meant, and
 * the decoder runs ahead by one decode instead of three (neither library lets decode be asked for less).
 */
export class Concealment {
	/** @param {(packet: Buffer) => Buffer | null | undefined} decode the decoder's own decode */
	constructor(decode, frameSamples = SAMPLES_PER_FRAME_24K) {
		this.decode = decode;
		this.frameSamples = frameSamples;
		this.pcm = null;
		this.at = 0;
	}

	/** A real packet was decoded: the gap is over, and the next one starts from a fresh decode. */
	reset() {
		this.pcm = null;
		this.at = 0;
	}

	/** The next frame of the gap, or null when the decoder has nothing to give. */
	next() {
		if (!this.pcm || this.at >= this.pcm.length) {
			const raw = this.decode(EMPTY_PACKET);
			if (!raw?.length) return null;
			this.pcm = int16From(raw);
			this.at = 0;
		}
		const frame = this.pcm.subarray(this.at, this.at + this.frameSamples);
		this.at += frame.length;
		return frame;
	}
}

export class VoiceSession {
	constructor({
		getClient = null,
		client = null,
		mixer,
		playback,
		getLive,
		music = null,
		ducker = null,
		log,
		debug = false,
		soloUserId = null,
		onSpeaking = null,
		onLost = null,
		onFrame = null,
		onUserPcm = null,
	}) {
		this._client = client;
		this.getClient = getClient ?? (() => this._client);
		this.mixer = mixer;
		this.playback = playback;
		this.getLive = getLive;
		this.music = music;
		this.ducker = ducker;
		this.log = log;
		this.debug = debug;
		this.soloUserId = soloUserId;
		this.onSpeaking = onSpeaking;
		this.onLost = onLost;
		this.onFrame = onFrame;
		this.onUserPcm = onUserPcm; // local STT: decoded 24 kHz mono packet per user

		this.connection = null;
		this.player = null;
		this.pcmStream = null;
		this.bridge = null;
		this.lastRenewAt = 0;
		this.renewTimer = null; // a renewal put off to the end of the throttle's second (see renewOutput)
		this.subscriptions = new Map(); // userId -> { opusStream, decoder }
		this._joining = null;
		this._joiningChannel = null;
		this._joinSeq = 0;
	}

	get client() {
		return this.getClient();
	}

	set client(value) {
		this._client = value;
	}

	get connected() {
		return this.connection?.state?.status === VoiceConnectionStatus.Ready;
	}

	get channelId() {
		return this.connection?.joinConfig?.channelId ?? null;
	}

	/**
	 * Joins a channel. Does nothing when we are already solidly connected to it; waits for an in-flight
	 * join to the same channel; an in-flight join to a DIFFERENT channel is cancelled.
	 */
	async join(guild, channel) {
		const current = this.connection?.joinConfig;
		if (current?.channelId === channel.id && this.connected) return; // already solidly connected
		if (this._joining && this._joiningChannel === channel.id) return this._joining; // a join is in flight: wait for it
		const seq = ++this._joinSeq; // another in-flight join sees this number change and gives up
		this._joiningChannel = channel.id;
		this._joining = this._join(guild, channel, seq);
		try {
			await this._joining;
		} finally {
			if (this._joinSeq === seq) {
				this._joining = null;
				this._joiningChannel = null;
			}
		}
	}

	async _join(guild, channel, seq) {
		this.leave();
		let attempt = 0;
		for (;;) {
			if (seq !== this._joinSeq) throw new Error(t('voice.join_cancelled'));
			const connection = joinVoiceChannel({
				channelId: channel.id,
				guildId: guild.id,
				adapterCreator: guild.voiceAdapterCreator,
				selfDeaf: false, // a deafened client receives no audio
				selfMute: false,
				group: `${this.client.user.id}:${attempt}`,
			});
			this.connection = connection;
			try {
				await waitForState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
				if (seq !== this._joinSeq || this.connection !== connection) {
					try {
						connection.destroy();
					} catch {
						/* ignore */
					}
					throw new Error(t('voice.join_cancelled'));
				}
				break;
			} catch (err) {
				if (seq !== this._joinSeq || this.connection !== connection) throw err;
				if (attempt + 1 >= MAX_ATTEMPTS) {
					this.leave();
					throw err;
				}
				attempt++;
				// After a stale voice state Discord can leave the join request unanswered; leaving and
				// rejoining forces a real state change.
				this.log(t('voice.join_retry'));
				try {
					connection.destroy();
				} catch {
					/* ignore */
				}
				await new Promise((resolve) => setTimeout(resolve, 1500));
			}
		}
		this.setupRuntime();
	}

	setupRuntime() {
		const connection = this.connection;
		const isCurrent = () => this.connection === connection;

		connection.on('stateChange', (oldState, newState) => {
			if (!isCurrent()) return;
			if (this.debug) this.log(t('voice.state_change', { from: oldState.status, to: newState.status }));
			if (newState.status === VoiceConnectionStatus.Disconnected) {
				// Pushing audio into a broken transport after a drop produces robotic/choppy sound; pause the
				// stream and start it again if the connection comes back.
				this.bridge?.stop();
			} else if (newState.status === VoiceConnectionStatus.Ready) {
				// A drop destroys the stream the player was reading from, and a destroyed stream never plays
				// again: the bot came back to the channel and stayed silent for the rest of the session while
				// everything upstream kept reporting success. Coming back means building a new one.
				if (this.pcmStream?.destroyed) this.renewOutput();
				if (this.bridge && !this.bridge.running) this.bridge.start();
			}
		});
		connection.on('error', (err) => {
			if (!isCurrent()) return;
			this.log(t('voice.connection_error'), err.message);
		});
		connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
			// While switching channels the old connection still emits its closing events; ignore them.
			if (!isCurrent()) return;
			const code = newState.closeCode ? t('voice.disconnect_code', { code: newState.closeCode }) : '';
			this.log(t('voice.disconnected', { reason: newState.reason ?? '?', code }));
			try {
				await waitForState(connection, VoiceConnectionStatus.Ready, 15_000);
			} catch {
				if (!isCurrent()) return;
				this.onLost?.();
			}
		});

		this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
		this.player.on('error', (err) => {
			this.log(t('voice.player_error'), err.message);
			this.renewOutput();
		});
		// A 20 ms stereo frame is 3840 bytes, so the stream's default 16 KB cushion is about 85 ms: one
		// garbage collection or one slow tick of the event loop overflows it, and an overflowing output
		// drops the bot's own speech rather than delaying it. 64 KB is around a third of a second, enough
		// to ride out a hiccup while still far too small to let stale audio pile up behind a real stall.
		this.buildOutput();
		connection.subscribe(this.player);

		connection.receiver.speaking.on('start', (userId) => {
			if (!isCurrent()) return;
			if (userId === this.client.user.id) return;
			this.onSpeaking?.(userId);
			this.ensureSubscription(userId);
		});

		this.bridge = new AudioBridge({
			mixer: this.mixer,
			playback: this.playback,
			output: this.pcmStream,
			getLive: this.getLive,
			music: this.music,
			ducker: this.ducker,
			debug: this.debug,
			log: this.log,
			onFrame: this.onFrame,
			onOutputDead: () => this.renewOutput(),
		});
		this.bridge.start();
	}

	/**
	 * The stream the player reads the bot's own voice from. Built when the connection is made and built
	 * again whenever it dies, because a PassThrough that has errored or been destroyed is finished: every
	 * later write disappears and the channel hears nothing at all.
	 */
	buildOutput() {
		// A 20 ms stereo frame is 3840 bytes, so the stream's default 16 KB cushion is about 85 ms: one
		// garbage collection or one slow tick of the event loop overflows it, and an overflowing output
		// drops the bot's own speech rather than delaying it. 64 KB is around a third of a second, enough
		// to ride out a hiccup while still far too small to let stale audio pile up behind a real stall.
		const stream = new PassThrough({ highWaterMark: 64 * 1024 });
		stream.on('error', (err) => {
			this.log(t('voice.stream_error'), err.message);
			// The error is the end of this stream, so the answer is another one rather than a log line.
			if (this.pcmStream === stream) this.renewOutput();
		});
		this.pcmStream = stream;
		this.player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
		return stream;
	}

	/**
	 * Replace a dead output with a live one, at most once a second so a storm cannot spin. A renewal asked
	 * for inside that second is put off to its end, not dropped. The player tears its input down after
	 * 100 ms without a packet, so a second death can follow the first well inside the second; its renewal
	 * used to be thrown away, the dead stream raises its one 'error' and is silent from then on, and the
	 * bot said nothing until the next voice reconnect. The bridge also asks on every tick it finds the
	 * output dead, which is what the timer here answers.
	 */
	renewOutput() {
		if (!this.connection || !this.player) return;
		// While the connection is down the bridge is stopped and nothing is written, so a new output would
		// starve and be torn down 100 ms later, once a second for as long as the outage lasted. Coming back
		// to Ready renews a dead output (see setupRuntime), and the bridge asks again once it runs.
		if (!this.connected) return;
		const now = Date.now();
		const wait = RENEW_INTERVAL_MS - (now - this.lastRenewAt);
		if (wait > 0) {
			this.renewTimer ??= setTimeout(() => {
				this.renewTimer = null;
				this.renewOutput();
			}, wait);
			return;
		}
		if (this.renewTimer) clearTimeout(this.renewTimer);
		this.renewTimer = null;
		this.lastRenewAt = now;
		const old = this.pcmStream;
		this.buildOutput();
		this.bridge?.setOutput(this.pcmStream);
		this.connection.subscribe(this.player);
		if (old && !old.destroyed) {
			try {
				old.destroy();
			} catch {
				/* ignore */
			}
		}
		this.log(t('voice.output_renewed'));
	}

	ensureSubscription(userId) {
		if (this.subscriptions.has(userId)) return;
		if (this.soloUserId && userId !== this.soloUserId) return;
		if (!this.connection) return;

		const opusStream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
		// Decoded straight to what the model takes, 24 kHz mono: the codec synthesises nothing above the
		// new Nyquist, so there is nothing to alias and no resampler to get wrong, and a stereo stream is
		// folded to one channel inside the decoder. Half the work of decoding at 48 kHz and filtering.
		const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: SAMPLES_PER_FRAME_24K });
		// A frame that never arrived: the decoder's own packet loss concealment, from what it heard last.
		// `encoder` is prism's name for the codec object it decodes with too (private, but the only way to
		// reach it); it is null once the stream is destroyed, and then there is nothing to conceal with.
		const concealment = new Concealment((packet) => decoder.encoder?.decode(packet));
		decoder.on('data', (pcm) => {
			concealment.reset();
			const mono = int16From(pcm);
			this.mixer.push(userId, mono);
			this.onUserPcm?.(userId, mono);
		});
		this.mixer.setConcealer?.(userId, () => concealment.next());
		let failed = false;
		const fail = (label, err) => {
			if (failed) return;
			failed = true;
			this.log(`${label} (${userId}):`, err.message);
			try {
				opusStream.destroy();
			} catch {
				/* ignore */
			}
		};
		opusStream.on('error', (err) => fail(t('voice.receive_error'), err));
		// A corrupt packet (e.g. after a DAVE transition) can lock the decoder up; drop the subscription so
		// that the next time the user speaks we resubscribe with a fresh decoder.
		decoder.on('error', (err) => fail(t('voice.opus_decode_error'), err));
		opusStream.pipe(decoder);

		let done = false;
		const cleanup = () => {
			if (done) return;
			done = true;
			this.subscriptions.delete(userId);
			this.mixer.removeUser(userId);
			try {
				decoder.destroy();
			} catch {
				/* ignore */
			}
		};
		opusStream.once('close', cleanup);
		opusStream.once('end', cleanup);

		this.subscriptions.set(userId, { opusStream, decoder });
	}

	/** The user left the channel: drop their subscription and buffer so nothing leaks. */
	dropUser(userId) {
		const sub = this.subscriptions.get(userId);
		if (!sub) return;
		try {
			sub.opusStream.destroy();
		} catch {
			/* ignore */
		}
	}

	leave() {
		this.bridge?.stop();
		this.bridge = null;
		if (this.renewTimer) clearTimeout(this.renewTimer);
		this.renewTimer = null;
		for (const [userId, sub] of this.subscriptions) {
			try {
				sub.opusStream.destroy();
			} catch {
				/* ignore */
			}
			this.mixer.removeUser(userId);
		}
		this.subscriptions.clear();
		// Do not let stale model audio play on the next join.
		this.playback?.clear?.();

		try {
			this.player?.stop();
		} catch {
			/* ignore */
		}
		this.player = null;

		try {
			this.pcmStream?.end();
		} catch {
			/* ignore */
		}
		this.pcmStream = null;

		const connection = this.connection;
		this.connection = null;
		if (connection) {
			try {
				connection.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	/** While leaving, waits for the "I left" notice to reach the gateway. */
	async destroy() {
		const connection = this.connection;
		this.leave();
		if (connection) await waitForState(connection, VoiceConnectionStatus.Destroyed, 2000).catch(() => {});
	}
}
