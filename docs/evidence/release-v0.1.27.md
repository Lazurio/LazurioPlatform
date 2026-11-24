# Ring 0 and the smoke test of v0.1.27-rc.2, 2026-11-24

`v0.1.27-rc.2` (`659c1d42`) is the candidate for the final `v0.1.27`. 0.1.27 carries #1228, the fix of #1227: a Work
Environment writes `Host <id>` routes for the peers its handover assigns, beside the routes of the home access service.
It also carries #1225 (the memory moves to its pin after an update, #1214), #1213 (on macOS a reader of the
Organization's files retries an open that fails during the copy switch, #1211), #1204, #1202 and #1210. `v0.1.27-rc.1`
(`4f4aedea`) was never released: its release run was rejected and rc.2 replaces it. The canary stage ran on 2026-11-24
from 11:29:31Z to 11:40:39Z, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green.

The record is [`qualification/canary/v0.1.27-rc.2.json`](../../qualification/canary/v0.1.27-rc.2.json), added by the
same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station,
so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.27` is tagged only on the release owner's approval in the `release`
environment. Its tree is `659c1d42`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is
this record's merge, as for `v0.1.20` to `v0.1.26`. `main` carries later changes (#1232, #1167, #1234 and others); the
release commit does not.

## The candidate

- Tag `v0.1.27-rc.2` at `659c1d42abd4710cb2a6c54a420cffae2894d086`, release run 45328580893 (success), prerelease
  published 2026-11-24T05:10:10Z.
- linux-x64: sha256 `2687b68b…`, 103 036 384 B. `lazurio.sigstore.json`: sha256 `c8b29d20…`, 11 698 B. All three
  binaries were checked on the downloaded files against `manifest.json`, and `gh attestation verify` with that bundle,
  bound to `.github/workflows/release.yml` at the tag, accepts the manifest, each binary, `install.sh` and the shell
  archive.
- Qualification `qualify.yml` run 45331396285 (artifact `qualification-v0.1.27-rc.2` for the candidate's published
  bytes): success, J1 to J6 on Linux and macOS.
- The push run of `659c1d42` on `main` (45319789529) is green in its third attempt, both macOS shards included. Its
  first two attempts failed on two different timing-sensitive macOS tests outside this release's changes, #1229 and
  #1230; the unreliability of the macOS shards is #1231. A manual run on the identical tree (`0f7bf5d5`, run
  45315135013) passed in full.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb) got it from LazurioExampleOrganization/infra#438. The
  pull request was merged at 10:53:04Z after an independent review on the exact head and a fresh CI Plan (34 actions,
  0 deletions, Machines v0.12.269). Its push run (45378981040) applied it from 10:53:39Z, `success` and `conformant`
  with 134 of 134 readback checks passing, ending at **11:29:31Z**. That was the last time a Machine in scope got the
  candidate, and it is the start of the stage.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane
  (LazurioExampleOrganization/infra#437), applied 10:33:55–10:50:54Z from the station, `success` and `conformant`; only
  its two earlier `unknown` checks stayed open.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal
  Environment. The member's Personal Environment was read at both edges: `healthy`, all five `recover` checks `ok`, but
  running and active **`0.1.24`**, with `/health` answering `0.1.24`, because no lane moves it to a candidate, as for
  `v0.1.25` and `v0.1.26`. Its two readings (11:34:31Z and 11:40:22Z) are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. Both personas were free at the start and
were held by this thread from the end of the apply to the end of the stage.

1. **R1, 11:33:39–11:34:41Z.** Every Machine through its own Launchpad, as the test accounts: `/api/recovery`, which is
   the use case of `lazurio recover --json`, and `/api/update/status`. The `launchpad-health` check of `/api/recovery`
   carries the `version` that the Launchpad's own `GET /health` answered on its health socket at that moment
   (`src/recover/observe.ts`, `askHealth`). A step passes only when `recover` is healthy, `running` and `active` are the
   candidate, and that `/health` version is the candidate. No Launchpad was in recovery mode: none of the readings was
   entered. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 11:34:48–11:34:58Z,** a Machine this lane updated, over its operator
   SSH entry:
   - `lazurio --version`: `0.1.27-rc.2`, commit `659c1d42`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as
     for `0.1.24` to `0.1.26`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 11:34:49Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - `suite both`, from 11:34:58Z: 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the
     member's proxy does not reach the Owner test account's Personal Environment, as for `v0.1.26`;
   - the main path as the Owner and the member, from 11:36:04Z: 19 of 19 required and 14 of 14 optional passed. The
     Marketplace, Připojení and the chat on both Work Environments are included;
   - the tiles on every Environment each account lists, from 11:37:56Z: 12 of 12 required and 10 of 10 optional passed.
     Both accounts' sign-out went through the realm's confirmation page in about 2.3 s, and the session answered 401
     afterwards.
4. **R2, 11:39:37–11:40:32Z.** The same readings, `/health` included, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (11:40Z).
6. **End:** `2026-11-24T11:40:39Z`, the green light.

### Per Machine

At both edges, `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.27-rc.2`, the Launchpad's own `GET /health` answered `0.1.27-rc.2` in normal mode, and the Launchpad unit's
`NRestarts` was 0. On the Owner's Work Environment this is the count after its restart in step 2. The `/health` column
is that answer at each edge. T3 Code is not part of this candidate; its version is recorded only so that a change can be
told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 11:34:03Z | 11:39:56Z | healthy / healthy | 0.1.27-rc.2 / 0.1.27-rc.2 | 0.1.27-rc.2 / 0.1.27-rc.2 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 11:34:08Z | 11:40:00Z | healthy / healthy | 0.1.27-rc.2 / 0.1.27-rc.2 | 0.1.27-rc.2 / 0.1.27-rc.2 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 11:34:37Z | 11:40:27Z | healthy / healthy | 0.1.27-rc.2 / 0.1.27-rc.2 | 0.1.27-rc.2 / 0.1.27-rc.2 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 11:34:41Z | 11:40:32Z | healthy / healthy | 0.1.27-rc.2 / 0.1.27-rc.2 | 0.1.27-rc.2 / 0.1.27-rc.2 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 11:33:58Z | 11:39:51Z | healthy / healthy | 0.1.27-rc.2 / 0.1.27-rc.2 | 0.1.27-rc.2 / 0.1.27-rc.2 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261121.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

The Plan of infra#438 had shown changed observed evidence on the Owner's Work Environment before the apply. At both
edges of this stage it runs and has active `0.1.27-rc.2`, so the apply left it on the candidate.

## Not verified

- Safari, Firefox and a phone.
- #1228 on a Work Environment whose handover assigns a peer of another Organization: no Environment of the pilot
  Organization has one. It is verified on such an Environment after the release, with `lazurio doctor --routes` and
  `ssh <id> true`.
- The candidate's other changes beyond the main path and the acceptances named above.
