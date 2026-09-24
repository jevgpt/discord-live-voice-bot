// grammar strings (en). Keys are referenced as "grammar.<key>" through src/i18n.
//
// This namespace holds the voice-command grammar: the patterns src/commands.js turns into matchers
// when it parses what was said in the voice channel. Every pattern is a plain RegExp source string
// plus its flags, so a language can be added without touching the parser. The patterns must be
// written in THIS locale's language -- they are matched against real speech, not translated.
//
// English puts the verb and the message first and the target last ("write hello in the general
// channel"), so the channel name is read out of the tail of the sentence and the message out of the
// part in front of it; see the send.body_before_channel switch below.

// Numbers the transcript may write out as words, for the queue and seek commands under music below. A
// place in the queue ("move three to one") takes cardinals and ordinals; an amount of time ("skip ahead
// thirty seconds", "a minute") takes cardinals and the article. [spoken word, value] pairs.
const CARDINALS = [
	['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
	['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16],
	['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20], ['thirty', 30], ['forty', 40], ['forty-five', 45],
	['fifty', 50], ['sixty', 60], ['ninety', 90],
];
const ORDINALS = [
	['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5], ['sixth', 6], ['seventh', 7], ['eighth', 8],
	['ninth', 9], ['tenth', 10],
];
const ARTICLES = [['a', 1], ['an', 1]];
// Longest first, so "forty-five" is not read as "forty"; the hyphen may be a space in a transcript.
const alternatives = (pairs) =>
	pairs
		.map(([word]) => word)
		.sort((a, b) => b.length - a.length)
		.map((word) => word.replace(/-/gu, '[\\s-]'))
		.join('|');
// A queue position: digits ("3", "3rd") or a word; ORD takes the ordinal ending and closes the number.
const POS = `(?:\\d{1,3}|${alternatives([...CARDINALS, ...ORDINALS])})`;
const ORD = '(?:st|nd|rd|th)?(?![\\p{L}\\p{N}])';
// An amount of time: digits or a word, never an ordinal ("second" is a unit here).
const AMOUNT = `(?:\\d{1,4}|${alternatives([...CARDINALS, ...ARTICLES])})`;
const UNIT = '(?:sec(?:ond)?s?|min(?:ute)?s?)(?![\\p{L}])';
// "30 seconds", "a minute and 15 seconds", "1 minute 30 seconds".
const SPAN = `(?<n1>${AMOUNT})\\s*(?<u1>${UNIT})(?:\\s*(?:and\\s+)?(?<n2>${AMOUNT})\\s*(?<u2>${UNIT}))?`;
// "1:30", "1.30", "1:02:03".
const STAMP = '(?<stamp>\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?)';
// The end of the sentence, and what may trail a seek or queue command without making it another one.
// The commands are held to the end of the line on purpose: "go to 2:30" is a seek, "let's go to the
// 2:30 showing" is not.
const END = '(?:\\s+please)?[.!?]*\\s*$';
// "The list" is anybody's list (shopping, guests, things to do): only the queue and the playlist are the music's.
const QUEUE_NAME = '(?:queue|playlist)';
const TAIL = `(?:\\s+(?:in|of)\\s+(?:the|this)\\s+(?:song|track))?(?:\\s+(?:in|on)\\s+the\\s+${QUEUE_NAME})?${END}`;
// ... and where one may begin. These commands run with no wake word, straight off what was heard, so they
// have to BE the sentence rather than sit inside one: "go back ten seconds" is a request, "I had to go back
// 10 seconds", "let's go back to the beginning" and "I will go to 3:30" are people talking. In front of the
// command there may be a name and a comma ("Aria, shuffle") and a filler word or two; the bot's own names
// are taken off in src/commands.js before any of this is tried, with a comma or without.
const LEAD = "^\\s*(?:[\\p{L}\\p{N}'’]+,\\s*)?(?:(?:please|just|now|ok(?:ay)?|hey|so),?\\s+)*";
// Where the words name the music outright ("loop this song", "shuffle the queue", "rewind 10 seconds"), a
// request put as a question counts as well.
const ASK = `${LEAD}(?:(?:can|could|would)\\s+you\\s+(?:please\\s+|just\\s+)?)?`;
// "move song 3", "move the third one", "move number 3".
const MOVE_HEAD = `${ASK}(?:move|bump|shift)\\s+(?:(?:song|track|number|the)\\s+)*(?<from>${POS})${ORD}(?:\\s+(?:song|track|one))?\\s+(?:up\\s+|down\\s+)?to\\s+`;

export default {
	// Dictation particles: "write X in general" leaves a trailing quoting particle that must not
	// become part of the message. Source string for a case-insensitive unicode RegExp.
	dictation_tail: '\\s+(?:okay|please)?\\s*(?:say|write|send)\\s+(?:that|it|this)?[.!?,]*$',
	// Speech-to-text can garble a channel name, and some languages need a tolerant letter class per
	// character, so that a plain letter matches its accented form too. English names are matched
	// literally, so the map is empty.
	letter_classes: {
		a: '[aáàâä]',
		c: '[cçć]',
		e: '[eéèêë]',
		g: '[gğ]',
		i: '[iíìîïıİ]',
		n: '[nñ]',
		o: '[oóòôöõ]',
		s: '[sśş]',
		u: '[uúùûü]',
	},

	// "switch to the Aria character", "change the character to Aria", "become the character Aria".
	// Capture group 1 is the character name; the word character/persona is required so that
	// "switch to the general channel" stays a join request. The first matching pattern wins.
	character_switch: [
		{
			pattern: '(?:switch|change|turn|go)\\s+(?:over\\s+)?to\\s+(?:the\\s+)?([\\p{L}\\p{N}_\\- ]{1,40}?)\\s+(?:character|persona)(?![\\p{L}])',
			flags: 'iu',
		},
		{
			pattern: '(?:switch|change|set)\\s+(?:the\\s+)?(?:character|persona)\\s+(?:over\\s+)?to\\s+(?:the\\s+)?([\\p{L}\\p{N}_\\- ]{1,40}?)[.!?]*\\s*$',
			flags: 'iu',
		},
		{
			pattern: '(?:become|act\\s+as|speak\\s+as|talk\\s+as|switch\\s+to|use)\\s+(?:the\\s+)?(?:character|persona)\\s+([\\p{L}\\p{N}_\\- ]{1,40}?)[.!?]*\\s*$',
			flags: 'iu',
		},
	],

	// "leave the channel", "get out of the voice channel", or a bare "disconnect".
	leave: {
		pattern:
			'(?<![\\p{L}])(?:leave|exit|quit|disconnect(?:\\s+from)?|get\\s+out\\s+of|hop\\s+out\\s+of)\\s+(?:the\\s+|this\\s+|your\\s+)?(?:voice\\s+)?(?:channel|chat|room|call|vc)(?![\\p{L}])|(?<![\\p{L}])(?:leave|disconnect)\\s*[.!?]*$',
		flags: 'iu',
	},

	// "be quiet", "shut up" and the way back, "you can speak again". Being quiet is a state of the
	// application and not a request to the model, so the words that switch it are matched here and run
	// without one. A bare "quiet" is deliberately absent: "the reading room is quiet" is a sentence,
	// not an instruction.
	quiet: {
		on: {
			pattern: '(?<![\\p{L}])(?:be\\s+quiet|quiet\\s+down|shut\\s+up|shut\\s+it|hush|silence)(?![\\p{L}])',
			flags: 'iu',
		},
		off: {
			pattern: '(?<![\\p{L}])(?:(?:you\\s+)?(?:can|may)\\s+(?:speak|talk)|(?:speak|talk)\\s+again)(?![\\p{L}])',
			flags: 'iu',
		},
		// The bare word, only next to the bot's name ("Melis, talk").
		off_named: {
			pattern: '(?<![\\p{L}])(?:speak|talk)(?![\\p{L}])',
			flags: 'iu',
		},
	},

	// What may follow a channel name: the word that marks it as a channel.
	channel_suffix: { pattern: '^\\s*(?:voice\\s+)?(?:channel|chat|room|vc)(?![\\p{L}])', flags: 'iu' },

	// Filler words stripped from the front of a dictated message or a music query. "the" is
	// deliberately absent: it is part of plenty of band and song names.
	fillers: { pattern: '^(?:please|just|now|maybe|quickly|kindly|hey|okay|ok)\\s+', flags: 'iu' },

	// "message:" in front of the dictated text is part of the command, not of the message. A
	// separator (or the end of the text) is required so that a song called "Message in a Bottle"
	// survives intact.
	message_prefix: { pattern: '^(?:a\\s+|the\\s+)?(?:message|msg)\\s*(?:[:,]\\s*|$)', flags: 'i' },

	// Filler words stripped from the front of a spoken channel name.
	channel_name_fillers: { pattern: '^(?:the|this|that|a|an|our|my|voice|text|please|just|now)\\s+', flags: 'iu' },

	// Words that are too generic to be a channel name (compared against the normalised name).
	generic_channel_words: ['the', 'a', 'voice', 'voice channel', 'channel', 'channels', 'text', 'chat', 'room', 'this', 'that', 'here'],

	send: {
		// Left boundary so that the "say" inside "essay" is not a verb. "tell" and "announce" are
		// left out on purpose: they put the message after the channel, which this shape cannot read.
		verb: { pattern: '(?<![\\p{L}])(?:write|send|post|say|type|drop)(?:s|es|ing)?(?![\\p{L}])', flags: 'iu' },
		// English says the message before the channel ("write hello in the general channel"), so the
		// part in FRONT of the channel name is searched as well.
		body_before_channel: true,
		// ... after trimming the preposition that introduces the channel, which would otherwise end
		// up at the end of the message.
		channel_lead: { pattern: '\\s+(?:in|into|to|on|over\\s+(?:in|at)|at)\\s+(?:the\\s+|our\\s+|my\\s+)?$', flags: 'iu' },
		// Channel name is not in the list: pull it out of the "... in the <name> channel" shape and
		// match it loosely afterwards. Group 2 is the name, group 1 the message side.
		legacy: {
			pattern: '(.+?)\\s+(?:in|into|to|on)\\s+(?:the\\s+)?([\\p{L}\\p{N}_\\- ]{1,40}?)\\s*(?:voice\\s+)?(?:channel|chat|room)(?![\\p{L}])',
			flags: 'iu',
			name: 2,
			body: 1,
		},
		// No name at all: "write hello in the channel" (the default channel is used).
		bare: { pattern: '(?:in|into|to|on)\\s+(?:the\\s+)?(?:channel|chat)\\s*[:,]?\\s*(?:a\\s+)?(?:message\\s*)?', flags: 'i' },
	},

	read: {
		// A real request to read, not "already read that" on its own.
		hint: {
			pattern:
				"(?<![\\p{L}])(?:read(?:\\s+out)?|what(?:'|’)?s\\s+(?:new|written|being\\s+said|going\\s+on)|what\\s+(?:is|was)\\s+(?:written|said)|what\\s+(?:did|do)\\s+(?:you|they|he|she)\\s+(?:say|write|post)|any(?:thing)?\\s+new|new\\s+messages|last\\s+messages|latest\\s+messages|recent\\s+messages|catch\\s+me\\s+up)(?![\\p{L}])",
			flags: 'iu',
		},
		// The sentence must be about a channel or about messages.
		requires: { pattern: 'channel|chat|room|message', flags: 'i' },
		// Channel name is not in the list. Group 1 is the name.
		legacy: {
			pattern: '(?:(?:read|check|show|open)\\s+(?:me\\s+)?|(?:in|from|on)\\s+)(?:the\\s+)?([\\p{L}\\p{N}_\\- ]{1,40}?)\\s*(?:voice\\s+)?(?:channel|chat|room)(?![\\p{L}])',
			flags: 'iu',
		},
	},

	join: {
		// Tested against single normalised words, so only whole verbs belong here. "get" and "move"
		// are left out: they are far too common in sentences that are not a request to join.
		verb: { pattern: '^(?:join|joins|come|comes|connect|hop|jump|enter|pop|switch)$', flags: 'u' },
		// A channel/room word or a known voice channel name has to be there; otherwise "come/enter"
		// fires on the wrong sentences.
		place: { pattern: '(?<![\\p{L}])(?:channel|room|voice|vc|call)', flags: 'iu' },
		// Channel name is not in the list. Group 1 is the name.
		legacy: {
			pattern:
				'(?:(?:join|come\\s+to|connect\\s+to|get\\s+in(?:to)?|hop\\s+in(?:to)?|move\\s+to|switch\\s+to)\\s+)?(?:the\\s+)?([\\p{L}\\p{N}_\\- ]{1,40}?)\\s*(?:voice\\s+)?(?:channel|room)(?![\\p{L}])',
			flags: 'iu',
		},
	},

	music: {
		// Control patterns, tried in order; the first hit wins.
		patterns: [
			{
				action: 'stop',
				pattern:
					'(?:stop|turn\\s+off|shut\\s+off|shut\\s+down|kill|cut|end)\\s+(?:the\\s+)?(?:music|song|track|playback|tunes)(?![\\p{L}])|(?:music|song|playback)\\s+off(?![\\p{L}])',
				flags: 'iu',
			},
			{
				action: 'pause',
				pattern: '(?:pause|hold|freeze)\\s+(?:the\\s+)?(?:music|song|track|playback)(?![\\p{L}])|(?<![\\p{L}])pause(?:\\s+(?:it|this))?[.!?]*\\s*$',
				flags: 'iu',
			},
			{
				action: 'resume',
				pattern:
					'(?:resume|unpause|continue|keep\\s+playing)\\s*(?:the\\s+)?(?:music|song|track|playback)?(?![\\p{L}])|(?:play\\s+(?:it\\s+)?again|carry\\s+on\\s+with\\s+the\\s+(?:music|song)|pick\\s+up\\s+where\\s+(?:it|we)\\s+left\\s+off)',
				flags: 'iu',
			},
			{
				action: 'skip',
				pattern:
					'(?:skip|next)\\s*(?:the\\s+)?(?:song|track|music|one|this)?(?![\\p{L}])|(?:next|another)\\s+(?:song|track|one)(?![\\p{L}])|(?:skip|pass)\\s+(?:it|this)(?![\\p{L}])',
				flags: 'iu',
			},
			{
				action: 'status',
				pattern:
					"(?:what(?:'|’)?s\\s+(?:playing|this\\s+song)|what\\s+is\\s+playing|what\\s+song\\s+is\\s+(?:this|playing)|which\\s+song\\s+is\\s+this|now\\s+playing|current\\s+(?:song|track)|name\\s+of\\s+(?:this|the)\\s+song)",
				flags: 'iu',
			},
		],
		// "set the music volume to 20 percent" — group 1 is the percentage.
		volume_set: {
			pattern: '(?:(?:set|put|turn|make)\\s+)?(?:the\\s+)?(?:music\\s+)?(?:volume|sound)\\s*(?:level\\s*)?(?:to|at)?\\s*(\\d{1,3})(?:\\s*(?:percent|%))?(?![\\p{N}])',
			flags: 'iu',
		},
		// The sentence must be about music at all before a bare number changes the volume.
		volume_requires: { pattern: 'music|song|track|volume|sound', flags: 'iu' },
		volume_down: {
			pattern:
				'(?:turn\\s+(?:it|the\\s+(?:music|volume|sound))\\s+down|turn\\s+down\\s+(?:the\\s+)?(?:music|volume|sound)|lower\\s+(?:the\\s+)?(?:music|volume|sound)|volume\\s+down|(?:make|turn)\\s+it\\s+quieter|(?:a\\s+bit\\s+)?quieter)',
			flags: 'iu',
		},
		volume_up: {
			pattern:
				'(?:turn\\s+(?:it|the\\s+(?:music|volume|sound))\\s+up|turn\\s+up\\s+(?:the\\s+)?(?:music|volume|sound)|raise\\s+(?:the\\s+)?(?:music|volume|sound)|volume\\s+up|crank\\s+it\\s+up|(?:make|turn)\\s+it\\s+louder|(?:a\\s+bit\\s+)?louder)',
			flags: 'iu',
		},
		// A request to play something is never a request to turn the volume up.
		volume_up_exclude: { pattern: '(?:^|\\s)(?:play|queue|put\\s+on|start\\s+playing)\\s', flags: 'iu' },
		// "skip" only skips when a track is being talked about.
		skip_requires: { pattern: 'song|track|music|skip|next', flags: 'iu' },
		// Play requests; group 1 is the query.
		play_patterns: [
			// "play Daft Punk Around the World", "queue up some jazz"
			{
				pattern: '(?:^|\\s)(?:play|queue(?:\\s+up)?|start\\s+playing)\\s+(?:us\\s+|me\\s+)?(.+?)(?:\\s+(?:please|for\\s+(?:us|me)))?[.!?]*\\s*$',
				flags: 'iu',
			},
			// "put on some jazz", "throw on Miles Davis"
			{ pattern: '(?:^|\\s)(?:put|throw)\\s+on\\s+(.+?)[.!?]*\\s*$', flags: 'iu' },
			// "put Smells Like Teen Spirit on" (the sentence ends with "on"; at least two words)
			{ pattern: '(?:^|\\s)(?:put|throw)\\s+(\\S+(?:\\s+\\S+)+?)\\s+on[.!?]*\\s*$', flags: 'iu' },
		],
		// Applied in order to the captured query; each match is removed.
		query_cleanup: [
			{ pattern: '^(?:us|me|for\\s+us|for\\s+me)\\s+', flags: 'iu' },
			{ pattern: '^(?:some\\s+|a\\s+|the\\s+)?(?:song|music|track|tune)s?\\s*[:]?\\s*', flags: 'iu' },
		],
		// Queries that mean "anything"; compared against the normalised query.
		not_a_query: [
			'something', 'something good', 'something nice', 'some music', 'some songs', 'some tunes', 'music', 'song',
			'songs', 'track', 'tracks', 'tunes', 'anything', 'a song', 'a track', 'us', 'me', 'please', 'a good one',
		],

		// ---- The queue and the place in the track. All of these are tried BEFORE the controls and the
		// play requests above: "skip ahead 30 seconds" would otherwise be a skip, "play X next" a skip (the
		// word "next") and "start the song over" a search for "the song over".

		// Numbers written out as words, [word, value]; the patterns below use them for positions and amounts.
		number_words: [...CARDINALS, ...ORDINALS, ...ARTICLES],
		// Units of time as [how the spoken word starts, seconds]: "sec", "second" and "seconds" are one entry.
		time_units: [['sec', 1], ['min', 60]],
		// Repeat modes; the first hit wins, so "stop repeating the song" is read as off before "repeat the song".
		// A repeat is about the song or the queue, and says so: "I keep looping this in my head" and "can you
		// repeat that one more time" are not. The short forms with no song in them ("stop repeating", "loop
		// it", "turn off repeat") count only as the whole sentence.
		loop: [
			{
				mode: 'off',
				pattern: `${ASK}(?:(?:stop|quit|cancel|end)\\s+(?:repeating|looping)|(?:don(?:'|’)?t|do\\s+not)\\s+(?:repeat|loop))\\s+(?:the|this|that)\\s+(?:song|track|queue|playlist)${END}`,
				flags: 'iu',
			},
			{
				mode: 'off',
				pattern: `${LEAD}(?:(?:stop|quit)\\s+(?:repeating|looping)|(?:turn|switch|shut)\\s+(?:off\\s+(?:the\\s+)?(?:repeat|loop)(?:ing)?|(?:the\\s+)?(?:repeat|loop)(?:ing)?\\s+off)|(?:repeat|loop)(?:ing)?\\s+off|no\\s+more\\s+(?:repeat|loop)(?:ing|s)?|disable\\s+(?:the\\s+)?(?:repeat|loop)(?:ing)?|unloop(?:\\s+(?:it|this))?)${END}`,
				flags: 'iu',
			},
			{
				mode: 'queue',
				pattern: `${ASK}(?:(?:repeat|loop)\\s+(?:the\\s+(?:whole\\s+|entire\\s+)?|this\\s+|our\\s+|my\\s+)?${QUEUE_NAME}|put\\s+(?:the\\s+)?${QUEUE_NAME}\\s+on\\s+(?:repeat|loop))${END}`,
				flags: 'iu',
			},
			{ mode: 'queue', pattern: `${LEAD}(?:repeat|loop)\\s+(?:them\\s+)?all${END}`, flags: 'iu' },
			{
				mode: 'track',
				pattern: `${ASK}(?:(?:repeat|loop)\\s+(?:this|the|that)\\s+(?:current\\s+)?(?:song|track)|put\\s+(?:this|the|that)\\s+(?:song|track)\\s+on\\s+(?:repeat|loop)|keep\\s+(?:repeating|looping)\\s+(?:this|the|that)\\s+(?:song|track))${END}`,
				flags: 'iu',
			},
			{
				mode: 'track',
				pattern: `${LEAD}(?:loop\\s+(?:this|it)(?:\\s+one)?|(?:repeat|loop)\\s+this\\s+one|put\\s+(?:it|this(?:\\s+one)?)\\s+on\\s+(?:repeat|loop)|(?:song|track)\\s+on\\s+(?:repeat|loop))${END}`,
				flags: 'iu',
			},
		],
		// "shuffle the queue", "mix up the playlist", or "shuffle" as the whole sentence (after the bot's name,
		// or a name and a comma, or a filler word): "the deck needs a shuffle" is about cards.
		shuffle: {
			pattern: `${ASK}(?:shuffle\\s+(?:up\\s+)?(?:the\\s+|our\\s+|my\\s+|this\\s+)?(?:queue|playlist|songs|tracks|music)|(?:mix\\s+up|randomi[sz]e|scramble)\\s+(?:the\\s+)?(?:queue|playlist|songs|tracks)|(?:turn|put)\\s+(?:on\\s+shuffle|shuffle\\s+on)|shuffle\\s+(?:mode\\s+)?on)${END}|${LEAD}shuffle(?:\\s+up)?${END}`,
			flags: 'iu',
		},
		// "clear the queue" empties what is waiting; the track playing now carries on.
		clear: {
			pattern: `${ASK}(?:(?:clear|empty|wipe|flush)\\s+(?:out\\s+)?(?:the\\s+|our\\s+|my\\s+|this\\s+)?(?:whole\\s+|entire\\s+)?(?:music\\s+)?(?:queue|playlist|up\\s*next)|(?:remove|delete|drop)\\s+(?:everything|all\\s+(?:the\\s+)?(?:songs|tracks))\\s+(?:from|in)\\s+the\\s+${QUEUE_NAME})${END}`,
			flags: 'iu',
		},
		// "move 3 to 1", "move the third song to the top". Named groups: from, to; `place` stands in for a
		// missing "to" (top = 1, end = the last place).
		move: [
			{ pattern: `${MOVE_HEAD}(?:the\\s+)?(?:(?:position|number|spot|place|slot)\\s+)?(?<to>${POS})${ORD}(?:\\s+(?:position|spot|place|slot))?${TAIL}`, flags: 'iu' },
			{ place: 'top', pattern: `${MOVE_HEAD}the\\s+(?:top|front|start|beginning)(?:\\s+of\\s+the\\s+${QUEUE_NAME})?${TAIL}`, flags: 'iu' },
			{ place: 'end', pattern: `${MOVE_HEAD}the\\s+(?:end|bottom|back)(?:\\s+of\\s+the\\s+${QUEUE_NAME})?${TAIL}`, flags: 'iu' },
		],
		// "remove 3 from the queue", "remove song 3", "take the second one out of the queue". Named group: pos.
		// What is taken out has to be a song, or come out of the queue: "ok, take two out" is about anything,
		// and "the list" is anybody's list.
		remove: [
			{
				pattern: `${ASK}(?:remove|delete|drop|take)\\s+(?:(?:song|track|number|the)\\s+)*(?<pos>${POS})${ORD}(?:\\s+(?:song|track|one))?\\s+(?:out\\s+of|from|off)\\s+(?:the\\s+|our\\s+|my\\s+)?${QUEUE_NAME}${END}`,
				flags: 'iu',
			},
			{ pattern: `${ASK}(?:remove|delete|drop)\\s+(?:the\\s+)?(?:song|track)\\s+(?:number\\s+)?(?<pos>${POS})${ORD}${END}`, flags: 'iu' },
			{ pattern: `${ASK}(?:remove|delete|drop|take)\\s+(?:the\\s+)?(?<pos>${POS})${ORD}\\s+(?:song|track)(?:\\s+(?:out|off))?${END}`, flags: 'iu' },
		],
		// Seeking. `dir`: start (back to 0:00), back / forward (a step), to (a place). Named groups: stamp
		// ("1:30"), or n1/u1 and n2/u2 (amount and unit, "1 minute 30 seconds"). Back to the start takes a
		// word that is only ever about playback (rewind, restart) or names the song: "let's go back to the
		// beginning" and "take it from the top" are said about plenty besides music.
		seek: [
			{
				dir: 'start',
				pattern:
					`${ASK}(?:(?:start|play)\\s+(?:the\\s+|this\\s+)?(?:song|track)\\s+(?:over|(?:again\\s+)?from\\s+the\\s+(?:start|beginning|top))|restart\\s+(?:the\\s+|this\\s+)?(?:song|track)|` +
					`(?:rewind|skip\\s+back|jump\\s+back)\\s+(?:it\\s+|the\\s+(?:song|track)\\s+)?to\\s+the\\s+(?:very\\s+)?(?:start|beginning|top)|` +
					`(?:go|skip|jump)\\s+back\\s+to\\s+the\\s+(?:very\\s+)?(?:start|beginning)\\s+of\\s+the\\s+(?:song|track))${TAIL}`,
				flags: 'iu',
			},
			{
				dir: 'back',
				pattern: `(?:${ASK}(?:rewind|skip\\s+back(?:wards?)?|jump\\s+back)|${LEAD}(?:go\\s+back|back\\s+up))\\s+(?:it\\s+|the\\s+(?:song|track)\\s+)?(?:by\\s+)?${SPAN}${TAIL}`,
				flags: 'iu',
			},
			{ dir: 'back', pattern: `${LEAD}(?:go|skip|jump|move)\\s+${SPAN}\\s+back(?:wards?)?${TAIL}`, flags: 'iu' },
			{
				dir: 'forward',
				pattern: `${ASK}(?:(?:skip|jump|go|move|seek)\\s+(?:ahead|forward)|fast\\s*-?\\s*forward|forward|skip)\\s+(?:it\\s+|the\\s+(?:song|track)\\s+)?(?:by\\s+)?${SPAN}${TAIL}`,
				flags: 'iu',
			},
			{ dir: 'forward', pattern: `${LEAD}(?:go|skip|jump|move)\\s+${SPAN}\\s+(?:ahead|forward)${TAIL}`, flags: 'iu' },
			// "Go to 3:30" is a seek only as the whole sentence ("could you go to 3:30?" asks somebody to be
			// somewhere); jump, skip, seek, fast forward and rewind are about playback however they are asked.
			{
				dir: 'to',
				pattern: `(?:${ASK}(?:jump|skip|seek|fast\\s*-?\\s*forward|rewind)|${LEAD}(?:go|move|take\\s+(?:it|me|us)))\\s+(?:back\\s+|ahead\\s+|forward\\s+)?to\\s+(?:the\\s+)?${STAMP}(?:\\s+mark)?${TAIL}`,
				flags: 'iu',
			},
			{
				dir: 'to',
				pattern: `(?:${ASK}(?:jump|skip|seek|fast\\s*-?\\s*forward|rewind)|${LEAD}(?:go|move|take\\s+(?:it|me|us)))\\s+(?:back\\s+|ahead\\s+|forward\\s+)?to\\s+(?:the\\s+)?${SPAN}(?:\\s+mark)?${TAIL}`,
				flags: 'iu',
			},
		],
		// "play X next", "queue up X next", "put X at the front of the queue", "after this, play X". Group 1
		// is the query; it goes through the same cleanup and "means anything" check as a play request.
		play_next: [
			{
				pattern:
					'(?:^|\\s)(?:play|queue(?:\\s+up)?|put\\s+on)\\s+(?:us\\s+|me\\s+)?(.+?)\\s+(?:next|(?:right\\s+)?after\\s+this(?:\\s+(?:one|song|track))?)(?:\\s+(?:please|for\\s+(?:us|me)))?[.!?]*\\s*$',
				flags: 'iu',
			},
			{ pattern: `(?:^|\\s)(?:add|put)\\s+(.+?)\\s+(?:to|at)\\s+the\\s+(?:front|top|start)\\s+of\\s+the\\s+${QUEUE_NAME}${END}`, flags: 'iu' },
			{ pattern: '(?:^|\\s)after\\s+this(?:\\s+(?:one|song|track))?\\s*,?\\s*(?:play|put\\s+on)\\s+(.+?)(?:\\s+please)?[.!?]*\\s*$', flags: 'iu' },
		],
	},
};
