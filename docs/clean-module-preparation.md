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
cleanup target. A symlink at that root, a separate filesystem, nested mounts,
foreign ownership, Git metadata or non-derived special entries are
refused. Descendant symlinks are unlinked without following their destinations.
Source, lockfiles, database, Git outside this tree and global cache are not targets.

Regular hardlinked package files are allowed: cleanup unlinks only their names in
the selected dependency tree, never writes or changes permissions on the shared
inode. Other cache/checkout links retain their bytes, inode and permissions.
[Bun's cache documentation](https://bun.sh/docs/pm/global-cache) identifies hardlinks
as the normal Linux installation backend, unlike macOS clonefile. Rejecting every
multi-link regular file prevented ordinary Linux clean preparation. A regression
fixture reproduces that rejection and verifies surviving cache/checkout links after
cleanup, including unchanged bytes, mode, inode and modification time.

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
