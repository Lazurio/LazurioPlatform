import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extractArchiveFile, UnsafeArchiveError } from "../tools/archive";
import {
  download,
  fetchOfficial,
  type InstallFetch,
  InstallStageError,
} from "../tools/install";
import type { ToolRunner } from "../tools/status";
import { bwCli } from "./bw";
import { type BitwardenPin, bitwardenPin, bitwardenTarget } from "./pin";

// The pinned Bitwarden CLI of the Environment vault (decision F43): the OSS
// build of exactly the pinned release, verified against its SHA-256 in this
// source before the archive is read, placed for the current user without
// root as `<install base>/tools/bitwarden/<version>/bw`, a directory that
// holds nothing else (a `bw-data` directory beside the binary would silently
// replace BITWARDENCLI_APPDATA_DIR). Agents type `bw`: the standard entry
// `~/.local/bin/bw` (decision 0161 point 6) is a small wrapper that runs the
// pinned binary with this Environment's data directory unless the caller
// names one, so no `bw` of this Environment ever reaches a default profile.
// A working `bw` of another version is never used for the vault, and an
// entry in `~/.local/bin` that is not Lazurio's is never replaced.

export type PinnedInstallInput = Readonly<{
  /** The product's install base (`${XDG_DATA_HOME:-~/.local/share}/lazurio`
   * on Linux). */
  base: string;
  /** `~/.local/bin`. */
  bin: string;
  /** The account's BITWARDENCLI_APPDATA_DIR: the wrapper's default, and the
   * only data directory the version check may touch. */
  data: string;
  home: string;
  path: string | undefined;
  platform: string;
  arch: string;
  run: ToolRunner;
  fetch?: InstallFetch | undefined;
  /** Test seam: another pin (a fake release with its own digest). */
  pin?: BitwardenPin | undefined;
}>;

/** What happened to the standard entry `~/.local/bin/bw`. */
export type BwEntry = "written" | "present" | "conflict";

export type PinnedInstall =
  | Readonly<{
      kind: "installed" | "present";
      version: string;
      binary: string;
      entry: BwEntry;
    }>
  | Readonly<{
      kind: "unsupported-platform";
      platform: string;
      arch: string;
    }>
  | Readonly<{
      kind: "install-failed";
      stage:
        | "preflight"
        | "download"
        | "checksum"
        | "extract"
        | "place"
        | "verify";
      reason: string;
    }>;

const archiveBytes = 256 * 1024 * 1024;
const wrapperMarker = "# lazurio-vault-bw:";

export const bitwardenTools = (base: string) =>
  join(base, "tools", "bitwarden");
