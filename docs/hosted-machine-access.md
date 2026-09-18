# Operator access to hosted Machines and the Conglomerate view

Status: proposal draft, 2026-09-17, written after the first live operator
onboarding into hosted workspace Machines. It proposes the target model; today's
implementation is named in "Open gates". Vocabulary follows `docs/decisions.md`
(F0): Machine, Lazurio Environment, Conglomerate, Owner, Principal.

## Problem

Connecting one operator to a hosted workspace Machine currently needs the
Organization Admin at four points: registering the operator's device in the
Conglomerate control plane (Headscale), a reviewed infrastructure change with a
one-time Permit for every device-to-Machine SSH grant, moving the operator's SSH
public key onto the Machine, and issuing a pairing token for the in-browser agent
workspace (T3 Code). Every step is safe; none scales to a team, and each needs a
rollout. Target: within what the Owner declared, the operator serves their own
access; the Admin performs only Owner-level decisions.

## Terms

- **Operator** — a person signed in with a Lazurio account (GitHub identity through
  Lazurio Sign-In). Rights derive from GitHub Organization and Team membership;
  GitHub remains the only access authority.
- **Machine** — a node of the Organization's private network (the Conglomerate
  control plane on the Conglomerate Host). Either a **hosted Machine** (a Team
  workspace VM, `<vm>.<org>.lazurio.io`) or a **personal Machine** of an operator
  (laptop, phone) used to reach hosted Machines.
- **Owner** — the Organization Admin; the only party who adds a Machine to the
  Conglomerate and declares which operator reaches which Machines.
- **Access declaration** — the record "operator ↔ hosted Machines ↔ level". Source
  of truth: GitHub Teams (who is an operator of a Team workspace) and the Dashboard
  (level and personal Machines). The Conglomerate **projects** it into the private
  network policy and the Machine gateway; no second ACL exists anywhere.

## Access levels to a hosted Machine

| Level | What the operator gets | Mechanism |
| --- | --- | --- |
| **Application user** | The Machine's applications (`<app>.<vm>.<org>`) except the agent workspace; no SSH, no module source | network grant TCP/443 to the Machine; the Machine gateway admits the users Team on every origin except the agent workspace origin |
| **Operator** | + agent workspace (agent, terminal, module source) | gateway admits the workspace Team on the agent workspace origin too; pairing is automatic (below) |
| **Operator with SSH** | + SSH from the operator's personal Machines (agent SSH remote, CLI) | network grant TCP/22 `operator → Machine` for that operator's nodes; the operator's public key in `~/.ssh/authorized_keys` of the Machine account (Machines tolerates and reports operator-added keys) |

A level binds an operator to a hosted Machine, not a device: every personal Machine
of the operator inherits the operator's levels. "Without SSH" is an ordinary
variant: the Owner grants someone the Machine's applications without agent
workspace or source access.

## Flows

### Adding a personal Machine (Owner-level, no pull request)

1. On the personal Machine: private-network client and Lazurio installed;
   Launchpad → "Sign in with your Lazurio account".
2. Launchpad → "Join the Organization's Conglomerate": the client logs in to the
   Organization's control plane through Lazurio Sign-In (OIDC). The node exists
   under the operator's own user, with no grants yet.
3. The Owner sees the new personal Machine in the Dashboard and approves it. The
   operator's access declaration already exists (Team membership), so the
   Conglomerate projects per-operator grants and the Machine immediately reaches
   what it may.
4. Removal: the Owner revokes the node or the Team membership; the projection
   withdraws the grants and gateway and agent-workspace sessions are revoked.

### SSH to a hosted Machine (without the Admin)

1. Launchpad (or the CLI) on the personal Machine generates a key pair and
   offers "Set up SSH to `<vm>`".
2. The public key travels over an authorized channel: a request through the
   Machine gateway where the operator is signed in (the Machine's Launchpad or
   a loopback broker appends it to `~/.ssh/authorized_keys`). Alternative: the
   Machine reads its operators' keys from GitHub (`github.com/<login>.keys`), the
   same authority without a channel.
3. Launchpad writes the SSH configuration, the known host keys (published by
   Machines from its readback) and the agent SSH remote. SSH works as soon as
   the TCP/22 grant is in the policy.

