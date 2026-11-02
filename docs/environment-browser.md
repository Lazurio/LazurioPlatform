# The Environment browser

Status: in force on every Remote Environment whose handover routes the gateway's
`browser.` origin (`entry.browser`). Decisions 0191 and 0195 of the
[decision register](decision-register.md) set the rules;
[F38](decisions.md#f38--the-environment-browser-of-a-remote-environment-one-chromium-a-window-per-thread-a-view-behind-the-gateway),
[F39](decisions.md#f39--the-peoples-view-of-the-environment-browser-one-tab-of-a-person-is-one-remote-tab),
[F47](decisions.md#f47--nová-karta-one-shell-element-for-every-apps-right-panel-the-places-that-hold-a-remote-tab-and-the-environments-overview),
[F50](decisions.md#f50--the-environment-browsers-contract-one-module-executable-vectors-and-an-attested-artifact-for-the-forks)
and [F57](decisions.md#f57--sleeping-tabs-a-tab-nobody-uses-closes-its-window-and-keeps-its-place-under-its-id)
implement them. Where this text and a decision disagree, the decision wins. This
document holds the table of contracts that F50 point 7 asks for (F50's addendum of
2026-11-01) and the rules for updating the forks that meet in the browser.

A rule marked with a source file is enforced by that file; a rule without one is
held by review and by the release process.

## What it is

- **One browser per Environment.** A Remote Environment runs one Chromium with one
  persistent profile on its virtual screen `:1`, as three user units the Platform
  writes: `lazurio-display`, `lazurio-browser` and `lazurio-browser-view`
  (`src/browser/units.ts`; [product update](update.md#state-on-disk)). The browser
  has a memory budget of its own and opens none of its old tabs after a restart.
- **Its sign-ins are the Environment's.** Every thread, agent, bot and Buddy of the
  Environment shares them, and nothing divides them inside it (decisions 0172 and
  0191). Whoever needs other sign-ins gets another Environment. Personal matters and
  their sign-ins belong only in the Personal Environment; on a Team Environment the
  whole Team sees them.
- **Agents drive it, people see it.** Agents work in windows of their own with the
  `agent-browser` CLI over DevTools on loopback port 9222. People see a tab through
  the view behind the Environment's gateway, `https://browser.<base>.lazurio.io/t/<id>`,
  where one tab of theirs is one remote tab (F39). Agent and person click and type in
  the same tab at once; the view never locks one of them out (F39 point 5).
- **Where people see it.** In the right panel of web T3 Code and of the Launchpad, in
  ChatGPT Desktop (formerly Codex Desktop) through a link, and in any browser tab or on
  a phone signed in to the Environment. Lazurio MausBot's right panel is decided, not
  yet deployed (0191). The T3 Code desktop app shows the browser of the computer it
  runs on; a link to a tab shows the Environment browser there.
- **The default browser of a Remote Environment.** `BROWSER` and `xdg-open` run
  `lazurio browser open <address>`, so a CLI's sign-in page opens in the Environment
  browser and its return to `localhost` completes inside the Environment (0201;
  Machines registers the command, F38's addendum of 2026-10-15). Lazurio on a person's
  own computer has no Environment browser: the computer's browser stays its default.
- **No Lazurio sign-in inside.** The rule is that the Environment browser never holds
  a Lazurio session (the account, the Dashboard, other Environments), because anyone
  who views it could use that session (0191). Two things hold it. A Chrome policy that
  Machines manages blocks the pages that carry a person's account, and the view offers
  to open such a page in the person's own browser (C18). The view removes such cookies
  each time it reaches the browser, at its start, an upgrade or a restarted browser
  (`src/browser/people/cookies.ts`), so a session that got in anyway lasts until the
  next sweep. The Environment's own apps and Modules open in it without a sign-in,
  through the gateway's loopback entry, which Machines runs (F39's addendum of
  2026-10-18).
- **Test personas run elsewhere.** A check as a test persona runs in a separate
  browser with its own temporary profile, never in the Environment browser (decisions
  0178 and 0223).
- **A Work Environment is never handed to another person.** After an export period it
  is removed (0191), so its profile and sign-ins never pass to someone else.
- **The screen's other programs** are worked through Computer Use, one agent at a time
  ([F59](decisions.md#f59--computer-use-on-a-remote-environment-the-cua-drivers-daemon-on-the-screen-one-mcp-server-computer-for-every-agent)).
  A web desktop on which people watch the screen is a later wave (0191).

## How an agent uses it

Agents read these rules in the Folder: the section on the Environment browser in
`manual/this-machine.md` and one line of AGENTS.md, rendered by `src/folder/manual.ts`
(`environmentBrowser`) and `src/folder/render.ts` only where the recorded entry has
the view. That text is the agents' instruction; this list is what it follows.

1. **Its window.** `lazurio browser window [--url <address>]` opens the calling
   thread's window, or returns the one its session is bound to, and prints the
   session, the link to its tab and the command to work in it. The window is a new
   window of the browser's default context (CDP `Target.createTarget` with
   `newWindow`), so it has the Environment's sign-ins; the session is bound to it and
   pinned (`src/browser/window.ts`). `--url` applies to a new window only. The session
   is `--session`, else `AGENT_BROWSER_SESSION` (T3 Code sets it per thread), else
   `codex-<CODEX_THREAD_ID>`, else `claude-<CLAUDE_CODE_SESSION_ID>` (`threadSession`,
   C2).
2. **Work.** `agent-browser --cdp 9222 --session <session> <command>`, with both
   flags in every call. Without `--cdp` agent-browser starts a browser of its own,
   without the sign-ins and invisible to people. Agents do not use `window new` (an
   isolated context without the sign-ins), `--profile`, `--headed`, `set device` or
   `set viewport`: the person's view sets the window's size (F39 point 3).
3. **The link.** The agent sends the link to its own tab,
   `https://browser.<base>.lazurio.io/t/<id>`, never the bare origin, which opens a new
   blank tab.
4. **Sign-in, 2FA and CAPTCHA.** The agent stops, sends the link to its tab and asks
   the person to take over in the view. Taking over is the person finishing the step
   in the same tab while the agent types nothing into those fields and waits for their
   answer; the view has no lock and no take-over control (F39 point 5). The agent never
   fills in passwords or codes and never asks for them in chat. The sign-in then holds
   for the whole Environment, and nobody signs out or clears the browser's data
   afterwards. Until the Environment's Bitwarden holds its passkeys, the Lazurio
   extension declines every passkey request, so sites offer another way
   (`src/browser/people/extension.ts`).
5. **A new page for the person.** A new page goes into a new tab, so the tab the person
   has open keeps their half-written form. In T3 Code `preview_open` with
   `reuseExistingTab: false` opens one. Elsewhere `lazurio browser link --url <address>`
   opens a tab nobody holds, which ends 30 s after its last viewer leaves (0191). A
   second window of the agent's own is `lazurio browser window --session <session>-2`.
6. **Done.** `lazurio browser done` lets go of the window: it asks the session's own
   agent-browser daemon on its socket to shut down and never signals a process
   (`stopSessionDaemon`, C7). The tab then ends once nothing holds it and nobody views
   it. Agents never use `agent-browser … tab close` or `close`, which close the tab for
   everyone, and never stop or restart the browser or its units.
7. **A lost window.** When agent-browser answers `tab_gone`, the window is gone (a
   renderer ended under the memory budget, or the browser restarted):
   `lazurio browser window` opens a new one, and the agent sends its new link.
8. **Another Environment's browser.** Work for an Organization runs in the browser of
   that Organization's Environment. From the Personal Environment the agent runs
   `lazurio browser window --session <session> --url <address>` there over SSH and
   sends the link to that Environment's view, which is never loaded inside this
   Environment's browser (0191).
9. **Diagnosis.** `lazurio doctor`, fact `environment-browser` (`src/browser/units.ts`):
   the three units, DevTools and the view on loopback, holder files that cannot be
   read (`browser-holder-unreadable`), and the GitHub login of the browser's kept
   github.com sign-in. It warns and never fails, and it starts and restarts nothing.

## The parts and who owns them

| Part | Owner | What it does |
| --- | --- | --- |
| The screen and the browser: `lazurio-display.service`, `lazurio-browser.service` | The Platform writes the units (`src/browser/units.ts`); Machines delivers the packages, the gateway's routes and the managed Chrome policy | One Chromium with its memory budget, `--deny-permission-prompts` and the Lazurio extension; no old tabs after a restart |
| The view and its hub: `lazurio-browser-view.service` (`lazurio browser serve`) | Platform, `src/browser/people/` | The view of one tab behind the gateway. The hub watches every tab, alone decides when a tab ends or sleeps, and keeps one blank window of its own, because Chrome ends with its last window |
| Holder files, `$XDG_RUNTIME_DIR/lazurio-browser/holders/<strip>.json` | The format is the Platform's (C5); each file belongs to the server of the app whose strip it is | Which tabs a strip holds |
| The list of live tabs, `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json` | The hub (C6) | A fresh snapshot of the browser's tabs on the boot clock, by which every app reconciles its holds |
| The hub's loopback requests, `/.lazurio/tabs…` | The hub (C11); only the Launchpad and `lazurio browser` call them | List, open, close for everyone, Vrátit, Uspat, Probudit; never through the gateway, never from a page |
| Přehled and the Launchpad's actions, `/api/new-tab/…` | Platform, `src/launchpad/new-tab-routes.ts` | Memory, tabs and running Modules; open, hold, release, close for everyone, Vrátit |
| Nová karta: the page `/new-tab` and the element `<lazurio-new-tab>` | Platform shell (C10) | One New Tab for every app's "+", and a standalone page for ChatGPT Desktop |
| `lazurio browser` | Platform CLI, `src/browser/cli.ts` (C13) | `window`, `link`, `open` and `done` for agents and CLIs |
| `agent-browser` | Fork [`Lazurio/agent-browser`](https://github.com/Lazurio/agent-browser) (C7) | The agents' tool: sessions, a session's binding to its tab, the pinned tab, the idle timeout |
| The agents' text | Platform, `src/folder/manual.ts` | The Folder's `manual/this-machine.md` section and the AGENTS.md line |

## How a tab lives and ends

The hub (`src/browser/people/hub.ts`) alone ends a tab, from the holder files, the
agent-browser bindings and its viewers (F47 points 4 to 6, decision 0195):

- **Held.** A tab is held while a holder file lists it or an agent works in it. An
  agent works in it while an agent-browser session is bound to it (`<session>.target`)
  and that session's daemon runs (`<session>.pid` names a live process); the binding
  alone does not count (`readHolds`, C5 and C7). The daemon ends after an hour without
  a command: the Platform writes `"idleTimeout": "1h"` into `~/.agent-browser/config.json`
  unless the person set one, because agent-browser's own default skips a browser it
  attached to over DevTools (`src/browser/agent-browser-config.ts`).
- **After the last hold.** When the last hold goes and nobody views the tab, it ends
  8 s later.
- **Nothing holds it.** A tab nothing holds ends 30 s after its last viewer leaves; one
  that nobody has viewed or held ends after 10 minutes. A held tab never ends for lack
  of viewers.
- **× in a strip** releases the tab for that place only and offers Vrátit for 7 s. The
  tab stays while something else holds it or someone views it, and Přehled lists it
  while it exists (0195).
- **Close for everyone** is in Přehled only: the tab ends after 8 s, held or not, and
  Přehled warns first when an agent works in it (F47 points 6 and 8).
- **Sleep.** A tab nobody views and no agent works in falls asleep after 20 minutes, or
  earlier under memory pressure: the hub closes its window and keeps its id, address
  and place in every strip; viewing it or Probudit loads the address again
  (`src/browser/people/sleep.ts`; decision 0195; F57, still a proposal under review,
  whose steps 1 and 2 are implemented). A tab an agent works with never sleeps, and a
  tab a T3 Code thread holds counts as an agent's (F57 point 3).
- **A holder file that cannot be read** stops the end of only the tabs it held at the
  hub's last reading; the other files count as they read now, and doctor names the
  file. A file the hub has not read since the view started holds nothing. A holder
  directory that cannot be listed stops every end (0191; `readHolds` and
  `holdsReader` in `src/browser/contract/node.ts`).
- **After a restart of the browser** its unit removes the profile's sessions before it
  starts (`src/browser/units.ts`), so no old tab reopens, and every app drops the ids
  the next list of live tabs lacks (C6).

## The host application's contract

Every app that shows the Environment browser (the Launchpad, T3 Code and, once
deployed, Lazurio MausBot) keeps these five rules and needs nothing more:

1. **Nová karta is a shell element.** The "+" of its right panel inserts
   `<lazurio-new-tab>` from the Environment's `/.lazurio/shell.js` with `strip`,
   `tools` (its own tools, each mapped to an id of the registry, C10), and optionally
   `focus-address` and `lang`, and takes the event `lazurio-new-tab`: a page, a chosen
   tab or a tool. It navigates nowhere itself and needs no knowledge of the protocol
   inside the element.
2. **A tab is a frame of the view.** It shows a tab as a frame of
   `https://browser.<base>.lazurio.io/t/<id>` with the contract's frame attributes
   (C15), takes the view's messages `lazurio-browser:info`, `lazurio-browser:new-tab`
   and `lazurio-browser:closed` (C8), and answers the view's identity request through
   the shell (C9).
3. **It holds what it shows.** Its server writes the strip's holder file (C5) and
   reconciles it with `tabs.json` by `keptTabs` (C6) when it starts, on every change of
   the list (watched, and read again every 30 s) and before each write. It writes and
   removes only the holder files of its own prefix (C2).
4. **It lets go of what ended.** × removes the tab from its strip and releases it.
   Archiving or deleting a thread (or a bot) releases all its tabs and lets go of its
   agent's session through the session daemon's socket, as `lazurio browser done`
   does, so that no daemon keeps its window; a tab another strip holds stays. The hub
   does the rest.
5. **Only the Platform's interfaces.** Shell elements, the Environment's `/.lazurio/…`
   documents and the holder files. The hub's loopback requests belong to the Launchpad
   and `lazurio browser`. No page of an app calls the browser's DevTools. An app never
   opens another Environment's view inside this Environment's browser; it may frame it
   in its own panel, marked as that Environment's (0191).

## The apps one by one

### The Launchpad

- **Its strip** is `launchpad` (`holders/launchpad.json`, written by
  `src/launchpad/new-tab/holder.ts` through `changeHolderFile`): the tabs a person opened
  in it from Nová karta, by address or from Přehled, and the new tabs of pages shown in
  it (0195).
- **"+"** opens Nová karta without tools and with the address bar ready to type; an
  empty strip shows Nová karta.
- **×** releases the tab; closing for everyone is in Přehled.
- **Přehled** reads the Environment's memory, its tabs and its running Modules only
  while Nová karta is shown. A tab's memory is an estimate from its JavaScript heap,
  marked "≈" (F47 point 7).

### T3 Code ([`Lazurio/t3code`](https://github.com/Lazurio/t3code))

- **The strip is a thread.** The right panel shows one thread's browser tabs and T3
  Code's tools. T3 Code's server holds them, so the strip is the same on every device,
  and writes the thread's holder file `t3-<thread>.json`; the thread's agent session
  is `t3-<thread>`.
- **"+" is Nová karta** instead of upstream's menu, with T3 Code's own tools mapped to
  the registry's ids (C10). A page or a chosen tab becomes the thread's tab, a tool T3
  Code's own surface. × takes a tab off that thread only, with Vrátit, and the strip
  says when another thread or the Launchpad holds it too (F47 point 10).
- **The preview tools** (`preview_*`) drive the Environment browser: each of their
  tabs is a window of it. On a Lazurio Environment the fork's server neither builds nor
  advertises upstream's own server browser (the fork's runbook,
  `docs/operations/lazurio-fork-release.md`).
- **The fork's side** of this contract (its strip sync, its seams in upstream files
  and the contract test that guards them) is in its overlay specification,
  `docs/operations/lazurio-overlay.md`. Until phase 2 of F50 point 8, T3 Code reads and
  writes C1 to C8, C10, C13 and C14 with copies of its own rather than the vendored
  module.

### Lazurio MausBot ([`Lazurio/OpenMausBot`](https://github.com/Lazurio/OpenMausBot)): decided, not yet deployed

Decision 0191 moves MausBot's bots into the Environment browser. The target:

- a bot works in the Environment browser through agent-browser on port 9222 with the
  session `bot-<id>`; the prefix `bot-` is reserved for MausBot (C2);
- the bot's strip is `bot-<id>.json`, written by MausBot's server; deleting or
  archiving a bot releases its tabs and lets go of its session, as for a T3 Code
  thread;
- MausBot's right panel shows the view and Nová karta as T3 Code does, on the vendored
  module (F50 point 8, last step);
- MausBot sets no `AGENT_BROWSER_CONFIG`, socket directory or namespace of its own, so
  the Platform's idle timeout reaches its daemons (F50 point 2);
- programs on the Environment's screen are worked through Computer Use (F59), one
  agent at a time.

The fork's `main` carries this target: its `LAZURIO.md` describes the bot's session,
strip and browser panel, and the fork vendors the module from v0.1.9 into
`lazurio/browser-contract/` with its `provenance.json` and runs the release's vectors
against it (`scripts/lazurio-browser-contract.node-test.mjs`). It reaches an
Environment only with Machines' pin. The rules MausBot's changes follow are in that
`LAZURIO.md`.

### ChatGPT Desktop (formerly Codex Desktop)

ChatGPT Desktop cannot be changed, so:

- its agents work in the Environment browser over SSH with agent-browser and send the
  link to their tab, which the person opens in ChatGPT Desktop's built-in browser;
- Nová karta is the Launchpad's page `https://launchpad.<base>.lazurio.io/new-tab`
  opened on its own, with the Launchpad's strip and no tools (F47's addendum of
  2026-10-24); a page opened from it belongs to no strip (`pageStrip`,
  `src/launchpad/new-tab-view.ts`);
- pages opened from there, and pages an agent outside T3 Code opens for the person
  (`lazurio browser link --url`, `lazurio browser open`), are held by nobody: they live
  while someone views them and end 30 s after the last viewer leaves (0191);
  ChatGPT Desktop has no strip and no × to release them;
- an agent's window is held only by its agent's work and by viewers, because Lazurio
  does not see ChatGPT Desktop's threads. The agent lets go of it with
  `lazurio browser done`, or its daemon ends after an hour without a command.

### agent-browser ([`Lazurio/agent-browser`](https://github.com/Lazurio/agent-browser))

The contract rests on these parts of agent-browser (C7):

- attaching to the shared browser with `--cdp 9222`;
- a session per thread, and its binding to its tab (`<session>.target`), which
  outlives a restart of the daemon;
- `<session>.pid`, which the daemon writes at start and removes when it ends;
- the pinned tab;
- the daemon's idle timeout from its user configuration (`idleTimeout` in
  `~/.agent-browser/config.json`). The Platform writes `"1h"` only where none is set
  and never overwrites the person's choice. A configuration it cannot read, that is no
  JSON object or no regular file (a symbolic link, say) it leaves as it is, and the
  daemons may then never idle out (`src/browser/agent-browser-config.ts`). An attached
  daemon that idles out or shuts down only disconnects; it closes no tab.

Lazurio's agents and bots run with the Environment's `XDG_RUNTIME_DIR` and set neither
`AGENT_BROWSER_SOCKET_DIR`, `AGENT_BROWSER_NAMESPACE` nor `AGENT_BROWSER_CONFIG`; the
module resolves the socket directory as agent-browser does
(`agentBrowserSocketDirectory`). Letting go of a window uses agent-browser's internal
shutdown action on the session's socket, which is no part of the contract: a
documented command of the fork is to replace it (F50 point 2), and only the outcomes of
`stopSessionDaemon` are the contract's. People do not use agent-browser's dashboard;
the fork carries fixes and distribution, and its runbook
`docs/operations/lazurio-fork-release.md` describes its releases.

## The contracts C1 to C18

The programs that meet in the Environment browser agree through these contracts
(F50). The one definition of each is the Platform's module `src/browser/contract/`,
and its executable vectors in `src/browser/contract/vectors/v1/` are their truth
(F50 point 4): `tests/browser-contract-vectors.test.ts` runs every case against the
module, fails when an export has no case or a case names no export, and pins the
module's exported names. C11 and C12 are internal to the Platform: their shapes are in
`src/browser/contract/platform.ts`, which the forks do not get, and they have no
vectors. C18 was added by F50's addendum of 2026-10-18.

The table was checked against the Platform's `main` at `a2927744`. In it, `pure.ts`,
`node.ts` and `platform.ts` are files of `src/browser/contract/`, `people/` is
`src/browser/people/`, a Launchpad file is in `src/launchpad/`, a test is in `tests/`,
and a vector file is in `src/browser/contract/vectors/v1/`. "Other programs" names the
forks only where they touch a contract today.

| # | Contract | Holder | Enforced in | Tested in | Other programs |
| --- | --- | --- | --- | --- | --- |
| C1 | **Remote tab id:** a DevTools target id, 32 hexadecimal digits, written in upper case and read in either case | Chrome; the rule: Platform | `isTargetId`, `targetIdOf` (`pure.ts`), which every Platform reader of an id takes (F50's second addendum of 2026-10-14), among them the view's routes (`people/service.ts`), `hubRequestOf` (`platform.ts`), the Launchpad (`new-tab/holder.ts`, `new-tab/hub-client.ts`, `new-tab-routes.ts`, `new-tab-view.ts`, `browser-panel-view.ts`), `src/browser/window.ts` | `remote-tab-ids.json` | T3 Code, server and web: own copy |
| C2 | **Strip and session names:** `[A-Za-z0-9_-]{1,64}`, Lazurio's subset of agent-browser's names; the strips `launchpad` and `t3-<thread>`; the prefixes `t3-`, `codex-`, `claude-` and `bot-` (reserved for MausBot); a harness's name made into a session by `threadSession` | Platform (grammar and prefixes); each app its own names | `isStrip`, `launchpadStrip`, `stripPrefixes`, `stripAppOf`, `threadSession` (`pure.ts`); the hub counts no binding outside the grammar (`readHolds`, `node.ts`); `src/browser/cli.ts`, `src/browser/window.ts`; the Launchpad writes only `launchpad` (`new-tab/holder.ts`); Přehled names apps by prefix (`new-tab-routes.ts`, `new-tab-view.ts`) | `strips.json`; `environment-browser.test.ts` | T3 Code names `t3-…`; MausBot's `main` names `bot-<id>` |
| C3 | **A view's address and its Environment:** `https://browser.<base>.lazurio.io/t/<id>` in the strict form (no port, credentials, query, fragment, or slash after the id), the bare origin for a new tab; `<base>` is the Environment id `environmentIdOf` gives (one label for a Personal Environment, `<machine>.<org>` for an Organization's); no Lazurio surface loads an address on a view host inside the Environment browser | Platform | `environmentIdOf`, `isEnvironmentId`, `viewPath`, `browserViewUrl`, `viewPathTab`, `viewAddressOf`, `isViewHost` (`pure.ts`; `src/shell/contract.ts` re-exports the id); the view (`people/service.ts`, `people/client.ts`, `people/bar.ts`), `src/browser/view.ts`, the Launchpad (`browser-panel-view.ts`, `new-tab-view.ts`, `server.ts`), `src/browser/cli.ts` | `view-addresses.json`; `shell-environment-id.test.ts`; `new-tab-view.test.ts` | T3 Code, server and web: own copies |
| C4 | **Boot clock:** `{"boot": "<boot_id>", "at": <seconds>}` from `/proc/sys/kernel/random/boot_id` and the first number of `/proc/uptime`, never the wall clock | Platform | `parseBootTime` (`pure.ts`), `readBootClock` (`node.ts`); the hub (`people/serve.ts`), the Launchpad (`new-tab-routes.ts`, `new-tab/holder.ts`) | `boot-clock.json`; `environment-browser-holds.test.ts` | T3 Code server: own copy |
| C5 | **Holder file** `$XDG_RUNTIME_DIR/lazurio-browser/holders/<strip>.json` = `{"schema": "lazurio.browser-holder.v1", "contract", "strip", "label", "tabs", "recordedAt"}`: mode 0600 in a 0700 directory, replaced atomically by its own app; the hub reads at most 64 Ki characters, 500 tabs and a 200-character label; a file without `schema` is v1; only its writer reads `recordedAt`; a strip that holds nothing has no file | The format: Platform; each file: its app | The text: `holderSchema`, `parseHolder`, `holderFileText`, `parseHolderRecords` (`pure.ts`). The write: `changeHolderFile`, `replaceOwnerFile` (`node.ts`), used by the Launchpad (`new-tab/holder.ts`). The reading: `readHolds`, `holdsReader`, `watchHolds` in the hub (`people/serve.ts`), `unreadableHolderFiles` in doctor (`src/browser/units.ts`) | `holder-files.json`; `environment-browser-holds.test.ts`; `environment-browser.test.ts` (doctor) | T3 Code writes `t3-<thread>.json` and reads the other files with its own copy; MausBot's `main` writes `bot-<id>.json` with the vendored module |
| C6 | **List of live tabs and the reconciliation:** `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json` = `{"schema": "lazurio.browser-tabs.v1", "tabs", "takenAt"}`, a fresh snapshot after each discovery, on each change and every 30 s; an app drops a stored id only by `keptTabs`: it ignores a list of another boot, keeps an id the list has, and drops one the list lacks only when `takenAt` is later than the id's record time | The hub | `liveTabsSchema`, `liveTabsText`, `parseLiveTabs`, `keptTabs` (`pure.ts`); `liveTabsPath`, `writeLiveTabs`, `readLiveTabs` (`node.ts`); written by the hub (`people/serve.ts`), read by the Launchpad through `changeHolderFile` | `live-tabs.json`; `environment-browser-holds.test.ts`; `launchpad-new-tab.test.ts` | T3 Code server: own copy |
| C7 | **agent-browser's session files and idle timeout:** `<socket dir>/<session>.target` (its `targetId`, kept past the daemon), `<session>.pid` (while the daemon runs), `<session>.sock`; the socket directory as agent-browser resolves it; `idleTimeout` in `~/.agent-browser/config.json`; letting go of a window through the session's socket, with the outcome `stopped`, `none`, `refused` or `unconfirmed` | The files: the fork `Lazurio/agent-browser`; the idle timeout written, the reading and letting go: Platform | `agentBrowserSocketDirectory`, `processAlive`, `readHolds`, `askDaemonSocket`, `stopSessionDaemon` (`node.ts`); `browserTimes.agentBrowserIdleTimeout`, written by `src/browser/agent-browser-config.ts`; the hub (`people/serve.ts`), `lazurio browser window` and `done` (`src/browser/window.ts`, `src/browser/cli.ts`) | `agent-browser.json`; `agent-browser-config.test.ts`; `environment-browser.test.ts` | The agent-browser fork's CI does not run these cases yet (F50 point 4); T3 Code reads bindings with its own copy |
| C8 | **The view's messages to its app:** `postMessage` of `{type: "lazurio-browser:info", v: 1, view, url, title}`, `{type: "lazurio-browser:new-tab", v: 1, view, url}` and `{type: "lazurio-browser:closed", v: 1, view}`; a message without `v` is v1; an app takes a message only from its frame's window on the view's origin, about a tab named by its strict view address, and cuts texts at 500 and 2048 characters | The view (Platform) | The writers `viewInfoMessage`, `viewNewTabMessage`, `viewClosedMessage` and `messageMajor` (`pure.ts`) in the view page (`people/client.ts`); the reader `acceptViewMessage` (`pure.ts`) in the Launchpad's panel (`browser-panel.ts`) | `messages.json`; `browser-panel-view.test.ts` | T3 Code web: own reader |
| C9 | **Identity and `<lazurio-environment>`:** the view asks `{type: "lazurio-browser:identity-request", v: 1}` at 0, 1 and 4 s; the app's shell answers `{type: "lazurio-browser:identity", v: 1, identity}` to exactly the frame's origin, with `majors` only where the app names them (none does yet); the element's attributes `environment`, `lang` and `space` (shell interface v1) | Platform shell | `identityRequestMessage`, `identityReplyMessage`, `identityRequestOf`, `acceptIdentityReply`, `viewEnvironmentId`, `parseMessageMajors` (`pure.ts`); the shell's responder (`src/shell/identity-protocol.ts`), the view (`people/client.ts`); the element in `src/shell/interface.ts` | `messages.json`; `shell-identity.test.ts`; `environment-browser-view-identity.test.ts`; `shell-interface.test.ts` | The forks load the responder and the element at runtime from the Environment's `/.lazurio/shell.js` |
| C10 | **Nová karta's interface:** `<lazurio-new-tab strip tools focus-address lang>`; `tools` is JSON `[{id, label, key?, icon?}]`, at most 12, an id matching `^[a-z0-9][a-z0-9-]{0,31}$`; the event `lazurio-new-tab` with `{kind: "page" \| "tab", tab, view}` or `{kind: "tool", id}`; the registry of tool ids `terminal`, `files`, `diff`, `pull-request`, `linked-pull-requests`, `agents` and `device`, each with its icon | Platform shell (interface v1) | `newTabEventName`, `maxNewTabTools`, `parseNewTabTools`, `newTabViewOf`, `parseNewTabChoice`, `newTabToolIcons`, `newTabToolIcon` (`pure.ts`); `src/shell/new-tab-protocol.ts`, `src/shell/new-tab-element.ts`, the page (`new-tab-page.ts`), the Launchpad's panel (`browser-panel.ts`, `browser-panel-view.ts`) | `new-tab.json`; `shell-new-tab.test.ts`; `shell-interface.test.ts` | T3 Code web inserts the element and maps its tools with its own copy |
| C11 | **The hub's loopback requests:** `GET /.lazurio/tabs[?heap=1]`; `POST /.lazurio/tabs {url, strip?}` → 201 `{id, view}`, or 200 with `reused: true` for a tab of the same strip at that address; `POST /.lazurio/tabs/<id>/close`, `restore`, `sleep` or `wake`; only with a loopback `Host`, refused with any `Origin` or `Sec-Fetch-Site` | The hub (Platform only) | The shapes in `platform.ts` (`hubTabsPath`, `hubTabPath`, `hubRequestOf`, `parseHubTab`); served by `classifyRequest` (`people/service.ts`); called by the Launchpad (`new-tab/hub-client.ts`) and by `lazurio browser link --url` and `open` | `launchpad-new-tab.test.ts`; `environment-browser-view.test.ts`; `environment-browser-sleep.test.ts`; no vectors | No fork calls it, and none gets it |
| C12 | **The Launchpad's view routes:** `GET /.lazurio/browser.json[?session=]` → `{available: true, view, session}` or `{available: false, reason}` (`not-declared`, `view-unavailable`); `GET /.lazurio/browser[?session=]` → a redirect to the view | The Launchpad (Platform only) | The shapes in `platform.ts`; served by `src/launchpad/server.ts` with `src/browser/view.ts`; read by Nová karta's page (`new-tab-page.ts`); `lazurio browser link` prints the hand-over (`browserHandoverUrl`, `src/browser/cli.ts`) | `environment-browser.test.ts`; `browser-panel-view.test.ts`; no vectors | `?session=` stays for T3 Code 0.0.45-lazurio.7 until lazurio.8 runs everywhere (`platform.ts`) |
| C13 | **`lazurio browser … --json`:** `{"schema": "lazurio.browser-cli.v1", kind, …}`, one kind per command: `browser-window` `{session, targetId, created, link, command}`, `browser-link` `{session, link[, targetId]}`, `browser-done` `{session, outcome}`, `browser-open` `{session, targetId, link}`; without a browser `{kind, available: false}` and exit 10; exits 0 done, 1 failure, 2 usage, 10 no browser; the first line of stderr is the reason in the user's language | Platform CLI | `browserCliSchema`, `browserCliText`, `parseBrowserCliAnswer`, `browserCliExit` (`pure.ts`); `src/browser/cli.ts` | `cli.json`; `environment-browser.test.ts` | T3 Code's server calls `window` and `link` with its own decoder |
| C14 | **Times and bounds:** the hub ends a tab 8 s after its last hold, 30 s after its last viewer, and after 10 minutes when never viewed or held; Vrátit lasts 7 s, 1 s less than the hub's grace; holds are read and reconciled at least every 30 s, changes joined in 100 ms, snapshots in 50 ms; the hub reconnects after 2 s and waits 2 s for a new tab; Přehled reads every 5 s; Nová karta is standalone after 1.5 s; another Environment's view names its tab within 4 s of loading or 15 s of starting; the identity is asked at 0, 1 and 4 s; agent-browser's idle timeout `1h`; DevTools port 9222; a thread's window has a 1280×800 page in a 1280×900 window | The hub (Platform) | `browserTimes`, `browserBounds` (`pure.ts`); the hub (`people/hub.ts`), the Launchpad (`new-tab/holder.ts`, `new-tab-view.ts`, `browser-panel.ts`), `src/browser/units.ts`, `src/browser/window.ts`, `src/browser/agent-browser-config.ts` | `times.json`, which pins both objects whole | T3 Code types its own values until phase 2 |
| C15 | **Framing:** the frame `allow="clipboard-read; clipboard-write; fullscreen"`, `referrerpolicy="origin"` and the sandbox `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals`, never on the app's own origin; the view's `frame-ancestors 'self' https://*.<base>.lazurio.io` and the T3 Code or Launchpad of another Environment that the request's `Referer` names; Nová karta's page `frame-ancestors 'self'` and the Environment's own apps | The view (Platform); the Launchpad for Nová karta | `viewFrameAttributes`, `appShellOrigin`, `viewFrameAncestors`, `newTabFrameAncestors` (`pure.ts`); the view's headers (`people/service.ts`), the Launchpad's frame (`browser-panel.ts`), Nová karta's page (`new-tab-routes.ts`) | `framing.json`; `environment-browser-view.test.ts`; `browser-panel-view.test.ts` | T3 Code web frames with attributes of its own |
| C16 | **Address-bar input:** one rule for the view's bar and Nová karta, read as Chrome's address bar: text with the scheme http or https as typed, and `about:blank`; another scheme refused; `localhost`, an IP address, or a one-label name with a port or a path over http; a name with a dot and a top-level domain over https; anything else a search, but a text without a space that names a view host is refused, never searched; this Environment's view address opens as its tab, its bare origin as a new tab, another Environment's view as that Environment's; the hub, `window --url`, `link --url` and `open` navigate only to http(s) off a view host, or to `about:blank` | Platform | `addressBarTarget`, `searchAddress`, `navigableAddress` (`pure.ts`); the view's bar (`people/client.ts`), Nová karta (`new-tab-page.ts`), the hub (`people/hub.ts`, `people/service.ts`, `people/sleep.ts`), the Launchpad (`new-tab-routes.ts`), `src/browser/cli.ts` | `address-bar.json`; `environment-browser-view-client.test.ts`; `new-tab-view.test.ts`; `environment-browser-view.test.ts` | — |
| C17 | **Language:** Czech or English; the shell's language everywhere, the browser's language only for a view opened on its own (0191); a framed view speaks the browser's language until the identity answer carries the shell's (phase 3) | Platform shell | `surfaceLanguages`, `surfaceLanguageOf`, `browserLanguage` (`pure.ts`); the view (`people/client.ts`), Nová karta (`new-tab-page.ts`, `src/shell/new-tab-protocol.ts`) | `language.json`; `environment-browser-view-client.test.ts` | T3 Code's overlay speaks the browser's language |
| C18 | **Hand-off to the person's own browser:** a navigation the Environment browser's policy blocks fails with `net::ERR_BLOCKED_BY_ADMINISTRATOR`; the view then offers that page's http or https address, without credentials, to open in the person's own browser, and never opens it inside | The view (Platform); the policy: Machines | `blockedNavigationError`, `handOffAddress` (`pure.ts`); the hub (`people/hub.ts`) and the view's bar (`people/bar.ts`) | `hand-off.json`; `environment-browser-view.test.ts` | A fork's view that hands a page off takes the same rule |

### Versions

- **A version on what crosses a boundary.** A document carries `schema` and a message
  `v`; one without is v1, for good (F50 point 3). The readers in `pure.ts`
  (`parseHolder`, `parseLiveTabs`, `parseBrowserCliAnswer` and the message readers)
  take an absent version as v1 and treat another major as unreadable: a holder file
  then holds what it held at its last reading, `tabs.json` counts as no list, so
  nothing is dropped, and a message counts as none. Readers ignore members they do not
  know.
- **Within v1 the contract only grows.** A release may add members, values, messages
  and cases and accept what it refused before. It never removes, renames or narrows
  anything, never changes what a case expects, and never shortens a time or a bound
  another program relies on. Review holds this; a v1 vector file only gains cases, so
  a changed expectation shows as a changed line.
- **Capabilities, not version numbers.** A consumer uses a feature only when its
  signal is there (the element is defined; the member is in the file, the message or
  the answer) and otherwise keeps its earlier behaviour (F50 point 7).
- **The producer first.** A consumer release that needs a new part of the Platform is
  published only after the Platform release that brings it runs on every Environment
  that declares the browser (F50 point 7). When the behaviour of tabs changes, the
  Platform and the app change together, the Platform's release first.
- **A major change** is decided as an addendum to F50 and announced in the forks'
  runbooks first; the Platform release that brings v2 reads v1 and v2, apps write v2
  only once that Platform runs everywhere, and v1 goes only after doctor shows no v1
  writer. No v2 exists.
- **The writer's release.** Every holder file the module writes names its writer's
  Platform release (`contract`); the hub ignores it. Doctor's warnings for a holder
  file whose `contract` is newer than the installed Platform
  (`browser-platform-older-than-app`) and for a session outside the grammar
  (`browser-session-outside-grammar`) are decided (F50 point 7) and not built; of the
  three, doctor has only the warning for a holder file it cannot read or of another
  major (`browser-holder-unreadable`, `src/browser/units.ts`).

### The Platform releases a consumer can rely on

Read from the release tags of this repository.

| Release | What it brought |
| --- | --- |
| v0.1.8-rc.38 | C8 `lazurio-browser:info` and `lazurio-browser:new-tab` |
| v0.1.8-rc.51 | The hub's holder files and `tabs.json` (C5, C6), C8 `lazurio-browser:closed`, the idle timeout `1h` (C7) |
| v0.1.8-rc.55 | C9 identity |
| v0.1.8-rc.57 | A holder file that cannot be read stops only its own tabs; doctor's `browser-holder-unreadable` |
| v0.1.8-rc.58 | C13 `done` and `link --url` |
| v0.1.8-rc.61 | The module `src/browser/contract/` with C1 to C7; `schema` and `contract` in holder files, `schema` in `tabs.json` |
| v0.1.8-rc.68 | The rest of phase 1: C8 to C10 and C13 to C17 in the module, `v: 1` on messages, `lazurio.browser-cli.v1`, the shared holder-file write; the shell artifact carries the module (`browserContract`) |
| v0.1.9 | C13 `browser-open` |
| v0.1.10 | C18 |
| v0.1.11 | C11 `sleep`, `wake` and `reused` (F57) |

### The module for the forks

- **The artifact.** Every release from v0.1.8-rc.68 on attaches `lazurio-shell.tar.gz`
  with the module under `browser-contract/`: `pure.js` and `node.js` as ES modules of
  their own, transpiled and not bundled, with their declarations, the vectors and their
  README, and the module's MIT `LICENSE`. `artifact.json` lists them under
  `browserContract` (major 1) and each file with its SHA-256 in `files`; the release's
  one attestation covers the archive (`scripts/release-shell.ts`;
  [product update](update.md), "The shell artifact"). `platform.ts` is not shipped.
  Tested by `tests/shell-artifact.test.ts` and `tests/browser-contract-artifact.test.ts`,
  which builds the archive as the release does, unpacks only the listed files against
  their digests and runs every vector against them.
- **How a fork takes it.** A fork vendors one exact tag: it downloads the tag's archive
  and attestation bundle, verifies the attestation against `release.yml` at that tag
  and the repository's and owner's immutable ids, unpacks only the listed regular files,
  checks `artifact.json` and every digest, keeps `LICENSE` and `NOTICE` beside the
  files and writes `provenance.json`. Its CI checks the vendored bytes against
  `provenance.json` on every run and runs the vectors. A bump is a reviewed pull
  request made by that script; nothing is edited by hand (F50 point 5 and its addendum
  of 2026-10-14, which gives the script).
- **The licence.** The module, its built files and its vectors are MIT, so the MIT and
  Apache-2.0 forks vendor them without becoming mixed-licence
  ([licensing](licensing.md#the-environment-browsers-contract-mit)).
- **What runs in the person's browser** keeps coming at runtime from the Environment's
  own `/.lazurio/shell.js` (shell interface v1); the vendored module serves the forks'
  servers and what their pages still parse themselves.

## Updating the forks

Three forks meet in the Environment browser:

| Fork | Moves by | Its release procedure |
| --- | --- | --- |
| [`Lazurio/t3code`](https://github.com/Lazurio/t3code), Lazurio T3 Code (decision 0200) | Each person's Update through the fork's update channel, above the minimum that Machines pins | `docs/operations/lazurio-fork-release.md` in the fork |
| [`Lazurio/OpenMausBot`](https://github.com/Lazurio/OpenMausBot), Lazurio MausBot | Machines' pin | `LAZURIO.md` in the fork |
| [`Lazurio/agent-browser`](https://github.com/Lazurio/agent-browser) | Machines' pin | `docs/operations/lazurio-fork-release.md` in the fork |

The Platform itself moves by rollout and by `lazurio update`. The contract moves into a
fork only by vendoring an exact Platform tag (above). Every fork release, and every
refresh of a fork on a new upstream stable release, keeps these rules:

1. **Upstream first.** Before a refresh, the fork lists what upstream changed in its
   browser, right panel, preview tools and handling of threads or bots, and where that
   meets this contract.
2. **The contract wins.** A browser or browser integration that upstream brings into
   the web app is switched off on a Lazurio Environment, and its entry points lead to
   the Environment's view and Nová karta.
3. **The overlay stays bounded.** Lazurio's code lives in the fork's own overlay
   files. Seams in upstream files stay small, covered by the fork's contract test and
   listed in its CI's allowlist. Every browser capability of the overlay has its row in
   the runbook's overlay table: the commit, why Lazurio needs it, and when it stays or
   goes. A refresh carries each overlay commit over by intent, and the overlay shrinks
   by whatever upstream does by itself.
4. **The vectors pass.** A fork that vendors the module runs every pure and Node case
   against its copy in each toolchain that imports it, plus the cases about its own code
   (F50 point 4). The agent-browser fork runs the session-file and shutdown cases
   against its own binary before each release, so that Machines never pins an
   agent-browser that breaks the hub. MausBot's `main` vendors the module and runs its
   vectors; T3 Code still carries its own copies (phase 2 of F50 point 8), and the
   agent-browser fork has no such CI yet.
5. **The check on an Environment.** After an update, a check in a browser (decision
   0178) shows that: a strip keeps its tabs and archiving releases them; Nová karta
   opens, and opens a page and a tab from Přehled; a page's new tab appears in the
   strip; `preview_*` drive the Environment browser; another Environment's view never
   loads inside this Environment's browser.
6. **Versions together.** A fork release that relies on a new part of the Platform
   requires it and comes after it (the producer first, above). A release goes first to
   the Environments of the reference Organization, and the next wave starts only after
   browser acceptance there (decision 0204).

## Not yet deployed

- **T3 Code on the vendored module** (phase 2 of F50 point 8): it drops its copies and
  maps its tools to registry ids.
- **The shell element for a browser tab and one language** (phase 3): the Launchpad
  and Nová karta show another Environment's tab, and the identity answer carries the
  shell's `lang`.
- **Desktop T3 Code on a Remote Environment** (phase 4): its right panel shows the
  thread's tabs from the Environment browser instead of the computer's browser.
- **The strips' shared scenarios and doctor's two remaining warnings** (phases 5 and
  6), and the agent-browser fork's CI on its session files.
- **A documented command of the agent-browser fork** that lets one session's daemon go,
  offered upstream (F50 point 2).
- **Lazurio MausBot on the Environment browser** (0191; F50 point 8, last step): built
  in the fork's `main`, not yet deployed.
- **The web desktop** for people (0191, a later wave), and a visible marking of
  another Environment's tab, which is a direction for interface proposals only.

## Provenance

This document takes the architecture and the contract table from the Lazurio Root's
`manual/environment-browser.md` (GEN3, [HumanAndMachines/Lazurio](https://github.com/HumanAndMachines/Lazurio),
commit `66e437f7`). Since 2026-11-01 this document and the decisions it names are the
authority, and the Root's manual stays only the GEN3 record. Each row of the table was
checked again against this repository at `a2927744`, and the release table against its
release tags; C18 and the later additions to C11 and C13 are new here. The dated notes
of the canary rollout and the survey of upstream T3 Code of 2026-10-11 were not carried
over, because the fork's runbook holds the upstream state.
