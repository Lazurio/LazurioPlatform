import { join } from "node:path";

// GBrain of every Personal Remote Environment (plan LZD-0033 R11a): the
// person's memory, one MCP server over loopback that every agent of the
// Environment reaches through Executor. Lazurio installs and looks after it
// the way it looks after Executor (decision F44): pinned per Platform
// release, installed for the current user without root, run by a user unit,
// and watched by `lazurio doctor`. The brain's data stays where it is: the
// database in `~/.gbrain` and the vault, the brain's Markdown, as a checkout
// in the person's Personalspace (root decision 0046).
//
// A new pin is a reviewed change of this file: an exact tag of the fork
// Lazurio/gbrain (upstream stable plus the fork's `lazurio/` overlay and the
// code patches its `lazurio/patches.list` records), its commit and the
// version its package.json carries, after the fork's upgrade test from the
// previous pin passed (`lazurio/upgrade-test/run.sh`). The version names the
// fork release (`-lazurio.<N>`), so a new release on the same upstream
// version still reads as a new pin.

export type BrainPin = Readonly<{
  repository: string;
  tag: string;
  commit: string;
  version: string;
}>;

export const brainPin: BrainPin = Object.freeze({
  repository: "Lazurio/gbrain",
  tag: "v0.60.733.0-lazurio.2",
  commit: "4f9507186aa23c67649901b6e3cac8b03752bdcd",
  version: "0.60.733.0-lazurio.2",
});

/** The server's address: loopback only, the port every client of the brain
 * already uses (Hermes, Executor, the Launchpad's memory page). */
export const brainPort = 3131;
export const brainUrl = `http://127.0.0.1:${brainPort}`;

/** The user units. Their names are the ones the interim installer and
 * Machines gave the brain, so an install of either is taken over in place. */
export const brainUnit = "gbrain.service";
export const brainRefreshService = "lazurio-gbrain-refresh.service";
export const brainRefreshTimer = "lazurio-gbrain-refresh.timer";

/** The name of the Brain's MCP server in Executor. */
export const brainServerName = "brain";

/** The names of the keys Lazurio mints over the brain's admin API. The
 * Launchpad's keeps the name Machines gave it (R11b), so a key Machines
 * minted is kept, not minted twice. */
export const brainKeyNames = Object.freeze({
  launchpad: "lazurio-launchpad-memory",
  executor: "lazurio-executor-brain",
  probe: "lazurio-brain-probe",
});

export type BrainPaths = Readonly<{
  home: string;
  /** One directory per pinned commit, each with its own Bun install. */
  releases: string;
  /** The interim installer's command, taken over in place. */
  interimCommand: string;
  /** Machines' system command on a free Environment (`workspace_hermes`). */
  machinesCommand: string;
  units: string;
  brain: string;
  adminToken: string;
  /** Key handovers, 0600, beside the admin token. */
  launchpadKey: string;
  executorKey: string;
  probeKey: string;
  /** Lazurio's own record of the brain's release and keys. */
  state: string;
}>;

export function brainPaths(home: string): BrainPaths {
  const brain = join(home, ".gbrain");
  return Object.freeze({
    home,
    releases: join(home, ".local", "share", "lazurio-gbrain"),
    interimCommand: join(home, ".bun", "bin", "gbrain"),
    machinesCommand: "/usr/local/bin/gbrain",
    units: join(home, ".config", "systemd", "user"),
    brain,
    adminToken: join(brain, "serve", "admin-token"),
    launchpadKey: join(brain, "serve", "lazurio-launchpad.json"),
    executorKey: join(brain, "serve", "lazurio-executor.json"),
    probeKey: join(brain, "serve", "lazurio-probe.json"),
    state: join(home, ".local", "state", "lazurio", "brain", "state.json"),
  });
}

/** The command of a pinned release in its own directory. */
export const releaseCommand = (paths: BrainPaths, commit: string) =>
  join(paths.releases, commit, "bin", "gbrain");
