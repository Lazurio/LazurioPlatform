import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ToolEntry } from "../src/tools/catalog";
import { findTool, toolCatalog } from "../src/tools/catalog";
import { runToolsCommand } from "../src/tools/cli";
import { resolveOnPath, toolsStatus, versionOf } from "../src/tools/status";
import { toolsUpdate } from "../src/tools/update";
import { runProcess } from "../src/update/self-check";

const posix = process.platform !== "win32";

// A fake tool: an executable that prints the version stored beside it, and
// whose "upgrade" rewrites that version. Nothing here touches the real PATH.
async function fakeTool(
  directory: string,
  name: string,
  version: string,
  options: { upgradeTo?: string; exitCode?: number } = {},
): Promise<string> {
  const versions = join(directory, `${name}.version`);
  await writeFile(versions, `${version}\n`);
  const script = join(directory, name);
  await writeFile(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then read v < "${versions}"; echo "${name} $v"; exit ${options.exitCode ?? 0}; fi
if [ "$1" = "upgrade" ] || [ "$1" = "update" ]; then ${
      options.upgradeTo
        ? `echo "${options.upgradeTo}" > "${versions}"; echo upgraded; exit 0`
        : "echo failed; exit 3"
    }; fi
exit 1
`,
  );
  await chmod(script, 0o755);
  return script;
}

const catalog = (
  entries: readonly Partial<ToolEntry>[],
): readonly ToolEntry[] =>
  entries.map((entry) =>
    Object.freeze({
      name: entry.name ?? "x",
      command: entry.command ?? entry.name ?? "x",
      versionArgs: entry.versionArgs ?? ["--version"],
      source: entry.source ?? "https://example.invalid/tool",
      updater: entry.updater ?? ({ kind: "none" } as const),
    }),
  );

test("the catalog names the operator's tools with their official update path", () => {
  expect(toolCatalog.map((entry) => entry.name)).toEqual([
    "codex",
    "claude",
    "gh",
    "git",
    "node",
    "npm",
    "bun",
  ]);
  expect(findTool("codex")?.updater.kind).toBe("installer");
  expect(findTool("claude")?.updater).toEqual({
    kind: "self",
    argv: ["update"],
  });
  expect(findTool("bun")?.updater).toEqual({
    kind: "self",
    argv: ["upgrade"],
  });
  for (const name of ["gh", "git", "node", "npm"])
    expect(findTool(name)?.updater.kind).toBe("none");
  expect(Object.isFrozen(toolCatalog)).toBe(true);
  expect(findTool("t3")).toBeUndefined();
});

test("versionOf takes the first version-shaped token of the first line", () => {
  expect(versionOf("gh version 2.86.0 (2026-09-01)\nhttps://…")).toBe("2.86.0");
  expect(versionOf("v26.5.0\n")).toBe("26.5.0");
  expect(versionOf("codex-cli 0.120.0-alpha.3")).toBe("0.120.0-alpha.3");
  expect(versionOf("\n  banner without number\n")).toBe(
    "banner without number",
  );
  expect(versionOf("")).toBeUndefined();
});

test.skipIf(!posix)(
  "status reports the first executable on PATH, its real path and its version; missing tools carry their source",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "lazurio-tools-")),
    );
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    const real = await fakeTool(second, "node-real", "26.5.0");
    await symlink(real, join(first, "node"));
    await fakeTool(second, "node", "24.0.0");
    await fakeTool(first, "gh", "2.86.0");
    await fakeTool(first, "bun", "1.4.2", { exitCode: 7 });
    await writeFile(join(first, "codex"), "not executable");
    const result = await toolsStatus({
      path: [first, second].join(delimiter),
      home: root,
      platform: process.platform,
      run: runProcess,
      catalog: catalog([
        { name: "node" },
        { name: "gh" },
        { name: "bun", updater: { kind: "self", argv: ["upgrade"] } },
        {
          name: "codex",
          updater: { kind: "installer", posix: "true", windows: "true" },
        },
        { name: "claude" },
      ]),
    });
    expect(result.kind).toBe("tools-status");
    const byName = Object.fromEntries(
      result.tools.map((tool) => [tool.name, tool]),
    );
    expect(byName.node).toMatchObject({
      installed: true,
      path: join(first, "node"),
      realPath: real,
      version: "26.5.0",
      updater: "none",
    });
    expect(byName.gh).toMatchObject({ installed: true, version: "2.86.0" });
    expect(byName.bun).toMatchObject({
      installed: true,
      versionError: "exit 7",
      updater: "self",
    });
    expect(byName.bun?.version).toBeUndefined();
    expect(byName.codex).toMatchObject({
      installed: false,
      updater: "installer",
      source: "https://example.invalid/tool",
    });
    expect(byName.claude).toMatchObject({ installed: false });
    expect(
      await resolveOnPath("node", undefined, process.platform),
    ).toBeUndefined();
  },
);

test.skipIf(!posix)(
  "update runs exactly one tool's own updater and reports before and after; the rest is refused or reported",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lazurio-tools-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await fakeTool(bin, "bun", "1.4.2", { upgradeTo: "1.4.3" });
    await fakeTool(bin, "claude", "2.1.0");
    await fakeTool(bin, "gh", "2.86.0");
    const common = {
      path: bin,
      home: root,
      platform: process.platform,
      run: runProcess,
      catalog: catalog([
        { name: "bun", updater: { kind: "self", argv: ["upgrade"] } },
        { name: "claude", updater: { kind: "self", argv: ["update"] } },
        { name: "gh" },
        {
          name: "codex",
          updater: {
            kind: "installer",
            posix: `echo "0.100.0" > "${join(bin, "codex.version")}"; echo installed`,
            windows: "exit 1",
          },
        },
      ]),
    };
    const updated = await toolsUpdate({ ...common, tool: "bun" });
    expect(updated).toMatchObject({
      kind: "tool-updated",
      tool: "bun",
      command: [join(bin, "bun"), "upgrade"],
      changed: true,
    });
    if (updated.kind === "tool-updated") {
      expect(updated.before.version).toBe("1.4.2");
      expect(updated.after.version).toBe("1.4.3");
      expect(updated.output).toBe("upgraded");
    }
    const failed = await toolsUpdate({ ...common, tool: "claude" });
    expect(failed).toMatchObject({
      kind: "tool-update-failed",
      tool: "claude",
      exitCode: 3,
      output: "failed",
    });
    expect(await toolsUpdate({ ...common, tool: "gh" })).toMatchObject({
      kind: "tool-not-self-updating",
      tool: "gh",
      source: "https://example.invalid/tool",
    });
    expect(await toolsUpdate({ ...common, tool: "t3" })).toEqual({
      kind: "tool-unknown",
      tool: "t3",
      known: ["bun", "claude", "gh", "codex"],
    });
    // The vendor installer runs through sh -c and the tool it installs is read
    // back afterwards; a missing tool before is still an honest "before".
    await fakeTool(bin, "codex", "0.99.0");
    const installed = await toolsUpdate({ ...common, tool: "codex" });
    expect(installed).toMatchObject({
      kind: "tool-updated",
      tool: "codex",
      command: [
        "/bin/sh",
        "-c",
        common.catalog[3]?.updater.kind === "installer"
          ? common.catalog[3].updater.posix
          : "",
      ],
      changed: true,
    });
    if (installed.kind === "tool-updated") {
      expect(installed.before.version).toBe("0.99.0");
      expect(installed.after.version).toBe("0.100.0");
    }
  },
);

test.skipIf(!posix)(
  "the CLI surface: status text and JSON, update exit codes, usage",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lazurio-tools-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await fakeTool(bin, "gh", "2.86.0");
    const context = {
      env: { PATH: bin, HOME: root },
      platform: process.platform,
    };
    const status = await runToolsCommand(["status", "--json"], context);
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.text) as {
      kind: string;
      tools: { name: string; installed: boolean }[];
    };
    expect(parsed.kind).toBe("tools-status");
    expect(parsed.tools.find((tool) => tool.name === "gh")).toMatchObject({
      installed: true,
      version: "2.86.0",
    });
    expect(parsed.tools.find((tool) => tool.name === "codex")).toMatchObject({
      installed: false,
    });
    const text = await runToolsCommand(["status"], context);
    expect(text.text).toContain(`gh      2.86.0           ${join(bin, "gh")}`);
    expect(text.text).toContain(
      "codex   missing          https://developers.openai.com/codex/cli",
    );
    const none = await runToolsCommand(["update", "gh"], context);
    expect(none.code).toBe(1);
    expect(none.text).toContain("no official self-update path");
    const unknown = await runToolsCommand(["update", "t3", "--json"], context);
    expect(unknown.code).toBe(2);
    await expect(runToolsCommand(["update"], context)).rejects.toThrow(/Usage/);
    await expect(runToolsCommand(["status", "extra"], context)).rejects.toThrow(
      /Usage/,
    );
  },
);
