import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchiveFormat,
  extractArchiveFile,
  UnsafeArchiveError,
} from "./archive";
import { type ActivatableTool, activatableTools } from "./catalog";
import { safeTail } from "./redact";
import { resolveOnPath, type ToolRunner, versionOf } from "./status";

/** The curated installation of a `setup: "launchpad"` catalog tool (decision
 * F19): for the current user, without root, into the standard path
 * `~/.local/bin/<command>` (F17), from the official source only, at the latest
 * release resolved at install time. A tool that already works is never
 * touched; a broken one elsewhere on PATH is not shadowed by a second copy. A
 * failure names its stage and offers the prepared agent prompt (`fallback:
 * "agent"`), whose text is the tool's written target state. */
export type InstallResult =
  | Readonly<{
      kind: "installed";
      tool: string;
      version?: string;
      path: string;
      /** Whether `~/.local/bin` is on the PATH the tool was installed for. */
      onPath: boolean;
    }>
  | Readonly<{
      kind: "already-installed";
      tool: string;
      version?: string;
      path: string;
    }>
  | Readonly<{
      kind: "unsupported-platform";
      tool: string;
      platform: string;
      arch: string;
      fallback: "agent";
    }>
  | Readonly<{
      kind: "install-failed";
      tool: string;
      stage: InstallStage;
      reason: string;
      /** A bounded, plain tail of the official installer's output with every
       * line that could carry a secret withheld. */
      detail?: string;
      fallback: "agent";
    }>;

export type InstallStage =
  | "preflight"
  | "resolve"
  | "download"
  | "checksum"
  | "extract"
  | "place"
  | "installer"
  | "verify";

/** A fetch as the product does it; injectable so tests never reach a vendor. */
export type InstallFetch = (
  url: string,
  init: Readonly<{
    signal: AbortSignal;
    headers: Readonly<Record<string, string>>;
  }>,
) => Promise<Response>;

export const fetchOfficial: InstallFetch = (url, init) =>
  fetch(url, {
    redirect: "follow",
    signal: init.signal,
    headers: { ...init.headers },
  });

export type InstallEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  xdg?: Readonly<Record<string, string>> | undefined;
  platform: string;
  arch?: string | undefined;
  run: ToolRunner;
  fetch?: InstallFetch | undefined;
  /** Test seam: the directory of the installer's private temporary file. */
  temporaryDirectory?: string | undefined;
}>;

type Target = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";
type ReleaseAsset = Readonly<{
  name: string;
  format: ArchiveFormat;
  /** The binary's path inside the archive. */
  binary: string;
}>;
type Recipe =
  | Readonly<{
      kind: "release";
      owner: string;
      repository: string;
      checksums: (version: string) => string;
      asset: (version: string, target: Target) => ReleaseAsset;
    }>
  | Readonly<{
      kind: "script";
      url: string;
      /** The controlled environment of the official installer. */
      env: Readonly<Record<string, string>>;
      targets: readonly Target[];
    }>;

// The official sources of the curated tools. gh and wacli publish release
// archives with a checksums file (GoReleaser); composio documents an
// installer script that verifies its own bundle, keeps it in ~/.composio and
// links ~/.local/bin/composio.
export const curatedInstallers: Readonly<Record<string, Recipe>> =
  Object.freeze({
    gh: {
      kind: "release",
      owner: "cli",
      repository: "cli",
      checksums: (version) => `gh_${version}_checksums.txt`,
      asset: (version, target) => {
        const platform = {
          "linux-x64": "linux_amd64",
          "linux-arm64": "linux_arm64",
          "darwin-x64": "macOS_amd64",
          "darwin-arm64": "macOS_arm64",
        }[target];
        const format = target.startsWith("darwin") ? "zip" : "tar.gz";
        const base = `gh_${version}_${platform}`;
        return {
          name: `${base}.${format}`,
          format,
          binary: `${base}/bin/gh`,
        };
      },
    },
    wacli: {
      kind: "release",
      owner: "openclaw",
      repository: "wacli",
      checksums: () => "checksums.txt",
      asset: (version, target) => ({
        name: `wacli_${version}_${target.replace("-", "_").replace("x64", "amd64")}.tar.gz`,
        format: "tar.gz",
        binary: "wacli",
      }),
    },
    composio: {
      kind: "script",
      url: "https://composio.dev/install",
      // No agent plugins, no shell startup files: only the bundle in its own
      // home and the ~/.local/bin entry. No version: the latest stable.
      env: {
        COMPOSIO_INSTALL_PLUGINS: "0",
        COMPOSIO_INSTALL_SHELL: "none",
        COMPOSIO_INSTALL_HELP: "0",
      },
      targets: ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
    },
  });

