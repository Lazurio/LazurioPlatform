import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspectOwnedDirectory } from "../../folder/owned-directory";
// Bun embeds the server's own text (`with { type: "text" }`); tsc types the
// module, not its text, so the import is checked at runtime below.
// @ts-expect-error The text of a TypeScript file, not the module.
import staticServerText from "./static-server.ts" with { type: "text" };

// Where the built output of a static app is kept (decision F58): outside the
// checkout, in the account's cache, one directory per app and in it one
// directory per build key, beside the app's build state, its last start's
// mode and the logs of its builds:
//
//   ${XDG_CACHE_HOME:-~/.cache}/lazurio/builds/<organization>/<module>/<app>/
//     build.json        current, previous, the build under way, the last failure
//     served.json       what the app's running process was started to serve
//     <key>/            the output of one build, never changed once there
//     logs/<key>.log    the output of the build of that key
//
// Nothing here is the truth of what runs: that stays the app's runner. These
// files say which output exists and which a start chose; a lost cache costs
// one build. The current and previous builds are kept, and any build the
// running process serves; older ones are removed after every build.

const stateSchema = "lazurio.build-state.v1";
const servedSchema = "lazurio.build-served.v1";

/** A build key: the module's commit (40 or 64 hex), or the digest of all the
 * checkouts a build reads (`buildKeyOf`). */
const keyPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const xdg = (
  env: Readonly<Record<string, string | undefined>>,
  name: "XDG_CACHE_HOME" | "XDG_STATE_HOME",
  home: string,
  fallback: readonly string[],
) => {
  // A relative XDG directory is invalid and ignored, as for the install base.
  const value = env[name];
  return value !== undefined && value !== "" && isAbsolute(value)
    ? value
    : join(home, ...fallback);
};

/** `${XDG_CACHE_HOME:-~/.cache}/lazurio/builds`. */
export function buildCacheRoot(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(
    xdg(env, "XDG_CACHE_HOME", home, [".cache"]),
    "lazurio",
    "builds",
  );
}

/** `${XDG_STATE_HOME:-~/.local/state}/lazurio/builds.lock`: one build at a
 * time in the account's Environment, whichever process builds. */
export function buildLockFile(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(
    xdg(env, "XDG_STATE_HOME", home, [".local", "state"]),
    "lazurio",
    "builds.lock",
  );
}

/** The checkout one build reads, by its path relative to the Organization
 * root (`.` the module itself), and its commit; null when it is absent. */
export type BuildInput = Readonly<{ path: string; commit: string | null }>;

/** The key of a build: the module's commit when the build reads nothing but
 * the module; otherwise the digest of every checkout it reads and its
 * commit, so that a change of the module's data repository (a repository
 * database below it) or of a sibling slot it requires builds again too. */
export function buildKeyOf(commit: string, inputs: readonly BuildInput[]) {
  if (inputs.length === 0) return commit;
  return createHash("sha256")
    .update(
      `lazurio.build-key.v1\n. ${commit}\n${inputs
        .map((input) => `${input.path} ${input.commit ?? "absent"}`)
        .sort()
        .join("\n")}\n`,
    )
    .digest("hex");
}

export type BuildRecord = Readonly<{
  key: string;
  /** The module's commit. */
  commit: string;
  inputs: readonly BuildInput[];
  /** The checkout had changes that were not committed; built as it was. */
  dirty: boolean;
  at: string;
}>;

export type BuildFailure = Readonly<{
  key: string;
  commit: string;
  at: string;
  /** `build-script-failed`, `build-timed-out`, `build-output-missing`,
   * `build-output-unservable`, or the preparation's reason. */
  reason: string;
}>;

export type BuildState = Readonly<{
  schema_version: typeof stateSchema;
  /** Which app this is: shown, and read back by the sweep (decision F58). */
  organization: string;
  module: string;
  app: string;
  current: BuildRecord | null;
  previous: BuildRecord | null;
  building: Readonly<{
    key: string;
    commit: string;
    at: string;
    pid: number;
  }> | null;
  failure: BuildFailure | null;
}>;

/** What a static app serves (decision F58): written before a built start
 * and at every swap, which its static server reads (the server serves `key`
 * and, for the assets of pages opened before, `previous`), and after a
 * start of its development version. An app that runs without one was
 * started before builds existed. Always replaced whole, by a rename. */
export type ServedState = Readonly<{
  schema_version: typeof servedSchema;
  mode: "built" | "dev";
  /** The build served, and the module's commit of it. */
  key: string | null;
  commit: string | null;
  /** The build served before it, kept for its assets. Absent in a record
   * of a static server that does not read this record (one started before
   * swaps replaced it): such a server is restarted onto a new build. */
  previous?: string | null;
  at: string;
}>;

