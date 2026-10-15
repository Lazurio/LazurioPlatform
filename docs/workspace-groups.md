# Workspace groups: Work and Administration

Proposed UI extension for [#428](https://github.com/Lazurio/LazurioPlatform/issues/428),
implemented in this review branch. It is not an approved release or an installed
Environment change.

Workspace keeps every catalog module. Its two tabs, Work and Administration
(Práce / Správa), show counts and divide the existing tiles. All modules start in
Work; the module's menu moves it to either group. Work is selected on a new page
load. The selected tab survives background reads and navigation within that page.
An empty group explains how to move modules back. Productionspace stays separate.
The Owner's New module tile stays in Work, including before the first module.

Assignments are a browser preference for the current account operator and space,
under `lazurio.workspace-groups.v1:` in localStorage. The tuple includes the
case-insensitive login, space kind and space identifier, so a Personalspace and an
Organization cannot collide. The origin separates Environments; this does not
synchronize across devices, origins or browser profiles. Clearing browser data
resets all modules to Work. The tab list's tooltip states the browser-only scope.
No Organization file, manifest, runtime, grant or Account API is written.

Only a validated account document supplies the operator. While that read is
pending, move actions are disabled. If the account is unavailable or has no
identified operator, assignments exist only in page memory; each move explicitly
says they will disappear on reload. This avoids reusing the previous person's
preferences on a shared origin. A storage failure leaves the saved assignment
unchanged and reports failure. Malformed preferences fall back to Work. A move
reads the latest saved list; storage events refresh other tabs. Simultaneous
writes in separate tabs follow localStorage's last-write-wins behavior.

Grouping never changes tile actions, module information routes, favorites,
catalog discovery or agent access. Unavailable modules can be grouped and remain
visible. New modules default to Work. Stale IDs produce no tiles and never move
a repository. Counts include only catalog modules, excluding New module.

Validation uses the existing synthetic preview Folder and external Playwright,
never a live Organization or installed product:

```sh
bun install --frozen-lockfile
bun run check
bun scripts/preview-launchpad.ts local cs 0 owner
# In another terminal, with external Playwright available through NODE_PATH:
bun scripts/smoke-workspace-groups.ts '<preview URL including fragment>' cs
```

The browser smoke checks moving and returning a module, reload, favorites,
keyboard tabs, person and Organization isolation, unavailable account, rejected
storage, malformed data, no-app modules and a narrow layout. Pure tests also
check unchanged actions and Productionspace, stale IDs and sequential writes
from multiple tabs. This is source-level UI evidence; release qualification and
installed-consumer acceptance remain the upstream release workflow's responsibility.
