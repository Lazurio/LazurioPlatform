# Recovery mode instead of rollback

Status: **shaping for the Principal's decision of 2026-09-28. Analysis and design
only.** Nothing here is implemented. The proposed decision F21 at the end amends F13,
the F17 addendum and the product update contract once the Principal accepts it.

## Recommendation

1. **Remove program rollback.** `lazurio update rollback`, `--auto`,
   `lazurio-rollback.service`, `OnFailure=`, the retained `previous` version,
   `pending.json` and the switch-back after a failed health poll all go. The version
   floor and the high-water mark stay: they refuse a downgrade, never perform one.
2. **Move the point of no return before the switch.** The candidate's self-check also
   runs the Launchpad start sequence on a private socket. A failing candidate is
   refused and nothing changes. After the switch the only direction is forward.
3. **Recovery mode is a state of the running Launchpad.** When it cannot serve its
   normal page for a reason it can name, it does not exit. It serves one page with
   one action: start a repair agent with a prepared assignment and the evidence.
4. **One core, two surfaces, one static fallback.** `lazurio recover` and the
   recovery page call the same use case. When the executable cannot run at all, the
   hosted gateway serves a static page that sends the operator to T3 Code.
5. **Every entry into Recovery mode ends on GitHub** as a sanitized issue in the
   public product repository (root decision 0163), repaired or not. Each such issue
   closes only with a regression test.
6. **Gates force quality.** Journeys on disposable runners against the real release
   candidate, a canary soak, and a release job that refuses a final tag without them.

The price: a release that passes every gate and still fails on one Machine leaves
that Machine's Launchpad in Recovery mode until a fixed release. T3 Code, the
operator's tools, the Folder and the repositories keep working; none of them depends
on the Launchpad process. The Principal chose this ("No back doors for rollback!").

## Context

The Principal (2026-09-28) wants no rollback safety net: a broken Environment starts
an agent that repairs forward, or delivers the materials for a fix to GitHub. Earlier
(2026-09-27): Lazurio is a thin wrapper over repositories where Git holds history.
The trigger: the Platform-written Launchpad unit restarts `on-failure` within a start
limit that ends `failed` and starts the rollback unit (`src/update/install.ts:86-99`),
while the resident Launchpad on hosted Machines must "always run" and never end
`failed` (Machines `workloads/workspace-vm/README.md:862-873`, Principal 2026-09-27).

A fact that shapes the migration: the Machines role installs the Platform **without**
`--service` (Machines `workloads/workspace-vm/README.md:449-451`), so no hosted
Machine has the Platform's units; its Launchpad unit is the resident one
(`workloads/workspace-vm/resident-services.mjs:48-80`). Platform units exist only where
someone ran `install --service systemd-user` (`install.sh:4`): qualification VMs and
Linux workstations. The `previous` version exists on every Machine that received an
offline update or a `lazurio update`.

## A. Inventory of rollback in the product today

"Rollback" below means what the Principal rejects: returning to an earlier version or
state as a way of repair. Each row gets one disposition.

### A.1 Code

