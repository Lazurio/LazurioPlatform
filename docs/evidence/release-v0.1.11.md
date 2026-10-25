# The canary of v0.1.11-rc.6 and the final release v0.1.11, 2026-10-24/25

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.11-rc.6` (source `b5c6521c3bac2cf4e01ac75fd6d535b312ed35f6`) ran for 8 hours
on every Environment of the pilot Organization, LazurioExampleOrganization, and on one operator's
personal VM. The final tag `v0.1.11` carries exactly its tree.

The record is [`qualification/canary/v0.1.11-rc.6.json`](../../qualification/canary/v0.1.11-rc.6.json),
added by the pull request that adds this file. Machines are opaque ids, as in the record. Which
Machine is which is kept only in the pilot Organization's own private records.

## Why the final tag is not on `main`

The final ships the candidate that passed the canary, nothing more. Two pull requests reached
`main` after the candidate was cut, during the merge freeze between the candidate and the final:
- #619 (`fda0a82f`): the request that the person does something goes through the question tool;
  template revision base-instructions-74.
- #623 (`9781aeda`): Buddy's wording; base-instructions-75.

Both are Folder and Buddy texts, reviewed and approved. They were not in the canary, so they go
into v0.1.12.

`release.yml` requires two things of a final tag:
- **Provenance.** The canary record's pull request is merged into the default branch, and its
  merge commit is in the tag's history (`check-canary.ts --provenance`).
- **The same source.** The tag differs from the candidate only under `qualification/` and
  `docs/evidence/`.

On `main` the first holds and the second does not. So the tag stands on the branch
`release/v0.1.11` instead:
- it starts at the commit that merged this record into `main`;
- it has one commit on top, which restores the candidate's tree everywhere outside
  `qualification/` and `docs/evidence/`.

The merge is that commit's parent, so provenance holds. The diff against the candidate is
exactly this record and this file, so the same source holds. The release cycle allows a final at
"a commit that differs from [the candidate] only under `qualification/` and `docs/evidence/`"
(release cycle, point 3); nothing requires that commit to be on `main`. `main` keeps #619 and
#623 for v0.1.12.

## Qualification

- **Published.** The candidate was published on 2026-10-24 at 20:15:32Z by Release run
  [40127498399](https://github.com/Lazurio/LazurioPlatform/actions/runs/40127498399).
- **Qualify.** Run [40128977902](https://github.com/Lazurio/LazurioPlatform/actions/runs/40128977902)
  ran on the default branch (`workflow_run`) and succeeded:
  - it left the artifact `qualification-v0.1.11-rc.6`, kept until 2027-01-22;
  - `scripts/qualify/evidence.ts check` against the candidate's published `manifest.json` answers
    `v0.1.11-rc.6 is qualified: J1 J2 J3 J4 J5 J6 ok on linux-x64 and darwin-arm64`.

## Scope and how each Machine got the candidate

The scope is the pilot Organization's 4 work VMs, which are all of its Environments, plus the
personal VM of one operator. The personal VM is outside the Organization, which has no personal
Environment (root decision 0204 point 7). The scope is not narrowed.

- **The work VMs** went through the pilot Organization's Machines lane, the path that pins their
  release, through the rollout pipeline (root decision 0205): the pull request's run computed the
  Plan, and the merge's run applied it. The apply ended at **2026-10-24T21:15:38Z**: push run
  40130309195 (merge `c81a80e7`), from `0.1.11-rc.5` (three VMs) and `0.1.11-rc.3` (one).
- **The personal VM** got the candidate through its own lane in its Owner's Organization, also
  through the pipeline (push run 40129477762), with its Owner's consent. Apply 20:22:30Z–20:35:43Z.

## The stage

- **Start:** `2026-10-24T21:15:38Z`, when the last Machine ran the candidate.
  - At 21:18:15–21:18:22Z each work VM answered `lazurio recover --json` `healthy` and
    `lazurio update status --json` active `0.1.11-rc.6`.
  - At 21:21:25Z the personal VM answered the same.
- **End:** `(pending the personal VM)` (pending).
  - At 05:20:49–05:21:05Z each work VM answered `recover` `healthy` and active `0.1.11-rc.6`, its
    Launchpad unit active and running with `NRestarts` 0.
  - At (pending) the personal VM answered `recover` `(pending)` and active
    `(pending)`.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. On every work VM
  the Launchpad unit had `NRestarts` 0 at the end, and `recover` was healthy at the start and at
  the end.
- **Acceptance in the browser, inside the stage (root decision 0178).** As a member and as the
  Owner:
  - the Launchpad, Chat and Automate opened;
  - Nová karta named the build of the knowledgebase module, "Built version · main · e36834a";
  - after a module pinned Bun 1.4.4 (#626), its build ran on that Bun, fetched into the runtime
    cache, while the user's own Bun stayed 1.4.2;
  - a module pinned to the user's Bun started without any download;
  - the generated Folder texts read template revision base-instructions-73.

### Other changes on the same Machines during the stage

| When (UTC) | Machines | What | Platform |
|---|---|---|---|
| 2026-10-24 21:21–21:26Z | two work VMs | the knowledgebase module moved to `bun@1.4.4` (the acceptance of #626 above): content synchronization fast-forwarded it, and its built App was rebuilt and served | unchanged |
| 2026-10-24 22:50–22:59Z | two work VMs | the hypervisor's guest agent (qemu-guest-agent) timed out and restarted itself several times, after read-only checks passed it non-ASCII arguments; nothing of Lazurio restarted (`NRestarts` 0 at the end) | unchanged |
| 2026-10-24 22:58–23:13Z | the personal VM | its Owner's personal assistant was installed on the candidate and checked | unchanged |

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.11-rc.6 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.11-rc.6 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.11-rc.6 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.11-rc.6 | healthy / healthy | 0 |
| `8d49b01f67710c7a` | personal | (pending) | healthy / (pending) | (pending) |
