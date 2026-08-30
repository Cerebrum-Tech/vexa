# Innova Turkish Terminal Design

## Objective

Brand every repository-controlled Terminal logo as Innova, use `Innova Toplantı Asistanı` as the
default meeting bot name, and make the local test Terminal and meeting recap interaction Turkish.
Teams remains joined with its camera disabled; no virtual-camera avatar is added.

## Branding

Vendor the official black/red Innova wordmark SVG from `https://www.innova.com.tr/home` into the
Terminal. Use a square, padded SVG wrapper for favicon-sized surfaces and the unmodified wordmark for
wide headers. Replace all references to `vexa-logo.svg` and the Vexa application icon, update alt text,
metadata, and visible product naming. Do not fetch brand assets at runtime.

## Bot identity

Keep the existing `bot_name` request contract. Change the Terminal fallback and Compose defaults to
the exact string `Innova Toplantı Asistanı`, with a build-time `NEXT_PUBLIC_DEFAULT_BOT_NAME` argument
so browser code receives the deployment value. Existing explicit per-calendar bot names still win.

## Turkish recap and UI

The post-meeting steering prompt must explicitly require Turkish responses for summaries, decisions,
actions, owners, and follow-ups. This complements the existing `report_language: tr` document writer;
it fixes interactive `/recap`-style chat replies at their server-side prompt source.

Translate the local test Terminal's user-facing meetings path: authentication/setup, workbench chrome,
today list, meeting view, chat phase labels/placeholders, and settings labels used to configure local
LLM/STT endpoints. Keep API values, route names, persisted keys, errors received from servers, and
source-level identifiers unchanged. Set document language to `tr`.

## Verification

Use test-first checks for Turkish steering, bot-name precedence, metadata/brand references, and key
meetings-mode copy. Run the focused Python and Terminal suites, build the Terminal image, inspect the
rendered UI locally, and verify Ollama still has no host/LAN listener. Leave all changes uncommitted
because contribution-rights status is `Unsure`.
