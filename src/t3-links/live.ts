import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { MachineBinding } from "../folder/machine-binding";
import { machineBinding } from "../machine/binding";
import {
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import { resolveOnPath, runTool } from "../tools/status";
import {
  issueLinkPairing,
  type PairingAnswer,
  settleLinkPairing,
  syncT3Links,
  type T3LinkSeams,
  type T3LinksReport,
  withT3LinksLock,
} from "./links";
import { openChatT3Rpc } from "./rpc";

// What the links of `links.ts` take from this Environment outside tests: its
// live handover, the user's `t3` and its running Chat's RPC.

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

async function liveSeams(
  home: string,
  uid: number | undefined,
  machine: MachineBinding,
): Promise<T3LinkSeams | undefined> {
  const path = process.env.PATH;
  const t3 = await userT3(home, path);
  if (t3 === undefined) return undefined;
  const env = { HOME: home, ...(path ? { PATH: path } : {}) };
  return {
    run: runTool,
    now: Date.now,
    home,
    uid,
    path,
    t3,
    node: machine.network?.headscaleHostname ?? null,
    rpc: openChatT3Rpc({ home, uid, t3, run: runTool, env }),
  };
}

const liveMachine = async (source: MachineContextSource) => {
  const observed = await readMachineContext(source);
  return machineBinding(observed.context, observed.digest);
};

/** One look at this Environment's links under their lock, from the live
 * handover; `t3-missing` without the user's `t3`. */
export async function syncLiveT3Links(
  home: string,
  uid: number | undefined,
  source: MachineContextSource = productionMachineContextSource,
): Promise<T3LinksReport | Readonly<{ result: "busy" | "t3-missing" }>> {
  const machine = await liveMachine(source);
  const seams = await liveSeams(home, uid, machine);
  if (seams === undefined) return { result: "t3-missing" };
  return withT3LinksLock(home, () => syncT3Links(seams, machine));
}

/** The target's half of a pairing, under the same lock as the looks. */
export async function issueLiveLinkPairing(
  home: string,
  uid: number | undefined,
  sourceNode: string,
  source: MachineContextSource = productionMachineContextSource,
): Promise<PairingAnswer | Readonly<{ result: "busy" | "t3-missing" }>> {
  const machine = await liveMachine(source);
  const seams = await liveSeams(home, uid, machine);
  if (seams === undefined) return { result: "t3-missing" };
  return withT3LinksLock(home, () =>
    issueLinkPairing(seams, machine, sourceNode),
  );
}

/** The target's settling of a source's code, under the same lock. */
export async function settleLiveLinkPairing(
  home: string,
  uid: number | undefined,
  sourceNode: string,
  source: MachineContextSource = productionMachineContextSource,
): Promise<
  | "settled"
  | "pending"
  | "refused"
  | Readonly<{ result: "busy" | "t3-missing" }>
> {
  const machine = await liveMachine(source);
  const seams = await liveSeams(home, uid, machine);
  if (seams === undefined) return { result: "t3-missing" };
  return withT3LinksLock(home, () =>
    settleLinkPairing(seams, machine, sourceNode),
  );
}
