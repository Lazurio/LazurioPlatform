# Templates of a new module

The stack templates of `lazurio module create` (decision F52). The only generator
is the pure function `planModuleScaffold` in `src/modules/scaffold.ts`; this
directory is its input data, embedded in the compiled executable as text by
`src/modules/scaffold-templates.ts`.

## Provenance

Ported from HumanAndMachines/Lazurio `lazurio/templates/module/` at `a5615be0`
(root decision 0171, addendum of 2026-10-13, point 3: one generator in the
Platform). Every file is the root's byte for byte, except:

- **The `.tmpl` suffix.** Every file here ends in `.tmpl`, also where the
  root's did not (`README.md`, `package.json`, `vite.config.ts`, …), so that
  none of them is an input of this repository's TypeScript, Biome or tests,
  and each can be embedded as text. `templateTargetPath` drops the suffix, so
  the module's file names are the root's.
- **Scope placeholders** where the root's wording named an Organization:
  `{{owner_label}}`, `{{pool_label}}` and `{{module_name}}` in the stacks'
  `README.md`, in `App.tsx`, `index.astro` and the Starlight page, and
  `{{verify_command}}` in `none/README.md`. For an Organization's module they
  render the root's exact words, so its plan keeps the root's tree hash
  (`tests/module-scaffold.test.ts` holds the root's hashes at `a5615be0`).
- **`_personal/AGENTS.md.tmpl`** is new: the rules of a personal module.

Since the Organization form moved here too (decision F52's addendum of
2026-10-14), these are the only templates that change; the root's generator
retires (root decision 0171's addendum of 2026-10-13, point 3).

## Layers

A module's files are the layers overlaid in order: `_common`, then `_bun`
(stacks with a Bun app), then the stack's own directory, and for a personal
module `_personal` last; a later layer wins over the same path. The stacks are
`vite-react`, `astro`, `astro-starlight`, `bun-service`, `python-uv` and
`none`. `lazurio.module.json` is no template: the plan writes it from the lease
and the stack.

## Names

A path segment that starts with `dot-` is written with a dot (`dot-gitignore`
→ `.gitignore`, `dot-github/` → `.github/`) and the trailing `.tmpl` is dropped
(`AGENTS.md.tmpl` → `AGENTS.md`).

A module with data (`--data`) is no template either: the plan adds the
repository-db dependency to `app/v1/package.json`, `/db/` to `.gitignore` and a
section on the data to `AGENTS.md` (`withData` in `scaffold.ts`).

## Placeholders

`{{name}}` in a path and in content:

| Placeholder | Organization module | Personal module |
| --- | --- | --- |
| `slug`, `display_name`, `stack` | the module's | the module's |
| `organization` | the Organization's slug | the person's GitHub login |
| `github_org` | the Organization's GitHub login | the person's GitHub login |
| `listener_id`, `listener_env_prefix` | `app`, `LAZURIO_RUNTIME_LISTENER_APP` | same |
| `runtime_id` | `<organization>-<slug>-v1`, lowercase | `personalspace-<slug>-v1` |
| `python_package` | the slug with `_` for `-` | same |
| `port` | the lease's port | same |
| `bun_version`, `module_kit_version`, `uv_version` | the pinned versions | same |
| `owner_label` | `Organizace` | `osobního prostoru` |
| `pool_label` | `poolu Organizace` | `osobního poolu` |
| `module_name` | `<organization>/<slug>` | `personalspace/<slug>` |
| `verify_command` | `lazurio module setup <cesta k Modulu> --root <Lazurio root> --json` | `lazurio module list personalspace --json` |

An unknown name is a template error. There is no engine and no escaping, so the
plan validates the values (a display name has no `"`, `\`, `<`, `>`, `{`, `}`
or control characters).

## Standard

Every app template must pass the Lazurio Module Standard once generated (root
`manual/module-standard.md`); the port is never written into a template
(`MS-01`, chapter 4.2), the app reads it from its listener variables. Until
`lazurio module setup` reaches the Platform (#423), `tests/module-scaffold.test.ts`
checks what the Platform reads: the module manifest, each app's runtime and
preparation declarations, and that the catalog lists the module.
