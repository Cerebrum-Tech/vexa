// Harness-governed Meeting Canvas view. The terminal trial-renders this before promotion.
// Live FIRST-PERSON transcript: model-cleaned lines plus local fallback lines in one attributed body.
const STATUS_LABEL = {
  idle: "Boşta",
  scheduled: "Zamanlandı",
  requested: "İstendi",
  joining: "Katılıyor",
  awaiting_admission: "Bekliyor",
  needs_help: "Yardım gerekli",
  active: "Canlı",
  live: "Canlı",
  stopping: "Durduruluyor",
  completed: "Tamamlandı",
  past: "Tamamlandı",
  failed: "Başarısız",
  stopped: "Durduruldu",
};

function statusLabel(status) {
  const v = String(status || "live").toLowerCase();
  const label = STATUS_LABEL[v];
  return typeof label === "string" ? label : v.replace(/_/g, " ");
}

function statusTone(status) {
  const v = String(status || "live").toLowerCase();
  if (v === "active" || v === "live") return "green";
  if (v === "completed" || v === "past") return "green";
  if (v === "scheduled" || v === "joining" || v === "awaiting_admission") return "accent";
  return "warn";
}

export default function MeetingCanvas() {
  const meeting = useMeeting();
  const notes = useMeetingNotes();
  const cleanNotes = notes.map((note) => ({ ...note, chapter: "" }));

  const status = meeting.meeting.status || "live";
  const title = meeting.meeting.title || "Toplantı";

  return (
    <ui.Stack size="lg">
      <ui.Row align="left" size="sm">
        <ui.Badge tone={statusTone(status)}>{statusLabel(status)}</ui.Badge>
        <ui.Tag tone="default">{title}</ui.Tag>
      </ui.Row>

      <ui.Section title="Transkript">
        <ui.LiveNotes notes={cleanNotes} maxNotes={80} merge empty="Katılımcılar konuştukça temiz ve konuşana atanmış transkript burada belirir." />
      </ui.Section>
    </ui.Stack>
  );
}
