# Connected apps and MCP servers of the Environment (plan DEV-6626, M4)

Status: shaping, 2026-10-08. It proposes **F42** (status: proposed; owner: Matěj)
and carries a red test contract (`tests/connections-*.test.ts`). Nothing here is
implemented or deployed.

Inputs: root decision 0162 with its addendum of 2026-10-08, points 1–10
(HumanAndMachines/Lazurio#507), and the addenda to 0185 and 0188 of the same day;
plan DEV-6626, milestone M4; the approved wireframe
HumanAndMachine-ai/prototypes-lazurio#22 (UX reference, not code to copy); the
`composio` CLI 0.4.1 (`--help`) and its source on `ComposioHQ/composio@next`, read
2026-10-08; OpenMausBot's MCP documentation; the MCP configuration of Codex 0.161
and Claude Code 2.1.

## F42 — Apps are connected in the Launchpad over the Environment's own CLI; MCP servers belong to the Environment (proposed)

**Proposed 2026-10-08 for Matěj's decision.** It implements mode 1 of root decision
0162's addendum of 2026-10-08.

1. **One page.** The Launchpad gets Apps → Připojené aplikace (`/connections`,
   `/connections/<toolkit>`), under Soubory in the Apps column. It is a catalog of
   Composio apps in the design of OpenMausBot's Apps dialog: tabs Vše / Připojené N /
   MCP servery, search, three-column cards, the accounts inside their card, and the
   Environment's MCP servers. It has one subtitle sentence and a "Jak to funguje" link;
   explanations live in the documentation.
2. **Mode 1 only, behind one boundary.** The page drives the Environment's
   `composio` CLI, which the operator signs in with their own Composio account in
   Settings → Nástroje (F19, unchanged). The Launchpad talks to a
   `ConnectionsBackend`; mode 1 implements it with the CLI. Mode 2 (the Organization's
   Composio organization, a project per Environment, provisioned by the
   Organization's broker) and the CLI's project-key login implement the same boundary
   later. Neither is built here.
3. **The CLI is the only actor on Composio.** Lazurio runs `composio` with F19's
   minimal environment and reads only its output and its public catalog cache. It
   never reads the CLI's key or any other file of its store, and never calls
   Composio's API itself.
4. **One Environment, one set of accesses.** Everything the Environment is signed in
   to (connected apps, MCP servers, tools) is there for every agent in Chat and every
   bot in Automate. Nothing is allowed per agent or per bot; other access means
   another Environment.
5. **Accounts.** An account is named once, when it is connected; renaming means
   disconnecting and connecting again. An expired, failed or pending account carries
   one state line. A disconnect needs the person's explicit confirmation and a CLI that
   removes without its interactive prompt; Lazurio never answers that prompt.
6. **MCP servers belong to the Environment.** One list in the Folder's preferences,
   without secrets, is managed on the same page and with `lazurio mcp`. Lazurio renders
   it into every consumer: Codex (`~/.codex/config.toml`), Claude Code (user scope) and,
   through those two, Lazurio MausBot. A header or variable value stays in local
   custody: Lazurio's 0600 custody file and the consumers' own 0600 configuration. It
   never enters Git, the Folder, an API answer or a log. This retires F18's sentence
   that MCP servers are never recorded in the Folder.
7. **Agents never send a raw Composio link.** For a missing app they send the
   Launchpad link `<origin>/connections/<toolkit>`, which opens the app's card with its
   name field. An agent adds an MCP server only on the Operator's request, and only
   into the Environment's list.
8. **An expired sign-in shows in the shell's column head** in Chat and Automate,
   with the same link.
9. **One projection.** The page, the shell line and a later report to the Dashboard
   map (DEV-6640) read one snapshot: apps, account names and states, MCP server names
   and states. It never holds a token, link, account id or secret value.

When accepted, F42 amends F14 (the manual's texts on connected applications and MCP),
F18 (its MCP sentence) and F19 (composio's usage and installation texts; Settings →
Nástroje keeps the composio sign-in and links to the page).

## 1. Intent and consumers

A person connects an app without a terminal and without copying a key, sees which
accounts are connected and in what state, and disconnects them, all in the Launchpad.
People got lost when they connected an app on Composio's website: the connection
landed in another Composio account than the one the Environment's CLI was signed in
to. Agents and bots then use the app at once.

| Consumer | What it uses |
| --- | --- |
| The person (Operator) | The page; Settings → Nástroje for the composio sign-in |
| Agents in Chat (Codex in T3 Code or ChatGPT Desktop, Claude Code) | `composio`; the rendered MCP servers; the Folder's instructions with the deep link |
| Bots in Automate (Lazurio MausBot) | The same `composio`; the MCP servers through the Codex and Claude Code configuration |
| The shell (column head of Chat and Automate) | Expired connections from the shell document |
| The Dashboard map, later (DEV-6640) | The read model of section 11 |

**Not in M4:** mode 2 and its broker (M5, M6); the CLI fork and the project-key login
(M3); reporting to the map (M7); MausBot's fork changes (Lazurio/OpenMausBot#27); app
events through `composio listen` (M8); MCP servers that need their own OAuth sign-in;
per-agent or per-bot access; Windows (the composio flows of F19 are refused there, and
so are these).

## 2. The boundary

```ts
// src/connections/backend.ts (proposed)
export interface ConnectionsBackend {
  readonly mode: "operator-account" | "environment-project";
  /** Whose connections these are: signed out, ready (with the account's and the
   * Composio organization's labels in mode 1), preparing (mode 2), unavailable. */
  space(): Promise<ConnectionsSpace>;
  /** Apps that need a connection: popular first, then the rest. */
  catalog(): Promise<ConnectionsCatalog>;
  /** Every account with one of four states: connected, expired, pending, failed. */
  accounts(): Promise<ConnectionsAccounts>;
  /** Starts a connection; returns the address the browser opens. */
  link(toolkit: string, name: string | null): Promise<LinkStart>;
  /** Whether the started connection is active yet. */
  linkState(link: LinkHandle): Promise<LinkProgress>;
  /** Removes one account, after the person confirmed it. */
  disconnect(account: AccountRef): Promise<DisconnectResult>;
  /** What this backend can do here, e.g. disconnect without a prompt. */
  capabilities(): Promise<Readonly<{ disconnect: boolean }>>;
}
```

The routes, the page, the link sessions, the shell line and the read model depend only
on this interface. Mode 1 is `composioCliBackend(toolsEnvironment)`. In mode 2, the
same CLI signed in with the project key covers catalog, accounts, link and disconnect;
`space()` reads the Organization's provisioning instead of `composio whoami`. If the
CLI lacks something there, mode 2 may use the SDK with the project key (that key is the
Environment's, not a person's). The Launchpad chooses the backend: mode 1 on a personal
Environment and a workstation; on an Organization's Environment, the Organization's
choice (M5).

The page needs nothing else from mode 2. It reads `mode` and `space.kind`: without a
sign-in it shows "Přihlásit Composio" in mode 1, and in mode 2 "no company Composio
yet" or "preparing". The disconnect dialog then names the right consequence.

### Mode 1 over `composio` 0.4.x

| Operation | Command | What Lazurio reads |
| --- | --- | --- |
| space | `composio whoami` (F18's probe) | email and organization labels |
| catalog | none: the CLI's public cache `~/.composio/toolkits.json` | `slug`, `name`, `meta.description`, `meta.categories`, `no_auth` |
| accounts | `composio connections list`, then `composio link <toolkit> --list` for each toolkit with an active account | statuses, `word_id`, aliases; ids and aliases of active accounts |
| link | `composio link <toolkit> --no-wait --no-browser [--alias <name>]` | the JSON `{status: "pending", connected_account_id, redirect_url, toolkit}`; without managed auth, one dashboard URL instead |
| link state | `composio link <toolkit> --list` | whether `connected_account_id` is active |
| disconnect | `composio connections remove <id or word_id> --yes`, only when `connections remove --help` lists `--yes` | then `accounts()` again, as the proof |

These outputs come from the CLI's source. `connections list` prints every status but
no ids, and an alias only when the toolkit has more than one account; `link --list`
prints only active accounts, with ids. `link` refuses a second account without
`--alias` and an alias already used by an active account (case-insensitive). A toolkit
without Composio-managed auth gets a URL of Composio's dashboard instead of a connect
link. When M3 adds ids and aliases to `connections list`, the adapter drops the
per-toolkit `--list` calls; nothing above the boundary changes.

Statuses map to four states: `ACTIVE` → connected; `EXPIRED`, `REVOKED` → expired;
`INITIATED`, `INITIALIZING` → pending; `FAILED`, `INACTIVE` and any unknown value →
failed. Every process runs as in F19: only `PATH`, `HOME`, `XDG_*` and `NO_COLOR`, in its
own process group, bounded (15 s), the output bounded and parsed, and never returned or
logged raw. Errors are fixed codes (`not-installed`, `signed-out`, `tool-exit`,
`timeout`, `unreadable`, `unexpected-url`).

## 3. API

The routes are served behind the same admission as every read (the token locally, the
gateway's session hosted). Reads are GET; changes are POST with a JSON body (at most
16 KiB, `Content-Type: application/json`). A refusal is `409 {kind: "blocked",
reason}`; malformed input is `400`.

| Route | Answer |
| --- | --- |
| `GET /api/connections` | `{kind: "connections", mode, space, capabilities: {disconnect}, apps: [{toolkit, name, accounts: [{account, name, state}]}]}` |
| `GET /api/connections/catalog` | `{kind: "connections-catalog", source: "cli-cache" \| "popular-only", apps: [{toolkit, name, description, categories, logo, popular}]}` |
| `POST /api/connections/link {toolkit, name?}` | `{kind: "link-pending", session, toolkit, url, expiresAt}`; blocked: `signed-out`, `name-required`, `name-taken`, `name-invalid`, `toolkit-unknown`, `unsupported-platform`; `{kind: "link-failed", reason}` |
| `POST /api/connections/link/poll {session}` | `link-pending`, `{kind: "connected", toolkit, account}` or `{kind: "link-ended", reason: "expired" \| "cancelled"}` |
| `POST /api/connections/link/cancel {session}` | `{kind: "cancelled"}` |
| `POST /api/connections/disconnect {account, confirm: true}` | `{kind: "disconnected"}`; `400 confirm-required` without `confirm: true`; blocked: `disconnect-unsupported`, `account-unknown`; `{kind: "disconnect-failed"}` when the account is still listed |
| `GET /api/connections/mcp` | `{kind: "mcp-servers", revision, servers: [{name, kind, command?, args?, url?, secret?: {kind, name}, state, tools?}]}` |
| `POST /api/connections/mcp/add {expectedRevision, server}` | `{kind: "updated", revision, server}`; blocked: `stale-revision`, `drift`, `name-invalid`, `name-taken`, `consumer-conflict`, `unsupported-platform` |
| `POST /api/connections/mcp/remove {expectedRevision, name, confirm: true}` | as add; `400 confirm-required` without `confirm: true` |
| `POST /api/connections/mcp/check {name}` | the server with its new state |

`account` is an opaque selector the page sends back: Composio's connected account id
for an active account, its `word_id` otherwise. It is never logged and never leaves
for the map. In `connected`, `account` is the account as `GET /api/connections` lists
it. The link `url` is sensitive while it is valid, exactly like F19's challenge: only
the request that started it and the holder of its `session` handle receive it, and it
is never logged, journaled or written anywhere. The journal says `{scope:
"connections", event, toolkit, outcome, reason}` and nothing else.

## 4. Catalog and logos

- **Popular first.** The product ships one ordered list of about fifty toolkit slugs
  with a one-line description in Czech and English (`src/connections/popular.ts`,
  taken from the approved wireframe). The CLI's cache is alphabetical and carries no
  popularity, so this list is the only ordering Lazurio owns.
- **Everything else** comes from the CLI's public catalog cache, read-only, entry by
  entry, with unknown fields ignored and descriptions cut to 200 characters. On
  2026-10-08 it held 1,596 toolkits. Toolkits that need no connection (`no_auth`,
  Composio's own built-ins among them) are left out. The other apps show Composio's
  own description, which is in English.
- **No paging.** `GET /api/connections/catalog` answers the whole ordered list once.
  The page renders it progressively while the person scrolls, and its search (without
  case or diacritics, over name, slug, description and category) covers every app.
- **Missing cache.** The CLI rewrites the cache, atomically, whenever it fetches the
  full catalog, and reads it itself only with `FORCE_USE_CACHE`. A fresh Environment
  may have none, and one whose CLI has not fetched the catalog for a while has an
  older one. Without it the catalog is the popular list (`source: "popular-only"`).
  M3's documented catalog command, with logos, replaces the cache read behind the same
  method.
- **Logos.** The browser loads `https://logos.composio.dev/api/<slug>` itself
  (answered 200 `image/svg+xml` on 2026-10-08). A logo that does not load becomes the
  app's initial. Lazurio bundles and proxies no logos.

## 5. Connecting an app

1. "Připojit" (or "Přidat účet") opens a form inside the card: "Název účtu",
   optional for the first account of an app and required for another one, because the
   CLI requires `--alias` then. A name is plain text of at most 64 characters, unique
   among the app's accounts without regard to case. The Launchpad checks it before
   anything runs (`name-required`, `name-taken`): the CLI checks that a name is
   required only after it has created the link, so its own refusal could leave a
   pending account behind.
2. "Pokračovat" opens an empty window synchronously in the click, so the browser does
   not block it, and starts the link. The answer's `url` must be https on Composio's own
   domain (`composio.dev` or a subdomain); anything else ends the link as
   `unexpected-url` and nothing opens. The window is navigated to the URL with
   `opener` cleared. When the window could not open, the page shows one line,
   "Prohlížeč zablokoval okno s připojením. Povol vyskakovací okna a zkus to znovu.",
   and the account row offers the same address as a plain link.
3. The account row says it is pending. The page polls `/api/connections/link/poll`
   every 2 s while the session lives. Each poll runs at most one CLI check, and a check
   at most every 2 s per session. The account the link created becomes active →
   `connected`, and the page reads `/api/connections` again.
4. A session lives 10 minutes, like F19's composio sign-in. After that it ends as
   `expired`. The account Composio created stays pending until the person finishes it
   or disconnects it, and the account list (always read live) shows the truth. A
   failed sign-in is visible as the account's state; with M3's ids in `connections
   list` it also ends the session at once.
5. A toolkit without Composio-managed auth gets a dashboard URL from the CLI. The page
   opens it the same way, and a new active account of that toolkit completes the
   session. Whether these toolkits, most of them API-key ones, can be connected that
   way is qualified on a test account (open question 3).

**The deep link** `/connections/<toolkit>` (slug `[a-z0-9_]{1,64}`) is a page route
like `/files` (`{view: "connections", toolkit}`; `/connections` alone is `{view:
"connections"}`), served without the token like every page. It opens the page with
that card in view and its form open. An app whose account is expired or pending
gets that account's own action instead. Without a composio sign-in, F19's sign-in
dialog comes first, through the same `/api/tools/login/*` routes, and the card opens
after it. That sign-in also turns composio on for agents, as a sign-in in Settings →
Nástroje does (`autoEnable`, Matěj 2026-10-04). An unknown slug opens the catalog with
the search field holding it. The first-run tour's
"Připoj své aplikace" step leads here (0188 addendum).

## 6. Accounts, names, disconnect

A card shows "✓ Připojeno" when at least one account is active, then "Přidat účet", then
its accounts, each with "Odpojit". There is no rename: a different name means
disconnecting and connecting again. An account that is not active carries one line:

| State | Line | Action |
| --- | --- | --- |
| pending | "Dokonči připojení v prohlížeči, nebo účet odpoj" | "Pokračovat" while its session lives |
| expired | "Přihlášení vypršelo — zkus to znovu" | "Přihlásit znovu": a new link under the same name; if Composio creates a new account instead of renewing the expired one, the expired one is removed once the new one is active and disconnecting is available |
| failed | "Připojení se nepovedlo — zkus to znovu" | "Zkusit znovu" |

**Disconnect.** The dialog names the account and the one consequence. In mode 1 that
is "Odpojí se z Composio účtu <account>, takže ve všech Environmentech, které ho
používají", because connections belong to the Composio account and organization. The
route refuses a request without `confirm: true`. It then runs `composio connections
remove <exact selector> --yes` and confirms the result by reading the accounts again.

**Safe interim until `--yes` exists.** `connections remove` asks for confirmation and
defaults to No; without a terminal it removes nothing and exits 0. The proposed `--yes`
flag (M3, upstream or the fork Lazurio/composio) is detected from `connections remove
--help`. Without it the route answers `disconnect-unsupported`; the page says in one line
that this composio cannot disconnect yet and offers "Aktualizovat" in Settings →
Nástroje (`lazurio tools update composio`). Lazurio never feeds the prompt (no pseudo
terminal, no piped "y") and never removes by a selector that could match more than one
account (a toolkit slug or a bare alias).

## 7. MCP servers of the Environment

### Where the list lives

The Folder's `.lazurio/preferences.json` gains an optional key `mcpServers`, exactly
like `tools` (F18). It is a list sorted by name and validated by the exact-key parser:

```json
[
  { "name": "invoicing", "kind": "url", "url": "https://mcp.example.com/mcp",
    "secret": { "kind": "header", "name": "Authorization" } },
  { "name": "notes", "kind": "command", "command": "npx",
    "args": ["-y", "@example/notes-mcp"], "secret": { "kind": "env", "name": "NOTES_TOKEN" } }
]
```

- **Shape.** A name matches `^[a-z][a-z0-9_-]{0,31}$`, which is a bare TOML key and a
  valid Claude Code and OpenMausBot name. A command is an argv, never a shell string.
  A URL is https without credentials. One optional secret per server: an environment
  variable for a command, a header for a URL. The list holds its name only.
- **Storage rules.** The key is absent when the list is empty, and an empty list is
  refused. A change is a fourth `FolderChangeRequest` kind (`{kind: "mcp",
  expectedRevision, servers}`) through F18's one planner and transaction, with its
  revision, archive and recovery; `inspect` is its read-only twin. The schema version
  is not raised. Like `tools`, a Folder with the key is unreadable by older binaries
  (fail closed, no rollback, F21).
- **Who changes it.** The page's routes and `lazurio mcp add|remove --folder <F>
  --expected-revision <n>` call the same use case; `lazurio mcp list` reads it.
  `lazurio mcp add` takes no secret value, so an agent never handles one. A server that
  needs a value is added by the Operator on the page.
- **Rendering.** AGENTS.md and `manual/this-machine.md` name the servers (name and
  kind, never a value), so agents know what the Environment has.

### Secrets

The value of a header or variable is typed once, into a masked field. It is kept in
`${XDG_CONFIG_HOME:-~/.config}/lazurio/mcp-secrets.json` (directory 0700, file 0600,
written through a temporary file and a rename), keyed by server name. It goes from there
into the consumers' own entries (below) and into the probe, and nowhere else. No route
returns it (`secret: {kind, name}` only), no log or journal names it, and it never
enters the Folder, its archive, a prompt or Git. Removing a server deletes its value; a
new value means removing and adding the server. Order of an add: custody first, then the
Folder change, then rendering. A refused Folder change deletes the value it wrote, and a
value without a server is deleted at the next reconciliation.

### Rendering into the consumers

| Consumer | How | Owner of the file |
| --- | --- | --- |
| Codex (Chat, MausBot's Codex bots) | One Lazurio-managed block of `[mcp_servers.<name>]` tables in `~/.codex/config.toml`: `command`, `args`, `env` for a command; `url`, `http_headers` for a URL | Codex; Lazurio owns only its block |
| Claude Code (Chat, MausBot's Claude bots) | `claude mcp add-json --scope user <name> <json>` and `claude mcp remove --scope user <name>` (`{type: "stdio", command, args, env}` or `{type: "http", url, headers}`) | Claude Code; Lazurio never edits `~/.claude.json` |
| Lazurio MausBot | Nothing of its own: Codex bots read `~/.codex/config.toml`, and Claude bots read Claude Code's user servers once the fork keeps "Also use my Claude Code MCP servers" on and hides its own MCP page (Lazurio/OpenMausBot#27) | OpenMausBot; Lazurio writes nothing under `~/.openmausbot` |

The Codex block lies between marker comments that carry a digest of the block. Lazurio
replaces only that block and keeps every other byte. It writes through a temporary file
and a rename, keeps the file 0600, and first checks that the result parses as TOML. A
name that Codex or Claude Code already has outside Lazurio's set refuses the add
(`consumer-conflict`) before anything is written. A hand-edited block is `drift`:
nothing is written and the page says so. A file that does not parse is never written.
`codex mcp add` is not used: in Codex 0.161 it cannot set a static header, and two
writers of one file would race. A consumer that is not installed is `absent` and gets
the servers when it appears. Reconciliation runs after every change, at the
Launchpad's start and on the page's refresh.

### Reload, restarts and a broken server

Lazurio restarts nothing; it is not a second supervisor. Codex and Claude Code read
their MCP configuration when a session starts, and MausBot when a bot's task starts. So
new chats and every bot's next task get the current list, while a running chat keeps
the servers it started with. Whether T3 Code's long-lived Codex app-server reads it for
each new thread is a qualification item.

The state line comes from a probe. After an add, on "Zkusit znovu" and on the page's
refresh (at most once a minute per server), Lazurio starts the server once with its
value: a command without a shell, in its own process group, bounded by 10 s. A URL
server it connects to with its header. It completes MCP `initialize` and `tools/list`
and keeps `{state: "ok", tools: n}` or `{state: "failed", reason}` in memory. The page
shows "Připojeno · N nástrojů", "Nepodařilo se spustit" or "Spouštím…". A broken server
stays rendered, because the list is the truth. Codex and Claude Code skip a server that
fails to start, and MausBot skips invalid entries. The cost is that a dead command
delays each new chat by the consumer's startup timeout, so the page shows the failure
next to "Odebrat".

## 8. Folder instructions

A new template revision covers:

- `manual/working-here.md`, "Connected applications":
  - Find what is here with `composio connections list` and `lazurio mcp list`.
  - For a missing app, find the toolkit (`composio search <app>`) and send the
    Operator `<origin>/connections/<toolkit>`, where the Folder records an entry. On a
    workstation, ask them to open Lazurio → Apps → Připojené aplikace (Connected apps).
  - Never run `composio link` and never send a Composio link.
  - An expired sign-in gets the same link.
  - Accounts are selected by their names: `composio execute … --account <name>`.
- AGENTS.md and `manual/this-machine.md` (`launchpadRouting`): the applications line
  names `<origin>/connections/<toolkit>`. `<origin>/settings/tools` stays the place
  to switch Composio on and sign it in.
- The composio catalog texts: `usage` drops "Connect an app with `composio link
  <toolkit>`, which returns a link for the Operator to open". `installation` drops
  "single applications are then connected with `composio link <toolkit>`".
- The MCP rule (`mcpInstruction`, `mcpServerPrompt` and the manual's "each
  Organization on its own" bullet):
  - MCP servers belong to the Environment, and every agent and bot has the same ones.
  - Add one only on the Operator's request, always with `lazurio mcp add`, never into
    one harness's own configuration.
  - A server that needs a value is added by the Operator on the page; never ask for it
    in chat.
  - A server found only in one harness's configuration is proposed for the list, by
    the Operator's decision (root decision 0173: an agent refactors, nothing migrates
    automatically).
  - An available server is still not consent to Publication.

## 9. The shell: expired connections

`lazurio.shell.v1` gains an optional member next to `setup`, additive like
`offlineGuide`: `connections: {expired: [{toolkit, name}]}`. It holds every app with an
expired account, describes the current Environment, and is absent when nothing is
expired or nothing is known. It is parsed like `setup`: only in its exact shape (a
toolkit slug and a name), and a document that carries it on a page that belongs to no
Environment is refused. The Launchpad fills it from the same snapshot as the page. The
snapshot is kept for 60 s, because the shell document is read on every page load of
Chat and Automate; its first reading is awaited for a few seconds at most.

The column head shows one line in Chat and Automate, and the setup line of 0188 wins
when both exist. The line reads "Gmail: přihlášení vypršelo", "Gmail a Slack: …" or "3
aplikace: …", with "Přihlásit znovu" leading to `<apps>/connections/<toolkit>` for one
app and to `<apps>/connections` for more. Apps itself shows the count on its
"Připojené aplikace" item instead.

## 10. Settings → Nástroje

The composio row keeps the sign-in, sign-out and organization of F19, and gains the
number of connected apps and a link "Připojené aplikace". On a Team Environment its one
line is "Používej týmové a firemní účty."; the page itself has no Team text. The line
that an Organization's Admin sees the names of connected apps comes with the map's
reporting (M7), not before.

## 11. Read model for the map (DEV-6640; designed, not built)

```json
{ "schema": "lazurio.connections-report.v1", "environment": "<id>", "observedAt": "<ISO>",
  "composio": { "mode": "operator-account", "account": "<label>", "organization": "<label>" },
  "apps": [{ "toolkit": "gmail", "name": "Gmail",
             "accounts": [{ "name": "work", "state": "connected" }] }],
  "mcpServers": [{ "name": "notes", "kind": "command", "state": "ok" }],
  "tools": [{ "name": "gh", "signedIn": true }] }
```

It never holds a token, link, account id, command line, URL path or secret value.
Visibility follows 0162 point 5: an Organization's Environments for its Admin, a
personal Environment for its owner only. Transport (a push by the Launchpad or a read
through the gateway) is DEV-6640's decision.

## 12. Failure modes

| Failure | Behaviour |
| --- | --- |
| composio missing, signed out, or on Windows | One line and "Přihlásit Composio" (F19's dialog); on Windows `unsupported-platform` |
| The CLI fails, times out or prints something unreadable | "Připojené aplikace se nepodařilo načíst." and "Zkusit znovu"; the catalog stays |
| The catalog cache is missing or unreadable | The popular list only |
| The pop-up is blocked | One alert line; the address stays as a plain link |
| A link answer on another host | `unexpected-url`; nothing opens |
| The person never finishes | The session ends after 10 minutes; the pending account stays listed with its line |
| A second account without a name, or a taken name | `name-required`, `name-taken`; the CLI does not run |
| A disconnect without `confirm`, or without `--yes` | `400 confirm-required`; `disconnect-unsupported`; the prompt is never driven |
| The CLI's removal does not take effect | `disconnect-failed`; the account stays listed |
| The same account is signed in on several Environments | One shared set of connections; the disconnect dialog says so |
| `~/.codex/config.toml` does not parse, has a conflicting name, or a hand-edited block | Nothing is written; `consumer-conflict` or `drift` on that server; the list stays |
| `claude` is missing or refuses | That consumer is `absent` or `failed`; it is retried at the next reconciliation |
| Secret custody cannot be written | The add is refused before the Folder changes |
| An MCP server does not start | "Nepodařilo se spustit"; it stays rendered until removed |
| An older Lazurio meets a Folder with `mcpServers` | It refuses the Folder; repair forward (F21) |

## 13. Alternatives considered

| Alternative | Disposition |
| --- | --- |
| Composio's SDK or REST API with the CLI's key | Rejected: Lazurio never reads the operator's key, which reaches every Composio organization and project the person has |
| A local MCP proxy that serves every consumer | Rejected: own machinery in the path of every tool call; the consumers speak MCP already |
| Embedding Composio's dashboard | Rejected: people got lost exactly there, and a second account was the result |
| Lazurio's own record of connections | Rejected: a second truth; Composio owns them and the page reads them live |
| The MCP list in its own file with the values | Rejected: a second state owner beside the Folder, with no revision or recovery |
| `codex mcp add` / `remove` | Not selected: no static header in 0.161, and two writers of one file |
| Header helpers (`http_headers_helper` in Codex, `headersHelper` in Claude Code) calling `lazurio` | Deferred (open question 6): no copy of a header value outside custody, but the consumers then depend on the `lazurio` path |
| A launcher that sets a command's variables | Rejected: one more long-lived process per server and chat |
| Writing `~/.claude.json` or `~/.openmausbot/config.json` directly | Rejected: each has its own writer |
| Driving `connections remove` through a pseudo terminal | Rejected: brittle against a CLI in active development, and it could answer the wrong prompt |
| Paging the catalog on the server | Rejected by the decision of 2026-10-08 |
| Allow lists per agent or bot | Rejected by 0162 point 7 |

## 14. Slices, in this order

1. **This shaping and the red contract.**
2. **Read the connections.** The `/connections` route and the Apps column item; the
   catalog (popular list and cache) and logos; the accounts with their state lines;
   `GET /api/connections`, `GET /api/connections/catalog`.
3. **Connect.** Link sessions and their routes, names, pop-up handling, the deep link
   with the sign-in first, the tour step, and the Folder texts of section 8 for apps,
   with a new template revision.
4. **Disconnect**, gated on `--yes`. It works on an Environment once M3's release
   reaches it.
5. **MCP servers.** The Folder key and change kind, `lazurio mcp`, custody, the Codex
   block and the Claude Code CLI, the probe, the tab, and the MCP texts, with a new
   template revision.
6. **The shell line** (the additive member) and the count in the Apps column.
7. **Settings → Nástroje** (the count, the link, the Team line); `environment-tools.md`
   and `launchpad-development.md` updated; the browser check of root decision 0178 on a
   test Environment; qualification with a real Composio account on the test project.

The read model of section 11 stays a document until M7.

## 15. Test contract

The contract is red by design. Each test is `test.failing`, so `bun run check` stays
green while the behaviour is missing. A test that starts to pass fails the run, and the
implementing slice then removes its `.failing`. `LAZURIO_CONTRACT=show bun test
tests/connections-` runs them as ordinary tests to show why they fail. Their fixtures
are fake `composio`, `claude` and `codex` executables and a fake MCP server on a private
PATH in a temporary home (`tests/fixtures/fake-connections.ts`). Green fixture tests
prove those fakes answer as the documented CLIs do, so a red test fails for the missing
behaviour.

- `tests/connections-routes.test.ts`: the catalog (popular first, every cached app
  once, logos, the key file unreadable and never echoed); the accounts in four states;
  a link returning its URL only to its caller; completion by polling; names required and
  taken; a disconnect refused without `confirm` and without `--yes`, and done with both;
  the deep link as a page route; expired connections in the shell document.
- `tests/connections-mcp.test.ts`: an added server reaches Codex and Claude Code;
  MausBot's file is untouched; the Folder names the server; secrets never reach the
  Folder, an answer or a log; a conflicting name; removal needs a confirmation; the state
  line from a real handshake.
- `tests/connections-folder.test.ts`: the deep link instead of a raw Composio link;
  the MCP rule.
- `tests/connections-shell.test.ts`: the column head's line for expired connections.

## 16. Open questions for Matěj

1. **Disconnect before M3.** Accept that "Odpojit" works only once `composio
   connections remove --yes` is released (upstream or the fork), or install the fork's
   composio on Environments for M4?
2. **A second account without a name.** Require it, as the CLI does (recommended), or
   generate one (`gmail-2`)?
3. **Apps without Composio-managed auth** (most of the 1,596, mainly API-key ones). Show
   them all and let Composio's page collect the key when the CLI answers with a
   dashboard link, or show only apps that connect in one step? A test account decides
   whether the first works at all.
4. **The composio switch "Používají agenti".** Under "one Environment, one set of
   accesses", should it stay switchable while apps are connected?
5. **MCP servers that need their own OAuth sign-in** (no header). Leave them out of M4
   (recommended), or guide a sign-in per consumer?
6. **Copies of a header value.** Start with the value in each consumer's own entry
   (proposed), or use the header helpers of both harnesses so that the value stays only
   in custody?
7. **The probe.** Use the official MCP TypeScript SDK client (a new, exactly pinned
   dependency, recommended) or a minimal handshake of Lazurio's own?
