# F15: Platform Launchpad on a hosted work VM (plan)

Status: read-only investigation, 2026-09-28. Nothing was changed, pushed or run
on any Machine.

Sources and exact heads:

- `P:` LazurioPlatform `main` at `8c73cb7` (`drafts/lazurioplatform/.worktrees/main-read`).
  Open Platform PR #60 (Settings layout) was read as a diff against it.
- `M:` Machines `main` at `7b2bcaa`
  (`organizations/HumanAndMachine-ai_GEN3/productionspace/Machines`). Open PRs
  #178 and #220 were read.
- `R:` legacy root repository `HumanAndMachines/Lazurio` at `main`.

## 0. Recommendation in one paragraph

Switch in two moves, not one. **First slice:** run the Platform Launchpad as the
installer-written, supervised `lazurio-launchpad.service` on a **new hostname and
port** of the one work VM. Rename the resident unit to
`lazurio-resident-launchpad.service` and leave it serving `launchpad.<vm>.<org>…`,
unchanged, for module start/open, the gateway `ensure`, the T3 "Chat" entry and
Organization install and sync. **Final switch (the actual F15):** move
`launchpad.<vm>.<org>…` to the Platform once it has `ensure`, hosted module
lifecycle and the T3 entry, then delete the resident unit.

Three things block even the first slice today:

1. The handover has no `entry.launchpad`, so a Platform Launchpad on a VM can only
   run in local mode.
2. The gateway's Launchpad snippet rewrites `Host` to loopback, which the Platform
   refuses as `host-mismatch`.
3. The resident unit already holds the name `lazurio-launchpad.service`.

Each of the three has a small, reviewable fix (sections 4 and 5).

## 1. Today, precisely (work VM, preset `hosted-organization-personal`)

### Resident Launchpad unit

| Aspect | Value | Evidence |
|---|---|---|
| Unit | user unit `~/.config/systemd/user/lazurio-launchpad.service`, written by Machines | `M:workloads/workspace-vm/resident-services.mjs:48` |
| Owner | the operator OS user, with lingering on | `resident-services.mjs:48`; `M:…/ansible/roles/workspace_baseline/tasks/main.yml:97-99` |
| Command | `~/.local/bin/bun <runtime>/launchpad/src/server-launcher.mjs --root ~/Lazurio --host 127.0.0.1 --port <overlay launchpad port>` | `resident-services.mjs:79` |
| Runtime | `~/.local/share/lazurio/resident/active` (a copy of the legacy root repo) | `resident-services.mjs:40,69`; `M:workloads/workspace-vm/README.md:303-304` |
| Working directory | `~/Lazurio` | `resident-services.mjs:39,66` |
| Environment | `HOME`, `PATH` (with `~/.local/bin` first), `LAZURIO_WORKSPACE_PROFILE=hosted`, `LAZURIO_ORGANIZATION_SLUG`, `LAZURIO_TEAM_ID`, `LAZURIO_HOSTED_DOMAIN`, `LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN`, `…_AUTH_CHECK_URL=https://<vm>.<org>.lazurio.io/oauth2/auth`, `…_AUTH_COOKIE_NAME`, `…_STATE_ROOT`, `LAZURIO_T3CODE_URL`, `LAZURIO_T3CODE_PAIRING_COMMAND` | `resident-services.mjs:35-37,67-78` |
| Supervision | `Restart=always`, `RestartSec=5`, start limit 5/10 s, `KillMode=control-group` (Apps are its children), `UMask=0077` | `resident-services.mjs:58-84`; `README.md:861-880` |
| Written by | the `workspace_services` role, with a plain `copy` on every apply; the role asserts the pair `lazurio-launchpad.service` and `lazurio-t3code.service` | `M:…/roles/workspace_services/tasks/main.yml:2-6,51-58` |
| Ports in fixtures | 4100 (work VM), 20000 (personal VM) | `M:test/workspace-vm-ingress.test.ts:48`; `M:test/workspace-personal-vm.test.ts:238` |

### Gateway

- Caddy plus oauth2-proxy on the VM. One origin per application,
  `https://<app>.<vm>.<org>.lazurio.io` (`M:…/workspace-vm/README.md:601-612`).
- Launchpad has its own static snippet, `lazurio_app_loopback_host`. It runs
  admission and then `reverse_proxy` with **`header_up Host {upstream_hostport}`**,
  so Launchpad sees `Host: 127.0.0.1:<port>`
  (`M:workloads/workspace-vm/ingress.ts:305-314,380-389`;
  `M:docs/workspace-application-entry.md:408-409`).
- Admission works like this (`ingress.ts:257-285`):
  1. Strip `X-Auth-Request-*`, `X-Lazurio-*`, `X-Forwarded-User|Email|Groups`,
     `Authorization` and `DPoP` (`ingress.ts:22-28`).
  2. Run `forward_auth` to oauth2-proxy `/oauth2/auth`. A 401/403 becomes a 302 to
     `/oauth2/start` on the bare hostname.
  3. Answer 403 to a write or WebSocket whose `Origin` is not `https://<that host>`.
