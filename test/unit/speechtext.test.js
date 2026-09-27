import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { speechLanguage, spellNumber, toSpeech } from '../../src/speechtext.js';

// What the local voice is given is what should be SAID. The owner's complaint was a voice that "rambles
// and talks nonsense", and the text it was handed explains half of it: digits, times, money, markdown,
// emoji and links, each one a string an autoregressive voice has no spoken form for and improvises on,
// and the Turkish engine cuts a number left as digits off altogether. Every row below is one written
// form and the words it has to come out as.

const ZWSP = String.fromCodePoint(0x200b);
const BELL = String.fromCodePoint(7);
const SOFT_HYPHEN = String.fromCodePoint(0xad);

const TURKISH = {
	'whole numbers': [
		['0', 'sıfır'],
		['7', 'yedi'],
		['10', 'on'],
		['11', 'on bir'],
		['21', 'yirmi bir'],
		['99', 'doksan dokuz'],
		['100', 'yüz', 'not "bir yüz"'],
		['101', 'yüz bir'],
		['200', 'iki yüz'],
		['1000', 'bin', 'not "bir bin"'],
		['1001', 'bin bir'],
		['2026', 'iki bin yirmi altı'],
		['10000', 'on bin'],
		['101000', 'yüz bir bin'],
		['1.000', 'bin'],
		['1.000.000', 'bir milyon', 'a million keeps its "bir"'],
		['1.250.000 kişi', 'bir milyon iki yüz elli bin kişi'],
		['1 250 000', 'bir milyon iki yüz elli bin', 'grouped with spaces'],
		['10 000', 'on bin'],
		['2.000.000.000', 'iki milyar'],
		['-5', 'eksi beş'],
		['007', 'sıfır sıfır yedi', 'a leading zero is a code, not an amount'],
		['2026 yılında', 'iki bin yirmi altı yılında', 'a year is read as a number'],
	],
	decimals: [
		['3,5', 'üç virgül beş'],
		['3,25', 'üç virgül yirmi beş'],
		['3,05', 'üç virgül sıfır beş'],
		['0,5', 'sıfır virgül beş'],
		['3,14159', 'üç virgül bir dört bir beş dokuz', 'a long tail digit by digit'],
		['1.250,75', 'bin iki yüz elli virgül yetmiş beş'],
		['1.5 GB', 'bir virgül beş gigabayt', 'a dot that cannot group thousands is a decimal point'],
	],
	ordinals: [
		['3. sırada', 'üçüncü sırada'],
		['21. yüzyıl', 'yirmi birinci yüzyıl'],
		['Kitabın 45. sayfası', 'Kitabın kırk beşinci sayfası'],
		["3'üncü", 'üçüncü'],
		["1'inci", 'birinci'],
		["2'nci", 'ikinci'],
		["4'üncü", 'dördüncü'],
		["6'ncı", 'altıncı'],
		["10'uncu", 'onuncu'],
		["100'üncü", 'yüzüncü'],
		['3üncü', 'üçüncü'],
		["3'üncüsü", 'üçüncüsü'],
		['Kazanan sayı 7. Tebrikler!', 'Kazanan sayı yedi. Tebrikler!', 'before a capital the full stop ends the sentence'],
	],
	'endings after a number': [
		["3'te", 'üçte'],
		['3’te', 'üçte', 'a typographic apostrophe'],
		["2026'da", 'iki bin yirmi altıda'],
		["5'i", 'beşi'],
		["4'e", 'dörde', 'dört softens before a vowel'],
		["4'ü de geldi", 'dördü de geldi'],
		["6'yı", 'altıyı'],
		["1'den 10'a kadar say", 'birden ona kadar say'],
		["2'nin", 'ikinin'],
		["3'ün", 'üçün'],
		["1990'larda", 'bin dokuz yüz doksanlarda'],
		["90'lar", 'doksanlar'],
		["50'şer kişi", 'ellişer kişi'],
		["5'er", 'beşer'],
		["2026'daki", 'iki bin yirmi altıdaki', '-ki keeps its vowel'],
		["Bu 100'de 1 ihtimal", 'Bu yüzde bir ihtimal'],
		['3te', 'üçte', 'the ending written without an apostrophe'],
		["14:00'te", 'on dörtte'],
		["5 km'den", 'beş kilometreden', 'refitted to the unit said'],
		["50 TL'ye", 'elli liraya', 'refitted to "lira", not to "TL"'],
		["10 GB'lık", 'on gigabaytlık'],
		['Fiyat TL cinsinden', 'Fiyat lira cinsinden'],
	],
	percentages: [
		['%20', 'yüzde yirmi'],
		['% 20', 'yüzde yirmi'],
		['20%', 'yüzde yirmi'],
		['%3,5', 'yüzde üç virgül beş'],
		["%20'si indirimde", 'yüzde yirmisi indirimde'],
		["%50'den fazla", 'yüzde elliden fazla'],
		['%20-30', 'yüzde yirmi ila otuz'],
		['yarın %60 yağmur', 'yarın yüzde altmış yağmur'],
	],
	times: [
		['14:45', 'on dört kırk beş'],
		['09:05', 'dokuz sıfır beş'],
		['14:00', 'on dört'],
		['00:30', 'sıfır otuz'],
		['14:45:30', 'on dört kırk beş otuz'],
		["Saat 9.30'da", 'Saat dokuz otuzda', 'a dot between hours and minutes'],
		["Toplantı 15:30'da, 2. katta.", 'Toplantı on beş otuzda, ikinci katta.'],
		["10.00'da", 'onda'],
		['Şu an saat 14.05.', 'Şu an saat on dört sıfır beş.'],
		['18:00-20:00 arası', 'on sekiz ila yirmi arası'],
		['3 pm', 'öğleden sonra üç'],
	],
	dates: [
		['24.09.2026', 'yirmi dört Eylül iki bin yirmi altı'],
		["24.09.2026'da", 'yirmi dört Eylül iki bin yirmi altıda'],
		['24 Eylül 2026', 'yirmi dört Eylül iki bin yirmi altı'],
		['2026-09-24', 'yirmi dört Eylül iki bin yirmi altı'],
		['24/09/2026', 'yirmi dört Eylül iki bin yirmi altı'],
		['09/24/2026', 'yirmi dört Eylül iki bin yirmi altı', 'a month that cannot be a day'],
		['01.01.2000', 'bir Ocak iki bin'],
		['31.12.1999', 'otuz bir Aralık bin dokuz yüz doksan dokuz'],
		['3 Mart 2026 Salı', 'üç Mart iki bin yirmi altı Salı'],
		['24. Eylül', 'yirmi dört Eylül'],
	],
	ranges: [
		['3-4 kişi', 'üç dört kişi', 'neighbours side by side'],
		['10-15 dakika', 'on ila on beş dakika'],
		['5–10', 'beş ila on', 'an en dash'],
		['Maç 3-1 bitti.', 'Maç üç bir bitti.', 'a score'],
		['2020-2024 yılları', 'iki bin yirmi ila iki bin yirmi dört yılları'],
		['3-5 km', 'üç ila beş kilometre'],
	],
	money: [
		['₺50', 'elli lira'],
		['50 TL', 'elli lira'],
		['50TL', 'elli lira'],
		['50 tl', 'elli lira'],
		['12,50 TL', 'on iki lira elli kuruş'],
		['Fiyatı 1.299,99 TL.', 'Fiyatı bin iki yüz doksan dokuz lira doksan dokuz kuruş.'],
		['₺1.250', 'bin iki yüz elli lira'],
		['0,50 TL', 'elli kuruş'],
		['$3.99', 'üç dolar doksan dokuz sent'],
		['€20', 'yirmi avro'],
		['£5', 'beş sterlin'],
		['100 USD', 'yüz dolar'],
		['EUR 20', 'yirmi avro'],
		['1,5 milyon TL', 'bir virgül beş milyon lira'],
		['5-10 TL', 'beş ila on lira'],
	],
	units: [
		['5 km', 'beş kilometre'],
		['5km', 'beş kilometre'],
		['2,5 kg', 'iki virgül beş kilogram'],
		['180 cm', 'yüz seksen santimetre'],
		['20°C', 'yirmi derece'],
		['-5 °C', 'eksi beş derece'],
		['90°', 'doksan derece'],
		['100 km/h', 'saatte yüz kilometre'],
		['120 m²', 'yüz yirmi metrekare'],
		['8 GB RAM', 'sekiz gigabayt RAM'],
		['500 MB', 'beş yüz megabayt'],
		['3,2 GHz', 'üç virgül iki gigahertz'],
		['30 sn', 'otuz saniye'],
		['5 dk. sonra', 'beş dakika sonra'],
		['2 sa', 'iki saat'],
		['~5 dk', 'yaklaşık beş dakika'],
	],
	'phone numbers and codes': [
		['0532 123 45 67', 'sıfır beş üç iki, bir iki üç, dört beş, altı yedi'],
		['+90 532 123 45 67', 'artı dokuz sıfır, beş üç iki, bir iki üç, dört beş, altı yedi'],
		['(0212) 555 12 34', 'sıfır iki bir iki, beş beş beş, bir iki, üç dört'],
		['05321234567', 'sıfır beş üç iki bir iki üç dört beş altı yedi'],
		['Sipariş numaranız 123456789.', 'Sipariş numaranız bir iki üç dört beş altı yedi sekiz dokuz.'],
	],
	'symbols and arithmetic': [
		['2+2=4', 'iki artı iki eşittir dört'],
		['5 - 3 = 2', 'beş eksi üç eşittir iki'],
		['3x daha hızlı', 'üç kat daha hızlı'],
		['1920x1080', 'bin dokuz yüz yirmi çarpı bin seksen'],
		['10 ÷ 2', 'on bölü iki'],
		['Ali & Veli', 'Ali ve Veli'],
		['ve/veya', 've veya'],
		['3/4', 'dörtte üç'],
		['1/3', 'üçte bir'],
		['1/2 saat', 'yarım saat'],
		['24/7', 'yirmi dört yedi'],
		['50/50', 'yarı yarıya'],
		['16:9 ekran', 'on altıya dokuz ekran', 'a ratio takes the dative'],
		['#1', 'numara bir'],
		['No. 5', 'numara beş'],
		['x²', 'x kare'],
	],
	'numbers inside words': [
		['COVID-19', 'COVID on dokuz'],
		['mp3 dosyası', 'mp üç dosyası'],
		['H2O', 'H iki O'],
		['4K ekran', 'dört K ekran', 'a capital K is a resolution, not a thousand'],
		['1080p', 'bin seksen p'],
		['v2.0', 'sürüm iki nokta sıfır'],
		['v1.2.3', 'sürüm bir nokta iki nokta üç'],
		['192.168.1.1', 'yüz doksan iki nokta yüz altmış sekiz nokta bir nokta bir'],
	],
	abbreviations: [
		['elma, armut vb.', 'elma, armut ve benzeri.', 'its full stop also ends the sentence'],
		['elma vs. armut', 'elma vesaire armut'],
		['örn. elma', 'örneğin elma'],
		['Örn. elma', 'Örneğin elma', 'capitalised at the start of a sentence'],
		['Dr. Ayşe geldi', 'Doktor Ayşe geldi'],
		['Prof. Dr. Ahmet', 'Profesör Doktor Ahmet'],
		['Sn. Ahmet Bey', 'Sayın Ahmet Bey', 'Sn. is Sayın ...'],
		['5 sn. bekle', 'beş saniye bekle', '... and sn. is saniye'],
		['Av. Mehmet', 'Avukat Mehmet'],
		['bkz. ek', 'bakınız ek'],
		['M.Ö. 500', 'milattan önce beş yüz'],
	],
	'markup, emoji and links': [
		['**Merhaba** _dünya_', 'Merhaba dünya'],
		['# Başlık', 'Başlık'],
		['- madde', 'madde'],
		['1. Elma\n2. Armut', 'Elma, Armut', 'a numbered list is a list'],
		['Kod:\n```js\nconsole.log(1)\n```', 'Kod: kod örneği'],
		['`npm test` çalıştır', 'npm test çalıştır'],
		['Harika 😀👍', 'Harika'],
		['🇹🇷 Türkiye', 'Türkiye'],
		['Tamam ❤️', 'Tamam'],
		['Selam 👋🏽', 'Selam'],
		['https://example.com/x adresine bak', 'bağlantı adresine bak'],
		['www.example.com', 'bağlantı'],
		['Bak: https://example.com.', 'Bak: bağlantı.'],
		['ali@example.com adresine yaz', 'e-posta adresi adresine yaz'],
		['[buraya](https://x.com) tıkla', 'buraya tıkla'],
		["google.com'a gir", "google nokta com'a gir"],
		['<@123456789012345678> selam', 'selam'],
		['Tamam :)', 'Tamam'],
		['Seni seviyorum <3', 'Seni seviyorum'],
		['Hmm... bilmiyorum...', 'Hmm, bilmiyorum.', 'three dots are a pause'],
		['Evet!!!', 'Evet!'],
		['Ne?!', 'Ne?'],
		['Ali (25) geldi', 'Ali, yirmi beş, geldi'],
		[`mer${ZWSP}haba`, 'merhaba', 'a zero-width space'],
		[`ya${SOFT_HYPHEN}kın`, 'yakın', 'a soft hyphen'],
		[`a${BELL}b`, 'a b', 'a control character'],
		['a    b', 'a b'],
	],
	'capitals, İ and ı': [
		['ŞİMDİ ÇOK İYİ OLDU', 'şimdi çok iyi oldu', 'shouting said as words, İ as i'],
		['KAPALI IŞIK YANIYOR', 'kapalı ışık yanıyor', 'and I as ı'],
		["İSTANBUL'DA ÇOK GÜZEL BİR GÜN", "istanbul'da çok güzel bir gün"],
		['NASA ve ESA', 'NASA ve ESA', 'two capitalised words are names, not shouting'],
		["İzmir'de 3 gün", "İzmir'de üç gün"],
		['Iğdır 2. sırada', 'Iğdır ikinci sırada'],
	],
};

