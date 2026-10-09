import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for the Environment's relay on the gateway (Machines #449,
// contract C3): an HTTP/1.1 server on a unix socket of its own, answering
// what each test says and recording every request exactly as it arrived.

export type RelayRequest = Readonly<{
  method: string;
  path: string;
  query: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type FakeRelay = Readonly<{
  socket: string;
  requests: RelayRequest[];
  close(): Promise<void>;
}>;

export async function fakeRelay(
  answer: (request: RelayRequest) => Response | Promise<Response>,
): Promise<FakeRelay> {
  const directory = await mkdtemp(join(tmpdir(), "relay-"));
  const socket = join(directory, "relay.sock");
  const requests: RelayRequest[] = [];
  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const url = new URL(request.url);
      const recorded: RelayRequest = Object.freeze({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.freeze(Object.fromEntries(request.headers)),
        body: await request.text(),
      });
      requests.push(recorded);
      return answer(recorded);
    },
  });
  return Object.freeze({
    socket,
    requests,
    async close() {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  });
}

/** The Dashboard's answer of contract C2, as the relay passes it on. */
export function settingsAnswer(
  body: unknown,
  version: string,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: { etag: `"${version}"`, "cache-control": "no-store" },
  });
}

export const commit = (digit: string) => digit.repeat(40);
