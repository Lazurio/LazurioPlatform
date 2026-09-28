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

## Settings: structure, routes and the T3 Code pattern

The Launchpad is one page with two views (decision F15 addendum 2026-09-28): the
Launchpad home (`/`, the development Application panel) and Settings. Settings follows
the settings UX of T3 Code, as the Principal asked, in plain CSS inside
`src/launchpad/index.html` and without a framework or a new dependency.

**Routes.** `/settings/general`, `/settings/machine` and `/settings/tools`; `/settings`
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
| Machine profile: Workspace preset, Language, Detail, Coordination, Preview, Apply previewed change, the status line | Settings → General, one group of rows; Preview and Apply in its last row |
| Reload profile | Settings → General, page action in the header |
| JSON of the last answer (`#result`) | Settings → General, behind "Technical details" |
| This Machine (read-only handover) | Settings → This Machine, one row per recorded fact |
| Tools (groups, cards, dialogs, MCP card) | Settings → Tools; Refresh status is its page action in the header |
| Product update pill, with the read-only "Folder refresh needed" line (F17 addendum) | Sidebar footer above Settings/Back, visible from every route, and only while an update is available or under way (Principal 2026-09-28, as in T3 Code); the Folder refresh line is independent of the pill, a subdued notice right above it with the command in selectable monospace |
| Application (development lifecycle) | Launchpad home `/`, not a setting |

**Patterns adopted from T3 Code** (source: `pingdotgg/t3code` at `d15210cd3d`,
`apps/web/src/`, and the installed T3 Code 0.0.42 bundle):

- the sidebar becomes the settings navigation on a settings route, a flat list with an
  icon per section, 32 px rows, 8 px radius, the current item on a lighter surface with
  `aria-current="page"` (`AppSidebarLayout.tsx`, `SettingsSidebarNav.tsx`,
  `ui/sidebar.tsx`);
- the sidebar footer has "Settings" on the Launchpad home and "Back" inside Settings;
  Back goes to the Launchpad home, not through the browser history, and the update
  pill sits in the same footer (`sidebar/SidebarChrome.tsx`, `mainAppLocation.ts`);
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
  through `prefers-color-scheme`; the system font stack.

**Deliberate differences.** Moving between sections adds a history entry (T3 Code
replaces it), so back and forward move between sections as the Principal asked.
Choosing a section keeps the focus on the navigation item as in T3 Code, but every
other move (Settings, Back, the breadcrumb, back/forward, a section chosen in the
narrow sheet) focuses the heading of the new view and the document title names it.
Escape does not leave Settings from a form field, so an unsaved note is not left
behind by a stray key. T3 Code's settings search, `/` shortcut, resizable sidebar and
per-row reset are not built: the page has three sections and no defaults to reset to.
The General settings keep the explicit Preview → Apply of a Folder change instead of
T3 Code's immediate apply. Icons are Lucide (ISC), inlined as SVG symbols.

## Tools section

The page has a section "Tools" / "Nástroje" (decision F18,
[environment-tools.md](environment-tools.md)). It reads `POST /api/tools/status` when
the profile is loaded (with `signIn: true`, so the sign-in probes run), after every
change (without them; the last known sign-ins stay on the cards) and on "Refresh
status" (with them again), and shows:

- a short introduction: what tools are, that "Used by agents" guides the agents on this
  Environment to use a tool, and that installing, uninstalling, signing in and signing
  out are separate acts (the Principal's wording, 2026-09-28; said once per page, not
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
  the shared case) the gh row has no "Sign in", "Link SSH key" or "Sign out" and no
  agent fallback; a subdued sentence says that this Team Environment works in GitHub
  through Lazurio for GitHub, set up by the Organization, and that personal GitHub
  accounts are not signed in here (Principal 2026-09-28). Its sign-in line stays, in
  the neutral colour. This is presentation only: the server still accepts a gh login
  on a Team Environment (the server rule is a separate slice). composio and wacli keep
  their actions there, with the shared sign-ins warning;
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
and returns focus to the card. What it shows:

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
