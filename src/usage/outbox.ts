import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "../platform/flock";
import { writeDurableFile } from "../update/durable-file";
import { type UsageEvent, usageBatch, usageBatchMaxEvents } from "./events";

// The usage producer's own state (proposed, docs/usage-producer.md):
// `<base>/usage/state.json`, 0600, written durably. Measurement is opt-in
// (AGENTS.md, docs/profile-evidence.md):
//
// - absent or unreadable state is "off": nothing is read and nothing is sent;
// - switching on records the instant, and only what happens after it is ever
//   read: no history is reconstructed;
// - switching off deletes the queue and the cursor at once, so nothing that
//   was waiting is sent later.
//
// Every change of the state happens under one kernel lock (`usage/lock`,
// `src/platform/flock.ts`), and every holder reads the state again first. A
// round never carries a state across a wait for the relay: it checks under
// the lock that the same consent (`enabledAt`) still stands before it sends
// the next batch and before it records an answer, so switching off can
// neither be undone by a round nor followed by another batch. A batch already
// on its way when consent ends may still arrive; nothing after it is sent.

const schemaVersion = 1;
/** Events kept while the Dashboard cannot be reached (about a working month of one person). */
export const usageQueueMax = 20_000;

export type UsageState = Readonly<{
  enabled: boolean;
  /** When measuring was switched on; nothing before it is read. */
  enabledAt: string | null;
  /** Everything up to this instant has been read into the queue. */
  readUntil: string | null;
  /** Read and not yet accepted by the Dashboard, oldest first. */
  queue: readonly UsageEvent[];
  /** Events dropped because the queue was full. */
  dropped: number;
  lastDelivery: Readonly<{ at: string; outcome: DeliveryOutcome }> | null;
}>;

/**
 * How the Dashboard answered a batch:
 * - `delivered` (202): accepted; removed from the queue;
 * - `refused` (400, 413): the batch itself is invalid; removed, never resent;
 * - `not-collected` (403 `usage_not_collected`): the Dashboard does not take
 *   this Environment's usage; measuring stops;
 * - `retrying`: anything that does not establish that, a 401, 403 of another
 *   reason, 404, 408, 429 or 5xx included; kept for the next round;
 * - `unreachable`: the relay gave no answer; kept for the next round.
 */
export type DeliveryOutcome =
  | "delivered"
  | "refused"
  | "not-collected"
  | "retrying"
  | "unreachable";

export const usageOff: UsageState = Object.freeze({
  enabled: false,
  enabledAt: null,
  readUntil: null,
  queue: [],
  dropped: 0,
  lastDelivery: null,
});

export type UsageStateStore = Readonly<{
  read(): Promise<UsageState>;
  write(state: UsageState): Promise<void>;
  /** Off, with the queue and the cursor deleted. */
  purge(): Promise<void>;
  /** `work` under the state's lock; read the state again inside it. */
  locked<T>(work: () => Promise<T>): Promise<T>;
}>;

/** How long a holder of the state's lock may keep another one waiting. */
export const usageLockTimeoutMs = 30_000;

const outcomes: readonly DeliveryOutcome[] = [
  "delivered",
  "refused",
  "not-collected",
  "retrying",
  "unreachable",
];

/** Whether a state still carries the consent a round started under. */
export function sameConsent(state: UsageState, enabledAt: string): boolean {
  return state.enabled && state.enabledAt === enabledAt;
}

function lastDeliveryOf(value: unknown): UsageState["lastDelivery"] {
  if (typeof value !== "object" || value === null) return null;
  const { at, outcome } = value as Record<string, unknown>;
  return typeof at === "string" && outcomes.includes(outcome as DeliveryOutcome)
    ? { at, outcome: outcome as DeliveryOutcome }
    : null;
}

export function usageStateStore(base: string): UsageStateStore {
  const directory = join(base, "usage");
  const file = join(directory, "state.json");
  return {
    async read() {
      try {
        const raw = JSON.parse(await readFile(file, "utf8")) as Record<
          string,
          unknown
        >;
        if (raw.schemaVersion !== schemaVersion || raw.enabled !== true)
          return usageOff;
        return {
          enabled: true,
          enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : null,
          readUntil: typeof raw.readUntil === "string" ? raw.readUntil : null,
          queue: Array.isArray(raw.queue) ? (raw.queue as UsageEvent[]) : [],
          dropped: typeof raw.dropped === "number" ? raw.dropped : 0,
          lastDelivery: lastDeliveryOf(raw.lastDelivery),
        };
      } catch {
        // Absent or unreadable: off. Measuring never starts by accident.
        return usageOff;
      }
    },
    async write(state) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeDurableFile(
        directory,
        "state.json",
        new TextEncoder().encode(
          `${JSON.stringify({ schemaVersion, ...state })}\n`,
        ),
      );
    },
    async purge() {
      await rm(file, { force: true });
    },
    async locked(work) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = await acquireFileLock(join(directory, "lock"), {
        timeoutMs: usageLockTimeoutMs,
      });
      try {
        return await work();
      } finally {
        await lock.release();
      }
    },
  };
}

/** Switch measuring on from `now`; an Environment already on keeps its state. */
export async function enableUsage(
  store: UsageStateStore,
  now: Date,
): Promise<UsageState> {
  return store.locked(async () => {
    const current = await store.read();
    if (current.enabled) return current;
    const at = now.toISOString();
    const state: UsageState = {
      ...usageOff,
      enabled: true,
      enabledAt: at,
      readUntil: at,
    };
    await store.write(state);
    return state;
  });
}

/** Switch measuring off and delete everything waiting. */
export async function disableUsage(store: UsageStateStore): Promise<void> {
  await store.locked(() => store.purge());
}

/** Add read events to the queue, without repeats, within its bound. */
export function enqueue(
  state: UsageState,
  events: readonly UsageEvent[],
): UsageState {
  const known = new Set(state.queue.map((event) => event.event_id));
  const fresh = events.filter((event) => !known.has(event.event_id));
  const queue = [...state.queue, ...fresh];
  const overflow = Math.max(0, queue.length - usageQueueMax);
  return {
    ...state,
    queue: queue.slice(overflow),
    dropped: state.dropped + overflow,
  };
}

/** The next delivery: at most one batch, its body and the ids it carries. */
export function nextBatch(
  state: UsageState,
): Readonly<{ body: string; ids: ReadonlySet<string> }> | null {
  if (state.queue.length === 0) return null;
  const events = state.queue.slice(0, usageBatchMaxEvents);
  return {
    body: usageBatch(events),
    ids: new Set(events.map((event) => event.event_id)),
  };
}