const limits = {
  metadataBytes: 1024 * 1024,
  scriptBytes: 1024 * 1024,
  archiveBytes: 256 * 1024 * 1024,
  requestMs: 5 * 60_000,
  installerMs: 10 * 60_000,
  versionMs: 15_000,
} as const;

export class InstallStageError extends Error {
  constructor(
    readonly stage: InstallStage,
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(`${stage}: ${reason}`);
  }
}

function target(platform: string, arch: string): Target | undefined {
  if (platform !== "linux" && platform !== "darwin") return undefined;
  if (arch !== "x64" && arch !== "arm64") return undefined;
  return `${platform}-${arch}`;
}

/** The tools that have a curated installer: exactly the `launchpad` ones. */
export function curatedTool(name: string): ActivatableTool | undefined {
  const entry = activatableTools().find((tool) => tool.name === name);
  return entry?.activation.setup === "launchpad" &&
    Object.hasOwn(curatedInstallers, name)
    ? entry
    : undefined;
}

// Only https, before the request and after every redirect. Bounded in size
// and time; the vault's pinned CLI (src/vault/install.ts) uses it too.
export async function download(
  fetcher: InstallFetch,
  url: string,
  maxBytes: number,
  stage: InstallStage,
  accept = "*/*",
): Promise<Uint8Array> {
  if (!url.startsWith("https://"))
    throw new InstallStageError(stage, "not-https");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.requestMs);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        signal: controller.signal,
        headers: { Accept: accept, "User-Agent": "lazurio-tools-install" },
      });
    } catch {
      throw new InstallStageError(
        stage,
        controller.signal.aborted ? "timeout" : "network",
      );
    }
    if (response.url !== "" && !response.url.startsWith("https://"))
      throw new InstallStageError(stage, "not-https");
    if (!response.ok)
      throw new InstallStageError(stage, `http-${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new InstallStageError(stage, "too-large");
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new InstallStageError(stage, "empty");
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw new InstallStageError(
          stage,
          controller.signal.aborted ? "timeout" : "network",
        );
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InstallStageError(stage, "too-large");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

// The published digest of exactly that asset: "<sha256>  <name>" per line.
export function checksumOf(
  checksums: string,
  asset: string,
): string | undefined {
  const digests = checksums
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(line.trim()))
    .filter((match) => match !== null && match[2] === asset)
    .map((match) => match?.[1]?.toLowerCase());
  return digests.length === 1 ? digests[0] : undefined;
}

type Found = Readonly<{
  path: string;
  version?: string;
  works: boolean;
}>;

async function probe(
  path: string,
  env: InstallEnvironment,
  processEnv: Readonly<Record<string, string>>,
): Promise<Found> {
  try {
    const result = await env.run(
      [path, "--version"],
      limits.versionMs,
      processEnv,
    );
    if (result === "timeout" || result.exitCode !== 0)
      return { path, works: false };
    const version = versionOf(result.stdout) ?? versionOf(result.stderr);
    return { path, works: true, ...(version ? { version } : {}) };
  } catch {
    return { path, works: false };
  }
}

// What the entry is, without following a link: enough to tell whether an
// installation attempt created or replaced it.
async function identity(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path, { bigint: true });
    const target = entry.isSymbolicLink() ? await readlink(path) : "";
    return [entry.dev, entry.ino, entry.size, entry.mtimeNs, target].join(":");
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function baseEnv(env: InstallEnvironment): Record<string, string> {
  const result: Record<string, string> = {};
  if (env.path) result.PATH = env.path;
  if (env.home) result.HOME = env.home;
  for (const [name, value] of Object.entries(env.xdg ?? {}))
    if (/^XDG_[A-Z_]+$/.test(name) && value) result[name] = value;
  return result;
}

const onPath = (directory: string, path: string | undefined) =>
  (path ?? "").split(":").includes(directory);

// A release archive: the latest tag, the checksums of that release, the
// archive verified before anything is read from it, the one binary written
// into a private directory beside its destination and renamed into place.
async function installRelease(
  entry: ActivatableTool,
  recipe: Extract<Recipe, { kind: "release" }>,
  platformTarget: Target,
  env: InstallEnvironment,
  destination: string,
): Promise<void> {
  const fetcher = env.fetch ?? fetchOfficial;
  const release = `https://github.com/${recipe.owner}/${recipe.repository}/releases`;
  let tag: string;
  try {
    const latest: unknown = JSON.parse(
      new TextDecoder().decode(
        await download(
          fetcher,
          `https://api.github.com/repos/${recipe.owner}/${recipe.repository}/releases/latest`,
          limits.metadataBytes,
          "resolve",
          "application/vnd.github+json",
        ),
      ),
    );
    const value =
      latest !== null && typeof latest === "object" && "tag_name" in latest
        ? latest.tag_name
        : undefined;
    if (typeof value !== "string" || !/^v?\d+\.\d+\.\d+$/.test(value))
      throw new InstallStageError("resolve", "unexpected-release");
    tag = value;
  } catch (error) {
    if (error instanceof InstallStageError) throw error;
    throw new InstallStageError("resolve", "unexpected-release");
  }
  const version = tag.replace(/^v/, "");
  const asset = recipe.asset(version, platformTarget);
  const checksums = new TextDecoder().decode(
    await download(
      fetcher,
      `${release}/download/${tag}/${recipe.checksums(version)}`,
      limits.metadataBytes,
      "checksum",
    ),
  );
  const expected = checksumOf(checksums, asset.name);
  if (expected === undefined)
    throw new InstallStageError("checksum", "checksum-missing");
  const archive = await download(
    fetcher,
    `${release}/download/${tag}/${asset.name}`,
    limits.archiveBytes,
    "download",
  );
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected)
    throw new InstallStageError("checksum", "checksum-mismatch");
  let binary: Uint8Array;
  try {
    binary = extractArchiveFile(archive, asset.format, asset.binary);
  } catch (error) {
    throw new InstallStageError(
      "extract",
      error instanceof UnsafeArchiveError
        ? "archive-unsafe"
        : "archive-invalid",
      error instanceof UnsafeArchiveError ? error.message : undefined,
    );
  }
  if (binary.byteLength === 0)
    throw new InstallStageError("extract", "binary-empty");
  const directory = join(destination, "..");
  let temporary: string | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    temporary = await mkdtemp(
      join(directory, `.lazurio-install-${entry.command}-`),
    );
    await chmod(temporary, 0o700);
    const staged = join(temporary, entry.command);
    await writeFile(staged, binary, { mode: 0o700, flag: "wx" });
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } catch {
    throw new InstallStageError("place", "write-failed");
  } finally {
    if (temporary !== undefined)
      await rm(temporary, { recursive: true, force: true });
  }
}