| # | What | Where | Rollback? | Disposition |
| --- | --- | --- | --- | --- |
| 1 | `lazurio update rollback`: switch to `previous` after its self-check, raising the high-water mark to the version it leaves | `src/update/update.ts:373-416`, CLI `src/update/cli.ts:392-405` | Yes, the explicit form | **Remove** |
| 2 | `lazurio update rollback --auto`: undo a switched, uncommitted activation | `src/update/update.ts:418-427`, `src/update/activation.ts:172-193` | Yes, automatic | **Remove** |
| 3 | `lazurio-rollback.service`, static, runs `previous/lazurio update rollback --auto` | `src/update/install.ts:111-130`, unit name `src/update/service-control.ts:14` | Yes | **Remove**; migration deletes the file (H) |
| 4 | `OnFailure=lazurio-rollback.service`, `StartLimitIntervalSec=60`, `StartLimitBurst=5`, `Restart=on-failure` in the Launchpad unit | `src/update/install.ts:86-99` | The trigger of 3 | **Replace** by the unit in F |
| 5 | Switch-back when the restarted Launchpad does not report the new version within 30 s | `src/update/activation.ts:132-143`, `undo` at `:88-103`, deadline `src/update/service-control.ts:243` | Yes: the new version ran and was observable | **Replace** by the pre-switch probe (F) and Recovery mode after the switch |
| 6 | `reconcilePending`: a mutating command asks the service once and undoes anything unhealthy | `src/update/activation.ts:154-170` | Yes, in its undo branch | **Remove** with the marker; a migration reader handles markers left by v0.1.x (H) |
| 7 | `reconcileAsLaunchpad` and the 15 s commit delay "so a version that dies sooner must reach `OnFailure=lazurio-rollback.service` uncommitted" | `src/update/activation.ts:195-216`, `src/launchpad/server.ts:38`, `:494-507` | Exists only to serve 2 and 3 | **Remove** |
| 8 | `update/pending.json` and its reconcile table | `src/update/layout.ts:182-257` | Exists only for undo | **Remove** (migration reader keeps one release) |
| 9 | `previous` link, `setPrevious`, `readPrevious`, "`previous` is the rollback target" | `src/update/layout.ts:32`, `:79-81`, `:113-116` | Yes: the retained target | **Remove** |
| 10 | Prune keeps "the active and the previous version" | `src/update/layout.ts:125-136` | Retention for rollback | **Replace**: keep only the active version |
| 11 | `rollbackTarget`, error code `rollback-unavailable` | `src/update/activation.ts:218-231`, `src/update/errors.ts:22` | Yes | **Remove** |
| 12 | `previous` in `update status` (JSON and text) and in the self-check report | `src/update/update.ts:435`, `:484`, `src/update/cli.ts:375`, `src/update/self-check.ts:38`, `:58` | Reports 9 | **Remove**. Old updaters only require `report.base` to exist (`src/update/self-check.ts:199`), and the Machines role reads `active` and `highWater`, not `previous` (Machines `ansible/roles/workspace_platform/tasks/install.yml:146-148`) |
| 13 | "Equal to the high-water mark but not active is the retry after a rollback" | `src/update/update.ts:183-186` | Its reason goes; the rule stays | **Keep**: installations rolled back under v0.1.x sit below their mark and must be able to return to it; reword the comment |
| 14 | Version floor = max(active, high-water); every network path and `install` refuse below it | `src/update/layout.ts:144-180`, `src/update/update.ts:132-142`, `src/update/install.ts:252-257`, `:295-302` | No: it refuses a downgrade | **Keep**. It is the one rule that makes "no way back" hold even against a stale pin or an exact tag |
| 15 | A candidate that fails its self-check is removed; nothing was switched | `src/update/update.ts:324-334`, `src/update/stage.ts:76-100`, `src/update/install.ts:304-314` | No: nothing was ever active | **Keep** |
| 16 | A storage failure while writing `previous`/marker/selector puts the selector back if it moved, before any restart | `src/update/activation.ts:123-130` | Atomicity of one step | **Keep** the principle; the path disappears because the switch becomes a single rename (F) |
| 17 | Scratch directory removed at the end of every attempt | `src/update/update.ts:296-299`, `:335-337` | No | **Keep** |
| 18 | Folder transactions: prepare, apply in a fixed rename order, finalize; resume completes a recognized attempt; retire abandons only a pre-activation attempt and retains every file | `src/folder/apply-preparation.ts:28-116`, `src/folder/update-profile.ts:17-25`, `src/folder/retire-preparation.ts:27-29` | No. `before.json` is a comparison snapshot, never a restore source; no code writes it back (`src/folder/apply-preparation.ts:139-202`) | **Keep**: forward completion, the model this document extends to the product |
| 19 | A Folder rendered by a newer template revision is refused (`template-upgrade-required`), never re-rendered older | `docs/machine-handover.md:196-198` | No: refuses a downgrade | **Keep** |
| 20 | Curated tool install: a placed binary that does not answer `--version` is removed when this attempt created or replaced it; an entry it did not change stays | `src/tools/install.ts:549-558` | No: nothing earlier is restored | **Keep**; slice 7 moves the probe before the rename for release archives (B, case 5) |
| 21 | The resident T3/runtime release tree of Machines restores "the selected previous tree after failed template activation" | Machines `workloads/workspace-vm/native-release.py:146-192` | Yes, but Machines', not the Platform's | **Out of scope**; question Q6 |

### A.2 Texts that promise or rely on rollback

| Text | Where | Disposition |
| --- | --- | --- |
| CLI help: "static lazurio-rollback.service its OnFailure= starts", "otherwise the previous version is selected again", `update rollback [--auto]` | `src/update/cli.ts:59-61`, `:64-66`, `:76-81`, `:315` | Rewrite with the new flow; add `recover` |
| Generated manual, hosted "Updates on this Machine": "`lazurio update rollback` returns to the previous version after a failed update" | `src/folder/manual.ts:726-727` | Replace by a "Recovery mode" section (D); template revision `base-instructions-10` |
| Generated manual, workstation "Product update": the rollback line, and "`activation-failed` (…; it was undone)", "`rollback-unavailable`", "which the next `lazurio update` or `lazurio update rollback` undoes" | `src/folder/manual.ts:768-769`, `:779-780` | Same |
| Update contract: exceptions needing a person, invariants, exact version, state table, activation, reconcile table, rollback paragraph, error list, evidence list | `docs/update.md:24-26`, `:54-60`, `:137-140`, `:184-189`, `:239-250`, `:257-299`, `:344`, `:381-383` | Rewrite (slice 1) |
| Release cycle: "rolls back", "An explicit rollback selects the retained previous version", "Rollback is permitted only with…", native qualification list | `docs/release-cycle.md:3`, `:33-35`, `:43-45`, `:142-146` | Rewrite; G adds the gates |
| Migration and recovery: "Product upgrade and profile rollback", rollback support checked before activation, "Before a program rollback below that release…", "Profile rollback is a new checked activation" | `docs/migration-and-recovery.md:220`, `:434-438`, `:448-449`, `:457-458` | Rename and reword; profile "rollback" is a forward change to earlier choices and stays as such |
| Architecture: boundary 1 owns "rollback", "retained rollback version" | `ARCHITECTURE.md:148`, `:180` | Reword to "activation and Recovery mode", "the active version" |
| Acceptance: "Activation, rollback and the Launchpad update pill"; F13 acceptance lists "two retained versions"; the Rollback row | `docs/acceptance.md:30`, `:72`, `:141` | Reword; the Rollback row becomes a "Forward repair" row |
| Decisions F4 ("Program rollback and data recovery are separate", "rollback retention"), F17 (Platform "with its own floor and rollback"; addendum point 3; manual line), F18 and F19 forward-migration boundaries | `docs/decisions.md:235`, `:274`, `:957`, `:1028-1029`, `:1067-1072`, `:1156-1175`, `:1264-1266` | Amended by F21 (I) |
| Machine handover: "After `lazurio update rollback` this is the expected readback"; "never run `lazurio update` or `lazurio update rollback`" | `docs/machine-handover.md:198-202`, `:339` | Reword; the second row loses its rollback half |
| Qualification script: journeys 4 and 6 test the rollback unit and explicit rollback | `scripts/qualify-update-linux.sh:38`, `:177-187`, `:224-226` | Replace by the journeys in G |
| Tests that assert rollback behaviour | `tests/update-reconcile.test.ts` (rows 1-3 and the rollback unit, e.g. `:160`, `:175`), `tests/update-journey.test.ts`, `tests/update-install.test.ts`, `tests/update-cli.test.ts`, `tests/update-compiled.test.ts`, `tests/update-pill.test.ts`, `tests/folder-manual.test.ts` and its snapshot | Replaced by the Recovery-mode tests of the same slice; deleted tests are listed in the PR |
| Machines role texts: "kept the version it left as `previous` (`lazurio update rollback`)", "or its owner rolled back", "exactly the high-water version re-activates it after a rollback" | Machines `workloads/workspace-vm/README.md:455-471`, `ansible/roles/workspace_platform/tasks/install.yml:13`, `:101`, `:127-130`, `tasks/main.yml:212-213` | Machines PR after F21 (H) |
| Root decision 0161: the Platform "s vlastním floorem a rollbackem, F13" | root `manual/decision-register.md:97` | Root PR (I) |

