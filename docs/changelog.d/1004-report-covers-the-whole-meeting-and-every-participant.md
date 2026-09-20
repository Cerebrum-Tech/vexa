### Changed

- **Toplantı raporu artık toplantının tamamını ve her katılımcıyı kapsıyor.** Rapor istemi kısa bir özet
  yerine, konuşulan her konuyu kendi cümlesiyle — isimler, sayılar, tarihler korunarak — yazıyor ve
  üç bölümün ardından `## Katılımcı Özetleri` bölümünü ekliyor: her konuşmacı için ne raporladığı ve neyi
  üstlendiği. Okuyucu "bana ne düşüyor" sorusunu asistana sormadan raporun kendisinde bulur.
- **Konuşmacının kendi üstlendiği iş artık bir aksiyon.** `ben ... bakacağım` biçimindeki taahhütler
  aksiyon listesine giriyor ve sahibi o cümleyi söyleyen kişi oluyor — Türkçede sürekli kullanılan hitap
  (`Ozan abi`, `Mert Bey`) muhatabı gösterir, sahibi değil. Her aksiyon kendini kanıtlayan cümleyi
  birebir taşıyor, böylece atıf okunurken doğrulanabiliyor.
- **Rapor, konuşmacı başına bir okuma ile yazılıyor.** Transkript bütçeye sığdığında her konuşmacı için
  ayrı bir model çağrısı yapılıp ne raporladıkları ve neyi üstlendikleri çıkarılıyor; rapor bu
  çıkarımları transkriptle birlikte okuyor. Sığmayan bir toplantı bu adımı atlar — zaten özetlenmiş bir
  kanıtı konuşmacı sayısı kadar yeniden okumanın getirisi yok. Bir konuşmacının başarısız çağrısı yalnızca
  kendi bloğunu düşürür.
