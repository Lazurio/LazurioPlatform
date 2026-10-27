# The canary of v0.1.14-rc.2 and the final release v0.1.14, 2026-10-27

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.14-rc.2` (source `65f660ac4f38d8cd3100d41181edef5545096cf6`) ran for 3 h 1 min 16 s, directly
observed, on every Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The
final tag `v0.1.14` carries the same product source. It differs from the candidate only by this record and this
file, under `qualification/` and `docs/evidence/`, as the release cycle allows.

The record is [`qualification/canary/v0.1.14-rc.2.json`](../../qualification/canary/v0.1.14-rc.2.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine is
which is kept only in the pilot Organization's own private records.

## Three hours, for this candidate only

Point (6) of root decision 0166 sets a canary of 8 hours. On 2026-10-27 Matěj decided that this one candidate's
canary lasts at least 3 hours, so that the new Buddy reaches personal Environments the same day. The decision is
root decision 0166's addendum of 2026-10-27 (HumanAndMachines/Lazurio#658).

`check-canary.ts` names this candidate in `shorterCanaries` (#673, merged before the candidate was cut). Every
other candidate keeps 8 hours. The scope, the start at the first direct reading and the G.3 conditions do not
change.

## Qualification

- **Published:** the candidate was published on 2026-10-27 at 12:32:00Z by Release run
  [40502572788](https://github.com/Lazurio/LazurioPlatform/actions/runs/40502572788).
  - Every check on `main` at `65f660ac` passed, including macOS. macOS passed on the second attempt; the first hit the known flake #552.
  - The release's own source check also passed on its second attempt; the first hit the known flake #380.
- **Qualify:** run [40504514254](https://github.com/Lazurio/LazurioPlatform/actions/runs/40504514254) ran on the
  default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.14-rc.2`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, through the rollout pipeline
(root decision 0205): the Plan in the pull request, the apply on its merge.

**The rollout rule the canary ran under** was that T3 Code `0.1.2-lazurio.5` and MausBot `0.1.115-lazurio.8` reach
an Environment no later than the Platform. Every Machine of the stage ran both from the start of the stage.

- **Four work VMs, the pilot Organization's lane #174:** merge `e5188760`; push run 40524546414 applied it
  14:48:07–15:34:34Z with success.
- **The fifth work VM (`d94d6e912281c8e6`), lane #176:** merge `de06424e`; push run 40536196264 applied it
  15:58:24–16:13:22Z with success.
  - Before the review, the Machine ran a host-only T3 preview built from the code of `0.1.2-lazurio.4`. The pin counts it as meeting `.5`.
  - To hold the rule's order, the preview was moved to the stable `0.1.2-lazurio.5` with T3's own update **before** the Platform's Plan was recomputed and applied (15:47–15:49:02Z).
- **The personal VM (`11e08b191f0fc044`), its lane #173:** merge `3fe7345f`, applied from the operator's Mac
  14:29:35–14:51:43Z with success, conformant.
  - Consent: its Owner's standing consent to Personal Environment updates.
  - Buddy's delegation tool was reinstalled from the candidate's own bundle at 14:57:55Z, before the stage.

## The stage

- **Start:** `2026-10-27T16:14:38Z`, the end of the first reading that observed every Machine healthy on the candidate.
  The last Machine got it at 16:13:22Z.
  - At 16:14:16–16:14:26Z every work VM answered `lazurio recover --json` `healthy`, with the Launchpad's `/health` on `0.1.14-rc.2`.
  - Each answered `lazurio update status --json` active `0.1.14-rc.2`, and its Launchpad unit had `NRestarts` 0.
  - At 16:14:28–16:14:38Z the personal VM answered the same. Its Launchpad had started at 14:44:34Z with the apply.
- **End:** `2026-10-27T19:15:54Z`, 3 h 1 min 16 s after the start.
  - At 19:15:30–19:15:41Z each work VM answered `recover` `healthy` and active `0.1.14-rc.2`, its Launchpad unit active since the deliberate restart of 16:15Z with `NRestarts` 0.
  - Each work VM's user journal since the start shows only that restart (one `Stopping`, `Stopped`, `Started`), with no other start, stop, scheduled restart or failure.
  - At 19:15:53Z the personal VM answered the same. Its Launchpad unit was active since the apply's start at 14:44:34Z, and its journal since the start shows no start, stop, restart or failure.
  - The reading at 17:45:30–17:45:54Z was the same on all six.
