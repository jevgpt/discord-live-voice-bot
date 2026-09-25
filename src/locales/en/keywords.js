// keywords strings (en). Keys are referenced as "keywords.<key>" through src/i18n.
//
// This namespace holds the speech-matching language data: the owner-gate keyword table, mention and
// permission vocabularies, colour names and audit-log labels. The gate compares these words against
// what was actually heard, so they must be real words of THIS locale, not translations of the keys.
export default {
	// Ways of saying "the private conversation we just had" (delete_messages / edit_message dm argument).
	// "Write to me", "my roles", "move me down": not a name, but the person saying it. Only consulted
	// when no real name matched, so somebody actually called "Me" keeps the name they have.
	self_words: ['me', 'myself', 'my', 'mine', 'i'],
	last_dm_words: ['last', 'the last one', 'that one', 'it', 'latest', 'previous'],
	// How the bot's own status line and online state may be spoken (src/tools/identity.js).
	presence_status: {
		online: ['online', 'active', 'available'],
		idle: ['idle', 'away'],
		dnd: ['dnd', 'do not disturb', 'busy'],
		invisible: ['invisible', 'offline', 'hidden'],
	},
	presence_activity: {
		playing: ['playing', 'play'],
		listening: ['listening', 'listen'],
		watching: ['watching', 'watch'],
		competing: ['competing', 'compete'],
		streaming: ['streaming', 'stream'],
		custom: ['custom', 'custom status', 'personal status', 'status line'],
	},
	no_picture_words: ['none', 'no picture', 'remove', 'clear', 'off'],
	// Spoken ways of saying "do not put this channel in any category" (edit_channel parent).
	no_category_words: ['none', 'no category', 'nowhere', 'root', 'top level', 'uncategorised', 'uncategorized', 'outside'],
	// Spoken and written spellings of on/off, beyond the universal 1/0/true/false/yes/no set.
	bool_true: ['ok', 'okay', 'yep', 'yeah', 'active', 'up'],
	bool_false: ['nope', 'nah', 'inactive', 'stop', 'down'],
	// Which tails a "=stem" gate keyword may pick up before it stops being that word. An English command
	// is an imperative and hardly inflects, so only the third-person "s" is allowed: "takes" is still
	// "take", while "taking" and "taken" are ordinary speech and must not open the gate.
	// English negates with a separate word rather than a suffix, so there is no tail to recognise.
	negation: { pattern: '', flags: 'u' },
	// Nor is there a negated shape of a word to find in an answer: "shouldn't" is spelled out as "should
	// not" before it is read (spokenTokens in src/attribution.js), and "not" is one of the no words.
	negative_word: { pattern: '', flags: 'u' },
	inflection: { pattern: '^(?:s|es)?$', flags: 'u' },
	// The forms a plain (non "=") entry is heard in. English builds no words by gluing, so a plain entry is
	// the whole word plus these tails, never a prefix: "ban" is "ban", "bans", "banned", "banning", and
	// not "banana", "band" or "bank". A word ending in e takes -s/-d and loses the e before -ing
	// ("deleted", "deleting"); a short vowel before one final consonant doubles it ("banned").
	word_forms: {
		suffixes: ['s', 'es', 'ed', 'ing'],
		after_e: ['s', 'd'],
		drop_e: ['ing'],
		doubled: ['ed', 'ing'],
		double_after: '[^aeiou][aeiou][b-df-hj-np-tvz]$',
	},
	// Whole-word matching already keeps "banana" away from "ban", so English has no look-alikes to list.
	lookalikes: [],
	// Set phrases that hold a command word and ask for nothing: a command word heard inside one of these
	// does not count. "Kick off" is a start, "boot up" a computer, and a saying is not a setting.
	phrase_lookalikes: [
		'kick off', 'kicks off', 'kicked off', 'kicking off',
		'boot up', 'boots up', 'booted up', 'booting up',
		'silence is golden',
	],
	// Owner-gate keywords: for an admin tool to run, the owner must have said one of these words.
	// A plain entry matches the whole word in the forms above; an entry written as "=word" matches only
	// itself and a plural "s". Words that are mostly everyday speech are left out when the group keeps a
	// real command without them ("pardon?" and "forgive me" were opening the ban tools, "sounds good" the
	// voice ones, "here" an @everyone ping), or pinned when a real command needs them ("=room").
	// Destructive tools gate on the VERB (delete, cancel, prune, kick, ban): "channel" on its own was
	// enough to open channel deletion, and naming a thing is not asking for it to go. "Get rid of" is a
	// verb too; the gate matches single words, and "rid" is hardly ever heard outside that phrase.
	words: {
		ban: ['ban', 'banned', 'unban', 'blacklist', 'forbid'],
		kick: ['kick', 'kicked', 'boot', 'eject', 'disconnect'],
		timeout: ['timeout', 'mute', 'silence'],
		role: ['role', 'rank', 'permission'],
		voice: ['voice', 'mic', 'microphone', 'mute'],
		setting: ['setting', 'mode', 'config', 'configure', 'configuration', 'option', 'quiet', 'silence', 'shut', 'hush', '=speak', '=talk'],
		delete: ['delete', 'remove', 'clear', 'purge', 'wipe', 'clean', '=rid'],
		cancel: ['cancel', 'delete', 'remove', 'scrap', '=rid'],
		prune: ['prune', 'purge', 'kick', 'remove', 'clean', '=rid'],
		channel: ['channel', '=room', 'category', 'lock', 'unlock'],
		name: ['nickname', 'nick', 'rename', '=name'],
		invite: ['invite', 'invitation', 'link'],
		log: ['log', 'audit', 'record', 'history'],
		move: [
			'move', 'relocate', 'transfer', 'drag', 'gather', 'summon', '=bring', '=pull', '=take', '=send',
			'=come', '=join', '=fetch', '=put', '=shift', '=haul',
		],
		everyone: ['everyone', 'everybody', 'ping', 'tag', 'mention', 'announce'],
		forget: ['forget', 'delete', 'remove', 'drop', '=rid'],
		record: ['record', 'transcript', 'privacy'],
		bot: ['bot', 'use bot', 'bot command', 'robot'],
		thread: ['thread', 'threads', 'subthread', 'discussion'],
		pin: ['pin', 'pinned', 'unpin', 'sticky'],
		reaction: ['reaction', 'react', 'reacted'],
		emoji: ['emoji', 'emote', 'sticker', 'expression'],
		event: ['event', 'schedule', 'scheduled'],
		automod: ['automod', 'automoderation', 'filter', 'rule'],
		webhook: ['webhook', 'hook'],
		server: ['server', 'guild', 'prune', 'vanity', 'widget', 'banner'],
		identity: [
			'avatar', 'banner', 'profile', 'nickname', 'status', 'presence', 'playing', 'appearance', 'picture',
			'bio', 'rename', 'username', '=name',
		],
		permission: [
			'permission', 'perm', 'access', 'connect', '=lock', '=join', '=enter', '=view', '=see',
			'=read', '=write', '=send', '=speak', '=talk', '=allow', '=deny', '=block', '=only',
		],
	},

	// The owner's answer to a two-step confirmation ("should I ban Sam?"). A yes counts only when the
	// owner's words since the question hold one of these and none of the no words: "yes, no wait" is not
	// a yes, and neither is "okay, forget it" or "ok stop". Every "n't" arrives as "not" (spokenTokens),
	// so "I didn't say yes" and "you shouldn't do it" carry their no. "Cancel", "forget" and "stop" are
	// no words, except when they are the verb of the thing being asked about: "yes, cancel it" to "should
	// I cancel movie night?" is a yes, because the question's own command words are not read as a no.
	confirm_yes: [
		'=yes', '=yeah', '=yep', '=yup', '=sure', 'confirm', '=ok', '=okay', 'go ahead', 'do it', '=proceed',
		'=absolutely', '=definitely', '=correct', '=affirmative',
	],
	confirm_no: [
		'=no', '=nope', '=nah', '=not', '=cannot', '=dont', '=never', '=wait', '=hold', 'abort', '=negative', '=nevermind',
		'cancel', 'forget', 'stop', 'leave it', 'skip it', 'as if',
	],

	// Mention resolution: names that mean the whole channel rather than one member.
	everyone_mention_words: ['everyone', 'everybody', 'all', 'all members'],
	here_mention_words: ['here', 'present', 'online'],
	// Extra spellings fed to the name -> mention replacement, so "@everyone" is not written twice.
	everyone_mention_variants: ['everyone', 'everybody'],
	here_mention_variants: ['here'],

	// Relative voice-channel targets ("the room below") and which of them mean "upwards".
	relative_target_words: ['down', 'below', 'lower', 'down channel', 'lower channel', 'up', 'above', 'upper', 'up channel', 'upper channel'],
	relative_up_words: ['up', 'above', 'upper'],

	// Spoken colour names -> colour value, used when creating or editing a role.
	color_names: {
		red: 0xed4245,
		blue: 0x3498db,
		green: 0x57f287,
		yellow: 0xfee75c,
		purple: 0x9b59b6,
		orange: 0xe67e22,
		pink: 0xeb459e,
		white: 0xffffff,
		black: 0x000000,
		grey: 0x95a5a6,
		gray: 0x95a5a6,
	},

	// Audit-log entries: Discord enum name -> readable label.
	audit_actions: {
		MemberBanAdd: 'ban',
		MemberBanRemove: 'unban',
		MemberKick: 'kick',
		MemberMove: 'voice channel move',
		MemberDisconnect: 'voice disconnect',
		MemberUpdate: 'member update',
		MemberRoleUpdate: 'role change',
		MemberTimeout: 'timeout',
		MessageDelete: 'message delete',
		MessageBulkDelete: 'bulk message delete',
		MessagePin: 'message pin',
		MessageUnpin: 'message unpin',
		ChannelCreate: 'channel create',
		ChannelUpdate: 'channel update',
		ChannelDelete: 'channel delete',
		RoleCreate: 'role create',
		RoleUpdate: 'role update',
		RoleDelete: 'role delete',
		InviteCreate: 'invite create',
		InviteDelete: 'invite delete',
	},

	// Channel permissions: the "everyone" target of a permission change.
	permission_everyone_words: ['everyone', 'everybody', 'here', 'all', 'all members', 'default'],

	// Permission names that can be said out loud -> discord.js PermissionFlagsBits key. Dangerous,
	// server-wide permissions (Administrator, ManageRoles, ManageGuild, ManageWebhooks, Ban/Kick) are
	// deliberately absent: they cannot be handed out by voice.
	permission_aliases: {
		ViewChannel: ['see', 'view', 'visible', 'visibility', 'show', 'look', 'view channel', 'read channel'],
		Connect: ['connect', 'connection', 'join', 'enter', 'access voice'],
		Speak: ['speak', 'talk', 'voice', 'mic', 'microphone'],
		SendMessages: ['write', 'send', 'message', 'send message', 'send messages', 'chat', 'post', 'type'],
		ReadMessageHistory: ['history', 'read history', 'message history', 'read message history', 'past messages'],
		AttachFiles: ['file', 'files', 'attach', 'attach files', 'upload', 'send files'],
		EmbedLinks: ['link', 'links', 'embed', 'embed links'],
		AddReactions: ['reaction', 'reactions', 'react', 'add reactions', 'emoji reaction'],
		Stream: ['stream', 'go live', 'screen share', 'screenshare', 'camera', 'video'],
		UseVAD: ['voice activity', 'vad', 'use vad'],
		PrioritySpeaker: ['priority', 'priority speaker'],
		MuteMembers: ['mute', 'mute members', 'silence members'],
		DeafenMembers: ['deafen', 'deafen members'],
		MoveMembers: ['move', 'move members', 'drag members'],
		ManageMessages: ['manage messages', 'manage message', 'delete messages', 'moderate messages'],
		ManageChannels: ['manage channels', 'manage channel', 'edit channel'],
		MentionEveryone: ['mention everyone', 'ping everyone', 'tag everyone'],
		CreatePublicThreads: ['thread', 'threads', 'start thread', 'create thread', 'create public threads'],
		SendMessagesInThreads: ['write in threads', 'reply in threads', 'send messages in threads'],
		UseApplicationCommands: ['command', 'commands', 'slash', 'slash command', 'use application commands'],
		UseExternalEmojis: ['external emoji', 'external emojis', 'use external emojis'],
		CreateInstantInvite: ['invite', 'invitation', 'create invite', 'create instant invite'],
	},
	// Groups: one word, several permissions.
	permission_groups: {
		access: ['ViewChannel', 'Connect', 'SendMessages'],
		entry: ['ViewChannel', 'Connect'],
	},
	// Spoken labels for a permission, used when reading a permission change back out loud.
	permission_labels: {
		ViewChannel: 'view',
		Connect: 'connect',
		Speak: 'speak',
		SendMessages: 'write',
		ReadMessageHistory: 'read history',
		AttachFiles: 'attach files',
		EmbedLinks: 'embed links',
		AddReactions: 'add reactions',
		Stream: 'stream',
		UseVAD: 'voice activity',
		PrioritySpeaker: 'priority speaker',
		MuteMembers: 'mute',
		DeafenMembers: 'deafen',
		MoveMembers: 'move',
		ManageMessages: 'manage messages',
		ManageChannels: 'manage channels',
		MentionEveryone: 'mention everyone',
		CreatePublicThreads: 'create threads',
		SendMessagesInThreads: 'write in threads',
		UseApplicationCommands: 'slash commands',
		UseExternalEmojis: 'external emojis',
		CreateInstantInvite: 'create invites',
	},
	permission_help: 'see, connect, speak, write, history, files, links, reactions, stream, mute, move, manage messages, manage channels, invite, access (= see + connect + write)',
};
