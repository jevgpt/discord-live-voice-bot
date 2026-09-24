// commands strings (tr). Keys are referenced as "commands.<key>" through src/i18n.
//
// "slash" mirrors the slash command tree (command -> options / subcommands -> options). The names
// here are the Turkish names Discord shows to Turkish clients (setNameLocalizations); the registered
// identifiers come from the English bundle, so these values only change what a Turkish viewer reads.
export default {
	slash: {
		join: {
			name: 'katil',
			description: 'Sesli kanala katıl',
			options: {
				channel: { name: 'kanal', description: 'Sesli kanal (boş bırakırsan bulunduğun kanala katılır)' },
			},
		},
		leave: { name: 'ayril', description: 'Sesli kanaldan ayrıl' },
		panel: { name: 'panel', description: 'Karakter ve ses panelini açar' },
		character: {
			name: 'karakter',
			description: 'Aktif karakteri değiştir',
			options: { name: { name: 'isim', description: 'Karakter adı' } },
		},
		send: {
			name: 'gonder',
			description: 'Bir metin kanalına mesaj gönder',
			options: {
				channel: { name: 'kanal', description: 'Metin kanalı' },
				message: { name: 'mesaj', description: 'Mesaj' },
			},
		},
		read: {
			name: 'oku',
			description: 'Kanaldaki yeni mesajları sesli oku',
			options: {
				channel: { name: 'kanal', description: 'Metin kanalı' },
				count: { name: 'adet', description: 'En fazla kaç mesaj (1-10)' },
			},
		},
		status: { name: 'durum', description: 'Botun durumu' },
		help: { name: 'yardim', description: 'Sesli ve slash komutların listesi' },
		music: {
			name: 'muzik',
			description: 'Müzik çal / durdur / atla / ses',
			subcommands: {
				play: {
					name: 'cal',
					description: 'Şarkı çal ya da sıraya ekle',
					options: { query: { name: 'sorgu', description: 'Şarkı adı, sanatçı ya da link' } },
				},
				stop: { name: 'durdur', description: 'Müziği durdur ve sırayı temizle' },
				pause: { name: 'duraklat', description: 'Müziği duraklat' },
				resume: { name: 'devam', description: 'Müziğe devam et' },
				skip: { name: 'atla', description: 'Sıradaki parçaya geç' },
				volume: {
					name: 'ses',
					description: 'Müzik ses seviyesi',
					options: { percent: { name: 'yuzde', description: '0-100' } },
				},
				status: { name: 'durum', description: 'Ne çalıyor, sırada ne var' },
			},
		},
		summary: {
			name: 'ozet',
			description: 'Buradaki son konuşmaların özeti, okuyabildiğin kanallardan',
			options: { hours: { name: 'saat', description: 'Kaç saat geriye (varsayılan 3)' } },
		},
		recording: {
			name: 'kayit',
			description: 'Konuşma/mesaj kaydını aç-kapat (gizlilik)',
			options: {
				status: {
					name: 'durum',
					description: 'aç / kapat / durum',
					choices: { on: 'aç', off: 'kapat', status: 'durum' },
				},
			},
		},
	},

	help: [
		'**Sesli komutlar** (kanalda söylemen yeter):',
		'• "Aria karakterine geç" — karakter değiştir',
		'• "genel kanalına selam yaz" — metin kanalına mesaj gönder',
		'• "genel kanalında ne yazıyor" — kanalın yeni mesajlarını oku',
		'• "sohbet kanalına gel" — sesli kanala katıl · "kanaldan ayrıl"',
		'• "Tarkan Şımarık çal" / "müzik aç: …" — müzik çal · "müziği durdur / duraklat / devam" · "şarkıyı atla" · "müziği kıs / aç" · "ne çalıyor"',
		"• Sahip: \"X'i banla / sustur / rol ver / kanalı kilitle / şunu aklında tut / bugün ne konuşuldu\"",
		'',
		'**Slash komutları:** /katil /ayril /panel /karakter /gonder /oku /durum /muzik /ozet /kayit /yardim',
	],

	// The command came from a server the bot is not set up for (it is not in VOICE_TARGETS, or it was
	// left for good); /join is the way back in.
	no_guild_session: 'Bu sunucu için ayarlı değilim. Önce `/katil` ile bir sesli kanala çağır.',
	// /join in a server outside GUILD_ID/VOICE_TARGETS: a new session there is on the owner's keys, so
	// only the owner and ADMIN_USER_IDS may start one.
	join_unconfigured_denied: 'Bu sunucu için ayarlı değilim; beni yeni bir sunucuya yalnızca sahibim getirebilir.',

	log_registered: 'Slash komutları kaydedildi.',
	log_register_failed:
		'Slash komutları kaydedilemedi: {error}. Botu "applications.commands" scope\'u ile yeniden davet etmen gerekir.',
	log_interaction_error: 'Etkileşim hatası ({command}): {error}',
	error_generic: 'Bir hata oldu: {error}',
	gate_denied_activity: '{command}: reddedildi (yetkisiz)',
	gate_unconfigured_activity: '{guild} sunucusunda katılma: reddedildi (ayarlı bir sunucu değil; orada oturumu yalnızca sahip ya da ADMIN_USER_IDS açabilir)',

	modal_new_title: 'Yeni karakter',
	modal_edit_title: 'Düzenle: {name}',
	modal_name_label: 'Karakter adı',
	modal_prompt_label: 'Kişilik / talimat (prompt)',
	modal_voice_label: 'Ses (boş = varsayılan; liste panelde)',

	panel_title: 'Karakter paneli',
	panel_empty: 'Henüz karakter yok. "Yeni karakter" ile ekle.',
	panel_voice_suffix: ' · ses: {voice}',
	panel_voices_footer: 'Sesler: {voices}',
	panel_active_field: 'Aktif: {name}',
	panel_select_placeholder: 'Aktif karakteri seç',
	panel_no_prompt: 'prompt yok',
	button_new: 'Yeni karakter',
	button_edit: 'Düzenle',
	button_delete: 'Sil',
	button_refresh: 'Yenile',
	button_join: 'Kanalıma katıl',
	button_leave: 'Kanaldan ayrıl',
	button_delete_yes: 'Evet, sil',
	button_cancel: 'Vazgeç',

	join_no_channel: 'Bir sesli kanalda değilsin; `/katil kanal:#kanal` ile seç.',
	joined: '**{channel}** kanalına katıldım.',
	join_failed: 'Katılamadım: {error}',
	left: 'Sesli kanaldan ayrıldım.',

	character_not_found: '"{name}" diye kayıtlı karakter yok.',
	character_active: 'Aktif karakter: **{name}**',
	character_missing: 'Karakter bulunamadı.',
	character_gone: 'Karakter zaten yok.',
	character_created: '**{name}** oluşturuldu ve aktif.',
	character_updated: '**{name}** güncellendi.',
	character_deleted: '**{name}** silindi.',
	no_character_to_edit: 'Düzenlenecek karakter yok.',
	no_character_to_delete: 'Silinecek karakter yok.',
	delete_confirm: '**{name}** karakterini silmek üzeresin; bu geri alınamaz.',
	delete_cancelled: 'Silme iptal edildi.',
	saved: 'Kaydedildi.',
	voice_unknown: '"{voice}" bilinen bir ses değil. Seçenekler: {voices}',
	persona_reason_character: 'karakter: {character}',
	persona_reason_character_updated: 'karakter güncellendi: {character}',
	persona_reason_character_deleted: 'karakter silindi',

	sent: '**#{channel}** kanalına gönderdim.',
	send_failed: 'Gönderemedim: {reason}',
	read_failed: 'Okuyamadım: {reason}',
	reading: '#{channel} kanalından {count} mesaj okuyorum{suffix}.',
	reading_new_suffix: ' (yeni)',
	reading_private: 'Sesli kanaldaki herkes #{channel} kanalını okuyamıyor, o yüzden yalnızca sana gösteriyorum:\n{text}',

	status_voice: 'Sesli kanal: {channel}',
	status_voice_none: 'değil',
	status_brain: 'Beyin: {brain}',
	status_brain_local: 'yerel (whisper + metin modeli + Chatterbox)',
	status_live: 'GPT-Live oturumu: {state}',
	status_open: 'açık',
	status_closed: 'kapalı',
	status_voice_engine: 'Ses: {engine}{server}',
	status_voice_engine_local: 'yerel (Chatterbox)',
	status_chatterbox_server: ' · Chatterbox sunucusu: {url}',
	status_character: 'Karakter: {character}',
	status_character_default: 'varsayılan',
	status_music: 'Müzik: {music}',
	status_music_off: 'kapalı',
	status_record: 'Kayıt: {state}',
	status_record_on: 'açık',
	status_record_off: 'kapalı (dökümler yazılmıyor)',
	status_quota: 'Günlük GPT-Live kotası: {used} / {limit} dk',
	// Several servers at once: the report above is about this one, these lines are the others.
	status_sessions_header: '**Sunucular ({count}):**',
	status_session_line: '• {guild} — {channel} · {brain} · GPT-Live: {live}',

	music_disabled: 'Müzik özelliği kapalı (.env: MUSIC=1).',
	music_unknown: 'Bilinmeyen müzik komutu.',
	ok: 'Tamam.',
	failed: 'Olmadı.',
	summary_unavailable: 'Özet özelliği bu kurulumda yok.',
	summary_guild_only: 'Özeti sunucunun içinden iste: orada okuyabildiğin kanalları kapsar.',
	record_status:
		'Kayıt şu an {state}. (Kapalıyken ses dökümleri ve mesaj metinleri panel günlüğüne yazılmaz; özet çıkarılamaz.)',
	record_state_on: 'AÇIK',
	record_state_off: 'KAPALI',
	record_toggled: 'Kayıt {state}.',
	record_turned_on: 'açıldı',
	record_turned_off: 'kapatıldı',
	unknown_command: 'Bilinmeyen komut.',
};
