# Ring 0 and the smoke test of v0.1.23-rc.4, 2026-11-19

`v0.1.23-rc.4` (`1c415d99`) carries the fix of incident #1094: a long-working Environment whose Organization root
resolves `conflict` (a projection digest not recomputed) is no longer sent back to Začínáme, `lazurio update`
fast-forwards such a root to its repair, `lazurio organization check [--write]` names and repairs a stale digest, and
"Vyřešit v Chatu" hands the agent a task it finishes on its own (#1095, #1096, #1098). It also carries every change
since `v0.1.22` (47 commits; among them computer contract v3, Apps, Brain, links between T3 Code servers, the Module
Standard and Buddy GEN4 R2/R3, whose window is enabled only by a lane's `buddy.generation: 4`). The canary stage ran on
2026-11-19 from 17:23:42Z to 17:38:17Z and is green.

The record is [`qualification/canary/v0.1.23-rc.4.json`](../../qualification/canary/v0.1.23-rc.4.json), added by the same
pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station, so
every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.23` is tagged only after the condition the release owner set for this
release is met (a canary on a Personal Environment that still runs Buddy GEN3, with its person's consent) and on the
release owner's approval in the `release` environment. `main` has moved on since the candidate, so the final is a
release commit off `main`, as for `v0.1.20` to `v0.1.22`: its parent is this record's merge, its tree is
`1c415d99`'s outside `qualification/` and `docs/evidence/`.

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
`0.1.23-rc.4`, and the Launchpad unit's `NRestarts` was 0. T3 Code is not part of this candidate; its version is
recorded to tell a change apart.

| Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | T3 Code |
|---|---|---|---|---|---|
| work (Owner) | ok | ok | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | 0.1.10-lazurio.2 |
| work (services) | ok | ok | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | 0.1.2-lazurio.6 |
| work (team) | ok | ok | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | 0.1.2-lazurio.6 |
| work (member) | ok | ok | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | 0.1.9-lazurio.2 |
| personal (Owner) | ok | ok | healthy / healthy | 0.1.23-rc.4 / 0.1.23-rc.4 | 0.1.10-preview.20261119.1 |

## Not verified

- A Personal Environment running Buddy GEN3 on the candidate (the Owner test account's is converted to Buddy GEN4); the
  release waits for it.
- Safari, Firefox, a phone; the candidate's other changes beyond the main path.
