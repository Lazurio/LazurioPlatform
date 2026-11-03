# One future marketplace: profiles and modules

Status: requested product vision and future roadmap, outside the current bootstrap,
with one bounded exception: the curated free module pilot below. There is no
marketplace service, account system, billing, discovery backend or executable
extension capability in this foundation.

## The curated pilot in the Launchpad (plan DEV-6593)

The Marketplace entry at the bottom of the Apps column in the
[target shell](launchpad-development.md#target-shell) opens a catalog of one section,
Šablony aplikací (app templates). Its offers come from the registry
[`Lazurio/marketplace`](#the-registry-lazuriomarketplace), read at one exact commit,
and until a registry was read from the copy of its `index.json` built into the
release (`src/launchpad/marketplace-index.json`). Everything below is what the pilot
does today; the rest of this document stays future direction.

- **One record per offer, in the registry.** An offer names its public source
  repository, publisher, SPDX license, its stone, `pricing` (only `free`), its words
  in Czech and English (one line, up to four features, the dialog's starts) and its
  releases, newest first. A release names `version`, tag `v<version>`, what it is
  built on (the app generation `app/v<N>`, the scaffold's stack and the exact Bun,
  because a generation transition or a release of the stack profile changes them;
  decided 2026-11-03), the full `commit` the tag points to and the `artifactDigest`
  of an attested artifact, the last two filled in only once the release is published.
  The Launchpad offers the newest release whose commit is recorded. The catalog holds
  no second copy of the source. A tag or a branch is not an immutable identity.
- **Only released templates are shown** (decided 2026-11-03). An offer none of whose
  releases has a commit is announced in the registry, but the Launchpad shows no card
  and no detail for it (`/marketplace/<offer>` says the offer is not in the
  Marketplace) and its prompt route answers 404. `parseMarketplaceIndex` still reads
  such an offer in full, so an invalid announcement refuses the index as any other
  error does.
- **Today's offers.** Mission Control 4.0.0 (`app/v3`), Design System 1.0.0
  (`app/v1`) and Presentations 0.1.0 (`app/v1`), all three of
  `LazurioExampleOrganization`, MIT, on Bun 1.4.4. None is released yet, so the
  Marketplace shows none of them and says there are no app templates yet. Mission
  Control's only public source is `LazurioExampleOrganization/mission-control`.
  Presentations moved there from `TemplatesRozjedeme-ai` with a clean history
  (decided 2026-11-03).
- **It looks like the module it becomes.** An offer carries the stone its module
  shows in Apps (`presentation`, `shell/stones.ts`). The catalog's card is a real
  screen of the app, the stone, the name and one line, as a tile in Apps.
- **Detail.** `/marketplace/<offer>` shows the stone, the name and its one line with
  "Přidat do Organizace"; the app's real screens, one large and the others as
  thumbnails that show it instead; and what it does in three short items (Knihovna,
  Promítání a PDF, Tvorba s agentem). Nothing technical is shown: no version,
  license, source, data or requirements block, no badge and no list of what the app
  lacks (Anna, 2026-10-26; the page was simplified with the Impeccable `distill`
  pass). The record still holds version, license and source for the brief and the
  agent. No price, pilot label, mention of the Environment or computer, install
  count, rating or other offer is shown; the price remains zero.
- **Screens.** The registry lists screens of the offered release: WebP files 1600 px
  wide in the template's repository, with invented content only, shown from
  `raw.githubusercontent.com/<repository>/<commit>/<path>`, so they are exactly the
  release's. Lazurio bundles no screens of its own. An offer without screens shows
  its stone and words only.
- **Přidat do Organizace.** A dialog names the target Organization, chosen only among
  this Folder's Organizations bound to a GitHub login (the address is never the
  target's authority), and how the module starts (empty, or with the release's
  invented example where the offer has one; the offer's own words), and says in one sentence what follows: the agent prepares a private
  module for that Organization with the person in Chat and shows the plan to approve
  before anything there changes. The plan itself (exact release, private repository,
  Teams chosen from the Organization's real list, the template's code run, a request
  where rights do not reach) is the agent's first step, as the brief requires. Where
  the Organization already has a module of that name the dialog says the agent agrees
  another. Teams are not listed on the page (decision F32).
- **Hand-over, not installation.** "Pokračovat v Chatu" hands the brief to Chat
  exactly as "+ Nový modul" does: by link where Chat takes a prepared prompt, else
  through the clipboard. The prompt `marketplace-<offer>-<empty|sample>` is served by
  `GET /.lazurio/prompts/<id>?org=<login>` to anyone admitted, for an offer and start
  of the catalog the Launchpad shows (so only for a release with a recorded commit)
  and an Organization of the Folder bound to that login; every other case is the same
  404. The brief names the exact release, the Organization and
  the start, and tells the agent to follow the release's `docs/adoption.md`: check live
  rights, name collision and compatibility, show the plan, `lazurio module create`,
  merge the pinned commit so it stays an ancestor, prepare a PR, prepare a request
  where rights do not reach, merge or activate nothing without the person's explicit
  instruction. The dialog then says Chat opened with the brief ready, unsent. It never
  claims installation on a click.
- **Listing a release.** Recording the commit (and the digest) after the release is
  published is a reviewed pull request of the registry; its merge puts the offer in
  every installed Launchpad within an hour of its next Marketplace read, without a
  Lazurio release.

The pilot is complete only after the real consumer journey into another Organization
and a verified update with local customizations (plan DEV-6593); this page is its
entry, not that evidence.

## The registry `Lazurio/marketplace`

Decided by Matěj on 2026-11-03: the registry is one public repository with one record
per template; adding a template is a pull request, CI checks its shape and source,
and a curator's merge is the listing. Lazurio reads the registry at one exact commit
instead of a record in its own code, so a new template needs no Lazurio release. The
repository is private until Matěj publishes it; the record format, the validator, the
contribution guide and the template contract live there (`schemas/offer.v1.schema.json`,
`CONTRIBUTING.md`).

### How the Launchpad reads it

`src/launchpad/marketplace-registry.ts`, implemented 2026-11-03:

1. **The source is pinned by identity.** The registry is named by its numeric GitHub
   repository id (`registrySource`), so a rename, a transfer or a look-alike
   repository cannot take its place. Requests go to
   `api.github.com/repositories/<id>/…` anonymously; the registry is public.
2. **One commit, then that commit's index.** A read asks which commit `main` is
   (`application/vnd.github.sha`), and only when that moved fetches `index.json` of
   exactly that commit (at most 1 MiB, 10 s for both). The index is the registry's
   generated, deterministic file; git's content addressing and TLS make what arrives
   that commit's bytes.
3. **Parsed in full or refused.** `parseMarketplaceIndex` (`marketplace.ts`) reads
   `lazurio.marketplace.index.v1` exactly: an unknown schema, field or value, a
   duplicate id, a short commit, a repository outside its publisher, a screen outside
   its repository or a price refuses the whole index and the Launchpad keeps what it
   showed. Only an unknown stone is tolerated (the plain app stone). A field Lazurio
   must understand first is a new schema version, landed here before the registry
   uses it.
4. **Kept, never stale for long, never in the way.** The index read is kept with its
   commit in the install base (`<base>/marketplace/registry.json`, a disposable cache
   like `update/last-check.json`) and shown at once after a restart. An open
   Marketplace (`POST /api/marketplace`) and an adoption prompt ask the registry again
   when the last question is an hour old; only while nothing was ever read from the
   registry does the answer wait for that question, otherwise it never waits for the
   network. Offline, rate-limited, private or refused: the kept index, else the
   built-in copy.
5. **The built-in copy** is the registry's `index.json` at the release's build,
   copied into `src/launchpad/marketplace-index.json` by a reviewed change; it must
   parse (an unreadable copy fails the module's load and the tests). A Launchpad that
   is not an installed one (a source checkout, the tests) never asks the registry and
   shows this copy.
6. **Nothing more is trusted.** A listing grants nothing: whatever an index says, the
   offer is a brief the agent checks against the release itself (live rights, the
   tag's commit, the release's `docs/adoption.md`), and the prompt route still serves
   it only for an Organization of this Folder and an offer the catalog shows, which
   has a recorded commit. No code from the
   registry or a template runs in the Launchpad; every word is drawn as text.

`GET`-like reads stay `POST {}` like `/api/catalog`, behind the same admission; a
public Environment shows the Marketplace and reads the same way.

### Why this way, and what was not chosen

The Platform distributes two kinds of things today ([product update](update.md)):
the product itself, an attested GitHub Release that only `lazurio update` activates,
and content, the Organizations' repositories that the hourly round and
`lazurio update` fast-forward. The Launchpad already asks GitHub in the background
for the newest release. The registry is neither product nor an Organization's
content, so the simplest safe path reuses the background question, not a new
channel:

| Alternative | Why not now |
| --- | --- |
| Keep the record in the product, or pin a registry commit in each release | Every template, release or commit fix would need a Lazurio release; the decision says it must not. Kept only as the built-in copy. |
| Attested registry releases (a tag and `actions/attest` per change, verified with Sigstore as the product update is) | Strongest provenance, but every listing becomes a tag, a second Publication step after the merge, and the client a second verifier. Worth it once paid templates or third-party publishers depend on the listing; the index format does not change. |
| Sync the registry as content into the Folder (`lazurio update`) | A new class of repository for the content core, a checkout per Environment and a Folder path that is not an Organization's; more moving parts for one small file. |
| Load `index.json` from the browser | Every visitor's browser would ask GitHub, without the kept index or one parse in the server, and the prompt route would still need the server's copy. |

Known limits: a force-push of `main` to an older commit is followed (the curator's
branch protection prevents it once the repository is public); screens load from
`raw.githubusercontent.com` in the person's browser, so a future Content Security
Policy of the Launchpad must allow that origin or proxy the screens through the
Launchpad; the artifact digest is carried but not verified yet.

## Direction

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
profile definitions which a user deliberately selects for a particular local
installation. Installing a definition is not importing another user's Lazurio Folder,
credentials, Organization data, Personalspace or authority. It must not update the
same user's other Machines implicitly.

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
requires this user's scope, consent provenance, revocation and actual rights.

Untrusted publisher content cannot redefine scope, bypass required approval or read
private data. Trust/authenticity, publisher verification and revocation, content
review, discovery/hosting, billing and executable extensions are future decisions.
Resolve them against real producer and consumer examples before building a store.

## Future acceptance

One synthetic producer publishes a declarative definition; two Machine fixtures of
the same user activate different pinned profiles without sync. Unknown schema,
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
