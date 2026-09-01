# Transcription servisini ayrı bir sunucuya kurma

Bu rehber, **yalnızca transcription (STT) konteynerinin** GPU'lu ayrı bir sunucuya alındığı
topolojiyi kurar. Yığının geri kalanı (gateway · terminal · meeting-api · agent-api · runtime ·
admin-api · postgres · redis · minio) uygulama sunucusunda CPU ile çalışmaya devam eder.

## 0. Topoloji

```
  UYGULAMA SUNUCUSU (CPU)                          GPU SUNUCUSU
  ┌────────────────────────────────┐               ┌──────────────────────────┐
  │ terminal · gateway · meeting-  │               │  transcription           │
  │ api · agent-api · runtime ·    │  HTTP POST    │  faster-whisper / CUDA   │
  │ admin-api · postgres · redis · │  multipart    │  :8000  (host :8083)     │
  │ minio                          │──────────────▶│                          │
  │                                │  Bearer token │  volume: model ağırlıkları│
  │ bot-<toplantı>  (efemer)       │               └──────────────────────────┘
  └────────────────────────────────┘
```

Trafik **tek yönlü**: sesi gönderen taraf, uygulama sunucusunda toplantı başına açılan **bot
konteyneridir** — GPU sunucusu ana yığına hiçbir zaman bağlanmaz. Bot her ses penceresini
`POST {TRANSCRIPTION_SERVICE_URL}/v1/audio/transcriptions` olarak multipart gönderir; kimlik
`Authorization: Bearer <token>` başlığındadır. Ek olarak meeting-api, açılışta ve `/health`
çağrılarında aynı uç noktaya küçük bir WAV ile yoklama isteği atar.

Sonuç: GPU sunucusunda **tek bir port** (8083) ve **tek bir sır** (API_TOKEN) yönetilir.

---

## 1. Ön koşullar (GPU sunucusu)

| Gereksinim | Not |
|---|---|
| NVIDIA sürücü | CUDA 12.3 çalıştırabilen bir sürüm (referans kurulum: sürücü 610.57.04, RTX 4090 24 GB) |
| `nvidia-container-toolkit` | Konteynerin GPU görmesi için zorunlu |
| Docker Engine + Compose v2 | `docker compose version` |
| Disk | İmaj ~8–10 GB (CUDA runtime tabanı) + model ağırlıkları için ~5 GB named volume |
| VRAM | `large-v3-turbo` + `int8` ≈ 2.1 GB |
| Ağ | 8083/tcp, **yalnızca** uygulama sunucusundan erişilebilir |

GPU'nun konteynerden göründüğünü kurulumdan önce doğrula:

```bash
docker run --rm --gpus all nvidia/cuda:12.3.2-base-ubuntu22.04 nvidia-smi
```

Bu komut GPU tablosunu basmıyorsa, aşağıdaki hiçbir adım çalışmaz — önce toolkit'i düzelt.

---

## 2. İmaj

Dockerfile deponun kökünü build context olarak bekler (`core/meetings/services/transcription/...`
yollarını kökten kopyalar). İki yol var:

### A) Registry'ye bir kez basıp GPU sunucusunda çekmek (önerilen)

`docker-compose.production.example.yml` bu yolu varsayar
(`image: cerebrumtech/innova-transcription:latest`):

```bash
# depo kökünde (build makinesinde)
docker build -f core/meetings/services/transcription/Dockerfile \
             -t cerebrumtech/innova-transcription:latest .
docker push cerebrumtech/innova-transcription:latest
```

Registry yoksa imajı doğrudan taşı:

```bash
docker save cerebrumtech/innova-transcription:latest | ssh gpu-host 'docker load'
```

### B) GPU sunucusunda derlemek

```bash
git clone -b feat/turkish-post-meeting-reports https://github.com/Cerebrum-Tech/vexa.git
cd vexa/deploy/transcription
docker compose build          # → vexaai/v012-transcription:dev
```

Bu yol tüm depoyu GPU sunucusuna indirmeyi gerektirir; sadece STT taşıyorsan (A) daha temizdir.

---

## 3. GPU sunucusundaki dosyalar

```bash
sudo mkdir -p /opt/innova-transcription && cd /opt/innova-transcription
```