### Agent workspace without an Admin-issued token

- **Launchpad / CLI on the Machine:** the "Open agent workspace" tile issues a
  one-time credential with the operator's full scopes including access
  management and redirects to the pairing URL; the operator never sees a token.
  The CLI does the same, also over an SSH remote from a personal Machine.
- **Broker in the Machine gateway** for clients without Launchpad (a phone):
  after the GitHub sign-in on the agent workspace origin, the gateway pairs the
  browser itself. Same mechanism, no UI.
- The Dashboard is **not** a token channel: it is a public control plane outside
  the private network; a secret through a third system adds state to revoke.
  The Dashboard is the entry catalog and the place of declaration.

## Launchpad as the Machine's control plane, Dashboard as the Conglomerate view

Launchpad shows "which Machine I am, what I can reach and how": a diagram built
from the private-network policy (grants and levels) and `lazurio.machine.json`
(Machine identity). From there: open the agent workspace, set up SSH, the
Organization's modules, later assistants. The CLI exposes the same functions to
agents; both call the same local core (F0).

The Dashboard renders the **Conglomerate view** for the Owner: a graph of the
Organization's Machines, the operators assigned to each hosted Machine with
their level, and directed edges between Machines meaning "SSH is allowed from
this Machine to that one". The graph is a projection of the private-network
policy and each Machine's identity file, never a second truth: it draws exactly
what the control plane enforces, and an Owner-originated change (approve a
personal Machine, change a level) writes through to the natural owner (the
access declaration) and is applied by the Conglomerate projection, consistent
with F0.

## Ownership (where each part lives)

| Repository | Change |
| --- | --- |
| Machines | per-operator private-network grants derived from the declaration (instead of per-device grants), control-plane OIDC through Lazurio Sign-In with node approval, per-application admission in the gateway (agent workspace only for operators), pairing broker in the gateway, publication of Machine host keys, operator keys in `authorized_keys` (receiving channel or GitHub keys) |
| Dashboard | personal Machines per operator, node approval by the Owner, access-level declaration, projection into the Conglomerate, the Conglomerate view |
| Platform (this repository) | sign-in with the Lazurio account, join the Conglomerate, set up SSH, open the agent workspace (pairing link), the Machine diagram; CLI and Launchpad through the same core |
| Agent workspace fork | scoped pairing credential issuance from the CLI |
| Platform profiles | a `workspace` profile for hosted Machines so the delivered root is a regular Lazurio Folder and the doctor knows the hosted context |

## Security invariants

- GitHub is the only authority: Teams say who is an operator; the Owner declares
  levels and approves Machines; nothing of that can be bypassed from a Machine.
- A Machine is a boundary: gateway and agent-workspace sessions are per Machine;
  an SSH grant is per operator but always to one Machine.
- No secret through a third system: pairing credentials and keys are created on
  the Machine or the personal Machine and travel only over the gateway or SSH.
- Adding a Machine to the Conglomerate is Owner-level; an operator can only use
  a grant, never create one.
- Auditability: the Machine readback reports operator-added keys, the Dashboard
  logs approvals and declarations, the agent workspace keeps its sessions.

## Open gates

1. Control-plane OIDC through Lazurio Sign-In: per-operator users instead of one
   Organization user; node approval (the control plane has no native pending
   state; model it as zero grants until the Owner approves in the Dashboard).
2. Per-application admission in the Machine gateway (agent workspace origin for
   the workspace Team only, other origins also for a users Team): the gateway
   catalog needs allowed groups per origin.
3. Deriving the policy from the declaration: where the declaration lives (GitHub
   Teams plus a Dashboard projection similar to the private DNS projection) and
   how the Conglomerate reconciles it.
4. Operator keys: a receiving endpoint behind the gateway versus reading GitHub
   keys; both yield `authorized_keys` without a rollout. Decide one.
5. Scoped pairing credentials from the CLI; the gateway broker for phones.
6. Machine host keys: publication from the readback into the Organization's
   infrastructure repository for `known_hosts`.
7. The `workspace` profile and the doctor on hosted Machines.
8. The hosted Machines must run the hostname-origin generation of Machines
   (application origins per app, operator-owned `authorized_keys`) before
   per-application admission is possible.
