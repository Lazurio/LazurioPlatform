import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listTabs, openTab } from "../launchpad/new-tab/hub-client";
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
import { browserHandoverUrl, type TabFacts } from "./contract/platform";
import {
  type BrowserCliAnswer,
  type BrowserCliKind,
  type BrowserDoneOutcome,
  type BrowserEnvironmentTab,
  type BrowserTabSession,
  type BrowserTakenWindow,
  type BrowserThreadWindow,
  browserBounds,
  browserCliExit,
  browserCliText,
  browserViewUrl,
  navigableAddress,
  stripAppOf,
  targetIdOf,
  threadSession,
} from "./contract/pure";
import { browserEntryOf } from "./view";
import {
  BrowserWindowFailure,
  bindThreadWindow,
  cdpSeams,
  type EnvironmentSession,
  ensureThreadWindow,
  type HeldThreadWindow,
  heldThreadWindows,
  readEnvironmentSessions,
  readThreadSessions,
  sessionHoldMayRemain,
  settleSessionBinding,
  type ThreadSession,
  tabHolders,
  takeTab,
  threadOfSession,
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
  targetId, created, link, command}. A new window opens blank, is bound to
  the session, and only then goes to --url, as a navigation the browser
  starts itself; --url never moves a window the session has already. When
  the address is still loading after 10 s, or the browser refused it, the
  window is still yours and window says so on stderr. Another window of the
  same thread is another --session, say <session>-2: each session name has
  a window of its own and a new link for the user. A new window is recorded
  as the calling thread's (its harness's AGENT_BROWSER_SESSION,
  CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID as above, else the session
  itself); that record, never the name, makes it the thread's for tabs and
  done --all. No number limits a thread's windows: when window opens a new
  one while the thread holds others, it names them on stderr (session and
  address) and reminds you to let go of those you no longer need (done
  --session <session>, or done --all). It refuses nothing for it and still
  exits 0. Where another thread took the session's window (take), window
  gives the session a new one and says so on stderr.
browser tabs [--session <name>] [--all] [--folder <absolute Folder>] [--json]
  The calling thread's windows and nobody else's: the thread's own session
  and the windows window recorded for the thread when it opened them. A
  name never makes a window the thread's: team-2 may be a thread of its
  own. --session names one window of the thread, which must be the calling
  thread's where its harness names one. For each window its session, tab,
  address, title, the user's link, whether your agent-browser still holds it
  and whether someone views it. A window whose record does not confirm the
  thread is named apart as not confirmed, by its session only: one window
  opened for the thread whose window changed since, one whose binding is not
  verified yet, and any window whose record cannot be read, which may be any
  thread's. While any is named, the list is not complete: its first line
  says so, and it still exits 0, since the listing worked; running it again
  tells nothing more. A window another thread took (take) is named apart as
  taken, with the thread that took it. --all adds every tab of the
  Environment browser, each with its id, address, title, the user's link,
  the agent-browser sessions bound to it (their thread where known and
  whether their agent-browser runs), the places that hold it and how many
  people view it: an overview for working with other agents, never a
  licence to work in their tabs. Run tabs before you tell the user that your
  windows are closed: a window you let go that the user still views stays
  for them. --json prints {schema: "lazurio.browser-cli.v1", kind:
  "browser-tabs", session (the thread), windows: [{session, targetId, url,
  title, link, held, viewers, sleeping, endsAt}], ambiguous: [session],
  complete, taken: [{session, targetId, thread, by, at}]}, and with --all
  all: [{targetId, url, title, link, viewers, sleeping, endsAt, yours,
  sessions: [{session, thread, running, unverified, taken}], strips:
  [{strip, label}]}]. Check complete: windows is complete only while it is
  true.
  Exit status: 0 listed (complete or not), 10 no Environment browser, 2
  usage, 1 the view's hub did not answer, or --session names a window of
  another thread or one whose thread cannot be told.
browser take <tab id> [--session <name>] [--confirm] [--folder <absolute Folder>] [--json]
  Takes a tab of the Environment browser, another agent's or a person's,
  into the calling thread's session, on purpose. Without --confirm it only
  describes it: the tab, from whom you take it (the sessions bound to it,
  their thread, whether their agent-browser runs and so whether their agent
  may be working there now), who else keeps it and who views it, and what
  --confirm does; it changes nothing and exits 3. With --confirm the
  sessions bound to the tab are let go as done lets go of one, the calling
  thread's session is bound to the tab and pinned, and the tab is recorded
  as the thread's window. Nothing is closed: the tab stays open, the places
  that hold it and the people who view it keep it, and the earlier holders'
  bindings are left as they are. Their thread sees in its tabs and window
  that this thread took the tab; agent-browser itself does not tell their
  agent, which works in the same tab as you if it goes on in its session.
  Refused, with nothing changed, when the browser has no such tab, when
  your session is bound to another open window (take it in another
  --session, or let go of yours first), or when a holder's agent-browser did
  not shut down. --json prints {schema: "lazurio.browser-cli.v1", kind:
  "browser-take", session, targetId, url, title, link, command, taken, from:
  [{session, thread, running, unverified, taken}], strips: [{strip, label}],
  viewers}. Exit status: 0 taken (or yours already), 3 described only, 10 no
  Environment browser, 2 usage, 1 refused or failed.
browser link [--session <name> | --url <url>] [--folder <absolute Folder>] [--json]
  The link for the user: with a session, the Launchpad's hand-over to that
  session's tab; with --url, a new tab at that address that nobody holds,
  which ends 30 s after its last viewer leaves (root decision 0191 point
  29); without either, the users' view of a new tab. --json prints
  {schema: "lazurio.browser-cli.v1", kind: "browser-link", session, link},
  with targetId for --url. Neither command opens an address on the view
  host of an Environment browser (browser.….lazurio.io).
browser done [--session <name>] [--all] [--folder <absolute Folder>] [--json]
  Lets go of the calling thread's window when its work there is done (root
  decision 0191 point 28): its agent-browser daemon stops, and the tab ends
  once nothing holds it and nobody views it. A user who has it open keeps
  it. It asks the session's own agent-browser daemon on its socket to shut
  down; it never signals a process. --all lets go of every window of the
  thread at once (the windows tabs lists), each the same way; a window
  whose record does not confirm the thread (tabs' ambiguous ones) is never
  let go, only named, and done --all then fails.
  --json prints {schema: "lazurio.browser-cli.v1", kind: "browser-done",
  session, outcome}, outcome being stopped, none (no daemon listens and
  none holds the window), refused (the daemon did not shut down; nothing
  changed) or unconfirmed (no answer, the daemon has not exited within 5 s,
  or its process still runs while nothing answers on its socket: it may
  still hold the window; run done again); with --all, session is the
  thread, sessions [{session, outcome}] each one's, ambiguous [session] the
  windows left alone, and outcome the worst, unconfirmed when any was left.
  Once the daemon has ended, done also settles a binding that an earlier
  window left unverified, so window opens a window in the session again;
  done --all lets go of the thread's own sessions whose binding is not
  verified or whose tab another thread took, too.
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
  "browser window|link|done|tabs [--session <name>] [--url <url>] [--all] [--folder <absolute Folder>] [--json] | browser take <tab id> [--session <name>] [--confirm] [--folder <absolute Folder>] [--json] | browser open <http(s) address> [--folder <absolute Folder>] [--json]";

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
    /** Tests only: the hub's loopback list behind `tabs`. */
    listTabs?: typeof listTabs | undefined;
    /** Tests only: the page titles the browser reports behind `tabs`. */
    pageTitles?: (() => Promise<ReadonlyMap<string, string>>) | undefined;
    /** Tests only: whether a daemon's process runs (`processAlive`) behind
     * `tabs` and `done`. */
    alive?: ((pid: number) => boolean) | undefined;
  }>;

