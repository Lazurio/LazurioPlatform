import {
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import type { BrowserEntry } from "./units";

/** The handover's `entry.browser` (Machines writes it for a guest whose
 * gateway roster routes `browser.`), the signal the Environment browser's
 * units are converged on (decision F38). Read only after the base is known
 * supervised and hosted; a handover without it, or unreadable, has none. */
export async function handoverBrowserEntry(
  source: MachineContextSource = productionMachineContextSource,
): Promise<BrowserEntry | undefined> {
  const { context } = await readMachineContext(source);
  const browser = context.entry?.browser;
  return browser === undefined
    ? undefined
    : Object.freeze({
        origin: browser.external_origin,
        listenPort: browser.listen_port,
      });
}
