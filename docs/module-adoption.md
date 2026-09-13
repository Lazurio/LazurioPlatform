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

## Pipe-controlled process group — development only

`startGuardedProcess` replaces the provisional numeric-group signaling adapter;
there is only one maintained launch/stop implementation. The caller supplies a
verified Platform executable and explicit app executable, args, owned cwd and data-only
environment. No ambient credentials or shell interpretation are added. Application
stdout/stderr is currently discarded; diagnostics/log integration remains unfinished.
The future single lifecycle owner still establishes authorization, module custody,
toolchain readiness, lease exclusion and the existing server/locator. This library
does not itself expose app actions through the public CLI or Launchpad API.

The Platform executable has an internal `__lazurio-process-guard` entrypoint. It
verifies that it is the leader of its own POSIX process group before launching any
app. It reads one bounded JSON launch request over inherited stdin, starts the app
inside that group, and reports only started PID / launcher exit code over stdout.
It remains alive after the app launcher exits, retaining the group's leader identity.
It has no network listener, locator, durable PID record or separate distribution.

The owner requests stop over the pipe; concurrent stop requests share one operation.
The guard ignores its own TERM, sends TERM to its own group, waits the bounded grace
period, then sends KILL to that same group including itself. Because the signaler is
the still-live group leader, this does not reconstruct authority from a stale numeric
group. The parent never sends a destructive signal to a saved PID/PGID. Pipe EOF
also triggers cleanup. Missing/malformed launch messages fail through the same cleanup.
The parent confirms guard exit and observed group absence before returning
`group-stopped`; missing confirmation or an unexpected surviving group is `incomplete`.

Compiled Mac-host tests cover normal and TERM-ignoring launcher/child groups, launcher
exit before stop and during grace (including surviving children), concurrent/repeated
stop, failed executable, refusal to run in the caller's existing group, pipe EOF
cleanup, and preservation of a second live application while stopping the first.
Input tests retain immutable data-only environment snapshots and reject
implicit executables and NUL arguments. These are synthetic tests; the app explicitly
uses the developer Bun as its fixture toolchain, while the guard is the compiled CLI.

This improves ordinary launcher-exit handling but is not containment of arbitrary
daemonized/escaped descendants. Unexpected guard death, durable crash recovery,
the complete native Linux/Windows qualification matrix and full CLI/UI consumer integration
remain incomplete. A group-stop result does not prove an arbitrary process tree is
gone. No daily installation is activated, and there is no permission granted by this
internal protocol. Existing runtime semantics were observed at the legacy commit above;
no legacy source was copied. The adapter uses
[Bun subprocess APIs](https://bun.sh/docs/runtime/child-process).

### Compiled guard native evidence, 2026-09-13

`scripts/smoke-guarded-process.ts` uses a separately compiled actual `src/cli.ts`
for the internal guard and its own standalone executable for the synthetic launcher
and child. With Platform source `f07e022e3880826c79ad14432ac2306ad665d268`, it passed
on the Mac ARM64 host and Ubuntu ARM64 VM: normal stop, TERM-ignoring processes,
launcher exit before stop, launcher exit during grace, live listener/group match,
endpoint disappearance, concurrent/repeated stop and an unrelated application left
responding. Both run with empty environments; Ubuntu had neither Bun nor Node installed.
`/bin/ps` and `/usr/bin/lsof` were present. The transferred Linux hashes matched:

- Platform CLI: `26e8a44c20c88785fb83bef67a25e512486e5a5ad7346cef1440a5a20b1f7f88`.
- Standalone runner: `bcf0214fcf8901fb543c78c1d24149a2791e6181d3e9170943e4965fa27e92d8`.

The first Linux attempt correctly refused a group-writable fixture directory inherited
from the guest umask. The runner and source test now request mode 0700 explicitly;
product custody checks were not relaxed. The corrected runner passed, then the VM
was stopped. This reused test VM is not a clean installer test. Linux evidence here
does not cover pipe EOF, guard death, escaped descendants, Windows, Organization
authorization or the still-missing user-facing app lifecycle commands and UI.
