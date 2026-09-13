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

## Explicit filesystem reader

`readModuleApplication` reads `lazurio.module.json` and the selected declared
`package.json` (`lazurio.runtime` plus package scripts). Ordinary package metadata
is allowed; legacy `companyascode.app` requires explicit adoption, not an implicit
fallback. Undeclared applications return the selector's blocked result.

This POSIX development adapter requires a canonical, caller-owned, non-shared-write
module directory and checks every intermediate app directory. Files must be owned,
regular, single-link and non-shared-write; reads use no-follow/nonblocking opens,
identity checks, a 1 MiB declaration limit and strict UTF-8 JSON. It never scans
Organizations, executes scripts, fetches URLs or writes files. Tests use invented
temporary modules, including links, malformed/oversized data and legacy conflicts.

This is a snapshot under stable, cooperative local directories, not a sandbox against
same-user ancestor replacement, a cross-file transaction, provider authorization or
an executable lease. The lifecycle owner must revalidate declarations and authority
before launch. Windows filesystem semantics and the complete CLI/UI consumer remain
unqualified; this adapter does not alter the pending Organization binding model.

## Listener health observation

`probeListenerHealth` performs one bounded HTTP(S) or TCP connectivity observation
for a validated loopback endpoint. It does not certify which process owns that port.
The lifecycle owner must combine health with fresh process/binding ownership evidence
before reporting an application ready; an unrelated service can also return HTTP 200.

HTTP uses direct Node-compatible request APIs with no reusable proxy agent, no
credentials, no redirects and no response-body buffering. Non-2xx is `http-error`;
transport/TLS failure is `unavailable`; the overall deadline is `timeout`. HTTPS
certificate verification stays enabled. `localhost` tries only numeric IPv4/IPv6
loopback under one deadline, never hosts-file/DNS targets. A responding IPv4 service
ends that observation, so this is not a discovery mechanism for multiple local services.
No response bodies, headers, URLs or low-level errors are returned in the report.

Synthetic native-host tests cover a real child HTTP process observed through the
module reader, success then disappearance after test-owned termination, TCP response,
HTTP failure, unfollowed redirect, stalled response and unsafe input. They do not prove
process-tree ownership, production start/stop, certificate distribution, or Windows/
Linux qualification. The child is launched and cleaned up by the test, not a second
Platform supervisor. No real Organization app was started.

Reference API behavior: [Node networking](https://nodejs.org/api/net.html) and
[HTTP client](https://nodejs.org/api/http.html). Existing runtime ownership behavior
was inspected in `lazurio/runtime/runtime-lib.mjs`; no implementation was copied.

## Native listener/group observation

`observeListenerBindings` queries the exact declared port using the OS `lsof`
executable (`/usr/sbin/lsof` on macOS, `/usr/bin/lsof` on Linux). It requests only
PID, process group, numeric UID, file descriptor and numeric binding fields. No
command arguments, process environments, filenames or working directories are read.
The subprocess has a 5-second timeout, bounded output and a minimal environment;
missing tools, warnings, malformed/partial fields or failed inspection are unavailable.
The field format follows the [lsof manual](https://lsof.readthedocs.io/en/stable/manpage/),
not a copied legacy parser. No-match means nothing was observed, never a reserved or
globally free port, because visibility can be restricted.

`compareListenerGroup` compares an observation to the lifecycle owner's expected
group and exact declared loopback binding. Any foreign group, wildcard or other
binding refuses a positive match. These observations are transient evidence, not
durable PID identity, permission to kill, a process handle or a replacement locator.
The future single lifecycle owner must retain actual launch ownership and account
for races and PID reuse; accepting a caller-supplied group number alone is not enough.
This code does not create a supervisor, take over a port or change live applications.

### Native evidence, 2026-09-13

The standalone `scripts/smoke-listener-ownership.ts` runner passed on macOS ARM64
and Ubuntu ARM64: spawn a synthetic child in a distinct group, observe matching
PID/group and binding, refuse a different expected group, confirm HTTP still responds,
then terminate only the test-owned child and confirm the endpoint is unavailable.
Linux ran with `env -i`, without Bun or Node installed, with the system `lsof` present.
The transferred artifact's SHA-256 matched
`9999eb10567e6421bef551c1539130416a2741977da7b67fa2157ca2f8718452`.
The VM was stopped afterwards. This is not an installation, clean-image claim,
Windows qualification, multi-process tree stop, or CLI/Launchpad lifecycle acceptance.

Build the runner with pinned Bun and compile autoloading disabled, for example:

```sh
bun build scripts/smoke-listener-ownership.ts --compile --target=bun-linux-arm64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/listener-ownership-linux-arm64
```

Run the compiled executable, not the TypeScript source: it launches itself in the
synthetic child mode. It requires only supported OS inspection tools at runtime;
it neither installs tools nor reads real Organization data.

## Same-instance process adapter — development only

`startOwnedProcess` is a bounded POSIX adapter for the future single lifecycle owner,
not another supervisor or a product-facing execute endpoint. It takes an explicit
absolute executable, argument array, owned working directory and data-only environment;
it does not inherit ambient credentials, select a toolchain, install dependencies or
interpret a shell command. Output is discarded in this initial adapter, not copied
to a new log store. The application layer still must establish actual authorization,
module custody, tool readiness, lease exclusion and the existing server/locator owner.

The returned same-instance handle retains the spawned launcher and process group.
There is no `stop(pid)` or reconstruction from persisted numbers. Concurrent stop
requests share one operation. Stop sends TERM, waits for launcher exit and group
absence, then may escalate to KILL while the launcher is still live. An observed
absent group is permanently retired. Launcher exit also retires destructive signaling;
each signal rechecks the subprocess's current exit state. A surviving group after
launcher exit returns `incomplete/launcher-exited`, not successful tree termination.

Mac-host synthetic tests exercise a launcher with a separate HTTP child, shared stop,
graceful group shutdown, forced shutdown with a different application left responding,
invalid process inputs, and launcher exit before stop or during grace. In the latter
cases a surviving child receives no further signals, even on repeated stop. Only the
test cleans up its deliberately orphaned fixture; this is not a product recovery path.

Review found and fixed delayed signaling through a stale group number. The remaining
POSIX check-then-signal race is **not** an atomic identity guarantee. Surviving or
escaped descendants, daemonized children, crash recovery, durable ownership, native
Linux/Windows process-tree qualification and CLI/UI integration remain incomplete.
Do not expose this primitive to installed consumers until the single lifecycle owner
provides the stronger identity/descendant handling required by acceptance. Group stop
alone does not prove an arbitrary process tree is gone. Existing runtime semantics
were observed at the legacy commit recorded above; no legacy source was copied.
The new adapter uses [Bun subprocess APIs](https://bun.sh/docs/runtime/child-process).
