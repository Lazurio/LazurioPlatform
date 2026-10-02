# Workspace composition: the Lazurio Account in the Launchpad and the workspace composed by the Dashboard

Status: **shaping, proposal [F33](decisions.md#f33--the-workspace-of-an-environment-is-composed-by-the-dashboard-from-live-github-rights-proposal-partly-decided);
partly decided by Matěj on 2026-10-02 (section 1.1), not implemented.** Plan DEV-6638 of the maintainers' Mission Control.
Nothing in this document changes behaviour, grants access or authorizes cloning a real
Organization. It records Matěj's direction of 2026-10-02 and his decisions of the same
evening (section 1.1), compares variants, names failure modes and lists which decisions
are made and which are still open (section 15). The identity foundation, the Lazurio
Account, is a placeholder whose design is pending (section 4.1).

Step 1 of the direction — the flat workspace without Team sections and Team badges in
the Launchpad — is decision F32, done in parallel in pull request #122, which leaves the
composition to "a later decision of DEV-6638"; this document is that proposal and does
not repeat step 1.

Citations: a bare path is this repository at `df5eb26`. `D:` is the maintainers'
private Dashboard repository at `c0d43e8`, `M:` the Machines repository at `0570a30`,
`B:` the GitHub token broker repository (`Lazurio/github-app`) at `3e7970d`, `T:` the
Lazurio fork of T3 Code at `79eb9c95`. Root decisions are cited by number (public
projection: the root repository's `manual/decision-register.md`). **Unverified** marks
what could not be checked against code or a run.

## 0. Recommendation in one page

1. **A workspace is one Environment's composition.** It is the set of repositories
   the Environment's GitHub identity can read, among the repositories its
   Organizations *declare* as modules or as Production Space repositories. The
   Launchpad shows the modules flat (step 1) and the Production Space read-only.
2. **The Dashboard computes the composition live from GitHub** (Team membership,
   repository grants, collaborator permission) through the GitHub App it already reads
   with, and answers it to the Launchpad through a typed, versioned API. GitHub stays
   the only access authority; the Dashboard projects and stores no access.
3. **The Lazurio Account is the foundation; the Launchpad represents the
   Environment.** An operator is a person with a Lazurio Account and a GitHub account
   linked to it, and owns their Environments (laptops, VMs). The Launchpad signs in by a
   device code, as `gh` does; by that it represents the Environment itself, which is
   linked to its operator and gets the operator's rights. An operator registers their
   own Environments; a Team Environment is registered by an Owner or Admin of the
   Organization; an Automated Environment is always an Environment under an operator.
   After the sign-in the Environment proves itself with a key it generated, survives
   reboots and needs no person's browser session. The design of the account itself is
   pending (section 4.1).
4. **The Launchpad applies the composition with its own `gh`.** It clones what is
   missing and fast-forwards clean checkouts through the Environment's own GitHub
   identity (the operator's sign-in, the persona's account, or the Team's brokered
   identity). It never infers access from a GitHub error again: a clone that fails
   while the composition says "granted" is a reported mismatch, not a guess.
5. **Nothing is removed by an outage, and nothing with local work is ever removed.**
   An unavailable or partial answer keeps the last known composition. A module that
   leaves the composition becomes a removal *proposal* that a person confirms, and only
   a clean checkout whose every commit is on the remote can be removed.
6. **Access requests (later).** Modules of the Organization outside the Environment's
   access appear as "další modul organizace" with "Požádat o přístup". The request lands
   in the Dashboard; an Owner approves the exact GitHub change; the Dashboard writes it
   to GitHub with the approving Owner's authority and an audit record; the next
   composition shows the right and the Launchpad clones.
7. **Technology.** TypeScript on Bun on both sides, and one shared contract package
   `@lazurio/contracts` in this repository, written with Effect Schema and Effect
   `HttpApi` as in the T3 Code fork, under guardrails: exact pin, Effect confined to the
   contract package and one client adapter, the wire contract fixed by a committed
   OpenAPI snapshot. A spike measures the cost first; JSON Schema with ajv is the
   fallback that keeps the same wire contract (section 7). The package lives in this
   repository and the Dashboard depends on it (decided). The same package and the
   same Dashboard API carry the Environment list of the shared Lazurio shell (plan
   DEV-6639), so there is one contract and one sign-in (section 7.5).

## 1. The direction (Matěj, Organization Admin, 2026-10-02)

1. One Environment = one workspace. Its modules (repositories holding applications'
   source) are those the Environment has access to by GitHub. The Launchpad shows a
   flat workspace: no Team sections, no Team badges. Teams and access are managed in the
   Dashboard; the Environment's Launchpad has nothing to do with them.
2. The Launchpad gets a Lazurio login. Through it the Launchpad pulls from the
   Dashboard what it should have access to, and therefore what to add, update, remove
   and configure in the workspace.
3. The Dashboard is the backend of that composition: it reads access live from GitHub
   (Teams, repository grants). GitHub stays the only access authority; the Dashboard
   projects it for the Launchpad. Not live `gh` from the Launchpad, not a snapshot in
   the Environment handover.
4. The Launchpad uses its live `gh` login to reach (clone, fetch, update) those
   repositories. This replaces the heuristic "GitHub says the repository does not exist,
   so I have no access", which had many edge cases.
5. Later: modules of the Organization outside the Operator's access are visible as
   "další modul organizace" with "Požádat o přístup"; the request reaches the
   Organization's Owner in the Dashboard; the Owner fulfils it; the Dashboard writes the
   grant to GitHub; the Launchpad sees the new right and clones with its `gh` login.

### 1.1 Decisions of the evening of 2026-10-02 (Matěj)

1. **The Lazurio Account is the foundation.** An operator account belongs to a person,
   with GitHub linked to it; the operator owns Environments (VMs, laptops). The
   Launchpad signs in by a device code like `gh`, and by that the Launchpad represents
   the Environment itself, which is linked to the operator and thereby gets the
   operator's rights (section 4.1, design pending).
2. **Who registers (O4).** An operator registers their own Environment. A Team
   Environment is registered by the Organization's Owner (or Admin). An Automated
   Environment is always an Environment under an operator: registered by and
   accountable to that operator, with the persona's account as its GitHub identity.
3. **What runs without a click (O6, O7).** Clones and clean fast-forwards are
   automatic; removal only after a person confirms it; no automatic removal after a
   revoke in v1.
4. **Production Space is in v1 (O18, reversed).** The Launchpad must be able to clone
   Production Space repositories too, as some Organizations have them today. The
   composition covers the Production Space repositories an Organization declares, with
   the same access rule (read access by GitHub), materialized into
   `productionspace/<repository>` as the manifest declares. They are never started or
   released; the Launchpad shows the Production Space read-only (root rule for the
   Launchpad).
5. **The broker's repository allowlist goes (O16)**, and **manifest `teams` become
   legacy and are removed after the rollout (O17).**
6. **One contract with the shared shell.** The contract package and the Dashboard API
   of this plan are the ones the Environment list of plan DEV-6639 uses; where the
   sign-in sits in the Launchpad (the account at the bottom of the rail) is DEV-6639's.

The other open decisions of section 15 are not answered yet; their recommendations stay
recommendations.

## 2. Today

### 2.1 This repository

- **Catalog = what is checked out.** `readFolderCatalog` treats every directory under
  `<Folder>/organizations/` as a candidate Organization and reads its declared slots
  (`src/organizations/catalog.ts:553-596`). Execution admission rests on "the checkout
  is the operator's, GitHub already decided access when it was cloned"
  ([B1](launchpad-parity.md#b1-catalog-organizations-and-modules-read-from-the-folder),
  decided as H1). Team membership of a slot is read from the manifest's `teams` for
  display (`src/organizations/catalog.ts:178-224`); step 1 removes that display.
- **Materialization is not implemented.** [Content synchronization](content-sync.md)
  (F9) and P10 (`lazurio organization sync|add`,
  [B7](launchpad-parity.md#b7-organizations-synchronize-and-materialize)) are accepted
  direction without code: "a slot the signed-in identity cannot read is `denied`".
  Only `lazurio organization list` exists (`src/organizations/cli.ts:176`). New hosted
  Environments get their modules cloned by an agent from the manual (H4).
- **Explicit only.** Content synchronization runs only when a person or an authorized
  agent invokes it; "no first render, status request, health check, login … synchronizes
  anything" ([content sync](content-sync.md#explicit-only)).
- **The Lazurio Account is optional and identifies a service user only.** "Account
  login (OIDC) is added when the Launchpad needs a named person or managed-service
  enrollment … It does not admit a browser to a workspace, does not supply repository
  rights" ([hosted entry](hosted-entry.md#lazurio-account), F11); "A self-hosted
  Environment needs neither Lazurio Account nor Dashboard". F16 already expects one
  Account to sign into the Dashboard and every Launchpad and the Dashboard to serve a
  laptop's Machine Assignment after the Account sign-in; that API was left to the
  Dashboard ([F16](decisions.md#f16--one-network-per-organization-every-machine-is-reached-the-same-way-and-the-conglomerate-graph-is-the-truth-agents-move-along), "Not decided here").
- **Provider identity per preset** is declared (`src/folder/presets.ts:65`):
  `own-sign-in` (`local`, `hosted-personal`, `hosted-organization-personal`),
  `brokered-organization` (`hosted-organization-team`, where the curated `gh` sign-in is
  refused, `src/tools/team-github.ts:101-117`) and `persona-account`
  (`hosted-organization-steward`).

### 2.2 The handover

`account` in `lazurio.machine.json` is `null` and reserved for "the Machine's Lazurio
account identity issued by the Dashboard; null until that contract exists"
(`M:workloads/workspace-vm/lazurio-machine.v1.schema.json:264-267`; planned as
`lazurio.machine.v2`, `M:docs/machine-identity.md:87-90`). `owner` and `team` "do not
authorize cloning its repositories" (`M:docs/machine-identity.md:64-66`). The work VM
lane copies only the Organization root, never modules
(`M:workloads/workspace-vm/ansible/roles/workspace_organization/tasks/main.yml:22-33`). No per-Machine credential
can authenticate an Environment to the Dashboard: the gateway's per-VM OIDC client is
authorization-code only (no client credentials), and the broker credential exists only
on brokered Team VMs.

### 2.3 The Dashboard

- People sign in with GitHub through Better Auth; the immutable numeric GitHub id is the
  account's identity, the login is display (`D:src/auth.ts:1-19`). No OAuth token is
  stored. No device flow, no machine or Environment credential and no API a Launchpad
  calls exist; the Better Auth `device-authorization` plugin ships with the installed
  version but is not configured.
- It reads GitHub through the GitHub App *Lazurio for GitHub* with installation tokens:
  Teams with members and repository grants (`D:src/github/app-client.ts:1272-1390`),
  a user's permission on one repository (`:1588`), the Organization's manifests
  (`D:src/orgs/discovery.ts:17-18`, still the legacy `company.gen3.json` and
  `modules.manifest.json`). Organization structure is read at request time with a
  60-second per-instance cache (`D:src/orgs/cache.ts:20-25`); membership roles are
  mirrored and re-checked after 5 minutes (`D:src/memberships/freshness.ts:21`).
- **Module reachability today is derived from the manifest's Team names**, resolved to
  live Team ids and compared with the person's Teams (`D:src/orgs/access.ts:1-40`),
  not from the repository grant itself.
- Its own rules: the database holds only accounts, membership, plan and UI state;
  GitHub is the truth and drift is reported, never silently written back; every write
  to Organization structure is an apply plan (dry run → Admin approval → audit)
  (`D:AGENTS.md:74-92`). "Launchpad composition-from-declarations is Vision (S6+) … Do
  not build it in v1" (`D:AGENTS.md:632-634`).
- The Environment list is deployment configuration (a navigation registry with GitHub
  Team ids and personal owner ids), "not an ACL" (`D:src/hosted-workspaces/registry.ts:178-313`).

### 2.4 The Team broker

The broker mints a token for one repository after four gates: workspace credential,
the policy's repository allowlist, a live check of the Team's grant on that repository,
mint (`B:src/core.mjs:506-563`; live Team check since v0.9.0). The allowlist is
authored in the hosting owner's deployment repository, and the Dashboard is described
there as "a read-only lens" whose input "grants nothing by itself"
(`B:ARCHITECTURE.md:106-111`).
Which broker version runs in each Organization is **unverified**.

### 2.5 What goes wrong

The legacy engine decided presence by attempting provider operations and reading the
failure. A private repository the identity cannot see answers 404, exactly like a
repository that does not exist, was renamed away, or sits behind an SSO authorization
the token lacks; a broker allowlist refusal, a rate limit or a network fault reads
similar. Each produced its own edge case. The Dashboard, meanwhile, projects access
from manifest Team names, which is not what GitHub grants. And a team VM does not know
which modules it should hold at all.

## 3. Target model

Four questions, four owners. The first and the last are unchanged from F11.

| Question | Owner | Mechanism |
| --- | --- | --- |
| May this browser enter this Environment? (**admission**) | The gateway delivered with the Machine | Unchanged ([hosted entry](hosted-entry.md)) |
| Which Environment is asking the Dashboard? (**Environment identity**) | The Lazurio Account (section 4.1), through a registration the operator (or, for a Team Environment, an Owner or Admin) approves | Environment key registered at the Lazurio Account sign-in (section 4) |
| Which repositories belong in this Environment? (**composition**) | The Dashboard, as a live projection of GitHub | Composition API (section 6) |
| May this operation touch this repository? (**access**) | GitHub, the only access authority | Live at the operation boundary, through the Environment's own `gh` identity |

**Workspace.** The workspace of an Environment is the union, over the Organizations in
scope for that Environment, of the Organization root repository, the declared module
slots (workspace modules and root-level applications, [F24](decisions.md#f24--an-organizations-root-level-applications-are-modules-of-the-catalog))
and the declared Production Space slots (`productionspace/<repository>`), whose
repository the Environment's **composition subject** can read. Production Space
repositories are materialized and kept current like modules but never run or released;
the Launchpad shows them read-only. Repository-database mounts (`mission-control/db`,
`workspace/<module>/db`) stay the Organization's own bootstrap
([B7](launchpad-parity.md#b7-organizations-synchronize-and-materialize)) and are not
part of the composition. The subject is a
GitHub principal: a user (the operator, the person at their workstation, a persona) or
a GitHub Team (a Team Environment). Teams are not shown; they only decide, inside GitHub,
what the subject can read.

**What is a module stays declared.** The Organization manifest (`lazurio.organization.json`)
declares which repositories are module slots and Production Space slots, where they
live and which are restricted.
The composition never introduces a repository the manifest does not declare (variant
5.2), and the Launchpad derives every destination path from the manifest it read from
the Organization root, never from the Dashboard's answer.

## 4. Identity

### 4.1 Lazurio Account (identity foundation) — placeholder, design pending

**Direction (Matěj, 2026-10-02).** The Lazurio Account is the foundation of identity.
An operator account belongs to a person and has the person's GitHub account linked to
it. The operator owns Environments: laptops and VMs. The Launchpad signs in by a device
code, as `gh` does; by that the Launchpad represents the Environment itself, which is
linked to its operator and thereby gets the operator's rights.

**Pending.** A separate research is establishing what exists today and what the
account has to be: which system issues the Lazurio Account (the Dashboard's Better
Auth sign-in, which uses GitHub only, or the Keycloak-based Lazurio Auth issuer), how
GitHub is linked to it, how this fits the maintainers' plan that the Dashboard is a
relying party of one account issuer and not an issuer of human accounts (plan
DEV-6552), and where the record of an Environment and its owner lives. How "the
operator owns the Environment" relates to the hosting ownership of a work VM, which
belongs to the Organization (root 0144, 0165), and to a Team Environment, which has no
single operator, is part of the same design. Sections 4.2 to 7.4 describe the
Environment's side, which holds whichever system issues the account: a registration
the operator approves by device code, a key the Environment generates, and requests the
Environment signs. They will be revised when this section is designed.

### 4.2 Identity per Environment kind

The composition subject is always the GitHub principal the Environment works as, never
the person who happens to be signed in to the Launchpad. The person who registers
authorizes the Environment to ask and stays accountable for it.

| Environment (root 0165/0169) | Preset | Who registers it (O4, decided) | Composition subject | Organizations in scope | GitHub identity used to clone | Local check before applying |
| --- | --- | --- | --- | --- | --- | --- |
| Workstation (Local Environment, the person's own device) | `local` | Its operator: the person, with their Lazurio Account | The GitHub user linked to that Account | Every Organization with the GitHub App installed whose root repository the user can read, minus Organizations the person excluded (O2) | The person's own `gh` sign-in | `gh`'s active account id equals the subject |
| Personal Remote Environment | `hosted-personal` | Its operator, the Owner | None (no Organization repositories, preset rule) | None | — | — (no composition is requested) |
| Work Environment (one operator) | `hosted-organization-personal` | Its operator, the one assigned (`owner.assignment.github_id`) | The operator's GitHub user | The owning Organization only (O3) | The operator's own `gh` sign-in | `gh`'s active account id equals the subject |
| Work Team Environment | `hosted-organization-team` | An Owner or Admin of the Organization | The GitHub Team the Environment is assigned to (immutable Team id) | The owning Organization | Lazurio for GitHub through the Organization's broker (0147) | `gh` resolves the brokered App identity (`ghIdentity` → `app` or `variable`) |
| Automated Environment | `hosted-organization-steward` | Its operator, the responsible one (`owner.assignment` `automation`); always an Environment under an operator | The persona's GitHub user, linked by proof of control | The owning Organization | The persona's account, signed in by the operator | `gh`'s active account id equals the subject |

Notes:

- **Personalspace is never part of a composition.** The Launchpad never sends a
  Personalspace path, name or state to the Dashboard (root 0091).
- **The subject of a Work Environment follows its binding.** Which GitHub account an
  operator's Work Environment is bound to is the infra roster's `owner.assignment`
  today; the Dashboard serves the merged value live, so the Launchpad follows a change
  without a Machines rollout (fulfilment of root 0159, O12). A changed binding revokes
  the registration; the new operator registers again.
- **An Automated Environment is always under an operator** (decided). Its operator
  registers it and answers for it; the persona's account is its GitHub identity. The
  handover names the operator, never the persona, and a composition reveals what its
  subject can read, so the persona's account is never accepted as a typed name.
  Recommendation: it is linked by proof of control — during registration the operator
  signs in to GitHub as the persona (the operator holds that account and its second
  factor, F27) and the Dashboard records the persona's immutable id from that sign-in.
  Once the infra roster also declares the persona (a Machines change), the Dashboard
  checks that the two agree. The local check refuses to apply under any other account.
- **A Team Environment never uses a person's account** (root 0168; F31 as proposed in
  pull request #119). It is registered by an Owner or Admin, who answers for it; its
  rights are the Team's, not the registering person's. Any Team member connected to the
  Environment sees the Team's composition, which they can already see as members.
- **The Team of a Team Environment is an immutable GitHub Team id**, the one the
  broker's policy binds the Environment to and the Dashboard's navigation registry
  already carries; never a Team name from the manifest or the handover.
- **An Owner's own Environments** read every repository with `admin`. Restricted slots
  (`infra` and the like) therefore arrive as `offer`, never `present`, so an Owner's
  workstation does not clone them without an explicit "Přidat" (root 0150, B7).

## 5. Variants

### 5.1 Where the composition is computed

| Variant | Assessment |
| --- | --- |
| A. The Launchpad asks GitHub itself through `gh` (today's family of heuristics) | No Dashboard dependency; but a Team Environment's brokered identity cannot list what it could read, a person's `gh` cannot tell "absent" from "denied", and every Launchpad version carries the heuristics; rejected by the direction |
| B. A snapshot in the handover written by Machines | Needs a Machines apply for every grant change; stale by construction; mixes hosting with access; rejected by the direction |
| C. The Dashboard reads GitHub live per request, with a short bounded cache, and answers the Launchpad (selected) | One place reads GitHub with the App's full view (Teams, grants, collaborators); one projection for every Environment kind; GitHub stays the authority |
| D. The Dashboard syncs grants into its database and answers from there | A second copy of access; violates the Dashboard's own invariant that Organization structure is read at request time; rejected |

### 5.2 Which repositories are modules

| Variant | Assessment |
| --- | --- |
| A. Declared module and Production Space slots of the Organization manifest ∩ live access (recommended, O1) | One reviewed declaration in Git already carries path, restriction and status, and `lazurio module create` writes it; the Dashboard cannot make the Launchpad clone an undeclared repository or write outside a declared path |
| B. Any readable repository with `lazurio.module.json` on its default branch | No slot list; but one content read per repository, no place for `restricted`, and a stray repository becomes a module by a file |
| C. Every repository the subject can read | Brings `infra`, data repositories and unrelated repositories into the workspace; rejected |

### 5.3 How the Launchpad signs in

| Variant | Assessment |
| --- | --- |
| E1. Device-code registration, as `gh` signs in, approved by the operator (an Owner or Admin for a Team Environment); the Environment generates a key pair and registers the public key; it then signs its requests as the Environment (device code decided; the key is the recommendation of O5) | One flow for every kind, headless and behind the gateway; the private key never leaves the Environment; no person's session is needed after registration; revocable per Environment |
| E2. Machines provisions the identity at apply and writes it into the handover (`account`, `lazurio.machine.v2`) | Zero-touch for hosted Environments; but Machines gets a Dashboard credential and a secret travels in custody; no answer for workstations; a later improvement on top of E1, not a replacement |
| E3. Reuse the gateway's session (Keycloak) | Admission is not identity (F11); the Launchpad never sees an identity from the gateway; per-VM clients have no client credentials; rejected |
| E4. Every person signs in, each with their own session | No composition while nobody is signed in; a person's session on a shared Team Environment; the subject would be the person, which is wrong for Team and Automated Environments; rejected |
| E5. Reuse the Team broker's credential | Exists only on brokered Team VMs; couples the Dashboard to the broker's secret; rejected |

### 5.4 How much is applied without a click

| Variant | Assessment |
| --- | --- |
| Explicit only, as content sync says today | Matches F9; but the direction expects the Environment to follow access ("the Launchpad sees the new right and clones"), and a Team Environment would never update by itself |
| Additions and clean fast-forwards automatic, removal always a confirmed proposal (decided 2026-10-02, O6 and O7) | Non-destructive operations follow GitHub without a person; every destructive one waits for a person; changes F9's "explicit only" for exactly these two operations |
| Fully automatic including removal of clean checkouts | A wrong answer, a revoked-by-mistake grant or a Dashboard defect deletes checkouts across a fleet; rejected for v1 (decided) |

## 6. The composition API

### 6.1 Endpoints (v1)

All under the Dashboard's origin, `/api/environment/v1/…`, JSON over HTTPS. Request and
response types come from the shared contract package (section 7).

| Endpoint | Purpose |
| --- | --- |
| `POST /api/environment/v1/device` | RFC 8628 device authorization. The Launchpad sends `client_id: lazurio-launchpad`, its public key (JWK, ES256) and the facts it claims (kind, Machine name and Organization from the handover, or `workstation`). Answers `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `interval`, `expires_in`. |
| Dashboard page `/device` | The person signs in with their Lazurio Account (section 4.1; with GitHub on the Dashboard today), sees the claimed facts next to what the Dashboard knows (the infra roster for a hosted Environment), and approves only what the rules of section 4.2 allow; the Environment is then linked to that operator, or to the Organization for a Team Environment. No token of that person ever reaches the Environment. |
| `POST /api/environment/v1/device/token` | Polled with `grant_type=urn:ietf:params:oauth:grant-type:device_code` as RFC 8628 says; on approval it answers the `environment_id` instead of an access token: the registration is complete and the registered key is the credential. |
| `GET /api/environment/v1/environments/{environment_id}/composition` | The composition, with `ETag`; `If-None-Match` answers 304. `Cache-Control: no-cache` from an explicit "Synchronizovat" asks for fresh GitHub reads, rate-limited per Environment. |
| `POST /api/environment/v1/environments/{environment_id}/report` | Optional (O10): the composition digest the Launchpad applied and a state code per entry. No paths, branch names, commit messages or file names. |
| `POST /api/environment/v1/environments/{environment_id}/revoke` | Self-revocation when the Operator disconnects the Environment from the Launchpad. Revocation from the Dashboard's Environment list deletes the key. |
| `GET /api/environment/v1/environments` | The Environment list of the shared shell (plan DEV-6639, its P3): the Environments of the operator this Environment is linked to, grouped per Organization. Its shape is DEV-6639's; it lives in the same API group and contract package and uses the same authentication (section 7.5). |

**Authentication after registration (O5).** Every request carries
`Authorization: Bearer <assertion>`, a JWT the Environment signs with its key (ES256):
`iss` and `sub` the `environment_id`, `aud` the Dashboard's API origin, `iat`, `exp` at
most five minutes later, a unique `jti` the Dashboard refuses to see twice. It is the
pattern of a GitHub App calling GitHub with its own JWT: no token endpoint, no issued
secret on disk, nothing to refresh; the Dashboard verifies the signature against the
registered public key and the registration's state on every request.

Access requests (M6) are made on a Dashboard page, not through this API: the Launchpad
opens `…/access-requests/new?repository=<id>&environment=<id>` and the person signs in
there with their own account, so the request carries a person, not an Environment.

### 6.2 The composition document

Wire JSON, shown as TypeScript for reading; the contract package defines it once.

```ts
type WorkspaceComposition = {
  schema: "lazurio.workspace-composition.v1";
  environment: {
    id: string; // opaque, issued at registration
    kind: "workstation" | "work" | "work-team" | "automated"; // personal: no composition
    machine: string | null; // Machine name for a hosted Environment
  };
  subject:
    | { kind: "github-user"; githubUserId: number; githubLogin: string }
    | { kind: "github-team"; githubOrganizationId: number; githubTeamId: number; slug: string };
  digest: string; // sha256 over the canonical JSON of `organizations`
  observedAt: string; // oldest GitHub read the answer rests on (RFC 3339)
  refreshAfterSeconds: number; // the Dashboard's polling hint
  organizations: ReadonlyArray<{
    githubOrganizationId: number;
    login: string;
    state: "complete" | "incomplete";
    reason?: "github-unavailable" | "rate-limited" | "manifest-invalid" | "app-not-installed";
    root: Entry; // the Organization root repository
    modules: ReadonlyArray<Entry & { slot: string; restricted: boolean; requestable: boolean }>;
    productionspace: ReadonlyArray<Entry & { slot: string; restricted: boolean }>; // read-only, never run
  }>;
};

type Entry = {
  repository: {
    githubRepositoryId: number; // immutable; a rename changes only fullName
    fullName: string;
    defaultBranch: string;
    archived: boolean;
  };
  access: "read" | "triage" | "write" | "maintain" | "admin" | "none" | "unknown";
  desired: "present" | "offer" | "absent" | "unchanged";
  reasons: ReadonlyArray<string>; // e.g. "access-revoked", "slot-retired", "excluded", "restricted"
};
```

Semantics:

- **`access`** is the subject's effective permission read from GitHub at `observedAt`.
  `none` only from a successful read that says so; any failed, partial or ambiguous read
  is `unknown`. Absence of evidence is never evidence of absence.
- **`desired`** is the Dashboard's statement about presence, never a local action:
  `present` (readable, declared, not restricted, not excluded), `offer` (readable but
  materialized only on a person's explicit "Přidat", e.g. a restricted slot,
  [B7](launchpad-parity.md#b7-organizations-synchronize-and-materialize)), `absent`
  (a confirmed `none`, a retired slot or an explicit exclusion) and `unchanged`
  (the Dashboard cannot tell; keep whatever is there). The Launchpad turns it into an
  action from the local state it alone knows (section 8). The Dashboard never learns or
  decides local state.
- **`productionspace`** lists the declared Production Space slots
  (`productionspace/<repository>`) with the same access rule and the same `desired`
  values as modules. The Launchpad materializes and updates them like modules and never
  starts, opens or releases them. They carry no `requestable` in v1 (recommendation).
- **`requestable`** (M6) marks a declared, non-restricted module slot the subject cannot read
  and may ask for. Restricted slots are never requestable. A user subject is eligible
  when it is a member of that Organization; a Team subject belongs to the Organization
  by construction, and the person who files a request for it must be a live member of
  that Team.
- **An `incomplete` Organization** carries every entry as `unchanged`.
- **Unknown members are ignored** by a client of the same major version; an unknown
  enum value is treated as `unchanged` (for `desired`) or `unknown` (for `access`).

### 6.3 Versioning, digest and caching

- **Contract versions.** The path carries the major version (`/v1`); the body carries
  `schema`. Within a major version the Dashboard only adds optional members and new
  enum values that old clients may safely read as `unchanged`/`unknown`. A breaking
  change is a new major path; the Dashboard serves **N and N-1** until no registered
  Environment reports N-1 (each request carries `User-Agent: lazurio/<version>` and
  the Dashboard counts per major). Launchpads update at different times (F17), so this
  window is measured, not assumed.
- **Digest.** `digest` covers the canonical JSON of `organizations` and is the `ETag`.
  The Launchpad applies a composition once per digest and remembers the last applied
  digest.
- **Dashboard cache.** GitHub reads are cached per (subject, Organization) for at most
  60 seconds, like today's Organization snapshot, and use conditional requests
  (`If-None-Match`) toward GitHub. Webhooks of the GitHub App (membership, Team,
  repository events) may invalidate earlier; they are an optimization, not a source of
  truth.
- **Launchpad cache.** The last composition and its digest are product state of the
  Folder (written atomically, owned by the operator account, never authority). It is
  read when the Dashboard is unavailable (section 10) and to show the workspace
  immediately on start.
- **Freshness.** The Launchpad asks on start, after registration, every
  `refreshAfterSeconds` (proposed 300) and on "Synchronizovat". A grant made in GitHub
  appears within one refresh plus one cache period, or at once with "Synchronizovat".
  Push (a WebSocket RPC stream or server-sent events) is a later optimization (O11).

## 7. Technology: a typed interface between the Launchpad and the Dashboard

Both sides are TypeScript on Bun: this repository (Bun 1.4.2, few dependencies —
`ajv`, the Sigstore verifier, `minimatch`, `uqr` — one compiled, attested executable,
F13/F20) and the Dashboard (Bun, its own routing over `Bun.serve`, Better Auth, `jose`,
`openid-client`, `pg`, `ajv`; `D:src/app.ts`, `D:src/server.ts`). The interface must be
typed end to end and validated at runtime on both sides, because Launchpads of
different versions call one Dashboard.

**The reference: T3 Code.** The fork keeps one contracts package
(`T:packages/contracts`, `@t3tools/contracts`, depending only on `effect`, pinned
`4.0.0-rc.115` through the workspace catalog) that the server and every client import.
Data is `effect/Schema`; HTTP endpoints are `effect/unstable/httpapi` groups with
payload, success and error schemas and authentication as `HttpApiMiddleware`
(`T:packages/contracts/src/environmentHttp.ts:411-470`, including the token endpoint,
browser session and pairing); live streams are `effect/unstable/rpc` groups over a
WebSocket (`T:packages/contracts/src/rpc.ts:1452`). Its relay already models an OAuth 2.0
token exchange that issues DPoP-bound tokens to public clients with ES256 keys
(`T:packages/contracts/src/relay.ts:743-800`), which is close to what an Environment
key needs.

### 7.1 Variants

| Criterion | A. Effect Schema + `HttpApi` contract package (T3 style) | B. JSON Schema + ajv, generated TypeScript types | C. Zod / Valibot / ArkType + a typed client (oRPC contract-first, or Hono RPC) |
| --- | --- | --- | --- |
| End-to-end types | Types derived from the schemas; a typed client derived from the API definition (`HttpApiClient.make`); typed errors per endpoint; server handlers typed by the same definition | Types by code generation or `JSONSchemaType<T>`; routing, client and error mapping written by hand on both sides | Types inferred from schemas; oRPC gives a contract-first typed client and server; **Hono RPC infers the client from the server's implementation**, which a public client cannot import from a private server — unusable here |
| Runtime validation, both sides | Decode and encode with the same schema, including branded ids and dates | ajv on both sides (both repositories already use it) | Yes |
| Compatibility N/N-1 | Decoders ignore unknown members by default (`onExcessProperty: "ignore"`), so additive changes are safe; two majors coexist as two groups | Response schemas must stay open to additions, against this repository's convention of closed schemas for files it reads | Unknown keys stripped by default |
| OpenAPI | Generated from the same definition (`effect/unstable/httpapi/OpenApi`); no second source | OpenAPI 3.1 embeds JSON Schema; the document is assembled by hand | Through a generator per library |
| Supply chain, executable size | One package, but a **release candidate**, and `httpapi`/`rpc` live under `effect/unstable/*`, which may change between candidates; size and cold-start cost unmeasured (**unverified**) | Nothing new at runtime | One to several packages |
| Programming model | Effect (`Effect`, `Layer`, `Context`) is a paradigm; confined to the contract package and one adapter here, mountable in the Dashboard as a web handler (`HttpRouter.toWebHandler`) inside the existing `Bun.serve` | None | Small |
| Alignment with the T3 fork | Same idioms and people; the auth, token and pairing schemas are a direct reference; a future RPC push uses the same machinery | None | None |
| Testing | In-memory client against the handler layer; contract snapshot tests | Fixtures and snapshot tests | Fixtures and snapshot tests |

### 7.2 Recommendation (O13)

**A, under four guardrails,** because it gives one definition for types, validation,
typed errors, authentication middleware, client and OpenAPI, and the same idiom the
fork already uses:

1. **The wire contract is a committed artifact.** The contract package generates its
   OpenAPI document into `packages/contracts/openapi/v1.json`; a test fails when the
   generated document differs from the committed one. Changing it is a reviewed
   change with a version note. Compatibility tests check N and N-1 snapshots, so an
   Effect upgrade cannot silently change the wire.
2. **Effect stays at the edge.** In this repository only `packages/contracts` and one
   Dashboard client adapter (`src/dashboard/`) import `effect`; the application core
   receives plain typed values. The Dashboard may implement the group with
   `HttpApiBuilder` or decode with the schemas inside its own handlers; either way the
   types come from the package.
3. **Exact pin, upgraded together.** `effect` is pinned exactly, preferably to the
   version the T3 fork's catalog pins, and upgraded in both repositories in one step.
4. **A measured spike decides before M3.** The spike builds the compiled Launchpad with
   the client adapter and records the executable size delta, the cold-start delta, the
   lockfile diff and the public-repository checks. Thresholds are proposed in O13. If
   they fail, **B** replaces the implementation behind the same committed OpenAPI
   document: the wire contract, the Dashboard's routes and every registered Environment
   stay as they are.

### 7.3 Where the contract package lives (O14)

**Decided 2026-10-02 (Matěj):** the contract package lives in this repository and the
Dashboard takes its types from it, as a dependency. The table below keeps the
comparison of how the Dashboard consumes it; that part is still a recommendation.

| Variant | Assessment |
| --- | --- |
| `packages/contracts` (`@lazurio/contracts`) as a Bun workspace package in this repository, attached as an attested artifact to every release, pinned by exact URL and integrity in the Dashboard (recommended) | The client is public anyway; public review of the contract; one trust mechanism (GitHub artifact attestation, F13); the Dashboard's CI verifies the attestation before an upgrade |
| Published to npm with provenance | Standard for libraries; but adds an npm organization and a second trust root; npm was rejected as the product's door (F20). A later option for third-party consumers |
| Consumed by exact Git commit | A Git dependency installs from a repository root, not from a subdirectory of this repository (**unverified** for the pinned Bun); would need its own repository |
| Authored in the Dashboard and vendored here with provenance, like the handover schema from Machines | Fits the handover precedent; but the source of truth of a public client's contract would be private; rejected by the decision |

Order of a change: contract change merged here → release (the Launchpad may still use
the old major) → the Dashboard upgrades the package and serves N and N-1 → a later
Launchpad release switches to N.

### 7.5 One contract with the shared Lazurio shell (plan DEV-6639)

Plan DEV-6639 gives the Dashboard, the Launchpad, Chat (the T3 Code fork) and Lazurio
MausBot one frame: a left rail of Environments grouped per Organization, with the
account and Settings at the bottom, and a contract for the Environment list that the
Dashboard owns (its P3). Both plans need the same things, so they share them (Matěj,
2026-10-02):

- **One contract package.** `@lazurio/contracts` carries both the Environment list
  (DEV-6639) and the composition (this plan), with one versioning rule and one OpenAPI
  snapshot.
- **One API group and one sign-in.** Both live under `/api/environment/v1/` and use the
  same registration and the same signed requests; a registered Environment fetches its
  operator's Environment list and its own composition with the same credential.
- **What DEV-6639 owns.** The shape of the Environment list, its offline cache and the
  local "Tento počítač" entry, and where the sign-in sits in the Launchpad (the account
  at the bottom of the rail). This plan provides the sign-in flow behind it.
- **Shared open point.** A Team Environment is linked to an Organization, not to one
  operator, so the list it should show depends on the person at the browser; the
  Environment's own credential cannot answer that. DEV-6639 decides whether its rail
  there asks the Dashboard with the person's own session.

### 7.4 The sign-in flow (O5)

- **Device authorization grant (RFC 8628), as `gh` signs in** (decided 2026-10-02).
  Which system serves it follows section 4.1; the Dashboard's Better Auth installation
  ships it (`device-authorization` plugin). It binds an Environment key to the approval
  of a signed-in operator; it issues that person nothing. The
  Launchpad shows the link, the code and a readable QR code exactly as for the curated
  tool sign-ins (F19); the CLI has `lazurio account login` with the same output. On the
  Launchpad page "Přihlásit" opens `verification_uri_complete` in a new tab, so a person
  at a browser gets the one-click feel of a redirect without typing the code.
- **Why not a browser redirect (authorization code with PKCE).** It needs a redirect
  URI registered for every Environment's origin (one per hosted Environment, a loopback
  listener for the CLI and for a workstation), and it hands the Environment a token of
  the person, which then has to be exchanged for the Environment's own credential. The
  device grant works the same from the CLI, a headless hosted Environment and the
  Launchpad page, and never puts a person's token on the Environment.
- **The Lazurio Account.** Placeholder, see section 4.1: the operator's account, with
  GitHub linked, is the foundation, and its design is pending. What this section
  assumes of it is only that an operator can sign in to approve a device code and that
  the Environment can be linked to that operator (or, for a Team Environment, to the
  Organization). An Environment key is not a human account.
- **The Environment key.** ES256, generated by the Launchpad with WebCrypto at
  registration; the private key stays in the Folder's product state (mode 0600, the
  operator account) and is never printed, exported or sent. On a Team Environment it is
  shared by everyone on that Environment by design: it represents the Environment.
- **Requests** carry a short-lived assertion signed by that key (6.1): variant (a),
  recommended. Alternatives: (b) the Environment as an OAuth client of the Lazurio Account issuer with
  `private_key_jwt` client credentials (RFC 7523), which needs a client per Environment
  in the issuer, a second registry next to infra; (c) a refresh token bound by DPoP
  (RFC 9449) as in the fork's relay; (d) the Better Auth device plugin's default, a
  long-lived bearer session on disk, rejected.
- **Revocation.** Disconnecting in the Dashboard's Environment list deletes the key;
  a changed Work Environment binding, a deleted Account (workstation) or a removed
  Machine (hosted) revokes it automatically. The Launchpad answers a refused assertion with
  "odpojeno", keeps the last composition read-only and offers a new sign-in.
- **Nothing is copied.** `gh`'s token never leaves `gh`'s store; the Dashboard never
  receives it and never hands the Launchpad a GitHub token; the App's installation
  tokens never leave the Dashboard; the person's Dashboard session never reaches the
  Environment.

## 8. The Launchpad applies a composition

CLI first: `lazurio workspace status [--json]` (read-only plan),
`lazurio workspace sync [--json]` (apply), `lazurio account login|logout|status`. The
Launchpad's "Synchronizovat" calls the same use case. P10 (`organization sync|add`) is
implemented once, as the executor of a composition; without a composition it executes
the Folder's own declaration exactly as [content sync](content-sync.md) says.

Order per Organization, as content sync's hierarchy: the root first (clone if absent,
fast-forward if clean), re-read its manifest, then the modules and the Production Space
repositories. A composition entry that does not match a slot declared by that manifest
(by repository id or full name) is reported `not-declared` and ignored.

| `desired` \ local | Absent | Clean, on the default branch | Dirty, other branch, ahead, diverged, operation in progress | Occupied by something else |
| --- | --- | --- | --- | --- |
| `present` | Clone (content sync's materialization) | Fetch, fast-forward | Fetch only; `blocked` with reason | `occupied`, untouched |
| `offer` | Show "Přidat"; clone on click | As `present` | As `present` | As `present` |
| `absent` | Nothing | Removal **proposal** (section 9) | `retained` with reason; nothing changes | Untouched |
| `unchanged` | Nothing | Fetch, fast-forward | Fetch only | Untouched |
| not in the composition, but on disk | — | Kept, shown "mimo složení" | Kept | — |

- **Automatic part (O6, decided).** After a new digest, clones of `present` entries and
  fast-forwards of clean checkouts run without a click. A fast-forward waits while an
  application of that module runs from that checkout ("aktualizace čeká, modul běží").
  Dependency preparation stays the module's declared preparation, invoked explicitly
  ([content sync](content-sync.md#after-content-changes)).
- **Production Space (O18, decided).** A declared Production Space repository is
  materialized into its declared `productionspace/<repository>` path and kept current by
  exactly the rules of the table: clone when absent, fast-forward only a clean checkout
  on its default branch, fetch only otherwise. A Production Space repository keeps its
  own branch and release model (root 0041), so work on another branch is never touched.
  The Launchpad shows these repositories read-only: no Start, Open, preparation or
  release, as the root rule for the Launchpad says. This amends content sync's exclusion
  of the Production Space (section 14).
- **Identity check first.** Before any provider operation the Launchpad checks section
  4's local condition. A mismatch (`identity-mismatch`: another `gh` account, no sign-in,
  a person's account on a Team Environment) applies nothing and offers the sign-in of
  the expected account by name.
- **No inference from errors.** A clone or fetch that fails while `access` is `read` or
  better is `access-mismatch` with `gh`'s exact message and the known causes as hints
  (another account, SSO authorization, the broker's allowlist until it is dropped
  (O16), propagation delay).
  It never turns into "no access".
- **A suspicious answer.** When one digest would turn more than half of the present
  modules of an Organization `absent`, the Launchpad applies none of those absences,
  reports `suspicious-composition` and waits for the next digest.

## 9. Removal ("ubrat")

"Ubrat" means the checkout leaves the Environment because the composition says
`absent`. It is never automatic in v1 (O7, decided). The Launchpad proposes it; a person on the
Environment confirms the exact list; the Launchpad removes only a checkout for which all
of these hold, checked immediately before deletion:

1. No uncommitted change to a tracked file and no untracked, non-ignored file.
2. No commit on any local branch that is not reachable from a remote-tracking ref
   (`git rev-list --branches --not --remotes` is empty) and no stash.
3. No linked worktree of that repository (task worktrees block removal entirely).
4. No merge, rebase, cherry-pick, bisect or `am` in progress.
5. No application of that module is running.
6. Ignored files are listed with their total size in the proposal; the person confirms
   them with the checkout.

A checkout that fails any guard stays, as `retained` with the reasons, and the
Launchpad says plainly that there is local work in a module the Environment no longer
has access to. Rescuing that work is a person's or an agent's explicit task in that
repository. The same guards hold for Production Space repositories. Removing the
Organization root is proposed only when none of its modules and Production Space
repositories remain. On Organization-owned Environments the report (O10) lets an Owner see
`retained` checkouts after a revoke.

## 10. Offline, outage and failure behaviour

| Situation | Behaviour |
| --- | --- |
| Dashboard unreachable, timeout, 5xx | Keep the last composition; banner with its age; no removal proposals; repositories already present still fetch on explicit sync |
| Registration revoked or unknown (`invalid_client`) | `disconnected`: last composition read-only, no automatic step, offer a new sign-in; nothing removed |
| An Organization `incomplete` | Its entries are `unchanged`; other Organizations continue |
| GitHub confirms `none` for a module | `absent` with `access-revoked`; removal proposal only |
| Composition says granted, clone fails | `access-mismatch` with the exact error; retried at the next digest or sync |
| `gh` signed out or another account | `identity-mismatch`; nothing applied; sign-in offered for the expected account |
| Team broker unavailable | `clone-unavailable`; nothing inferred |
| A repository renamed on GitHub | Matched by id; the local remote is reported `remote-renamed` and corrected only by an explicit action |
| A new digest while applying | The running apply finishes with the composition it started; the next run takes the new one (per-Organization content lock) |
| Clock skew on the Environment | Assertions carry `iat`/`exp`; the Dashboard allows a bounded skew and says so in the error |
| No Lazurio Account at all (self-hosted, before registration) | Unmanaged mode (O8): today's Folder catalog and explicit `lazurio organization add|sync` of what the person names; no automatic additions or removals |

## 11. Security

- **GitHub remains the authority.** The composition grants nothing: a clone succeeds
  only if GitHub lets the Environment's own identity read the repository.
- **Blast radius of a compromised or wrong Dashboard.** It can only choose among slots
  that Organizations declared in reviewed Git, and only repositories the Environment's
  identity can already read get cloned, into paths the manifest declares. It can hide
  modules (a denial of service) and it can propose removals, which need a person and
  pass the guards of section 9. It never receives a GitHub credential of an Environment.
- **Cross-Organization isolation.** The Dashboard answers only the Organizations in
  scope for the Environment's kind (section 4); the Launchpad independently refuses
  entries for an Organization other than the handover's `owner.organization` on an
  Organization-owned Environment. On a multi-Organization workstation each
  Organization materializes only under its own root and fails alone.
- **Information exposure.** A composition names repositories. `requestable` entries
  reveal names of repositories the subject cannot read; they are limited to declared,
  non-restricted slots, to eligible subjects (members of that Organization, or its own
  Teams) and to Organizations whose Owner turned it on (O9).
- **Production Space repositories** can hold sensitive source (firmware, production
  services). They arrive only where the subject can read them, a restricted one only as
  `offer`, and the Launchpad never runs them.
- **Personalspace and personal Environments** never appear in a composition or a report.
- **Audit.** Registration, revocation, every access request, its approval and the GitHub
  write are audit events in the Dashboard; the Dashboard has no audit table today and
  gets one with M4/M6.

## 12. Access requests (M6)

1. The Launchpad lists `requestable` modules under "Další moduly organizace" with
   "Požádat o přístup", which opens the Dashboard's request page for that repository
   and Environment.
2. The person signs in to the Dashboard and sends the request with a reason. On a Team
   Environment the request is for the Team; elsewhere for the person.
3. An Owner sees the request and the exact GitHub change it implies (which Team or
   person gets which permission on which repository) and approves or declines.
4. On approval the Dashboard performs that one change as an apply: dry run, the Owner's
   approval, the write, a read-back from GitHub, an audit record. The write runs with the
   approving Owner's GitHub authority (O15), so GitHub checks the Owner's live rights and
   its audit log names the Owner.
5. The Dashboard invalidates the affected cache; the next composition shows `present`;
   the Launchpad clones with its own `gh` (or the broker, for a Team).

For a Team Environment the broker's repository allowlist must follow the Team's grant,
or the clone is refused by the broker even though GitHub allows it (O16).

## 13. Migration from today

1. **Step 1 (F32, pull request #122):** flat workspace; nothing else changes.
2. **Unregistered Launchpads keep working** in the unmanaged mode (section 10, last row).
3. **Registered Launchpads** show the composition over the Folder catalog: "k přidání"
   for entries not on disk, "mimo složení" for checkouts the composition does not name.
   Additions and fast-forwards then follow O6; removal proposals start only after the
   rollout evidence (M7).
4. **Existing checkouts are adopted as they are:** a checkout that matches its slot and
   remote is `current`; nothing is re-cloned. This includes Production Space checkouts
   that some Organizations have today.
5. **Hosted Work and Team Environments** stop needing an agent to clone modules by hand
   (H4): the composition does it.
6. **The Dashboard's own module view** moves from manifest Team names to the live
   repository permission the composition uses (M4).
7. **Manifest `teams`** stop being shown by the Launchpad with step 1 (F32 keeps them in
   the catalog for the Teams column of `lazurio module list`); they become legacy and
   are removed after the rollout (O17, decided).
8. **Root-repository installations** (root decision 0164) are out of scope; they move to
   a Folder first.

## 14. Decisions this changes (to be recorded in M2)

| Decision | Change |
| --- | --- |
| Root 0149 | Confirmed: live GitHub grants are the only authority, a desired mapping never grants. Extended: the Dashboard projects access for Environments and may write one GitHub grant as the apply of an Owner's explicit approval, with audit (M6). |
| Root 0159 | Fulfilled for registered Environments: the binding of a Work Environment to a GitHub account is served by the Dashboard, and the Launchpad applies a composition only under that account. Unregistered Environments keep 0159 as is. |
| Root 0021/0023/0041 (2–5) | Teams as manifest declarations stop shaping the Launchpad; Teams and access are managed in GitHub through the Dashboard. |
| Root 0147 | The broker drops its repository allowlist and relies on the live Team grant it already checks (O16, decided). |
| Root 0041 (6–7) and root 0129 (exclusions of the general update) | Production Space repositories are materialized and fast-forwarded by the composition under the guards of section 8; their own branch and release models stay; the Launchpad keeps showing them read-only (O18, decided). |
| Root 0144 / 0165 (Owner of a work VM is the Organization) | To be reconciled with "the operator owns Environments" in the Lazurio Account design (section 4.1). |
| Root `ARCHITECTURE.md`, Hosted Team Workspace | "Manifesty Organizace určují dostupné Team moduly" becomes "the composition from the Dashboard determines them". |
| F9 / [content sync](content-sync.md) | "Explicit only" keeps for everything except composition-driven additions and clean fast-forwards (O6); the Production Space leaves the list of what is never synchronized (O18). |
| F11 / [hosted entry](hosted-entry.md) | The Lazurio Account sign-in is the Environment's registration; it still neither admits nor grants. Self-hosted keeps working unmanaged. |
| [B1](launchpad-parity.md#b1-catalog-organizations-and-modules-read-from-the-folder) | Execution admission unchanged; what gets materialized follows the composition. |
| Dashboard rules | "Launchpad composition-from-declarations … do not build in v1" is superseded; the write path of M6 is the apply its rules already require. |

## 15. Decisions and open questions

Rows marked **Decided** are Matěj's decisions of 2026-10-02; every other row is the
recommendation of this shaping and still open.

| # | Question | Decision or recommendation |
| --- | --- | --- |
| O1 | Which repositories are modules of a workspace? | Recommendation: declared module and Production Space slots of the Organization manifest ∩ live access (5.2 A) |
| O2 | Which Organizations go onto a workstation? | Recommendation: all Organizations of the Account where the App is installed, with a per-Environment exclusion of whole Organizations in the Dashboard (narrows, never widens) |
| O3 | Which Organizations go onto a Work Environment? | Recommendation: only the owning Organization; other Organizations stay explicit and unmanaged |
| O4 | Who registers which Environment? | **Decided:** an operator registers their own Environment; an Owner (or Admin) registers a Team Environment; an Automated Environment is always under an operator, registered by and accountable to that operator, with the persona's account as its GitHub identity. Recommendation: the persona's account is linked by proof of control (4.2); Machines-provisioned registration (E2) later for zero-touch fleets |
| O5 | What credential does the Environment hold? | **Decided:** sign-in by device code, as `gh`. Recommendation: a key pair generated on the Environment, registered by a device code a signed-in person approves in the Dashboard; every request a short-lived assertion signed by the key (GitHub App pattern); no human token on the Environment |
| O6 | What runs without a click? | **Decided:** clones of `present` entries and fast-forwards of clean, not-running checkouts; removal always confirmed |
| O7 | Automatic removal after a revoke on Organization-owned Environments? | **Decided:** not in v1. Recommendation: `retained` and proposed removals visible to the Owner; revisit after M7 |
| O8 | Without a Lazurio Account? | Recommendation: keep an unmanaged mode (Folder catalog, explicit add and sync), as F11 promises self-hosters |
| O9 | Who sees "další modul organizace"? | Recommendation: only declared non-restricted slots, only for members of that Organization or its own Teams, only where the Owner turned it on |
| O10 | Does the Launchpad report back? | Recommendation: yes: applied digest and a state code per entry, nothing else |
| O11 | Polling or push? | Recommendation: polling with `ETag` (300 s and on demand) in v1; push over an RPC stream later |
| O12 | Where does a Work Environment's GitHub binding live? | Recommendation: the infra roster (`owner.assignment`), edited from the Dashboard by a pull request to infra (F16), served live by the Dashboard; revisit with the Lazurio Account design (4.1), where the Environment is linked to its operator |
| O13 | Contract technology? | Recommendation: Effect Schema + `HttpApi` under the guardrails of 7.2, gated by a spike: the compiled Launchpad grows by less than 5 MB and its cold start by less than 50 ms; otherwise JSON Schema + ajv behind the same OpenAPI |
| O14 | Where does the contract package live? | **Decided:** in this repository; the Dashboard takes its types from it and depends on it; one package shared with the Environment list of DEV-6639. Recommendation: `packages/contracts`, consumed as an attested release artifact with an exact pin in the Dashboard |
| O15 | With whose authority does the Dashboard write a grant (M6)? | Recommendation: the approving Owner's GitHub user authorization at the moment of approval, not stored; not an App installation with administration write |
| O16 | The broker's repository allowlist? | **Decided:** drop it in favour of the live Team grant the broker already checks; a second list is a second ACL |
| O17 | Manifest `teams` declarations? | **Decided:** legacy, removed after the rollout. Recommendation: together with the CLI's Teams column, by an agent-led refactor (root 0173) after M7 |
| O18 | Production Space repositories in the composition? | **Decided (reversed):** in v1, with the same access rule, materialized into `productionspace/<repository>` as declared, shown read-only, never run or released. Recommendation: no access requests for them in v1 |
| O19 | How is the persona of an Automated Environment bound? | Recommendation: by proof of control at registration (the operator signs in to GitHub as the persona), cross-checked against the infra roster once it declares the persona (4.2) |
| O20 | How does "the operator owns Environments" meet the Organization as Owner of a work VM and a Team Environment without one operator? | Part of the Lazurio Account design (4.1); pending |

## 16. Not decided here

The Lazurio Account itself (section 4.1, pending research), the shape of the
Environment list and where the sign-in sits in the shell (plan DEV-6639), the visual
design of the flat workspace (step 1), the Machine Assignment API of F16
(preset and profile served by the Dashboard; a sibling resource of the composition on
the same registration), repository databases following published data (issue #118, a
different freshness problem inside a checkout), the escalation map of the Folder
(issue #117, which the Dashboard can serve on the same registration later), the
Organization-owned workstation preset (F16) and every Dashboard-internal design, which
the Dashboard's own shaping document records.
