# Workspace presets

Status: **local preset model implemented (2026-09-22, names, derivation and
adoption accepted by the Principal); typed owner requests remain accepted direction.
The Steward preset (decision 0169, 2026-09-30) is proposed and implemented locally;
its derivation waits for the Machines handover value `automation`.**
See [decision F10](decisions.md#f10--workspace-presets-and-typed-owner-requests).

A workspace preset is a different concept from the application presets in
[module adoption](module-adoption.md#workspace-standards-and-versioned-presets--accepted-direction),
which produce a starting application inside an Organization. A workspace preset
configures one Lazurio Environment.

## What a preset is

A named, versioned, declarative composition, shipped as data in
`src/folder/presets.ts`:

| Field | Meaning |
| --- | --- |
| Machine kinds | Which handover kinds the preset is allowed on (`workstation`, `personal-vm`, `workspace-vm`) |
| Composition | The fixed profile axes the preset pins: `access` and `purpose` |
| Defaults | Initial `locale`, `detail` and `coordination`; the Principal may change them |
| Personalspace policy | `present` (intimate, one Principal) or `never` (Organization-owned Machine) |
| Provider identity | The Principal's own sign-in, the brokered Organization identity, or the persona's own account |
| Enabled surfaces | Which installed surfaces are offered, for example Launchpad, hosted entry and Lazurio MausBot |
| Supervision policy | Session-scoped applications or the OS service manager |
| Bot team | `null`, or the defaults Lazurio MausBot starts the persona's bot team with ([Steward preset](#the-steward-preset-automated-environment)) |

A preset carries no scripts, no infrastructure and no authority. An unknown preset,
an unknown version or an unsupported combination fails before any mutation. Only whole
presets are supported: editing a field does not create a new supported preset. Today
the composition, the defaults, the Personalspace policy and the Machine kinds are
consumed by the Folder Factory; provider identity, surfaces and supervision are
declared for the consumers that own them (the identity broker, hosted entry, the
application runner) and are not enforced by the preset itself. One consumer of the
provider identity is in the Platform: on the brokered preset (`hosted-organization-team`)
the curated gh sign-in and SSH key linking are refused and only a person's account
left signed in may be signed out ([gh on a Team Environment](environment-tools.md#gh-on-a-team-environment),
F19 addendum 2026-09-28); on every other preset the curated tools behave the
same. On the Steward preset that sign-in is the persona's account (below). The bot
team is declared for the service that runs Lazurio MausBot and rendered into the
Folder; Platform applies none of it.

## The presets

| Preset | Machine | Principal here | Provider identity | Personalspace | Organization repositories |
| --- | --- | --- | --- | --- | --- |
| `local` | The Principal's own workstation, no handover | The signed-in user | Own sign-in | Present | `organizations/<org>/` |
| `hosted-personal` | A Principal's ONE personal VM (`machine.kind: personal-vm`) | The Machine's Owner; a Buddy is an optional resident of the same Machine | Own sign-in | Present and intimate | None mounted |
| `hosted-organization-personal` | An Organization-owned work VM assigned to ONE operator (`workspace-vm`) | The assigned operator | Own sign-in | Never present | `organizations/<org>/` |
| `hosted-organization-team` | An Organization-owned team VM, one OS account, several Principals (`workspace-vm`) | The connected Team member; the OS account is not a person | Brokered Organization identity; no personal credentials | Never present | `organizations/<org>/` |
| `hosted-organization-steward` | The Automated Environment of an Organization persona (`workspace-vm`), decision 0169 | The one responsible operator, an Owner or Admin of the Organization; the persona's bot team works here | The persona's own GitHub user account (a bot account), signed in by the operator | Never present | `organizations/<org>/` |

The earlier names `hosted-private` and `hosted-team` were never implemented and were
renamed without compatibility.

## Derived from the handover, confirmed or explicitly overridden

The preset is derived from the typed fields of the root-issued handover
([machine handover](machine-handover.md)), never from a Machine name, hostname,
Team name, operator account or the recorded relationships. Platform never guesses.
The derivation is a function of one **assignment** value — is the work VM assigned
to ONE operator, shared by a Team, or the Automated Environment of a persona? — and
`machine.kind`. Since Machines v0.12.61
the handover states the assignment as `owner.assignment`
(`{kind: "operator", github_login, github_id}` | `{kind: "team"}`), copied from the
reviewed owner overlay and never inferred; when present it is **the only selector**
between the two Organization presets (`machineAssignment` in
`src/folder/presets.ts` reads it and nothing else):

| `owner.assignment` | Handover | Assignment | Derived preset | Allowed presets |
| --- | --- | --- | --- | --- |
| — | No handover (workstation) | — | `local` | `local` |
| never present | `machine.kind: "personal-vm"` | one operator | `hosted-personal` | `hosted-personal` |
| `{kind: "operator", …}` | `"workspace-vm"`, with or without `owner.team` | one operator | `hosted-organization-personal` | the three Organization presets |
| `{kind: "team"}` | `"workspace-vm"`, with or without `owner.team` | the Team | `hosted-organization-team` | the three Organization presets |
| `{kind: "automation", …}` (not in the handover schema yet) | `"workspace-vm"`, with or without `owner.team` | a persona, one responsible operator | `hosted-organization-steward` | the three Organization presets |
| absent | `"workspace-vm"` without `owner.team` | one operator | `hosted-organization-personal` | the three Organization presets |
| absent | `"workspace-vm"` with `owner.team` | **ambiguous** | none: explicit `--preset` required | the three Organization presets |

The ambiguous row remains only for handovers without `owner.assignment` (an older
Machines release, or an owner that declares none). A Team alone is not a fact about
assignment: an Organization may model an individual operator's work VM as a GitHub
Team named after the operator (found on the first real canary,
[evidence](evidence/presets-linux-arm64-2026-09-22.md)). No heuristic (such as
comparing the Team name with the Machine name) stands in for the assignment.

`lazurio machine folder-init [--preset <name>]` records the derived preset by default.
On an ambiguous handover it ends `blocked` with `reason: "preset-ambiguous"` and the
three allowed presets, before any write, unless the Folder is already adopted (an adopted
Folder already has its preset and re-runs report `already-adopted`). A `--preset` must
be one the handover allows (a personal VM never takes an Organization preset and vice
versa) and is recorded as an explicit choice; on an ambiguous handover every choice is
explicit. The same allow-list governs every later change. The rendered Owner line names
the handover's Team only under `hosted-organization-team`; the recorded binding keeps
the Team value untouched either way, and the rendered Assignment line states the
handover's `owner.assignment` exactly when it is present (`assigned to operator
<login>` / `shared by the Team`).

## The Steward preset: Automated Environment

Decision 0169 (Lazurio root register) adds a fourth kind of Environment next to the
three of 0165: **Automated** (Automatizovaný). Automated work of an Organization is
done by a bot team of its persona (Henry) in Lazurio MausBot, Lazurio's fork of
OpenMausBot. `hosted-organization-steward` is that Environment's preset:

- **Machine and operator.** An Organization-owned work VM (`workspace-vm`) with one
  responsible operator, an Owner or Admin of the Organization, who configures the
  automation and answers for it. Only the operator connects over SSH, for service
  interventions; colleagues work with the persona through GitHub. Personalspace is
  never present; Organization repositories are mounted under `organizations/<org>/`
  exactly as on the other Organization presets.
- **Provider identity `persona-account`.** The persona's own GitHub user account
  (a bot account), one per Organization (not a GitHub App: a code owner, a requested reviewer
  and an assignee must be users). It is neither the operator's account nor Lazurio for
  GitHub, which stays the identity of the Work Team Environment (0147, 0168). Every
  tool, T3 Code and every bot acts as that account and within its live GitHub rights.
- **Curated tools.** The curated gh sign-in and SSH key linking are offered, as on
  the Work presets: the responsible operator signs in once with `lazurio tools login
  gh` or in the Launchpad (Tools), chooses the persona's account in the browser's
  device flow and links this Machine's SSH key to it. The operator holds the account's
  two-factor authentication and recovery codes outside the Machine. Signing in the
  operator's own account there is wrong by the rendered rules; Platform does not
  compare accounts (the handover names the operator, not the persona) and grants
  nothing. Composio and wacli behave as on a Work Environment.
- **Surfaces** `launchpad`, `hosted-entry` (which already carries T3 Code, as on every
  hosted preset) and `openmausbot`, the Lazurio MausBot web app of the Machine (its
  link from the Launchpad is Launchpad work outside this preset). **Supervision** by the OS service manager: the bots keep running
  without a session.
- **Composition** `access: remote`, `purpose: human`: a person answers for every
  Machine (0169), and the sweep of the purpose vocabulary under decision 0156 is a
  separate step. The communication defaults are the shared ones.

**Bot team.** The preset declares the defaults Lazurio MausBot starts the persona's
bot team with. The service that installs and runs Lazurio MausBot applies them as its
environment (a Machines workload today); Platform applies none of them, and the
operator may change them in Lazurio MausBot. The Folder renders them into
`manual/this-machine.md` and a short section of `AGENTS.md`:

| Field | Lazurio MausBot setting | Default |
| --- | --- | --- |
| `workingFolder: "lazurio-folder"` | `OMB_DEFAULT_BOT_CWD` | The Lazurio Folder: new bots start there and follow its `AGENTS.md` cascade |
| `team` | Templates → Import (`POST /api/teams/import`) | `lazurio/teams/steward.openmaus.json` from the installed release: a leader named after the persona and three workers |
| `githubIntake` | `OMB_GITHUB_INTAKE=1` | The model-free intake under the Machine's `gh` account |
| `githubIntake.bot: "team-leader"` | `OMB_GITHUB_INTAKE_BOT` | The leader's name in the imported team (Henry; another persona renames it) |
| `githubIntake.scope` | `OMB_GITHUB_INTAKE_SCOPE` | `organization` |
| `githubIntake.owners: "machine-organization"` | `OMB_GITHUB_INTAKE_OWNERS` | The handover's `owner.organization` |
| `githubIntake.exclude` | `OMB_GITHUB_INTAKE_EXCLUDE` | The Organization's `infra` and `productionspace` repositories, as `<org>/<repository>` from its declaration |

The exclusion mirrors 0169's grant (write on workspace repositories including
Mission Control and the design system, not on infra and productionspace); the
`organization` scope already takes only repositories the account can push to, so the
account's live rights remain the limit and the list is not a grant. The team file is
in the Lazurio MausBot repository today; shipping it inside the release archive, so
an Environment imports it from the installed version without access to the
repository, is an open item of that repository (Lazurio/OpenMausBot#4). Which
approval level an unattended team may run on is an open security decision of
DEV-6632, not part of the preset.

**Derivation.** The kind comes from a typed handover value, never from names:
`owner.assignment` `{kind: "automation", github_login, github_id}`, naming the
responsible operator exactly like `operator`. A stored binding accepts it
(`{kind: "automation", githubLogin, githubId}`) and derives `hosted-organization-steward`;
any other kind still fails closed. The vendored handover schema does not carry it:
until Machines adds it to `lazurio.machine.v1` and Platform re-pins the schema and
projects it in `src/machine/binding.ts`, a handover declaring it is refused whole
(`machine-context-invalid`) and the operator of a work VM chooses the preset
explicitly: every `workspace-vm` allows the three Organization presets. A work VM
re-assigned to `automation` whose derived preset was recorded is
`preset-derivation-changed` on refresh; the Principal chooses the Steward preset with
`profile-update --preset` and the refresh follows. For every handover that exists
today the derivation, the recorded state and the rendered bytes are unchanged; the
only visible change is the third allowed preset.

## Immutable and mutable

| | Where it comes from | Launchpad |
| --- | --- | --- |
| Machine identity: kind, name, Owner (Principal or Organization + Team), tailnet node, host | The handover, recorded at adoption as part of the **Machine binding**; immutable | Shown only |
| Assignment and relationships when the handover carries them, handover digest | The current handover; `machine folder-refresh` re-records them in the binding | Shown only |
| Preset | Derived, confirmed or explicitly chosen within the allow-list | Changeable through the ordinary preview → apply profile change |
| Communication axes `locale`, `detail`, `coordination` | Preset defaults, then the Principal | Changeable through the same flow |
| Fixed axes `access`, `purpose` | The preset's composition | Not controls; a request whose fixed axes disagree with the preset is a blocked plan |

There is one change path. CLI (`profile-preview`/`profile-update --preset`), Launchpad
and a future typed owner request all send `{expectedRevision, preset?, profile}` to the
same use case; a preset outside the allow-list is `preset-not-allowed`, a profile that
disagrees with the preset is `preset-composition`, both without a write. A handover
rewrite enters the same planner and transaction through `lazurio machine
folder-refresh`, with the recorded preset and profile and the re-projected binding of
the same Machine ([refresh](machine-handover.md#refresh-after-a-handover-rewrite)); a
preset recorded as derived that the new assignment no longer derives is
`preset-derivation-changed`, never silently kept or switched.

## Storage and ownership

`.lazurio/preferences.json` (schema 2) stores the **preset reference** (`name`,
`version`, `selection: derived | explicit`), the **Machine binding** (`null` on a
workstation; its identity immutable, the rest following the handover) and the profile, under the existing revision discipline
([migration and recovery](migration-and-recovery.md)). The optional top-level key
`tools` holds the enabled catalog tools
([F18](decisions.md#f18--enabled-tools-of-the-environment)); it is absent when nothing
is enabled and belongs to neither the preset, the binding nor the profile, so a preset
or profile change carries it forward unchanged. The optional key `toolNotes` holds the
operator's notes for agents on required or enabled tools (F18 addendum) under the same
rules. The whole composition is
validated on every parse: a preset the recorded handover does not allow never parses.
The rendered `AGENTS.md` and the six files of `manual/` are a deterministic projection
of preset, binding, profile, enabled tools and the operator's notes on them ([machine handover](machine-handover.md#what-the-folder-renders));
the manifest records one digest per generated file.

Do not extend the instruction axes in `src/folder/profile.ts` into a universal
infrastructure configuration. Those axes describe generated instructions. A preset
supplies their defaults and pins the fixed ones; it does not turn the profile renderer
into the owner of supervision or surfaces. The `purpose` axis keeps its values until
the upstream sweep of decision 0156 (automated Machine with a persona) lands.

## Adoption of an existing Folder

`folder-init` adopts the Folder Machines delivers and the one real Machines already
have. The Folder owns exactly `AGENTS.md`, `manual/` and `.lazurio/` at the top level
(the agent manual of [decision F14](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)
is rendered into `manual/` by the same transaction as `AGENTS.md`; a foreign `manual/`
without recorded digests is refused by name).
`organizations/` and `personalspace/` may be non-empty and are never traversed, listed
beyond existence, moved or written; `launchpad.gen3.json` and
`launchpad.gen3.local.json` are tolerated by name (legacy files of the resident
Launchpad, decision F15: never read, never written, tolerance ends with it); any other top-level entry fails
closed naming that entry. Machines precreates an empty `personalspace/` on every work
VM, so an Organization preset (Personalspace never present) accepts an empty one and
refuses a used one — it deletes nothing and names the path. A re-run on an adopted
Folder reports `already-adopted` and changes nothing (a re-applied handover of the
same Machine included; `folder-refresh` renders what the rewritten handover changed);
a Folder adopted for a different Machine or with unrecognized state is refused by name.

## One choice, two effects, two owners

A user-facing "Machine profile" choice has two distinct effects:

| Effect | Owner | Examples |
| --- | --- | --- |
| Infrastructure custody and topology | The hosting engine | Placement, network, gateway, custody, recovery, OS account |
| Environment configuration | Platform | Preset reference, overrides, surfaces, supervision policy |

The hosting engine's reusable Machine profiles remain its own; Platform gains no
authority to redefine them. A managed Dashboard may present one choice and dispatch a
separate request to each owner. Neither owner applies the other's half.

## Typed requests with an expected revision — accepted direction

A managed service that wants to change Environment configuration sends a **typed,
resource-specific request**: for example "set preset reference", "update the product"
or "start this application". Each request carries the requester's identity, the
**expected local revision** of that resource and the requested change. The local state
already makes this possible: the preset reference and its revision live in
`.lazurio/preferences.json`, and "set preset reference" is exactly the
`{expectedRevision, preset, profile}` request above.

The local core validates the request, applies it through the ordinary use case (the
same one CLI and Launchpad use) and returns an accepted or rejected revision plus the
observed outcome. A concurrent local change is a **conflict**: the request is
rejected with the current revision, and the requester decides again. Cloud intent
never silently takes precedence over a local change.

There is no generic desired-state-to-Machine pipeline, no reconciler that converges a
Machine toward a remote document, and no second writer. Transport, authentication of
the requester and freshness of displayed observations remain open; self-hosted
Environments need none of this. No Dashboard request is built yet.

## Never part of a preset

Access grants, rosters, team membership, tokens, credentials, effective mandates and
analytics consent are never preset fields, defaults or side effects. A preset cannot
enable measurement ([profile evidence](profile-evidence.md)), grant provider access or
supply a mandate. `hosted-organization-team` requires the brokered identity *mode* as
a capability; the broker credential, its policy and the live GitHub Team grants stay
with their owners, and a missing capability is a diagnosis, never something the preset
provisions. Recording a preset enforces no access: placement never proves the Git
pusher.

## Provenance in the Machine identity

The handover has no selected-preset field and needs none: the preset is derived from
`owner.assignment` and `machine.kind`, and an explicit choice is recorded locally.
`relationships` (Machines v0.12.61) is recorded in the binding and rendered into
`manual/this-machine.md` and `AGENTS.md` when present; it never takes part in the
derivation and Platform enforces nothing from it. The persona's account (upstream
decisions 0156 and 0169) is not carried by the handover or the preset: the Steward
preset renders the rule (the persona's own account, signed in by the responsible
operator), never an account name, and the `automation` assignment names only the
responsible operator. If the persona's account must appear in
`lazurio.machine.json`, that is an **upstream schema change** in Machines followed by
a re-pin and conformance test here.

## Acceptance before a preset is offered

- `hosted-personal`: the private canary journey in
  [acceptance](acceptance.md#nearest-pilot-sequence) on a real personal VM.
- `hosted-organization-personal`: the same journey on a real work VM.
- `hosted-organization-team`: shared use by several Principals, conflict handling,
  attribution of every change to the Team through the brokered identity, and
  revocation on GitHub blocking the next provider operation. Live Team-grant
  verification in the broker is an external dependency under upstream decisions 0147
  and 0149.
- `hosted-organization-steward`: on a real work VM, the persona's account signed in
  by the operator, Lazurio MausBot running with the declared defaults, a review on
  an exact head and an explicitly instructed publication completed through GitHub
  alone (the pilot of DEV-6632), and an idle team calling no model.

Unit tests prove derivation from `owner.assignment` (operator and Team, with and
without `owner.team`) and the remaining ambiguous handover without it (blocked
`folder-init` with the exact reason, explicit choice recorded, adopted Folder
unaffected), that a v0.12.59-shaped handover derives exactly as before, the
allow-list, whole-composition validation, adoption
(non-empty work directories, legacy files, foreign entries, idempotence, the
Personalspace conflict), conformance of both handover branches, the rendered document
per preset and language, and the Launchpad flow. A native run of `folder-init` on a
fresh Ubuntu 24.04 ARM64 VM with fixture handovers of all three kinds is recorded in
[evidence](evidence/presets-linux-arm64-2026-09-22.md); a real Machines-delivered VM
and a native Launchpad preset change are not proven. For the Steward preset, unit
tests prove its whole composition, that the four earlier presets are unchanged field
by field and render the same bytes (their snapshots and the template revision are
unchanged), derivation from a stored `automation` assignment with and without
`owner.team`, the fail-closed refusal of every other assignment shape, the vendored
schema's refusal of `automation` today, `folder-init` derived and explicit (today's
operator and Team handovers) with the rendered persona, bot team and publication
rule, the refusal on a personal VM and of a used `personalspace/`, the refresh after
a re-assignment to `automation`, the gh gate offering sign-in and key linking, and
the responsible operator withheld from recovery evidence. No native run exists.
