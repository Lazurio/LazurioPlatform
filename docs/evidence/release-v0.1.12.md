# The canary of v0.1.12-rc.2 and the final release v0.1.12, 2026-10-25/26

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.12-rc.2` (source `8571aa71a17dcd184e6ec785167f3ba7c538da78`) ran for 8 hours on every
Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The final tag
`v0.1.12` carries the same product source; it differs from the candidate only by this record and this file, under `qualification/` and `docs/evidence/`, as the release cycle allows.

The record is [`qualification/canary/v0.1.12-rc.2.json`](../../qualification/canary/v0.1.12-rc.2.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine
is which is kept only in the pilot Organization's own private records.

## The final tag is on `main`

The merge freeze held from the candidate to the final:
- `main` was `8571aa71` when `v0.1.12-rc.2` was cut;
- `main` stayed `8571aa71` until the merge of this record (the record's own merge commit).

The final tag stands on that merge, and it differs from the candidate only under `qualification/` and
`docs/evidence/`. `release.yml`'s provenance and same-source checks hold without a release branch.

## Qualification

- **Published:** the candidate was published on 2026-10-25 at 16:02:21Z by Release run
  [40209175549](https://github.com/Lazurio/LazurioPlatform/actions/runs/40209175549).
  - The candidate's own check took 6 minutes (#640).
  - Every check on `main` at `8571aa71` passed, including macOS (run 40207465604).
- **Qualify:** run [40209771577](https://github.com/Lazurio/LazurioPlatform/actions/runs/40209771577) ran on the default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.12-rc.2`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is
not narrowed. Each Machine got the candidate through the path that pins its release, through the rollout
pipeline (root decision 0205): the Plan in the pull request, the apply on its merge.

- **Four work VMs, the pilot Organization's lane #157.** Merge `3c4894f9`. The push run 40211605922 applied it
  16:25:49–17:12:02Z with success:
  - `15074d1280e87726` from 0.1.12-rc.1;
  - the other three from 0.1.11-rc.6.
- **The fifth work VM (`d94d6e912281c8e6`), lane #159.** Applied by its owning thread 18:03–18:17:35Z with
  success, together with that Environment's Machines and T3 Code move. One restart instead of two.
- **The personal VM (`11e08b191f0fc044`), its lane #158.**
  - Merge `709ba98e`; applied from the operator's Mac 17:43:07–17:59:08Z with success, conformant.
  - Also moved Machines from v0.12.199 to v0.12.208.
  - Its Plan's only further change, a relationships verify id, followed from an earlier merged host change
    that removed a grant to a retired Environment.
  - Consent: its Owner's standing consent to Personal Environment updates, recorded on the exact Plan digest
    and confirmed by the lane's owner.

## The stage

- **Start:** `2026-10-25T18:44:36Z`, the first reading that observed every Machine healthy on the candidate.
  The last Machine (`d94d6e912281c8e6`) got the candidate at 18:17:35Z. The stage counts from the first direct
  reading, so its 8 hours are observed on every Machine, not inferred from the applies.
  - At 18:44:36–18:44:46Z every work VM answered `lazurio recover --json` `healthy` (the Launchpad's
    `/health` on 0.1.12-rc.2) and `lazurio update status --json` active `0.1.12-rc.2`. Each Launchpad unit had
    `NRestarts` 0.
  - The personal VM answered the same at 18:02:53Z, before the start.
