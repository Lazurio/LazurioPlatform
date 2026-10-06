import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LaunchpadStartRefused,
  readStartState,
} from "../launchpad/start-check";
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
import { runProcess } from "../update/self-check";
import { browserCdpPort } from "./units";
import { browserEntryOf, browserViewUrl } from "./view";
import {
  BrowserWindowFailure,
  cdpSeams,
  ensureThreadWindow,
  threadSession,
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
  the people's view (https://browser.…/t/<id>), where the Operator works in
  the same tab, and the agent-browser command to work in it. --json prints
  {kind: "browser-window", session, targetId, created, link, command}.
browser link [--session <name>] [--folder <absolute Folder>] [--json]
  The link for the person: with a session, the Launchpad's hand-over to that
  session's tab; without one, the people's view of a new tab.
  Exit status: 0 done, 10 this Environment has no Environment browser, 2
  usage, 1 failure.
browser serve --port <loopback port> --origin <https://browser.…>
  The people's view service, as lazurio-browser-view.service runs it; it runs
  until it is stopped. Not for agents.`;

const synopsis =
  "browser window|link [--session <name>] [--url <url>] [--folder <absolute Folder>] [--json]";

export type BrowserContext = CliContext &
  Readonly<{
    /** Tests only: the browser and agent-browser behind the window. */
    windowSeams?: WindowSeams | undefined;
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
    view: "The Operator works with you in this tab",
    use: "Work in your window with",
    reused: "Your window is open already.",
    created: "Your window is open.",
  },
  cs: {
    "not-declared":
      "Tenhle Environment nemá prohlížeč Environmentu: předání sem nesměruje žádný pohled prohlížeče. Na Remote Environmentu přichází s cestou browser. v bráně.",
    "no-session":
      "Chybí sezení: zadej --session <jméno> (písmena, číslice, - a _, nejvýš 64), nebo spusť příkaz z vlákna T3 Code, Codexu nebo Claude Code.",
    "browser-unreachable":
      "Prohlížeč Environmentu na loopbacku neodpovídá. Spusť lazurio doctor.",
    "window-create-failed":
      "Prohlížeč Environmentu neotevřel okno. Spusť lazurio doctor.",
    "bind-failed":
      "Okno je otevřené, ale agent-browser k němu sezení nepřipojil.",
    failed: "lazurio browser selhal",
    session: "Sezení",
    view: "Tady s tebou Operátor pracuje ve stejné záložce",
    use: "Ve svém okně pracuj příkazem",
    reused: "Tvoje okno už je otevřené.",
    created: "Tvoje okno je otevřené.",
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
    : `${launchpadOrigin}/.lazurio/browser?session=${session}`;
}

export const browserCommand = (session: string) =>
  `agent-browser --cdp ${browserCdpPort} --session ${session}`;

export async function runBrowserCommand(
  args: readonly string[],
  context: BrowserContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: ${synopsis}`,
  });
  let values: {
    json?: boolean | undefined;
    session?: string | undefined;
    url?: string | undefined;
    folder?: string | undefined;
  };
  let action: "window" | "link";
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
    if (
      parsed.positionals.length !== 1 ||
      (positional !== "window" && positional !== "link") ||
      new Set(names).size !== names.length ||
      (positional === "link" && values.url !== undefined) ||
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
    const entry = state?.entry ?? null;
    const browser = browserEntryOf(entry);
    if (entry === null || browser === undefined)
      return Object.freeze({
        code: exitUpdateAvailable,
        ...(json
          ? {
              stdout: JSON.stringify({
                kind: "browser-window",
                available: false,
              }),
            }
          : {}),
        stderr: copy["not-declared"],
      });
    const named =
      values.session === undefined && action === "link"
        ? null
        : threadSession(values.session, context.env);
    if (named === null && (action === "window" || values.session !== undefined))
      return Object.freeze({ code: exitUsage, stderr: copy["no-session"] });
    if (action === "link") {
      const link = browserLink(entry.externalOrigin, browser.origin, named);
      return Object.freeze({
        code: exitOk,
        stdout: json
          ? JSON.stringify({ kind: "browser-link", session: named, link })
          : link,
      });
    }
    const session = named as string;
    const window = await ensureThreadWindow(
      session,
      values.url,
      context.windowSeams ?? cdpSeams(context.env, context.run ?? runProcess),
    );
    const command = browserCommand(session);
    const link = browserViewUrl(browser.origin, window.targetId);
    if (json)
      return Object.freeze({
        code: exitOk,
        stdout: JSON.stringify({
          kind: "browser-window",
          session,
          targetId: window.targetId,
          created: window.created,
          link,
          command,
        }),
      });
    return Object.freeze({
      code: exitOk,
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
      return Object.freeze({ code: exitFailure, stderr: copy[error.reason] });
    return Object.freeze({
      code: exitFailure,
      stderr:
        error instanceof LaunchpadStartRefused
          ? `${copy.failed}: the Folder could not be read (${error.reason})`
          : copy.failed,
    });
  }
}
