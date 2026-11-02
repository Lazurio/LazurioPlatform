# Lazurio decision register

Lazurio's decisions have one series of numbers for both generations: GEN3, the
Lazurio Root on a person's computer, and GEN4, Lazurio Platform with its Folder
and Environments. Since 2026-11-01 this register is where the numbers are
allocated and where a public decision has its full text. An agent that meets
`decision 0172` (or just `0172`) in the Folder, in this repository or in an
Organization finds it here.

This repository's own implementation decisions, `F<n>`, are in
[decisions.md](decisions.md). They implement the numbered decisions here; where
the two disagree, the numbered decision wins and the F decision is rewritten.

## How to read an entry

- **Status:** `in force`; `in force for GEN3 only` for the Root's own mechanics,
  which stay maintained while customers work on GEN3; `decided, not yet
  deployed`, `decided, implementation in progress` or `proposed`, which are not
  facts about running systems; or `superseded by …`.
- **Applies to:** `GEN3 and GEN4`, `GEN4`, `GEN3`, or `internal (<Organization>)`.
- **Decided / Amended:** the dates of the decision and of the amendments folded
  into the text.
- **Related:** other numbers and the F decisions that implement them
  (`GEN4 counterpart` for a GEN3-only decision).

The text is the norm in force, condensed: amendments in force are folded in,
superseded parts are left out, and there are no quotations, names of customers,
internal plan codes or internal host names.

## Internal decisions

Decisions about the development and operation of Lazurio itself are internal to
the LazurioDevelopment Organization, and product and business decisions to
HumanAndMachine-ai. They keep their numbers here with one line; their full text
lives in that Organization's Knowledgebase. When a public text cites an internal
decision, its entry here carries the general norm that the public text relies
on, and only the operational details stay internal.

## Recording a decision

A new decision takes the next free number, **0227**, by a pull request to this
file. Check `main` again before the merge, because a parallel pull request may
take the same number, and fix a collision by renumbering before the merge. An
amendment is folded into the entry with its date. An internal decision gets a
one-line entry here and its full text in its Organization's Knowledgebase.

## Provenance

Until 2026-11-01 the numbers were allocated in the Lazurio Root's
`manual/decision-register.md`, which stays as the record for GEN3. These
entries condense its rows as of commit `66e437f7`. Full records up to 0127
were kept in a private, now archived repository; from 0128 on, the Root's row
was the full record. Gaps in the series are normal. 0206 is cited by F32 but
was never recorded.

## Decisions

### 0013 — One Lazurio Root per machine as a workstation control plane

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F1

A computer carries exactly one Lazurio Root. The Root discovers and runs the Organizations mounted in it but never holds their business truth, which stays in each Organization's own repository. The rule holds for Root installations until they move to the Lazurio Folder (0164).

### 0018 — Every Organization has its own doctor

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0118

Each Organization carries its own doctor for its own repository and contracts. Diagnostics run per Organization, not as one global check across Organizations. In GEN3 the Root's doctor calls these doctors and aggregates their reports (0118).

### 0021 — A Team is a named group inside an Organization

- **Status:** in force (hostname pattern superseded by 0146) · **Applies to:** GEN3 and GEN4
- **Related:** 0023, 0041, 0146, 0186, F32

A Team is a named group inside one Organization. It is declared in the Organization's manifest and bound to a GitHub Team; it is not a directory (0041). The earlier hosted application pattern `<module>.<team>.<domain>` no longer applies: hosted names follow 0146, where a Team's hosted Machine is an Environment with its own label.

### 0023 — A Team may be a group of people or a brand; live GitHub grants decide its access

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0021, 0041, 0186, F32, F33

A Team can be a group of people or a brand or venture of the Organization. Which modules belong to a Team is declared in the manifest. Whether a Team can reach a module is decided only by its live grant on GitHub (0186); the declaration grants nothing. In GEN4 the Launchpad does not group modules by Team (F32).

### 0024 — CEO-first concept of the Launchpad

- **Status:** superseded by 0047 · **Applies to:** —

### 0026 — Canonical Organization layout and its single manifest authority

- **Status:** in force (compatibility window closed by 0145) · **Applies to:** GEN3 and GEN4
- **Related:** 0031, 0042, 0145, F12

An Organization uses `lazurio.organization.json` as the only authored source of its Organization manifest, a flat `workspace/` folder and a separate `modules.manifest.json`. `company.gen3.json` is at most a deterministic legacy projection generated from the canonical file, never a second authority. Decision 0145 deprecates it and sets how the compatibility window ends.

### 0030 — The Root is a direct-pull clone of one shared upstream

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F13

A Lazurio Root is a clone of the one shared upstream repository and is updated by pulling from it directly. Improvements go back upstream as pull requests, never by syncing a fork. The rule holds for Root installations until their migration to the Folder (0164).

### 0031 — Organization mounts are nested repositories classified by one resolver

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0026, 0042, 0145

Each Organization is mounted at `organizations/<org>/` as its own nested Git repository, never as a Git submodule. Every mount is classified into exactly one normalized result of the shared Lazurio Core manifest resolver, not by which manifest file name it happens to carry. In GEN3 the Root's Git ignores these mounts, its doctor manages them and the Root configuration follows the folders that are present.

### 0033 — Organizations migrate from GEN2 to GEN3 by fork, in parallel

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0037, 0044, 0164, 0166

An Organization moves from the GEN2 layout to the `_GEN3` layout through a fork that runs in parallel with the old repository. The old generation stays available as the rollback line until the move is complete. This concerns the migration of Organizations, not the installation of Lazurio, which has no rollback (0164, 0166).

### 0034 — Mission Control planning propagates through the template

- **Status:** in force · **Applies to:** GEN3 and GEN4

Mission Control and the Organization templates form one roadmap loop. Changes to the planning layer reach Organizations along the template path instead of being made separately in each Organization.

### 0035 — Data applications separate a draft of data from its Publication

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0102, 0103, 0196

Data applications of the v3 generation keep prepared changes apart from the Publication of data in their repository-db. Changes to protected paths go through draft, approval and publish. How much needs approval follows the progressive locking of the data branch (0102). The draft is shared by everyone on the same Environment (0196).

### 0036 — The Mission Control cutover from legacy YAML is gated

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0037

Moving an Organization's Mission Control from the legacy YAML ledgers to its current data store passes explicit gates. Historical records are not rewritten.

### 0037 — Mission Control v3 arrives with the Organization's GEN3 migration

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0033, 0036

An Organization adopts Mission Control v3 at the boundary of its migration to the GEN3 layout. Moving its planning data off the legacy ledgers passes the gates of 0036.

### 0039 — Historical product naming

- **Status:** superseded by 0128 · **Applies to:** —

### 0040 — Precedence of sources of truth

- **Status:** in force for GEN3 only · **Applies to:** GEN3

When sources disagree, the higher one wins: decision records, then schemas and configuration, then the glossary, then the `AGENTS.md` of the scope, then contracts, then the Guide. The Root's rules for agents state this order and place `ARCHITECTURE.md` directly below the decision records.

### 0041 — Flat workspace, Teams as declarations, and productionspace

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0021, 0023, 0186, 0221, F32, F67

All modules of an Organization live side by side in one flat `workspace/` folder. A Team is an N:M declaration in the manifest, not a directory; a module without a declaration belongs to the default Team `workspace`, and since 0186 the declaration is only the starting state when a module is created, never an access authority. `productionspace` is a reserved Organization-level name outside Teams for repositories with their own branch and release rules, where the doctor enforces only a safe minimum. The only exception to the flat folder is a guest module of another Organization (0221).

### 0042 — The Launchpad discovers Organization mounts by itself

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F12

The Root's Launchpad scans candidate Organization mounts and resolves each one through the single Core resolver, one resource per mount, failing closed on a conflict; the Root configuration is not an allowlist and the same security checks apply to every mount. The rule holds for Root installations until their migration (0167). In GEN4 the Folder catalog applies the same manifest reader to every directory in `organizations/`.

### 0043 — An invalid manifest isolates only its own Organization

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0042, 0129

An invalid Organization manifest isolates that Organization. The Launchpad sets the broken mount aside safely and never fails as a whole because of it, so the other Organizations stay usable.

### 0044 — New clients start directly on GEN3

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0033

A new client Organization is set up directly in the GEN3 layout. There is no onboarding onto GEN2.

### 0045 — `_GENn` is a permanent generation marker in names

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0219

The suffix `_GENn` is a permanent generation marker in the name of a repository and its mount, such as `<Organization>_GEN3`. The internal identity of the Organization or brand stays clean, without the marker. Repository names and the Organization layout do not change with GEN4 (0219).

### 0046 — Buddy's gbrain belongs to the Personalspace

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0051, 0091, 0210

Gbrain, Buddy's memory, belongs to the person's Personalspace and never to an Organization. It therefore never lands on an Environment owned by an Organization, where the Personalspace is never mounted (0091).

### 0047 — Two surfaces: the builder-first Launchpad and the hosted Dashboard

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0024, 0167, 0170, 0194

Lazurio has two surfaces. The Launchpad is the builder-first surface of an Environment: it starts applications from `main` and previews from worktrees, shows productionspace read-only and, in GEN4, carries no plan browser or Git actions (0167). The Lazurio Dashboard is the hosted entry for administration and for Organization Users and is not part of a self-hosted Environment. Towards people both are internal names; texts name the target as Apps, Organization overview or Settings (0170).

### 0048 — Product plans and hosting modes

- **Status:** in force · **Applies to:** internal (HumanAndMachine-ai)

The full decision is internal to the HumanAndMachine-ai Organization.

### 0049 — Plan-owned worktrees with sidecar metadata

- **Status:** in force (amended by 0167) · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-09-28
- **Related:** 0131, 0167, 0195, F14, F22

Every change is made in a plan-owned worktree under `.worktrees/` of the owning repository, with sidecar metadata (`companiesascode.worktree.v1`) naming the repository, branch, plan, pull request and originating session; the primary checkout stays on `main`. This is the working discipline of agents in GEN3 and GEN4. The GEN3 Launchpad also runs applications from these worktrees. The GEN4 Launchpad runs modules from `main` and creates no worktrees from plans; on a hosted Environment a pull request preview gets a temporary address as a lease, whose exact rules are still a proposal (0167).

### 0051 — Structure of the Personalspace

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0046, 0079, 0091, 0171

A Personalspace is the private repository `<login>/<login>_GEN3` on the person's own GitHub account, outside every company Organization. It carries `personal.gen3.json`, a flat `workspace/` folder and Buddy's gbrain at its root. Changes to the Organization manifest family (0026, 0031, 0042) do not change the Personalspace file name or its private rollout.

### 0052 — AI Architect as a paid service

- **Status:** in force · **Applies to:** internal (HumanAndMachine-ai)

The full decision is internal to the HumanAndMachine-ai Organization.

### 0059 — Root-only channel update

- **Status:** superseded by 0129 · **Applies to:** —

### 0060 — The role sets the footprint on a machine; an Organization User installs nothing

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0062, 0175

What a person installs follows their role. An Organization User is zero-install: no local Root, with access through the Organization's production applications and MCP. The role User is a different concept from the general user an agent works for (0175).

### 0061 — Bring your own subscription

- **Status:** in force (amended by 0169 and 0181) · **Applies to:** GEN3 and GEN4
- **Related:** 0169, 0181

The agent runtime and its subscription belong to the builder; Lazurio supplies no LLM account and no hidden autonomy. The subscription may be signed in on the Organization's AI pool instead of the person's machine (0181). An Environment that works through the Organization's bots uses models the Organization pays for through its pool (0169).

### 0062 — Four Organization roles

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0060, 0102, 0103, 0175

An Organization knows four roles: Organization Admin, Steward, Builder and User. The names stay in English and are not declined in Czech. A role name authorizes nothing by itself; the person's live rights with the provider decide (0102, 0103).

### 0063 — A Task Agent works only in an authorized task; authority approves its work

- **Status:** in force (terms updated by 0130 and 0156) · **Applies to:** GEN3 and GEN4
- **Related:** 0103, 0130, 0156

A Task Agent works only within a task its user has explicitly authorized and under that user's supervision. Its prepared work is approved by someone who holds the authority for the operation; the gate is authority, not whether a human or an AI did the work. Task Agent replaces the earlier term Worker Agent (0130), and the AI Colleague is retired (0156).

### 0077 — Organization templates are identified by a validated marker

- **Status:** in force (mount location superseded by 0127) · **Applies to:** GEN3 and GEN4
- **Related:** 0113, 0127, 0174

Organization templates follow a template-first flow under the name OrganizationTemplate. Whether a repository is a template is decided by its validated `organization_kind` marker, never by its name, and the runtime excludes templates from execution. In GEN3 the working checkout of a template lives under the Admin Organization's productionspace (0127).

### 0079 — A Personalspace starts from the public template

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0051, 0091

A person creates their Personalspace self-service from the public `PersonalspaceTemplate_GEN3`. The real instance is always a private repository owned by that person.

### 0080 — Buddy runs on the owner's dedicated server

- **Status:** superseded by 0153 and 0210 · **Applies to:** —

### 0089 — Buddy is the person's trusted personal representative

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0046, 0153, 0180, 0210

Buddy represents one person and acts in that person's rights. His conduct rests on a written moral contract and on standing mandates that are scoped and revocable. A mandate never replaces the consent needed for a specific transaction: billing and ownership, recovery, secrets, destructive operations, access changes and merge, publish or release outside an explicit mandate always need the person's consent to the exact operation. Buddy never issues, widens or renews a mandate for himself.

### 0090 — Worker Agent as the name of a working session

- **Status:** superseded by 0130 · **Applies to:** —

### 0091 — The Personalspace belongs to one person; GitHub decides access to source

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0046, 0153, 0172, 0192

A Personalspace belongs to exactly one person and, optionally, their Buddy. Nobody else reads it, including Stewards, Admins and the hosting operator, it is never shared and it is never mounted on an Environment owned by an Organization. The person fully controls their own machine. GitHub is the only authority for access to workspace source, and a module's repository is the smallest access boundary.

### 0092 — The AI Colleague has its own account, Machine and installation

- **Status:** superseded by 0156 and 0169 · **Applies to:** —

### 0093 — An Organization's `infra` repository is Admin-only

- **Status:** in force (amended 2026-11-01 by 0169) · **Applies to:** GEN3 and GEN4
- **Related:** 0150, 0169

The `infra` repository of an Organization is Admin-only: Stewards, Builders and Teams get no grant to it (0150). The single exception is the Organization's persona, which may receive a direct Write grant, never Admin and never through a Team, as the named independent reviewer of infra pull requests once that Organization switches its review policy (0169).

### 0094 — One named human custodian for recovery and service access

- **Status:** in force (amended by 0156 and 0169) · **Applies to:** GEN3 and GEN4
- **Related:** 0156, 0169

A custodian (Opatrovník) is the one named person responsible for recovery and for a named, audited service access. Custody is an axis separate from roles in the Organization. For an Environment that works on its own through bots, its responsible user holds this role (0169), and no separate custodian seat exists. Custody gives no right to read a private Personalspace.

### 0095 — An Admin may merge their own pull request; the Steward is the usual merge lane

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0103

An Organization Admin may merge their own pull request where GitHub allows it. The Steward is the regular merge lane, not the only authority and not a mandatory bottleneck for the Admin.

### 0102 — Mission Control writes with the signed-in person's GitHub identity

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0035, 0103

The local Mission Control writer uses the GitHub identity of the signed-in person; no second identity or approval system exists. The data lane locks progressively: in a small Organization with an unprotected data repository, any trusted Builder with live write rights may publish data, and technical enforcement starts when an Admin deliberately locks the data branch.

### 0103 — Agents deliver work as pull requests; live GitHub rights govern Publication

