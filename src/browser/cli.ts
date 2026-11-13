import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openTab } from "../launchpad/new-tab/hub-client";
import {
  LaunchpadStartRefused,
  readStartState,
} from "../launchpad/start-check";
import {
  type CliContext,
  type CommandOutput,
  operatorFolder,
} from "../update/cli";
import { runProcess } from "../update/self-check";
import {
  agentBrowserSocketDirectory,
  type DaemonSeams,
  stopSessionDaemon,
} from "./contract/node";
import { browserHandoverUrl } from "./contract/platform";
import {
  type BrowserCliAnswer,
  type BrowserCliKind,
  browserBounds,
  browserCliExit,
  browserCliText,
  browserViewUrl,
  navigableAddress,
  stripAppOf,
  threadSession,
} from "./contract/pure";
import { browserEntryOf } from "./view";
import {
  BrowserWindowFailure,
  bindThreadWindow,
  cdpSeams,
  ensureThreadWindow,
  type WindowSeams,
} from "./window";

/** `lazurio browser`: the agent's way into the Environment browser of a
 * Remote Environment (decisions F38 and F39). */
export const browserHelp = `browser window [--session <name>] [--url <url>] [--folder <absolute Folder>] [--json]
  The calling thread's own window of the Environment browser: the one its
  agent-browser session is bound to while it is open, otherwise a new window
  of the shared browser (with the Environment's sign-ins) bound to the
  session. The session is --session, else AGENT_BROWSER_SESSION (T3 Code sets
  it per thread), else codex-<CODEX_THREAD_ID>, else
  claude-<CLAUDE_CODE_SESSION_ID>. Prints the session, the link to its tab in
  the users' view (https://browser.…/t/<id>), where the user works in
  the same tab, and the agent-browser command to work in it. --json prints
  {schema: "lazurio.browser-cli.v1", kind: "browser-window", session,
  targetId, created, link, command}.
browser link [--session <name> | --url <url>] [--folder <absolute Folder>] [--json]
  The link for the user: with a session, the Launchpad's hand-over to that
  session's tab; with --url, a new tab at that address that nobody holds,
  which ends 30 s after its last viewer leaves (root decision 0191 point
  29); without either, the users' view of a new tab. --json prints
  {schema: "lazurio.browser-cli.v1", kind: "browser-link", session, link},
  with targetId for --url. Neither command opens an address on the view
  host of an Environment browser (browser.….lazurio.io).
browser done [--session <name>] [--folder <absolute Folder>] [--json]
  Lets go of the calling thread's window when its work there is done (root
  decision 0191 point 28): its agent-browser daemon stops, and the tab ends
  once nothing holds it and nobody views it. A user who has it open keeps
  it. It asks the session's own agent-browser daemon on its socket to shut
  down; it never signals a process. --json prints {schema:
  "lazurio.browser-cli.v1", kind: "browser-done", session, outcome}, outcome
  being stopped, none (no daemon listens),
  refused (the daemon did not shut down; nothing changed) or unconfirmed
  (no answer, or the daemon has not exited within 5 s: it may still hold the
  window; run done again).
  Exit status: 0 done, 10 this Environment has no Environment browser (with
  --json, {schema, kind, available: false}, the command's own kind), 2
  usage, 1 failure.
browser open <http(s) address> [--folder <absolute Folder>] [--json]
  The Remote Environment's default browser (root decision 0201 point 5): what
  BROWSER and xdg-open run there, so a CLI's sign-in page and an agent's page
  open in the Environment browser and a return to localhost completes inside
  the Environment. A new tab at the address, through the view's hub, and its
  link. In a T3 Code thread (AGENT_BROWSER_SESSION t3-…) the thread's session
  is bound to that tab, so the thread's panel shows it and its agent works
  there next; elsewhere nobody holds the tab, as with link --url. Only http
  and https, never the view host. --json prints {schema:
  "lazurio.browser-cli.v1", kind: "browser-open", session, targetId, link},
  session null where none is bound. Exit status: 0 opened, 10 this
  Environment has no Environment browser (nothing opened; open the address
  in your own browser), 2 usage or an address it does not open, 1 the view
  did not open the tab.
browser serve --port <loopback port> --origin <https://browser.…>
  The users' view service, as lazurio-browser-view.service runs it; it runs
  until it is stopped. Not for agents.`;

