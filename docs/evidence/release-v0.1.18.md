# The canary of v0.1.18-rc.1 and the final release v0.1.18, 2026-10-31

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.18-rc.1` (source `bdf1adbe4947ff9a70a6920a94c3dc572ff77e33`) ran for 8 h 0 min 36 s, directly
observed, on every Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The
final tag `v0.1.18` is to carry the same product source. It is to differ from the candidate only under
`qualification/` and `docs/evidence/`, as the release cycle allows; the expected difference is listed below. The
final tag, its branch and its release do not exist yet. They follow the merge of the pull request that adds this
file.

The record is [`qualification/canary/v0.1.18-rc.1.json`](../../qualification/canary/v0.1.18-rc.1.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine is
which is kept only in the pilot Organization's own private records.

v0.1.18 adds three changes to v0.1.17:
- `lazurio update` refreshes the Folder itself, so people never see a refresh (#731);
- the Automated Environment gets the onboarding of a work Environment (#732);
- a test prints its output when its exit code is wrong (#733).

## Why the final tag is not on `main`

The final ships the candidate that passed the canary, nothing more. Six pull requests reached `main` after the
candidate was cut:
- #665, #325, #738, #514 and #742;
- #739, v0.1.17's own canary record, which touches only `qualification/` and `docs/evidence/`.

None of them was in the canary, so they go into later versions.

`release.yml` requires two things of a final tag:
- **provenance:** the canary record's pull request is merged into the default branch, and its merge commit is in
  the tag's history;
- **the same source:** the tag differs from the candidate only under `qualification/` and `docs/evidence/`.

On `main` the first will hold and the second does not. So the tag is planned on the branch `release/v0.1.18`. It
is to start at the commit that merges this record into `main` and to have one commit on top, which restores the
candidate's tree everywhere outside `qualification/` and `docs/evidence/`. The merge will be that commit's parent, so
provenance will hold.

The expected difference against the candidate is four added files, all under the allowed paths:
- this record, `qualification/canary/v0.1.18-rc.1.json`, and this file;
- v0.1.17's canary record, `qualification/canary/v0.1.17-rc.1.json`, and its evidence,
  `docs/evidence/release-v0.1.17.md` (#739), which reached `main` after this candidate was cut.

Nothing differs outside `qualification/` and `docs/evidence/`, so the same source will hold. This is the path
v0.1.11, v0.1.13, v0.1.16 and v0.1.17 took.

## Qualification

- **Published:** the candidate was published on 2026-10-30 at 12:00:49Z by Release run
  [41051087334](https://github.com/Lazurio/LazurioPlatform/actions/runs/41051087334), first attempt.
  - Every check on `main` at `bdf1adbe` passed, including macOS (run
    [41047701302](https://github.com/Lazurio/LazurioPlatform/actions/runs/41047701302)).
  - `v0.1.17-rc.1..v0.1.18-rc.1` adds #733, #731 and #732.
- **Qualify:** run [41052196051](https://github.com/Lazurio/LazurioPlatform/actions/runs/41052196051) ran on the
  default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.18-rc.1`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, through the rollout pipeline
(root decision 0205): the Plan in the pull request, the apply on its merge.

**The rollout rule** was unchanged from v0.1.17:
- T3 Code `0.1.2-lazurio.4` or newer (`.6` recommended, `.5` skipped);
- MausBot `0.1.115-lazurio.8` or newer;
- on Environments with Buddy, Hermes `0.22.4-lazurio.2` or newer.

Every Machine met it from the start of the stage. Buddy's installer did not run in this round.

**Two lanes for the work VMs.** The pinned Machines release (v0.12.213) converges at most four guests in one
revision, so the five work VMs went in two lanes.

- **Four work VMs (`00910e1abf66fb61`, `06d5c433c545e38d`, `e0d566c46a1a84de`, `15074d1280e87726`), lane #207:**
  - merge `c05d97ee` at 07:19:51Z, after a fresh Plan that compared the same;
  - push run 41180171949 applied it 07:20:23–07:54:45Z with success, Permit `mp_5e0a8b9b…`;
  - 127 of 131 checks passed. Four `ai-ready` checks were unknown.
  - One work VM's resource resize was a no-op, so that VM was not restarted.
- **The personal VM (`11e08b191f0fc044`), its lane #206:**
  - merge `758278e2` at 07:57:47Z, after a fresh Plan that compared the same;
  - applied from the operator's Mac 07:58:00–08:11:16Z with success, `conformant`, Permit `mp_b3869792…`;
  - 20 of 21 checks passed. The Owner's acceptance stays pending until the Owner signs in.
  - Consent: its Owner's standing consent to Personal Environment updates.
  - **During the apply:** the Folder re-rendered at template revision `base-instructions-91`, and Buddy's Telegram
    connection reconnected (08:08:25Z).
  - Hermes, MausBot, the main T3 Code and Buddy's own T3 Code stayed at the builds of v0.1.17's round.
