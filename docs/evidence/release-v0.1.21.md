# Ring 0 and the smoke test of v0.1.21-rc.6, and the final release v0.1.21, 2026-11-13

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.21-rc.6` (source `00dec36b5256649d3017896f7ba7217e77eb5a41`) ran on every Environment of the
pilot Organization, LazurioExampleOrganization, all four of them, and on one personal VM. The last of them got the
candidate at `2026-11-13T09:22:26Z`, which is the start of the stage. In the stage that followed:

- every Machine was read at both edges;
- a Folder refresh and a Launchpad restart ran on the personal VM, and a Folder refresh ran on one Work Environment;
- one recorded smoke test passed between the readings, as the pilot Organization's test accounts, its Owner and a
  member: sign-in, the Launchpad and its Apps, modules started and opened, the chat, Settings → Připojení, the
  Marketplace with its seven templates, and what the last candidates added (#743, #931 and the fix of #111, with
  `lazurio doctor` reporting `machine-binding ok`).

The green light at `2026-11-13T09:32:56Z` ends the stage. The record is `lazurio.canary.v2` (#752).

The final tag `v0.1.21` is to carry the candidate's product source and to differ from it only under `qualification/`
and `docs/evidence/`. The final tag and its release do not exist yet. They follow the merge of the pull request that
adds this file.

The record is [`qualification/canary/v0.1.21-rc.6.json`](../../qualification/canary/v0.1.21-rc.6.json), added by the
same pull request as this file. Machines are opaque ids, as in the record: the first 16 hex digits of an HMAC-SHA-256
under a key kept only by the release thread's station, so they cannot be recomputed from a name. The key is the one
of v0.1.20's record, so every Machine keeps the id it had there. The public Environment for visitors was retired
before this stage (LazurioExampleOrganization/machines#266) and is not in the record. Which Machine is which is kept
only at the station.

v0.1.21 adds to v0.1.20:
- **Modules explained in Apps** (#882; F36's addendum of 2026-11-05 and F56's addendum (8)):
  - "+ Nový modul" is a dialog of three screens that hands the brief to Chat;
  - a member gets the tile muted and asks the Organization Admin instead;
  - Zkontrolovat přístupy runs the Organization's synchronization at once;
  - Apps' "?" plays the video of modules, and Začínáme ends Volitelné with "Poznejte moduly".

  What agents know about modules is in the Folder (#880).
- **The Marketplace of templates:**
  - the offers come from the public registry `Lazurio/marketplace` at one commit (#820), and the built-in copy holds
    its released templates (#844);
  - the adoption brief runs `lazurio module create` with the target and Teams, and takes a release into an existing
    module instead of creating a duplicate (#908);
  - the first read after a registry change waits for the registry's answer (#922);
  - the stack profiles of release 2026.11 (#821, F69).
- **Chat and Automate from the Launchpad** follow the apps' plain origins, with no pairing on the way; the apps pair a
  browser without a session themselves (#743, F36's addendum of 2026-10-31).
- **The Folder's machine binding:**
  - `folder-refresh` records the Owner Organization by its lower-cased `organization_key` (#931, F10's addendum of
    2026-11-11);
  - it records a rewritten handover's digest, `refreshed` with `bindingRebound: "handover-digest"`, so
    `lazurio doctor` reports `machine-binding ok` after it (#940, fixes #111).
- **The Organization Admin and access:** decisions 0228–0233 (#839, #852, #865, #885, #897, #899) and the manual and
  skill `admin-request` (#860), `lazurio organization role` (#868), and a module that learns who came only through
  module-kit `appAccess` (#874). A module whose access proved to have ended leaves the Environment (#896, F72).
- **Agents in the Folder:**
  - the skills `ui-craft` (#585) and the Organization's skills (#869);
  - the routes between Environments (#826);
  - WebMCP (#883, #884);
  - the Folder's three levels of access (#889, #902);
  - guidance for an Organization's production applications and application roles (decision 0239).
- **The shell and Začínáme:**
  - the Environment switcher (#845);
  - the Czech names of the prototype (#891, #903);
  - the Organization in the rail opens Apps (#918);
  - Začínáme → Připojit AI (#925);
  - the GitHub sign-in asks for the `workflow` scope (#894).
- **The decision register:** entries and amendments up to 0242, among them 0204, 0213, 0237–0240 and 0242.

## The final tag

`main` moved on after the candidate was cut (#941, #921, #939, #928, #831, #945, #948, #949 and others), so the tag
cannot stand on the commit that merges this record. It stands on the branch `release/v0.1.21`: that merge commit, plus
one commit on top that restores the candidate's tree everywhere outside `qualification/` and `docs/evidence/`. This is
the path v0.1.20 took, as v0.1.11, v0.1.13, v0.1.16 and v0.1.17 did before it.

The merge is that commit's parent, so provenance holds. Nothing under `qualification/` or `docs/evidence/` changed on
`main` since the candidate. The diff against the candidate is therefore exactly this record and this file, so the same
source holds.

## The candidates of v0.1.21

- **`v0.1.21-rc.1`** (`d1d8917c`, 2026-11-05): Ring 0 (LazurioExampleOrganization/machines#242) and a smoke test
  passed (draft #861). No personal VM ran it, so it has no record. It was superseded by rc.2, which carried the modules
  of #880 and #882.
- **`v0.1.21-rc.2`** (`c4d32466`, 2026-11-06): its stage of 2026-11-08 ended green. Its record (#914) was closed
  without a merge, because the release owner chose rc.3 for the Marketplace fixes (#846, comment of 2026-11-08 11:45Z).
- **`v0.1.21-rc.3`** (`6c4dc221`, 2026-11-08): Ring 0 (machines#251), and the Marketplace on the canary on
  2026-11-10. A personal VM never ran it.
- **`v0.1.21-rc.4`** (`6efb25df`, 2026-11-11): carried #922, #918 and #925, Ring 0 (machines#261). It was superseded
  by rc.5 before a stage, because #931 was needed by another Organization's Environments. A personal VM never ran it.
- **`v0.1.21-rc.5`** (`f4eeaa8b`, 2026-11-11): Ring 0 (machines#262). Its stage, 22:21–22:54Z, did not end green:
  - on the Owner's Work Environment, `lazurio doctor` reported `machine-binding warn handover-changed` before and after
    `folder-refresh` (#111);
  - every other step passed;
  - on 2026-11-12 the release owner decided to fix #111 first, cut rc.6 and repeat the whole canary with
    `machine-binding ok` as the criterion (#846, comment of 2026-11-12 09:40Z).
- **`v0.1.21-rc.6`** (`00dec36b`): tagged from `main` on 2026-11-12 at 15:37:32Z. It carries #940 and the Folder
  guidance of decision 0239 on top of rc.5, plus register entries. It does not carry #941.

**`main`'s macOS check at `00dec36b` is red.** In Platform checks run
[43228109661](https://github.com/Lazurio/LazurioPlatform/actions/runs/43228109661), everything on `ubuntu-24.04`
passed: the static checks, both test shards and `check (ubuntu-24.04)`. `check (macos-15)` did not pass in any of its
three attempts:

| Attempt | When (2026-11-12) | Ended | Recorded cause |
|---|---|---|---|
| 1 | 13:31–14:01Z | `cancelled` at the 30-minute job limit | #858 and a Git-inspection timeout |
| 2 | 14:04–14:34Z | `cancelled` at the 30-minute job limit | no failing test |
| 3 | 14:36–15:05Z | `failure` | one test of the pairing code ledger behind Settings → Připojení (`storage-failed`); 5706 passed, 1 failed |

The causes of attempts 1 and 2 are as recorded in #846 (comment of 2026-11-12 15:38Z). The same check had been red on
`main` since 2026-11-11 22:09Z, docs-only commits included (#816, #858). The release owner decided on 2026-11-12 to cut
rc.6 anyway, because the qualification checks the candidate's macOS behaviour: J1–J6 on `macos-15`, below. Unlike
v0.1.20's candidate, this one was cut while `main`'s macOS check was red.

## Qualification

- **Published:** 2026-11-12 at 15:57:17Z by Release run
  [43249830923](https://github.com/Lazurio/LazurioPlatform/actions/runs/43249830923), attempt 2. The tag was pushed
  at 15:37:32Z.
  - Attempt 1 stopped in "Check the tagged source" (15:37:43–15:47:07Z): two Trezor tests of the public Environment for
    visitors timed out (5702 passed, 2 failed). These are the family of #669, whose fix is #774.
  - The rerun of the failed job passed the whole suite (15:47:55–15:55:41Z).
  - "Attest and publish" ran at 15:56:36–15:57:22Z after the `release` approval.
- **Qualify:** run [43253382715](https://github.com/Lazurio/LazurioPlatform/actions/runs/43253382715) ran on the
  default branch (`workflow_run`) at 15:57:27–16:05:39Z and succeeded: J1–J6 on `ubuntu-24.04` and `macos-15`. It left
  the artifact `qualification-v0.1.21-rc.6`.
- **Assets:**
  - linux-x64: sha256 `f20abc36…`, 101 651 936 B;
  - `lazurio.sigstore.json`: sha256 `dc0ba4af…`, 11 894 B;
  - `manifest.json` names the same digest and source;
  - `gh attestation verify` accepts the binary as signed by `release.yml` at `refs/tags/v0.1.21-rc.6`, digest
    `00dec36b…` (run 43249830923, attempt 2).

## Scope and how each Machine got the candidate

- **All four Environments of the pilot Organization are in the scope:** the two Work Environments of the test
  accounts, the Team Environment and the Prostředí služeb. The public Environment for visitors, which earlier
  candidates of v0.1.21 had in their scope, was stopped and retired by LazurioExampleOrganization/machines#266 (merged
  2026-11-12 18:03Z). It is no longer an Environment of the pilot Organization.
- **The four Environments**, all on one virtualization host's lane, got the candidate in one apply.
  LazurioExampleOrganization/machines#275 changed only the Platform pins of the four guests (Machines v0.12.231
  stayed):
  - its CI Plan was current (observed 08:43:26Z, every guest idle), with the same 22 actions as `main`'s Plan of #269;
  - the reviewer persona approved the exact head at 08:47:32Z, and it was merged as `86790ebf` at 08:47:52Z;
  - its push run [43396048702](https://github.com/LazurioExampleOrganization/machines/actions/runs/43396048702)
    applied it at 08:48:26–09:22:26Z: `success`, completion `installation-complete-acceptance-pending`, conformity
    `conformant`, `release` passing on all four guests, Permit `mp_24182194…`, and evidence on
    `machines-evidence-v1` at `c639de4b`;
  - health is `degraded` only by `ai-ready` of three guests, which is the user acceptance, as with every earlier
    candidate.
- **The personal VM** is the release owner's own Personal Environment, outside the pilot Organization, which has none.
  It is the same Machine as in v0.1.20's record. It was updated to the candidate on 2026-11-13, on its Owner's
  instruction. Its Launchpad restarted with it at 08:45:09Z, and it has run rc.6 since 08:45:14Z: `healthy`, with
  `lazurio doctor` reporting `machine-binding ok`. T3 Code was not restarted (it has run since 2026-10-28).

## The stage

**By one thread, read-only except the smoke test and the real work:**

1. **Quiet check, 09:23Z:** no rollout run was in progress, queued or waiting in the pilot Organization's Deployment
   Repo. The push run had ended at 09:22:37Z. **Start:** `2026-11-13T09:22:26Z`, when the apply ended with `release`
   passing on every guest; the personal VM ran the candidate already.
2. **R1, 09:23:58–09:24:48Z.** Every Machine in the record was read:
   - each Environment of the pilot Organization through its own Launchpad, as the test accounts (`/api/recovery`, the
     use case of `lazurio recover --json`, and `/api/update/status`);
   - the personal VM with `lazurio recover --json` and `lazurio update status --json`.
3. **Real work on the personal VM:** `lazurio machine folder-refresh` at 09:25:08Z re-rendered the Folder from the
   handover (`unchanged`). A deliberate `systemctl --user restart` of the Launchpad followed at 09:25:08Z, and the unit
   came back healthy on the candidate with `NRestarts` 0. `machine-binding` was `ok` before and after. T3 Code and
   the Codex app-server daemon kept their start times.
4. **The smoke test, 09:25:19–09:31:38Z.** Each persona ran in a fresh headless profile of its own (Chromium headless
   shell 148.0.7778.96), never in an Environment's browser.
   - **The standard suite as the Owner and the member** (skill `lazurio-example-smoke-test`, `suite both`),
     09:25:19–09:26:09Z: **17 of 17 required steps passed**, 2 optional were INCONCLUSIVE. Those are the Owner test
     account's personal Environment, whose name does not resolve from the station; it is not in this record. The
     steps:
     - GitHub and Lazurio sign-in, the session and the listed Environments;
     - each own and listed Environment opened (`/.lazurio/shell.json` names it);
     - the member refused with 403 at each of the Owner's Environments;
     - sign-out proven, GitHub sign-out, and a new sign-in asks again.
   - **The main path as the Owner and the member**, 09:26:14–09:28:05Z: **23 of 23 required steps passed**, 8 optional
     passed, 1 optional INCONCLUSIVE (the same personal Environment):
     - the Launchpad's Apps on each Work Environment: 12 module tiles for the Owner and 11 for the member, with
       runnable Knowledgebase, Time Tracker, App access, Presentations, Design system and Mission Control;
     - modules started and opened from their tiles: Knowledgebase on both Work Environments and Design system on the
       Owner's, each with HTTP 200 on the module's own origin, its own heading and its stylesheets, in 5–6 s;
     - the chat on both Work Environments answered a random sum correctly (12 s and 5 s);
     - **the Marketplace**, for both: 7 templates from the registry at `a43cf16a`, at their newest versions (Design
       System 2.0.0, Knowledgebase 0.1.0, Mission Control 4.1.2, Presentations 0.2.1, Quotes 0.1.0, Time Tracker
       0.1.0, Website 0.1.0). Mission Control's detail shows its 5 screens from its release commit `42141bbd` (4.1.2)
       and offers "Add";
     - **Settings → Připojení** on every Environment in reach: the page and `/api/connections` agree and offer no
       pairing and no Codex restart. Both Work Environments are `organization-ai`, the Team Environment `team` and the
       Prostředí služeb `no-chatgpt`.
   - **#743, Chat and Automate from the Launchpad**, as the Owner and the member, each in a fresh profile,
     09:28:10–09:30:03Z: **16 of 16 required steps passed**, and 6 optional passed.
     - A plain click on the Chat tab and on the Automate tab of each Work Environment's Launchpad went straight to the
       app's recorded origin. That was the first navigation after the click. No `/pair` page appeared, and the
       Launchpad got no request under `/api/chat/` or `/api/mausbot/`.
     - With no session yet, T3 Code and MausBot paired the browser themselves (`GET /.lazurio/chat/pairing` and
       `GET /.lazurio/mausbot/pairing`, 200). T3 Code showed its composer, and MausBot showed no code form.
     - A second click on Chat, now with a session, opened it at once with no pairing route asked.
   - **#931 and #111 on the Owner's Work Environment**, through the Owner test account's T3 Code terminal,
     09:30:11–09:31:38Z. The station has no service access to the pilot Organization's hosts, so the terminal is the
     path. Nothing but these commands ran there.
     - `lazurio --version` answered `0.1.21-rc.6` (`00dec36b`).
     - `lazurio doctor` reported `machine-binding ok` (`workspace-vm`) and `machine-entry ok` at 09:30:43Z.
     - `lazurio machine folder-refresh` at 09:30:59Z answered `unchanged`, with no `bindingCorrected`.
     - `lazurio doctor` at 09:31:16Z again reported `machine-binding ok`.
     - Under rc.5 the same check had reported `warn handover-changed` (#111). The binding was already rebound before
       this stage, most likely by the refresh that every apply runs, so this refresh had nothing to rebind. The result
       `refreshed` with `bindingRebound: "handover-digest"` is covered by `tests/folder-binding-rebind.test.ts` (#940).
5. **R2, 09:31:52–09:32:41Z**, the same readings.
6. **End:** `2026-11-13T09:32:56Z`, the green light, given after R2 and the Recovery issue search. The result is
   green.

- **Recovery issues: none.** The search ran at 09:32:47–09:32:56Z:
  - issues labelled `recovery`: 0;
  - `0.1.21-rc.6`: 0;
  - `v0.1.21-rc.6`: only the release issue #846 and the flaky macOS test #858, neither of them a Recovery issue.

### Per Machine

At both edges:

- `recover` answered `healthy`, with all five checks `ok`: `update-state-invalid`, `folder-state`,
  `self-check-failed`, `launchpad-unit`, and `launchpad-health` with `0.1.21-rc.6`;
- `update status` answered running and active `0.1.21-rc.6`;
- the Launchpad unit's `NRestarts` was 0 everywhere. The personal VM's Launchpad restarted once in the stage,
  deliberately (step 3), and that does not count as a restart of the unit.

T3 Code is not part of this candidate. Its version is recorded at both edges so that a change during the stage can be
told apart, and it did not change.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | T3 Code R1 / R2 |
|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work | 09:24:18Z | 09:32:13Z | healthy / healthy | 0.1.21-rc.6 / 0.1.21-rc.6 | 0.1.7-lazurio.1 / the same |
| `7d3f2189170e39ea` | work | 09:24:22Z | 09:32:17Z | healthy / healthy | 0.1.21-rc.6 / 0.1.21-rc.6 | 0.1.6-lazurio.1 / the same |
| `9289bc065828421b` | work | 09:24:43Z | 09:32:36Z | healthy / healthy | 0.1.21-rc.6 / 0.1.21-rc.6 | 0.1.7-lazurio.1 / the same |
| `c04fe553256c9e52` | work | 09:24:48Z | 09:32:41Z | healthy / healthy | 0.1.21-rc.6 / 0.1.21-rc.6 | 0.1.7-lazurio.1 / the same |
| `a6afa18b46790817` | personal | 09:23:58Z | 09:31:52Z | healthy / healthy | 0.1.21-rc.6 / 0.1.21-rc.6 | 0.1.7-lazurio.1 / the same |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- **`folder-refresh` answering `refreshed` with `bindingRebound` on the canary.** The binding was already current
  before the stage, so the canary could show only `machine-binding ok` before and after a refresh. The rebinding itself
  is proven by `tests/folder-binding-rebind.test.ts` and `tests/doctor.test.ts` (#940).
- **The correction of #931 on a change of only the Owner's login.** The pilot Organization's `owner.organization` is
  already its lower-cased login, so this case cannot be shown on the canary. `tests/folder-binding-correction.test.ts`
  proves it.
- **`main`'s `check (macos-15)` at the candidate.** It is red, as described above, and the candidate was cut on the
  release owner's decision. Only the qualification's J1–J6 on `macos-15` check the candidate on macOS.
- **What the release issue #846 asks beyond this stage:** the first real adoption of a template through the
  Marketplace, and a member's request actually sent to the Organization Admin.
- **Whether MausBot answers.** The stage opened Automate and proved its pairing; it sent MausBot nothing.
- Which AI provider the chats used. The test checked only that they answered correctly.