## B. The boundary: atomicity is not rollback

**The rule.** The product may, automatically: never leave a half-written state
(write beside, then one atomic rename; remove what an attempt placed before anything
used it); refuse before it changes anything (verify, self-check, probe, then switch);
never go below the version floor. The product must not, automatically or on request,
return to an earlier version, executable or state **after the new one became
observable**, that is, once a CLI invocation, a restarted Launchpad or a person could
run it and it could write. Before that point cleanup is atomicity; after it the only
direction is forward: complete, repair, or a newer release. A downgrade refusal
(row 14) is the mirror image: it keeps "no way back" true when a stale pin asks.

Tested against five cases from A:

1. **Candidate fails its self-check (row 15).** Placed under `versions/<v>`, never
   named by the selector, so nothing could run it. Removing it is atomicity. Allowed.
2. **Restarted Launchpad unhealthy within 30 s (row 5).** The selector named the new
   version, the unit ran it, and for up to 30 s it could write (a Folder lock,
   preferences through the page). Switching back is rollback. Not allowed; replaced
   by the probe before the switch and Recovery mode after it.
3. **Folder transaction interrupted after two of five renames (row 18).** Resume
   completes it forward; retire applies only before activation and deletes nothing.
   Nothing earlier is restored. Allowed, and the pattern the product adopts.
4. **Storage failure while replacing the selector (row 16).** The rename is one system
   call: old or new link, never neither. Without `previous` and the marker no
   multi-step window is left to undo. Allowed, and simpler.
5. **Curated tool whose placed binary does not run (row 20).** It was on PATH for a
   moment, but removing it restores nothing earlier: the flow installs only when no
   working tool exists (`src/tools/install.ts:515-538`), and a replaced entry is not
   brought back. Cleanup of a failed placement, allowed; slice 7 moves the probe
   before the rename for release archives so the rule holds literally. Official
   installer scripts write their own home and stay their own atomicity.

## C. Recovery mode: the design

### C.1 When the product is broken

"Broken" means the product cannot serve its normal Launchpad page, or cannot update
itself forward. Five checks, each with an owner and a moment:

| Id | Check | Who runs it | When | Outcome |
| --- | --- | --- | --- | --- |
| R1 `start-refused` | The Launchpad start sequence fails on a condition the executable can name: Folder state unreadable by this version (unknown key, unknown schema), Folder lock or pending transaction, invalid hosted entry, missing bundled asset (today these throw out of `src/launchpad/server.ts:126-132` and the process exits) | The Launchpad itself | Every start | Serve Recovery mode instead of exiting |
| R2 `update-state-invalid` | `readUpdateState` answers `state-invalid` (`src/update/layout.ts:141-142`, `:238-241`) | Launchpad at start, `update`, `update status`, `recover` | Every read | Normal page stays; the update pill's only action becomes "Start a repair agent" with the same prompt (it offers no action today, `docs/update.md:312`) |
| R3 `activation-unhealthy` | After the switch, the restarted Launchpad does not report the new version in normal mode within the deadline | The updater (`lazurio update`, `install`) | Once per activation | Result `activation-unhealthy`; the Machine is in Recovery mode (R1 or R4 explains why) |
| R4 `launchpad-not-running` | The executable cannot run or crashes before it can serve (exec failure, crash at import, native fault) | systemd (restart counter), the hosted gateway (upstream refused), `lazurio recover` when the CLI still runs | Continuously | Hosted: the gateway's static page. Workstation: `lazurio launchpad` and `recover` report it |
| R5 `self-check-failed` | The **active** executable fails its own `self-check` against the base and Folder | `lazurio recover` | On demand | Evidence for the agent |

The health socket (`src/launchpad/server.ts:44-58`) answers `{version}` only in normal
mode. In Recovery mode it answers `503 {mode: "recovery", check}`. This matters for
compatibility: a v0.1.x updater treats anything but `{version}` as unhealthy
(`src/update/service-control.ts:190-203`), so a new release that starts in Recovery
mode is never committed by an old updater.

