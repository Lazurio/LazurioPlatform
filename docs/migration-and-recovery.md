# Migration and recovery contract

Status: design and acceptance requirements. No operation described here has been
run against an active installation by this preparation. A compiled proof is not an
installer. Each future mutator must refuse unrecognized state before its first write.

## Three independent transactions

| Operation | Reads | May change | Must not change |
| --- | --- | --- | --- |
| Product upgrade | Authenticated release metadata, installed version, compatibility, current profile revision | Staged product version and its compatible generated output, activation pointer | Repo history, worktrees, Personalspace, module content, user preference intent |
| Profile update | Current preferences, expected revision, installed templates and ownership manifest | Versioned preferences and enumerated generated instructions/config | Installed software, credentials, repositories, runtime data, grants |
| Legacy source-working → Lazurio Environment migration | Exact source inventory, mount/Git/process state, supported destination, approved plan | Lazurio Folder placement and ownership transition using a dedicated migration procedure | Work loss, silent branch reset, remote rewrite, secret copying or automatic publish |

Organization Git synchronization remains an explicit existing operation. Do not hide
fetch, checkout, stash creation or reset inside product/profile update.

A working profile belongs to the individual Machine installation. Changing it here
does not update any other Machine used by the same Principal. Profile transport or
copy is outside this first capability; no automatic sync is part of upgrade.

## Shared local migration use case

The official installed CLI can complete migration without a running Launchpad, source
checkout or separate Folder Factory installation. CLI and Launchpad invoke the same
application-core use case; neither carries its own migration implementation. The core
orchestrates inventory, approved plan, verified checkpoint, transition and recovery
through platform adapters. Folder Factory supplies only profile-based owned content.

Equivalent inputs, authority and initial state must yield equivalent plans, checks,
effects and recovery outcomes through either interface. Both share the same operation
lock and recovery state; simultaneous CLI/Launchpad requests cannot create two writers.
UI presentation may differ. No command names, packaging split or new service are selected
here, and these requirements do not claim an implemented migrator.

## macOS Lazurio Folder compatibility aliases

The target macOS layout has exactly one real Lazurio Folder at `<home>/Lazurio`.
`<home>/Conglomerate` and `<home>/Conglomerate_GEN3` are compatibility symlinks to
that folder so historical chats and tools using either absolute path continue to
resolve the same files. The aliases are not additional Environments, writable replicas
or evidence that the legacy Conglomerate product meaning is current.

The eventual migration is a shared local-core operation exposed by CLI and Launchpad.
Folder Factory supplies the owned content contract, not the Git migration plan. Neither this source checkout nor a
remote Dashboard mutates a Machine directly. macOS is the first explicit adapter;
Windows and Linux require separate path/link evidence and must not inherit symlink
assumptions.

Before the first write, inspect all three paths with `lstat`, `readlink` and canonical
path resolution; inventory nested Git/worktree state and active writers; and identify
one authoritative populated tree. If more than one distinct real tree contains data,
the target is occupied, a symlink points elsewhere, or the state is not understood,
stop with a no-op report. Never merge or recursively copy the trees merely because
their basenames are recognized.

After a verified checkpoint and quiescence, move the one authoritative real directory
to `<home>/Lazurio` only when the destination is absent. Validate that canonical Folder
through Doctor, then create both legacy symlinks. An already-correct symlink is an
idempotent success. Journal the exact pre-state, move and link operations so interruption
can resume or report a bounded repair instead of guessing.

Before new writes, rollback may restore the original real basename and remove only
aliases created by the recorded operation. After new writes, keep the same canonical
Folder and perform forward repair; never recreate independent copies or discard newer
work. Do not remove the aliases while supported consumers or historical chat paths may
still reference them.

## Common mutation discipline

1. Identify Principal, Machine Owner and parent provider/operator boundary. Check
   exact filesystem/remote identity, platform capability and necessary live rights.
2. Acquire one owner-controlled operation lock and capture expected current revision.
   A stale lock is not deleted on age alone; verify owner process and recovery state.
3. Build a read-only plan. Enumerate owned paths, expected old digests, target schema,
   disk requirements, compatibility, running consumers and recovery checkpoint.