- **Recovery issues: none** (searched at 2026-10-27T19:16:01Z, every issue state):
  - `repo:Lazurio/LazurioPlatform is:issue label:recovery "0.1.14-rc.2"` and the `v0.1.14-rc.2` variant: 0. Issues mentioning recovery created since the candidate was published: 0.
  - Issues naming the candidate at all: #681 and #682, both findings of the stage's own acceptance, and #547, where the same finding as an older candidate's was appended. None is a Recovery issue.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage (the
  deliberate restarts below) came up `healthy`, and every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **16:15:11–16:15:34Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`), then a
   deliberate Launchpad restart. At 16:15:41–16:15:52Z each Launchpad was active since its restart, with `NRestarts` 0,
   and `recover` was `healthy` on `0.1.14-rc.2`.
2. **16:16:15–16:16:43Z, module starts** on the three work VMs that hold the Organization's modules:
   - a static content module, served as a build of its commit;
   - the Organization's planning app, running from `main` as one production process through `start_script`.

   Both were healthy on all three.
3. **16:20:01–16:20:12Z, the one `lazurio update` through Nová karta's Update,** as the Owner test account on its Work
   Environment:
   - every module "Up to date";
   - Lazurio "Up to date, version 0.1.14-rc.2", with no downgrade to the older public release;
   - nothing restarted, and no codes or paths on the page.
4. **16:17:19–16:40:49Z, acceptance of the candidate's changes as the Owner test account** on the personal VM. All passed.
   - **Buddy's first meeting (#667):**
     - his bubble's invitation in Apps, Chat and Automate;
     - the meeting's five steps;
     - his own first message, delivered once and kept once after a reload.
   - **"bot <Name>" and the link to the bot's conversation (#663, #666):** one delegation, one result. The link opened the bot's real conversation.
   - **The line that lets an agent open Buddy's chat (#662):** present in the rendered Folder with the Environment's exact address.
   - **Composio in the account's default organization (#661):** after the sign-in, connected to the default organization with no choice offered, also after a reload. The web dashboard had another organization open.
   - **Findings, none from this candidate's Platform behaviour and none blocking:**
     - #681: the bubble's "1" stays in already-open Chat and Automate tabs until reload;
     - #682: the "Používají agenti" switch stays off after a sign-in, as in v0.1.13;
     - #547: the update view links the latest public release's notes.

### Other changes on the same Machines during the stage

| When (UTC) | What | Effect on the candidate |
|---|---|---|
| 16:15:51 | On the personal VM, Buddy's first-meeting state was reset for the acceptance (a file of Buddy's, not the Platform's) | none; the Launchpad unit kept running |
| 16:16 and 17:56 | On a work VM, a T3 Code `.5` right-panel crash was reproduced in the browser (Lazurio/t3code#135) | none; T3 only, and the Launchpad unit kept running |
| 18:01–18:04:21 | On the same work VM, T3 Code moved to the host-only preview built from the fix's commit (the Ring 0 of `0.1.2-lazurio.6`); only T3's service restarted (18:03:10Z) | none; the Launchpad and every `lazurio-*` unit kept running, `NRestarts` 0 |

### Other observations

- **T3 Code `0.1.2-lazurio.5` has a regression of its own** (Lazurio/t3code#135). Opening T3's right panel in a Chat crashes that Chat (React #301).
  - It was reproduced on a work VM at 16:16Z. The canary's browser checks did not open that panel.
  - It is not Platform behaviour, and no Machine was unhealthy.
  - It is fixed in `0.1.2-lazurio.6`. The final's notes set T3 Code `.4` or newer, not `.5`, as the rollout rule (Matěj's decision of 2026-10-27).

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.14-rc.2 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.14-rc.2 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.14-rc.2 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.14-rc.2 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.14-rc.2 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.14-rc.2 | healthy / healthy | 0 |
