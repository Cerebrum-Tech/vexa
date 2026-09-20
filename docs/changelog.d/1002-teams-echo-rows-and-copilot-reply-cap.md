- **Teams: one utterance no longer lands twice under two names.** When the next speaker's lane opened on the
  previous speaker's last words, that tail was published again as the new lane's first row ("robot bakımından.
  Orada" under a second name, 0.9 s after it closed the first). The lane now retracts the echo copy on text plus
  time alone, where the word contest needed word timings the backend never gave. Measured on a 24-minute,
  six-speaker Teams meeting on faster-whisper: 7 of 200 durable rows were such echoes.
- **Meeting copilot: a reply cap no longer throws away a whole window of live notes.** With
  `VEXA_LLM_MAX_TOKENS` below one window's JSON (2048 against a 43-row window), the model's reply was cut mid-note
  and every note in the window was lost behind "model response did not include processed transcript notes". The
  parser now keeps every note that closed before the cut; deployments should still size the cap for their window
  (8192 is comfortable). See [Post-meeting report](/how-to/post-meeting-report).
- **Transcription: Turkish YouTube-outro hallucinations are suppressed by pattern.** Whisper's "kanalımıza abone
  olmayı ve videoyu beğenmeyi unutmayın", "abone ol" and "izlediğiniz için teşekkürler" on near-silent screen-share
  windows no longer reach the transcript; real business phrases with the same words ("servise abone olmayı
  düşünüyoruz") are pinned as kept.
