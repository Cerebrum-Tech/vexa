# terminal — the meeting workspace (Next.js)

## Purpose

The browser client presents a Turkish meeting library, people, companies and partner notes in a
responsive page layout. A contextual assistant keeps a separate conversation for each authenticated
user and canonical meeting run. General conversations remain available from the sidebar.

Surfaces use the contribution registry and existing authorized APIs. Same-origin `/api/*` Next route
proxies keep upstream hosts and credentials server-side and relay chat streams.

Meeting preparation keeps title, link, date, automatic joining and workspace selection in a local
draft. New drafts start at the current time. Planla saves all fields in one request; Katıl saves
with automatic joining disabled, then launches the exact saved meeting ID. Failed joins retain
the draft and reconcile the owned row before retrying. The library also offers a direct link-entry
join control. Meeting dates fall back to persisted creation time when no planned or actual start
exists, so unjoined records retain a stable date across refreshes.

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| calls | agent-api | `POST /api/chat` (SSE proxy → `${AGENT_API}/api/chat`) | a chat now-dispatch; SSE relay of the agent's output stream |
| calls | agent-api | `GET /api/sessions` | a subject's chat-session list (resume) |
| calls | agent-api | `GET/POST /api/routines`, `PATCH /api/routines/{name}/enabled`, `DELETE /api/routines/{id}` | list / create / enable·disable / delete a `routine.v1` cron job |
| produces | agent-api | `POST /api/events` (→ `${AGENT_API}/events`) | an `event.v1` Event → a `unit.v1` Invocation → Dispatcher |
| calls | meeting-api (via gateway) | `GET /meetings` + `WS /ws` (`u:{user}:meetings`) | the user's meetings (live + past); live status deltas over the socket (no poll) |
| calls | agent-api | `GET /api/meeting/stream?meeting_id=&session_uid=` (SSE, `EventSource`) | live transcript + copilot output wire |
| calls | meeting-api (via gateway) | `POST /bots`, `DELETE /bots/{platform}/{native}`, `PUT /meetings/{platform}/{native}/intent` | launch / stop a self-hosted meeting bot; schedule·cancel its scheduling intent |
| calls | agent-api | `GET /api/workspace/{tree,file,git}?slug=` | workspace tree, file content, the agent's real git state |
| consumes | browser | page layout + surfaces registry (`src/surfaces/index.tsx`) | registered pages, secondary tools, contextual assistant and palette commands |

All upstreams resolve to `AGENT_API_URL` (default `http://127.0.0.1:18100`).

## Contracts

**Owns:** none — the terminal defines no `*.v1`; it is a pure client of the agent domain.
**Consumes:** `core/agent/contracts/event.v1` (the `/api/events` ingress shape), `routine.v1`
(routines CRUD), `unit.v1` (chat + SSE relay), and the meeting/workspace surfaces of
`core/agent/services/agent-api`. Schemas are sealed in `contracts.seal.json` (repo root) — the
proxies forward bodies verbatim, they do not re-declare schemas.

## Terminal modes

`NEXT_PUBLIC_TERMINAL_MODE` (build-time public env — inlined by `next build`, changing it requires a
rebuild; see `src/app/mode.ts`):

- unset / empty (default) — every surface registers.
- `meetings` — a meetings-only terminal: only the **Meetings** list, the **meeting/canvas** tabs, and
  the **API Tokens** surface register. The agent surfaces (chat, sessions, workspace/knowledge,
  routines) and their palette commands never register, and the server proxy refuses agent-api paths
  with 404 (`src/app/api/proxyMode.ts`), so no agent traffic is possible from this deployment.

Pass it as a Docker build arg (`--build-arg NEXT_PUBLIC_TERMINAL_MODE=meetings`) or via the
commented example on the `terminal` service in `deploy/compose/docker-compose.yml`.

## API tokens (self-serve)

The **API Tokens** left list (`src/surfaces/tokens.tsx`) lets the logged-in user list, mint
(scopes `bot`/`tx`/`browser`, optional name + expiry) and revoke their own tokens. The `/api/tokens`
routes call admin-api with the server's `VEXA_ADMIN_API_KEY` (admin tier, like the login flow) and
scope every operation to the user resolved from the httpOnly auth cookies — a `user_id` from the
client is never accepted. The minted token value is returned once, at creation.

Separately, every OAuth **or** email **login** mints its own API token named `terminal-login`
(distinct from the self-serve tokens above). These login tokens are **capped per user** — after each
sign-in the terminal prunes a user's oldest `terminal-login` tokens beyond `VEXA_TERMINAL_LOGIN_TOKEN_CAP`
(default `3`), so repeated sign-ins (including an OAuth redirect loop) leave a bounded set of live
tokens rather than one new token per sign-in. The prune only ever touches `terminal-login`-named
tokens; **self-serve tokens you created above are never pruned by login.**

## Isolated evaluation

Run the client checks from this directory:

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
npm run dev
```

Vitest covers meeting pagination and access changes, directory reads and editor dispatch,
conversation switching, report provenance and notifications, and navigation. Browser checks need an
isolated development server with authorized test data. Model output quality requires a separate live
meeting or recording witness.
