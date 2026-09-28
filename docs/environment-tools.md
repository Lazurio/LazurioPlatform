# Environment tools and operator sign-ins

Proposed bounded pilot procedure under accepted decision 0144. Apart from the curated
installation and login of three catalog tools (decision F19, below), this document
does not claim an implemented tool installer, authenticated harness or usable
Environment.
Machines delivers the online Machine and a first installation of the Platform; local
Platform operations and the operator prepare what is needed inside it, including
the Platform's own updates (F17 addendum 2026-09-28).

## Operator tools are the operator's (decision 0161, F17)

Root decision 0161 (2026-09-26, with its addendum of the same day) splits a Remote
Environment into the **provider baseline** (system, accounts, network, gateway,
resident, the installed Platform release, and the first installation of the operator's
tools in the standard path below) and the **operator's tools** (Codex, Claude Code,
`gh`, Node, npm, Bun and whatever else is on the operator's PATH). The baseline is
pinned through the Machines rollout; the tools are delivered once at Machine creation
and then belong to the operator, who updates them with the official installers.
Since the F17 addendum of 2026-09-28 the version of the Platform belongs to the
operator too: they update it with `lazurio update`, and the pin is only a minimum a
rollout installs, repairs or raises to, never a version it lowers to.
Readback reports their versions as facts, not drift. A rollout is only a repair of the
one installation (the exact scope is in "The standard path" below); the Machines apply
starts no agent and returns the `lazurio doctor` and `lazurio tools status` readback,
and the rolling-out Task Agent starts the repair of the rest with the operator's
mandate per the Folder manuals. Agents update operator tools only on the Principal's
explicit instruction. The Platform's part is the generated manual rule and section
"Where the tools live" (template revision `base-instructions-7`) and
`lazurio tools status|update`, a thin orchestration of the official installers that
reports and, on instruction, runs them; it pins nothing.

### `lazurio tools status` and `lazurio tools update <tool>`

The Platform's surface for the operator's tools, implemented in `src/tools/`:

- `tools status [--json]` lists codex, claude, gh, git, node, npm, bun, composio,
  wacli, gog and neon as found on
  the process PATH (first executable of the name, decision 0140 rule), with the real
  path behind a link and the version the tool reports; missing tools carry their
  official source. Read-only; the version commands never use the network; it does not
  say "outdated", because the operator's version is a fact, not drift.
- `tools update <tool> [--json]` runs exactly that tool's official update path as the
  current user and reports the version before and after: the tool's own updater
  (`claude update`, `bun upgrade`) or the vendor's installer script (`codex`, the
  official standalone installer of `manual/organization-install.md`). Tools without one
  (`gh`, `git`, `node`, `npm`) are reported with their official source and nothing
  runs (`tool-not-self-updating`, exit 1). Unknown names exit 2. It never pins,
  never downgrades on its own, never touches another tool and is not run by
  `lazurio update`, the Launchpad or a Machines apply. An agent runs it only on the
  Principal's explicit instruction (F17).

### Enabled tools of a Folder (decision 0162, F18)

Agents use what the Folder tells them to use. The catalog marks the tools that may be
named in the generated instructions with a **tier** and a **setup mode**:

| Tool | Command | Tier | Setup |
| --- | --- | --- | --- |
| `gh` | `gh` | required: always on, never stored, cannot be disabled | launchpad |
| `composio` | `composio` | recommended | launchpad |
| `wacli` | `wacli` | optional | launchpad |
| `gogcli` | `gog` | optional | agent |
| `neon` | `neon` | optional | agent |