const ENGLISH = {
	'whole numbers': [
		['0', 'zero'],
		['13', 'thirteen'],
		['21', 'twenty-one'],
		['99', 'ninety-nine'],
		['100', 'one hundred'],
		['105', 'one hundred five'],
		['1,000', 'one thousand'],
		['1,250,000', 'one million two hundred fifty thousand'],
		['1000000', 'one million'],
		['-7', 'minus seven'],
		['3.5', 'three point five'],
		['3.14', 'three point one four'],
		['0.5', 'zero point five'],
		['1,000.5', 'one thousand point five'],
		['9.30', 'nine point three zero', 'a dot is a decimal point in English'],
	],
	years: [
		['2026', 'twenty twenty-six'],
		['in 1999', 'in nineteen ninety-nine'],
		['1905', 'nineteen oh five'],
		['1900', 'nineteen hundred'],
		['2000', 'two thousand'],
		['2005', 'two thousand five'],
		['2010', 'twenty ten'],
		['1500 people', 'fifteen hundred people'],
		['the 1990s', 'the nineteen nineties'],
		["the '90s", 'the nineties'],
		['in your 20s', 'in your twenties'],
	],
	ordinals: [
		['1st', 'first'],
		['2nd', 'second'],
		['3rd', 'third'],
		['4th', 'fourth'],
		['11th', 'eleventh'],
		['12th', 'twelfth'],
		['21st', 'twenty-first'],
		['22nd', 'twenty-second'],
		['100th', 'one hundredth'],
		['1ST', 'first'],
	],
	percentages: [
		['20%', 'twenty percent'],
		['%20', 'twenty percent'],
		['12.5%', 'twelve point five percent'],
		['20-30%', 'twenty to thirty percent'],
	],
	times: [
		['14:45', 'fourteen forty-five'],
		['09:05', 'nine oh five'],
		['12:00', "twelve o'clock"],
		['14:00', 'fourteen hundred'],
		['3:30 pm', 'three thirty PM'],
		['3pm', 'three PM'],
		['Call me at 5 p.m. tomorrow.', 'Call me at five PM tomorrow.'],
		['from 9am to 5pm', 'from nine AM to five PM'],
		["It's 1:30.", "It's one thirty."],
	],
	dates: [
		['September 24, 2026', 'September twenty-fourth, twenty twenty-six'],
		['on Sept. 5th', 'on September fifth'],
		['24 September 2026', 'the twenty-fourth of September, twenty twenty-six'],
		['the 24th of September', 'the twenty-fourth of September'],
		['2026-09-24', 'September twenty-fourth, twenty twenty-six'],
		['03/04/2026', 'March fourth, twenty twenty-six', 'US order when both could be the month'],
		['24/09/2026', 'September twenty-fourth, twenty twenty-six'],
		['24.09.2026', 'September twenty-fourth, twenty twenty-six'],
		['May 2026', 'May twenty twenty-six'],
	],
	ranges: [
		['3-5 days', 'three to five days'],
		['3-4 people', 'three to four people'],
		['won 3-1', 'won three one'],
		['1990-2000', 'nineteen ninety to two thousand'],
	],
	money: [
		['$3.99', 'three dollars ninety-nine'],
		['$1', 'one dollar'],
		['$0.50', 'fifty cents'],
		['$0.01', 'one cent'],
		['$3.05', 'three dollars and five cents'],
		['$1,250', 'one thousand two hundred fifty dollars'],
		['$1.5M', 'one point five million dollars'],
		['$2 billion', 'two billion dollars'],
		['€20', 'twenty euros'],
		['€1', 'one euro'],
		['£5.50', 'five pounds fifty'],
		['50 USD', 'fifty dollars'],
		['₺50', 'fifty lira'],
		['$5-10', 'five to ten dollars'],
		['It costs $19.99/month.', 'It costs nineteen dollars ninety-nine per month.'],
	],
	units: [
		['1 km', 'one kilometer'],
		['5 km', 'five kilometers'],
		['1.5 GB', 'one point five gigabytes'],
		['20°C', 'twenty degrees Celsius'],
		['-3°C', 'minus three degrees Celsius'],
		['98.6°F', 'ninety-eight point six degrees Fahrenheit'],
		['100 km/h', 'one hundred kilometers per hour'],
		['60 mph', 'sixty miles per hour'],
		['6 ft', 'six feet'],
		['1 ft', 'one foot'],
		['250 ml', 'two hundred fifty milliliters'],
		['100 ms', 'one hundred milliseconds'],
		['5 min', 'five minutes'],
		['2h', 'two hours'],
		['10k steps', 'ten thousand steps'],
		['1.5M users', 'one point five million users'],
		['5 km/day', 'five kilometers per day'],
	],
	'phone numbers': [
		['555-123-4567', 'five five five, one two three, four five six seven'],
		['+1 (555) 123-4567', 'plus one, five five five, one two three, four five six seven'],
	],
	'symbols and arithmetic': [
		['2+2=4', 'two plus two equals four'],
		['3x faster', 'three times faster'],
		['Tom & Jerry', 'Tom and Jerry'],
		['and/or', 'and or'],
		['3/4 cup', 'three quarters cup'],
		['1/2', 'one half'],
		['2/3', 'two thirds'],
		['5/10', 'five out of ten'],
		['a 50/50 chance', 'a fifty-fifty chance'],
		['24/7', 'twenty-four seven'],
		['16:9', 'sixteen to nine'],
		['~5 min', 'about five minutes'],
		['#1 fan', 'number one fan'],
		['No. 5', 'number five'],
	],
	'numbers inside words': [
		['COVID-19', 'COVID nineteen'],
		['mp3', 'mp three'],
		['v2.0', 'version two point zero'],
		['iPhone 15', 'iPhone fifteen'],
		['Q3', 'Q three'],
	],
	abbreviations: [
		['e.g. apples', 'for example apples'],
		['e.g., apples', 'for example, apples'],
		['E.g. this', 'For example this'],
		['i.e. this', 'that is this'],
		['apples, pears, etc.', 'apples, pears, et cetera.'],
		['Dr. Smith', 'Doctor Smith'],
		['Mr. and Mrs. Smith', 'Mister and Missus Smith'],
		['Ms. Lee', 'Miz Lee'],
		['Cats vs. dogs', 'Cats versus dogs'],
		['approx. 5 km', 'approximately five kilometers'],
		['w/ friends', 'with friends'],
		['w/o sugar', 'without sugar'],
	],
	'markup, emoji and links': [
		['**Bold** and _italic_', 'Bold and italic'],
		['## Summary', 'Summary'],
		['- item', 'item'],
		['See https://example.com/docs.', 'See link.'],
		['Mail me at a.b@example.com.', 'Mail me at email address.'],
		['Great job! 🎉', 'Great job!'],
		['I AM VERY HAPPY TODAY', 'I am very happy today', 'shouting, with "I" left a capital'],
		['NASA and ESA', 'NASA and ESA'],
		['Well... maybe', 'Well, maybe'],
		['Code:\n```python\nprint(1)\n```', 'Code: a code sample'],
		['snake_case_name', 'snake case name'],
		['2*3*4', 'two times three times four', 'arithmetic, not italics'],
	],
};

