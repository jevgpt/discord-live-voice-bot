// boot strings (en). Keys are referenced as "boot.<key>" through src/i18n.
//
// Everything printed while the bot comes up: the configuration error before anything else exists,
// and the start-up summary written once the Discord client is ready.
export default {
	config_failed: 'Could not read the settings: {error}',
	// One line per setting that was not read as written (config.warn_*); the bot starts regardless.
	config_warning: 'Settings: {warning}',

	panel_history: 'Panel history loaded: {count} events (data/activity.jsonl).',
	joined_channel: 'I joined the "{channel}" channel. Listening to what is said.',
	voice_channel_missing: 'Voice channel not found ({channel}); you can bring me in with /join.',
	message_baseline: 'Message baseline taken: {count} text channels (only the new ones are read when asked).',

	intents: 'Intents — presence: {presence}, members: {members}, message content: {messageContent}',
	on: 'on',
	off: 'off',

	text_generation: 'Text generation: {provider}.',
	tools_backend: 'Tools: Responses backend ({model}) — {count} tools + web search.',
	tools_client: 'Tools: client delegation — regex voice commands only; set RESEARCH_MODEL and every tool is enabled.',

	owner_priority: 'Owner priority on: while {owner} speaks only their audio is processed.',
	attribution_path:
		'Speaker attribution: one path of speakers over each line (ATTRIBUTION=hmm); a fragment at the edge of a turn goes with its neighbours unless its own audio says otherwise.',
	attribution_vote: 'Speaker attribution: every fragment by its own audio (ATTRIBUTION=vote).',
	no_owner_id: 'OWNER_ID is not set: the spoken admin tools (ban/role/channel/setting) are off; slash permission goes through ManageGuild.',

	music_on: 'Music on: volume {volume}%, {duck}% while someone is speaking{folder}.',
	music_folder: ', local folder: {dir}',

	brain_local: 'Brain: LOCAL (whisper + text model + Chatterbox); GPT-Live will not be used.',
	brain_auto: 'Brain: GPT-Live; falls back to the local brain (whisper + DeepSeek + Chatterbox) on a credit/key error.',
	brain_live: 'Brain: GPT-Live only.',

	chatterbox_autostart: 'The Chatterbox server will be started by the bot when it is needed ({model}, whisper {stt}).',
	chatterbox_missing_venv: 'The Chatterbox virtual environment was not found (.venv-chatterbox); for local speech run tools/setup-chatterbox.ps1.',

	daily_quota: 'Daily GPT-Live quota: {limit} min ({used} min used today).',
	record_off: 'Recording is OFF: voice transcripts and message texts are not written to the panel log.',
	memory_on: 'Memory on: {users} people, {notes} notes.',

	// One server of several could not be brought up; the rest carry on.
	guild_failed: 'Server {guild} could not be set up: {error}',
	no_guilds: 'No server could be set up: nothing is being listened to. Check GUILD_ID / CHANNEL_ID / VOICE_TARGETS.',
	member_index_failed: 'The member index could not be loaded: {error}',
	panel_failed: 'The panel could not be started: {error}',
	setup_failed: 'Setup failed: {error}',
	login_failed: 'Discord login failed: {error}',
};
