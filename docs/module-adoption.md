# Module contract adoption

The next Launchpad consumer is permitted-module discovery followed by app
start/status/stop through one shared lifecycle owner. It must not invent a second
module catalog, port registry or process supervisor.

## Integrated consumer draft — current boundary

`organization-inspect --directory <permitted canonical Organization fixture>` now
exercises the shared read-only application inventory from the compiled CLI. It reads
the canonical Organization and declared module inventory, then only declared workspace
module/application files. It does not read the legacy Organization projection, guess
missing applications, inspect Repository DB contents, execute scripts or query GitHub.
Conflicted slots, unavailable modules and invalid runtimes remain explicit; healthy
siblings can still be observed. A final Organization-document recheck detects changes
during the observation. The result is not an atomic snapshot, provider permission,
dependency readiness or a reusable authorization to launch. Production selection must
still bind live access and revalidate the selected scope at each operation.

The development Launchpad accepts an optional `--organization-directory` selected by
its starting CLI. Its authenticated `POST /api/apps/discover` accepts only an empty
object and uses that configured directory, never a path supplied by the browser.
The panel presents the same declaration results and can populate the application
selection from a declared runtime. Refresh reads the canonical documents again;
conflicts remain visible and changing selection clears the previous app result/link.
Discovery does not install application authorization adapters: a discovery-only session
still refuses app control. Live provider/operation binding remains a separate missing
integration, not an implied permission from this local view.

The existing Launchpad server can compose one application lifecycle with trusted
authorization/toolchain adapters. Its authenticated application API serves both the
browser controls and the compiled development CLI's `app-request` stdin transport.
The latter accepts an explicit existing private session URL, operation and declared
selection, not a second locator, process owner or persisted credential. The standard
`launchpad --folder` command still configures only profiles; production Organization
bindings and the complete preparation/install journey remain incomplete.

Authenticated preparation requests use a 660-second transport wait rather than the
ordinary CLI request's 30 seconds, allowing the Bun preparation effect's maximum
600-second budget and cleanup. Launchpad extends that request's idle timeout only
after authentication and body parsing. A real 31-second shared-owner test covers
the CLI/server path. These deadlines do not cancel an operation, prove rollback,
or solve queue admission, reconnect/status tracking and uncooperative adapter
timeouts; those remain integration work, not reasons to automatically retry a write.

The browser exposes explicit preparation/start/status/link/stop in Czech and English. A link is restricted
to the selected execution Machine's observed loopback web listener, never production
metadata. Remote-profile context does not expose that address as a local browser link;
a qualified remote access route remains required. Process start, health observation,
opening a page and functional acceptance are distinct results.

