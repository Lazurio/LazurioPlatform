# Update qualification on native Linux ARM64 — 2026-09-19

Evidence for [product update](../update.md), "Evidence required before any
Machine depends on this". This is one run of one script on one Machine; it is
not a claim about Linux x64, a hosted canary or a real reboot.

- **Machine:** a disposable local Ubuntu ARM64 virtual machine, user `admin`,
  systemd 255 (`255.4-1ubuntu8.17`), an ext filesystem, a real
  `systemd --user` manager.
- **Source:** commit `fe05ce937427e359acc40f5573a5f01cf2c2eb0e`, clean tree.
  Three REAL product executables (`src/cli.ts`, not the test-only product) that
  differ only in their embedded version — 1.0.0, 1.1.0, 1.2.0 — cross-compiled
  with `--target=bun-linux-arm64`, plus the signed loopback fixture repository
  server, compiled the same way and run on the Machine itself.
- **Reproduce:**

  ```sh
  bun run scripts/qualify-update-linux.ts build --target linux-arm64 --out <absent dir>
  # copy <dir> to the Machine, then ON the Machine:
  bash <dir>/qualify-update-linux.sh <dir>
  ```

  The same two commands with `--target linux-x64` are the hosted canary run.
- **What the run changed on the Machine:** `loginctl enable-linger admin` before
  (it was `no`; the user manager must outlive the login session that starts the
  run) and `disable-linger` after. The script itself works under its own `HOME`
  inside a fresh work directory, puts one unit file into
  `$XDG_RUNTIME_DIR/systemd/user`, and removes both at the end. The user's real
  install base and Folder were not touched.
- **Faults are in the harness, not in the product:** the Launchpad unit has an
  `ExecStartPre`/`ExecStartPost` gate script that, while a fault file says so,
  refuses the Launchpad of 1.2.0 (`e1`) or kills it one second after every
  start (`e2`). `ExecStart` is always the selector `bin/lazurio`.
- **Shortened policy:** `--stability-ms` 5000–8000 and `--deadline-ms`
  12000–90000 instead of the defaults (10 s, 120 s). Resumes — the Launchpad's
  own and `lazurio --version` — ran with the defaults.
- **Duration:** 76 s wall clock for the whole script.

## What the real systemd path needed

Only the last row FAILED in front of us. The first was anticipated and then
reproduced in isolation on the Machine. The three in the middle were found by
reading the design against systemd's semantics before the first native run and
were fixed first, so this run never saw them fail — they are listed because a
reviewer should know they were not observed, only reasoned and unit-tested.

| Finding | How it was found | Resolution |
| --- | --- | --- |
| After a crash-looping service the unit sits in its start limit and systemd refuses even a manual `restart` — exactly when the previous version must come back. | Anticipated; reproduced with a throw-away unit: `restart` exit 1, after `reset-failed` exit 0. Journey `e2` passes with the fix. | The adapter runs `systemctl --user reset-failed <unit>` before every restart; unit-tested as command construction. |
| A transient unit with `Restart=on-failure` restarts a worker that exits non-zero — and a typed refusal such as `activation-failed` (exit 40) is an ANSWER, not a death. It would re-run a failed activation up to the start limit. | Reasoned, not observed. | A worker that answers exits 0; only a dead worker is restarted. |
| A restarted worker finds its own record, treats it as an abandoned one and answers `busy`. | Reasoned, not observed. | A worker adopts its own record (same operation and candidate) and continues under the original deadline; unit-tested; journey `f`. |
| With the worker gone and the Launchpad restarted — a reboot — nobody looks at the record again until a person runs a command; after the deadline that command rolls back a healthy version. | Reasoned, not observed. | The Launchpad keeps looking while a record exists (`watchActivation`), confirms itself after the stability period and undoes the activation past the deadline; unit-tested; journey `g`. |
| Ubuntu's default `umask 002` makes new directories group-writable; the product rightly refuses a group-writable Folder parent, so `folder-init` failed and every later journey with it. | **Observed**: the first native attempt. | Harness: `umask 077`. For the product it is a requirement on the future installer: create its directories `0700` explicitly. |

What held on first contact: `systemd-run --user --collect --wait --pipe`
returns the worker's JSON line to the caller **across a restart of the worker**
(journey `f`: the caller printed `updated` after the worker had been killed and
started again); the worker's control group is its own; `systemctl --user`
works from inside the transient unit with the allow-listed environment; the
`Restart*` and `StartLimit*` properties are accepted by `systemd-run`;
`/proc/<pid>/exe` of a Launchpad started through the selector is the versioned
path, so the readiness digest is the digest of what runs.

## Not covered by this run

A real reboot (only its equivalent: worker unit stopped, Launchpad unit
restarted with the record present); Linux x64; a hosted Machine; module
applications running under the Launchpad; a full disk; an expired timestamp or
a repository advancing mid-update natively (covered in `bun run check` on the
development host only); an installer — version 1.0.0 was laid out by the
script the way the tests do it.

## Transcript

Unedited output of the script except that the work directory is shown as
`<work>`.

