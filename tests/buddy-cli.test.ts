import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuddyContext, runBuddyCommand } from "../src/buddy/cli";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { codexDevicePage } from "../src/tools/ai";
import type { CliContext } from "../src/update/cli";
import {
  type FakeHermesGateway,
  fakeHermesGateway,
  recorded,
} from "./fixtures/fake-hermes-gateway";
import { personalWithEntry } from "./fixtures/machine-bindings";

// Decision F63: `lazurio buddy status`, `sign-in start` and `sign-out` on the
// Launchpad's core, for an operator on the Environment: JSON on stdout, the
// sign-in held by the terminal as `lazurio tools login` holds it, Ctrl-C
// cancelling it on Hermes, and nothing without Buddy's recorded origin.

const posix = test.skipIf(process.platform === "win32");

async function folderOf(parent: string, buddy: boolean) {
  const folder = join(parent, buddy ? "Lazurio" : "Lazurio-without-buddy");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset: "hosted-personal",
    machine: personalWithEntry(20999, false, false, buddy),
    profile: presetProfile("hosted-personal", executionOs(process.platform), {
      locale: "en",
    }),
  });
  return folder;
}

async function within(
  body: (
    fake: FakeHermesGateway,
    run: (
      args: string[],
      extra?: Partial<BuddyContext>,
    ) => ReturnType<typeof runBuddyCommand>,
    folders: { buddy: string; without: string },
  ) => Promise<void>,
  options: Parameters<typeof fakeHermesGateway>[0] = {},
) {
  const fake = await fakeHermesGateway(options);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "buddy-cli-")));
  try {
    const folders = {
      buddy: await folderOf(parent, true),
      without: await folderOf(parent, false),
    };
    const context: BuddyContext = {
      identity: {} as CliContext["identity"],
      platform: process.platform,
      env: { HOME: fake.userHome, PATH: "/usr/bin:/bin" },
      executable: "/usr/local/bin/lazurio",
    };
    await body(
      fake,
      (args, extra = {}) => runBuddyCommand(args, { ...context, ...extra }),
      folders,
    );
  } finally {
    await fake.close();
    await rm(parent, { recursive: true, force: true });
  }
}

posix("lazurio buddy status: the Launchpad's answer and its exit", () =>
  within(async (fake, run, folders) => {
    const status = ["status", "--folder", folders.buddy, "--json"];
    expect(await run(status)).toEqual({
      code: 10,
      stdout: JSON.stringify({
        kind: "buddy",
        state: "waits",
        signIn: { state: "none" },
        locale: "en",
      }),
    });
    fake.state.signedIn = true;
    expect(await run(status)).toEqual({
      code: 0,
      stdout: JSON.stringify({
        kind: "buddy",
        state: "works",
        signIn: { state: "connected" },
        locale: "en",
      }),
    });
    expect(
      await run(["status", "--folder", folders.without, "--json"]),
    ).toEqual({
      code: 10,
      stdout: '{"kind":"blocked","reason":"buddy-absent"}',
    });
    await fake.stop();
    expect(await run(status)).toEqual({
      code: 1,
      stdout: JSON.stringify({
        kind: "buddy",
        state: "unknown",
        reason: "not-running",
        signIn: { state: "unknown" },
        locale: "en",
      }),
    });
  }),
);

posix(
  "lazurio buddy sign-in start: the code at once, then each change on its own line until Buddy is signed in",
  () =>
    within(async (fake, run, folders) => {
      const lines: string[] = [];
      const done = run(["sign-in", "start", "--folder", folders.buddy], {
        pollMs: 20,
        write: (line) => {
          lines.push(line);
          // The person enters the code once it is shown.
          if (lines.length === 1)
            setTimeout(() => fake.approve("Fixture_Session_000001"), 60);
        },
      });
      expect(await done).toEqual({ code: 0, stdout: "" });
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        {
          kind: "pending",
          session: expect.stringMatching(/^[0-9a-f]{32}$/),
          code: recorded.http.start.body.user_code,
          url: codexDevicePage,
          expiresAt: expect.any(String),
          pollMs: 2000,
        },
        { kind: "signed-in" },
      ]);
      // Never Hermes's session or a ticket on stdout.
      for (const secret of ["Fixture_Session_000001", ...fake.spent])
        expect(lines.join("\n")).not.toContain(secret);
    }),
);

