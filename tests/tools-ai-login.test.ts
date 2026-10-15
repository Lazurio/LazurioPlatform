import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiServices } from "../src/tools/ai-services";
import {
  createLoginSessions,
  type LoginEnvironment,
  type LoginJournalEntry,
  type LoginState,
  type SignInPage,
} from "../src/tools/login";
import {
  createPageCapture,
  openedView,
  returnsToCli,
  signInCode,
  signInPageOf,
} from "../src/tools/sign-in-page";
import { runTool } from "../src/tools/status";
import {
  codeOfPage,
  fakeAi,
  fakeAiClis,
  returnFromPage,
} from "./fixtures/fake-ai-clis";

// `lazurio tools login codex|claude` (root decision 0201 points 3-6, F19's
// addendum of 2026-10-15) over fake CLIs that sign in as the real ones do on
// a headless Linux: the page they open through `BROWSER`, its return to the
// CLI on 127.0.0.1, Claude's code page and its code on the CLI's input, and
// the CLIs' own status as the confirmation.

const posix = process.platform !== "win32";
const posixTest = test.skipIf(!posix);
const view =
  "https://browser.workspace.example.lazurio.io/t/0123456789ABCDEF0123456789ABCDEF";

async function scratch(
  clis: readonly ("codex" | "claude")[] = ["codex", "claude"],
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "lazurio-ai-")));
  const bin = await fakeAiClis(home, clis);
  return {
    home,
    path: `${bin}:/usr/bin:/bin`,
    close: () => rm(home, { recursive: true, force: true }),
  };
}

/** The Environment browser of a Remote Environment: what it was asked to
 * open, and whether it opens it. */
function environmentBrowser(opens = true) {
  const opened: string[] = [];
  const page: SignInPage = {
    kind: "environment",
    open: async (url) => {
      opened.push(url);
      return opens ? { view } : null;
    },
  };
  return { page, opened };
}

function sessionsFor(
  scratchHome: Awaited<ReturnType<typeof scratch>>,
  extra: Partial<LoginEnvironment> = {},
) {
  const journal: LoginJournalEntry[] = [];
  const reloads: unknown[] = [];
  const services: AiServices = { t3: { state: "not-installed" } };
  const environment: LoginEnvironment = {
    path: scratchHome.path,
    home: scratchHome.home,
    xdg: {},
    platform: process.platform,
    run: runTool,
    firstChallengeMs: 5_000,
    pageGraceMs: 300,
    journal: (entry) => journal.push(entry),
    reload: async (tool, signedIn) => {
      reloads.push([tool, signedIn]);
      return services;
    },
    ...extra,
  };
  return { sessions: createLoginSessions(environment), journal, reloads };
}

async function settle(
  sessions: ReturnType<typeof createLoginSessions>,
  tool: string,
  handle: string,
  limitMs = 10_000,
): Promise<LoginState> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    await sessions.changed(tool, handle, 100);
    const state = sessions.poll(tool, handle);
    if (state.kind !== "pending") return state;
    if (Date.now() > deadline) throw new Error("Session did not settle");
  }
}

async function calls(home: string, cli: string) {
  try {
    return (await readFile(join(home, `${cli}.calls`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; browser: string });
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(25);
  }
}

async function gone(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    () => true,
  );
}

