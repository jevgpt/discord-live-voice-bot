// The Jev reply gate: was the line just spoken for the bot? Asked as early as the audio allows
// (onUserSpeechEnd, judgeEarly) and again on the closed line (judgeLine); the bot's audio is held while
// the answer is out, a reply to a line that was not for the bot is kept off the channel, and the room
// is left to itself for a while after one (the aside). deliverAssistantAudio is the last step every
// chunk of the model's audio passes before the channel. The local brain's version of the same
// question (localLineForBot) is here as well.
//
// Writes: earlyJudge, closedLineToJudge, speakingNow, replyHold, suppress, lastSuppressedAt, asideUntil.
// Shared: earlyJudgeTimer is the gate's, but onTranscript (transcript.js) re-arms it on every user
// delta and stop() clears it.
// Reads only: jev, cfg, live, localMode (localvoice.js), silenced (settings.js), health, trace,
// transcriptBuffers, recentUserText and lastHeardAssistantLine (transcript.js), lastAssistantSpokeAt
// (livelink.js, localvoice.js). Drives playback (push, clear).

import { runText } from '../runs.js';
import { t } from '../i18n/index.js';
import { normalize, safeContext } from '../text.js';
import {
	ASIDE_MS,
	JEV_ADDRESSED_P,
	JEV_BANTER_P,
	JEV_GROWTH_CHARS,
	JEV_MIN_CHARS,
	JEV_NOT_ADDRESSED_P,
	JEV_SPEECH_END_SETTLE_MS,
	REPLY_HOLD_MAX_MS,
	REPLY_SUPPRESS_MS,
	SILENCE_GAP_MS,
} from './constants.js';