export const pinnedBinary = (base: string, pin: BitwardenPin = bitwardenPin) =>
  join(bitwardenTools(base), pin.version, "bw");

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The text of `~/.local/bin/bw`. */
export function bwWrapper(binary: string, data: string): string {
  return [
    "#!/bin/sh",
    `${wrapperMarker} the Bitwarden CLI pinned by Lazurio for this Environment's vault (decision F43).`,
    '# Agents run `eval "$(lazurio vault env)"` first and never bw login, unlock, lock, logout or config.',
    'if [ -z "$BITWARDENCLI_APPDATA_DIR" ]; then',
    `  BITWARDENCLI_APPDATA_DIR=${quote(data)}`,
    "  export BITWARDENCLI_APPDATA_DIR",
    "fi",
    // Never a prompt for a master password: "Vault is locked." instead.
    'if [ -z "$BW_NOINTERACTION" ]; then',
    "  BW_NOINTERACTION=true",
    "  export BW_NOINTERACTION",
    "fi",
    `exec ${quote(binary)} "$@"`,
    "",
  ].join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `path` is a regular file whose text starts as Lazurio's wrapper. */
async function isWrapper(path: string): Promise<string | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return text.startsWith(`#!/bin/sh\n${wrapperMarker}`) ? text : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** `~/.local/bin/bw`: written when absent, a dangling link, a link to a
 * pinned bw of Lazurio or an older wrapper of Lazurio; left alone (and
 * reported) when it is anything else. `~/.local` and `~/.local/bin` are
 * never written through a link. */
export async function ensureBwEntry(
  bin: string,
  binary: string,
  data: string,
  tools: string,
): Promise<BwEntry> {
  const entry = join(bin, "bw");
  const wanted = bwWrapper(binary, data);
  for (const directory of [dirname(bin), bin]) {
    try {
      const found = await lstat(directory);
      if (!found.isDirectory()) return "conflict";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "conflict";
    }
  }
  let replace = false;
  try {
    const found = await lstat(entry);
    if (found.isSymbolicLink()) {
      const target = resolve(bin, await readlink(entry));
      const dangling = await stat(entry)
        .then(() => false)
        .catch(() => true);
      if (!dangling && !target.startsWith(`${tools}/`)) return "conflict";
      replace = true;
    } else if (found.isFile()) {
      const text = await isWrapper(entry);
      if (text === null) return "conflict";
      if (text === wanted) return "present";
      replace = true;
    } else return "conflict";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "conflict";
  }
  await mkdir(bin, { recursive: true, mode: 0o755 });
  const temporary = join(bin, `.bw.lazurio-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, wanted, { mode: 0o755, flag: "wx" });
    await chmod(temporary, 0o755);
    if (replace || !(await exists(entry))) await rename(temporary, entry);
    else return "conflict";
  } finally {
    await rm(temporary, { force: true });
  }
  return "written";
}

/** Installs exactly the pinned bw when it is not there and working, and the
 * standard entry. Removes older pinned versions once the entry runs the new
 * one. Never touches a `bw` that is not Lazurio's. */
export async function installPinnedBw(
  input: PinnedInstallInput,
): Promise<PinnedInstall> {
  const pin = input.pin ?? bitwardenPin;
  const target = bitwardenTarget(input.platform, input.arch);
  if (target === undefined)
    return {
      kind: "unsupported-platform",
      platform: input.platform,
      arch: input.arch,
    };
  const tools = bitwardenTools(input.base);
  const directory = join(tools, pin.version);
  const binary = join(directory, "bw");
  const failed = (
    stage: Extract<PinnedInstall, { kind: "install-failed" }>["stage"],
    reason: string,
  ): PinnedInstall => ({ kind: "install-failed", stage, reason });
  // bw prefers a `bw-data` directory beside its executable over
  // BITWARDENCLI_APPDATA_DIR; nothing of Lazurio ever writes one there.
  if (await exists(join(directory, "bw-data")))
    return failed("preflight", "bw-data-present");
  const version = () =>
    bwCli({
      binary,
      data: input.data,
      home: input.home,
      path: input.path,
      run: input.run,
    }).version();
  let kind: "installed" | "present" = "present";
  if ((await exists(binary)) && (await version()) !== pin.version)
    await rm(binary, { force: true });
  if (!(await exists(binary))) {
    kind = "installed";
    const asset = pin.assets[target];
    let archive: Uint8Array;
    try {
      archive = await download(
        input.fetch ?? fetchOfficial,
        `${pin.release}/${asset.name}`,
        archiveBytes,
        "download",
      );
    } catch (error) {
      return failed(
        "download",
        error instanceof InstallStageError ? error.reason : "network",
      );
    }
    if (createHash("sha256").update(archive).digest("hex") !== asset.sha256)
      return failed("checksum", "checksum-mismatch");
    let bytes: Uint8Array;
    try {
      bytes = extractArchiveFile(archive, "zip", "bw");
    } catch (error) {
      return failed(
        "extract",
        error instanceof UnsafeArchiveError
          ? "archive-unsafe"
          : "archive-invalid",
      );
    }
    if (bytes.byteLength === 0) return failed("extract", "binary-empty");
    let temporary: string | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      temporary = await mkdtemp(join(directory, ".lazurio-install-"));
      const staged = join(temporary, "bw");
      await writeFile(staged, bytes, { mode: 0o700, flag: "wx" });
      await chmod(staged, 0o755);
      await rename(staged, binary);
    } catch {
      return failed("place", "write-failed");
    } finally {
      if (temporary !== undefined)
        await rm(temporary, { recursive: true, force: true });
    }
    if ((await version()) !== pin.version) {
      await rm(binary, { force: true });
      return failed("verify", "version-mismatch");
    }
  }
  let entry: BwEntry;
  try {
    entry = await ensureBwEntry(input.bin, binary, input.data, tools);
  } catch {
    entry = "conflict";
  }
  // Older pins: the entry no longer runs them.
  for (const name of await readdir(tools).catch(() => []))
    if (name !== pin.version && /^\d+\.\d+\.\d+$/.test(name))
      await rm(join(tools, name), { recursive: true, force: true });
  return { kind, version: pin.version, binary, entry };
}

/** Whether the pinned bw is in place, without running it. */
export async function pinnedInstalled(
  base: string,
  pin: BitwardenPin = bitwardenPin,
): Promise<boolean> {
  try {
    const found = await stat(pinnedBinary(base, pin));
    return (
      found.isFile() &&
      !(await exists(join(dirname(pinnedBinary(base, pin)), "bw-data")))
    );
  } catch {
    return false;
  }
}
