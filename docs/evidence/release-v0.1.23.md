# Ring 0 and the smoke test of v0.1.23-rc.4, 2026-11-19

`v0.1.23-rc.4` (`1c415d99`) carries the fix of incident #1094: a long-working Environment whose Organization root
resolves `conflict` (a projection digest not recomputed) is no longer sent back to Začínáme, `lazurio update`
fast-forwards such a root to its repair, `lazurio organization check [--write]` names and repairs a stale digest, and
"Vyřešit v Chatu" hands the agent a task it finishes on its own (#1095, #1096, #1098). It also carries every change
since `v0.1.22` (47 commits; among them computer contract v3, Apps, Brain, links between T3 Code servers, the Module
Standard and Buddy GEN4 R2/R3, whose window is enabled only by a lane's `buddy.generation: 4`). The canary stage ran on
2026-11-19 from 17:23:42Z to 17:38:17Z and is green.

The record is [`qualification/canary/v0.1.23-rc.4.json`](../../qualification/canary/v0.1.23-rc.4.json), added by the
same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station,
so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.23` is tagged only after the condition the release owner set for this
release is met (a canary on a Personal Environment that still runs Buddy GEN3, with its person's consent; met at
22:00–22:05Z, see below) and on the release owner's approval in the `release` environment. `main` has moved on since the
candidate, so the final is a release commit off `main`, as for `v0.1.20` to `v0.1.22`: its parent is this record's
merge, its tree is `1c415d99`'s outside `qualification/` and `docs/evidence/`.

## The candidate

- Tag `v0.1.23-rc.4` at `1c415d99934ecaf6622bd1526b20de1fdcbfc33e`, release run 44533609917 (attempt 3; attempts 1 and 2
  failed in "Check the tagged source" on timing tests, `tests/built-builds.test.ts` and the known flaky public-vault
  test of #615, both passing locally).
- linux-x64: sha256 `c145c343…`, 102 589 920 B; `lazurio.sigstore.json`: sha256 `eff82fa6…`, 11 847 B;
  `gh attestation verify --bundle … --source-digest 1c415d9…` accepts the binary.
- Qualification `qualify.yml` run 44540386756: every journey ok on `ubuntu-24.04` and `macos-15`.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb): LazurioExampleOrganization/infra#340, merged at
  16:47:47Z after an independent review on the exact head and a fresh CI Plan, applied by its push run, which ended at
  **17:23:42Z**: the last time a Machine in scope got the candidate, and the start of the stage.
- **One personal VM**, the Owner test account's Personal Environment: its lane on the operator path
  (LazurioExampleOrganization/infra#339), merged at 15:18:56Z after an independent review, a fresh Plan and the Owner's
  consent to its exact Plan digest, applied by the operator 15:19:09–15:28:35Z.
- **Not in this record:** the release owner's own Personal Environment.

## The stage

By one thread. Read-only except the acceptance of #1094, the real work on the personal VM and the smoke tests.

1. **Acceptance of #1094 as the Owner, 17:24–17:29Z,** on the Owner's Work Environment: its Organization root was moved
   locally back to a commit with a stale digest whose repair is on `main` (fixture
   LazurioExampleOrganization/LazurioExampleOrganization_GEN3#32, no net change to that root). Apps kept the
   Organization with the line and "Solve in Chat"; Začínáme kept its step done; "Solve in Chat" opened Chat with the
   prepared task; the agent acted without a further word and the routine `lazurio update` fast-forwarded the root to
   its repair (`transition`, 12 modules). Its device channel still works (handover from Auth `200`, checked by the
   LZD-0018 thread).
2. **R1, 17:31:34–17:32:15Z.** Every Machine through its own Launchpad, as the test accounts (`/api/recovery`,
   `/api/update/status`).
3. **The smoke tests,** each persona in a fresh headless profile of its own: `suite both` 17 of 17 required (7 optional
   passed, 1 INCONCLUSIVE); the main path as the Owner and the member 19 of 19 required. Two optional checks failed
   only on the script's stale list of template versions in Marketplace (it expected the versions of 16 Nov; Marketplace
   offers newer ones, e.g. mission-control 4.2.1).
4. **Real work on the personal VM, 17:36:33–17:36:43Z:** `lazurio doctor` (machine binding and entry ok; `gh` is not
   signed in on this test account, which makes its verdict `broken` independent of the candidate), `lazurio machine
   folder-refresh` (unchanged), a restart of the Launchpad unit (active, `NRestarts` 0), `lazurio recover --json`
   healthy. T3 Code was not touched.
5. **R2, 17:37:21–17:38:08Z.** The same readings.
6. **Recovery issues:** none open with the label `recovery` (17:38Z).
7. **End:** `2026-11-19T17:38:17Z`, the green light.

**Not quiet:** the pilot Organization's Deployment Repo ran one push apply during the stage, on a lane outside the
scope: its Conglomerate Host's Machines pin (#344, 17:31:54–17:32:59Z, failed). It changes no Platform pin and no
Environment in scope; R2 reads every Machine as healthy on the candidate after it.

### Per Machine

At both edges `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.23-rc.4`, and the Launchpad unit's `NRestarts` was 0. The check `launchpad-health` of `recover` is the Launchpad's
own `GET /health` (`src/recover/observe.ts`): it is `ok` only when `/health` answers in normal mode, not in recovery
mode, with the version equal to the active one, so the `/health` column is that answer at each edge. T3 Code is not part
of this candidate; its version is recorded to tell a change apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 17:31:39Z | 17:37:26Z | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | normal, 0.1.23-rc.4 / normal, 0.1.23-rc.4 | Knowledgebase 17:33:08Z, Design system 17:33:14Z: each from its tile, its own origin, HTTP 200, its heading | 0.1.10-lazurio.2 |
| `7d3f2189170e39ea` | work (services) | 17:31:43Z | 17:37:31Z | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | normal, 0.1.23-rc.4 / normal, 0.1.23-rc.4 | none to start: its one tile is the Organization's AI pool service (a service page, not a module), as for `v0.1.22` | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 17:32:11Z | 17:38:03Z | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | normal, 0.1.23-rc.4 / normal, 0.1.23-rc.4 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 17:32:15Z | 17:38:08Z | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | normal, 0.1.23-rc.4 / normal, 0.1.23-rc.4 | Knowledgebase 17:34:13Z: from its tile, its own origin, HTTP 200, its heading | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 17:31:34Z | 17:37:21Z | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | normal, 0.1.23-rc.4 / normal, 0.1.23-rc.4 | none to start: Apps shows 0 module tiles | 0.1.10-preview.20261119.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

### Added after review, 22:05:55–22:12:33Z

The review asked for module coverage on every Machine. The stage itself started and opened modules only on the two Work
Environments that carry them, and did not look at Apps on the other three. So the same thread ran the missing look
afterwards, bracketed by two more readings, all as the test accounts. This is outside the record's window and does not
change it. Between the windows the pilot Organization's host got Machines v0.12.256 (infra#345, applied
17:52–18:28Z), and T3 Code on the Owner's Work Environment updated itself to 0.1.10-lazurio.3 between R3 and R4. No
Platform pin changed.

1. **R3, 22:06:01–22:06:47Z.** Every Machine: `recover` healthy, active `0.1.23-rc.4`, `/health` normal with
   `0.1.23-rc.4`, `NRestarts` 0.
2. **Apps on every Environment each account lists, about 22:07Z.** Owner's Work Environment: 12 tiles. Member's: 11.
   Prostředí služeb: 1 tile, the AI pool service (CLIProxyAPI, "Open the service's page"); the check for a startable
   module there found none, by design. Team Environment: 0. Owner's Personal Environment: 0.
3. **The main path again, 22:09:43–22:10:53Z.** Knowledgebase and the Design system on the Owner's Work Environment,
   and Knowledgebase on the member's, each started and opened from its tile on its own origin with HTTP 200. Both chats
   answered, and Připojení was right on every Environment: 19 of 19 required. The same two optional
   Marketplace checks failed on the script's stale list of versions.
4. **R4, 22:11:48–22:12:33Z.** The same readings as R3, all the same except T3 Code above.

## The Buddy GEN3 canary, 22:00–22:05Z

This was the release owner's condition. One Personal Environment that still runs Buddy GEN3 took the candidate with its
person's consent: `lazurio update --version v0.1.23-rc.4` 22:00:57–22:01:06Z, `updated` 0.1.22 → 0.1.23-rc.4, exit 0,
Folder refreshed, Launchpad restarted. The shared Chat, the Buddy GEN3 unit (its own Chat copy answering on its port),
Hermes and MausBot did not change and were not restarted; no failed unit, `lazurio doctor` ok. The person opened
Lazurio, opened Buddy and wrote to it; Buddy answered ("Funguje to"). Known and not blocking: Apps → Brain on that
Environment says the map has no access to its memory yet and that a later update adds it. That is the new feature's own
message, not a fault.

## Not verified
- Safari, Firefox, a phone; the candidate's other changes beyond the main path.
