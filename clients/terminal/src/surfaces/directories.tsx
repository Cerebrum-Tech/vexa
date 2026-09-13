"use client";
/** People, companies and partner notes are views over authorized workspace documents. */
import { useCallback, useEffect, useRef, useState } from "react";
import { registerTab, registerList, type TabProps } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { Modal } from "../ui-kit/Modal";
import { MdxDoc, DocMetaContext } from "../ui-kit/MdxDoc";
import { ASK_CHAT_EVENT } from "../canvas/actions";
import type { ChatAskDetail, ChatDispatchResult } from "./chat";
import { meetingsOnly } from "../app/mode";
import { readActiveSet, listWorkspaceTree, readWorkspaceFile, type ActiveMount } from "./workspaceApi";
import { directoryRecord, isDirectoryCandidate, type DirectoryKind, type DirectoryRecord } from "./directoryRecords";

const labels = {
  person: { title: "Kişiler", singular: "Kişi", intro: "İlişkilerinizi hatırlayın, her görüşmeye bir adım önde başlayın.", icon: "user", folder: "person" },
  company: { title: "Şirketler", singular: "Şirket", intro: "Birlikte çalıştığınız şirketler ve aranızdaki tüm bağlantılar.", icon: "building", folder: "company" },
  partner: { title: "İş Ortağı Notları", singular: "Not", intro: "İş birliklerinize dair fikirler, görüşmeler ve önemli ayrıntılar.", icon: "file", folder: "note" },
};
const opts = (slug?: string) => slug ? { slug } : undefined;
const initialLetters = (s: string) => s.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toLocaleUpperCase("tr");

