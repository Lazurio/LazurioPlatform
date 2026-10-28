import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { readFolderState } from "../folder/read-state";
import { type BuddyLocale, buddyAnswer } from "../launchpad/buddy-routes";
import { toolsEnvironmentOf } from "../tools/overview";
import type { ToolRunner } from "../tools/status";
import {
  type CliContext,
  type CommandOutput,
  operatorFolder,
} from "../update/cli";
import {
  exitFailure,
  exitOk,
  exitUpdateAvailable,
  exitUsage,
} from "../update/errors";
import { type BuddyChat, buddyChat } from "./chat";
import type { ActiveWork } from "./gateway-refresh";
import { createHermesGateway, type HermesGateway } from "./hermes-gateway";
import { type BuddyPersona, buddyPersona } from "./persona-apply";
import {
  type BuddySignInAnswer,
  type BuddySignOutAnswer,
  buddySignInPollMs,
  createBuddySignIn,
} from "./sign-in";
import { buddyStatus, readBuddyFacts } from "./status";

/** `lazurio buddy chat` (decision F61): what Machines run after they install
 * Buddy's T3 Code, as they run `lazurio chat defaults --apply` for Chat.
 * `lazurio buddy status`, `sign-in start` and `sign-out` (decision F63): the
 * Launchpad's Buddy routes on the same core, for an operator on the
 * Environment. `lazurio buddy persona` (decision F64): Buddy's persona and
 * what the Platform derives from it, which the installer and Machines run
 * where they rendered it themselves. */
