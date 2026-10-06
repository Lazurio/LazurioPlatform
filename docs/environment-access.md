# Lazurio account entry and delegated access — approved target

Status: accepted direction of the Operator, 2026-10-06, root decision 0192;
[public shared contract](https://github.com/HumanAndMachines/Lazurio/pull/504).
This document refines F11/F16/F33/F37 for organizational entry. It does not
claim that the current gateway, handover, shell or onboarding implements it.
Existing qualified local/self-hosted operation remains supported; this
contract does not introduce a mandatory hosted account into loopback use.

## Identity, network and entry are distinct

An organizational Environment and its apps require all three:

1. Tailscale against the correct Headscale, with Admin approval of the exact
   device before protected reachability. OIDC or another approved device is
   not that approval. There is no public alternative to protected work URLs.
2. Active Lazurio Organization membership, identified by immutable issuer
   and subject, not email, a GitHub login or the current tailnet user name.
3. An exact full-Environment or named-app grant in the account authority.

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

## Sharing and remote operations

An Admin manages membership, initial assignments, device admission and
cross-user links within their scope. An assignee may share their work
Environment or selected apps with existing active members of the same
Organization without another Admin click. This cannot invite outsiders,
approve devices, create membership or assign someone else's Environment.
A user may link two Environments assigned to them in that Organization;
a matching assignee across Organizations is not a cross-Organization grant.

Full entry exposes Chat, automation, Launchpad and the runtime's available
files, credentials and integrations. It is not per-visitor runtime isolation
and does not by itself delegate grant administration. App-only entry must
not expose other apps, Chat, automation, shell or Environment credentials,
including API, WebSocket, download and direct-origin routes. Personalspace
remains private and is not shared through this work-Environment feature.

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
