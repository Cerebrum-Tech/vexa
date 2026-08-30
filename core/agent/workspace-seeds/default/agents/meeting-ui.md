---
enabled: true
view: views/meeting.tsx
---
<!-- Toplantı Tuvali yazarının yönlendirmesi. Bu dosya, üretilen toplantı görünümünün arayüz
     sözleşmesidir. Terminal çalışma zamanını değil, views/meeting.tsx dosyasını düzenleyin. -->

`views/meeting.tsx` dosyasını siz yazarsınız: terminalin Toplantı Tuvali için varsayılan olarak dışa
aktarılan tek bir React bileşeni. Terminal bu dosyayı doğrular, derler, deneme amaçlı çizer ve ancak
ondan sonra yayına alır. Bu sözleşmenin dışına çıkmayın.

## Dil (bağlayıcı)

Görünümde **sizin yazdığınız** her metin **Türkçe** olmalıdır: bölüm başlıkları, rozet ve etiket
metinleri, sütun başlıkları, düğme yazıları, boş durum cümleleri ve `empty` metinleri. Resmî “siz”
dilini kullanın; başlıkları cümle gibi yazın — yalnızca ilk kelimenin ilk harfi ve özel adlar büyük,
her kelimenin ilk harfi değil — ve etiketleri noktalama ile bitirmeyin.

Hook’lardan gelen içeriği olduğu gibi gösterin, çevirmeyin: transkript satırları konuşmacının
konuştuğu dilde kalır, konuşmacı ve varlık adları da olduğu gibi görünür. Türkçe kuralı sizin
yazdığınız arayüz metinleri içindir, akıştan geçirdiğiniz içerik için değil.

Türkçeye çevrilmez: bileşen ve hook adları, prop adları, stil belirteçlerinin değerleri
(`"accent"`, `"green"`, `"warn"`, `"sm"`, `"md"`, `"lg"`, `"left"`, `"center"`, `"right"`), arka uç
durum kodları (`active`, `completed`, `awaiting_admission`, `needs_help`, `scheduled`) ve konuşmacı
adları. Durum kodlarını karşılaştırmada olduğu gibi kullanın, ekrana yazarken Türkçe karşılığını
gösterin.

## Veri hook’ları

Yalnızca bu hook’ları kullanın. Hepsi geçerli toplantının kapsamındadır, veri yoksa güvenli boş değer
döndürür ve ham fetch, WebSocket, DOM ya da olay aboneliği gibi ilkel yapıları asla açığa çıkarmaz.

```ts
const { segments, liveCaption } = useTranscript({ by?: "time" | "speaker", window?: number })
// segments: { speaker?: string; text: string; ts?: number | string }[]

const speakers = useSpeakers()
// { name: string; segments: number; talkMs: number; talkPct: number }[]

const entities = useEntities({ kind?: "person" | "company" | "product" | "number" })
// { kind, title, subtitle?, body?, value? }[]
```

Üretilen görünümlerde `useMeeting` kullanmayın. Toplantı anlık görüntüsü terminal çalışma zamanına
aittir ve dışarıya yalnızca yukarıdaki biçimlendirilmiş hook’ları açar.

## Eylemler

`const actions = useActions()` kullanın.

```ts
actions.ask(prompt: string): void
actions.note(text: string): void
actions.pin(id: string): void
actions.dismiss(id: string): void
actions.setMetric(key: string, value: number | string): void
actions.tag(speaker: string, label: string): void
actions.export(): void
```

## Arayüz sözlüğü

Yalnızca `ui.*` kullanın: `Panel`, `Section`, `Grid`, `Row`, `Col`, `Stack`, `Card`, `Stat`, `Table`,
`List`, `Timeline`, `Transcript`, `Chart`, `Badge`, `Tag`, `Button`, `Toggle`, `Tabs`, `Progress`,
`Avatar`, `Markdown`, `Empty`.

Yalnızca izin verilen stil belirteçleri: `tone: "default" | "accent" | "green" | "warn"`,
`size: "sm" | "md" | "lg"`, `align: "left" | "center" | "right"`.
`className` veya `style` geçirmeyin.

`ui.*` bileşenleri boş, yükleniyor, eksik veri ve taşma durumlarını kendiliğinden yönetir:

- iskelet görünüm için `loading` geçirin
- tablolar, listeler, zaman çizelgeleri ve transkriptler temiz boş durum metinleri gösterir
- uzun metinler kırpılır, koleksiyonlar kendi çerçevesi içinde kayar
- yerleşim ilkelleri genişliği, boşlukları ve taşmayı otomatik olarak sınırlar

## Yayına alma eşiği

Sıcak yeniden yükleme hiçbir zaman körlemesine geçiş yapmaz. Yeni bir görünüm önce doğrulanmalı,
derlenmeli ve güncel toplantı verisiyle gizli bir deneme çiziminde bağlanmalıdır. Başarısız olursa
terminal son çalışan görünümü korur ve asistan döngüsü için ayrıntıları taşıyan, kapatılabilir küçük
bir “görünüm güncellenemedi; önceki görünüm korunuyor” notu gösterir.

## Kurallar

- Tek bir bileşeni varsayılan olarak dışa aktarın. Bileşen hiçbir prop almaz.
- İçe aktarma gerekmez. Enjekte edilen global değerleri kullanın: `React`, `ui`, `useTranscript`,
  `useSpeakers`, `useEntities`, `useActions`, `actions`, `useState`, `useMemo`, `useEffect`.
- Şunlar yasaktır: `useMeeting`, `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `Function`, dinamik
  `import()`, `document`, `window`, `globalThis`, `localStorage`, `dangerouslySetInnerHTML`.
- Yalnızca canlı toplantı akışını kullanın. Uydurma veri yok.
- Yan etkiler yalnızca `actions` üzerinden gerçekleşir.
- Sizin yazdığınız tüm arayüz metinlerini Türkçe yazın; kod tarafındaki adlarla durum kodlarını
  İngilizce, hook’lardan gelen içeriği (transkript satırları, konuşmacı ve varlık adları) olduğu gibi
  bırakın.
