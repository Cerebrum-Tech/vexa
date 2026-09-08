# agent · worker

The agent worker: runs a single agent workload to completion. Owns the generic turn engine
(`engine`), the per-meeting loop (`meeting`, `meeting_transcript_mcp`), and its container image
(`Dockerfile`). Model/harness access goes through the provider-agnostic [`llm`](../llm) ports —
card beats via `CompletionPort` (a direct HTTP completion), workspace turns via `HarnessPort` (the
`VEXA_RUNNER`-selected CLI agent); no vendor name lives in this package. Spawned by the control
plane; liveness = workload lifecycle.

`budget` is the context budget every prompt this worker sends is held to
(`VEXA_LLM_CONTEXT_TOKENS`, default 8000). A meeting has no maximum length and a model's window
does, so the live card beat trims its transcript window to fit and the post-meeting report — when
the transcript does not fit — is written from digests of chunks that do (map → reduce in
`meeting.summarize_notes`). The report turn carries its evidence and frontmatter in the prompt and
runs `Write`-only: a file read is context that can be neither measured nor capped, which is what
made the budget unenforceable when the prompt told the model to open the transcript itself.