// Anything else gets only the cleanup that does not depend on the language: its numbers keep their
// digits, because a voice in a language without a table is better off with a digit than with a number
// read in Turkish or English.
const OTHER = [
	['de', '**Hallo** 😀 Welt', 'Hallo Welt'],
	['de', 'Es kostet 5 €', 'Es kostet 5 €'],
	['de', 'Siehe https://example.de bitte', 'Siehe link bitte'],
	['fr', 'Voilà:\n```\ncode\n```', 'Voilà: a code sample'],
	['fr', `bon${ZWSP}jour`, 'bonjour'],
	[null, '# Title', 'Title'],
	['xx', 'Ok :)', 'Ok'],
];

function table(language, groups) {
	for (const [group, rows] of Object.entries(groups)) {
		describe(`${language}: ${group}`, () => {
			for (const [input, expected, note] of rows) {
				it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}${note ? ` (${note})` : ''}`, () => {
					assert.equal(toSpeech(input, language), expected);
				});
			}
		});
	}
}

table('tr', TURKISH);
table('en', ENGLISH);

describe('other languages: only the cleanup', () => {
	for (const [language, input, expected] of OTHER) {
		it(`${language}: ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
			assert.equal(toSpeech(input, language), expected);
		});
	}
});

const everyRow = [
	...Object.values(TURKISH).flatMap((rows) => rows.map(([input]) => ['tr', input])),
	...Object.values(ENGLISH).flatMap((rows) => rows.map(([input]) => ['en', input])),
	...OTHER.map(([language, input]) => [language, input]),
];