- Launchpad keeps the session cookie. Other applications get it stripped
  (`README.md:727-732`).
- The cookie is `__Secure-lazurio-workspace`, scoped to `.<vm>.<org>.lazurio.io`
  (`routes.ts:16,242`). Work VMs use a minimal session. Personal VMs use a full one
  with a 2-minute refresh, which oauth2-proxy may split into `_0`–`_3` chunks
  (`M:workloads/workspace-vm/gateway.mjs:40,55-57`; `ingress.ts:35-37`).
- **The gateway calls the Launchpad.** On a module hostname, after admission, it
  sends `GET /api/internal/hosted/modules/<id>/ensure` to the Launchpad port with
  `Host: 127.0.0.1:<port>`, `Origin: https://launchpad.<vm>.<org>…`,
  `Sec-Fetch-Site: same-origin` and only the session cookie. Only a 204 continues
  (`ingress.ts:124-138`; `README.md:696-725`). The target is hard-wired to the
  `launchpad` roster route (`ingress.ts:250-252,320`).
- The bare hostname `/` redirects to `https://launchpad.<vm>.<org>…/`
  (`routes.ts:243`). A roster without `launchpad` is refused (`routes.ts:237`).

### Who the operator is

- Nobody is named. The resident reads no identity header. It revalidates the exact
  cookie against the auth URL (2xx within 2 s) for mutations and the internal
  namespace (`R:launchpad/src/request-trust-lib.mjs:62-117`, `:66-70`).
- Plain GET reads on an Organization VM rely on the gateway alone (subagent reading
  of `R:launchpad/src/server.mjs:1942-2084`).
- The only person identity shown is the `gh` account in Settings
  (`R:launchpad/src/setup-github-lib.mjs:375-391`).

### Platform installation on the same VM (role `workspace_platform`, optional pin)

- The role runs in `post_tasks` after `workspace_identity` and `workspace_services`
  (`M:…/ansible/playbooks/apply.yml:120-131`). Its sequence:
  1. `<staged>/lazurio install --base ~/.local/share/lazurio --json` with **no
     `--service`** (`README.md:449-452`; `roles/workspace_platform/tasks/install.yml:2-7,40-42`).
  2. `machine folder-init` (`README.md:478-487`).
  3. `machine folder-refresh` (`README.md:488-509`).
  4. `machine inspect` and a receipt (`roles/workspace_platform/tasks/main.yml:123-199`).
- It never touches a unit and asserts that the resident units stay active
  (`workspace_platform/tasks/main.yml:1-10,162-179`).
- Layout: base `~/.local/share/lazurio` (versions/, bin/, update/) beside the
  resident's `resident/` and `t3code/`; Folder `~/Lazurio`. The role environment is
  only `HOME` and `PATH`, with no `XDG_RUNTIME_DIR`
  (`roles/workspace_platform/defaults/main.yml:1-16,43-46`).
- Result today: the Platform is installed, the Folder is adopted, **no Platform
  service runs** (`P:docs/decisions.md:532`), and `update status` is unsupervised.

## 2. Target, precisely

### Unit

On an existing installation, `lazurio install` with `--service` writes the unit,
enables it and starts it (`P:src/update/cli.ts:274-301`):

```
~/.local/share/lazurio/bin/lazurio install \
  --base /home/<op>/.local/share/lazurio \
  --service systemd-user --folder /home/<op>/Lazurio --json
```

It writes two files:

- `~/.config/systemd/user/lazurio-launchpad.service`:
  `ExecStart=<base>/bin/lazurio launchpad --base <base> --folder <folder>`,
  `Restart=on-failure`, `RestartSec=2`, start limit 5/60 s,
  `OnFailure=lazurio-rollback.service`, `[X-Lazurio] Folder=` and the marker line
  (`P:src/update/install.ts:79-109`; marker `P:src/update/service-control.ts:19-20`).
- `lazurio-rollback.service` (`install.ts:112-130`).

It then runs `systemctl --user daemon-reload` and `enable --now`
(`install.ts:337-351`). That needs `XDG_RUNTIME_DIR` in the caller's environment
(`service-control.ts:49-63`). The Machines role must add it; `workspace_services`
already does (`workspace_services/tasks/main.yml:67-68`).

`--folder` must be an absolute canonical path (`install.ts:208-209`). The unit takes
**no port, host, `--organization-directory` or `--bun-executable` options**
(`install.ts:91-98`; the options exist only on `lazurio launchpad`,
`P:src/cli.ts:406-420`). Without `--bun-executable` the Launchpad has no module
lifecycle: `/api/apps/*` answers `applications-unavailable`
(`P:src/launchpad/server.ts:249-251`).

### Port and hosted mode

Hosted mode comes only from the Folder: `preferences.machine.entry` (`server.ts:127-132`).

