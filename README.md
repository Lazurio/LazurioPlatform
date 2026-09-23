# Lazurio Platform

**Lazurio Platform** is the public, source-available TypeScript product and codebase.
Its reviewed source produces versioned Lazurio releases; people install those releases
and do not clone the source repository for daily work.

An installed release contains CLI, Launchpad and the **Lazurio Folder Factory**. Folder
Factory is the shared component that plans, generates and reconciles Lazurio-owned paths
in the **Lazurio Folder** from a selected profile: `AGENTS.md`, the agent manual in
`manual/` shipped with the product ([decision F14](docs/decisions.md#f14--agent-manuals-live-in-the-lazurio-folder))
and the `.lazurio/` state. CLI and Launchpad use the same core;
The shared core is the local application boundary, exposed by CLI and Launchpad. The compatible installed
components together with the materialized Lazurio Folder form that Machine's **Lazurio
Environment**. Machines share a versioned environment contract and conventions/interfaces,
not a live shared directory or identical state.

Optional services operated by Human and Machine s.r.o.—Lazurio Account/Auth, Lazurio
Dashboard and managed Machine hosting—are not required for a self-hosted Lazurio
Environment. Their private integration belongs to `HumanAndMachineEmpire`, not this
public codebase.

**Status: release candidates.** `install.sh` downloads a release from GitHub Releases
over HTTPS and verifies its attestation when the GitHub CLI is available (otherwise it
says so); the installed `lazurio` verifies the attestation of every later update itself,
updates through one activation path, initializes or adopts a Lazurio Folder from the
Machine handover with a workspace preset, re-renders its generated files when Machines
rewrites that handover (`lazurio machine folder-refresh`), and runs the Launchpad. Hosted Machines still run the legacy resident beside
it until the hosted entry and content synchronization land; existing installations
remain on their current implementation until then.

- [Architecture and ownership](ARCHITECTURE.md)
- [Decisions, alternatives and required amendments](docs/decisions.md)
- [Migration, upgrade and recovery](docs/migration-and-recovery.md)
- [Build and qualification lifecycle](docs/release-cycle.md)
- [Product update contract](docs/update.md)
- [Selective Launchpad adoption and Doctor direction](docs/legacy-adoption.md)
- [Developer commands and conventions](docs/development.md)
- [Future shared marketplace](docs/marketplace.md)
- [Elastic License 2.0 and output boundaries](docs/licensing.md)
- [Profile evidence and voluntary measurement](docs/profile-evidence.md)
- [Scoped hosted advice and draft execution](docs/hosted-assistance.md)
- [Content synchronization](docs/content-sync.md)
- [Workspace presets](docs/workspace-presets.md)
- [Hosted entry: admission versus identity](docs/hosted-entry.md)
- [Acceptance and implementation slices](docs/acceptance.md)
- [Stack experiment and evidence](docs/stack-evidence.md)
- [Agent contribution contract](AGENTS.md)

The target includes local and hosted human work, Buddy and AI Colleague environments.
A hosted workspace is either private, dedicated to one Principal, or an
Organization-owned team workspace that several Principals connect to without personal
credentials; a personal environment is never shared ad hoc. OS/CPU, purpose and
collaboration preferences are separate axes; they do not create product forks.
"Update Lazurio" (product) and "Synchronize content" (Organization repositories) are
separate operations.

This repository is public from its foundation, by explicit instruction. Architecture,
decisions, code, tests and build procedures are openly reviewable. Secrets and private
personal, Organization or customer data never enter Git history, artifacts or logs.
Creating it does not transfer history from `HumanAndMachines/Lazurio`, choose a
license for reused code, redirect distribution or authorize product release.
See [provenance](docs/decisions.md#provenance-and-publication) and
[public development](docs/public-development.md).

New first-party source is available under [Elastic License 2.0](LICENSE)
(`Elastic-2.0`), a source-available license. See [scope and notices](docs/licensing.md).