export type AppIdentity = Readonly<{
  organization: string;
  module: string;
  app: string;
  runtimeId: string;
  /** The app's package directory, canonical: two checkouts of one module
   * (another Folder) never share a cache. */
  applicationDirectory: string;
}>;

/** The directory of one app's builds. */
export function appBuildDirectory(root: string, identity: AppIdentity) {
  for (const part of [
    identity.organization,
    identity.module,
    identity.runtimeId,
  ])
    if (!segment.test(part)) throw new Error("Invalid build directory name");
  const digest = createHash("sha256")
    .update(identity.applicationDirectory)
    .digest("hex")
    .slice(0, 12);
  return join(
    root,
    identity.organization,
    identity.module,
    `${identity.runtimeId}-${digest}`,
  );
}

function parseState(value: unknown): BuildState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (state.schema_version !== stateSchema) return null;
  const record = (input: unknown): BuildRecord | null => {
    if (!input || typeof input !== "object") return null;
    const item = input as Record<string, unknown>;
    return typeof item.key === "string" &&
      keyPattern.test(item.key) &&
      typeof item.commit === "string" &&
      Array.isArray(item.inputs) &&
      typeof item.dirty === "boolean" &&
      typeof item.at === "string"
      ? (item as BuildRecord)
      : null;
  };
  const building = state.building as Record<string, unknown> | null;
  const failure = state.failure as Record<string, unknown> | null;
  return Object.freeze({
    schema_version: stateSchema,
    organization: String(state.organization),
    module: String(state.module),
    app: String(state.app),
    current: record(state.current),
    previous: record(state.previous),
    building:
      building &&
      typeof building.key === "string" &&
      keyPattern.test(building.key) &&
      typeof building.commit === "string" &&
      typeof building.at === "string" &&
      Number.isSafeInteger(building.pid)
        ? (building as BuildState["building"])
        : null,
    failure:
      failure &&
      typeof failure.key === "string" &&
      typeof failure.commit === "string" &&
      typeof failure.reason === "string" &&
      typeof failure.at === "string"
        ? (failure as BuildFailure)
        : null,
  });
}

async function readJson(path: string): Promise<unknown> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > 64 * 1024) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Written whole or not at all: a temporary file renamed over the old one. */
async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The builds of one app. Every write is whole; the caller holds the build
 * lock for the build state and its outputs. */
export function openBuildStore(directory: string) {
  const statePath = join(directory, "build.json");
  const servedPath = join(directory, "served.json");
  // A build that waits for its turn (one build at a time): its own file, so
  // that it is written without the build lock and never overwrites the
  // build state another process writes under it.
  const queuedPath = join(directory, "queued.json");
  const logs = join(directory, "logs");
  const ensure = async () => {
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await inspectOwnedDirectory(directory);
  };
  return Object.freeze({
    directory,
    /** The record the static server reads. */
    servedFile: servedPath,
    async state(): Promise<BuildState | null> {
      return parseState(await readJson(statePath));
    },
    async writeState(state: BuildState) {
      await ensure();
      await writeJson(statePath, state);
    },
    async served(): Promise<ServedState | null> {
      const value = (await readJson(servedPath)) as Record<
        string,
        unknown
      > | null;
      if (
        !value ||
        value.schema_version !== servedSchema ||
        (value.mode !== "built" && value.mode !== "dev")
      )
        return null;
      return value as ServedState;
    },
    /** A build of this app that waits for its turn, by the process that
     * queued it; null when none is recorded. */
    async queued(): Promise<Readonly<{ at: string; pid: number }> | null> {
      const value = (await readJson(queuedPath)) as Record<
        string,
        unknown
      > | null;
      return value &&
        typeof value.at === "string" &&
        Number.isSafeInteger(value.pid)
        ? (value as Readonly<{ at: string; pid: number }>)
        : null;
    },
    async writeQueued(pid: number, at: string) {
      await ensure();
      await writeJson(queuedPath, { at, pid });
    },
    async clearQueued() {
      await rm(queuedPath, { force: true });
    },
    async writeServed(
      served: Omit<ServedState, "schema_version" | "at" | "previous"> & {
        previous: string | null;
      },
    ) {
      await ensure();
      await writeJson(servedPath, {
        schema_version: servedSchema,
        ...served,
        at: new Date().toISOString(),
      });
    },
    /** The output of a build key, when it is there. */
    async output(key: string): Promise<string | null> {
      if (!keyPattern.test(key)) return null;
      const path = join(directory, key);
      try {
        const entry = await lstat(path);
        return entry.isDirectory() ? path : null;
      } catch {
        return null;
      }
    },
    logFile(key: string) {
      if (!keyPattern.test(key)) throw new Error("Invalid build key");
      return join(logs, `${key}.log`);
    },
    async prepareLogs() {
      await ensure();
    },
    /** Copies a finished build's output in and makes it the directory of its
     * key in one rename: a reader sees the whole output or none. An older
     * output of the same key (a rebuild of a changed checkout) is moved
     * aside first and removed after. */
    async install(source: string, key: string): Promise<string> {
      if (!keyPattern.test(key)) throw new Error("Invalid build key");
      await ensure();
      const incoming = join(
        directory,
        `.incoming-${randomBytes(6).toString("hex")}`,
      );
      const target = join(directory, key);
      try {
        await cp(source, incoming, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        });
        let retired: string | null = null;
        if (
          await lstat(target).then(
            () => true,
            () => false,
          )
        ) {
          retired = join(
            directory,
            `.retired-${randomBytes(6).toString("hex")}`,
          );
          await rename(target, retired);
        }
        await rename(incoming, target);
        if (retired !== null)
          await rm(retired, { recursive: true, force: true });
        return target;
      } catch (error) {
        await rm(incoming, { recursive: true, force: true });
        throw error;
      }
    },
    /** Removes every output, log and leftover not in `keep`. */
    async collect(keep: ReadonlySet<string>) {
      let entries: string[] = [];
      try {
        entries = await readdir(directory);
      } catch {
        return;
      }
      for (const entry of entries)
        if (
          (keyPattern.test(entry) && !keep.has(entry)) ||
          entry.startsWith(".incoming-") ||
          entry.startsWith(".retired-")
        )
          await rm(join(directory, entry), { recursive: true, force: true });
      let logged: string[] = [];
      try {
        logged = await readdir(logs);
      } catch {
        return;
      }
      for (const entry of logged) {
        const key = entry.replace(/\.log$/, "");
        if (entry.endsWith(".log") && keyPattern.test(key) && !keep.has(key))
          await rm(join(logs, entry), { force: true });
      }
    },
  });
}