describe('toSpeech: the promises it keeps', () => {
	it('changes nothing the second time: every row of the table, run through it again', () => {
		for (const [language, input] of everyRow) {
			const once = toSpeech(input, language);
			assert.equal(toSpeech(once, language), once, `${language}: ${JSON.stringify(input)}`);
		}
	});

	it('leaves no digit in Turkish or English', () => {
		for (const [language, input] of everyRow) {
			if (language !== 'tr' && language !== 'en') continue;
			assert.doesNotMatch(toSpeech(input, language), /[0-9]/u, `${language}: ${JSON.stringify(input)}`);
		}
	});

	it('takes anything, and gives back nothing only when nothing can be said', () => {
		for (const language of ['tr', 'en', 'de', null, undefined, 42]) {
			assert.equal(toSpeech('', language), '');
			assert.equal(toSpeech('   ', language), '');
			assert.equal(toSpeech(null, language), '');
			assert.equal(toSpeech(undefined, language), '');
			assert.equal(toSpeech('😀👍', language), '', 'emoji alone: nothing to say');
			assert.equal(toSpeech('<:kedi:123456789012345678>', language), '', 'a Discord emoji alone');
			assert.equal(typeof toSpeech({ toString: () => 'obje' }, language), 'string');
		}
		assert.equal(toSpeech(42, 'tr'), 'kırk iki');
		assert.equal(toSpeech('merhaba', 'tr'), 'merhaba', 'plain words stay exactly as they are');
		assert.equal(toSpeech('Hello there.', 'en'), 'Hello there.');
	});

	it('reads the language the way the request names it', () => {
		assert.equal(speechLanguage('tr-TR'), 'tr');
		assert.equal(speechLanguage('EN'), 'en');
		assert.equal(speechLanguage('en_US.UTF-8'), 'en');
		assert.equal(speechLanguage('de'), null);
		assert.equal(speechLanguage('auto'), null);
		assert.equal(toSpeech('%20', 'tr-TR'), 'yüzde yirmi');
		assert.equal(toSpeech('20%', 'EN'), 'twenty percent');
	});

	it('is quick enough to run on every sentence', () => {
		const lines = everyRow.map(([language, input]) => [language, `${input} ${input}`]);
		const started = performance.now();
		let calls = 0;
		while (calls < 2000) {
			for (const [language, input] of lines) {
				toSpeech(input, language);
				calls++;
			}
		}
		const perCall = (performance.now() - started) / calls;
		assert.ok(perCall < 2, `${perCall.toFixed(3)} ms a sentence`);
	});
});

