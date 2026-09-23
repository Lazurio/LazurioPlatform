# Product update

Status: **accepted direction of the Principal (2026-09-19, simplified the same
day), implementation in progress.** This document is the single contract for how
an installed Lazurio learns about, obtains and activates a new product version.
It replaces the earlier TUF-based contract and the pilot installer documents
(decision [F13](decisions.md#f13--release-trust-is-github-artifact-attestation)).
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
3. When the user clicks, the update **dependably happens**: every failure is
   bounded, leaves the installed product working, and the same click works again
   once the outside condition is restored. A crash at any point is reconciled by
   the next command without manual repair. Two exceptions need a person and are
   named where they arise: a new version that stays alive but unhealthy after a
   power loss inside the activation window (`lazurio update rollback`), and update
   state damaged from outside the product (`state-invalid`).
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
- **Explicit activation.** Checking and showing availability are automatic;
  download and activation start only from `lazurio update` or the Launchpad
  action.
- **No wedge.** Every failure leaves the installed product usable and the next
  attempt possible. Downloads are scratch files; there is no pending download, no
  `recover` command and no journal. The only transaction record is the activation
  marker `pending.json`, and every state it can be found in has one defined
  outcome (*Reconciling the marker*).
- **Versions only move forward over the network.** The floor is the higher of the
  active version and the durable high-water mark, which records the highest
  version whose activation was ever committed. No network path, `latest` or an
  exact tag, installs a version below the floor, even after a rollback.
- **Program rollback is not data rollback.** A version never rewrites Folder
  state into a form its predecessor cannot read before its activation is
  committed.
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
creates one Sigstore bundle with `actions/attest` whose subjects are the manifest
and every binary, attaches everything to a draft release and publishes it once.
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
is refused, a version equal to the high-water mark but not active (the retry
after a rollback) is allowed. Going below the floor is only ever the local
`update rollback`. GitHub prereleases are invisible to `latest`, so a release
candidate reaches only the Machines that ask for it. This is the whole canary
mechanism; there are no channels. A Machine that committed a release candidate
follows that line: it takes the next version at or above it, and returning to an
older line is a new installation.

**First installation** is trusted through HTTPS, and says so. `install.sh`
downloads the latest binary from the origin and checks it against the manifest.
When `gh` is present it runs `gh attestation verify` before executing anything.
An attestation check performed by the downloaded binary itself is not
authentication and is not presented as one. OS publisher signing stays a gate
before public release ([decisions](decisions.md)).

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

## State on disk

Everything lives under the per-user install base
(`${XDG_DATA_HOME:-~/.local/share}/lazurio` on Linux,
`~/Library/Application Support/Lazurio` on macOS). Unknown entries are tolerated.

| Path | Meaning |
| --- | --- |
| `versions/<version>/lazurio` | immutable installed versions; the active and the previous one are kept, older ones are pruned after a committed activation |
| `bin/lazurio` → `../versions/<v>/lazurio` | the only selector of the active version |
| `previous` → `versions/<v>` | the rollback target |
| `update/lock` | one kernel `flock` for every mutating update operation |
| `update/high-water` | highest version whose activation was ever committed; only ever raised |
| `update/pending.json` | `{from, to}` activation marker of a supervised installation; written before the switch, deleted by the commit or the undo |
| `update/last-check.json` | cache of the last check for the pill and the CLI notice; disposable |
| `sigstore/` | Sigstore's trust-root cache; disposable |

`high-water` and `pending.json` are written as a temporary file made durable,
renamed over the target, with the directory made durable. A crash leaves the old
or the new content, never a partial one. Status is computed from these paths when asked; there is no observed-state file
and no configuration file. A supervised installation is one whose systemd user
unit `lazurio-launchpad.service` was written by `lazurio install` (its first line
is the installer's marker); the Folder path lives in that unit. A unit of that
name written by anyone else — a Machines resident runtime, a person — makes the
installation unsupervised: the switch is the commit and that unit is never
restarted or rewritten.

## Offline update

A Machine delivered by Machines receives the Platform from a custody-staged,
digest-pinned binary, never from the network ([machine handover](machine-handover.md),
"Delivery by the Machines role"). The same command that installs it also moves an
existing installation forward: `<staged>/lazurio install --base <base>` run from an
executable **newer** than the active version is the offline update. It takes the
update contract's own steps with the bytes coming from the staged file instead of a
release: a leftover marker is reconciled, the executable is copied into
`versions/<version>/` and held against its digest, its `self-check` must pass (a
failure removes what was placed and switches nothing), `previous` is recorded, the
selector is switched by rename and the high-water mark is raised. The supervisor is
the installer-written unit if there is one; with a foreign unit or none the switch is
the commit and `restartRequired` is true. The result is `{"kind":"updated","from",
"to","restartRequired","path","serviceInstalled"}`. The same version again is
`installed` and changes nothing; a version lower than the active one or below the
high-water mark is refused as `release-invalid` (`reason: "below-floor"`), so a stale
pin can never downgrade a Machine and there is no force. The mark is the floor even
when the selector is missing or damaged: a tree with `update/high-water` at `1.1.0`
and no readable `bin/lazurio` refuses a staged `1.0.0` and is repaired by `1.1.0` or
newer, which becomes active with the mark unchanged; the whole update state is read
and validated first, so a marker without a selector is `state-invalid` and nothing is
staged or switched. Trust is the custody that
staged the binary (its attestation is verified there with `gh attestation verify`);
the running product verifies nothing about a file it was asked to run.

## Activation

`lazurio update` under the lock:

1. Reconcile a leftover `pending.json` (below). Check, download into scratch,
   verify, place into `versions/<version>/`, all on the same filesystem.
2. Run the new binary's `self-check`: it reports the expected identity and can
   read the current install base and Folder state. A failure ends here; nothing
   was switched.
3. Point `previous` at the active version. On a supervised installation write
   `pending.json {from, to}`. Each step is durable before the next.
4. Replace `bin/lazurio` by rename and make the directory durable.
5. **Unsupervised (macOS, no service):** raise the high-water mark to the new
   version; done. The switch is the commit and there is no marker; a running
   Launchpad reports that a restart finishes the update.
   **Supervised:** restart `lazurio-launchpad.service` and poll its health
   endpoint until it reports the new version, for at most 30 seconds. On success
   commit: raise the high-water mark, delete `pending.json`, prune. On failure
   undo: switch back, restart, delete `pending.json`, exit `activation-failed`.
   A version whose activation was undone never raised the high-water mark; the
   pill returns to `available` with the failure, and a retry is the same click.

The Launchpad action starts the same command as
`systemd-run --user --unit lazurio-update … update --version <v>`, so it outlives
the Launchpad restart it causes. The pill follows that unit and
`last-check.json`.

### Reconciling the marker

`pending.json` can outlive its updater only through a crash. Whoever next holds
the lock reconciles it before doing anything else: every mutating update
command, a starting Launchpad, and the rollback unit. The outcome depends only
on what is on disk:

| Marker | `bin/lazurio` selects | `previous` selects | Meaning | Outcome |
| --- | --- | --- | --- | --- |
| absent | any | any | nothing in flight | proceed |
| valid | `from` | any | crashed before the switch, or after an undo | delete the marker; proceed. The next click starts a fresh activation |
| valid | `to` | `from` | switched, not committed | decided by the reconciler, below |
| valid | `to` | not `from` | cannot arise from a crash | `state-invalid` |
| valid | neither | any | cannot arise from a crash | `state-invalid` |
| unreadable or wrong schema | any | any | cannot arise from a crash | `state-invalid` |

Switched, not committed:

- A **Launchpad of version `to`** that has started healthy commits.
- The **rollback unit** (`OnFailure=lazurio-rollback.service`, run from
  `previous/lazurio update rollback --auto` when the start limit is hit) undoes. In
  every other row it does nothing.
- A **mutating update command** asks the service once: healthy at `to` commits,
  anything else undoes. It then continues with what the user asked for.

`state-invalid` never clears, rewrites or guesses: the product keeps running what
the selector names, the high-water mark is untouched, mutating update commands
refuse with the offending path, and `update status` shows it. It is reachable only
by interference from outside the product and is resolved by a person. An
unreadable `high-water` is `state-invalid` as well; a missing one means the floor
is the active version.

Not recovered automatically: a new version that stays alive but never becomes
healthy after a power loss between the switch and the commit. systemd sees a live
process, so the rollback unit never runs; the next `lazurio update` or `lazurio
update rollback` undoes it. A watchdog is deliberately not built for it.

`lazurio update rollback` switches to `previous` after that binary's own
`self-check`, with the same marker, restart and health rule, after raising the
high-water mark to the version it leaves. It never lowers the high-water mark. After
an undone activation `previous` names the active version, so there is no rollback
target until the next committed update; the marker deliberately carries no more
state to restore it.

## Surfaces

- **Launchpad.** Poller: first check shortly after start, then every few minutes
  with jitter. Pill states `idle`, `checking`, `available`, `downloading`,
  `activating`, and failures that return to `available` with the error and a
  retry. It shows version, a link to the release notes and the single action
  appropriate to the state. The Launchpad serves it on its loopback session as
  `GET /api/update/status` (computed from disk and the unit, never the network)
  and `POST /api/update/apply` with the version the pill showed; a version the
  last check no longer names is refused and the pill re-checks. A last verified
  check older than 24 hours is shown prominently by its age; it changes no
  state. `state-invalid` is shown with its path and offers no action.
- **CLI.** `lazurio update`, `--check`, `--version <tag>`, `update status
  [--json]`, `update rollback`, `lazurio install [--service systemd-user]` (from a
  newer executable over an existing installation: the offline update),
  `lazurio --version`. Other commands print a one-line notice from
  `last-check.json` and never touch the network for it.
- **Exit status.** `0` success or up to date, `10` update available (`--check`),
  `2` usage, `1` failure or busy. `--json` carries one stable error code from a
  short list (`network-unavailable`, `release-invalid`, `attestation-invalid`,
  `trust-unavailable`, `target-unsupported`, `reinstall-required`, `busy`,
  `storage-unavailable`, `disk-full`, `not-installed`, `self-check-failed`,
  `activation-failed`, `rollback-unavailable`, `state-invalid`, `internal`).
- **Identity in the binary.** Version, commit, target, origin and its numeric IDs
  are embedded at build time.

## Never silently stale

1. Local: the pill and the CLI notice, fed by the poller.
2. Observed: `lazurio update status --json` is what an outside observer reads:
   running, active and latest known version and the time of the last verified
   check. Today that observer is the Machines readback on hosted Machines; later
   it is the managed service once a Machine is enrolled through Lazurio Account.
   An unused installation that nobody observes gets an OS-scheduled check only
   when a real consumer needs it.

Lazurio Account login, a Dashboard-selected Machine profile and internal
analytics stay additive consumers as described in
[F10](decisions.md) and [F11](decisions.md): typed, revisioned requests in, status
out. Login never becomes local authority and analytics can never block an update.

## Deliberately narrow

`linux-x64` and `darwin-arm64` are supported; `linux-arm64` is built for the
qualification VM. Installation is per-user. Supervision exists only as a systemd
user service. There is no Windows, no automatic activation, no channel, no
resumable download, no delta update, no OS-scheduled check and no watchdog.

## Evidence required before any Machine depends on this

- Behavioural tests against a local fixture origin: forward update, refusal of
  a version below the floor after a rollback through `latest` and through an
  exact tag, the equal-high-water retry, every row of the reconcile table, tag/manifest
  mismatch, wrong identity, wrong repository ID, tampered artifact and manifest,
  raced `latest`, cold trust cache offline, disk full, concurrent runs, kill at
  every activation step.
- One real release candidate published by `release.yml` and verified by a
  compiled client, because a fixture cannot prove the GitHub and Sigstore path.
- Native qualification on Linux with systemd: A → B, failed B with automatic
  rollback, crash-looping B after a simulated power loss, explicit rollback, a
  real reboot. Then the same journey on the Spectoda canary.

## Removed by this contract

The pilot installer (`src/distribution`, `product install|recover|status|activate`)
with its journal and replay; TUF roles, keys, floors and the publisher; the
metadata tree on GitHub Pages and its refresh job; channel documents; the signed
identity document; the activation worker, the readiness file and the stability
period; `activation.json`, `previous.json`, `observed.json`, `config.json`; the
documents `pilot-repair.md` and `expired-trust-recovery.md`.
