import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutorContext,
  ExecutorHost,
  ExecutorJournalEntry,
} from "../../src/executor/flow";
import type { ExecutorPin } from "../../src/executor/pin";
import { runTool } from "../../src/tools/status";

// A fake Executor world (decision F44). Nothing here reaches the npm
// registry, a vendor or a real service manager: the registry is an injected
// fetch serving tarballs built here, npm a shell script that unpacks them
// into the prefix as `npm install --global --prefix` lays them out, the
// program a shell script that answers `--version` and `install` (writing the
// unit as `executor install` does and starting it through `systemctl`), the
// user manager a shell script keeping its state under
// `$HOME/systemd-world`, and Codex and Claude Code small scripts that keep
// their MCP servers where the real ones do. Every call is recorded under
// `$HOME`. Every name and value is invented.

export const fakeVersion = "1.6.10";
const registry = "https://registry.example.invalid/executor/-";

/** The program of the platform package: `--version`, and `install` as
 * Executor 1.6.10's Linux backend does it (the unit with the program's own
 * path, `daemon-reload`, `enable --now`). Each call records its arguments,
 * both switches, its PATH and whether Lazurio's drop-in was already there. */
export const fakeProgram = (version: string) => String.raw`#!/bin/sh
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
dropin="$HOME/.config/systemd/user/sh.executor.daemon.service.d/lazurio.conf"
printf '%s|analytics=%s|update=%s|path=%s|data=%s|dropin=%s\n' "$*" "$EXECUTOR_DISABLE_ANALYTICS" "$EXECUTOR_DISABLE_UPDATE_CHECK" "$PATH" "$EXECUTOR_DATA_DIR" "$([ -f "$dropin" ] && echo yes || echo no)" >> "$HOME/executor.calls"
case "$1" in
--version) echo "executor v${version}"; exit 0;;
install)
  if [ -f "$HOME/executor-world/install-fails" ]; then echo "did not publish a reachable server manifest" >&2; exit 1; fi
  dir="$HOME/.config/systemd/user"
  mkdir -p "$dir"
  printf '[Unit]\nDescription=Executor supervised daemon\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=%s daemon run --foreground --port 4789 --hostname 127.0.0.1\nEnvironment=EXECUTOR_SUPERVISED=1\nEnvironment=PATH=%s\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n' "$self" "$PATH" > "$dir/sh.executor.daemon.service"
  # The world's fake user manager, never the system's: its directory is
  # recorded in $HOME/fake-tools.
  sc="$(cat "$HOME/fake-tools" 2>/dev/null)/systemctl"
  [ -x "$sc" ] || { echo "fake executor: no fake systemctl" >&2; exit 70; }
  "$sc" --user daemon-reload
  "$sc" --user enable --now sh.executor.daemon.service || exit 1
  echo "Executor is now running as a background service at http://127.0.0.1:4789."
  exit 0;;
mcp) exit 0;;
esac
echo "fake executor: unknown command $1" >&2
exit 64
`;

/** The user manager of the one unit: `show`, `daemon-reload`, `enable
 * [--now]`, `start`, `restart`, `stop`, `reset-failed`. `unreachable` makes
 * every call fail; `start-fails` a start; `silent` keeps the service from
 * answering until a restart clears it, unless `stays-silent`. */
const fakeSystemctl = String.raw`#!/bin/sh
world="$HOME/systemd-world"
mkdir -p "$world"
echo "$*" >> "$HOME/systemctl.calls"
if [ -f "$world/unreachable" ]; then echo "Failed to connect to bus" >&2; exit 1; fi
[ "$1" = "--user" ] || exit 64
shift
unit=sh.executor.daemon.service
state() { cat "$world/active" 2>/dev/null || echo inactive; }
case "$1" in
show)
  if [ -f "$HOME/.config/systemd/user/$unit" ]; then load=loaded; else load=not-found; fi
  if [ -f "$world/enabled" ]; then file=enabled; elif [ "$load" = loaded ]; then file=disabled; else file=""; fi
  printf 'LoadState=%s\nActiveState=%s\nUnitFileState=%s\n' "$load" "$(state)" "$file"
  exit 0;;
daemon-reload) exit 0;;
enable)
  touch "$world/enabled"
  if [ "$2" = "--now" ]; then echo active > "$world/active"; fi
  exit 0;;
start)
  if [ -f "$world/start-fails" ]; then echo failed > "$world/active"; exit 1; fi
  echo active > "$world/active"; exit 0;;
restart)
  [ -f "$world/stays-silent" ] || rm -f "$world/silent"
  echo active > "$world/active"; exit 0;;
stop) echo inactive > "$world/active"; exit 0;;
reset-failed) if [ "$(state)" = failed ]; then echo inactive > "$world/active"; fi; exit 0;;
esac
exit 64
`;

