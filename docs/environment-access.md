# Lazurio account entry and delegated access — approved target

Status: decision 0192 of the [decision register](decision-register.md), in force as
the target model; the transition is not complete. Its amendments of 2026-10-26 and
2026-11-01, decision 0202 and the access edges of decision 0224 are decided, not yet
deployed; decision 0213 is decided and partly deployed; decision 0196 is in force;
decision 0231 (application roles and what a Module receives) and decision 0234 (the
names of access roles) are decided, not yet deployed.
This document is the public model of access to an Environment. The Lazurio Root's
`manual/environment-access-model.md` stays as the GEN3 record and is no authority
for this repository. This document refines F11/F16/F33/F37 and
[F40](decisions.md#f40--lazurio-account-entry-approved-devices-and-internal-environment-sharing)
for organizational entry. It does not claim that the current gateway, handover,
shell or onboarding implements it, except where it names the source file that does.
Existing qualified local/self-hosted operation remains supported; this contract does
not introduce a mandatory hosted account into loopback use.

## Accepted trust-based full sharing — Matěj's clarification, 2026-10-06

Full sharing of an assigned individual work Environment is an intentional
transfer of **all capabilities available inside** to a trusted user:
files, processes, agents, browser sessions, passwords/passkeys, personal
working logins, integrations and existing remote access. The sharing user
accepts this risk. Do not require sign-out, profile wiping, credential
replacement, conversion to a Team/broker mode or another approval of the Organization Admin as
a prerequisite. Active same-Organization membership and the Organization Admin's approval of
the recipient's exact device remain mandatory, except in an Organization in
public-DNS mode, which has no device approval (decision 0213, below); friends
or family are not exceptions. Personalspace is outside this work-sharing
feature.

Explain this scope at the normal sharing action, with a clearly labelled
full-access choice and a separate app-only choice; do not add an approval
workflow or a new user role. For collaboration without this personal trust,
use a separate Team Environment. A full grant does not add the Organization Admin role
to the recipient's Lazurio account, but a privileged identity already
signed in inside the runtime can technically be used. The product must
not claim per-user isolation or exclusive attribution to one user for that
identity. The responsibility of a named user and the instructions for
publication remain a process obligation inside this trusted shared runtime.

**Environment holding several Organizations.** When an individual work
Environment holds repositories, data or sign-ins of several Organizations,
its Assigned User may share it fully only with a user who is an active member
of each of them (Matěj's decision of 2026-10-06). Sharing checks the
Organizations connected to the Environment; that a personal sign-in such as
GitHub can reach further Organizations is explained in the sharing text and
is the sharer's responsibility. Otherwise only selected applications or a
Team Environment remain. The target is a GitHub sign-in inside a work
Environment that reaches only that Environment's Organizations, through an
OAuth sign-in without personal access tokens; its mechanism is still to be
qualified.

Full sharing includes existing A-to-B capabilities. Do not require a new
direct per-user grant to B merely to share A, or disconnect its accounts
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

1. Tailscale against the correct Headscale, with the Organization Admin's approval of the exact
   device before protected reachability. OIDC or another approved device is
   not that approval. There is no public alternative to protected work URLs,
   except the public-DNS mode an Organization may choose (decision 0213,
   below), which drops this condition.
2. Active Lazurio Organization membership, identified by immutable issuer
   and subject, not email, a GitHub login or the current tailnet user name.
3. An exact full-Environment or named-app grant in the account authority.

**Device approval.** An approval binds one concrete device, its owner's
account and one target Organization. On a tailnet that serves several
Organizations, the Organization Admin of each Organization approves entry into that
Organization; an approval for one Organization never opens another, and one
device may carry approvals for several Organizations. Decided, not yet
deployed (0192's amendment of 2026-11-01, with 0183 and 0205): the Organization Admin
approves or removes a device in the Dashboard through a service on the
Conglomerate Host, which applies it within tens of seconds; a person may
remove their own lost device at once, and only an Organization Admin approves. Every action
is audited, and the service records each approval into the host owner's
Deployment Repository automatically as an audit entry without review, a record
and not an input. The rules (who may approve, and where an approved device
reaches) stay in that repository and change only by a reviewed pull request.
Until the service runs, an approval is a reviewed change in the host owner's
Deployment Repository, enforced by Machines (Plan, Permit, readback). The
Dashboard never rewrites approvals by writing to Headscale directly. Moving the
record to Auth is a separate migration with no period of two writers.

**Reach derived from one truth.** Reach between people, devices and
Environments derives from assignments, approved devices and live Organization Admin roles
(0192 with its amendment of 2026-10-07; the amendments of 2026-10-26 and
2026-11-01 are decided, not yet deployed).

- An approved computer reaches its person's Environments on HTTPS (443) and SSH
  (22); a phone reaches them on HTTPS only. SSH from an approved device into a
  Work Environment assigned to the same person appears with the device approval
  and follows changes of the assignment, the device and the membership without
  another request.
- A Personal Environment, which is not a device, always reaches the Work
  Environments assigned to its owner in the same tailnet over SSH, without a
  device approval.
- An Organization Admin's Work Environment is the Organization's administrative station
  (decision 0202).
- No edge runs in the opposite direction of another. Every access between
  Environments is listed in [Access edges in a Conglomerate](#access-edges-in-a-conglomerate-decision-0224-decided-not-yet-deployed)
  below.
- Every SSH edge between Environments needs both the network grant and the
  source Environment's own key, which the target accepts only from the
  source's address and for the assigned account; both appear and disappear
  with the facts they derive from. The source takes each target's host key
  from the records of the Organization that owns the target, never from the
  first connection; a changed host key stops the connection until those
  records confirm it; and no edge forwards the agent or ports, so no path
  leads back from a Work Environment into a Personal one.

The Platform's part is the source side of the edges
([decision F70](decisions.md#f70--a-source-environments-routes-come-from-its-home-access-service-its-own-key-registered-targets-pinned-and-with-their-deadline)).
Every source Environment has one key, `~/.ssh/lazurio-environment-ed25519`, created inside
it and never copied out. Where the handover declares the home Conglomerate Host's access
service, the Platform registers the key's public part there (`PUT /v1/source-key`) and
writes one `Host <environment id>` block per target the service answers
(`GET /v1/targets`) in `~/.ssh/config.d/lazurio-environments.conf`, with the host key
pinned (`StrictHostKeyChecking yes`), the one key (`IdentitiesOnly yes`), no agent or port
forwarding and no jump host, and drops a route when its `valid_until` passes; without an
answer it adds nothing. Without that member a personal Environment's routes are the Work
Environments the Machine binding lists as assigned, as before. The member is
`access_service: {origin}`, exactly `http://<host's tailnet name>:8444`, which Machines
writes from the home host only while that host switches the service on
(HumanAndMachine-ai/Machines#1040, [machine handover](machine-handover.md#the-home-access-service-decision-f70)). The network grants, the keys accepted on the
targets and the service itself belong to Machines and Headscale.

Auth owns membership, assignments and grants. Dashboard manages that
canonical authority; Machines/infra own technical deployment and derived
network/gateway enforcement. Platform consumes the qualified entry contract,
never trusts arbitrary forwarded identity headers and never stores a second
editable ACL. The Environment's own vault adds the user its gateway admits
as a Správce, named by the gateway's own answer to the admission and never by
a header of the request, at the address of the Lazurio username that answer
carries, and keeps no list of them (decision F11's amendments and F53's
addendum of 2026-10-14, amended on 2026-10-16 by root decision 0203). A
personal Environment's vault is in its user's own Bitwarden instead (root
decision 0203 point 7): it invites only the user who connected it, at the
address of their own Bitwarden account, with the vault role User and Manage
on Agenti. The supported provider mechanism and revocation behavior must be
qualified before activation. Public account/enrollment endpoints do not
expose work resources.

GitHub is optional for a visitor to an individual or team Environment.
It remains the authority for repository operations and publication. The
Team scopes the Environment's repository capability through the existing
Organization broker, not the personal identity of every visitor. A GitHub
link alone grants no repository right.

An Organization Admin manages who may enter a Team Environment. Until Auth grants replace
it, membership of the Environment's GitHub Team decides entry as the marked
migration implementation.

## Public-DNS mode (decision 0213)

Decided, partly deployed. People enter an Organization's Environments through its
tailnet, which stays the default, or without a tailnet through public DNS. The
gateways and the server's public entry that carry this mode belong to Machines; this
repository has no code for it.

- **The switch.** The mode is one setting in the Organization's Deployment Repository,
  the server's public entry on each server concerned. The Organization Admin turns
  it on by a reviewed pull request that cites the Organization's own decision; it
  requires mandatory two-factor authentication in the GitHub Organization and a DNS
  zone delegated to the Organization. Admitting any Lazurio account stays reserved to
  the reference Organization's shared visitors' Environment (decision 0204).
- **Entry.** The server's entry reads only the server name from TLS without opening
  the connection, passes only declared Environment names to their gateways and closes
  any other name. A Lazurio account with active membership and a specific grant
  replaces the device approved by the Organization Admin: condition 1 above and device approval do not
  apply to people. From the internet only the entry into Environment gateways is
  reachable, and every path behind it needs a Lazurio session.
- **Revocation.** Every gateway refreshes the session at least every two minutes, so a
  removed member is refused any new request or connection within two minutes, and it
  ends every upgraded or long-open connection five minutes after it opened, so the
  member loses everything within seven minutes.
- **What people get.** Only the web interface (the Launchpad, chat, MausBot, Buddy):
  no SSH for people, no native T3 pairing exception, no desktop T3 Code and no vault
  from their devices. The Organization's vault stays reachable for people only inside
  the tailnet; people see their Environment's vault on its Vault page.
- **What stays.** The Environments stay server nodes of the Organization's tailnet,
  with the same enrollment, default grants and SSH between Environments; agents reach
  the vault over the tailnet, and the servers are managed through the Organization's
  own Conglomerate Host. The services Environment that carries the public entry stays
  outside the tailnet.
- **Accepted risks.** A stolen session works from anywhere until it is ended, the Organization Admin
  has no device list, and the gateways are visible on the internet. The tailnet stays
  the backbone of security; public DNS is an Organization's choice, not the standard.

## Module data: the Environment's ceiling (decision 0196)

In force. Lazurio controls entry to a Module's application (Application Admin,
Application User or no entry, [decision 0231](decision-register.md#0231--access-in-an-organization-owner-admin-and-members-module-access-and-maintainers-application-admins-and-users)) and passes it who came and with
which application role; what each person may do inside is the Organization's own
rules in its code and data.

- **The Environment reaches the data, not a person.** The Organization Admin gives
  the Environment its data access through the vault: that is the Environment's
  ceiling. The Launchpad hands a Module only the secrets it declares, by name, read from
  the Environment's own vault before every start and passed to the Module's own process
  only; a required secret that cannot be read keeps the Module from starting, and a
  capability only some Environments have is declared as `optional_secrets`
  (`src/modules/runtime-secrets.ts`;
  [F46](decisions.md#f46--runtime-secrets-declared-names-read-from-the-environment-vault-before-every-start-fail-closed)).
  The Modules of all Organizations on one Environment run under its single account as
  one trust domain.
- **Whole Environment, whole ceiling.** Whoever has the whole Environment has root in it
  and works with the whole ceiling.
- **An app, a narrowed part.** Whoever has only an app sees the part of the ceiling the
  Organization's rules allow. The Module's server narrows it on every request,
  including APIs, downloads, WebSockets and direct URLs, and never gives more than the
  ceiling.
- **Narrowing is a service of the operator, not isolation against them.** The person
  who operates the Environment has root, can change the Module's server and could show
  a visitor the whole ceiling. Where narrowing must hold against the operator, the data
  is served by an app the Organization runs or by a store that verifies the identity
  itself.
- **The identity is not a key.** Inside the Environment the statement comes from the
  Environment's gateway and holds as far as the Environment does (0231). An identity
  for use outside the Environment is signed by Lazurio Auth, never by the Environment;
  it is short-lived and valid for one exact Environment and app. A shared app carries no
  rights to the visitor's data, so a Module with restricted rights always has a server
  part, and the browser never gets access to its store. Whoever is to see data with
  their own rights opens the Module in their own Environment or in an app the
  Organization runs.
- **The store.** Whether a Module keeps its data in repository-db or in a database is
  its architect's choice under the Module Standard; a person with restricted rights
  sees only the changes of the repository-db draft to records they can access, and
  only someone who sees the whole draft may publish it.

## Applications and application roles (decision 0231): decided, not yet deployed

[Decision 0231](decision-register.md#0231--access-in-an-organization-owner-admin-and-members-module-access-and-maintainers-application-admins-and-users) names three levels of access and never lets admin or user
stand alone; [decision 0234](decision-register.md#0234--the-names-of-access-roles-one-vocabulary-for-every-text-screen-and-agent) gives each role its name and identifier.
The Organization has the Organization Owner, the Organization Admin and the
Organization Member; a Module has the Module Reader, the Module Contributor and the
Module Maintainer (module access is the name of the setting that holds a person's or
a Team's Module role, never a role); an application has the Application Admin and the
Application User (the module kit's `appRole` `admin` and `user`).

- **An application** is the running stable version of a Module, built from `main` of
  the primary checkout on an Environment (decision 0195). A worktree's development
  server is not one.
- **Roles hold across Environments.** An application role holds for the Module on
  every Environment of the Organization. Application Admins without any setting are
  the Module Contributors, the Module Maintainers, the Organization Admin and whoever
  has the whole Environment where the application runs; the Module Reader role by
  itself gives no application role. Module Contributors, Module Maintainers and the
  Organization Admin give the role of Application Admin or Application User to people,
  a Team or the whole Organization; the higher role holds, and the Organization Admin
  may remove any.
- **Availability.** The person on whose Environment the application runs makes it
  available to the Organization. People with an active membership of the Organization
  and a role see it in Apps of their
  Launchpad, or on their Lazurio account without an Environment, and the gateway
  admits them to that application only (see app-only entry below). A Work
  Environment is the first home; the target is an application the Organization runs
  at its own address behind its own gateway (decision 0146).
- **What a Module receives.** Only the module kit's answer is the contract, with
  the same five fields in every case: the kind of entry (`environment`, `app`,
  `local`, `unknown`), the application role (`admin` for the Application Admin, `user` for the
  Application User, none with `unknown`), the person (Lazurio subject and username, or none), the source of
  the statement (`gateway`, later `auth`; none without a person) and, without a
  person, the reason. The gateway sets it from its own
  admission answer after removing every client copy; a missing statement grants no
  role, and a request from inside the Environment is an Application Admin without a
  name. Its fields and values never change meaning; new information comes as new
  fields.
- **Meaning.** What the two roles allow is the Organization's rule in the Module's
  code, enforced on the server for every request. Finer roles live in the Module's
  own data, keyed by the subject.
- **Not yet.** An agent of a colleague cannot enter an application made available
  from another Environment, because the Environment's browser never holds a Lazurio
  session.

## Sharing and remote operations

An Organization Admin manages membership, initial assignments, device admission and
cross-user links within their scope. An Assigned User may share their work
Environment or selected apps with people who have an active membership of the same
Organization without another click of the Organization Admin. This cannot invite outsiders,
approve devices, create membership or assign someone else's Environment.
A user may link two Environments assigned to them in that Organization;
a matching Assigned User across Organizations is not a cross-Organization grant.

Both full and application shares are bound to the originating assignment:
they end when that assignment is lost or reassigned, when the sharer or the
recipient loses membership, or when the target is rebound, and a later
restoration does not revive them. An application made available from an
Environment admits people by their application role, Application Admin or
Application User ([Applications and application roles](#applications-and-application-roles-decision-0231-decided-not-yet-deployed)),
not by a per-person grant of at most basic `user` entry.

Full entry exposes Chat, automation, Launchpad and the runtime's available
files, credentials and integrations. It is not per-visitor runtime isolation
and does not by itself delegate grant administration. App-only entry must
not expose other apps, Chat, automation, shell or Environment credentials,
including API, WebSocket, download and direct-origin routes. Personalspace
remains private and is not shared through this work-Environment feature.

Application access never includes the Environment's browser or desktop
(`browser.`, `desktop.`) or any other path that controls the whole
Environment ([The Environment browser](environment-browser.md)). The gateway's
shared session cookie is not an application grant; the gateway checks every
target separately ([F40](decisions.md#f40--lazurio-account-entry-approved-devices-and-internal-environment-sharing)
point 3). A Work Environment is never handed to
another person: after an export period it is removed (decision 0191), so its
browser profile and sign-ins never pass to someone else; 0192 only removes
forced sign-out for ordinary sharing.

An A → B link includes a destination account, allowed remote operations and
credentials, not just network ports. All full users of A can use that
capability. Sharing and link changes must evaluate and show indirect access;
removing B's web grant does not revoke an A → B SSH path. Agents are processes
using Environment capabilities, not additional privileged identities. Audit
binds the user's account, source Environment, destination and working identity.

A team Environment may prepare changes/PRs and an authorized preview for a
visitor without GitHub. A named authorized user approves and publishes.
Before admitting this cohort, broker/provider protections must deny the
Environment's own approval, merge and direct protected-branch writes. A
hidden UI action or process-only promise is not proof of this boundary.

## Access edges in a Conglomerate (decision 0224): decided, not yet deployed

A Conglomerate is one tailnet of befriended Organizations; each Organization has its
own server with only its own Environments, and a Personal Environment is a node of
exactly one Conglomerate. The table lists every access between people, devices and
Environments. Access runs one way only, and an edge that is not in it does not exist
by default.

| Access | From → to | Derived from | How |
| --- | --- | --- | --- |
| Work access | A Personal Environment → the Work Environments assigned to its owner in every Organization of its Conglomerate | The assignment and live membership | Automatically, SSH, this direction only |
| Team Environments through a Work Environment | A person's Work Environment → the Team Environments of that person's Teams in the same Organization | Team membership | Automatically, SSH with the Work Environment's key. From the Personal Environment in two `ssh` steps through the person's own Work Environment, never directly and without forwarding its key |
| Administration (decision 0202) | An Organization Admin's Work Environment → every other Environment of the Organization: Organization Members' Work and Team Environments, other Organization Admins' Work Environments, Henry and the server services | The live Organization Admin role | Automatically, SSH with the station's one key. From the Organization Admin's Personal Environment in two steps through that Work Environment |
| From a device | A person's approved device → that person's Environments | The Organization Admin's approval of the device (0192) | Automatically after the approval: 443 and 22, a phone 443 |
| To a device | An Environment → one specific computer (decision 0240) | The consent of the device's owner: a person for their own computer, the Organization Admin for the Organization's computer, choosing which Environments may reach it | Optional, per device, revocable. A Device of the Organization: SSH from the Environment. A personal Device: never SSH into it; only over the channel the Device itself opened into the Environment, while its owner has it switched on, ending at once when switched off |
| Exceptions | Anything else | A reviewed pull request to the Deployment Repository with its reason and owner | Exceptionally |

- **No reverse edges.** No edge exists as the reverse of another: neither Work →
  Personal nor Team → Work, and the target of administration does not reach the
  Organization Admin's Environments by it. Two Organization Admins of one Organization reach each other's Work
  Environments, each from their own role. The source Environment's key is never
  forwarded: the step from a Work Environment into a Team Environment is a second
  `ssh` run in the Work Environment with its own key.
- **Who grants it.** The Organization Admin, through their decisions: assigning an
  Environment, putting a person into a Team, approving a device; the Organization
  Owner, by naming an Organization Admin. A device's owner switches on access to that device. No separate SSH grant is created.
- **How it is applied.** The service on the Conglomerate Host that approves devices
  derives the edges from these facts: it delivers the source Environment's key to the
  target account, accepted only from the source's address and never forwarded, and
  gives the source its targets with host keys pinned from the Organization's records,
  never trusted on first use; no edge forwards the agent or ports. After a fact is
  removed, new connections fail within five minutes, while sessions already running
  may finish; nothing supervises running sessions. The use of a personal Device is the
  exception (0240): switched off by its owner, the Device closes its channel at once and
  the agent's use ends with it. Git holds only the exceptions no rule derives.
- **Agents** use only the routes Lazurio gives an Environment and say so when a route
  is missing.
- **Data in the personal context.** In a person's personal context the data of the
  Organizations they belong to may meet, so Buddy may compose results from them for
  that person. In an Organization's context data never mix, and nothing moves from a
  Personal Environment into another Organization.
- **Without a tailnet.** A Personal Environment in public-DNS mode (decision 0207) has
  none of these routes.
- **Replaced.** 0224 replaces decision 0158 and point 3 of decision 0182: an Environment
  reaches a person's device only by the access to a device above, which 0240 narrows
  for a personal Device to the channel the Device itself opened.

## SSH from a user's devices

A user registers their own computer's SSH key for an Environment in that
Environment's Launchpad Settings → SSH from your devices
([decision F49](decisions.md#f49--ssh-from-the-persons-devices-is-registered-in-launchpad-settings)).
The key goes into the Environment account's `authorized_keys` and nowhere
else; the host key reaches the computer over the signed-in page and is pinned.
This is entry to the account, not to the network: reaching the Environment on
TCP/22 from that device remains a separate grant the Organization Admin
approves and Headscale enforces, and the Launchpad neither checks nor opens
it. Under 0192's amendment of 2026-11-01 that grant comes with the approval of a
computer; a phone has none (decided, not yet deployed). Removing a web grant or
a device key does not remove the other. On a Team
Environment every admitted user acts as the Team's account and may add or
remove device keys; whether that needs a narrower rule is open.

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
- Onboarding separates account login, pending device approval by the Organization Admin and
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
