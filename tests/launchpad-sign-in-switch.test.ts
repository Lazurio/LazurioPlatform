import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentsSwitch } from "../src/folder/enable-tool";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import { fakeLoginTools } from "./fixtures/fake-login-tools";

// The switch that follows a sign-in (F19's addendum of 2026-10-28) when two
// sign-ins of the same tool overlap (Pablo's review of #702): the first
// one's Folder change is still running when the second sign-in ends and its
// switch settles. Each answer waits for its own switch only, and a closing
// Launchpad waits for every switch under way. The curated sign-in's fake
// composio signs in once `approve` exists in its home; each switch here
// waits until the test lets it go.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

async function launchpad() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-switch-")),
  );
  const home = join(parent, "home");
  const path = await fakeLoginTools(home, ["composio"]);
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  const switches: { tool: string; release: () => void }[] = [];
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    {
      path,
      home,
      xdg: {
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CONFIG_HOME: join(home, ".config"),
      },
      platform: process.platform,
      run: runTool,
    },
    {
      login: { probeIntervalMs: 50 },
      switchOn: (_folder, tool) =>
        new Promise<AgentsSwitch>((resolve) => {
          switches.push({ tool, release: () => resolve({ kind: "on" }) });
        }),
    },
  );
  const url = new URL(app.url);
  const post = async (route: string, value: unknown) => {
    const response = await fetch(new URL(route, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(value),
    });
    return (await response.json()) as Json;
  };
  return {
    switches,
    post,
    app,
    approve: () => writeFile(join(home, "approve"), ""),
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(25);
  }
}

// The holder's polls until its sign-in is no longer pending.
async function outcome(
  opened: Awaited<ReturnType<typeof launchpad>>,
  started: Json,
): Promise<Json> {
  const deadline = Date.now() + 10_000;
  let state = started;
  while (state.kind === "pending") {
    if (Date.now() > deadline) throw new Error("Sign-in did not settle");
    await Bun.sleep(50);
    state = await opened.post("/api/tools/login/poll", {
      tool: "composio",
      session: started.session,
    });
  }
  return state;
}

test.skipIf(!posix)(
  "overlapping sign-ins of one tool: each answer waits for its own switch, never for the other's",
  async () => {
    const opened = await launchpad();
    try {
      const first = await opened.post("/api/tools/login/start", {
        tool: "composio",
      });
      expect(first).toMatchObject({ kind: "pending", tool: "composio" });
      await opened.approve();
      // The first sign-in ended; its switch is still running.
      await until(() => opened.switches.length === 1);
      let firstAnswer: Json | null = null;
      const firstPoll = opened
        .post("/api/tools/login/poll", {
          tool: "composio",
          session: first.session,
        })
        .then((value) => {
          firstAnswer = value;
        });
      await Bun.sleep(300);
      expect(firstAnswer).toBeNull();

      // A second sign-in ends meanwhile (the approval holds) and its own
      // switch settles at once: its answer comes without the first switch.
      const secondStart = opened.post("/api/tools/login/start", {
        tool: "composio",
      });
      await until(() => opened.switches.length === 2);
      opened.switches[1]?.release();
      expect(await outcome(opened, await secondStart)).toMatchObject({
        kind: "signed-in",
        tool: "composio",
      });
      expect(firstAnswer).toBeNull();

      // The first answer comes once its own switch settled.
      opened.switches[0]?.release();
      await firstPoll;
      expect(firstAnswer).toMatchObject({
        kind: "signed-in",
        tool: "composio",
      });
    } finally {
      for (const each of opened.switches) each.release();
      await opened.app.close();
      await opened.cleanup();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "a closing Launchpad waits for every switch under way, also one that another sign-in of the tool overtook",
  async () => {
    const opened = await launchpad();
    let closed = false;
    try {
      const first = await opened.post("/api/tools/login/start", {
        tool: "composio",
      });
      await opened.approve();
      await until(() => opened.switches.length === 1);
      // Nobody polls the first sign-in. A second one ends and its switch
      // settles while the first switch still runs.
      const secondStart = opened.post("/api/tools/login/start", {
        tool: "composio",
      });
      await until(() => opened.switches.length === 2);
      opened.switches[1]?.release();
      expect(await outcome(opened, await secondStart)).toMatchObject({
        kind: "signed-in",
      });
      // The second start replaced the first outcome (one per tool): its
      // holder reads none, never an answer tied to the second switch.
      expect(
        await opened.post("/api/tools/login/poll", {
          tool: "composio",
          session: first.session,
        }),
      ).toEqual({ kind: "none", tool: "composio" });

      const closing = opened.app.close().then(() => {
        closed = true;
      });
      await Bun.sleep(500);
      expect(closed).toBe(false);
      opened.switches[0]?.release();
      await closing;
      expect(closed).toBe(true);
    } finally {
      for (const each of opened.switches) each.release();
      if (!closed) await opened.app.close();
      await opened.cleanup();
    }
  },
  20_000,
);
