# Turkish Local Teams Reports

## Objective

Run a single Microsoft Teams meeting through Vexa on one RTX 4090, with both inference stages local
and GPU-backed. Vexa must transcribe Turkish speech and, when the meeting ends, turn the workspace's
meeting entity into one Turkish report containing a summary, explicit decisions, and
participant-attributed action items. No cloud inference or continuously updated summary is required.

This is a test deployment, but the source change must remain safe for every deployment: English stays
the default, Turkish is selected through the existing workspace-governed meeting configuration, and
the report remains idempotent at the existing meeting entity path.

## Existing Seams

The Teams bot already forwards the invocation's `language` value to the first-party transcription
service. The separate `deploy/transcription` unit already runs faster-whisper on CUDA and recommends
`large-v3-turbo` with `int8`, approximately 2.1 GB of VRAM.

The meeting agent already mirrors every cleaned, speaker-attributed note into
`kg/entities/meeting/<native-meeting-id>.md`. On `session_end`, `meeting_doc_turn` is allowed to read,
write, and edit that same file and commits the result. The defect is introduced in its prompt: it
requires a plain-English summary, does not require reading the existing transcript, and has no
evidence rules for decisions or action ownership. The fix belongs in this report producer. Neither
`transcript.v1` nor the meetings-to-agent data flow needs to change.

## Source Design

### Governed report language

Extend `MeetingConfig` with `report_language`, defaulting to `en`. Parse the value from the YAML
frontmatter in `agents/meeting.md` with tolerant per-key fallback, matching the existing config
behavior. Normalize supported values to `en` or `tr`; blank, malformed, and unsupported values fall
back to `en` with no model or vendor name entering the core configuration.

Document the key in both workspace seed variants. Existing workspaces and deployments therefore keep
their present English behavior. The local test workspace sets:

```yaml
enabled: false
write_meeting_doc: true
report_language: tr
model: gemma4:12b
```

`enabled: false` disables live LLM polishing/card beats but does not disable baseline processed notes
or the post-meeting document turn. This prevents Ollama from competing with transcription during the
meeting while preserving the event-driven report.

### Report prompt and evidence

Pass `report_language` from the loaded `MeetingConfig` into `meeting_doc_turn`. The turn must first
read the existing meeting Markdown file, which at that point contains the finalized
speaker-attributed transcript. It then preserves the exact YAML frontmatter and replaces only the
body. Re-running the turn updates the same path and never creates a duplicate.

For `tr`, the body has exactly these sections:

```markdown
## Özet

## Alınan Kararlar

## Aksiyon Maddeleri
```

The summary is concise Turkish prose grounded only in the file. A decision is included only when the
transcript records agreement, approval, rejection, or another explicit commitment. An action item
contains the task and the participant's displayed name when ownership is explicit. Unassigned work is
written as `Sorumlu belirtilmedi`; the model must not infer an owner from topic, role, or speaking
order. Explicit dates are preserved, but missing deadlines are not invented. Empty decision/action
sections contain a short Turkish statement that none was recorded.

Surfaced entity cards may supplement attendee/company/topic links, but they are not evidence for a
decision or action. The raw transcript remains available in the durable transcript/envelope stores;
the meeting Markdown body becomes the post-meeting report, matching the existing design.

### Failure behavior

If the meeting has no finalized notes, skip the report turn and preserve the meeting file. If Ollama
is unavailable, returns an authentication/model error, exceeds context, or the harness fails, emit the
existing typed model/auth error event and leave the last committed transcript/report intact. A retry
uses the same path and prompt, so it converges rather than duplicating content. No cloud endpoint or
fallback model is permitted.

## Local GPU Deployment

Run one transcription worker from `deploy/transcription` with:

```dotenv
MODEL_SIZE=large-v3-turbo
COMPUTE_TYPE=int8
```

