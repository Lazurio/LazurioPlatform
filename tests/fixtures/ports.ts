import { randomInt } from "node:crypto";

// A loopback port for a listener a test configures before it starts (a
// handover's `listenPort`, a gateway's), when the listener cannot take port 0
// itself (issue #413).
//
// Probing port 0 and releasing it hands out an ephemeral port: until the
// listener binds it, the kernel may give the same port to any other socket,
// another worker's outgoing connection or port-0 listener among them, and
// the start fails with "Failed to start server. Is port <n> in use?". These
// ports lie below both kernels' ephemeral ranges (Linux 32768-60999, macOS
// 49152-65535), so the kernel never hands them out on its own. Each worker of
// `bun test --parallel` takes them from a range of its own, by
// BUN_TEST_WORKER_ID (a run without workers takes all of them); a file never
// gets the same port twice; and a port that something listens on already is
// skipped. Two test runs on one machine at the same time may still meet.
const first = 20_000;
const slice = 1_000;
const slices = 12;

const given = new Set<number>();

export function freePort(): number {
  const worker = Number(process.env.BUN_TEST_WORKER_ID);
  const [base, size] =
    Number.isInteger(worker) && worker > 0
      ? [first + ((worker - 1) % slices) * slice, slice]
      : [first, slices * slice];
  const start = randomInt(size);
  for (let step = 0; step < size; step += 1) {
    const port = base + ((start + step) % size);
    if (given.has(port)) continue;
    try {
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response(""),
      }).stop(true);
    } catch {
      continue;
    }
    given.add(port);
    return port;
  }
  throw new Error("No free loopback port left for this test file");
}
