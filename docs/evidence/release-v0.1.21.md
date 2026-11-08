# Ring 0 and the smoke test of v0.1.21-rc.2, and the final release v0.1.21, 2026-11-08

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.21-rc.2` (source `c4d32466278d4d0da852d7e23375eb8151e69c11`) ran on every Environment of the
pilot Organization, LazurioExampleOrganization, all five of them, and on one personal VM. In the stage from
`2026-11-08T13:25:41Z` to `13:30:51Z` every Machine in its scope was read at both edges, a Folder refresh and a
Launchpad restart ran on one of them, and one recorded smoke test as the pilot Organization's test accounts, its Owner
and a member, passed between the readings: sign-in, the Launchpad and its Apps, modules started and opened, the chat,
Settings → Připojení, and what this release adds to Apps (the dialog "+ Nový modul" handed to Chat, a member's muted
tile, the video of modules, Zkontrolovat přístupy, the Marketplace's templates and Začínáme's "Poznejte moduly"); the
green light ends it. The record is `lazurio.canary.v2` (#752). The final tag `v0.1.21` is to carry the candidate's
product source and to differ from it only under `qualification/` and `docs/evidence/`. The final tag and its release
do not exist yet; they follow the merge of the pull request that adds this file.

The record is [`qualification/canary/v0.1.21-rc.2.json`](../../qualification/canary/v0.1.21-rc.2.json); the pull
request that adds this file adds it too. Machines are opaque ids, as in the record: the first 16 hex digits of an
HMAC-SHA-256 under a key kept only by the release thread's station, so they cannot be recomputed from a name. The key
is the one of v0.1.20's record, so each Machine that was in that record keeps its id; the public Environment for
visitors, new in the scope, has a new one. Which Machine is which is kept only there.

v0.1.21 adds to v0.1.20:
- **Modules explained in Apps** (#882; F36's addendum of 2026-11-05 and F56's addendum (8)): "+ Nový modul" is a
  dialog of three screens (what a module is, what it should do, the brief) that hands the brief to Chat; a member
  gets the tile muted and asks the Organization Admin instead; Zkontrolovat přístupy runs the Organization's
  synchronization at once; Apps' "?" plays the video of modules, and Začínáme ends Volitelné with "Poznejte moduly".
  What agents know about modules is in the Folder (#880, `base-instructions-111`);
- **the Marketplace of templates:** the offers come from the public registry `Lazurio/marketplace` at one commit
  (#820), and the built-in copy holds its three released templates (#844); the stack profiles of release 2026.11, in
  which `lazurio module create` makes a module (#821, F69);
- **root decision 0216, free Environments:** a free Environment's assignment receipt is read beside its handover, and
  its Folder is created in the assigned person's home (#853);
- **the Organization Admin:** decisions 0228 (#839), 0229 (#852), 0230 (#865) and 0231 (#885); the manual and the
  skill `admin-request` (#860, `base-instructions-109`); `lazurio organization role <Organization> --json` (#868); a
  module learns who came and with which role only through module-kit `appAccess` (#874);
- **agents in the Folder:** the skill `ui-craft` (#585), the Organization's skills (#869, `base-instructions-110`),
  the routes between Environments (#826, `base-instructions-107`, and #825 in Doctor and onboarding), WebMCP in the
  Environment browser (#883, `base-instructions-112`) and in the Module Standard (#884);
- **the shell and Začínáme:** the Environment switcher leads with whose an Environment is (#845), the account is asked
  for in the Environment's language (#847), the tab icon is drawn into PNG (#835), module stones (#696), Composio holds
  its sign-in while the Organization is not in the Folder (#829), and GitHub refusing a linked SSH key is not
  "Připojení nefunguje" (#851);
- the amendments of decisions 0209 (#838), 0181 (#859), 0218 (#886) and 0169 (#888) in the register, and the test
  fixes #875 and #895.

`v0.1.21-rc.2` does not carry what merged after it was cut: #896, #897, #900, #903, and the Czech names of #891.

## The final tag

`main` moved on after the candidate was cut (#891, #896 and others), so the tag cannot stand on the commit that merges
this record. It stands on the branch `release/v0.1.21`: that merge commit plus one commit on top which restores the
candidate's tree everywhere outside `qualification/` and `docs/evidence/`, the path v0.1.20 took, like v0.1.11,
v0.1.13, v0.1.16 and v0.1.17 before it. The merge is that commit's parent, so provenance holds. Nothing under
`qualification/` or `docs/evidence/` changed on `main` since the candidate, so the diff against the candidate is
exactly this record and this file, and the same source holds.

## The candidates of v0.1.21

- **`v0.1.21-rc.1`** (`d1d8917c`) was published on 2026-11-05, ran on every Environment of the pilot Organization
  (LazurioExampleOrganization/machines#242), and a smoke test as its Owner and a member passed (draft #861). No
  personal VM ran it, so it has no canary record. Matěj decided on 2026-11-06 that the modules of #880 and #882 go
  into v0.1.21 as rc.2, which supersedes it.
- **`v0.1.21-rc.2`** (`c4d32466`) was tagged from `main` on 2026-11-06 at 11:36:44Z.
- **`main`'s macOS check at `c4d32466` is red.** In Platform checks run
  [42211528240](https://github.com/Lazurio/LazurioPlatform/actions/runs/42211528240) everything on `ubuntu-24.04`
  passed (the static checks and both test shards), but `check (macos-15)` failed in all four attempts, each time only
  on known flaky tests:

  | Attempt | When (2026-11-06) | Pass / skip / fail | Failed |
  |---|---|---|---|
  | 1 | 11:36–12:10Z | 5599 / 10 / 1 | #438 |
  | 2 | 18:03–18:30Z | 5598 / 10 / 2 | #438, #858 |
  | 3 | 18:35–19:02Z | 5599 / 10 / 1 | #438 |
  | 4 | 19:31–20:03Z | 5599 / 10 / 1 | #858 |

  #438 is the Folder tools transaction test reaching the 5 s test timeout in a loaded full run; #858 is a wall-clock
  test of the Environment browser that does not see its write in time. No other test failed in any attempt. Unlike
  v0.1.20's candidate, which was cut only after every check on `main` passed, this one was tagged before the first
  attempt ended. The release's own check of the tagged source and the qualification on both targets passed (below).

## Qualification

- **Published:** 2026-11-06 at 12:21:20Z by Release run
  [42211552551](https://github.com/Lazurio/LazurioPlatform/actions/runs/42211552551), attempt 2; tag pushed at
  11:36:44Z, `release` approved at 12:20:47Z. Attempt 1 (11:36:48–11:43:54Z) stopped in "Check the tagged source":
  `tests/module-bun-runtime.test.ts`, "Apps with different pins run side by side…", was refused its own fixture port
  (`port-occupied`; 5596 pass, 1 fail), the family of #222. The rerun of the failed job passed the whole suite
  (11:44:26–11:53:14Z).
- **Qualify:** run [42217038354](https://github.com/Lazurio/LazurioPlatform/actions/runs/42217038354) ran on the
  default branch (`workflow_run`) at 12:21:26–12:23:07Z and succeeded (J1–J6 on `ubuntu-24.04` and `macos-15`),
  leaving the artifact `qualification-v0.1.21-rc.2`.
- **Assets:** linux-x64 sha256 `b15e7859…`, 101 553 632 B; `lazurio.sigstore.json` sha256 `b9ddf16e…`, 11 706 B.
  `manifest.json` names the same digest and source, and `gh attestation verify` accepts the binary as signed by
  `release.yml` at `refs/tags/v0.1.21-rc.2` (run 42211552551, attempt 2).

## Scope and how each Machine got the candidate

- **All five Environments of the pilot Organization are in the scope.** Decision 0166's addendum of 2026-11-03 took
  the public Environment for visitors out of v0.1.20's stage only. For v0.1.21 it is in again, and it can be read:
  its public entry ("Přihlásit se přes Lazurio") admits the Owner test account, so it is read through its own
  Launchpad like the others.
- **The five Environments**, all on one virtualization host's lane, got the candidate in two applies of one change:
  - LazurioExampleOrganization/machines#249 changed only the Platform pins of the five guests (Machines v0.12.227,
    T3 Code 0.1.2-lazurio.6 and Lazurio MausBot 0.1.130-lazurio.4 stayed). Its CI Plan (30 actions, 0 deletions, the
    same set as #242's) was committed unchanged and found current, the idle guard read all five guests idle, and
    Pablo approved the exact head. It was merged at 2026-11-08 11:31:34Z after a fresh Plan (11:30:54Z) with no other
    rollout run.
  - **Its push run failed after its mutation began.** Run
    [42476133301](https://github.com/LazurioExampleOrganization/machines/actions/runs/42476133301) consumed its Permit
    (`mp_6aab088a…`) and at 11:55:00Z failed with `workspace-fleet-vm-151-workspace-artifact-release-unreachable`: the
    Prostředí služeb could not fetch its release sources from GitHub. GitHub had the incident "Increase in timeouts for
    some unauthenticated users" (API Requests) at that time: investigated from 10:36Z, its component found at 11:50Z,
    mitigated at 11:56:20Z. The release asset answered 200 at 11:58Z. Read through their own Launchpads at
    11:56–11:57Z, the Team Environment ran the candidate and the other four still `0.1.21-rc.1`, all healthy; the lane
    held `recovery_required`.
  - **The re-attempt within the approval's 24 hours was refused before any Permit:** run
    [42478324826](https://github.com/LazurioExampleOrganization/machines/actions/runs/42478324826) stopped in its
    re-plan readback, because a lane with `tailnet-enrollment-keys` cannot re-attempt in runner mode
    (HumanAndMachine-ai/Machines#842).
  - **The reviewed recovery,** LazurioExampleOrganization/machines#250: the failed run's `recovery.json` from its
    artifact, byte for byte, and the single-use interrupted-apply attestation and reference in the Machine Record, the
    path #248 took on this lane on 2026-11-07. Its CI Plan (the same 30 actions) was committed unchanged and found
    current, the idle guard read all five guests idle, and Pablo approved the exact head. It was merged at 12:30:56Z
    after a fresh Plan (12:24:51Z) with no other rollout run. Its push run
    [42480618054](https://github.com/LazurioExampleOrganization/machines/actions/runs/42480618054) applied it
    12:31:34–13:23:49Z: `success`, completion `installation-complete-acceptance-pending`, Permit `mp_05319e2a…`,
    evidence on `machines-evidence-v1` at `6de16cf4`.
- **The personal VM** is the release owner's own Personal Environment, outside the pilot Organization, which has none;
  it is the same Machine as in v0.1.20's record. It was updated by `lazurio update --version v0.1.21-rc.2` on
  2026-11-06 at 18:05:31–18:05:46Z, on its Owner's instruction: `updated` 0.1.20 → 0.1.21-rc.2,
  `restartRequired: false`, Folder refreshed, the Launchpad restarted once (18:05:37Z) and, with it, the view of the
  Environment browser (`stale-restarted`). The Codex app-server daemon was not restarted (its processes kept their
  start times of 2026-10-28 and 2026-11-06 02:40Z), nor was T3 Code (2026-10-28).

## The stage

**By one thread, read-only except the smoke test and the real work:**

1. **Quiet check, 13:24:29Z:** no rollout run in progress, queued or waiting in the pilot Organization's Deployment
   Repo; the last Machine had got the candidate at 13:23:49Z.
2. **R1, 13:24:34–13:25:41Z.** Every Machine in the record read through its own Launchpad as the test accounts
   (`/api/recovery`, the use case of `lazurio recover --json`, and `/api/update/status`; the public Environment for
   visitors through its public entry); the personal VM with `lazurio recover --json` and
   `lazurio update status --json`. **Start:** `2026-11-08T13:25:41Z`, the end of R1.
3. **Real work on the personal VM:** `lazurio machine folder-refresh` at 13:25:54Z re-rendered the Folder from the
   handover (`unchanged`), and a deliberate `systemctl --user restart` of the Launchpad at 13:25:55Z; the unit came
   back healthy on the candidate with `NRestarts` 0 (13:26:01Z). The Codex app-server daemon and T3 Code kept their
   start times.
4. **The smoke test, 13:26:08–13:29:29Z,** each persona in a fresh headless profile of its own (Chromium headless
   shell 148.0.7778.96), never in an Environment's browser:
   - **the standard suite as the Owner and the member** (skill `lazurio-example-smoke-test`, `suite both`),
     13:26:08–13:27:00Z: **17 of 17 required steps passed**, 2 optional INCONCLUSIVE (the Owner test account's
     personal Environment, whose name does not resolve from the station; not in this record): GitHub and Lazurio
     sign-in, session, the listed Environments, each own and listed Environment opened (`/.lazurio/shell.json` names
     it), the member refused with 403 at each of the Owner's Environments, sign-out proven, GitHub sign-out, and a new
     sign-in asks again;
   - **the main path as the Owner and the member, with what this release adds,** 13:27:05–13:29:29Z: **30 of 30
     required steps passed**, 9 optional passed, 1 optional INCONCLUSIVE (the same personal Environment):
     - the Launchpad's Apps on each Work Environment: 11 module tiles for the Owner, 10 for the member; runnable
       Knowledgebase, Time Tracker, App access, Design system and Mission Control;
     - modules started and opened from their tiles: Knowledgebase on both Work Environments and Design system on the
       Owner's, each with HTTP 200 on the module's own origin, its own heading and its stylesheets, in about 5 s;
     - the chat on both Work Environments answered a random sum correctly, in 4 s each;
     - **"+ Nový modul", the Owner:** the tile ("Create with an agent") opens the dialog; its three screens say what a
       module is (process, data and app; an agent builds it), take the description, and show the brief for the agent
       with that description and the skill `new-module`, with "Copy the brief" and "Open in Chat". "Open in Chat"
       opened the Owner's Chat in a new tab (`lazurio-prompt=new-module-<key>`), and its composer held the brief with
       the description, unsent;
     - **"+ Nový modul", the member:** the tile is muted ("The Organization Admin creates it") and opens the member's
       dialog: the Organization Admin creates modules, and the last screen is the request to the Organization Admin
       with the description and the skill `admin-request`. Escape closed it; nothing was handed over;
     - **Apps' "?"** ("How does it work?") opened the video of modules in place and played it
       (`modules-overview-en.mp4`, past its first second of 29.5 s) for both;
     - **Zkontrolovat přístupy** ("Check access") answered for both in about 7 s: "Nothing new. The Organization
       Admin grants access to modules.";
     - **the Marketplace** shows three templates for both: Design System, Mission Control and Presentations;
     - **Začínáme** ends with "Poznejte moduly" ("Get to know modules") for both, and its video plays;
     - **Settings → Připojení** on every Environment in reach: the page and `/api/connections` agree and offer no
       pairing and no Codex restart: both Work Environments `organization-ai`, the Team Environment `team`, the
       Prostředí služeb `no-chatgpt`.

     The test accounts' Environments render their Launchpads in English, the language of their Folders, so the
     checks read the English texts and the English cut of the video.
5. **R2, 13:29:41–13:30:41Z**, the same readings.
6. **End:** `2026-11-08T13:30:51Z`, the green light, after R2 and the Recovery issue search. The result: green.

- **Recovery issues: none** (searched at 13:30:47–13:30:51Z): `label:recovery "0.1.21-rc.2"` and the `v0.1.21-rc.2`
  variant: 0, and no issue labelled `recovery` since the candidate was cut. The search also returns #913, which names
  `0.1.21-rc.1`: a first open of a never-run module through its link, on 2026-11-08 during GitHub's incident. It is
  not a Recovery issue.

### Per Machine

At both edges `recover` answered `healthy`, all five checks `ok` (`update-state-invalid`, `folder-state`,
`self-check-failed`, `launchpad-unit`, `launchpad-health` with `0.1.21-rc.2`), and `update status` answered running and
active `0.1.21-rc.2`. The Launchpad unit's `NRestarts` was 0 at both edges everywhere; the personal VM's Launchpad
restarted once in the stage, deliberately (step 3), which does not count as a restart of the unit. T3 Code is not part
of this candidate; its version is recorded at both edges so that a change during the stage can be told apart, and it
did not change. The Owner's Work Environment runs a host-only T3 Code preview, outside the lane's pins.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | T3 Code R1 / R2 |
|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work | 13:24:53Z | 13:29:57Z | healthy / healthy | 0.1.21-rc.2 / 0.1.21-rc.2 | 0.1.7-preview.20261106.1 / the same |
| `7d3f2189170e39ea` | work | 13:24:57Z | 13:30:01Z | healthy / healthy | 0.1.21-rc.2 / 0.1.21-rc.2 | 0.1.6-lazurio.1 / the same |
| `0957a900a448bf22` | work | 13:25:05Z | 13:30:09Z | healthy / healthy | 0.1.21-rc.2 / 0.1.21-rc.2 | 0.1.2-lazurio.6 / the same |
| `9289bc065828421b` | work | 13:25:27Z | 13:30:29Z | healthy / healthy | 0.1.21-rc.2 / 0.1.21-rc.2 | 0.1.2-lazurio.6 / the same |
| `c04fe553256c9e52` | work | 13:25:31Z | 13:30:34Z | healthy / healthy | 0.1.21-rc.2 / 0.1.21-rc.2 | 0.1.6-lazurio.1 / the same |
| `a6afa18b46790817` | personal | 13:24:34Z | 13:29:41Z | healthy / healthy | 0.1.21-rc.2 / 0.1.21-rc.2 | 0.1.6-lazurio.1 / the same |

The Team Environment and the public Environment for visitors are listed as `work`: the record's kinds are `work` and
`personal`.

## Not verified

- **What the release issue #846 asks beyond this stage:** the first real adoption of the templates through the
  Marketplace, a member's request actually sent to the Organization Admin, and Zkontrolovat přístupy fetching a module
  right after a grant (here it answered "nothing new", as no access had changed).
- **The Czech texts in a live Launchpad:** the test accounts' Environments render English. The Czech wording of the
  dialog, the tile and Začínáme is covered by the tests and the preview of #882.
- **A first open of a never-run module through its link (#913):** the stage opened modules from their tiles.
- Which AI provider the chats used; the test checked only that they answered correctly.
