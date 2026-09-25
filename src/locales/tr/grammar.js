// grammar strings (tr). Keys are referenced as "grammar.<key>" through src/i18n.
//
// This namespace holds the voice-command grammar: the patterns src/commands.js turns into matchers
// when it parses what was said in the voice channel. Every pattern is a plain RegExp source string
// plus its flags, so a language can be added without touching the parser. The patterns must be
// written in THIS locale's language -- they are matched against real speech, not translated.
//
// Turkish marks the target with case suffixes AFTER the word ("genel kanalına ... yaz"), which is
// why the channel name comes first and the verb last in nearly every pattern here.

// Numbers the transcript may write out as words, for the queue and seek commands under music below: a
// place in the queue ("üçüncü şarkıyı başa al") and an amount of time ("otuz saniye ileri sar").
const CARDINALS = [
	['bir', 1], ['iki', 2], ['üç', 3], ['dört', 4], ['beş', 5], ['altı', 6], ['yedi', 7], ['sekiz', 8], ['dokuz', 9],
	['on', 10], ['on beş', 15], ['yirmi', 20], ['otuz', 30], ['kırk', 40], ['kırk beş', 45], ['elli', 50], ['altmış', 60],
	['doksan', 90],
];
const ORDINALS = [
	['birinci', 1], ['ikinci', 2], ['üçüncü', 3], ['dördüncü', 4], ['beşinci', 5], ['altıncı', 6], ['yedinci', 7],
	['sekizinci', 8], ['dokuzuncu', 9], ['onuncu', 10],
];
// Speech-to-text drops the Turkish letters often enough that "uc" has to find "üç" as well.
const FOLD = { ç: '[çc]', ğ: '[ğg]', ı: '[ıi]', ö: '[öo]', ş: '[şs]', ü: '[üu]' };
const tolerant = (word) => word.replace(/[çğıöşü]/gu, (ch) => FOLD[ch]).replace(/ /gu, '\\s+');
// Longest first, so "on beş" is not read as "on" and "birinci" not as "bir".
const alternatives = (pairs) =>
	pairs
		.map(([word]) => word)
		.sort((a, b) => b.length - a.length)
		.map(tolerant)
		.join('|');
