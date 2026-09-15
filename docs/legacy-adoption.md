# Selective adoption of existing behavior

The Principal delegated the Launchpad implementation judgment: preserve verified
necessary user flows and replace coherent parts progressively in TypeScript. This
does not authorize a blind 1:1 rewrite, wholesale source copy or permanent JavaScript
fork. Reuse requires license/provenance review. Current maintenance remains with its
current owners until each replacement is qualified.

The first real installed-product consumer is **discover a permitted module, start
its declared application, observe status and stop its managed process tree** without
a Platform checkout. Test the same path through CLI and Launchpad, including denied
access, invalid manifest, busy port and failed start. The profile preview experiment
does not satisfy this consumer.

The [module adoption record](module-adoption.md) pins the observed existing wire
contract and documents the new TypeScript reader/explicit app selector. Parsing is
not discovery, access verification or a running lifecycle consumer.

| Concern | Proposed disposition | Evidence and convergence |
| --- | --- | --- |
| Module/Organization discovery | Preserve contracts, port implementation selectively | Real manifest fixtures, case/remote identity and unauthorized/unknown scope denial |
| App start/status/stop | Preserve useful behavior, one TS lifecycle owner | Actual managed process tree and endpoint readiness; CLI/UI equivalence; no second supervisor |
| Launchpad UI | Rebuild by verified user flow, framework decision pending | Browser acceptance for navigation/status/errors; avoid copying old source-text tests as behavior proof |
| Git preservation checks | Reuse justified invariants and fixtures with provenance | Dirty/stash/worktree/ref and interrupted-recovery assertions survive the port |
| Large legacy modules | Decompose only by demonstrated state/ownership seams | Smaller file count or line count is not acceptance |
| Dependency repair | Preserve current lockfile-owned rebuild semantics | Failed derived dependencies stay isolated; no conflation with user-data rollback |
| Source-only install assumptions | Remove from the daily Lazurio Environment path | Installed consumer works without source tree, test runner, build scripts or development tools |

Any temporary compatibility adapter gets an exact source ref, narrow input/output
contract, owner and retirement condition in its introducing PR. It must not create
a second persistent state owner or a runtime fetch of legacy source. Remove it after
the corresponding native and browser consumer tests pass and the supported cohort
no longer uses it. Do not retain all legacy JavaScript behind a generic bridge.

## Doctor — accepted design direction, not implemented

The Principal accepted a small TypeScript diagnostic orchestrator for installed Lazurio Environments,
with reusable probes judged individually. Installer, runtime and Doctor share the same
validators; CLI and Launchpad consume the same typed,
locale-neutral results and severity/policy decisions. Check is read-only; repair is
an explicit operation with its own authority, preview and recovery conditions.

| Existing check family | Recommendation | Acceptance |
| --- | --- | --- |
| Artifact/profile/manifest compatibility | Adapt to installed state | Detect exact installed version, output drift and unsupported schema without writes |
| Provider identity/access | Reuse verified provider semantics | Explicit online readiness reports fresh identity/grants; offline check never fabricates them |
| Repository and worktree preservation | Retain relevant probes | No fetch/reset/stash in read-only Doctor; repair is separately scoped |
| Source checkout / development toolchain | Move to explicit development gate | Daily user not blocked by absent Platform, formatter, test runner or source Git branch |
| Process/port/readiness | Adapt through lifecycle owner's read interface | One process/locator truth, precise unavailable/error result |
| Obsolete duplicate probes | Remove after mapped replacement tests | No parallel Doctor policy table or duplicate mutable readiness store |

The orchestrator should aggregate probe results, not invent another generic workflow
engine. Define structured errors and exit codes from actual CLI/UI consumers before
implementing broad repair. Native OS failure fixtures and check-does-not-mutate
tests are required. This accepted direction does not switch the active Doctor implementation.