`docker-compose.yml` ← bu depodaki `deploy/transcription/docker-compose.production.example.yml`
dosyasının kopyası. Kopyaladıktan sonra `environment:` bloğuna **tek bir satır ekle** —
örnek dosyada yok ve olmadan Swagger arayüzü herkese açık kalır:

```yaml
      VEXA_ENV: ${VEXA_ENV:-production}   # /docs, /redoc, /openapi.json kapanır
```

Yanına `.env`:

```bash
TRANSCRIPTION_PORT=8083
MODEL_SIZE=large-v3-turbo
COMPUTE_TYPE=int8

# Paylaşılan sır. Uygulama sunucusundaki TRANSCRIPTION_SERVICE_TOKEN ile AYNI olmalı.
# Üret:  openssl rand -hex 32
API_TOKEN=<güçlü-rastgele-değer>

# Yük sınırları — bkz. §7
MAX_ACTIVE_REQUESTS=8
MAX_QUEUE_SIZE=16
FAIL_FAST_WHEN_BUSY=true
REALTIME_RESERVED_SLOTS=1

VEXA_ENV=production
```

`API_TOKEN` compose dosyasında `${API_TOKEN:?...}` ile zorunlu tutulur: boş bırakırsan konteyner
hiç açılmaz. Bu kasıtlı — servis, token tanımsızken **her isteği kabul eder** ve loga
`API_TOKEN not configured - allowing all requests` uyarısı düşer.

Başlat:

```bash
docker compose up -d
docker compose logs -f          # "Model loaded successfully" satırını bekle
```

İlk açılışta model ağırlıkları indirilir (birkaç dakika). İnene kadar `/health` **503** ve
`"status": "unhealthy"` döner — bu normaldir, hata değildir. Ağırlıklar `transcription-models`
named volume'unda kalır; sonraki açılışlar saniyeler sürer.

---

## 4. Ağ ve güvenlik

**Port yalnızca uygulama sunucusuna açık olmalı.** Compose dosyası portu tüm arayüzlere bağlar
(`"${TRANSCRIPTION_PORT:-8083}:8000"`), sınırı güvenlik duvarı koyar:

```bash
sudo ufw allow from <uygulama-sunucusu-ip> to any port 8083 proto tcp
sudo ufw deny 8083/tcp
```

**Token düz metin gider.** `Authorization: Bearer` başlığı TLS olmadan ağda görünür. İki sunucu
aynı VPC/VPN içindeyse düz HTTP kabul edilebilir; internet üzerinden geçiyorsa önüne bir ters
vekil (nginx/Caddy) koy, 443'te TLS sonlandır ve uygulama tarafındaki URL'i `https://` yap.

**Hız sınırı yok.** Depodaki nginx yük dengeleyici varyantı (`docker-compose.yml` + `nginx.conf`)
IP başına istek/bağlantı sınırı taşır; tek konteynerli production örneği taşımaz. Servis
güvenilir bir ağda ve tek istemcisi kendi botlarınsa gerek yoktur.

---

## 5. Uygulama sunucusu ayarları

`deploy/compose/.env`:

```bash
TRANSCRIPTION_SERVICE_URL=http://<gpu-host>:8083     # veya https://stt.sirket.local
TRANSCRIPTION_SERVICE_TOKEN=<GPU .env'deki API_TOKEN ile aynı>
TRANSCRIPTION_MODEL=                                  # boş bırak
```

Üç kural:

1. **URL taban adrestir.** İstemci `/v1/audio/transcriptions` yolunu kendisi ekler
   (`whisper/src/transcription-client.ts`). Tam uç noktayı yazsan da kabul edilir — hem istemci
   hem yoklama aynı kuralı uygular — ama `/v1` veya `/v1/audio` gibi **yarım** bir yol 404 üretir.
2. **`localhost` yazma.** İsteği yapan taraf bot konteyneridir; onun `localhost`'u kendisidir.
   Ayrı sunucuda zaten IP/DNS adı yazacaksın.
3. **`TRANSCRIPTION_MODEL` boş kalsın.** Bu servis istekteki `model` alanını yok sayar; çalışan
   model her zaman kendi `MODEL_SIZE` değeridir. Bu değişken yalnızca model kimliğini *doğrulayan*
   arka uçlar (Groq, OpenAI, LiteLLM/vLLM) içindir.

Uygula — ortam değişkeni değişikliği konteynerin yeniden yaratılmasını gerektirir:

