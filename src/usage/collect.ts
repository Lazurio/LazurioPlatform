import type {
  RelayExchange,
  RelayTransport,
} from "../organization-settings/relay";
import type { UsageEvent } from "./events";
import {
  type DeliveryOutcome,
  enqueue,
  nextBatch,
  sameConsent,
  type UsageState,
  type UsageStateStore,
} from "./outbox";
import type { T3UsageRead } from "./t3-source";

// One round of the usage producer (proposed, docs/usage-producer.md):
// read what happened since the last round, queue it, and deliver what is
// queued through the Environment's relay, one batch after another, until a
// batch is not accepted. Off means off: without consent no source is read
// and nothing reaches the relay.
//
// The state is never held across a wait for the relay. Each step takes the
// state's lock, reads the state again and goes on only under the consent the
// round started with (src/usage/outbox.ts): switching off mid-round stops it
// before the next batch and is never written over.

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

const off = (outcome: DeliveryOutcome | null): UsageRound => ({
  kind: "off",
  queued: 0,
  outcome,
});

/** The Dashboard's error code of an answer, when it gave one. */
function errorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * What an answer means for the batch. Only an answer that establishes the
 * batch is invalid drops it; an answer about authentication, routing, load or
 * time keeps it (docs/usage-producer.md, "Delivery").
 */
export function deliveryOutcome(exchange: RelayExchange): DeliveryOutcome {
  if (exchange.kind === "failed") return "unreachable";
  const { status } = exchange;
  if (status === 202) return "delivered";
  if (status === 400 || status === 413) return "refused";
  if (status === 403 && errorCode(exchange.text) === "usage_not_collected")
    return "not-collected";
  return "retrying";
}

export async function usageRound(deps: UsageRoundDeps): Promise<UsageRound> {
  const now = deps.now();
  const store = deps.store;
  // Read the sources and queue what they say, under the consent that stands.
  const started = await store.locked(async () => {
    const state = await store.read();
    if (!state.enabled || state.enabledAt === null) return null;
    const enabledAt = state.enabledAt;
    const from = new Date(
      Math.max(
        Date.parse(enabledAt),
        Date.parse(state.readUntil ?? enabledAt) - usageRereadMs,
      ),
    ).toISOString();
    const read = deps.read(from);
    if (read.kind !== "ready") return { enabledAt, read };
    // Nothing that happened before consent is ever queued.
    const events: UsageEvent[] = read.events.filter(
      (event) => event.occurred_at >= enabledAt,
    );
    await store.write({
      ...enqueue(state, events),
      readUntil: now.toISOString(),
    });
    return { enabledAt, read };
  });
  if (started === null) return off(null);
  const { enabledAt, read } = started;

  let outcome: DeliveryOutcome | null = null;
  let queued = 0;
  for (;;) {
    const step = await store.locked(async () => {
      const state = await store.read();
      if (!sameConsent(state, enabledAt)) return "revoked" as const;
      queued = state.queue.length;
      return nextBatch(state);
    });
    if (step === "revoked") return off(outcome);
    if (step === null) break;
    outcome = deliveryOutcome(
      await deps.relay({
        method: "POST",
        path: usageRelayPath,
        headers: { "content-type": "application/json" },
        body: step.body,
        timeoutMs: relayTimeoutMs,
        maxBytes: answerMaxBytes,
      }),
    );
    const answered: DeliveryOutcome = outcome;
    const recorded = await store.locked(async () => {
      const state = await store.read();
      if (!sameConsent(state, enabledAt)) return "revoked" as const;
      if (answered === "not-collected") {
        // The Dashboard will not take this Environment's usage: stop
        // measuring and keep nothing, as if switched off.
        await store.purge();
        return "revoked" as const;
      }
      const drop = answered === "delivered" || answered === "refused";
      const next: UsageState = {
        ...state,
        queue: drop
          ? state.queue.filter((event) => !step.ids.has(event.event_id))
          : state.queue,
        lastDelivery: { at: now.toISOString(), outcome: answered },
      };
      await store.write(next);
      queued = next.queue.length;
      return "recorded" as const;
    });
    if (recorded === "revoked") return off(outcome);
    if (answered !== "delivered" && answered !== "refused") break;
  }
  if (read.kind !== "ready") return { kind: "unavailable", queued, outcome };
  return { kind: queued === 0 ? "delivered" : "waiting", queued, outcome };
}
