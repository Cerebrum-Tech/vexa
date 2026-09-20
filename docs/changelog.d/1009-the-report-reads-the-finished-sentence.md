### Fixed

- **The meeting report is authored on the finished sentence, not the first draft of it.** A processed
  note was published once, when its segment first appeared on the transcript stream; every later draft
  that refined or *extended* that segment updated the worker's window in place and published nothing.
  The durable transcript kept the last text, the report's evidence kept the first — so the report was
  written on a transcript whose sentences stop early. Measured on a 30-minute Turkish call: 264 durable
  rows / 18,927 characters against 12,161 characters of evidence, with 106 rows materially truncated and
  ~7,700 characters of speech the author never saw. Turkish puts the verb last, so the amputated tail is
  exactly where the commitment sits — decisions and action items went missing from reports whose
  transcript, on screen, was complete. A segment now republishes its 1:1 note whenever its text changes,
  and the end-sequence republishes every segment before the report turn runs.
