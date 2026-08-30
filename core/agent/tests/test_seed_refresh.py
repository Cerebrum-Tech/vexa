"""An existing workspace must receive template changes for the files it never touched — and must
keep every file it did touch.

Seeding runs once per workspace, so before this a template change (new guidance, a new language)
reached only workspaces created after it. Every workspace already in the volume kept whatever it was
born with, silently and forever.
"""
from pathlib import Path

from shared.seeding import refresh_workspace_seed, seed_workspace


def _seed(tmp_path: Path, **files: str) -> Path:
    seed = tmp_path / "seed"
    for rel, body in files.items():
        p = seed / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return seed


def test_untouched_files_follow_the_template(tmp_path):
    seed = _seed(tmp_path, **{"CLAUDE.md": "v1", "README.md": "eski", "agents/meeting.md": "v1"})
    ws = seed_workspace(tmp_path / "ws", seed)

    (seed / "README.md").write_text("yeni")
    (seed / "agents/meeting.md").write_text("v2")
    updated = refresh_workspace_seed(ws, seed)

    assert sorted(updated) == ["README.md", "agents/meeting.md"]
    assert (ws / "README.md").read_text() == "yeni"
    assert (ws / "agents/meeting.md").read_text() == "v2"


def test_a_file_the_user_edited_is_never_clobbered(tmp_path):
    seed = _seed(tmp_path, **{"CLAUDE.md": "v1", "README.md": "eski"})
    ws = seed_workspace(tmp_path / "ws", seed)

    (ws / "README.md").write_text("benim notlarım")   # the workspace owns it now
    (seed / "README.md").write_text("yeni")

    assert refresh_workspace_seed(ws, seed) == []
    assert (ws / "README.md").read_text() == "benim notlarım"


def test_a_new_template_file_is_added(tmp_path):
    seed = _seed(tmp_path, **{"CLAUDE.md": "v1"})
    ws = seed_workspace(tmp_path / "ws", seed)

    (seed / "views").mkdir()
    (seed / "views/meeting.tsx").write_text("<Toplantı />")

    assert refresh_workspace_seed(ws, seed) == ["views/meeting.tsx"]
    assert (ws / "views/meeting.tsx").read_text() == "<Toplantı />"


def test_a_workspace_only_file_is_left_alone(tmp_path):
    """A path the seed commit never carried belongs to the workspace, even if the template later
    ships the same path — overwriting it would destroy the agent's own work."""
    seed = _seed(tmp_path, **{"CLAUDE.md": "v1"})
    ws = seed_workspace(tmp_path / "ws", seed)
    (ws / "notlar.md").write_text("asistanın yazdığı")

    (seed / "notlar.md").write_text("şablondan")
    assert refresh_workspace_seed(ws, seed) == []
    assert (ws / "notlar.md").read_text() == "asistanın yazdığı"


def test_seed_workspace_refreshes_an_existing_workspace(tmp_path):
    """The wiring: the refresh happens on the ordinary seeding path, so an existing workspace
    converges on next use without an operator running anything."""
    seed = _seed(tmp_path, **{"CLAUDE.md": "v1", "README.md": "eski"})
    ws = seed_workspace(tmp_path / "ws", seed)
    (seed / "README.md").write_text("yeni")

    seed_workspace(tmp_path / "ws", seed)
    assert (ws / "README.md").read_text() == "yeni"


def test_refresh_is_a_noop_on_an_unseeded_path(tmp_path):
    assert refresh_workspace_seed(tmp_path / "nope", tmp_path / "seed") == []
