# Ring 0 and the smoke test of v0.1.29-rc.2, 2026-11-27

`v0.1.29-rc.2` (`81b6e88d`) is the candidate for the final `v0.1.29`. 0.1.29 carries:
- Buddy GEN4's Control Plane skill and a line in his instructions (#1272);
- `<lazurio-buddy>` with the frame of 0248 and the version's frame (#1244);
- the narrowed viewer for a page that runs an Organization's code (#1255);
- the content sync converging after a GitHub Organization rename (#1282, the fix of #1281), with the machine handover's `owner.organization_id` vendored from Machines (#1284);
- a report that can be fixed without asking back, and offering the user once to file their bug or idea (#1275, base-instructions-156);
- Začínáme telling GitHub's used-up rate limit from a missing sign-in (#1224);
- the fake `gh` of the tests giving valid JSON on macOS too (#1278);
- manual and decision register entries (#1263, #1264, #1265, #1270, #1271, #1280).

`v0.1.29-rc.1` (`ff5576bd`) was released but never applied anywhere. rc.2 replaces it, because 0.1.29 carries the rename fix.

The canary stage ran on 2026-11-27 from 15:50:28Z to 15:57:17Z, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green. It starts with the R1 readings, which give every Machine's start edge (`recover` healthy and the Launchpad's `NRestarts`). It does not start at the end of the last apply (15:02:15Z): a rename test on the pilot Organization held the window in between, and no reading of that time is part of this record.

The record is [`qualification/canary/v0.1.29-rc.2.json`](../../qualification/canary/v0.1.29-rc.2.json), added by the same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station, so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.29` is tagged only on the release owner's approval in the `release` environment.
- **Its tree:** `81b6e88d`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is this record's merge, as for `v0.1.20` to `v0.1.27`. `main` has one later commit (#1279), which the release commit does not take.
- **Other gates:** two more gates of the release owner's decisions apply before the final, and both are recorded outside this file. One is the Brain transfer test of a candidate that changes Buddy. The other is the acceptance of the rename fix.

## The candidate

- Tag `v0.1.29-rc.2` at `81b6e88d4bd5187f6a8344cd8cc4bbb6b0a4f9ce`, release run 45992219898 (success), prerelease published 2026-11-27T11:51:21Z.
- linux-x64: sha256 `8ef6b4af…`, 103 175 648 B. `lazurio.sigstore.json`: sha256 `1d02d95f…`, 12 117 B.
  - All three binaries were checked on the downloaded files against `manifest.json`.
  - `gh attestation verify` with that bundle, bound to `.github/workflows/release.yml` at the tag, accepts the manifest, each binary, `install.sh` and the shell archive.
- Qualification `qualify.yml` run 45993870736 (artifact `qualification-v0.1.29-rc.2` for the candidate's published bytes): success.
- The push run of `81b6e88d` on `main` (45989216757) is green on its first attempt, both macOS shards included.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host got it from LazurioExampleOrganization/infra#457. These are the Owner's and the member's Work Environments, the Team Environment and the Prostředí služeb.
  - The pull request also declares the Organization's immutable GitHub id (`resident_bootstrap.organization_id`). With this candidate, Machines v0.12.274 writes it to their handover as `owner.organization_id`, which the rename fix uses.
  - It was merged at 14:23:58Z after an independent review on the exact head and a fresh CI Plan (34 actions, 0 deletions, Machines v0.12.274).
  - Its push run (46015578121) applied it from 14:24:43Z, `success`, `complete`, `healthy` and `conformant` with no failed check, ending at **15:02:15Z**. That was the last time a Machine in scope got the candidate. The stage starts later, with the R1 readings at 15:50:28Z.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane (LazurioExampleOrganization/infra#452), applied 13:29:40–13:39:33Z from the station, `success` and `conformant`. Only its two earlier `unknown` checks stayed open.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal Environment.
  - The member's Personal Environment was read at both edges: `healthy`. It runs and has active **`0.1.24`**, with `/health` answering `0.1.24`, because no lane moves it to a candidate, as for `v0.1.25` to `v0.1.28`.
  - Its two readings (15:51:12Z and 15:56:55Z) are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. Both personas were free at the start and were held by this thread for the stage, after a rename test on the pilot Organization had ended (15:34Z) and given the window free. Between the end of the apply and the stage, that test renamed the pilot Organization and restored its name. No Machine got a new version in that time, and the stage's start edge below is read after it.

1. **R1, the start edge, readings 15:50:28–15:51:32Z.** Every Machine through its own Launchpad, as the test accounts:
   - `/api/recovery`, which is the use case of `lazurio recover --json`, and `/api/update/status`;
   - the `launchpad-health` check of `/api/recovery`, which carries the `version` that the Launchpad's own `GET /health` answered on its health socket at that moment.

   A step passes only when `recover` is healthy, `running` and `active` are the candidate, and that `/health` version is the candidate. No Launchpad was in recovery mode. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 15:51:32–15:51:42Z,** a Machine this lane updated, over its operator SSH entry:
   - `lazurio --version`: `0.1.29-rc.2`, commit `81b6e88d`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as for `0.1.24` to `0.1.28`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 15:51:33Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - **`suite both`, 15:51:42–15:52:52Z:** 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy does not reach the Owner test account's Personal Environment, as before.
   - **The main path as the Owner and the member, 15:52:52–15:54:40Z:** 19 of 19 required steps passed.
     - Knowledgebase and Design system were started from their tiles.
     - The chat answered on both Work Environments.
     - The Marketplace's Mission Control detail answered.
     - Two optional steps failed: `marketplace` for each account. The station's script for this step expects the registry of 2026-11-24. The Marketplace answered HTTP 200 with 8 templates in newer versions, so it is the script's expectation that is out of date, as in the canary of `v0.1.28-rc.1`, not the candidate.
   - **The tiles on every Environment each account lists, 15:54:40–15:56:14Z:** 12 of 12 required and 10 of 10 optional passed.
4. **R2, readings 15:56:14–15:57:16Z.** The same readings, `/health` included, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (15:57Z).
6. **End:** `2026-11-27T15:57:17Z`, the green light.

### Per Machine

At both edges, R1 (start) and R2 (end):
- `recover` answered `healthy` with all five checks `ok`;
- `update status` answered running and active `0.1.29-rc.2`;
- the Launchpad's own `GET /health` answered `0.1.29-rc.2` in normal mode;
- the Launchpad unit's `NRestarts` was 0 at both edges, so it did not grow during the stage. On the Owner's Work Environment the count at R2 is the one after its deliberate restart in step 2, which systemd counts as a new start, not as an automatic restart.

T3 Code is not part of this candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 15:50:45Z | 15:56:29Z | healthy / healthy | 0.1.29-rc.2 / 0.1.29-rc.2 | 0.1.29-rc.2 / 0.1.29-rc.2 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 15:50:50Z | 15:56:35Z | healthy / healthy | 0.1.29-rc.2 / 0.1.29-rc.2 | 0.1.29-rc.2 / 0.1.29-rc.2 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 15:51:16Z | 15:56:59Z | healthy / healthy | 0.1.29-rc.2 / 0.1.29-rc.2 | 0.1.29-rc.2 / 0.1.29-rc.2 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 15:51:21Z | 15:57:04Z | healthy / healthy | 0.1.29-rc.2 / 0.1.29-rc.2 | 0.1.29-rc.2 / 0.1.29-rc.2 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 15:50:41Z | 15:56:25Z | healthy / healthy | 0.1.29-rc.2 / 0.1.29-rc.2 | 0.1.29-rc.2 / 0.1.29-rc.2 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261127.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path, notably the Control Plane skill in use by Buddy and the rename fix after a rename. Their acceptance is outside this record.