- **Status:** in force (the intake's reply when it declines a request is not yet built into Lazurio MausBot) · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-12, 2026-10-24, 2026-10-28 (by 0218), 2026-10-31
- **Related:** 0095, 0102, 0132, 0163, 0199, 0211, 0218

An agent always works in a worktree and delivers code as a pull request; work in an external application is a prepared, unsent state inside that application. The pull request is visible from the first push, as a GitHub Draft where the repository's plan allows it and otherwise as a regular pull request with its state in the description, and the agent marks finished, verified work Ready for review, which is not Publication. Publication (merge, sending, deployment) happens only on the user's explicit instruction in the current thread, through a valid assignee handover or under a standing merge mandate that a decision records for a defined scope; the user's live GitHub rights decide what may be merged, `main` locks progressively, and before a merge the agent checks that the approval belongs to the exact head and merges with `--match-head-commit`. People, Task Agents and bots of every Environment cooperate on a pull request only through GitHub: Ready and a reviewer request ask for review, the assignee owns completion, including an allowed merge but never a separate Release or infra apply, and a comment with an @mention notifies. A Draft gets neither review nor handover, a persona's intake that declines a request says once in the pull request why, and an author who gets no verdict in the agreed time tells its user (a bot tells whoever gave it the work) instead of waiting silently. The handoff is guiding and ends with the standard question whether to publish in the user's name or ask another colleague (0199, 0211).

### 0104 — The Root's `.claude/skills` mirrors `.agents/skills` byte for byte

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F14

In the Lazurio Root, `.claude/skills` is a Git-tracked, byte-for-byte mirror of `.agents/skills`, without symlinks so that it works on Windows. The doctor checks the parity and a repair lane restores it.

### 0112 — Agent instructions are a constitution

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-24
- **Related:** 0130, 0173, 0175, F14

Instructions for agents explain values, boundaries and expectations; they do not dictate procedures. Every rule has one canonical home, and mechanics live in scripts, skills and doctors rather than in prose. The Root's `AGENTS.md` follows the pattern of the `AGENTS.md` that Lazurio generates into each Folder: values, boundaries and short rules that link to the manuals and skills holding the details. The vocabulary of people and agents is set by 0130 and 0175.

### 0113 — A renamable name is never a key

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0125

A name that can be renamed, such as a slug, label or declaration, is neither an authorization key nor a join key. Bindings and selection rest on stable identity and verified state, never on the name alone.

### 0118 — The Root's doctor composes the doctors of mounted repositories

- **Status:** in force for GEN3 only · **Applies to:** GEN3

The Root's doctor calls the own doctors of mounted repositories as their manifest declares, aggregates the nested reports and reports a broken child loudly. Its state vocabulary includes `not_applicable`, `blocked` and `incomplete`.

### 0124 — Document modules write and publish only through branch and pull request

- **Status:** in force · **Applies to:** GEN3 and GEN4

A document-native workspace module for Markdown or MDX has one write and publish path: a Git branch and a pull request. No second writer is added; a separate authoring profile needs its own documented and approved use case.

### 0125 — A module's slug and its repository mount are separate

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0113

A module's stable identity and its physical mount are separate axes. The `slug` is an explicit lowercase kebab-case ID used for bindings and the interface, while the folder name under `workspace/` or `productionspace/` keeps the exact GitHub repository name, including case, `_` and `.`. A case-preserving folder name without an explicit or safely derivable slug fails closed.

### 0127 — Template working checkouts live in the Admin Organization's productionspace

- **Status:** in force for GEN3 only · **Applies to:** GEN3

In a Root, working checkouts of the Personalspace and Organization templates live as nested repositories in `organizations/<AdminOrganization>/productionspace/`, not as another Organization. This adds no Team membership, alias, provider transfer or visibility change.

### 0128 — The product is called Lazurio

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-24
- **Related:** 0039, 0144, 0170

The shared system, framework, Root, Launchpad messages, guides and every other current surface for people are called Lazurio; older names remain only in historical audit records. The rename does not change the company's legal name, real GitHub and Organization identities, existing paths or compatible CLI, API and data identifiers. Lazurio is developed by Human and Machine s.r.o., whose agency Rozjedeme.ai integrates Lazurio into the operations of other companies.

### 0129 — One explicit `lazurio update` for the Root and its Organizations

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F9

In GEN3 the one general update is the explicit `lazurio update`: it fast-forwards the Root, the Organization roots and freshly rediscovered managed repositories and workspace modules in that order, always on a clean `main`, moving dirty work into a verified recovery stash and returning anything unsafe as blocked with a prompt for an agent. An invalid slot is quarantined while healthy siblings continue. Productionspace, the Personalspace, worktrees and root-level repository-db mounts are excluded.

### 0130 — A tool's working session is a Task Agent

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0063, 0090, 0112, 0175

The canonical name for a tool's working session (Claude Code, Codex, Cursor and similar) is Task Agent, or Agent for short; the machine value is `task_agent`, with no compatibility alias. A Task Agent has no authority of its own. This replaces the terminology of 0063, 0090 and 0112 without rewriting their historical wording.

### 0131 — A worktree points back to the session that created it

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0049

A Task Agent's worktree carries a local, Git-ignored pointer to the session it came from, so that unfinished work can be resumed; in the worktree sidecar this is `conversation_origin`. The pointer only orients and creates no identity, attribution or permission.

### 0132 — The user owns the outcome; the agent owns a clean solution

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0103, 0164, 0166, 0173

The user owns the desired outcome, priorities and Publication; the Task Agent carries professional responsibility for an elegant, clean solution in what it proposes and prepares. Every change to source gets risk-proportional shaping: a small change gets a quick check, while a new lasting abstraction, state, authority, boundary, interface, dependency or migration needs compared variants, the smallest complete cut, named failure modes answered by forward repair (0166) and proof on a real consumer. This responsibility gives the agent no business or access authority and does not depend on a particular reviewer, model or CLI. When a clean solution needs a different goal or principle, the agent returns that choice to the user.

### 0133 — A Workspace App's dependencies come from its declared package root and lockfile

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F34

In GEN3 a Workspace App's dependency authority is the package root its manifest declares and its versioned lockfile, never file times, a local `.env` or an earlier `node_modules`, and a relative `file:` reference may point read-only only to an exact package inside the same Organization. Install keeps an existing tree, Repair removes the derived `node_modules` and installs frozen, and after a real source change the same mechanism checks the affected Apps and tries one clean repair; an invalid lockfile stays a source error for an agent. The Launchpad owns the lifecycle of the running application and restores it only after verified success.

### 0134 — One exact Bun version for the Root's source, CLI and CI

- **Status:** in force for GEN3 only · **Applies to:** GEN3
- **Related:** 0135, 0140, 0171, F62

In GEN3 the single `package.json#packageManager` owns the exact, tested Bun version for the Root's source, CLI and CI; Install Core and the doctor compare the running version exactly and fail closed on a mismatch. Installing or upgrading Bun is an explicitly agreed step, never a hidden part of `lazurio update`. In GEN4 the installed executable carries its own runtime, and the Bun an application pins is that application's runtime (0171).

### 0135 — Tool currency is a read-only troubleshooting lane

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F17

In GEN3 whether development tools are current is checked only by the explicit, read-only `lazurio doctor --tool-updates`, not by an automatic updater or the regular doctor; Git, GitHub CLI and Codex must be on `PATH` and Claude Code is optional. Tools are compared with their official stable release source, unverifiable currency stays a warning, and an agent updates, installs or changes `PATH` only after the user agrees to the exact change. Bun keeps its exact pin (0134).

### 0136 — The Root lives directly in the home directory

- **Status:** in force for GEN3 only (amended by 0164) · **Applies to:** GEN3 · **GEN4 counterpart:** F1

A Lazurio Root on a computer lies directly in the home directory at `<home>/Lazurio` (`~/Lazurio` on macOS and Linux, `%USERPROFILE%\Lazurio` on Windows), in the `source` profile where the verified existing checkout is the working Root and may keep a historical folder name until its migration. The planned `managed` profile and a Source-to-Managed migration with rollback are not built; Root installations move one way to the Lazurio Folder instead (0164). A Root outside a direct child of the home directory is not supported.

### 0137 — Lifecycle of applications started by the Launchpad

- **Status:** in force (amended by 0167) · **Applies to:** GEN3 and GEN4 · **GEN4 counterpart:** F8
- **Related:** 0049, 0167, 0195, F22

The Launchpad is a workshop with three lifecycle profiles. On a computer the GEN3 Launchpad runs `main` or a worktree only as a child of the current server session, a graceful shutdown ends the whole process tree and nothing is restored after a restart; in the GEN4 Launchpad, modules on Linux are services of the operating system that survive a Launchpad restart, while on macOS they stay bound to the session (0167). On a hosted Environment the Launchpad and T3 Code are always on, applications start only on Open or an authenticated direct link, Stop holds until the next Open, and health checks or the catalog start nothing. Production accepts only a separate reproducible build and never uses the Launchpad or worktrees, and state derived from clicks, a service catalog or its controller is never an authority.

### 0138 — Organization install fills in the Mission Control data checkout

- **Status:** in force for GEN3 only (extended by 0152) · **Applies to:** GEN3 · **GEN4 counterpart:** F34

In GEN3 the explicit `lazurio organization install` is the only bounded bootstrap for the active root-level `mission-control/db` declared as `repository_db_mount`: once exactly one installer-managed parent repository exists, it may add the missing checkout from the Organization's own remote and exact branch. An incomplete or inactive declaration ends `blocked` instead of claiming convergence, and an existing checkout must be clean and match, and is neither fetched nor fast-forwarded. Decision 0152 extends this to module data checkouts.

### 0139 — GitHub Issues hold open technical problems

- **Status:** in force (amended by 0163) · **Applies to:** GEN3 and GEN4
- **Related:** 0163

GitHub Issues in the exact owning repository are the only authority for open technical problems and uncertainties; their visibility and live GitHub rights keep the repository and Organization boundaries. Mission Control keeps the plan, priority, responsibility and delivery state. A Task Agent writes an issue without asking first (0163), after checking for duplicates and sanitizing, and without a safe target it returns a sanitized draft. The legacy `ISSUES.open.json` and `ISSUES.resolved.json` are frozen migration input without synchronization or authority.

### 0140 — A tool is ready only when it works from the user's PATH

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0134, 0135, 0151, 0161, F19

A tool counts as ready only when its command resolves in the user's `PATH` of a fresh process and works there; a present binary or success inside an inherited installation session is no proof. The first executable of the name on `PATH` is the one selected, and a matching path or version does not prove which binary it is. An installing agent runs official installers and makes the smallest user-level `PATH` change only with an explicit mandate for the exact tools, keeps existing entries and does not touch system-wide `PATH`, package managers or other versions without further consent. In GEN3 the onboarding of a work machine has one top-level gate (Git, GitHub CLI, Codex CLI, Node and the pinned Bun, with GitHub on the SSH protocol proven by `git ls-remote`) before `lazurio organization install` materializes an Organization.

### 0141 — Builder readiness is a read-only GitHub gate

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F33

In GEN3, `lazurio organization install <github-login> --role builder` first proves against GitHub, with a freshly signed-in account, active Organization membership, Team membership, effective WRITE or higher and the Team's WRITE grant on the Organization root and every active repository meant for Builders; the manifest only maps the internal Team to a verified immutable GitHub Team ID. Planned, restricted and role-mismatched slots do not block. An incomplete binding or READ fails closed before anything is materialized, naming the account, Team and repository, and the gate changes nothing on GitHub.

### 0142 — The Launchpad interface is bilingual, with locale-neutral codes

- **Status:** in force (amended by 0164) · **Applies to:** GEN3 and GEN4
- **Related:** 0164, 0170

Interface text owned by the Launchpad comes from paired `cs` and `en` catalogs with stable meaning-based keys and works offline. Core and API keep locale-neutral reason codes and parameters and never branch on a translated sentence; names, descriptions, commit texts and technical evidence owned by an Organization are never translated, and a missing or mismatched translation source has no cross-locale fallback. In GEN3 the locale resolves from an explicit browser preference, then a supported browser locale, then Czech, and switching reloads the same address without changing scope or runtime. The planned Managed Root composition is void (0164).

### 0143 — Restricted slots are declared, never inferred, and installed only by an Admin

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0093, 0141, 0150, 0152

Whether an Organization slot is restricted (Admin-only) follows only from its declaration `default_access: restricted` or `private`, never from a name or path; an unknown or malformed mode is treated as `access_classification_unknown`, without a clone or a provider read. The general `lazurio update` never materializes an absent restricted slot but keeps already mounted ones current. The only opt-in is an explicit Admin `lazurio organization install <login>` without `--role`; role-scoped installs (`--role builder`, `--role steward`) materialize only regular slots, including the required Mission Control data mount, and return restricted ones as `excluded_by_role_scope` without any provider operation. The doctor reports an intentionally absent restricted slot only as advice, and no persistent workstation ACL or second manifest exists.

### 0144 — The handover boundary between Lazurio Machines and the Platform, and the Environment vocabulary

- **Status:** in force (amended by 0161) · **Applies to:** GEN3 and GEN4
- **Related:** 0128, 0146, 0161, 0224, F10, F17

Lazurio Machines delivers a hosted Machine online: operating system, network, SSH and sudo, the Machine identity in `lazurio.machine.json`, entry through the shared Auth gateway and an installed Lazurio release. Everything inside the Machine, including the Lazurio Folder, Organizations, modules, sign-ins and their updates, belongs to the installed product, operated through the `lazurio` CLI, and to the Machine's user, and the user's tools are the user's own (0161). Machines keeps no resident or artifacts of its own and converges by deletion, not by overwriting. `lazurio.machine.json` is an owner-bound description of identity, not a registry, IAM or permission manifest, and authorizes nothing. A Conglomerate is one tailnet of befriended Organizations (0224); the map of all of one person's Machines across those Organizations is a view without authority, ACL or registry, and Conglomerate stays retired as a product name (0128); a Conglomerate Host is the Machine that runs Headscale and Vaultwarden for one Conglomerate; a Lazurio Environment is what one Machine offers its agents: the selected profile, the Lazurio Folder and all available tools and sign-ins.

### 0145 — The Organization manifest compatibility window ends

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Amended:** by 0225 on 2026-11-01 · **GEN4 counterpart:** F12
- **Related:** 0026, 0031, 0042, 0167, 0225, F22

`company.gen3.json` is deprecated, and every Organization's target state is `lazurio.organization.json` alone, without a legacy projection. Each root moves through the states `legacy` (only `company.gen3.json`), `transition` (both files, the canonical one authoritative and the legacy one generated) and `current` (only `lazurio.organization.json`). A root in `transition` regenerates the projection and may remove it only after the finalization gate (`lazurio migrate organization-manifest --finalize`), once every mutation-capable reader and supported Machine has passed the reader gate. The contract belongs to Lazurio Platform (0225): its `docs/organization-contract.md` and its readers are the authority, its schema is written anew there, and the GEN3 Root's Core with its migrator and Machines follow that contract; no second schema or source of truth exists. In GEN4, Organizations in `transition` and `current` run their applications (0167).

### 0146 — Names and entry of hosted Environments

- **Status:** in force (amended by 0213) · **Applies to:** GEN3 and GEN4 · **GEN4 counterpart:** F11
- **Related:** 0021, 0041, 0144, 0153, 0213

Under an Organization there are three layers of names: a hosted work Environment (a workshop) serves each application at the root of its own hostname `<app>.<vm>.<org>.lazurio.io`, production applications for the Organization's users live at `<app>.<org>.lazurio.io` behind a fail-closed production gateway with Lazurio Auth sign-in, and productionspace repositories stay outside the scheme. No application is bent to live under a path: the bare `<vm>.<org>.lazurio.io` is a signpost that redirects `/launchpad` and `/<app>` to the matching hostnames, so links with a slash keep working. In the default tailnet mode a workshop is reachable only from the tailnet, where the Conglomerate Host resolves workshop labels by split DNS and the public production gateway refuses every name that is not a registered production application; an Organization in public DNS mode lets people reach its Environments from the internet through the server's entry, still only through their gateways with a Lazurio account (0213). Machine and production application labels share one namespace per Organization, come only from the Organization's merged Deployment Repo, collide fail-closed and rest for seven days after removal before they can be reused. Each hosted Machine has its own certificate whose private key never leaves it and its own sign-in session that never extends to another Machine or production application; single sign-on across boundaries comes only from the identity provider's session. The Machine's application catalog belongs to its user and is filled by the Launchpad, so adding an application, worktree or development server needs no Machines rollout.

### 0147 — A Team Environment acts on GitHub as Lazurio for GitHub

- **Status:** in force (target broker contract not yet built) · **Applies to:** GEN3 and GEN4
- **Related:** 0148, 0149, 0165, 0168, F31

A hosted Team Environment, a shared Machine owned by the Organization with no assigned person, has no human GitHub identity. It acts through the platform GitHub App Lazurio for GitHub via the Organization's token broker, which issues short-lived tokens scoped to one repository; the App's private key never lies on the workspace Machine, only in the broker and the hosting operator's custody. The target contract, one workspace per Team bound to an immutable GitHub Team ID, one broker credential per Team and a live check of the Team's repository grant at every token issue, needs a versioned broker change first and is not yet built; today's broker authorizes by workspace ID, its credential and repository IDs. A GitHub App per Team and a team GitHub user account were rejected.

### 0148 — Git attribution and publishing from a Team Environment

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-02, 2026-10-05 · **GEN4 counterpart:** F31
- **Related:** 0147, 0165, 0167, 0211

Commits from a Team Environment have `lazurio-for-github[bot]` as committer and the Team pseudo-identity `"<Organization> Team <slug>" <team.<slug>@<Organization domain>>` as author, set in the system Git configuration, and each carries the trailer `Lazurio-Workspace: <organization-slug>/<team-slug>`. Every change goes through a pull request opened by the bot with the label `team:<slug>` and a description header naming the Team. The agent acts under the Organization's brokered identity and never merges there, not even on an instruction in the chat: it asks the user whom to ask for Publication, requests that person's review, assigns them the pull request and hands over with an @mention, and whoever approves and publishes answers for the change. On GitHub Free this rule is held by process and the Organization's `AGENTS.md`, and on a paid plan by branch protection without bypass. A trailer naming the Environment (`Lazurio-Environment: <machine>.<org>`) is a direction that is not built yet (0167).

### 0149 — Live GitHub grants decide a Team's access to repositories

- **Status:** in force (per-token broker check not yet built) · **Applies to:** GEN3 and GEN4
- **Related:** 0147, 0155, 0186, F31, F33

The only live authority for a Team's access to modules and repositories is its current GitHub Team membership and repository grant. The broker is to check the immutable GitHub Team and the grant for the exact repository at every token issue and fail closed on divergence, so that a revocation on GitHub blocks the next token; this check is part of the target contract of 0147. The Dashboard may keep a desired Team-to-repository mapping as reviewed input for broker policy and changes grants with a person's rights (0186), but a mapping never grants or keeps access by itself and never becomes a second ACL. A shared Team Environment accepts incoming connections only from members of its live GitHub Team.

### 0150 — A new client Organization sets up its GitHub access baseline before the first Builder install

- **Status:** in force · **Applies to:** GEN3 and GEN4
- **Related:** 0093, 0141, 0143

Before the first Builder installation, a new client Organization sets up its GitHub baseline: Lazurio for GitHub has access to all repositories, the base repository permission is `none`, a GitHub Team `builders` whose full roster matches exactly the approved members holds the Builder role, and that Team has explicit WRITE on the canonical root and every active non-restricted repository. Neither the Team nor non-admin Builders get any grant on `infra` or another restricted or private slot, and a new regular repository grant is created in the same step that activates its slot. Before installation the Owner reads the live state back against the versioned manifest, and an `unknown` slot status, incomplete provider data or an extra or missing Builder blocks it. An Organization owner's effective access to restricted repositories is recorded as an owner-role exception, never as a Builder grant; GitHub stays the only access authority, and writes to the provider need the user's explicit mandate.

### 0151 — The default prompt for a new Builder machine is console-free

- **Status:** in force for GEN3 only · **Applies to:** GEN3 · **GEN4 counterpart:** F20

In GEN3 the default short prompt for a new Builder machine authorizes, for that installation session, the official installation of missing required tools, the platform's standard package manager and elevation, and the smallest necessary `PATH` change, but no upgrade of tools that already qualify and no general machine administration. The Task Agent runs every command itself and never hands terminal work to the person; the only human steps are native consent, GitHub's web authorization and, if needed, relaunching Codex. GitHub pairing uses the web device flow, and the agent may show the short user code only in the private chat, never the internal device code, tokens or keys.

### 0152 — Module data checkouts are filled in at installation and preparation

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-17
- **Related:** 0138, 0143, F34

An explicit `lazurio organization install` fills in an active declared `repository_db_mount` only at `mission-control/db` or the canonical `workspace/<module>/db`, below exactly one active and materialized parent repository; the deprecated `modules/<module>/db` is never materialized. The child remote must belong to the same GitHub Organization, branch and path must match the manifest exactly, ignore is proven in the parent repository, and role-scoped installs inherit the restricted boundary of parent and child. A module also fills in its own missing declared data checkout during its preparation before start or open, and a fresh installation fills it in together with its parent module, within the same limits and the user's live access. A clone never overwrites existing content (an empty folder counts as missing), an existing checkout is only verified, an empty remote is never created, and when filling in fails the start is refused with a clear reason. The general update and ongoing synchronization gain no authority from this.

### 0153 — One personal hosted Environment per person

- **Status:** in force (amended by 0207, 0210, 0216 and 0220) · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-26, 2026-10-31
- **Related:** 0089, 0091, 0154, 0155, 0207, 0210, 0216, 0220

A person has exactly one hosted personal Machine, their Personal Environment, counted from the moment one is assigned to them. Buddy belongs to it and runs inside it as part of the Personal Environment, not as a second host (0210). The person's own hardware stands outside the pool as a client and needs no name in `lazurio.io`. The reason is coordination: a Personalspace lies outside GitHub Organizations and has nothing to coordinate ownership, names or access of several hosted Machines with, so a second lasting Machine belongs to an Organization, where GitHub coordinates it, and a temporary need is met inside one's own Machine by a snapshot or by container or process isolation; a nested or short-lived virtual server is a Machine too and never becomes a second personal home. One personal boundary means one Machine and one hostname, so a Personalspace needs no label registry or Deployment Repo entry and the Conglomerate Host never reads the owner's personal repository. An Environment that belongs to a persona's account does not count as anyone's personal Machine (0220).

### 0154 — A personal Environment in a tailnet is reached only through its Conglomerate Host's Headscale

- **Status:** in force (amended by 0207 and 0216) · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-25, 2026-10-26
- **Related:** 0144, 0146, 0153, 0155, 0184, 0207, 0213, F16

A personal Environment in a tailnet is a node of the same Headscale tailnet of the Conglomerate Host in which its person works with their Organizations, registered under the person's own Headscale user, never an Organization's user or tagged devices. The person's laptop and phone therefore need one Tailscale client, and SSH, Codex and applications all go that way; the personal Machine has no public port, DNAT or per-Machine network resources, and no WireGuard tunnel or other second VPN is used. The pool operator's service access stays separate from the owner's access and does not depend on the owner's devices. A personal Environment without a tailnet, in public DNS mode, is reachable by people only on the web through the server's entry with a Lazurio account and without SSH, and whoever needs SSH gets a tailnet node under this rule (0207). The personal DNS slug is the person's login, captured and frozen when the Environment is assigned, while the Machine's technical name stays neutral.

### 0155 — Zones of access between one person's Environments

- **Status:** in force (access added by 0192 and 0224 is decided, not yet deployed) · **Applies to:** GEN3 and GEN4 · **Amended:** 2026-10-19, 2026-10-20, 2026-10-26, 2026-10-27, 2026-10-28, 2026-11-01
- **Related:** 0144, 0146, 0153, 0154, 0158, 0192, 0202, 0205, 0217, 0224, F16

One person's Environments and clients form a personal zone (own laptop, phone and the one Personal Environment) and a work zone (the Work Environments assigned to that person, also across several Organizations of the same Conglomerate, and an Organization's work laptop), and all of it holds inside one Conglomerate. Access between them runs only along defined, one-way edges (0224): the Personal Environment reaches the person's assigned Work Environments in the same tailnet automatically (0192); a person's Work Environment reaches the Team Environments of that person's Teams in the same Organization; an Admin's Work Environment reaches the other Environments of the Organization (0202); an approved device reaches its person's Environments; and an Environment reaches a specific computer only when that computer's Owner switches it on. No edge runs from a Work Environment to the Personal Environment, a person's own computer is reached only through the access its Owner switches on, Work Environments have no other grants between each other, and no edge is granted merely as the reverse of another: a path back exists only where its own fact derives it, as when two Admins of one Organization reach each other's Work Environments, each through their own Admin role; a shared Team Environment accepts only incoming connections from members of its live GitHub Team and has no outgoing grants. The relations `owner` and `operator` bind to immutable GitHub IDs, while the frozen lowercase login is only a network and DNS slug and a display name such as Henry is only a description. The Organization's `infra` repository is a readable blueprint listing Machines (owner, operator, zone) and rules from which exact per-Machine grants are generated, and a Personal Environment in a tailnet is managed by the Organization that owns that tailnet's Conglomerate Host, which gives it no right to read the Personalspace. The Conglomerate Host is administered by an Owner of the Organization that owns it, from the Owner's personal laptop and Personal Environment or a named administrative Work Environment (0202); the maintainers' development stations have a narrowly defined exception (0217).

