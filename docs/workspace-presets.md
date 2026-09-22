# Workspace presets

Status: **local preset model implemented (2026-09-22, names, derivation and
adoption accepted by the Principal); typed owner requests remain accepted direction.**
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
| Provider identity | The Principal's own sign-in, or the brokered Organization identity |
| Enabled surfaces | Which installed surfaces are offered, for example Launchpad and hosted entry |
| Supervision policy | Session-scoped applications or the OS service manager |

A preset carries no scripts, no infrastructure and no authority. An unknown preset,
an unknown version or an unsupported combination fails before any mutation. Only whole
presets are supported: editing a field does not create a new supported preset. Today
the composition, the defaults, the Personalspace policy and the Machine kinds are
consumed by the Folder Factory; provider identity, surfaces and supervision are
declared for the consumers that own them (the identity broker, hosted entry, the
application runner) and are not enforced by the preset itself.

## The presets

| Preset | Machine | Principal here | Provider identity | Personalspace | Organization repositories |
| --- | --- | --- | --- | --- | --- |
| `local` | The Principal's own workstation, no handover | The signed-in user | Own sign-in | Present | `organizations/<org>/` |
| `hosted-personal` | A Principal's ONE personal VM (`machine.kind: personal-vm`) | The Machine's Owner; a Buddy is an optional resident of the same Machine | Own sign-in | Present and intimate | None mounted |
| `hosted-organization-personal` | An Organization-owned work VM assigned to ONE operator (`workspace-vm`) | The assigned operator | Own sign-in | Never present | `organizations/<org>/` |
| `hosted-organization-team` | An Organization-owned team VM, one OS account, several Principals (`workspace-vm`) | The connected Team member; the OS account is not a person | Brokered Organization identity; no personal credentials | Never present | `organizations/<org>/` |

The earlier names `hosted-private` and `hosted-team` were never implemented and were
renamed without compatibility.

## Derived from the handover, confirmed or explicitly overridden

The preset is derived from the typed fields of the root-issued handover
([machine handover](machine-handover.md)), never from a Machine name, hostname,
Team name or operator account. Platform never guesses. The derivation is a function
of `machine.kind` and one **assignment** value — is the work VM assigned to ONE
operator or shared by a Team? (`machineAssignment` in `src/folder/presets.ts`):

| Handover | Assignment | Derived preset | Allowed presets |
| --- | --- | --- | --- |
| No handover (workstation) | — | `local` | `local` |
| `machine.kind: "personal-vm"` | one operator | `hosted-personal` | `hosted-personal` |
| `"workspace-vm"` without `owner.team` | one operator | `hosted-organization-personal` | both Organization presets |
| `"workspace-vm"` with `owner.team` | **ambiguous** | none: explicit `--preset` required | both Organization presets |

A Team in the handover is not a fact about assignment: an Organization may model an
individual operator's work VM as a GitHub Team named after the operator (found on the
first real canary, [evidence](evidence/presets-linux-arm64-2026-09-22.md)). Machines
will state the assignment explicitly as `owner.assignment`
(`{kind: "operator", github_login, github_id}` | `{kind: "team"}`); once the vendored
schema carries that field it replaces the ambiguous row and becomes the single source
of the assignment value. No heuristic (such as comparing the Team name with the
Machine name) stands in for it meanwhile.

`lazurio machine folder-init [--preset <name>]` records the derived preset by default.
On an ambiguous handover it ends `blocked` with `reason: "preset-ambiguous"` and the two
allowed presets, before any write, unless the Folder is already adopted (an adopted
Folder already has its preset and re-runs report `already-adopted`). A `--preset` must
be one the handover allows (a personal VM never takes an Organization preset and vice
versa) and is recorded as an explicit choice; on an ambiguous handover every choice is
explicit. The same allow-list governs every later change. The rendered Owner line names
the handover's Team only under `hosted-organization-team`; the recorded binding keeps
the Team value untouched either way.

## Immutable and mutable

| | Where it comes from | Launchpad |
| --- | --- | --- |
| Machine kind, name, Owner (Principal or Organization + Team), tailnet node, host, and relationships when the handover carries them | The handover, recorded once as the **Machine binding** | Shown only |
| Preset | Derived, confirmed or explicitly chosen within the allow-list | Changeable through the ordinary preview → apply profile change |
| Communication axes `locale`, `detail`, `coordination` | Preset defaults, then the Principal | Changeable through the same flow |
| Fixed axes `access`, `purpose` | The preset's composition | Not controls; a request whose fixed axes disagree with the preset is a blocked plan |

There is one change path. CLI (`profile-preview`/`profile-update --preset`), Launchpad
and a future typed owner request all send `{expectedRevision, preset?, profile}` to the
same use case; a preset outside the allow-list is `preset-not-allowed`, a profile that
disagrees with the preset is `preset-composition`, both without a write.

## Storage and ownership

`.lazurio/preferences.json` (schema 2) stores the **preset reference** (`name`,
`version`, `selection: derived | explicit`), the immutable **Machine binding** (`null`
on a workstation) and the profile, under the existing revision discipline
([migration and recovery](migration-and-recovery.md)). The whole composition is
validated on every parse: a preset the recorded handover does not allow never parses.
The rendered `AGENTS.md` and the six files of `manual/` are a deterministic projection
of preset, binding and profile ([machine handover](machine-handover.md#what-the-folder-renders));
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
`launchpad.gen3.local.json` are tolerated by name; any other top-level entry fails
closed naming that entry. Machines precreates an empty `personalspace/` on every work
VM, so an Organization preset (Personalspace never present) accepts an empty one and
refuses a used one — it deletes nothing and names the path. A re-run on an adopted
Folder reports `already-adopted` and changes nothing; a Folder adopted from a different
handover or with unrecognized state is refused by name.

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
`machine.kind` and the assignment the handover proves, and an explicit choice is
recorded locally; `owner.assignment` is the one upstream field this derivation waits
for. A persona
(upstream decision 0156) is not carried by the handover or the preset and is not
rendered. If persona or relationships must appear in `lazurio.machine.json`, that is
an **upstream schema change** in Machines followed by a re-pin and conformance test
here; the renderer already renders a relationships section only when the recorded
binding carries one.

## Acceptance before a preset is offered

- `hosted-personal`: the private canary journey in
  [acceptance](acceptance.md#nearest-pilot-sequence) on a real personal VM.
- `hosted-organization-personal`: the same journey on a real work VM.
- `hosted-organization-team`: shared use by several Principals, conflict handling,
  attribution of every change to the Team through the brokered identity, and
  revocation on GitHub blocking the next provider operation. Live Team-grant
  verification in the broker is an external dependency under upstream decisions 0147
  and 0149.

Unit tests prove derivation including the ambiguous handover (blocked `folder-init`
with the exact reason, explicit choice recorded, adopted Folder unaffected), the
allow-list, whole-composition validation, adoption
(non-empty work directories, legacy files, foreign entries, idempotence, the
Personalspace conflict), conformance of both handover branches, the rendered document
per preset and language, and the Launchpad flow. A native run of `folder-init` on a
fresh Ubuntu 24.04 ARM64 VM with fixture handovers of all three kinds is recorded in
[evidence](evidence/presets-linux-arm64-2026-09-22.md); a real Machines-delivered VM
and a native Launchpad preset change are not proven.
