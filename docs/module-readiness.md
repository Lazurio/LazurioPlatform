# A Module ready as an Application

Every Module with an app becomes an Application once it passes this check
(decision [0249](decision-register.md#0249--module-and-application-two-terms-for-people-every-module-with-an-app-becomes-an-application-and-its-development-version-stays-in-the-environment)).
This page says what "ready" means for each generation and how it is checked.
The rules themselves are the [Module Standard](module-standard.md); this page
does not add a second standard, it names which of its rules decide readiness.

## Three parts of the check

1. **Static, from the checkout:** `lazurio module readiness <absolute module
   directory> [--app <package>] [--json]`. It reads the manifests, the app's
   package, and from the tree committed at `HEAD` the files, the CI workflows
   and the app's source for markers (read from Git's objects, never through a
   symlink), without running anything and without the network, so
   an agent runs it anywhere. It reads only an app the manifest declares,
   through the start path's reader. It changes
   nothing (decision 0173): an agent fixes the findings in the Module.
2. **Contract tests in the Module's CI**, over the testing helpers of
   `@lazurio/module-kit` (`/tools/testing` and `/testing`): who came and with
   which role, the tool list by role, refusal without a role (`403
   identity_unavailable`), refusal of a write without the writer, a stale
   write ending in `record_changed`, and deep health. The static check asks
   that the Module has them; CI proves they pass.
3. **The rollout** on the application host: the release evidence the
   Organization's release mode asks for (by default a merge to `main` with
   green checks, or an approved release where the Organization switched that
   on), the deployed Application's health, and from outside its gateway's
   `401` with a `scope` on `/mcp`, its protected-resource metadata and the
   host's scope at the issuer. These need the live host and the
   Organization's rule and belong to the rollout, not to the Module.

## Verdicts

| Verdict | Means |
| --- | --- |
| `no-application` | A Module without an app (V0): there is no Application. |
| `not-ready` | A blocker: the Application cannot run from this Module. |
| `ready-for-trial` | It can run as an Application, but live use still needs something (CI, contract tests), or the evidence could not be read (Git did not list the committed files). |
| `ready-for-live` | Nothing found: people may do their real work in it. |

**Host conditions** are listed apart: what the application host must support
for this Module (a static build, sibling data, a sibling API). They are not
defects of the Module and do not lower its verdict; a rollout checks them
against the host it deploys to and refuses where the host lacks them.

## Before people see it

None of the three parts says whether a person finds their way in the
Application, and `ready-for-live` is not "done". Before an Application is
shown to people as ready, someone walks through it as a person who sees it for
the first time, on its real data (the agent with the `ui-craft` skill, then
the people who decide):
- within a few seconds it is clear what the page holds and what to do;
- the main action is found without searching;
- long lists and long texts have an order, a filter and a clear first step;
- it works on a phone.

What does not pass is reported with screenshots as not ready, whatever the
verdict says. A larger rebuild of the interface is shown first as a prototype
on real data, before it is built.

## What "ready" means per generation

Every generation with an app needs: a valid manifest and app declaration as
the start path reads them; a built version (`start_script` or
`build_output`); Bun pinned exactly with a committed `bun.lock`; no committed
`.env*` file anywhere in the Module (`.env.example` excepted); and, for live
use, CI on the Module. A release tag is not a requirement of the Module: the
rollout asks for the evidence the Organization's release mode needs.

- **V0, no app.** Nothing to deploy; the verdict is `no-application`.
- **V1, content is part of the app** (a reference app such as a design
  system). Usually a static build: the host condition `static-app` until the
  application host serves static Applications. An own server additionally
  needs `@lazurio/module-kit` 0.3.0 or newer, `appAccess` on every request and
  a health path of its own (not `/`).
- **V2, content beside the app** (a knowledge base, a website). As V1. The
  content is changed only by a pull request to the Module; the Application
  never writes it.
- **V3, repository-db.** An own server is required (`data-without-server` otherwise): all access to the data, `/mcp` and the page tools run in it, and it serves the built interface. The server has module-kit, `appAccess` and deep
  health (503 until the data are open), and the writer rule below. Contract
  tests for live use. A declared sibling's data (`workspace/<slug>/db`) is the
  host condition `data-sibling`; a sibling's API is `api-sibling`. The
  Application reads from a sibling only the contract the sibling documents with
  a version, never its internal files, and says so plainly when the replica is
  missing.
- **V4, a database in Server Services.** As V3, over the same data port
  (`store`). The development version uses a local database with preview data
  and never a grant to the Application's database. A migration deployed
  automatically only expands the schema; one that drops or narrows goes only
  through an approved release with a restore from backup as the way back.

## The writer rule

On the application host the Application always gets
`LAZURIO_RUNTIME_DATA_WRITER`: with `true` it writes; with `false` or any other
value it neither writes, pulls nor publishes. What an App may do without the variable, in a development
version in an Environment, is open and decided by the Owner (Module Standard,
Applications of an Organization): variant A (recommended) lets only the entries
`local` and `environment` and the data sync host (at start, in the background
and after their requests) write there, while a request from `app` only reads,
and a runtime stating `LAZURIO_RUNTIME_DEPLOYMENT=production` (#1041) never
writes without `true`;
variant B writes nothing without the variable until the Platform passes `true`
to the writing Environment (#1034). Either way the App must read the variable,
so the static check looks for it (or module-kit's `dataWriter`) in a V3 or V4
app's source, and the contract tests prove the cases of the chosen variant.

## Limits of the static check

It reads markers, not behaviour: a source that names `appAccess` or the writer
variable is not proof that every route uses them, which the contract tests and
review hold. The generation comes from the data layer the app depends on and
otherwise from its directory `app/v<N>/`. Without Git the committed files and
the source markers are unknown, which it reports instead of passing them. Source is read up to 1 MiB per file
and 4 MiB in total; a marker found counts, and a marker missing while some
committed source was not read is reported as `source-incomplete`, never as
absent. It keeps the level of what is unknown: a blocker when `appAccess` or the
writer rule is unknown, live evidence when only the contract tests are. It
does not read secrets, the vault, deployed hosts or GitHub.
