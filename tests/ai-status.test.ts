import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type AiProviderReading,
  aiState,
  claudeReading,
  codexReading,
  parseAiAnswer,
} from "../src/tools/ai";
import {
  type Converse,
  converse,
  createAiProbe,
  readAi,
} from "../src/tools/ai-probe";
import { runTool, type ToolRunner } from "../src/tools/status";

// The Environment's AI (root decision 0201 points 1, 3 and 6): Codex says it
// through its app-server's `account/read`, Claude Code through `claude auth
// status --json`; an Organization's AI pool is a Codex provider that needs
// no OpenAI sign-in. The pure rules, the probe over fake processes and over
// fake CLIs, and `GET /api/ai`.

const posixTest = test.skipIf(process.platform === "win32");

test("Codex's account/read: an account works, a provider without OpenAI sign-in is the Organization's", () => {
  expect(
    codexReading({
      account: { type: "chatgpt", email: "a@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    }),
  ).toEqual({
    provider: "codex",
    state: "signed-in",
    method: "chatgpt",
    account: "a@example.com",
  });
  expect(
    codexReading({ account: { type: "apiKey" }, requiresOpenaiAuth: true }),
  ).toEqual({ provider: "codex", state: "signed-in", method: "api-key" });
  expect(codexReading({ account: null, requiresOpenaiAuth: true })).toEqual({
    provider: "codex",
    state: "signed-out",
  });
  // The AI pool's provider (`requires_openai_auth = false`): provided,
  // whatever account Codex also holds.
  for (const account of [null, { type: "chatgpt", email: "a@example.com" }])
    expect(codexReading({ account, requiresOpenaiAuth: false })).toEqual({
      provider: "codex",
      state: "provided",
    });
  // An e-mail is a label only when it is one line and looks like one.
  expect(
    codexReading({
      account: { type: "chatgpt", email: "not an email\n" },
      requiresOpenaiAuth: true,
    }),
  ).toEqual({ provider: "codex", state: "signed-in", method: "chatgpt" });
  for (const result of [
    undefined,
    null,
    "account",
    { requiresOpenaiAuth: true },
    { account: { type: "other" }, requiresOpenaiAuth: true },
  ])
    expect(codexReading(result)).toEqual({
      provider: "codex",
      state: "unknown",
    });
});

test("Claude Code's auth status: loggedIn, whatever the exit code", () => {
  expect(
    claudeReading(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "a@example.com",
      }),
    ),
  ).toEqual({
    provider: "claude",
    state: "signed-in",
    account: "a@example.com",
  });
  expect(
    claudeReading(JSON.stringify({ loggedIn: false, authMethod: "none" })),
  ).toEqual({ provider: "claude", state: "signed-out" });
  for (const stdout of ["", "Logged in", "{}", '{"loggedIn":"yes"}'])
    expect(claudeReading(stdout)).toEqual({
      provider: "claude",
      state: "unknown",
    });
});

test("the Environment's AI: the Organization's first, then any sign-in; missing only when every CLI answered", () => {
  const codex = (state: AiProviderReading["state"]): AiProviderReading => ({
    provider: "codex",
    state,
  });
  const claude = (state: AiProviderReading["state"]): AiProviderReading => ({
    provider: "claude",
    state,
  });
  expect(aiState([codex("provided"), claude("signed-out")])).toBe(
    "organization",
  );
  expect(aiState([codex("signed-in"), claude("provided")])).toBe(
    "organization",
  );
  expect(aiState([codex("signed-out"), claude("signed-in")])).toBe("connected");
  expect(aiState([codex("unknown"), claude("signed-in")])).toBe("connected");
  expect(aiState([codex("signed-out"), claude("not-installed")])).toBe(
    "missing",
  );
  expect(aiState([codex("not-installed"), claude("not-installed")])).toBe(
    "missing",
  );
  // One CLI did not answer: never claimed missing.
  expect(aiState([codex("signed-out"), claude("unknown")])).toBe("unknown");
  expect(aiState([])).toBe("unknown");
});

test("the route's answer, as the page reads it", () => {
  const answer = {
    kind: "ai",
    state: "connected",
    providers: [
      {
        provider: "codex",
        state: "signed-in",
        method: "chatgpt",
        account: "a@example.com",
      },
      { provider: "claude", state: "signed-out" },
      { provider: "future-cli", state: "whatever" },
    ],
  };
  expect(parseAiAnswer(answer)).toEqual({
    state: "connected",
    providers: [
      {
        provider: "codex",
        state: "signed-in",
        method: "chatgpt",
        account: "a@example.com",
      },
      { provider: "claude", state: "signed-out" },
    ],
  });
  for (const wrong of [
    null,
    { ...answer, kind: "other" },
    { ...answer, state: "maybe" },
    { ...answer, providers: "none" },
    { ...answer, providers: [{ provider: "codex", state: "half" }] },
  ])
    expect(parseAiAnswer(wrong)).toBeNull();
});

async function scratch() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ai-status-")));
  const home = join(parent, "home");
  const bin = join(parent, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  return { parent, home, bin };
}

posixTest(
  "the probe asks Codex's app-server once, without refreshing a token, as the operator with PATH and home",
  async () => {
    const { parent, home, bin } = await scratch();
    try {
      await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const asked: {
        command: readonly string[];
        env: Readonly<Record<string, string>>;
        input: string;
      }[] = [];
      const talk: Converse = async (command, env, input, until) => {
        asked.push({ command, env, input });
        const answer = JSON.stringify({
          id: 1,
          result: { account: null, requiresOpenaiAuth: false },
        });
        expect(until('{"id":0,"result":{}}')).toBe(false);
        expect(until(answer)).toBe(true);
        return ['{"id":0,"result":{}}', answer];
      };
      const run: ToolRunner = async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "",
      });
      const reading = await readAi(
        { path: bin, home, platform: process.platform, run },
        { converse: talk },
      );
      expect(reading).toEqual({
        state: "organization",
        providers: [
          { provider: "codex", state: "provided" },
          { provider: "claude", state: "not-installed" },
        ],
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]?.command).toEqual([join(bin, "codex"), "app-server"]);
      expect(asked[0]?.env).toEqual({
        HOME: home,
        PATH: bin,
        USER: userInfo().username,
        LOGNAME: userInfo().username,
      });
      expect(
        asked[0]?.input
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method),
      ).toEqual(["initialize", "initialized", "account/read"]);
      expect(JSON.parse(asked[0]?.input.trim().split("\n")[2] ?? "")).toEqual({
        method: "account/read",
        id: 1,
        params: { refreshToken: false },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// A fake Codex whose app-server answers `account/read` with `result`, and a
// fake Claude Code that prints `claude`.
async function fakeClis(
  bin: string,
  result: unknown,
  claude: unknown,
): Promise<void> {
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh
[ "$1" = "app-server" ] || exit 2
while IFS= read -r line; do
  case "$line" in
    *'"account/read"'*) printf '%s\\n' '${JSON.stringify({ id: 1, result })}' ;;
    *'"initialize"'*) printf '%s\\n' '{"id":0,"result":{}}' ;;
  esac
done
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh
[ "$1 $2 $3" = "auth status --json" ] || exit 2
printf '%s\\n' '${JSON.stringify(claude)}'
${(claude as { loggedIn?: unknown }).loggedIn === true ? "exit 0" : "exit 1"}
`,
    { mode: 0o755 },
  );
}

posixTest(
  "over real processes: the app-server's answer, an early exit and silence",
  async () => {
    const { parent, home, bin } = await scratch();
    const environment = {
      path: `${bin}:/usr/bin:/bin`,
      home,
      platform: process.platform,
      run: runTool,
    };
    try {
      await fakeClis(
        bin,
        {
          account: { type: "chatgpt", email: "a@example.com" },
          requiresOpenaiAuth: true,
        },
        { loggedIn: false, authMethod: "none" },
      );
      expect(await readAi(environment)).toEqual({
        state: "connected",
        providers: [
          {
            provider: "codex",
            state: "signed-in",
            method: "chatgpt",
            account: "a@example.com",
          },
          { provider: "claude", state: "signed-out" },
        ],
      });
      // Both signed out: missing.
      await fakeClis(
        bin,
        { account: null, requiresOpenaiAuth: true },
        { loggedIn: false },
      );
      expect((await readAi(environment)).state).toBe("missing");
      // A Codex that ends before it answers, or never answers: not known.
      await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      expect((await readAi(environment)).providers[0]).toEqual({
        provider: "codex",
        state: "unknown",
      });
      await writeFile(join(bin, "codex"), "#!/bin/sh\nexec sleep 30\n", {
        mode: 0o755,
      });
      const started = Date.now();
      const silent = await converse(
        [join(bin, "codex"), "app-server"],
        { PATH: environment.path, HOME: home },
        "{}\n",
        () => true,
        300,
      );
      expect(silent).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(
        (await readAi(environment, { timeoutMs: 300 })).providers[0]?.state,
      ).toBe("unknown");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

test("the probe keeps an answer a minute, asks once at a time and forgets on request", async () => {
  let now = 0;
  let asked = 0;
  let answer: unknown = { account: null, requiresOpenaiAuth: true };
  const talk: Converse = async () => {
    asked += 1;
    await Bun.sleep(5);
    return [JSON.stringify({ id: 1, result: answer })];
  };
  const probe = createAiProbe(
    {
      // No codex or claude on this PATH: only the conversation decides.
      path: "/nonexistent",
      home: "/nonexistent",
      platform: process.platform,
      run: async () => "timeout",
    },
    { now: () => now, converse: talk },
  );
  // Neither is installed: missing, without a conversation.
  const [first, second] = await Promise.all([probe.state(), probe.state()]);
  expect(first.state).toBe("missing");
  expect(second).toBe(first);
  expect(asked).toBe(0);
  now = 59_000;
  expect(await probe.state()).toBe(first);
  now = 61_000;
  answer = { account: null, requiresOpenaiAuth: false };
  const later = await probe.state();
  expect(later).not.toBe(first);
  probe.forget();
  expect(await probe.state()).not.toBe(later);
});

posixTest(
  "GET /api/ai: behind the admission, kept a minute, asked again with fresh=1",
  async () => {
    const { parent, home, bin } = await scratch();
    const folder = join(parent, "Lazurio");
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform)),
    );
    await fakeClis(
      bin,
      { account: null, requiresOpenaiAuth: false },
      { loggedIn: true, email: "a@example.com" },
    );
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      {},
      {
        path: `${bin}:/usr/bin:/bin`,
        home,
        platform: process.platform,
        run: runTool,
      },
    );
    try {
      const url = new URL(app.url);
      const headers = {
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      };
      const get = (path: string, extra = headers) =>
        fetch(new URL(path, url), { headers: extra });
      expect(
        (await get("/api/ai", { Origin: url.origin, Authorization: "" }))
          .status,
      ).toBe(403);
      const answer = await get("/api/ai");
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await answer.json()).toEqual({
        kind: "ai",
        state: "organization",
        providers: [
          { provider: "codex", state: "provided" },
          { provider: "claude", state: "signed-in", account: "a@example.com" },
        ],
      });
      // The Organization's pool ends; within the minute the answer stays,
      // "Zkontrolovat znovu" asks now.
      await fakeClis(
        bin,
        { account: null, requiresOpenaiAuth: true },
        { loggedIn: false },
      );
      expect(
        ((await (await get("/api/ai")).json()) as { state: string }).state,
      ).toBe("organization");
      expect(
        ((await (await get("/api/ai?fresh=1")).json()) as { state: string })
          .state,
      ).toBe("missing");
      for (const path of [
        "/api/ai?fresh=0",
        "/api/ai?other=1",
        "/api/ai?fresh=1&fresh=1",
      ])
        expect([path, (await get(path)).status]).toEqual([path, 400]);
      expect(
        (
          await fetch(new URL("/api/ai", url), {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(405);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);
