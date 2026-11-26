# Ring 0 and the smoke test of v0.1.28-rc.1, 2026-11-26

`v0.1.28-rc.1` (`af5e618f`) is the candidate for the final `v0.1.28`. 0.1.28 carries:
- #1232, the fix of #1197: Chat's recommended model follows the AI signed in;
- Buddy GEN4's notices on from the start (#1167) and his introduction (#1166);
- Buddy wherever a person signs in, and off the tailnet (#1252, #1253);
- a Module app's STAGING page with Lazurio's element (#1254);
- the shell of a Module's app in DEV on the Launchpad's loopback (#1251);
- Lazurio pages only in the person's own browser (C20, #1262);
- stack profiles 2027.03 (#1234) and the Apps tiles' words (#1246, #1249).

The canary stage ran on 2026-11-26 from 05:22:56Z to 05:36:31Z, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green. #1233, the check of a Personal Environment with only Claude signed in, followed it on the same candidate and is described below.

The record is [`qualification/canary/v0.1.28-rc.1.json`](../../qualification/canary/v0.1.28-rc.1.json), added by the same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station, so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.28` is tagged only on the release owner's approval in the `release` environment. Its tree is `af5e618f`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is this record's merge, as for `v0.1.20` to `v0.1.27`.

## The candidate

- Tag `v0.1.28-rc.1` at `af5e618fada8ecfa095f79342b2c16abc92c2c35`, release run 45748896942 (success), prerelease published 2026-11-26T03:43:30Z.
- linux-x64: sha256 `832c959b…`, 103 097 824 B. `lazurio.sigstore.json`: sha256 `7b13498f…`, 11 694 B.
  - All three binaries were checked on the downloaded files against `manifest.json`.
  - `gh attestation verify` with that bundle, bound to `.github/workflows/release.yml` at the tag, accepts the manifest, each binary, `install.sh` and the shell archive.
- Qualification `qualify.yml` run 45750737117 (artifact `qualification-v0.1.28-rc.1` for the candidate's published bytes): success.
- The push run of `af5e618f` on `main` (45745493517) is green on its first attempt, both macOS shards included.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work Environments, the Team Environment and the Prostředí služeb) got it from LazurioExampleOrganization/infra#443.
  - The pull request was merged at 04:43:57Z after an independent review on the exact head and a fresh CI Plan (34 actions, 0 deletions, Machines v0.12.270).
  - Its push run (45757061593) applied it from 04:44:33Z, `success` and `conformant` with 134 of 134 readback checks passing, ending at **05:22:56Z**. That was the last time a Machine in scope got the candidate, and it is the start of the stage.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane (LazurioExampleOrganization/infra#442), applied 04:23:43–04:33:58Z from the station, `success` and `conformant`. Only its two earlier `unknown` checks stayed open.
- **Not in this record:** the release owner's own Personal Environment, and the member test account's Personal Environment.
  - The member's Personal Environment was read at both edges: `healthy`, all five `recover` checks `ok`. It runs and has active **`0.1.24`**, with `/health` answering `0.1.24`, because no lane moves it to a candidate, as for `v0.1.25` to `v0.1.27`.
  - Its two readings (05:30:19Z and 05:36:13Z) are failed optional steps of the stage.

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. Both personas were free at the start and were held by this thread for the stage.

1. **R1, readings 05:29:48–05:30:30Z.** Every Machine through its own Launchpad, as the test accounts:
   - `/api/recovery`, which is the use case of `lazurio recover --json`, and `/api/update/status`;
   - the `launchpad-health` check of `/api/recovery`, which carries the `version` that the Launchpad's own `GET /health` answered on its health socket at that moment (`src/recover/observe.ts`, `askHealth`).

   A step passes only when `recover` is healthy, `running` and `active` are the candidate, and that `/health` version is the candidate. No Launchpad was in recovery mode: none of the readings was entered. 12 of 12 required steps passed.
2. **Real work on the Owner's Work Environment, 05:30:37–05:30:47Z,** a Machine this lane updated, over its operator SSH entry:
   - `lazurio --version`: `0.1.28-rc.1`, commit `af5e618f`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`), as for `0.1.24` to `0.1.27`; the other findings are `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 05:30:38Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - `suite both`, from 05:30:47Z: 17 of 17 required steps passed. 8 optional passed and 1 was INCONCLUSIVE, because the member's proxy does not reach the Owner test account's Personal Environment, as before.
   - The main path as the Owner and the member, from 05:31:51Z: 19 of 19 required steps passed, with Knowledgebase and Design system started from their tiles, the chat answering on both Work Environments, the Marketplace's Mission Control detail and Připojení.
     - Two optional steps failed: `marketplace` for each account. The station's script for this step still expected the Marketplace registry as it was on 2026-11-24 (7 templates at registry commit `5dcd40bb`).
     - The Marketplace answered HTTP 200 from its registry at commit `41907c45` with 8 templates: the Deals template 0.1.1 is new, and several templates have newer versions.
     - It is the script's expectation that is out of date, not the candidate.
   - The tiles on every Environment each account lists, from 05:33:45Z: 12 of 12 required and 10 of 10 optional passed. Both accounts' sign-out went through the realm's confirmation page in about 2 s, and the session answered 401 afterwards.
4. **R2, readings 05:35:37–05:36:23Z.** The same readings, `/health` included, 12 of 12 required steps passed.
5. **Recovery issues:** none open with the label `recovery` (05:36Z).
6. **End:** `2026-11-26T05:36:31Z`, the green light.

A module the Organization's Ring 0 thread had started on the Owner's Work Environment shortly before (from the Deals 0.1.1 template) was read after the stage: `running` and `healthy`, served from the same build as before the apply. The restarts of the apply and of step 2 did not stop it.

### Per Machine

At both edges:
- `recover` answered `healthy` with all five checks `ok`;
- `update status` answered running and active `0.1.28-rc.1`;
- the Launchpad's own `GET /health` answered `0.1.28-rc.1` in normal mode;
- the Launchpad unit's `NRestarts` was 0. On the Owner's Work Environment this is the count after its restart in step 2.

T3 Code is not part of this candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 05:29:53Z | 05:35:43Z | healthy / healthy | 0.1.28-rc.1 / 0.1.28-rc.1 | 0.1.28-rc.1 / 0.1.28-rc.1 | Knowledgebase and Design system, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.10-preview.20261121.1 |
| `7d3f2189170e39ea` | work (services) | 05:29:58Z | 05:35:47Z | healthy / healthy | 0.1.28-rc.1 / 0.1.28-rc.1 | 0.1.28-rc.1 / 0.1.28-rc.1 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 05:30:25Z | 05:36:18Z | healthy / healthy | 0.1.28-rc.1 / 0.1.28-rc.1 | 0.1.28-rc.1 / 0.1.28-rc.1 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 05:30:30Z | 05:36:23Z | healthy / healthy | 0.1.28-rc.1 / 0.1.28-rc.1 | 0.1.28-rc.1 / 0.1.28-rc.1 | Knowledgebase, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 05:29:48Z | 05:35:37Z | healthy / healthy | 0.1.28-rc.1 / 0.1.28-rc.1 | 0.1.28-rc.1 / 0.1.28-rc.1 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261124.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## #1233: a Personal Environment with only Claude signed in

On the Owner test account's Personal Environment, on this candidate, from 07:03 to 07:07Z, with the release owner's consent to sign ChatGPT out after the earlier tests (details in #1233):

- **Both signed in:** `lazurio chat defaults --json` answered `managed`, `ai: "codex"`. Chat is on ChatGPT's model.
- **ChatGPT signed out** with `codex logout`:
  - `lazurio chat defaults --json` answered `outdated`, `ai: "claude"`. The rule of #1232 picks Claude, but a sign-out applies nothing. **Followed up as #1268.**
  - After `lazurio chat defaults --apply`, the step a sign-in runs, it answered `managed`, `ai: "claude"`, and T3 held `claudeAgent` / `claude-opus-5-5` / `effort: medium`.
- **In a fresh browser profile, as the test account:** `/api/ai` read Claude signed in and Codex signed out, and a new Chat thread showed "Opus 5.5 Medium" and answered in 8 s.
- **Buddy GEN4's first thread opened after the Claude sign-in: moved after the release.** This Environment's Buddy thread already existed (Lazurio/t3code#258), and the reference Organization has no Environment whose Buddy thread was never opened. On 2026-11-26 at 07:14 UTC, the release owner's coordinator decided under the release owner's standing mandate (not the release owner himself) to check it on the first real or test Environment with only Claude signed in after the release. The result goes into #1233, which stays open until then.
- **The warning in Začínáme after a failed model step: open.** It needs a sign-in by the person. Whether it is checked together with the release owner's own ChatGPT sign-in on this Environment waits for his answer.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path and the acceptances named above.
