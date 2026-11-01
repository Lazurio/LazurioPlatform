# Ring 0 and the smoke test of v0.1.19-rc.2, and the final release v0.1.19, 2026-11-01

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.19-rc.2` (source `e4862401582c7d3547127c8bc595da6e6b5788ff`) ran on every Environment of the
pilot Organization, LazurioExampleOrganization, and on one personal VM, each on the candidate. One recorded smoke
test as the pilot Organization's test accounts, its Owner and a member, then gave the green light at
`2026-11-01T03:34:50Z`. This is the first candidate under root decision 0166's addendum of 2026-10-31: the 8-hour
window is replaced by that smoke test, and the record is `lazurio.canary.v2` (#752). The final tag `v0.1.19` is to
carry the same product source and to differ from the candidate only under `qualification/` and `docs/evidence/`. The
final tag and its release do not exist yet; they follow the merge of the pull request that adds this file.

The record is [`qualification/canary/v0.1.19-rc.2.json`](../../qualification/canary/v0.1.19-rc.2.json). The pull
request that adds this file adds it too. Machines are opaque ids, as in the record, the same ids as in v0.1.18's
record: the same Machines, moved to another server (a host is not identity, #760). Which Machine is which is kept only
in the pilot Organization's own private records.

v0.1.19 contains everything in v0.1.18, which was not published as a final (#746), and adds:
- a Machine moved to another server keeps its Folder: the host leaves the binding's identity (#760, fixes #759);
- threads do not coordinate, the Environment's network is never switched, one worktree per pull request (#754);
- Guest Modules: another Organization's Module in the host's workspace, cloned and kept current, listed read-only,
  never run (#749);
- the smoke test replaces the 8-hour canary (#752);
- what Buddy writes to other people reads like a person (#738);
- Marketplace (#665), module stones (#325), the semantic palette (#514) and the rail's bounded retry (#742);
- the macOS jobs on `macos-15` (#741).

## The final tag

Nothing reached `main` after the candidate was cut except this record. So the final tag is planned on the commit
that merges this pull request into `main`:
- **provenance:** the record's pull request is merged into the default branch, and its merge commit is the tag's
  commit;
- **the same source:** the tag differs from the candidate only by this record and this file, both under the allowed
  paths.

If anything else reaches `main` before the tag, the tag goes on a branch `release/v0.1.19` instead, from that merge
commit with one commit on top restoring the candidate's tree outside `qualification/` and `docs/evidence/`, as
v0.1.17 did.

## Qualification

- **Published:** 2026-11-01 at 01:52:19Z by Release run
  [41262350081](https://github.com/Lazurio/LazurioPlatform/actions/runs/41262350081), first attempt.
  - Every check on `main` at `e4862401` passed, including macOS (run
    [41260750621](https://github.com/Lazurio/LazurioPlatform/actions/runs/41260750621)).
  - `v0.1.19-rc.1..v0.1.19-rc.2` adds #754 and #760. `v0.1.18-rc.1..v0.1.19-rc.1` added #665, #325, #738, #514, #742,
    #741, #749, #752 and the records #739, #744.
  - `v0.1.19-rc.1` (`2c51356d`) is not the candidate: its Ring 0 stopped at the first apply after the server move
    (#759).
- **Qualify:** run [41262858859](https://github.com/Lazurio/LazurioPlatform/actions/runs/41262858859) ran on the
  default branch (`workflow_run`) and succeeded (J1–J6 on `ubuntu-24.04` and `macos-15`), leaving the artifact
  `qualification-v0.1.19-rc.2`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, the rollout pipeline (root decision
0205): the Plan in the pull request, the apply on its merge. The pinned Machines release was v0.12.214.

**The rollout rule** was unchanged:
- T3 Code `0.1.2-lazurio.4` or newer (`.6` recommended, `.5` skipped);
- MausBot `0.1.115-lazurio.8` or newer;
- on Environments with Buddy, Hermes `0.22.4-lazurio.2` or newer.

Every Machine met it; T3 Code was `0.1.3-lazurio.1`. Buddy's installer did not run in this round.

**The server move first.** The work VMs had moved to another server of the pilot Organization the evening before. On
`v0.1.19-rc.1` the first apply after the move stopped at the Launchpad switch, because the Folder's binding still held
the old host (#759). `v0.1.19-rc.2` carries the fix (#760): in the same apply the new Platform was installed before the
Folder's `folder-init` and `folder-refresh`, which then answered `already-adopted` and recorded the new host.

- **Four work VMs (`00910e1abf66fb61`, `06d5c433c545e38d`, `e0d566c46a1a84de`, `15074d1280e87726`), revision A with
  the recovery of the stopped rc.1 apply, lane PR #219:**
  - merge `49423ed1` at 02:05:51Z;
  - push run 41263763310 applied it 02:06:32–02:43:39Z with success, Permit `mp_b5aa2376…`;
  - 128 of 133 checks passed. The fifth work VM's `release` check still failed (it was revision B's), and four
    `ai-ready` checks were unknown.
- **The personal VM (`11e08b191f0fc044`), its lane PR #218:**
  - merge `b336b038` at 02:12:28Z, after a fresh Plan that compared the same;
  - applied from the operator's Mac 02:12:39–02:22:18Z with success, `conformant`, Permit `mp_70ea2c99…`;
  - 20 of 21 checks passed. The Owner's acceptance stays pending until the Owner signs in.
  - Consent: its Owner's standing consent to Personal Environment updates.
  - The Folder re-rendered at template revision `base-instructions-97`; Buddy's Telegram connection reconnected
    (02:20:52Z).
- **The fifth work VM (`d94d6e912281c8e6`), revision B, lane PR #220:**
  - merge `ffca201d` at 03:04:20Z;
  - push run 41267677019 applied it 03:05:23–03:27:57Z with success, `conformant`, Permit `mp_6d846c2a…`;
  - in its readback every work VM passed `release`, `platform`, `launchpad-platform` and `lazurio-folder`; only the
    four `ai-ready` checks were unknown (user acceptance).

## The stage

- **Start:** `2026-11-01T03:27:57Z`, when the last Machine ran the candidate: the end of revision B's apply, whose
  readback passed the release and Launchpad checks of every work VM. The personal VM had run it since 02:22:18Z.
- **The smoke test, 03:29:15–03:34:50Z**, by one thread, before it 0 rollout runs in progress or queued and no lane
  marker held:
  - **as the Owner test account, 03:29:15–03:32:14Z: 8 of 8 passed:**
    1. sign-in with GitHub password and TOTP, then the Lazurio account at its Work Environment's Launchpad;
    2. Apps: 9 tiles, the same as before the round (nothing missing, added or newly unavailable);
    3. the chat answered in 27 s;
    4. Buddy on the Owner's Personal Environment replied in 17 s;
    5. two Organization modules, the knowledge base and the planning app, opened with HTTP 200 and their own headings;
    6. `lazurio update` reported `0.1.19-rc.2` up to date;
    7. its thread archived, nothing left in the sidebar;
    8. after sign-out a protected page asked for sign-in again.
  - **as the member test account, 03:32:26–03:34:50Z: 7 of 7 passed** (Apps 8 tiles as before, chat in 29 s, the
    update, cleanup and sign-out); this account has no Buddy, so that step was skipped.
  - **G.3 of #749** on both Work Environments and on the personal VM: `0.1.19-rc.2` (`e4862401`) everywhere, the
    Folder at `base-instructions-97` with `lazurio doctor` `template-revision` ok, no Guest Module declared (no
    `guest-module` check, no `guests` in `lazurio organization list --json`), and the Folder manual's Guest Module
    paragraph present on the Work Environments, absent on the personal VM by its preset.
  - **Doctor:** on the personal VM no new warning against the reading before the round (one fewer:
    `machine-binding: handover-changed`). The Work Environments had no reading before the move to compare with; their
    warnings are tools recommended but missing, modules without an app, a module the member does not see and the
    Codex app server's version, none about the change.
- **End:** `2026-11-01T03:34:50Z`, the green light. The result: green.
- **Recovery issues: none** (searched at 2026-11-01T03:38:50Z, every issue state): `label:recovery "0.1.19-rc.2"`, the
  `v0.1.19-rc.2` variant and any issue naming the candidate: 0.

### Per Machine

The reading was taken right after the green light, 03:41–03:44Z, read-only, by the thread that ran the smoke test. On
each Machine it ran `lazurio recover --json`, `lazurio update status --json`, the Launchpad unit's state and its
journal since 02:06Z, the start of Ring 0.

- **Read directly on four Machines:** the personal VM over the operator path; three work VMs through the chat of
  their own Environment, as the test accounts.
  - `recover` answered `healthy`, all five checks `ok` (`update-state-invalid`, `folder-state`, `self-check-failed`,
    `launchpad-unit`, `launchpad-health` with `0.1.19-rc.2`), no issue and no repair prompt.
  - `update status` answered active `0.1.19-rc.2`, and the Launchpad unit was active with `NRestarts` 0.
  - **Since 02:06Z** each journal shows exactly one stop and start of the Launchpad, at that Machine's own apply, and
    no Recovery line. Recovery mode is chosen only when the Launchpad starts, and the Launchpad that answered
    `healthy` at 03:41–03:44Z had run since before the start of the stage (03:27:57Z). So it was healthy at the start
    and at the end, with no Recovery mode in between.
- **Not read directly on two work VMs (`e0d566c46a1a84de`, `15074d1280e87726`):**
  - `15074d1280e87726`'s chat could not answer: its coding agent is not signed in on that Environment.
  - Neither test account is admitted to `e0d566c46a1a84de`.
  - There is no operator path to the new server's guests.
  - **What there is:** the readback of revision B's apply at 03:27:57Z, the start of the stage. Its checks passed on
    both:
    - `release`: the guest's receipt matches the declaration, which pins `0.1.19-rc.2`;
    - `launchpad-platform`: the installer's Launchpad unit is active and enabled, and its health socket answers `200`
      with a version. A Launchpad in Recovery mode answers `503`, so neither was in Recovery mode at the start.
    - `platform`, `lazurio-folder` and `resident-config`.
  - **What there is not:** a `recover`, `update status`, unit or journal value, and any reading at the end of the
    stage. Their `active` and `healthy` in the record stand on that start readback alone. The gap is open in
    #763.

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end | Read |
|---|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.19-rc.2 | healthy / healthy | 0 | 03:43:31Z, its chat |
| `06d5c433c545e38d` | work | 0.1.19-rc.2 | healthy / healthy | 0 | 03:41:54Z, its chat |
| `d94d6e912281c8e6` | work | 0.1.19-rc.2 | healthy / healthy | 0 | 03:41:51Z, its chat |
| `e0d566c46a1a84de` | work | not read; receipt of the `0.1.19-rc.2` declaration at 03:27:57Z | not read; Launchpad serving at 03:27:57Z | not read | readback only |
| `15074d1280e87726` | work | not read; receipt of the `0.1.19-rc.2` declaration at 03:27:57Z | not read; Launchpad serving at 03:27:57Z | not read | readback only |
| `11e08b191f0fc044` | personal | 0.1.19-rc.2 | healthy / healthy | 0 | 03:41:03Z, operator path |