### 0156 — The AI Colleague is retired; automated work runs in an Environment with a persona

- **Status:** in force (completed by 0169) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-21 (amended 2026-10-24)
- **Related:** 0092, 0094, 0169, 0170, F27, F30

The AI Colleague, an AI with its own seat and the powers of a person, is retired and removed from rules, manuals, skills, map and architecture; historical records keep the term. Automated work for an Organization is carried by a Work Environment set up to work on its own through bots, named Henry where it needs a name (0169, 0170), not by another seat. A persona is the name and character of the agents on a particular Environment, such as Buddy's persona on a Personal Environment or the Organization's persona Henry on its Environments. A persona is not a user, identity or authority, and on an Environment with a user the agents act for that user in that user's rights.

### 0157 — Entry to a personal Environment uses the same gateway, with a narrow exception for native T3 pairing

- **Status:** in force (amended by 0207, 0213 and 0214) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-22 (amended 2026-09-26 and 2026-11-01)
- **Related:** 0153, 0154, 0207, 0213, 0214, F11, F29

A hosted personal Environment uses the same standard gateway as a work Environment, one for the Launchpad, T3 Code and every application. Admission rests on a `groups` claim in the ID token that a client-bound mapper issues only for the Owner's immutable GitHub ID, and the session refreshes at least every two minutes, so a removed or unlinked person is refused on new requests and connections within two minutes (connections opened earlier are bounded by 0213). Only on the `t3code` hostname may the native T3 client reach, without the gateway, exactly `GET /.well-known/t3/environment`, `POST /oauth/token`, `GET /api/auth/session`, `POST /api/auth/websocket-ticket`, `POST /api/auth/websocket-ticket/rpc`, the CORS preflight `OPTIONS` of these five paths and the websocket `GET /ws` with a `wsTicket` parameter; T3's own pairing and session authorization and the tailnet rules protect them, and the exception is not widened without a new decision. This is a deliberate deviation from one admission gateway per Machine, applies to work and personal Environments and stays open for possible correction. In public DNS mode the native pairing exception is not offered (0207, 0213), and the Owner-bound sign-in client is created and removed by assignment in Lazurio Auth (0214). A wildcard certificate for `*.<login>.lazurio.io` writes the login into public Certificate Transparency logs, and people are told so during onboarding.

### 0158 — An Owner's device may sit in both zones

- **Status:** superseded by 0224 · **Applies to:** —

### 0159 — Temporarily free GitHub sign-in on single-person hosted Environments

- **Status:** in force (temporary; ended for Team Environments by 0168) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-25
- **Related:** 0147, 0165, 0168, 0192, F33

Until the Lazurio account in the Dashboard controls which GitHub account belongs to which Machine, the user of a hosted Work Environment or Personal Environment may sign `gh` in with any GitHub account. The assignment in `lazurio.machine.json` does not restrict the sign-in, neither the Launchpad nor an agent blocks on a missing, invalid or different assignment, and the Launchpad offers sign-out for any sign-in. On Team Environments the exception has ended and they work through the Organization's bot only (0168). The target is that an Owner or Admin sets the Machine-to-account binding in the Dashboard and the Launchpad, signed in with the Lazurio account, controls `gh` accordingly without a Machines rollout; GitHub stays the only access authority.

### 0160 — Remote Environment and Local Environment

- **Status:** superseded by 0170 and 0179 · **Applies to:** —

### 0161 — Remote Environment baseline versus the user's own tools; a rollout repairs, it does not hold back

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-09-26 (amended 2026-09-28, 2026-10-24 and 2026-10-30, and by 0166) · **GEN4 counterpart:** F17
- **Related:** 0144, 0164, 0166, 0171, F13, F14

The hosting baseline of a Remote Environment is what Lazurio Machines delivers under 0144 and what its pin holds even after the user breaks everything else: system, accounts and sudo, network and Headscale, the gateway with certificates and admission, the entry units (Launchpad and T3 Code), a working Lazurio of at least the pinned version, and the first installation of the user's tools in the standard path. The user's tools (Codex, Claude Code, `gh`, Node, npm, Bun and any other on their `PATH` and in their home) belong to the user, who updates them with the official installers; a rollout never downgrades or overwrites them, readback reports their versions as facts, no second rescue copy exists, and an agent updates them only on the user's explicit instruction in the thread, while a Bun that an application pins is that application's runtime rather than a user tool (0171). A tool's standard path is the first executable of its name in `~/.local/bin` on the user's `PATH`, linked or wrapped there from the installer's own home, with Lazurio itself in `~/.local/share/lazurio/` behind `~/.local/bin/lazurio`; system tools belong to the operating system, and T3 Code runs on the Node runtime of its own service. When the user breaks the environment so that agents stop working, a rollout restores only the baseline and reinstalls only missing or broken user tools into the same path with their official installer, never touching configuration, sign-ins or history; it starts no AI agent itself, and the rest is repaired by the rolling-out agent on its user's instruction, with the readback as its brief. Lazurio has one updater, `lazurio update`, which the user runs on a Remote Environment as on their own computer without a rollout; the hosting pin is a minimum that a rollout raises a Machine to and never lowers, and a newer version is a fact, not drift. After activating a new version, `lazurio update` refreshes the generated Folder files by itself, from the command line as from the Launchpad's Update button, and never shows that refresh to the user.

### 0162 — Integrations: applications connected to an Environment, one path each

- **Status:** in force (the Organization switch for ChatGPT apps and the Microsoft 365 settings are decided, not yet deployed) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-27 (amended 2026-10-02, 2026-10-08, 2026-10-09, 2026-10-13, 2026-10-14, 2026-10-17, 2026-10-19 and 2026-10-27) · **GEN4 counterpart:** F42
- **Related:** 0172, 0185, 0193, 0194, F18, F19, F44

An Environment mirrors its user: agents act wherever the sign-ins on that Environment reach, and whoever needs to separate contexts or access creates another Environment with other accounts. An Integration is an application or service connected to the Environment and has exactly one path: a tool from Settings → Tools made for that application (`gh` for GitHub is mandatory), directly through the Environment's Executor (a localhost-only MCP gateway that Lazurio installs and runs), or through Composio with the user's own account where the Organization allows it (a Team Environment signs in a team Composio account); agents use them in that order, and every agent and bot of the Environment gets all of them. Agents never connect an Integration themselves, because signing in is the user's consent: they send a link to its card in Apps → Integrations, and they add a custom MCP server to the Environment's Executor only on the user's explicit instruction. A connected application is available for reading, writing and deleting until the user narrows it, but the ability to write is no consent to Publication; new ChatGPT or claude.ai connectors, other shared brokers, scraping, cookie sessions and copying keys or tokens into chat, Git or logs stay forbidden, and ChatGPT apps, plugins and connectors in an agent's harness are off unless the Organization (on a Personal Environment, the user) allows them, and then only for applications outside the Integrations. Each user signs Composio in with their own account and works in a Composio organization of their own named after the Lazurio Organization (on a Personal Environment, the account's default organization); Lazurio holds no Composio organization key, creates no shared Composio organizations, and Composio holds the tokens and call contents of its connections. Company applications (Google Workspace, Microsoft 365) are an Organization-wide choice set by an Admin in the Organization's settings and then connect directly, and for Microsoft 365 the Organization registers one single-tenant public client application with delegated permissions, gives one consent on behalf of the organization, keeps no client secret and leaves sending mail off until it enables it.

### 0163 — Open questions go to GitHub Issues; review findings are taken with judgement

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-27 (amended 2026-10-28 by 0218 and 2026-10-30)
- **Related:** 0103, 0139, 0166, 0211, 0218

A Task Agent has a standing mandate to write an open technical problem, uncertainty or finding as a GitHub Issue in the exact owning repository, after checking for duplicates and sanitizing, without asking first, and the issue does not stop work that does not depend on it. Closing, assigning and prioritizing issues stay with the user, except where a decision gives a coordinator a standing mandate for a defined scope; closing an issue without a fix always needs a person's instruction, and nothing Organization-specific, secret or from a Personalspace goes into a public repository. An agent fixes a real defect found in review at once; to a trifle without impact, speculation about future change or a widening of the pull request's scope it answers with a factual objection and asks for a verdict on the unchanged head, and if the reviewer insists, it puts both positions to the user. Every reviewer, whether a person, a Task Agent or a bot, requests changes only for a real defect the pull request introduces or leaves (wrong behaviour, a broken or missing required check, contradicting texts, an unsupported claim, a security problem or a leak of sensitive content); everything else is a non-blocking note, and in doubt it does not block. A reviewer goes through the whole change once and puts all findings into one review split into blocking and non-blocking, a repeated review checks only the changes since the last verdict and the resolution of blocking findings, and findings go only to GitHub, with anything worth fixing outside the pull request filed as an issue. Review is never bypassed, an approval belongs only to the exact head, and merge, release and deployment stay Publication.

### 0164 — One standard installation; the move from the Root to the Folder is one-way

- **Status:** in force (amended by 0166 and 0168) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-28 · **GEN4 counterpart:** F20
- **Related:** 0013, 0030, 0129, 0136, 0142, 0166, 0167, 0168, 0219, F1, F21

Installations of the Lazurio Root repository as a checkout on a machine are to end: every Environment moves to a Lazurio Folder managed by the Lazurio Platform, and the Root repository is archived after the last migration. The migration is one-way: no path back is built or kept, and a failed migration is repaired forward in the Folder by an agent following the Folder's manuals and the prompt prepared for each platform. It does not touch the content of Organization repositories, the Personalspace or sign-ins, which keep their own Git history, and it runs on Linux (first Ubuntu) first, then on macOS, and on Windows only after a Windows build exists, while Root installations keep working unchanged until their turn. The first installation on a new computer is one command, `curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install | sh`, which installs the CLI and the Launchpad as one program, after which `lazurio update` takes over. Every platform has one standard layout (the product's install base, the `~/.local/bin/lazurio` command and the Lazurio Folder); the installer never silently overwrites what it does not own but reports the deviation, an agent straightens it on the user's instruction, and a deviating installation is not a supported variant. Until their migration, Root installations keep their own rules (0013, 0030, 0129, 0136), and the Root converges on the Folder's mechanisms (0219).

### 0165 — Kinds of Environment and their GitHub identity

- **Status:** in force (amended by 0168, 0170 and 0207; the Services Environment is decided, not yet deployed) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-28 · **GEN4 counterpart:** F28
- **Related:** 0147, 0153, 0155, 0159, 0168, 0170, 0207, 0209

People see three kinds of Environment: Personal (the person's one hosted Personal Environment), Work (an Environment of one person for work in an Organization, either a hosted Environment assigned to them or an Organization's work computer) and Team (a shared Machine of the Organization on which several members of a Team work). The person's own computer with a local Lazurio has no kind and is called "your computer" (0207), and the Organization's server services become a fourth kind, the Services Environment, decided but not yet deployed (0209). For a hosted Machine the kind follows only from `lazurio.machine.json` (`machine.kind: personal-vm` is Personal, `owner.assignment.kind: operator` is Work, `owner.assignment.kind: team` is Team), never from a name, hostname or Team size. On Personal and Work Environments the user signs GitHub in with their own account, which also links the Machine's SSH key. A Team Environment never signs in a person's account or links a personal SSH key: it works on GitHub through the Organization's Lazurio for GitHub App (0147, 0168), and the aim is that GitHub shows which Environment created a commit, pull request or issue.

