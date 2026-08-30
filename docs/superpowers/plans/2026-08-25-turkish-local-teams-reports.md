# Turkish Local Teams Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one automatic, evidence-grounded Turkish report after a locally transcribed Teams meeting, with both Whisper and Gemma 4 running on the RTX 4090.

**Architecture:** Keep the existing Teams → first-party STT → processed-notes → session-end document flow. Add a workspace-governed `report_language` setting and a Turkish variant of the existing post-meeting harness prompt; preserve English defaults and contracts. For this test, disable live LLM beats so Ollama loads only for the session-end report.

**Tech Stack:** Python 3.13, pytest, Claude Code harness, Ollama 0.32, Gemma 4 12B, faster-whisper, Docker Compose, Redis streams, Markdown workspaces.

**Spec:** `docs/superpowers/specs/2026-08-25-turkish-local-teams-reports-design.md`

## Global Constraints

- Keep every repository change uncommitted: contributor-rights status is `Unsure`, and the user authorized local-only work.
- Do not create an issue, pull request, branch rewrite, push, DCO trailer, or external message.
- Preserve `report_language: en` as the code and seed default; configure only the local test workspace as `tr`.
- Use only `gemma4:12b`, never a `:cloud` model or cloud fallback.
- Keep the system Ollama unit inactive and bind the test server only to `172.17.0.1:11434`; never
  bind it to `0.0.0.0`, `10.15.0.117`, or `10.8.0.19`.
- Pin Teams transcription requests to `language: "tr"`.
- Keep one transcription worker, one loaded Ollama model, and one parallel Ollama request.
- Treat 20 GiB as the measured total-GPU-use ceiling.
- Do not change `architecture.calm.json` unless implementation reveals a real module, carrier, owner, or data-flow change; stop for design review if that happens.
- Replace each normal commit step with `git diff --check`, focused tests, and `git status --short`.

---

### Task 1: Add governed report-language configuration

**Files:**
- Modify: `core/agent/shared/agent_config.py`
- Modify: `core/agent/tests/test_agent_config.py`
- Modify: `core/agent/workspace-seeds/default/agents/meeting.md`
- Modify: `core/agent/workspace-seeds/finos/agents/meeting.md`

**Interfaces:**
- Produces: `MeetingConfig.report_language: str`, normalized to `"en"` or `"tr"`.
- Produces: `DEFAULT_REPORT_LANGUAGE = "en"` and `_as_report_language(value: object) -> str`.
- Consumes: existing tolerant frontmatter parsing in `load_meeting_config(work: Path)`.

- [ ] **Step 1: Write failing parser tests**

Add these cases to `test_agent_config.py`:

```python
def test_report_language_defaults_to_english(tmp_path):
    assert load_meeting_config(tmp_path).report_language == "en"


def test_report_language_accepts_turkish(tmp_path):
    _write(tmp_path, "---\nreport_language: tr\n---\n")
    assert load_meeting_config(tmp_path).report_language == "tr"


def test_report_language_rejects_blank_and_unsupported_values(tmp_path):
    _write(tmp_path, "---\nreport_language: de\n---\n")
    assert load_meeting_config(tmp_path).report_language == "en"
    _write(tmp_path, "---\nreport_language: '   '\n---\n")
    assert load_meeting_config(tmp_path).report_language == "en"
```

- [ ] **Step 2: Prove the tests are red**

Run:

```bash
uv run --project core/agent pytest core/agent/tests/test_agent_config.py -q
```

Expected: the three new tests fail because `MeetingConfig` has no `report_language` field.

- [ ] **Step 3: Implement the minimal parser**

Add the following structure in `agent_config.py` and pass the parsed value from `load_meeting_config`:

```python
DEFAULT_REPORT_LANGUAGE = "en"
SUPPORTED_REPORT_LANGUAGES = frozenset({"en", "tr"})


def _as_report_language(value: object) -> str:
    if isinstance(value, str):
        language = value.strip().lower()
        if language in SUPPORTED_REPORT_LANGUAGES:
            return language
    return DEFAULT_REPORT_LANGUAGE


@dataclass(frozen=True)
class MeetingConfig:
    # existing fields remain unchanged
    report_language: str = DEFAULT_REPORT_LANGUAGE
```