4. Stage in the same filesystem where atomic replacement is promised. Verify
   authenticated artifact provenance, digest, archive path containment, permissions,
   platform and no symlink/hardlink traversal. Refuse unsupported mounts/case collisions.
5. Recheck lock, fingerprint, preference revision and running-process policy before
   activation. An intervening edit invalidates the plan and requires a new preview.
6. Activate one coherent generation. Persist enough local non-secret operation state
   to distinguish prepared, activated and validated states after a crash. Do not build
   a second general workflow database: the installed manifest and bounded journal
   belong to the installer, not to access authority.
7. Verify the actual installed command and affected consumers using the activated
   version. CLI migration does not require launching the graphical interface; verify
   Launchpad readiness when it is an affected running consumer. On failure retain or restore the compatible prior generation. Report
   exact state and recovery action, never success merely because files copied.

POSIX rename and native Windows replacement/locking behavior need separate adapter
tests. Do not assert multi-file atomicity by independently renaming files. Prefer
immutable generation directories plus one activation record, with a supported
Windows launcher/selection mechanism proven before accepting the layout. Preserve
old versions until no running process references them and retention gates pass.

### Proposed first instruction-write transaction

The read-only development code currently treats root `AGENTS.md` as a regular file.
Ordinary harness discovery reads that path, not an application generation pointer;
the inventory adapter deliberately rejects symlinks. Therefore a pointer-only switch
is not an implementation of instruction activation. This proposal qualifies the
immutable-generation preference above for the first, single-output consumer; it is
not a claim that a writer, persisted schema or recovery mechanism already exists.

Keep canonical preferences and custom instruction source separate from derived output.
Before implementing writes, define their schema and the ownership manifest together
with the existing local operation owner. Stage one validated instruction file on the
same filesystem. Under one shared operation lock, recheck the expected revision,
target identity and digest; an unowned, edited or unsafe target remains a refusal.
Use a native-qualified regular-file replacement as the visible activation point.
Fresh creation must not overwrite a file that appeared after planning.

The ownership manifest and bounded recovery journal describe preparation and the
observed replacement outcome. Recover by inspecting both journal and actual bytes;
do not trust a phase label alone or blindly overwrite post-interruption user edits.
Preferences, manifest and root file are not one filesystem-atomic write. Consumers
of the local core must refuse incomplete transactions until reconciled. Immutable
generation snapshots may retain source and recovery evidence, but no independent
pointer may contradict which root instructions are actually visible.

This bounded one-file mechanism cannot complete multi-file generation acceptance.
Before adding more generated files, prove coherent reader selection or an equivalent
qualified transaction protocol; independent file renames do not suffice. Keep all
Organization and Personalspace paths outside the write set. Session pinning still
requires actual harness evidence: a file replacement cannot by itself guarantee
that an already-running agent retains its previous instruction snapshot.

Required fixtures cover fresh-create races, manual edits, stale revisions, competing
invocations, interruption before and after every journal/replacement boundary,
interrupted recovery, permissions, disk exhaustion and link rejection, with exact
unrelated-file preservation. Qualify filesystem replacement separately on each
supported native OS. No real Folder write or migration is authorized by this proposal.

### Development state schema for this consumer

`src/folder/state.ts` defines a testable version-1 candidate for the single-output
transaction, not a released storage API or an installed state directory:

- Preferences own a positive safe-integer revision, the composed profile and verbatim
  custom instruction source. They contain no effective authorization or credentials.
- The generated manifest separately records its preference revision, template revision
  and the digest of the only supported output, root `AGENTS.md`. Arbitrary paths and
  Organization/Personalspace outputs are rejected.
- Both parsers reject unknown versions/fields and executable accessor fields, returning
  immutable snapshots. Parsing proves structure, not trusted custody or ownership.
- The shared configured-preview consumer rejects mismatched preference/manifest revisions
  before inventory. Nonempty custom source currently stops with an explicit unsupported
  composition error; it is never silently omitted from generated output.

The filesystem owner must still establish trusted state custody and the operation lock.
No JSON imported by a caller can prove ownership of an existing file. Durable storage,
journal schema, creation/replacement and durable recovery remain unimplemented. There is
no second locator or workflow service. Custom composition/conflict handling and actual
CLI/Launchpad state loading must precede claims of usable persistent preferences.

