# Product update: native Linux ARM64 qualification, 2026-09-21

Evidence for the [product update contract](../update.md), section *Evidence
required before any Machine depends on this*, third item (native Linux with
systemd, including a real reboot). It does **not** cover the real GitHub and
Sigstore path, `linux-x64`, macOS or the Spectoda canary.

| | |
| --- | --- |
| Source commit | `665fa744755bf036d98aabe6c7c00725e0df2760` (branch `claude/DEV-6594-update-impl`); a first run on `0b86a18` with a single-listener fixture gave the same 47/47 and is superseded by this one |
| Machine | fresh disposable clone of the Ubuntu base image (Tart, Apple Silicon host), deleted afterwards |
| OS | Ubuntu 24.04.4 LTS, kernel 7.0.0-30-generic, `aarch64` |
| systemd | 255 (255.4-1ubuntu8.17), user manager with `Linger=yes` (enabled by the operator before the run) |
| Harness | `scripts/qualify-update-linux.ts` (bundle built on the host) and `scripts/qualify-update-linux.sh` (run on the Machine) |
| Result | **47 checks passed, 0 failed**; phase `before-reboot` 30, phase `after-reboot` 17; a real `systemctl reboot` between them |

The fixture origin serves the real redirect shape on two listeners: `latest` → the
origin's exact-tag URL (port 38917) → asset storage on another port (38918) whose URL
names neither the repository nor the tag. Every check and download in the journeys
below went through that chain; the client takes the tag from the first hop only.

The four executables are the real product entry point (`src/cli.ts`) compiled for
`linux-arm64`, differing only in the embedded version (1.0.0, 1.1.0, 1.1.5,
1.2.0). They are **fixture builds**: they ask a loopback origin on the Machine and
trust a throwaway fixture Sigstore root from the bundle, say so in `--version`,
and a product updater's self-check refuses them. The verification code that runs
is the real sigstore-js verifier.

## What the journeys showed

1. `install --service systemd-user`: the executable installs itself as the first
   version, writes `lazurio-launchpad.service` and the static
   `lazurio-rollback.service`, enables the service; no high-water mark yet, so
   the floor is the active version.
2. 1.0.0 → 1.1.0: `--check` exits 10, the update verifies the attested release,
   switches, restarts the service, sees health at the new version and commits
   (high-water raised, marker deleted). 1.4 s.
3. A 1.2.0 that refuses to start: `activation-failed`, exit 1, switched back
   within the health deadline, mark not raised, marker deleted, the retry is the
   same action. The rollback unit that systemd started during that attempt found
   the updater alive holding the lock and did nothing.
4. Simulated power loss (SIGKILL of the updater right after the switch) with a
   crash-looping 1.2.0: nobody runs any command; the start limit triggers
   `OnFailure=lazurio-rollback.service`, which switches back, resets the failed
   unit and restarts it. Mark not raised.
5. Simulated power loss after the switch to a healthy 1.2.0, then a **real
   reboot**: the Launchpad of 1.2.0 started at boot, outlived its first 15 s and
   committed the marker itself; no update command ran between the boot and the
   commit.
6. Explicit `update rollback` 1.2.0 → 1.1.0: previous after its own self-check,
   same restart and health rule; the version left stays the floor.
7. The floor: a `latest` of 1.1.5 below the mark is not an update; the exact tag
   `v1.1.5` is refused as `release-invalid` / `below-floor`; the exact tag equal
   to the mark but not active (1.2.0) is allowed and activates.

## Journey 8 — Launchpad pill (pending native run)