export const buddyHelp = `buddy chat [--apply] [--folder <absolute Folder>] [--json]
  Buddy's chat in Lazurio (decision F61): the T3 Code of his own in
  ~/.t3-buddy on the user's Osobní Prostředí, whose one provider is Buddy,
  the Hermes Agent over ACP. Reads, without writing, whether its settings hold
  Lazurio's members: the provider instance buddy, named as Buddy is named in
  his persona, runs \`hermes acp\` with
  HERMES_HOME=~/.hermes, LAZURIO_BUDDY_CHANNEL=t3 and T3 Code's acting
  sender (T3CODE_ACTING_SENDER=buddy, T3CODE_ACTING_FOR and
  T3CODE_ACTING_FOR_ACCUSATIVE, the user's name from Buddy's persona), so
  his steps in the user's threads show „Buddy za <jméno>“; Codex and Claude
  are off; no turn continues by itself after an update; agents get no T3
  browser. --apply writes these members of ~/.t3-buddy/userdata/settings.json
  and keeps every other one. Settings already in place need nothing; a change
  takes T3 Code's ownership of that home, as T3's own offline commands do, so
  while Buddy's T3 Code runs it is refused (t3-running): stop its unit, apply,
  start it. Unavailable, and nothing written, without Hermes's ACP server
  (hermes acp --check), without Buddy's layer in the Folder's .agents/buddy,
  with the layer inside a Git work tree, or without a persona in
  ~/.config/lazurio/buddy/persona.json that passes its checks
  (buddy-persona-unreadable); on any other Environment it does
  nothing (not-personal). The instance's unit, port, route and project are
  Machines'; the composer's steer and queue are T3 Code's own. JSON on
  stdout: {kind: "buddy-chat", state, reason?}. The Folder is found as for
  lazurio doctor.
  Exit status: 0 managed, 10 outdated or not personal, 1 unavailable, 2 usage.
buddy status [--folder <absolute Folder>] [--json]
buddy sign-in start [--folder <absolute Folder>] [--json]
buddy sign-out [--folder <absolute Folder>] [--json]
  Buddy's state and his own ChatGPT sign-in (decision F63), on the user's
  Osobní Prostředí whose Machine binding records Buddy's origin, through his
  running Hermes gateway (hermes-gateway.service, its control socket in
  ~/.hermes and its loopback API), exactly as the Launchpad's Začínáme and
  Nastavení → Buddy do. Hermes's own sign-in worker saves the sign-in into
  Buddy's auth store; never hermes auth add, and nothing here reads or writes
  that store. status: {kind: "buddy", state: works|waits|unknown,
  reason?: not-running, signIn: {state: connected|none|unknown}, locale}.
  sign-in start: starts a sign-in by code and holds it, as lazurio tools
  login does: the first line is {kind: "pending", session, code, url,
  expiresAt, pollMs} with OpenAI's page and the one-time code for the person,
  then each change on its own line until it ends: signed-in, or failed with
  expired, refused (OpenAI refused a sign-in by code), lost (Buddy's gateway
  restarted) or failed. It starts only where Buddy's Hermes advertises its
  OAuth cancellation contract (Lazurio/hermes-agent#17); otherwise
  {kind: "blocked", reason: "hermes-outdated"}: Buddy needs an update before
  he can be signed in here. Ctrl-C cancels it on Hermes ({kind: "cancelled"}
  once it can no longer complete); when Hermes did not confirm the cancel,
  {kind: "blocked", reason: "sign-in-running"}, and the sign-in may still
  complete. A line on stderr says each refusal in words. Buddy keeps working
  on his sign-in until a new one replaces it. sign-out: Hermes forgets
  Buddy's sign-in ({kind: "signed-out"}); Buddy stops answering until he is
  signed in again. Without Buddy's gateway {kind: "unavailable", reason};
  without Buddy here {kind: "blocked", reason: "buddy-absent"}. JSON on
  stdout. The Folder is found as for lazurio doctor.
  Exit status: 0 works, signed in or signed out; 10 waits or no Buddy here;
  1 unknown, failed, cancelled, blocked or unavailable; 2 usage.
buddy persona [--apply] [--confirm] [--folder <absolute Folder>] [--json]
  Buddy's persona (decision F64): his name, how he addresses the user, the
  user's name in three cases and an optional tone, in
  ~/.config/lazurio/buddy/persona.json (lazurio.buddy-persona.v1), the one
  source the Platform derives from. Reads, without writing, the persona and
  whether what derives from it is in place: ~/.hermes/SOUL.md in the Folder's
  locale (0600), the acting sender of Buddy's gateway in
  hermes-gateway.service.d/lazurio-acting-sender.conf (0644), both byte for
  byte as buddy-install.sh renders them, whether his gateway still runs from
  before them (restart pending), whether a refresh of his stored prompts is
  owed (after a change of the persona, or because his Lazurio layer in the
  Folder, .agents/buddy/.hermes.md and his skills, is not the one his last
  complete refresh was built from, as recorded in
  ~/.local/state/lazurio/buddy/prompt-inputs.json; none recorded counts once),
  and his T3 settings as lazurio buddy chat reads them. --apply, one at
  a time, replaces each file that differs on its own, has systemd reread the
  units, and brings the change to his running conversations: hermes sessions
  repair-prompts clears the stored prompt of every conversation that holds
  one and can still take a turn (live, or ended in a way Hermes resumes, as
  the web chat's ACP session is after each disconnect), checked in Hermes's
  store, and once Hermes's active-work answers
  that Buddy is idle, hermes-gateway.service restarts once, never on units
  systemd failed to reread; his T3 settings are applied, his T3 Code's unit
  stopped and started around them only when T3 Code has no run going; after
  a complete refresh and that restart, the layer as the apply found it when
  it began is recorded. A layer file that is no regular file or cannot be read
  counts by a token of its own and is named (layer-unreadable). What
  waits answers waiting, what failed answers failed with its reason, and both
  stay visible until the next --apply or the Launchpad finishes them.
  --confirm records that the person confirmed the names (confirmed_at, kept
  once set). A persona that fails the installer's checks is refused with the
  member (invalid-<member>) and nothing is written. On any other
  Environment it does nothing (not-personal). JSON on stdout:
  {kind: "buddy-persona", state, reason?, persona?, locale?, files?,
  prompts?, restart?, chat?}. The Folder is found as for lazurio doctor.
  Exit status: 0 in place or applied, 10 outdated, waiting or not personal,
  1 unavailable or failed, 2 usage.`;

