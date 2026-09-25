// The session's tuning constants: the timings, thresholds and limits that src/guildsession.js and the
// method groups beside it in src/session/ are tuned with, each with the comment that says why it is
// the number it is. They lived at the top of guildsession.js. Nothing here holds state.

import { tList, tRaw } from '../i18n/index.js';

// Retry schedule (ms) for rejoining after the voice connection drops; the rest are skipped once one works.
export const RECOVERY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

// If the model left the channel on its own (it was thrown out), it tries to come back after these delays.
export const REJOIN_DELAYS_MS = [60_000, 180_000];

// Latency measurement: in a full-duplex stream audio keeps arriving, so only replies that start after
// a silence are measured; very short delays are not written out so they do not clutter the log.
export const SILENCE_GAP_MS = 600;
// After a character switch the new session introduces itself in one line. If somebody has just spoken
// to the bot, that introduction is a second answer to the same moment, so it is skipped instead.
export const INTRO_QUIET_MS = 6000;
export const MIN_LOGGED_MS = 300;
// Peak the model's audio has to reach before it counts as "audible" (int16; about -44 dBFS).
export const AUDIO_PEAK_MIN = 200;
// Local TTS: speak the tail that never got its punctuation anyway, after this much silence.
export const TTS_FLUSH_MS = 1500;
// A sentence that took longer to generate than it lasts is worth a line in the log.
export const TTS_SLOW_MS = 1500;
// The brain is asked for one short sentence, so waiting for the full stop means waiting for the whole
// reply: streaming buys nothing on its own. The FIRST piece of a turn is therefore cut early, at a comma
// or failing that at a word, once there is enough of it to be worth saying. Only the first: everything
// after it is generated while the previous piece plays, so there is nothing to gain and prosody to lose.
export const FIRST_CHUNK_CHARS = 40;
// Retrying every few seconds is pointless for permanent errors (credit, key): this interval is used instead.
export const FATAL_RETRY_MS = 10 * 60_000;

// Barge-in with the local brain: only while the bot is REALLY speaking (audio is playing) and the user
// has been talking for about 0.8 s without a break. Nothing is cancelled while generation is still under
// way (no audio yet); otherwise a 15 s Chatterbox render is thrown away on every interruption and the
// bot never gets to speak at all.
export const BARGE_IN_MS = 1200;

// Delegation id -> that turn's audio/clock marker. When a tool call arrives the gate looks at the moment the
// request was born; voices cutting in while the backend runs do not change it. Kept small (a few turns is enough).
export const TURN_MEMORY = 8;