- [ ] **Step 4: Document the seed key without changing defaults**

Add `report_language: en` immediately after `write_meeting_doc: true` in both seed `meeting.md` files, with a comment that supported values are `en | tr`.

- [ ] **Step 5: Prove Task 1 green and checkpoint the diff**

Run:

```bash
uv run --project core/agent pytest core/agent/tests/test_agent_config.py -q
git diff --check
git status --short
```

Expected: parser tests pass; only the four Task 1 files plus the local spec/plan are changed.

---

### Task 2: Localize the post-meeting report prompt at the producer

**Files:**
- Modify: `core/agent/worker/meeting.py`
- Modify: `core/agent/tests/test_meeting_postprocess_offline.py`
- Modify: `core/agent/tests/test_worker.py`

**Interfaces:**
- Produces: `meeting_doc_turn(..., report_language: str = "en") -> Iterator[dict]`.
- Produces: `build_meeting_doc_prompt(..., report_language: str = "en") -> str` for isolated tests.
- Consumes: the existing meeting file at `kg/entities/meeting/<native>.md` and surfaced `cards`.

- [ ] **Step 1: Add a failing Turkish prompt test**

Capture the harness prompt in `test_worker.py` and call `meeting_doc_turn(..., report_language="tr")`.
Assert all of the following:

```python
assert "Read the existing file first" in seen_prompt["prompt"]
assert "## Özet" in seen_prompt["prompt"]
assert "## Alınan Kararlar" in seen_prompt["prompt"]
assert "## Aksiyon Maddeleri" in seen_prompt["prompt"]
assert "Sorumlu belirtilmedi" in seen_prompt["prompt"]
assert "do not infer" in seen_prompt["prompt"].lower()
assert "preserve the exact YAML frontmatter" in seen_prompt["prompt"]
```

- [ ] **Step 2: Add a failing English regression test**

Call `build_meeting_doc_prompt` without `report_language` and assert the current English requirements remain:

```python
assert "plain-English SUMMARY" in prompt
assert "## Attendees" in prompt
assert "## Decisions" in prompt
assert "## Actions" in prompt
```

- [ ] **Step 3: Add a report-failure preservation test**

Seed `kg/entities/meeting/teams-test.md` with frontmatter and a speaker-attributed Turkish
transcript. Reuse the existing fake-harness seam, but return a terminal `done` event with
`ok: false` and no file write. Assert the file bytes are unchanged and the worker emits the
failure event instead of deleting or replacing the transcript.

- [ ] **Step 4: Prove the new tests are red**

Run:

```bash
uv run --project core/agent pytest \
  core/agent/tests/test_worker.py::test_turkish_meeting_doc_prompt_is_evidence_grounded \
  core/agent/tests/test_worker.py::test_english_meeting_doc_prompt_remains_default \
  core/agent/tests/test_worker.py::test_meeting_doc_failure_preserves_existing_transcript -q
```

Expected: failures report the missing builder/signature and Turkish headings.

- [ ] **Step 5: Implement two code-owned prompt variants**

Keep the existing English prompt text unchanged. Add a Turkish report template that instructs the harness to:

```text
Read the existing file first and use its speaker-attributed transcript as the only evidence.
Preserve the exact YAML frontmatter.
Replace only the Markdown body and write every narrative sentence in Turkish.
Use exactly ## Özet, ## Alınan Kararlar, and ## Aksiyon Maddeleri.
Record only explicit decisions. For each action, preserve the explicit participant owner;
write Sorumlu belirtilmedi when none is assigned, and do not infer an owner or deadline.
Write/edit only kg/entities/meeting/{native}.md.
```

Select the template with normalized `report_language`, format the existing frontmatter facts and `cards`, and have `meeting_doc_turn` call the builder.

- [ ] **Step 6: Make the offline fake author a Turkish report**