### 0166 — No rollback; Recovery mode repairs forward

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-09-28 (amended 2026-10-14, 2026-10-15, 2026-10-27, 2026-10-31 and 2026-11-01) · **GEN4 counterpart:** F21
- **Related:** 0161, 0163, 0164, 0204, F13

Lazurio has no rollback: no `lazurio update rollback`, no retained previous version and no automatic switch back after an unhealthy restart, while atomic failure of a single operation, refusal before anything changes (verification, self-check and a trial of the candidate before the switch) and refusal to downgrade (floor and high-water mark) are not rollback and stay. After a switch to a new version the only way is forward: finish, repair or a newer release. When Lazurio is broken it offers only Recovery mode, an agent in the chat with the task to repair what is needed or an issue with everything the repair needs, and every entry into Recovery mode ends with an issue so that the repair becomes a regression test; the Launchpad always runs and in Recovery mode serves only this action. An automatic issue goes to the product's public repository with structured fields only (version, target, platform, identifiers of failed checks, unit state, Folder and template revisions) after a deterministic sanitizing gate; free text leaves the Machine only when the repair agent attaches it after reading it under the sanitizer, and the user sees the exact body that left. Lazurio Machines follows the same rule: an apply finishes or does not start and never returns to an earlier release as a repair. Releases ship in stages, and a release candidate becomes final when it runs healthy on the pilot Organization's work Environments and its users' personal Environments and one recorded end-to-end smoke test as a test account of the reference Organization gives it a green light, with no minimum observation window.

### 0167 — The Platform Launchpad replaces the resident Launchpad without overlap

- **Status:** in force (amended by 0179; the lease rules for previews are still a proposal) · **Applies to:** GEN4 · **Decided:** 2026-09-28 · **GEN4 counterpart:** F22
- **Related:** 0047, 0049, 0137, 0145, 0148, 0164, 0166, 0179, F8, F15

Completing the Platform Launchpad has top priority; the concepts of the resident Launchpad are rebuilt properly in it, CLI first (`lazurio module …`, `lazurio organization …`), without new state in the Folder. A hosted Machine switches in one Machines apply that removes the resident unit after read-only checks: no period with both Launchpads, no transition hostname and no way back, with Recovery mode (0166) released first. The first usable version targets hosted Remote Environments on Linux, in the first phase Ubuntu, with other distributions reported as unverified, and macOS and Windows follow, Windows only after a Windows build exists. Deliberately not carried over are a Git client in the browser, a Mission Control plan browser (Mission Control opens like any module), notifications, "most used" and recent changes; agents do Git in T3 Code with worktree discipline. The Platform Launchpad runs modules from `main`, on Linux as operating-system services, and a pull request preview on a hosted Environment gets a temporary Environment address registered as a lease that ends by itself; agents never send a person a localhost link. Organizations with only `lazurio.organization.json` run their applications, `launchpad.gen3.json` has no successor, agents clone Organizations into new work Machines until the Platform synchronizes content, and commits, pull requests and issues from a Team Environment are to carry `Lazurio-Environment: <machine>.<org>`, a direction that is not built yet.

### 0168 — A Team Environment works with the Organization's bot from handover; strict first-install command

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-09-28
- **Related:** 0147, 0159, 0164, 0165, F20, F22

A Team Environment works on GitHub through the Organization's bot (Lazurio for GitHub, 0147) right after handover, so no personal `gh` sign-in is needed there, and the temporary exception of 0159 has ended for it. Lazurio refuses a personal `gh` sign-in and the linking of a personal SSH key on a Team Environment and lets a personal account left from earlier be signed out. A Team Environment on which the broker does not run is a defect of Lazurio Machines to repair forward, not a reason to sign a person in: the agent offers no personal sign-in and records a blocker. For single-person Work Environments and Personal Environments 0159 applies unchanged. The documented first-install command has the strict form `curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install | sh`, which keeps even the download of the script itself on HTTPS with at least TLS 1.2.

### 0169 — Henry: automated work of an Organization runs as a bot team under a persona account, with a responsible user

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-29 (amended 2026-10-12, 2026-10-24 and 2026-11-01, and by 0170, 0181 and 0220) · **GEN4 counterpart:** F27
- **Related:** 0061, 0089, 0093, 0094, 0103, 0150, 0156, 0170, 0171, 0181, 0218, 0220

Automated work of an Organization is carried by an ordinary Work Environment of the Organization with automations, named Henry where it needs a name (0170); its user is an Owner or Admin of the Organization who sets the automations up, answers for them and holds the custodian role (0094); everyday collaboration with the persona goes through GitHub, and SSH into the Environment is only for service interventions. Its GitHub identity is a machine user account of the Organization's persona with 2FA, a member and never an Owner, different in every Organization; all tools, T3 Code and bots of the Environment act by its rights, which come through a Team `steward` with Maintain on all repositories except `infra` (including productionspace unless the Organization excludes it), while `infra` gets a direct Write only under 0093, and in `infra` the persona merges on GitHub Free only a pull request whose merge deploys nothing, assigned by another Admin with an independent approval, and never on a paid plan. The bots run in Lazurio MausBot, Lazurio's fork of OpenMausBot that is heading towards a full fork: a leader of the persona's name splits work among further bots (three by default), they start in the Lazurio Folder and follow Mission Control plans and worktrees, only the persona appears on GitHub, and a watcher without a model passes them only real work. Review runs on a pull request in Ready and on every new head, a valid assignee handover is itself the instruction to complete the pull request including an allowed merge, a review request alone authorizes no merge, and the persona's own pull requests are approved by a person (Owner, Admin or Steward), enforced by branch rules on a paid plan and by agreement on a free one. The bots use OpenMausBot memory separated per Organization (gbrain stays in the Personalspace) and take models from the Organization's AI pool (0181); a provider that manages client Organizations without their own server has a separate persona that keeps one isolated team per client Organization on Henry's preset. The persona never runs an apply, issues a Release or changes access, secrets or billing, apart from narrow exceptions that a decision records for a provider persona; Hermes is reserved for Buddy and for a persona's own agent under 0220, and Buddy may configure bots in Environments his user can reach when a mandate allows it, while new secrets and access changes still need consent to the specific operation.

### 0170 — Towards people the place they work in is the Environment (Czech: Prostředí)

- **Status:** in force (the Services Environment is decided, not yet deployed) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-29 (amended 2026-10-15, 2026-10-19, 2026-10-21, 2026-10-28 and 2026-10-29) · **GEN4 counterpart:** F28
- **Related:** 0128, 0160, 0165, 0169, 0175, 0199, 0207, 0209

Agents, application texts, human-readable command output and generated instructions call the place where a person works an Environment, and a hosted one a Remote Environment; Machine, VM and server are never used to name it towards people, while exact terms such as MCP server or development server stay. In Czech the word is Prostředí, with a capital P and neuter gender and the kind given as an attribute (Osobní, Pracovní, Týmové Prostředí); a hosted one has no proper name in Czech and, where it must be told apart, is described as "Prostředí na serveru", never "Vzdálené Prostředí". Machine stays the precise technical and architectural term for the boundary an Environment runs on, in identifiers, keys, commands such as `lazurio machine …`, schemas, custody records, decision records and `ARCHITECTURE.md`, and rules for agents may use the technical term Environment. There is no separate automated kind: an Environment with automations is an ordinary Work Environment, named Henry where it needs a name (for example `henry-01`), only the Environment of a provider persona carries that persona's name, and machine values such as `automated` are not renamed. In texts for people the product is Lazurio (Launchpad and Dashboard are internal names, and the target is named Apps, Organization overview or Settings), an Organization is called an Organization and not a company, Czech uses the standard demonstratives tento, tato and toto, and the person an agent talks to is the user (0175). The Organization's server services become a fourth kind, the Services Environment, decided but not yet deployed (0209).

### 0171 — Lazurio Module Standard

- **Status:** in force; in GEN4 the restart backoff and the refusal `module-nonconformant` are not implemented · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-09-30 (amended 2026-10-13, 2026-10-24 and 2026-10-28, by 0195 and by 0225 on 2026-11-01) · **GEN4 counterpart:** F34
- **Related:** 0026, 0041, 0161, 0173, 0174, 0195, 0225, F25, F26, F52, F62

The Launchpad implements no workarounds for deviating modules; all modules and Organizations converge on one maintainable standard, whose full text and authority is `docs/module-standard.md` in Lazurio Platform since 0225, together with its Organization contract: TypeScript strict, a single-process start, a declared preparation, a closed runtime environment, the repository boundary, disjoint port pools and the canonical Organization manifest. The stack is Vite, React and TypeScript for interface and data applications, Astro for websites and knowledge bases and Bun for services, with `@lazurio/module-kit` as the only runtime library of a module and Python modules through `uv` under the same contract. The Launchpad prepares before start, runs a closed environment, supervises with a bounded backoff (1 s, 5 s, 30 s, then `failed`) and treats an occupied port as the module's error; opening a module from `main` runs its built version while a worktree preview runs `dev` (0195), and after the cutover a non-conforming module is refused as `module-nonconformant`. A module keeps at most two App generations, `lazurio module setup` (checks `MS-01` to `MS-14`) and the doctor check conformance, and a person's own module is created with `lazurio module create personalspace/<slug>` as a private repository on their own account; module generation moves into the Platform as the single generator, and the Root's scaffold stays the generator of the Organization shape until that shape has moved too. The Bun an application pins exactly in `package.json#packageManager` is that application's runtime: Lazurio uses the user's Bun when it matches, otherwise a verified copy from its runtime cache or the official npm distribution with its integrity checked, never silently another version, and an Organization's Henry may converge pins up to Lazurio's default version and merge patch and minor bumps itself on green CI with a fresh independent approval, while a major bump goes to the Organization's Owner. Repositories created from Lazurio templates run all gates on Linux for every pull request and push to `main`, and run Windows and macOS only for pull requests that change code, migrations, toolchain or workflows, or on demand.

### 0172 — Agents work with full access; the Environment is the boundary

- **Status:** in force (the full-access default for every MausBot bot is decided, not yet deployed) · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-01 (amended 2026-10-19 and by 0210)
- **Related:** 0091, 0103, 0153, 0162, 0169, 0210, F14

Task Agents in T3 Code, Codex or Claude Code and the bot teams of Lazurio MausBot work in an Environment with full access: commands and changes inside the Environment run without a sandbox and without per-command approval, by default and without anyone switching it on. Narrower rights are never made with a sandbox or approvals inside an Environment but with a separate Environment that really has fewer capabilities: another Machine, other sign-ins and other GitHub grants. Access is not divided inside an Environment: wherever it is signed in (the Environment browser, tools and Integrations, CLI sign-ins) every bot, agent and chat reaches, and MausBot has no per-bot switches for applications, MCP servers, keys or sign-ins. A task that explicitly wants a sandbox gets a working one, and whoever wants to supervise particular work may choose that supervision themselves. Full access is a capability, not consent: Publication still belongs to the user (0103), writes to connected external applications keep their own gates, and the Personalspace and cross-Organization isolation still apply (0091). Buddy also works with the full rights of the Personal Environment (0210).

### 0173 — An agent does restructuring by a guide; scripts only add new things or take simple steps

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-02
- **Related:** 0112, 0132, 0171, F14

Where an old structure is discarded or rebuilt (a module brought to the standard, an App generation, a data layer, a moved port, a changed file layout), the Task Agent and its subagents do it as a reviewed refactor, one unit per pull request, and Lazurio builds no script or mechanism that performs the conversion by itself. A script may only add something missing that can be written unambiguously, or take a straightforward deterministic step without edge cases; once a step has edge cases, changes existing files based on their content or assumes how foreign code is built, it is a refactor and belongs to an agent. A conversion ships a guide for the agent with full context (why, the target design, the procedure, what done means and how to verify it) and checks that read and report findings with the next step; an agent may write a one-off script for bulk data in its own pull request, prove it with a parity check and delete it afterwards. A button in an application may start an agent with the guide or show the person instructions to paste into the chat. When an Organization needs an update, conversions are done at once as parallel pull requests that bring the Organization in line as a whole, while creating something new from a template, `lazurio update` and deterministic generation from one source are not conversions. A subagent's output is no proof: the delegating agent reads the diff and runs the checks itself, and Publication still belongs to the user.

### 0174 — A repository created from a template keeps its lineage through merge commits

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-02
- **Related:** 0077, 0171

A module or Organization-level repository created from a Lazurio template allows merge commits on GitHub next to rebase. A template synchronization is a pull request whose head contains the exact template commit as an ancestor; a repository without shared history first imports it on the pull request branch (a merge with `--allow-unrelated-histories`, with the `ours` strategy for identical content) without rewriting the protected `main`, and the pull request is merged with a merge commit. If the ancestor is missing or the repository does not allow merge commits, the agent does not merge and reports it. Whoever creates a repository from a template allows merge commits at creation, because squash or rebase rewrites the template's commits and loses the merge base. Protection of `main`, review before Publication and rebase as the default for repositories not created from a template stay.

### 0175 — The person agents work for is the user

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-02 (amended 2026-10-21) · **GEN4 counterpart:** F30
- **Related:** 0060, 0062, 0094, 0112, 0130, 0170, 0192

Whoever controls an Environment controls the agents started in it: the agents act for that person in their live rights, the person gives the instruction to publish and has the last word, and this person is always a human. Rules for agents, manuals, skills, product texts and command help call this person the user, replacing the earlier words Operator and Principal and, in this sense, person and people. On a Personal Environment the user is its Owner, on a Work Environment the person the Organization assigned it to, on a Team Environment the connected Team member with rights, and on Henry the responsible Owner or Admin of the Organization (0192). A colleague (Kolega) is a user in an Organization, the Personalspace and Buddy belong to the person who owns the Personal Environment, and the hosting operator is a different role. The Organization role User (0060, 0062) is a different concept from the general user and texts tell them apart where they meet, and decisions are attributed to whoever made them, not to a role. Identifiers and machine values (for example `operator`, `owner.kind: "principal"` and `task_agent`), verbatim quotations and the titles of historical decisions are not renamed.

### 0176 — Modules sit side by side in `workspace/`; an App reads a declared sibling only as `../<slug>/`

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03 (amended 2026-10-10)
- **Related:** 0041, 0146, 0171, 0173, 0195, F26

An Organization's Modules always sit side by side in its `workspace/`, and when one Module depends on another, both must be present on the Environment. An App declares such a neighbour in `lazurio.runtime.required_module_slots` of its `package.json` (the slot `workspace/<slug>` or its data mount `workspace/<slug>/db`) and at run time reads it only as `<own Module root>/../<slug>/`, that is its `db/` data mount and generated read models, never its code or any manifest; an App never writes outside its own Module. A declared neighbour that is missing beside the running checkout (not materialized, a `planned_slot`, or absent next to a worktree) makes the App not runnable there: the Launchpad refuses the start with a typed readiness finding before installing dependencies, and the doctor reports it. An App may call the API of a sibling it declares as a Module slot: at every start the Launchpad passes `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN`, the loopback origin of the sibling's default App, only for a declared sibling of the same Organization that lies beside it; the App reads the address only from that variable and never hands it to the browser, a stopped sibling refuses the call and the App tells its user, and without the variable the App never guesses a port. A link for people to the sibling is derived only from the App's own external origin with the sibling's hostname label, and where that origin is not passed, no link is drawn. Who may start a Module follows the Organization manifest and GitHub grants, not a Team identity, and the Module Standard checks (`MS-06`, `MS-09`) enforce these limits.

### 0177 — Secrets an App needs at start come from the Environment vault, never from `.env` files

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03 (amended 2026-10-09, by 0198 on 2026-10-13 and by 0203 on 2026-10-15)
- **Related:** 0171, 0172, 0193, 0196, 0198, 0203, F46

An App declares only the names of the secrets it needs to start, in `lazurio.runtime.secrets` next to its listeners (names matching `^[A-Z][A-Z0-9_]*$`, each listed once, never values); a capability that only some Environments have is declared in `optional_secrets` (0196). Before every start the Launchpad reads each declared name from the Environment's vault and passes the value into the App's closed process environment as `LAZURIO_RUNTIME_SECRET_<NAME>`; nothing else from the vault reaches the App, and values never go to logs, diagnostics or files. A required secret that the vault lacks or holds more than once, or that the Environment cannot read, is a typed readiness finding that names the secret without its value, the App does not start, and the App itself also reads the variable fail-closed. `.env*` files on the start path remain a Module Standard defect, Bun Apps start with `--no-env-file`, and an App never keeps secrets in its own state files. A secret needed only by a manually run script is not declared: the script reads it from the Environment's vault itself, and the Module's README describes the step. Since 0198 and 0203 the vault is the Environment's own vault, which on a personal Environment lives in the person's own Bitwarden and also serves Personalspace Modules.

### 0178 — Agents check in a browser what people will see; no automated rendered-page test

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03
- **Related:** 0103, 0191, 0223, F14

For a change to a UI, a sign-in page, a sign-in flow or a deployed application, the agent that prepares the pull request checks the result in a browser before marking it Ready, and the agent that Publishes it checks it again after deployment. The check confirms that the page really renders and its main path works; sign-in is tested with a test account that the person or the Organization designated, and without one the agent asks the person to sign in once, because a Task Agent neither has nor creates an account of its own. Checks with a test account run in a separate browser with its own temporary profile, never in the shared Environment browser (0191, 0223). The result, or the check that is missing, goes into the handoff's Verified section. Lazurio builds no automated rendered-page test, such as a headless browser in CI, for how a page looks; tests keep holding the contract of behaviour. The rule applies in the root and in every Organization.

