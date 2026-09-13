- **A clearer Turkish meeting workspace.** A responsive sidebar opens the complete searchable meeting
  library, people, companies and partner notes. Meeting conversations are scoped to each user and run;
  raw and corrected transcripts remain separately accessible. Correction defaults on, with an explicit
  off preference retained. Report indicators check saved content and run provenance, and notifications
  remain available outside the meeting page. See [Workspace files](/how-to/workspace-files) and
  [Meeting reports](/how-to/post-meeting-report).
- **Remove the experimental Teams greeting.** The bot no longer attempts an admission greeting or
  outbound Teams chat through the experimental sender. Incoming Teams chat capture remains available.
- **Isolate parallel Docker deployments.** `DOCKER_NAME_PREFIX` separates workload names when stacks
  share a daemon. Container conflicts only replace a verified stale workload on the same stack network.
  Report notification popups are bounded on small screens while every notification stays in the list.
- **Submit meeting details once.** Title, link, date, automatic joining and workspace selection stay
  local until Planla or Katıl. A visible quick-join control opens the returned canonical meeting,
  failed submissions retain inputs, and new drafts start at the current date and time. Unjoined
  history uses its persisted creation date; mixed time-zone offsets sort by their actual instant.
