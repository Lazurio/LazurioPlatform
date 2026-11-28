# Ring 0 and the smoke test of v0.1.30-rc.1, 2026-11-28

`v0.1.30-rc.1` (`8f68a833`) is the candidate for the final `v0.1.30`. 0.1.30 is the final 0.1.29 plus two fixes. The release owner reported both bugs on the morning of 2026-11-28 and asked for the fixes:
- **#1294:** the frame of the place is drawn only once the account says who views, and none is drawn on Buddy's own page.
  - On 0.1.29, every person's own Work and Personal Environment showed a red frame with their own name while the page loaded.
  - Where the account could not be read, that frame stayed.
  - Buddy's window stayed red.
- **#1295:** Začínáme no longer sends the tour back to Buddy's step for names that are confirmed but still owed to `~/Buddy`.

`v0.1.30-rc.1` is the first candidate of 0.1.30.

The canary stage ran on 2026-11-28 from 11:39:56Z to 11:48:50Z, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green.

The record is [`qualification/canary/v0.1.30-rc.1.json`](../../qualification/canary/v0.1.30-rc.1.json), added by the same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station, so every Machine keeps the id it had there.

**This record is not a release.** After this record merges, the final `v0.1.30` is tagged on a commit whose tree is `8f68a833`'s outside `qualification/` and `docs/evidence/`. The tag starts `release.yml`, and its publication waits for the release owner's approval in the `release` environment (`docs/update.md`, "Publishing").

