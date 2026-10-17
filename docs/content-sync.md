# Content synchronization

Status: **accepted direction of Matěj (2026-09-19). Installation of absent content
is implemented (2026-10-04, [F9 addendum](decisions.md#addendum-of-2026-10-04-content-installation-the-personalspace-and-the-presets),
root decision 0188); synchronization of existing repositories is not.** `lazurio
organization install`, `lazurio personalspace install` and the Launchpad's
`/api/content*` routes materialize absent repositories as described in
[Installation](#installation--implemented-2026-10-04). No Platform command fetches or
fast-forwards a repository today. This document is the contract for both operations
and for their separation from product update. See
[decision F9](decisions.md#f9--update-lazurio-and-synchronize-content-are-separate-operations).

## Two operations, never one

| | Update Lazurio | Synchronize content |
| --- | --- | --- |
| Subject | Installed product bytes | Organization repositories declared by an Organization |
| Contract | Product update contract (`docs/update.md`, separate PR) | This document |
| Entry | Its own command and button | Its own command and button |
| Lock | Product activation exclusion | Per-Organization content exclusion |
| Outcome | Selected version, or preserved previous version with a reason | Per-repository result list |

Neither starts the other, and a failure of one never blocks or implies the other.
Product update must never clone a repository, create a stash, switch a branch,
regenerate preferences, upgrade tools or run a data migration. Content synchronization
must never select, download or activate a product version.

## Explicit only

Synchronization runs only when an Operator or an authorized Task Agent invokes it for a
selected Organization. No first render, status request, health check, login, product
update or Launchpad start synchronizes anything. Read-only inspection may report that
content is behind; it fetches nothing.

## Hierarchy

1. Synchronize the Organization root repository.
2. Re-read the Organization manifest from the resulting commit. Children are taken
   from this fresh declaration, never from a manifest read before step 1.
3. Process the declared children: managed Organization-level repositories and
   workspace modules.

A failed or blocked root stops that Organization: its children are not processed from
a stale declaration. A failed or blocked child is reported individually; healthy
siblings continue. One invalid slot is a quarantine, not a global failure.

## Materialization of an absent repository

1. Validate the owner boundary: the destination is the exact declared path inside the
   selected Organization, contained, not a link, and under the expected custody.
2. Check provider rights for the exact repository through the intended identity.
3. Clone into a temporary sibling of the destination on the same filesystem.
4. Verify the clone: expected remote identity, expected branch and inspected commit.
5. Publish into the **absent** destination with a no-replace rename.

An occupied destination is never disposable. A directory that exists but is not the
expected repository is reported and left untouched; it is not moved, merged, emptied
or overwritten. An interrupted materialization leaves only its own temporary sibling,
which only the same operation kind may remove after recognizing it as its own.

## Existing repositories

Fetch, then fast-forward the default branch to the exact commit that was inspected
after the fetch. The operation changes a checkout only when all of these hold: clean
tracked and untracked state, the expected branch, no operation in progress
(merge, rebase, cherry-pick, bisect, am) and a strict fast-forward relation.

**Dirty or wrong-branch checkouts block by default.** Synchronization reports the
exact repository and reason and changes nothing in it. It does not create a recovery
stash, does not switch branches and does not reset.

This is a deliberate change from the legacy engine, which stores dirty work in a
recovery stash and returns the checkout to `main`. Preserved bytes in a stash still
interrupt active work, and on a team workspace the interrupted person is not the one
who clicked. Preserving work aside is a separate, explicit operation on one named
repository, never a side effect of synchronization. Upstream decision 0129 describes
the legacy behaviour; aligning it is a [required upstream
amendment](decisions.md#required-amendments-before-production-implementation).

Divergence (ahead or diverged default branch) and unsafe detached state are blocked.
Synchronization never resets, rebases or merges to resolve them; resolution belongs
to the person or Task Agent with that repository's context.

## Outside generic synchronization

Following the exclusions of upstream decision 0129, these are never synchronized,
materialized or inspected for cleanliness by this operation:

- Production Space repositories, which keep their own branch and release models;
- Personalspace, which is private to its Owner and absent from
  Organization-owned Machines;
- worktrees, including task and pull-request worktrees of any repository;
- repository databases, which publish through their own application contract.

Installation (below) is a different operation with its own rules: since decision F33
(1.1 point 4) it materializes absent Production Space repositories, and since the F9
addendum of 2026-10-04 it materializes the Personalspace on the two kinds of
Environment that hold one. Neither is ever fetched, fast-forwarded or prepared by it.
Since the B7 amendment of 2026-10-17 it also materializes the declared data mount
(`repository_db_mount`) of a module that is there after the same install, on its
declared branch, and never fetches or changes one that exists; worktrees stay outside
it.

## Identity and rights

Rights are checked at the operation boundary through the identity the workspace is
meant to use, as selected by its [workspace preset](workspace-presets.md):

- private workspace or local Machine: the Operator's own provider sign-in;
- team workspace: the brokered Organization identity, one short-lived
  repository-scoped token per operation.

Denied, revoked or unavailable access stops that repository's operation and preserves
local content. Synchronization never substitutes another identity, reuses a peer's
credential or treats a present checkout as proof of access. GitHub stays the authority.

## After content changes

Dependency preparation follows a successful content change through the module
contract ([module adoption](module-adoption.md)); it is the module's declared
preparation, invoked explicitly, not a hidden step of synchronization. Changing
dependencies beneath a running application is unsafe: synchronization and preparation
share the dependency owner's coordination boundary with
[OS-owned applications](module-adoption.md#application-lifetime--implemented-for-linux-session-scoped-on-macos),
and a running application blocks preparation of its own tree rather than being
stopped implicitly.

## Results

Each repository returns exactly one of `materialized`, `fast-forwarded`, `current`,
`blocked` (dirty, wrong-branch, diverged, detached, operation in progress, occupied
destination), `denied`, `unavailable` or `failed`, with locale-neutral reason codes.
CLI and Launchpad invoke the same use case and return equivalent results.

## Installation — implemented 2026-10-04

Matěj's decision of 2026-10-04 (root decision 0188, [F9 addendum](decisions.md#addendum-of-2026-10-04-content-installation-the-personalspace-and-the-presets)):
an Environment's content is put into its Folder by one explicit operation, through the
same core from the CLI and the Launchpad (`src/content/`). It materializes what is
absent and leaves everything present as it is; it never fetches, switches, resets or
stashes, never runs implicitly (no start, health check, status read, login or product
update triggers it) and never touches the installed product.

### What an Environment holds

The content follows the Environment's kind, which is the Folder's recorded preset
(`derivePreset` derives it from the handover; `src/content/model.ts` `contentScope`):

| Environment | Preset | Content |
| --- | --- | --- |
| The person's own computer | `local` | Its Organizations and the Personalspace |
| Personal Remote Environment | `hosted-personal` | Only the person's Personalspace, never an Organization repository; gh must work as the handover's owner (`github-identity-mismatch`) |
| Work Environment of one operator, Automated Environment | `hosted-organization-personal`, `hosted-organization-steward` | Only the Organization of its handover (`owner.organization`), never a Personalspace |
| Team Environment | `hosted-organization-team` | Prepared by the hosting (Machines); the operation answers `prepared-by-hosting` and does nothing |
| Public Environment (`entry.audience` `public`) | any | Only the Organization of its handover, read anonymously as a reader ([below](#a-public-environment-anonymous-reading)); never a Personalspace |

The Automated Environment uses the ordinary explicit installation under its
signed-in persona account (F9 amendment of 2026-10-12). Its preset describes the
working arrangement and responsible human; it does not require a hosting archive,
prove a Steward role, or grant repository access. Its repositories are ordinary
Git clones, including tracked internal symlinks. CLI and Settings → This Environment
use this same core; the content response owns UI availability. The first-run tour
for a person's own account is separate and is unchanged.

A request for an item the kind never holds is refused as a whole
(`not-for-this-environment`). The identity is gh's sign-in on this Environment, found
on the operator's PATH and run with the operator's home, as the Launchpad's other
GitHub reads run it; git is the operator's own git with the operator's configuration,
and for an HTTPS remote gets gh as its credential helper (`gh auth git-credential`), as
`gh repo clone` does. No token is read, passed on or printed.

### An Organization

Steps, in this fixed order: `access`, `root`, `modules`, `preparation`, `check`.

1. **access** — gh's account, then the root repository (below), then GitHub's answer
   for it through that account: it must exist, be readable and belong to the login.
   Then the person's **live role** in the Organization (review of root decision 0188,
   as the resident `lazurio organization install --role builder|steward` scopes it,
   and the Reader of decision F9's addendum of 2026-10-05),
   which GitHub must confirm through the same account before anything is cloned:
   **Admin** by an active Owner membership (`GET /user/memberships/orgs/<org>`, role
   `admin`, as `organization-owner.ts` reads it), **Steward** by `maintain` on the root
   repository (the Steward's grant, as `module-maintainer.ts` reads it), **Builder** by
   `write` on it (the resident's Builder gate reads WRITE), **Reader** by `read` or
   `triage` on it together with an active membership (any role, not pending): a public
   root answers `read` to every account, so the permission alone names no one of the
   Organization, and an outside collaborator who only reads is not a Reader. The CLI
   matches the resident and adds the Reader: `lazurio organization install <login>` is
   the Admin installation (the full one) and runs only for a verified Admin;
   `lazurio organization install <login> --role builder|steward|reader` is the
   role-scoped one (anyone may choose a narrower role GitHub confirms); `--role admin`
   does not exist. The resident CLI knows no `--role reader`. The Launchpad picks the
   form from the live role, in the order Admin, Steward, Builder, Reader. A role GitHub
   does not confirm, the bare form for anyone but a verified Admin (its failure names
   the `--role` forms), or a live resolution that finds none of the four fails closed
   with `role-unverified`. The role decides scope only, never access, and nothing is
   recorded. A Reader's clones are ordinary clones: they are read-only because GitHub
   refuses the account's pushes, and nothing in installation, the product update or
   the doctor asks for write on a repository (pulling a clean checkout with
   `git pull --ff-only` needs read only).
2. **root** — present in the Folder (an Organization of the catalog whose canonical
   manifest binds the login): taken as it is. Absent: cloned into a temporary sibling
   `organizations/.<name>.lazurio-content-<random>/checkout`, verified (the `origin`
   is the expected repository, `HEAD` is `main`, the inspected commit, and the clone's
   own `lazurio.organization.json` resolves, is an Organization, binds the login and
   names exactly this repository in `root_repository`, the same criterion as the
   lookup below; a commit that does not declare itself the root is never published,
   `root-declaration-mismatch`), then published
   to the absent `organizations/<repository name>` with a no-replace rename
   (`renamex_np(RENAME_EXCL)` on macOS, `renameat2(RENAME_NOREPLACE)` on Linux). An
   occupied destination is never touched (`destination-occupied`).
3. **modules** — the children are re-read from the root as it now is: the workspace
   modules, the root-level applications (`mission-control`, `design-system`) and the
   Production Space repositories (decision F33, 1.1 point 4), each with a GitHub
   remote in its slot. A declared data mount (`materialization:
   "repository_db_mount"` at `mission-control/db` or `workspace/<module>/db`) follows
   its module (B7, amended 2026-10-17): materialized on its declared `git.branch`
   (often `v3`) by the same function as the modules when the module is materialized or
   present in this install, `excluded` when it is not; an empty directory at its place
   counts as absent. A present checkout is reported as for any child (`present`, or
   `blocked` for another repository) and never changed. `infra` and a database slot
   declared otherwise are left out (`excluded`). The role scope comes first: a restricted (Admin-only,
   `default_access` `restricted` or `private`) slot and every slot below it are in
   scope only for a verified Admin; for a Steward, Builder or Reader they are
   `excluded_by_role_scope` without any provider operation. A slot whose access
   declaration (its own or one above it) is malformed (`classifySlotAccess` →
   `unknown`) is `blocked` (`access-classification-unknown`) for every role, also
   without a provider operation. Each other child is checked through gh
   (`denied` when GitHub answers 404 or no read permission, `unavailable` when it does
   not answer), materialized like the root, or reported `present` (a checkout of the
   same repository) or `blocked` (anything else there). One child's result never
   stops its siblings; unreachable children are reported, not failures of the run.
   Unlike the resident's role gate, a Builder's or Steward's missing WRITE on one
   child repository does not block the whole install: the role is confirmed on the
   root, and each child is cloned when it can be read. A Reader gets the same children
   as a Builder, cloned with read.
4. **preparation** — the declared preparation (`lazurio.preparation`, decision F34)
   of each module this run cloned, through the module core's `prepare` (the same as
   `lazurio module prepare`). Production Space repositories are never prepared. A
   refused preparation (for example `toolchain-missing`) is reported in the step's
   detail and does not fail the run: a start prepares again when the declared check
   fails (F34). Nothing cloned: `skipped`.
5. **check** — the doctor's checks of this Organization in the catalog
   (`catalogChecks`): the Organization must be executable; modules with a reason are
   counted in the detail.

### A public Environment: anonymous reading

A public Environment (root decision 0204, [F55's addendum of
2026-10-17](decisions.md#addendum-of-2026-10-17-a-public-environment-has-no-github-identity))
has no GitHub identity at all: no broker, no App installation token and no person's
sign-in; `gh` is signed out. The recorded entry decides it (`githubIdentity`, the
same rule as the generated texts), whatever the preset, so a Team Environment with the
member is no longer `prepared-by-hosting`. The same five steps run, with these
differences only (`scope.github` `anonymous` in `src/content/model.ts`):

- **access** asks GitHub nothing: no gh account, no repository, membership or
  declaration read. The role is the Reader's (restricted slots and what is below them
  `excluded_by_role_scope`); only the Reader's role may be asked for, any other one
  fails closed (`role-unverified`), the CLI's bare Admin form included. The root is the
  one the Folder holds, the named `--root`, or the name candidate `<login>/<login>_GEN3`;
  there is no scan, which would read the Organization's listing and one declaration
  per repository through GitHub's unauthenticated API (60 requests an hour per
  address, shared by every visitor of that address). The candidate is verified in the
  clone, as every source is (`root-declaration-mismatch`). The handover names the
  Organization by its lowercase slug, so the root is published under the repository
  name its own verified declaration spells (`root_repository.locator`, which may differ
  from the request by letter case only): `organizations/<Org>_GEN3` as every member's
  install names it, also on a case-sensitive filesystem. The occupied check covers that
  name in any letter case, also when an entry appears while the root is cloned.
  Children keep the paths their slots declare.
- **root** and **modules** clone exactly `https://github.com/<owner>/<repository>.git`
  (anything else fails before any process) with an isolated git: the process gets only
  PATH, a locale and an empty temporary home, with no system, global or XDG configuration
  and nothing injected through the environment (`GIT_CONFIG_*`, `GIT_CONFIG_PARAMETERS`),
  no credential, askpass or SSH helper and HTTPS the only protocol
  (`anonymousGitEnvironment` in `src/content/git.ts`). So no `http.extraHeader`,
  credential helper, `insteadOf` rewrite (to another host or to SSH) or `core.sshCommand`
  of the operator, a visitor or this process reaches the clone (review of #472). A
  child is not asked of GitHub before its clone, so one that anonymous Git cannot read
  (private or absent) is reported `failed` (`clone-failed`), not `denied`.
- Nothing is created, generated, granted, committed or pushed: the Personalspace is
  refused (`not-for-this-environment`), and the Organization path has no such step.

Everything else, the temporary sibling, the verification, the no-replace publish,
the preparation and the check, is the same code. Without the member nothing changes.

### The Personalspace

Steps: `find`, `create`, `clone`, `bootstrap` and `push` (the three only when it
creates), `check`; for any other Personalspace `bootstrap` is reported `skipped`
with what it found.

- **Recognition.** The Personalspace of GitHub account `<login>` is
  `<login>/<login>_GEN3` in `personalspace/<login>_GEN3`, the naming the resident
  Lazurio creates (`scripts/create-personalspace.mjs`) and its Launchpad checks
  (folder name, owner and repository must match). It must be private and owned by
  the account (`personalspace-public`, `personalspace-not-owned`). GitHub's
  `template_repository` is **not** the recognition: a Personalspace created before the
  template existed has none (observed on the maintainers' own, 2026-10-04), so a
  template rule would create a second Personalspace for exactly the people who have
  one. The template link is used only as a guard: when `<login>/<login>_GEN3` is
  absent but a repository of the account was created from
  `Lazurio/PersonalspaceTemplate_GEN3` under another name (a renamed repository, a
  login renamed later), nothing is created (`personalspace-elsewhere`) and the person
  decides.
- **Present locally** (exactly one directory in `personalspace/`, the rule the
  catalog reads by): it counts only when it is the account's own Personalspace, as a
  clone would require: the directory is `<login>_GEN3`, its `origin` is
  `<login>/<login>_GEN3`, and GitHub knows that repository as the account's own
  (`personalspace-not-owned`) and private (`personalspace-public`). Then `find` done,
  `clone` skipped, `check`. A checkout of another account, or under another name, is
  `personalspace-foreign`: nothing is touched. `GET /api/content` makes the same
  decision (`verifyPersonalspaceCheckout`): it reports the Personalspace `present` only
  when verified, and otherwise `blocked` with the reason (`personalspace-foreign`,
  `-not-owned`, `-public`, `github-unavailable`, `github-signed-out`,
  `github-identity-mismatch`). So do the catalog, the module lifecycle and Nová karta
  (Lazurio/LazurioPlatform#186, decision F9's addendum of 2026-10-05): one decision
  whose Personalspace this Environment holds (`personalspaceHolder`), by the GitHub
  account its gh is signed in with and, on a personal Remote Environment, only for the
  handover's Owner. Anything else is listed blocked with its reason and no modules, and
  none of it is read or started. The Launchpad remembers the decision for a minute; the
  page's catalog shows the last one and never waits for GitHub.
- **Exists on GitHub:** cloned only. **Missing:** created from
  `Lazurio/PersonalspaceTemplate_GEN3` as a **private** repository of the account
  (`POST /repos/{template}/generate`, `private: true`), refused when GitHub reports it
  not private (`personalspace-not-private`), awaited until its `main` exists, then
  cloned and set up by the template's own bootstrap
  ([F9 addendum of 2026-10-14](decisions.md#addendum-of-2026-10-14-the-install-runs-the-templates-own-bootstrap), #377).
- **The template's bootstrap** (only for the Personalspace this run created). Before
  anything is created, `create` asks for what the setup needs: Bun (`~/.local/bin/bun`,
  else on the PATH; `personalspace-toolchain-missing`) and an identity to commit with:
  the operator's own Git identity (`user.name`, `user.email`) where it is set, else
  the person's GitHub identity (the profile's name, else the login, and `<id>+<login>@users.noreply.github.com`) given per commit with `git -c`, never written by this install, for an Environment whose gh was not signed in through Lazurio (the curated gh sign-in sets the same identity globally where it is missing: [F19 addendum of 2026-10-14](decisions.md#f19--curated-installation-and-login-of-catalog-tools)) (`git-identity-missing`
  only when neither is known). After the clone, `bootstrap`
  checks that the checkout is clean and carries the template's marker
  `personalspace.template.json` (`personalspace-template-unexpected`), then runs
  `bun run --cwd <checkout> bootstrap -- --login <login> --display-name <name> --apply`
  with the operator's gh and git: the template names the owner in `personal.gen3.json`
  and `modules.manifest.json` and creates and clones the private
  `<login>/<login>-gbrain` (root decision 0046). The name is the GitHub profile's,
  else the login. `--install-gbrain` is not passed: installing the gbrain CLI stays the
  person's choice, and the template's own rule accepts a doctor that is `incomplete`
  only for that deferred `gbrain.cli`. The Platform writes neither file; it reads what
  the template wrote and requires it to name the signed-in account with a gbrain
  repository. A failed bootstrap is `personalspace-bootstrap-failed` with the
  template's own reason: the repository stays created and cloned, nothing is
  committed, pushed or removed, and the detail names the next step (fix the cause, run
  the same command in the checkout, then commit and push as the template's manual,
  step 7, says).
- **push** commits exactly the files the template's manual names, with its messages:
  `personal.gen3.json` and `modules.manifest.json` to `main` of the new Personalspace,
  and `gbrain/.gitignore` to `main` of the new gbrain repository
  (`personalspace-commit-failed`, `personalspace-push-failed`, `gbrain-commit-failed`,
  `gbrain-push-failed`). Both repositories were created by the same run a moment
  before, so this completes their creation and overwrites nobody's work.
- **An existing Personalspace is never bootstrapped**, present or cloned now: its
  `main` is the person's Publication, and the bootstrap would run code of a
  repository this run did not create. `bootstrap` is `skipped`: when its
  declarations name an owner, with that owner; when they still hold the template's
  placeholders (`owner-github-username`), the item succeeds with the warning
  `personalspace-placeholders` (`warnings` of the item) and the step's detail names
  the next step: in a task worktree (`personalspace/.worktrees/<task>`) run the
  template's bootstrap, commit the two files and open a pull request into the
  Personalspace. The template's bootstrap supports a task worktree: it writes only
  into the worktree and keeps `gbrain/` in the primary checkout.
- **Under a Lazurio Folder.** The template recognises the Platform's Folder
  (`.lazurio/preferences.json`) above `personalspace/`, as it recognises the Lazurio
  root by `launchpad.gen3.json`; a Folder outside any Git repository has no root
  repository the mount could leak into, so the root's Git checks do not apply there
  (Lazurio/PersonalspaceTemplate_GEN3, "Co bootstrap kontroluje nad
  `personalspace/`").

### One operation at a time, and its leftovers

A kernel `flock` per Folder in the install base (`<base>/content/content-<digest>.lock`,
beside the product's `update/lock`; the Folder's `.lazurio/` admits no foreign entry)
serializes the CLI and the Launchpad (`content-busy`). It is coordination only: an
interrupted run leaves only its temporary sibling, whose exact name and marker file
(`.lazurio-content`) identify it; the next run that materializes the same destination
removes it under the lock. A lookalike without the marker is left untouched, and no
read (status, catalog) removes anything.

### Surfaces

- `lazurio organization install <github-login> [--role builder|steward|reader] [--root <owner>/<repository>] [--folder <Folder>] [--json]`
  (`--root` is the explicit source of [the root](#where-the-root-repository-is), verified
  the same way)
  and `lazurio personalspace install [--folder <Folder>] [--json]`: one line per step
  event (`{"kind":"content-step","item":…,"key":…,"state":…,"detail"?,"code"?}` with
  `--json`), then the result (`{"kind":"content-install","state":…,"items":[…],"failure"?}`).
  Exit 0 installed, 1 failed, 2 usage or not allowed here.
- `GET /api/content`: `{ allowed, reason?, items }`; an Organization item is
  `{ kind, login, name?, state, reason? }`, the Personalspace
  `{ kind, login, state, onGitHub?, reason? }`, `state` one of `absent`, `present`,
  `blocked`. One gh read for the account, one more for the Personalspace; the
  Launchpad reuses the decision about a present one for a minute (#186).
- `POST /api/content/install` with `{}` (everything the Environment holds: on a
  workstation the Organizations already in the Folder and the Personalspace) or
  `{ "items": [ { "kind": "organization", "login": "…" } | { "kind": "personalspace" } ] }`:
  `202 { "job" }`, `409 { "error": "busy", "job"? }` (without `job` when another
  process holds the lock), `403 { "error": "not-allowed", "reason" }`, `400` for a
  malformed body. Same admission as every write (`/api/tools/update`). Where the
  Environment signs in as its person, also `403` with `"reason": "ai-missing"` while its
  AI is provably missing (root decision 0201 point 3, [F36's addendum of
  2026-10-15](decisions.md#f36-addendum-of-2026-10-15-začínáme-the-basics-from-live-facts-ai-first-root-decision-0201)):
  the content never starts before an agent could help with it.
- `GET /api/content/root-access?org=<login>`: `{ kind: "root-access", write }`, whether
  this Environment's GitHub identity can prepare that Organization's root (an active Owner,
  or `write` on `<login>/<login>_GEN3`). Only for the Organization whose newest installation
  stopped at `root-not-found` or `organization-unreadable`; for any other the same
  `write: false` without asking GitHub.
- `GET /api/content/jobs/<id>`: `{ id, state: running|succeeded|failed, steps, failure? }`;
  `steps` holds the latest state of each step, `item` is the request item
  (`{ kind: "organization", login }` or `{ kind: "personalspace" }`), a failed step has a
  stable `code` and an English `detail` for agents. Jobs are in the Launchpad's memory;
  the last 16 stay readable.
- `GET /api/content/jobs/latest`: the newest of them in the same shape, `404` before the
  first. The Launchpad page reads it on load, so a reload, another tab or another device
  shows the same run or stop as the page that started it, and the line in Apps agrees
  with the shell document's `setup`, which reads the same newest job.

Failure codes are `contentFailureCodes` in `src/content/model.ts`; the Organization
`check` fails with the catalog's own reason (`organization-conflict`, …).

### Where the root repository is

**Decided by Matěj on 2026-10-05 (root decision 0188): a name is never trusted, it is
only a candidate, accepted after the repository declares itself the root.** A
repository declares itself the root of login `L` when its own
`lazurio.organization.json` on its default branch, read through the Environment's gh
before anything is cloned, is an Organization (not a template) whose
`organization.forge_binding.locator` is `L` and whose `root_repository.locator` names
exactly that repository. The install verifies the cloned commit once more before
publishing it (`root-declaration-mismatch`).

**The target source is the Dashboard's Organization record, fed by the Organization's
Lazurio for GitHub app installation.** It does not exist yet; finding the candidate by
name and by scan is the interim way until it does. The verification stays with every
source, the Dashboard included: a named root is accepted only after it declares itself
the root.

`resolveOrganizationRootRepository` (`src/content/organization-root.ts`) takes an
Organization the Folder already holds as its own root, and otherwise asks one typed
list of sources in order:

| Source | Kind | When it finds nothing | When its repository does not declare itself |
| --- | --- | --- | --- |
| `explicit`: the CLI's `--root <owner>/<repository>` | Named | Next source | `root-declaration-mismatch`, no other source |
| `dashboard`: the Dashboard's Organization record (**target; not wired yet**) | Named | Next source | `root-declaration-mismatch`, no other source |
| `name-candidate`: `<login>/<login>_GEN3`, the resident's name (interim) | Discovery | Next source | Next source |
| `scan`: the Organization's repositories this account can read, not archived (interim) | Discovery | `root-not-found` | Exactly one that declares itself is accepted; several are `root-ambiguous` |

A named source that names a repository of another owner is `root-owner-mismatch`
before GitHub is asked; a source GitHub does not answer is `github-unavailable`, never
"absent". The scan reads at most 1 000 repositories, eight at a time. The role rules
above are unchanged and run after the root is known.

## What this does not mean

- It is not a port of the legacy updater's source-root update; the product is not a
  repository on the Machine.
- It does not make Platform an Organization reconciler running in the background.
- It does not grant, cache or infer provider access.
- Synchronization (fetch, fast-forward of existing repositories) is not implemented;
  installation of absent content is, and it runs only when a person or an authorized
  Task Agent invokes it for their own Environment.