/** The titles the browser reports for its pages on its loopback DevTools
 * endpoint (`/json/list`), by target id: the hub reads a page's own title
 * only while someone views it, and an agent's window mostly has no viewer.
 * Empty when the browser does not answer within 3 s. */
async function browserPageTitles(): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  try {
    const response = await fetch(
      `http://127.0.0.1:${browserBounds.devtoolsPort}/json/list`,
      { signal: AbortSignal.timeout(3_000) },
    );
    const list = (await response.json()) as unknown;
    if (Array.isArray(list))
      for (const item of list) {
        const { id, type, title, url } = (item ?? {}) as Record<
          string,
          unknown
        >;
        const target = targetIdOf(id);
        if (
          type === "page" &&
          target !== null &&
          typeof title === "string" &&
          title !== url
        )
          titles.set(target, title.slice(0, browserBounds.titleLength));
      }
  } catch {}
  return titles;
}

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
      "The window is open, but agent-browser did not bind the session to it. The session is left bound to no other tab: run lazurio browser window again. A window it could not bind ends by itself while nobody views it.",
    "binding-unverified":
      "The session {session} has no window for now: an earlier lazurio browser window in it did not finish binding it, and its agent-browser has not ended yet, so the session's binding may still come to name another agent's tab. Lazurio opens nothing in the session until that agent-browser has ended. Let go of it with lazurio browser done --session {session}, which asks it to shut down and then settles the binding, and run lazurio browser window again. To work right away, use another session: lazurio browser window --session {session}-2. No tab was closed; a window it could not bind ends by itself while nobody views it. If done does not settle it, run lazurio doctor.",
    "navigate-failed":
      "The window is open, but agent-browser did not open the address in it.",
    "not-a-tab":
      "The Environment browser has no tab {targetId}. lazurio browser tabs --all lists its tabs with their ids.",
    "session-busy":
      "Your session {session} has a window of its own, which taking the tab would leave. Take the tab into another session (lazurio browser take {targetId} --session {session}-2), or let go of your window first (lazurio browser done --session {session}). Nothing was taken.",
    "holder-busy":
      "The session {session} bound to the tab did not let it go: its agent-browser refused to shut down or did not confirm that it ended. Nothing was taken. Try again in a moment; if it stays so, leave the tab to its agent.",
    "take-id":
      "take needs the tab's id, 32 hexadecimal digits, as lazurio browser tabs --all prints it.",
    "navigate-pending":
      "The window is yours, but its address has not answered within 10 s and is still loading. Check it with {command} get url.",
    "navigate-refused":
      "The window is yours, but the browser did not open the address in it. Open it with {command} open <address>.",
    "window-taken":
      "Your earlier window in this session ({targetId}) was taken by the thread {thread} (session {by}) at {at}: it is that thread's now, so leave it alone. This is a new window.",
    "done-settled":
      "Its unverified binding is settled: lazurio browser window opens a window in this session again.",
    "done-unsettled":
      "Its binding is still not verified, so lazurio browser window opens nothing in this session yet. Run lazurio browser done --session {session} again in a moment; if it stays so, run lazurio doctor.",
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
    "window-others": "This thread's other windows in the Environment browser:",
    "window-others-next":
      "Let go of those you no longer need right away: lazurio browser done --session <session> lets go of one, lazurio browser done --all of every window of the thread, this one too. lazurio browser tabs lists them.",
    "tabs-unreachable":
      "The users' view of the Environment browser did not list its tabs, so this thread's windows are unknown. Run lazurio doctor.",
    "tabs-none": "This thread has no window in the Environment browser.",
    "tabs-none-confirmed":
      "This thread has no confirmed window in the Environment browser.",
    "tabs-count-one": "This thread holds {count} window.",
    "tabs-count-few": "This thread holds {count} windows.",
    "tabs-count-other": "This thread holds {count} windows.",
    "tabs-link": "The user's link",
    "tabs-held": "your agent-browser holds it",
    "tabs-released": "let go",
    "tabs-viewed": "the user views it ({viewers}): it stays for them",
    "tabs-unviewed": "nobody views it",
    "tabs-sleeping": "asleep",
    "tabs-ends": "ends at {time} unless held or viewed again",
    "tabs-next":
      "Before you tell the user your windows are closed, run lazurio browser tabs again: a window you let go that the user views stays for them.",
    "done-all-none":
      "This thread has no running agent-browser: nothing to let go.",
    "done-all-stopped": "let go",
    "done-all-none-one": "nothing ran",
    "done-all-refused": "refused to shut down; nothing changed",
    "done-all-unconfirmed": "not confirmed; it may still hold the window",
    "done-check":
      "Check what remains with lazurio browser tabs in a few seconds: a window ends 8 s after it was let go unless the user views it.",
    "window-unrecorded":
      "This window is not recorded as this thread's, so lazurio browser tabs and done --all do not see it. Let go of it with lazurio browser done --session {session}.",
    "thread-ambiguous":
      "It cannot be told which thread {session} is a window of: its record cannot be read, or its window changed since lazurio browser window opened it. Nothing was listed or let go. If it is yours, let go of it alone with lazurio browser done --session {session}.",
    "thread-other":
      "{session} is not a window of this thread: lazurio browser window did not open it for this thread, and tabs and done --all take only this thread's windows. If it is yours, let go of it alone with lazurio browser done --session {session}.",
    "tabs-incomplete":
      'This list is not complete: lazurio browser cannot confirm whether the windows under "Not confirmed" are this thread\'s. The listing itself worked, so running it again tells nothing more. Let go of a window that is yours with lazurio browser done --session <session>, and leave the others alone.',
    "tabs-ambiguous":
      "Not confirmed as this thread's (their record or binding does not confirm it):",
    "tabs-taken":
      "Taken by another thread (lazurio browser take), so no longer this thread's; leave them alone and let go of their session with lazurio browser done --session <session>:",
    "tabs-taken-one":
      "- {session}: {url}, taken by the thread {thread} (session {by}) at {at}",
    "all-header": "Every tab of the Environment browser ({count}):",
    "all-none": "The Environment browser has no tab.",
    "all-yours": "your window",
    "all-held": "Held by",
    "all-nobody": "No agent-browser session or place holds it.",
    "all-session": "session {session}",
    "all-thread": "thread {thread}",
    "all-thread-unknown": "thread unknown",
    "all-running": "its agent-browser runs",
    "all-stopped": "its agent-browser does not run",
    "all-unverified": "binding not verified",
    "all-session-taken": "taken from it",
    "all-strip": "panel {strip} “{label}”",
    "all-viewed": "the user views it ({viewers})",
    "all-unviewed": "nobody views it",
    "all-next":
      "Leave the tabs of other threads and of people alone unless the user asks, or you work with that agent on purpose. Taking a tab is a deliberate step: lazurio browser take <id> first describes from whom you take it and what happens, and only with --confirm takes it.",
    "take-title": "Taking the tab {targetId}: {url}{title}",
    "take-from": "You take it from:",
    "take-from-none": "No other agent-browser session is bound to it.",
    "take-from-running":
      "its agent-browser runs: its agent may be working in it now",
    "take-from-stopped": "its agent-browser does not run",
    "take-keeps": "Kept by, unchanged:",
    "take-what":
      "With --confirm: the sessions above are let go as lazurio browser done lets go of one, your session {session} is bound to the tab, and the tab is recorded as this thread's window. Their bindings stay, and their thread sees in lazurio browser tabs that this thread took the tab; if their agent goes on in its session, it works in the same tab as you, and agent-browser does not tell it. Nothing is closed, and whoever has the tab open keeps it.",
    "take-ask":
      "Take it only as a deliberate decision, when the user asked for it or you work with that agent on purpose:",
    "take-done": "The tab {targetId} is now this thread's window.",
    "take-done-from":
      "Taken from: {sessions}. Their thread sees it in lazurio browser tabs; if their agent goes on in its session, it works in the same tab as you.",
    "take-already": "The tab {targetId} is your session's window already.",
    "done-all-ambiguous":
      "done --all did not let go of these windows, and this thread may still hold them: their record or binding does not confirm that they are this thread's. Let go of one that is yours with lazurio browser done --session <session>, and leave the others alone:",
    "doubt-unreadable":
      "its record cannot be read, so it may be any thread's window",
    "doubt-unverified":
      "its binding is not verified since a lazurio browser window did not finish, so it may name another agent's tab; lazurio browser done --session <session> lets go of it and settles it",
    "doubt-taken": "another thread took its tab",
    "doubt-rebound":
      "its window changed since lazurio browser window opened it",
    "doubt-recorded-elsewhere":
      "lazurio browser window opened it for another thread",
    "done-all-lingering":
      "its process still runs, but nothing answers on its socket: it may still hold the window",
    "daemon-lingering":
      "Your session's agent-browser process still runs, but nothing answers on its socket, so it may still hold your window. Run lazurio browser done again in a moment; if it stays, run lazurio doctor. Never signal the process.",
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
      "Okno je otevřené, ale agent-browser k němu sezení nepřipojil. Sezení nezůstalo připojené k žádné jiné záložce: spusť lazurio browser window znovu. Okno, které se připojit nepodařilo, samo skončí, když se na něj nikdo nedívá.",
    "binding-unverified":
      "Sezení {session} teď nemá okno: dřívější lazurio browser window v něm připojení nedokončil a jeho agent-browser ještě neskončil, takže vazba sezení může ještě začít ukazovat na záložku jiného agenta. Dokud ten agent-browser neskončí, Lazurio v sezení nic neotevře. Pusť ho příkazem lazurio browser done --session {session}, který ho požádá o ukončení a pak vazbu vyřídí, a spusť lazurio browser window znovu. Chceš-li pracovat hned, použij jiné sezení: lazurio browser window --session {session}-2. Žádná záložka se nezavřela; okno, které se připojit nepodařilo, samo skončí, když se na něj nikdo nedívá. Když to done nevyřeší, spusť lazurio doctor.",
    "navigate-failed":
      "Okno je otevřené, ale agent-browser v něm adresu neotevřel.",
    "not-a-tab":
      "Prohlížeč Prostředí nemá záložku {targetId}. Záložky i s jejich id vypíše lazurio browser tabs --all.",
    "session-busy":
      "Tvoje sezení {session} má vlastní okno a převzetím záložky by ho opustilo. Převezmi záložku do jiného sezení (lazurio browser take {targetId} --session {session}-2), nebo nejdřív pusť své okno (lazurio browser done --session {session}). Nic se nepřevzalo.",
    "holder-busy":
      "Sezení {session}, které je k záložce připojené, ji nepustilo: jeho agent-browser se odmítl ukončit nebo nepotvrdil, že skončil. Nic se nepřevzalo. Zkus to za chvíli znovu; když to vydrží, nech záložku jeho agentovi.",
    "take-id":
      "take potřebuje id záložky, 32 šestnáctkových číslic, jak ho vypíše lazurio browser tabs --all.",
    "navigate-pending":
      "Okno je tvoje, ale jeho adresa do 10 s neodpověděla a pořád se načítá. Ověř ji příkazem {command} get url.",
    "navigate-refused":
      "Okno je tvoje, ale prohlížeč v něm adresu neotevřel. Otevři ji příkazem {command} open <adresa>.",
    "window-taken":
      "Tvoje dřívější okno v tomto sezení ({targetId}) převzalo vlákno {thread} (sezení {by}) v {at}: teď patří jemu, tak ho nech být. Tohle je nové okno.",
    "done-settled":
      "Jeho neověřená vazba je vyřízená: lazurio browser window v tomto sezení zase otevře okno.",
    "done-unsettled":
      "Jeho vazba pořád není ověřená, takže lazurio browser window v tomto sezení zatím nic neotevře. Za chvíli spusť lazurio browser done --session {session} znovu; když to vydrží, spusť lazurio doctor.",
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
    "window-others": "Další okna tohoto vlákna v prohlížeči Prostředí:",
    "window-others-next":
      "Ta, která už nepotřebuješ, hned pusť: jedno pustí lazurio browser done --session <sezení>, všechna okna vlákna i s tímto lazurio browser done --all. Vypíše je lazurio browser tabs.",
    "tabs-unreachable":
      "Pohled prohlížeče Prostředí nevypsal své záložky, takže okna tohoto vlákna nejsou známá. Spusť lazurio doctor.",
    "tabs-none": "Toto vlákno nemá v prohlížeči Prostředí žádné okno.",
    "tabs-none-confirmed":
      "Toto vlákno nemá v prohlížeči Prostředí žádné potvrzené okno.",
    "tabs-count-one": "Toto vlákno drží {count} okno.",
    "tabs-count-few": "Toto vlákno drží {count} okna.",
    "tabs-count-other": "Toto vlákno drží {count} oken.",
    "tabs-link": "Odkaz pro uživatele",
    "tabs-held": "drží ho tvůj agent-browser",
    "tabs-released": "puštěné",
    "tabs-viewed": "uživatel se na něj dívá ({viewers}): zůstane mu",
    "tabs-unviewed": "nikdo se na něj nedívá",
    "tabs-sleeping": "spí",
    "tabs-ends": "skončí v {time}, pokud ho nikdo znovu nedrží ani neotevře",
    "tabs-next":
      "Než uživateli řekneš, že jsou tvoje okna zavřená, spusť znovu lazurio browser tabs: puštěné okno, na které se uživatel dívá, mu zůstane.",
    "done-all-none": "Toto vlákno nemá spuštěný agent-browser: není co pustit.",
    "done-all-stopped": "puštěné",
    "done-all-none-one": "nic neběželo",
    "done-all-refused": "odmítl se ukončit; nic se nezměnilo",
    "done-all-unconfirmed": "nepotvrdil konec; okno možná pořád drží",
    "done-check":
      "Co zůstalo, ověř za pár sekund příkazem lazurio browser tabs: okno skončí 8 s po puštění, pokud se na něj uživatel nedívá.",
    "window-unrecorded":
      "Toto okno není zapsané jako okno tohoto vlákna, takže ho lazurio browser tabs ani done --all neuvidí. Pusť ho příkazem lazurio browser done --session {session}.",
    "thread-ambiguous":
      "Nejde poznat, kterého vlákna je {session} okno: jeho záznam nejde přečíst, nebo se jeho okno od otevření příkazem lazurio browser window změnilo. Nic se nevypsalo ani nepustilo. Je-li tvoje, pusť ho samotné příkazem lazurio browser done --session {session}.",
    "thread-other":
      "{session} není okno tohoto vlákna: lazurio browser window ho pro toto vlákno neotevřel a tabs i done --all berou jen okna tohoto vlákna. Je-li tvoje, pusť ho samotné příkazem lazurio browser done --session {session}.",
    "tabs-incomplete":
      "Výpis není úplný: u oken pod „Nepotvrzená“ lazurio browser nemůže potvrdit, jestli patří tomuto vláknu. Výpis sám proběhl, takže jeho opakování nic dalšího neřekne. Okno, které je tvoje, pusť příkazem lazurio browser done --session <sezení>, ostatní nech být.",
    "tabs-ambiguous":
      "Nepotvrzená jako okna tohoto vlákna (jejich záznam nebo vazba to nepotvrzuje):",
    "tabs-taken":
      "Převzalo je jiné vlákno (lazurio browser take), takže už nepatří tomuto vláknu; nech je být a jejich sezení pusť příkazem lazurio browser done --session <sezení>:",
    "tabs-taken-one":
      "- {session}: {url}, převzalo vlákno {thread} (sezení {by}) v {at}",
    "all-header": "Všechny záložky prohlížeče Prostředí ({count}):",
    "all-none": "Prohlížeč Prostředí nemá žádnou záložku.",
    "all-yours": "tvoje okno",
    "all-held": "Drží ji",
    "all-nobody": "Nedrží ji žádné sezení agent-browseru ani místo.",
    "all-session": "sezení {session}",
    "all-thread": "vlákno {thread}",
    "all-thread-unknown": "vlákno neznámé",
    "all-running": "jeho agent-browser běží",
    "all-stopped": "jeho agent-browser neběží",
    "all-unverified": "vazba neověřená",
    "all-session-taken": "převzaté",
    "all-strip": "panel {strip} „{label}“",
    "all-viewed": "uživatel se na ni dívá ({viewers})",
    "all-unviewed": "nikdo se na ni nedívá",
    "all-next":
      "Záložky jiných vláken a lidí nech být, pokud o to uživatel nepožádá nebo s tím agentem vědomě nespolupracuješ. Převzetí záložky je vědomý krok: lazurio browser take <id> nejdřív popíše, od koho ji přebíráš a co se stane, a teprve s --confirm ji převezme.",
    "take-title": "Převzetí záložky {targetId}: {url}{title}",
    "take-from": "Přebíráš ji od:",
    "take-from-none": "Žádné jiné sezení agent-browseru k ní připojené není.",
    "take-from-running":
      "jeho agent-browser běží: jeho agent v ní možná právě pracuje",
    "take-from-stopped": "jeho agent-browser neběží",
    "take-keeps": "Dál ji drží, beze změny:",
    "take-what":
      "S --confirm: sezení výše se pustí jako po lazurio browser done, tvoje sezení {session} se k záložce připojí a záložka se zapíše jako okno tohoto vlákna. Jejich vazby zůstanou a jejich vlákno v lazurio browser tabs uvidí, že záložku převzalo toto vlákno; když jejich agent ve svém sezení pokračuje, pracuje ve stejné záložce jako ty a agent-browser mu to neřekne. Nic se nezavře a kdo má záložku otevřenou, tomu zůstane.",
    "take-ask":
      "Převezmi ji jen jako vědomé rozhodnutí, když o to uživatel požádal nebo s tím agentem vědomě spolupracuješ:",
    "take-done": "Záložka {targetId} je teď okno tohoto vlákna.",
    "take-done-from":
      "Převzato od: {sessions}. Jejich vlákno to uvidí v lazurio browser tabs; když jejich agent ve svém sezení pokračuje, pracuje ve stejné záložce jako ty.",
    "take-already": "Záložka {targetId} už je okno tvého sezení.",
    "done-all-ambiguous":
      "Tato okna done --all nepustil a toto vlákno je možná pořád drží: jejich záznam nebo vazba nepotvrzuje, že patří tomuto vláknu. To, které je tvoje, pusť příkazem lazurio browser done --session <sezení>, ostatní nech být:",
    "doubt-unreadable":
      "jeho záznam nejde přečíst, takže může patřit kterémukoli vláknu",
    "doubt-unverified":
      "jeho vazba není ověřená, protože lazurio browser window nedoběhl, takže může ukazovat na záložku jiného agenta; pustí a vyřídí ho lazurio browser done --session <sezení>",
    "doubt-taken": "jeho záložku převzalo jiné vlákno",
    "doubt-rebound":
      "jeho okno se od otevření příkazem lazurio browser window změnilo",
    "doubt-recorded-elsewhere":
      "lazurio browser window ho otevřel pro jiné vlákno",
    "done-all-lingering":
      "jeho proces pořád běží, ale na socketu nic neodpovídá: okno možná pořád drží",
    "daemon-lingering":
      "Proces agent-browseru tvého sezení pořád běží, ale na socketu nic neodpovídá, takže tvoje okno možná pořád drží. Za chvíli spusť lazurio browser done znovu; když to zůstane, spusť lazurio doctor. Proces nikdy nesignalizuj.",
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

