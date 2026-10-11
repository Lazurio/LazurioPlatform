import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { browserCdpPort, browserScreenSize } from "../units";
import { agentBrowserSocketDirectory } from "../window";
import {
  holderDirectory,
  liveTabsPath,
  readBootClock,
  readHolds,
  watchHolds,
  writeLiveTabs,
} from "./holds";
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
  const sockets = agentBrowserSocketDirectory(env);
  const liveTabs = liveTabsPath(env);
  const service = startViewService({
    origin: options.origin,
    port: options.port,
    log,
    hub: {
      connect: loopbackBrowser(browserCdpPort),
      holds: () => readHolds({ holders, sockets }),
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
