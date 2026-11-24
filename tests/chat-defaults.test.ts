import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatDefaults,
  chatDefaults,
  claudeOnly,
  recommendedChatModel,
  recommendedClaudeModel,
} from "../src/chat/defaults";
import type { AiProviderState, AiReading } from "../src/tools/ai";
import type { Converse } from "../src/tools/ai-probe";
import type { ToolsEnvironment } from "../src/tools/overview";

test("read-only Chat status and apply use T3's native owner; custom choices survive", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "chat-defaults-")));
  try {
    for (const name of ["t3", "codex"])
      await writeFile(join(home, name), "#!/bin/sh\nexit 1\n", {
        mode: 0o700,
      });
    // Codex answers that its configuration pins no model.
    const { converse } = codexAnswering(configRead(null));
    let current: unknown = null;
    let managed: unknown = null;
    const calls: string[][] = [];
    const tools: ToolsEnvironment = {
      home,
      path: home,
      platform: "linux",
      run: async (argv) => {
        calls.push([...argv]);
        if (argv.length === 6) {
          const request = JSON.parse(argv[5] ?? "");
          expect(request.folder).toBe(home);
          expect(request.selection).toEqual(recommendedChatModel);
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ version: 1, current, lastManaged: managed }),
          stderr: "",
        };
      },
    };
    expect((await chatDefaults(tools, { converse })).state).toBe("outdated");
    expect(calls[0]).toEqual([
      join(home, "t3"),
      "lazurio",
      "model",
      "--base-dir",
      join(home, ".t3"),
    ]);
    current = managed = recommendedChatModel;
    expect(
      (await chatDefaults(tools, { apply: true, folder: home, converse }))
        .state,
    ).toBe("managed");
    current = {
      ...recommendedChatModel,
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    expect((await chatDefaults(tools, { converse })).state).toBe("custom");
    current = managed = { instanceId: "codex", model: "previous", options: [] };
    expect((await chatDefaults(tools, { converse })).state).toBe("outdated");
    expect(
      await chatDefaults(
        {
          ...tools,
          run: async () => ({
            exitCode: 0,
            stdout: '{"version":1}',
            stderr: "secret",
          }),
        },
        { converse },
      ),
    ).toEqual({
      kind: "chat-defaults",
      state: "unavailable",
      reason: "t3-defaults-unavailable",
      // Whose model was recommended is known by then (F51's addendum).
      ai: "codex",
    });
    expect((await chatDefaults({ ...tools, path: "" })).reason).toBe(
      "t3-launcher-missing",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Chat's model comes from the Environment's Codex configuration (root
// decision 0209 and the 0204 addendum of 2026-10-19): when Codex's own
// `config/read` resolves a `model` (Machines' system file, the operator's own
// file), that model is the recommendation; when Codex answers that it pins
// none, the Platform's own. Without Codex's answer the model is not known and
// T3 is left as it is, since a gateway that admits only the pinned model
// would refuse the Platform's own. T3's reconciliation (F51) keeps a person's
// own choice; the fake T3 below does what T3 does.

type Selection = Readonly<{
  instanceId: string;
  model: string;
  options?: readonly Readonly<{ id: string; value: string | boolean }>[];
}>;

async function environment(start: {
  current: Selection | null;
  lastManaged: Selection | null;
}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "chat-model-")));
  for (const name of ["t3", "codex"])
    await writeFile(join(home, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  let current = start.current;
  let managed = start.lastManaged;
  const written: unknown[] = [];
  const t3 = { calls: 0 };
  const tools: ToolsEnvironment = {
    home,
    path: home,
    platform: "linux",
    run: async (argv) => {
      t3.calls += 1;
      if (argv.length === 6) {
        const { selection } = JSON.parse(argv[5] ?? "");
        written.push(selection);
        // T3 changes an unset model or its own last write; a person's own
        // model stays.
        if (
          current === null ||
          JSON.stringify(current) === JSON.stringify(managed)
        )
          current = managed = selection;
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ version: 1, current, lastManaged: managed }),
        stderr: "",
      };
    },
  };
  return {
    home,
    tools,
    written,
    t3,
    done: () => rm(home, { recursive: true, force: true }),
  };
}