const synopsis =
  "browser window|link|done [--session <name>] [--url <url>] [--folder <absolute Folder>] [--json] | browser open <http(s) address> [--folder <absolute Folder>] [--json]";

/** The commands that run inside other programs, the view service the unit
 * runs and the default browser a CLI's BROWSER or xdg-open runs: they end
 * without the update notice, which would land in that program's output. */
export const browserCommandWithoutNotice = (args: readonly string[]) =>
  args[0] === "serve" || args[0] === "open";

/** The sessions whose app shows a tab the session is bound to: a T3 Code
 * thread's, whose strip records a tab its session newly binds and opens its
 * panel on it (F47 point 4), and whose earlier window its holder file keeps.
 * A Codex or Claude Code thread's session is never moved: nothing would show
 * the page, and its agent's window, which only its binding holds, would end. */
const showsBoundTab = (session: string | null): session is string =>
  session !== null && stripAppOf(session) === "t3code";

export type BrowserContext = CliContext &
  Readonly<{
    /** Tests only: the browser and agent-browser behind the window. */
    windowSeams?: WindowSeams | undefined;
    /** Tests only: the process table behind `done`. */
    daemonSeams?: DaemonSeams | undefined;
    /** Tests only: the hub's loopback request behind `link --url`. */
    openTab?: typeof openTab | undefined;
  }>;

