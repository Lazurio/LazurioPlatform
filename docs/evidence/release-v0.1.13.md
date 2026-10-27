# The canary of v0.1.13-rc.1 and the final release v0.1.13, 2026-10-26/27

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.13-rc.1` (source `2bd9b43852576ac01b89dc72c45db22a568f3506`) ran for 8 hours, directly observed, on every
Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The final tag `v0.1.13`
carries the same product source; it differs from the candidate only by this record and this file, under
`qualification/` and `docs/evidence/`, as the release cycle allows.

The record is [`qualification/canary/v0.1.13-rc.1.json`](../../qualification/canary/v0.1.13-rc.1.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine is
which is kept only in the pilot Organization's own private records.

## Why the final tag is not on `main`

The final ships the candidate that passed the canary, nothing more. One pull request reached `main` after the
candidate was cut, during the merge freeze: #661 (`bbad4adf`), a personal Environment working in the account's
default Composio organization. It was opened after the freeze was announced on the open pull requests, so it
carried no notice of it. It was not in the canary, so it goes into v0.1.14.

`release.yml` requires two things of a final tag:
- **provenance:** the canary record's pull request is merged into the default branch, and its merge commit is in
  the tag's history;
- **the same source:** the tag differs from the candidate only under `qualification/` and `docs/evidence/`.

On `main` the first holds and the second does not. So the tag stands on the branch `release/v0.1.13`. It starts
at the commit that merged this record into `main` and has one commit on top, which restores the candidate's tree
everywhere outside `qualification/` and `docs/evidence/`. The merge is that commit's parent, so provenance holds.
The diff against the candidate is exactly this record and this file, so the same source holds. This is the path
v0.1.11 took (`docs/evidence/release-v0.1.11.md`).

## Qualification

- **Published:** the candidate was published on 2026-10-26 by Release run
  [40292886437](https://github.com/Lazurio/LazurioPlatform/actions/runs/40292886437). Every check on `main` at `2bd9b438`
  passed, including macOS.
- **Qualify:** run [40293858858](https://github.com/Lazurio/LazurioPlatform/actions/runs/40293858858) ran on the default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.13-rc.1`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, through the rollout pipeline
(root decision 0205): the Plan in the pull request, the apply on its merge.

**The rollout rule of this release** is that T3 Code `0.1.2-lazurio.4` and MausBot `0.1.115-lazurio.8` reach an
Environment no later than the Platform. Every Machine of the stage got all three in one apply.

- **Four work VMs, the pilot Organization's lane #171:** merge `8dd1af37`; push run 40298513627 applied it
  09:18:34–10:04:30Z with success.
- **The fifth work VM (`d94d6e912281c8e6`), lane #172:**
  - merge `7bccfd3c`; push run 40316546035 applied it 11:38:32–11:55:53Z with success;
  - it went straight from 0.1.12-rc.2 to the candidate, because a pin is a minimum;
  - its T3 Code was already a build of the same commit as `0.1.2-lazurio.4`, so it was not reinstalled.
- **The personal VM (`11e08b191f0fc044`), its lane #170:**
  - merge `70f24ded`, applied from the operator's Mac 13:39:41–13:52:11Z with success, conformant;
  - consent: its Owner's standing consent to Personal Environment updates, recorded on the exact Plan digest.

## The stage

- **Start:** `2026-10-26T13:53:42Z`, the first reading that observed every Machine healthy on the candidate. The last Machine got
  it at 13:52:11Z (the personal VM).
  - At 13:53:25–13:53:34Z every work VM answered `lazurio recover --json` `healthy` (the Launchpad's `/health` on 0.1.13-rc.1) and `lazurio update status --json` active `0.1.13-rc.1`, its Launchpad unit with `NRestarts` 0. At 13:53:42Z the personal VM answered the same; its Launchpad had started at 13:47:07Z with the apply.
- **End:** `2026-10-26T21:55:46Z`, 8 h 2 min 4 s after the start.
  - At 21:55:30–21:55:40Z each work VM answered `recover` `healthy` and active `0.1.13-rc.1`, its Launchpad unit active since the deliberate restart of 13:54Z with `NRestarts` 0; its user journal since 13:47Z shows only that restart (one `Stopping`, `Stopped`, `Started`) and no other start, stop, scheduled restart or failure. At 21:55:46Z the personal VM answered the same; its journal since 13:47Z shows only the apply's start at 13:47:07Z, before the stage. Readings in between, at 17:00Z and 20:38Z, were the same on all six.
- **Recovery issues: none** (searched at 2026-10-26T21:55:56Z, every issue state):
  - `repo:Lazurio/LazurioPlatform is:issue label:recovery "0.1.13-rc.1"` and the `v0.1.13-rc.1` variant: 0;
  - issues naming `0.1.13-rc.1` at all: 2, #659 and #660, both observations from the stage's own Buddy check (a missing journal line, and a Folder refresh answering `unchanged` while it restored a file); neither is a Recovery issue. Issues mentioning recovery created since the candidate: 0.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage
  (the deliberate restarts below) came up `healthy`. Every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **13:54:10–13:54:21Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`), then a
   deliberate Launchpad restart. At 13:54:22–33Z each Launchpad was active since its restart, `NRestarts` 0,
   `recover` `healthy` on 0.1.13-rc.1.
2. **13:54:36–13:55:12Z, module starts** on the three work VMs that hold the Organization's modules: a static
   content module served as a build of its commit, and the Organization's planning app, with its own server,
   running from `main` as one production process through `start_script`, healthy on all three.
3. **14:00:18–14:00:26Z, the one `lazurio update` through Nová karta's Update,** as the Owner test account on its Work
   Environment: every module and Lazurio "Up to date", Lazurio "Up to date, version 0.1.13-rc.1" with no downgrade
   to the older public release; nothing restarted; no codes or paths on the page.
4. **#652 on the personal VM (Buddy's rules reach his running conversations by themselves):**
   - the update itself refreshed Buddy's stored prompts 11 s after the Launchpad's start (13:47:18Z), including the
     web chat's ended session, with one Buddy gateway restart and nothing done by hand;
   - a one-byte change to a file of Buddy's layer (14:06:35Z) was refreshed 32 s later; `lazurio machine
     folder-refresh` restored it (14:10:58Z) and the refresh followed within 11 s. The change was reverted.
     Only Buddy's gateway restarted; the Launchpad unit kept running since 13:47:07Z.
5. **14:12:20–14:30:52Z, Buddy acceptance as the Owner test account** on the personal VM:
   - the launcher sits in the same bottom-right corner (22/22 px) in the Launchpad, T3 Code and MausBot, at 1440 and
     390 px wide (#647); T3 Code's and MausBot's composers keep room for it, and Send stays visible at 390 px;
   - full screen fills the viewport; Buddy presents the guide himself (#649);
   - Buddy's surface shows only Normal/Fast; its theme follows the page; one message got one answer.

### Other changes on the same Machines during the stage

| When (UTC) | What | Effect on the candidate |
|---|---|---|
| none | No other change touched the stage's Machines: no apply on the pilot Organization's lanes after 13:52:11Z | — |

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.13-rc.1 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.13-rc.1 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.13-rc.1 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.13-rc.1 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.13-rc.1 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.13-rc.1 | healthy / healthy | 0 |
