import { spyOn } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { initializeFolder } from "../../src/folder/initialize-folder";
import { executionOs } from "../../src/folder/platform";
import { presetProfile } from "../../src/folder/presets";
import { startLaunchpad } from "../../src/launchpad/server";
import { toolsEnvironmentOf } from "../../src/tools/overview";

// The world of the connected-apps contract (decision F42, proposed,
// docs/connected-apps.md): a private home whose PATH holds fake `composio`,
// `claude` and `codex` executables, the CLI's public catalog cache, a key file
// that must never be read, and a fake MCP server. Each fake is a POSIX
// wrapper that runs a script of this directory with the Bun that runs the
// tests, so the PATH needs nothing else. Nothing here reaches a vendor or
// the network.

/** One account as the fake composio keeps it: a connected account of
 * Composio with its status, the alias given at `link` and its `word_id`. */
export type FakeAccount = {
  id: string;
  toolkit: string;
  status: string;
  alias: string | null;
  word_id: string;
};

/** The fake composio's state: signed in or not, whether its `connections
 * remove` knows `--yes` (the flag proposed upstream, M3) and its accounts. */
export type FakeComposioState = {
  signedIn: boolean;
  removeYes: boolean;
  next: number;
  accounts: FakeAccount[];
};

/** What `~/.composio/user_data.json` holds: the operator's key, as the real
 * CLI keeps it. Lazurio never reads that file, so this never appears
 * anywhere. */
export const keyCanary = "composio-user-key-canary-0000";

// The CLI's catalog cache in its real shape (`~/.composio/toolkits.json`):
// alphabetical by slug, with no logos and no popularity. `codeinterpreter`
// needs no connection, as Composio's own built-ins do.
const cached = (
  slug: string,
  name: string,
  description: string,
  category: string,
  auth: "managed" | "api-key" | "none",
) => ({
  name,
  slug,
  auth_schemes:
    auth === "none"
      ? ["NO_AUTH"]
      : auth === "managed"
        ? ["OAUTH2"]
        : ["API_KEY"],
  composio_managed_auth_schemes: auth === "managed" ? ["OAUTH2"] : [],
  is_local_toolkit: false,
  meta: {
    description,
    categories: [{ id: category, name: category }],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    available_versions: [],
    tools_count: 10,
    triggers_count: 0,
  },
  no_auth: auth === "none",
});
export const fakeCatalog = Object.freeze([
  cached(
    "aaa_tool",
    "AAA Tool",
    "A tool whose slug sorts first.",
    "productivity",
    "api-key",
  ),
  cached(
    "airtable",
    "Airtable",
    "Tables with a database behind them.",
    "productivity",
    "managed",
  ),
  cached(
    "codeinterpreter",
    "Code Interpreter",
    "Runs code; needs no connection.",
    "developer-tools",
    "none",
  ),
  cached("gmail", "Gmail", "Email from Google.", "email", "managed"),
  cached(
    "linear",
    "Linear",
    "Issues and projects of product teams.",
    "productivity",
    "managed",
  ),
  cached(
    "notion",
    "Notion",
    "Notes, documents and wikis.",
    "productivity",
    "managed",
  ),
  cached(
    "slack",
    "Slack",
    "Team chat in channels.",
    "communication",
    "managed",
  ),
  cached(
    "zzz_tool",
    "ZZZ Tool",
    "A tool whose slug sorts last.",
    "productivity",
    "api-key",
  ),
]);

const fixtures = import.meta.dir;
const wrapper = (script: string) =>
  `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(fixtures, script)}' "$@"\n`;

async function executable(path: string, content: string) {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
}

export type ConnectionsWorld = Readonly<{
  home: string;
  /** The PATH of the tools environment: only the fake tools. */
  path: string;
  /** The absolute command of the fake MCP server (an MCP server's command). */
  mcpServer: string;
}>;

/** A private home under `parent` with the fake tools. `composio: false`
 * leaves composio out; `claudeServers` are user-scope servers Claude Code
 * already has, made by hand; `codexConfig` is the operator's own
 * `~/.codex/config.toml`. */
