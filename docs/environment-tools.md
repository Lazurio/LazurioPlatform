# Environment tools and operator sign-ins

Proposed bounded pilot procedure under accepted decision 0144. This document does
not claim an implemented tool installer, authenticated harness or usable Environment.
Machines delivers the online Machine and selected Platform release; local Platform
operations and the operator prepare what is needed inside it.

## Operator tools are the operator's (decision 0161, F17)

Root decision 0161 (2026-09-26) splits a Remote Environment into the **provider
baseline** (system, accounts, network, gateway, resident, Platform, Folder, and a
recovery runtime for an agent in a path owned by the Machine's installation authority,
outside the operator's PATH) and the **operator's tools** (Codex, Claude Code, `gh`,
Node, npm, Bun and whatever else is on the operator's PATH). The baseline is pinned
through the Machines rollout; the tools are delivered once at Machine creation and then
belong to the operator, who updates them with the official installers. A rollout never
downgrades or overwrites them, readback reports their versions as facts, and a rollout
is only a repair: it restores the baseline and starts an agent that repairs the rest per
the Folder manuals. Agents update operator tools only on the Principal's explicit
instruction. The Platform's part is the generated manual rule (template revision
`base-instructions-6`) and `lazurio tools status|update`, a thin orchestration of the
official installers that reports and, on instruction, runs them; it pins nothing.

### `lazurio tools status` and `lazurio tools update <tool>`

The Platform's surface for the operator's tools, implemented in `src/tools/`:

- `tools status [--json]` lists codex, claude, gh, git, node, npm and bun as found on
  the process PATH (first executable of the name, decision 0140 rule), with the real
  path behind a link and the version the tool reports; missing tools carry their
  official source. Read-only, never the network; it does not say "outdated", because
  the operator's version is a fact, not drift.
- `tools update <tool> [--json]` runs exactly that tool's official update path as the
  current user and reports the version before and after: the tool's own updater
  (`claude update`, `bun upgrade`) or the vendor's installer script (`codex`, the
  official standalone installer of `manual/organization-install.md`). Tools without one
  (`gh`, `git`, `node`, `npm`) are reported with their official source and nothing
  runs (`tool-not-self-updating`, exit 1). Unknown names exit 2. It never pins,
  never downgrades on its own, never touches another tool and is not run by
  `lazurio update`, the Launchpad or a Machines apply. An agent runs it only on the
  Principal's explicit instruction (F17).

### The standard path (decision 0161, point 6)

One installation per tool, in one place, on every Machine: an operator tool is the
first executable of its name in `~/.local/bin` on the operator's PATH. A tool's
official installer may keep its own home (Codex `~/.codex/…`, Bun `~/.bun`); only a
link or wrapper in `~/.local/bin` puts it on PATH. Lazurio lives in
`~/.local/share/lazurio/` with `~/.local/bin/lazurio`; system tools (git, curl,
python, ssh) belong to the OS package manager; T3 Code and its runtime belong to the
service unit and run on the Node its version recommends. There is no second
"recovery" copy of any tool: a rollout repairs the one installation in place (only
missing or broken, never a downgrade), the Machines apply returns the `lazurio doctor`
and `lazurio tools status` readback and starts no agent, and the rolling-out Task
Agent starts the repair with the operator's mandate. `tools status` reports
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
  token or SSH key, or copies a session onto the shared account. Diagnosis that finds a
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
0161 and is not a general updater); the team case consumes the existing upstream
broker rather than adding one. Unknown installation state receives a diagnosis
and operator repair procedure, not an improvised privileged cleanup. Missing accounts
remain an explicit pilot prerequisite, not something Machines or a profile can grant.
Real Organization materialization and canonical document adoption have their separate
decision/authorization gate; this proposal does not authorize conversion or cloning.
