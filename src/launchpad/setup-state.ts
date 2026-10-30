import type { ShellSetup } from "../shell/contract";
import { ghStatus } from "../tools/gh-status";
import type { ToolsEnvironment } from "../tools/overview";
import { sshStatus } from "../tools/ssh-key";
import { resolveOnPath, type ToolSignIn } from "../tools/status";
import {
  type ContentJob,
  type ContentList,
  parseContentJob,
  parseContentList,
} from "./content-client";

// What the current Environment still lacks, for the shell document's
// `setup` (root decisions 0188 and 0201, `shellSetup` in first-run.ts): its
// AI (tools/ai-probe.ts), GitHub's sign-in of its person (on the Automated
// Environment of its persona), read with this Environment's `gh` as
// Settings → Nástroje reads it, and its content, as the content routes
// answer. Only for an Environment with the onboarding; nothing is said when
// it is not known.

/** The server's content routes as this module reads them (the routes
 * object of `content-routes.ts` itself): what lives here (`GET /api/content`)
 * and the last installation (`GET /api/content/jobs/<id>` of the newest job),
 * each in the answer's own JSON shape, null when there is none. Trusted
 * composition, never HTTP input. */
export type ContentReader = Readonly<{
  list: () => Promise<unknown>;
  lastJob: () => Promise<unknown>;
}>;

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

/** gh's state for the shell, and the account it is signed in with (null
 * where it is not, or gh does not name one): what the soft check of the
 * Automated Environment compares (first-run.ts `ownAccount`, F27's addendum
 * of 2026-10-30). */
export type GithubReading = Readonly<{
  state: "connected" | "missing" | "unknown";
  account: string | null;
}>;

/** GitHub's sign-in of this Environment's person, kept a short while so
 * that the shell document, read on every page load of Chat and Automate,
 * does not ask GitHub each time. Settings → Nástroje's own readings and
 * every sign-in or sign-out through this Launchpad replace it. Not
 * installed is `missing`; a timeout or a failure is `unknown`. Connected is
 * gh signed in and this Environment reaching GitHub over SSH as that
 * account (decision F19, addendum 2026-10-19, #515): signed in without it
 * is `missing` for the shell, which counts it so, and the status's SSH part
 * runs the sign-in's own proof, kept by the environment's `sshProofs` where
 * it has them (the Launchpad's). The reading keeps the account with the
 * state (`reading`). */
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
  let known: Readonly<{ reading: GithubReading; at: number }> | null = null;
  let asking: Readonly<{
    generation: number;
    reading: Promise<GithubReading>;
  }> | null = null;
  // A reading or a forget while a question runs makes its answer stale: it
  // is not kept, and not answered either (Pablo's review of #524).
  let generation = 0;

  async function ask(): Promise<GithubReading> {
    const gh = await resolveOnPath(
      "gh",
      environment.path,
      environment.platform,
    );
    if (gh === undefined) return { state: "missing", account: null };
    if (!environment.home) return { state: "unknown", account: null };
    const env: Record<string, string> = { HOME: environment.home };
    if (environment.path) env.PATH = environment.path;
    for (const [name, value] of Object.entries(environment.xdg ?? {}))
      env[name] = value;
    const run = (command: readonly string[], timeoutMs: number) =>
      environment.run(command, timeoutMs, env);
    const { signIn, scopes } = await ghStatus(run, gh, timeout);
    if (signIn.state !== "signed-in") return readingOf(signIn);
    const [keygen, ssh] = await Promise.all([
      resolveOnPath("ssh-keygen", environment.path, environment.platform),
      resolveOnPath("ssh", environment.path, environment.platform),
    ]);
    return readingOf({
      ...signIn,
      ssh: await sshStatus({
        home: environment.home,
        gh,
        account: signIn.account,
        scopes,
        keygen,
        ssh,
        run,
        proofs: environment.sshProofs,
      }),
    });
  }

  /** The reading, asked when it is not known or older than the TTL. An
   * answer that a sign-in, link or sign-out through this Launchpad (or a
   * reading of Settings → Nástroje) overtook is from before it: asked
   * again, and after three such changes in a row `unknown`, never the
   * older reading. */
  async function reading(): Promise<GithubReading> {
    for (let again = 0; again < 3; again++) {
      if (known !== null && now() - known.at < ttl) return known.reading;
      const asked = generation;
      if (asking?.generation !== asked) {
        const answer: Promise<GithubReading> = ask()
          .catch(() => unknownReading)
          .then((answered) => {
            if (asked === generation) known = { reading: answered, at: now() };
            return answered;
          })
          .finally(() => {
            if (asking?.reading === answer) asking = null;
          });
        asking = { generation: asked, reading: answer };
      }
      const answered = await asking.reading;
      if (asked === generation) return answered;
    }
    return unknownReading;
  }

  return {
    reading,
    /** The reading's state alone. */
    async state(): Promise<GithubReading["state"]> {
      return (await reading()).state;
    },
    /** A reading of Settings → Nástroje: gh installed or not, and its
     * sign-in when it was probed. True when it says otherwise than the
     * reading known before: another state, or another account signed in. */
    remember(installed: boolean, signIn: ToolSignIn | undefined): boolean {
      if (installed && signIn === undefined) return false;
      const read: GithubReading = installed
        ? readingOf(signIn as ToolSignIn)
        : { state: "missing", account: null };
      const changed =
        known?.reading.state !== read.state ||
        known.reading.account !== read.account;
      generation += 1;
      known = { reading: read, at: now() };
      return changed;
    },
    /** A sign-in or sign-out changed it: ask again next time. */
    forget() {
      generation += 1;
      known = null;
    },
  };
}

