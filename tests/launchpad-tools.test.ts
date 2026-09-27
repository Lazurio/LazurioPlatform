import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { startLaunchpad } from "../src/launchpad/server";
import { parseToolsOverview } from "../src/launchpad/tools-view";
import { mcpServerPrompt, toolPrompt } from "../src/tools/catalog";
import { runTool, type ToolRunner } from "../src/tools/status";
import { bindings } from "./fixtures/machine-bindings";

// A fake tool on a private PATH: it answers `--version` and records every
// invocation, so a test can prove which commands the probe ran.
async function fakeTool(
  directory: string,
  name: string,
  version: string,
  exitCode = 0,
): Promise<string> {
  const script = join(directory, name);
  await writeFile(
    script,
    `#!/bin/sh
echo "$@" >> "${join(directory, `${name}.calls`)}"
if [ "$1" = "--version" ]; then echo "${name} version ${version}"; echo "SECRET-LOOKING-OUTPUT-${name}" >&2; exit ${exitCode}; fi
exit 1
`,
  );
  await chmod(script, 0o755);
  return script;
}

type Tool = {
  name: string;
  command: string;
  tier: string;
  setup: string;
  enabled: boolean;
  purpose: string;
  usage: string;
  source: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  versionError?: string;
  standardPath?: boolean;
  prompt: string;
};
type Overview = {
  kind: string;
  revision: number;
  locale: string;
  sharedEnvironment: boolean;
  tools: Tool[];
  mcpPrompt: string;
};

