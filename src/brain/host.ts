import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { askActiveWork } from "../buddy/gateway-refresh";
import { type PresetName, personalMemoryHere } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { presetKinds } from "../launchpad/shell-document";
import { resolveOnPath, type ToolRunner } from "../tools/status";
import type { ProcessRunner } from "../update/self-check";
import { brainHttp, healthVersion } from "./admin";
import { brainPaths, brainUrl } from "./pin";
import type { SetupHost } from "./setup";
import type { BrainContext } from "./status";

// The production composition of the person's brain (plan LZD-0033 R11a):
// this process's home and user manager, on a Remote Environment on Linux
// whose declared operator this account is (the signal every Remote
// Environment convergence uses), and only where that Environment is a
// Personal one: a Work, Team or public Environment has no person's memory.

export function processBrainHost(
  input: Readonly<{
    hostedFolder: () => Promise<string | undefined>;
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    run: ToolRunner;
    service: ProcessRunner;
  }>,
): SetupHost {
  const home =
    input.env.HOME !== undefined && isAbsolute(input.env.HOME)
      ? input.env.HOME
      : "/nonexistent";
  const unsupported = (
    reason: Extract<BrainContext, { kind: "unsupported" }>["reason"],
  ): BrainContext => Object.freeze({ kind: "unsupported", reason });
  const hermesHome = join(home, ".hermes");
  const vault = {
    folder: join(home, "Lazurio"),
    gh: undefined as string | undefined,
  };
  // Buddy is idle where there is no Buddy, or where his gateway says no work
  // and no agent runs; a gateway that does not answer is not idle.
  const idle = async () =>
    (await lstat(hermesHome).then(
      () => false,
      () => true,
    )) || (await askActiveWork(hermesHome)) === "idle";
  return Object.freeze({
    async context(): Promise<BrainContext> {
      vault.gh = await resolveOnPath("gh", input.env.PATH, input.platform);
      if (input.platform !== "linux" || home === "/nonexistent")
        return unsupported("workstation");
      let folder: string | undefined;
      try {
        folder = await input.hostedFolder();
      } catch {
        return unsupported("handover-unreadable");
      }
      if (folder === undefined) return unsupported("workstation");
      if (folder !== join(home, "Lazurio")) return unsupported("not-operator");
      try {
        const { preferences } = await readFolderState(join(folder, ".lazurio"));
        const preset = preferences.preset.name;
        // The one gate of the person's memory, shared with the Folder's text.
        if (
          !Object.hasOwn(presetKinds, preset) ||
          !personalMemoryHere(preset as PresetName, preferences.machine)
        )
          return unsupported("not-personal");
      } catch {
        return unsupported("not-personal");
      }
      return Object.freeze({ kind: "supported" });
    },
    paths: brainPaths(home),
    globalUnits: "/etc/systemd/user",
    handover: "/etc/lazurio/brain-handover",
    health: () => healthVersion(brainHttp, brainUrl),
    run: input.run,
    service: input.service,
    http: brainHttp,
    bun: join(home, ".local", "bin", "bun"),
    env: input.env,
    vault,
    idle,
  });
}
