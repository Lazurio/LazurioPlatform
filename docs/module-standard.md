# Lazurio Module Standard

This page is the full text of the Lazurio Module Standard, decision
[0171](decision-register.md#0171--lazurio-module-standard). It defines what a
Module is, what its repository holds, what its manifests declare and how Lazurio
prepares, starts, builds and stops its Apps. Lazurio makes no exception for a
Module that deviates: the deviation is fixed in the Module.

This repository is the standard's authority. The Lazurio Root (GEN3) converges on
it, as on every mechanism of the Folder (decision
[0219](decision-register.md#0219--the-lazurio-root-and-the-lazurio-folder-converge-on-the-folders-mechanisms-gen3-and-gen4-are-orientation-terms)).

**How a requirement is enforced.** No command of the Platform checks a Module
against the whole standard yet (#423); `lazurio module readiness` checks
statically what decides whether a Module is ready as an Application (`MS-19`).
The Platform enforces a requirement where
its readers or its start path refuse a declaration; the requirements list below
names the source file for each. A requirement marked **rule only** has no check
in this repository: the Module's author and its review hold it. An agent that
converts or checks a Module goes through every requirement and names in the pull
request what it could not verify.

## Terms

- **Module**: one Git repository with `lazurio.module.json` at its root.
- **App**: a runnable package of a Module, declared in `apps[]` of
  `lazurio.module.json`. Exactly one App of a Module with Apps is its
  `default_app`.
- **App generation**: the directory `app/v<N>/` that holds an App's package.
- **Lease**: a loopback TCP port the Module owns, declared in
  `lazurio.module.json`.
- **Listener**: a port an App listens on, declared in `lazurio.runtime.listeners[]`
  and bound to one lease.
- **Preparation**: everything that has to happen before a start (installing
  dependencies, generating data, migrations). It is not the start.
- **Built version**: what Lazurio runs from `main`: a static build the Platform
  serves, or the App's own production process.
- **Sibling**: another Module of the same Organization that an App declares as a
  required slot.
- **Application**: what people open at `https://<module>.<org>.lazurio.app` with
  their Lazurio account, without the source code: the released App of a Module on
  the Organization's application host (decision 0249). Texts for people say only
  Module and Application.
- **Development version**: the App a Module runs from `main` in an Environment,
  for the people who build it and their agents.
- **Generation**: where a Module's data are, V0 to V4 ([App generations](#app-generations)).

## Where a Module lives

| Kind | Path in the Folder | Repository |
| --- | --- | --- |
| Organization Module | `organizations/<Organization>/workspace/<module>/` | `<GitHub Organization>/<module>` |
| Organization-level application | `organizations/<Organization>/mission-control/`, `…/design-system/` | a repository of the Organization; a Module only when it carries `lazurio.module.json` ([F24](decisions.md#f24--an-organizations-root-level-applications-are-modules-of-the-catalog)) |
| Personal Module | `personalspace/<login>_GEN3/workspace/<module>/` | `<login>/<module>` on the person's own GitHub account, private, without an Organization or Teams ([F52](decisions.md#f52--one-module-generator-in-the-platform-a-persons-own-modules-in-their-personalspace)) |
| Guest Module | `organizations/<host>/workspace/<HomeOrganization>_GEN3/<repository>/` | the home Organization's; the host keeps it current and never runs it (decision [0221](decision-register.md#0221--guest-modules-an-organization-may-host-another-organizations-module-in-its-workspace), [F67](decisions.md#f67--guest-modules-another-organizations-module-in-the-hosts-workspace-kept-current-never-run)) |

An Organization's Modules sit side by side in one flat `workspace/` (decision
[0041](decision-register.md#0041--flat-workspace-teams-as-declarations-and-productionspace)).
Each one is a slot in the Organization's `modules.manifest.json`; a Team is a
declaration on the slot, not a directory, and a Team reaches a Module through its
live GitHub grant. The catalog (`lazurio organization list`, `lazurio module list`)
reads every Module through its slot. A slot whose repository is not created yet
carries `status: "planned_slot"`. The old `modules/` layout is retired. Who may
start a Module follows the Organization's manifest and live GitHub grants, never a
check inside the App against the Team an Environment runs under (decision
[0176](decision-register.md#0176--modules-sit-side-by-side-in-workspace-an-app-reads-a-declared-sibling-only-as-slug)).

## Repository layout

| Path | Holds | Required |
| --- | --- | --- |
| `lazurio.module.json` | identity, leases, Apps | always |
| `app/v<N>/package.json` | one App: scripts, `packageManager`, `lazurio.runtime`, `lazurio.preparation` | each App |
| `app/v<N>/bun.lock` | the App's lockfile, committed | each App that declares dependencies |
| `app/v<N>/tsconfig.json` | `strict: true`, or `extends` a framework's strict preset | each TypeScript App |
| `biome.json` | lint and format, in the App or at the Module root | each App |
| `README.md`, `AGENTS.md` | what the Module does and how to develop it; the rules for agents | always |
| `.github/workflows/` | the Module's CI | always |
| `db/` | the Module's repository-db data, a checkout of its own, ignored by the Module's Git | a Module with data |

An App never lives at the Module root. A Module without an App has
`tcp_port_policy: {"mode": "none"}`, no leases and `apps: []`.

Never in a Module: a `.env*` file on the start path; `node_modules` in Git; a
symlink created at start; an absolute path of a particular computer.

## The Module manifest: `lazurio.module.json`

```json
{
  "schema_version": "lazurio.module.v1",
  "id": "notes",
  "company": "example",
  "tcp_port_policy": { "mode": "single" },
  "port_leases": [{ "id": "main", "host": "127.0.0.1", "port": 24017 }],
  "apps": ["app/v1/package.json"],
  "default_app": "app/v1/package.json"
}
```

| Field | Rule |
| --- | --- |
| `schema_version` | `lazurio.module.v1` |
| `id` | the slot's slug, `^[a-z0-9][a-z0-9-]*$` |
| `company` | the Organization's slug; for a personal Module the person's GitHub login |
| `tcp_port_policy.mode` | `none` (no lease, `apps: []`), `single` (exactly one lease, with id `main`) or `exception` (at least two leases and a `reason` of at least 20 characters) |
| `port_leases[]` | `id` (`^[a-z][a-z0-9-]*$`), `host` (`127.0.0.1`, `localhost` or `::1`; a new Module gets `127.0.0.1`), `port` (1024–65535); ids and ports unique |
| `apps[]` | the App packages, each a relative path ending in `package.json`, unique; a missing `apps` is a legacy Module that does not start (`explicit-apps-required`) |
| `default_app` | one of `apps[]`; absent when `apps` is empty |

`parseModuleManifest` (`src/modules/manifest.ts`) refuses anything else, an
unknown field included. The catalog accepts a Module only when its `company` is
the Organization's slug and its `id` is the slot's
(`observeModuleDirectory`, `src/organizations/read-applications.ts`).

**Ports.** Every lease lies in its owner's `module_port_pool`: the Organization's
pool of 100 ports, or for a personal Module the Personalspace's pool, the reserved
range 23000–23099 (decision 0171, addendum of 2026-10-13). The pools of different
Organizations do not overlap, none overlaps the reserved range, and no central
port registry exists. The port lives only in the lease: the App reads it from its
listener variables and never writes it into its sources. A lease is never renumbered in ordinary work. When a
Module is converted to the standard and a lease lies outside the pool, the agent
moves it to a free port of the pool in the Module's pull request, gives the old →
new mapping there and shows the App starting on the new port after the merge.

## The App package

```json
{
  "name": "notes-app-v1",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.4.4",
  "scripts": {
    "dev": "bun --no-env-file run src/server.ts",
    "check": "bun run typecheck && bun run lint && bun run test",
    "check:prepared": "bun run src/prepared.ts",
    "test": "bun test"
  },
  "lazurio": {
    "runtime": { "...": "below" },
    "preparation": { "...": "below" }
  }
}
```

The App's `package.json` carries the scripts `dev`, `check` (type check, Biome
and the tests) and `test`, the run declaration `lazurio.runtime` and the
preparation `lazurio.preparation`. The Platform reads an App only through `lazurio.runtime`;
an App that still declares the legacy `companyascode.app` is refused
(`src/modules/read-application.ts`).

### Bun is the App's runtime

`packageManager` pins an exact, released Bun, `bun@x.y.z`. That version is the
App's runtime: its preparation, its start, its build and its own server all run
with exactly that Bun, never with another
([F62](decisions.md#f62--the-bun-an-app-pins-is-its-runtime-the-users-bun-when-it-is-that-version-else-the-runtime-cache-else-a-verified-fetch),
decision 0171, addendum of 2026-10-24). The Platform takes the user's Bun at
`~/.local/bin/bun` when it reports that version, otherwise the version from its
runtime cache under `~/.local/share/lazurio/runtimes/bun/`, otherwise it fetches
that version from Bun's npm distribution with its integrity checked. What it
cannot have refuses the run with a reason named by the App's `package.json`:
`runtime-unavailable`, `runtime-integrity-failed`, `runtime-version-unknown`,
`runtime-disk-full` or `runtime-unsupported-platform` (`src/modules/bun-runtime.ts`).
A `packageManager` that is not an exact Bun version is
`preparation-package-manager-unsupported`.

A new Module pins the Bun of its [stack profile](stack-profiles.md), the same
for every profile (`scaffoldBunVersion`, `src/modules/scaffold.ts`), not the Bun
this repository builds with. Another released version is
the Module author's deliberate choice in an ordinary pull request of the Module;
every Environment that runs it fetches that version once. In an Organization with
a Henry, Henry may converge the pins up to Lazurio's default version (decision
0171). A package that pins no Bun runs with the user's Bun, whichever version it
is ([F25](decisions.md#f25--a-module-without-a-preparation-declaration-starts-by-a-default-preparation));
a conformant App always pins one.

### The run declaration: `lazurio.runtime`

```json
"runtime": {
  "schema_version": "lazurio.runtime.v1",
  "id": "example-notes-v1",
  "title": "Notes",
  "company": "example",
  "module": "notes",
  "surface": "internal",
  "dev_script": "dev",
  "tags": ["notes"],
  "listeners": [
    {
      "id": "app",
      "role": "entrypoint",
      "lease": "main",
      "protocol": "http",
      "health": { "kind": "http", "path": "/healthz" }
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `schema_version` | `lazurio.runtime.v1` |
| `id` | the App's id, `^[a-z0-9]+(-[a-z0-9]+)*$`; a new Module gets `<organization>-<module>-v<N>` for its App generation in lowercase (`-v1`, with `--data` `-v3`), a personal one `personalspace-<module>-v<N>` |
| `title` | the App's name |
| `company`, `module` | equal to `company` and `id` of `lazurio.module.json` |
| `surface` | `internal`, `manual`, `admin` or `public-preview` |
| `dev_script` | a script of the package: the development server |
| `tags` | lowercase words, `^[a-z0-9][a-z0-9-]*$` |
| `listeners[]` | `id` (`^[a-z][a-z0-9-]*$`), `role` (`entrypoint` or `auxiliary`), `lease` (a lease id of `lazurio.module.json`), `protocol` (`http`, `https` or `tcp`), `health` (`{"kind": "http", "path": "/…"}` or `{"kind": "tcp"}`) |
| `required_module_slots` | optional: the Organization slots the App needs, see [Siblings](#siblings) |
| `secrets`, `optional_secrets` | optional: names of the App's secrets, see [Secrets](#configuration-and-secrets) |
| `build_script`, `build_output`, `static_fallback`, `start_script` | optional: the built version, see [The built version from `main`](#the-built-version-from-main) |
| `description` (at most 240 characters), `icon`, `group` (at most 80 characters), `plugin` (ends in `.json`), `preview_script`, `production_url` (starts with `http://` or `https://`) | optional; the catalog shows `title`, `description`, `icon` and `tags` |

Exactly one listener is the entrypoint, and it speaks HTTP or HTTPS. Listener ids
and the leases they reference are unique. An HTTP health path starts with `/` and
cannot leave the App's own origin (`//` or a backslash is refused); a `tcp`
listener has a `tcp` health check. `dev_script`, `build_script` and
`start_script` name scripts of the package that exist. `parseAppRuntime` and
`planModuleRuntime` (`src/modules/runtime.ts`) refuse anything else, an unknown
field included.

### The preparation: `lazurio.preparation`

```json
"preparation": {
  "schema_version": "lazurio.preparation.v1",
  "owner_package": "app/v1/package.json",
  "check_script": "check:prepared",
  "prepare_script": "prepare:app"
}
```

- `owner_package` is the App's own `package.json`. The Platform refuses a
  workspace owner or member (`preparation-workspace-unqualified`): one App, one
  package, one lockfile.
- `check_script` is required and read-only: it exits 0 when the App is prepared,
  otherwise non-zero.
- `prepare_script` is optional. It does everything a start must not do: data,
  migrations of the Module's data, generated files. It is idempotent and makes no
  network calls besides what the dependency install fetches. For an App with
  `build_output` it never builds the App: the build is `build_script`'s alone.
- Script names follow `^[A-Za-z][A-Za-z0-9:_-]*$` and are never npm lifecycle
  names (`prepare`, `preinstall`, `install`, `postinstall`, `prepublish`,
  `prepack`, …), which `bun install` runs by itself. The convention is
  `prepare:app` and `check:prepared`.

**What the Platform runs before a start** ([F34](decisions.md#f34--a-declared-preparations-start-installs-checks-and-prepares-when-the-check-fails-lazurio-module-prepare)):
`bun --no-env-file install --frozen-lockfile` from the lockfile beside the owner
package, then the check; when the check fails, `prepare_script` and the check
again. The App starts only when the check passes. The install belongs to the
Platform; a Module's script never repeats it. `lazurio module prepare` runs the
same step without a start. A preparation that cannot run names its reason and
file, among them `preparation-lockfile-missing`, `preparation-lockfile-ambiguous`,
`preparation-lockfile-unused`, `preparation-script-missing`,
`preparation-install-failed`, `preparation-script-failed`,
`preparation-dependency-outside-owner`, `preparation-dependency-missing` and
`preparation-toolchain-mismatch` (`src/modules/preparation-refusal.ts`); a check
that still fails after `prepare_script` is `prerequisites-not-ready`.

An App without `lazurio.preparation` gets the default preparation, the frozen
install alone ([F25](decisions.md#f25--a-module-without-a-preparation-declaration-starts-by-a-default-preparation)).
The default exists for adopting Modules written before the standard; a conformant
App declares its preparation.

### Python Apps

A Python App follows the same contract with `uv`. `app/v<N>/` holds
`pyproject.toml` and a committed `uv.lock`; its `package.json` carries the scripts
and `lazurio.*`, mirrored in `[tool.lazurio]` of `pyproject.toml`. `dev` runs the
package's entry point as one process (`uv run --no-sync <module>`), `check` runs
`ruff` and `pyright`, `test` runs `pytest`, and `lazurio.preparation` adds
`runtime: "uv"` and the exact `uv_version`. `lazurio module create --stack
python-uv` creates such a Module. The Platform does not read `runtime` and
`uv_version` yet: its preparation reader refuses them, so a Python App is listed
as `default-app-invalid` and does not start until the `uv` adapter exists
(`tests/module-scaffold.test.ts`). A Bun App never writes `runtime`.

## Starting an App

### One process

`dev_script` and `start_script` start exactly one long-running server process
and nothing else. They do not build, run `concurrently` or another supervisor,
create files or symlinks, run migrations, read `.env`, set `NODE_ENV` or bind
ports other than their listeners. Child processes are allowed only as children of
that one process (for example Vite's middleware inside a Bun server).

```text
"dev": "bun --no-env-file run src/server.ts"
"dev": "bun --no-env-file ./node_modules/vite/bin/vite.js"
"dev": "astro dev"
```

The Platform starts the script as `bun --no-env-file run <script>` in the App's
package directory with the App's pinned Bun
(`src/modules/local-application-adapters.ts`). Bun otherwise loads `.env`,
`.env.local` and `.env.<NODE_ENV>` from that directory by itself, and a second
`bun` that the script starts loads them again. Every `bun` call on the start path
therefore carries `--no-env-file` before its entry (between `bun` and the file,
or between `bun run` and the script name) and never `--env-file`. A framework
command without another `bun` (`astro dev`) needs nothing.

The script works with only Bun on `PATH`. On Linux the App's `PATH` is
`~/.local/bin:/usr/local/bin:/usr/bin:/bin`; on macOS it is `~/.local/bin`
followed by the Launchpad session's `PATH`. The pinned Bun's directory comes first
when that Bun comes from the runtime cache (`src/modules/module-operations.ts`,
`src/modules/bun-runtime.ts`). `node`, `npx`, `bunx`, `nvm` and global tools are
not used on the start path; a local binary runs as `bun <path>` or as a package
script.

### The environment an App gets

The App's process gets a closed environment built from its declaration, never the
user's environment ([F26](decisions.md#f26--a-started-application-gets-the-runtime-environment-of-the-replaced-launchpad),
`src/modules/application-environment.ts`):

| Variable | Value |
| --- | --- |
| `LAZURIO_RUNTIME_LISTENER_<ID>_HOST`, `LAZURIO_RUNTIME_LISTENER_<ID>_PORT` | host and port of each listener, from its lease; `<ID>` is the listener id in capitals with every other character as `_` (`app` → `APP`) |
| `LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN` | the browser origin of the entrypoint, only for the Module's default App on a Remote Environment |
| `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN` | the loopback origin of each declared sibling, see [Siblings](#siblings) |
| `LAZURIO_RUNTIME_SECRET_<NAME>` | each declared secret with a value, see [Secrets](#configuration-and-secrets) |
| `LAZURIO_RUNTIME_BUILD_OUTPUT` | the installed client build of an App with its own server started from `main` |
| `NODE_ENV` | `development` for the development server, `production` for the built version |
| `HOME`, `PATH`, `TMPDIR` | the account's home, the `PATH` above, the temporary directory |

For Modules written for the earlier Launchpad, the Platform also passes
`LAZURIO_RUNTIME_HOST`, `LAZURIO_RUNTIME_PORT`, `LAZURIO_RUNTIME_EXTERNAL_ORIGIN`,
`LAZURIO_RUNTIME_LISTENERS_JSON`, `LAZURIO_RUNTIME_APP_ID`,
`LAZURIO_RUNTIME_ENTRYPOINT_ID`, `LAZURIO_RUNTIME_SCHEMA_VERSION`, `NODE_PATH` and
`COMPANYASCODE_*`, and sets `BUN_OPTIONS=--no-install` so that no undeclared
package is fetched at run time. A conformant App reads none of the legacy pair,
`PORT` or `COMPANYASCODE_*`.

### Host and port

The App reads its host and port only from `LAZURIO_RUNTIME_LISTENER_<ID>_HOST`
and `LAZURIO_RUNTIME_LISTENER_<ID>_PORT`. Without them it does not run: it exits
with code 2 and a message that names the missing variable. It never guesses a
port from a lease file, `PORT` or a default. A development server accepts a
foreign `Host` only from its own `_EXTERNAL_ORIGIN` (Vite and Astro
`allowedHosts`), loopback always, and never binds `0.0.0.0`.
`@lazurio/module-kit` implements this: `listener("app")` returns host, port and
external origin and throws when a variable is missing, after which the App exits
2; `viteServerOptions("app")` and `astroServerOptions("app")` configure the
development servers. The start test that `lazurio module create` writes checks
the exit code and the message (`src/modules/templates/_bun/app/v1/tests/start.test.ts.tmpl`).

### Health, stop and logs

- **Health.** The listener's HTTP health path answers 200 once the App really
  serves, and before that 503 or nothing. The Platform's probe counts a 2xx
  status and never follows a redirect (`src/modules/health.ts`), so a site with a
  language index declares `/cs/`, not `/`.
- **Stop.** On `SIGTERM` the App ends cleanly with exit code 0. The Platform
  stops the App's whole process group: on Linux the service manager kills what
  still runs after 5 seconds (`TimeoutStopSec=5s`,
  `src/modules/systemd-user-runner.ts`), on macOS the session runner after
  1 second (`src/modules/guarded-process.ts`). A fatal state is a non-zero exit;
  the App never restarts itself, and the Platform does not restart it either:
  its state becomes `ended` and the next Open or start starts it again.
- **Logs.** The App logs to stdout and stderr only. On Linux each App is a
  transient systemd user service (`UMask=0077`) whose output goes to the user
  journal, read by `lazurio module logs`; on macOS an App is a child of the
  Launchpad session and its output is not kept ([F8](decisions.md#f8--the-os-service-manager-owns-long-running-applications)).
- **Writes.** The App writes nothing outside its Module, `XDG_STATE_HOME` and
  `XDG_CACHE_HOME`.

### Configuration and secrets

An App's configuration is its runtime environment plus files committed in the
Module (`config/*.json`, defaults). A demo or offline mode is a separate script
(`dev:demo`), never the start.

A secret (an API key, a token, a password) is never in the repository, in a
`.env*` file or in a file the App stores. The only source at start is the
Environment's own vault (decisions
[0177](decision-register.md#0177--secrets-an-app-needs-at-start-come-from-the-environment-vault-never-from-env-files),
[0196](decision-register.md#0196--module-data-the-environments-ceiling-narrowing-in-the-app-and-a-verified-identity-that-is-not-a-key)
and [0198](decision-register.md#0198--each-environment-has-its-own-vault-managed-by-the-people-who-have-access-to-it),
[F46](decisions.md#f46--runtime-secrets-declared-names-read-from-the-environment-vault-before-every-start-fail-closed)):

```json
"runtime": {
  "...": "...",
  "secrets": ["EXTERNAL_API_KEY"],
  "optional_secrets": ["MAPS_API_KEY"]
}
```

- **Names only.** Each name matches `^[A-Z][A-Z0-9_]*$` and appears once; a
  list is never empty (an App without secrets leaves the key out), and a name is
  never both required and optional (`src/modules/runtime.ts`).
- **Before every start**, a restart included, the Platform reads each declared
  name from the Environment's vault: the login password of the one item named
  exactly `<NAME>`. It passes the value only to the App's own process as
  `LAZURIO_RUNTIME_SECRET_<NAME>`, never to the preparation's processes, a log, a
  finding or a file (`src/modules/runtime-secrets.ts`). A changed value applies
  from the next start.
- **Required secrets fail closed.** When a value of `secrets` is missing, held by
  more than one item, empty, or the vault cannot be used, the App does not start:
  `runtime-secret-unavailable` names each secret with its reason (`missing`,
  `ambiguous`, `empty`, `not-connected`, `locked`, `unreachable`,
  `other-organization`, `personalspace`, `personal-environment`, `workstation`,
  `no-vault-identity`, …) and never its value. The App itself also reads the
  variable fail-closed: exit 2 with a message that names the variable.
- **Optional secrets** are a capability some Environments have. A missing item,
  or a vault the App cannot use, leaves the variable out and the App starts
  without that capability, which it handles itself; it never falls back to a
  file or a shared sign-in.
- **Whose vault.** On a work Environment only the Apps of the Organization that
  owns it read its vault; on a personal Environment only Personalspace Apps
  ([F53](decisions.md#f53--every-environment-owns-its-vault-its-own-organization-in-the-networks-vaultwarden-created-by-its-technical-account)).
  Outside a Remote Environment, on a person's computer, the Platform reads no
  vault for an App: a required secret refuses the start there (`workstation`,
  `src/vault/host.ts`).
- **A static App declares no secrets**, see [Static App](#static-app-build_output).
- **A script outside the start** (an import, a one-off data migration) declares
  nothing: it reads the secret from the Environment's vault itself, under the
  Environment's account (for example `bw get password <NAME>`), and the Module's
  README describes the step.
- **An interface** may show "set / missing in the vault" for a secret; it never
  asks for the value or stores it.

### Siblings

An App that needs another Module of its Organization declares the slot in
`lazurio.runtime.required_module_slots`, as an Organization-relative path
(decision [0176](decision-register.md#0176--modules-sit-side-by-side-in-workspace-an-app-reads-a-declared-sibling-only-as-slug)):

- `workspace/<slug>` declares the sibling Module: the App may read its data and
  call its API.
- `workspace/<slug>/db` declares only the sibling's data mount: the App may read
  its data.

**Reading data.** The App reads a sibling only as `../<slug>/` from its own
Module root, and there only `db/` and the generated read models in `generated/`:
never anything under `app/`, a dotfile, a `.env*` file, the sibling's code or its
manifests. It writes nothing there; a change of the sibling's data goes through
the sibling's API. A path is never composed from `COMPANYASCODE_ORGANIZATION_ROOT`,
an absolute path or a symlink.

**Calling an API.** For each declared `workspace/<slug>` the Platform passes, at
every start, `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN`: the loopback origin of the
entrypoint of the sibling's default App, read from its lease at that start, as
`<protocol>://<host>:<port>` (for example `http://127.0.0.1:24611`). `<SLUG>` is
the slug in capitals with `-` as `_`. A sibling that is there but has no App, an
unreadable declaration or no HTTP(S) entrypoint gets no variable; whether the
sibling runs is not asked (`src/modules/sibling-origins.ts`). The rules:

- The App reads the address only from this variable, once at start.
  - **Absent:** the sibling has no usable entrypoint, or a Launchpad that does not
    pass the variable runs the App (an older release). The App keeps running and
    reports the sibling unavailable to its user ([F26](decisions.md#f26--a-started-application-gets-the-runtime-environment-of-the-replaced-launchpad)
    point 9); it never guesses a port.
  - **Present but not an exact loopback origin** (`http` or `https`, host
    `127.0.0.1`, `localhost` or `[::1]`, a port, no path): the App exits 2
    naming the variable.
- The address is for the App's server only. The App never gives it to the
  browser: no link, redirect, page data or CORS header. The browser calls the
  App, and the App calls the sibling (for example a proxy `/api/<sibling>/*`).
- A stopped or failing sibling refuses the call. The App answers its caller with
  a typed error (for example 503 "the sibling does not run in this Environment"),
  does not retry in a loop and never starts the sibling. Without the variable it
  answers that the sibling is unavailable ("the sibling's address was not
  passed").
- The call reaches the sibling directly on the Environment, without the gateway
  and without a signed-in user. When the sibling accepts writes only from its own
  origin, the caller sends `Origin` equal to the address. Who triggered the call
  is not carried; the standard does not define it yet, and the sibling reads
  `entry: "local"` ([Who came and with which role](#who-came-and-with-which-role)):
  the caller does not forward the gateway's statement.
- A link for people to a sibling's App is derived from the App's own
  `LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN` by replacing the first
  hostname label with the sibling's, following the hosted names of decision
  [0146](decision-register.md#0146--names-and-entry-of-hosted-environments). The
  gateway serves only a Module's default App. Where the variable is absent, no
  link is drawn.

**When a slot is missing.** Every required slot is declared by the Organization's
manifest, active and checked out beside the App, or nothing is installed or
started: `required-slot-undeclared`, `required-slot-planned` or
`required-slot-missing`, with the slot. The Module's own data mounts (slots
directly below it with `materialization: "repository_db_mount"`) are cloned at
start when absent; when that fails, the start is refused with
`data-mount-denied`, `data-mount-occupied`, `data-mount-unavailable` or
`data-mount-clone-failed` (`src/modules/data-mounts.ts`). No address is passed
for a Module of another Organization or an undeclared Module, and an App of a
Personalspace gets none.

### Who came and with which role

Lazurio decides who may open a Module's App and with which application role,
Application Admin or Application User (`appRole` `admin` or `user`, [decision 0234](decision-register.md#0234--the-names-of-access-roles-one-vocabulary-for-every-text-screen-and-agent)),
and the Organization decides in the
Module's code what each role may do ([decision 0231](decision-register.md#0231--access-in-an-organization-owner-admin-and-members-module-access-and-maintainers-application-admins-and-users)). An App learns it for
each request from the person's existing Lazurio session, with no second
sign-in.

**Status: available** with `@lazurio/module-kit` 0.3.0 (released 2026-11-06) on an
Environment whose gateway states the person and the entry (Machines v0.12.233
and later). Behind an older gateway a request through it reads `unknown`, which
grants no role. The stack profiles still pin module-kit 0.2.0
([stack profiles](stack-profiles.md)); an App adopts 0.3.0 with the profile
release that moves the pin.

**How an App reads it.** Only through `@lazurio/module-kit`:
`appAccess(request, "<listener>")` (Python: `app_access`). Its answer is the
stable contract: every answer has the same five fields, their values never
change meaning or disappear, and new information comes as new fields.

| `entry` | `appRole` | `person` | `source` | `reason` | When |
| --- | --- | --- | --- | --- | --- |
| `environment` | `admin` | subject and username | `gateway` | `null` | the person has the whole Environment where the App runs |
| `app` | `admin` or `user` | subject and username | `gateway` | `null` | the person has this App only, with the role the Organization gave them |
| `local` | `admin` | `null` | `null` | `not-hosted`, `not-through-gateway` or `local-entry` | from inside the Environment: no external origin (a person's own computer), a request to a loopback address (a sibling, a script, an agent), or the Environment browser's local entry |
| `unknown` | `null` | `null` | `null` | `no-identity` | through the gateway without a valid statement (for example a gateway release without this capability), or a `Host` that is neither the App's hostname nor loopback |

`source` says who stated the person: `gateway`, which states it from its own
admission answer (`/oauth2/auth`, [hosted entry](hosted-entry.md)) after
removing every copy a client sent; an identity signed by Lazurio Auth for use
outside the Environment will come as `auth`. Without a person `source` is
`null` and `reason` says why. A request whose `Host` names the App's external
hostname, in any letter case, with any port or a trailing dot, as the gateway
matches it, counts only by the gateway's statement, and a missing, repeated or
malformed statement is `unknown`. The headers that carry the statement are
transport, not this contract; read them only through the module kit.

The rules:

- **Enforce on the server, per request.** The App checks the role for every
  request, including APIs, downloads, WebSockets and direct URLs, never only by
  hiding a control, and never caches it. After another account signs in, the
  next request names the new person; an expired or missing session never
  reaches the App, because the gateway sends the person to sign in (a
  background request gets `401`).
- **`unknown` is no role.** The App shows that Lazurio did not say who came and
  refuses what needs a role. It never fills in a name or a role from the
  browser, the operating-system account, the Environment's Assigned User or the
  account that runs the Environment.
- **The subject identifies, the username is shown.** An App that remembers a
  person keys them by `subject`; `username` may be `null`.
- **Finer roles are the Module's.** Approvers, technicians and the like live in
  the Module's own data, keyed by `subject`; Lazurio keeps only the two
  application roles.
- **`local` is a statement of the Environment, not a proof.** The `Host` check
  only tells a request for the App's hostname from an ordinary call to a
  loopback address.
  It cannot prove that a request went through the gateway: a process on the
  Environment that reaches the App's loopback port can set `Host` and the
  headers itself, as it can read the App's data. The Apps of one Environment
  are one trust domain under its account (decision 0196), so the answer holds
  against visitors who have only the App, never against the Environment's
  operator, and is no authentication boundary inside the Environment.
- **No key and no signature.** The answer grants no access to data, signs
  nothing and changes no historical record. The App does not forward it to a
  sibling or another service.

## The built version from `main`

Opening a Module from `main` runs its built version: a static build the Platform
serves, or one production process of the App's own server, rebuilt after each
change of `main` while the previous build keeps serving (decisions
[0195](decision-register.md#0195--an-environment-under-full-memory-slows-down-but-does-not-freeze)
and [0212](decision-register.md#0212--what-is-published-on-main-is-what-lazurio-runs-as-a-build),
[F58](decisions.md#f58--a-static-app-starts-from-main-as-its-build-each-commit-built-once-outside-the-checkout-served-by-the-platform-rebuilt-after-a-pull)).
Every App declares either `build_output` or `start_script`. An App that declares
neither still runs its development script from `main` (`lazurio module build`
answers `not-static`) until it is converted.

### Static App (`build_output`)

An App whose output is files (Astro without SSR, Vite without its own server)
declares:

- `build_script`: a script of the package that builds the App.
- `build_output`: the directory of the package the build writes, for example
  `dist`. Segments are separated by `/`, each matches
  `^[A-Za-z0-9_][A-Za-z0-9._-]*$` (no `.`, `..`, leading dot, absolute path or
  backslash), at most 200 characters.
- `static_fallback` (optional): `"404"`, the default, answers an unknown path
  with the build's `404.html` and status 404 when the build has one; `"spa"`
  answers an unknown path whose last segment has no dot with `index.html` and
  status 200.

A static App has exactly one listener, the HTTP entrypoint with an HTTP health
path, and no `secrets` or `optional_secrets`: nothing of it runs on the server,
and a secret built into public files would be published (`src/modules/runtime.ts`).
After the build, `build_output` is a directory and the health path resolves in it
directly to a file: a path without a trailing `/` to the exact file or
`<path>.html`, a path ending in `/` to its `index.html`. A path that only reaches
a directory would answer with a redirect, so such a build is not used
(`build-output-unservable`).

The Platform serves the build with its own small static server on the App's
listener (`src/modules/built/static-server.ts`): GET and HEAD only, nothing
outside the build, `<path>`, `<path>.html` and `<path>/index.html` (a directory
without its slash redirects), `/_astro/` and `/assets/` cached for a year, HTML
revalidated (`no-cache`, ETag), a missing asset served from the previous build.

### App with its own server (`start_script`)

An App with its own server (a Bun server, an API beside its client) declares
`start_script`: a script of the package that starts its production server as one
process ([F58, addendum (2) of 2026-10-21](decisions.md#f58-addendum-2-of-2026-10-21-an-app-with-its-own-server-runs-from-main-as-one-production-process)).
It may be the same script as `dev_script` when that already is the production
server. The rules of [One process](#one-process) apply to it, and a development
server (`vite` without `build`, `astro dev`, `bun --hot`, `bun --watch`) is not
one. Its client, when it has one, is declared with `build_script` and
`build_output` and built like a static App's; `static_fallback` is refused,
because the server routes its own requests. The server gets its listeners (any
number), secrets, siblings and external origin as its development run does. Its
server code runs from the checkout.

From `main` the Platform starts `bun --no-env-file run <start_script>` in the
package with `NODE_ENV=production` and, with a client,
`LAZURIO_RUNTIME_BUILD_OUTPUT`: the installed build outside the checkout, which
never changes while the App runs. The server serves its client from there, and
from its own output in a development run:
`process.env.LAZURIO_RUNTIME_BUILD_OUTPUT ?? "./dist"`.

### Builds

- **Where and how.** `lazurio module build`, a start without a build and the
  background refresh run the App's start-time preparation and then
  `bun --no-env-file run <build_script>` in the package with
  `NODE_ENV=production`. The build gets no listener, origin, sibling or secret,
  so its output is the same wherever it is served and nothing secret is built into
  a client (`buildEnvironment`, `src/modules/application-environment.ts`). A
  configuration that needs a listener at build time fails with
  `build-script-failed`.
- **Bounds.** One build at a time per Environment. On Linux each build is its
  own transient unit at low priority with at most 2 GiB of memory and
  10 minutes (`src/modules/built/build-process.ts`).
- **Output.** The Platform removes `build_output` before the script runs and
  requires it afterwards as a directory written by this run
  (`build-output-missing` otherwise). When the output or the way to it is a link
  (a symlink, a junction on Windows) or leads out of the package, nothing is
  removed, built or copied (`build-output-unservable`,
  `src/modules/built/output-boundary.ts`). The build is kept outside the checkout,
  under `${XDG_CACHE_HOME:-~/.cache}/lazurio/builds/`, with the current, the
  previous and the served build.
- **Key.** A static App's build is keyed by the Module's commit and the commits
  of the data mounts and required slots it reads; a server App's by the Module's
  commit alone, because a server reads its data at run time. A checkout with
  uncommitted changes is built under its `HEAD` key and marked `dirty`.
- **After a change of `main`.** The Platform watches the checkouts of every
  built App, sweeps every 5 minutes and fast-forwards clean primary checkouts
  hourly; a new key builds in the background. A static App is swapped onto the new
  build without a restart; a server App is restarted onto it, with a gap of a few
  seconds. A failed build (`build-script-failed`, `build-timed-out`,
  `build-output-missing`, `build-output-unservable`) keeps the previous version
  running and is not retried by itself, unless the pinned Bun could not be
  fetched (`runtime-unavailable`, `runtime-disk-full`); a person's start or
  `lazurio module build` retries it. A server commit that builds but does not start leaves the App
  ended, because the previous server code lived in the checkout: the Module's CI
  guards `main`.
- **The development server of a built App** runs from `main` only on explicit
  request (`lazurio module start --dev`, or "Spustit vývojovou verzi" in the
  Launchpad), until it is stopped; a swap never replaces it. A worktree preview is
  the development server, run by an agent in its worktree.

### Sleep

An App started from `main` that has had no open connection on its listeners for
20 minutes is stopped like a plain Stop
([F58, addendum of 2026-10-21](decisions.md#f58-addendum-of-2026-10-21-an-app-nobody-uses-falls-asleep),
`src/modules/module-operations.ts`). The next Open, or a signed-in direct link on
a Remote Environment, starts it again as its newest build, and the first request
waits for the start. What the App held only in memory is lost, so an App keeps no
state that has to survive in memory alone. A Module that another App of its
Organization declares as `workspace/<slug>` never sleeps, because its callers
reach it past the gateway, which wakes nothing; a Module that must work without a
person is a service, not an App.

## Applications of an Organization

Every Module with an app is an **Application** of its Organization once it is
ready as one (decision 0249, [A Module ready as an Application](module-readiness.md)):
the released, built App on the Organization's application host at
`https://<module>.<org>.lazurio.app`. People open it with their Lazurio account and
an Application User or Application Admin role, without an Environment, tailnet
access or source code; use the verified deployment output for an actual link. The
App a Module runs from `main` in an Environment is the Application's **development
version**: the state of `main`, for the people who build the Module and their
agents, not necessarily the version people have. Read-only Applications (`app/v1`,
`app/v2`) are Applications too; their content changes only in the Module.

**Who enters.** Whoever has the Module enters its Application: a Module Reader as
an Application User, a Module Contributor and a Module Maintainer as an Application
Admin, by the Module roles Lazurio holds (reading a public repository is no Module
Reader role). Roles given in the Application to a person, a Team or the whole
Organization add to that, and the higher role holds. For one Application the
Organization Admin may switch the entry through the Module off ("application roles
only"); then only roles given in the Application decide. Access to an Application
never gives access to the Module. The App itself learns only the application role,
through `appAccess`; how the role was derived is Lazurio Auth's (decisions 0231,
0249). Until Auth itself holds the Module roles, a person enters the Application only
through a role given in it or the Organization Admin role; having the whole of an
Environment makes someone Application Admin only of the development version
running there, never of the Application on the application host.

**A new version.** By default every merge to `main` is deployed; an Organization
may instead require a release approved on GitHub, with a version number and
release notes (decision 0249). Every rollout keeps its Plan, Permit, readback and
evidence for the exact commit (decision 0205). Who approves a release, the
safeguards of an automatic deployment and where the mode is recorded are open in
0249; its proposal is green checks on the merged commit, a backup of the data
before the switch, the new version started beside the running one and switched
to only when its health is good, and the mode with its approvers in the
Deployment Repo (decision 0245). A Module is built so that this works: one
process, deep health, and in `app/v4` migrations that only expand. Until the application host deploys this way, a version is
deployed through a reviewed pull request to the Deployment Repo, and its merge is
the approval (decision 0239). In `app/v4` an automatically deployed migration only
expands the schema; one that drops or narrows it goes only through an approved
release with a restore from backup as the way back.

**The runtime contract** still holds: built output, one server process, listener
host and port from `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` and `_PORT`, direct 200
health that answers 503 until the App's data are open, and secrets declared by name
and delivered from the Organization's vault through Machines custody. No secret
values in Git or requests. The App enforces Application User and Application Admin
permissions on every server request through `appAccess` of `@lazurio/module-kit`;
unknown identity or a missing role grants nothing.

**The Application is the sole writer of its data.** On the application host the
App always gets `LAZURIO_RUNTIME_DATA_WRITER`: with `true` it writes; with `false`
or any other value it neither writes, pulls nor publishes, by the one rule
`dataWriter` of
[Effects and publication](#effects-and-publication).

**Open: when an App may write without the variable** (decided by the Owner; until
then Modules keep what they do today and nothing builds on either variant). In an
Environment the Platform passes no `LAZURIO_RUNTIME_DATA_WRITER`, people still
write there until the Module's writer moves, and the runtime does not yet state
where the App runs (#1041, #1034). Two variants:

- **A, transitional (recommended):** a missing variable means the development
  version in an Environment. Only the entries `local` and `environment` write,
  and so does the data sync host itself (at start, in the background and after
  their requests); a request from the entry `app` (a person who has only the
  application) only reads and syncs nothing, and its write is refused. A runtime
  that states `LAZURIO_RUNTIME_DEPLOYMENT=production` (#1041) never writes
  without `true`, with or without the writer variable.
- **B, fail-closed:** a missing variable means no write. Before a development
  version writes again, the Platform has to pass `LAZURIO_RUNTIME_DATA_WRITER=true`
  on the Environment that is the writer (#1034); until then work in Environments
  stops writing.

A keeps people working until the writer moves, and B is stricter but stops
writing in every Environment until #1034 ships. With
repository-db the application host is then the sole sync host for the declared
data repository, and development versions use preview data. Moving the writer
names the old and new writer and its approved steps; until then the Application
runs as a trial with `data.writer: false`. A second writer is never a trial.

**Siblings.** An Application reads from a sibling's data (`workspace/<slug>/db`)
only the contract the sibling documents with a version, never its internal files,
and says so plainly when the replica is missing, never filling in data of its own.
The application host provides sibling data as a read-only replica; an API sibling
runs as another Application of the same host. A host that cannot yet do either is
a host condition of the readiness check, not a defect of the Module.

**Agents and Buddy.** An Application may offer its tools to agents through `/mcp`
and WebMCP, behind the gateway and by the application roles above, as
[Tools for agents](#tools-for-agents-mcp-and-webmcp) describes; the rollout then
checks `401` without a token and the refusal of an invalid token, a wrong audience
and a missing application role through the real gateway. A fixed shared token is
not a substitute for Lazurio sign-in. Buddy's bubble appears in an Application only
for a person who has Buddy (decision 0180 as amended by 0249); Buddy is then one
more client of the same tools, through the Application's MCP server connected in
the person's Work Environment or the development version's page tools there, and
never gets more than the person's role. How the bubble gets onto an Application
is open in 0249 (proposed: the application host's gateway adds it, so a Module
would carry no code for it); until it is decided, the standard asks nothing of a
Module for the bubble.

The generated `manual/admin.md` describes the Organization Admin's part (the
release mode, the entry switch, roles, verification); `admin-request` gives
everyone else one request in the Organization's root repository. Check the
Organization's deployed pipeline and evidence before describing this delivery path
as available.

## Boundaries and dependencies

- An App imports only from its own repository and from dependencies declared in
  its `package.json`. Never `../../launchpad/…`, `<organization>/infra/…`,
  `<organization>/design-system/…`, another Module's code or a `file:`
  dependency outside the Module.
- A declared preparation installs local `file:` dependencies only from inside the
  owner's directory (`preparation-dependency-outside-owner`,
  `src/modules/local-dependency-inputs.ts`).
- Shared contracts of an Organization become a versioned package the Organization
  owns (a repository of its own, a dependency on a released tag), or move into the
  one Module that uses them.
- A design system's assets come as a dependency on its package, never by a
  relative path.
- Git submodules are allowed only for foreign code with its own lockfile, and
  never on the start path.
- The Platform reads a Module, its App directories and its required slots only as
  real directories owned by the user, never through a symlink
  ([F23](decisions.md#f23--the-operators-own-checkout-is-read-by-ownership-not-by-permission-bits-or-link-count),
  `src/folder/owned-directory.ts`).

**Data.** A Module's records live in repository-db: the Module depends on one
released version, `github:Lazurio/repository-db#v3.x.y`, never on a branch's
commit, and its data repository `<owner>/<module>-data` is checked out on its
generation branch (`v3`) as the Module's `db/`, declared in the Organization as
the slot `workspace/<module>/db` with `materialization: "repository_db_mount"`.
`lazurio module create --data` sets this up, with the App in `app/v3` ([F52, addendum of 2026-10-14](decisions.md#f52-addendum-of-2026-10-14-a-new-modules-data-starts-in-repository-db---data);
[F69](decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release), point 8).
Generated read models in `generated/` are derived and never edited by hand. A
user's edit is an unpublished change in the data checkout; publishing it is one
commit and push, a Publication.

Three consequences for the App and its validation:

- **Validate content, not the Git index.** A publication runs the data repository's
  validate commands in the live checkout before it stages the change
  (`git add --all`), so a file added in the same draft is still untracked there,
  while in a pull request's CI every present file is tracked. A validation rule must
  therefore judge the checkout's content (paths, files, what `.gitignore` excludes),
  never whether a file is tracked or staged.
- **Check rules across records in the App first.** When the validation fails at
  publication (`validation_failed`), the change stays an unpublished, editable draft
  in the data checkout, and every further publication fails the same way until the
  data or the validator is corrected and the publication retried (repository-db
  `docs/operations.md`); discard the draft only if it should not be published at
  all. A rule that spans records
  (a unique open item, a reference to another record) belongs in the App's operation
  before it writes, answering the request with a refusal (`409`, `422`); the
  validator stays the safety net.
- **A new field ships validator first.** Merge the data repository's validator
  change before the Module change that writes the field; in the other order the new
  App writes what the old validator refuses. The schemas are strict, so an older
  running copy of the App cannot read a record with the new field: update every
  running copy before converting existing records.

## Stacks and quality

An App is written in strict TypeScript: no `.js`, `.mjs` or `.cjs` sources, and
framework configuration in TypeScript (`vite.config.ts`, `astro.config.ts`).
`bun run check` runs the type check, Biome and the tests (`bun test`); the
Module's CI runs it on every pull request. In an App with data it also runs
`bun run validate:data`: every record the Module's own repository carries
(`seed/` in the App, laid out like `db/data/`, a directory per collection and a
document `<id>.yaml` in repository-db's envelope) is checked against the Zod
schemas of `src/domain/collections.ts`, and a record that does not match, a
wrong envelope or a collection without a schema fails the check. The records in
`db/` are a repository of their own, which the Module's CI does not check out:
the App hands the same schemas to repository-db as its parsers, and
`bun run validate:db` checks them the same way before a publication.
`lazurio module create --data` writes the schemas (no collection yet), the
validation with its test and the empty `seed/`
([F69](decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release), point 7).

Each App is built with the exact tools of its [stack profile](stack-profiles.md)
(decision
[F69](decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release)):
`content` for the Astro stacks, `app` for `vite-react` and `bun-service`,
`app-data` with repository-db data and `app-database` with Dolt. Its tools change
only by a transition to the next App generation or by a new release of its
profile, which an existing Module takes in a pull request of its own.

| App | Stack (`lazurio module create --stack`) |
| --- | --- |
| Interface and data application | `vite-react`: Vite, React, TypeScript, a static build with `static_fallback: "spa"` |
| Website | `astro`: Astro, a static build |
| Documentation, knowledge base | `astro-starlight`: Astro with Starlight, a static build |
| Service, API, automation | `bun-service`: `Bun.serve` without a framework |
| Python service | `python-uv`: `uv` and `pyproject.toml`; not startable yet, see [Python Apps](#python-apps) |
| Module without an App | `none` |

Another stack is the user's decision, never a silent exception.
`@lazurio/module-kit` (`github:Lazurio/module-kit#v0.x.y`) is the only runtime
library a Module shares: listeners and their fail-closed reading, the health
handler, `onShutdown()` for `SIGTERM`, the development server options and
`viteShutdownPlugin()`, which closes Vite's open connections on `SIGTERM` so that
it exits 0. It does not grow into a framework.

## Tools for agents (MCP and WebMCP)

People and agents work in the same Apps. A colleague's agent works with an
Organization's App in two ways, and both reach the same tools:

- **as an MCP server**, connected once in the colleague's Environment
  (Integrations, Executor) and signed in as that person: every agent and bot of
  the Environment then calls the App's tools by that person's application role;
- **in the page**, when the agent has the App open in the Environment browser
  (the right panel of the agent's chat shows it): the page registers the same
  tools as WebMCP tools and the agent calls them with `agent-browser webmcp
  list` and `webmcp invoke` ([Environment browser](environment-browser.md)),
  with the page's own session.

Clicking through the page like a person is slow and breaks when the page
changes; a second, agent-only API would drift from what people may do. So an
App defines its tools once, on its server, and offers them through two
transports over the same handler (Matěj 2026-11-05 and 2026-11-17, amendments
of [0171](decision-register.md#0171--lazurio-module-standard); plan LZD-0037).

**Status.** The registry, both transports and the test helpers are in
`@lazurio/module-kit/tools`, `/tools/testing` and `/webmcp` of module-kit
v0.4.0, which the stack profiles pin from release 2026.12. The Application host's gateway admits `/mcp` today (Machines
v0.12.244 and later states the scope, below). Lazurio does not yet offer an
Organization's App MCP server in Integrations by itself; until it does, the
person adds it under Integrations → Custom. `lazurio module create` gives a
`bun-service` its tool registry at `/mcp` (`src/agent-tools.ts`, with
`get_app_context` and a test), and every Module with data (`--data`) the
single-record part of the data port (`src/data/store.ts`: get, list and save
with a revision unique per write, over repository-db, with
`tests/store-contract.test.ts`) and the same registry; a record's history and
a change of several records in one write the Module adds with their contract
cases when it needs them; a `vite-react` or
`astro` App with data routes them once it has a server of its own.

### Which Apps and which tools

- **Which Apps.** Every App with an interface where people do something:
  create, edit, search, assign, prepare, approve. A website or a knowledge base
  that people only read (`astro`, `astro-starlight`) needs none; a service
  without an interface (`bun-service`) offers its tools through `/mcp` only.
- **Which tools.** The actions a person does most and the ones an agent is
  asked to do: find a record, read it, fill or change it, prepare a document,
  produce a PDF. A tool names one action (`snake_case`, verb first, in English:
  `find_revisions`, `update_measurement`); its description, in the
  Organization's language, says what it does and what it returns; its input and
  output are JSON Schema.
- **Never more than the interface.** A tool offers a person exactly what the
  interface offers that person: the same role, the same rules, the same
  redaction. It calls the Module's domain service, the one the interface's API
  calls, never the data files, the repository-db checkout or SQL directly.

### One registry, two transports

The App's server keeps one registry (`createToolRegistry` of
`@lazurio/module-kit/tools`). Each tool states its name, description, input
and output schema, the least application role (`user` or `admin`), its effect
and whether its answer carries text other people wrote (`untrustedContent`).

- **`/mcp`.** A stateless MCP server: Streamable HTTP with JSON answers, `POST`
  only (`405` with `Allow: POST` otherwise), no batches, a bounded body (64 KiB
  by default), JSON only, an unsupported `MCP-Protocol-Version` refused, and a
  request whose `Origin` is not the App's own refused. `/mcp` is the only path:
  no aliases such as `/v1/mcp`.
- **The page.** `GET /api/agent-tools` lists the tools for the person who has
  the page open; `POST /api/agent-tools/<name>` calls one, only from the App's
  own origin (scheme, host and port exactly) and only as `application/json`,
  so a page of another site or another local port cannot call it. The page registers them with `registerAgentTools` of
  `@lazurio/module-kit/webmcp`, which looks up the WebMCP API
  (`document.modelContext`, `navigator.modelContext`) and registers nothing
  without it; the page works the same.
- **View tools of the page.** A page may add tools that only open or show
  something (`open_revision`). They never change data, never shadow a server
  tool and exist only on the page.
- **Identity.** Both transports read who came only through `appAccess`, for
  every call. When Lazurio did not say who came (`entry: unknown`) the App
  answers `403` `identity_unavailable` before any MCP processing; the gateway
  already sent an unauthenticated `/mcp` call a `401`. A local entry (`entry:
  local`, an Application Admin without a name, in a development version in an
  Environment) is a valid caller on both transports. The App never sees the Bearer token and
  cannot tell an MCP call from a browser call: both come as `entry: app` (or
  `environment`) with `source: gateway`, so the registry records the channel
  itself.
- **The list follows the role and the writer mode.** `tools/list` and the page
  manifest contain only the tools the caller's role and the App's writer mode
  allow; a hidden tool called directly is refused (`forbidden`,
  `data_read_only`), an unknown one is `unknown_tool`.

### Effects and publication

Each tool declares what it does to the data:

- `read` changes nothing: finding, reading, computing, producing a file such as
  a PDF. The effect follows the data, not the HTTP method: a PDF export is a
  read and works in the read-only mode too.
- `prepare` changes no shared data and prepares a step a person completes in
  the interface: an approval, a signature, a sending.
- `write` changes data and says with `publishesData` whether the change is a
  publication of data (one commit and push in repository-db, `DOLT_COMMIT` in a
  database) or only a draft.

The rule of Publication holds for tools as for everything else
([Data](#boundaries-and-dependencies): publishing a data change is a
Publication). Two rules follow:

- **Never by a tool:** an approval, a signature, a sending, a deletion or a
  person's confirmation. A tool prepares it and the last step stays a button
  the person presses. No consent changes this.
- **A publication of data only with the Owner's recorded prior consent.**
  Otherwise a tool saves a draft where the data layer has drafts, or prepares
  the change that a person publishes in the interface, and a write tool that
  would publish data is not offered in an Application. The one
  exception is a kind of record for which the Owner allowed agents in advance
  to publish, with the decision recorded (a plan or a decision): such a tool
  names it in `publicationConsent`. That is the person's prior consent to that
  Publication under the rules of Publication; it covers only that kind of
  record, and the tool is still not offered in the read-only mode. An agent's own rules say the same (Publication only
on the person's word); the App holds it as well. Whether an Application may
let a tool publish an ordinary data change on a person's role is an open
decision of the Owner for every other kind of record (LZD-0037, D1); until it
is decided and a mechanism for the person's consent on both transports is
built and verified, it may not.
Executor's approval of a tool annotated `destructiveHint` is no such consent:
by default it returns the pause to the agent, not to the person
([Integrations](integrations.md#approvals)).

A write is offered only while the App may write, and the tools, the HTTP API
and the data port decide it by one rule (`dataWriter` of
`@lazurio/module-kit/tools`): `LAZURIO_RUNTIME_DATA_WRITER=true` writes and any
other value does not (an Application host always sets it, `true` or `false`);
what it does without the variable is open (variant A: only a local or
Environment entry and the data sync host write, to the Environment's own data;
variant B: nothing writes); see
[Applications of an Organization](#applications-of-an-organization).

### What every App answers

- **`get_app_context`.** Every registry answers it: module, App version, data
  generation (`v3`, `v4`…), `production` (the Application on the
  application host) or `environment` (a development version in an Environment),
  entry, application role, person and whether the caller may change data now.
  An agent checks it before it changes anything, so it knows whether it works
  with real data or with a development copy. Until the runtime states the
  deployment itself (Lazurio/LazurioPlatform#1041), an App on a host is the one
  whose runtime sets `LAZURIO_RUNTIME_DATA_WRITER`.
- **Answers and refusals.** A tool returns JSON data (an object) and optional
  files, or a refusal `{ ok: false, reason, message }`; it never throws for an
  expected outcome. The common reasons, the same in the App's own HTTP API, on
  `/mcp` and on the page: `identity_unavailable`, `forbidden`, `unknown_tool`,
  `invalid_input` (with the issues), `not_found`, `record_changed` (with
  `current_revision`), `data_read_only`, `unavailable` and `internal_error`; a
  Module adds domain reasons of its own in `snake_case`. On `/mcp` a refusal is
  a tool result with `isError: true` and `structuredContent`, never a protocol
  error; a file is an embedded resource, bounded in size. `unknown` stays
  distinct from `not_found`: when the App cannot tell, it says so, and the
  agent does not write again blindly.
- **Annotations.** `readOnlyHint` for `read` and `prepare`, `destructiveHint`
  only for a write that publishes data, `idempotentHint`, `openWorldHint:
  false`; on the page also `untrustedContentHint` for answers with text other
  people wrote, which the agent treats as data, never as instructions.
- **The App's version.** `serverInfo.version` is the App's released version,
  never a fixed number. The server's `instructions` carry the domain's rules
  the agent should know, in the Organization's language.
- **Lists page.** A list takes an opaque cursor and a limit, so the data layer
  under it can change.
- **Audit.** Every call writes one line: channel, tool, entry, subject, role,
  outcome and duration, never the input, the answer or a token.

### The Application host's gateway

The gateway admits `/mcp` and `/mcp/*` only with a Lazurio Auth Bearer access
token whose audience is the Application host's client and which carries
`application-user:<module>` or `application-admin:<module>` (with
`environment-app`, which Auth adds itself) or `environment-full`; it removes
the cookie, `Authorization` and every client copy of the identity headers
before the App. Without a token it answers `401` with `WWW-Authenticate:
Bearer resource_metadata=…, scope="<host client>-mcp"`, with a token without
the role `403 insufficient_scope`; the protected-resource metadata at
`/.well-known/oauth-protected-resource` name the issuer and `scopes_supported`
(Machines v0.12.244 and later: Keycloak takes the audience only from that
scope). The MCP client registers itself at the issuer under Auth's
registration policy and the person signs in and consents; a fixed shared token
or a public endpoint is never an access path. An App checks in its own tests
the list per role, the refusal without a role, the read-only mode and
`record_changed` on both transports (`@lazurio/module-kit/tools/testing`); the
rollout checks `401` without a token and the refusal of a wrong audience or a
missing role through the real gateway.

### The Application and its development version

- **The Application** (`<module>.<org>.lazurio.app`) holds the real data.
  Agents work with it only through its MCP server or its page, by the role of
  the person who connected; never by a copy of its data or a direct
  connection to its database.
- **The development version in an Environment** runs from the Module's checkout with
  preview data (repository-db checkout or a local database seeded by the
  Module). Agents use it to develop and test: its `/mcp` on the loopback
  address and its page tools answer as `entry: local`, an Application Admin
  without a name, and `get_app_context` says `environment`. It is not an
  Integration and is never connected as one.

### Connecting the App in a colleague's Environment

The person adds the App's MCP server (`https://<module>.<org>.lazurio.app/mcp`)
in their Environment under Integrations; Executor registers itself as the MCP
client, the person signs in with their Lazurio account and consents, and the
connection then serves every agent and bot of that Environment, by that
person's application role (decisions 0172 and 0196: the Environment is the
boundary). The sign-in is the person's consent: an agent never connects it for
them. A person without a role in the App gets a connection that answers
`403`. The target is that Lazurio offers the MCP servers of the Organization's
Applications in Integrations and the person confirms by signing in
(LZD-0037); until then the person adds it as a custom server.

### Tested like the interface

The App's tests check the names, input schemas and annotations of its tools,
the list per role and writer mode, that each tool calls the same domain
operation as its button, the refusals above, that no tool completes an
approval, a signature, a sending, a deletion or a person's confirmation, and
that a write publishing data is offered in an Application only with
`publicationConsent`, on both transports. Modules that exist converge in a pull request of their own.

## App generations

A Module's generation says where its data are, not its quality (decision 0249).
People and agents name five, V0 to V4; the directory `app/v<N>/` holds the App of
generations V1 to V4:

| Generation | Where the data are | Directory | Example |
| --- | --- | --- | --- |
| V0 | No app: data, exports or tools only; no Application | none (`apps: []`, stack `none`) | an export Module |
| V1 | The content is part of the App: a reference app | `app/v1` | a design system |
| V2 | The content lies beside the App in the Module; changing it is a pull request to the Module | `app/v2`, `data/v2/` | a knowledge base, a website |
| V3 | repository-db: one Application keeps its records in the Module's data repository; everyone sees a change at once, and it is published to the data repository when it is decided | `app/v3`, `db/` | a stock or a register people write in |
| V4 | A Dolt database in the Server Services of the Organization's server; every client has its own frontend and synchronizes with it | `app/v4` | an Application with many concurrent writers |

What "ready as an Application" means for each generation, and how
`lazurio module readiness` checks it, is in
[A Module ready as an Application](module-readiness.md).

- The generation number names the App's data layer, not its quality, in every
  generation created from now on (decision
  [F69](decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release),
  point 8):
  - `app/v1` has no data layer of its own: its content is part of the App. It
    ships and changes with the App, inside `app/v1/` or beside it, and no
    contract of its own describes it. The templates `LazurioTemplates/design-system`
    (`content/`) and `LazurioTemplates/presentations` (`data/v1/decks/`) are `app/v1`.
  - `app/v2` has no data layer of its own either, but its content lies beside
    the App in the same repository, in `data/v2/`, with a declared structure the
    App checks: much content that changes now and then and that agents edit. The
    App never writes it: a change is a pull request to the Module, and it reaches
    the Application with the next version. The
    public documentation is laid out this way (`Lazurio/documentation`: `app/v2/`
    and `data/v2/`, a website without a Module manifest).
  - `app/v3` keeps its records in repository-db: a data repository of their own,
    `<slug>-data`, mounted as `db/`. It is the default for a new Module with data.
  - `app/v4` keeps its records in a Dolt database in the Server services of the
    Organization's server (root decision 0209, decided, not yet deployed): on GitHub
    are the App, the process and the schema, not the rows. A Dolt outside the server
    is a connection setting of `app/v4`; there is no `app/v5`.

  "No data of their own" in F69 means no data layer of their own: `app/v1` and
  `app/v2` have content in the Module's repository, under its history, and no
  records behind a store. A new Module starts in `app/v1`, or in `app/v3` with
  `--data`; `app/v2` comes by a transition. A Module starts as low as it can, and
  moving to the next data layer is a new generation beside the old one, the data
  moved and `default_app` switched
  ([stack profiles](stack-profiles.md#how-a-profile-changes)). What this means for
  people is the [module explanation](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)
  of F14's second addendum of 2026-11-05.
- An existing Module whose App with data lives in `app/v1` or `app/v2`
  (created before this rule, for example by F52's addendum of 2026-10-14)
  conforms as it is and is not renamed: a rename would move its code outside a
  planned step. It moves at its next planned generation transition, which
  creates the generation of its data layer beside the old one (`app/v3` for
  repository-db, `app/v4` for Dolt); the old directory goes once it is no
  longer kept for a return.
- A Module keeps at most two App generations: the default one and one more,
  either the previous one kept for a return or a newer candidate that is not the
  default yet. Switching `default_app` to the candidate is the decision of the
  Module Maintainer or the user, never a conformance fix. Older generations
  are deleted; Git history keeps them.
- `apps[]` matches the directories: a package not declared in `apps[]` is not in
  the repository.
- When an App directory moves (`app/` → `app/v1/`) or a generation is deleted,
  existing checkouts keep its old build outputs (`node_modules`, `.astro`,
  `dist`, …), which no `.gitignore` covers any more, and a later update stops on
  them. The pull request that moves or deletes the directory adds those paths to
  the root `.gitignore`, and the rules stay until every checkout of the Module is
  verified clean.

### One data port under the tools, from `app/v3` to `app/v4`

An App's tools, its HTTP API and its interface never touch the data layer
directly. They call the Module's domain service, and the service calls one
port, `app/v<N>/src/data/store.ts`, named by operations of the domain
(`listRevisions`, `getRevision`, `saveRevisionFields(id, changes,
baseRevision)`, `publish(…)`), never by files, Git or SQL. The layout is the
`app-data` stack profile's ([stack profiles](stack-profiles.md)): a
repository-db implementation in `app/v3`, a Dolt one in `app/v4`
(`app-database`), and one domain test suite, `tests/store-contract.ts`, that
both pass. That is why moving to the database changes no tool: the tool
contract above stays, the implementation of the port changes.

The port holds, in both generations:

- **A stable id.** A record is a collection and an id; the id survives the move
  to `app/v4` unchanged (the table's primary key) and tools refer to it.
- **An opaque revision, unique per write.** A write carries the revision it
  was based on and ends with `record_changed` and the current revision when the
  record changed meanwhile, never by overwriting it. The revision is new and
  unique for every write, never derived from the content alone and never a
  counter: after A → B → A a content fingerprint repeats, and Dolt merges
  concurrent transactions by cell, so two writes of the same counter and
  content would both pass. Every writer stores a new random value or operation
  id in the record's `revision` field (repository-db) or `revision` column
  (Dolt), a direct writer included. The port compares that value and the
  content, so a direct change that kept the old value is still a change. The revision does not survive the move
  to `app/v4`: after the move a client reads the record again.
- **Atomic writes, where offered.** A port that changes several records in one
  write (a capability it offers once its tools or interface need it) changes
  them in one commit (repository-db) or one transaction with one `DOLT_COMMIT`
  (Dolt), never some of them.
- **Author and channel.** A change records the person's `subject` as its author
  (`<subject> <<subject>@subject.lazurio.invalid>`) and trailers
  `Lazurio-Subject` and `Lazurio-Channel` (`ui`, `mcp`, `webmcp`, `import`), in
  the Git commit or with `DOLT_COMMIT --author`. It is the App's statement, not
  a proof: the data layer proves only that the App wrote
  ([0196](decision-register.md#0196--module-data-the-environments-ceiling-narrowing-in-the-app-and-a-verified-identity-that-is-not-a-key), point 5).
- **History, where offered.** A port that offers the history of a record (who,
  when, what) gives it in the same shape from Git and from Dolt's history
  tables. Over repository-db this needs an engine API, which does not exist
  yet; the App never reads Git itself.
- **Lists by an opaque cursor**, which each implementation encodes its own way.
- **The read-only mode in the port.** When `dataWriter` (above) says the App
  may not write, the port answers `data_read_only` itself, before any error of
  the data layer; the service passes the same decision to the port, which
  never takes one of its own; a Dolt
  application without the writer role holds a read-only grant as well.
- **No raw errors.** A serialization failure of the database (`40001`) is
  retried a bounded number of times and then becomes `record_changed` (one
  record) or the domain's refusal (a rule across records), never an SQL error.
  A rule across several records (a balance never below zero) is guarded by one
  row each write updates with its unique revision; checking a sum alone does
  not protect it.
- **Drafts are optional.** A data layer may keep unpublished drafts (a working
  tree, a Dolt branch) and publish them; an Organization's App usually writes
  one operation as one publication. The tool contract above decides what a tool
  may do with either.

`store-contract` runs against both implementations in CI, `app/v4` against a
`dolt sql-server` of the pinned version, and covers: the stale revision, a
stale write after A → B → A, a direct change that kept the old revision, two
concurrent writes of the same record with the same content, the read-only mode
and paging, and, for a port that offers them, history and a change of several
records, including two concurrent writes breaking a rule across records.
Repository-db's single writer or a Git conflict keeps the concurrent cases in
`app/v3`; in `app/v4` only the unique revision does.

**Direct writes beside the App.** An Application is the only
writer of its data ([Applications](#applications-of-an-organization)).
In a development version in an Environment agents may change its data directly, for
a bulk import or a clean-up, with `repository-db origin --kind agent` and only
on the person's word; they store a new revision with every change, and the
port refuses a stale save instead of overwriting it. Whether agents may also
write an Application's data directly, in `app/v3` or `app/v4`, is an
open decision (LZD-0037); until it is decided they change production data
only through the App's interface and tools. The database's access contract for
an Organization's App is proposed in Machines#1350.

**Moving a Module from `app/v3` to `app/v4`**, as a generation transition:

1. Create `app/v4` beside `app/v3` in the same Module; both keep the same tool
   registry and pass the same `store-contract`.
2. Freeze writes to the `app/v3` data at a recorded commit.
3. Migrate with evidence: the record counts match and every record makes the
   round trip (v3 → v4 → v3) unchanged; ids stay, revisions are new.
4. Try the way back, an export from `app/v4` to `app/v3`, on a copy.
5. Switching `default_app` to `app/v4` is the decision of the Module
   Maintainer or the user, as for every generation, never an automatic step;
   the switched release reaches people by the Organization's release mode
   ([Applications](#applications-of-an-organization)). `app/v3` stays as the generation kept for a
   return until it is deleted.

The App reads its database connection only on the server, from runtime
secrets of its server service (proposed in Machines#1350:
`LAZURIO_RUNTIME_SECRET_LAZURIO_SERVICE_<ID>_HOST`, `_PORT`, `_USER`,
`_PASSWORD`, `_DATABASE`), never from `.env` and never in the browser. A development
version in an Environment uses its own `dolt sql-server` of the pinned version
with the Module's seed data, as in CI, never a copy of production.

## CI

A Module's CI saves GitHub Actions minutes (decision 0171, addendum of
2026-10-28):

- One Linux workflow runs every gate on every pull request and every push to
  `main`, with `concurrency` (a newer push cancels the older head's run) and
  `timeout-minutes`.
- Windows and macOS run in a separate workflow only for pull requests that change
  the App's code, its migrations, the toolchain or the workflows
  (`pull_request.paths`), and on request (`workflow_dispatch`): never after a merge
  to `main`, on a schedule, in a merge queue or for every pull request.
- A content repository (knowledge base, website) checks on Linux that every path
  can be checked out on Windows, reading the real names
  (`git -c core.quotePath=false ls-files`).
- Steps, action pins and the Bun version are the same on every system.
- A root `package.json` that delegates to the App runs `bun run --cwd app/vN check`,
  never `bun --cwd app/vN run check`: with the global flag first, Bun (1.4.2 to
  1.4.4) prints the usage of `bun run` and exits 0, so CI passes without running a
  single gate. Read the CI log once and check that the type check, Biome and the
  tests really ran.

`lazurio module create` writes the Linux workflow only
(`src/modules/templates/_bun/dot-github/workflows/check.yml.tmpl`); it does not
set `concurrency` or `timeout-minutes` yet.

## Creating a Module

A new Module is never founded by hand, and a local repository is never bound to
GitHub afterwards. `lazurio module create` is the one generator
([F52](decisions.md#f52--one-module-generator-in-the-platform-a-persons-own-modules-in-their-personalspace),
`src/modules/scaffold.ts`, `src/modules/module-create-cli.ts`):

```text
lazurio module create <Organization>/<module> --stack <stack> --teams <team,team> [--name <name>] [--port N] [--data] (--dry-run | --confirm <plan>) [--folder <Folder>] [--json]
lazurio module create personalspace/<module> --stack <stack> [--name <name>] [--port N] [--data] (--dry-run | --confirm <plan>) [--folder <Folder>] [--json]
```

- `--dry-run` checks everything a real run would and prints the plan with its
  digest; nothing is written. The agent shows the plan to the user, and only after
  they confirm it does `--confirm <plan>` create exactly that plan.
- An Organization's Module is created by the Organization Admin; until the Admin
  role in Lazurio Auth is deployed (decision 0245), an active Organization Owner on
  GitHub (its `admin`
  organization role) creates it, which gives that Owner no access to any Environment, never from a Team Environment, from a task worktree of the Organization root on
  a branch of its own. The run creates the private repository, grants Write (`push`,
  the Module Contributor) to each Team of `--teams`, places the Module in `workspace/<module>`, pushes `main`
  and declares the slot in the worktree's `modules.manifest.json`; merging the
  root's pull request is the user's Publication.
- A personal Module is a private repository `<login>/<module>` on the account
  `gh` is signed in with, its slot declared by a pull request into the
  Personalspace.
- The Module gets a lease from a free port of the pool derived from its slug, or
  `--port N`; the slug is lowercase kebab-case, at most 50 characters, and not one
  of the names Lazurio or the gateway keep for themselves.
- `--data` starts the Module's data in repository-db and its App in `app/v3`.
- The plan is the standard: `lazurio.module.json`, `app/v1/` (`app/v3/` with
  `--data`) with the stack's template, `lazurio.runtime`, `lazurio.preparation`, the lockfile, a strict
  `tsconfig.json`, Biome, `check` and `test`, `README.md`, `AGENTS.md` and the CI
  workflow. A Module outside the standard is non-conformant from its first
  commit.

## The Organization side

The Organization's manifest family is described in the
[Organization contract](organization-contract.md):

- Every Module is a slot of `modules.manifest.json`, and every slot is either
  checked out or `planned_slot`. A Module's data repository is a slot
  `workspace/<module>/db` with `materialization: "repository_db_mount"`.
- `lazurio.organization.json` declares the `module_port_pool` (100 ports,
  disjoint from every other Organization's and from 23000–23099).
- Organization-level applications (Mission Control, the design system) are
  repositories of their own with `lazurio.module.json`, never files of the
  Organization's root repository.
- A guest Module carries `home_organization` in its slot; its
  `lazurio.module.json` belongs to the home Organization, which checks its
  conformance. The host never starts it and gives it no port, lease or secret.

## Converting a Module

An agent brings an existing Module to the standard as a reviewed refactor
following a guide, never by an automatic migrator or codemod (decision
[0173](decision-register.md#0173--an-agent-does-restructuring-by-a-guide-scripts-only-add-new-things-or-take-simple-steps)).
One Module is one worktree and one pull request; a change of the Organization (a
slot, the port pool) is a separate pull request to its root, and the two link each
other. The order: the start (one process, the preparation apart), variables and
secrets, boundaries and siblings, strict TypeScript and the checks, App
generations, health, the built version. The pull request says what did not fit
before and what deliberately stays.

Verification happens in the worktree with the change: `bun install
--frozen-lockfile` and `bun run check` in every App, and the build script of a
built App. `lazurio module start` runs the primary checkout on
`main`, so a start through the Platform verifies the change only after the merge,
from a checkout that contains it. A Module created from a Lazurio template keeps
its lineage through merge commits (decision
[0174](decision-register.md#0174--a-repository-created-from-a-template-keeps-its-lineage-through-merge-commits)).
Lazurio is never changed so that a Module passes; a real gap of the standard or
of the Platform is an issue in this repository, without Organization content.

## What the Platform does not do

- It never passes the user's environment to an App (only the variables listed
  above), reads `.env`, or writes a secret to a log or a file.
- It never takes over a port: a foreign process on a declared port is
  `port-occupied`, another App of the Organization on it is `port-managed`.
- It never starts a sibling because another App calls it, and never proxies calls
  between Modules.
- It runs no build or supervisor for an App, except the build of the built
  version.
- It does not restart an App that ends. Decision 0171 describes a bounded restart
  backoff (1 s, 5 s, 30 s, then `failed`); the Platform's runners do not implement
  it (`Restart=no`).
- It does not refuse a non-conformant Module. Decision 0171 plans the refusal
  `module-nonconformant` for after the cutover, which has no date; this repository
  has no such check.

## Requirements MS-01 to MS-19

| ID | Requirement | Enforced in this repository |
| --- | --- | --- |
| `MS-01` | `lazurio.module.json` is valid; `id` is the slot's and `company` the Organization's; every lease lies in the Organization's pool; pools are disjoint | The manifest's shape: `src/modules/manifest.ts` (`tests/module-manifest.test.ts`). Identity against the slot: `src/organizations/read-applications.ts`. The pool only when a Module is created (`port_outside_pool`, `port_taken`, `pool_exhausted`, `organization-pool-invalid`: `src/modules/scaffold.ts`, `src/modules/module-create-organization.ts`). An existing lease outside the pool and overlapping pools: rule only |
| `MS-02` | Every App pins an exact, released Bun in `packageManager`; its lockfile is committed and current | A non-exact pin (`preparation-package-manager-unsupported`, `src/modules/install-authority.ts`) and an unknown or unavailable version (`runtime-*`, `src/modules/bun-runtime.ts`, `tests/module-bun-runtime.test.ts`). A missing or stale lockfile fails the frozen install (`preparation-lockfile-missing`, `preparation-install-failed`: `src/modules/frozen-install-process.ts`). A missing pin (the user's Bun runs) and whether the lockfile is committed: rule only |
| `MS-03` | `lazurio.runtime` declares listeners and health; `dev_script` and a declared `start_script` exist; required secrets are available | `src/modules/runtime.ts` (`tests/module-runtime.test.ts`); secrets: `src/modules/runtime-secrets.ts` (`tests/module-runtime-secrets.test.ts`) |
| `MS-04` | `lazurio.preparation` is declared; `check_script` exists; a Bun App writes no `runtime`; script names are not npm lifecycle names | When declared: `src/modules/preparation-declaration.ts` (`tests/preparation-declaration.test.ts`), scripts exist: `src/modules/frozen-install-process.ts`. Whether it is declared (absent means the default preparation) and lifecycle names: rule only |
| `MS-05` | `dev_script` and `start_script` start one process: no `&&`, `concurrently`, `build`, `npx`, `node`, `bunx`, `nvm` or inline `VAR=…`; `start_script` is no development server | Rule only |
| `MS-06` | No reading of `LAZURIO_RUNTIME_HOST`, `LAZURIO_RUNTIME_PORT`, `PORT`, `COMPANYASCODE_*`, a `lazurio.module.json` or a sibling's `package.json` from App sources; `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN` read only for a declared `workspace/<slug>`; no port written in the sources | Rule only. The Platform passes a sibling's origin only for a declared sibling (`src/modules/sibling-origins.ts`) and still passes the legacy variables (`src/modules/application-environment.ts`) |
| `MS-07` | No `.env*` on the start path, no `dotenv`; every `bun` call on the start path carries `--no-env-file` before its entry and never `--env-file` | The Platform's own Bun calls (install, preparation, start, build): `src/modules/frozen-install-process.ts`, `src/modules/local-application-adapters.ts`, `src/modules/built/build-process.ts`. Calls inside the Module's scripts, `.env*` files and `dotenv`: rule only |
| `MS-08` | Strict TypeScript; no `.js`, `.mjs` or `.cjs` App sources | Rule only |
| `MS-09` | No import or path outside the Module, except reading `db/` and `generated/` of a sibling declared in `required_module_slots` | `file:` dependencies outside the owner: `src/modules/local-dependency-inputs.ts`. Declared slots present: `src/modules/sibling-origins.ts` (`tests/sibling-origins.test.ts`). Imports and paths in sources: rule only |
| `MS-10` | repository-db and `@lazurio/module-kit` are pinned to released tags | Rule only. `lazurio module create` writes released tags (`src/modules/scaffold.ts`) |
| `MS-11` | No absolute paths of a computer, no symlinks created at start, no `modules/` layout | A Module, its App directories and its required slots are never read through a symlink: `src/folder/owned-directory.ts`. The rest: rule only |
| `MS-12` | `apps[]` matches the directories; at most two App generations | Only declared Apps start and a Module without `apps` does not (`explicit-apps-required`, `src/modules/manifest.ts`); overlapping App directories under the default preparation are refused (`preparation-applications-overlap`, `src/modules/preparation-binding.ts`). Undeclared packages and the number of generations: rule only |
| `MS-13` | The `check` and `test` scripts exist; `check` runs the tests, in an App with data `validate:data` as well, and the Module's CI runs `check` | Rule only. `lazurio module create` writes them, with `--data` the validation of the data too (`tests/module-scaffold.test.ts`) |
| `MS-14` | CI saves minutes: a workflow with a Windows or macOS job runs only for `pull_request` with non-empty `paths` and on `workflow_dispatch` | Rule only |
| `MS-15` | An App with an interface for people registers its tools as WebMCP tools through `registerAgentTools`, from the same server registry as `/mcp`; view tools of the page never change data; no tool completes an approval, a signature, a sending, a deletion or a person's confirmation, and a tool publishes data only with the Owner's recorded prior consent for that kind of record (`publicationConsent`) ([Tools for agents](#tools-for-agents-mcp-and-webmcp)) | Rule only |
| `MS-16` | An App's tools are defined once on its server and offered through `/mcp` and the page over the same handler; both read who came only through `appAccess`, list only what the role and the writer mode allow, and a write that publishes data is not offered in an Application unless it names the Owner's recorded prior consent for that kind of record (`publicationConsent`) ([One registry, two transports](#one-registry-two-transports), [Effects and publication](#effects-and-publication)) | Rule only |
| `MS-17` | Every tool registry answers `get_app_context` and refuses with the common reasons (`identity_unavailable`, `forbidden`, `unknown_tool`, `invalid_input`, `not_found`, `record_changed` with `current_revision`, `data_read_only`, `unavailable`, `internal_error`) ([What every App answers](#what-every-app-answers)) | Rule only |
| `MS-18` | Tools, HTTP API and interface reach the data only through the domain port `store.ts`, which decides writes by the same `dataWriter` rule as the tools, whose revision is unique per write (never content alone, never a counter) and whose implementations pass one `store-contract` including A → B → A ([One data port](#one-data-port-under-the-tools-from-appv3-to-appv4)) | Rule only |
| `MS-19` | A Module with an app is ready as an Application before it is deployed as one: a built version, Bun pinned exactly with a committed lockfile, no committed `.env*` file anywhere in the Module (`.env.example` excepted), and for an own server `@lazurio/module-kit` 0.3.0 or newer, `appAccess` on every request and a health path of its own; in V3 and V4 the writer rule; for live use CI and contract tests over the module kit's testing helpers. The release evidence the Organization's release mode needs is the rollout's | `lazurio module readiness` (`src/modules/readiness.ts`, `tests/module-readiness.test.ts`) reads it statically; the contract tests run in the Module's CI |

## GEN3

In GEN3 the Lazurio Root runs Modules with its own Launchpad and measures `MS-01`
to `MS-14` with its own command `lazurio module setup` (`MS-15` is a rule of this
page only); where it differs from the
Platform, this page describes the Platform.

## Decisions

The standard rests on decisions
[0171](decision-register.md#0171--lazurio-module-standard) (with its addenda),
[0026](decision-register.md#0026--canonical-organization-layout-and-its-single-manifest-authority),
[0031](decision-register.md#0031--organization-mounts-are-nested-repositories-classified-by-one-resolver),
[0041](decision-register.md#0041--flat-workspace-teams-as-declarations-and-productionspace),
[0137](decision-register.md#0137--lifecycle-of-applications-started-by-the-launchpad),
[0145](decision-register.md#0145--the-organization-manifest-compatibility-window-ends),
[0167](decision-register.md#0167--the-platform-launchpad-replaces-the-resident-launchpad-without-overlap),
[0173](decision-register.md#0173--an-agent-does-restructuring-by-a-guide-scripts-only-add-new-things-or-take-simple-steps),
[0174](decision-register.md#0174--a-repository-created-from-a-template-keeps-its-lineage-through-merge-commits),
[0176](decision-register.md#0176--modules-sit-side-by-side-in-workspace-an-app-reads-a-declared-sibling-only-as-slug),
[0177](decision-register.md#0177--secrets-an-app-needs-at-start-come-from-the-environment-vault-never-from-env-files),
[0195](decision-register.md#0195--an-environment-under-full-memory-slows-down-but-does-not-freeze),
[0196](decision-register.md#0196--module-data-the-environments-ceiling-narrowing-in-the-app-and-a-verified-identity-that-is-not-a-key),
[0198](decision-register.md#0198--each-environment-has-its-own-vault-managed-by-the-people-who-have-access-to-it),
[0212](decision-register.md#0212--what-is-published-on-main-is-what-lazurio-runs-as-a-build),
[0219](decision-register.md#0219--the-lazurio-root-and-the-lazurio-folder-converge-on-the-folders-mechanisms-gen3-and-gen4-are-orientation-terms),
[0249](decision-register.md#0249--module-and-application-two-terms-for-people-every-module-with-an-app-becomes-an-application-and-its-development-version-stays-in-the-environment)
and [0221](decision-register.md#0221--guest-modules-an-organization-may-host-another-organizations-module-in-its-workspace),
and on this repository's
[F8](decisions.md#f8--the-os-service-manager-owns-long-running-applications),
[F23](decisions.md#f23--the-operators-own-checkout-is-read-by-ownership-not-by-permission-bits-or-link-count),
[F24](decisions.md#f24--an-organizations-root-level-applications-are-modules-of-the-catalog),
[F25](decisions.md#f25--a-module-without-a-preparation-declaration-starts-by-a-default-preparation),
[F26](decisions.md#f26--a-started-application-gets-the-runtime-environment-of-the-replaced-launchpad),
[F34](decisions.md#f34--a-declared-preparations-start-installs-checks-and-prepares-when-the-check-fails-lazurio-module-prepare),
[F46](decisions.md#f46--runtime-secrets-declared-names-read-from-the-environment-vault-before-every-start-fail-closed),
[F52](decisions.md#f52--one-module-generator-in-the-platform-a-persons-own-modules-in-their-personalspace),
[F53](decisions.md#f53--every-environment-owns-its-vault-its-own-organization-in-the-networks-vaultwarden-created-by-its-technical-account),
[F58](decisions.md#f58--a-static-app-starts-from-main-as-its-build-each-commit-built-once-outside-the-checkout-served-by-the-platform-rebuilt-after-a-pull),
[F62](decisions.md#f62--the-bun-an-app-pins-is-its-runtime-the-users-bun-when-it-is-that-version-else-the-runtime-cache-else-a-verified-fetch),
[F67](decisions.md#f67--guest-modules-another-organizations-module-in-the-hosts-workspace-kept-current-never-run)
and [F69](decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release).

## Provenance

This text was written new for LazurioPlatform under the Elastic License 2.0 from
the Lazurio Root's manual (`manual/module-standard.md` of
`HumanAndMachines/Lazurio` at commit `66e437f7`). Since 2026-11-01 LazurioPlatform
is the standard's authority (decision 0225).
