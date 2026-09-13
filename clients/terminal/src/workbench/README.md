# workbench

The responsive shell renders one registered page and an optional assistant panel. Its primary
navigation is Toplantılar, Kişiler, Şirketler and İş Ortağı Notları; additional contributions are
available under Diğer araçlar. Account controls, theme and report notifications live in the shell.

`LayoutService.usePages()` enables page navigation with bounded back history. Existing tab descriptors,
preview retargeting and contribution commands resolve to pages. Direct meeting URLs restore the requested
meeting; private page descriptors are not restored from browser storage on a new login.

The shell resolves the authenticated subject and canonical meeting row before mounting meeting chat.
`Chat` owns conversation isolation. `ReportNotifications` observes reports from authorized workspaces
while any page is open. Surfaces own their content and use the existing API boundaries.
