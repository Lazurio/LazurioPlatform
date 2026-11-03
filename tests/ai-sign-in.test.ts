import { expect, test } from "bun:test";
import {
  aiSignInAfterReading,
  aiSignInAnswer,
  aiSignInPlace,
  createAiSignIn,
  createReadingOrder,
  takeAiReading,
} from "../src/launchpad/ai-sign-in";

// Začínáme's AI sign-in in the page (root decision 0201 points 3-6, F19's
// addendum of 2026-10-15): where its page opens, what each answer of the
// login routes means, and the flow over a fake server: the right panel opened
// on the Environment browser's tab once, the poll, the code, the cancel, and
// the AI read again once signed in.

const session = "0123456789abcdef0123456789abcdef";
const view =
  "https://browser.workspace.example.lazurio.io/t/0123456789ABCDEF0123456789ABCDEF";

test("the page opens in the panel on a Remote Environment with its browser, the computer's own browser without an entry, nowhere else", () => {
  expect(aiSignInPlace(null)).toBe("own");
  const entry = {
    launchpadOrigin: "https://launchpad.workspace.example.lazurio.io",
    t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
    moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
  };
  expect(aiSignInPlace(entry)).toBe("none");
  expect(
    aiSignInPlace({
      ...entry,
      browserOrigin: "https://browser.workspace.example.lazurio.io",
    }),
  ).toBe("panel");
});

test("each answer of the login routes, only in its known shape", () => {
  const pending = (extra: object) => ({
    kind: "pending",
    tool: "codex",
    session,
    expiresAt: "2026-10-15T20:00:00.000Z",
    ...extra,
  });
  expect(aiSignInAnswer("codex", pending({}))).toEqual({
    kind: "starting",
    tool: "codex",
    session,
  });
  expect(
    aiSignInAnswer(
      "codex",
      pending({ challenge: { kind: "page", view, code: false } }),
    ),
  ).toEqual({ kind: "waiting", tool: "codex", session, view, code: false });
  expect(aiSignInAnswer("codex", pending({ step: "services" }))).toEqual({
    kind: "finishing",
    tool: "codex",
    session,
  });
  // Neither or both of view and url, another kind, another tool, a bad
  // handle: no known shape.
  for (const value of [
    pending({ challenge: { kind: "page", code: false } }),
    pending({
      challenge: {
        kind: "page",
        view,
        url: "https://auth.openai.com/",
        code: false,
      },
    }),
    pending({ challenge: { kind: "page", view: "javascript:x", code: false } }),
    pending({ challenge: { kind: "url", url: view } }),
    { ...pending({}), tool: "claude" },
    { ...pending({}), session: "nope" },
    null,
  ])
    expect(aiSignInAnswer("codex", value)).toBeNull();
  expect(
    aiSignInAnswer("claude", {
      kind: "signed-in",
      tool: "claude",
      account: "person@example.com",
      services: { t3: { state: "driver-mismatch", mismatches: [{}] } },
    }),
  ).toEqual({
    kind: "signed-in",
    tool: "claude",
    services: { t3: { state: "driver-mismatch", mismatches: [] } },
  });
  // T3 Code answered without an enabled instance (Pablo's review of #441).
  expect(
    aiSignInAnswer("codex", {
      kind: "signed-in",
      tool: "codex",
      services: {
        appServer: { state: "restarted" },
        t3: {
          state: "failed",
          reason: "not-enabled",
          providers: ["codex", "x"],
        },
      },
    }),
  ).toEqual({
    kind: "signed-in",
    tool: "codex",
    services: {
      appServer: { state: "restarted" },
      t3: { state: "failed", reason: "not-enabled", providers: ["codex"] },
    },
  });
  // Codex could not say whether the Organization provides the AI.
  expect(
    aiSignInAnswer("codex", {
      kind: "failed",
      tool: "codex",
      reason: "provider-unknown",
    }),
  ).toEqual({ kind: "failed", tool: "codex", reason: "provider-unknown" });
  // The CLI is not on PATH: kept, so the step says it, not "try again".
  expect(
    aiSignInAnswer("claude", {
      kind: "failed",
      tool: "claude",
      reason: "not-installed",
    }),
  ).toEqual({ kind: "failed", tool: "claude", reason: "not-installed" });
  expect(
    aiSignInAnswer("codex", {
      kind: "failed",
      tool: "codex",
      reason: "browser-unavailable",
    }),
  ).toEqual({ kind: "failed", tool: "codex", reason: "browser-unavailable" });
  expect(
    aiSignInAnswer("codex", {
      kind: "failed",
      tool: "codex",
      reason: "tool-exit",
    }),
  ).toEqual({ kind: "failed", tool: "codex", reason: "failed" });
  expect(aiSignInAnswer("codex", { kind: "expired", tool: "codex" })).toEqual({
    kind: "failed",
    tool: "codex",
    reason: "expired",
  });
  expect(
    aiSignInAnswer("codex", {
      kind: "blocked",
      tool: "codex",
      reason: "organization-provided",
    }),
  ).toBe("organization-provided");
  expect(
    aiSignInAnswer("codex", {
      kind: "blocked",
      tool: "codex",
      reason: "no-environment-browser",
    }),
  ).toEqual({
    kind: "failed",
    tool: "codex",
    reason: "no-environment-browser",
  });
  expect(aiSignInAnswer("codex", { kind: "cancelled", tool: "codex" })).toEqual(
    { kind: "idle" },
  );
});