export type BuddyContext = CliContext &
  Readonly<{
    /** Tests only: the runner of `hermes` and `systemctl`. */
    toolRun?: ToolRunner | undefined;
    /** Tests only: Buddy's gateway; this account's own otherwise. */
    gateway?: HermesGateway | undefined;
    /** Where a running sign-in writes each state as it changes: stdout. */
    write?: ((line: string) => void) | undefined;
    /** Ctrl-C: cancels a running sign-in. */
    signal?: AbortSignal | undefined;
    /** Tests only: the wait between two questions of a running sign-in. */
    pollMs?: number | undefined;
    /** Tests only: Hermes's `active-work` verb. */
    activeWork?: ((hermesHome: string) => Promise<ActiveWork>) | undefined;
    /** Tests only: the clock of `confirmed_at`. */
    now?: (() => Date) | undefined;
  }>;

const usageText =
  "Usage: buddy chat [--apply] | buddy status | buddy sign-in start | buddy sign-out | buddy persona [--apply] [--confirm], each with [--folder <absolute Folder>] [--json]";
const usage = Object.freeze({ code: exitUsage, stderr: usageText });

const exitOf = (answer: BuddyChat): number =>
  answer.state === "managed"
    ? exitOk
    : answer.state === "unavailable"
      ? exitFailure
      : exitUpdateAvailable;

const personaExitOf = (answer: BuddyPersona): number =>
  answer.state === "in-place" || answer.state === "applied"
    ? exitOk
    : answer.state === "unavailable" || answer.state === "failed"
      ? exitFailure
      : exitUpdateAvailable;

const commands: Readonly<Record<string, readonly string[]>> = {
  chat: ["apply", "json", "folder"],
  status: ["json", "folder"],
  "sign-in start": ["json", "folder"],
  "sign-out": ["json", "folder"],
  persona: ["apply", "confirm", "json", "folder"],
};

const absent = Object.freeze({
  code: exitUpdateAvailable,
  stdout: JSON.stringify({ kind: "blocked", reason: "buddy-absent" }),
});

/** Buddy here: the binding records his origin; with the Folder's locale. */
async function buddyHere(
  folder: string | undefined,
): Promise<Readonly<{ locale: BuddyLocale }> | undefined> {
  if (folder === undefined) return undefined;
  const { preferences } = await readFolderState(join(folder, ".lazurio"));
  return preferences.machine?.entry?.buddyOrigin === undefined
    ? undefined
    : { locale: preferences.profile.locale };
}