```text
target linux-arm64, commit fe05ce937427e359acc40f5573a5f01cf2c2eb0e, systemd 255 (255.4-1ubuntu8.17)
linger: yes

== a. signed fixture repository on loopback, served from this Machine ==
   1.0.0  lazurio 1.0.0 (commit fe05ce937427e359acc40f5573a5f01cf2c2eb0e, target linux-arm64)
   1.1.0  lazurio 1.1.0 (commit fe05ce937427e359acc40f5573a5f01cf2c2eb0e, target linux-arm64)
   1.2.0  lazurio 1.2.0 (commit fe05ce937427e359acc40f5573a5f01cf2c2eb0e, target linux-arm64)
   PASS  three real product executables run natively
   took 0.6 s

== b. install 1.0.0 the way an installer would: versions/<name> + the selector ==
   PASS  version through the selector: 1.0.0
   took 0.2 s

== c. the Launchpad as a systemd user service whose ExecStart is the selector ==
   PASS  readiness announced: digest of 1.0.0, pid 9560 = MainPID
   i. ExecStart is the selector; the kernel runs: <base>/versions/1.0.0+be87222e8dc6f710/lazurio
   PASS  i. the running executable is the versioned path, not the selector: <work>/home/.local/share/lazurio/versions/1.0.0+be87222e8dc6f710/lazurio
   took 0.5 s

== d. 1.0.0 -> 1.1.0 under systemd: transient worker outside the Launchpad's control group, fresh stable instance ==
   released 1.1.0 as stable sequence 1 (generation 2)
   worker     lazurio-update-<operation>.service  lazurio-update-<operation>.service
   launchpad  lazurio-qualify-9433.service
   worker runs: <base>/versions/1.0.0+be87222e8dc6f710/lazurio
   PASS  worker has its own control group
   PASS  worker executes the PREVIOUS immutable executable: <work>/home/.local/share/lazurio/versions/1.0.0+be87222e8dc6f710/lazurio
   Restart=on-failure
   NRestarts=0
   > {"kind":"updated","version":"1.1.0","previous":"1.0.0"}
   > exit=0
   PASS  result: updated
   PASS  selector: 1.1.0+b9ae6c6aad93b266
   PASS  Launchpad active on 1.1.0
   PASS  fresh instance: pid 9560 -> 9672, started 2026-09-19T01:53:48.289Z
   PASS  record removed
   PASS  previous.json: 1.0.0+be87222e8dc6f710
   PASS  observation: up-to-date
   took 6.8 s

== e1. 1.2.0 whose Launchpad is refused at start -> automatic rollback to 1.1.0 ==
   released 1.2.0 as stable sequence 2 (generation 3)
   > {"kind":"error","code":"activation-failed","context":{"reason":"restart","rolledBackTo":"1.1.0"}}
   > exit=40
   PASS  typed error: activation-failed
   PASS  exit status: exit=40
   PASS  selector: 1.1.0+b9ae6c6aad93b266
   PASS  Launchpad healthy again on 1.1.0
   PASS  record removed
   observed: status=error code=activation-failed canRetry=true available=1.2.0
   PASS  observed error: activation-failed
   took 0.9 s

== e2. 1.2.0 whose Launchpad starts and is killed, again and again -> deadline, rollback, unit restartable ==
   > {"kind":"error","code":"activation-failed","context":{"reason":"unstable","rolledBackTo":"1.1.0"}}
   > exit=40
   PASS  typed error: activation-failed
   PASS  selector: 1.1.0+b9ae6c6aad93b266
   PASS  Launchpad healthy again on 1.1.0 (after the crash loop)
   PASS  a later check offers the retry (exit 10): 10
   took 26.2 s

== f. kill -9 of the worker while confirming -> systemd restarts it and it finishes ITS record ==
   SIGKILL -> worker (record: confirming)
   NRestarts=1
   > {"kind":"updated","version":"1.2.0","previous":"1.1.0"}
   > exit=0
   PASS  record settled without any command
   PASS  selector: 1.2.0+51b832be54af2d3e
   PASS  Launchpad active on 1.2.0
   PASS  same operation confirmed: a931c63a-7860-4f87-9973-ba7d4539b666
   PASS  previous.json: 1.1.0+b9ae6c6aad93b266
   took 10.4 s

== h. lazurio update rollback 1.2.0 -> 1.1.0 through the same worker path ==
   > {"kind":"rolled-back","version":"1.1.0","from":"1.2.0"}
   > exit=0
   PASS  result: rolled-back
   PASS  selector: 1.1.0+b9ae6c6aad93b266
   PASS  Launchpad active on 1.1.0
   PASS  previous.json: 1.2.0+51b832be54af2d3e
   took 5.8 s

== g. reboot-equivalent: worker gone, Launchpad unit (re)started with a record present -> it settles the record itself ==
   worker unit stopped (a transient unit does not survive a reboot)
   Launchpad unit restarted with record phase=confirming
   PASS  record present, no worker: 0 worker units
   > {"kind":"error","code":"activation-interrupted","context":{"resumed":"in-progress"}}
   > exit=41
   PASS  the Launchpad confirmed itself after its stability period; no command was run
   PASS  selector: 1.2.0+51b832be54af2d3e
   PASS  Launchpad active on 1.2.0
   PASS  observation: up-to-date
   took 10.7 s

== f2. worker AND Launchpad gone past the deadline -> a plain later 'lazurio --version' undoes it ==
   worker and Launchpad stopped; selector names 1.1.0, record phase=confirming
   > {"kind":"error","code":"activation-interrupted","context":{"resumed":"in-progress"}}
   > exit=41
   $ lazurio --version
   > Lazurio undid an interrupted update: 1.2.0+<sha16> is active. Run `lazurio update` to try again.
   > lazurio 1.1.0 (commit fe05ce937427e359acc40f5573a5f01cf2c2eb0e, target linux-arm64)
   PASS  record settled by an ordinary command
   PASS  selector back on the version that was confirmed: 1.2.0+51b832be54af2d3e
   PASS  observed error: activation-interrupted
   PASS  the undo restarted the Launchpad onto 1.2.0
   took 13.6 s

QUALIFIED: every journey passed
script-exit=0
```
