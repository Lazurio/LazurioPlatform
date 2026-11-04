# The canary of v0.1.15-rc.2 and the final release v0.1.15, 2026-10-28

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.15-rc.2` (source `d12249c7a7405f62dbe046538111e4d5897d8d10`) ran for 8 h 1 min 59 s, directly
observed, on every Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The
final tag `v0.1.15` carries the same product source. It differs from the candidate only by this record and this
file, under `qualification/` and `docs/evidence/`, as the release cycle allows.

The record is [`qualification/canary/v0.1.15-rc.2.json`](../../qualification/canary/v0.1.15-rc.2.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine is
which is kept only in the pilot Organization's own private records.

## Two candidates, one canary

- **rc.1** (`c94cf947`, published 2026-10-28 08:18:41Z) reached four work VMs of the pilot Organization through lane
  #183 (merge `8403aafd`, push run 40666490634, applied 09:44:08–10:25:55Z with success). No other Machine got it.
- **Before the stage started, #695 was taken into v0.1.15.** It is the Publication rule for agents, in the words the
  Organization Admin approved that morning, as one block (F14 addendum 2026-10-28, base-instructions-85).
  - The release owner and the rollout coordinator chose an rc.2 over v0.1.16. Otherwise this release would have
    rolled out the rule of #683, which its own author found hard to read, and v0.1.16 would re-render every Folder
    right after.
  - **rc.2** = rc.1 + #695 only.
- **The canary below ran on rc.2 alone,** for the full 8 hours. No canary ran on rc.1.

## Qualification

- **Published:** the candidate was published on 2026-10-28 at 11:03:25Z by Release run
  [40675978147](https://github.com/Lazurio/LazurioPlatform/actions/runs/40675978147), first attempt.
  - Every check on `main` at `d12249c7` passed on the first attempt, including macOS: run
    [40672920573](https://github.com/Lazurio/LazurioPlatform/actions/runs/40672920573).
  - `v0.1.15-rc.1..v0.1.15-rc.2` is exactly #695's squash commit.
- **Qualify:** run [40676970795](https://github.com/Lazurio/LazurioPlatform/actions/runs/40676970795) ran on the
  default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.15-rc.2`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, through the rollout pipeline
(root decision 0205): the Plan in the pull request, the apply on its merge.

**The rollout rule** was that T3 Code `0.1.2-lazurio.4` or newer (`.6` recommended, `.5` skipped) and MausBot
`0.1.115-lazurio.8` reach an Environment no later than the Platform. Every Machine of the stage ran T3 Code `.6` and
MausBot `.8` from the start of the stage.