Every Teams bot request includes `"language":"tr"`. For this machine, bind the transcription load
balancer to the Docker bridge gateway (`172.17.0.1`) rather than a LAN/VPN address. The main Compose
stack and its spawned meeting/agent workers can reach that host-side bridge address, while no STT
port is published on `10.15.0.117`, `10.8.0.19`, or `0.0.0.0`.

Keep the system Ollama unit inactive during the test. Run the installed Ollama binary as a bounded
session on the RTX 4090, binding only to the Docker bridge gateway at `172.17.0.1:11434`. Do not bind
Ollama to `0.0.0.0`, the Ethernet address, or the VPN address. This makes it reachable by Vexa's
Docker workloads without accepting LAN/VPN clients. Configure:

```text
OLLAMA_CONTEXT_LENGTH=32768
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_KEEP_ALIVE=5m
```

Pull only `gemma4:12b` (never a `:cloud` tag). The main stack uses Ollama's OpenAI-compatible endpoint
for completion configuration and its Anthropic-compatible endpoint for the existing Claude Code
harness. `VEXA_AGENT_MODEL`, `VEXA_MEETING_MODEL`, `VEXA_LLM_MODEL`, and the operator allowlist all pin
`gemma4:12b`. Local dummy tokens satisfy client configuration but provide no remote credential.

The GPU acceptance ceiling is 20 GiB total measured use, leaving approximately 4 GiB for the desktop
and transient allocations. `OLLAMA_MAX_LOADED_MODELS=1` and `OLLAMA_NUM_PARALLEL=1` prevent hidden
multiplication of model/context allocations. `q8_0` halves KV-cache memory relative to `f16` with
Flash Attention enabled. If the model exceeds the ceiling or `ollama ps` reports CPU offload, reduce
the context for the short test before selecting a smaller Gemma 4 variant.

Before model use, verify `ss` reports only `172.17.0.1:11434` and that requests to both host-facing
addresses on port 11434 fail. Repeat the check after the Vexa stack starts. This is a test-time
network boundary, not a substitute for production firewall policy.

## Verification

Follow the repository's Expected → Actual → Verdict loop for each observation:

1. Parser tests prove `report_language: tr`, English fallback, and malformed/unsupported fallback.
2. Prompt tests prove the exact Turkish headings, read-before-write instruction, evidence-only
   decisions, explicit owner handling, and `Sorumlu belirtilmedi` fallback.
3. Offline session-end tests use deterministic harness fakes to prove one report at the exact meeting
   path, preserved frontmatter, no duplicate on retry, no report without notes, and transcript
   preservation on model failure.
4. A Turkish audio fixture sent directly to the local STT endpoint returns Turkish text and language
   `tr`; the negative control omits/changes language and proves the request pin is meaningful.
5. An Ollama probe summarizes a Turkish transcript into the required headings. `ollama ps` reports
   `100% GPU` and `nvidia-smi` remains below 20 GiB at peak.
6. One short live Teams meeting includes named participants, one explicit decision, one assigned
   action, and one unassigned action. After `session_end`, inspect the committed workspace report and
   verify Turkish output and attribution row by row.
7. Run the focused agent suite and `node scripts/gates.mjs all`. Record that multi-meeting concurrency,
   long-meeting context limits, and production network hardening were not checked.

## Documentation and Architecture

Update the configuration reference and post-meeting report guide with `report_language`, Turkish
output behavior, and the local Ollama endpoint pair. Add a per-PR file under `docs/changelog.d/`; do
not edit the changelog hot file directly.

No module, owner, carrier, or data-flow edge changes. `architecture.calm.json` therefore remains
unchanged. If implementation reveals a new service or flow is required, stop and revise this design
before editing the architecture seal.

## Non-goals

- Live or continuously refreshed summaries.
- Multiple simultaneous meetings or multiple Ollama models.
- Translation of non-Turkish meetings into Turkish.
- A generic external summarization service.
- Cloud inference fallback.
- Production firewall, TLS, or multi-host deployment design.
