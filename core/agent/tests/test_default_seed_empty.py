"""A new default workspace contains user-created knowledge only."""
from pathlib import Path

from shared.seeding import seed_workspace

SEEDS = Path(__file__).resolve().parents[1] / "workspace-seeds"


def test_default_workspace_starts_with_empty_graph(tmp_path):
    workspace = tmp_path / "workspace"
    seed_workspace(workspace, SEEDS / "default")
    entities = workspace / "kg" / "entities"
    assert sorted(path.relative_to(entities).as_posix() for path in entities.rglob("*.md")) == [
        "company/index.md", "index.md", "meeting/index.md", "person/index.md",
    ]
    for path in [workspace / "CLAUDE.md", workspace / "onboarding.md", *entities.rglob("index.md")]:
        content = path.read_text()
        assert "Jane Liu" not in content
        assert "Acme Corp" not in content
    assert (workspace / "agents" / "meeting.md").is_file()
    assert (workspace / ".git").is_dir()


def test_refresh_preserves_user_record_and_opt_in_graph(tmp_path):
    workspace = tmp_path / "workspace"
    seed_workspace(workspace, SEEDS / "default")
    person = workspace / "kg" / "entities" / "person" / "jane-liu.md"
    content = "---\ntype: person\nid: jane-liu\ntitle: Jane Liu\n---\nActual user supplied notes.\n"
    person.write_text(content)
    seed_workspace(workspace, SEEDS / "default")
    assert person.read_text() == content
    finos = tmp_path / "finos"
    seed_workspace(finos, SEEDS / "finos")
    assert any(path.name != "index.md" for path in (finos / "kg" / "entities").rglob("*.md"))
