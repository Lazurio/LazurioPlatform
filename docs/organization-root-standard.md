# Organization Root Standard

This page defines what the repository of an Organization's root holds, which
files Lazurio manages in it, and how the root checks itself. It is the
standard for every Organization root of GEN4 and for the template it is created
from (`OrganizationTemplate_GEN4`). This repository is its authority, as for the
[Module Standard](module-standard.md) and the
[organization contract](organization-contract.md) (decision
[0225](decision-register.md#0225--gen3-and-gen4-are-official-designations-gen3-stays-maintained-and-transitional)).
It applies the move of Organization roots to new `<Organization>_GEN4`
repositories of decision
[0251](decision-register.md#0251--organization-roots-move-to-new-organization_gen4-repositories-without-backward-compatibility).

The three documents divide the work:

- the **organization contract** defines the manifests `lazurio.organization.json`
  and `modules.manifest.json`, their schema and their readers;
- the **Module Standard** defines a Module, its Apps, and the tools and CI a
  Module is checked with; a root borrows those tools and that CI;
- **this standard** defines the root repository around the manifests: what lies
  in it, what Lazurio writes into it and how it proves that it is a root.

A root has no App, no runtime, no generations and no data. Nothing from the
Module Standard about starting, health, data or tools for agents applies to it.

**How a requirement is enforced.** For an Organization root (`kind:
"organization"`), `lazurio organization check` resolves the root as every reader
of this repository does and fails when the root does not run
(`src/organizations/check-cli.ts`). A template (`kind: "template"`) never runs;
see [The template](#the-template). A requirement marked **rule only** has no
check in this repository yet: the root's own contract check (shipped with the
template, `OR-09`) and the root's review hold it.

## What a root is

An Organization root is the repository that declares itself the root in its
Organization manifest: `root_repository` and `forge_binding` in
`lazurio.organization.json` name it. The name of the repository and the name of
the directory it is checked out in are not its identity. A root is found and
accepted by its declaration (`declaresRoot`, `src/content/organization-root.ts`,
which accepts only `kind: "organization"`). A GEN4 root is a repository named
`<Organization>_GEN4` (0251); until an Environment's folder is renamed during
the move, its checkout may still sit in a directory named `<Organization>_GEN3`,
and it is the same root.

## Repository layout

| Path | Holds | Who writes it |
| --- | --- | --- |
| `lazurio.organization.json` | The Organization manifest ([organization contract](organization-contract.md)) | Lazurio (`lazurio organization create`, `lazurio module create`, Settings) and reviewed pull requests |
| `modules.manifest.json` | The repository slots, the port pool | Lazurio and reviewed pull requests |
| `AGENTS.md` | The Organization's rules for agents: managed blocks from the template and the Organization's own blocks | Template (managed blocks), the Organization (own blocks) |
| `CLAUDE.md` | One line, `@AGENTS.md` | Template |
| `README.md`, `MAP.md`, `GLOSSARY.md` | Orientation, map and terms of the Organization | The Organization, started from the template |
| `.agents/skills/` | The Organization's skills; the only source of skills | Template (managed skills), the Organization (own skills) |
| `company/colleagues/<user>/` | Overlays for colleagues | The Organization |
| `docs/decisions/` | Decisions about the Organization itself | The Organization |
| `manual/` | The Organization's own procedures | The Organization |
| `workspace/`, `productionspace/` | Mount points of the slots; only a `README.md` is committed | Template |
| `package.json`, `bun.lock`, `tsconfig.json`, `biome.json`, `scripts/*.ts` | The root's checks | Template (managed) |
| `.github/workflows/check.yml` | The root's CI | Template (managed) |
| `.gitignore`, `.gitattributes`, `.editorconfig` | Repository settings | Template (managed) |
| `lazurio.template.json` | Which template release the managed files come from | Template |

Nothing else belongs to a root. In particular a root has no:

- `company.gen3.json`, `compatibility` block or projection digest (decision
  [0145](decision-register.md#0145--the-organization-manifest-compatibility-window-ends));
- root task ledgers (`TODO.tasks.json`, `DONE.tasks.json`, `ISSUES.*.json`) or
  snapshots of them: tasks live in the Organization's Mission Control data and
  open problems in GitHub Issues;
- generated views of the manifests (`generated/`): readers read the manifests;
- integration catalogue (`.mcp.json`, `.codex/config.toml`): integrations are
  `settings.integrations` in the Organization manifest and the Environment's
  Executor (decision
  [0162](decision-register.md#0162--integrations-applications-connected-to-an-environment-one-path-each));
- committed `.claude/skills`: it is an ignored link to `.agents/skills` that
  Lazurio creates on the Environment;
- application code, a Launchpad, a design system or data: those are Modules in
  their own repositories, declared as slots;
- code, tests or text that exist only for GEN2 or GEN3.

## Managed files

The template names, in `lazurio.template.json`, every file it manages and the
release they come from. A managed file is the same in every root of that
release; the Organization does not edit it. `AGENTS.md` is managed by blocks:
each managed block is marked with its name and the template release, and
everything outside the marks belongs to the Organization and is never
overwritten.

Managed files reach a root as a pull request:

- a new root receives them when it is created (`lazurio organization create`);
- an existing root receives a new template release as an ordinary reviewed
  pull request that rewrites only the managed files and the managed blocks of
  `AGENTS.md` and updates `lazurio.template.json` (decision
  [0251](decision-register.md#0251--organization-roots-move-to-new-organization_gen4-repositories-without-backward-compatibility),
  which replaces
  [0174](decision-register.md#0174--a-repository-created-from-a-template-keeps-its-lineage-through-merge-commits)
  for Organization roots). The pull request carries no merge commit of the
  template and the root has no `template` remote; the release is a published
  GitHub Release of the template, and its commit is named in the pull request.

## Stacks and quality

A root's checks are written in strict TypeScript and run on Bun, with the same
tools as a Module: the exact Bun of its stack profile in `packageManager`, a
committed `bun.lock`, TypeScript strict with `noUncheckedIndexedAccess`, Biome
with `--error-on-warnings` and `bun test`, all behind one gate `bun run check`.
The rules are those of [Stacks and quality](module-standard.md#stacks-and-quality)
and `MS-02`, `MS-08` and `MS-13` of the [Module Standard](module-standard.md#requirements);
this standard does not repeat them. Of `MS-11` only the first part applies: no
absolute path of a computer. A dependency of the root's checks is pinned to an
exact released version. A root has no `.js`, `.mjs` or `.cjs` file.

A root carries as little code as possible. Its scripts are only:

- the task doctor and the pull request preflight its `AGENTS.md` asks agents to
  run (`bun run doctor:task`, `bun run pr:preflight`), until the Platform offers
  them as commands;
- its own contract check (`OR-09`).

A check that the Platform performs (the manifests, the root's resolution, the
declaration) is not reimplemented in the root.

## CI

A root's CI follows [CI](module-standard.md#ci) of the Module Standard (`MS-14`):
one Linux workflow on every pull request and every push to `main`, with
`concurrency` and `timeout-minutes`. It runs:

1. `bun install --frozen-lockfile`;
2. `bun run check`;
3. the pinned Lazurio CLI, installed by the release's `install.sh` with an exact
   `LAZURIO_VERSION`, and `lazurio organization check --json`: the root must
   run;
4. the root's contract check against `GITHUB_REPOSITORY`: the repository the CI
   runs in is the one the manifest declares as the root.

The task doctor and the preflight also run on people's computers, so the root
has the second workflow that [CI](module-standard.md#ci) and decision 0171
require of a repository created from a template: Windows and macOS run the same
gate only for pull requests that change the scripts, the tests, the toolchain or
a workflow (`pull_request.paths`), and on request (`workflow_dispatch`).

## Requirements OR-01 to OR-12

| Requirement | Text | Enforced by |
| --- | --- | --- |
| `OR-01` | An Organization root: `lazurio organization check` resolves it as running | `src/organizations/check-cli.ts` (`tests/organization-check.test.ts`) |
| `OR-02` | An Organization root: the manifest declares it; `root_repository` and `forge_binding` name this repository; it is never identified by the suffix of its name or by its directory | `declaresRoot`, `src/content/organization-root.ts`; in CI the root's contract check (`OR-09`) |
| `OR-03` | Only `lazurio.organization.json` and `modules.manifest.json` describe the Organization; no `company.gen3.json`, no `compatibility`, no projection digest | Rule only; the root's contract check |
| `OR-04` | No root task ledgers, snapshots of them or generated views | Rule only; the root's contract check |
| `OR-05` | No integration catalogue in the root; integrations are `settings.integrations` and the Executor | Rule only; the root's contract check |
| `OR-06` | `.agents/skills/` is the only source of skills; `.claude/skills` is ignored and never committed; `CLAUDE.md` is `@AGENTS.md` | Rule only; the root's contract check |
| `OR-07` | `lazurio.template.json` names the template release and every managed file; managed files match that release; managed blocks of `AGENTS.md` are marked | Rule only; the root's contract check |
| `OR-08` | Strict TypeScript on Bun with one gate `bun run check` (the rules of `MS-02`, `MS-08` and `MS-13`); dependencies pinned to exact released versions; no absolute path of a computer (the first part of `MS-11`); no `.js`, `.mjs` or `.cjs` | Rule only; the root's CI |
| `OR-09` | The root's contract check exists, comes from the template and runs in `bun run check` | Rule only |
| `OR-10` | CI as in [CI](#ci): Linux, frozen install, `bun run check`, the pinned Lazurio CLI and `lazurio organization check`, the declaration against `GITHUB_REPOSITORY`; Windows and macOS for changes of code, toolchain or workflows and on request (0171, `MS-14`) | Rule only |
| `OR-11` | No code, test or text that exists only for GEN2 or GEN3: `git grep -n -i -E 'gen2\|gen3'` on `HEAD` finds nothing but deliberate exceptions: the guest Module folder that the slot contract names (`src/organizations/repository-slots.ts`), the name of a predecessor repository during a move, and quotations in historical records | Rule only; the root's contract check reports it, as an error in managed files and in its strict mode |
| `OR-12` | A template release reaches the root only as a reviewed pull request of its managed files and blocks, from a published release, without a merge commit of the template or a `template` remote (0251) | Rule only |

## The template

`OrganizationTemplate_GEN4` satisfies the requirements of this standard that
describe the repository (`OR-03` to `OR-12`). It is a template, not a running
root: its Organization manifest has `kind: "template"`, an unverified binding
with placeholders, and the standard slots
(`knowledgebase`, `mission-control`, `mission-control/db`, `design-system`,
`infra`) as planned slots. Its releases are tagged; a root names the release it
follows. The Modules behind the standard slots come from the released
templates of the Marketplace, as every Module does
([Creating a Module](module-standard.md#creating-a-module)). `OR-01` and `OR-02`
apply to the root created from it, once its manifest names the Organization and
its repository.

## GEN3 roots

A GEN3 root (`<Organization>_GEN3`, with `company.gen3.json` and the scripts of
`OrganizationTemplate_GEN3`) does not satisfy this standard and is not changed to
satisfy it. By decision 0251 it is replaced by a new GEN4 root that carries its
history and, in one pull request, its canonical manifests without the
compatibility block and the managed files of the GEN4 template. The move of an
Organization begins only after the gate of 0251, which is the finalization gate
of [0145](decision-register.md#0145--the-organization-manifest-compatibility-window-ends)
for a root that moves: every mutation-capable reader and supported Machine that
can reach the Organization (this Platform, the Root's Core where it still runs,
the Dashboard, Lazurio Machines) no longer requires the projection and accepts
the new name. Until then the Platform keeps reading the GEN3 root as it does
today.
