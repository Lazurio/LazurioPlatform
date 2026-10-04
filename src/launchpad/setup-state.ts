import type { ShellSetup } from "../shell/contract";
import { ghStatus } from "../tools/gh-status";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath, type ToolSignIn } from "../tools/status";
import {
  type ContentJob,
  type ContentList,
  parseContentJob,
  parseContentList,
} from "./content-client";
import { contentFact } from "./content-view";
import { signsInAsPerson } from "./first-run";

// What the current Environment still lacks, for the shell document's
// `setup` (root decision 0188): GitHub's sign-in of its person, read with
// this Environment's `gh` as Settings → Nástroje reads it, and its content,
// as the content routes answer. Only for an Environment that signs in as
// its person; nothing is said when it is not known.

/** The server's content routes as this module reads them (DEV-6644 content
 * install): what lives here (`GET /api/content`) and the last installation
 * (`GET /api/content/jobs/<id>` of the newest job), each in the answer's own
 * JSON shape, null when there is none. Trusted composition, never HTTP
 * input. */
export type ContentReader = Readonly<{
  list: () => Promise<unknown>;
  lastJob: () => Promise<unknown>;
}>;

/** No content routes: nothing is known about the content. */
export const unavailableContent: ContentReader = Object.freeze({
  list: async () => null,
  lastJob: async () => null,
});

/** The content as read, each null when it is not there or unreadable. */
export async function readContent(
  reader: ContentReader,
): Promise<Readonly<{ list: ContentList | null; job: ContentJob | null }>> {
  const [list, job] = await Promise.all([
    reader.list().then(parseContentList, () => null),
    reader.lastJob().then(parseContentJob, () => null),
  ]);
  return { list, job };
}

/** The shell document's `setup` from what is known: undefined where the
 * preset does not sign in as its person or GitHub's state is not known. */
export function shellSetup(
  input: Readonly<{
    preset: string;
    github: "connected" | "missing" | "unknown";
    list: ContentList | null;
    job: ContentJob | null;
  }>,
): ShellSetup | undefined {
  if (!signsInAsPerson(input.preset) || input.github === "unknown")
    return undefined;
  const fact =
    input.list === null
      ? ({ state: "none" } as const)
      : contentFact(input.list, input.job);
  const base = { github: input.github } as const;
  if (fact.state === "none" || fact.state === "loading") return base;
  if (fact.state === "ready") return { ...base, content: "ready" };
  const item = fact.item;
  const read =
    item === null
      ? undefined
      : item.kind === "organization"
        ? {
            kind: "organization" as const,
            name: item.name ?? item.login,
            login: item.login,
          }
        : { kind: "personalspace" as const, login: item.login };
  return {
    ...base,
    content: fact.state === "failed" ? "failed" : "missing",
    ...(read === undefined ? {} : { item: read }),
  };
}

/** GitHub's sign-in of this Environment's person, kept a short while so
 * that the shell document, read on every page load of Chat and Automate,
 * does not ask GitHub each time. Settings → Nástroje's own readings and
 * every sign-in or sign-out through this Launchpad replace it. Not
 * installed is `missing`; a timeout or a failure is `unknown`. */
export function createGithubProbe(
  environment: ToolsEnvironment,
  options: Readonly<{
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  }> = {},
) {
  const ttl = options.ttlMs ?? 60_000;
  const timeout = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  let known: Readonly<{
    state: "connected" | "missing" | "unknown";
    at: number;
  }> | null = null;
  let asking: Promise<"connected" | "missing" | "unknown"> | null = null;
  // A reading or a forget while a question runs makes its answer stale.
  let generation = 0;

  async function ask(): Promise<"connected" | "missing" | "unknown"> {
    const gh = await resolveOnPath(
      "gh",
      environment.path,
      environment.platform,
    );
    if (gh === undefined) return "missing";
    if (!environment.home) return "unknown";
    const env: Record<string, string> = { HOME: environment.home };
    if (environment.path) env.PATH = environment.path;
    for (const [name, value] of Object.entries(environment.xdg ?? {}))
      env[name] = value;
    const { signIn } = await ghStatus(
      (command, timeoutMs) => environment.run(command, timeoutMs, env),
      gh,
      timeout,
    );
    return stateOf(signIn);
  }

  return {
    /** The state, asked when it is not known or older than the TTL. */
    async state(): Promise<"connected" | "missing" | "unknown"> {
      if (known !== null && now() - known.at < ttl) return known.state;
      if (asking === null) {
        const asked = generation;
        asking = ask()
          .catch(() => "unknown" as const)
          .then((state) => {
            if (asked === generation) known = { state, at: now() };
            return state;
          })
          .finally(() => {
            asking = null;
          });
      }
      return asking;
    },
    /** A reading of Settings → Nástroje: gh installed or not, and its
     * sign-in when it was probed. */
    remember(installed: boolean, signIn: ToolSignIn | undefined) {
      if (installed && signIn === undefined) return;
      generation += 1;
      known = {
        state: installed ? stateOf(signIn as ToolSignIn) : "missing",
        at: now(),
      };
    },
    /** A sign-in or sign-out changed it: ask again next time. */
    forget() {
      generation += 1;
      known = null;
    },
  };
}

function stateOf(signIn: ToolSignIn): "connected" | "missing" | "unknown" {
  return signIn.state === "signed-in"
    ? "connected"
    : signIn.state === "signed-out"
      ? "missing"
      : "unknown";
}

export type GithubProbe = ReturnType<typeof createGithubProbe>;