**The Brain transfer test.** It is the release owner's gate for a candidate that changes Buddy. 0.1.30 changes neither Buddy's skill nor his instructions: the frame and Začínáme are the shell's and the Launchpad's. So this record runs no transfer test, as the final 0.1.29 (#1293) did not either, which relied on the release owner's decision of 2026-11-27 19:12Z.

## The candidate

- Tag `v0.1.30-rc.1` at `8f68a833575748b8bd2fd402a17642b2e92b05b4`, release run 46135067605 (success), prerelease published 2026-11-28T10:34:05Z.
- linux-x64: sha256 `4732095d…`, 103 179 744 B. `lazurio.sigstore.json`: sha256 `77b9f9fb…`, 11 557 B.
  - All three binaries were checked on the downloaded files against `manifest.json`.
  - `gh attestation verify` with that bundle, bound to `.github/workflows/release.yml` at the tag, accepts the manifest, each binary, `install.sh` and the shell archive.
- Qualification `qualify.yml` run 46135798851 (artifact `qualification-v0.1.30-rc.1` for the candidate's published bytes): success.
- The push run of `8f68a833` on `main` (46132265500) is green on its third attempt.
  - The Linux jobs were green on every attempt.
  - `macOS tests (1/2)` failed on attempt 1 on #1229 and on attempt 2 on #1170. Both are known timing flakes, a different one each run (#1231).
  - The candidate was tagged after attempt 2. Its own qualification runs the tests on both platforms over the published bytes.

## Scope and how each Machine got the candidate

- **One personal VM**, the Owner test account's Personal Environment, got it first from its own lane (LazurioExampleOrganization/infra#465), on Machines v0.12.274 since #462.
  - The pull request was merged at 10:59:31Z after an independent review on the exact head and a fresh Plan-only.
  - It was applied 10:59:52–11:08:59Z from the station, `success` and `conformant`. Only its two earlier `unknown` checks stayed open.
- **The four Environments of the pilot Organization** on its tailnet host got it from LazurioExampleOrganization/infra#466: the Owner's and the member's Work Environments, the Team Environment and the Prostředí služeb.
  - The pull request was merged at 11:10:22Z after an independent review on the exact head and a CI Plan current on it (34 actions, 0 deletions, Machines v0.12.274).
  - Its push run (46138610679) applied it from 11:10:55Z, `success`, ending at **11:39:56Z**. That was the last time a Machine in scope got the candidate, and it is the start of the stage.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal Environment.
  - The member's Personal Environment was read at both edges: `healthy`. It runs and has active **`0.1.24`**, with `/health` answering `0.1.24`, because no lane moves it to a candidate, as for `v0.1.25` to `v0.1.29`.
  - Its two readings (11:41:10Z and 11:48:26Z) are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. A unit at the station waited on the push run and started the stage when it ended, with no other work on the pilot Organization in between. A change of sign-in that was ready (Lazurio/infra#189) was held until the stage ended. Both personas were held by this thread for the stage.

1. **R1, the start edge, readings 11:40:19–11:41:32Z,** 23 s after the last apply ended. Every Machine was read through its own Launchpad, as the test accounts:
   - `/api/recovery`, which is the use case of `lazurio recover --json`, and `/api/update/status`;
   - the `launchpad-health` check of `/api/recovery`, which carries the `version` that the Launchpad's own `GET /health` answered on its health socket at that moment.

   A step passes only when `recover` is healthy, `running` and `active` are the candidate, and that `/health` version is the candidate. No Launchpad was in recovery mode. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 11:41:33–11:41:43Z,** a Machine this lane updated, over its operator SSH entry:
   - `lazurio --version`: `0.1.30-rc.1`, commit `8f68a833`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as for `0.1.24` to `0.1.29`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - **`suite both`, 11:41:43–11:42:47Z:** 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy does not reach the Owner test account's Personal Environment, as before.
   - **The main path as the Owner and the member, 11:42:47–11:44:49Z:** 19 of 19 required steps passed.
     - Knowledgebase and Design system were started from their tiles.
     - The chat answered on both Work Environments.
     - The Marketplace's Mission Control detail answered.
     - Two optional steps failed: `marketplace` for each account. The station's script for this step expects the registry of 2026-11-24. The Marketplace answered HTTP 200 with 8 templates in newer versions, so it is the script's expectation that is out of date, not the candidate.
   - **The tiles on every Environment each account lists, 11:44:49–11:46:32Z:** 12 of 12 required and 10 of 10 optional passed.
   - **The frame as the Owner test account, 11:46:32–11:47:40Z:** 12 of 12 required steps passed. A watcher installed before each page's first script recorded every frame the page drew, every 25 ms and on every change, for 6 s after the load:
     - its own Work Environment and its own Personal Environment showed no frame at any moment;
     - the same two Environments showed no frame at any moment while every read of the account was blocked in the browser;
     - its own Buddy's page showed no frame at any moment;
     - the Prostředí služeb showed a blue frame labelled with its name from 642 ms on, and never a red one.

     The same check on `v0.1.29-rc.4` (2026-11-28 09:50Z), the code of the final 0.1.29, caught the bug in all three forms:
     - while the page loaded, a red frame with the account's own name, on the Work Environment from 0.47 s to 3.6 s;
     - a permanent red frame while the account could not be read;
     - a permanent red frame on Buddy's page.
4. **R2, the end edge, readings 11:47:40–11:48:48Z.** The same readings, `/health` included, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (11:48Z).
6. **End:** `2026-11-28T11:48:50Z`, the green light.

### Per Machine

At both edges, R1 (start) and R2 (end):
- `recover` answered `healthy` with all five checks `ok`;
- `update status` answered running and active `0.1.30-rc.1`;
- the Launchpad's own `GET /health` answered `0.1.30-rc.1` in normal mode;
- the Launchpad unit's `NRestarts` was 0 at both edges, so it did not grow during the stage. On the Owner's Work Environment the count at R2 is the one after its deliberate restart in step 2.

T3 Code is not part of this candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 11:40:37Z | 11:47:57Z | healthy / healthy | 0.1.30-rc.1 / 0.1.30-rc.1 | 0.1.30-rc.1 / 0.1.30-rc.1 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 11:40:42Z | 11:48:01Z | healthy / healthy | 0.1.30-rc.1 / 0.1.30-rc.1 | 0.1.30-rc.1 / 0.1.30-rc.1 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 11:41:15Z | 11:48:30Z | healthy / healthy | 0.1.30-rc.1 / 0.1.30-rc.1 | 0.1.30-rc.1 / 0.1.30-rc.1 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 11:41:19Z | 11:48:35Z | healthy / healthy | 0.1.30-rc.1 / 0.1.30-rc.1 | 0.1.30-rc.1 / 0.1.30-rc.1 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 11:40:33Z | 11:47:52Z | healthy / healthy | 0.1.30-rc.1 / 0.1.30-rc.1 | 0.1.30-rc.1 / 0.1.30-rc.1 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261127.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- The Začínáme fix (#1295) in use. The test accounts have no confirmed names still owed to `~/Buddy`, so the main path does not reach that case; its acceptance is outside this record.
- The frame on a Team Environment, which the Owner test account does not list, on another person's Environment as its viewer, and on a DEV page.
