# Integrace: the apps connected to an Environment

Status: implemented (decision F42, root decision 0162 with its addendum of
2026-10-09, plan DEV-6626 tasks 675, 683 and the Folder part of 681). Whether
Composio is allowed on an Organization's Environment follows the Organization's
settings since decision F45 (root decision 0194, plan DEV-6653 task 693). The
company apps of Google Workspace and Microsoft 365 (task 685) are not part of it;
the seam they plug into is named below.

An **Integrace** is an app or service connected to an Environment. Each has
exactly one **path**: by its own **tool** from Settings → Tools (`gh` for GitHub,
`wacli` for WhatsApp, `gogcli` for Google on a personal Environment, `neon` for
Neon), **directly** through the Environment's Executor, or **through Composio**
with the person's own Composio account. People connect, see and disconnect them
in the Launchpad under Apps → Integrace; agents read the same list with
`lazurio integrations list --json` and use an Integrace where it is connected,
in the order tool → Executor → Composio. Agents never connect one themselves:
the sign-in is the person's consent, so they send the link to its card.

## Where things live

| Part | Where |
| --- | --- |
| The path rule (`choosePath`, ported from the approved wireframe) | `src/integrations/path.ts` |
| Whether Composio is allowed (root decision 0194, F45) | `src/integrations/policy.ts` (the shape), `src/organization-settings/governance.ts` (`composioPolicyOf`) |
| The catalog and its shape | `src/integrations/catalog.json`, `catalog-schema.ts`, `catalog.ts` |
| The catalog's curated input and its build | `scripts/integrations-apps.ts`, `scripts/integrations-catalog.ts` |
| Executor's client and reading | `src/integrations/executor-client.ts`, `executor-source.ts` |
| Composio's CLI as a source and a path | `src/integrations/composio-source.ts` |
| The one list (pure merge) | `src/integrations/model.ts` |
| One reading for the route and the CLI | `src/integrations/read.ts` |
| Connecting and disconnecting | `src/integrations/connect.ts` |
| The routes | `src/launchpad/integrations-routes.ts` |
| The page | `src/launchpad/integrations-view.ts` (pure), `integrations-panel.ts` (DOM) |
| `lazurio integrations list` | `src/integrations/cli.ts` |
| The Folder's texts | `src/folder/render.ts` (`integrationsSection`), `src/folder/manual.ts` |

## The path rule

`choosePath` is the wireframe's rule, with a test for every branch
(`tests/integrations-path.test.ts`):

1. A connected tool made for the app wins; its card offers nothing else.
2. One app, one path: an app already connected keeps its way, přímo before an
   older Composio one. An account left on the other way is marked spare
   ("nepoužívá se") and may be disconnected.
3. Directly where it is just as easy: an official MCP server that registers
   itself (dynamic client registration, a client ID metadata document) or needs
   no sign-in, or a company app the Organization set up. Only where Executor is
   part of the Environment (`Rules.direct`): Lazurio sets it up here (decision
   F44's context: a Remote Environment's operator) and its row in Settings →
   Tools says it is installed. Elsewhere, as on a person's computer until F44's
   second wave or before F44's setup ran, the reading says `absent` and an app
   goes the next way instead of a dead end. An Executor that is part of the
   Environment but down or answering unexpectedly keeps the direct path; the
   page says why it cannot connect now.
4. Through Composio where it is allowed (`composioPolicyOf`, below), after
   signing the person's Composio account in where it is not signed in yet.
5. Without either: an Organization's company app first (its Admin sets it up in
   the Dashboard, anyone else asks the Admin), then Composio not allowed (whoever
   decides allows it, anyone else asks), then the app's own tool, else nothing.

A tool counts as connected when agents use it (required, or switched on in
Settings → Tools), it is installed and its sign-in probe says signed in; `gogcli`
counts only on a personal Environment and the person's own computer. Composio
counts when it is allowed, switched on for agents, installed and signed in.

Whether Composio is allowed is one rule over the Organization settings the Folder
records (`composioPolicyOf(preset, settings)`, decision F45): on an Organization's
Environment whose Organization says `integrations.composio.allowed: false` it is
`{allowed: false, source: "organization"}`, so no app goes through Composio, its
accounts are not asked for, and an app only Composio connects says the company has
it off (its Admin: "Povolit Composio", which opens the Organization in the
Dashboard; anyone else: "Požádat Admina"). Where the Organization says `true` it is
`{allowed: true, source: "organization"}`; where it says nothing, and on a personal
Environment or the person's own computer, `{allowed: true, source: "environment"}`,
as since F18. The page, the rule and the reading read only this; a test may give
its own policy (`IntegrationsHost.policy`). The Organization's company apps arrive
with task 685; the rule takes them as `Rules.companyApps`, empty today.