export async function runBuddyCommand(
  args: readonly string[],
  context: BuddyContext,
): Promise<CommandOutput> {
  let command: string;
  let values: { apply?: boolean; confirm?: boolean; folder?: string };
  try {
    const parsed = parseArgs({
      args: [...args],
      tokens: true,
      allowPositionals: true,
      strict: true,
      options: {
        apply: { type: "boolean" },
        confirm: { type: "boolean" },
        json: { type: "boolean" },
        folder: { type: "string" },
      },
    });
    command = parsed.positionals.join(" ");
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    const allowed = Object.hasOwn(commands, command)
      ? commands[command]
      : undefined;
    if (
      allowed === undefined ||
      names.some((name) => !allowed.includes(name)) ||
      new Set(names).size !== names.length ||
      (parsed.values.folder !== undefined && !isAbsolute(parsed.values.folder))
    )
      return usage;
    values = parsed.values;
  } catch {
    return usage;
  }
  if (command === "chat" || command === "persona") {
    try {
      const folder = values.folder ?? (await operatorFolder(context));
      const tools = toolsEnvironmentOf(
        context.env,
        context.platform,
        context.toolRun,
      );
      if (command === "persona") {
        const answer: BuddyPersona =
          folder === undefined
            ? {
                kind: "buddy-persona",
                state: "skipped",
                reason: "not-personal",
              }
            : await buddyPersona(
                {
                  tools,
                  env: context.env,
                  activeWork: context.activeWork,
                  now: context.now,
                },
                {
                  folder,
                  apply: values.apply === true,
                  confirm: values.confirm === true,
                },
              );
        return { code: personaExitOf(answer), stdout: JSON.stringify(answer) };
      }
      const answer: BuddyChat =
        folder === undefined
          ? { kind: "buddy-chat", state: "skipped", reason: "not-personal" }
          : await buddyChat(tools, { folder, apply: values.apply === true });
      return { code: exitOf(answer), stdout: JSON.stringify(answer) };
    } catch {
      return {
        code: exitFailure,
        stderr:
          command === "persona"
            ? "Could not inspect Buddy's persona in this Environment."
            : "Could not inspect Buddy's chat in this Environment.",
      };
    }
  }
  let here: Awaited<ReturnType<typeof buddyHere>>;
  try {
    here = await buddyHere(values.folder ?? (await operatorFolder(context)));
  } catch {
    return {
      code: exitFailure,
      stderr: "Could not read this Environment's Folder.",
    };
  }
  if (here === undefined) return absent;
  const gateway =
    context.gateway ??
    createHermesGateway({
      home: toolsEnvironmentOf(context.env, context.platform).home,
    });
  if (command === "status") {
    const answer = buddyAnswer(
      buddyStatus(await readBuddyFacts(gateway)),
      here.locale,
    );
    return {
      code:
        answer.state === "works"
          ? exitOk
          : answer.state === "waits"
            ? exitUpdateAvailable
            : exitFailure,
      stdout: JSON.stringify(answer),
    };
  }
  const signIn = createBuddySignIn({ gateway });
  if (command === "sign-out") {
    const answer = await signIn.signOut();
    return {
      code: answer.kind === "signed-out" ? exitOk : exitFailure,
      stdout: JSON.stringify(answer),
      ...blockedWords(answer),
    };
  }
  const answer = await holdSignIn(signIn, context);
  return {
    code: answer.kind === "signed-in" ? exitOk : exitFailure,
    stdout: "",
    ...blockedWords(answer),
  };
}

/** A blocked answer, or an account that cannot run Buddy, in words, on
 * stderr. */
function blockedWords(
  answer: BuddySignInAnswer | BuddySignOutAnswer,
): Readonly<{ stderr?: string }> {
  if (answer.kind === "unusable")
    return {
      stderr:
        answer.reason === "no-subscription"
          ? "This ChatGPT account has no subscription, and Buddy needs one. He was signed out again; sign him in with an account that has a ChatGPT subscription."
          : "This ChatGPT account's subscription is not enough for Buddy. He was signed out again; sign him in with another account.",
    };
  if (answer.kind !== "blocked") return {};
  return {
    stderr:
      answer.reason === "hermes-outdated"
        ? "Buddy needs an update before he can be signed in here."
        : "Buddy's sign-in could not be cancelled and may still finish. Try again.",
  };
}

/** `sign-in start`: the terminal holds the sign-in for as long as it runs,
 * as `lazurio tools login` does, and writes each state as it changes. */
async function holdSignIn(
  signIn: ReturnType<typeof createBuddySignIn>,
  context: BuddyContext,
): Promise<BuddySignInAnswer> {
  const write = context.write ?? ((line: string) => console.log(line));
  const pollMs = context.pollMs ?? buddySignInPollMs;
  const aborted = new Promise<"aborted">((resolve) => {
    if (context.signal?.aborted) resolve("aborted");
    context.signal?.addEventListener("abort", () => resolve("aborted"), {
      once: true,
    });
  });
  let state: BuddySignInAnswer = await signIn.start();
  write(JSON.stringify(state));
  let shown = JSON.stringify(state);
  while (state.kind === "pending") {
    const session = state.session;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      aborted,
      new Promise<"poll">((resolve) => {
        wait = setTimeout(() => resolve("poll"), pollMs);
      }),
    ]);
    clearTimeout(wait);
    state =
      outcome === "aborted"
        ? await signIn.cancel(session)
        : await signIn.poll(session);
    const next = JSON.stringify(state);
    if (next !== shown) write(next);
    shown = next;
  }
  return state;
}