// Who owns the audio that is REALLY sent to the model: with owner priority the owner, otherwise the loudest
// person in the mix. This is used instead of Discord's "started speaking" event; short noises cutting in do
// not steal the announcement.
export const SPEAKER_STABLE_FRAMES = 8; // stable for 160 ms
export const SPEAKER_GAP_FRAMES = 15;
// A line is finished this long after the last delta.
export const TRANSCRIPT_FLUSH_MS = 1200;
// Two people trading turns kept restarting that timer, so one "line" could run as long as the
// conversation did. The runs sort the names out; this stops everything downstream -- the record, the
// model's context, a spoken command -- waiting for the room to fall silent first. 8 s sits inside the
// gate's 15 s transcript window.
export const LINE_MAX_MS = 8000;
// Past the cap the line waits for a word to finish before it is closed; this is where it stops waiting.
// A word is not worth more than a couple of seconds of delay.
export const LINE_HARD_MAX_MS = 12_000;
export const PARTS_MAX = 2000; // insurance against a pathological delta rate; bounds the buffer's memory
// How many transcript fragments to watch before saying which shape their time windows arrive in.
export const WINDOW_SHAPE_SAMPLE = 24;
// Voice commands that change nothing outside the bot's own playback or ask it a question. These may run
// off a line that is only MOSTLY one person's, because the worst case is the wrong song. Everything else
// -- posting a message, changing the persona, the privacy setting, moving the bot between channels --
// needs a line that is provably one person's, because the worst case there is somebody else's words
// acting under a name that is not theirs.
export const HARMLESS_VOICE_ACTIONS = new Set(['music', 'read', 'status', 'help', 'panel', 'summary']);
// How many times a session will spell out a line that had no audio under it. Enough to see the pattern,
// few enough not to become the log.
export const NO_AUDIO_SAMPLE = 6;
// Jev thresholds. Banter needs a clear majority before the model is told to take it as a joke: a wrong
// "that was a joke" on a real request is worse than a missed one. "Not said to you" is the stronger
// claim, so it needs the probability of being addressed to be low, not merely below half. Lines shorter
// than a word are not worth a round trip.
export const JEV_BANTER_P = 0.7;
// Below this a line was not for the bot and the reply stays off the channel; above JEV_ADDRESSED_P it
// clearly was and the reply goes out at once. In between, on a line that is still being spoken, the
// answer is "wait for more of it": measured live, one word of a line ("Adem", "İyi adam") came back
// anywhere between 28% and 58%, and every one of those lines turned out to be for somebody else.
export const JEV_NOT_ADDRESSED_P = 0.3;
export const JEV_ADDRESSED_P = 0.6;
export const JEV_MIN_CHARS = 4;
// A line that has grown by this much since it was last judged is asked about again.
export const JEV_GROWTH_CHARS = 5;
// The reply gate. A line is judged as soon as its pieces stop arriving for this long, well before the
// line is closed for the record, because the model starts answering about a second after the person
// stops and the verdict has to be there first. While Jev answers, the bot's audio is held for at most
// this long and then played anyway: a slow Jev costs a moment, never the reply. A reply to a line that
// was not for the bot is kept off the channel for the length of that reply, with this much patience
// for it to start.
export const JEV_SETTLE_MS = 450;
// The audio says somebody stopped long before the transcript does, and the model answers within about
// a second of it: the hold starts there, and the first question is asked this soon after, from whatever
// the transcript has delivered.
export const JEV_SPEECH_END_SETTLE_MS = 200;
// Measured: the model's first audio comes 0.4 to 1.7 s after a person stops, and Jev's answer 0.3 to
// 1.2 s after it is asked. The hold has to outlast the slower of the two, or the reply slips out in the
// moment between them -- which is exactly what happened at 1.5 s.
export const REPLY_HOLD_MAX_MS = 2000;
// A reply kept off the channel is kept off for the whole turn: the model, told its answer was not
// played, tends to answer again ("hmm", "that conversation is yours") seconds later, and that is the
// same interruption in fewer words. The window ends at the next stop, or here at the latest.
export const REPLY_SUPPRESS_MS = 10_000;
// An aside: once a line was not for the bot, the room is talking among themselves, and for this long
// the bot needs a clear invitation -- its name, or a verdict above JEV_ADDRESSED_P -- before it speaks.
// A doubt is answered with silence, which is what a person would do.
export const ASIDE_MS = 20_000;
// The session's own report on itself: every few minutes, once enough has happened to say anything.
export const HEALTH_EVERY_MS = 300_000;
export const HEALTH_MIN_FRAGMENTS = 20;
// How many failures on one open session, inside this window, mean the session is no longer usable.
export const LIVE_ERROR_LIMIT = 3;
export const LIVE_ERROR_WINDOW_MS = 60_000; // errors further apart than this start the count again
// How long a realtime session has to stay up before the reconnect back-off starts again from one second.
export const LIVE_STABLE_MS = 30_000;

// Names the bot answers to on top of the active character's name, and the filler words dropped when
// deciding whether the name was called on its own or together with a request.
export const WAKE_WORDS = tList('runtime.wake_words');
export const WAKE_FILLER_WORDS = tList('runtime.wake_filler_words');

export const SETTING_NAMES = ['quiet', 'transcripts', 'announce_speaker', 'owner_priority', 'idle_close_minutes', 'local_tts', 'record', 'brain'];

// Spoken aliases -> canonical setting name; the switch below only knows the canonical names.
export const SETTING_ALIASES = tRaw('runtime.setting_aliases') ?? {};