const fakeLoginctl = `#!/bin/sh
echo "$*" >> "$HOME/loginctl.calls"
echo yes
`;

/** npm as Lazurio uses it: `install --global --prefix <prefix> … <spec>`,
 * where the spec is the launcher's tarball or `<alias>@file:<tarball>`. It
 * records its arguments and the configuration it was given. */
const fakeNpm = String.raw`#!/bin/sh
printf '%s|userconfig=%s|globalconfig=%s|cache=%s|offline=%s|scripts=%s|home=%s\n' "$*" "$npm_config_userconfig" "$npm_config_globalconfig" "$npm_config_cache" "$npm_config_offline" "$npm_config_ignore_scripts" "$HOME" >> "$HOME/npm.calls"
if [ -f "$HOME/npm-world/fail" ]; then echo "npm error fake failure" >&2; exit 1; fi
prefix=""; prev=""; spec=""
for a in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$a"; fi
  prev="$a"; spec="$a"
done
case "$spec" in
*@file:*) name="$(printf '%s' "$spec" | sed 's/@file:.*//')"; file="$(printf '%s' "$spec" | sed 's/^[^@]*@file://')";;
*) name=executor; file="$spec";;
esac
if [ -f "$HOME/npm-world/skip-platform" ] && [ "$name" != executor ]; then echo "added 0 packages"; exit 0; fi
tmp="$prefix/.fake-npm-$$"
mkdir -p "$tmp"
tar -xzf "$file" -C "$tmp" || exit 1
mkdir -p "$prefix/lib/node_modules"
rm -rf "$prefix/lib/node_modules/$name"
mv "$tmp/package" "$prefix/lib/node_modules/$name"
rm -rf "$tmp"
if [ "$name" = executor ]; then
  mkdir -p "$prefix/bin"
  ln -sf ../lib/node_modules/executor/bin/executor "$prefix/bin/executor"
fi
echo "added 1 package"
`;

const fakeNode = "#!/bin/sh\necho v24.21.0\n";

/** Codex's `mcp get <name> --json` and `mcp add <name> [--env K=V]… --
 * <command> <args…>`, kept in `$CODEX_HOME` (default `~/.codex`). */