type Action = "window" | "link" | "done" | "open" | "tabs" | "take";

const kindOf: Readonly<Record<Action, BrowserCliKind>> = {
  window: "browser-window",
  link: "browser-link",
  done: "browser-done",
  open: "browser-open",
  tabs: "browser-tabs",
  take: "browser-take",
};

/** `{name}` in a text, each replaced by its value. */
const fill = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);

/** The worst of the outcomes of `done --all`: one that may still hold a
 * window, then one that refused, then one let go, else none. */
const outcomeOrder: readonly BrowserDoneOutcome[] = [
  "unconfirmed",
  "refused",
  "stopped",
  "none",
];
const worstOutcome = (outcomes: readonly BrowserDoneOutcome[]) =>
  outcomeOrder.find((outcome) => outcomes.includes(outcome)) ?? "none";

/** One window of `tabs` as text: its session, address and title, the
 * user's link, and its state. */
function windowText(
  window: BrowserThreadWindow,
  copy: (typeof text)[keyof typeof text],
): string {
  const state = [
    window.held ? copy["tabs-held"] : copy["tabs-released"],
    window.viewers > 0
      ? fill(copy["tabs-viewed"], { viewers: String(window.viewers) })
      : copy["tabs-unviewed"],
    ...(window.sleeping ? [copy["tabs-sleeping"]] : []),
    ...(window.endsAt !== null && !window.held && window.viewers === 0
      ? [fill(copy["tabs-ends"], { time: window.endsAt })]
      : []),
  ].join("; ");
  const title = window.title === "" ? "" : ` „${window.title}“`;
  return [
    `- ${window.session}: ${window.url}${title}`,
    `  ${copy["tabs-link"]}: ${window.link}`,
    `  ${state}`,
  ].join("\n");
}