/** A fake Launchpad: answers by route, records every request. */
function server(
  answers: Record<string, (body: Record<string, unknown>) => unknown>,
) {
  const requests: [string, unknown][] = [];
  return {
    requests,
    post: async (path: string, body: unknown) => {
      requests.push([path, body]);
      const answer = answers[path]?.(body as Record<string, unknown>);
      return {
        value: answer,
        ok: !(
          typeof answer === "object" &&
          answer !== null &&
          "error" in answer
        ),
      };
    },
  };
}

async function until(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Not reached");
    await Bun.sleep(5);
  }
}

test("the flow: the panel on the Environment browser's tab once, the poll to signed in, and the AI read again", async () => {
  let polls = 0;
  const fake = server({
    "/api/tools/login/start": () => ({
      kind: "pending",
      tool: "codex",
      session,
      expiresAt: "x",
      challenge: { kind: "page", view, code: false },
    }),
    "/api/tools/login/poll": () =>
      ++polls < 3
        ? {
            kind: "pending",
            tool: "codex",
            session,
            expiresAt: "x",
            challenge: { kind: "page", view, code: false },
          }
        : {
            kind: "signed-in",
            tool: "codex",
            services: { t3: { state: "not-installed" } },
          },
  });
  const shown: string[] = [];
  let reads = 0;
  const signIn = createAiSignIn({
    post: fake.post,
    showView: (opened) => shown.push(opened),
    changed: () => undefined,
    readAi: () => {
      reads++;
    },
    pollMs: 5,
  });
  await signIn.start("codex");
  expect(signIn.state()).toEqual({
    kind: "waiting",
    tool: "codex",
    session,
    view,
    code: false,
  });
  await until(() => signIn.state().kind === "signed-in");
  // The panel opened once for the page, though every poll named it.
  expect(shown).toEqual([view]);
  expect(reads).toBe(1);
  // "Otevřít přihlášení" only while the page is open.
  signIn.reopen();
  expect(shown).toEqual([view]);
  expect(fake.requests.map(([path]) => path)).toEqual([
    "/api/tools/login/start",
    "/api/tools/login/poll",
    "/api/tools/login/poll",
    "/api/tools/login/poll",
  ]);
});

