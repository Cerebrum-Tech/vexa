"use client";
/** People, companies and partner notes are views over authorized workspace documents. */
import { useCallback, useEffect, useRef, useState } from "react";
import { registerTab, registerList, type TabProps } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { Modal } from "../ui-kit/Modal";
import { MdxDoc, DocMetaContext } from "../ui-kit/MdxDoc";
import { meetingsOnly } from "../app/mode";
import { ApiError, presentError } from "./apiClient";
import { readActiveSet, readWorkspaceEntities, readWorkspaceFile, saveWorkspaceEntity, type ActiveMount } from "./workspaceApi";
import { directoryRecord, type DirectoryKind, type DirectoryRecord } from "./directoryRecords";

const labels = {
  person: { title: "Kişiler", singular: "Kişi", intro: "İlişkilerinizi hatırlayın, her görüşmeye bir adım önde başlayın.", icon: "user", folder: "person" },
  company: { title: "Şirketler", singular: "Şirket", intro: "Birlikte çalıştığınız şirketler ve aranızdaki tüm bağlantılar.", icon: "building", folder: "company" },
  partner: { title: "İş Ortağı Notları", singular: "Not", intro: "İş birliklerinize dair fikirler, görüşmeler ve önemli ayrıntılar.", icon: "file", folder: "note" },
};
const opts = (slug?: string) => slug ? { slug } : undefined;
const initialLetters = (s: string) => s.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toLocaleUpperCase("tr");

/** A refusal from the workspace is a sentence the backend already wrote for the reader — a 403 here
 *  means "you cannot write to this workspace", never the API-key fault the shared presenter assumes.
 *  Prose from the server wins; anything else falls back to the presenter's vocabulary. */
function saveError(e: unknown): string {
  const detail = e instanceof ApiError ? e.detail.trim() : "";
  return detail && detail.length <= 300 && detail.includes(" ") && !/^[{[<]/.test(detail)
    ? detail : presentError(e).headline;
}

export function EntityEditor({ kind, mounts, record, onClose, onSaved }: { kind: DirectoryKind; mounts: ActiveMount[]; record?: DirectoryRecord; onClose: () => void; onSaved: () => void }) {
  const writable = mounts.filter((m) => m.write && (!record || m.slug === record.slug));
  const [name, setName] = useState(record?.title ?? "");
  const [notes, setNotes] = useState(record ? record.body.replace(/^#\s+[^\n]+\n/, "").trim() : "");
  const [slug, setSlug] = useState(writable[0]?.slug ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async () => {
    if (saving) return;
    setError(null);
    const mount = writable.find((m) => m.slug === slug);
    if (!mount || !name.trim()) return;
    setSaving(true);
    try {
      // The card is the form: title and text go to the file as typed. An edit keeps its own path,
      // so re-saving a card updates it in place instead of leaving a second copy behind.
      await saveWorkspaceEntity({
        workspace: mount.slug, kind: kind === "partner" ? "note" : kind,
        title: name.trim(), body: notes, ...(record ? { path: record.path } : {}),
      });
      if (!mounted.current) return;
      onSaved();
      onClose();
    } catch (e) {
      if (mounted.current) setError(saveError(e));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return <Modal title={`${labels[kind].singular} ${record ? "düzenle" : "ekle"}`} onClose={onClose} width={480}>
    <form className="entity-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label>{kind === "person" ? "Ad soyad" : "Başlık"} <span className="req" aria-hidden="true">*</span><input required aria-required="true" value={name} disabled={saving} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label>Notlar<textarea value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} placeholder="Bildiğiniz ayrıntıları kendi cümlelerinizle yazın." /><span className="hint">Yazdığınız metin olduğu gibi kaydedilir.</span></label>
      <label>Çalışma alanı<select value={slug} disabled={saving || !!record} onChange={(e) => setSlug(e.target.value)}>{writable.map((m) => <option key={m.slug} value={m.slug}>{m.name || (m.primary ? "Kişisel alanım" : "Paylaşılan alan")}</option>)}</select></label>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="entity-form-actions"><button type="button" className="secondary-button" onClick={onClose}>Kapat</button><button className="primary-button" disabled={saving || !writable.length || !name.trim()}>{saving ? "Kaydediliyor…" : "Kaydet"}</button></div>
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
    setLoading(true); setError(null);
    try {
      // ONE request for the whole directory. Listing each workspace and then reading every document
      // over its own call put hundreds of requests on every 30 s refresh of every open directory —
      // which is what the gateway's per-user guard answered with 429 "istek sınırına ulaşıldı".
      const { mounts: active, files, unreadable, truncated } = await readWorkspaceEntities();
      if (current !== generation.current) return;
      const bySlug = new Map(active.map((m) => [m.slug, m]));
      const all: DirectoryRecord[] = [];
      for (const file of files) {
        const mount = bySlug.get(file.slug);
        const record = mount ? directoryRecord(file.path, file.content, mount) : null;
        if (record) all.push(record);
      }
      setMounts(active); setRecords(all); hasLoaded.current = true;
      setError(truncated ? "Çok fazla kayıt var; listenin tamamı gösterilemiyor."
        : unreadable.length ? `${unreadable.length} çalışma alanı okunamadı; aşağıdakiler diğerlerinden geliyor.`
        : null);
    } catch {
      // A failed refresh leaves what is already on screen ALONE — a restarting backend or one dropped
      // request used to blank a populated page, and made a card that HAD been written read as a failure.
      if (current !== generation.current) return;
      setError(hasLoaded.current
        ? "Liste yenilenemedi; görünen kayıtlar son başarılı okumadan."
        : "Bilgiler yüklenemedi. Bağlantınızı ve çalışma alanı erişiminizi kontrol edin.");
      if (!hasLoaded.current) { setRecords([]); setMounts([]); }
    }
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
  // Partner notes have no list of their own: the directory was a third sidebar entry for a card
  // type people were not filing by hand. Notes the meeting agent writes are still readable through
  // their own entity pages and through search.
  for (const [id, kind, order] of [["people", "person", 31], ["companies", "company", 32]] as const) {
    registerList({ id, label: labels[kind].title, icon: labels[kind].icon, order,
      component: () => <DirectoryView id={id} params={{ directory: kind }} active />,
      centerTab: { id, title: labels[kind].title, kind: "directory", params: { directory: kind } } });
  }
}
