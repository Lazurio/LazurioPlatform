import type { RelayTransport } from "../organization-settings/relay";
import type { UsageEvent } from "./events";
import {
  type DeliveryOutcome,
  enqueue,
  nextBatch,
  type UsageState,
  type UsageStateStore,
} from "./outbox";
import type { T3UsageRead } from "./t3-source";

// One round of the usage producer (proposed, docs/usage-producer.md):
// read what happened since the last round, queue it, and deliver what is
// queued through the Environment's relay, one batch after another, until a
// batch is not accepted. Off means off: without consent no source is read
// and nothing reaches the relay.

/** The relay's path to the Dashboard's `POST /api/environment/v1/usage/events`. */
export const usageRelayPath = "/usage/events";
/** A run that ends this long after the last read is still found: its outcome is read again. */
export const usageRereadMs = 2 * 60 * 60 * 1000;
const relayTimeoutMs = 20_000;
const answerMaxBytes = 4 * 1024;

export type UsageRoundDeps = Readonly<{
  store: UsageStateStore;
  /** Read the Environment's sources from an instant on. */
  read: (since: string) => T3UsageRead;
  relay: RelayTransport;
  now: () => Date;
}>;

export type UsageRound = Readonly<{
  kind: "off" | "unavailable" | "delivered" | "waiting";
  queued: number;
  outcome: DeliveryOutcome | null;
}>;

function outcomeOf(status: number): DeliveryOutcome {
  if (status === 202) return "delivered";
  // 403: the Dashboard does not collect this Environment's usage (a Personal
  // or services Environment, or no assignee). Nothing is sent again.
  if (status === 403) return "not-collected";
  // Any other 4xx: the batch itself is wrong; keeping it would block the queue.
  if (status >= 400 && status < 500 && status !== 429) return "refused";
  return "unreachable";
}

export async function usageRound(deps: UsageRoundDeps): Promise<UsageRound> {
  let state: UsageState = await deps.store.read();
  if (!state.enabled || state.enabledAt === null)
    return { kind: "off", queued: 0, outcome: null };
  const now = deps.now();
  const from = new Date(
    Math.max(
      Date.parse(state.enabledAt),
      Date.parse(state.readUntil ?? state.enabledAt) - usageRereadMs,
    ),
  ).toISOString();
  const read = deps.read(from);
  if (read.kind === "ready") {
    // Nothing that happened before consent is ever queued.
    const enabledAt = state.enabledAt;
    const events: UsageEvent[] = read.events.filter(
      (event) => event.occurred_at >= enabledAt,
    );
    state = { ...enqueue(state, events), readUntil: now.toISOString() };
  }

  let outcome: DeliveryOutcome | null = null;
  for (;;) {
    const batch = nextBatch(state);
    if (batch === null) break;
    const exchange = await deps.relay({
      method: "POST",
      path: usageRelayPath,
      headers: { "content-type": "application/json" },
      body: batch.body,
      timeoutMs: relayTimeoutMs,
      maxBytes: answerMaxBytes,
    });
    outcome =
      exchange.kind === "answer" ? outcomeOf(exchange.status) : "unreachable";
    if (outcome === "delivered" || outcome === "refused") {
      state = {
        ...state,
        queue: state.queue.filter((event) => !batch.ids.has(event.event_id)),
      };
      if (outcome === "delivered") continue;
    }
    break;
  }
  if (outcome === "not-collected") {
    // The Dashboard will not take this Environment's usage: stop measuring
    // and keep nothing, as if switched off.
    await deps.store.purge();
    return { kind: "off", queued: 0, outcome };
  }
  state = {
    ...state,
    lastDelivery:
      outcome === null
        ? state.lastDelivery
        : { at: now.toISOString(), outcome },
  };
  await deps.store.write(state);
  if (read.kind !== "ready")
    return { kind: "unavailable", queued: state.queue.length, outcome };
  return {
    kind: state.queue.length === 0 ? "delivered" : "waiting",
    queued: state.queue.length,
    outcome,
  };
}