test("the official sign-in pages, their return and Claude's code", () => {
  expect(
    signInPageOf("codex", "https://auth.openai.com/oauth/authorize?state=x"),
  ).toBe("https://auth.openai.com/oauth/authorize?state=x");
  expect(signInPageOf("claude", "https://claude.com/cai/oauth/authorize")).toBe(
    "https://claude.com/cai/oauth/authorize",
  );
  for (const [tool, page] of [
    ["codex", "https://auth.openai.com.evil.example/oauth/authorize"],
    ["codex", "http://auth.openai.com/oauth/authorize"],
    ["codex", "https://claude.com/cai/oauth/authorize"],
    ["claude", "https://auth.openai.com/oauth/authorize"],
    ["claude", "https://user@claude.com/cai/oauth/authorize"],
    ["claude", "https://claude.com:8443/cai/oauth/authorize"],
    ["claude", "javascript:alert(1)"],
  ] as const)
    expect([tool, page, signInPageOf(tool, page)]).toEqual([
      tool,
      page,
      undefined,
    ]);
  const page = (redirect: string) =>
    `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(redirect)}`;
  expect(returnsToCli(page("http://localhost:43123/callback"))).toBe(true);
  expect(returnsToCli(page("http://127.0.0.1:1455/auth/callback"))).toBe(true);
  expect(
    returnsToCli(page("https://platform.claude.com/oauth/code/callback")),
  ).toBe(false);
  expect(returnsToCli(page("http://evil.example/callback"))).toBe(false);
  expect(returnsToCli("https://claude.com/cai/oauth/authorize")).toBe(false);
  expect(signInCode("  abc-DEF_1#st.ate~2 ")).toBe("abc-DEF_1#st.ate~2");
  for (const bad of [
    "abc",
    "#state",
    "code#",
    "a#b#c",
    "a b#c",
    "a#b\nextra#line",
    "x".repeat(4097),
    42,
  ])
    expect(signInCode(bad)).toBeUndefined();
});

test("the browser CLI's answer of `browser open` gives the link, nothing else", () => {
  const answer = {
    schema: "lazurio.browser-cli.v1",
    kind: "browser-open",
    session: null,
    targetId: "0123456789ABCDEF0123456789ABCDEF",
    link: view,
  };
  expect(openedView({ code: 0, stdout: JSON.stringify(answer) })).toEqual({
    view,
  });
  expect(openedView({ code: 10, stdout: JSON.stringify(answer) })).toBeNull();
  expect(
    openedView({
      code: 0,
      stdout: JSON.stringify({ ...answer, kind: "browser-link" }),
    }),
  ).toBeNull();
  expect(
    openedView({
      code: 0,
      stdout: JSON.stringify({ ...answer, link: "javascript:x" }),
    }),
  ).toBeNull();
  expect(openedView({ code: 0, stdout: "not json" })).toBeNull();
  expect(openedView({ code: 0 })).toBeNull();
});