const fakeCodex = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const home = process.env.HOME;
const dir = process.env.CODEX_HOME ?? home + "/.codex";
const store = dir + "/fake-mcp.json";
const argv = process.argv.slice(2);
appendFileSync(home + "/codex.calls", argv.join(" ") + "|codex_home=" + (process.env.CODEX_HOME ?? "") + "\n");
const servers = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
if (argv[0] === "--version") { console.log("codex-cli 0.161.0"); process.exit(0); }
if (argv[0] === "mcp" && argv[1] === "get" && argv[3] === "--json") {
  const name = argv[2];
  if (!Object.hasOwn(servers, name)) { console.error("Error: No MCP server named '" + name + "' found."); process.exit(1); }
  const server = servers[name];
  console.log(JSON.stringify({ name, enabled: server.enabled ?? true, disabled_reason: null, transport: server.transport, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }, null, 2));
  process.exit(0);
}
if (argv[0] === "mcp" && argv[1] === "add") {
  if (existsSync(home + "/codex-world/add-fails")) { console.error("Error: cannot write config"); process.exit(1); }
  const name = argv[2];
  const env = {};
  let index = 3;
  while (index < argv.length && argv[index] !== "--") {
    if (argv[index] !== "--env") process.exit(2);
    const [key, value] = argv[index + 1].split("=");
    env[key] = value;
    index += 2;
  }
  const [command, ...args] = argv.slice(index + 1);
  servers[name] = { transport: { type: "stdio", command, args, env: Object.keys(env).length === 0 ? null : env, env_vars: [], cwd: null } };
  mkdirSync(dir, { recursive: true });
  writeFileSync(store, JSON.stringify(servers));
  console.log("Added global MCP server '" + name + "'.");
  process.exit(0);
}
process.exit(64);
`;

/** Claude Code's `mcp add --scope user <name> [-e K=V]… -- <command>
 * <args…>`, in the top-level `mcpServers` of `~/.claude.json` (or the one in
 * `$CLAUDE_CONFIG_DIR`); every other key of that file is kept. */
const fakeClaude = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const home = process.env.HOME;
const file = (process.env.CLAUDE_CONFIG_DIR ?? home) + "/.claude.json";
const argv = process.argv.slice(2);
appendFileSync(home + "/claude.calls", argv.join(" ") + "|traffic=" + (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "") + "|config=" + (process.env.CLAUDE_CONFIG_DIR ?? "") + "\n");
if (argv[0] === "--version") { console.log("2.1.283 (Claude Code)"); process.exit(0); }
if (argv[0] === "mcp" && argv[1] === "add" && argv[2] === "--scope" && argv[3] === "user") {
  if (existsSync(home + "/claude-world/add-fails")) { console.error("cannot write"); process.exit(1); }
  const name = argv[4];
  const env = {};
  let index = 5;
  while (index < argv.length && argv[index] !== "--") {
    if (argv[index] !== "-e") process.exit(2);
    const [key, value] = argv[index + 1].split("=");
    env[key] = value;
    index += 2;
  }
  const [command, ...args] = argv.slice(index + 1);
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  config.mcpServers ??= {};
  if (Object.hasOwn(config.mcpServers, name)) { console.error("MCP server " + name + " already exists in user config"); process.exit(1); }
  config.mcpServers[name] = { type: "stdio", command, args, env };
  writeFileSync(file, JSON.stringify(config, null, 2));
  console.log("Added stdio MCP server " + name + " to user config");
  process.exit(0);
}
process.exit(64);
`;

