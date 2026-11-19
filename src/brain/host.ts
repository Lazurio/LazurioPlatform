import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ActiveWork, askActiveWork } from "../buddy/gateway-refresh";
import { buddyT3Unit } from "../buddy/t3-runtime";
import { buddyGeneration } from "../folder/machine-binding";
import { type PresetName, personalMemoryHere } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { presetKinds } from "../launchpad/shell-document";
import { resolveOnPath, type ToolRunner } from "../tools/status";
import type { ProcessRunner } from "../update/self-check";
import { brainHttp, healthVersion } from "./admin";
import { buddyGen4Turn } from "./buddy-turn";
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
 * Fail closed: only a confirmed answer counts. Which Buddy, by the
 * Environment's binding (`buddyGeneration`):
 * - Buddy GEN4, a thread of the shared T3 Code: no turn of his thread runs,
 *   as T3 Code's agent CLI says (`./buddy-turn.ts`); neither Hermes nor
 *   `lazurio-t3-buddy.service` counts, as the conversion leaves them.
 * - Otherwise as before: Buddy of Hermes (`~/.hermes`) when his gateway says
 *   no work and no agent runs; his own T3 Code (`lazurio-t3-buddy.service`)
 *   only when systemd confirms it is not running; no Buddy at all (neither
 *   there, as a confirmed absence) idle.
 * A binding that cannot be read, a read that fails, or a gateway, systemd or
 * T3 Code that does not answer, is busy. */
export async function buddyIdle(
  input: Readonly<{
    home: string;
    service: ProcessRunner;
    activeWork: (hermesHome: string) => Promise<ActiveWork>;
    /** The binding's Buddy; `unreadable` where it could not be read. */
    generation: 3 | 4 | undefined | "unreadable";
    gen4Turn: () => Promise<ActiveWork>;
  }>,
): Promise<boolean> {
  if (input.generation === "unreadable") return false;
  if (input.generation === 4) return (await input.gen4Turn()) === "idle";
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
  // Which Buddy the binding names, read with the context; until then, and
  // where it cannot be read, Buddy counts as busy.
  let generation: 3 | 4 | undefined | "unreadable" = "unreadable";
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env))
    if (value !== undefined) env[name] = value;
  const idle = async () =>
    buddyIdle({
      home,
      service: input.service,
      activeWork: askActiveWork,
      generation,
      gen4Turn: async () =>
        buddyGen4Turn({
          run: input.run,
          t3:
            (await resolveOnPath("t3", input.env.PATH, input.platform)) ??
            join(home, ".local", "bin", "t3"),
          home,
          env,
        }),
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
        generation = buddyGeneration(preferences.machine?.entry);
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
