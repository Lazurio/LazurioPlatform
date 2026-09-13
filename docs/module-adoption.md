# Module contract adoption

The next Launchpad consumer is permitted-module discovery followed by app
start/status/stop through one shared lifecycle owner. It must not invent a second
module catalog, port registry or process supervisor.

Protocol observation: `HumanAndMachines/Lazurio` at
`afa1c19fab473be6ee38094e5db769b6b0722e51`, specifically
`lazurio/schemas/lazurio-module.schema.json` and
`lazurio/core/module-contract-lib.mjs`. These files were clean at inspection.
The source license is FSL-1.1-Apache-2.0; no legacy implementation or schema file
has been copied into Platform or relicensed. The new TypeScript reader implements
the existing declarative wire fields and constraints with invented fixture data.
Any later source reuse still requires its own rights/provenance review.

`src/modules/manifest.ts` reads `lazurio.module.v1`: module/company identity,
none/single/exception TCP policy, module-owned loopback port leases, declared
package paths and the default app. Duplicate lease IDs/ports, unknown fields,
invalid paths, missing defaults and contradictory no-app/no-port states fail.
It keeps missing legacy `apps` distinct from explicit `apps: []`. The pure
application selector refuses to guess an app for a missing declaration and only
selects the declared default or an explicitly requested declared package.

The reader follows the published schema's conservative package-path character set;
the older JavaScript validator is more permissive for path characters. Unsupported
legacy spellings must be reported, not normalized or silently renamed. Newline/NUL,
accessor-valued objects and sparse/executable arrays are refused. Parsed snapshots
do not grant provider rights, prove filesystem custody or authorize taking a port.

Remaining consumer work: bind module identity to an authorized Organization and
canonical contained path; read explicit app package runtime declarations; validate
runtime-to-lease references; integrate one process/locator owner; prove readiness,
stop-owned-tree, wrong identity, invalid manifest, occupied port and failed start
through CLI and Launchpad. Local-founder binding still requires the F6 amendment.
No running legacy Server or real module was contacted or started in this step.
