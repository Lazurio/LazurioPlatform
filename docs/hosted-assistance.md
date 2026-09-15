# Scoped platform advice and draft execution

Status: accepted product outcome; execution, billing and hosting mechanisms require
shaping and qualification. No hosted runner, new identity or billing code is implemented.
A customer should be able to request advice and prepare Organization changes through
a platform dashboard without installing a local development toolchain.

At the whole-system level Dashboard is initially an overview and reasoning projection,
not an access or control authority. It keeps no parallel truth. Any later desired change
originated there must be written through to the natural owner and applied locally on the
target Machine by the installed shared core exposed by CLI and Launchpad. The topology owner, discovery/projection/freshness
and write-through mechanism remain open; this document does not define a central registry.

## One ownership model

| Concern | Existing authority to extend | Boundary |
| --- | --- | --- |
| Task intent and context | Customer Principal's explicit request | Selected Organization/repo, goal and visible context; no ambient cross-customer discovery |
| Access and publication | Actual provider identity and existing mandate model | Live repo operation rights; credits and product role are not grants |
| Work | Customer-owned repository and review branch | Advice or reviewable draft/PR; no platform-only code copy as canonical truth |
| Execution | Dedicated per-Principal Machine envelope and lifecycle | Organization/provider may own infrastructure; state, credentials and recovery are isolated from peers |
| Budget | Existing platform billing owner | Bounded metered work, no permission to mutate repos |
| Recommendations | Profile/module catalog plus disclosed evidence | Reasons, alternatives, compatibility and commercial interest visible |

The implementation must identify the actual Principal, Machine Owner, provider/operator
boundary, credential delegate and exact repository rights before running. An ephemeral
process/container is not automatically an isolated Machine. Choose a provider envelope
that proves file/process/network/credential/recovery separation and bounded lifetime;
reuse existing provisioning, credential custody and lifecycle rather than inventing
an all-powerful "architect" Principal. Customer Personalspace is not mounted. Work on
multiple Organizations requires separate scoped contexts and credential boundaries.
Shared Organization applications do not imply a shared multi-Principal execution host.

The baseline is advice over deliberately supplied context with no writes. Execution
adds a bounded customer-owned repo worktree and preparation/validation of a draft.
Publication is a separate exact operation under current rights and consent. A customer
may revoke repo access or stop the task; neither unused credits nor prior purchases
allows credential replacement or continuation outside scope. Preserve unpushed work
privately on interruption and provide an authorized export/recovery path.

## Proposed interaction and lifecycle

1. Show target Organization/repo, visible context, advice versus draft scope, required
   capabilities, estimated consumption basis and a hard agreed budget cap.
2. Establish explicit authorization separately from payment. Recheck provider identity,
   repo access and relevant Machine/Organization mandates at operation boundaries.
3. Run with an attributable task ID and visible work/consumption. The billing owner
   must handle retries idempotently, reserve bounded budget and settle actual measured
   work without duplicate charges. Unknown usage is reported as unknown, not free/zero.
4. Interrupt at a safe boundary when the user stops, budget is exhausted, access is
   revoked or the runner fails. Preserve the draft and bounded private diagnostics;
   stop owned children and release unused budget according to selected billing terms.
5. Resume only from a verified checkpoint with renewed relevant access/budget checks.
   Do not replay a publication or charge because a response was lost.
6. Hand back advice, reasons and alternatives or the exact tested PR in the customer's
   repo. Publishing or deploying requires its own authorization; a completed draft
   does not select or buy a recommended module automatically.

The dashboard must distinguish advice, preparation and publication, including the
billable work already performed when interrupted. Prices, credit units, reserve/settle
provider, refund rules and retry guarantees need a reviewed contract before launch.
Recommend the smallest standard provider capabilities; a general workflow engine or
second repository registry is not required. A licensing/hosting agreement must cover
the service; Platform's ELv2 terms do not grant arbitrary third-party managed hosting.
Human and Machine s.r.o. may grant that right to an approved partner under a separately
negotiated commercial license.

## Failure and acceptance

Prove read-only advice cannot write; draft preparation cannot merge; credit purchase
without Git rights fails; wrong-customer context/credentials cannot cross boundaries;
revocation halts further unauthorized operations without deleting work. Exercise
budget exhaustion, concurrent requests, partial usage reporting, double callback,
runner loss, cancellation, resumable draft and lost publication response. Evidence
records exact task/commit/provider operation privately with no secret values.

First implementation acceptance uses a synthetic customer repo and a real isolated
consumer to prepare and test a PR without a local toolchain. It does not require
building a full store or autonomous account system. Public design contains these
generic contracts; individual customers, financial strategy and operational custody
remain in the owning private Organization documentation.

## Later nontechnical founder discovery

Creating or digitalizing a business through an Architect dashboard is a later research
journey with a product teammate. Explore intent → task → observable result and visible
cost/progress/stop controls. It is not a blocker for the first maker and technical-founder
local release. The local-to-GitHub requirement is already accepted in F6 and must not be
parked in this research. Dashboard onboarding, exact copy, pricing and execution design
remain open; UI status text and promotional revenue claims do not prove a working product.
