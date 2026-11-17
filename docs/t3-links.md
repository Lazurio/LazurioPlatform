# Links between T3 Code servers

Status: implemented in `src/t3-links/`, not yet released or tried live. It
carries out root decision 0157 as amended on 2026-11-17, with 0246, 0247 and
0091 (see `docs/decision-register.md`).

## What the Platform does

A person's Personal Environment may link the T3 Code of its Chat to the T3
Code of each Work Environment assigned to that person, so its threads, Buddy
among them, work there with T3 Code's standard tools. The Organization records
the edge in its Deployment Repo and its Owner confirms it; the same record
gives the SSH route and lets the Work Environment's gateway pass the four
paths of the link (`POST /mcp`, `POST /oauth/mcp/register`, `/decision`,
`/token`) only from the Personal Environment's tailnet address. Lazurio never
creates or removes an edge. Inside one, it pairs, renews and ends the link
itself, and T3 Code is not changed.

Each end acts only on its own handover. The Launchpad looks every five
minutes, where it sets Executor up; `lazurio machine t3-links` looks once.
Both take the same lock.

| | Personal Environment (source) | Work Environment (target) |
|---|---|---|
| Edge, as its handover shows it | an assigned peer (`access: "assigned"`, its Environment id, account and host key) | an inbound SSH peer that is a personal Machine |
| `linkedEnvironmentsEnabled` | on while it has an edge, through its running server | on while it has an edge, through its running server |
| Pairing | asks the target over `ssh <Environment id>` for a code (`lazurio machine t3-link-pair --source <its node> --label <its Chat's label>`) and links to `https://t3code.<Environment id>.lazurio.io` with `full-access` through its server (`peerLinks.link`) | records the source and its label, turns its switch on, then issues a code that lives two minutes (`t3 auth pairing create`), only for a source its handover names |
| Renewal | the same steps once fewer than seven days are left of the 30-day token, or when T3 Code reports the link expired or failing; then the target's sessions of its earlier links are revoked, once the new one is seen | — |
| Failure | the next attempt no sooner than 15 minutes later; an unspent code is revoked on the target | — |
| Edge removed | forgets its own link (`peerLinks.unlink` by its recorded peer id) | revokes exactly the sessions of that source's label (`T3 Code · <label>`, subject `mcp-client`) |
| Switch off | with the last link, only where Lazurio turned it on | with the last edge, only where Lazurio turned it on |

The target ends the sessions itself because the source loses its SSH route
together with the edge.

## T3 Code's own API

Every change of T3 Code goes through the running server, the one owner of its
settings (decision F51) and of its links: the Chat's RPC over `/ws` on
loopback, the one T3 Code's own clients use (`packages/contracts/src/rpc.ts`).
The switch is `server.updateSettings` with `{patch: {linkedEnvironmentsEnabled}}`,
the link `peerLinks.link`, `peerLinks.list` and `peerLinks.unlink`. The file
`settings.json` is only read. A look takes a session of T3 Code's own for
itself: `t3 auth session issue` with exactly `access:read`, `access:write` and
`settings:write` and a life of two minutes prints the token on its standard
output; it goes into the `Authorization` header of the WebSocket upgrade and
the session is revoked when the look ends. No lasting secret is added. Without
a running server nothing changes: a look answers `server-down`.

## Secrets

The pairing code goes from the target's T3 Code to its Lazurio, over SSH to
the source's Lazurio and into the one `peerLinks.link` request on loopback. It
is on no command line of either end, and it never reaches a file, a log, the
state or a report; neither does the session's token. Every value that reaches
the target's shell is checked as one token first (the label travels as
base64url). The tests prove this on both ends with real processes.

## Ownership and recovery

What Lazurio owns is exact, and it is recorded before anything is opened:

- the source records each link by the peer id T3 Code returned; a link at the
  same address it did not make is the person's (`person-link`) and is never
  renewed or forgotten;
- the target records the inbound source and the label it pairs under before
  the code exists, and revokes only that label's sessions when that edge
  goes; other sources' links and the person's own stay;
- `enabledByLazurio` is written before Lazurio turns a switch on, and a
  pairing under way (`pending`) before the code is asked for; a link a cut-off
  look made is then still Lazurio's.

The state is `~/.local/state/lazurio/t3-links.json` (0600). A look cut off at
any point leaves a state the next look finishes or undoes. A state that is
there but cannot be read, or that is missing while something may be open (the
switch on, or on the target a session of a linked T3 Code), fails closed: the
switch goes off through the server and, on the target, every session of a
linked T3 Code is revoked; only then is a new state written (`closed`), and
the next looks build again from the handovers. A source keeps its links when
it closes, since the target is where access is granted. Closing needs the
running server; until it answers nothing is replaced (`close-failed`). A
target with a damaged state issues no code.

## The first link and its confirmation

Decision 0157 wants the person to confirm the first link into each Work
Environment once, with a button in Lazurio, and allows pairing inside an edge
the Owner confirmed without it until that confirmation is built with the
rework of Lazurio Auth. This implementation pairs automatically. The button
would sit in the Launchpad of the Personal Environment, beside the assigned
Work Environment, and needs:

- a record of the confirmation per Work Environment that the source's look
  reads before its first pairing, issued and revocable in one place (Lazurio
  Auth after its rework);
- the Launchpad page and its route, behind the person's own sign-in;
- a state for a link that waits for confirmation, so the look reports it
  instead of pairing.

Renewal needs no confirmation.

## What agents are told

The generated `AGENTS.md` of a Personal Environment lists its assigned Work
Environments in „Z tohoto Osobního Prostředí“ (template revision
`base-instructions-139`). With the links it says how to find and use them
through T3 Code's tools (`t3_environment_links`, `environmentId` with the
target's `threadId`, `delegate_task` with `target.environmentId` and
`target.projectId`), that only Lazurio pairs, renews and ends them, how often
it tries and that a link that does not come within half an hour is reported to
the user, since a stopped T3 Code or an unreachable Environment keeps it away.
Buddy GEN4's own instructions are not generated yet; when they are, the same
points belong there. Buddy GEN3's own T3 Code (`~/.t3-buddy`) is not linked:
its guard keeps linked environments off.

## Known limits

- The source names itself to the target by its handover's
  `network.headscale_hostname`; the target accepts it only when its own
  handover names that node as an inbound personal peer.
- Two sources that link under the same label are one label to the target.
- A person who turned the switch on by hand before Lazurio's first look with
  an edge sees it closed once and then turned on as Lazurio's.

## Not covered here

- The gateway's paths (Machines) and T3 Code's guard against incoming links in
  a Personal Environment (fork) are separate changes, and both must be in
  place before links are relied on.
- A live trial needs the edge recorded and applied in the Organization's
  Deployment Repo, the gateway released and this change released to both
  Environments.
