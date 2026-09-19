# Implementation acceptance

This is a public technical contract, not a second task/status ledger. Scheduling,
assignment and delivery status live in the owning Organization's Mission Control.
The foundation delivers documentation and a bounded proof only. Every future slice
must add evidence here or in its reviewed test/build instructions without claiming
the other slices are complete.

## Ordered consumer slices

### Nearest-pilot sequence

Accepted order of work for the canary (2026-09-19), replacing the 2026-09-16 priority
note. Each step is a bounded increment with executable acceptance; a later step does
not start on the claim that an earlier one is "mostly done". Nothing in this list is
implemented by the document that records it.

1. **Reconcile contracts.** Private versus team hosted workspaces, OS-owned application
   lifetime, canonical Organization admission, canary versus general-availability
   support. This is the documentation change that introduced this list.
2. **OS-owned applications on Linux.** Service-manager ownership with CLI/Launchpad
   parity, concurrent operations, dependency exclusion and application survival across
   a Launchpad restart. Implemented 2026-09-19 as transient systemd user services and
   natively qualified on `linux-arm64` for survival, rediscovery, dependency exclusion
   and stop; two concurrent owners, `linux-x64` and survival across a product
   activation remain ([module adoption](module-adoption.md#application-lifetime--implemented-for-linux-session-scoped-on-macos)).
3. **Durable update check.** Trust and availability state that survives interruption
   (product update contract, `docs/update.md`, separate PR).
4. **Publisher and release workflow.** The real channel produced by the real workflow.
5. **Activation, rollback and the Launchpad update pill.** Two real versions, candidate
   failure, reboot, concurrent requests and an update while applications are in use.
6. **Hosted entry adapter.** Unauthenticated denial, authenticated access, WebSockets,
   unknown hosts and module links ([hosted entry](hosted-entry.md)).
7. **Materialization and content synchronization.** One real Organization and one
   standard module through explicit clone, prepare, start, functional check and stop
   ([content synchronization](content-sync.md)).
8. **One private canary VM** through the real channel, with explicit tool and sign-in
   preparation, a real agent task and a **repeated infrastructure apply that preserves
   identity, content and the selected version**. VM restart, failed-update preservation
   and the repeat on a second approved VM from the 2026-09-16 note remain required
   evidence of this journey; the reordering does not drop them.
9. **Team preset** with shared-use, conflict, attribution and revocation evidence
   ([workspace presets](workspace-presets.md)). Live Team-grant verification in the
   identity broker is an external dependency.

Supported targets of this first hosted delivery are `linux-x64` and `darwin-arm64`;
`linux-arm64` is built for the qualification VM and is not a support claim.
Installation is per-user. Windows, musl and Intel macOS wait for a real user. The
[platform matrix](#platform-matrix-and-truth-labels) and the first usable transition
gate below remain the general-availability target; the canary path is narrower and
every canary record says so. Passing the canary qualifies none of the wider cells.

Outside the canary path: internal usage analytics, marketplace, hosted advice, legacy
personal migration, generic remote reconciliation and any new supervisor. Analytics
stays default-off and consent-bound per [profile evidence](profile-evidence.md) and
can never block an update. Account login and Dashboard preset selection remain product
commitments; neither blocks proving the local installation and update foundation.
Machines retains infrastructure execution; Platform qualification is not an
apply/restart or access mandate.

### Slices toward general availability

| Slice | Prerequisite | Smallest real consumer and exit criterion |
| --- | --- | --- |
| 0 — Foundation review | Product intent and repository routing | Public architecture, explicit decision amendments, stack comparison, working standalone proof, independent review |
| 1a — Distribution decisions | Reviewed foundation and accepted stack | Distribution owner proposes and obtains acceptance of concrete bootstrap trust, hosting, signing/rotation, channel authorization, retention, platform support and installer layout contracts; record signed/tampered/offline behavior and test strategy |
| 1b — Distribution implementation | Accepted slice 1a contracts | Clean machine runs full installed CLI + Launchpad without source; signed/tampered/offline artifact cases and artifact secret scan |
| 2 — Environment generation | Slice 1 and ownership/schema contract | Folder Factory produces only owned Lazurio Folder files through the shared CLI/Launchpad core; the shared core applies locally through CLI or Launchpad, starts full app; unknown/edited paths preserved; rollback drill |
| 3 — Profile capability | Slice 2 and accepted behavior schema | CLI and Launchpad use the same profile use case; deterministic generation, stale revision refusal, session pin/restart and upgrade preservation |
| 4 — Environment purposes | Slices 2–3 and the validated hosted presets | Private human, team, Buddy and AI Colleague acceptance with correct Principal or Team attribution, Owner, custody and unavailable-capability behavior |
| 5 — Migration rehearsal | Relevant slices 1–4, legacy compatibility and restore mapping | Faithful dirty legacy source-working fixtures plus legacy shared-workshop convergence to a private or team workspace prove preservation, interrupted recovery and no-op unknown state |
| 6 — Opt-in cohorts | Qualified consumer slices; rehearsal and explicit migration approval for migrating cohorts | Small native cohort on each supported OS, user completion evidence, observation and recovery; halt on data loss/identity ambiguity |
| 7 — General availability and retirement | Successful cohorts, public release approval | Published support matrix and release provenance; legacy install/update paths retired by declared criteria, backups retained by policy |

Slice 1 includes decision work, not only coding. The foundation does not claim those
mechanisms are already selected. Acceptance of this foundation permits developing
the concrete distribution proposal, not shipping an installer with invented trust
roots. Slice 1 is complete only when both 1a and 1b pass; the owning distribution
plan must record that ordering before implementation starts. Build/proof experiments
without installation remain useful evidence but do not bypass 1a.

These dependencies govern completed installed-consumer acceptance, not a requirement
to serialize all development behind signing-account provisioning. Shared-core,
Folder Factory and profile implementation may proceed against explicitly isolated
synthetic fixtures before signed distribution is available. Settle the relevant
ownership and schema contracts before implementing writes; retain parity, conflict,
concurrency and recovery tests. This permission does not add installation or migration
commands to the bounded proof by implication: use reviewed product implementation
boundaries and keep the proof's evidence labels accurate.

Unsigned fixture evidence cannot complete public-release slices 1–3, qualify a public installer,
authorize daily-Machine activation or waive any native platform/harness gate. Installer
trust decisions in 1a remain prerequisites for installer implementation; certificate
availability is not a prerequisite for unrelated core or generation tests.

The Principal explicitly permits a controlled internal pilot with HTTPS initial
bootstrap and subsequent TUF verification before Apple Developer ID, notarization
and Windows publisher signing are available. Record that limitation in pilot evidence.
Do not disable OS protections, waive integrity/recovery tests or infer public release
readiness. Later OS signing changes artifact bytes: qualify those final signed artifacts
before promotion. Remaining technical distribution details are delegated for design and
verification; they must be documented, not repeatedly treated as pending founder choices.

Fresh local cohorts qualify distribution, generation, profile and local-founder behavior;
they do not wait for unrelated hosted or legacy shared-workshop migration. Existing-environment migration
cohorts must pass their preservation/recovery gate; hosted cohorts additionally need their
validated preset and the envelope proof of their kind. Broad support/retirement claims require every
claimed cohort's evidence. The three-OS/two-harness first-transition gate stays binding.

Do not silently fold ongoing legacy maintenance into a new Platform rewrite. Existing
fixes continue with their owners; selectively port proven contracts with provenance.

## Required scenarios

| Area | Positive proof | Negative / failure proof |
| --- | --- | --- |
| Installation | CLI, Folder Factory and real Launchpad run from an installed artifact in a fresh home without a Platform source checkout or Bun development tools | Missing dependency, bad signature/digest/platform, hostile archive, occupied Lazurio Folder: no partial activation |
| Source / Folder Factory / local core boundary | Platform source builds a release; Folder Factory plans and generates owned output; the installed shared core locally applies the change through CLI or Launchpad | Active source checkout, remote source mutation of a Machine, or a second local writer fails the boundary review |
| Managed-service independence | Self-hosted Platform forms a working Environment without HumanAndMachineEmpire, Account/Auth or Dashboard | Private service unavailability blocks local CLI, Launchpad or Folder generation |
| macOS Folder compatibility aliases | A single real `<home>/Lazurio` is reached through both `<home>/Conglomerate` and `<home>/Conglomerate_GEN3` symlinks; repeated migration is a no-op and historical absolute paths still resolve | A populated second tree, wrong symlink target, active writer, dirty migration journal or occupied target blocks mutation; no trees are merged or overwritten |
| Conglomerate projection | Whole-system view resolves Organization access from GitHub and Machine facts from their local owners, with freshness/unknown state visible | View grants access, becomes a parallel truth, crosses Personalspace/credentials/private content, or treats the fleet as a shared directory/Organization |
| Shared core | CLI and UI produce equivalent validated operation plans and reason codes | UI cannot bypass validation/authority; unknown fields/enums/schema rejected |
| In-place one-way conversion | Installed profile applied without legacy profile-branch checkout; Organization/Personalspace paths, content and Git/worktree functionality preserved; unique old product work archived before scoped retirement | Unknown files, dependent Git metadata or unattributed work block destructive cleanup; interrupted conversion repairs forward without requiring runnable legacy-installation rollback |
| Migration entrypoint parity | Official installed CLI completes migration without running Launchpad, source checkout or separately installed Folder Factory; equivalent fixtures through CLI and Launchpad yield equivalent plans, checks, effects and recovery | Simultaneous CLI/Launchpad invocation cannot create two writers; interruption through either interface preserves the same recovery guarantees; Folder Factory never owns legacy Git preservation |
| Profile | Two Machines of one Principal retain different profiles; local change does not sync; detail changes independently from delegation and locale; deterministic digest; upgrade retains selection | Manual output drift, stale revision, unsupported purpose/locale, concurrent mutation, missing harness capability |
| Public development | Source, build commands and sanitized evidence publicly reproducible | CI catches synthetic secret and `.env` in archive without printing values; placeholders stay valid |
| Data preservation | Dirty index/worktree/untracked/ignored files, local refs/stashes and external linked worktrees match before/after | Disk full, permissions, interruption at every phase, path traversal, foreign Personalspace: stop safely |
| Runtime | One selected version, managed process tree drained/restored through its owner | Port collision, stale locator, busy executable, active writer, failed healthcheck do not kill unrelated work |
| Application lifetime (Linux; implemented 2026-09-19 for Launchpad restart, [native evidence](evidence/app-services-linux-arm64-2026-09-19.md); product activation, reboot persistence and `linux-x64` not yet exercised) | A started application survives a Launchpad restart and a product activation; Stop stops the service; identity and readiness come from the service manager; reboot persistence only when explicitly set; CLI and Launchpad agree | Saved PID treated as identity, foreign service or process adopted or signalled, port collision accepted, dependency preparation beneath a running application, implicit persistence after Open |
| Content synchronization (accepted direction) | Root first, manifest re-read, declared children; absent destination materialized through a verified temporary sibling; existing checkout fast-forwarded to the inspected commit; siblings continue past one failure | Dirty or wrong-branch checkout stashed, switched or reset; occupied destination replaced; divergence merged; Production Space, Personalspace, worktree or repository database touched; product update cloning or stashing anything |
| Hosted entry (accepted direction) | Authenticated browser reaches Launchpad and application hostnames; session revalidated at the configured auth endpoint; WebSocket reconnect re-enters admission | Forged identity headers honoured, unknown host served, cross-origin state change accepted, Account login treated as admission or repository access |
| Workspace preset (accepted direction) | Immutable reference plus visible overrides survive upgrade; typed request with the expected revision is applied through the ordinary use case and reports the observed outcome | Unknown preset or version mutates; stale revision applied; remote intent overrides a concurrent local change; preset carries grants, tokens, mandates or analytics consent; preset derived from a name |
| Access | Live identity and exact repo operation attributable to the correct Principal, or on a team workspace to the Team through the brokered identity | Revoked membership or Team grant, wrong account, unattributed brokered change, personal credential on a team workspace, peer credential access fail closed |
| Rollback | Exact old compatible product/profile with verified checkpoint and retained work | New schema/data or new user writes block blind downgrade and produce forward-repair plan |
| Retirement | Old route/process/credential/profile inventory empty after accepted cutover | Recovery dependencies or unattributed drafts prevent deletion |

## Platform matrix and truth labels

Launch acceptance includes four composed journeys: Windows local human, macOS local
human, remote human on a virtual Machine, and Buddy on a virtual Machine. Exercise each
in Czech and English using the same shared Folder foundation. Verify generated instruction
and UI language, unchanged Organization/Personalspace paths and content, and actual
execution-Machine OS detection rather than the connecting client's OS. Changing language
does not relocate or translate user data. Record the selected virtual-Machine OS and
qualified support; no unspecified OS/hosting combination is implicitly supported.
These are future acceptance scenarios, not completed tests or four template forks.

This matrix is the general-availability target. The
[nearest-pilot sequence](#nearest-pilot-sequence) deliberately qualifies a narrower set
first (`linux-x64`, `darwin-arm64`, per-user install, one private hosted preset, then
the team preset). That narrowing orders the work; it does not retire a cell, a journey
or a language from this matrix, and no canary result may be reported as matrix evidence
beyond the cells it actually exercised.

Target native acceptance: macOS arm64/x64, Linux glibc arm64/x64 and Windows x64/arm64.
Each cell is independently `not qualified`, `compiled`, `native tested` or `supported`.
Optional musl and unsupported CPU/OS versions must not be silently treated as qualified.
The release owner publishes exact minimum OS/ABI versions only from actual evidence.

Use Bun behavioral tests for pure/core and filesystem fixtures, a strict TypeScript
check for contracts, and native OS process/Git/installer tests for adapters. Browser
acceptance should use Playwright against the real Launchpad; adding it to this tiny
distribution experiment is not needed to claim a final browser acceptance gate.
Test docs-like source text only where the text itself is the contractual output.

On native Windows cover drive/UNC constraints, case-insensitive collision, path spaces,
file handles, executable replacement, reparse points, Git worktrees and environment
propagation into a clean process. On POSIX cover permissions, symlinks, process groups,
cross-volume rename, signal interruption and credential-socket boundaries.

Native compiled smoke does not prove app compatibility, signed distribution,
installer readiness, hosting isolation or migration safety. CI workflow presence
does not prove that an exact head passed. Preserve exact source/artifact versions
and test output with explicit skipped/unavailable cells.

The confirmed rough topology does not select a registry, topology store, discovery
transport, freshness protocol or Dashboard write API. Acceptance for a future proposal
must first identify the natural owner and prove that the view is a projection rather
than a second authority. Until then, missing cross-Machine visibility is an explicit
open capability, not permission to centralize local facts.

## Custom profile and future marketplace acceptance

Custom free-form source survives regeneration and upgrade; shared/custom precedence
conflicts are visible. Export excludes private data and effective authorization.
Imported proposed mandates remain inactive without local scoped consent and stop
being effective after revocation. One catalog may present both profiles and modules,
but tests reject a profile installation targeting an Organization and require the
selected project's real module contract/rights for a module (local owner authority
before binding, live provider rights for connected operations; see F6). Marketplace implementation
is a future workstream, not an added foundation service.

## Coordinator evals

Run actual harness scenarios, not only prompt snapshots: complete a bounded task
locally; delegate independent work with sufficient scoped context; receive a false
success report and catch it from the artifact; handle delegate failure/cancellation;
operate with no delegation tool; refuse a requested publication absent mandate;
avoid copying another Organization's data; preserve a nontechnical user's final
decision while presenting an understandable artifact. Score outcome completion,
scope/privacy, verified evidence, recovery and publication authority separately.
Record the exact harness/tool capability set. A generated instruction file alone
cannot pass these evals.

## First usable transition gate

Before a real-root transition, an official installation must work natively on **macOS,
Windows and Linux**, with the full CLI, real Launchpad and correctly generated base
AGENTS.md. First supported agent environments are **Codex and Claude Code**. Each OS
must have a declared supported architecture and actual cold-session harness evidence;
unavailable combinations stay unqualified and cannot be silently waived for the first
transition claim. Additional architectures retain independent truth labels above.

The minimum preserved Launchpad journey selects a discovered permitted Organization
and module, starts its declared App, shows readiness/status and stops only its owned
process tree. CLI must show equivalent results and useful denied/offline/invalid-manifest/
failed-start errors. This scope does not promise every unspecified legacy UI feature.

For each native OS and each initial harness, record exact installer artifact, OS/ABI,
harness/model version and a cold-start task proving generated instruction discovery,
a packaged skill invocation and correct Organization rule loading. The task must
exercise behavior (scope selection, a bounded result and unauthorized-action refusal),
not simply read back a marker string. Record mismatched/missing instructions and skill
as failures. Codex and Claude adapters must consume one canonical instruction/skill
source; required filename/entrypoint compatibility is an adapter concern, not divergent
policy copies. Verify actual documented harness loading behavior when implementing.

| Accepted requirement | Required evidence before its consumer launches |
| --- | --- |
| Two test modes | Three concurrent isolated fixtures AND one integrated candidate whole-Machine acceptance, as specified in release-cycle.md |
| Dynamic discovery | Verified identity/access separate from local/stale state; correct Organization AGENTS loading; revoke preserves local work |
| Expertise / proactivity | Same marketing domain fixture under responsive and proactive modes, separate quality/oversight scores; no background work without runtime/trigger |
| Mandate scope | Machine-only cannot publish to Organization; Organization-only cannot activate Machine; cross-scope action needs both; import/revocation tests |
| Voluntary evidence | Default-off, inspected minimized payload, no private custom fingerprint/content, missing cost unknown, bias/rare-cell handling |
| Community | Author-selected export preview, provenance/variant lineage, report/moderation disposition; no implicit upload |
| Purchased module | Immutable snapshot to tested customer-owned PR, local customization preserved on update/conflict, payment grants no access |
| Hosted assistance | Advice versus draft versus publication, actual isolated provider context, budget/cancel/resume/idempotency and no cross-customer access |

Profile evidence design starts with the profile capability. No telemetry service,
marketplace billing or hosted runner is a prerequisite to the first local installed
consumer. Their future launch gates remain explicit in the corresponding contracts;
no documented acceptance scenario is represented as already executed here.

## Maker onboarding acceptance

From the official CLI, select a pinned community profile, create a new Lazurio Environment
and perform a bounded task in an existing Codex or Claude Code using the maker's own
model access. Prove initial instruction/skill adoption and visible missing capabilities.
The fixture has no Organization and no hosting account or platform credits; empty
discovery must not block first use. Later Organization onboarding is a distinct journey.
Profile selection is evidence-informed, not a competence guarantee or a promise of
support for every harness. This does not relax the full first-transition native gate.

The first task may use owned files/personal repositories in the Principal's own
Personalspace without an Open Connector. Optional integration absence is not failure;
company repo work still routes to the Organization and its instructions/rights.

## Technical founder local-to-GitHub acceptance

First-version priority, dependent on the explicit F6 amendment and implemented shared
manifest/lifecycle contract, not on dashboard research or marketplace backend:

1. On a clean owner-controlled fixture without GitHub credentials/account, create a
   useful project with local Git repos and modules; complete a bounded task in each
   initial harness and exercise app start/status/stop through CLI and Launchpad.
   Doctor reports intentionally local state without demanding remote membership.
2. Make local commits, branches/tags, staged and unstaged edits, untracked files and
   a linked worktree. Record exact refs/content. Local use and restart remain possible
   without connecting a provider; no hidden subscription or upload is triggered.
3. Explicitly select an authorized test GitHub identity, exact Organization/repos and
   visibility; preview binding and publish scope. Connect while preserving files,
   commit IDs, refs and worktree linkage, then prove provider identity/rules discovery.
   A private/public destination distinction is reviewed before upload, including history.
4. Wrong account, revoked rights, existing/divergent remote, secret-bearing history,
   offline retry and partial multi-repo completion preserve local work and stop unsafe
   upload. Retry checks confirmed remote state without duplicate creation or overwrite.
   Cancellation before upload leaves local usability; after upload requires an explicit
   reconciliation plan, not remote deletion disguised as rollback.
5. No GitHub binding test starts hosting or deploys the app. No fake local Organization
   roles or memberships satisfy connected operation checks. Existing connected fixtures
   retain current access semantics after the schema amendment.

## Product visibility and analyst dogfood acceptance

Before the first public product version, show source-linked product activation,
returning use/completed work, community activity and commercial outcomes, with date range,
denominators, freshness and unknown values. Prove opt-out use still works, no content is
sent, no anonymous event is automatically joined to CRM identity, and benchmarking is
separate. An existing analytics/CRM proposal is sufficient for design; actual collection
needs the consent/transport gate in profile-evidence.md. No fabricated zero fills gaps.
This gate belongs to the first public product version, not to the canary path; missing
or declined measurement never blocks installation, update or use.

The first AI Colleague pilot uses the same pinned transferable analyst profile without
waiting for a marketplace backend. Prove installation → profile adoption → actual own-seat
Organization access → scheduled bounded work → attributable daily report and deeper weekly
analysis → compatible update/recovery. Each finding references its source and observation
window; distinguish facts, hypotheses and recommendations. Missing/revoked access yields a
missing-data report, never another identity's credentials. Source content stays private.

Before any run, the owner approves the dedicated Machine, separate seat/identity, human
custodian, scopes, report destination and effective mandates. Reuse an existing scheduler
and report store. Exercise sleep, restart, missed runs, duplicate wakeups, interrupted work,
revocation, upgrade and rollback: show missed periods, coalesce catch-up under an agreed
policy, verify checkpoints, avoid duplicate reports/actions and never claim work while
asleep. Schedule/timezone, retention and catch-up policy must be selected before activation.
Named equipment/custody and operational evidence belong only to private owner records.
This gate specifies future evidence; no identity, machine or scheduled job exists by
virtue of this document and this audit authorizes none.