## Executor API (Executor 1.6.10)

Executor (github.com/UsefulSoftwareCo/executor, MIT) is a required part of every
Environment; Lazurio installs it, runs it as the account's service and registers
it with the agents in a Remote Environment (decision F44, `src/executor/`, plan
DEV-6626 task 684; a workstation is its second wave). The Launchpad talks to it
over the typed HTTP API its own console uses; people never need the console. The
facts below were read from the source of tag `v1.6.10` on 2026-10-09
(`apps/local/src/serve.ts`, `serve-shared.ts`, `auth.ts`,
`packages/core/api/src/**`, `packages/plugins/mcp/src/**`,
`packages/core/sdk/src/**`, `packages/hosts/mcp/src/tool-server.ts`).

### Reaching it

- `executor install` runs the daemon as the account's service on
  `127.0.0.1:4789` (`daemon run --port 4789 --hostname 127.0.0.1`). Other ways
  of starting it default to 4788; the Launchpad asks only 4789.
- Everything under `/api` and `/mcp` needs `Authorization: Bearer <token>`,
  compared in constant time; the token is `{"token": "…"}` in
  `~/.executor/server-control/auth.json` (or `$EXECUTOR_DATA_DIR`), written 0600.
  A refused token is `401` in plain text. Exempt: `GET /api/health` (`ok`), the
  OAuth callback and the client ID metadata documents.
- There is no Host check: the token is the only boundary. So the Launchpad sends
  it only after `lsof` proves that every listener of the port is 127.0.0.1 of
  this account's processes, reads it from an owner-only regular file (one link,
  no group or other bits, no symlink, unchanged while read) for every call, and
  never returns, logs or keeps it.
- The client connects with `node:http` and an agent of its own: Bun's `fetch`
  honours `HTTP_PROXY`/`ALL_PROXY` even for 127.0.0.1 and would hand the token
  to a proxy. No redirect is followed; an answer is bounded in time (15 s, 60 s
  for probes) and size (2 MiB) and must be JSON.
- `/api` is stripped and the rest is Executor's Effect HttpApi: REST groups,
  no version segment, no pagination. Errors are tagged JSON
  (`{"_tag": "ConnectionAlreadyExistsError", …}` with 409, 404, 400; storage and
  defects `{"_tag": "InternalError"}` 500).
- No endpoint tells the running version (`server.json` names it); none lists
  the integrations.sh catalog (the daemon caches it in
  `~/.executor/cache/integrations.json`; the console asks integrations.sh from
  the browser).

### What the Launchpad uses

