# Usage producer for Organization usage analytics (proposed)

Status: **proposal with a tested core, not wired into the CLI, the Launchpad or
any timer. Nothing runs, reads or sends until the decisions below are taken.**
Issue: #951.

## Purpose

The Dashboard's proposed usage view for an Organization ("Využívání") shows
who works in Lazurio, on what, with which outcomes and costs, from events its
Environments deliver (`lazurio.usage-event.v1`, `POST
/api/environment/v1/usage/events`, authenticated by the Environment's own
token like the settings report). This module is the Environment's side.

## What it reads

`src/usage/t3-source.ts` opens T3 Code's state read-only and selects named
columns and named JSON keys only:

| T3 Code record | Event |
| --- | --- |
| run (`requested_at`, `status`, `completed_at`, model) | `task.started`, `task.completed` / `task.failed` / `task.cancelled` |
| subagent | the same, with the run as `parent_task_id` |
| provider turn (`turnTokenUsage.inputTokens`, `outputTokens`) | `model.usage` with the run's model; no cost, because T3 Code records none |
| run in a scheduled task's thread | `origin: automation`; a turn takes its own run's origin and model, however long ago the run started |

Never read: thread titles, messages, prompts, scheduled task titles or prompts,
paths, branches, pull requests. The model name is untrusted text, so it is only
ever mapped to a fixed value (`safeModel`): a listed published identifier, the
family of any other name of a known family (`gpt`, `claude`, …; a newer model
shows as its family until it is added to the list in a reviewed change),
`other` for anything else (a URL, a path, a provider prefix) and `unknown`
when there is none. Ids leave the Environment only as digests
(`usageId`): a stable version 8 UUID per occurrence, so a redelivery is a
no-op at the Dashboard. When a table or column it needs is missing, the
adapter produces nothing (`unavailable`), never a guess; that includes
`scheduled_tasks.thread_id`, without which automation cannot be told apart.

## Consent and state

`src/usage/outbox.ts` keeps `<base>/usage/state.json` (0600, durable writes):

- absent or unreadable state means off: no source is read, nothing is sent;
- switching on records the instant; nothing that happened before it is ever
  queued, so no history is reconstructed;
- switching off deletes the queue and the cursor at once;
- the queue is bounded (`usageQueueMax`) and counts what it had to drop;
- every change of the state happens under one kernel lock (`usage/lock`). A
  round sends each batch inside the lock, after re-reading the state and only
  under the consent it started with, and records the answer before it lets
  go. Switching off therefore waits for a send in progress (at most the
  relay's 20-second timeout) and, once it returns, nothing more is sent and
  no round can write consent back.

## Delivery

`src/usage/collect.ts` runs one round: read since the last read (with a
two-hour re-read for late outcomes), queue, and deliver batches of at most 100
events through the Environment's relay at `/usage/events` (`deliveryOutcome`):

| Answer | Batch | Round |
| --- | --- | --- |
| `202` | removed | next batch |
| `400` (the batch itself is invalid) | removed, never resent | next batch |
| `413` (the request is too large, not its events) | kept | the same events in halved batches; a single event still too large stays queued |
| `403` with `usage_not_collected` (a Personal or services Environment, or no assignee) | queue deleted | measuring switched off |
| any other answer: `401`, `403` of another reason, `404`, `408`, `429`, `5xx` | kept | stops; the next round resends it |
| no answer from the relay | kept | stops; the next round resends it |

## Not done, and why

1. **Decisions first.** Platform rules describe measurement as opt-in and
   content-free (`AGENTS.md`, `docs/profile-evidence.md`). Per-person usage
   inside an Organization is a different purpose and needs its own decision,
   together with the Dashboard's decisions on store, retention and who may see
   the team view.
2. **Consent surface.** Who switches it on: the Environment's Assigned User
   (proposed), with a notice of what is measured, in Launchpad Settings and
   `lazurio usage status|on|off`. Not built.
3. **Relay path.** The gateway's relay forwards only the settings calls today;
   `/usage/events` needs the same forwarding in the gateway (Machines).
4. **Environment client.** The Environment needs an `environment_client_id`
   in the Dashboard's registry, as for the settings delivery.
5. **Schedule.** One round every ten minutes from the Launchpad's existing
   timers, after the points above.
6. **App opens.** The Launchpad does not count application opens; `app.opened`
   would be produced where it opens a module, by module slug only.