/** A session bound to a tab, as the overview and `take` name it. */
const tabSessionOf = (entry: EnvironmentSession): BrowserTabSession =>
  Object.freeze({
    session: entry.session,
    thread: entry.thread,
    running: entry.running,
    unverified: entry.unverified,
    taken: entry.taken !== null,
  });

/** Every tab of the Environment browser (`tabs --all`): the hub's facts of
 * each, the sessions whose binding names it and the places that hold it, and
 * whether it is one of the calling thread's windows. */
function overviewOf(
  tabs: readonly TabFacts[],
  sessions: readonly EnvironmentSession[],
  yours: ReadonlySet<string>,
  titleOf: (tab: TabFacts) => string,
  origin: string,
): BrowserEnvironmentTab[] {
  return tabs.map((tab) =>
    Object.freeze({
      targetId: tab.id,
      url: tab.url,
      title: titleOf(tab),
      link: browserViewUrl(origin, tab.id),
      viewers: tab.viewers,
      sleeping: tab.sleeping !== undefined,
      endsAt: tab.closing ?? tab.grace?.endsAt ?? null,
      yours: yours.has(tab.id),
      sessions: sessions
        .filter((entry) => entry.targetId === tab.id)
        .map(tabSessionOf),
      strips: tab.holders.map(({ strip, label }) =>
        Object.freeze({ strip, label }),
      ),
    }),
  );
}