- **With an entry:** the Launchpad listens on `127.0.0.1:<entry.listenPort>`
  (`server.ts:164-166`). It has no fragment token and serves the shell only after
  admission, through a private unix socket (`server.ts:133-151,180-202`).
- **Without one:** it listens on a random loopback port with a token (`server.ts:151,166`).

The entry has exactly four values (`P:src/launchpad/hosted-trust.ts:9-18,45-86`):
`externalOrigin`, `authCheckUrl` (https), `authCookieName`, `listenPort`.

Only one writer may set it: the handover field `entry.launchpad`
(`external_origin`, `auth_check_url`, `auth_cookie_name`, `listen_port`), written by
the Machines apply that also switches the unit (`P:docs/machine-handover.md:280-295`;
`P:docs/hosted-entry.md:104-110`).

- **Missing today, Machines side:** the Machines schema has no `entry`, and the
  vendored copy is closed (`additionalProperties: false`,
  `P:src/machine/lazurio-machine.v1.schema.json:10`; pinned to Machines v0.12.61,
  `P:src/machine/schema-provenance.json`).
- **Missing today, Platform side:** the projection into the binding
  (`P:src/machine/binding.ts:62-111` copies no entry). The binding parser already
  accepts one (`P:src/folder/machine-binding.ts:61-63,240-290`), and the manual
  already renders it (`P:src/folder/manual.ts:1174-1189`).

### Trust model behind the gateway

Implemented in `hosted-trust.ts:140-197` and pinned by
`P:tests/launchpad-hosted-trust.test.ts:39-60,98-115`. A request is admitted only
when all of these hold:

1. `Host` equals the external origin's host (`hosted-trust.ts:181-182`).
2. A non-GET/HEAD request has `Sec-Fetch-Site: same-origin` and
   `Origin == externalOrigin` (`:183-189`).
3. There is **exactly one** cookie with the configured name, in a Cookie header of
   at most 16 KiB. Chunks are not accepted (`:101-121`).
4. That cookie alone, sent to `authCheckUrl`, returns 2xx within 3 s, without
   following a redirect. A positive answer is cached for 2 minutes
   (`:146-176`; `P:docs/hosted-entry.md:112-122`).

Forwarded identity headers are ignored (`hosted-entry.md:23-29,144`). A denial is
`401 {"error":"denied","reason":…}` (`server.ts:183-185`), and the page reloads on a
401 (`P:src/launchpad/ui.ts:142-149`).

What the gateway must therefore **preserve**:

- the browser `Host`, meaning **no** `header_up Host {upstream_hostport}`;
- `Origin` and `Sec-Fetch-Site`;
- the session cookie.

What it must **strip** is the same identity set it strips today (`ingress.ts:22-28`).
The existing `lazurio_app` snippet cannot be reused, because it strips the cookie
(`ingress.ts:294-303`).

**The capability fragment behind a gateway:** there is none. With an entry, the
token is empty and the URL is the external origin (`server.ts:151,509-512`). The
fragment token exists only in local mode, where the page reads it from
`location.hash` (`ui.ts:11-12,142-146`).

### Updates in supervised mode

A unit that carries the marker makes the installation supervised
(`service-control.ts:215-241`). The pill starts
`systemd-run --user --unit lazurio-update … update --version <v>`
(`P:src/update/launchpad-activation.ts:37-80`). The updater then:

1. self-checks the new binary against the Folder;
2. writes `pending.json`;
3. swaps the selector;
4. restarts the unit;
5. waits up to 30 s for `/health` on the unix socket to report the new version;
6. commits, or else undoes.

(`P:docs/update.md:230-256`; the health socket is at `server.ts:43-57`, and the
self-commit after 15 s at `server.ts:488-502`.)

A crash loop hits the start limit, and `OnFailure` runs
`previous/lazurio update rollback --auto` (`install.ts:79-88,112-130`). A later
Machines `install --base … --service …` with a higher pin is the offline update
through the same path, and it restarts the supervised unit (`install.ts:278-328`).

## 3. Feature gap: resident vs Platform Launchpad at `8c73cb7`