Hosted admission in Recovery mode: the entry normally comes from the Folder
(`src/launchpad/server.ts:137`). When the Folder is what failed, the recovery page
reads the entry from the Machine handover that the Folder copy was derived from; when
neither is readable it binds loopback only and serves nothing through the gateway.
The page is never served without the gateway's admission.

### C.2 Three variants

| | 1. Launchpad mode | 2. Separate recovery program or unit | 3. CLI only |
| --- | --- | --- | --- |
| What serves | The product executable, a minimal server path that needs no Folder | A tiny static server in its own unit, or the gateway serving a static page | Nothing; `lazurio recover` prints prompt and bundle |
| Depends on | The executable starting (R1, R2, R3 covered; R4 not) | Variant 2a: a second program and runtime that must not share the product's faults, i.e. not the product binary. Variant 2b: the gateway (Caddy + oauth2-proxy), already present on hosted Machines | The executable running as CLI, and someone at a shell or in an agent chat |
| Operator on a hosted Machine | Opens the usual Launchpad URL and sees the recovery page | 2a: a second port behind the gateway; 2b: the usual URL answers the static page when the Launchpad upstream is down | Must already be in T3 Code and know to ask |
| Operator on a workstation | `lazurio launchpad` prints the recovery URL | 2a: a second supervised process on macOS, which the product does not have; 2b: no gateway | The agent that started the Launchpad reads the result |
| Build cost | Medium: a recovery server path, page, health semantics, the `recover` use case | 2a: high and against the contract ("Do not create … a second app supervisor", `AGENTS.md`); 2b: low, but in Machines | Low |
| Test cost | Unit tests per R-check plus a native drill under the unit | 2a: a second artifact to qualify per target; 2b: one gateway test | Unit tests |
| "Only start an agent" | Yes: the page has one action | 2b: yes, a static link to T3 Code and a fixed prompt | Yes, but the operator does not see it |

**Recommended: 1 + 3 on one core, 2b as the hosted fallback.** The use case
`collectRecovery` returns the failed check, the bundle and the prompt; `lazurio
recover [--json | --prompt | --issue-body]` prints it and the Launchpad in Recovery
mode renders it. For R4 the gateway's static page says: "The Lazurio Launchpad on
this Machine is not running. Open T3 Code and start a chat with: *The Lazurio
Launchpad is down. Follow `manual/troubleshooting.md`, section Recovery mode, in the
Lazurio Folder.*" The manual was rendered earlier and is plain files, so it is there
exactly when the product is not. Variant 2a is rejected: its own runtime,
distribution and qualification, and the second supervisor the contract forbids.

### C.3 The page and the one action

The page shows the failed check in plain words, when it was detected, the sanitized
bundle ("this is what can leave this Machine") and one button. No Settings, Tools,
update pill or applications. Applications owned by the OS service manager keep
running (F8); hosted applications that are the Launchpad's children start again on
the next Open after repair. "Start a repair agent":

