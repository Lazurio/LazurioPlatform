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
minutes, and `lazurio machine t3-links` looks once, under the same lock.

| | Personal Environment (source) | Work Environment (target) |
|---|---|---|
| Edge, as its handover shows it | an assigned peer (`access: "assigned"`, its Environment id, account and host key) | an inbound SSH peer that is a personal Machine |
| `linkedEnvironmentsEnabled` in `~/.t3/userdata/settings.json` | on while it has an edge | on while it has an edge |
| Pairing | asks the target over `ssh <Environment id>` for a code (`t3 auth pairing create --ttl 2m`), links to `https://t3code.<Environment id>.lazurio.io` with `full-access` under its running Chat's label | issues the code it is asked for |
| Renewal | the same steps once fewer than seven days are left of the 30-day token, or when T3 Code reports the link expired or failing; then revokes on the target the sessions of its earlier links | nothing of its own |
| Failure | waits 15 minutes before the next attempt; an unspent code is revoked on the target | — |
| Edge removed | forgets the link (`t3 environment unlink`) | turns the switch off and revokes every session of a linked T3 Code (`T3 Code · <label>`, subject `mcp-client`) |
| Switch off | with the last link, only where Lazurio turned it on | with the last edge, only where Lazurio turned it on |

The target ends its own sessions because the source loses its SSH route
together with the edge. Turning the target's switch off already makes T3 Code
refuse linked clients; the revocation removes the sessions too.

## Secrets

The pairing code travels from the target's standard output, over SSH, into
the Platform's memory and onto the command line of the one
`t3 environment link` that spends it. That run takes seconds, the code lives
two minutes and is single-use, and it is revoked on the target when the run
fails. T3 Code's CLI takes the code only as a flag; a way that avoids the
command line would need a change to T3 Code. The code and the link's token
never reach a file, a log, the state or a report. Every value that reaches the
target's shell is checked as one token first.

The state, `~/.local/state/lazurio/t3-links.json` (0600), records which links
Lazurio made and until when, the inbound peers it last saw, whether Lazurio
turned the switch on and when an attempt last failed. A state that cannot be
read is replaced; the report says so (`stateRecovered`).

## The Chat's settings

T3 Code keeps its settings and watches `settings.json`; before each write of
its own it reads the file again. The Platform writes one member,
`linkedEnvironmentsEnabled`, replacing the file atomically and only while it
still holds what was read, as it does for Buddy's settings
(`src/buddy/chat.ts`). Every other member stays as T3 Code wrote it. A file
with comments, one T3 Code could not decode, a link or another kind of file is
left alone. Elsewhere the Chat's settings are written only through T3 Code
(decision F51); a command of T3 Code's own for this switch would replace the
file write and needs a change to the fork.

Buddy GEN3's own T3 Code (`~/.t3-buddy`) is not linked: its guard keeps linked
environments off, and Buddy GEN4 is a thread of the Chat's T3 Code.

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
- a state for a link that waits for confirmation, so the look reports
  `waiting-for-confirmation` instead of pairing.

Renewal needs no confirmation.

## What agents are told

The generated `AGENTS.md` of a Personal Environment lists its assigned Work
Environments in „Z tohoto Osobního Prostředí“ (template revision
`base-instructions-139`); with the links it also says how to find and use
them through T3 Code's tools (`t3_environment_links`, `environmentId` with the
target's `threadId`, `delegate_task` with `target.environmentId` and
`target.projectId`) and that only Lazurio pairs, renews and ends them, so an
agent never asks for a pairing code or runs `t3 environment` or `t3 auth`.
Buddy GEN4's own instructions in `~/Buddy` are not generated yet; when they
are, the same two points belong there. Buddy GEN3's skills are not changed:
its T3 Code is not linked.

## Not covered here

- The gateway's paths (Machines) and T3 Code's guard against incoming links in
  a Personal Environment (fork) are separate changes.
- A live trial needs the edge recorded and applied in the Organization's
  Deployment Repo and the gateway released.