### 0179 — One Lazurio shell: a rail and the Chat · Apps · Automate switch, no top bar

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-03 (amended the same evening, by 0185 on 2026-10-04, by 0200 on 2026-10-13 and by 0208 on 2026-10-18)
- **Related:** 0160, 0165, 0167, 0170, 0180, 0185, 0187, 0200, 0208, F32, F36

Lazurio has one shell without a top bar: a rail on the left and, at the top of the app's full-height left column, the app switch Chat · Apps · Automate, where Chat is T3 Code, Apps is the Platform's Launchpad and Automate is MausBot; the Dashboard is not in the switch and opens from the Lazurio logo. The rail, the column header, the app switch and Buddy's bubble are web components that every app, the T3 Code and MausBot forks included, loads from the Environment's `/.lazurio/shell.js` with data from `/.lazurio/shell.json`, and outside Lazurio they draw nothing. An Environment's settings have the sections General, This Environment, Tools and Recovery, and dedicated servers are never Environments: only the Owner sees them, under the Organization's infrastructure settings. Apps show two sections: Workspace, with every Module of the Organization that the Environment's GitHub identity can reach, each once and in manifest order, without Team groups, Team labels or access-request tiles, and Productionspace, with the Organization's production repositories read-only. One sign-in session holds across the Dashboard and the Environments, and a Lazurio Organization is a GitHub Organization with the Lazurio for GitHub app installed, not merely one with a manifest. Since 0185 the rail switches spaces and the Environment is chosen in the column header, and since 0200 and 0208 Chat is the Lazurio T3 Code distribution and both forks follow the Environment's theme while keeping their own brand.

### 0180 — Buddy is a floating chat on every Lazurio page, not an app, mode or tab

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03 (amended 2026-10-18 and by 0210 on 2026-10-19 and 2026-10-20)
- **Related:** 0089, 0153, 0169, 0175, 0179, 0199, 0207, 0210, 0224, F56, F60

Buddy is the person's personal representative, not a Task Agent, an app, a fourth mode of the app switch or a bot: Buddy acts for the person within their rights and mandates, holds the person's authority toward agents and enters the person's Chat threads only at the person's request (0210), while mandates toward other people and transaction-specific steps follow 0089. Buddy is a floating chat at the bottom right of every Lazurio page (the Launchpad, Chat, Automate and Module apps, but not the Dashboard, which has a neutral Lazurio helper instead), served by the person's Personal Environment, in which Buddy runs. The host tells the bubble where the person is asking from (the Environment and its kind, the Organization, the app and the page) but gives it no token, Buddy gets a screenshot only when the person shares one, and Buddy keeps an Organization's data apart from the Personalspace and never carries it into another Organization. Buddy's mandates, channels, memory and journal live in Settings → Buddy of the Personal Environment, where mandates can be revoked; a new or broader mandate is confirmed in the Dashboard with the Lazurio account and a fresh verification such as a passkey or a new sign-in, while refusing or revoking needs none. Buddy is also the guide to Lazurio: the "?" at a page title lets Buddy explain the page in place, the host's shell draws the figure and highlights, and Buddy's frame may only request an explanation by its id, never sending content or data. Where a person has no Personal Environment, or Buddy cannot reach the Environment a page belongs to, a neutral Lazurio guide takes Buddy's place.

### 0181 — An Organization's AI pool holds the AI subscriptions its Environments use

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-03 (amended by 0209 on 2026-10-19)
- **Related:** 0061, 0155, 0169, 0201, 0204, 0209

An Organization can serve its Environments' AI through an AI pool, a proxy that holds AI subscriptions in one place and shows the subscriptions of several providers together. Each Environment uses the subscription assigned to it (a Work Environment its person's, a Team Environment one subscription for all its people, an Environment with automations its own), and Lazurio itself supplies no LLM account: subscriptions come from the Organization and its people (0061). A pool serves only its own Organization and its members, so data, access and billing stay separate even when Organizations share a Conglomerate. There is no per-Environment pool key: since 0209 the pool is a service of the services Environment on each of the Organization's servers, and Environments on the same server reach it over the server's internal network as the Organization's deployment repository permits. Only Owners and Admins manage the pool, never a Team, because it holds the sign-ins of every member's subscription. The proxy is a public fork that runs as a service in its own container on that services Environment, not as a Module the Launchpad starts.

### 0182 — A device is a client or a server, never both

- **Status:** in force; point 3 is replaced by 0224, decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03 (amended by 0224 on 2026-11-01)
- **Related:** 0155, 0158, 0160, 0224, F16

A device is either a client or a server, never both. A device configured as a server is as a whole the boundary of the Environment it carries, so the Linux VM that holds the Environment may see its host. A physical laptop may carry an Environment as a Linux VM (for example OrbStack on macOS or WSL2 on Windows) with USB passthrough for peripherals such as phones and development kits, and is then no longer a personal client laptop. An Environment reaches a person's device only under the device-access rule of 0224: SSH to a specific computer, turned on and revocable by that device's owner, per device.

### 0183 — The Conglomerate view only shows; access rules change by pull request; Lazurio generates the SSH configuration

- **Status:** in force; the amendment of 2026-11-01 is decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03 (amended by 0192 on 2026-11-01)
- **Related:** 0144, 0155, 0184, 0192, 0205, 0224, F16

The Conglomerate view in the Dashboard only shows and is never an authority or a registry (0144); since 2026-11-01 it is a diagram derived from Environment assignments, approved devices and live Admin roles, showing people, their devices, the Environments of each Organization, the access between them and connected apps. Rules of access, meaning who may approve and where an approved device reaches, change only by a reviewed pull request to the host owner's deployment repository, which the Dashboard may later open on a click for people with the right to do so. Single device approvals are not pull requests: the Admin approves or removes a device in the Dashboard through a service on the Conglomerate Host, a person may remove their own device, and each approval is recorded into the repository automatically as an audit entry without review. Lazurio adds no `lazurio ssh` wrapper; it generates a standard OpenSSH configuration (`~/.ssh/lazurio/config` with host keys pinned from the machine records and one `Include` at the top of `~/.ssh/config`), so plain `ssh` works and aliases are output, not source.

### 0184 — Tailnet by people: one network user per person, created by signing in with the Lazurio account

- **Status:** proposed; partly replaced by 0192; the amendment of 2026-10-23 is decided; not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-03 (amended 2026-10-23)
- **Related:** 0153, 0154, 0155, 0183, 0192, 0213, 0217, 0224, F40

In every Conglomerate tailnet a person belongs to, they have exactly one Headscale user, created when they first sign in with their Lazurio account; shared Organization users and Headscale users for Linux admin accounts end, and a user name grants nothing. Environments keep joining with one-time tagged pre-auth keys whose tags only the admin layer owns, and a Personal Environment stays under its owner's personal user. Only a person whose linked identity is a live member of an Organization the Conglomerate serves may join, and the amendment of 2026-10-23 makes the Conglomerate one trust boundary of its founders: a member of any Organization it serves can sign in without being a member of the Organization that owns the host, while signing in alone opens no network access. Device approval and grants stay with each Organization's Admin (0192), the Environment's gateway still decides entry, and administration of the host comes only from specifically approved devices of people with a live Owner role, never from a network user, tag or membership. Existing nodes move to personal users through a one-time reviewed adoption without re-pairing. No tailnet uses this sign-in yet.

### 0185 — The shell's second iteration: the rail switches spaces and the column header chooses the Environment

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-04 (amended 2026-10-06, 2026-10-08, 2026-10-09, 2026-10-13 and 2026-10-18)
- **Related:** 0146, 0162, 0170, 0171, 0179, 0180, 0186, 0187, 0207, F36, F42, F52, F53

The rail switches spaces: from the top the Lazurio logo (Dashboard), search (⌘⇧E / Ctrl+Shift+E), the person's personal space when they have a personal Environment, and the GitHub avatar of each Organization, with only the account at the bottom; it holds no Environment icons, and a click on an Organization returns to its last-opened Environment in the same app, otherwise to its first one, or to its Dashboard when it has none. The Environment is chosen in the header of the app's left column, above the Chat · Apps · Automate switch, where the picker shows the Environment's name and whom it serves, with a gear beside it for exactly that Environment's settings; Environment names say what each is for (Team and name, Work, the persona's name, the computer's name, Personal), never VM, and the machine's technical name appears only in settings, diagnostics, the server list and its address. The selected state is a quiet, slightly darker surface with a checkmark rather than the Organization's colour, and the rail is a narrow column whose items share the same rounded corners. Apps open in the last-used Environment, and the Apps column holds All modules, Files, Integrace and Trezor (Trezor only where the Environment has a vault); a Module tile shows an icon, name, short description and a favourite star, and its menu offers Add to favourites, Module information and, for an Organization's Admins and Stewards, Module access in the Dashboard (0186). The last Workspace tile, "+ New module", appears only where the Environment's real GitHub identity may create repositories in the Organization, and always for the verified holder of a personal space; it opens Chat with a prepared, unsent prompt that creates the Module with `lazurio module create` under the Module Standard. Until self-service creation is ready, the rail offers no "+" for adding a space (F36).

### 0186 — A Team's access to a Module is the live GitHub grant

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-04
- **Related:** 0023, 0041, 0185, 0194, F37

Which Teams reach a Module is decided by the live grant on GitHub; `teams` in the Organization manifest is only the default when a Module is created (`lazurio module create --teams`) and a layout declaration, not an access authority. The Dashboard changes the grant (Organization settings → Modules, or Module access from Apps) with the acting person's own rights through a narrow GitHub app, Lazurio Administration Access, whose one-time user token it discards after the change, so GitHub's audit names the person and neither the Lazurio for GitHub app nor the Team broker can change access. A Steward's switch is a request that an Admin approves, and an Admin's switch is its own approval. The shell writes the person's favourite Modules and last Environment to their Lazurio account through the Environment's gateway with the person's token, limited to a fixed list of paths under `/.lazurio/account/`; the Dashboard knows which Environment asks from a signed token, never from a header, and the Launchpad, apps and agents never see the token. Several Environments of one Team are named in order of creation (Team <name>, Team <name> 2 and so on), and an Organization's Admin may rename any Environment.

### 0187 — Shell colours come from the app the shell sits in

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-04 (amended 2026-10-17, by 0200 on 2026-10-13 and by 0208 on 2026-10-18)
- **Related:** 0179, 0185, 0200, 0208, F36

The shell has no palette of its own: the rail, the column header, the Environment list and the account menu take their colours from the app they sit in, which passes colour roles as `--lazurio-*` CSS variables on its document, and where a role is missing the design system applies. Shapes, type and the rule for the selected state (a quiet surface with a checkmark) always come from the design system, and the Lazurio logo in the rail sits in a white circle so that it shows in every theme. A thin line separates the rail from the app's column in every app, drawn by the rail in the app's `--lazurio-line` colour, and each column starts with a bar holding the left-panel toggle and the app's name, then the Environment picker with its gear and the Chat · Apps · Automate switch. Since 0208 the Environment has one colour theme, chosen in Apps → Settings and taken over by Chat, Apps and Automate; a different theme chosen inside T3 Code or MausBot stays a personal exception, and each person chooses light or dark mode.

### 0188 — The first start of an Environment: a tour of the real interface, content by kind and repair in Chat

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-04 (amended 2026-10-08, 2026-10-09 and 2026-10-30, and by 0201 on 2026-10-14)
- **Related:** 0091, 0153, 0162, 0169, 0181, 0185, 0201, 0212, F9, F27, F36

Someone opening their Environment for the first time (personal, work or their own computer) gets a tour of the real interface, a ring around an element with a short bubble while they click themselves, and since 0201 the Začínáme (Getting started) page in Settings shows the basics until they are done: AI first, then GitHub, then content. While GitHub or content is missing, a one-line banner in Apps and in the shell's column header, and so also in Chat and Automate, leads to Settings and starts the action there. Content follows the kind of Environment: a personal Environment holds only the personal space, a work Environment only its Organization, the person's own computer its Organizations and the personal space; Team Environments and the server's services Environment are prepared by hosting, while an Environment with automations goes through a Work Environment's first start and signs in to GitHub with its persona's account, never with the account of its responsible person. The Organization is installed by `lazurio organization install <login>` with the person's live role verified on GitHub (Builders and Stewards skip Admin-only slots, and an unverifiable role stops the install) and the personal space by `lazurio personalspace install`; the Launchpad calls the same core, and installing content is never part of a product update. When preparation stops, the repair button opens Chat through a link that carries only the name of a prepared prompt whose text the same Environment's Launchpad supplies, and Chat opens a new thread in the Lazurio Folder that the person sends. Texts are short and non-technical, tools show their real names with one line and Connected or Not connected, apps are connected on the Integrace page, and a connected tool is turned on for agents automatically.

### 0189 — Chat starts in the Lazurio Folder; a handed-over prompt carries no model

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-04 (amended 2026-10-05)
- **Related:** 0167, 0185, 0210, F51

Every thread that the Launchpad, a guide or a prompt opens in Chat starts in the project of the Environment's Lazurio Folder, not in an Organization's root or a Module; the prompt names the Organization (name and GitHub login) and the work, and the agent sets its scope from `AGENTS.md`. A prompt handed over by link carries only text and folder, never a model or reasoning effort, and T3 Code opens such a thread with the default model from its settings. The Platform keeps the recommended default model for each signed-in provider in one place and ships it with every release, so changing the recommendation is one pull request and one release. It writes the default only when none is set or when the setting still holds exactly the value it wrote last, so a person's own choice is never overwritten; someone who picks exactly the recommended model is treated as following the recommendation. `lazurio doctor` warns when the default model is older or weaker than the recommendation or when its provider is not signed in on the Environment.

### 0190 — Rebuilding the Dashboard's interface on the Platform's stack

- **Status:** in force · **Applies to:** internal (LazurioDevelopment) · **Decided:** 2026-10-05

The full decision is internal to the LazurioDevelopment Organization.

### 0191 — The Environment browser: one Chromium per Environment with shared sign-ins, seen in the right panel

- **Status:** in force; the web desktop for people and the move of MausBot's bots into the Environment browser are decided, not yet deployed · **Applies to:** GEN4 · **Decided:** 2026-10-05 (amended 2026-10-06, 2026-10-09, 2026-10-11, 2026-10-12, 2026-10-18, 2026-10-19, 2026-10-21 and 2026-10-26)
- **Related:** 0103, 0162, 0172, 0192, 0195, 0198, 0200, 0216, 0223, F38, F39, F47, F50, F57, F59

Every Remote Environment runs one Environment browser, a Chromium with one persistent profile on the Environment's single screen; its sign-ins are a capability of the Environment, shared by all threads, agents, bots and Buddy and not separated inside it, so whoever needs other sign-ins gets another Environment, and personal matters and their sign-ins belong only in the personal Environment. Agents drive it with the `agent-browser` CLI in windows of their own thread or bot and release a window when done instead of closing tabs for everyone, and where the Environment has a vault, the browser's Bitwarden extension draws on it. People see it in the view behind the Environment's gateway, where one tab of theirs is one remote tab, in the right panel of T3 Code, the Launchpad or MausBot rather than as a fourth app mode, or in ChatGPT Desktop, a browser tab or a phone; agent and person work in the same tab at once, the agent shares the link to its own tab, and every view shows which Organization and Environment it belongs to. The Environment browser never holds a sign-in to Lazurio itself (account, Dashboard, vault web or other Environments), which opens only in the person's own browser, while the Environment's own apps open in it without signing in, and checks as a test persona use an isolated browser of their own (0223). Agents and bots also work on the Environment's screen through Computer Use, one at a time, while a web desktop on which people can watch them is a later wave. A Work Environment is never handed to another person; after an export period it is removed.

### 0192 — Entry with a Lazurio account and an Admin-approved device; sharing inside the Organization

- **Status:** in force as the target model; the transition is not complete, and the amendments of 2026-10-26 and 2026-11-01 are decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-06 (amended 2026-10-06, 2026-10-07, 2026-10-26 and 2026-11-01, by 0213 on 2026-10-24 and by 0224 on 2026-11-01)
- **Related:** 0091, 0155, 0172, 0175, 0182, 0183, 0184, 0202, 0213, 0215, 0216, 0224, F40, F49

