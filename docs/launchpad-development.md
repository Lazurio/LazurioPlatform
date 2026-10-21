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
Before state is available the page stays hidden, at most a second, and a hosted page
is served in the Folder's language ([first paint](#the-shell-as-built-decision-f36));
should the profile not be read, the page is in English.

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
next to it, the rail's hairline between them ([F36's addendum of
2026-10-17](decisions.md#f36-addendum-of-2026-10-17-the-rails-edge-toward-the-app)). At the very
top of the left column is the app's band, as tall as a page's header (52 px): the toggle
that hides the column, then the app's name, which each app draws itself (Apps, Settings
and the Dashboard the Lazurio lockup, Chat T3 Code with the Lazurio badge, Automate
MausBot; [F36's addendum of 2026-10-17
(2)](decisions.md#f36-addendum-of-2026-10-17-2-the-band-on-top-of-the-launchpads-column)).
Under it sits the column head: the Environment picker
with the Settings gear beside it, and under them the app switch **Chat · Apps ·
Automate**. Chat is T3 Code (`t3code.…`), Apps is this Launchpad (`launchpad.…`) and
Automate is MausBot (`mausbot.…`). Each is its own origin of the Environment, so the
switch, the picker's entries and the rail are plain links that load a full page. The
Dashboard is not in the switch; the Lazurio logo at the top of the rail opens it.

**Rail.** The rail switches spaces, not Environments. From the top: the Lazurio logo
(the Dashboard), the search button that opens the jump dialog (**⌘⇧E**, Ctrl+Shift+E on
Windows and Linux; not ⌘K, which T3 Code uses for its own command palette), the personal
space (its Owner's initials) when the user has an Environment there, one GitHub avatar
per Organization, and "+" to add an Organization when the document names an address for
it (none for now: F36's addendum of 2026-10-16). At the bottom there is only the account, shown as the user's GitHub
photo. There are no Environment icons, no Organization folders and no "+N"/"méně": a
kind icon looks the same in every Organization and a wrong click is easy, while an
Organization's avatar is recognised at a glance. The avatar is the GitHub
Organization's, cached by the Dashboard on each GitHub sync and changed only on GitHub.
The active space has the design system's selected look (B3, design-system-lazurio#57):
the quiet surface around its avatar with a hairline; no ring, no pill on the edge and no
fill in the Organization's colour. The rail is one step of the grid wide (64 px): every
item is 40 px around a 32 px mark with concentric corners, an item under the pointer
brings the quiet surface and keeps its shape, and the personal space is a white monogram
with a hairline, never an ink block (prototypes-lazurio #11). The tooltip shows the
space's name alone, as every label of the rail (F36's addendum of 2026-10-16). Clicking an
Organization returns to the Environment last used in it, in the same app (Chat stays
Chat); without a remembered one it opens the Organization's first Environment, and with
no Environment at all the Organization's Dashboard. The personal space opens the
personal Remote Environment, or the last personal Environment used. Dedicated servers
are never Environments and appear neither in the rail nor in the picker; they belong to
the Organization Settings (Owner only).

**Column head: the Environment picker.** Above Chat · Apps · Automate the picker names
the Environment: its name, below it whom it serves, and the Organization's avatar as its
glyph. Its dropdown lists the Environments of the current space, one line each: a small
glyph, the name and, quieter beside it, whom it serves. It never leads to the
Organization's Dashboard, which is never one more row beside the Environments: the
Organization's name in the page's head opens it (in Apps), as do ⌘⇧E and the personal
Dashboard's Organizations (prototypes-lazurio #17). "This computer", a workstation that
carries several Organizations, appears in every Organization it carries and opens for
that Organization, so the Organization is part of the address of every app (in the
wireframe `#/e/<env>/<app>/o-<org>`). "Všechny Organizace" (all Organizations), the only
thing at the dropdown's foot, widens the list. A search field appears only past seven
Environments and once widened; ↑↓, Home, End and Enter work with or without it. The
dropdown overlays the column only while it is open, so a fork's sidebar keeps its
content. ⌘⇧E stays the global jump dialog, with the Organizations' heads. On an
Organization's Dashboard the picker names the Organization, and the column has no second
Organization block under it.

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
in a list a check, whose word ("tady jsi", you are here) only screen readers hear
(design-system-lazurio#62). The picker has no frame until
it is hovered or open. Nothing is selected by an edge on the left: in the design system
that is `lz-edge`, "something to resolve". The Organization's colour stays in its avatar
and never marks the active element. Nothing in the page's flow has a drop shadow; only a
layer floating above the page (a menu, the list under the picker, the ⌘⇧E dialog, a
label) has the one shadow and a hairline (design-system-lazurio#59). There are no
all-caps labels.
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
something the user acts on. Nothing is grouped or labelled by Team: the point is
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

- **Landing.** After sign-in, and when Lazurio is opened without an address, the user
  lands in Apps of the Environment they had open last, in its Organization; the first
  time, in the first Environment of the first Organization. The Lazurio logo still
  opens the Dashboard. The Dashboard account remembers the last Environment, because
  every Environment has its own address.
- **Header.** The Organization's name, and under it the Environment's name with its
  kind icon. The Organization's name is a link to its Dashboard, underlined only under
  the pointer (prototypes-lazurio #17); the personal space's "Osobní" is not. It never
  says "sdílený Teamem"; it says "offline" only when the Environment is not running.
  The Guide is only the link at the top right; there is no Guide tile. On a computer
  with several Organizations the Organization comes from the address, chosen in the
  rail or the column head's picker, so the home needs no Organization picker of its
  own.
- **Column.** Under the column head the Apps column holds only Všechny moduly (all
  modules), Soubory (Files, decision F35), Integrace (decision F42), Trezor (the vault,
  [below](#vault-apps--trezor); only where the Environment has a vault), Oblíbené (the
  favourites, pinned) and, at its bottom, the Marketplace. There is no module list (its
  rows led to technical details and confused users) and no search.
- **Marketplace.** The entry is in the Apps column of every Environment. For now it
  says "již brzy" (coming soon) and opens a placeholder page; it is not the
  [future marketplace](marketplace.md).
- **Favourites.** Set from a module's "⋯" menu ("Přidat do oblíbených" / "Odebrat z
  oblíbených"). They are pinned in the column, where a favourite opens its app
  directly. On the home a starred module comes first in its section, in the column's
  order, with a small filled star by its name. Favourites belong to the user and the
  Organization (the Dashboard account), so they follow the user to every Environment
  of that Organization; an Environment shows only those its GitHub identity can reach.
- **A clean tile.** Icon, name, short description, the favourite star and "⋯", which
  sits top right, always visible but quiet. No state line (Běží / Skončila sama / Nelze
  spustit), no running dot, no new-tab arrow, no explanatory tail ("otevře složku
  Modulu", "vlastní release, jen pro čtení") and no Productionspace subtitle. A work
  branch on a tile stays.
- **A tile's click.** A module with an app opens it where the user's account setting
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
  reaches the module, other roles see it read-only, and the page lists the users who
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
  they get the tile only if their identity really has that capability. The personal
  space has its own "+ Nový modul" for its verified holder, which founds the user's
  own module ([below](#personal-new-module)). #154 builds
  this as the Owner check of F36's Organization-rail addendum, point 8. Before the
  Organization's first module, such an identity still sees Workspace ("zatím žádné
  moduly") with the tile as its only tile, not the sentence that sends a user
  without modules to the Admin (#376). Once
  founding a Module in the Dashboard is done (plan DEV-6634), "+ Nový modul" leads there
  instead of to Chat (Matěj, 2026-10-04). The
  T3 Code fork accepts the prompt by link, from the Environment's own origin only and
  never sent without the user (Lazurio/t3code#35): the link carries only the prompt's
  id and the Organization's GitHub login, and the fork fetches the text from
  `/.lazurio/prompts/<id>` on its own origin ([prompt hand-off](#prompt-hand-off-to-chat)).

**Buddy.** Buddy is Buddy: he coordinates Agents on behalf of his user
and holds the same authority over Agents as the user; he is neither an Agent nor an
app. The user stays the human. In the shell Buddy is not a fourth mode of the
switch and not a tab, but a floating chat bottom-right on every screen, an iframe served
by the user's personal Environment and embedded in the Dashboard, the Launchpad,
module apps and both forks. The chat is one endless thread with Buddy, who runs on
Hermes Agent. Buddy knows the context the user asks from (Environment, app, module) as a
chip the user can remove, and he accepts images and files, which go straight to the
personal Environment; the host app never sees them. Buddy looking into an
Organization's Environment is intended: he knows that what he sees there is the
Organization's data and keeps it apart from the Personalspace memory and from other
Organizations. The window signs in with the Lazurio account (OAuth through
`auth.lazurio.ai`, a partitioned cookie); the host app passes no token. If that sign-in
cannot work in Safari or Firefox, Buddy's window is supported in Chrome only. A user
without a Buddy sees no bubble.

**The forks and `/.lazurio/`.** Chat (`Lazurio/t3code`) and Automate
(`Lazurio/OpenMausBot`) keep their upstream look and branding until upstream's stable
releases, and we keep calling them T3 Code and MausBot. *(Root decision 0200 changes
this for Chat: the distribution "Lazurio T3 Code" keeps T3 Code's mark and takes the
design system's light look on an Environment from the tokens the shell declares, F36's
addendum of 2026-10-13. Automate is unchanged.)* A fork adds only the rail, the
column head at the top of its own sidebar (the only slot it adds to that sidebar) and
the Buddy bubble, and knows nothing of Lazurio's data:

- Behind the Environment's gateway every app hostname of the Environment
  (`launchpad.…`, `t3code.…`, `mausbot.…`) serves the path `/.lazurio/`, answered by
  this Launchpad. `/.lazurio/shell.js` is the script with the elements, in the version of
  the Launchpad on that Environment; `/.lazurio/shell.json` holds the signed-in user
  with their GitHub photo, the spaces (the personal space and the Organizations with
  their avatars), their Environments with their names and whom they serve, the last
  Environment used in each space (the Dashboard account remembers it; the Launchpad
  takes all of this from the Dashboard), the current Environment and the addresses of
  its apps. The second iteration needs no Organization accent: the Organization's colour
  stays in its avatar. Same origin: no CORS and no cookie of another site.
- `shell.js` defines three Web Components with Shadow DOM, so neither side's CSS reaches
  the other: `<lazurio-rail>` (the logo to the Dashboard, the search for the ⌘⇧E jump,
  the personal space when it holds an Environment, one avatar per Organization, "+" when
  the document names it, the account),
  `<lazurio-column-head>` (the Environment picker with the Settings gear, over the app
  switch, in place of the fork's logo at the top of its sidebar) and `<lazurio-buddy>`
  (the bubble; since [F56](decisions.md#f56--průvodce-buddy-nebo-průvodce-lazuria-vysvětlí-stránku-na-místě-kreslí-shell-hostitele-rám-buddyho-smí-jen-požádat-id)
  the place where the guide draws, [below](#the-guide-decision-f56)).
- The patch in each fork is about 20 lines in about three files: the
  `<script type="module" src="/.lazurio/shell.js">` in `index.html`, the three elements,
  and a fixed rail with `#root { box-sizing: border-box; padding-left:
  var(--lazurio-rail-width, 0px); }` (padding, not margin: upstream `#root` is
  `width: 100%` under an overflow-hidden body, so a margin would clip the right edge).
  Each changed file joins the fork's allowlist as its own exact path. A check in the fork keeps
  that slot (the script and `<lazurio-column-head>`), so a rebase on a new upstream
  conflicts only on those lines. For colours, the fork adds a few lines of CSS that map
  its theme tokens to the shell's colour roles on `:root` (see
  [the shell as built](#the-shell-as-built-decision-f36), "Colours").
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
`postMessage` per navigation); whether the switch still pairs the browser with T3 Code
and MausBot on the way (for T3 Code it does until every Environment's T3 Code pairs
itself, [Chat entry](#chat-entry), 2026-10-17);
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
  switch, and the one identity that names an Environment everywhere, `environmentIdentity`,
  as pure functions), `elements.ts` (`<lazurio-rail>`, `<lazurio-column-head>`),
  `identity-element.ts` (`<lazurio-environment>` and the drawing of an identity, which the
  column head's picker shares), `identity-protocol.ts` (the answer to the Environment
  browser's framed view that asks how its Environment is named, [F39's addendum of
  2026-10-12](decisions.md#f39--the-peoples-view-of-the-environment-browser-one-tab-of-a-person-is-one-remote-tab)),
  `base-styles.ts` (the vendored tokens on `:host`, the colour roles with their
  fallbacks), `identity-styles.ts` (an identity's drawing), `styles.ts` (the rail, the
  picker and the switch, the design system's selection rule), `design-tokens.ts` (the
  vendored `tokens.css` as text, once in the script), `tokens.ts` (the design system's
  tokens on the app document's root, below), `theme.ts` (the Environment's theme over
  them, its memory on the origin and its announcement, below),
  `kind-name.ts` (the words of the three kinds and of your computer, and the tokens a
  text writes for the Environment it is in: {tomto}, {this}; F28's addendum of
  2026-10-18), `guide.ts`, `guide-layer.ts`, `guide-styles.ts`, `guide-content.ts`,
  `guide-placement.ts`, `guide-protocol.ts`, `guide-scenes.ts`, `guide-stage.ts` and
  `guide-scene-styles.ts` (the guide and the principles' scenes, [below](#the-guide-decision-f56)),
  `stones.ts`, `fonts.ts`, `last.ts` (the report of the last Environment used,
  below), `account.ts` and `merge.ts` (the user's account and its merge into the
  rail, below), `state.ts` (what the elements draw, shared by the page's elements and
  free of the DOM: the page's document, the user's account, the merge, and who
  provides the account), `index.ts` (the entry of `/.lazurio/shell.js`) and `vendor/`
  (tokens, logo, fonts and stones with their hashes). Tests: `tests/shell.test.ts`,
  `tests/shell-last.test.ts`, `tests/shell-account.test.ts`,
  `tests/shell-host.test.ts`, `tests/shell-signed-out.test.ts`,
  `tests/shell-picker.test.ts`, `tests/shell-interface.test.ts`,
  `tests/shell-identity.test.ts`, `tests/shell-tokens.test.ts`,
  `tests/shell-theme.test.ts`, `tests/shell-guide.test.ts`,
  `tests/shell-guide-protocol.test.ts`, `tests/launchpad-shell-routes.test.ts`,
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
- **An Organization's Environment is in its Organization's space** (Matěj
  2026-10-05). A hosted work, Team or Automated Environment lists the Organization that
  owns it (the handover's owner slug, `ownerOrganization`) first among its
  `organizations`, whether or not the Folder holds that Organization or can read it.
  The handover names the owner by its lowercased GitHub login (`examplelazurio`),
  the Folder by its own slug (`example`). The catalog entry bound to that login,
  or carrying that slug, is the same Organization and keeps its slug; it is never
  listed twice.
  Until it can, the document knows the Organization by its slug alone: the slug as the
  name, its Dashboard address, no avatar. Before this, a work Environment whose
  Organization checkout lacked its canonical documents fell into the user's own space
  and the rail showed it as "Osobní". A personal Environment still belongs to no
  Organization. Tests: `tests/shell.test.ts`.
- **Routes.** `/.lazurio/shell.js`, `/.lazurio/fonts/<file>` and
  `/.lazurio/stones/<file>` beside the page's routes (`src/launchpad/page.ts`);
  `/.lazurio/shell.json`, `/.lazurio/prompts/<id>`, `/api/organizations/<org>/owner`,
  `/api/organizations/<org>/modules/<module>/maintain` and `/api/chat/prompt-handoff`
  in the server after admission (`src/launchpad/server.ts`, producer
  `shell-document.ts`, the prompts `prompts.ts`, the Owner answer
  `organization-owner.ts`, a Steward's answer `module-maintainer.ts`, the hand-off
  check `chat.ts`). The page and the library also speak to `/.lazurio/account/…` on the
  same origin, which the Environment's gateway relays to the user's account (F37 and
  its addendum); the Launchpad does not answer it.
- **Page.** `index.html` is rail | column | main. The Apps column (all modules, Files,
  Integrace, Trezor, favourites, Marketplace) and home are `catalog-panel.ts` over `apps-view.ts` and
  `favorites.ts`, the frame is `shell.ts`, and the switch's pairing and the new
  module's hand-over to Chat are in `ui.ts`. A module's name, line and stone come from
  its default app's declaration (title, description, `icon`, tags), carried by the
  catalog as display-only `display`; the stone falls back by the root Launchpad's
  org-agnostic semantic key, and the Module's own manifest stays the authority.
  Settings, Tools, Recovery and Files keep their panels. The sections below that speak of the sidebar, its footer, the top
  bar, T3 Code's colours or Chat and MausBot as sidebar links describe the build before
  F36.
- **First paint** ([F36's addendum of
  2026-10-08](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer)):
  the first thing painted is the final page. The inline script at the top of
  `index.html` names the frame on `<html data-frame data-section>` before anything else
  is parsed (`pageFrame` in `routes.ts` reads the same; keep the two equal when a route
  changes, `tests/launchpad-first-paint.test.ts` fails otherwise), and the stylesheet
  shows only that frame. Nothing shows until `ui.ts` sets `data-ready` (the language,
  the shell document, the catalog on Apps, the profile on Settings; at the latest after
  a second, the stylesheet after two). Behind the gateway the page carries its boot
  document (`boot.ts`, `boot-document.ts`): the language, the shell document without
  `setup`, the catalog and the entry's public parts, and its words already in that
  language; a workstation's page carries none and reads them. A new text of the page
  takes a `data-message` key, so the server writes it in the right language too. The
  page reads the tools' sign-ins and the content on Settings or once idle, never on the
  way to the first paint. To watch it, sample the page in every animation frame from
  the document's start (Playwright's `addInitScript`) against the preview with its
  `gh` slowed down; screenshots alone miss frames.
- **The user's account** ([F36's account
  note](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer),
  root decision 0185 S8, S12, S15, S18). Built, and waiting only for the account to
  answer on the Environment's own origin; until the gateway relays
  `/.lazurio/account/` (404 today) everything behaves as before it:
  - The library reads `GET /.lazurio/account/environments` once per page load
    (`src/shell/account.ts`: same origin, no token, no redirect followed, given up
    after 4 s), alongside `/.lazurio/shell.json`, on the Launchpad page too, and
    never polls. A host page that provides the account itself reads, keeps and
    reports nothing (below). Apps reads the same answer (`src/launchpad/account.ts`), so the page
    asks once. Apps takes two things of it: `preferences.openApps` and `favourites`
    keyed by the Organization slug.
  - The rail draws at once from the account this origin remembered
    (`localStorage` `lazurio.account.v1`), and the fresh answer replaces it when it
    arrives (Matěj 2026-10-05: the rail took seconds to appear). Only an Environment
    that belongs to one user remembers one, and only that user's: the account's
    `operator` must be the Environment's own (`operator.login` of the shell document:
    the owner of a personal Remote Environment, the assigned user of a work one,
    the responsible user of an Automated one) when the fresh answer is kept
    (`rememberAccount`) and when it is used (`cachedAccountFor`). A Team Environment
    and a workstation name no user, so they neither keep nor use one: another
    user may open a shared origin, and only the fresh answer is theirs. Another
    user's fresh answer, a refusal (`401`, `403`) or no relay (`404`) removes it; a
    slow or failed answer keeps it. It holds only the members `parseShellAccount`
    reads, never anything else the answer carried, so never a token.
  - The rail's merge (F37 point 4, `src/shell/merge.ts`). `parseShellAccount` in
    `contract.ts` reads `lazurio.account.v1` with the same entry parsers as
    `lazurio.shell.v1` (https only, `isEnvironmentId` and the base-host identity, unknown
    members dropped, an invalid document refused as a whole), plus the optional `name`,
    `who` and `offline` of an Environment (both documents) and the account-only
    `last`, `lastBySpace`, `favourites` and `preferences.openApps`; an account
    Environment's Apps address is always absolute. `mergeAccount` keeps this
    Environment's own entry, `current` and apps, and drops the account's entry of
    the same id, taking only its `name`, `who` and `offline`. It adds the account's
    other Environments and its spaces in the account's order. An Organization is
    matched by its Dashboard slug (`dashboardSlug`), the local entry winning in
    the account's place, and local ones the account lacks follow. A Dashboard slug
    that two local Organizations (or two of the account's) reduce to is ambiguous:
    the local entries stay as they are and the account's Organization, its
    Environments and its last Environment there are left out. The account's `name`
    and `who` are shown only when its `locale` is the local document's; otherwise
    every Environment is named from its label or kind in the local language, and the
    structure (ids, apps, spaces, last Environments) stays. The `operator`
    becomes the user signed in at the browser. A space without an Environment (an
    Organization from the user's memberships) keeps its avatar and its name in the
    rail and leads to its Dashboard; ⌘⇧E lists
    it with its head and "You have no Environment here.", and the picker, which has no
    heads, leaves it out even widened. A click on another space leads to the account's
    last Environment there (`lastBySpace`), else this browser's memory, else its
    first. Without the account (404 on today's gateways, 401 or 403, slow, not a valid
    document) the rail is exactly this Environment's, with one debug line in the
    console and no error shown.
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
    and forget and silent on failure, apart from the rail's merge of the account, and
    only after the page's account read answered with an account (no write without the
    relay, so no `405` in the browser). The
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
  cookie. The entry names the user's sign-out (Machines#358), so the account at the
  foot of the rail opens its menu; the preview has no gateway, so its "Odhlásit"
  reaches the Launchpad, which does not serve the sign-out. The account is not part of
  the preview: a browser automation, or a small
  stub in front of the hosted proxy, stands in for the gateway's relay of
  `/.lazurio/account/…`. The hosted entry also routes the Environment browser's view
  ([the right panel](#the-right-panel-the-environment-browser)): agent-browser is not
  run, the Launchpad answers the view with a synthetic token on the origin the preview
  prints as `browser`, and a browser automation stands in for that origin. With
  `public` after the mode, the hosted entry also carries `audience: "public"`: a public
  Environment's demo onboarding, its notice in the column head and no Integrace,
  Trezor or Nástroje ([F55](decisions.md#f55--a-public-environment-a-demo-onboarding-a-quiet-notice-that-it-is-public-nothing-to-sign-in-to)).
  With `team` or `automated` after the mode, the hosted work Environment is the example
  Organization's Team Environment or a persona's Automated Environment instead, to see
  how the page names each kind.
  Screenshots come from Chrome through playwright-core.
- **A fork's snippet** is in decision F36 point 5 and in the target shell's "The forks
  and `/.lazurio/`": the rail, and the column head at the top of the fork's sidebar.
- **The look** ([F36's addendum of 2026-10-06 on the rail and the
  picker](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer)):
  the wireframe at prototypes-lazurio 1acd615 and the design system at
  design-system-lazurio fdcc9b4. A 64 px rail of 40 px items around 32 px marks; three
  radii, one per kind of thing; one shadow, only for the list, the ⌘⇧E dialog and the
  rail's label; the picker (`lz-picker`, 52 px with its two lines) beside a 48 px gear;
  every icon at the wireframe's stroke of 1.6. The picker's list is one line per
  Environment of the space, without the Organization's head, with a search field only
  past seven Environments and only "Všechny Organizace" at its foot; ⌘⇧E keeps the
  heads (`switcherList` and its keys, `switcherKey`, in `view.ts`). The Organization's
  name in the Apps head links to its Dashboard (`appsHeading` in `apps-view.ts`).
- **The interface the forks build on** is `src/shell/interface.ts` (version 1, F36
  addendum of 2026-10-04, grown by the addendum of 2026-10-05 with what a host page
  needs, by the addendum of 2026-10-06 with `parseShellSignedOut`, by the addendum
  of 2026-10-13 with what the script declares in the app's document, `declares`, and by
  the addendum of 2026-10-18 with the Environment theme: `declares.environmentTheme`,
  the host's `data-lazurio-appearance` and the event `lazurio-theme`, and by decision
  F56 with the guide: `<lazurio-buddy lang>`, the page's `marks` `data-guide` and
  `data-guide-help`, the event `lazurio-guide` and the export `provideGuides`, [the
  guide](#the-guide-decision-f56)); `tests/shell-interface.test.ts` keeps every
  promised name, the token names a fork may rely on among them.
- **A host page that is no Environment's** ([F36's addendum of
  2026-10-05](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer),
  the Dashboard). Such a host provides both documents itself and draws the same rail
  and column head:

  ```html
  <html lang="cs" data-lazurio-shell="host" data-lazurio-account="host">
  <script type="module" src="/.lazurio/shell.js"></script>
  <lazurio-rail space="example"></lazurio-rail>
  <lazurio-column-head space="example" settings="/orgs/example/settings/general"></lazurio-column-head>
  ```

  ```js
  import { parseShell, parseShellAccount, provideShell, provideAccount } from "/.lazurio/shell.js";
  const shell = parseShell(shellJson); // its own lazurio.shell.v1, current: null
  if (shell !== null) provideShell(shell);
  provideAccount(parseShellAccount(accountJson)); // null: no account
  ```

  - **Its document** has `current: null` (explicit; absent is refused, and `setup`
    must then be absent too), carries Environments and Organizations of its own or
    none (the account brings the user's), and may name its own pages by path:
    `dashboard`, `account`, `addOrganization` and an Organization's `dashboard`
    (`/…`, never `//…`, no fragment). The account document stays https only. Both
    documents are additive only from now on; a breaking change is a v2.
  - **The account** comes only from `provideAccount` on a page marked
    `data-lazurio-account="host"`: no request to `/.lazurio/account/environments`, no
    remembered account read or written, no `PUT /.lazurio/account/last`
    (`src/shell/state.ts`). Without the mark a provided account is ignored with one
    debug line.
  - **Where the page is** comes from `space`: an Organization the document lists is
    that Organization's Dashboard; without it, `personal` or an unlisted slug is the
    personal Dashboard (`pageOf` in `view.ts`). The rail marks that Organization as the
    space you are in (the quiet surface with a hairline), or on the personal Dashboard
    no space and the logo (`aria-current="page"`, the same look). It keeps no last Environment and reports none; a space opens the
    account's last visit there in its app, else its first Environment's Apps, else its
    Dashboard (`railSpaces` with no app of its own).
  - **The column head** (`columnHead` in `view.ts`) on an Organization's Dashboard:
    the Organization's avatar (or initials), its name and "Dashboard Organizace"; the
    list under it with its Environments, none current (⌘⇧E marks the Organization's head
    as where you are; the picker has no head since F36's addendum of 2026-10-06);
    the gear to the Organization Settings (`settings`, else `<its dashboard>/settings`,
    "Nastavení Organizace", marked by `active="settings"`); no switch. On the personal
    Dashboard it draws nothing.
  - **Links.** The logo, "+" and the account announce `lazurio-navigate` when the host
    names them by path, so a single-page host moves without a reload.
  - **Signed out** ([F36's addendum of
    2026-10-06](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer)).
    With nobody signed in the page has no `lazurio.shell.v1`, which needs a user. It
    hands its `lazurio.shell-signed-out.v1` to the same `provideShell`, and no account:

    ```js
    import { parseShellSignedOut, provideShell, provideAccount } from "/.lazurio/shell.js";
    const signedOut = parseShellSignedOut({
      schema: "lazurio.shell-signed-out.v1",
      locale: "cs",
      signIn: "/auth/sign-in?return=%2F", // https, or a path on this origin
    });
    if (signedOut !== null) provideShell(signedOut);
    provideAccount(null);
    ```

    The rail then draws only the Lazurio logo and the key "Přihlásit Lazurio účtem",
    both leading to `signIn` (a path announces `lazurio-navigate`, as above), and the
    column head draws nothing. `signIn` follows the rule of the Dashboard's addresses
    above. A later `provideShell` with the user's `lazurio.shell.v1` draws the full
    rail again, and a signed-out document after that draws the logo and the key again.
    A host without a sign-in provides no signed-out document, and its rail stays empty.
  - **Assets.** The host serves `shell.js` and the four fonts at
    `/.lazurio/fonts/<file>` on its own origin. It takes them from the release
    artifact `lazurio-shell.tar.gz` (the addendum's point 9), which also carries the
    DOM-free parsers and the hashes of every file; `docs/update.md`, "The shell
    artifact", says what it holds and how a host verifies it.
- **What the Environment still lacks** (root decisions 0188 and 0201, additive in v1):
  the document's optional `setup` for the current Environment, `{ai?: "ready" |
  "missing", github: "connected" | "missing", content?: "ready" | "missing" | "failed",
  item?: {kind: "organization", name, login} | {kind: "personalspace", login | null}}`.
  Present only where the Environment signs in as its user and gh's state is known
  (`setup-state.ts`: this Environment's `gh`, kept a minute and replaced by Nástroje's
  readings and every sign-in or sign-out through the Launchpad); `ai` only where Codex
  and Claude Code answered (`src/tools/ai-probe.ts`, kept a minute; `ready` is the
  user's sign-in or the Organization's AI); `content` only where the content routes
  answer, `item` the first content not here or the one that stopped. The document never
  waits for it (F36's addendum of 2026-10-08): it is the last reading, first read when
  someone opens the page, read again in the background after 30 seconds, and dropped
  and read again at once on a sign-in or sign-out, a Tools reading that changes
  GitHub's state, a content installation, a fresh AI reading and a profile change; until
  the first reading ends the document has none. `parseShell` takes it absent, null or in
  its exact shape and refuses the document otherwise, as for every known member (an
  older parser ignores `ai`). `<lazurio-column-head>` shows it as one quiet prompt under
  the switch in Apps, Chat and Automate (`columnSetupPrompt` in `view.ts`, root
  decision 0201 point 2): while a basic is known to be missing, "Dokončit nastavení (1
  ze 3)" (`ai` ready, GitHub connected and the content ready count as done), a link to
  `settings/start` of the Environment's Launchpad (a path when Apps is this origin's,
  announced as `lazurio-navigate`). Settings and a page that is no Environment's show
  none. No attribute, event or property of the interface changes.
- **Whether the Environment keeps the offline guide** (decision F41, additive in v1):
  the document's optional `offlineGuide: true`, present only where the current
  Environment is a node of a tailnet and no workstation. `parseShell` takes it absent,
  false or true beside a current Environment (keeping it only when true) and refuses
  any other shape, or any value on a page that belongs to no Environment. The shell's
  state registers the guide's worker only with it ("The offline guide" below); a host
  never sets it.
- **Colours** (F36's addendum of 2026-10-04, evening; root decision 0187). The elements
  have no palette of their own: they take the colours of the app they sit in. A host
  sets the colour roles below as custom properties on its document (`:root`), from its
  own theme tokens; they inherit into the elements' shadow roots. Every role is
  optional: an unset one keeps the design system's colour, so a host that sets none
  (the Launchpad page) looks as before, and the column head's dark tone
  (`--lazurio-host-tone`) stays the fallback for a dark host without roles. A role the
  host sets wins over that tone. Point each role at a token of the theme (`var(--…)`),
  not at a fixed colour, so a change of theme reaches the elements without more code.

  | Role | What it colours | What a host maps |
  | --- | --- | --- |
  | `--lazurio-surface` | the rail, the column behind the head | its sidebar's background |
  | `--lazurio-ink` | names, icons on hover | its sidebar's text |
  | `--lazurio-ink-muted` | who an Environment is for, icons, meta | its sidebar's muted text |
  | `--lazurio-line` | hairlines and borders, the active tab's edge, the rail's edge toward the app | its sidebar's border |
  | `--lazurio-line-strong` | the hairline around the active space in the rail (and the logo on the personal Dashboard) | the border of its selected row; the design system's `gray-300` |
  | `--lazurio-hover` | a row or a rail item under the pointer | its row hover |
  | `--lazurio-selected` | the selected row, the open picker | its selected row |
  | `--lazurio-control` | the track of the app switch | its control or input surface |
  | `--lazurio-raised` | the active tab of the switch, an Organization's mark, your personal monogram | its active row or raised surface |
  | `--lazurio-overlay` | the list under the picker, the ⌘⇧E dialog, menus | its popover or menu background |
  | `--lazurio-overlay-ink` | text in them | its popover text |
  | `--lazurio-focus` | the focus ring | its focus ring |

  T3 Code maps its sidebar tokens, MausBot its skin's panel tokens; the wireframe at
  `HumanAndMachine-ai/prototypes-lazurio` 5411279 shows both (`themes/t3code.css`,
  `themes/mausbot.css`). For example, for a theme whose sidebar tokens are `--sidebar`
  and `--sidebar-foreground`:

  ```css
  :root {
    --lazurio-surface: var(--sidebar);
    --lazurio-ink: var(--sidebar-foreground);
    /* … the other ten roles … */
  }
  ```

  The shapes, type and selection rule stay the design system's. The list of
  Environments mixes its lines, hover and selection from the overlay and its ink. The
  Lazurio logo sits on a white disc in every theme. On its edge toward the app the rail
  draws one hairline in `--lazurio-line`, the design system's line without roles, 1 px
  inside its own 64 px ([F36's addendum of
  2026-10-17](decisions.md#f36-addendum-of-2026-10-17-the-rails-edge-toward-the-app),
  amending root decision 0187 point 2; from 2026-10-04 it drew none). Map
  `--lazurio-surface` to the colour of the sidebar beside it and `--lazurio-line` to the
  border that sidebar draws on its other side, and draw no line of your own on the
  rail's side, or there are two: the Launchpad page dropped its `.app { border-left }`,
  and the Dashboard drops its `.surface` line when it vendors a release with the edge.
  The line is an inset shadow of the element, not a border, so a border colour a host's
  own rules give the rail never recolours it. Since root decision 0208 the apps' standard
  looks follow one theme of the Environment, through the token names below ([the
  Environment's theme](#the-shell-as-built-decision-f36)); a user's own pick in T3
  Code or MausBot stays theirs, and the roles follow whatever the app shows. The
  Launchpad page sets the roles only under a theme other than Lazurio, so under Lazurio
  the elements draw the design system's look exactly as before.
- **The design system's tokens in the app's document** ([F36's addendum of
  2026-10-13](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer),
  root decision 0200). When `/.lazurio/shell.js` loads, `defineShellElements` puts the
  vendored `tokens.css`, without its comments, first in the document's `<head>`
  (`src/shell/tokens.ts`, one `<style data-lazurio-tokens>`) and marks `<html
  data-lazurio-theme="light">`. It relies on the file's shape, one `:root` rule of
  `--lz-*` custom properties, as `base-styles.ts` does for `:host`;
  `tests/shell-tokens.test.ts` fails on anything else in the file. Once per document, the
  mark only where the tokens hold, and nothing at all where the root already resolves
  any of the names: the Launchpad page links `tokens.css` itself and the Dashboard
  vendors it. The elements keep their own tokens on `:host`, so they draw as before. A
  fork maps its own tokens onto the promised names under the mark's value, for its
  standard light look only, with a fallback where it makes sense:

  ```css
  :root[data-lazurio-theme="light"]:not([data-theme-id]):not(.dark) {
    --background: var(--lz-surface);
    --foreground: var(--lz-ink);
    --control-radius: var(--lz-radius-sm);
    /* … */
  }
  ```

  It may rely on the mark, on the names `declares.tokens` lists in
  `src/shell/interface.ts` (what T3 Code's mapping needs: the surfaces, ink, line,
  accent, black buttons, the grey steps it uses, the signal colours with their surfaces,
  the type and the radii) and on the faces of Inter Tight Variable and Geist Mono from
  `/.lazurio/fonts/`; never on the values, or on any other `--lz-*` name the shell
  happens to declare, which the design system may change or drop. MausBot gets the same
  tokens and mark and reads neither, so it looks as before. Since the addendum of
  2026-10-18 the tokens' style ends with `:root { --lazurio-color-scheme: light; }`:
  the scheme of their values, from the moment the script evaluates.
- **The Environment's theme** ([F36's addendum of
  2026-10-18](decisions.md#f36-addendum-of-2026-10-18-the-environment-theme-root-decision-0208),
  root decision 0208). One theme per Environment that Chat, Apps and Automate take
  through the shell; a user's own pick inside T3 Code or MausBot stays theirs.
  - **The record** (`src/theme/record.ts`): `{theme, revision, setAt}` in the install
    base, `<base>/theme/<Folder digest>.json`, never in the Folder's `.lazurio/` and
    never in the profile; Lazurio at revision 0 while there is none or it cannot be
    read. Every change is compare and set on `revision` under a per-Folder `flock`
    (`theme-changed`, `theme-busy`, `unchanged`); a Launchpad without a base keeps it in
    memory.
  - **The themes** (`src/theme/palettes.ts`): `lazurio` (the vendored tokens' own
    values, light only, the default), then T3 Code's built-ins `grove`, `ocean`,
    `ember` and `iris` (`src/theme/vendor/`, MIT, re-vendored at each rebuild of the T3
    Code fork), projected onto `shellThemeColors` (the promised colours) as literal
    `#rrggbb`, light and dark. The projection table is in the addendum; the contrast of
    every theme and appearance is `tests/theme-palettes.test.ts`.
  - **The API** (`src/launchpad/theme-routes.ts`): `GET /api/theme` answers `{kind:
    "theme", theme, label, revision, setAt, choices}` (every theme with its values);
    `POST /api/theme/set` takes exactly `{theme, revision}` and answers the same with
    `outcome` (`set`, `unchanged`), 409 `{kind: "blocked", reason: "theme-changed",
    current}` or `theme-busy`, 400 for anything else. On a public Environment every
    read is the default Lazurio, whatever the record says (`fixedThemeReads`), and the
    change is 403 `public-environment`, before its body is read: a guardrail of these
    interfaces, not a security boundary (root decision 0172).
  - **The CLI** (`src/theme/cli.ts`): `lazurio theme show` and `lazurio theme set <id>
    [--expected-revision <n>]`, JSON on stdout, over the same record; on a public
    Environment `show` answers the default and `set` is refused with the reason on
    stderr. Never `t3 theme set`.
  - **In the shell document**: `theme: {id, label, revision, light, dark?}` beside a
    current Environment (`parseShellTheme`), always in `/.lazurio/shell.json` and the
    boot document (`shellThemeOf`).
  - **In the app's document** (`src/shell/theme.ts`): the shell writes one
    `<style data-lazurio-environment-theme>` right after the tokens it installed, or
    fills a host's own (the Launchpad's), with the light values on `:root` and, where
    the theme has them, the dark values where the host shows dark; it marks the root
    where the values hold and declares, as the script evaluates, the theme this origin
    remembers (`localStorage` `lazurio.shell.theme`) before the app's own module runs.
    It reads `/.lazurio/shell.json` again when the page is shown again (visibility,
    focus) and follows another tab's newer theme at once (`storage`); every change is
    `lazurio-theme` on the document. For Ocean the style is:

    ```css
    :root {
      --lz-surface: #f5f7f8;
      /* … the other 19 promised colours … */
      --lazurio-color-scheme: light;
    }
    :root:is(.dark, [data-lazurio-appearance="dark"]) {
      --lz-surface: #17212b;
      /* … */
      --lazurio-color-scheme: dark;
    }
    @media (prefers-color-scheme: dark) {
      :root[data-lazurio-appearance="device"] {
        --lz-surface: #17212b;
        /* … */
        --lazurio-color-scheme: dark;
      }
    }
    ```

    and the root `<html data-lazurio-theme="light" data-lazurio-environment-theme="ocean"
    data-lazurio-theme-dark>`. A host says how it shows dark: `class="dark"` (T3 Code),
    or `data-lazurio-appearance="device"` (follow the device), `"dark"` or `"light"`. A
    fork maps the promised names as before; T3 Code's gate takes the dark values too with
    `:root[data-lazurio-theme="light"]:not([data-theme-id]):is(:not(.dark),
    [data-lazurio-theme-dark])`, and MausBot's "Environment" skin keys its code palette on
    `--lazurio-color-scheme`. The Platform release ships before either fork's.
  - **Apps** (`src/launchpad/theme-view.ts`, `index.html`): the page takes its colours
    from the promised names where the design system's value is the same, so Lazurio
    looks as before; under another theme it also sets the twelve colour roles, so the
    rail follows. It stays light: it hands the shell the theme without its dark values
    (`appsTheme`), with `data-lazurio-appearance="device"` on `<html>` for when Apps gets
    a dark look. A hosted page carries the style filled at the end of `<head>`, after the
    bundled tokens; a workstation's script adds the empty place there.
  - **Settings → Obecné → Téma Prostředí** (`src/launchpad/theme-panel.ts`): a card per
    theme with its light and dark miniatures, a native radio group whose choice applies
    at once (compare and set at the revision shown; the current theme when it moved
    meanwhile), for whoever can open Settings, a Team's every member; no group on a public
    Environment.

### Prompt hand-off to Chat

"+ Nový modul" opens Chat of the same Environment with the prepared prompt in a new
thread's composer, not sent (Lazurio/t3code#35, Lazurio/LazurioPlatform#153).

- **The prompt.** `GET /.lazurio/prompts/<id>?org=<login>`, behind the admission of
  every read (the gateway's session hosted, where Machines proxies `/.lazurio/*` from
  the T3 Code origin to this Launchpad with the Launchpad's Host and the query kept;
  the fragment token locally), answers `application/json`, `Cache-Control: no-store`:
  `{"schema": "lazurio.prompt.v1", "id", "text", "cwd"}`. `text` is the prompt in the
  user's language (the Folder's profile locale), `cwd` the absolute root of the
  Lazurio Folder for every prompt, an Organization's too (root decision 0189; F36
  addendum of 2026-10-14: the Folder's skills are found only from there). Three ids
  exist (`src/launchpad/prompts.ts`). `prepare-content` ("Vyřešit v Chatu", root
  decision 0188) is the Folder's: only where the Environment signs in as its user,
  only while the last installation the content routes report stopped, its text the
  wireframe's `preparePrompt` with the step and the detail of that stop (find the
  cause, fix it, finish with `lazurio organization install <login>` or `lazurio
  personalspace install`, verify with `lazurio doctor` and the modules' tests, report,
  ask before anything outside the Environment), its `cwd` the Lazurio Folder's root
  (the Organization may not be here yet). Its `org` is optional and, when given, must
  be the login of the content that stopped (the Organization's, or the user's for the
  Personalspace); today's fork sends it with every link. `new-module` is an
  Organization's (its text `newModulePrompt`); the
  Organization is the one Organization of the Folder whose manifest binds that GitHub
  login. Each prompt names who may get it: `new-module` only where this Environment's
  GitHub identity is an Owner of the Organization, the tile's live check
  (`organization-owner.ts`), so never on a Team Environment. `new-personal-module`
  (the personal space's "+ Nový modul", audience `personalspace-holder`) is the
  Folder's too: only where this Environment's GitHub account holds the Folder's
  Personalspace, decided at the request as `GET /api/content` decides it (#186: its
  own private `<login>/<login>_GEN3`, on a personal Remote Environment the handover's
  Owner), and only for `org` equal to that account's login, letter case ignored; its
  text `newPersonalModulePrompt` with the login as GitHub spells it, its `cwd` the
  Lazurio Folder's root (root decision 0189). Anyone else, an unknown id,
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
  text in the composer; nothing is sent without the user, and an unknown id, a failed
  fetch or a wrong answer insert nothing.
- **Tests.** `tests/launchpad-prompts.test.ts`: the prompt registry and its audience,
  the Organization a login names (case-insensitive, exactly one), the document, the
  version rule and the cached `t3 --version` check (every failure no), the link's shape,
  and HTTP: hosted behind the admission (401 without the session), the Owner's document
  with `no-store`, GitHub asked for the bound login, 405 for POST, the same 404 for
  another id, Organization, query or a non-Owner, the hand-off answer from the
  Environment's `t3`; locally only with the token, and no hand-off without a Chat origin.

### The guide (decision F56)

A "?" right after a page's heading makes Buddy, or without him the neutral guide of
Lazurio, explain the page in place
([F56](decisions.md#f56--průvodce-buddy-nebo-průvodce-lazuria-vysvětlí-stránku-na-místě-kreslí-shell-hostitele-rám-buddyho-smí-jen-požádat-id),
root decision 0180's addendum of 2026-10-18): a ring around the real element, the
guide's mark and a card beside it, and the layer lets every click through.

- **In the shell.** `src/shell/guide.ts` decides what plays and when, over seams, so its
  rules are tested without a DOM; `guide-layer.ts` draws in `<lazurio-buddy>`'s own
  shadow root, made only when the guide first shows; `guide-content.ts` holds the six
  principles in both languages and parses what a host hands over;
  `guide-placement.ts` is where a bubble at a ringed element stands, for the tour too;
  `guide-protocol.ts` is the pure protocol of Buddy's frame, with its vectors in
  `guide-vectors/v1/`. `elements.ts` defines `<lazurio-buddy>` and exports
  `provideGuides` (interface v1), and for the Launchpad alone `guideAttention`, the
  arbiter with its tour.
- **The principles in motion** ([F56's addendum (3) of 2026-10-19](decisions.md#f56-addendum-3-of-2026-10-19-the-six-principles-in-motion)).
  `environment`, `buddy`, `reach`, `files` and `integrations` play a scene in the card,
  one beat a step; Trezor keeps its video and has none, and so does a host's own
  explanation. `guide-scenes.ts` is the scenes as pure data (per beat where each object
  stands, whether it is on stage, the words of its state, when it moves; their names in
  both languages), `guide-stage.ts` builds one in the card and sets a beat, and
  `guide-scene-styles.ts` draws it: its plain rules are each beat's finished frame, and
  every transition and animation stands inside `@media (prefers-reduced-motion:
  no-preference)` and outside the layer's `data-still`, looping or ending at that frame.
  The engine hands the layer `GuideView.scene`, keyed by the principle's id and the
  step; nothing of it is interface v1. A scene names things only (at most three words,
  the guide's text rules), never "=" or a word of sameness, draws two devices with
  Lazurio as a window into the agents' computer (on your computer one device, yours,
  with Lazurio on its screen and no arrow), and the way from the Osobní to the
  Pracovní Prostředí as one straight solid arrow with nothing on it. The card keeps one
  size through any explanation: every step's words stand in one place (`.lines`, only
  the step's own shown), the stage is as wide as the card leaves (at most 360 px, 16 by
  9, centred in the sheet below 768 px), and the last step's links have their own row
  (`.more`), unseen until then.
- **A host takes part by asking.** It places `<lazurio-buddy lang>`, hands over the
  explanations of the page it shows with `provideGuides([...])` on every move (null to
  withdraw), marks its elements with `data-guide` and its "?" with
  `data-guide-help="<id>"`. A "?" may name a principle (`environment`, `buddy`,
  `reach`, `files`, `integrations`, `vault`) or one of the page's explanations. An
  explanation may carry `docs`, an https address the card links at its last step
  ("Dokumentace", [F56's addendum of 2026-10-18](decisions.md#f56-addendum-of-2026-10-18-every-page-of-the-apps-column-has-its--and-loses-its-explaining-sentences)); the
  principle `integrations` carries the documentation of Integrace. Without that, the
  element draws and listens to nothing, as on the forks.
- **The Launchpad** (`src/launchpad/guides.ts`, wired in `ui.ts`; [F56's addendum of
  2026-10-18](decisions.md#f56-addendum-of-2026-10-18-every-page-of-the-apps-column-has-its--and-loses-its-explaining-sentences)): every page of the Apps column has its "?"
  right after its heading (`pageHelpOf`): the header's `#page-help` after
  `#page-heading` on Soubory and Trezor, `#catalog-help` beside the Apps home's heading
  (catalog-panel.ts keeps it there as it draws the head) and `#integrations-page-help`
  beside Integrace's title; every section of Settings uses the header's. Each starts hidden and shows once the page knows what it
  plays; a module's overview and the Marketplace have none. `pageGuide(route, facts,
  copy)` chooses from what the page knows (`PageGuideFacts`: the kind of the shell's
  current Environment, whether Composio is allowed as Integrace read it, the vault's
  facts as Trezor read them, what Začínáme shows here and what Nástroje can point at),
  never an Organization's name (#499):
  - Apps home and an Organization's Apps: the principle `environment`;
  - Soubory: the principle `files`, in a Team Environment the Launchpad's `files-team`;
  - Integrace: the principle `integrations`, where Composio is allowed the Launchpad's
    `integrations-composio` (the user's own account, one Composio organization per
    Organization, what the agents use, another account for other accounts), on Vlastní
    and its form `integrations-custom`; the Launchpad's explanations carry the page's
    documentation (`integrationsHelp`), which left the page's corner;
  - Trezor (`vaultHelp`), only once the page read the vault's state: in a Personal
    Environment, or wherever the vault is the
    user's own Bitwarden, the principle `vault` (its Personal adaptation); where
    nobody who enters is added to the vault (membership `not-managed` or
    `sign-in-not-required`, so a Team or Automated Environment), where the user is no
    member (no account or no master password yet, removed), and while that is not
    known, the Launchpad's `vault-agents`, which promises no Bitwarden of one's own; where
    the user is a member of the vault, or the Environment has no vault, the approved video
    `vault-overview`, open in place as the page opens and the first thing it shows (F56's
    addendum (4) of 2026-10-19), with the one line it does not say; the "?" closes and reopens
    it (`page-help.ts`, `#vault-video`); nothing until the page read the vault's state. One
    agent's request has no "?";
  - Settings ([F56's addendum (2) of 2026-10-18](decisions.md#f56-addendum-2-of-2026-10-18-every-section-of-settings-has-its--and-loses-its-explaining-sentences)): Začínáme
    `settings-start` (only where it has the basics: not on a public Environment's demo
    nor where it has nothing to set up), Obecné `settings-general`, Komunikace agentů
    `settings-communication` (`-team`), Toto <kind> Prostředí `settings-machine` (on
    your computer its own words), Nástroje `settings-tools` (`-team`), the devices
    section `settings-ssh` (`-team`; its words never name the protocol), Obnova
    `settings-recovery` (none in Recovery mode). Escape closes an explanation there and
    stays on the page (`createShell`'s `guiding`).

  The panels report what the choice reads (`integrations.composio()`,
  `vaultPage.facts` and the tools panel's targets, each with a `drawn` hook), and `pageHelpStates` says what each
  "?" shows, which ui.ts sets on the buttons. Escape leaves Settings only while the
  guide explains nothing (`escapeLeavesSettings` in shell.ts, `guiding`): the shell's
  listener comes before the guide's. The marks are `nav-files`,
  `nav-integrations`, `nav-vault` (the column), `browser` (the corner's toggle),
  `files-list`, `composio-apps` (the corner's Composio link), `vault-row` (the vault's
  row, and the picture of a Personal Environment's connection), `vault-open` (the row's
  actions), Settings' `start-steps`, `start-optional`, `general-language`,
  `general-detail`, `general-coordination`, `general-apply`, `voice-text`,
  `voice-save`, `machine-facts`, `machine-support`, `tools`, `ssh-prompt`,
  `ssh-devices`, and those a panel draws once read (`drawnMarks`): `integration-on` and
  `integration-connect` (the first connected app, the first Connect),
  `mcp-list` and `mcp-add` (Vlastní), `start-ai` and `start-github` (Začínáme),
  `tool-connect` and `tool-agents` (Nástroje, chosen by `toolGuideTargets`: the first
  sign-in or connection someone made, the first switch that moves; never gh of a Team
  Environment; where there is none, the steps at it are left out and Nástroje's "?"
  says what the page is and, in a Team Environment, that the Team shares it; it waits
  until the tools are read), `recovery-result` and `recovery-checks` (Obnova). Words are in
  `messages.ts` (`pageHelp`, `guideFilesTeam*`, `guideComposio*`, `guideCustom*`,
  `guideVaultAgents*`, `vaultVideoLine`, `guideStart*`, `guideGeneral*`, `guideVoice*`,
  `guideMachine*`, `guideTools*`, `guideDevices*`, `guideRecovery*`). Recovery mode withdraws the guide. The tour (`tour.ts`) tells the
  guide whether it wants attention, hides while the guide is out, and nudges its bubble
  when a "?" asks meanwhile; the guide then draws nothing and only says "Nejdřív
  dokončete Začínáme" to assistive technology.
- **Rules of a text** (`tests/fixtures/guide-text.ts`): at most four steps of at most
  nine words, no full stop, never Launchpad, Dashboard, Mašina or VM, SSH, a tailnet or a
  server (an MCP server is the name of a thing and passes), three kinds of
  Environment, never "jen vám/váš/vaše/pro vás", no sameness, nothing that forbids. A
  variant is chosen only by facts the page knows, never by an Organization's name
  (#499).
- **Check it in a browser** (root decision 0178): `bun scripts/preview-launchpad.ts
  hosted|personal cs|en <port> owner [team|automated|no-vault|vault-member|composio-off]`
  (`vault-member`: the user already a member of the work Environment's vault, where
  Trezor shows its video first), then every
  page with its "?" at 1440 and 700 px, with and without `prefers-reduced-motion`: one
  "?" right after the heading, the ring on each step's element (or the card in the
  middle where it is not on the page), "Dokumentace" at the last step of Integrace,
  Trezor's variant in a Work (the video, playing, with its line), Team and Automated
  (`vault-agents`) and Personal (`vault`) Environment and without a vault (the video),
  Escape returning the focus to the "?", the removed sentences absent, and a page with
  the shell and `<lazurio-buddy>` but no `provideGuides` drawing nothing. For the scenes,
  play each principle (a button with `data-guide-help="<id>"` plays any of them on a
  page that takes part) in a Work, a Team and a Personal Environment: every beat, one
  card size per explanation, and with `prefers-reduced-motion` no running animation and
  the beat's finished frame at once. Tests: `tests/shell-guide.test.ts`,
  `tests/shell-guide-protocol.test.ts`, `tests/shell-guide-scenes.test.ts`,
  `tests/launchpad-guide.test.ts`.

### The offline guide (decision F41)

On an Environment that is a node of a tailnet, the Launchpad answers
`/.lazurio/offline` (the guide page, built by `src/shell/offline-page.ts`) and
`/.lazurio/offline-sw.js` (the worker, `src/shell/offline-worker.ts` behind a
per-answer prelude from `src/launchpad/offline-guide.ts`) after the same
admission as every read, and its shell document carries `offlineGuide: true`.
Elsewhere there is no page and the document says nothing, but the worker's
address still answers, with the retiring worker. The shell's state acts once
per page load (`src/shell/offline-guide.ts`): it registers the worker only with
`offlineGuide`, and otherwise only checks the guide's worker registered
before, which then retires. The worker must stay updatable: keep its address,
an answer there on every Launchpad (never a 404), `Cache-Control: no-cache`,
`Service-Worker-Allowed: /` and the prelude's digest of the page; never add
`importScripts`. Check it in Chromium with Playwright supplied externally:

```sh
NODE_PATH=<directory with playwright> bun scripts/smoke-offline-guide.ts
```

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

**Routes.** `/settings/start` ([Začínáme](#first-run-of-an-environment), first where
the Environment has it), `/settings/general`, `/settings/machine`, `/settings/tools`,
`/settings/ssh` ([SSH from your devices](#ssh-from-your-devices)) and
`/settings/recovery` (the read-only [Recovery page](recovery.md#the-recovery-page)); `/settings`
and an unknown section open General and the address bar is rewritten to the canonical
path. Trezor is no section of Settings any more: it is the page `/vault` of the Apps
column ([Vault, Apps → Trezor](#vault-apps--trezor)), and its old `/settings/vault` and
`/settings/vault/requests/<id>` are served for good and open it, the address bar
rewritten to `/vault…` (`legacyVaultPaths`). The paths live in `src/launchpad/routes.ts` (pure, tested in
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
| This Environment (read-only handover) | Settings → This Environment (Czech "Tento Environment"): "Obsah Environmentu", then the kind, whom it belongs to and who works in it in a person's words, the recorded technical facts folded under "Pro podporu" (root decision 0188) |
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
behind by a stray key. The header (also Files') keeps its 52 px row but wraps rather
than run past its edge or under the page's top right corner (#365): below 768 px its
actions show only their icon, their words kept for screen readers, as the Browser
toggle does there, and a breadcrumb that leaves no room puts the action on a second
row at the right. T3 Code's settings search, `/` shortcut and per-row reset are
not built: the page has three sections and no defaults to reset to. Its sidebar toggle
and resizable sidebar are built for the left column since 2026-10-12
([the right panel](#the-right-panel-the-environment-browser)).
The General settings keep the explicit Preview → Apply of a Folder change instead of
T3 Code's immediate apply; the Environment's theme in the same section (root decision
0208) applies at once, because it changes nothing of the Folder. Icons are Iconoir (MIT), the design system's interface set, inlined as SVG symbols (Lucide before decision F36's addendum of 2026-10-04).

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
allowlist, no planned slots, no `launchpad.gen3*.json`, no state: the CLI recomputes
the catalog on every read, and the Launchpad keeps its last reading only while a watch
of the directories it found tells of no change (`catalog-reading.ts`, F36's note of
2026-10-20 (2)). A candidate that cannot be read keeps its typed reason
(`canonical-documents-required`, `organization-conflict`, `template-not-runtime`,
`organization-changed`, `organization-unavailable` for a link or a directory that is
not the user's) and never hides the others; two candidates that declare the same
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
`preparation-lockfile-ambiguous`, `preparation-lockfile-unused` (with the lockfile as
`file`, beside a package that declares nothing to install, F25 addendum of
2026-10-07), `preparation-package-manager-unsupported`,
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
are skipped): with two or more, which one is the user's is not guessed, none is
read, and the group is listed with `personalspace-ambiguous` and no modules (decision
0091); an owner directory or `workspace/` that is not the user's own is
`personalspace-unavailable`. An Organization whose slug is `personalspace` is
ambiguous with the group under the selection rule.

**Whose Personalspace (#186, decision F9's addendum of 2026-10-05).** The one owner
directory is read only when this Environment's GitHub account holds it: gh's account
(the Launchpad's and the CLI's own sign-in) and, on a personal Remote Environment, the
handover's Owner; the directory `<login>_GEN3`, its `origin` `<login>/<login>_GEN3`
and GitHub's answer that the repository is the account's own and private.
`personalspaceHolder` in `src/content/status.ts` makes the decision for
`GET /api/content`, the catalog (`readFolderCatalog(folder, holder)`), the module
lifecycle (at the selection and in `resolvePersonalspaceApplication`) and Nová karta's
running modules. Otherwise the group is listed with the reason and no modules
(`personalspace-foreign`, `-not-owned`, `-public`, `github-signed-out`,
`github-unavailable`, `github-identity-mismatch`), every operation on
`personalspace/<module>` answers it, and `ensure` finds no module. A reader given no
decision (the Doctor, the vault, the shell document, the Organization routes) lists
the group as `personalspace-unverified`. The Launchpad keeps one decision per checkout
for a minute (`createPersonalspaceHolder` in `src/content/holder.ts`; the layout is
read on every call) and makes the first in the background as it starts. The page's
catalog (`POST /api/catalog`, the boot document) takes the last decision and never
waits for GitHub: before the first one the group is `personalspace-unverified`, and
the page reads the catalog again after 1, 2, 4, 8 and 16 seconds while the group is
`personalspace-unverified` or `github-unavailable` (`personalspaceRereadMs`). A
decision being made when a gh sign-in or sign-out drops it is never answered: it is
made again. An Organization's module never waits for the decision: the lifecycle
decides it only for `personalspace/<module>` and, for the gateway's `ensure`, only
for an id the Personalspace alone may have (below); `lazurio module list` only where
the group is shown. The resident addressed these apps
as `<owner login>/<module>` (its `company` was the owner,
`R:lazurio/runtime/personalspace-lib.mjs:1126`, selected by
`R:lazurio/core/module-lifecycle-client-lib.mjs:297,385`) and its CLI refused them on a
personal server (`:76`); the Platform names them `personalspace/<module>` instead, so
no output carries the login. The company a module declares is still part of its
transient unit's readable name (`applicationUnitName`), as it was in the resident's
inventory.

**What else the personal space offers ([F36's addendum of
2026-10-13](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer),
root decision 0185's addendum of 2026-10-13, #359).** Where the personal space is held
(listed without a reason, above), its Apps home ends with a quiet section, "Co dalšího
tu můžete dělat", with one tile each for Chat, Automate, Integrace and Soubory. It comes
after the empty sentence or after the whole grid, never between tiles, and not while
the first run's line shows. An Organization never has it.

- `appsHomeParts` in `apps-view.ts` gives the order of the home: the empty sentence,
  the sections, then the starts.
- `personalStarts` gives the starts. Chat and Automate come from `switchTabs` over this
  Environment's shell document, with their tab's address and name; a plain click sends
  the tab's `lazurio-app`, so `ui.ts` pairs the browser on the way. Where the app does
  not run (a workstation, or a personal Remote Environment without MausBot), the start
  is muted with the tab's words. Integrace and Soubory are the column's routes
  (`integrationsPath`, `filesUrlPath`) under the column's message keys.
- `catalog-panel.ts` draws the section. `tests/apps-view.test.ts` checks the order, the
  targets, the muted words and that `index.html`'s column has the same routes and keys.
- <a id="personal-new-module"></a>**"+ Nový modul" in the personal space** ([F36's
  second addendum of 2026-10-13](decisions.md#f36--the-lazurio-shell-one-library-in-the-platform-served-at-lazurioshelljs-with-lazurioshelljson-the-launchpad-is-its-first-consumer),
  plan DEV-6662 M1b). For the holder, the personal space's one section is Workspace,
  even with no module ("zatím žádné moduly"), and it ends with the tile "+ Nový modul"
  / "Vytvořit s agentem"; the empty sentence gives way to it, and the starts stay after
  it. `newModuleOffer` in `apps-view.ts` decides who gets which tile: an Organization's
  Owner the prompt `new-module`, the personal space's holder `new-personal-module`. The
  holder is the `login` of the `present` personalspace item of `GET /api/content`
  (`personalHolderOf`), which the page reads once it is idle; until then, and for a
  personal space listed with a reason, there is no tile. The click hands over
  `{id: "new-personal-module", organization: <login>, text}` through `handOver`, by
  link where Chat takes prompts, otherwise through the clipboard (a workstation always
  copies). Both briefs (F36 addendum of 2026-10-14) are short: "Chci postavit nový
  modul do Workspace Lazuria." / "I want to build a new module in the Lazurio
  Workspace.", where the module goes (the personal space as a private repository on
  `<login>`'s account, or the Organization `{name}` with its GitHub login), and "Použij
  skill `new-module`. …" / "Use the skill `new-module`. …", which asks for the interview
  about the purpose, the agent's own technical choices and the plan to confirm. The
  Folder's skill `new-module` (F14 addendum of 2026-10-14) holds every step, including
  `lazurio module create personalspace/<slug>`; the brief carries none. The personal
  brief must not reach a release before the real run of that command (#399).

**Routes.** `/` is the first Organization's Apps home; `/o/<org>` one Organization's
Apps home, its sections Workspace and Productionspace (F36, F32's final addendum);
`/o/<org>/<module>` one module (Organization, apps with the default marked,
path, whether it can run; no resolution state since F36's addendum of 2026-10-16). No route shows Teams (F32). `<org>` is selected by the CLI's rule
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
F25; nothing at all for a package that declares nothing to install, which needs no
lockfile, F25 addendum of 2026-10-07); for an app that declares one the same frozen
install on every start (when `node_modules` matches the lockfile Bun leaves registry
dependencies as they are, but copies local `file:` dependencies again and runs the app
package's own lifecycle scripts such as `postinstall`), then its check, and only when
the check fails the declared `prepare_script` and the check again (decision F34, Lazurio Module Standard
ch. 3 and 10); then the dev script, never a hostname convention. Every one of these
processes runs with Bun's runtime auto-install off (`BUN_OPTIONS` with `--no-install`,
F25 addendum of 2026-10-07, point 6). A check that passes
after the install runs no `prepare_script`. **Prepare** (`lazurio module prepare`) runs the lifecycle's explicit
preparation (the transaction with the retained owner lock), whatever the check says now,
and starts nothing: for a declared preparation the install, `prepare_script` and check,
for the default its install. It never prepares beneath a running app: a service-owned
app is `application-running`, another managed app of the Organization
`other-app-managed`, and a session app is stopped for its own preparation, as before. The toolchain is the user's Bun at
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
JSON, `NODE_PATH`, `NODE_ENV=development`, the runtime and Organization identity, the
loopback origin of each sibling module of its Organization it declares
(`LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN`, F26 addendum of 2026-10-10), the value of
each runtime secret it declares, read from the Environment's own vault at this start
(`LAZURIO_RUNTIME_SECRET_<NAME>`, F46 as F53 amends it; a required one without a value refuses the
start as `runtime-secret-unavailable`, an optional one is reported as
`secretsNotProvided`), and on
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

## Module creation (decision F52)

A user's own module: `lazurio module create personalspace/<module>` plans a private
repository `<login>/<module>` on the GitHub account gh is signed in with, checked out in
the held Personalspace's `workspace/<module>`, with no Organization and no Teams, its slot
declared by a pull request into the Personalspace (root decision 0171, addendum of
2026-10-13). One generator, `planModuleScaffold` in `src/modules/scaffold.ts`, ported from
the root with its templates (`src/modules/templates/README.md`); the use case is
`planModuleCreate` in `src/modules/module-create.ts`, the CLI `src/modules/module-create-cli.ts`.

**CLI first.** `lazurio module create personalspace/<module> --stack <stack> [--name
<name>] [--port N] (--dry-run | --confirm <plan>) [--folder <F>] [--json]`. The Launchpad has no route for it:
the user's agent runs it (M1's prompt hands it over). `--json` prints one line per step
(`{"kind": "module-create-step", "key": "plan", "state": …}`), then the report
`lazurio.module_create.report.v1`: `status` and `reason`, `module` (`name`, `slug`,
`stack`, `display_name`), `repository` (`full_name`, `private: true`, `create`), `slot`,
`lease`, `files` (path and size), `generated_by_install`, `tree_hash`, `plan` (a digest of
everything the user confirms), `manifest` (the manifest that receives the slot, its
`module_port_pool` and whether the slot's pull request adds it), `worktree`,
`module_root`, `warnings`, `issues` and `next_steps`. Exit status: 0 planned or
created, 1 created with a step left to the user, 2 refused (nothing written) or
usage.

**Checks, in order, all reading only.** Codes the root's `module create` has keep its
spelling; codes the content core has keep the content core's.

1. The name and the stack, with nothing read: `invalid_selector`, `unknown_stack`,
   `invalid_slug`, `reserved_slug` (the root's list and the gateway's labels).
   `<Organization>/<module>` is the Organization form (below). `--teams` with
   `personalspace` is a usage error.
2. A Personalspace on this preset (`personalspace-not-here`) and installed
   (`personalspace-absent`, next step `lazurio personalspace install`).
3. Held by gh's account (#186): the holder decision's reasons (`github-signed-out`,
   `github-unavailable`, `github-identity-mismatch`, `personalspace-ambiguous`,
   `personalspace-unavailable`, `personalspace-foreign`, `personalspace-not-owned`,
   `personalspace-public`).
4. The layout. The task worktree is the cwd's checkout when it shares the held
   Personalspace's Git and is not the Personalspace itself; the slot goes into its
   `modules.manifest.json`, otherwise into the Personalspace's
   (`modules_manifest_missing`, `manifest_invalid`). A declared `module_port_pool` must lie
   in `23000`–`23099` (`personalspace-pool-invalid`); without one the reserved range is
   used and the slot's pull request declares it. `workspace/` is a real directory of the
   user (`personalspace-unavailable`), Git ignores `workspace/<module>`
   (`personalspace-workspace-tracked`), and no directory (`directory_exists`) and no slot
   of the Personalspace or the task branch (`slot_exists`) has that name, letter case
   ignored. The template's example slot `workspace/personal-notes` is an ordinary
   declared slot: it is left as it is and conflicts only with that name. A Personalspace
   that still names the template's placeholder owner (`owner-github-username`, #377) is
   a warning with its next step, never a refusal; the command does not name the owner.
5. The plan: the slot and a lease of the pool (`port_outside_pool`, `port_taken`,
   `pool_exhausted`, `port_not_allowed`), avoiding every lease the Folder's modules
   declare (every Organization's `workspace/*`, `mission-control`, `design-system`, and
   the Personalspace's modules) and the Environment's own ports.
6. GitHub has no `<login>/<module>`, letter case ignored (`repository-exists`; an
   existing repository is never taken over; `github-unavailable` when GitHub does not
   answer).

A dry run writes nothing and asks GitHub only reads: whose the Personalspace is (`GET
user`, `GET repos/<login>/<login>_GEN3`) and `GET repos/<login>/<module>`. Its next steps
name the task worktree (`personalspace/.worktrees/<task>`, beside the owner directory,
never in it and never a second directory of `personalspace/`), ask the agent to show the
user the plan and create nothing before they confirm it, and give the exact command of
the real run with the plan's digest.

**The real run** (`createPersonalModule` in `src/modules/module-create-run.ts`, decision
F52 point 7) runs only with `--confirm <plan>`, under the Folder's content lock
(`content-busy`), from a task worktree of the held Personalspace in exactly
`personalspace/.worktrees/<task>` on a branch of its own
(`personalspace_root_not_task_worktree`, `personalspace_worktree_misplaced`,
`personalspace_root_on_main`), and only for the
plan whose digest the user confirmed: every check runs again and a different plan is
`plan-changed`. Its steps, one JSON line each with `--json`: `write` (the files into a
marked temporary sibling `workspace/.<module>.lazurio-content-<hex>`, through
`publishNewCheckout` in `src/content/materialize.ts`, the content install's own
publication), `prepare` (`bun install --cwd app/v1` with `~/.local/bin/bun`, or `uv lock
--directory app/v1`; a failure is an issue and the run goes on), `commit` (`git init` on
`main` and one commit by the user's Git identity, else by their GitHub identity
(profile name or login, `<id>+<login>@users.noreply.github.com`) given per commit and never
configured; `commit-failed` stops only when neither is known), `create`
(`POST /user/repos` with `private=true` through gh; GitHub's answer must say private, the
holder's login and the planned name, or the run stops with nothing placed:
`create-failed`, `not-private`, or `create-uncertain` when GitHub did not confirm the
creation but has the name now, its answer lost or the name taken meanwhile: never
adopted, `action_required`, the user looks at it), `place` (the no-replace rename into `workspace/<module>`), `push` (`main`,
with gh as the credential helper of an HTTPS remote; `push-failed` keeps the module
placed and names the exact command), `declare` (the slot, and the pool the Personalspace
lacks, into the task worktree's `modules.manifest.json` with `insertModulePortPoolText`
and `insertModuleSlotText`; never the Personalspace's own tracked files) and `check` (the
catalog lists `personalspace/<module>`). A repository is never adopted, and one the run
created is never deleted: a stop after its creation is `action_required` and says what to
do with it. Then the user's agent commits the manifest, pushes the branch and opens the
pull request into `<login>/<login>_GEN3`; its merge is the user's Publication.

**An Organization's module** (F52's addendum of 2026-10-14, #267): `lazurio module
create <Organization>/<module> --stack <stack> --teams <team,team> …`, the same plan,
dry run and digest, planned by `planOrganizationModule` in
`src/modules/module-create-organization.ts` and run by the same `createModule`. The
Organization is named by its slug, its directory or its GitHub login. Only an
active Owner of the Organization (`organization-owner-required`), never on a Team
Environment (`team-environment`); `--teams` required (`teams-required`), each a Team of
`lazurio.organization.json` that exists on GitHub (`unknown_team`,
`team-not-on-github`, `team-binding-mismatch`); the Organization found in the catalog
and resolving cleanly, also in the task branch (`organization_not_found`,
`organization_ambiguous`, `organization_manifest_not_mutation_safe`,
`organization-not-bound`); its pool out of `23000`–`23099`
(`organization-pool-invalid`). The run needs a linked worktree of the Organization root
in `<root>/.worktrees/root/<task>` on a branch of its own
(`organization_root_not_task_worktree`, `organization_worktree_misplaced`,
`organization_root_on_main`). It creates `<login>/<module>` with `POST
/orgs/<login>/repos`, places the module in the primary checkout's `workspace/<module>`,
grants each Team Write after the push (step `grant`, read back; `grant-failed` names the
exact `gh api` command), and declares the slot in the task worktree with the
Organization's regenerated projection (`company.gen3.json` and the digest in
`lazurio.organization.json`, `src/modules/organization-declaration.ts`), so the root
still resolves `transition` (or `current`) when the pull request is merged. Its check
reads the task worktree's documents and the placed module; the catalog lists the module
after the merge. Tests: `tests/organization-module-create.test.ts`.

**A module with data** (`--data`, F52's second addendum of 2026-10-14), in either
form and only for a stack with a Bun app: the app depends on one released
`@lazurio/repository-db`, the module ignores `db/`, and after the push the step `data`
creates the private repository `<owner>/<slug>-data` (verified as the module's, granted
to its Teams), mounts it with the app's own `repository-db init` on `v3` (the host's
`initData`, `processDataInit` in `module-create-cli.ts`), and the slot
`workspace/<slug>/db` (`repository_db_mount`) is declared after the module's.

**`module prepare` is dispatched.** `src/cli.ts` sent only `start`, `stop`, `status` and
`logs` to the module command, so `lazurio module prepare` fell to the catalog's usage
(issue #114); every verb of `moduleVerbs` reaches it now, and `create` its own command.

**Verification.** `tests/personal-module-create.test.ts`: the exact plan from a task
worktree and from outside one, on a workstation and on a personal Remote Environment;
the filesystem unchanged and only GitHub reads in the stub's log; leases of an
Organization's module and of a personal module avoided; a declared pool; and every
refusal above against Personalspaces as the install leaves them
(`tests/fixtures/personalspace-template.ts`, the template's own files with their
placeholders). The real run against a stub GitHub that creates bare repositories and the
product's git: the repository created once and verified, `main` pushed with every
planned file and the lockfile, the module placed as a clean checkout of it, the slot and
the pool in the task worktree byte for byte, the Personalspace's tracked files
unchanged; a creation that fails, is taken meanwhile, is public or of another account
(nothing placed, nothing pushed); a failed push and a failed install (the run goes on); no
Git identity (GitHub's noreply identity as author and committer, no configuration written) and
neither identity (nothing created); the run's own refusals; and the CLI's lines and exit
codes. `tests/module-create-cli.test.ts`: through `runCli`, the usage errors, the
refusals by name, `module prepare` reaching the lifecycle and the help; and the plan end
to end in a child process of `src/cli.ts` with a fake gh and the real git.
`tests/content-github.test.ts`: `POST /user/repos` and its answers.
`tests/personalspace-modules.test.ts`: a created module listed the same by the reader,
`module list --json` and `POST /api/catalog`, naming no owner, and its status through the
lifecycle. Starting a freshly created app needs its dependencies from the network, so
the tests start held personal modules from a runnable fixture instead.

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

**Read-only.** Doctor adds one check of its own, the user's Codex app-server
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
| tools | `tool` | `toolsOverview` (tiers, enabled), else `toolsStatus` over the catalog | required missing `fail required-missing`; `warn recommended-missing`, `warn enabled-missing`, `warn version-unreadable`; `skipped not-enabled`; `skipped not-offered` for a missing tool Lazurio does not offer in this Environment (`toolOffered`: bitwarden outside a Remote Environment on Linux, decisions F43 and F53; gogcli in a work Environment, F44); Executor is not a tool row but its own check; `signIn`/`ssh` ids with `--sign-in`, and with it `warn ssh-not-linked` for a signed-in gh whose SSH proof failed where the Environment signs in as its user (F19's addendum of 2026-10-19) |
| tools | `executor` | `executorStatus` ([F44](decisions.md#f44--executor-in-every-remote-environment-installed-run-and-connected-to-the-agents-by-lazurio)): the entry and its marker, `systemctl --user show` of `sh.executor.daemon.service` and its drop-in, `GET 127.0.0.1:4789/api/health`, `codex mcp get executor --json` and `~/.claude.json`; never `fail`, never in `recover` | `ok` running with the installed agents connected (context `toolVersion`, `executorService`, `codexMcp`, `claudeMcp`); `warn executor-not-installed`, `executor-outdated`, `executor-conflict`, `executor-not-running`, `executor-incomplete` (the next step is `lazurio executor setup`, or Settings → Tools → executor); `skipped not-offered` (a computer, not the operator), `skipped handover-unreadable` |
| organizations | `catalog` | `readFolderCatalog` | counts of the Organizations and their modules only: the Personalspace group is never counted or named; `warn catalog-unreadable` |
| organizations | `organization` | catalog entry | `warn` with the Organization reason; a template `skipped template-not-runtime` |
| organizations | `module` | catalog entry | `warn` with the module or Organization reason |
| launchpad | `launchpad-unit` | `collectRecovery` unit (Linux, supervised) | `fail unit-*`; `skipped no-user-manager`, `not-supervised` |
| launchpad | `launchpad-health` | `collectRecovery` health socket, `answer` normal/recovery/none/unexpected | `fail launchpad-recovery-mode`, `launchpad-not-answering`, `launchpad-version-mismatch` |
| machine | `machine-entry` | the recorded binding's `entry` on a hosted preset | `warn entry-not-recorded`; `skipped not-hosted` |
| machine | `codex-app-server` | `observeCodexAppServer` ([F29](decisions.md#f29--entry-units-of-a-remote-environment-the-launchpad-t3-code-and-the-operators-codex-app-server)): `systemctl --user show` of `lazurio-codex-app-server.service`, then, when it is active, `codex app-server daemon version` from `~/.local/bin/codex` (10 s, PATH and HOME only); never `fail`, never in `recover` | `ok` when active and Codex answers `running`; `warn app-server-outdated` with `appServerVersion` and `cliVersion` when Codex answers `running` with two different versions (an app-server a client started over SSH outside the unit; replacing it is the user's call, `manual/troubleshooting.md`, issue #173), `warn daemon-not-running`, `warn daemon-state-unknown`, `warn unit-failed`, `unit-inactive`, `unit-not-loaded` (the next step is `systemctl --user start lazurio-codex-app-server.service`, or `lazurio install --service systemd-user --folder <Folder>` when the unit is missing); `skipped no-user-manager`, `not-supervised`, `not-hosted`, `codex-missing`, `user-manager-unreachable`, `unit-state-unknown` |
| machine | `environment-browser` | `observeEnvironmentBrowser` ([F38](decisions.md#f38--the-environment-browser-of-a-remote-environment-one-chromium-a-window-per-thread-a-view-behind-the-gateway)): `systemctl --user show` of `lazurio-display.service`, `lazurio-browser.service` and `lazurio-browser-view.service`, then the browser's DevTools (`127.0.0.1:9222/json/version`) and the view (`127.0.0.1:<entry.browser.listen_port>/`), 3 s each, then every holder file in `$XDG_RUNTIME_DIR/lazurio-browser/holders` (`unreadableHolderFiles`, root decision 0191 point 32); never `fail`, never in `recover`, never `agent-browser doctor` (it cleans files) | `ok` when all three are active, both answer and every holder file can be read; `warn browser-unit-not-loaded`, `browser-unit-failed`, `browser-unit-inactive` with the `unit`, `warn browser-not-answering`, `browser-view-not-answering`, `warn browser-holder-unreadable` with the `files` (or the directory) it could not read: a file the hub read before keeps the tabs of its last reading until it can be read again, a file the hub has not read since the view started holds no tab, and doctor cannot tell the two apart; `skipped no-user-manager`, `not-supervised`, `not-hosted`, `browser-not-declared`, `user-manager-unreachable` |
| machine | `computer-use` | `observeComputerUse` ([F59](decisions.md#f59--computer-use-on-a-remote-environment-the-cua-drivers-daemon-on-the-screen-one-mcp-server-computer-for-every-agent)): `~/.local/bin/cua-driver` a regular executable, `systemctl --user show` of `lazurio-computer.service`, then the driver's own `cua-driver doctor --json` (15 s, on `DISPLAY=:1` with `XDG_SESSION_TYPE=x11`, the user manager's session bus, telemetry and update check off; on Linux it only reads), then `codex mcp get computer --json` and `~/.claude.json`; never `fail`, never in `recover` | `ok` when the unit is active, the driver's doctor reports an X11 display and a reachable AT-SPI bus and every installed harness has Lazurio's entry (context `toolVersion`, the driver's version, `codexMcp`, `claudeMcp`); `warn computer-driver-missing` (the next step is Machines' install of the pinned driver), `warn computer-unit-not-loaded`, `computer-unit-failed`, `computer-unit-inactive` (`systemctl --user status lazurio-computer.service`, or the same install again), `warn computer-doctor-unreadable` (no JSON answer in time), `warn computer-display-unavailable` (the display probe is not X11, or the X11 connection is an error; no windows yet is still X11), `warn computer-accessibility-unavailable` (no AT-SPI bus: `at-spi2-core`, `dbus-user-session` and `gdbus` are Machines' packages), `warn computer-agents-missing` with `codexMcp`/`claudeMcp` (an entry of that name that is not Lazurio's is `conflict` and stays); `skipped no-user-manager`, `not-supervised`, `not-hosted`, `browser-not-declared` (no screen), `user-manager-unreachable` |

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
Machines' origin template, launchpad-parity B4). The Personalspace counts as the
gateway's catalog sees it, whoever holds it (#186): when its one owner directory has
`workspace/<id>/lazurio.module.json` (`personalspaceMayOwn`; only that path is looked
at). So an Organization's module is resolved without GitHub, an id that the
Personalspace's directory has too stays ambiguous, and only an id the Personalspace
alone may have asks whose it is (decision F9's addendum of 2026-10-05), for at most
the request's wait; a Personalspace this Environment's account does not hold lists no
module (`module-unknown`). Then the catalog's own rules, as for
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
| 503 | the `lazurio module status` answer with `operation: "ensure"` (`outcome: "start-pending"` while the start still runs) | "starting", reload in 2 s | not yet healthy; a report-only request to an app that does not run; `closing`, `coordination-busy`; `personalspace-unverified` (whose Personalspace this is was not decided within the wait; the decision goes on) |
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

**The Environment pairs its own browser (decision of the Organization Admin,
2026-10-17).** This replaces the rule of 2026-09-21 from root DEV-6616: T3 Code opened
directly shows T3's own pairing page, and the T3 Code fork stays untouched for it. Until
now only the Launchpad's Chat click paired. Every other way into Chat ended on that page:
a bookmark, the shell's switch on another app, the Dashboard, another Environment's Chat
in the picker. Now the Environment pairs every browser the gateway admitted, whichever
way it enters:

- T3 Code's web client (Lazurio/t3code#84) asks for `GET /.lazurio/chat/pairing` on
  its own origin whenever it has no session, or only a legacy one. The gateway forwards
  the request to this Launchpad behind the unchanged admission. The client takes only
  the exact answer (200 without a redirect, JSON, the three keys of the table below and
  no other) within five seconds, and anything else leaves T3's own pairing page (how the
  request arrives: [hosted entry](hosted-entry.md#the-t3-code-link-chat)).
- Such a browser gets T3's operator pairing wherever the installed T3 Code offers it,
  Team Environments included: `t3 lazurio pairing`, which T3 Code announces as
  `operatorPairing` in `t3 lazurio capabilities`. Elsewhere it gets the standard pairing,
  `t3 auth pairing create`. T3 defines the operator pairing's scopes. The standard one
  names its own: T3 Code v0.1.0's standard client scopes (`standardPairingScopes`), never
  `access:*` or `relay:write`, which T3 Code v0.1.1 added to its default grant
  (Lazurio/t3code#97). A visitor on a public Environment thus never manages the
  Environment's access or its T3 Connect.
- A public Environment's visitors (root decision 0204,
  [F55](decisions.md#f55--a-public-environment-a-demo-onboarding-a-quiet-notice-that-it-is-public-nothing-to-sign-in-to))
  always get the standard pairing.
- Each pairing is labelled with the admitted user's Lazurio username, `Lazurio ·
  <username>`, so T3 Code's Settings → Connections shows whose browser each session is.
- T3 Code's desktop and mobile apps pair with device tokens from T3's Settings →
  Connections, on Environments reached over the tailnet. A public lane has no native
  path; that is intended for now.

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

Since the decision of 2026-10-17 the call is chosen and labelled as described above. The
launcher is first asked `t3 lazurio capabilities`, through the reader the provider
refresh uses (`t3Offers` in `src/tools/ai-services.ts`); on a public Environment it is
not asked. Only `operatorPairing: true` selects `t3 lazurio pairing`; anything else, a
T3 Code without the command included, selects `t3 auth pairing create`. Both take
`--base-dir ~/.t3 --ttl 60s --label "Lazurio · <username>"`, with only `Lazurio` where
the admission names no Lazurio username and for `lazurio chat link`. The standard call
adds `--json`; `t3 lazurio pairing` always prints the same JSON and takes no `--json`,
which T3's CLI would refuse as a flag it does not know (Lazurio/t3code#84). Before the
standard call the launcher is asked `t3 --version`: from T3 Code v0.1.0 on, which takes
`--scope`, the call adds one `--scope` for each of `standardPairingScopes`, which replaces
T3's default set; an older T3 Code refuses the flag and pairs as before; with no version
to read nobody is paired (`t3-pairing-failed`). The
username counts only by its own rule, so the label stays short plain text. The answer
(`id`, `credential`, `label`, `scopes`, `expiresAt`) is read for `credential` and
`expiresAt`, and nothing else of it is passed on. One function mints for the click, the
self-pairing and the CLI: `mintChatPairing` in `src/launchpad/chat.ts`.

**Routes.** Behind the admission every other route has (the gateway's session cookie
hosted, the fragment token locally):

| Route | Answer |
|---|---|
| `GET /api/entry` | `{kind: "entry", entry: {launchpadOrigin, t3codeOrigin, moduleOriginTemplate, mausbotOrigin?, browserOrigin?} \| null}`: the recorded entry's public parts, read-only (`browserOrigin` offers [the right panel](#the-right-panel-the-environment-browser)); the auth endpoint, cookie name and port stay on the server. `null` on a workstation. Any other method: 405. Recovery mode answers it too. |
| `POST /api/chat/pair` (body `{}`) | `{kind: "chat-link", url}` with `url` = `<t3codeOrigin>/pair#token=…`; `409 {kind: "blocked", reason}` with `t3-launcher-missing` (no `t3` on PATH, nothing run) or `t3-pairing-failed` (a non-zero exit, a timeout of 15 s, output that is not JSON, a credential of another shape or no readable `expiresAt`); `404` on a workstation. Same-origin rule of every state-changing request. Not in Recovery mode (its typed refusal). |
| `GET /.lazurio/chat/pairing` | T3 Code's self-pairing (decision of 2026-10-17): `200` with exactly `{"kind":"chat-pairing","credential":"…","expiresAt":"…"}` and `Cache-Control: no-store`, minted for the admitted user as the click's pairing is. Only a page's own script fetch: `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode` `cors` or `same-origin`, and neither `Sec-Purpose` nor `Purpose` naming a prefetch or prerender. Anything else, `403 {error: "not-allowed"}` with nothing run: a navigation (a bookmark, a link, a typed address), a subresource, a speculative load, another site, a request without Fetch Metadata. `409 {kind: "blocked", reason}` as above; a query: 400; any method but GET, HEAD included (it mints nothing): 405; `404` on a workstation. Recovery mode answers it with its plain page and mints nothing. |
| `GET /api/chat/prompt-handoff` | `{kind: "chat-prompt-handoff", accepted}`: whether Chat on this Environment takes a prepared prompt by link ([prompt hand-off](#prompt-hand-off-to-chat)); `accepted: false` on a workstation without running anything. Any other method: 405. |

**CLI.** `lazurio chat link [--folder <absolute Folder>] [--plain] [--json]`
(`src/launchpad/chat-cli.ts`) is the same entry for an agent in a terminal: it reads the
Folder's recorded entry as the Launchpad start does (`readStartState`, without the lock,
so it writes nothing), found as for `lazurio doctor` (`--folder`, the supervised unit's,
or on a hosted Machine the declared operator's), and answers from the same
`issueChatLink` with the same tools environment (`toolsEnvironmentOf`, this process's
`PATH` and `HOME`), through `chatLinkAnswer` in `src/launchpad/chat.ts`. With a pairing
the link `<t3codeOrigin>/pair#token=…` alone is on stdout, for the user's browser;
without one, on `t3-launcher-missing`, `t3-pairing-failed` or with `--plain`
(`plain-requested`), stdout carries the plain `t3codeOrigin`, where a T3 Code that
pairs itself asks this Launchpad and an older one asks the browser to pair, and stderr
one sentence naming the reason, in the Folder's language.
Without a recorded entry (`not-hosted`) there is no link: exit 10 and the sentence on
stderr. `--json` prints `{kind: "chat-link", url, pairing, reason?}` (`url: null` when
not hosted). Stderr never carries the token. Exit status: 0 a link (paired or plain), 10
not hosted, 2 usage, 1 the Folder could not be read (its enumerated start refusal, never
a path). The generated manual tells agents on a hosted Machine to hand this link to the
user, never a localhost one (base-instructions-13).

**Page.** `src/launchpad/chat-view.ts` (pure, tested) accepts the entry only in the
recorded shapes and a pairing link only on the recorded T3 Code origin, path `/pair`, no
query, a `token` fragment. The Chat link's `href` is `t3codeOrigin` itself, so a modified
click (a new tab) opens T3 Code as a link does. A plain click asks for a pairing link and
follows it in this tab, as the resident did; when there is none (no launcher, a refused
call) it follows the plain origin, where T3 Code asks for its pairing itself and, since
the same minting fails there too, shows its own pairing page. The click keeps pairing on
the way although T3 Code now pairs itself: that is harmless, and older T3 Code builds
without the self-pairing need it. It can go once every Environment's T3 Code pairs
itself. Without an entry (a workstation) the entry is absent, as the resident's button:
T3 Code runs wherever the user runs it (launchpad-parity D). The **Recovery page**
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

**Verification 2026-10-17 (the self-pairing).** `tests/launchpad-chat.test.ts`, behind
the same fake auth endpoint, which names a Lazurio username where a test needs one, and
with a fake launcher that answers `t3 lazurio capabilities` with or without
`operatorPairing` and, as T3's CLI, refuses a `--json` to `t3 lazurio pairing`. A
page's own fetch, sent with the Launchpad's Host, the session cookie and a script's
Fetch Metadata, as the gateway forwards it: 200 without a redirect, exactly the JSON
document, `no-store`, T3's id, label and scopes not passed on, `t3 lazurio pairing`
without `--json` labelled `Lazurio · <username>`, and the click minting through the
same calls. The
refusals, each with nothing run: no session, a refused session, T3 Code's own Host, no
Fetch Metadata, another site, a sibling site, a typed address, a navigation, a
subresource, `Sec-Purpose` and `Purpose` prefetches and a prerender, a query, HEAD and
POST. A public Environment's visitor gets the standard call, and T3 Code is not asked
for its capabilities. A Team Environment's user gets the operator call. Without `t3`,
or with a failing, unreadable, misshaped or expiry-less answer: 409 with one reason and
never the output. On a workstation: 403 without the token, 404 with it. As unit tests,
without a server: the label (only a Lazurio username, at most 49 characters), the Fetch
Metadata rule and the command chosen for every answer of the capabilities: `true`,
`false`, `"true"`, `1`, none, no `lazurio` command, not JSON, an array, a timeout or a
failed call. `tests/launchpad-recovery-page.test.ts`: Recovery mode answers the
self-pairing with its plain page. `tests/chat-link-cli.test.ts`: the CLI's calls with
the capabilities first and the label `Lazurio`. The provider refresh reads the
capabilities through the same `t3Offers`; its tests are unchanged and pass. A real
gateway, a real T3 Code with the fork's self-pairing and a real browser were **not**
exercised, and neither was how long the two `t3` calls take on an Environment against
the client's five seconds.

## Lazurio MausBot entry

DEV-6632 (decision 0169). On a Machine that runs Lazurio MausBot, the Environment's
bot-team app (Lazurio's fork of OpenMausBot), the sidebar shows **Lazurio MausBot** next
to Chat and enters it the same way: the Launchpad runs as the same Machine user as
MausBot, mints a one-time pairing code and opens MausBot's pairing form with that code
already filled in, so the user never types or copies a code. OpenMausBot's `/pair`
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
the profile is loaded (with `signIn: true`, so the sign-in probes run, or the
Launchpad's reading of the last minute answers), after every
change (without them; the last known sign-ins stay on the cards) and on "Refresh
status" (with them again and `fresh: true`, read anew), and shows:

- no introduction (root decision 0188, Matěj 2026-10-04: no paragraph that only
  restates the page), no tier notes, no "Zjištěno v …" and no note on a shared (Team)
  Environment: the "?" beside the heading explains the section, in a Team Environment
  that its accounts are the whole Team's ([the guide](#the-guide-decision-f56), F56's
  addendum (2) of 2026-10-18); the warning stays in the confirmation of an enable on a
  shared Environment;
- three groups, **Required**, **Recommended** and **Optional**, in catalog order, each
  a settings group of rows. A row carries on the left the tool's real name (gh,
  composio, bitwarden, wacli, gogcli, neon: what an agent says and what is searched for), one
  plain sentence on what it is for (root decision 0188; `toolDescription` in
  `tools-view.ts`, a page-only text: the catalog's `activation.purpose` is rendered into
  the agents' generated files and stays as it is) and one line of its state
  (`connectionLine`): "Připojeno jako <account>" / "Connected as <account>" (with the
  organization for composio), "Nepřipojeno", "Připojení nezjištěno", "Připojení se
  nezjišťovalo", or "Ještě není přidané" when it is not installed ("Až se <tool>
  nainstaluje, agenti ho začnou používat." when its switch is on, Matěj 2026-10-09:
  said only while it is true, from the live state). The installed
  version, a failed version check, a PATH outside the standard and whether gh's SSH key
  is linked are in its Details; a key that is not linked (in the warning colour) or not
  verified stays on the line, and gh's account is then not in the success colour, which
  only a working link gets (F19's addendum of 2026-10-19, #515), and no line has it while
  the rows show an older reading as being checked (#551). A sign-in the page runs
  of the tool, its window closed or open, says "Čekám na přihlášení…" or "Dokončuji
  připojení…" there with the waiting mark (#516). On the right the one action
  ("Připojit" / "Connect"; "Přidat a
  připojit" / "Add and connect" when it is not installed yet; "Link SSH key" before
  "Odpojit" / "Disconnect"; or, for a tool an agent sets up, "Připojit s pomocí agenta" /
  "Connect with an agent") and the switch with its visible label
  "Used by agents" / "Používají agenti" ("Always on" for a required tool). A signed-in
  gh whose key is not linked shows "Link SSH key" as the row's primary action. A
  sign-in completed in this Launchpad session turns the switch on (`autoEnable`, Matěj
  2026-10-04): after the reading that follows the sign-in, so the change is made at the
  current revision, never for a tool that was signed in before (`already`), and the
  user may turn it off again. On a Team Environment (the preset `hosted-organization-team`,
  the shared case) the gh row has no "Sign in" or "Link SSH key", and "Install" instead
  of "Install and sign in" while gh is missing (its notice ends with the Team
  sentence); a subdued sentence says that this Team Environment works in GitHub through
  Lazurio for GitHub, set up by the Organization, and that personal GitHub accounts are
  not signed in here (Matěj 2026-09-28). Its sign-in line stays, in the neutral
  colour, reads "Works as lazurio-for-github[bot]" when gh works as the Organization's
  App identity (the brokered gh), and goes on with "· Uses Lazurio for GitHub" instead
  of the state of an SSH key. The agent fallback in Details hands gh's Team prompt,
  which signs nobody in. "Sign
  out" appears there only while a user's account is signed in (gh's `signIn.identity`
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
  MCP servers are never recorded in the Folder, so this card enables nothing;
- on an Organization's Environment, a tool the Organization does not allow
  ([F45](decisions.md#f45--organization-settings-reach-the-environment-asked-through-its-relay-recorded-in-the-folder-reported-back),
  today Composio) has its switch locked off, labelled "Nastavuje Organizace" / "Set by
  the Organization" (`organizationView` in `tools-view.ts`), one subdued sentence "Composio
  tu nepovoluje Organizace." / "The Organization does not allow Composio here." and,
  where the user had it on, that the choice is kept for when the Organization allows
  it; no "Add and connect", "Connect" or agent fallback, while "Disconnect" stays for a
  sign-in left from before. Its Details gain "Organization settings"
  (`organizationDetails`): that only the Organization's Admin changes it, where this
  Environment gets the settings, the version applied and when, when it last asked, and
  why nothing new came (the Dashboard silent, the Environment's identity missing, the
  Organization's settings invalid, the repository unreadable, the record unreadable). A
  tool the Organization allows explicitly keeps its switch and says "Organizace ho
  povoluje." The first reading and "Refresh status" ask the Organization's settings
  first, at most five seconds.

**Enable, disable and notes** take one click (the switch is a `role="switch"` button
named "Used by agents: <tool>" with `aria-checked`, so its name holds the visible
label and the tool). The button sends the full next
selection (and, for a note, the full next set of notes) with the shown revision to
`/api/tools/update`; the page no longer uses `/api/tools/preview`, which stays for
other clients. After a recorded change the card confirms what happened in one plain
sentence ("composio teď používají agenti." / "Agents now use composio."; only "Zapnuto."
/ "Switched on." for a tool that is not installed, whose row says the rest), with an
"Undo" that sends the state before the change at the new revision and takes the
focus once the page has read the new state; on the Team preset the shared sign-ins
warning follows an enable. Neither the card nor the section's header names the
Folder, its revision, a path or a command (Matěj 2026-10-09: plain language for normal
users; technical details only under Podrobnosti); the header says only when the
tools were read. The whole page then reloads its state, so the revision advances
for the profile form as well and a profile preview made before the change is dropped.
A `blocked` answer becomes one plain sentence in the card that nothing was saved
(`stale-revision`, `drift`, `incomplete-state` or any other reason) with a "Reload"
button; an answer that cannot be read is reported as unconfirmed, never as refused.
The technical part (a drifted file's path, the reason's code, the CLI command, and a
removed SSH key's fingerprint after "Sign out") is under the tool's Details as "What
happened" / "Co se stalo". The card is said again from the tool as the page shows it
at every render (`toolNoticeView`), so it never contradicts the row, and it ends,
with its Undo, at the next act on that tool (a change, an installation, a sign-in or
a sign-out), at Refresh status or Reload, and at a reading of another Folder revision
(`noticeHolds`), where the Undo would be refused. A
required tool has no toggle and shows "Always on"; it can carry a note.

**Set up with an agent** opens a modal `<dialog>` with the prepared prompt in a
read-only text area and "Copy prompt" (Clipboard API; where it is unavailable the text
is selected for a keyboard copy). The prompt contains no secret, and the user
pastes it into a new chat in T3 Code on the Machine. Focus moves into the dialog and
returns to the button that opened it (opening its "Details" again when the button sits
there). Every activatable tool has this button.

**Install and sign in, Sign in, Sign out** (decision F19,
[environment-tools.md](environment-tools.md#curated-installation-and-login-decision-f19)).
A `launchpad` tool shows "Install and sign in" when it is missing, "Sign in" when it
is installed and not known to be signed in, and "Sign out" when it is signed in; an
`agent` tool shows none of them. The first two open a second dialog: its title names
the tool, a list of plain steps ("Installing", "Waiting for you", "Signed in", each
marked done, in progress, next or did not finish; none for composio) and a status
line with `aria-live`; focus moves to the title. On a shared Environment the shared sign-ins
warning and "Continue" come first. The dialog then installs (`/api/tools/install`) when
needed and starts the login (`/api/tools/login/start`), and polls
`/api/tools/login/poll` every 2 seconds with the session handle, one poll loop per
sign-in (`createLoginPoll`). Its × in the corner and Escape close the window and never
end a sign-in that starts or runs (`loginCloseAction`, F19's addendum of 2026-10-19,
#516): the page keeps its handle and polls on, also while the page is hidden (the poll
belongs to the running sign-in; only the update pill polls only while the page is shown,
plan DEV-6656), its end runs as with the window open, and opening the same tool's
sign-in again (its row, Začínáme, the line in Apps) shows it instead of starting
another. Only "Zrušit" in the dialog's foot sends
`/api/tools/login/cancel`, offered only while a code, link or QR code waits
(`loginCancelOffered`). Closing clears the code, link or QR from the page and returns
focus to the card. Until the tool shows something to act on, the status
line says "Starting the sign-in…" and the body, never the same sentence, says that
Lazurio waits for the tool's first step and for at most a minute (#98). A start that
gets no answer within 45 seconds ends the dialog with "The Launchpad did not answer in
time"; a poll without an answer ends nothing and is asked again, until a minute after
the session's own end (`loginPollGivenUp`); and a sign-in that ends as `not-installed`,
`spawn-failed`, `tool-exit`, `not-confirmed` or `no-challenge` shows a sentence that
says what to do. A tool that was signed in
before (`signed-in` with `already: true`) is reported as "already signed in" and the
card's state is read again. What it shows:

- gh: the sentence that the code is entered on any device, the code in large
  selectable characters (with a spelled-out accessible name) and a link to
  `https://github.com/login/device` in a new tab;
- composio: a link to the sign-in page in a new tab; after the sign-in (decision F42,
  addendum (2), note of 2026-10-17) only what is left to do, read from
  `/api/tools/composio/organizations` (`composioDialogView` in `tools-view.ts`).
  The organization of the Organization's name missing: the title "Ještě jeden krok
  v Composiu", one line, the name in a read-only box with "Kopírovat", the drawing
  of Composio's dashboard (`composio-scene.ts`; its CSS in `index.html`, the
  finished frame under `prefers-reduced-motion`), "Otevřít Composio" to the
  dashboard's root and a quiet waiting line; two of the name: one sentence and the
  same button; nothing to do there: one sentence. Meanwhile the dialog reads again
  after 4 s, growing to every 30 s, paused while the page is hidden and at once when
  it shows again, until it is connected or closed (`composioPollDelay`,
  `composioPollNext`). Connected: "Composio je připojené" with the account and the
  organization the reading marks current, a native select where the user
  chooses among several (it switches on change), and "Vybrat aplikace" to Apps →
  Integrace in place of "Done";
- wacli: the path in WhatsApp in words, the QR code as an image of the server's SVG
  (280 CSS px, white, quiet zone, `image-rendering: pixelated`, a text alternative that
  says what to do), replaced in place when the code rotates, and "Pair with a phone
  number instead" (a phone field, then the pairing code in large characters and "Show
  the QR code instead"). After pairing, the note that the first sync runs in the
  background.

**Update** (decision F42, addendum (3) of 2026-10-13). The tools reading carries the
build Lazurio pins for a tool (`pinned`; today only composio, Lazurio's build of the
Composio CLI, `0.4.3-lazurio.2` since 2026-10-19). A composio whose version is not
that build, an earlier build of Lazurio's (`0.4.3-lazurio.1`) included, says so in its
Details ("Toto není sestavení, které Lazurio používá (0.4.3-lazurio.2)." / "This is not
the build Lazurio uses (0.4.3-lazurio.2).", the amber attention state) and its row offers
"Aktualizovat" / "Update" (named "Update composio") where the update can work: a
`launchpad` tool this Environment offers, not refused by the Organization, installed
in the standard path (an installation elsewhere is never shadowed by a second copy, so
there is no button there). The click is the user's consent: it posts
`/api/tools/upgrade` `{tool}`, which runs the core of `lazurio tools update`
(composio's curated installer again at the pinned build, keeping the sign-in; one
installer run per tool at a time, shared with installation, `busy` otherwise; a tool
without a pinned build is refused as `update-unavailable`). While it runs the status
line says that the tool is being updated; the row then says the outcome ("composio
0.4.3-lazurio.2 je nainstalovaný; přihlášení zůstává." or that the update did not
finish, with why under "What happened" in Details) and the tools are read again.

**gh and its SSH key** (F19 addendum 2026-09-28). The gh dialog has a third step,
"Linking the SSH key", between "Waiting for you" and "Signed in": after the code is
entered, the status line says "Dokončuji připojení…" with the waiting mark and "Okno
můžete zavřít, Lazurio připojení dokončí samo." (F19's addendum of 2026-10-19; never
"connected" before the proof), and offers no "Zrušit". A linked key ends the dialog
with "The SSH key of this Machine is linked: git clone git@github.com:… works as
<account>" and whether the key was created now
(without a passphrase, so agents can use it) or an existing one is used unchanged, with
its path and fingerprint. A key that is not linked marks the step "did not finish" and
says, in one sentence each, that gh is signed in but git over SSH does not work yet and
why (a passphrase on the existing key, the key in use by another account, a differing
github.com host key, a failing proof, …), with "Finish with an agent" and "Try again",
which links the key only. A signed-in gh whose key is not linked or not verified shows
"Link SSH key" on its card: the same dialog, under gh's own title "Connect GitHub", with
the steps "Linking the SSH key" and "SSH key linked", and "Waiting for you" first with a
device code only when the gh sign-in may not manage SSH keys yet (the code widens the
sign-in, the text says so).
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

**The Environment's own vault** (decision F53, the wireframe of
prototypes-lazurio#33; it replaces F43's dialog). The Environment sets its vault up
itself: the installed Launchpad runs the one setup of `/api/tools/bitwarden/setup` in
the background after its start where the vault needs it (`vaultAtStart`, the rule of
Executor's, and `setUpAtStart`), and the `bitwarden` row (`bw`) only reads its state
(`/api/tools/bitwarden/status`, and `/refresh` when the sign-ins are probed: on load and
on "Refresh status"). A setup that runs is the state both answer, `202 {kind:
"vault-setting-up", job, phase}`, and the row follows it by its job whoever started it,
saying its step: "Instaluje se Bitwarden…", "Připravuje se účet trezoru…",
"Připravuje se trezor…", "Přihlašuje se…". Otherwise it says the state in few words:
"Připojeno", "Zatím nenastaveno", "Trezor se zakládá" (its creation not confirmed yet),
"Síť zatím účet trezoru nepovolila", "Trezor byl
odebrán" (a 0197 pilot's: "Přístup odebrán v trezoru"), "Trezor neodpovídá", "Nastavení
se nedokončilo", "Tento Environment zatím trezor nemá" (the handover names no vault),
"Čeká na váš Bitwarden" (a personal Environment whose user has not connected their
own Bitwarden yet, root decision 0203 point 7, with "Připojit", a link to the form of
Apps → Trezor, and no setup) and "V tomto Prostředí není k dispozici" on this
computer, which says no plan (F36's addendum of 2026-10-16) ("Connected", "Not set up
yet", …). Its
controls are "Otevřít trezor" once connected, a link in a new tab to
`<server_url>/#/vault?organizationId=<id>`, and one action only where a setup moves the
vault on: "Nastavit" when nothing set it up yet and "Zkusit znovu" after a setup that
stopped, a vault that did not answer or a creation not confirmed yet. A vault the network has not allowed or has
revoked, and a 0197 pilot, offer none; there is no dialog, no details section and no
disconnect. The setup in which the vault becomes ready turns the agents' switch on in the
Folder itself, once per vault (decision F53), so a user who turns it off keeps it off;
the page never turns it on, and after a setup it followed that ends connected it reads
the Folder again to show it. The state is accepted only in its exact form
(`src/launchpad/vault-view.ts`, `tests/vault-view.test.ts`); the DOM is
`src/launchpad/vault-panel.ts`.

**An agent's secret request** (decision F54, root decision 0198 point 9 (c); the
wireframe's `screens/SecretRequest.tsx` and the section of `EnvVault.tsx`). Trezor's
page in the Apps column (`/vault`) has below it the page of one request,
`/vault/requests/<id>`, a sub-route as Integrace has its forms (`pageRoute`; the
first-paint script agrees, `tests/launchpad-first-paint.test.ts`). The link
`lazurio vault request` printed before, `/settings/vault/requests/<id>`, opens the same
request for good ([F54's amendment of
2026-10-18](decisions.md#f54-amendment-of-2026-10-18-the-requests-page-under-trezor-the-old-addresses-kept-for-good)).
`src/launchpad/vault-requests-panel.ts` draws two places the Trezor page holds:
`#vault-requests`, "Žádosti agentů" with the count and one row per waiting request
(what the agent needs, its fields, "Zadat" to its page), shown only while one waits;
and `#vault-request`, the request's page: the need as its title, then why and where,
one input per field (a password input with "Zobrazit" for a secret one), the item it
becomes ("Uloží se do trezoru Prostředí jako položka …"), "Uložit do trezoru" once every
field has a value, and "Odmítnout"; afterwards "Uloženo do trezoru." or "Odmítnuto.".
A value goes from its input into the one `POST /api/vault/requests/<id>/save` and
nowhere else (no storage, address or log); the inputs are emptied once the request is
answered and kept after a refusal the user can retry ("Trezor teď neodpovídá. Zkuste
to prosím za chvíli."). A request answered meanwhile by someone else is read again.
The routes' answers are read in their exact shape and the texts made by
`src/launchpad/vault-requests-view.ts` (`tests/vault-requests-view.test.ts`). The Trezor
page (F53's addendum of 2026-10-14) holds `#vault-requests` above its vault and
`#vault-request` as the last of its section.

**Executor** (decision F44). The `executor` row reads its own state
(`/api/tools/executor/status`, beside every read of the tools) and says it in plain
words: "Běží", "Není nainstalovaný", "Čeká na aktualizaci", "Neběží", "Běží,
nastavení není dokončené", "Koliduje s jinou instalací", and "V tomto Prostředí není k
dispozici" on this computer ("Running", "Not installed", "Waiting for an update", "Not
running", "Running, setup not finished", "Conflicts with another installation", "Not
available in this Environment"; F36's addendum of 2026-10-16). Its one action is "Nainstalovat", "Aktualizovat" or "Opravit", which runs
`/api/tools/executor/setup` and asks again with its job while the line says the step
("Instaluje se…", "Spouští se…", "Připojují se agenti…"), or for a conflict "Vyřešit s
pomocí agenta", which opens a prepared prompt (show the user what conflicts and
remove it only with their consent). A setup the page did not start, the Launchpad's
own after its start (F44 addendum of 2026-10-11) or Install in another page, comes
back from the status read as its job and step; the row follows it the same way, with
no action until it ends. In the required group it has "Vždy zapnuto" where
it is offered and no switch. Details hold the version, the address
"127.0.0.1:4789 (jen tento Environment)", the service and the agents ("Codex:
připojený · Claude Code: není nainstalovaný"), and after a setup that stopped its stage
and reason; there is no link to Executor's console, which shows the access token. A
tool this Environment does not offer is listed only while it is switched on (so it can
be switched off, "Not offered in this Environment; agents do not use it.") or when its
own row says why (the vault and Executor on a computer).

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

## SSH from your devices

Settings → SSH from your devices ([decision F49](decisions.md#f49--ssh-from-the-persons-devices-is-registered-in-launchpad-settings))
lists the keys of the account's `~/.ssh/authorized_keys`, adds a device's key with the
Launchpad's marker, removes only such keys, and shows the settings a computer writes and
the prompt for the user's own agent. The core is `src/ssh-access/` (`keys.ts` the file,
`host.ts` the account, tailnet name and host key, `access.ts` the use case), tested in
temporary homes (`tests/ssh-access-keys.test.ts`, `tests/ssh-access-host.test.ts`, the
fingerprint cross-checked with `ssh-keygen -lf`). The routes are `src/launchpad/ssh-routes.ts`
(`tests/launchpad-ssh.test.ts`, locally and behind a fake auth endpoint); the page's pure
part `src/launchpad/ssh-view.ts` (`tests/ssh-view.test.ts`) and its DOM
`src/launchpad/ssh-panel.ts`. `startLaunchpad` takes the SSH host as its last
trusted-composition argument, so a preview runs against a temporary home, a host key file
and a tailnet answer of its own and never touches the real `~/.ssh`.

On 2026-10-12 the section was driven in headless Chrome (Playwright, the installed
Chrome) against such a preview: the page and its navigation, a private key and an
options prefix refused beside the key field, a key `ssh-keygen` had just created added
(its fingerprint as `ssh-keygen -lf` prints it, the marked line in the temporary
`authorized_keys`), the config block and the known_hosts line read from their
`data-ssh-block` and accepted by OpenSSH itself (`ssh -G -F`, `ssh-keygen -F`), Copy, the
two-step Remove, a key added outside Launchpad shown without Remove, a 390 px wide
screen, and Czech, without page errors. A real Remote Environment, its network grant and
`ssh <alias> true` from a device are not part of that check.

## Vault (Apps → Trezor)

Apps → Vault, Czech "Trezor" ([F53's addendum of
2026-10-14](decisions.md#f53-addendum-of-2026-10-14-nastavení--trezor-and-the-správci),
root decision 0198 point 5, the wireframe's `EnvVault` of prototypes-lazurio#33), a page
of the Apps column under Integrace since [F53's addendum of
2026-10-18 (2)](decisions.md#f53-addendum-of-2026-10-18-2-trezor-is-a-page-of-the-apps-column)
(`/vault`, the frame `vault`, Files' header with the title alone and "Obnovit stav"; listed
only where the Environment has a vault, [F53's addendum of
2026-10-18 (3)](decisions.md#f53-addendum-of-2026-10-18-3-trezor-only-where-the-environment-has-a-vault)),
is the way into the Environment's own vault, which is Lazurio Vaultwarden's web vault on its own
address: one row with the vault's name and state, and the actions the user's
membership decides ("Přidat položku" and "Otevřít trezor", or "Vytvořit účet v trezoru").
The rule ("Kdo má přístup do Prostředí, má i jeho hesla") and how the vault works are
the "?" beside its heading ([the guide](#the-guide-decision-f56), F56's addendum of
2026-10-18), which plays what is true of this Environment's vault.
The Launchpad never lists items or shows a value. The routes are
`src/launchpad/vault-page-routes.ts` (`GET /api/vault`, `POST /api/vault/membership`),
over the vault's core (`src/vault/flow.ts`, `src/vault/members.ts`); the page's pure part
is `src/launchpad/vault-page-view.ts` (`tests/vault-page-view.test.ts`) and its DOM
`src/launchpad/vault-page-panel.ts`. On first view the page reads its model, then asks
the vault itself (the Tools row's `POST /api/tools/bitwarden/refresh`) and where the
user stands, and asks about the user again when its tab is shown again while they
had no account or their sign-in no username. A hidden `#vault-requests` group above the row is the slot of the
agents' secret requests (DEV-6631 task 651). The user is whom the gateway's own answer
to the request's admission named, by the subject and the Lazurio username
(`src/launchpad/hosted-trust.ts`); their address in the vault is
`<username>@account.lazurio.ai`, a user named without a username is added nowhere
(`no-username`, with a line asking them to sign in again), and a workstation names
nobody and has no vault. HTTP behaviour is tested in
`tests/launchpad-vault-page.test.ts` behind a fake gateway with the fake Vaultwarden and
the fake bw of `tests/fixtures/fake-vault.ts`.

**An Environment without a vault** ([F53's addendum of
2026-10-17](decisions.md#f53-addendum-of-2026-10-17-an-environment-without-a-vault-explains-the-vault))
says why in the page's line; how a vault works in an Organization is the guide video
`vault-overview`, open in place under the heading as the page opens (F56's addendum (4) of
2026-10-19; since its addendum of 2026-10-18 the page no longer has the group "Jak trezor
funguje", and the "?" beside the heading closes and reopens the video).
The line depends on the vault's reason (`vaultPageView`'s `note`): a
public Organization's Environment, whose handover names no tailnet (`no-tailnet`), has
none on purpose, since the Organization is a public demo; any other (`no-vault`) is not
set up yet, and the Organization's Admin sets it up. A public Environment (F55) has
Trezor only with its own vault (see below). `bun scripts/preview-launchpad.ts hosted
cs|en <port> owner no-tailnet|no-vault` shows either: the preview's work Environment then
has no vault, for that reason, and its Apps column no Trezor; `/vault` opens the page.

**Where the column lists Trezor** ([F53's addendum of
2026-10-18 (3)](decisions.md#f53-addendum-of-2026-10-18-3-trezor-only-where-the-environment-has-a-vault),
root decision 0185's addendum, HumanAndMachines/Lazurio#577). Only where the Environment
has a vault, as the vault core answers for it (`vaultAnswer` in `src/vault/flow.ts`, the
answer `lazurio vault status` reads; `vaultListed` in `vault-page-view.ts`): listed for
`own`, `needs-connection`, a 0197 pilot whose account was connected and the faults
(`folder-unreadable`, `handover-missing`, `handover-unreadable`, `not-operator`,
`connection-unreadable`, a core that throws), so the page can say them; not listed for
`no-vault`, `no-tailnet`, `workstation` and a pilot never connected, whose status is
`no-vault`. The server decides it for the first paint: `vaultInAppsOf`
(`boot-document.ts`) reads it beside the Folder's state, from local files only, the boot
document carries it as `vaultInApps`, and the page is served with `#vault-nav` shown only
where it is true (hidden as written, plan DEV-6668 slice 6); `ui.ts` draws the item from the
same member. A page
without a boot document follows its preset (`vaultInApps`): not on this computer.
Trezor's addresses, `/vault` and the old `/settings/vault` with their requests, answer
either way. Tested over HTTP in `tests/launchpad-apps-vault.test.ts` with the production
composition of the vault's facts (`processVaultHost`), the handover's place, the
operator's record and the state root the test's.

**A public Environment's Trezor** ([F55's addendum of 2026-10-20 on the
vault](decisions.md#addendum-of-2026-10-20-a-public-environments-vault-follows-the-vault-core),
plan DEV-6668 slice 6, #499). Stricter: only where the vault core answers this
Environment's own vault (`own`), which is the handover's `vault`; a fault and a core that
throws do not list it (`vaultListed(answer, true)`, `vaultInAppsOf(host, true)`), and a
public page without a boot document does not either. A page without a boot document
lists Trezor on no Environment until `GET /api/entry` (or a workstation's answer of
none) tells it whether it is public (`entryKnown` in `ui.ts`); a failed read keeps it
hidden. The item is hidden as `index.html` is written: `withBoot` shows it only where the
boot document lists Trezor, and `ui.ts` where it decided so, so a page whose script never
runs shows none. Without its vault, Trezor's pages
answer `404` and show Apps, and its API (`/api/vault…`) answers `404 {"error":
"not-found"}` (`withheldInPublic(route, {vault})` on the server, `publicRoute` in the
page's router). Its vault is a Team Environment's whatever the Folder recorded (the Try
overlay's `shownKind`, `src/vault/host.ts`): it adds nobody, and its "?" plays
`vault-agents`. `bun scripts/preview-launchpad.ts hosted cs|en <port> owner public` shows
it with the preview's vault, and with `no-tailnet` too without one. Tested in
`tests/public-vault.test.ts` on try-01's handover recorded as Work and as Team, without
and with `vault`.

**A personal Environment's own Bitwarden** ([F53's amendment of
2026-10-16](decisions.md#f53-amendment-of-2026-10-16-a-personal-environments-own-bitwarden),
root decision 0203 point 7, and its
[amendment (2)](decisions.md#f53-amendment-of-2026-10-16-2-a-personal-environments-own-bitwarden-shown-not-explained)).
While the vault waits for its user (`needs-connection`), the page shows
`#vault-connect` instead of the row, in the spirit of F36's addendum of 2026-10-16
(a title, a picture, one line, two steps of one line each, the fields and one button):
the title "Hesla pro agenty ve vašem Bitwardenu"; a small inline SVG of the vault
between "Váš Bitwarden" and "Agenti v tomto Prostředí", built from the design
system's tokens and the page's own icons, whose middle is the name the vault gets
(`GET /api/vault`'s `name`, "Osobní <login>", fitted to its column and whole in the
picture's accessible name); one line ("Agenti dostanou vlastní účet. Ten váš zůstane
jen pro vás."); the slot of the guide's video (`<div class="guide-video"
id="vault-connect-video">`, empty and collapsed until its video
`vault-personal-bitwarden` exists and the panel mounts `createGuideVideo` there, as
[Guide videos](#guide-videos) says, #452); and two numbered steps in the look of
`#vault-bitwarden`, each with one line and a picture of Bitwarden's own web vault, the
place to fill in ringed. Step 1, "Založte účet pro agenty" with the tip of a
`+agenti` address, opens bitwarden.eu's own sign-up in a new tab ("Otevřít
bitwarden.eu ↗"), and "Používáte bitwarden.com?" switches it to bitwarden.com's
(`signUpLinks`). Step 2 names the way to the API key in Bitwarden's own words and holds
the three fields, `client_id`, `client_secret` and "Hlavní heslo účtu pro agenty", and
"Připojit". There is no region and no e-mail: the server finds the region that accepts
the key. The secret inputs are password inputs with "Zobrazit"/"Skrýt" as on a secret
request and `autocomplete="new-password"`; they are emptied as the request leaves, and
the rest once connected; no value goes to browser storage or the address. "Připojit"
sends `POST /api/vault/connect` (`src/launchpad/vault-connection-routes.ts`); a refusal
says what to do in one sentence (`connectionRefusalText`; a wrong master password adds
that the `client_secret` and the password are pasted again, both emptied as they were
sent), and the one setup it starts
is followed by its job, as the Tools row follows it, so a failure it ends in stays on
the page. The pictures are bundled with the page in `#vault-connect-pictures` and
placed in a step only once the section shows, in the page's language. Connected, the
row is the organization's ("Osobní <login>") with its item count; until the user
asks to be invited (`not-invited`), one line says it is connected and the card
"Chcete hesla agentů vidět i ve svém Bitwardenu?" (`#vault-invite`) takes their own
Bitwarden address and sends `POST /api/vault/invitee` ("Pozvat mě"); its refusals are
`inviteRefusalText`. Then one line says where the user stands (the invitation
e-mailed, accepted and being confirmed, or removed in Bitwarden), a member gets
"Přidat položku" and "Otevřít trezor" into the region's web vault, and "Odpojit
Bitwarden" (`POST /api/vault/disconnect`) with its note shows whenever no setup runs.
Once it succeeded, the section comes back and the page's status line says „Trezor i
hesla zůstaly ve vašem Bitwardenu." until the user connects again or the page is
loaded anew (`disconnectedLine`).
The page asks about the user again when its tab is shown again while their
invitation waits. Tested over HTTP in `tests/launchpad-vault-connect.test.ts` with the
fake Bitwarden cloud of `tests/fixtures/fake-bitwarden-cloud.ts`, and the pure part in
`tests/vault-page-view.test.ts`. `bun scripts/preview-launchpad.ts personal cs|en`
shows it against the same fake cloud: its JSON line's `bitwarden` has a fictional
agents' account to connect and a file whose creation accepts the invitation.

**Bitwarden in Codex Desktop and the user's browser** ([F53's addendum of
2026-10-16](decisions.md#f53-addendum-of-2026-10-16-bitwarden-in-codex-desktop-and-the-persons-browser)).
Under the vault, "V Codex Desktopu a ve vašem prohlížeči" (`#vault-bitwarden`) gives the
steps that add the vault to the Bitwarden extension in Codex Desktop (Nastavení →
Prohlížeč → Rozšíření) and in the user's own browser, in the extension's own words:
the extension's page in the Chrome Web Store, and another browser's own store for other
browsers; for an Organization's Lazurio Vaultwarden
the vault's address and the user's own address, each with a Copy button and a picture
of the extension's screen where it goes, the Lazurio sign-in, a line pointing to
"Vytvořit účet v trezoru" while the page offers it, and the network under the steps; for
a personal Environment's own Bitwarden its region's service and the user's own
account; none where the user's membership answer says that only the agents use the
vault. The user's address is the membership answer's `address`, which the server
builds from the Lazurio username of the gateway's own answer, only for a Lazurio
Vaultwarden; the user never composes it: until it is there, one line in its place says
that it is loading, that it shows after signing in again, or that it could not be loaded
(with the page's "Obnovit stav"). `bitwardenTarget` and
`bitwardenGuide` in `src/launchpad/vault-page-view.ts` decide it; Začínáme's "Trezor v
Bitwardenu" shows exactly there (`offersBitwarden`: for a Lazurio Vaultwarden Začínáme
asks the same membership answer, once per page), and its "Návod" brings the steps into
view once it is certain they show (`revealBitwarden`, `bitwardenReveal`). The pictures
are `src/launchpad/images/bitwarden-<server|email>-<cs|en>.webp`, bundled through the
hidden `#vault-bitwarden-pictures`, from which a step clones the one of its name and the
page's language; the decision records the extension's version and how to capture them
again. Above the steps, for an Organization's Lazurio Vaultwarden, the guide's video
`vault-bitwarden` ("Přehrát video", see Guide videos below) shows the same steps. A
hosted preview (`scripts/preview-launchpad.ts hosted`) has the tests' fake vault and a
gateway that names the fictional user `jana`, so both show there with
`jana@account.lazurio.ai`.

## Guide videos

A guide may show its steps in a short silent video beside them ([F53's addendum of
2026-10-16 on the guide video](decisions.md#f53-addendum-of-2026-10-16-the-guide-video-of-trezor-in-bitwarden));
the steps stay the video's text. The component is **`createGuideVideo`** in
`src/launchpad/guide-video.ts`: given a slot element, a video's `name`, its `title` (the
accessible name), the id of the steps it shows (`describedBy`), the page's copy and its
language, it draws one button, "Přehrát video" / "Play video", whose accessible name is
"Přehrát video: <title>". Pressed, it puts the browser's own player in its place,
`<video controls playsinline preload="none" poster=…>` with one `<source type="video/mp4">`
in the page's language, focuses it and plays it. Never `autoplay`, `muted` or `loop`; the
files carry no audio track; nothing of the video loads before the press. `render()`
follows the page's language: the button's words, or an open video replaced by the new
language's, paused. The pure part, `guideVideoPlayer`, decides the markup and the names
(`tests/launchpad-guide-video.test.ts`). Apps → Trezor mounts it in
`#vault-bitwarden-video` at the top of "V Codex Desktopu a ve vašem prohlížeči"
(`vault-page-panel.ts`, hidden for a personal Environment's own Bitwarden, whose steps
differ). Trezor's "?", where its words are true of the Environment's vault (an Organization's
vault the user is in, or no vault here; [the guide](#the-guide-decision-f56)), is the
first thing the page shows (F56's addendum (4) of 2026-10-19, `src/launchpad/page-help.ts`):
as the page knows the video is true, the box `#vault-video` opens under the page's heading
with `vault-overview` in `#vault-video-player` at its poster, playing nothing and moving no
focus, and the user starts it; the line under it (`vaultVideoLine`) says what the video
does not. The "?" closes it and opens it again, and then plays it (with less motion it
waits at its poster); Escape closes it, the focus back on the "?". Closed by the user, it
stays closed until the page moves on (`helpVideoDrawing`, per visit), and the next visit
opens it again.

The files are `src/launchpad/videos/<name>-<cs|en>.mp4` and their posters
`<name>-<cs|en>.webp`, embedded in the executable with `{ type: "file" }` like the shell's
fonts (`guide-video-files.ts`), so every release carries them. They are served at
`/videos/<file>` beside the page's routes: locally without the token, as the page;
hosted only after the gateway's admission, answered by the server itself rather than
through the inner listener so that the request's byte range reaches it. Safari and iOS
play a video only from a server that answers ranges: one range is `206 Partial Content`
with `Content-Range`, a range past the end `416` with `bytes */<size>`, anything else
(no range, several, an `If-Range` of another version) the whole file with `200`; every
answer says `Accept-Ranges: bytes`, `Content-Type: video/mp4` or `image/webp`, and
`Cache-Control: no-cache` with the content's digest as a strong ETag, so a release with a
new cut under the same name replaces the browser's copy, and `If-None-Match` of the
current one is `304`. The range rules are `selectRange` in `http-conditions.ts`, shared
with the Files downloads. A file must be H.264 in MP4 (no WebM), its `moov` before its
`mdat`, one video track and no audio, under 4 MiB, its poster a WebP under 100 KiB; the
test checks each, the HTTP answers locally and hosted, and `tests/update-compiled.test.ts`
a range of the compiled executable.

To add a video: put both languages' files in `src/launchpad/videos/`, add the name to
`guideVideoNames` and the four imports to `guideVideoFilePaths`, give the guide a slot in
`index.html` and mount `createGuideVideo` on it in its panel.

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

- no sentence that explains the page: the "?" beside its heading does ([the
  guide](#the-guide-decision-f56)), on a Team Environment with the line that the whole
  Team reads and changes the folder;
- the path as links, "Documents" / "Dokumenty" first, the current folder last
  (`aria-current="page"`);
- "Upload files" (a file picker, several at once) and "Download folder (ZIP)";
- the list, folders first, then names as users read them: an icon, the name (a folder
  is a route, a file its download), the size in decimal units or "Folder", the
  modification time in the reader's language and time zone, and "Download" (named
  "Download <name>" for assistive technology). Below 36 rem of the list's width a row
  stacks its size and date under its name and the column names are hidden;
- an empty folder says so, the empty Documents folder that there are no files yet; a missing or
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

## The right panel: the Environment browser

Root decision 0191 point 8a (#207, [F38's addendum of
2026-10-05](decisions.md#f38--the-environment-browser-of-a-remote-environment-one-chromium-a-window-per-thread-a-view-behind-the-gateway)):
the Environment browser, and in the second wave the desktop, are views of the
Environment in each app's right panel, never a fourth mode beside Chat · Apps ·
Automate. The Launchpad's own right panel shows, when the user opens it, the tabs the
Launchpad holds and its Nová karta entries ([F47](decisions.md#f47--nová-karta-one-shell-element-for-every-apps-right-panel-the-places-that-hold-a-remote-tab-and-the-environments-overview) point 9 and Matěj's tuning
of 2026-10-12), each tab in the same view T3 Code's panel embeds (Lazurio/t3code#41);
the Launchpad builds no viewer of its own.

- **Offered** only where `GET /api/entry` answers an entry with `browserOrigin` (the
  handover's `entry.browser`): never on a workstation (no entry), on a Remote
  Environment whose gateway routes no view, or in Recovery mode.
- **The toggle** "Prohlížeč" / "Browser" (Iconoir's app-window) stands in the page's top
  right corner, the wireframe's `apps-corner` ([F47's addendum of 2026-10-12,
  evening](decisions.md#f47--nová-karta-one-shell-element-for-every-apps-right-panel-the-places-that-hold-a-remote-tab-and-the-environments-overview)):
  one toggle in the same place on every page, Settings, Files and a module's information
  page included, after the Guide on the Apps home (Integrace's "Jak to funguje" is the
  guide's card's since F56's addendum of 2026-10-18); only its icon below 768 px. Pressed, it takes
  the quiet surface, and it stays in the corner while the panel is open (the wireframe
  hid it then; Matěj's call of 2026-10-12); a click on it closes the panel. The corner is
  the page's, left of the panel, so the panel beside the page never covers it; when the
  page steps aside for a panel that takes all of the room, the corner goes with the
  page, as the heads' toggle did, and below 1100 px the sheet covers the page, corner
  included. The corner stays in view as the page scrolls, on the page's own surface;
  page heads hold only their titles and leave it free, as wide as it is
  (`--page-corner`, measured by `layout.ts`). A panel left open stays open across every
  move within the page. It slides the panel in from the window's right edge and back out
  in 200 ms, the focus moving to the panel and back to the toggle; with reduced motion the
  panel appears and goes at once. The panel is closed on every page load; only its width
  is remembered (below).
- **The panel** is an `<aside>` after the page in the `.app` row, so the page shrinks:
  beside the rail and the column the page and the panel share the room, and the Apps
  tiles count their columns from their own width, as the wireframe does
  (prototypes-lazurio#10). Its strip has the entries, "+" and Close; Reload and "Otevřít
  v nové kartě" left it on 2026-10-13 for an entry's menu (below). Escape inside it
  closes it, or an entry's open menu alone. The first-run tour steps aside while it is
  open. Below 1100 px there is no room for the page beside it,
  so it covers the window like a sheet with Close in view, and the rail, the column and
  the page are inert behind it.
- **Its width** (`layout-view.ts`, pure; `layout.ts` and `browser-panel.ts` draw it): the
  panel's left edge is a divider, as in T3 Code and Codex Desktop, a focusable `separator`
  whose value is the width. Drag it, move it with the arrow keys (24 px, 96 with Shift),
  Home and End for the least and the greatest width, double-click it for the default,
  half of the room within 360–960 px. Beside the page it stops where the page keeps
  400 px. Dragged past half of that, the page steps aside (`data-browser="wide"` on
  `.app`) and the panel takes all of the room right of the column, as the wireframe's
  "Celá šířka"; dragged back, the page returns at its narrowest. A width that no longer
  fits the window is held where the page keeps its width. The sheet has no divider.
- **The strip** ([F47](decisions.md#f47--nová-karta-one-shell-element-for-every-apps-right-panel-the-places-that-hold-a-remote-tab-and-the-environments-overview) point 9, its addendum and Matěj's tuning of 2026-10-12;
  `browser-panel-view.ts`): the tabs the Launchpad holds, then its Nová karta entries,
  each a tab of the same width with its ×. "+" adds a Nová karta after the others and
  shows it; only the shown entry is mounted. × on a tab lets go of the Launchpad's hold,
  with Vrátit; × on a Nová karta takes it away. The user's × on the last entry closes
  the panel (Vrátit then opens it on the tab again), and opening it on an empty strip
  shows a Nová karta; a strip emptied any other way shows a new one.
- **An entry's menu** ([F47](decisions.md#f47--nová-karta-one-shell-element-for-every-apps-right-panel-the-places-that-hold-a-remote-tab-and-the-environments-overview)
  point 9's addendum of 2026-10-13; `tabMenu` in `browser-panel-view.ts`) opens by a
  right-click on the entry, or by the context-menu key or Shift+F10 while it has the
  focus, at the pointer or under the entry, inside the window. A tab offers "Otevřít
  samostatně" / "Open in a new tab" and "Načíst znovu" / "Reload" (a fresh frame for the
  shown entry; one not shown is mounted fresh whenever it is shown), then every entry
  "Zavřít", "Zavřít ostatní" and "Zavřít vpravo" / "Close", "Close others" and "Close to
  the right", which work as × does; a Nová karta has the closes alone. "Zavřít" on the
  last entry closes the panel. A close with nothing to close is greyed. One command is
  one toast with one Vrátit for every tab it let go of, and a command that ends no tab
  leaves the Vrátit of one that ends, its own line above it. The arrows, Home and End
  move in the menu, Enter and Space run a command, Escape closes only the menu and gives
  the focus back to the entry, Tab closes it and moves on from the entry, and a press
  elsewhere closes it. Checked on 2026-10-13 in Chrome against
  `scripts/preview-new-tab.ts` with a stand-in view, in Czech and English, at 1440×900
  and as the sheet at 900×760: the menu by the pointer and by Shift+F10, the arrows,
  Escape and the focus, "Otevřít samostatně" in a new tab without an opener, "Načíst
  znovu" with one new frame, "Zavřít vpravo" and "Zavřít ostatní" with one toast and one
  Vrátit that brought every tab back, the shown one shown, a later × that ended nothing
  keeping that Vrátit, and "Zavřít" on the last entry closing the panel, whose Vrátit
  opened it again.
- **What it shows** (`browser-panel.ts`): the strip's shown entry. A tab's view is framed
  only as `/t/<id>` on exactly the recorded `browserOrigin`, never the page's own, with
  `allow="clipboard-read; clipboard-write; fullscreen"`, `referrerpolicy="no-referrer"`
  and the sandbox of T3 Code's panel with `allow-popups-to-escape-sandbox` since
  2026-10-13 (the view keeps its own origin and cookie and cannot navigate the Launchpad,
  and a tab it opens, its own "Otevřít samostatně" above all, is an ordinary tab of this
  browser, not a sandboxed one; checked in Chrome, where the same tab opened from a frame
  with the earlier sandbox is sandboxed); anything else is one sentence that the tab
  cannot be shown here. Nová karta is
  `<lazurio-new-tab strip="launchpad" focus-address>`. Closing removes what was shown,
  so a closed panel streams and reads nothing.
- **"Otevřít samostatně" / "Open in a new tab"** in an entry's menu opens the tab's view
  in a new tab of this browser, without an opener, where the gateway's sign-in can show,
  which a frame cannot. The view's address carries no token (F39 point 8).
- **The left column** on a screen 768 px wide or wider (Matěj 2026-10-12, as T3 Code's
  sidebar; `layout.ts`): T3 Code's sidebar toggle (Iconoir's sidebar-collapse and
  sidebar-expand), "Skrýt levý panel" / "Hide left panel", stands first in the band on
  top of the column (Matěj 2026-10-17, [F36's addendum of
  2026-10-17 (2)](decisions.md#f36-addendum-of-2026-10-17-2-the-band-on-top-of-the-launchpads-column)):
  a 52 px band, as tall as Settings' header, with the toggle 19 px from the column's edge
  and 11 px from its top, its centre over the picker's mark, then the design system's
  approved lockup, 18 px tall and starting where the Environment's name starts. The band
  is the page's own markup (`.column-band` in `index.html`), above
  `<lazurio-column-head>`, which follows right under it; the toggle's row under the
  switch is gone. The toggle hides the column, the rail staying. While the column is
  hidden, one toggle, "Zobrazit levý panel" / "Show left panel", at the page's top left
  in the same spot, where ChatGPT and Codex keep theirs, shows it again. The page's
  content never moves for it: only a
  title row it would reach steps aside (Matěj 2026-10-13), that is Settings' and Files'
  header, the first row of the Apps home, Integrace and a module's page, and the
  Marketplace's head only while its centred column comes that close (a container query
  on `.page`). While the page also steps aside for the panel, the one in the panel's
  strip stands in for it.
  One of them is drawn at a time, and the focus a toggle had moves on to the one drawn
  now. The shell's column head stays as it is: it offers no slot for a host's control.
  Its right edge is a divider like the panel's, 208–480 px and never leaving the page
  less than 400 px, double-click for 264 px. Below 768 px it stays the sheet opened by
  the button at the top of the page, its band showing the lockup alone. With the column
  hidden and the panel over all of the room, the panel's own hairline gives way where it
  meets the rail, whose edge is the line between them.
- **Remembered in this browser**: the panel's width or all of the room, the column's
  width and whether it is hidden, as one `localStorage` entry, `lazurio.layout`, read
  field by field; a field that is not what it should be is its default alone. As the
  favourites and the tour's progress, never in the Folder, which a Team Environment
  shares.
- **Verified** by `tests/browser-panel-view.test.ts` (where it is offered, from the
  projected handovers with and without the route; the view accepted from the server's
  own resolution and refused in every other shape; the read's request and its failures;
  what each state draws) and on 2026-10-05 in Chrome against the hosted preview in
  Czech and English at 1440×900, 1024×768 and 390×844 and against a workstation
  preview: the toggle on the Apps home, Settings, Files and the Marketplace and none on
  the workstation, the page shrinking beside the panel, the frame's attributes with no
  referrer, the view's own cookie and its top navigation refused by the sandbox, Reload
  with a new frame, Close and Escape returning the focus, the sheet with the page inert,
  both sentences with the hand-over link, and Recovery mode closing the panel. These are
  no rendered-page CI gates (root decision 0178). A real gateway, agent-browser's
  dashboard in the frame and the gateway's framing rules were **not** exercised; they
  belong to the DEV-6646 integration review. Matěj's tuning of 2026-10-12 is covered by
  `tests/browser-panel-view.test.ts` (several Nová karta entries, "+", × on either kind,
  the last ×, the strip emptied from elsewhere) and `tests/layout-view.test.ts` (the
  widths, the step aside and back, the keys, the stored layout); how it looks and moves
  belongs to a check in a browser. The controls in the page's corners (2026-10-12,
  evening) are pinned by `tests/launchpad-page-corners.test.ts` (the one Browser toggle
  in the corner after the Apps home's Guide, outside every view and head; the column's
  toggle in the band on top of the column with the vendored lockup, above the column
  head, at the page's top left and in the strip; heads with their titles and their "?" only;
  Integrace's search and refresh with the tabs) and were checked in
  Chrome against the hosted preview in Czech and English at 1440×900, 900×900 and
  390×844: the Apps home, Integrace, the Marketplace, every section of Settings, Files
  and a module's page with the column shown and hidden, at the two wider sizes with the
  panel closed and open (the toggle pressed in the corner beside the open panel, its
  click closing it), the panel taking all of the room and the page scrolled; on every
  page and size the page's content where it is for the hidden column's toggle, and
  Settings' and Files' header within its edge, every control in it in reach and nothing
  under a corner; the focus back on the toggle after Close and after Escape, and moving
  by keyboard between the column's toggles. The band of 2026-10-17 was checked in
  headless Chrome against the hosted preview in Czech at 1440×900 and 700×900, as its
  addendum records.

## First run of an Environment

Root decision 0188 (Matěj 2026-10-04), reshaped by root decision 0201 points 1-3 and 8
(Matěj 2026-10-14, plan DEV-6665, after a new member's first run on 2026-10-13: "Ukončit"
ended the tour for good, and the Organization's download ran before any AI could help),
after the wireframe of HumanAndMachine-ai/prototypes-lazurio 1eefc3d (`setup.tsx`,
`screens/Start.tsx`, `screens/Tour.tsx`, PRs #48 and #49) and [F36's addendum of
2026-10-15](decisions.md#f36-addendum-of-2026-10-15-začínáme-the-basics-from-live-facts-ai-first-root-decision-0201).
Only where the Environment signs in to GitHub as its user: the presets
`hosted-personal`, `hosted-organization-personal` and `local`. A Team or an Automated
Environment acts through the Organization's app or its persona, its basics are the
Organization's, and it gets none of it.

- **The basics** (0201 point 1): an AI an agent can work with, GitHub signed in as the
  user, and the content (the Organization, on the personal Environment the
  Personalspace). They are read live, never stored, in the order AI → GitHub → content
  (`nextBasic` in `first-run.ts`):
  - the AI from `GET /api/ai` (`src/tools/ai.ts`, `src/tools/ai-probe.ts`): Codex's own
    app-server answers `account/read` (a ChatGPT sign-in or an API key works;
    `requiresOpenaiAuth: false` is the Organization's AI pool, whose provider needs no
    OpenAI sign-in, so the step is done without the user), Claude Code answers
    `claude auth status --json`. `organization` or `connected` is done; `missing` only
    when every CLI answered (signed out or not installed); `unknown` (no answer) is
    never claimed missing and holds nothing back. The server keeps an answer a minute;
    `?fresh=1` (Začínáme's "Zkontrolovat znovu") asks now. The sign-in itself
    (`lazurio tools login codex|claude`, F19's addendum of 2026-10-15) only makes this
    reading change: when one ends, the server drops the answer it keeps;
  - GitHub from Settings → Nástroje's own reading of the profile shown (`githubFact`: an
    unknown, unprobed, stale or Team reading says nothing; gh not installed is missing;
    connected only when gh is signed in and this Environment reaches GitHub over SSH as
    that account, `incomplete` when it does not, which counts as missing, F19's addendum
    of 2026-10-19);
  - the content from the content routes (`content-client.ts`, `content-view.ts`).
- **Nastavení → Začínáme** (`/settings/start`, first in the Settings column with the
  count "1/3" while a basic is missing; `start-view.ts`, `start-panel.ts`): "Hotovo
  {n} ze 3 kroků." (all there: "Prostředí je připravené."), then "Povinné kroky". Each
  row is its title, its action and its state, with at most one short line where the
  title alone does not say what it is for (F36's addendum of 2026-10-16):
  1. **Připojit AI** (`ai-sign-in.ts` holds the sign-in in the page): "Zajišťuje vaše
     Organizace." (done, nothing runs); otherwise only the title and "Přihlásit ChatGPT"
     and "Přihlásit Claude", each with its mark before its name (OpenAI's Blossom from
     its brand kit, the sprite's `i-openai`, in OpenAI's white or black only; Claude's
     simple-icons mark, `i-claude`; [licensing](licensing.md#bundled-third-party-assets)),
     nothing said before them (where the AI could not be checked, that line); beneath
     them ChatGPT's quieter "Přihlásit kódem" (a link-coloured button) with its one line,
     "Přihlášení kódem si nejdřív zapněte v nastavení zabezpečení ChatGPT. U pracovního
     účtu ho povoluje jeho správce." (root decision 0201 point 10, F19's addendum of
     2026-10-21: `lazurio tools login codex --device-code`), and while its code waits
     "Otevřete stránku ChatGPT v kterémkoli prohlížeči, třeba v telefonu, a opište kód.
     Platí 15 minut." with the code, "Kopírovat" and "Otevřít ChatGPT" (the block of gh's
     code in its dialog, `device-code-block.ts`) and "Zrušit", nothing opened in the right
     panel; signing
     in, "Dokončete přihlášení k {ChatGPT|Claude} v prohlížeči vpravo." (the
     right panel opens on the Environment browser's tab, as for Integrace) or "… v okně
     prohlížeče." (a workstation, whose CLI opens the computer's browser), with
     "Otevřít přihlášení" and "Zrušit", and for Claude's code page one field for its
     code (`POST /api/tools/login/code`); "Připojeno: ChatGPT, <e-mail>; Claude,
     <e-mail>" with "Přihlásit jiný účet", which offers both again; a sign-in that did
     not finish ("Přihlášení se nepovedlo…", expired, the Environment browser did not
     open it) with "Zkusit znovu"; a T3 Code that did not turn the provider on, said
     beside the account; and without the Environment browser "Přihlášení tu teď nejde
     otevřít.", nothing started. Signed in, the page reads `GET /api/ai?fresh=1` at once;
  2. **GitHub**: "Připojeno jako @login", or "Nepřipojeno" with
     "Připojit" (gh's own sign-in dialog of Nástroje), enabled only once AI is there;
     before, the step waits under its number. Connected badly (signed in, SSH not
     working): "Připojení nefunguje." with the warning mark and "Připojit znovu", which
     opens "Link SSH key" under the title "Připojit GitHub". A sign-in the page runs, its
     window closed or open: "Čeká na vaše potvrzení." or "Dokončuje se připojení…" with
     the waiting mark and "Otevřít", which shows it again (F19's addendum of 2026-10-19);
  3. **Stáhnout <Organizace>** / **Připravit osobní prostor** / both: the content's own
     rows inside the step (the same `content-panel.ts` as Toto Prostředí draws).
     Once this view saw GitHub or the AI arrive (from missing to there; what was there
     when the page loaded starts nothing), the installation starts by itself as soon as
     both are there, whichever came last, and the content is read and missing
     (`autoStartStep`: in memory only, never after a stop, never during a run). Nothing
     starts it before its turn (`contentBlockedBy`): without AI or GitHub neither the
     download nor "Zkusit znovu" is offered, only "Nabídne se po připojení AI." or
     "Spustí se samo po připojení GitHubu." in Toto Prostředí, and nothing in Začínáme,
     whose numbered steps say the order (`turn`); a start request in the address follows
     `startDecision`; and `POST /api/content/install` refuses with `403`
     `"reason": "ai-missing"` while the AI is provably missing. An AI that could not be
     checked holds nothing back.

  Then "Hesla pro agenty" with Trezor Prostředí and its state as Apps → Trezor reads
  it (`GET /api/vault`, `vaultPageView`; a Remote Environment with a vault only),
  "Volitelné" (Composio where Nástroje offer it, with its sign-in, and "Nedokončeno"
  with "Dokončit" where it is signed in but the organizations' reading says it does
  not work in the organization of the Organization's name: "Dokončit" opens
  Composio's dialog at the step left in Composio, decision F42's note of 2026-10-19;
  on a Remote Environment SSH z vlastního počítače, "Nastaveno" once a device's key was added here,
  and Codex Desktop, both leading to Settings → SSH; between them "Trezor v Bitwardenu"
  where Apps → Trezor gives the steps for Bitwarden, its "Návod" opening them) and
  "Prohlídka aplikace" ("Spustit
  prohlídku" / "Spustit znovu" starts the introduction in Apps). A Team or Automated
  Environment's Začínáme says only "Tady není co nastavovat.".
- **The line in Apps** (`appsSetupLine`): until the basics exist, one line under the
  head, the next missing basic first: "AI není připojené." · "Připojit AI";
  "GitHub není připojený." · "Připojit GitHub"; "<Organizace> tu ještě není." ·
  "Stáhnout"; "Osobní prostor tu ještě není." · "Připravit"; while it runs "Stahuje se
  <Organizace>." · "Zobrazit"; "Příprava se zastavila." · "Vyřešit v Chatu" or "Připojit
  AI", "Zkusit znovu"; for an Organization not prepared for this version, to a member who
  cannot write its root, "<Organizace> ještě není připravená. Připravuje ji Admin." ·
  "Zkusit znovu". Every button leads to Začínáme. No empty card beside it.
- **The quiet prompt in the shell's column** (`columnSetupPrompt` in `src/shell/view.ts`,
  0201 point 2): while a basic is known to be missing, "Dokončit nastavení (1 ze 3)"
  under the switch in Apps, Chat and Automate alike, leading to Začínáme of the
  Environment's Launchpad (a move within the page in Apps). It replaces the line the
  column head drew in Chat and Automate. The shell document's `setup` gained `ai`
  (below); the Launchpad page gives its own column head the `setup` of its own, newer
  facts.
- **Start requests.** A button of the line is a link to `/settings/start` with the
  action in the fragment, decided by `startDecision`: `#lazurio-start=sign-in-gh` opens
  gh's sign-in once Nástroje have read gh and AI is there, `#lazurio-start=install-content`
  starts the installation once the content is read, something is missing and its turn has
  come; without AI either shows the AI step and starts nothing. A link of an older shell to
  Nástroje or Toto Prostředí lands on Začínáme too. `readFragment` takes the fragment
  apart: the request, and the rest, which locally is the session token
  (`#<token>&lazurio-start=…`).
- **The tour** (`tour.ts` over the rules of `first-run.ts`): a ring around a real
  element and a bubble beside it with at most a dozen words; the layer lets every click
  through, so the user does each step. While a basic is missing: the gear ("Nejdřív
  připojte AI", its title alone with no line under it, as Začínáme's AI step; "Připojte
  GitHub", "Ještě stáhněte <Organizace>", "Příprava se nepovedla"), Začínáme in the
  Settings column ("Všechny kroky na jednom místě."), then on Začínáme the missing step
  itself (`data-tour` `start-ai`, `start-github`, `prepare`). Then the introduction: Apps,
  Chat, Automate and the gear ("Nastavení" · "Začínáme tu najdete kdykoli."). Every
  bubble but the last offers **"Dokončím později"**, which puts it away for the current
  view only: until the basics exist the tour is back on the next page load, and Začínáme
  never goes away. It steps aside while a dialog or the Environment browser is open and
  waits while its element is not on the page (a preparation that runs).
- **Where the bubble stands** (`src/shell/guide-placement.ts`, which the guide shares
  since F56; Lazurio/LazurioPlatform#461): one
  rule for every stop. Beside the ringed element when there is room, else under it,
  above it or on its left; along that side it starts where the ring starts, or ends
  where the ring ends when starting there would leave the window, so the bubble at
  "Zkusit znovu" on the right edge of Začínáme stays over the content. It is always
  whole inside the window's visible area, 12 px from its edges, measured without the
  scrollbar (`clientWidth`), which a classic one (Windows, a Mac with a mouse) would
  otherwise lay over it; 300 px wide, or what a narrower window leaves; its arrow points
  at the element. Without the element on screen (the Settings column of a narrow
  window, closed) it stands in the bottom right corner. A ringed link is the page's own
  link: a plain click moves within the page, and only a click with ⌘ (Ctrl outside a
  Mac, where Ctrl opens the context menu), Shift or the middle button opens a new tab or
  window, as for every link.
- **Where the progress lives.** Only where the introduction points, in this browser's
  `localStorage` per Environment (`lazurio.tour:<Environment id>` = `{ "intro": n }`, the
  shell document's `current`). Nothing about the basics is stored: they are the
  Environment's own state, the same in every browser. An entry of the first run of 0188
  (`{ composio, intro, done }`) keeps its place in the introduction and its `done` counts
  as seen; it never hides the basics again. An Environment that has its basics at first
  sight starts with the introduction seen, so a workstation, whose loopback origin
  changes with every start, does not repeat it. Not in the Folder's preferences: they
  are schema-versioned, revisioned state whose every change rewrites the agents'
  instructions.
- **Where a stop leads** (`resolveOf`, 0201 points 3 and 8): "Vyřešit v Chatu" only
  while an agent can work; with no AI connected the button is "Připojit AI", the
  sentence "Agent v Chatu pomůže, až připojíte AI." and the click opens Začínáme at the
  AI step, as does every hand-over to Chat (`handOver`, "+ Nový modul" included) while
  no AI is connected. For `root-not-found` and `organization-unreadable` (the root does
  not declare itself in `lazurio.organization.json`, or its declaration cannot be read)
  the sentence is "Organizace ještě není připravená pro tuto verzi Lazuria.", and to
  someone whom `GET /api/content/root-access?org=<login>` does not confirm (an active
  Owner, or `write` on the conventional root `<login>/<login>_GEN3`; GitHub's live
  answer, any failure no) "Organizaci připravuje Admin." with no Chat button. The route
  answers only for the Organization of that stop and gives the same no, without asking
  GitHub, for any other.
- **Toto Prostředí** says what a user needs (`environmentFacts` in
  `machine-view.ts`, the wireframe's `ThisEnvironment`): "Druh", "Patří" and "Pracuje v
  něm"; the technical name and kind, the owner and assignment as recorded, the tailnet
  node, the host and the relationships are folded under "Pro podporu". A workstation
  says only "Váš počítač". No introduction. The section is named by its kind ("Toto
  Týmové Prostředí", on a computer "Tento počítač") and "Druh" is one of the three kinds,
  an automated Environment "Pracovní Prostředí s automatizacemi"
  ([F28's addendum of 2026-10-18](decisions.md#f28-addendum-of-2026-10-18-three-kinds-of-environment-and-your-computer-without-a-kind)).
- **Obsah Prostředí** (`content-panel.ts`) in Settings → Toto Prostředí, above
  those facts, and in Začínáme's third step: a row per item of `GET /api/content` (the
  personal Environment holds the Personalspace, a work one its Organization, a
  workstation both; the content routes decide), the one action ("Stáhnout",
  "Připravit", "Stáhnout vše", "Zkusit znovu"; not offered before its turn, only "Nabídne
  se po připojení AI." or "Spustí se samo po připojení GitHubu.") posting
  `POST /api/content/install` with `{}`, and
  while it runs the job's steps in plain words ("Ověřuji přístup", "Stahuji
  Organizaci", "Stahuji moduly", "Instaluji", "Kontroluji" / "Hledám váš osobní
  prostor", "Zakládám", "Stahuji", "Kontroluji"), read from `GET
  /api/content/jobs/<id>` every second. A stop shows one plain sentence by the step,
  the command and the detail under "Podrobnosti", and where it leads (above). On load
  the page reads the Launchpad's newest job (`GET /api/content/jobs/latest`), not
  anything kept in the browser, so a reload, another tab or another device shows the
  same run or stop. Any other answer of the routes (none on a Launchpad without them)
  hides the group.
- **"Vyřešit v Chatu"** hands the prompt `prepare-content` to Chat ([prompt
  hand-off](#prompt-hand-off-to-chat)): by link where Chat takes prompts and this
  Launchpad serves that prompt for the login it names (asked before the click, so the
  click itself opens the tab), otherwise through the clipboard with the same text
  built in the page.
- **Tests.** `tests/first-run.test.ts` (the basics and their order, the tour's stops and
  words, "Dokončím později", the stored progress, the line per state, where a stop
  leads, GitHub's fact, the fragment), `tests/start-view.test.ts` (Začínáme's steps,
  the count and the optional rows), `tests/ai-status.test.ts` (the CLIs' answers, the
  probe over fake processes and fake CLIs, `GET /api/ai`),
  `tests/content-client.test.ts` (the client against stubs of the fixed API),
  `tests/content-view.test.ts` (steps, the stop and where it leads, the prompt),
  `tests/content-routes.test.ts` (`root-access`), `tests/first-run-shell.test.ts`
  (the shell document's `setup` with `ai`, the column head's prompt, the GitHub probe,
  `prepare-content` over HTTP, the auto-on rule and the Nástroje texts) and
  `tests/tour-placement.test.ts` (where the bubble stands: the page's own boxes at 1440,
  1280, 1024 and 800 px, short windows, a classic scrollbar and a sweep of elements
  across five windows).

An Organization's own tabs in Workspace (decision F32's addendum of 2026-10-16)
are shaped in [Workspace tabs](workspace-tabs.md): one setting of the
Organization, read with its catalog, arranged by its Owner in the Dashboard.
They look like the column head's switch Chat · Apps · Automate (F32's addendum
of 2026-10-19, prototypes-lazurio#73): `nav.switch` and `.tab` of
`src/shell/styles.ts` drawn in the page's roles the shell's colour roles stand
for here (`--hover`, `--card`, `--border`, `--fg`, `--muted-fg`, `--link`), at
the right end of the Workspace head 6 px above its rule, "Upravit karty" right
after the switch (one `.workspace-head-end`), and the "Workspace" flag flush
on the rule: the head (`.workspace-head`) wraps in reverse and aligns its parts
to its bottom edge, so a switch that does not fit beside the flag takes a line
above it. `appsSectionHead` (`apps-view.ts`) gives the head's parts in order;
`catalog-panel.ts` draws them. Tests: `tests/workspace-tabs.test.ts` and the
contract cases in `tests/organization-settings.test.ts`; the geometry (no gap
under the flag, the switch 6 px above the rule) is checked in a browser.
Preview: `bun scripts/preview-launchpad.ts local cs 0 owner workspace-tabs`.
