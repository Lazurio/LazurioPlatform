// The operator's tools that `lazurio tools` reports and, on instruction, updates
// (decision 0161 / F17, docs/environment-tools.md). A thin orchestration of each
// tool's OFFICIAL update path: the tool's own updater where it has one, the
// vendor's installer script where that is the documented path, and only a
// report with the official source where neither exists. Nothing here pins,
// downgrades or chooses a package manager.
export type ToolUpdater =
  | Readonly<{ kind: "self"; argv: readonly string[] }>
  | Readonly<{ kind: "installer"; posix: string; windows: string }>
  | Readonly<{ kind: "none" }>;

export type ToolEntry = Readonly<{
  name: string;
  command: string;
  versionArgs: readonly string[];
  source: string;
  updater: ToolUpdater;
}>;

const tool = (entry: ToolEntry): ToolEntry => Object.freeze(entry);

export const toolCatalog: readonly ToolEntry[] = Object.freeze([
  tool({
    name: "codex",
    command: "codex",
    versionArgs: ["--version"],
    source: "https://developers.openai.com/codex/cli",
    // The official standalone installer installs and updates Codex
    // (manual/organization-install.md "Codex CLI: instalace a aktualizace").
    updater: {
      kind: "installer",
      // Two steps, so a failed download can never run half a script or pass
      // as an update: fetch to a private file, then run it.
      posix:
        'set -eu; f="$(mktemp)"; trap \'rm -f "$f"\' EXIT; curl -fsSL https://chatgpt.com/codex/install.sh -o "$f"; sh "$f"',
      windows:
        "$ErrorActionPreference = 'Stop'; $s = irm https://chatgpt.com/codex/install.ps1; iex $s",
    },
  }),
  tool({
    name: "claude",
    command: "claude",
    versionArgs: ["--version"],
    source: "https://docs.claude.com/en/docs/claude-code/setup",
    updater: { kind: "self", argv: ["update"] },
  }),
  tool({
    name: "gh",
    command: "gh",
    versionArgs: ["--version"],
    source: "https://github.com/cli/cli#installation",
    updater: { kind: "none" },
  }),
  tool({
    name: "git",
    command: "git",
    versionArgs: ["--version"],
    source: "https://git-scm.com/downloads",
    updater: { kind: "none" },
  }),
  tool({
    name: "node",
    command: "node",
    versionArgs: ["--version"],
    source: "https://nodejs.org/en/download",
    updater: { kind: "none" },
  }),
  tool({
    name: "npm",
    command: "npm",
    versionArgs: ["--version"],
    source: "https://nodejs.org/en/download",
    updater: { kind: "none" },
  }),
  tool({
    name: "bun",
    command: "bun",
    versionArgs: ["--version"],
    source: "https://bun.sh/docs/installation",
    updater: { kind: "self", argv: ["upgrade"] },
  }),
]);

export function findTool(name: string): ToolEntry | undefined {
  return toolCatalog.find((entry) => entry.name === name);
}
