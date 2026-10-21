import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import type { MachineEntry } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { launchpadSignInPage, startLaunchpad } from "../src/launchpad/server";
import type { AiReading } from "../src/tools/ai";
import type { AiProbe } from "../src/tools/ai-probe";
import type { SignInPage } from "../src/tools/login";
import { runTool } from "../src/tools/status";
import {
  codeOfPage,
  fakeAi,
  fakeAiClis,
  returnFromPage,
} from "./fixtures/fake-ai-clis";

// Začínáme's "Přihlásit ChatGPT" and "Přihlásit Claude" through the
// Launchpad (root decision 0201 points 3-6, F19's addendum of 2026-10-15):
// the same sessions as `lazurio tools login`, started, followed and ended
// behind the page's admission; the page shows the Environment browser's view
// in its right panel; a code of Claude's code page goes to the waiting CLI.

const posixTest = test.skipIf(process.platform === "win32");
const view =
  "https://browser.workspace.example.lazurio.io/t/0123456789ABCDEF0123456789ABCDEF";
type Json = Record<string, unknown>;

/** The AI as Codex and Claude answered it, and how often it was dropped. */
function aiProbe(reading: AiReading) {
  let forgotten = 0;
  const probe: AiProbe = {
    state: async () => reading,
    forget: () => {
      forgotten++;
    },
  };
  return { probe, forgotten: () => forgotten };
}

