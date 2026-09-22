# The first final releases through the real path — v0.1.0-rc.2, v0.1.0, v0.1.1, v0.1.2, 2026-09-22/23

Evidence for the [product update contract](../update.md), section *Evidence
required before any Machine depends on this*: the second and third real releases
published by `release.yml`, both on `main`
`c5dc8cd1bdd01702b540ad404010c970136714d5` (the squash of #19), and the first real
update from one published release to another, which
[v0.1.0-rc.1](release-v0.1.0-rc.1-2026-09-22.md) could not cover. The Principal's
decision of 2026-09-22: publish `v0.1.0-rc.2`, verify it on a clean Machine, and
publish `v0.1.0` from the same commit as the first `latest`.

## Publishing

- `v0.1.0-rc.2`: run <https://github.com/Lazurio/LazurioPlatform/actions/runs/35788249164>,
  environment `release` approved by the Admin, one immutable prerelease with the
  five assets. Manifest: `version 0.1.0-rc.2`, `source_commit c5dc8cd1…`.
- `v0.1.0`: run <https://github.com/Lazurio/LazurioPlatform/actions/runs/35788799973>,
  same commit, ordering gate passed against the whole release history (no
  published final release before it), published as `latest`. Manifest below.

## GitHub's own verifier (operator's Mac)

`gh attestation verify <asset> -R Lazurio/LazurioPlatform --bundle
lazurio.sigstore.json --signer-workflow
Lazurio/LazurioPlatform/.github/workflows/release.yml` for `manifest.json` and
`lazurio-linux-arm64` of `v0.1.0-rc.2`: verified; the certificate names
`sourceRepositoryRef refs/tags/v0.1.0-rc.2`, `buildSignerURI
…/release.yml@refs/tags/v0.1.0-rc.2`, issuer
`https://token.actions.githubusercontent.com`. The binary with one appended byte
is refused (`Error: verifying with issuer "sigstore.dev"`).

## Phase 1 — rc.2 on a clean Machine

Fresh disposable Ubuntu 24.04.4 ARM64 clone (systemd 255), no `gh`, umask `0002`,
`curl` and `sha256sum` only, real network to `github.com`. `install.sh` fetched
from the tag over HTTPS.

```text
$ LAZURIO_VERSION=v0.1.0-rc.2 sh install.sh
NOT verified beyond HTTPS: the GitHub CLI (gh) is not installed, so the attestation of v0.1.0-rc.2 was not checked.
Lazurio 0.1.0-rc.2 is installed. Put /home/admin/.local/share/lazurio/bin on your PATH.
$ lazurio --version
lazurio 0.1.0-rc.2 (commit c5dc8cd1bdd01702b540ad404010c970136714d5, target linux-arm64)
$ lazurio update --check --json
{"kind":"error","code":"release-invalid","context":{"resource":"latest","reason":"not-found"}}   # no final release yet
$ lazurio update --check --version v0.1.0-rc.2 --json
{"kind":"up-to-date","running":"0.1.0-rc.2","latest":"0.1.0-rc.2","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v0.1.0-rc.2"}
```

Adoption from two handovers shaped exactly as Machines v0.12.61 writes them
(`/etc/lazurio/lazurio.machine.json`, `root:root 0644`), Folder skeleton created
with umask `077`, no `--preset`:

- `personal-vm` with `relationships` (laptop both ways, work VM outbound with its
  Launchpad hostname) → `initialized`, preset `hosted-personal`, six manual files;
  `manual/this-machine.md` carries *This Machine's zone* ("the personal VM of the
  personal zone… no work Machine may reach it") and a *Relationships* section with
  one line per peer ("SSH from here to `matej.tailnet…` as `admin`; HTTPS
  `launchpad.matej.spectoda.lazurio.io`"). Re-run → `already-adopted`, same digest.
- `workspace-vm` with `owner.team`, `owner.assignment {operator immakermatty}` and
  work-zone `relationships` → `initialized`, preset `hosted-organization-personal`
  derived from the assignment alone; the manual states "Assignment: assigned to
  operator `immakermatty` (GitHub id 12345)", the work-zone sentence and the three
  peers (laptop inbound, personal VM inbound as `admin`, Conglomerate Host HTTPS
  only). No generated file references `HumanAndMachines/Lazurio`.

Supervised path on the same Machine: `lazurio install --service systemd-user
--folder ~/Lazurio` under umask `002` → `{"kind":"installed","active":"0.1.0-rc.2",
"serviceInstalled":true}`; `lazurio-launchpad.service` active, its main process is
`versions/0.1.0-rc.2/lazurio` through the selector, `update/launchpad.sock`
present, `update status` reports `supervised: true`, no high-water yet.

## Phase 2 — the real update rc.2 → v0.1.0 on the supervised Machine

### First attempt: rc.2 → v0.1.0 refused, and rightly so by the client

On the supervised Machine of phase 1 (Launchpad active on `0.1.0-rc.2`, pid 1899),
once `v0.1.0` was `latest`:

```text
$ lazurio update --check --json
{"kind":"error","code":"reinstall-required","context":{"version":"0.1.0","minimumUpdaterVersion":"0.1.0"}}
$ lazurio update --json
{"kind":"error","code":"reinstall-required","context":{"version":"0.1.0","minimumUpdaterVersion":"0.1.0"}}
$ lazurio update status --json
{"kind":"status","running":"0.1.0-rc.2","active":"0.1.0-rc.2","previous":null,"highWater":null,"supervised":true,"pending":null,"stateInvalid":null,"lastCheck":{"checkedAt":"2026-09-22T21:53:29.985Z","latest":"0.1.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v0.1.0"},"updateAvailable":true}
$ lazurio update rollback --json
{"kind":"error","code":"rollback-unavailable","context":{"reason":"none"}}
```

Nothing changed on the Machine: selector still `0.1.0-rc.2`, no `previous`, no
high-water, no marker, the unit untouched, no updater process left behind, the
Folder still `already-adopted`. The client behaved exactly as the contract says
for a release whose `minimum_updater_version` is above the running version.

The defect is in publishing: `scripts/release-manifest.ts` set the minimum to the
constant `0.1.0`, and in the product order a prerelease is below its final
version (`0.1.0-rc.2 < 0.1.0`), so the first final release refused every
release-candidate client. Fixed in #21: the constant is the first release whose
updater exists, `0.1.0-rc.1`, raised only with an incompatible protocol change;
`v0.1.0` itself is immutable and keeps the old value. A client on an rc reinstalls
(the exact-tag `install.sh`) or updates to the next release.

Observed inconsistency, not fixed here: `update status` reports
`updateAvailable: true` from the last check while `update --check` reports
`reinstall-required`, and the `folder-init` hint says "Run `lazurio update`" for
an update the client will refuse. The hint should carry the check's outcome.

### Staged-binary install over an existing installation (the Machines-role path)

The role installs from a custody-staged, digest-pinned binary with no network.
On the same supervised rc.2 Machine, the real `lazurio-linux-arm64` of `v0.1.0`
(sha256 verified) ran `install --base ~/.local/share/lazurio --json` under umask
`002`:

```text
{"kind":"installed","active":"0.1.0-rc.2","path":"/home/admin/.local/share/lazurio/bin","serviceInstalled":false}
```

No `versions/0.1.0` added, selector and running unit unchanged on the rc, both
units untouched (`ExecStart` is the selector, `OnFailure=lazurio-rollback.service`).
By design (`src/update/install.ts`: an installation exists, versions change only
through `lazurio update`). `lazurio machine folder-init` afterwards →
`already-adopted`, `preferences.json` byte-identical, manual intact. So the role's
staged install is exact on a fresh Machine and a safe no-op on an installed one;
an installed Machine moves to the pinned version through the product's update.

### Second attempt: rc.2 → v0.1.1 and v0.1.0 → v0.1.1

`v0.1.1` (run <https://github.com/Lazurio/LazurioPlatform/actions/runs/35791688509>,
`main` `4df177a9fc4f2c5f6e0ef2863971dc2a9163099d` = the squash of #21) is `latest`;
`gh attestation verify manifest.json` verified on `refs/tags/v0.1.1`; its manifest
carries `minimum_updater_version 0.1.0-rc.1`. Targets: `linux-x64`
`707d57a6157253b46e37b27847e1ba09659365a0f39bddc8902029eb88562a77` (82441696),
`linux-arm64` `b5487a5d86e8a9f88ff274f3b200f606103dae8a0fa20491185b629af5f455a3`
(82430248), `darwin-arm64` `bf5ad28bdd16473b37f564a17d1136e1da017bcc792c1710147c6fb50fc82f1e`
(63349746).

Two supervised Machines, both adopted Folders, both with the Launchpad active
under `lazurio-launchpad.service` written by `lazurio install`:

| Machine | From | Check | Update | Launchpad on the new version | Status after | Rollback | Forward again | Folder |
|---|---|---|---|---|---|---|---|---|
| VM 1 (rc.2, organization Folder) | `0.1.0-rc.2` | `available`, exit 10 | `{"kind":"updated","from":"0.1.0-rc.2","to":"0.1.1","restartRequired":false}` | 18 s, pid 3944 → 4081 | `active 0.1.1`, `previous 0.1.0-rc.2`, `highWater 0.1.1`, no marker, no updater process | `rolled-back` to `0.1.0-rc.2`, unit active on it, high-water stays `0.1.1` | `updated` to `0.1.1` again | `already-adopted`, same digest |
| VM 2 (v0.1.0 via `latest`, personal `cs` Folder) | `0.1.0` | `available`, exit 10 | `{"kind":"updated","from":"0.1.0","to":"0.1.1","restartRequired":false}` | 21 s, pid 1333 → 1470 | `active 0.1.1`, `previous 0.1.0`, `highWater 0.1.1` | `rolled-back` to `0.1.0` | `updated` to `0.1.1` again | `already-adopted` |

Both `versions/` directories hold exactly the two versions; the transient
`lazurio-update` unit left no journal entries because `lazurio update` ran from the
shell, not from the pill. The rc client's refusal of `v0.1.0` above and its success
with `v0.1.1` are the two halves of the same evidence: the client was right, the
published minimum was wrong.

## Manifest of v0.1.0 (for custody-staged installs by the Machines role)

```json
{
  "schema": 1,
  "version": "0.1.0",
  "source_commit": "c5dc8cd1bdd01702b540ad404010c970136714d5",
  "minimum_updater_version": "0.1.0",
  "targets": {
    "darwin-arm64": { "sha256": "21e754fd43e69683bab8d7b965946e982c5e616646ebd61034b5edd7258da1a8", "size": 63349746 },
    "linux-arm64":  { "sha256": "868ea157ef43dbadd9039b35494d6217e04acf15ad3f7ae44daf83e40d749cd4", "size": 82430248 },
    "linux-x64":    { "sha256": "e8e4e271a9b4c4101430696540c96d27173ff9fb62f9beb634935d783c696599", "size": 82441696 }
  }
}
```

`gh attestation verify` of `manifest.json` and `lazurio-linux-arm64` of `v0.1.0`
with the same flags as above: verified, `sourceRepositoryRef refs/tags/v0.1.0`,
`buildSignerURI …/release.yml@refs/tags/v0.1.0`.

## Findings on the Machines-delivered canary (Spectoda `matej`, rc.1)

Read-only probe, 2026-09-23: `lazurio-launchpad.service` there is the Machines
resident runtime's unit (bun `server-launcher.mjs`), yet `update status` reports
`supervised: true` because the updater takes the unit name as proof; an update
would restart that unit and undo after 30 s. And a re-applied handover (Machines
rewrites `installed.*`, `owner.assignment`, `relationships` on every apply) turns
an adopted Folder into `blocked folder-binding-changed` — reproduced on VM 1 by
changing only `installed.recorded_at`. Both fixed in #22 (marker-gated
supervision; adoption by Machine identity). The rc.1 updater on the canary has
neither fix, so that Machine moves forward by one deliberate reinstall of
`bin/`, `versions/`, `update/` under the shared base once the fixed release exists.

## v0.1.2 and the Machines-delivered canary

`v0.1.2` (run <https://github.com/Lazurio/LazurioPlatform/actions/runs/35794323975>,
`main` `3ace67847b44b10335975c0cca3656bcdb2f6ac5` = the squash of #22) is `latest`,
attestation verified on `refs/tags/v0.1.2`; targets `linux-x64`
`f70cbb7f3d4a5dfd0610eca781cbc28b2ac957b493df5e9d2b56adad2402ba86` (82441696),
`linux-arm64` `4c96e8e23a48a7eff2d09f38809c9e330528bc14461f1a324e75aaf7b3caaa89`
(82430248), `darwin-arm64` `3a6529a7046066565ac5c7235ab3e6e0957ee93ccf2a2e9be7e27b89524bc5a9`
(63349746); bundle `lazurio.sigstore.json`
`6f0b88dab5828e2b24a237ead43f1a018a4e6412977b5c15e3bb31c5d25f4e2c` (11319). The
Machines role pins this release (docs/machine-handover.md, "Delivery by the Machines
role").

- **VM 1, supervised by the installer-written unit:** `0.1.1` → `0.1.2` `updated`,
  Launchpad on `0.1.2` in 17 s, `supervised: true` stays (the marker is present),
  rollback to `0.1.1` and forward again, Folder `already-adopted`.
- **Spectoda `matej` (Machines-delivered, linux-x64, Machines v0.12.63 handover with
  `owner.assignment` operator):** the rc.1 updater has neither #22 fix, so one
  deliberate reinstall with the Principal's consent: `bin/`, `versions/`, `update/`
  removed, `LAZURIO_VERSION=v0.1.2 sh install.sh` (no `gh` on the Machine);
  `resident/`, `t3code/`, `operator-kit/` untouched (`lifecycle.v1.json`,
  `resident/active`, `t3code/current` identical before and after, both Machines
  units active throughout). Readback: `lazurio 0.1.2`, `update status` →
  `supervised: false` on the Machines unit, `update --check` → `up-to-date`.
- **rc.1-era Folder state is not recognised:** `folder-init` on the Folder adopted
  by rc.1 → `blocked folder-state-unrecognized` (rc.1 wrote `instructions.json`
  schema 1 with one output; F14 replaced it with the outputs manifest, and no
  compatibility path was in scope). `matej` was the only such Folder: `.lazurio/`
  and the rc.1 `AGENTS.md` moved to `~/Lazurio.lazurio-rc1-backup-2026-09-23/`,
  then `folder-init` → `initialized`, preset `hosted-organization-personal` derived
  from the assignment, six manual files, `this-machine.md` with the assignment line;
  re-run `already-adopted`. `profile-update --expected-revision 1 … --locale cs` →
  `updated` revision 2, Czech `AGENTS.md`, manual stays English.

## Not covered by this run

`darwin-arm64` client against these releases; the Launchpad pill path against a
real release (qualified against the fixture origin in
[update-linux-arm64-2026-09-21.md](update-linux-arm64-2026-09-21.md)); the
Machines role's own install from the custody-staged binary (Machines #199); the
Launchpad pill on a Machines-delivered VM (its Launchpad is the resident's, not the
Platform's).
