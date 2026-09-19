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
  `prepare`, `clean-prepare` and `start`) accepts only parity-valid `transition`;
  it is the single executable state. A canonical-only `current` root is observable
  and inspection-only until a separately proven finalization: decision 0145 lets
  the projection disappear only after the finalization gate has covered every
  mutation-capable reader, and a valid digest proves the projection's content, not
  that the gate ran. `current` becomes executable only once the pinned Core
  envelope carries an explicit, verified finalization admission signal. `legacy`,
  `projection_drift`, `conflict`, `missing`, a template and an unresolvable root
  refuse before descendant inspection, the owner lock, preparation, script start
  or any write. Every present document is normalized with the upstream issue codes
  (slot path grammar and scope, `module_port_pool` range, legacy identity and
  schema) before any state is assigned.
- Discovery stays inspection-only: `applications-observed` carries the resolution
  state and an explicit `admission: executable | inspection-only`; a
  `projection_drift` root is still listed from the canonical file but is not
  executable. Conflict returns `organization-conflict` with issue codes only.

## Exit from transition-only admission

Accepted direction (2026-09-19, [decision F12](decisions.md#f12--canonical-only-organizations-and-a-deliberately-narrow-first-delivery)),
not implemented. **Canonical-only Organizations are the target normal case.** Upstream
decision 0145 deprecates the legacy projection and makes `current` the end state of
every Organization. Admitting only parity-valid `transition` roots, as described above,
is an **interim gate** tied to upstream finalization readiness. It is not a product
requirement that an Organization keep a deprecated file: requiring the projection
forever would institutionalize migration machinery and make every new Organization
start in a migration state.

Exit criterion, stated generically: `current` roots become executable once upstream
accepts a **trusted, live-verifiable identity continuity proof**, that is, evidence the
consumer can check at the operation boundary that this canonical-only root is the same
Organization that passed the finalization gate, without consulting the removed
projection and without trusting a locally stored claim alone. When the pinned Core
contract carries that signal, Platform admits `current` as the normal executable state,
keeps `transition` executable while it still exists, and deletes nothing itself.

Until then nothing changes: no fallback to the projection, no second schema, no
locally invented finalization marker, and no admission from a digest that only proves
the projection's content.

## Relation to the upstream contract

The upstream contract already makes `lazurio.organization.json` canonical during a
parity-valid transition, with the legacy file a generated projection, not a second
authority. Removal waits for the separate reader/update/finalization gate and an
authorized per-Organization change. A later decision to finish the rollout does not
waive those existing gates. Real Organization materialization remains blocked on
consumer convergence and its owning rollout, not on inventing another filename or
schema; its future operation is [content synchronization](content-sync.md). No real
conversion, cloning or legacy removal occurs in this increment.
