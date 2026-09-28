# Product update

Status: **accepted direction of the Principal (2026-09-19, simplified the same
day), implementation in progress.** This document is the single contract for how
an installed Lazurio learns about, obtains and activates a new product version.
It replaces the earlier TUF-based contract and the pilot installer documents
(decision [F13](decisions.md#f13--release-trust-is-github-artifact-attestation)).

**Change of 2026-09-28: no program rollback.** The Principal decided that rollback
is not the safety net ("No back doors for rollback!"); the recovery-mode shaping
proposes it as decision F21, which is not yet recorded in
[decisions](decisions.md). This contract describes the implementation: there is no
`lazurio update rollback`, no retained previous version and no switch-back. A
candidate proves itself before the switch, the switch is final, and a Launchpad
that cannot start normally serves Recovery mode instead of exiting. The update
**to** the first release without rollback is still performed by the old updater
(see *Migration from releases with rollback*).
Nothing is deployed to real clients on this codebase yet, so it is written
without a compatibility burden. After the first client deployment every change
to it must be compatible.

## What the Principal asked for

1. Update is a **conscious step**. Lazurio never activates a new version behind
   the user's back.
2. Availability is shown **continuously**: a Machine that can reach GitHub shows
   the newest release it has verified, and shows how old that knowledge is. It
   cannot show a release that the network withholds from it (see *Knowingly not
   covered*); that case is visible as an ageing last check, not as a version.
3. When the user clicks, the update **dependably happens**: every failure before
   the switch is bounded, leaves the installed product as it was, and the same
   click works again once the outside condition is restored. A crash at any point
   leaves the old or the new version active, never neither. After the switch the
   only direction is forward: a new version whose Launchpad does not come up
   healthy is reported as `activation-unhealthy`, stays active, and is repaired by
   a newer release or by fixing the condition its Recovery mode names. Update state
   damaged from outside the product (`state-invalid`) needs a person.
4. **Proven practice instead of our own machinery.** Where a maintained standard
   exists (GitHub Releases, Sigstore attestations, systemd, `flock`, an atomic
   symlink) the product uses it and adds nothing beside it.

The model for the user experience and the release flow is T3 Code's updater: a
small explicit state machine, a poller in the long-running app, a pill in the
UI, failures that fall back to `available` with a retry, and a tag-driven CI
release that publishes every platform at once.

## Invariants

- **One core, one command.** CLI and Launchpad run the same `lazurio update`.
  There is no second updater, no worker entrypoint and no installer logic
  outside the product.
- **The operator owns the version.** The operator of the Environment runs
  `lazurio update`, on a hosted Machine as on their own computer. A provider's pin
  is a minimum: a rollout installs a missing or broken installation and may raise
  one below the pin through the offline update, and never lowers a version
  ([F17 addendum 2026-09-28](decisions.md#f17--operator-tools-belong-to-the-operator-the-rollout-pins-the-baseline-and-repairs)).
- **Explicit activation.** Checking and showing availability are automatic;
  download and activation start only from `lazurio update` or the Launchpad
  action.
- **No wedge.** Every failure before the switch leaves the installed product as
  it was and the next attempt possible. Downloads are scratch files; there is no
  pending download, no journal and no activation marker.
- **No way back.** The product never returns to an earlier version or state
  after the new one became observable. What stays is atomicity and refusal:
  nothing is left half-written, a candidate proves itself before the selector
  names it, and the switch of `bin/lazurio` is one rename and the commit.
- **Versions only move forward.** The floor is the higher of the active version
  and the durable high-water mark, which records the highest version ever
  activated. No path, `latest`, an exact tag or the offline update, installs a
  version below the floor.
- **Data is repaired forward.** A version never rewrites Folder state into a form
  its predecessor cannot read before it is active; a Folder a newer template
  revision rendered is refused by an older one, never re-rendered older.
- **Running work is never killed to finish an update.** Applications belong to
  the OS service manager ([F8](decisions.md)); only the Launchpad restarts.
- **Self-hosted works alone.** No Human and Machine service takes part in
  checking, downloading, verifying or activating.

## Release and trust

The origin is the public GitHub repository `Lazurio/LazurioPlatform`, compiled
into the binary together with its numeric repository and owner IDs. There are no
Lazurio signing keys, no metadata service and no second origin.

**Publishing.** A protected tag `vX.Y.Z` starts `.github/workflows/release.yml`.
It builds `lazurio-<target>` for every supported target, writes `manifest.json`,
creates one Sigstore bundle with `actions/attest` whose subjects are the manifest,
every binary and `install.sh` of the tag, attaches everything to a draft release and
publishes it once. `install.sh` is not in the manifest, whose targets are executables;
a client requires its digests to be among the subjects, so an added subject changes
nothing for it.
Releases are immutable (GitHub immutable releases). Publishing is serialized: the
publishing job runs in one repository-wide concurrency group that queues and
never cancels, in the protected environment `release` with a required reviewer.
Inside that group, immediately before publishing, it lists the published final
releases and refuses a final version that is not greater than every one of them;
the draft is then deleted and nothing is published. Only after that check does it
publish, with `latest` set explicitly for a final version and never for a
prerelease. Two tags pushed together therefore publish one after the other, and
the lower one fails closed. Every action is pinned by commit. The file name
`release.yml` is permanent: it is the trust entry point of every installed
client.

```json
{
  "schema": 1,
  "version": "1.4.0",
  "source_commit": "<40 hex>",
  "minimum_updater_version": "1.0.0",
  "notes_url": "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0",
  "targets": { "linux-x64": { "file": "lazurio-linux-x64", "sha256": "<hex>", "size": 0 } }
}
```

`minimum_updater_version` is the oldest installed version able to perform this
update. An older client reports `reinstall-required` and changes nothing. The
value is a constant of the publishing script (`scripts/release-manifest.ts`): the
first release whose updater exists, raised only with an incompatible change of
the update protocol. Ordering is the product order, where a prerelease is below
its final version, so a minimum of `X.Y.Z` would refuse every `X.Y.Z-rc.N`
client.

**Check.** The client requests
`https://github.com/<origin>/releases/latest/download/manifest.json`, records the
tag the redirect resolved to, and from then on uses only exact-tag URLs
(`releases/download/<tag>/…`) for the bundle and the artifact. The tag is taken from that first redirect only, which must name
exactly this asset of a `v<version>` tag on the compiled-in origin; anything else is
refused before another request is made. Exact-tag URLs are then followed over HTTPS
wherever GitHub stores the bytes: there is no host allow-list, because the bytes are
authenticated by the attestation and not by where they came from. A manifest whose
version differs from the resolved tag is refused. An update is available when
the verified manifest version is greater than the active version and not lower
than the floor.

**Verify.** With the `sigstore` library (the verifier npm itself uses), against
Sigstore's public trust root, refreshed through Sigstore's own client into a
cache under the install base. All of the following must hold:

- issuer is exactly `https://token.actions.githubusercontent.com`;
- certificate identity matches the anchored, escaped pattern
  `^https://github\.com/<origin>/\.github/workflows/release\.yml@refs/tags/v<version>$`,
  which binds the bytes to the tag;
- the certificate's repository ID and owner ID equal the compiled-in IDs, and its
  source ref and commit equal the tag and the manifest's `source_commit`;
- the attested subjects contain the SHA-256 of the manifest and of the
  downloaded artifact; size and digest of the artifact match the manifest.

A cold trust cache during a Sigstore outage blocks the update; it never weakens
verification.

**Exact version.** `lazurio update --version vX.Y.Z-rc.N` installs one exact tag.
The tag is normalized to a version, the manifest must carry exactly that version,
verification is the same, and the same floor applies: a version below the floor
is refused; a version equal to the high-water mark but not active is allowed,
because an installation rolled back by a release before the change of 2026-09-28
sits below its mark and must be able to return to it. Nothing goes below the
floor. GitHub prereleases are invisible to `latest`, so a release
candidate reaches only the Machines that ask for it. This is the whole canary
mechanism; there are no channels. A Machine that activated a release candidate
follows that line: it takes the next version at or above it, and returning to an
older line is a new installation.

**The command on PATH.** `lazurio install`, first installation and offline update
alike, links the standard entry `~/.local/bin/lazurio` (root decision 0161 point 6)
to the selector `<base>/bin/lazurio` by one atomic rename, and creates
`~/.local/bin` (`0755`) when it is missing. An entry already pointing to the selector
is left alone; a link to the selector of a Lazurio install base (another base, or one that is gone) is replaced; a dangling link of any other shape is someone else's and stays; when `~/.local` or `~/.local/bin` is itself a link or not a directory, nothing is written through it (`conflict`, `parent`); a regular file, a directory or a link to anything else is never
overwritten. The result's `entry` says which (`created`, `present`, `replaced`,
`conflict`, `failed`), whether `~/.local/bin` is on the process PATH, which other
`lazurio` resolves first on it (`shadowedBy`, changed in no way) and, in `next`, what
the operator or an agent should do. `path`, the directory to put on PATH, is
`~/.local/bin` when the link exists and `<base>/bin` otherwise. The installation
never fails because of its entry, and shell profiles are never edited.

**First installation** is the one step the installed product cannot authenticate
for itself; what it proves is spelled out in [First installation](#first-installation).
OS publisher signing stays a gate before public release ([decisions](decisions.md)).

**Knowingly not covered.** An attacker who controls both the network and a valid
TLS certificate for `github.com` can hold a client on its current version; they
cannot downgrade it or make it run foreign bytes. The last verified check time in
`update status` is how that freeze becomes visible. The trust base is named in
full: the governance of this repository is the authorization policy (whoever can
run the protected release workflow on a protected tag can publish); GitHub
Actions OIDC, which asserts the workflow identity, and Sigstore's certificate
authority, transparency log and trust root, which the verifier relies on, are
cryptographic dependencies outside Lazurio's control. A private fork is a different product configuration with its
own compiled-in origin and IDs, not a runtime setting.

## First installation

Decision [F20](decisions.md#f20--one-command-first-installation-the-downloaded-executable-verifies-its-own-release).
On a new computer Lazurio is installed by one command, and from then on it updates
itself with `lazurio update`:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install | sh
```

Until the website route is deployed, and until a release carries `install.sh` as an
asset, the script is served from this repository:
`https://raw.githubusercontent.com/Lazurio/LazurioPlatform/main/install.sh`.
Arguments after `sh -s --` go to `lazurio install` (on Linux, `--service systemd-user
--folder <absolute Folder>` installs the supervised Launchpad); `LAZURIO_VERSION=vX.Y.Z`
installs one exact tag, which must be a release that already carries this mechanism
(an older executable does not know `--verify-release` and refuses the call). Linux
x64 and arm64 and macOS on Apple silicon are supported; Windows and Intel Macs are
not yet, and the script says so in one sentence. It needs only `curl` and
`sha256sum` or `shasum`, runs as the user who will use Lazurio (root is refused),
never uses `sudo` and never edits a shell profile. The script installs the latest
release, so it works from the first release built with `--verify-release` on; until
that release is published an older executable refuses the call and nothing is
installed.

**curl only, deliberately.** Every download of the script follows GitHub's redirects
into its asset storage, and every hop must stay HTTPS: `curl --proto '=https'
--proto-redir '=https'` refuses a downgrade (`curl: (1) Protocol "http" disabled (in
redirect)`), the download fails and nothing is executed. That matters because the
script compares the executable with a manifest that arrives the same way: a plaintext
hop could supply a forged manifest and a matching executable, which the comparison
would pass, and the executable's own check runs only after it has started. `wget`
cannot be held to that portably: GNU wget 1.x has no option that restricts the scheme
of a redirect (`--https-only` applies only to recursive retrieval), wget2 and BusyBox
wget differ again in options and in how they print response headers, and BusyBox
wget has no `--max-redirect` at all. Following redirects by hand
(`--max-redirect=0`, reading `Location`) would have to be right for all three
families without a way to prove it here, so there is no `wget` fallback: a smaller
script that is certainly safe beats a wider one that is probably safe. The cost,
plainly: macOS ships curl, and so do most Linux desktops, but some ship only wget
(some Ubuntu Desktop releases, for example); there the script names the package to install
(`sudo apt install curl`, `sudo dnf install curl`) and stops before any request. The
one command itself is a `curl` command, so such a computer needs curl first anyway.

**Two ways in, kept apart in code and here.**

- **Downloaded** (a person's computer): `install.sh` runs
  `<executable> install --verify-release <directory>`. Before anything is written, the
  executable holds itself against the release it says it is, through
  `verifyReleaseDocuments`, the same function `lazurio update` runs on a release it
  fetched: the manifest must carry the executable's own version and source commit,
  its target entry must have the size and SHA-256 of the running file, and the bundle
  must be the release workflow's attestation at that tag with the manifest and that
  digest among its subjects. Any refusal happens before the first write and leaves
  nothing behind; the staged copy is then held against the digest that was verified.
- **Staged** (the Machines role, [offline update](#offline-update)): `<staged>/lazurio
  install --base <base>` from a custody-staged, digest-pinned file. No release files,
  no network, no verification by the executable: the custody that pinned the bytes is
  the authority. This path is unchanged.

**What `install.sh` does, in order.** Resolve the platform; resolve the tag from
GitHub's first redirect of `latest`, which is not followed and must be the exact-tag
HTTPS URL of this repository (an `http://` answer is refused before another request);
download the manifest, the executable and
`lazurio.sigstore.json` by exact tag into a private temporary directory (`0700`);
hold the executable against the manifest's SHA-256 **before it is executed**; when a
signed-in `gh` is present, run `gh attestation verify` on the manifest and the
executable, also before anything is executed; then run the executable as above. The
temporary directory is removed whatever happens.

**The trust chain, honestly.**

| Step | Protects against | Does not protect against |
| --- | --- | --- |
| HTTPS to `lazurio.ai` for the route | a network attacker without a valid `lazurio.ai` certificate | whoever controls `lazurio.ai` or its hosting: they choose the script |
| HTTPS to `github.com` for the script (behind the redirect) and the release files | a network attacker without a valid GitHub certificate | GitHub itself; whoever can publish a release (the repository governance of [F13](decisions.md#f13--release-trust-is-github-artifact-attestation)) |
| SHA-256 of the executable against the manifest, checked by the script before execution | a corrupted or truncated download, the executable of another target or release | a manifest and executable swapped together: they come from the same place |
| The attestation, checked by the downloaded executable | a release not built by `release.yml` at its tag (an asset uploaded by hand, a manifest, bundle and executable that do not belong together, a stale or wrong mirror), as long as the executable is genuine | a malicious executable: it can skip the check and print "Verified" |
| `gh attestation verify`, when a signed-in `gh` is present | everything the attestation proves, by a verifier that did not arrive with the download | nothing beyond what the attestation itself proves |

A check performed by the downloaded executable protects against a swapped download
only to the extent that the script and the executable come from different places or
the script pins what it expects. Behind a redirect both come from the same GitHub
release, and the script pins nothing that release does not already say, so the first
installation stays trust on first use through HTTPS, with the attestation checked
independently wherever a verifier exists that did not come in the download. What the
executable's own check adds is that an honest executable never installs itself out of
a release that is not what the release workflow published, and that the first
installation takes the same verification path as every update. After it, every
update is authenticated by the installed product before a byte of the new version
runs.

**Trust root: offline and online.** Checking a bundle is offline: certificate chain to
Sigstore's Fulcio root, signed certificate timestamp, transparency-log inclusion,
DSSE signature and the identity policy are all verified from the bundle against
Sigstore's trusted root. That trusted root itself comes online, from Sigstore's TUF
repository (`tuf-repo-cdn.sigstore.dev`), bootstrapped from the TUF root compiled into
the executable (`@sigstore/tuf`). A first installation has no cache, so it needs that
network: without it the result is `trust-unavailable` and nothing is installed. The
cache it uses is fresh, inside the private download directory, and removed with it;
no cache found lying around is ever taken as the starting root. `lazurio update`
keeps its own cache under the install base (`sigstore/`). The staged way in needs
none of this.

**What a person reads.** Success, on a new Linux laptop:

```text
Installing Lazurio v1.4.0 for linux-x64.
Checked: lazurio-linux-x64 matches the SHA-256 in the manifest of v1.4.0.
The GitHub CLI (gh) is not installed, so there is no independent second check; lazurio verifies the release attestation itself next.
Verified: this executable is lazurio 1.4.0 for linux-x64, built and attested by the release workflow of Lazurio/LazurioPlatform at v1.4.0.
Lazurio 1.4.0 is installed.
The command is /home/ana/.local/bin/lazurio.
/home/ana/.local/bin is on your PATH.
Next, create your Lazurio Folder and start the Launchpad:
  lazurio folder-init --folder /home/ana/Lazurio --access local --purpose human --locale en --detail concise --coordination direct
  lazurio launchpad --folder /home/ana/Lazurio
The Folder's language and style are your choice: --locale cs, --detail technical and --coordination coordinator are the alternatives.
```

With a signed-in `gh` the third line is `Checked by the GitHub CLI: attested by the
release workflow of Lazurio/LazurioPlatform at v1.4.0.`; with a `gh` that is not
signed in it says so and continues. The first step depends on `~/Lazurio`: absent,
`folder-init` and the Launchpad as above; an initialized Folder, only the Launchpad;
anything else there is left alone and `folder-init` is offered for a path that does
not exist yet. With `--service` the service runs the Launchpad and no first step is
printed. When `~/.local/bin` is not on PATH, or another `lazurio` comes first, the
commands name this installation by its full path, the result says `Put
~/.local/bin on your PATH` or names the other program, and the pointer to the agent
prompt below follows.

Refusals, on stderr, exit 1, each saying what happened to the computer:

| Situation | Message |
| --- | --- |
| Unsupported platform | `install.sh: Lazurio supports Linux on x64 and arm64, and macOS on Apple silicon (arm64). This computer is <uname -s> <uname -m>. Windows and Intel Macs are not supported yet; nothing was installed.` |
| Run as root | `install.sh: Lazurio installs for one user and never needs sudo. Run this again as the user who will use Lazurio, without sudo.` |
| No curl (also when only `wget` is present) | `install.sh: Lazurio needs curl to download itself over HTTPS, and curl is not installed. Install it with your system's package manager (for example: sudo apt install curl on Ubuntu or Debian, sudo dnf install curl on Fedora), then run this again.` |
| A redirect leaves HTTPS | curl's own line (`curl: (1) Protocol "http" disabled (in redirect)`), then `install.sh: could not download <asset> of <tag> from GitHub; nothing was installed.` |
| No digest tool | `install.sh: Lazurio needs sha256sum or shasum to check the download, and neither is installed. Install one of them and run this again.` |
| GitHub unreachable | `install.sh: cannot reach https://github.com/Lazurio/LazurioPlatform; nothing was installed.` |
| `latest` redirects elsewhere | `install.sh: the latest release did not redirect to a release of Lazurio/LazurioPlatform; nothing was installed.` |
| No usable tag | `install.sh: could not find out which release is the latest one; nothing was installed.` |
| A file missing | `install.sh: could not download <asset> of <tag> from GitHub; nothing was installed.` |
| Manifest of another version | `install.sh: the manifest of <tag> names another version; nothing was installed.` |
| No executable for the platform | `install.sh: release <tag> has no executable for <target>; nothing was installed.` |
| Digest mismatch | `install.sh: the downloaded lazurio-<target> does not match the SHA-256 in the manifest of <tag>, so it was not run; nothing was installed.` |
| `gh` refuses | `install.sh: gh attestation verify refused <asset> of <tag>, so nothing was run; nothing was installed.` |
| The executable refuses | its own lines, then `install.sh: lazurio did not install itself; the reason is above.` |

The executable's own refusals of the downloaded way in keep the stable code first,
then say it in words:

- `Installation failed: attestation-invalid` — `The release attestation does not
  vouch for this executable: it is not what the release workflow of
  Lazurio/LazurioPlatform built for this version. Nothing was installed.`
- `Installation failed: trust-unavailable` — `Sigstore's trust root could not be
  reached, so the release attestation could not be checked. Nothing was installed.
  Try again when this computer can reach tuf-repo-cdn.sigstore.dev.`
- `Installation failed: release-invalid` — `The release files do not describe this
  executable (<manifest|bundle|artifact>: <reason>). Nothing was installed.`

**One standard installation.** Lazurio is installed exactly the standard way on every
Environment: the install base, its selector `<base>/bin/lazurio`, the link
`~/.local/bin/lazurio` to it, and `~/.local/bin` on PATH with no other `lazurio` before
it. A deviation is reported, never silently overwritten and never kept as a supported
variant. `lazurio install` reports what it found (*The command on PATH* above) and,
when the installation deviates, prints the command that produces the prepared agent
prompt: `lazurio install prompt [--locale cs|en] [--json]`. It reads the installation
without writing and names the standard layout on this platform, what was found
instead (`not-installed`, `entry-missing`, `entry-stale`, `entry-foreign`,
`entry-parent`, `entry-unreadable`, `directory-not-on-path`, `shadowed`), what the
agent may do by itself (read the state, run `lazurio install`, which is convergent,
install with the official installer), what only on the operator's explicit
instruction (move aside something that is not Lazurio's at the entry, edit a shell
profile, remove the legacy root CLI link or another shadowing `lazurio`), and how
success is proven (`command -v lazurio` names the entry, `lazurio --version`,
`lazurio update status`, and `install prompt --json` reporting `"standard": true`).
Deviations are relative to the PATH of the process that asks, so an agent asks from a
new login shell of the operator.

### Serving `https://lazurio.ai/install`

The website lives in another repository; this is its contract.

- **Redirect, recommended.** `GET` and `HEAD` of `https://lazurio.ai/install` answer
  `302 Found` (or `307`) with `Location:
  https://github.com/Lazurio/LazurioPlatform/releases/latest/download/install.sh`
  and `Cache-Control: no-store` on the redirect itself. `curl -fsSL` follows it; the
  website holds no copy that can drift, and every new release is served the moment it
  is published.
- **Proxy, only if a redirect is impossible.** The response body is byte-identical to
  the `install.sh` asset of the current latest release: no templating, minification,
  line-ending change, injected analytics or query variants; `Content-Type:
  text/x-shellscript; charset=utf-8` (or `text/plain; charset=utf-8`); no
  `Content-Encoding` unless the client asked for one; `Cache-Control: public,
  max-age=300` at most, so a new release takes over within minutes. Checkable at any
  time: the SHA-256 of `curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install` equals that of the
  release asset, and `gh attestation verify install.sh --bundle lazurio.sigstore.json
  --repo Lazurio/LazurioPlatform` accepts it, because `install.sh` is an attested
  subject.
- **HTTPS only.** Plain `http://lazurio.ai/install` redirects to the HTTPS route and
  serves nothing else.
- **Order.** `releases/latest/download/install.sh` exists only from the first release
  built by a workflow that attaches it; the route goes live after that release.
  `release.yml` attaches `install.sh` of the tag and makes it an attested subject;
  releases up to v0.1.7 were built before that and carry no such asset.

## State on disk

Everything lives under the per-user install base
(`${XDG_DATA_HOME:-~/.local/share}/lazurio` on Linux,
`~/Library/Application Support/Lazurio` on macOS). Unknown entries are tolerated.

| Path | Meaning |
| --- | --- |
| `versions/<version>/lazurio` | immutable installed versions; only the active one is kept, the rest are pruned after an activation |
| `bin/lazurio` → `../versions/<v>/lazurio` | the only selector of the active version |
| `update/lock` | one kernel `flock` for every mutating update operation |
| `update/high-water` | highest version ever activated; only ever raised |
| `update/launchpad.sock` | the supervised Launchpad's health socket |
| `update/last-check.json` | cache of the last check for the pill and the CLI notice; disposable |
| `sigstore/` | Sigstore's trust-root cache; disposable |

Releases up to `v0.1.x` also wrote `previous` and `update/pending.json`; the
migration removes them (*Migration from releases with rollback*). A running
Launchpad of a pruned version keeps its unlinked executable (POSIX).

`high-water` is written as a temporary file made durable,
renamed over the target, with the directory made durable. A crash leaves the old
or the new content, never a partial one. Status is computed from these paths when asked; there is no observed-state file
and no configuration file. A supervised installation is one whose systemd user
unit `lazurio-launchpad.service` was written by `lazurio install` (its first line
is the installer's marker); the Folder path lives in that unit. A unit of that
name written by anyone else — a Machines resident runtime, a person — makes the
installation unsupervised: nothing is restarted and that unit is never
rewritten. The unit is this installation's only with the marker AND this base's
exact `ExecStart=` line; a marked unit of another install base is that
installation's, so this one is unsupervised and `install --service` refuses it as
`foreign-unit` before anything changes.

The unit `lazurio install --service systemd-user` writes:

```ini
# Written by `lazurio install`; rewritten by it, so edit a drop-in instead.
[Unit]
Description=Lazurio Launchpad
StartLimitIntervalSec=0

[Service]
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=<base>/bin/lazurio launchpad --base <base> --folder <Folder>
Restart=always
RestartSec=5

[Install]
WantedBy=default.target

[X-Lazurio]
Folder=<Folder>
```

The Launchpad must always run. It restarts after every exit, five seconds apart,
and never ends `failed`: `systemd.unit(5)` counts manual starts toward
`StartLimitIntervalSec=`/`StartLimitBurst=` and stops automatic restarts once the
limit is hit, so the limit is switched off (`0`, pinned in `[Unit]` against a
manager-wide default). There is no `OnFailure=`. `PATH` puts the operator's
standard tool path `~/.local/bin` first ([environment tools](environment-tools.md#the-standard-path-decision-0161-point-6)),
so the Launchpad and what it starts find Bun and the other tools there.

## Offline update

A Machine delivered by Machines receives the Platform from a custody-staged,
digest-pinned binary, never from the network ([machine handover](machine-handover.md),
"Delivery by the Machines role"); the pin is a minimum, and after that the operator
updates with `lazurio update`. The same command that installs it also moves an
existing installation forward: `<staged>/lazurio install --base <base>` run from an
executable **newer** than the active version is the offline update. It takes the
update contract's own steps with the bytes coming from the staged file instead of a
release: what a release with rollback left is migrated, the executable is copied into
`versions/<version>/` and held against its digest, its `self-check` (with the
Launchpad probe when the installation is supervised) must pass (a failure removes
what was placed and switches nothing), the selector is switched by rename and the
high-water mark is raised; a supervised Launchpad that does not report the new
version is `activation-unhealthy`, exactly as for `lazurio update`. The supervisor is
the installer-written unit if there is one; with a foreign unit or none nothing is
restarted and `restartRequired` is true. The result is `{"kind":"updated","from",
"to","restartRequired","path","serviceInstalled"}`. The same version again is
`installed` and changes nothing; a version lower than the active one or below the
high-water mark is refused as `release-invalid` (`reason: "below-floor"`), so a stale
pin can never downgrade a Machine and there is no force. The mark is the floor even
when the selector is missing or damaged: a tree with `update/high-water` at `1.1.0`
and no readable `bin/lazurio` refuses a staged `1.0.0` and is repaired by `1.1.0` or
newer, which proves itself by its `self-check` and becomes active with the mark
unchanged; the whole update state is read and validated first, so a leftover marker
without a selector is `state-invalid` and nothing is staged or switched. Trust is the custody that
staged the binary (its attestation is verified there with `gh attestation verify`);
the running product verifies nothing about a file it was asked to run. This is the
staged way in of [First installation](#first-installation): `--verify-release` is the
downloaded way in and is neither needed nor used here.

## Activation

`lazurio update` under the lock:

1. Migrate what a release with rollback left (below). Check, download into
   scratch, verify, place into `versions/<version>/`, all on the same filesystem.
2. **Refuse before changing anything.** Run the new binary's `self-check`: it
   reports the expected identity and can read the current install base and
   Folder state. On a supervised installation the updater also passes
   `--launchpad`: the candidate runs the Launchpad start sequence against the
   real base and the unit's Folder **read-only** (no Folder lock, no real port, no
   health socket under the base), serves its bundled page on a private temporary
   socket, answers its own health once and exits. A failure removes the candidate
   and ends here with `self-check-failed` (a refused probe names its condition:
   `reason: "launchpad-refused"`, `refusal: <check>`); nothing was switched.
3. **Switch** `bin/lazurio` by one rename and make the directory durable: the
   commit. Then raise the high-water mark; a crash in between leaves the mark
   below the active version, which the floor already covers.
4. Prune every version except the active one.
5. **Unsupervised (macOS, no service):** done; a running Launchpad reports that a
   restart finishes the update (`restartRequired`).
   **Supervised:** restart `lazurio-launchpad.service` and poll its health socket
   until it reports the new version, for at most 30 seconds. Healthy: `updated`.
   Anything else: `activation-unhealthy` (`{from, to}`), exit status 1. **Nothing
   is switched back.** The new version stays active; its Launchpad is in
   Recovery mode (below) or not running, and the unit keeps restarting it.

What the probe cannot catch lands in Recovery mode: a conflict on the real port,
a difference between the updater's and the unit's environment, a crash after
minutes of use.

The Launchpad action starts the same command as
`systemd-run --user --unit lazurio-update … update --version <v>`, so it outlives
the Launchpad restart it causes. The pill follows that unit and
`last-check.json`. A crash of the updater after the switch and before the
restart leaves the new version active and the old Launchpad running; the pill
says that a restart of the Launchpad finishes the update.

`state-invalid` never clears, rewrites or guesses: the product keeps running what
the selector names, the high-water mark is untouched, mutating update commands
refuse with the offending path, and `update status` shows it. It is reachable only
by interference from outside the product and is resolved by a person. An
unreadable `high-water` is `state-invalid` as well; a missing one means the floor
is the active version.

### Recovery mode

When the Launchpad cannot start normally because of a condition the executable
can name, it does not exit (check `start-refused`). The conditions and their
stable ids: `folder-state-unreadable` (the Folder or its state cannot be read by
this version: not owned, unknown entries, unknown key or schema),
`folder-transaction-pending` (an interrupted profile or tools change),
`folder-lock-unavailable`, `hosted-entry-invalid`, `asset-missing` (the page this
executable carries does not serve completely). A Folder that is busy for a moment
(lock held, transaction in flight) is retried for a few seconds first.

In Recovery mode the Launchpad keeps the port it would have served on (the hosted
entry's port behind the same admission, when the Folder's recorded entry still reads
and is valid, which a pending transaction, a held lock or an unknown key elsewhere in
the state do not prevent; otherwise an ephemeral loopback port that no gateway proxies
to) and answers every page path
with `503` and a plain-text body naming the check and the reason, every
`/api/…` route with `503 {error: "recovery-mode", check, reason}`, and the health
socket with `503 {mode: "recovery", check, reason}`. An updater of any release
reads that as not healthy. `lazurio launchpad` prints
`{url, scope: "recovery-mode", check, reason}`. It changes nothing; after the
condition is repaired, a restart of the Launchpad starts it normally. The page
with the repair action and `lazurio recover` are later slices of the
recovery-mode shaping. An executable that cannot run at all is restarted by the
unit every five seconds and picks up a fixed release on the next restart.

### Migration from releases with rollback

Releases up to `v0.1.x` kept `previous`, wrote `update/pending.json` around a
supervised activation and, with `install --service`, wrote
`lazurio-rollback.service` and `OnFailure=` into the Launchpad unit. The migration
`src/update/migrations/remove-rollback/` (its README names the entry points and
the condition for deleting it) runs under the lock at the start of `lazurio
update` and `lazurio install`, after validating the whole update state:

| Found | Outcome |
| --- | --- |
| marker, selector on `from` | marker deleted |
| marker, selector on `to`, `previous` on `from` | mark raised to `to`, marker deleted; nothing is switched back. When its Launchpad is not healthy and nothing newer is available, `lazurio update` answers `activation-unhealthy` (`stage: "legacy-marker"`) |
| marker in any other combination, or unreadable | `state-invalid`, untouched |
| installer-written `lazurio-rollback.service` | deleted |
| installer-written Launchpad unit of this base with `OnFailure=` | rewritten to the unit above; `daemon-reload`, no restart |
| `previous` | deleted; every version but the active one pruned |

`update status` reports `legacyRollbackState: true` until the migration ran.

**The update to the first release without rollback is still performed by the old
updater.** It writes `previous` and a marker, and it switches back if the new
release's Launchpad is not healthy within its deadline; a leftover rollback unit
can still run the old `previous` binary. That is the last rollback that can
happen; it cannot be prevented without blocking the update, and it happens only
if the new release is unhealthy, which its Recovery mode (`503` on the health
socket) makes the correct decision. From the first mutating command the new
release runs, the migration removes all of it.

## Surfaces

- **Launchpad.** Poller: first check shortly after start, then every few minutes
  with jitter. Pill states `idle`, `checking`, `available`, `downloading`,
  `activating`, and failures that return to `available` with the error and a
  retry. It shows version, a link to the release notes and the single action
  appropriate to the state. The Launchpad serves it on its loopback session as
  `GET /api/update/status` (computed from disk and the unit, never the network)
  and `POST /api/update/apply` with the version the pill showed; a version the
  last check no longer names is refused and the pill re-checks. A last verified
  check older than 24 hours is shown prominently by its age whenever the pill
  is shown; it changes no state. `state-invalid` is shown with its path and offers no action. The page
  shows the pill only while an update is available or under way, after a failed
  update and with `state-invalid`; "up to date" and a running check show nothing
  (Principal 2026-09-28, as in T3 Code). The Folder refresh line below is
  independent of the pill.
- **CLI.** `lazurio update`, `--check`, `--version <tag>`, `update status
  [--json]`, `--folder <Folder>` on `update` and `update status`,
  `lazurio install [--verify-release <directory>] [--service
  systemd-user]` (from a newer executable over an existing installation: the offline
  update), `lazurio install prompt`, `lazurio --version`. `lazurio launchpad --folder <Folder>` serves behind the
  Organization's gateway when the Folder records a hosted entry
  ([hosted entry](hosted-entry.md)); the pill and `POST /api/update/apply` pass the
  gateway's admission like every other request there. Other commands print a one-line notice from
  `last-check.json` and never touch the network for it.
- **Folder refresh needed.** An update never writes the Folder
  ([F14](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)). When the
  Folder records an older template revision than the active product renders, the
  results of `lazurio update` (`updated` and `up-to-date`), `update status` and
  the pill carry `folderRefresh {folder, recorded, product, command}` and a person
  reads "Folder refresh needed" with that command: `lazurio machine
  folder-refresh` on a hosted Machine, `lazurio profile-update` with the recorded
  choices at the current revision on a workstation. The Folder is `--folder`, the
  supervised unit's, the Launchpad's own, or on a hosted Machine the declared
  operator's from the handover; none known, nothing is said. The updater learns
  the revision of a new version from its `self-check` report
  (`templateRevision`); a version that does not state it is reported as nothing,
  never guessed. Reading only: no lock, no write, never a reason to refuse.
- **Exit status.** `0` success or up to date, `10` update available (`--check`),
  `2` usage, `1` failure or busy. `--json` carries one stable error code from a
  short list (`network-unavailable`, `release-invalid`, `attestation-invalid`,
  `trust-unavailable`, `target-unsupported`, `reinstall-required`, `busy`,
  `storage-unavailable`, `disk-full`, `not-installed`, `self-check-failed`,
  `activation-failed` (the service manager refused to start the unit),
  `activation-unhealthy`, `state-invalid`, `internal`). `rollback-unavailable`
  is retired and never reused.
- **Identity in the binary.** Version, commit, target, origin and its numeric IDs
  are embedded at build time.

## Never silently stale

1. Local: the pill and the CLI notice, fed by the poller.
2. Observed: `lazurio update status --json` is what an outside observer reads:
   running, active and latest known version and the time of the last verified
   check. Today that observer is the Machines readback on hosted Machines, which
   observes the version and does not own it; later
   it is the managed service once a Machine is enrolled through Lazurio Account.
   An unused installation that nobody observes gets an OS-scheduled check only
   when a real consumer needs it.

Lazurio Account login, a Dashboard-selected Machine profile and internal
analytics stay additive consumers as described in
[F10](decisions.md) and [F11](decisions.md): typed, revisioned requests in, status
out. Login never becomes local authority and analytics can never block an update.

## Deliberately narrow

`linux-x64`, `linux-arm64` and `darwin-arm64` are supported (`linux-arm64` was first
built for the qualification VM; the one-command installation offers it as well,
F20). Installation is per-user. Supervision exists only as a systemd
user service. There is no Windows, no automatic activation, no channel, no
resumable download, no delta update, no OS-scheduled check, no watchdog and no
rollback.

## Evidence required before any Machine depends on this

- Behavioural tests against a local fixture origin: forward update, refusal of
  a version below the floor through `latest` and through an exact tag, the
  equal-high-water return, a candidate refused by its Launchpad probe with the
  base unchanged byte for byte, `activation-unhealthy` with nothing undone, every
  row of the migration table, tag/manifest mismatch, wrong identity, wrong
  repository ID, tampered artifact and manifest, raced `latest`, cold trust cache
  offline, disk full, concurrent runs, kill at every activation step, and
  Recovery mode for every named start refusal.
- One real release candidate published by `release.yml` and verified by a
  compiled client, because a fixture cannot prove the GitHub and Sigstore path.
- Native qualification on Linux with systemd: A → B, a B refused at start that
  ends `activation-unhealthy` while the unit restarts without ever reaching
  `failed`, a candidate refused before the switch by its probe, a real reboot, no
  way back. Then the same journey on a canary Environment.

## Removed by this contract

The pilot installer (`src/distribution`, `product install|recover|status|activate`)
with its journal and replay; TUF roles, keys, floors and the publisher; the
metadata tree on GitHub Pages and its refresh job; channel documents; the signed
identity document; the activation worker, the readiness file and the stability
period; `activation.json`, `previous.json`, `observed.json`, `config.json`; the
documents `pilot-repair.md` and `expired-trust-recovery.md`.
