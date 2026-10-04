# Development profile panel

`bun run src/cli.ts launchpad --folder <canonical initialized fixture>` starts a
loopback-only server on an allocated port. Open the private session URL printed in
the terminal. Do not share it: its random, process-local token authorizes operations
on the one bound fixture. Stop the process with Ctrl-C. There is no persistent token,
remote listener, account service, Folder picker or implicit daily-Folder discovery.

The UI reads current preferences, previews a selected profile and explicitly applies
the previewed selection. Changing any choice invalidates the previous preview.
Reload profile refreshes the revision after a competing change. The API binds the
Folder at startup and refuses request-supplied paths. API requests require exact
loopback Host/Origin, a session bearer token and JSON; responses are not cached.
The fragment token is removed from the address bar and retained only in page memory;
a full page reload requires reopening the original terminal link.

CLI and HTTP adapters call `inspectProfileChange` and `updateProfile`, using the same
state, expected revision, ownership checks, operation lock and recovery behavior.
The browser does not write files independently. Errors retain local evidence and
may require the explicit CLI recovery operations. User output is rendered as text,
not HTML. The core currently blocks nonempty custom instruction composition.

The persisted profile locale selects Czech or English labels, option text, status
messages, document title and document language. Preview does not activate a language
change; the UI changes language only after the new state is loaded. Stable enum
values, JSON diagnostic keys, Folder paths and user content are not translated.
Before state is available the loading/error shell defaults to English.

On 2026-09-13, real in-app browser interaction against a new temporary macOS fixture
loaded revision 1, selected Czech instructions, previewed without writing, applied
the selection and displayed revision 2 with apply disabled again. HTTP tests compare
preview to the CLI's shared use case and verify update, stale revision, drift,
unexpected Folder input and missing-token/cross-origin/Host denial. These tests use
synthetic files only. No daily Environment was activated or migrated.

The same panel was then served by the native compiled CLI with embedded assets.
It loaded revision 2; a separate CLI update created revision 3, and the browser's
Reload profile action displayed that revision. This confirms the shared state owner
for that concrete local journey, not all concurrency or restart scenarios. The full
host check passed 104 tests / 808 assertions; independent development review found
no unresolved findings in this scope.

The localized compiled panel was also exercised in the browser: English revision 3
remained English through a Czech preview, confirmation produced Czech revision 4;
changing another choice disabled the pending apply action, and a new preview plus
confirmation returned to English at revision 5. This is a manual native macOS
browser observation, not an automated multi-browser or three-OS localization gate.

This is an initial functional profile panel, not the completed Launchpad consumer.
Visual/accessibility qualification, repeatable
browser automation, remote-human access, restart/session behavior and installed
native three-OS acceptance remain open. Module discovery/start/status/stop must still
use the reviewed manifest and existing lifecycle owner; this panel implements none
of them. The original bounded proof is unchanged and is not relabelled as a full UI.

## Target shell

