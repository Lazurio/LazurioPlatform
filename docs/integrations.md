# Integrace: the apps connected to an Environment

Status: implemented (decision F42 with its addenda of 2026-10-11 to 2026-10-14, root decision 0162
with its addendum of 2026-10-09, plan DEV-6626 tasks 675, 683 and the Folder part of
681). Whether
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
| Connecting and disconnecting; adding, reading and editing a custom MCP server | `src/integrations/connect.ts` |
| A custom MCP server's rules and Executor's shapes of it (shared by the page and the server) | `src/integrations/custom-server.ts` |
| The routes | `src/launchpad/integrations-routes.ts` |
| The page | `src/launchpad/integrations-view.ts` and `custom-server-form.ts` (pure), `integrations-panel.ts` (DOM) |
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
| `POST /api/oauth/clients` | a public client of the client ID metadata document `https://executor.sh/api/oauth/client-id-metadata/local.json` (loopback redirect URIs on any port), `clientSecret: ""`; replaces a client of the same `(owner, slug)` |
| `POST /api/oauth/clients/register-dynamic` | RFC 7591 registration, reused when it matches the exact `redirectUri`: the Launchpad's `<entry>/api/integrations/oauth/callback` on a Remote Environment, else (or after the server refused it, 400) `http://localhost:4789/api/oauth/callback`; `clientName` `Lazurio` |
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
slug and per endpoint, so the mapping is never ambiguous. The company apps'
OpenAPI integrations (task 685) will need an identity of their own; until then no
API integration counts as an app's.

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

Read from the CLI's source (ComposioHQ/composio, `ts/packages/cli`, 2026-10-09):

- `connections list` prints `{<toolkit>: [{status, alias?, word_id?,
  permission_group}]}` on stdout, every status, an alias only where a toolkit has
  several accounts, no ids. Statuses map to four states: `ACTIVE` connected;
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
  removes nothing; it has no `--yes` (0.4.2, and `next` on 2026-10-12; proposed
  upstream in ComposioHQ/composio#4817). The Launchpad removes only when
  `connections remove --help` offers `--yes` and never answers the prompt for the
  person. The reading says whether it does (`composio.disconnect`, read with the
  accounts), and only then the page offers "Odpojit" for a Composio account; the
  route still answers `disconnect-unsupported` to a request without it. Composio's
  accounts belong to the Composio account and its organization, so disconnecting
  reaches every Environment signed in the same way.

- `orgs list` prints `[{id, name, is_selected_global_org}]` (the JSON array on
  stdout, after the CLI's own lines), and `orgs switch --org-id <id>` makes one
  organization current. The CLI has no command that creates one, and Composio's
  API documents only `GET /api/v3.1/org/list`.

Every process gets only `PATH`, `HOME`, the XDG base directories and `NO_COLOR`,
runs in its own process group and is bounded (15 s); its raw output is never
returned or logged.

### The Composio organization of an Environment

Decision F42, addendum of 2026-10-13. Each person has one Composio account. In it
they have one organization of their own for each Lazurio Organization, named as
the Organization is, with nobody else in it, and the default one Composio made
when they signed up.

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
  the organization the person chose; the sign-in dialog advises a personal
  Environment to choose the default one. A name matches whatever its case, its
  spaces and its diacritics (`organizationKey`: "Human and Machine" is
  `humanandmachine`); punctuation counts.
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
  Composio's dashboard and the model drawn, and `lazurio integrations list` tells
  agents. The next reading after the person created it makes it current.
- **Where its organization cannot be told** (`unverified`, or an `elsewhere`
  organization that could not be made current), the Composio source reads
  `organization`: none of its accounts is listed, and a link or a removal is
  refused (`409 composio-organization`) with nothing written. The reading's
  `composio.organization` is `{name, state}` on an Organization's Environment
  (the name null where it is `unverified`), null elsewhere.
- **Creating one** is the person's, in Composio's dashboard: neither its CLI nor
  its documented API creates an organization. "Zkontrolovat připojení" finds it
  by name afterwards.

### Account names and Composio's dashboard

Decision F42, addendum of 2026-10-11 (#312). An account's **label** is its name:
Composio's alias, or the name Executor gives a direct account (the name given when
connecting, or the account the provider names). Without one the page says "účet"
("account"); a word id is a selector, never shown as a name.

- `connections list` leaves out the alias of a toolkit's only account. Where that
  account is active and has no alias there, the reading asks `link <toolkit>
  --list` (`nameComposioAccounts`): once per such toolkit and for no other, at
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
- No rename and no provider identity: renaming needs a project API key and the
  CLI has no rename, and the CLI strips the identity Composio keeps for an account
  (`state.val.displayName`) from every output. Both wait for the CLI.

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
  "Wispr Flow"); nothing is asked for its name. Its card says "Z Composia, mimo
  katalog Lazuria." and stands under Připojené once an account is active.
  `lazurio integrations list` names it as `Wispr Flow (wispr_flow)` and, where
  `composio.apps` is set, adds where the person connects an app the catalog does
  not list.

## The reading: `GET /api/integrations` and `lazurio integrations list`

Both answer the same document (`IntegrationsOverview`, `src/integrations/model.ts`):
the Folder's language and scope, the Integrace page address where a browser
reaches the Launchpad (`page`, null on a workstation), Composio's policy,
readiness, whether its CLI removes an account here (`disconnect`) and its
Apps in Composio's dashboard (`apps`: [Composio's own Apps](#composios-own-apps-aplikace-v-composiu)), each
source's state (`ok`, `unavailable`, `absent` for an Environment
without Executor, `unreadable`, `signed-out`, `not-allowed`), the tools for one app that are connected, every catalog app with
its path, `connected`, its accounts (path, the selector that disconnects it, its
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