/** Codex's app-server answering `config/read` with `answer` (its line), or
 * not answering at all. */
function codexAnswering(answer: unknown) {
  const asked: { command: readonly string[]; input: string }[] = [];
  const converse: Converse = async (command, _env, input, until) => {
    asked.push({ command, input });
    if (answer === "timeout" || answer === "failed") return answer;
    const lines = ['{"id":0,"result":{}}', JSON.stringify(answer)];
    expect(until(lines[0] ?? "")).toBe(false);
    expect(until(lines[1] ?? "")).toBe(true);
    return lines;
  };
  return { asked, converse };
}

const configRead = (model: string | null) => ({
  id: 1,
  result: {
    config: { model, model_provider: model === null ? null : "gateway" },
    origins: {},
    layers: null,
  },
});

test("a model the Environment's Codex configuration pins is Chat's model, over the Platform's own", async () => {
  // A T3 still on the Platform's earlier recommendation follows.
  const env = await environment({
    current: recommendedChatModel,
    lastManaged: recommendedChatModel,
  });
  try {
    const codex = codexAnswering(configRead("gpt-6-luna"));
    expect(
      (await chatDefaults(env.tools, { converse: codex.converse })).state,
    ).toBe("outdated");
    expect(
      (
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: codex.converse,
        })
      ).state,
    ).toBe("managed");
    expect(env.written).toEqual([
      { ...recommendedChatModel, model: "gpt-6-luna" },
    ]);
    expect(
      (await chatDefaults(env.tools, { converse: codex.converse })).state,
    ).toBe("managed");
    // Asked through Codex's own app-server, never by reading its files.
    expect(codex.asked[0]?.command).toEqual([
      join(env.home, "codex"),
      "app-server",
    ]);
    const messages = (codex.asked[0]?.input ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "config/read",
    ]);
    expect(messages[2]).toEqual({
      method: "config/read",
      id: 1,
      params: { includeLayers: false },
    });
  } finally {
    await env.done();
  }
});

test("without a model in Codex's configuration Chat keeps the Platform's default", async () => {
  const env = await environment({ current: null, lastManaged: null });
  try {
    const codex = codexAnswering(configRead(null));
    expect(
      (
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: codex.converse,
        })
      ).state,
    ).toBe("managed");
    expect(env.written).toEqual([recommendedChatModel]);
  } finally {
    await env.done();
  }
});

test("a model the person chose in Chat wins over the one Codex's configuration pins", async () => {
  const chosen = {
    instanceId: "codex",
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const env = await environment({
    current: chosen,
    lastManaged: recommendedChatModel,
  });
  try {
    const codex = codexAnswering(configRead("gpt-6-luna"));
    expect(
      (await chatDefaults(env.tools, { converse: codex.converse })).state,
    ).toBe("custom");
    expect(
      (
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: codex.converse,
        })
      ).state,
    ).toBe("custom");
    expect(
      (await chatDefaults(env.tools, { converse: codex.converse })).state,
    ).toBe("custom");
  } finally {
    await env.done();
  }
});

