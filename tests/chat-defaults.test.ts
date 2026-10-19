import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatDefaults, recommendedChatModel } from "../src/chat/defaults";
import type { Converse } from "../src/tools/ai-probe";
import type { ToolsEnvironment } from "../src/tools/overview";

test("read-only Chat status and apply use T3's native owner; custom choices survive", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "chat-defaults-")));
  try {
    await writeFile(join(home, "t3"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
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
    expect((await chatDefaults(tools)).state).toBe("outdated");
    expect(calls[0]).toEqual([
      join(home, "t3"),
      "lazurio",
      "model",
      "--base-dir",
      join(home, ".t3"),
    ]);
    current = managed = recommendedChatModel;
    expect(
      (await chatDefaults(tools, { apply: true, folder: home })).state,
    ).toBe("managed");
    current = {
      ...recommendedChatModel,
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    expect((await chatDefaults(tools)).state).toBe("custom");
    current = managed = { instanceId: "codex", model: "previous", options: [] };
    expect((await chatDefaults(tools)).state).toBe("outdated");
    expect(
      await chatDefaults({
        ...tools,
        run: async () => ({
          exitCode: 0,
          stdout: '{"version":1}',
          stderr: "secret",
        }),
      }),
    ).toEqual({
      kind: "chat-defaults",
      state: "unavailable",
      reason: "t3-defaults-unavailable",
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
// file), that model is the recommendation; without one, or without an
// answer, the Platform's own stays. T3's reconciliation (F51) keeps a
// person's own choice either way; the fake T3 below does what T3 does.

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
  const tools: ToolsEnvironment = {
    home,
    path: home,
    platform: "linux",
    run: async (argv) => {
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

test("when Codex's config/read fails Chat keeps the Platform's default and is not blocked", async () => {
  for (const answer of [
    "timeout",
    "failed",
    { id: 1, error: { code: -32601, message: "Method not found" } },
    { id: 1, result: { config: { model: 7 } } },
    { id: 1, result: { config: { model: "two\nlines" } } },
    { id: 1, result: null },
  ]) {
    const env = await environment({ current: null, lastManaged: null });
    try {
      const codex = codexAnswering(answer);
      expect(
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse: codex.converse,
        }),
      ).toEqual({ kind: "chat-defaults", state: "managed" });
      expect(env.written).toEqual([recommendedChatModel]);
    } finally {
      await env.done();
    }
  }
  // A Codex that throws, and no Codex on PATH at all.
  const env = await environment({ current: null, lastManaged: null });
  try {
    await rm(join(env.home, "codex"));
    let asked = false;
    const converse: Converse = async () => {
      asked = true;
      throw new Error("spawn failed");
    };
    expect(
      (
        await chatDefaults(env.tools, {
          apply: true,
          folder: env.home,
          converse,
        })
      ).state,
    ).toBe("managed");
    expect(asked).toBe(false);
    await writeFile(join(env.home, "codex"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    expect((await chatDefaults(env.tools, { converse })).state).toBe("managed");
    expect(asked).toBe(true);
    expect(env.written).toEqual([recommendedChatModel]);
  } finally {
    await env.done();
  }
});
