"""Workspace-seed localization: the templates ship Turkish, their machine-read literals do not.

`default` is the template materialized into every workspace (`shared/seeding.py`). `finos` is the
opt-in FINOS-ecosystem demo selected with `VEXA_DEFAULT_TEMPLATE=finos`. Both are pinned across the
same four surfaces, because a seed that is Turkish in its chrome and English in its agent
instructions governs the agent to two different languages at once: the dashboard and the copilot
steering decide what the user reads, and CLAUDE.md + onboarding.md decide what the agent writes.
The pre-loaded FINOS knowledge graph is the one part that stays English — it is sourced verbatim
from public English material and carries its own `Source:` provenance — so it is not pinned here.

Assertions are headings and short phrases rather than whole sentences: copy gets reworded, and a
test that breaks on a comma is a test that gets deleted.
"""
from pathlib import Path


SEEDS = Path(__file__).resolve().parents[1] / "workspace-seeds"

# Every surface of the template that lands in a real workspace.
SEED_SURFACES = ("README.md", "CLAUDE.md", "onboarding.md", "agents/meeting.md")

TURKISH_MARKERS = {
    "README.md": ("# Çalışma alanınız", "## Kişiler", "## Şirketler ve kuruluşlar"),
    "CLAUDE.md": ("## Dil (bağlayıcı)", "her zaman Türkçe"),
    "onboarding.md": ("## Dil (bağlayıcı)", "her zaman Türkçe"),
    "agents/meeting.md": ("Türkçe yazın", "konuşmacının konuştuğu dilde kalır"),
}

# The headings the English originals carried. Their absence is what proves a surface was actually
# translated rather than appended to.
ENGLISH_HEADINGS = (
    "# Your workspace",
    "## People",
    "## Companies & organizations",
    "## Recent meetings",
    "## Tasks & follow-ups",
    "New here?",
)

# Read by the machine, never by the reader: frontmatter keys, enum values compared in code, entity
# type slugs, paths, env var names. A translator that touches these breaks config loading, so they
# are pinned as a negative control.
MACHINE_LITERALS = (
    "enabled: true",
    "cadence_segments: 4",
    "card_kinds: [person, company, product]",
    "write_meeting_doc: true",
    "report_language: tr",
    "polish_rules: >",
    "tag_rules: >",
    "VEXA_MEETING_MODEL",
)


def _read(variant: str, surface: str) -> str:
    return (SEEDS / variant / surface).read_text(encoding="utf-8")


def test_every_template_is_turkish_on_every_surface_it_ships():
    for variant in ("default", "finos"):
        for surface in SEED_SURFACES:
            text = _read(variant, surface)
            for marker in TURKISH_MARKERS[surface]:
                assert marker in text, f"{variant}/{surface} is missing {marker!r}"


def test_no_english_headings_survive_on_a_translated_surface():
    for variant in ("default", "finos"):
        for surface in SEED_SURFACES:
            text = _read(variant, surface)
            for heading in ENGLISH_HEADINGS:
                assert heading not in text, f"{variant}/{surface} still carries {heading!r}"


def test_both_templates_select_turkish_post_meeting_reports():
    for variant in ("default", "finos"):
        assert "report_language: tr" in _read(variant, "agents/meeting.md")


def test_machine_read_literals_are_left_untranslated():
    for variant in ("default", "finos"):
        text = _read(variant, "agents/meeting.md")
        for literal in MACHINE_LITERALS:
            assert literal in text, f"{variant}/agents/meeting.md lost the literal {literal!r}"


def test_entity_contract_literals_survive_in_the_dashboards():
    for variant in ("default", "finos"):
        text = _read(variant, "README.md")
        assert "kg/entities/person/" in text
        assert "self: true" in text