async function launchpad(
  options: Readonly<{
    signInPage?: SignInPage;
    reading?: AiReading;
    /** The Launchpad's own AI reading over the fake CLIs, kept a minute,
     * instead of a stub. */
    keptAi?: boolean;
  }> = {},
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "launchpad-ai-")));
  const home = join(parent, "home");
  const bin = await fakeAiClis(home);
  const folder = join(parent, "Lazurio");
  await initializeFolder(
    folder,
    presetProfile("local", executionOs(process.platform)),
  );
  const ai = aiProbe(
    options.reading ?? {
      state: "missing",
      providers: [
        { provider: "codex", state: "signed-out" },
        { provider: "claude", state: "signed-out" },
      ],
    },
  );
  const tools = {
    path: `${bin}:/usr/bin:/bin`,
    home,
    xdg: {},
    platform: process.platform,
    run: runTool,
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    tools,
    {
      login: {
        firstChallengeMs: 5_000,
        pageGraceMs: 200,
        ...(options.signInPage === undefined
          ? {}
          : { signInPage: options.signInPage }),
      },
    },
    // recovery, the module host, documents, content (host and reader), the
    // browser view, the vault, Executor, Integrace, the Organization's
    // settings, Nová karta and SSH: the defaults.
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.keptAi === true ? undefined : ai.probe,
  );
  const url = new URL(app.url);
  const headers = {
    Origin: url.origin,
    Authorization: `Bearer ${url.hash.slice(1)}`,
  };
  const get = async (route: string) => {
    const response = await fetch(new URL(route, url), { headers });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const post = async (route: string, body: unknown) => {
    const response = await fetch(new URL(route, url), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  return {
    home,
    get,
    post,
    forgotten: ai.forgotten,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function until(
  read: () => Promise<Json>,
  done: (value: Json) => boolean,
  ms = 10_000,
): Promise<Json> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Not reached: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

function environmentBrowser() {
  const opened: string[] = [];
  const page: SignInPage = {
    kind: "environment",
    open: async (url) => {
      opened.push(url);
      return { view };
    },
  };
  return { page, opened };
}

test("the Launchpad's sign-in page: its own browser on a workstation, the Environment browser where the entry routes it, none where not", async () => {
  const entry = {
    browserOrigin: "https://browser.workspace.example.lazurio.io",
    browserListenPort: 4848,
  } as unknown as MachineEntry;
  const asked: string[] = [];
  const opener = async (url: string) => {
    asked.push(url);
    return { view };
  };
  expect(launchpadSignInPage(null, () => opener)).toEqual({ kind: "own" });
  expect(
    launchpadSignInPage({} as unknown as MachineEntry, () => opener),
  ).toEqual({ kind: "none" });
  const page = launchpadSignInPage(entry, () => opener);
  if (page.kind !== "environment") throw new Error("Expected the browser");
  expect(await page.open("https://auth.openai.com/oauth/authorize")).toEqual({
    view,
  });
  expect(asked).toEqual(["https://auth.openai.com/oauth/authorize"]);
  // An opener that is not there opens nothing.
  const closed = launchpadSignInPage(entry, () => null);
  if (closed.kind !== "environment") throw new Error("Expected the browser");
  expect(await closed.open("https://auth.openai.com/oauth/authorize")).toBe(
    null,
  );
});

posixTest(
  "codex and claude only sign in through these routes; they are no catalog tools here",
  async () => {
    const opened = await launchpad();
    try {
      for (const route of [
        "/api/tools/install",
        "/api/tools/upgrade",
        "/api/tools/logout",
      ])
        for (const tool of ["codex", "claude"])
          expect(await opened.post(route, { tool })).toEqual({
            status: 409,
            body: { kind: "blocked", reason: "tool-unknown", tool },
          });
      expect(
        (
          await opened.post("/api/tools/login/start", {
            tool: "codex",
            phone: "+420123456789",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await opened.post("/api/tools/login/start", {
            tool: "claude",
            sshKey: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await opened.post("/api/tools/login/code", {
            tool: "claude",
            session: "nope",
            code: "a#b",
          })
        ).status,
      ).toBe(400);
      expect(
        await opened.post("/api/tools/login/code", {
          tool: "claude",
          session: "0".repeat(32),
          code: "a#b",
        }),
      ).toEqual({ status: 409, body: { error: "not-waiting" } });
    } finally {
      await opened.close();
    }
  },
  30_000,
);

posixTest(
  "on a Remote Environment the page opens in the Environment browser, the poll follows it to signed in, and the AI is read again",
  async () => {
    const browser = environmentBrowser();
    const opened = await launchpad({ signInPage: browser.page });
    try {
      const started = await opened.post("/api/tools/login/start", {
        tool: "codex",
      });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({
        kind: "pending",
        tool: "codex",
        challenge: { kind: "page", view, code: false },
      });
      expect(started.body.challenge).not.toHaveProperty("url");
      const session = started.body.session as string;
      const before = opened.forgotten();
      expect(await returnFromPage(browser.opened[0] as string)).toBe(200);
      const done = await until(
        async () =>
          (
            await opened.post("/api/tools/login/poll", {
              tool: "codex",
              session,
            })
          ).body,
        (value) => value.kind !== "pending",
      );
      // No Codex app-server unit and no T3 Code in this test's world.
      expect(done).toEqual({
        kind: "signed-in",
        tool: "codex",
        services: {
          appServer: { state: "not-managed" },
          t3: { state: "not-installed" },
        },
      });
      expect(opened.forgotten()).toBeGreaterThan(before);
    } finally {
      await opened.close();
    }
  },
  30_000,
);

posixTest(
  "Claude's code page: only a whole code, only while the sign-in waits for one, goes to the CLI",
  async () => {
    const browser = environmentBrowser();
    const opened = await launchpad({ signInPage: browser.page });
    await writeFile(join(opened.home, "claude.no-browser"), "");
    try {
      const started = await opened.post("/api/tools/login/start", {
        tool: "claude",
      });
      expect(started.body).toMatchObject({
        kind: "pending",
        challenge: { kind: "page", view, code: true },
      });
      const session = started.body.session as string;
      expect(
        await opened.post("/api/tools/login/code", {
          tool: "claude",
          session,
          code: "only-half",
        }),
      ).toEqual({ status: 400, body: { error: "invalid-code" } });
      expect(
        await opened.post("/api/tools/login/code", {
          tool: "codex",
          session,
          code: codeOfPage(browser.opened[0] as string),
        }),
      ).toEqual({ status: 409, body: { error: "not-waiting" } });
      expect(
        await opened.post("/api/tools/login/code", {
          tool: "claude",
          session,
          code: codeOfPage(browser.opened[0] as string),
        }),
      ).toEqual({
        status: 200,
        body: { kind: "code-accepted", tool: "claude" },
      });
      const done = await until(
        async () =>
          (
            await opened.post("/api/tools/login/poll", {
              tool: "claude",
              session,
            })
          ).body,
        (value) => value.kind !== "pending",
      );
      expect(done).toMatchObject({
        kind: "signed-in",
        tool: "claude",
        account: "person@example.com",
      });
    } finally {
      await opened.close();
    }
  },
  30_000,
);

posixTest(
  "nothing starts without the Environment browser, or where the Organization provides the AI",
  async () => {
    const none = await launchpad({ signInPage: { kind: "none" } });
    try {
      expect(
        await none.post("/api/tools/login/start", { tool: "claude" }),
      ).toEqual({
        status: 409,
        body: {
          kind: "blocked",
          tool: "claude",
          reason: "no-environment-browser",
        },
      });
    } finally {
      await none.close();
    }
    // Codex itself says its provider needs no OpenAI sign-in.
    const provided = await launchpad({ signInPage: environmentBrowser().page });
    await writeFile(join(provided.home, "codex.provided"), "");
    try {
      expect(
        await provided.post("/api/tools/login/start", { tool: "codex" }),
      ).toEqual({
        status: 409,
        body: {
          kind: "blocked",
          tool: "codex",
          reason: "organization-provided",
        },
      });
    } finally {
      await provided.close();
    }
  },
  30_000,
);

posixTest(
  "the AI reading kept for the page never decides: the start asks Codex afresh, after the Organization switched to its provider (Pablo's review of #441)",
  async () => {
    const browser = environmentBrowser();
    const opened = await launchpad({
      signInPage: browser.page,
      keptAi: true,
    });
    try {
      // The page read the AI: signed out, kept for a minute.
      expect((await opened.get("/api/ai")).body).toMatchObject({
        kind: "ai",
        state: "missing",
      });
      // Within that minute the Organization switches Codex to its provider;
      // the kept answer still says missing.
      await writeFile(join(opened.home, "codex.provided"), "");
      expect((await opened.get("/api/ai")).body).toMatchObject({
        state: "missing",
      });
      // The start asks Codex itself and refuses; `codex login` never runs.
      expect(
        await opened.post("/api/tools/login/start", { tool: "codex" }),
      ).toEqual({
        status: 409,
        body: {
          kind: "blocked",
          tool: "codex",
          reason: "organization-provided",
        },
      });
      expect(browser.opened).toEqual([]);
      const calls = (await readFile(join(opened.home, "codex.calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { args: string[] }).args[0]);
      expect(calls.length).toBeGreaterThan(1);
      expect(calls).not.toContain("login");
    } finally {
      await opened.close();
    }
  },
  30_000,
);

posixTest(
  "ChatGPT by code through the Launchpad (root decision 0201 point 10): `deviceCode` for codex only, without the Environment browser too; the page and the code go to the page that started it, never to the journal",
  async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(
      (...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      },
    );
    const opened = await launchpad({ signInPage: { kind: "none" } });
    try {
      // Any other tool, any other value, or beside a phone or a key: refused.
      for (const body of [
        { tool: "claude", deviceCode: true },
        { tool: "gh", deviceCode: true },
        { tool: "codex", deviceCode: "yes" },
        { tool: "codex", deviceCode: false },
        { tool: "codex", deviceCode: true, sshKey: true },
      ])
        expect(await opened.post("/api/tools/login/start", body)).toEqual({
          status: 400,
          body: { error: "invalid-device-code" },
        });
      const started = await opened.post("/api/tools/login/start", {
        tool: "codex",
        deviceCode: true,
      });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({
        kind: "pending",
        tool: "codex",
        challenge: {
          kind: "device-code",
          url: "https://auth.openai.com/codex/device",
          code: fakeAi.deviceCode,
        },
      });
      const session = started.body.session as string;
      // The person enters the code on OpenAI's page.
      await writeFile(join(opened.home, "codex.approve"), "");
      const done = await until(
        async () =>
          (
            await opened.post("/api/tools/login/poll", {
              tool: "codex",
              session,
            })
          ).body,
        (value) => value.kind !== "pending",
      );
      expect(done).toEqual({
        kind: "signed-in",
        tool: "codex",
        services: {
          appServer: { state: "not-managed" },
          t3: { state: "not-installed" },
        },
      });
      const journal = lines
        .filter((line) => line.includes('"scope":"tools-login"'))
        .map((line) => JSON.parse(line));
      expect(journal).toEqual([
        { scope: "tools-login", tool: "codex", event: "start" },
        {
          scope: "tools-login",
          tool: "codex",
          event: "end",
          outcome: "signed-in",
        },
      ]);
      expect(lines.some((line) => line.includes(fakeAi.deviceCode))).toBe(
        false,
      );
    } finally {
      log.mockRestore();
      await opened.close();
    }
  },
  30_000,
);
