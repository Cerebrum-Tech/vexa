"""seeding.py — materialize a per-subject workspace from a VALIDATED template, plus the 'passes checks'
gate for any candidate seed folder.

The seed source can be ANY folder that clears `validate_seed` (carries a CLAUDE.md governance root); the
rest of the template (agents/, views/, skills/) is optional and domain-specific. `seed_workspace` is the
single seeding primitive — copy the template tree, then `git init` + a seed commit — idempotent on an
existing repo. (Extracted from the retired MVP0 chat_runner; wired into the worker's first-dispatch
seeding in the seed-consolidation phase.)
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from shared.gitenv import scrubbed_git_env

# A folder may serve as a workspace seed only if it carries these — the minimum a workspace needs to be
# governable. CLAUDE.md is the auto-loaded root memory/contract every turn reads; without it the
# workspace has no governance root.
REQUIRED_SEED_PATHS = ("CLAUDE.md",)

# The seeds ROOT is a registry of named templates — one validated seed per subdir
# (``workspace-seeds/<name>/``). Flavors today: ``default`` (the default — a LIGHT, ready-to-go scaffold
# whose README is the onboarding-dashboard the user first sees) and ``finos`` (the default scaffold PLUS a
# pre-loaded FINOS-ecosystem knowledge graph, selectable via ``VEXA_DEFAULT_TEMPLATE=finos`` or an explicit
# ``VEXA_WORKSPACE_SEED_DIR``). Adding a flavor is a new subdir, no code change. ``resolve_seed_dir`` is the
# single selection seam.
DEFAULT_TEMPLATE = "default"
DEFAULT_SEEDS_ROOT = "/app/workspace-seeds"


def resolve_seed_dir(template: "str | None" = None, *, seeds_root: "str | Path | None" = None) -> Path:
    """Resolve which seed template a workspace is materialized from. Precedence:

    1. ``VEXA_WORKSPACE_SEED_DIR`` — an explicit, already-resolved seed dir (tests / special deploys);
       overrides selection entirely.
    2. ``<seeds_root>/<template>`` — pick a named template out of the registry root. ``seeds_root``
       falls back to ``VEXA_WORKSPACE_SEEDS_DIR`` then ``/app/workspace-seeds``; ``template`` falls back
       to ``default``.
    """
    explicit = os.environ.get("VEXA_WORKSPACE_SEED_DIR")
    if explicit:
        return Path(explicit)
    root = Path(seeds_root or os.environ.get("VEXA_WORKSPACE_SEEDS_DIR", DEFAULT_SEEDS_ROOT))
    return root / (template or DEFAULT_TEMPLATE)


def list_templates(seeds_root: "str | Path | None" = None) -> list[str]:
    """The named templates available in the registry root (each a valid seed subdir)."""
    root = Path(seeds_root or os.environ.get("VEXA_WORKSPACE_SEEDS_DIR", DEFAULT_SEEDS_ROOT))
    if not root.is_dir():
        return []
    return sorted(d.name for d in root.iterdir() if d.is_dir() and not validate_seed(d))


def validate_seed(seed: Path) -> list[str]:
    """Return the problems that disqualify `seed` as a workspace template; empty list == valid.
    The 'passes checks' gate: point the seed at any folder, and it's accepted iff this is empty."""
    if not seed.exists() or not seed.is_dir():
        return [f"seed path is not a directory: {seed}"]
    return [f"missing required seed file: {rel}"
            for rel in REQUIRED_SEED_PATHS if not (seed / rel).is_file()]


def _root_commit(ws: Path, env: dict) -> "str | None":
    """The workspace's SEED commit (its first). Its tree is the pristine template as installed, which
    is what makes 'has the user touched this file?' answerable without storing a manifest."""
    r = subprocess.run(["git", "rev-list", "--max-parents=0", "HEAD"],
                       cwd=str(ws), capture_output=True, text=True, env=env)
    if r.returncode != 0:
        return None
    heads = r.stdout.split()
    return heads[-1] if heads else None


