// speech strings (tr). Keys are referenced as "speech.<key>" through src/i18n.
//
// This namespace holds what src/speechtext.js needs to turn written text into the words a speech
// synthesiser should say: number words, units, currencies, abbreviations and the few fixed words that
// stand in for things nobody reads aloud (a link, a block of code). A model's reply is written for the
// eye -- "%20", "14:45", "3'te", "vb." -- and a voice left to guess at that improvises; the Turkish
// engine cuts off a number left as digits altogether.
//
// The table is read in the language of the SENTENCE, not in BOT_LANGUAGE. The words are real Turkish,
// not translations of the English table; the two only share their shape.
//
// Turkish says 100 and 1000 without "bir" (yüz, bin) but not a million (bir milyon), writes a number's
// case ending after an apostrophe ("3'te", "2026'da") and glues it on when it is said ("üçte"): the
// endings are re-fitted to the spoken word in src/speechtext.js, which is why only "dört" needs a
// table here (it softens to "dörd-" before a vowel: "4'e" is "dörde").
export default {
	// How a number is written: "1.250.000,50".
	number_format: { thousands: '.', decimal: ',' },
	ones: ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'],
	tens: ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'],
	hundred: 'yüz',
	// One word per group of three digits, the ones first.
	scales: ['', 'bin', 'milyon', 'milyar', 'trilyon', 'katrilyon', 'kentilyon'],
	// Said without "bir" in front: 100 is "yüz", 1000 is "bin", 1.000.000 is still "bir milyon".
	silent_one: ['yüz', 'bin'],
	// "yirmi bir"
	tens_joiner: ' ',
	// The last word of a number and the same word as an ordinal: "yirmi üç" -> "yirmi üçüncü".
	ordinals: [
		['sıfır', 'sıfırıncı'], ['bir', 'birinci'], ['iki', 'ikinci'], ['üç', 'üçüncü'], ['dört', 'dördüncü'],
		['beş', 'beşinci'], ['altı', 'altıncı'], ['yedi', 'yedinci'], ['sekiz', 'sekizinci'], ['dokuz', 'dokuzuncu'],
		['on', 'onuncu'], ['yirmi', 'yirminci'], ['otuz', 'otuzuncu'], ['kırk', 'kırkıncı'], ['elli', 'ellinci'],
		['altmış', 'altmışıncı'], ['yetmiş', 'yetmişinci'], ['seksen', 'sekseninci'], ['doksan', 'doksanıncı'],
		['yüz', 'yüzüncü'], ['bin', 'bininci'], ['milyon', 'milyonuncu'], ['milyar', 'milyarıncı'],
		['trilyon', 'trilyonuncu'],
	],
	// "3,5" is "üç virgül beş" and "3,25" "üç virgül yirmi beş": up to this many digits after the comma
	// are read as one number, as Turkish does; a longer tail is read digit by digit.
	decimal_word: 'virgül',
	fraction_as_number: 3,
	minus: 'eksi',
	plus: 'artı',
	times: 'çarpı',
	divided: 'bölü',
	equals: 'eşittir',
	and: 've',
	// Between the parts of a version or an address ("2.0.1", "192.168.1.1") and of a domain name.
	point: 'nokta',
	dot: 'nokta',
	about: 'yaklaşık',
	squared: 'kare',
	cubed: 'küp',
	// A lone "%" or "°" with no number beside it.
	percent_word: 'yüzde',
	degrees_word: 'derece',
	percent: 'yüzde {n}',
	// "3x daha hızlı"
	multiple: '{n} kat',
	// "10-15 dakika" is "on ila on beş dakika". Two neighbours are said side by side as people say them
	// ("3-4 kişi" -> "üç dört kişi"), and with the first number larger it is a score ("3-1") said the same way.
	range: '{from} ila {to}',
	range_adjacent: '{from} {to}',
	score: '{from} {to}',
	version: 'sürüm {n}',
	// "16:9" is "on altıya dokuz": the first number takes the dative.
	ratio: '{from} {to}',
	ratio_case: 'e',
	// Turkish puts "ayda" before the amount ("19,99 TL/ay"); nothing is said for the slash.
	per: '',
	// "#1", "No. 5"
	number_sign: 'numara {n}',

	// ---- times: "14:45" -> "on dört kırk beş", "09:05" -> "dokuz sıfır beş", "14:00" -> "on dört"
	time_zero: 'sıfır',
	time_full_hour: '',
	time_full_hour_24: '',
	time_am: 'öğleden önce {time}',
	time_pm: 'öğleden sonra {time}',

	// ---- dates: "24.09.2026" -> "yirmi dört Eylül iki bin yirmi altı"
	months: [
		['Ocak', 'Oca'], ['Şubat', 'Şub'], ['Mart', 'Mar'], ['Nisan', 'Nis'], ['Mayıs', 'May'], ['Haziran', 'Haz'],
		['Temmuz', 'Tem'], ['Ağustos', 'Ağu'], ['Eylül', 'Eyl'], ['Ekim', 'Eki'], ['Kasım', 'Kas'], ['Aralık', 'Ara'],
	],
	date: '{day} {month} {year}',
	date_no_year: '{day} {month}',
	day_month: '{day} {month}',
	day_month_year: '{day} {month} {year}',
	date_day: 'cardinal',
	// "03/04/2026": the day comes first in Turkish however the date is written.
	slash_dates: 'dmy',
	// Years are read as numbers: "2026" is "iki bin yirmi altı" wherever it stands.
	year_style: 'cardinal',

	// ---- fractions: "3/4" -> "dörtte üç" (the denominator takes the locative, as in "yüzde")
	fraction_style: 'locative',
	fraction_specials: [['1/2', 'yarım'], ['1/4', 'çeyrek'], ['50/50', 'yarı yarıya'], ['24/7', 'yirmi dört yedi']],
	fraction_denominators: [],
	fraction_out_of: '',

	// ---- money: "₺50" -> "elli lira", "12,50 TL" -> "on iki lira elli kuruş". The euro is "avro", the
	// spelling a Turkish voice says right; "euro" comes out letter by letter.
	currencies: [
		{ symbols: ['₺', 'TL', 'tl', 'TRY'], one: 'lira', many: 'lira', cent_one: 'kuruş', cent_many: 'kuruş' },
		{ symbols: ['$', 'USD', 'usd'], one: 'dolar', many: 'dolar', cent_one: 'sent', cent_many: 'sent' },
		{ symbols: ['€', 'EUR', 'eur'], one: 'avro', many: 'avro', cent_one: 'sent', cent_many: 'sent' },
		{ symbols: ['£', 'GBP', 'gbp'], one: 'sterlin', many: 'sterlin', cent_one: 'peni', cent_many: 'peni' },
	],
	// The words an amount may carry between the number and the currency ("1,5 milyon TL").
	amount_scales: [
		['bin', 'bin'], ['milyon', 'milyon'], ['milyar', 'milyar'], ['trilyon', 'trilyon'],
		['K', 'bin'], ['mn', 'milyon'], ['Mn', 'milyon'], ['mlr', 'milyar'], ['Mlr', 'milyar'],
	],
	// Turkish writes the scale as a word ("1,5 milyon"), which is said as it is.
	number_scales: [],
	money: {
		whole: '{amount} {unit}',
		cents: '{amount} {unit} {cents} {subunit}',
		small_cents: '{amount} {unit} {cents} {subunit}',
		only_cents: '{cents} {subunit}',
	},

	// ---- units after a number: [as written, one, more than one]; a Turkish noun after a number stays
	// singular, so both are the same. "{n}" places the number when it does not simply go first.
	units: [
		['km/h', 'saatte {n} kilometre', 'saatte {n} kilometre'],
		['km/sa', 'saatte {n} kilometre', 'saatte {n} kilometre'],
		['mph', 'saatte {n} mil', 'saatte {n} mil'],
		['m/s', 'saniyede {n} metre', 'saniyede {n} metre'],
		['m/sn', 'saniyede {n} metre', 'saniyede {n} metre'],
		['Mbps', 'saniyede {n} megabit', 'saniyede {n} megabit'],
		['Gbps', 'saniyede {n} gigabit', 'saniyede {n} gigabit'],
		['fps', 'saniyede {n} kare', 'saniyede {n} kare'],
		['km²', 'kilometrekare', 'kilometrekare'],
		['m²', 'metrekare', 'metrekare'],
		['m2', 'metrekare', 'metrekare'],
		['cm²', 'santimetrekare', 'santimetrekare'],
		['m³', 'metreküp', 'metreküp'],
		['km', 'kilometre', 'kilometre'],
		['cm', 'santimetre', 'santimetre'],
		['mm', 'milimetre', 'milimetre'],
		['m', 'metre', 'metre'],
		['kg', 'kilogram', 'kilogram'],
		['mg', 'miligram', 'miligram'],
		['gr', 'gram', 'gram'],
		['g', 'gram', 'gram'],
		['ml', 'mililitre', 'mililitre'],
		['lt', 'litre', 'litre'],
		['L', 'litre', 'litre'],
		['°C', 'derece', 'derece'],
		['°F', '{n} derece fahrenhayt', '{n} derece fahrenhayt'],
		['°', 'derece', 'derece'],
		['TB', 'terabayt', 'terabayt'],
		['GB', 'gigabayt', 'gigabayt'],
		['MB', 'megabayt', 'megabayt'],
		['KB', 'kilobayt', 'kilobayt'],
		['kB', 'kilobayt', 'kilobayt'],
		['tb', 'terabayt', 'terabayt'],
		['gb', 'gigabayt', 'gigabayt'],
		['mb', 'megabayt', 'megabayt'],
		['kb', 'kilobayt', 'kilobayt'],
		['GHz', 'gigahertz', 'gigahertz'],
		['MHz', 'megahertz', 'megahertz'],
		['kHz', 'kilohertz', 'kilohertz'],
		['Hz', 'hertz', 'hertz'],
		['kW', 'kilovat', 'kilovat'],
		['W', 'vat', 'vat'],
		['V', 'volt', 'volt'],
		['mAh', 'miliamper saat', 'miliamper saat'],
		['ms', 'milisaniye', 'milisaniye'],
		['sn', 'saniye', 'saniye'],
		['dk', 'dakika', 'dakika'],
		['sa', 'saat', 'saat'],
	],

	// ---- what stands in for something that is not read out
	url: 'bağlantı',
	email: 'e-posta adresi',
	code: 'kod örneği',

	// ---- abbreviations: [as written, as said, true when it can end a sentence]. Matched as written, so
	// "Sn." (Sayın) and "sn." (saniye) stay apart; one that starts with a small letter is also found
	// capitalised at the start of a sentence ("Örn.").
	abbreviations: [
		['vb.', 've benzeri', true],
		['vs.', 'vesaire', true],
		['vd.', 've diğerleri', true],
		['örn.', 'örneğin'],
		['ör.', 'örneğin'],
		['bkz.', 'bakınız'],
		['bknz.', 'bakınız'],
		['yak.', 'yaklaşık'],
		['yakl.', 'yaklaşık'],
		['sa.', 'saat', true],
		['dk.', 'dakika', true],
		['sn.', 'saniye', true],
		['yy.', 'yüzyıl', true],
		['M.Ö.', 'milattan önce', true],
		['M.S.', 'milattan sonra', true],
		['Dr.', 'Doktor'],
		['Prof.', 'Profesör'],
		['Doç.', 'Doçent'],
		['Sn.', 'Sayın'],
		['Av.', 'Avukat'],
		['Yrd.', 'Yardımcı'],
		['Müh.', 'Mühendis'],
		['Uzm.', 'Uzman'],
		['Op.', 'Operatör'],
		['Öğr.', 'Öğretmen'],
		['Hz.', 'Hazreti'],
		['Cad.', 'Caddesi', true],
		['Sok.', 'Sokak', true],
		['Mah.', 'Mahallesi', true],
		['Apt.', 'Apartmanı', true],
		['tel.', 'telefon'],
		['TL', 'lira'],
		['km', 'kilometre'],
		['kg', 'kilogram'],
	],

	// ---- what follows a number. After an apostrophe any ending is the number's ("3'te", "%20'si"); one
	// written without it ("3te", "90lar") is taken only when it has the shape of a case, plural,
	// possessive or distributive ending, so "4K" and "1080p" keep their letter apart.
	number_suffix: {
		pattern: '^(?:y?[ıiuüae]|[dt][ae](?:n|ki)?|l[ae]r\\p{L}*|l[ıiuü][kğ]\\p{L}*|s[ıiuü]\\p{L}*|n?[ıiuü]n|y?l[ae]|ş?[ae]r)$',
		flags: 'u',
	},
	suffix_style: 'harmony',
	// "3'üncü", "3.üncü", "3üncü", "2'nci", "10'uncu"
	ordinal_mark: { pattern: "(?:['’.]\\s?)?[ıiuü]?nc[ıiuü]", flags: 'u' },
	// "3. sırada": a number with a full stop before a word in small letters is an ordinal.
	ordinal_dot: { pattern: '\\.(?=\\s+\\p{Ll})', flags: 'u' },
	soft_endings: [['dört', 'dörd']],
};
