# Development standard — proposed foundation

This standard is a reviewable recommendation, not an approved final product stack. It applies to the small executable proof now; extend it with the first real consumers. Optimize source for humans and agents to understand and change safely. Never minify source, shorten meaningful names or compress code to save prompt tokens. Distribution optimization, if later measured and adopted, happens only at build time and preserves debuggability.

## Start and navigate

Read `README.md`, `ARCHITECTURE.md` and the nearest `AGENTS.md`, then `docs/stack-evidence.md` for empirical limits. `proof/core.ts` owns the pure preview operation; `proof/main.ts` owns CLI and HTTP transport; `proof/ui.ts` consumes HTTP in the browser. `tests/` checks behavior and negative cases; `scripts/` contains development-only verification. The installed product must not depend on those developer scripts or on a Platform checkout.

Follow ownership and consumers rather than arbitrary file-size limits. Keep a behavior with its state/validation owner. Extract a module when it gives a responsibility a clear home, eliminates duplicate logic or provides a useful test boundary. Avoid generic `manager`, `utils` or `service` layers with no specific invariant. A long coherent function may merit review; line count alone is not a defect and many tiny files can make navigation worse. Prefer named inputs, explicit return contracts at public seams, readable domain names and direct control flow. CLI and UI call the same operation; transport adapters must not duplicate business decisions.

## Mechanical quality and commands

