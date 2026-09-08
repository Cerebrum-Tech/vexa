- **The recap panel stops calling a slow report a failed one (#0000).** It polled for 45 × 2 s = 90
  seconds and then said *"Toplantı özeti oluşturulamadı."* — but the report is authored by a model
  turn that summarizes a long meeting in chunks and then writes from those digests, which is minutes
  of GPU on a 77-minute recording. So the panel declared failure on essentially every real meeting,
  including ones whose report landed correctly moments later; the operator's report was exactly that
  — *her toplantıda bunu diyo*. It now polls fast for the first minute (a short meeting really is
  ready in seconds) and then patiently, to a ~20 minute budget, and when the budget is spent it says
  the summary is **not ready yet** rather than that it failed — which is true, recoverable, and the
  difference between a bug report and a refresh.
- **The report turn no longer reads back the transcript it just summarized.** The harness's `Write`
  tool refuses to overwrite a file it has not `Read` this session, and the target path holds the
  worker's own transcript mirror — so the turn read 153 KB straight back into the context the token
  budget had just condensed, defeating it. The target is now removed immediately before the write
  turn: `Write` creates instead of overwriting, needs no `Read`, and the only transcript in context
  is the digest. A failed turn still restores the mirror, so the transcript is never the price.
