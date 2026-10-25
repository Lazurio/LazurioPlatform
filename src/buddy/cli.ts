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
import { createHermesGateway, type HermesGateway } from "./hermes-gateway";
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
 * Environment. */
export const buddyHelp = `buddy chat [--apply] [--folder <absolute Folder>] [--json]
  Buddy's chat in Lazurio (decision F61): the T3 Code of his own in
  ~/.t3-buddy on the user's Osobní Prostředí, whose one provider is Buddy,
  the Hermes Agent over ACP. Reads, without writing, whether its settings hold
  Lazurio's members: the provider instance buddy runs \`hermes acp\` with
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
  with the layer inside a Git work tree, or without a name in
  ~/.config/lazurio/buddy/persona.json that T3 Code takes
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
  restarted) or failed. Ctrl-C cancels it on Hermes ({kind: "cancelled"}
  once it can no longer complete). While it still may, nothing is cancelled:
  {kind: "blocked", reason: "sign-in-finishing"} when Hermes no longer holds
  it but its last round may still sign Buddy in (try again in a few
  minutes), or "sign-in-running" when Hermes did not confirm the cancel; a
  line on stderr says so in words. Buddy keeps working on his sign-in until
  a new one replaces it. sign-out: Hermes forgets
  Buddy's sign-in ({kind: "signed-out"}); Buddy stops answering until he is
  signed in again. Without Buddy's gateway {kind: "unavailable", reason};
  without Buddy here {kind: "blocked", reason: "buddy-absent"}. JSON on
  stdout. The Folder is found as for lazurio doctor.
  Exit status: 0 works, signed in or signed out; 10 waits or no Buddy here;
  1 unknown, failed, cancelled, blocked or unavailable; 2 usage.`;

export type BuddyContext = CliContext &
  Readonly<{
    /** Tests only: the runner of `hermes acp --check`. */
    toolRun?: ToolRunner | undefined;
    /** Tests only: Buddy's gateway; this account's own otherwise. */
    gateway?: HermesGateway | undefined;
    /** Where a running sign-in writes each state as it changes: stdout. */
    write?: ((line: string) => void) | undefined;
    /** Ctrl-C: cancels a running sign-in. */
    signal?: AbortSignal | undefined;
    /** Tests only: the wait between two questions of a running sign-in. */
    pollMs?: number | undefined;
  }>;

const usageText =
  "Usage: buddy chat [--apply] | buddy status | buddy sign-in start | buddy sign-out, each with [--folder <absolute Folder>] [--json]";
const usage = Object.freeze({ code: exitUsage, stderr: usageText });

const exitOf = (answer: BuddyChat): number =>
  answer.state === "managed"
    ? exitOk
    : answer.state === "unavailable"
      ? exitFailure
      : exitUpdateAvailable;

const commands: Readonly<Record<string, readonly string[]>> = {
  chat: ["apply", "json", "folder"],
  status: ["json", "folder"],
  "sign-in start": ["json", "folder"],
  "sign-out": ["json", "folder"],
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
  let values: { apply?: boolean; folder?: string };
  try {
    const parsed = parseArgs({
      args: [...args],
      tokens: true,
      allowPositionals: true,
      strict: true,
      options: {
        apply: { type: "boolean" },
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
  if (command === "chat") {
    try {
      const folder = values.folder ?? (await operatorFolder(context));
      const answer: BuddyChat =
        folder === undefined
          ? { kind: "buddy-chat", state: "skipped", reason: "not-personal" }
          : await buddyChat(
              toolsEnvironmentOf(
                context.env,
                context.platform,
                context.toolRun,
              ),
              { folder, apply: values.apply === true },
            );
      return { code: exitOf(answer), stdout: JSON.stringify(answer) };
    } catch {
      return {
        code: exitFailure,
        stderr: "Could not inspect Buddy's chat in this Environment.",
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

/** A blocked answer in words, on stderr. */
function blockedWords(
  answer: BuddySignInAnswer | BuddySignOutAnswer,
): Readonly<{ stderr?: string }> {
  if (answer.kind !== "blocked") return {};
  return {
    stderr:
      answer.reason === "sign-in-finishing"
        ? "Buddy's previous sign-in may still finish. Try again in a few minutes."
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