posix("Ctrl-C cancels the sign-in on Hermes", () =>
  within(async (fake, run, folders) => {
    const interrupt = new AbortController();
    const lines: string[] = [];
    const answer = await run(["sign-in", "start", "--folder", folders.buddy], {
      pollMs: 20,
      signal: interrupt.signal,
      write: (line) => {
        lines.push(line);
        if (lines.length === 1) setTimeout(() => interrupt.abort(), 50);
      },
    });
    expect(answer).toEqual({ code: 1, stdout: "" });
    expect(JSON.parse(lines.at(-1) as string)).toEqual({ kind: "cancelled" });
    expect(fake.sessions.size).toBe(0);
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
  }),
);

posix(
  "Ctrl-C while Hermes does not confirm the cancel says so: the sign-in may still complete",
  () =>
    within(async (fake, run, folders) => {
      const interrupt = new AbortController();
      const lines: string[] = [];
      fake.state.http = (request) =>
        request.method === "DELETE"
          ? Response.json({ detail: "Internal Server Error" }, { status: 500 })
          : undefined;
      const answer = await run(
        ["sign-in", "start", "--folder", folders.buddy],
        {
          pollMs: 20,
          signal: interrupt.signal,
          write: (line) => {
            lines.push(line);
            if (lines.length === 1) setTimeout(() => interrupt.abort(), 50);
          },
        },
      );
      expect(answer).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "Buddy's sign-in could not be cancelled and may still finish. Try again.",
      });
      expect(JSON.parse(lines.at(-1) as string)).toEqual({
        kind: "blocked",
        reason: "sign-in-running",
      });
      expect(fake.sessions.size).toBe(1);
    }),
);

posix(
  "where Buddy's Hermes does not keep the cancellation contract, sign-in start says in words that he needs an update; status and sign-out still work",
  () =>
    within(
      async (fake, run, folders) => {
        const lines: string[] = [];
        expect(
          await run(["sign-in", "start", "--folder", folders.buddy], {
            write: (line) => lines.push(line),
          }),
        ).toEqual({
          code: 1,
          stdout: "",
          stderr: "Buddy needs an update before he can be signed in here.",
        });
        expect(lines.map((line) => JSON.parse(line))).toEqual([
          { kind: "blocked", reason: "hermes-outdated" },
        ]);
        expect(
          fake.requests.filter((request) => request.path.endsWith("/start")),
        ).toHaveLength(0);
        expect(
          (await run(["status", "--folder", folders.buddy, "--json"])).code,
        ).toBe(0);
        expect(await run(["sign-out", "--folder", folders.buddy])).toEqual({
          code: 0,
          stdout: '{"kind":"signed-out"}',
        });
      },
      { contract: false, signedIn: true },
    ),
);

posix(
  "lazurio buddy sign-out, and both without Buddy's gateway or without Buddy here",
  () =>
    within(async (fake, run, folders) => {
      fake.state.signedIn = true;
      expect(await run(["sign-out", "--folder", folders.buddy])).toEqual({
        code: 0,
        stdout: '{"kind":"signed-out"}',
      });
      expect(fake.state.signedIn).toBe(false);
      expect(
        await run(["sign-in", "start", "--folder", folders.without]),
      ).toEqual({
        code: 10,
        stdout: '{"kind":"blocked","reason":"buddy-absent"}',
      });
      expect(fake.requests).toHaveLength(1);
      await fake.stop();
      const lines: string[] = [];
      expect(
        await run(["sign-in", "start", "--folder", folders.buddy], {
          write: (line) => lines.push(line),
        }),
      ).toEqual({ code: 1, stdout: "" });
      expect(lines).toEqual(['{"kind":"unavailable","reason":"no-socket"}']);
      expect(await run(["sign-out", "--folder", folders.buddy])).toEqual({
        code: 1,
        stdout: '{"kind":"unavailable","reason":"no-socket"}',
      });
    }),
);

posix("a wrong command line is usage", () =>
  within(async (fake, run, folders) => {
    for (const args of [
      ["sign-in"],
      ["sign-in", "poll"],
      ["sign-in", "cancel"],
      ["sign-in", "start", "now"],
      ["status", "--apply"],
      ["sign-out", "--apply"],
      ["status", "--folder", "Lazurio"],
      ["status", "--json", "--json"],
      ["sign-out", "now"],
    ])
      expect((await run([...args, "--folder", folders.buddy])).code).toBe(2);
    expect(fake.control).toHaveLength(0);
  }),
);
