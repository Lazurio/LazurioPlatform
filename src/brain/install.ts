import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ToolRunner } from "../tools/status";
import { writeDurableFile } from "../update/durable-file";
import { type BrainPaths, brainPin, releaseCommand } from "./pin";

// The pinned release in a directory of its own, installed for the current
// user without root by Bun from the fork at the pinned commit
// (`BUN_INSTALL=<releases>/<commit> bun add --global github:<repo>#<commit>`).
// Each commit keeps its directory, so the release a brain runs stays
// runnable while the next one is installed beside it. The installed
// package.json must carry the pinned version, or the install counts as
// failed and nothing switches to it.

const installTimeoutMs = 15 * 60_000;

async function installedVersion(directory: string): Promise<string | null> {
  try {
    const value = JSON.parse(
      await readFile(
        join(
          directory,
          "install",
          "global",
          "node_modules",
          "gbrain",
          "package.json",
        ),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

export type InstallOutcome = "present" | "installed" | "failed";

export async function installPinnedRelease(
  input: Readonly<{
    paths: BrainPaths;
    run: ToolRunner;
    /** The Bun that installs (the operator's ~/.local/bin/bun on a Remote
     * Environment, where the Platform itself runs on it). */
    bun: string;
    path: string | undefined;
  }>,
): Promise<InstallOutcome> {
  const directory = join(input.paths.releases, brainPin.commit);
  const command = releaseCommand(input.paths, brainPin.commit);
  const present =
    (await installedVersion(directory)) === brainPin.version &&
    (await stat(command).then(
      () => true,
      () => false,
    ));
  if (present) return "present";
  await mkdir(join(directory, ".install-home"), {
    recursive: true,
    mode: 0o700,
  });
  const result = await input
    .run(
      [
        input.bun,
        "add",
        "--global",
        `github:${brainPin.repository}#${brainPin.commit}`,
      ],
      installTimeoutMs,
      {
        HOME: join(directory, ".install-home"),
        BUN_INSTALL: directory,
        PATH: input.path ?? "/usr/local/bin:/usr/bin:/bin",
      },
    )
    .catch(() => "timeout" as const);
  if (result === "timeout" || result.exitCode !== 0) return "failed";
  return (await installedVersion(directory)) === brainPin.version
    ? "installed"
    : "failed";
}

/** The owner credential the server reads at start: 32 random bytes, hex,
 * 0600, written once and never shown. */
export async function ensureAdminToken(
  paths: BrainPaths,
): Promise<"kept" | "written"> {
  try {
    if ((await readFile(paths.adminToken, "utf8")).trim().length >= 32)
      return "kept";
  } catch {
    // written below
  }
  await mkdir(dirname(paths.adminToken), { recursive: true, mode: 0o700 });
  await writeDurableFile(
    dirname(paths.adminToken),
    basename(paths.adminToken),
    Buffer.from(randomBytes(32).toString("hex")),
  );
  return "written";
}
