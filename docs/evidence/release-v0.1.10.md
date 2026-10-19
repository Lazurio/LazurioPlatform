# The canary of v0.1.10-rc.1 and the final release v0.1.10, 2026-10-19

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary): the candidate
`v0.1.10-rc.1` (source `edca9290470d04802610cf3c86556c66a597309e`) and the final tag `v0.1.10` at
the same source.
The record is [`qualification/canary/v0.1.10-rc.1.json`](../../qualification/canary/v0.1.10-rc.1.json).
Machines are opaque ids, as in the record. Which Machine is which is kept only in the pilot
Organization's own private records.

**Status: the canary has not passed yet.**
- The first stage ran for 8 hours on the pilot Organization's three work VMs, which are all of its
  Environments. Every Machine was on the candidate and healthy in every round.
- No personal VM took part. So the record lists the work VMs only, and
  `scripts/qualify/check-canary.ts` refuses it with exactly one finding: "no personal VM is listed;
  the stage needs every one" (root decision 0166 point 6).
- The 8 hours start when the last Machine runs the candidate. The canary passes only after an
  operator's personal VM has run the candidate and a new 8-hour stage on all four Machines has
  ended.
- Then the record is replaced by that stage's and this document is completed (*The second stage*
  below).

## Qualification

The candidate was published on 2026-10-19 at 09:12:25Z by Release run
[39226735059](https://github.com/Lazurio/LazurioPlatform/actions/runs/39226735059). Qualify run
[39228308554](https://github.com/Lazurio/LazurioPlatform/actions/runs/39228308554)
ran on the default branch (`workflow_run`) and succeeded:
- it left the artifact `qualification-v0.1.10-rc.1`, kept until 2027-01-17;
- `scripts/qualify/evidence.ts check` against the candidate's published `manifest.json`
  answers `v0.1.10-rc.1 is qualified: J1 J2 J3 J4 J5 J6 ok on linux-x64 and darwin-arm64`;
- the manifest's `source_commit` is `edca9290470d04802610cf3c86556c66a597309e`.

## Scope

The scope is the pilot Organization's 3 work VMs, which are all of its Environments, plus the
personal VM of one operator. The personal VM is outside the Organization, which has no personal
Environment (root decision 0204 point 7). The scope is not narrowed. The personal VM has not run
the candidate yet.

How each Machine got the candidate:
- **The work VMs** went through the pilot Organization's Machines lane, the path that pins their
  release. It ran through the rollout pipeline (root decision 0205): the pull request's run
  computed the Plan, and the merge's run applied it.
  - Plan `33a41539…`, committed unchanged and confirmed current before the merge;
  - Permit `mp_1adc7300…`, 09:42:46Z;
  - apply 09:40:49Z–10:13:16Z: `success`, complete, healthy (68 of 68 checks) and conformant;
  - evidence commit `3a1cbc89` on the lane's evidence branch.

  The same apply brought Lazurio MausBot 0.1.115-lazurio.3 to the three work VMs. The Launchpad
  units were switched to the candidate at 09:52:35Z, 10:00:57Z and 10:09:06Z.
- **The personal VM** waits for its Owner's consent, which the release cycle keeps for every
  rollout ("the personal VM Owner's consent").
  - Its path will be the one used for `v0.1.9-rc.6` and `v0.1.8-rc.70`: its own updater
    (`lazurio update --version v0.1.10-rc.1`, which verifies the release's attestation), followed
    by `lazurio machine folder-refresh`, as the hosting apply does.
  - That departs from G.3's "the path that pins its release", because a pin is a minimum (root
    decision 0161, addendum of 2026-09-28).

## The first stage: the work VMs

- **Start:** `2026-10-19T10:15:00Z`. At that moment the last work VM was proven on the candidate:
  - `lazurio update status --json` active and running `0.1.10-rc.1`;
  - the Launchpad's health on the candidate;
  - `lazurio recover --json` healthy.
- **End:** `2026-10-19T18:24:05Z` (8 h 9 min).
- **Observation:** a read-only round on every Machine every 30 minutes. Each round reads:
  - `update status`, `self-check` and `recover`;
  - the Launchpad's health;
  - the Launchpad unit's state, `NRestarts` and start time;
  - the module app units, the Folder revision and the T3 Code version.

  Rounds (UTC, Machines on the candidate and healthy / Machines): 2026-10-19T10:15:00Z 3/3; 2026-10-19T10:15:15Z 3/3; 2026-10-19T10:45:23Z 3/3; 2026-10-19T11:15:30Z 3/3; 2026-10-19T11:45:37Z 3/3; 2026-10-19T12:15:44Z 3/3; 2026-10-19T12:45:52Z 3/3; 2026-10-19T13:15:59Z 3/3; 2026-10-19T13:46:13Z 3/3; 2026-10-19T14:16:21Z 3/3; 2026-10-19T14:46:28Z 3/3; 2026-10-19T15:16:36Z 3/3; 2026-10-19T15:46:45Z 3/3; 2026-10-19T16:16:53Z 3/3; 2026-10-19T16:47:05Z 3/3; 2026-10-19T17:18:15Z 3/3; 2026-10-19T17:48:24Z 3/3; 2026-10-19T18:24:05Z 3/3.

  Consecutive rounds were at most 31.2 minutes apart, except the last gap: 35.7 minutes,
  17:48:24Z–18:24:05Z. The observer's 30-minute wait ended late, so the round planned for about
  18:18Z ran as the final round.
- **No Recovery mode between the rounds:**
  - Recovery mode is chosen only when the Launchpad starts (`startOrRecover` in
    `src/launchpad/recovery-mode.ts` at the candidate's tag).
  - On every Machine, the Launchpad unit's `ActiveEnterTimestampMonotonic` changed only at the
    deliberate restart of the G.3 item below (two work VMs, 10:15:28Z and 10:16:02Z). `NRestarts`
    was 0 in every round.
  - Every round found `lazurio recover --json` healthy, with its checks `launchpad-health`,
    `launchpad-unit`, `folder-state`, `self-check-failed` and `update-state-invalid` all ok. The
    Launchpad's health answered `0.1.10-rc.1`.
- **Recovery issues:** none. A search of the public repository (state all, created since
  2026-10-19) for `0.1.10-rc.1` finds no issue.

## Other changes on the same Machines during the stage

Only one other change touched the stage's Machines during the stage, and it did not change the
Platform. No apply ran on the lane between the candidate's apply and the end of the stage.

| When (UTC) | Machines | What | Platform |
|---|---|---|---|
| 2026-10-19 11:20:16–11:20:26Z | work VM `f1040cafc798ecf0` | T3 Code 0.1.0-preview.20261018.1 → 0.1.0-preview.20261019.1, a preview with Lazurio/t3code#87 (Chat's rail follows the Environment theme), installed in the guest after a backup. Only the T3 Code service restarted (active again at 11:20:26Z). To check it, the Environment theme of that VM was set to Ocean at 11:21:06Z and back to Lazurio at 11:21:46Z. | unchanged |

The rounds also compared that VM's T3 Code version with the one expected before this change. So
from 11:45:37Z on, every round reported this deliberate change as a difference. Every check of the
Platform passed in every round.

**After the stage:**
- From 18:26:12Z to 18:27:15Z, T3 Code went to 0.1.0-lazurio.3 on all three work VMs. Only the
  T3 Code service restarted, each time after a backup.
- A readback at 18:27:49Z found all three on T3 Code 0.1.0-lazurio.3 and still on `0.1.10-rc.1`.
- This is not part of the stage.

## Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` start / end | Launchpad health at end | Module apps active start / end |
|---|---|---|---|---|---|---|
| `146fb920b36d943c` | work | 0.1.10-rc.1 | healthy / healthy | 0 / 0 | 0.1.10-rc.1 | 3 / 3 (failed 0) |
| `a2a75fc428e8dbad` | work | 0.1.10-rc.1 | healthy / healthy | 0 / 0 | 0.1.10-rc.1 | 0 / 0 (failed 0) |
| `f1040cafc798ecf0` | work | 0.1.10-rc.1 | healthy / healthy | 0 / 0 | 0.1.10-rc.1 | 3 / 3 (failed 0) |

"Module apps active" counts the module app units (`lazurio-app-*`) running at the start and at
the end of the stage. No module app failed in any round.

## Module starts and real work

- **Folder refresh and Launchpad restart (G.3), inside the stage.** On work VM `f1040cafc798ecf0`
  at 10:15:26Z and on work VM `146fb920b36d943c` at 10:16:00Z:
  - `lazurio machine folder-refresh` as the Machine's user: `unchanged`, exit 0;
  - then a deliberate `systemctl --user restart lazurio-launchpad.service`, exit 0;
  - the units came back active at 10:15:28Z and 10:16:02Z with `NRestarts` 0 (a deliberate
    restart does not count), and `lazurio recover --json` answered `healthy` on 0.1.10-rc.1;
  - a round right after each (10:15:43Z and 10:16:17Z) found all three work VMs on the candidate
    and healthy.
- **The Environment theme (#493)** was written twice on `f1040cafc798ecf0` through the candidate
  (11:21:06Z and 11:21:46Z, above). The Folder revision stayed the same: the theme's record lies
  outside the Folder.
- **Modules already running at the start** (3 each on two work VMs) were still running at the
  end, with their data mounts present (#476). None stopped or failed.
- **Module opens through the Launchpad** were not recorded inside this stage. The browser
  acceptance below opens modules after it, and the second stage records module opens inside it.

## Browser acceptance (root decision 0178)

On the pilot Organization, after the first stage, with the designated test accounts (the Owner
and a member), each in an agent's own headless browser profile. The result is added here before
this pull request is marked ready.

## The second stage, with the personal VM

The second stage starts once the personal VM's Owner has consented:
1. The personal VM gets the candidate by the path above.
2. One round proves all four Machines on the candidate.
3. Its time is the start of the 8 hours.
4. The rounds continue every 30 minutes, with the same reads. T3 Code's version is recorded but
   no longer compared, because it is not part of the Platform candidate.
5. The G.3 item (a Folder refresh and a deliberate Launchpad restart) and module opens through the
   Launchpad are done inside the stage.

When it has ended:
- its record replaces the one in this pull request;
- its rounds, per-Machine table, real work and other changes are added here.

## Result

Not passed yet. On every work VM the candidate ran for the whole first stage:
- `lazurio recover --json` healthy at the start, at the end and in every round;
- no Recovery mode, no automatic Launchpad restart and no failed module app.

The record lists no personal VM, so it does not pass `scripts/qualify/check-canary.ts`:

```text
Refused: the canary of v0.1.10-rc.1 does not pass.
  no personal VM is listed; the stage needs every one
```

## The final tag

`main` has moved since the candidate, so `v0.1.10` is not a commit of `main`. It is a commit
whose parent is this pull request's merge commit and whose tree is exactly `v0.1.10-rc.1`'s tree
plus this record and this evidence, taken from that merge commit, as for
[`v0.1.9`](release-v0.1.9.md) and [`v0.1.8`](release-v0.1.8.md). Release's job `qualified`
checks three things on it:
- the diff from the candidate is only under `qualification/` and `docs/evidence/`;
- `check-canary.ts --provenance`;
- the qualification artifact above.