Added to the `after-reboot` phase after journey 7 by the update-pill branch: the
click path entirely through the installed Launchpad's loopback session
(`GET /api/update/status`, `POST /api/update/apply` with the bearer token read
from the service's journal) — availability learned by the poller's own first
check, the click that starts the transient `lazurio-update` unit and restarts
the Launchpad, a stale click, a failed candidate (the attested impostor release
`v1.4.0` whose executable is 1.3.0's, refused by its self-check) with the error
read back from the unit's journal and a retry that is not `busy`, and
`state-invalid` from a damaged `update/high-water`. Not yet run natively; this
section is replaced by the transcript of that run.

## Observed and accepted

- After an **undone** activation `previous` names the same version as the
  selector (journey 4: `selector=1.1.0 previous=1.1.0`), so `update rollback`
  answers `rollback-unavailable` until the next committed update. The older
  version directory still exists but nothing points at it. This follows from the
  contract's ordering ("point `previous` at the active version" before the
  switch) and is accepted rather than adding state to the marker.
- After a rollback the check reports `up-to-date` with `running 1.1.0, latest
  1.1.5`: a `latest` below the floor is never offered. `update status` shows the
  high-water mark that explains it.

## Transcript: `before-reboot`

```text
phase before-reboot: target linux-arm64, commit 665fa744755bf036d98aabe6c7c00725e0df2760, systemd 255 (255.4-1ubuntu8.17), 7.0.0-30-generic
linger: yes
   lazurio 1.0.0 (commit 665fa744755bf036d98aabe6c7c00725e0df2760, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.1.0 (commit 665fa744755bf036d98aabe6c7c00725e0df2760, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.1.5 (commit 665fa744755bf036d98aabe6c7c00725e0df2760, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.2.0 (commit 665fa744755bf036d98aabe6c7c00725e0df2760, target linux-arm64) FIXTURE BUILD: not a release

== 1. install --service systemd-user: the downloaded executable installs ITSELF and the units ==
   > {"kind":"installed","active":"1.0.0","path":"/home/admin/.local/share/lazurio/bin","serviceInstalled":true}
   > exit=0
   PASS  result: installed
   PASS  selector: 1.0.0
   PASS  modes of base bin versions update (umask 002): 700 700 700 700
   PASS  mode of the executable: 500
   units written by the installer:
   | # Written by `lazurio install`; rewritten by it, so edit a drop-in instead.
   | [Unit]
   | Description=Lazurio Launchpad
   | StartLimitIntervalSec=60
   | StartLimitBurst=5
   | OnFailure=lazurio-rollback.service
   |
   | [Service]
   | ExecStart=/home/admin/.local/share/lazurio/bin/lazurio launchpad --base /home/admin/.local/share/lazurio --folder /home/admin/Lazurio
   | Restart=on-failure
   | RestartSec=2
   |
   | [Install]
   | WantedBy=default.target
   |
   | [X-Lazurio]
   | Folder=/home/admin/Lazurio
   | # Written by `lazurio install`; rewritten by it, so edit a drop-in instead.
   | [Unit]
   | Description=Lazurio rollback of an interrupted activation
   |
   | [Service]
   | Type=oneshot
   | ExecStart=/home/admin/.local/share/lazurio/previous/lazurio update rollback --auto --base /home/admin/.local/share/lazurio
   PASS  unit enabled: enabled
   PASS  Launchpad active; the kernel runs versions/1.0.0/lazurio through the selector; health socket present
   PASS  no high-water mark yet: the floor is the active version:
   took 1.9 s

== 2. A -> B (1.0.0 -> 1.1.0): attested release, restart, health at the new version, commit ==
   latest -> v1.1.0
   PASS  update --check exit status (10 = available): 10
   > {"kind":"updated","from":"1.0.0","to":"1.1.0","restartRequired":false}
   > exit=0
   PASS  result: updated
   PASS  selector: 1.1.0
   PASS  previous: 1.0.0
   PASS  high-water raised at commit: 1.1.0
   PASS  marker deleted by the commit:
   PASS  Launchpad active on 1.1.0 (pid 1278 -> 1372)
   PASS  systemd-analyze verify accepts both units (exit status): 0
   $ lazurio --version
   > lazurio 1.1.0 (commit 665fa744755bf036d98aabe6c7c00725e0df2760, target linux-arm64) FIXTURE BUILD: not a release
   took 0.8 s

== 3. failed B (1.2.0 refused at start): automatic switch-back within the health deadline ==
   latest -> v1.2.0
   > {"kind":"error","code":"activation-failed","context":{"from":"1.1.0","to":"1.2.0"}}
   > exit=1
   PASS  typed error: activation-failed
   PASS  exit status: exit=1
   PASS  selector: 1.1.0
   PASS  an undone activation never raised the mark: 1.1.0
   PASS  marker deleted by the undo:
   PASS  Launchpad healthy again on 1.1.0
   rollback unit during that attempt (updater alive, lock held -> it must do nothing):
   | Starting lazurio-rollback.service - Lazurio rollback of an interrupted activation...
   | Interrupted activation: none.
   | Finished lazurio-rollback.service - Lazurio rollback of an interrupted activation.
   PASS  the retry is the same action (check exit 10): 10
   took 0.8 s

== 4. power loss after the switch + crashing 1.2.0 -> OnFailure=lazurio-rollback.service undoes (no updater, no command) ==
   SIGKILL -> updater (pid 1530, <base>/versions/1.1.0/lazurio) right after the switch to 1.2.0
   PASS  no updater is alive
   state: selector=1.2.0 previous=1.1.0 high-water=1.1.0 marker={"from":"1.1.0","to":"1.2.0"}
   PASS  the dead updater left the marker: {"from":"1.1.0","to":"1.2.0"}
   nobody runs any command now; systemd alone is in charge
   PASS  rollback unit switched back, reset the failed unit and restarted it: Launchpad on 1.1.0
   state: selector=1.1.0 previous=1.1.0 high-water=1.1.0 marker=
   PASS  the mark was not raised: 1.1.0
   journal of the rollback unit:
   | Finished lazurio-rollback.service - Lazurio rollback of an interrupted activation.
   | Starting lazurio-rollback.service - Lazurio rollback of an interrupted activation...
   | Interrupted activation: undone.
   | Finished lazurio-rollback.service - Lazurio rollback of an interrupted activation.
   took 1.4 s

== 5a. power loss after the switch to a HEALTHY 1.2.0 — followed by a REAL reboot ==
   SIGKILL -> updater (pid 1723, <base>/versions/1.1.0/lazurio) right after the switch to 1.2.0
   PASS  no updater is alive
   state: selector=1.2.0 previous=1.1.0 high-water=1.1.0 marker={"from":"1.1.0","to":"1.2.0"}
   PASS  selector: 1.2.0
   PASS  the dead updater left the marker: {"from":"1.1.0","to":"1.2.0"}
   PASS  not committed: the mark is still: 1.1.0
   took 0.6 s

NOW: sudo reboot, then run this script with after-reboot. Checks failed so far: 0
```

## Transcript: `after-reboot`

```text
phase after-reboot: target linux-arm64, commit 665fa744755bf036d98aabe6c7c00725e0df2760, systemd 255 (255.4-1ubuntu8.17), 7.0.0-30-generic
linger: yes
uptime: up 0 minutes; boot id 2535a251-3b89-482e-a91a-22f62237ea9d

== 5b. after the reboot: the Launchpad of 1.2.0 started healthy by itself and committed the marker ==
   PASS  marker deleted and mark raised to 1.2.0 without any command
   state: selector=1.2.0 previous=1.1.0 high-water=1.2.0 marker=
   PASS  Launchpad active on 1.2.0 after boot
   system boot: 2026-09-21 23:39
   Launchpad started: Sep 21 23:39:52.745871
   high-water written: 2026-09-21 23:40:07.841000009 +0000  (the Launchpad commits once it outlived its first 15 s)
   update commands run by anyone between the boot and that commit: none (this script started at 23:39:53.418 and only reads until here)
   PASS  previous: 1.1.0
   > running 1.2.0
   > active 1.2.0
   > previous 1.1.0
   > latest known 1.2.0 (checked 2026-09-21T23:39:37.797Z)
   took 14.6 s

== 6. explicit rollback 1.2.0 -> 1.1.0: previous after its own self-check, same restart and health rule ==
   > {"kind":"rolled-back","from":"1.2.0","to":"1.1.0"}
   > exit=0
   PASS  result: rolled-back
   PASS  selector: 1.1.0
   PASS  previous: 1.2.0
   PASS  the version left stays the floor: 1.2.0
   PASS  marker:
   PASS  Launchpad active on 1.1.0
   took 0.6 s

== 7. the floor: no network path goes below the high-water mark; the equal retry is allowed ==
   latest -> v1.1.5
   PASS  latest below the floor is not an update (check exit 0): 0
   > {"kind":"up-to-date","running":"1.1.0","latest":"1.1.5"}
   > exit=0
   PASS  update through latest: up-to-date
   > {"kind":"error","code":"release-invalid","context":{"resource":"version","reason":"below-floor"}}
   > exit=1
   PASS  exact tag below the floor: release-invalid
   PASS  reason: below-floor
   PASS  selector unchanged: 1.1.0
   > {"kind":"updated","from":"1.1.0","to":"1.2.0","restartRequired":false}
   > exit=0
   PASS  equal to the mark, not active: allowed: updated
   PASS  selector: 1.2.0
   PASS  Launchpad active on 1.2.0
   > {"kind":"status","running":"1.2.0","active":"1.2.0","previous":"1.1.0","highWater":"1.2.0","supervised":true,"pending":null,"stateInvalid":null,"lastCheck":{"checkedAt":"2026-09-21T23:40:08.932Z","latest":"1.1.5","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.5"},"updateAvailable":false}
   took 0.7 s

QUALIFIED: every journey passed
```
