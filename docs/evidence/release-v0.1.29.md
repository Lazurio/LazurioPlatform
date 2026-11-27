# Ring 0 and the smoke test of v0.1.29-rc.3, 2026-11-27

`v0.1.29-rc.3` (`1e9d3876`) is the candidate for the final `v0.1.29`. 0.1.29 carries:
- Buddy GEN4's Control Plane skill and a line in his instructions (#1272);
- `<lazurio-buddy>` with the frame of 0248 and the version's frame (#1244);
- the narrowed viewer for a page that runs an Organization's code (#1255);
- the content sync converging after a GitHub Organization rename (#1282, the fix of #1281), with the machine handover's `owner.organization_id` vendored from Machines (#1284);
- a report that can be fixed without asking back, and offering the user once to file their bug or idea (#1275, base-instructions-156);
- Začínáme telling GitHub's used-up rate limit from a missing sign-in (#1224);
- the fake `gh` of the tests giving valid JSON on macOS too (#1278);
- manual and decision register entries (#1263, #1264, #1265, #1270, #1271, #1279, #1280).

**Earlier candidates of 0.1.29:**
- `v0.1.29-rc.1` (`ff5576bd`) was released but never applied.
- `v0.1.29-rc.2` (`81b6e88d`) ran on every Machine of this record, but its record (#1285) was closed. Its stage's start-edge readings came 48 minutes after the last Machine ran it, while the definition of `start` asks for them at that moment.
- rc.3 is rc.2 plus #1279, cut so that the stage starts with readings right after the last Machine runs the candidate.

The canary stage ran on 2026-11-27 from 17:56:22Z to 18:04:09Z, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green.

The record is [`qualification/canary/v0.1.29-rc.3.json`](../../qualification/canary/v0.1.29-rc.3.json), added by the same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station, so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.29` is tagged only on the release owner's approval in the `release` environment, on a commit whose tree is `1e9d3876`'s outside `qualification/` and `docs/evidence/`. The Brain transfer test of a candidate that changes Buddy is another release-owner gate before it, recorded outside this file.

## The candidate

- Tag `v0.1.29-rc.3` at `1e9d38761c9e46033ec8a236511dac116b724f02`, release run 46030939288 (success), prerelease published 2026-11-27T16:21:10Z.
- linux-x64: sha256 `dd36fcae…`, 103 175 648 B. `lazurio.sigstore.json`: sha256 `c207154b…`, 11 553 B.
  - All three binaries were checked on the downloaded files against `manifest.json`.
  - `gh attestation verify` with that bundle, bound to `.github/workflows/release.yml` at the tag, accepts the manifest, each binary, `install.sh` and the shell archive.
- Qualification `qualify.yml` run 46032895092 (artifact `qualification-v0.1.29-rc.3` for the candidate's published bytes): success.
- The push run of `1e9d3876` on `main` (45996651476) is green on its first attempt, both macOS shards included.

## Scope and how each Machine got the candidate

- **One personal VM**, the Owner test account's Personal Environment, got it first from its own lane (LazurioExampleOrganization/infra#458). It was applied 17:02:03–17:11:28Z from the station, `success` and `conformant`, and only its two earlier `unknown` checks stayed open.
- **The four Environments of the pilot Organization** on its tailnet host got it from LazurioExampleOrganization/infra#459. These are the Owner's and the member's Work Environments, the Team Environment and the Prostředí služeb.
  - The pull request was merged at 17:16:50Z after an independent review on the exact head and a fresh CI Plan (34 actions, 0 deletions, Machines v0.12.274). The lane keeps the Organization's immutable GitHub id (`resident_bootstrap.organization_id`) from #457.
  - Its push run (46040569121) applied it from 17:17:25Z, `success`, `healthy` and `conformant` with no failed check, ending at **17:56:22Z**. That was the last time a Machine in scope got the candidate, and it is the start of the stage.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal Environment.
  - The member's Personal Environment was read at both edges: `healthy`. It runs and has active **`0.1.24`**, with `/health` answering `0.1.24`, because no lane moves it to a candidate, as for `v0.1.25` to `v0.1.28`.
  - Its two readings (17:57:48Z and 18:03:48Z) are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. The thread waited on the push run and started the stage when it ended, with no other work on the pilot Organization in between. Both personas were free and were held by this thread for the stage.

1. **R1, the start edge, readings 17:56:55–17:58:09Z,** 33 s after the last apply ended. Every Machine was read through its own Launchpad, as the test accounts:
   - `/api/recovery`, which is the use case of `lazurio recover --json`, and `/api/update/status`;
   - the `launchpad-health` check of `/api/recovery`, which carries the `version` that the Launchpad's own `GET /health` answered on its health socket at that moment.

   A step passes only when `recover` is healthy, `running` and `active` are the candidate, and that `/health` version is the candidate. No Launchpad was in recovery mode. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 17:58:09–17:58:19Z,** a Machine this lane updated, over its operator SSH entry:
   - `lazurio --version`: `0.1.29-rc.3`, commit `1e9d3876`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as for `0.1.24` to `0.1.28`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - **`suite both`, 17:58:19–17:59:26Z:** 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy does not reach the Owner test account's Personal Environment, as before.
   - **The main path as the Owner and the member, 17:59:26–18:01:27Z:** 19 of 19 required steps passed.
     - Knowledgebase and Design system were started from their tiles.
     - The chat answered on both Work Environments.
     - The Marketplace's Mission Control detail answered.
     - Two optional steps failed: `marketplace` for each account. The station's script for this step expects the registry of 2026-11-24. The Marketplace answered HTTP 200 with 8 templates in newer versions, so it is the script's expectation that is out of date, not the candidate.
   - **The tiles on every Environment each account lists, 18:01:27–18:03:07Z:** 12 of 12 required and 10 of 10 optional passed.
4. **R2, the end edge, readings 18:03:07–18:04:08Z.** The same readings, `/health` included, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (18:04Z).
6. **End:** `2026-11-27T18:04:09Z`, the green light.

### Per Machine

At both edges, R1 (start) and R2 (end):
- `recover` answered `healthy` with all five checks `ok`;
- `update status` answered running and active `0.1.29-rc.3`;
- the Launchpad's own `GET /health` answered `0.1.29-rc.3` in normal mode;
- the Launchpad unit's `NRestarts` was 0 at both edges, so it did not grow during the stage. On the Owner's Work Environment the count at R2 is the one after its deliberate restart in step 2.

T3 Code is not part of this candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 17:57:19Z | 18:03:21Z | healthy / healthy | 0.1.29-rc.3 / 0.1.29-rc.3 | 0.1.29-rc.3 / 0.1.29-rc.3 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 17:57:24Z | 18:03:26Z | healthy / healthy | 0.1.29-rc.3 / 0.1.29-rc.3 | 0.1.29-rc.3 / 0.1.29-rc.3 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 17:57:52Z | 18:03:52Z | healthy / healthy | 0.1.29-rc.3 / 0.1.29-rc.3 | 0.1.29-rc.3 / 0.1.29-rc.3 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 17:57:57Z | 18:03:57Z | healthy / healthy | 0.1.29-rc.3 / 0.1.29-rc.3 | 0.1.29-rc.3 / 0.1.29-rc.3 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 17:57:15Z | 18:03:17Z | healthy / healthy | 0.1.29-rc.3 / 0.1.29-rc.3 | 0.1.29-rc.3 / 0.1.29-rc.3 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261127.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path, notably the Control Plane skill in use by Buddy and the rename fix after a rename. Their acceptance is outside this record.
