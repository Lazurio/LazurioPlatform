import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { unitMarker } from "../update/service-control";
import { meaningConcurrency, meaningUnit, meaningUrl } from "./meaning-pin";
import {
  type BrainPaths,
  brainPort,
  brainRefreshService,
  brainRefreshTimer,
  brainUnit,
  brainUrl,
} from "./pin";

// Lazurio's user units of the brain, in ~/.config/systemd/user, under the
// names the interim installer and Machines used. The server unit names the
// command of one release in its own directory, so a start, a crash restart
// or a reboot always runs the release the brain is on; only setup's move
// rewrites it, after its copy of the brain. The owner credential is read
// from its 0600 file at start, never written into a unit.

export function renderBrainUnits(
  command: string,
  meaning = false,
): Readonly<Record<string, string>> {
  // Search by meaning (`./meaning.ts`): gbrain asks the local model server
  // on loopback, started before it and not required by it, so the memory
  // runs on with keyword search when the model does not.
  // gbrain sends 20 embedding requests at once by default, each up to 32
  // chunks with a 60 s limit: on a 4-vCPU Environment the local model queues
  // them until they time out and are retried (measured on Bob, 2026-11-19).
  // Two at a time keep the model busy without a request waiting a minute.
  const model = meaning
    ? [
        `Environment=LLAMA_SERVER_BASE_URL=${meaningUrl}/v1`,
        `Environment=GBRAIN_EMBED_CONCURRENCY=${meaningConcurrency}`,
      ]
    : [];
  const after = meaning ? [`Wants=${meaningUnit}`, `After=${meaningUnit}`] : [];
  const server = [
    unitMarker,
    "[Unit]",
    `Description=Lazurio Brain: the person's memory (gbrain MCP server, loopback 127.0.0.1:${brainPort})`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    ...after,
    "",
    "[Service]",
    "Type=simple",
    "Environment=GBRAIN_HOME=%h",
    ...model,
    "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "WorkingDirectory=%h",
    "ExecStartPre=/usr/bin/test -r %h/.gbrain/serve/admin-token",
    `ExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec ${command} serve --http --bind 127.0.0.1 --port ${brainPort} --public-url ${brainUrl}'`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  const refresh = [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Brain: bring the vault up to date from GitHub",
    `After=${brainUnit}`,
    `Requires=${brainUnit}`,
    "",
    "[Service]",
    "Type=oneshot",
    "Environment=GBRAIN_HOME=%h",
    ...model,
    "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "WorkingDirectory=%h",
    `ExecStart=${command} sources refresh default --json`,
    "",
  ].join("\n");
  const timer = [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Brain: refresh the vault from GitHub every 15 minutes",
    "",
    "[Timer]",
    "OnBootSec=5min",
    "OnUnitActiveSec=15min",
    "RandomizedDelaySec=60",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return Object.freeze({
    [brainUnit]: server,
    [brainRefreshService]: refresh,
    [brainRefreshTimer]: timer,
  });
}

/** Who wrote a unit of these names:
 * - `lazurio`: byte for byte what `renderBrainUnits` writes for a command
 *   Lazurio may name, a pinned release in its own directory or the interim
 *   installer's command it took over in place, with or without the model;
 * - `interim`: the interim installer's own unit, by its exact command line;
 * - `foreign`: anything else; `unreadable`: it cannot be read; `absent`.
 * A marker alone never makes a unit Lazurio's. */
export type UnitOwner =
  | "absent"
  | "lazurio"
  | "interim"
  | "foreign"
  | "unreadable";

/** The interim installer's lines (buddy-install.sh 2026-10-30.7). */
const interimServeExec = `ExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec %h/.bun/bin/gbrain serve --http --bind 127.0.0.1 --port ${brainPort} --public-url ${brainUrl}'`;
const interimRefreshExec =
  "ExecStart=%h/.bun/bin/gbrain sources refresh default --json";

const execLines = (text: string) =>
  text.split("\n").filter((line) => /^\s*Exec/.test(line));

/** Whether `command` is one Lazurio may name: a release in its directory
 * (`<releases>/<commit>/bin/gbrain`) or the interim installer's command. */
function allowedCommand(paths: BrainPaths, command: string): boolean {
  if (command === paths.interimCommand) return true;
  const prefix = `${paths.releases}/`;
  return (
    command.startsWith(prefix) &&
    /^[0-9a-f]{40}\/bin\/gbrain$/.test(command.slice(prefix.length))
  );
}

export function unitOwnerOf(
  paths: BrainPaths,
  name: string,
  text: string,
): Exclude<UnitOwner, "absent" | "unreadable"> {
  const named =
    name === brainUnit
      ? /exec (\S+) serve --http /.exec(text)
      : name === brainRefreshService
        ? /^ExecStart=(\S+) sources refresh /m.exec(text)
        : null;
  const commands =
    name === brainRefreshTimer
      ? [paths.interimCommand]
      : named?.[1] !== undefined && allowedCommand(paths, named[1])
        ? [named[1]]
        : [];
  for (const command of commands)
    for (const meaning of [false, true])
      if (renderBrainUnits(command, meaning)[name] === text) return "lazurio";
  if (text.startsWith(unitMarker)) return "foreign";
  const exec = execLines(text);
  if (name === brainUnit && exec.length === 1 && exec[0] === interimServeExec)
    return "interim";
  if (
    name === brainRefreshService &&
    exec.length === 1 &&
    exec[0] === interimRefreshExec
  )
    return "interim";
  // A timer starts only its own service, this name's: the interim
  // installer's has no command and names no other unit.
  if (
    name === brainRefreshTimer &&
    exec.length === 0 &&
    !/^\s*Unit=/m.test(text)
  )
    return "interim";
  return "foreign";
}

export async function unitOwner(
  paths: BrainPaths,
  directory: string,
  name: string,
): Promise<UnitOwner> {
  let text: string;
  try {
    text = await readFile(join(directory, name), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "unreadable";
  }
  return unitOwnerOf(paths, name, text);
}

export class ForeignBrainUnit extends Error {
  constructor(
    readonly unit: string,
    readonly owner: UnitOwner,
  ) {
    super(`${unit} is ${owner}`);
  }
}

/** Writes the units that differ; returns which. A unit of these names that
 * is neither absent nor Lazurio's is never overwritten (`ForeignBrainUnit`),
 * except the interim installer's own during its takeover. */
export async function writeBrainUnits(
  paths: BrainPaths,
  command: string,
  meaning = false,
  options: Readonly<{ takeOver?: boolean }> = {},
): Promise<readonly string[]> {
  const directory = paths.units;
  await mkdir(directory, { recursive: true });
  const units = renderBrainUnits(command, meaning);
  for (const name of Object.keys(units)) {
    const owner = await unitOwner(paths, directory, name);
    if (
      owner !== "absent" &&
      owner !== "lazurio" &&
      !(owner === "interim" && options.takeOver)
    )
      throw new ForeignBrainUnit(name, owner);
  }
  const changed: string[] = [];
  for (const [name, text] of Object.entries(units)) {
    const current = await readFile(join(directory, name), "utf8").catch(
      () => undefined,
    );
    if (current === text) continue;
    await writeDurableFile(directory, name, Buffer.from(text));
    changed.push(name);
  }
  return Object.freeze(changed);
}