| # | What the operator uses on the VM today | Resident evidence | Platform | Platform evidence | Blocks first VM? | Smallest cover |
|---|---|---|---|---|---|---|
| 1 | Open a module App (install, start, wait healthy, open its hostname) | `R:launchpad/src/runtime-lib.mjs:1185-1240`; `R:…/hosted-app-url-lib.mjs:544-556` | **missing** on hosted | the unit passes no `--bun-executable` (`install.ts:91-98`); the app form is a developer form keyed by company/module/package (`ui.ts:393-424`); the link is shown only when local and only as a loopback URL (`ui.ts:413-417`; `P:src/launchpad/application-view.ts:58-70`); execution only for `transition` roots and self-owned Bun packages (`P:src/organizations/read-applications.ts:11-17`; `cli.ts:317-320`) | yes, if the resident goes | keep the resident at `launchpad.` |
| 2 | A cold direct link to `<module>.<vm>.<org>` starts the module (`ensure`) | `R:launchpad/src/server.mjs:1369-1404`; `R:…/hosted-readiness-lib.mjs:1-8` | **missing** | no `/api/internal/hosted/*` route; GET `/api/*` other than update status is 405 (`server.ts:217-227`); gateway `Host: 127.0.0.1` fails `host-mismatch` | yes, if the Platform takes the `launchpad` route | keep `ensure` on the resident; the gateway targets the `launchpad` route (`ingress.ts:320`) |
| 3 | Stop or restart an App | `R:…/runtime-lib.mjs:1375-1390` | missing on hosted (as row 1) | as row 1 | yes, if the resident goes | resident |
| 4 | T3 Code "Chat" button (one-time pairing into T3) | `R:launchpad/src/t3-chat-lib.mjs:10-90`; `R:launchpad/public/app.js:2257-2281` | **missing**; only prompt text mentions T3 | `P:src/launchpad/messages.ts:329,341` | yes, if the resident goes | resident; operators may also open `t3code.<vm>…` directly |
| 5 | GitHub sign-in with SSH key link, sign-out removes the key | `R:…/setup-github-lib.mjs:499-564,701,748` | **present**, and stronger (host keys, proof) | `P:docs/decisions.md:1391-1508`; `server.ts:311-423` | no | Platform |
| 6 | Organization install (`organization install --role builder`) | `R:…/setup-github-lib.mjs:775-804` | **missing** | F9 content sync "not implemented" (`P:docs/decisions.md:436-445`) | yes, if the resident goes | resident, or CLI in T3 |
| 7 | Synchronize / update of the root checkout and Organizations | `R:launchpad/src/server.mjs:1466-1483`; `R:lazurio/runtime/lazurio-update-lib.mjs:189-198` | **missing** (by design, F9) | `P:docs/decisions.md:436-445,729-731` | no for the first slice; yes for the final switch | resident; later F9 |
| 8 | Settings: General (environment), GitHub, SSH authorized keys | `R:launchpad/public/settings.js:8-14,74-95`; `R:launchpad/src/server.mjs:256-265,1556-1575` | **partly**: "This Machine" binding, profile and preset, Tools; **no** SSH authorized-keys page | `server.ts:274-291`; `ui.ts:83-85,135-140`; PR #60 adds `/settings/<section>` routes (`src/launchpad/routes.ts` on that branch) | no | resident keeps SSH keys |
| 9 | Personalspace lane (personal VM only) | `R:launchpad/src/server.mjs:1248-1367,1869-1876` | **missing** | no Personalspace routes in `server.ts` | only for personal VMs | resident on personal VMs |
| 10 | Enabled tools, notes, curated install of `gh`/`composio`/`wacli` | none | **present** | `P:docs/decisions.md:1050-1390`; `server.ts:296-457` | no | this is the reason to switch |
| 11 | Product update pill for the Launchpad itself | none (no self-update, subagent reading of `R:…/server.mjs:133-136`) | **present**, supervised | `P:docs/update.md:301-315` | no | Platform |
| 12 | Profile and preset change, Folder refresh notice | none | **present** | `server.ts:274-291,458-479`; `P:docs/decisions.md:1019-1033` | no | Platform |
| 13 | "Launchpad must always run" (Principal 2026-09-27) | `Restart=always`, the unit never fails (`README.md:861-873`) | **different**: `Restart=on-failure` plus a start limit that ends in `failed` and a rollback (`install.ts:84-100`) | | no, but it is a policy conflict | see open question Q3 |

Conclusion: an operator who loses rows 1–4 or 6 cannot work. The Platform at
`8c73cb7` cannot replace the resident; it can only **stand beside it**.

## 4. The unit name collision

**What happens today.** On a VM, `install --service systemd-user --folder ~/Lazurio`:

1. stages the executable and swaps the selector first, under the update lock
   (`install.ts:239-334`);
2. only then calls `writeUnit`. That finds `~/.config/systemd/user/lazurio-launchpad.service`
   without the marker and throws `storage-unavailable {stage: "unit", reason:
   "foreign-unit"}` (`install.ts:173-184,337-346`).

The product version has changed, no unit is written, and the resident keeps
running. Every update detects no supervisor, because a foreign unit makes the
installation unsupervised (`service-control.ts:15-18,226`; `P:docs/update.md:196-201`).

The collision also runs in the other direction. Even if the Platform wrote its unit,
the next Machines apply would overwrite it with the resident unit, because
`workspace_services` copies unconditionally (`workspace_services/tasks/main.yml:51-58`).