test("the code of Claude's code page, Zrušit, an Organization's AI and a Launchpad that does not answer", async () => {
  const waiting = {
    kind: "pending",
    tool: "claude",
    session,
    expiresAt: "x",
    challenge: { kind: "page", view, code: true },
  };
  const fake = server({
    "/api/tools/login/start": () => waiting,
    "/api/tools/login/poll": () => waiting,
    "/api/tools/login/code": (body) =>
      body.code === "code#state"
        ? { kind: "code-accepted", tool: "claude" }
        : { error: "invalid-code" },
    "/api/tools/login/cancel": () => ({ kind: "cancelled", tool: "claude" }),
  });
  const shown: string[] = [];
  const signIn = createAiSignIn({
    post: fake.post,
    showView: (opened) => shown.push(opened),
    changed: () => undefined,
    readAi: () => undefined,
    pollMs: 1_000,
  });
  await signIn.start("claude");
  signIn.reopen();
  expect(shown).toEqual([view, view]);
  await signIn.sendCode("half");
  expect(signIn.state()).toMatchObject({
    kind: "waiting",
    codeNote: "invalid",
  });
  await signIn.sendCode("code#state");
  expect(signIn.state()).toMatchObject({ kind: "waiting", codeNote: "sent" });
  await signIn.cancel();
  expect(signIn.state()).toEqual({ kind: "idle" });
  expect(fake.requests.at(-1)).toEqual([
    "/api/tools/login/cancel",
    { tool: "claude", session },
  ]);

  // The Organization provides the AI after all: read it again, idle.
  let reads = 0;
  const provided = createAiSignIn({
    post: server({
      "/api/tools/login/start": () => ({
        kind: "blocked",
        tool: "codex",
        reason: "organization-provided",
      }),
    }).post,
    showView: () => undefined,
    changed: () => undefined,
    readAi: () => {
      reads++;
    },
  });
  await provided.start("codex");
  expect(provided.state()).toEqual({ kind: "idle" });
  expect(reads).toBe(1);

  // No answer within the bound: failed, and the session is not left running.
  const silent = server({
    "/api/tools/login/start": () => ({
      kind: "pending",
      tool: "codex",
      session,
      expiresAt: "x",
    }),
    "/api/tools/login/poll": () => new Promise(() => undefined),
    "/api/tools/login/cancel": () => ({ kind: "cancelled", tool: "codex" }),
  });
  const hanging = createAiSignIn({
    post: async (path, body) =>
      path === "/api/tools/login/poll"
        ? new Promise(() => undefined)
        : silent.post(path, body),
    showView: () => undefined,
    changed: () => undefined,
    readAi: () => undefined,
    pollMs: 5,
    answerMs: 30,
  });
  await hanging.start("codex");
  expect(hanging.state()).toEqual({ kind: "starting", tool: "codex", session });
  await until(() => hanging.state().kind === "failed");
  expect(hanging.state()).toEqual({
    kind: "failed",
    tool: "codex",
    reason: "no-answer",
  });
  await until(() =>
    silent.requests.some(([path]) => path === "/api/tools/login/cancel"),
  );
  // Only ChatGPT and Claude.
  await hanging.start("gh");
  expect(hanging.state().kind).toBe("failed");
});

// ChatGPT's sign-in by code (root decision 0201 point 10, F19's addendum of
// 2026-10-21): "Přihlásit kódem" starts the same sessions with `deviceCode`,
// and the step shows the code and OpenAI's page for it.

const devicePage = "https://auth.openai.com/codex/device";
const deviceCode = "QX7P-4MZ2K";

test("an answer by code: only ChatGPT's, only OpenAI's exact page and a whole code", () => {
  const pending = (tool: string, challenge: object) => ({
    kind: "pending",
    tool,
    session,
    expiresAt: "2026-10-21T08:15:00.000Z",
    challenge,
  });
  expect(
    aiSignInAnswer(
      "codex",
      pending("codex", {
        kind: "device-code",
        url: devicePage,
        code: deviceCode,
      }),
    ),
  ).toEqual({
    kind: "by-code",
    tool: "codex",
    session,
    url: devicePage,
    code: deviceCode,
  });
  for (const [tool, challenge] of [
    ["claude", { kind: "device-code", url: devicePage, code: deviceCode }],
    [
      "codex",
      {
        kind: "device-code",
        url: "https://auth.openai.example/codex/device",
        code: deviceCode,
      },
    ],
    [
      "codex",
      { kind: "device-code", url: `${devicePage}?x=1`, code: deviceCode },
    ],
    [
      "codex",
      {
        kind: "device-code",
        url: "https://github.com/login/device",
        code: deviceCode,
      },
    ],
    ["codex", { kind: "device-code", url: devicePage, code: "QX7P 4MZ2K" }],
    ["codex", { kind: "device-code", url: devicePage, code: "\u001b[94mQX" }],
    ["codex", { kind: "device-code", url: devicePage }],
  ] as const)
    expect(aiSignInAnswer(tool, pending(tool, challenge))).toBeNull();
  // A sign-in by code that ends without signing in says it was by code, so
  // "Zkusit znovu" starts it by code again.
  expect(
    aiSignInAnswer("codex", { kind: "expired", tool: "codex" }, true),
  ).toEqual({ kind: "failed", tool: "codex", reason: "expired", byCode: true });
  expect(
    aiSignInAnswer(
      "codex",
      {
        kind: "pending",
        tool: "codex",
        session,
        expiresAt: "x",
      },
      true,
    ),
  ).toEqual({ kind: "starting", tool: "codex", session, byCode: true });
});

