# Expired pending trust: implementation work package

> **Superseded for product update (2026-09-19).** The accepted contract for
> checking, downloading, activating and rolling back a product version is
> [product update](update.md). The journal-reconstruction work package below is not continued. Decision F13 removes the product's own TUF client, so the threat it analyses (authenticated-but-unpersisted role floors) no longer has a subject; this document is removed together with the pilot installer.

Status: deferred automatic-recovery work, not a prerequisite for the controlled
pilot (scope decision 2026-09-15; see [pilot repair](pilot-repair.md)). Stop expanding
this work package for pilot readiness. Preserve completed safety checks and retained
trust; unfinished helpers are not runtime acceptance. Not an available recovery command or permission
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

Reconstructed floors privately retain each role's signed JSON content at its
highest observed version. Continuation and publication reject changed content at
the same version, including a newly signed expiry extension. The comparison covers
unknown signed fields, but ignores JSON formatting/key order and envelope signature
encoding. A partial cycle retains earlier content bindings; restart reconstructs
them from signed evidence rather than deserializing another counter/content store.
Publication also compares each cached role's own version separately: a higher
timestamp snapshot reference must not mask rollback of the cached snapshot itself.

`historicalFloorsFromTrustedCheckpoint` provides an explicit trusted-input seed
for the owner's already-published checkpoint. It preserves the timestamp's snapshot
reference, the cached snapshot's own version and role references, and the cached
targets version even when those roles describe different refresh stages. It does
not authenticate arbitrary cache files: the caller still has to bind the input to
`readPublishedPilotTrust`. Shape checks and the function name are not provenance.

The existing recovery owner now seeds floors from its selected published checkpoint
and calls `assertCheckpointRetainsFloors` before publishing replay's result. This
comparison rejects lower counters, missing snapshot references and same-version
signed-content substitution; ordinary replay still owns cryptographic verification. A newer
root version alone is not proof of its chain, and the comparison does not claim
freshness. This adds a publication guard, not the new expired-recovery path.

Historical journal reconstruction and continuation are not yet called by the owner.
The adapter throws on refused/corrupt evidence; it does not yet classify a refused
final response. It also does not reset floors after role-key rotation. Those
steps and durable cross-cycle integration below remain required before enabling
the new recovery path. A fully authenticated expired chain by itself is not enough.

### Durable metadata-cycle ledger (not yet a network recovery route)

`recovery-cycles.ts` creates sequential `recovery-cycles/000001` directories within
the pending attempt. Each contains only an immutable root/target/prior-state input and a
`received-metadata` journal. Initialization is synced and renamed before returning
a location on which a caller could perform requests. The caller must hold the
existing installation owner's lock and supply its held-lock assertion; no second
lock or trust-selection store is introduced.
Reconstruction requires the same held-lock assertion: it checks custody at entry,
before each cycle, after journal reads and before returning usable floors, including
an empty ledger. A revoked assertion refuses rather than returning a stale result;
the caller must continue holding the lock while using that result.

Reconstruction starts from the original owner-bound floors, checks every cycle's
root/target binding and a SHA-256 fingerprint of the entire reconstructed prior
floor/content state, and reauthenticates its ordered records with the shared journal
reader. No counters are deserialized and no mutable client cache is adopted.
The fingerprint is recomputed from authenticated inputs, not used as an authority;
equal roots with different prior floors must not be interchangeable. The original
input includes the original pending journal's authenticated progress, not merely
the older published checkpoint. Supplying that owner-bound input remains required
at integration.
Unpublished initialization directories stay outside the ledger and are retained,
never reused as evidence. Corrupt/gapped/foreign inputs refuse without fallback.
Tests cover a second interrupted cycle and failures before/after publication; they
are not power-loss qualification.

The ledger is bounded to 32 cycles and 260 records/32 MiB across their journals;
exhaustion refuses without deleting evidence. `beginRecoveryMetadataCycle` derives
the remaining aggregate budget from reconstruction and binds it to the new journal
fetcher. Prior counts are not the new journal's sequence indices. The fetcher
snapshots its bounds, caps each request by remaining bytes, and refuses oversized
transport responses before recording or returning them to TUF. This is only a
write-ahead transport, not a fresh-client verification or publication route.
The returned recovery fetcher is metadata-only: target downloads refuse without
calling transport. Its journal writer checks the owner assertion before transport,
after transport before recording, and after durable write before delivery. Lost
custody after a write retains that evidence for recovery but refuses delivery.
`refreshRecoveryMetadata` now runs a normal fresh TUF refresh from reconstructed
root state through that transport, in a new disposable cache outside the ledger.
It checks the complete result against retained version/content floors and returns
only `fresh-metadata-only`; it cannot download targets or publish trust. Tests
cover expiry, lower/equal-version replacement and another interruption followed by
a rollback refusal and successful newer refresh. These are metadata-only tests,
not end-to-end recovery qualification.
Channel/high-water evidence, refused-tail handling and owner/trust-publication
integration are still unimplemented.
This metadata-only ledger is not yet invoked by `product recover`.

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
