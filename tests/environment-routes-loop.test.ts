import { expect, test } from "bun:test";
import type { AccessServiceLocation } from "../src/ssh-access/access-service";
import { runEnvironmentRoutes } from "../src/ssh-access/routes";

// The Launchpad's live loop of the routes (root decision 0224; review of
// #833): every tick reads the handover's declaration again, so a service
// declared, replaced or removed after start takes effect at the next tick and
// an old origin is never asked again.

const service = (origin: string) =>
  ({ origin }) as unknown as AccessServiceLocation;

function harness(declared: () => AccessServiceLocation | null) {
  let tick: (() => void) | undefined;
  let cleared = false;
  const asked: string[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const stop = runEnvironmentRoutes(
    async () => declared(),
    async (location) => {
      asked.push((location as unknown as { origin: string }).origin);
      if (hold) await new Promise<void>((resolve) => (release = resolve));
    },
    {
      everyMs: 60_000,
      setInterval: (next) => {
        tick = next;
        return "handle";
      },
      clearInterval: (handle) => {
        cleared = handle === "handle";
      },
    },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    asked,
    stop,
    async next() {
      tick?.();
      await settle();
    },
    settle,
    holdNext() {
      hold = true;
    },
    release() {
      hold = false;
      release?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

test("a service declared after start is used from the next tick, a replaced origin replaces the old one, and a removed one is never asked again", async () => {
  let declared: AccessServiceLocation | null = null;
  const h = harness(() => declared);
  await h.settle();
  expect(h.asked).toEqual([]);

  declared = service("http://host-a.tailnet.example.invalid:8444");
  await h.next();
  expect(h.asked).toEqual(["http://host-a.tailnet.example.invalid:8444"]);

  declared = service("http://host-b.tailnet.example.invalid:8444");
  await h.next();
  await h.next();
  expect(h.asked).toEqual([
    "http://host-a.tailnet.example.invalid:8444",
    "http://host-b.tailnet.example.invalid:8444",
    "http://host-b.tailnet.example.invalid:8444",
  ]);

  // Removed: no further call, to the old origin or any other.
  declared = null;
  await h.next();
  await h.next();
  expect(h.asked.length).toBe(3);
});

test("one synchronization at a time, a failing read or synchronization never stops the loop, and stop ends it", async () => {
  let calls = 0;
  let declared: AccessServiceLocation | null = service(
    "http://host-a.tailnet.example.invalid:8444",
  );
  const h = harness(() => {
    calls += 1;
    if (calls === 3) throw new Error("handover unreadable");
    return declared;
  });
  await h.settle();
  expect(h.asked.length).toBe(1);

  // A tick while one synchronization runs does not start a second.
  h.holdNext();
  await h.next();
  expect(h.asked.length).toBe(2);
  await h.next();
  expect(h.asked.length).toBe(2);
  h.release();
  await h.settle();

  // The third read throws: nothing is asked, and the loop goes on.
  await h.next();
  expect(h.asked.length).toBe(2);
  await h.next();
  expect(h.asked.length).toBe(3);

  h.stop();
  expect(h.cleared).toBe(true);
  declared = service("http://host-b.tailnet.example.invalid:8444");
  await h.next();
  expect(h.asked.length).toBe(3);
});