| Call | Shape |
| --- | --- |
| `GET /api/integrations` | `[{slug, name, description, kind, canRemove, canRefresh, authMethods, displayUrl?}]`; `kind` is the plugin (`mcp`, `openapi`, `graphql`); static namespaces (Executor's own tools) are left out |
| `GET /api/integrations/<slug>` | one of them; `authMethods: [{id, label, kind: oauth\|apikey\|header\|none, template, oauth?: {discoveryUrl?, scopes?, …}}]` |
| `GET /api/connections` | `[{owner: org\|user, name, integration, template, identityLabel, lastHealth: null\|{status, identity?, …}, …}]`; no id: a connection is `(owner, integration, name)`; `status` is `healthy`, `expired`, `misconfigured`, `degraded` or `unknown` |
| `POST /api/connections` | `{owner, name, integration, template}` with exactly one of `value`, `values` or `from`; template `none` with `values: {}`, a header key as `value` |
| `GET /api/connections/<owner>/<integration>/<name>` | one connection, the shape of the list's; read back after creating or signing in again |
| `POST /api/connections/<owner>/<integration>/<name>/refresh` | re-syncs its tools (the array of them); fails when the server does not answer as it should |
| `POST /api/connections/<owner>/<integration>/<name>/health` | Executor's liveness check (for MCP: dial the server, list its tools) → `{status, checkedAt, …}`, kept as the connection's `lastHealth` |
| `DELETE /api/connections/<owner>/<integration>/<name>` | `{removed: true}` |
| `POST /api/mcp/probe` | `{endpoint, headers?}` → `{connected, requiresAuthentication, requiresOAuth, supportsDynamicRegistration, toolCount, …}`; up to about 60 s |
| `POST /api/mcp/servers` | remote `{transport: "remote", name, endpoint, slug?, remoteTransport: "auto", auth: {kind: none\|oauth2\|header, headerName?}}`; command `{transport: "stdio", name, command, args, env?}` → `{slug}`; 409 when the slug exists; a command server gets its `org/default` connection at once, a remote one does not |
| `GET /api/mcp/servers/<slug>` | `{slug, config: {transport, endpoint\|command, args, env?, …}}`; `env` may hold a legacy plaintext environment and is never passed on |
| `DELETE /api/mcp/servers/<slug>` | `{removed: true}`, with the clients registered for it |
| `GET /api/tools?integration=<slug>` | its tools (counted for a custom server) |
| `POST /api/oauth/probe` | `{url}` → `{authorizationUrl, tokenUrl, registrationEndpoint?, resource?, scopesSupported?, issuer?, clientIdMetadataDocumentSupported?, …}` |
| `POST /api/oauth/clients` | a public client of the client ID metadata document `https://executor.sh/api/oauth/client-id-metadata/local.json` (loopback redirect URIs on any port), `clientSecret: ""`; replaces a client of the same `(owner, slug)` |
| `POST /api/oauth/clients/register-dynamic` | RFC 7591 registration, reused when it matches; `redirectUri` `http://localhost:4789/api/oauth/callback`, `clientName` `Lazurio` |
| `POST /api/oauth/start` | `{client, clientOwner, owner, name, integration, template, newConnection?, identityLabel?}` → `{status: "redirect", authorizationUrl, state}` |
| `GET /api/oauth/await/<state>` | a long poll of up to 25 s: `null` (pending) or `{type: "executor:oauth-result", ok, …}`, answered once |
| `POST /api/oauth/cancel` | `{state}` |

Executor's OAuth callback is `http://localhost:4789/api/oauth/callback` on the
Environment. So the person signs in where that address is the Environment's
own: in the Environment browser on a Remote Environment (the Launchpad opens the
authorization URL there with `Target.createTarget` and shows its view in the
right panel) and in their own browser on their computer. A Remote Environment
without the Environment browser cannot finish a direct sign-in, and says so.
Connections are created with owner `org`: the Environment is one boundary.

**Which integration is an app's.** Only a remote MCP server at the catalog's
endpoint (the same scheme, host and path; Executor shows a remote server's
endpoint as `displayUrl`), whatever its slug. A slug is never enough: an
integration that holds an app's slug and points elsewhere, or runs a command, is
another server. It is listed among the custom servers with its real address,
never under the app's card. Connecting the app then neither reuses it nor
replaces it: the connect refuses with `integration-conflict` before anything is
probed, added or connected, and the person removes that server in Vlastní first.
It refuses even where the app's own server is there too under another slug:
agents find Executor's integrations by slug, so the squatter goes first. The catalog keeps one app per integration
slug and per endpoint, so the mapping is never ambiguous. The company apps'
OpenAPI integrations (task 685) will need an identity of their own; until then no
API integration counts as an app's.

**Signing an account without sign-in in again** is a real retry: Executor
re-syncs its tools (`…/refresh`) and checks it (`…/health`), and the Launchpad
reads it back. It answers `connected` only when Executor then reads the account
as working, and otherwise `still-failing`, never a success it did not see. The
same applies when "Připojit" without a name meets the app's existing default
account. A new account is read back after it is created, too.

### Approvals

Executor approves only the calls that go through its tool invocation
(`executor.execute()`): the MCP `execute` tool of `executor mcp` and `POST
/api/executions`, which `executor call` uses. The typed API above, the console's
own, has no approval step.

- A call needs approval when a policy says `require_approval` or the tool is
  annotated `requiresApproval`. MCP tools get it only from an explicit
  `destructiveHint: true` (`readOnlyHint` is ignored; a tool without annotations
  runs at once); an OpenAPI operation with POST, PUT, PATCH or DELETE and a
  GraphQL mutation need it. Executor's management tools (`addServer`,
  `connections.create`, `oauth.start`, the policy tools…) need it too. No policy
  exists by default.
- `executor mcp` runs in the elicitation mode `model` by default. A call that
  needs approval returns at once to the agent as `waiting_for_interaction` with an
  `executionId`; the agent itself resumes it with the MCP tool `resume`
  (`accept`, `decline` or `cancel`). No console and no person's prompt is
  involved, and an MCP client without elicitation support is unaffected.
