// brain strings (en). Keys are referenced as "brain.<key>" through src/i18n.
export default {
	// --- local brain: text model in the voice channel (src/localbrain.js)
	local_note: [
		'You are in a Discord voice channel; your ears are a local speech recogniser (the transcript can be wrong, your name can be misspelled), your mouth is a local speech synthesiser.',
		'Speech generation is slow: keep your reply to a SINGLE short sentence (15 words at most); the other person will ask for the rest if they want it. No bullet points, no lists, no emoji.',
		'Say a thing once: do not repeat yourself, and do not re-announce what you or a tool already reported.',
		'There can be more than one person in the channel; every message starts with the name of the speaker. Do not treat everyone the same way.',
		'Swearing and insults are usually a joke: you can fire back short and sharp, but you do not carry out an explicit sexual request — brush it off with a quip.',
		'Not everything you hear is meant for you: when people in the channel are talking among themselves, that conversation is theirs — do not answer it or chip in. Speak when something is aimed at you (your name, or a request or question meant for you).',
		'If a Discord job is asked for (send a message, play music, take a note, role/channel work and so on) call the matching tool; report the result in one sentence.',
		'Do not say "done/sent" without calling the tool. If a tool returns "ok:false", say briefly why.',
		'Admin tools only run when the owner asks; if anyone else asks, say "only the owner can do that".',
		'Do not make up what you do not know; you cannot search the web, so do not act as if you had.',
	],
	local_wake_words: ['bot', 'assistant'],
	local_name_hint: 'Your name is {name}; people call you "{name}".',
	local_default_speaker: 'someone',
	local_no_text_provider: 'no text provider',
	local_error: 'local brain error: {error}',
	// --- local speech recognition (src/localstt.js)
	stt_health_failed: 'local STT health check failed: {error}',
	stt_error: 'local STT error ({status})',
	stt_error_detail: 'local STT error ({status}): {detail}',
	// --- Chatterbox server process (src/localserver.js)
	local_server_running: 'running',
	local_server_off: 'off',
	local_server_exited: 'stopped (exit {code})',
	local_server_start_failed: 'could not start: {error}',
	local_server_no_venv: 'no virtual environment (tools/setup-chatterbox.ps1)',
	local_server_no_script: 'server file missing: {script}',
	local_server_gave_up: 'it stopped {count} times; start it by hand and check the log',
	local_server_starting: 'Starting the Chatterbox server: {python} {script} {args}',
	local_server_spawn_failed: 'Could not run the Chatterbox server: {error}',
	local_server_exit_log: 'The Chatterbox server stopped (exit {code}); attempt {count}/{max}.',
	local_server_token_not_kept: 'The Chatterbox token could not be kept in {file} ({error}); a server left running after the bot is killed will refuse the next start.',
	// --- local speech synthesis (src/localtts.js)
	tts_fallback_language: 'en',
	tts_health_failed: 'local TTS health check failed: {error}',
	speech_refused: 'the speech server at {url} refused the request ({status}): check LOCAL_TTS_TOKEN and LOCAL_TTS_URL, or stop a server left running by an earlier start of the bot (end the python process that holds that port)',
	tts_empty_text: 'empty text',
	tts_error: 'local TTS error ({status})',
	tts_error_detail: 'local TTS error ({status}): {detail}',
	// --- latency metrics (src/latency.js)
	latency_seconds: '{value}s',
	latency_summary: 'Response latency: P50 {p50}, P90 {p90} (n={count})',
};
