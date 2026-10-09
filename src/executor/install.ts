import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fetchOfficial, type InstallFetch } from "../tools/install";
import { resolveOnPath, type ToolRunner, versionOf } from "../tools/status";
import { compareVersions } from "../update/version";
import {
  type ExecutorPin,
  type ExecutorTarball,
  type ExecutorTarget,
  executorPin,
  executorTarget,
} from "./pin";

// The pinned Executor of an Environment (decision F44): exactly the tarballs
// of `pin.ts`, downloaded from the npm registry and verified against their
// integrity before npm sees them, installed by npm offline and without
// scripts, for the current user and without root, into
// `~/.local/share/executor-cli/<version>/`, the runbook's layout
// (`manual/integrations/executor.md` of the Lazurio root):
//
//   <prefix>/bin/executor                      npm's link to the launcher
//   <prefix>/lib/node_modules/executor/        the launcher package
//   <prefix>/lib/node_modules/executor-<target>/bin/executor   the program
//
// Agents and the service run the program itself: the standard entry
// `~/.local/bin/executor` (decision 0161 point 6) is a small wrapper Lazurio
// writes, marked as its own, that turns Executor's analytics and its check
// for a newer version off and runs the pinned program, so no run of this
// Environment's `executor`, a version probe or `executor mcp` included, calls
// home, and nothing needs Node once it is installed. A link
// `~/.local/bin/executor` into `~/.local/share/executor-cli/` (the runbook's
// manual layout) is Lazurio's to replace; any other entry there is never
// touched.

export type PinnedInstallInput = Readonly<{
  /** `~/.local/share/executor-cli`: one directory per pinned version. */
  root: string;
  /** `~/.local/bin`. */
  bin: string;
  home: string;
  path: string | undefined;
  platform: string;
  arch: string;
  run: ToolRunner;
  /** Test seams: the registry download and the pin. */
  fetch?: InstallFetch | undefined;
  pin?: ExecutorPin | undefined;
}>;

export type InstallFailureStage =
  | "preflight"
  | "download"
  | "integrity"
  | "npm"
  | "verify"
  | "place";

export type PinnedInstall =
  | Readonly<{
      kind: "installed" | "present";
      version: string;
      binary: string;
      /** The standard entry: written now, or already the wrapper. */
      entry: "written" | "present";
    }>
  | Readonly<{ kind: "unsupported-platform"; platform: string; arch: string }>
  /** `~/.local/bin/executor` is not Lazurio's: nothing was downloaded. */
  | Readonly<{ kind: "entry-conflict" }>
  /** Lazurio's wrapper runs a newer pin than this release's: nothing changes
   * (never a downgrade: a newer Executor may have migrated its data). */
  | Readonly<{ kind: "newer-installed"; version: string; binary: string }>
  | Readonly<{
      kind: "install-failed";
      stage: InstallFailureStage;
      reason: string;
    }>;

/** What `~/.local/bin/executor` is. */
export type ExecutorEntry =
  | Readonly<{ kind: "absent" }>
  /** A link into the version root, dangling or not (the runbook's manual
   * layout, a removed older pin): Lazurio replaces it with its wrapper. */
  | Readonly<{ kind: "replaceable" }>
  /** Lazurio's wrapper; `version` and `binary` are null when its text is not
   * of this release's form. */
  | Readonly<{
      kind: "lazurio";
      version: string | null;
      binary: string | null;
    }>
  /** Anything else, `~/.local` or `~/.local/bin` that is not a directory
   * included: never replaced. */
  | Readonly<{ kind: "foreign" }>;

const limits = {
  /** The launcher package is a few kilobytes; a platform package about
   * 100 MB compressed. */
  mainBytes: 1024 * 1024,
  platformBytes: 192 * 1024 * 1024,
  requestMs: 10 * 60_000,
  npmMs: 10 * 60_000,
  versionMs: 30_000,
} as const;

const wrapperMarker = "# lazurio-executor ";
const installMarker = ".lazurio-install.json";

