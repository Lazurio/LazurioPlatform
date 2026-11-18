import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { unitMarker } from "../update/service-control";
import {
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
): Readonly<Record<string, string>> {
  const server = [
    unitMarker,
    "[Unit]",
    `Description=Lazurio Brain: the person's memory (gbrain MCP server, loopback 127.0.0.1:${brainPort})`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    "Environment=GBRAIN_HOME=%h",
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

/** Writes the units that differ; returns which. A unit of these names that
 * is not Lazurio's is never overwritten: the caller decides (`foreign`). */
export async function writeBrainUnits(
  directory: string,
  command: string,
): Promise<readonly string[]> {
  await mkdir(directory, { recursive: true });
  const changed: string[] = [];
  for (const [name, text] of Object.entries(renderBrainUnits(command))) {
    const current = await readFile(join(directory, name), "utf8").catch(
      () => undefined,
    );
    if (current === text) continue;
    await writeDurableFile(directory, name, Buffer.from(text));
    changed.push(name);
  }
  return Object.freeze(changed);
}
