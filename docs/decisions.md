# Decision proposals and convergence

Status: review draft, updated 2026-09-19. These local identifiers are Platform proposals,
not new numbers in the maintained Lazurio decision register. They do not override
legacy runtime contracts until the owning decision is amended and consumers migrate.
Canonical decision 0144 has now accepted the Machines/Environment handover boundary
and the Conglomerate graph meaning; those two points are no longer pending amendments.

The 2026-09-19 reconciliation rewrote F2 and added F8–F12 from the Principal's
direction and an architecture review. Where a canonical upstream decision contradicts
a Platform proposal, upstream wins and the proposal is rewritten; where the Principal's
direction changes upstream behaviour, the change is listed as a required upstream
amendment below. F8–F12 are accepted direction; F8 is implemented for Linux (see F8),
F9–F12 are not implemented.

## F0 — Confirmed vocabulary and responsibility split

**Direction confirmed by the Principal:** the product is **Lazurio Platform**. Its public,
source-available codebase is `Lazurio/LazurioPlatform`; the repository was renamed from
`Lazurio/LazurioFactory` on 2026-09-13 without replacing its GitHub identity or history.
Legacy local checkout paths migrate separately and may temporarily retain the old basename.
The source produces installed releases and is not itself a daily Machine checkout.

An installed release contains CLI, Launchpad and **Lazurio Folder Factory**. Folder Factory
is the shared component that plans, generates and reconciles Lazurio-owned paths from a
selected profile. CLI and Launchpad invoke the same local application core; that core
owns local application through platform adapters. Neither UI is an independent writer,
and no remote source repository mutates a Machine.

**Migration entrypoints confirmed by the Principal:** the official installed CLI must
complete migration without running Launchpad or separately installing Folder Factory.
The release includes the required shared core and Folder Factory capability. Launchpad
invokes the same migration use case, rather than requiring a shell invocation of CLI.
Given equivalent inputs, authority and initial state, both entrypoints must produce
equivalent plans, checks, effects and recovery outcomes. The core owns inventory,
checkpoint, transition and recovery orchestration; Folder Factory owns only profile-based
owned-content planning/generation/reconciliation, not preservation of the legacy Git repo.
Both entrypoints share mutation exclusion and recovery state, preventing concurrent
writes to the same Environment. This replaces the earlier Launchpad-only apply wording;
it is a target contract, not an implemented migration or a new daemon/package decision.

The resulting composition of compatible installed components and a correctly materialized
**Lazurio Folder** on one Machine is a **Lazurio Environment**. Treat `Managed Root`
and `Lazurio Root` only as historical aliases; do not introduce them as current
user-facing proper nouns.

**Conglomerate** is the end-state fleet/graph of Machines and Lazurio Environments across
Organizations, with meaningful relationships and flows of data, information and work.
It is not a directory, Organization, shared access boundary, ACL or authority. Dashboard
is initially the whole-system overview/reasoning surface, not control authority. It keeps
no parallel truth and grants no access. A future Dashboard-originated change must write
through to the natural owner and be applied locally on the target Machine by the shared local core exposed by CLI and Launchpad.

GitHub remains connected-Organization access authority. Machine facts stay local;
Personalspace, credentials and private content are not centralized or crossed. Machines
share a versioned environment contract and conventions/interfaces, not a live shared
directory or identical state.

The inversion alternative—a central registry that also becomes authority—would add a
second truth, synchronization/freshness failures and a new privacy/access boundary. The
minimal retained model is an owner-backed projection/view. Whether even a non-authoritative
central registry exists remains open because of the current no-central-registry and
no-global-sync rule; no mechanism is selected in this draft.

## F1 — Public Platform codebase and Folder Factory

**Migration direction confirmed:** convert the existing Lazurio Folder in place and
one-way, preserving Organization/Personalspace paths, repositories and worktrees.
The installed distribution supplies the selected profile; legacy Git is inventory and
provenance, not a profile-branch delivery mechanism. Retire only identified legacy
product files, Git metadata and product worktrees after preserving unique work and
checking dependencies. Data recovery and interrupted-operation forward repair remain
required; restoring a runnable legacy checkout does not. See the migration contract.

**Direction accepted in the request:** a public TypeScript Platform repository containing
CLI, Launchpad, Lazurio Folder Factory and shared contracts. Folder Factory owns only the
generation/reconciliation capability; it is not the whole product or a Machine-level
authority. Local and hosted environments, Buddy and AI Colleagues consume installed
Platform releases.
**Confirmed stack and installation direction:** develop the CLI and shared core in
strict TypeScript with pinned Bun tooling. Distribute a standalone executable containing
its required runtime; users do not need a separately installed Bun, Node or npm. First
installation starts with a terminal command and a thin bootstrap that verifies and
installs Lazurio; environment setup belongs to the shared core. HTTPS delivery from
the official source followed by verification of the release attestation is accepted
(F13; this replaces the earlier selection of TUF). A controlled internal
pilot may precede Apple Developer ID, notarization and Windows publisher signing;
these remain mandatory before public release. Remaining technical details are delegated
to the implementer to specify and verify, without disabling OS protections.
React/Vite for the real Launchpad remains under consideration;
the proof's tiny native HTML surface is not a final UI framework selection.

Baseline incremental cleanup of the legacy source-working directory retains deployment coupling.
It remains the maintenance path for existing users, but cannot be the final daily
installation model. A wholesale source copy reproduces hidden assumptions and
licenses without review. Reuse behavior, fixtures and proven contracts selectively.
A new service per subsystem increases lifecycle and recovery complexity without
an independent consumer; reject that split at foundation stage.

An npm distribution could reuse current tooling but still requires correct runtime
and asset resolution. Standalone packaging reduces end-user runtime setup, at the
cost of larger OS/CPU artifacts and native signing/upgrade work. The bounded
[stack proof](stack-evidence.md) qualifies the choice only for its tested behavior.
Do not maintain npm and standalone as two independently implemented update paths.
If a package-manager shim is later needed, it must select the same verified release.

## F2 — Private and team hosted workspaces

The team's first development prerequisite is a working HumanAndMachineEmpire composition
in the owning Organization's Production Space, preserving existing checkouts and work.
It is the common starting point for development, integration verification and release
preparation. Component repositories retain source/review ownership; the public Platform
must remain independently buildable and usable without the private composition.
This prerequisite is not a requirement to finish Dashboard/Auth or deploy hosted services.

**Rewritten 2026-09-19.** The earlier text of this decision retired the shared
multi-Principal workshop as a target topology. That conflicts with canonical upstream
decisions 0147–0149, which define the Hosted Team Workspace as an Organization-owned
Machine without an assigned operator. Upstream wins. Both hosted kinds are first-class:

| | Private hosted workspace | Team hosted workspace |
| --- | --- | --- |
| Used by | One named Principal | Several Principals of one Team connect |
| Machine Owner | The Organization, or the Principal under upstream rules | The Organization |
| OS account | One | One, shared; not a human Principal |
| Provider identity | The Principal's own sign-in | Brokered platform App identity; short-lived repository-scoped tokens |
| Personal credentials | The Principal's own, in their custody | None, ever |
| Personalspace | Not mounted on an Organization-owned Machine | Never present |
| Attribution | The Principal's own provider identity | Bot committer, Team author pseudo-identity and workspace trailer (upstream 0148) |
| How changes land | The Principal's live rights | Pull requests; an authorized person reviews, merges and takes responsibility |
| Revocation | The Principal's grants and sign-in | Live GitHub Team grant checked at each token issue (upstream 0149) |
| Workspace preset | `hosted-personal` (the Principal's own personal VM) or `hosted-organization-personal` (an Organization work VM assigned to one operator) | `hosted-organization-team` |

**Intent that remains.** A personal environment is never shared ad hoc. Nobody adds a
second person to a private workspace, a workstation or a Buddy host; nobody copies a
session, token or Personalspace onto a shared Machine to make it convenient. Sharing
happens only on a Machine that was delivered as a team workspace, with the credential
and attribution contract above. Individual isolation is a private workspace (or,
upstream, a single-member Team Workspace), never a Unix-user split inside a shared one.

A shared workspace combines files, processes and recovery by design; its members accept
that common scope knowingly, and the Organization owns it. Private workspaces simplify
attribution and failure scope at the cost of more provisioning, per-seat updates and
capacity. Neither choice is a new IAM system, and the preset never grants access.

The hosting owner must specify and prove the isolation envelope of each kind; a parent
operator remains a higher compromise domain. Placement never proves the Git pusher:
verify the provider identity and exact repository grants at the operation boundary.
On a team workspace, a change that cannot be attributed to the Team through the
brokered identity fails closed. Live Team-grant verification in the broker is a target
contract upstream, not deployed behaviour; it is an external dependency of
`hosted-organization-team` acceptance. Platform consequences: [workspace presets](workspace-presets.md),
[content synchronization](content-sync.md), [hosted entry](hosted-entry.md),
[tools and sign-ins](environment-tools.md) and [machine handover](machine-handover.md).

## F3 — Profile is behavior, not authority

**Launch composition confirmed:** one shared Folder foundation must compose Windows
local human, macOS local human, remote virtual-Machine human and virtual-Machine Buddy
journeys, each in Czech and English. Execution OS, local/remote use, purpose and locale
are independent dimensions, not four template forks. Detect OS on the execution Machine.
Preserve Folder layout and Organization/Personalspace paths/content across variants and
language changes. Exact virtual-Machine OS support remains an explicit qualification
choice. Existing native OS/harness and custody gates remain binding.

**Direction accepted:** coordinator behavior, configurable technical detail and
publication mandate are distinct. **Accepted ownership:** per-Machine profile, independently selectable for the same
Principal on different Machines. No automatic sync or global override engine.
**Proposed implementation:** versioned machine-local preferences and deterministic
Folder-owned generation through one Folder Factory capability shared by CLI and Launchpad.

Editing generated instructions creates a second truth; editing Platform source for
every user creates personal product forks. Both are rejected. A generic plugin/profile
DSL is unnecessary. Predefined templates and preserved machine-local custom sources
are both accepted: free-form working instructions and proposed mandates are supported
design requirements. Composition precedence must be explicit; an imported proposal
is never effective authorization. Storage format and activation UI remain open.

Generation manifests identify owned files, expected previous digests and the
active preference revision. Product upgrade, profile activation and data migration
have different transactions and compatibility checks. See [recovery](migration-and-recovery.md).

## Required amendments before production implementation

| Existing authority | Proposed precise change | Preserved invariant / retirement evidence |
| --- | --- | --- |
| Decisions 0128 and 0144 / `Conglomerate Host` | Accepted: deprecated root/product name stays deprecated; Conglomerate means the Principal's Machine graph, Host is a specific infrastructure Machine | No new authority, ACL or registry; consumer terminology migration remains separate |
| Decisions 0136 and resident-distribution knowledge | Platform source is optional development input; installed product owns runtime; Folder Factory preserves the canonical Lazurio Folder path | Legacy source-working directory supported until explicit migration and restore proof; no second active Lazurio Folder |
| Decision 0137, session semantics (F8) | **Required upstream amendment.** Long-running module applications are owned by the OS service manager (Linux first), not by the Launchpad process: Start survives a Launchpad restart, Stop stops the service, persistence across reboot is an explicit per-application setting. macOS workstations keep session-scoped applications | Module-owned ports and collision refusal; no foreign process adopted or signalled; health, catalog and background requests start nothing; production still accepts only a reproducible Build; no Lazurio supervisor or daemon |
| Decisions 0147–0149 and the Hosted Team Workspace | No amendment: Platform's former F2 proposal to retire shared Team execution is withdrawn. Platform consumes the brokered identity, attribution and live-grant contract as written | No personal credentials or Personalspace on a team workspace; live Team-grant verification remains a broker change upstream |
| Decisions 0091, 0092, 0094 and Machine architecture | Clarify private versus team hosted use, infrastructure ownership and custodian recovery | Personalspace remains private, Buddy not Principal, AI Colleague own identity, parent operator boundary explicit |
| Decision 0129 (F9) | **Required upstream amendment.** Product upgrade uses artifacts and is a separate operation from content synchronization. Content synchronization keeps 0129's hierarchy, atomic materialization, fast-forward-only rule, sibling quarantine and exclusions, but dirty or wrong-branch checkouts **block** instead of being stashed and switched to `main` | No product updater scanning/rewriting repositories; no reset or auto-merge; Source update retired by cohort; an explicit separate preservation operation replaces the implicit stash |
| Decision 0144 and the Machine identity schema (F10) | **Conditional upstream amendment.** Only if preset provenance must appear in `lazurio.machine.json`: add the field upstream in the hosting engine, then re-pin and conformance-test here | Identity stays descriptive and grants nothing; nothing is derived from names; `account` stays `null` until its contract exists |
| Decision 0145 (F12) | No amendment to the decision. **Admission superseded 2026-09-28** (Principal, question H1, decision F22 point 1): canonical-only `current` roots execute now (variant B), without waiting for an upstream identity continuity proof; the proof requirement F12 stated is historical | Transition-only admission is retired, variant A kept one line away for the record; no fallback to the deprecated projection; no second schema; `legacy`, `projection_drift`, `conflict`, `missing` and templates still refuse |
| Decision 0146 (F11) | No amendment: Platform consumes the per-application hostname, catalog and session model through a hosted request adapter | Gateway authenticates; forwarded identity headers are not trusted; unknown hosts refused |
| Decision 0166 (F21) | No amendment: **accepted 2026-09-28** (Principal, questions Q1–Q6 of the recovery-mode shaping). No program rollback; Recovery mode with a repair agent or a sanitized issue for every entry; quality gates and an 8-hour canary on the pilot Organization's work VMs and its operators' personal VMs. Within this repository it amends F4, F13, F17 (with its addendum point 3) and F18; in the root it replaces 0161's mention of the Platform's own rollback | Atomic failure, refusal before the switch, floor and high-water stay; no shorter or narrower canary without the Principal's decision recorded in the register; Machines' own rule is a separate Machines decision, not done |
| Decisions 0167 and 0168 (F22) | No amendment: **accepted 2026-09-28** (Principal, questions H1, H4, H6, H3 in direction, the drops of the parity shaping). The Platform Launchpad replaces the resident in one Machines apply; Ubuntu 24.04 on every hosted Machine, personal VMs by a rebuild with state transfer. Amends F8's "Not done" list, F12's admission (its addendum) and F15; in the root 0167 amends 0137 and 0049, and 0168 ends the 0159 exception on Team Environments | No side-by-side period, transition hostname or way back; no new Folder state; `entry` written only by Machines; H2, H5, H7 and the preview lease rules (B14) stay open |
| Decisions 0134, 0140 | Installed executable carries its runtime; development/module toolchain checks remain capability-specific | No automatic machine-wide PATH/tool upgrades; packaging does not claim third-party app dependencies bundled |
| Decision 0142 | Lazurio Folder Factory composes purpose, behavior and locale from versioned inputs | Organization language ownership and stable locale-neutral reason codes preserved |
| Collaboration constitution / 0132 | Define coordinator acceptance with real harness capability and independent verification | Principal retains scope, access and publication authority |

Canonical amendments belong with the existing maintained decision owners. This
preparation records replacement text and acceptance intent; it neither edits live
host policy nor assigns new global decision IDs. Owner-specific migration and
infrastructure details stay outside this repository.

Open decisions are: possible conflict with the no-central-registry/no-global-sync rule;
the natural owner of topology; discovery, projection and freshness; the transport,
requester authentication and acknowledgement of Dashboard-originated typed requests
(their shape is decided in F10); privacy and observability; legacy local-checkout
migration; and migration of legacy terminology. None is an implied implementation task.

## Provenance and publication

`Lazurio/LazurioPlatform` is the current public repository. It was renamed from
`Lazurio/LazurioFactory` on 2026-09-13 and is not a transfer or rename of
`HumanAndMachines/Lazurio`. The repository rename does not change legacy package
coordinates, Git remotes, signing identities, releases, version history or IP rights.

Public-first development was explicitly requested after repository creation. The
bootstrap history was inspected before changing visibility: one commit containing
only the short repository README. No legacy core or private content was published.

Before legacy code reuse/product release, the authorized owner must settle license and IP
provenance, preserving notices and exact source refs. Decide the final public source
URL and legacy redirect policy, artifact/package names and trusted signing identity.
Keep an auditable mapping `legacy source/ref → reviewed reused component → Platform ref`.
Do not copy private planning, provider operations or customer context into public docs.
The Principal selected [Elastic License 2.0](licensing.md) for newly owned Platform
code, documentation, runtime and embedded templates. User content and marketplace
submissions retain their own rights; dependencies retain original terms/notices.
No legacy FSL source is relicensed and no automatic Apache transition applies.

A candidate's provenance includes source repository and full commit, dependency
lockfile, toolchain pin, target, artifact digest and signed release metadata. A digest
alone detects corruption but does not authenticate its publisher. Trust bootstrap,
signing-key rotation and Windows/macOS distribution signing (rollback retention left
this list with F21)
must be implemented and exercised before public release. The controlled pilot exception
above defers OS publisher signing only, not release verification, preservation or recovery.
No keys or workflows
are created by this draft.

## Open gates, owners and resolution evidence

The [release cycle proposal](release-cycle.md) recommends one product version,
immutable candidates and promotion without rebuild. Its two test paths, explicit Machine-wide candidate activation and promotion of the
same qualified artifact are accepted requirements. How a release is selected, trusted, detected and activated is decided by F13 and the
[product update contract](update.md): `latest` or one explicit exact tag selects a GitHub Release; there is no update channel and no channel promotion.

| Gate | Accountable function | Evidence needed |
| --- | --- | --- |
| Decision amendment acceptance | Product Principal and maintained decision owner | Reviewed canonical amendments, explicit migration scope |
| License/IP and product release | Authorized repository/IP owner | Reused-source inventory, license disposition, explicit product-release instruction; repository visibility is already public by request |
| Native supported platform floor | Lazurio Platform maintainer | Native OS/CPU/ABI tests; build success alone insufficient |
| Hosting envelope for private and team workspaces | Infrastructure owner | Isolation and identity smoke per kind, brokered attribution and revocation on the team kind, recovery plan; legacy shared workshops converge to one of the two kinds |
| Release trust and recovery | Distribution owner | One real release candidate verified by a compiled client, tamper and wrong-identity denial, protected tag and release environment in place (F13) |
| Coordinator capability | Harness integration owner | Actual delegated and unavailable-tool scenarios, not generated text assertions |

Function labels describe required responsibility, not granted permissions. Concrete
assignment and scheduling belong to the Organization's Mission Control.

## F4 — Qualification and one active installed product

Accepted: the first usable transition version requires official native macOS, Windows
and Linux installation, full CLI, real Launchpad and generated base instructions used
by actual Codex and Claude Code consumers. Preserved Launchpad scope is module
discover/start/status/stop plus the necessary navigation, readiness and error handling;
full unspecified legacy feature parity is not an accepted promise.

Accepted: three simultaneous worktree tests are isolated; a separately integrated,
qualified candidate may then be explicitly selected for the Principal's whole dedicated
Machine and real Lazurio Environment before stable release. These are not alternatives. A per-shell
override alone cannot prove daily activation. Repeated PATH rewriting and a separate
candidate updater are rejected because they create conflicting selectors. Extend the
installer's existing version selection and lifecycle owner; details remain proposals.
Build failure preserves active software. There is no program rollback (F21); data is
repaired forward.

## F5 — Profiles, evidence and the single marketplace

Accepted: expertise and proactivity are independent, profiles are Machine-local and
can propose Machine or Organization mandates without transferring effective consent.
Generated instructions discover current access instead of embedding an ACL snapshot.

Accepted: optional minimal field measurement informs profile/model/harness/task fit;
community sharing has explicit preview and author choice. Benchmark and field results
remain distinct. No guarantee of anonymity, universal best profile or backend exists.
Reuse profile version/provenance and existing consent/runtime owners rather than a
new recommendation identity graph, configuration engine or telemetry platform.

Accepted module consumer: an immutable authored release is deliberately integrated
as a tested draft into a customer's own Organization; later updates preserve local
changes through another integration. Licensing/entitlement/support/visibility terms
are independent open decisions, not consequences of Lazurio Platform's ELv2.

Accepted hosted-assistance outcome: scoped advice and preparation of customer-owned
repo drafts can run without a local developer toolchain. Credit budget is not access
or publication authority. The provider isolation, credential delegation, charging and
lifecycle mechanisms require their actual consumer and failure evidence before launch.
No implementation, account service, billing or live migration is authorized here.

## Managed-service and private-integration boundary

**Direction confirmed by the Principal:** the public Lazurio Platform is source-available
under Elastic License 2.0 and remains self-hostable for personal and internal commercial
Organization use. Human and Machine s.r.o. reserves customer-facing hosted/managed service
delivery, with separately contracted partners as the explicit exception.
External implementers may deploy Lazurio for a customer's own internal use without that
implementation alone becoming the reserved customer-facing managed service.

`HumanAndMachineEmpire` is the private integration repository. It pins the
public Lazurio Platform with private Lazurio Account/Auth, Lazurio Dashboard and managed
Machine-hosting components. Those services are optional for self-hosted Lazurio and do
not become access authority for Organization repositories merely by being integrated.
Its initial composition uses exact Git submodule pins; partner agreements, prices,
cross-component release rules and hosting mechanisms remain open.

The licensing model is Elastic-2.0 for public Platform code plus a separately negotiated
commercial license for approved service providers. This is source-available, not OSI
open source. Human and Machine s.r.o. is the named licensor; accepting outside contributions
or relicensing additionally requires verified inbound rights.

## Discussion gap audit and implementation routing

The initial foundation covered ownership, preservation and a preview proof. The
following gaps are now specified as contracts; this table is a coverage map, not a
claim of completed implementation or a second delivery ledger.

| Clarified requirement | Gap in initial foundation | Canonical implementation contract |
| --- | --- | --- |
| First transition usable on three OS / two harnesses | Compilation matrix did not bind actual harness behavior | acceptance.md: first usable transition gate |
| Retire legacy development checkout | Legacy path was only provenance | migration-and-recovery.md: retirement gate |
| Isolated tests and Machine candidate | No explicit distinction or active-selector lifecycle | release-cycle.md: two modes, state/failure contract |
| Dynamic discovery | Access checks lacked generated-agent entry flow | ARCHITECTURE.md: discovery at task entry |
| Expertise and proactivity | Collaboration/detail omitted domain competence | ARCHITECTURE.md: axes and profiles |
| Machine and Organization mandates | Scope was underspecified | ARCHITECTURE.md: scoped consent intersection |
| Optional evidence | No minimization/consent/bias contract | profile-evidence.md |
| Community loop | Catalog fields lacked share/try/adapt/feedback and moderation | marketplace.md: community loop |
| Provider business model | Not technical public-source authority | Owning Organization's private knowledge and planning; no customer/business data here |
| Paid immutable modules | No purchased-release integration/update consumer | marketplace.md: source purchase and integration |
| Dashboard assistance | No scoped execution/budget/recovery contract | hosted-assistance.md |

## F6 — Two priority local entry journeys

**Accepted product requirement:** maker profile adoption in an existing harness and
technical founder local preparation are both priority first-version journeys. A founder
must be able to build a useful organization/project and modules locally without a
GitHub account, then explicitly connect their own GitHub while retaining files and Git
history. This is no longer deferred dashboard research. GitHub is remote collaboration
and access authority for connected resources; it is not application hosting.

**Proposed amendment, not a deployed model:** distinguish owner-local project preparation
from a GitHub-bound Organization. The former is usable local work, not a hollow preview:
local repos, module declarations, instructions and app lifecycle run under the existing
Machine/filesystem owner's authority. It has no fabricated GitHub identity, Organization
membership, roles, remote rights or independent ACL. Product language may describe
preparing an organization, but discovery must show that it is not yet provider-bound.
Reuse the project/module manifest owner with a versioned binding distinction; do not
invent a registry, account system or parallel permission store. Exact schema, naming
and physical layout require the maintained Organization decision owner's amendment
before implementation. Local files remain useful without a remote; optional later
binding is not a trial expiry or code unlock.

| Alternative | Assessment |
| --- | --- |
| Require GitHub before useful project work | Simplest current baseline, but fails the accepted founder requirement |
| Treat local declarations as provider Organization rights | Superficially uniform, but creates false authority and an implicit second ACL; reject |
| Owner-local preparation, explicit provider binding | Recommended: one local data owner, preserved Git history, live GitHub authority only for connected operations; requires visible lifecycle distinction |

Amend the current Organization=GitHub definition and its discovery/materialization,
module and Doctor consumers together. Existing connected Organizations retain their
provider identity and rights. No current config is silently reclassified. This proposal
belongs alongside the existing maintained Organization model, not a new global decision
number or a hidden product exception. The real consumer and recovery gate are in
[acceptance](acceptance.md#technical-founder-local-to-github-acceptance).

Binding plans must identify the actual GitHub account, exact destination Organization
and each repo, live create/write rights and visibility before any upload. Mark each
repo bound only after confirming its remote identity and uploaded ref; mixed completion
stays explicit until every selected binding is verified. Preserve commit IDs,
branches, tags, dirty/index/untracked work and linked worktrees. Public destinations
require a separate reviewed publication decision and history/content screening; secrets
or private history stop upload, never trigger automatic history rewriting. Nonempty
or divergent remotes require an explicit integration plan. A partial multi-repo upload
cannot be rolled back by deleting remote work: record confirmed outcomes, recheck them
on retry and preserve local usability. Provider binding is not app deployment.

## F7 — First-version outcome visibility and first analyst pilot

Accepted: from the first public product version, provide a view of product use,
community participation and commercial outcomes. It must show missing data honestly;
profile/model benchmarking remains a separate analytical purpose. Reuse existing
analytics and CRM capabilities as the proposed baseline; no vendor is selected and no
new collector or CRM is implemented. The [measurement contract](profile-evidence.md)
defines consent, separation and acceptance.

Accepted first concrete AI Colleague dogfood role: product/growth analyst, running a
versioned transferable profile on a dedicated owner-approved Machine with its own
seat/identity, one human custodian and actual Organization grants. Daily evidence-based
results/deviations/missing-data/recommendation reports and a deeper weekly analysis
exercise installation through update/recovery. Hardware, named custodians, Organization
data, effective mandates and credentials stay in private owner documentation. This
foundation authorizes no provisioning, identity, scheduler or report publication.

Accepted communication direction: adapt an existing agent with a community or custom
role/persona and work on your project. Exact copy remains a draft. Build the product
using the product; publish deliberately selected reusable profiles and sanitized evidence
of outcomes and failures. A profile alone cannot guarantee autonomy, runtime availability
or task success. Sharing/streams do not relax private-data or publication boundaries.

## F8 — The OS service manager owns long-running applications

**Accepted direction (2026-09-19); implemented for Linux as transient systemd user
services on 2026-09-19, macOS session-scoped.** Reboot persistence, lingering, launchd
and the upstream amendment remain open. Long-running module applications
are owned by the operating system's service manager, not by the Launchpad process.
Linux first: systemd user services generated from validated module declarations with
the exact working directory, command, environment and source selection. Identity and
readiness are queried from the service manager, never reconstructed from saved PIDs.
Start survives a Launchpad restart; Stop stops the service; persistence across reboot
is an explicit per-application setting, never a consequence of clicking Open. Ports
stay module-defined and collisions are refused. Bounded preparation subprocesses keep
the existing guarded-process ownership. macOS keeps session-scoped applications until
a workstation consumer needs more. No Lazurio supervisor or daemon is built.

Motivation: a product that updates itself must not make people accept interruption of
their work. While applications are children of the Launchpad, every product activation
or Launchpad restart stops them, and availability of the product depends on people
repeatedly agreeing to lose running work. This changes the session semantics of
upstream decision 0137 and requires the amendment listed above. The contract is in
[module adoption](module-adoption.md#application-lifetime--implemented-for-linux-session-scoped-on-macos).

| Alternative | Assessment |
| --- | --- |
| Keep applications as Launchpad session children | Simplest and current; couples application availability to product update and Launchpad restarts; rejected for hosted Linux |
| Build a Lazurio supervisor or daemon | A second lifecycle to install, update, secure and recover; duplicates the OS; rejected |
| OS service manager, Linux first | Recommended: standard capability, survives the Launchpad, queryable identity; cost is one adapter per OS and an upstream amendment |

## F9 — Update Lazurio and Synchronize content are separate operations

**Accepted direction (2026-09-19), not implemented.** "Update Lazurio" changes product
bytes; its contract is the product update document (`docs/update.md`, separate PR).
"Synchronize content" changes Organization repositories; its contract is
[content synchronization](content-sync.md). They have separate commands, buttons,
locks and outcomes. Product update never clones, stashes, regenerates preferences,
upgrades tools or runs data migrations. Content synchronization is explicit only and
blocks on dirty or wrong-branch checkouts instead of stashing and switching, a
deliberate change from the legacy engine that requires the 0129 amendment above.

## F10 — Workspace presets and typed owner requests

**Accepted direction (2026-09-19); amended and accepted by the Principal 2026-09-22;
local preset model implemented, typed owner requests not.** A named, versioned,
declarative [workspace preset](workspace-presets.md) composes purpose, collaboration
defaults, required capabilities, enabled surfaces and supervision policy. A preset does
not select product releases: F13 has no update channel to configure.

**Amendment 2026-09-22.** Three hosted presets, next to the `local` workstation
default: `hosted-personal` (a Principal's one personal VM: Personalspace present, no
Organization repositories mounted, the Principal's own sign-ins, Buddy optional),
`hosted-organization-personal` (an Organization-owned work VM assigned to one
operator; Organization repositories; Personalspace never present; formerly
`hosted-private`) and `hosted-organization-team` (an Organization-owned team VM, one
OS account, several Principals, brokered Organization identity; formerly
`hosted-team`). Nothing was implemented under the old names, so no compatibility.
The preset is **derived from the Machine handover** and can only be confirmed or
explicitly overridden within what the handover allows: `machine.kind: "personal-vm"`
→ `hosted-personal`; `"workspace-vm"` with `owner.team` → `hosted-organization-team`;
without → `hosted-organization-personal`; a personal VM never takes an Organization
preset and vice versa, and an explicit choice is recorded as such. What comes from the
handover (kind, name, owner, team, tailnet identity, host, relationships when present)
is immutable and only shown; the preset and the communication axes change through the
one existing preview → apply profile change. `folder-init` adopts an existing Folder
instead of requiring an empty layout. The Environment stores the immutable preset
reference plus explicit local overrides under the existing environment-configuration
owner; the instruction axes of the profile renderer are not extended into a universal
infrastructure configuration.

**Amendment 2026-09-22 (first real canary).** A Team in the handover does not decide
the preset: an Organization may model one operator's work VM as a GitHub Team named
after the operator, so `owner.team` is not a fact about assignment. Platform never
guesses. `workspace-vm` without `owner.team` still derives
`hosted-organization-personal`; with `owner.team` it derives nothing and `folder-init`
requires an explicit `--preset` (`preset-ambiguous` otherwise; an adopted Folder keeps
its preset). Machines will add an explicit `owner.assignment`
(`{kind: "operator", github_login, github_id}` | `{kind: "team"}`) that becomes the
single source of the assignment; no heuristic and no local schema change stand in for
it. The rendered Owner line names the Team only under `hosted-organization-team`.

**Amendment 2026-09-22 (Machines v0.12.61).** The vendored handover schema is
re-pinned to Machines v0.12.61 (commit `cb305ce`), which carries `owner.assignment`
on the Organization branch and `relationships` on both. `owner.assignment` is now
**the** selector between the two Organization presets: `operator` →
`hosted-organization-personal`, `team` → `hosted-organization-team`, regardless of
`owner.team`. The ambiguous case remains only for handovers without it (`workspace-vm`
with `owner.team`); `workspace-vm` without either still derives
`hosted-organization-personal`, so a v0.12.59 handover reads and derives exactly as
before. Both fields are recorded in the immutable Machine binding exactly as written
(absent stays absent) and rendered: the assignment as one line in `AGENTS.md` and
`manual/this-machine.md` and in the Launchpad's "This Machine", the relationships as
the manual's `Relationships` section (one line per peer, with the sentence that
Lazurio enforces none of it and Headscale does), a compact list in `AGENTS.md` and
the Launchpad, nothing when absent. The relationships never take part in derivation,
and Platform derives no access, no reachability and no heuristic from either field.
The three preset names `hosted-personal` / `hosted-organization-personal` /
`hosted-organization-team` are final; `hosted-private` / `hosted-team` have no
compatibility path.

**Amendment 2026-09-23 (handover refresh).** Observed in production: Machines
re-applied a personal VM with one more peer (the operator's work VM, outbound SSH);
the handover was rewritten, but `AGENTS.md` and `manual/this-machine.md` kept the
peers recorded at adoption and `profile-preview` with the same choices was
`unchanged`, so an agent on the personal VM never learned it may reach the work VM.
Only the Machine **identity** (kind, name, Owner, tailnet node, host) is immutable
(unchanged from PR #22); the rest of the binding (assignment, relationships, handover
digest) is handover-derived content and follows the current handover. The new
`lazurio machine folder-refresh` re-projects the binding of the same Machine and
re-renders with the recorded preset and profile through the one Folder change planner
and transaction of `profile-update` (digest-checked edits refused by path, staged,
archived, revision bumped, `profile-resume` recovery). A binding that renders the same
bytes is `unchanged` and not recorded, so a re-apply that only rewrote `installed`
never bumps the revision. A preset recorded as derived that the new assignment no
longer derives is `preset-derivation-changed`: the Principal chooses again. The
Machines resident role calls it after every handover write on an existing Folder.
The shared transaction (refresh and profile update alike) re-checks the claimed
boundary of a hosted Folder before its journal, before every replacement and in
`profile-resume`, as adoption and initialization recovery do: a foreign top-level
entry is refused by name and the interrupted state is left in place. A workstation
Folder keeps preserving the Principal's own top-level files.

| Alternative | Trade-off / disposition |
| --- | --- |
| `profile-preview`/`profile-update` treat a changed handover rendering as a change | The caller must hold the recorded profile choices and revision, which Machines does not own (the Principal changes them in the Launchpad); the generic profile commands and the Launchpad would have to read the Linux handover; one revision would mix a Principal's choice with an infrastructure rewrite; rejected |
| Explicit `machine folder-refresh` over the same planner and transaction (selected) | One more input to the one change use case, bound like `folder-init`, non-interactive, no parallel writer |
| Automatic re-render by the Launchpad or updater on start | A write without an explicit caller (F14 defers automatic writes); on hosted Machines Machines installs without `--service`, so no Platform unit runs at boot yet; could later be a thin caller of the same use case; rejected for now |

**Amendment 2026-09-30.** A fifth preset for the Automated Environment of upstream
decision 0169 is proposed in [F27](#f27--the-steward-preset-for-the-automated-environment).


A user-facing "Machine profile" choice has two effects with two owners: infrastructure
custody and topology belong to the hosting engine, Environment configuration to
Platform. A managed Dashboard may present one choice and dispatch typed,
resource-specific requests carrying an expected local revision to each owner. The local
core validates, applies through the ordinary use case and returns the accepted or
rejected revision plus the observed outcome. A concurrent local change is a conflict,
never silent cloud precedence. A generic desired-state-to-Machine pipeline is rejected.
Access grants, rosters, tokens, mandates and analytics consent are never part of a
preset.

## F11 — Hosted admission is not identity

**Accepted direction (2026-09-19), not implemented.** The hosted gateway authenticates.
The Launchpad does not trust forwarded identity headers and revalidates the browser
session against the gateway's configured auth endpoint. Lazurio Account login (OIDC) is
added when the Launchpad needs a named person or managed-service enrollment; it
identifies the service user and neither admits to a workspace nor supplies repository
rights. GitHub stays the only access authority. Self-hosted needs neither Account nor
Dashboard. The loopback protocol gets an explicit hosted request adapter as required
work. Contract: [hosted entry](hosted-entry.md).

## F12 — Canonical-only Organizations and a deliberately narrow first delivery

**Addendum 2026-09-28 (Principal, question H1 of the Launchpad parity shaping,
decision F22 point 1): the admission gate below is superseded.** The interim
transition-only gate ends without the upstream identity continuity proof: no owner of
that proof was named, and a canonical-only Organization would otherwise lose its
applications when the Platform Launchpad replaces the resident one. Implemented:
`isExecutableOrganizationState` in `src/organizations/root-resolution.ts` runs
variant B, so `transition` and `current` execute and `legacy`, `projection_drift`,
`conflict`, `missing`, templates and unresolvable roots refuse; variant A stays one
line away for the record. The exclusions stand: no fallback to the projection, no
second schema, no local finalization marker. The narrow first delivery in the second
paragraph is not affected by this addendum.

*Historical text of F12 as accepted on 2026-09-19; its first paragraph (admission and
exit criterion) is superseded by the addendum above.*

**Accepted direction (2026-09-19), not implemented.** Canonical-only Organizations are
the target normal case. Admitting only parity-valid `transition` roots is an interim
gate tied to upstream finalization readiness (decision 0145); requiring the deprecated
projection forever would institutionalize migration machinery. Exit criterion: a
trusted, live-verifiable identity continuity proof accepted upstream. See
[organization contract](organization-contract.md#exit-from-transition-only-admission).

The first hosted delivery is deliberately narrow: `linux-x64` and `darwin-arm64` are
the supported targets, `linux-arm64` is built for the qualification VM, installation
is per-user, and Windows, musl and Intel macOS wait for a real user. The launch matrix
in [acceptance](acceptance.md#platform-matrix-and-truth-labels) stays the
general-availability target; the canary path is narrower and says so. Internal usage
analytics, marketplace, hosted advice, legacy personal migration and generic remote
reconciliation are outside the canary path. Analytics stays default-off and
consent-bound per [profile evidence](profile-evidence.md) and can never block an update.

## F13 — Release trust is GitHub artifact attestation

**Amended by F21 (2026-09-28).** The durable version floor and the high-water mark
stay and refuse a downgrade; there is no retained previous version and no program
rollback.

**Accepted direction (2026-09-19), not implemented.** A product release is a GitHub
Release of the public repository `Lazurio/LazurioPlatform`, built by one protected
tag-driven workflow and carrying a Sigstore attestation (`actions/attest`) over its
manifest and every binary. The installed product verifies that attestation with the
maintained `sigstore` library against the workflow identity of the exact tag, the
repository and owner IDs and the source commit, and never goes below a durable
version floor on any network path. The contract is [product update](update.md). This replaces the earlier
selection of TUF. `latest` or one explicit exact tag selects a release; no document,
preset, local configuration or typed request carries an update channel, and there is
no channel promotion.

Motivation: the Principal asked for proven practice instead of our own machinery.
The TUF path was secure on paper, but the maintained JavaScript client does not
persist what it verifies, so the product had grown its own role promotion, floor
vector, link rules, a four-key publisher, a metadata tree on a second origin with a
daily refresh job, and a key ceremony — several thousand lines whose every review
round found another gap. None of it had a second consumer.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep TUF and finish the persistence layer around `tuf-js` | Strongest freeze and key-compromise model; we own a security-critical client layer and a publisher nobody else maintains; operating cost (keys, refresh, two origins) from day one; rejected for this product stage |
| Own signed manifest (offline root key signs an online release key, Tailscale `distsign` style) | Small and independent of GitHub and Sigstore; still our own protocol, keys and rotation drill; kept as the fallback if attestation proves unworkable |
| HTTPS and a checksum only (what most self-updating CLIs ship) | Simplest; a digest does not authenticate its publisher; rejected |
| GitHub Releases with Sigstore attestation | No keys, no ceremony, no second origin, maintained verifier and signer; selected |

Knowingly accepted: no expiring freshness metadata (an attacker holding both the
network and a valid `github.com` certificate can hold a client on its current
version, never lower, visible only as an ageing last check); GitHub Actions OIDC and
Sigstore's certificate authority, transparency log and trust root are cryptographic
dependencies outside Lazurio's control; authorization rests on the governance of the
repository, so the tag
ruleset, the protected `release` environment with a required reviewer, immutable
releases and commit-pinned actions are part of the mechanism, not hygiene; update
availability depends on Sigstore's trust root being reachable on a cold cache; a
private fork is a separately compiled product configuration. First installation is
authenticated by HTTPS only and says so; OS publisher signing remains a gate before
public release. (Since [F20](#f20--one-command-first-installation-the-downloaded-executable-verifies-its-own-release),
2026-09-28: the downloaded executable also verifies its own release attestation before
it installs itself; what that does and does not prove is in F20.)

Evidence before acceptance as implemented: a spike on 2026-09-19 verified a real
GitHub CLI provenance bundle with `sigstore@5.0.0` inside a `bun build --compile`
binary (wrong identity and a tampered artifact refused). Still required: one real
release candidate of this repository verified by a compiled client, and the native
Linux activation journey listed in the contract.

## F14 — Agent manuals live in the Lazurio Folder

**Decided by the Principal 2026-09-22; implemented in the local Folder model.** The
Lazurio Folder is self-contained for an agent that starts work on the Machine: what
Lazurio is, how this Machine fits into the Conglomerate, what is expected of agents,
how work is done, the roles, the glossary and how to solve problems. That content is
**product content**: six templates in this repository (`src/folder/manual.ts`),
versioned with the release and reviewed as code. They are rendered into the Folder as
its third owned top-level name, `manual/` (beside `AGENTS.md` and `.lazurio/`), by
`lazurio machine folder-init` and re-rendered only through the existing change path
(preview → apply in the Launchpad panel, and `machine folder-refresh`, which share one
planner and one transaction). There is no second mechanism.

`manual/` follows the Folder locale like `AGENTS.md` (amendment 2026-09-24 below;
it was English only until then); `AGENTS.md` links the six files. Every generated file carries a digest in the instruction manifest (schema 2,
`outputs`), exactly like `AGENTS.md`: a hand-edited or removed file is never
overwritten, the change path refuses with `drift` and the file's path. Adoption of an
existing Folder treats a `manual/` without recorded digests as a foreign entry and
refuses it by name. One transaction stages and replaces every generated output, changed
or not, so the journal, the receipts and the recovery paths have one fixed file list.

**Authority moves.** For hosted Machines the Platform-shipped manual is the authority.
The root repository that carried the agent rules until now is a **legacy source**: its
content of lasting value was extracted into these templates (the collaboration model
and its five boundaries, the Draft/Publication/Release rule, the worktree discipline
and the handoff, the roles, the glossary, the zones of decision 0155 and the persona
direction of decision 0156, the update and refusal codes of this product). The
Platform's instructions never reference that repository: an agent on a hosted Machine
knows only the Platform, and the root repository is to carry only a migration procedure
from itself to the Platform before it is retired for those Machines.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep the manuals in the root repository and clone it onto every Machine | One more checkout and a second authority next to the product; the root rules assume a workstation with the root's scripts; every hosted Machine would depend on a repository it does not otherwise need; rejected |
| Generate everything from the product (selected) | One authority, versioned with the release, reviewed as code, rendered per preset from the same inputs as `AGENTS.md`; the text can only change through a product release |
| Mixed: product renders the frame, the root repository supplies the prose | Two sources for one document, drift between them invisible to the agent; rejected |

**Principal's decision 2026-09-22: the pull-request lifecycle for agents.** From the
first push the work is visible as a GitHub Draft PR while it is in progress; once it is
finished and verified, the agent marks it Ready for review themselves (Ready is not
Publication; finished work never stays a Draft); and the agent assigns the pull request
(the GitHub assignee, plus the review request) to the GitHub user whose verification
they are asking for, so that person knows the work is theirs to check — the assignee is
the owner of the next step. `manual/working-here.md` states this rule directly. It
supersedes any repository `AGENTS.md` that requires review-ready pull requests from the
first push; the Dashboard's `AGENTS.md` will be aligned in a follow-up in that
repository.

**Deferred, deliberately not built.** An operator `notes/` area for hand-written
notes (today an edited generated file is refused and there is no restore command; the
troubleshooting document says so). The Launchpad may later show which product version
rendered the Folder. No automatic writes: the re-rendering after a product update is
decided below and happens only through an explicit change.

**Decided 2026-09-24: a newer template revision re-renders the Folder.** Until
`base-instructions-4` every change of the template revision made a refresh and a
profile change `template-upgrade-required`, so a Machine that received a new release
never received its new `AGENTS.md` and `manual/`. Now the one Folder change planner
treats a recorded revision older than the product's (`base-instructions-<n>`, ordered
by `n`) as an upgrade: the next `machine folder-refresh` (which Machines runs after
every apply) or profile change re-renders every generated file with the recorded
preset, profile and binding, through the same transaction, archive and recovery, and
records the new revision and digests in the same final manifest rename. Its
conditions:

- **No drift.** The old bytes cannot be rendered by the new product, so the recorded
  digests are the only proof of ownership: every generated file must still match its
  digest. One edited, removed or linked file refuses the whole upgrade with `drift` or
  `unsafe-path` and its path, and nothing is written. The coherence check that the
  recorded digests are what the composition renders applies only within one revision;
  the transaction's activation and recovery compare the previous outputs by the
  recorded digest for the same reason.
- **Never downgrade.** A recorded revision newer than the product's, or one of another
  form, stays `template-upgrade-required` (the code's meaning is now "this Folder needs
  a product at least as new as the one that rendered it"); Machines already records it
  as a finding, never a failure. An owner who rolls the product back keeps the newer
  Folder until the newer release is active again.
- **Idempotent.** A second run renders the same bytes and is `unchanged`.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep `template-upgrade-required` for every change of revision | No new state path; hosted Machines never receive a corrected manual; rejected |
| Re-render automatically on product activation | A write the Principal did not ask for, and a second writer beside the change path; rejected |
| A separate `folder-upgrade` command | The same planner and transaction under a second name, and one more step for Machines; rejected |
| Upgrade inside the existing planner, digests as proof (selected) | One path, the existing refusal for edited files, no downgrade |

**Amendment 2026-09-24, decided by the Principal (Matěj): the manual follows the
Folder locale.** Asked whether the manuals should be Czech or English, the Principal
decided they follow the locale, so that a Czech-speaking operator gets a Czech manual.
`manual/*` is rendered in the Folder locale (`cs` or `en`), with the same six file
names; `AGENTS.md` is unchanged in that respect. The locale is chosen as before (the
handover owner overlay at `folder-init`, then the profile). Both languages are written
side by side, paragraph by paragraph, in `src/folder/manual.ts`, so that neither can
change alone; technical identifiers (commands, codes, paths, preset names) stay in
English. A locale change therefore re-renders the manual too.

**Hosted content in `base-instructions-4`.** Three rules every hosted Machine's
`AGENTS.md` and manual now state: SSH to another Machine only to the tailnet hostname
the handover records, with a pinned host key (`HostKeyAlias`, a dedicated
`UserKnownHostsFile`, `StrictHostKeyChecking yes`) after verifying the active tailnet,
never to a bare `100.64.0.x` address or through the general `known_hosts`; the product
version, the tools and the Folder are updated by the Machines pin and the agent only
reports what is outdated (no `lazurio update` on a hosted Machine); and, on a personal
VM, Organization work belongs on a work VM and device work (the signed-in browser) on
a device, never cloned onto the personal VM. The peers this Machine may reach over SSH
are listed neutrally, exactly as the recorded `relationships` carry them; the handover
records reachability, not whose a peer is (a peer carries no owner or operator and its
zone may be `null`), so the text says reachability is neither identity nor mandate and
has the agent confirm with the Principal that a peer is theirs or assigned to them
before working there. Nothing is inferred from names, and the text says that
Headscale, not Lazurio, enforces reachability. Organization content synchronization is
stated as not implemented in the product yet, with only plain `git pull --ff-only` on
a clean checkout of its default branch, never a stash, switch or reset.

Verified by unit tests: the rendered manual per preset and locale (snapshots, parity
of the section structure between `cs` and `en`, no reference to the legacy
repository), the template upgrade (success, drift refused without a write, a newer
revision refused, an idempotent second run), the refusal of an edited or removed
manual file by path, the refusal of a foreign `manual/` on adoption, an idempotent
re-run, digests in the manifest, and every interruption and recovery path of the
transaction with the wider file list, and the recovery boundary: a foreign entry
inserted after the initialization journal is refused by name and nothing is written.

**Native run 2026-09-22.** The compiled `linux-arm64` client of PR #18 on a fresh
Ubuntu 24.04.4 ARM64 clone with a team-bearing handover (root-owned `0644`, umask
`077`): `folder-init` without `--preset` is `preset-ambiguous` (both Organization
presets allowed); with `--preset hosted-organization-personal` it initializes revision
1 as an explicit choice, the top level holds `.lazurio`, `AGENTS.md`, `manual/` with
its six files, `organizations/` and `personalspace/`, and `AGENTS.md` and `manual/*`
contain no reference to the legacy repository. A re-run is `already-adopted` and
changes nothing; a line appended to `manual/roles.md` makes `profile-preview` refuse
with `drift` and `path: manual/roles.md`; a `manual/` left behind without `.lazurio`
is `folder-foreign-entry` naming `manual`. Not proven: a native Launchpad preset
change on that Machine.

**Addendum 2026-09-28: two working rules of root decision 0163.** The generated
`AGENTS.md` ("How work is done here" / "Jak se tu pracuje") states each rule in a short
paragraph, and `manual/working-here.md` in full, in its own section: "Open questions go
to GitHub Issues and do not stop the work" and "Take review findings with judgment".
(1) An agent files an open technical problem, uncertainty or finding it cannot resolve
at once as a GitHub Issue in the exact owning repository without asking first, after a
duplicate check and after removing secrets, Personalspace and Organization content
outside its boundary; it continues with everything that does not depend on the answer
and stops only where it cannot continue safely or the decision is the Principal's. It
does not close, assign or prioritize issues without instruction; plan, priority and
responsibility stay in the Organization's Mission Control. (2) A real defect found in
review is fixed at once; trivia, speculation about a future change or a widening of
the scope gets a factual objection on the pull request and a request for a verdict on
the unchanged head; if the reviewer insists, both positions go to the Principal, and
the review is never bypassed. The manual no longer says that creating an issue is a
Publication that needs the Principal's mandate (`working-here.md`, `troubleshooting.md`):
0163 changed exactly that point of root decision 0139. No file is added. The template
revision stays `base-instructions-8`, like the F18 addendum: the latest release,
`v0.1.6`, renders `base-instructions-7`, so nothing rendered by revision 8 has shipped.
A unit test checks key sentences of both rules in `AGENTS.md` and
`manual/working-here.md` for every preset in both locales, and that no output still
calls an issue a Publication.

## F15 — The Platform Launchpad replaces the resident Launchpad; `launchpad.gen3.json` is legacy without a successor

**Principal's decision 2026-09-23, not implemented.** On a hosted Machine delivered
by Machines, the Launchpad in `lazurio-launchpad.service` is today the resident
runtime's copy of the legacy root repository, and `launchpad.gen3.json` plus the
per-Machine `launchpad.gen3.local.json` exist only because that Launchpad reads
them: the Machines resident role writes them, the Platform neither reads nor writes
them and its Folder only tolerates them by name. The question was whether to rename
the file to the `lazurio.<thing>.json` convention before the fleet rollout. The
decision is that the file has no successor:

1. **The Platform Launchpad replaces the resident Launchpad on hosted Machines.**
   The hosted request adapter of F11 ([hosted entry](hosted-entry.md)) is the work
   that makes the Platform's Launchpad serve `launchpad.<vm>.<org>.lazurio.io` (and
   `launchpad.<login>.lazurio.io`) behind the gateway; the unit then runs the
   Platform executable through its selector, which also removes the foreign-unit
   case of the update contract on those Machines. This is the next Platform work
   after the Machines role has installed the Platform on the first Machines.
2. **Machines stops writing `launchpad.gen3*.json` in the same release** that
   switches the unit. What the per-Machine `.local.json` carried (planned slots,
   the Personalspace owner) belongs to the Folder's preferences under the existing
   environment-configuration owner, not to a new file.
3. **The Platform keeps tolerating both names during the transition** and drops
   the tolerance once no resident Launchpad remains. Nothing in the Platform parses
   the file, and no compatibility reader is added: renaming a file that is going
   away would be work without a product.

Not decided here: the shape of the hosted request adapter (F11 shaping follows) and
the order of Machines releases; the legacy root repository's own rename of
`company.gen3.json` → `lazurio.organization.json` is unaffected.

**Addendum 2026-09-28 (Principal, after clicking through the preview of the Tools
section): the Launchpad's Settings follow T3 Code.** "I would like to keep to the UX
of settings the way T3 Code has it solved." The Platform Launchpad gets a Settings
area in T3 Code's pattern: the sidebar turns into the settings navigation, a header
with the breadcrumb, sections of grouped rows with the label and description on the
left and the control on the right, switches for yes/no, Back in the sidebar footer
and Escape to leave, an off-canvas sheet below 768 px, light and dark from the system.
Each section is a route (`/settings/general`, `/settings/machine`, `/settings/tools`),
never an `.html` file; the server serves the one page under exactly those paths and
the credential never travels in the path. The page's existing settings move in
without new ones: the Folder profile to General, the handover to This Machine, the
Tools section to Tools, the update pill to the sidebar footer (with a reserved place
for the Folder refresh indication above it); the development Application panel stays
on the Launchpad home. Plain CSS, no framework and no new dependency; Czech and
English. Patterns, sources and deliberate differences:
[launchpad development](launchpad-development.md#settings-structure-routes-and-the-t3-code-pattern).
The same day the Principal settled the follow-ups: a history entry per section;
the update pill only while an update is available, as in T3 Code, with the Folder
refresh line independent of it; "Set up with an agent" visible on the row of a tool
an agent sets up; the tool switch labelled "Used by agents" / "Používají agenti",
its meaning said once in the Tools intro ("guides agents to use this tool;
installing, uninstalling, signing in and signing out are separate acts"); and the
Environment kinds named "Personal" / "Osobní", "Work" / "Pracovní", "Work, Team" /
"Pracovní týmové" where the page already names a kind (the workspace presets).
**Team Environments and GitHub (Principal 2026-09-28).** A Team Environment
(`hosted-organization-team`) is never signed in to gh with a person's account and
never links a person's SSH key; it will work in GitHub through the GitHub App
"Lazurio for GitHub" installed under the Organization, so that GitHub shows which
Environment made a commit, pull request or issue. That integration is not built.
The Launchpad already shows no gh sign-in, SSH key or sign-out action there and says
why; the server and CLI rule that refuses such a login, and allows the sign-out of a
personal account left there, is the F19 addendum "gh on a Team Environment".

## F16 — One network per Organization: every Machine is reached the same way, and the Conglomerate graph is the truth agents move along

**Principal's decision 2026-09-25, direction; not implemented.** Recorded from the
Principal's own words, because it reframes F11 and the root-repository migration.

**The Machine is a boundary of access and functionality.** The operator's goal is to
automate it: install applications and automatic processes until the Machine works as a
colleague with a role in the Organization. When it breaks, the operator opens that
Machine's chat (T3 Code) from their own Machine and unblocks it. A Machine gives its
agents three things: **context** through the Lazurio Folder (which Machine this is, what
is expected here), **capabilities** through the Lazurio CLI on that Machine, and
**reach** through the accounts signed in on that Machine.

**Machines cooperate along the Conglomerate graph.** The graph says which Machine may
reach which — SSH, and the same URLs the browser uses. Along an edge an agent may move
by SSH from one Machine to the next; that is loose coupling, and the Machines then work
as one surface (the operator's work laptop and work VM: same accounts, they represent
the same person). Between different people's or automated Machines (Pablo, Henry) the
output goes through **GitHub**: separate GitHub accounts and rights, meeting in pull
requests; another person's agents enter such a Machine only for service events.

**One Organization, one network, one URL mechanism.** Where an Organization has
Headscale, every Machine of the Organization — hosted VM or physical laptop — is
reached the same way: `launchpad.<machine>.<org>.lazurio.io`,
`t3code.<machine>…`, and the module applications it hosts, from any Machine whose
graph edge allows it. Whether the Machine is virtual or physical must not matter.
From the Dashboard a person picks a Machine (Pablo's laptop today) and opens its chat.
A **work laptop is reached through the Conglomerate Host's gateway over the tailnet**,
with no gateway and no certificate of its own on the laptop; the laptop is a tailnet
node and its Launchpad, T3 and module applications listen on its tailnet address for
the gateway. For the Platform this is the same hosted request adapter as on a VM (F11):
the Launchpad needs only its external origin, the auth endpoint and the cookie name,
and it never matters on which Machine the gateway stands.

**Personal is a different thing.** A personal laptop, the person's phone and their one
personal VM form one boundary (SSH laptop ↔ VM, phone ↔ VM, decision 0153/0155). There
is no Organization network for personal Machines, no public name for a personal laptop,
and an Organization must not even be able to grant itself reach into a personal laptop:
the model has no such edge to allow.

**The truth of the graph is the infra repository of the Organization.** Which Machines
exist, what reaches what by SSH and by URL — declared there, tested by its CI, deployed
by Machines, applied to Headscale. The Dashboard is the one place where a person
composes the graph: a change opens a pull request into infra (an Owner or an agent may
open the same pull request by hand); the Dashboard never writes Headscale directly.
The Launchpad reflects what the Dashboard shows.

**One Lazurio Account ties it together.** The same Account signs into the Dashboard and
into the Launchpad of every Machine. It decides which Machines and applications a
person sees and may open, which chats they may join, and it carries the **preset and
profile** of a Machine so that they can be managed centrally: the Lazurio Folder is
generated for each Machine from one *Machine Assignment* — identity (kind, name, Owner,
operator or team), entry (the external names, auth endpoint, cookie), relationships,
preset, and the profile axes that shape the agent instructions (language, detail,
coordination; and, to be added, work versus personal, one or several Organizations,
founder versus employee, technical versus non-technical). Shared instructions are one
template for all Machines; the axes make the per-Machine difference. Two transports,
one schema: on a hosted VM Machines writes the Assignment as the handover, because the
VM exists before any person signs in; on a laptop the Dashboard serves it after the
Account sign-in and the Launchpad writes it into the Folder. Both end in the same Folder
state, so the Dashboard changes preset and profile everywhere through the one typed
request with an expected revision (F10), and `folder-refresh` re-renders.

**What this replaces.** The legacy root repository is decomposed by owner rather than
migrated as files: Launchpad, Guide, templates and scripts → the Platform executable;
manuals and agent rules → generated from the Assignment (F14); the skill package →
generated into the Folder by axis; `launchpad.gen3*.json` → gone (F15);
`organizations/` and `personalspace/` → mounts in the Folder; content synchronization →
F9. Order: hosted VM canary (Platform Launchpad replaces the resident one, Assignment
from the file) → laptops through the Account sign-in (the root checkout becomes a mount,
then a pointer) → work laptops reachable through the Conglomerate Host gateway.

**How a work laptop is classified.** An entry belongs only to a Machine with a
recorded Machine binding — today a hosted VM adopted from its handover. A laptop without
a binding is the `local` preset of F10: a personal Machine, and it can never hold an
entry, which is the guarantee that no Organization gains an edge into a personal
laptop. A work laptop becomes a Machine of the Organization the same way a VM does:
its Assignment (identity of kind `workstation`, Owner the Organization, operator
assignment, entry, relationships) recorded in the Folder — served by the Dashboard
after the Account sign-in, or written by a Machines workstation record. The preset
for such a Machine (an Organization-owned workstation: Personalspace present,
Organization repositories, the person's own sign-ins, reached through the
Conglomerate Host gateway) is decided in the laptop phase as an F10 amendment, not
here; until it exists no laptop can be given an entry, and the adapter's rule is only
"an entry requires a Machine binding".

**Naming (Principal's decision 2026-09-26).** A hosted Machine is a **Remote
Environment** (Czech *Vzdálené prostředí*) wherever people see it — the Launchpad's
Environment switcher, the Dashboard, the generated manual — the same term Codex and T3
Code use for a remote workspace: an Organization's work VM at
`launchpad.<machine>.<org>.lazurio.io` on the Organization's network, or a personal VM
at `launchpad.<login>.lazurio.io` on its Principal's home tailnet (0146, 0153). This
computer — the device the user is sitting at, not a hosted Machine — is the **Local
Environment** (*Místní prostředí*); the listener is not the classifier, a hosted
Launchpad also serves on loopback behind its gateway. The axis stays "Prostředí / Environments" and offers both; "VM" remains an
adjective; the internal term stays Machine; addresses do not change. Recorded in the
generated glossary (template revision `base-instructions-5`, so every Folder re-renders
on its next refresh).

**Not decided here:** the Dashboard API for the Assignment and the Keycloak account
consolidation (owned by the Dashboard thread), the Machines record for a workstation,
the preset of an Organization-owned workstation and the gateway routes on the
Conglomerate Host (Machines), and the exact profile axes.

## F17 — Operator tools belong to the operator; the rollout pins the baseline and repairs

**Principal's decision 2026-09-26 (root decision 0161), direction; the manual rule is
implemented in this revision, `lazurio tools` follows.** Recorded from the Principal's
words: operators of a Remote Environment must be able to update Codex, Claude Code, T3
Code, `gh`, Node and Bun themselves and are not to be blocked; there is no point in
pinning their versions; the provider should be clear about what it operates and use
the rollout only as a repair to the state where an agent can be started in the
Environment and fixes the rest per the Lazurio Environment manuals.

**Two layers.** The **provider baseline** is what a Remote Environment stands on and
must exist even when the operator breaks everything: system, accounts and sudo,
network and Headscale, gateway with certificates and admission, resident, Platform
(with its own floor, F13/F14, and no program rollback, F21), the Lazurio Folder with its manuals, and a
**recovery runtime for an agent** (Codex or Claude Code, `gh`, `git`, Node at a
known-good version) in a path owned by the Machine's installation authority (root on
Linux, the installing admin on macOS), outside the operator's PATH; only the Environment
entry (`lazurio`, the T3 launcher) uses it, when the operator's tools do not work. The
**operator's tools** are everything the operator runs as a tool on their PATH and in
their home. The baseline delivers them once at Machine creation; from then on the
operator updates them with the official installers, the rollout never downgrades or
overwrites them, and readback reports their versions as facts, not drift (Machines
0.12.83 refusing an operator's own `npm` is the failure this rules out).

**Rollout is repair, not a brake.** When the operator breaks the Environment so that
agents no longer work, the re-pin restores only the baseline and starts an agent in it
from the recovery runtime; that agent repairs the operator layer per
`manual/troubleshooting.md`. The rollout never touches what the operator installed.

**T3 Code** is part of the Environment entry (behind the gateway, in the unit), so it
belongs to the baseline, with its own runtime managed by its launcher and repaired by
apply and an Update button fed by `Lazurio/t3code` releases; T3 always runs tools from
the operator's PATH, and recovery goes through `lazurio` from the recovery runtime, not
through a PATH fallback (Machines, DEV-6624).

**Platform.** The hosted manual section "Updates on this Machine" now says (until the
addendum of 2026-09-28 below) that the pin owns the product and the generated files, not the operator's tools, and that an agent
updates operator tools only on the Principal's explicit instruction in the thread and
otherwise only reports versions (template revision `base-instructions-6`, so every
Folder re-renders on its next refresh). `lazurio update` remains the only product
update; `lazurio tools status|update` is the thin orchestration of the official
update paths (report the installed versions as facts; on instruction run the official
updater or installer of one named tool; never pin, downgrade or overwrite), specified in
[environment-tools.md](environment-tools.md). It covers codex (official standalone
installer), claude (`claude update`), bun (`bun upgrade`) and reports gh, git, node and
npm with their official source; it does not query what is available, because a version
check against a vendor is the vendor's updater's job and the Platform never says
"outdated" about an operator's tool.

**Addendum 2026-09-26 (root decision 0161 addendum, Principal).** The recovery runtime
above is withdrawn: there is no second copy of any tool. The baseline delivers one
installation of the operator's tools in one standard path — the first executable of
the name in `~/.local/bin` on the operator's PATH, official installers keeping their
own homes with only a link or wrapper there, Lazurio in `~/.local/share/lazurio/`,
system tools with the OS package manager — and a rollout repairs that installation in
place, in two tiers: (a) only the `~/.local/bin/<tool>` link or wrapper is missing or
dangling while the installer home holds a working binary — the link is recreated;
(b) the binary itself is non-functional or absent — the tool's official installer runs
at the baseline version, writes into its own home exactly as on any installation
(`~/.bun/bin/bun`, a new release under `~/.codex/packages/standalone/releases/…`) and
restores the `~/.local/bin` entry. A working tool keeps its version whatever it is;
the operator's configuration, sign-ins and history are never touched; only a tool's
own official installer writes into its home. The Machines apply starts no agent
(it would run with the operator's sign-ins without their instruction); it returns the
`lazurio doctor` and `lazurio tools status` readback, and the rolling-out Task Agent
starts the repair with the operator's mandate. T3 Code is the confirmed exception and
runs on the Node its version recommends, as a service runtime. The generated manual
gains "Where the tools live" on every preset (template revision `base-instructions-7`)
so agents on VMs keep the layout for further tools, and `tools status` reports
`standardPath`.

**Not decided here:** the readback shape and the T3 launcher (Machines).

**Addendum 2026-09-28 (Principal): the operator owns the Lazurio version; the pin
is a minimum.** Recorded from the Principal's decisions of 2026-09-28. (1) There is
**one updater**, `lazurio update`. The operator of an Environment updates Lazurio
themselves, on a hosted Machine (Remote Environment) exactly as on their own computer,
without any rollout: "updating Lazurio is the operator's update of a tool, not a
rollout". (2) A rollout **may** still move a working Lazurio forward, because
operators sometimes forget to update and sometimes it is needed. So the provider's pin
is a **minimum**: a rollout installs Lazurio when it is absent or broken, raises a
Machine that is below the pin to the pinned release, and never moves a Machine below
what it already runs — the existing floor and high-water rule of F13
([product update](update.md#offline-update)), which already refuses a lower pin with
`below-floor`. (3) Forward repair over rollback: no new rollback machinery;
`lazurio update rollback` stays what it is, the way back from a failed update. *(The
second half is withdrawn by F21 the same day: `lazurio update rollback` is removed and
a failed update is repaired forward.)*
(4) Linux first, then macOS; Windows later.

This changes one point of this decision: the installed Platform release leaves the
pinned baseline for its **version**. The baseline still delivers the first
installation and repairs a broken one; the version belongs to the operator like the
tools of 0161 point 2, with the one difference that a rollout may raise it to the pin.

*The standard entry `~/.local/bin/lazurio`* (0161 point 6) now exists. `lazurio
install`, the first installation and the offline update alike, links it to the install
base's selector `<base>/bin/lazurio` by one atomic rename, creating `~/.local/bin`
(`0755`) when it is missing. An entry that already points to the selector is left
alone; a link to the selector of a Lazurio install base (another base, or one that is gone) is replaced; a dangling link of any other shape is someone else's and stays; when `~/.local` or `~/.local/bin` is itself a link or not a directory, nothing is written through it (`conflict`, `parent`); a
regular file, a directory or a link to anything else is **never** overwritten — the
installation still succeeds and its result (`entry.state: "conflict"`, human and JSON)
names what is there and what the operator or an agent should do. Shell profiles are
never edited. The result reports whether `~/.local/bin` is on the process PATH (the
directory it tells the operator to put on PATH is `~/.local/bin` when the link exists)
and warns, with both paths, when another program named `lazurio` resolves first (the
legacy root CLI linked by Bun into `~/.bun/bin`, for example); it changes nothing about
that program.

*"Folder refresh needed."* A product update never writes the Folder (F14). So
`lazurio update`, `lazurio update status` and the installed Launchpad's update pill say
"Folder refresh needed" with the exact command when the Folder records an older
template revision than the active product renders: `lazurio machine folder-refresh`
on a hosted Machine; on a workstation the unchanged profile applied again
(`lazurio profile-update` with the recorded choices at the current revision, or
preview and apply in the profile panel), which the one planner turns into the same
template upgrade. It only reads; nothing is refreshed automatically, and an edited
generated file still blocks the refresh with `drift`. The Folder is `--folder`, the
supervised unit's, or on a hosted Machine the declared operator's from the handover.
The updater learns the revision a new version renders from that version's own
self-check report (`templateRevision`), before activating it; an executable older
than this addendum does not state it and nothing is reported rather than a guess — so
the first update performed by `v0.1.7` or older reports no refresh, and
`lazurio update status` of the new version does.

*The generated manual* no longer forbids `lazurio update`, `lazurio update rollback`
or `lazurio install` on a hosted Machine and no longer says the pin owns the product
version: the operator owns it; an agent runs `lazurio update` when the operator asks
(a change of the Environment, never on its own initiative) and `update status` freely;
the pin is a minimum and a rollout never lowers a version; the refresh command follows
an update; `lazurio update rollback` is for a failed update (since
`base-instructions-10`, F21, the manual says there is no way back and describes
Recovery mode instead). Template revision
`base-instructions-9` (revision 8 shipped in `v0.1.7`), so every Folder re-renders on
its next refresh. A unit test checks that no generated output, in any preset or
locale, still forbids `lazurio update` or gives the product version to the pin.

Root decision 0161 still lists "the installed release" among what the pin holds; it
is amended by a separate pull request in the root repository. What the Machines role
must do differently is the contract in
[machine handover](machine-handover.md#what-the-machines-role-does-with-the-lazurio-version-f17-addendum-2026-09-28).

## F18 — Enabled tools of the Environment

**Principal's decision 2026-09-27 (root decision 0162 and the F17 line), implemented
in this revision as data, state, rendering and read/write surfaces; installation,
sign-in flows and Launchpad UI are not built.** Lazurio is CLI-first: the `lazurio`
CLI and the Launchpad, one thing over one core, care for the tools of an Environment
and tell agents how to move in it. The operator opts in to tools from a tested
catalog, and what is on is written into the generated instructions and manual of the
Lazurio Folder, so agents know they are to use it. Turning a tool off removes it.

**The catalog** (`src/tools/catalog.ts`) gives a tool an `activation` when agents may
be told to use it:

| Tool | Command | Tier | Setup |
| --- | --- | --- | --- |
| `gh` | `gh` | required | launchpad |
| `composio` | `composio` | recommended | launchpad |
| `wacli` | `wacli` | optional | launchpad |
| `gogcli` | `gog` | optional | agent |
| `neon` | `neon` | optional | agent |

A `required` tool is always on, is never stored and cannot be disabled. The operator's
other tools (codex, claude, git, node, npm, bun) have no activation and stay what F17
made them. Each activation carries three texts in `cs` and `en`: `purpose` (one
sentence), `usage` (when and how an agent uses the tool, with the command that reports
its sign-in) and `installation` (the target state an installation must reach).

**Context, not authority and not installation.** Enabling a tool grants no access,
installs nothing, signs in nowhere and pins no version. A tool may be enabled while it
is not installed; the generated manual tells the agent to report a missing or
signed-out tool to the Principal. F3 holds unchanged: a generated profile never grants
permission.

**Priority rule for agents.** First the catalog CLIs that are on, as the generated
manual describes them. Then MCP servers, under one generic instruction to discover
what the harness offers. MCP servers are never recorded in the Folder, and an
available server is not consent to Publication.

**Two setup modes.** `setup: "launchpad"` means installation and sign-in will get a
curated Launchpad flow. `setup: "agent"` means the Launchpad only shows status, and
"install" opens a T3 Code chat with a prepared prompt for an agent who installs the
tool and guides the operator's sign-in; the Launchpad performs no installation. The
`installation` text is the agent's manual in both cases: the body of the prompt for an
`agent` tool, and what a fallback agent follows for a `launchpad` tool whose curated
installer failed. It names the binary and the standard path `~/.local/bin/<command>`
(F17), the official source, how the operator signs in, the probe that proves it, and
what must never happen: no secret in chat, Git or a log, no second installation of the
same tool, no downgrade of a working tool. `toolPrompt` and `lazurio tools prompt
<tool>` return the prompt: the task, that text, and the rule that after a successful
installation the agent enables the tool so the Folder instructions name it. The
Principal's reason for the second mode: many tools can be offered cheaply through the
agent mode, and later usage analytics of which tools operators try to install with an
agent shows where a curated flow is worth building. No such analytics exist in this
revision; F5 (opt-in, content-free measurement) governs them when they do.

**Storage.** `.lazurio/preferences.json` gains one optional top-level key, `tools`: a
sorted, unique array of enabled catalog names of the `recommended` and `optional`
tiers, validated against the catalog by the exact-key parser. It is not part of
`profile`, `machine` or the preset. The key is **absent** when nothing is enabled, so
every existing Folder keeps byte-identical preferences, and a Folder that disables its
last tool returns to that shape. A stored empty array is **refused**, not normalized:
one selection has exactly one stored representation, which is what the transaction's
byte comparisons rely on. A request (CLI, Launchpad) may name the empty selection; the
same validator requires it sorted and unique.

**Schema version: not raised.** `folderStateSchemas` stays `preferences: [2]`,
`manifest: [2]`, and the artifact identity is unchanged. The declared versions answer
one question at staging: can the new release read what the installed one wrote. It
can, because every schema-2 document without the key parses as before. A version 3
would instead have forced a rewrite of every existing Folder, which the byte-identity
requirement forbids. The transaction journal schema
(version 3) is unchanged as well: it embeds preferences, and a journal written with a
non-empty selection is validated by the binary that wrote it.

*Amended by F21 (2026-09-28): there is no program rollback; of the two paragraphs
below only the fact stands that an older executable refuses such a Folder, fail
closed.*

**Forward-migration boundary.** A Folder with a non-empty `tools` list is unreadable
by binaries older than this release: their exact-key parser refuses the unknown key,
so every Folder operation and the Launchpad start fail closed; nothing is rewritten or
dropped. This is the explicit no-automatic-rollback boundary of
[migration and recovery](migration-and-recovery.md). For `lazurio update rollback`
(program rollback is not data rollback, [update.md](update.md)) it means: a Folder
that enabled nothing rolls back freely; a Folder with enabled tools must have them
disabled with this release **before** rolling back below it, or is repaired forward by
returning to this release. The rollback does not do this by itself.

**What guards the rollback.** `lazurio update rollback` runs the self-check of the
target executable before it switches, and where the installation knows its Folder
(a supervised Launchpad service installed with `--folder`, which is every hosted
Machine) that self-check parses the Folder's state. An older binary refuses the
unknown key, the self-check fails and the rollback ends as `rollback-unavailable`
with nothing switched. The automatic rollback after an unhealthy activation returns
to the release that was running, which wrote the state and reads it. An installation
without a known Folder (a workstation that starts the Launchpad by hand) has no such
guard: there the rollback switches and the older binary then refuses the Folder until
the tools are disabled by this release or the product is updated forward again.

**Template revision `base-instructions-8`.** `AGENTS.md` gains the section "Tools"
(the required and the enabled tools with their purpose, the priority rule and the MCP
instruction). The per-Machine `manual/this-machine.md` gains "Enabled tools" (each
tool with its usage, and the MCP instruction). No generated file is added; the output
list is fixed (F14). Both locales have the same structure. A Folder rendered by
revision 7 is upgraded by its next change when every file still has its recorded
digest.

**One planner, one transaction.** A tools change is the third kind of
`FolderChangeRequest` (`{ kind: "tools", expectedRevision, tools }`) and runs
`planFolderChange`, preparation, application, archive and recovery (`profile-resume`)
exactly as a profile change and a handover refresh do. A profile change and a refresh
carry the recorded tools forward unchanged. The same selection is `unchanged` and is
not recorded. Every refusal holds: a stale revision, an edited or removed owned file
by its path, custom instructions, an unknown template revision, a foreign top-level
entry of a hosted Folder. `inspectToolsChange` is the read-only twin. An instruction
source without the key renders what the empty selection renders; every product caller
passes the recorded selection.

**Surfaces.** `lazurio tools list|enable|disable|prompt`
([environment tools](environment-tools.md)); the Launchpad server returns `tools` (the
catalog with `tier`, `setup` and `enabled`) in `/api/profile` and takes
`{ expectedRevision, tools }` at `POST /api/tools/preview` and `POST /api/tools/update`
with the status codes of `/api/preview` and `/api/update`.

**Deferred** ([F19](#f19--curated-installation-and-login-of-catalog-tools) later implements the curated installation and login of the `launchpad` tools). Installation of any tool; sign-in flows; the Launchpad UI for tools and
the hand-over of the prompt to T3 Code; the agent fallback for a failed curated
installer beyond its text; usage analytics; further catalog entries. The neon texts
state what was not verified against the vendor's documentation (the npm package name
and Node.js requirement, which the documentation and the repository README state
differently, and whether the browser sign-in completes on a headless Machine).

**Shared Team preset (Principal 2026-09-27).** Tools can be enabled on the preset with a
brokered Organization identity (`hosted-organization-team`) too. Accounts signed in to
the tools there apply to the whole Environment and are shared by all its operators and
their agents; `AGENTS.md` and `manual/this-machine.md` say so, and enabling a tool
returns the warning `shared-environment-sign-ins`.

**Addendum 2026-09-27 (Principal, after a preview of the Launchpad Tools section):
the operator's note, sign-in state and one-click changes.**

*The operator's note.* An operator who installs a tool with an intent ("use it for the
ClickUp and Gmail of Spectoda; send nothing without my instruction") writes that intent
once, and agents read it in the Lazurio Folder. It is stored in
`.lazurio/preferences.json` under a second optional top-level key, `toolNotes`: an
object from a catalog tool name to the note. Only an activatable tool that is required
or currently enabled may carry a note; the keys are sorted; the key is **absent** when
there is no note (an empty object is refused, one set of notes has one stored
representation), so every existing Folder keeps byte-identical preferences. A note is
plain text in its stored form: trimmed, line endings LF, 1 to 600 Unicode code points,
at most 6 lines, and no control character other than the line feed, no line or
paragraph separator, byte-order mark or text-direction control
(`src/tools/note.ts`; surfaces normalize typed text before they send it, the state
parser accepts only the stored form). Disabling a tool removes its note in the same
change.

*One planner, one transaction.* The `tools` change request carries the notes:
`{ kind: "tools", expectedRevision, tools, notes }`. `notes` is the full next set;
when a request omits it, the recorded notes of the tools that stay on are carried, which
is how a disable removes a note and how an older client that sends only `tools` keeps
them. A profile change and a handover refresh carry the recorded notes exactly like the
recorded tools; `validatePreparation` regenerates the transition with the staged notes,
so `profile-resume` completes an interrupted note change like any other. The same
notes are `unchanged` and not recorded. The instruction source gains `toolNotes`
(absent means none), and every caller of `instructionSource` passes the recorded notes.

*Rendering and its safety.* `manual/this-machine.md` quotes a note inside the tool's
list item, under "Note from the operator of this Environment:" / "Poznámka operátora
tohohle Environmentu:", and when any note exists the section says once that a note is
the operator's intent for agents on this Environment, followed within the Principal's
instructions, granting no access and no mandate for a Publication and changing none of
the document's rules. `AGENTS.md` does not repeat the note; the tool's line says that
the operator left one in `manual/this-machine.md`. Every note line is rendered as a
Markdown blockquote line (`> `, an empty line as `>`), `<` and `>` become `&lt;` and
`&gt;` (an `&` that already starts an entity becomes `&amp;`), and a line whose first
character after up to three spaces is `#`, a code fence (```` ``` ````, `~~~`), a
setext underline (a line of only `=` or `-`) or a backslash gets a backslash before it.
Together with the refused control characters a note can never end its block, forge a
heading, an instruction section, an HTML comment or the generated-file marker. The
quoting is injective, so two different notes always render different bytes and a
changed note is always a changed Folder. The template revision stays
`base-instructions-8`: nothing rendered by revision 8 has been released, and a Folder
without notes renders exactly what it rendered before.

*Forward-migration boundary.* `toolNotes` widens the boundary exactly as `tools` does:
a Folder with a note is unreadable by binaries older than this release (their
exact-key parser refuses the unknown key, fail closed, nothing rewritten). The schema
versions stay unchanged for the same reason as for `tools`. Before a program rollback
below this release, remove the notes (and disable the tools) with this release, or
repair forward by returning to it; the rollback guard described above holds unchanged.
*(Amended by F21: there is no program rollback; an older executable refusing such a
Folder is what stands.)*

*Surfaces.* `lazurio tools note <tool> --folder <F> --expected-revision <n> (--text
<text> | --clear)`; `tools list` shows each tool's note. `POST /api/tools/preview` and
`/api/tools/update` take the optional `notes` object; `POST /api/tools/status`
returns each tool's `note`.

*Sign-in state.* The Launchpad and `lazurio tools list --sign-in` say whether each
tool is signed in and as whom when the tool can tell. The catalog gives every
activatable tool a `signInProbe`, the command its usage text names: `gh auth status
--hostname github.com` (the login from "Logged in to github.com account <login>" or
"… as <login>"), `composio whoami` (the `email` and `current_org_name` of the JSON
line it prints; it exits 0 also when it says "You are not logged in", so it counts as
signed in only with that line and a non-empty email), `wacli auth status --json
--read-only` (`authenticated` must be `true`; the label is `phone` or `linked_jid`),
`gog auth list --check --json --no-input` (at least one account; the label is the first
account's email when the shape allows it, an unknown shape is signed in without a
label) and `neon me -o json` (`email` or `login`). A probe is signed in when it exits
0 and those rules hold; `unknown` covers a tool that is not installed, has no probe,
timed out, failed to run or printed nothing readable. Only installed tools are probed,
in parallel, each bounded by 10 s, with only `PATH`, `HOME` and the `XDG_*` base
directories in its environment. The raw output of a probe is never returned or logged;
only the extracted label is, as plain text without control or text-direction
characters, trimmed and cut to 120 characters. Because a tool may contact its provider
to verify a token, the probes are **opt-in per request**: `POST /api/tools/status`
takes an optional boolean `signIn` (default `false`), which the page sends on load and
on "Refresh status". The version commands of `tools status` still never use the
network.

*One click.* The page no longer previews a tools change: "Enable", "Disable" and a
saved note apply at the revision the page shows, and the card confirms what happened
with the new Folder revision and an "Undo" that restores the state before the change
(the shared sign-ins warning follows an enable on the Team preset). The preview API
stays for other clients. The note about a tool outside `~/.local/bin` is shown only on
a hosted preset; on a local workstation any tool on PATH is fine, and the status
response says which with `hosted`.

## F19 — Curated installation and login of catalog tools

**Principal's decision 2026-09-27 and 2026-09-28 (the F18 line), implemented in this
revision for `gh`, `composio` and `wacli` on Linux and macOS.** The tools with setup
mode `launchpad` get a curated flow that installs the tool and signs the operator in
with as little friction as possible: the operator never copies an API key, and the
sign-in works on a headless Linux VM whose operator's browser and phone are on another
device as well as on a local workstation. Maintenance of this catalog is a value of
the product: every entry has a written target state (`activation.installation`), and
when a curated installer fails the operator is offered the prepared agent prompt
(`toolPrompt`), so an agent completes the installation by that text. Tools with setup
mode `agent` (`gogcli`, `neon`) get no curated flow; nothing changes for them.

**CLI first, Launchpad second, one core.** `src/tools/install.ts` (`installTool`) and
`src/tools/login.ts` (`createLoginSessions`) are the core. `lazurio tools install`,
`tools login`, `tools logout` and `tools composio-org` are the first adapter; the
Launchpad routes `POST /api/tools/install`, `/api/tools/login/start|poll|cancel`,
`/api/tools/logout` and `/api/tools/composio/organizations|organization` are the
second. The words follow the tools' own convention (`gh auth login`, `composio login`,
`wacli auth logout`) in every machine-facing name; people read "Sign in" and "Sign out"
("Přihlásit", "Odhlásit") in the Launchpad. The earlier names `tools list --sign-in` and
the `signIn` field of the status response keep their names.

**Installation rules.** For the current user, without root, into the standard path of
F17: the binary or a link at `~/.local/bin/<command>`; a tool's own home only where
its official installer creates one (`~/.composio`). A tool that works, found on PATH
or in the standard path, is never touched (`already-installed`, nothing downloaded,
nothing written), so there is no downgrade and no second installation; a broken copy
elsewhere on PATH is not shadowed by a new one (`install-failed` at `preflight`, the
agent's prompt covers the repair); a broken standard entry (for example a dangling
link) is replaced. The version is the latest release resolved from the official
source at install time (the GitHub release API of `cli/cli` and `openclaw/wacli`,
composio's own installer); nothing is recorded as a pin. Only HTTPS, checked before a
request and after its redirects. `gh` and `wacli`: the release's published checksums
file (`gh_<version>_checksums.txt`, `checksums.txt`) gives the SHA-256 of exactly the
asset, which is verified in memory before the archive is read; every entry of the
archive is then checked, and an absolute name, a `..` segment, a backslash, a link
whose target leaves the archive, a device, FIFO or other special entry, an encrypted or
ZIP64 zip refuses the whole archive; only the one binary (`gh_<v>_<platform>/bin/gh`,
`wacli`) is taken, written into a private directory (0700) beside its destination,
made 0755 and renamed into place, and the directory is removed. `composio`: the
documented installer `https://composio.dev/install` is downloaded into a private file
first and then run with `COMPOSIO_INSTALL_PLUGINS=0`, `COMPOSIO_INSTALL_SHELL=none` and
`COMPOSIO_INSTALL_HELP=0` (no agent plugins, no shell startup files); a failed
download runs nothing. A binary that does not answer `--version` afterwards is removed
and reported. Results: `installed {version, path, onPath}`, `already-installed`,
`unsupported-platform` and `install-failed {stage, reason, detail?}`, the last two
with `fallback: "agent"`. `detail` is at most twelve plain lines of the installer's
output with every line that looks like a token, key, login link or code withheld.
Every process is bounded by a timeout that kills its process group; downloads are
bounded in size. One install per tool at a time in the Launchpad.

**Challenges and their lifetime.** A login is a session in the memory of the process
that started it (a `tools login` command or the Launchpad server), one per tool; a new
start replaces a running one. The tool's own sign-in command runs as the current user
with only `PATH`, `HOME`, `XDG_*` and `NO_COLOR`, and its output is parsed as it
arrives into a challenge: `gh auth login --hostname github.com --git-protocol ssh
--web --clipboard=false` prints a one-time code and `https://github.com/login/device`
(`device-code`; gh 2.101.0 copies the code to the clipboard by default and the flag
turns that off for this run only, and a gh older than the flag, which never copies,
is run once more without it); `composio login --no-wait --no-skill-install` prints the dashboard
link (`url`), and `composio login --poll --no-skill-install` completes it; `wacli auth
--events --idle-exit 30s [--phone <number>]` emits `qr_code` and `pair_code` events on
stderr (`qr` with a sequence that replaces the previous code, `pair-code`). Only an
https URL on exactly the expected host (`github.com/login/device`,
`dashboard.composio.dev`) becomes a challenge; anything else ends the session as
`failed`. Signed in is what the tool's existing sign-in probe confirms. A challenge is
sensitive while it is valid: it is returned only to the holder of the session's random
handle (the stdout of the running command, an authenticated Launchpad request naming
the handle) and never written to a log, a file, the Folder, the transaction archive or
an error; errors are fixed codes. The tools' own stores keep their own pending state
(composio's pending login in `~/.composio`), which is the tool's custody. Sessions end
on completion, cancel, expiry (gh 15 minutes, the device code's validity; composio 10
minutes; WhatsApp pairing 5 minutes) and the owner's shutdown, each killing the tool's
process group. After WhatsApp pairing the same process runs its first sync; it is left
to its own idle exit, bounded by 30 minutes, and the CLI waits for it. `tools logout`
runs the tool's own command and says what it means: gh and composio forget the
sign-in on this Machine only (the provider still lists it until it is revoked there);
wacli unlinks the device. The Composio organization is chosen after the sign-in with
the tool's `orgs list` and `orgs switch --org-id` (the tool's `--org` at login needs a
user API key, which the operator never handles).

**The QR code.** A readable QR code drawn by the Launchpad is an explicit added value:
the operator must not fight a broken code drawn in a terminal. The server draws the
wacli payload as SVG (white background, the four-module quiet zone, one black path,
crisp edges, nothing of the tool's output but the modules), and the page shows it as an
image of at least 260 CSS px only in exactly that form. The CLI draws Unicode half
blocks on an explicit white background (ANSI 30;107), so a dark terminal theme does
not invert the code. The encoder is the one added dependency, **`uqr` 0.1.3**, pinned
exactly: MIT, no dependencies, 79 kB, maintained under `unjs`, a port of Project
Nayuki's reference-quality QR generator, bundled by `bun build --compile`. Writing a
correct encoder (Reed–Solomon, the version table, masks and their penalties) was not a
reasonable part of this slice. It is tested against module matrices of two independent
encoders for fixed payloads, versions, levels and masks.

| Alternative | Trade-off / disposition |
| --- | --- |
| Show the tool's own terminal QR in the page | Unreadable in a browser, depends on the tool's drawing; rejected |
| Own encoder | No dependency; several hundred lines of error-correction code to own and review; rejected for this slice |
| `qrcode-generator` | Well known, MIT, no dependencies; 555 kB, older API; not selected |
| `uqr` | Small, typed, no dependencies, Nayuki-derived; selected |

**Launchpad.** The card of a `launchpad` tool shows "Install and sign in" (missing),
"Sign in" (installed, not known to be signed in) or "Sign out" (signed in). The first
two open a dialog with plain steps (installing, waiting for you, signed in) and an
`aria-live` status; on a shared Environment the shared sign-ins warning comes before
anything starts. gh shows the code in large selectable characters and a link to the
device page in a new tab, with the sentence that the code is entered on any device;
composio a link in a new tab and, after the sign-in, a select of the organizations
with the current one marked and the hint that the Environment's connections belong to
that account and organization; wacli the QR code with its text alternative, the path in
WhatsApp in words and the alternative of a pairing code for a phone number. The page
polls every 2 seconds while the dialog is open; closing it cancels the login. A failure
shows its reason and "Finish with an agent", which opens the prepared prompt.

**Deferred.** Windows (the flows are refused as `unsupported-platform` there), further
tools, automatic updates of curated tools, the hand-over of the prompt into a T3 Code
chat, and usage analytics. The real vendor flows are qualified on a test VM, not by this
revision's tests, which use fake tools and a fake source only.

**Addendum 2026-09-28 (Principal): the gh sign-in links the Machine's SSH key.**
Recorded from the Principal's words: the sign-in to gh through the Launchpad must link
the SSH key as well, which is why it exists; the SSH key matters most, and gh over
https is of no use here. Also decided, with no change needed: a broken tool outside the
standard path is always left to an agent following the manual, and on a shared
Environment a new sign-in replacing a running one is fine.

*Target state.* `lazurio tools login gh` and the Launchpad's "Sign in" end with a
Machine that can `git clone git@github.com:…` as the signed-in account. The device flow
is `gh auth login --hostname github.com --git-protocol ssh --web --scopes
admin:public_key --clipboard=false`: one code for the operator, and the token may list,
add and delete the account's SSH keys. gh itself offers to upload a key only when it
can prompt (`opts.Interactive && gitProtocol == "ssh"` in
`pkg/cmd/auth/shared/login_flow.go`, where it also adds `admin:public_key`); without a
terminal it prints the code and the page and uploads nothing, so Lazurio does steps 2
to 5 after gh confirmed the sign-in, in the same session, as a step of its own
(`pending` with `step: "ssh-key"`):

1. *The key pair.* This Machine's key is the first default name whose private key
   exists, in the order `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` (ed25519 first
   because it is what Lazurio creates; `_sk` keys need a touch, DSA is not accepted by
   GitHub). It is used as it is and never overwritten or changed: `ssh-keygen -y -P ""
   -f <key>` must derive exactly the public key of its `.pub` file, which proves the
   pair belongs together and has no passphrase. Without a default key Lazurio creates
   `ssh-keygen -q -t ed25519 -N "" -C lazurio@<Machine> -f ~/.ssh/id_ed25519`
   (`~/.ssh` created 0700, the private key 0600). A key with a passphrase, without its
   `.pub` or unreadable is reported (`key-passphrase`, `key-incomplete`,
   `key-unreadable`) and left alone; Lazurio never adds a second default key beside an
   existing one, because OpenSSH offers the defaults in its own order (rsa, ecdsa,
   ed25519 in `readconf.c`) and which account answers would then depend on it.
2. *Registration.* `gh ssh-key add ~/.ssh/<key>.pub --title "Lazurio: <Machine>"
   --type authentication`. gh lists the account's keys first and adds nothing when
   the key is there ("Public key already exists on your account", exit 0:
   `already-registered`). GitHub refuses a key that is in use elsewhere, on another
   account or as a repository's deploy key ("key is already in use", HTTP 422): the
   result is `key-in-use`, and no second key is generated. The Machine's name is the
   system host name reduced to letters, digits, `.`, `-` and `_` (no secret; on a
   workstation it may carry the owner's name, and it goes only to the owner's own
   account).
3. *Host keys.* GitHub's published host keys come over HTTPS from `gh api meta --jq
   .ssh_keys` (the `ssh_keys` of `https://api.github.com/meta`). `ssh-keygen -F
   github.com -f ~/.ssh/known_hosts` finds existing entries, hashed ones included. Only
   missing keys are appended as plain `github.com <key>` lines; an entry whose key is
   not published, or one with a marker (`@revoked`, `@cert-authority`), stops the link
   as `host-key-mismatch` and nothing is changed. A changed host key is never replaced
   or accepted; GitHub's own guidance for its 2023 RSA key rotation is the agent's
   manual for that case.
4. *Proof.* `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15
   git@github.com` must print "Hi <login>! You've successfully authenticated…" (it
   exits 1 by design) for the signed-in login. Another login is `proof-other-account`
   with `provedAs`; anything else `proof-failed`. The proof runs with the minimal
   environment of every login process (no `SSH_AUTH_SOCK`), so it shows what the
   default key and `~/.ssh/config` give an agent without an ssh agent.

Only then does the result say linked: `signed-in` carries `ssh: { state: "linked",
key: { path, fingerprint, created }, registration, knownHosts }`; otherwise `ssh: {
state: "not-linked", reason, key?, provedAs?, fallback: "agent" }` — signed in to gh,
SSH not linked, the reason and the agent as the next step, never a plain "signed in".
`lazurio tools login gh` exits 0 only when linked. Every step runs as a process of the
session in its own process group, bounded by 30 s; a cancel, an expiry (5 minutes from
the start of linking) or a shutdown kills it.

*Link SSH key.* For a gh that is signed in already, `lazurio tools login gh --ssh-key`
and `POST /api/tools/login/start {tool: "gh", sshKey: true}` run the same steps. When
the token lacks `admin:public_key` (a gh signed in by hand without the SSH prompt),
they first run `gh auth refresh --hostname github.com --scopes admin:public_key
--clipboard=false` through the same kind of device-code session; without a terminal
gh requires `--hostname`, keeps the scopes the token had, prints the code and the page
exactly as the login does and fails when the browser signs in another account
(`pkg/cmd/auth/refresh/refresh.go`). A gh that is not signed in ends as
`not-signed-in`.

*Status.* The gh sign-in probe (run only when the sign-in is asked for, as before)
adds `ssh`: `linked` when the `.pub` of this Machine's key is among the account's keys
(`gh api "user/keys?per_page=100"`, with the token scopes read from the probe's own
`gh auth status` output), `not-linked` with `no-key` or `not-registered`, `unknown`
with `scope-missing` or `unreadable`, and the public fingerprint. The private key is
not read and nothing connects over SSH on a status call: the host keys and the proof
are checked by the sign-in and "Link SSH key". The card shows "Signed in as X · SSH key
linked", "… · SSH key not linked" or "… · SSH key not verified", and the last two offer
"Link SSH key".

*Sign-out.* Before `gh auth logout`, the key of this Machine is removed from the
account (`gh ssh-key delete <id> --yes`) when the token has `admin:public_key` and the
registered key's title starts with `Lazurio: `. The rule needs no state file: a key is
Lazurio's when its public key is this Machine's and Lazurio's title marker is on it. A
key the operator registered by hand before Lazurio (any other title) stays
(`kept-not-lazurio`), because it may serve other Machines of the operator that share
it, and the result says how to remove it (GitHub Settings, SSH and GPG keys). Without
the scope or when gh fails, the result is `not-removed` with the reason and the same
advice. The local key files always stay. The result is `sshKey: { state: "removed" |
"not-registered" | "no-key" | "kept-not-lazurio" | "not-removed", reason?, fingerprint?
}` on `logged-out`.

*Nothing secret leaves.* No route, log or output carries private key content or even
the public key's blob: only the key's path and its SHA-256 fingerprint. One-time codes
go only to the holder of the session, as before.

*Trade-offs.* (a) The created key has no passphrase, so agents can use it unattended;
anyone who can read the operator's home can use it, which is the same boundary as gh's
own token on the Machine, and sign-out removes it from the account. An operator who
wants a passphrase keeps their own key, and Lazurio then reports `key-passphrase`
instead of using it. (b) The token carries `admin:public_key` beyond gh's minimum
(`repo`, `read:org`, `gist`): it can add and delete the account's SSH keys, which is
what lets sign-out end the Machine's access. (c) `known_hosts` trusts the keys GitHub
publishes over HTTPS through gh, not a first SSH connection.

*Not verified against the real service in this revision.* The flows run against fake
`gh` and `ssh` (the real `ssh-keygen` runs on a temporary home): the exact text of the
greeting and of gh's messages ("already exists", "key is already in use") comes from
gh's source and GitHub's documentation; a real device flow with `--scopes`, a real
`auth refresh` without a terminal and real SSH authentication are qualified on a test
VM. `ssh` resolves `~` from the account's passwd entry, not from `HOME`; the Launchpad
and the CLI are expected to run with the account's own home.

*Agent fallback.* The catalog's `installation` text of gh (the body of `lazurio tools
prompt gh`, not rendered into the Folder) states this target state for an agent. The
`usage` text rendered into the Folder instructions is unchanged in this revision.

**Addendum 2026-09-28 (Principal): gh on a Team Environment.** There are three kinds
of Environment: Personal, Work (one operator) and Work Team (shared by several
operators). "A Team VM is to work out of the box with the signed-in bot of the
organization. So there is no need to sign in gh." A Team Environment
(`hosted-organization-team`, the preset whose provider identity is the brokered
Organization identity) works in GitHub through the GitHub App "Lazurio for GitHub"
installed under the Organization; a person's account is not signed in there and a
person's SSH key is not linked. The earlier temporary exception that let any account
sign in on a Team VM ends. composio and wacli stay as they are:
signed in for the whole Environment, with the shared sign-ins warning.

*One rule in one place.* `githubActionRefused` in `src/tools/team-github.ts`, pure and
dependency-free so that the Launchpad page decides with it too: on a brokered preset
the curated `login` and `ssh-key` of gh are refused; `logout` of gh is allowed exactly
when gh's active account is a person's, because removing a personal account left on a
shared Machine is what the rule wants (its sign-out also removes the SSH key Lazurio
registered, as everywhere else). Every other tool and every other preset is untouched.
`githubRefusal` in `src/tools/github-gate.ts` applies it for the CLI and the server;
only a sign-out reads gh's sign-in first. The refusal is the ordinary refusal of these
surfaces: `{ kind: "blocked", reason: "team-environment", tool: "gh", action }`, exit 2
in the CLI and `409` from `/api/tools/login/start` (with or without `sshKey`),
`/api/tools/login/poll` (which also cancels the session) and `/api/tools/logout`;
`cancel` is always allowed. The wording is one: the Launchpad's sentence ("This Team
Environment works in GitHub through Lazurio for GitHub, set up by the Organization.
Personal GitHub accounts are not signed in here.") now lives in `team-github.ts` in
both languages, and a refused sign-out adds that only a personal account left there is
signed out and the Organization's identity is not. The status line of gh (Launchpad
and `tools list --sign-in`) says "uses Lazurio for GitHub" there instead of the state
of a person's SSH key.

*How the kind of Environment is known.* The Launchpad serves one Folder and reads its
recorded preset on every such request. `tools login` and `tools logout` take no
Folder, and adding `--folder` to them would let a caller name any Folder; instead, on a
hosted Machine they read the preset of the declared operator's Folder, which the
product already finds from the root-issued handover and the effective account for
`lazurio update` (`hostedOperatorFolder`, F17 addendum). The handover alone is not
used: an ambiguous handover derives no preset and the operator may record another
allowed one, so the Folder is the owner of the answer. Only where there positively is
no such Folder (not Linux, no handover, a valid handover whose operator is another
account) do the commands behave as before. *Addendum (#83):* a hosted context that is
there but cannot be read is not a workstation. `discoverHostedOperator` tells the three
kinds apart (`absent`, `hosted`, `unreadable`: an unreadable, unsafe, malformed or
off-schema handover, or an operator record that cannot be resolved), and
`hostedEnvironmentPreset` rejects with `HostedEnvironmentUnreadable` also when the
declared Folder, its state or its preferences are missing or malformed. gh's curated
login, key linking and sign-out then stop before gh runs as `failed` /
`environment-unreadable` (exit 1), the reason a running session already ended with;
a session re-reads it before every step below, and a hosted Folder found earlier in the
same command that is no longer found counts as unreadable. The refusal never signs out
or removes a credential. Commands that only look up a Folder (`update`,
`organization`, `module`, `chat link`, `recover`) take none from an unreadable context
and so act on none; `doctor` names it as `machine-binding` `warn`
`handover-unreadable`.

*A person's account or the Organization's identity.* gh's sign-in probe asks
`gh auth status --json hosts` first. gh has that flag since **2.81.0** (cli/cli#11544,
"Add JSON output to `gh auth status`", merged 2025-09-25); it is also exactly the one
`gh auth` command the Organization's brokered gh answers (the upstream GitHub App
adapter's wrapper refuses every other `gh auth` command and replies with the App's
`lazurio-for-github[bot]` login). The probe asks for the one field `hosts` and never
passes `--show-token`, so gh leaves the token out (`token` is `omitempty` and blanked
without that flag); only the active github.com entry's `state`, `login`, `tokenSource`
and `scopes` are read, and with `--json` gh always exits 0, so `state` (`success`,
`error`, `timeout`) decides. A gh older than 2.81.0 does not print that document
("unknown flag: --json"); the probe then reads the text form `gh auth status --hostname
github.com` as before. The same reading serves the Launchpad and `tools list
--sign-in`, the confirmation of a login, the scope check before linking a key and the
removal of the key at sign-out (`src/tools/gh-status.ts`). Both forms report
`identity`: `app` when the login ends in `[bot]` (a GitHub login is letters, digits and
hyphens, so the suffix can only be an App's) or, in the text form, the entry's masked
token is an installation token `ghs_…`; `variable` when the token comes from an
environment variable (`GH_TOKEN`, `GITHUB_TOKEN`, …), which `gh auth logout` refuses to
remove anyway; `person` when the token is one gh stores itself (`keyring`, the hosts
file, older gh's `oauth_token`); otherwise `unknown`. Only `person` is signed out;
everything else, a failed or timed-out probe included, fails closed. The account label
keeps the `[bot]` suffix, and on a Team Environment the App identity reads "works as
lazurio-for-github[bot]" / "pracuje jako lazurio-for-github[bot]" instead of "signed in
as", next to "uses Lazurio for GitHub" / "používá Lazurio for GitHub". A machine user (a
GitHub user account used by automation) whose token gh stores counts as `person`, which
the rule accepts, because only the App identity belongs on a Team Environment. The
wrapper's behaviour was read from its source and reproduced by a fake gh; the real
wrapper is qualified on a Team Machine.

*A session that outlives the preset.* A gh session is re-checked, not only started
under the rule: the login core asks the rule again (`LoginEnvironment.refused`) before
every step that changes the account or the Machine — when the device flow has ended
and before the login is completed, before a scope refresh of "Link SSH key" and after
it, before the SSH key linking starts, before the key is created, before it is
registered, before `known_hosts` is written, and before the final "signed in". When
the preset is now Team the session ends as `{ kind: "blocked", reason:
"team-environment", tool: "gh", action: "login" | "ssh-key" }` and nothing after that
step happens; the CLI exits 2 with the Team sentence. The Launchpad reads its Folder's
preset for that; the CLI reads the hosted operator Folder's preset again. A preset that
cannot be read ends a Launchpad session as `failed` / `environment-unreadable` (fail
closed). These preset reads, the status read and `/api/profile` run beside each other
in one Launchpad process, and the Folder operation lock is exclusive and
non-blocking: a read now waits for another holder for up to 3 s
(`withFolderReadLock`, retrying only on `FolderOperationBusyError`) instead of
failing as busy, which had failed a poll with `operation-failed` or a session with
`environment-unreadable` whenever two reads met; mutations keep the immediate refusal.
The Launchpad also ends a running gh session at once, as refused, when a
profile update (`/api/update`) makes its Folder a Team Environment, and a `poll` of gh
on a Team Environment ends the session and answers the refusal. Limit: gh stores a
sign-in itself when the code is approved in the browser; a preset switched by another
process (a CLI `profile-update`) while the operator approves is seen only after that,
so the session stops before any key step but the account is then signed in there, a
person's account left on a Team Environment that the Tools section offers to sign
out.

*Installing and the agent prompt.* Installing gh is not a sign-in and stays allowed.
`tools install gh` on a Team Environment (the preset read as for `login`) ends with the
Team sentence instead of "Next: lazurio tools login gh"; the Launchpad's Team gh row
offers "Install" / "Nainstalovat" only while gh is missing, never "Install and sign
in", and its notice ends with the same sentence. gh's catalog entry gains a Team target
state (`activation.team`): a working `gh` on PATH, normally the Organization's brokered
one, which stays as it is; installed from the official source only when none works; and
"Do not sign in gh or link a key: the Environment works in GitHub through Lazurio for
GitHub, set up by the Organization." `lazurio tools prompt gh` reads the hosted
operator Folder's preset and prints that Team prompt there instead of the sign-in
steps; the Launchpad of a Team Folder hands the same prompt, so the gh row's "Set up
with an agent" fallback is shown again. Where the kind is not known, gh's prompt keeps
the sign-in steps and adds "On a Team Environment (hosted-organization-team) do not
sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub,
set up by the Organization." The generated Folder texts already say that a Team
Environment uses the brokered Organization identity and holds no personal sign-ins, so
the template revision is unchanged.

*Known limits, kept.* A personal account stored behind an active broker token is not
the active account, is not offered for sign-out and has to be removed by hand (`gh auth
logout --user <login>` with the broker variable cleared); a personal token left in
`~/.config/gh` of a Machine whose gh is the wrapper is out of the wrapper's reach and
of this sign-out. (The earlier limit, that the CLI took an unreadable hosted operator
Folder for a workstation, ended with #83.)

*Not built.* The path through Lazurio for GitHub is not part of the Platform: nothing
here provisions the App, its token broker or a brokered `gh`. The product refuses the
personal sign-in and relies on what the Machine delivers.

**Addendum 2026-09-29 (#98): a sign-in that shows nothing ends with a reason, and the
journal names it.** A sign-in that shows no challenge within one minute is killed and
ends as `failed` with the fixed code `no-challenge`, instead of waiting out its
lifetime; the linking of gh's SSH key, which has bounded steps of its own, is not
affected. The Launchpad writes the start and the end of each sign-in to its journal:
the tool, the outcome and the fixed reason code, never output, a challenge or an
account. The dialog never waits for an answer of the Launchpad for longer than 45
seconds, never shows the same sentence as its status and its detail, and every end of
a sign-in that did not start, ended early or showed nothing says what to do next.
A wacli that reports `connected` without a challenge was paired before this session:
confirmed by its probe, the session ends as `signed-in` with `already: true` and the
dialog says "already signed in"; this is a sign-in that changed nothing, not a new
pairing. Only the probe confirms it: unconfirmed 20 s after `connected` (and always
within the minute above) with no challenge shown, the process is killed and the
session ends as `not-confirmed`. A session that has shown a challenge keeps its
pairing lifetime. The wacli probe reads `wacli auth status --json`'s own envelope
(`data.authenticated`, `data.phone`, `data.linked_jid`); it read the top level before
and reported a paired wacli as not signed in.

## F20 — One-command first installation; the downloaded executable verifies its own release

**Principal's decision 2026-09-28, implemented in this revision for Linux and macOS.**
Recorded from the Principal's words: "with one command I am able to install the
lazurio platform (CLI and Launchpad) on a customer's new laptop". The first
installation is one command, an install script served from `https://lazurio.ai/install`
(`curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install | sh`); it installs the Platform, the CLI and
the Launchpad as one program, and afterwards Lazurio takes over with `lazurio update`.
Platforms in order: Linux, then macOS; Windows later. npm is not the primary door. The
same day: **Lazurio is installed exactly the standard way on every Environment**;
deviations are reported and straightened by an agent following the manual, never
silently overwritten and never kept as a supported variant.

**What was weak.** `install.sh` verified the release attestation only when `gh` was
present and otherwise said it had not; a customer's new laptop has no `gh`.

**Decided.** (1) `install.sh` needs only `curl` and `sha256sum` or `shasum`, and
holds every download and every redirect to HTTPS (`--proto '=https' --proto-redir
'=https'`); there is no `wget` fallback, because wget cannot be held to that portably
([product update](update.md#first-installation)). It
downloads the executable, the manifest and the Sigstore bundle of one release into a
private temporary directory, holds the executable against the manifest's SHA-256
before anything runs, keeps `gh attestation verify` as an independent second check
when a signed-in `gh` is present, and runs `<executable> install --verify-release
<directory>`. (2) That executable verifies its own release with the product's verifier
— `verifyReleaseDocuments`, the function `lazurio update` runs on a fetched release —
before the first write, and refuses otherwise, leaving nothing behind. (3) The staged
way in of the Machines role (`install --base` from a digest-pinned file, no network)
is unchanged and does not use the new check; the two ways in are explicit in code and
in [product update](update.md#first-installation). (4) `lazurio install prompt`
prints the prepared prompt an agent follows to straighten a non-standard installation
(standard layout, deviations found, what the agent may do, what only on the operator's
instruction, how success is proven); `lazurio install` points to it whenever it finds
a deviation. (5) `release.yml` attaches `install.sh` of the tag to every release and
makes it an attested subject, so that `releases/latest/download/install.sh` is what the
website serves, by redirect (recommended) or as a byte-identical proxy; the contract
is in [product update](update.md#serving-httpslazurioaiinstall).

**What the executable's own check proves, honestly.** It is not authentication of
the publisher: a malicious executable can skip it. It protects against a swapped
download only to the extent that the script and the executable come from different
places or the script pins what it expects, and behind a redirect both come from the
same GitHub release. It makes an honest executable refuse a release that is not what
`release.yml` published at that tag, and it puts the first installation on the same
verification path as every update. The real chain is HTTPS to `lazurio.ai` for the
route, HTTPS to GitHub for the script and the release files, the manifest digest
checked by the script before execution, then the attestation checked by the
executable, and independently by `gh` where a signed-in one exists. The first
installation stays trust on first use; every later update is authenticated by the
installed product.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep "HTTPS only, and say so" without `gh` | Honest, but the customer's laptop never gets the attestation checked by anything; rejected |
| Require `gh` (install it first) | An independent verifier, but a second tool, a sign-in and a GitHub account before Lazurio; rejected as the door, kept as the optional second check |
| Verify Sigstore in POSIX shell | No maintained verifier exists in `sh`; our own cryptography; rejected |
| The executable verifies its own release (selected) | Same verifier and path as every update, no extra tool; not authentication of the publisher, stated as such |
| The website pins the expected manifest digest in the script it serves | Script and release from independent places, so a swapped release is refused before execution; needs a website deploy step per release; left open for the website, not built here |
| npm as the door | Needs Node and npm on a new laptop and a second distribution channel; rejected by the Principal |
| `wget` as a fallback when curl is missing | Covers Linux desktops that ship only wget; but GNU wget 1.x cannot restrict the scheme of a redirect, and following redirects by hand would have to be right for GNU wget, wget2 and BusyBox wget alike, while a plaintext hop could supply a forged manifest and a matching executable that run before any attestation check; rejected (review of pull request 62), the script names how to install curl instead |

**Not in this decision:** Windows; the website route itself (another repository);
OS publisher signing, which stays a gate before public release (F13).

## F21 — Recovery mode instead of rollback

**Principal's decision 2026-09-28, accepted.** The authority is root decision 0166
(HumanAndMachines/Lazurio#442); this entry records how it binds the Platform. The
analysis and design are [recovery mode](recovery-mode.md), whose questions Q1–Q6 the
Principal decided the same day (Q4 by delegation). Recorded from the Principal's words:
rollback must not be the safety net; when something breaks, the Environment starts an
agent that repairs forward, or delivers every material for a fix to GitHub, and the
pressure lands on tests and CI/CD so that releases become stable. "No back doors for
rollback!"

1. **No program rollback** (0166 point 1; Q1). `lazurio update rollback`, `--auto`,
   `lazurio-rollback.service`, `OnFailure=`, the retained `previous` version,
   `pending.json` and the switch-back after an unhealthy restart are removed; the
   switch-back is rollback, because the new version had already run (Q1). What stays
   is not rollback: an operation fails atomically, nothing changes before a candidate
   has proven itself (verification, self-check and a read-only Launchpad start on a
   private socket), and the floor with its high-water mark refuses a downgrade. The
   switch is the commit; after it the only direction is forward.
2. **Recovery mode** (0166 point 2; Q3). When the Launchpad cannot serve its normal
   page for a reason it can name, it keeps running and serves one page with one
   action: a repair agent with a prepared assignment and the sanitized evidence.
   `lazurio recover` is the same use case on the CLI. The Launchpad unit restarts
   always and never ends `failed`. On a workstation, copying the prompt into the
   operator's agent application is enough for now (Q3), revisited when T3 Code can
   start a thread from outside. When the executable cannot run at all, the hosted
   gateway serves a static page that sends the operator to T3 Code (Machines).
3. **Every entry into Recovery mode ends on GitHub** (0166 point 2; Q2), also after
   a local repair, "otherwise the repair never becomes a test". Each such issue closes
   only with a regression test under `tests/recovery/<fingerprint>/`.
4. **Where the issue goes** (0166 point 8; Q4, delegated by the Principal and decided
   by the Task Agent). The automatic issue goes to this public repository and carries
   only structured fields after a deterministic sanitizing gate (version, target,
   platform, failed check identifiers, unit state, Folder and template revision). The
   journal tail and any free text stay in the local recovery bundle and reach the
   issue only when the repair agent attaches them after reading them under the same
   gate. The operator does not confirm and sees the exact body that left. No intake
   service; a private intake is reconsidered only if structured issues prove
   insufficient for fixes.
5. **Quality instead** (0166 points 3, 5 and 6; Q5). A final release requires the
   journeys J1–J6 on disposable Ubuntu and macOS runners against the real release
   candidate ([gates](recovery-mode.md#g-what-forces-quality-instead)), and a canary
   stage of **8 hours on the work VMs of the pilot Organization and on the personal
   VMs of its operators**, with its evidence. Releases go out in stages: qualification
   VM, pilot Organization, then further Organizations step by step. A shorter canary
   or a narrower set of Machines for a named release exists only as the Principal's
   decision recorded in the register, never as a line in an evidence pull request.
   Linux means Ubuntu in the first phase; the rebuild of the hosted personal VMs on
   Ubuntu 24.04 (F22 point 5) comes before the first canary stage, and no final
   release passes with a personal VM missing from it.
6. **Machines too** (0166 point 4; Q6). An apply completes or does not start and never
   returns to an earlier release as a way of repair. What stays, because it is not
   rollback: the atomic, pre-validated gateway configuration, forward completion of an
   interrupted apply and the provider's rescue access as the emergency way in. What
   goes: the restore of the previous resident tree and of the previous T3 Code release
   tree. A failed apply returns full evidence to the agent running the rollout, which
   repairs forward with a new Plan or files an issue. Its application in Machines is a
   separate Machines decision.
7. **Accepted consequence** (0166 point 7). A release that passes every gate and
   still fails on one Machine leaves that Machine's Launchpad in Recovery mode until a
   fixed release; T3 Code, the operator's tools, the Folder and the repositories are
   unaffected. The update to the first release without rollback is performed by the
   old updater, which may switch back once; that last switch-back is accepted.

Q7 (whether `update status` keeps a `previous` field) was not put to the Principal; it
was implemented as recommended: the field is dropped.

**Amends** F4 (rollback retention; "program rollback and data recovery are
separate"), F13 (no retained previous version), F17 and its 2026-09-28 addendum point
3 (`lazurio update rollback` is withdrawn), F18 (its rollback paragraphs) and the
[product update](update.md) contract; each amended place carries a pointer here. In
the root register, 0166 replaces 0161's mention of the Platform's own rollback; 0164
and 0166 are one rule, forward repair.

**Open.** The separate Machines decision and the Machines texts that still describe
rollback ([recovery mode](recovery-mode.md) G.4, H); the staged rings (G.5); a passing
qualification; the start of a T3 Code thread from outside (Q3); repair of a damaged
active executable at the same version; deletion of the remove-rollback migration once
`minimum_updater_version` reaches the first release without rollback.

**State on the evening of 2026-09-28.** Merged in this repository: the shaping (#64);
`lazurio recover` with its checks, tier-1 evidence, refusing sanitizer and repair
prompt (#69) and its probe fix (#78, issue #74); activation without undo, the
always-restarting unit, minimal Recovery mode and the remove-rollback migration (#67,
`base-instructions-10`); the Recovery page (#72); `qualify.yml` with J1–J6 and the
canary record a final tag requires (#75). Released only as the pre-releases
`v0.1.8-rc.1` and `v0.1.8-rc.2`; the latest release `v0.1.7` still contains rollback.
The first real qualification run, on `v0.1.8-rc.2`, failed: J3 on `ubuntu-24.04` (the
previous release's Launchpad did not come up within 60 s), the other eleven journey
runs passed; no candidate is qualified and no canary has started. Not done: the
Machines part (its decision, the gateway's static page, the role texts) and the
rebuild of the personal VMs that precedes the first canary.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep rollback as a safety net | Fast relief on one Machine; hides faults and keeps a second code path alive; rejected by the Principal |
| Keep only the automatic switch-back after an unhealthy restart | Smaller, but the new version was observable and may have written state; it is rollback by the rule above; rejected (Q1) |
| Recovery page from a separate program | Survives a broken executable; a second runtime and supervisor to build and qualify; rejected in favour of the gateway's static page |
| Recovery mode in the Launchpad plus `lazurio recover` | One core, no new process, reaches the operator where they already are; selected |
| A private intake from which maintainers write the public issue | Two gates and a reader before the public; an endpoint, a private repository and an agent pass to run; kept as the fallback if structured issues prove insufficient (Q4) |

## F22 — The Platform Launchpad reaches parity and replaces the resident in one apply

**Principal's decision 2026-09-28, accepted.** The authority is root decision 0167 with
its addendum of the same day (HumanAndMachines/Lazurio#442, #443); the Team
Environment part follows root decision 0168. The analysis is
[Launchpad parity](launchpad-parity.md), whose questions H1, H4 and H6, H3 in
direction and the drops of its section F the Principal decided. Recorded from the
Principal's words: "Let us give maximum priority to finishing the Platform Launchpad,
so that we do not have to deal with this parallel run at all", and "take the concepts
of the old Launchpad and do them properly in the new Launchpad".

1. **Canonical-only Organizations are executable** (0167 point 5; H1). F12's
   transition-only admission ends (F12 addendum): `transition` and `current` roots
   run applications.
2. **Concepts, CLI first, no new Folder state** (0167 point 1). Organizations and
   modules are read from the Folder's `organizations/`; module operations are CLI
   first (`lazurio module …`, `lazurio organization …`), run without a Launchpad, use
   the operator's Bun from `~/.local/bin` and log to the journal; the Launchpad
   composes the same core. On Linux modules are systemd user units that survive a
   Launchpad restart, on macOS they stay session-bound (0167 amends root 0137);
   modules run from `main` (0167 amends root 0049).
3. **The handover carries `entry`** (the Launchpad, T3 Code and the module origin
   template), written only by Machines; the gateway keeps the browser's `Host` and
   sends the Launchpad's `Host` on `ensure`. The entry is declaration, not identity:
   the Platform records it whenever the handover carries it, and writing it is not
   switching ([machine handover](machine-handover.md#the-hosted-entry-decision-f16)).
4. **One apply, no side-by-side period** (0167 point 2). A hosted Machine switches in
   one Machines apply that removes the resident unit after read-only checks. There is
   no period with both Launchpads, no transition hostname and no way back to the
   resident; Recovery mode (F21) is released first, and Machines itself does not roll
   back (F21 point 6). The order of the apply is the shaping's proposal (H2 below).
5. **Ubuntu 24.04 on every hosted Machine** (0167 point 3 and its addendum). The first
   usable version targets hosted Remote Environments on Linux, which means Ubuntu in
   the first phase; other distributions are "unverified". Hosted personal VMs move
   from Debian 13 to Ubuntu 24.04 at the next Machines rollout, as a **rebuild with
   state transfer that is seamless for the Owner**: about an hour of outage is
   acceptable, but the Owner sets up no SSH key, sign-in or Buddy again. The Machine's
   identity, its tailnet node, its SSH host keys and the operator's home with the
   Buddy's state are restored, each proven by a readback. The Buddy's secrets are
   carried byte for byte without rotation; the pool host keeps the old disk for 14
   days, and booting it in that window is only a manual last-resort step of the
   operator, not a product mechanism and not a way back in the sense of F21. The
   Principal's own personal VM is rebuilt first, the second at any time, the third in
   a window agreed with its Owner. The rebuild stays separate from the switch and
   precedes the first canary stage (F21 point 5). macOS and Windows follow, Windows
   once a Platform build for Windows exists.
6. **Deliberately not carried over** (0167 point 4; section F). The browser Git client
   (a worktree from a plan, publishing a draft by commit and push), the Mission Control
   plan browser, notifications, "most used" and recent changes, and the other drops
   of [section F](launchpad-parity.md#f-what-we-deliberately-do-not-carry-over) have
   no successor. Git is done by agents in T3 Code under the manual's worktree
   discipline, and click-derived state has no decision behind it.
7. **Pull-request previews** (0167 addendum; H3 in direction). Worktree source (P9) is
   off the switch line. A preview from the web T3 Code on a hosted Machine gets a
   temporary Environment URL that the agent registers like a module's hostname, as a
   lease that ends by itself and never accumulates (the Principal's examples: cleanup
   after 24 hours and when the port disappears). The hosted Folder manual tells agents
   how previews work so that they never send the operator a localhost link; until an
   application has a hosted name, the handoff says so instead of a link. On a
   workstation, worktree source is a later slice.
8. **New Work Machines** (0167 point 6; H4): until content synchronization (P10), the
   agent in T3 Code clones their Organizations from the manual.
9. **Team Environments** (0167 point 7, 0168; H6). Commits, pull requests and issues
   from a Team Environment carry `Lazurio-Environment: <machine>.<org>` beside root
   decision 0148's `Lazurio-Workspace`, a direction for the broker and Machines that is
   not built. A Team Environment works in GitHub through the Organization's bot right
   after handover; the Platform refuses a personal `gh` sign-in and SSH key there and
   allows the sign-out of a personal account left behind (F19 addendum).
10. The new Launchpad shell that another Kolega's plan builds in the resident is a
    proof of concept and an input to the Platform Launchpad (0167 point 8).

**Open.** H2: the point of no return after read-only preflights inside the one apply
([C.2](launchpad-parity.md#c2-the-apply-in-order)); recommended, and the Machines
switch draft follows it. H5: `launchpad.gen3.json` and `launchpad.gen3.local.json`
with its planned slots and Personalspace owner have no successor, amending F15 point
2; 0167 point 9 records it as a proposal the Principal neither confirmed nor
questioned. H7: the command names `lazurio module …` and `lazurio organization …` are
kept from the resident; recommended and implemented. The rules of the preview lease
(time to live, renewal, end conditions, the cap per Machine;
[B14](launchpad-parity.md#b14-worktree-previews-under-a-temporary-hostname-p9-proposal))
are a proposal, not a decision. Implementation proceeds on the recommendations; H5
and H7 can still change before the first final release that contains P4 and P5,
without migrating anything.

**Amends** F12 (its admission; see the F12 addendum), F15 (point 2, subject to H5, and
the 2026-09-28 addendum's sentence that the development Application panel stays on
the Launchpad home: the home is the catalog) and F8's "Not done" list (module logs are
done; worktree source stays not done).

**State on the evening of 2026-09-28.** Merged in this repository (slices of
[Launchpad parity](launchpad-parity.md#e-slices)): the shaping (#65); P1, F21's
slices (#67, #69, #72, #78); P2, the unit's `PATH` line (in #67); P3, the handover
entry with the schema re-pinned to Machines v0.12.93, which released M1 (#71); P4, the
catalog home and admission variant B (#68); P5, the module lifecycle (#73); P6, the
gateway's `ensure` (#79); P7, Chat into T3 Code (#80); P8, `lazurio doctor` (#77); P12,
the Team rule for `gh` (#66). Open: M2, the switch apply (Machines #248, Draft, not
declarable until a Platform candidate with P1–P8 has passed `qualify.yml`); M3, the
local Ubuntu VM qualification harness (Machines #244, Draft, no real run yet); M6, the
rebuild, whose design is merged (Machines #247) and whose slices R2–R8 are open; the
first real qualification run (`v0.1.8-rc.2`) failing J3 on Ubuntu (F21); issue #76,
hosted admission refusing a session cookie split into chunks (P13). P9 follows the
switch. The resident Launchpad serves every hosted Machine until the switch release.

| Alternative | Trade-off / disposition |
| --- | --- |
| Run both Launchpads side by side on a transition hostname | Gentle, but two Launchpads, a second hostname and a way back to maintain; rejected by the Principal |
| Port the resident's code | Carries a Git client, a plan browser and click ranking nobody decided; rejected: concepts, not code |
| Keep transition-only admission until an identity continuity proof | The proof has no owner; every migrated Organization would lose its applications at the switch; rejected (H1) |
| Parity by concept, CLI first, one Machines apply (selected) | No new Folder state and no parallel run; the switch waits for Recovery mode and a qualified candidate |

## F23 — The operator's own checkout is read by ownership, not by permission bits or link count

**Principal's decision 2026-09-29, accepted** (issue #92, last comment; the reasons of
issue #93 follow from it; the directory, dependency-tree and lockfile points were
decided the same day on the open questions of #94). The Principal did not pick one of
the options of #92 as written; he stated the principle, which decides it:

> The rights of the signed-in GitHub account are the authority. What GitHub allows the
> operator, the operator may use. The Platform does not add a second, local permission
> layer on top of the operator's own checkout. [...] Keep it simple.

The hosted setup only installs Lazurio from the public checkout; the operator installs
the Organization under their own rights after linking GitHub in the Launchpad, and
nothing but the operator writes the Organization's files. On a hosted work Machine the
operator's umask is `002`: Git creates the checkout's directories `0775` and its files
`0664`.

1. **Files of the checkout.** A file of the operator's own checkout is read when it is
   a regular file (not a symlink, directory or device) owned by the operator's account
   and within its bound: **1 MiB** for a declaration or a small input, **16 MiB** for a
   lockfile (`bun.lock`, `bun.lockb`, and `package-lock.json`, `npm-shrinkwrap.json`,
   `yarn.lock`, `pnpm-lock.yaml` wherever the install reads them), which grows with
   every dependency. Its permission bits and its link count are never a reason to
   refuse it: Git under a umask `002` writes `0664`, Bun hard-links local packages,
   and both are the operator's own tools under the operator's own account, which say
   nothing about who may change the Organization (GitHub does). A world-writable file
   (`0666`) is read too: that is the operator's own choice about their own files.
2. **Directories of the checkout.** A directory of the operator's own checkout is
   accepted when it is a real directory (not a symlink, and not reached through one)
   owned by the operator; group or world write bits are not a reason to refuse it.
3. **Where the checkout rule applies.** `organizations/` and each Organization root
   with its `.git`; the Organization's `lazurio.organization.json`,
   `company.gen3.json` and `modules.manifest.json`; `workspace/`, each module and app
   directory, and a module's declarations (`lazurio.module.json` and the
   `package.json` of each app it lists); `personalspace/`, the Personalspace owner
   directory and its modules; the install inputs the start reads (the preparation
   owner's `package.json` and lockfile, workspace members, patch files and their
   directories, local `file:` dependencies, `.npmrc`/`bunfig.toml` of the checkout
   and of the account's home and configuration directory); the working directory of
   a managed install or application; the dependency owner's retained operation lock
   directory; and a module's `node_modules` tree when a clean preparation removes it.
4. **Where it does not.** What the product, root or the system writes keeps the
   strict rules byte for byte (single link, no group or world write, the expected
   owner): the Folder itself and its parent at initialization, its state and history
   directories, preferences, locks and generated inventory, the install base, the
   root-issued Machine context and handover and their directories, and runtime
   directories (application coordination under `XDG_RUNTIME_DIR`). Those are not the
   operator's checkout.
5. **Another account's file or directory is refused**, for declarations, install
   inputs and dependency trees alike: that is not the operator's checkout. A clean
   preparation refuses a `node_modules` tree, or any entry in it, owned by another
   account, and keeps every safety that is not about permission bits (no symlink
   followed, nothing removed outside the module's `node_modules`, no nested mount).
6. **A refusal has a specific reason**: `declaration-not-regular`,
   `declaration-owner`, `declaration-too-large` for a file, `directory-not-regular`,
   `directory-owner` for a directory, with the path relative to its module (`.` for
   the module itself), else to the Organization root, or `~/…` for the account's
   configuration; never an absolute path or content. `lazurio module list` reports a
   refused declaration or module directory as `executable: false` with that reason,
   and an Organization whose root or document is refused carries it too; `module
   start`, `status` and the gateway's `ensure` answer `blocked` with it; a clean
   preparation answers `preparation-failed` with it; `lazurio doctor` names it; the
   Launchpad shows it. An install input is not a declaration: it does not make the
   module unexecutable in the list, and the start refuses it with its reason.
   `operation-failed` stays only for throws without a reason.
7. **Nothing changes the operator's files.** Neither the product nor the hosted setup
   normalizes modes or links of a checkout (option 2 of #92 is rejected by the
   principle).

**Amends** the file- and directory-custody sentences of
[module adoption](module-adoption.md) and [clean module
preparation](clean-module-preparation.md) (single-link and non-shared-write
declarations, install inputs and dependency trees).
Point 6 is amended by F25: the list also reports what the preparation's shape refuses
(the owner's package, its Bun, its one lockfile), while the install inputs' contents
stay the start's to refuse.

| Alternative | Trade-off / disposition |
| --- | --- |
| Refuse only world-writable, accept group-writable with the owner's private group (#92 option 1) | Keeps a local permission layer and needs a group lookup; not chosen: permission bits are not the product's business |
| Normalize the checkout to umask `022` from the hosted setup (#92 option 2) | The product or Machines would change the operator's files, and every later clone breaks again; rejected by the principle |
| Keep the rule and only report it (#92 option 3) | Every Machine with umask `002` stays unusable; not chosen |
| Relax files only, keep the directory rule | A clone under umask `002` still has `0775` directories and nothing runs; not chosen |
| One checkout rule by ownership, type and size for files and directories, with a typed reason (selected) | Simple; another account's file or directory, a symlink and an oversized file are still refused and named |

## F24 — An Organization's root-level applications are modules of the catalog

**Direction decided by the Principal 2026-09-28; the details proposed 2026-09-29 and
implemented** (issue #95). The direction is the decided row of [Launchpad
parity](launchpad-parity.md#f-what-we-deliberately-do-not-carry-over): "Mission Control
is an Organization application; the Launchpad opens it like any module". Observed on
2026-09-29 against a hosted Organization work Folder: the catalog listed the modules
under `workspace/` and neither of the two root-level applications the Organization
keeps beside them, which the Machine's gateway serves. The Machines switch to this
Launchpad requires every module the gateway serves to be exactly one executable
module of the catalog, so it stopped (`module-unknown`). The issue left open how such
a module is named, ordered and grouped in Teams; the points below are the
implementation's answers, proposed for review.

1. **Which.** A declared slot of `modules.manifest.json` at the root-level
   application path `mission-control` or `design-system` is a module of its
   Organization when a `lazurio.module.json` is there. A slot that is not declared, not
   checked out, or checked out without a module manifest is not a module: nothing is
   guessed from a directory. The repository slots `infra` and `mission-control/db` and
   everything under `productionspace/` are never modules, whatever they contain.
2. **One code path.** The existing canonical reader (`observeOrganizationApplications`)
   admits the two paths beside the workspace slots; the catalog, `organization list`,
   `module list`, the Launchpad's module view, `lazurio module start|stop|status|logs`,
   the Launchpad's module routes and the gateway's `ensure` read it unchanged. No
   second discovery, no configuration, no state.
3. **Name and order.** The module id is the slot's id, its `slug` or else the last
   segment of its path, which the manifest's `id` must equal, exactly as for a
   workspace module (a different `id` is `module-unavailable`); in the real layout
   both are `mission-control` and `design-system`, the ids the gateway serves. `path`
   is the slot path (`mission-control`, `design-system`). Modules keep the declaration
   order of `module_slots`; a root-level application is not moved before or after the
   workspace modules.
4. **Teams, custody, executability.** The same as a workspace module's: the slot's
   `teams`, else the legacy alias, else the default Team `workspace`; the checkout rule
   of F23 on its directory, its manifest and its apps, with the same typed reasons;
   the same admission of the Organization and of its default app.
5. **A shared id is a conflict.** A workspace module and a root-level application that
   declare one id are both `declaration-conflict`, and the Organization carries the
   inventory issue `repository-id-collision`, as for any two slots declaring one id.
   Neither is picked, and neither is executable.

**Not covered.** A root-level application that the gateway serves without its slot
being declared stays outside the catalog; the Organization declares it, or the switch
refuses it (`module-unknown`). The same id in two Organizations of one Folder stays
`module-ambiguous` for `ensure` (B5). No qualification journey lists or starts modules;
the contract tests' fixture Organization carries a root-level application, and a
journey that lists and starts modules is a follow-up. The Machines gateway's
discovery and the Folder manual are unchanged.

| Alternative | Trade-off / disposition |
| --- | --- |
| A module directory with a manifest is a module, declared or not (the gateway's glob) | Guesses from the directory and makes an undeclared checkout executable; rejected by the issue's rule: declarations decide |
| A second reader for root-level applications | Two discovery paths to keep consistent; rejected: the existing reader admits two more paths |
| List root-level applications first, or in a group of their own | An ordering rule nobody decided; not chosen: declaration order, as for every slot |
| Declared root-level application slots with a module manifest, read by the one reader under a workspace module's rules (selected) | Small; the switch's check finds the served applications; an undeclared one is refused visibly, not guessed |

## F25 — A module without a preparation declaration starts by a default preparation

**Principal's decision 2026-09-29, accepted** (issue #97, last comment: option (a)).
Observed the same day on the first real Machine switched to this Launchpad
(`0.1.8-rc.7`): `lazurio module start` of its only module answered `operation-failed`,
because the application's `package.json` declares `lazurio.runtime` and no
`lazurio.preparation`, which the start required. On a hosted Organization work Machine
none of 27 application packages of 21 modules declares it. The Launchpad this one
replaces started the same modules by running their dev script after a frozen install
from their lockfile. The Principal's rule: what the replaced Launchpad started must keep
starting without a change in the module. The catalog meanwhile called these modules
`executable: true`, which the Machines switch relies on before its point of no return,
and the operator saw only `operation-failed`. Both are fixed with the decision.

1. **The default.** An application package without `lazurio.preparation` has the
   default preparation: its own `package.json` is the owner (`owner_package` is the
   application package itself); preparing is the frozen install, `bun --no-env-file
   install --frozen-lockfile` (with `--backend copyfile` when the package has local
   `file:` dependencies, as for a declared preparation), from the one Bun lockfile
   (`bun.lock` or `bun.lockb`) beside that package, under the existing install
   authority, checkout rule (F23) and guarded process; there is no prepare script and
   **no check script**. No owner is searched among the ancestors, and no script name is
   invented.
1a. **Local dependencies in the same Organization checkout** (extension of 2026-09-29,
   after a read-only check of this change on a real hosted Organization work Machine:
   of 21 modules 16 were executable, 1 had no app, and 4 were refused as
   `preparation-dependency-outside-owner`, because their application packages share a
   contracts package of the Organization's root repository, for example
   `"@<scope>/v1": "file:../../../../launchpad/contracts/v1"` from
   `workspace/<module>/app/v3/`; the replaced Launchpad starts them). For the default
   preparation a local `file:` dependency may lie anywhere inside the same Organization
   directory (`organizations/<Org>/…`; for a Personalspace module its owner directory
   `personalspace/<owner>/…`), also outside the module's own repository. The reference
   is normalized as text, without following a symlink, and the dependency is then
   reached from the Organization directory one real directory at a time under the
   checkout rule (F23: no symlink on the way, owned by the operator; permission bits are
   not a reason). Its files are install inputs of the operator's checkout like any other
   local dependency: the install authority inventories that dependency, and only it,
   so a change invalidates the observation; the Organization is never inventoried as a
   whole, and the Organization directory itself is not a dependency. Still refused: a
   dependency that leaves the Organization directory
   (`preparation-dependency-outside-owner`), one through or at a symlink or owned by
   another account (the checkout rule's `directory-not-regular`, `directory-owner`, …
   with its file relative to the module, else to the Organization root), and one that
   is not there (`preparation-dependency-missing`, named by the application package
   that declares it). This follows decision (a), what the replaced Launchpad started
   keeps starting, and F23, the operator's own checkout is read by ownership with no
   second permission layer. A declared preparation keeps its owner as the boundary. Git
   dependencies (`git+https://…`, `git+ssh://…`) are not local dependencies: the frozen
   install resolves them with the operator's own GitHub access.
2. **The start.** A declared preparation's start runs its check and installs nothing,
   as before. The default has no check, so the check is optional for the default only:
   its start-time step is the frozen install itself, which changes nothing when
   `node_modules` matches the lockfile and repairs it when it does not (observed on a
   real Machine: dependencies older than the lockfile pinned, fixed by exactly this
   install). The same holds for the gateway's `ensure` and the Launchpad's Start, which
   run the same core. The install runs under the start's coordination, not as a
   separate transaction: an interrupted install leaves no retained record, because the
   next start's frozen install is its repair. *Amended by F30:* a declared preparation's
   start runs the same install, then its check, and only when the check fails its
   `prepare_script` and the check again.
3. **The toolchain.** A package that pins Bun (`packageManager: bun@x.y.z`) is
   installed and run with exactly that Bun, as before; a mismatch with the operator's
   Bun is `preparation-toolchain-mismatch`. **A package that pins none is installed and
   run with the operator's Bun at `~/.local/bin/bun` (B2), whichever version it is**,
   which is what the replaced Launchpad did; real application packages do not
   guarantee a `packageManager`. Any other `packageManager` value is refused. This rule
   is the install authority's and holds for a declared preparation too.
4. **The catalog tells the truth.** `executable` means that a start of the default app
   can proceed as far as is known without running anything: after the declarations and
   the Organization's admission, the preparation in effect is inspected read-only
   (`inspectPreparationShape`): the owner's path and package, its `packageManager`, its
   one lockfile under the checkout's file rule (a regular file of the operator, at most
   16 MiB, not empty), the checkout's `.npmrc` and `bunfig.toml` down to the owner under
   the same rule, its own local dependencies being there inside their boundary (point
   1a) and reached through real directories (a symlink there, dangling or not, is
   `directory-not-regular`; a file dependency is under the file rule), the default's
   separate application directories (point 6), and a declared owner's membership and
   scripts with no workspace install. What fails there is `executable: false` with the
   start's reason and file, and `preparationRefused: true`, in `module list`,
   `organization list`'s JSON, the Launchpad's module view and `lazurio doctor`.
   **Amends F23 point 6** only in this: the preparation's shape is now reported by the
   list. Deliberately left to the start, as F23 point 6 says, because the list would
   have to read or inventory them: the files inside local dependencies and their
   transitive dependencies, patch files, workspace members, the account's own
   configuration (`~/.npmrc`, `~/.bunfig.toml`, the XDG directory), an explicit owner's
   package that does not parse (`module-unavailable` in the list), the inventory limits;
   and what only running shows: a Bun version mismatch and a failing install.
4a. **Reading and stopping never depend on the preparation.** A module refused only by
   its default app's preparation keeps its lifecycle: `module status`, `module logs` and
   `module stop` operate its running app (the Launchpad's module page keeps the card
   and its Stop), and the stop of a session app does not resolve the preparation. Only
   what would start it depends on the preparation: `module start` refuses with the
   reason, and `ensure` reports a running app as it is and refuses with the reason only
   where it would start a stopped or ended one. A running app whose lockfile disappears
   is therefore still read and stopped (review 5359095003).
5. **Typed reasons.** A preparation that cannot run for a known reason answers one of a
   closed set, with the module-relative package or lockfile as `file`, never an
   absolute path or the error message: `preparation-lockfile-missing` (no lockfile, or
   an empty one), `preparation-lockfile-ambiguous` (both `bun.lock` and `bun.lockb`),
   `preparation-package-manager-unsupported`, `preparation-dependency-outside-owner` (a
   `file:` dependency outside the Organization directory, or for a declared preparation
   outside its owner), `preparation-dependency-missing` (a `file:` dependency that is not
   there), `preparation-owner-invalid`,
   `preparation-script-missing`, `preparation-workspace-unqualified`,
   `preparation-applications-overlap` (point 6), and from the start
   only `preparation-toolchain-mismatch` and `preparation-install-failed` (with the
   lockfile). The CLI and the Launchpad explain each in words (English and Czech on the
   page). `operation-failed` stays for a throw without a known cause.

6. **Application packages of one module do not overlap under the default.** The
   default install writes the application directory's `node_modules`, beneath any other
   application package nested there, whose app may be running from it. The default
   preparation therefore refuses an application whose directory contains, or lies
   inside, the directory of another application package the same module declares
   (`preparation-applications-overlap`, naming the module-relative package, in the list
   and at the start of either). Sibling packages (`app/v1`, `app/v2`, `app/v3`) never
   overlap, and a local package inside the application's directory
   (`app/v3/packages/<name>`) is a dependency, not an application. Such a module
   declares its preparation (review 5359095003).

**What the explicit declaration is still for**: a workspace owner (still refused for
installation until its inputs are qualified), a prepare script (data or DB setup the
module owns), a check the start runs instead of installing, or application packages
nested in one another.

**Not covered.** The default does not qualify workspaces, local dependencies outside
the Organization's checkout (point 1a), an application without dependencies (Bun deletes an empty lockfile, so it
has none and is `preparation-lockfile-missing`), or private Git dependencies beyond
what the operator's own Git and GitHub access on the Machine allow the install. The
install runs the package's own lifecycle scripts as `bun install` does. No new
configuration, Folder state or second mechanism: the default is the absent case of the
existing composition. The qualification journeys (J1–J5) start no module; the
contract tests' fixture modules include undeclared ones, and a journey that starts an
undeclared module is a follow-up.

| Alternative | Trade-off / disposition |
| --- | --- |
| Every application package declares `lazurio.preparation` before its Machine switches, with a migration and `executable: false` until then (option b) | A change in every module of every Organization before the switch; not chosen by the Principal |
| Search the ancestors for a lockfile or workspace owner | Guesses which install owns the app; excluded by the issue's rule |
| Default with a check script by convention (for example `check`) | Invents a script name the modules never agreed to; rejected |
| Pin the default toolchain to the Platform's own Bun version | Real Machines update their Bun (B2); every module would stop at the first Bun update; not chosen |
| Local dependencies only inside the application's package directory | The first version of this change; four real modules sharing the Organization's contracts package stayed refused; widened (point 1a) |
| Local dependencies inside the module's own repository | The shared contracts package lives in the Organization's root repository; the same four stay refused; not chosen |
| Local dependencies anywhere the operator can read | Crosses the Organization's access boundary (one Organization, one access boundary); rejected |
| The application's own package, a frozen install from its lockfile, no check (selected) | Starts what the replaced Launchpad started; honest refusals with a reason for what it cannot |
| Local dependencies anywhere in the same Organization (or Personalspace owner) directory, through real directories of the operator's checkout, only the dependency inventoried (selected, point 1a) | Starts the real modules unchanged; the Organization stays the boundary and F23 the only rule |

## F26 — A started application gets the runtime environment of the replaced Launchpad

**Required by the Principal 2026-09-29 (issue #102); the details proposed 2026-09-30
and implemented.** Observed on 2026-09-29 on a hosted personal Environment, at its first
real switch to this Launchpad: a module started through the module operations ran and
was healthy on its loopback port, and opened at its own hostname it answered the dev
server's refusal "Blocked request. This host (…) is not allowed." The application reads
its hosted origin from `LAZURIO_RUNTIME_EXTERNAL_ORIGIN` and allows exactly that
hostname (and checks the `Origin` header against it). Its unit had exactly `HOME`,
`PATH`, `LAZURIO_RUNTIME_LISTENER_ENTRYPOINT_HOST` and `_PORT`; `lazurio module status`
already answered the right `runtime.url`. The rule is F25's: what the replaced Launchpad
started keeps starting without a change in the module.

**Source of the contract.** The replaced Launchpad (public, `HumanAndMachines/Lazurio`):
the start's overrides (`R:lazurio/runtime/runtime-lib.mjs:703-722`), `runtimeProcessEnv`,
`listenerRuntimeEnv`, `hostedRuntimeOrigin`, `organizationRuntimeEnv`
(`:2080-2188`), `runtimeListenerState` (`:127-143`), `runtimeListenerEnvironmentNames`
(`R:lazurio/core/runtime-contract-lib.mjs:54-78`), the listener binding of a module
lease (`R:lazurio/core/module-contract-lib.mjs:183-209`), `launchpad/README.md` and
`launchpad/docs/hosted-workspace-parity-contract.md` (the hosted origin), pinned by
`launchpad/src/runtime-lib.test.mjs` and `runtime-contract-lib.test.mjs`.

1. **What a declared runtime gets.** On top of the closed base `HOME`, `PATH` and
   optional `TMPDIR`, in both runners (`src/modules/application-environment.ts`, built
   in `localApplicationAdapters.prepareLaunch`):

   | Name | Value | Present | Replaced Launchpad |
   | --- | --- | --- | --- |
   | `LAZURIO_RUNTIME_LISTENER_<ID>_HOST`, `_PORT` | the listener's lease host and port; `<ID>` upper-cased, `-` as `_` | every listener | `listenerRuntimeEnv` |
   | `LAZURIO_RUNTIME_HOST`, `LAZURIO_RUNTIME_PORT` | the entrypoint's lease | always | start overrides |
   | `LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN` of the entrypoint, `LAZURIO_RUNTIME_EXTERNAL_ORIGIN` | the browser origin, `https://<host>`, no slash, no path | hosted, the entrypoint of the module's default app | `listenerRuntimeEnv`, `hostedRuntimeOrigin` |
   | `LAZURIO_RUNTIME_LISTENERS_JSON` | `[{id, role, allocation: "static", host, port, protocol, health, claim: {mode: "exclusive"}, external_origin?}]` | always | `runtimeListenerState` |
   | `LAZURIO_RUNTIME_SCHEMA_VERSION`, `LAZURIO_RUNTIME_APP_ID`, `LAZURIO_RUNTIME_ENTRYPOINT_ID` | `lazurio.runtime.v1`, the runtime `id`, the entrypoint's `id` | always | start overrides |
   | `COMPANYASCODE_APP_ID`, `COMPANYASCODE_RUNTIME_KEY`, `COMPANYASCODE_RUNTIME_SOURCE` | the runtime `id`, the runtime `id`, `main` | always | start overrides (the key and source of the module's own checkout) |
   | `COMPANYASCODE_ORGANIZATION_ROOT` | the canonical Organization root | an Organization's module; not a Personalspace module | `organizationRuntimeEnv` |
   | `NODE_PATH` | `<application directory>/node_modules` | always | `runtimeProcessEnv` |
   | `NODE_ENV`, `ASTRO_DEV_BACKGROUND`, `ASTRO_PREVIEW_BACKGROUND` | `development`, `1`, `1` | always | start overrides |

2. **One source for the origin.** The origin is the one `runtime.url` links to, from one
   function (`applicationOrigin` in `src/modules/module-operations.ts`): on a Folder with
   a Machine binding, `moduleOrigin` of the recorded entry's module origin template
   (B4), for the module's default app, which is what the gateway serves at the module
   hostname. So the variable is exactly `runtime.url` without its slash, `new URL(x).origin`
   of it. No entry (`hosted-entry-missing`), another app of the module
   (`hosted-app-not-default`), a label the gateway does not serve, a workstation and every
   listener but the entrypoint: no origin, the app is loopback-only, as its link says. A
   Folder whose state cannot be read is not taken for a workstation (#83): the start is
   refused as `folder-state-unreadable` before any effect.
3. **Closed.** The environment is built from the declaration, the application's
   directory, the Organization root and the origin only; nothing ambient is read, so an
   ambient `HOST`, `PORT`, `NODE_PATH`, `COMPANYASCODE_ORGANIZATION_ROOT` or
   `LAZURIO_RUNTIME_*` of the Launchpad, the CLI or the user manager never reaches the app
   (the user manager's own names stay unset, F8). This is the replaced Launchpad's
   removal list, enforced by construction.
4. **Not carried over, and why.**
   - *The rest of the parent's environment.* The replaced Launchpad passed its whole
     process environment minus the names above; this Platform's owner passes a closed
     allowlist (the unit environment of F8, `docs/module-adoption.md`: a user manager's
     environment carries session sockets and credentials). A module that read another ambient variable gets it from its own
     declaration or configuration, not from the Machine.
   - *`HOST` and `PORT`.* Given only to a legacy `companyascode.app` declaration; this
     Platform refuses such a declaration ("explicit adoption"), so no started app is one.
   - *`COMPANIES_WORKSPACE_ROOT`.* The directory holding every Organization of the
     Machine; telling a module where the other Organizations are crosses the access
     boundary of its own (one Organization, one access boundary), and its only reader
     is the replaced Launchpad's own per-Organization app, which this Launchpad replaces.
   - *`COMPANYASCODE_WORKTREE_SLUG`.* Only for a worktree source, which does not exist yet
     (P9); it comes with it, as would another `COMPANYASCODE_RUNTIME_KEY` and `_SOURCE`.
   - *The hosted fail-closed start without an origin.* The replaced Launchpad refused a
     hosted start whose origin it could not derive; this Platform's hosted mode is the
     recorded entry (F16), so without an entry the Machine is served as a workstation and
     the app starts loopback-only, as its link already said.
5. **Running applications.** The declaration digest (`declaration sha256`) covers the
   module's declaration files only, and the unit's name its identity; neither covers the
   environment. The unit's `definition sha256` covers it but only proves that the unit is
   the one this runner created. An application started before this change (or before
   the Machine's entry changed) is therefore still recognized, reported running and
   healthy, `start` answers `already-managed`, and Stop works; it keeps its old
   environment until it is stopped and started once (`lazurio module stop` and `start`,
   the Launchpad's Stop and Start, or a reboot, which ends every transient unit). No
   start stops a running application as a side effect (F8: an update must not interrupt
   people's work). A session application
   (macOS) ends with its Launchpad, so an update always starts it anew.

**Not covered.** The preparation's processes (install, prepare and check scripts) keep
the closed base environment, as before. Other differences of the start that the
replaced Launchpad had and this one does not (`bun run` without `--no-env-file`, so Bun
loaded the package's `.env` files; its own log file per app; a port takeover) are
separate questions, not changed here. The qualification journeys start no module; the
contract tests (`tests/application-environment.test.ts`) start a fixture application
that allows only its origin's hostname, on a hosted and a workstation fixture Folder, in
both runners, and compare the whole environment exactly.

| Alternative | Trade-off / disposition |
| --- | --- |
| Add only `LAZURIO_RUNTIME_EXTERNAL_ORIGIN` | Fixes the observed module; a module reading the aliases, the listener JSON or `NODE_PATH` breaks at the next switch; rejected by the F25 rule |
| Pass the parent's environment minus a removal list, as the replaced Launchpad did | Hands session sockets and credentials to every module; rejected by the F8 unit's allowlist |
| Compose the origin from the Launchpad's origin or the Machine name | Composition from a convention (`docs/hosted-entry.md`); rejected |
| Bind the environment into the declaration digest, so a stale app reads as `declaration-changed` | The app then reports unhealthy and without a link but still runs stale, and nothing restarts it; not chosen |
| Restart a running app whose environment differs | A start that stops an app people may be using, against F8; not chosen |
| The replaced Launchpad's names and values, built from the declaration and the recorded entry, on the closed base (selected) | Modules run unchanged; one source for the link and the origin; nothing ambient |

## F27 — The Steward preset for the Automated Environment

**Proposed 2026-09-30 (upstream decision 0169; plan DEV-6632, milestone M2); implemented
locally; derived from the handover since the re-pin to Machines #277 (amendment below).** A fifth [workspace preset](workspace-presets.md) (F10),
`hosted-organization-steward`, for the fourth kind of Environment, **Automated**: the
work VM of an Organization persona whose bot team runs in Lazurio MausBot, with one
responsible operator (an Owner or Admin). Personalspace never, Organization
repositories mounted, provider identity `persona-account` (the persona's own GitHub
user account, a bot account, signed in by the operator, who holds its 2FA and recovery),
surfaces `launchpad`, `hosted-entry` and `mausbot` (named `openmausbot` until DEV-6632's naming rule: every name Lazurio owns says `mausbot`; data only, never persisted), the OS service manager. A new
preset field `botTeam` declares the defaults Lazurio MausBot starts the team with
(`OMB_DEFAULT_BOT_CWD` = the Lazurio Folder, the Steward team file of the installed
release, the GitHub intake for the team leader in the Organization scope without the
Organization's infra and productionspace repositories); the service that runs Lazurio
MausBot applies them, Platform renders them and applies none. The curated gh sign-in
stays offered, for the persona's account. The kind is derived from a new
`owner.assignment` value `{kind: "automation", github_login, github_id}` naming the
responsible operator; a stored binding accepts it ahead of the Machines schema, the
vendored schema is not changed locally, and until the re-pin the preset is an explicit
choice, allowed on every `workspace-vm`. Existing handovers derive, record and render
exactly as before; their allow-list gains the third Organization preset. Details:
[workspace presets](workspace-presets.md#the-steward-preset-automated-environment).

**Template revision.** The Folder template revision stays `base-instructions-14`: the
added text renders only under this preset, which no earlier release can record, so
every Folder of the four earlier presets keeps its bytes and its recorded digests
(their snapshots are unchanged) and no existing Folder is re-rendered. A bump would
re-render every Folder for no change in content. The user-facing text says
"Environment", never Machine (issue #99).

| Alternative | Trade-off / disposition |
| --- | --- |
| Derive the Automated kind from the Machine or Team name, or from a persona account signed in to `gh` | A guess from names or from live state that changes; forbidden by 0169 and F10; rejected |
| A separate handover field for the persona identity next to `owner.assignment` | Two fields to keep consistent for one fact; 0165 already derives the kind from `owner.assignment.kind`; rejected in favour of a third kind of the same value |
| `owner.assignment` `{kind: "automation", github_login, github_id}` of the responsible operator (selected) | Same shape as `operator`, one selector, fail closed on unknown kinds; needs a Machines schema change and a re-pin |
| Allow the Steward preset only on an `automation` handover | Nothing to choose until Machines ships, and a work VM re-assigned from a Team to `automation` could not reach the preset through the change path (the old binding would refuse it); rejected for the kind-wide allow-list that F10 already uses. Superseded for new choices by the amendment below, which also gives the re-assignment its path |
| Configure Lazurio MausBot from Platform (write its environment or unit) | A second supervisor and a writer outside the Folder; Machines runs the service today; rejected: the preset declares, the service applies |

**Amendment 2026-09-30 (Machines #277; issue #107).** The vendored handover schema is
re-pinned to the head of Machines pull request #277 (commit `504db74`), which adds
`owner.assignment` `{kind: "automation", github_login, github_id}`; the pin moves to
its merge commit before a release. `src/machine/binding.ts` projects it one member to
one, so an Automated Environment's handover derives `hosted-organization-steward` and
`folder-init` records it as `derived`. Recovery withholds the responsible operator
from the handover evidence as from the binding; the Launchpad names the assignment as
the Folder renders it.

New preset choices are narrowed by the stated assignment (issue #107, following
upstream decision 0168): when the handover states `owner.assignment`, the only
selectable preset is the one it derives (`selectablePresets` next to
`allowedPresets`); without a stated assignment the choice stays the machine-kind
allow-list. This governs `folder-init --preset`, the profile change and the
Launchpad's offered presets. A recorded preset stays valid within the allow-list
(state and render validation are unchanged) and stays offered, so no existing Folder
becomes invalid; switching it to a preset that is not selectable is
`preset-not-allowed`. No transition relief keeps the Steward preset selectable on an
`operator` handover: the handover states `automation` directly. A re-assignment whose
recorded derived preset the new assignment no longer derives stays
`preset-derivation-changed` on refresh; since the profile change plans against the
recorded binding, which now offers only the old preset, `lazurio machine
folder-refresh --preset <derived>` takes the newly derived preset (and only it) with
the new binding in one revision, recorded as `derived`. The refresh of the F10
amendment of 2026-09-23 took no options; it now takes exactly this one choice, named
explicitly by the operator, so nothing is switched silently.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep the kind-wide allow-list for every choice | Leaves a Team Environment one explicit choice away from a user-account sign-in (0168); rejected by issue #107 |
| Narrow validation of stored presets too | Would make existing Folders invalid (an explicit Steward preset recorded on an `operator` handover under #106); rejected: only new choices narrow |
| Refresh switches to the newly derived preset by itself | A silent switch of provider identity, against F10's refresh rule; rejected for the explicit `--preset` |
| Profile change reads the current handover | The Launchpad and profile commands would read the Linux handover and mix an infrastructure rewrite into a Principal's revision, as F10 rejected; rejected |
| `folder-refresh --preset <derived>` (selected) | One explicit option on the existing refresh, same planner and transaction; takes only the derived preset |

## F28 — Towards people the place they work in is the Environment; a hosted one is a Remote Environment

**Decided by the Principal 2026-09-29 (issue #99).** What people read calls the place
where they and their agents work the **Environment**, and a hosted one a **Remote
Environment**. The words "Mašina", "Machine" (as the thing a person works in), "VM" and
"server" are not used towards people. The reason is recognition: people know "Remote
Environment" from the tools they already use (Codex and T3 Code name a hosted workspace
that way, F16), and understand it better than "Machine", which in this project is a
defined architectural term.

1. **Czech.** The word stays unchanged and is masculine: *ten Environment*, *tento
   (tenhle) Environment*, *na tomto (tomhle) Environmentu*, *Remote Environment*
   (*osobní Remote Environment*, *pracovní Remote Environment*, *týmový Remote
   Environment*). Texts that already treated it as neuter (*tohle Environment je
   sdílené*) follow the masculine form.
2. **Where it applies.** Every user-facing string of the Launchpad in both locales
   (`src/launchpad/messages.ts` and the page's own fallback text), the human output and
   help text of the CLI, the prompts a person copies for an agent, and the instructions
   the Platform generates into the Folder (`AGENTS.md` and `manual/`, every preset, both
   locales). The generated `AGENTS.md` carries one short rule that tells agents to say
   Environment and Remote Environment to people and never Mašina, VM or server
   (`environmentWording` in `src/folder/render.ts`); the template revision is
   `base-instructions-15`. The manual defines **Machine** once, as the technical term,
   in its glossary and in the boundary bullet of `manual/lazurio.md`.
3. **Where "Machine" stays.** Machine remains the technical term for the runtime,
   security and recovery boundary an Environment runs on (0144, 0153). Identifiers, JSON
   keys, machine-readable values, command names (`lazurio machine inspect`,
   `lazurio machine folder-refresh`), flags, file names (`manual/this-machine.md`,
   `lazurio.machine.json`), schemas (`lazurio.machine.v1`), custody, `ARCHITECTURE.md`
   and these decision records keep it. Where help text must name such a command, the
   command stays and the prose around it says Environment. The hosting product keeps its
   name, Lazurio Machines; in prose its operator is the hosting operator.
4. **A guard.** `tests/environment-wording.test.ts` scans the message catalog in both
   locales, the page's text, the prepared prompts and the generated Folder instructions
   and manual of every preset and locale for "Mašin", "VM" and "Machine" as a noun. Its
   allowlist is short and explained: the wording rule itself, code spans (commands,
   paths, identifiers), the bold defined term **Machine**, the product name Lazurio
   Machines, the name of the principle "Human and Machine", and the Czech word
   *mašinérie* (machinery).

**Not covered.** Renaming identifiers, JSON keys, commands, schema fields, file names
or the architecture's term is a separate decision, because other products read those
contracts. Docs that are architecture or decision records keep "Machine"; user guides
may follow this wording when they are next edited.

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep "Machine" / "Mašina" towards people | A defined architectural term people do not recognize; rejected by the Principal |
| Czech "prostředí" / "vzdálené prostředí" | A common word that does not read as a name; not chosen by the Principal, so Czech and English texts name the same thing |
| Rename the identifiers, commands and schemas too | Changes contracts other products read; a separate decision |
| "Environment" and "Remote Environment" in what people read, "Machine" as the technical term, guarded by a test (selected) | People read one familiar word; contracts stay; regressions are caught |

## F29 — Entry units of a Remote Environment: the Launchpad, T3 Code and the operator's Codex app-server

**Decided by the Principal 2026-09-30 (plan DEV-6635); implemented in this revision.**
A Remote Environment has three ways in that must be there after every boot without
anyone starting them by hand: the Launchpad (the installer's
`lazurio-launchpad.service`, F21), T3 Code (baseline, its launcher's unit, Machines,
F17) and the operator's **Codex app-server daemon**, which a Codex client — the Codex
app over SSH, for example — connects to. Today nobody starts the daemon after a reboot
and such a client waits forever. `codex app-server daemon start` does not survive a
reboot on its own.

1. **A second installer unit.** Next to the Launchpad unit the installer owns
   `lazurio-codex-app-server.service`, a `oneshot` unit with
   `RemainAfterExit=yes` that runs the operator's own `%h/.local/bin/codex app-server
   daemon start` (`ExecStop=-… daemon stop`), `WantedBy=default.target`, with the
   condition `ConditionFileIsExecutable=%h/.local/bin/codex`, `KillMode=process`, the
   units' PATH, no `Restart=`, no `PrivateTmp=` and no ordering against the Launchpad.
   Exact text and the reason for each directive: [product update](update.md#state-on-disk).
2. **The Platform converges its entry units itself, on install and on update.**
   Whenever `lazurio install` (with or without `--service`) or `lazurio update`
   (online, or offline through `install --base`) finds this base supervised — the
   Launchpad unit is the installer's unit of this base (`unitBelongsToBase`) — and the
   process is the declared operator of a readable Machine handover
   (`discoverHostedOperator` answers `hosted`, the signal that gives a Remote
   Environment its Folder), it ensures the Codex unit. So every Environment switched
   before this release gets it: Machines runs `install --service` once, at the
   Launchpad switch, and afterwards only `install --base` without `--service`, and
   operators run `lazurio update`. A workstation's supervised base writes the
   Launchpad unit alone (`skipped-not-hosted`); a base without its Launchpad unit is
   left alone and its result has no `codexAppServer`. The hosted context is asked only
   for a supervised base. `serviceInstalled` still says only whether `--service` was
   given. No new flag: the handover already says it. The first online update **to**
   this release runs the previous release's updater, which does not converge; the next
   `install --base` of a Machines apply, or the next update, does.
3. **Codex stays the operator's** (root decision 0161, F17). The Platform never
   installs, updates, downgrades or reconfigures Codex and never runs its installer;
   without Codex the condition skips the start and nothing fails. `install` and
   `update` never `restart` or `stop` the unit, because that ends live Codex sessions;
   `start` of an active unit changes nothing, and identical text is not rewritten.
4. **It never blocks.** The step runs only after the Launchpad unit is in place (and,
   on update, after a successful run, outside the update lock), and nothing about it
   fails the installation, the update or the Launchpad switch: the result keeps `kind`,
   `serviceInstalled` and its success and adds `codexAppServer` (`enabled`,
   `skipped-not-hosted`, `foreign-unit`, `failed` with `step`, each failure with
   `next`). An unmarked file of that name, or a masked unit, is someone else's and is
   left unchanged. The marker alone is ownership: the unit names no base or Folder, so
   every installation renders the same bytes.
5. **A fact in doctor, not a recovery.** `lazurio doctor` reports it as
   `codex-app-server`: `ok` when the unit is active and Codex answers `running` to
   `codex app-server daemon version`, otherwise `warn` with its reason, `skipped` where
   the unit cannot be (not Linux, no user manager, not supervised, not hosted, no
   Codex); never `fail`. `lazurio recover` and Recovery mode do not look at it.

**Not decided here.** T3 Code's unit stays Machines'. A refused update
(`activation-unhealthy` included) converges nothing; the next successful install or
update does.

| Alternative | Trade-off / disposition |
| --- | --- |
| Leave the daemon to the operator or the client | The failure this decision fixes: nothing starts it after a reboot; rejected |
| Machines writes the Codex unit | A second writer of the operator's user units next to the installer's, and one more thing to keep in step with the Platform's unit text; rejected: the installer that owns the Launchpad unit owns this one |
| `Type=simple` running `codex app-server` in the foreground under systemd | systemd would supervise a process Codex supervises itself (its own daemon package and update loop), and Codex's `daemon` commands would no longer see it as their daemon; rejected |
| Order the unit after the Launchpad or make it require it | Couples two independent ways in; a broken Launchpad would keep Codex away; rejected |
| An explicit opt-in flag on `install` | The handover already declares a hosted operator; a flag is a second source for the same fact; rejected |
| Write the unit only with `install --service` | Machines passes `--service` once, at the switch, so every Environment switched earlier would never get it; rejected for convergence on every install and update of a supervised hosted base |
| A oneshot unit running the operator's `codex app-server daemon start`, written by `install --service` on a hosted Machine, never blocking (selected) | Uses Codex's own daemon lifecycle; one owner of the installer's units; failures are facts, not blockers |

## F30 — A declared preparation's start installs, checks and prepares when the check fails; `lazurio module prepare`

**Decided 2026-10-02 by the owner of the Platform rollout of the Lazurio Module Standard**
(root decision 0171, `manual/module-standard.md` ch. 3 and 10; issues #114, #116). Under the
standard every application declares `lazurio.preparation`, and the Launchpad holds one
policy for every module: installing the dependencies (`bun install --frozen-lockfile` from
the lockfile beside the application's `package.json`) is part of the preparation the
Platform owns, and the module's `prepare_script` never repeats it; before a start the
Launchpad runs `check_script` and, when it fails, `prepare_script`, then the check again.
Observed on `0.1.8-rc.11` and `rc.12`: the Platform installed only for an application
**without** a declaration (F25), so a converted module on a fresh checkout answered
`prerequisites-not-ready` and nothing on the operator's side could prepare it; and a
converted module whose check passed on a tree installed for an earlier lockfile started
and crashed at once on a dependency an update had added (`Cannot find module`).

1. **The start-time step.** For a declared preparation the start runs the frozen install
   from the lockfile beside the owner's package **first, on every start**, exactly as the
   default preparation does (F25 point 2), under the existing install authority, checkout
   rule and guarded process; then its check. A check that passes is the end of the step:
   the application starts and `prepare_script` does not run. A check that fails is followed
   by the declared `prepare_script` and the check again; the application starts only when
   that check passes. The gateway's `ensure` and the Launchpad's Start run the same core.
   **Why the install comes first:** the check verifies the module's own preparation (its
   data, its build); whether the installed tree matches the lockfile is the Platform's
   question, and the frozen install is the Platform's answer to it. A module check cannot
   reliably tell whether `node_modules` matches its lockfile, and one that passes on a
   stale tree started an application that crashed. An install that changes nothing changes
   no file, so a passing check still leaves everything the module owns as it was. Its cost
   is the one every application without a declaration already pays: Bun's own no-op
   frozen install takes about 10 ms, and the guarded process, toolchain and input checks
   around it made a declared start of the fixture module about 1.1 s slower on macOS
   ARM64 (1.2 s to 2.3 s, start to healthy against the in-memory user manager).
2. **One run, one deadline.** The install, the check, the script and the second check are
   one run of the existing Bun preparation under its one 600-second budget, so a start
   fits the Launchpad's 660-second transport wait; cancellation, timeout, unconfirmed
   cleanup and changed inputs never become prepared.
3. **Exclusion as F25 point 2.** The start-time preparation runs under the start's
   coordination, not as a retained transaction: an interrupted install or script leaves
   no retained record, and the next start installs and checks again.
4. **Nested applications.** A declared preparation keeps application packages nested in
   one another possible (F25 point 6). For such an application the start never installs:
   its check runs, and a check that fails answers `preparation-applications-overlap`; only
   an explicit preparation installs.
5. **The failed step is named.** `preparation-install-failed` with the lockfile (now also
   for a declared preparation), the new `preparation-script-failed` with the owner's
   `package.json`, and `prerequisites-not-ready` when the check still fails after the
   preparation (or fails after the install when there is no `prepare_script`). The CLI and
   the page explain each (English and Czech).
6. **`lazurio module prepare <Org>/<module> [--app] [--json]`** and `POST
   /api/modules/<org>/<module>/prepare`: the existing explicit preparation of the
   lifecycle (the transaction with the retained owner lock), whatever the check says now:
   install, `prepare_script`, check; it never starts anything. It keeps that path's guards:
   `application-running` beneath a service-owned application, `other-app-managed` while
   another application of the same Organization is managed (#124), and a session
   application is stopped for its own preparation, as before. A known preflight refusal is
   answered with its `preparation-*` reason and module-relative file, so the transaction
   completes and leaves no retained record. Where applications are session-owned, the CLI
   answers `launchpad-required`, as for start. No operator step is needed after an update
   that adds a dependency: the next start installs it.

**Not decided here.** Narrowing `other-app-managed` to applications that can share the
dependency tree (#124). Keeping the output of the preparation's processes (#125).

| Alternative | Trade-off / disposition |
| --- | --- |
| Keep the start as it is and ship only `prepare` (#114 option 1) | Every converted module needs an operator step on every Environment after every materialization; contradicts ch. 10's one policy; rejected |
| The standard says "declare only from the release with `prepare`" (#114 option 3) | Leaves conforming modules worse off than non-conforming ones; rejected |
| Check first, install only when the check fails | A check that passes on a stale tree starts an application that misses a dependency added by an update (#114's last comment), unless every module's check inspects its `node_modules`; rejected |
| Install on every start, then check, then `prepare_script` and the check again only when it fails; `prepare` as the explicit transaction (selected, #116's proposal) | One install policy for every module, declared or not; the stale-tree failure repaired without an operator step; about a second per start in the fixture when nothing changes, as for an undeclared module |