- `executor call` pauses the same way; `executor resume --execution-id <id>
  --action accept` resumes it (pauses of the two paths are separate).
- So a write never waits for a console approval nobody can give. The approval is
  the agent's, and Lazurio does not change Executor's policy: the Folder tells
  agents to accept such a pause only for a Draft or for a Publication the
  Operator explicitly approved, and to decline it otherwise
  (`manual/working-here.md`, Integrace). Making Executor ask the person instead
  (elicitation mode `browser` or `native`) would be a change of F44's agent
  registration (`src/executor/agents.ts`) and is not made here.

## Composio (`composio` 0.4.x)

Read from the CLI's source (ComposioHQ/composio, `ts/packages/cli`, 2026-10-09):

- `connections list` prints `{<toolkit>: [{status, alias?, word_id?,
  permission_group}]}` on stdout, every status, an alias only where a toolkit has
  several accounts, no ids. Statuses map to four states: `ACTIVE` connected;
  `EXPIRED`, `REVOKED` expired; `INITIATED`, `INITIALIZING` pending; anything else
  failed.
- `link <toolkit> --list` prints `{toolkit, total, items}` with the active accounts,
  their ids and aliases; the Launchpad checks a second account's name against it
  before linking (the CLI asks for one only after it created the link).
- `link <toolkit> --no-wait --no-browser [--alias <name>]` prints `{status:
  "pending", connected_account_id, redirect_url, toolkit}`. The URL must be https
  on `composio.dev`; it is answered only to the request that started the link and
  opened in a window of the person's browser (Composio's page, no callback on the
  Environment). A toolkit without Composio-managed sign-in prints only a URL of
  Composio's dashboard, opened the same way. A link lives ten minutes; the page
  asks every two seconds whether its account is active.
- `connections remove <selector>` asks for a confirmation and, without a terminal,
  removes nothing; it has no `--yes` (0.4.3-beta). The Launchpad removes only when
  `connections remove --help` offers `--yes` and never answers the prompt for the
  person; otherwise it answers `disconnect-unsupported` and the page sends the
  person to Composio. Composio's accounts belong to the Composio account and its
  organization, so disconnecting reaches every Environment signed in the same way.

Every process gets only `PATH`, `HOME`, the XDG base directories and `NO_COLOR`,
runs in its own process group and is bounded (15 s); its raw output is never
returned or logged.

## The reading: `GET /api/integrations` and `lazurio integrations list`

