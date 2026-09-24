// commands strings (en). Keys are referenced as "commands.<key>" through src/i18n.
//
// "slash" mirrors the slash command tree (command -> options / subcommands -> options). Every entry
// carries a name and a description. The name is a Discord identifier, so the English bundle holds
// the names that are actually registered and that handleCommand() switches on; the Turkish bundle
// holds the name and description Turkish clients are shown instead, because Discord localises per
// VIEWER, not per bot language.
export default {
	slash: {
		join: {
			name: 'join',
			description: 'Join a voice channel',
			options: {
				channel: { name: 'channel', description: 'Voice channel (leave it empty and I join the one you are in)' },
			},
		},
		leave: { name: 'leave', description: 'Leave the voice channel' },
		panel: { name: 'panel', description: 'Opens the character and voice panel' },
		character: {
			name: 'character',
			description: 'Change the active character',
			options: { name: { name: 'name', description: 'Character name' } },
		},
		send: {
			name: 'send',
			description: 'Send a message to a text channel',
			options: {
				channel: { name: 'channel', description: 'Text channel' },
				message: { name: 'message', description: 'Message' },
			},
		},
		read: {
			name: 'read',
			description: 'Read the new messages of a channel out loud',
			options: {
				channel: { name: 'channel', description: 'Text channel' },
				count: { name: 'count', description: 'How many messages at most (1-10)' },
			},
		},
		status: { name: 'status', description: 'Bot status' },
		help: { name: 'help', description: 'List of the voice and slash commands' },
		music: {
			name: 'music',
			description: 'Play / stop / skip music, or set the volume',
			subcommands: {
				play: {
					name: 'play',
					description: 'Play a song or add it to the queue',
					options: { query: { name: 'query', description: 'Song title, artist or link' } },
				},
				stop: { name: 'stop', description: 'Stop the music and clear the queue' },
				pause: { name: 'pause', description: 'Pause the music' },
				resume: { name: 'resume', description: 'Resume the music' },
				skip: { name: 'skip', description: 'Skip to the next track' },
				volume: {
					name: 'volume',
					description: 'Music volume',
					options: { percent: { name: 'percent', description: '0-100' } },
				},
				status: { name: 'status', description: 'What is playing and what is queued' },
			},
		},
		summary: {
			name: 'summary',
			description: 'Summary of the recent conversations here, from the channels you can read',
			options: { hours: { name: 'hours', description: 'How many hours back (default 3)' } },
		},
		recording: {
			name: 'recording',
			description: 'Turn conversation/message recording on and off (privacy)',
			options: {
				status: {
					name: 'status',
					description: 'on / off / status',
					choices: { on: 'on', off: 'off', status: 'status' },
				},
			},
		},
	},

	help: [
		'**Voice commands** (just say them in the channel):',
		'• "switch to the Aria character" — change character',
		'• "write hello in the general channel" — send a message to a text channel',
		"• \"what's new in the general channel\" — read the new messages of the channel",
		'• "join the chat channel" — join a voice channel · "leave the channel"',
		"• \"play Daft Punk Around the World\" / \"put on some jazz\" — play music · \"stop / pause / resume the music\" · \"skip the song\" · \"turn the music down / up\" · \"what's playing\"",
		'• Owner: "ban / mute X", "give X a role", "lock the channel", "remember this", "what was said today"',
		'',
		'**Slash commands:** /join /leave /panel /character /send /read /status /music /summary /recording /help',
	],

	// The command came from a server the bot is not set up for (it is not in VOICE_TARGETS, or it was
	// left for good); /join is the way back in.
	no_guild_session: 'I am not set up for this server. Bring me into a voice channel with `/join` first.',
	// /join in a server outside GUILD_ID/VOICE_TARGETS: a new session there is on the owner's keys, so
	// only the owner and ADMIN_USER_IDS may start one.
	join_unconfigured_denied: 'I am not set up for this server, and only my owner can bring me into a new one.',

	log_registered: 'Slash commands registered.',
	log_register_failed:
		'Could not register the slash commands: {error}. You need to invite the bot again with the "applications.commands" scope.',
	log_interaction_error: 'Interaction error ({command}): {error}',
	error_generic: 'Something went wrong: {error}',
	gate_denied_activity: '{command}: denied (not allowed)',
	gate_unconfigured_activity: 'join in {guild}: denied (not a configured server; only the owner or ADMIN_USER_IDS may start a session there)',

	modal_new_title: 'New character',
	modal_edit_title: 'Edit: {name}',
	modal_name_label: 'Character name',
	modal_prompt_label: 'Personality / instructions (prompt)',
	modal_voice_label: 'Voice (blank = default; list on panel)',

	panel_title: 'Character panel',
	panel_empty: 'No characters yet. Add one with "New character".',
	panel_voice_suffix: ' · voice: {voice}',
	panel_voices_footer: 'Voices: {voices}',
	panel_active_field: 'Active: {name}',
	panel_select_placeholder: 'Pick the active character',
	panel_no_prompt: 'no prompt',
	button_new: 'New character',
	button_edit: 'Edit',
	button_delete: 'Delete',
	button_refresh: 'Refresh',
	button_join: 'Join my channel',
	button_leave: 'Leave the channel',
	button_delete_yes: 'Yes, delete it',
	button_cancel: 'Cancel',

	join_no_channel: 'You are not in a voice channel; pick one with `/join channel:#channel`.',
	joined: 'I joined **{channel}**.',
	join_failed: 'I could not join: {error}',
	left: 'I left the voice channel.',

	character_not_found: 'There is no character saved as "{name}".',
	character_active: 'Active character: **{name}**',
	character_missing: 'I could not find that character.',
	character_gone: 'That character is already gone.',
	character_created: '**{name}** created and active.',
	character_updated: '**{name}** updated.',
	character_deleted: '**{name}** deleted.',
	no_character_to_edit: 'There is no character to edit.',
	no_character_to_delete: 'There is no character to delete.',
	delete_confirm: 'You are about to delete the **{name}** character; this cannot be undone.',
	delete_cancelled: 'Deletion cancelled.',
	saved: 'Saved.',
	voice_unknown: '"{voice}" is not a voice I know. Options: {voices}',
	persona_reason_character: 'character: {character}',
	persona_reason_character_updated: 'character updated: {character}',
	persona_reason_character_deleted: 'character deleted',

	sent: 'Sent it to **#{channel}**.',
	send_failed: 'I could not send it: {reason}',
	read_failed: 'I could not read it: {reason}',
	reading: 'Reading {count} messages from #{channel}{suffix}.',
	reading_new_suffix: ' (new)',

	status_voice: 'Voice channel: {channel}',
	status_voice_none: 'none',
	status_brain: 'Brain: {brain}',
	status_brain_local: 'local (whisper + text model + Chatterbox)',
	status_live: 'GPT-Live session: {state}',
	status_open: 'open',
	status_closed: 'closed',
	status_voice_engine: 'Voice: {engine}{server}',
	status_voice_engine_local: 'local (Chatterbox)',
	status_chatterbox_server: ' · Chatterbox server: {url}',
	status_character: 'Character: {character}',
	status_character_default: 'default',
	status_music: 'Music: {music}',
	status_music_off: 'off',
	status_record: 'Recording: {state}',
	status_record_on: 'on',
	status_record_off: 'off (transcripts are not written)',
	status_quota: 'Daily GPT-Live quota: {used} / {limit} min',
	// Several servers at once: the report above is about this one, these lines are the others.
	status_sessions_header: '**Servers ({count}):**',
	status_session_line: '• {guild} — {channel} · {brain} · GPT-Live: {live}',

	music_disabled: 'The music feature is off (.env: MUSIC=1).',
	music_unknown: 'Unknown music command.',
	ok: 'Done.',
	failed: 'That did not work.',
	summary_unavailable: 'The summary feature is not part of this setup.',
	summary_guild_only: 'Ask for the summary inside the server: it covers the channels you can read there.',
	record_status:
		'Recording is currently {state}. (While it is off, voice transcripts and message texts are not written to the panel log; no summary can be made.)',
	record_state_on: 'ON',
	record_state_off: 'OFF',
	record_toggled: 'Recording {state}.',
	record_turned_on: 'turned on',
	record_turned_off: 'turned off',
	unknown_command: 'Unknown command.',
};