// A queue position: the number, and what makes it a place in the queue, which is never a bare case ending
// on a word. "Onu" (him, it) is "on" (ten) with an accusative glued on, and "onu sıradan çıkar" removed
// track 10; "bire" is anybody's "to one". So a position is a digit with its full stop or its apostrophe
// ("3.", "3'ü", "1'e"), an ordinal with whatever ending it carries ("üçüncü", "üçüncüyü"), or either kind
// of number before "numara" ("3 numaralı", "üç numarayı"). The lookbehinds tell which kind was matched.
const POS = `(?:\\d{1,3}|${alternatives([...CARDINALS, ...ORDINALS])})`;
const POS_END = "(?:(?<=\\d)(?:\\.|['’]\\p{L}{1,4})|(?<=nc[ıiuü])\\p{L}{0,5}|\\s+numara(?:l[ıi])?\\p{L}*)";
const AMOUNT = `(?:\\d{1,4}|${alternatives(CARDINALS)})`;
// A bare unit steps ("30 saniye ileri sar"); the dative one names a place ("90. saniyeye git").
const UNIT = '(?:saniye|sn|dakika|dk)(?![\\p{L}])';
const UNIT_TO = "(?:saniye|sn['’]?|dakika|dk['’]?)y[ae](?![\\p{L}])";
const SPAN = `(?<n1>${AMOUNT})\\s*(?<u1>${UNIT})(?:\\s*(?<n2>${AMOUNT})\\s*(?<u2>${UNIT}))?`;
const STAMP = '(?<stamp>\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?)';
// A verb said as a request: the imperative ("sar", "sarsana", "sarın") or a question put to the bot
// ("sarar mısın", "sarabilir misin"). Never a statement: "on dakikaya gelirim" (I will be there in ten
// minutes) and "30 saniye geri sardım" (I rewound it) are somebody talking, and they were seeks.
const asked = (stem) => `${stem}(?:s[ae]n[ae]|y?[ıiuü]n(?:[ıiuü]z)?|\\p{L}{0,7}\\s*m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?)?(?![\\p{L}])`;
// Going to a place in the track. "Gel" (come) is not among them: "saat 9.30'a gel" is an invitation.
const VERB_TO = `(?:${asked('gi[td]')}|${asked('ge[çc]')}|${asked('sar')}|${asked('atla')}|${asked('al')})`;
// The end of the sentence: the verb closes a Turkish command, so what follows it is at most "lütfen".
const END = '(?:\\s+l[üu]tfen)?[.!?]*\\s*$';
// ... and where one may begin. These commands run with no wake word, straight off what was heard, so they
// have to BE the sentence: "akşam 8.30'a gelirim" and "saat 9.30'a gel" are about an evening, not a song.
// In front of the command there may be a name and a comma ("Melis, karıştır") and a word such as "lütfen"
// or "hadi"; the bot's own names are taken off in src/commands.js, with a comma or without.
const LEAD = "^\\s*(?:[\\p{L}\\p{N}'’]+,\\s*)?(?:(?:l[üu]tfen|hadi|haydi|şimdi|hemen),?\\s+)*";
// The song, named as what the command is about: "şarkıyı 1:30'a al", "bu parçayı döngüye al".
const SONG = '(?:(?:bu|şu)\\s+)?(?:şark[ıi]y[ıi]|par[çc]ay[ıi]|m[üu]zi[ğg]i)\\s+';
// "3. şarkıyı", "üçüncü parçayı", "3 numarayı": the noun that may follow a position.
const NOUN = '(?:(?:şark[ıi]|par[çc]a|s[ıi]radaki|numara)\\p{L}*\\s+)?';
const MOVE_HEAD = `${LEAD}(?<from>${POS})${POS_END}\\s+${NOUN}`;
const MOVE_VERB = `(?:${asked('ta[şs][ıi]')}|${asked('al')}|${asked('koy')}|${asked('getir')})${END}`;
const REMOVE_VERB = `(?:${asked('[çc][ıi]kar')}|${asked('sil')}|${asked('kald[ıi]r')}|${asked('at')})${END}`;