export async function connectionsWorld(
  parent: string,
  options: Readonly<{
    composio?: Partial<FakeComposioState> | false;
    claudeServers?: Record<string, unknown>;
    codexConfig?: string;
  }> = {},
): Promise<ConnectionsWorld> {
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".config"), { recursive: true, mode: 0o700 });
  if (options.composio !== false) {
    await executable(join(bin, "composio"), wrapper("fake-composio.ts"));
    await mkdir(join(home, ".fake-composio"), { mode: 0o700 });
    await writeComposioState(home, {
      signedIn: true,
      removeYes: false,
      next: 100,
      accounts: [],
      ...options.composio,
    });
    const store = join(home, ".composio");
    await mkdir(store, { mode: 0o700 });
    await writeFile(join(store, "toolkits.json"), JSON.stringify(fakeCatalog));
    const key = join(store, "user_data.json");
    await writeFile(key, JSON.stringify({ api_key: keyCanary }), {
      mode: 0o600,
    });
    // Unreadable: whatever needs it fails, and nothing may need it.
    await chmod(key, 0o000);
  }
  await executable(join(bin, "claude"), wrapper("fake-claude.ts"));
  await mkdir(join(home, ".fake-claude"), { mode: 0o700 });
  await writeFile(
    join(home, ".fake-claude", "servers.json"),
    JSON.stringify(options.claudeServers ?? {}),
    { mode: 0o600 },
  );
  await executable(
    join(bin, "codex"),
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo "codex-cli 0.161.0"; exit 0; }\nexit 1\n`,
  );
  if (options.codexConfig !== undefined) {
    await mkdir(join(home, ".codex"), { mode: 0o700 });
    await writeFile(join(home, ".codex", "config.toml"), options.codexConfig, {
      mode: 0o600,
    });
  }
  const servers = join(home, ".local", "mcp");
  await mkdir(servers, { recursive: true, mode: 0o700 });
  const mcpServer = join(servers, "fake-mcp-server");
  await executable(mcpServer, wrapper("fake-mcp-server.ts"));
  return { home, path: bin, mcpServer };
}

export async function readComposioState(
  home: string,
): Promise<FakeComposioState> {
  return JSON.parse(
    await readFile(join(home, ".fake-composio", "state.json"), "utf8"),
  ) as FakeComposioState;
}

export async function writeComposioState(
  home: string,
  state: FakeComposioState,
): Promise<void> {
  const target = join(home, ".fake-composio", "state.json");
  await writeFile(`${target}.test`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${target}.test`, target);
}

/** The person finished (or abandoned) the sign-in in their browser:
 * Composio now reports this status for the account. */
export async function setAccountStatus(
  home: string,
  id: string,
  status: string,
): Promise<void> {
  const state = await readComposioState(home);
  const account = state.accounts.find((entry) => entry.id === id);
  if (account === undefined) throw new Error(`No fake account ${id}`);
  account.status = status;
  await writeComposioState(home, state);
}

async function lines(file: string): Promise<string[][]> {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

/** Every argv the fake composio was called with, in order. */
export const composioCalls = (home: string) =>
  lines(join(home, ".fake-composio", "calls.jsonl"));

/** Every argv the fake claude was called with, in order. */
export const claudeCalls = (home: string) =>
  lines(join(home, ".fake-claude", "calls.jsonl"));

/** Claude Code's user-scope MCP servers, as the fake keeps them. */
export async function claudeServers(
  home: string,
): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(
    await readFile(join(home, ".fake-claude", "servers.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
}

/** Every regular file under `root` whose bytes contain `needle`, with its
 * permission bits. Links are not followed. */
export async function filesContaining(
  root: string,
  needle: string,
): Promise<{ path: string; mode: number }[]> {
  const found: { path: string; mode: number }[] = [];
  const bytes = Buffer.from(needle);
  async function walk(directory: string) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        let content: Buffer;
        try {
          content = await readFile(path);
        } catch {
          continue;
        }
        if (content.includes(bytes))
          found.push({ path, mode: stat.mode & 0o777 });
      }
    }
  }
  await walk(root);
  return found;
}

/** A Launchpad on a new workstation Folder at `<parent>/Lazurio`, beside the
 * world's home and outside it, whose tools environment is the world's PATH
 * and home. Every call carries the session token, as the page does. */
export async function worldLaunchpad(
  parent: string,
  world: ConnectionsWorld,
  locale: "cs" | "en",
) {
  const folder = join(parent, "Lazurio");
  await initializeFolder(
    folder,
    presetProfile("local", executionOs(process.platform), { locale }),
  );
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    toolsEnvironmentOf(
      { PATH: world.path, HOME: world.home },
      process.platform,
    ),
  );
  const url = new URL(app.url);
  const authorization = `Bearer ${url.hash.slice(1)}`;
  return {
    folder,
    url,
    get: (path: string) =>
      fetch(new URL(path, url), { headers: { Authorization: authorization } }),
    post: (path: string, body: unknown) =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: {
          Authorization: authorization,
          Origin: url.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    close: () => app.close(),
  };
}

/** Everything the process writes to the console while a test runs (the
 * Launchpad journals there), as text. */
export function captureConsole() {
  const spies = (["log", "info", "warn", "error"] as const).map((name) =>
    spyOn(console, name),
  );
  return {
    text: () =>
      spies
        .flatMap((spy) =>
          spy.mock.calls.flat().map((value) => Bun.inspect(value)),
        )
        .join("\n"),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