**Decided by Matěj on 2026-10-03 (the Lazurio shell decisions); second iteration decided
on 2026-10-04 and first built by PR #154 (F36's Organization-rail addendum), which names
what the build still lacks.** This section records the
target that the Launchpad, the Dashboard and the two forks converge on. The second
iteration was proposed and decided by Anička, the owner of the design system and of the
shell's UX, after reviewing the shell wireframe (HumanAndMachine-ai/prototypes-lazurio#4),
and Matěj confirmed it as a whole on 2026-10-04. It replaces the first target's rail of
Environments in Organization folders, its gear in the rail and its accent fill (root
decision 0179 points 2 and 3 in part), and the Apps column's module list and search; the
root records it as decision 0185 (HumanAndMachines/Lazurio#487). A
first cut of the first target is built ([decision F36](#the-shell-as-built-decision-f36));
the record of the second iteration is
[F36's addendum of 2026-10-04](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer).
The sections below describe what is built today; where they differ, a note points here.
Nothing in this section is executable evidence.

**Layout.** There is no top bar. Level 1 is a rail of spaces on the far left (the
personal space and one per Organization), and the app's left column runs full height
next to it. At the top of the left column sits the column head: the Environment picker
with the Settings gear beside it, and under them the app switch **Chat · Apps ·
Automate**. Chat is T3 Code (`t3code.…`), Apps is this Launchpad (`launchpad.…`) and
Automate is MausBot (`mausbot.…`). Each is its own origin of the Environment, so the
switch, the picker's entries and the rail are plain links that load a full page. The
Dashboard is not in the switch; the Lazurio logo at the top of the rail opens it.

**Rail.** The rail switches spaces, not Environments. From the top: the Lazurio logo
(the Dashboard), the search button that opens the jump dialog (**⌘⇧E**, Ctrl+Shift+E on
Windows and Linux; not ⌘K, which T3 Code uses for its own command palette), the personal
space (its Owner's initials), one GitHub avatar per Organization, and "+" to add an
Organization. At the bottom there is only the account, shown as the person's GitHub
photo. There are no Environment icons, no Organization folders and no "+N"/"méně": a
kind icon looks the same in every Organization and a wrong click is easy, while an
Organization's avatar is recognised at a glance. The avatar is the GitHub
Organization's, cached by the Dashboard on each GitHub sync and changed only on GitHub.
The active space has an ink ring around its avatar: no pill on the edge and no fill in
the Organization's colour. The tooltip shows the space's name, the number of its
Environments and the last one used. Clicking an Organization returns to the Environment
last used in it, in the same app (Chat stays Chat); without a remembered one it opens the
Organization's first Environment, and with no Environment at all the Organization's
Dashboard. The personal space opens the personal Remote Environment, or the last
personal Environment used. Dedicated servers are never Environments and appear neither
in the rail nor in the picker; they belong to the Organization Settings (Owner only).

**Column head: the Environment picker.** Above Chat · Apps · Automate the picker names
the Environment: its name, below it whom it serves, and the Organization's avatar as its
glyph. Its dropdown lists the Environments of the current space by name. The
Organization stands above its Environments as a head row that opens the Organization's
Dashboard; the Dashboard is never one more row beside the Environments. "This computer",
a workstation that carries several Organizations, appears in every Organization it
carries and opens for that Organization, so the Organization is part of the address of
every app (in the wireframe `#/e/<env>/<app>/o-<org>`). "Všechny Organizace" (all
Organizations) widens the list; search, ↑↓ and Enter work in it. The dropdown overlays
the column only while it is open, so a fork's sidebar keeps its content. ⌘⇧E stays the
global jump dialog. On an Organization's Dashboard the picker names the Organization,
and the column has no second Organization block under it.

**Environment names say what the Environment is for.** A Team Environment is
"Team <name>", a work Environment "Pracovní", an Automated Environment the persona's
name, a local one the computer's name and the personal Remote Environment "Osobní". No
name carries "VM" (root decision 0170). The default name comes from the Team, the
assignment or the persona in the Dashboard; whether a Team with several Environments may
rename them is open. The picker's second line says whom the Environment serves (sdílený
Teamem / jen tvůj / @kolega / automatizace / předplatná Organizace), and its state only
when it is not running ("offline"). The Machine's technical name (`vm-01`) appears only
in Environment Settings → Tento Environment ("Technický název (pro podporu)"), in
Diagnostics, in Servers and in the address. The address bar keeps it (root decision
0146); changing that would be a separate infrastructure decision.

**Selection is the quiet surface** (the design system's variant A,
HumanAndMachine-ai/design-system-lazurio#54). A selected row, menu item or navigation
item and the picker take a surface one step darker (`gray-100`) and semibold type, and
in a list a check with a word ("tady jsi", you are here). The picker has no frame until
it is hovered or open. Nothing is selected by an edge on the left: in the design system
that is `lz-edge`, "something to resolve". The Organization's colour stays in its avatar
and never marks the active element; there are no drop shadows and no all-caps labels.
This replaces the first target's active Environment filled with the Organization's
accent and ringed, and closes the question of an Organization accent token without a
new token.

**Settings and the gear.** The gear is a square button beside the picker, not in the
rail: at the bottom of the rail, under the Organizations, it read as global Settings. It
opens the Settings of exactly what the picker names. In an Environment (Apps, Chat,
Automate or a module app) that is the Environment's Settings under this Launchpad
(`/settings/<section>`); on an Organization's Dashboard it is the Organization Settings.
Account Settings stay in the account menu ("Nastavení účtu", account settings).
Settings in every scope share one kit in T3 Code's shape (the patterns
[below](#settings-structure-routes-and-the-t3-code-pattern)) and the Lazurio
design-system look: its tokens, type and colour, not T3 Code's. The Environment's
sections are Obecné / Tento Environment / Nástroje / Obnova (General / This Environment
/ Tools / Recovery); the Czech name is "Tento Environment", never "Toto" or "Tenhle".
Whether Diagnostika and Přístup belong under Tento Environment is open (plan DEV-6628).

**Apps home.** The home shows the Organization's name on top (a picker on a computer
with several Organizations) and two sections (Matěj's final position, evening of
2026-10-03, [F32's final addendum](decisions.md#f32--teams-are-not-a-presentation-axis-of-the-launchpad-an-environment-is-one-workspace)):
**Workspace**, every module of this Environment, root-level applications such as
Mission Control and the design system included, in the catalog's order, and later only
those its GitHub identity can access (no Team link, no request-access tiles); and
**Productionspace**, the Organization's productionspace repositories, read-only. The
Organization's `infra` is neither and is not listed. An earlier version of this target
had a third section, Organizace, for the Organization's own applications and `infra`;
it was dropped because where a module's repository sits in the Organization is not
something the Operator acts on. Nothing is grouped or labelled by Team: the point is
that an Environment does not show Teams. A module tile
opens the module's app in a new tab on its own origin; selecting the module in the left
column opens its overview: open the app, its lifecycle, branches and worktrees, its
log.

**Apps in the second iteration (2026-10-04).** The two sections stay as above
(Workspace and Productionspace; Productionspace holds repositories, counted as
"repozitáře", not modules, and counts use the Czech plural: 1 modul, 3 moduly, 6
modulů). The rest of the Apps paragraph above is refined as follows; where they differ,
this paragraph wins: a module is no longer selected in the left column, and its
information page is reached only from its tile's menu.

- **Landing.** After sign-in, and when Lazurio is opened without an address, the person
  lands in Apps of the Environment they had open last, in its Organization; the first
  time, in the first Environment of the first Organization. The Lazurio logo still
  opens the Dashboard. The Dashboard account remembers the last Environment, because
  every Environment has its own address.
- **Header.** The Organization's name, and under it the Environment's name with its
  kind icon. It never says "sdílený Teamem"; it says "offline" only when the
  Environment is not running. The Guide is only the link at the top right; there is no
  Guide tile. On a computer with several Organizations the Organization comes from the
  address, chosen in the rail or the column head's picker, so the home needs no
  Organization picker of its own.
- **Column.** Under the column head the Apps column holds only Všechny moduly (all
  modules), Soubory (Files, decision F35), Oblíbené (the favourites, pinned) and, at
  its bottom, the Marketplace. There is no module list (its rows led to technical
  details and confused people) and no search.
- **Marketplace.** The entry is in the Apps column of every Environment. For now it
  says "již brzy" (coming soon) and opens a placeholder page; it is not the
  [future marketplace](marketplace.md).
- **Favourites.** Set from a module's "⋯" menu ("Přidat do oblíbených" / "Odebrat z
  oblíbených"). They are pinned in the column, where a favourite opens its app
  directly. On the home a starred module comes first in its section, in the column's
  order, with a small filled star by its name. Favourites belong to the person and the
  Organization (the Dashboard account), so they follow the person to every Environment
  of that Organization; an Environment shows only those its GitHub identity can reach.
- **A clean tile.** Icon, name, short description, the favourite star and "⋯", which
  sits top right, always visible but quiet. No state line (Běží / Skončila sama / Nelze
  spustit), no running dot, no new-tab arrow, no explanatory tail ("otevře složku
  Modulu", "vlastní release, jen pro čtení") and no Productionspace subtitle. A work
  branch on a tile stays.
- **A tile's click.** A module with an app opens it where the person's account setting
  says (Matěj, 2026-10-04): a new tab by default, or the same window. It is one setting
  for the whole account, in every Environment, for tiles and favourites alike; the
  Dashboard account stores it, and "the same window" navigates to the app's address,
  never embedding it. A tile
  without an app opens nothing, not even the folder, and shows a short message: "Modul
  <název> zatím nemá aplikaci.", "Repozitář <název> nemá aplikaci.", or for an app that
  cannot start "Aplikace modulu <název> teď nejde spustit."
- **The tile's "⋯" menu.** "Přidat do oblíbených" / "Odebrat z oblíbených";
  "Informace o modulu" ("Informace o repozitáři" in Productionspace), the only entry to
  the module's information page (the application's lifecycle, its folder, branches and
  worktrees, its log); and for the Organization's Admin and Steward "Přístup k modulu".
  That opens the module in the Organization's Dashboard (Nastavení Organizace → Moduly
  → the module) in the same window. There a switch per Team decides whether the Team
  reaches the module, other roles see it read-only, and the page lists the people who
  reach it. GitHub stays the only authority: the Dashboard grants the Team access to the
  module's repository with the rights of whoever changes it, and the module then shows
  in Apps of the Environments whose GitHub identity reaches it.
- **"+ Nový modul"** (new module) is the last tile of Workspace. It opens Chat of the
  same Environment with a prepared prompt in the composer, not sent. The prompt has the
  agent first ask what the module is for, its name, whether it has an app (and which
  stack) and which Teams reach it; then found it with `lazurio module create
  <org>/<slug> --stack … --teams …` by the Lazurio Module Standard, `--dry-run` first
  and never by hand; check the GitHub repository and its Teams; and prepare a PR,
  asking before Publication. The tile shows only where GitHub's live answer says that
  the Environment's actual identity can create a repository in the Organization and
  grant it to Teams; without that answer it is not shown (fail closed). Typically that is
  the Organization Owner's own work Environment or computer. A Team Environment acts
  through the brokered Lazurio for GitHub app within its Team's grants (root decisions
  0147 and 0165), an Automated Environment through its persona's own GitHub account
  (root decision 0169), and the personal Environment has no Organization repositories;
  they get the tile only if their identity really has that capability. #154 builds
  this as the Owner check of F36's Organization-rail addendum, point 8. Once
  founding a Module in the Dashboard is done (plan DEV-6634), "+ Nový modul" leads there
  instead of to Chat (Matěj, 2026-10-04). The
  T3 Code fork accepts the prompt by link, from the Environment's own origin only and
  never sent without the person (Lazurio/t3code#35): the link carries only the prompt's
  id and the Organization's GitHub login, and the fork fetches the text from
  `/.lazurio/prompts/<id>` on its own origin ([prompt hand-off](#prompt-hand-off-to-chat)).

**Buddy.** Buddy is Buddy: he coordinates Agents on behalf of his person (the Operator)
and holds the same authority over Agents as the Operator; he is neither an Agent nor an
app. The Operator stays the human. In the shell Buddy is not a fourth mode of the
switch and not a tab, but a floating chat bottom-right on every screen, an iframe served
by the person's personal Environment and embedded in the Dashboard, the Launchpad,
module apps and both forks. The chat is one endless thread with Buddy, who runs on
Hermes Agent. Buddy knows the context the person asks from (Environment, app, module) as a
chip the person can remove, and he accepts images and files, which go straight to the
personal Environment; the host app never sees them. Buddy looking into an
Organization's Environment is intended: he knows that what he sees there is the
Organization's data and keeps it apart from the Personalspace memory and from other
Organizations. The window signs in with the Lazurio account (OAuth through
`auth.lazurio.ai`, a partitioned cookie); the host app passes no token. If that sign-in
cannot work in Safari or Firefox, Buddy's window is supported in Chrome only. A person
without a Buddy sees no bubble.

**The forks and `/.lazurio/`.** Chat (`Lazurio/t3code`) and Automate
(`Lazurio/OpenMausBot`) keep their upstream look and branding until upstream's stable
releases, and we keep calling them T3 Code and MausBot. A fork adds only the rail, the
column head at the top of its own sidebar (the only slot it adds to that sidebar) and
the Buddy bubble, and knows nothing of Lazurio's data:

- Behind the Environment's gateway every app hostname of the Environment
  (`launchpad.…`, `t3code.…`, `mausbot.…`) serves the path `/.lazurio/`, answered by
  this Launchpad. `/.lazurio/shell.js` is the script with the elements, in the version of
  the Launchpad on that Environment; `/.lazurio/shell.json` holds the signed-in person
  with their GitHub photo, the spaces (the personal space and the Organizations with
  their avatars), their Environments with their names and whom they serve, the last
  Environment used in each space (the Dashboard account remembers it; the Launchpad
  takes all of this from the Dashboard), the current Environment and the addresses of
  its apps. The second iteration needs no Organization accent: the Organization's colour
  stays in its avatar. Same origin: no CORS and no cookie of another site.
- `shell.js` defines three Web Components with Shadow DOM, so neither side's CSS reaches
  the other: `<lazurio-rail>` (the logo to the Dashboard, the search for the ⌘⇧E jump,
  the personal space, one avatar per Organization, "+", the account),
  `<lazurio-column-head>` (the Environment picker with the Settings gear, over the app
  switch, in place of the fork's logo at the top of its sidebar) and `<lazurio-buddy>`
  (the bubble).
- The patch in each fork is about 20 lines in about three files: the
  `<script type="module" src="/.lazurio/shell.js">` in `index.html`, the three elements,
  and a fixed rail with `#root { box-sizing: border-box; padding-left:
  var(--lazurio-rail-width, 0px); }` (padding, not margin: upstream `#root` is
  `width: 100%` under an overflow-hidden body, so a margin would clip the right edge).
  Each changed file joins the fork's allowlist as its own exact path. A check in the fork keeps
  that slot (the script and `<lazurio-column-head>`), so a rebase on a new upstream
  conflicts only on those lines.
- Nothing renders outside Lazurio: without `/.lazurio/shell.js` the elements stay
  undefined, the rail's width is 0 and the fork behaves as upstream. A new rail ships
  with the Launchpad, without a new fork release.

**What this changes below.** Today's build has Settings/Back and the update pill in the
sidebar footer and T3 Code's colour tokens
([Settings](#settings-structure-routes-and-the-t3-code-pattern)), a sidebar of
Organization groups on the home ([catalog](#launchpad-home-the-catalog)), and Chat and
Lazurio MausBot as links in the sidebar ([Chat entry](#chat-entry),
[MausBot entry](#lazurio-mausbot-entry)); the target replaces these. The routes, the
catalog's core and the module lifecycle are not affected. The shell built under decision
F36 is a cut of the first target: its rail has Organization folders, the gear and the
accent fill; its Apps column has the search and the module list; its tiles show state
by exception, and a module without an app opens its overview. The second iteration
replaces these.

**Open.** The narrow display (how the rail and a fork's sidebar collapse; upstream T3
Code uses an off-canvas sheet); how the context reaches Buddy's iframe (an attribute or a
`postMessage` per navigation); whether the switch takes the colours of the fork it sits
in; whether the switch still pairs the browser with T3 Code and MausBot on the way;
where the update pill goes. (How the catalog reads the productionspace repositories
was settled by F32's addenda: the read-only `repositories`; `infra` is not listed.)

## The shell as built (decision F36)

The [target shell](#target-shell) as built, DEV-6639: [decision
F36](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer)
and its addendum of 2026-10-04, the Organization rail of the wireframe at
prototypes-lazurio 1cbad15. Where the target shell above still describes a rail of
Environments, folders and a gear in the rail, the addendum supersedes it.

- **Library.** `src/shell/`: `contract.ts` (`lazurio.shell.v1` and its parser, and
  the identity of an Environment entry below),
  `view.ts` (the rail's spaces, the Environment picker's list, names and who lines, the
  switch, as pure functions), `elements.ts` (`<lazurio-rail>`, `<lazurio-column-head>`),
  `styles.ts` (the vendored tokens on `:host`, the design system's selection rule),
  `stones.ts`, `fonts.ts`, `last.ts` (the report of the last Environment used,
  below), `index.ts` (the entry of `/.lazurio/shell.js`) and `vendor/` (tokens, logo,
  fonts and stones with their hashes). Tests: `tests/shell.test.ts`,
  `tests/shell-last.test.ts`, `tests/launchpad-shell-routes.test.ts`,
  `tests/apps-view.test.ts`, `tests/account.test.ts`, `tests/app-opening.test.ts`,
  `tests/organization-owner.test.ts`, `tests/module-maintainer.test.ts`.
- **Identity of an Environment entry** ([F37's addendum of
  2026-10-04](decisions.md#addendum-of-2026-10-04-account-writes-one-namespace-the-environment-known-from-the-token)).
  The document's `current` and every Environment's `id` are the Environment's base host
  in lowercase DNS form: `<machine>.<org>` for an Organization's hosted Environment
  (`<app>.<machine>.<org>.lazurio.io`), the personal DNS slug for a personal Remote
  Environment (`<app>.<slug>.lazurio.io`), and a workstation's local id as before. The
  bare Machine name repeats across Organizations; the base host is unique by DNS, so
  the account document can list Environments of several Organizations. Only
  `environmentIdOf` derives it, from the Environment's own Launchpad origin; the
  producer (`shell-document.ts`) uses nothing else and fails closed when a hosted
  address yields no base host (no document, `operation-failed`; the rail stays empty).
  `parseShell` refuses an id that is not one or two lowercase DNS labels
  (`isEnvironmentId`), and a hosted entry whose id is not the base host of its own
  Apps address (the bare Machine name included). The Dashboard derives the
  same value from the registry's Apps address. The rail's memory of the last
  Environment, kept under the bare name, stops matching once and falls back to the
  space's first Environment. Tests: `tests/shell-environment-id.test.ts`.
- **Routes.** `/.lazurio/shell.js`, `/.lazurio/fonts/<file>` and
  `/.lazurio/stones/<file>` beside the page's routes (`src/launchpad/page.ts`);
  `/.lazurio/shell.json`, `/.lazurio/prompts/<id>`, `/api/organizations/<org>/owner`,
  `/api/organizations/<org>/modules/<module>/maintain` and `/api/chat/prompt-handoff`
  in the server after admission (`src/launchpad/server.ts`, producer
  `shell-document.ts`, the prompts `prompts.ts`, the Owner answer
  `organization-owner.ts`, a Steward's answer `module-maintainer.ts`, the hand-off
  check `chat.ts`). The page and the library also speak to `/.lazurio/account/…` on the
  same origin, which the Environment's gateway relays to the person's account (F37 and
  its addendum); the Launchpad does not answer it.
- **Page.** `index.html` is rail | column | main. The Apps column (all modules, Files,
  favourites, Marketplace) and home are `catalog-panel.ts` over `apps-view.ts` and
  `favorites.ts`, the frame is `shell.ts`, and the switch's pairing and the new
  module's hand-over to Chat are in `ui.ts`. A module's name, line and stone come from
  its default app's declaration (title, description, `icon`, tags), carried by the
  catalog as display-only `display`; the stone falls back by the root Launchpad's
  org-agnostic semantic key, and the Module's own manifest stays the authority.
  Settings, Tools, Recovery and Files keep their panels. The sections below that speak of the sidebar, its footer, the top
  bar, T3 Code's colours or Chat and MausBot as sidebar links describe the build before
  F36.
- **The person's account** ([F36's account
  note](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer),
  root decision 0185 S8, S12, S15, S18). Built, and waiting only for the account to
  answer on the Environment's own origin; until the gateway relays
  `/.lazurio/account/` (404 today) everything behaves as before it:
  - `account.ts` reads `GET /.lazurio/account/environments` once per page load
    (same origin, no token, given up after 4 s). Only a `lazurio.account.v1` document
    counts, and Apps takes two things of it: `preferences.openApps` and `favourites`
    keyed by the Organization slug.
  - Where apps open (S18, `app-opening.ts`): tiles, the column's favourites, "Otevřít
    aplikaci" and the lifecycle's "Otevřít" open in a new tab (`tab`, also without the
    account) or navigate this window (`same`), never in a frame. On a workstation the
    tab is opened within the click; this window moves only once the start succeeded.
  - Favourites (S12): with the account, an Organization's favourites are its list, in
    its order, and the star writes `PUT`/`DELETE
    /.lazurio/account/favourites/<org slug>/<module|repository>/<id>` at once. One
    favourite's writes go one at a time in the order of the clicks, and a failure is put
    back with a short message only when no later click wants something else. Without
    the account, and for the Personalspace group, they stay in the browser per
    Organization (`favorites.ts`); browser favourites are never uploaded.
  - The last Environment (S8, `src/shell/last.ts`): the library sends `PUT
    /.lazurio/account/last` once per full page load of Apps, Chat and Automate, fire
    and forget and silent on failure, apart from the rail's merge of the account. The
    Environment it names is the shell document's `current`, its base host (the
    identity of an Environment entry, F37's addendum).
  - "Přístup k modulu" (S15, #151): in a module tile's menu for the Organization's
    Owners and Stewards (GitHub's `maintain` on the module's declared repository), into
    the Organization's Dashboard in the same window.
- **Preview.** A temporary fixture Folder, never a live one: `bun
  scripts/preview-launchpad.ts local|hosted cs|en <port> [owner|steward|member]` writes
  an Organization with root-level and workspace modules in Workspace, two production
  repositories in Productionspace and an `infra` that is not listed, a synthetic home
  for Files and Tools whose `gh` answers for the example Organization as the role says
  (an Owner by default; a Steward maintains its workspace modules' repositories), and
  with `hosted` a recorded entry plus a loopback proxy that adds the gateway's Host and
  cookie. The account is not part of the preview: a browser automation stands in for
  the gateway's relay of `/.lazurio/account/…`. Screenshots come from Chrome through
  playwright-core.
- **A fork's snippet** is in decision F36 point 5 and in the target shell's "The forks
  and `/.lazurio/`": the rail, and the column head at the top of the fork's sidebar.
- **The interface the forks build on** is `src/shell/interface.ts` (version 1, F36
  addendum of 2026-10-04); `tests/shell-interface.test.ts` keeps every promised name.

### Prompt hand-off to Chat

"+ Nový modul" opens Chat of the same Environment with the prepared prompt in a new
thread's composer, not sent (Lazurio/t3code#35, Lazurio/LazurioPlatform#153).

- **The prompt.** `GET /.lazurio/prompts/<id>?org=<login>`, behind the admission of
  every read (the gateway's session hosted, where Machines proxies `/.lazurio/*` from
  the T3 Code origin to this Launchpad with the Launchpad's Host and the query kept;
  the fragment token locally), answers `application/json`, `Cache-Control: no-store`:
  `{"schema": "lazurio.prompt.v1", "id", "text", "cwd"}`. `text` is the prompt in the
  person's language (the Folder's profile locale), `cwd` the absolute root of the
  Organization on this Environment (`<Folder>/organizations/<directory>`). Only the id
  `new-module` exists (`src/launchpad/prompts.ts`, its text `newModulePrompt`); the
  Organization is the one Organization of the Folder whose manifest binds that GitHub
  login. Each prompt names who may get it: `new-module` only where this Environment's
  GitHub identity is an Owner of the Organization, the tile's live check
  (`organization-owner.ts`), so never on a Team Environment. Anyone else, an unknown id,
  an Organization the Folder does not bind to that login, any other query and every
  failure get the same `404 {"error": "not-found"}`: the answer never says more than the
  tile already showed. Any method but GET: 405.
- **The link.** The page never puts the text in a link. It opens Chat in a new tab
  through the pairing (`POST /api/chat/pair`) and adds
  `lazurio-prompt=<id>&lazurio-org=<login>` to the pairing link's fragment, after the
  token (`chatPromptHref` in `chat-view.ts`); without a pairing, to Chat's plain origin.
  A fragment never reaches a server or a log, and a T3 Code without the hand-off ignores
  both parameters.
- **Hand-off or clipboard.** The Launchpad hands the prompt over by link only where this
  Environment's Chat takes it. `GET /api/chat/prompt-handoff` answers
  `{"kind": "chat-prompt-handoff", "accepted": true|false}`: the server asks the T3 Code
  installed here, through the same `t3` launcher the pairing runs (`t3 --version`), and
  says yes only for a Lazurio fork release not older than the first one with the
  hand-off on its channel (`chatPromptsSince` in `chat.ts`: stable
  `0.0.45-lazurio.2`, released on 2026-10-04 with the overlay of Lazurio/t3code#36,
  preview `0.0.45-preview.20261004.1`). A vanilla upstream
  build, another shape, a missing launcher, a failure or a workstation (no Chat origin,
  nothing run) is no. The answer is kept five minutes. The page reads it once with the
  entry. Yes: the click opens Chat with the link and copies nothing. No: the click writes
  the prompt to the clipboard first, while the page still has the focus, then opens Chat
  as before, and the short message says to paste it into a new chat; a workstation only
  copies. A blocked tab falls back to the clipboard as well.
- **The fork.** The overlay of Lazurio/t3code accepts only the id and the login, fetches
  the text from its own origin, opens a new thread in the project rooted at `cwd` (adding
  that folder as a project when there is none, as "Add project" does) and leaves the
  text in the composer; nothing is sent without the person, and an unknown id, a failed
  fetch or a wrong answer insert nothing.
- **Tests.** `tests/launchpad-prompts.test.ts`: the prompt registry and its audience,
  the Organization a login names (case-insensitive, exactly one), the document, the
  version rule and the cached `t3 --version` check (every failure no), the link's shape,
  and HTTP: hosted behind the admission (401 without the session), the Owner's document
  with `no-store`, GitHub asked for the bound login, 405 for POST, the same 404 for
  another id, Organization, query or a non-Owner, the hand-off answer from the
  Environment's `t3`; locally only with the token, and no hand-off without a Chat origin.

## Settings: structure, routes and the T3 Code pattern

The Launchpad is one page with two views (decision F15 addendum 2026-09-28): the
Launchpad home and Settings. Since slice P4 of the Launchpad parity the home is the
catalog of the Folder's Organizations and modules
([below](#launchpad-home-the-catalog)); the addendum's sentence that the development
Application panel stays on the home needs Matěj's amendment. Settings follows
the settings UX of T3 Code, as Matěj asked, in plain CSS inside
`src/launchpad/index.html` and without a framework or a new dependency. In the
[target shell](#target-shell) Settings keep that shape in the Lazurio design-system
look and open from the gear beside the column head's Environment picker (second
iteration, 2026-10-04; the first target had the gear in the rail).

**Routes.** `/settings/general`, `/settings/machine`, `/settings/tools` and
`/settings/recovery` (the read-only [Recovery page](recovery.md#the-recovery-page)); `/settings`
and an unknown section open General and the address bar is rewritten to the canonical
path. The paths live in `src/launchpad/routes.ts` (pure, tested in
`tests/launchpad-routes.test.ts`); the server serves the same bundled page under
exactly these paths (`pagePaths`) and nothing else, locally and through the hosted
shell listener after admission. A path never carries the credential: locally the
fragment token of the terminal link is read once and kept in page memory, and moving
between routes uses `history.pushState`, so the page never reloads and the token
stays. A deep link works as the first address (`/settings/tools#<token>`) or, hosted,
through the gateway; a local link opened in a new tab without the token shows the
page but its reads are refused, as before. `src/launchpad/shell.ts` holds the DOM of
the frame.

**What went where** (every setting the page had; none was added):

| Before | Now |
| --- | --- |
| Environment profile: Workspace preset, Language, Detail, Coordination, Preview, Apply previewed change, the status line | Settings → General, one group of rows; Preview and Apply in its last row |
| Reload profile | Settings → General, page action in the header |
| JSON of the last answer (`#result`) | Settings → General, behind "Technical details" |
| This Environment (read-only handover) | Settings → This Environment (Czech "Tento Environment"), one row per recorded fact |
| Tools (groups, cards, dialogs, MCP card) | Settings → Tools; Refresh status is its page action in the header |
| Product update pill, with the read-only "Folder refresh needed" line (F17 addendum) | Sidebar footer above Settings/Back, visible from every route, and only while an update is available or under way (Matěj 2026-09-28, as in T3 Code); the Folder refresh line is independent of the pill, a subdued notice right above it with the command in selectable monospace |
| Application (development lifecycle) | Launchpad home `/`, not a setting; since P4 replaced there by the catalog; since P5 the module page carries the lifecycle ([below](#module-lifecycle)), the development API stays |

**Patterns adopted from T3 Code** (source: `pingdotgg/t3code` at `d15210cd3d`,
`apps/web/src/`, and the installed T3 Code 0.0.42 bundle):

- the sidebar becomes the settings navigation on a settings route, a flat list with an
  icon per section, 32 px rows, 8 px radius, the current item on a lighter surface with
  `aria-current="page"` (`AppSidebarLayout.tsx`, `SettingsSidebarNav.tsx`,
  `ui/sidebar.tsx`);
- the sidebar footer has "Settings" on the Launchpad home and "Back" inside Settings;
  Back goes to the Launchpad home, not through the browser history, and the update
  pill sits in the same footer (`sidebar/SidebarChrome.tsx`, `mainAppLocation.ts`);
  in the [target shell](#target-shell) Settings open from the gear beside the
  Environment picker instead, scoped to what the picker names;
- Escape leaves Settings unless something else took it (`hooks/useNavigateBack.ts`);
- a 52 px header with the breadcrumb "Settings / Tools", the current item
  `aria-current="page"`, and page-level actions on its right (`SettingsBreadcrumb.tsx`,
  `WorkspacePageHeader.tsx`, `routes/settings.tsx`);
- content 56 rem wide at most, 24 px padding, 32 px between sections
  (`WorkspacePageContainer.tsx`, `settingsLayout.tsx`);
- a section is a quiet heading (14 px, regular, 70 % foreground) over a card with a
  12 px radius, a faint border and dividers between rows; a row has the title (14 px
  medium), the description (13 px muted) and a status line (12 px) on the left and the
  control on the right, and stacks below 32 rem of its own width (container query)
  (`settingsLayout.tsx`, `SettingsGroup.tsx`);
- yes/no is a switch (`role="switch"`, 18 px), an enumerated choice a select; 28 px
  buttons with an 8 px radius, outline by default, the primary filled, sign-out in the
  destructive-outline style (`ui/switch.tsx`, `ui/button.tsx`);
- dialogs with a 16 px radius, a large shadow, a dimmed backdrop and a footer bar with
  the actions on the right (`ui/alert-dialog.tsx`);
- below 768 px the sidebar is an off-canvas sheet opened from a header button; choosing
  a section closes it (`ui/sidebar.tsx`);
- the colour tokens of `index.css`: zinc in light, neutral in dark, the same primary,
  through `prefers-color-scheme`; the system font stack. Superseded by the
  [target shell](#target-shell): Settings take T3 Code's shape in the Lazurio
  design-system look (its tokens, type and colour); only the forks keep the upstream
  look.

**Deliberate differences.** Moving between sections adds a history entry (T3 Code
replaces it), so back and forward move between sections as Matěj asked.
Choosing a section keeps the focus on the navigation item as in T3 Code, but every
other move (Settings, Back, the breadcrumb, back/forward, a section chosen in the
narrow sheet) focuses the heading of the new view and the document title names it.
Escape does not leave Settings from a form field, so an unsaved note is not left
behind by a stray key. T3 Code's settings search, `/` shortcut, resizable sidebar and
per-row reset are not built: the page has three sections and no defaults to reset to.
The General settings keep the explicit Preview → Apply of a Folder change instead of
T3 Code's immediate apply. Icons are Iconoir (MIT), the design system's interface set, inlined as SVG symbols (Lucide before decision F36's addendum of 2026-10-04).

## Launchpad home: the catalog

Slice P4 of the Launchpad parity (shaping `docs/launchpad-parity.md` B1 on its review
branch; decision F22, whose points Matěj decided on 2026-09-28). The home shows the
Organizations and modules of the Folder the Launchpad serves; the developer form and
its "Development fixture only" banner are gone.

**Source.** One core, `readFolderCatalog` in `src/organizations/catalog.ts`: every
directory in `<Folder>/organizations/` (not files, not hidden entries) is one candidate,
resolved by the canonical reader (`read-applications.ts`, `root-resolution.ts`).
Hidden entries are not candidates, as the resident's glob `organizations/*` never
matched them; `.cache`, `.git` and editor folders are the normal case. No
allowlist, no planned slots, no `launchpad.gen3*.json`, no state: the catalog is
recomputed on every read. A candidate that cannot be read keeps its typed reason
(`canonical-documents-required`, `organization-conflict`, `template-not-runtime`,
`organization-changed`, `organization-unavailable` for a link or a directory that is
not the operator's) and never hides the others; two candidates that declare the same
slug are both `organization-duplicate`, because `<Org>/<Module>` would be ambiguous.
The modules of an Organization are its declared slots (`modules.manifest.json`
`module_slots`), in declaration order: every workspace slot
(`workspace/<module>`), and a root-level application slot, `mission-control` or
`design-system`, when it carries a `lazurio.module.json` (decision F24); a
root-level application slot that is not declared, or not checked out, or checked out
without a module manifest, is not a module, and nothing is guessed from a directory.
Such an application is a module like any other: its `path` is the slot path, its id
is the slot's id (its `slug`, else the last path segment), which its manifest's `id`
must equal, exactly as for a workspace module, and its Teams, checkout rule,
executability and reasons are a workspace module's. The repository slots `infra` and
`mission-control/db` and everything under `productionspace/` are never modules. An
id that a workspace module and a root-level application share is
`declaration-conflict` on both, with the inventory issue `repository-id-collision` on
the Organization, as for any two slots declaring one id.
Per module: Organization slug, module id, path, apps and the default app, Teams (N:M)
with their source `teamsSource`, the root state and `executable`, or a typed `reason`
(`organization-not-executable`, `declaration-conflict`, `module-unavailable`,
`explicit-apps-required`, `no-app`, `default-app-invalid`, or a refusal of the
checkout rule of decision F23 with its module-relative `file`: a declaration
`declaration-not-regular`, `declaration-owner`, `declaration-too-large`, a directory
of the module `directory-not-regular`, `directory-owner`; an Organization whose root
or document is refused gets the same reason with its `file`; or, since decision F25, a
preparation of the default app that cannot run for a reason known without running
anything, with the package it concerns as `file`: `preparation-lockfile-missing`,
`preparation-lockfile-ambiguous`, `preparation-package-manager-unsupported`,
`preparation-dependency-outside-owner`, `preparation-dependency-missing`,
`preparation-owner-invalid`, `preparation-applications-overlap`,
`preparation-script-missing`, `preparation-workspace-unqualified`). Executable means the
declarations admit a start of the default app under the one admission rule of the
[organization contract](organization-contract.md) (variant B, decided 2026-09-28 on
question H1: a canonical-only `current` Organization runs) and that its preparation can
run as far as is known read-only (`inspectPreparationShape`; a module refused only by
it carries `preparationRefused: true`, and its status, logs and stop still work, F25
point 4a); it is not readiness,
provider permission or a lease. The contents of the install inputs (lockfile bytes,
local dependencies, patches, configuration) are still the start's to refuse (F23 point
6), and so are a Bun version mismatch and a failing install. A malformed
Team membership is reported as `teams-invalid` on the module and never blocks it.

**Production repositories (F32 final addendum of 2026-10-03).** Per Organization,
`repositories` lists in declaration order the declared `productionspace/<repository>`
slots, which the Launchpad shows read-only in its Productionspace section. They are
never modules. Each has `slug`, `path`, `checkedOut` and `url`; there is no `layout`
field, on a repository or on a module (the first addendum's three groups are gone).
The canonical reader (`observeOrganizationApplications`) returns them with the modules, from the same documents; a slot without a usable id or
in a declaration conflict is left out, and its issue stays on the Organization.
`checkedOut` is true when every directory down to the slot passes the checkout rule of
F23 and the slot holds `.git` (a directory, or a linked worktree's file); a missing,
refused or plain directory is not checked out. `url` is the GitHub page
`https://github.com/<owner>/<repo>` of the slot's `git.url` (or the legacy `repo`,
`repository`) when that names a github.com repository, otherwise null; nothing is
fetched. `infra` and `mission-control/db` are not listed: neither is a module nor a
production repository. An Organization that could not be read, and the Personalspace
group, have `repositories: []`.

**Teams.** The canonical form is `module_slots[].teams`. The catalog resolves membership
exactly as the resident's read model does (`organizationSlotTeams` in the legacy root's
`lazurio/core/organization-slot-scope-lib.mjs`, the order of `declaredSlotTeams` in
`lazurio/runtime/discovery-lib.mjs`): `teams` when it is a list; otherwise, for
compatibility with older manifests, the legacy alias, the `workspaces` list and then the
singular `workspace`; blank entries and `productionspace` are dropped; nothing left means
the default Team `workspace` (decision 0041, as the resident's Launchpad README says).
`teamsSource` is `teams`, `legacy-alias` or `default`. An Organization with any
`legacy-alias` module is named once, never per module, in a note under the CLI tables,
so its manifest can be migrated to `teams`. Teams are for the CLI and the catalog's
JSON: the Launchpad shows none (decision F32, an Environment is one workspace).

**CLI first.** `lazurio organization list [--folder <F>] [--json]` prints the catalog
(`--json`: exactly the object below), `lazurio module list [<Org>] [--folder <F>]
[--json]` its modules, for one Organization named under the one selection rule the
routes share (`selectCatalogOrganization` in `src/organizations/catalog-selection.ts`):
its slug, case-insensitively; a slug that two or more candidates declare, in the same
case or another, selects none of them; only when no slug matches, the exact directory
name. Without `--folder` the Folder is found as `lazurio update` finds it:
the supervised unit's `[X-Lazurio] Folder=`, otherwise the hosted Machine's declared
operator (`standardFolder` in `src/update/cli.ts`, one function for both); a
workstation without a unit names it. Human output is aligned columns as in
`lazurio tools list`.

**HTTP.** `POST /api/catalog` with `{}` answers the same catalog (tests compare it to
`organization list --json`), behind the same admission as every other route: the
fragment token locally, the gateway's cookie hosted.

**The Personalspace group (P13, launchpad-parity B11).** On a preset that has a
Personalspace (`local`, `hosted-personal`: `personalspace: "present"` in
`src/folder/presets.ts`) the catalog carries one more group, `personalspace`, with the
modules in `<Folder>/personalspace/<owner>/workspace/<module>/`, the glob the
Machines gateway serves (`M:workloads/workspace-vm/gateway-catalog.py:106-107`, where
the module id is the manifest's `id`, `:139-148`). An Organization preset never reads
`personalspace/`; nor does a Folder whose state cannot be read (fail closed). The
preset is read from `preferences.json` without the Folder lock, as `observeFolder`
reads it: its Personalspace policy never changes for a Folder, because each Machine
kind allows only presets of one policy. There is no Organization manifest and no new
state: a directory in `workspace/` named like a module id that holds a
`lazurio.module.json` is a module, its declared `id` must be its directory name, and
it is read by the same module reader as an Organization slot
(`observeModuleDirectory` in `src/organizations/read-applications.ts`), with the same
module reasons. Executable means the module's own declaration admits a start of its
default app; there are no Teams (`teams: []`, `teamsSource: "none"`), no root state
(`state: null`) and no company check against an identity, since nothing but the
module declares one. The group has the shape of an Organization named
`personalspace` (`directory`, `organization` and the modules' `organization` are that
literal; the owner's directory name is never in any output) and sits in the catalog's
own `personalspace` field, not in `organizations`, so no reader of Organizations (the
Doctor's checks, the table of `organization list`) lists it by accident; `module
list`, the selection rule (`catalogGroups` in `catalog-selection.ts`) and the page add
it after the Organizations. Exactly one owner directory is expected (hidden entries
are skipped): with two or more, which one is the Operator's is not guessed, none is
read, and the group is listed with `personalspace-ambiguous` and no modules (decision
0091); an owner directory or `workspace/` that is not the Operator's own is
`personalspace-unavailable`. An Organization whose slug is `personalspace` is
ambiguous with the group under the selection rule. The resident addressed these apps
as `<owner login>/<module>` (its `company` was the owner,
`R:lazurio/runtime/personalspace-lib.mjs:1126`, selected by
`R:lazurio/core/module-lifecycle-client-lib.mjs:297,385`) and its CLI refused them on a
personal server (`:76`); the Platform names them `personalspace/<module>` instead, so
no output carries the login. The company a module declares is still part of its
transient unit's readable name (`applicationUnitName`), as it was in the resident's
inventory.

**Routes.** `/` is the first Organization's Apps home; `/o/<org>` one Organization's
Apps home, its sections Workspace and Productionspace (F36, F32's final addendum);
`/o/<org>/<module>` one module (Organization, apps with the default marked,
path, resolution state, whether it can run). No route shows Teams (F32). `<org>` is selected by the CLI's rule
above and each segment is URL-encoded. A candidate's own route uses the name that
selects exactly it: its slug, otherwise its directory name (an Organization that
could not be read, or one of two candidates of a slug whose directory is not a slug);
a candidate that no name selects has no link and is shown with its reason on `/`. An
ambiguous slug never shows one of its candidates: `/o/<slug>` and its module routes
show the duplicate isolation with every candidate's directory and status. A route the
Folder does not have says so with a link to all Organizations. The paths live in `src/launchpad/routes.ts` next to the settings
routes, the server answers them with the same page (Bun route parameters) and nothing
deeper, and they behave like the settings routes: deep links, back and forward,
focus on the heading, the breadcrumb "Organization / module", the document title.

**Sidebar in T3 Code's pattern.** On the home frame the sidebar lists "All
Organizations", then each Organization as a group (T3's projects) with its modules as
rows (T3's threads) and a status dot (green: can run; grey: cannot, with the reason
in the row's accessible name). Each module is one row, in the catalog's order (the
declaration order of `module_slots`), whatever Teams declare it, and there is no Team
subheader (decision F32; until then a subheader per Team listed a module of two Teams
twice). From F32's first addendum of 2026-10-03 the rows sat in three layout groups
(Organizace, Workspace, Productionspace); its final addendum the same evening left two,
**Workspace** (every module, in the catalog's order) and **Productionspace** (the
production repositories, read-only), which the shell's Apps column and home draw
([below](#the-shell-as-built-decision-f36)). A section with nothing in it is not
drawn; the Personalspace group stays one list.
The current Organization or module is `aria-current="page"`. "Refresh" is the page
action in the header. Below 768 px the sidebar is the same off-canvas sheet as in
Settings, and choosing a row closes it.

**Target (2026-10-03).** This sidebar of "All Organizations" and Organization groups is
today's build. In the [target shell](#target-shell) the home shows the Organization's
name on top (a picker on a computer with several Organizations) and two sections,
Workspace (every module) and Productionspace (read-only), with no grouping by Team; a module
tile opens its app in a new tab, and selecting a module in the left column opens its
overview.

**What a module row shows.** Name, default app, and "Can run" or the reason in
words with its code; no Team badge (F32). A production repository's tile or row shows
its name and path, "Not checked out" in words when it is not, and is a link to its
GitHub page when it has one; no status dot, no action and no page of its own. Rows carry no action; the
module's page carries its lifecycle
([below](#module-lifecycle)). `src/launchpad/catalog-view.ts` holds the pure
presentation (tested in `tests/catalog-view.test.ts`), `src/launchpad/catalog-panel.ts`
the DOM, drawn with `textContent` only.

**Verification 2026-10-03 (F32 final addendum).** `tests/organization-catalog.test.ts`
reads the same fixture Folder and checks that `alpha`'s modules, its root-level
application among its workspace modules, form one list in declaration order with no
`layout`, and that its `repositories` are only `firmware` and `connect`: the checked-out
`infra` with its GitHub remote is not there. The HTTP answer equals the CLI's JSON,
passes the page's shape check and carries no `layout`. `tests/catalog-view.test.ts`
checks in both languages that an Organization has at most two sections, Workspace and
Productionspace, the Workspace section being the very flat list with a root-level
application in the middle where it is declared, an empty section not drawn and no
"Organizace"/"Organization" heading; `tests/apps-view.test.ts` that the Apps home's
sections are Workspace and Productionspace with their counts, and that a production
repository's tile has no action and a muted note instead of a dot.

**Verification 2026-10-03 (F32 first addendum, superseded).** `tests/organization-catalog.test.ts`
reads the fixture Folder, whose Organization `alpha` has a root-level application
(`mission-control`), three workspace modules, a checked-out `infra` with a GitHub
remote and two productionspace repositories, `firmware` checked out with an SSH
remote and `connect` not checked out. It checks every module's `layout` and the
repositories with their checkout state and page. A productionspace directory without
`.git` is not checked out, and a slot path decides the group, not the id. The HTTP
answer equals the CLI's JSON and passes the page's shape check.
`tests/catalog-view.test.ts` checks the groups the page draws in both languages: the
order Organization, Workspace, Productionspace; modules before repositories; an empty
group not drawn; every module in exactly one group; the Personalspace group without
groups. It also checks that an answer whose layout, repositories or link is malformed
is not drawn. The page was rendered in headless Chrome against a fixture Folder (see
the pull request).

**Verification 2026-10-02 (F32).** `tests/catalog-view.test.ts` checks the pure view
the sidebar, the overview and both pages draw (`catalogTree`, `organizationFacts`,
`moduleFacts`): a module of two declared Teams, one of an undeclared Team and one of
none are each listed once in declaration order, the Personalspace group stays last,
and no drawn text names a Team, its membership source or `teams-invalid`, in both
languages. The CLI's Teams column and legacy-alias note keep their tests in
`tests/organization-catalog.test.ts`. The home, the sidebar, an Organization page and a
module page were driven in headless Chrome (Playwright) against a temporary
workstation Folder with two Organizations, three Teams sharing modules and a
Personalspace module: every module once, no Team subheader, heading or badge, no page
errors.

**Verification 2026-09-28.** Unit and HTTP tests (`tests/organization-catalog.test.ts`,
`tests/catalog-view.test.ts`, `tests/launchpad-routes.test.ts`, the hosted test) use a
fixture Folder with two Organizations (one `transition` with a module in two Teams,
one canonical-only `current`), one invalid, one template, a linked candidate and a
duplicated slug; both admission variants were run by flipping the one constant. The
home was driven in headless Chromium (Playwright) against an isolated home, an empty
PATH and a temporary fixture Folder, in English and Czech: no form or banner, four
groups, a module under two Teams, no row actions, sidebar and body links to the
Organization and module routes with focus on the heading, the breadcrumb, back and
forward, a deep link with the token, an unknown route, Settings and Escape back,
the narrow sheet, light and dark, without page errors. Screen-reader output was not
qualified by a manual run.

## Module lifecycle

Slice P5 of the Launchpad parity (shaping `docs/launchpad-parity.md` B3, B4, B6; root
decision 0167 points 1–2, command names kept from the resident). One core,
`createModuleOperations` in `src/modules/module-operations.ts`, answers the CLI and the
Launchpad; tests compare their outputs.

**CLI first.** `lazurio module start|prepare|stop|status <Org>/<module> [--app <package>]
[--folder <F>] [--json]` and `lazurio module logs <Org>/<module> [--lines N]` (default
100, at most 1000). `<Org>` is selected by the catalog's one rule
(`selectCatalogOrganization`): a slug that two directories declare is refused as
`organization-ambiguous` with every candidate's directory, a module that cannot run is
refused with its catalog reason (`no-app`, `default-app-invalid`,
`organization-not-executable`, `template-not-runtime`, …), an undeclared `--app` as
`app-unknown` and a declared one without a valid runtime as `app-not-runnable`. A
named `--app` still runs when the module's only fault is its default app. The Folder is
found as for `module list`. Exit status: 0 done, 2 refused, 1 the Folder could not be
read.

**What runs, and who owns it.** Start runs the module's default app (or `--app`) from
its own declaration through the existing lifecycle (`src/modules/lifecycle.ts`), the
runners and `localApplicationAdapters`: for an app without a `lazurio.preparation` its
default preparation, the frozen install from the lockfile beside its package (decision
F25); for an app that declares one the same frozen install on every start (when
`node_modules` matches the lockfile Bun leaves registry dependencies as they are, but
copies local `file:` dependencies again and runs the app package's own lifecycle scripts
such as `postinstall`), then its check, and only when the check fails the
declared `prepare_script` and the check again (decision F34, Lazurio Module Standard
ch. 3 and 10); then the dev script, never a hostname convention. A check that passes
after the install runs no `prepare_script`. **Prepare** (`lazurio module prepare`) runs the lifecycle's explicit
preparation (the transaction with the retained owner lock), whatever the check says now,
and starts nothing: for a declared preparation the install, `prepare_script` and check,
for the default its install. It never prepares beneath a running app: a service-owned
app is `application-running`, another managed app of the Organization
`other-app-managed`, and a session app is stopped for its own preparation, as before. The toolchain is the operator's Bun at
`<home>/.local/bin/bun` (B2); missing, start is refused as `toolchain-missing` before any
effect (`--bun-executable` stays a development flag of the old panel only). On Linux with
a reachable user manager the app is a transient systemd user unit (`systemd-user`
runner): it survives a Launchpad restart (same `InvocationID`), ends with a reboot, and
writes to the journal (`StandardOutput/Error=journal`); `logs` is `journalctl --user
--unit=<unit> --lines=N --output=cat`. The app's `PATH` is the installed unit's line
(`~/.local/bin:/usr/local/bin:/usr/bin:/bin`), so the CLI and the Launchpad start
identical units. Beside `HOME`, `PATH` and optional `TMPDIR` the app gets exactly the
runtime environment the replaced Launchpad gave it (decision F26, the table in
`docs/module-adoption.md`): the keyed and entrypoint listener addresses, the listener
JSON, `NODE_PATH`, `NODE_ENV=development`, the runtime and Organization identity, and on
a hosted Machine, for the module's default app, the entrypoint's external origin
`LAZURIO_RUNTIME_EXTERNAL_ORIGIN`, taken from the same recorded entry as `runtime.url`
(that URL without its slash), so a dev server that allows only its own hostname
accepts the browser. Nothing ambient is inherited. A running app keeps the environment
it was started with; after an update that changes it, Stop and Start the app once. On macOS the app is a child of the Launchpad session (`session`
runner), as before: the Launchpad holds one lifecycle per Organization and its apps end
with it; the CLI, another process, answers `launchpad-required`, and `logs`
`logs-unavailable` (session logs are the macOS line, P14). **No Folder state:** the
running state is the service manager's or the session's; every call reads the catalog
again. Lifecycle refusals keep their codes (`port-occupied`, `prerequisites-not-ready` — the
declared check still fails after the preparation —, `coordination-busy`,
`service-unrecognized`, …); a failed step of a preparation is named
(`preparation-install-failed` with the lockfile, `preparation-script-failed` with the
owner's `package.json`, decision F34). A file or directory of the module's
checkout that the checkout rule refuses during the start (an install input such as a
local dependency's file) is named by its rule (`declaration-*`, `directory-*`) with
its module-relative `file` (decision F23); a preparation that cannot run for a known
reason by its `preparation-*` reason and the package or lockfile it concerns (decision
F25, `src/modules/preparation-refusal.ts`); any other throw inside the lifecycle is
`operation-failed`.

**Answer.** `{kind: "module", operation, organization, module, app, runner,
survivesLaunchpadRestart, outcome, state, healthy, service, runtime, runtimeReason?}`;
`outcome` is the lifecycle's own result (`started`, `already-managed`, `prepared`,
`group-stopped`, `status`, `not-managed`), `state` one of `running`, `starting`, `stopping`, `ended`,
`stopped`, `service` the unit and invocation (null for a session app). `runtime.url`,
the name root `AGENTS.md` uses, is present only while the app reports healthy: locally
the loopback address its owner observed; on a hosted Machine only
`moduleOrigin(template, id)` of the recorded entry (`src/launchpad/hosted-entry.ts`), for
the module's default app, which is what the gateway serves; never a loopback address.
Without a recorded entry there is no link (`runtimeReason: "hosted-entry-missing"`), and
a non-default app on a hosted Machine has none either (`hosted-app-not-default`).
Refusals are `{kind: "blocked", operation, reason, …}`.

**HTTP.** `GET /api/modules/<org>/<module>/status[?app=<package>]`, `POST
/api/modules/<org>/<module>/start`, `…/prepare` and `…/stop` with `{}` or `{"app": "<package>"}`,
each segment URL-encoded, behind the existing admission (the fragment token locally,
the gateway's cookie hosted; `POST` also same-origin). The body is the CLI's `--json`
object: 200 when done, 409 when refused. Start and prepare answer within 630 seconds
counted from naming the module, below their 660-second idle timeout (decision F34); the
deadline covers the module's resolution and the status read of the answer as well. One
still running when only the status read's share is left (half the deadline, at most 5 s;
queued behind another app's start of the Organization, waiting for a lock, or installing)
answers 202 with the app's status and the outcome `start-pending` or `prepare-pending`,
goes on in the Launchpad, and the page says so; a status read that does not finish in
the rest leaves that answer unobserved (not healthy, `starting` for a start, `stopped`
for a preparation), and a module not resolved in time is not operated on
(`operation-failed`).

**Page.** The route `/o/<org>/<module>` of an executable module shows an "Application"
card in the settings-row pattern: a status dot (green running and healthy, amber
starting or not ready, red ended, grey stopped or unknown) with one sentence, who keeps
it running ("Keeps running when the Launchpad restarts" or "Ends when this Launchpad
ends"), why a healthy app has no link, the sentence after the last action in a polite
live region, and on the right "Open" (a new tab, only the root of an https hostname or a
loopback port) and the one primary action, Start or Stop. After Start the page reads the
status once a second until the app reports healthy, about half a minute at most; the
keyboard focus returns to the action. Pure presentation in
`src/launchpad/module-view.ts` (tested in `tests/module-view.test.ts`), Czech and
English.

**Not in this slice.** An `open` verb, a Prepare action on the page (Start prepares
an app whose check fails; `prepare` is the CLI's and the route's, decision F34), the
output of a preparation's processes,
the T3 Code chat link (P7, since in [Chat entry](#chat-entry)), worktree `--source` (P9), a logs
tail on the page, and the retirement of `/api/apps/*`, `app-request`,
`--organization-directory` and `--bun-executable`: they keep working unchanged for their
tests and `scripts/smoke-application-ui.ts`. The seams are marked in
`src/modules/module-operations.ts`.

**Verification 2026-09-28.** `tests/module-operations.test.ts` over the catalog's
fixture Folder: every refusal equal from the CLI and over HTTP; the Linux path against
the in-memory user manager (`tests/fixtures/fake-service-manager.ts`) with the compiled
process guard running the declared start check (start from the page, CLI and HTTP
status equal, `already-managed`, logs, a Launchpad restart keeping the invocation, stop
from the CLI, `toolchain-missing`); the hosted link from a recorded entry and its
absence without one; the session path with a real synthetic app, `launchpad-required`
and `logs-unavailable` from the CLI, and the app ending with its Launchpad. The unit
policy transition (an older unit with `null` output is `service-unrecognized`) is in
`tests/systemd-user-runner.test.ts`. The page was driven in headless Chromium against the
compiled executable on macOS with a temporary home and Folder: Start, the healthy
status with Open to the loopback URL, Stop, focus on the action, and no action on a
module that cannot run. A real systemd user manager and journal (Ubuntu 24.04) were
**not** exercised by this slice; that is C.5.

**Verification 2026-10-02 (F34).** `tests/module-declared-preparation.test.ts` runs the
real Bun, the compiled process guard and the in-memory user manager over fixture modules
with the standard declaration on a fresh checkout (a lockfile, no `node_modules`):
`lazurio module start` installs, checks, runs `prepare_script`, checks again and starts
(package and lockfile unchanged); a prepared tree's next start checks once and runs no
`prepare_script`; a check that passes after the install runs no `prepare_script`; a
failing `prepare_script`, a lockfile the package no longer matches (no check runs) and a
check that still fails are each named and start nothing; a nested application only
checks. A tree installed for an earlier lockfile whose check passes (#114's last
comment) is installed by a start through a session Launchpad, and the real app serves
the dependency version the lockfile pins. `lazurio module prepare` prepares without starting,
for a declared and an undeclared app, names the same failures, is refused beneath its
running app and while another app runs, answers like `POST …/prepare`, and is
`launchpad-required` where apps are session-owned. Under shortened deadlines the routes
answer in time: a start queued behind a preparation answers `start-pending` (202 over
HTTP) and goes on, a runner selection slower than the deadline answers
`operation-failed` and starts nothing, and a status read that does not finish answers an
unobserved `start-pending` while the start goes on. `tests/frozen-install-process.test.ts`
covers the steps' order and failures in the Bun preparation itself,
`tests/module-lifecycle.test.ts` the core's decisions with fake adapters, and
`tests/organization-applications.test.ts` a fresh declared module started through the
compiled Launchpad's session. A real systemd user manager and a real Remote Environment
were **not** exercised; `scripts/smoke-application-service.ts` was updated for the new
start and not run.

## Doctor

Slice P8 of the Launchpad parity (shaping `docs/launchpad-parity.md` B9): the
healthy-product readback of an Environment, the machine-readable preflight of C.2 step 4
and the readback of C.3 item 4. One core, `collectDoctor` in `src/doctor/doctor.ts`;
the terminal surface is `src/doctor/cli.ts`. `lazurio recover` stays the
broken-product path with its evidence, prompt and issue; doctor points to it.

**CLI.** `lazurio doctor [--folder <absolute Folder>] [--sign-in] [--json]`. The Folder
is `--folder`, the supervised unit's, or on a hosted Machine the declared operator's
(as for `lazurio update`). Exit status: 0 `ok`, 10 `attention` (a `warn`), 3 `broken`
(a `fail`), 2 usage, 1 the command itself failed.

**Read-only.** Doctor adds one check of its own, the operator's Codex app-server
daemon of a Remote Environment (`codex-app-server`, F29); every other answer comes
from a reader the product already has, and none of them writes. The Folder's tool selection is read under
the Folder's read lock (`toolsOverview`) where its state is recognized, and without a
lock otherwise, since taking the lock of a state without one would create it; nothing
is fetched (`update-available` is the
last verified check on disk); nothing restarts. `--sign-in` additionally runs each
installed tool's sign-in probe, which may contact its provider, exactly as `tools list
--sign-in`. The heavy reader is the active executable's `self-check`, one process, as in
`recover`. A test snapshots the whole temporary tree (paths, modes, sizes, modification
times, the SHA-256 of every file and the target of every link) before and after and finds
it byte-identical. A tool's version is reported only as numeric segments
(`2.63.0`); a suffix is free text and is omitted.

**Answer.** `{kind: "doctor", verdict: ok|attention|broken, locale, checks}`; every
check is `{id, outcome: ok|warn|fail|skipped, reason?, context?}` in group order. Ids
and reasons are enumerated (`doctorCheckIds`, `doctorReasons`); a check about one tool,
Organization or module names it in `context` (`tool`, `organization`, `module`). The
context passes one allowlist, recover's tier 1 (`contextRules`) extended by doctor's
keys (`doctorContextRules`): enumerated values, releases, counts, template revisions
and identifier-shaped catalog names. A catalog name that is not an identifier is
`invalid` (`lazurio organization list` shows it); no path, digest, account or message
is ever printed. The human form groups the checks in the catalog's columns (control
characters escaped), Czech or English by the Folder's locale.

| Group | Id | Source | Outcomes |
| --- | --- | --- | --- |
| product | `update-state` | `collectRecovery` R2 | `fail state-invalid` with the relative state path |
| product | `product-version` | `readStatus` running vs active | `warn running-not-active`, `warn not-installed` |
| product | `self-check` | `collectRecovery` R5 | `fail self-check-failed` with its reason |
| product | `update-available` | `readStatus` (`last-check.json`) | `warn update-available`; `skipped never-checked` |
| product | `folder-refresh` | `readStatus.folderRefresh` | `warn folder-refresh-needed`; `skipped not-active` when the running executable is not the active one |
| product | `template-revision` | `observeFolder` facts | `warn folder-newer` (a newer product rendered it), `warn revision-unknown`; an older one is `folder-refresh` |
| Folder | `folder-state` | `collectRecovery` Folder state; preset and Machine kind from `observeFolder` | `fail folder-state-pending`, `-absent`, `-unrecognized`, `-unreadable` |
| Folder | `machine-binding` | recorded `preferences.machine` vs `machineBinding` of the live handover | `warn machine-identity-changed`, `warn handover-changed` (digest; `machine folder-refresh`), `warn binding-absent`, `warn handover-unreadable`; `skipped not-hosted` |
| tools | `tool` | `toolsOverview` (tiers, enabled), else `toolsStatus` over the catalog | required missing `fail required-missing`; `warn recommended-missing`, `warn enabled-missing`, `warn version-unreadable`; `skipped not-enabled`; `signIn`/`ssh` ids with `--sign-in` |
| organizations | `catalog` | `readFolderCatalog` | counts of the Organizations and their modules only: the Personalspace group is never counted or named; `warn catalog-unreadable` |
| organizations | `organization` | catalog entry | `warn` with the Organization reason; a template `skipped template-not-runtime` |
| organizations | `module` | catalog entry | `warn` with the module or Organization reason |
| launchpad | `launchpad-unit` | `collectRecovery` unit (Linux, supervised) | `fail unit-*`; `skipped no-user-manager`, `not-supervised` |
| launchpad | `launchpad-health` | `collectRecovery` health socket, `answer` normal/recovery/none/unexpected | `fail launchpad-recovery-mode`, `launchpad-not-answering`, `launchpad-version-mismatch` |
| machine | `machine-entry` | the recorded binding's `entry` on a hosted preset | `warn entry-not-recorded`; `skipped not-hosted` |
| machine | `codex-app-server` | `observeCodexAppServer` ([F29](decisions.md#f29--entry-units-of-a-remote-environment-the-launchpad-t3-code-and-the-operators-codex-app-server)): `systemctl --user show` of `lazurio-codex-app-server.service`, then, when it is active, `codex app-server daemon version` from `~/.local/bin/codex` (10 s, PATH and HOME only); never `fail`, never in `recover` | `ok` when active and Codex answers `running`; `warn daemon-not-running`, `warn daemon-state-unknown`, `warn unit-failed`, `unit-inactive`, `unit-not-loaded` (the next step is `systemctl --user start lazurio-codex-app-server.service`, or `lazurio install --service systemd-user --folder <Folder>` when the unit is missing); `skipped no-user-manager`, `not-supervised`, `not-hosted`, `codex-missing`, `user-manager-unreachable`, `unit-state-unknown` |

**C.2 step 4.** The apply reads `lazurio doctor --json` and stops on any `fail`; for
modules it keeps reading `lazurio module list --json`, since only the apply knows which
modules ran under the resident. A module that is not executable is `warn` here because
doctor does not know that.

**Not in this slice.** The Launchpad surface `/settings/diagnostics` (B9) and child
doctors of Organizations or modules.

**Verification 2026-09-28.** `tests/doctor.test.ts` against a temporary install base,
HOME and Folder with stand-in tools on a temporary PATH: a healthy fixture `ok` with
nothing written, a pending transaction `broken`, a missing required tool `fail` and a
missing recommended one `warn`, a module with an invalid default app and an unreadable
Organization under a non-identifier name `warn`, the hosted binding against the same, a
rewritten and a foreign handover and none, Recovery mode on the health socket, a
verified newer release in Czech, usage, and the source CLI in a child process. Every
JSON answer is checked against the tier-1 rules (ids, reasons, context rules, no string
that is not an identifier, no path of the fixture) and every human answer row by row
against the JSON.

## Gateway `ensure`

Slice P6 of the Launchpad parity (shaping `docs/launchpad-parity.md` B5, F22 point 3).
On a hosted Machine a browser that opens a module's hostname reaches the Machines
gateway, which asks the Launchpad to make the module's default app run and proxies the
browser to the module's port only when the answer is 204. The Launchpad answers from the
same core as `lazurio module start|status` (`ensure` in
`src/modules/module-operations.ts`); there is no new command, and `lazurio module status`
shows what an `ensure` started.

**The request, as the gateway makes it.** Taken from Machines
`workloads/workspace-vm/ingress.ts:113-159` (`moduleReadiness`, at `ab84f38`): one
bodyless `GET /api/internal/hosted/modules/<id>/ensure` (an empty query) to the
Launchpad's loopback port, `<id>` the exact `lazurio.module.v1` id the gateway catalog
read from the module's manifest (`gateway-catalog.py:139-148`, `:235`), with `Origin`
the Launchpad's external origin, `Sec-Fetch-Site: same-origin`, only the session cookie
(and its chunks), the browser's own `Sec-Fetch-Mode` and `Sec-Fetch-Dest`, and no
`Authorization`, `DPoP`, `Connection`, `Upgrade` or `Sec-WebSocket-*`. No timeout and no
retry of its own: the gateway waits for the answer, and its "starting" page reloads the
browser every 2 s (`Refresh: 2`, `Retry-After: 2`). The route matches the resident's
(`R:launchpad/src/server.mjs:1377`) byte for byte; only `GET` is served (405 otherwise),
and only in hosted mode (a workstation Launchpad answers 404: it has no module
hostnames).

**Admission.** The hosted admission of `docs/hosted-entry.md`, with one addition taken
from the resident (`R:launchpad/src/request-trust-lib.mjs:72-83`): the internal
namespace `/api/internal/*` is a lifecycle mutation even on `GET`, so it always needs the
same-origin rule (`Sec-Fetch-Site: same-origin`, `Origin` equal to the entry's external
origin) on top of the entry's `Host` and the revalidated session cookie. The `Host` rule
is the one every route has: the entry's Launchpad hostname. The gateway after the switch
sends exactly that on this subrequest (launchpad-parity C.2 step 7, F22 point 3), while
keeping the browser's `Host` on the Launchpad route; a loopback `Host`, which today's
gateway sends because the resident required it (`ingress.ts:130`), is refused as
`host-mismatch`. One rule instead of a loopback exception for `/api/internal/*`
(variant A of B5) keeps a single admission: a process on the Machine that can reach the
loopback port gains nothing without the session cookie, and the browser never reaches
the namespace because the gateway answers 404 for it on every public hostname
(`ingress.ts:54-57`). No fragment token, no forwarded identity header.

**Which app.** The id must name a module of exactly one Organization of the catalog,
the Personalspace group counting as one (`personalspace` in `candidates`);
every group that lists it counts, runnable or not, because the gateway serves the
id at one hostname and routes it to one of their declared ports. Two or more:
`module-ambiguous` with every candidate's directory (the fix is `{organization}` in
Machines' origin template, launchpad-parity B4). Then the catalog's own rules, as for
`lazurio module`: a module that cannot run is refused with its catalog reason. Only the
module's default app (`default_app`) is ever started: `ensure` takes no `--app` and never
falls back to another declared app.

**Start or only report.** `Sec-Fetch-Mode: navigate` or absent is an Open: a stopped or
explicitly stopped app starts. Any other mode, or a `Sec-WebSocket-Key`, only reports: a
background fetch or a WebSocket reconnect never starts an app (the resident's
`hostedRequestMayStartApp`, `R:launchpad/src/hosted-readiness-lib.mjs:4-8`). A lifecycle
hint after admission, never an access decision.

**Timing.** Healthy now: 204 at once. Otherwise the start runs, and `ensure` waits for
the app to report healthy at most 20 s, reading the status every 250 ms (the resident's
`openHealthyWaitMs` and `openHealthyPollMs`, `R:lazurio/runtime/runtime-lib.mjs:44-45`);
still not healthy, it answers 503 and the start goes on. Requests that arrive while a
start of the same app is under way (the page's assets, the reloads of the "starting"
page) join that start instead of queueing more: a slow declared check runs once and its
refusal reaches every one of them. That is memory of the running process for the
duration of one start, not state.

**Answer.** The status is what the gateway reads (`ingress.ts:139-157`):

| Status | Body | Gateway shows | When |
|---|---|---|---|
| 204 | none | the app | the default app reports healthy |
| 503 | the `lazurio module status` answer with `operation: "ensure"` (`outcome: "start-pending"` while the start still runs) | "starting", reload in 2 s | not yet healthy; a report-only request to an app that does not run; `closing`, `coordination-busy` |
| 404 | `{kind: "blocked", operation: "ensure", reason, …}` | "not available here" | `module-unknown` (also for a string that is not a valid id, which is not echoed), the catalog reasons (`no-app`, `default-app-invalid`, `organization-not-executable`, …), `folder-unreadable` |
| 409 | `{kind: "blocked", operation: "ensure", reason: "module-ambiguous", candidates}`, or the start's or status read's refusal with `operation: "start"` or `"status"` (`toolchain-missing`, `prerequisites-not-ready`, `port-occupied`, …) | "could not be prepared" (502) | the id is ambiguous; the lifecycle refused |
| 401 | `{error: "denied", reason}` | "could not be prepared" (502) | admission refused |

Bodies carry no address: `runtime` is null unless the app is healthy, and a healthy
answer has no body. The resident answered 404 for an ambiguous id and 503 for every
failed start (the browser then reloaded forever); here the ambiguous id and a refused
start are 409, so the gateway's "could not be prepared" page says so once. `ensure`
starts through the same core as `lazurio module start`, so it installs what a start
installs: the frozen install from the lockfile, declared preparation or not, and for a
declared preparation whose check then fails its `prepare_script` (F25, F34); a module
whose check still fails after it answers `prerequisites-not-ready`.

**Verification 2026-09-28.** `tests/launchpad-ensure.test.ts` against the fixture Folder:
the gateway's exact subrequest (headers from `ingress.ts:124-138`, the M2 `Host`), each
header dropped or changed (loopback `Host`, module `Host`, no `Origin`, a module
`Origin`, no `Sec-Fetch-Site`, no or forged cookie: 401), browser routes unchanged;
unknown, invalid, app-less, invalid-default and ambiguous ids (nothing started, the
valid second app of the invalid-default module neither); on the Linux path with the
in-memory user manager a background fetch and a WebSocket reconnect only reporting, a
navigation starting the default app (204, empty body, one unit, `lazurio module status`
showing it with the entry's link), repeated requests never starting again, an explicitly
stopped app starting on the next navigation, `toolchain-missing` as 409 with
`operation: "start"`, a start still under way answering 503 `start-pending` and becoming
204, three concurrent navigations joining one failing slow check (one run, three 409
`prerequisites-not-ready`; since F34 after the start's install); on the session path a real synthetic app started by a
navigation, served on its declared port and ending with its Launchpad; and a
workstation Launchpad answering 404. `tests/launchpad-hosted-trust.test.ts` covers the
internal-namespace rule of the admission. A real gateway, Caddy and oauth2-proxy were
**not** exercised; that is C.5.

## Chat entry

Slice P7 of the Launchpad parity (shaping `docs/launchpad-parity.md` B8). On a hosted
Machine the sidebar starts with **Chat**, in T3 Code's "New thread" place: it opens this
Machine's T3 Code, as the resident's Chat button does today
(`R:launchpad/public/app.js:2257-2281`, `R:launchpad/src/t3-chat-lib.mjs`, decided in
root DEV-6616). In the [target shell](#target-shell) this link becomes **Chat** in the
switch Chat · Apps · Automate at the top of the left column; the Dashboard is not in the
switch, the rail's logo opens it.

**What the resident does, and what is kept.** The resident's button is hidden until
`GET /api/chat` says Chat is configured (only behind a gateway); a click posts
`/api/chat/pair`, the server runs T3's own `auth pairing create --base-dir ~/.t3 --ttl
60s --label launchpad-chat --json`, reads `credential` from its output and answers
`<T3 origin>/pair#token=<credential>`, and the page follows it in the same tab. No thread
is created and no Organization, module or worktree is passed: T3 Code opens at its home,
paired. All of that is kept, with two changes of source: T3 Code's origin is the recorded
entry's `t3codeOrigin` (never the resident unit's `LAZURIO_T3CODE_URL`, never composed),
and the program is the T3 launcher `t3` on this Launchpad's PATH (Machines DEV-6624's
`~/.local/bin/t3`, the parity design) instead of the unit's
`LAZURIO_T3CODE_PAIRING_COMMAND`. Its environment is exactly `HOME` and `PATH`; the
output is never passed on, logged or put in an error, and nothing is recorded.

**Routes.** Behind the admission every other route has (the gateway's session cookie
hosted, the fragment token locally):

| Route | Answer |
|---|---|
| `GET /api/entry` | `{kind: "entry", entry: {launchpadOrigin, t3codeOrigin, moduleOriginTemplate, mausbotOrigin?} \| null}`: the recorded entry's public parts, read-only; the auth endpoint, cookie name and port stay on the server. `null` on a workstation. Any other method: 405. Recovery mode answers it too. |
| `POST /api/chat/pair` (body `{}`) | `{kind: "chat-link", url}` with `url` = `<t3codeOrigin>/pair#token=…`; `409 {kind: "blocked", reason}` with `t3-launcher-missing` (no `t3` on PATH, nothing run) or `t3-pairing-failed` (a non-zero exit, a timeout of 15 s, output that is not JSON or a credential of another shape); `404` on a workstation. Same-origin rule of every state-changing request. Not in Recovery mode (its typed refusal). |
| `GET /api/chat/prompt-handoff` | `{kind: "chat-prompt-handoff", accepted}`: whether Chat on this Environment takes a prepared prompt by link ([prompt hand-off](#prompt-hand-off-to-chat)); `accepted: false` on a workstation without running anything. Any other method: 405. |

**CLI.** `lazurio chat link [--folder <absolute Folder>] [--plain] [--json]`
(`src/launchpad/chat-cli.ts`) is the same entry for an agent in a terminal: it reads the
Folder's recorded entry as the Launchpad start does (`readStartState`, without the lock,
so it writes nothing), found as for `lazurio doctor` (`--folder`, the supervised unit's,
or on a hosted Machine the declared operator's), and answers from the same
`issueChatLink` with the same tools environment (`toolsEnvironmentOf`, this process's
`PATH` and `HOME`), through `chatLinkAnswer` in `src/launchpad/chat.ts`. With a pairing
the link `<t3codeOrigin>/pair#token=…` alone is on stdout, for the operator's browser;
without one, on `t3-launcher-missing`, `t3-pairing-failed` or with `--plain`
(`plain-requested`), stdout carries the plain `t3codeOrigin`, where T3 Code asks the
browser to pair, and stderr one sentence naming the reason, in the Folder's language.
Without a recorded entry (`not-hosted`) there is no link: exit 10 and the sentence on
stderr. `--json` prints `{kind: "chat-link", url, pairing, reason?}` (`url: null` when
not hosted). Stderr never carries the token. Exit status: 0 a link (paired or plain), 10
not hosted, 2 usage, 1 the Folder could not be read (its enumerated start refusal, never
a path). The generated manual tells agents on a hosted Machine to hand this link to the
operator, never a localhost one (base-instructions-13).

**Page.** `src/launchpad/chat-view.ts` (pure, tested) accepts the entry only in the
recorded shapes and a pairing link only on the recorded T3 Code origin, path `/pair`, no
query, a `token` fragment. The Chat link's `href` is `t3codeOrigin` itself, so a modified
click (a new tab) opens T3 Code as a link does. A plain click asks for a pairing link and
follows it in this tab, as the resident did; when there is none (no launcher, a refused
call) it follows the plain origin, where T3 Code itself asks a browser it does not know
to pair. Without an entry (a workstation) the entry is absent, as the resident's button:
T3 Code runs wherever the operator runs it (launchpad-parity D). The **Recovery page**
(Settings → Recovery, and Recovery mode) shows **Open T3 Code** next to **Copy the
prompt** when there is a prompt and an entry: the same origin, a plain link in a new tab
(`docs/recovery-mode.md` C.3, first slice), never a pairing call, because Recovery mode
changes nothing. The module page has no link of its own: the resident had none, T3 Code
cannot start a thread about a module from outside yet (C.3), and the sidebar's Chat
stands on the module page as on every route.

**Deviations from the resident.** The launcher comes from PATH, not from the unit's
environment; without it Chat stays visible and opens the plain origin instead of hiding
(the resident's button was either configured or hidden; here the entry decides whether
there is a T3 Code, the launcher only whether the browser is paired on the way). A
refused pairing answers 409 with a reason instead of 502 with the resident's
`t3_pairing_*` codes, as every blocked Platform answer. `lazurio chat link` came in a
follow-up of the slice (above).

**Verification 2026-09-28.** `tests/launchpad-chat.test.ts`: a hosted Folder from the
handover fixture behind a fake auth endpoint (`/api/entry` 401 without the cookie, the
public parts byte for byte with the auth values absent, 405 for `POST`), a fake launcher
on a private PATH (missing: nothing run; 401 without same-origin; the resident's exact
arguments, `HOME` and `PATH` only, the pair URL on the recorded origin; a failing call
whose stderr holds the credential, non-JSON output and a short credential: one reason,
the credential absent from the answer; nothing written in the home), a workstation
(`entry: null` behind the token, no pairing route, nothing run), the page's parsers, the
markup (hidden, outside every view) and a scan that no source under `src/launchpad`
builds an origin or hostname from labels. `tests/launchpad-recovery-page.test.ts`: Recovery
mode answers `/api/entry` behind the admission and refuses the pairing route;
`tests/recovery-view.test.ts`: the Recovery page's link. Driven in headless Chromium on
macOS against a workstation Launchpad, with `/api/entry` and `/api/chat/pair` stubbed
for the hosted case: absent on the workstation; `href` the recorded origin on the home,
Settings and the Recovery page; a click landing on the pair URL, and on the plain origin
when the pairing is refused. A real gateway, a real T3 Code and the launcher of
DEV-6624 were **not** exercised; that is C.5 items 10 and 14.
`tests/chat-link-cli.test.ts` (the CLI): a hosted Folder from the handover fixture with a
fake launcher on a private PATH (the pairing link on the recorded origin, the resident's
exact arguments, human and `--json` answering the same link, nothing written in the
home), the launcher missing (the plain origin with `t3-launcher-missing`, nothing run), a
failing call whose stderr holds the credential (`t3-pairing-failed`, the credential in
neither stream), `--plain` (nothing run), a workstation Folder and no Folder (exit 10,
`not-hosted`), usage and an unreadable Folder, and the real command line in a child
process with `HOME`, `PATH` and XDG in temporary directories (the link alone on stdout,
no token on stderr).

## Lazurio MausBot entry

DEV-6632 (decision 0169). On a Machine that runs Lazurio MausBot, the Environment's
bot-team app (Lazurio's fork of OpenMausBot), the sidebar shows **Lazurio MausBot** next
to Chat and enters it the same way: the Launchpad runs as the same Machine user as
MausBot, mints a one-time pairing code and opens MausBot's pairing form with that code
already filled in, so the operator never types or copies a code. OpenMausBot's `/pair`
page only prefills the code from the fragment: one **Connect** click pairs the browser
and lands in the app. A browser that is already paired sees "This browser is already
connected" with **Open the app** instead, and the minted code expires unused after about
five minutes. Submitting the form by itself would be a small fork change of `/pair`,
deliberately left for later (the Organization Admin prefers the fork changed as little
as possible). The old resident Launchpad has no such entry; this one replaces it there.
In the [target shell](#target-shell) it is **Automate** in the switch, and we call the
app MausBot: the fork keeps OpenMausBot's upstream look and branding until upstream's
stable releases.

**Source.** Only the recorded entry: `mausbotOrigin` and `mausbotListenPort`, projected
from the handover's optional `entry.mausbot`
([projection](machine-handover.md#the-hosted-entry-decision-f16)). Without them there is
no MausBot on this Machine: no link and no route. The preset's `mausbot` surface does
not decide it; the handover does.

**Pairing.** OpenMausBot's own API, unchanged: `POST
http://127.0.0.1:<mausbotListenPort>/api/auth/pairing` with `{"label": "launchpad"}`.
A loopback request without forwarded headers or `Origin` is OpenMausBot's owner, exactly
what `openmausbot pair` on the Machine does; the external origin is never called. A 200
with `code` of the pairing shape (`XXXX-XXXX-XXXX`, single use, about five minutes) answers
`<mausbotOrigin>/pair#code=<code>`, OpenMausBot's own pairing link. The code is never
logged, never in an error and never in a query; the other values of OpenMausBot's answer
(its credential, invite) are not read or passed on, and nothing is recorded. A server
that treats loopback as a service (`OMB_LOOPBACK_TRUST=service`, a hosted OpenMausBot
workspace) refuses with 403; that is `mausbot-pairing-failed`, and the page opens the
plain origin, where MausBot asks for a code.

| Route | Answer |
|---|---|
| `GET /api/entry` | as for Chat, plus `mausbotOrigin` only when recorded; the loopback port stays on the server |
| `POST /api/mausbot/pair` (body `{}`) | `{kind: "mausbot-link", url}` with `url` = `<mausbotOrigin>/pair#code=…`; `409 {kind: "blocked", reason}` with `mausbot-unreachable` (no answer on the loopback port within 10 s) or `mausbot-pairing-failed` (any status but 200, a redirect, an answer that is not JSON or a code of another shape); `404` without a recorded MausBot (a workstation, or a Machine without it). Same-origin rule of every state-changing request. Not in Recovery mode (its typed refusal). |

**Page.** `mausbotHref` and `mausbotPairLink` in `src/launchpad/chat-view.ts` accept the
origin only in the recorded shape and a pairing link only on it, path `/pair`, no query, a
`code` fragment. The link's `href` is `mausbotOrigin` itself; a plain click asks for a
pairing link and follows it in this tab, to the pairing form with the code filled in, or
the plain origin when there is none, as Chat does. There is no CLI of its own yet.

**Verification.** `tests/launchpad-mausbot.test.ts`: the handover member on both branches
and its refusals, the binding projection (both fields or neither, an older entry byte for
byte), the pairing call against a fake OpenMausBot on loopback (the exact request, loopback
`Host`, no `Origin` or forwarded headers; 403, 500, a redirect, non-JSON, `null`, no
code, a code of another shape, a slow answer, nothing listening; the code absent from
every refusal), the hosted routes behind the admission, and the page's parsers and markup.
A real gateway and a real Lazurio MausBot were **not** exercised: the handover member
waits for the Machines release that writes it.

## Tools section

The page has a section "Tools" / "Nástroje" (decision F18,
[environment-tools.md](environment-tools.md)). It reads `POST /api/tools/status` when
the profile is loaded (with `signIn: true`, so the sign-in probes run), after every
change (without them; the last known sign-ins stay on the cards) and on "Refresh
status" (with them again), and shows:

- a short introduction: what tools are, that "Used by agents" guides the agents on this
  Environment to use a tool, and that installing, uninstalling, signing in and signing
  out are separate acts (Matěj's wording, 2026-09-28; said once per page, not
  on every row);
- on a shared Environment (the Team preset) the warning that signed-in accounts are
  shared by all operators; it is repeated in the confirmation of an enable;
- three groups, **Required**, **Recommended** and **Optional**, in catalog order, each
  a settings group of rows. A row carries on the left the tool's name, its one-line
  purpose and one status line (installed version or "not installed", then the
  sign-in), a failed version check below it, and on the right the one action
  ("Install and sign in", "Sign in", "Link SSH key" before "Sign out", "Sign out" or,
  for a tool an agent sets up, "Set up with an agent") and the switch with its visible
  label "Used by agents" / "Používají agenti" ("Always on" for a required tool). The sign-in reads: "Signed in as <account>" (with the
  organization for composio), "Signed in", "Not signed in", "Sign-in unknown" or
  "Sign-in not checked"; for gh the line goes on with "· SSH key linked", "· SSH key
  not linked" (in the warning colour) or "· SSH key not verified" (F19 addendum
  2026-09-28), and a signed-in gh whose key is not linked shows "Link SSH key" as the
  row's primary action. On a Team Environment (the preset `hosted-organization-team`,
  the shared case) the gh row has no "Sign in" or "Link SSH key", and "Install" instead
  of "Install and sign in" while gh is missing (its notice ends with the Team
  sentence); a subdued sentence says that this Team Environment works in GitHub through
  Lazurio for GitHub, set up by the Organization, and that personal GitHub accounts are
  not signed in here (Matěj 2026-09-28). Its sign-in line stays, in the neutral
  colour, reads "Works as lazurio-for-github[bot]" when gh works as the Organization's
  App identity (the brokered gh), and goes on with "· Uses Lazurio for GitHub" instead
  of the state of an SSH key. The agent fallback in Details hands gh's Team prompt,
  which signs nobody in. "Sign
  out" appears there only while a person's account is signed in (gh's `signIn.identity`
  is `person`, a left-over of the ended exception), never for the Organization's
  identity; the page decides with the same rule the server enforces
  (`src/tools/team-github.ts`, [environment tools](environment-tools.md#gh-on-a-team-environment)),
  and a refused sign-out reads the same sentence with the reason. composio and wacli
  keep their actions there, with the shared sign-ins warning;
  Only on a hosted Machine (`hosted`) does a PATH entry outside `~/.local/bin` add a
  note and the amber attention state; on a local workstation any tool on PATH is fine;
- behind "Details" the path where the tool was found, "What agents are told" (the
  catalog usage text, read-only), the official source, for a `launchpad` tool the
  "Set up with an agent" fallback, and, for a required or enabled tool, a text area "Your note for agents" with
  a character counter and "Save note" / "Clear note"; a disabled optional tool says
  that a note can be added after enabling it. The counter and the checks use the rules
  of the Folder state (`src/tools/note.ts`), so a note the server would refuse cannot
  be saved; what was typed and not saved survives a re-render;
- a card "Connect another app through an MCP server" with the generic prepared prompt.
  MCP servers are never recorded in the Folder, so this card enables nothing.

**Enable, disable and notes** take one click (the switch is a `role="switch"` button
named "Used by agents: <tool>" with `aria-checked`, so its name holds the visible
label and the tool). The button sends the full next
selection (and, for a note, the full next set of notes) with the shown revision to
`/api/tools/update`; the page no longer uses `/api/tools/preview`, which stays for
other clients. After a recorded change the card confirms politely what happened, that
the agent instructions of this Folder were rewritten and the new Folder revision, with
an "Undo" that sends the state before the change at that new revision and takes the
focus once the page has read the new state; enabling a tool
that is not installed says so, and on the Team preset the shared sign-ins warning
follows an enable. The whole page then reloads its state, so the revision advances
for the profile form as well and a profile preview made before the change is dropped.
A `blocked` answer becomes one sentence in the card (`stale-revision`, `drift` with its
path, `incomplete-state`; any other reason is named by its code) with a "Reload"
button; an answer that cannot be read is reported as unconfirmed, never as refused. A
required tool has no toggle and shows "Always on"; it can carry a note.

**Set up with an agent** opens a modal `<dialog>` with the prepared prompt in a
read-only text area and "Copy prompt" (Clipboard API; where it is unavailable the text
is selected for a keyboard copy). The prompt contains no secret, and the operator
pastes it into a new chat in T3 Code on the Machine. Focus moves into the dialog and
returns to the button that opened it (opening its "Details" again when the button sits
there). Every activatable tool has this button.

**Install and sign in, Sign in, Sign out** (decision F19,
[environment-tools.md](environment-tools.md#curated-installation-and-login-decision-f19)).
A `launchpad` tool shows "Install and sign in" when it is missing, "Sign in" when it
is installed and not known to be signed in, and "Sign out" when it is signed in; an
`agent` tool shows none of them. The first two open a second dialog: its title names
the tool, a list of plain steps ("Installing", "Waiting for you", "Signed in", each
marked done, in progress, next or did not finish) and a status line with
`aria-live`; focus moves to the title. On a shared Environment the shared sign-ins
warning and "Continue" come first. The dialog then installs (`/api/tools/install`) when
needed and starts the login (`/api/tools/login/start`), and polls
`/api/tools/login/poll` every 2 seconds with the session handle while it is open;
closing it sends `/api/tools/login/cancel`, clears the code, link or QR from the page
and returns focus to the card. Until the tool shows something to act on, the status
line says "Starting the sign-in…" and the body, never the same sentence, says that
Lazurio waits for the tool's first step and for at most a minute (#98). A request that
gets no answer within 45 seconds ends the dialog with "The Launchpad did not answer in
time", and a sign-in that ends as `not-installed`, `spawn-failed`, `tool-exit`,
`not-confirmed` or `no-challenge` shows a sentence that says what to do. A tool that was signed in
before (`signed-in` with `already: true`) is reported as "already signed in" and the
card's state is read again. What it shows:

- gh: the sentence that the code is entered on any device, the code in large
  selectable characters (with a spelled-out accessible name) and a link to
  `https://github.com/login/device` in a new tab;
- composio: a link to the sign-in page in a new tab; after the sign-in a select of the
  account's organizations with the current one marked "(current)", which switches on
  change, and the hint that the apps connected in Composio belong to that account and
  organization, the account of the Environment;
- wacli: the path in WhatsApp in words, the QR code as an image of the server's SVG
  (280 CSS px, white, quiet zone, `image-rendering: pixelated`, a text alternative that
  says what to do), replaced in place when the code rotates, and "Pair with a phone
  number instead" (a phone field, then the pairing code in large characters and "Show
  the QR code instead"). After pairing, the note that the first sync runs in the
  background.

**gh and its SSH key** (F19 addendum 2026-09-28). The gh dialog has a third step,
"Linking the SSH key", between "Waiting for you" and "Signed in": after the code is
entered, the status line says that Lazurio links the SSH key of this Machine and checks
git over SSH. A linked key ends the dialog with "The SSH key of this Machine is linked:
git clone git@github.com:… works as <account>" and whether the key was created now
(without a passphrase, so agents can use it) or an existing one is used unchanged, with
its path and fingerprint. A key that is not linked marks the step "did not finish" and
says, in one sentence each, that gh is signed in but git over SSH does not work yet and
why (a passphrase on the existing key, the key in use by another account, a differing
github.com host key, a failing proof, …), with "Finish with an agent" and "Try again",
which links the key only. A signed-in gh whose key is not linked or not verified shows
"Link SSH key" on its card: the same dialog with the steps "Linking the SSH key" and
"SSH key linked", and "Waiting for you" first with a device code only when the gh
sign-in may not manage SSH keys yet (the code widens the sign-in, the text says so).
"Sign out" of gh also says what happened to the key on the account: removed, kept
because Lazurio did not register it, or possibly still registered with where to remove
it.

The page accepts a login answer only in its exact form: a link only as https on the
expected host, a code only in its expected shape, the QR only as the exact SVG the
server draws (turned into a `data:` image, never inserted as markup). A failure shows
its reason, "Finish with an agent" (which opens the prepared prompt) where an agent is
the next step, and "Try again". After a sign-in the card's sign-in line is refreshed
with the probes. "Sign out" runs `/api/tools/logout` and confirms on the card whether
the tool forgot the sign-in on this Machine only (gh, composio) or unlinked the device
(wacli). An SSH outcome is taken only in its exact form (known reasons, a `SHA256:`
fingerprint, no key content).

Pure view logic lives in `src/launchpad/tools-view.ts` and is tested without a
DOM (`tests/tools-view.test.ts`); `src/launchpad/tools-panel.ts` holds the DOM and
renders every server and tool value with `textContent`. HTTP behavior is tested in
`tests/launchpad-tools.test.ts` and `tests/launchpad-curated.test.ts` with fake tools
on a private PATH, a temporary home and a fake official source. On 2026-09-28 the Settings layout was driven in headless Chromium (Playwright) against
a temporary Folder, fake tools on a private PATH and a temporary home: routes, deep
links, back/forward, Escape, focus after navigation, the narrow sheet, the gh dialog
(focus to its title, Escape, focus back to the row), enable with Undo and a Czech
round trip, light and dark, without page errors; the update pill and the shared
Environment were shown by intercepting their answers in the browser. Screen-reader
output and the clipboard path have not been qualified by a recorded manual run.

## Files page

The page has a section "Files" / "Soubory" (decision
[F35](decisions.md#f35--files-the-operators-documents-through-the-launchpad)): the
Documents folder of the account the Launchpad runs as. Its routes are `/files` (the
folder itself) and `/files/<name>/<name>` (a folder below it), each name
percent-encoded; they are page routes like the catalog's, served by the same bundled
page locally (`pagePaths` holds `/files` and `/files/*`) and, behind a gateway, after the
admission, where a path that names a regular file is its download instead
([hosted entry](hosted-entry.md#files-links-decision-f34)). The page reads its route
with the same path rules as the server (`src/files/rules.ts`); a path they refuse opens
the Documents folder itself, and the server checks every path again on its platform.

The Files entry stands in the sidebar on every route, below Chat and outside the view
navigations; on the Files page the sidebar keeps the catalog's Organizations
(`data-view="catalog files"`), and the header's page action is "Refresh". The view
shows:

- the introduction (what the folder is) and, on a Team Environment, the note that the
  whole Team sees and changes the same folder;
- the path as links, "Documents" / "Dokumenty" first, the current folder last
  (`aria-current="page"`);
- "Upload files" (a file picker, several at once) and "Download folder (ZIP)";
- the list, folders first, then names as people read them: an icon, the name (a folder
  is a route, a file its download), the size in decimal units or "Folder", the
  modification time in the reader's language and time zone, and "Download" (named
  "Download <name>" for assistive technology). Below 36 rem of the list's width a row
  stacks its size and date under its name and the column names are hidden;
- an empty folder says so; the empty Documents folder says what it is for; a missing or
  refused path says the folder or file does not exist and links to Documents; a file
  path (locally) says it is a file, with Download and a link to its folder.

**Downloads.** Behind a gateway every download is a plain link (`/files/<path>`, the
link `lazurio files link` prints, and `/api/files/zip?path=`) that the session cookie
admits and the browser saves itself, resumable and of any size. Locally a link cannot
carry the session token, so a plain click fetches `/api/files/download` or
`/api/files/zip` with it and saves the result through an object URL; a modified click
opens the address as a link does.

**Uploads.** A drop anywhere on the page, or the picker, queues the files for the folder
shown; a dropped folder is skipped and said so. One file at a time goes to
`POST /api/files/upload` (XMLHttpRequest for its upload progress, the session token
locally, the same origin and cookie behind a gateway), each with its row: name, a
progress bar, the state ("Waiting", "Uploading, 45%", "Uploaded", "Uploaded as
report (2).docx", or why not) and Cancel while it waits or runs. The folder shown is read
again after each upload into it; a finished upload is read out once in a screen-reader-only
live region. A 401 behind a gateway re-enters through the sign-in.

**CLI.** `lazurio files link <path> [--folder <absolute Folder>] [--json]` prints the
link of a file or folder in `~/Documents` with the same rules and Documents adapter:
`<Launchpad origin>/files/<path>` where the Folder records an entry, the absolute path
otherwise; a path outside `~/Documents`, hidden or missing is refused with exit 2
(`tests/files-link-cli.test.ts`). Agents hand that link over (F35 point 8).

Pure view logic lives in `src/launchpad/files-view.ts` and is tested without a DOM
(`tests/files-view.test.ts`); `src/launchpad/files-panel.ts` holds the DOM and renders
every server value with `textContent`. HTTP behavior is tested in
`tests/launchpad-files.test.ts` against a temporary home, locally and behind a fake auth
endpoint. On 2026-10-03 the page was driven in headless Chrome (Playwright, the installed
Chrome) against a temporary Folder and home: the Documents folder, a task folder, an
upload with its progress and a taken name, the drop overlay, an empty and a missing
folder, light and dark, a 390 px wide screen with its sheet, and Czech, without page
errors.
