# Build and qualification lifecycle

How an installed Lazurio checks for, verifies, activates and rolls back a product
version is the [product update contract](update.md) with decision
[F13](decisions.md#f13--release-trust-is-github-artifact-attestation). This document
binds what that contract does not repeat: the build and qualification lifecycle, the
two test modes and the install location. The earlier pilot installer, its TUF
metadata, signing keys, channels and repair procedures were removed together with
their code.

Status: the two test paths and deliberate whole-Machine candidate activation are
accepted outcomes, not a mandate to switch the current host.

Use one product version for CLI, server/Launchpad runtime and generator. Their
compatibility is tested as one delivered product. Profile/preferences schemas retain
their separate contract versions; they are not independently drifting binaries.

```text
reviewed PR + CI → main → tag → release workflow builds and attests every target
                      → release candidate (prerelease, reached only by exact tag)
                      → native acceptance → final release (latest)
```

A merge does not roll out software. Candidate acceptance includes install, product
upgrade, profile preservation and recovery on each supported native platform. A
release candidate is a GitHub prerelease: it is invisible to `latest` and reaches only
the Machines that ask for that exact tag. A final release requires an explicit
authorized decision — the protected tag and the required reviewer of the `release`
environment. Releases are immutable; a final version is a new tag built from the
qualified source, never a renamed candidate.

Artifact identity is immutable (`version + target + digest + source provenance`) and
is embedded in the executable and stated by the attested `manifest.json`. An explicit
rollback selects the retained previous version and is distinguishable from normal
progression; no network path goes below the version floor.

Update behavior detects availability and explains compatibility; activation remains
explicit. Detection is not a download/execute mandate. Offline, a failed
verification, an unsupported target or unknown state preserves the current
installation and reports a precise reason.

Product update, profile activation and Source→Managed migration are distinct
operations. Rollback is permitted only with the compatibility and preservation
evidence in [migration and recovery](migration-and-recovery.md). Program rollback
cannot reverse data/schema changes.

Native distribution signatures stay separate from build provenance:
[Apple Developer ID and notarization](https://developer.apple.com/developer-id/)
are the macOS route to qualify, and a Windows public-trust signing provider requires
eligibility and identity validation. The Principal permits a controlled internal
pilot before them; public release still requires them and tests of the final signed
bytes. No OS protections are disabled.

## Build

Development packaging is executable with the pinned Bun from a clean committed
repository root:

```sh
bun run scripts/build-candidate.ts /absolute/absent/output-directory
bun run scripts/smoke-candidate.ts /absolute/absent/output-directory/lazurio
```

The parent output directory must already exist and be canonical; the output itself
must be absent. The build installs frozen development dependencies without lifecycle
scripts, runs the narrow publication guard, compiles the real CLI with its embedded
identity and emits `identity.json`. It refuses a dirty source or an existing output;
partial failed output is retained, not cleaned automatically. The identity describes
unattested bytes, not a release or a reproducibility proof.

The POSIX smoke accepts an existing executable, requires its embedded identity to
equal `identity.json`, creates its own temporary Folder, initializes Czech
instructions, changes to English, starts that executable's Launchpad, checks embedded
HTML, API denial and authenticated profile state, then stops it. The child's PATH
excludes development runtimes. This is not a clean-OS install, browser interaction,
full module journey or Windows acceptance. It never rebuilds the supplied candidate.

- Build the real `src/cli.ts` entrypoint, including its Launchpad assets and Folder
  Factory. `proof/main.ts` remains a separate demonstration and is not a release input.
  Pin Bun from `packageManager`; disable compiled ambient dotenv/bunfig loading.
  The distribution does not bundle every module's Bun or database dependency.
- One standalone executable per qualified native target. A release executable is
  built by `.github/workflows/release.yml` on a runner of its own target
  (`scripts/release-build.ts`) and is asked for its identity before it is uploaded.
  A local build must use an explicit new output directory and never replace an
  installation.
- No source checkout, user Bun/Node/npm, sudo, provider credential or access to a
  private integration repository is required merely to launch the installed CLI and
  Launchpad.

## Install location

Install per user outside the Folder: macOS `~/Library/Application Support/Lazurio`,
Linux `${XDG_DATA_HOME:-~/.local/share}/lazurio`. Resolve and validate actual absolute
paths; this notation is not shell code to execute. Versioned product directories are
immutable after verification. One stable entrypoint, `bin/lazurio`, selects the active
version; the layout under the base is the *State on disk* table of the
[product update contract](update.md). Windows (`%LOCALAPPDATA%/Lazurio`), its
entrypoint replacement and running-handle behavior must be designed and qualified
natively, not assumed from POSIX; it is not supported yet.

Qualification starts on the available native macOS ARM64 and Linux ARM64 fixtures.
Other target names in an identity schema do not establish support. Windows and the
remaining launch matrix remain required work, not silently dropped deliverables.
The full first installed consumer must use the real CLI/Launchpad module lifecycle,
not just `--help`.

## Two independent test modes

```mermaid
flowchart LR
  S[Platform changes] --> B[Same local and CI artifact build]
  B --> W[Three isolated worktree tests]
  W --> I[Selected changes integrated and rebuilt]
  I --> Q[Integrated candidate qualification without checkout]
  Q --> A[Explicit whole-Machine activation in real Lazurio Environment]
  A --> O[Observed CLI and Launchpad use plus recovery evidence]
  O --> P[Final release tagged from the qualified source]
```

**Worktree isolation:** three agents may run concurrently, each from its own Platform
worktree and exact artifact. Each gets an owned temporary Lazurio Folder and test Organization,
process-local PATH entry, server/allocated ports, state locator and evidence directory.
The test harness passes explicit paths; it must not fall back to the daily Lazurio Environment,
ambient credentials, normal user state or another test's server. Isolating a directory
alone is insufficient: redirect all product-owned OS state paths and inherit only
reviewed environment values. Fixtures contain no real Organization/Personalspace data.
Native acceptance uses a copied artifact with the checkout unavailable; rapid source
unit tests are allowed earlier. Cleanup verifies fixture/process ownership, preserves
private failure evidence and removes only that run's own resources.

**Integrated personal acceptance:** selected worktree changes are integrated at one
reviewed source ref and built through the same packaging path as CI. Run the combined
candidate tests before activation; no worktree build independently replaces daily
Lazurio. The Principal deliberately activates that exact candidate for the whole
single-Principal Machine: ordinary CLI launches and Launchpad use it with the selected
real Lazurio Environment and real Organizations. This is stronger than a temporary shell PATH override.
If the current Lazurio Folder needs migration, the migration rehearsal and separately authorized
apply must finish first. Design agreement here is not an instruction to act on a host.


Native qualification of the update mechanism itself — install with the systemd user
service, A → B, a failed B with automatic switch-back, a crash-looping B after a
simulated power loss, explicit rollback and a real reboot — is
`scripts/qualify-update-linux.ts`; it uses a loopback fixture origin and a fixture
Sigstore trust root that a release build never contains.

## Required lifecycle evidence

For the current foundation proof, `bun run scripts/identify-proof.ts` rebuilds
the native proof from a clean committed checkout and emits its byte digest,
size, source commit, lockfile digest and pinned toolchain. This is an unsigned
build identity, not publisher authentication, a release manifest or a native
installation qualification. Run from the repository root using the pinned Bun.
The output must not be used as authorization to install or activate a product.

Run three simultaneous fixtures and prove distinct PATH resolution, Lazurio Folder, state and
processes; deliberately collide a port and terminate one run without harming its peers
or daily installation. Separately prove integrated Machine activation with cold CLI
and Launchpad starts, a busy writer, old session, build failure, interrupted switch,
health failure, incompatible downgrade and new data writes. Record exact native OS,
artifact and harness versions. Personal acceptance is not a substitute for the other
OS cells. Failure logs stay private until separately sanitized for public evidence.
