import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BuddySignalProcess,
  buddySignalFollowerFor,
} from "../src/buddy/signal";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  buddySignalPath,
  buddySignalStream,
} from "../src/launchpad/buddy-signal-stream";
import { startLaunchpad } from "../src/launchpad/server";
import { shellDocument } from "../src/launchpad/shell-document";
import { type BuddySignal, unavailableSignal } from "../src/shell/buddy-signal";
import { parseShell } from "../src/shell/contract";
import { layout } from "../src/update/layout";
import { binding, handoverEntry, withBuddy } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";
import { freePort } from "./fixtures/ports";

// The sign by Buddy GEN4's avatar in the Launchpad (plan LZD-0033): the shell
// document carries it beside his origin and `/.lazurio/buddy/signal` streams
// it, only where the entry names Buddy GEN4. A sign nobody could read is
// `unavailable` all the way to the page, never quiet.

const host = "example.lazurio.io";
const buddyOrigin = `https://buddy.${host}`;
const gen4 = (port: number, home = "/home/operator") =>
  binding({
    ...personal,
    entry: {
      ...handoverEntry(host, port),
      buddy: {
        generation: 4,
        folder: join(home, "Buddy"),
        profile: "buddy",
        external_origin: buddyOrigin,
      },
    },
  });
const gen3 = (port: number, _home?: string) =>
  binding({ ...personal, entry: withBuddy(handoverEntry(host, port), host) });

const waiting: BuddySignal = {
  state: "waiting",
  since: "2026-11-19T16:00:00.000Z",
  request: { kind: "question" },
  startedBy: "person",
};

test("the shell document carries Buddy GEN4's sign beside his origin, and a sign it cannot read is unavailable", () => {
  const machine = gen4(20000);
  const document = shellDocument({
    preset: "hosted-personal",
    machine,
    locale: "cs",
    catalog: { kind: "catalog", organizations: [] },
    buddyOpen: true,
    buddySignal: waiting,
  });
  expect(document.buddy).toEqual({ origin: buddyOrigin, signal: waiting });
  // Without a sign (Buddy GEN3) only the origin, as before.
  expect(
    shellDocument({
      preset: "hosted-personal",
      machine: gen3(20000),
      locale: "cs",
      catalog: { kind: "catalog", organizations: [] },
      buddyOpen: true,
    }).buddy,
  ).toEqual({ origin: buddyOrigin });
  // Never while Buddy is closed.
  expect(
    shellDocument({
      preset: "hosted-personal",
      machine,
      locale: "cs",
      catalog: { kind: "catalog", organizations: [] },
      buddyOpen: false,
      buddySignal: waiting,
    }).buddy,
  ).toBeUndefined();
  // A consumer reads a garbled sign as unavailable, never as quiet or none.
  for (const signal of [{ state: "sleeping" }, "quiet", 1, null]) {
    const parsed = parseShell({
      ...JSON.parse(JSON.stringify(document)),
      buddy: { origin: buddyOrigin, signal },
    });
    expect(parsed?.buddy?.signal).toEqual(unavailableSignal);
  }
});

/** The events of a stream, as EventSource would read them. */
async function events(response: Response, count: number) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("No body");
  const decoder = new TextDecoder();
  let text = "";
  const seen: unknown[] = [];
  while (seen.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let end = text.indexOf("\n\n");
    while (end !== -1) {
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      for (const line of block.split("\n"))
        if (line.startsWith("data: ")) seen.push(JSON.parse(line.slice(6)));
      end = text.indexOf("\n\n");
    }
  }
  return { seen, reader };
}

test("the stream sends the current sign, then each change, and ends when the Launchpad stops it", async () => {
  let current: BuddySignal = unavailableSignal;
  const listeners = new Set<(signal: BuddySignal) => void>();
  const follower = {
    current: () => current,
    subscribe: (listener: (signal: BuddySignal) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const open = new Set<() => void>();
  const response = buddySignalStream(follower, open);
  expect(response.headers.get("content-type")).toBe(
    "text/event-stream; charset=utf-8",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  const first = await events(response, 1);
  expect(first.seen).toEqual([unavailableSignal]);
  current = waiting;
  for (const listener of listeners) listener(waiting);
  const { value } = await first.reader.read();
  expect(new TextDecoder().decode(value)).toBe(
    `data: ${JSON.stringify(waiting)}\n\n`,
  );
  expect(open.size).toBe(1);
  for (const stop of [...open]) stop();
  expect(open.size).toBe(0);
  expect(listeners.size).toBe(0);
  expect((await first.reader.read()).done).toBe(true);
});

const posix = test.skipIf(process.platform === "win32");

async function hosted(machineOf: typeof gen4) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-signal-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const port = freePort();
  const machine = machineOf(port, parent);
  const preset = "hosted-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const lines: ((line: string) => void)[] = [];
  const base = join(parent, "base");
  await mkdir(dirname(layout(base).healthSocket), {
    recursive: true,
    mode: 0o700,
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    {
      base,
      version: "0.0.0-test",
      buddySignalAtStart: async (onLine): Promise<BuddySignalProcess> => {
        lines.push(onLine);
        return { exited: new Promise(() => {}), stop: () => {} };
      },
    },
    {
      fetcher: async (_url, init) =>
        new Headers(init.headers).get("cookie") ===
        "__Secure-lazurio-workspace=valid"
          ? new Response("ok")
          : new Response("no", { status: 401 }),
    },
    {
      path: join(parent, "bin"),
      home: parent,
      platform: process.platform,
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    },
  );
  const entry = machine.entry;
  if (entry === null || entry === undefined)
    throw new Error("The fixture has an entry");
  const ask = (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${entry.listenPort}${buddySignalPath}`, {
      headers: {
        host: new URL(entry.externalOrigin).host,
        cookie: "__Secure-lazurio-workspace=valid",
        ...headers,
      },
    });
  return { app, parent, lines, ask };
}

test("only an entry that names Buddy GEN4 gets a follower, and only where the service says how to start it", () => {
  const start = async (): Promise<BuddySignalProcess> => ({
    exited: new Promise(() => {}),
    stop: () => {},
  });
  const follower = buddySignalFollowerFor(gen4(20000).entry, start);
  expect(follower?.current()).toBe(unavailableSignal);
  follower?.close();
  expect(buddySignalFollowerFor(gen4(20000).entry, undefined)).toBeNull();
  expect(buddySignalFollowerFor(gen3(20000).entry, start)).toBeNull();
  expect(
    buddySignalFollowerFor(
      binding({ ...personal, entry: handoverEntry(host) }).entry,
      start,
    ),
  ).toBeNull();
  expect(buddySignalFollowerFor(null, start)).toBeNull();
});

posix(
  "Buddy GEN3's Launchpad follows nothing and has no stream of a sign",
  async () => {
    const gen3Launchpad = await hosted(gen3);
    try {
      expect(gen3Launchpad.lines).toHaveLength(0);
      expect((await gen3Launchpad.ask({ cookie: "" })).status).toBe(401);
      expect((await gen3Launchpad.ask()).status).toBe(404);
    } finally {
      await gen3Launchpad.app.close();
      await rm(gen3Launchpad.parent, { recursive: true, force: true });
    }
  },
  30_000,
);
