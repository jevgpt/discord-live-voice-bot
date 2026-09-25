// keywords strings (tr). Keys are referenced as "keywords.<key>" through src/i18n.
//
// This namespace holds the speech-matching language data: the owner-gate keyword table, mention and
// permission vocabularies, colour names and audit-log labels. The gate compares these words against
// what was actually heard, so they must be real words of THIS locale, not translations of the keys.
export default {
	// Ways of saying "the private conversation we just had" (delete_messages / edit_message dm argument).
	// "Bana yaz", "benim rollerim", "beni aşağı al": bunlar isim değil, konuşan kişinin kendisi.
	// Yalnızca gerçek bir isim eşleşmediğinde bakılır, yani "Ben" takma adlı biri kendi adını kaybetmez.
	self_words: ['ben', 'bana', 'beni', 'bende', 'benim', 'benimki', 'kendim', 'kendime', 'kendimi'],
	last_dm_words: ['son', 'sonuncu', 'o', 'onu', 'az onceki', 'az önceki', 'biraz onceki'],
	// How the bot's own status line and online state may be spoken (src/tools/identity.js).
	presence_status: {
		online: ['cevrimici', 'çevrimiçi', 'aktif', 'online'],
		idle: ['bosta', 'boşta', 'uzakta', 'idle'],
		dnd: ['rahatsiz etmeyin', 'rahatsız etmeyin', 'mesgul', 'meşgul', 'dnd'],
		invisible: ['gorunmez', 'görünmez', 'cevrimdisi', 'çevrimdışı', 'gizli'],
	},
	presence_activity: {
		playing: ['oynuyor', 'oyun', 'oynuyorum'],
		listening: ['dinliyor', 'dinliyorum', 'dinleme'],
		watching: ['izliyor', 'izliyorum', 'izleme'],
		competing: ['yarisiyor', 'yarışıyor'],
		streaming: ['yayinda', 'yayında', 'yayin'],
		custom: ['ozel', 'özel', 'kisisel', 'kişisel', 'ozel durum', 'özel durum', 'kisisel durum', 'kişisel durum'],
	},
	no_picture_words: ['yok', 'kaldir', 'kaldır', 'sil', 'temizle', 'kapat'],
	// Spoken ways of saying "do not put this channel in any category" (edit_channel parent).
	no_category_words: ['yok', 'kategorisiz', 'hicbiri', 'kategori disi', 'disari', 'en ust', 'ust seviye', 'bagimsiz'],
	// Spoken and written spellings of on/off, beyond the universal 1/0/true/false/yes/no set.
	bool_true: ['evet', 'acik', 'açık', 'ac', 'aç', 'aktif', 'tamam', 'olur'],
	bool_false: ['hayir', 'hayır', 'kapali', 'kapalı', 'kapat', 'kapa', 'pasif', 'yok'],
	// Which tails a "=stem" gate keyword may pick up before it stops being that word. Turkish glues the
	// whole mood onto the verb, so "cek" is heard as "ceksene", "cekelim", "cekebilir misin", "cektim",
	// "cekiversene" -- an exact-word test misses every one of them. The shape is: optional ability
	// ("-ebil") or hurry ("-iver") infix, then one mood/tense suffix, then an optional person ending;
	// a person ending alone is not enough, which is what keeps "cekler" and "atlar" out. Everything is
	// matched against the normalised (ASCII, lower-case) tail, so "ı/i" and "u/ü" collapse into one.
	// Words that do not fit -- "cekirdek", "cekingen", "gecen", "gecmis", "alan", "atlas" -- stay out.
	// The negative in Turkish is -ma/-me glued straight onto the verb, so the negated word contains the
	// positive one: "silme" (do not delete) starts with "sil" (delete). Matched against the tail AFTER a
	// keyword; when it matches, the word does not count as the command. -meli/-mali (should) and
	// -mek/-mak (the infinitive) begin the same way and are not negatives, so they are excluded. Before
	// -iyor the negative loses its vowel ("silmiyorum", "onaylamiyorum"), so -miyor/-muyor is one too;
	// -mis (the reported past, "silmis") is not.
	// A verb made from a noun takes -la/-le before the negative: "banlama" and "yasaklama" are "ban" and
	// "yasak" with "do not" glued on through it, and a prefix match on the noun read them as the command.
	// The verbal noun is built with the same -ma/-me and is not a negative at all: "silmeni istiyorum" (I
	// want you to delete it), "silmen lazim", "silmesini", "silmeyi". Its possessive and case endings
	// (-n, -ni, -niz, -si, -sini, -yi, -ye...) are let through; the negative forms that begin the same way
	// ("silmesin", "silmeyin", "silmem") are not among them. A bare "silme" can be either, and stays a no.
	negation: {
		pattern: '^(?:l[ae])?m(?:[ae](?![lk])(?!(?:n(?:[iu](?:z(?:[iu]|[ea])?|n)?|[ea]|d[ea]n)?|s[iu](?:n(?:[iu]|[ea]|d[ea]n))?|y(?:[iu]|[ea]))$)|[iu]yor)',
		flags: 'u',
	},
	// The shape of a whole word that is a negated verb, whatever the verb: "silme", "banlama", "yapmayin",
	// "yapmasan", "olmaz", "yapmadi", "yapmayacagim", "yapmamalisin", "onaylamiyorum". An answer can say
	// no with the verb it is about ("tamam, banlama": okay, do not ban), and that verb is in no word list,
	// so a word of this shape is a no in the owner's answer. A noun that happens to end the same way
	// ("sinema") reads as a no too, which only ever costs a question asked again.
	negative_word: {
		pattern:
			'^[a-z]{2,}m(?:[ae](?:y[iu]n(?:[iu]z)?|s[ae]n(?:[ae]|[iu]z[ae])?|s[iu]n(?:l[ae]r)?|y[ae]l[iu]m|z(?:s[iu]n(?:[iu]z)?|[iu]z|l[ae]r)?|d[iu](?:m|n|k|n[iu]z|l[ae]r)?|y[ae]c[ae][kg][a-z]*|m[ae]l[iu][a-z]*)?|[iu]yor[a-z]*)$',
		flags: 'u',
	},
	inflection: {
		pattern:
			'^(?:[ea]bil|[iu]ver)?(?:(?:s[ea]n(?:[ea]|[iu]z[ea])?|s[iu]n(?:[iu]z)?|[iu]n(?:[iu]z)?|[ea]lim|[ea]yim|[ea]c[ea]k|[iu]yor|[eaiu]r|[dt][iu])(?:m|n|k|z|[iu]m|[iu]z|s[iu]n(?:[iu]z)?|l[ea]r)?)?$',
		flags: 'u',
	},
	// Turkish builds its words by gluing, so a plain entry stays a prefix ("banla" -> "banlasana"); the
	// English whole-word forms do not apply here.
	word_forms: null,
	// Words that begin with a keyword and are something else. A prefix match reads "banyo" as "ban" and
	// "odak" as "oda"; worse, "bana" (to me) begins with "ban" and "konusalim" with "konu", so ordinary
	// speech was opening the ban and thread tools. A heard word that begins with one of these does not
	// count as the shorter keyword it starts with (a keyword that is itself this long is unaffected). The
	// answer words below are read the same way, so "tamamen" is not "tamam" and "hayirli olsun" not "hayir".
	lookalikes: [
		'bana', 'banyo', 'bank', 'bant', 'band', 'banal', 'banliyo',
		'odak',
		'silah', 'silik', 'silgi', 'silindir', 'silo', 'silu', 'silk',
		'konus', 'konum', 'konuk',
		'toplanti', 'indirim', 'tasit', 'kanaliz', 'baglanti', 'logo', 'model', 'modern', 'modem', 'adil',
		'sesli', 'seslen',
		'cikartma', 'tamamen', 'tamamla', 'hayirli', 'aslan',
	],
	// Set phrases that hold a command word and ask for nothing (see the English table). The prefix match
	// and the look-alikes above already cover what Turkish has of these.
	phrase_lookalikes: [],
	// Owner-gate keywords: for an admin tool to run, the owner must have said one of these words.
	// An entry of three letters or more matches as a prefix ("ban" also matches "banla"); an entry
	// written as "=word" is a stem and matches only itself plus the inflections above. Everyday words
	// that would swallow half of ordinary speech as a prefix are written as stems ("=kov": "kovsana",
	// not "kova" or "kovala"), so "the owner said the command word" stays meaningful without losing
	// "ceksene". "affet" (forgive me) is left out of the ban words for the same reason as the English
	// "forgive", and "kaldir" with it: lifting a ban is said with the ban word itself ("banini kaldir",
	// "yasagini kaldir"). Destructive tools gate on the verb (sil, iptal, at, ban), never on the thing.
	words: {
		ban: ['ban', 'banla', 'unban', 'yasak', 'yasakla', 'yasag'],
		kick: ['kick', 'at', '=kov', 'cikar'],
		timeout: ['timeout', 'sustur', 'mute'],
		role: ['rol', 'yetki'],
		voice: ['ses', 'sesini', 'voice', 'mikrofon', 'mute'],
		setting: ['ayar', 'setting', 'mod', 'modu', 'modunu', '=sus', 'sessiz', 'sessizlik', '=kes', '=kapa', '=konusabilir', '=edebilir', '=konus', 'devam', 'quiet', 'yasak', '=ac', 'birak', 'kaldir'],
		delete: ['sil', 'temizle', 'kaldir'],
		cancel: ['iptal', 'sil', 'kaldir'],
		prune: ['prune', 'temizle', 'ayikla', '=kov', 'at'],
		channel: ['kanal', 'oda', 'kategori', 'kilit', 'kilitle'],
		name: ['nick', 'nickname', 'isim', 'ismi', 'takma', 'adi', 'adin', 'kullanici'],
		invite: ['davet', 'invite', 'link'],
		log: ['log', 'kayit', 'denetim'],
		move: [
			'tasi', 'tasin', 'getir', 'surukle', 'gecir', 'gecin', 'gecsin', 'gotur', 'gonder', 'gitsin', 'gidin',
			'gidelim', 'indir', 'cikar', 'cikart', 'aktar', 'yolla', 'topla', 'toplan', 'davet', '=cek', '=al',
			'=at', '=gec', '=git', '=in', '=kat',
		],
		everyone: ['herkes', 'herkesi', 'everyone', 'here', 'buradakiler', 'etiketle', 'duyuru'],
		forget: ['unut', 'sil', 'forget'],
		record: ['kayit', 'kaydi', 'dokum', 'gizlilik'],
		bot: ['bot', 'botu', 'botuna', 'botla', 'robot'],
		thread: ['thread', 'konu', 'alt baslik', 'altbaslik', 'tartisma'],
		pin: ['sabit', 'sabitle', 'pinle', 'pin', 'tuttur'],
		reaction: ['tepki', 'reaksiyon', 'emoji tepki'],
		emoji: ['emoji', 'emote', 'cikartma', 'sticker', 'ifade'],
		event: ['etkinlik', 'event', 'takvim', 'planla'],
		automod: ['otomod', 'automod', 'otomatik moderasyon', 'filtre', 'kural'],
		webhook: ['webhook', 'kanca'],
		server: ['sunucu', 'server', 'temizle', 'prune', 'widget', 'banner'],
		identity: [
			'avatar', 'banner', 'profil', 'takma', 'nick', 'durum', 'oynuyor', 'gorunum', 'resim', 'hakkinda',
			// "kendi ismini degistir" was refused because not one of these words is a name. Turkish drops the
			// vowel in the possessive (isim -> ismi), so the bare stem never matches what is actually said.
			'biyografi', 'isim', 'ismi', 'adi', 'adin', 'kullanici',
		],
		permission: [
			'yetki', 'izin', 'erisim', 'kanal', 'oda', 'kilit', 'baglan', 'girebil', 'giremes', 'girsin', 'girmesin',
			'gorebil', 'goremes', 'gorsun', 'gormesin', 'yazabil', 'yazamas', 'yazsin', 'yazmasin', 'konusabil', 'konusamas',
		],
	},

	// The owner's answer to a two-step confirmation ("Sam'i banlayayim mi?"). A yes counts only when the
	// owner's words since the question hold one of these and none of the no words. A yes word with the
	// negative glued on ("yapma", "onaylamiyorum") is read as a no, and so is any negated verb at all
	// (negative_word above): in "tamam, banlama" the no is on the verb, not on the yes. "degil" says no
	// to the word before it ("kesinlikle degil"), and "kalsin" (let it stay) is a no to changing it.
	// "onayliyor" is listed on its own because the a of "onayla" drops before -iyor. "iptal" and "unut"
	// are no words except when they are the verb of the thing being asked about: "evet, iptal et" to
	// "etkinligi iptal edeyim mi?" is a yes, because the question's own command words are not read as a no.
	confirm_yes: [
		'=evet', '=onay', 'onayla', 'onayliyor', 'tamam', '=olur', '=yap', 'aynen', 'kesinlikle', '=tabii', '=tabi',
		'elbette', '=peki',
	],
	confirm_no: [
		'hayir', '=yok', 'vazgec', '=dur', 'bekle', 'olmaz', '=etme', 'istemiyorum', '=istemem', '=sakin', 'asla',
		'degil', 'kalsin', 'iptal', 'unut', 'bosver', 'bos ver',
	],

	// Mention resolution: names that mean the whole channel rather than one member.
	everyone_mention_words: ['everyone', 'herkes', 'everyone.', 'tümü', 'tumu'],
	here_mention_words: ['here', 'burada', 'buradakiler'],
	// Extra spellings fed to the name -> mention replacement, so "@everyone" is not written twice.
	everyone_mention_variants: ['everyone', 'herkes'],
	here_mention_variants: ['here', 'buradakiler'],

	// Relative voice-channel targets ("the room below") and which of them mean "upwards".
	relative_target_words: ['alt', 'aşağıdaki', 'asagidaki', 'alt oda', 'alt kanal', 'üst', 'ust', 'yukarıdaki', 'yukaridaki', 'üst oda', 'üst kanal'],
	relative_up_words: ['üst', 'ust', 'yukar'],

	// Spoken colour names -> colour value, used when creating or editing a role.
	color_names: {
		kirmizi: 0xed4245,
		mavi: 0x3498db,
		yesil: 0x57f287,
		sari: 0xfee75c,
		mor: 0x9b59b6,
		turuncu: 0xe67e22,
		pembe: 0xeb459e,
		beyaz: 0xffffff,
		siyah: 0x000000,
		gri: 0x95a5a6,
	},

	// Audit-log entries: Discord enum name -> readable label.
	audit_actions: {
		MemberBanAdd: 'banlama',
		MemberBanRemove: 'ban kaldırma',
		MemberKick: 'atma (kick)',
		MemberMove: 'sesli kanal taşıma',
		MemberDisconnect: 'sesli kanaldan atma',
		MemberUpdate: 'üye güncelleme',
		MemberRoleUpdate: 'rol değişikliği',
		MemberTimeout: 'susturma (timeout)',
		MessageDelete: 'mesaj silme',
		MessageBulkDelete: 'toplu mesaj silme',
		MessagePin: 'mesaj sabitleme',
		MessageUnpin: 'sabitlemeyi kaldırma',
		ChannelCreate: 'kanal açma',
		ChannelUpdate: 'kanal güncelleme',
		ChannelDelete: 'kanal silme',
		RoleCreate: 'rol oluşturma',
		RoleUpdate: 'rol güncelleme',
		RoleDelete: 'rol silme',
		InviteCreate: 'davet oluşturma',
		InviteDelete: 'davet silme',
	},

	// Channel permissions: the "everyone" target of a permission change.
	permission_everyone_words: ['herkes', 'herkese', 'everyone', 'here', 'hepsi', 'tum uyeler', 'butun uyeler', 'default', 'varsayilan'],

	// Permission names that can be said out loud -> discord.js PermissionFlagsBits key. Dangerous,
	// server-wide permissions (Administrator, ManageRoles, ManageGuild, ManageWebhooks, Ban/Kick) are
	// deliberately absent: they cannot be handed out by voice.
	permission_aliases: {
		ViewChannel: ['gor', 'gorme', 'goruntule', 'goruntuleme', 'goster', 'gorsun', 'gorunur', 'gorunurluk', 'view', 'view channel', 'see'],
		Connect: ['baglan', 'baglanma', 'baglansin', 'baglanti', 'gir', 'giris', 'girme', 'girsin', 'katil', 'katilma', 'connect', 'join'],
		Speak: ['konus', 'konusma', 'konussun', 'speak', 'ses', 'mikrofon'],
		SendMessages: ['yaz', 'yazma', 'yazsin', 'mesaj', 'mesaj gonder', 'mesaj gonderme', 'mesaj yaz', 'send', 'send messages'],
		ReadMessageHistory: ['gecmis', 'gecmisi oku', 'mesaj gecmisi', 'read message history', 'history'],
		AttachFiles: ['dosya', 'dosya ekle', 'dosya gonder', 'attach', 'attach files'],
		EmbedLinks: ['link', 'link ekle', 'embed', 'embed links'],
		AddReactions: ['tepki', 'tepki ver', 'emoji tepki', 'reaction', 'add reactions'],
		Stream: ['yayin', 'yayin ac', 'ekran paylas', 'ekran paylasimi', 'kamera', 'video', 'stream'],
		UseVAD: ['ses aktivitesi', 'vad', 'use vad'],
		PrioritySpeaker: ['oncelikli konusmaci', 'priority speaker'],
		MuteMembers: ['sustur', 'susturma', 'mute', 'mute members'],
		DeafenMembers: ['sagirlastir', 'deafen', 'deafen members'],
		MoveMembers: ['tasi', 'tasima', 'move', 'move members'],
		ManageMessages: ['mesaj yonet', 'mesajlari yonet', 'mesaj sil', 'manage messages'],
		ManageChannels: ['kanal yonet', 'kanali yonet', 'kanal duzenle', 'manage channels', 'manage channel'],
		MentionEveryone: ['herkesi etiketle', 'everyone etiketle', 'mention everyone'],
		CreatePublicThreads: ['alt baslik', 'thread', 'thread ac', 'konu ac', 'create public threads'],
		SendMessagesInThreads: ['thread yaz', 'send messages in threads'],
		UseApplicationCommands: ['komut', 'slash', 'slash komut', 'use application commands'],
		UseExternalEmojis: ['dis emoji', 'external emojis', 'use external emojis'],
		CreateInstantInvite: ['davet', 'davet olustur', 'create instant invite', 'invite'],
	},
	// Groups: one word, several permissions.
	permission_groups: {
		erisim: ['ViewChannel', 'Connect', 'SendMessages'],
		access: ['ViewChannel', 'Connect', 'SendMessages'],
		giris: ['ViewChannel', 'Connect'],
	},
	// Spoken labels for a permission, used when reading a permission change back out loud.
	permission_labels: {
		ViewChannel: 'görme',
		Connect: 'bağlanma',
		Speak: 'konuşma',
		SendMessages: 'yazma',
		ReadMessageHistory: 'geçmişi okuma',
		AttachFiles: 'dosya ekleme',
		EmbedLinks: 'link ekleme',
		AddReactions: 'tepki verme',
		Stream: 'yayın açma',
		UseVAD: 'ses aktivitesi',
		PrioritySpeaker: 'öncelikli konuşma',
		MuteMembers: 'susturma',
		DeafenMembers: 'sağırlaştırma',
		MoveMembers: 'taşıma',
		ManageMessages: 'mesaj yönetme',
		ManageChannels: 'kanal yönetme',
		MentionEveryone: 'herkesi etiketleme',
		CreatePublicThreads: 'thread açma',
		SendMessagesInThreads: "thread'e yazma",
		UseApplicationCommands: 'slash komut',
		UseExternalEmojis: 'dış emoji',
		CreateInstantInvite: 'davet oluşturma',
	},
	permission_help: 'gör, bağlan, konuş, yaz, geçmiş, dosya, link, tepki, yayın, sustur, taşı, mesaj yönet, kanal yönet, davet, erişim (= gör + bağlan + yaz)',
};
