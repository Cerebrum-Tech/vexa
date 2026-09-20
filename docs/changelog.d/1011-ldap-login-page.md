### Changed

- **The sign-in page is one centered form, in Turkish.** The card with the logo row is gone. The page
  now reads "İnnova Toplantı Asistanı'na giriş yapın" above a Kullanıcı Adı and Şifre field (with a
  show/hide eye), a full-width "Giriş yap" pill and the note "* İnnova kullanıcınız ile giriş yapın".
  A small "Diğer giriş seçenekleri" link swaps in the other methods (Google, Microsoft, or the
  test-mode e-posta entry), `?auth=email` opens them directly, and "LDAP ile devam et" swaps back. A
  deploy without LDAP lands on the other methods directly. The first-run admin-claim variant keeps
  the same layout with its own heading and note.