| Option | Assessment |
|---|---|
| A. Machines removes the resident unit first, and the Platform takes the name and the `launchpad.` hostname | This is the F15 end state (`P:docs/decisions.md:788-794`). As a first step it loses rows 1–4 and 6 of the gap table. Rejected for now. |
| B. The Platform uses another unit name, written by Machines | The Platform recognises supervision only by the name `lazurio-launchpad.service` and the marker (`service-control.ts:13-20,223-226`). Such a unit would be unsupervised: the update switch is the commit, a restart is needed, and there is no rollback unit. It would be a second author of the Platform's unit. Rejected. |
| C. A transition: Machines renames the resident unit to `lazurio-resident-launchpad.service` (same port, same `launchpad.` hostname), and the Platform installer writes `lazurio-launchpad.service` on a new port and hostname | **Recommended.** The Platform needs no unit-name change. The installer-written unit is supervised from day one, which is the F15 evidence line "`update status` → `supervised: true`" (`P:docs/hosted-entry.md:151-159`). Only Machines-owned migration code changes (the resident layer is slated for deletion, `M:ARCHITECTURE.md:199-212`). The final switch is then "delete the resident unit and move the `launchpad` route". |

The code supports C:

- The Platform accepts an existing supervised unit as convergent: the same text
  makes `writeUnit` return early (`install.ts:175-176`).
- The resident can be renamed because nothing in the Platform reads its unit.
- Machine-specific settings go into a drop-in, which is what the marker text asks
  for (`service-control.ts:19-20`) and what Machines PR #220 does for T3.

## 5. Change list by repository, smallest first

Every step is its own PR and release.

### P0 — Platform: hosted runtime fixes (no Machines dependency)

| Change | Files | Risk | Verified before a VM |
|---|---|---|---|
| Put `~/.local/bin` on the unit PATH (`Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`). Today the unit inherits the user manager's PATH. The Tools section probes and runs tools from `process.env.PATH` (`server.ts:103-109`), while F17/F19 put tools in `~/.local/bin` (`P:docs/decisions.md:961-981,1294-1300`). Alternative: a Machines drop-in; see Q4. | `src/update/install.ts:79-109`, tests | low; the unit text changes, so a re-install rewrites it (convergent) | unit test of the rendered unit; disposable local Linux VM: `systemctl --user show lazurio-launchpad -p Environment` and the Tools status showing `gh` |
| Refuse or hide the `gh` curated install and login on `hosted-organization-team`. That Machine's `gh` is the broker wrapper, and a personal `~/.config/gh/hosts.yml` makes the next Machines apply fail (`M:…/workspace-vm/README.md:120-126`). Needed before any Team VM switches, not before the first work VM. | `src/tools/login.ts`, `src/tools/install.ts`, `src/launchpad/tools-panel.ts`, tests | low | unit tests per preset |
| Accept oauth2-proxy cookie chunks `<name>_0…_3`, reassembled and forwarded as the chunks. Needed only for personal VMs (`gateway.mjs:55-57`). | `src/launchpad/hosted-trust.ts:101-121,157-162`, tests | medium (security surface) | unit tests; a native run behind a stand-in with a split cookie |

### M1 — Machines: handover schema gains the optional `entry.launchpad`

- Change: add `entry.launchpad {external_origin, auth_check_url, auth_cookie_name,
  listen_port}` on both branches (work VM and personal VM) of
  `workloads/workspace-vm/lazurio-machine.v1.schema.json`. **No Machine writes it
  yet.** Document it in `docs/machine-identity.md`, add schema tests, bump the
  version.
- Risk: very low. The field is optional and unused.
- Why it comes first: the Platform must re-pin a released schema byte-for-byte
  (`P:docs/machine-handover.md:293-295`).
- Why nothing may write it yet: an **older** Platform refuses a handover with an
  unknown field (closed schema), so no VM may receive `entry` before it runs P1.
- Verify: `bun test` on the schema tests; a v0.12.61 handover still validates.

### P1 — Platform: project the entry and re-pin

- Change:
  - vendor the M1 schema (`src/machine/lazurio-machine.v1.schema.json` and
    `schema-provenance.json`);
  - map `entry.launchpad` to `HostedEntry` in `machineBinding`
    (`src/machine/binding.ts:62-111`), using `parseHostedEntry` (`hosted-trust.ts:45-86`);
  - absent stays absent, as with `assignment` and `relationships`;
  - `folder-refresh` re-records it (declaration, not identity; `P:docs/machine-handover.md:286-289`);
  - update the `hosted-entry.md` status line.
- Tests: a handover with an entry gives `binding.entry`; a refresh adds, changes
  and removes it; a Launchpad started from such a Folder is hosted
  (`tests/launchpad-hosted.test.ts` pattern); an old handover is byte-identical.
- Release: next patch (`v0.1.8`+). Take PR #60 first if the Settings routes should
  ship; its server change serves the page under each `/settings/*` route through
  the hosted shell socket too.
- Risk: low to medium. The binding shape changes, and existing Folders without the
  field are unaffected.
- Verify:
  - on a disposable local Linux VM, `folder-init` from a handover with an entry,
    then run the existing evidence recipe (`P:docs/evidence/hosted-entry-linux-arm64-2026-09-26.md`)
    with the entry coming from the handover instead of a hand-written preference;
  - `install --service systemd-user --folder` on that VM, then `update status
    --json` shows `supervised: true`, and one pill update commits.

