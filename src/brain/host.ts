import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ActiveWork, askActiveWork } from "../buddy/gateway-refresh";
import { buddyT3Unit } from "../buddy/t3-runtime";
import { type PresetName, personalMemoryHere } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { presetKinds } from "../launchpad/shell-document";
import { resolveOnPath, type ToolRunner } from "../tools/status";
import type { ProcessRunner } from "../update/self-check";
import { brainHttp, healthVersion } from "./admin";
import { meaningUrl } from "./meaning-pin";
import { brainPaths, brainUrl } from "./pin";
import type { SetupHost } from "./setup";
import type { BrainContext } from "./status";

// The production composition of the person's brain (plan LZD-0033 R11a):
// this process's home and user manager, on a Remote Environment on Linux
// whose declared operator this account is (the signal every Remote
// Environment convergence uses), and only where that Environment is a
// Personal one: a Work, Team or public Environment has no person's memory.

/** Whether a path is there: `absent` only for ENOENT; any other error of
 * the read is `unknown`. */
async function presence(
  path: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "unknown";
  }
}

/** Whether Buddy is idle, so the brain's server may stop for a moment.
 * Fail closed: only a confirmed answer counts.
 * - Buddy of Hermes (`~/.hermes`): his gateway says no work and no agent runs.
 * - Buddy GEN4 in T3 Code (its unit `lazurio-t3-buddy.service`): T3 Code has
 *   no signal of a turn in progress Lazurio can read, so only a T3 Code that
 *   systemd confirms is not running counts as idle.
 * - No Buddy at all (neither there, as a confirmed absence): idle.
 * A read that fails, or a gateway or systemd that does not answer, is busy. */
export async function buddyIdle(
  input: Readonly<{
    home: string;
    service: ProcessRunner;
    activeWork: (hermesHome: string) => Promise<ActiveWork>;
  }>,
): Promise<boolean> {
  const hermesHome = join(input.home, ".hermes");
  const hermes = await presence(hermesHome);
  const t3 = await presence(
    join(input.home, ".config", "systemd", "user", buddyT3Unit),
  );
  if (hermes === "unknown" || t3 === "unknown") return false;
  if (hermes === "present" && (await input.activeWork(hermesHome)) !== "idle")
    return false;
  if (t3 === "present") {
    const answer = await input
      .service(["systemctl", "--user", "is-active", buddyT3Unit], 60_000)
      .catch(() => "timeout" as const);
    if (
      answer === "timeout" ||
      !["inactive", "failed"].includes(answer.stdout.trim())
    )
      return false;
  }
  return true;
}

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
  const vault = {
    folder: join(home, "Lazurio"),
    gh: undefined as string | undefined,
  };
  const idle = () =>
    buddyIdle({
      home,
      service: input.service,
      activeWork: askActiveWork,
    });
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
    meaning: async () => {
      const answer = await brainHttp("GET", `${meaningUrl}/health`);
      return answer !== null && answer.status === 200;
    },
    run: input.run,
    service: input.service,
    http: brainHttp,
    bun: join(home, ".local", "bin", "bun"),
    env: input.env,
    vault,
    idle,
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
  });
}