```bash
cd deploy/compose
docker compose up -d --force-recreate meeting-api
```

Tek sunucu kurulumundan geliyorsan, eskiden kullanılan
`docker network connect --alias transcription-api-local ...` bağı artık gereksizdir; kaldır.

---

## 6. Doğrulama — sırayla, her adımda beklenen çıktı

**1) GPU sunucusunda, yerel:**

```bash
curl -s localhost:8083/health
```
Beklenen: `"status":"healthy"`, `"device":"cuda"`, `"model":"large-v3-turbo"`.

**2) Uygulama sunucusundan, ağ + token:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" http://<gpu-host>:8083/health
```
Beklenen: `200`. `000` → güvenlik duvarı/route; `401` → token uyuşmuyor.

**3) Gerçek ses turu — sözleşmenin ucu ucuna kanıtı:**

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 test.wav
curl -s http://<gpu-host>:8083/v1/audio/transcriptions \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@test.wav -F model=whisper-1 -F response_format=verbose_json -F language=tr
```
Beklenen: `200` ve `text` alanı taşıyan JSON. Ton sesinde metnin **boş** gelmesi normaldir —
kanıtlanan şey ses hattının uçtan uca çalıştığıdır. Yanlış token → `401`.

**4) meeting-api'nin kendi yoklaması:**

```bash
docker compose logs meeting-api | grep "config.v1 capability stt"
curl -s 127.0.0.1:18080/health | jq '.capabilities.stt'
```
Beklenen: `{"state":"configured","probe":{"ok":true,...}}`.

Yoklama açılışta bir kez **zorlanır**; sonrasında sonuç 900 sn (15 dk) önbelleklenir. Ayar
değiştirdiysen taze sonucu görmenin yolu meeting-api'yi yeniden başlatmaktır.

> Not: bot başlatma hatası metni "`/health?force=1` çağır" der; `/health` işleyicisi sorgu
> parametresi okumaz (`meeting_api/app.py:201` → `capability_health()` varsayılan `force_probe=False`).
> Zorlamanın gerçek yolu yeniden başlatmaktır.

**5) Canlı toplantı:** bir toplantıya bot gönder, transkript akışını terminalde izle. Aynı anda
GPU sunucusunda `docker compose logs -f` istekleri saymalıdır. Bu adım atlanamaz — 1–4 yeşilken
5'in kırmızı olduğu tek senaryo, bot konteynerinin GPU sunucusuna çıkışının olmamasıdır.

---

## 7. Yük ayarları ve boyutlandırma

| Değişken | Kod varsayılanı | Ne yapar |
|---|---:|---|
| `MAX_ACTIVE_REQUESTS` | 20 | Eşzamanlı transkripsiyon sayısı. CTranslate2 CUDA işlemlerini zaten sıraya sokar; bu sınır kuyruk gecikmesini sınırlar. |
| `MAX_QUEUE_SIZE` | 10 | Sırada bekleyebilecek istek sayısı. |
| `FAIL_FAST_WHEN_BUSY` | true | Doluysa beklemeden `503` döner; bot tamponlayıp daha büyük bir pencereyle tekrar dener. |
| `REALTIME_RESERVED_SLOTS` | 1 | Canlı akışa ayrılan slot — kayıttan işlenen (deferred) işler bunu tüketemez. |
| `BUSY_RETRY_AFTER_S` | 1 | `503` yanıtındaki `Retry-After`. |
| `VAD_MIN_SILENCE_DURATION_MS` | 160 | Daha küçük değer → daha sık bölme, daha düşük gecikme, daha çok istek. |

Kaba kapasite: bir toplantı yaklaşık her 3–5 saniyede bir istek üretir. Kod içindeki ölçüm notuna
göre (RTX 4090) 20 eşzamanlı istekte en kötü gecikme ~3 sn. Tek 4090 için `MAX_ACTIVE_REQUESTS=8`
ile başla, gerçek trafikte GPU kullanımını izleyip yükselt. Örnek dosyadaki `2` kasıtlı olarak
temkinlidir.

**Ölçekleme.** İkinci GPU: nginx dengeleyicili varyanta geç (`docker-compose.yml` içindeki
`transcription-worker-2` bloğunu **ve** `nginx.conf` içindeki upstream satırını aç — ikisi
birlikte). İkinci sunucu: önüne bir yük dengeleyici koy, uygulama tarafındaki URL'i ona çevir.

