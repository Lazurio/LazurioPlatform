# The canary of v0.1.9-rc.6 and the final release v0.1.9, 2026-10-18/19

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary): the candidate
`v0.1.9-rc.6` (source `4680c44fafe15cb05e80ce27bdb9b7eec850097f`) ran for 8 hours on every
Environment of the pilot Organization, LazurioExampleOrganization, and on one operator's personal
VM, before the final tag `v0.1.9` at the same source.
The record is [`qualification/canary/v0.1.9-rc.6.json`](../../qualification/canary/v0.1.9-rc.6.json).
Machines are opaque ids, as in the record. Which Machine is which is kept only in the pilot
Organization's own private records.

## Qualification

The candidate was published on 2026-10-18 at 14:24:13Z. Qualify run
[39135833261](https://github.com/Lazurio/LazurioPlatform/actions/runs/39135833261)
ran on the default branch (`workflow_run`) and succeeded:
- it left the artifact `qualification-v0.1.9-rc.6`, kept until 2027-01-16;
- `scripts/qualify/evidence.ts check` against the candidate's published `manifest.json`
  answers `v0.1.9-rc.6 is qualified: J1 J2 J3 J4 J5 J6 ok on linux-x64 and darwin-arm64`;
- the manifest's `source_commit` is `4680c44fafe15cb05e80ce27bdb9b7eec850097f`.

## Scope

The pilot Organization's 3 work VMs, which are all of its Environments, and the personal VM of
one operator. The personal VM is outside the Organization, which has no personal Environment
(root decision 0204 point 7). The scope was not narrowed.

How each Machine got the candidate:
- **The work VMs** went through the pilot Organization's Machines lane, the path that pins their
  release:
  - Plan `a28985f6`, captured 16:00:00Z;
  - Permit `mp_5b869d03…`;
  - apply 16:06:38Z–16:34:59Z, `success`, healthy and conformant;
  - evidence commit `041314b6` on the lane's evidence branch.

  The Launchpad units were switched to the candidate at 16:15:13Z, 16:22:50Z and 16:31:00Z.
- **The personal VM** used its own updater (`lazurio update --version v0.1.9-rc.6`, which verifies
  the release's attestation) at 15:00:05Z–15:00:20Z, followed by `lazurio machine folder-refresh`
  (template `base-instructions-57`), as the hosting apply does. Its Launchpad unit started on the
  candidate at 15:00:15Z.
  - This departs from G.3, which says each Machine is rolled "through the path that pins its
    release". The personal lane's pin was not raised for this candidate, just as for
    `v0.1.8-rc.70`: a pin is a minimum (root decision 0161, addendum of 2026-09-28).

## The stage

- **Start:** `2026-10-18T16:37:43Z`. At that moment the last Machine was proven on the candidate:
  - `lazurio update status --json` active and running `0.1.9-rc.6`;
  - Launchpad health on the candidate in normal mode;
  - `lazurio recover --json` healthy.
- **End:** `2026-10-19T00:43:06Z` (8 h 5 min).
- **Observation:** a read-only round on every Machine every 30 minutes. Each round reads:
  - `update status`, `self-check` and `recover`;
  - the Launchpad's health;
  - the Launchpad unit's state, `NRestarts` and start time;
  - the module app units, the Folder revision and the T3 Code version.

  The host that ran the rounds was kept awake for the whole stage, and no two consecutive rounds
  were more than 30.3 minutes apart.

  Rounds (UTC, Machines on the candidate and healthy / Machines): 2026-10-18T16:37:43Z 4/4; 2026-10-18T16:38:17Z 4/4; 2026-10-18T17:08:28Z 4/4; 2026-10-18T17:38:46Z 4/4; 2026-10-18T18:08:56Z 4/4; 2026-10-18T18:39:07Z 4/4; 2026-10-18T19:09:16Z 4/4; 2026-10-18T19:39:28Z 4/4; 2026-10-18T20:09:39Z 4/4; 2026-10-18T20:39:50Z 4/4; 2026-10-18T21:10:01Z 4/4; 2026-10-18T21:40:12Z 4/4; 2026-10-18T22:10:24Z 4/4; 2026-10-18T22:40:34Z 4/4; 2026-10-18T23:10:43Z 4/4; 2026-10-18T23:40:52Z 4/4; 2026-10-19T00:11:02Z 4/4; 2026-10-19T00:41:12Z 4/4; 2026-10-19T00:43:06Z 4/4.
- **No Recovery mode between the rounds:**
  - Recovery mode is chosen only when the Launchpad starts (`startOrRecover` in
    `src/launchpad/recovery-mode.ts` at the candidate's tag).
  - On every Machine, the Launchpad unit's `ActiveEnterTimestampMonotonic` is the same in all
    19 rounds, with `NRestarts` 0. The process that the candidate's activation started ran
    the whole stage, and every round found it in normal mode on the candidate.
- **Recovery issues:** none. A search of the public repository (state all, created since
  2026-10-18) for `0.1.9-rc.6` finds one issue: #507, reported 2026-10-19T05:39Z. It lists
  wording and display discrepancies in the Composio path, found in an end-to-end browser test.
  It is not a Recovery issue and does not report a health fault.

## Other changes on the same Machines during the stage

Other work changed things on the stage's Machines during the stage. None of it changed the
Platform. In every round after each change, all four Machines still ran `0.1.9-rc.6` with
`recover` healthy, and the Launchpad unit had the same start time with `NRestarts` 0.

| When (UTC) | Machines | What | Platform |
|---|---|---|---|
| 2026-10-18 16:37:58–16:38:07Z | work VM `f1040cafc798ecf0` | T3 Code 0.1.0-preview.20261018.1 installed in the guest. Only the T3 Code service restarted. | unchanged |
| 2026-10-18 17:51:57–18:17:25Z | the 3 work VMs | the lane's apply of Machines v0.12.174: memory drop-ins (`MemoryLow`) applied by `daemon-reload` without a restart; T3 Code kept on all three. Result: `success`, healthy, conformant. | unchanged |
| 2026-10-18 19:51:26–19:52:31Z | the work VMs' host | a host-only apply on Machines v0.12.176 failed at its host step (trust of the rollout gateway's CA), and that trust was never written; no guest step ran | unchanged |
| 2026-10-18 21:19:15–21:44:50Z | the work VMs' host and the 3 work VMs | the reviewed recovery of that apply on Machines v0.12.177. The guest reconciles were no-ops for the Platform. Result: `success`, healthy, conformant. | unchanged |
| 2026-10-19 00:21:18–00:42:30Z | the 3 work VMs | the lane's apply of Lazurio MausBot 0.1.115-lazurio.2. Result: `success`, healthy, conformant. | unchanged |

The personal VM had no change during the stage.

**After the stage:**
- The lane's first apply through the rollout pipeline (Machines v0.12.180, 2026-10-19
  02:46:33Z–03:11:18Z) reconciled the work VMs again, including their Launchpad switch actions.
- A read-only round at 2026-10-19T05:47:18Z found all four Machines still on `0.1.9-rc.6`,
  `recover` healthy, `NRestarts` 0 and each Launchpad unit's start time unchanged.

## Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` start / end | Launchpad health at end | Module apps active start / end |
|---|---|---|---|---|---|---|
| `146fb920b36d943c` | work | 0.1.9-rc.6 | healthy / healthy | 0 / 0 | 0.1.9-rc.6 | 3 / 3 (failed 0) |
| `482d0d709bcc19df` | personal | 0.1.9-rc.6 | healthy / healthy | 0 / 0 | 0.1.9-rc.6 | 2 / 2 (failed 0) |
| `a2a75fc428e8dbad` | work | 0.1.9-rc.6 | healthy / healthy | 0 / 0 | 0.1.9-rc.6 | 0 / 0 (failed 0) |
| `f1040cafc798ecf0` | work | 0.1.9-rc.6 | healthy / healthy | 0 / 0 | 0.1.9-rc.6 | 1 / 3 (failed 0) |

"Module apps active" counts the module app units (`lazurio-app-*`) running at the start and at
the end of the stage. No module app failed in any round.

## Module starts and real work

- **Module starts under the candidate**, through the Platform Launchpad, on work VM
  `f1040cafc798ecf0`:
  - At 16:41:11Z, Mission Control's tile was opened for the first time. Its declared data mount
    was absent, so the candidate fetched it at that Open (#476). Mission Control opened with
    its 13 plans within 5 s, with no refusal.
  - The Knowledgebase app opened, was closed and was opened again.
  - That Machine's module apps went from 1 to 3, and stayed running to the end.
- **Opened after Machines v0.12.174 was applied:** the Knowledgebase opened and rendered on
  `f1040cafc798ecf0` (18:44:58Z) and on `146fb920b36d943c` (18:45:46Z).
- **Modules already running at the start** (3 on one work VM, 2 on the personal VM) were still
  running at the end. None stopped or failed.
- **Folder writes:** two quick Settings saves in a row on `f1040cafc798ecf0` (#494) moved its
  Folder from revision 6 to 10, with no "busy" refusal.
- **Folder refresh and Launchpad restart.** G.3 asks for one of each during real work. Neither
  was done during the stage:
  - The last Launchpad start on every Machine was the candidate's own activation, just before
    the stage.
  - The last Folder refresh was the personal VM's, at 15:00:20Z.
  - The browser acceptance below deliberately left both out.
  - **Done after the stage, on the candidate.** The release reviewer ran both on work VM
    `f1040cafc798ecf0` at 2026-10-19T05:56:10–05:56:16Z, before the final tag:
    `lazurio machine folder-refresh` as the Machine's user (`unchanged`, exit 0), then a
    deliberate `systemctl --user restart lazurio-launchpad.service` (exit 0). The unit came
    back active at 05:56:11Z with `NRestarts` 0 (a deliberate restart does not count), and
    `lazurio recover --json` answered `healthy` on 0.1.9-rc.6. A round at 05:56:54Z found all
    three work VMs on the candidate and healthy, and the Machine's public Launchpad name
    answered its sign-in redirect. This is a deviation from G.3's "during the stage": the
    item proves the same behavior on the same bytes, a few hours later. It does not shorten
    the 8 hours.

## Browser acceptance (root decision 0178)

- **On the pilot Organization, 2026-10-18 16:40–17:10Z.** An agent ran the checks with the
  designated test accounts (the Owner and a member) in its own browser profiles. On all three
  work VMs, the version page shows 0.1.9-rc.6.
  - **Passed:**
    - sign-in through the gateway, and sign-out and sign-in again in a single tab;
    - Launchpad and Apps;
    - a member refused on an Environment she was not given (403);
    - Mission Control's data mount, fresh and already present (#476);
    - Nastavení → Trezor without a vault, in Czech and in English (#481);
    - Chat's default model (#477) and Chat pairing (#486);
    - the rail and the column band at 1440 px and 390 px (#485);
    - two quick saves (#494).
  - **Not run:** #487's refusal path, because no refusal occurred.
  - **Partial:** the Composio sign-in dialog (#480), because Composio was already connected.
  - **Not in LazurioPlatform:** one observation concerns the hosted gateway. Signing out with
    other tabs of the same Environment open does not finish.
  - No defect was found in LazurioPlatform.
- **Again after Machines v0.12.174 was applied, 18:19–18:46Z**, with the same accounts:
  - sign-in, the Launchpad on 0.1.9-rc.6, Chat pairing and the module opens above;
  - the visitors' path on the public Environment.
- **The personal VM** was accepted in the browser by its Owner after the update, at about
  15:05Z.

## Result

Every Machine ran the candidate for the whole stage:
- `lazurio recover --json` healthy at the start, at the end and in every round;
- no Recovery mode, no automatic Launchpad restart and no failed module app;
- modules start and open under the candidate (see *Module starts and real work*).

The record passes `scripts/qualify/check-canary.ts`. The pilot Organization's release reviewer
adds it in [508](https://github.com/Lazurio/LazurioPlatform/pull/508).

## The final tag

`main` has moved since the candidate, so `v0.1.9` is not a commit of `main`. It is a commit
whose parent is this pull request's merge commit and whose tree is exactly `v0.1.9-rc.6`'s tree
plus this record and this evidence, taken from that merge commit, as for
[`v0.1.8`](release-v0.1.8.md). Release's job `qualified` checks three things on it:
- the diff from the candidate is only under `qualification/` and `docs/evidence/`;
- `check-canary.ts --provenance`;
- the qualification artifact above.
