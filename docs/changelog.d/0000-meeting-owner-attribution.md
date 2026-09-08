- **Every meeting's report is written into its owner's workspace — and the copilot can actually
  start (#0000).** Two halves of one silent outage. The meeting copilot was dispatched under a
  hardcoded `u_live` placeholder subject; that subject had no workspace on disk, and the mount set
  names a path the runtime bind-mounts, so the container never started
  (`docker start … cannot access path …/u_live: no such file or directory`). Every meeting on the
  deployment failed there, so **no post-meeting report was ever written** — and the terminal's recap
  panel, which polls the reader's OWN workspace, would not have found one in a placeholder anyway.
  It surfaced to users only as "Toplantı özeti oluşturulamadı" after the panel's 90-second wait.
  - Each meeting is now attributed to its real owner, resolved per meeting from meeting-api's new
    internal edge `GET /internal/meetings/{id}/owner` (`X-Internal-Secret`, fail-closed, never
    reachable from a client edge). The copilot — and therefore the report — runs under that subject,
    so the report lands where its reader looks. An unattributable meeting still arms under the
    fallback rather than losing its report, and says why on `relay_health.owner_resolve` (P18).
  - The dispatch now **materializes** the workspace it is about to mount instead of merely naming
    it, and drops any mount whose path is not on disk. The old "fails soft to `{root}/{subject}`"
    fallback did not fail soft at all — it moved the hard failure one hop later, into container
    start, where it read as a runtime error rather than a missing workspace. Losing a mount costs a
    turn some context; keeping a phantom one costs the turn its existence.
  - Chosen over the one-line unblock (creating the `u_live` directory), which would have fixed the
    crash and not the complaint: the report would still have been written where nobody could read it.
  Reported by an Innova operator during team testing.
