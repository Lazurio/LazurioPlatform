import { lstat, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { systemctl } from "../update/service-control";
import { answers, type MoveHost, stoppedForSure } from "./move";
import { brainRefreshTimer, brainUnit } from "./pin";

// The agents' conversations stay out of the memory (plan LZD-0033 R11a,
// decided by Matěj on 2026-11-21: "rozhovory do paměti vypnout - stačí, že
// budou v prostředí dle mého. Ale, dedikované zápisky by se měly propisovat
// do gbrainu, to pořád platí."). gbrain's conversation archive (0.60.733)
// is on by default on a personal brain: its upkeep, while the server is
// quiet, reads the harnesses' sessions in the home (Claude Code, Codex and
// others) and writes them as pages of the source `conversations`. Lazurio
// switches it off for every brain it runs; the deliberate pages (written
// over MCP, through Executor or the memory's skill) are not touched.
//
// The switch is in gbrain's database (`transcripts.archive.enabled`), which
// the running server holds, so it is set with the server stopped: before
// the first start of a new brain, and with a short stop, only while Buddy is
// idle, for one that runs already. A mark in the brain's directory records
// it: every copy and every way back of the brain carries the mark with the
// database it belongs to, and a brain made anew (from its vault) has none,
// so it is switched off again.

/** The mark in the brain's directory that its archive is off. */
export const archiveOffMark = "lazurio-archive-off.json";

export type ArchiveResult =
  | "off"
  | "waits-idle"
  | "waits:release-unknown"
  | `failed:${string}`;

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const service = (host: MoveHost, ...args: string[]) =>
  systemctl({ run: host.service, env: host.env }, ...args);

/** Whether this brain's archive is recorded as off. */
export const archiveIsOff = (host: Pick<MoveHost, "paths">) =>
  present(join(host.paths.brain, archiveOffMark));

/** gbrain's own switch, with the server stopped; then the mark. */
async function switchOff(
  host: MoveHost,
  command: string,
): Promise<ArchiveResult> {
  const ran = await host
    .run([command, "transcripts", "archive", "off", "--json"], 60_000, {
      HOME: host.paths.home,
      GBRAIN_HOME: host.paths.home,
      PATH: host.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    })
    .catch(() => "timeout" as const);
  if (ran === "timeout") return "failed:timeout";
  if (ran.exitCode !== 0) return "failed:refused";
  try {
    const at = (host.now ?? (() => new Date()))().toISOString();
    const mark = join(host.paths.brain, archiveOffMark);
    await writeFile(`${mark}.tmp`, `${JSON.stringify({ at })}\n`, {
      mode: 0o600,
    });
    await rename(`${mark}.tmp`, mark);
  } catch {
    return "failed:mark";
  }
  return "off";
}

/** The archive off for a brain whose server is not started yet (a new
 * brain, before its first start). */
export async function archiveOffBeforeStart(
  host: MoveHost,
  command: string,
): Promise<ArchiveResult> {
  if (await archiveIsOff(host)) return "off";
  return switchOff(host, command);
}

/** The archive off for a brain whose server runs: a short stop, only while
 * Buddy is idle, and the server started again whatever the switch did. */
export async function convergeArchiveOff(
  host: MoveHost,
  command: string | undefined,
): Promise<ArchiveResult> {
  if (await archiveIsOff(host)) return "off";
  if (command === undefined) return "waits:release-unknown";
  if (!(await host.idle())) return "waits-idle";
  if (!(await stoppedForSure(host))) {
    await service(host, "start", brainUnit);
    await service(host, "start", brainRefreshTimer);
    return "failed:not-stopped";
  }
  const result = await switchOff(host, command);
  const started =
    (await service(host, "start", brainUnit)) && (await answers(host)) !== null;
  await service(host, "start", brainRefreshTimer);
  if (!started) return "failed:start";
  return result;
}
