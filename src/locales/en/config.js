// config strings (en). Keys are referenced as "config.<key>" through src/i18n.
export default {
	missing_env_one: 'Missing environment variable: {keys} (check your .env file; template: .env.example)',
	missing_env_many: 'Missing environment variables: {keys} (check your .env file; template: .env.example)',
	// Spellings of on and off for a boolean .env setting. The lists of every bundled language are
	// accepted whatever BOT_LANGUAGE is, so the same .env means the same thing in every language; a value
	// on neither list keeps the setting's default and is reported at start.
	on_words: ['1', 'true', 'yes', 'on', 'enabled'],
	off_words: ['0', 'false', 'no', 'off', 'disabled'],
	// Values that mean "do not send this field at all" (effort/tier settings). Also accepted in every language.
	none_words: ['off', 'none', '-'],
	// Printed once at start (boot.config_warning) for a value that was read as something other than what
	// was written. {key} is the variable, {value} what it held.
	warn_bool: '{key}={value} is not an on/off value (1/0, true/false, yes/no, on/off); the default is used: {fallback}.',
	warn_number: '{key}={value} is not a number; the default is used: {fallback}.',
	warn_below: '{key}={value} is below the minimum, so {limit} is used.',
	warn_above: '{key}={value} is above the maximum, so {limit} is used.',
	warn_choice: '{key}={value} is not one of {choices}; {fallback} is used.',
	warn_intent: '{key}={value} is neither auto nor an on/off value; the intent is taken from the Developer Portal (auto).',
	warn_snowflake: '{key}: "{value}" is not a Discord ID (a number of 17 to 20 digits), so it will not match anything.',
	warn_target_pair: '{key}: "{entry}" is not a guildId:channelId pair and is skipped.',
	warn_target_repeat: '{key}: server {guild} is already listed with channel {channel}; "{entry}" is skipped.',
	warn_language: 'BOT_LANGUAGE={value} is not a supported language ({supported}); {fallback} is used.',
	// Printed once at start while BOT_LANGUAGE and at least one of the two keys are unset. {fix} is the
	// line to add, e.g. "LOCAL_TTS_LANG=tr LOCAL_STT_LANG=tr".
	note_language_defaults:
		"LOCAL_TTS_LANG and LOCAL_STT_LANG no longer mean Turkish when unset: the local voice speaks the bot's language (English, as BOT_LANGUAGE is not set) and whisper detects the language of each line. To keep Turkish, add {fix} to .env; setting BOT_LANGUAGE silences this note.",
	// Fallback persona, joined with spaces. Sets the language the assistant speaks.
	default_instructions: [
		'You are a voice assistant that lives in a Discord voice channel and speaks English.',
		'There can be several people in the channel; you understand as much of the talk as you hear and answer naturally.',
		'Keep your answers short and conversational, usually 1-3 sentences. Do not read out bullet lists, do not give speeches.',
		'The channel is a live voice conversation; do not cut in, wait your turn. Answer when someone calls on you or asks you a question.',
	],
};
