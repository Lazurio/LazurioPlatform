import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { browserCdpPort, browserScreenSize } from "../units";
import { agentBrowserSocketDirectory } from "../window";
import { agentBoundTargets } from "./hub";
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
  const service = startViewService({
    origin: options.origin,
    port: options.port,
    log,
    hub: {
      connect: loopbackBrowser(browserCdpPort),
      boundTargets: () => agentBoundTargets(agentBrowserSocketDirectory(env)),
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