export const platformPackage = (target: ExecutorTarget) => `executor-${target}`;
export const pinnedPrefix = (root: string, pin: ExecutorPin = executorPin) =>
  join(root, pin.version);
/** The program of a pinned version: the binary the wrapper and the service
 * run. */
export const pinnedBinary = (
  root: string,
  target: ExecutorTarget,
  pin: ExecutorPin = executorPin,
) =>
  join(
    pinnedPrefix(root, pin),
    "lib",
    "node_modules",
    platformPackage(target),
    "bin",
    "executor",
  );

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The text of `~/.local/bin/executor`. Both variables are set for every run,
 * whatever the caller's environment says. */
export function executorWrapper(version: string, binary: string): string {
  return [
    "#!/bin/sh",
    `${wrapperMarker}${version}: Executor pinned by Lazurio for this Environment (decision F44).`,
    "# No usage report and no check for a newer version from any run: Lazurio pins the version.",
    "EXECUTOR_DISABLE_ANALYTICS=1",
    "EXECUTOR_DISABLE_UPDATE_CHECK=1",
    "export EXECUTOR_DISABLE_ANALYTICS EXECUTOR_DISABLE_UPDATE_CHECK",
    `exec ${quote(binary)} "$@"`,
    "",
  ].join("\n");
}

/** The version and program of a wrapper of exactly this release's form. */
function parseWrapper(
  text: string,
): Readonly<{ version: string | null; binary: string | null }> {
  const version = new RegExp(`^${wrapperMarker}(\\S+): `, "m").exec(
    text.split("\n")[1] ?? "",
  )?.[1];
  const exec = /^exec '((?:[^']|'\\'')*)' "\$@"$/m.exec(text)?.[1];
  const binary = exec?.replaceAll(`'\\''`, "'");
  if (
    version === undefined ||
    binary === undefined ||
    text !== executorWrapper(version, binary)
  )
    return { version: null, binary: null };
  return { version, binary };
}

