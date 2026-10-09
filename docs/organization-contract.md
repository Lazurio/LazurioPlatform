# Organization contract authority and convergence

The maintained Lazurio Core contract is authoritative, not a new Platform schema:

- [Manifest family](https://github.com/HumanAndMachines/Lazurio/blob/b037a9f0691afea39efc722aede3a44125bf1d38/manual/lazurio-manifest-family.md), accepted by decisions 0026, 0031 and 0042.
- [Authored schema](https://github.com/HumanAndMachines/Lazurio/blob/b037a9f0691afea39efc722aede3a44125bf1d38/lazurio/lazurio.organization.v1.schema.json), SHA256 `4f14f1a1fec950b39fd0fddb1b13f1c41874c99b836d1029f2ee9f91ff5c6292`.

Platform must consume this same versioned contract. The current independently
authored `canonical-manifest.ts` parser is not an exact vendored schema or a complete
Core resolver. Before real Organization adoption, pin the upstream schema with
provenance and its applicable license/notices and verify conformance. Do not copy
legacy source under Platform's license or create another schema authority.

## Current correspondence and gaps

`organization.forge_binding`, optional `root_repository`, metadata, inventory pointer,
extensions and compatibility projection fields are upstream wire fields. They are
not invented Platform fields. Verified Organization/repository IDs remain a complete
pair; owner and binding state must match and the compatibility branch remains `main`.
The root repository is never trusted by name: a name is only a candidate, accepted
after the repository declares itself the root, that is, after its own
`lazurio.organization.json` binds the Organization's login and names exactly that
repository as `root_repository` (Matěj, 2026-10-05; root decision 0188). The target
source of the root is the Dashboard's Organization record, fed by the Organization's
Lazurio for GitHub app installation; until it exists, content installation finds the
candidate by name (`<Owner>/<Owner>_GEN3`) and otherwise by a scan of the
Organization's readable repositories ([content synchronization](content-sync.md#where-the-root-repository-is)).
The verification stays with every source, the Dashboard included.
Shape validation is neither live provider verification nor permission to operate.

Templates remain valid authored declarations for inspection/conversion preview, but
`kind: template` excludes the root from runtime. Shared application discovery returns
`template-not-runtime` before reading descendants; executable selection refuses it.
CLI and Launchpad use that same boundary. A filename or declared app cannot turn a
template into an actionable Organization.

Upstream resolves legacy, transition, projection drift, conflict, current and missing
states through one Core owner. Its normalized resource and resolution envelope are
not the authored schema. Until Platform consumes that resolver envelope directly
(pinned provenance and conformance), `src/organizations/root-resolution.ts` is an
interim implementation of the same compatibility-state table, not a second schema:

- Canonical-first: `lazurio.organization.json` is the only authority. The deprecated
  `company.gen3.json` is consulted only as the generated compatibility projection for
  the parity gate while it still exists; it disappears at finalization and never
  becomes a fallback, a second authority or a second schema.
- The projection digest reuses the deterministic projection generator and
  `sha256-canonical-json-v1` digest already pinned for conversion preview. Exact digest
  equality proves `transition` parity; a legacy document that round-trips through the
  pure conversion to the same projection is `projection_drift`; every other
  divergence, an unreadable or malformed document, a stale declared digest or a
  missing inventory is `conflict`. This recognizes drift only where parity is
  proven and is stricter than upstream, never looser.
- Execution admission (`resolveOrganizationApplication`, hence Launchpad/CLI
  `prepare`, `clean-prepare` and `start`, and `executable` in the Folder catalog)
  asks one rule, `isExecutableOrganizationState` in
  `src/organizations/root-resolution.ts`, with two variants in one constant:
  **transition-only** (variant A, F12 as accepted: only parity-valid `transition`
  executes, a canonical-only `current` root is observable and inspection-only) and
  **transition-and-current** (variant B: `current` executes as well). The default is
  **variant B, decided by Matěj on 2026-09-28** (question H1 of the
  Launchpad parity shaping, decision F22 point 1): the checkout exists because
  GitHub allowed the clone, and the projection gate was migration machinery.
  Variant A stays one line away for the record and tests cover both variants. Under either variant `legacy`, `projection_drift`,
  `conflict`, `missing`, a template and an unresolvable root refuse before
  descendant inspection, the owner lock, preparation, script start or any write.
  Every present document is normalized with the upstream issue codes (slot path
  grammar and scope, `module_port_pool` range, legacy identity and schema) before
  any state is assigned.
- Discovery stays inspection-only: `applications-observed` carries the resolution
  state and an explicit `admission: executable | inspection-only`; a root the
  admission rule does not execute (`projection_drift`, and `current` under variant
  A) is still listed from the canonical file but is not executable. Conflict
  returns `organization-conflict` with issue codes only.
- The Organization root and its documents are the operator's own checkout (decision
  F23): the root is accepted when it is a real directory owned by the operator, each
  document when it is a regular file of at most 1 MiB owned by the operator;
  permission bits and link count are not reasons (a clone under umask `002` has
  `0775` directories and `0664` files). A refused document keeps the `conflict` state
  and its `*_document_unreadable` issue, and the catalog names the Organization's
  reason by the rule (`declaration-not-regular`, `declaration-owner`,
  `declaration-too-large`) with the document's file; a refused root is
  `directory-not-regular` or `directory-owner` with `.`.
- The Folder catalog (`lazurio organization list`, `lazurio module list`, the
  Launchpad home) applies this reader to every directory in
  `<Folder>/organizations/`; a candidate that cannot be read, a template and two
  candidates declaring one slug are isolated with a typed reason and never hide
  the others. See [launchpad development](launchpad-development.md#launchpad-home-the-catalog).

## Organization settings

Upstream decision 0194 adds the optional, closed `settings` section of
`lazurio.organization.json`; its first setting is
`settings.integrations.composio.allowed`. Platform consumes it exactly as Lazurio
Core defines it ([contract, schema `$defs.organizationSettings` and Core tests](https://github.com/HumanAndMachines/Lazurio/pull/512),
merged; the authored schema pinned at the top of this page carries the section).

- `parseCanonicalOrganization` accepts the section and keeps it as authored but
  never judges it. `organizationSettings` (`src/organizations/organization-settings.ts`)
  is its only reader: `absent`, `valid` (exactly the declared keys, plus the
  effective value of every known key) or `invalid` (nothing applies; every issue
  carries Core's code and JSON Pointer).
- A malformed section never turns the Organization into a `conflict`: the
  projection and its hash, the root state, execution admission and the root
  declaration used by content synchronization ignore it, as in Core. Every other
  unknown top-level field still refuses the manifest.
- An absent value is not governed by the Organization and the Environment
  decides; a present value governs every work Environment of the Organization;
  personal Environments ignore it. Applying a setting and reporting each item is
  decision [F45](decisions.md#f45--organization-settings-reach-the-environment-asked-through-its-relay-recorded-in-the-folder-reported-back):
  the Launchpad asks the Dashboard through the Environment's relay, or reads this
  section from the Organization's root in the Folder where there is no relay, and
  records what it applies in the Folder. `deliveredSettings` reads the Dashboard's
  answer by the same contract, keeping a key this release does not know apart, by
  its key only, to be reported `unsupported`.
- Readers first: older releases reject a manifest with the section as an unknown
  field. An Organization adds it only after the release with this reader runs on
  all of its Environments.

## Exit from transition-only admission

**Decided 2026-09-28 by Matěj (question H1 of the Launchpad parity shaping,
decision F22 point 1): the transition-only gate is retired and this section is a
historical record.** Admission runs variant B (see the execution admission bullet
above): a parity-valid `transition` root and a canonical-only `current` root both
execute; `legacy`, `projection_drift`, `conflict`, `missing`, a template and an
unresolvable root refuse. No upstream identity continuity proof is awaited: no owner
of such a proof was named, and a canonical-only Organization would otherwise lose its
applications when the Platform Launchpad replaces the resident one. Nothing falls back
to the deprecated projection, no second schema and no local finalization marker exist.
Variant A stays one line away in `src/organizations/root-resolution.ts` for the
record, covered by tests.

*Historical, as [decision F12](decisions.md#f12--canonical-only-organizations-and-a-deliberately-narrow-first-delivery)
was accepted on 2026-09-19 and superseded on 2026-09-28; nothing below is a pending
condition.* Canonical-only Organizations were stated as the target normal case:
upstream decision 0145 deprecates the legacy projection and makes `current` the end
state of every Organization. Admitting only parity-valid `transition` roots was then an
**interim gate** tied to upstream finalization readiness, not a product requirement
that an Organization keep a deprecated file, since requiring the projection forever
would have institutionalized migration machinery and made every new Organization
start in a migration state.

The exit criterion F12 stated was that `current` roots would become executable once
upstream accepted a trusted, live-verifiable identity continuity proof: evidence the
consumer could check at the operation boundary that a canonical-only root is the same
Organization that passed the finalization gate, without consulting the removed
projection and without trusting a locally stored claim alone. Meanwhile F12 excluded a
fallback to the projection, a second schema, a locally invented finalization marker
and admission from a digest that only proves the projection's content. The 2026-09-28
decision replaced that criterion rather than meeting it; the exclusions still hold.

## Relation to the upstream contract

The compatibility projection follows Core's materializable-repository boundary:
slots without repository coordinates stay in the authored inventory but are absent
from legacy `modules`; Productionspace entries carry no `teams`, `workspace` or
`workspaces` alias. This behavior is checked against
[Core's projector at f402e355](https://github.com/HumanAndMachines/Lazurio/blob/f402e35522ef947efe55c953f754e5d9d1fca98c/lazurio/core/organization-activation-lib.mjs)
with synthetic wire expectations in `tests/organization-root-resolution.test.ts`.
The regression proves a valid projection is executable and a stale declared hash
still refuses. It does not rewrite declarations or claim complete resolver
convergence.

The upstream contract already makes `lazurio.organization.json` canonical during a
parity-valid transition, with the legacy file a generated projection, not a second
authority. Removal waits for the separate reader/update/finalization gate and an
authorized per-Organization change. A later decision to finish the rollout does not
waive those existing gates. Real Organization materialization remains blocked on
consumer convergence and its owning rollout, not on inventing another filename or
schema; its future operation is [content synchronization](content-sync.md). No real
conversion, cloning or legacy removal occurs in this increment.
