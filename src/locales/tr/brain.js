// brain strings (tr). Keys are referenced as "brain.<key>" through src/i18n.
export default {
	// --- local brain: text model in the voice channel (src/localbrain.js)
	local_note: [
		'Bir Discord sesli kanalındasın; kulağın yerel bir konuşma tanıma (döküm hatalı olabilir, adın yanlış yazılmış olabilir), ağzın yerel bir ses sentezi.',
		'Ses üretimi yavaş: cevabın TEK kısa cümle olsun (en fazla ~15 kelime); gerekirse karşındaki devamını sorar. Madde işareti, liste, emoji yok.',
		'Bir şeyi bir kez söyle: kendini tekrar etme, senin ya da bir aracın zaten bildirdiği şeyi yeniden duyurma.',
		'Kanalda birden fazla kişi olabilir; her mesajın başında konuşanın adı verilir. Herkese aynı davranma.',
		'Küfür ve laf sokma çoğu zaman şaka: sen de kısa ve sert laf sokabilirsin ama açık cinsel isteği yapmaz, espriyle geçiştirirsin.',
		'Duyduğun her şey sana söylenmiş değildir: kanaldaki insanlar kendi aralarında konuşuyorsa o sohbet onların — cevap verme, araya girme. Sana yönelen bir şey varsa (adın, ya da sana sorulmuş bir istek/soru) konuş.',
		'Bir Discord işi istenirse (mesaj gönder, müzik çal, not al, rol/kanal işleri vb.) ilgili aracı çağır; sonucu bir cümleyle söyle.',
		'Aracı çağırmadan "yaptım/gönderdim" deme. Araç "ok:false" dönerse nedenini kısaca söyle.',
		'Yönetici araçları yalnızca sahip isterken çalışır; başkası isterse "bunu yalnızca sahip yapabilir" de.',
		'Bilmediğini uydurma; web araması yapamıyorsun, arama yapmış gibi davranma.',
	],
	local_wake_words: ['bot', 'asistan'],
	local_name_hint: 'Adın {name}; sana "{name}" diye seslenirler.',
	local_default_speaker: 'biri',
	local_no_text_provider: 'metin sağlayıcısı yok',
	local_error: 'yerel beyin hatası: {error}',
	// --- local speech recognition (src/localstt.js)
	stt_health_failed: 'yerel STT sağlık sorgusu başarısız: {error}',
	stt_error: 'yerel STT hatası ({status})',
	stt_error_detail: 'yerel STT hatası ({status}): {detail}',
	// --- Chatterbox server process (src/localserver.js)
	local_server_running: 'çalışıyor',
	local_server_off: 'kapalı',
	local_server_exited: 'kapandı (çıkış {code})',
	local_server_start_failed: 'başlatılamadı: {error}',
	local_server_no_venv: 'sanal ortam yok (tools/setup-chatterbox.ps1)',
	local_server_no_script: 'sunucu dosyası yok: {script}',
	local_server_gave_up: '{count} kez kapandı; elle başlat ve logu incele',
	local_server_starting: 'Chatterbox sunucusu başlatılıyor: {python} {script} {args}',
	local_server_spawn_failed: 'Chatterbox sunucusu çalıştırılamadı: {error}',
	local_server_exit_log: 'Chatterbox sunucusu kapandı (çıkış {code}); {count}/{max} deneme.',
	// --- local speech synthesis (src/localtts.js)
	tts_fallback_language: 'tr',
	tts_health_failed: 'yerel TTS sağlık sorgusu başarısız: {error}',
	speech_refused: '{url} adresindeki ses sunucusu isteği reddetti ({status}): LOCAL_TTS_TOKEN ve LOCAL_TTS_URL ayarlarını kontrol et ya da botun önceki bir çalışmasından açık kalmış sunucuyu kapat',
	tts_empty_text: 'boş metin',
	tts_error: 'yerel TTS hatası ({status})',
	tts_error_detail: 'yerel TTS hatası ({status}): {detail}',
	// --- latency metrics (src/latency.js)
	latency_seconds: '{value} sn',
	latency_summary: 'Yanıt gecikmesi: P50 {p50}, P90 {p90} ({count} yanıt)',
};