// The official installer script, in two steps: downloaded into a private
// file, then run with the controlled environment. A failed download runs
// nothing.
async function installScript(
  recipe: Extract<Recipe, { kind: "script" }>,
  env: InstallEnvironment,
): Promise<void> {
  const script = await download(
    env.fetch ?? fetchOfficial,
    recipe.url,
    limits.scriptBytes,
    "download",
  );
  if (script.byteLength === 0 || script.includes(0))
    throw new InstallStageError("download", "not-a-script");
  const directory = await mkdtemp(
    join(env.temporaryDirectory ?? tmpdir(), "lazurio-install-"),
  );
  try {
    await chmod(directory, 0o700);
    const file = join(directory, "install.sh");
    await writeFile(file, script, { mode: 0o600, flag: "wx" });
    const result = await env.run(["/bin/sh", file], limits.installerMs, {
      ...baseEnv(env),
      ...recipe.env,
    });
    if (result === "timeout")
      throw new InstallStageError("installer", "timeout");
    if (result.exitCode !== 0)
      throw new InstallStageError(
        "installer",
        `exit-${result.exitCode}`,
        safeTail(`${result.stdout}\n${result.stderr}`),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function installTool(
  name: string,
  env: InstallEnvironment,
): Promise<InstallResult> {
  const entry = curatedTool(name);
  if (entry === undefined)
    throw new Error("Only a curated catalog tool is installed here");
  const recipe = curatedInstallers[name] as Recipe;
  const fail = (
    stage: InstallStage,
    reason: string,
    detail?: string,
  ): InstallResult => ({
    kind: "install-failed",
    tool: name,
    stage,
    reason,
    ...(detail ? { detail } : {}),
    fallback: "agent",
  });
  const arch = env.arch ?? process.arch;
  const platformTarget = target(env.platform, arch);
  if (
    platformTarget === undefined ||
    (recipe.kind === "script" && !recipe.targets.includes(platformTarget))
  )
    return {
      kind: "unsupported-platform",
      tool: name,
      platform: env.platform,
      arch,
      fallback: "agent",
    };
  if (!env.home?.startsWith("/")) return fail("preflight", "no-home");
  const processEnv = baseEnv(env);
  const bin = join(env.home, ".local", "bin");
  const destination = join(bin, entry.command);
  // A tool that works, on PATH or in the standard path, is never touched.
  const onPathNow = await resolveOnPath(entry.command, env.path, env.platform);
  const found = onPathNow ? await probe(onPathNow, env, processEnv) : undefined;
  if (found?.works)
    return {
      kind: "already-installed",
      tool: name,
      path: found.path,
      ...(found.version ? { version: found.version } : {}),
    };
  if (onPathNow === undefined && (await exists(destination))) {
    const standard = await probe(destination, env, processEnv);
    if (standard.works)
      return {
        kind: "already-installed",
        tool: name,
        path: destination,
        ...(standard.version ? { version: standard.version } : {}),
      };
  }
  // A broken installation elsewhere stays the operator's: a second copy in
  // ~/.local/bin would only hide it. The agent's prompt covers the repair.
  if (onPathNow !== undefined && onPathNow !== destination)
    return fail("preflight", "broken-installation-elsewhere");
  const before = await identity(destination);
  try {
    if (recipe.kind === "release")
      await installRelease(entry, recipe, platformTarget, env, destination);
    else await installScript(recipe, env);
  } catch (error) {
    if (error instanceof InstallStageError)
      return fail(error.stage, error.reason, error.detail);
    return fail("place", "unexpected");
  }
  const installed = await probe(destination, env, processEnv);
  if (!installed.works) {
    // What this attempt placed and does not run is not left behind as
    // "installed": the entry it created or replaced in the standard path
    // goes (for an installer script that is its link; the installer's own
    // home stays the tool's). An entry the attempt did not change stays the
    // operator's.
    if ((await identity(destination)) !== before)
      await rm(destination, { force: true });
    return fail("verify", "version-failed");
  }
  return {
    kind: "installed",
    tool: name,
    path: destination,
    onPath: onPath(bin, env.path),
    ...(installed.version ? { version: installed.version } : {}),
  };
}
