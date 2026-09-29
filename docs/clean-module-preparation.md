# Explicit clean module preparation

Development composition only: no default production authorization or dependency
owner discovery is introduced by this operation.

`clean-prepare` uses the same existing Launchpad lifecycle, authenticated API and
compiled CLI stdin transport as `prepare`. The browser labels its button explicitly
as reinstalling dependencies and removing `node_modules`. The trusted composition
must supply `preflightCleanPreparation` and authorize the `clean-prepare` operation;
absence is unavailable, never a fallback to ordinary preparation. Permission to stop
the selected managed app is still checked separately. No other app is stopped.

The Bun adapter's explicit `cleanInstall: true` performs cleanup only in the effect
phase, under the existing owner coordination after app stop. Package, lock and
configuration authority are rechecked. Only `<resolved owner>/node_modules` is a
cleanup target. A symlink at that root, a separate filesystem, nested mounts, an
entry another account owns (`directory-owner`, `declaration-owner`), Git metadata or
non-derived special entries are refused. A tree the operator owns is the operator's
own whatever its write bits (decision F23), so a group-writable `node_modules` left
by an install under umask `002` is removed like any other; a refusal of the checkout
rule answers `preparation-failed` with its rule and module-relative path. Descendant symlinks are unlinked without following their destinations.
Source, lockfiles, database, Git outside this tree and global cache are not targets.

The dedicated POSIX process guard tightens its inherited creation mask with
`umask | 0077` before spawning a managed install or application. New default-created
files/directories in its descendants are private to the executing user, consistent
with the product's own files, which keep their strict rule. The caller's process mask is not
changed, stricter inherited restrictions are not relaxed, and existing files,
directories and shared cache inodes are never chmodded. This covers application
cache creation as well as installation; otherwise a guest with umask `0002` can
install successfully and then fail clean preparation on its own new shared tree.
A pre-existing group-writable tree the operator owns is accepted and never chmodded
(decision F23); another account's tree is refused rather than repaired.
Trusted scripts can deliberately change their own mask or modes; the guard is not
a filesystem sandbox and does not certify arbitrary module code.

A compiled-guard regression launches from a separate umask-0002 process and checks
new directory/file permissions, inheritance by a descendant, and preservation of
the test caller's mask. It fails before the guard change and passes afterward.

Regular hardlinked package files are allowed: cleanup unlinks only their names in
the selected dependency tree, never writes or changes permissions on the shared
inode. Other cache/checkout links retain their bytes, inode and permissions.
[Bun's cache documentation](https://bun.sh/docs/pm/global-cache) identifies hardlinks
as the normal Linux installation backend, unlike macOS clonefile. Rejecting every
multi-link regular file prevented ordinary Linux clean preparation. A regression
fixture reproduces that rejection and verifies surviving cache/checkout links after
cleanup, including unchanged bytes, mode, inode and modification time.

The same holds for reading: the checkout rule of decision F23 reads a hard-linked
`package.json` of a local package, and the permission bits of the operator's
checkout files are not a reason to refuse them. When local `file:` inputs exist, the
frozen install uses `--backend copyfile`, so the Platform's own preparation does not
hard-link a source file into the installed tree; an earlier install by another tool
may have, and that is read as it is.

This relies on cooperative stable filesystem custody, not protection against a
hostile same-user writer replacing paths during traversal/removal. Cleanup safety
errors fail preparation; no success is inferred from missing dependencies. Missing
node_modules needs no cleanup and proceeds to the existing frozen install and
module-owned preparation/postconditions.

Cancellation is checked before inspection, during traversal and immediately before
removal. Once recursive removal starts, the owner awaits it rather than releasing
coordination while effects continue. Cancellation or failure must not report prepared;
partial dependencies can require a later explicit clean retry. There is no rollback
of removed derived files and no automatic retry loop. This is not full crash recovery.

Focused tests cover reinstall plus source/lock/DB/Git preservation, external symlink
destination preservation, root-symlink refusal, pre-cancelled cleanup and distinct
API/CLI authorization/capability routing. The browser harness exercises explicit clean
reinstall from a running synthetic app through both UI and compiled CLI, followed by
start, health, actual page opening and stop. Real candidate/VM coverage and exact-head
review must be renewed before broader support claims.
