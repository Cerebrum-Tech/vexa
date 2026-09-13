"use client";
/** Page-oriented workspace shell. Contributions own content; the shell owns navigation and context. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Menu, X, ChevronRight } from "lucide-react";
import { useService, useStore, KeybindingServiceId } from "../platform";
import { LayoutServiceId, type TabDescriptor } from "./layout";
import { CommandPalette } from "./CommandPalette";
import { registry } from "../contributions";
import { Icon } from "../ui-kit";
import { readActiveSet } from "../surfaces/workspaceApi";
import { Chat } from "../surfaces/chat";
import { ReportNotifications } from "../canvas/ReportNotifications";
import { MeetingStatusNotices } from "../canvas/MeetingStatusNotices";
import { meetingConversationSession } from "../surfaces/sessionsApi";
import { resolveDocRef } from "../ui-kit/docLinks";
import { useLiveMeetings } from "../surfaces/liveMeetings";
import { isOwnedPath, meetingIdFromPath, meetingPath } from "../app/meetingRoute";
import { ASK_CHAT_EVENT, OPEN_ENTITY_EVENT } from "../canvas/actions";
import { useTheme } from "../app/theme";
import { meetingsOnly } from "../app/mode";
import "../surfaces/directories";

const library: TabDescriptor = { id: "today", title: "Toplantılar", kind: "today", params: {} };
const navigation = [
  { id: "meetings", title: "Toplantılar", icon: "cal", page: library },
  { id: "people", title: "Kişiler", icon: "user", page: { id: "people", title: "Kişiler", kind: "directory", params: { directory: "person" } } },
  { id: "companies", title: "Şirketler", icon: "building", page: { id: "companies", title: "Şirketler", kind: "directory", params: { directory: "company" } } },
  { id: "partners", title: "İş Ortağı Notları", icon: "file", page: { id: "partners", title: "İş Ortağı Notları", kind: "directory", params: { directory: "partner" } } },
];

export function Workbench() {
  const layout = useService(LayoutServiceId);
  const keybindings = useService(KeybindingServiceId);
  const { page, activeList, activeSession, rightCollapsed } = useStore(layout.store);
  const [theme, toggleTheme] = useTheme();
  const [mobileNav, setMobileNav] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const restoreMenuFocus = useRef(false);
  const [user, setUser] = useState<{ name?: string; email?: string } | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const meetOnly = meetingsOnly();
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  const meetings = useLiveMeetings();
  const canonicalMeeting = page?.kind === "meeting"
    ? meetings.find((m) => m.id === String(page.params?.meetingId)) ?? meetings.find((m) => m.native_id === String(page.params?.meetingId)) : undefined;
  const routeMeeting = useRef(typeof window === "undefined" ? null : meetingIdFromPath(window.location.pathname));
  const initialized = useRef(false);

  useEffect(() => { const d = keybindings.attach(window); return () => d.dispose(); }, [keybindings]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 960px)");
    const update = () => { setIsMobile(media.matches); if (!media.matches) setMobileNav(false); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobileNav && restoreMenuFocus.current) { restoreMenuFocus.current = false; menuRef.current?.focus(); }
    if (!mobileNav || !isMobile) return;
    const focusable = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('button, a[href], summary, [tabindex="0"]') ?? [])
      .filter((element) => element.getClientRects().length > 0 && !element.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); restoreMenuFocus.current = true; setMobileNav(false); }
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", trap, true);
    return () => window.removeEventListener("keydown", trap, true);
  }, [mobileNav, isMobile]);
  useEffect(() => {
    layout.usePages();
    if (initialized.current) return;
    initialized.current = true;
    let sharedMeeting: string | null = null;
    let sharedWorkspace: string | null = null;
    try {
      sharedMeeting = localStorage.getItem("vexa.openMeeting");
      sharedWorkspace = localStorage.getItem("vexa.openWorkspace");
      localStorage.removeItem("vexa.openMeeting"); localStorage.removeItem("vexa.openWorkspace");
    } catch { /* navigation still works without browser storage */ }
    const id = sharedMeeting || routeMeeting.current;
    if (sharedWorkspace && !meetOnly) {
      layout.openTab({ id: `doc:${sharedWorkspace}:README.md`, title: "Paylaşılan çalışma alanı", kind: "doc", params: { path: "README.md", slug: sharedWorkspace } });
    }
    if (id) layout.openTab({ id: `meeting:${id}`, title: "Toplantı", kind: "meeting", params: { meetingId: id } });
  }, [layout, meetOnly]);
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
      .then((r) => { if (alive) setUser(r?.user ?? null); }).catch(() => {});
    if (!meetOnly) readActiveSet().then((r) => { if (alive) { setSubject(r.subject); setIdentityError(false); } })
      .catch(() => { if (alive) setIdentityError(true); });
    return () => { alive = false; };
  }, [meetOnly]);
  useEffect(() => {
    if (!page || !isOwnedPath(window.location.pathname)) return;
    const next = page.kind === "meeting" ? meetingPath(String(page.params?.meetingId ?? "")) : "/";
    if (next !== window.location.pathname) window.history.replaceState(window.history.state, "", next + window.location.search + window.location.hash);
  }, [page]);
  useEffect(() => {
    const onEntity = async (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; wikilink?: string; slug?: string; docPath?: string }>).detail ?? {};
      const r = await resolveDocRef(detail, { path: detail.docPath, slug: detail.slug });
      if (r) layout.openTab({ id: `doc:${r.slug ?? ""}:${r.path}`, title: "Bilgi notu", kind: "doc", params: { path: r.path, slug: r.slug } });
    };
    const onAsk = () => layout.showRight();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNav(false); };
    window.addEventListener(OPEN_ENTITY_EVENT, onEntity);
    window.addEventListener(ASK_CHAT_EVENT, onAsk);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener(OPEN_ENTITY_EVENT, onEntity); window.removeEventListener(ASK_CHAT_EVENT, onAsk); window.removeEventListener("keydown", onKey); };
  }, [layout]);

  const navigate = (id: string, next: TabDescriptor) => { layout.openTab(next); layout.setActiveList(id, false); setMobileNav(false); };
  const name = user?.name || user?.email?.split("@")[0] || "Hesabım";
  const initials = name.split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toLocaleUpperCase("tr");
  const title = page?.kind === "meeting" ? "Toplantı ayrıntıları" : page?.title ?? "Toplantılar";
  const Content = page?.kind === "list" ? registry.list(String(page.params?.list))?.component : registry.tabComponent(page?.kind ?? "today");
  const session = canonicalMeeting && subject ? meetingConversationSession(subject, canonicalMeeting.id) : activeSession;
  const extraLists = registry.lists().filter((l) => !["meetings", "sessions", "people", "companies", "partners"].includes(l.id));
  const logout = () => void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage unavailable */ }
    window.location.reload();
  });

  return <div className={`workspace-shell${mobileNav ? " nav-open" : ""}`}>
    <a className="skip-link" href="#workspace-content">İçeriğe geç</a>
    {mobileNav && <button className="nav-scrim" aria-label="Menüyü kapat" onClick={() => setMobileNav(false)} />}
    <aside ref={sidebarRef} className="workspace-sidebar" aria-label="Ana menü" inert={isMobile && !mobileNav}>
      <a className="workspace-brand" href="/" onClick={(e) => { e.preventDefault(); navigate("meetings", library); }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/innova-logo.svg" alt="Innova" width={116} height={38} />
        <span>Toplantı Asistanı</span>
      </a>
      <div className="nav-heading">ÇALIŞMA ALANIM</div>
      <nav className="workspace-nav">
        {navigation.filter((n) => !meetOnly || n.id === "meetings").map((n) => <button key={n.id}
          aria-current={activeList === n.id && !["settings", "list"].includes(page?.kind ?? "") ? "page" : undefined}
          onClick={() => navigate(n.id, n.page)}><Icon name={n.icon} size={19} /><span>{n.title}</span>
          {n.id === "meetings" && meetings.some((m) => m.status === "live") && <span className="nav-live-dot" aria-label="Canlı toplantı var" />}
        </button>)}
      </nav>
      {!meetOnly && <div className="sidebar-assistant">
        <div className="assistant-symbol"><Icon name="spark" size={23} /></div>
        <strong>Birlikte düşünelim.</strong>
        <p>Toplantılarınız ve notlarınız hakkında asistanınıza danışın.</p>
        <button onClick={() => { navigate("assistant", { id: "assistant", title: "Asistan", kind: "assistant", params: {} }); layout.showRight(); }}>Asistana sor <ChevronRight size={15} /></button>
      </div>}
      <div className="sidebar-bottom">
        {extraLists.length > 0 && <details className="workspace-tools"><summary>Diğer araçlar</summary>{extraLists.map((l) => <button key={l.id} onClick={() => navigate(l.id, l.centerTab ?? { id: `list:${l.id}`, title: l.label, kind: "list", params: { list: l.id } })}><Icon name={l.icon} size={16} />{l.id === "files" ? "Çalışma alanları" : l.label}</button>)}</details>}
        <button className="settings-link" onClick={() => navigate("settings", { id: "settings", title: "Ayarlar", kind: "settings", params: {} })}><Icon name="gear" size={18} />Ayarlar</button>
        <div className="workspace-profile"><span className="avatar">{initials}</span><div><strong>{name}</strong><small>{user?.email ?? ""}</small></div>
          <button className="icon-button" onClick={logout} aria-label="Çıkış yap" title="Çıkış yap"><Icon name="logout" size={17} /></button></div>
      </div>
    </aside>
    <div className="workspace-main" inert={isMobile && mobileNav}>
      <header className="workspace-topbar">
        <button ref={menuRef} className="icon-button mobile-menu" aria-label="Menüyü aç" aria-expanded={mobileNav} onClick={() => setMobileNav(!mobileNav)}><Menu size={21} /></button>
        <div className="workspace-breadcrumb"><span>Çalışma alanım</span><ChevronRight size={14} /><strong>{title}</strong></div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={toggleTheme} aria-label={theme === "light" ? "Koyu tema" : "Açık tema"}><Icon name={theme === "light" ? "moon" : "sun"} size={19} /></button>
          {!meetOnly && <ReportNotifications subject={subject} onOpen={(meetingId) => navigate("meetings", { id: `meeting:${meetingId}`, title: "Toplantı", kind: "meeting", params: { meetingId } })} />}
          {!meetOnly && <MeetingStatusNotices onOpen={(meetingId) => navigate("meetings", { id: `meeting:${meetingId}`, title: "Toplantı", kind: "meeting", params: { meetingId } })} />}
          <span className="avatar avatar-small" aria-hidden="true">{initials}</span>
        </div>
      </header>
      <div className="workspace-body">
        <main id="workspace-content" className={`workspace-page${page?.kind === "assistant" ? " assistant-home" : ""}`} tabIndex={-1}>
          {page?.kind !== "today" && <div className="page-context-bar"><button className="text-button" onClick={() => { if (!layout.goBack()) navigate("meetings", library); }}><ArrowLeft size={16} />Geri</button>
            {page?.kind === "meeting" && !meetOnly && <button className="secondary-button" onClick={() => layout.showRight()}><Icon name="spark" size={17} />Toplantı asistanı</button>}
          </div>}
          {page?.kind === "assistant" ? <div className="assistant-welcome"><Icon name="spark" size={36} /><h1>Bir soruyla başlayın.</h1><p>Toplantılarınızdan fikirlerinize, ihtiyacınız olan bilgi birlikte daha yakın.</p></div>
            : Content ? <Content key={page?.id} id={page?.id ?? "today"} params={page?.params ?? {}} active />
              : <div className="empty-state"><h2>Bu bölüm şu anda açılamıyor.</h2><button className="secondary-button" onClick={() => navigate("meetings", library)}>Toplantılara dön</button></div>}
        </main>
        {!meetOnly && <aside className={`workspace-chat${rightCollapsed ? " is-hidden" : ""}`} aria-label="Asistan" aria-hidden={rightCollapsed}>
          <div className="chat-panel-heading"><span><Icon name="spark" size={18} />{canonicalMeeting ? "Toplantı asistanı" : "Asistan"}</span><button className="icon-button" aria-label="Asistanı kapat" onClick={() => layout.toggleRight()}><X size={19} /></button></div>
          {subject && (page?.kind !== "meeting" || canonicalMeeting) ? <Chat hideHeader={!!canonicalMeeting} params={{ subject, session, ...(canonicalMeeting ? { meetingId: canonicalMeeting.id } : {}) }} />
            : <div className="empty-state" role="status">{identityError ? <>Asistan bağlantısı kurulamadı.<button className="text-button" onClick={() => { setIdentityError(false); void readActiveSet().then((r) => setSubject(r.subject)).catch(() => setIdentityError(true)); }}>Yeniden dene</button></> : "Asistan hazırlanıyor…"}</div>}
        </aside>}
      </div>
    </div>
    <CommandPalette />
  </div>;
}