test("without Codex's answer, apply writes nothing and says why; a managed pinned model stays", async () => {
  const luna = { ...recommendedChatModel, model: "gpt-6-luna" };
  const unreadable: ChatDefaults = {
    kind: "chat-defaults",
    state: "unavailable",
    reason: "codex-config-unreadable",
  };
  const throwing: Converse = async () => {
    throw new Error("spawn failed");
  };
  for (const talk of [
    codexAnswering("timeout").converse,
    codexAnswering("failed").converse,
    codexAnswering({
      id: 1,
      error: { code: -32601, message: "Method not found" },
    }).converse,
    codexAnswering({ id: 1, result: { config: { model: 7 } } }).converse,
    codexAnswering({ id: 1, result: { config: { model: "two\nlines" } } })
      .converse,
    codexAnswering({ id: 1, result: { config: null } }).converse,
    codexAnswering({ id: 1, result: null }).converse,
    throwing,
  ]) {
    // T3 holds the pinned model the Platform last wrote.
    const env = await environment({ current: luna, lastManaged: luna });
    try {
      expect(
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: talk,
        }),
      ).toEqual(unreadable);
      // The read-only check does not compare with the Platform's own either.
      expect(await chatDefaults(env.tools, { converse: talk })).toEqual(
        unreadable,
      );
      expect(env.t3.calls).toBe(0);
      expect(env.written).toEqual([]);
      // Once Codex answers again, the pinned model is still Chat's.
      expect(
        (
          await chatDefaults(env.tools, {
            converse: codexAnswering(configRead("gpt-6-luna")).converse,
          })
        ).state,
      ).toBe("managed");
    } finally {
      await env.done();
    }
  }
  // No Codex on PATH: it is never started and nothing is written.
  const env = await environment({ current: null, lastManaged: null });
  try {
    await rm(join(env.home, "codex"));
    let asked = false;
    const converse: Converse = async () => {
      asked = true;
      return "failed";
    };
    expect(
      await chatDefaults(env.tools, {
        apply: true,
        folder: env.home,
        converse,
      }),
    ).toEqual(unreadable);
    expect(asked).toBe(false);
    expect(env.t3.calls).toBe(0);
    expect(env.written).toEqual([]);
  } finally {
    await env.done();
  }
});

// T3 may log on stdout before its one-line answer, as 0.1.7-lazurio.1 does
// when its data directory carries migrations of a later build
// (Lazurio/t3code#210). The answer is still read; a stdout without a JSON
// line is its own reason.
test("a log line before T3's answer is read through; no answer is t3-answer-unreadable", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "chat-log-")));
  try {
    for (const name of ["t3", "codex"])
      await writeFile(join(home, name), "#!/bin/sh\nexit 1\n", {
        mode: 0o700,
      });
    const { converse } = codexAnswering(configRead(null));
    const answer = JSON.stringify({
      version: 1,
      current: recommendedChatModel,
      lastManaged: recommendedChatModel,
    });
    const warning = [
      "[00:47:49.316] WARN (#31): Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name. {",
      "  divergent: [",
      "    '80:ScheduledTaskThreadMode (unknown to this build)',",
      "  ]",
      "}",
    ].join("\n");
    const with_ = (stdout: string): ToolsEnvironment => ({
      home,
      path: home,
      platform: "linux",
      run: async () => ({ exitCode: 0, stdout, stderr: "" }),
    });
    expect(
      await chatDefaults(with_(`${warning}\n${answer}\n`), {
        apply: true,
        folder: home,
        converse,
      }),
    ).toEqual({ kind: "chat-defaults", state: "managed", ai: "codex" });
    for (const stdout of ["", `${warning}\n`, "[1,2]", "null"])
      expect(
        await chatDefaults(with_(stdout), {
          apply: true,
          folder: home,
          converse,
        }),
      ).toEqual({
        kind: "chat-defaults",
        state: "unavailable",
        reason: "t3-answer-unreadable",
        ai: "codex",
      });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// F51's addendum of 2026-11-24 (LazurioPlatform#1197): where Codex cannot
// work and Claude Code is signed in, Chat's model is Claude's, so a first
// thread made on the Folder project's model answers. Codex provided, signed
// in or not known keeps Codex, as before.
const reading = (codex: string, claude: string): AiReading => ({
  state: "unknown",
  providers: [
    { provider: "codex", state: codex as AiProviderState },
    { provider: "claude", state: claude as AiProviderState },
  ],
});

test("only where Codex cannot work and Claude is signed in does Chat run on Claude", () => {
  for (const codex of ["signed-out", "not-installed"])
    expect(claudeOnly(reading(codex, "signed-in"))).toBe(true);
  for (const codex of ["signed-in", "provided", "unknown"])
    expect(claudeOnly(reading(codex, "signed-in"))).toBe(false);
  for (const claude of ["signed-out", "not-installed", "unknown"])
    expect(claudeOnly(reading("signed-out", claude))).toBe(false);
  expect(claudeOnly({ state: "unknown", providers: [] })).toBe(false);
  expect(recommendedClaudeModel).toEqual({
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "medium" }],
  });
});

