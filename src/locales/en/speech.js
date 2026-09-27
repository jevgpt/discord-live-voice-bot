// speech strings (en). Keys are referenced as "speech.<key>" through src/i18n.
//
// This namespace holds what src/speechtext.js needs to turn written text into the words a speech
// synthesiser should say: number words, units, currencies, abbreviations and the few fixed words that
// stand in for things nobody reads aloud (a link, a block of code). A model's reply is written for the
// eye -- "$3.99", "14:45", "e.g." -- and an autoregressive voice left to guess at that improvises, so
// everything here is the spoken form of something that is written differently.
//
// The table is read in the language of the SENTENCE, not in BOT_LANGUAGE: with LOCAL_TTS_LANG=auto a
// Turkish bot says an English line with these words. Like keywords and grammar, the words are real
// English, not translations of the Turkish table; the two only share their shape.
//
// Number words are American: no "and" inside a number ("one hundred five"), which is also how the
// years below come out ("two thousand five").
export default {
	// How a number is written: "1,250,000.50".
	number_format: { thousands: ',', decimal: '.' },
	// 0-19 have words of their own; from 20 on a number is a tens word and a unit.
	ones: [
		'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
		'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
	],
	tens: ['', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'],
	hundred: 'hundred',
	// One word per group of three digits, the ones first.
	scales: ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'],
	// The scale words said without "one" in front of them: none in English ("one hundred", "one thousand").
	silent_one: [],
	// "twenty-one"
	tens_joiner: '-',
	// The last word of a number and the same word as an ordinal: "twenty-one" -> "twenty-first".
	ordinals: [
		['zero', 'zeroth'], ['one', 'first'], ['two', 'second'], ['three', 'third'], ['four', 'fourth'], ['five', 'fifth'],
		['six', 'sixth'], ['seven', 'seventh'], ['eight', 'eighth'], ['nine', 'ninth'], ['ten', 'tenth'],
		['eleven', 'eleventh'], ['twelve', 'twelfth'], ['thirteen', 'thirteenth'], ['fourteen', 'fourteenth'],
		['fifteen', 'fifteenth'], ['sixteen', 'sixteenth'], ['seventeen', 'seventeenth'], ['eighteen', 'eighteenth'],
		['nineteen', 'nineteenth'], ['twenty', 'twentieth'], ['thirty', 'thirtieth'], ['forty', 'fortieth'],
		['fifty', 'fiftieth'], ['sixty', 'sixtieth'], ['seventy', 'seventieth'], ['eighty', 'eightieth'],
		['ninety', 'ninetieth'], ['hundred', 'hundredth'], ['thousand', 'thousandth'], ['million', 'millionth'],
		['billion', 'billionth'], ['trillion', 'trillionth'],
	],
	// "3.14" is "three point one four": the digits after the point are read one by one, so no more of
	// them are read as a number than this.
	decimal_word: 'point',
	fraction_as_number: 0,
	minus: 'minus',
	plus: 'plus',
	times: 'times',
	divided: 'divided by',
	equals: 'equals',
	and: 'and',
	// Between the parts of a version or an address ("2.0.1", "192.168.1.1") and of a domain name.
	point: 'point',
	dot: 'dot',
	about: 'about',
	squared: 'squared',
	cubed: 'cubed',
	// A lone "%" or "°" with no number in front of it.
	percent_word: 'percent',
	degrees_word: 'degrees',
	percent: '{n} percent',
	// "3x faster"
	multiple: '{n} times',
	// "3-5 days" and, with the first number larger, a score ("won 3-1").
	range: '{from} to {to}',
	range_adjacent: '{from} to {to}',
	score: '{from} {to}',
	version: 'version {n}',
	// "16:9", "4:3"
	ratio: '{from} to {to}',
	ratio_case: '',
	// "$19.99/month"
	per: 'per',
	// "#1", "No. 5"
	number_sign: 'number {n}',

	// ---- times: read as they are written ("14:45" is "fourteen forty-five"), see src/speechtext.js
	time_zero: 'oh',
	time_full_hour: "o'clock",
	time_full_hour_24: 'hundred',
	time_am: '{time} AM',
	time_pm: '{time} PM',

	// ---- dates
	// Each month is its name first, then the ways it is shortened.
	months: [
		['January', 'Jan'], ['February', 'Feb'], ['March', 'Mar'], ['April', 'Apr'], ['May'], ['June', 'Jun'],
		['July', 'Jul'], ['August', 'Aug'], ['September', 'Sept', 'Sep'], ['October', 'Oct'], ['November', 'Nov'],
		['December', 'Dec'],
	],
	date: '{month} {day}, {year}',
	date_no_year: '{month} {day}',
	// "24 September" as English says it when the day comes first.
	day_month: 'the {day} of {month}',
	day_month_year: 'the {day} of {month}, {year}',
	// "September twenty-fourth": the day is an ordinal.
	date_day: 'ordinal',
	// "03/04/2026" with both numbers 12 or less: month first, as in the US. Dates written with dots
	// ("24.09.2026") are always day first, which is the only way they are written.
	slash_dates: 'mdy',
	// "2026" -> "twenty twenty-six", "1905" -> "nineteen oh five": a bare four-digit number from 1100 to
	// 2099 is said the way a year is (an amount that size is written "1,500", and "fifteen hundred" is
	// how it is said anyway); 2000-2009 stay "two thousand five".
	year_style: 'paired',

	// ---- fractions: "3/4" -> "three quarters", "5/10" -> "five out of ten"
	fraction_style: 'named',
	fraction_specials: [['1/2', 'one half'], ['50/50', 'fifty-fifty'], ['24/7', 'twenty-four seven']],
	fraction_denominators: [[2, 'half', 'halves'], [3, 'third', 'thirds'], [4, 'quarter', 'quarters']],
	fraction_out_of: '{num} out of {den}',

	// ---- money: "$3.99" -> "three dollars ninety-nine"
	currencies: [
		{ symbols: ['$', 'USD', 'usd'], one: 'dollar', many: 'dollars', cent_one: 'cent', cent_many: 'cents' },
		{ symbols: ['€', 'EUR', 'eur'], one: 'euro', many: 'euros', cent_one: 'cent', cent_many: 'cents' },
		{ symbols: ['£', 'GBP', 'gbp'], one: 'pound', many: 'pounds', cent_one: 'penny', cent_many: 'pence' },
		{ symbols: ['₺', 'TL', 'tl', 'TRY'], one: 'lira', many: 'lira', cent_one: 'kurus', cent_many: 'kurus' },
	],
	// The words an amount may carry between the number and the currency ("$1.5M", "$2 billion").
	amount_scales: [
		['thousand', 'thousand'], ['million', 'million'], ['billion', 'billion'], ['trillion', 'trillion'],
		['k', 'thousand'], ['K', 'thousand'], ['m', 'million'], ['M', 'million'], ['mn', 'million'],
		['bn', 'billion'], ['B', 'billion'], ['tn', 'trillion'],
	],
	// A scale letter glued to a number without a currency: "1.5M users", "10k steps". A capital K stays a
	// letter ("4K" is a resolution).
	number_scales: [['k', 'thousand'], ['M', 'million'], ['bn', 'billion'], ['B', 'billion']],
	money: {
		whole: '{amount} {unit}',
		cents: '{amount} {unit} {cents}',
		small_cents: '{amount} {unit} and {cents} {subunit}',
		only_cents: '{cents} {subunit}',
	},

	// ---- units after a number: [as written, one, more than one]. "{n}" places the number when it does
	// not simply go first.
	units: [
		['km/h', '{n} kilometer per hour', '{n} kilometers per hour'],
		['kph', '{n} kilometer per hour', '{n} kilometers per hour'],
		['mph', '{n} mile per hour', '{n} miles per hour'],
		['m/s', '{n} meter per second', '{n} meters per second'],
		['Mbps', '{n} megabit per second', '{n} megabits per second'],
		['Gbps', '{n} gigabit per second', '{n} gigabits per second'],
		['fps', '{n} frame per second', '{n} frames per second'],
		['km²', 'square kilometer', 'square kilometers'],
		['m²', 'square meter', 'square meters'],
		['cm²', 'square centimeter', 'square centimeters'],
		['m³', 'cubic meter', 'cubic meters'],
		['km', 'kilometer', 'kilometers'],
		['cm', 'centimeter', 'centimeters'],
		['mm', 'millimeter', 'millimeters'],
		['m', 'meter', 'meters'],
		['mi', 'mile', 'miles'],
		['ft', 'foot', 'feet'],
		['kg', 'kilogram', 'kilograms'],
		['mg', 'milligram', 'milligrams'],
		['g', 'gram', 'grams'],
		['lbs', 'pound', 'pounds'],
		['lb', 'pound', 'pounds'],
		['oz', 'ounce', 'ounces'],
		['ml', 'milliliter', 'milliliters'],
		['L', 'liter', 'liters'],
		['°C', '{n} degree Celsius', '{n} degrees Celsius'],
		['°F', '{n} degree Fahrenheit', '{n} degrees Fahrenheit'],
		['°', 'degree', 'degrees'],
		['TB', 'terabyte', 'terabytes'],
		['GB', 'gigabyte', 'gigabytes'],
		['MB', 'megabyte', 'megabytes'],
		['KB', 'kilobyte', 'kilobytes'],
		['kB', 'kilobyte', 'kilobytes'],
		['tb', 'terabyte', 'terabytes'],
		['gb', 'gigabyte', 'gigabytes'],
		['mb', 'megabyte', 'megabytes'],
		['kb', 'kilobyte', 'kilobytes'],
		['GHz', 'gigahertz', 'gigahertz'],
		['MHz', 'megahertz', 'megahertz'],
		['kHz', 'kilohertz', 'kilohertz'],
		['Hz', 'hertz', 'hertz'],
		['kW', 'kilowatt', 'kilowatts'],
		['W', 'watt', 'watts'],
		['V', 'volt', 'volts'],
		['mAh', 'milliamp hour', 'milliamp hours'],
		['ms', 'millisecond', 'milliseconds'],
		['sec', 'second', 'seconds'],
		['min', 'minute', 'minutes'],
		['hrs', 'hour', 'hours'],
		['hr', 'hour', 'hours'],
		['h', 'hour', 'hours'],
	],

	// ---- what stands in for something that is not read out
	url: 'link',
	email: 'email address',
	code: 'a code sample',

	// ---- abbreviations: [as written, as said, true when it can end a sentence]. Matched as written; one
	// that starts with a small letter is also found capitalised at the start of a sentence.
	abbreviations: [
		['e.g.', 'for example'],
		['i.e.', 'that is'],
		['etc.', 'et cetera', true],
		['vs.', 'versus'],
		['vs', 'versus'],
		['approx.', 'approximately'],
		['est.', 'estimated'],
		['dept.', 'department'],
		['max.', 'maximum'],
		['min.', 'minimum'],
		['a.k.a.', 'also known as'],
		['aka', 'also known as'],
		['a.m.', 'AM', true],
		['p.m.', 'PM', true],
		['w/o', 'without'],
		['w/', 'with'],
		['Dr.', 'Doctor'],
		['Mr.', 'Mister'],
		['Mrs.', 'Missus'],
		['Ms.', 'Miz'],
		['Prof.', 'Professor'],
		['Jr.', 'Junior', true],
		['Sr.', 'Senior', true],
		['Inc.', 'Incorporated', true],
		['Ltd.', 'Limited', true],
		['Co.', 'Company', true],
		['TL', 'lira'],
	],

	// ---- what follows a number: "the 1990s", "in your 20s" -> the plural of the last word
	number_suffix: { pattern: '^s$', flags: 'u' },
	suffix_style: 'plural',
	// "1st", "22nd", "3RD"
	ordinal_mark: { pattern: '(?:st|nd|rd|th)(?![\\p{L}])', flags: 'iu' },
	// English writes no ordinal with a full stop.
	ordinal_dot: { pattern: '', flags: 'u' },
	soft_endings: [],
};
