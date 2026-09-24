// boot strings (tr). Keys are referenced as "boot.<key>" through src/i18n.
//
// Everything printed while the bot comes up: the configuration error before anything else exists,
// and the start-up summary written once the Discord client is ready.
export default {
	config_failed: 'Ayarlar okunamadı: {error}',
	// One line per setting that was not read as written (config.warn_*); the bot starts regardless.
	config_warning: 'Ayarlar: {warning}',

	panel_history: 'Panel geçmişi yüklendi: {count} olay (data/activity.jsonl).',
	joined_channel: '"{channel}" kanalına katıldım. Konuşulanlar dinleniyor.',
	voice_channel_missing: 'Sesli kanal bulunamadı ({channel}); /katil ile katılabilirsin.',
	message_baseline: 'Mesaj temeli alındı: {count} metin kanalı (sorulunca yalnızca yenileri okunur).',

	intents: "Intent'ler — presence: {presence}, üyeler: {members}, mesaj içeriği: {messageContent}",
	on: 'açık',
	off: 'kapalı',

	text_generation: 'Metin üretimi: {provider}.',
	tools_backend: 'Araçlar: Responses backend ({model}) — {count} araç + web araması.',
	tools_client: 'Araçlar: istemci delegasyonu — yalnızca regex sesli komutlar; RESEARCH_MODEL ayarlarsan tüm araçlar açılır.',

	owner_priority: 'Sahip önceliği açık: {owner} konuşurken yalnızca onun sesi işleniyor.',
	attribution_path:
		'Konuşmacı ataması: her satırda tek bir konuşmacı yolu (ATTRIBUTION=hmm); sıranın kenarındaki bir parça, kendi sesi aksini söylemedikçe komşularıyla gider.',
	attribution_vote: 'Konuşmacı ataması: her parça kendi sesine göre (ATTRIBUTION=vote).',
	no_owner_id: 'OWNER_ID ayarlı değil: sesli yönetici araçları (ban/rol/kanal/ayar) kapalı; slash yetkisi ManageGuild ile.',

	music_on: 'Müzik açık: ses %{volume}, konuşurken %{duck}{folder}.',
	music_folder: ', yerel klasör: {dir}',

	brain_local: 'Beyin: YEREL (whisper + metin modeli + Chatterbox); GPT-Live kullanılmayacak.',
	brain_auto: 'Beyin: GPT-Live; kredi/anahtar hatasında yerel beyne (whisper + DeepSeek + Chatterbox) düşer.',
	brain_live: 'Beyin: yalnızca GPT-Live.',

	chatterbox_autostart: 'Chatterbox sunucusu gerekince bot tarafından başlatılacak ({model}, whisper {stt}).',
	chatterbox_missing_venv: 'Chatterbox sanal ortamı bulunamadı (.venv-chatterbox); yerel ses için tools/setup-chatterbox.ps1.',

	daily_quota: 'Günlük GPT-Live kotası: {limit} dk (bugün {used} dk kullanıldı).',
	record_off: 'Kayıt KAPALI: ses dökümleri ve mesaj metinleri panel günlüğüne yazılmıyor.',
	memory_on: 'Hafıza açık: {users} kişi, {notes} not.',

	// One server of several could not be brought up; the rest carry on.
	guild_failed: '{guild} sunucusu hazırlanamadı: {error}',
	no_guilds: 'Hiçbir sunucu hazırlanamadı: hiçbir yeri dinlemiyorum. GUILD_ID / CHANNEL_ID / VOICE_TARGETS değerlerine bak.',
	member_index_failed: 'Üye hafızası yüklenemedi: {error}',
	panel_failed: 'Panel başlatılamadı: {error}',
	setup_failed: 'Kurulum başarısız: {error}',
	login_failed: 'Discord girişi başarısız: {error}',
};