export const replyGateMethods = {
	/**
	 * Ask Jev what a finished line IS, and tell the model only when the answer changes how it should
	 * treat the line. Non-blocking: the line has already gone to the model under its speaker's name; a
	 * second short context line follows when Jev says it was banter, or was not said to the bot at all.
	 * A slow or dead Jev therefore costs nothing but the verdict.
	 */
	judgeLine(item) {
		if (!this.jev?.enabled || !item.id || item.line.length < JEV_MIN_CHARS) return;
		const early = this.earlyJudge;
		const sameLine = early && item.line.startsWith(early.text.slice(0, Math.min(12, early.text.length)));
		const grown = !early || item.line.length - early.text.length >= JEV_GROWTH_CHARS;
		if (sameLine && early.pending) {
			// The answer about a shorter version is still on its way; the closed line gets the final word
			// once it has arrived (see judgeEarly's callback).
			early.flushed = true;
			if (grown) this.closedLineToJudge = { text: item.line, id: item.id };
			return;
		}
		if (sameLine && (early.byName || !grown)) {
			// Already judged as it stands: nothing new to ask, and nothing left to wait for.
			this.earlyJudge = null;
			this.releaseReplyHold();
			return;
		}
		this.earlyJudge = null;
		this.judgeClosedLine({ text: item.line, id: item.id });
	},

	/** The final word on a line: judged whole, and whatever the answer, the hold does not outlive it. */
	judgeClosedLine({ text, id }) {
		const askedAt = Date.now();
		void this.jev
			.judge(this.judgeInput(text, id))
			.then((hit) => this.applyVerdict(hit, { text, id, ms: Date.now() - askedAt, final: true }))
			.catch(() => this.releaseReplyHold());
	},

	/** Who the mixer says is speaking, frame by frame: the moment somebody stops is when the reply gate has to act. */
	noteSpeechEnd(frame) {
		const now = (frame?.active ?? []).map(String);
		for (const id of this.speakingNow) if (!now.includes(id)) this.onUserSpeechEnd(id);
		this.speakingNow = now;
	},

	/**
	 * Somebody just stopped talking, and the model answers within about a second of that. The audio says
	 * so long before the transcript does, so this is where the reply is held -- before it can start --
	 * and where the first question is asked, from whatever the transcript has delivered; the verdict
	 * improves as the rest of the line arrives (judgeEarly asks again when the line grows).
	 */
	onUserSpeechEnd() {
		if (!this.jev?.enabled || !this.live?.ready || this.localMode || !this.cfg.jevReplyGate) return;
		this.suppress = null; // a new turn is judged anew; the hold protects it until then
		this.holdReply();
		if (this.earlyJudgeTimer) clearTimeout(this.earlyJudgeTimer);
		this.earlyJudgeTimer = setTimeout(() => this.judgeEarly(), JEV_SPEECH_END_SETTLE_MS);
	},

	/**
	 * Judge the line being spoken: first as soon as the speaker stops (or the pieces pause), then again
	 * whenever it has grown by a word, because one word of a line says little about who it was for. A
	 * line that names the bot never waits. The bot's audio is held meanwhile (see holdReply), and the
	 * verdict decides whether the reply reaches the channel.
	 */
	judgeEarly() {
		this.earlyJudgeTimer = null;
		if (!this.jev?.enabled || !this.live?.ready || this.localMode) return;
		const buf = this.transcriptBuffers.get('user');
		if (!buf?.parts.length) return;
		const text = runText({ parts: buf.parts });
		const named = buf.parts.filter((part) => part.id);
		const id = named.length ? named[named.length - 1].id : null;
		if (!id || text.length < JEV_MIN_CHARS) return;
		const early = this.earlyJudge;
		if (early && early.pending) return; // one question at a time; its answer decides whether to ask again
		if (early && !early.flushed && text.startsWith(early.text) && (early.byName || text.length - early.text.length < JEV_GROWTH_CHARS)) return;
		const tokens = normalize(text).split(' ').filter(Boolean);
		if (tokens.some((token) => this.wakeWordSet().has(token))) {
			this.earlyJudge = { text, id, pending: false, flushed: false, byName: true, verdict: { addressed: 1, byName: true } };
			this.leaveAside();
			this.releaseReplyHold();
			return;
		}
		const judge = { text, id, pending: true, flushed: false, byName: false, verdict: null };
		this.earlyJudge = judge;
		this.holdReply();
		const askedAt = Date.now();
		void this.jev
			.judge(this.judgeInput(text, id))
			.then((hit) => {
				judge.pending = false;
				judge.verdict = hit;
				if (this.earlyJudge !== judge) {
					this.releaseReplyHold();
					return;
				}
				this.applyVerdict(hit, { text, id, ms: Date.now() - askedAt });
				// The line went on while the question was out: ask about the fuller line -- the closed one
				// when it closed meanwhile, otherwise what the transcript has delivered since.
				const closed = this.closedLineToJudge;
				if (closed) {
					this.closedLineToJudge = null;
					this.earlyJudge = null;
					this.judgeClosedLine(closed);
					return;
				}
				const now = this.transcriptBuffers.get('user');
				const grown = now?.parts.length ? runText({ parts: now.parts }) : '';
				if (!judge.flushed && grown.length - text.length >= JEV_GROWTH_CHARS) this.judgeEarly();
			})
			.catch(() => this.releaseReplyHold());
	},

	/** What Jev is told about a line: the words, who said them, who is in the room, what the bot last said. */
	judgeInput(text, id) {
		return {
			line: text,
			speaker: this.speakerLabel(id),
			botName: this.persona().name ?? 'bot',
			ownerSpeaking: this.isOwnerId(id),
			recent: this.recentUserText,
			people: this.rosterNames().map((entry) => (entry.owner ? `${entry.name} (owner)` : entry.name)),
			assistantLastLine: this.lastHeardAssistantLine,
		};
	},

	/**
	 * What the verdict does. Not for the bot: the held audio is dropped, the reply that follows is kept
	 * off the channel until it ends, and the model is told its answer was not played. Banter: the model
	 * is told so. Anything else: the held audio goes out as if nothing had happened.
	 */
	applyVerdict(hit, { text, id, ms = null, final = false }) {
		// In an aside a doubt is a no: the room is talking among themselves, and the bot speaks only on a
		// clear invitation. Outside one, a doubt on a line still being spoken waits for more of the line.
		const aside = Date.now() < this.asideUntil;
		const said = Boolean(hit);
		const notForBot = said && (hit.addressed <= JEV_NOT_ADDRESSED_P || (aside && hit.addressed < JEV_ADDRESSED_P));
		const banter = said && hit.kind === 'banter' && hit.kindP >= JEV_BANTER_P;
		if (said && hit.addressed <= JEV_NOT_ADDRESSED_P) this.enterAside();
		if (said && hit.addressed >= JEV_ADDRESSED_P) this.leaveAside();
		this.health.jevVerdict(hit, ms, { notForBot, banter });
		this.trace?.jev({ text, id, ms, hit, notForBot, banter });
		if (!hit) {
			// No answer. On a line still being spoken the next question may bring one; on a closed line
			// there is nothing more to wait for.
			if (final) this.releaseReplyHold();
			return;
		}
		const who = this.speakerLabel(id);
		if (this.cfg.debug) {
			this.log(
				t('runtime.log_jev', {
					who,
					kind: hit.kind,
					kindP: Math.round(hit.kindP * 100),
					addressed: Math.round(hit.addressed * 100),
					line: text.slice(0, 40),
				}),
			);
		}
		const clipped = safeContext(text).slice(0, 120);
		if (notForBot) {
			this.dropReplyHold();
			if (this.cfg.jevReplyGate) {
				// A reply already under way is cut at its next pause; one that has not started yet is dropped
				// when it starts, if it starts within the window.
				const now = Date.now();
				const inProgress = now - this.lastAssistantSpokeAt <= SILENCE_GAP_MS;
				this.suppress = { until: now + REPLY_SUPPRESS_MS, started: inProgress, lastLoud: this.lastAssistantSpokeAt, line: text };
				if (inProgress) {
					// The model sends audio faster than it plays: seconds of the reply may already be queued,
					// and a reply kept off the channel is kept off whole, not from this frame on.
					this.lastSuppressedAt = now;
					this.playback.clear();
				}
				this.health.jevSuppressed();
			}
			this.log(t('runtime.log_reply_suppressed', { addressed: Math.round(hit.addressed * 100), line: text.slice(0, 40) }));
			if (this.live?.ready) this.live.appendContext('thinking', t('runtime.jev_not_addressed', { line: clipped }));
			return;
		}
		// Clearly for the bot, or the closed line: the reply goes out. Unclear on a line still being spoken:
		// keep holding, a fuller line or the timeout decides. A fuller line saying "for the bot" also calls
		// off a suppression that a shorter one started, as long as nothing has been dropped yet.
		const clearlyForBot = hit.addressed >= JEV_ADDRESSED_P;
		if (clearlyForBot || final) this.releaseReplyHold();
		if (clearlyForBot && this.suppress && !this.suppress.started) this.suppress = null;
		if (banter && this.live?.ready) {
			this.live.appendContext('thinking', t('runtime.jev_banter', { line: clipped }));
		}
	},

	/** Hold the bot's audio back while Jev answers -- only when no reply is playing yet; otherwise it is too late to hold. */
	holdReply() {
		if (!this.cfg.jevReplyGate || this.localMode) return;
		if (Date.now() - this.lastAssistantSpokeAt <= SILENCE_GAP_MS) return;
		if (this.replyHold) return; // already holding: the timeout runs from the stop, not from the latest question
		this.replyHold = { samples: [], since: Date.now(), timer: setTimeout(() => this.releaseReplyHold(), REPLY_HOLD_MAX_MS) };
	},

	/** Let the held audio out, in order. */
	releaseReplyHold() {
		const hold = this.replyHold;
		if (!hold) return;
		clearTimeout(hold.timer);
		this.replyHold = null;
		if (this.silenced) return;
		for (const samples of hold.samples) this.playback.push(samples);
	},

	/** Throw the held audio away. */
	dropReplyHold() {
		const hold = this.replyHold;
		if (!hold) return;
		clearTimeout(hold.timer);
		this.replyHold = null;
	},

	/**
	 * The last step before the channel. Silenced by the owner: nothing goes out. Kept off by the reply
	 * gate: nothing goes out until that reply ends. Held: kept until the verdict. Otherwise: play.
	 */
	deliverAssistantAudio(samples, loud) {
		if (this.silenced) return;
		if (this.suppress && this.suppressing(loud)) return;
		if (this.replyHold) {
			this.replyHold.samples.push(samples);
			return;
		}
		this.playback.push(samples);
	},

	/** Is this chunk part of the reply being kept off the channel? Ends at the reply's next pause, or when no reply came. */
	suppressing(loud) {
		const now = Date.now();
		const state = this.suppress;
		if (now > state.until) {
			this.suppress = null;
			return false;
		}
		if (!state.started) {
			if (loud) {
				state.started = true;
				state.lastLoud = now;
				this.lastSuppressedAt = now;
				this.playback.clear();
			}
			return true;
		}
		if (loud) {
			state.lastLoud = now;
			return true;
		}
		// That reply has ended. The window has not: a second reply to the same line is kept off as well.
		if (now - state.lastLoud > SILENCE_GAP_MS) state.started = false;
		return true;
	},

	/** The room is talking among themselves: from here the bot speaks only on a clear invitation. */
	enterAside() {
		const was = Date.now() < this.asideUntil;
		this.asideUntil = Date.now() + ASIDE_MS;
		if (!was) this.log(t('runtime.log_aside_on'));
	},

	/** Somebody spoke to the bot, clearly or by name: the aside is over. */
	leaveAside() {
		if (Date.now() < this.asideUntil) this.log(t('runtime.log_aside_off'));
		this.asideUntil = 0;
	},

	/**
	 * Local brain: was this line for the bot at all? The local path has no model listening to decide
	 * for itself, so with Jev the question is put directly, and people talking among themselves get no
	 * reply. A line that names the bot is always for it; without Jev everything is, as before.
	 */
	async localLineForBot(line, userId) {
		if (!this.jev?.enabled || this.cfg.localBrainRespond !== 'auto') return true;
		const tokens = normalize(line).split(' ').filter(Boolean);
		if (tokens.some((token) => this.wakeWordSet().has(token))) return true;
		const askedAt = Date.now();
		const hit = await this.jev.judge(this.judgeInput(line, userId));
		this.health.jevVerdict(hit, Date.now() - askedAt, { notForBot: Boolean(hit) && hit.addressed <= JEV_NOT_ADDRESSED_P, banter: false });
		if (!hit) return true;
		if (this.cfg.debug) {
			this.log(
				t('runtime.log_jev', {
					who: this.speakerLabel(userId),
					kind: hit.kind,
					kindP: Math.round(hit.kindP * 100),
					addressed: Math.round(hit.addressed * 100),
					line: line.slice(0, 40),
				}),
			);
		}
		if (hit.addressed > JEV_NOT_ADDRESSED_P) return true;
		this.log(t('runtime.log_local_not_addressed', { addressed: Math.round(hit.addressed * 100), line: line.slice(0, 40) }));
		return false;
	},
};