Extend `test_offline_meeting_doc_turn_authors_entity_from_fixed_cards` with an existing Turkish transcript file and a deterministic fake harness result containing:

```markdown
## Özet
Ekip, yerel çıkarım kurulumunu değerlendirdi.

## Alınan Kararlar
- Özetleme için Gemma 4 kullanılmasına karar verildi.

## Aksiyon Maddeleri
- Ayşe modeli indirecek. Sorumlu: Ayşe
- VRAM ölçümü yapılacak. Sorumlu belirtilmedi
```

Assert the frontmatter remains, the three headings exist, both ownership forms exist, and only one meeting Markdown file exists after two runs.

- [ ] **Step 7: Prove Task 2 green and checkpoint the diff**

Run:

```bash
uv run --project core/agent pytest \
  core/agent/tests/test_meeting_postprocess_offline.py \
  core/agent/tests/test_worker.py -q
git diff --check
git status --short
```

Expected: all post-processing and worker tests pass; no contract or architecture file changes.

---

### Task 3: Wire the locale into session-end execution and skip empty reports

**Files:**
- Modify: `core/agent/worker/engine.py`
- Modify: `core/agent/worker/meeting.py`
- Modify: `core/agent/tests/test_worker.py`

**Interfaces:**
- Consumes: `MeetingConfig.report_language` from Task 1.
- Consumes: `meeting_doc_turn(..., report_language=...)` from Task 2.
- Preserves: `doc_turn(cards)` callback shape and the existing `meeting-doc` event id.

- [ ] **Step 1: Add failing wiring tests**

Patch `meeting_doc_turn` in the worker-main test, load `agents/meeting.md` with `report_language: tr`, and assert the captured call receives `report_language == "tr"`.

Add an empty-meeting test:

```python
def test_serve_meeting_skips_doc_when_no_notes_exist():
    doc_ran = []
    s = MeetingStream(inbox=[
        ("1-0", {"payload": json.dumps({"type": "session_end"})}),
    ])
    serve_meeting(
        s, transcript_stream="tc:m1", out_topic="o", card_turn=_card_turn,
        idle_ms=10, doc_turn=lambda cards: doc_ran.append(cards) or iter(()),
    )
    assert doc_ran == []
```

- [ ] **Step 2: Prove the tests are red**

Run the two new test node ids with `uv run --project core/agent pytest ... -q`.

Expected: locale is not forwarded and the empty session currently invokes `doc_turn`.

- [ ] **Step 3: Implement the minimal wiring**

In `engine.main`, pass `report_language=cfg.report_language` into `meeting_doc_turn`. In the `session_end` branch, change the document condition to:

```python
if doc_turn is not None and notes:
    _emit_turn(stream, out_topic, lambda: doc_turn(cards), "meeting-doc")
```

Do not gate baseline notes, `view_end`, envelope persistence, or live cards.

- [ ] **Step 4: Prove Task 3 green and run the focused agent suite**

Run:

```bash
uv run --project core/agent pytest \
  core/agent/tests/test_agent_config.py \
  core/agent/tests/test_meeting_postprocess_offline.py \
  core/agent/tests/test_worker.py -q
git diff --check
```

Expected: all focused tests pass, including `enabled=false` still writing a document when transcript notes exist.

---

### Task 4: Update user-facing configuration and report documentation

**Files:**
- Modify: `docs/docs/configuration.mdx`
- Modify: `docs/docs/how-to/post-meeting-report.mdx`
- Create: `docs/changelog.d/0000-turkish-local-reports.md`

**Interfaces:**
- Documents: `report_language: en | tr` in `agents/meeting.md`.
- Documents: Ollama endpoint split—`http://<docker-bridge-gateway>:11434/v1` for OpenAI-compatible
  completions and `http://<docker-bridge-gateway>:11434` for the Anthropic-compatible harness.

- [ ] **Step 1: Add the configuration entry**

Explain that `report_language` is workspace-governed, defaults to English, and Turkish produces the exact three headings. State that setting `enabled: false` with `write_meeting_doc: true` disables live model beats while retaining the session-end report.

