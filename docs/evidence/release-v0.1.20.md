# Ring 0 and the smoke test of v0.1.20-rc.3, and the final release v0.1.20, 2026-11-03

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.20-rc.3` (source `a995da2cad17527ed2a8c4ae52788289862bf03e`) ran on every Environment of the
pilot Organization, LazurioExampleOrganization, that its test accounts can enter, and on one personal VM. In the
stage from `2026-11-03T23:46:44Z` to `23:50:37Z` every Machine in its scope was read at both edges, a Folder refresh
and a Launchpad restart ran on one of them, and one recorded smoke test as the pilot Organization's test accounts,
its Owner and a member, passed between the readings: sign-in, the Launchpad and its Apps, modules started and opened,
the chat, Settings → Připojení; the green light ends it. The record is `lazurio.canary.v2` (#752). The final tag `v0.1.20` is
to carry the candidate's product source and to differ from it only under `qualification/` and `docs/evidence/`. The
final tag and its release do not exist yet; they follow the merge of the pull request that adds this file.

The record is [`qualification/canary/v0.1.20-rc.3.json`](../../qualification/canary/v0.1.20-rc.3.json); the pull
request that adds this file adds it too. Machines are opaque ids, as in the record. They are new for this record:
the first 16 hex digits of an HMAC-SHA-256 under a key kept only by the release thread's station, so they cannot be
recomputed from a name. Which Machine is which is kept only there.

v0.1.20 adds to v0.1.19:
- **F71, Phone through ChatGPT:** Settings → Připojení pairs the ChatGPT app with the Codex remote control (#834),
  and finds Codex's control socket on macOS too (#841);
- Začínáme offers no sign-in whose CLI is missing (#827);
- SSH: a source Environment's routes from its home access service (#824), and the handover's home access service
  origin (#833);
- a foreign top-level entry no longer stops a hosted Folder's refresh (#817);
- the Environment browser opens a link to an ended tab again (#815), guest Modules drawn per home Organization
  (#792), and a declared module cloned once readable (#793);
- the decision register entries 0225–0227 and the Folder template revisions up to `base-instructions-106`.

## The final tag

`main` moved on after the candidate was cut (#844, #585, #839 and others), so the tag cannot stand on the commit
that merges this record. It stands on the branch `release/v0.1.20`: that merge commit plus one commit on top which
restores the candidate's tree everywhere outside `qualification/` and `docs/evidence/`, the path v0.1.11, v0.1.13,
v0.1.16 and v0.1.17 took. The merge is that commit's parent, so provenance holds; the diff against the candidate is
exactly this record and this file, so the same source holds.

## The candidates of v0.1.20

- `v0.1.20-rc.1` (`d229964a`) and `v0.1.20-rc.2` (`d4880c40`) were published and qualified the same day. Neither
  carries F71. rc.2 reached only Bob's personal VM (LazurioExampleOrganization/machines#237); it is superseded and
  not in this record.
- **`main` was red after F71 merged:** the macOS job on `0cbc48e9` (run
  [41714295649](https://github.com/Lazurio/LazurioPlatform/actions/runs/41714295649)) failed 16 tests of
  `tests/connections.test.ts`. On macOS Bun's `realpath` fails on a Unix socket with `EOPNOTSUPP`, so every
  Connections page on a Mac would have read `no-daemon`. #841 resolves the path with `lstat` and `readlink`, one
  component at a time (two review rounds by Pablo, each with a regression test). The candidate was cut only after
  every check on `main` at `a995da2c` passed, macOS included (run
  [41726085001](https://github.com/Lazurio/LazurioPlatform/actions/runs/41726085001)).

## Qualification

- **Published:** 2026-11-03 at 22:23:53Z by Release run
  [41729266487](https://github.com/Lazurio/LazurioPlatform/actions/runs/41729266487), first attempt; tag pushed at
  22:15:58Z, `release` approved at 22:23:16Z.
- **Qualify:** run [41730454789](https://github.com/Lazurio/LazurioPlatform/actions/runs/41730454789) ran on the
  default branch (`workflow_run`) and succeeded (J1–J6 on `ubuntu-24.04` and `macos-15`), leaving the artifact
  `qualification-v0.1.20-rc.3`.
- **Assets:** linux-x64 sha256 `1587c23b…`, 96 740 832 B; `lazurio.sigstore.json` sha256 `155982ee…`, 11 788 B.
  `manifest.json` names the same digest and source, and `gh attestation verify` accepts the binary as signed by
  `release.yml` at `refs/tags/v0.1.20-rc.3`.

## Scope and how each Machine got the candidate

- **The five Environments of the pilot Organization**, all on one virtualization host's lane, got the candidate in
  one apply: LazurioExampleOrganization/machines#238 changed only the Platform pins of the five guests (Machines
  v0.12.215 stayed). Its CI Plan (30 actions, 0 deletions) was committed unchanged and found current; Pablo approved
  the exact head; merged at 22:40:26Z; its push run
  [41732839990](https://github.com/LazurioExampleOrganization/machines/actions/runs/41732839990) applied it
  22:40:59–23:26:07Z, `success`, completion `installation-complete-acceptance-pending`, Permit `mp_7aaf3f67…`,
  evidence on `machines-evidence-v1` at `74b146e5`.
- **The personal VM** is the release owner's own Personal Environment, outside the pilot Organization, which has
  none. It was updated by `lazurio update --version v0.1.20-rc.3` at 22:37:31–22:37:43Z, on its Owner's instruction:
  `updated` 0.1.19 → 0.1.20-rc.3, `restartRequired: false`, Folder refreshed, the Launchpad restarted once
  (22:37:39Z). The Codex app-server daemon was not restarted: its processes kept their start times of 2026-10-28 and
  2026-10-29.
- **Out of scope:** the public Environment for visitors (try-01). No test account is admitted there (its Launchpad
  answers a sign-in redirect), as for v0.1.19. Matěj decided on 2026-11-03 that it stays out of v0.1.20's stage;
  he confirmed on 2026-11-04 that it covers the whole release including rc.3, and it is recorded as decision 0166's
  addendum of 2026-11-03 (#850, merged as `2a1777bb` on 2026-11-04). It got the same candidate in the same apply.

## The stage

**A first stage, 23:28:00–23:32:47Z, does not count.** Its readings and smoke test passed (R1 and R2 healthy on
every Machine, the standard suite 17 of 17, Settings → Připojení 4 of 4), but its smoke test opened no module and no
chat, and no Folder refresh or Launchpad restart ran within it; G.3 asks for both. The review of #849 refused it, so
the stage was repeated; nothing was deployed in between.

**The repeated stage, by one thread, read-only except the smoke test and the real work:**

1. **Quiet check, 23:45:42Z:** no rollout run in progress in the pilot Organization's Deployment Repo.
2. **R1, 23:45:51–23:46:44Z.** Every Machine in the record read through its own Launchpad as the test accounts
   (`/api/recovery`, the use case of `lazurio recover --json`, and `/api/update/status`); the personal VM with
   `lazurio recover --json` and `lazurio update status --json`. **Start:** `2026-11-03T23:46:44Z`, the end of R1.
   The last Machine had got the candidate at 23:26:07Z.
3. **Real work on the personal VM:** `lazurio machine folder-refresh` at 23:46:47Z re-rendered the Folder from the
   handover (`unchanged`), and a deliberate `systemctl --user restart` of the Launchpad at 23:46:48Z; the unit came
   back healthy on the candidate with `NRestarts` 0. The Codex app-server daemon kept its start times.
4. **The smoke test, 23:47:03–23:49:39Z:**
   - **the standard suite as the Owner and the member** (skill `lazurio-example-smoke-test`, `suite both`),
     23:47:03–23:47:59Z: **17 of 17 required steps passed**, 2 optional INCONCLUSIVE (the Owner test account's
     personal VM, whose name does not resolve from the station; not in this record): GitHub and Lazurio sign-in,
     session, the listed Environments, each own and listed Environment opened (`/.lazurio/shell.json` names it),
     the member refused with 403 at each of the Owner's Environments, sign-out proven, GitHub sign-out, and a new
     sign-in asks again;
   - **the main path as the Owner and the member**, 23:47:59–23:49:39Z: **19 of 19 required steps passed**:
     - the Launchpad's Apps on each Work Environment: 9 module tiles for the Owner, 8 for the member, the same as
       for v0.1.19; runnable Knowledgebase, Design system and Mission Control;
     - modules started and opened from their tiles: Knowledgebase on both Work Environments (HTTP 200 on the
       module's own origin, its own heading, about 5 s) and Design system on the Owner's (about 4 s);
     - the chat on both Work Environments answered a random sum correctly (3 s and 5 s);
     - **Settings → Připojení (F71)** on every Environment in scope: the page and `/api/connections` agree, and the
       page says the state of its kind with no pairing and no Codex restart offered: both Work Environments
       `organization-ai` ("Coming soon for Environments on the Organization's AI."), the Team Environment `team`,
       the Prostředí služeb `no-chatgpt`. On the personal VM the Codex daemon's `remoteControl/status/read`
       answered `connected` with a server name, the state in which the page offers pairing without a restart.
5. **R2, 23:49:46–23:50:37Z**, the same readings.
6. **End:** `2026-11-03T23:50:37Z`, the green light, after R2 and the Recovery issue search. The result: green.

- **Recovery issues: none** (searched at 23:32:47Z and 23:50:37Z): `label:recovery "0.1.20-rc.3"`, the
  `v0.1.20-rc.3` variant and every issue naming `0.1.20-rc.3`: 0.

### Per Machine

At both edges `recover` answered `healthy`, all five checks `ok` (`update-state-invalid`, `folder-state`,
`self-check-failed`, `launchpad-unit`, `launchpad-health` with `0.1.20-rc.3`), and `update status` answered
running and active `0.1.20-rc.3`. The Launchpad unit's `NRestarts` was 0 at both edges everywhere; the personal VM's
Launchpad restarted once in the stage, deliberately (step 3), which does not count as a restart of the unit.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 |
|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work | 23:46:04Z | 23:49:58Z | healthy / healthy | 0.1.20-rc.3 / 0.1.20-rc.3 |
| `7d3f2189170e39ea` | work | 23:46:07Z | 23:50:01Z | healthy / healthy | 0.1.20-rc.3 / 0.1.20-rc.3 |
| `9289bc065828421b` | work | 23:46:29Z | 23:50:20Z | healthy / healthy | 0.1.20-rc.3 / 0.1.20-rc.3 |
| `c04fe553256c9e52` | work | 23:46:33Z | 23:50:23Z | healthy / healthy | 0.1.20-rc.3 / 0.1.20-rc.3 |
| `a6afa18b46790817` | personal | 23:45:51Z | 23:49:46Z | healthy / healthy | 0.1.20-rc.3 / 0.1.20-rc.3 |

The Team Environment is listed as `work`: the record's kinds are `work` and `personal`.

## Not verified

- **Making a pairing code and its QR in the page.** None of the pilot Organization's Environments offers pairing
  (Organization AI, Team, no ChatGPT sign-in), and an agent cannot open the personal VM's Launchpad: the
  Environment browser refuses Lazurio pages by design. The dialog (QR of the verified URL, the short code, time
  left, closing drops the code) is covered by `tests/connections.test.ts`, which passes on Linux and macOS.
- Which AI provider the chats used; the test checked only that they answered correctly.
