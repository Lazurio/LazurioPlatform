# Ring 0 and the smoke test of v0.1.29-rc.4, 2026-11-27

`v0.1.29-rc.4` (`bdf86e32`) is the candidate for the final `v0.1.29`. 0.1.29 carries:
- Buddy GEN4's Control Plane skill and a line in his instructions (#1272);
- `<lazurio-buddy>` with the frame of 0248 and the version's frame (#1244). The frame is not drawn on the person's own Environment when that Environment records its owner by GitHub id alone (#1289), and a DEV page without its document is framed blue (#1290);
- the narrowed viewer for a page that runs an Organization's code (#1255);
- the content sync converging after a GitHub Organization rename (#1282, the fix of #1281), with the machine handover's `owner.organization_id` vendored from Machines (#1284). The owner Organization is also read by its id in content status, settings, Composio and tools (#1288, the fix of #1287);
- a report that can be fixed without asking back, and offering the user once to file their bug or idea (#1275, base-instructions-156);
- Začínáme telling GitHub's used-up rate limit from a missing sign-in (#1224);
- the fake `gh` of the tests giving valid JSON on macOS too (#1278);
- manual and decision register entries (#1263, #1264, #1265, #1270, #1271, #1279, #1280).

**Earlier candidates of 0.1.29:**
- `v0.1.29-rc.1` (`ff5576bd`) was released but never applied.
- `v0.1.29-rc.2` (`81b6e88d`) ran on every Machine of this record. Its record (#1285) was closed because its stage's start-edge readings came 48 minutes after the last Machine ran it.
- `v0.1.29-rc.3` (`1e9d3876`) has a green record (#1286, [`qualification/canary/v0.1.29-rc.3.json`](../../qualification/canary/v0.1.29-rc.3.json)). On it the Owner test account saw a red frame on its own Work and Personal Environment. The release owner decided on 2026-11-27 at 19:12Z that a frame appears only on an Environment that is not the viewer's, so the final is cut from rc.4.
- rc.4 is rc.3 plus #1288, #1289 and #1290.

The canary stage ran from 2026-11-27 23:57:40Z to 2026-11-28 00:05:30Z, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green.

The record is [`qualification/canary/v0.1.29-rc.4.json`](../../qualification/canary/v0.1.29-rc.4.json), added by the same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station, so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.29` is tagged only on the release owner's approval in the `release` environment, on a commit whose tree is `bdf86e32`'s outside `qualification/` and `docs/evidence/`.

**The Brain transfer test**, the release owner's gate for a candidate that changes Buddy, is met for 0.1.29 by the release owner's decision of 2026-11-27 19:12Z. That decision accepts the baseline run of 2026-11-26, and a run on Codex is optional and does not hold the final.

## The candidate

- Tag `v0.1.29-rc.4` at `bdf86e328fbfdd0429436ba86c9862660feb7bb3`, release run 46066738573 (success), prerelease published 2026-11-27T21:02:49Z.
- linux-x64: sha256 `1d7f1729…`, 103 179 744 B. `lazurio.sigstore.json`: sha256 `05fbba0e…`, 11 553 B.
  - All three binaries were checked on the downloaded files against `manifest.json`.
  - `gh attestation verify` with that bundle, bound to `.github/workflows/release.yml` at the tag, accepts the manifest, each binary, `install.sh` and the shell archive.
- Qualification `qualify.yml` run 46067682485 (artifact `qualification-v0.1.29-rc.4` for the candidate's published bytes): success.
- The push run of `bdf86e32` on `main` (46061094262) is green. Its first attempt failed one macOS test on a timing condition, the known flake #1229; the rerun of the failed jobs passed, with both macOS shards.

## Scope and how each Machine got the candidate

- **One personal VM**, the Owner test account's Personal Environment, got it first from its own lane (LazurioExampleOrganization/infra#462).
  - The lane also moved this Environment from Machines v0.12.256 to **v0.12.274**. Since the Conglomerate Host's Machine Record names the lane's author, v0.12.256 refuses that record, and no Plan of this lane could be computed without the move. v0.12.274 is what the other lane of this record runs.
  - It was merged at 21:20:51Z after an independent review on the exact head and a fresh Plan-only. It was applied 21:21:01–21:31:15Z from the station, `success` and `conformant`; only its two earlier `unknown` checks stayed open.
- **The four Environments of the pilot Organization** on its tailnet host got it from LazurioExampleOrganization/infra#463: the Owner's and the member's Work Environments, the Team Environment and the Prostředí služeb.
  - The pull request was merged at 23:28:19Z after an independent review on the exact head and a fresh CI Plan (34 actions, 0 deletions, Machines v0.12.274).
  - Its push run (46082673076) applied it from 23:28:48Z, `success`, ending at **23:57:40Z**. That was the last time a Machine in scope got the candidate, and it is the start of the stage.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal Environment.
  - The member's Personal Environment was read at both edges: `healthy`. It runs and has active **`0.1.24`**, with `/health` answering `0.1.24`, because no lane moves it to a candidate, as for `v0.1.25` to `v0.1.28`.
  - Its two readings (23:58:50Z and 00:05:09Z) are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. A unit at the station waited on the push run and started the stage when it ended, with no other work on the pilot Organization in between. Both personas were held by this thread for the stage.

1. **R1, the start edge, readings 23:58:09–23:59:09Z,** 29 s after the last apply ended. Every Machine was read through its own Launchpad, as the test accounts:
   - `/api/recovery`, which is the use case of `lazurio recover --json`, and `/api/update/status`;
   - the `launchpad-health` check of `/api/recovery`, which carries the `version` that the Launchpad's own `GET /health` answered on its health socket at that moment.

   A step passes only when `recover` is healthy, `running` and `active` are the candidate, and that `/health` version is the candidate. No Launchpad was in recovery mode. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 23:59:10–23:59:19Z,** a Machine this lane updated, over its operator SSH entry:
   - `lazurio --version`: `0.1.29-rc.4`, commit `bdf86e32`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as for `0.1.24` to `0.1.29-rc.3`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - **`suite both`, 23:59:19–00:00:21Z:** 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy does not reach the Owner test account's Personal Environment, as before.
   - **The main path as the Owner and the member, 00:00:21–00:02:10Z:** 19 of 19 required steps passed.
     - Knowledgebase and Design system were started from their tiles.
     - The chat answered on both Work Environments.
     - The Marketplace's Mission Control detail answered.
     - Two optional steps failed: `marketplace` for each account. The station's script for this step expects the registry of 2026-11-24. The Marketplace answered HTTP 200 with 8 templates in newer versions, so it is the script's expectation that is out of date, not the candidate.
   - **The tiles on every Environment each account lists, 00:02:10–00:03:43Z:** 12 of 12 required and 10 of 10 optional passed.
   - **The frame as the Owner test account, 00:03:43–00:04:23Z:** 9 of 9 required steps passed.
     - The account's own Work Environment has no frame.
     - Its own Personal Environment has no frame.
     - The Prostředí služeb has a blue frame labelled with its name.

     The same check on rc.3 (2026-11-27 21:15Z) found a red frame on both of the account's own Environments, so this step tells the two candidates apart.
4. **R2, the end edge, readings 00:04:23–00:05:28Z.** The same readings, `/health` included, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (00:05Z).
6. **End:** `2026-11-28T00:05:30Z`, the green light.

### Per Machine

At both edges, R1 (start) and R2 (end):
- `recover` answered `healthy` with all five checks `ok`;
- `update status` answered running and active `0.1.29-rc.4`;
- the Launchpad's own `GET /health` answered `0.1.29-rc.4` in normal mode;
- the Launchpad unit's `NRestarts` was 0 at both edges, so it did not grow during the stage. On the Owner's Work Environment the count at R2 is the one after its deliberate restart in step 2.

T3 Code is not part of this candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 23:58:25Z | 00:04:43Z | healthy / healthy | 0.1.29-rc.4 / 0.1.29-rc.4 | 0.1.29-rc.4 / 0.1.29-rc.4 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 23:58:30Z | 00:04:48Z | healthy / healthy | 0.1.29-rc.4 / 0.1.29-rc.4 | 0.1.29-rc.4 / 0.1.29-rc.4 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 23:58:55Z | 00:05:13Z | healthy / healthy | 0.1.29-rc.4 / 0.1.29-rc.4 | 0.1.29-rc.4 / 0.1.29-rc.4 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 23:58:59Z | 00:05:18Z | healthy / healthy | 0.1.29-rc.4 / 0.1.29-rc.4 | 0.1.29-rc.4 / 0.1.29-rc.4 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 23:58:21Z | 00:04:39Z | healthy / healthy | 0.1.29-rc.4 / 0.1.29-rc.4 | 0.1.29-rc.4 / 0.1.29-rc.4 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261127.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path and the frame, notably the Control Plane skill in use by Buddy and the rename fix after a rename. Their acceptance is outside this record.
- The frame on a Team Environment, which the Owner test account does not list, and on a DEV page.
