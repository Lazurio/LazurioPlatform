# The canary of v0.1.16-rc.1 and the final release v0.1.16, 2026-10-29/30

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary).

The candidate `v0.1.16-rc.1` (source `4681f49720fa7a6a7ceaac6ec07f8bd05d4e2193`) ran for 8 h 3 min 51 s, directly
observed, on every Environment of the pilot Organization, LazurioExampleOrganization, and on one personal VM. The
final tag `v0.1.16` carries the same product source. It differs from the candidate only by this record and this
file, under `qualification/` and `docs/evidence/`, as the release cycle allows.

The record is [`qualification/canary/v0.1.16-rc.1.json`](../../qualification/canary/v0.1.16-rc.1.json).
The pull request that adds this file adds it too. Machines are opaque ids, as in the record. Which Machine is
which is kept only in the pilot Organization's own private records.

One acceptance check failed: Buddy's route to another Environment (#689). The release owner and the rollout
coordinator kept the final on this candidate and list the failure as a known issue (#722, see
[Known issues](#known-issues)).

## Why the final tag is not on `main`

The final ships the candidate that passed the canary, nothing more. Three pull requests reached `main` after the
candidate was cut:
- #716 (`02860d2a`), a decision proposal (documentation only);
- #723 (`c00efef1`) and #724 (`666b672c`), two changes to Buddy's rules. #724 fixes #722.

None of them was in the canary, so they go into the next version.

`release.yml` requires two things of a final tag:
- **provenance:** the canary record's pull request is merged into the default branch, and its merge commit is in
  the tag's history;
- **the same source:** the tag differs from the candidate only under `qualification/` and `docs/evidence/`.

On `main` the first holds and the second does not. So the tag stands on the branch `release/v0.1.16`. It starts
at the commit that merged this record into `main` and has one commit on top, which restores the candidate's tree
everywhere outside `qualification/` and `docs/evidence/`. The merge is that commit's parent, so provenance holds.
The diff against the candidate is exactly this record and this file, so the same source holds. This is the path
v0.1.11 and v0.1.13 took.

## Qualification

- **Published:** the candidate was published on 2026-10-29 at 07:47:02Z by Release run
  [40836788112](https://github.com/Lazurio/LazurioPlatform/actions/runs/40836788112).
  - Every check on `main` at `4681f497` passed, including macOS: run
    [40830093387](https://github.com/Lazurio/LazurioPlatform/actions/runs/40830093387).
  - `v0.1.15..v0.1.16-rc.1` is #702, #709, #684, #699, #689, #691 and #711.
- **Qualify:** run [40837659090](https://github.com/Lazurio/LazurioPlatform/actions/runs/40837659090) ran on the
  default branch (`workflow_run`) and succeeded, leaving the artifact `qualification-v0.1.16-rc.1`.

## Scope and how each Machine got the candidate

The scope is all 5 Environments of the pilot Organization, its work VMs, plus one personal VM. The scope is not
narrowed. Each Machine got the candidate through the path that pins its release, through the rollout pipeline
(root decision 0205): the Plan in the pull request, the apply on its merge.

**The rollout rule** was unchanged from v0.1.15:
- T3 Code `0.1.2-lazurio.4` or newer (`.6` recommended, `.5` skipped);
- MausBot `0.1.115-lazurio.8` or newer;
- on Environments with Buddy, Hermes `0.22.4-lazurio.2` or newer.

Every Machine of the stage met it from the start of the stage. The personal VM ran Hermes `0.22.4-lazurio.4`.

- **Four work VMs (`00910e1abf66fb61`, `06d5c433c545e38d`, `e0d566c46a1a84de`, `15074d1280e87726`), lane #191:**
  merge `3729fa9f`.
  - Push run 40851835716, attempt 1, stopped at its permit before any change on a Machine: the token broker
    answered 503, so no deployment token was issued. The lease was released.
  - Attempt 2 applied the candidate 09:47:46–10:22:22Z with success, lane `conformant`.
- **The fifth work VM (`d94d6e912281c8e6`), lane #193:** merge `e20876e2`; push run 40858450821 applied it
  10:33:41–10:47:38Z with success, lane `conformant`.
- **The personal VM (`11e08b191f0fc044`), its lane #192:** merge `39327cc6`, applied from the operator's Mac
  20:29:09–20:39:39Z with success.
  - Consent: its Owner's standing consent to Personal Environment updates.
  - The apply re-rendered the Folder, and Buddy's gateway (Hermes, not the Platform) restarted once with it, at
    20:37:29Z, before the stage started.

## The stage

- **Start:** `2026-10-29T20:42:10Z`, the end of the first reading that observed every Machine healthy on the
  candidate (20:41:47–20:42:10Z). The last Machine got it at 20:39:39Z.
  - Every work VM answered `lazurio recover --json` `healthy`, with the Launchpad's `/health` on `0.1.16-rc.1`.
    Each answered `lazurio update status --json` active `0.1.16-rc.1`, and its Launchpad unit had `NRestarts` 0.
  - The personal VM answered the same. Its Launchpad had started at 20:35:26Z with the apply.
- **End:** `2026-10-30T04:46:01Z`, 8 h 3 min 51 s after the start.
  - At 04:45:43–04:45:51Z each work VM answered `recover` `healthy` and active `0.1.16-rc.1`. Its Launchpad unit had
    been active since the deliberate restart of 20:42Z, with `NRestarts` 0.
  - Each work VM's user journal since the start shows only that restart (one `Stopping`, `Stopped`, `Started`).
    There is no other start, stop, scheduled restart or failure.
  - At 04:45:53–04:46:01Z the personal VM answered the same. Its Launchpad unit had been active since the apply at
    20:35:26Z, and its journal since the start shows no start, stop, restart or failure.
  - The reading at 00:45:23–00:45:41Z was the same on all six.
- **Recovery issues: none** (searched at 2026-10-30T04:46:17Z, every issue state).
  - `label:recovery "0.1.16-rc.1"` and the `v0.1.16-rc.1` variant: 0.
  - Issues naming the candidate at all: #722, a finding of the stage's own acceptance. It is not a Recovery issue.
- **No Recovery mode.** Recovery mode is chosen only when the Launchpad starts. Every start inside the stage (the
  deliberate restarts below) came up `healthy`, and every unit had `NRestarts` 0 at the end.

### Real work inside the stage (G.3)

1. **20:42:19–20:42:29Z, every work VM:** a Folder refresh (`lazurio machine folder-refresh`, `unchanged`), then a
   deliberate Launchpad restart. At 20:43:30–20:43:45Z each Launchpad was active since its restart, with
   `NRestarts` 0, and `recover` was `healthy` on `0.1.16-rc.1`.
2. **20:43:45–20:44:12Z, module starts** on the three work VMs that hold the Organization's modules: a static
   content module and the Organization's planning app, each built from its commit. Both were running and healthy
   on all three.
3. **Acceptance of the agent rules, read-only on every Machine** (on the work VMs as each got the candidate; on the
   personal VM from its apply's readback, 20:39Z):
   - Every Folder renders template revision `base-instructions-89`.
   - #680 still holds: every Codex `config.toml` carries the `chatgpt-apps` markers, and `lazurio doctor` reports
     `chatgpt-apps` `ok` on every Machine.
   - **#711, personal VM:** Buddy's `.hermes.md` has the two-minute rule and the pace lines. The skill
     `lazurio-t3-orchestration` sends `--mode auto`.
   - **#684 and #691, personal VM: gated, OK.** The Machines release in use carries no peer members into the
     handover yet, so there is no assigned Work Environment to read and no SSH config to write. Nothing failed.
     The positive check follows these Machines changes:
     - HumanAndMachine-ai/Machines#986, the gate that lets the handover carry peers from this Platform;
     - HumanAndMachine-ai/Machines#987, a derived personal-environment grant;
     - HumanAndMachine-ai/Machines#965, a public-entry server node that cannot receive a grant's key yet.
4. **20:47–21:33Z, browser acceptance as the Owner test account on the personal VM.** All passed; one variant
   was skipped.
   - **#699:** a paid ChatGPT account connects as before. The free-account variant was skipped: no free test
     account exists.
   - **#709:** in Integrace, WhatsApp's „Připojit“ installed its tool on the first click, and the second click
     showed the QR code over the page. The session was cancelled.
   - **#702:** after the Composio sign-in completed, the Launchpad turned „Používají agenti“ on by itself
     (21:28:19Z), one Folder revision. Nástroje showed it on, and Integrace no longer said that agents don't use it.
   - **Telegram:** an end-to-end message with Buddy's bot went through, confirmed by the Organization Admin at
     21:03Z.
5. **21:41:42–21:48:10Z, Buddy's chat as the Owner test account (#711): passed.**
   - A small payment task with a QR code was done by Buddy himself.
   - A bigger task went to a bot. The result came back checked, and nothing was published.
   - Findings, none blocking: Lazurio/hermes-agent#28 (the chat shows a raw `MEDIA:` line instead of the QR image);
     the handover to the bot had three sentences where the rule asks for one.
6. **01:12:29–01:13:46Z, Buddy's route to another Environment (#689): failed.**
   - **The bubble path was not run.** Buddy's launcher appears only on pages of an Environment in the same tailnet
     as the person's personal VM. The Work Environment it was checked on is a public-entry node, so its pages show
     no launcher yet (HumanAndMachine-ai/Machines#965).
   - **The rule, in Buddy's own chat:** asked to check free disk space in the person's Work Environment, named by
     its id, Buddy looked for the generated SSH config (absent, see #691 above).
     - He then found a hand-written SSH alias left there by an earlier manual grant, and ran a read-only `df`
       over it with strict host key checking.
     - The rule expects plain words here ("not from here yet"). Filed as #722.
   - **What held:** no guessed address or host key, no forwarded sign-in, read-only.
   - `.hermes.md` carries the #689 section.

### Other changes on the same Machines during the stage

| When (UTC) | What | Effect on the candidate |
|---|---|---|
| 20:48:55 | On the personal VM, Composio signed out locally, as the baseline for #702 | none |
| 20:49–21:19 | On the personal VM, five Composio sign-in sessions opened and left unfinished | none |
| 20:58:06 | On the personal VM, `wacli` 0.25.1 installed by #709's first click (a tool, not the Platform). It stays installed, not paired and off | none; the Launchpad unit kept running |
| 20:59:28–20:59:31 | On the personal VM, a WhatsApp QR session opened and cancelled | none |
| 21:28:19 | On the personal VM, the Composio sign-in completed, with one Folder revision (#702) | none; no restart |
| 21:41–21:48 | On the personal VM, Buddy's chat and one bot task, with synthetic files only | none; Buddy's gateway kept running |
| 01:12:29–01:13:46 | Buddy's chat on the personal VM, with one read-only `df` over SSH on a work VM | none |

## Known issues

- **#722:** when the person names another Environment in Buddy's chat and no generated SSH name exists, Buddy may
  use a hand-written alias from `~/.ssh/config`. The rule asks him to say in plain words that the Environment is not
  reachable from here yet. The safety lines held: no guessed address or host key, no forwarded sign-in, and
  strict host key checking. v0.1.15 had no route rule at all, so this is not a regression. #724 on `main` fixes it,
  for the next version.
- **Lazurio/hermes-agent#28** (Hermes): the chat shows a raw `MEDIA:` line instead of an image.
- **Buddy's handover to a bot** can be longer than the one sentence the rule asks for.

### Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` at end |
|---|---|---|---|---|
| `00910e1abf66fb61` | work | 0.1.16-rc.1 | healthy / healthy | 0 |
| `06d5c433c545e38d` | work | 0.1.16-rc.1 | healthy / healthy | 0 |
| `d94d6e912281c8e6` | work | 0.1.16-rc.1 | healthy / healthy | 0 |
| `e0d566c46a1a84de` | work | 0.1.16-rc.1 | healthy / healthy | 0 |
| `15074d1280e87726` | work | 0.1.16-rc.1 | healthy / healthy | 0 |
| `11e08b191f0fc044` | personal | 0.1.16-rc.1 | healthy / healthy | 0 |
