# Launchpad parity: the Platform Launchpad replaces the resident Launchpad

Status: **shaping for the Principal's decision of 2026-09-28. Analysis and design
only.** Nothing here is implemented or approved. It replaces the two-move plan of
`docs/hosted-launchpad-switch-plan.md` (branch `claude/DEV-6626-distribution-and-migration`)
and keeps its facts. It depends on the Recovery mode shaping
([`docs/recovery-mode.md`](recovery-mode.md), branch `claude/DEV-6626-recovery-mode-shaping`,
proposed decision F21) and on F20 (first installation, pull request #62). Decisions
proposed here are numbered from F22.

Citations: a bare path is this repository at `0fa47cf`. `R:` is the legacy root
repository at `c9b57da8`. `M:` is the Machines repository at `7b2bcaa` (v0.12.91).
"Root issue #N" is an issue of the legacy root repository. **Unverified** marks what
could not be checked against code, documentation or a native run.

## 0. Recommendation

1. **One apply per Machine, no side-by-side period.** A Machines release removes the
   resident unit and installs the Platform's supervised `lazurio-launchpad.service` in
   the same apply, on the same hostname `launchpad.<vm>.<org>.lazurio.io`, the same
   port and the same cookie. There is no transition hostname and no renamed resident
   unit. The point of no return is inside that apply and comes **after** read-only
   preflights of the new Launchpad on the real Machine (section C).
2. **Parity means concepts, not code.** The resident Launchpad is 2 092 lines of
   server (`R:launchpad/src/server.mjs`) over a 5 054-line runtime
   (`R:lazurio/runtime/runtime-lib.mjs`). About a third of it is accidental: a Git
   client, a Mission Control plan browser, click ranking, a port-takeover audit, a
   second trust profile, source-hash restarts. The Platform carries twelve concepts
   over, each CLI first, and drops the rest (section F).
3. **The switch line is ten slices** (section E), five of them small:
   Recovery mode and the new unit (F21), the unit PATH, the handover entry in two
   repositories, Organizations read from the Folder, the module lifecycle from the CLI
   with logs, the gateway `ensure`, the Chat entry into T3 Code, a read-only
   `lazurio doctor`, and the Machines switch release qualified on a disposable local
   Linux VM. Content synchronization, SSH keys in the browser, the Team and Personal
   Environments and macOS follow, in that order.
4. **No new Folder state.** Every new capability reads its truth where it already
   lives: Organizations from `organizations/*`, running applications and their source
   from the OS service manager, logs from the journal, URLs from the Machine handover.
5. **Two existing Platform decisions must change** and are the Principal's: F12's
   transition-only admission (canonical-only Organizations must be able to run
   applications, H1), and the F15 addendum's "development Application panel stays on
   the Launchpad home" (the home becomes the real application catalog, B1).
   Recovery mode (F21) is a hard dependency of the switch line: without rollback,
   a switched Machine whose Launchpad cannot serve must land in Recovery mode, not in
   a gateway 502.

The first three slices: (1) F21 slices 2–4, the unit that never ends `failed`, with
the PATH line added; (2) the optional `entry` in the Machines handover schema; (3) the
Platform projecting that entry and serving hosted from it. After (3) a disposable
local Linux VM with a stand-in gateway already shows the Platform Launchpad on its
final hostname.

## A. Parity inventory

"Resident" is the Launchpad in `R:launchpad/` as Machines runs it on hosted VMs
(`M:workloads/workspace-vm/resident-services.mjs:47-88`) and as `lazurio launchpad
serve` runs it on workstations. "Platform" is this repository. "Switch" says whether
the gap blocks the switch of one hosted Work Environment (`hosted-organization-personal`):
**yes**, **no**, or the later line it belongs to (Team, Personal, macOS, new Machines).

### A.1 Applications and modules

| # | Capability | Resident, exactly | Platform today | Gap | Switch |
|---|---|---|---|---|---|
| 1 | Catalog | Scan-first over `organizations/*`, one resolver preferring `lazurio.organization.json` over `company.gen3.json` (`R:lazurio/runtime/discovery-lib.mjs:1832-1963`); modules from `modules.manifest.json#module_slots[]`, apps from `lazurio.module.json` + `package.json#lazurio.runtime` (`:992-1024`); invalid apps isolated | One explicit `--organization-directory` (`src/cli.ts:429-432`), read live (`src/organizations/read-applications.ts:49-60`); `organization-inspect` CLI (`src/cli.ts:221-242`); home page is a hand-typed developer form (`src/launchpad/index.html:295-321`) | Multi-Organization discovery; a real catalog view | yes |
| 2 | Execution admission | Any resolved root, with projection drift a warning (`R:…/discovery-lib.mjs:1896-1897`) | Only a parity-valid `transition` root; canonical-only `current` is inspection-only (`src/organizations/read-applications.ts:13-17`; F12, `docs/decisions.md:555-562`) | Canonical Organizations cannot run apps | yes (H1) |
| 3 | Install dependencies | `bun install --frozen-lockfile`; `repair` deletes `node_modules`; a running app is stopped and restarted around it (`R:lazurio/runtime/runtime-lib.mjs:1041-1178`, `:1062-1067`) | `prepare` and `clean-prepare` through the module's declared preparation (`src/modules/lifecycle.ts:199`); refused under a running service (`docs/module-adoption.md:556-565`) | Only reachable with `--bun-executable`, which the installed unit does not pass (`src/update/install.ts:91-98`) | yes |
| 4 | Start, stop, restart | Detached child in its own process group (`R:…/runtime-lib.mjs:591`, `:732`); `restart` = stop + start (`:1870`) | Transient systemd user services on Linux, session children on macOS (`src/modules/application-runner.ts:4-17`, `src/modules/systemd-user-runner.ts`) | Wiring into the installed Launchpad and the CLI; no `restart` verb (not needed, see B3) | yes |
| 5 | Open (one click) | Install if needed → start or reuse → wait healthy → return URL; records `usage.json` (`R:…/runtime-lib.mjs:1185-1316`) | `entrypoint` returns a loopback URL (`src/modules/lifecycle.ts:430-494`); shown only locally (`src/launchpad/ui.ts:421-430`) | One-action Open; external-origin links on hosted | yes |
| 6 | Health | Declared health probe, `GET|POST …/health` (`R:…/runtime-lib.mjs:3430`) | Readiness observation inside start/status, with control-group ownership (`src/modules/health.ts:48`, `docs/module-adoption.md:523-527`) | None (Platform is stronger) | no |
| 7 | Logs | `launchpad/logs/apps/<id>.log`, `GET …/logs` (`R:…/runtime-lib.mjs:1897`); stripped on the Personalspace lane (`R:launchpad/src/server.mjs:1330-1336`) | Output discarded: `StandardOutput=null` (`src/modules/systemd-user-runner.ts:77-79`; `docs/module-adoption.md:667`) | Logs | yes |
| 8 | Source: `main` or worktree | Every mutating action names `{type:"main"}` or `{type:"worktree",slug}` (`R:lazurio/runtime/runtime-source-lib.mjs:3-20`); choice per browser tab in memory (`R:launchpad/public/app.js:4868-4920`); CLI always `main` | Not supported (`docs/module-adoption.md:668-669`) | Worktree source | Q (H3) |
| 9 | Ports and leases | Port only in `lazurio.module.json`; same-module/worktree peer replaced; same-Organization collision refused; cross-Organization takeover needs confirmation and is audited (`R:…/runtime-lib.mjs:3021-3195`, `:977-1016`) | Leases declared and resolved (`src/modules/runtime.ts:86-177`); an occupied port is refused (`src/modules/listener-observation.ts:72-75`) | Takeover as an explicit Stop of the holder (workstation only) | macOS |
| 10 | Hosted `ensure` | `GET /api/internal/hosted/modules/<id>/ensure` from the gateway; `Sec-Fetch-Mode: navigate` or none starts, a WebSocket or fetch does not; 204 healthy, 503 starting, 404 unknown (`R:launchpad/src/server.mjs:1376-1404`; `R:launchpad/src/hosted-readiness-lib.mjs:4-8`; `R:launchpad/docs/hosted-workspace-parity-contract.md:120-135`) | No `/api/internal/*`; every GET but update status is 405 (`src/launchpad/server.ts:223-233`) | `ensure` | yes |
| 11 | Hosted stop semantics | Stop holds until the next Open (`R:…/runtime-lib.mjs:1375-1391`; root decision 0137) | Stop stops the unit; nothing restarts it (`docs/module-adoption.md:538-546`) | None: the same semantics fall out of `ensure` | no |
| 12 | Session-scoped processes (localhost) | Graceful shutdown stops all; nothing restored (`R:launchpad/src/server.mjs:1768-1782`) | `session` runner on macOS, same semantics (`docs/module-adoption.md:437`) | None | no |
| 13 | CLI lifecycle | `lazurio module status|start|open|stop <Org/Module> [--json]`, result `result.runtime.url` (`R:lazurio/core/module-lifecycle-client-lib.mjs`); on hosted only `status` works, the rest needs the browser (`:76-84`) | `app-request` over stdin with a private session URL (`src/cli.ts:243-264`); status and stop without a Launchpad on Linux only (`src/cli.ts:99-151`) | A real `lazurio module` command family | yes |

### A.2 Organizations

| # | Capability | Resident | Platform today | Gap | Switch |
|---|---|---|---|---|---|
| 14 | Discovery | Scan of `organizations/*`; hosted catalog filtered to one Organization and Team by environment (`R:launchpad/src/server.mjs:587-588`), a documented limitation (`R:manual/hosted-machine-handover.md:121-134`) | None (A.1 #1) | Discovery from the Folder | yes |
| 15 | Organization install | `lazurio organization install <login> [--role builder|steward]`, Admin = no role, restricted slots excluded for roles, repository-db bootstrap (`R:lazurio/organization-install-lib.mjs:62-78`, `:875-877`, `:440`); root path hard-coded `organizations/<login>_GEN3` (`:139-141`); in-app from the GitHub setup step (`R:launchpad/src/setup-github-lib.mjs:803-805`) | None; F9 not implemented (`docs/content-sync.md:3-6`) | Materialization | new Machines |
| 16 | Synchronize / update | `lazurio update`: root → Organization roots → children, recovery stash, ff-only (`R:lazurio/runtime/lazurio-update-lib.mjs:122-358`, `:742-758`); `POST /api/update`, `/api/sync`; legacy `pull`, `pull-autostash`, `pull-all` routes run the full update (`R:launchpad/src/server.mjs:1466-1483`) | None; the manual tells agents `git pull --ff-only` on a clean default branch (`docs/decisions.md:729-731`) | Explicit sync | after switch |
| 17 | Roles builder/steward/admin | Scope filter on restricted slots (root decision 0143) | None | See B7: no role flag | new Machines |
| 18 | Teams grouping | `module_slots[].teams` N:M, legacy fallbacks (`R:…/discovery-lib.mjs:910`; `R:launchpad/public/app.js:2509`) | Team only as manual text and binding fields (`src/folder/machine-binding.ts:16-30`) | Grouping in the catalog | yes (display only) |
| 19 | Productionspace | Read-only cards (`R:launchpad/public/app.js:2914-3056`) | None | Not carried (F) | no |
| 20 | Template Organizations | Excluded from runtime (`R:…/discovery-lib.mjs:1937-1952`) | Refused fail-closed (`src/organizations/read-applications.ts:13-17`) | None | no |
| 21 | Logo and theme | `GET /api/organizations/:slug/logo` (`R:launchpad/src/server.mjs:281-288`) | None | Later, display only | no |

### A.3 Chat, GitHub, SSH, Personalspace

| # | Capability | Resident | Platform today | Gap | Switch |
|---|---|---|---|---|---|
| 22 | Chat into T3 Code | `POST /api/chat/pair` runs `LAZURIO_T3CODE_PAIRING_COMMAND --ttl 60s --label launchpad-chat --json` and returns `<t3>/pair#token=…` (`R:launchpad/src/t3-chat-lib.mjs:17-25`, `:71-90`; `R:launchpad/public/app.js:2260-2281`); URL and command come from the unit's environment (`M:workloads/workspace-vm/resident-services.mjs:77-78`) | None; prompts are pasted into T3 by hand (`src/launchpad/messages.ts:333`) | Chat entry | yes |
| 23 | GitHub sign-in | Device flow, SSH key created and added, `ssh -T` and `git ls-remote <login>/<login>_GEN3` proof; logout removes the key (`R:launchpad/src/setup-github-lib.mjs:502-567`, `:685-773`); reads `company.gen3.json` through `gh api` (`:777-788`) | Present and stronger: host keys, proof, key title, sign-out removes only its own key (F19, `docs/decisions.md:1303`; `src/tools/ssh-key.ts:581`, `:659`) | None on Work; server refusal on Team (`docs/decisions.md:837-838`) | Team |
| 24 | SSH authorized keys | Hosted Settings → SSH: list, add, remove keys marked `lazurio-launchpad`, audited (`R:launchpad/src/ssh-access-lib.mjs:17`, `:230`; `R:launchpad/src/server.mjs:1556-1575`) | None | Access section | after switch |
| 25 | Machine connections (laptop) | Local profile: Headscale join files a GitHub issue; per-peer SSH config and pinned `known_hosts` (`R:launchpad/src/laptop-network-lib.mjs:9-26`); a documented temporary bridge (root issue #416) | None | Not carried; F16 owns it (F) | no |
| 26 | Personalspace lane | Separate discovery and runtime, gbrain notes, logs stripped (`R:launchpad/src/server.mjs:1248-1367`, `:297-308`); 404 on a Team Machine (`R:launchpad/src/setup-github-lib.mjs:180-192`) | Folder policy `present`/`never` only (`src/folder/handover-layout.ts:15`) | Personalspace applications | Personal |

### A.4 Settings, Guide, update, doctor, desktop, trust

| # | Capability | Resident | Platform today | Gap | Switch |
|---|---|---|---|---|---|
| 27 | Settings | `/settings/{general,github,network,connections,ssh}` from `settings.html` (`R:launchpad/src/server.mjs:2080-2083`) | T3 Code pattern, `/settings/{general,machine,tools}` (`src/launchpad/routes.ts:20-24`; `docs/launchpad-development.md:56-128`) | Access and Diagnostics sections | partly |
| 28 | Guide and manual | Tile links out to the documentation site (`R:launchpad/public/guide-link.js:1-7`); `GET /api/guide/organization-install` renders a root manual (`R:launchpad/src/server.mjs:2028-2042`) | Manual in the Folder (F14) | A help link | no |
| 29 | Product update | None in the Launchpad; hosted runtime is a pinned artifact; on a source checkout `lazurio update` pulls the root itself (`R:manual/lazurio-runtime-install-interface.md:47`) | `lazurio update`, pill, floor (`docs/update.md`); rollback removed by F21 | None | no |
| 30 | Doctor | `lazurio doctor [--tool-updates] [--json]`, child doctors, Doctor chip (`R:lazurio/lib.mjs:108-136`; `R:launchpad/src/server.mjs:898-933`); unfixable failures on hosted residents (root issue #434) | Not implemented; accepted direction (`docs/legacy-adoption.md:35-55`); the manual already names `lazurio doctor` (`src/folder/manual.ts:709-710`) | Read-only doctor | yes |
| 31 | Desktop launcher | macOS `.app` running `Launchpad.command` (`R:scripts/install-launchpad-macos.sh`); Windows Start Menu link (`R:lazurio/launchpad-install-lib.mjs:3-32`) | None | Desktop entry | macOS |
| 32 | `serve` and locator | Reuse a compatible instance, else foreground; `server.json` locator, lifetime lock; `LAZURIO_SERVER_STATE_PERMISSION_REQUIRED`; a source change makes the server "stale" and the next `serve` kills its session apps (`R:lazurio/core/server-identity-lib.mjs:227-247`; `R:launchpad/src/server-startup-lib.mjs:48-60`) | `lazurio launchpad --folder` in the foreground; installed mode has a health socket (`src/launchpad/server.ts:44-58`) | A CLI path to a running workstation Launchpad | macOS |
| 33 | Hosted admission | Loopback backend Host required; mutations need same-origin and the external origin; one cookie revalidated at `/oauth2/auth` in 2 s; no identity header trusted (`R:launchpad/src/request-trust-lib.mjs:62-117`) | Same model, browser `Host` required instead of loopback, 3 s, 2-minute positive cache (`src/launchpad/hosted-trust.ts:140-197`) | Gateway must keep the browser Host (C.2); cookie chunks for personal VMs (`src/launchpad/hosted-trust.ts:101-121`) | yes / Personal |
| 34 | Supervision | `Restart=always`, never `failed`; apps are its children and die with every restart (`M:workloads/workspace-vm/README.md:861-880`) | `Restart=on-failure`, start limit, `OnFailure=lazurio-rollback.service` (`src/update/install.ts:79-109`); F21 replaces it with `Restart=always` | F21 | yes |

### A.5 Only in the resident, not listed above

Mission Control plan list and guarded worktree creation (`R:launchpad/src/worktree-actions-lib.mjs:56-75`),
"Publikovat draft" running `git add -A`, commit and push from the browser (`:428-507`),
a Git read model with background fetch (`R:launchpad/README.md:1036-1062`),
notifications, "most used" and recent changes (`R:launchpad/src/server.mjs:981-1003`),
open a module folder in the OS (`:1217-1244`), a Codex hand-off dialog
(`R:launchpad/public/codex-handoff.js`), read-only plugins, `lazurio search`, the
superseded personal-entry trust profile (`R:launchpad/src/personal-entry-lib.mjs`),
the hosted maintenance loop that re-derives the app set every 15 s
(`R:launchpad/src/server.mjs:545-552`). The repository-db "Publikovat změny" button is
not the Launchpad's; it belongs to the Mission Control application
(`R:manual/workspace-module-version-lifecycle.md:223-236`). Dispositions are in F.

### A.6 What the Platform has and the resident does not

Enabled tools with notes and the agent instructions they shape (F18), curated
install and sign-in of `gh`, `composio`, `wacli` with SSH-key linking (F19), the
product update pill and the version floor (F13, F17), the Folder profile and preset
with preview and apply (F10), the generated manual (F14), applications that survive a
Launchpad restart (F8), hosted admission behind a private shell socket
(`src/launchpad/server.ts:139-156`). These are the reasons to switch; none of them
has to be built for it.

## B. Concept by concept

Each concept names what the resident got wrong or accidental, then the Platform
design: CLI first, state, surface, hosted trust, tests. Command names keep the
resident's `lazurio module …` and `lazurio organization …`, because root `AGENTS.md`
teaches agents exactly these (`R:AGENTS.md:311-313`); their JSON is new and documented.

### B1. Catalog: Organizations and modules read from the Folder

**Accidental in the resident.** Discovery is 2 909 lines that also read the legacy
projection, planned slots from a gitignored `launchpad.gen3.local.json`, a
`launchpad.gen3.json` it then ignores (`R:…/discovery-lib.mjs:1648-1661`), and on hosted
a single-Organization filter set by environment variables. Module hostnames derived
from module and Machine alone collide across Organizations
(`R:manual/hosted-machine-handover.md:117-130`).

**Design.**

- CLI: `lazurio organization list [--json]` and `lazurio module list [<Org>] [--json]`.
  The Folder comes from the operator's standard Folder (`<home>/Lazurio`, recorded in
  the supervised unit as `[X-Lazurio] Folder=`, `src/update/install.ts:79-109`) or
  `--folder`.
- Discovery: every directory in `<Folder>/organizations/` is one candidate; the
  existing canonical reader resolves it (`src/organizations/root-resolution.ts`); a
  failure isolates that Organization with its reason, never the list. Templates stay
  refused. No allowlist, no planned slots.
- Output per module: Organization slug, module id, default app, Teams, root state,
  `executable` with a reason, and on hosted the external origin (B4).
- **State: none.** The list is recomputed on every read, as the resident does after
  Sync.
- Surface: the Launchpad home becomes the catalog in T3 Code's sidebar pattern. The
  sidebar lists Organizations as groups (T3's projects), modules as rows with a status
  dot (T3's threads), a subheader per Team. `/` is an overview of every module's
  default app; `/o/<org>` and `/o/<org>/<module>` are routes like `/settings/<section>`
  (`src/launchpad/routes.ts`). The developer form and its "Development fixture only"
  banner (`src/launchpad/messages.ts:367`) go away. This changes the F15 addendum
  sentence "the development Application panel stays on the Launchpad home"
  (`docs/decisions.md:820-821`).
- Hosted trust: nothing new; reads pass the same admission.
- Tests: fixtures with two Organizations, one invalid, one template, one canonical
  `current`; CLI and HTTP give equal lists; Team grouping N:M.

**Execution admission (F12).** Today only a parity-valid `transition` root can run an
application; `current` waits for an upstream "identity continuity proof"
(`docs/organization-contract.md:64-83`). Which state the real Organizations are in is
**unverified**. If any is `current`, the switch loses its applications.

| Variant | Assessment |
|---|---|
| A. Keep the gate until upstream defines the proof | No product change; any canonical-only Organization is dead on a switched Machine; no owner of the proof is named |
| B. `current` is executable; the checkout is the operator's, GitHub already decided access when it was cloned | One line of admission; consistent with "GitHub is the only access authority"; the projection gate was migration machinery (F12's own wording) |

**Recommended: B**, as proposed decision F22 point 1 (H1).

### B2. Toolchain without flags

**Accidental.** The Platform's installed unit cannot run applications because module
operations are enabled only by `--bun-executable` on the command line
(`src/cli.ts:433-478`), which the installer never writes (`src/update/install.ts:91-98`).
The resident ran Bun from `~/.local/bin/bun`, put first on the unit's PATH
(`M:workloads/workspace-vm/resident-services.mjs:67-79`).

| Variant | Assessment |
|---|---|
| A. The installer writes `--bun-executable` into the unit | Machine-specific text in a product unit; a Bun update that moves the binary breaks the unit |
| B. Resolve Bun at each operation from the standard path `~/.local/bin/bun` (F17 addendum, `docs/decisions.md:993-1013`), refuse with `toolchain-missing` and the `lazurio tools` hint | One rule for CLI, Launchpad and every Machine; follows the operator's own Bun updates |

**Recommended: B.** The unit gets `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`
(the Tools section already probes `process.env.PATH`, `src/launchpad/server.ts:109-115`);
the Platform owns that line because F17 makes `~/.local/bin` the standard path. The
lifecycle is then always composed, locally and hosted; `--organization-directory` and
`--bun-executable` remain development flags only.

### B3. Module lifecycle, CLI first

**Accidental in the resident.** On hosted the CLI can only read status; start, open
and stop need the signed-in browser (`R:lazurio/core/module-lifecycle-client-lib.mjs:76-84`),
so an agent in T3 on the same Machine cannot start the module it is changing.
Applications are Launchpad children, so every Launchpad restart stops them
(`M:workloads/workspace-vm/README.md:875-880`). A source change makes the server
"stale" and kills its session (`R:launchpad/src/server-startup-lib.mjs:48-60`).
`repair` stops a running app as a side effect (`R:…/runtime-lib.mjs:1062-1067`).

**Design.**

- CLI: `lazurio module status|prepare|start|open|stop|logs <Org>/<Module> [--app <package>] [--source <main|worktree:name>] [--json]`.
  `open` = prepare when needed, start or reuse, wait for readiness, print the URL
  (`runtime.url`, the name root `AGENTS.md` uses). On Linux every verb runs without a
  Launchpad, through the systemd-user runner and the coordination lock that already
  make `status` and `stop` work (`docs/module-adoption.md:630-634`). `start` and
  `prepare` need the toolchain adapter, which B2 makes available to the CLI.
- The installed Launchpad composes the same lifecycle; the Open button calls `open`.
- `restart` is not a verb: `stop` then `start`, which the page may offer as one button.
- Preparation under a running application stays refused (`application-running`); the
  page offers "Stop and reinstall" as an explicit two-step action. No side effect.
- **State: none.** Identity, invocation and source are in the service manager.
- `app-request` (stdin, session URL) is retired once `lazurio module` exists; its
  retirement is part of the slice.
- Hosted trust: the CLI runs as the operator OS account on the Machine; that is the
  same authority the T3 agent already has. No browser credential is involved.
- Tests: CLI/HTTP equivalence per verb; a Launchpad restart keeps a started module
  (same `InvocationID`, as `scripts/smoke-application-service.ts` already proves);
  concurrent `start` from CLI and page serialize.

### B4. Hosted links and the handover entry

**Accidental.** The resident composes module URLs from environment variables
(`R:lazurio/runtime/hosted-app-url-lib.mjs:544-556`); the Platform refuses to compose
URLs at all (`docs/hosted-entry.md:59-63`) and has no entry yet: the Machines handover
schema lacks it and the vendored copy is closed (`src/machine/lazurio-machine.v1.schema.json:10`;
`src/machine/schema-provenance.json`, Machines v0.12.61); `src/machine/binding.ts`
projects no entry although the binding parser accepts one
(`src/folder/machine-binding.ts:240-290`).

**Design.** The handover gains an optional `entry` written by Machines from the same
rendering as its gateway:

```json
"entry": {
  "launchpad": { "external_origin": "https://launchpad.<vm>.<org>.lazurio.io",
                 "auth_check_url": "https://<vm>.<org>.lazurio.io/oauth2/auth",
                 "auth_cookie_name": "__Secure-lazurio-workspace",
                 "listen_port": 0 },
  "t3code":    { "external_origin": "https://t3code.<vm>.<org>.lazurio.io" },
  "modules":   { "origin_template": "https://{module}.<vm>.<org>.lazurio.io" }
}
```

| Variant for module links | Assessment |
|---|---|
| A. `modules.origin_template` in the handover | Static, one writer (Machines), the same rule its gateway catalog uses (`M:…/gateway-catalog.py:225-237`); the Platform substitutes a validated module id and composes nothing else |
| B. Machines writes the live gateway catalog as JSON for the operator to read | Exact routes, but a second file with its own refresh (the catalog timer runs every 30 s, `M:workloads/workspace-vm/gateway.mjs:115-150`) and a second reader |
| C. Derive from the Launchpad origin by replacing its first label | Composition from a convention; forbidden by `docs/hosted-entry.md:59-63` |

**Recommended: A.** The Platform projects `entry` into the binding
(`src/machine/binding.ts`), `folder-refresh` re-records it (declaration, not identity,
`docs/machine-handover.md:280-295`), and the Launchpad serves hosted from it as today.
The same `entry.launchpad` shape already parsed by `src/launchpad/hosted-trust.ts:45-86`
stays. Two Organizations with the same module id on one Machine produce one hostname;
`ensure` answers `module-ambiguous` (B5) and the fix belongs to Machines' template
(`{organization}` in it) — a risk, G.

### B5. The gateway `ensure`

**Accidental.** The resident required a loopback `Host` on every hosted request
(`R:launchpad/src/request-trust-lib.mjs:62-64`), so the gateway rewrites `Host` for the
Launchpad (`M:workloads/workspace-vm/ingress.ts:303-313`) and for `ensure`
(`:124-138`). The Platform, correctly, admits only the browser's `Host`
(`src/launchpad/hosted-trust.ts:181-182`) and answers every loopback request
`host-mismatch`.

| Variant | Assessment |
|---|---|
| A. The Platform accepts a loopback `Host` on `/api/internal/*` | A second admission rule inside the adapter; the reason F11 selected one rule |
| B. The gateway sends `Host: launchpad.<vm>.<org>…` on the `ensure` subrequest and stops rewriting `Host` on the Launchpad route | One admission rule; Caddy sets it in the same `header_up` lines; the browser cannot reach `/api/internal/*` because the gateway answers 404 there on every public hostname (`M:workloads/workspace-vm/ingress.ts:34`, `:54-57`) |
| C. `ensure` over a unix socket reachable only by the gateway | Caddy runs as a `DynamicUser` (`M:…/gateway.mjs:87-91`); socket ownership across users is its own mechanism |

**Recommended: B.** Platform contract, copied from the resident's proven one
(`R:launchpad/docs/hosted-workspace-parity-contract.md:120-135`):

- `GET /api/internal/hosted/modules/<module-id>/ensure`, admitted by the ordinary
  hosted rule plus the non-GET rule applied to it (same-origin, `Origin` equals the
  Launchpad origin), cookie revalidated;
- `Sec-Fetch-Mode: navigate` or absent → Open (starts even an explicitly stopped
  module, prepares when needed); anything else, or `Sec-WebSocket-Key`, only reports;
- 204 healthy, 503 starting or preparing (bounded body, no internal addresses), 404
  unknown or not executable, 409 `module-ambiguous`;
- the module's default app only (`default_app` in `lazurio.module.json`).

CLI equivalent: `lazurio module open`. No state. Tests: each header combination;
a WebSocket reconnect never starts; a stopped module starts on navigate; an unadmitted
subrequest is 401; `ensure` concurrent with `open` serializes.

### B6. Logs

**Accidental.** The resident writes log files under its own tree and returns full text
on the Organization lane but not the Personalspace lane, undocumented
(`R:launchpad/src/server.mjs:1330-1336`). The Platform discards output.

| Variant | Assessment |
|---|---|
| A. `StandardOutput=journal` on Linux; read with `journalctl --user -u <unit> -n <N> -o cat` | The OS owns retention and rotation; no file in the Folder or a module checkout; identity is the unit |
| B. Files under the install base | Rotation, permissions and cleanup become ours |

**Recommended: A on Linux**; macOS session runner writes a bounded ring file under
the per-user state directory (macOS line). `lazurio module logs <Org>/<Module> [--lines N] [--json]`;
the page shows a tail on the module route. Hosted trust: whoever is admitted sees the
logs, as with the resident; on a Team Environment all admitted members see them.
Personalspace logs are not shown in the browser (keep the resident's rule, document
it). The fixed unit policy compared on adoption changes one property
(`src/modules/systemd-user-runner.ts:65-80`), so running units started by an older
release are `service-unrecognized` until stopped once; the release notes and the
switch apply handle it (no module runs under the Platform before the switch).
This amends F8's "Not done" item (`docs/module-adoption.md:667`), not F8.

### B7. Organizations: synchronize and materialize

**Accidental in the resident.** `lazurio update` means content sync there and product
update in the Platform. It stashes dirty work and switches branches (root decision
0129), which F9 rejects (`docs/content-sync.md:63-73`). Legacy `pull` routes run the
whole update (`R:launchpad/src/server.mjs:1466-1483`). Install hard-codes
`<login>_GEN3` and reads the deprecated manifest (`R:launchpad/src/setup-github-lib.mjs:777-788`).
Roles are a scope flag on top of GitHub rights (`R:lazurio/organization-install-lib.mjs:62-78`).

**Design.** Implement `docs/content-sync.md` as written:
`lazurio organization sync [<Org>] [--json]` materializes absent declared repositories
and fast-forwards clean ones; `lazurio organization add <github-org>/<root-repo>`
materializes a new root and then syncs it. No role flag: a slot the signed-in identity
cannot read is `denied`; a slot declared `restricted` is never materialized implicitly,
only with `--slot <name>`. Repository-db mounts stay the Organization's own bootstrap
(root decisions 0138/0152), called as a declared preparation, not a sync side effect.
Surface: "Synchronize" as the page action in the Organization view header, "Add
Organization" at the bottom of the sidebar (T3's "Add project"). No state. On a Team
Environment the identity is the broker's `gh` wrapper that Machines installs
(`M:workloads/workspace-vm/README.md:76-154`); the Platform uses whatever `git` and `gh`
the operator account resolves and names the identity in the result.

**Not on the switch line** for existing Machines: their repositories exist, and agents
fast-forward by hand as the manual says. It is on the line for **new** Work Machines
(A.2 #15), see E.

### B8. Chat into T3 Code

**Accidental.** Pairing URL and command live in the resident unit's environment
(`M:workloads/workspace-vm/resident-services.mjs:77-78`); a local profile with Chat
configured refuses to start (`R:launchpad/src/server.mjs:167-171`).

**Design.** `lazurio chat link [--json]`: runs the T3 launcher from the standard path
(`~/.local/bin/t3 … pairing create --ttl 60s --label launchpad-chat --json`; the
launcher's path is Machines' DEV-6624 work, **unverified** as merged) and prints
`<entry.t3code.external_origin>/pair#token=…`. The Launchpad sidebar header gets
"Chat" as its primary action (T3's "New thread" place); it opens the link in a new tab.
Without `entry.t3code` the button is absent (workstation). No state; the token is
single-use, 60 s, never logged. Recovery mode uses the same link for "Start a repair
agent" ([recovery mode](recovery-mode.md), C.3). Tests: a fake launcher; exact-form
acceptance of its output; the token never appears in logs or errors.

### B9. Doctor

**Accidental.** The resident's doctor mixes source-checkout checks (`git.root`,
`doctor:task` preflight) with Machine health, and fails unfixably on hosted residents
(root issue #434); child doctors block the event loop (`R:launchpad/src/server.mjs:914-919`).

**Design.** `lazurio doctor [--json]`, read-only, aggregating what already exists:
`update status`, the supervised unit (marker, active, `NRestarts`), Folder state and
revision (`folderRefresh`), the recorded entry, `organization list` failures,
`module list` executability, `tools status`. Severity `ok|warn|fail`; exit 0/1. No
repair, no network except what `update status` reads from cache. `lazurio recover`
(F21) stays the broken-product path; doctor is the healthy-product readback that the
F17 addendum already expects Machines to collect (`docs/decisions.md:1006-1009`).
Surface: `/settings/diagnostics` (T3 Code has a Diagnostics section).

### B10. SSH authorized keys (Access)

**Accidental.** A separate audit file in the resident tree
(`R:launchpad/src/ssh-access-lib.mjs`) and a hosted-only switch in code.

**Design.** `lazurio ssh-keys list|add|remove [--json]` editing only lines marked
`lazurio` in the operator's `~/.ssh/authorized_keys`, atomically; the resident's marker
`lazurio-launchpad` is recognized as ours. Settings → Access on hosted presets only.
On a Team Environment any admitted member can add a key to the shared account; that
equals the shell T3 already gives them, and the page says so. After the switch line;
until then an agent in T3 edits the file.

### B11. Personalspace applications

**Design.** `lazurio module …` addresses `personalspace/<owner>/workspace/<module>` as
`@personal/<module>`; discovery reads the one Personalspace present
(`src/folder/handover-layout.ts:15`, policy `present`); the gbrain note browser is not
carried (F). Logs are not shown in the browser. Needs the cookie chunks on the
personal VM gateway (`M:workloads/workspace-vm/gateway.mjs:52-57`;
`src/launchpad/hosted-trust.ts:101-121`), a security-surface change with its own tests.
Personal line only.

### B12. Team Environment and "Lazurio for GitHub"

**Design.** The server refuses `tools login gh` and `tools logout gh` on
`hosted-organization-team` (`blocked team-environment`), closing the gap the F15
addendum names (`docs/decisions.md:837-838`). Tools shows the GitHub identity the
account resolves (the broker's bot, `M:workloads/workspace-vm/README.md:76-154`)
read-only. Attribution is Machines' and the broker's: committer
`lazurio-for-github[bot]`, trailer `Lazurio-Workspace: <org>/<team>` (root decision
0148). "GitHub shows which Environment made it" needs the Machine in that trailer;
proposed as `Lazurio-Environment: <machine>.<org>` in H6. Team line.

### B13. The Launchpad unit

Taken from F21 ([recovery mode](recovery-mode.md), F.1): `Restart=always`,
`RestartSec=5`, start limit pinned so it never ends `failed`, no `OnFailure=`, the
PATH line of B2. `KillMode` stays the default: modules are separate transient units,
so a Launchpad restart no longer stops them (A.4 #34). Nothing else is added; the port
and host come from the Folder's entry.

## C. The hosted switch without a side-by-side period

### C.1 What must be true before a Machine switches

| # | Condition | Proven by |
|---|---|---|
| 1 | A Platform release with the switch-line slices P1–P8 (E) is published and passed F21's journeys | Its release evidence |
| 2 | A Machines release with M1 (schema) and M2 (switch) is published, pinning that Platform release as its minimum | Machines CI incl. the pinned-Caddy ingress proof (`M:.github/workflows/ci.yml:44-58`) |
| 3 | Both passed the local VM qualification of C.5 | The evidence file of C.5 |
| 4 | On the target Machine, the Platform is installed (already true where the role pins it, `M:workloads/workspace-vm/ansible/roles/workspace_platform/tasks/install.yml:38-50`) and at or above the pin | `lazurio update status --json` |
| 5 | The Folder is drift-free, so the entry can be recorded | `lazurio machine folder-refresh` answers `refreshed` or `unchanged` |
| 6 | Every module the operator uses is executable under the Platform | `lazurio module list --json` on the Machine, read-only, run by the apply before the point of no return |

### C.2 The apply, in order

Owned by Machines M2; each step names its readback.

1. Write the handover with `entry` (`workspace_identity`).
2. Install or raise the Platform (`install --base …`, offline update, unchanged).
3. `lazurio machine folder-refresh`: must record the entry. `blocked` stops the apply
   **here**, with the resident untouched.
4. **Preflight, read-only:** `lazurio doctor --json` with the Folder and `lazurio
   module list --json`. A `fail`, or a module that ran under the resident and is not
   `executable` now, stops the apply here. The candidate's own start sequence was
   already proven by F21's pre-switch probe (`self-check --launchpad`).
5. **Point of no return.** Stop and disable the resident unit, remove
   `~/.config/systemd/user/lazurio-launchpad.service` only when it lacks the
   Platform's marker line (`src/update/service-control.ts:19-20`), `daemon-reload`.
   Its modules, children of the resident, stop with it
   (`M:workloads/workspace-vm/README.md:875-880`).
6. `<base>/bin/lazurio install --base <base> --service systemd-user --folder <home>/Lazurio --json`
   with `XDG_RUNTIME_DIR` set (`M:…/workspace_services/tasks/main.yml:67-68` already
   does it for its units). It writes and starts the unit on the entry port.
7. Gateway: the `launchpad` route becomes a snippet with admission and the internal
   deny, **without** `header_up Host` and **without** cookie stripping; the `ensure`
   subrequest sends `Host: launchpad.<vm>.<org>…` (B5); the static Recovery page of
   F21 (variant 2b) stands behind the Launchpad upstream.
8. Remove `~/Lazurio/launchpad.gen3.json` and `launchpad.gen3.local.json` when Machines
   wrote them (`M:workloads/workspace-vm/ansible/roles/workspace_resident/tasks/discovery.yml:1-39`);
   stop writing them. Remove the resident runtime (`~/.local/share/lazurio/resident/`),
   its state (`~/.local/state/lazurio/launchpad`, `resident-selection.json`) and the
   `workspace_resident` tasks. `t3code/` stays: T3 is baseline (F17). What
   `operator-kit/` holds and whether anything else needs it is **unverified**; Machines
   decides.
9. Readback: the checklist of C.3, items 1–6, as apply findings.

Steps 5–8 run in one role invocation. An interruption after step 5 leaves no
Launchpad; the next apply converges forward (steps are idempotent: a missing resident
unit is fine, `install --service` is convergent, `src/update/install.ts:173-176`), and
the gateway's static Recovery page answers meanwhile. There is no path back to the
resident: its artifact is not re-installed by any role after M2.

### C.3 Acceptance checklist of a switched Machine

An agent runs it on the Machine (1–10) and in the browser of the operator (11–16).
Every item has one expected answer.

1. `systemctl --user is-active lazurio-launchpad.service` → `active`; `systemctl --user cat`
   shows the installer marker on line 1, `Restart=always`, no `OnFailure=`.
2. No `lazurio-rollback.service`, no resident unit or runtime directory.
3. `lazurio update status --json` → `supervised: true`, `folderRefresh` null.
4. `lazurio doctor --json` → no `fail`.
5. `ss -ltnp` → exactly one listener on the entry port, in the unit's control group.
6. `ls ~/Lazurio` → no `launchpad.gen3*.json`; `lazurio machine folder-refresh` → `unchanged`.
7. `lazurio module list --json` → every module `executable`.
8. `lazurio module open <Org>/<Module> --json` → `runtime.url` on
   `https://<module>.<vm>.<org>.lazurio.io`; `lazurio module logs` shows lines.
9. `systemctl --user restart lazurio-launchpad.service`, then `lazurio module status`
   → the same module running with the same invocation.
10. `lazurio chat link --json` → a `…/pair#token=` URL on the T3 origin.
11. `https://launchpad.<vm>.<org>.lazurio.io/` after sign-in → the catalog with every
    Organization and Team group.
12. Open a module from the catalog → it opens healthy on its own hostname.
13. `lazurio module stop …`, then open the module's hostname cold → the starting page,
    then the module (`ensure`); a reload of a background tab does not start it.
14. "Chat" → T3 Code opens paired; a new thread runs `lazurio --version`.
15. The update pill takes the next patch; modules keep running; item 3 again.
16. A repeated Machines apply changes nothing; modules keep running.

A reboot (the unit starts with linger, modules start only on Open) stays in the
manual qualification, as F21 notes for runners.

### C.4 Order of repositories

1. **Platform** P1–P8 (E), each its own pull request and release.
2. **Machines** M1: optional `entry` in the schema (both lanes), no writer. Released.
3. **Platform** re-pins the schema byte-for-byte and projects `entry` (P3). Released.
   An older Platform refuses a handover with an unknown field (closed schema), so no
   Machine may receive `entry` before it runs P3 or later; M2 therefore pins P3+ as
   its minimum.
4. **Machines** M2: the apply of C.2, gateway changes, readback, deletion of the
   resident layer from the workspace-VM lane (`M:ARCHITECTURE.md:179-214` names it
   migration input to be deleted). Released after C.5.
5. **Owner overlay** of one Work Machine: pin the Machines and Platform releases,
   Plan, Permit, apply, checklist. Then the other Work Machines, one overlay change
   each.

### C.5 Qualification on a disposable local Linux VM

Machines has no local-VM harness (`M:workloads/workspace-vm/FLEET.md:13`: "local tests
do not constitute live fleet qualification"; no harness found). The switch needs one,
slice M3:

- a disposable Debian/Ubuntu VM on the qualifier's computer (the Platform's hosted-entry
  evidence already used one, `docs/evidence/hosted-entry-linux-arm64-2026-09-26.md`),
  applied by the Machines playbook **with the previous Machines release first** (so the
  resident runs with a real module), then with M2;
- a stand-in auth endpoint in place of the shared issuer, the real pinned Caddy and
  oauth2-proxy, hostnames through `/etc/hosts` on the VM and the qualifier's computer;
- one fixture Organization with two modules (one `transition`, one `current`), one
  with a worktree;
- the full checklist of C.3, plus: interrupted apply after step 5 and a re-apply; a
  candidate Launchpad that fails its start (F21 R1) to show the Recovery page through
  the real gateway; a module id present in two Organizations (`module-ambiguous`).

The evidence file goes into Machines' evidence ledger and this repository's
`docs/evidence/`.

### C.6 Where this program would need rollback, and what stands in its place

| Point | Without rollback | Depends on |
|---|---|---|
| A switched Machine's Launchpad does not serve | Recovery mode page, or the gateway's static page when the executable cannot run; repair forward; issue filed | F21 (C.2 1 and 2b) — **required before M2** |
| The apply dies between steps 5 and 6 | Re-apply converges; static page meanwhile | F21 2b, M2 idempotency |
| A module that ran under the resident fails under the Platform | Found by the preflight (C.1 #6) before the point of no return; after it, the module is fixed in its repository | P4, P5, doctor |
| A product update after the switch is bad | F21's pre-switch probe, then Recovery mode | F21 slice 4 |
| The switch release has a gateway defect | The deny reason names it (`host-mismatch`, `cookie-missing`); fixed in a Machines patch release; the static page answers | M2 tests, C.5 |
| The operator loses the Launchpad and T3 needs a new pairing | T3's existing sessions (365-day TTL, `M:workloads/workspace-vm/tool-services.mjs:10-30`) keep working; a new device pairs through `t3 … pairing create` over SSH | T3 baseline (F17); Recovery mode's T3 link |

Nothing in this program restores the resident Launchpad, a previous Platform version or
an earlier Folder.

## D. Workstation (Local Environment), macOS first

What the resident does on a workstation that the Platform must do:

| Need | Resident | Platform design |
|---|---|---|
| Several Organizations on one Machine | Scan-first, all of them (A.2 #14) | B1 unchanged |
| Port collisions across Organizations | Cross-Organization takeover with confirmation and audit (`R:…/runtime-lib.mjs:3156-3195`) | Refuse with the holder named; the page offers "Stop <holder> and start" as two explicit calls; no audit file |
| Session-scoped modules | Children of the server (root decision 0137) | `session` runner, unchanged (F8) |
| CLI reaches the running Launchpad | `server.json` locator plus identity check (`R:lazurio/core/module-lifecycle-client-lib.mjs:227-250`) | A control socket under the install base (0600, next to the existing health socket, `src/update/layout.ts:41`): `lazurio module …` on macOS talks to it; when no Launchpad runs, `start`/`open` launch it detached first |
| Open the Launchpad | `lazurio launchpad serve` prints `LAZURIO_LAUNCHPAD_URL=…` | `lazurio launchpad open [--json]`: starts or reuses, asks the control socket for a fresh loopback URL with a new token, prints it; the token is never stored |
| Desktop launcher | `.app` bundle running `Launchpad.command` from the root checkout | An `.app` written by `lazurio install` that runs `lazurio launchpad open` and hands the URL to the default browser; no root checkout; signed with the release (F13's OS-signing gate) |
| Worktree source | Per-tab choice | B3 `--source`, same as hosted |
| Migration from the root checkout | — | `docs/distribution-and-migration.md` D (rename aside, adopt) |

| Variant for the macOS Launchpad process | Assessment |
|---|---|
| A. On demand: `lazurio launchpad open` starts it detached, it lives until logout or Quit | The resident's behaviour; no service manager work; modules are session children as F8 says |
| B. launchd user agent, always on | Symmetric with Linux, but modules stay session children, so an update restart still stops them; a written plist to keep, detect and remove |

**Recommended: A** first; B when a workstation consumer asks for an always-on
Launchpad (F8's own condition). Hosted differences: no gateway, no entry, the local
fragment token instead of the cookie, no `ensure`, no Chat button (T3 runs where the
operator runs it), Personalspace present.

## E. Slices

Sizes: S = days, M = one to two weeks, L = more, for one agent with review. Rough.
"Repo": P Platform, M Machines, O owner overlay.

| # | Slice | Repo | Depends on | Size | After it the operator (or agent) can |
|---|---|---|---|---|---|
| P1 | F21 slices 2–4: `recover`, Recovery mode, activation without undo, the F.1 unit | P | F21 accepted | L (F21's) | trust that a broken Launchpad shows a repair action instead of a dead page |
| P2 | Unit PATH line (B2, B13) | P | P1 (same unit text) | S | run tools from `~/.local/bin` in the Launchpad on every Linux Machine |
| M1 | Optional `entry` (launchpad, t3code, modules) in the handover schema | M | — | S | nothing yet; unblocks P3 |
| P3 | Re-pin schema; project `entry`; hosted from the handover | P | M1 released | S | open the Platform Launchpad behind a real gateway on a qualification VM |
| P4 | Organizations and modules from the Folder; `organization list`, `module list`; catalog home; F22 point 1 (`current` executable) | P | H1 | M | see every Organization and module in the Platform Launchpad; agents list them |
| P5 | `lazurio module` lifecycle CLI first on Linux, toolchain from the standard path, journal logs, Open with external links, installed Launchpad composes the lifecycle; retire `app-request` | P | P3, P4 | M | open, stop and read logs of modules from the page and from T3 by CLI |
| P6 | Hosted `ensure` (B5) | P | P5 | S | follow a cold direct link to a module |
| P7 | `lazurio chat link` and the Chat button (B8) | P | P3; T3 launcher on PATH (M) | S | enter T3 Code from the Launchpad without pasting a token |
| P8 | `lazurio doctor` read-only; `/settings/diagnostics` (B9) | P | P4, P5 | S | get one readback of the Environment's health |
| P9 | Worktree source `--source main|worktree:<name>` (B3) | P | P5 | S | open a pull request's worktree on the module's hostname |
| M2 | Switch release (C.2): resident removed, gateway snippet and `ensure` Host, entry written, `install --service`, `launchpad.gen3*` removed, F21 static page | M | P1–P8 released; M3 | M | — (qualification only) |
| M3 | Local Linux VM qualification harness (C.5) | M | — | M | qualify any Machines release before a real Machine |
| O1 | One Work Machine switched; then the others | O | M2 | S each | use the Platform Launchpad only |
| — | **Switch line, existing hosted Work Environment: P1–P8, M1–M3, O1 (+ P9 per H3)** | | | | |
| P10 | `organization sync` and `organization add` (B7, F9) | P | P4 | L | synchronize and add Organizations from page and CLI |
| — | **New Work Machines without an agent-led clone: + P10** | | | | |
| P11 | `ssh-keys` and Settings → Access (B10) | P | P3 | S | add a laptop key in the browser |
| P12 | Team: server refuses personal gh; Tools shows the broker identity (B12) | P | — | S | — |
| M4 | Team lane of M2 (shared account, broker unchanged) | M | M2, P12 | S | — |
| — | **Team Environment line: switch line + P10 + P11 + P12 + M4** | | | | |
| P13 | Cookie chunks in hosted admission; Personalspace modules (B11) | P | P5 | M | — |
| M5 | Personal lane of M2 (entry without Organization segment) | M | M2, P13 | S | — |
| — | **Personal Machine line: switch line + P11 + P13 + M5** | | | | |
| P14 | Workstation adoption (`folder-init --adopt`), control socket, `launchpad open`, session logs, port "Stop holder" action | P | P5; distribution slice S5 | M | run the Platform Launchpad over all Organizations on a Mac |
| P15 | macOS `.app` from `lazurio install` | P | P14; OS signing | M | start Lazurio from the Dock |
| — | **macOS workstation line: P1 (unsupervised parts), P4, P5 (session runner), P8, P9, P10, P14, P15, and the migration of `docs/distribution-and-migration.md` D** | | | | |

Strictness notes: P9 is on the switch line only if H3 says hosted worktree previews
are used. P11 is off it because an agent in T3 can edit `authorized_keys`. P10 is off it
for existing Machines because their repositories exist and the manual already tells
agents to fast-forward. P8 is on it because the apply's preflight and readback need a
machine-readable answer.

## F. What we deliberately do not carry over

| Resident capability | Why not |
|---|---|
| Git client in the browser: worktree create from Mission Control plans, "Publikovat draft" (`git add -A`, commit, push), Git read model with background fetch (`R:launchpad/src/worktree-actions-lib.mjs:56-75`, `:428-507`) | Agents in T3 do Git with the worktree discipline of the manual (F14); a browser commit of `git add -A` bypasses it; Git and GitHub are the history owners |
| Mission Control plan browser | Mission Control is an Organization application; the Launchpad opens it like any module |
| Notifications, "most used", recent changes, `usage.json` ranking (`R:launchpad/src/server.mjs:981-1003`) | Click-derived state with no decision behind it; root `ARCHITECTURE.md:269-270` already calls click evidence non-authoritative |
| Cross-Organization port takeover with audit log (`R:…/runtime-lib.mjs:977-1016`, `:3156-3195`) | Replaced by refusal plus an explicit Stop (D) |
| Hosted maintenance loop re-deriving the app set every 15 s (`R:launchpad/src/server.mjs:545-552`) | On-demand `ensure` needs no background loop |
| Source-hash "stale server" restarts (`R:lazurio/core/server-identity-lib.mjs:227-247`) | The product is a versioned executable; only `lazurio update` changes it |
| `launchpad.gen3.json`, `launchpad.gen3.local.json`, planned slots, `personalspace_owner` | F15 point 2 gave them a successor in Folder preferences; no consumer needs planned slots, and the Personalspace owner is the one Personalspace present or the handover's Owner. Proposed: no successor at all (H5) |
| Legacy personal-entry trust profile (`R:launchpad/src/personal-entry-lib.mjs`) | Marked historical by root decision 0157 |
| Laptop network join and peer connections (`R:launchpad/src/laptop-network-lib.mjs`) | F16: the Organization's infra repository and the Dashboard own the graph; a join that files an issue was a bridge (root issue #416) |
| Productionspace cards | Read-only listing without an action; each repository has its own release process (root decision 0041) |
| Organization install role flag | GitHub rights decide; restricted slots need an explicit name (B7) |
| Recovery stash in sync | F9 blocks on dirty checkouts instead (`docs/content-sync.md:63-73`) |
| `lazurio search`, plugins, local Guide application, `GET /api/guide/organization-install` | No consumer found; the manual lives in the Folder and the Guide on the documentation site |
| gbrain note browser in the Personalspace lane | Personal memory tooling belongs to the Buddy and Personalspace, not the Launchpad |
| Module logs of Personalspace in the browser | Kept out, as in the resident |
| Windows Start Menu launcher | Windows comes later (Principal's order) |

## G. Risks and how each is caught before an operator sees it

| Risk | Caught by |
|---|---|
| A real module is not a "declared self-owned Bun package" (`src/cli.ts:320`) and cannot run under the Platform | C.1 #6 preflight on each Machine before the point of no return; C.5 fixture; P5 tests over the real module shapes of the canary Organization (**unverified** which shapes exist) |
| Canonical-only Organizations stay inspection-only | H1 decided before P4; P4 fixture with a `current` root |
| The gateway still rewrites `Host` or strips the cookie | Pinned-Caddy ingress proof in Machines CI; C.5; the deny reason in the body names it |
| `ensure` starts a module on a WebSocket reconnect or a background fetch | P6 unit tests per header set; C.5 item 13 |
| Two Organizations with the same module id on one Machine | `module-ambiguous` 409; C.5 case; Machines template gains `{organization}` when it happens |
| Logs contain secrets and reach a Team member | Same exposure as the resident; stated on the Team page; journal retention is the OS's; no log text in issues without F21's sanitizer |
| Journal output changes the fixed unit policy and older units become `service-unrecognized` | No Platform-owned module units exist on hosted Machines before M2; on qualification VMs, stop once; P5 test for the transition |
| The installed unit's environment differs from the updater's | F21 pre-switch probe runs the start sequence; C.3 item 1 reads the unit; P2 pins PATH |
| The apply dies after the point of no return | Idempotent steps; C.5 interrupted-apply case; F21 static page |
| An old Platform receives a handover with `entry` | M2 pins P3+ as minimum; the closed schema refuses rather than guessing |
| A Team member signs in `gh` personally and breaks the next apply (`M:workloads/workspace-vm/README.md:120-126`) | P12 server refusal before M4 |
| The T3 launcher is not on PATH on some Machine | `lazurio doctor` reports it; Chat button absent rather than broken |
| The macOS control socket is reachable by another user | 0600 in a 0700 directory, owner check before use; P14 test |
| Operators relearn commands | Command names kept from the resident (`lazurio module …`); the Folder manual gets the list at the next template revision |

## H. Questions for the Principal

- **H1 — May canonical-only Organizations run applications?** (F12,
  `docs/organization-contract.md:64-83`.) Recommendation: yes, as F22 point 1. The
  checkout exists because GitHub allowed the clone; the "identity continuity proof"
  has no owner and blocks the switch for every migrated Organization.
- **H2 — One apply with the point of no return after read-only preflights (C.2), and
  the switch only after F21 is released?** Recommendation: yes. It is the only way to
  have no side-by-side period and no rollback.
- **H3 — Are pull-request previews on hosted Work Machines used today** (the handoff
  line "Zkontroluj si to v aplikaci")? Recommendation: yes, keep P9 on the switch line
  (S). If nobody uses them, P9 moves after the switch.
- **H4 — New Work Machines between the switch and P10:** created with the switch
  release and their Organizations cloned by the T3 agent from the manual, or held on
  the previous Machines release until P10? Recommendation: agent-led clone; P10 follows
  immediately.
- **H5 — `launchpad.gen3.local.json`'s planned slots and Personalspace owner have no
  successor** (amends F15 point 2). Recommendation: accept; nothing reads them in the
  Platform.
- **H6 — Team attribution names the Environment:** ask the broker and Machines to add a
  `Lazurio-Environment: <machine>.<org>` trailer beside root decision 0148's
  `Lazurio-Workspace`? Recommendation: yes, it is how GitHub shows which Environment
  made a commit; pull requests and issues get the same line in their body.
- **H7 — Command names:** keep `lazurio module …` and `lazurio organization …` from the
  resident. Recommendation: yes; agents already know them from root `AGENTS.md`.

Proposed decision, for the Principal's acceptance:

> ## F22 — The Platform Launchpad reaches parity by concept and replaces the resident in one apply
>
> **Principal's decision 2026-09-28, direction; not implemented.** "Let us give maximum
> priority to finishing the Platform Launchpad, so that we do not have to deal with
> this parallel run at all." (1) Canonical-only Organizations are executable; F12's
> transition-only admission ends. (2) Organizations and modules are read from the
> Folder's `organizations/`; module operations are CLI first (`lazurio module`,
> `lazurio organization`), run without a Launchpad on Linux, use the operator's Bun
> from `~/.local/bin`, log to the journal, and the Launchpad composes the same core;
> no new Folder state. (3) The handover carries `entry` (Launchpad, T3 Code, module
> origin template), written only by Machines; the gateway keeps the browser `Host` and
> sends the Launchpad's `Host` on `ensure`. (4) A hosted Machine switches in one
> Machines apply that removes the resident unit after read-only preflights, with
> Recovery mode (F21) released first; there is no transition hostname and no way back
> to the resident. (5) The resident's Git client, click ranking, takeover audit,
> maintenance loop and `launchpad.gen3*.json` have no successor.
>
> Amends F12, F15 (point 2 and the 2026-09-28 addendum's home-page sentence), and F8's
> "Not done" list (logs, worktree source).

## I. What this shaping could not determine

- Which root state (`transition` or `current`) each real Organization is in, and
  whether their modules are all "self-owned Bun packages" the Platform can run.
- Whether hosted Work Machines use worktree previews today (H3).
- Whether the T3 launcher `~/.local/bin/t3` (Machines DEV-6624) is merged and present
  on every Machine; the branch was unmerged at `7b2bcaa` per the Machines reading.
- What `~/.local/share/lazurio/operator-kit/` contains and who else reads it.
- Whether `XDG_RUNTIME_DIR` reaches the installed Launchpad's environment from the
  user manager on the fleet's systemd version (the systemd-user runner requires it,
  `docs/module-adoption.md:440-443`); C.5 answers it.
- Which `X-Forwarded-*` headers Caddy sends by default on the workspace-VM ingress;
  the Platform ignores them, so this matters only for modules.
- How the Machine resolves its own bare hostname for the auth check from inside
  (the resident does it today, which suggests it works).
- How many Organizations on one Work Machine share a module id.
- The exact T3 Code pairing interface of the fork in use; the T3 research copy was a
  newer build than the public repository.
