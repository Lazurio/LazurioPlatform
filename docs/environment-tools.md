# Environment tools and operator sign-ins

> **Approved target update, 2026-10-06 (root 0192):** [Account and Environment access](environment-access.md) refines organizational admission: Lazurio membership and full/app grants, optional GitHub for visitors, Admin approval of the exact Headscale device, and delegated same-Organization sharing. Conflicting older target statements below are superseded; implemented behavior and evidence remain baseline only until a qualified migration. No runtime changes in this documentation update.

Proposed bounded pilot procedure under accepted decision 0144. Apart from the curated
installation and login of three catalog tools (decision F19, below), the
Environment's own vault (decisions F43 and F53, below), Executor (decision F44, below) and the
pilot of the shared GitHub App sign-in (decision F48, below), this
document does not claim an implemented tool installer, authenticated harness or
usable Environment.
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
mandate per the Folder manuals. Agents update Operator tools only on the Operator's
explicit instruction. The Platform's part is the generated manual rule and section
"Where the tools live" (template revision `base-instructions-7`) and
`lazurio tools status|update`, a thin orchestration of the official installers that
reports and, on instruction, runs them; it pins nothing but Lazurio's build of
composio ([F42](decisions.md#f42--integrace-one-catalog-for-the-environment-one-path-per-app-executors-api-behind-the-launchpad), addendum (3) of 2026-10-13).

### `lazurio tools status` and `lazurio tools update <tool>`

The Platform's surface for the operator's tools, implemented in `src/tools/`:

- `tools status [--json]` lists codex, claude, gh, executor, git, node, npm, bun,
  composio, bw, wacli, gog and neon as found on
  the process PATH (first executable of the name, decision 0140 rule), with the real
  path behind a link and the version the tool reports; missing tools carry their
  official source. Read-only; the version commands never use the network; it does not
  say "outdated", because the operator's version is a fact, not drift. bw writes its
  data file on every start, even for `--version`, so its version command runs with a
  private temporary `BITWARDENCLI_APPDATA_DIR` (the catalog's `isolatedData`, decision
  F43) and touches no profile; Executor's runs with a private `EXECUTOR_DATA_DIR`
  (decision F44), and its wrapper keeps analytics and the update check off.
- `tools update <tool> [--json]` runs exactly that tool's official update path as the
  current user and reports the version before and after: the tool's own updater
  (`claude update`, `bun upgrade`) or the vendor's installer script (`codex`, the
  official standalone installer of `manual/organization-install.md`). composio, which
  Lazurio uses in its own build (F42, addendum (3)), runs its curated installer again
  at that pinned build (updater `curated`, the result names the `installer` instead
  of a `command`), whatever version runs now, in place in `~/.local/bin` and
  `~/.composio` and keeping the sign-in; it refuses to put a second copy beside a
  composio elsewhere on PATH (`preflight`, `installation-elsewhere`), and it is
  `tool-updated` only when `composio --version` then prints that build. Tools without
  an update path (`gh`, `git`, `node`, `npm`) are reported with their official source
  and nothing runs (`tool-not-self-updating`, exit 1). Unknown names exit 2. Apart
  from composio's build it pins nothing; it never downgrades on its own, never touches
  another tool and is not run by `lazurio update` or a Machines apply. The Launchpad
  runs it only when the person clicks "Update" ("Aktualizovat") on a composio that is
  not that build (Settings → Tools, `POST /api/tools/upgrade`). An agent runs it only
  on the Operator's explicit instruction (F17). When Codex changed its version, the result
  carries `next`: a Codex app-server that is already running keeps the old version
  until it is replaced, `lazurio doctor` reports it as `codex-app-server`
  `app-server-outdated`, and nothing is stopped or restarted (F29 addendum, issue
  #173).

### Enabled tools of a Folder (decision 0162, F18)

Agents use what the Folder tells them to use. The catalog marks the tools that may be
named in the generated instructions with a **tier** and a **setup mode**:

| Tool | Command | Tier | Setup |
| --- | --- | --- | --- |
| `gh` | `gh` | required: always on, never stored, cannot be disabled | launchpad |
| `executor` | `executor` | required; offered in a Remote Environment on Linux (F44) | launchpad (Lazurio's own setup, below) |
| `composio` | `composio` | recommended | launchpad |
| `bitwarden` | `bw` | recommended; offered in a Remote Environment on Linux (F43, F53) | launchpad (its own flow, below) |
| `wacli` | `wacli` | optional | launchpad |
| `gogcli` | `gog` | optional; offered on a computer and in a personal Remote Environment, not in a work one (F44) | agent |
| `neon` | `neon` | optional | agent |

Enabling is context for agents. It grants no access, installs nothing, signs in
nowhere and pins no version; a tool may be enabled before it is installed.
**Where a tool is offered** (F44, `toolOffered`): a tool the Environment does not
offer (the table's column) is not rendered for agents, cannot be newly enabled
(`blocked` / `tool-not-offered`), is listed with `offered: false` and the line "not
offered here", and is not missing for doctor. A selection stored before stays
readable and can switch it off; that change is recorded although no generated file
changes. The enabled
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

**What the Organization decides** ([F45](decisions.md#f45--organization-settings-reach-the-environment-asked-through-its-relay-recorded-in-the-folder-reported-back),
root decision 0194). On an Organization's Environment (work, Team, Automated) the
Organization's settings take precedence over the Environment's: where they say
`integrations.composio.allowed: false`, `composio` is not used by agents, whatever the
person chose. The Folder records the settings it applies (`organizationSettings` in
`.lazurio/preferences.json`) and renders the person's selection without the tools the
Organization does not allow, with a line that says why; the selection itself is kept,
so the Organization allowing the tool again brings it back. While it does not, the
person's choice of that tool does not change from any surface (`organization-governed`),
Settings → Tools shows its switch locked off with a sentence that the Organization
decides it, and offers neither adding nor signing in. A personal Environment and the
person's own computer decide alone. How the settings arrive (the Dashboard through the
Environment's relay, or the Organization's root in the Folder) is F45.

**Setup modes.** `launchpad`: installation and login have a curated flow in the CLI
and the Launchpad ([F19](decisions.md#f19--curated-installation-and-login-of-catalog-tools),
below). `agent`: the Launchpad only shows status, and "Set up with an agent" hands the
prepared prompt to an agent who installs the tool and guides the sign-in. Each tool's
`installation` text describes the target state and is the agent's manual in both
modes (for a `launchpad` tool it is what a fallback agent follows when the curated
installer fails). Matěj's reason: many tools can be offered cheaply through the
agent mode, and later usage analytics of which tools Operators try to install with an
agent shows where a curated flow is worth building. The analytics are not
implemented.

The commands are Folder-bound in the style of the profile commands: the Folder is
always explicit, a mutation names the revision it was decided against, the result is
JSON with `--json`, and the exit status is 0 completed or unchanged, 2 blocked or
usage, 1 operation failure.

- `tools list --folder <absolute Folder> [--sign-in] [--json]` lists the activatable
  catalog tools only, in catalog order, each with `tier`, `setup`, `enabled` (the
  recorded choice), `organization` `{allowed}` when the Organization's settings speak
  about it (F45; one it does not allow is not used by agents), its `note` when there
  is one and the live facts of `tools status`
  for that tool (`installed`, `path`, `realPath`, `version`, `standardPath`,
  `source`), plus the Folder `revision` a following mutation must name. Read-only.
  With `--sign-in` each entry also carries `signIn` (below).
- `tools enable <tool> --folder <Folder> --expected-revision <n> [--json]` and
  `tools disable <tool> …` record the selection and re-render the Folder through the
  profile transaction (`updated` with the new revision, or `unchanged`). A name the
  catalog does not offer for activation is `blocked` / `tool-unknown` (exit 2);
  disabling a required tool is `blocked` / `tool-required` (exit 2); enabling a
  required tool is `unchanged` (exit 0); enabling or disabling a tool the
  Organization does not allow here is `blocked` / `organization-governed` with the
  reason in words (exit 2, F45). The planner's refusals arrive unchanged
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
of `lazurio tools prompt <tool>`. `enabled` is the person's recorded choice; agents
use the tool where it is also `offered` (F44) and, where the Organization's settings
speak about it, `organization: { allowed }` does not refuse it (F45), so a choice the
Organization refuses is kept for when it allows the tool again. On an
Organization's Environment the answer also carries
`organizationSettings`: where the settings come from (`dashboard` or `repository`), the
version applied, when, when the source last answered, the last error and the keys that
did not apply. With `signIn: true` (the first reading and "Refresh status") the
Launchpad first asks the Organization's settings and waits for them up to five
seconds. `mcpPrompt` is the prepared prompt for the third
route, an MCP server set up by an agent. Without `signIn: true` the probe runs each
found tool's version command and nothing else, and uses no network. The raw output of
a tool is not returned, and the request accepts no Folder, PATH or tool name. The
facts are those of the PATH and home of the Launchpad process. The installed
service unit sets that PATH to `~/.local/bin:/usr/local/bin:/usr/bin:/bin`
(`Environment=PATH=%h/.local/bin:…`, [product update](update.md#state-on-disk)), so
it sees the standard path first, as an operator's login shell with `~/.local/bin`
on PATH does; a tool only on another directory of the interactive PATH is not
seen there.

**Sign-in state** ([F18 addendum](decisions.md#f18--enabled-tools-of-the-environment)).
With `signIn: true` (the page sends it on load and on "Refresh status") or
`tools list --sign-in`, each installed tool's catalog sign-in probe runs as well:
for gh `gh auth status --json hosts` (gh 2.81.0 and later) and, for an older gh that
does not know `--json` there, `gh auth status --hostname github.com`; `composio
whoami`, `wacli auth status --json --read-only`, `gog auth list --check --json
--no-input`, `neon me -o json`. These may
contact the tool's provider to verify its token, which is why they run only on
request. They run in parallel, 10 s each, with only `PATH`, `HOME` and `XDG_*` in their
environment. `signIn` is `{ state: "signed-in" | "signed-out" | "unknown", account?,
organization? }`: signed in when the probe exits 0 and its rules hold (composio exits
0 also when not logged in and counts as signed in only with its JSON line and a
non-empty email; wacli wraps its answer as `{"success":true,"data":{"authenticated":…,
"linked_jid":…,"phone":…},"error":null}` and counts as signed in only when
`data.authenticated` is `true`, with `data.phone`, else `data.linked_jid`, as the
account (#98: the probe read these fields at the top level before and so reported every
paired wacli as not signed in)), `unknown` for a tool not installed, a timeout or unreadable output.
`account` and `organization` (composio's current organization) are the only things
taken from the output, as plain text of at most 120 characters; the output itself is
never returned or logged. A signed-in gh also carries `ssh` ([F19 addendum
2026-09-28](decisions.md#f19--curated-installation-and-login-of-catalog-tools)):
`{ state: "linked" | "not-linked" | "unknown", reason?, fingerprint? }`, from the
`.pub` of this Machine's default key and one call of `gh api "user/keys?per_page=100"`
(`not-linked` with `no-key` or `not-registered`; `unknown` with `scope-missing` when
the token cannot read keys, or `unreadable`). The private key is not read and nothing
connects over SSH on a status call. gh's JSON status is asked for exactly one field,
`hosts`, and never with `--show-token`, so gh leaves the token out; only the active
github.com entry's `state`, `login`, `tokenSource` and `scopes` are read (with `--json`
gh always exits 0 and `state` says `success`, `error` or `timeout`). A signed-in gh
carries `identity` as well, read from the same answer: `person` (a user account whose token gh stores itself, in its
keyring or its hosts file: what a sign-in leaves and `gh auth logout` removes), `app`
(a GitHub App's own identity: a `…[bot]` login or an installation token `ghs_…`),
`variable` (a token from `GH_TOKEN`, `GITHUB_TOKEN` or another `*_TOKEN` variable,
which `gh auth logout` cannot remove) or `unknown`. The account label keeps a `[bot]`
suffix. On a Team Environment the gh line says "uses Lazurio for GitHub" instead of the
state of an SSH key, and the Organization's App identity reads "works as
lazurio-for-github[bot]" instead of "signed in as" ([below](#gh-on-a-team-environment)).

The Tools section itself is described in
[launchpad-development.md](launchpad-development.md#tools-section).

### Curated installation and login (decision F19)

For the `launchpad` tools (`gh`, `composio`, `wacli`) on Linux and macOS, x64 and
arm64, and the sign-in of the AI CLIs `codex` and `claude` (F19's addendum of
2026-10-15, below). CLI first; the Launchpad serves the same core. The tools set up by
an agent (`gogcli`, `neon`) are refused with a pointer to `lazurio tools prompt
<tool>`.

- `tools install <tool> [--json]` installs for the current user, without root, into
  `~/.local/bin/<command>` from the official source at the latest release. `gh` and
  `wacli`: the GitHub release archive for the platform, verified against the SHA-256
  in the release's checksums file before it is read, every archive entry checked
  (absolute names, `..`, escaping links and special entries refuse the archive), only
  the binary placed, atomically, 0755. `composio`: Lazurio's build of the CLI (F42,
  addendum (3)), installed by Composio's installer from Lazurio's fork, pinned by
  commit (`https://raw.githubusercontent.com/Lazurio/composio/<installerCommit>/install.sh`,
  immutable), downloaded into a private file first, then run with
  `COMPOSIO_INSTALL_PLUGINS=0 COMPOSIO_INSTALL_SHELL=none COMPOSIO_INSTALL_HELP=0
  COMPOSIO_GITHUB_OWNER=Lazurio COMPOSIO_GITHUB_REPO=composio
  COMPOSIO_INSTALL_VERSION=@composio/cli@0.4.3-lazurio.1` and the target's
  `COMPOSIO_INSTALL_SHA256` (of the archive the installer downloads: on macOS an x64
  process that Rosetta 2 translates gets the arm64 one, as its `detect_target` chooses;
  bundle in `~/.composio`, link in `~/.local/bin`, no agent
  plugins, no shell files). The installer refuses any archive but the pinned one, and
  a missing checksum, before it extracts or replaces anything (`installer`: nothing
  changed); only exactly that version afterwards is installed (`verify`,
  `version-mismatch` otherwise, what then runs staying).
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
  --idle-exit 30s`), or with `--phone` the pairing code. wacli prints these as
  `--events` NDJSON on stderr whether or not it has a terminal, so the sign-in works
  from a Launchpad that runs as a service; the tool gets no terminal (stdin is
  `/dev/null`, stdout and stderr are read). The code or link is opened on
  any device; nothing is typed into Lazurio and no key is copied. It waits until signed
  in (confirmed by the tool's sign-in probe), failed or expired (gh 15 minutes,
  composio 10, WhatsApp pairing 5); Ctrl-C cancels and kills the tool's process group.
  A wacli that reports `connected` without a QR or pairing code first was paired
  before: once its probe confirms it the sign-in ends at once as `signed-in` with
  `already: true` ("already signed in", nothing paired or changed) and the process
  finishes its sync to its own idle exit (#98). Only the probe confirms: when it has not
  confirmed 20 s after `connected` (retried every 2 s) and no code was shown, the
  process is killed and the sign-in fails as `not-confirmed`. A tool that shows no
  link, code or QR code within a minute is killed and the sign-in fails as
  `no-challenge` (or `not-confirmed` after `connected`), instead of waiting out its
  lifetime; a session that has shown a code keeps its lifetime; a tool that is
  not found fails as `not-installed`, one that cannot be started as `spawn-failed`,
  and one that exits before it is signed in as `tool-exit`.
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
- **gh sets the person's Git identity where git has none** (F19 addendum 2026-10-14):
  after the SSH key step, whatever its outcome, each of `user.name` and `user.email`
  that neither git's global nor system configuration names is written with `git config
  --global` from `gh api user`: the profile's name, else the login, and
  `<id>+<login>@users.noreply.github.com`. Right before each field's write the Team
  rule is asked again and the field is checked again: an existing value is never
  changed (one set meanwhile is skipped), a check that cannot answer writes nothing
  more, and a Team Environment never gets here. The result carries `gitIdentity`:
  `{ state: "present" }` (nothing written), `{ state: "set", fields, identity,
  incomplete? }` (`fields` is exactly what was written; `incomplete: { reason, missing
  }` with `write-failed` or `config-unreadable` when a later field was not), or `{ state:
  "not-set", reason, missing? }` (this step wrote nothing; `git-missing`,
  `config-unreadable`, `viewer-unavailable`, `write-failed`). A later sign-in adds only
  what is still missing. It does not change the exit code.
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
- **`tools login codex` and `tools login claude`** (root decision 0201 points 3-6, F19's
  addendum of 2026-10-15) run the CLI's own browser sign-in, `codex login` (never
  `--device-auth`) and `claude auth login`, as the current user with the minimal
  environment and the account's name (`USER`, `LOGNAME`). They are no catalog tools of
  agents: `tools list` does not show them and `install` and `logout` refuse them as
  before. Where the sign-in page opens:
  - On a Remote Environment whose entry routes the Environment browser, the CLI's
    `BROWSER` is a private stand-in (`$TMPDIR/lazurio-sign-in-*/browser`, 0700) that
    hands the address the CLI opens to the sign-in; both CLIs run `$BROWSER <page>`
    also without a display. Only an https page on the CLI's official hosts
    (`auth.openai.com`; `claude.com`, `claude.ai`, `platform.claude.com`,
    `console.anthropic.com`) is opened; any other address stops the CLI
    (`unexpected-url`). The command opens it as `lazurio browser open` does (in a T3
    Code thread in the thread's panel, elsewhere in Přehled and by the link it prints),
    the Launchpad as a tab it holds, shown in its right panel. The page returns to the
    CLI on 127.0.0.1 inside the Environment. Claude's printed address is its code page
    (`redirect_uri=https://platform.claude.com/oauth/code/callback`); it opens only
    when the CLI hands over no page within 3 s, and the code it shows (`<code>#<state>`)
    then goes to the CLI's input, pasted in the terminal or in the Launchpad's field.
    A browser that does not open the page stops the CLI (`browser-unavailable`).
  - On a computer of one's own nothing is set: the CLI opens the computer's browser,
    and the printed page is offered beside it (`challenge: { kind: "page", url, code
    }`; on a Remote Environment `{ kind: "page", view, code }`, never the page).
  - Nothing starts on a Remote Environment without the Environment browser (`blocked`,
    `no-environment-browser`, exit 2), nor codex where Codex's own `account/read`, asked
    afresh right before `codex login` and never from a reading kept for the page, says
    its provider needs no OpenAI sign-in, the Organization's AI pool (`blocked`,
    `organization-provided`, exit 2). An `account/read` that cannot be read starts
    nothing (`failed`, `provider-unknown`, exit 1). A hosted context that cannot be read
    fails as `environment-unreadable`.
  - Signed in is what `codex login status` and `claude auth status --json` (the
    catalog's `signInProbe`) say after the CLI exited 0; otherwise `tool-exit` or
    `not-confirmed`. Then, pending with `step: "services"`, the running services read
    the sign-in, and `signed-in` carries `services`: `appServer` (codex only:
    `systemctl --user restart lazurio-codex-app-server.service` where that unit is the
    installer's; `restarted`, `not-managed` or `failed`) and `t3` (`t3 lazurio providers
    --base-dir ~/.t3 '{"providers":[…],"enable":true}'` with every AI CLI signed in now,
    where `t3 lazurio capabilities` reports `providerRefresh: true`; `refreshed` with
    each provider's state when the answer names an enabled instance of every CLI asked
    about (one still checking its sign-in counts), `not-installed`, `not-supported`,
    `driver-mismatch` with the instance that runs another driver, or `failed` with
    `not-enabled` and the CLIs it did not turn on, `not-running`, `refused`,
    `unreadable` or `timeout`). Exit 0 only when signed in and neither the restart nor
    T3 Code failed; 1 otherwise. The sign-in lives 10 minutes.

The Launchpad offers the same over `POST /api/tools/install {tool}`,
`/api/tools/login/start {tool, phone?}`, `/api/tools/login/poll {tool, session}`,
`/api/tools/login/cancel {tool, session}`, `/api/tools/login/code {tool, session,
code}`, `/api/tools/logout {tool}`, `/api/tools/composio/organizations {}` and
`/api/tools/composio/organization {id}`, with the admission, exact-field JSON and
`Cache-Control: no-store` of every route. codex and claude take only the login routes;
`code` hands a code of Claude's code page to the waiting CLI (`{kind:
"code-accepted"}`, `400` for anything but a whole `<code>#<state>`, `409` where no
sign-in waits for one), and a refused start (`blocked`) answers `409`.
`start` answers with the session handle and the first challenge; `poll` and `cancel`
take that handle, so a challenge goes only to the browser that started the login. A
pending WhatsApp login carries `qrSvg`, the QR code drawn by the server. A tool the
catalog does not know, or an `agent` tool, is `409 blocked`. `start` takes `sshKey:
true` for gh only ("Link SSH key"; anything else with it is `400`), and a pending gh
login says `step: "ssh-key"` while the key is being linked. No answer carries private
key content or a public key's blob; only the key's path and SHA-256 fingerprint.

A challenge is never written to a log, a file, the Folder or an error. The Launchpad
writes one JSON line to its journal (the unit's journal on a Machine) when a sign-in
starts and one when it ends: `{"scope":"tools-login","tool":"wacli","event":"start"}`
and `{"scope":"tools-login","tool":"wacli","event":"end","outcome":"failed","reason":"no-challenge"}`,
with the tool, the outcome (`signed-in`, `failed`, `blocked`, `expired`, `cancelled`)
and the fixed reason code only; never the tool's output, a challenge or an account.
The tools keep
their own pending state in their own stores (composio's pending login in
`~/.composio`), which is the tool's custody and is not copied anywhere. On a shared
Environment (the Team preset) a composio or wacli login belongs to the whole
Environment, and the Launchpad and `tools login` say so before it starts; gh is not
signed in there at all (next section).

#### gh on an Automated Environment

On the Steward preset (`hosted-organization-steward`, the Automated Environment of
upstream decision 0169) the curated gh sign-in and SSH key linking are offered, as on
a Work Environment. The account signed in is the persona's own GitHub user account
(a bot account), not the operator's: the responsible operator runs `lazurio tools login gh`
or the Launchpad's sign-in, chooses the persona's account in the device flow and
keeps its two-factor authentication and recovery codes outside the Environment. The
rendered Folder states this rule; the gate does not compare accounts
([workspace presets](workspace-presets.md#the-steward-preset-automated-environment)).

#### gh on a Team Environment

Matěj's decision 2026-09-28 ([F19 addendum](decisions.md#f19--curated-installation-and-login-of-catalog-tools)):
there are three kinds of Environment, Personal, Work (one Operator) and Work Team
(`hosted-organization-team`, shared by several Operators). A Team Environment works in
GitHub through the GitHub App "Lazurio for GitHub" installed under the Organization;
a person's account is not signed in there and a person's SSH key is not linked. The
earlier temporary exception that let any account sign in on a Team VM has ended.

- `tools login gh` and `tools login gh --ssh-key` are refused before anything runs:
  `{ kind: "blocked", reason: "team-environment", tool: "gh", action: "login" |
  "ssh-key" }`, exit 2, and the sentence "This Team Environment works in GitHub through
  Lazurio for GitHub, set up by the Organization. Personal GitHub accounts are not
  signed in here." (Czech on the Launchpad: "Tohle týmové Environment pracuje v GitHubu
  přes Lazurio for GitHub, které nastavuje Organizace. Osobní účty GitHubu se tady
  nepřihlašují."). `/api/tools/login/start` (with or without `sshKey`) answers the same
  object with `409`, like every other refusal of these routes; `/api/tools/login/poll`
  of gh cancels the session and answers it too; `cancel` stays allowed.
- `tools logout gh` and `/api/tools/logout` stay allowed exactly when gh's active
  account is a person's (`identity: "person"`): removing a personal account left on a
  shared Machine by the ended exception is what the rule wants, and the sign-out
  removes the SSH key Lazurio registered for this Machine as everywhere else. A GitHub
  App identity, a token from a variable, a gh that is not signed in or a sign-in whose
  kind gh does not tell is never signed out: `blocked` / `team-environment` with
  `action: "logout"` and the sentence "Only a personal GitHub account left signed in
  here is signed out, and gh reports none; Lazurio does not sign out the Organization's
  GitHub identity." The Launchpad offers "Sign out" on the Team gh row only in that
  case, with the same rule (`src/tools/team-github.ts`).
- A session started before the Environment became a Team one does not finish: before
  every step that changes the account or the Machine (the end of the device flow, a
  scope refresh, the start of the key linking, the key's creation, its registration,
  `known_hosts`, the final "signed in") the session asks the rule again and ends as
  `{ kind: "blocked", reason: "team-environment", tool: "gh", action }` when the
  preset is now Team. A profile update in the Launchpad that makes its Folder a Team
  Environment ends a running gh session at once, and a `poll` answers the refusal. A
  preset the Launchpad cannot read ends the session as `failed` /
  `environment-unreadable`.
- composio and wacli are unaffected: allowed, with the shared sign-ins warning.
- **How the kind of Environment is known.** The Launchpad serves one Folder and reads
  its recorded preset on each of these requests (a profile change may switch it while
  it runs). `tools login` and `tools logout` take no Folder: on a hosted Machine they
  read the preset of the declared operator's Folder, found from the root-issued
  handover `/etc/lazurio/lazurio.machine.json` and the effective account exactly as
  `lazurio update` finds it. The handover alone does not decide it (an ambiguous
  handover derives no preset, and the operator may choose another allowed preset), the
  Folder does. Only where there positively is no such Folder (not Linux, no handover
  at all, or a valid handover whose operator is another account) do the commands
  behave as on a workstation. A hosted context that is there but cannot be read is
  never a workstation (#83): a handover that is unreadable, in unsafe custody,
  malformed or off the schema, an operator record that cannot be resolved, a declared
  Folder that is missing, or whose state or preferences are missing or malformed.
  Then gh's `tools login` (with or without `--ssh-key`) and `tools logout` stop before
  gh runs with `{ kind: "failed", tool: "gh", reason: "environment-unreadable" }`,
  exit 1; nothing is signed out or removed. A running gh session reads it again before
  each step above and ends the same way when it can no longer be read, also when the
  hosted Folder it found at the start is no longer found; an external device flow
  already approved is not undone. composio and wacli, `tools install` and
  `tools prompt` are not gated and keep their workstation texts. `tools list --folder`
  reads the named Folder.
- **The Organization's brokered gh.** On a Team Machine gh is normally the
  Organization's brokered wrapper, which of all `gh auth` commands answers exactly
  `gh auth status --json hosts`, as `lazurio-for-github[bot]`. The JSON status reads it
  as signed in with `identity: "app"`: the Launchpad row says "Works as
  lazurio-for-github[bot] · Uses Lazurio for GitHub" ("Pracuje jako
  lazurio-for-github[bot] · Používá Lazurio for GitHub"), `tools list --sign-in` says
  "works as lazurio-for-github[bot], uses Lazurio for GitHub", no sign-out is offered
  and a logout is refused.
- **Installing gh there.** `tools install gh` installs as everywhere, but ends with the
  sentence above instead of "Next: lazurio tools login gh". The Launchpad's Team gh row
  offers "Install" ("Nainstalovat") only while gh is missing, never "Install and sign
  in"; its notice says what was installed and the same sentence.
- **The agent prompt.** `lazurio tools prompt gh` reads the hosted operator Folder's
  preset like `login` does. On a Team Environment it prints gh's Team target state
  instead of the sign-in and the SSH key: a working `gh` on PATH (normally the
  brokered one, which stays as it is), installed from the official source only when
  none works, and "Do not sign in gh or link a key: the Environment works in GitHub
  through Lazurio for GitHub, set up by the Organization." Where the kind is not known
  the prompt keeps the sign-in steps and adds "On a Team Environment
  (hosted-organization-team) do not sign in gh or link a key: the Environment works in
  GitHub through Lazurio for GitHub, set up by the Organization." (Czech: "V týmovém
  Environmentu (hosted-organization-team) gh nepřihlašuj a klíč nepropojuj: Environment
  pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace."). The
  Launchpad of a Team Folder hands the Team prompt, so its "Set up with an agent"
  fallback is shown on the gh row again.
- **Known limits.** A personal account stored behind an active broker token is not the
  active account, is not offered for sign-out and is removed by hand; a personal token
  in `~/.config/gh` of a Machine whose gh is the wrapper is out of this sign-out's
  reach. gh stores a sign-in when its code is approved: a preset switched by another
  process while the operator approves is seen only afterwards, so no key is linked but
  the person's account is then signed in there and offered for sign-out. Another
  account than the declared operator on a hosted Machine has no hosted Folder and is
  treated as on a workstation.
- **Not built.** The path through Lazurio for GitHub is not part of the Platform:
  nothing here provisions the App, its broker or a brokered `gh`. The product refuses
  the personal sign-in and relies on what the Machine delivers.

### The Environment's own vault (decisions F43 and F53)

Root decision 0198: every Environment owns its vault, its own organization in its
network's Lazurio Vaultwarden, created by its technical account, which is its only
Owner, and remembered by ID (decision F53 supersedes F43's collection model; F43's
pinned CLI, custody and one shared session stay). The account and the vault come from
the handover's member `vault: {server_url, account, name}` (DEV-6631 contract C2),
which Machines writes only for a Platform that reads it; without it a work, Team or
Automated Environment has no vault yet (`unsupported`, `no-vault`). A personal
Environment whose handover names no vault keeps its vault in its person's own
Bitwarden instead (root decision 0203 point 7, [F53's amendment of
2026-10-16](decisions.md#f53-amendment-of-2026-10-16-a-personal-environments-own-bitwarden),
below): until the person connects it, it is `needs-connection`. The catalog tool is
`bitwarden` (command `bw`); it has its own flow instead of F19's install and sign-in,
which refuse it as `setup-vault`. Remote Environments on Linux only; on this computer
it is the second wave (`unsupported`, `workstation`).

- **Facts** (`src/vault/context.ts`, read from the handover for every operation): the
  vault `vault.server_url`, the account `vault.account`
  (`vaultwarden-<26 base32>@<Environment address>`, which the network generated and
  pre-allowed for this Environment alone), the vault's name `vault.name` and the
  Organization that owns a work Environment (`owner.organization`; none for a personal
  one). Nothing is derived from the tailnet or the address any more, and no collection
  is matched by a name. Only the handover's declared operator has the account
  (`not-operator`).
- **Custody** (`src/vault/store.ts`), written by the Platform itself, the one
  exception of [public development](public-development.md):
  `${XDG_STATE_HOME:-~/.local/state}/lazurio/vault/<vault host>/<account>/`
  (0700, keyed by the account, so an account the handover replaces starts afresh and
  a 0197 pilot's directory, keyed by its address, stays beside it) with `lock` and
  `bw/` (0700, `BITWARDENCLI_APPDATA_DIR`), which holds bw's `data.json`,
  `lazurio-account.json` (0600: email, server, device identifier, master password, API
  key, createdAt), `lazurio-session` (0600), `lazurio-vault.json` (0600, not
  secret: the vault's organization id, Agenti's collection id, and a creation's
  receipt with its time while it is unresolved), on a work Environment
  `lazurio-assignment.json` (0600, not secret: the fingerprint of the assignment its
  Správci were added under, F53's addendum of 2026-10-14), and `requests/` (0700) with
  one `<id>.json` (0600) per agent's secret request (decision F54), never a value. A
  record that is there but cannot be read refuses (`record-unreadable`): nothing is
  ever created over it. An account file whose account or vault is not the handover's
  is refused by every operation (`account-mismatch`). Nothing else anywhere; no secret
  on argv, in a log, the journal or an error.
- **The pinned CLI** (`src/vault/pin.ts`, `src/vault/install.ts`): bw-oss 2026.7.0
  from `https://github.com/bitwarden/clients/releases/download/cli-v2026.7.0/`,
  the zip of the platform verified against its SHA-256 in the source, its one entry
  `bw` placed as `${XDG_DATA_HOME:-~/.local/share}/lazurio/tools/bitwarden/2026.7.0/bw`
  (0755, alone in its directory: a `bw-data` beside it would override the data
  directory and refuses). `~/.local/bin/bw` is Lazurio's wrapper: it runs that binary
  and sets `BITWARDENCLI_APPDATA_DIR` to the Environment's `bw/` and
  `BW_NOINTERACTION=true` unless the caller set them, so a bare `bw` never reaches a
  default profile or prompts for a password. An entry there that is not Lazurio's is
  left alone and the setup fails as `entry-conflict`. Older pinned versions are
  removed afterwards.
- **The account** (`src/vault/register.ts`): a password of 32 random bytes and a
  device identifier are written to `lazurio-account.json` before anything is sent;
  `POST /identity/accounts/register/send-verification-email` `{email, name,
  receiveMarketingEmails: false}` with `Accept: application/json` answers the
  registration token (a JSON string, or `text/plain` from 1.37.4 without that
  header; 204 means SMTP is on: `smtp-enabled`; "Registration not allowed or user
  already exists": `not-allowed`, and the account file goes when its password was
  generated in the same run, never a resumed one); `POST
  /identity/accounts/register/finish` with the v1 account keys (PBKDF2-SHA256 600 000,
  the salt the trimmed lowercased email, an RSA-2048 key pair, the user key wrapped by
  the stretched master key); `POST /identity/accounts/prelogin`, `POST
  /identity/connect/token` (password grant with the one device identifier) and `POST
  /api/accounts/api-key`, whose key joins the account file. HTTP 429 is
  `rate-limited`; nothing retries a login.
- **The vault** (`src/vault/organization.ts`): `POST /identity/connect/token` with
  `grant_type=client_credentials` (the API key, the one device identifier), `GET
  /api/accounts/profile` for the organizations the account is a confirmed member of,
  then by the record: the recorded organization (renamed with `PUT
  /api/organizations/<id>` `{name, billingEmail}` when its name is not `vault.name`;
  gone: `revoked`, never replaced), or a new one with `POST /api/organizations`
  `{name, billingEmail, key, keys: {publicKey, encryptedPrivateKey}, collectionName,
  planType: 0}`: a new organization key of 64 random bytes RSA-OAEP-SHA1-encrypted to
  the account's own public key (derived from its own private key, which the master
  password unlocks), the organization's RSA-2048 key pair with its private key
  wrapped by the organization key, the billing e-mail the account, and the first
  collection "Agenti", its name encrypted with the organization key. The new
  organization's public key is recorded with the time before the request as its
  receipt, and while it is unresolved no setup sends another creation: each looks for
  the organization that carries the key among the account's memberships of any status
  (`GET /api/organizations/<id>/public-key`) and records it once its membership is
  confirmed; found nowhere, the setup is `creating` and the next one looks again (an
  answer that was lost, a profile that lists it late, a request that arrives late).
  Only a receipt older than 15 minutes (`receiptBoundMs`; a request takes at most
  30 s) that still matches nothing is discarded (journal `receipt-expired`) and the
  vault created anew, once. A creation refused by the vault's answer (4xx but 429)
  discards its receipt at once. Agenti is the organization's one collection by its ID (`GET
  /api/organizations/<id>/collections`); several, without a record of it, are
  `collection-unknown`, never chosen by a name. A vault that does not let the account
  create organizations (`ORG_CREATION_USERS`) is `organization-refused`; a refused API
  key is `revoked`.
- **bw** (`src/vault/bw.ts`): always the pinned binary with the account's
  `BITWARDENCLI_APPDATA_DIR`, `BW_NOINTERACTION` and `--nointeraction`. bw rewrites
  its store on every start, so `bwCli` refuses to start without an absolute data
  directory and a binary by its path, and sets the directory last on every run; the
  version probe of Settings → Tools runs a `bw` on PATH with a fresh temporary one
  (the catalog's `isolatedData`). No bw of this product reaches a default profile,
  a person's own included. `bw config
  server`, `bw login --apikey` (the key in `BW_CLIENTID`/`BW_CLIENTSECRET`; the session
  it prints is still locked and is never read), `bw unlock --passwordfile <private
  file> --raw` (the file removed at once), `bw sync`, `bw list
  organizations|collections|items`, for the Správci `bw list org-members
  --organizationid <id>` and `bw confirm org-member <id> --organizationid <id>`, and,
  for a secret request (decision F54), `bw create item` with the encoded item on its
  standard input (never on argv), each with the session in `BW_SESSION`. bw's output
  never leaves the module (`bw create item` prints the whole item; only its id is
  read); failures are fixed codes (`locked`, `unauthenticated`,
  `unreachable`, `rate-limited`, `invalid-credentials`, `logout-required`, `timeout`,
  `spawn-failed`, `unreadable`, `failed`).
- **States** (`src/vault/flow.ts`, `kind: "vault-status"` with `vault`, `account`,
  `name`, `team` and `origin`, `own` or `pilot-0197`): `unsupported` with a reason,
  `not-set-up` (`next`: `install`, `account`, `vault` or `sign-in`), `creating` (a
  creation's receipt not resolved yet; the start sets it up again), `not-allowed`
  (the network has not pre-allowed the address, or removed an unused pre-allowance),
  `connected` (`organizationId`, `collectionId`, `organization`, `items`; `locked`
  when the session must be unlocked again), `revoked`, `unreachable` (`reason`) and
  `failed` (`stage`: `install`, `account`, `vault`, `sign-in`, `sync` or `status`;
  `reason`; `fallback: "agent"`). `status` is local (bw's copy, no network); `refresh`
  syncs first and unlocks again when the session is no longer the unlocked one;
  `setup` installs, registers or resumes the account, creates, recognizes or renames
  the vault, signs bw in, unlocks and syncs, and is safe to run again. A bw profile
  signed in to anything but the account at its vault is never used (status
  `not-set-up`, `next: "sign-in"`; env refuses); a setup signs it out and the account
  in. Mutations hold the account's kernel lock.
- **CLI** (`lazurio vault`): `env [--json]` prints `export BITWARDENCLI_APPDATA_DIR=…`,
  `BW_SESSION`, `LAZURIO_VAULT_ORGANIZATION_ID` (the vault) and
  `LAZURIO_VAULT_COLLECTION_ID` (Agenti), single-quoted, for `eval "$(lazurio vault
  env)"`; not set up, one line on stderr, nothing on stdout, exit 2 (`busy` and
  `unlock-failed` exit 1). `status`, `refresh` and `setup [--json]` print the state
  (setup: exit 0 connected, 2 waiting for a person: no vault named, not allowed,
  revoked or unsupported; 1 failed or unreachable; its steps go to stderr). `status`
  is the one source of truth for agents and the Launchpad. `request --item <name>
  --need <what> --why <why> --where <where in the service> --field <Name>[:secret]
  ... [--json]` asks a person for a secret (decision F54) and prints the request's id
  and its page `<external origin>/settings/vault/requests/<id>`; `request status <id>`
  answers `pending`, `saved` (with the item's name) or `declined`, `request list`
  every request (exit 0, 2 refused, 1 a failure).
- **Launchpad**: `POST /api/tools/bitwarden/status|refresh` with `{}`, and `POST
  /api/tools/bitwarden/setup` with `{}` (starts or joins the one setup) or `{job}`
  (asks about it): `202 {kind: "vault-setting-up", job, phase}` while it runs
  (`install`, `account`, `vault`, `sign-in`), then the state; status and refresh
  answer a running setup the same way. An unknown job is `404 job-unknown`. The
  installed Launchpad of a supervised base of the hosted operator (`vaultAtStart`, the
  rule of Executor's) runs the setup in the background after its start where
  `setUpAtStart` says the vault needs it: not set up, its session locked, or its name
  no longer the handover's; never a 0197 pilot, a revoked or failed vault. The setup
  in which the vault becomes ready (its collection Agenti recorded, `outcome:
  "ready"`) turns "Používají agenti" on for `bitwarden` in the Folder
  (`enableVaultForAgents`, `src/vault/host.ts`, also for `lazurio vault setup`): the
  switch's own change at the current revision, refused as the switch is where the
  tool is not offered or the Organization does not allow it. Once per vault, so a
  person who turns it off keeps it off; a failure is journaled (`agents-not-enabled`),
  never the setup's. The journal of the unit gets
  `{"scope":"tools-vault","operation":"setup|refresh|unlock|vault|secrets|request","outcome":…,"reason":…}`
  (with `"trigger":"start"` for the start's setup) only. An agent's secret request
  (decision F54) is answered on Nastavení → Trezor (`/settings/vault`, "Žádosti
  agentů") and its own page `/settings/vault/requests/<id>` over `GET
  /api/vault/requests`, `GET /api/vault/requests/<id>`, `POST
  /api/vault/requests/<id>/save {values}` and `POST /api/vault/requests/<id>/decline
  {}`, behind the same admission (same origin for a write); any admitted person
  answers, without an account in the vault, and a save writes exactly one Secure note
  into Agenti.
- **The vault page and its Správci** (F53's addendum of 2026-10-14,
  `src/vault/members.ts`): Settings → Vault (`/settings/vault`, "Trezor") shows the
  rule, the vault's name and state, and "Přidat položku" and "Otevřít trezor", or
  "Vytvořit účet v trezoru" while the person has no account in the network's vault
  and the vault takes the Lazurio sign-in (`GET /identity/sso/prevalidate`). `GET
  /api/vault` is the page, `POST /api/vault/membership` `{}` adds the person the
  gateway admitted (whom its own answer names, F11's amendments) on a personal or
  work Environment whose handover names a vault (a personal Environment in its
  person's own Bitwarden invites that person instead, below):
  `<username>@account.lazurio.ai`, the address of the Lazurio
  username that answer carries (root decision 0203, F53's amendment of 2026-10-16),
  invited as an Admin through the vault's API and confirmed with bw once accepted,
  only where the network's vault refuses every password path of the address
  (`SSO_ONLY`, asked of its token endpoint: "SSO sign-in is required"); elsewhere
  nobody is invited or confirmed (`sign-in-not-required`), and a pending invitation
  (`awaiting-password`) is safe. A person named without a valid username is added
  nowhere (`no-username`), and the page asks them to sign in again. A work Environment's Admin-type members all leave when
  its assignment changes; the Owner and other roles are never touched; a personal
  Environment never removes; a Team or Automated one neither adds nor removes yet.
  The installed hosted Launchpad also looks at the assignment after its start and
  every five minutes. The journal says `operation: "members"` with a fixed outcome,
  never an address, a member id or a token.
- **Runtime secrets** (decision F46 as F53 amends it, `vaultSecrets` in
  `src/vault/flow.ts`): on a work Environment the applications of the Organization
  that owns it read them, on a personal one the Personalspace's modules (root decision
  0198 point 4); another Organization's application is `other-organization`, a
  Personalspace module on a work Environment `personalspace`, an Organization's
  application on a personal one `personal-environment`. They are read through the
  same one session as `env`: `bw sync`, then `bw list items --organizationid <id>`,
  of which `secretItems` keeps only the items of the declared names, and of those
  only name, organization, collections, login password and, of a Secure note, how many
  hidden fields it has and the value of the only one. A value is the password of the
  one item named exactly so anywhere in the Environment's vault, or the one hidden
  field of a Secure note (decision F54: what an agent's secret request becomes; two
  hidden fields are `ambiguous`), otherwise `missing`, `ambiguous` or `empty`. Values
  go to the caller only; a refusal is a
  fixed code (`workstation`, `no-vault-identity`, `personalspace`,
  `personal-environment`, `other-organization`, `not-connected`, `locked`, `busy`,
  `unreachable`, `vault-failed`).
- **0197 pilots** (`src/vault/legacy-0197/`, frozen): an Environment connected the
  F43 way whose handover names no vault yet keeps working read only: its status, the
  shared session for agents and F46 from the collection it recorded, with F46's rule
  of 0197. It is never set up, connected, confirmed or disconnected; its directory is
  left untouched once the handover names the own vault, for DEV-6631 task 649 to move
  its items. Its README names the condition of its deletion. A personal Environment
  whose pilot was never connected (`pilotConnected`) connects its own Bitwarden.
- **A personal Environment's own Bitwarden** (root decision 0203 point 7, F53's
  amendment of 2026-10-16, `src/vault/connection.ts`, `src/vault/invitee.ts`): the
  vault is a free organization in the person's own Bitwarden, in the cloud's EU or US
  region (`src/vault/endpoints.ts`, an allow-list: web `https://vault.bitwarden.eu`,
  API `https://api.bitwarden.eu`, identity `https://identity.bitwarden.eu`, and the
  same on `bitwarden.com`), owned by a separate agents' account, never the person's
  main account. While nothing is connected the state is `needs-connection` and
  nothing runs (no setup at the start, `env`, secrets, requests and the membership
  `not-connected`, `vault setup` exit 2). The person creates the agents' account in
  the same service and region as their own and its API key (Account settings →
  Security → Keys → API key) and enters the region, `client_id`, `client_secret`, the
  agents' master password and the e-mail of their own Bitwarden account once in
  Settings → Vault (`POST /api/vault/connect`, exactly those keys, at most 16 KiB,
  same origin). The Environment signs in with the API key at the region's identity
  host (never the password grant: API-key sign-ins are exempt from new-device
  verification), reads the agents' address from the profile, refuses the person's own
  address (`same-account`) and an account that owns or administers another
  organization (`owns-organization`), and opens its keys with the cloud's KDF,
  PBKDF2-SHA256 or Argon2id (`wrong-password`, `unsupported-kdf`,
  `unsupported-keys`). Only then does it write the account whole into its custody
  (`<state>/lazurio/vault/vault.bitwarden.eu/<agents' address>/bw/lazurio-account.json`,
  0600) and the connection (`<state>/lazurio/vault/personal/connection.json`, 0600:
  region, agents' account, the person's address) and start the setup: the pinned
  `bw` signed in with `bw config server <web vault>` and `bw login --apikey`, the
  organization "Osobní <login>" with Agenti created on the cloud's API
  (`useSecretsManager: false`; a second Free organization is
  `free-organization-limit`), and the person invited as a User with Manage on Agenti,
  never an Admin (the cloud allows one Free organization per Owner or Admin). The
  cloud e-mails the invitation; once accepted, the next setup or look of the page
  confirms the person with `bw confirm org-member` (`invitation-pending`,
  `accepted`, `member`, `revoked`). "Odpojit Bitwarden" (`POST /api/vault/disconnect`)
  signs bw out and removes the credentials, the session and bw's data, keeps the
  record and the requests and never deletes the organization; the same account
  connected again finds its vault. The journal says `operation: "connect"` or
  `"disconnect"` with a fixed outcome and reason, never a value or an address.

The agents' texts are the catalog entry's (`purpose` in `AGENTS.md`, `usage` in
`manual/this-machine.md`) and the manual's Secrets (`manual/working-here.md`),
template revision `base-instructions-50` (since `base-instructions-55` they name a
personal Environment's own Bitwarden and say that only its person connects it, and
that an agent never asks for that account's credentials): read `lazurio vault status` again before
saying anything about the vault, start with `eval "$(lazurio vault env)"`, never `bw
login`, `unlock`, `lock`, `logout` or `bw config`, `bw sync` before reading, values
straight into commands and never printed, nothing in the account's own vault, and an
externally visible write a Publication. A secret is never asked for in chat or taken
from a file or a message; what the vault lacks an agent gets in the order of root
decision 0198 point 9 (decision F54): (a) where the shared browser window has the
Bitwarden extension, the person's sign-in saved into the Environment's vault; (b) a
secret the agent creates itself in a signed-in session, stored with `bw create item`
(the template piped through `bw encode`, never as an argument); (c) otherwise
`lazurio vault request`, in words the person understands, with its link handed over
and other work continued meanwhile.

### Executor (decision F44)

Root decision 0162, addendum 2026-10-09: Executor 1 is a required part of every
Environment, the MCP gateway of its direct Integrations and custom MCP servers.
Lazurio installs it, runs it as the Environment user's service on localhost only and
connects Codex and Claude Code to it. The catalog tool is `executor`; it has Lazurio's
own setup instead of F19's install and sign-in, which refuse it as `setup-executor`.
Remote Environments on Linux only; on this computer it is the second wave
(`unsupported`, `workstation`) until a pilot on macOS verifies the launchd service
`executor install` writes there. The facts and every reason are in
[F44](decisions.md#f44--executor-in-every-remote-environment-installed-run-and-connected-to-the-agents-by-lazurio).

- **The pin** (`src/executor/pin.ts`): Executor 1.6.10, `dist.integrity` (sha512) of
  the npm package `executor` (the Node launcher) and of the glibc builds
  `executor@1.6.10-linux-x64` and `-linux-arm64` (the program). No install scripts,
  no dependencies besides these.
- **Installation** (`src/executor/install.ts`): both tarballs verified while they
  stream, before npm sees them (a mismatch runs nothing); npm offline, with
  `--ignore-scripts`, an empty user and global config and a private cache, installs
  the launcher and then `executor-<target>@file:<tarball>` into a staging prefix; the
  program must answer `executor v1.6.10`; Lazurio's marker
  `.lazurio-install.json` is written and the prefix moves into place as
  `~/.local/share/executor-cli/1.6.10/` (a directory that was there moves aside and
  goes once the service runs the pin). Missing npm or node: `preflight`,
  `npm-missing` or `node-missing`, before any download.
- **Entry**: `~/.local/bin/executor` is Lazurio's marked wrapper; it sets
  `EXECUTOR_DISABLE_ANALYTICS=1` and `EXECUTOR_DISABLE_UPDATE_CHECK=1` for every run
  and runs `~/.local/share/executor-cli/<version>/lib/node_modules/executor-<target>/bin/executor`.
  A link into `~/.local/share/executor-cli/` (the runbook's manual link, or one left
  dangling by a removed older pin) is replaced; any other entry is a conflict and is
  never touched, also a dangling link that leads anywhere else. A wrapper of a newer
  pin is never replaced.
- **Service** (`src/executor/service.ts`): Executor's own unit
  `sh.executor.daemon.service`, written by `executor install` (`127.0.0.1:4789`,
  data in `~/.executor`), and Lazurio's drop-in
  `~/.config/systemd/user/sh.executor.daemon.service.d/lazurio.conf` with both
  switches, written before `executor install` runs. A unit of another program is
  stopped and repointed by `executor install`; a changed drop-in is reread once and
  restarts the service; a stopped one is started; a running one that answers
  `/api/health` is never stopped or restarted. Lingering is reported, never changed.
  `executor service uninstall` is never run (it disables lingering for the account).
- **Agents** (`src/executor/agents.ts`): the MCP server `executor`
  (`~/.local/bin/executor mcp`, both switches) is added with `codex mcp add` and
  `claude mcp add --scope user` where the harness is installed; read back with
  `codex mcp get executor --json` and from `~/.claude.json`'s top-level
  `mcpServers`. Registration states: `registered`, `disabled` (Codex's entry switched
  off by the operator, left so), `missing`, `conflict` (an entry of that name that is
  not Lazurio's, never changed), `absent` (not installed), `unknown`. Running chats
  keep their tools; new chats see `executor`.
- **States** (`src/executor/flow.ts`, `kind: "executor-status"` with `version`,
  `installed`, `address`, `entry`, `service`, `settings`, `answering`, `linger`,
  `agents`): `running`, `not-installed`, `outdated`, `not-running`, `incomplete`,
  `conflict`, or `unsupported` with `reason` (`workstation`, `handover-unreadable`,
  `not-operator`); a setup that stopped adds `failure` (`stage`: `preflight`,
  `download`, `integrity`, `npm`, `verify`, `place`, `service`, `agents` or `busy`;
  `reason`). A setup holds the kernel lock `~/.local/share/executor-cli/.lazurio.lock`.
- **CLI** (`lazurio executor`): `status [--json]` reads (exit 0); `setup [--json]`
  sets up what is missing (exit 0 running, 2 waiting for a person, 1 not finished;
  its steps go to stderr).
- **Launchpad**: `POST /api/tools/executor/status` with `{}` (the state, or the
  running setup's `202` below), and
  `POST /api/tools/executor/setup` with `{}` (starts or joins the one setup) or
  `{job}`: `202 {kind: "executor-setting-up", job, phase}` while it runs (`install`,
  `service`, `agents`), then the state; an unknown job is `404 job-unknown`, and a
  setup asked while the Launchpad closes is `503 closing` (none starts then). The row in
  Settings → Tools says the state in plain words with one action and keeps the
  version, address, service and agents under Details; no link to the console. It
  follows a running setup it did not start. The
  unit's journal gets `{"scope":"tools-executor","operation":"setup","outcome":…}`
  with a stage and reason when it stopped, and `"trigger":"start"` for the
  Launchpad's own setup after its start, nothing else.
- **Install, update and the Launchpad's start** (addendum of 2026-10-11, #298): on
  a supervised base of the hosted operator, `lazurio install` and `lazurio update`
  only read Executor's state and report `executor` in `--json`; never a setup and
  never a reason to fail ([product update](update.md)). The Launchpad of that base
  sets Executor up in the background after it starts: one setup per start, where it
  is `not-installed`, `outdated`, `not-running` or `incomplete`.
- **Doctor**: the check `executor`, `ok` running, `warn` `executor-<state>` otherwise,
  `skipped` where it is not offered; never `fail`.

The agents' texts are the catalog entry's (`purpose` in `AGENTS.md`, `usage` in
`manual/this-machine.md`, template revision `base-instructions-38`): use the
Integrations connected directly through the MCP server `executor` (tools `skills` and
`execute`) or `executor call tools <integration> <owner> <connection> <tool> '<json>'`,
check `lazurio executor status`, leave a repair to the Operator's instruction, and an
externally visible write through an Integration is a Publication.

### The shared GitHub App sign-in (pilot, decision F48)

The opt-in pilot uses the existing Lazurio for GitHub App. One authorization
acts as the assigned human across every installation available to that person.
GitHub enforces the intersection of user rights, App permissions and installation
repository selection. The owning Organization is a required installation check,
not a token restriction. Full Environment sharing includes this entire capability.
The selected contract, alternatives, failures and real acceptance gates are in
[F48](decisions.md#f48--one-shared-github-app-sign-in-in-a-work-environment-pilot).
No other App is registered and no personal access token is used.

- `lazurio github pilot enable --client-id <Iv…>` enables the pilot only in an
  assigned individual Work Environment. Its owning Organization comes from the
  handover. The App's client id is public. There is one application configuration,
  with no per-Organization add/remove command or sign-in selector. With the switch
  off, the ordinary tooling flow is unchanged.
- `lazurio github sign-in [--json]` shows a code for
  `https://github.com/login/device` to approve in the person's own browser.
  It checks the assigned account id and the App's active owning installation.
  Other installations of that same App are accepted. Expiring token pairs are
  retained owner-only; Ctrl-C cancels. Unknown or foreign interrupted-write files are
  preserved with all current custody for explicit local recovery; only complete
  writes for the configured owner and App are recovered or removed. `sign-out` removes the local pair and known interrupted-write copies without a
  provider request. Its JSON result names `scope: "environment"`. GitHub
  authorization and copied credentials remain valid; ending the authorization
  under GitHub Settings → Applications → Authorized GitHub Apps affects the
  person’s other Environments too. The credential-reporting endpoint is not
  a routine sign-out API: the real pilot also lost its second control chain.
- `lazurio github pilot wire` requires that sign-in, preserves official gh and
  installs the reversible launcher and Git include. gh and HTTPS Git use the
  same token chain for every repository owner. GitHub's denial propagates; no
  other credential is substituted. Git's `quit=1` prevents helper/prompt fallback.
  Existing GitHub SSH remotes are rewritten to HTTPS by the include.
- `pilot unwire` restores the prior gh entry and Git config, preserving the
  sign-in. `pilot disable` refuses until unwired and signed out. While wired,
  F19's tool login/logout directs the person to this pilot's commands instead.
- `lazurio github status [--json]` and Doctor report the one sign-in, owning
  installation, expiry, wiring and leftover account credentials without values.
  This is local state, not a fresh access inventory. `doctor --sign-in` additionally
  probes GitHub SSH. Existing credentials are never silently removed.

```text
${XDG_CONFIG_HOME:-~/.config}/lazurio/github/            0700
  pilot.json        0600  one App, owning installation and reversible wiring
  pilot.gitconfig   0600  the Git include while wired
${XDG_STATE_HOME:-~/.local/state}/lazurio/github/        0700
  sign-in.json      0600  one expiring user token/refresh pair
  sign-in.lock      0600  one kernel lock for all callers
  gh                0755  preserved official gh binary when moved from its entry
~/.local/bin/gh           the marked launcher while wired
```

The pilot's version-2 configuration/token shapes replace unpublished experimental
version-1 shapes. Unknown configuration is retained and refused, not silently
converted. The shared chain is refreshed under its kernel lock ten minutes before
expiry; concurrent processes re-read it and refresh once. Atomic whole-file writes
and interrupted-write recovery preserve the pair. A refused/expired refresh asks
for a new human sign-in; an outage retains local state and can use a still-valid
token. A refresh invalidates the old access token, so a concurrent long operation
can fail; the real pilot must measure this limitation and revocation scope.

The wrapper's token-display and host checks prevent accidental disclosure, not
access by the Environment's own user or their agents. Permissions are GitHub's;
this module is neither a sandbox nor an additional Organization ACL. Device Flow
and installation permission approvals use the existing App's normal provider
settings and human authentication. Real pilot acceptance precedes rollout.

### The standard path (decision 0161, point 6)

One installation per tool, in one place, on every Machine: an operator tool is the
first executable of its name in `~/.local/bin` on the operator's PATH. A tool's
official installer may keep its own home (Codex `~/.codex/…`, Bun `~/.bun`); only a
link or wrapper in `~/.local/bin` puts it on PATH. Lazurio lives in
`~/.local/share/lazurio/` with `~/.local/bin/lazurio`, the link `lazurio install`
creates and reports ([product update](update.md#release-and-trust)), and the
Launchpad unit puts `~/.local/bin` first on its own PATH; system tools (git, curl,
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

**The Codex app-server daemon at boot (F29).** In a Remote Environment whose Launchpad
is supervised, every `lazurio install` and `lazurio update` run as the handover's
declared operator ensures a second installer unit, `lazurio-codex-app-server.service`, runs the
operator's own `~/.local/bin/codex app-server daemon start` at every boot, so a Codex
client connecting over SSH finds the daemon without anyone starting it by hand. This
is the one thing the Platform does with Codex beyond reporting it: it never installs,
updates, downgrades or reconfigures Codex and never runs its installer; without Codex
at its standard entry the unit's condition skips the start. Install and update never
restart or stop the daemon, since that would end live Codex sessions. `lazurio doctor`
reports it as `codex-app-server` (`ok`, or `warn` with the next step, never `fail`).
The unit text is in [product update](update.md#state-on-disk).

## Ownership

| Capability | Platform responsibility | Operator / external owner responsibility |
| --- | --- | --- |
| Standalone Lazurio CLI | Verify the release, stage and activate the selected artifact; no external Bun/Node prerequisite | Approve the release (`latest` or one exact tag) and target; Machines performs its infrastructure installation handover |
| Git and GitHub CLI (`gh`) | Diagnose availability and required capabilities; propose explicit preparation of missing tools | Authorize package/system changes; authenticate as the intended Operator and grant actual repo access |
| Module runtime (for example Bun) | Coordinate the module's declared preparation; report missing/incompatible runtime without claiming readiness | Module owns exact dependency/runtime requirements and preparation; operator approves installation |
| Codex / Claude harness | Diagnose the selected harness, instruction loading and required capabilities; provide one Folder-owned instruction contract; in a Remote Environment start the operator's Codex app-server daemon at boot (`lazurio-codex-app-server.service`, F29) and report it in `lazurio doctor` | Choose the harness, accounts/model access and consent; complete provider-native sign-in; install, update and configure Codex itself |
| Environment browser (Remote Environment, F38, F39) | Run the virtual screen, the one Chromium with its persistent profile and the Lazurio extension, and the people's view (`lazurio browser serve`) as user units; open a thread's window (`lazurio browser window`); open a page as the Environment's default browser (`lazurio browser open`, root decision 0201 point 5); answer the view of a thread's tab behind the gateway; report it in `lazurio doctor` | Machines delivers Xvfb, Chrome for Testing through agent-browser and the `browser.` route with `entry.browser`, and registers `lazurio browser open` as the Environment user's default browser (`BROWSER`, `xdg-open`); the person signs in to websites in the view and decides what may be signed in there |
| Credentials | Use an existing approved provider/credential interface; retain only non-secret diagnostic outcomes | Existing credential owner retains custody, rotation and revocation |

The table describes a private workspace or local Machine, where one person is the
Operator. The team case differs and is described [below](#team-workspace).

Do not install both harnesses merely because they are supported consumers. The pilot
must select and qualify an actual agent, not infer success from an executable's presence.
Do not copy sessions, tokens or another person's Personalspace from a workstation.
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
  token or SSH key, or copies a session onto the shared account. The curated gh
  sign-in and SSH key linking are refused there, and a personal account left signed in
  can be signed out ([gh on a Team Environment](#gh-on-a-team-environment), Matěj
  2026-09-28). Tools that serve the whole Team (composio, wacli) may be signed in for
  the whole Environment with the shared sign-ins warning (F18 addendum). Diagnosis
  that finds a personal provider credential there reports it as a defect to be removed
  through its owner; it is never used.
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
0161 and installs only the curated catalog tools of decision F19 and the pinned
Bitwarden CLI of decision F43; it is not a general updater or installer); the team
case consumes the existing upstream broker rather than adding one. The Environment's
own vault (F43, F53) keeps no secret in the Platform: the vault is the network's
Vaultwarden, or on a personal Environment its person's own Bitwarden (root decision
0203 point 7), and the Environment account's credentials stay beside the Bitwarden
CLI's own data directory. Unknown installation state receives a diagnosis
and operator repair procedure, not an improvised privileged cleanup. Missing accounts
remain an explicit pilot prerequisite, not something Machines or a profile can grant.
Real Organization materialization and canonical document adoption have their separate
decision/authorization gate; this proposal does not authorize conversion or cloning.
