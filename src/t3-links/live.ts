import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { machineBinding } from "../machine/binding";
import {
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import { readOwnFile } from "../ssh-access/environments";
import { resolveOnPath, runTool } from "../tools/status";
import {
  syncT3Links,
  type T3LinkSeams,
  type T3LinksReport,
  withT3LinksLock,
} from "./links";
import { chatT3Home } from "./settings";

// What the links of `links.ts` take from this Environment outside tests: its
// live handover, the user's `t3` and the label its running Chat answers with.

/** The origin of a T3 Code server on this Machine's loopback, as its runtime
 * state names it; anything else is not asked. */
export function loopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname === "/" &&
      url.search === "" &&
      url.username === "" &&
      url.password === ""
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** A label as T3 Code keeps one: trimmed, one line, at most 128 characters. */
export function environmentLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 && label.length <= 128 && !/\p{Cc}/u.test(label)
    ? label
    : undefined;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The label the user's running Chat T3 Code answers with: its runtime state
 * (`~/.t3/userdata/server-runtime.json`) names its loopback origin, and its
 * descriptor there (`/.well-known/t3/environment`) the label the service runs
 * with (`T3CODE_ENVIRONMENT_LABEL` of its unit). None when it does not run. */
export async function chatT3Label(
  home: string,
  uid: number | undefined,
  fetcher: Fetch = (url, init) => fetch(url, init),
): Promise<string | undefined> {
  const observed = await readOwnFile(
    join(home, chatT3Home, "userdata", "server-runtime.json"),
    uid,
  ).catch(() => undefined);
  if (observed?.kind !== "file") return undefined;
  let origin: string | undefined;
  try {
    origin = loopbackOrigin(
      (JSON.parse(observed.bytes.toString("utf8")) as { origin?: unknown })
        .origin,
    );
  } catch {
    return undefined;
  }
  if (origin === undefined) return undefined;
  try {
    const response = await fetcher(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return environmentLabel(
      ((await response.json()) as { label?: unknown }).label,
    );
  } catch {
    return undefined;
  }
}

/** The user's `t3`: on PATH, else `~/.local/bin/t3`, where T3 Code's
 * installer links it. */
export async function userT3(
  home: string,
  path: string | undefined,
): Promise<string | undefined> {
  const found = await resolveOnPath("t3", path, process.platform);
  if (found !== undefined) return found;
  const linked = join(home, ".local", "bin", "t3");
  try {
    await access(linked, constants.X_OK);
    return linked;
  } catch {
    return undefined;
  }
}

/** One look at this Environment's links under their lock, from the live
 * handover; `t3-missing` without the user's `t3`. */
export async function syncLiveT3Links(
  home: string,
  uid: number | undefined,
  source: MachineContextSource = productionMachineContextSource,
): Promise<T3LinksReport | Readonly<{ result: "busy" | "t3-missing" }>> {
  const observed = await readMachineContext(source);
  const machine = machineBinding(observed.context, observed.digest);
  const path = process.env.PATH;
  const t3 = await userT3(home, path);
  if (t3 === undefined) return { result: "t3-missing" };
  const seams: T3LinkSeams = {
    run: runTool,
    now: Date.now,
    home,
    uid,
    path,
    t3,
    label: () => chatT3Label(home, uid),
  };
  return withT3LinksLock(home, () => syncT3Links(seams, machine));
}
