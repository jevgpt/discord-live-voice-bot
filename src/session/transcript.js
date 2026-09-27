// The transcript pipeline: realtime deltas in, finished lines out. A delta is placed on the audio track
// once (onTranscript), buffered per speaker and cut into one line per stretch of one voice
// (flushTranscript, resolveLine). Each line is recorded, told to the model under its speaker's name
// (announceLine), handed to the reply gate (judgeLine, replygate.js) and may run a voice command
// (runVoiceCommand). The bot's own lines are recorded here too, and the wake nudge answers a name the
// model did not.
//
// Writes: transcriptBuffers and the buffers in it, lastUserDeltaAt, noAudioSaid, lastWakeNudgeAt,
// lastHeardAssistantLine, and -- created on first use, not in the constructor -- lastSpokenLine,
// windowDeltas, windowStraddles, windowShapeSaid.
// Shared: recentUserText and recentUserTextAt are written here and by onLocalSegment (localvoice.js).
// lastAnnouncedUser is set here by announceLine and by announceSpeaker (speakers.js), and reset by the
// 'ready' handler (livelink.js) and onVoiceStateUpdate. transcriptBuffers is flushed and cleared by
// the 'ready' handler and by stop() as well. earlyJudgeTimer belongs to the reply gate
// (replygate.js), but it is re-armed here on every user delta.
// Reads only: cfg, attribution, health, latency, trace, live, store, taskDeps, guild, localMode
// (localvoice.js), lastAssistantSpokeAt (livelink.js, localvoice.js), lastSuppressedAt (replygate.js).

import { executeAction } from '../agent.js';
import { buildRuns, canEndAfter, runCandidates, runEnd, runSpan, runText } from '../runs.js';
import { parseVoiceCommand } from '../commands.js';
import { speakerPath } from '../speakerpath.js';
import { t } from '../i18n/index.js';
import { normalize, safeContext, stripSpokenPrefix } from '../text.js';
import {
	HARMLESS_VOICE_ACTIONS,
	JEV_SETTLE_MS,
	LINE_HARD_MAX_MS,
	LINE_MAX_MS,
	NO_AUDIO_SAMPLE,
	PARTS_MAX,
	REPLY_SUPPRESS_MS,
	TRANSCRIPT_FLUSH_MS,
	WAKE_FILLER_WORDS,
	WAKE_WORDS,
	WINDOW_SHAPE_SAMPLE,
} from './constants.js';