Run `bun run scripts/smoke-application-ui.ts cs` and the same command with `en` using
an explicitly supplied external Playwright installation and its Chromium (for example,
via the test environment's `NODE_PATH`). This optional local harness compiles the CLI,
creates synthetic Folder/module data and an isolated browser, opens the synthetic app,
then stops its owner and removes only its temporary fixture. It is not a release gate
or evidence of either real candidate's installation/DB readiness. The main `bun run
check` includes transport, lifecycle and presentation unit/integration tests; it does
not implicitly download a browser or run this separate browser harness.

The Bun preparation adapter now composes exact toolchain/manifest/lock preflight,
a guarded frozen install, an optional explicitly selected declared module preparation
script and a mandatory read-only postcondition. The preparation script must belong
to the snapshotted package owner; it is not a browser-supplied command or an inferred
DB recipe. Both subprocess phases use the same retained process-group runner and
share the preparation deadline/cancellation. Manifest/lock drift, nonzero exit,
incomplete cleanup or failed postconditions prevent a prepared result. A terminated
module may leave partial data or its own recovery gate: Platform preserves these
instead of running a destructive repair or treating them as ready.

The install-authority package reader uses the same duplicate-member rejection as
the module/Organization declaration readers. Duplicate decoded keys in toolchain,
scripts or dependencies fail preflight before tool execution, including escaped
spellings of the same key. The original package and opaque Bun lockfile remain
unchanged; this does not parse a Bun lockfile as JSON or regenerate it. Regression
coverage is in `tests/install-authority.test.ts` and `tests/unique-json.test.ts`.

Trusted preparation composition may additionally select `moduleCheckScript`, an
explicit script from the same snapshotted package owner. It runs after installation
and optional preparation under the same deadline and cancellation signal. Its process
handle remains retained for cleanup, including after failure or cancellation. Nonzero
exit, incomplete cleanup or authority drift prevents the final postcondition callback
and a prepared result. The callback remains required; check-script exit alone does
not establish full application functionality. Read-only check behavior is a module
contract, not a sandbox guarantee. No manifest field, implicit script discovery or
browser-supplied command is introduced by this adapter option.

### Development preparation declaration

The application package may explicitly declare `lazurio.preparation` alongside
`lazurio.runtime`:

```json
{
  "schema_version": "lazurio.preparation.v1",
  "owner_package": "app/package.json",
  "prepare_script": "prepare:data",
  "check_script": "check:data"
}
```

This is a development contract, not a released API. `owner_package` is a safe
module-relative package path, not an ancestor search. `prepare_script` is optional;
`check_script` is required. Both name package scripts, not shell commands. Unknown
fields, versions, traversal and executable input objects are refused. An absent
declaration is explicitly `null` in the reader result; existing modules are not
silently assigned default script names or made preparation-capable.

The read-only application reader includes this declaration in its existing digest.
Parsing does not prove that the owner exists, owns the selected workspace package,
declares those scripts or may execute them. Before execution, the composition must
resolve and verify those facts, the toolchain and current authority under the existing
owner coordination. No dependency installation, script execution or new permission
follows from a successfully parsed declaration. Consumer wiring and native lifecycle
qualification remain incomplete; fixtures exercise parsing and unchanged source bytes.

`inspectPreparationBinding` now resolves that explicit owner using the existing owned
package/lock reader, checks self-ownership or declared array-form Bun workspace membership
(including exclusions), and requires the named scripts in the owner package. It repeats
the application digest and owner inspection before returning read-only observations.
This is still not permission or readiness: member manifests and other workspace install
inputs are not yet a complete execution snapshot, and normal CLI/Launchpad composition
is not enabled by this reader. No ancestor search or application-specific DB resolver
is introduced. The workspace matcher is also checked against a synthetic real Bun
installation; that check does not qualify arbitrary workspace layouts or native OSes.

The install authority additionally inventories manifest bytes of regular workspace
members selected by the declared positive and negative patterns. Verification repeats
the inventory, so changed manifests and added or removed members invalidate the prior
observation. Member ancestor identities are retained and declaration ownership rules
still apply. Enumeration does not follow symlinks; linked members are not qualified
by this observation. Traversal prunes Git/derived trees and paths that cannot contain
a declared match; the pinned MIT-licensed `minimatch` 10.2.6 partial matcher supplies
path-prefix matching rather than a handwritten glob parser (see its
[upstream API](https://github.com/isaacs/minimatch#partial)). Bun matching remains
the final membership filter. Nonmatching descendants and excluded leaves do not
affect the snapshot. This is not a complete effect-input snapshot: local dependency
contents, patches, workspace configuration and enumeration bounds still need their
own qualification before the workspace execution refusal can be removed.

The development `preflightDeclaredBunPreparation` adapter connects this inspection to
the existing preparation owner for a self-owned package without workspace declarations.
It selects the check/optional preparation scripts from the package, rechecks the binding
before execution and retains the existing cancellation, cleanup and mandatory final
postcondition. Workspace installation remains explicitly unavailable until its broader
input snapshot is qualified. A lifecycle fixture exercises real install/check/start/stop
through this adapter; the explicit local CLI composition below is its next consumer.
This intermediate boundary is not completion of either candidate's full module journey.

The development `launchpad` command can now opt into local application execution with
both `--organization-directory` and `--bun-executable`. Without the explicit executable,
discovery remains read-only. It does not download a toolchain or select one from PATH.
The executable must match the module's exact Bun version. Only HOME, PATH and optional
TMPDIR enter the selected process environment; module scripts still run as the local
account and can access its files, so this is not a sandbox or provider permission check.

One `localApplicationAdapters` composition resolves each selection from the current
canonical inventory, uses the declared self-owned preparation/check scripts, and shares
the dependency owner queue with start/stop. The module check supplies its postcondition;
the platform also rechecks install inputs, then independently observes process health
after start. This is not proof that arbitrary module check scripts are honest or that
all dependencies are semantically correct. No per-module database resolver is added.

The compiled CLI fixture covers missing prerequisites, explicit preparation, start,
observed health, actual HTTP content and owned stop without injected test adapters.
This composition remains development-only: qualified crash recovery, complete
workspace input capture, remote browser access, provider operations and installed
consumer qualification remain open. Do not run competing development owners against
the same dependency tree or use this as daily-environment activation.

The local dependency owner now retains the existing cooperative directory lock at
the resolved dependency root across operations, including after start returns.
The lifecycle first closes admission and drains accepted operations, then stops its
owned processes. Only a confirmed closed result releases the dependency locks.
An incomplete or throwing cleanup retains exclusion. This intentionally reserves
an encountered dependency root until that lifecycle closes, even after an app stop;
it does not hand processes to another supervisor or infer process adoption.
Competing owners receive a busy/recovery failure, not permission to reinstall.

The lock uses the same `.operation-lock` mechanism as Folder operations, but is
bound to the actual package/workspace dependency owner, not the Lazurio Folder.
Unknown existing locks, replaced directories and unexpected contents remain refused.
A killed owner can leave descendants and a retained lock; there is no automatic
age/PID-based reclamation. Operator recovery and native Windows/network-filesystem
support remain unqualified. This cooperative guard is not a same-user sandbox.

The existing `scripts/smoke-application-ui.ts` now starts that compiled CLI command,
not an injected lifecycle adapter. Its synthetic module declares its own data check
and preparation. On the local macOS ARM64 host, both `en` and `cs` passed canonical
discovery/selection, preparation, clean reinstall, start/status/open and stop through
actual Chromium controls and the compiled CLI. The harness independently checks the
synthetic dependency/data, unchanged package/lock and removal of only derived sentinels.
Run with an externally supplied Playwright/Chromium installation via `NODE_PATH`.
These are host synthetic integration results, not new real-module or VM qualification.

Local launch derives `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` and `_PORT` from each
validated runtime listener and its module-owned lease. IDs use uppercase with hyphens
mapped to underscores; the listener grammar disallows ambiguous underscore IDs.
The client cannot supply these addresses. A compiled CLI regression consumes the
variables in its real server and checks the resulting health/content; it failed
before this propagation was added. Preparation does not start the declared listeners.

For start-time prerequisites, `preflightDeclaredBunCheck` selects the explicit check
operation of that same process owner. It skips frozen installation and prepare_script,
requires check_script, and rejects clean-install mode. Module check code is expected
not to provision or repair; that is a module contract, not an OS sandbox guarantee.
The lifecycle's optional `preflightStartCheck` retains this operation through run/close
and shutdown before preparing an application launch. Failed prerequisites return
`prerequisites-not-ready`; unconfirmed cleanup stays owned and prevents another start.
Status inspection does not invoke this operation. Synthetic tests distinguish a missing
dependency from permission to install it and cover shutdown during the start check.

The browser harness installs a real synthetic local dependency and runs its explicit
module-owned synthetic data preparation before starting its app. An
installer exit of zero with failed module postconditions does not become prepared;
start adapters must also check current module prerequisites. This is not a generic
DB resolver or a claim that clean-install/workspace owner resolution is complete.
Preparation shares the lifecycle mutation path, stops only its selected owned app,
and retains incomplete cleanup for shutdown/recovery. While shared-owner overlap
resolution remains unimplemented, another managed app causes an explicit refusal,
not an assumption that mutating its dependencies is safe. Full composition with
actual Organization bindings, both candidates and their module-owned preparation
contracts remains the integrated milestone.

Module-owned dependency/DB preparation and adaptation to the target standard follow
[the architecture contract](../ARCHITECTURE.md#workspace-module-contract-and-first-usable-milestone).
Do not replace that ownership with application-specific Platform DB provisioning.

### Local draft verification — 2026-09-14

The current integrated working tree passed `bun run check` on macOS ARM64 with
Bun 1.4.2: 234 tests passed, one Windows-specific test was skipped, and none failed
(235 tests across 42 files, 1525 assertions).
Lint, TypeScript, the narrow public-input guard and standalone proof smoke passed.
The separate Chromium harness passed in Czech and English: canonical inventory discovery
and application selection in the panel, explicit frozen install and declared module preparation,
start, healthy status, opening the synthetic page and stop through the browser, followed
by the compiled CLI journey against the same lifecycle owner. Changing the selected
module clears the preceding application result instead of showing stale readiness.

Module preparation tests additionally run a declared script only after the install,
refuse absent/option-like script selections, reject success when postconditions fail,
and cancel a real preparation process with a live descendant. The retained guard
reports group-stopped, the descendant's heartbeat stops, and partial synthetic data
survives. This is POSIX local fixture evidence, not native Windows or arbitrary
module/Git recovery qualification.

This evidence applies to the local uncommitted draft and isolated synthetic fixtures,
not an approved release or qualification of actual Organization bindings, either real
candidate, clean-install, or VM/platform coverage. Repeat it on the exact review commit
before treating it as commit-bound integration evidence.

The canonical application inspection tests include the compiled CLI and exercise canonical-only acquisition,
conflict quarantine, missing/foreign modules, invalid runtime and linked-parent refusal.
Authenticated discovery tests reject browser-supplied directories and foreign origins,
re-read changed canonical state and prove that discovery alone does not grant app control.

### Native artifact lifecycle runner

Compile `scripts/smoke-application-native.ts` and `src/cli.ts` for the same target
with compile-time dotenv/bunfig autoload disabled. Run the compiled runner with the
absolute CLI artifact path and `cs` or `en`. Copy only those two artifacts to a
disposable guest and independently verify their digests before execution. The runner
creates and removes only its own synthetic Folder/Organization, uses an embedded test
application, and closes its lifecycle owner. It needs no separately installed Bun/Node
or Platform source in the guest. Its fixture-scoped authorization is not a live provider
adapter. This runner covers canonical discovery parity and shared CLI/HTTP
start/status/entrypoint/HTTP-function/stop, not package preparation, browser interaction,
DB acquisition, installation, or the two real candidate modules.

On 2026-09-14 it passed on the macOS ARM64 host (`en`) and Ubuntu 24.04.4 LTS ARM64,
kernel `7.0.0-30-generic` (`en` and `cs`). The Linux guest was a reused disposable Tart
2.32.1 test clone, not a fresh-install qualification; Bun, Node and Lazurio were absent
from its tested PATH. Networking was host-only, with no host directory/clipboard/audio
sharing or credential forwarding. Transfers matched the independently calculated
artifact digests; the owned test processes were absent after completion.

The same macOS artifacts subsequently passed both `en` and `cs` in a reused disposable
macOS 26.6.2 (25G83) ARM64 VM, also with Bun/Node/Lazurio absent from its tested PATH.
Only the compiled CLI and runner were copied; no Platform checkout or host working
directory was exposed. Independent digest checks preceded execution and both runs
closed their lifecycle owner. This adds native guest lifecycle evidence, not a clean
installation, notarization, browser or actual-module acceptance claim.

| Artifact from the local draft | SHA-256 |
| --- | --- |
| macOS ARM64 CLI | `f2601d02a53d544f786a1c6b46d75fbb667f935eeaf9da4cb52314c72d17b82c` |
| macOS ARM64 runner | `e9e39924e1fc3b9c67fc21b9ff734ae98104266c8991b21b05b931ad35400f2c` |
| Linux ARM64 CLI | `7d2c7b9564c03c762e0304ef3c716108dcaf83dda3883976587c391aba04ae0b` |
| Linux ARM64 runner | `feb1dd0dac16c0a782cdd5baaffbc6efadfbd6d41ada739eac7970077ab87a9c` |
| Runner source | `ce3a13a2bc2f14976d4e328bc38b2f49a98fde9d5d96e78809275b0e7dbdc072` |

These hashes identify tested local artifacts, not authenticated releases or reviewed
source commits. Repeat qualification after the integrated source is committed/reviewed.

## Workspace standards and versioned presets — accepted direction

Keep three responsibilities separate: the Platform's shared operational
install/lifecycle/Doctor contract, each application's concrete requirements, and
versioned preset inputs that produce a conforming starting application. Organizations
select their allowed standards/presets through their existing rules owner. TypeScript
and Bun are the first reference path, not a global ban on other qualified stacks.
Presets give agents and operators, including non-developers, tested starting points;
they do not certify arbitrary subsequent application code.

First document one standard and prove one reference preset through the existing
install/check/start/health/stop consumer. Then qualify conversion of one representative
workspace module without losing functionality or data. Follow with a deduplicated
inventory and gradual alignment of other workspace apps, and creation from a selected
tested preset. Fleet conversion and marketplace are not prerequisites for the first
usable Platform milestone. Nonstandard projects retain their Production Space regime;
this classification does not authorize moving existing paths.

Initial presets can be ordinary versioned sources without a backend. Generated modules
are Organization-owned code; changing a preset must not overwrite local customization.
Preset format, upgrade mechanism and UI remain open. Community presets and other
qualified stacks belong to the already planned marketplace, not another registry,
catalog, service or plugin framework. This direction adds no rollout or release mandate.

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

The draft now reads explicit app runtime declarations, validates runtime-to-lease
references and exercises readiness, owned stop and refusal cases through its shared
lifecycle tests and synthetic transports. Remaining consumer work includes binding
module identity to a live authorized Organization and canonical contained path,
the existing process locator, and full qualification with real modules. Local-founder
binding still requires the F6 amendment. Synthetic evidence does not authorize
contacting a running legacy Server or controlling a customer's module.

## Shared application lifecycle — development integration boundary

`createApplicationLifecycle` composes the module reader, guarded launch, listener
observation and owned stop into one in-memory owner. It is intended to be instantiated
once by the existing local server, shared by CLI and Launchpad requests. The draft
transports use this owner when trusted application adapters are supplied; default
production discovery/binding remains incomplete. Do not construct an owner per CLI invocation or
alongside the legacy supervisor for the same Environment. No locator, persistent
PID database, module catalog or permission store is introduced.

Every operation requires a trusted authorization adapter bound to the actual selected
company/module/package and operation; failure denies the request. The adapter supplies
the canonical module directory only after verifying the existing authority/custody
contract. This interface is not itself a GitHub probe or implementation of the pending
owner-local project model. The production adapter must perform those real checks.
The separate trusted toolchain adapter must honor the declared development script,
license/dependency/required-slot readiness and explicit environment policy. Neither
adapter is accepted from HTTP/CLI JSON or inferred from a path/profile label.

Start reads and validates the selected declaration, prepares an explicit launch,
serializes competing starts, refuses this owner's already claimed port or any observed
external binding, then rechecks authorization and declaration before spawn. Runtime
plans retain the selected script's digest; the filesystem reader additionally binds
the full decoded module/package declarations, including pre/post hooks, package
manager and dependencies. Revalidation therefore detects changed executable hooks,
not only a changed main command. Digests are local change detectors, not publisher
proof, and status returns neither command text nor these fingerprints.
Filesystem checks still assume stable cooperative
custody; they are not an atomic read-to-exec or cross-file transaction.

`started` means the guard reported a launcher, not readiness. Status observes each
declared listener through the retained handle; the aggregate is an instantaneous
observation, not atomic multi-listener evidence. A port race after inspection can
still cause a failed app start; no foreign process is adopted or signaled. Duplicate
start is `already-managed`, not a replacement/restart. Changed authorization scope
cannot control an old run. Stop removes an entry only after confirmed group cleanup;
incomplete cleanup retains it and blocks reuse. Owner shutdown closes new starts and
drains only retained groups, without needing new provider rights to clean up its own
resources. It cannot recover escaped descendants or adopt runs after owner death.

Native Mac-host synthetic tests run a declared package script with an explicit fixture
Bun toolchain and a compiled actual CLI guard. They cover concurrent duplicate start,
healthy status, denied/wrong identity, access revocation, occupied foreign port,
changed script/hook, failed executable, changed scope and owned shutdown. Authorization
is deliberately an invented test adapter, not live provider evidence. Real discovery,
server locator/transport integration, toolchain policy, Linux/Windows lifecycle
qualification and installed CLI/Launchpad acceptance remain incomplete.

## GitHub repository observation for the authorization adapter

`src/providers/github-repository.ts` performs a fixed read-only GraphQL query through
an explicitly selected GitHub CLI executable and the caller's existing credential
context. Viewer node ID and exact repository facts come from the same response.
The expected viewer ID must come from the selected Principal context, not a profile
or repository name. Wrong viewer/repository, partial GraphQL errors, malformed
fields, warnings, timeout and oversized output never produce positive evidence.
Successful observations carry request start/completion times; they are not cached.

The adapter returns the repository's node ID, canonical name, reported permission
(including null), archived and disabled state. These facts do not grant app execution,
publication or local filesystem custody. The caller must bind them to the existing
Organization/module contract and actual operation, and recheck at the operation
boundary. Missing or inaccessible repository is not proof of nonexistence. No new
roster, IAM, credential store or provider binding model is introduced.

The observation additionally reads repository `databaseId` and the owner's type,
node ID, login and Organization `databaseId`. `compareGitHubBindings` compares these
with the existing verified `organizationForgeBinding` / `repositoryForgeBinding`
wire fields from `lazurio/lazurio.organization.v1.schema.json` at the same clean
legacy commit cited below. No schema source was copied. Both stable decimal IDs
and current locators must agree; unverified bindings, user-owned repositories,
replacement IDs, renamed/transferred locators and missing identities do not match.
Case-only locator differences are accepted. This reads no local manifest and grants
no permission: filesystem custody, manifest integrity and operation policy remain
separate. It neither upgrades unverified records nor rewrites a manifest after rename.

GraphQL `databaseId` values are accepted only as positive safe-integer numbers and
converted exactly to decimal strings. Null means unavailable, not a guessed ID;
unsafe numbers are refused rather than rounded. This cannot qualify every possible
20-digit manifest ID. The inspected API does not offer Repository `fullDatabaseId`;
no unsupported field or lossy numeric fallback is used. A future broader ID transport
must preserve exact values and be separately verified. Node IDs remain separate
from database IDs and are never decoded to fabricate the latter.

Credential values remain inside the selected `gh` process context and are never
returned or logged by this adapter. Supply an explicit data-only environment
snapshot; Bun's accessor-backed `process.env` is deliberately not accepted directly.
Only existing credential/configuration and essential OS location variables are
forwarded. Proxy/debug/host overrides are omitted, prompting and update notifications
disabled, output limited to 64 KiB and execution bounded. Errors are reason-only;
raw stderr and provider payloads are not emitted. The trusted caller still verifies
the executable and credential custody. This is an optional connected-operation
dependency, not a Bun/Node/gh requirement for offline Folder generation.

References: [GitHub CLI API](https://cli.github.com/manual/gh_api) and
[credential/environment behavior](https://cli.github.com/manual/gh_help_environment).
Existing provider behavior was inspected in `lazurio/core/github-provider-lib.mjs`
at legacy commit `afa1c19fab473be6ee38094e5db769b6b0722e51` (clean); no legacy source
was copied or relicensed. The new adapter intentionally exposes a fixed observation,
not arbitrary provider commands.

Native Mac-host evidence: `gh` 2.97.0 and the new source adapter successfully queried
the public Platform repository with the existing configured identity and rejected
an intentionally different expected viewer ID. No identity switch or remote mutation
was performed. Synthetic compiled transport tests cover fixed argv, filtered host/
debug/proxy environment, warnings, oversized output and timeout; parser tests cover
partial/malformed data and identity mismatch. This is not live revocation, private
Organization authorization, app permission, token-custody qualification, or installed
Linux/Windows evidence. The lifecycle's production authorization adapter still needs
the Organization manifest/local-repository binding and operation policy.

The extended query and comparison were also exercised read-only against the public
Platform repository on the Mac host: observed Organization/repository decimal IDs
matched the selected expected values, while a deliberately wrong expected repository
ID failed. This is not a real transfer/recreation or local-manifest custody test.
Synthetic tests cover both ID mismatches, locator changes, unverified bindings,
user-owned repositories and missing/unsafe numeric IDs.

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

The retained guard handle now also provides `observeListener` for one validated
declared endpoint. It checks that startup succeeded, the launcher and guard have
not exited and stop has not been requested. It obtains matching loopback/group
observations before and after the bounded health request, rechecking lifecycle
state after each await. A foreign group, unavailable observation, changed binding
snapshot, launcher exit or concurrent stop cannot produce `observed-healthy`.
The health input parser is shared with the standalone connectivity adapter.

This is a read-only instantaneous observation, not authorization, a bind reservation,
continuous readiness, or atomic evidence of socket ownership during the request.
A replacement followed by restoration between observations cannot be excluded.
All required application listeners still need evaluation by the single lifecycle
owner, along with module identity, dependencies and authority. No imported PGID
can create this handle, and this method never sends a signal or adopts a process.
Mac-host synthetic tests cover a matching group, localhost, foreign group, HTTP 503,
invalid inputs, launcher exit, stopped state and stopping during a health request.
The compiled runner also exercises matching/foreign ownership, localhost path
normalization, launcher exit and stopped state on macOS ARM64 and Linux ARM64;
see the dated evidence below. Concurrent-stop observation and HTTP 503 remain
Mac-host source tests, not Linux qualification. Windows and the UI remain unqualified.

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

### Owned listener observation evidence, 2026-09-13

The extended `scripts/smoke-guarded-process.ts` passed on the Mac ARM64 host and
the existing Ubuntu ARM64 VM with Platform source
`d1a4e3a08c0a8415efb472ef5b90a2fbb20e11b6`. It checks the retained handle's own
healthy listener, refusal of the other fixture's group, localhost with a normalized
health path, launcher-exit refusal and inactive status after confirmed stop, in
addition to the four earlier process scenarios. The compiled runner contains the
observer adapter; the separately compiled actual CLI supplies the process guard.
This does not claim user-facing CLI app commands already exist.

Both ran under `env -i`. The Ubuntu guest had no `bun` or `node` command; transferred
SHA-256 values matched before execution:

- Platform CLI: `fdf9a845138b298a5ea36bf02796f5f8eab5a271e452a7244d9706f0fcddd5a5`.
- Extended runner: `0d8803eac52909feea006017c938e147abd008bd3535706cb61fd39dc154fb00`.

The VM was stopped afterwards. This is a reused fixture VM, not a clean installation,
signed distribution, full readiness/authority proof, Windows qualification or
CLI/Launchpad acceptance. No Organization or Personalspace was mounted or used.

### Local Git checkout observation

`src/providers/git-checkout.ts` is a read-only POSIX development adapter using an
explicit caller-qualified Git executable. It requires a canonical caller-owned,
non-shared-writable checkout root and Git/common directories, observes their
identities again, and reads one locally configured origin without includes. Nested
paths are not accepted as checkout roots. Only exact GitHub HTTPS or SSH coordinates
are returned; credentials, alternate transports and ambiguous origins are refused.
Commands have bounded time/output and do not fetch, check out, clean or modify Git.

Synthetic Mac-host tests cover an ordinary checkout and a linked worktree, preserve
untracked work and Git configuration/pointer files, and reject nested paths and
multiple origins. This is not Linux/Windows qualification. Observations assume a
stable cooperative filesystem, not atomic protection against same-user replacement.
The configured origin is not the effective fetch destination after Git rewrites,
proof of repository contents, provider rights or Organization authorization. Full
Organization document resolution and operation policy remain separate prerequisites;
this adapter does not grant lifecycle access or touch a real installation.

### Organization document acquisition

`src/organizations/read-documents.ts` acquires the existing three root documents:
`lazurio.organization.json`, `company.gen3.json`, and `modules.manifest.json`.
Each result is explicitly missing, invalid, or a recursively frozen decoded object;
an unreadable, linked, oversized, non-object or malformed document is not absence.
The shared owned-JSON reader also rejects duplicate member names at any object
depth, including names that become equal after JSON escape decoding. Syntax is
validated by JSON.parse, then an iterative source scan checks per-object key
uniqueness before the parsed value can escape. Equal keys in separate objects
remain valid. Errors contain no key names or values. This prevents last-member-wins
parsing from discarding declaration content before conversion hashes are computed.
Compiled conversion CLI tests cover duplicate legacy custom/nested members and
inventory members with exact source-byte/directory preservation and no output write.
It never falls back from an invalid canonical document to a legacy projection.
Boundary failure returns unavailable, without raw filesystem errors or file contents
in diagnostics. The shared `providers/owned-json.ts` retains the bounded no-follow
reader already used by application declarations. No recursive directory discovery,
Organization data modification or implicit creation occurs.

Mac-host fixtures exercise all three states, malformed UTF-8, size bounds, symlinks,
hard links, directories and shared-writable files/root, with original contents retained.
These are acquisition tests, not semantic Organization acceptance. Reads assume a
stable cooperative directory and are not one atomic multi-document transaction.
Windows is refused; native Linux qualification remains outstanding.

The existing resolution behavior was inspected in `organization-root-reader-lib.mjs`
and `organization-activation-lib.mjs` at the legacy commit above. That historical
resolution is reference material for a controlled one-time conversion, where legacy-only,
transition, projection drift and conflicts may need inspection. It is not the target
runtime contract: normal application discovery reads canonical documents only and
refuses missing/invalid canonical state rather than adopting legacy state. Conversion
must preserve the owning Organization's work and has separate rollout/retirement gates.
Provider identity, local Git binding and operation rules remain required for connected
application control. Valid JSON or successful local discovery cannot authorize it.
No legacy implementation was copied or relicensed in this step.

### Existing document hash compatibility

`src/organizations/document-hash.ts` implements the existing
`sha256-canonical-json-v1` serialization retained for explicit conversion/projection inspection:
recursive object-key sorting followed by JSON.stringify, with array order retained.
Numeric object keys therefore follow JavaScript JSON ordering, not a newly substituted
canonicalization standard. Tests cover non-ASCII strings, numeric keys, negative zero,
array-order differences, null versus absence and `__proto__` as ordinary JSON data.
Non-JSON/executable inputs, sparse arrays, non-finite numbers and cycles are refused;
accessor and toJSON fixture hooks are not invoked.

A read-only Mac-host comparison against the legacy `organizationSemanticHash` at
the pinned source commit above matched four invented documents (nested/numeric/non-ASCII,
empty, fractional number/array, and `__proto__`). It imported the existing local legacy
function only for comparison; it is not a build/test dependency of Platform and no
legacy implementation was copied. The public tests instead assert explicit expected
serialized bytes and behavior. This is bounded compatibility evidence, not complete
projection/normalization parity. Schema validation, projection construction, conflict
resolution and lifecycle authorization remain incomplete. A matching content hash is
neither a publisher signature nor a grant of access.

### Canonical Organization schema reader

`parseCanonicalOrganization` validates the existing `lazurio.organization.v1`
wire fields and binding invariants, returning a separate frozen data snapshot.
Organization metadata, legacy extensions and optional governance/team/layer/task-source/
Doctor data remain intact. Reserved-field collisions, unknown structural fields,
wrong identity types, mixed binding states, mismatched owners, unsupported governance,
bad projection pointers/digest syntax and invalid port pools are refused.

The existing runtime compatibility check additionally requires a verified root to be
`<owner>/<owner>_GEN3` on `main`; that rule was verified in
`organization-scaffold-lib.mjs#validForgeBinding` at the pinned legacy commit. It is
not generalized to unverified declarations. Unverified absent/null roots remain
representable, without adopting the still-pending owner-local project contract.
Team fields follow the published schema, including optional exact team forge binding;
the older runtime's shape check only verifies that teams is an array. Malformed team
entries accepted by that weaker runtime are intentionally not silently adopted.

Tests cover frozen-copy preservation, unverified optional roots and 44 malformed or
conflicting variants. This parser verifies declaration shape and cross-field rules,
not the correctness of the declared projection hash, agreement with modules inventory,
legacy semantic equivalence, provider facts or operation permission. Those remain
separate steps before a lifecycle consumer can use the Organization. No document is
written, migrated, renamed or used to activate a real installation.

### Repository mount diagnostics

`src/organizations/repository-slots.ts` recognizes the existing exact repository
mount grammar: named root slots, direct workspace/modules/productionspace mounts and
workspace/modules nested `db` mounts. It preserves case, dots and underscores in the
physical basename, with the separate declared/default repository slug inspected for
validity. Paths are never normalized into acceptance. Containers and arbitrary deeper
descendants are not executable repository mounts, even where the broader Organization
document scope classifier recognizes their area.

Collection diagnostics identify implicated declaration indices for duplicate paths,
case collisions, conflicting identities, repeated slugs and missing/exact-case-wrong
nested-database parents. Unsupported entries remain visible as issues; unrelated
siblings are retained. Path scope wins over a contradictory `space` label for this
observation, but that label's semantic validation is still required downstream.
This is neither a second catalog nor authorization, checkout verification or proof
that a nested database is an application. Remote aliases, source-of-truth declarations,
required slots, live rights and the actual module manifest still need evaluation.

Synthetic tests cover 22 accepted/refused path observations and 11 diagnostic cases,
including unchanged inputs and healthy siblings. A read-only comparison of 14 invented
paths matched the legacy canonical-mount, scope and nested-database helpers at the
pinned commit above. No legacy source was copied or introduced as a dependency; the
public tests are independent fixtures. No real Organization files were enumerated.

### Canonical Organization / inventory declaration binding

`prepareOrganizationConversion` provides an explicit pure conversion draft from
legacy GEN3 declarations and the existing module inventory. It preserves custom
metadata and existing declared forge IDs, without querying or verifying GitHub.
Absent IDs remain unverified. It rejects conflicting inventory, case drift,
malformed bindings and any candidate whose complete legacy projection differs
from the original document except for an explicitly reported normalization: a
missing `company.default_branch` may be materialized from an existing exact `main`
declaration in `forge_binding.repository.default_branch`. No branch is guessed;
an existing conflicting value is refused. The input hash still describes the
original source, while the compatibility digest describes the projected output.
Thus other unsupported aliases/defaults require explicit
reconciliation instead of silently losing content. The returned input hashes
identify the inspected data; they are not an authorization token.

This is conversion logic only, not runtime fallback or a writer. Organization
declaration adoption is a separately scoped change under that Organization's
repository ownership and review rules, not an implicit step in Lazurio Folder
migration. The Folder migrator must report missing or conflicting prerequisites
without rewriting protected Organization content. Before applying
a draft, a separately authorized Organization conversion use case must prove canonical
target absence, recheck input bytes and filesystem custody under its operation
lock, preserve edits and support interruption recovery. It must not overwrite an
existing canonical document. No active Organization is migrated by this function.
Synthetic tests cover lossless custom-data preservation, declared/unverified IDs,
binding conflicts, inventory drift, duplicate slots, alias loss and accessor refusal.

The development CLI exposes `organization-conversion-preview --directory <fixture>`
through `inspectOrganizationConversion`. It reads only the explicit owned directory,
refuses any occupied canonical target (including invalid files or links), requires
both legacy declarations and inventory, and repeats directory/document observation
before returning a draft. Changed observations are refused; this is not an atomic
snapshot or protection against same-user replacement. Exit 0 means a draft, not an
applied conversion; exit 2 reports a reason-only block. Draft JSON may contain private
Organization metadata and must remain within the owning scope. It performs no write,
lock creation, provider query or app execution. Compiled CLI fixture tests verify
unchanged source bytes and directory contents, plus refusal of occupied targets.
Projection conflicts additionally identify fixed section labels such as `modules`
or `company`, never arbitrary metadata keys or values. A section diagnostic does
not choose which declaration wins, reorder entries or authorize reconciliation.

`scripts/smoke-organization-conversion.ts` is a standalone native qualification
runner. Compile it and `src/cli.ts` for the target with compile-time dotenv/bunfig
autoloading disabled; pass the CLI's absolute path to the compiled runner. It
creates and removes only its own temporary synthetic fixture, checks a successful
draft and an exact conflict result from the real CLI, and verifies unchanged input
bytes and absence of a canonical output. It is not a publisher-signature verifier,
installer test, full migration test or Launchpad qualification.

On 2026-09-14, the initial runner executed successfully in the existing Ubuntu ARM64
development VM against CLI source `cdfb444ecd833b99e6547f9f1cdf121da96b300c`.
The CLI SHA-256 was `3e6b0e4bbb6ec387301fc277ad22867959da751c2475e0454a772445bed7938f`;
the pre-publication runner SHA-256 was
`90159bf5a08a5ce76d4f5d4c39e44cc1286c1e2df4e0519e0aaa3f36c2c5c71f`.
Transferred hashes matched the host artifacts, the command exited zero, and the VM
was stopped afterward. Both executables carried the Bun 1.4.2 runtime. This was a
prepared development VM, not evidence of installation on a pristine system. Rebuild
and record new artifact hashes when rerunning the checked-in formatted runner.
The checked-in runner also resolves its owned temporary directory to a canonical
path before calling the CLI: the initial Mac-host run correctly hit CLI refusal
on the system's aliased temporary path. After that runner correction, the compiled
smoke passed on the macOS ARM64 development host. This does not change or relax
the product's symlink/custody checks; the corrected runner has not yet been rerun
in the Linux guest.

`inspectCanonicalInventory` composes canonical schema validation with the existing
modules-manifest header contract and mount diagnostics. A missing schema/generation
remains the legacy header form; explicit versions are limited to
`companiesascode.modules.v1` or `modules.manifest.v3`, with `gen3` when generation is
present. Unknown/null versions are not absence. Company slug and GitHub owner must
match the canonical Organization case-insensitively; exact-case differences remain
visible warnings instead of rewritten identity strings.

The result keeps frozen copies of both declarations, including Organization-owned
inventory metadata, and indexed slot diagnostics without discarding healthy siblings.
The data snapshot implementation is shared with canonical validation and content
hashing, avoiding execution hooks or mutation of caller input. Tests exercise all
three header forms, mismatched identities, malformed headers/slots, preserved custom
data, case warnings and conflicting slots alongside an unaffected sibling.

This observes declaration agreement only. An all-zero but syntactically valid declared
projection digest can still reach this result: projection-content validation and
legacy-document reconciliation are not implemented by this function. Slot diagnostics
must still be handled, and neither this result nor a case warning authorizes a launch,
Git action or manifest repair. No second inventory store or filesystem scan is added.

### Expected legacy projection and declared digest verification

`expectedLegacyProjection` now derives the expected `company.gen3.json` data from
canonical Organization and module declarations and compares its calculated digest
with the declared digest. It preserves custom metadata/extensions, emits the existing
verified forge binding where applicable, excludes root-scoped slots, maps legacy
remote/branch/access fields and sorts projected slots by path. Nested workspace/module
database slots do not acquire a guessed slug. Nullish aliases follow existing fallback
behavior; they are not interpreted as executable/provider authority.

Document scope is deliberately separate from executable mount grammar. Existing
containers and root descendants can participate in compatibility projection without
becoming launchable repositories. Unnormalized, escaping or control-character paths
are refused, not rewritten. The first test run exposed a trailing-slash mismatch;
the scope check now refuses it as the existing normalizer does. No file is written.

Read-only comparison against the pinned legacy projection functions matched content
hashes for five invented canonical variants: missing/null/unverified/verified root
bindings and optional data, with mixed root/workspace/database/production slots.
Public tests independently verify field mappings, hash mismatch/match, sorting,
preservation, optional roots, nullish fallback and invalid inputs. The legacy function
is not imported by the product or its committed tests. No implementation was copied.

A matching expected digest is necessary but not sufficient for Organization resolution:
the actual legacy document still needs normalization and semantic comparison to
distinguish transition, projection drift and conflict. Existing slot diagnostics,
provider rights and lifecycle policy remain separate; this function repairs nothing
and grants no permission even when `declaredHashMatches` is true.