function EntityEditor({ kind, mounts, record, onClose, onSaved }: { kind: DirectoryKind; mounts: ActiveMount[]; record?: DirectoryRecord; onClose: () => void; onSaved: () => void }) {
  const layout = useService(LayoutServiceId);
  const writable = mounts.filter((m) => m.write && (!record || m.slug === record.slug));
  const [name, setName] = useState(record?.title ?? "");
  const [notes, setNotes] = useState("");
  const [slug, setSlug] = useState(writable[0]?.slug ?? "");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [pending, setPending] = useState<{ path: string; slug?: string; before: string | null; started: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    const check = async () => {
      try {
        const current = await readWorkspaceFile(pending.path, opts(pending.slug));
        if (!active) return;
        if (current && current !== pending.before) { setPending(null); onSaved(); onClose(); }
        else if (Date.now() - pending.started > 180_000) { setPending(null); setError("Değişiklik henüz kaydedilmedi. Asistanın yanıtını kontrol edin."); }
      } catch { if (active) { setPending(null); setError("Kaydın sonucu doğrulanamadı. Erişiminizi kontrol edip yeniden deneyin."); } }
    };
    const timer = setInterval(() => void check(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [pending, onClose, onSaved]);
  const submit = async () => {
    if (submitting || pending) return;
    setError(null);
    const mount = writable.find((m) => m.slug === slug);
    if (!mount || !name.trim()) return;
    const safeName = name.toLocaleLowerCase("tr").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "not";
    const path = record?.path ?? `kg/entities/${labels[kind].folder}/${safeName}-${Date.now().toString(36)}.md`;
    const workspaceSlug = mount.slug;
    setSubmitting(true);
    try {
      const current = await readWorkspaceFile(path, opts(workspaceSlug));
      if (!mounted.current) return;
      const prompt = [
        `${record ? "Mevcut kaydı güncelle" : "Yeni kayıt oluştur"}: ${JSON.stringify(name.trim())}.`,
        `Çalışma alanı: ${JSON.stringify(mount.slug)}. Hedef belge: ${JSON.stringify(path)}.`,
        `Belge türü ${kind === "partner" ? "note" : kind}. Türkçe yaz, başlık ve tür alanlarını koru. Var olan bilgileri silme, desteklenmeyen bilgi uydurma.`,
        `İstenen içerik/değişiklik: ${JSON.stringify(notes.trim())}.`,
        "Değişikliği belirtilen belgeye kaydet. Yalnızca istenen çalışma alanına yaz; yazamıyorsan açıkla.",
      ].join("\n");
      const displayText = `${name.trim()} için ${labels[kind].singular.toLocaleLowerCase("tr")} kaydını ${record ? "güncelle" : "oluştur"}.\n${notes.trim()}`;
      const dispatch: { result: ChatDispatchResult | "unavailable" } = { result: "unavailable" };
      layout.showRight();
      window.dispatchEvent(new CustomEvent<ChatAskDetail>(ASK_CHAT_EVENT, { detail: {
        prompt, displayText, ground: false, onDispatch: (result) => { dispatch.result = result; },
      } }));
      if (dispatch.result === "accepted") setPending({ path, slug: workspaceSlug, before: current, started: Date.now() });
      else setError(dispatch.result === "busy"
        ? "Asistan önceki yanıtı hazırlıyor. Yanıt tamamlanınca yeniden deneyin. İstek gönderilmedi."
        : "Asistan bağlantısı henüz hazır değil. Biraz sonra yeniden deneyin. İstek gönderilmedi.");
    } catch { if (mounted.current) setError("Çalışma alanı okunamadı. İstek gönderilmedi."); }
    finally { if (mounted.current) setSubmitting(false); }
  };
  return <Modal title={`${labels[kind].singular} ${record ? "düzenle" : "ekle"}`} onClose={onClose} width={480}>
    <form className="entity-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label>{kind === "person" ? "Ad soyad" : "Başlık"} <span className="req" aria-hidden="true">*</span><input required aria-required="true" value={name} disabled={submitting || !!pending} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label>{record ? "Neyi değiştirmek istersiniz?" : "Eklemek istediğiniz bilgiler"} <span className="req" aria-hidden="true">*</span><textarea value={notes} required aria-required="true" disabled={submitting || !!pending} onChange={(e) => setNotes(e.target.value)} placeholder="Bildiğiniz ayrıntıları kendi cümlelerinizle yazın." /><span className="hint">* işaretli alanlar zorunludur; ikisi de dolunca <b>Asistanla kaydet</b> etkinleşir.</span></label>
      <label>Çalışma alanı<select value={slug} disabled={submitting || !!pending || !!record} onChange={(e) => setSlug(e.target.value)}>{writable.map((m) => <option key={m.slug} value={m.slug}>{m.name || (m.primary ? "Kişisel alanım" : "Paylaşılan alan")}</option>)}</select></label>
      {pending && <div className="notice pending" role="status">Asistan değişikliğinizi hazırlıyor. Belgeye kaydedilmesi bekleniyor…</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="entity-form-actions"><button type="button" className="secondary-button" onClick={onClose}>Kapat</button><button className="primary-button" disabled={submitting || !!pending || !writable.length || !name.trim() || !notes.trim()}><Icon name="spark" size={16} />Asistanla kaydet</button></div>
    </form>
  </Modal>;
}

export function DirectoryView({ params }: TabProps) {
  const kind: DirectoryKind = ["person", "company", "partner"].includes(String(params.directory)) ? params.directory as DirectoryKind : "person";
  const layout = useService(LayoutServiceId);
  const [records, setRecords] = useState<DirectoryRecord[]>([]);
  const [mounts, setMounts] = useState<ActiveMount[]>([]);
  const [query, setQuery] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const generation = useRef(0);
  const hasLoaded = useRef(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    // Records stay on screen while a refresh runs: a refresh that wiped the list first made every
    // 30 s tick (and every return from the meeting window) read as "0 kayıt, yükleniyor…".
    const progressive = !hasLoaded.current;
    setLoading(true); setError(null);
    try {
      const set = await readActiveSet();
      if (current !== generation.current) return;
      setMounts(set.active);
      const all: DirectoryRecord[] = [];
      for (const mount of set.active) {
        const readOpts = opts(mount.slug);
        const paths = (await listWorkspaceTree(readOpts)).filter(isDirectoryCandidate);
        for (let i = 0; i < paths.length; i += 8) {
          const batch = await Promise.all(paths.slice(i, i + 8).map(async (path) => {
            const body = await readWorkspaceFile(path, readOpts);
            return body == null ? null : directoryRecord(path, body, mount);
          }));
          if (current !== generation.current) return;
          all.push(...batch.filter((r): r is DirectoryRecord => r !== null));
          if (progressive) setRecords([...all]);
        }
      }
      setRecords(all); hasLoaded.current = true;
    } catch { if (current === generation.current) { setRecords([]); setMounts([]); setError("Bilgiler yüklenemedi. Bağlantınızı ve çalışma alanı erişiminizi kontrol edin."); } }
    finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { generation.current++; clearInterval(timer); };
  }, [load]);
  const items = records.filter((r) => r.kind === kind && (!workspace || r.slug === workspace) && `${r.title} ${r.description} ${r.organization}`.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr"))).sort((a, b) => a.title.localeCompare(b.title, "tr"));
  const close = useCallback(() => setEditing(false), []);
  return <div className="directory-page">
    <div className="page-heading"><div><h1>{labels[kind].title}</h1><p>{labels[kind].intro}</p></div><button className="primary-button" disabled={!mounts.some((m) => m.write)} onClick={() => setEditing(true)}><Icon name="plus" size={17} />{labels[kind].singular} ekle</button></div>
    <div className="directory-filters"><label className="search-field"><Icon name="search" size={18} /><input aria-label={`${labels[kind].title} içinde ara`} placeholder="İsim veya bilgi ara…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <select aria-label="Çalışma alanı filtresi" value={workspace} onChange={(e) => setWorkspace(e.target.value)}><option value="">Tüm çalışma alanları</option>{mounts.map((m) => <option key={m.slug} value={m.slug}>{m.name || (m.primary ? "Kişisel alanım" : "Paylaşılan alan")}</option>)}</select><span className="result-count">{items.length} kayıt</span></div>
    {error && <div className="notice error" role="alert">{error} <button className="text-button" onClick={() => void load()}>Yeniden dene</button></div>}
    {items.length ? <div className="directory-grid">{items.map((r) => <button key={r.id} className="directory-card" onClick={() => layout.openTab({ id: `entity:${r.id}`, title: r.title, kind: "entity", params: { path: r.path, slug: r.slug } })}>
      <span className="avatar">{kind === "person" ? initialLetters(r.title) : <Icon name={labels[kind].icon} size={22} />}</span><h2>{r.title}</h2>{r.organization && <span className="organization">{r.organization}</span>}<p>{r.description || "Ayrıntıları ve bağlantılı notları görüntüleyin."}</p><small><Icon name={r.writable ? "folder" : "eye"} size={12} />{r.workspace}{!r.writable && " · Salt okunur"}</small>
    </button>)}</div> : !error && <div className="empty-state"><Icon name={labels[kind].icon} size={34} /><h2>{loading ? "Bilgileriniz yükleniyor…" : query || workspace ? "Eşleşen kayıt bulunamadı." : "Yeni bağlantılara yer açın."}</h2><p>{loading ? "Çalışma alanlarınızdaki kayıtlar hazırlanıyor." : "Toplantılardan oluşan kayıtlar burada görünür. Dilerseniz ilk kaydı kendiniz ekleyin."}</p></div>}
    {editing && <EntityEditor kind={kind} mounts={mounts} onClose={close} onSaved={load} />}
  </div>;
}

function EntityDetail({ params }: TabProps) {
  const [record, setRecord] = useState<DirectoryRecord | null>(null);
  const [mounts, setMounts] = useState<ActiveMount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const path = String(params.path ?? ""); const slug = typeof params.slug === "string" ? params.slug : undefined;
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const set = await readActiveSet();
      const mount = set.active.find((m) => slug ? m.slug === slug : m.primary);
      if (!mount) throw new Error("inaccessible");
      const content = await readWorkspaceFile(path, opts(slug));
      const next = content == null ? null : directoryRecord(path, content, mount);
      if (current !== generation.current) return;
      setRecord(next); setMounts(set.active); setError(next ? null : "Bu kayıt artık bulunamıyor.");
    } catch { if (current === generation.current) { setRecord(null); setMounts([]); setError("Bu kayıt okunamadı veya artık bu kayda erişiminiz yok."); } }
  }, [path, slug]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000); return () => { generation.current++; clearInterval(timer); }; }, [load]);
  const close = useCallback(() => setEditing(false), []);
  if (!record) return <div className="empty-state" role="status">{error || "Kayıt yükleniyor…"}{error && <button className="text-button" onClick={() => void load()}>Yeniden dene</button>}</div>;
  return <div className="entity-detail"><div className="page-heading"><div><h1>{record.title}</h1><p>{[record.organization, record.workspace, !record.writable ? "Salt okunur" : ""].filter(Boolean).join(" · ")}</p></div>{record.writable && <button className="secondary-button" onClick={() => setEditing(true)}><Icon name="edit" size={16} />Düzenle</button>}</div>
    <div className="entity-document"><DocMetaContext.Provider value={{ path, slug }}><MdxDoc>{record.body.replace(/^#\s+[^\n]+\n/, "")}</MdxDoc></DocMetaContext.Provider></div>
    {editing && <EntityEditor kind={record.kind} record={record} mounts={mounts} onClose={close} onSaved={load} />}
  </div>;
}
if (!meetingsOnly()) {
  registerTab("directory", DirectoryView); registerTab("entity", EntityDetail);
  for (const [id, kind, order] of [["people", "person", 31], ["companies", "company", 32], ["partners", "partner", 33]] as const) {
    registerList({ id, label: labels[kind].title, icon: labels[kind].icon, order,
      component: () => <DirectoryView id={id} params={{ directory: kind }} active />,
      centerTab: { id, title: labels[kind].title, kind: "directory", params: { directory: kind } } });
  }
}