describe('number words', () => {
	it('never says "bir yüz" or "bir bin", and says "bir milyon"', () => {
		for (let n = 1; n <= 20_000; n += n < 2000 ? 1 : 7) {
			const words = spellNumber(n, 'tr');
			// "on bir bin" (11 000) and "yüz bir bin" (101 000) are right; a group that is just one is not.
			assert.doesNotMatch(words, /(?:^|(?:bin|milyon|milyar) )bir (?:yüz|bin)(?:\s|$)/u, `${n}: ${words}`);
			assert.doesNotMatch(words, /\s{2}|^\s|\s$/u, `${n}: ${JSON.stringify(words)}`);
		}
		assert.equal(spellNumber(1_000_000, 'tr'), 'bir milyon');
		assert.equal(spellNumber(1_001_000, 'tr'), 'bir milyon bin');
		assert.equal(spellNumber(123_456_789, 'tr'), 'yüz yirmi üç milyon dört yüz elli altı bin yedi yüz seksen dokuz');
		assert.equal(spellNumber(123_456_789, 'en'), 'one hundred twenty-three million four hundred fifty-six thousand seven hundred eighty-nine');
		assert.equal(spellNumber(1_000_000_000_000, 'en'), 'one trillion');
	});

	it('spells every English number from 1 to 20 000 with its hyphens and without gaps', () => {
		for (let n = 1; n <= 20_000; n += n < 2000 ? 1 : 7) {
			const words = spellNumber(n, 'en');
			assert.doesNotMatch(words, /\s{2}|^\s|\s$|--|\s-|-\s/u, `${n}: ${JSON.stringify(words)}`);
			if (n % 100 > 20 && n % 10) assert.match(words, /\p{L}-\p{L}+$/u, `${n}: ${words}`);
		}
	});
});