/** A session bound to a tab, as text: its name, its thread where known,
 * whether its agent-browser runs, and what is in doubt. */
const sessionText = (
  entry: BrowserTabSession,
  copy: (typeof text)[keyof typeof text],
) =>
  `${fill(copy["all-session"], { session: entry.session })} (${[
    entry.thread === null
      ? copy["all-thread-unknown"]
      : fill(copy["all-thread"], { thread: entry.thread }),
    entry.running ? copy["all-running"] : copy["all-stopped"],
    ...(entry.unverified ? [copy["all-unverified"]] : []),
    ...(entry.taken ? [copy["all-session-taken"]] : []),
  ].join(", ")})`;

/** Who holds a tab, as text: its sessions and places, or nobody. */
const holdersText = (
  sessions: readonly BrowserTabSession[],
  strips: readonly Readonly<{ strip: string; label: string }>[],
  copy: (typeof text)[keyof typeof text],
) =>
  sessions.length === 0 && strips.length === 0
    ? copy["all-nobody"]
    : `${copy["all-held"]}: ${[
        ...sessions.map((entry) => sessionText(entry, copy)),
        ...strips.map((strip) => fill(copy["all-strip"], strip)),
      ].join("; ")}`;

/** The overview of every tab as text, after the thread's own windows. */
function overviewText(
  all: readonly BrowserEnvironmentTab[],
  copy: (typeof text)[keyof typeof text],
): string[] {
  if (all.length === 0) return ["", copy["all-none"]];
  return [
    "",
    fill(copy["all-header"], { count: String(all.length) }),
    ...all.map((tab) =>
      [
        `- ${tab.targetId}: ${tab.url}${tab.title === "" ? "" : ` „${tab.title}“`}${tab.yours ? ` (${copy["all-yours"]})` : ""}`,
        `  ${copy["tabs-link"]}: ${tab.link}`,
        `  ${holdersText(tab.sessions, tab.strips, copy)}`,
        `  ${
          tab.viewers > 0
            ? fill(copy["all-viewed"], { viewers: String(tab.viewers) })
            : copy["all-unviewed"]
        }${tab.sleeping ? `; ${copy["tabs-sleeping"]}` : ""}`,
      ].join("\n"),
    ),
    copy["all-next"],
  ];
}

/** A window whose record does not confirm the thread, as text: its session
 * and why, never its address or title (it may be another thread's). */
const doubtText = (
  { session, doubt }: ThreadSession,
  copy: (typeof text)[keyof typeof text],
) => `- ${session}: ${copy[`doubt-${doubt ?? "unreadable"}`]}`;

/** How many windows the thread holds, in the plural form of the language
 * (Czech: 1 okno, 2–4 okna, 5 oken). */
function countText(
  count: number,
  locale: keyof typeof text,
  copy: (typeof text)[keyof typeof text],
): string {
  const form = new Intl.PluralRules(locale).select(count);
  const key =
    form === "one" || form === "few"
      ? (`tabs-count-${form}` as const)
      : "tabs-count-other";
  return fill(copy[key], { count: String(count) });
}

/** The note `window` writes to stderr when it opened a new window while the
 * thread holds others (decided on 2026-11-14 in place of a limit): their
 * sessions and addresses, and how to let go of them. Nothing when there are
 * none, or when they cannot be read: the note never fails the window. */
async function otherWindowsNote(
  session: string,
  thread: string,
  targetId: string,
  seams: WindowSeams,
  copy: (typeof text)[keyof typeof text],
): Promise<string | undefined> {
  let others: readonly HeldThreadWindow[];
  try {
    others = (await heldThreadWindows(thread, seams)).filter(
      (other) => other.session !== session && other.targetId !== targetId,
    );
  } catch {
    return undefined;
  }
  if (others.length === 0) return undefined;
  return [
    copy["window-others"],
    ...others.map((other) =>
      other.url === ""
        ? `- ${other.session}`
        : `- ${other.session}: ${other.url}`,
    ),
    copy["window-others-next"],
  ].join("\n");
}

