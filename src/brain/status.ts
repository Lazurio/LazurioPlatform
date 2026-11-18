import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { unitMarker } from "../update/service-control";
import {
  type BrainPaths,
  type brainKeyNames,
  brainPin,
  brainUnit,
  releaseCommand,
} from "./pin";

// What is there of the person's brain, read only (no network beyond
// loopback, nothing written): who runs it, which release, whether it
// answers, and which of Lazurio's keys are handed over. The one read of
// `lazurio brain status`, doctor and the Launchpad's setup decision.

export type BrainUnsupportedReason =
  /** Not a Remote Environment on Linux. */
  | "workstation"
  | "handover-unreadable"
  | "not-operator"
  /** A Work, Team or public Environment: the person's memory is only in a
   * Personal Environment. */
  | "not-personal";

export type BrainContext =
  | Readonly<{ kind: "supported" }>
  | Readonly<{ kind: "unsupported"; reason: BrainUnsupportedReason }>;

/** Who runs the brain's server unit today. */
export type BrainOwner =
  /** Lazurio's own unit (written by `lazurio brain setup`). */
  | "lazurio"
  /** The interim installer's unit in ~/.config/systemd/user, running the
   * command in ~/.bun: taken over in place. */
  | "interim"
  /** Machines' global unit on a free Environment (`workspace_hermes`):
   * Machines' until they hand it over. */
  | "machines"
  /** No unit at all. */
  | "absent"
  /** A unit of that name nobody of these wrote: left alone. */
  | "foreign";

export type BrainKeys = Readonly<
  Record<keyof typeof brainKeyNames, "handed-over" | "missing" | "invalid">
>;

export type BrainStatus =
  | Readonly<{ state: "unsupported"; reason: BrainUnsupportedReason }>
  | Readonly<{
      state:
        | "not-installed"
        | "adoptable"
        | "machines"
        | "foreign"
        | "outdated"
        | "not-running"
        | "running";
      owner: BrainOwner;
      /** The pinned release. */
      pin: string;
      /** The version the server answers with, or null when it does not. */
      running: string | null;
      /** Whether the brain's data is there (`~/.gbrain/config.json`). */
      brain: boolean;
      keys: BrainKeys;
    }>;

export type BrainHost = Readonly<{
  context(): Promise<BrainContext>;
  paths: BrainPaths;
  /** Where Machines' global user units are (`/etc/systemd/user`). */
  globalUnits: string;
  /** GET /health of the loopback server: its version, or null. */
  health(): Promise<string | null>;
}>;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The interim installer's unit: its `ExecStart` runs `gbrain serve` from
 * the person's `~/.bun` (buddy-install.sh 2026-10-30.7). */
const interimServe = /^ExecStart=.*%h\/\.bun\/bin\/gbrain serve --http\b/m;
/** Machines' global unit: `workspace_hermes` runs the system command. */
const machinesServe = /^ExecStart=.*\/usr\/local\/bin\/gbrain serve --http\b/m;

export async function brainOwner(
  paths: BrainPaths,
  globalUnits: string,
): Promise<BrainOwner> {
  const own = await readText(join(paths.units, brainUnit));
  if (own !== undefined) {
    if (own.startsWith(unitMarker)) return "lazurio";
    if (interimServe.test(own)) return "interim";
    return "foreign";
  }
  const global = await readText(join(globalUnits, brainUnit));
  if (global === undefined) return "absent";
  return machinesServe.test(global) ? "machines" : "foreign";
}

/** A handover is the Launchpad's shape: `{url, token}`, loopback url. */
async function handover(
  path: string,
): Promise<"handed-over" | "missing" | "invalid"> {
  const text = await readText(path);
  if (text === undefined) return "missing";
  try {
    const value = JSON.parse(text) as { url?: unknown; token?: unknown };
    return typeof value.url === "string" &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) &&
      typeof value.token === "string" &&
      value.token.length >= 16
      ? "handed-over"
      : "invalid";
  } catch {
    return "invalid";
  }
}

export async function brainKeys(paths: BrainPaths): Promise<BrainKeys> {
  return Object.freeze({
    launchpad: await handover(paths.launchpadKey),
    executor: await handover(paths.executorKey),
    probe: await handover(paths.probeKey),
  });
}

export async function brainStatus(host: BrainHost): Promise<BrainStatus> {
  const context = await host.context();
  if (context.kind === "unsupported")
    return Object.freeze({ state: "unsupported", reason: context.reason });
  const { paths } = host;
  const owner = await brainOwner(paths, host.globalUnits);
  const running = await host.health();
  const brain = await exists(join(paths.brain, "config.json"));
  const keys = await brainKeys(paths);
  const base = { owner, pin: brainPin.version, running, brain, keys };
  const state = (() => {
    switch (owner) {
      case "absent":
        return "not-installed" as const;
      case "interim":
        return "adoptable" as const;
      case "machines":
        return "machines" as const;
      case "foreign":
        return "foreign" as const;
      case "lazurio":
        if (running === null) return "not-running" as const;
        return running === brainPin.version
          ? ("running" as const)
          : ("outdated" as const);
    }
  })();
  return Object.freeze({ state, ...base });
}

/** Whether the pinned release is installed in its own directory. */
export const pinnedInstalled = (paths: BrainPaths) =>
  exists(releaseCommand(paths, brainPin.commit));