The development POSIX adapter `withFolderOperationLock` uses atomic creation of
`.operation-lock` within an explicitly supplied, canonical, caller-owned stable
state directory. It does not discover or create an installed state location. All
consumers must bind the same existing operation owner; selecting different directories
does not provide mutual exclusion. It exposes a held-lock recheck before mutation,
checks directory identities, and removes only its own empty lock on callback exit.
Unexpected lock content or replacement is retained as an error. A terminated process
leaves a blocking lock; age, PID absence or guessed completion never automatically
reclaims it. Journal-aware operator recovery remains to be implemented. Callback
exceptions release an otherwise unchanged lock, so the caller must inspect pending
transaction recovery under every acquired lock before doing new work.

Tests currently exercise native macOS fixtures, contention, callback failure,
process termination and preservation of unexpected lock contents. This is cooperative
local exclusion, not a security boundary against same-user attackers or ancestor
replacement, and not evidence for Windows/network filesystems or durable transactions.

## Product upgrade and profile rollback

### Development preparation writer

`prepareProfileChange` recomputes the profile-change plan under the same Folder
operation lock, then exclusively creates `.lazurio/transaction`. It writes a before
snapshot, proposed preferences/manifest and staged `AGENTS.md` using exclusive file
creation and file sync. A final `prepared.json` marker records expected/next revisions
and the staged file identity/digest after rechecking active instruction bytes and
identity. Directory sync is requested as well. All stage paths are fixed and bounded;
Organization/Personalspace and active preferences/instructions are not written.

This is preparation only, not activation or completed recovery. The marker is not
proof of application or a reusable authorization token. Incomplete preparation is
retained, including an empty transaction directory, and blocks subsequent ordinary
inspection/preparation. Never remove it by age or assume that an exception means no
staging happened. An unchanged/stale request creates no transaction. No CLI command
currently exposes preparation; tests use only newly created synthetic fixtures.

Current native macOS tests inject exceptions after each preparation checkpoint and
verify exact active-state preservation and retained evidence. They do not prove power-
loss durability, Windows/Linux writer qualification or successful forward recovery.
The activation/recovery consumer must validate staged schemas, bytes, file identities,
current revisions and unchanged active state under the lock before applying anything.
The bounded journal format remains development-only until that consumer is implemented
and its crash/recovery tests pass. Fresh Folder initialization is a separate missing path.

The development `planProfileChange` use case prepares one coherent next preference
revision and output manifest without writing either. It requires a matching expected
revision, matching current preference/manifest revision and current-template output
digest, and unchanged observed owned bytes. Stale state, manual edits, unsupported
template upgrades, OS changes, unsupported custom composition and revision exhaustion
return blocked results. A no-op does not advance the revision. It neither changes
software nor grants access. The future writer must obtain trusted state under the
shared lock and revalidate before applying; a returned plan is not an authorization
or durable transaction. CLI/UI transport and persistence are still required consumers.

The development `inspectProfileChange` adapter binds this planner to an explicit
canonical owned Folder and its single `.lazurio` metadata directory under the shared
lock. It no longer accepts an alternate state-directory argument. Its state reader
uses `.lazurio/preferences.json` and `.lazurio/instructions.json`; every operation on
the same Folder must use `.lazurio/.operation-lock`. This folder-relative binding
avoids an independently writable global Folder registry and prevents cooperating
callers from selecting different state owners for the same Folder. Symlinked Folder
or metadata paths are rejected. Existing unknown metadata is preserved and blocks
use; the name alone is not proof of ownership, an import or a migration permission.
Installed creation/upgrade still require the custody and transaction gates. The reader rejects
nonregular/linked/shared-writable files, changed read snapshots, malformed UTF-8/JSON
and unknown entries that could represent pending transaction recovery. Each JSON
document is bounded to 16 MiB by the development decoder, not a published custom-profile
size promise. A missing file is an error, not permission to initialize fresh state.
Only the ephemeral lock is created/removed; source, manifest, instructions and user
files remain unchanged. Actual persistence, journal recovery and installed CLI/UI
integration are not supplied by this read-only adapter.

