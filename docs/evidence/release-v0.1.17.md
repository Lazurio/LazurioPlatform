# The canary of v0.1.17-rc.1 and the final release v0.1.17, 2026-10-30

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.17-rc.1` (source `4f7d1278d9a8b83040fd965e0b9359027fdf36a7`) ran for 8 h 0 min 52 s, directly
observed, on every Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The
final tag `v0.1.17` carries the same product source. It differs from the candidate only by this record and this
file, under `qualification/` and `docs/evidence/`, as the release cycle allows.

The record is [`qualification/canary/v0.1.17-rc.1.json`](../../qualification/canary/v0.1.17-rc.1.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine is
which is kept only in the pilot Organization's own private records.

v0.1.17 carries the Buddy fixes found in v0.1.16's canary and in the Buddy diagnostics of 2026-10-29. The check that
failed in v0.1.16, Buddy's route to another Environment (#689, known issue #722), passed on this candidate.

## Why the final tag is not on `main`

The final ships the candidate that passed the canary, nothing more. Six pull requests reached `main` after the
candidate was cut:
- #733, #731 and #732, which are in `v0.1.18-rc.1`;
- #665, #325 and #738.

None of them was in the canary, so they go into later versions.

`release.yml` requires two things of a final tag:
- **provenance:** the canary record's pull request is merged into the default branch, and its merge commit is in
  the tag's history;
- **the same source:** the tag differs from the candidate only under `qualification/` and `docs/evidence/`.

On `main` the first holds and the second does not. So the tag stands on the branch `release/v0.1.17`. It starts
at the commit that merged this record into `main` and has one commit on top, which restores the candidate's tree
everywhere outside `qualification/` and `docs/evidence/`. The merge is that commit's parent, so provenance holds.
The diff against the candidate is exactly this record and this file, so the same source holds. This is the path
v0.1.11, v0.1.13 and v0.1.16 took.

## Qualification

- **Published:** the candidate was published on 2026-10-30 at 11:13:12Z by Release run
  [41044587817](https://github.com/Lazurio/LazurioPlatform/actions/runs/41044587817), second attempt.
  - The first attempt's source check failed one test on a fixture port that another process took under load (#222).
    The re-run passed.
  - Every check on `main` at `4f7d1278` passed, including macOS, on the third attempt of run
    [41032246515](https://github.com/Lazurio/LazurioPlatform/actions/runs/41032246515). The first two attempts each
    failed one different macOS test, both flakes under load (#451, #734).
  - `v0.1.16..v0.1.17-rc.1` adds #716 (a decision proposal, documentation only), #723, #724 and #730 to v0.1.16's
    tree.
- **Qualify:** run [41046507907](https://github.com/Lazurio/LazurioPlatform/actions/runs/41046507907) ran on the
  default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.17-rc.1`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, through the rollout pipeline
(root decision 0205): the Plan in the pull request, the apply on its merge.

**The rollout rule** was unchanged from v0.1.16:
- T3 Code `0.1.2-lazurio.4` or newer (`.6` recommended, `.5` skipped);
- MausBot `0.1.115-lazurio.8` or newer;
- on Environments with Buddy, Hermes `0.22.4-lazurio.2` or newer.

Every Machine met it from the start of the stage. Two of them ran T3 Code preview builds, installed directly on the
host: one work VM a `0.1.2` preview from an earlier date, and the personal VM a `0.1.3` preview (below). Buddy's own
T3 Code on the personal VM stayed `0.1.2-lazurio.6`.

- **Four work VMs (`00910e1abf66fb61`, `06d5c433c545e38d`, `e0d566c46a1a84de`, `15074d1280e87726`), lane #200:**
  - merge `7a35ffaf`; push run 41049661382 applied it 11:40:06–12:15:10Z with success;
  - 123 of 131 checks passed. Four `ai-ready` checks were unknown. Four failed on the fifth work VM, which this lane
    did not change; lane #202 converged them.
  - The work VM's resource resize was a no-op, so that VM was not restarted.
- **The fifth work VM (`d94d6e912281c8e6`), lane #202:** merge `5c81fc95`, after a fresh Plan that compared the
  same. Push run 41058084317 applied it 12:48:38–13:07:00Z with success; 127 checks passed and 4 `ai-ready` were
  unknown.