### M2 — Machines: "Platform Launchpad beside the resident"

The whole step is gated on the overlay declaring the new roster application and a
P1+ Platform pin.

| Sub-change | Files | Notes |
|---|---|---|
| Rename the resident unit to `lazurio-resident-launchpad.service`; content, port and `launchpad.` hostname unchanged | `resident-services.mjs:48`; `workspace_services/tasks/main.yml:5` (assert); `resident-observe.py:16,183`; `resident-expectations.py`; `personal-vm/personal-observe.py:24`; `personal-vm/contract.ts:42`; `resident-activation.py`; `resident-bootstrap.py`; tests listed by `grep -l lazurio-launchpad.service test/` (14 files) | Legacy creation renderers keep the old name for historical digests (`owner.mjs:101-104`). Do not touch them. |
| Retire the old file safely: stop, disable and remove `~/.config/systemd/user/lazurio-launchpad.service` **only when it lacks the Platform marker line**, then run `daemon-reload` | `workspace_services/tasks/main.yml` | Never remove an installer-written unit. The resident restart stops its child Apps (`README.md:852-859,875-876`); T3 keeps running. |
| New roster slug for the Platform Launchpad (name: Q1), served by a new static snippet: admission, `INTERNAL_DENY`, `reverse_proxy http://127.0.0.1:<port>` **without** a Host rewrite and **without** cookie stripping | `routes.ts` (reserve the slug; `staticRosterRoute`), `ingress.ts:48-52,294-314,380-389`, `test/workspace-vm-ingress.test.ts`; run `bun run proof:workspace-ingress` with pinned Caddy (`README.md:733-735`) | `ensure` still targets the `launchpad` route, which is the resident. |
| Write `entry.launchpad` into the handover, from the same route rendering as the gateway: `https://<slug>.<vm>.<org>.lazurio.io`, `https://<vm>.<org>.lazurio.io/oauth2/auth`, `__Secure-lazurio-workspace`, the overlay port | `workspace_identity` role, handover renderer, `docs/machine-identity.md` | Written only when the slug is declared and the Platform pin is P1 or later. |
| `workspace_platform` order: `install --base` (as today), `folder-init`, `folder-refresh` (records the entry), then **`<selector> install --base <base> --service systemd-user --folder ~/Lazurio --json` with `XDG_RUNTIME_DIR`** | `roles/workspace_platform/tasks/*.yml`, `defaults/main.yml:43-46` | The service goes last because a Launchpad started before the Folder exists fails `inspectOwnedDirectory` (`server.ts:122`) and crash-loops into the rollback unit. The call is convergent on re-apply (`install.ts:175-176`). A `foreign-unit` answer fails the apply with a clear message. |
| Readback: `update status --json` shows `supervised: true`; a listener on `127.0.0.1:<port>`; `systemctl --user is-active lazurio-launchpad`; the receipt gains `launchpad: supervised`; the resident units (renamed) stay active | `workspace_platform/tasks/main.yml:162-199`, `resident-observe.py` (`observe_platform`), `test/workspace-platform-role.test.ts`, `test/workspace-platform-observe.test.ts` | A failed Platform Launchpad is a **finding**, not an apply failure, while the resident serves. Q5. |
| Keep writing `launchpad.gen3*.json` while the resident runs | `workspace_resident/tasks/discovery.yml` | A conscious deviation from F15 point 2, which ties it to "the release that switches the unit". Record it in the PR. |
| Organization lane only in this release; the personal lane keeps today's shape | `workspace_guest_kind` guard | The personal VM needs P0 cookie chunks and Personalspace (gap row 9). |
| Docs and version | `README.md` "LazurioPlatform beside the resident", `ARCHITECTURE.md` handover section, `FLEET.md`, `package.json` version | |

Risk: medium.

- The rename touches readback and 14 test files.
- Coordinate with open PR #220, which is `CONFLICTING` and edits
  `resident-services.mjs` and `workspace_services`. It also changes the T3 unit name
  that the same assert checks. **Land #220 first or rebase M2 on it.**

Verify before a VM:

- `bun test`, including the ingress proof with real Caddy;
- the Ansible role tests;
- a disposable local Linux VM with the workspace playbook in check-mode and a real
  apply:
  - both Launchpads answer;
  - the new hostname returns the Platform shell after sign-in;
  - `launchpad.` is the resident;
  - a module cold link still starts through the resident's `ensure`.

### O1 — owner deployment repository (one work VM)

Overlay changes:

- pin the P1+ Platform (`resident_bootstrap.artifacts.platform` and `platform_attestation`,
  `M:…/workspace-vm/README.md:408-417`) and put the binary in the runner custody
  cache;
- bump the Machines release;
- add `{slug: <Q1>, port: <free port>}` to `provision.gateway.applications`.

Then Plan, Permit and apply. Risk: low for the overlay itself.