def _seeded_bytes(ws: Path, commit: str, rel: str, env: dict) -> "bytes | None":
    """The file's bytes AS SEEDED, or None when the seed commit never carried it."""
    r = subprocess.run(["git", "show", f"{commit}:{rel}"],
                       cwd=str(ws), capture_output=True, env=env)
    return r.stdout if r.returncode == 0 else None


def refresh_workspace_seed(ws: Path, seed_dir: "Path | None") -> list[str]:
    """Bring an EXISTING workspace's untouched seed files up to the current template. Returns the
    relative paths actually updated.

    Seeding is once-per-workspace, so a template change (new guidance, a new language) reaches only
    workspaces created after it — every existing workspace keeps whatever it was born with. That is
    the gap this closes.

    A workspace is the user's, not ours, so the rule is narrow: a file is refreshed ONLY when its
    current bytes are identical to the bytes the SEED COMMIT installed — proof that neither the user
    nor the agent has touched it. Anything edited since is left exactly as it is, and a path the seed
    commit never carried is the workspace's own file and is never overwritten. New template files that
    the workspace lacks entirely are added.
    """
    if not seed_dir or not seed_dir.exists() or not (ws / ".git").exists():
        return []
    env = scrubbed_git_env()
    commit = _root_commit(ws, env)
    if not commit:
        return []

    updated: list[str] = []
    for src in sorted(seed_dir.rglob("*")):
        if not src.is_file() or ".git" in src.parts:
            continue
        rel = src.relative_to(seed_dir).as_posix()
        dst = ws / rel
        want = src.read_bytes()
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(want)
            updated.append(rel)
            continue
        current = dst.read_bytes()
        if current == want:
            continue
        seeded = _seeded_bytes(ws, commit, rel, env)
        if seeded is None or seeded != current:
            continue  # the workspace owns this file now — never clobber it
        dst.write_bytes(want)
        updated.append(rel)

    if updated:
        subprocess.run(["git", "add", "-A"], cwd=str(ws), check=True, capture_output=True, text=True, env=env)
        subprocess.run(["git", "commit", "-q", "-m", "refresh untouched seed files"],
                       cwd=str(ws), check=True, capture_output=True, text=True, env=env)
    return updated


def seed_workspace(ws: Path, seed_dir: "Path | None") -> Path:
    """Initialize `ws` as a git repo seeded from `seed_dir` (the validated template). Copies the
    template tree, then `git init` + a seed commit so a governed turn has a HEAD to commit onto.

    An already-seeded workspace is not re-created; its UNTOUCHED seed files are refreshed to the
    current template (`refresh_workspace_seed`), so template changes reach existing workspaces while
    anything the user or agent has edited is preserved."""
    if (ws / ".git").exists():
        refresh_workspace_seed(ws, seed_dir)
        return ws
    ws.mkdir(parents=True, exist_ok=True)
    if seed_dir and seed_dir.exists():
        for item in seed_dir.iterdir():
            dst = ws / item.name
            if item.is_dir():
                shutil.copytree(item, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dst)
    # scrubbed_git_env: a hook-exported GIT_DIR would otherwise re-point init/add/commit at the
    # HOOK's repo (with `ws` as its work tree) and rewrite that repo's branch — see shared/gitenv.py.
    env = scrubbed_git_env()
    for args in (("init", "-q"), ("config", "user.email", "agent@vexa"), ("config", "user.name", "vexa-agent")):
        subprocess.run(["git", *args], cwd=str(ws), check=True, capture_output=True, text=True, env=env)
    subprocess.run(["git", "add", "-A"], cwd=str(ws), check=True, capture_output=True, text=True, env=env)
    subprocess.run(["git", "commit", "-q", "-m", "seed", "--allow-empty"], cwd=str(ws), check=True, capture_output=True, text=True, env=env)
    return ws
