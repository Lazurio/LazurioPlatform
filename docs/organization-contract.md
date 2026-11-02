# Organization contract

An Organization is described by its manifest family: `lazurio.organization.json`
(the Organization manifest), `modules.manifest.json` (its repository slots) and
the `lazurio.module.json` of each Module ([Module Standard](module-standard.md)).
The family was accepted by decisions
[0026](decision-register.md#0026--canonical-organization-layout-and-its-single-manifest-authority),
[0031](decision-register.md#0031--organization-mounts-are-nested-repositories-classified-by-one-resolver)
and [0042](decision-register.md#0042--the-launchpad-discovers-organization-mounts-by-itself);
decision [0145](decision-register.md#0145--the-organization-manifest-compatibility-window-ends)
ends the compatibility window of the legacy `company.gen3.json`. This repository
is the contract's authority (decision 0225): this document and the readers that
apply it.

## Who holds the contract

- **Readers in this repository:** `parseCanonicalOrganization`
  (`src/organizations/canonical-manifest.ts`) checks the authored document and its
  cross-field rules; `organizationSettings`
  (`src/organizations/organization-settings.ts`) is the only reader of `settings`;
  `src/organizations/root-resolution.ts` resolves an Organization root's
  compatibility state. The readers are the contract as it is enforced.
- **The JSON Schema of `lazurio.organization.v1`** is
  `src/organizations/lazurio.organization.v1.schema.json`, written in this
  repository from this document and the readers. Decision 0225 rules out copying
  the GEN3 Root's schema, which is under another licence. [The schema](#the-schema)
  below says what it covers and what only the readers check;
  `tests/organization-schema.test.ts` holds the schema and the readers together.
- **A change of the contract** changes this document, the readers and the schema
  in one pull request of this repository.
- **Consumers follow this repository.** The Lazurio Root (GEN3) is a consumer: its
  Core validates Organization manifests on a person's computer against its own
  `lazurio/lazurio.organization.v1.schema.json` until it pins the schema of this
  repository by commit and SHA-256. It never extends the contract on its own.
- **Known gaps.** The GEN3 Root's own schema does not define
  `settings.workspace.tabs`, which `organizationSettings` reads ([F32](decisions.md#f32--teams-are-not-a-presentation-axis-of-the-launchpad-an-environment-is-one-workspace),
  addendum of 2026-10-16): a manifest with tabs fails that schema while this
  repository's readers and schema accept them.

## What the readers check

`organization.forge_binding`, the optional `root_repository`, metadata, the
inventory pointer, extensions and the compatibility projection are fields of the
manifest. Verified Organization and repository IDs remain a complete pair; owner and
binding state must match and the compatibility branch remains `main`.
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

An Organization root is in one of the compatibility states of decision 0145:
`legacy`, `transition`, `projection_drift`, `conflict`, `current` or `missing`.
`src/organizations/root-resolution.ts` resolves them in GEN4, and the Root's Core
resolves the same table in GEN3. A resolution's result is a read model, never
validated as the authored manifest and never a second schema:

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
  proven and is stricter than the Root's Core, never looser.
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
  Every present document is normalized with the contract's issue codes (slot path
  grammar and scope, `module_port_pool` range, legacy identity and schema) before
  any state is assigned.
- Discovery stays inspection-only: `applications-observed` carries the resolution
  state and an explicit `admission: executable | inspection-only`; a root the
  admission rule does not execute (`projection_drift`, and `current` under variant
  A) is still listed from the canonical file but is not executable. Conflict
  returns `organization-conflict` with issue codes only.
- The Organization root and its documents are the user's own checkout (decision
  F23): the root is accepted when it is a real directory owned by the user, each
  document when it is a regular file of at most 1 MiB owned by the user;
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

Decision 0194 adds the optional, closed `settings` section of
`lazurio.organization.json`; the reader `organizationSettings` defines its
tree and the schema's `$defs.organizationSettings` states it. Its settings are
`integrations.composio.allowed`, `integrations.chatgpt_apps.allowed`,
`integrations.microsoft365` (`tenant_id`, `client_id`, `apps`, `callbacks`),
the Dashboard's own `access_requests.enabled`, and `workspace.tabs`, which the
GEN3 Root's schema lacks (see the known gaps above).

- `parseCanonicalOrganization` accepts the section and keeps it as authored but
  never judges it. `organizationSettings` (`src/organizations/organization-settings.ts`)
  is its only reader: `absent`, `valid` (exactly the declared keys, plus the
  effective value of every known key) or `invalid` (nothing applies; every issue
  carries the contract's code and JSON Pointer).
- A malformed section never turns the Organization into a `conflict`: the
  projection and its hash, the root state, execution admission and the root
  declaration used by content synchronization ignore it, as the Root's Core does.
  Every other unknown top-level field still refuses the manifest.
- An absent value is not governed by the Organization and the Environment
  decides; a present value governs every work Environment of the Organization;
  personal Environments ignore it. Applying a setting and reporting each item is
  decision [F45](decisions.md#f45--organization-settings-reach-the-environment-asked-through-its-relay-recorded-in-the-folder-reported-back):
  the Launchpad asks the Dashboard through the Environment's relay, or reads this
  section from the Organization's root in the Folder where there is no relay, and
  records what it applies in the Folder. `deliveredSettings` reads the Dashboard's
  answer by the same contract, keeping a key this release does not know apart, by
  its key only, to be reported `unsupported`.
- `access_requests` (`{ enabled: boolean }`, decision 0204, addendum of
  2026-10-17 afternoon, point b) is the Dashboard's own setting. The reader checks
  it like every other leaf, so writing it never withholds the rest, and then drops
  it from `values`: it has no key and is never applied or reported. The Dashboard
  never delivers it, so only a root read from Git holds it (F45).
- A new setting is one leaf of `organizationSettings` and one of the schema's
  `$defs.organizationSettings`, added in one pull request; the GEN3 Root's Core
  reads it once it follows that commit.
- Readers first: older releases reject a manifest with the section as an unknown
  field. An Organization adds it only after the release with this reader runs on
  all of its Environments.

## The schema

`src/organizations/lazurio.organization.v1.schema.json` states the contract as
JSON Schema 2020-12 under the `$id`
`https://lazurio.io/schemas/lazurio.organization.v1.schema.json` and compiles in
Ajv's strict mode. `tests/organization-schema.test.ts` binds it to the readers on
synthetic fixtures it shares with the tests of `parseCanonicalOrganization` and
`organizationSettings` (`tests/fixtures/organization-manifests.ts`): every
manifest the readers accept passes the schema, and every manifest they refuse
fails it unless the test lists it as checked only by the readers, with the
reason.

- **What it covers:** every field the readers read. That is `schema_version`,
  `kind`, the `organization` identity with its `forge_binding` and `metadata`,
  `root_repository`, `manifests`, `extensions.legacy`,
  `compatibility.legacy_projection`, `module_port_pool`, `governance`, `teams`,
  `layers`, `task_sources`, `doctor`, and `settings` as
  `$defs.organizationSettings`, `workspace.tabs` included.
- **Closed where the readers are closed:** the top level, the identity, both
  bindings, `manifests`, `extensions`, `compatibility`, the port pool, a Team's
  `forge_binding` and every level of `settings` refuse an unknown key. Where the
  readers keep Organization-owned data as authored, the schema is open:
  `metadata`, `extensions.legacy`, `governance`, `doctor`, `layers`,
  `task_sources` and a Team's other fields. `metadata` and `extensions.legacy`
  still refuse the names the legacy projection writes itself.
- **Binding states are schema rules:** a verified binding carries its ID and an
  unverified one none, and the owner and the root share one state, so a verified
  Organization declares a verified root.
- **Only the readers check** these rules, which JSON Schema cannot express: it
  compares no two values, reads no other document or file, never sees the JSON
  text and counts the length of a string in code points.
  - the owner in `root_repository.locator` is the Organization's login, ignoring
    letter case;
  - `module_port_pool.start` does not exceed `end`;
  - two Workspace tabs never share a name (in NFC, ignoring letter case), and a
    module is in one tab at most;
  - a tab name has at most 40 UTF-16 code units: a name of 21 to 40 characters
    outside the Basic Multilingual Plane, such as emoji, passes only the schema;
  - the declared projection digest is the digest of the projection of this
    manifest and its inventory;
  - `modules.manifest.json` exists, is well formed and names the same
    Organization, and `company.gen3.json`, while it exists, is this manifest's
    projection;
  - the JSON text names no member twice and holds no number beyond a double
    (`1e400` parses to Infinity);
  - the file rules of decision F23 above: a regular file of at most 1 MiB owned
    by the user.
- **A malformed `settings` section** fails the schema, while the Platform keeps
  the Organization usable and applies none of the section (see Organization
  settings above). A consumer that keeps this tolerance validates the manifest
  without `settings` and the section on its own against
  `#/$defs/organizationSettings`.
- **Consumers pin it** by this repository's commit and the file's SHA-256; the
  GEN3 Root is to do so in its own pull request.

## Exit from transition-only admission

**Decided 2026-09-28 by Matěj (question H1 of the Launchpad parity shaping,
decision F22 point 1): the transition-only gate is retired and this section is a
historical record.** Admission runs variant B (see the execution admission bullet
above): a parity-valid `transition` root and a canonical-only `current` root both
execute; `legacy`, `projection_drift`, `conflict`, `missing`, a template and an
unresolvable root refuse. No identity continuity proof from the Root's Core is
awaited: no owner of such a proof was named, and a canonical-only Organization would
otherwise lose its applications when the Platform Launchpad replaces the resident one.
Nothing falls back to the deprecated projection, no second schema and no local
finalization marker exist. Variant A stays one line away in
`src/organizations/root-resolution.ts` for the record, covered by tests.

*Historical, as [decision F12](decisions.md#f12--canonical-only-organizations-and-a-deliberately-narrow-first-delivery)
was accepted on 2026-09-19 and superseded on 2026-09-28; nothing below is a pending
condition.* Canonical-only Organizations were stated as the target normal case:
decision 0145 deprecates the legacy projection and makes `current` the end
state of every Organization. Admitting only parity-valid `transition` roots was then an
**interim gate** tied to the Root's finalization readiness, not a product requirement
that an Organization keep a deprecated file, since requiring the projection forever
would have institutionalized migration machinery and made every new Organization
start in a migration state.

The exit criterion F12 stated was that `current` roots would become executable once
the Root's Core, then the contract's owner, accepted a trusted, live-verifiable
identity continuity proof: evidence the consumer could check at the operation
boundary that a canonical-only root is the same Organization that passed the
finalization gate, without consulting the removed projection and without trusting a
locally stored claim alone. Meanwhile F12 excluded a fallback to the projection, a
second schema, a locally invented finalization marker and admission from a digest
that only proves the projection's content. The 2026-09-28 decision replaced that
criterion rather than meeting it; the exclusions still hold.

## The legacy projection

The compatibility projection follows the materializable-repository boundary:
slots without repository coordinates stay in the authored inventory but are absent
from legacy `modules`; Productionspace entries carry no `teams`, `workspace` or
`workspaces` alias. This behavior is checked against
[Core's projector at f402e355](https://github.com/HumanAndMachines/Lazurio/blob/f402e35522ef947efe55c953f754e5d9d1fca98c/lazurio/core/organization-activation-lib.mjs)
with synthetic wire expectations in `tests/organization-root-resolution.test.ts`.
The regression proves a valid projection is executable and a stale declared hash
still refuses. It does not rewrite declarations or claim complete resolver
convergence.

The contract makes `lazurio.organization.json` canonical during a parity-valid
transition, with the legacy file a generated projection, not a second authority.
Removal waits for the separate reader, update and finalization gate of decision
0145 (in GEN3 the Root's `lazurio migrate organization-manifest --finalize`) and an
authorized per-Organization change. A later decision to finish the rollout does not
waive those existing gates. Real Organization materialization remains blocked on
consumer convergence and its owning rollout, not on inventing another filename or
schema; its future operation is [content synchronization](content-sync.md). No real
conversion, cloning or legacy removal occurs in this increment.

## Provenance

This document was written anew from the description of the manifest family in the
GEN3 Root (`HumanAndMachines/Lazurio`, `manual/lazurio-manifest-family.md` and
`lazurio/lazurio.organization.v1.schema.json` at commit `66e437f7`); no file was
copied (decision 0225). Before 2026-11-01 this page named the Root's Core as the
contract's owner and pinned its schema at commit
`b037a9f0691afea39efc722aede3a44125bf1d38` (SHA-256
`4f14f1a1fec950b39fd0fddb1b13f1c41874c99b836d1029f2ee9f91ff5c6292`). The Root's
later commits up to `66e437f7` added only `settings.integrations.microsoft365`,
`settings.integrations.chatgpt_apps` and `settings.access_requests`, which this
repository already read. The `settings` section was first defined in the Root's
Core (HumanAndMachines/Lazurio#512). Since 2026-11-01 LazurioPlatform is the
contract's authority. The schema `src/organizations/lazurio.organization.v1.schema.json`
was written from this document and the readers in `src/organizations/` (#799);
the GEN3 Root's schema was neither opened nor copied for it (decision 0225).
