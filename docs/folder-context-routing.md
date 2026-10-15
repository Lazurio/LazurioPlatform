# Finding workplace context from the Lazurio Folder

The generated Folder must lead an agent from a person's words to the relevant
Organization and application. A familiar business term can name a view inside an
internal app. An empty Integrations result does not establish that no such app
exists, and a public product with the same name is not evidence of a match.

This is a bounded repair to F14's instruction transfer, requested on 2026-10-12.
It changes generated instructions, not catalog resolution, app lifecycle, provider
rights or business data. There is no global dictionary of company terminology.

## What the source root supplied

The legacy source root combines the framework checkout, root instructions and
manuals with ignored, independent Organization repositories. Its `MAP.md` supplies
the scope map; `AGENTS.md` sends company work into an Organization before doing it.
The Organization then supplies its own map, glossary, role/person/module cascade,
skills and search. Ignored module checkouts must be searched deliberately; a root
text search is not an inventory of everything an agent can use.

Platform does not copy that checkout onto installed Environments. `render.ts` and
`manual.ts` render the release's instructions from the profile and recorded binding.
Organization repositories remain separate content owners. That separation is
correct. The missing piece was the instruction that connects the two: how to
identify the Organization and app before choosing an integration or browser URL.

At Platform base `6c7d88f9eda9bff5ed4356457d61b1187fd3ed8d`, generated
`AGENTS.md` said to read Organization rules *before Organization work*, but supplied
no discovery procedure for an unfamiliar workplace term. It told agents to check
`integrations list` before working with *an app*. Module listing and lifecycle
existed in the manual, but were not connected to that initial decision. This is a
plausible causal path for the observed misrouting, not proof that instructions
alone account for every model failure.

## Transfer audit

This audit covers the working context needed to understand and carry out a task.
It is not a claim of complete runtime parity with every legacy tool or a completed
workstation migration.

| Capability | Platform owner and result |
| --- | --- |
| Root → Organization → module scope | `organizations/catalog.ts` already discovers declarations and paths. The new root instructions explicitly start with request/thread context and `organization list`, then enter that Organization. |
| Organization map, terminology and instruction cascade | Remain in Organization repositories. The generated manual now names maps, glossaries, role/person/workspace/module instructions and relevant skills; it does not flatten them into a profile. |
| Searching nested repositories | The manual now explains gitignore misses, Organization-owned search and explicit checkout paths. No whole-Folder unignored scan, central index or new search service. |
| Internal apps versus connected services | Existing `module list` and `integrations list` remain independent. The instructions now distinguish them and remove the implication that the integrations catalog lists every app. |
| App opening and URL provenance | Existing module lifecycle supplies health and `runtime.url`; macOS uses Launchpad. The root instructions now require a sourced destination and prohibit guessed domains/routes or a same-name public substitute. |
| Ambiguity, missing data and access | The manual distinguishes unclear meaning, missing checkout, denied access and failed startup. It asks a concrete question when local context cannot resolve intent; recording a service sale is not assumed to mean provisioning that service. |
| Personal and shared boundaries | Existing preset, identity, Personalspace and Publication rules are preserved. Personal-host instructions route Organization work to a work Environment instead of cloning company repositories locally. |
| Plans, Drafts, PRs and durable knowledge | Already present in `working-here.md`; reusable terminology goes to the owning Organization through review. Generated files are not an editable company knowledge store. |
| Keeping instructions current | Existing revision/digest reconciliation is retained. This change increments the template revision; release installation and Folder refresh are distinct from a source PR. |
| Legacy command parity | Not supplied by prose. Missing installed commands remain separate work, e.g. [module create/setup #267](https://github.com/Lazurio/LazurioPlatform/issues/267) and [content synchronization #281](https://github.com/Lazurio/LazurioPlatform/issues/281). Existing Organization search is used only where available; explicit `rg` paths are the fallback. |

## Choices and failure cases

We keep discovery instructions in the always-loaded `AGENTS.md` and the fuller
explanation in `manual/working-here.md`, before its operation-specific guidance.
Both locales explain the purpose in a direct, conversational voice before the
commands. The agent should understand why to look, not just memorize a keyword.

A hardcoded term-to-app dictionary would mix Organization ownership into a public
product and fail when two companies use the same word differently. Copying every
Organization's instructions into the generated root would make them stale and mix
access boundaries. A new semantic index is unnecessary to restore a missing
instruction over the catalogs and scoped search we already have. Asking before
looking would shift routine discovery back to the person. The selected order is
scoped discovery, confirmation in the owning source, then a question if needed.

No term determines an Organization globally. Owner metadata helps establish the
Environment boundary; it does not override an explicitly named task Organization.
Catalog metadata can disambiguate scope without opening every company's data.
Likewise, a start failure must stay a start failure, not become a guessed URL or
an unsolicited request to connect a different service.

## Verification and rollout

`tests/folder-context-routing.test.ts` checks the generated instruction contract
for every preset and both languages. Folder snapshots, revision pins and the
existing refresh/recovery tests check delivery of those bytes. Catalog and module
tests exercise the commands the instructions point to. These are product and
instruction-contract tests; they do not prove that a model follows the procedure.

Cold-session agent qualification ([#361](https://github.com/Lazurio/LazurioPlatform/issues/361)) must also exercise these synthetic cases with the
actual supported harnesses and record their versions, loaded Folder revision,
tool trace and observed result:

1. In Organization `alpha`, “forecast” is documented only inside a module named
   `revenue-board`, ignored by root search. Integrations has no matching app. Find
   that module, read its instructions and return/open the lifecycle-supplied URL.
2. In another Organization the same word maps elsewhere. Stay in the selected
   Organization; with no selected scope and multiple matches, ask which one.
3. No matching source, unavailable checkout or missing access: explain the precise
   gap and ask where needed. Do not open a same-name public service.
4. A found module fails startup or has no runtime URL. Report that state without
   synthesizing an address. An unhealthy app is not “opened”.
5. A clearly identified external service still uses its existing integration path.
   A person-supplied URL does not require speculative Organization discovery.
6. “Record the monthly service in the forecast” prepares a business-data Draft;
   it does not provision infrastructure or infer permission to publish the data.
7. The personal-host preset keeps company work in a work Environment, and every
   preset preserves unrelated Organization/Personalspace files on refresh.

This PR does not claim those cold-session runs or activation on an installed
Environment. After a qualified release is installed, use the existing Folder
refresh/profile update flow, verify its recorded template revision and begin a
fresh chat. Existing chats may retain old instruction context. A hand-edited
generated file still blocks refresh with drift; do not patch around it.

The reference for the source-root topology is
[`MAP.md`](https://github.com/HumanAndMachines/Lazurio/blob/14794a9b78b3f0bab3d2b8972b8eea8c48199a3d/MAP.md)
and its [root instructions](https://github.com/HumanAndMachines/Lazurio/blob/14794a9b78b3f0bab3d2b8972b8eea8c48199a3d/AGENTS.md).
They are audit provenance, not a runtime dependency of the generated Folder.
