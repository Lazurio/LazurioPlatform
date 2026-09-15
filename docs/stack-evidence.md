# Stack decision evidence — bounded feasibility proof

Status: bounded feasibility evidence recorded 2026-09-08. TypeScript/Bun and standalone terminal installation direction confirmed 2026-09-13; detailed framework and distribution mechanisms remain proposals. This is not a released product or a claim of cross-platform readiness. The consumer is a disposable profile preview in `proof/`; no installer, updater, migration, discovery, activation or identity implementation exists here.

## Decision and alternatives

Use TypeScript in strict mode, exact Bun 1.4.2 for development/build, a pure Folder Factory core shared by CLI and HTTP adapters, and one standalone executable containing the application and static UI assets as the preferred initial end-user distribution. Keep the Platform source checkout optional for end users. The pure core owns profile parsing/rendering; CLI parsing and HTTP transport do not implement another profile truth. Purpose, communication detail and coordination preferences compose independently; publication permission is never derived from them.

This is a recommendation based on the narrow consumer below. Production adoption remains contingent on native platform acceptance, release verification and recovery work described in the architecture and plan.

| Choice | Concrete benefit | Cost/failure and recommendation |
| --- | --- | --- |
| Existing source checkout | No packaging changes | Conflicts with source-independent installed product goal; preserve only as migration input and developer workflow. |
| npm package requiring external runtime | Familiar package tooling, smaller payload | End user must maintain runtime compatibility; packed asset omissions can escape source tests. Retain as a possible later developer channel, not a second initial update authority. |
| Standalone executable with embedded UI | One versioned artifact; no source checkout or installed JS runtime needed by this proof | Larger platform-specific artifacts; signing, trusted upgrades and retained versions still need design and native evidence. Preferred initial channel. |
| Separate UI service and CLI service | Independent deployment | Adds lifecycle, version skew and port ownership without a demonstrated requirement. Reject for initial product. |
| Bun HTTP plus browser platform UI | Meets this static consumer with no application dependencies | Does not prove maintainability of a rich Launchpad; use this only as a baseline. |
| React + Vite for the growing Launchpad | React provides component/state composition; Vite supplies a development/build pipeline | Strong candidate for the real interactive UI, pending a representative consumer and embedded production-asset proof. It need not add a production service: embed the static build into the same executable. Native HTML here proves distribution only and does not settle the UI choice. |
| `node:util.parseArgs` | Handles strict command options without a CLI framework | Reassess help/command tree requirements with real CLI consumers. |
| Small explicit parser | Tiny proof has three finite fields, no versioned disk data | Use only in this disposable proof. Recommend JSON Schema plus Ajv for real persisted/provider contracts, deriving TS types from that canonical contract rather than maintaining parallel types and schema. |

The parser rejects missing fields, extra fields and values outside the finite proof choices. It does not silently treat platform names as environment purpose or organization roles as communication profiles. The generated text is an in-memory value, never written as an active agent instruction.

## Reproducible evidence

