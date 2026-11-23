# Ring 0 and the smoke test of v0.1.26-rc.1, 2026-11-23

`v0.1.26-rc.1` (`4c3abfeb`) is the candidate for the final `v0.1.26`. 0.1.26 carries #1208, the fix of #1205: a Folder
refresh is never cut off inside its transaction, a prepared transaction an interrupted update left is finished by the
next update with the active version, and on a supervised Linux base the refresh runs as a transient unit that outlives
its caller. It also carries what reached `main` after 0.1.25's candidate: #1196, #1198, #1199, #1185, #1187, #1206 and
#1209. The canary stage ran on 2026-11-23 from 12:29:23Z to 12:39:50Z, including the real work on a Machine
(`docs/recovery-mode.md` G.3). It is green; one required step of the tiles' run failed once and is described below with
its repetition.

The record is [`qualification/canary/v0.1.26-rc.1.json`](../../qualification/canary/v0.1.26-rc.1.json), added by the
same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station,
so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.26` is tagged only on the release owner's approval in the `release`
environment. Its tree is `4c3abfeb`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is
this record's merge, as for `v0.1.20` to `v0.1.25`. `main` carries later changes (#1202, #1204, #1210 and others); the
release commit does not.

## The candidate

- Tag `v0.1.26-rc.1` at `4c3abfeb03900d4ff7ca37710f9b3a602bcc61e3`, release run 45157859474 (success), prerelease
  published 2026-11-23T10:46:52Z.
- linux-x64: sha256 `3109fda3…`, 103 020 000 B. `lazurio.sigstore.json`: sha256 `9bf32163…`, 11 741 B. All three
  binaries and the shell archive were checked on the downloaded files against `manifest.json`, and `gh attestation
  verify` with that bundle accepts each of them.
- Qualification `qualify.yml` run 45159218648 on the default branch (artifact `qualification-v0.1.26-rc.1` for the
  candidate's published bytes): success.

## The fix on the candidate's own binary

Before the stage, on station-01, in a separate home with the candidate installed by `install --verify-release`: a Folder
rendered by 0.1.23 was refreshed by the candidate and that refresh was cut off at its journal's archive (the state of
#1205: every replacement done, the prepared journal left). `lazurio update --version v0.1.26-rc.1` then answered
`up-to-date` with `folderRefresh: refreshed`, the journal was archived as `history/revision-2`, and `lazurio recover`
answered healthy. A journal can only be finished by the version that wrote it: a 0.1.24 journal is refused by the
candidate and finished by 0.1.24 (`profile-resume`), which is how the Environment of #1205 was repaired.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb) got it from LazurioExampleOrganization/infra#431. The
  pull request was merged at 11:56:52Z after an independent review on the exact head and a fresh CI Plan (`af1fc3a6…`,
  34 actions, 0 deletions, Machines v0.12.268). Its push run applied it, `success` and `conformant` with 131 of 131
  readback checks passing, ending at **12:29:23Z**. That was the last time a Machine in scope got the candidate, and it is
  the start of the stage. The `database` service on the Prostředí služeb was read before the merge and after the apply by
  its own thread: not restarted, its data's HEAD unchanged, its backup succeeded after the apply.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane
  (LazurioExampleOrganization/infra#429), applied 11:43:26–11:55:54Z: Lazurio `0.1.26-rc.1`, its Folder refreshed to the
  candidate's template with no pending transaction, `recover` healthy.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal
  Environment. The member's Personal Environment was read at both edges: `healthy`, all five `recover` checks `ok`,
  `NRestarts` 0, but running and active **`0.1.24`**, because no lane moved it to the candidate, as for `v0.1.25`. Its two
  readings are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. Both personas were free at the start and
were held by this thread from the end of the apply to the end of the stage.

1. **R1, 12:30:30–12:31:12Z.** Every Machine through its own Launchpad, as the test accounts: `/api/recovery`, which is
   the use case of `lazurio recover --json`, and `/api/update/status`. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 12:31:18–12:31:28Z,** a Machine this lane updated, over its operator
   SSH entry:
   - `lazurio --version`: `0.1.26-rc.1`, commit `4c3abfeb`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as
     for `0.1.24` and `0.1.25`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 12:31:19Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - `suite both`: 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy
     does not reach the Owner test account's Personal Environment;
   - the main path as the Owner and the member: 19 of 19 required and 14 of 14 optional passed, the Marketplace and
     Připojení included;
   - the tiles on every Environment each account lists, **first run, 12:34:28–12:36:56Z: FAILED**, 10 of 12 required
     passed. The member's sign-out (12:36:01.195–12:36:31.436Z) waited out its 30 s for the "Odhlásit" button on the
     Dashboard's Nastavení → Účet page (`/settings/account`), which showed its own error state ("Nepodařilo se načíst",
     with "Zkusit znovu") instead of the account: the sign-out never reached the identity service (INCONCLUSIVE
     `sign-out`). The following check (12:36:31.456–12:36:53.348Z, 21.9 s for two calls) found the member still signed
     in (FAIL `session-gone`: `/api/dashboard/v1/session` 200, `/api/dashboard/v1/shell` 200, the sign-in not shown).
     The Owner's sign-out in the same run passed in 2.4 s, through the realm's confirmation page. **Repeated at
     12:38:14–12:39:50Z:** 12 of 12 required and 10 of 10 optional passed; both accounts' sign-out took about 2.4 s and
     the session answered 401 afterwards. The Account page is the Dashboard's, deployed apart from this candidate; the
     first run is recorded as what happened, not explained away, and is followed up as an issue of the sign-in
     services. The release owner accepted the canary with the repetition.
4. **R2, 12:37:13–12:37:55Z.** The same readings, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (12:38Z).
6. **End:** `2026-11-23T12:39:50Z`, the green light, after the repeated tiles' run.

### Per Machine

At both edges, `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.26-rc.1`, and the Launchpad unit's `NRestarts` was 0. On the Owner's Work Environment this is the count after its
restart in step 2. The `/health` column is the Launchpad's own `GET /health` at each edge. T3 Code is not part of this
candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 12:30:35Z | 12:37:19Z | healthy / healthy | 0.1.26-rc.1 / 0.1.26-rc.1 | 0.1.26-rc.1 / 0.1.26-rc.1 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 12:30:40Z | 12:37:23Z | healthy / healthy | 0.1.26-rc.1 / 0.1.26-rc.1 | 0.1.26-rc.1 / 0.1.26-rc.1 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 12:31:07Z | 12:37:50Z | healthy / healthy | 0.1.26-rc.1 / 0.1.26-rc.1 | 0.1.26-rc.1 / 0.1.26-rc.1 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 12:31:12Z | 12:37:55Z | healthy / healthy | 0.1.26-rc.1 / 0.1.26-rc.1 | 0.1.26-rc.1 / 0.1.26-rc.1 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 12:30:30Z | 12:37:13Z | healthy / healthy | 0.1.26-rc.1 / 0.1.26-rc.1 | 0.1.26-rc.1 / 0.1.26-rc.1 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261121.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- An end-to-end self-update of a person's hosted Environment from an older version to the candidate started by an
  agent's tool call (the cause of #1205); the transient-unit path is covered by tests with real systemd user units.
- The candidate's other changes beyond the main path and the acceptances named above.