- [ ] **Step 2: Add the local Ollama example**

Use these exact model/provider values in the documentation:

```dotenv
VEXA_LLM_PROVIDER=openai-compat
VEXA_LLM_BASE_URL=http://docker-bridge-gateway:11434/v1
VEXA_LLM_API_KEY=ollama
VEXA_LLM_MODEL=gemma4:12b
ANTHROPIC_BASE_URL=http://docker-bridge-gateway:11434
ANTHROPIC_AUTH_TOKEN=ollama
VEXA_AGENT_MODEL=gemma4:12b
VEXA_MEETING_MODEL=gemma4:12b
VEXA_MODEL_ALLOWLIST=gemma4:12b
```

- [ ] **Step 3: Add the local-only changelog fragment**

Write one factual bullet: Turkish post-meeting reports are selected from `agents/meeting.md`, preserve English defaults, and ground decisions/action owners in the meeting transcript. Do not claim live Teams validation until Task 7 passes.

- [ ] **Step 4: Run documentation checks**

Run:

```bash
node scripts/docs-current-gate.mjs
git diff --check
git status --short
```

Expected: docs-current passes and `docs/docs/changelog.mdx` remains untouched.

---

### Task 5: Run source verification before GPU packaging

**Files:**
- No new files.

**Interfaces:**
- Consumes: completed source and docs changes from Tasks 1–4.
- Produces: raw baseline evidence before any image build.

- [ ] **Step 1: Run the entire agent suite**

```bash
uv run --project core/agent pytest core/agent/tests -q
```

Expected: zero failures.

- [ ] **Step 2: Run repository static checks**

```bash
npx --yes pnpm@11.7.0 typecheck
npx --yes pnpm@11.7.0 lint
```

Expected: both commands exit zero.

- [ ] **Step 3: Run the full gate suite**

```bash
node scripts/gates.mjs all
```

Expected: every gate passes. If any result is unexpected, stop and interpret it before GPU setup.

- [ ] **Step 4: Record the local-only checkpoint**

```bash
git diff --check
git status --short
```

Expected: all intended changes remain uncommitted on `feat/turkish-post-meeting-reports`.

---

### Task 6: Start and prove the two local GPU inference services

**Files:**
- Create locally ignored: `deploy/transcription/.env`
- No committed source files.

**Interfaces:**
- Produces: STT at `http://172.17.0.1:8083/v1/audio/transcriptions`.
- Produces: Ollama OpenAI API at `http://172.17.0.1:11434/v1` and Anthropic API at
  `http://172.17.0.1:11434`.
- Rejects: Ollama access through the host Ethernet and VPN addresses.

- [ ] **Step 1: Verify the Docker-only bind address and start bounded Ollama**

```bash
test "$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')" = 172.17.0.1
test "$(systemctl is-active ollama 2>/dev/null || true)" != active
env \
  OLLAMA_HOST=172.17.0.1:11434 \
  OLLAMA_CONTEXT_LENGTH=32768 \
  OLLAMA_MAX_LOADED_MODELS=1 \
  OLLAMA_NUM_PARALLEL=1 \
  OLLAMA_FLASH_ATTENTION=1 \
  OLLAMA_KV_CACHE_TYPE=q8_0 \
  OLLAMA_KEEP_ALIVE=5m \
  CUDA_VISIBLE_DEVICES=0 \
  ollama serve
```

Expected: server listens on port 11434 and detects the RTX 4090.

In a second shell, prove the listener and negative controls before continuing:

```bash
ss -ltn '( sport = :11434 )'
! curl -sf --connect-timeout 2 http://10.15.0.117:11434/api/tags
! curl -sf --connect-timeout 2 http://10.8.0.19:11434/api/tags
```

Expected: `ss` shows only `172.17.0.1:11434`; both host-facing probes fail.

- [ ] **Step 2: Pull and probe only the local Gemma model**