- **The fifth work VM (`d94d6e912281c8e6`), lane #208:**
  - merge `218c0e5c` at 08:16:29Z, after a fresh Plan that compared the same;
  - push run 41183927437 applied it 08:16:59–08:31:49Z with success, Permit `mp_f038d0d2…`;
  - 127 of 131 checks passed and 4 `ai-ready` were unknown.

**The Folder at a Launchpad's first start (#736).** Right after an update, the new Launchpad's first
Organization-settings round may render the Folder once more. This is a second writer beside the update's own
refresh. The candidate's notes describe it, and it changes nothing the canary checks: every Folder renders the
same template revision.

## The stage

- **Start:** `2026-10-31T08:33:28Z`, the end of the first reading that observed every Machine healthy on the
  candidate (08:33:06–08:33:28Z). The last Machine got it at 08:31:49Z.
  - Every work VM answered `lazurio recover --json` `healthy`, with the Launchpad's `/health` on `0.1.18-rc.1`.
    Each answered `lazurio update status --json` active `0.1.18-rc.1`, and its Launchpad unit had `NRestarts` 0.
    Each Launchpad had started with its lane's apply.
  - The personal VM answered the same. Its Launchpad had started at 08:06:08Z with the apply.
- **End:** `2026-10-31T16:34:04Z`, 8 h 0 min 36 s after the start.
  - At 16:33:37–16:33:52Z each work VM answered `recover` `healthy` and active `0.1.18-rc.1`. Its Launchpad unit had
    been active since the deliberate restart of 08:33Z, with `NRestarts` 0.
  - Each work VM's user journal since the start shows only that restart (one `Stopping`, `Stopped`, `Started`). There
    is no other start, stop, scheduled restart or failure.
  - At 16:33:53–16:34:04Z the personal VM answered the same. Its Launchpad unit had been active since the apply at
    08:06:08Z, and its journal since the start shows no start, stop, restart or failure.
  - The reading at 12:38:42–12:39:02Z was the same on all six.
- **Recovery issues: none** (searched at 2026-10-31T16:34:16Z, every issue state).
  - `label:recovery "0.1.18-rc.1"` and the `v0.1.18-rc.1` variant: 0.
  - Issues naming the candidate at all, neither of them a Recovery issue:
    - #736, the Folder render at a Launchpad's first start above;
    - #740, the retirement of the macOS 14 CI runners.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage (the
  deliberate restarts below) came up `healthy`, and every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **08:33:39–08:33:50Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`), then a
   deliberate Launchpad restart (08:33:42–08:33:50Z). Right after, each Launchpad was active since its restart, with
   `NRestarts` 0, and `recover` was `healthy` on `0.1.18-rc.1`.
2. **Module starts** on the three work VMs that hold the Organization's modules: a static content module and the
   Organization's planning app, each built from its commit. Both were running and healthy on all three by 08:35:25Z.
3. **08:35:37–08:36:52Z, the modules open through the Launchpad.**
   - G.3 asks that the modules users work with start **and open** through the Launchpad or
     `lazurio module open`. This release has no `lazurio module open` command; [Launchpad
     parity](../launchpad-parity.md) describes it as the target. So the opening went the way a person opens a
     module: in a browser, on the module's own hostname, through the Environment's gateway and Launchpad.
   - **On each of the three work VMs both modules opened, as the Organization's test accounts:**
     - HTTP 200;
     - the content module's own front page;
     - the planning app's plan board.
   - The two person-assigned work VMs were opened as their assigned users. The public one was opened with a session
     that was already signed in, so no sign-in page appeared this time.
   - The modules were still running from step 2, so these were warm opens.
   - By the reading at 12:38Z no module was running. This is the Launchpad's own sleep of unused apps (decision
     F57, root decision 0195 point 23): it stops an app nobody has used for 20 minutes, at its next sweep, every 5
     minutes. It is not a failure.
4. **Acceptance of the agent rules, read-only on every Machine:**
   - on the four work VMs of lane #207 at 07:56:13–07:56:28Z, after their apply;
   - on the personal VM from its lane's acceptance read after its apply (08:11Z);
   - on the fifth work VM at 16:35:52Z, right after the stage, with its Machine unchanged since lane #208.

   The results:
   - Every Folder renders template revision `base-instructions-91`.
   - The Publication block is in `AGENTS.md` on every non-public work VM, and absent on the public one, as designed.
   - #680 still holds: every Codex `config.toml` carries the `chatgpt-apps` markers, and `lazurio doctor` reports
     `chatgpt-apps` `ok` on every Machine.

### Other changes on the same Machines during the stage

None. The pilot Organization held its next lanes until the end of the stage.

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.18-rc.1 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.18-rc.1 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.18-rc.1 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.18-rc.1 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.18-rc.1 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.18-rc.1 | healthy / healthy | 0 |
