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

## Tools section

The page has a section "Tools" / "Nástroje" (decision F18,
[environment-tools.md](environment-tools.md)). It reads `POST /api/tools/status` when
the profile is loaded, after every change and on "Refresh status", and shows:

- one introductory sentence: what tools are, that enabling writes them into the agent
  instructions, and that agents use enabled tools first and MCP servers second;
- on a shared Environment (the Team preset) the warning that signed-in accounts are
  shared by all operators; it is repeated in the confirmation of an enable;
- three groups, **Required**, **Recommended** and **Optional**, in catalog order. A
  card carries the tool's name, its one-line purpose, the enabled state, the setup
  mode, the installed version and path or "not installed", a note when the PATH entry
  is outside `~/.local/bin`, a failed version check, and behind "What agents are told"
  the usage text and the official source;
- a card "Connect another app through an MCP server" with the generic prepared prompt.
  MCP servers are never recorded in the Folder, so this card enables nothing.

**Enable and disable** use the pattern of the profile form in two clicks. The first
sends the full next selection with the shown revision to `/api/tools/preview` and
writes nothing; the card then says what the change does and which files it rewrites.
"Confirm" sends the same candidate to `/api/tools/update`. After a recorded change the
whole page reloads its state, so the revision advances for the profile form as well
and a profile preview made before the change is dropped. A `blocked` answer becomes
one sentence in the card (`stale-revision`, `drift` with its path, `incomplete-state`;
any other reason is named by its code) with a "Reload" button; an answer that cannot
be read is reported as unconfirmed, never as refused. A required tool has no such
control and shows "Always on".

**Set up with an agent** opens a modal `<dialog>` with the prepared prompt in a
read-only text area and "Copy prompt" (Clipboard API; where it is unavailable the text
is selected for a keyboard copy). The prompt contains no secret, and the operator
pastes it into a new chat in T3 Code on the Machine. Focus moves into the dialog and
returns to the button that opened it. Every activatable tool has this button. A
`launchpad` tool additionally shows a disabled "Install and sign in" with the hint
that the curated flow comes in the next release; that flow is not built.

The section checks installation only. It runs no sign-in command and says so on the
page. Pure view logic lives in `src/launchpad/tools-view.ts` and is tested without a
DOM (`tests/tools-view.test.ts`); `src/launchpad/tools-panel.ts` holds the DOM and
renders every server and tool value with `textContent`. HTTP behavior is tested in
`tests/launchpad-tools.test.ts` with fake tools on a private PATH and a temporary
home. The section's appearance in a real browser, its keyboard and screen-reader
behavior and the clipboard path have not been qualified by an automated or recorded
manual run.
