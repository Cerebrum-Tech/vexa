# Innova Turkish Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an Innova-branded, Turkish meetings UI with a Turkish default recap and the bot name `Innova Toplantı Asistanı`.

**Architecture:** Reuse the existing Terminal assets, default-name seam, and server-owned meeting steering. Keep network contracts and Teams camera behavior unchanged; localization is deployment-focused UI copy rather than a new locale framework.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest, Python, pytest, Docker Compose, SVG.

**Spec:** `docs/superpowers/specs/2026-08-25-innova-turkish-terminal-design.md`

## Global Constraints

- Keep changes uncommitted because contribution-rights status is `Unsure`.
- Use the exact name `Innova Toplantı Asistanı`.
- Vendor the official Innova SVG; do not fetch it at runtime.
- Do not enable a camera, virtual camera, or unsupported avatar act.
- Do not change API enum values, route paths, storage keys, or architecture carriers.

---

### Task 1: Brand assets and bot-name defaults

**Files:**
- Create: `clients/terminal/public/innova-logo.svg`
- Create: `clients/terminal/public/innova-icon.svg`
- Modify: `clients/terminal/src/app/icon.svg`
- Modify: `clients/terminal/src/app/layout.tsx`
- Modify: `clients/terminal/src/workbench/Workbench.tsx`
- Modify: `clients/terminal/src/app/AuthGate.tsx`
- Modify: `clients/terminal/src/surfaces/defaultBotName.ts`
- Modify: `clients/terminal/src/surfaces/__tests__/defaultBotName.test.ts`
- Modify: `deploy/compose/docker-compose.yml`
- Modify: `deploy/compose/.env.example`

**Interfaces:**
- Produces: `defaultBotName(): string` with explicit env precedence and Innova fallback.
- Produces: local `/innova-logo.svg` and `/innova-icon.svg` assets.

- [ ] Write a failing test expecting the exact Innova fallback and trimmed env override.
- [ ] Run `pnpm --filter @vexa/terminal test -- defaultBotName.test.ts` and observe the old `Vexa` fallback.
- [ ] Add the official assets and replace every code-controlled Vexa logo reference and metadata string.
- [ ] Thread `DEFAULT_BOT_NAME` into `NEXT_PUBLIC_DEFAULT_BOT_NAME` at Terminal build time and set Compose defaults.
- [ ] Re-run the focused test and `rg -n 'vexa-logo|alt="Vexa"' clients/terminal/src clients/terminal/public` expecting no matches.

### Task 2: Turkish interactive recap

**Files:**
- Modify: `core/agent/control_plane/meeting_steering.py`
- Modify: `core/agent/tests/test_meeting_steering.py`

**Interfaces:**
- Produces: post-phase steering that mandates Turkish recap output.

- [ ] Add a failing test asserting the rendered post preamble requires Turkish and named action owners.
- [ ] Run `uv run --project core/agent pytest core/agent/tests/test_meeting_steering.py -q` and observe failure.
- [ ] Add the minimum Turkish-output instruction to the post template at the producer seam.
- [ ] Re-run the focused suite and confirm green.

### Task 3: Turkish meetings-mode UI

**Files:**
- Modify: `clients/terminal/src/app/layout.tsx`
- Modify: `clients/terminal/src/app/AuthGate.tsx`
- Modify: `clients/terminal/src/app/SetupGate.tsx`
- Modify: `clients/terminal/src/workbench/Workbench.tsx`
- Modify: `clients/terminal/src/surfaces/today.tsx`
- Modify: `clients/terminal/src/surfaces/meeting.tsx`
- Modify: `clients/terminal/src/surfaces/chat.tsx`
- Modify: `clients/terminal/src/surfaces/settings.tsx`
- Test: `clients/terminal/src/surfaces/__tests__/turkishMeetingsUi.test.ts`

**Interfaces:**
- Produces: Turkish user-visible meetings workflow while preserving internal values.

- [ ] Add a source-boundary test for key Turkish labels, `lang="tr"`, and the absence of key English labels.
- [ ] Run the focused Vitest file and observe failure against current English copy.
- [ ] Translate the listed user-facing strings without changing API values or identifiers.
- [ ] Re-run the focused test and the complete Terminal test suite.

### Task 4: Build and local witness

**Files:**
- Modify: `docs/changelog.d/0000-innova-turkish-terminal.md`

**Interfaces:**
- Consumes: Tasks 1-3.

- [ ] Run `git diff --check`, focused Python tests, Terminal tests, and `pnpm --filter @vexa/terminal build`.
- [ ] Rebuild/recreate only the Terminal service and inspect the local meetings path.
- [ ] Verify `ss` shows no Ollama listener on `0.0.0.0` or LAN addresses.
- [ ] Record the user-visible change in a changelog fragment and leave the tree uncommitted.
