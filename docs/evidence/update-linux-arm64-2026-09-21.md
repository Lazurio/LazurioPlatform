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

## Journey 8 — Launchpad pill, native run 2026-09-22

Source commit `56050c6a3e0f83da3298b4eee70da146410f4c9b` (branch
`claude/DEV-6594-update-pill`), a fresh disposable clone of the same Ubuntu 24.04.4
ARM64 image, systemd 255.4, `Linger=yes`, the two-listener fixture origin plus a
fifth executable 1.3.0 and the attested impostor release `v1.4.0`. Journeys 1–7
ran again first. The harness counts only failures (`FAILED`) and ends the phase
with `QUALIFIED` only when that count is zero; the totals below are `PASS` lines
counted in the two transcripts that follow: `before-reboot` 30, `after-reboot` 84,
of which journey 8 contributes 67, and **0 `FAIL` lines**. A real reboot lies
between the phases.

Entirely through the installed Launchpad's loopback session (`GET
/api/update/status`, `POST /api/update/apply` with the bearer token read from the
service's journal; the harness never calls `lazurio update`):

- 8a. the pill shows what `last-check.json` knows (1.1.5, below the floor: `idle`,
  no action); the poller's own first check, 30 s after the Launchpad started,
  learned 1.3.0 by itself → `available`, action `update`, `checkedAt` 0 s old.
- 8b. the click → `started`; the transient `lazurio-update` unit exists and the
  pill follows it (`downloading`); within 1 s the selector is 1.3.0, the marker is
  gone, the mark is raised, the Launchpad was restarted by the unit (new pid and
  invocation); the unit's journal line is `{"kind":"updated",…}`; the new
  Launchpad answers `idle`, running 1.3.0. The finished transient unit is
  collected.
- 8c. a click naming the version the page showed before (1.2.0) → 409 `stale`
  with what is true now; no unit started; selector unchanged.
- 8d. the impostor `v1.4.0` (attested, downloads, its executable is 1.3.0's):
  a click before the pill knew it → 409 `stale` and the pill re-checked; the
  click → the unit failed; the pill returned to `available` with action `retry`
  and the error read back from that invocation's journal
  (`self-check-failed` / `identity-mismatch`); selector and mark unchanged;
  `versions/1.4.0` removed again; the Launchpad was never restarted; the retry
  click was `started` (not `busy`) with a new invocation, because the apply path
  resets the failed record first.
- 8e. `update/high-water` damaged from outside: the pill shows `stateInvalid`
  with the path and no action; a click → 409 `state-invalid`; nothing switched;
  after the file is restored the pill is back to normal.

Found by the first native run and fixed before this one: systemd 255 rejects
`--collect=no` (`--collect` takes no argument); the click had answered
`internal{stage:systemd-run}` and no unit was ever started. The unit is now
started without `--collect`, whose default keeps a failed unit for the journal
readback.

### Transcript: `before-reboot`

```text
phase before-reboot: target linux-arm64, commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, systemd 255 (255.4-1ubuntu8.17), 7.0.0-30-generic
linger: yes
   lazurio 1.0.0 (commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.1.0 (commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.1.5 (commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.2.0 (commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, target linux-arm64) FIXTURE BUILD: not a release
   lazurio 1.3.0 (commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, target linux-arm64) FIXTURE BUILD: not a release

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
   took 1.8 s

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
   PASS  Launchpad active on 1.1.0 (pid 1284 -> 1380)
   PASS  systemd-analyze verify accepts both units (exit status): 0
   $ lazurio --version
   > lazurio 1.1.0 (commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, target linux-arm64) FIXTURE BUILD: not a release
   took 0.9 s

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
   SIGKILL -> updater (pid 1537, <base>/versions/1.1.0/lazurio) right after the switch to 1.2.0
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
   took 0.4 s

== 5a. power loss after the switch to a HEALTHY 1.2.0 — followed by a REAL reboot ==
   SIGKILL -> updater (pid 1725, <base>/versions/1.1.0/lazurio) right after the switch to 1.2.0
   PASS  no updater is alive
   state: selector=1.2.0 previous=1.1.0 high-water=1.1.0 marker={"from":"1.1.0","to":"1.2.0"}
   PASS  selector: 1.2.0
   PASS  the dead updater left the marker: {"from":"1.1.0","to":"1.2.0"}
   PASS  not committed: the mark is still: 1.1.0
   took 0.6 s

NOW: sudo reboot, then run this script with after-reboot. Checks failed so far: 0
```

### Transcript: `after-reboot`

```text
phase after-reboot: target linux-arm64, commit 56050c6a3e0f83da3298b4eee70da146410f4c9b, systemd 255 (255.4-1ubuntu8.17), 7.0.0-30-generic
linger: yes
uptime: up 0 minutes; boot id 29ce18f7-c6f3-44fb-8966-e6e77d51ceee

== 5b. after the reboot: the Launchpad of 1.2.0 started healthy by itself and committed the marker ==
   PASS  marker deleted and mark raised to 1.2.0 without any command
   state: selector=1.2.0 previous=1.1.0 high-water=1.2.0 marker=
   PASS  Launchpad active on 1.2.0 after boot
   system boot: 2026-09-22 07:45
   Launchpad started: Sep 22 07:46:01.413243
   high-water written: 2026-09-22 07:46:16.527000009 +0000  (the Launchpad commits once it outlived its first 15 s)
   update commands run by anyone between the boot and that commit: none (this script started at 07:46:01.479 and only reads until here)
   PASS  previous: 1.1.0
   > running 1.2.0
   > active 1.2.0
   > previous 1.1.0
   > latest known 1.2.0 (checked 2026-09-22T07:45:54.969Z)
   took 15.2 s

== 6. explicit rollback 1.2.0 -> 1.1.0: previous after its own self-check, same restart and health rule ==
   > {"kind":"rolled-back","from":"1.2.0","to":"1.1.0"}
   > exit=0
   PASS  result: rolled-back
   PASS  selector: 1.1.0
   PASS  previous: 1.2.0
   PASS  the version left stays the floor: 1.2.0
   PASS  marker:
   PASS  Launchpad active on 1.1.0
   took 0.7 s

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
   > {"kind":"status","running":"1.2.0","active":"1.2.0","previous":"1.1.0","highWater":"1.2.0","supervised":true,"pending":null,"stateInvalid":null,"lastCheck":{"checkedAt":"2026-09-22T07:46:17.680Z","latest":"1.1.5","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.5"},"updateAvailable":false}
   took 0.7 s

== 8. the Launchpad pill: the click path through GET /api/update/status and POST /api/update/apply on the service's loopback session ==
   latest -> v1.3.0
   PASS  session of the Launchpad (pid 1506, invocation ae6b9d91) read from its journal: http://127.0.0.1:45263
   8a. availability: the pill shows what last-check.json knows; then the poller's own first check learns the new latest
   pill: HTTP 200 {"kind":"update-pill","state":"idle","running":"1.2.0","active":"1.2.0","latest":"1.1.5","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.5","checkedAt":"2026-09-22T07:46:17.680Z","stale":false,"supervised":true,"restartRequired":false,"action":null,"error":null,"stateInvalid":null}
   PASS  state (last check 1.1.5: below the floor, nothing to offer): idle
   PASS  running: 1.2.0
   PASS  supervised: true
   PASS  action: null
   PASS  latest agrees with last-check.json: 1.1.5
   PASS  checkedAt agrees with last-check.json: 2026-09-22T07:46:17.680Z
   no test hook exists: waiting for the poller's first check, ~30 s after this Launchpad started (journey 7 restarted it)
   PASS  the poller learned 1.3.0 by itself, 30 s into the wait
   pill: HTTP 200 {"kind":"update-pill","state":"available","running":"1.2.0","active":"1.2.0","latest":"1.3.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.3.0","checkedAt":"2026-09-22T07:46:48.066Z","stale":false,"supervised":true,"restartRequired":false,"action":"update","error":null,"stateInvalid":null}
   PASS  state: available
   PASS  latest: 1.3.0
   PASS  notesUrl: https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.3.0
   PASS  action: update
   PASS  stale: false
   PASS  last-check.json was written by that check: 1.3.0
   PASS  checkedAt is 0 s old
   8b. the click: POST /api/update/apply starts the transient unit; the Launchpad it restarts answers idle at the new version
   click 1.3.0 -> HTTP 200 {"kind":"started","version":"1.3.0"}
   PASS  HTTP status: 200
   PASS  kind: started
   lazurio-update.service right after the click: load=loaded active=active/running pid=3382 invocation=e9d5b511
   PASS  the transient unit exists: loaded
   PASS  the pill follows the unit: downloading
   PASS  within 30 s (1 s): selector 1.3.0, marker gone, mark raised, Launchpad on 1.3.0 (pid 1506 -> 3460)
   state: selector=1.3.0 previous=1.2.0 high-water=1.3.0 marker=
   PASS  previous: 1.2.0
   PASS  the Launchpad was restarted by the unit (invocation ae6b9d91 -> b288e35b)
   PASS  lazurio-update.service finished: load=not-found active=inactive (a finished transient unit is collected; only a failed one stays)
   journal of lazurio-update.service, invocation e9d5b511:
   | {"kind":"updated","from":"1.2.0","to":"1.3.0","restartRequired":false}
   PASS  its answer in the journal: updated
   PASS  session of the Launchpad (pid 3460, invocation b288e35b) read from its journal: http://127.0.0.1:33345
   pill: HTTP 200 {"kind":"update-pill","state":"idle","running":"1.3.0","active":"1.3.0","latest":"1.3.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.3.0","checkedAt":"2026-09-22T07:46:48.066Z","stale":false,"supervised":true,"restartRequired":false,"action":null,"error":null,"stateInvalid":null}
   PASS  the new Launchpad: state: idle
   PASS  running: 1.3.0
   PASS  active: 1.3.0
   PASS  latest: 1.3.0
   PASS  action: null
   PASS  error: null
   8c. a stale click: the version the page showed is no longer what the last check names
   click 1.2.0 -> HTTP 409 {"kind":"stale","version":"1.2.0","latest":"1.3.0"}
   PASS  HTTP status: 409
   PASS  kind: stale
   PASS  what is true now: 1.3.0
   PASS  no unit was started: inactive
   PASS  selector unchanged: 1.3.0
   8d. a failed candidate: v1.4.0 is attested and downloads, but its executable is 1.3.0's and refuses its self-check
   latest -> v1.4.0
   click 1.4.0 -> HTTP 409 {"kind":"stale","version":"1.4.0","latest":"1.3.0"}
   PASS  not checked yet: refused as stale (and the pill re-checks): 409
   PASS  the stale click made the pill re-check: latest 1.4.0
   pill: HTTP 200 {"kind":"update-pill","state":"available","running":"1.3.0","active":"1.3.0","latest":"1.4.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0","checkedAt":"2026-09-22T07:47:18.768Z","stale":false,"supervised":true,"restartRequired":false,"action":"update","error":null,"stateInvalid":null}
   PASS  state: available
   PASS  action: update
   click 1.4.0 -> HTTP 200 {"kind":"started","version":"1.4.0"}
   PASS  HTTP status: 200
   PASS  the unit failed and stays on record: result=exit-code exit=1
   journal of lazurio-update.service, invocation dff12603:
   | {"kind":"error","code":"self-check-failed","context":{"reason":"identity-mismatch"}}
   pill: HTTP 200 {"kind":"update-pill","state":"available","running":"1.3.0","active":"1.3.0","latest":"1.4.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0","checkedAt":"2026-09-22T07:47:18.768Z","stale":false,"supervised":true,"restartRequired":false,"action":"retry","error":{"code":"self-check-failed","context":{"reason":"identity-mismatch"}},"stateInvalid":null}
   PASS  state: available
   PASS  action: retry
   PASS  error read back from that invocation's journal: self-check-failed
   PASS  reason: identity-mismatch
   PASS  selector unchanged: 1.3.0
   PASS  mark unchanged: 1.3.0
   PASS  marker:
   PASS  what the run placed was removed again (versions/1.4.0): absent
   PASS  the Launchpad was never restarted (pid): 3460
   the retry: the same click while the failed unit is still on record
   click 1.4.0 -> HTTP 200 {"kind":"started","version":"1.4.0"}
   PASS  not busy: HTTP status: 200
   PASS  kind: started
   PASS  a new invocation (dff12603 -> 45f02099): the apply path reset the failed record before the start
   PASS  it failed the same way
   pill: HTTP 200 {"kind":"update-pill","state":"available","running":"1.3.0","active":"1.3.0","latest":"1.4.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0","checkedAt":"2026-09-22T07:47:18.768Z","stale":false,"supervised":true,"restartRequired":false,"action":"retry","error":{"code":"self-check-failed","context":{"reason":"identity-mismatch"}},"stateInvalid":null}
   PASS  action: retry
   PASS  code: self-check-failed
   harness cleanup: reset-failed lazurio-update.service (the product does this before its next start; 8e wants a clean record)
   8e. state-invalid: update/high-water damaged from outside the product
   pill: HTTP 200 {"kind":"update-pill","state":"idle","running":"1.3.0","active":"1.3.0","latest":"1.4.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0","checkedAt":"2026-09-22T07:47:18.768Z","stale":false,"supervised":true,"restartRequired":false,"action":null,"error":null,"stateInvalid":"update/high-water"}
   PASS  the offending path: update/high-water
   PASS  state: idle
   PASS  action: null
   click 1.4.0 -> HTTP 409 {"kind":"error","code":"state-invalid","context":{"path":"update/high-water"}}
   PASS  HTTP status: 409
   PASS  code: state-invalid
   PASS  path: update/high-water
   PASS  no unit was started: inactive
   PASS  selector unchanged: 1.3.0
   pill: HTTP 200 {"kind":"update-pill","state":"available","running":"1.3.0","active":"1.3.0","latest":"1.4.0","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0","checkedAt":"2026-09-22T07:47:18.768Z","stale":false,"supervised":true,"restartRequired":false,"action":"update","error":null,"stateInvalid":null}
   PASS  restored: null
   PASS  mark: 1.3.0
   took 61.8 s

QUALIFIED: every journey passed
```
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
