// config strings (tr). Keys are referenced as "config.<key>" through src/i18n.
export default {
	missing_env_one: 'Eksik ortam değişkeni: {keys} (.env dosyasına bak; şablon: .env.example)',
	missing_env_many: 'Eksik ortam değişkenleri: {keys} (.env dosyasına bak; şablon: .env.example)',
	// Spellings of on and off for a boolean .env setting. The lists of every bundled language are
	// accepted whatever BOT_LANGUAGE is, so the same .env means the same thing in every language; a value
	// on neither list keeps the setting's default and is reported at start.
	on_words: ['1', 'true', 'yes', 'on', 'evet', 'açık', 'acik'],
	off_words: ['0', 'false', 'no', 'off', 'hayır', 'hayir', 'kapalı', 'kapali'],
	// Values that mean "do not send this field at all" (effort/tier settings). Also accepted in every language.
	none_words: ['off', 'none', 'kapali', 'kapalı', '-'],
	// Printed once at start (boot.config_warning) for a value that was read as something other than what
	// was written. {key} is the variable, {value} what it held.
	warn_bool: '{key}={value} bir açık/kapalı değeri değil (1/0, true/false, evet/hayır, açık/kapalı); varsayılan kullanılıyor: {fallback}.',
	warn_number: '{key}={value} bir sayı değil; varsayılan kullanılıyor: {fallback}.',
	warn_below: '{key}={value} alt sınırın altında, bu yüzden {limit} kullanılıyor.',
	warn_above: '{key}={value} üst sınırın üstünde, bu yüzden {limit} kullanılıyor.',
	warn_choice: '{key}={value} şunlardan biri değil: {choices}; {fallback} kullanılıyor.',
	warn_intent: "{key}={value} ne auto ne de bir açık/kapalı değeri; intent Developer Portal'dan okunuyor (auto).",
	warn_snowflake: '{key}: "{value}" bir Discord kimliği değil (17-20 haneli bir sayı olmalı), bu yüzden hiçbir şeyle eşleşmez.',
	warn_target_pair: '{key}: "{entry}" bir sunucuId:kanalId çifti değil, atlanıyor.',
	warn_target_repeat: '{key}: {guild} sunucusu zaten {channel} kanalıyla listede; "{entry}" atlanıyor.',
	warn_language: 'BOT_LANGUAGE={value} desteklenen dillerden biri değil ({supported}); {fallback} kullanılıyor.',
	// Fallback persona, joined with spaces. Sets the language the assistant speaks.
	default_instructions: [
		'Sen bir Discord ses kanalında yaşayan, Türkçe konuşan bir sesli asistansın.',
		'Kanalda birden fazla kişi olabilir; konuşulanları duyduğun kadarıyla anlarsın ve doğal karşılık verirsin.',
		'Cevapların kısa ve konuşma diline uygun olsun; genelde 1-3 cümle. Madde listesi okuma, uzun nutuk çekme.',
		'Kanalda sesli iletişim var; araya girme, sıranı bekle. Sana seslenildiğinde ya da sana soru sorulduğunda cevap ver.',
	],
};