Enabling is context for agents. It grants no access, installs nothing, signs in
nowhere and pins no version; a tool may be enabled before it is installed. The enabled
names are stored in `.lazurio/preferences.json` under the optional key `tools`, absent
when nothing is enabled ([F18](decisions.md#f18--enabled-tools-of-the-environment)),
and rendered into `AGENTS.md` ("Tools") and `manual/this-machine.md` ("Enabled tools").
Agents use the catalog CLIs that are on first, then the MCP servers their harness
offers, which the Folder never records.

**The operator's note** ([F18 addendum](decisions.md#f18--enabled-tools-of-the-environment)).
A required or enabled tool may carry a note from the operator: the intent with which
they use it ("use it for the ClickUp and Gmail of Spectoda; send nothing without my
instruction"). It is stored under the optional key `toolNotes` (absent without a note)
and quoted for agents in `manual/this-machine.md` under the tool, as a blockquote that
cannot forge a heading, section or marker; `AGENTS.md` only says that a note exists. A
note is plain text of 1 to 600 characters after trimming, at most 6 lines, without
control characters. It is the operator's intent for agents on this Environment and
grants no access. Disabling a tool removes its note.

**Setup modes.** `launchpad`: installation and login have a curated flow in the CLI
and the Launchpad ([F19](decisions.md#f19--curated-installation-and-login-of-catalog-tools),
below). `agent`: the Launchpad only shows status, and "Set up with an agent" hands the
prepared prompt to an agent who installs the tool and guides the sign-in. Each tool's
`installation` text describes the target state and is the agent's manual in both
modes (for a `launchpad` tool it is what a fallback agent follows when the curated
installer fails). The Principal's reason: many tools can be offered cheaply through the
agent mode, and later usage analytics of which tools operators try to install with an
agent shows where a curated flow is worth building. The analytics are not
implemented.

The commands are Folder-bound in the style of the profile commands: the Folder is
always explicit, a mutation names the revision it was decided against, the result is
JSON with `--json`, and the exit status is 0 completed or unchanged, 2 blocked or
usage, 1 operation failure.

- `tools list --folder <absolute Folder> [--sign-in] [--json]` lists the activatable
  catalog tools only, in catalog order, each with `tier`, `setup`, `enabled`, its
  `note` when there is one and the live facts of `tools status` for that tool
  (`installed`, `path`, `realPath`, `version`, `standardPath`, `source`), plus the
  Folder `revision` a following mutation must name. Read-only. With `--sign-in` each
  entry also carries `signIn` (below).
- `tools enable <tool> --folder <Folder> --expected-revision <n> [--json]` and
  `tools disable <tool> …` record the selection and re-render the Folder through the
  profile transaction (`updated` with the new revision, or `unchanged`). A name the
  catalog does not offer for activation is `blocked` / `tool-unknown` (exit 2);
  disabling a required tool is `blocked` / `tool-required` (exit 2); enabling a
  required tool is `unchanged` (exit 0). The planner's refusals arrive unchanged
  (`stale-revision`, `drift` with the path, `custom-composition-unavailable`, …). An
  interrupted change is completed with `profile-resume`.
- `tools note <tool> --folder <Folder> --expected-revision <n> (--text <text> | --clear)
  [--json]` records or removes the operator's note on a required or enabled tool
  through the same transaction (`updated` or `unchanged`). The text is trimmed and its
  line endings normalized first; an invalid text is `blocked` / `note-invalid` with the
  `problem` (`empty`, `too-long`, `too-many-lines`, `control`), a note on a tool that is
  not on is `blocked` / `tool-not-enabled`, both exit 2.
- `tools prompt <tool> [--locale cs|en] [--json]` prints the prepared agent prompt:
  the task, the `installation` text and the rule to enable the tool afterwards.
  Read-only text, no Folder; the default locale is `en`.

The Launchpad server offers the same over the same core: `tools` in `/api/profile`,
`POST /api/tools/preview` and `POST /api/tools/update` with
`{ expectedRevision, tools, notes? }`, where `tools` is the full next selection, sorted
and unique, and `notes`, when present, the full next set of notes (sorted keys, only
required or enabled tools); without `notes` the recorded notes of the tools that stay
on are kept.

`POST /api/tools/status` (body `{}` or `{ "signIn": true|false }`, the same admission
as every other route) is what the Launchpad's Tools section reads. It answers
`kind: "tools-status"`, the Folder's `revision` and `locale`, `sharedEnvironment`,
`hosted` (every preset but `local`), and for every activatable catalog tool in catalog
order: `name`, `command`, `tier`, `setup`, `enabled`, `purpose` and `usage` in the
Folder's locale, `source`, the live facts of `tools status` (`installed`, `path`,
`realPath`, `version`, `versionError`, `standardPath`), `note` when the operator left
one, `signIn` when the request asked for it, and `prompt`, the prepared agent prompt
of `lazurio tools prompt <tool>`. `mcpPrompt` is the prepared prompt for the third
route, an MCP server set up by an agent. Without `signIn: true` the probe runs each
found tool's version command and nothing else, and uses no network. The raw output of
a tool is not returned, and the request accepts no Folder, PATH or tool name. The
facts are those of the PATH and home of the Launchpad process, which on an installed
service may differ from an operator's interactive shell.

**Sign-in state** ([F18 addendum](decisions.md#f18--enabled-tools-of-the-environment)).
With `signIn: true` (the page sends it on load and on "Refresh status") or
`tools list --sign-in`, each installed tool's catalog sign-in probe runs as well:
`gh auth status --hostname github.com`, `composio whoami`, `wacli auth status --json
--read-only`, `gog auth list --check --json --no-input`, `neon me -o json`. These may
contact the tool's provider to verify its token, which is why they run only on
request. They run in parallel, 10 s each, with only `PATH`, `HOME` and `XDG_*` in their
environment. `signIn` is `{ state: "signed-in" | "signed-out" | "unknown", account?,
organization? }`: signed in when the probe exits 0 and its rules hold (composio exits
0 also when not logged in and counts as signed in only with its JSON line and a
non-empty email), `unknown` for a tool not installed, a timeout or unreadable output.
`account` and `organization` (composio's current organization) are the only things
taken from the output, as plain text of at most 120 characters; the output itself is
never returned or logged. A signed-in gh also carries `ssh` ([F19 addendum
2026-09-28](decisions.md#f19--curated-installation-and-login-of-catalog-tools)):
`{ state: "linked" | "not-linked" | "unknown", reason?, fingerprint? }`, from the
`.pub` of this Machine's default key and one call of `gh api "user/keys?per_page=100"`
(`not-linked` with `no-key` or `not-registered`; `unknown` with `scope-missing` when
the token cannot read keys, or `unreadable`). The private key is not read and nothing
connects over SSH on a status call.

The Tools section itself is described in
[launchpad-development.md](launchpad-development.md#tools-section).

### Curated installation and login (decision F19)

For the `launchpad` tools (`gh`, `composio`, `wacli`) on Linux and macOS, x64 and
arm64. CLI first; the Launchpad serves the same core. The tools set up by an agent
(`gogcli`, `neon`) are refused with a pointer to `lazurio tools prompt <tool>`.

- `tools install <tool> [--json]` installs for the current user, without root, into
  `~/.local/bin/<command>` from the official source at the latest release. `gh` and
  `wacli`: the GitHub release archive for the platform, verified against the SHA-256
  in the release's checksums file before it is read, every archive entry checked
  (absolute names, `..`, escaping links and special entries refuse the archive), only
  the binary placed, atomically, 0755. `composio`: the official installer
  `https://composio.dev/install`, downloaded into a private file first, then run with
  `COMPOSIO_INSTALL_PLUGINS=0 COMPOSIO_INSTALL_SHELL=none COMPOSIO_INSTALL_HELP=0`
  (bundle in `~/.composio`, link in `~/.local/bin`, no agent plugins, no shell files).
  A tool that works anywhere on PATH, or in the standard path, is not touched
  (`already-installed`); a broken copy elsewhere on PATH is not shadowed
  (`install-failed` at `preflight`). Failures name the stage (`resolve`, `download`,
  `checksum`, `extract`, `place`, `installer`, `verify`) and point to the agent prompt;
  an unsupported platform (Windows included) likewise. Exit 0 installed or already
  installed, 1 failed or unsupported, 2 usage or refused.
- `tools login <tool> [--phone <+number>] [--ssh-key] [--json]` runs the tool's own
  sign-in in the foreground and shows its challenge: for gh the one-time code and
  `https://github.com/login/device` (`gh auth login --hostname github.com
  --git-protocol ssh --web --scopes admin:public_key --clipboard=false`; since gh
  2.101.0 the code is copied to the clipboard by default, and `--clipboard=false`
  turns that off for this run only);
  for composio the dashboard link (`composio login --no-wait --no-skill-install`, then
  `composio login --poll --no-skill-install`); for wacli the WhatsApp QR code drawn in
  the terminal on a white background, redrawn when it rotates (`wacli auth --events
  --idle-exit 30s`), or with `--phone` the pairing code. The code or link is opened on
  any device; nothing is typed into Lazurio and no key is copied. It waits until signed
  in (confirmed by the tool's sign-in probe), failed or expired (gh 15 minutes,
  composio 10, WhatsApp pairing 5); Ctrl-C cancels and kills the tool's process group.
  After WhatsApp pairing it waits for the first sync of messages. `--json` prints one
  JSON object per state change, the challenge included, because the running command
  holds the session. Exit 0 signed in, 1 not, 2 usage or refused.
- **gh links the Machine's SSH key** (F19 addendum 2026-09-28): after the sign-in the
  same command, as a step of its own, uses the existing default key (`~/.ssh/id_ed25519`,
  `id_ecdsa`, `id_rsa`, in that order; never overwritten or changed, and it must have
  no passphrase) or creates `~/.ssh/id_ed25519` without a passphrase (`~/.ssh` 0700,
  key 0600); registers it with `gh ssh-key add <key>.pub --title "Lazurio: <Machine>"
  --type authentication` (nothing is added when the account has it); adds only the
  missing github.com keys of `gh api meta` (`ssh_keys`) to `~/.ssh/known_hosts` and
  stops without a change when an existing github.com entry differs; and proves it with
  `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes git@github.com`, whose
  greeting must name the signed-in login. The result is `signed-in` with `ssh: {
  state: "linked", key: { path, fingerprint, created }, registration, knownHosts }`,
  or `ssh: { state: "not-linked", reason, key?, provedAs?, fallback: "agent" }` with
  one of `scope-missing`, `keygen-missing`, `keygen-failed`, `key-passphrase`,
  `key-incomplete`, `key-unreadable`, `key-in-use` (GitHub refuses a key used by
  another account or as a deploy key; no second key is made), `register-failed`,
  `host-keys-unavailable`, `host-key-mismatch`, `known-hosts-failed`, `ssh-missing`,
  `proof-failed`, `proof-other-account`. gh exits 0 only when the key is linked.
  `--ssh-key` (gh only) does these steps for a gh that is signed in already, after
  `gh auth refresh --hostname github.com --scopes admin:public_key --clipboard=false`
  (a device code) when the token lacks the scope; a gh that is not signed in fails as
  `not-signed-in`.
- `tools logout <tool> [--json]` runs the tool's own sign-out (`gh auth logout
  --hostname github.com`, `composio logout`, `wacli auth logout`) and checks it with
  the probe. gh and composio forget the sign-in on this Machine only: revoke it at the
  provider as well if it must end there. wacli unlinks the device from the account.
  gh first removes this Machine's SSH key from the account (`gh ssh-key delete <id>
  --yes`) when the token has `admin:public_key` and the key's title starts with
  `Lazurio: `, so that sign-out ends the Machine's access; a key the operator
  registered by hand stays, the key files stay, and `sshKey` says which (`removed`,
  `not-registered`, `no-key`, `kept-not-lazurio`, `not-removed` with the reason and
  where to remove it by hand).
- `tools composio-org [list | switch <id>] [--json]` lists the Composio organizations
  of the signed-in account with the current one marked (`composio orgs list`) and
  switches it (`composio orgs switch --org-id`). The apps connected in Composio belong
  to the account and organization of this Environment.

The Launchpad offers the same over `POST /api/tools/install {tool}`,
`/api/tools/login/start {tool, phone?}`, `/api/tools/login/poll {tool, session}`,
`/api/tools/login/cancel {tool, session}`, `/api/tools/logout {tool}`,
`/api/tools/composio/organizations {}` and `/api/tools/composio/organization {id}`,
with the admission, exact-field JSON and `Cache-Control: no-store` of every route.
`start` answers with the session handle and the first challenge; `poll` and `cancel`
take that handle, so a challenge goes only to the browser that started the login. A
pending WhatsApp login carries `qrSvg`, the QR code drawn by the server. A tool the
catalog does not know, or an `agent` tool, is `409 blocked`. `start` takes `sshKey:
true` for gh only ("Link SSH key"; anything else with it is `400`), and a pending gh
login says `step: "ssh-key"` while the key is being linked. No answer carries private
key content or a public key's blob; only the key's path and SHA-256 fingerprint.

A challenge is never written to a log, a file, the Folder or an error. The tools keep
their own pending state in their own stores (composio's pending login in
`~/.composio`), which is the tool's custody and is not copied anywhere. On a shared
Environment (the Team preset) the login belongs to the whole Environment, and the
Launchpad says so before it starts.

### The standard path (decision 0161, point 6)

One installation per tool, in one place, on every Machine: an operator tool is the
first executable of its name in `~/.local/bin` on the operator's PATH. A tool's
official installer may keep its own home (Codex `~/.codex/…`, Bun `~/.bun`); only a
link or wrapper in `~/.local/bin` puts it on PATH. Lazurio lives in
`~/.local/share/lazurio/` with `~/.local/bin/lazurio`, the link `lazurio install`
creates and reports ([product update](update.md#release-and-trust)); system tools (git, curl,
python, ssh) belong to the OS package manager; T3 Code and its runtime belong to the
service unit and run on the Node its version recommends. There is no second
"recovery" copy of any tool: a rollout repairs the one installation in place, in two
tiers — (a) only the `~/.local/bin/<tool>` link or wrapper is missing or dangling
while the installer home holds a working binary: the link is recreated; (b) the binary
itself is non-functional or absent: the tool's official installer runs at the baseline
version, writes into its own home exactly as on any installation (`~/.bun/bin/bun`, a
new release under `~/.codex/packages/standalone/releases/…`) and restores the
`~/.local/bin` entry. A working tool keeps its version whatever it is; the operator's
configuration, sign-ins and history are never touched; only a tool's own official
installer writes into its home. The Machines apply returns the `lazurio doctor` and
`lazurio tools status` readback and starts no agent; the rolling-out Task Agent starts
the repair with the operator's mandate. `tools status` reports
`standardPath` per tool; the generated Folder manual carries the rule ("Kde bydlí
nástroje" / "Where the tools live") so agents keep the layout when they add tools.

## Ownership

| Capability | Platform responsibility | Operator / external owner responsibility |
| --- | --- | --- |
| Standalone Lazurio CLI | Verify the release, stage and activate the selected artifact; no external Bun/Node prerequisite | Approve the release (`latest` or one exact tag) and target; Machines performs its infrastructure installation handover |
| Git and GitHub CLI (`gh`) | Diagnose availability and required capabilities; propose explicit preparation of missing tools | Authorize package/system changes; authenticate as the intended Principal and grant actual repo access |
| Module runtime (for example Bun) | Coordinate the module's declared preparation; report missing/incompatible runtime without claiming readiness | Module owns exact dependency/runtime requirements and preparation; operator approves installation |
| Codex / Claude harness | Diagnose the selected harness, instruction loading and required capabilities; provide one Folder-owned instruction contract | Choose the harness, accounts/model access and consent; complete provider-native sign-in |
| Credentials | Use an existing approved provider/credential interface; retain only non-secret diagnostic outcomes | Existing credential owner retains custody, rotation and revocation |

The table describes a private workspace or local Machine, where one Principal is the
operator. The team case differs and is described [below](#team-workspace).

Do not install both harnesses merely because they are supported consumers. The pilot
must select and qualify an actual agent, not infer success from an executable's presence.
Do not copy sessions, tokens or another Principal's Personalspace from a workstation.
An operator identity in `lazurio.machine.json` does not authorize GitHub, model access,
package installation, a paid subscription or a Machine-wide system change.

## Minimal preparation sequence

1. Load and bind the Machines context; inspect tools under the actual execution user.
   Follow the existing decision 0140 tool-resolution rule: resolve the first executable
   on process PATH, then check capabilities/compatible versions. Do not introduce
   Homebrew or a hard-coded installation-directory allowlist as a universal prerequisite.
   This generic tool policy does not weaken the trusted system-account lookup used to
   bind the Linux operator or the artifact custody rules of the product installer.
2. Report separately: available, missing, incompatible, unauthenticated and access
   denied. A tool version, successful login or owner name alone cannot prove permission
   for an exact Organization/repository operation.
3. Present a bounded preparation plan: exact missing tool/version, official source,
   verification method, target scope and whether privilege/network access is needed.
   Reuse compatible installations. Do not silently upgrade global PATH tools or run
   guessed package commands. Select concrete sources/pins for the approved guest before
   implementing the installer; no universal package manager is chosen by this design.
4. Let the operator complete interactive/provider-native sign-ins. Recheck actual
   identity and exact repository rights before Organization materialization; denied or
   unavailable access stops that operation without deleting existing work.
5. Use the module's declared dependency preparation, then exercise prepare/start/open/
   functional check/status/stop through shared CLI/Launchpad behavior. Module dependencies
   are not bundled CLI requirements and preparation success alone is not app readiness.
6. Start a fresh selected agent and prove Folder instructions, Organization rules and
   one bounded real task. Store only sanitized evidence in the owning private scope.

## Team workspace

Accepted direction (2026-09-19, [decision F2](decisions.md#f2--private-and-team-hosted-workspaces)),
not implemented. On a team hosted workspace the operator account is shared, so the
sign-in column above changes:

- **No personal sign-ins.** Nobody runs a personal `gh auth login`, stores a personal
  token or SSH key, or copies a session onto the shared account. (Open: the Team
  preset can already enable tools and sign in to them for the whole Environment, F18
  addendum; the curated gh sign-in then also links an SSH key for the whole
  Environment. How that meets this direction is not decided.) Diagnosis that finds a
  personal provider credential there reports it as a defect to be removed through its
  owner; it is never used.
- **Provider identity is brokered.** Git and GitHub operations use the platform App
  identity through the Organization's token broker: short-lived, repository-scoped
  tokens, the App's private key never on the Machine. Platform diagnoses that the
  brokered mode is available and that an exact repository operation is permitted; it
  does not hold the broker credential's policy or the Team's grants.
- **Attribution is the Team's.** Commits carry the bot committer, the Team author
  pseudo-identity and the workspace trailer of upstream decision 0148; changes land
  through pull requests that an authorized person reviews and merges.
- **Revocation is GitHub's.** Removing the Team's repository grant blocks the next
  token. Platform keeps local content and reports denial.
- **Harness and model access is open.** A member's personal model subscription is a
  personal credential and does not belong on the shared account; what the Organization
  supplies instead, and how it is attributed and revoked, is undecided and is a
  prerequisite of `hosted-organization-team` acceptance.
- **No Personalspace**, and no step of the preparation sequence may create one.

Steps 1–3 and 5–6 of the sequence apply unchanged. Step 4 becomes: verify the brokered
identity and exact repository rights before Organization materialization.

## Pilot limits

Implement read-only diagnosis and one explicitly approved preparation path first.
Platform builds no credential broker, account registry, automatic model login or
package-manager matrix (`lazurio tools` runs one tool's official update path under decision
0161 and installs only the curated catalog tools of decision F19; it is not a general
updater or installer); the team case consumes the existing upstream
broker rather than adding one. Unknown installation state receives a diagnosis
and operator repair procedure, not an improvised privileged cleanup. Missing accounts
remain an explicit pilot prerequisite, not something Machines or a profile can grant.
Real Organization materialization and canonical document adoption have their separate
decision/authorization gate; this proposal does not authorize conversion or cloning.
