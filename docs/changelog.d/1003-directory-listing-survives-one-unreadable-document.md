### Fixed

- **Kişiler / Şirketler / İş Ortağı Notları listeleri tek bir okunamayan belgede boşalmıyor.** Bir dizin,
  çalışma alanındaki her aday belgeyi okuyup sınıflandırıyor; bu okumalardan biri başarısız olduğunda
  ekrandaki bütün kartlar siliniyor ve 30 saniyede bir yeniden siliniyordu. Artık her belge kendi başına
  başarısız oluyor, liste ayakta kalıyor.
- **Dizin taraması toplantı belgelerini atlıyor.** `kg/entities/meeting/` altındaki belgeler hiçbir zaman
  kişi, şirket veya not kaydı üretmiyor; dolu bir çalışma alanında sayıca hepsinden fazlalar ve hiç
  katılmayacakları listeyi geciktiriyorlardı.
- **Açık dizinin kendi klasörü önce okunuyor**, böylece kartları ekrana gelirken çalışma alanının geri
  kalanı hâlâ sınıflandırılıyor — kişilerle dolu bir alana eklenen bir not artık en son okunan belgelerden
  biri değil.