- **End:** `2026-10-26T02:45:25Z`, 8 h 0 min 49 s after the start.
  - At 02:45:09–02:45:18Z each work VM answered `recover` `healthy` and active `0.1.12-rc.2`. Its Launchpad unit
    was active and running since the deliberate restart, with `NRestarts` 0. Its user journal from 18:17:35Z on
    shows only that restart (one `Stopping`, `Stopped`, `Started` at 18:45:08–17Z) and no other start, stop,
    scheduled restart or failure.
  - At 02:45:25Z the personal VM answered `recover` `healthy` and active `0.1.12-rc.2`. Its Launchpad unit had
    run uninterrupted since 17:52:36Z with `NRestarts` 0, and its journal from 18:17:35Z on shows no start, stop,
    restart or failure. It has no app units (a Personal Environment holds no Organization modules).
  - Readings in between, at 21:50Z, 23:49Z and 02:19Z, were the same on all six.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage
  (the deliberate restarts below) came up `healthy`. Every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **18:45:07–18:45:17Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`),
   then a deliberate Launchpad restart. At 18:45:46–54Z each Launchpad was active since its restart,
   `NRestarts` 0, `recover` `healthy` on 0.1.12-rc.2.
2. **18:45:56–18:46:41Z, module starts** on the work VMs that hold the Organization's modules:
   - a static content module was served as a build of its commit;
   - the Organization's planning app, which has its own server, ran from `main` as one production process
     through `start_script`: the first real consumer of #579 and the Module Standard's `start_script`. On a
     work VM Nová karta named it "Built version · main · <commit>" at 11–46 MB, where the development server
     it replaced held about 76 MB.
   - One work VM holds no Organization content yet, and the services Environment holds no Organization, so
     there are no module starts on those two.
3. **18:51:44–18:51:52Z, the one `lazurio update` (#622) through Nová karta's Update (#624),** as the Owner test
   account on its Work Environment:
   - every module "Up to date", and Lazurio "Up to date, version 0.1.12-rc.2", with no downgrade to the older
     public release;
   - no Bun row, because the pinned Bun was already present;
   - no codes or paths on the page; nothing restarted.
4. **Buddy on the personal VM** (#637, #645, #635/#636): the Owner test account's acceptance, 21:23–21:45Z, inside the stage:
   - Začínáme: "Meet Buddy" is the first required step, the ChatGPT sign-in shows connected, and the banner shows. PASS.
   - Seznamte se s Buddym: name, form of address and signature saved and confirmed; the Telegram step is optional. PASS.
   - Nastavení → Buddy: "Working", sign-in connected, persona field, no developer text. PASS.
   - Delegation from the web chat after the prompt refresh: exactly one result message per delegation (21:33:34Z), none after it until 21:39Z. PASS. #645's `NO_REPLY` was not exercised by it: the bot finished (21:33:23Z) after Buddy's own look (21:33:17Z), so the notice (21:33:26Z) brought news and Buddy reported it once. A targeted check followed inside the stage: delegation at 21:58:52Z, the bot done at 21:59:06Z, the notice queued at 21:59:09Z while Buddy's turn ran; Buddy reported the result once at 21:59:37Z, and the notice's turn ended in exactly `NO_REPLY` at 21:59:40Z, hidden in the chat. #645 PASS.
   - The mobile viewport carries `interactive-widget=resizes-content` (#642). PASS, checked statically.
   - A persona change through Nastavení → Buddy (renaming Buddy, 21:32:11Z, by the account's own session): applied by the Platform's own path (#636): its rules rewritten, live prompts cleared, one Buddy gateway restart at 21:32:12Z; the web chat's prompt was rebuilt with the new name at 21:33Z. The Launchpad unit was not touched.
   - Seen once and not repeated: the first open of Buddy's panel at 21:28Z showed T3 Code's generic home instead of Buddy's surface; reopened at 21:31Z correctly (an issue in the T3 Code fork).
5. **Services:** the services Environment ran the candidate through the stage; its Služby serveru path (#629) passed Ring 0 on rc.1 and is unchanged in rc.2.

### Other changes on the same Machines during the stage

| When (UTC) | What | Effect on the candidate |
|---|---|---|
| 18:36:22–18:43:27Z | The pilot Organization's Conglomerate Host: a test account's SSH grant and client. One Headscale restart at 18:39:15Z, so a tailnet blip of a few seconds is possible | none: the start readback came after it |
| 18:54:49–19:02:59Z | Another Organization's sign-in issuer: one Keycloak restart of 10–20 s for every Organization's Lazurio sign-in | none observed |
| 19:56:27–20:01:29Z | The pilot Organization's second server (a rehearsal host with no running guest): its release move and pair test. On this server only the routine 15-minute replication pull, no extra one | none |
| 20:51:50–20:57:52Z | The pilot Organization's Conglomerate Host: an approved device for a test account's client. One Headscale restart at 20:54:15Z, so a tailnet blip of a few seconds is possible | none |
| 21:32:37–21:36:29Z | The pilot Organization's second server: retiring a recovery reference. Nothing on this server changed, no extra replication pull | none |

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.12-rc.2 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.12-rc.2 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.12-rc.2 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.12-rc.2 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.12-rc.2 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.12-rc.2 | healthy / healthy | 0 |

## Known limitation shipped with the final

After the update, Buddy's chat keeps his previous rules until his stored prompts are refreshed. The rollout
refreshes them on every Environment with Buddy, and v0.1.13 makes this automatic (#648).
- **On the canary's personal VM:** the Platform's own refresh (#636) refreshed the live session.
- **What it missed:** the web chat's resumed session needed one manual clear. That finding is recorded on #648.
