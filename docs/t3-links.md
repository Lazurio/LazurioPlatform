# Links between T3 Code servers

Status: implemented in `src/t3-links/`, not yet released or tried live. It
carries out root decision 0157 as amended on 2026-11-17, with 0246, 0247 and
0091 (see `docs/decision-register.md`).

## What the Platform does

A person's Personal Environment may link the T3 Code of its Chat to the T3
Code of each Work Environment assigned to that person, so its threads, Buddy
among them, work there with T3 Code's standard tools. The Organization records
the edge in its Deployment Repo and its Owner confirms it; the same record
gives the SSH route and lets the Work Environment's gateway pass the five
paths of the link (`GET /.well-known/t3/environment`, `POST /mcp`,
`POST /oauth/mcp/register`, `/decision`, `/token`) only from the Personal
Environment's tailnet address. Lazurio never
creates or removes an edge. Inside one, it pairs, renews and ends the link
itself, and T3 Code is not changed.

Each end acts only on its own handover. The Launchpad looks every five
minutes, where it sets Executor up; `lazurio machine t3-links` looks once.
Both take the same lock.

| | Personal Environment (source) | Work Environment (target) |
|---|---|---|
| Edge, as its handover shows it | an assigned peer (`access: "assigned"`, its Environment id, account and host key) | an inbound SSH peer that is a personal Machine |
| `linkedEnvironmentsEnabled` | on while it has an edge, through its running server | on while it has an edge, through its running server |
| Pairing | asks the target over `ssh <Environment id>` for a code (`lazurio machine t3-link-pair --source <its node>`), links to `https://t3code.<Environment id>.lazurio.io` with `full-access` through its server (`peerLinks.link`) and asks the target to settle it (`lazurio machine t3-link-settle --source <its node>`) | issues one code at a time, only for a source its handover names: records the source, the time and the sessions of linked T3 Code that exist already, turns its switch on, then issues a code that lives two minutes (`t3 auth pairing create`); once the code is spent or gone, the new session is that source's, by id |
| Renewal | the same steps once fewer than seven days are left of the 30-day token, or when T3 Code reports the link expired or failing | settling the new code revokes the source's earlier sessions, by id |
| Failure | a refusal T3 Code answered: the next attempt no sooner than 15 minutes later, the unspent code revoked on the target; an outcome that is not certain (a lost answer, a timeout) holds the Environment until its code has certainly expired and is never taken as Lazurio's | a code nobody spent is let go once it has certainly expired |
| Edge removed | forgets only its own links (`peerLinks.unlink`), recognised by the peer id and `linkedAt` of T3 Code's answer to its own request | revokes a code still out, settles it, then revokes exactly the sessions that source owns |
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
the target's shell is checked as one token first. The tests prove this on
both ends with real processes.

## Ownership and recovery

What Lazurio owns it knows only by identifiers T3 Code gave and that it has
checked, never by a label, an address or a failure that may have hidden a
success; it is recorded before anything is opened:

- the source records each link by the peer id and the moment T3 Code linked
  it (`linkedAt`). T3 Code keeps one link per peer, so a link the person makes
  over Lazurio's has another moment and is the person's from then on; a link
  at the same address that Lazurio did not make is the person's
  (`person-link`) and is never renewed or forgotten;
- only T3 Code's own answer to Lazurio's `peerLinks.link` request proves a
  link Lazurio's. When that answer is lost or is a refusal, no link is ever
  taken as Lazurio's afterwards: T3 Code's list cannot tell the link of the
  attempt from one the person made after it. The pairing under way
  (`pending`, written before the code is asked for) only holds the
  Environment, so no second pairing runs over it, until its code has
  certainly expired (ten minutes), also when the edge went meanwhile. A link
  it may have made is then the person's; nothing stays open, because the
  target owns the session of Lazurio's code by its own record and revokes it
  when the edge goes;
- the target issues a code only while no other code is out, Lazurio's or one
  the person issued, and records, before the code exists, the source and the
  sessions of linked T3 Code that exist already. T3 Code does not record which
  code a session came from (`auth_sessions` has no pairing column and the
  session list shows none), so the target counts every new session of a
  linked T3 Code that nobody owns and that appears while the code is out
  (until it is spent, at most five minutes) as that source's, by id, across
  renewals and whatever label its Chat answers with. When an edge goes,
  exactly the sessions that source owns are revoked. Other sources' sessions
  stay, and so do the person's own, except one that appeared while
  Lazurio's code was out (see the limits below);
- `enabledByLazurio` is written before Lazurio turns a switch on.

The state is `~/.local/state/lazurio/t3-links.json` (0600). A look cut off at
any point leaves a state the next look finishes or undoes. A state that is
there but cannot be read, or that is missing while something may be open or
may still open (the switch on, or on the target a session of a linked T3 Code
or a code of Lazurio's still out), fails closed. On the target every code of
Lazurio's still out (Lazurio labels each `lazurio-link`) is revoked first, so
none can open a session nobody owns once the switch is on again; then the
switch goes off through the server and every session of a linked T3 Code is
revoked. Only then is a new state written (`closed`), and
the next looks build again from the handovers. A source keeps its links when
it closes, since the target is where access is granted. This holds with
or without an edge: a missing state is idle only once the switch is shown to
be off and, on the target, no linked session and no code of Lazurio's
exists; an empty state is then
written so later looks need not ask T3 Code again. A pairing request over a
missing state closes what may be open the same way before it records the
source and issues a code, and issues none when it cannot. Closing needs the
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
- An accepted limit, in the safe direction: every new session of a linked
  T3 Code that appears on the target while Lazurio's code for a source is out
  (until the code is spent, at most five minutes) is counted as that pairing's
  source's, whatever its label, and is revoked with that source's edge or at
  its next renewal. A person who links another T3 Code to this Work
  Environment in exactly that window may lose that session; nothing stays
  open. Lazurio waits while any other code is out, and without the gateway's
  sign-in only an edge's source can reach the link's four `POST` paths, which
  pair and use a link, so the window is short and narrow. (The description
  `GET /.well-known/t3/environment` is also reachable by native T3 clients
  under 0157's separate pairing exception; it issues no session.) Telling
  the sessions apart for certain would need T3 Code to record which code a
  session came from. The label is not used to narrow it: it can change, and a
  wrong filter would leave the session of Lazurio's code owned by nobody.
- After a lost answer, the link the attempt may have made is the person's, so
  Lazurio neither renews nor removes it; it works until it expires or the
  edge goes. To hand the Environment back to Lazurio, the person forgets that
  link in Settings → Connections of the Personal Environment's Chat, and the
  next look pairs again.
- A person who turned the switch on by hand before Lazurio's first look with
  an edge sees it closed once and then turned on as Lazurio's.

## Not covered here

- The gateway's paths (Machines) and T3 Code's guard against incoming links in
  a Personal Environment (fork) are separate changes, and both must be in
  place before links are relied on.
- A live trial needs the edge recorded and applied in the Organization's
  Deployment Repo, the gateway released and this change released to both
  Environments.