export type BuildStore = ReturnType<typeof openBuildStore>;

/** The app identities of every build state under `root`: the apps someone
 * opened, which the Launchpad keeps built after a pull (decision F58). */
export async function listBuildStates(
  root: string,
): Promise<readonly Readonly<{ directory: string; state: BuildState }>[]> {
  const found: { directory: string; state: BuildState }[] = [];
  const children = async (path: string) =>
    readdir(path, { withFileTypes: true })
      .then((entries) =>
        entries
          .filter((entry) => entry.isDirectory() && segment.test(entry.name))
          .map((entry) => join(path, entry.name)),
      )
      .catch(() => [] as string[]);
  for (const organization of await children(root))
    for (const module of await children(organization))
      for (const app of await children(module)) {
        const state = await openBuildStore(app).state();
        if (state !== null) found.push({ directory: app, state });
      }
  return found;
}

/** The static server's text, as Bun embeds it in the product. */
export function staticServerSource(): string {
  const text: unknown = staticServerText;
  if (typeof text !== "string" || !text.includes("serveStatic"))
    throw new Error("Static server text unavailable");
  return text;
}

/** The static server's files, written once per version of its text: the
 * script and an empty Bun configuration, so that no bunfig.toml of the app's
 * directory (its working directory) configures the Platform's server. */
export async function staticServerFiles(root: string) {
  const text = staticServerSource();
  const version = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const directory = join(root, ".server", version);
  const script = join(directory, "static-server.ts");
  const config = join(directory, "bunfig.toml");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectOwnedDirectory(directory);
  for (const [path, content] of [
    [script, text],
    [config, ""],
  ] as const) {
    if ((await readFile(path, "utf8").catch(() => null)) === content) continue;
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
  return Object.freeze({ script, config });
}

/** Whether the static server answers `path` of the build at `root` with a
 * file (`--check`): the same resolution that will serve it decides whether
 * a build is kept (decision F58). */
export async function staticServerServes(input: {
  executable: string;
  files: Readonly<{ script: string; config: string }>;
  root: string;
  path: string;
  fallback: "404" | "spa";
}): Promise<boolean> {
  const child = Bun.spawn(
    [
      input.executable,
      "--no-env-file",
      `--config=${input.files.config}`,
      input.files.script,
      "--root",
      input.root,
      "--fallback",
      input.fallback,
      "--check",
      input.path,
    ],
    {
      cwd: input.root,
      env: { PATH: "/usr/bin:/bin", BUN_OPTIONS: "--no-install" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    return (await child.exited) === 0;
  } finally {
    clearTimeout(timer);
  }
}
