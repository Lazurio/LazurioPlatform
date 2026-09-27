import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import type { ToolEntry } from "../src/tools/catalog";
import {
  activatableTools,
  findTool,
  toolCatalog,
  toolPrompt,
} from "../src/tools/catalog";
import { runToolsCommand } from "../src/tools/cli";
import {
  resolveOnPath,
  runTool,
  toolsStatus,
  versionOf,
} from "../src/tools/status";
import { toolsUpdate } from "../src/tools/update";

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
        : "echo failed >&2; exit 3"
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
    "composio",
    "wacli",
    "gogcli",
    "neon",
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
      run: runTool,
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
    expect(byName.gh).toMatchObject({
      installed: true,
      version: "2.86.0",
      standardPath: false,
    });
    // The standard path (decision 0161 point 6): ~/.local/bin/<tool> of the home.
    const standard = join(root, ".local", "bin");
    await mkdir(standard, { recursive: true });
    await fakeTool(standard, "claude", "2.1.0");
    // A deeper path that merely starts with the standard entry is not it.
    const shadow = join(standard, "gh-shadow");
    await mkdir(shadow, { recursive: true });
    await fakeTool(shadow, "gh", "2.0.0");
    const inHome = await toolsStatus({
      path: [standard, shadow, first].join(delimiter),
      home: root,
      platform: process.platform,
      run: runTool,
      catalog: catalog([{ name: "claude" }, { name: "gh" }]),
    });
    expect(inHome.tools.map((tool) => [tool.name, tool.standardPath])).toEqual([
      ["claude", true],
      ["gh", false],
    ]);
    expect(inHome.tools[1]?.path).toBe(join(shadow, "gh"));
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
    // Installer scripts need the system tools an operator's PATH always has.
    const common = {
      path: [bin, "/usr/bin", "/bin"].join(delimiter),
      home: root,
      platform: process.platform,
      run: runTool,
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
    // Without an injected catalog the known names are the product catalog's.
    expect(
      await toolsUpdate({ ...common, catalog: undefined, tool: "t3" }),
    ).toEqual({
      kind: "tool-unknown",
      tool: "t3",
      known: toolCatalog.map((entry) => entry.name),
    });
    // A download that fails never runs half a script and never passes as an
    // update: the failure and its stderr are reported.
    const download = await toolsUpdate({
      ...common,
      tool: "curl-less",
      catalog: catalog([
        {
          name: "curl-less",
          command: "gh",
          updater: {
            kind: "installer",
            posix:
              'set -eu; f="$(mktemp)"; trap \'rm -f "$f"\' EXIT; /usr/bin/false -o "$f" || { echo "download failed" >&2; exit 22; }; sh "$f"',
            windows: "exit 1",
          },
        },
      ]),
    });
    expect(download).toMatchObject({
      kind: "tool-update-failed",
      tool: "curl-less",
      exitCode: 22,
      output: "download failed",
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
    expect(text.text).toContain(`gh       2.86.0           ${join(bin, "gh")}`);
    expect(text.text).toContain(
      "codex    missing          https://developers.openai.com/codex/cli",
    );
    const none = await runToolsCommand(["update", "gh"], context);
    expect(none.code).toBe(1);
    expect(none.text).toContain("no official self-update path");
    const unknown = await runToolsCommand(["update", "t3", "--json"], context);
    expect(unknown.code).toBe(2);
    await expect(runToolsCommand(["update"], context)).rejects.toThrow(/Usage/);
    await expect(
      runToolsCommand(["status", "--nope"], context),
    ).rejects.toThrow(/Usage/);
    await expect(runToolsCommand(["status", "extra"], context)).rejects.toThrow(
      /Usage/,
    );
    // The Folder options belong to the Folder-bound commands only.
    for (const args of [
      ["status", "--folder", root],
      ["update", "gh", "--expected-revision", "1"],
    ])
      await expect(runToolsCommand(args, context)).rejects.toThrow(/Usage/);
  },
);

test.skipIf(!posix)(
  "the Folder-bound CLI surface: list, enable and disable with their exit codes",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "lazurio-tools-folder-")),
    );
    const bin = join(root, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await fakeTool(bin, "gh", "2.86.0");
    await fakeTool(bin, "wacli", "0.9.1");
    const context = {
      env: { PATH: bin, HOME: root },
      platform: process.platform,
    };
    const folder = join(root, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const run = async (...args: string[]) => {
      const output = await runToolsCommand([...args, "--json"], context);
      expect(JSON.parse(output.text)).toEqual(output.result);
      return { code: output.code, result: output.result };
    };
    const list = async () =>
      (await run("list", "--folder", folder)).result as {
        kind: string;
        revision: number;
        tools: Record<string, unknown>[];
      };
    const first = await list();
    expect(first.kind).toBe("tools-list");
    expect(first.revision).toBe(1);
    expect(first.tools).toMatchObject([
      {
        name: "gh",
        tier: "required",
        setup: "launchpad",
        enabled: true,
        installed: true,
        path: join(bin, "gh"),
        version: "2.86.0",
        standardPath: true,
      },
      {
        name: "composio",
        tier: "recommended",
        enabled: false,
        installed: false,
        source: "https://docs.composio.dev/docs/cli",
      },
      {
        name: "wacli",
        tier: "optional",
        setup: "launchpad",
        enabled: false,
        installed: true,
        version: "0.9.1",
        standardPath: true,
      },
      {
        name: "gogcli",
        command: "gog",
        tier: "optional",
        setup: "agent",
        enabled: false,
        installed: false,
      },
      {
        name: "neon",
        tier: "optional",
        setup: "agent",
        enabled: false,
        installed: false,
      },
    ]);
    const text = await runToolsCommand(["list", "--folder", folder], context);
    expect(text.code).toBe(0);
    expect(text.text.split("\n")).toEqual([
      "revision 1",
      `gh        required     launchpad  enabled   2.86.0 ${join(bin, "gh")}`,
      "composio  recommended  launchpad  disabled  missing https://docs.composio.dev/docs/cli",
      `wacli     optional     launchpad  disabled  0.9.1 ${join(bin, "wacli")}`,
      "gogcli    optional     agent      disabled  missing https://github.com/openclaw/gogcli",
      "neon      optional     agent      disabled  missing https://neon.com/docs/reference/neon-cli",
    ]);

    const enable = (tool: string, revision: number) =>
      run(
        "enable",
        tool,
        "--folder",
        folder,
        "--expected-revision",
        String(revision),
      );
    const disable = (tool: string, revision: number) =>
      run(
        "disable",
        tool,
        "--folder",
        folder,
        "--expected-revision",
        String(revision),
      );
    // Enabling a tool that is not installed is allowed: context, not
    // installation. Nothing was installed by it.
    expect(await enable("composio", 1)).toEqual({
      code: 0,
      result: { kind: "updated", revision: 2, tool: "composio" },
    });
    expect(await resolveOnPath("composio", bin, process.platform)).toBe(
      undefined,
    );
    expect(await enable("composio", 2)).toEqual({
      code: 0,
      result: { kind: "unchanged", tool: "composio" },
    });
    expect(await enable("wacli", 1)).toEqual({
      code: 2,
      result: { kind: "blocked", reason: "stale-revision", tool: "wacli" },
    });
    expect(await enable("wacli", 2)).toEqual({
      code: 0,
      result: { kind: "updated", revision: 3, tool: "wacli" },
    });
    expect(
      (await list()).tools.map((tool) => [tool.name, tool.enabled]),
    ).toEqual([
      ["gh", true],
      ["composio", true],
      ["wacli", true],
      ["gogcli", false],
      ["neon", false],
    ]);
    expect(
      JSON.parse(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      ).tools,
    ).toEqual(["composio", "wacli"]);
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
      "- `wacli` (enabled): ",
    );

    // A required tool is always on; unknown and not activatable names are
    // refused before the Folder is read.
    expect(await enable("gh", 99)).toEqual({
      code: 0,
      result: { kind: "unchanged", tool: "gh" },
    });
    expect(await disable("gh", 3)).toEqual({
      code: 2,
      result: { kind: "blocked", reason: "tool-required", tool: "gh" },
    });
    for (const tool of ["t3", "codex"])
      expect(await enable(tool, 3)).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          reason: "tool-unknown",
          tool,
          known: ["gh", "composio", "wacli", "gogcli", "neon"],
        },
      });

    expect(await disable("composio", 3)).toEqual({
      code: 0,
      result: { kind: "updated", revision: 4, tool: "composio" },
    });
    expect(await disable("composio", 4)).toEqual({
      code: 0,
      result: { kind: "unchanged", tool: "composio" },
    });
    // An edited owned file blocks by path with exit 2.
    const roles = join(folder, "manual", "roles.md");
    const original = await readFile(roles, "utf8");
    await writeFile(roles, "my notes");
    expect(await disable("wacli", 4)).toEqual({
      code: 2,
      result: {
        kind: "blocked",
        reason: "drift",
        path: "manual/roles.md",
        tool: "wacli",
      },
    });
    await writeFile(roles, original);
    expect(await disable("wacli", 4)).toEqual({
      code: 0,
      result: { kind: "updated", revision: 5, tool: "wacli" },
    });
    expect(
      "tools" in
        JSON.parse(
          await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
        ),
    ).toBe(false);

    // Usage: the Folder and the revision are explicit, nothing is discovered.
    for (const args of [
      ["list"],
      ["list", "extra", "--folder", folder],
      ["list", "--folder", folder, "--expected-revision", "5"],
      ["enable", "wacli", "--folder", folder],
      ["enable", "wacli", "--expected-revision", "5"],
      ["enable", "--folder", folder, "--expected-revision", "5"],
      ["enable", "wacli", "--folder", folder, "--expected-revision", "0"],
      ["enable", "wacli", "--folder", folder, "--expected-revision", "x"],
      [
        "disable",
        "wacli",
        "--folder",
        folder,
        "--folder",
        folder,
        "--expected-revision",
        "5",
      ],
    ])
      await expect(runToolsCommand(args, context)).rejects.toThrow(/Usage/);
    // A Folder that is not one is an operation failure, not a refusal.
    await expect(
      runToolsCommand(["list", "--folder", join(root, "absent")], context),
    ).rejects.not.toThrow(/Usage/);
    await expect(
      runToolsCommand(
        [
          "enable",
          "wacli",
          "--folder",
          join(root, "absent"),
          "--expected-revision",
          "1",
        ],
        context,
      ),
    ).rejects.not.toThrow(/Usage/);
  },
);