posixTest(
  "the stand-in for a browser keeps each page it is given, privately, until it is removed",
  async () => {
    const capture = await createPageCapture();
    try {
      expect((await stat(capture.directory)).mode & 0o777).toBe(0o700);
      expect(await capture.pages()).toEqual([]);
      const handed = Bun.spawnSync([
        capture.browser,
        "https://auth.openai.com/oauth/authorize?state=x",
      ]);
      expect(handed.exitCode).toBe(0);
      // Nothing to open without an address.
      expect(Bun.spawnSync([capture.browser]).exitCode).toBe(1);
      expect(await capture.pages()).toEqual([
        "https://auth.openai.com/oauth/authorize?state=x",
      ]);
      expect((await stat(join(capture.directory, "pages"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await capture.close();
    }
    expect(await gone(capture.directory)).toBe(true);
  },
);

posixTest(
  "codex on a Remote Environment: BROWSER hands its page over, it opens in the Environment browser, and the return to the CLI signs it in",
  async () => {
    const opened = await scratch(["codex"]);
    const browser = environmentBrowser();
    const { sessions, journal, reloads } = sessionsFor(opened, {
      signInPage: browser.page,
    });
    try {
      const started = await sessions.start("codex");
      if (started.kind !== "pending") throw new Error("Expected pending");
      // The Environment browser's view: never the page itself.
      expect(started.challenge).toEqual({ kind: "page", view, code: false });
      expect(browser.opened).toHaveLength(1);
      const page = browser.opened[0] as string;
      expect(new URL(page).hostname).toBe("auth.openai.com");
      expect(returnsToCli(page)).toBe(true);
      // `codex login`, never its device code, with BROWSER the stand-in.
      const [call] = await calls(opened.home, "codex");
      expect(call?.args).toEqual(["login"]);
      expect(call?.browser).toMatch(/lazurio-sign-in-[^/]+\/browser$/);
      // The person signs in; the page returns to the CLI here.
      expect(await returnFromPage(page)).toBe(200);
      const done = await settle(sessions, "codex", started.session);
      expect(done).toEqual({
        kind: "signed-in",
        tool: "codex",
        services: { t3: { state: "not-installed" } },
      });
      // T3 Code is asked about the AI CLIs signed in now: Claude is not here.
      expect(reloads).toEqual([["codex", ["codex"]]]);
      // The stand-in is gone with the session.
      await waitFor(() =>
        gone(String(call?.browser).replace(/\/browser$/, "")),
      );
      expect(journal).toEqual([
        { tool: "codex", event: "start" },
        { tool: "codex", event: "end", outcome: "signed-in" },
      ]);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "claude on a Remote Environment: its automatic page, which returns to the CLI, opens, never the printed code page",
  async () => {
    const opened = await scratch();
    const browser = environmentBrowser();
    const { sessions, reloads } = sessionsFor(opened, {
      signInPage: browser.page,
      // Long enough that only the page handed over can be the one opened.
      pageGraceMs: 5_000,
    });
    try {
      const started = await sessions.start("claude");
      if (started.kind !== "pending") throw new Error("Expected pending");
      expect(started.challenge).toEqual({ kind: "page", view, code: false });
      const page = browser.opened[0] as string;
      expect(new URL(page).hostname).toBe("claude.com");
      expect(new URL(page).searchParams.get("redirect_uri")).toMatch(
        /^http:\/\/localhost:\d+\/callback$/,
      );
      // No code goes to a page that returns by itself.
      expect(sessions.code("claude", started.session, codeOfPage(page))).toBe(
        "not-waiting",
      );
      expect(await returnFromPage(page)).toBe(200);
      const done = await settle(sessions, "claude", started.session);
      expect(done).toEqual({
        kind: "signed-in",
        tool: "claude",
        account: fakeAi.email,
        organization: fakeAi.organization,
        services: { t3: { state: "not-installed" } },
      });
      expect(reloads).toEqual([["claude", ["claude"]]]);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "a CLI that hands over no page: after the grace its printed code page opens, and the code goes to the waiting CLI",
  async () => {
    const opened = await scratch(["claude"]);
    await writeFile(join(opened.home, "claude.no-browser"), "");
    const browser = environmentBrowser();
    const { sessions } = sessionsFor(opened, { signInPage: browser.page });
    try {
      const started = await sessions.start("claude");
      if (started.kind !== "pending") throw new Error("Expected pending");
      expect(started.challenge).toEqual({ kind: "page", view, code: true });
      const page = browser.opened[0] as string;
      expect(new URL(page).searchParams.get("redirect_uri")).toBe(
        "https://platform.claude.com/oauth/code/callback",
      );
      // Only a whole code, only while the session waits for one.
      expect(sessions.code("claude", started.session, "abc")).toBe(
        "invalid-code",
      );
      expect(sessions.code("claude", "0".repeat(32), codeOfPage(page))).toBe(
        "not-waiting",
      );
      expect(sessions.code("claude", started.session, codeOfPage(page))).toBe(
        "accepted",
      );
      const done = await settle(sessions, "claude", started.session);
      expect(done.kind).toBe("signed-in");
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "a wrong code ends the sign-in as the CLI ends it",
  async () => {
    const opened = await scratch(["claude"]);
    await writeFile(join(opened.home, "claude.no-browser"), "");
    const { sessions } = sessionsFor(opened, {
      signInPage: environmentBrowser().page,
    });
    try {
      const started = await sessions.start("claude");
      if (started.kind !== "pending") throw new Error("Expected pending");
      expect(sessions.code("claude", started.session, "wrong-code#state")).toBe(
        "accepted",
      );
      expect(await settle(sessions, "claude", started.session)).toEqual({
        kind: "failed",
        tool: "claude",
        reason: "tool-exit",
      });
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "on a computer of one's own nothing is set: the CLI opens its browser, and the printed page is offered beside it",
  async () => {
    const opened = await scratch();
    const { sessions } = sessionsFor(opened);
    try {
      const codex = await sessions.start("codex");
      if (codex.kind !== "pending" || codex.challenge?.kind !== "page")
        throw new Error("Expected a page");
      const page = codex.challenge.url as string;
      expect(codex.challenge).toEqual({ kind: "page", url: page, code: false });
      expect(new URL(page).hostname).toBe("auth.openai.com");
      const [call] = await calls(opened.home, "codex");
      expect(call).toEqual({ args: ["login"], browser: null });
      expect(await returnFromPage(page)).toBe(200);
      expect((await settle(sessions, "codex", codex.session)).kind).toBe(
        "signed-in",
      );
      // Claude prints its code page: offered with the code's field.
      const claude = await sessions.start("claude");
      if (claude.kind !== "pending" || claude.challenge?.kind !== "page")
        throw new Error("Expected a page");
      expect(claude.challenge.code).toBe(true);
      expect(claude.challenge.view).toBeUndefined();
      expect(
        new URL(claude.challenge.url as string).searchParams.get(
          "redirect_uri",
        ),
      ).toBe("https://platform.claude.com/oauth/code/callback");
      sessions.cancel("claude", claude.session);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "the T3 refresh names every AI CLI signed in now",
  async () => {
    const opened = await scratch();
    await mkdir(join(opened.home, ".claude"), { recursive: true });
    await writeFile(join(opened.home, ".claude", ".credentials.json"), "{}");
    const browser = environmentBrowser();
    const { sessions, reloads } = sessionsFor(opened, {
      signInPage: browser.page,
    });
    try {
      const started = await sessions.start("codex");
      if (started.kind !== "pending") throw new Error("Expected pending");
      await returnFromPage(browser.opened[0] as string);
      expect((await settle(sessions, "codex", started.session)).kind).toBe(
        "signed-in",
      );
      expect(reloads).toEqual([["codex", ["codex", "claude"]]]);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "nothing starts on a Remote Environment without its Environment browser, or where the Organization provides the AI",
  async () => {
    const opened = await scratch();
    const asked: string[] = [];
    const { sessions, journal } = sessionsFor(opened, {
      signInPage: { kind: "none" },
    });
    const provided = sessionsFor(opened, {
      signInPage: environmentBrowser().page,
      organizationProvides: async (tool) => {
        asked.push(tool);
        return tool === "codex";
      },
    });
    try {
      for (const tool of ["codex", "claude"])
        expect(await sessions.start(tool)).toEqual({
          kind: "blocked",
          tool,
          reason: "no-environment-browser",
        });
      expect(await provided.sessions.start("codex")).toEqual({
        kind: "blocked",
        tool: "codex",
        reason: "organization-provided",
      });
      expect(asked).toEqual(["codex"]);
      // Neither CLI ran.
      expect(await calls(opened.home, "codex")).toEqual([]);
      expect(await calls(opened.home, "claude")).toEqual([]);
      expect(journal).toEqual([
        { tool: "codex", event: "start" },
        {
          tool: "codex",
          event: "end",
          outcome: "blocked",
          reason: "no-environment-browser",
        },
        { tool: "claude", event: "start" },
        {
          tool: "claude",
          event: "end",
          outcome: "blocked",
          reason: "no-environment-browser",
        },
      ]);
    } finally {
      await sessions.close();
      await provided.sessions.close();
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "a page on another host is never opened, and an Environment browser that does not open it stops the CLI",
  async () => {
    const opened = await scratch(["codex"]);
    try {
      await writeFile(join(opened.home, "codex.page"), "");
      const foreign = environmentBrowser();
      const first = sessionsFor(opened, { signInPage: foreign.page });
      expect(await first.sessions.start("codex")).toEqual({
        kind: "failed",
        tool: "codex",
        reason: "unexpected-url",
      });
      expect(foreign.opened).toEqual([]);
      const pid = Number(
        await readFile(join(opened.home, "codex.pid"), "utf8"),
      );
      await waitFor(() => !alive(pid));
      await first.sessions.close();
      await rm(join(opened.home, "codex.page"));
      const refusing = environmentBrowser(false);
      const second = sessionsFor(opened, { signInPage: refusing.page });
      expect(await second.sessions.start("codex")).toEqual({
        kind: "failed",
        tool: "codex",
        reason: "browser-unavailable",
      });
      expect(refusing.opened).toHaveLength(1);
      const next = Number(
        await readFile(join(opened.home, "codex.pid"), "utf8"),
      );
      await waitFor(() => !alive(next));
      await second.sessions.close();
    } finally {
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "a CLI that ends without its sign-in fails, and so does one whose status does not confirm it",
  async () => {
    const opened = await scratch(["codex"]);
    try {
      await writeFile(join(opened.home, "codex.fail"), "");
      const first = sessionsFor(opened, {
        signInPage: environmentBrowser().page,
      });
      expect(await first.sessions.start("codex")).toEqual({
        kind: "failed",
        tool: "codex",
        reason: "tool-exit",
      });
      await first.sessions.close();
      await rm(join(opened.home, "codex.fail"));
      await writeFile(join(opened.home, "codex.unconfirmed"), "");
      const browser = environmentBrowser();
      const second = sessionsFor(opened, { signInPage: browser.page });
      const started = await second.sessions.start("codex");
      if (started.kind !== "pending") throw new Error("Expected pending");
      await returnFromPage(browser.opened[0] as string);
      expect(await settle(second.sessions, "codex", started.session)).toEqual({
        kind: "failed",
        tool: "codex",
        reason: "not-confirmed",
      });
      expect(second.reloads).toEqual([]);
      await second.sessions.close();
    } finally {
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "cancel ends the CLI and removes the stand-in; nothing of the page or the code stays in a file",
  async () => {
    const opened = await scratch();
    await writeFile(join(opened.home, "claude.no-browser"), "");
    const browser = environmentBrowser();
    const { sessions, journal } = sessionsFor(opened, {
      signInPage: browser.page,
    });
    try {
      const started = await sessions.start("claude");
      if (started.kind !== "pending") throw new Error("Expected pending");
      const page = browser.opened[0] as string;
      const pid = Number(
        await readFile(join(opened.home, "claude.pid"), "utf8"),
      );
      const [call] = await calls(opened.home, "claude");
      const directory = String(call?.browser).replace(/\/browser$/, "");
      expect(sessions.cancel("claude", started.session)).toEqual({
        kind: "cancelled",
        tool: "claude",
      });
      await waitFor(() => !alive(pid));
      await waitFor(() => gone(directory));
      // Neither the page's state nor a code is in any file here but the
      // fake CLI's own record of its call.
      const state = new URL(page).searchParams.get("state") as string;
      const walk = async (current: string): Promise<string[]> =>
        (
          await Promise.all(
            (
              await readdir(current, { withFileTypes: true })
            ).map((entry) =>
              entry.isDirectory()
                ? walk(join(current, entry.name))
                : [join(current, entry.name)],
            ),
          )
        ).flat();
      for (const file of await walk(opened.home))
        expect([file, (await readFile(file, "utf8")).includes(state)]).toEqual([
          file,
          false,
        ]);
      expect(JSON.stringify(journal).includes(state)).toBe(false);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
  20_000,
);
