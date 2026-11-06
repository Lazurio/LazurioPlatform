# Ring 0 and the smoke test of v0.1.21-rc.1, 2026-11-05

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.21-rc.1` (source `d1d8917cdf1afdf49c5091115ca9d615abc0c376`) runs on every Environment of the
pilot Organization, LazurioExampleOrganization, after one apply. A smoke test as its test accounts, its Owner and a
member, passed on 2026-11-05 between 10:27:36Z and 10:30:05Z.

**This is not a canary record yet.** The stage of [the release cycle](../release-cycle.md#qualification-and-the-canary)
also needs the candidate on at least one personal VM, and no personal VM runs `v0.1.21-rc.1` yet. So this pull
request adds no `qualification/canary/v0.1.21-rc.1.json`, and the final tag `v0.1.21` waits for that record. The
release owner decides about the final release separately.

v0.1.21 adds to v0.1.20:
- **Root decision 0216, free Environments:** the Platform reads a free Environment's assignment receipt beside its
  handover and creates the Folder in the assigned person's home (#853). Before the assignment it acts for nobody
  and refuses with `machine-assignment-pending`. After a release it refuses with `machine-assignment-released`, and
  for a work person without a linked GitHub account with `machine-assignment-unlinked`. The vendored
  `lazurio.machine.v1` schema now also accepts an auth-sourced handover.
- No Environment of the pilot Organization declares a free Environment. Ring 0 therefore shows that the candidate
  reads the existing handovers unchanged: every Environment came up healthy on it.

## The candidate

- **`main` at `d1d8917c`:** every check passed. The first `check (macos-15)` run
  ([41937302895](https://github.com/Lazurio/LazurioPlatform/actions/runs/41937302895), attempt 1) failed one
  wall-clock test of the Environment browser that #853 does not touch. Its rerun (attempt 2) passed. The flaky test
  is #858.
- **Published:** 2026-11-05 at 09:13:57Z by Release run
  [41999314940](https://github.com/Lazurio/LazurioPlatform/actions/runs/41999314940); tag pushed at 09:03:56Z,
  `release` approved at 09:13:31Z.
- **Assets:** linux-x64 sha256 `d648b517…`, 96 843 232 B; `lazurio.sigstore.json` sha256 `b1b6f7f6…`, 11 612 B.
  `manifest.json` names the same digest and source, and `gh attestation verify` accepts the binary as signed by
  `release.yml` at `refs/tags/v0.1.21-rc.1`.

## Qualification

- **The first run failed for a reason outside the candidate.** Qualify run
  [42000690241](https://github.com/Lazurio/LazurioPlatform/actions/runs/42000690241) started six seconds after
  publishing. J1 and J2 on both targets and J5 on `macos-15` failed between 09:14:36Z and 09:15:20Z. In each case
  GitHub answered HTTP 504 for the new release's assets (`network-unavailable`, `httpStatus` 504). J1 hashed that
  error page as `install.sh`. J3, J4 and J6 passed. At 09:25Z the tag served `install.sh` and `manifest.json`
  byte-identical to the attested assets. The harness gap is #857.
- **The documented rerun passed:** run [42002257328](https://github.com/Lazurio/LazurioPlatform/actions/runs/42002257328)
  (`workflow_dispatch` with the tag, from the default branch), J1–J6 on `ubuntu-24.04` and `macos-15`. It left the
  artifact `qualification-v0.1.21-rc.1`.

## How the pilot Organization got the candidate

- **The five Environments,** all on one virtualization host's lane, got the candidate in one apply.
  LazurioExampleOrganization/machines#242 changed only the Platform pins of the five guests; Machines v0.12.215
  stayed. Its CI Plan (30 actions, 0 deletions, the same set as v0.1.20's apply) was committed unchanged and found
  current. Pablo approved the exact head. It was merged at 09:44:57Z, after a check that no other rollout ran on the
  lane. Its push run [42004936851](https://github.com/LazurioExampleOrganization/machines/actions/runs/42004936851)
  applied it 09:45:11–10:27:15Z: `success`, completion `installation-complete-acceptance-pending`, Permit
  `mp_da64d2e4…`, evidence on `machines-evidence-v1` at `9e0e80be`.
- **Out of the smoke test's reach:** the public Environment for visitors, as for v0.1.19 and v0.1.20 (decision
  0166, addendum of 2026-11-03). It got the same candidate in the same apply, but no test account is admitted there.

## The smoke test

Done by one thread from the release station, read-only apart from the sign-ins. Each persona ran in a fresh
headless profile of its own (Chromium headless shell 148.0.7778.96), never in an Environment's browser.

1. **Quiet check, 10:27:34Z:** no rollout run in progress, queued or waiting in the pilot Organization's
   Deployment Repo.
2. **The standard suite as the Owner and the member** (skill `lazurio-example-smoke-test`, `suite both`),
   10:27:36–10:28:38Z: **17 of 17 required steps passed**, 2 optional INCONCLUSIVE. The two are the Owner test
   account's personal VM, whose name does not resolve from the station, and it is not in this record. Passed:
   - GitHub and Lazurio sign-in, the session and the listed Environments;
   - each own and listed Environment opened, and `/.lazurio/shell.json` names it;
   - the member is refused with 403 by the gateway of each of the Owner's Environments;
   - sign-out proven, GitHub sign-out, and a new sign-in asks again.
3. **The main path as the Owner and the member,** 10:28:43–10:30:05Z: **16 of 16 required steps passed**, 15
   optional passed.
   - **Readings on every Environment in reach,** through its own Launchpad as the test account:
     `/api/update/status` answered running and active `0.1.21-rc.1`. `/api/recovery` answered `healthy` with all
     five checks `ok`: `update-state-invalid`, `folder-state`, `self-check-failed`, `launchpad-unit` and
     `launchpad-health`. This covers both Work Environments, the Team Environment and the Prostředí služeb.
   - **The Launchpad's Apps:** 5 module links on each Work Environment (T3 Code, MausBot, Knowledgebase, Design
     system, Mission Control) and 2 on the Team Environment and the Prostředí služeb (T3 Code, MausBot), the same
     as on `v0.1.20-rc.3`.
   - **Modules opened from their tiles,** each with HTTP 200 on the module's own origin and its own heading:
     Knowledgebase on both Work Environments (about 4–5 s) and T3 Code on the Team Environment.
   - **Settings → Připojení** on every Environment in reach: the page and `/api/connections` answer 200.
4. **One observation, checked again:** the Owner's first opening of the Knowledgebase after the apply showed its
   page without styles in the screenshot. The member's opening a minute later was styled. A second opening by the
   Owner at 10:30:48–10:31:12Z loaded both stylesheets with HTTP 200, with no failed request and the theme's font
   applied. It did not recur, and the Platform does not serve the module's assets, so it is not counted against the
   candidate.

- **Recovery issues: none.** At 10:31Z, `label:recovery "0.1.21-rc.1"` found 0 issues.

## Not verified

- **A personal VM on the candidate,** which the canary record requires. The final tag waits for it.
- **The free-Environment path itself** (a receipt that names a person, the Folder created at the assignment). No
  Environment in Ring 0 declares a free Environment. It is covered by `tests/free-environment-handover.test.ts`,
  which passed on `main` on Linux and macOS.
- Which AI provider the Environments use; the main path did not open a chat this time.