export const transcriptMethods = {
	/**
	 * The transcript arrives late: when the gate cannot find the word it waits at most `maxMs`. It returns
	 * about 300 ms after the newest transcript chunk (once the chunks settle) or when the time is up.
	 */
	awaitTranscript(maxMs = 1500) {
		const startedAt = Date.now();
		return new Promise((resolve) => {
			const poll = () => {
				const now = Date.now();
				if (now - startedAt >= maxMs) return resolve();
				if (this.lastUserDeltaAt > startedAt && now - this.lastUserDeltaAt >= 300) return resolve();
				setTimeout(poll, 100);
			};
			setTimeout(poll, 100);
		});
	},

	onTranscript({ speaker, text, startMs, endMs }) {
		const cfg = this.cfg;
		// The transcript's clock is not ours (see SpeakerAttribution.observeTranscript): its positions run
		// ahead of the audio we have sent, by more every minute, until a fragment lands where the track has
		// no audio at all and every line is nobody's. The offset is measured from the fragments themselves
		// and taken off before anything is looked up.
		let drift = 0;
		let rawStart = null;
		let rawEnd = null;
		if (speaker === 'user') {
			rawStart = startMs;
			rawEnd = endMs;
			drift = this.attribution.observeTranscript(endMs);
			startMs = this.attribution.mapTranscriptMs(startMs);
			endMs = this.attribution.mapTranscriptMs(endMs);
		}
		let buf = this.transcriptBuffers.get(speaker);
		if (!buf) {
			buf = { parts: [], timer: null, startedAt: 0, lastEnd: null };
			this.transcriptBuffers.set(speaker, buf);
		}
		// The realtime API reports the stretch an utterance has reached, not the stretch THIS fragment
		// covers: the second fragment of a sentence comes back spanning the first one as well. Read
		// literally, every fragment after the first one carries the previous speaker's audio inside its
		// own window, which in a room with three people means every line but the first reads as "two
		// voices at once" -- measured live, four times out of four. So a fragment is judged on the audio
		// that is NEW since the last one. When the API does send a per-fragment window this changes
		// nothing, because the window already starts where the last one ended.
		let from = startMs;
		const straddles = Number.isFinite(buf.lastEnd) && Number.isFinite(from) && Number.isFinite(endMs) && from < buf.lastEnd && endMs > buf.lastEnd;
		// A fragment that has got no further than the last one brings no audio of its own: two pieces the far
		// end sent from the same point of the stream ("şarkı" then "yı"), or one reported a little behind.
		// Its window used to fall back to the whole utterance so far, so it was judged on everything said
		// since the utterance began. Caught by the benchmark (bench/, the overlap rooms): a guest's "ban"
		// sent that way, in an utterance the owner had held alone for four fifths of, came back as the
		// owner's word and opened the gate. It is named from the stretch the last fragment covered, which is
		// the audio the far end had just heard when it sent both; its own end stays where it was reported.
		// That stretch alone decides nobody's authority, though. The same rule the other way round: guest,
		// owner, guest in quick turns, and the far end reporting the guest's last word at the end of the
		// owner's (it only ever moves the end forward) put a guest's "ban" on the owner's stretch, and the
		// gate opened on it. So the owner's authority needs the owner alone under both, the last stretch and
		// the fragment's own window, and nobody else anywhere in the stretch (reportedMs in noteTranscript).
		// On the bench's reverse-repeat rooms that closed 4 guest commands in 192 and cost the owner 6 in 64:
		// the owner's own word, sent that way straight after a guest's, is no longer the owner's, the command
		// before it is refused as interrupted, and the owner has to ask again.
		const repeats =
			!straddles && Number.isFinite(buf.lastEnd) && Number.isFinite(buf.lastFrom) && Number.isFinite(from) && Number.isFinite(endMs) && from < buf.lastEnd && endMs <= buf.lastEnd;
		let judgedEnd = endMs;
		if (straddles) from = buf.lastEnd;
		if (repeats) {
			from = buf.lastFrom;
			judgedEnd = buf.lastEnd;
		} else if (Number.isFinite(from)) {
			buf.lastFrom = from;
		}
		if (Number.isFinite(endMs) && (!Number.isFinite(buf.lastEnd) || endMs > buf.lastEnd)) buf.lastEnd = endMs;
		if (speaker === 'user') this.noteWindowShape(straddles);
		let part = { text, startMs: from, endMs, id: null, sure: false, owner: false, confidence: 'unsure', ids: [] };
		if (speaker === 'user') {
			// ONE resolution per delta, made where the audio track lives and then reused for the record, for
			// the model's context and for the run. Resolving it again downstream is how two parts of the code
			// ended up naming two different people for the same words.
			const hit = this.attribution.noteTranscript(text, { startMs: from, endMs: judgedEnd, reportedMs: repeats ? [startMs, endMs] : null });
			this.health.fragment(hit);
			this.health.driftNow(drift, this.attribution.driftRate);
			this.trace?.delta({ audio: this.attribution.audioMs, rawStart, rawEnd, start: from, end: judgedEnd, drift, text, hit });
			this.lastUserDeltaAt = Date.now();
			// The reply gate asks its question as soon as the pieces stop for a moment (see judgeEarly).
			if (this.earlyJudgeTimer) clearTimeout(this.earlyJudgeTimer);
			this.earlyJudgeTimer = setTimeout(() => this.judgeEarly(), JEV_SETTLE_MS);
			// The evidence travels with the part (reason, every candidate's share, the fragment's number), so the
			// line pass can weigh a fragment against its neighbours without looking the audio up a second time.
			if (hit) {
				part = {
					text,
					startMs: from,
					endMs,
					id: hit.id,
					sure: hit.sure,
					owner: hit.owner === true,
					confidence: hit.confidence,
					ids: hit.ids,
					reason: hit.reason,
					ranked: hit.ranked,
					seq: hit.seq,
				};
			}
			// From the audio position to the wall clock: when did the user actually stop speaking?
			const lag = Number.isFinite(endMs) ? Math.max(0, this.attribution.audioMs - endMs) : 0;
			this.latency.userSpeechEnd(Date.now() - lag);
			if (cfg.debug) {
				// What the question actually is, when somebody asks why a line was refused: which stretch of
				// audio this fragment was judged on, who the audio says was in it, and how sure that is.
				this.log(
					t('runtime.log_attribution', {
						start: Math.round(Number(startMs) || 0),
						end: Math.round(Number(endMs) || 0),
						audio: Math.round(this.attribution.audioMs),
						drift: Math.round(drift),
						who: hit?.id ? this.speakerLabel(hit.id) : '-',
						confidence: hit?.confidence ?? '-',
						reason: hit?.reason ?? '-',
						solo: hit ? Math.round(hit.solo * 100) : 0,
						ids: hit?.ids?.length ? hit.ids.map((id) => this.speakerLabel(id)).join(', ') : '-',
						text: String(text ?? '').slice(0, 30),
					}),
				);
			}
		}
		if (!buf.parts.length) buf.startedAt = Date.now();
		buf.parts.push(part);
		if (buf.timer) clearTimeout(buf.timer);
		buf.timer = null;
		// The cap is there so that a conversation that never falls silent still produces lines. It is not a
		// reason to cut a word in half: the fragments are sub-word, so closing the line on whichever one
		// happened to arrive at the eight second mark splits "banla" into "ban" and "la" -- which also
		// stops the command parser recognising either half. So it waits for a fragment that ends
		// somewhere a line can end, and gives up on waiting after a couple of seconds.
		const age = Date.now() - buf.startedAt;
		const overdue = age >= LINE_MAX_MS && (canEndAfter(part.text) || age >= LINE_HARD_MAX_MS);
		if (overdue || buf.parts.length >= PARTS_MAX) {
			this.flushTranscript(speaker);
			return;
		}
		buf.timer = setTimeout(() => this.flushTranscript(speaker), cfg.transcriptFlushMs ?? TRANSCRIPT_FLUSH_MS);
	},

	/**
	 * Says once, out loud, which shape the transcript windows arrive in.
	 *
	 * Everything about whose words a line is rests on what [start_ms, end_ms] means: the stretch THIS
	 * fragment covers, or how far the utterance has got. The handling works either way -- a fragment is
	 * judged on the audio that is new since the last one -- but which one it is was worked out from a
	 * pattern across four lines of a pasted log, and a guess that load-bearing should not stay a guess.
	 * So the bot counts and reports it: one line per session, after enough fragments to be sure.
	 */
	noteWindowShape(straddles) {
		if (this.windowShapeSaid) return;
		this.windowDeltas = (this.windowDeltas ?? 0) + 1;
		if (straddles) this.windowStraddles = (this.windowStraddles ?? 0) + 1;
		if (this.windowDeltas < WINDOW_SHAPE_SAMPLE) return;
		this.windowShapeSaid = true;
		const straddled = this.windowStraddles ?? 0;
		this.log(
			t(straddled > this.windowDeltas / 2 ? 'runtime.window_shape_cumulative' : 'runtime.window_shape_per_fragment', {
				straddled,
				total: this.windowDeltas,
			}),
		);
	},

	/**
	 * Turns the buffered deltas into finished lines: one line per stretch of one speaker, so that two
	 * people inside one flush come out as two lines with two names instead of one line carrying whoever
	 * happened to speak last. Safe to call early (a session reset) and safe to call twice.
	 */
	flushTranscript(speaker) {
		const cfg = this.cfg;
		const buf = this.transcriptBuffers.get(speaker);
		if (!buf) return;
		// Kill the timer FIRST, always: the buffer object is reused, so a flush that leaves one armed fires
		// again later on a buffer somebody else has since refilled.
		if (buf.timer) clearTimeout(buf.timer);
		buf.timer = null;
		const parts = buf.parts;
		buf.parts = [];
		buf.startedAt = 0;
		if (!parts.length) return;

		if (speaker !== 'user') {
			const line = parts
				.map((entry) => entry.text)
				.join('')
				.replace(/\s+/g, ' ')
				.trim();
			if (!line) return;
			// Some transcript streams re-send the text so far: without this, one reply is recorded twice with
			// the second copy carrying the first, which reads exactly like the bot repeating itself. Only the
			// line just before it is compared, and only while it is recent.
			const previous = this.lastSpokenLine && Date.now() - this.lastSpokenLine.at < 20_000 ? this.lastSpokenLine.text : '';
			const fresh = stripSpokenPrefix(line, previous);
			this.lastSpokenLine = { text: line, at: Date.now() };
			if (!fresh) return;
			// A reply the application kept off the channel (the line was not for the bot) is recorded as such,
			// and never becomes "what the bot last said" for the next judgment: nobody heard it.
			const suppressed = !this.localMode && this.lastSuppressedAt > 0 && Date.now() - this.lastSuppressedAt < REPLY_SUPPRESS_MS;
			if (cfg.transcripts) this.log(t(suppressed ? 'runtime.transcript_out_suppressed' : 'runtime.transcript_out', { line: fresh }));
			// Local mode: this text is turned into speech by Chatterbox and pushed to Discord.
			if (this.localMode) this.enqueueLocalSpeech(fresh);
			else this.record({ kind: 'voice', direction: 'out', whoName: this.persona().name ?? 'bot', text: fresh, meta: suppressed ? { suppressed: true } : undefined });
			if (!suppressed) this.lastHeardAssistantLine = fresh;
			this.trace?.assistant(fresh, suppressed);
			return;
		}

		// ATTRIBUTION=hmm reads the speakers of the whole flush as one path (src/speakerpath.js) before the
		// line is cut; vote keeps every fragment's own answer. Either way the gate never sees this: it reads
		// the attribution's record, which was written fragment by fragment in onTranscript.
		const path = cfg.attribution === 'hmm';
		const labelled = path ? speakerPath(parts, { ownerId: this.attribution.ownerId }) : parts;
		const lines = [];
		for (const run of buildRuns(labelled)) {
			const line = runText(run);
			if (line) lines.push({ line, ...this.resolveLine(run, { path }), endMs: runEnd(run) });
		}
		if (!lines.length) return;

		for (const item of lines) {
			if (cfg.transcripts) this.log(t('runtime.transcript_in', { line: item.line }));
			if (cfg.debug) {
				this.log(
					t('runtime.log_line_decision', {
						who: item.id ? this.speakerLabel(item.id) : '-',
						mixed: item.mixed ? t('runtime.yes') : t('runtime.no'),
						candidates: item.candidates.length ? item.candidates.map((id) => this.speakerLabel(id)).join(', ') : '-',
						line: item.line.slice(0, 40),
					}),
				);
			}
			this.record({
				kind: 'voice',
				direction: 'in',
				who: item.id,
				text: item.line,
				meta: item.id && !item.mixed ? undefined : { unclear: true, speakers: item.candidates },
			});
			this.health.line(item);
			this.trace?.line(item);
			if (cfg.announceSpeaker && this.live?.ready) this.announceLine(item);
			this.judgeLine(item);
		}
		// Once per flush, not once per line: aborting an in-flight local render twice throws the whole
		// generation away, which is the reason the barge-in guard exists at all.
		this.interruptLocalSpeech();

		const all = lines.map((item) => item.line).join(' ');
		this.recentUserText = `${this.recentUserText} ${all}`.slice(-700).trim();
		this.recentUserTextAt = Date.now();
		// Asked once over the whole flush: the bot's name from one person and the request from another is
		// still somebody calling the bot.
		this.maybeWakeByVoiceName(all);

		for (const item of lines) this.runVoiceCommand(item);
	},

	/**
	 * Whose line is it? The deltas decided where the line was CUT; who OWNS it is asked once over the
	 * whole stretch it covers.
	 *
	 * A delta is shorter than a word, and the first one of a turn lands while the previous speaker is
	 * still counted as talking. Judging the line by its worst delta therefore condemned nearly every line
	 * in a busy channel, which is how a session ended up running no voice commands at all. Over the whole
	 * stretch the same audio reads clearly: one voice holding nine tenths of it is one voice.
	 *
	 * With `path` (ATTRIBUTION=hmm) the run was cut along the speaker path, and the path's name for it is
	 * the line's name. The span the path draws can hold more of a neighbour's audio than the run's own, and
	 * named from the span it put the owner's name on lines that were not the owner's: 5 in 5,643 on the
	 * benchmark, against 3 named by the path. The audio still has its say in `mixed` -- a span that does
	 * not agree with the path is not one person's -- and in `owner`, which is the gate's own test over the
	 * span and nothing else.
	 */
	resolveLine(run, { path = false } = {}) {
		const decided = this.resolveLineByAudio(run);
		if (!path) return decided;
		const owner = this.attribution.ownerId;
		if (run.id !== null) {
			// A fragment the path gave a name its own audio did not (see speakerPath) is inference, and a line
			// holding one is told as one that may hold somebody else's words: the path is a better guess
			// than the vote at the edge of a turn, and still a guess.
			const inferred = run.parts.some((part) => part.path === 'neighbours');
			return { ...decided, id: run.id, mixed: decided.mixed || inferred || decided.id !== run.id, owner: decided.owner && run.id === owner };
		}
		// The path found nobody here. The span may still name a guest, as it would without the path; it may
		// not name the owner, because the owner's name on a line comes from the path or not at all.
		if (owner !== null && decided.id === owner) return { ...decided, id: null, mixed: true, owner: false };
		return decided;
	},

	/** The line's owner as the audio under its whole span says it (see resolveLine). */
	resolveLineByAudio(run) {
		const span = runSpan(run);
		const hit = span ? this.attribution.resolveSpeaker(span[0], span[1]) : null;
		// Still happening in the field and I will not guess at it a third time. When a line turns out to
		// have no audio under it at all, say where it was looking and where the audio actually is: the
		// distance between those two numbers is the answer, and one session's worth of them settles it.
		if (span && hit && !hit.id && !hit.ids.length && this.noAudioSaid < NO_AUDIO_SAMPLE) {
			this.noAudioSaid++;
			const track = this.attribution.track;
			const lastEnd = track.length ? track[track.length - 1].endMs : null;
			this.log(
				t('runtime.log_no_audio_detail', {
					from: Math.round(span[0]),
					to: Math.round(span[1]),
					audio: Math.round(this.attribution.audioMs),
					lastEnd: lastEnd === null ? '-' : Math.round(lastEnd),
				}),
			);
		}
		// Whether the line is the owner's by the gate's own test (the owner alone for most of it), which is
		// a stricter question than whose name it carries; runVoiceCommand asks it before acting as the owner.
		const spoken = run.parts.filter((part) => String(part.text ?? '').trim());
		const ownerAlone = span ? this.attribution.speakerAt(span[0], span[1]) === true : spoken.length > 0 && spoken.every((part) => part.owner === true);
		// No position on any part (or nothing in the track for it): fall back on what the deltas said.
		if (!hit || (hit.heardMs <= 0 && !hit.id)) return { id: run.id, mixed: run.mixed, owner: ownerAlone, candidates: runCandidates(run) };
		const candidates = hit.ids.length ? hit.ids : runCandidates(run);
		return {
			id: hit.id ?? null,
			// A run that swallowed somebody else's words stays mixed however clean the audio looks: the
			// text really does hold two people.
			mixed: run.mixed || hit.confidence !== 'sure',
			owner: ownerAlone,
			candidates,
		};
	},

	/**
	 * The turn a line's command acts under: the line's OWN last audio position.
	 *
	 * Reusing the whole flush's final position would let a LATER speaker's audio count as "before the
	 * turn" for an EARLIER line's command, which is the widest possible window and exactly the hole the
	 * gate exists to close. A position the API reports out of order can only make this earlier, which is
	 * the strict direction.
	 */
	lineTurn(item) {
		return { at: Date.now(), audioMs: Number.isFinite(item.endMs) ? item.endMs : this.attribution.audioMs };
	},

	/**
	 * A finished line may run a voice command. How clean the line has to be depends on what the command
	 * would do.
	 *
	 * This path bypasses the model, so for a tool with no gate there is no second check anywhere, and on a
	 * mixed line one person's word can finish another's sentence. But refusing every mixed line took the
	 * music controls away from a lively channel entirely: "skip the queue", asked four times in a row, was
	 * answered four times and never done. The worst case of a mixed "skip" is the wrong song, so the rule
	 * follows the consequence rather than treating every command as if it were a ban.
	 */
	runVoiceCommand(item) {
		const refuse = () => {
			if (this.cfg.transcripts && item.line) this.log(t('runtime.log_command_unclear', { line: item.line.slice(0, 40) }));
		};
		if (!item.id) return refuse();
		const command = parseVoiceCommand(item.line, this.store.list(), this.channelLists());
		if (!command) return;
		// Quiet is the one state-changing command allowed off a mixed line: the tool behind it is
		// owner-gated (who said the word, and whether anybody spoke over it), which is exactly the second
		// check this shortcut lacks and the reason the mixed rule exists. Both live "sus" lines were
		// flagged mixed, so refusing them here left the deterministic route permanently unused.
		if (item.mixed && command.type !== 'quiet' && !HARMLESS_VOICE_ACTIONS.has(command.type)) return refuse();
		const lineTurn = this.lineTurn(item);
		// The line's own speaker, rather than whoever Discord last reported as speaking: the music queue,
		// the memory notes and "move me" all act under this identity. A mixed line runs its harmless command
		// for nobody in particular, though: "read the staff channel" is harmless only as far as the person
		// asking may read it, and on a line two voices share, whose request it was is exactly what is not
		// known. The owner's name goes only on a line that was the owner's alone (see speakerOfTurn).
		const speakerId = item.mixed || (this.isOwnerId(item.id) && item.owner !== true) ? null : String(item.id);
		void executeAction(command, {
			...this.taskDeps,
			currentTurn: () => lineTurn,
			currentSpeakerId: () => speakerId,
			currentSpeakerName: () => (speakerId ? this.nameFor(speakerId) : null),
			currentSpeakerChannel: () => (speakerId ? (this.guild?.voiceStates.cache.get(speakerId)?.channel ?? null) : null),
		})
			.then((result) => {
				if (result?.speak && result.text && !result.reused) this.say(result.text);
			})
			.catch((err) => this.log(t('runtime.command_error', { error: err.message })));
	},

	/** Tells the model whose words a finished line carries, or that it cannot be told. */
	announceLine({ line, id, mixed, candidates }) {
		const clipped = safeContext(line).slice(0, 200);
		if (!id) {
			// Two different things end up here and they were being reported as the same one. Candidates
			// means two voices really did run into each other. No candidates means there was no audio under
			// these words at all, which is a different sentence to say and a different thing to fix.
			if (!candidates.length) {
				this.live.appendContext('thinking', t('runtime.speaker_line_unknown', { line: clipped }));
				if (this.cfg.transcripts) this.log(t('runtime.log_context_unknown', { line: line.slice(0, 40) }));
				return;
			}
			const names = candidates.map((candidate) => safeContext(this.speakerLabel(candidate))).join(t('runtime.name_join'));
			this.live.appendContext('thinking', t('runtime.speaker_line_overlap', { names, line: clipped }));
			// Naming them in the log too: "two voices at once" on its own says nothing about whether the
			// judgement was right, and this log is the only evidence there is after the fact.
			if (this.cfg.transcripts) this.log(t('runtime.log_context_overlap', { names, line: line.slice(0, 40) }));
			return; // lastAnnouncedUser is deliberately NOT touched: the model was told no name
		}
		const name = safeContext(this.speakerLabel(id));
		const contradicts = this.lastAnnouncedUser && String(id) !== String(this.lastAnnouncedUser);
		this.lastAnnouncedUser = String(id);
		const owner = this.isOwnerId(id) ? t('runtime.owner_suffix') : '';
		// "thinking", not "instructions": this carries somebody's words, and words spoken in the channel
		// must never arrive on the channel the model treats as hard instruction.
		//
		// A mixed line is mostly this person's and holds a piece of somebody else's. It is not honest to
		// hand it over under one name with no caveat -- the model answers these lines, and it cannot see
		// what we know about them. The application already refuses to run a command off one; the model is
		// told the same thing in words so that it can be careful with the part that may not be theirs.
		this.live.appendContext(
			'thinking',
			mixed ? t('runtime.speaker_line_mixed', { name, owner, line: clipped }) : t('runtime.speaker_line', { name, owner, line: clipped }),
		);
		if (this.cfg.transcripts && contradicts) this.log(t('runtime.log_context_correction', { line: line.slice(0, 40), name }));
	},

	/** When the bot is called by name in the channel and the model stayed silent, tells it to answer. */
	maybeWakeByVoiceName(line) {
		if (!this.live?.ready) return;
		const now = Date.now();
		if (now - this.lastAssistantSpokeAt < 5000) return; // the model already spoke, or is speaking
		if (now - this.lastWakeNudgeAt < 15_000) return; // do not nudge too often
		const wakeWords = this.wakeWordSet();
		const tokens = normalize(line).split(' ').filter(Boolean);
		if (!tokens.some((token) => wakeWords.has(token))) return;
		this.lastWakeNudgeAt = now;
		// "Aria?" -> a short answer; "ban Dana, Aria" -> there is a real request, so do not fob it off.
		const rest = tokens.filter((token) => !wakeWords.has(token) && !WAKE_FILLER_WORDS.includes(token));
		if (rest.length <= 1) {
			this.log(t('runtime.log_wake_name_only'));
			this.live.appendContext('instructions', t('runtime.wake_nudge'));
			return;
		}
		this.log(t('runtime.log_wake_request'));
		// The request itself is somebody's speech: it goes on "thinking" so it cannot act as an instruction.
		this.live.appendContext('thinking', t('runtime.wake_nudge_request', { line: safeContext(line).slice(0, 200) }));
	},

	/** The words that mean "you": the active character's name and the generic ones. */
	wakeWordSet() {
		const active = this.store.getActive();
		return new Set([active?.name, ...WAKE_WORDS].filter(Boolean).map((word) => normalize(word)).filter(Boolean));
	},
};
