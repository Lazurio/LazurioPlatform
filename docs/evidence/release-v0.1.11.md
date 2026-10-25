# The canary of v0.1.11-rc.6 and the final release v0.1.11, 2026-10-24/25

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.11-rc.6` (source `b5c6521c3bac2cf4e01ac75fd6d535b312ed35f6`) ran for more than 8
hours on every Environment of the pilot Organization, LazurioExampleOrganization, and on one
operator's personal VM.

The final tag `v0.1.11` carries the candidate's tree plus two evidence files: this file and the
canary record. The release cycle allows exactly those two directories to differ
(`qualification/` and `docs/evidence/`). No other file differs from the candidate.

The record is [`qualification/canary/v0.1.11-rc.6.json`](../../qualification/canary/v0.1.11-rc.6.json),
added by [#638](https://github.com/Lazurio/LazurioPlatform/pull/638). Machines are opaque ids, as in
the record. Which Machine is which is kept only in the pilot Organization's own private records.

## Why the final tag is not on `main`

The final ships the candidate that passed the canary, nothing more.

Two pull requests reached `main` after the candidate was cut, during the merge freeze between the
candidate and the final:
- #619 (`fda0a82f`): the request that the person does something goes through the question tool;
  template revision base-instructions-74.
- #623 (`9781aeda`): Buddy's wording; base-instructions-75.

Both are reviewed and approved Folder and Buddy texts, but they were not in the canary. They go
into v0.1.12.

`release.yml` requires two things of a final tag:
- **Provenance:** the canary record's pull request is merged into the default branch, and its
  merge commit is in the tag's history (`check-canary.ts --provenance`).
- **The same source:** the tag differs from the candidate only under `qualification/` and
  `docs/evidence/`.

On `main` the first holds and the second does not. So the tag stands on the branch
`release/v0.1.11`:
- it starts at the commit that merged this record into `main`;
- it adds one commit that restores the candidate's tree everywhere outside `qualification/` and
  `docs/evidence/`.

The merge is that commit's parent, so provenance holds. The diff against the candidate is exactly
this record and this file, so the same source holds.

The release cycle allows a final at "a commit that differs from [the candidate] only under
`qualification/` and `docs/evidence/`" (release cycle, point 3), and nothing requires that commit
to be on `main`. `main` keeps #619 and #623 for v0.1.12.

## Qualification

The candidate was published on 2026-10-24 at 20:15:32Z by Release run
[40127498399](https://github.com/Lazurio/LazurioPlatform/actions/runs/40127498399).

Qualify run [40128977902](https://github.com/Lazurio/LazurioPlatform/actions/runs/40128977902)
ran on the default branch (`workflow_run`) and succeeded:
- it left the artifact `qualification-v0.1.11-rc.6`, kept until 2027-01-22;
- `scripts/qualify/evidence.ts check` against the candidate's published `manifest.json` answers
  `v0.1.11-rc.6 is qualified: J1 J2 J3 J4 J5 J6 ok on linux-x64 and darwin-arm64`.

## Scope and how each Machine got the candidate

The scope is the pilot Organization's 4 work VMs, which are all of its Environments, plus one
operator's personal VM. The personal VM is outside the Organization, which has no personal
Environment (root decision 0204 point 7). The scope is not narrowed.

- **The work VMs** went through the pilot Organization's Machines lane, the path that pins their
  release, through the rollout pipeline (root decision 0205). The pull request's run computed the
  Plan and the merge's run applied it.
  - Push run 40130309195, merge `c81a80e7`.
  - The apply ended at **2026-10-24T21:15:38Z**, coming from `0.1.11-rc.5` (three VMs) and
    `0.1.11-rc.3` (one).
  - The apply restarted each Launchpad unit on the candidate between 20:46:22Z and 21:10:40Z.
    That was before the stage began.
- **The personal VM** got the candidate through its own lane in its Owner's Organization, also
  through the pipeline (push run 40129477762), with its Owner's consent. The apply ran from
  20:22:30Z to 20:35:43Z.

## The stage

The stage begins at **`2026-10-24T21:15:38Z`**, when the last Machine ran the candidate.

| Machine set | Start readings | End of its window | End readings |
|---|---|---|---|
| The 4 work VMs | 21:18:15–21:18:22Z: `recover` `healthy`, `update status` active `0.1.11-rc.6` | `2026-10-25T05:42:02Z` (8 h 26 min 24 s) | 05:41:53–05:42:00Z, below |
| The personal VM | 21:21:25Z: `recover` `healthy`, active `0.1.11-rc.6` | `2026-10-25T05:22:09Z` (8 h 6 min 31 s) | 05:22:08–05:22:09Z: `recover` `healthy`, Launchpad `NRestarts` 0, active `0.1.11-rc.6` |

- **The two ends differ on purpose.**
  - The work VMs' window was extended past 8 hours so that a Folder refresh and a deliberate
    Launchpad restart happen inside it (below).
  - The personal VM left the stage at 05:22:09Z: a planned change of its own lane (#695 in its
    Owner's Organization, merged 05:34:36Z; web chat and T3 Code 0.1.2, Platform unchanged) began
    after it.
  - The record's `end` is the later end, `2026-10-25T05:42:02Z`. The personal VM's own window
    is 8 h 6 min 31 s, and no reading of it after 05:22:09Z is part of this stage.
- **No Recovery mode, and no restart of its own.** Recovery mode is chosen only when the
  Launchpad starts. At the end, on every work VM:
  - the Launchpad unit had `NRestarts` 0;
  - its `ActiveEnterTimestamp` was the apply's start before the stage, except the one deliberate
    restart below.

  So no Launchpad started during the stage on its own. `recover` was `healthy` at the start and at
  the end, with the check `launchpad-health` answering `0.1.11-rc.6` (the Launchpad's `/health` in
  normal mode).
- **Recovery issues:** none. A search of the public repository for `0.1.11-rc.6` among issues
  created since 2026-10-24 finds none. The search for "recovery" over the same period finds only
  #625, an unrelated CLI build issue.

### Real work inside the stage

- **A Folder refresh and a deliberate Launchpad restart**, on work VM `06d5c433c545e38d`:
  - at 05:40:19Z, `lazurio machine folder-refresh` as the Machine's user answered
    `{"kind":"unchanged"}`;
  - then a deliberate `systemctl --user restart lazurio-launchpad.service`;
  - at 05:40:31Z the unit was active and running since 05:40:19Z, with `NRestarts` 0 (a
    deliberate restart does not count); `recover` was `healthy` and `/health` answered
    `0.1.11-rc.6`.
- **Module starts under the candidate** (`lazurio module start`, then the module's status):

  | Machine | knowledgebase (built App) | Mission Control (development run) |
  |---|---|---|
  | `06d5c433c545e38d` | running, healthy, built `e36834aa` (05:40:44Z) | running, healthy (05:40:44Z) |
  | `d94d6e912281c8e6` | running, healthy, built `e36834aa` (05:40:50Z) | not started |
  | `e0d566c46a1a84de` | running, healthy, built `e36834aa` (05:41:05Z) | running, healthy at 05:41:29Z |
  | `00910e1abf66fb61` | not applicable: this Team Environment holds no Organization content yet (a known installation gap, not of this candidate) | not applicable |

  At the end those apps' units were active.
- **Acceptance in the browser (root decision 0178),** as a member and as the Owner, between
  21:20Z and 21:35Z:
  - the Launchpad, Chat and Automate opened;
  - Nová karta named the knowledgebase's build, "Built version · main · e36834a";
  - after the knowledgebase pinned Bun 1.4.4 (#626), its build ran on that Bun, fetched into the
    runtime cache, while the user's own Bun stayed 1.4.2;
  - Mission Control, pinned to the user's Bun, started without any download;
  - the generated Folder texts read template revision base-instructions-73.

### Other changes on the same Machines during the stage

| When (UTC) | Machines | What | Platform |
|---|---|---|---|
| 2026-10-24 21:21–21:26Z | two work VMs | the knowledgebase module moved to `bun@1.4.4` (the acceptance of #626 above); content synchronization fast-forwarded it, and its built App was rebuilt and served | unchanged |
| 2026-10-24 22:50–22:59Z | two work VMs | the hypervisor's guest agent (qemu-guest-agent) timed out and restarted itself several times after read-only checks passed it non-ASCII arguments; no Lazurio unit restarted | unchanged |
| 2026-10-24 22:58–23:13Z | the personal VM | its Owner's personal assistant was installed on the candidate and checked | unchanged |

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` start / end | Launchpad health at end |
|---|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.11-rc.6 | healthy / healthy | 0 / 0 | 0.1.11-rc.6 |
| `06d5c433c545e38d` | work | 0.1.11-rc.6 | healthy / healthy | 0 / 0 (one deliberate restart) | 0.1.11-rc.6 |
| `d94d6e912281c8e6` | work | 0.1.11-rc.6 | healthy / healthy | 0 / 0 | 0.1.11-rc.6 |
| `e0d566c46a1a84de` | work | 0.1.11-rc.6 | healthy / healthy | 0 / 0 | 0.1.11-rc.6 |
| `8d49b01f67710c7a` | personal | 0.1.11-rc.6 (05:22:09Z) | healthy / healthy | – / 0 | – |

**How "start" is established.**
- **Work VMs:** `NRestarts` at the start is shown by the unit itself. Each work VM's unit was active
  since before the stage, and at the end it had `NRestarts` 0; a counter that is 0 at the end of an
  uninterrupted run was 0 at its start.
- **The deliberate restart on `06d5c433c545e38d`** resets that run, and its earlier run had the same
  reading at 05:37:32Z, just before it.
- **The personal VM:** its `NRestarts` and health version at the start were not read; its start
  reading is `recover` `healthy` only, which includes the Launchpad's health check.
