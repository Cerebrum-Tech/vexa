"""The knowledge-graph entity a PERSON writes — rendered here, identically for the endpoint that
validates the request and the worker that commits it.

A directory card is a typed markdown file (``kg/entities/<type>/<slug>.md``), and a person filling in
a two-field form has already said everything the file needs: its title and its body. Nothing about
that is a language problem, so nothing here calls a model — the same input always renders the same
bytes, which is what lets the endpoint compute the file it expects and compare it to the one that
landed. The agent still writes entities of its own from meetings; this is the hand-written half.
"""
from __future__ import annotations

import re
import unicodedata

#: The entity types a person can author from the directories. `note` is the partner-note type the
#: meeting agent also writes; `meeting` is deliberately absent — those are authored from a meeting.
KINDS = ("person", "company", "note")

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
_TRANSLITERATE = str.maketrans({"ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
                                "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c"})


class EntityEditError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def entity_slug(title: str) -> str:
    """An ASCII file-name slug for a Turkish title. `i̇` (the dotted i's decomposition) and every other
    combining mark is dropped rather than spelled out, so `Görüşme` becomes `gorusme`, not `g-r-me`."""
    folded = unicodedata.normalize("NFKD", title.translate(_TRANSLITERATE).lower())
    ascii_only = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return _SLUG_STRIP.sub("-", ascii_only).strip("-")


def entity_path(kind: str, title: str, *, suffix: str) -> str:
    """Where a NEW entity of this kind lives. ``suffix`` disambiguates two cards with one name and is
    supplied by the caller (the client's own id), never invented here — the render has to be a pure
    function of the request for the endpoint to be able to predict the file."""
    if kind not in KINDS:
        raise EntityEditError(422, "Bilinmeyen kayıt türü.")
    slug = entity_slug(title) or kind
    tail = _SLUG_STRIP.sub("-", suffix.lower()).strip("-")
    if not tail:
        raise EntityEditError(422, "Kayıt kimliği eksik.")
    return f"kg/entities/{kind}/{slug}-{tail}.md"


def validate_entity_path(path: str, kind: str) -> str:
    """The path a caller supplied for an EXISTING card, refused unless it is one this module could
    have produced: inside the kind's own folder, one markdown file deep, no traversal, no index."""
    cleaned = (path or "").strip()
    prefix = f"kg/entities/{kind}/"
    name = cleaned[len(prefix):] if cleaned.startswith(prefix) else ""
    if (not name or not name.endswith(".md") or "/" in name or name.startswith(".")
            or name in ("index.md", "readme.md", "log.md")):
        raise EntityEditError(422, "Kayıt yolu bu türe ait değil.")
    return cleaned


def render_entity(*, kind: str, title: str, body: str, entity_id: str) -> str:
    """The file's exact bytes: the three mandated frontmatter fields, then the person's own text.

    The body is written through untouched apart from newline and trailing-space normalization. It is
    what the author typed — rewriting it is the model's job in a turn they did not ask for."""
    if kind not in KINDS:
        raise EntityEditError(422, "Bilinmeyen kayıt türü.")
    name = " ".join((title or "").split())
    if not name:
        raise EntityEditError(422, "Başlık zorunludur.")
    if len(name) > 200:
        raise EntityEditError(422, "Başlık en fazla 200 karakter olabilir.")
    identifier = (entity_id or "").strip()
    if not identifier:
        raise EntityEditError(422, "Kayıt kimliği eksik.")
    text = "\n".join(line.rstrip() for line in (body or "").replace("\r\n", "\n").split("\n")).strip()
    if len(text) > 100_000:
        raise EntityEditError(422, "Metin çok uzun.")
    # Quoted with double quotes and inner quotes doubled-escaped: a title carrying `:` or `#` would
    # otherwise re-parse as something else entirely when the workspace is read back.
    safe_title = name.replace("\\", "\\\\").replace('"', '\\"')
    front = f'---\ntype: {kind}\nid: {identifier}\ntitle: "{safe_title}"\n---\n'
    return f"{front}\n{text}\n" if text else front