```bash
OLLAMA_HOST=http://172.17.0.1:11434 ollama pull gemma4:12b
curl -sf http://172.17.0.1:11434/api/chat -d '{
  "model":"gemma4:12b",
  "stream":false,
  "messages":[{"role":"user","content":"Yalnızca Türkçe cevap ver: Yerel toplantı özeti hazır."}]
}' | jq -e '.message.content | length > 0'
OLLAMA_HOST=http://172.17.0.1:11434 ollama ps
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits
```

Expected: response is Turkish, `ollama ps` reports `100% GPU`, and measured use is below 20,480 MiB.

- [ ] **Step 3: Configure and start one faster-whisper worker**

Seed `deploy/transcription/.env` from `.env.example`, then set exactly:

```dotenv
TRANSCRIPTION_LB_PORT=172.17.0.1:8083
MODEL_SIZE=large-v3-turbo
COMPUTE_TYPE=int8
IMAGE_TAG=dev
API_TOKEN=vexa-local-stt-20260825
```

Run:

```bash
docker compose -f deploy/transcription/docker-compose.yml up -d --build
curl -sf http://172.17.0.1:8083/health | jq .
```

Expected: health reports CUDA, `large-v3-turbo`, and `int8`.

- [ ] **Step 4: Record and transcribe a Turkish microphone fixture**

Speak this sentence during the eight-second capture: `Bugün yerel toplantı özetini test ediyoruz.`

```bash
timeout 8 parec --format=s16le --rate=16000 --channels=1 | \
  ffmpeg -hide_banner -loglevel error -f s16le -ar 16000 -ac 1 -i - /tmp/vexa-turkish.wav
curl -sf http://172.17.0.1:8083/v1/audio/transcriptions \
  -H 'Authorization: Bearer vexa-local-stt-20260825' \
  -F file=@/tmp/vexa-turkish.wav -F model=whisper-1 -F language=tr | tee /tmp/vexa-turkish.json
jq -e '.language == "tr" and (.text | length > 0)' /tmp/vexa-turkish.json
```

Expected: non-empty Turkish text with language `tr`.

- [ ] **Step 5: Measure co-resident VRAM**

Keep Whisper healthy, run one Gemma response, then query `nvidia-smi` again.

Expected: both services use GPU, Ollama remains fully offloaded, and total use stays below 20,480 MiB.

---

### Task 7: Build Vexa locally and witness a Teams report

**Files:**
- Create locally ignored: `deploy/compose/.env`
- Modify through Vexa workspace governance: `agents/meeting.md` in the local `u_live` workspace.

**Interfaces:**
- Consumes: local STT and Ollama endpoints from Task 6.
- Produces: one Turkish report at `kg/entities/meeting/<teams-id>.md`.

- [ ] **Step 1: Configure the local Compose stack**

Seed `deploy/compose/.env` from `.env.example`, then set these exact values:

```dotenv
IMAGE_TAG=dev
BROWSER_IMAGE=vexaai/vexa-bot:v012
TRANSCRIPTION_SERVICE_URL=http://172.17.0.1:8083
TRANSCRIPTION_SERVICE_TOKEN=vexa-local-stt-20260825
TRANSCRIPTION_MODEL=
TRANSCRIBE_ENABLED=true
VEXA_LLM_PROVIDER=openai-compat
VEXA_LLM_BASE_URL=http://172.17.0.1:11434/v1
VEXA_LLM_API_KEY=ollama
VEXA_LLM_MODEL=gemma4:12b
VEXA_MODEL_ALLOWLIST=gemma4:12b
VEXA_RUNNER=claude-code
ANTHROPIC_API_KEY=
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_BASE_URL=http://172.17.0.1:11434
ANTHROPIC_MODEL=gemma4:12b
VEXA_AGENT_MODEL=gemma4:12b
VEXA_MEETING_MODEL=gemma4:12b
```

- [ ] **Step 2: Build and start from this worktree**

```bash
make dev
docker compose -p vexa-v012 -f deploy/compose/docker-compose.yml ps
```

Expected: all long-running services are healthy and the locally built agent-worker image exists.