---

## 8. Türkçe doğruluk

- `MODEL_SIZE=large-v3-turbo` — çok dilli, 99+ dil. Türkçe için `medium` altına inme; `small`
  yalnızca GPU'suz geliştirme içindir.
- Botu Türkçe toplantıda **`language: "tr"`** ile başlat (`POST /bots` gövdesindeki `language`
  alanı). Otomatik dil tespiti kısa ses pencerelerinde salınabilir; dili sabitlemek pencere
  başına dil değişmesini keser.
- `VAD_MIN_SILENCE_DURATION_MS` — GPU compose dosyası 80 ms kullanır (kod varsayılanı 160).
  Türkçenin doğal duraklarında daha sık bölme, canlı transkriptte daha akıcı bir akış verir.

---

## 9. İşletim

```bash
docker compose logs -f                     # istek akışı + model yükleme
docker compose pull && docker compose up -d   # imaj güncelleme
docker volume rm innova-transcription_transcription-models   # ağırlıkları sıfırla (yeniden iner)
```

Servis **durumsuzdur**: model ağırlıkları dışında saklanan hiçbir şey yoktur, yedeklenecek veri
yoktur, istediğin an yeniden yaratılabilir. GPU sunucusu kapalıyken ana yığın ayakta kalır —
botlar toplantıya katılır ve **kaydeder**, ama transkript üretmez; servis dönünce yeni pencereler
normal akar (geriye dönük telafi yoktur).

---

## 10. Sorun giderme

| Belirti | Sebep | Çözüm |
|---|---|---|
| `curl: connection refused` | Güvenlik duvarı, ya da konteyner ayakta değil | `docker compose ps`, ufw kuralı |
| `401` | Token uyuşmuyor | GPU `.env` `API_TOKEN` = uygulama `.env` `TRANSCRIPTION_SERVICE_TOKEN` |
| `404` | URL'de yarım yol (`/v1`, `/v1/audio`) | Taban adres yaz |
| `503` + `"status":"unhealthy"` | Model henüz yüklenmedi veya yüklenemedi | `docker compose logs` — CUDA/sürücü hatası ara |
| `503 Service busy` | `MAX_ACTIVE_REQUESTS` dolu | Sınırı yükselt veya worker ekle |
| `POST /bots` → *"no transcription backend configured"* | URL/TOKEN boş | §5 |
| `POST /bots` → *"the configured transcription backend is not working"* | Önbellekteki yoklama sonucu yapılandırma hatası diyor | Ayarı düzelt, meeting-api'yi yeniden başlat |
| Bot katılıyor, kayıt var, transkript yok | Bot konteynerinin GPU sunucusuna çıkışı yok | Uygulama sunucusundan **ve** bir konteyner içinden §6-2'yi tekrarla |
| `CUDA error: no kernel image is available` | Sürücü/CUDA uyumsuz | Sürücüyü CUDA 12.3 destekleyen sürüme çıkar |

---

## 11. Tek sunucuya geri dönüş

GPU aynı makinedeyse ayrı sunucuya hiç gerek yok: `deploy/transcription` birimini yerelde ayağa
kaldır, portu docker köprü arayüzüne bağla (`TRANSCRIPTION_LB_PORT=172.17.0.1:8083`) ve
uygulama tarafında `TRANSCRIPTION_SERVICE_URL=http://172.17.0.1:8083` yaz. Bot konteynerleri
köprü IP'sinden host'a ulaşır.

---

## İlgili dosyalar

| Dosya | Rolü |
|---|---|
| `deploy/transcription/docker-compose.production.example.yml` | GPU sunucusuna kopyalanan compose dosyası |
| `deploy/transcription/docker-compose.yml` + `nginx.conf` | Çok worker'lı, nginx dengeleyicili varyant |
| `deploy/transcription/.env.example` | Değişken referansı |
| `deploy/compose/.env` | Uygulama tarafı: `TRANSCRIPTION_SERVICE_URL` / `_TOKEN` / `_MODEL` |
| `core/meetings/modules/whisper/src/transcription-client.ts` | İsteği atan istemci (yol + Bearer kuralı) |
| `core/meetings/services/transcription/src/transcription/main.py` | Servisin kendisi (uçlar, kimlik, yük sınırları) |
