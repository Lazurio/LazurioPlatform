# One future marketplace: profiles and modules

Status: requested product vision and future roadmap, outside the current bootstrap.
There is no marketplace service, account system, billing, discovery backend or
executable extension capability in this foundation.

One shared marketplace for profiles and Organization modules is an accepted future
product requirement. Discovery/presentation, authorship, versions and descriptions
are shared; package contracts and installation targets remain distinct. A module targets an explicitly selected project/Organization with its manifest/schema
and ownership rules. Connected repo operations require live access/publish rights.
The accepted local-founder journey and proposed binding distinction in
[decision F6](decisions.md#f6--two-priority-local-entry-journeys) also permit useful
owner-local module work before GitHub; its schema/amendment must be qualified first. The marketplace never becomes a
second ACL. Paid module snapshots are an accepted future consumer below; exact commercial terms
and module licenses remain separate decisions.

The active profile remains per Machine. A future marketplace distributes versioned
profile definitions which a Principal deliberately selects for a particular local
installation. Installing a definition is not importing another person's Lazurio Folder,
credentials, Organization data, Personalspace or authority. It must not update the
same person's other Machines implicitly.

## Minimal portable definition — proposal

Use one versioned declarative document when the first real consumer is built:

| Field | Purpose and boundary |
| --- | --- |
| `schemaVersion` | Definition format; unknown versions refused before activation |
| `id`, `version` | Stable publisher-scoped name and immutable definition version; name is not verified identity |
| `author`, `source` | Attributed author and original source reference; authorship alone is not trust or permission |
| `compatibility` | Required product/profile contract range and relevant platform constraints |
| `requiredCapabilities` | Declared harness features needed for intended behavior; missing capability is visible, not auto-installed |
| `preferences` | Supported behavior/detail/locale values from the existing profile contract |
| `description`, `intendedUse` | User-submitted explanation of proven use and suitability |
| `customInstructions` | Free-form user-authored source, separate from generated AGENTS.md |
| `proposedMandates` | Intended work/scope description, never imported consent or effective grants |

The actual schema is not implemented here. Avoid a speculative configuration DSL.
Predefined and custom instructions plus proposed mandates are accepted requirements.
Tools/plugins and arbitrary executable hooks are not implied. No postinstall/shell
scripts or provider grants are part of this profile definition. Field names and
storage format remain proposals. Module installation follows its own approved
contract, not the profile contract or an invented universal package.

Machine-local activation records the selected immutable version, source and digest,
the compatibility/capability check and the reviewed effective preference/output diff.
This record extends the existing local profile ownership manifest; it is not a second
profile database. A marketplace listing is discovery information, not permission.

Pin installed definitions. Discovering an update may notify, but never silently
activates new instructions or adds capabilities. A change requires the same checked
local profile operation, expected revision and session adoption policy as a local
profile edit. Show changed preferences and generated instructions before activation;
rollback uses retained compatible versions and preserves subsequent edits.

Custom source survives regeneration and upgrade. Shared/custom composition has
explicit precedence and displays conflicts before activation. Export/submission
includes reviewed portable source and intended-use explanation, never private data,
credentials, the author's consent or effective mandates. Local effective authority
requires this Principal's scope, consent provenance, revocation and actual rights.

Untrusted publisher content cannot redefine scope, bypass required approval or read
private data. Trust/authenticity, publisher verification and revocation, content
review, discovery/hosting, billing and executable extensions are future decisions.
Resolve them against real producer and consumer examples before building a store.

## Future acceptance

One synthetic producer publishes a declarative definition; two Machine fixtures of
the same Principal activate different pinned profiles without sync. Unknown schema,
unavailable capability, wrong compatibility and tampered definition fail before
activation. A new version produces an explicit diff and does not expand authority.
The test includes attempted secret/Lazurio Folder/data import and attempted install script.
It proves refusal without executing the content. Service launch and public profile
publication retain their own explicit mandates.

## Community producer and consumer loop

The product starts from a concrete result: discover an example, share its profile,
try it, adapt it and return experience. Profiles are primarily compared and selected
in the catalog; customization uses Lazurio's existing local profile settings, not a
second configuration engine inside the store. A submission carries purpose, selected
examples, model/tools, prerequisites/proposed mandates, limits, author and version
provenance. Derived variants retain attribution and their source revision. Discussion
and qualitative experience sit beside the separate [evidence types](profile-evidence.md).

Sharing is explicit. Preview the exact export; default to excluding private/custom
instructions and include only custom text deliberately selected by its author after
review. Never upload automatically. Remove secrets, Organization content, runtime
state and effective mandates. A useful-result example is not blanket permission to
publish its source data. Future trust work must cover author verification, reports,
moderation, malicious content, version withdrawal and appeal/disposition. A withdrawn
listing must not silently delete an installed local variant or its user's work.

## Paid module: immutable source purchase and integration

An author may offer a module repository release or immutable source snapshot. Public
visibility of all paid repositories is not decided. The transaction identifies the
exact version/digest, source provenance and applicable module license. Payment or a
dashboard receipt does not itself protect source, prove code quality, grant Git access,
install the module or authorize publication. Platform ELv2 does not choose its license.

The consumer explicitly selects a customer Organization. With the applicable source
entitlement and live repository rights, its agent verifies the snapshot, dependencies,
license and compatibility, then prepares a tested adaptation/integration in that
Organization's own repo/PR. The customer owns its modifications subject to underlying
licenses; source and data remain under their normal owners, with no platform lock-in.
Preserve the imported base revision/digest and license notices as provenance. Review
migration/security assumptions before execution; malicious hooks cannot run merely
because a module was bought. Publication remains a distinct authorized action.

A later upstream release is another deliberate integration against the recorded base
and local changes. Never overwrite the customer's derived variant, data or configuration.
Conflicts, incompatible schema or missing update rights stop the operation and preserve
work. Do not turn module updates into the product updater. Future decisions include
update entitlement, module redistribution/adaptation rights, platform share, support,
refunds and author payouts. Do not infer prices, subscriptions or universal source
visibility from this product direction.

Acceptance uses an immutable synthetic module, a licensed import into a fixture repo,
a local customization, then an upstream update with a deliberate conflict. Prove a
reviewable diff, retained attribution and data, denied installation without repo rights,
tamper rejection and no automatic publish after purchase. Community and paid modules
share this one catalog; they do not share the profile installation contract.

Profiles may also be paid offerings. Whether a starter profile is free, profile pricing,
license and update entitlement remain decisions; no free-trial credit or universal
free starter is implied. Payment does not change the profile's declarative installation,
capability or consent boundaries. The same catalog covers profiles and modules.

## Local project consumer

For the accepted founder path, a permitted module snapshot can be integrated and run
in an explicitly owned local project without a GitHub login. License/entitlement and
capability checks still apply; absence of provider rights blocks remote access, not
owned local work. Preserve source provenance, custom changes and local Git history.
Later provider binding follows F6 and does not silently upload a purchased source
snapshot to a public repo. This extends the module consumer target, not the profile
format, marketplace ACL or product updater. The connected customer PR flow above remains
unchanged. Local acquisition must use a legitimately available artifact; this is no
permission to bypass a private source repository's access or licensing.