### What the operator sees after O1

- `https://<slug>.<vm>.<org>.lazurio.io` opens the Platform Launchpad without a new
  sign-in (same cookie domain). It shows "This Machine", profile, **Settings →
  Tools** (gh sign-in with SSH key, composio, wacli) and the update pill.
- `https://launchpad.<vm>.<org>…` is still the resident, for Apps, Chat and
  Organization install.
- The resident restarted once during the apply, so running Apps stop until their
  next Open. T3 is untouched.

### Later: P2, M3, O2 — the actual F15 switch

- **P2 (Platform):**
  - hosted `ensure`, answering the gateway's request. This needs a trusted-loopback
    variant or the gateway sending the real `Host`, which is a joint decision (Q2);
  - hosted module lifecycle with external-origin links (`P:docs/hosted-entry.md:71-73`)
    and multi-Organization discovery;
  - a T3 entry. The resident pairs through a command in its unit
    (`resident-services.mjs:77-78`); with PR #220 it becomes `~/.local/bin/t3`;
  - Organization install and sync (F9);
  - Personalspace for `hosted-personal`.
- **M3 (Machines):**
  - the `launchpad` route becomes the Platform snippet on the Platform port;
  - the entry origin changes to `launchpad.<vm>.<org>…` (refresh re-records it);
  - retire the second slug or make it redirect;
  - delete `lazurio-resident-launchpad.service` and stop writing `launchpad.gen3*.json`;
  - the qualification gate of `M:ARCHITECTURE.md:204-214,1285-1296`.
- **O2 (owner repo):** overlay for the switch.

## 6. Differences per kind of Environment

| | Work, one operator (`hosted-organization-personal`) | Work Team (`hosted-organization-team`) | Personal VM (`hosted-personal`) |
|---|---|---|---|
| Unit | Installer unit as the operator; drop-in only for Machine specifics | Same unit under the one shared OS account | Same unit under the owner's account |
| Hostname | `<slug>.<vm>.<org>.lazurio.io`, later `launchpad.` | Same | `launchpad.<login>.lazurio.io` (`P:docs/decisions.md:788-791`) |
| Cookie | minimal, one cookie (`gateway.mjs:40`) | Same | full session, may be chunked `_0–_3`; **the Platform refuses chunks today** (`hosted-trust.ts:101-121`); P0 change or a minimal session |
| Auth URL | `https://<vm>.<org>.lazurio.io/oauth2/auth` | Same | bare personal host `/oauth2/auth` |
| GitHub identity | the operator's own `gh` via Tools (F19) | **the broker bot only**. The Platform must not offer a personal gh sign-in (P0); a personal `hosts.yml` breaks the next apply (`M:…/README.md:120-126`) | the owner's own sign-in |
| Tool sign-ins | the operator's | shared by all Team members; the Platform warns `shared-environment-sign-ins` (`P:docs/decisions.md:1177-1181`) | the owner's |
| Admission | Team or operator grant at oauth2-proxy | The Team; admission names nobody, and attribution comes from the broker (`P:docs/hosted-entry.md:81-84`) | owner-only; PR #178 qualifies a *different* personal entry (access-token introspection), which does not match the cookie revalidation model (Q6) |
| Transition order | first (this plan) | after P0 gh refusal | after P0 chunks and Personalspace (P2) |

## 7. Failure modes and the forward repair

| Failure | What the operator sees | Forward repair |
|---|---|---|
| Platform unit does not start (Folder absent or foreign entry, `inspectOwnedDirectory` throws, a bad binary) | New hostname: gateway 502. The resident at `launchpad.` works. | `journalctl --user -u lazurio-launchpad`. A crash loop reaches `failed` and runs `lazurio-rollback.service`, which does nothing without a marker (`P:docs/update.md:257-283`). A T3 agent fixes the Folder per `manual/troubleshooting.md`; then `systemctl --user reset-failed` and `restart`, or the next apply (`enable --now` is convergent). |
| Launchpad starts in **local** mode because the entry was not recorded (for example `folder-refresh` blocked on `drift`) | 502 on the new hostname; the unit is active; `update status` shows supervised | The apply records `handover: drift` (`M:…/README.md:496-501`). The agent restores the edited generated file; the next apply refreshes and the unit restarts. Precheck before the first apply: see section 8. |
| Wrong gateway route | Raw `401 {"reason":"host-mismatch"}`: Host rewritten. `cookie-missing`: cookie stripped. `origin-mismatch`. 421: route missing. | Fix the snippet in a Machines patch release. The reason in the body names the defect. Nothing on the VM needs repair. |
| Operator locked out of the Platform Launchpad while T3 works | 401 loop, or the auth endpoint unreachable (`auth-denied`/`auth-unavailable`) | Everything has a CLI: `lazurio tools list --sign-in`, `tools login gh`, `profile-update`, `update status`, all run from T3. The resident Launchpad stays at `launchpad.`. Check `curl` of the auth URL from the VM (Q7). |
| Supervised update fails | The pill shows the failure (`activation-failed`) and the previous version runs again after the automatic undo (`P:docs/update.md:242-256`) | Retry once. Otherwise wait for the next release (forward). A Machines pin raise also works (the pin is a minimum). `lazurio update rollback` only for a bad committed version, and not below a release that wrote `tools` or `toolNotes` (`P:docs/decisions.md:1124-1143`). `state-invalid` needs a person, with the path it names. |
| Folder with drift | Profile and Tools changes answer `drift` with the path; a refresh does not happen | The agent reverts the named generated file, or moves the hand-written content out. There is no overwrite path by design (`P:docs/decisions.md:684-690`). |
| Two sign-in UIs for gh (resident Settings → GitHub and Platform Tools) | Confusion only; same account | Tell the operator to use Platform Tools. The resident page goes away in M3. |

