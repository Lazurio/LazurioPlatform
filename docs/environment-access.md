# Lazurio account entry and delegated access — approved target

Status: accepted direction of the Operator, 2026-10-06, root decision 0192;
[public shared contract](https://github.com/HumanAndMachines/Lazurio/blob/main/manual/environment-access-model.md).
This document refines F11/F16/F33/F37 for organizational entry. It does not
claim that the current gateway, handover, shell or onboarding implements it.
Existing qualified local/self-hosted operation remains supported; this
contract does not introduce a mandatory hosted account into loopback use.

## Accepted trust-based full sharing — Operator clarification, 2026-10-06

Full sharing of an assigned individual work Environment is an intentional
transfer of **all capabilities available inside** to a trusted person:
files, processes, agents, browser sessions, passwords/passkeys, personal
working logins, integrations and existing remote access. The sharing user
accepts this risk. Do not require sign-out, profile wiping, credential
replacement, conversion to a Team/broker mode or another Admin approval as
a prerequisite. Active same-Organization membership and Admin approval of
the recipient's exact device remain mandatory; friends or family are not
exceptions. Personalspace is outside this work-sharing feature.

Explain this scope at the normal sharing action, with a clearly labelled
full-access choice and a separate app-only choice; do not add an approval
workflow or a new user role. For collaboration without this personal trust,
use a separate Team Environment. A full grant does not add an Admin role
to the recipient's Lazurio account, but a privileged identity already
signed in inside the runtime can technically be used. The product must
not claim per-person isolation or exclusive human attribution for that
identity. Named human responsibility and instructions for publication
remain a process obligation inside this trusted shared runtime.

Full sharing includes existing A-to-B capabilities. Do not require a new
direct per-person grant to B merely to share A, or disconnect its accounts
first. The UI/map discloses effective reach; creating a new link still
checks the actor's link-management authority. Sharing creates no new
network edge, Organization membership or direct B grant. An existing
integration credential can have broader reach than the entry grant; that
is part of the explicitly accepted trust, not an isolation guarantee.

Revoking the share must stop subsequent entry and handle supported active
sessions within a measured bound. It cannot erase data already copied or
automatically invalidate credentials copied from external providers.
Credential rotation and review of persistent changes are separate recovery
operations when trust is lost, not automatic prerequisites for sharing.
Tests must not assert isolation of retained personal identities; they
must cover sharing without forced sign-out, honest scope communication,
entry revocation and the separate app-only boundary. This decision changes
no live grants or credentials.

## Identity, network and entry are distinct

An organizational Environment and its apps require all three:

1. Tailscale against the correct Headscale, with Admin approval of the exact
   device before protected reachability. OIDC or another approved device is
   not that approval. There is no public alternative to protected work URLs.
2. Active Lazurio Organization membership, identified by immutable issuer
   and subject, not email, a GitHub login or the current tailnet user name.
3. An exact full-Environment or named-app grant in the account authority.

**Device approval.** An approval binds one concrete device, its owner's
account and one target Organization. On a tailnet that serves several
Organizations, each Organization's Admin approves entry into that
Organization; an approval for one Organization never opens another, and one
device may carry approvals for several Organizations. Until the record moves
to Auth, a single writer holds approvals: the network intent in the host
owner's Deployment Repository, created as a reviewed change from live state
and enforced by Machines (Plan, Permit, readback). The Dashboard never
rewrites it by writing to Headscale directly. Moving the record to Auth is a
separate migration with no period of two writers.

Auth owns membership, assignments and grants. Dashboard manages that
canonical authority; Machines/infra own technical deployment and derived
network/gateway enforcement. Platform consumes the qualified entry contract,
never trusts arbitrary forwarded identity headers and never stores a second
editable ACL. The supported provider mechanism and revocation behavior must
be qualified before activation. Public account/enrollment endpoints do not
expose work resources.

GitHub is optional for a human visitor to an individual or team Environment.
It remains the authority for repository operations and publication. The
Team scopes the Environment's repository capability through the existing
Organization broker, not the personal identity of every visitor. A GitHub
link alone grants no repository right.

An Admin manages who may enter a Team Environment. Until Auth grants replace
it, membership of the Environment's GitHub Team decides entry as the marked
migration implementation.

## Sharing and remote operations

An Admin manages membership, initial assignments, device admission and
cross-user links within their scope. An assignee may share their work
Environment or selected apps with existing active members of the same
Organization without another Admin click. This cannot invite outsiders,
approve devices, create membership or assign someone else's Environment.
A user may link two Environments assigned to them in that Organization;
a matching assignee across Organizations is not a cross-Organization grant.

Both full and application shares are bound to the originating assignment:
they end when that assignment is lost or reassigned, when the sharer or the
recipient loses membership, or when the target is rebound, and a later
restoration does not revive them. An application share grants at most basic
`user` entry.

Full entry exposes Chat, automation, Launchpad and the runtime's available
files, credentials and integrations. It is not per-visitor runtime isolation
and does not by itself delegate grant administration. App-only entry must
not expose other apps, Chat, automation, shell or Environment credentials,
including API, WebSocket, download and direct-origin routes. Personalspace
remains private and is not shared through this work-Environment feature.

Application access never includes the Environment's browser or desktop
(`browser.`, `desktop.`) or any other path that controls the whole
Environment. The shared gateway cookie of root decision 0191 (point 8b) is
not an application grant; the gateway checks every target separately. Point
10 of decision 0191 (wipe the browser profile before a work Environment is
reassigned to another person) still applies; 0192 only removes forced
sign-out for ordinary sharing.

An A → B link includes a destination account, allowed remote operations and
credentials, not just network ports. All full operators of A can use that
capability. Sharing and link changes must evaluate and show indirect access;
removing B's web grant does not revoke an A → B SSH path. Agents are processes
using Environment capabilities, not additional privileged identities. Audit
binds the human account, source Environment, destination and working identity.

A team Environment may prepare changes/PRs and an authorized preview for a
visitor without GitHub. A named authorized human approves and publishes.
Before admitting this cohort, broker/provider protections must deny the
Environment's own approval, merge and direct protected-branch writes. A
hidden UI action or process-only promise is not proof of this boundary.

## Platform consumer qualification

- The shell lists only granted Environments/apps for the Lazurio subject,
  including one using a supported sign-in method without GitHub. It does
  not request the visitor's read access to the whole infra repository.
- An app-only session cannot obtain Chat/Automate/browser pairing, open
  unrelated Documents, call an app-start/internal endpoint to widen access,
  or reuse another app's session/audience. Current whole-Environment
  admission tests alone do not prove this.
- Approved and unapproved devices with otherwise identical membership are
  tested against actual protected URLs. Device approval is a network
  prerequisite, never implemented by hiding the entry button.
- Revoking device, membership or grant covers cached admission, refresh,
  existing WebSockets and remote connections with a measured convergence
  bound. Reassignment must not transfer prior working credentials/sessions.
- Onboarding separates account login, pending Admin device approval and
  optional working integrations. A GitHub requirement belongs to the exact
  GitHub operation; absence of GitHub is not a universal first-run blocker.
- Existing Machine binding/entry, immutable origins, unknown-host denial,
  CSRF/session revalidation and provider-operation rights remain separate
  contracts. Assignment migration from static infra has one writer and
  explicit rollback/denial behavior, never concurrent writable authorities.

The existing tests and evidence describe their pinned baseline only. New
consumer tests, a browser journey, native network enforcement and controlled
migration are prerequisites of declaring this target delivered. This
source/documentation change does not authorize any live migration.
