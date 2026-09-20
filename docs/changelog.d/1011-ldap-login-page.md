### Changed

- **The sign-in page is the İnnova corporate login.** A white page with two faint red gradients,
  the white İnnova wordmark on its charcoal backing next to "Kurumsal uygulamalar", and one compact
  centered card: "Toplantı Asistanı", "Hoş geldiniz", a one-line intro, Kullanıcı adı and Şifre
  (with a show/hide eye), the red full-width "Giriş yap" button, the note "İnnova kullanıcı
  bilgilerinizle giriş yapın.", then a divider and the "Diğer giriş seçenekleri" link. That link
  swaps in the other methods (Google, Microsoft, or the test-mode e-posta entry) in the same card,
  `?auth=email` opens them directly, and "LDAP ile devam et" swaps back. A deploy without LDAP lands
  on the other methods directly. The button stays red and enabled from the start; while a sign-in
  is pending it reads "Giriş yapılıyor…" and blocks a second submit; a rejected sign-in lands in an
  alert region above it. The route is always light, whatever theme the workspace uses. The
  first-run admin-claim variant keeps the same card with its own heading, intro and note.