export async function writeExecutable(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function tarOf(directory: string, out: string) {
  // No AppleDouble files of macOS's tar in the archive.
  const child = Bun.spawn(["tar", "-czf", out, "-C", directory, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
  return new Uint8Array(await readFile(out));
}

export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** The two tarballs of one version: the launcher package and a platform
 * package whose program reports `programVersion` (the pinned version unless
 * a test wants a liar). */
export async function fakeTarballs(
  directory: string,
  options: Readonly<{
    version?: string | undefined;
    programVersion?: string | undefined;
  }> = {},
) {
  const version = options.version ?? fakeVersion;
  const build = async (name: string, files: Record<string, string>) => {
    const root = join(directory, name);
    await mkdir(join(root, "package", "bin"), { recursive: true });
    for (const [path, text] of Object.entries(files))
      await writeExecutable(join(root, "package", path), text);
    return tarOf(root, join(directory, `${name}.tgz`));
  };
  const main = await build("main", {
    "package.json": JSON.stringify({
      name: "executor",
      version,
      bin: { executor: "bin/executor" },
      optionalDependencies: {
        "executor-linux-x64": `npm:executor@${version}-linux-x64`,
      },
    }),
    "bin/executor": "#!/usr/bin/env node\nprocess.exit(1);\n",
  });
  const platforms = {
    "linux-x64": await build("linux-x64", {
      "package.json": JSON.stringify({
        name: "executor",
        version: `${version}-linux-x64`,
      }),
      "bin/executor": fakeProgram(options.programVersion ?? version),
    }),
    "linux-arm64": await build("linux-arm64", {
      "package.json": JSON.stringify({
        name: "executor",
        version: `${version}-linux-arm64`,
      }),
      "bin/executor": fakeProgram(options.programVersion ?? version),
    }),
  };
  const pin: ExecutorPin = {
    version,
    main: {
      url: `${registry}/executor-${version}.tgz`,
      integrity: integrityOf(main),
    },
    platforms: {
      "linux-x64": {
        url: `${registry}/executor-${version}-linux-x64.tgz`,
        integrity: integrityOf(platforms["linux-x64"]),
      },
      "linux-arm64": {
        url: `${registry}/executor-${version}-linux-arm64.tgz`,
        integrity: integrityOf(platforms["linux-arm64"]),
      },
    },
  };
  const bytes = new Map<string, Uint8Array>([
    [pin.main.url, main],
    [pin.platforms["linux-x64"].url, platforms["linux-x64"]],
    [pin.platforms["linux-arm64"].url, platforms["linux-arm64"]],
  ]);
  return { pin, bytes };
}

/** The registry: only the pinned addresses answer; every request is
 * counted, and `tamper` swaps the bytes of one address. */
export function fakeRegistry(bytes: Map<string, Uint8Array>) {
  const requests: string[] = [];
  const tampered = new Set<string>();
  return {
    requests,
    tamper(url: string) {
      tampered.add(url);
    },
    restore() {
      tampered.clear();
    },
    fetch: async (url: string) => {
      requests.push(url);
      const body = bytes.get(url);
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(
        new Uint8Array(
          tampered.has(url)
            ? new TextEncoder().encode("not the tarball")
            : body,
        ),
      );
    },
  };
}

export type ExecutorWorld = Awaited<ReturnType<typeof executorWorld>>;

/** A private home with `~/.local/bin` first on PATH, the fakes after it,
 * and the system's tools last. */
export async function executorWorld(
  options: Readonly<{
    codex?: boolean;
    claude?: boolean;
    npm?: boolean;
    node?: boolean;
    context?: ExecutorContext;
    programVersion?: string;
    version?: string;
  }> = {},
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "executor-")));
  const home = join(parent, "home");
  const fakes = join(parent, "fakes");
  await mkdir(home, { recursive: true });
  await mkdir(fakes);
  await writeExecutable(join(fakes, "systemctl"), fakeSystemctl);
  await writeExecutable(join(fakes, "loginctl"), fakeLoginctl);
  if (options.npm !== false) await writeExecutable(join(fakes, "npm"), fakeNpm);
  if (options.node !== false)
    await writeExecutable(join(fakes, "node"), fakeNode);
  if (options.codex !== false)
    await writeExecutable(join(fakes, "codex"), fakeCodex);
  if (options.claude !== false)
    await writeExecutable(join(fakes, "claude"), fakeClaude);
  await symlink(process.execPath, join(fakes, "bun"));
  await writeFile(join(home, "fake-tools"), fakes);
  const tarballs = await fakeTarballs(join(parent, "tarballs"), {
    version: options.version,
    programVersion: options.programVersion,
  });
  const registryFake = fakeRegistry(tarballs.bytes);
  const path = `${join(home, ".local", "bin")}:${fakes}:/usr/bin:/bin`;
  const journal: ExecutorJournalEntry[] = [];
  const answers = async () => {
    const world = join(home, "systemd-world");
    const active = await readFile(join(world, "active"), "utf8").catch(
      () => "",
    );
    const silent = await readFile(join(world, "silent"), "utf8").then(
      () => true,
      () => false,
    );
    return active.trim() === "active" && !silent;
  };
  const host: ExecutorHost = {
    context: async () => options.context ?? { kind: "supported" },
    home,
    bin: join(home, ".local", "bin"),
    root: join(home, ".local", "share", "executor-cli"),
    path,
    env: {
      HOME: home,
      PATH: path,
      XDG_RUNTIME_DIR: join(parent, "run"),
    },
    platform: "linux",
    arch: "x64",
    run: runTool,
    uid: 1000,
    fetch: registryFake.fetch,
    probe: answers,
    pin: tarballs.pin,
    journal: (entry) => journal.push(entry),
    lockMs: 0,
    healthDeadlineMs: 2_000,
  };
  const lines = async (name: string) =>
    (await readFile(join(home, name), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.length > 0);
  return {
    parent,
    home,
    fakes,
    path,
    host,
    pin: tarballs.pin,
    registry: registryFake,
    journal,
    answers,
    /** One recorded call per line: `npm.calls`, `executor.calls`,
     * `systemctl.calls`, `codex.calls`, `claude.calls`. */
    calls: lines,
    async flag(path: string, present = true) {
      const file = join(home, path);
      if (present) {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "");
      } else await rm(file, { force: true });
    },
    async setActive(state: string) {
      await mkdir(join(home, "systemd-world"), { recursive: true });
      await writeFile(join(home, "systemd-world", "active"), `${state}\n`);
    },
    async close() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}