The release declares supported preferences and generated-manifest versions. Backward
read compatibility is checked before stage; write compatibility and rollback support
are checked before activation. Keep the original preference snapshot and exact prior
product/profile artifacts. A forward migration that makes old software unable to
read new state is an explicit no-automatic-rollback boundary. Restore the coherent
old product and preference generation only if subsequent work can be preserved;
otherwise stop for forward repair rather than start an old binary on incompatible data.

A profile update renders deterministic output without host secrets. It changes only
paths named in its ownership manifest, each matched to the expected old digest.
Untracked/unknown paths and edited generated files are preserved and block conflicting
replacement. Removed generated paths can be deleted only if still owned and unchanged.
New sessions select the new generation; existing sessions keep a pinned snapshot and
show restart-required state. Profile rollback is a new checked activation, not an
unconditional restoration over edits made since the previous activation.

Do not terminate unrelated processes to complete an update. Query the lifecycle owner,
request a bounded drain of affected managed processes and preserve open agent sessions.
If a running consumer cannot safely move, leave its old version installed and report
pending activation or require an explicit maintenance window.

## Legacy source-working directory inventory and preservation

Migration must run on each actual machine only after consent to its exact plan. The
supported Lazurio Folder is `<home>/Lazurio`; the recognized existing legacy Folder is
the in-place input, not an occupied-target error. A conflicting second target or ambiguous folder is a blocker.
Do not create a second active locator, infer identity from a basename, or recursively
copy a Lazurio Folder with nested `.git` files and claim preservation.

Inventory includes:

- Legacy source repo identity, full HEAD, branch, remotes and upstreams; staged, unstaged,
  untracked and ignored user files; local-only commits and ongoing Git operations.
- Every nested Organization/module/productionspace repo and permitted own Personalspace,
  including `.git` indirection, refs/reflogs, stashes, linked worktrees and their sidecars.
- Worktrees outside the Lazurio Folder, bare common directories and absolute Git path references;
  runtime selection, open files/processes, leases and service definitions referencing paths.
- Config and manifests with exact schema/version, custom files and generated ownership;
  credential references and access proof without reading/copying secret values into evidence.
- Filesystem/volume boundaries, case collisions, symlinks, permissions/ACLs and free space.

Verify recovery before mutation: preserve the whole relevant Git common directory,
working trees and mutable data with platform-correct permissions. `git bundle` alone
does not preserve untracked files, dirty indexes, worktree linkage or all reflogs.
Stashing alone is not a migration backup. No clean/reset/rebase is used to make the
inventory easier. A merge/rebase/am in progress blocks migration until its owner
resolves it. Unknown layouts receive a no-op report and a supported repair proposal.

For the one-way product conversion, this checkpoint protects recoverable history and
unique work; it does not require keeping old product worktrees operational after conversion.
Protected Organization and Personalspace Git/worktree functionality must remain intact.

Classify old files into Folder Factory-derived, user-owned and unknown using an exact old
release/source manifest plus reviewed mapping. Unknown files remain preserved; they
are not guessed to be obsolete. Do not treat all ignored files as disposable caches.
Before relocating any linked worktree use supported Git relocation/repair with
proof on a faithful fixture; never rewrite arbitrary `.git` pointer text blindly.

## Confirmed one-way, in-place conversion

The Principal selected in-place conversion, not a supported return to the old
source-working installation. Keep the Lazurio Folder, Organization repositories,
Personalspace and their worktrees at their existing paths. The separate compatibility
alias procedure above is not part of this conversion when paths are already correct.

The installed CLI/Launchpad core uses the selected profile from its compatible installed
distribution, previews the exact owned diff and applies it locally. Legacy Git provides
inventory/provenance and custom-change detection, not profile delivery: do not pull or
check out generated profile branches as the migration mechanism.

After preserving unique work and checking dependencies, retire only the old product's
Git metadata, recognized obsolete product files and its own disposable worktrees.
Preserve legacy history/custom work as recovery evidence, not a runnable old installation.
Organization/Personalspace repositories and their worktrees are not cleanup targets;
their existing directories are excluded from product cleanup and generated-output writes,
not merely left at the same paths. No recursive cleanup may cross these boundaries.
verify their Git common directories and indirections remain independent and functional.
Unknown files and edited instructions are preserved rather than blindly overwritten.
An unresolved dependency or unattributed work blocks the affected destructive step.

