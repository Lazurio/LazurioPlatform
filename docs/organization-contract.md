# Organization contract authority and convergence

The maintained Lazurio Core contract is authoritative, not a new Platform schema:

- [Manifest family](https://github.com/HumanAndMachines/Lazurio/blob/b6c2849e2f5b1b6ca91cf197a597be7dc9270ceb/manual/lazurio-manifest-family.md), accepted by decisions 0026, 0031 and 0042.
- [Authored schema](https://github.com/HumanAndMachines/Lazurio/blob/b6c2849e2f5b1b6ca91cf197a597be7dc9270ceb/lazurio/lazurio.organization.v1.schema.json), SHA256 `e75588a6fef1d96953f1241fea377bdfd89d07c007d6d539da1b4cf12a9b1f61`.

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
The root repository name is explicit, not derived as `<Owner>/<Owner>_GEN3`.
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
  **variant B, decided by the Principal on 2026-09-28** (question H1 of the
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
- The Folder catalog (`lazurio organization list`, `lazurio module list`, the
  Launchpad home) applies this reader to every directory in
  `<Folder>/organizations/`; a candidate that cannot be read, a template and two
  candidates declaring one slug are isolated with a typed reason and never hide
  the others. See [launchpad development](launchpad-development.md#launchpad-home-the-catalog).

## Exit from transition-only admission

**Decided 2026-09-28 by the Principal (question H1 of the Launchpad parity shaping,
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

The upstream contract already makes `lazurio.organization.json` canonical during a
parity-valid transition, with the legacy file a generated projection, not a second
authority. Removal waits for the separate reader/update/finalization gate and an
authorized per-Organization change. A later decision to finish the rollout does not
waive those existing gates. Real Organization materialization remains blocked on
consumer convergence and its owning rollout, not on inventing another filename or
schema; its future operation is [content synchronization](content-sync.md). No real
conversion, cloning or legacy removal occurs in this increment.
