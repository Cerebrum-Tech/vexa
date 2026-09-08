- **Meeting times are typed, not just picked (#0000).** The planned-meeting picker offered a list of
  quarter-hour slots and nothing else, so an ordinary meeting time like 17:35 was inexpressible and
  users rounded their own calendar to fit the tool. The popover now carries a **typed time field**
  above the slot list: it is forgiving about how a time is written (`17:35`, `17.35`, `1735`, `9:05`,
  `9`) and strict about whether it is one — `25:00` is refused with a Turkish hint rather than
  silently clamped to a time nobody asked for. The slot list stays for the common case. Reported by
  an Innova operator during team testing.
