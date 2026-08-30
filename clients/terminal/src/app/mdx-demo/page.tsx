"use client";
/** /mdx-demo — standalone showcase of the MdxDoc workspace renderer (no gateway needed).
 *  Left: the raw agent-authored markdown source. Right: the live rendered interface.
 *  The second sample is intentionally malformed to demonstrate the plain-markdown fallback. */
import { MdxDoc } from "../../ui-kit/MdxDoc";

const SAMPLE = `# Jane Liu

[[Company ACME]] şirketinde Mühendislik Başkan Yardımcısı — platform geçişi için birincil iletişim kişisi.

<Note>
  En son **2026-06-30 tarihli durum toplantısından** eşitlendi. Asistan bu belgeyi her toplantıdan sonra günceller.
</Note>

<CardGroup cols={2}>
  <Card title="Açık görevler" icon="tasks" href="kg/entities/project/platform-migration.md">
    3 madde ACME’nin güvenlik incelemesine takılı durumda.
  </Card>
  <Card title="Toplantı notları" icon="cal" href="kg/entities/meeting/2026-06-30-sync.md">
    Haftalık durum toplantısı — devreye alma aşamalarına ilişkin kararlar.
  </Card>
</CardGroup>

Bağlantılar: [geçiş planı](kg/entities/project/platform-migration.md) çalışma alanı sekmesi
olarak açılır; [ACME belgeleri](https://example.com/acme) tarayıcıda açılır.

## Devreye alma planı

<Steps>
  <Step title="Güvenlik incelemesi onayı">
    ACME bilgi güvenliği ekibi veri yerleşimi ek maddesini inceler. Sorumlu: [[Jane Liu]].
  </Step>
  <Step title="Pilot grup">
    İşlem masasında 20 kullanıcı, iki hafta, başarı ölçütü = günlük aktif kullanım.
  </Step>
  <Step title="Kurum geneline yayılım">
    Pilot ölçümlerine ve *çeyreklik bütçe kontrolüne* bağlı.
  </Step>
</Steps>

## Ayrıntılar

<Tabs>
  <Tab title="Genel bilgi">
    Jane, 40 kişilik bir platform ekibini yönetiyor. Eşzamansız güncellemeleri tercih ediyor; acil konuları yalnızca e-posta ile iletin.

    - **Yetkinlikler:** Rust, dağıtık sistemler
    - **Konum:** San Francisco
  </Tab>
  <Tab title="Geçmiş">
    | Tarih | Olay |
    | --- | --- |
    | 2026-05-12 | Tanışma görüşmesi |
    | 2026-06-30 | Geçiş toplantısı — pilot kapsamı üzerinde anlaşıldı |
  </Tab>
</Tabs>

<Warning>
  Sözleşme yenilemesine **45 gün kaldı** — pilot bitmeden fiyatlandırmayı gündeme getirin.
</Warning>
`;

const BROKEN = `# Yedek görünüm gösterimi

Bu dosya, asistanların ara sıra yazdığı türden geçersiz MDX içeriyor: kapatılmamış bir
<etiket ve başıboş {süslü parantezler}. Yine de düz Markdown olarak görüntülenir.

- sayfa asla bozulmaz
- en kötü ihtimalle etkileşimi kaybederiz, içeriği değil
`;

function Pane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 12, background: "var(--bg)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--t3)", padding: "8px 13px", borderBottom: "1px solid var(--line)", background: "var(--panel)" }}>{title}</div>
      <div style={{ padding: "16px 18px", overflow: "auto", flex: 1 }}>{children}</div>
    </div>
  );
}

export default function MdxDemo() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--t1)", padding: "26px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Çalışma alanı MDX görüntüleyicisi</div>
        <div style={{ fontSize: 12.5, color: "var(--t3)", marginTop: 3 }}>
          asistanın yazdığı Markdown (solda) → canlı arayüz (sağda) · @mdx-js/mdx ile çalışma zamanında derlenir, kapalı bileşen kaydı, düz Markdown yedeği
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "stretch", minHeight: 0 }}>
        <Pane title="kg/entities/person/jane-liu.md (kaynak)">
          <pre style={{ fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.55, color: "var(--t2)", whiteSpace: "pre-wrap" }}>{SAMPLE}</pre>
        </Pane>
        <Pane title="çıktı">
          <div style={{ fontSize: 14, lineHeight: 1.6 }}><MdxDoc>{SAMPLE}</MdxDoc></div>
        </Pane>
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "stretch", minHeight: 0 }}>
        <Pane title="hatalı MDX (kaynak)">
          <pre style={{ fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.55, color: "var(--t2)", whiteSpace: "pre-wrap" }}>{BROKEN}</pre>
        </Pane>
        <Pane title="çıktı — sorunsuz yedek görünüm">
          <div style={{ fontSize: 14, lineHeight: 1.6 }}><MdxDoc>{BROKEN}</MdxDoc></div>
        </Pane>
      </div>
    </div>
  );
}