export default {
	// Dictation particles: "write X in general" leaves a trailing quoting particle that must not
	// become part of the message. Source string for a case-insensitive unicode RegExp.
	dictation_tail: '\\s+(?:de|da|diye|diyorum|diyor|dedim)(?:\\s+(?:yaz|söyle))?[.!?,]*$',
	// Speech-to-text loses Turkish diacritics, so a normalised channel name is expanded into a
	// tolerant pattern: "genel sohbet" -> /g[eé]n[eé]l[\s_-]+s[oö]hb[eé]t/. Letters that are not
	// listed are matched literally.
	letter_classes: {
		a: '[aá]',
		c: '[cç]',
		e: '[eé]',
		g: '[gğ]',
		i: '[iıİ]',
		o: '[oö]',
		s: '[sş]',
		u: '[uü]',
	},

	// "<ad> karakterine geç" / "... geçer misin" / "... geçebilir misin". Capture group 1 is the
	// character name. Note: \b is unreliable around Turkish letters (ç, ı...), so a non-letter
	// lookahead is used instead. The first matching pattern wins.
	character_switch: [
		{
			pattern: '([\\p{L}\\p{N}_\\- ]{1,40}?)\\s+karakter(?:ine|[ıi]ne|i|e|im)?\\s+ge[çc](?:er|ebilir)?(?![\\p{L}])',
			flags: 'iu',
		},
	],

	// "kanaldan ayrıl"
	leave: { pattern: 'kanaldan\\s+ayr[ıi]l', flags: 'iu' },

	// "sus", "sessiz ol", "kes sesini"; geri dönüş "konuşabilirsin". Susmak modelin değil uygulamanın
	// tuttuğu bir durum, bu yüzden kelimeler burada: model hiç devreye girmeden çalışsın. "susma",
	// "susam" ve "susadım" eşleşmez; "sus" tek başına ya da kendi çekimleriyle aranır.
	quiet: {
		on: {
			pattern:
				'(?<![\\p{L}])(?:sus(?:unuz|un|s[ae]n[ae]|ar\\s+m[ıi]s[ıi]n)?|sessiz\\s+ol(?:un|unuz)?|sessizlik|kes\\s+ses[iı]n[iı]|ses[iı]n[iı]\\s+kes|kapa\\s+çenen[iı]|çenen[iı]\\s+kapa|(?:quiet(?:\\s+ayar[ıi]n[ıi])?|sessiz\\s+mod(?:u|a)?)\\s+(?:a[çc]\\p{L}*|ge[çc]\\p{L}*)|quiet\\s+on)(?![\\p{L}])',
			flags: 'iu',
		},
		off: {
			pattern: '(?<![\\p{L}])(?:konu[şs](?:ab[iı]l[iı]r\\p{L}*|maya\\s+devam(?:\\s+et\\p{L}*)?)|devam\\s+edeb[iı]l[iı]r\\p{L}*|konu[şs]ma\\s+yasa[ğg][ıi]n[ıi]\\s+kald[ıi]r\\p{L}*|(?:sessizli[ğg]i|sessizlik\\s+ayar[ıi]n[ıi]|quiet(?:\\s+ayar[ıi]n[ıi])?|sessiz\\s+modu?)\\s+(?:kald[ıi]r\\p{L}*|kapat\\p{L}*|bitir\\p{L}*)|quiet\\s+off|ses[iı]n[iı]\\s+a[çc]\\p{L}*|sus(?:ma)?y[ıi]\\s+b[ıi]rak\\p{L}*)(?![\\p{L}])',
			flags: 'iu',
		},
		// The bare word alone, which the transcript can hand over out of "konuşma" (do not talk): it gives the
		// voice back only next to the bot's name ("Melis konuş"). Heard live: "artık konuşma" arrived as
		// "Artık konuş" and the bot, told to be quiet six seconds earlier, spoke again.
		off_named: {
			pattern: '(?<![\\p{L}])konu[şs](?:un|sana)?(?![\\p{L}])',
			flags: 'iu',
		},
	},

	// What may follow a channel name: the word "kanal" with any suffix, or the case suffix on its
	// own ("genel sohbete merhaba yaz").
	channel_suffix: {
		pattern: "^\\s*(?:kanal[a-zçğıöşü]*|['’]?(?:nin|nın|ne|na|de|da|te|ta|ye|ya|in|ın|e|a)(?=\\s|$))",
		flags: 'i',
	},

	// Filler words stripped from the front of a dictated message or a music query.
	fillers: { pattern: '^(?:bir|şöyle|ki|lütfen|hadi|hemen|şimdi|acaba|bana|bize|şu|bu|o)\\s+', flags: 'iu' },

	// "mesaj(ı)" in front of the dictated text is part of the command, not of the message.
	message_prefix: { pattern: '^(?:mesaj[ıi]?|mesajı)\\s*', flags: 'i' },

	// Filler words stripped from the front of a spoken channel name.
	channel_name_fillers: {
		pattern: '^(?:bu|şu|o|bir|sesli|metin|lütfen|hadi|hemen|şimdi|acaba|bana|bize)\\s+',
		flags: 'iu',
	},

	// Words that are too generic to be a channel name (compared against the normalised name).
	generic_channel_words: ['sesli', 'kanal', 'kanala', 'kanalina', 'metin', 'sohbet', 'bu', 'su'],

	send: {
		// Left boundary: the "at" inside "saat" and the "yaz" inside "beyaz" are not verbs.
		verb: { pattern: '(?<![\\p{L}])(?:yaz|g[öo]nder|at)(?:ar|er|abilir|abilirsen|sana|sene)?(?![\\p{L}])', flags: 'iu' },
		// Turkish puts the message in front of the verb and the channel first, so there is never a
		// message to pick up BEFORE the channel name, and nothing sits in front of that name either.
		body_before_channel: false,
		channel_lead: null,
		// Channel name is not in the list: pull it out of the "<ad> kanalına ..." shape and match it
		// loosely afterwards. Group 1 is the name, group 2 the rest of the sentence.
		legacy: { pattern: '([\\p{L}\\p{N}_\\- ]{1,40}?)\\s*kanal[a-zçğıöşü]*\\s*(.+)$', flags: 'iu', name: 1, body: 2 },
		// No name at all: "kanala mesaj gönder: ..." (the default channel is used).
		bare: { pattern: 'kanal[a-zçğıöşü]*\\s*(?:bir\\s+)?(?:mesaj[ıi]?\\s*)?', flags: 'i' },
	},

	read: {
		// A real request to read, not "okul/okyanus/okuma".
		hint: {
			pattern:
				'(?:ne\\s+yaz[ıi]yor\\w*|neler\\s+yaz[ıi]yor\\w*|(?<![\\p{L}])oku(?:r|yor|yabilir|sana|sene|yun|yal[ıi]m|)(?![\\p{L}])|son\\s+mesajlar?|son\\s+yaz[ıi]lanlar?)',
			flags: 'iu',
		},
		// The sentence must be about a channel or about messages.
		requires: { pattern: 'kanal|mesaj', flags: 'i' },
		// Channel name is not in the list. Group 1 is the name.
		legacy: { pattern: '([\\p{L}\\p{N}_\\- ]{1,40}?)\\s*kanal[a-zçğıöşü]*', flags: 'iu' },
	},

	join: {
		// Imperative and polite forms: katıl, katılsana, gir, gel, gelsene, geç, geçer misin,
		// gelebilir misin. Words like "gece", "gelin", "gelecek", "geçmiş" do not fit the
		// stem + allowed-suffix list, so they do not match. Tested against single normalised words.
		verb: { pattern: '^(?:katil|gir|gel|gec)(?:sene|sen|in|iniz|ebilir|abilir|er|ir|elim|eyim|meni|sin|iver|iversene|)$', flags: 'u' },
		// A channel/room word or a known voice channel name has to be there; otherwise "gel/gir"
		// fires on the wrong sentences.
		place: { pattern: '(?<![\\p{L}])(?:kanal|oda|sesli|ses)', flags: 'iu' },
		// Channel name is not in the list. Group 1 is the name.
		legacy: {
			pattern: '([\\p{L}\\p{N}_\\- ]{1,40}?)\\s*(?:isminde\\s+)?(?:sesli\\s+)?(?:kanal|oda)[a-zçğıöşü]*',
			flags: 'iu',
		},
	},

	music: {
		// Control patterns, tried in order; the first hit wins.
		patterns: [
			{
				action: 'stop',
				pattern:
					'(?:m[üu]zi[ğg]i|m[üu]zik|şark[ıi]y[ıi]|şark[ıi]|par[çc]ay[ıi]|par[çc]a)(?:n[ıi])?\\s+(?:durdur|kapat|kes|sustur|bitir)',
				flags: 'iu',
			},
			{
				action: 'pause',
				pattern:
					'(?:m[üu]zi[ğg]i|m[üu]zik|şark[ıi]y[ıi]|şark[ıi]|par[çc]ay[ıi]|par[çc]a)(?:n[ıi])?\\s+(?:duraklat|beklet|dondur)',
				flags: 'iu',
			},
			{
				action: 'resume',
				pattern:
					'(?:m[üu]zi[ğg]e|şark[ıi]ya|m[üu]zi[ğg]i|şark[ıi]y[ıi])\\s+(?:devam|s[üu]rd[üu]r)|(?:kald[ıi][ğg][ıi]\\s+yerden\\s+devam)',
				flags: 'iu',
			},
			{
				action: 'skip',
				pattern:
					'(?:şark[ıi]y[ıi]|par[çc]ay[ıi]|m[üu]zi[ğg]i|bunu)\\s+(?:atla|ge[çc](?:sene|sen|)(?![\\p{L}]))|(?:bir\\s+)?sonraki(?:ne|si)?\\s*(?:şark[ıi]|par[çc]a)?(?:ya|ye)?\\s*(?:ge[çc]|atla)?',
				flags: 'iu',
			},
			{
				action: 'status',
				pattern: '(?:ne\\s+çal[ıi]yor|hangi\\s+şark[ıi]|şark[ıi]n[ıi]n\\s+ad[ıi]\\s+ne|bu\\s+şark[ıi]\\s+ne|çalan\\s+şark[ıi])',
				flags: 'iu',
			},
		],
		// "müziğin sesini yüzde 20 yap" — group 1 is the percentage.
		volume_set: {
			pattern: '(?:m[üu]zi[ğg]in?\\s+)?sesi(?:ni)?\\s+(?:y[üu]zde\\s*)?(\\d{1,3})(?:\\s*(?:yap|olsun|e\\s+(?:al|getir|çek)|a\\s+(?:al|getir|çek)))?',
			flags: 'iu',
		},
		// The sentence must be about music at all before a bare number changes the volume.
		volume_requires: { pattern: 'm[üu]zi|şark|par[çc]a|ses', flags: 'iu' },
		volume_down: { pattern: 'm[üu]zi[ğg]i(?:n\\s+sesini)?\\s+(?:biraz\\s+)?(?:k[ıi]s|azalt|al[çc]alt|d[üu]ş[üu]r)', flags: 'iu' },
		volume_up: {
			pattern: 'm[üu]zi[ğg]i(?:n\\s+sesini)?\\s+(?:biraz\\s+)?(?:a[çc](?![\\p{L}])|y[üu]kselt|art[ıi]r|a[çc]sana)',
			flags: 'iu',
		},
		// "müzik aç: ..." means play, not louder.
		volume_up_exclude: { pattern: '(?:^|\\s)(?:bir\\s+)?(?:şark[ıi]|m[üu]zik|par[çc]a)\\s+a[çc][:\\s]', flags: 'iu' },
		// "atla" only skips when a track is being talked about.
		skip_requires: { pattern: 'şark|par[çc]a|m[üu]zi|sonraki', flags: 'iu' },
		// Play requests; group 1 is the query.
		play_patterns: [
			// "Tarkan Şımarık şarkısını çal", "Sezen Aksu'dan bir parça aç"
			{
				pattern:
					'(?:^|\\s)(?:bana\\s+|bize\\s+)?(.+?)\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi]|m[üu]zi[ğg]ini|şark[ıi]s[ıi]|par[çc]as[ıi]|şark[ıi]y[ıi]|par[çc]ay[ıi])\\s+(?:çal|a[çc]|oynat|başlat|koy|aç)(?:sana|sene|ar\\s+m[ıi]s[ıi]n|abilir\\s+misin)?(?![\\p{L}])',
				flags: 'iu',
			},
			// "şarkı çal: sezen aksu", "müzik aç sezen aksu gülümse", "bir şarkı koy: ..."
			{
				pattern: '(?:^|\\s)(?:bir\\s+)?(?:şark[ıi]|m[üu]zik|par[çc]a)\\s+(?:çal|a[çc]|oynat|koy|başlat)(?:sana|sene)?[:\\s]+(.+)$',
				flags: 'iu',
			},
			// "sezen aksu gülümse çal" (the sentence ends with "çal"; at least two words)
			{
				pattern: '(?:^|\\s)(?:bana\\s+|bize\\s+)?(\\S+(?:\\s+\\S+)+?)\\s+(?:çal|oynat)(?:sana|sene|ar\\s+m[ıi]s[ıi]n|abilir\\s+misin)?[.!?]*\\s*$',
				flags: 'iu',
			},
		],
		// Applied in order to the captured query; each match is removed.
		query_cleanup: [
			{ pattern: '^(?:bana|bize)\\s+', flags: 'iu' },
			{ pattern: '^(?:bir\\s+)?(?:şark[ıi]|m[üu]zik|par[çc]a)\\s*[:]?\\s*', flags: 'iu' },
		],
		// Queries that mean "anything"; compared against the normalised query.
		not_a_query: [
			'bir sey', 'bir seyler', 'sey', 'seyler', 'bisey', 'biseyler', 'muzik', 'sarki', 'parca', 'bana', 'bize',
			'hadi', 'lutfen', 'guzel bir sey', 'bir muzik', 'bir sarki',
		],

		// ---- The queue and the place in the track. All of these are tried BEFORE the controls and the
		// play requests above: "sonraki şarkı X olsun" would otherwise be a skip, and "bundan sonra X çal" a
		// search for "bundan sonra X".

		// Numbers written out as words, [word, value]; the patterns below use them for positions and amounts.
		number_words: [...CARDINALS, ...ORDINALS],
		// Units of time as [how the spoken word starts, seconds]: "saniye" also finds "saniyeye".
		time_units: [['saniye', 1], ['sn', 1], ['dakika', 60], ['dk', 60]],
		// Repeat modes; the first hit wins. "Şarkıyı tekrarlama" (do not repeat the song) must be read as off
		// before "şarkıyı tekrarla" can match, which is also why every verb ends at a word boundary. A repeat
		// names what it is about -- the song, the queue, or the repeat itself -- and "bunu" does not count:
		// "bunu tekrarla" is also "say that again", and "bir daha tekrarlama" is "do not do that again".
		loop: [
			{
				mode: 'off',
				pattern:
					`${LEAD}(?:(?:tekrar[ıi]|d[öo]ng[üu]y[üu]|tekrarlamay[ıi]|tekrar\\s+modunu)\\s+(?:${asked('kapat')}|${asked('kald[ıi]r')}|${asked('durdur')}|${asked('bitir')}|${asked('b[ıi]rak')}|iptal\\s+${asked('e[td]')})|` +
					`tekrar(?:lama)?\\s+kapal[ıi]|(?:${SONG}|(?:s[ıi]ray[ıi]|listeyi)\\s+)(?:tekrarlama(?![\\p{L}])|d[öo]ng[üu]den\\s+${asked('[çc][ıi]kar')}))${END}`,
				flags: 'iu',
			},
			{
				mode: 'queue',
				pattern: `${LEAD}(?:s[ıi]ray[ıi]|listeyi|kuyru[ğg]u|çalma\\s+listesini)\\s+(?:${asked('tekrarla')}|(?:d[öo]ng[üu]ye|tekrara)\\s+${asked('al')})${END}`,
				flags: 'iu',
			},
			{
				mode: 'track',
				pattern: `${LEAD}(?:${SONG}(?:${asked('tekrarla')}|(?:d[öo]ng[üu]ye|tekrara)\\s+${asked('al')}|tekrar\\s+tekrar\\s+${asked('[çc]al')})|(?:(?:bu|şu)\\s+)?(?:şark[ıi]|par[çc]a)\\s+tekrarda\\s+kals[ıi]n)${END}`,
				flags: 'iu',
			},
		],
		// "sırayı karıştır", "karışık çal", or "karıştır" as the whole sentence, after the bot's name or a name
		// and a comma at most: "hadi karıştır" (come on, stir it) and "kafamı karıştır" are not about music.
		shuffle: {
			pattern:
				`${LEAD}(?:(?:s[ıi]ray[ıi]|listeyi|kuyru[ğg]u|şark[ıi]lar[ıi]|par[çc]alar[ıi]|çalma\\s+listesini|s[ıi]radakileri)\\s+${asked('kar[ıi][şs]t[ıi]r')}|(?:kar[ıi][şs][ıi]k|rastgele)\\s+(?:s[ıi]rayla\\s+)?${asked('[çc]al')}|kar[ıi][şs][ıi]k\\s+mod(?:u|a)?\\s+(?:${asked('a[çc]')}|${asked('ge[çc]')}))${END}|` +
				`^\\s*(?:(?!(?:hadi|haydi|hade|bir|kafam[ıi]|ortal[ıi][ğg][ıi])[,.!?\\s])[\\p{L}\\p{N}'’]+,\\s*)?${asked('kar[ıi][şs]t[ıi]r')}${END}`,
			flags: 'iu',
		},
		// "sırayı temizle": what is waiting goes, the track playing now carries on.
		clear: {
			pattern:
				`${LEAD}(?:(?:s[ıi]ray[ıi]|listeyi|kuyru[ğg]u|s[ıi]radakileri|çalma\\s+listesini)\\s+(?:${asked('temizle')}|${asked('bo[şs]alt')})|s[ıi]radakileri\\s+(?:${asked('sil')}|${asked('kald[ıi]r')})|` +
				`s[ıi]radaki\\s+(?:her\\s+şeyi|şark[ıi]lar[ıi]|par[çc]alar[ıi])\\s+(?:${asked('sil')}|${asked('temizle')}|${asked('kald[ıi]r')}))${END}`,
			flags: 'iu',
		},
		// "3. şarkıyı 1. sıraya al", "3'ü 1'e taşı", "üçüncü şarkıyı başa al". Named groups: from, to;
		// `place` stands in for a missing "to" (top = 1, end = the last place). "Onu en başa al" is "put him
		// (it) first": "onu" is no position (see POS_END).
		move: [
			{ pattern: `${MOVE_HEAD}(?<to>${POS})${POS_END}\\s+(?:(?:s[ıi]ra|yer|numara)\\p{L}*\\s+)?${MOVE_VERB}`, flags: 'iu' },
			{ place: 'top', pattern: `${MOVE_HEAD}(?:en\\s+)?(?:ba[şs]a|[öo]ne|s[ıi]ran[ıi]n\\s+ba[şs][ıi]na)\\s+${MOVE_VERB}`, flags: 'iu' },
			{
				place: 'end',
				pattern: `${MOVE_HEAD}(?:en\\s+)?(?:sona|sonuna|s[ıi]ran[ıi]n\\s+sonuna)\\s+(?:${asked('ta[şs][ıi]')}|${asked('al')}|${asked('koy')}|${asked('at')}|${asked('getir')})${END}`,
				flags: 'iu',
			},
		],
		// "3. şarkıyı sıradan çıkar", "sıradan 3'ü sil". Named group: pos.
		remove: [
			{ pattern: `${LEAD}(?<pos>${POS})${POS_END}\\s+${NOUN}s[ıi]radan\\s+${REMOVE_VERB}`, flags: 'iu' },
			{ pattern: `${LEAD}s[ıi]radan\\s+(?<pos>${POS})${POS_END}\\s+${NOUN}${REMOVE_VERB}`, flags: 'iu' },
		],
		// Seeking. `dir`: start (back to 0:00), back / forward (a step), to (a place). Named groups: stamp
		// ("1:30"), or n1/u1 and n2/u2 (amount and unit, "1 dakika 30 saniye"). A step says which way
		// (ileri, geri) or jumps (atla); a place is a time with a verb of going there, at the start of the
		// sentence (LEAD, VERB_TO).
		seek: [
			// "Başa al" on its own is left to "X'i en başa al" (play X next) and "3'ü başa al" (move): only
			// "başa sar", or going back to the start of the song named as such, goes back to the start.
			{
				dir: 'start',
				pattern:
					`${LEAD}(?:${SONG}(?:en\\s+)?ba[şs]a\\s+(?:${asked('al')}|${asked('sar')}|${asked('d[öo]n')})|(?:en\\s+)?ba[şs]a\\s+${asked('sar')}|(?:${SONG})?ba[şs]tan\\s+${asked('[çc]al')}|${SONG}ba[şs]tan\\s+${asked('ba[şs]lat')}|` +
					`(?:şark[ıi]n[ıi]n|par[çc]an[ıi]n)\\s+(?:en\\s+)?ba[şs][ıi]na\\s+(?:${asked('d[öo]n')}|${asked('gi[td]')}|${asked('sar')}))${END}`,
				flags: 'iu',
			},
			{
				dir: 'back',
				pattern: `${LEAD}(?:${SONG})?${SPAN}\\s+geri(?:ye)?\\s+(?:${asked('sar')}|${asked('al')}|${asked('gi[td]')}|${asked('d[öo]n')})${END}`,
				flags: 'iu',
			},
			{
				dir: 'forward',
				pattern: `${LEAD}(?:${SONG})?${SPAN}\\s+(?:ileri(?:ye)?\\s+(?:${asked('sar')}|${asked('al')}|${asked('gi[td]')}|${asked('atla')}|${asked('ge[çc]')})|${asked('atla')})${END}`,
				flags: 'iu',
			},
			{ dir: 'to', pattern: `${LEAD}(?:${SONG})?${STAMP}(?:['’]?\\s*(?:y?[ae]|[ıi]?n[ae]))?\\s+${VERB_TO}${END}`, flags: 'iu' },
			{
				dir: 'to',
				pattern: `${LEAD}(?:${SONG})?(?<n1>${AMOUNT})\\s*(?<u1>dakika|dk)\\s+(?<n2>${AMOUNT})\\.?\\s*(?<u2>${UNIT_TO})\\s+${VERB_TO}${END}`,
				flags: 'iu',
			},
			{ dir: 'to', pattern: `${LEAD}(?:${SONG})?(?<n1>${AMOUNT})\\.?\\s*(?<u1>${UNIT_TO})\\s+${VERB_TO}${END}`, flags: 'iu' },
		],
		// "bundan sonra X çal", "sıradaki şarkı X olsun", "X'i sıranın başına ekle". Group 1 is the query; it
		// goes through the same cleanup and "means anything" check as a play request. The request has to be
		// about music: "çal" and "oynat" are, "aç" and "koy" only with the song named ("bundan sonra kapıyı
		// aç" is about a door), and a place in the queue is either the queue's ("sıranın başına") or the
		// song's ("X şarkısını araya koy"): "çayı araya koy" is about tea.
		play_next: [
			{
				pattern:
					'(?:^|\\s)bundan\\s+sonra\\s+(?:bana\\s+|bize\\s+)?(.+?)(?:\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi]|şark[ıi]s[ıi]|par[çc]as[ıi]))?\\s+(?:çal|oynat)(?:sana|sene|ar\\s+m[ıi]s[ıi]n|abilir\\s+misin)?[.!?]*\\s*$',
				flags: 'iu',
			},
			{
				pattern:
					'(?:^|\\s)bundan\\s+sonra\\s+(?:bana\\s+|bize\\s+)?(.+?)\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi]|şark[ıi]s[ıi]|par[çc]as[ıi])\\s+(?:a[çc]|koy)(?:sana|sene|ar\\s+m[ıi]s[ıi]n|abilir\\s+misin)?[.!?]*\\s*$',
				flags: 'iu',
			},
			{ pattern: '(?:^|\\s)(?:s[ıi]radaki|sonraki)\\s+(?:şark[ıi]|par[çc]a)\\s+(.+?)\\s+olsun[.!?]*\\s*$', flags: 'iu' },
			{
				pattern: `(?:^|\\s)(?:bana\\s+|bize\\s+)?(.+?)(?:['’]\\p{L}{1,3})?(?:\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi]))?\\s+s[ıi]ran[ıi]n\\s+ba[şs][ıi]na\\s+(?:${asked('ekle')}|${asked('al')}|${asked('koy')}|${asked('sok')})[.!?]*\\s*$`,
				flags: 'iu',
			},
			{
				pattern: `(?:^|\\s)(?:bana\\s+|bize\\s+)?(.+?)\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi])\\s+(?:en\\s+ba[şs]a|araya)\\s+(?:${asked('ekle')}|${asked('al')}|${asked('koy')}|${asked('sok')})[.!?]*\\s*$`,
				flags: 'iu',
			},
		],
	},
};
