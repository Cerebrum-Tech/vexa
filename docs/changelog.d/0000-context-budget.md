- **Every prompt the meeting worker sends is held to a context budget (#0000).** A meeting has no
  maximum length and a model's context window does; left unbounded the two met at the worst possible
  moment — the post-meeting report, on the longest meeting — and an overflow is not a degraded report,
  it is no report at all. `VEXA_LLM_CONTEXT_TOKENS` (default 8000) is now enforced rather than hoped
  for. The live card beat trims its transcript window to fit, keeping the newest lines and saying that
  it trimmed. The **report** is the real change: when the transcript does not fit it is summarized in
  chunks that do and the report is written from those digests — every part of the meeting represented,
  at one extra model call per chunk, instead of the end of the meeting (where the decisions usually
  are) being silently dropped. A meeting that already fits skips all of it and the raw transcript goes
  in verbatim, which is always the better evidence when it is affordable; a digest call that fails
  falls back to its own chunk's transcript, so a lost call costs detail and never a stretch of the
  meeting. The report turn is now **self-contained**: it carries its evidence and its exact
  frontmatter in the prompt and runs `Write`-only, because the previous shape told the model to go
  read the transcript file itself — and a file read is context we can neither see nor cap, which is
  precisely what made the budget unenforceable before.
- **`VEXA_LLM_MAX_TOKENS` reaches the provider it was set for (#0000).** The key was declared and set,
  but only the Anthropic adapter ever sent it; on any `openai-compat` backend — the default, and what
  every local-model deployment runs — the configured reply cap was inert. It is now sent on every
  request, and both it and the context budget are stamped into each worker dispatch (a key the
  dispatch never forwards is a key the worker never sees).
