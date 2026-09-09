- **Calendar feed: `webcal://` accepted, refusal says where the link is.** Outlook and Apple hand
  out the ICS feed as `webcal://`; admin-api now stores it as `https://` instead of refusing. A
  paste that is not a feed URL at all is refused with the Outlook and Google paths to the right
  link, in the deployment's language, instead of `ics_url must be an http(s) URL`.
