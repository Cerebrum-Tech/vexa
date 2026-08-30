# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md above is the actor contract (intake, claiming, worktree rules, PR shape) and points at the
two constitutions: the **P-book** (`docs/docs/governance/architecture.mdx`, P1–P23) and the **D-book**
(`docs/docs/governance/delivery.mdx`). This file adds the mechanics: what to run, and how the tree fits
together.

## Commands

Toolchain: **pnpm 11.7** (`packageManager`), **Node ≥ 22.13**, **uv** for every Python package.
`pnpm install` at the root. On a machine with no GPU, `ONNXRUNTIME_NODE_INSTALL=skip pnpm install`
skips onnxruntime-node's CUDA download (what CI does).

```bash
pnpm gates                  # node scripts/gates.mjs all — THE bar; must be green before push
node scripts/gates.mjs <g>  # one gate: readme graph isolation exports schema dataflow python node …
pnpm build / pnpm test / pnpm lint / pnpm typecheck   # turbo; JS/TS workspace packages only
```

`.githooks/pre-push` runs a fast *static* subset (~14 gates, no build/pytest). CI (`.github/workflows/gates.yml`)
runs the full suite as three parallel jobs — `static` / `python` / `node` — joined by the single required
check named `gates`.

**Python** — 12 packages, each its own `pyproject.toml` + `tests/`, each with its own `uv.lock`
(`core/{agent,identity,runtime}`, `core/*/services/*`, `core/seam/meeting-status-ws`, `clients/slim`).
`pnpm gate:python` runs `uv run pytest -q` in every one. A single test:

```bash
cd core/agent && uv run pytest tests/test_worker.py -k spawn -q
```

**Node/TS modules** — no test framework: a `*.test.ts` is a standalone `tsx` script that self-asserts and
exits non-zero, and each package's `test` script is an *explicit chain of file paths* (see
`core/meetings/services/bot/package.json`). A new test does not run until it is appended to that chain.
A single file:

```bash
pnpm --filter @vexa/bot exec tsx src/pipeline.test.ts
```

**Terminal client** (`clients/terminal`, Next.js 15, vitest + jsdom, port 3000):

```bash
pnpm --filter @vexa/terminal dev
pnpm --filter @vexa/terminal exec vitest run src/surfaces/__tests__/meetingActions.test.tsx
```

Only `src/**/__tests__/**/*.test.ts(x)` is collected (`vitest.config.ts`).

**Running the stack** (from the repo root):

```bash
make all     # published images       make dev   # built from this checkout, :dev tags
make down    # stop                   make probe # full-journey smoke probe of a running install
make -C deploy/compose stack-test     # the gate:compose proof (owns its own up/down)
make -C deploy/compose logs | ps
```

`make dev` wants ~8 vCPU / 16 GB; `make all` only pulls. Live behaviour is proven against a running
stack — `pnpm gates` green is necessary, never sufficient (P19).

**The chart** — `architecture.calm.json` (FINOS CALM) is the single registry of every node, edge, carrier
and owner. Read the generated index first (`docs/views/architecture.dsl`, ~1.4k tokens), then slice:
`pnpm arch:viz cluster:meetings`, `path:tc-stream`, `flow:live-transcript-flow`.

## Architecture

`core/` is an organizing folder that owns no code and no contract; the bounded contexts are **one level
down**, and P1–P3 apply per domain:

| domain | what it owns |
|---|---|
| `core/runtime` | the kernel — spawns/executes workloads (process · docker · k8s). Depends on nothing above it. |
| `core/meetings` | capture — `services/{bot,meeting-api,mcp,transcription,desktop}` + `modules/*` (join, capture, pipelines, whisper, recording). Owns the raw transcript. |
| `core/agent` | execution — `services/agent-api` (control plane) + `worker/` (claude-in-container). Owns processed notes + the user workspace. |
| `core/identity` | `services/admin-api` — accounts, tokens, authz oracle, the durable DB. |
| `core/gateway` | the one public edge — auth, routing, WS fan-out. Everything client-facing goes through it. |

The live path, end to end: **bot** writes `segments-stream` → **meeting-api** collects into `tc-stream`
(+ postgres, + recording blobs in minio) → **agent-worker** tails `tc-stream` and writes `proc-stream` /
`out-stream` → **terminal** reads those through the **gateway**. Workload spawn is always
`meeting-api`/`agent-api` → `runtime` → an ephemeral container that boots from one env var, works, emits,
and dies (P7).

Language split is deliberate (P13): control planes and workers are **Python/FastAPI**; anything touching a
browser or the media pipeline is **TypeScript**; a language boundary is always also a service + contract
boundary. Bricks under `core/meetings/modules/` are consumed only through their package `index` (`gate:exports`),
never a deep path, and may import only their own code, another domain's `contracts/`, or `core/runtime/contracts`
(`gate:graph`, `gate:isolation` — and `gate:test-isolation` applies the same rule to Python tests).

**Contracts are sealed.** A `<domain>/contracts/<name>.vN/` directory with `*.schema.json` is hashed into
`contracts.seal.json`; the DB schema into `schema.seal.json`; the chart into `architecture.seal.json`. Changing
any of them turns a gate red until you deliberately re-seal — and the seal diff *is* the review surface:

```bash
pnpm seal:contracts   # after a reviewed contract change (lane:contract)
pnpm seal:schema      # after a reviewed DB model change
pnpm seal:arch        # after editing architecture.calm.json (required by P23 when a module or flow moves)
```

Everything is green-on-empty by design, so a gate that prints ✓ may simply have found nothing — check that
your new surface is actually discovered by it.

## Things that bite

- **One writer per data carrier (P23).** A reader never re-derives a producer's data. If you're reshaping a
  transcript in a consumer, the fix belongs upstream at the producer.
- **Config is a validated contract (P14).** App vars are `VEXA_*`; structured config is one JSON env var
  validated against a `*.v1` schema at boot; `*_TOKEN` / `*_SECRET` / `*_KEY` never reach logs or goldens.
- **`gate:readme` (P12)** — every non-ignored directory, at any depth, needs a non-empty `README.md`. Adding a
  directory without one turns the suite red.
- **Licensing is FINOS-gated (ADR-0004, P17)** — new deps must be Category A (MIT/BSD/Apache/ISC); weak-copyleft
  needs an entry in `license-exceptions.json`; GPL/AGPL and source-available (BSL/SSPL/Elastic) are forbidden.
- **`docs/docs` is the published law** (Mintlify) and moves with the change; per-PR changelog entries go in
  `docs/changelog.d/<pr>-<slug>.md`, never in `changelog.mdx`.
- **Git envs in hooks/tests.** Anything shelling out to git inherits `GIT_DIR` from a hook process and will
  operate on the wrong work tree; `core/agent/shared/gitenv.py` and `.githooks/pre-push` both scrub it.