- **Hosted (T3 Code).** First slice: copy the prompt and open T3 Code in a new tab,
  the pattern of the Tools section (`src/launchpad/messages.ts:333`). T3 Code has no
  released way to start a thread with a prompt; `t3 thread start <project> <prompt>`
  is an open upstream pull request
  ([pingdotgg/t3code#12504](https://github.com/pingdotgg/t3code/pull/12504),
  [#13576](https://github.com/pingdotgg/t3code/pull/13576)). Once the `Lazurio/t3code`
  fork carries it, the button opens the new thread directly (slice 7).
- **Workstation.** The same copy action into the agent app the operator uses. Codex
  and Claude Code accept an initial prompt (`codex "<prompt>"`, `claude "<prompt>"`),
  but the product does not ask a person to open a terminal (root `AGENTS.md`). Q3.

## D. The repair agent's assignment

The prompt follows the shape of `toolPrompt` (`src/tools/catalog.ts:435-468`): task,
first read the real state, the mandate, the target state, what never happens, and the
stop rule. It exists in `cs` and `en`; the English text:

> **Task:** Lazurio on this Machine is in Recovery mode (check `<id>`, detected
> `<time>`). Repair it forward. When you cannot, file everything needed for a fixed
> release as a GitHub Issue.
>
> **Evidence** collected and sanitized by Lazurio: `<bundle>`.
>
> 1. Read the current state yourself: `lazurio recover --json`. If `lazurio` does not
>    run, follow `manual/troubleshooting.md`, section "Recovery mode", in the Lazurio
>    Folder: it lists what to collect by hand.
> 2. Name the cause to the operator in two sentences before you change anything.
> 3. **On your own you may:** run read-only commands; `lazurio update` to a release
>    newer than the active one; `lazurio install --service systemd-user --folder
>    <Folder>` to converge the units; `lazurio folder-resume` or `profile-resume` to
>    finish an interrupted Folder change; restart `lazurio-launchpad.service`.
> 4. **Only on the operator's explicit instruction in this chat:** deleting, moving or
>    editing files in the Folder, `organizations/`, `personalspace/` or the install
>    base; retiring an interrupted Folder change; changes of tools, sign-ins or keys;
>    `sudo`.
> 5. **Never:** install a version below the active one or the high-water mark; copy an
>    older executable anywhere; edit `bin/lazurio` or `update/high-water` by hand;
>    delete update state to get past `state-invalid`; print a secret.
> 6. **Success is proven:** `lazurio recover --json` answers `healthy` and the
>    Launchpad page loads normally. Tell the operator what was wrong and what you
>    changed.
> 7. **Record it on GitHub either way.** Search the issues of `Lazurio/LazurioPlatform`
>    for `<fingerprint>`. An open match gets a comment; otherwise create an issue with
>    `lazurio recover --issue-body`. Read the body before you send it and remove
>    anything the sanitizer missed; when you are not sure it is public-safe, do not
>    send it: hand the body to the operator. Without a GitHub sign-in or network, give
>    the operator the prepared body and its link.
> 8. If no release repairs it, tell the operator that the Launchpad stays in Recovery
>    mode until a fixed release, and that T3 Code, the tools and the repositories are
>    not affected. Stop there; work around nothing.

The manual lets an agent run `lazurio update` only when the operator asks
(`src/folder/manual.ts:714-715`); pressing "Start a repair agent" is that request,
bounded to moving forward. An issue follows even a successful local repair because a
state the product could not handle, whoever caused it, is a missing test (Q2).

## E. The evidence bundle for GitHub

### E.1 Contents

The bundle is a structured document (`lazurio.recovery.v1`) of enumerated fields plus
one bounded free-text tail. Structure first: an enumerated field cannot leak what it
does not contain.

| Field | Source |
| --- | --- |
| `check`, `code`, `context` | The failed R-check and its stable error code |
| `product` | `version`, `commit`, `target`, `fixture` of the running and of the active executable (`self-check`) |
| `platform` | OS, kernel release, architecture, systemd version (Linux), Bun version embedded |
| `install` | `active`, `highWater`, `stateInvalid` (path relative to the base), the list of installed versions, whether a legacy `previous` or marker exists |
| `unit` | `LoadState`, `ActiveState`, `SubState`, `Result`, `NRestarts`, `ExecMainStatus` of `lazurio-launchpad.service`; the last `lazurio-update` failure code (`src/update/service-control.ts:145-187`) |
| `folder` | Preset kind (`local`, `hosted-personal`, organization presets), recorded and product template revision, preference and manifest schema versions, whether a transaction is pending and its phase |
| `lastCheck` | `latest`, `checkedAt` |
| `journal` | Last lines of the Launchpad unit's journal for the failing invocation, sanitized (E.2) |

Never collected: the Folder's files, `organizations/` entries by name, preferences
contents, the handover, environment variables, tool sign-in state, anything under
`personalspace/`.

### E.2 Sanitization

`src/tools/redact.ts` withholds whole lines that look like credentials (`:6-17`),
strips control characters (`:23-37`) and bounds a tail to 12 lines and 1200
characters (`:19-20`, `:45-54`). It is reused unchanged for secrets. For a public
issue it lacks:

1. **Identifier substitution.** Known exact values of the Machine are replaced before
   any pattern runs: `$HOME` → `~`, user name → `<user>`, hostname → `<host>`, each
   name under `organizations/` → `<org-n>`, repository names → `<repo-n>`, the
   handover's Machine and Organization labels, the GitHub login → `<login>`. Then
   patterns: `*.lazurio.io` hostnames, IP addresses (tailnet `100.64.0.0/10`
   included), e-mail addresses, absolute paths outside the product's layout.
2. **Digest tolerance.** "Long runs of key material" (`redact.ts:14`) withholds every
   line carrying a commit or SHA-256, most of a useful journal. Digests belong in the
   structured fields; in the tail, a run equal to a known product commit or artifact
   digest is kept.
3. **A residual check that fails closed.** If any known private value survives,
   `--issue-body` refuses and the agent hands the body to the operator (root
   `manual/github-issues.md:75-78`).
4. **Journal-sized bounds.** 80 lines and 8 KB for the tail; the body under 6 KB so it
   fits a prefilled issue link.

A test plants canaries (tokens of each shape, a user name, a hostname, Organization
names, a tailnet address, an e-mail) in every source and asserts none reaches the
body; it is also part of J6.

### E.3 Who approves, what the operator sees

Root decision 0163 lets the agent file an issue after a duplicate check and
sanitization without asking (`manual/decision-register.md:99`,
`manual/github-issues.md:55-60`). The operator is not asked; the operator sees: the
page shows the exact sanitized bundle, and the agent shows the issue body in the chat
in the turn it files it. Closing and prioritizing stay with the Principal. The owning
repository is the public `Lazurio/LazurioPlatform` (Issues enabled); the root routing
table (`manual/github-issues.md:16`) needs a row for it.

### E.4 Duplicates

The fingerprint is 12 hex characters of SHA-256 over `check`, `code`,
`context.stage`/`context.reason` and `target`, without the version, so one fault meets
its issue across releases. The title ends in `[rf-<fingerprint>]`; the agent searches
`--state all`. An open match gets a comment; a closed match is a regression and gets a
new issue linking it.

### E.5 No GitHub sign-in, no network

- **No sign-in** (always so on a Team Environment, `docs/decisions.md:832-836`):
  `recover` prints a prefilled link
  `https://github.com/Lazurio/LazurioPlatform/issues/new?title=…&body=…` for the
  operator's own browser, and the body as text.
- **No network:** no agent runs either. The page shows the bundle to copy and
  `recover` writes it to `<base>/recovery/<timestamp>.json` (owner-only) for the next
  agent. Nothing retries in the background.

## F. How the unit behaves without rollback

### F.1 The unit

```ini
# Written by `lazurio install`; rewritten by it, so edit a drop-in instead.
[Unit]
Description=Lazurio Launchpad
StartLimitIntervalSec=10
StartLimitBurst=5

[Service]
ExecStart=<base>/bin/lazurio launchpad --base <base> --folder <Folder>
Restart=always
RestartSec=5

[Install]
WantedBy=default.target

[X-Lazurio]
Folder=<Folder>
```

This is the resident unit's supervision, taken over on purpose (Machines
`workloads/workspace-vm/README.md:862-873`, `resident-services.mjs:61-80`): restart
after every exit; the start limit pinned in `[Unit]` against a manager-wide override;
5 s restarts never reach 5 starts in 10 s, so the unit never ends `failed` (systemd
stops automatic restarts once the limit is hit, `systemd.service(5)`). When F15 makes
the Platform Launchpad the hosted one, both units have the same shape. No
`OnFailure=`, so `RestartMode=` (systemd 254) is not needed either.

### F.2 "The Launchpad must always run"

Recovery mode is a running Launchpad serving a different page, never a stopped one
(R1, R3). Only R4, an executable that cannot run, leaves nothing serving; the unit
keeps retrying every 5 s, picks up a fixed release on the next restart, and the
gateway's static page stands in.

### F.3 Activation without undo

`lazurio update` (and the offline update of `install`), under the lock:

1. Check, download, verify, place into `versions/<v>/` (unchanged).
2. **Refuse before changing anything.** `self-check --launchpad`: the candidate runs
   the Launchpad start sequence against the real base and Folder **read-only** (no
   lock write, as the self-check already reads, `src/update/self-check.ts:59-69`),
   binds a private temporary socket, answers its own health once and exits. A failure
   removes the candidate. R1 faults of a new version now surface before the switch.
3. **Switch** `bin/lazurio` by one rename: the commit. Then raise the high-water
   mark; a crash in between leaves the mark below the active version, which the floor
   already handles (`src/update/layout.ts:175-180`).
4. Prune every version except the active one. A running old Launchpad keeps its
   unlinked executable open (POSIX); Windows is unsupported (`docs/update.md:366-369`).
5. Supervised: restart the unit, poll health for at most 30 s. Healthy in normal mode
   → `updated`. Anything else → `activation-unhealthy`, exit 1, pointing to
   `recover`; the Launchpad is in Recovery mode (R1) or not running (R4). Nothing is
   switched back. Unsupervised: `updated` with `restartRequired`, as today.

What the probe cannot catch lands in Recovery mode: a conflict on the real port, a
difference between the updater's and the unit's environment, a crash after minutes of
use. The gates in G exist for exactly these.

## G. What forces quality instead

### G.1 What exists

Pull requests run lint, typecheck, unit tests, the public guard and the proof smoke
on `ubuntu-24.04` and `macos-14` (`.github/workflows/check.yml:11-28`,
`package.json:8`). A tag re-runs that check, builds each target on its own runner,
attests, applies the ordering gate and waits for the `release` environment's reviewer
(`.github/workflows/release.yml:61-120`). Native update qualification is a hand-run
script for a disposable Linux VM with a fixture origin
(`scripts/qualify-update-linux.sh:1-20`). `docs/evidence/` holds evidence for
`v0.1.0-rc.1` and `v0.1.0` only, while eight final releases `v0.1.0`–`v0.1.7` were
published between 2026-09-22 and 2026-09-27. The gap: nothing mechanical connects a
final release to a native journey, a real update from the previous release, or a
canary.

### G.2 Proposed gates

**Journeys against the real release candidate.** `qualify.yml` runs when a
prerelease `vX.Y.Z-rc.N` is published, on GitHub-hosted runners (a fresh VM with
`sudo` each run): `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-14`, through the real
Release and Sigstore path, not the fixture origin:

| Journey | Linux | macOS |
| --- | --- | --- |
| J1 First installation by `install.sh` with `LAZURIO_VERSION=<rc>` (`install.sh:5`), then `--version`, `self-check`, a Folder init | yes, with `--service systemd-user` and linger | yes |
| J2 Update from the previous final release to the RC by `lazurio update --version <rc>`, including the pre-switch probe | yes, supervised | yes, unsupervised |
| J3 Folder refresh: a Folder rendered by the previous release upgraded by the RC's template (`profile-update` / `machine folder-refresh` with a fixture handover) | yes | yes |
| J4 Launchpad under the unit: start, `/health`, `kill -9` and automatic restart, `systemctl --user restart`, a restart loop that never reaches `failed` | yes | n/a (unsupervised start and stop) |
| J5 Hosted trust behind a stand-in gateway (the setup of `docs/evidence/hosted-entry-linux-arm64-2026-09-26.md`, scripted) | yes | n/a |
| J6 Recovery drill: induce R1 (unknown Folder key), R2 (unreadable `high-water`), R3 (a fixture candidate that passes the probe and dies under the unit), R4 (non-executable active binary); assert the page, the health answer, `recover --json`, and the canary-free issue body | yes | R1, R2, R5 |

A real reboot stays in the manual VM qualification (a runner cannot reboot and
continue).

**The final release refuses without them.** The release job for a final tag requires
a successful `qualify.yml` run of an RC whose commit equals the final tag's, or
differs only under `docs/evidence/`. Otherwise the draft is deleted and nothing is
published, like the ordering gate.

**Canary soak.** The RC runs by exact tag on one canary Environment for at least 24
hours of real work, including a Folder refresh and a Launchpad restart. The evidence
PR adds `docs/evidence/release-vX.Y.Z.md` with the canary's `lazurio recover --json`
(`healthy`), `NRestarts` and a sanitized journal summary; the `release` reviewer
approves only with it.

**Every recovery issue ends with a regression test.** The issue template sets the
label `recovery` and asks for the fingerprint. The PR that closes it adds
`tests/recovery/<fingerprint>/`, a fixture reproducing the check; J6 runs every
fixture there, so the drill grows with each field failure. The release job lists open
`recovery` issues in the draft release notes.

**A fast lane is a requirement.** Without rollback a broken Machine waits for a fix.
The RC→final path (J1–J6 plus review) should fit in one working hour; the soak of a
fix release may be shortened only explicitly, in its evidence PR.

## H. Migration of existing installations

State in the field, `v0.1.0`–`v0.1.7`: every Machine with a `lazurio update` or an
offline update has a `previous` link and two version directories. Supervised
installations (not hosted Machines, see Context) also have
`lazurio-rollback.service`, `OnFailure=` in the Launchpad unit and possibly a
`pending.json`.

**The update to the first release without rollback (call it vN) is performed by the
old updater.** It still writes `previous`, a marker, and still switches back if vN is
unhealthy. That is the last rollback that can happen, it cannot be prevented without
blocking the update, and it only happens if vN fails. vN's health socket answering
`503` in Recovery mode (C.1) makes the old updater's decision correct.

**vN converges the leftovers**, in a migration kept apart from current-direction code
(`src/update/migrations/remove-rollback/` with a README, its entry points and the
condition for its deletion), run under the update lock at the start of `update` and
`install`; `recover` only reports it:

1. A marker: `not-switched` → delete it. `switched` and the Launchpad healthy at `to`
   → delete it and raise the mark. `switched` and unhealthy → delete it, leave the
   selector, report Recovery mode (no undo). Unreadable → `state-invalid`, untouched,
   as today.
2. `lazurio-rollback.service` carrying the installer's marker line → delete the file.
   The Launchpad unit carrying the marker → rewrite it to F.1, `daemon-reload`, no
   restart (the new `Restart=` applies from the next exit). A unit without the marker
   is someone else's and stays (`src/update/install.ts:173-184`).
3. `previous` → delete the link; prune all versions except the active one.

Order is not critical: once vN is active nothing writes a marker, so a leftover
rollback unit, run by the old `previous` binary, finds no switched marker and does
nothing (`src/update/activation.ts:177-193`). Step 3 removes the manual back door
(`previous/lazurio update rollback`) at the first mutating command run by vN or later:
the operator's next `lazurio update`, or a Machines apply whose staged pin is vN or
later (an older staged binary runs its own code and is refused `below-floor`).

`update status` reports `legacyRollbackState: true` until the migration ran, like
"Folder refresh needed". The migration is deleted in the first release whose
`minimum_updater_version` is at least vN (`docs/update.md:99-105`): no older updater
can then produce the state.

**What the Machines role must stop expecting** (texts in A.2): a `previous` version
after `updated`, "its owner rolled back" as a reason for `ahead`, and "exactly the
high-water version re-activates it after a rollback". After vN the active version
equals the floor unless the selector is damaged, so `ahead` means only "the operator
updated beyond the pin". New for Machines: `activation-unhealthy` from `install` is a
Recovery-mode finding with the bundle in the readback, never a retry; and the
gateway's static page for the Launchpad host (C.2, 2b).

## I. Decisions to amend

- **F13** (`docs/decisions.md:573-617`): the durable floor stays; add that there is
  no retained previous version and no program rollback, pointing to F21. Its
  acceptance row lists "two retained versions" (`docs/acceptance.md:72`).
- **F17 addendum 2026-09-28**, point 3 (`docs/decisions.md:1028-1029`): "`lazurio
  update rollback` stays what it is, the way back from a failed update" is withdrawn
  by F21. Also `:957` ("with its own floor and rollback") and `:1067-1072` (the manual
  line about rollback).
- **F4** (`docs/decisions.md:235`, `:274`): "rollback retention" leaves the
  pre-public-release gates; "Program rollback and data recovery are separate" becomes
  "There is no program rollback; data is repaired forward".
- **F18, F19** (`docs/decisions.md:1156-1175`, `:1264-1266`): the rollback paragraphs
  shrink to the fact that older executables refuse such a Folder.
- **Root decisions** (`manual/decision-register.md`): 0161 (`:97`) gives the Platform
  "vlastní floor a rollback, F13" and needs a root PR. 0132 (`:68`, rollback scenarios
  in shaping) is design practice and stays. 0136 (`:72`) promises a rollback for the
  legacy root's Source → Managed migration, not this product; noted only. 0033 (`:22`)
  is GEN2 history.
- **Generated manual:** `src/folder/manual.ts:726-727`, `:768-769`, `:779-780`, replaced
  by a "Recovery mode" section in `manual/troubleshooting.md` for every preset at
  `base-instructions-10` (today `base-instructions-9`, `src/folder/render.ts:29`).

Proposed wording, in the style of `docs/decisions.md`:

> ## F21 — Recovery mode instead of rollback
>
> **Principal's decision 2026-09-28, direction; not implemented.** Recorded from the
> Principal's words: rollback must not be the safety net; when something breaks, the
> Environment starts an agent to repair it, or delivers every material for a fix to
> GitHub, and the pressure lands on tests and CI/CD so that releases become stable.
> "No back doors for rollback."
>
> **No program rollback.** The product never returns to an earlier version or state
> after the new one became observable. `lazurio update rollback`, `--auto`,
> `lazurio-rollback.service`, `OnFailure=`, the retained `previous` version,
> `pending.json` and the switch-back after an unhealthy restart are removed. What
> stays is atomicity and refusal: nothing is left half-written, a candidate proves
> itself (self-check and a read-only Launchpad start on a private socket) before the
> selector names it, and no path goes below the version floor, which the high-water
> mark keeps durable. The switch is the commit.
>
> **Recovery mode.** When the Launchpad cannot serve its normal page for a reason it
> can name, it keeps running and serves one page with one action: start a repair
> agent with a prepared assignment and the sanitized evidence. `lazurio recover` is the
> same use case on the CLI. The agent repairs forward within the assignment's mandate
> or files the evidence as an issue in `Lazurio/LazurioPlatform` (root decision 0163);
> every entry into Recovery mode is recorded there, and each such issue closes with a
> regression test. The Launchpad unit restarts always and never ends `failed`. When
> the executable cannot run at all, the hosted gateway serves a static page that sends
> the operator to T3 Code and the Folder's manual.
>
> **Quality instead.** A final release requires the journeys of
> [recovery mode](recovery-mode.md#g-what-forces-quality-instead) on disposable
> runners against the real release candidate, and a canary soak with its evidence;
> the release job refuses a final tag without the former.
>
> **Accepted consequence.** A release that passes every gate and still fails on one
> Machine leaves that Machine's Launchpad in Recovery mode until a fixed release.
> T3 Code, the operator's tools, the Folder and the repositories are unaffected.
>
> | Alternative | Trade-off / disposition |
> | --- | --- |
> | Keep rollback as a safety net | Fast relief on one Machine; hides faults and keeps a second code path alive; rejected by the Principal |
> | Keep only the automatic switch-back after an unhealthy restart | Smaller, but the new version was observable and may have written state; it is rollback by the rule above; rejected |
> | Recovery page from a separate program | Survives a broken executable; a second runtime and supervisor to build and qualify; rejected in favour of the gateway's static page |
> | Recovery mode in the Launchpad plus `lazurio recover` | One core, no new process, reaches the operator where they already are; selected |
>
> This amends F4, F13, the F17 addendum of 2026-09-28 (point 3), F18 and F19 as listed
> in [recovery mode](recovery-mode.md#i-decisions-to-amend), and the
> [product update](update.md) contract.

## J. Slices and questions

### J.1 Slices, each reviewable and releasable

1. **Decision and contract.** F21 and the rewritten texts of A.2. No code.
2. **`lazurio recover` and the sanitizer.** Core use case, R2/R5, bundle, issue body,
   fingerprint, prefilled link, canary tests. Additive; first release that files
   evidence.
3. **Recovery mode in the Launchpad.** R1 instead of exit, the one-action page, health
   `503`, admission from the handover, the manual section at `base-instructions-10`.
   Additive.
4. **Activation without undo (vN).** The `--launchpad` probe, switch as commit,
   `activation-unhealthy`, the F.1 unit, removal of A.1 rows 1–12, the migration of H,
   rewritten qualification and tests. Needs 2 and 3 released first, so a failure after
   the switch lands somewhere.
5. **Quality gates.** `qualify.yml` J1–J6, the release-job lookup, templates,
   `tests/recovery/`. Parallel to 2–4; active before the final tag of 4.
6. **Machines.** Role texts of H, `activation-unhealthy` as a finding, the gateway's
   static page. After 4.
7. **Follow-ups.** T3 thread start (fork); same-version repair of a damaged active
   executable (today a no-op, `docs/machine-handover.md:336`), which is forward
   repair; probe-before-rename for release archives (B, case 5); deleting the
   migration.

### J.2 Questions for the Principal

- **Q1 — Is the switch-back after an unhealthy restart rollback?** Yes (B, case 2);
  remove it. The alternative, keeping it as "atomic activation", is smaller but the
  new version has already run.
- **Q2 — An issue for every entry into Recovery mode, even after a local repair?**
  Yes: a state the product could not handle is a missing test.
- **Q3 — Workstation: is "copy the prompt into your agent app" enough?** Yes for now;
  revisit when T3 Code can start a thread from outside.
- **Q4 — Operator confirmation before an issue leaves the Machine?** No, per 0163; the
  operator sees the exact body, and a body not provably clean is never sent.
- **Q5 — Canary soak?** 24 hours on one hosted Environment of the Principal's choice.
- **Q6 — Does "no rollback" bind Machines too?** Its resident and T3 release trees
  restore a previous tree after a failed activation (Machines
  `native-release.py:146-192`). Yes, by a separate Machines decision once F15 lands.
- **Q7 — `previous` in `update status`: drop or keep `null` for one release?** Drop;
  the only known reader, Machines, does not read it.

## What this shaping could not determine

- Which Machines outside the hosted fleet have the Platform units: Machines never
  passes `--service`, but workstations and qualification VMs are inventoried nowhere
  this document may read.
- Whether GitHub-hosted Ubuntu runners give a systemd user manager with linger for
  J1/J4; the first `qualify.yml` run proves it or moves them to a disposable VM.
- Whether `v0.1.1`–`v0.1.7` were qualified without an evidence document.
- T3 Code's thread-start interface: upstream pull requests are open, and the
  `Lazurio/t3code` fork was not inspected.
