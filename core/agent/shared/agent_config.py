"""agent_config.py — the GOVERNED, workspace-driven config for per-agent behavior.

The user/agent steers the real-time meeting copilot through a VISIBLE, git-governed file in their
workspace: ``agents/meeting.md`` (a per-agent config home — NOT a dotfile, so it shows in the Files
tree and the user can read+edit it; seeded from the workspace template). It is YAML frontmatter (the
knobs) + a natural-language body (steering merged into the copilot prompt).

This module is deliberately small, isolated, and unit-testable: it has no redis/docker/claude
dependency. Parsing is TOLERANT — a missing file, missing/partial frontmatter, or malformed YAML each
fall back PER-KEY to the defaults, and the body (if any) is always taken as steering.

Two keys resolve in TIERS, not from a constant alone: the workspace's frontmatter overrides the
DEPLOYMENT default (an env var the operator sets — ``VEXA_MEETING_MODEL``/``VEXA_LLM_MODEL`` for the
model, ``VEXA_REPORT_LANGUAGE`` for the report language), which overrides the code default. The
deployment tier is what reaches a workspace seeded before the operator made the choice: seeding runs
once per workspace and never again, so a seed edit reaches only new workspaces while the env reaches
every turn.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

log = logging.getLogger(__name__)

# PROVIDER-AGNOSTIC model governance: a model is a FREE STRING the llm module's provider adapter
# interprets — NO vendor names or committed model list live in code. Resolution (call-time, so a
# respawned worker sees current env): VEXA_MEETING_MODEL (meeting-specific) → VEXA_LLM_MODEL (the
# deployment default) → "" (the adapter's own default, or fail-loud where a model is required).
def default_meeting_model() -> str:
    return os.environ.get("VEXA_MEETING_MODEL") or os.environ.get("VEXA_LLM_MODEL") or ""


def model_allowlist() -> frozenset[str]:
    """The OPTIONAL operator gate on workspace-pinned models: ``VEXA_MODEL_ALLOWLIST`` (comma-
    separated). Empty/unset ⇒ allow any route — the config file is governed but user-editable, so
    operators who need to bound spend or routes set the env; nobody else pays a code-change."""
    raw = os.environ.get("VEXA_MODEL_ALLOWLIST", "")
    return frozenset(m.strip() for m in raw.split(",") if m.strip())

DEFAULT_CARD_KINDS: tuple[str, ...] = ("person", "company", "product")
DEFAULT_CADENCE_SEGMENTS = 4
DEFAULT_REPORT_LANGUAGE = "en"
SUPPORTED_REPORT_LANGUAGES = frozenset({"en", "tr"})


def default_report_language() -> str:
    """The DEPLOYMENT default language of the post-meeting report: ``VEXA_REPORT_LANGUAGE`` (a P14 app
    var), read at call time so a respawned worker sees the current env. A workspace's own
    ``agents/meeting.md`` frontmatter stays the per-workspace OVERRIDE; the env is what every workspace
    that never states a language follows — including the ones seeded before the operator chose a
    language, which are never re-seeded. Unset or unsupported ⇒ ``DEFAULT_REPORT_LANGUAGE``."""
    raw = os.environ.get("VEXA_REPORT_LANGUAGE", "")
    language = raw.strip().lower()
    if not language:
        return DEFAULT_REPORT_LANGUAGE
    if language in SUPPORTED_REPORT_LANGUAGES:
        return language
    log.warning(
        "VEXA_REPORT_LANGUAGE=%r is not one of %s — using %r",
        raw, sorted(SUPPORTED_REPORT_LANGUAGES), DEFAULT_REPORT_LANGUAGE,
    )
    return DEFAULT_REPORT_LANGUAGE

# v2 DEFAULTS — the polish + tagging POLICY. These live as code fallbacks but the user GOVERNS them by
# editing ``agents/meeting.md`` (the seed carries the same text); changing the file changes the prompt,
# no redeploy. The mechanism is in code (``build_card_prompt`` composes around the transcript window);
# the policy is this prose. The policy is written in Turkish and names the Turkish output language
# explicitly, because it governs the wording of every note the user reads; the English frame around it
# (``_CARD_FRAME``) carries the machine-readable JSON contract and stays English on purpose.
DEFAULT_POLISH_RULES = (
    "Bu dağıtımın çıktı dili TÜRKÇEDİR: ürettiğin her notu ve kullanıcının okuduğu her cümleyi Türkçe "
    "yaz. Bir konuşmacı başka bir dilde konuştuysa onun sözlerini çevirme, olduğu gibi koru.\n"
    "Her satırı DAİMA BİRİNCİ TEKİL KİŞİ ağzından, konuşmacının kastettiği anlamla yaz: \"Konuşmacı "
    "fiyatlandırmayı gözden geçireceğini söylüyor.\" DEĞİL — \"Fiyatlandırmayı cuma gününe kadar gözden "
    "geçireceğim.\" Düz olguları doğrudan aktar (\"Anthropic yeni bir model yayımladı.\"). Yalnızca "
    "HAFİF bir okunabilirlik temizliği uygula: örtüşen veya tekrar eden satırları teke indir, noktalama "
    "ile büyük/küçük harf hatalarını düzelt, parçalı ifadeleri okunabilir cümlelere birleştir. Bu, ağır "
    "bir anlamsal yeniden yazım ya da özet DEĞİLDİR — her olguyu, konuşmacının kelimelerini, "
    "tereddüdünü ve tonunu koru. Dolgu sözlerini, yarım kalan başlangıçları ve bariz transkript/model "
    "artıklarını çıkar. Eksik içerik UYDURMA. Özel adları, ürün ve teknoloji adlarını olduğu gibi bırak."
    "\nASLA gözlemci kalıbı yazma — ne Türkçesini ne İngilizcesini: \"Konuşmacı söylüyor\", \"Konuşmacı "
    "belirtiyor\", \"Konuşmacı ifade ediyor\", \"Konuşmacı dile getiriyor\", \"Konuşmacı aktarıyor\", "
    "\"Konuşmacı anlatıyor\", \"Konuşmacı açıklıyor\", \"Konuşmacı vurguluyor\", \"Konuşmacı not "
    "ediyor\", \"Konuşmacı bildiriyor\", \"Konuşmacı duyuruyor\", \"Konuşmacı "
    "paylaşıyor\", \"Konuşmacı diyor ki\", \"Konuşmacı ... olduğunu düşünüyor\", \"Konuşmacı ... "
    "-acağını/-eceğini söylüyor\", \"Konuşmacı ... istiyor/planlıyor/soruyor\", \"Speaker says\", "
    "\"the speaker describes\", \"they talk about\". Bu kalıpların yerine cümleyi doğrudan birinci "
    "tekil kişiye çevir."
)
DEFAULT_TAG_RULES = (
    "Araştırmaya değer VARLIK ANAHTAR KELİMELERİNİ öne çıkar: adıyla anılan kişiler, şirketler ve "
    "ürünler/teknolojiler. Yalnızca satırlarda fiilen geçen somut adları yüzeye çıkar — uydurma. "
    "Sinyalleri (kararlar, aksiyon maddeleri, sorular, iddialar) veya düz sayıları ETİKETLEME; yalnızca "
    "varlıkları etiketle. Kart başlığı varlığın adının kendisidir — adı çevirme veya değiştirme; kart "
    "gövdesini ve kullanıcının okuduğu diğer bütün metni Türkçe yaz."
)


@dataclass(frozen=True)
class MeetingConfig:
    """The resolved meeting-copilot knobs (every field has a code default; see ``load_meeting_config``)."""

    enabled: bool = True
    model: str = field(default_factory=default_meeting_model)
    cadence_segments: int = DEFAULT_CADENCE_SEGMENTS
    card_kinds: list[str] = field(default_factory=lambda: list(DEFAULT_CARD_KINDS))
    write_meeting_doc: bool = True
    report_language: str = field(default_factory=default_report_language)
    steering: str = ""
    # Workspace-governed POLICY (prompt-only governance): edit agents/meeting.md to change behavior.
    polish_rules: str = DEFAULT_POLISH_RULES
    tag_rules: str = DEFAULT_TAG_RULES


_FRONTMATTER = re.compile(r"^\s*---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)

# Where the per-agent config lives in the workspace (visible, git-governed).
MEETING_CONFIG_PATH = "agents/meeting.md"


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Return (frontmatter-dict, body). Tolerant: no fence ⇒ ({}, whole-text-as-body); bad yaml ⇒
    ({}, body)."""
    m = _FRONTMATTER.match(text)
    if not m:
        return {}, text.strip()
    raw_fm, body = m.group(1), m.group(2)
    try:
        data = yaml.safe_load(raw_fm)
    except yaml.YAMLError:
        log.warning("agents/meeting.md: malformed YAML frontmatter — using defaults")
        return {}, body.strip()
    if not isinstance(data, dict):
        return {}, body.strip()
    return data, body.strip()