async function readHead(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Whether `~/.local` and `~/.local/bin` are directories (or absent): an
 * entry is never written through a link. */
async function binDirectoriesOk(bin: string): Promise<boolean> {
  for (const directory of [dirname(bin), bin]) {
    try {
      if (!(await lstat(directory)).isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

export async function inspectEntry(
  bin: string,
  root: string,
): Promise<ExecutorEntry> {
  if (!(await binDirectoriesOk(bin))) return { kind: "foreign" };
  const entry = join(bin, "executor");
  let found: Awaited<ReturnType<typeof lstat>>;
  try {
    found = await lstat(entry);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "foreign" };
  }
  if (found.isSymbolicLink()) {
    let target: string;
    try {
      target = resolve(bin, await readlink(entry));
    } catch {
      return { kind: "foreign" };
    }
    // Only where the link leads decides, dangling or not: into the version
    // root it is Lazurio's layout (the runbook's link, a removed older pin);
    // anywhere else it is someone else's, also once its target is gone.
    return target.startsWith(`${root}/`)
      ? { kind: "replaceable" }
      : { kind: "foreign" };
  }
  if (!found.isFile()) return { kind: "foreign" };
  const text = await readHead(entry, 16 * 1024);
  if (text === null || !text.startsWith(`#!/bin/sh\n${wrapperMarker}`))
    return { kind: "foreign" };
  return { kind: "lazurio", ...parseWrapper(text) };
}

/** `~/.local/bin/executor` as the wrapper of `binary`: written when absent,
 * replaceable or another wrapper of Lazurio; left alone (`conflict`) when it
 * is anything else, also when it became something else meanwhile. */
export async function ensureExecutorEntry(
  bin: string,
  root: string,
  version: string,
  binary: string,
): Promise<"written" | "present" | "conflict"> {
  const current = await inspectEntry(bin, root);
  if (current.kind === "foreign") return "conflict";
  const wanted = executorWrapper(version, binary);
  if (
    current.kind === "lazurio" &&
    current.version === version &&
    current.binary === binary
  )
    return "present";
  const entry = join(bin, "executor");
  await mkdir(bin, { recursive: true, mode: 0o755 });
  const temporary = join(
    bin,
    `.executor.lazurio-${randomBytes(8).toString("hex")}`,
  );
  try {
    await writeFile(temporary, wanted, { mode: 0o755, flag: "wx" });
    await chmod(temporary, 0o755);
    // Still the state that was judged: an entry that appeared meanwhile is
    // judged again rather than replaced.
    const again = await inspectEntry(bin, root);
    if (again.kind === "foreign" || again.kind !== current.kind)
      return "conflict";
    await rename(temporary, entry);
  } finally {
    await rm(temporary, { force: true });
  }
  return "written";
}

class StageError extends Error {
  constructor(
    readonly stage: InstallFailureStage,
    readonly reason: string,
  ) {
    super(`${stage}: ${reason}`);
  }
}

/** One tarball from the registry to `file`, hashed while it streams, bounded
 * in size and time, https only before the request and after every redirect.
 * A digest other than the pin's removes the file. */
export async function downloadVerified(
  fetcher: InstallFetch,
  tarball: ExecutorTarball,
  file: string,
  maxBytes: number,
): Promise<void> {
  if (!tarball.url.startsWith("https://"))
    throw new StageError("download", "not-https");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.requestMs);
  const hash = createHash("sha512");
  const handle = await open(file, "wx", 0o600);
  let complete = false;
  try {
    let response: Response;
    try {
      response = await fetcher(tarball.url, {
        signal: controller.signal,
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "lazurio-executor-install",
        },
      });
    } catch {
      throw new StageError(
        "download",
        controller.signal.aborted ? "timeout" : "network",
      );
    }
    if (response.url !== "" && !response.url.startsWith("https://"))
      throw new StageError("download", "not-https");
    if (!response.ok)
      throw new StageError("download", `http-${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new StageError("download", "too-large");
    const reader = response.body?.getReader();
    if (!reader) throw new StageError("download", "empty");
    let length = 0;
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw new StageError(
          "download",
          controller.signal.aborted ? "timeout" : "network",
        );
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new StageError("download", "too-large");
      }
      hash.update(chunk.value);
      await handle.write(chunk.value);
    }
    if (length === 0) throw new StageError("download", "empty");
    await handle.sync();
    if (`sha512-${hash.digest("base64")}` !== tarball.integrity)
      throw new StageError("integrity", "integrity-mismatch");
    complete = true;
  } finally {
    clearTimeout(timer);
    await handle.close();
    if (!complete) await rm(file, { force: true });
  }
}

/** The environment npm runs with: the operator's PATH and home, and nothing
 * of the operator's npm configuration, cache, registry or scripts. */
function npmEnvironment(
  input: PinnedInstallInput,
  scratch: string,
): Record<string, string> {
  return {
    PATH: input.path ?? "",
    HOME: input.home,
    npm_config_userconfig: join(scratch, "npmrc"),
    npm_config_globalconfig: join(scratch, "npmrc-global"),
    npm_config_cache: join(scratch, "cache"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_loglevel: "error",
    npm_config_progress: "false",
  };
}

async function packageVersion(
  directory: string,
): Promise<Readonly<{ name: unknown; version: unknown }> | null> {
  try {
    const value = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown } | null;
    return value === null || typeof value !== "object"
      ? null
      : { name: value.name, version: value.version };
  } catch {
    return null;
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The version the program reports, run with a private data directory and
 * both switches off, so the probe writes nothing of the Environment's and
 * calls nobody. */
export async function programVersion(
  binary: string,
  input: Pick<PinnedInstallInput, "home" | "path" | "run">,
): Promise<string | null> {
  if (!(await executable(binary))) return null;
  const data = await mkdtemp(join(tmpdir(), "lazurio-executor-probe-"));
  try {
    const result = await input
      .run([binary, "--version"], limits.versionMs, {
        HOME: input.home,
        ...(input.path === undefined ? {} : { PATH: input.path }),
        EXECUTOR_DATA_DIR: data,
        EXECUTOR_DISABLE_ANALYTICS: "1",
        EXECUTOR_DISABLE_UPDATE_CHECK: "1",
      })
      .catch(() => "timeout" as const);
    if (result === "timeout" || result.exitCode !== 0) return null;
    return versionOf(result.stdout) ?? null;
  } finally {
    await rm(data, { recursive: true, force: true });
  }
}

const markerOf = (pin: ExecutorPin, target: ExecutorTarget) =>
  `${JSON.stringify({
    schemaVersion: 1,
    version: pin.version,
    target,
    main: pin.main.integrity,
    platform: pin.platforms[target].integrity,
  })}\n`;

/** Whether Lazurio verified and placed `version` in the version root: its
 * marker names that version. Reads one small file; runs nothing. */
export async function markedVersion(
  root: string,
  version: string,
): Promise<boolean> {
  const marker = await readHead(join(root, version, installMarker), 4096);
  if (marker === null) return false;
  try {
    return (JSON.parse(marker) as { version?: unknown }).version === version;
  } catch {
    return false;
  }
}

/** Whether this release's pin is in place: the marker Lazurio wrote after
 * verifying it, and the program answering the pinned version. */
export async function pinnedInstalled(
  input: Pick<PinnedInstallInput, "root" | "home" | "path" | "run">,
  target: ExecutorTarget,
  pin: ExecutorPin = executorPin,
): Promise<boolean> {
  const marker = await readHead(
    join(pinnedPrefix(input.root, pin), installMarker),
    4096,
  );
  return (
    marker === markerOf(pin, target) &&
    (await programVersion(pinnedBinary(input.root, target, pin), input)) ===
      pin.version
  );
}

const isNewer = (version: string | null, than: string) => {
  if (version === null) return false;
  try {
    return compareVersions(version, than) > 0;
  } catch {
    return false;
  }
};

/** Installs exactly the pinned Executor when it is not in place, and the
 * standard entry. Never touches an entry that is not Lazurio's, never
 * replaces a newer pin, and removes nothing older: the service may still run
 * it (`removeOlderInstallations`, after the switch). */
export async function installPinnedExecutor(
  input: PinnedInstallInput,
): Promise<PinnedInstall> {
  const pin = input.pin ?? executorPin;
  const target = executorTarget(input.platform, input.arch);
  if (target === undefined)
    return {
      kind: "unsupported-platform",
      platform: input.platform,
      arch: input.arch,
    };
  const entry = await inspectEntry(input.bin, input.root);
  if (entry.kind === "foreign") return { kind: "entry-conflict" };
  if (
    entry.kind === "lazurio" &&
    entry.binary !== null &&
    isNewer(entry.version, pin.version)
  )
    return {
      kind: "newer-installed",
      version: entry.version as string,
      binary: entry.binary,
    };
  const binary = pinnedBinary(input.root, target, pin);
  let kind: "installed" | "present" = "present";
  if (!(await pinnedInstalled(input, target, pin))) {
    kind = "installed";
    try {
      await placePinned(input, pin, target);
    } catch (error) {
      return error instanceof StageError
        ? { kind: "install-failed", stage: error.stage, reason: error.reason }
        : { kind: "install-failed", stage: "place", reason: "write-failed" };
    }
  }
  let written: "written" | "present" | "conflict";
  try {
    written = await ensureExecutorEntry(
      input.bin,
      input.root,
      pin.version,
      binary,
    );
  } catch {
    written = "conflict";
  }
  if (written === "conflict") return { kind: "entry-conflict" };
  return { kind, version: pin.version, binary, entry: written };
}

/** Download, verify, npm into a private staging prefix, verify the result,
 * mark it, and move it in place of `<root>/<version>`; a directory that was
 * there (an unverified manual installation) moves aside first and is removed
 * once the service no longer runs it. Nothing is left behind on a failure. */
async function placePinned(
  input: PinnedInstallInput,
  pin: ExecutorPin,
  target: ExecutorTarget,
): Promise<void> {
  const npm = await resolveOnPath("npm", input.path, input.platform);
  if (npm === undefined) throw new StageError("preflight", "npm-missing");
  if ((await resolveOnPath("node", input.path, input.platform)) === undefined)
    throw new StageError("preflight", "node-missing");
  try {
    await mkdir(input.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(input.root)).isDirectory())
      throw new StageError("place", "root-not-directory");
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError("place", "write-failed");
  }
  const scratch = await mkdtemp(join(input.root, ".lazurio-download-"));
  let staging: string | undefined;
  try {
    const fetcher = input.fetch ?? fetchOfficial;
    const main = join(scratch, "executor.tgz");
    const platform = join(scratch, `${platformPackage(target)}.tgz`);
    await downloadVerified(fetcher, pin.main, main, limits.mainBytes);
    await downloadVerified(
      fetcher,
      pin.platforms[target],
      platform,
      limits.platformBytes,
    );
    await writeFile(join(scratch, "npmrc"), "", { mode: 0o600 });
    await writeFile(join(scratch, "npmrc-global"), "", { mode: 0o600 });
    staging = await mkdtemp(join(input.root, ".lazurio-staging-"));
    const env = npmEnvironment(input, scratch);
    const flags = [
      "install",
      "--global",
      "--prefix",
      staging,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ];
    // The launcher first, without its optional dependencies (offline, they
    // do not resolve); then the one platform package under the alias the
    // launcher looks for, which Node resolves beside it.
    for (const spec of [main, `${platformPackage(target)}@file:${platform}`]) {
      const result = await input
        .run([npm, ...flags, spec], limits.npmMs, env)
        .catch(() => "timeout" as const);
      if (result === "timeout") throw new StageError("npm", "timeout");
      if (result.exitCode !== 0)
        throw new StageError("npm", `exit-${result.exitCode}`);
    }
    const modules = join(staging, "lib", "node_modules");
    const launcher = await packageVersion(join(modules, "executor"));
    const program = await packageVersion(
      join(modules, platformPackage(target)),
    );
    if (
      launcher?.name !== "executor" ||
      launcher.version !== pin.version ||
      program?.name !== "executor" ||
      program.version !== `${pin.version}-${target}` ||
      !(await lstat(join(staging, "bin", "executor")).then(
        () => true,
        () => false,
      ))
    )
      throw new StageError("verify", "layout-unexpected");
    const staged = join(modules, platformPackage(target), "bin", "executor");
    if ((await programVersion(staged, input)) !== pin.version)
      throw new StageError("verify", "version-mismatch");
    try {
      await writeFile(join(staging, installMarker), markerOf(pin, target), {
        mode: 0o600,
        flag: "wx",
      });
      const prefix = pinnedPrefix(input.root, pin);
      if (
        await lstat(prefix).then(
          () => true,
          () => false,
        )
      )
        await rename(
          prefix,
          join(
            input.root,
            `.lazurio-previous-${randomBytes(8).toString("hex")}`,
          ),
        );
      await rename(staging, prefix);
      staging = undefined;
    } catch {
      throw new StageError("place", "write-failed");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (staging !== undefined)
      await rm(staging, { recursive: true, force: true });
  }
}

/** After the entry and the service run the pinned version: every older
 * version directory and every leftover of Lazurio's own (`.lazurio-…`) in the
 * version root goes. A newer version or a name of another form stays. */
export async function removeOlderInstallations(
  root: string,
  pin: ExecutorPin = executorPin,
): Promise<void> {
  for (const name of await readdir(root).catch(() => [])) {
    const older = (() => {
      try {
        return compareVersions(name, pin.version) < 0;
      } catch {
        return false;
      }
    })();
    if (older || /^\.lazurio-(previous|staging|download)-/.test(name))
      await rm(join(root, name), { recursive: true, force: true });
  }
}
