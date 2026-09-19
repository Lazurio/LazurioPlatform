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
2. Availability is shown **continuously**: a Machine never silently stays on an
   old version.
3. When the user clicks, the update **dependably happens**: every failure is
   bounded, leaves the installed product working, and the same click works again
   once the outside condition is restored. No failed attempt needs manual repair.
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
  attempt possible. Downloads are scratch files; there is no pending attempt,
  no `recover` command and no journal.
- **Versions only move forward over the network.** The highest version ever
  accepted is durable. A network update is never lower than it, even after a
  rollback.
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
Releases are immutable (GitHub immutable releases). The workflow refuses a final
version that is not greater than every existing final release, marks the release
as latest explicitly, pins every action by commit and runs its publishing job in
the protected environment `release` with a required reviewer. The file name
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
update. An older client reports `reinstall-required` and changes nothing.

**Check.** The client requests
`https://github.com/<origin>/releases/latest/download/manifest.json`, records the
tag the redirect resolved to, and from then on uses only exact-tag URLs
(`releases/download/<tag>/…`) for the bundle and the artifact. A manifest whose
version differs from the resolved tag is refused. An update is available when
the verified manifest version is greater than the running version and not lower
than the durable high-water mark.

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

**Exact version.** `lazurio update --version vX.Y.Z-rc.N` installs one exact tag
through the same verification. GitHub prereleases are invisible to `latest`, so
a release candidate reaches only the Machines that ask for it. This is the whole
canary mechanism; there are no channels.

**First installation** is trusted through HTTPS, and says so. `install.sh`
downloads the latest binary from the origin and checks it against the manifest.
When `gh` is present it runs `gh attestation verify` before executing anything.
An attestation check performed by the downloaded binary itself is not
authentication and is not presented as one. OS publisher signing stays a gate
before public release ([decisions](decisions.md)).

**Knowingly not covered.** An attacker who controls both the network and a valid
TLS certificate for `github.com` can hold a client on its current version; they
cannot downgrade it or make it run foreign bytes. Trust rests on the governance
of this repository: whoever can run the protected release workflow on a protected
tag can publish. A private fork is a different product configuration with its
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
| `update/high-water` | highest version ever accepted |
| `update/pending.json` | `{from, to}`; present only between a switch and its commit on a supervised installation |
| `update/last-check.json` | cache of the last check for the pill and the CLI notice; disposable |
| `sigstore/` | Sigstore's trust-root cache; disposable |

Status is computed from these paths when asked; there is no observed-state file
and no configuration file. A supervised installation is one whose systemd user
unit `lazurio-launchpad.service` exists; the Folder path lives in that unit.

## Activation

`lazurio update` under the lock:

1. Reconcile a leftover `pending.json` (below). Check, download into scratch,
   verify, place into `versions/<version>/`, all on the same filesystem.
2. Run the new binary's `self-check`: it reports the expected identity and can
   read the current install base and Folder state. A failure ends here; nothing
   was switched.
3. Point `previous` at the active version; write the high-water mark; on a
   supervised installation write `pending.json`. Each step is made durable before
   the next.
4. Replace `bin/lazurio` by rename and make the directory durable.
5. **Unsupervised (macOS, no service):** done. The switch is the commit; a running
   Launchpad reports that a restart finishes the update.
   **Supervised:** restart `lazurio-launchpad.service` and poll its health
   endpoint until it reports the new version, for at most 30 seconds. On success
   delete `pending.json` and prune. On failure switch back, restart, delete
   `pending.json` and exit `activation-failed`. The high-water mark stays; the
   pill returns to `available` with the failure, and a retry is the same click.

The Launchpad action starts the same command as
`systemd-run --user --unit lazurio-update … update --version <v>`, so it outlives
the Launchpad restart it causes. The pill follows that unit and
`last-check.json`.

**Interrupted activation.** If the updater dies after the switch (power loss),
`pending.json` remains. A Launchpad of version `to` that starts healthy and can
take the lock deletes it: the activation is committed. If instead the new
version crash-loops, the unit's start limit triggers
`OnFailure=lazurio-rollback.service`, which runs `previous/lazurio update
rollback --auto`. That command does nothing unless `pending.json` is valid, the
selector equals `to`, `previous` equals `from` and it holds the lock; then it
switches back, resets the failed unit and restarts it. Every later mutating
command reconciles a leftover marker the same way before it begins. A new
version that stays alive but never becomes healthy after a power loss in that
window is not recovered automatically; `lazurio update rollback` is the answer,
and a watchdog is deliberately not built for it.

`lazurio update rollback` switches to `previous` after that binary's own
`self-check`, with the same restart and health rule. It never lowers the
high-water mark.

## Surfaces

- **Launchpad.** Poller: first check shortly after start, then every few minutes
  with jitter. Pill states `idle`, `checking`, `available`, `downloading`,
  `activating`, and failures that return to `available` with the error and a
  retry. It shows version, a link to the release notes and the single action
  appropriate to the state.
- **CLI.** `lazurio update`, `--check`, `--version <tag>`, `update status
  [--json]`, `update rollback`, `lazurio install [--service systemd-user]`,
  `lazurio --version`. Other commands print a one-line notice from
  `last-check.json` and never touch the network for it.
- **Exit status.** `0` success or up to date, `10` update available (`--check`),
  `2` usage, `1` failure or busy. `--json` carries one stable error code from a
  short list (`network-unavailable`, `release-invalid`, `attestation-invalid`,
  `trust-unavailable`, `target-unsupported`, `reinstall-required`, `busy`,
  `storage-unavailable`, `disk-full`, `not-installed`, `self-check-failed`,
  `activation-failed`, `rollback-unavailable`, `internal`).
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
  a version below the high-water mark after a rollback, tag/manifest
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