Entry to an Environment needs three separate conditions: the network (Tailscale on the right Headscale tailnet from a specific device that the Organization's Admin approved), active membership of the target Organization, and a concrete grant to the whole Environment or to one app; an Organization in public DNS mode (0213) drops the network condition and device approval. People need no GitHub account to enter, while GitHub remains the authority for repository capabilities and Publication; Lazurio Auth holds accounts, membership and grants, the Dashboard manages them and the infrastructure enforces technical limits, and for accounts linked to GitHub, live membership of the GitHub Organization still mirrors membership of the Lazurio Organization. The assigned person may share their whole Work Environment or selected apps with active members of the same Organization without another Admin approval and never with an outsider: full sharing is knowing trust that includes the person's sign-ins and remote access, an Environment holding several Organizations' data may be shared in full only with a member of each, and app access never includes the Environment's browser or desktop. Reach between people, devices and Environments is derived from one truth (assignments, approved devices and live Admin roles): an approved device gets HTTPS and SSH to its person's Environments, a phone HTTPS only; a Personal Environment, which is not a device, always gets SSH to the Work Environments assigned to its owner in the same tailnet; and an Admin's administration station reaches colleagues' Work Environments in the same Organization, with no edge in the opposite direction (0224 lists every access). Every SSH edge between Environments needs both the network grant and the source Environment's own key, which the target accepts only from the source's address and for the assigned account, and both appear and disappear with the facts they derive from. The source gets each target's host key from the records of the Organization that owns the target, never from the first connection; a changed host key stops the connection until those records confirm it; and no edge between Environments forwards the agent or ports, so no path leads back from a Work Environment into a Personal one. The Admin approves or removes a device in the Dashboard through a service on the Conglomerate Host within tens of seconds, a person may remove their own lost device at once, every action is audited, and the Personalspace stays private.

### 0193 — Each Environment has its own vault identity; its agents use what is shared with it without asking

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-08 and 2026-10-09 (amended 2026-10-11, by 0197 on 2026-10-12, by 0198 on 2026-10-13 and by 0203 on 2026-10-15)
- **Related:** 0162, 0172, 0177, 0191, 0197, 0198, 0203, F43, F53

Every Environment has its own identity in the vault, separate from any person's account, used by its agents' `bw`, by the Launchpad for Module secrets (0177) and by the Bitwarden extension of its browser; since 0198 and 0203 that identity owns the Environment's own vault in its Organization's Lazurio Vaultwarden, while a personal Environment uses the person's own Bitwarden. Whatever is shared with the Environment, all its agents and bots may use without asking; a write visible outside remains the person's Publication, and values never go into chat, Git, logs or pull requests. The Launchpad keeps one unlocked `bw` session for the whole Environment, which an agent takes with `lazurio vault env`; agents never run `bw login`, `unlock`, `lock`, `logout` or `bw config`, because that would end the session for the others. Agents with full access can read the vault's secrets, so what binds them to the Environment is what is shared and its revocation: removal takes effect at once, but what the Environment already downloaded stays, so important passwords are changed after a revocation, and the right to edit includes deleting. Remote Environments come first; the person's own computer with several Organizations and vaults gets vault accounts in a second wave.

### 0194 — Organization settings are code in the Organization's repository, delivered to its Environments

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-09
- **Related:** 0047, 0149, 0162, 0186, 0192, 0198, 0203, F45

Settings that hold for a whole Organization (rules, default tools, Integrace, company apps) live in a schema-checked section of its manifest, `lazurio.organization.json`, in its repository, while people, membership and grants live in Lazurio Auth, secrets only in the vault (settings refer to them by name) and infrastructure in the deployment repository. The Dashboard keeps no copy: it shows a change as an exact edit of the file, the Admin approves it, and the Dashboard writes it to GitHub with the Admin's own rights, reads it back and audits it; agents propose settings changes as pull requests for an Admin to approve, and the Admin's approval is the Publication. An Environment asks the Dashboard through its gateway, with its own identity, what applies to it (every two minutes, when the Launchpad opens and on Refresh), applies it itself and repeatably, and reports which version it applied and how each item ended; a local installation reads the same document from Git, and nothing is pushed into Environments. Without an answer an Environment keeps the last applied version, invalid settings are never delivered and are shown to the Admin, and whatever an Environment cannot apply it reports for an agent to fix. On an Organization's Environments (work, Team, automated) the Organization's settings take precedence over the Environment's own and the Launchpad says so at the switch, while personal Environments govern themselves; the first such setting is whether Composio may be used.

### 0195 — An Environment under full memory slows down but does not freeze

- **Status:** in force · **Applies to:** GEN4 (the Module build rules also GEN3) · **Decided:** 2026-10-10 (amended 2026-10-11, 2026-10-12, 2026-10-20, 2026-10-21 and 2026-10-26, and by 0212 on 2026-10-24)
- **Related:** 0171, 0173, 0176, 0191, 0204, 0212, 0216, F47, F57, F58

A Remote Environment under full memory slows down but does not freeze and stays controllable: it has two-layer swap (compressed memory in front of a swap file), the Launchpad, T3 Code, the gateway and SSH have protected memory so that browser tabs and then Modules give way first, and processor time is shared between Environments while memory is not. The Environment browser has its own memory limit, the Environment's memory minus a 4 GiB reserve (at least 30 % of memory on Environments under 6 GiB) with at most 20 % in swap, and after a crash or restart it does not reopen old tabs. A tab that nobody watches and no agent works in falls asleep after idle time, or earlier under memory pressure, staying listed and reloading at the same address when opened, while a tab an agent controls or someone watches never sleeps. The "+" in every app's right panel opens the same Nová karta with an address bar, the app's tools and Přehled, which shows the Environment's memory, all its tabs with who opened them, their memory and last use, and the running Modules with Stop; each strip shows the tabs of its own place, × releases a tab for that place only, closing for everyone happens only in Přehled, and a remote tab ends once no place holds it, no agent works in it and nobody watches it. Opening a Module from `main` runs its built version, either a static build the Platform serves or one production `start_script` process, rebuilt in the background after each change of `main` while the previous build keeps serving; a development server runs only from a worktree (0212), and an App nobody has used for 20 minutes stops and starts again on the next open unless another App declares it as a sibling (0176). Lazurio gets faster through well-chosen parameters, standard capabilities and a few general principles, such as letting whatever nobody uses fall asleep, and simplicity wins over the last percent of performance.

### 0196 — Module data: the Environment's ceiling, narrowing in the app, and a verified identity that is not a key

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-10
- **Related:** 0035, 0171, 0177, 0192, 0198, 0203, F46

Lazurio controls entry to a Module (no access, user or admin, 0192) and passes it a verified identity, while what each person may do inside is the Organization's own rules in its code and data, for which Lazurio offers a recommended practice that the Organization may adopt or redefine. Data are reached by the Environment, not by a person: the Organization's Admin gives the Environment its data access through the vault (the Environment's ceiling, 0198 and 0203), the Launchpad hands a Module only the secrets it declares, a capability only some Environments have is declared as `optional_secrets`, and the Modules of all Organizations on one Environment run under its single account as one trust domain. Whoever has the whole Environment has root and works with the whole ceiling, whoever has only an app sees the part the Organization's rules allow, narrowed by the Module's server on every request including APIs, downloads, WebSockets and direct URLs, and this narrowing is a service of the Environment's operator, not isolation against them; where it must hold against the operator, an Organization-run app or a store that verifies identity itself serves the data. The identity is signed by Lazurio Auth, never by the Environment, is short-lived, valid for one exact Environment and app and never a key to data, so a Module with restricted rights always has a server part and the browser never gets access to its store. The Module's architect chooses repository-db or a database (a database when the ceiling must differ between Environments within one data set, personal data must be deletable, an outside service writes, writes are many, or people from several Environments work on the same data at once), and the agent explains this trade-off and recommends one. The repository-db draft stays shared per Environment, a person with restricted rights sees only changes to records they can access, and only someone who sees the whole draft may Publish it.

### 0197 — The Environment vault as a system: Lazurio-account entry, technical accounts and Lazurio Vaultwarden

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-11 and 2026-10-12 (amended 2026-10-14, by 0198 on 2026-10-13 and by 0203 on 2026-10-15)
- **Related:** 0091, 0172, 0177, 0191, 0192, 0193, 0198, 0203, 0213, F53

Each Environment has its own set of passwords and passkeys that its agents sign in to on their own and use proactively without asking; people know that whatever they put there is available to every agent of the Environment, keep other passwords where agents cannot see them, and since 0198 the set is the Environment's own vault. People enter the vault server only by signing in with their Lazurio account (single sign-on), with their vault account created at first sign-in and a master password they set once; no account is created from an e-mail address or an invitation. Each Environment registers a technical account with an unguessable address that the network pre-allows when it creates the Environment and hands only to that Environment; its password and keys stay on the Environment, single sign-on never gets that address, and when the network stops serving the Environment it disables the account instead of deleting it. Networks run Lazurio's public Vaultwarden distribution, an exact upstream release with a small overlay and an unchanged API so that Bitwarden apps keep working, in which only the Environments' technical accounts, matched by one fixed address pattern, are exempt from sign-on-only mode and people's API keys are refused. In the Environment browser the pinned official Bitwarden extension is signed in as the Environment's account with Chrome's own password manager off, agents stop only where access is missing, at a CAPTCHA or at a factor on the person's device, and a write visible outside remains the person's Publication. The vault server is reachable only from its tailnet, keeps its configuration as code and its admin interface off the internet, and is backed up encrypted off the host before each version change; since 0203 every Organization has its own Lazurio Vaultwarden and a personal Environment uses the person's own Bitwarden.

### 0198 — Each Environment has its own vault, managed by the people who have access to it

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-12 and 2026-10-13 (amended 2026-10-14 and by 0203 on 2026-10-15 and 2026-10-20)
- **Related:** 0091, 0172, 0192, 0194, 0196, 0197, 0201, 0203, F53, F54

Every Environment has its own vault, its own organization in its Organization's Lazurio Vaultwarden (0203), which the Environment's technical account creates and solely owns and which the Environment remembers by ID; its agents use it on their own. People with access to the Environment (0192) are the vault's managers with full rights, added and removed by the Environment itself as their access changes; others get only collections the managers knowingly share, and no role, not even Organization Admin, gives anyone an Environment's passwords by itself. Each person enters with one account per vault server using only their Lazurio account, chooses a master password that Lazurio never knows, and sees there the vaults of all Environments they can access; personal passwords belong in the person's own password manager. The vault is reached from Apps → Trezor without the Launchpad showing items, its web has Lazurio's look and Bitwarden's structure, the Dashboard never sees it, and the server uses standard Vaultwarden functions only. Secrets never travel through chat or a file: an agent gets one when the person signs in to a service in the shared browser window and confirms Bitwarden's offer to save it, by creating it itself in a signed-in service and saving it straight into the vault, through a secret request that a person with access fills in the Launchpad (the agent then receives only the item's name), or by importing a supplier's bulk file that the person puts into the Environment's Files and deleting it at once (0203). What an Organization hands out to several Environments goes through a shared vault for that purpose (0203).

### 0199 — Lazurio and its agents address every person formally in Czech

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-11 and 2026-10-12 (amended by 0210 on 2026-10-20)
- **Related:** 0103, 0170, 0210, 0211, F14

Whatever Lazurio and its agents say or write to a person in Czech (chat, handoff, a pull request description meant for the person, application texts and the human output of commands) uses the formal vy: lower-case vy, váš and vám, imperatives in the plural and no past tense about the person that would force a gender. English is unchanged. Rules written for agents (`AGENTS.md`, skills) and prompts a person sends to an agent in their own words stay informal. The standard handoff of 0103 is phrased formally, including its closing question whether the agent should Publish the changes on the person's behalf or ask another colleague to review and Publish them, which agents ask with the question tool (0211). Buddy addresses its own person formally or informally as that person chooses in Settings → Buddy (0210).

### 0200 — Chat is Lazurio T3 Code, a modified distribution that keeps the T3 Code brand

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-13 (amended by 0208 on 2026-10-18)
- **Related:** 0179, 0187, 0191, 0208, F36

Lazurio's Chat is Lazurio T3 Code, a modified distribution of T3 Code for Lazurio Environments: the distribution's name appears in its repository, repository description, releases, images and archives, while the wordmark, icons and in-app name stay upstream's and upstream's MIT license travels with it. In an Environment the app is labelled "T3 Code (Lazurio)", uses upstream's production icons and no longer calls preview releases "Nightly". The fork's README, repository description and release notes first say that the browser works differently — in the web client on a Lazurio Environment the right panel shows the Environment browser's remote tabs, shared with agents and other apps, while the desktop app on a local Environment keeps the computer's own browser — and then describe the Folder project, how the fork follows upstream, how it is released and where to report bugs, with security issues going through GitHub's private vulnerability reporting. On an Environment the web client's standard appearance follows the Environment theme of 0208, by default the Lazurio design system: the Environment shell declares the design-system tokens, the fork maps them in a single stylesheet, a theme picked inside T3 Code is a personal override, and without the Lazurio shell T3 Code looks like upstream. The Platform release that carries the tokens reaches Environments before the fork release that uses them, and MausBot keeps its upstream brand while its default look follows the Environment theme.

### 0201 — Environment onboarding: the basics first, AI first, CLI sign-in in the Environment browser, and a lasting Lazurio sign-in

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-14 (amended 2026-10-21 and 2026-10-22)
- **Related:** 0162, 0173, 0181, 0188, 0191, 0192, 0198, 0204, 0210, F19, F36, F55, F65

An Environment is ready when it has at least one connected AI subscription, a signed-in GitHub and the Organization's repositories (on a Personal Environment, its personal space); a basic step the Organization provides in advance, such as an AI pool or a Team's GitHub identity, counts as done without the user, and a member without rights to the root repository of an Organization not yet converted to the canonical manifest is told that its Admin, not Chat, prepares it. Settings → Getting started (Začínáme) checks the steps off from the tools' live state and stores nothing; while a basic step is missing it reappears after every reload even if the user closed it, it is always one click away, and afterwards it keeps the optional steps (Composio, SSH from one's own computer, a desktop client) and the tour. The order is AI, GitHub, repositories, so that an agent can help with the rest: "solve in Chat" is offered only once AI is connected, the user chooses ChatGPT, Claude or both, which turns on the matching Chat providers, and whether a sign-in is needed is read from the CLIs themselves, with no new flag or Organization setting. Sign-in runs Lazurio's command (`lazurio tools login codex` or `lazurio tools login claude`), which calls the official CLI sign-in in a browser and stores the result where Chat, a desktop client over SSH, the terminal and agents all read it, after which running services reload it; Chat's own ChatGPT button is hidden so that no Chat-only sign-in appears, ChatGPT also offers a less prominent device-code fallback (`--device-code`, a code valid for fifteen minutes, linked only to ChatGPT's official code page), and Claude keeps browser sign-in only, with no long-lived token offered. The Environment browser, shown in the right panel, is the default browser of every personal and work Remote Environment, so every CLI that opens a browser opens it there and the localhost callback completes inside the Environment, while on one's own computer the computer's browser stays the default; passkeys and the computer's password manager do not work in the Environment browser, and the step says so in advance. A Lazurio-account session lasts seven days of inactivity and at most thirty days and then signs in straight through GitHub while GitHub is the only way in, signing out also ends the Lazurio session, and Admin-approved devices still guard the entry; a Personal Environment starts with Buddy's own sign-in and introduction (0210), an Environment with automations has the same first start as a Work Environment, and the public shared Environment of 0204 has a demo onboarding without the AI step.

### 0202 — The Admin's Work Environment is the Organization's administrative station

- **Status:** decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-15 (amended by 0192 and 0224 on 2026-11-01)
- **Related:** 0153, 0155, 0172, 0183, 0192, 0224

The Work Environment of a person who holds the live Owner role of the GitHub Organization (the Organization Admin) is the Organization's administrative station: from it, directly and without a laptop, SSH leads into every other Environment of the same Organization — members' Work and Team Environments, other Admins' Work Environments, the Environment Henry and the server services — and into administration of the Organization's Conglomerate Host, while from the Admin's Personal Environment the way goes in two steps through this Work Environment. Agents there act for that person; the source is never a whole Organization tag, a Team Environment, an Environment with automations, a phone or another person's device, the target is never a Personal Environment or another Organization, and no edge is granted merely as the reverse of another; another Admin reaches this Work Environment only through their own Admin role. The edges are derived automatically from the live Owner role and are removed within five minutes after the role ends, with no manual infrastructure change; the station has one key for all its edges, a target accepts it only from the station's address, and its private part never leaves the station. Personalspace never lives in a Work Environment, only in the person's Personal Environment, so an Admin's entry opens only the Organization's work, and where a Work Environment still holds a personal space the Admin's agents do not read it. Whoever controls the station reaches every Environment of the Organization, a deliberate cost of administration: precise Headscale grants limit the direct paths, the tailnet alone does not isolate data because one tailnet and one Conglomerate Host can serve several Organizations, and host administration goes only to Owners of the Organization that owns the host, so controlling their station affects every tenant of that host.

### 0203 — Vaults per Organization: each Organization has its own Lazurio Vaultwarden, people use their Lazurio username, Personal Environments use their own Bitwarden

- **Status:** decided, not yet fully deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-15 (amended 2026-10-20)
- **Related:** 0091, 0153, 0154, 0193, 0197, 0198, 0207, 0213, F53, F54

Each Organization has its own Lazurio Vaultwarden, run by its Conglomerate Host with its own database, backup, updates and Lazurio Auth client, reachable only from the network's tailnet at an address that carries the Organization's GitHub login; a person therefore has one vault account per Organization, Environment vaults live in their Organization's Vaultwarden and are named after the Environment, and an instance moves only as a whole, never as a database copy into another running instance. The Organizations of one Conglomerate form one security boundary, so Lazurio Auth lets a member of any of them into any of their Vaultwardens and what a person sees depends only on the vaults they are invited to; someone who leaves an Organization but stays in the circle keeps only what others explicitly shared, and Environments remove them from their vaults by themselves. A Vaultwarden has three kinds of vault, each labelled with whom it is for: the Organization vault for passwords people share, owned by the Organization Admin as a person and never holding Environment accounts; an Environment vault for that Environment's agents and the people with access to it; and Admin-owned shared purpose vaults for data that several Environments' agents, or people and agents together, need — vaults, not collections, separate who sees what, and when trust in a removed Environment is lost, the keys it used are rotated. Every Lazurio account has one lowercase username that never changes and is never reissued — the GitHub login from the first sign-in, or a chosen name that exists on GitHub neither as a user nor as an organization — used everywhere (vault, Headscale, personal DNS slug) and received by Environments from sign-in, never composed from GitHub; the vault address is `<username>@account.lazurio.ai`, an identifier with a null MX record that is never a mailbox or a contact. Environments register their own vault accounts with a random master password and an API key that stay in the Environment and that no person knows, agents never use a person's account, and before recommending where to store a secret an agent asks who needs it and who changes it; a bulk secrets file from a supplier goes into the Environment's Files, never into Chat, and the agent imports it into the right vault, deletes the file and never prints the values. A Personal Environment belongs to no Organization and uses the person's own Bitwarden (typically the free hosted service): the person creates a separate agents' account in the same service and region and enters its API key once on the Vault page, after which the Environment sets up a two-member Bitwarden organization as its vault; Personalspace privacy (0091) and entry under 0192 do not change.

### 0204 — LazurioExampleOrganization is Lazurio's public reference Organization and the first wave of every rollout

- **Status:** in force, partly deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-16 (amended 2026-10-17, 2026-10-18, 2026-10-19, 2026-10-20, 2026-10-21, 2026-10-22, by 0213 on 2026-10-24 and by 0207 on 2026-10-25)
- **Related:** 0166, 0178, 0191, 0192, 0201, 0203, 0205, 0209, 0213, F55

LazurioExampleOrganization is Lazurio's public reference Organization: it holds only fictional data and public repositories apart from its private Deployment Repo, keeps no secret in Git and nothing that reaches into another Organization, and runs exactly the same code and mechanics as any Organization, differing only in settings any Organization could use; no other Organization may invoke or extend this decision. Its Work and Team Environments follow GitHub membership, Teams and grants and serve testing and benchmarking; people, members and visitors alike, enter its Environments only by Lazurio sign-in through the public-DNS mode of 0213 and never through a tailnet, its servers are managed through its own small Conglomerate Host and tailnet, its vault answers only inside that tailnet, and under 0213 its Environments, the shared public one included (for its own vault account), are server nodes of that tailnet without giving people a tailnet path. The only public Environment is one shared trial Environment, shown as a Team Environment with a qualifier, reached by link and not offered in the Dashboard: it admits any signed-in Lazurio account without request, membership or grant, has full web access and a demo onboarding, reads the Organization's public content without a GitHub identity and can only read on GitHub (signing in to one's own GitHub there is blocked, so nothing is published from it), with no Integrations, no shared AI subscription or AI pool and no secret of the Organization. Everyone who enters sees and may change everything in it, as the entry notice says before linking the trial terms and privacy policy, which continuing accepts; visitors use their own AI subscription or other accounts there at their own risk and sign out afterwards, its only Organization AI is a gateway with a fixed spending cap, its own Environment vault and a nightly reset to its last reviewed state are decided but not yet deployed, and any Environment or the whole server can be redeployed from scratch at any time, which is not a release rollback. The Organization is the first wave of every rollout of Lazurio's shared software (Machines, the Platform, the T3 Code and MausBot forks, Auth or Dashboard changes at the Environment entry; not the shared control plane): rollouts, restarts, reinstalls and redeployments there need no consent from its users and no window, an agent runs them at the instruction and in the rights of a user with a live Admin role there, and the next wave starts only after browser acceptance on this Organization (0178); source review, Machines lifecycle gates, release approval and other Organizations' consent stay. Access requests are a general Organization feature that any Organization can enable in its manifest: a person with a Lazurio account asks in the Dashboard, the Admin approves (followed by an ordinary GitHub invitation) or rejects, and the list stays only in the Dashboard; the reference Organization's dedicated server is not backed up, because recovery is a fresh deployment.

### 0205 — An Organization's Machines and Environments change only through a pull request to its Deployment Repo

- **Status:** in force, partly deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-16 (amended 2026-10-17, 2026-10-21, 2026-10-26, by 0155 on 2026-10-19 and 2026-10-20, by 0213 on 2026-10-24, by 0192 on 2026-10-26 and 2026-11-01 and by 0224 on 2026-11-01)
- **Related:** 0144, 0153, 0155, 0166, 0183, 0192, 0203, 0204, 0213, 0216, 0224

The only way to change an Organization's Machines and Environments is a pull request to its private Deployment Repo: CI computes the native Plan, the persona or a Kolega reviews it, and a merge by a named user with live rights plus one click in the GitHub Environment authorizes the apply, which runs on a pinned Machines release and keeps evidence, Permit and audit in the same repository; a persona never approves an apply, and Machines derives the rest (issuer client, enrollment, DNS, grants) from one declaration per person and per Environment. Runtime facts decided elsewhere do not go through pull requests and reach the repository only as automatic audit records: individual device approvals by the Conglomerate Host's service (0192), access edges derived from assignment, membership and roles (0224), and the assignment of person-free Environment declarations, which is a write in Lazurio Auth. The runner is a short-lived GitHub-hosted Actions workflow that authenticates by GitHub OIDC at a gateway on the server's Conglomerate Host (Lazurio runs the gateway for personal Environments outside an Organization); the gateway checks repository, ref and GitHub Environment, issues only per-run credentials (a short-lived SSH certificate, custody access for that lane, a temporary tagged tailnet node) and holds each Machine's lock and queue, so GitHub stores no secret, no personal token is used, and custody sits at the Conglomerate Host boundary, sourced from the Organization's Vaultwarden. An approved intent stays valid for 24 hours, so a failed apply may run again without a new review when its new Plan contains only the rest of the approved one, also with a newer attested Machines release carrying a fix; failures before the first mutation recover by themselves, runtime errors carry specific codes, repairs go forward (0166), and the Dashboard and other services only read published state and evidence, the runner's progress records there being a view, not an authority. Personal Environments outside an Organization's tailnet have no Deployment Repo: the Lazurio account is their source of truth, Lazurio's pool gateway converges them and they take already accepted releases in a nightly run unless the owner turns on prior approval, while a Personal Environment that is a node of an Organization's tailnet is managed by the Organization that owns that Conglomerate Host (0155); Machines releases reach Organizations as automatic pin-bump pull requests in waves, the public reference Organization first (0204). For every Organization except the reference one, servers and Environments are reachable only through its tailnet, with no public SSH in normal operation and exactly three public entries — Headscale sign-in, the rollout gateway's admission for OIDC-verified runs from the merged Deployment Repo, and production apps the Organization deliberately publishes behind its fail-closed gate — plus, in public-DNS mode, the server's entry to Environment gateways (0213), and a declared, expiring operator-key SSH only while the pipeline is being introduced.

### 0207 — People see three kinds of Environment; Buddy names the personal product; a Personal Environment is a tailnet node or web-only

- **Status:** in force; the public-DNS mode of Personal Environments is decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-17 (amended 2026-10-18, 2026-10-25, 2026-10-26, by 0170 on 2026-10-19, by 0209 on 2026-10-29 and by 0192 and 0224 on 2026-11-01)
- **Related:** 0089, 0091, 0153, 0154, 0155, 0170, 0180, 0192, 0203, 0209, 0210, 0213, 0214, 0215, 0224, F28, F66

People are shown three kinds of Environment — Personal, Work and Team Environment (Osobní, Pracovní, Týmové Prostředí): an Environment with automations is a plain Work Environment, named Henry where it needs a name, the person's own computer with a local Lazurio has no kind and is "your computer", and decision 0209 adds a fourth kind, the Services Environment, which is decided but not yet shown. A text about a specific Environment names its kind ("this Work Environment"), plain "Environment" stays for Environments in general or lists of them, and identifiers, schemas, commands and decision records are not renamed. Buddy is the name of the personal product a person creates and of the personal representative, the personal space's content is the Personal Workspace, and every new Personal Environment comes with Buddy, who also explains Lazurio from his floating bubble: that an Environment is a computer where agents work, that his Environment belongs to the person alone, and that agents may go from it into Work Environments but never back. A Personal Environment runs in one of two modes set by its own declaration: in tailnet mode it is a node of one Conglomerate's tailnet, reached from its Owner's devices over HTTPS and SSH, and its Buddy works in the person's Work Environments under their AGENTS.md without carrying one Organization's data into another; in public-DNS mode only the Owner reaches it, through web apps over HTTPS behind the Lazurio account via its server's public entry (0213, 0214), with no SSH and no path into other Environments for it or its Buddy. Whoever needs SSH or founds an Organization moves to tailnet mode, enrolled and verified from the person's devices before the public names are removed, and a Personal Environment with grants into a tailnet Organization never moves back, because its agents would bypass that Organization's device approval; existing Personal Environments stay in tailnet mode. GitHub stays a required onboarding step until accounts without GitHub exist, Buddy's first recommended channel is Telegram with the person's own bot created at BotFather (there is no shared Lazurio bot), computers and phones connect preferably through the person's own AI account rather than SSH (0215), and a Personal Environment uses the person's own Bitwarden (0203); the Personalspace boundary (0091), one hosted personal Machine per person (0153) and the access model (0192) stay.

### 0208 — One colour theme per Environment, chosen in Apps → Settings and taken by Chat, Apps and Automate

- **Status:** in force · **Applies to:** GEN4 · **Decided:** 2026-10-18
- **Related:** 0172, 0179, 0187, 0200, 0204, F36

An Environment has one colour theme, a single record owned by the Launchpad and chosen in Apps → Settings → General; agents read it with `lazurio theme` and change it only where the last rule below allows, and it is never copied into T3 Code's settings or MausBot's CSS. The default palette is Lazurio, today's design-system look, and T3 Code's built-in themes (Grove, Ocean, Ember, Iris), taken from the fork under the MIT license and mapped onto the design-system tokens, can also be chosen; the T3 Chat brand palette is not offered. The Environment shell carries the theme into every app as it carries language and tokens — listed in `shell.json` and declared on the app's document as the promised `--lz-*` token values, light and dark — so Chat's standard look, the new "Environment" skin in Automate and Apps take it, and a change shows as soon as the page is displayed again, without a reload. The pickers inside T3 Code and MausBot stay: their Environment entry means the Environment theme, another choice is a personal override in that browser which later theme changes do not overwrite, the choices are neither hidden nor synchronized, and upstream `t3 theme set` is not used on Lazurio Environments. Light or dark mode is each person's choice, by default following the device, Apps stay light until the design system has a dark interface, and apps without the shell keep their current look. Whoever may open the Environment's Settings changes the theme — the user of a Personal or Work Environment, anyone connected to a Team Environment — while on a visitors' Environment (0204) the theme is fixed to Lazurio and writes are refused in Settings and in `lazurio theme`, an interface safeguard rather than a security boundary, which stays the Environment (0172).

### 0209 — Server services: one services Machine on each Organization server, entered only by Owners and Admins, with one container per service and the AI pool

- **Status:** decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-19 (amended 2026-10-19, 2026-10-26, 2026-10-29, by 0213 on 2026-10-25 and by 0224 on 2026-11-01)
- **Related:** 0146, 0148, 0155, 0172, 0179, 0181, 0185, 0198, 0204, 0207, 0213, 0214, 0224, F10, F32

Every Proxmox server of an Organization has exactly one services Machine, shown to people as Server services, which holds every service the server provides to its Environments and is enlarged rather than duplicated; a server hosts the Environments of one Organization only, and a server of many people's Personal Environments carries the same Services Environment only for the public entry and certificates (0213). Server services are a fourth kind for people, the Services Environment (until the shell supports the kind they appear as a Work Environment), entered only by the Organization's Owners and Admins, who see it among their Environments, chat and set up bots there and watch the services run; its agents act for the Admin who manages the service keys, which sit in its Environment vault and are entered from there rather than pre-filled in a shared browser profile. Each service runs in its own container with memory, CPU and process limits so that a shortage stops only that service, but the Machine stays one access boundary (0172) and every service gets only its own key; platform services (AI pool, AI gateway, public entry, certificates, diagnostics) come with Machines releases, while an Organization's own service is built from its productionspace repository into the Organization's image registry with verified provenance and pinned by digest. Other Environments on the same server reach, over the server's internal network and without a tailnet, only services the Deployment Repo declares and permits and the pipeline deployed; the services entry tells a service which Environment called and to whom it is assigned, as an audit record rather than a permission, and a permitted integration service appears in that Environment's Integrations without manual connection, for example as an MCP server in Executor, while the AI pool and AI gateway arrive as the Codex model and are not Integrations. The Organization's AI pool always runs here, one per server and never for another Organization; services speak HTTP for now, MCP over streamable HTTP included, and serve only their own server's Environments, never an external chat client, while the Organization's production apps and databases are separate systems outside them; a Services Environment that carries a public entry is not a tailnet node (0213), and a key that issues certificates may change records only in its own delegated zone. Each service is one productionspace repository for all the Organization's servers, read-only by default, which may declare a link that opens the service's page on localhost in the Services Environment's browser of the server where the user clicked; productionspace repositories never get an address of their own, Server services act on GitHub as Lazurio for GitHub through the Organization's broker with write access only to service repositories and read access to the root repository, and Publication from them is always by a named user.

### 0210 — Buddy is a Hermes Agent inside the Personal Environment

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-19 (amended 2026-10-20, 2026-10-21, 2026-10-22, 2026-10-24, 2026-10-26, 2026-10-28, 2026-10-29 and 2026-10-30)
- **Related:** 0080, 0089, 0091, 0153, 0155, 0172, 0180, 0189, 0192, 0199, 0201, 0202, 0207, 0211, 0224, F14, F56, F60, F61, F63, F64, F65, F66

The product is the Personal Environment, and Buddy belongs to it as a briefed Hermes Agent running inside it, installed the upstream way from Lazurio's forks at a commit Machines pins; the separate hosted Buddy, the Resident distribution for Buddy and Zulip are gone, a neutral Lazurio guide replaces Buddy where a person has no Personal Environment, in Environments of another tailnet and on Work Environment pages when the Personal Environment has no tailnet (and so no path there), and the Dashboard has its own Lazurio assistant. Buddy has four layers: Lazurio's role, rules and skills, shipped to every Buddy and never edited by him; the persona (name, character, form of address, tone) the user sets in Settings → Buddy, from which SOUL.md is built; his own learned skills and notes, backed up to the user's private repository; and gbrain memory over the Personalspace vault, which he uses implicitly, which other agents use only on explicit instruction, and of which only a text-free picture may leave when the user shares it. He works with the Personal Environment's full rights, without sandbox or command approvals, takes turns only from his user and treats outside content and bots' results as data; he reaches what the Personal Environment reaches, enters another Environment by a step into it (SSH or a Chat thread) under its access and AGENTS.md and never by forwarding credentials, and servicing colleagues' Environments goes only through the administrative station (0202). He is his user's coordinator: he does simple tasks of roughly two minutes himself, even in another Environment, and hands anything bigger to MausBot bots where the work belongs through Delegation, a deterministic service that records each task with a deadline and reliably tells him when it ends, fails, asks or runs late; he reads Chat threads at any time but writes in, steers or starts them only at the user's request, Chat agents never try to reach him, and workers are called bots or Chat Agents, never "helpers". All direct conversations with him (bubble, Telegram, other channels, later voice) form one endless conversation, replies go back where the message came from and a message during his work steers rather than stops him; the chat offers only a Normal/Fast switch while Lazurio sets model and parameters through three tested profiles (Economical, Balanced and the default Thorough, which uses a deliberately chosen model, GPT-6.1-Terra as of 2026-10-28, with medium reasoning in conversation), and Buddy's own ChatGPT sign-in, separate from the Environment agents', is the first step of a Personal Environment's onboarding. Towards people he talks like a friend and never shows internal mechanics, tools or task states; a message he writes for his user to another person greets them by name, says in one plain sentence that the user asked, and is signed "Buddy", while the trace "Buddy za <user>" appears only where T3 Code adds it in threads and approvals, his informal or formal address follows the user's setting, and Publication follows 0089.

### 0211 — Agents ask people through their harness's question tool

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-20 (amended 2026-10-24)
- **Related:** 0103, 0148, 0163, 0169, 0199, 0210, F14

An agent that needs a decision or an answer from a person asks with its harness's question tool (Claude Code `AskUserQuestion`, Codex `request_user_input`, Hermes `clarify`), not only in message text, where a question gets lost and the thread looks busy while it is stuck. A request that the person do something — enter a verification code, sign in, confirm or check — is asked the same way, with exactly what to do, the link, the code and its expiry, and options that report the outcome ("Done", "It doesn't work"); a short-lived code stays in that private chat, never in a mailbox, issue, repository or lasting log. A question offers two to four options with the recommended one first and marked "(Recommended)", the context goes in the message above it, and the agent first does everything that does not depend on the answer and asks only when it cannot safely continue or the decision belongs to the person, never about what it can find out itself (0163). The handoff block of 0103 stays message text and its standard two-part question (publish in the user's name, or ask another Kolega) is asked with the tool with neither option marked as recommended; in a Team Environment the tool asks whom to tell to publish, and a Publication choice the person makes in the tool is their explicit instruction to publish in the current thread, which in a Team Environment leads to a handover to a named user rather than a merge by the agent. Without a question tool the agent asks in text with numbered options and says that it is waiting and what is on hold; a subagent, a MausBot bot or an automated reviewer has no user in the session, does not use the tool, and passes the question in its output to whoever gave it the work. Codex offers the tool in Default mode only with the `default_mode_request_user_input` feature turned on per Machine in `~/.codex/config.toml`, and the generated Folder's AGENTS.md in every Environment carries the same rule.

### 0212 — What is published on `main` is what Lazurio runs, as a build

- **Status:** in force; implementation in progress · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-24
- **Related:** 0171, 0173, 0188, 0195, 0204, 0205, F9, F47, F58, F62

What is published on a Module's `main` and in its data is what an Environment or a person's computer runs, and it runs as a built version. Lazurio fetches and fast-forwards the primary checkouts of the Organization root, its Modules and their data repositories (data on their declared branch) only when a checkout is clean, on its branch, without an operation in progress and strictly behind; anything else stays as it is and appears as a finding for an agent, the root goes first and the Modules come from its new manifest, worktrees, productionspace, Personalspace and `infra` are not synchronized, missing repositories are not created (installation does that, 0188), and the Environment's own access is used. `lazurio update` means the same on a computer and in an Environment — Lazurio itself to the newest public release, then the checkouts, the tools Modules declare (0171), and preparing and building what changed with running Apps swapped, reported per item — agents run it before every task and the Update button runs it by hand, while in the background the Platform Launchpad synchronizes and builds hourly for the whole Organization and at once for a Module being opened, without changing Lazurio itself. The pipeline governs what an Environment is (system, services, resources, network and minimum software versions, with changes that may restart services going into windows), while `lazurio update` governs what runs on it above that minimum without restarting the Environment (updating Lazurio restarts only the Launchpad); a new Lazurio release passes as a candidate through the reference Organization and browser acceptance before it is public, after which Environments take it themselves and the pipeline raises the minimum in waves for those that did not. From `main` only a build or a production start runs, never a development server: a failed build keeps the previous one running with a finding, no build means the App does not start, and development servers run only from a worktree, started by an agent on their own localhost address opened in the Environment browser, never replacing the `main` version and ending with the worktree or after inactivity. The New Tab card shows for each running Module whether it is the built version (with its commit) or a development server, with an Update button and per-Module progress; every App declares a build output or a production start script, the Module Standard requires it, agents convert existing Apps in waves with the reference Organization first under the normal Publication rules, the cutover then removes running development versions from `main`, and until computers get the Platform Launchpad the root repository offers the same declaration in a small form.

### 0213 — Network for people: an Organization may switch from tailnet to public DNS

- **Status:** decided, partly deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-24 (amended 2026-10-25, also by 0207 and 0214 on 2026-10-25)
- **Related:** 0146, 0155, 0157, 0172, 0192, 0197, 0203, 0204, 0205, 0207, 0209, 0214

People enter an Organization's Environments through its tailnet, which stays the default, or without a tailnet through public DNS; the mode is one setting in the Deployment Repo, the server's public entry on each server concerned, which the Organization Admin turns on by a reviewed pull request citing the Organization's own decision, which requires mandatory two-factor authentication in the GitHub Organization and an own delegated DNS zone, and which replaces any platform list of public Organizations (admitting any Lazurio account stays reserved to the reference Organization's shared visitors' Environment, 0204). In public-DNS mode the services Environment's entry (0209) reads only the server name from TLS without opening the connection, passes only declared Environment names to their gateways and closes any other name, each Environment has two public records in the Organization's zone that the zone owner writes and Machines only compares and lists, and a Lazurio account with active membership and a specific grant replaces the Admin-approved device (0192). Every gateway refreshes the session at least every two minutes, so a removed member is refused any new request or connection within two minutes, and ends every upgraded or long-open connection five minutes after it opened, so the member loses everything within seven minutes; this mode has no native T3 pairing exception and no SSH for people, who get only the web interface (Launchpad, chat, MausBot, Buddy), not desktop T3 Code or the vault from their devices. The Environments stay server nodes of the Organization's tailnet with the same enrollment, default grants and SSH (0155), except the services Environment that carries the public entry, which stays outside the tailnet; the Organization's vault stays tailnet-only for people, who see their Environment's vault on its Vault page, while agents reach it from the Environment over the tailnet and servers are still managed through the Organization's own Conglomerate Host tailnet. From the internet only the entry into Environment gateways is reachable and every path behind it needs a Lazurio session; the accepted risks are that a stolen session works from anywhere until it is ended, that the Admin has no device list and that the gateways are visible like the Dashboard, while a Vaultwarden exposed to the internet, Machines writing address records and a single zone wildcard were rejected. The tailnet stays the backbone of security and the web entry is an Organization's choice, not the standard; Personal Environments in public-DNS mode use the same entry, gateway and record rules (0207, 0214), and a server of many people's Personal Environments carries the same Services Environment as an Organization's server.

### 0214 — Public entry for Personal Environments at scale: assignment in Lazurio Auth, a sign-in client per Environment, an entry per server

- **Status:** decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-25 (amended 2026-10-26)
- **Related:** 0091, 0153, 0154, 0157, 0192, 0203, 0207, 0209, 0213, 0216

Assigning a Personal Environment to a person is a single permission in Lazurio Auth, made by the Dashboard and later by payment (the same holds for Work Environments), and the Dashboard's rail, the sign-in client, the DNS records and the Environment's lane all derive from it, so adding a person needs no Dashboard release and no Conglomerate Host change; after an assignment is removed the gateway refuses new requests and connections within two minutes and open connections end within seven. Every Personal Environment keeps its own sign-in client bound to its Owner's immutable GitHub ID and to its slug's redirect address only; the client is created with the Environment and switched on at assignment through Lazurio Auth's administration interface by the assignment service alone, never by the Conglomerate Host's realm configuration, its secret goes straight into the gateway's custody and never through a pull request, and gateways accept no bearer tokens. Every server with such Environments has its own Services Environment carrying the public entry (0213) and the DNS-01 challenge service, outside the tailnet and worked in only by the operator's Owners and Admins; the Personal Environments are tagged management nodes in the operator's tailnet that cannot reach each other, and there is no central entry for all servers, so capacity grows by adding servers and an outage touches only one server's Environments. The zone owner's service writes, from the assignment, only the `<slug>` and `*.<slug>` address records, a fixed CAA record binding issuance to DNS-01 (and to the Environment's ACME account once known) and one static CNAME for the challenge; each Personal Environment issues its own certificate, the challenge key can publish only TXT records for that Environment's name in the operator's delegated zone, the address writer never holds the TXT key and the TXT key never writes addresses, and moving an Environment to another server changes one record, never its name. `lazurio.io` is to be entered in the Public Suffix List so that every Personal Environment and every Organization is a separate site for browsers and people who do not trust each other share no cookies, after the domain registration is extended beyond two years and parent-domain cookies are removed from all services. Rejected alternatives are a separate entry unit, a second ACME mechanism, a CAA record at the zone apex, one sign-in client per server (its secret would let people on a server obtain each other's tokens), a central entry, a TLS-terminating CDN proxy, names that carry the server, and a separate Conglomerate Host for these servers.

### 0215 — ChatGPT apps pair with an Environment through the ChatGPT account; SSH stays a hidden option for advanced users

- **Status:** decided, not yet deployed · **Applies to:** GEN4 · **Decided:** 2026-10-26 (amended by 0192 on 2026-11-01)
- **Related:** 0148, 0172, 0192, 0207, 0213, F29, F49

The official way to connect the ChatGPT app on a phone (iOS, Android) or on a computer (Codex, desktop app) to a Personal or Work Environment is pairing through the ChatGPT account: the Environment creates a short-lived pairing code and QR code, the person enters or scans it, and the Environment appears in the app as a device the app controls, over OpenAI's remote-control service, with no SSH, password, open port or tailnet on the phone or computer. The app must be signed in with the same ChatGPT account as Codex in the Environment, and the person checks first that it is their own personal or work account; where Codex in a Work Environment uses AI provided by the Organization instead of the person's account, pairing is not possible. Settings gets a Connections section with three tabs — Control this Environment (paired devices, add with QR and pairing code, allow connections, remove access), Control other Environments (on a Personal Environment, read-only, the Work Environments its derived SSH edges reach) and SSH — which replaces the SSH-based Computer and phone page; SSH under F49 stays the hidden third tab for advanced users, is never offered first and reaches only devices that have port 22 (a phone has only 443). Because the pairing code is created inside the Environment, only someone who already enters it under 0192 can pair; afterwards the ChatGPT account and its multi-factor authentication decide access, not the Lazurio sign-in or an Admin-approved device, and access is removed in the ChatGPT app or in Settings. The underlying remote-control feature is experimental and officially documented only for macOS and Windows hosts, so the Platform detects it; without it SSH is offered only where SSH into the Environment is allowed, and in public-DNS mode pairing shows as unavailable while the web entry stays. Team Environments are unchanged, since their Codex acts under the Team's identity, and so are SSH under F49 and device approval in the tailnet (0192).

### 0216 — Environments are created in advance and assigned to people

- **Status:** decided, not yet deployed · **Applies to:** internal (HumanAndMachine-ai) · **Decided:** 2026-10-26 (amended 2026-10-27)

The full decision is internal to the HumanAndMachine-ai Organization.

### 0217 — Stations of the development Organization

- **Status:** decided, implementation in progress · **Applies to:** internal (LazurioDevelopment) · **Decided:** 2026-10-27 (amended 2026-10-28 and 2026-10-31)

Agents never switch, sign out or stop an Environment's own network, and they reach another tailnet only the way the Environment offers, such as an approved headless client's socket or that tailnet's own isolated network space chosen for each command, telling the user when it offers none; no tailnet is ever switched globally and nothing routes between tailnets. The rest of the decision, which lets a Work Environment of the development Organization act as its person's station for the Organizations they work in, is internal to the LazurioDevelopment Organization.

### 0218 — Coordinator of Lazurio's development

- **Status:** decided, implementation in progress · **Applies to:** internal (LazurioDevelopment) · **Decided:** 2026-10-28 (amended 2026-10-31 and 2026-11-01)

Threads do not coordinate with each other: each takes its own request through with its own worktree (one per pull request), pull request, verification and assignee, messages another thread only when its user explicitly asks, and puts whatever needs an order or depends on other work into the main roadmap in the Organization's Mission Control, kept by whoever holds the Organization's queue (usually its Henry). Every text an agent writes on GitHub ends with `Agent: environment <UUID> · T3 thread <UUID>` (a MausBot bot writes `bot <UUID>`), which names no Environment and therefore also fits public repositories. The rest of the decision, on the coordinator of Lazurio's own development, is internal to the LazurioDevelopment Organization.

### 0219 — The Lazurio Root and the Lazurio Folder converge on the Folder's mechanisms

- **Status:** decided, not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-28 (amended by 0225 on 2026-11-01)
- **Related:** 0144, 0161, 0217, 0225, F14, F67

The Lazurio Root (the root repository with its CLI on a person's computer) and the Lazurio Folder (the folder the Platform manages in an Environment) work on the same mechanisms, with the Folder as the reference: someone who has Lazurio both on a computer and in an Environment gets the same behaviour in both, and agents on the computer know how to reach the Environment and work with its Folder. GEN3 designates the Lazurio Root on a computer with `<login>_GEN3` Organizations and GEN4 Lazurio Platform with its Folder and Environments; since 0225 these are official designations in texts, not names of folders or repositories, nor a separate architecture layer, and repository names and the Organization layout do not change. Differences are measured on real consumers, each convergence step is a pull request in the owning repository with a contract on the consumer, and mechanisms are not duplicated: what the Folder can do, the Root adopts instead of building its own variant.

### 0220 — AI Employee (working name)

- **Status:** decided, not yet deployed · **Applies to:** internal (HumanAndMachine-ai) · **Decided:** 2026-10-30 (amended 2026-10-31)

The full decision is internal to the HumanAndMachine-ai Organization.

### 0221 — Guest Modules: an Organization may host another Organization's Module in its workspace

- **Status:** in force; deployment in progress · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-30 (amended 2026-10-31)
- **Related:** 0041, 0186, 0217, 0219, F67

An Organization may host a Module of another, home Organization as a guest Module: it is mounted in the host's workspace under `workspace/<HomeOrganization>_GEN3/<repository>`, with repository-db data under `…/db`, its slot in the host's `modules.manifest.json` carries `home_organization` and the home repository's remote, and the home Organization's folder has its own README.md and AGENTS.md saying that these Modules belong to another Organization. The root CLI and the Platform clone and update guest Modules with the user's own rights, relate their identity to the home Organization and never run them as the host's applications, and changes go by pull request to the home repository under the home Organization's rules, review and Publication. Hosting changes no owner, visibility or grant: access follows live GitHub rights (0186), nothing is copied between Organizations, a person without access to the home repository does not get the guest Module, client Organizations' data are never shared this way, and guest folders are the only exception to the flat `workspace/` (0041).

### 0222 — Every pull request has an assignee who takes it to `main`

- **Status:** in force; enforcement not yet deployed · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-30
- **Related:** 0103, 0171, 0218

Every pull request in every Organization has an assignee, the one who takes it all the way to `main`: the author, the Organization's persona (its Henry, or the coordinator in Lazurio's own development) or another eligible Kolega. A pull request without an assignee is an unfinished assignment and is not merged until its author assigns it; personas merge only pull requests on which they are the assignee, and a review request without assignment is only a check. Where the GitHub plan allows it, a required check that fails without an assignee enforces the rule; elsewhere a process holds it, with a bot that labels such pull requests and asks the author, rolled out first on the reference Organization.

### 0223 — Agents in one Environment do not block each other

- **Status:** in force; implementation in progress · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-10-31
- **Related:** 0172, 0178, 0191, 0204, 0217, 0218, 0222

Each Task Agent thread has for itself everything its work needs: a worktree per pull request, a clean browser and its own test-persona sign-in for every test run, a tailnet chosen per command and its own temporary files. The Environment's shared sign-ins — its browser (0191), `gh` and Integrations — stay its capabilities that threads use but never switch; a thread that needs another identity, such as a test persona, uses its own isolated browser for its run, and nothing shared by several threads is switched globally: not the Environment's network, the Tailscale profile, tools' sign-ins or global configuration. There is no coordinator inside an Environment and threads need not agree with each other (direct coordination only where the user explicitly asks, 0218); what must stay shared is guarded by a mechanism that never waits indefinitely — the rollout gateway's lock for an apply on a host, a lease for a physical device, a code queue for a persona's sign-in — and any place where threads would have to agree or wait for each other is an Environment defect, filed as an issue and removed by a mechanism rather than by a chat rule. A thread develops a change, tests it end to end itself as the reference Organization's test persona, from sign-in to sign-out, and hands it over by pull request; in Lazurio's development repositories the development coordinator, and in Organizations their Henry, reviews it, verifies it and puts it into the release pipeline, which reaches people through acceptance on the reference Organization (0204). Threads of one Environment are not a security boundary (0172): the rule ensures that they do not get in each other's way, not that they cannot see each other, and Publication stays the user's.

### 0224 — Access in a Conglomerate is derived from facts; Git holds only exceptions

- **Status:** decided, not yet deployed · **Applies to:** GEN4 · **Decided:** 2026-11-01
- **Related:** 0153, 0154, 0155, 0182, 0184, 0192, 0202, 0207, 0209, 0216

A Conglomerate is one tailnet of befriended Organizations; each Organization has its own server with only its own Environments, and a Personal Environment is a node of exactly one Conglomerate. In a person's personal context the data of the Organizations they belong to may meet, so Buddy may compose results from them for that person; in an Organization's context data never mix, and nothing moves from a Personal Environment into another Organization. Each edge runs one way, and none is granted merely as the reverse of another: a Personal Environment reaches the Work Environments assigned to its Owner in every Organization of the Conglomerate; a Work Environment reaches its person's Team Environments in the same Organization (a Personal Environment gets there in two `ssh` steps through its own Work Environment, never directly and without forwarding its key); an Admin's Work Environment reaches every other Environment of their Organization; an approved device reaches its person's Environments; and an Environment reaches a specific computer only when that computer's Owner switches it on. These edges are derived automatically from facts people with authority set (assignments, Team membership, the live Admin role, approved devices, a device Owner's consent) by the service on the Conglomerate Host that already approves devices. It delivers the source Environment's key to the target account, accepted only from the source's address and never forwarded, and gives the source its targets with host keys pinned from the Organization's records, never trusted on first use; a changed host key stops the connection until the records confirm it, and no edge forwards the agent or ports. After a fact is removed, new connections fail within five minutes, while sessions already running may finish; no supervision of running sessions is built. Git holds only the exceptions no rule derives, by reviewed pull request. Agents use only the routes Lazurio gives an Environment and say so when a route is missing. A Personal Environment without a tailnet (Product 1, 0207) has none of these routes. Replaces 0158 and 0182 point 3.

### 0225 — GEN3 and GEN4 are official designations; GEN3 stays maintained and transitional

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-11-01
- **Related:** 0164, 0171, 0219, 0226

GEN3 is the official designation of the Lazurio Root, the root repository with its CLI and Organizations on a person's computer, and GEN4 of Lazurio Platform with its Folder and Environments. The designations hold in texts (documentation, agent instructions, Knowledgebases); repositories and folders are not renamed, and the `_GEN3` suffix of Organization repositories stays because both generations use it. GEN3 stays maintained because customers work on it every day: fixes and security go on, but new norms are written only in GEN4, and GEN3 links to them instead of keeping its own copy. Shared contracts belong to Lazurio Platform, among them the Organization manifest contract with its schema and the Module Standard, written anew there under its licence, and GEN3 pins them. Customers move to GEN4 by the one-way migration of 0164. Amends 0219, whose orientation terms become official designations.

### 0226 — One decision register for both generations; a decision's home follows its audience

- **Status:** in force · **Applies to:** GEN3 and GEN4 · **Decided:** 2026-11-01
- **Related:** 0219, 0221, 0225

Lazurio's decisions keep one series of numbers for GEN3 and GEN4, and only this register in Lazurio Platform allocates them. A public decision, one that defines how Lazurio works for people, agents and administrators, has its full condensed text here, without quotations or internal details. A decision about the development and operation of Lazurio is internal to the LazurioDevelopment Organization, and a product or business decision to HumanAndMachine-ai; each keeps one line here and its full text in that Organization's Knowledgebase. What a public text cites must be findable publicly, so the entry of a cited internal decision carries the general norm the public text relies on. The Lazurio Root's register stays as GEN3's record of the rows up to 0224 and points here.