## 8. What I could not determine, and the single check that answers it

| # | Unknown | One check on the real VM (as the operator) |
|---|---|---|
| U1 | The user manager's PATH for units (whether `~/.local/bin` is present), which decides the P0 PATH change | `systemctl --user show-environment \| grep ^PATH` |
| U2 | Whether the Platform process reaches and trusts `https://<vm>.<org>.lazurio.io/oauth2/auth` from inside the VM (the resident does, which suggests yes) | `curl -s -o /dev/null -w '%{http_code}' https://<vm>.<org>.lazurio.io/oauth2/auth` gives 401 |
| U3 | The current Platform version, template revision and whether the Folder is drift-free (an entry arriving with drift is not recorded) | `~/.local/share/lazurio/bin/lazurio update status --json` plus the last `platform-selection.json` `handover` value |
| U4 | A free loopback port for the new roster application on that VM | `ss -ltn` |
| U5 | Whether the work VM session cookie is ever chunked (minimal session says no) | browser devtools on `launchpad.<vm>…`: one `__Secure-lazurio-workspace` cookie |
| U6 | Whether the VM has outbound HTTPS to GitHub and Sigstore for the pill's check | `lazurio update --check --json` |
| U7 | Whether renaming the resident unit changes any creation-binding digest of an existing guest | Not a VM check: run the full adapter test suite after the rename. A local run of `test/workspace-*-adapter*.test.mjs` answers it. |

## 9. Recommended first slice (fastest, acceptable risk)

1. **P1** (with the P0 PATH line): Platform release that projects
   `entry.launchpad` from the handover. Qualify it on a disposable local Linux VM
   with the stand-in gateway recipe, the handover path and the installer unit.
2. **M1 and M2** in one Machines release. The schema change can land first as its
   own PR in the same release train, because the Platform needs the schema tag to
   re-pin: M1 tag, then P1, then M2. M2 contains:
   - the resident renamed;
   - the new Platform snippet and slug;
   - the handover entry;
   - `install --service` last in `workspace_platform`;
   - readback as a finding;
   - the Organization lane only.
   Coordinate with PR #220.
3. **O1**: overlay of the one work VM. Before the apply, run checks U1–U5. After
   the apply:
   - open the new hostname and use Settings → Tools (gh sign-in with SSH link);
   - `update status` shows `supervised: true`;
   - do one pill update to the next patch;
   - confirm that `launchpad.` Apps, a cold module link and Chat still work.

That gives the operator the Platform Launchpad with Tools on one VM, with an
installer-written supervised unit, and nothing they use today removed. The F15
switch proper (M3) follows P2.

## 10. Open questions for the Principal

- **Q1.** Slug of the transition hostname: `platform`, `lazurio` or another name.
  Roster wins over a module lease of the same slug (`M:…/README.md:633-642`).
- **Q2.** For the final switch: should the Platform `ensure` accept the gateway's
  loopback `Host`, or should the gateway send the external `Host` for `ensure`?
  This is a joint Platform/Machines contract, and `P:docs/hosted-entry.md:61-63`
  forbids deriving the origin from `Host`.
- **Q3.** Launchpad supervision policy. The Machines decision says "must always
  run": `Restart=always`, never failed (`M:…/README.md:861-873`). The Platform
  relies on the start limit ending in `failed` to trigger the rollback
  (`install.ts:84-88`; `server.ts:488-493`). Which wins for the Platform unit? My
  recommendation: keep the Platform's semantics, and do not override
  `Restart`/`StartLimit*` in a Machines drop-in.
- **Q4.** PATH ownership for the unit: the Platform unit (recommended, since F17
  standard path) or a Machines drop-in.
- **Q5.** In M2, is a failing Platform Launchpad a finding or an apply failure,
  while the resident still serves?
- **Q6.** Personal VM entry: PR #178's access-token introspection model versus the
  Platform's cookie revalidation. Which one is the personal Launchpad's contract?
- **Q7.** Is the temporary deviation from F15 point 2 (Machines keeps writing
  `launchpad.gen3*.json` while the resident runs) accepted?
