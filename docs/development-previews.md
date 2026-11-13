# Stable applications and development previews

Matěj's decision of 2026-10-20, confirmed on 2026-11-13 and recorded as
[F22's addendum of 2026-10-20](decisions.md#f22-addendum-of-2026-10-20-stable-addresses-on-main-development-previews-in-the-environment-browser).
It replaces the preview direction of F22 point 7, launchpad-parity B14/P9/H3 and the
preview advice of F14's addendum of 2026-10-02. It refines root decisions 0167 and
0191. Worktree discipline still applies.

An application's normal address is somewhere the user can return to and keep
working. It serves the stable version from `main`; the target is a built release,
without a development server or hot reload. Starting a preview must leave that
application, its address, service and port alone.

A development version runs from its own worktree on a separate free loopback port.
Open its actual `http://127.0.0.1:<port>` or `http://localhost:<port>` address in the
browser of the Environment where the process runs. This applies to module changes,
prototypes, other branches and development applications in productionspace. A
productionspace checkout does not gain a module hostname by being opened for review.

The user sees that page through the existing Environment browser view. Return the
link to the actual tab, label it as a development preview and give its local address
and branch. The tab's `localhost` belongs to the Environment, not to the user's
computer. A `browser.…/t/<id>` link is a view of a browser tab; it does not publish the
application through the gateway. On the user's own computer a local preview opens
directly in that computer's browser.

## Agent procedure

1. Read the owning repository's start contract. Verify the exact worktree, command,
   free port and loopback bind. Modules receive their declared runtime listener
   variables (`LAZURIO_RUNTIME_LISTENER_<ID>_*`); applications outside the module
   catalog follow their own contract.
2. Start a separate process and check its health. `lazurio module start` currently
   starts the primary checkout; it is not a worktree preview command. Do not stop
   the main application, reuse its port, change a proxy or register a hostname.
   Leave an occupied port's process alone and choose a different free port.
3. Open the preview in a new tab of the Environment browser, as the manual's
   "A new tab" point describes. In T3 Code, `preview_open` with
   `reuseExistingTab: false` and the preview's `url` opens a new tab and returns its
   `tabId`; the link is `https://browser.…/t/<tabId>`. Elsewhere, open it in a window
   of a session that has none yet:
   `lazurio browser window --session <session>-preview --url <localhost-url> --json`.
   `--url` applies only when the command creates the window. A session that already
   has its window gets that window back, unmoved (`ensureThreadWindowLocked` in
   `src/browser/window.ts`), and the command answers `created: false` ("Your window
   is open already"); then the address did not open, so choose another session
   name. Never hand over the link of the thread's own window as the preview.
   Verify rendering and the main journey before handing over the tab link.
4. If the browser, server or a required dependency is unavailable, report the exact
   gap. Do not route around it through the stable module URL or a new public port.
   Preview data and sign-ins follow the owning repository's rules; a preview URL
   does not isolate data or authorize production writes.
5. Keep track of the process you started. At cleanup, stop only that process and
   let go of the preview's window with `lazurio browser done --session <session>`.
   Neither the end of a tab nor a sleeping tab stops a dev server.

## What changed and what remains to do

The earlier same-address switch between `main` and worktree is retired as an agent
workflow. The later proposal to register temporary preview hostnames and leases is
also retired. The existing Environment browser provides the review path, so previews
need neither a second gateway catalog nor a new preview URL service. An SSH tunnel
is not the default handoff when the Environment browser is available.

This change updates the generated Folder instructions in both locales. A normal
versioned Platform release and Folder refresh must deliver them to installed
Environments; a source merge alone does not do that. Existing active chats may have
loaded older instructions and need to reread the refreshed Folder.

An app that declares its build (`build_output`, or `start_script` for an app with its
own server) already starts from `main` as that build ([F58](decisions.md#f58--a-static-app-starts-from-main-as-its-build-each-commit-built-once-outside-the-checkout-served-by-the-platform-rebuilt-after-a-pull)).
An app without one still runs its declared development command, and calling its
`main` stable does not turn that process into a release build.
[Moving normal module entry to built releases](https://github.com/Lazurio/LazurioPlatform/issues/548)
remains separate implementation work: define the build/start contract, verify a real
module, preserve data and access boundaries, and qualify failure and update behavior
before rollout. This change does not alter that runner, activate a release, migrate
an installation or change gateway routes.

Acceptance has two separate parts: generated instructions must direct an agent to a
loopback preview in a new tab or a new session's window without touching main;
installed-consumer qualification must then show both pages working side by side and
cleanup leaving main healthy. The latter must be recorded during the authorized
release rollout, not inferred from text tests.
