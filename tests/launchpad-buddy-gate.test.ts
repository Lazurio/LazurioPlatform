import { expect, test } from "bun:test";
import type { BuddyFacts } from "../src/buddy/status";
import {
  type MachineBinding,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { launchpadBoot } from "../src/launchpad/boot-document";
import {
  buddyGateAnswer,
  buddyGatePath,
  buddyOpenOf,
  buddyT3Active,
} from "../src/launchpad/buddy-gate";
import { publicEntry } from "../src/launchpad/chat";
import { parseEntryAnswer } from "../src/launchpad/chat-view";
import { createSetupCache } from "../src/launchpad/setup-state";
import type { ToolRunner } from "../src/tools/status";
import { bindings } from "./fixtures/machine-bindings";

// Buddy open (F60's addendum of 2026-11-09, Matěj's decision "Odkaz do
// Začínáme"): his bubble only once he runs and the person has his persona,
// and his own address leads to Začínáme until then.

const buddyOrigin = "https://buddy.example.lazurio.io";
const personalEntry = bindings.personalEntry as MachineBinding & {
  entry: NonNullable<MachineBinding["entry"]>;
};
const recorded = parseMachineBinding(
  JSON.parse(
    JSON.stringify({
      ...personalEntry,
      entry: { ...personalEntry.entry, buddyOrigin },
    }),
  ),
) as MachineBinding & { entry: NonNullable<MachineBinding["entry"]> };

const signedIn: BuddyFacts = { runtime: "ready", loggedIn: true };

test("Buddy is open only signed in, with his names confirmed and his T3 Code running", () => {
  expect(buddyOpenOf(signedIn, true, true)).toBe(true);
  const closed: [BuddyFacts, boolean, boolean][] = [
    // Not signed in to the person's ChatGPT, or the card not readable.
    [{ runtime: "ready", loggedIn: false }, true, true],
    [{ runtime: "ready", loggedIn: undefined }, true, true],
    // His gateway does not run, or cannot be asked.
    [{ runtime: "not-running" }, true, true],
    [{ runtime: "unknown" }, true, true],
    // No persona confirmed yet.
    [signedIn, false, true],
    // His T3 Code, the page his bubble frames, does not run.
    [signedIn, true, false],
  ];
  for (const [facts, confirmed, t3] of closed)
    expect({
      facts,
      confirmed,
      t3,
      open: buddyOpenOf(facts, confirmed, t3),
    }).toEqual({ facts, confirmed, t3, open: false });
});

test("his T3 Code counts as running only when systemd says its unit is active", async () => {
  const calls: (readonly string[])[] = [];
  const runner =
    (answer: "active" | "inactive" | "timeout" | "throws"): ToolRunner =>
    async (command) => {
      calls.push(command);
      if (answer === "throws") throw new Error("spawn");
      if (answer === "timeout") return "timeout";
      return {
        exitCode: answer === "active" ? 0 : 3,
        stdout: "",
        stderr: "",
      };
    };
  const service = (answer: Parameters<typeof runner>[0]) => ({
    run: runner(answer),
    env: { HOME: "/home/person" },
  });
  expect(await buddyT3Active(service("active"))).toBe(true);
  expect(calls[0]).toEqual([
    "systemctl",
    "--user",
    "is-active",
    "--quiet",
    "lazurio-t3-buddy.service",
  ]);
  for (const answer of ["inactive", "timeout", "throws"] as const)
    expect(await buddyT3Active(service(answer))).toBe(false);
});

test("the gate lets a navigation through while Buddy is open, and sends it to Začínáme otherwise", async () => {
  expect(buddyGatePath).toBe("/.lazurio/buddy/gate");
  const open = buddyGateAnswer(recorded.entry, true);
  expect(open.status).toBe(204);
  expect(open.headers.get("cache-control")).toBe("no-store");
  expect(await open.text()).toBe("");

  const closed = buddyGateAnswer(recorded.entry, false);
  expect(closed.status).toBe(303);
  expect(closed.headers.get("cache-control")).toBe("no-store");
  expect(recorded.entry.externalOrigin).toBe(
    "https://launchpad.example.lazurio.io",
  );
  // Začínáme of this Environment's own Launchpad, never composed from
  // Buddy's origin, with his dialog to open.
  expect(closed.headers.get("location")).toBe(
    `${recorded.entry.externalOrigin}/settings/start#lazurio-start=meet-buddy`,
  );

  // An entry that names no Buddy, or none at all: he is not here.
  for (const entry of [personalEntry.entry, null]) {
    const absent = buddyGateAnswer(entry, true);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "buddy-absent" });
  }
});

test("the page knows Buddy is here from the entry's public parts, which carry only his origin's shape", () => {
  const entry = publicEntry(recorded.entry);
  expect(entry?.buddyOrigin).toBe(buddyOrigin);
  expect(parseEntryAnswer({ kind: "entry", entry })).toEqual(entry);
  // Without Buddy the public parts are as before.
  expect(
    Object.hasOwn(publicEntry(personalEntry.entry) ?? {}, "buddyOrigin"),
  ).toBe(false);
  // Another shape refuses the whole answer, as for every origin.
  for (const other of [
    "http://buddy.example.lazurio.io",
    "https://chat.example.lazurio.io",
    "https://buddy.example.lazurio.io/",
    42,
  ])
    expect(
      parseEntryAnswer({
        kind: "entry",
        entry: { ...entry, buddyOrigin: other },
      }),
    ).toBeNull();
});

test("the page's boot document names Buddy's bubble only while he is open", () => {
  const boot = (buddyOpen?: boolean) =>
    launchpadBoot({
      preset: "hosted-personal",
      machine: recorded,
      locale: "cs",
      catalog: { kind: "catalog", organizations: [] },
      entry: recorded.entry,
      tailnet: null,
      ...(buddyOpen === undefined ? {} : { buddyOpen }),
    });
  expect(boot(true).shell?.buddy).toEqual({ origin: buddyOrigin });
  for (const closed of [false, undefined])
    expect(Object.hasOwn(boot(closed).shell ?? {}, "buddy")).toBe(false);
  // The page learns he is here from the entry either way.
  expect(boot(false).entry?.buddyOrigin).toBe(buddyOrigin);
});

test("the setup's cache keeps Buddy's open beside the setup, from one reading", async () => {
  let open = false;
  const cache = createSetupCache(async () => ({
    setup: undefined,
    buddyOpen: open,
  }));
  expect(cache.peek()).toBeUndefined();
  await cache.settled();
  expect(cache.peek()).toEqual({ setup: undefined, buddyOpen: false });
  open = true;
  cache.forget();
  await cache.settled();
  expect(cache.peek()?.buddyOpen).toBe(true);
});
