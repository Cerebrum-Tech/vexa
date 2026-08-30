---
name: scheduling
description: Tekrar eden veya zamanlanmış işleri kurar — kullanıcının bir programa göre, düzenli aralıklarla ya da ileri bir tarihte çalıştırılmasını istediği her şey (“her sabah”, “her hafta içi 09:00’da”, “günlük özet”, “haftalık rapor”, “bana hatırlat”, “bunu cron ile çalıştır”). Yeniden başlatmalara dayanan kalıcı bir Vexa Scheduler rutininin nasıl yazılacağını anlatır. Zamanlanmış işler için işletim sistemi cron görevi, sistem zamanlayıcısı veya yalnızca oturum boyu süren hatırlatma yerine bunu kullanın.
---

# scheduling — kalıcı tekrar eden işler

Kullanıcı bir programa göre çalışması ya da zaman içinde tekrarlanması gereken HERHANGİ bir şey
istediğinde (günlük özet, haftalık rapor, düzenli bir kontrol, ileri tarihli bir hatırlatma), bu
çalışma alanında bir **rutin dosyası** oluşturursunuz. agent-api içindeki uzlaştırıcı bu dosyayı,
yeniden başlatmalara ve süreç ölümüne dayanan **kalıcı bir Vexa Scheduler işine** derler — zamanlanmış
işler için buradaki tek doğru mekanizma budur.

Zamanlanmış işler için şunları **ASLA** yapmayın:

- işletim sistemi cron görevi oluşturmak (`crontab`, `/etc/cron.*`)
- systemd zamanlayıcısı ya da başka bir sistem zamanlayıcısı oluşturmak
- kabukta arka plan döngüsü / `sleep` döngüsü başlatmak
- “yalnızca oturum boyu” bir hatırlatma bırakmak (turunuz biter, o da yok olur)

Bunların hepsi yeniden başlatmada veya turunuz bittiğinde kaybolur. Yalnızca bir rutin dosyası kalıcıdır.

## Rutin nasıl oluşturulur

**`routines/<name>.md`** yolunda tek bir dosya yazın (`<name>` kısa bir slug'dır; dosya adının kökü
rutinin adı olur). Bu, sıradan bir çalışma alanı dosyasıdır — sadece yazın; git komutlarını siz
çalıştırmazsınız.

Dosya, **YAML frontmatter** ve **isteğe bağlı bir markdown gövdesinden** oluşur:

| alan      | zorunlu                 | anlamı                                                             |
|-----------|-------------------------|--------------------------------------------------------------------|
| `enabled` | hayır (varsayılan `true`) | `false` işi iptal eder ama dosyayı sonradan yeniden etkinleştirmek üzere saklar |
| `cron`    | evet (etkinken)         | standart **5 alanlı** cron ifadesi (dakika saat ayın-günü ay haftanın-günü) |
| `prompt`  | evet (etkinken)         | her çalıştırmada asistana gönderilen yönerge (boş olamaz)          |

İkinci `---` satırının altındaki isteğe bağlı markdown gövdesi, her çalıştırma için ek bağlam olarak
`prompt` değerinin sonuna eklenir.

### cron biçimi

Boşlukla ayrılmış beş alan: `dakika saat ayın-günü ay haftanın-günü`. Haftanın günü `0`–`7` aralığındadır
(0 ve 7 pazardır); `mon`/`tue`/… ve `jan`/`feb`/… adları da kabul edilir — bu adlar İngilizcedir ve
olduğu gibi yazılır. Aralıklar (`mon-fri`), listeler (`1,15`) ve adımlar (`*/15`) da geçerlidir.

Örnekler:
- `0 8 * * *` — her gün 08:00
- `30 9 * * mon-fri` — hafta içi 09:30
- `0 17 * * fri` — her cuma 17:00
- `0 * * * *` — her saat başı

### Örnek uygulama

“Her hafta içi sabah 9’da dünkü toplantıların özetini ver” isteği için
`routines/morning-digest.md` dosyasını oluşturun:

```markdown
---
enabled: true
cron: "30 9 * * mon-fri"
prompt: "kg/entities/ altındaki dünkü toplantılardan ve açık görevlerden kısa bir özet derle; bugün neyin dikkat gerektirdiğini yaz."
---

En fazla ~10 madde olsun. Kişi/şirket bazında gruplayın. Varlıkları [[wikilink]] ile bağlayın.
```

Hepsi bu. agent-api içinde çalışan ve her çalışma alanını belirli aralıklarla tarayan uzlaştırıcı
dosyayı alır, `cron` ile `prompt` değerlerini doğrular ve kalıcı bir Vexa Scheduler işi zamanlar.
Dosyayı düzenlemek işi günceller; `enabled: false` yapmak (ya da dosyayı silmek) işi iptal eder.

## Doğrulama notları

- **Etkin** bir rutinde geçerli, 5 alanlı bir `cron` ve boş olmayan bir `prompt` MUTLAKA bulunmalıdır;
  aksi halde uzlaştırıcı bir uyarı yazar ve rutini atlar (iş oluşturulmaz). Cron ifadesinin tam olarak
  beş alan taşıdığını yeniden kontrol edin.
- **Devre dışı** bir rutin (`enabled: false`) için `cron`/`prompt` gerekmez — yalnızca o ada ait mevcut
  işi iptal eder.
- `prompt` değerini ve markdown gövdesini Türkçe yazın: her çalıştırmanın çıktısını kullanıcı okur.
- Neyi zamanladığınızı kullanıcıya doğrulayın (ad + cron + ne yaptığı).
