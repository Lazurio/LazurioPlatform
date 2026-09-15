# Expired pending trust: implementation work package

Status: open implementation gate, not an available recovery command or permission
to install from expired metadata. This extends the installation owner described in
[release-cycle](release-cycle.md), not a second updater or trust selection store.

## Required end state

`product recover` with explicit network origins must be able to finish after an
interrupted refresh whose retained metadata expired or no longer matches the live
repository. It must preserve authenticated root advancement, role-version rollback
protection and the channel high-water across another interruption. Only a subsequent
normal installation may stage or activate an artifact. Offline recovery remains
available and must not silently become a network operation.

The existing EOF continuation is insufficient: it cannot replace an expired
timestamp or request a snapshot belonging to a different refresh cycle while
pretending those responses complete the original transcript.

### Current adapter boundary

`src/distribution/historical-roles.ts` authenticates one ordered response chain
from an explicitly trusted root using pinned model signature and metadata-link
verification. Its result is branded `historical-floors-only`, contains no target
selection or installable checkpoint, and makes no freshness/original-acceptance
claim. Tests use distinct role keys and expired metadata, plus an old-and-new-signed
root rotation. The model package is a pinned direct dependency, not an implicit
production import from a development-only dependency.

`continueHistoricalRoles` reconstructs each subsequent chain from the preceding
authenticated root and preserves the maximum of every previously authenticated
role/reference version, including missing roles in a partial later cycle. It
rejects deserialized or fabricated floor objects: restart must reauthenticate the
owner-bound evidence. This is in-memory accumulation, not durable recovery, and
does not mark lower signed responses as accepted. Root rotation does not silently
clear the counters.

This adapter is not yet called by the owner. It throws on refused/corrupt evidence;
it does not yet classify a refused final response or import a previously published
checkpoint's floors. It also does not reset floors after role-key rotation. Those
steps and durable cross-cycle integration below remain required before enabling
the new recovery path. A fully authenticated expired chain by itself is not enough.

## Three distinct trust inputs

1. The owner-bound published checkpoint (or the explicitly supplied first-install
   bootstrap root) is the original authority. Missing established state is damage,
   not permission to bootstrap again.
2. Received journal bytes are evidence to authenticate, not accepted state. Neither
   a successful file write nor a mutable TUF cache proves cryptographic acceptance.
3. A historical rollback floor is not fresh metadata and cannot authorize a target.
   The normal TUF refresh must still verify final freshness, signatures, metadata
   links and target/channel binding using the real clock.

Pinned-client qualification demonstrates that an expired timestamp can retain its
timestamp and snapshot version floors. It also demonstrates that expired timestamp
blocks snapshot verification. Consequently catching an expiry exception and copying
the remaining cache is not a recovery algorithm. A complete previously trusted
expired cache can start a fresh refresh; that qualification does not authenticate a
partial journal or establish an accepted root for it.

## Implementation sequence

1. Build an authenticated historical-floor adapter, bound to the original input
   and ordered evidence. It must distinguish accepted progress, a refused final
   response and corrupt/unconsumed evidence. Verify consecutive, old-and-new-signed
   root transitions; retain role versions and metadata links without claiming the
   expired chain is installable. Do not backdate the client clock, rewrite expiry,
   trust a cache by filename, or treat any caught exception as accepted progress.
   Library integration is still to be implemented and reviewed: current tests of
   private client internals do not authorize a production private-API dependency.
2. Represent fresh refresh cycles durably inside the existing pending attempt.
   Keep each cycle's input binding and received bytes immutable. A second failure
   must preserve progress from that cycle as well as the original one. Define and
   test initialization, incomplete-record and publication crash boundaries before
   connecting the writer. Never overwrite the old transcript with newer responses.
3. Run the ordinary fresh client from the authenticated recovery input. Prove that
   no root, timestamp, snapshot, targets or channel floor was lost. Root-key
   rotation needs its own tests: any protocol-permitted role-cache reset must be
   justified by the authenticated rotation, never merely by failure or expiry.
4. Publish a complete verified generation through the existing selected-trust
   pointer, then close the pending attempt. Preserve the owner's lock, one total
   deadline and cancellation, and the metadata-only recovery boundary. CLI and
   Launchpad must not grow separate recovery implementations.

Do not close this work package when only the adapter or a happy-path refresh works.
The owner integration and repeated-failure tests are part of the same deliverable.

## Required acceptance evidence

- Bootstrap and established inputs; interruption after root, timestamp, snapshot,
  targets, channel and trust publication. Include an incomplete role set before
  the first channel, not only a complete cached checkpoint.
- Expired intermediate and final metadata; repository advancement while offline;
  equal/lower versions, rollback of referenced versions, and changed channel bytes
  at the same sequence. No time override and no unauthenticated higher floor.
- Separate role keys, two-sided root rotation, rejected root jumps/signatures and
  authenticated timestamp/snapshot key rotation. Shared-key fixtures alone do not
  qualify the trust transition.
- Corrupt, gapped, reordered and unconsumed journal records; invalid final response;
  cancellation and a second interruption in the fresh cycle. Repeated recovery
  must neither forget accepted progress nor reopen first install.
- Existing publication-interruption recovery, owner exclusion and read-only status
  remain valid. No artifact request, staging, activation or execution during recover.
- Exact-head tests on macOS and Linux ARM64, followed by a compiled CLI journey:
  interrupted install, fresh recovery, next non-bootstrap install and product
  status. Distinguish this from Windows, power-loss and official HTTPS qualification.

Until these pass, keep the pending-attempt barrier and report the limitation. A
manual deletion of pending state is not the planned forward-recovery operation.
