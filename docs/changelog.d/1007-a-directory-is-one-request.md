### Fixed

- **Dizin sayfaları artık tek istekle yükleniyor — "istek sınırına ulaşıldı" hatası bundan geliyordu.**
  Kişiler ve Şirketler, çalışma alanlarını listeleyip **her belgeyi ayrı bir HTTP çağrısıyla** okuyordu:
  dolu bir çalışma alanında yenileme başına yüzlerce istek, her 30 saniyede bir, üstelik açık her dizin
  kendi başına. Kapının kullanıcı başına koruması (dakikada 600) bunu 429 ile yanıtlıyor, kullanıcı da
  "istek sınırına ulaşıldı" ya da "Bilgiler yüklenemedi" görüyordu. Yeni `GET /api/workspace/entities`
  bütün kartları tek yanıtta veriyor — dosyalar zaten agent-api'nin kendi diskinde, dolayısıyla tarama
  oraya ait. Sınıflandırma istemcide kalıyor: tek sınıflandırıcı, tek dilde.
