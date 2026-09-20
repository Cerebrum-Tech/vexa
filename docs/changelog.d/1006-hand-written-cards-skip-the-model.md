### Changed

- **Kişi, şirket ve not kayıtları artık doğrudan yazılıyor — model devrede değil.** Formu dolduran kişi
  kaydın kendisini yazmıştır; bunu bir dil turundan geçirmek, girdiyi yeniden üretmek için çıkarım
  harcamak demekti ve canlı çalışma alanlarının gösterdiği gibi bazen girdiyi değil başka bir şeyi, bazen
  de hiçbir şeyi üretiyordu. Yeni `POST /api/workspace/entity` uçları başlığı ve metni olduğu gibi
  dosyaya yazıyor; yazma işini özet düzenlemesinin kullandığı deterministik worker yapıyor (aynı kilit,
  aynı sembolik bağlantı reddi, aynı commit doğrulaması), ve kaydedildi denmeden önce diske düşen baytlar
  beklenenle karşılaştırılıyor.
- **İş Ortağı Notları arayüzden kaldırıldı.** Kenar çubuğunda elle doldurulmayan bir kart türü için ayrı
  bir dizin duruyordu; toplantı asistanının yazdığı notlar kendi varlık sayfalarından okunmaya devam ediyor.
- **Sohbet her açılışta boş başlıyor.** Ana ekran en son konuşulanı geri getiriyordu; artık yeni bir sohbet
  açılıyor ve önceki sohbetler sohbet başlığındaki listeden bir tıkla erişilebiliyor.

### Fixed

- **Adlandırılmamış bir kanal artık rapora "Speaker" adlı bir katılımcı olarak geçmiyor.** Kalıcı
  transkriptin her satırı gerçek bir ad taşırken, kopilotun akışında adı çözülmemiş birkaç parça
  `Speaker` etiketiyle kalıyor ve rapor bunu bir kişi sanıp aksiyon sahibi yapıyordu (toplantı 138:
  `Sorumlu: Speaker`). Bu satırlar artık `?` ile geliyor ve istem, onları kimseye atfetmemeyi,
  adlandırmamayı ve rapora yazmamayı açıkça söylüyor; konuşmacı başına okuma da bu kanalları atlıyor.
- **Başarısız bir liste yenilemesi artık ekrandaki kayıtları silmiyor.** Dizin her 30 saniyede ve her
  kayıttan sonra yeniliyor; yenileme başarısız olduğunda kod listeyi boşaltıp hata basıyordu — yeniden
  başlayan bir arka uç dolu bir sayfayı siliyor, ve kaydedilmiş bir kart hemen ardından başarısız gibi
  okunuyordu. Artık kayıtlar kalıyor, mesaj bunun son başarılı okumadan geldiğini söylüyor; listelenemeyen
  bir çalışma alanı yalnızca kendi kartlarını düşürüyor.
