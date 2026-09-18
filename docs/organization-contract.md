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
  `prepare`, `clean-prepare` and `start`) accepts only `current` or parity-valid
  `transition`. `legacy`, `projection_drift`, `conflict`, `missing`, a template and
  an unresolvable root refuse before descendant inspection, the owner lock,
  preparation, script start or any write.
- Discovery stays inspection-only: `applications-observed` carries the resolution
  state and an explicit `admission: executable | inspection-only`; a
  `projection_drift` root is still listed from the canonical file but is not
  executable. Conflict returns `organization-conflict` with issue codes only.

The upstream contract already makes `lazurio.organization.json` canonical during a
parity-valid transition, with the legacy file a generated projection, not a second
authority. Removal waits for the separate reader/update/finalization gate and an
authorized per-Organization change. A later decision to finish the rollout does not
waive those existing gates. Real Organization materialization remains blocked on
consumer convergence and its owning rollout, not on inventing another filename or
schema. No real conversion, cloning or legacy removal occurs in this increment.