test("with only Claude signed in the Platform's model is Claude's, without asking Codex's configuration; a person's own model stays", async () => {
  const env = await environment({
    current: recommendedChatModel,
    lastManaged: recommendedChatModel,
  });
  try {
    const codex = codexAnswering(configRead(null));
    const ai = reading("signed-out", "signed-in");
    expect(
      (await chatDefaults(env.tools, { converse: codex.converse, ai })).state,
    ).toBe("outdated");
    expect(
      (
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: codex.converse,
          ai,
        })
      ).state,
    ).toBe("managed");
    expect(env.written).toEqual([recommendedClaudeModel]);
    expect(codex.asked).toEqual([]);
    expect(
      (await chatDefaults(env.tools, { converse: codex.converse, ai })).ai,
    ).toBe("claude");
    // Once Codex is signed in, the Platform's model is Codex's again.
    const signedIn = reading("signed-in", "signed-in");
    expect(
      (
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: codex.converse,
          ai: signedIn,
        })
      ).state,
    ).toBe("managed");
    expect(env.written.at(-1)).toEqual(recommendedChatModel);
    // Both signed in: Codex's model, and the answer says whose it is.
    expect(
      (
        await chatDefaults(env.tools, {
          converse: codex.converse,
          ai: signedIn,
        })
      ).ai,
    ).toBe("codex");
  } finally {
    await env.done();
  }
  // A model the person chose is theirs whichever AI is signed in.
  const own = { instanceId: "codex", model: "gpt-6-luna", options: [] };
  const chosen = await environment({
    current: own,
    lastManaged: recommendedChatModel,
  });
  try {
    const answer = await chatDefaults(chosen.tools, {
      apply: true,
      folder: chosen.home,
      converse: codexAnswering(configRead(null)).converse,
      ai: reading("signed-out", "signed-in"),
    });
    expect(answer.state).toBe("custom");
  } finally {
    await chosen.done();
  }
});

test("without a reading Claude Code is asked first, and Codex's sign-in only where Claude is signed in", async () => {
  for (const [claudeStatus, expected] of [
    ['{"loggedIn":true,"email":"a@example.invalid"}', recommendedClaudeModel],
    ['{"loggedIn":false}', recommendedChatModel],
  ] as const) {
    const env = await environment({ current: null, lastManaged: null });
    try {
      await writeFile(join(env.home, "claude"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const run = env.tools.run;
      const tools: ToolsEnvironment = {
        ...env.tools,
        run: async (argv, ...rest) =>
          argv.at(1) === "auth"
            ? { exitCode: 0, stdout: claudeStatus, stderr: "" }
            : run(argv, ...rest),
      };
      // Codex answers `account/read` signed out, `config/read` pinning none.
      const asked: string[] = [];
      const converse: Converse = async (_command, _env, input) => {
        const method = input
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { id?: number; method?: string })
          .find((message) => message.id === 1)?.method;
        asked.push(method ?? "?");
        return [
          '{"id":0,"result":{}}',
          JSON.stringify(
            method === "account/read"
              ? { id: 1, result: { account: null, requiresOpenaiAuth: true } }
              : configRead(null),
          ),
        ];
      };
      await chatDefaults(tools, { apply: true, folder: env.home, converse });
      expect(env.written).toEqual([expected]);
      expect(asked).toEqual(
        expected === recommendedClaudeModel
          ? ["account/read"]
          : ["config/read"],
      );
    } finally {
      await env.done();
    }
  }
});