test("Přihlásit kódem: the start asks for the code, the step shows it until the code is entered, and nothing opens in the panel", async () => {
  let polls = 0;
  const waiting = {
    kind: "pending",
    tool: "codex",
    session,
    expiresAt: "2026-10-21T08:15:00.000Z",
    challenge: { kind: "device-code", url: devicePage, code: deviceCode },
  };
  const fake = server({
    "/api/tools/login/start": () => waiting,
    "/api/tools/login/poll": () =>
      ++polls < 3
        ? waiting
        : {
            kind: "signed-in",
            tool: "codex",
            services: { t3: { state: "not-installed" } },
          },
  });
  const shown: string[] = [];
  let reads = 0;
  const signIn = createAiSignIn({
    post: fake.post,
    showView: (opened) => shown.push(opened),
    changed: () => undefined,
    readAi: () => {
      reads++;
    },
    pollMs: 5,
  });
  await signIn.start("codex", { byCode: true });
  expect(signIn.state()).toEqual({
    kind: "by-code",
    tool: "codex",
    session,
    url: devicePage,
    code: deviceCode,
  });
  // "Otevřít přihlášení" has nothing to show: the page is the person's.
  signIn.reopen();
  await until(() => signIn.state().kind === "signed-in");
  expect(shown).toEqual([]);
  expect(reads).toBe(1);
  expect(fake.requests[0]).toEqual([
    "/api/tools/login/start",
    { tool: "codex", deviceCode: true },
  ]);

  // An expired code: "Zkusit znovu" knows it was by code.
  const expiring = createAiSignIn({
    post: server({
      "/api/tools/login/start": () => waiting,
      "/api/tools/login/poll": () => ({ kind: "expired", tool: "codex" }),
    }).post,
    showView: () => undefined,
    changed: () => undefined,
    readAi: () => undefined,
    pollMs: 5,
  });
  await expiring.start("codex", { byCode: true });
  await until(() => expiring.state().kind === "failed");
  expect(expiring.state()).toEqual({
    kind: "failed",
    tool: "codex",
    reason: "expired",
    byCode: true,
  });

  // Claude has no sign-in by code: nothing is asked.
  const none = server({});
  const claude = createAiSignIn({
    post: none.post,
    showView: () => undefined,
    changed: () => undefined,
    readAi: () => undefined,
  });
  await claude.start("claude", { byCode: true });
  expect(claude.state()).toEqual({ kind: "idle" });
  expect(none.requests).toEqual([]);
});

test("a fresh reading that finds the CLI drops the click's not installed, and nothing else (review of #827)", () => {
  const missing = {
    kind: "failed",
    tool: "claude",
    reason: "not-installed",
  } as const;
  const reading = (
    claude: "not-installed" | "signed-out" | "signed-in" | "unknown" | null,
  ) => ({
    state: "missing" as const,
    providers: [
      { provider: "codex" as const, state: "signed-out" as const },
      ...(claude === null
        ? []
        : [{ provider: "claude" as const, state: claude }]),
    ],
  });
  // Installed since the click: signed out or in, the sign-in is offered again.
  expect(aiSignInAfterReading(missing, reading("signed-out"))).toEqual({
    kind: "idle",
  });
  expect(aiSignInAfterReading(missing, reading("signed-in"))).toEqual({
    kind: "idle",
  });
  // Still missing, not known, not named or not read: the failure stays.
  for (const kept of [
    reading("not-installed"),
    reading("unknown"),
    reading(null),
    null,
  ])
    expect(aiSignInAfterReading(missing, kept)).toBe(missing);
  // Any other failure or state is not the reading's to change.
  const failed = { kind: "failed", tool: "claude", reason: "failed" } as const;
  expect(aiSignInAfterReading(failed, reading("signed-out"))).toBe(failed);
  const idle = { kind: "idle" } as const;
  expect(aiSignInAfterReading(idle, reading("signed-out"))).toBe(idle);
});

