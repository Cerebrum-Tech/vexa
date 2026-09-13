/** The RAW transcript is the default for every meeting: it is what the STT actually heard, and the
 *  corrected view is a model's rewrite of it. An explicit selection (either way) wins. */
export function defaultProcessingView(_live: boolean, _hasNotes: boolean): boolean {
  return false;
}

export function deriveProcessingView(o: {
  override: boolean | null;
  live: boolean;
  hasNotes: boolean;
  durableTerminal: boolean;
}): boolean {
  return o.override ?? defaultProcessingView(o.live && !o.durableTerminal, o.hasNotes);
}