const text = {
  en: {
    "not-declared":
      "This Environment has no Environment browser: the handover routes no browser view here. On a Remote Environment it comes with the gateway's browser route.",
    "no-session":
      "No session: pass --session <name> (letters, digits, - and _, at most 64), or run it from a thread of T3 Code, Codex or Claude Code.",
    "browser-unreachable":
      "The Environment browser does not answer on loopback. Run lazurio doctor.",
    "window-create-failed":
      "The Environment browser did not open a window. Run lazurio doctor.",
    "bind-failed":
      "The window is open, but agent-browser did not bind the session to it.",
    failed: "lazurio browser failed",
    session: "Session",
    view: "The user works with you in this tab",
    use: "Work in your window with",
    reused: "Your window is open already.",
    created: "Your window is open.",
    "hub-unreachable":
      "The users' view of the Environment browser did not open the tab. Run lazurio doctor.",
    "invalid-address": "The view does not open that address.",
    stopped:
      "Your window is let go: it ends once nothing holds it and nobody views it. Whoever has it open keeps it.",
    "no-daemon":
      "Your session has no running agent-browser: nothing to let go.",
    "daemon-refused":
      "Your session's agent-browser refused to shut down. Nothing changed; try again, or run lazurio doctor.",
    "daemon-unconfirmed":
      "Your session's agent-browser has not confirmed that it ended, so it may still hold your window. Run lazurio browser done again in a moment, or lazurio doctor.",
    "open-scheme":
      "The Environment browser opens only http and https addresses.",
    "open-not-declared":
      "The address did not open: this Environment has no Environment browser. Open it in your own browser.",
    opened: "Opened in the Environment browser",
    "opened-thread":
      "Opened in the Environment browser, in this thread's panel",
    "open-unbound":
      "This thread's panel does not show it: agent-browser did not bind the thread's session to the tab.",
  },
  cs: {
    "not-declared":
      "Toto Prostředí nemá prohlížeč Prostředí: předání sem nesměruje žádný pohled prohlížeče. V Prostředí na serveru přichází s cestou browser. v bráně.",
    "no-session":
      "Chybí sezení: zadejte --session <jméno> (písmena, číslice, - a _, nejvýš 64), nebo spusťte příkaz z vlákna T3 Code, Codexu nebo Claude Code.",
    "browser-unreachable":
      "Prohlížeč Prostředí na loopbacku neodpovídá. Spusťte lazurio doctor.",
    "window-create-failed":
      "Prohlížeč Prostředí neotevřel okno. Spusťte lazurio doctor.",
    "bind-failed":
      "Okno je otevřené, ale agent-browser k němu sezení nepřipojil.",
    failed: "lazurio browser selhal",
    session: "Sezení",
    view: "Tady s tebou uživatel pracuje ve stejné záložce",
    use: "Ve svém okně pracuj příkazem",
    reused: "Tvoje okno už je otevřené.",
    created: "Tvoje okno je otevřené.",
    "hub-unreachable":
      "Pohled prohlížeče Prostředí záložku neotevřel. Spusťte lazurio doctor.",
    "invalid-address": "Tuto adresu pohled neotevře.",
    stopped:
      "Okno je puštěné: skončí, až ho nic nedrží a nikdo se na něj nedívá. Kdo ho má otevřené, tomu zůstane.",
    "no-daemon": "Tvoje sezení nemá spuštěný agent-browser: není co pustit.",
    "daemon-refused":
      "agent-browser tvého sezení se odmítl ukončit. Nic se nezměnilo; zkus to znovu, nebo spusť lazurio doctor.",
    "daemon-unconfirmed":
      "agent-browser tvého sezení nepotvrdil, že skončil, takže tvoje okno možná pořád drží. Za chvíli spusť lazurio browser done znovu, nebo lazurio doctor.",
    "open-scheme": "Prohlížeč Prostředí otevírá jen adresy http a https.",
    "open-not-declared":
      "Adresa se neotevřela: toto Prostředí nemá prohlížeč. Otevřete ji ve svém prohlížeči.",
    opened: "Otevřeno v prohlížeči Prostředí",
    "opened-thread": "Otevřeno v prohlížeči Prostředí, v panelu tohoto vlákna",
    "open-unbound":
      "Panel tohoto vlákna stránku neukáže: agent-browser k záložce nepřipojil sezení vlákna.",
  },
} as const;

/** The person's link for `browser link`: the Launchpad's hand-over to a
 * session's tab (it opens the window when the session has none), or the
 * people's view of a new tab without a session. `browser window` prints the
 * tab's own address instead (`browserViewUrl`). */
export function browserLink(
  launchpadOrigin: string,
  browserOrigin: string,
  session: string | null,
): string {
  return session === null
    ? browserViewUrl(browserOrigin, null)
    : browserHandoverUrl(launchpadOrigin, session);
}

export const browserCommand = (session: string) =>
  `agent-browser --cdp ${browserBounds.devtoolsPort} --session ${session}`;

/** The command's answer with `--json` (C13): the contract's text, `schema`
 * beside its `kind`. */
const answered = (answer: BrowserCliAnswer) => browserCliText(answer);

type Action = "window" | "link" | "done" | "open";

const kindOf: Readonly<Record<Action, BrowserCliKind>> = {
  window: "browser-window",
  link: "browser-link",
  done: "browser-done",
  open: "browser-open",
};

/** The default browser's address (root decision 0201 point 5): http or
 * https only, as given. A file, a script, another app's scheme or a bare
 * path never reaches the Environment browser; `about:blank`, which `link
 * --url` takes, is no page to open for anyone. */
const webAddress = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** `browser open` (root decision 0201 point 5): a new tab at the address
 * through the view's hub, for the T3 Code thread's strip where the caller is
 * one, and that thread's session bound to it so its panel shows it. The page
 * is open once the hub opened it: a binding that fails says so on stderr and
 * answers without the thread. */
