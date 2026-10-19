# Integrace: the apps connected to an Environment

Status: implemented (decision F42 with its addenda of 2026-10-11 to 2026-10-14, root
decision 0162 with its addendum of 2026-10-09, plan DEV-6626 tasks 675, 683 and the
Folder part of 681). Lazurio installs its own build of Composio's CLI (F42, addendum
(3) of 2026-10-13: [Lazurio's build](#lazurios-build-of-the-cli)). Whether
Composio is allowed on an Organization's Environment follows the Organization's
settings since decision F45 (root decision 0194, plan DEV-6653 task 693). The
Organization's Microsoft 365 company app (task 685) connects Outlook, OneDrive and
SharePoint directly since F42's addendum (c) of 2026-10-14
([below](#the-microsoft-365-company-app)); Google Workspace's company app is not part
of it yet.

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
| Lazurio's build of Composio's CLI (the pin), its installation and update | `src/tools/composio-build.ts`, `src/tools/install.ts`, `src/tools/update.ts` |
| The one list (pure merge) | `src/integrations/model.ts` |
| One reading for the route and the CLI | `src/integrations/read.ts` |
| Connecting and disconnecting; adding, reading and editing a custom MCP server | `src/integrations/connect.ts` |
| A custom MCP server's rules and Executor's shapes of it (shared by the page and the server) | `src/integrations/custom-server.ts` |
| The Microsoft 365 company app: its pinned specs and scopes, its card, building its one document and applying it to Executor | `src/integrations/microsoft365.ts`, `microsoft365-card.ts`, `microsoft365-executor.ts` |
| The routes | `src/launchpad/integrations-routes.ts` |
| The page | `src/launchpad/integrations-view.ts` and `custom-server-form.ts` (pure), `integrations-panel.ts` (DOM) |
| `lazurio integrations list` | `src/integrations/cli.ts` |
| The Folder's texts | `src/folder/render.ts` (`integrationsSection`), `src/folder/manual.ts` |

## The path rule

`choosePath` is the wireframe's rule, with a test for every branch
(`tests/integrations-path.test.ts`):

1. A connected tool made for the app wins; its card offers nothing else. An
   account of the app left directly or through Composio is spare beside it, as
   in point 2 (until 2026-10-19 such an account was drawn as if it were used).
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
5. Without either: an Organization's company app
   first (its Admin sets it up in the Dashboard, anyone else asks the Admin), then
   Composio not allowed (whoever decides allows it, anyone else asks), then the
   app's own tool, else nothing.

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
its own policy (`IntegrationsHost.policy`). The Organization's company app is
`Rules.companyApps`: `microsoft` on every Environment of an Organization whose
Microsoft 365 setting the Folder records (`microsoft365Here`), where its one card
"Microsoft 365" takes the place of Outlook's, OneDrive's and SharePoint's.

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
| `POST /api/connections` | `{owner, name, integration, template}` with exactly one of `value`, `values` or `from`; template `none` with `values: {}`, a custom server's keys as `values` by input; an account's values are only ever given here: `PATCH` changes its label and description, no call returns them |
| `GET /api/connections/<owner>/<integration>/<name>` | one connection, the shape of the list's; read back after creating or signing in again |
| `POST /api/connections/<owner>/<integration>/<name>/refresh` | re-syncs its tools (the array of them); fails when the server does not answer as it should |
| `POST /api/connections/<owner>/<integration>/<name>/health` | Executor's liveness check (for MCP: dial the server, list its tools) → `{status, checkedAt, …}`, kept as the connection's `lastHealth` |
| `DELETE /api/connections/<owner>/<integration>/<name>` | `{removed: true}` |
| `POST /api/mcp/probe` | `{endpoint, headers?}` → `{connected, requiresAuthentication, requiresOAuth, supportsDynamicRegistration, toolCount, …}`; up to about 60 s |
| `POST /api/mcp/servers` | remote `{transport: "remote", name, endpoint, slug?, remoteTransport: "auto"}` with `auth: {kind: none\|oauth2}` or `authenticationTemplate: [{slug: "apikey", type: "apiKey", headers: {Authorization: ["Bearer ", {type: "variable", name: "token"}], <header>: [{type: "variable", name: "header-<header>"}]}}]` (the request-shaped dialect, stored as canonical placements); command `{transport: "stdio", name, command, args, cwd?, env?}`, `env` one-shot values that become the account's (a `stdio_env` method names them) → `{slug}`; the slug is the name in lower case with `_` for anything else; 409 when the slug exists; a command server gets its `org/default` connection at once, a remote one does not |
| `GET /api/mcp/servers/<slug>` | `{slug, config: {transport, endpoint\|command, args?, cwd?, env?, headers?, authenticationTemplate, …}}` or `null`; `env` and `headers` are a static environment and static headers set elsewhere, never shown or passed on; `authenticationTemplate` names the keys (placements, `stdio_env` vars), never a value |
| `POST /api/mcp/servers/<slug>/config` | `{config}` replaces the whole config (canonical shape); the tools are synced again on their next read; the connections stay |
| `PATCH /api/integrations/<slug>` | `{name}` renames it; the slug stays |
| `DELETE /api/mcp/servers/<slug>` | `{removed: true}`, with the clients registered for it |
| `GET /api/tools?integration=<slug>` | its tools (counted for a custom server) |
| `POST /api/oauth/probe` | `{url}` → `{authorizationUrl, tokenUrl, registrationEndpoint?, resource?, scopesSupported?, issuer?, clientIdMetadataDocumentSupported?, …}` |
| `POST /api/oauth/clients` | a public client of the client ID metadata document `https://executor.sh/api/oauth/client-id-metadata/local.json` (loopback redirect URIs on any port), `clientSecret: ""`; the company app's manual client `microsoft365` (`clientId` the setting's `client_id`, `clientSecret: ""`: a public client); replaces a client of the same `(owner, slug)` |
| `POST /api/oauth/clients/register-dynamic` | RFC 7591 registration, reused when it matches the exact `redirectUri`: the Launchpad's `<entry>/api/integrations/oauth/callback` on a Remote Environment, else (or after the server refused it, 400) `http://localhost:4789/api/oauth/callback`; `clientName` `Lazurio` |
| `POST /api/openapi/specs` | `{spec: {kind: "blob", value} \| {kind: "url", url}, slug, name, description, authenticationTemplate: [{slug, kind: "oauth2", authorizationUrl, tokenUrl, resource, scopes}]}` → `{slug, toolCount}`; 409 when the slug exists; Executor parses a JSON spec of at most 32 MiB and compiles it (the company app's merged document is about 12.6 MiB) |
| `GET /api/openapi/integrations/<slug>/config` | `{specUrl?, authenticationTemplate}` of an OpenAPI integration (never the spec), or `null` |
| `POST /api/openapi/integrations/<slug>/spec` | `{spec: {kind: "blob", value}}` replaces the spec in place; connections stay |
| `POST /api/openapi/integrations/<slug>/config` | `{authenticationTemplate, mode: "replace"}` replaces its auth template |
| `GET /api/oauth/clients` | the clients, `[{owner, slug, grant, authorizationUrl, tokenUrl, clientId, origin: {kind}}]`, never a secret |
| `POST /api/oauth/start` | `{client, clientOwner, owner, name, integration, template, newConnection?, identityLabel?, redirectUri?}` → `{status: "redirect", authorizationUrl, state}`; `redirectUri` the address the client was registered with, Executor's own callback without it |
| `GET /api/oauth/callback?state=…&code=…` | Executor's own callback (`error`, `error_description`, `domain`, `site` too): exchanges the code, syncs the tools in the background, tells the long poll and answers its popup page, on a failure too |
| `GET /api/oauth/await/<state>` | a long poll of up to 25 s: `null` (pending) or `{type: "executor:oauth-result", ok, …}`, answered once |
| `POST /api/oauth/cancel` | `{state}` |

Executor's OAuth callback is `http://localhost:4789/api/oauth/callback` on the
Environment, reachable only from a browser there. So on a Remote Environment the
Launchpad registers the client for its own address instead,
`<entry>/api/integrations/oauth/callback` (decision F42, addendum of 2026-10-13):
the person signs in in a window of their own browser, the server returns it to the
Launchpad through the gateway (whose session cookie is `SameSite=Lax`, sent on that
top-level navigation), and the Launchpad hands the return to Executor's callback.
A server that refuses that address (some register only loopback addresses, RFC
8252) or offers only a client ID metadata document (whose addresses are loopback)
returns to Executor's callback on localhost, so the person signs in where that
address is the Environment's own: in the Environment browser on a Remote
Environment (the Launchpad opens the authorization URL there and shows its view in
the right panel) and in their own browser on their computer. A Remote Environment
without the Environment browser cannot finish such a sign-in, and says so.
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
slug and per endpoint, so the mapping is never ambiguous. The company app's one
OpenAPI integration (`m365`, [below](#the-microsoft-365-company-app)) is its card's
by its slug and only as an OpenAPI integration; another kind under that slug is
never reused (`integration-conflict`). No other API integration counts as an
app's.

**Signing an account without sign-in in again** is a real retry: Executor
re-syncs its tools (`…/refresh`) and checks it (`…/health`), and the Launchpad
reads it back. It answers `connected` only when Executor then reads the account
as working, and otherwise `still-failing`, never a success it did not see. The
same applies when "Připojit" without a name meets the app's existing default
account. A new account is read back after it is created, too.

**An account's state** is Executor's last verdict (`lastHealth.status`): none,
`healthy` and `unknown` read as connected, `expired` as expired, and
`misconfigured` and `degraded` as failing (a custom server "Nepodařilo se
spustit"). `degraded` says that Executor's last check reached no working server
for a reason other than the credential. Executor 1.6.10 adds a server it cannot
reach all the same and stamps its connection `degraded` with `reason:
tool_sync_failed`; a later check (`…/health`) replaces that with its own
verdict, such as `probe_failed`. The Launchpad therefore reads the status and
never the reason (#322).

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

## Custom MCP servers (Vlastní)

Apps → Integrace → Vlastní lists the custom MCP servers in Executor and adds them as
Codex Desktop's "Connect to a custom MCP" does (decision F42, addendum of
2026-10-11, which maps every field onto Executor 1.6.10 and names the two Codex
fields left out). "Přidat MCP server" opens `/integrations/custom/new`, a server's
name `/integrations/custom/server/<slug>`, the same page filled in. Agents add one
only on the person's explicit instruction and only without keys (the prepared prompt
of Settings → Tools); a key is entered on this page, by the person. The page explains
none of what follows in text of its own, as Codex's does not: this section is where
it is said.

- **STDIO**: Název, Příkaz ke spuštění (as typed, never split), Argumenty (one row
  each), Proměnné prostředí (key and value), Pracovní složka (absolute or `~/…`,
  resolved against the account's home). Executor spawns the command without a shell;
  the command gets the MCP SDK's safe list of the daemon's variables and the proxy and
  CA variables, nothing else, so there is no passthrough.
- **Streamable HTTP**: Název, URL (https, or http to `localhost`, `127.x.x.x` or
  `[::1]`), Bearer token (the token itself, masked), Hlavičky (key and value).
  Executor resolves no header from its environment, so there are no headers from
  environment variables. Without keys the address is probed and a server that needs
  a sign-in starts it; with keys it is probed with them.
- **Keys.** Every value of an environment variable, the Bearer token and every header
  value is a key: it goes only to this Environment's Executor, as the values of the
  server's one account (`org/default`), the Bearer token as `Authorization: Bearer
  <token>` and each header as an input of its own (`header-<name>`), and it is never
  shown again. The page sends it once and keeps no copy; no answer, journal line or
  Folder file carries it; an edited server's key fields open empty, marked
  "Uloženo". Executor's config of the server names the keys only; Lazurio sets no
  static header or static environment, which Executor's API and its agents'
  `getServer` tool would return as they are.
- **Editing.** The name is changed in place and the slug stays; the command, the
  arguments, the working directory or the address replace the config
  (`POST /api/mcp/servers/<slug>/config`, everything the page does not show carried
  through); the type stays. A stored key's field opens empty in the state
  "Uloženo": left empty, it keeps the stored value. Executor keeps an account's
  values together and never returns or patches one of them, so an account cannot be
  changed key by key: while no key changes the account stays, and once one does (a
  new value, a key added or removed, the Bearer token added or removed) the account
  is created anew with every key. Then every stored key's field turns to
  "Zadejte znovu" and Save waits until each is typed again. The page says this only
  through those two states; there is no line or note explaining it. An address left
  as shown keeps the stored one with its query; a new address is a change of the keys
  for a server that has any, since it is probed and reached with them, so its stored
  keys turn to "Zadejte znovu" too (a server without keys just moves).
- **Checked twice.** The page and the server share the rules
  (`src/integrations/custom-server.ts`): what the page refuses as the person types, the
  route refuses before Executor is asked.

## Composio (`composio` 0.4.x)

Read from the CLI's source (ComposioHQ/composio, `ts/packages/cli`, 2026-10-09). The
Environment runs Lazurio's build of it, which differs in two commands
([below](#lazurios-build-of-the-cli)); what follows holds for both where it does not
say otherwise.

- `connections list` prints `{<toolkit>: [{status, alias?, word_id?,
  permission_group}]}` on stdout, every status, an alias only where a toolkit has
  several accounts, no ids. Lazurio's build prints on every entry its `id` too, its
  `alias` wherever it has one and `display_name` where Composio knows the provider's
  identity. Statuses map to four states: `ACTIVE` connected;
  `EXPIRED`, `REVOKED` expired; `INITIATED`, `INITIALIZING` pending; anything else
  failed. Only a connected account connects its app: one whose sign-in expired or
  failed is listed with its state, and the app is not connected. A pending
  account is a sign-in: `link --no-wait` creates it at once, and one that is
  never finished stays pending in Composio, which its dashboard does not show. The
  reading lists a pending account only where a sign-in started in this Launchpad
  that still waits may be it (`pendingOfSignIns`): each sign-in keeps the word ids
  of its toolkit's pending accounts read just before its link, and an account
  belongs to the sign-in after whose start and before the next one's it appeared
  (ended and cancelled sign-ins count while their sessions are kept). One sign-in
  of a toolkit starts at a time, its snapshot, link and session in that order, so
  the sessions keep the links' order. None is listed where those word ids could
  not be read. The Launchpad reads again when a sign-in starts, ends or is
  cancelled.
- `link <toolkit> --list` prints `{toolkit, total, items}` with the active accounts,
  their ids, word ids and aliases (an alias of `null` where the account has none);
  the Launchpad checks a second account's name against it before linking (the CLI
  asks for one only after it created the link), and the reading takes a single
  account's name from it (see [Account names](#account-names-and-composios-dashboard)).
- `whoami` prints `{account_type, email, current_org_name, …}`: the sign-in probe
  of Settings → Tools reads the account and its current organization, and the
  reading uses that organization for the link to Composio's dashboard.
- `link <toolkit> --no-wait --no-browser [--alias <name>]` prints `{status:
  "pending", connected_account_id, redirect_url, toolkit}`. The URL must be https
  on `composio.dev`; it is answered only to the request that started the link and
  opened in a window of the person's browser (Composio's page, no callback on the
  Environment). A toolkit without Composio-managed sign-in prints only a URL of
  Composio's dashboard, opened the same way. A link lives ten minutes; the page
  asks every two seconds whether its account is active.
- `connections remove <selector>` asks for a confirmation and, without a terminal,
  removes nothing; Composio's own CLI has no `--yes` (0.4.2 and 0.4.3, and `next` on
  2026-10-12; proposed upstream in ComposioHQ/composio#4817), Lazurio's build has it
  (and `-y`). The Launchpad removes only when `connections remove --help` offers
  `--yes` and never answers the prompt for the person. The reading says whether it
  does (`composio.disconnect`, read with the accounts), and only then the page offers
  "Odpojit" for a Composio account; the route still answers `disconnect-unsupported`
  to a request without it. The selector is the account's id where the list gives one
  (Lazurio's build), else its word id. Composio's accounts belong to the Composio
  account and its organization, so disconnecting reaches every Environment signed in
  the same way.

- `orgs list` prints `[{id, name, is_selected_global_org}]` (the JSON array on
  stdout, after the CLI's own lines), and `orgs switch --org-id <id>` makes one
  organization current. The CLI has no command that creates one, and Composio's
  API documents only `GET /api/v3.1/org/list`.

Every process gets only `PATH`, `HOME`, the XDG base directories and `NO_COLOR`,
runs in its own process group and is bounded (15 s); its raw output is never
returned or logged.

### Lazurio's build of the CLI

Decision F42, addendum (3) of 2026-10-13 (the Operator's decision). Composio's stable
CLI cannot remove an account without a prompt and names no account but by an alias,
so Lazurio installs its own build until a stable release of Composio's has both
changes (proposed upstream in ComposioHQ/composio#4817, issue #4816, and #4809).

- **The build.** Composio's stable 0.4.3 with exactly two changes, the GitHub release
  `@composio/cli@0.4.3-lazurio.1` of the fork Lazurio/composio (assets
  `composio-<target>.zip` and `checksums.txt`, as Composio's); `composio --version`
  prints `0.4.3-lazurio.1`. `connections remove <account> --yes` (and `-y`) removes
  without a prompt; `connections list` prints on every entry its `id` (`ca_…`), its
  `alias` wherever it has one (a toolkit's only account too; `alias: null` may stand
  for none) and, where Composio knows the provider's identity, `display_name`
  (trimmed, at most 200 characters), for example `{"gmail":[{"id":"ca_example123",
  "status":"ACTIVE","alias":"work","word_id":"castle","display_name":
  "ada@example.com","permission_group":null}]}`. Its `composio upgrade`, update
  check, skill installation and companion self-repair default to the fork's releases.
- **The pin** is one constant, `composioBuild` (`src/tools/composio-build.ts`): the
  fork, the version and its tag, and the commit of the fork's installer
  (`installerCommit`). The tag and the commit come from the same release of the fork
  and change together, in one reviewed change; the constant goes, and the recipe
  returns to Composio's installer and latest stable release, once Composio's own
  stable CLI has both changes.
- **Installation** (`lazurio tools install composio`, Settings → Tools): Composio's
  installer from Lazurio's fork, pinned by commit
  (`https://raw.githubusercontent.com/Lazurio/composio/<installerCommit>/install.sh`;
  pinned by commit, the URL is immutable), downloaded into a private file first and
  run with `COMPOSIO_INSTALL_PLUGINS=0`,
  `COMPOSIO_INSTALL_SHELL=none`, `COMPOSIO_INSTALL_HELP=0`,
  `COMPOSIO_GITHUB_OWNER=Lazurio`, `COMPOSIO_GITHUB_REPO=composio` and
  `COMPOSIO_INSTALL_VERSION=@composio/cli@0.4.3-lazurio.1`. It downloads the release's
  archive for the platform, checks it against the release's `checksums.txt`, publishes
  the bundle into `~/.composio` beside the files already there and links
  `~/.local/bin/composio`. The installer served at `https://composio.dev/install`
  cannot install the build: it accepts an explicit version only as `X.Y.Z` or
  `X.Y.Z-beta.N` (`normalize_version`) and "latest" only among plain
  `@composio/cli@X.Y.Z` tags. The fork's `install.sh` is Composio's with that one
  check widened to accept `X.Y.Z-lazurio.N`, a source of `Lazurio/composio` strict
  (no `checksums.txt`, no entry or no SHA-256 tool is an error) and
  `COMPOSIO_INSTALL_SHA256`; everything else is Composio's installer. The Launchpad
  passes the SHA-256 of the archive the installer downloads (`composioBuild.archives`;
  on macOS an x64 process that Rosetta 2 translates gets the arm64 one, as the
  installer's `detect_target` chooses), so the
  installer refuses any other archive before it extracts or replaces anything: a
  refused installation or update changes nothing. The installation is done only when
  `composio --version` then prints exactly `0.4.3-lazurio.1`. Were another version to
  run after an installer that ignored the pins, it would fail at `verify`
  (`version-mismatch`), and what runs would stay.
- **Update** (`lazurio tools update composio`; "Aktualizovat" / "Update" in Settings →
  Tools): the same installation again, whatever runs now (Composio's stable CLI, an
  older build, a newer release of Composio's), in place: the bundle in `~/.composio`
  replaced, the sign-in (`~/.composio/user_data.json`) and the link kept. Never beside
  a composio elsewhere on PATH (`preflight`, `installation-elsewhere`), never without
  the person's request (decision 0161): no rollout, `lazurio update` or Launchpad start
  runs it. The tools reading carries the pin (`pinned`); a composio that is not the
  build says so in its Details and its row offers "Update" where the update can work.
  Not `composio upgrade`: it takes the highest non-prerelease release by semver, so
  from the build it moves to newer builds of the fork rather than the pinned one, from
  Composio's CLI it reaches the fork only with `GITHUB_*` overrides, and it also
  installs the CLI's skill for Claude Code, which the installation keeps out.
- **The same update from Integrace** (decision F42, addendum (b) of 2026-10-14). Where
  Composio is on here (allowed, installed, signed in, on for agents) and its row in
  Settings → Tools offers "Update" (`pinnedUpdateOffered`, `src/tools/pin.ts`, one
  rule for both pages), the reading's `composio.update` is true and Apps → Integrace
  shows one line above the apps on Vše and Připojené: "Aktualizujte Composio, ať tu
  můžete účty odpojovat a vidět jejich jména." ("Update Composio to disconnect
  accounts here and see their names.") with "Aktualizovat" ("Update"). The click is
  the consent and posts `/api/tools/upgrade` (`{tool: "composio"}`), the same route
  and core as Settings → Tools. From the click until the reading after a finished
  update the line says "Aktualizuji Composio…" with a spinner and its button waits;
  then the page reads again (`?refresh=1`), the line goes, and "Composio je
  aktualizované." stands under the tabs. Any other answer says "Aktualizace nedoběhla.
  Zkuste to znovu." in the line, and its button tries again. Where Composio is off,
  not installed, signed out, elsewhere on PATH or already the build, there is no line;
  the cards and the other notices already say what is missing. `lazurio integrations
  list` says in one line that the person updates Composio in Settings → Tools, and
  that an agent does not do it unless the person asks (decision 0161, F17).
- **Integrace** reads the richer list: names and removal by id
  ([Account names](#account-names-and-composios-dashboard)), and "Odpojit" appears by
  itself, since the build has `--yes`.

### The Composio organization of an Environment

Decision F42, addendum of 2026-10-13 and its note of 2026-10-17. Each person has one
Composio account. In it they have one organization of their own for each Lazurio
Organization, named as the Organization is, with nobody else in it, and the default
one Composio made when they signed up.

How the person's account maps to Environments (what the figure of the sign-in
dialog and Apps → Integrace drew until 2026-10-17; the screens now show only the
step left to do):

| In the person's Composio account | Used by |
| --- | --- |
| `ExampleCompany`, the Organization "Example Company" named as Composio accepts it | that Organization's Environments |
| one organization for each other Organization, named as it is | that Organization's Environments |
| the default organization (`<login>_workspace`, made at the sign-up) | the person's personal Environment |

Nobody else is invited to these organizations and no key is shared: the person
signs in to Composio with their own account, and Lazurio switches the CLI to the
right organization.

- **The rule** (`composioOrganizationRule`): an Environment whose Machine binding
  names an owning Organization works in the organization of that Organization's
  display name (`organization.display_name` of its manifest, as the Folder's
  catalog reads it); `unverified` where that name cannot be read, never the
  person's choice. The owning Organization is the one Organization settings
  select (F45, `selectCatalogOrganization` with the binding's owner): its
  manifest slug compared whatever the case, else its directory name. Machines
  hands the owner over in lower case (`example`) while a manifest keeps its
  capitals (`Example`). A GitHub login alone selects nothing, so Composio and
  the Organization's settings, which say whether Composio is allowed, never
  disagree on the owner. Missing or ambiguous is `unverified` (fixed on
  2026-10-13 after rc.65, whose exact comparison left every Environment of an
  Organization with capitals in its slug `unverified`). Any other Environment, a personal one or a computer, works in
  the organization the person chose; by advice (this page) a personal
  Environment's is the default one, and the sign-in dialog offers the choice where
  the account has several. A name matches by its letters and digits alone
  (`organizationKey`, note of 2026-10-17, evening): its case, diacritics,
  spaces, punctuation and underscores do not count, so every name Composio
  allows for the Organization matches it ("Human and Machine",
  `HumanAndMachine`, `human_and_machine` and `humanandmachine` are one name).
  The person creates it as Composio accepts names, only letters, digits and
  underscores, starting with a letter: the display name's words in CamelCase
  without diacritics (`composioOrganizationName`: "Lazurio Example
  Organization" is `LazurioExampleOrganization`), with `Org` before one that
  would start with a digit, which is then compared in that form too. A
  display name that gives no such name is `unverified`.
- **The verdict** (`composioOrganizationVerdict`), over `orgs list`: `matches`
  where the one organization of that name is current; `elsewhere` where it
  exists and another is current; `missing` where the account has none;
  `ambiguous` where it has more than one, and none is guessed.
- **Brought current** (`convergeComposioOrganization`): the reading (only where
  Composio is installed, signed in, on and allowed), and the sign-in dialog of
  Settings → Tools after a sign-in, make an `elsewhere` organization current
  with `orgs switch`, journaled as `composio-organization` with its outcome and
  nothing else (`lazurio integrations list` writes the line on stderr). Every
  link and every removal asks it live first (`inOwnOrganization`), never the
  cached reading: it switches back where another organization was chosen, goes
  to the current one where the account has none of the name or several, and
  refuses with `composio-organization` where the organization cannot be told. A
  person's choice is never changed.
- **Missing or there more than once** (the Operator's decision of 2026-10-13):
  Composio works in the person's current organization, its accounts count and
  links and removals go there; Apps → Integrace says what to do with a link to
  Composio's dashboard, and `lazurio integrations list` tells agents. The next
  reading after the person created it makes it current.
- **Where its organization cannot be told** (`unverified`, or an `elsewhere`
  organization that could not be made current), the Composio source reads
  `organization`: none of its accounts is listed, and a link or a removal is
  refused (`409 composio-organization`) with nothing written. The reading's
  `composio.organization` is `{name, state}` on an Organization's Environment
  (the name null where it is `unverified`), null elsewhere.
- **Creating one** is the person's, in Composio's dashboard: neither its CLI nor
  its documented API creates or renames an organization (the API lists them, the
  CLI lists and switches). On Apps → Integrace, "Zkontrolovat připojení" finds it
  by name afterwards.
- **The sign-in dialog** of Settings → Tools (note of 2026-10-17) shows, after the
  sign-in, only what is left: where the organization is missing, the
  Organization's name as Composio accepts it with "Kopírovat", a drawing of the
  path in Composio's dashboard ("FOR YOU", the organization card at the bottom of
  the sidebar, "Create Org", then the page it opens, where the name is typed into
  "Organization name" and "Create organization" clicked; `composioScreen` in
  `src/launchpad/composio-scene.ts` holds Composio's labels, matched to the
  Organization Admin's screenshots) and "Otevřít Composio" to the dashboard's
  root; where there are two of the name, rename the extra one. Apps → Integrace
  and `lazurio integrations list` name the organization in the same form. It
  reads the organizations again by itself (after 4 s, growing to every 30 s,
  paused while the page is hidden and at once when it shows again) until it is
  connected, then says "Composio je připojené" with the account and the
  organization current after the switch, and "Vybrat aplikace" to Apps → Integrace.

### Account names and Composio's dashboard

Decision F42, addenda of 2026-10-11 (#312) and (3) of 2026-10-13. An account's
**label** is its name: Composio's alias, else the provider's identity Lazurio's build
of the CLI prints (`display_name`: a mail address, a login), or the name Executor
gives a direct account (the name given when connecting, or the account the provider
names). Without one the page says "účet" ("account"); a word id is a selector, never
shown as a name.

- Lazurio's build prints every account's alias and its id: where every entry of
  `connections list` carries an id, the list names every account and no lookup
  below runs. An id is taken only as a plain selector (`^[A-Za-z0-9_-]{1,128}$`) and
  any other refuses the list, as an alias that is not a plain label does; a
  `display_name` is taken only as trimmed plain text of at most 200 characters
  without control or bidirectional characters, and any other is left out without
  refusing the list.
- Composio's own `connections list` leaves out the alias of a toolkit's only
  account. Where that account is active and has no alias there, the reading asks
  `link <toolkit> --list` (`nameComposioAccounts`): once per such toolkit and for no other, at
  most two at a time for all readings of the Launchpad together (each `composio`
  process takes about 200 MB), each call started only within one Composio budget
  (15 s) and bounded by it, so naming adds at most two budgets to a reading and
  nothing where no account needs it.
- The Launchpad keeps a name it read for half an hour by toolkit and word id
  (`createComposioNames`, `composioNamesFreshMs`), beyond the reading's minute, so
  a page opened again runs no `link --list` once the names are known.
  "Zkontrolovat připojení" (`?refresh=1`) reads every name again, by a reading
  of its own that never adopts an older reading or lookup still running;
  connecting, signing in again or disconnecting an account of a toolkit here
  reads that toolkit's again. A lookup that was running when its names were
  forgotten keeps nothing (`ComposioNames.since`: an answer is kept only while
  the generations of forgetting, all names' and its toolkit's, are unchanged). A
  failure, an unclear answer and an account without a word id are never kept.
  `lazurio integrations list`, a process of its own, reads the names each time.
- The alias is taken only where `--list` lists exactly one active account and,
  where both lists name a word id, the same one. Any other answer, a failure or a
  timeout leaves the account unnamed. An account that is not active stays unnamed
  too: `--list` lists only active accounts.
- Each Composio account's `manage` is the page where the person sees and changes
  it: the app's page in their Composio organization,
  `https://dashboard.composio.dev/<organization name>/~/connect/apps/<toolkit>`
  (the name an encoded path segment, the path the CLI builds when it links an
  account, without its `?open=true`, which would connect another account).
  Composio's dashboard has no page of one account. The organization is
  `current_org_name` of the sign-in probe; where it is not known, the link is
  `https://dashboard.composio.dev/~/org/connect/apps/<toolkit>`, the person's
  current organization through `~/org/`, a shortcut inferred from the links in
  Composio's documentation. A visitor not signed in to Composio signs in there
  first. An Executor account has none (`null`).
- The page shows a "⋯" menu on each Composio account: "Spravovat v Composiu"
  opens `manage` in a new tab of the person's browser, and "Odpojit" is there
  rather than in the row, where the CLI removes an account without a prompt
  (`composio.disconnect`). "Přihlásit znovu" stays in the row of an expired
  account; an Executor account keeps "Odpojit" in its row and has no menu.
- "Odpojit" asks once, then the confirmation closes and the account's row says
  "Odpojuji…" ("Disconnecting…") with a spinner, dimmed, its "⋯" and "Odpojit"
  waiting, until a successful reading no longer lists it (decision F42, addendum
  (b) of 2026-10-14; `Removal`, `removalsRead`, `integrations-view.ts`). Removing a
  Composio account and reading the page again take a few seconds. A reading that
  fails or still lists the account keeps the row waiting and the page reads again
  after 1.5 s, at most twice; a reading whose source of the account's path
  (`sources.composio` or `sources.executor`) was not read leaves that source's
  accounts out and counts as one that still lists it. Then a reading that still lists it draws the row as it
  is with "Odpojeno, ale ještě se tu ukazuje. Za chvíli zkontrolujte připojení.",
  and a failing one leaves it waiting under "Integrace se nepodařilo načíst." until
  a reading succeeds. A removal that fails brings the row back with why ("Účet se
  nepodařilo odpojit.", or what the route's refusal means) in place of its line,
  until the next successful reading or another attempt. A custom server's "Odebrat" keeps its confirmation open until it is
  done, as before.
- No rename: it needs a project API key, and the CLI has no rename. The provider's
  identity (`state.val.displayName`) is printed only by Lazurio's build; Composio's
  own CLI strips it from every output.

### Composio's own Apps ("Aplikace v Composiu")

Decision F42, addendum of 2026-10-14. Lazurio's catalog does not list every app
Composio offers (Wispr Flow's MCP, for example), and Composio's dashboard connects
them well. So the page leads there:

- The reading's `composio.apps` is the Apps section of the Composio organization
  this Environment works in, built by the server like an account's `manage`
  (`composioAppsUrl`): `https://dashboard.composio.dev/<organization name>/~/connect/apps`,
  the name an encoded path segment, or `https://dashboard.composio.dev/~/org/connect/apps`
  where the organization is not known. It is there only where Composio's accounts
  count here: allowed, installed, signed in, on for agents, and its source read
  (`ok`). It is `null` otherwise: not allowed, signed out, unreadable, or working
  in no organization that can be told (`organization`). The page takes only a link
  to Composio's dashboard.
- The page shows it twice, only where it is not `null`. "Aplikace v Composiu ↗"
  ("Apps in Composio") stands in the page's top right corner beside "Jak to
  funguje", on every tab, and shows only its icon below 768 px. "Aplikaci tu
  nenajdete? Připojte ji v Composiu ↗" is at the foot of Vše, and inside the empty
  line of a search there that found nothing. Both open a new tab of the person's
  own browser. Where it is `null`, nothing is shown; the cards and the notices
  already say why.
- Coming back reads again once (`composioTrip`, `integrations-view.ts`). After one
  of these links was used and the page lost the person (the tab hidden or the
  window blurred), their return (focus, or the tab visible again) reads the
  Integrace as "Zkontrolovat připojení" does (`?refresh=1`). The return reads only
  once and only while the page is shown, and there is no polling. A link opened in
  the background never took the person away, so the page reads only once they do
  leave and come back.
- An account of a toolkit the catalog does not know is listed as an app of its own
  (`catalog: false`, its id the toolkit). It is named from the slug alone
  (`toolkitName`: words split at `_` and `-`, each capitalised, so `wispr_flow` is
  "Wispr Flow"); nothing is asked for its name. Its card says "Z Composia." (until
  F36's addendum of 2026-10-16 also "mimo katalog Lazuria", a word of the people who
  build it) and stands under Připojené once an account is active.
  `lazurio integrations list` names it as `Wispr Flow (wispr_flow)` and, where
  `composio.apps` is set, adds where the person connects an app the catalog does
  not list.

## The Microsoft 365 company app

Decision F42, addendum (c) of 2026-10-14; root decision 0162, addendum of
2026-10-14; plan DEV-6626 task 685. The Organization registers one single-tenant
app in its own Microsoft tenant, a public client without a secret, and consents to
its delegated Graph permissions once for everyone (the Admin's runbook is the root's
`manual/integrations/microsoft-365.md`). People then connect their Microsoft
accounts directly through their Environment's Executor; their tokens stay there.

The rules, in one breath: "Připojit" (or "Přidat účet") is one Microsoft sign-in,
and the account is connected and agents use it; several accounts side by side are
the person's choice; "Odpojit" disconnects one; nothing disconnects or expires on
Lazurio's side by itself.

- **The setting** (`settings.integrations.microsoft365`, Lazurio Core's contract):

  ```json
  "microsoft365": {
    "tenant_id": "00000000-0000-4000-8000-0000000000aa",
    "client_id": "00000000-0000-4000-8000-0000000000bb",
    "apps": ["outlook", "one_drive", "share_point"],
    "callbacks": [
      "https://launchpad.vm-01.contoso.lazurio.io/api/integrations/oauth/callback"
    ]
  }
  ```

  Lowercase GUIDs, a non-empty subset of the three apps (Teams joins in phase 2),
  and the Launchpad callbacks registered at Microsoft, possibly none, at most 255
  (Entra's 256 with the localhost one), each exactly
  `https://launchpad.<machine>.<github-org-login>.lazurio.io/api/integrations/oauth/callback`:
  any other host would receive the authorization response. Closed: no other key,
  so never a `client_secret`. Each leaf is one report item
  (`integrations.microsoft365.tenant_id`, …).
- **One integration, built from pinned specs.** Once the Folder recorded the
  setting (F45), the Launchpad applies it to Executor: ONE OpenAPI integration
  `m365` and one manual client `microsoft365` of the Environment. `apps` chooses
  the parts that go in:

  | App | Parts (Executor's curated Graph specs) | Delegated scopes beyond `openid profile email offline_access User.Read` |
  | --- | --- | --- |
  | Outlook (`outlook`) | mail, calendar | `Mail.ReadWrite`, `Calendars.ReadWrite` |
  | OneDrive (`one_drive`) | files | `Files.ReadWrite.All` |
  | SharePoint (`share_point`) | files, sites (walking a library's folders needs the files' drive items) | `Files.ReadWrite.All`, `Sites.Read.All` |

  The parts are pinned by the commit of their public source,
  `UsefulSoftwareCo/integrations`
  (`public/specs/microsoft-graph/{mail,calendar,files,sites}.json`), with the
  SHA-256 of each in `src/integrations/microsoft365.ts`. The Launchpad downloads
  them, refuses any whose bytes differ (`spec-mismatch`), merges their paths and
  components (a component several parts define identically kept once, any other
  overlap `spec-conflict`), replaces their own security schemes with one of the
  union of the scopes, and gives Executor the document as a blob (all four:
  13.2 million characters, 2,825 paths, under Executor's 32 MiB). The integration's
  description names the document's id, so applying again downloads nothing while
  it matches; other apps rebuild it in place. The auth template names the tenant
  (never `common`) and the union of the scopes. No `Mail.Send`, no
  `MailboxSettings.ReadWrite`. Applying never touches an account.
- **One sign-in, every app.** Executor 1.6.10 takes a sign-in's scopes from the
  integration's auth template and keeps one token pair per connection, which every
  operation of the integration uses: one Microsoft sign-in connects mail, calendar,
  files and sites at once. "Připojit" and "Přidat účet" start `POST
  /api/oauth/start` with the manual client and `newConnection` (another account gets
  a free name: `default`, `default2`, …), never an `identityLabel` of Lazurio's, so
  the ID token names the account (its email, else its user name); "Přihlásit znovu"
  signs an expired account in again under its own name.
- **Where the person signs in.** Where `callbacks` lists this Launchpad's own
  callback, the sign-in returns to it in a window of the person's own browser.
  Otherwise it returns to Executor's callback on localhost
  (`http://localhost:4789/api/oauth/callback`; the Admin registers
  `http://localhost/api/oauth/callback` once, Entra ignores a localhost address's
  port but matches its path) in the Environment browser. That browser is the
  agents' too, so once such a sign-in ends (connected or not) the Launchpad clears
  Microsoft's sign-in origins there (`login.microsoftonline.com`,
  `login.microsoft.com`, `login.live.com`; CDP `Storage.clearDataForOrigin`); the
  tenant's own web apps opened there keep their cookies. This disconnects nothing.
- **The card.** Where the setting is recorded, on every Environment of the
  Organization (work, Team or Automated), one card "Microsoft 365" stands in place of
  Outlook, OneDrive and SharePoint (a search for any of them, or for Microsoft,
  finds it), with "Připojit", then "Přidat účet", and "Odpojit" on each account. Its
  accounts are the connections of `m365`, named by their Microsoft account. Without
  the setting, the three cards stay as they are, with Composio where it is allowed;
  accounts left from before the setting went keep the card, so "Odpojit" still
  reaches them.
  A personal Environment and the person's own computer have no company app.
- **Handing an Environment over.** Nothing disconnects by itself. Whoever hands an
  Environment over, or receives one, disconnects in Apps → Integrace the accounts
  that should no longer be used there.
- **What it allows, and the off switch.** `Calendars.ReadWrite` sends invitations
  and cancellations; `Files.ReadWrite.All` deletes files and creates sharing links;
  Executor holds such writes for the agent's approval, a rule agents follow, not a
  barrier. What agents read goes to their AI model provider. The Lazurio setting
  only offers the company app; Entra is the company's off switch (block the account,
  revoke its sessions, disable the app or remove its consent).
- **IT consent.** The tenant's admin consents once, for everyone. A sign-in that
  says administrator approval is required (`AADSTS65001`, `AADSTS90094`) means the
  tenant lacks consent to a scope this release asks for; the Organization's Admin
  adds it, and the person connects again.

## The reading: `GET /api/integrations` and `lazurio integrations list`

Both answer the same document (`IntegrationsOverview`, `src/integrations/model.ts`):
the Folder's language and scope, the Integrace page address where a browser
reaches the Launchpad (`page`, null on a workstation), Composio's policy,
readiness, whether its CLI removes an account here (`disconnect`), whether the
page offers its update (`update`: [Lazurio's build](#lazurios-build-of-the-cli)) and its
Apps in Composio's dashboard (`apps`: [Composio's own Apps](#composios-own-apps-aplikace-v-composiu)), each
source's state (`ok`, `unavailable`, `absent` for an Environment
without Executor, `unreadable`, `signed-out`, `not-allowed`), the tools for one app that are connected, every catalog app with
its path, `connected`, its accounts (path, the selector that disconnects it: Executor's
connection id, Composio's id where its list gives one, else its word id; its
`label`, state, spare, and `manage`, a Composio account's page in Composio's
dashboard: [Account names](#account-names-and-composios-dashboard)) and its card link (`<origin>/integrations/app/<id>`, which
lists and focuses that card even where nothing connects the app here), the
accounts of Composio toolkits the catalog does not know (named from the toolkit),
and the custom MCP
servers (address without userinfo or query, which may carry a key; a command
server's line is not shown). A source that cannot be read is said so and never
taken for "nothing connected"; only a Folder that cannot be read fails the route
(500). The tools' sign-in probes and Composio reach the network, so the Launchpad
keeps its last reading for a minute and reads again on "Zkontrolovat připojení"
(`?refresh=1`) and after every change.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/integrations[?refresh=1]` | | the reading |
| `POST /api/integrations/connect` | `{app, name?, account?}` | `{kind: "authorize", session, url}` (a window of this browser), `{kind: "authorize", session, view}` (the Environment browser's tab), `{kind: "connected", app}`, or `409 {kind: "blocked", reason}`: `app-unknown`, `path-unavailable`, `composio-signed-out`, `composio-organization` (Composio works in no organization of this Environment's Organization's name), `name-required`, `name-taken`, `account-unknown`, `executor-unavailable`, `browser-unavailable`, `integration-conflict` (Executor holds the app's slug for another server), `still-failing` (Executor cannot use the account, read back after the attempt), `connect-failed` |
| `POST /api/integrations/poll` | `{session}` | `pending`, `{kind: "connected", app}` or `{kind: "ended", reason: failed\|expired\|cancelled}`; 404 for an unknown session |
| `POST /api/integrations/cancel` | `{session}` | `{kind: "cancelled"}`; an OAuth flow is cancelled in Executor too |
| `GET /api/integrations/oauth/callback?state=…&code=…` | | an authorization server's return in the person's own browser (a Remote Environment): `state`, `code`, `error`, `error_description`, `domain` and `site`, each once and at most 8 KiB, are handed to Executor's callback once, only for a sign-in started here for this address that still waits (anything else stays here); a page saying how it went, without a script, a link or anything of the return (200), or that the sign-in is no longer valid (400 where no sign-in here has the state) |
| `POST /api/integrations/disconnect` | `{app, path, account, confirm: true}` | `{kind: "disconnected"}`, `400 confirm-required` without `confirm: true`, or blocked `account-unknown`, `disconnect-unsupported`, `executor-unavailable`, `disconnect-failed`, `composio-organization` |
| `POST /api/integrations/custom/add` | STDIO `{type: "stdio", name, command, args: [string], env: [{name, value}], cwd?}`; Streamable HTTP `{type: "http", name, url, bearer?, headers: [{name, value}]}` | like connect; a remote server without keys that needs OAuth starts its sign-in; `400 {error: "invalid-server", problems}` for what the form refuses |
| `GET /api/integrations/custom/server?id=<slug>` | | its edit form: `{kind: "custom-server", id, type, name, …}` with the command, the arguments and the working directory, or the address without userinfo or query, and its keys by name (`env`, `bearer`, `headers`), never a value; `409 account-unknown` for a catalog app's integration |
| `POST /api/integrations/custom/update` | `{id, …}` as the add, a stored key's `value` (and `bearer`) `null` to keep it | `{kind: "saved", app}`, or `authorize` when the server now signs in; `409` `type-fixed`, `account-unknown`, `executor-unavailable`, `connect-failed`; `400 keys-required` when a kept key must come again (another key changed, or the address did), refused before any probe; `400 invalid-server` for what the form refuses |
| `POST /api/integrations/custom/remove` | `{id, confirm: true}` | `{kind: "removed"}`; a catalog app's integration is never removed as custom |

All behind the admission of every route (the local token and same origin, or the
gateway's session); writes are POST with JSON bodies of exact keys, at most 16 KiB.
A connect takes the app's path from the reading, never from the page. A key (an
environment variable's value, the Bearer token, a header's value) goes only to
Executor, never back, never logged or journaled. The journal says
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
([licensing](licensing.md)). The one mark from outside simple-icons in the
Launchpad is OpenAI's Blossom on Začínáme's "Přihlásit ChatGPT", bundled under
OpenAI's brand terms with the Organization Admin's approval of 2026-10-16
([licensing](licensing.md#bundled-third-party-assets)); Integrace takes none.

## The Folder

AGENTS.md has a section Integrace after Tools: what an Integrace is, its three
paths, `lazurio integrations list --json`, the order tool → Executor → Composio,
never connecting one (the card's link where the Launchpad has an address, the page
named on a workstation), and a custom MCP server only on the person's explicit
instruction and always into Executor. `manual/working-here.md` has the chapter
Integrace (with Executor's approvals, the IT consent of company apps and, on an
Organization's Environment, how agents use the Microsoft 365 Integrace `m365`:
several accounts possible, ask which when unclear, drafts only, folders by item id
with paging, readback with `webLink`),
`manual/this-machine.md` points from its tools to it, and the Launchpad routing of
hosted Environments names the Integrace page instead of Composio's procedure. The
texts it retires: `composio link` for agents, "send the link the command returns",
"no cloud connector other than Composio", MCP servers set up per harness
(`claude mcp add`, `~/.codex/config.toml`). Template revision `base-instructions-39`;
the Microsoft 365 texts `base-instructions-53`.
