# Stack profiles of Lazurio Modules

**Decided by Matěj (Operator) on 2026-11-03, decision
[F69](decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release).
Current release: `2026.11`.** A stack profile names the exact tools a kind of
Module is built with and why. A Module is born in one profile release, and its
tools change only in one of two planned ways: a transition to the next App
generation or a new release of its profile. Nothing else moves them, so a
Module never has to migrate its code outside a planned step.

This page is the one public place of the profiles. The Marketplace registry
(`Lazurio/marketplace`), every template's repository and every Module that
`lazurio module create` generates refer to it. A reference names the profile
and the release, `<profile>@<release>` (for example `app-data@2026.11`), and
links the profile's section here
(`https://github.com/Lazurio/LazurioPlatform/blob/main/docs/stack-profiles.md#app-data`).
The profiles sit inside the [Lazurio Module Standard](module-standard.md): a
profile never makes an exception to it, and a conflict between the two is
resolved by changing the standard.

## The profiles

| Profile | For | App generations | `lazurio module create --stack` |
| --- | --- | --- | --- |
| [`content`](#content) | Websites, design systems, documentation, knowledge bases | `app/v1`, `app/v2`; `app/v3` with data | `astro`, `astro-starlight` (with `--data` in `app/v3`) |
| [`app`](#app) | Applications and services without a data layer of their own | `app/v1`, `app/v2` | `vite-react`, `bun-service` |
| [`app-data`](#app-data) | Applications with their records in repository-db | `app/v3` | `vite-react --data`, `bun-service --data` |
| [`app-database`](#app-database) | Applications with their records in a Dolt database | `app/v4` | none yet |

In every Module, a template or one `lazurio module create` generates, the App
generation names its data layer, not its quality (Matěj, 2026-11-03; F69,
point 8): `app/v1` and `app/v2` have no data layer of their own (in `app/v1` the
content is part of the App, in `app/v2` it lies beside it in `data/v2/` with a
declared structure), `app/v3` keeps its records in repository-db, and `app/v4` in
Dolt ([Module Standard](module-standard.md#app-generations)). A Dolt database outside the
server (for an Organization with several servers) is a different connection
setting of `app/v4`, not a generation `app/v5`: the code, the schemas and the
migrations are the same.

The rule holds for every generation created from now on. An existing Module
whose App with data lives in `app/v1` or `app/v2` keeps it there and is not
renamed; at its next planned generation transition it gets the generation of
its data layer, `app/v3` or `app/v4`, beside the old one
([Module Standard](module-standard.md#app-generations)).

`lazurio module create` therefore writes a Module without data to `app/v1`
and a Module with data (`--data`) to `app/v3`, with the data layer of
`app-data` (repository-db and Zod): a `vite-react` or `bun-service` Module
with data is born in `app-data`, and an `astro` or `astro-starlight` Module
with data stays in `content` with that data layer. Its manifest declares
`app/v3/package.json` as its only App and `default_app`, and its runtime id is
`<organization>-<module>-v3`
([Module Standard](module-standard.md#app-generations)).

`python-uv` and `none` are outside the profiles: the first has no TypeScript,
the second no App. This repository's own toolchain is not a profile either; it
keeps its pins (`package.json`) and its contracts keep JSON Schema with Ajv
([stack evidence](stack-evidence.md)).

## Common base

Every profile builds on this base.

| Tool | Exact pin | Why |
| --- | --- | --- |
| Bun: runtime, package manager, tests | `packageManager: "bun@1.4.4"` | The App's runtime ([Bun is the App's runtime](module-standard.md#bun-is-the-apps-runtime), F62). 1.4 brought `bun test --parallel`, `--changed` and `--isolate`. |
| `@types/bun` | `1.4.4` | Always the pinned Bun's own version. |
| `@biomejs/biome` | `2.6.4` | Lint and format with one tool and one configuration. |
| `@lazurio/module-kit` | `github:Lazurio/module-kit#v0.2.0` | The one runtime library Modules share (`MS-10`). |
| Tests | `bun test`, built in | The tests run on the same runtime as the App and add no dependency. |
| CI | the one Linux workflow of the standard ([CI](module-standard.md#ci)) | Unchanged. |

Rules of every profile:

- Every dependency has an exact version, never a range (`^`, `~`), and every
  App commits its `bun.lock`.
- One `biome.json`, the one `lazurio module create` writes
  (`src/modules/templates/_bun/app/v1/biome.json.tmpl`): spaces, width 100,
  the recommended preset with `noExplicitAny` as an error, `.astro` files left
  out. Biome 2.6 also formats Markdown and YAML; both stay off. repository-db
  writes the YAML in `db/` as its canonical form, its structural merge depends
  on it, and the Markdown formatter rewrote the frontmatter of a Starlight
  page in the verification below. Turning either on is a candidate for a later
  release.
- `bun run check` is the one gate: the type check, Biome and the tests, and in
  `app-data` and `app-database` `bun run validate:data`, which checks the
  records the Module's repository carries (`seed/`) against its Zod schemas
  ([Module Standard](module-standard.md#stacks-and-quality)). CI runs
  `bun run check` and nothing else beside the install. CI does not check out
  `db/`; its records are checked by `bun run validate:db` before a
  publication, and by the same schemas as the engine's parsers.

## content

Websites, design systems, documentation and knowledge bases, built statically
(`build_output: "dist"`). Generations `app/v1` and `app/v2`; a content Module
with data (`--data`) is in `app/v3` with the data layer of
[`app-data`](#app-data).

| Tool | Exact pin | Why |
| --- | --- | --- |
| `astro` | `7.4.5` | Astro 7 has the compiler in Rust and Vite 8. Astro 5 is two major versions behind, and Starlight 0.42 requires Astro 7. |
| `@astrojs/starlight` | `0.42.8` | Documentation and knowledge bases only; requires `astro ^7.2.10`. |
| `@astrojs/check` | `0.9.12` | The type check of `.astro` files. Its peer dependency is `typescript ^5 \|\| ^6`. |
| `typescript` | `6.0.3` | TypeScript 7.0 has no programmatic API yet, and `astro check` needs it; Microsoft itself asks Astro, MDX, Vue and Svelte projects to stay on 6.0. |

TypeScript 6 no longer loads every `@types/*` package by default (`types` is
`[]`), so the `tsconfig.json` names `"types": ["bun"]` for the tests.

Left out deliberately:

- **React islands.** A website or a design system does not need them. A
  template that does adds `@astrojs/react` at the React pins of [`app`](#app).
- **Tailwind.** A design system has its own tokens in CSS; a second styling
  system would be a second truth.
- **Biome on `.astro` files.** Left out until a release verifies it.

Planned release: once `@astrojs/check` supports TypeScript 7 (it waits for the
API of TypeScript 7.1), a release of `content` moves to `typescript 7.x`. The
generation does not change.

## app

Applications with an interface (Vite and React, a static build with
`static_fallback: "spa"`) and services (`Bun.serve` without a framework) that
have no data of their own. Generations `app/v1` and `app/v2`.

| Tool | Exact pin | Why |
| --- | --- | --- |
| `typescript` | `7.0.2` | The native `tsc` is several times faster, which shortens an agent's feedback loop. Nothing here needs TypeScript's API: Biome and Vite do not use it. The 6.x line gets no more minor versions, so pinning 6 would only postpone a migration. |
| `vite` | `8.3.5` | Vite 8 with Rolldown. Interface applications only. |
| `@vitejs/plugin-react` | `6.2.1` | |
| `react`, `react-dom` | `19.3.1` | |
| `@types/react`, `@types/react-dom` | `19.3.0` | |

The `tsconfig.json` of the templates names `types`, `moduleResolution:
"Bundler"` and `strict` explicitly, so TypeScript 7's changed defaults do not
change it. A `Bun.serve` server through module-kit is optional in an interface
application.

## app-data

Applications whose records live in repository-db. Generation `app/v3`. It is
[`app`](#app) plus:

| Tool | Exact pin | Why |
| --- | --- | --- |
| `@lazurio/repository-db` | `github:Lazurio/repository-db#v3.2.6` | The engine: `createSyncHost`, Draft & Publish, the Review Surface and `DraftPublishPanel` from `@lazurio/repository-db/ui`. |
| `zod` | `4.6.7` | **The one source of the shape of the data.** A Zod schema is directly the engine's `DocumentParser`, the types come from it (`z.infer`), and `z.toJSONSchema()` derives the JSON Schema (Draft 2020-12) for CI, other languages and documentation. |
| `yaml` | `2.9.1` | Only when the App reads YAML outside the engine, for an import; the engine reads and writes the records. |
| Server | `Bun.serve` and module-kit | All access to the data runs in the App's server; the interface talks only to the Module's own HTTP API. |

No hand-written data types and no second schema: JSON Schema is a generated
output (`bun run schema:export`), and once a Module has it, `check` verifies
that it is current. `lazurio module create --data` writes the dependencies,
`src/domain/collections.ts` (the collections and their Zod schemas, none yet),
`src/validate-data.ts` with its test `tests/data.test.ts`, the empty `seed/`
and the scripts `validate:data` (part of `check`) and `validate:db`, and says
this in the Module's `AGENTS.md`. It writes no store or `schema:export` yet;
those are the Module's own.

The structure that makes the transition to `app/v4` a planned step and not a
rewrite:

```text
app/v3/src/
  domain/                  # Zod schemas and pure domain logic; knows no storage
    collections.ts         # each collection's schemaVersion and record schema
  validate-data.ts         # validate:data (seed/, part of check) and validate:db (db/)
  data/
    store.ts               # the storage port: typed collections, revisions, draft status, publish
    repository-db-store.ts # its implementation over @lazurio/repository-db
  server/                  # Bun.serve and the HTTP API; calls only store.ts
  ui/                      # React; calls only the HTTP API
tests/
  store-contract.ts        # the shared test suite of the storage port
```

- `store.ts` names operations of the domain (`listPlans`, `getPlan`,
  `savePlan(id, plan, baseRevision)`, `status()`, `publish(…)`), never files.
  No YAML path or Git expression crosses it.
- A record has a stable `id` and a flat shape. Free nested maps
  (`Record<string, unknown>`) are not allowed; where one is needed, the schema
  names it. Flat records become table rows mechanically in `app/v4`.
- Draft & Publish (an unpublished change, a review, one publication with its
  author) is the contract of the interface and stays the same in `app/v4`.
- `tests/store-contract.ts` runs against repository-db in a fixture repository
  in `app/v3` and against Dolt in `app/v4`. Both implementations passing the
  same suite is what verifies the transition.

Left out deliberately:

- **JSON Schema with Ajv as the source.** It is the right choice for the
  Platform's own contracts ([stack evidence](stack-evidence.md)), but in a
  Module it gives two truths (a schema and hand-written types) or another type
  generator, and repository-db expects a Zod-style `parse()`.
- **Valibot, ArkType.** Smaller or faster, but they fit the engine's
  `DocumentParser` less directly, have no JSON Schema export in the package and
  are less known to agents. Validation runs on the server, so bundle size does
  not decide.
- **A router (TanStack Router, React Router) and TanStack Query.** The
  existing templates navigate by themselves; a router would rewrite their
  interface and gives the data layer nothing. A candidate for new templates
  with many screens.
- **React Compiler.** Under Vite 8 it needs Babel through another plugin; no
  shown benefit for internal applications.
- **Vitest.** `bun test` covers the tests, components included.

## app-database

Applications whose records live in a Dolt database. Generation `app/v4`. It is
[`app-data`](#app-data) with another implementation of `store.ts` and without
repository-db.

| Tool | Exact pin | Why |
| --- | --- | --- |
| Dolt server | `2.6.2` | Pinned by the services Environment (Prostředí služeb) of the server, not by the Module; the Module names the version it is tested with. |
| `kysely` | `0.29.8` | A typed query builder close to SQL. Dolt's procedures (`CALL DOLT_COMMIT(…)`, `dolt_checkout`, `dolt_diff`) are plain SQL through its `sql` tag, and its `Migrator` runs the migrations. |
| `mysql2` | `3.24.6` | The driver of Kysely's MySQL dialect. |
| `zod` | `4.6.7` | The same schemas as in `app/v3`; they validate the API's input and the database's rows. |

Draft & Publish carries over without changing the interface: Dolt has a working
set (the unpublished change), commits (`DOLT_COMMIT` is the publication with its
author and message), branches and diff tables (the review). This mapping is a
design to prove on a prototype, not verified behavior.

Where Dolt runs is a connection setting of `app/v4`: in the services
Environment of the Organization's server, or outside the server for an
Organization with several servers (what the Marketplace contract called `v5`).
How Lazurio gives a Module that connection without `.env` is not defined yet
([#818](https://github.com/Lazurio/LazurioPlatform/issues/818)); no template of this profile exists before
it is.

Before the first template of this profile:

- A prototype and a CI test of the template: `dolt sql-server` at the pinned
  version and `tests/store-contract.ts` against it. Neither `mysql2` nor Kysely
  is in Dolt's own client test suite, so without that test compatibility is an
  assumption.
- Revisions stay optimistic (`baseRevision`), as in `app/v3`: Dolt does not
  support `SELECT … FOR UPDATE` for fully serializable transactions.
- The current branch is session state, so a pooled connection can stay on
  another branch: one pool per branch, or a check of `active_branch()` at the
  start of each operation.
- In this profile "generation" is the App's directory (`app/v4`) and "data
  branch" is a Git branch of repository-db (`v3`); the two are never mixed up.

Left out deliberately:

- **Drizzle ORM.** Its 1.0 line is still a release candidate and changes the
  API, so a template on 0.45 would have a certain migration; its migration
  generator is untested against Dolt.
- **Prisma.** A third schema (`schema.prisma`) beside Zod and SQL, and a
  generated client.
- **`Bun.SQL`.** No dependency, but open MySQL decoding bugs and untested
  against Dolt.
- **Doltgres.** The PostgreSQL protocol would mix with Neon, which DEV-6657
  uses for other purposes.

## Left out of every profile: Vite+

Vite+ (`vp`, 1.0 since 2026-09-28, MIT) bundles Vite, Rolldown, Oxlint, Oxfmt,
Vitest and tsdown with one configuration. It is not part of any profile now:

1. **Runtime.** Vite+ supports Node.js only; Bun works with it only as a
   package manager. Lazurio runs every App with its pinned Bun, without `node`
   or `npx` on the start path (`MS-05`, F62). Tests through `vp test` would run
   on Node while the App and repository-db run on Bun.
2. **Formatter 0.x.** Oxfmt is not at 1.0, so every release of a profile could
   reformat every Module: exactly the unplanned migration the profiles exist to
   prevent.
3. **A modified Vite.** `vite-plus` installs its own core under the name `vite`,
   while Astro 7 depends on upstream `vite ^8.3.5`.
4. **Little gain.** Biome already gives lint and format in one tool, and `tsc`
   does the type check. Task caching and monorepo support serve large
   monorepos; a Module is one small repository.

Oxlint with Oxfmt is left out for the same reasons: two tools and a 0.x
formatter. Vite+ is reopened, as a release of the profiles and never as a
generation transition, once all of these hold: Vite+ supports Bun as its
runtime officially, Oxfmt is at 1.0 or later, and Lazurio supports or
deliberately allows Node beside Bun.

## How a profile changes

Exactly two kinds of change move a Module's tools.

1. **A generation transition** changes the data layer (`app/v3` → `app/v4`). The
   new `app/v<N+1>` is created beside the old one on the current release of its
   profile, a script moves the data, and `default_app` switches on the decision
   of the Module Maintainer or the user
   ([App generations](module-standard.md#app-generations)). The old generation
   stays as the way back.
2. **A profile release** changes the tools within a generation (a new major or
   minor version, a tool added or removed, a configuration change such as
   turning on a formatter). It applies to new Modules at once and reaches
   existing ones only by their own pull request.

Besides these, only a patch version with a security fix changes, inside a
release.

### Releases

- A release is named by the year and month of its decision, `YYYY.MM`. One
  release covers all four profiles; it may change only some of them, and the
  others carry over unchanged. A security patch inside a release is
  `YYYY.MM.P` (`2026.11.1`) and changes patch versions only. The Marketplace
  registry records the release each template release is built on as
  `stackProfile` (`app-data@2026.11`).
- A release is decided by the Operator and recorded as an addendum of F69,
  with the reason for each change and what an existing Module has to change.
  This page then shows the new release; the tables of every earlier release
  stay below under [Earlier releases](#earlier-releases), so that every
  reference `<profile>@<release>` keeps resolving.
- `lazurio module create` follows the current release in the same pull
  request (`stackProfilesRelease` and the templates in `src/modules/`;
  `tests/module-scaffold.test.ts` holds the exact pins).
- A template publishes the release it adopts as a new release of its own (an
  annotated tag) and records it in its README and in its registry entry. A
  Module adopted from the template takes it by merging the tag. A Module
  created by `lazurio module create` takes it by a pull request that changes
  its pins as the release's addendum says. Neither happens without that
  Module's pull request.

### Earlier releases

None yet. `2026.11` is the first release.

## Verification of release 2026.11

On 2026-11-03 on Linux x64, with Bun 1.4.4, `lazurio module create`'s plan was
written for `vite-react`, `vite-react --data`, `astro`, `astro-starlight` and
`bun-service`. In each, `bun install` and `bun run check` passed (type check,
Biome and the tests, the start contract among them), and `bun run build` passed
for the three static stacks. TypeScript 7.0.2 ran under Bun 1.4.4 and reported
a type error planted for the purpose. In the data module, a Zod 4.6.7 object
schema type-checked as repository-db 3.2.6's `DocumentParser`, and
`z.toJSONSchema` produced Draft 2020-12.

What the verification changed in the templates:

- Biome 2.6 deprecates `"recommended": true`; the templates use
  `"preset": "recommended"`.
- Biome 2.6 formats Markdown by default and inserted a blank line into the
  frontmatter of the Starlight page; the templates turn the Markdown and YAML
  formatters off.
- TypeScript 6 loads no `@types/*` by default; the Astro templates name
  `"types": ["bun"]`.

Not verified: the [`app-database`](#app-database) profile (no prototype yet),
macOS and Windows, and the existing Modules and templates, which adopt the
release in their own pull requests.
