### Fixed

- **Geç render edilen Teams toplantı konusu artık kaybolmuyor.** Konu, bot toplantıya kabul edildiği anda
  bir kez okunuyordu; Teams toplantı arayüzünü yerleştirdikten sonra konuyu yazdığı için bu tek okuma
  boş dönüyor ve adı olan bir toplantı listede çıplak bir numara olarak kalıyordu. Bot artık toplantı
  boyunca (5 sn'de bir, 2 dakika boyunca) konuyu sormaya devam ediyor ve bulduğunu kapanış olayında
  taşıyor; meeting-api platform başlığını yalnızca satırda hiç başlık yokken kabul ettiği için bu, ne
  kullanıcının yazdığı adı ne de kabul anında okunan adı ezer.
