import type { ListenerObservation } from "./application-runner";
import { parseHealthListener, probeListenerHealth } from "./health";
import { observeListenerBindings } from "./listener-ownership";

type Bindings = Awaited<ReturnType<typeof observeListenerBindings>>;
type Listener = ReturnType<typeof parseHealthListener>;

// One bounded readiness observation shared by every application owner: declared
// health is only reported together with fresh evidence, before AND after the
// probe, that the listener still belongs to the same live owner. `ownership`
// returns null for "this owner's" or a reason; it is the only owner-specific part
// (process group for a session, control group for a service). Snapshots cannot
// exclude a replacement and restoration between the two reads.
export async function observeOwnedListener(input: {
  listener: unknown;
  timeoutMs: number;
  active: () => boolean | Promise<boolean>;
  ownership: (
    bindings: Bindings,
    listener: Listener,
  ) => string | null | Promise<string | null>;
  observeBindings?: typeof observeListenerBindings;
  probeHealth?: typeof probeListenerHealth;
}): Promise<ListenerObservation> {
  const listener = parseHealthListener(input.listener);
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 30_000
  )
    throw new Error("Bounded health timeout required");
  const observe = input.observeBindings ?? observeListenerBindings;
  const probe = input.probeHealth ?? probeListenerHealth;
  const inactive = Object.freeze({ kind: "lifecycle-inactive" as const });
  if (!(await input.active())) return inactive;
  const before = await observe(listener.port);
  if (!(await input.active())) return inactive;
  const ownership = await input.ownership(before, listener);
  if (ownership !== null)
    return Object.freeze({
      kind: "ownership-unconfirmed" as const,
      reason: ownership,
    });
  const health = await probe(listener, input.timeoutMs);
  if (!(await input.active())) return inactive;
  const after = await observe(listener.port);
  if (!(await input.active())) return inactive;
  const finalOwnership = await input.ownership(after, listener);
  if (finalOwnership !== null)
    return Object.freeze({
      kind: "ownership-unconfirmed" as const,
      reason: finalOwnership,
    });
  // Refuse even an in-owner replacement between the two observations.
  const fingerprint = (value: Bindings) =>
    value.kind === "observed"
      ? JSON.stringify(
          value.bindings.map((binding) => JSON.stringify(binding)).sort(),
        )
      : "";
  if (fingerprint(before) !== fingerprint(after))
    return Object.freeze({ kind: "bindings-changed" as const });
  return Object.freeze({
    kind:
      health.kind === "responding"
        ? ("observed-healthy" as const)
        : ("health-failed" as const),
    health,
  });
}

// Refuse a declared port that any process already listens on. Absence is not an
// OS reservation: a race after this check still only fails the application's own
// bind, and no foreign process is adopted or signalled.
export async function refuseOccupiedPorts(
  ports: readonly number[],
  observeBindings: typeof observeListenerBindings = observeListenerBindings,
) {
  for (const port of ports) {
    const bindings = await observeBindings(port);
    if (bindings.kind !== "observed")
      return Object.freeze({ kind: "inspection-unavailable" as const });
    if (bindings.bindings.length)
      return Object.freeze({ kind: "port-occupied" as const });
  }
  return null;
}