async function openDefault(
  given: string,
  browser: NonNullable<ReturnType<typeof browserEntryOf>>,
  json: boolean,
  copy: (typeof text)[keyof typeof text],
  context: BrowserContext,
): Promise<CommandOutput> {
  // Never the view host of an Environment browser (F50 point 2).
  const address = navigableAddress(given);
  if (address === null)
    return Object.freeze({
      code: browserCliExit.usage,
      stderr: copy["invalid-address"],
    });
  const caller = threadSession(undefined, context.env);
  const thread = showsBoundTab(caller) ? caller : null;
  const opened = await (context.openTab ?? openTab)(browser, address, thread);
  if (opened.kind !== "opened")
    return Object.freeze({
      code:
        opened.reason === "invalid-request"
          ? browserCliExit.usage
          : browserCliExit.failure,
      stderr:
        opened.reason === "invalid-request"
          ? copy["invalid-address"]
          : copy["hub-unreachable"],
    });
  const bound =
    thread !== null &&
    (await bindThreadWindow(
      thread,
      opened.tab,
      context.windowSeams ?? cdpSeams(context.env, context.run ?? runProcess),
    ));
  const link = browserViewUrl(browser.origin, opened.tab);
  return Object.freeze({
    code: browserCliExit.done,
    stdout: json
      ? answered({
          kind: "browser-open",
          session: bound ? thread : null,
          targetId: opened.tab,
          link,
        })
      : `${copy[bound ? "opened-thread" : "opened"]}: ${link}`,
    ...(thread !== null && !bound ? { stderr: copy["open-unbound"] } : {}),
  });
}