test.skipIf(!posix)(
  "a timed-out update kills the whole process group, so nothing keeps writing after the report",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lazurio-tools-"));
    const marker = join(root, "late");
    // The shell forks a child that would write after the timeout; the shell
    // itself is what a naive kill would stop.
    const started = Date.now();
    const result = await runTool(
      ["/bin/sh", "-c", `sleep 1; echo late > "${marker}"; exit 0`],
      200,
      { PATH: "/usr/bin:/bin" },
    );
    expect(result).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(900);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(stat(marker)).rejects.toThrow();
    const helper = await runTool(
      ["/bin/sh", "-c", `(sleep 1; echo late > "${marker}") & wait`],
      200,
      { PATH: "/usr/bin:/bin" },
    );
    expect(helper).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(stat(marker)).rejects.toThrow();
  },
);

test("the prepared agent prompt: task, target state and the rule to enable the tool, in both locales", async () => {
  // No Folder, no PATH: the prompt is text of the catalog.
  const context = { env: {}, platform: process.platform };
  for (const entry of activatableTools())
    for (const locale of ["cs", "en"] as const) {
      const prompt = toolPrompt(entry.name, locale);
      if (prompt === undefined) throw new Error("Expected a prompt");
      expect(prompt).not.toContain("undefined");
      expect(prompt).toContain(
        locale === "cs"
          ? `Úkol: nainstaluj na téhle Mašině nástroj \`${entry.name}\` (příkaz \`${entry.command}\`)`
          : `Task: install the tool \`${entry.name}\` (command \`${entry.command}\`) on this Machine`,
      );
      expect(prompt).toContain(entry.activation.purpose[locale]);
      expect(prompt).toContain(entry.activation.installation[locale]);
      expect(prompt).toContain("`lazurio tools status --json`");
      expect(
        prompt.includes(
          `\`lazurio tools enable ${entry.name} --folder <Folder> --expected-revision <n>\``,
        ),
      ).toBe(entry.activation.tier !== "required");
      const output = await runToolsCommand(
        ["prompt", entry.name, "--locale", locale, "--json"],
        context,
      );
      expect(output.code).toBe(0);
      expect(JSON.parse(output.text)).toEqual({
        kind: "tool-prompt",
        tool: entry.name,
        locale,
        setup: entry.activation.setup,
        prompt,
      });
      expect(
        (
          await runToolsCommand(
            ["prompt", entry.name, "--locale", locale],
            context,
          )
        ).text,
      ).toBe(prompt);
    }
  // Both locales have the same paragraphs.
  expect(toolPrompt("neon", "cs")?.split("\n").length).toBe(
    toolPrompt("neon", "en")?.split("\n").length,
  );
  // English is the default; a required tool has nothing to enable.
  expect((await runToolsCommand(["prompt", "gogcli"], context)).text).toBe(
    toolPrompt("gogcli", "en") as string,
  );
  expect(toolPrompt("gh", "en")).toContain(
    "`gh` is a required tool and is always in the Folder instructions",
  );
  for (const name of ["t3", "codex", "gog"]) {
    expect(toolPrompt(name, "en")).toBeUndefined();
    const unknown = await runToolsCommand(["prompt", name, "--json"], context);
    expect(unknown.code).toBe(2);
    expect(unknown.result).toEqual({
      kind: "blocked",
      reason: "tool-unknown",
      tool: name,
      known: ["gh", "composio", "wacli", "gogcli", "neon"],
    });
  }
  for (const args of [
    ["prompt"],
    ["prompt", "neon", "extra"],
    ["prompt", "neon", "--locale", "de"],
    ["prompt", "neon", "--folder", "/tmp"],
    ["prompt", "neon", "--expected-revision", "1"],
    ["status", "--locale", "cs"],
  ])
    await expect(runToolsCommand(args, context)).rejects.toThrow(/Usage/);
});
