# Ring 0 and the smoke test of v0.1.19-rc.2, and the final release v0.1.19, 2026-11-01

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.19-rc.2` (source `e4862401582c7d3547127c8bc595da6e6b5788ff`) ran on every Environment of the
pilot Organization, LazurioExampleOrganization, and on one personal VM. In the stage from `2026-11-01T08:53:54Z` to
`09:11:52Z` every Machine in its scope was read at both edges, and one recorded smoke test as the pilot
Organization's test accounts, its Owner and a member, passed between the readings; the green light ends it. The
scope is Matěj's decision of 2026-11-01 in root decision 0166's register (HumanAndMachines/Lazurio#695): the public
Environment for visitors is out of it, and the Prostředí služeb is checked by what belongs to it, first its AI pool
(the CLI Proxy API), through Machines' readback of its services. The record carries the four Machines read
directly. This is the first candidate under root decision 0166's addendum of 2026-10-31: the 8-hour window is
replaced by the smoke test, and the record is `lazurio.canary.v2` (#752). The final tag `v0.1.19` is to
carry the same product source and to differ from the candidate only under `qualification/` and `docs/evidence/`. The
final tag and its release do not exist yet; they follow the merge of the pull request that adds this file.

The record is [`qualification/canary/v0.1.19-rc.2.json`](../../qualification/canary/v0.1.19-rc.2.json). The pull
request that adds this file adds it too. Machines are opaque ids, as in the record, the same ids as in v0.1.18's
record: the same Machines, moved to another server (a host is not identity, #760). Which Machine is which is kept only
in the pilot Organization's own private records; the two Environments outside the record are named here by their
kind only.

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

All 5 Environments of the pilot Organization, its work VMs, plus one personal VM got the candidate. The stage's
scope is narrowed for this candidate only, by Matěj (HumanAndMachines/Lazurio#695; see [Per Machine](#per-machine)).
Each Machine got the candidate through the path that pins its release, the rollout pipeline (root decision
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

- **Four work VMs (`00910e1abf66fb61`, `06d5c433c545e38d`, the Prostředí služeb and the public Environment for
  visitors), revision A with the recovery of the stopped rc.1 apply, lane PR #219:**
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

**A first stage, 03:27:57–03:34:50Z, does not count.** Its smoke test passed (the Owner 8 of 8, the member 7 of 7),
but its Machines were read only after its green light (03:41–03:44Z) and not at its start. So it was repeated with a
reading at each edge; nothing was deployed in between.

**The repeated stage, 2026-11-01, by one thread, read-only except the smoke test:**

1. **Quiet check, 08:50:12Z:** 0 rollout runs in progress or queued, and no lane marker held.
2. **R1, 08:50:12–08:53:54Z**, on every Machine in the record (see [Per Machine](#per-machine)). **Start:**
   `2026-11-01T08:53:54Z`, the end of R1, the first reading that observed every Machine in scope healthy on the
   candidate. The last Machine had got it at 03:27:57Z.
3. **The Prostředí služeb, at the start:** a read-only Plan of its lane (run 41290779466), readback observed at
   08:57:03Z, before the smoke test began.
4. **The smoke test, 08:57:29–09:03:06Z:**
   - **as the Owner test account, 08:57:32–09:00:28Z: 8 of 8 passed:**
     1. sign-in with GitHub password and TOTP, then the Lazurio account at its Work Environment's Launchpad;
     2. Apps: 9 tiles, the same as before the round (nothing missing, added or newly unavailable);
     3. the chat answered in 29 s;
     4. Buddy on the Owner's Personal Environment replied in 17 s;
     5. two Organization modules, the knowledge base and the planning app, opened with HTTP 200 and their own
        headings;
     6. `lazurio update` reported `0.1.19-rc.2` up to date;
     7. its thread archived, nothing left in the sidebar;
     8. after sign-out a protected page asked for sign-in again.
   - **as the member test account, 09:00:38–09:03:06Z: 7 of 7 passed** (Apps 8 tiles as before, the chat, the
     update, cleanup and sign-out); this account has no Buddy, so that step was skipped.
   - **G.3 of #749** on both Work Environments and on the personal VM: `0.1.19-rc.2` (`e4862401`) everywhere, the
     Folder at `base-instructions-97` with `lazurio doctor` `template-revision` ok, no Guest Module declared (no
     `guest-module` check, no `guests` in `lazurio organization list --json`), and the Folder manual's Guest Module
     paragraph present on the Work Environments, absent on the personal VM by its preset.
   - **Doctor:** on the personal VM no new warning against the reading before the round (one fewer:
     `machine-binding: handover-changed`). The Work Environments had no reading before the move to compare with; their
     9 warnings each, the same as in the first stage, are tools recommended but missing, modules without an app, a
     module the member does not see and the Codex app server's version, none about the change.
5. **R2, 09:03:25–09:06:46Z**, the same reading on every Machine in the record.
6. **The Prostředí služeb, at the end:** a read-only Plan of its lane (run 41291771491), readback observed at
   09:11:14Z.
7. **End:** `2026-11-01T09:11:52Z`, the green light, given only after R2 and the second readback passed. The result:
   green.

- **Recovery issues: none** (searched at 2026-11-01T03:38:50Z, 08:40:43Z and, after the green light, 09:14:10Z, every issue state):
  `label:recovery "0.1.19-rc.2"` and the `v0.1.19-rc.2` variant: 0. Issues that mention the candidate, none of them a
  Recovery issue: #759 (the move, fixed in it), #763 and #771 (how to read two Environments after the move).

### Per Machine

**The scope (HumanAndMachines/Lazurio#695).** After the move two work VMs could not be read by an agent (#763): the
Prostředí služeb, whose Codex is not signed in and whose Settings offers no Codex or Claude sign-in (#771), and the
public Environment for visitors, to which no test account is admitted. Matěj decided on 2026-11-01, for this
candidate only:
- the public Environment for visitors is out of the stage's scope ("try-01 je veřejná mašina, kvuli ní nemusíme
  blokovat release");
- the Prostředí služeb is checked by what belongs to it, first its signed-in CLI Proxy API, the Organization's AI pool
  ("V prostředí služeb mě hlavně zajímá, aby fungovalo CLI Proxy API, které je přihlášené"), through Machines'
  readback of its services at the start and the end of the window; a Codex sign-in or an agent reading there is not a
  condition.

So the record lists the four Machines read directly, and nothing in it rests on a readback.

**The four Machines in the record**, read in R1 and R2: the personal VM over the operator path, three work VMs
through the chat of their own Environment, as the test accounts. Each reading ran `lazurio recover --json`, `lazurio
update status --json`, the Launchpad unit's state and its journal since 02:06Z, the start of Ring 0.
- **At both edges** `recover` answered `healthy`, all five checks `ok` (`update-state-invalid`, `folder-state`,
  `self-check-failed`, `launchpad-unit`, `launchpad-health` with `0.1.19-rc.2`), no issue and no repair prompt, and
  `update status` answered active `0.1.19-rc.2`.
- **No restart in the stage:** the Launchpad unit's `NRestarts` (0), `ActiveEnterTimestamp` and the journal's start
  and stop lines are the same in R1 and R2: one stop and start each, at that Machine's own apply, and no Recovery line.
  The smoke test's `lazurio update` restarted nothing.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | Launchpad `NRestarts`, active since |
|---|---|---|---|---|---|---|
| `00910e1abf66fb61` | work | 08:52:42Z | 09:05:38Z | healthy / healthy | 0.1.19-rc.2 / 0.1.19-rc.2 | 0, 02:22:20Z |
| `06d5c433c545e38d` | work | 08:51:00Z | 09:04:00Z | healthy / healthy | 0.1.19-rc.2 / 0.1.19-rc.2 | 0, 02:36:54Z |
| `d94d6e912281c8e6` | work | 08:50:57Z | 09:03:57Z | healthy / healthy | 0.1.19-rc.2 / 0.1.19-rc.2 | 0, 03:21:08Z |
| `11e08b191f0fc044` | personal | 08:50:25Z | 09:03:30Z | healthy / healthy | 0.1.19-rc.2 / 0.1.19-rc.2 | 0, 02:18:36Z |

**The Prostředí služeb, checked by its services.** Each readback is a read-only Plan of its lane, from a README-only
Draft in the Organization's Deployment Repo that was never merged: no apply and no Permit.

| | Start (run 41290779466, observed 08:57:03Z) | End (run 41291771491, observed 09:11:14Z) |
|---|---|---|
| `ai-pool-members`, `ai-pool-roster` (the AI pool, its CLI Proxy API) | pass | pass |
| the pool's accounts by state | 2 `ok`, 0 failed | 2 `ok`, 0 failed |
| `ai-pool` of each of the three work VMs (token, files, catalog and authenticated access from the VM) | pass | pass |
| `release` (receipt of the declaration that pins `0.1.19-rc.2`) | pass | pass |
| `launchpad-platform` (the installer's Launchpad unit active, its health socket answering `200`; `503` in Recovery mode) | pass | pass |
| `resident-config` | pass | pass |

Not proven: which provider the smoke test's chats used; their records name only the model. On the lane only the
`ai-ready` checks of the work VMs do not pass; they stay unknown until user acceptance. GitHub lists the start run's
creation at 09:54:15Z, after it had finished; the observation time above is the readback's own.

**The public Environment for visitors** is outside the scope. For information only, the readbacks of the first stage
(03:27:57Z and 03:59:10Z) passed every check of it except `ai-ready`.
