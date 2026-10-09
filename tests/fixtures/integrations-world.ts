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
import { updateTools } from "../../src/folder/update-profile";
import type { ExecutorEndpoint } from "../../src/integrations/executor-client";
import type { IntegrationsSeams } from "../../src/launchpad/integrations-routes";
import { startLaunchpad } from "../../src/launchpad/server";
import { toolsEnvironmentOf } from "../../src/tools/overview";
import { type FakeExecutor, startFakeExecutor } from "./fake-executor-api";

// The world of the Integrace contract (decision F42): a private home whose
// PATH holds a fake `gh` and a fake `composio`, Executor's console token in
// `~/.executor/server-control/auth.json` (0600) holding a canary, and a fake
// Executor on a loopback port of its own. Each fake CLI is a POSIX wrapper
// that runs a script of this directory with the Bun that runs the tests.
// Nothing here reaches a vendor, the network or port 4789.

/** One account as the fake composio keeps it. */
export type FakeAccount = {
  id: string;
  toolkit: string;
  status: string;
  alias: string | null;
  word_id: string;
};

export type FakeComposioState = {
  signedIn: boolean;
  removeYes: boolean;
  next: number;
  accounts: FakeAccount[];
  /** The preview's stand-in: a link's account is active at once. */
  activateOnLink?: boolean;
};

/** Executor's console token: it may reach the fake Executor only. */
export const tokenCanary = "executorTokenCanary0000000000000000000000";

const fixtures = import.meta.dir;
const wrapper = (script: string) =>
  `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(fixtures, script)}' "$@"\n`;

async function executable(path: string, content: string) {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
}

// gh as `tools status` and the sign-in probe ask it: signed in while
// `~/gh.signed-in` exists.
const fakeGh = `#!/bin/sh
case "$*" in
  "--version") echo "gh version 2.101.0 (2026-09-01)"; exit 0;;
  "auth status --json hosts")
    if [ -f "$HOME/gh.signed-in" ]; then
      echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"example-user","tokenSource":"keyring","scopes":"repo"}]}}'
    else
      echo '{"hosts":{}}'
    fi
    exit 0;;
esac
exit 1
`;

const toolkits = [
  "notion",
  "gmail",
  "slack",
  "salesforce",
  "outlook",
  "github",
  "linear",
  "todoist",
].map((slug) => ({
  name: slug,
  slug,
  auth_schemes: ["OAUTH2"],
  composio_managed_auth_schemes: ["OAUTH2"],
  is_local_toolkit: false,
  meta: { description: slug, categories: [] },
  no_auth: false,
}));

export type IntegrationsWorld = Readonly<{
  home: string;
  path: string;
  executor: FakeExecutor;
  /** The Executor host the Launchpad gets: the fake's port, this account. */
  executorHost: (owned?: boolean) => ExecutorEndpoint;
}>;

export async function integrationsWorld(
  parent: string,
  options: Readonly<{
    composio?: Partial<FakeComposioState> | false;
    gh?: boolean;
    executorSeed?: Parameters<typeof startFakeExecutor>[1];
  }> = {},
): Promise<IntegrationsWorld> {
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await executable(join(bin, "gh"), fakeGh);
  if (options.gh !== false) await writeFile(join(home, "gh.signed-in"), "");
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
    await mkdir(join(home, ".composio"), { mode: 0o700 });
    await writeFile(
      join(home, ".composio", "toolkits.json"),
      JSON.stringify(toolkits),
    );
  }
  const control = join(home, ".executor", "server-control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeFile(
    join(control, "auth.json"),
    `${JSON.stringify({ token: tokenCanary }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(join(control, "auth.json"), 0o600);
  const executor = await startFakeExecutor(tokenCanary, options.executorSeed);
  const uid = process.getuid?.() ?? 0;
  return {
    home,
    path: bin,
    executor,
    executorHost: (owned = true) => ({
      dataDir: join(home, ".executor"),
      port: executor.port,
      uid,
      ownsListener: async () => owned,
    }),
  };
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

/** The person finished (or abandoned) a Composio sign-in. */
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

/** Every argv the fake composio was called with, in order. */
export async function composioCalls(home: string): Promise<string[][]> {
  try {
    return (await readFile(join(home, ".fake-composio", "calls.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

/** Every regular file under `root` whose bytes contain `needle`. Links are
 * not followed. */
export async function filesContaining(
  root: string,
  needle: string,
): Promise<string[]> {
  const found: string[] = [];
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
        const content = await readFile(path).catch(() => null);
        if (content?.includes(bytes)) found.push(path);
      }
    }
  }
  await walk(root);
  return found;
}

/** A Launchpad on a new workstation Folder at `<parent>/Lazurio` whose tools
 * environment is the world's PATH and home and whose Executor is the fake.
 * Every call carries the session token and the origin, as the page does. */
export async function worldLaunchpad(
  parent: string,
  world: IntegrationsWorld,
  options: Readonly<{
    locale?: "cs" | "en";
    /** The tools switched on for agents (composio, wacli…). */
    tools?: readonly string[];
    seams?: Partial<IntegrationsSeams>;
  }> = {},
) {
  const folder = join(parent, "Lazurio");
  await initializeFolder(
    folder,
    presetProfile("local", executionOs(process.platform), {
      locale: options.locale ?? "en",
    }),
  );
  if (options.tools !== undefined && options.tools.length > 0) {
    const updated = await updateTools(folder, 1, [...options.tools].sort());
    if (updated.kind !== "updated") throw new Error("Tools not recorded");
  }
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
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Executor's setup (decision F44) is not part of these tests.
    undefined,
    {
      executor: world.executorHost(),
      // The tests' Folder is a workstation's, where decision F44 installs no
      // Executor; the fake stands in for a Remote Environment's.
      executorPresent: true,
      environmentBrowser: null,
      now: () => new Date("2026-10-09T12:00:00.000Z"),
      ...options.seams,
    },
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

/** Everything the process writes to the console while a test runs. */
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
