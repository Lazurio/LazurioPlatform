import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readShellInputs, shellDocument } from "../../launchpad/shell-document";
import { readMachineContext } from "../../machine/context";
import { hostedOperatorFolder } from "../../machine/operator";
import { shellMessages } from "../../shell/messages";
import {
  type EnvironmentIdentity,
  environmentIdentity,
} from "../../shell/view";
import { ensureAgentBrowserIdleTimeout } from "../agent-browser-config";
import {
  agentBrowserSocketDirectory,
  holderDirectory,
  holdsReader,
  liveTabsPath,
  readBootClock,
  watchHolds,
  writeLiveTabs,
} from "../contract/node";
import { browserCdpPort, browserScreenSize } from "../units";
import { sweepCookies } from "./cookies";
import { loopbackBrowser, startViewService } from "./service";

/** `lazurio browser serve --port <port> --origin <origin>`: the people's view
 * service (decision F39), as `lazurio-browser-view.service` runs it. It runs
 * until it is stopped. Not for agents: they use `lazurio browser window`. */
export const serveSynopsis =
  "browser serve --port <loopback port> --origin <https://browser.…>";

export function parseServeArgs(
  args: readonly string[],
): { port: number; origin: string } | null {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { port: { type: "string" }, origin: { type: "string" } },
    });
    if (positionals.length !== 0) return null;
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const origin = new URL(values.origin ?? "");
    if (
      (origin.protocol !== "https:" && origin.protocol !== "http:") ||
      origin.origin !== values.origin
    )
      return null;
    return { port, origin: origin.origin };
  } catch {
    return null;
  }
}

/** How the shell names this Environment (F39's addendum of 2026-10-12), for
 * the view's page: the Environment's own shell document from the declared
 * operator's Folder, read and produced exactly as the Launchpad's
 * `/.lazurio/shell.json` (`readShellInputs`, `shellDocument`), named by
 * `environmentIdentity` in the Folder's language. The switcher of this
 * Environment's apps says the same but for what only the person's account
 * adds (a name the Dashboard gave, its initials on a personal Environment),
 * which the app around a framed view then tells it. None without a hosted
 * Folder; a Folder that cannot be read rejects. */
export async function readViewIdentity(
  folder: () => Promise<string | undefined> = hostedOperatorFolder,
  ownerKey?: () => Promise<string | null>,
): Promise<EnvironmentIdentity | null> {
  const found = await folder();
  if (found === undefined) return null;
  const shell = shellDocument(await readShellInputs(found, { ownerKey }));
  return shell.current === null
    ? null
    : environmentIdentity(shell, shell.current, shellMessages(shell.locale));
}

/** Whether this Environment is public (root decision 0204, decision F55),
 * for the cookie sweep (#504): the handover's `entry.audience`, or, where it
 * cannot be read, the shell document of the declared operator's Folder,
 * which records it. Not public when neither can be read. */
export async function readViewPublic(
  handover: () => Promise<"public" | undefined> = async () =>
    (await readMachineContext()).context.entry?.audience,
  folder: () => Promise<string | undefined> = hostedOperatorFolder,
): Promise<boolean> {
  try {
    return (await handover()) === "public";
  } catch {}
  try {
    const found = await folder();
    if (found === undefined) return false;
    return shellDocument(await readShellInputs(found)).audience === "public";
  } catch {
    return false;
  }
}

export async function runViewService(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const options = parseServeArgs(args);
  if (options === null) {
    console.error(`Usage: lazurio ${serveSynopsis}`);
    return 2;
  }
  const log = (line: string) => console.error(line);
  const runtime = env.XDG_RUNTIME_DIR;
  // The apps' servers write their holds here (decision F47 point 4); the
  // directory exists from the start, so it is watched from the start.
  const holders = holderDirectory(env);
  if (holders !== undefined)
    await mkdir(holders, { recursive: true, mode: 0o700 }).catch(
      () => undefined,
    );
  // An agent works in a tab while its agent-browser daemon runs (decision F47
  // point 5), and agent-browser's own idle default skips the attached
  // Environment browser: its user config gets the hour (#326).
  const idle = await ensureAgentBrowserIdleTimeout(env).catch(
    () => "unreadable" as const,
  );
  if (idle === "set") log("agent-browser idle timeout set to 1h");
  else if (idle === "unreadable" || idle === "not-a-file")
    log(
      `agent-browser config left as it is (${idle}): its daemons keep no idle timeout unless it names one`,
    );
  else if (idle === "changed")
    log(
      "agent-browser config changed meanwhile: left as it is until the next start",
    );
  const sockets = agentBrowserSocketDirectory(env);
  const liveTabs = liveTabsPath(env);
  const service = startViewService({
    origin: options.origin,
    port: options.port,
    log,
    identity: () => readViewIdentity(),
    hub: {
      connect: loopbackBrowser(browserCdpPort),
      sweepCookies: async (cdp) => sweepCookies(cdp, await readViewPublic()),
      holds: holdsReader({ holders, sockets }, { log }),
      watchHolds: (changed) => watchHolds([holders, sockets], changed),
      ...(liveTabs === undefined
        ? {}
        : {
            writeTabs: (ids, takenAt) => writeLiveTabs(liveTabs, ids, takenAt),
            bootClock: () => readBootClock(),
          }),
      uploadDirectory: join(
        runtime?.startsWith("/") ? runtime : tmpdir(),
        "lazurio-browser-uploads",
      ),
      screen: browserScreenSize,
      log,
    },
  });
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
  await service.stop();
  return 0;
}