test("the controller settles a not installed on the fresh reading after it (review of #827)", async () => {
  const changes: string[] = [];
  const signIn = createAiSignIn({
    post: async () => ({
      value: { kind: "failed", tool: "claude", reason: "not-installed" },
      ok: false,
    }),
    showView: () => undefined,
    changed: () => changes.push(signIn.state().kind),
    readAi: () => undefined,
  });
  await signIn.start("claude");
  expect(signIn.state()).toEqual({
    kind: "failed",
    tool: "claude",
    reason: "not-installed",
  });
  const before = changes.length;
  const installed = {
    state: "missing",
    providers: [{ provider: "claude", state: "signed-out" }],
  } as const;
  // A reading that still says not installed changes nothing.
  signIn.settle(
    {
      state: "missing",
      providers: [{ provider: "claude", state: "not-installed" }],
    },
    signIn.mark(),
  );
  expect(changes.length).toBe(before);
  // Installed and read again after the failure: drawn without it.
  signIn.settle(installed, signIn.mark());
  expect(signIn.state()).toEqual({ kind: "idle" });
  expect(changes.at(-1)).toBe("idle");
});

test("a reading begun before the failure never settles it (review of #827)", async () => {
  const signIn = createAiSignIn({
    post: async () => ({
      value: { kind: "failed", tool: "claude", reason: "not-installed" },
      ok: false,
    }),
    showView: () => undefined,
    changed: () => undefined,
    readAi: () => undefined,
  });
  // "Zkontrolovat znovu" starts a reading while Claude Code is there ...
  const since = signIn.mark();
  // ... the CLI goes, and a click finds it missing before the reading ends.
  await signIn.start("claude");
  const missing = {
    kind: "failed",
    tool: "claude",
    reason: "not-installed",
  } as const;
  expect(signIn.state()).toEqual(missing);
  // The older reading, which still saw it installed, leaves the failure.
  signIn.settle(
    {
      state: "missing",
      providers: [{ provider: "claude", state: "signed-out" }],
    },
    since,
  );
  expect(signIn.state()).toEqual(missing);
});

test("the reading shown is the freshest that answered, whatever the order (review of #827)", () => {
  // Two "Zkontrolovat znovu": the first finds Claude missing but waits for
  // Codex, the second (after the install) ends first.
  let order = createReadingOrder();
  const first = order.ask(true);
  const second = order.ask(true);
  expect(order.take(second)).toBe(true);
  expect(order.take(first)).toBe(false);
  // A plain reading asked while a fresh one runs may get the server's kept
  // answer: shown while nothing fresher is, never over the fresh one, in
  // either order of answers.
  order = createReadingOrder();
  let fresh = order.ask(true);
  let plain = order.ask(false);
  expect(order.take(plain)).toBe(true);
  expect(order.take(fresh)).toBe(true);
  order = createReadingOrder();
  fresh = order.ask(true);
  plain = order.ask(false);
  expect(order.take(fresh)).toBe(true);
  expect(order.take(plain)).toBe(false);
  // A plain reading asked after the fresh one answered gets at least its
  // data, and is shown.
  expect(order.take(order.ask(false))).toBe(true);
  // Plain readings alone, as on the first load: each is shown.
  order = createReadingOrder();
  expect(order.take(order.ask(false))).toBe(true);
  expect(order.take(order.ask(false))).toBe(true);
});

test("a fresh reading overtaken by a plain one still settles the not installed (review of #827)", async () => {
  const signIn = createAiSignIn({
    post: async () => ({
      value: { kind: "failed", tool: "claude", reason: "not-installed" },
      ok: false,
    }),
    showView: () => undefined,
    changed: () => undefined,
    readAi: () => undefined,
  });
  await signIn.start("claude");
  const order = createReadingOrder();
  const installed = {
    state: "missing",
    providers: [{ provider: "claude", state: "signed-out" }],
  } as const;
  // Claude Code installed, then "Zkontrolovat znovu" (fresh) and, while it
  // runs, a return to Začínáme (a plain reading).
  const fresh = { reading: order.ask(true), since: signIn.mark() };
  const plain = { reading: order.ask(false), since: null };
  // The plain one answers first with the server's kept answer, from before
  // the install: shown for now, and it settles nothing.
  const kept = {
    state: "missing",
    providers: [{ provider: "claude", state: "not-installed" }],
  } as const;
  expect(takeAiReading(order, signIn, plain, kept)).toBe(true);
  expect(signIn.state()).toMatchObject({ reason: "not-installed" });
  // The fresh one answers last: it is shown over the kept answer and settles
  // the failure, so Claude's sign-in is offered again.
  expect(takeAiReading(order, signIn, fresh, installed)).toBe(true);
  expect(signIn.state()).toEqual({ kind: "idle" });
});