Recommend one mechanical tool: exact `@biomejs/biome` 2.5.12 for formatting, import organization and the recommended lint preset. Keep `tsc` as the semantic type checker. Biome is a development dependency, absent from the runtime executable. The version was verified from the package registry on 2026-09-08 and is locked in `bun.lock`. The exact Bun pin is 1.4.2. [Biome installation and usage](https://biomejs.dev/guides/getting-started/).

| Option | Fit for this foundation | Reconsider when |
| --- | --- | --- |
| Biome + tsc | One mechanical config and separate semantic checking; adequate for the current TypeScript proof | A concrete required rule or language integration cannot be covered cleanly |
| ESLint + Prettier + tsc | Valid alternative, but introduces two mechanical configurations and dependency surfaces for the current consumer | Actual framework/plugin rules justify the extra moving parts |
| Formatter only | Makes diffs consistent | Insufficient by itself: it does not replace lint, type checking or behavioral tests |

`biome.json` scopes automation to src/proof/scripts/tests TypeScript and the three JSON config files. It deliberately does not reformat architecture documents, instructions or other contributors' prose. Review the configuration scope when adding product source; an excluded future directory must not silently miss lint. The current HTML asset is reviewed manually. [Biome configuration reference](https://biomejs.dev/reference/configuration/).

```sh
bun install --frozen-lockfile
bun run check
```

`check` stops on the first failure and runs lint/format verification → strict typecheck → behavioral tests → public-input guard → standalone build → isolated CLI/HTTP smoke. It does not publish, install a product or activate a profile. `bun run format` applies formatting, import organization and safe mechanical fixes to the configured scope; review the diff. `bun run lint`, `bun run typecheck`, `bun test` and `bun run check:public` are available for focused iteration. Tests and build checks remain authoritative together: Bun compilation does not replace TypeScript checking.

## Comments and contracts

Comment why a choice exists, the invariant it protects, a non-obvious failure mode or a boundary the type system cannot enforce. Do not narrate each statement or repeat names in prose. Keep comments adjacent to the owning logic. A public operation should explain its inputs, side effects, rejection behavior and authority requirements where those are not obvious. Link a lasting architectural tradeoff to its decision instead of copying a second decision into comments. Temporary TODOs identify the owning issue or plan step; they are not permission to bypass safety.

Examples already present explain why the preview has no IO and why the smoke omits runtime environment variables. They do not claim that either measure creates an OS security boundary. Avoid blanketing code with comments to satisfy a numeric coverage rule.

## Tests and proposed CI acceptance

Test consumer-visible behavior and meaningful rejection/recovery paths. Do not mirror implementation statements or assert source text except for a narrowly justified static policy. Pure tests cover deterministic combinations and invalid input. The binary smoke covers source-independent execution, shared CLI/HTTP output, embedded asset delivery and no working-directory writes. It does not execute the browser or exercise real Lazurio Folder mutations.

Recommend PR CI on native macOS, Linux and Windows using the exact Bun pin and frozen lockfile; run `bun run check` on every matrix entry. Pin third-party actions to verified immutable commits, keep permissions read-only and avoid secrets in pull-request jobs. No workflow is included in this proof: native runner/action selection and provider setup require their own verified implementation. Every OS/CPU advertised as supported needs native acceptance evidence, not just successful cross-compilation or a generic OS matrix.

The first real Launchpad consumer should add Playwright for browser flows, error states and accessibility checks. Profile activation and migration additionally need native filesystem/process fixtures, interruption, dirty Git/worktree preservation, concurrent invocation and rollback tests. Coordinator profiles need actual harness evals. Coverage percentages alone do not prove these invariants. Keep fixtures synthetic and scoped; never use live organization or Personalspace data.

## Public inputs: implemented narrow guard

`bun run check:public` reads Git-tracked and untracked, non-ignored publication candidates, checking both index blobs and worktree bytes. A safe unstaged replacement cannot conceal a staged credential; safe differences remain allowed. It rejects `.env` variants, conventional secret/private/Personalspace paths, key extensions, tracked dependency/build output, non-regular files and recognizable private-key/GitHub-token patterns. It emits paths and failure categories, never matching contents. The proof's four reviewed source/asset files are enumerated; unreviewed files, imports and obvious dynamic loaders fail the narrow static check. New intentional assets require a reviewed policy update. The fixture tests demonstrate rejected names, synthetic credential signatures and an unapproved asset import.

This is not a general secret scanner: it does not inspect Git history, ignored files, dependencies, compiled binary contents, arbitrary provider token formats, encoded/fragmented values or organization confidentiality. Static TypeScript dependencies are read with Bun.Transpiler.scan, including side-effect imports, re-exports and import attributes. HTMLRewriter parses attributes independently of quoting or whitespace; only the small reviewed HTML vocabulary is allowed, so CSS, srcset, inline scripts and import maps require explicit policy expansion. Computed loading and arbitrary runtime IO are still a review boundary, not a security sandbox. The build embeds only the reviewed proof graph, and the smoke observes behavior; neither proves comprehensive absence of secrets. Review history, diffs, release inputs and artifact provenance before public release; add a maintained scanner when choosing the repository-wide release pipeline. Never treat a passing guard as permission to copy private data into this public repository.

Observed locally on 2026-09-13: mechanical checks, strict types, twenty-two tests (208 assertions), the public-input guard, standalone build and native macOS arm64 smoke passed. The Linux ARM64 artifact also passed the isolated CLI/HTTP/asset runner in a clean Ubuntu 24.04.4 guest without Bun/Node or a source checkout. The macOS arm64 proof passed the same runner in two independent macOS 26.6.2 clean clones. This is bounded proof evidence, not installer or full Launchpad qualification. Windows, other architectures and full browser flows remain unverified.

`src/folder/reconcile.ts` starts product development separately from the disposable
proof: a pure planner for the generated `AGENTS.md` file. It consumes typed inventory
and prior/desired digests, not ambient filesystem state. Unknown ownership, unsafe
paths and drift block the plan. Its tests do not prove inventory accuracy, runtime
input validation, write safety, locks, atomic generation or CLI/UI integration;
the remaining adapters and consumers still require implementation. This is not a persisted
manifest schema or a public API. Product source is included in lint and type checks.

`src/folder/inventory.ts` adds read-only POSIX inspection of that one file in an
explicit absolute directory. Its caller must validate ownership and maintain a stable
parent directory; this snapshot is not a lock or defense against parent substitution.
It rejects root symlinks, nonregular instruction files and hardlinks; IO failures
propagate rather than masquerading as absent files. Tests use synthetic temporary
directories on macOS, not personal data. Windows explicitly remains unsupported by
this adapter. Linux proof results above do not qualify this new adapter on Linux.

`src/folder/profile.ts` validates the internal composed profile input independently
of the preview proof. Execution OS, access context, purpose, locale, detail and
coordination are separate required fields. Configuration syntax is not a support
matrix, identity check or authorization grant. The four launch journey fixtures in
both languages exercise parsing only, not generated instructions, UI translation or
native runtime support. Persistence, custom-source composition and capability checks
remain subsequent consumers; do not store this internal shape as a supported schema.

`src/folder/render.ts` renders the base instruction template in Czech or English
from validated profile input. Template revision and normalized profile are included
for deterministic provenance. Tests connect rendered-content digests to reconciliation
and exercise all four launch configurations in both languages. These are text and
planning tests, not live harness adoption. Custom instruction composition, packaged
skills, CLI/UI integration and generation activation remain incomplete. The generator
does not inspect, translate or relocate Organization/Personalspace content.

`src/folder/preview.ts` is the shared read-only use case joining profile validation,
rendering, digest calculation, injected inventory and reconciliation. Invalid profile
or prior digest stops before inventory; inventory failure propagates. A real temporary
directory test proves that preview preserves instructions and unrelated user files.
Transport adapters still need to bind this operation to an explicitly validated owned
directory. Repeated-call equality is not evidence of implemented CLI/UI parity.
The preview is not authorization, a persisted transaction or a safe-to-apply token;
future application must revalidate ownership, revisions and filesystem state under
the mutation contract. No home-directory discovery or writer exists in this use case.

Development entrypoint: `bun run src/cli.ts folder-preview --folder <canonical-fixture-path>
--profile '<profile-json>' [--previous-digest <sha256>]`. Use only your own stable
synthetic fixture, not a live Lazurio Folder. The directory must be canonical, owned
by the current user and not group/world writable; symlink paths are rejected. These
checks do not protect against hostile concurrent parent-directory replacement.
The command prints a JSON preview, returns 0 for a valid proposal, 2 for a blocked
plan, and 1 for invalid input or unavailable inventory. Errors omit raw input and
private filesystem paths. No installed CLI, Windows support, mutation or UI parity
is claimed. The full local check passed with 23 tests and 217 assertions after this
entrypoint was added; this extends the earlier foundation evidence above.

Parser references verified for the regression fix: [Bun Transpiler scan](https://bun.sh/docs/runtime/transpiler) and [HTMLRewriter](https://bun.sh/docs/runtime/html-rewriter). Regression cases cover side-effect imports, re-exports, JSON/file attributes, CommonJS and dynamic imports, whitespace/unquoted HTML attributes and alternative asset forms.
