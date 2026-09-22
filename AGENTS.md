# Lazurio Platform: implementation contract

This repository develops and distributes Lazurio Platform. A source checkout is not an
installed user's Lazurio Environment and must not be treated as the active installation.

Public-first is a project invariant. Keep source, architectural rationale, proposed
decisions, tests, reproducible build steps and safe evidence publicly reviewable.
Use configuration names and safe placeholders; never actual secret values, private
keys, personal/Organization/customer data, or private operational logs. Check staged
content, history and artifact contents before sharing. Follow `docs/public-development.md`.
Do not invent a secret store or hide harmless implementation details.

Read `ARCHITECTURE.md`, `docs/decisions.md`, `docs/migration-and-recovery.md` and
`docs/acceptance.md` before implementation. Read `docs/update.md`, the accepted
contract for product update, before any distribution work, and `docs/release-cycle.md`
for the build, qualification and promotion lifecycle and the two distinct test paths, `docs/profile-evidence.md` for optional measurement
and `docs/hosted-assistance.md` before any hosted advice/execution work. Read
`docs/content-sync.md`, `docs/workspace-presets.md` and `docs/hosted-entry.md` before
work on repository synchronization, presets or hosted entry; content sync and hosted
entry record accepted direction, not implemented behavior, and workspace presets
record the implemented local preset model next to the accepted typed-request
direction. This foundation is a proposal and bounded
proof, not authorization to migrate an installation, transfer a repository, publish
a release or change access. Distinguish proposed contracts from executable evidence.

Use strict TypeScript and the exact `packageManager` toolchain. CLI and Launchpad
call one application core; platform adapters own filesystem/process/provider effects.
Keep product state, profile preferences and generated instructions separately owned.
Do not create an IAM, Machine registry, second app supervisor or a writable copy of
the source as a substitute for the installed product.

Work on a review branch in an owner-scoped worktree, preserve all unrelated work,
commit only scoped changes, open a PR and report exact validation. Primary `main`
is a reference checkout. Publication requires the Principal's explicit instruction
and live provider rights. A generated profile never grants permission.

Never read or copy another Principal's Personalspace. Organization data, credentials,
deployment inventory and planning ledgers do not belong in this product repository.
Do not import legacy source wholesale: preserve license and provenance for every
deliberately reused component, and port only behavior justified by a consumer.

The proof has no install/update/profile-write/migrate command. Lazurio Folder Factory is
the shared planning/generation/reconciliation component used by CLI and Launchpad;
the shared local core owns application of configuration and desired changes through CLI or Launchpad. A source
checkout never applies them remotely. Do not quietly turn
it into one. Satisfy the relevant ownership, schema and decision prerequisites before
implementation. Isolated shared-core, Folder Factory and profile development may run
before signed distribution, as specified in `docs/acceptance.md`; installed-consumer
completion still requires all recorded acceptance gates. Installer implementation
still requires accepted distribution decisions. Test behavior and failure recovery, not source
text shape or arbitrary file-size limits. Compiling for an OS is not testing on it.

First transition acceptance requires official installation and real CLI/Launchpad on
macOS, Windows and Linux plus actual Codex and Claude Code instruction/skill use.
Do not equate compilation, prompt text or the preview proof with that acceptance.
Three parallel worktree tests isolate artifacts, process PATH, fixtures, ports and
state. They never activate the Principal's daily installation. Whole-Machine candidate
activation is a separate explicit action after integration and recovery qualification;
this design is not permission to perform it now.

Profiles must direct discovery of live identity/rights and target Organization rules,
not copy a roster. Separate expertise from proactivity and Machine from Organization
mandates. Reuse existing state owners. Measurement is opt-in and content-free; do not
claim guaranteed anonymity or upload custom instructions. Marketplace purchases and
credits do not grant access, installation authority or publication consent.
