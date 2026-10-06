# Distribution, operator-driven update and migration from the root repository

Status: **decided shape (Matěj, 2026-09-28, on issue #50); partly implemented.** It
answers issue #50: how Lazurio is installed the first time, who updates it, how users
of the legacy root repository (`HumanAndMachines/Lazurio`) move to the Lazurio Folder,
and what must exist before that repository is archived. The draft of 2026-09-28 laid
out options and ten questions; Matěj's decisions on #50 answered most of them, and the
options they ruled out are removed here. Four questions remain open
([#224](https://github.com/Lazurio/LazurioPlatform/issues/224)).

The binding records are the Platform decisions
[F17](decisions.md#f17--operator-tools-belong-to-the-operator-the-rollout-pins-the-baseline-and-repairs)
(addenda of 2026-09-28 and 2026-10-02),
[F20](decisions.md#f20--one-command-first-installation-the-downloaded-executable-verifies-its-own-release),
[F21](decisions.md#f21--recovery-mode-instead-of-rollback) and
[F22](decisions.md#f22--the-platform-launchpad-reaches-parity-and-replaces-the-resident-in-one-apply),
and root decisions 0161 (addendum), 0164, 0166, 0167 and 0168. This document does not
restate them; it applies them to distribution and migration and says what is built.

Citations: a bare path is this repository at `1a4a99b`. "Root" is the legacy root
repository at `12497f46`. **Not built** and **unverified** mark what does not exist or
could not be checked against code, documentation or a native run.

## 1. Decisions

Later comments on #50 override earlier ones.

| # | Decision | Source on #50 | Recorded in | State on `main` |
| --- | --- | --- | --- | --- |
| 1 | **One updater, `lazurio update`.** The operator updates Lazurio on any Environment, a Remote Environment included, without a rollout. Updating Lazurio is the operator's update of a tool, not a rollout | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5866787843) | F17 addendum 2026-09-28; root 0161 addendum | Built: the generated manual no longer forbids it (`base-instructions-9`); since the F17 addendum of 2026-10-02 agents run it at the start of every piece of work |
| 2 | **The pin is a minimum.** A rollout installs Lazurio when it is absent or broken, raises an Environment below the pin, and never lowers a version | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5866787843) | F17 addendum 2026-09-28; [machine handover](machine-handover.md#what-the-machines-role-does-with-the-lazurio-version-f17-addendum-2026-09-28) | Product side built (floor and high-water, `below-floor`). The Machines role is another repository; **unverified** here |
| 3 | **Migration from the root repository is one-way, without rollback.** Failures are repaired forward in the Lazurio Folder. Organization repositories, Personalspace and sign-ins are not touched | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5866787843) | root 0164 points 1–3 | Manual and prompt **not built** (section 4) |
| 4 | **Order of platforms:** Linux, then macOS, then a Windows build of the Platform, and only after it the migration of Windows users. Linux means Ubuntu in the first phase; other distributions are communicated as unverified | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5866787843), [late afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869231172) | root 0164 point 4; F22 point 5 | Release targets `linux-x64`, `linux-arm64`, `darwin-arm64`; no Windows, no Intel macOS (`.github/workflows/release.yml`) |
| 5 | **First installation is one command**, an install script served from `https://lazurio.ai/install`, in the strict form `curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install \| sh`. It installs the CLI and the Launchpad (one program); then `lazurio update` takes over | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5867934763), [late afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869231172) | F20; root 0164 point 6, 0168 point 5 | Script and `--verify-release` built; attached to the `v0.1.8` pre-releases, not to a final release (latest final `v0.1.7`). The website route is **not served** ([#223](https://github.com/Lazurio/LazurioPlatform/issues/223)) |
| 6 | **npm is not the primary door.** The package `lazurio` may follow as a second door | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5867934763) (overrides the npm front door of the [morning](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5866787843)) | F20; root 0164 point 6 | **Not built**; `lazurio` is still unpublished on npm (404 on 2026-10-06) |
| 7 | **One standard installation on every Environment.** A deviation is reported and an agent straightens it by the manual; it is never kept as a supported variant | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5867934763) | F20 point 4; root 0164 point 7 | Built: `lazurio install` reports deviations and `lazurio install prompt` prints the agent's assignment |
| 8 | **No rollback and no back doors for it; Recovery mode instead.** A broken Lazurio offers only a repair agent or an issue with everything a fix needs; every entry ends in an issue | [afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5868604357), [late afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869231172), [evening](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869474451) | F21; root 0166 | Built in the pre-releases; `v0.1.7` still contains rollback |
| 9 | **The Platform Launchpad replaces the resident Launchpad**, with no side-by-side period and no transition hostname. The two-move switch plan drafted in this pull request keeps its facts and loses its plan | [afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5868604357) | F22; root 0167; [Launchpad parity](launchpad-parity.md) | Switch line in [Launchpad parity, E](launchpad-parity.md#e-slices) |
| 10 | **A Team Environment works with the Organization's bot**; `gh` is not signed in there | [afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5868604357) | F22 point 9; root 0168 | Built (P12) |
| 11 | **A release candidate soaks 8 hours** on the work VMs of the pilot Organization and the personal VMs of its operators before it becomes final; releases are staged | [late afternoon](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869231172), [night](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869623126), [night, second](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5869726141) | F21 point 5 | `qualify.yml` and the canary record built; no final release has passed it yet |
| 12 | **Documentation is finished at the very end**, after the open questions are answered | [2026-09-28](https://github.com/Lazurio/LazurioPlatform/issues/50#issuecomment-5866787843) | — | This document is shaping, not the user manual |

Decisions on #50 that do not concern distribution are recorded elsewhere: the rebuild
of hosted personal VMs on Ubuntu 24.04 with state transfer (F22 point 5), previews of a
worktree on a Remote Environment (F22 point 7), where a recovery issue is filed (F21
point 4), and OpenMausBot coming last.

## 2. First installation

**Built** ([product update, First installation](update.md#first-installation)):
`install.sh` needs only `curl` and `sha256sum` or `shasum`, holds every download and
redirect to HTTPS, checks the executable against the manifest digest before it runs,
and runs `<executable> install --verify-release <directory>`, so the downloaded
executable verifies its own release with the product's verifier before the first
write. A signed-in `gh` is an optional second check. It refuses Windows and Intel
macOS with one sentence and writes nothing (`install.sh`). The trust it gives, and does
not give, is stated in F20.

**Not yet usable as documented.** The documented door depends on two things that do
not exist on 2026-10-06 ([#223](https://github.com/Lazurio/LazurioPlatform/issues/223)):

- a final release carrying `install.sh`, because the route redirects to
  `releases/latest/download/install.sh` and `latest` is `v0.1.7`;
- the website route. Today `https://lazurio.ai/install` answers `200` with the
  website's HTML page, so the one-liner would hand HTML to `sh`. Until the route is
  live it must answer non-2xx.

Until then the script is served from this repository
(`https://raw.githubusercontent.com/Lazurio/LazurioPlatform/main/install.sh`), as
[product update](update.md#first-installation) says.

**The standard layout** (decision 7) per platform:

| | Install base | Command | Folder |
| --- | --- | --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/lazurio` | `~/.local/bin/lazurio` → `<base>/bin/lazurio` | `~/Lazurio` |
| macOS | `~/Library/Application Support/Lazurio` | same | `~/Lazurio` |
| Windows | **none** (`src/update/base.ts` answers no base) | — | — |

`lazurio install` creates `~/.local/bin/lazurio` by one atomic rename and never
overwrites an entry that is not Lazurio's; it reports `conflict` and warns when
another `lazurio` (the legacy root CLI linked by Bun into `~/.bun/bin`, for example)
resolves first (F17 addendum 2026-09-28). Shell profiles are never edited.

**npm, if it follows** (decision 6). Not scheduled. Should the second door be built,
the shape recommended in the 2026-09-28 draft still holds and is all that is kept of
its comparison: one unscoped package `lazurio` with no product bytes, no dependencies
and no lifecycle scripts; on first use it downloads the release, verifies it with the
product's own verifier and runs `install`; afterwards it only hands over to the
installed product. It never becomes a second updater (decision 1), and it is not
installed on Remote Environments, where it would compete for `~/.local/bin/lazurio`.
Per-platform binaries as npm optional dependencies and a JS/TS package run by Bun or
Node were rejected for creating a second updater and a second version truth. Claim
the name only with the first real publication: an unpublished name held in reserve
counts as squatting under npm's disputes policy.

## 3. Updates

All decided; the contracts are [product update](update.md),
[machine handover](machine-handover.md#what-the-machines-role-does-with-the-lazurio-version-f17-addendum-2026-09-28)
and F17. In short:

- **Who.** The operator, with `lazurio update` or the Launchpad's update pill, on a
  workstation and on a Remote Environment alike. Agents run it at the start of every
  piece of work and tell the operator what changed (F17 addendum 2026-10-02).
- **The rollout.** Installs when absent or broken, raises a version below the pin,
  never lowers one; a version above the pin is the fact `ahead`, not drift. The
  Machines role never runs `lazurio update`.
- **The Folder.** A product update never writes the Folder (F14). `update`, `update
  status` and the pill say "Folder refresh needed" with the exact command when the
  Folder records an older template revision.
- **A Team Environment.** Any of its operators may update; the update affects all of
  them, and the generated text says so (F17 addendum 2026-10-02, point 4). This
  answers question Q6 of the draft.
- **No way back.** `lazurio update rollback` is removed; a failed update stays on the
  new version in Recovery mode and is repaired forward (F21). The one switch-back the
  old updater may perform on the update to the first release without rollback is
  accepted (F21 point 7).

**Open** ([#224](https://github.com/Lazurio/LazurioPlatform/issues/224), Q5): an
Environment whose operator updated above the pin and whose installation then broke is
not repairable by a rollout until the pin reaches the high-water mark; a damaged
executable at the same version is not repaired by `install` either (F21, Open).
Recommended: in repair mode the Machines role stages the release equal to the
high-water mark.

## 4. Migration from the root repository

### 4.1 Who migrates which Environment

| Environment | Today | How it migrates | When |
| --- | --- | --- | --- |
| Remote Environment on Linux, delivered by Machines | The Folder already exists (`machine folder-init`); until its switch, the resident Launchpad runs from a copy of the root repository | **Machines**, in the one switch apply of F22 (slice M2): resident unit removed, the Platform's supervised unit installed, `launchpad.gen3*.json` removed. The agent only verifies | First, and under way: the first real Machine was switched on `0.1.8-rc.7` on 2026-09-29 (F25); which Environments are switched is Machines' record, not this repository's. Hosted personal VMs are rebuilt on Ubuntu 24.04 with state transfer (F22 point 5) |
| Linux computer with a root checkout | Root Git checkout, legacy CLI | **An agent** with the prepared prompt and manual (4.3) | With the Linux line, after slice S5 |
| macOS computer with a root checkout | Root Git checkout, legacy CLI linked by Bun, `.app` launcher | **An agent**, as above | After Linux; S5, then a canary (S6) |
| Windows computer with a root checkout | Root Git checkout, Start Menu link | Agent, **blocked**: no Windows build, install base or lock | After a Windows build (S10). Until then root installations on Windows keep working unchanged (root 0164 point 4) |

### 4.2 Topology: rename aside (recommendation; open, Q7)

The old checkout `<home>/Lazurio` is renamed to `<home>/Lazurio.legacy-<date>`. A new
Folder is created at `<home>/Lazurio`. `organizations/`, `personalspace/` and `drafts/`
are moved back into it by rename. Every Organization repository, worktree,
Personalspace and draft ends at **the same absolute path**, so Git's absolute worktree
links stay valid and nothing is copied or deleted.

The legacy tree is kept as evidence of what was there (unpushed root work, stashes,
unknown files), **never as a way back**: the migration is one-way (decision 3), offers
no reverse procedure, and a failure is repaired forward in the new Folder.

This amends the earlier "Confirmed one-way, in-place conversion" of
[migration and recovery](migration-and-recovery.md#confirmed-one-way-in-place-conversion),
which retires old product files inside the same directory. Both keep every path and
both are one-way; rename aside needs no classification of old files and deletes
nothing. Until Matěj decides
([#224](https://github.com/Lazurio/LazurioPlatform/issues/224), Q7), the in-place note
stands as written and implementation follows this recommendation. A new path for the
Folder was rejected: every absolute path would change, linked worktrees would break and
tool configurations would point to the old place.

### 4.3 Inventory of a root checkout and its fate

| What the user has | Where it is | Fate | Proof |
| --- | --- | --- | --- |
| Root Git checkout (`AGENTS.md`, `manual/`, `launchpad/`, `lazurio/`, scripts, templates) | tracked in `<home>/Lazurio` | **Stays** in the legacy tree; the Folder gets generated `AGENTS.md` and `manual/` (F14) | Root branches, stashes and worktrees with unpushed work listed in the report |
| Organizations `organizations/<Org>/` with modules, Production Space repositories, worktrees, repository databases | gitignored | **Moves** by one directory rename; contents never entered | Per repository: HEAD, `status --porcelain`, `stash list`, `worktree list` identical before and after |
| `personalspace/` | gitignored | **Moves** by rename; never listed or read | Same device and inode (`stat`), nothing more |
| `drafts/` | gitignored | **Moves** by rename (a workstation Folder keeps the operator's own top-level entries) | `worktree list` of each clone unchanged |
| `launchpad.gen3.json`, `launchpad.gen3.local.json` (Personalspace owner, planned slots) | tracked / gitignored | **Stay** in legacy. No successor (F22, open H5) | — |
| Legacy Launchpad state: `launchpad/runtime`, `launchpad/logs`; `server.json` and `server-lifetime-*.lock` in the OS state directory (on macOS the same directory as the install base) | gitignored / OS state | **Stays** until the legacy Launchpad is stopped, then removed by exact name; the Platform tolerates unknown entries in its base | `lazurio update status` healthy |
| Legacy CLI linked by Bun into `~/.bun/bin/lazurio` | home | **Unlinked last**, after proof. Same name, different meaning: legacy `lazurio update` synchronizes checkouts, the Platform's updates the product | `command -v lazurio` is `~/.local/bin/lazurio`; `lazurio --version --json` names `Lazurio/LazurioPlatform` |
| Root worktrees (`.worktrees/…`) and recovery stashes `lazurio-update:*` | gitignored / `refs/stash` | **Stay** in legacy; never applied or dropped. Root development ends with the archive | Unpushed work confirmed with the operator before the rename |
| Root skills `.agents/skills` and the `.claude/skills` mirror | tracked | **Not carried**; gap (section 5) | — |
| Organization skills and agent rules | inside Organization repositories | **Move** with the Organization | — |
| macOS `.app` launcher, Windows Start Menu link | home | **Renamed aside**: they would start the legacy tree | The old launcher no longer starts anything |
| Compatibility aliases (`<home>/Conglomerate`, `<home>/Conglomerate_GEN3`) | home | **Stay**; they resolve to the new Folder because the path is unchanged | `readlink` unchanged |
| Sign-ins and settings: `gh`, SSH keys, Git config, Codex and Claude Code configuration, MCP configurations | home or Organization repositories | **Never touched** | `gh auth status`; `git ls-remote` of one Organization root |
| Agent histories keyed by the working directory | harness-owned | **Never touched**; they keep working because the path is unchanged (observed on one computer; **unverified** as a harness contract) | — |
| Toolchain (Git, `gh`, Node, Bun, Codex, Claude Code) | operator's PATH | **Never touched** (0161) | `lazurio tools status` |
| Running legacy Launchpad and its applications | processes | **Stopped** before the rename | No listener on the legacy port; no process with a working directory inside the tree |

Observed on one operator's workstation, to size the real case: fifteen Organization
mounts, more than twenty root worktrees, more than two hundred local root branches and
several recovery stashes. The migration lists all of it and cleans none of it.

### 4.4 The agent's manual (to be written; slice S5)

One manual with a shared core and a section per platform, owned by this repository
(F14), printed with the prompt by a new `lazurio migration prompt`; the root
repository only points to it.

**Preconditions.** The operator's explicit instruction in the thread; a supported
target; a Platform release with workstation adoption; `gh auth status` succeeds; the
legacy tree and `<home>` on one filesystem; no merge, rebase, cherry-pick or `am` in
progress in the root or any Organization repository; no `.lazurio/` in `<home>/Lazurio`;
the agent's working directory **outside** `<home>/Lazurio`, so the rename does not move
its own shell.

| # | Step | Check before the next step |
| --- | --- | --- |
| 0 | Read-only inventory (`lazurio migration inspect`, not built): root HEAD, branches, stashes, worktrees with unpushed work; per Organization repository HEAD, status, stashes and worktrees; home links into the tree; running legacy processes. JSON report outside the tree | The operator confirms the root work that exists only on this computer |
| 1 | Install the Platform with the one-liner (section 2). Use `<base>/bin/lazurio` by absolute path until step 8, because the legacy CLI may still resolve first | `--version --json` names the Platform; `update status` healthy |
| 2 | Quiesce: stop the legacy Launchpad and its applications; close editors and terminals inside the tree | No listener, no process inside the tree |
| 3 | `mv <home>/Lazurio <home>/Lazurio.legacy-<date>` (one rename; also the lock against a second migration) | Legacy path present, `<home>/Lazurio` absent |
| 4 | `mkdir <home>/Lazurio`; rename `organizations`, `personalspace`, `drafts` into it | Same device and inode for each |
| 5 | `lazurio folder-init --folder <home>/Lazurio --adopt …` (**not built**: workstation `folder-init` today requires an absent path; only the hosted `machine folder-init` adopts) | `.lazurio/`, `AGENTS.md`, `manual/` present |
| 6 | Parity: repeat step 0 for Organization repositories | Identical |
| 7 | Smoke: open the Platform Launchpad; every Organization and its modules are listed; a new agent started in `<home>/Lazurio` names the Folder instructions it read | Reachable; agent names the Folder `AGENTS.md` |
| 8 | Switch the command: unlink the legacy CLI; `~/.local/bin/lazurio` present and on PATH (added to the login shell only with the operator's consent) | `command -v lazurio` as in 4.3 |
| 9 | Rename the legacy desktop launcher aside | — |
| 10 | Report: what moved, what stayed in the legacy tree, what is next | — |

**Never touched:** the contents and Git state of Organization repositories and the
Personalspace (no fetch, pull, reset, stash, clean, branch deletion or push); sign-ins,
keys, tokens and tool configuration; the operator's tools and their versions; anything
in the legacy tree.

**When a check fails.** No way back is offered. The agent stops at that step, reports
the step and the state, and repairs forward in the new Folder by the manual; what it
cannot repair goes into an issue with the inventory, as Recovery mode does (decision
8). State is recognized from disk alone:

| `<home>/Lazurio` | `Lazurio.legacy-*` | Meaning | Next |
| --- | --- | --- | --- |
| Root checkout (`.git`, no `.lazurio`) | absent | Not started, or stopped before step 3 | Start |
| absent | present | Stopped between steps 3 and 4 | Continue at step 4 |
| Directory without `.lazurio`, some mounts moved | present | Stopped in step 4 | Finish moving |
| `.lazurio` with a pending initialization journal | present | Stopped in step 5 | `lazurio folder-resume --folder <home>/Lazurio` ([machine handover](machine-handover.md)) |
| Finished Folder | present | Steps 6–10 | Continue verification |

**Per platform.** macOS: the install base shares its directory with the legacy server
state (4.3). Linux computers with a root checkout: a legacy Buddy bridge or resident
unit running from the checkout is a stop condition and goes to the hosted Buddy
manual. Windows (later): a rename fails while any handle is open; aliases are
junctions; `%LOCALAPPDATA%\Lazurio` is both the legacy server state and the planned
install base.

### 4.5 The prepared prompt (to be rendered in `cs` and `en` by `lazurio migration prompt`)

> Task: move this Environment from the legacy Lazurio root checkout at
> `<home>/Lazurio` to a Lazurio Folder at the same path, following the Lazurio
> migration manual for this operating system.
>
> First read the actual state and change nothing: run the read-only inventory from
> step 0 of the manual, show me the report, and list every root worktree or branch
> with work that exists only on this computer. Start only after I confirm, and work
> with your working directory outside `<home>/Lazurio`.
>
> Target state: the `lazurio` command on PATH is the installed Lazurio Platform;
> `<home>/Lazurio` is a Lazurio Folder; every Organization repository, the
> Personalspace and every draft is at the same path as before with the same Git state;
> the old checkout is kept, unchanged, at `<home>/Lazurio.legacy-<date>`.
>
> Never: read or list anything inside `personalspace/`; change the content or Git
> state of any Organization repository; copy instead of rename; delete anything;
> touch sign-ins, keys, tokens or tool configuration; update or reinstall a tool that
> works; put a secret into chat, Git or a log.
>
> After every step run its check. There is no way back to the old checkout. If a check
> fails or the state is not one the manual names, stop and tell me the step and the
> exact state, then repair forward by the manual; what you cannot repair, file as an
> issue with the inventory.

## 5. Before the root repository is archived

Decided (root 0164 point 1): the root repository is archived **after the last
Environment has migrated**, and Windows root installations keep working until their
own migration (point 4). So the archive comes after the Windows build and its
migration; question Q8 of the draft is answered. Archiving on GitHub makes the
repository read-only; clones and fetches keep working.

| Capability of the root | State in the Platform on `main` | Needed for | Slice |
| --- | --- | --- | --- |
| Command on PATH | Built: `~/.local/bin/lazurio` (F17 addendum) | migration | S2 |
| First installation | Script built; route and final release missing (section 2) | migration, new computers | S4 |
| Adoption of an existing directory on a workstation | **Not built** (`src/folder/initialize-folder.ts`: never adopts) | migration | S5, P14 |
| Read-only inventory, manual and prompt | **Not built** | migration | S5 |
| Launchpad over all Organizations | Built (P4) | daily work | — |
| Organization and Personalspace installation | Built (F9 addendum 2026-10-04 and 2026-10-05); synchronization **not built** (P10); agents fast-forward meanwhile (F17 addendum 2026-10-02) | new computers | S9, P10 |
| `lazurio doctor` | Built, read-only (P8) | daily work | — |
| `lazurio module …` lifecycle without a Launchpad session | Built on Linux (P5); on macOS the control socket is **not built** | daily work | P14 |
| Recovery mode instead of rollback | Built in the pre-releases (F21) | every Environment | — |
| Worktree discipline as a mechanism (root `worktrees:*`, `pr:preflight`) | Manual text only (F14); the browser Git client is not carried (F22 point 6) | daily work | S7 |
| Skills package and the Claude Code entry (`CLAUDE.md` → `AGENTS.md`) | **Not built**: the Folder generates `AGENTS.md` and `manual/` only; whether Claude Code reads `AGENTS.md` without a bridge is **unverified** | daily work | S7 |
| Desktop launcher (macOS `.app`) | **Not built** | non-technical operators | P15 |
| Windows install, Folder and lock | **Not built** | Windows users | S10 |
| Intel macOS | **Not built**; whether such users exist is **unknown** | only if they exist | — |
| `lazurio search`, local Guide | No consumer; not carried ([Launchpad parity, F](launchpad-parity.md#f-what-we-deliberately-do-not-carry-over)) | — | — |
| Root decision register and lasting root manuals | Open ([#224](https://github.com/Lazurio/LazurioPlatform/issues/224), Q9) | the archive | S11 |
| Open issues and pull requests of the root repository | Must be finished, transferred or closed | the archive | S11 |

Not determined: whether a Machines or Organization build depends on the root
repository beyond the resident artifact (the F22 switch removes that one); whether
Organization `AGENTS.md` files tell agents to run root scripts (`doctor:task`,
`pr:preflight`). Each Organization's rules need their own revision before its
Environments migrate.

## 6. Risks of repairing forward

The migration renames and never deletes; Organization and Personalspace data never
change. What remains:

| Risk | Why Git or an agent cannot fix it | Mitigation |
| --- | --- | --- |
| Untracked and ignored data (Personalspace, drafts, local secrets in Organization repositories, stashes, unpushed branches, root worktrees) | Git history does not hold it | Rename, never copy or delete; inventory before and after; the legacy tree is kept |
| The agent's own runtime | An agent cannot repair the harness it runs in; renaming the tree under its working directory moves its shell | Working directory outside the tree; the path `<home>/Lazurio` is kept; the legacy CLI stays until step 8 |
| A release with a bug in the updater | Only maintainers can publish the fix | Qualification and the 8-hour canary (F21 point 5); Recovery mode; the install script or an offline `install` of the fixed release |
| A release that changes Folder state | There is no program or data rollback | The next release repairs forward (F18, F21) |
| Sigstore unreachable on a cold trust cache | The installer and the updater refuse (`trust-unavailable`) | Accepted by F13; retry later |
| Two migrations at once | Two agents could interleave renames | Step 3's rename is atomic; the second agent's precondition fails |
| Same command, new meaning | Agents taught "run `lazurio update` first" by root rules now update the product | Harmless for data (F9); Organization rules need their own revision |
| The website route answers HTML | `curl -f` does not stop on `200` | [#223](https://github.com/Lazurio/LazurioPlatform/issues/223) |
| Windows | Renames fail on open handles; no product today | Windows waits for its build; a failed rename is a clean stop with nothing moved |

## 7. Order of work

Slice names are kept from the draft because [Launchpad parity](launchpad-parity.md)
cites them.

| # | Slice | Repository | State on `main` (2026-10-06) |
| --- | --- | --- | --- |
| S1 | Decisions: operator owns the version, pin is a minimum, first installation, no rollback, one-way migration | Platform, root | Done: F17 addendum, F20, F21, F22; root 0161 addendum, 0164, 0166–0168 |
| S2 | `~/.local/bin/lazurio`; hosted manual lets the operator update; "Folder refresh needed" | Platform | Done (F17 addendum); released only in pre-releases |
| S3 | Machines role: pin as a minimum, verify the PATH entry, never run `lazurio update` | Machines | Contract in [machine handover](machine-handover.md#what-the-machines-role-does-with-the-lazurio-version-f17-addendum-2026-09-28); implementation **unverified** here; repair above the pin open (Q5) |
| S4 | First installation: `install.sh` with `--verify-release`, attached to releases; the website route | Platform, website | Script done; route and first final release with it missing ([#223](https://github.com/Lazurio/LazurioPlatform/issues/223)). npm second door not scheduled |
| S8 | Hosted Linux Environments: the F22 switch apply (M2), resident removed | Machines, Platform | Under way since 2026-09-29 (F25); slices in [Launchpad parity, E](launchpad-parity.md#e-slices); first in order |
| S5 | Workstation adoption (`folder-init --adopt`), `migration inspect`, `migration prompt`, the manual of 4.4 | Platform | **Not built** |
| S6 | Canary of the workstation migration: one Linux computer, then macOS | — | After S5 |
| S7 | Daily-work gaps: worktree mechanism, skills and the Claude Code entry, macOS control socket (P14), desktop launcher (P15) | Platform | **Not built** |
| S9 | Content synchronization (F9, P10) | Platform | Installation done; synchronization **not built** |
| S10 | Windows build and its migration section | Platform | **Not built** |
| S11 | Archive: manuals and register moved (Q9), root issues and pull requests closed or transferred, root README becomes a pointer, archive | root and owners | After the last Environment, Windows included |

## 8. Questions of the 2026-09-28 draft

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Thin npm launcher under `lazurio`? | Superseded: npm is not the primary door; the launcher shape of section 2 holds if the second door is ever built |
| Q2 | npm package on Remote Environments? | No (section 2) |
| Q3 | Publish the launcher from `release.yml` with the product's version? | Deferred with Q1 |
| Q4 | May a rollout still move a working Lazurio forward? | Yes: the pin is a minimum (decision 2) |
| Q5 | Repair at the high-water release when the operator is above the pin? | **Open** ([#224](https://github.com/Lazurio/LazurioPlatform/issues/224)) |
| Q6 | May any operator of a Team Environment update? | Yes; the generated text says it affects all of them (F17 addendum 2026-10-02) |
| Q7 | Rename aside instead of in-place conversion? | **Open** ([#224](https://github.com/Lazurio/LazurioPlatform/issues/224)); recommendation followed meanwhile |
| Q8 | Archive before Windows users can migrate? | No: after the last Environment (root 0164) |
| Q9 | Where do the root register and lasting root manuals go? | **Open** ([#224](https://github.com/Lazurio/LazurioPlatform/issues/224)) |
| Q10 | When is the legacy tree deleted? | **Open** ([#224](https://github.com/Lazurio/LazurioPlatform/issues/224)); recommended: never by the migration, by the operator on instruction after 30 days of daily work without it |