- **The personal VM (`11e08b191f0fc044`), its lane #201:** merge `c979c3b1`, after a fresh Plan that compared the
  same. It was applied from the operator's Mac 14:56:11–15:05:41Z with success, `conformant`. 20 of 21 checks
  passed; the Owner's acceptance stayed pending until the Owner signs in.
  - Consent: its Owner's standing consent to Personal Environment updates.
  - **Before the apply, the same day:**
    - Buddy's installer moved Hermes to its current build.
    - At 14:41:10–14:41:41Z the main T3 Code was updated to a `0.1.3` preview build, in a separate host-only step.
  - **During the apply:**
    - the Folder re-rendered, and Buddy's SOUL.md was derived again (15:03:50Z) with #730's sentence;
    - Buddy's Telegram connection reconnected (15:04:07Z).

## The stage

- **Start:** `2026-10-30T15:07:39Z`, the end of the first reading that observed every Machine healthy on the
  candidate (15:07:21–15:07:39Z). The last Machine got it at 15:05:41Z.
  - Every work VM answered `lazurio recover --json` `healthy`, with the Launchpad's `/health` on `0.1.17-rc.1`.
    Each answered `lazurio update status --json` active `0.1.17-rc.1`, and its Launchpad unit had `NRestarts` 0.
  - The personal VM answered the same. Its Launchpad had started at 15:01:50Z with the apply.
- **End:** `2026-10-30T23:08:31Z`, 8 h 0 min 52 s after the start.
  - At 23:08:15–23:08:24Z each work VM answered `recover` `healthy` and active `0.1.17-rc.1`. Its Launchpad unit had
    been active since the deliberate restart of 15:08Z, with `NRestarts` 0.
  - Each work VM's user journal since the start shows only that restart (one `Stopping`, `Stopped`, `Started`). There
    is no other start, stop, scheduled restart or failure.
  - At 23:08:25–23:08:31Z the personal VM answered the same. Its Launchpad unit had been active since the apply at
    15:01:50Z, and its journal since the start shows no start, stop, restart or failure.
  - The reading at 19:39:49–19:40:27Z was the same on all six.
- **Recovery issues: none** (searched at 2026-10-30T23:08:38Z, every issue state).
  - `label:recovery "0.1.17-rc.1"` and the `v0.1.17-rc.1` variant: 0.
  - Issues naming the candidate at all, neither of them a Recovery issue:
    - #722, the acceptance result below;
    - #222, the release run's test flake.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage (the
  deliberate restarts below) came up `healthy`, and every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **15:07:55–15:08:05Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`), then a
   deliberate Launchpad restart. At 15:09:05–15:09:14Z each Launchpad was active since its restart, with
   `NRestarts` 0, and `recover` was `healthy` on `0.1.17-rc.1`.
2. **15:09:16–15:09:35Z, module starts** on the three work VMs that hold the Organization's modules: a static
   content module and the Organization's planning app, each built from its commit.
   - Both were running on all three.
   - On one work VM the planning app answered `healthy: false` right after its start and `healthy: true` at
     15:09:46Z. It was still starting, not a failure.
3. **Acceptance of the agent rules, read-only on every Machine:** on the work VMs at 13:08:45–13:09:01Z, after
   both lanes; on the personal VM from its apply's readback, at 15:05Z.
   - Every Folder renders template revision `base-instructions-90`.
   - The Publication block is in `AGENTS.md` on every non-public Environment, and absent on the public one, as
     designed.
   - #680 still holds: every Codex `config.toml` carries the `chatgpt-apps` markers, and `lazurio doctor` reports
     `chatgpt-apps` `ok` on every Machine.
4. **15:10:46–15:15:01Z, Buddy's chat as the Owner test account on the personal VM: all passed.** Three messages,
   each after the previous turn ended.
   - **The route to another Environment (#724, fixes #722; 15:10:52–15:11:45Z).**
     - The same request that failed in v0.1.16's canary: the person's Work Environment, named by its id.
     - Buddy looked only for the generated SSH config (absent). He read no `~/.ssh/config` and ran no SSH.
     - He answered in plain words that no route leads there from here yet, and that he would not present an
       earlier figure as a fresh one.
   - **Pace (#724; 15:12:27–15:13:10Z).** A question about his own Environment's disk: one short sentence before his
     first tool, then the answer.
   - **Handover (#724; 15:14:10–15:15:01Z).** A small task for a bot: the handover in one sentence, and the bot's
     result reported in the same minute.
   - **The name (#730).** The person's name opened one of the four replies.

### Other changes on the same Machines during the stage

| When (UTC) | What | Effect on the candidate |
|---|---|---|
| 15:10:46–15:15:01 | On the personal VM, Buddy's chat as the Owner test account, with one bot task | none; the Launchpad unit kept running |

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.17-rc.1 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.17-rc.1 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.17-rc.1 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.17-rc.1 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.17-rc.1 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.17-rc.1 | healthy / healthy | 0 |