// A Folder, a private home with a private PATH, and a Launchpad on them. The
// process environment is never the source of a fact here.
async function session(
  initialize: (folder: string) => Promise<unknown>,
  prepare: (home: string) => Promise<string[]>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-tools-status-")),
  );
  const home = join(parent, "home");
  await mkdir(join(home, ".config"), { recursive: true, mode: 0o700 });
  const path = (await prepare(home)).join(":");
  const folder = join(parent, "Lazurio");
  await initialize(folder);
  const commands: string[][] = [];
  const run: ToolRunner = (command, timeoutMs, env) => {
    commands.push([...command]);
    expect(env).toEqual({ PATH: path, HOME: home });
    return runTool(command, timeoutMs, {
      ...env,
      XDG_CONFIG_HOME: join(home, ".config"),
    });
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    { path, home, platform: process.platform, run },
  );
  const url = new URL(app.url);
  const call = (path: string, body: unknown, override = {}) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
        ...override,
      },
      body: JSON.stringify(body),
    });
  return {
    parent,
    home,
    folder,
    commands,
    call,
    status: async () =>
      (await (await call("/api/tools/status", {})).json()) as Overview,
    async close() {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const localProfile = (locale: "cs" | "en") => ({
  os: executionOs(process.platform),
  access: "local",
  purpose: "human",
  locale,
  detail: "concise",
  coordination: "direct",
});

test.skipIf(process.platform === "win32")(
  "Launchpad tools status joins the recorded selection with the live facts and runs version commands only",
  async () => {
    const opened = await session(
      (folder) => initializeFolder(folder, localProfile("en")),
      async (home) => {
        const standard = join(home, ".local", "bin");
        const other = join(home, "opt");
        await mkdir(standard, { recursive: true });
        await mkdir(other, { recursive: true });
        await fakeTool(standard, "gh", "2.86.0");
        await fakeTool(other, "composio", "0.7.1");
        await fakeTool(other, "gog", "1.2.3", 7);
        return [standard, other];
      },
    );
    try {
      const before = await readFile(join(opened.folder, "AGENTS.md"), "utf8");
      const entries = await readdir(join(opened.folder, ".lazurio"));
      // The same admission as every other route.
      expect(
        (await opened.call("/api/tools/status", {}, { Authorization: "" }))
          .status,
      ).toBe(403);
      expect(
        (
          await opened.call(
            "/api/tools/status",
            {},
            { Origin: "https://untrusted.example" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await opened.call(
            "/api/tools/status",
            {},
            { "Content-Type": "text/plain" },
          )
        ).status,
      ).toBe(415);
      expect(opened.commands).toEqual([]);
      // No input is accepted: not a Folder, not a PATH.
      for (const body of [
        { folder: opened.parent },
        { path: "/usr/bin" },
        { tools: [] },
      ]) {
        const refused = await opened.call("/api/tools/status", body);
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({
          error: "operation-failed",
          recoveryMayBeRequired: true,
        });
      }
      expect(opened.commands).toEqual([]);

      const response = await opened.call("/api/tools/status", {});
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const raw = await response.text();
      const overview = JSON.parse(raw) as Overview;
      const standard = join(opened.home, ".local", "bin");
      const other = join(opened.home, "opt");
      expect<unknown>(overview).toEqual({
        kind: "tools-status",
        revision: 1,
        locale: "en",
        sharedEnvironment: false,
        mcpPrompt: mcpServerPrompt("en"),
        tools: [
          {
            name: "gh",
            command: "gh",
            tier: "required",
            setup: "launchpad",
            enabled: true,
            purpose:
              "GitHub CLI for work with repositories, pull requests, issues and reviews.",
            usage: expect.stringContaining("gh auth status"),
            source: "https://github.com/cli/cli#installation",
            installed: true,
            path: join(standard, "gh"),
            realPath: join(standard, "gh"),
            version: "2.86.0",
            standardPath: true,
            prompt: toolPrompt("gh", "en") as string,
          },
          {
            name: "composio",
            command: "composio",
            tier: "recommended",
            setup: "launchpad",
            enabled: false,
            purpose: expect.any(String),
            usage: expect.any(String),
            source: "https://docs.composio.dev/docs/cli",
            installed: true,
            path: join(other, "composio"),
            realPath: join(other, "composio"),
            version: "0.7.1",
            standardPath: false,
            prompt: toolPrompt("composio", "en") as string,
          },
          {
            name: "wacli",
            command: "wacli",
            tier: "optional",
            setup: "launchpad",
            enabled: false,
            purpose: expect.any(String),
            usage: expect.any(String),
            source: "https://github.com/openclaw/wacli",
            installed: false,
            prompt: toolPrompt("wacli", "en") as string,
          },
          {
            name: "gogcli",
            command: "gog",
            tier: "optional",
            setup: "agent",
            enabled: false,
            purpose: expect.any(String),
            usage: expect.any(String),
            source: "https://github.com/openclaw/gogcli",
            installed: true,
            path: join(other, "gog"),
            realPath: join(other, "gog"),
            versionError: "exit 7",
            standardPath: false,
            prompt: toolPrompt("gogcli", "en") as string,
          },
          {
            name: "neon",
            command: "neon",
            tier: "optional",
            setup: "agent",
            enabled: false,
            purpose: expect.any(String),
            usage: expect.any(String),
            source: "https://neon.com/docs/reference/neon-cli",
            installed: false,
            prompt: toolPrompt("neon", "en") as string,
          },
        ],
      });
      // What the page accepts is exactly what the server sends.
      expect(parseToolsOverview(JSON.parse(raw))).toEqual(JSON.parse(raw));

      // Only the version command of each found tool ran, once.
      expect(opened.commands).toEqual([
        [join(standard, "gh"), "--version"],
        [join(other, "composio"), "--version"],
        [join(other, "gog"), "--version"],
      ]);
      for (const [directory, name] of [
        [standard, "gh"],
        [other, "composio"],
        [other, "gog"],
      ] as const)
        expect(await readFile(join(directory, `${name}.calls`), "utf8")).toBe(
          "--version\n",
        );

      // Nothing secret-like: no raw tool output, no environment, no token,
      // and no field a credential could travel in.
      expect(raw).not.toContain("SECRET-LOOKING-OUTPUT");
      const fields = new Set<string>();
      const collect = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object")
          for (const [key, inner] of Object.entries(value)) {
            fields.add(key);
            collect(inner);
          }
      };
      collect(overview);
      expect([...fields].sort()).toEqual(
        [
          "command",
          "enabled",
          "installed",
          "kind",
          "locale",
          "mcpPrompt",
          "name",
          "path",
          "prompt",
          "purpose",
          "realPath",
          "revision",
          "setup",
          "sharedEnvironment",
          "source",
          "standardPath",
          "tier",
          "tools",
          "usage",
          "version",
          "versionError",
        ].sort(),
      );
      for (const key of fields)
        expect(key).not.toMatch(
          /token|secret|password|credential|key|output|account|session/i,
        );

      // Reading the status wrote nothing.
      expect(await readFile(join(opened.folder, "AGENTS.md"), "utf8")).toBe(
        before,
      );
      expect(await readdir(join(opened.folder, ".lazurio"))).toEqual(entries);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Launchpad tools status follows the Folder: locale, the enabled flag after an update and the advanced revision",
  async () => {
    const opened = await session(
      (folder) => initializeFolder(folder, localProfile("cs")),
      async (home) => {
        const standard = join(home, ".local", "bin");
        await mkdir(standard, { recursive: true });
        await fakeTool(standard, "gh", "2.86.0");
        return [standard];
      },
    );
    try {
      const first = await opened.status();
      expect(first.locale).toBe("cs");
      expect(first.revision).toBe(1);
      expect(first.mcpPrompt).toBe(mcpServerPrompt("cs"));
      expect(first.mcpPrompt).not.toBe(mcpServerPrompt("en"));
      expect(first.tools.map((tool) => [tool.name, tool.enabled])).toEqual([
        ["gh", true],
        ["composio", false],
        ["wacli", false],
        ["gogcli", false],
        ["neon", false],
      ]);
      for (const tool of first.tools) {
        expect(tool.prompt).toBe(toolPrompt(tool.name, "cs") as string);
        expect(tool.prompt).toContain("Úkol:");
      }
      expect(first.tools[0]?.purpose).toBe(
        "GitHub CLI pro práci s repozitáři, pull requesty, issues a review.",
      );

      // Enabled while not installed: context, not installation.
      const updated = await opened.call("/api/tools/update", {
        expectedRevision: first.revision,
        tools: ["composio", "neon"],
      });
      expect(await updated.json()).toEqual({ kind: "updated", revision: 2 });
      const second = await opened.status();
      expect(second.revision).toBe(2);
      expect(
        second.tools.map((tool) => [tool.name, tool.enabled, tool.installed]),
      ).toEqual([
        ["gh", true, true],
        ["composio", true, false],
        ["wacli", false, false],
        ["gogcli", false, false],
        ["neon", true, false],
      ]);

      // The language of the Folder changes the texts with the next read.
      expect(
        await (
          await opened.call("/api/update", {
            expectedRevision: 2,
            profile: localProfile("en"),
          })
        ).json(),
      ).toEqual({ kind: "updated", revision: 3 });
      const third = await opened.status();
      expect(third.locale).toBe("en");
      expect(third.revision).toBe(3);
      expect(third.mcpPrompt).toBe(mcpServerPrompt("en"));
      expect(third.tools.filter((tool) => tool.enabled)).toHaveLength(3);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Launchpad tools status says when sign-ins are shared: the Team preset",
  async () => {
    const team = await session(
      async (folder) => {
        await mkdir(folder, { mode: 0o700 });
        await mkdir(join(folder, "organizations"), { mode: 0o755 });
        return initializeHandoverFolder(folder, {
          preset: "hosted-organization-team",
          machine: bindings.team,
          profile: presetProfile(
            "hosted-organization-team",
            executionOs(process.platform),
          ),
        });
      },
      async (home) => {
        await mkdir(join(home, "empty"));
        return [join(home, "empty")];
      },
    );
    try {
      const overview = await team.status();
      expect(overview.sharedEnvironment).toBe(true);
      // An empty PATH is a state, not an error.
      expect(overview.tools.map((tool) => tool.installed)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(team.commands).toEqual([]);
    } finally {
      await team.close();
    }
    const personal = await session(
      async (folder) => {
        await mkdir(folder, { mode: 0o700 });
        await mkdir(join(folder, "organizations"), { mode: 0o755 });
        return initializeHandoverFolder(folder, {
          preset: "hosted-organization-personal",
          machine: bindings.organization,
          profile: presetProfile(
            "hosted-organization-personal",
            executionOs(process.platform),
          ),
        });
      },
      async (home) => {
        await mkdir(join(home, "empty"));
        return [join(home, "empty")];
      },
    );
    try {
      expect((await personal.status()).sharedEnvironment).toBe(false);
    } finally {
      await personal.close();
    }
  },
);

test("the MCP prompt carries its rules in both languages", () => {
  for (const [locale, words] of [
    ["en", ["official MCP server", "never", "Lazurio Folder", "browser"]],
    [
      "cs",
      ["oficiálnímu MCP serveru", "nikdy", "Lazurio Folderu", "prohlížeči"],
    ],
  ] as const) {
    const prompt = mcpServerPrompt(locale);
    for (const word of [
      ...words,
      "~/.codex/config.toml",
      "claude mcp add",
      "Git",
    ])
      expect(prompt).toContain(word);
  }
});
