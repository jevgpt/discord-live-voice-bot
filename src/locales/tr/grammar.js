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
// A queue position and the case ending glued to it: "3.", "3'ü", "üçüncüyü", "bire".
const POS = `(?:\\d{1,3}|${alternatives([...CARDINALS, ...ORDINALS])})`;
const POS_END = "(?:\\.|['’]?\\p{L}{0,5})?";
const AMOUNT = `(?:\\d{1,4}|${alternatives(CARDINALS)})`;
// A bare unit steps ("30 saniye ileri sar"); the dative one names a place ("90. saniyeye git").
const UNIT = '(?:saniye|sn|dakika|dk)(?![\\p{L}])';
const UNIT_TO = "(?:saniye|sn['’]?|dakika|dk['’]?)y[ae](?![\\p{L}])";
const SPAN = `(?<n1>${AMOUNT})\\s*(?<u1>${UNIT})(?:\\s*(?<n2>${AMOUNT})\\s*(?<u2>${UNIT}))?`;
const STAMP = '(?<stamp>\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?)';
const VERB_TO = '(?:git|gel|ge[çc]|sar|atla|al)\\p{L}*';
// The end of the sentence: the verb closes a Turkish command, so what follows it is at most "lütfen".
const END = '(?:\\s+l[üu]tfen)?[.!?]*\\s*$';
// "3. şarkıyı", "üçüncü parçayı", "3 numarayı": the noun that may follow a position.
const NOUN = '(?:(?:şark[ıi]|par[çc]a|s[ıi]radaki|numara)\\p{L}*\\s+)?';
const MOVE_HEAD = `(?<![\\p{L}\\p{N}])(?<from>${POS})${POS_END}\\s+${NOUN}`;
const MOVE_VERB = `(?:ta[şs][ıi]|al|koy|getir)\\p{L}*${END}`;

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
		// before "şarkıyı tekrarla" can match, which is also why the track pattern ends at a word boundary.
		loop: [
			{
				mode: 'off',
				pattern:
					'(?<![\\p{L}])(?:(?:tekrar[ıi]|d[öo]ng[üu]y[üu]|tekrarlamay[ıi]|tekrar\\s+modunu)\\s+(?:kapat|kald[ıi]r|durdur|bitir|b[ıi]rak|iptal\\s+et)\\p{L}*|tekrar(?:lama)?\\s+kapal[ıi]|d[öo]ng[üu]den\\s+[çc][ıi]k\\p{L}*|(?:şark[ıi]y[ıi]|par[çc]ay[ıi]|s[ıi]ray[ıi]|listeyi|bunu|art[ıi]k)\\s+tekrarlama(?![\\p{L}])|tekrarlama[.!?]*\\s*$)',
				flags: 'iu',
			},
			{
				mode: 'queue',
				pattern:
					'(?<![\\p{L}])(?:s[ıi]ray[ıi]|listeyi|kuyru[ğg]u|hepsini|t[üu]m[üu]n[üu]|çalma\\s+listesini)\\s+(?:tekrarla(?:sana|r\\s+m[ıi]s[ıi]n)?(?![\\p{L}])|d[öo]ng[üu]ye\\s+al\\p{L}*|tekrara\\s+al\\p{L}*)',
				flags: 'iu',
			},
			// "Bunu tekrarla" on its own is also "say that again", so "bunu" counts only with döngü/tekrara al.
			{
				mode: 'track',
				pattern:
					'(?<![\\p{L}])(?:(?:şark[ıi]y[ıi]|par[çc]ay[ıi])\\s+(?:tekrarla(?:sana|r\\s+m[ıi]s[ıi]n)?(?![\\p{L}])|d[öo]ng[üu]ye\\s+al\\p{L}*|tekrara\\s+al\\p{L}*|tekrar\\s+tekrar\\s+[çc]al\\p{L}*)|bunu\\s+(?:d[öo]ng[üu]ye|tekrara)\\s+al\\p{L}*|(?:şark[ıi]|par[çc]a)\\s+tekrarda\\s+kals[ıi]n)',
				flags: 'iu',
			},
		],
		// "sırayı karıştır", "karışık çal", or "karıştır" on its own (after the bot's name or nothing).
		shuffle: {
			pattern:
				"(?<![\\p{L}])(?:(?:s[ıi]ray[ıi]|listeyi|kuyru[ğg]u|şark[ıi]lar[ıi]|par[çc]alar[ıi]|çalma\\s+listesini|s[ıi]radakileri)\\s+kar[ıi][şs]t[ıi]r\\p{L}*|(?:kar[ıi][şs][ıi]k|rastgele)\\s+(?:s[ıi]rayla\\s+)?[çc]al\\p{L}*|kar[ıi][şs][ıi]k\\s+mod(?:u|a)?\\s+(?:a[çc]|ge[çc])\\p{L}*)|(?:^\\s*(?:(?!(?:bir|kafam[ıi]|ortal[ıi][ğg][ıi])\\s)[\\p{L}\\p{N}'’]+[,.!?]?\\s+)?|[,.!?]\\s*)kar[ıi][şs]t[ıi]r(?:sana|[ıi]r\\s+m[ıi]s[ıi]n)?(?:\\s+l[üu]tfen)?[.!?]*\\s*$",
			flags: 'iu',
		},
		// "sırayı temizle": what is waiting goes, the track playing now carries on.
		clear: {
			pattern:
				'(?<![\\p{L}])(?:(?:s[ıi]ray[ıi]|listeyi|kuyru[ğg]u|s[ıi]radakileri|çalma\\s+listesini)\\s+(?:temizle|bo[şs]alt)\\p{L}*|s[ıi]radakileri\\s+(?:sil|kald[ıi]r)\\p{L}*|s[ıi]radaki\\s+(?:her\\s+şeyi|şark[ıi]lar[ıi]|par[çc]alar[ıi])\\s+(?:sil|temizle|kald[ıi]r)\\p{L}*)',
			flags: 'iu',
		},
		// "3. şarkıyı 1. sıraya al", "3'ü 1'e taşı", "üçüncü şarkıyı başa al". Named groups: from, to;
		// `place` stands in for a missing "to" (top = 1, end = the last place).
		move: [
			{ pattern: `${MOVE_HEAD}(?<to>${POS})${POS_END}\\s+(?:(?:s[ıi]ra|yer|numara)\\p{L}*\\s+)?${MOVE_VERB}`, flags: 'iu' },
			{ place: 'top', pattern: `${MOVE_HEAD}(?:en\\s+)?(?:ba[şs]a|[öo]ne|s[ıi]ran[ıi]n\\s+ba[şs][ıi]na)\\s+${MOVE_VERB}`, flags: 'iu' },
			{ place: 'end', pattern: `${MOVE_HEAD}(?:en\\s+)?(?:sona|sonuna|s[ıi]ran[ıi]n\\s+sonuna)\\s+(?:ta[şs][ıi]|al|koy|at|getir)\\p{L}*${END}`, flags: 'iu' },
		],
		// "3. şarkıyı sıradan çıkar", "sıradan 3'ü sil". Named group: pos.
		remove: [
			{ pattern: `(?<![\\p{L}\\p{N}])(?<pos>${POS})${POS_END}\\s+${NOUN}s[ıi]radan\\s+(?:[çc][ıi]kar|sil|kald[ıi]r|at)\\p{L}*${END}`, flags: 'iu' },
			{ pattern: `(?<![\\p{L}])s[ıi]radan\\s+(?<pos>${POS})${POS_END}\\s+${NOUN}(?:[çc][ıi]kar|sil|kald[ıi]r|at)\\p{L}*${END}`, flags: 'iu' },
		],
		// Seeking. `dir`: start (back to 0:00), back / forward (a step), to (a place). Named groups: stamp
		// ("1:30"), or n1/u1 and n2/u2 (amount and unit, "1 dakika 30 saniye").
		seek: [
			// "Başa al" on its own is left to "X'i en başa al" (play X next) and "3'ü başa al" (move): only
			// "başa sar", or "başa al" about the song itself, goes back to the start.
			{
				dir: 'start',
				pattern: `(?<![\\p{L}])(?:(?:şark[ıi]y[ıi]|par[çc]ay[ıi]|m[üu]zi[ğg]i|bunu)\\s+(?:en\\s+)?ba[şs]a\\s+al|(?:en\\s+)?ba[şs]a\\s+sar|ba[şs]tan\\s+(?:ba[şs]lat|[çc]al)|(?:şark[ıi]n[ıi]n|par[çc]an[ıi]n)\\s+(?:en\\s+)?ba[şs][ıi]na\\s+(?:d[öo]n|git|sar))\\p{L}*${END}`,
				flags: 'iu',
			},
			{ dir: 'back', pattern: `(?<![\\p{L}\\p{N}])${SPAN}\\s+geri(?:ye)?\\s+(?:sar|al|git|gel|d[öo]n)\\p{L}*${END}`, flags: 'iu' },
			{ dir: 'forward', pattern: `(?<![\\p{L}\\p{N}])${SPAN}\\s+(?:ileri(?:ye)?\\s+(?:sar|al|git|atla|ge[çc])|atla)\\p{L}*${END}`, flags: 'iu' },
			{ dir: 'to', pattern: `(?<![\\p{L}\\p{N}])${STAMP}(?:['’]?\\s*(?:y?[ae]|[ıi]?n[ae]))?\\s+${VERB_TO}${END}`, flags: 'iu' },
			{
				dir: 'to',
				pattern: `(?<![\\p{L}\\p{N}])(?<n1>${AMOUNT})\\s*(?<u1>dakika|dk)\\s+(?<n2>${AMOUNT})\\.?\\s*(?<u2>${UNIT_TO})\\s+${VERB_TO}${END}`,
				flags: 'iu',
			},
			{ dir: 'to', pattern: `(?<![\\p{L}\\p{N}])(?<n1>${AMOUNT})\\.?\\s*(?<u1>${UNIT_TO})\\s+${VERB_TO}${END}`, flags: 'iu' },
		],
		// "bundan sonra X çal", "sıradaki şarkı X olsun", "X'i sıranın başına ekle". Group 1 is the query; it
		// goes through the same cleanup and "means anything" check as a play request.
		play_next: [
			{
				pattern:
					'(?:^|\\s)bundan\\s+sonra\\s+(?:bana\\s+|bize\\s+)?(.+?)(?:\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi]|şark[ıi]s[ıi]|par[çc]as[ıi]))?\\s+(?:çal|a[çc]|koy|oynat)(?:sana|sene|ar\\s+m[ıi]s[ıi]n|abilir\\s+misin)?[.!?]*\\s*$',
				flags: 'iu',
			},
			{ pattern: '(?:^|\\s)(?:s[ıi]radaki|sonraki)\\s+(?:şark[ıi]|par[çc]a)\\s+(.+?)\\s+olsun[.!?]*\\s*$', flags: 'iu' },
			{
				pattern:
					"(?:^|\\s)(?:bana\\s+|bize\\s+)?(.+?)(?:['’]\\p{L}{1,3})?(?:\\s+(?:şark[ıi]s[ıi]n[ıi]|par[çc]as[ıi]n[ıi]))?\\s+(?:s[ıi]ran[ıi]n\\s+ba[şs][ıi]na|en\\s+ba[şs]a|araya)\\s+(?:ekle|al|koy|sok)\\p{L}*[.!?]*\\s*$",
				flags: 'iu',
			},
		],
	},
};
