# Content synchronization

Status: **accepted direction of the Principal (2026-09-19); not implemented.** No
Platform command clones, fetches or fast-forwards an Organization repository today.
This document is the contract for that future operation and for its separation from
product update. See [decision F9](decisions.md#f9--update-lazurio-and-synchronize-content-are-separate-operations).

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

Synchronization runs only when a Principal or an authorized Task Agent invokes it for a
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
- Personalspace, which is private to its Principal and absent from
  Organization-owned Machines;
- worktrees, including task and pull-request worktrees of any repository;
- repository databases, which publish through their own application contract.

## Identity and rights

Rights are checked at the operation boundary through the identity the workspace is
meant to use, as selected by its [workspace preset](workspace-presets.md):

- private workspace or local Machine: the Principal's own provider sign-in;
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

## What this does not mean

- It is not a port of the legacy updater's source-root update; the product is not a
  repository on the Machine.
- It does not make Platform an Organization reconciler running in the background.
- It does not grant, cache or infer provider access.
- It is not implemented, and it does not authorize cloning any real Organization.