def _as_bool(val: object, default: bool) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in {"true", "yes", "1", "on"}
    return default


def _as_model(val: object) -> str:
    """A workspace-pinned model is a free string passed through to the provider adapter. When the
    operator set ``VEXA_MODEL_ALLOWLIST``, an off-list route falls back to the deployment default
    with a log line (a typo cannot silently pin an unexpected route); with no allowlist, any
    non-blank route passes."""
    if isinstance(val, str) and val.strip():
        candidate = val.strip()
        allow = model_allowlist()
        if not allow or candidate in allow:
            return candidate
        log.warning(
            "agents/meeting.md: model %r not in VEXA_MODEL_ALLOWLIST — falling back to default %r",
            candidate, default_meeting_model(),
        )
    return default_meeting_model()


def _as_cadence(val: object) -> int:
    try:
        n = int(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_CADENCE_SEGMENTS
    return n if n >= 1 else DEFAULT_CADENCE_SEGMENTS


def _as_rules(val: object, default: str) -> str:
    """A governed POLICY string (polish_rules / tag_rules). A non-empty string (frontmatter scalar)
    overrides the code default; anything else (absent, blank, non-string) falls back to the default so a
    partial config never blanks out the policy."""
    if isinstance(val, str) and val.strip():
        return val.strip()
    return default


def _as_report_language(val: object) -> str:
    """The workspace's own ``report_language`` frontmatter is the OVERRIDE. Absent, blank, or an
    unsupported value falls back to the deployment default (``default_report_language``), never
    straight to the code constant — so an operator's ``VEXA_REPORT_LANGUAGE`` reaches every workspace
    that does not state a language of its own."""
    if isinstance(val, str):
        language = val.strip().lower()
        if language in SUPPORTED_REPORT_LANGUAGES:
            return language
    return default_report_language()


def _as_card_kinds(val: object) -> list[str]:
    if isinstance(val, (list, tuple)):
        kinds = [str(k).strip().lower() for k in val if str(k).strip()]
        if kinds:
            return kinds
    return list(DEFAULT_CARD_KINDS)


def load_meeting_config(work: Path) -> MeetingConfig:
    """Read ``<work>/agents/meeting.md`` and return the resolved ``MeetingConfig`` with PER-KEY
    fallback to the deployment/code defaults. Absent file ⇒ all defaults. Tolerant of bad YAML / no
    frontmatter (body, if any, is still used as steering)."""
    path = Path(work) / MEETING_CONFIG_PATH
    if not path.exists():
        return MeetingConfig()
    try:
        text = path.read_text()
    except OSError:
        return MeetingConfig()

    fm, body = _split_frontmatter(text)
    return MeetingConfig(
        enabled=_as_bool(fm.get("enabled"), True),
        model=_as_model(fm.get("model")),
        cadence_segments=_as_cadence(fm.get("cadence_segments")),
        card_kinds=_as_card_kinds(fm.get("card_kinds")),
        write_meeting_doc=_as_bool(fm.get("write_meeting_doc"), True),
        report_language=_as_report_language(fm.get("report_language")),
        steering=body,
        polish_rules=_as_rules(fm.get("polish_rules"), DEFAULT_POLISH_RULES),
        tag_rules=_as_rules(fm.get("tag_rules"), DEFAULT_TAG_RULES),
    )
