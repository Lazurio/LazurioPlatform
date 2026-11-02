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
against the whole standard yet (#423). The Platform enforces a requirement where
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
  "packageManager": "bun@1.4.2",
  "scripts": {
    "dev": "bun --no-env-file run src/server.ts",
    "check": "bun run typecheck && bun run lint",
    "check:prepared": "bun run src/prepared.ts",
    "test": "bun test"
  },
  "lazurio": {
    "runtime": { "...": "below" },
    "preparation": { "...": "below" }
  }
}
```

The App's `package.json` carries the scripts `dev`, `check` (type check and
Biome) and `test`, the run declaration `lazurio.runtime` and the preparation
`lazurio.preparation`. The Platform reads an App only through `lazurio.runtime`;
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

A new Module pins the Bun this repository pins in its own `package.json`
(`scaffoldBunVersion`, `src/modules/scaffold.ts`). Another released version is
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
| `id` | the App's id, `^[a-z0-9]+(-[a-z0-9]+)*$`; a new Module gets `<organization>-<module>-v1` in lowercase, a personal one `personalspace-<module>-v1` |
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

- The App reads the address only from this variable, once at start, and checks
  that it is an exact loopback origin (`http` or `https`, host `127.0.0.1`,
  `localhost` or `[::1]`, a port, no path); otherwise it exits 2 naming the
  variable.
- The address is for the App's server only. The App never gives it to the
  browser: no link, redirect, page data or CORS header. The browser calls the
  App, and the App calls the sibling (for example a proxy `/api/<sibling>/*`).
- A stopped or failing sibling refuses the call. The App answers its caller with
  a typed error (for example 503 "the sibling does not run in this Environment"),
  does not retry in a loop and never starts the sibling. Without the variable the
  App answers "the sibling's address was not passed" and never guesses a port.
- The call reaches the sibling directly on the Environment, without the gateway
  and without a signed-in user. When the sibling accepts writes only from its own
  origin, the caller sends `Origin` equal to the address. Who triggered the call
  is not carried; the standard does not define it yet.
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
`lazurio module create --data` sets this up ([F52, addendum of 2026-10-14](decisions.md#f52-addendum-of-2026-10-14-a-new-modules-data-starts-in-repository-db---data)).
Generated read models in `generated/` are derived and never edited by hand. A
user's edit is an unpublished change in the data checkout; publishing it is one
commit and push, a Publication.

## Stacks and quality

An App is written in strict TypeScript: no `.js`, `.mjs` or `.cjs` sources, and
framework configuration in TypeScript (`vite.config.ts`, `astro.config.ts`).
`bun run check` runs the type check and Biome; `bun test` runs the tests; the
Module's CI runs both on every pull request.

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

## App generations

- A Module keeps at most two App generations: the default one and one more,
  either the previous one kept for a return or a newer candidate that is not the
  default yet. Switching `default_app` to the candidate is the decision of the
  Organization's Steward or the user, never a conformance fix. Older generations
  are deleted; Git history keeps them.
- `apps[]` matches the directories: a package not declared in `apps[]` is not in
  the repository.
- When an App directory moves (`app/` → `app/v1/`) or a generation is deleted,
  existing checkouts keep its old build outputs (`node_modules`, `.astro`,
  `dist`, …), which no `.gitignore` covers any more, and a later update stops on
  them. The pull request that moves or deletes the directory adds those paths to
  the root `.gitignore`, and the rules stay until every checkout of the Module is
  verified clean.

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
- An Organization's Module is created by an active Owner of the Organization,
  never from a Team Environment, from a task worktree of the Organization root on
  a branch of its own. The run creates the private repository, grants Write to
  each Team of `--teams`, places the Module in `workspace/<module>`, pushes `main`
  and declares the slot in the worktree's `modules.manifest.json`; merging the
  root's pull request is the user's Publication.
- A personal Module is a private repository `<login>/<module>` on the account
  `gh` is signed in with, its slot declared by a pull request into the
  Personalspace.
- The Module gets a lease from a free port of the pool derived from its slug, or
  `--port N`; the slug is lowercase kebab-case, at most 50 characters, and not one
  of the names Lazurio or the gateway keep for themselves.
- `--data` starts the Module's data in repository-db.
- The plan is the standard: `lazurio.module.json`, `app/v1/` with the stack's
  template, `lazurio.runtime`, `lazurio.preparation`, the lockfile, a strict
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
--frozen-lockfile`, `bun run check` and `bun test` in every App, and the build
script of a built App. `lazurio module start` runs the primary checkout on
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

## Requirements MS-01 to MS-14

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
| `MS-13` | The `check` and `test` scripts exist; the Module's CI runs them | Rule only. `lazurio module create` writes both (`tests/module-scaffold.test.ts`) |
| `MS-14` | CI saves minutes: a workflow with a Windows or macOS job runs only for `pull_request` with non-empty `paths` and on `workflow_dispatch` | Rule only |

## GEN3

In GEN3 the Lazurio Root runs Modules with its own Launchpad and measures `MS-01`
to `MS-14` with its own command `lazurio module setup`; where it differs from the
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
[0219](decision-register.md#0219--the-lazurio-root-and-the-lazurio-folder-converge-on-the-folders-mechanisms-gen3-and-gen4-are-orientation-terms)
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
[F62](decisions.md#f62--the-bun-an-app-pins-is-its-runtime-the-users-bun-when-it-is-that-version-else-the-runtime-cache-else-a-verified-fetch)
and [F67](decisions.md#f67--guest-modules-another-organizations-module-in-the-hosts-workspace-kept-current-never-run).

## Provenance

This text was written new for LazurioPlatform under the Elastic License 2.0 from
the Lazurio Root's manual (`manual/module-standard.md` of
`HumanAndMachines/Lazurio` at commit `66e437f7`). Since 2026-11-01 LazurioPlatform
is the standard's authority (decision 0225).
