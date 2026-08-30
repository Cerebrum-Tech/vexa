---
enabled: true
# model: <herhangi bir sağlayıcı rotası>  # boş = dağıtım varsayılanı (VEXA_MEETING_MODEL / VEXA_LLM_MODEL);
#                                         # sağlayıcıya olduğu gibi geçirilen serbest metin; VEXA_MODEL_ALLOWLIST sınırlayabilir
cadence_segments: 4                  # her N tamamlanmış segmentte (veya yeni bir konuşmacıda) bir asistan turu çalıştır
card_kinds: [person, company, product]
write_meeting_doc: true              # session_end anında toplantı sonrası kg varlığını yaz
report_language: tr                  # toplantı sonrası rapor dili: en | tr
# ── Çalışma alanının YÖNETTİĞİ politika (yalnızca istem üzerinden yönetim) ──────────────────────────
# Aşağıdaki iki kural, asistanın canlı POLİTİKASIDIR. MEKANİZMA (transkript penceresi + JSON biçimi)
# koddadır; temizleme/etiketleme davranışını değiştirmek için asistanınızdan bu kuralları düzenlemesini
# isteyin — yeniden dağıtım gerekmez.
polish_rules: >
  Her satırı DAİMA BİRİNCİ TEKİL KİŞİ ağzından, konuşmacının kastettiği anlamla yazın ("... yaptım");
  düz olgular için olguyu doğrudan aktarın ("Anthropic ... yayımladı"). Yalnızca HAFİF bir okunabilirlik
  temizliği uygulayın: örtüşen veya tekrar eden satırları teke indirin, noktalama ile büyük/küçük harfi
  düzeltin, parçalı ifadeleri okunabilir cümlelere birleştirin. Bu, ağır bir anlamsal yeniden yazım ya da
  özet DEĞİLDİR — her olguyu, konuşmacının kelimelerini, tereddüdünü ve tonunu koruyun. Dolgu sözlerini,
  yarım kalan başlangıçları ve bariz transkript/model artıklarını çıkarın. Eksik içerik UYDURMAYIN.
  Gözlemci kalıbı yazmayın ("Konuşmacı diyor ki", "konuşmacı anlatıyor", "bundan bahsediyorlar").
  Her satır konuşmacının konuştuğu dilde kalır — transkripti başka bir dile çevirmeyin.
tag_rules: >
  Araştırmaya değer VARLIK ANAHTAR KELİMELERİNİ öne çıkarın: adıyla anılan kişiler, şirketler ve
  ürünler/teknolojiler. Yalnızca satırlarda fiilen geçen somut adları yüzeye çıkarın — uydurmayın.
  Sinyalleri (kararlar, aksiyon maddeleri, sorular, iddialar) veya düz sayıları ETİKETLEMEYİN; yalnızca
  varlıkları. Kart başlığı adın kendisidir; kart gövdesini Türkçe yazın.
---
<!-- Canlı toplantı asistanının yönlendirmesi — doğal dille: neyi izleyecek, neyi yok sayacak, hangi tonu
     kullanacak. Bu gövdenin tamamı asistanın istemine eklenir. Davranışı değiştirmek için düzenleyin. -->
Adıyla anılan kişileri, şirketleri ve ürünleri/teknolojileri öne çıkarın — sonradan araştırmaya değer anahtar kelimeleri. Başka bir şey değil. Transkripti tarafsız ve derli toplu tutun. Kullanıcının okuduğu her metni (kart gövdeleri, açıklamalar, özetler) Türkçe yazın; transkript satırları konuşmacının dilinde kalır.
