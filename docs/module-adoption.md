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

## App runtime declaration

`src/modules/runtime.ts` adds a new TypeScript reader for `lazurio.runtime.v1`,
observed in `lazurio/schemas/lazurio-runtime.schema.json` and
`lazurio/core/runtime-contract-lib.mjs` at the same legacy commit above (clean files).
No legacy source is embedded. The pure runtime plan binds an explicitly declared
package to matching company/module identity, an existing own package script, and
the module's leases. Host/port values come only from that module, not app overrides.

Exactly one HTTP(S) entrypoint is required. Listener IDs and lease references must
be unique; missing lease references or contradictory health protocols are refused.
Optional required module slots and presentation/build metadata are retained without
claiming their availability. Parsing never runs scripts, resolves plugins or fetches
production/health URLs. The executor still must verify filesystem containment,
provider scope, dependency readiness and exclusive ownership before any effect.

Health paths receive an additional safety check beyond the legacy schema's leading
slash: resolving a path must retain the bound origin. Network-relative URLs,
backslashes and tab-normalized origin escapes are refused. This is not yet a health
probe implementation; future HTTP probes must also bound timeouts and redirects.
Nonempty textual fields additionally reject blank-only or newline/NUL values.

Fixtures verify a valid runtime-to-lease plan, an undeclared package, wrong identity,
absent/accessor script, duplicate listeners, missing leases, unsafe health paths and
retained module requirements. These checks prepare the common lifecycle consumer;
they are not app start/status/stop or installed-product evidence.
