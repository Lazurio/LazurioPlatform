import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatDefaults, recommendedChatModel } from "../src/chat/defaults";
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
