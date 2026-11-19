import { type BuddySignal, buddySignalPath } from "../shell/buddy-signal";

export { buddySignalPath };

// The sign by Buddy GEN4's avatar as a stream (plan LZD-0033, the sign): the
// shell's bubble on every page of the person's Osobní Prostředí follows it
// on its own origin, which the gateway forwards to the Launchpad behind the
// same admission as the shell document. Each event is the whole sign, the
// first one the current; a comment keeps idle proxies from closing it.

const keepaliveMs = 25_000;
// How long EventSource waits before it reconnects after the stream ends.
const reconnectMs = 5_000;

type Follower = Readonly<{
  current: () => BuddySignal;
  subscribe: (listener: (signal: BuddySignal) => void) => () => void;
}>;

/** One stream of `follower`'s sign; its stop is in `open` until it ends,
 * so the Launchpad ends every stream when it closes. */
export function buddySignalStream(
  follower: Follower,
  open: Set<() => void>,
): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      const send = (text: string) => {
        if (ended) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const event = (signal: BuddySignal) =>
        send(`data: ${JSON.stringify(signal)}\n\n`);
      send(`retry: ${reconnectMs}\n\n`);
      event(follower.current());
      const unsubscribe = follower.subscribe(event);
      const beat = setInterval(() => send(": keepalive\n\n"), keepaliveMs);
      stop = () => {
        if (ended) return;
        ended = true;
        unsubscribe();
        clearInterval(beat);
        open.delete(stop);
        try {
          controller.close();
        } catch {}
      };
      open.add(stop);
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