// The property the voice depends on, over text nobody wrote on purpose: whatever it is given, it does not
// throw, it leaves no digit behind in Turkish or English, and a second run changes nothing. The digits a
// language without a table keeps are kept on purpose (see OTHER above); a digit that is not ASCII (Arabic-
// Indic, say) is not a Turkish or English number and is left as it is, so only 0-9 are looked for.
describe('toSpeech on random text', () => {
	let seed = 20_260_927;
	const random = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	const PIECES = [
		'0', '1', '2', '3', '5', '9', '12', '100', '1000', '2026', '0532', '99', '07', '1.250', '3,5', '1.5', '14:45', '9.30', '24.09.2026',
		'2026-09-24', '%', '$', '€', '£', '₺', 'TL', 'km', 'GB', 'x', '×', '+', '=', '-', '–', '—', '/', '.', ',', ':', ';', '!', '?',
		'...', '…', "'", '’', '"', '(', ')', '*', '**', '_', '#', '@', '&', '~', '°', '°C', '²', '½', '①', ' ', ' ', ' ', '\n', 'a', 'b',
		'İ', 'ı', 'I', 'Ş', 'ç', 'e', 'te', 'da', "'te", "'si", 'st', 'nd', 'th', 'üncü', 'nci', 'v', 'mp', 'COVID', 'Dr.', 'vb.', 'e.g.',
		'etc.', 'No.', 'pm', 'am', ' PM', 'Eylül', 'September', 'May', '😀', '👍🏽', '🇹🇷', '❤️', ZWSP, BELL, 'http://x.io/a', 'a@b.co',
		'```', '`', '<@123>', ':)', '<3', 'xD', 'ŞİMDİ', 'ÇOK', 'GÜZEL',
	];
	const junk = () => Array.from({ length: 1 + Math.floor(random() * 12) }, () => PIECES[Math.floor(random() * PIECES.length)]).join('');

	it('never throws, leaves no digit in Turkish or English, and changes nothing the second time', () => {
		for (let i = 0; i < 3000; i++) {
			const input = junk();
			for (const language of ['tr', 'en', 'de']) {
				const once = toSpeech(input, language);
				assert.equal(typeof once, 'string');
				if (language !== 'de') assert.doesNotMatch(once, /[0-9]/u, `${language}: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`);
				assert.equal(toSpeech(once, language), once, `${language}: ${JSON.stringify(input)}`);
			}
		}
	});

	it('always has something to say for words and numbers, whatever stands between them', () => {
		const WORDS = ['merhaba', 'hello', '3', '2026', '%50', '14:45', '$3.99', "3'te", 'COVID-19', 'Dr.', 'İyi', 'ok'];
		const GLUE = [' ', ', ', '. ', ' - ', ' / ', ' & ', '! ', '... ', ' (', ') ', ' **', '** ', ' 😀 '];
		for (let i = 0; i < 1000; i++) {
			let input = WORDS[Math.floor(random() * WORDS.length)];
			for (let j = Math.floor(random() * 5); j > 0; j--) input += GLUE[Math.floor(random() * GLUE.length)] + WORDS[Math.floor(random() * WORDS.length)];
			for (const language of ['tr', 'en', 'de']) assert.notEqual(toSpeech(input, language), '', `${language}: ${JSON.stringify(input)}`);
		}
	});
});