- [ ] **Step 3: Prove both model endpoints from inside the stack**

```bash
docker compose -p vexa-v012 -f deploy/compose/docker-compose.yml exec -T agent-api \
  python -c "import urllib.request; print(urllib.request.urlopen('http://172.17.0.1:11434/api/tags').status)"
docker compose -p vexa-v012 -f deploy/compose/docker-compose.yml exec -T runtime \
  python -c "import urllib.request; print(urllib.request.urlopen('http://172.17.0.1:8083/health').status)"
```

Expected: both print `200`.

- [ ] **Step 4: Mint a local API key and configure the governed meeting agent**

```bash
VEXA_TEST_API_KEY=$(make -s -C deploy/compose provision-token \
  ADMIN_TOKEN=changeme EMAIL=turkish-test@vexa.local SCOPES=bot,tx)
curl -N -X POST http://127.0.0.1:18056/agent/chat \
  -H "X-API-Key: $VEXA_TEST_API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"Edit agents/meeting.md YAML frontmatter only: set enabled to false, write_meeting_doc to true, report_language to tr, and model to gemma4:12b. Preserve all other fields and text."}'
curl -sf -H "X-API-Key: $VEXA_TEST_API_KEY" \
  'http://127.0.0.1:18056/agent/workspace/file?path=agents%2Fmeeting.md' | \
  jq -e '.content | contains("report_language: tr") and contains("enabled: false")'
```

Expected: the governed file contains the Turkish report settings.

- [ ] **Step 5: Start one short Teams meeting through the authenticated API**

Obtain the disposable Teams test URL from the user at execution time and keep it in the current
shell as `VEXA_TEAMS_URL`; do not print the URL because it can contain an admission passcode. Send
the bot with Turkish transcription explicitly selected:

```bash
curl -sf -X POST http://127.0.0.1:18056/bots \
  -H "X-API-Key: $VEXA_TEST_API_KEY" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg meeting_url "$VEXA_TEAMS_URL" \
    '{meeting_url:$meeting_url, language:"tr", bot_name:"Vexa Turkish Test"}')" | jq -e .
```

Expected: `POST /bots` returns `201`. Admit `Vexa Turkish Test` from the Teams lobby, then use
`http://127.0.0.1:13000` to observe the meeting lifecycle and transcript.

Use this witnessed script with named participants:

```text
Ayşe: Özetleme modeli olarak Gemma 4 kullanmaya karar verdik.
Mehmet: Model indirme işini ben yarın tamamlayacağım.
Ayşe: Toplantıdan sonra VRAM ölçümü de yapılmalı, ancak henüz sorumlu belirlemedik.
```

End the meeting normally after the transcript displays all three statements.

- [ ] **Step 6: Inspect the report and GPU evidence**

Use the workspace tree endpoint to locate `kg/entities/meeting/<teams-id>.md`, then fetch it and assert:

```text
## Özet
## Alınan Kararlar
Gemma 4
## Aksiyon Maddeleri
Mehmet
Sorumlu belirtilmedi
```

Run:

```bash
OLLAMA_HOST=http://172.17.0.1:11434 ollama ps
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits
ss -ltn '( sport = :11434 )'
! curl -sf --connect-timeout 2 http://10.15.0.117:11434/api/tags
! curl -sf --connect-timeout 2 http://10.8.0.19:11434/api/tags
docker compose -p vexa-v012 -f deploy/compose/docker-compose.yml logs --since=20m \
  runtime agent-api meeting-api | rg -i 'error|auth|model|session_end|meeting-doc'
```

Expected: report evidence matches the spoken script, Ollama reports 100% GPU, total use stays below 20,480 MiB, and logs contain no model/auth failure.

- [ ] **Step 7: Record the final local-only verdict**

Report raw commands, output counts, report excerpts, and measured VRAM. Explicitly record that multiple meetings, long-meeting context limits, production network hardening, and non-Turkish report locales were not checked.

Run:

```bash
git diff --check
git status --short
```

Expected: all work remains uncommitted in `/home/alp/git/vexa-turkish-reports`.
