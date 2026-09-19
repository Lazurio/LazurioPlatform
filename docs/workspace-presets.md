# Workspace presets

Status: **accepted direction of the Principal (2026-09-19); not implemented.** No
preset format, store, command or UI exists. See
[decision F10](decisions.md#f10--workspace-presets-and-typed-owner-requests).

A workspace preset is a different concept from the application presets in
[module adoption](module-adoption.md#workspace-standards-and-versioned-presets--accepted-direction),
which produce a starting application inside an Organization. A workspace preset
configures one Lazurio Environment.

## What a preset is

A named, versioned, declarative composition of:

| Field | Meaning |
| --- | --- |
| Purpose | Human work, Buddy acting for a human, or AI Colleague seat |
| Collaboration defaults | Initial collaboration, detail and locale choices; the Principal may change them |
| Required capabilities | Tools, harness capabilities and the provider identity mode (own sign-in or brokered Organization identity) the Environment must diagnose as present |
| Enabled surfaces | Which installed surfaces are offered, for example Launchpad and hosted entry |
| Supervision policy | How long-running applications are owned, for example OS service manager or session-scoped |
| Default update channel | The channel the product update check follows unless overridden |

A preset is data shipped with a release. It carries no scripts, no infrastructure and
no authority. An unknown preset, an unknown version or an unsupported combination
fails before any mutation.

## The first validated presets

Exactly two hosted presets are validated first, next to the existing local default:

| Preset | Use | Provider identity | Personalspace |
| --- | --- | --- | --- |
| `local` (existing default) | A Principal's own workstation | Principal's own sign-in | The Principal's own, under upstream rules |
| `hosted-private` | A hosted workspace dedicated to one Principal | That Principal's own sign-in | Not mounted on an Organization-owned Machine |
| `hosted-team` | An Organization-owned hosted workspace; one OS account; several Principals connect | Brokered Organization identity; no personal credentials | Never present |

Each preset is validated as a complete composition. Fields are not independently
supported combinations: a preset that has not passed its acceptance is not offered,
and editing individual fields does not create a new supported preset.

## Storage and ownership

The Environment stores the **immutable preset reference** (name and version) together
with **explicit local overrides**, under the existing environment-configuration owner
and its revision discipline ([migration and recovery](migration-and-recovery.md)).
Overrides are visible, named and revisioned; a preset upgrade never silently drops or
reinterprets them.

Do not extend the instruction axes in `src/folder/profile.ts` into a universal
infrastructure configuration. Those axes describe generated instructions. A preset may
supply their defaults; it does not turn the profile renderer into the owner of
supervision, surfaces or channels.

## One choice, two effects, two owners

A user-facing "Machine profile" choice has two distinct effects:

| Effect | Owner | Examples |
| --- | --- | --- |
| Infrastructure custody and topology | The hosting engine | Placement, network, gateway, custody, recovery, OS account |
| Environment configuration | Platform | Preset reference, overrides, surfaces, supervision policy, channel |

The hosting engine's reusable Machine profiles remain its own; Platform gains no
authority to redefine them. A managed Dashboard may present one choice and dispatch a
separate request to each owner. Neither owner applies the other's half.

## Typed requests with an expected revision

A managed service that wants to change Environment configuration sends a **typed,
resource-specific request**: for example "set preset reference", "set update channel"
or "start this application". Each request carries the requester's identity, the
**expected local revision** of that resource and the requested change.

The local core validates the request, applies it through the ordinary use case (the
same one CLI and Launchpad use) and returns an accepted or rejected revision plus the
observed outcome. A concurrent local change is a **conflict**: the request is
rejected with the current revision, and the requester decides again. Cloud intent
never silently takes precedence over a local change.

There is no generic desired-state-to-Machine pipeline, no reconciler that converges a
Machine toward a remote document, and no second writer. Transport, authentication of
the requester and freshness of displayed observations remain open; self-hosted
Environments need none of this.

## Never part of a preset

Access grants, rosters, team membership, tokens, credentials, effective mandates and
analytics consent are never preset fields, defaults or side effects. A preset cannot
enable measurement ([profile evidence](profile-evidence.md)), grant provider access or
supply a mandate. `hosted-team` requires the brokered identity *mode* as a capability;
the broker credential, its policy and the live GitHub Team grants stay with their
owners, and a missing capability is a diagnosis, never something the preset provisions.

## Provenance in the Machine identity

The pinned Machine identity schema has no selected-preset field. Platform does not
derive a preset from a Machine name, Team slug, hostname or operator account. If
preset provenance must appear in `lazurio.machine.json`, that is an **upstream schema
change** in the hosting engine followed by a re-pin and conformance test here
([machine handover](machine-handover.md)). Until then the preset reference lives only
in the Environment configuration and is chosen explicitly at setup.

## Acceptance before a preset is offered

- `hosted-private`: the private canary journey in
  [acceptance](acceptance.md#nearest-pilot-sequence).
- `hosted-team`: shared use by several Principals, conflict handling, attribution of
  every change to the Team through the brokered identity, and revocation on GitHub
  blocking the next provider operation. Live Team-grant verification in the broker is
  an external dependency under upstream decisions 0147 and 0149.