/** The thread `tabs` and `done --all` take (F38, addendum of 2026-11-14):
 * the calling thread's identity (`threadSession` of its harness), or, with
 * `--session`, the thread whose window that session is (`threadOfSession`).
 * A name is never taken apart. Refused when the session's thread cannot be
 * told, or when it is not the calling thread where the harness names one:
 * the command then lists and lets go of nothing. */
async function threadFor(
  named: string,
  given: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Promise<
  | Readonly<{ kind: "thread"; thread: string }>
  | Readonly<{ kind: "refused"; reason: "thread-ambiguous" | "thread-other" }>
> {
  if (!given) return { kind: "thread", thread: named };
  const caller = threadSession(undefined, env);
  const found = await threadOfSession(named, env);
  if (found.kind === "ambiguous")
    return { kind: "refused", reason: "thread-ambiguous" };
  if (caller === null || found.thread === caller) return found;
  // The caller's own session that another thread recorded: both may hold it.
  return {
    kind: "refused",
    reason: named === caller ? "thread-ambiguous" : "thread-other",
  };
}

/** What settling a session's binding needs of the context (`done`). */
const settleSeams = (context: BrowserContext) => ({
  env: context.env,
  ...(context.daemonSeams === undefined ? {} : { daemon: context.daemonSeams }),
  ...(context.alive === undefined ? {} : { alive: context.alive }),
});

/** Lets go of one session's window (`stopSessionDaemon`). Where nothing
 * answered on its socket, a missing or refused one, the window is let go
 * only once the hub no longer counts an agent working in it: while its
 * `.pid` names a running process and its binding is there it may still hold
 * the window (`lingering`), never `none` (Pablo's review of #971). */
async function letGo(
  sockets: string | undefined,
  session: string,
  context: BrowserContext,
): Promise<BrowserDoneOutcome | "lingering"> {
  if (sockets === undefined) return "none";
  const outcome = await stopSessionDaemon(
    sockets,
    session,
    context.daemonSeams,
  );
  return outcome === "none" &&
    (await sessionHoldMayRemain(context.env, session, context.alive))
    ? "lingering"
    : outcome;
}

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

/** `browser take` (F38, addendum of 2026-11-15): another agent's or a
 * person's tab into the calling thread's session, only once its agent
 * confirmed it. Without `--confirm` it describes the tab, from whom it is
 * taken, who else keeps it and what happens, and exits `confirm` (3). With
 * it, `takeTab` lets the holders go, binds the session and records the
 * window; its refusals reach the caller's mapping of `BrowserWindowFailure`. */
async function take(
  given: string,
  values: Readonly<{
    session?: string | undefined;
    confirm?: boolean | undefined;
  }>,
  browser: NonNullable<ReturnType<typeof browserEntryOf>>,
  json: boolean,
  copy: (typeof text)[keyof typeof text],
  context: BrowserContext,
): Promise<CommandOutput> {
  const targetId = targetIdOf(given);
  if (targetId === null)
    return Object.freeze({
      code: browserCliExit.usage,
      stderr: copy["take-id"],
    });
  const session = threadSession(values.session, context.env);
  if (session === null)
    return Object.freeze({
      code: browserCliExit.usage,
      stderr: copy["no-session"],
    });
  const thread = threadSession(undefined, context.env) ?? session;
  const listed = await (context.listTabs ?? listTabs)(browser, {
    heap: false,
  });
  if (listed.kind !== "tabs")
    return Object.freeze({
      code: browserCliExit.failure,
      stderr: copy["tabs-unreachable"],
    });
  const tab = listed.tabs.find((candidate) => candidate.id === targetId);
  if (tab === undefined)
    return Object.freeze({
      code: browserCliExit.failure,
      stderr: fill(copy["not-a-tab"], { targetId }),
    });
  const title =
    tab.title !== ""
      ? tab.title
      : ((await (context.pageTitles ?? browserPageTitles)()).get(tab.id) ?? "");
  const sessions = await readEnvironmentSessions(context.env, context.alive);
  const own = sessions.find((entry) => entry.session === session);
  const open = new Set(listed.tabs.map((candidate) => candidate.id));
  const link = browserViewUrl(browser.origin, targetId);
  const command = browserCommand(session);
  const strips = tab.holders.map(({ strip, label }) =>
    Object.freeze({ strip, label }),
  );
  const answer = (taken: boolean, from: readonly BrowserTabSession[]) =>
    answered({
      kind: "browser-take",
      session,
      targetId,
      url: tab.url,
      title,
      link,
      command,
      taken,
      from,
      strips,
      viewers: tab.viewers,
    });
  const already = () =>
    Object.freeze({
      code: browserCliExit.done,
      stdout: json
        ? answer(true, [])
        : [
            fill(copy["take-already"], { targetId }),
            `${copy.view}: ${link}`,
            `${copy.use}: ${command} <command>`,
          ].join("\n"),
    });
  if (own?.targetId === targetId && own.taken === null) return already();
  // Taking it would leave the session's own open window: never silently.
  if (
    own?.targetId !== undefined &&
    own.targetId !== null &&
    own.targetId !== targetId &&
    open.has(own.targetId)
  )
    return Object.freeze({
      code: browserCliExit.failure,
      stderr: fill(copy["session-busy"], { session, targetId }),
    });
  const holders = (
    await tabHolders(session, targetId, context.env, context.alive)
  ).map(tabSessionOf);
  if (values.confirm !== true) {
    const confirm = `lazurio browser take ${targetId} --confirm${
      values.session === undefined ? "" : ` --session ${session}`
    }`;
    const holderLine = (entry: BrowserTabSession) =>
      `- ${fill(copy["all-session"], { session: entry.session })} (${[
        entry.thread === null
          ? copy["all-thread-unknown"]
          : fill(copy["all-thread"], { thread: entry.thread }),
        ...(entry.unverified ? [copy["all-unverified"]] : []),
        ...(entry.taken ? [copy["all-session-taken"]] : []),
      ].join(", ")}): ${
        entry.running ? copy["take-from-running"] : copy["take-from-stopped"]
      }`;
    return Object.freeze({
      code: browserCliExit.confirm,
      stdout: json
        ? answer(false, holders)
        : [
            fill(copy["take-title"], {
              targetId,
              url: tab.url,
              title: title === "" ? "" : ` „${title}“`,
            }),
            `${copy["tabs-link"]}: ${link}`,
            ...(holders.length === 0
              ? [copy["take-from-none"]]
              : [copy["take-from"], ...holders.map(holderLine)]),
            ...(strips.length === 0
              ? []
              : [
                  copy["take-keeps"],
                  ...strips.map(
                    (strip) => `- ${fill(copy["all-strip"], strip)}`,
                  ),
                ]),
            tab.viewers > 0
              ? fill(copy["all-viewed"], { viewers: String(tab.viewers) })
              : copy["all-unviewed"],
            fill(copy["take-what"], { session }),
            copy["take-ask"],
            `  ${confirm}`,
          ].join("\n"),
    });
  }
  const result = await takeTab(
    session,
    targetId,
    context.windowSeams ?? cdpSeams(context.env, context.run ?? runProcess),
    { thread },
  );
  if (result.already) return already();
  const taken = new Set(result.from.map((entry) => entry.session));
  const from = holders.filter((entry) => taken.has(entry.session));
  return Object.freeze({
    code: browserCliExit.done,
    stdout: json
      ? answer(true, from)
      : [
          fill(copy["take-done"], { targetId }),
          ...(from.length === 0
            ? []
            : [
                fill(copy["take-done-from"], {
                  sessions: from.map((entry) => entry.session).join(", "),
                }),
              ]),
          `${copy.session}: ${session}`,
          `${copy.view}: ${link}`,
          `${copy.use}: ${command} <command>`,
        ].join("\n"),
    ...(result.recorded || session === thread
      ? {}
      : { stderr: fill(copy["window-unrecorded"], { session }) }),
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
    all?: boolean | undefined;
    confirm?: boolean | undefined;
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
        all: { type: "boolean" },
        confirm: { type: "boolean" },
      },
    });
    values = parsed.values;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    const [positional] = parsed.positionals;
    const folderOk =
      values.folder === undefined ||
      (isAbsolute(values.folder) && resolve(values.folder) === values.folder);
    if (positional === "take") {
      // `take`'s tab: the one argument after it; an id of another form is
      // a usage error the command itself names.
      if (
        parsed.positionals.length !== 2 ||
        new Set(names).size !== names.length ||
        values.url !== undefined ||
        values.all !== undefined ||
        !folderOk
      )
        return usage;
      given = parsed.positionals[1];
    } else if (positional === "open") {
      if (
        parsed.positionals.length !== 2 ||
        new Set(names).size !== names.length ||
        values.url !== undefined ||
        values.session !== undefined ||
        values.all !== undefined ||
        values.confirm !== undefined ||
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
        positional !== "done" &&
        positional !== "tabs") ||
      new Set(names).size !== names.length ||
      values.confirm !== undefined ||
      (values.all !== undefined &&
        positional !== "done" &&
        positional !== "tabs") ||
      (positional === "tabs" && values.url !== undefined) ||
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
    if (action === "take")
      return await take(given as string, values, browser, json, copy, context);
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
    if (action === "tabs") {
      const resolved = await threadFor(
        named as string,
        values.session !== undefined,
        context.env,
      );
      if (resolved.kind === "refused")
        return Object.freeze({
          code: browserCliExit.failure,
          stderr: fill(copy[resolved.reason], { session: named as string }),
        });
      const thread = resolved.thread;
      const sessions = await readThreadSessions(
        thread,
        context.env,
        context.alive,
      );
      const listed = await (context.listTabs ?? listTabs)(browser, {
        heap: false,
      });
      if (listed.kind !== "tabs")
        return Object.freeze({
          code: browserCliExit.failure,
          stderr: copy["tabs-unreachable"],
        });
      const facts = new Map(listed.tabs.map((tab) => [tab.id, tab]));
      const titles = listed.tabs.some((tab) => tab.title === "")
        ? await (context.pageTitles ?? browserPageTitles)()
        : new Map<string, string>();
      const titleOf = (tab: { id: string; title: string }) =>
        tab.title === "" ? (titles.get(tab.id) ?? "") : tab.title;
      const windows = sessions.flatMap(
        ({ session, targetId, confirmed }): BrowserThreadWindow[] => {
          const tab = targetId === null ? undefined : facts.get(targetId);
          if (tab === undefined || !confirmed) return [];
          return [
            Object.freeze({
              session,
              targetId: tab.id,
              url: tab.url,
              title: titleOf(tab),
              link: browserViewUrl(browser.origin, tab.id),
              held: tab.agents.includes(session),
              viewers: tab.viewers,
              sleeping: tab.sleeping !== undefined,
              endsAt: tab.closing ?? tab.grace?.endsAt ?? null,
            }),
          ];
        },
      );
      // Taken on purpose by another thread (`take`): known, so named apart
      // and never in doubt, while the tab is open.
      const taken = sessions.flatMap(({ taken: note }): BrowserTakenWindow[] =>
        note !== null && facts.has(note.targetId) ? [note] : [],
      );
      // Not confirmed, and a window or a daemon that may hold one: named
      // apart by its session only, never as the thread's, and the list is
      // not complete while any is (a record that cannot be read names no
      // thread, so its window may be this one's).
      const doubtful = sessions.filter(
        (entry) =>
          !entry.confirmed &&
          entry.doubt !== "taken" &&
          (entry.socket ||
            entry.running ||
            (entry.targetId !== null && facts.has(entry.targetId))),
      );
      const ambiguous = doubtful.map((entry) => entry.session);
      const complete = ambiguous.length === 0;
      // `--all`: every tab of the Environment browser, an overview for
      // working with other agents (F38, addendum of 2026-11-15).
      const all =
        values.all === true
          ? overviewOf(
              listed.tabs,
              await readEnvironmentSessions(context.env, context.alive),
              new Set(windows.map((window) => window.targetId)),
              titleOf,
              browser.origin,
            )
          : undefined;
      return Object.freeze({
        code: browserCliExit.done,
        stdout: json
          ? answered({
              kind: "browser-tabs",
              session: thread,
              windows,
              ambiguous,
              complete,
              taken,
              ...(all === undefined ? {} : { all }),
            })
          : [
              ...(complete ? [] : [copy["tabs-incomplete"]]),
              ...(windows.length > 0
                ? [
                    countText(
                      windows.filter((entry) => entry.held).length,
                      locale,
                      copy,
                    ),
                    ...windows.map((window) => windowText(window, copy)),
                  ]
                : doubtful.length === 0
                  ? [copy["tabs-none"]]
                  : [copy["tabs-none-confirmed"]]),
              ...(doubtful.length === 0
                ? []
                : [
                    copy["tabs-ambiguous"],
                    ...doubtful.map((entry) => doubtText(entry, copy)),
                  ]),
              ...(taken.length === 0
                ? []
                : [
                    copy["tabs-taken"],
                    ...taken.map((note) =>
                      fill(copy["tabs-taken-one"], {
                        ...note,
                        url: facts.get(note.targetId)?.url ?? note.targetId,
                      }),
                    ),
                  ]),
              ...(windows.length === 0 && doubtful.length === 0
                ? []
                : [copy["tabs-next"]]),
              ...(all === undefined ? [] : overviewText(all, copy)),
            ].join("\n"),
      });
    }
    if (action === "done" && values.all === true) {
      const resolved = await threadFor(
        named as string,
        values.session !== undefined,
        context.env,
      );
      if (resolved.kind === "refused")
        return Object.freeze({
          code: browserCliExit.failure,
          stderr: fill(copy[resolved.reason], { session: named as string }),
        });
      const thread = resolved.thread;
      const sockets = agentBrowserSocketDirectory(context.env);
      // Only a session whose daemon may run is asked: one with a socket or
      // a running process. A binding alone holds nothing.
      const threadSessions =
        sockets === undefined
          ? []
          : await readThreadSessions(thread, context.env, context.alive);
      const running = threadSessions.filter(
        (entry) => entry.socket || entry.running,
      );
      // The thread's own sessions whose tab alone is in doubt (a binding not
      // verified, a tab another thread took) are the thread's to let go of:
      // letting go of them only ends this thread's hold.
      const letGoOf = (entry: ThreadSession) =>
        entry.confirmed ||
        (entry.owned &&
          (entry.doubt === "unverified" || entry.doubt === "taken"));
      // Any other window whose record does not confirm the thread is never
      // let go: it may be another thread's. It is named, and the thread may
      // still hold it, so done --all fails.
      const doubtful = running.filter((entry) => !letGoOf(entry));
      const ambiguous = doubtful.map((entry) => entry.session);
      const results = await Promise.all(
        running.filter(letGoOf).map(async ({ session }) => ({
          session,
          result: await letGo(sockets, session, context),
        })),
      );
      // A binding left unverified is settled once its daemon has ended,
      // also for a session whose daemon had ended already.
      const unsettled: string[] = [];
      for (const entry of threadSessions.filter(
        (candidate) => candidate.owned && candidate.doubt === "unverified",
      ))
        if (
          (await settleSessionBinding(entry.session, settleSeams(context))) ===
          "pending"
        )
          unsettled.push(entry.session);
      const outcomes = results.map(({ session, result }) => ({
        session,
        outcome: result === "lingering" ? ("unconfirmed" as const) : result,
      }));
      const outcome = worstOutcome([
        ...outcomes.map((entry) => entry.outcome),
        ...(ambiguous.length === 0 ? [] : (["unconfirmed"] as const)),
      ]);
      const words: Readonly<Record<BrowserDoneOutcome | "lingering", string>> =
        {
          stopped: copy["done-all-stopped"],
          none: copy["done-all-none-one"],
          refused: copy["done-all-refused"],
          unconfirmed: copy["done-all-unconfirmed"],
          lingering: copy["done-all-lingering"],
        };
      const lines = [
        ...results.map((entry) => `- ${entry.session}: ${words[entry.result]}`),
        ...unsettled.map((session) =>
          fill(copy["done-unsettled"], { session }),
        ),
        ...(doubtful.length === 0
          ? []
          : [
              copy["done-all-ambiguous"],
              ...doubtful.map((entry) => doubtText(entry, copy)),
            ]),
      ];
      const failed = outcome === "refused" || outcome === "unconfirmed";
      return Object.freeze({
        code: failed ? browserCliExit.failure : browserCliExit.done,
        ...(json
          ? {
              stdout: answered({
                kind: "browser-done",
                session: thread,
                outcome,
                sessions: outcomes,
                ambiguous,
              }),
            }
          : lines.length === 0
            ? { stdout: copy["done-all-none"] }
            : failed
              ? { stderr: [...lines, copy["done-check"]].join("\n") }
              : { stdout: [...lines, copy["done-check"]].join("\n") }),
      });
    }
    if (action === "done") {
      const session = named as string;
      const result = await letGo(
        agentBrowserSocketDirectory(context.env),
        session,
        context,
      );
      const outcome = result === "lingering" ? "unconfirmed" : result;
      const ended = outcome === "stopped" || outcome === "none";
      // Once its daemon has ended, a binding an earlier window left
      // unverified is settled here, so the agent need not wait for it.
      const settled = ended
        ? await settleSessionBinding(session, settleSeams(context))
        : "none";
      const settledText = settled === "settled" ? [copy["done-settled"]] : [];
      const unsettled =
        settled === "pending"
          ? { stderr: fill(copy["done-unsettled"], { session }) }
          : {};
      return Object.freeze({
        code: ended ? browserCliExit.done : browserCliExit.failure,
        ...(json
          ? {
              stdout: answered({ kind: "browser-done", session, outcome }),
              ...unsettled,
            }
          : outcome === "stopped"
            ? {
                stdout: [copy.stopped, ...settledText, copy["done-check"]].join(
                  "\n",
                ),
                ...unsettled,
              }
            : outcome === "none"
              ? {
                  stdout: [copy["no-daemon"], ...settledText].join("\n"),
                  ...unsettled,
                }
              : {
                  stderr:
                    copy[
                      result === "lingering"
                        ? "daemon-lingering"
                        : outcome === "refused"
                          ? "daemon-refused"
                          : "daemon-unconfirmed"
                    ],
                }),
      });
    }
    const session = named as string;
    const seams =
      context.windowSeams ?? cdpSeams(context.env, context.run ?? runProcess);
    // The thread whose window this is: its harness's identity, else the
    // session named (F38, addendum of 2026-11-14). A new window is recorded
    // as that thread's, never one the session has already.
    const thread = threadSession(undefined, context.env) ?? session;
    const window = await ensureThreadWindow(session, address, seams, {
      thread,
    });
    const command = browserCommand(session);
    const link = browserViewUrl(browser.origin, window.targetId);
    // A new window while the thread holds others: they are named on stderr,
    // which a caller of --json does not read (T3 Code reads stdout).
    const notes = window.created
      ? [
          ...(window.takenBy === undefined
            ? []
            : [fill(copy["window-taken"], window.takenBy)]),
          ...(window.navigation === "pending"
            ? [fill(copy["navigate-pending"], { command })]
            : window.navigation === "failed"
              ? [fill(copy["navigate-refused"], { command })]
              : []),
          ...(window.recorded === false && session !== thread
            ? [fill(copy["window-unrecorded"], { session })]
            : []),
          ...[
            await otherWindowsNote(
              session,
              thread,
              window.targetId,
              seams,
              copy,
            ),
          ].filter((note): note is string => note !== undefined),
        ]
      : [];
    const noted = notes.length === 0 ? {} : { stderr: notes.join("\n") };
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
        ...noted,
      });
    return Object.freeze({
      code: browserCliExit.done,
      stdout: [
        window.created ? copy.created : copy.reused,
        `${copy.session}: ${session}`,
        `${copy.view}: ${link}`,
        `${copy.use}: ${command} <command>`,
      ].join("\n"),
      ...noted,
    });
  } catch (error) {
    const copy = text[locale];
    if (error instanceof BrowserWindowFailure)
      return Object.freeze({
        code: browserCliExit.failure,
        stderr: fill(copy[error.reason], {
          session:
            error.session ?? threadSession(values.session, context.env) ?? "",
          targetId: targetIdOf(given) ?? "",
        }),
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