const unknownReading: GithubReading = Object.freeze({
  state: "unknown",
  account: null,
});

// The first run's `githubFact` for the shell: connected only with SSH
// working, missing also when it does not (connected badly), unknown when it
// could not be read; with the account a signed-in gh names.
function readingOf(signIn: ToolSignIn): GithubReading {
  if (signIn.state === "signed-out") return { state: "missing", account: null };
  if (signIn.state !== "signed-in") return unknownReading;
  const account = signIn.account ?? null;
  return {
    state:
      signIn.ssh?.state === "linked"
        ? "connected"
        : signIn.ssh?.state === "not-linked"
          ? "missing"
          : "unknown",
    account,
  };
}

export type GithubProbe = ReturnType<typeof createGithubProbe>;

/** The shell document's `setup` as last read, so that `/.lazurio/shell.json`
 * never waits for GitHub (F36's addendum of 2026-10-08). `peek` answers at
 * once with what is known, and reads again in the background when nothing is
 * known yet or the last reading is older than the TTL (stale while
 * revalidating): until the first reading ends the document carries no
 * `setup`, which v1 allows. `forget` drops it where it changed (a sign-in or
 * sign-out of gh, an installation of the content, a profile change) and
 * reads it again at once; a reading that was running then is not kept. */
export function createSetupCache(
  read: () => Promise<ShellSetup | undefined>,
  options: Readonly<{ ttlMs?: number; now?: () => number }> = {},
) {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let known: Readonly<{ setup: ShellSetup | undefined; at: number }> | null =
    null;
  let generation = 0;
  let reading: Readonly<{ generation: number; done: Promise<void> }> | null =
    null;

  function refresh(): Promise<void> {
    if (reading !== null && reading.generation === generation)
      return reading.done;
    const asked = generation;
    const done = read()
      .catch(() => undefined)
      .then((setup) => {
        if (asked === generation) known = { setup, at: now() };
      })
      .finally(() => {
        if (reading?.done === done) reading = null;
      });
    reading = { generation: asked, done };
    return done;
  }

  return {
    /** What is known now, at once; a reading starts in the background when
     * there is none or it is older than the TTL. */
    peek(): ShellSetup | undefined {
      if (known === null || now() - known.at >= ttl) void refresh();
      return known?.setup;
    },
    /** It changed: say nothing until it is read again, which starts at
     * once, so the next load after the change finds it. */
    forget() {
      generation += 1;
      known = null;
      void refresh();
    },
    /** Resolves when the reading running now has ended. */
    settled: (): Promise<void> => reading?.done ?? Promise.resolve(),
  };
}