Recovery means protecting data and resuming or repairing forward. Returning the whole
Folder to a legacy Git checkout is not an acceptance requirement. This does not relax
product-version rollback or the separate shared-workshop migration contract.

## Legacy source-working → Lazurio Environment phases and recovery

| Phase | Exit proof | Recovery |
| --- | --- | --- |
| Discover and plan | Exact inventory, known schema, approved owner/target, supported platform | No writes, no rollback needed |
| Checkpoint | Offline-restorable verified copy, refs/index/dirty/untracked/stash/worktree parity, enough space | Delete only own unused staging after safe cleanup check |
| Quiesce | Affected managed processes drained, active writers reconciled, fingerprint unchanged | Restart the exact old runtime; preserved sessions/files unchanged |
| Prepare owned output | Valid installed profile and staged generation; nested Git independence verified; unchanged working paths | Preserve checkpoint and existing data; refuse an invalid plan |
| Convert in place | Retire enumerated old product files/Git state and apply owned output; same Folder path and one runtime identity | Resume recognized phases or repair forward; no legacy-installation rollback required |
| Verify and allow writes | CLI and affected-consumer smoke, credentials operation proof, protected data/Git parity | Preserve new work and repair forward, never overwrite it with a checkpoint |
| Retire remaining product worktrees | Unique work/history preserved, no dependent consumers, exact cleanup inventory | Retain recovery evidence under an explicit retention decision |

After conversion begins, recovery is forward-oriented rather than a supported return
to the old installation. Compare inventories and preserve new work before repair.
Never silently discard new
work to recover a green check. Interrupted operations resume only from a recognized
journal phase and matching artifacts; ambiguity produces a no-op recovery report.

The optional developer source checkout is migrated separately from active Lazurio Folder
selection. Preserve unique legacy work and provenance; old product worktrees may be
retired under the checks above, unlike protected Organization worktrees. Do not redirect
its remote to Platform because the names look related. Platform is a separate repo.

## Shared workshop → dedicated environments

This is an owner-led infrastructure migration, separate from local environment migration.
Approve the amendment and stop creating new shared cohorts at a named rollout gate.
Inventory sessions, working copies, dirty branches, stashes, jobs, credentials and
organization-owned data with the authorized owner; do not inspect foreign Personalspace.
Attribute work to its owner instead of copying the shared directory to every seat.

Provision one isolated target per Principal using the existing infrastructure owner.
Re-establish each identity through its provider flow; never clone another person's
credentials. Preserve attributable drafts through authorized Git branches or explicit
scoped data handoff. Verify peer denial for files, process signals, network and
credential use, and disclose parent-operator access. Prove actual Git operation
attribution and effective repo grants from each target.

Drain the old workshop, prevent concurrent writers, redirect only owner-approved
entrypoints and verify the human/AI Colleague flows. After the agreed observation
and restore period, revoke old shared credentials through their owner, remove old
routes/services and retire the old shared profile and docs in their owning repos.
An unresolved attribution or restore test blocks decommission, not permission to
run two writable environments indefinitely. No current infrastructure is touched
by the Platform foundation.

## Legacy source checkout retirement

`development/Lazurio` is not a target standard component of a Lazurio Environment;
Platform development belongs in `productionspace/LazurioPlatform`. The GitHub repository
has been renamed; an existing `productionspace/LazurioFactory` checkout remains a legacy
local path until a separate guarded mount migration proves all consumers and worktrees.
Do not equate path relocation with runtime activation. Before retiring old source,
inventory shell/launcher/service paths, dependencies, scripts, open sessions, module
references and all linked worktrees in addition to refs/index/dirty/untracked/ignored
work. Prove no active consumer requires it and that recovery can restore the captured
state. Unattributed work or a remaining dependency blocks deletion; retain the checkout
as migration provenance until the explicit cleanup gate. This preparation deletes none.

The [two qualification modes](release-cycle.md) remain separate from migration. A fixture
is not a real-environment checkpoint. Integrated candidate activation in a legacy
source-working environment cannot bypass the explicit migration plan. A product downgrade
cannot restore a Lazurio Folder move, schema or user writes; the recovery plan
must evaluate each independently.
