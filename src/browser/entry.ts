import {
  type MachineContext,
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import { type BrowserEntry, browserLocalEntry } from "./units";

/** The handover's `entry.browser` (Machines writes it for a guest whose
 * gateway roster routes `browser.`), the signal the Environment browser's
 * units are converged on (decision F38). Read only after the base is known
 * supervised and hosted; a handover without it, or unreadable, has none. */
export async function handoverBrowserEntry(
  source: MachineContextSource = productionMachineContextSource,
): Promise<BrowserEntry | undefined> {
  const { context } = await readMachineContext(source);
  return browserEntryOfContext(context);
}

/** `entry.browser` of a parsed handover. Its `local_port`, with the
 * Environment's name from the module origins, is the gateway's loopback
 * entry for the browser itself (#504); a handover without it has none, and
 * the browser's flags stay as they were. */
export function browserEntryOfContext(
  context: MachineContext,
): BrowserEntry | undefined {
  const browser = context.entry?.browser;
  if (browser === undefined) return undefined;
  const local =
    browser.local_port === undefined
      ? undefined
      : browserLocalEntry(
          browser.local_port,
          context.entry?.modules.origin_template,
        );
  return Object.freeze({
    origin: browser.external_origin,
    listenPort: browser.listen_port,
    ...(local === undefined ? {} : { local }),
  });
}