- **Four work VMs, lane #184:** merge `f1753801`; push run 40679400132 applied it 11:22:40–11:59:19Z with success,
  lane `conformant`.
  - They had run rc.1 since #183, which also moved their T3 Code from `.5` to `.6`. `.5` has the React #301
    right-panel crash (Lazurio/t3code#135).
- **The fifth work VM (`d94d6e912281c8e6`), lane #186:** merge `569169ab`; push run 40686768153 applied it
  12:19:15–12:32:53Z with success, lane `conformant`.
  - It went straight from `0.1.14-rc.2` to rc.2 with T3 Code `.6` in the same apply, and never ran rc.1.
- **The personal VM (`11e08b191f0fc044`), its lane #182:** merge `e0750e62`, applied from the operator's Mac
  12:46:15–12:57:02Z with success.
  - Consent: its Owner's standing consent to Personal Environment updates.
  - Before its Platform apply (10:36:49–10:40:48Z), Buddy's installer release 2026-10-28.3 moved Hermes from
    `0.22.4-lazurio.3` to `.4` and Buddy's default model. The Platform does not pin Hermes. The installer's own
    read-only gate and readback passed.
  - The rc.2 apply left Hermes at `.4`.

## The stage

- **Start:** `2026-10-28T12:58:55Z`, the end of the first reading that observed every Machine healthy on the
  candidate. The last Machine got it at 12:57:05Z.
  - At 12:58:39–12:58:48Z every work VM answered `lazurio recover --json` `healthy`, with the Launchpad's `/health`
    on `0.1.15-rc.2`. Each answered `lazurio update status --json` active `0.1.15-rc.2`, and its Launchpad unit had
    `NRestarts` 0.
  - At 12:58:49–12:58:55Z the personal VM answered the same. Its Launchpad had started at 12:53:05Z with the apply.
- **End:** `2026-10-28T21:00:54Z`, 8 h 1 min 59 s after the start.
  - At 21:00:36–21:00:47Z each work VM answered `recover` `healthy` and active `0.1.15-rc.2`. Its Launchpad unit had
    been active since the deliberate restart of 12:59Z, with `NRestarts` 0.
  - Each work VM's user journal since the start shows only that restart (one `Stopping`, `Stopped`, `Started`). There
    is no other start, stop, scheduled restart or failure.
  - At 21:00:48–21:00:54Z the personal VM answered the same. Its Launchpad unit had been active since the apply at
    12:53:05Z, and its journal since the start shows no start, stop, restart or failure.
  - The reading at 17:00:17–17:00:42Z was the same on all six.
- **Recovery issues: none** (searched at 2026-10-28T21:01:03Z, every issue state).
  - `label:recovery "0.1.15-rc.2"` and the `v0.1.15-rc.2` and `v0.1.15-rc.1` variants: 0.
  - Issues mentioning recovery created since the candidates were published: 0.
  - Issues naming the candidate at all: #700 and #701, findings of the stage's own acceptance. Neither is a Recovery issue.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage (the
  deliberate restarts below) came up `healthy`, and every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **12:59:36–12:59:47Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`), then a
   deliberate Launchpad restart. At 13:00:48–13:00:57Z each Launchpad was active since its restart, with
   `NRestarts` 0, and `recover` was `healthy` on `0.1.15-rc.2`.
2. **13:00:58–13:01:17Z, module starts** on the three work VMs that hold the Organization's modules:
   - a static content module, served as a build of its commit;
   - the Organization's planning app, running from `main` as one production process through `start_script`.

   Both were healthy on all three.
3. **Acceptance of the agent rules (#680, #683/#695), read-only on every Machine** (12:19–12:34Z on the work VMs as
   each got rc.2; on the personal VM from its apply's readback, 12:57Z):
   - **#695:** every Folder renders template revision `base-instructions-85`.
     - On the work VMs, the Publication block is in `AGENTS.md` on every non-public Environment.
     - It is absent on the public one, as designed.
   - **#680:** every Codex `config.toml` carries `[apps._default] enabled = false` and `tool_suggest = false` inside
     the `chatgpt-apps` markers.
     - `lazurio doctor` reports `chatgpt-apps` `ok` on every Machine. On the personal VM, the person decides,
       and the apps and suggestions are off.
     - On the personal VM, `codex debug prompt-input` (no model call) lists 0 recommended plugins, where there had
       been 2.
4. **14:55:47–16:41:26Z, acceptance of Buddy's Telegram bot (#664) as the Owner test account on the personal VM.**
   All passed.
   - **Already up to date:** the update view said Lazurio `0.1.15-rc.2` is current.
   - **Connection steps in Nastavení → Buddy:**
     - disconnect;
     - a wrong token, refused with nothing saved;
     - connect with the real token;
     - closing the page mid-connect sent exactly one connect request.
   - **Unknown sender:** the Organization Admin pressed Start from his own Telegram account. Buddy answered in his
     own words, which needs Hermes `.4`.
   - **Account confirmation:** the Owner confirmed the account in the page. The row then reads "Připojeno" with the
     bot's name, also after a reload.
   - **Messages:** one message each way went through.
   - **Server side:** 1 approved user and 0 pending. Buddy's reply to an unknown sender is set in the gateway's
     configuration.
   - **Pause:** the acceptance stopped 15:04:10–16:19Z for an unrelated network quiet window.
   - **Findings, none blocking:**
     - #700: the Telegram row reads „Nepodařilo se ověřit“ for under a second before the first reading arrives;
     - #701: a bot that Buddy's installer connected, not the page, never gets Buddy's reply to an unknown sender
       until it is connected again in the page.

### Other changes on the same Machines during the stage

| When (UTC) | What | Effect on the candidate |
|---|---|---|
| 14:57:04–14:57:09 and 14:59:19–14:59:20 | On the personal VM, Buddy's gateway (Hermes, not the Platform) restarted twice, at the acceptance's disconnect and connect | none; the Launchpad unit kept running |

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.15-rc.2 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.15-rc.2 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.15-rc.2 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.15-rc.2 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.15-rc.2 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.15-rc.2 | healthy / healthy | 0 |