Both answer the same document (`IntegrationsOverview`, `src/integrations/model.ts`):
the Folder's language and scope, the Integrace page address where a browser
reaches the Launchpad (`page`, null on a workstation), Composio's policy and
readiness, each source's state (`ok`, `unavailable`, `absent` for an Environment
without Executor, `unreadable`, `signed-out`, `not-allowed`), the tools for one app that are connected, every catalog app with
its path, `connected`, its accounts (path, the selector that disconnects it, its
name, state, spare) and its card link (`<origin>/integrations/app/<id>`, which
lists and focuses that card even where nothing connects the app here), the
accounts of Composio toolkits the catalog does not know, and the custom MCP
servers (address without userinfo or query, which may carry a key; a command
server's line is not shown). A source that cannot be read is said so and never
taken for "nothing connected"; only a Folder that cannot be read fails the route
(500). The tools' sign-in probes and Composio reach the network, so the Launchpad
keeps its last reading for a minute and reads again on "Zkontrolovat připojení"
(`?refresh=1`) and after every change.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/integrations[?refresh=1]` | | the reading |
| `POST /api/integrations/connect` | `{app, name?, account?}` | `{kind: "authorize", session, url}` (a window of this browser), `{kind: "authorize", session, view}` (the Environment browser's tab), `{kind: "connected", app}`, or `409 {kind: "blocked", reason}`: `app-unknown`, `path-unavailable`, `composio-signed-out`, `name-required`, `name-taken`, `account-unknown`, `executor-unavailable`, `browser-unavailable`, `integration-conflict` (Executor holds the app's slug for another server), `still-failing` (Executor cannot use the account, read back after the attempt), `connect-failed` |
| `POST /api/integrations/poll` | `{session}` | `pending`, `{kind: "connected", app}` or `{kind: "ended", reason: failed\|expired\|cancelled}`; 404 for an unknown session |
| `POST /api/integrations/cancel` | `{session}` | `{kind: "cancelled"}`; an OAuth flow is cancelled in Executor too |
| `POST /api/integrations/disconnect` | `{app, path, account, confirm: true}` | `{kind: "disconnected"}`, `400 confirm-required` without `confirm: true`, or blocked `account-unknown`, `disconnect-unsupported`, `executor-unavailable`, `disconnect-failed` |
| `POST /api/integrations/custom/add` | `{name, kind: url\|command, target, secretName?, secretValue?}` | like connect; a remote server that needs OAuth starts its sign-in |
| `POST /api/integrations/custom/remove` | `{id, confirm: true}` | `{kind: "removed"}`; a catalog app's integration is never removed as custom |

All behind the admission of every route (the local token and same origin, or the
gateway's session); writes are POST with JSON bodies of exact keys, at most 16 KiB.
A connect takes the app's path from the reading, never from the page. A key
(`secretValue`) goes only to Executor (the remote server's header, or the
command's variable), never back, never logged or journaled. The journal says
`{scope: "integrations", event, app, outcome, reason?}` and nothing else.

## The catalog

`src/integrations/catalog.json` (`lazurio.integrations-catalog.v1`) lists the apps
Lazurio offers, in the order of their use: 67 on 2026-10-09, 32 of them in one
click directly (31 by dynamic client registration, DeepWiki without sign-in), 6
whose official server needs the company's own app, 9 through the company app of
Google Workspace or Microsoft 365, 19 only through Composio, and WhatsApp only by
`wacli`. Every entry has its id (Composio's toolkit slug where that is a plain
name, the deep link's segment), names and one sentence in Czech and English, its
category, Composio's toolkit, the direct path (Executor's integration slug, the
MCP endpoint, how it signs in and when the probe verified it), its tool and the
date it was built. Executor's catalog is partly AI-generated, so a direct path is
written only where the probe of the official endpoint verified it; a company
app's API path only from Executor's own curated specs.

### Refreshing it (maintainers)

1. Take the two public catalogs as they are cached on any Environment with both
   tools: `~/.composio/toolkits.json` (written by the Composio CLI when it fetches
   the catalog) and `~/.executor/cache/integrations.json` (Executor's copy of
   `https://integrations.sh/api.json`). Neither holds a secret.
2. Unpack simple-icons at the version of the last build:
   `npm pack simple-icons@16.34.0` and `tar xzf simple-icons-16.34.0.tgz`.
3. Add, change or remove apps in `scripts/integrations-apps.ts` (names, one
   sentence in both languages, category, Composio's toolkit, Executor's entry,
   the company app, the tool, the simple-icons slug).
4. Run, from the repository:
   `bun scripts/integrations-catalog.ts --composio <toolkits.json> --executor
   <integrations.json> --icons <package directory>`. It probes every official
   MCP endpoint (one MCP `initialize` without credentials, then the public OAuth
   metadata: dynamic client registration, a client ID metadata document, or an app
   to register), reports what it found on stderr and writes the catalog; a new
   version only when an entry changed beyond its dates. An entry that a catalog no
   longer backs fails the build: change the curation, never the output.
5. Review the diff (especially direct paths that appear or disappear), run
   `bun run check` and publish it by a pull request.

### Icons

The page asks no third party for a logo. An entry's icon is the SVG path and
colour of [simple-icons](https://simpleicons.org) (CC0-1.0, the version in its
`source`), bundled into the catalog; an icon simple-icons marks with a license of
its own is never taken, and an app without one shows its first letter. Brand
names and logos belong to their owners and only identify the app
([licensing](licensing.md)).

## The Folder

AGENTS.md has a section Integrace after Tools: what an Integrace is, its three
paths, `lazurio integrations list --json`, the order tool → Executor → Composio,
never connecting one (the card's link where the Launchpad has an address, the page
named on a workstation), and a custom MCP server only on the person's explicit
instruction and always into Executor. `manual/working-here.md` has the chapter
Integrace (with Executor's approvals and the IT consent of company apps),
`manual/this-machine.md` points from its tools to it, and the Launchpad routing of
hosted Environments names the Integrace page instead of Composio's procedure. The
texts it retires: `composio link` for agents, "send the link the command returns",
"no cloud connector other than Composio", MCP servers set up per harness
(`claude mcp add`, `~/.codex/config.toml`). Template revision `base-instructions-39`.
