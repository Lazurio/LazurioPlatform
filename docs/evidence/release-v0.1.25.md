# Ring 0 and the smoke test of v0.1.25-rc.4, 2026-11-22

`v0.1.25-rc.4` (`fe129901`) is the candidate for the final `v0.1.25`. Since `rc.3` it carries the GBrain pin
`lazurio.3` (#1189) and the `buddy-brain` skill with the facts Buddy can read back (#1193); the rename #1192 that reached
`main` between them is reverted by #1194, so the candidate's tree has no rename. The canary stage ran on 2026-11-22 from
23:17:51Z to 23:26:38Z in one complete pass, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is
green.

The record is [`qualification/canary/v0.1.25-rc.4.json`](../../qualification/canary/v0.1.25-rc.4.json), added by the
same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station,
so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.25` is tagged only on the release owner's approval in the `release`
environment. Its tree is `fe129901`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is
this record's merge, as for `v0.1.20` to `v0.1.24`. `main` carries #1196 (`docs/decision-register.md`) after the
candidate; the release commit does not.

## The candidate

- Tag `v0.1.25-rc.4` at `fe129901c52c7e481a20636d268590c87ea3ef0f`, release run 45047169046 (success), prerelease
  published 2026-11-22T17:14:50Z.
- linux-x64: sha256 `238021f8…`, 103 003 616 B. `lazurio.sigstore.json`: sha256 `25823cdb…`, 11 847 B. All three
  binaries and the shell archive were checked on the downloaded files against `manifest.json`, and `gh attestation
  verify` with that bundle accepts each of them.
- Qualification `qualify.yml` run 45048359811 on `fe129901`: success.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb) got it from LazurioExampleOrganization/infra#415. The
  pull request was merged at 22:39:11Z after an independent review on the exact head and a fresh CI Plan (`436872cf…`,
  34 actions, 0 deletions, Machines v0.12.267), on the Owner's word for this lane (2026-11-22 20:27Z). Its push run
  applied it, `success` and `conformant` with 129 of 129 readback checks passing, ending at **23:17:51Z**. That was the
  last time a Machine in scope got the candidate, and it is the start of the stage. The `database` service on the
  Prostředí služeb was read before the merge and after the apply by its own thread: not restarted, its data's HEAD
  unchanged, its backup succeeded during the apply.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane
  (LazurioExampleOrganization/infra#414), applied 18:03:49–18:12:58Z. The coordinator's acceptance of Brain's facts ran
  there as the persona (18:26–18:30Z).
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal
  Environment. The member's Personal Environment is reachable through the station's member proxy this time and was read
  at both edges: `healthy`, all five `recover` checks `ok`, `NRestarts` 0, but running and active **`0.1.24`**, because
  no lane moved it to the candidate. Its two readings are the stage's only failed optional steps.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. Both personas were free at the start and
were held by this thread from the end of the apply to the end of the stage.

1. **R1, 23:20:17–23:20:56Z.** Every Machine through its own Launchpad, as the test accounts: `/api/recovery`, which is
   the use case of `lazurio recover --json`, and `/api/update/status`. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 23:21:03–23:21:13Z,** a Machine this lane updated, over its operator
   SSH entry:
   - `lazurio --version`: `0.1.25-rc.4`, commit `fe129901`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as
     for `0.1.24`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 23:21:04Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - `suite both`: 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy
     does not reach the Owner test account's Personal Environment;
   - the main path as the Owner and the member: 19 of 19 required and 14 of 14 optional passed, the Marketplace and
     Připojení included;
   - the tiles on every Environment each account lists: 12 of 12 required and 10 of 10 optional passed.
4. **R2, 23:25:51–23:26:31Z.** The same readings, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (23:26Z).
6. **End:** `2026-11-22T23:26:38Z`, the green light.

### Per Machine

At both edges, `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.25-rc.4`, and the Launchpad unit's `NRestarts` was 0. On the Owner's Work Environment this is the count after its
restart in step 2. The `/health` column is the Launchpad's own `GET /health` at each edge. T3 Code is not part of this
candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 23:20:22Z | 23:25:56Z | healthy / healthy | 0.1.25-rc.4 / 0.1.25-rc.4 | 0.1.25-rc.4 / 0.1.25-rc.4 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 23:20:26Z | 23:26:01Z | healthy / healthy | 0.1.25-rc.4 / 0.1.25-rc.4 | 0.1.25-rc.4 / 0.1.25-rc.4 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 23:20:52Z | 23:26:27Z | healthy / healthy | 0.1.25-rc.4 / 0.1.25-rc.4 | 0.1.25-rc.4 / 0.1.25-rc.4 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 23:20:56Z | 23:26:31Z | healthy / healthy | 0.1.25-rc.4 / 0.1.25-rc.4 | 0.1.25-rc.4 / 0.1.25-rc.4 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 23:20:17Z | 23:25:51Z | healthy / healthy | 0.1.25-rc.4 / 0.1.25-rc.4 | 0.1.25-rc.4 / 0.1.25-rc.4 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261121.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path and the acceptances named above.