export async function runBrowserCommand(
  args: readonly string[],
  context: BrowserContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: browserCliExit.usage,
    stderr: `Usage: ${synopsis}`,
  });
  let values: {
    json?: boolean | undefined;
    session?: string | undefined;
    url?: string | undefined;
    folder?: string | undefined;
  };
  let action: Action;
  // `open`'s address: the one argument BROWSER and xdg-open pass.
  let given: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        session: { type: "string" },
        url: { type: "string" },
        folder: { type: "string" },
      },
    });
    values = parsed.values;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    const [positional] = parsed.positionals;
    if (positional === "open") {
      if (
        parsed.positionals.length !== 2 ||
        new Set(names).size !== names.length ||
        values.url !== undefined ||
        values.session !== undefined ||
        (values.folder !== undefined &&
          (!isAbsolute(values.folder) ||
            resolve(values.folder) !== values.folder))
      )
        return usage;
      given = parsed.positionals[1];
    } else if (
      parsed.positionals.length !== 1 ||
      (positional !== "window" &&
        positional !== "link" &&
        positional !== "done") ||
      new Set(names).size !== names.length ||
      (positional === "link" &&
        values.url !== undefined &&
        values.session !== undefined) ||
      (positional === "done" && values.url !== undefined) ||
      (values.url !== undefined &&
        !/^(https?:\/\/|about:blank$)/.test(values.url)) ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      return usage;
    action = positional;
  } catch {
    return usage;
  }
  const json = values.json === true;
  let locale: "cs" | "en" = "en";
  try {
    const folder = values.folder ?? (await operatorFolder(context));
    const state =
      folder === undefined
        ? null
        : await readStartState(folder, { locked: false });
    locale = state?.preferences.profile.locale === "cs" ? "cs" : "en";
    const copy = text[locale];
    // The default browser opens a web page, nothing else, wherever it runs.
    if (action === "open" && !webAddress(given as string))
      return Object.freeze({
        code: browserCliExit.usage,
        stderr: copy["open-scheme"],
      });
    const entry = state?.entry ?? null;
    const browser = browserEntryOf(entry);
    // Each command answers with its own kind, also without a browser
    // (F50 point 2).
    if (entry === null || browser === undefined)
      return Object.freeze({
        code: browserCliExit.noBrowser,
        ...(json
          ? { stdout: answered({ kind: kindOf[action], available: false }) }
          : {}),
        stderr: copy[action === "open" ? "open-not-declared" : "not-declared"],
      });
    if (action === "open")
      return await openDefault(given as string, browser, json, copy, context);
    const named =
      values.session === undefined && action === "link"
        ? null
        : threadSession(values.session, context.env);
    if (named === null && (action !== "link" || values.session !== undefined))
      return Object.freeze({
        code: browserCliExit.usage,
        stderr: copy["no-session"],
      });
    // No address on a view host of an Environment browser (F50 point 2),
    // for a window's first page as for the person's page.
    const address =
      values.url === undefined ? undefined : navigableAddress(values.url);
    if (address === null)
      return Object.freeze({
        code: browserCliExit.usage,
        stderr: copy["invalid-address"],
      });
    if (action === "link" && address !== undefined) {
      // A page for the person that nobody holds (0191 point 29): the hub
      // opens it on its loopback request, without a strip.
      const opened = await (context.openTab ?? openTab)(browser, address, null);
      if (opened.kind !== "opened")
        return Object.freeze({
          code: browserCliExit.failure,
          stderr:
            opened.reason === "invalid-request"
              ? copy["invalid-address"]
              : copy["hub-unreachable"],
        });
      const link = browserViewUrl(browser.origin, opened.tab);
      return Object.freeze({
        code: browserCliExit.done,
        stdout: json
          ? answered({
              kind: "browser-link",
              session: null,
              targetId: opened.tab,
              link,
            })
          : link,
      });
    }
    if (action === "link") {
      const link = browserLink(entry.externalOrigin, browser.origin, named);
      return Object.freeze({
        code: browserCliExit.done,
        stdout: json
          ? answered({ kind: "browser-link", session: named, link })
          : link,
      });
    }
    if (action === "done") {
      const session = named as string;
      const sockets = agentBrowserSocketDirectory(context.env);
      const outcome =
        sockets === undefined
          ? ("none" as const)
          : await stopSessionDaemon(sockets, session, context.daemonSeams);
      return Object.freeze({
        code:
          outcome === "stopped" || outcome === "none"
            ? browserCliExit.done
            : browserCliExit.failure,
        ...(json
          ? { stdout: answered({ kind: "browser-done", session, outcome }) }
          : outcome === "stopped"
            ? { stdout: copy.stopped }
            : outcome === "none"
              ? { stdout: copy["no-daemon"] }
              : {
                  stderr:
                    copy[
                      outcome === "refused"
                        ? "daemon-refused"
                        : "daemon-unconfirmed"
                    ],
                }),
      });
    }
    const session = named as string;
    const window = await ensureThreadWindow(
      session,
      address,
      context.windowSeams ?? cdpSeams(context.env, context.run ?? runProcess),
    );
    const command = browserCommand(session);
    const link = browserViewUrl(browser.origin, window.targetId);
    if (json)
      return Object.freeze({
        code: browserCliExit.done,
        stdout: answered({
          kind: "browser-window",
          session,
          targetId: window.targetId,
          created: window.created,
          link,
          command,
        }),
      });
    return Object.freeze({
      code: browserCliExit.done,
      stdout: [
        window.created ? copy.created : copy.reused,
        `${copy.session}: ${session}`,
        `${copy.view}: ${link}`,
        `${copy.use}: ${command} <command>`,
      ].join("\n"),
    });
  } catch (error) {
    const copy = text[locale];
    if (error instanceof BrowserWindowFailure)
      return Object.freeze({
        code: browserCliExit.failure,
        stderr: copy[error.reason],
      });
    return Object.freeze({
      code: browserCliExit.failure,
      stderr:
        error instanceof LaunchpadStartRefused
          ? `${copy.failed}: the Folder could not be read (${error.reason})`
          : copy.failed,
    });
  }
}