Prerequisite: exact Bun 1.4.2. `package.json` pins TypeScript 5.9.3 and `@types/bun` 1.4.2; `bun.lock` records dependency resolution. TypeScript 5.9.3 is a conservative proof pin, not a claim that it is the latest release. Biome 2.5.12 is also pinned for development lint/format checks; see `docs/development.md`. There are no runtime package dependencies.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build:proof
bun run smoke:proof
```

Observed on macOS arm64 with Bun 1.4.2:

- Type check passed, including strict mode, unchecked-index and exact-optional checks. Dependency declaration checking is skipped; application source is checked.
- Two behavioral unit tests passed, 43 assertions: all 12 profile combinations render deterministically, with invalid and additional inputs rejected.
- Native standalone build passed. The smoke copied only the binary to a newly created temporary directory, omitted PATH and Bun runtime environment variables, then exercised it there.
- CLI JSON equaled HTTP `/status` JSON. The loopback server used an OS-assigned port and announced its actual URL. Embedded HTML and compiled JS were fetched successfully; missing route returned 404 and unknown CLI option failed.
- The isolated working directory still contained only the executable afterward. Smoke cleanup removes only its own temporary fixture and terminates the child server.

The smoke checks asset delivery and compiled browser code presence; it does **not** execute a browser, prove visual/accessibility quality or demonstrate a complete Launchpad. Empty-cwd execution is dependency isolation, not filesystem sandboxing or proof that the process cannot read other paths.

## Platform evidence matrix

The current official compiler documentation lists all six OS/CPU combinations below, including Windows arm64. Linux glibc and musl are separate target families. Availability of a target is not product support. [Bun executable documentation](https://bun.sh/docs/bundler/executables).

| Product candidate | Compiler target documented | Cross-compile executed here | Native execution here |
| --- | --- | --- | --- |
| macOS arm64 | `bun-darwin-arm64` | Native build passed | CLI + HTTP + embedded assets passed |
| macOS x64 | `bun-darwin-x64` | No | No |
| Linux x64 glibc | `bun-linux-x64` | No | No |
| Linux arm64 glibc | `bun-linux-arm64` | No | No |
| Windows x64 | `bun-windows-x64` | No | No |
| Windows arm64 | `bun-windows-arm64` | No | No |

All unexecuted rows remain acceptance work. CPU/OS availability does not establish minimum OS versions, libc compatibility, codesigning, antivirus acceptance, service management, filesystem semantics, symlink/reparse-point handling, locking, process termination or recovery correctness. Do not advertise those platforms as tested based on this table. Linux musl is deferred unless a real deployment consumer requires it.

## Independent counterweight and missing invariants

1. Do not introduce a workspace monorepo, service framework, plugin system, database, dependency injection layer or profile registry just to structure three small adapters. The current proof needs none of them. Decompose only when actual ownership/import boundaries justify it.
2. The proof has no stored profile truth, revision, update authority, filesystem ownership inventory or migration journal. The real implementation must establish one canonical owner for each, and test interrupted activation and recovery before any Lazurio Folder writes.
3. Loopback binding is exposure minimization, not authentication. No private state is exposed here. A real UI needs its own authenticated session, Origin/Host checks, CSRF protection for writes and capability checks before becoming an authority to mutate data.
4. Bun's standalone runtime can load `.env` and `bunfig.toml` by default. This build disables both autoload paths explicitly. The runtime also exposes `BUN_BE_BUN` and accepts `BUN_OPTIONS`; a compiled artifact does not prevent arbitrary execution or self-modification under the same OS identity. Real enforcement must sit in a separately owned OS/harness boundary. [Bun runtime configuration](https://bun.sh/docs/bundler/executables#automatic-config-loading).
5. The tiny renderer proves deterministic computation and shared consumption, not coordinator competence, delegation availability or obeyed instructions. Those require actual harness scenarios with failure, review and publication boundaries.
6. Do not couple profile updates to product replacement or Source-to-Managed migration. These are different transactional operations even if they share implementation helpers.
7. A source-independent binary still needs provenance, signing/verification, a single version selector, compatible rollback rules and explicit managed versus user-owned paths. None are supplied by bundling alone.

## Primary references checked

- [Bun HTTP server](https://bun.sh/docs/runtime/http/server): native HTTP API used by the local adapter.
- [Node `util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig): standard option parsing API exercised under Bun.
- [TypeScript strict mode](https://www.typescriptlang.org/tsconfig/strict.html): enables the strict family of source checks; transpilation/build alone is not type checking.
- [Ajv getting started](https://ajv.js.org/guide/getting-started.html): candidate validator for versioned JSON contracts; deliberately not added to this proof.

These references establish available mechanisms. Architectural recommendations and acceptance gaps above are project judgments; the native results are local empirical evidence only.

## Public-first follow-up under discussion

React + Vite, JSON Schema as single contract authority with a runtime validator, and Bun behavioral tests plus Playwright browser acceptance are explicit candidates awaiting agreement. A representative Launchpad slice should test interactive state, accessibility, failure recovery and packaged assets before accepting the UI stack. Native OS acceptance must additionally run process/filesystem/recovery scenarios; browser tests alone cannot establish those semantics. No Playwright or React/Vite consumer is implemented in this proof. The public repository must keep source, tests, builds and architecture inspectable while excluding credentials and private organization data from history and generated artifacts. The foundation includes a narrow automated public-input guard, with exact coverage and limitations documented in `docs/development.md`; a maintained comprehensive history/release scanner remains a later pipeline decision.

Official references checked: [Vite guide](https://vite.dev/guide/), [React project guidance](https://react.dev/learn/start-a-new-react-project), [Playwright introduction](https://playwright.dev/docs/intro). These document the candidate tools; choosing their product integration remains a project decision.
