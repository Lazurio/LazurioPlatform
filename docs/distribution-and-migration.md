# Distribution through npm, operator-driven update and migration from the root repository

Status: **shaping for a decision by the Principal (2026-09-28). Nothing here is
implemented or approved.** It answers the Principal's direction of 2026-09-27/28:
a Lazurio npm package, operators updating Lazurio themselves on every VM, a prepared
agent migration from the legacy root repository (`HumanAndMachines/Lazurio`) to the
Lazurio Folder, and the archive of that repository.

Citations name a file and line of this repository at `3926999` unless another
repository is named. "Root" means the legacy root repository checkout at the time of
writing; "Machines" means the Machines repository at `b5de591`. Statements marked
**unverified** could not be checked against code, documentation or a native run.

## Recommendation in one page

1. **npm is the front door, not a second channel.** Publish one small package
   `lazurio` (npm organization `lazurio`). It has no dependencies and no install
   scripts. On first use it downloads the release from GitHub, verifies its artifact
   attestation with the product's own verifier (F13) and runs `lazurio install`.
   After that it only hands over to the installed product. First install:
   `npx --yes lazurio@<version> install`. Update: `lazurio update`. There is exactly
   one updater. The launcher is published by the existing protected release workflow
   with the product's version. (Section B.)
2. **On VMs, updating Lazurio becomes the operator's step.** Machines keeps
   installing the first version and repairing a broken one. It stops choosing the
   version. The version floor already makes an older pin harmless: Machines records
   `ahead` and never downgrades. Three things change: the generated manual stops
   forbidding `lazurio update`, `lazurio install` creates `~/.local/bin/lazurio`, and
   the product tells the operator when the Folder needs `folder-refresh` after an
   update. VMs do not need the npm package. (Section C.)
3. **Migration is three renames and one command.** Rename the old checkout aside.
   Create the Folder at the same path `<home>/Lazurio`. Move `organizations/`,
   `personalspace/` and `drafts/` back into it by rename. Adopt them with a new
   workstation mode of `folder-init`. Every repository and worktree keeps its
   absolute path. Nothing is copied or deleted, and going back is the same renames in
   reverse. An agent runs it from a prepared prompt. (Section D.)
4. **The archive waits for gaps, not for heroics.** Before the archive the Platform
   needs: workstation adoption, the PATH entry, multi-Organization discovery, a
   session-free module CLI, a doctor, skills and the Claude Code entry, a worktree
   mechanism and desktop packaging. It also needs Windows, or your decision to leave
   Windows users on a frozen checkout. Organization materialization and content sync
   are needed for new Machines, not for migrating existing ones. (Section E.)
5. **Repair forward holds.** Organization and Personalspace data never changes, and
   the legacy tree is the checkpoint. The real limits: npm publications cannot be
   undone, an agent cannot repair its own harness, only maintainers can fix the
   product, and Windows cannot run the product at all today. (Section F.)

Proposed order: S2 and S3 (operator updates on VMs) first. They are independent of npm
and of the migration. Then the npm launcher and workstation adoption. Then a macOS
canary on the Principal's own workstation. The daily-work gaps come in parallel.
Windows and the archive come last. Ten questions are in G2.

## A. What exists today

### A1. Release and trust (F13)

| Fact | Source |
| --- | --- |
| A protected tag `v*` starts `release.yml`; only the origin repository publishes | `.github/workflows/release.yml:17-19`, `:36` |
| Built targets: `linux-x64`, `linux-arm64`, `darwin-arm64`, each on a runner of its own target. No Windows, no Intel macOS | `release.yml:84-89` |
| One Sigstore attestation (`actions/attest`) over `manifest.json` and every binary; the bundle is the release asset `lazurio.sigstore.json` | `release.yml:155-166` |
| Publishing needs the protected environment `release` (required reviewer), runs in one queue, refuses a final version not above every published one, then publishes once | `release.yml:120-126`, `:186-207` |
| The file name `release.yml` is permanent: every client checks the attestation against it | `release.yml:10-12`; `docs/update.md:79-81` |
| Published releases `v0.1.0` … `v0.1.6` (latest, 2026-09-26). Asset sizes of `v0.1.6`: `darwin-arm64` 63 MB, `linux-*` 82 MB | observed with `gh release list/view` on 2026-09-28 |

The installed client verifies the attestation itself with the `sigstore` library:
issuer, workflow identity at the exact tag, repository and owner IDs, source commit,
and the digests of manifest and artifact (`docs/update.md:114-128`). A cold trust
cache during a Sigstore outage blocks the update and never weakens it (`:127-128`).

### A2. First installation: `install.sh`

- POSIX only. Accepts `Linux-x86_64`, `Linux-aarch64|arm64` and `Darwin-arm64`; every
  other platform fails (`install.sh:25-30`).
- Reads the tag from the first redirect of `releases/latest`, or takes
  `LAZURIO_VERSION` (`install.sh:46-61`).
- Checks the binary against the manifest digest (`install.sh:71-80`). Runs
  `gh attestation verify` against `release.yml` at the tag **only when `gh` is
  present**; without `gh` it prints "NOT verified beyond HTTPS" and continues
  (`install.sh:82-97`).
- Runs the downloaded binary's `install` with the caller's arguments
  (`install.sh:99-101`).

### A3. `lazurio install` and the install base

- The running executable copies itself to `versions/<v>/lazurio` and points the
  symlink `bin/lazurio` at it (`src/update/install.ts:204-224`, `:262`;
  `src/update/layout.ts:28-43`).
- Install base: macOS `~/Library/Application Support/Lazurio`, Linux
  `${XDG_DATA_HOME:-~/.local/share}/lazurio`; **no other OS has one**
  (`src/update/base.ts:8-21`). The CLI refuses with "no per-user install base on this
  platform" (`src/update/cli.ts:114-119`).
- It never edits shell profiles. It returns the directory to put on PATH
  (`install.ts:142`; `cli.ts:45-52`). Nothing in the Platform creates
  `~/.local/bin/lazurio`, although root decision 0161 point 6 names that path as the
  standard entry (root `manual/decision-register.md:97`).
- `--service systemd-user --folder <F>` writes and enables
  `lazurio-launchpad.service` and `lazurio-rollback.service` on Linux only
  (`install.ts:192-202`, `:324-339`). A unit of that name that the installer did not
  write is refused (`install.ts:160-171`).
- Run from a **newer** executable over an existing installation, `install` is the
  **offline update**: reconcile a marker, stage, self-check, switch, raise the
  high-water mark. A lower version is refused `release-invalid` / `below-floor`
  (`install.ts:265-315`; `docs/update.md:186-210`).

### A4. `lazurio update`: floor, high-water, supervised or not

- One command for CLI and Launchpad; no second updater (`docs/update.md:38-40`).
- **Floor** = max(active version, durable high-water mark). No network path installs
  below it, not even after a rollback (`docs/update.md:49-52`, `:130-139`).
  `update rollback` goes below the floor locally and never lowers the mark
  (`:276-281`).
- **Supervised** means the installer wrote `lazurio-launchpad.service`. Then the
  update restarts that unit, waits up to 30 s for health, and commits or undoes
  (`docs/update.md:176-184`, `:224-232`). **Unsupervised** (macOS, no unit, or a
  foreign unit such as the Machines resident's) means the selector switch is the
  commit and a running Launchpad reports that a restart finishes the update
  (`:224-226`; `src/update/update.ts:310`).
- Exact tags (`--version vX.Y.Z-rc.N`) are the only canary mechanism; there are no
  channels (`docs/update.md:130-139`).
- Deliberately narrow: `linux-x64` and `darwin-arm64` supported, `linux-arm64` built
  for qualification; **no Windows** (`docs/update.md:327-332`;
  `src/update/identity.ts:18-22`).
- A product update never re-renders the Folder. A newer template revision reaches the
  Folder only through `machine folder-refresh` or a profile change (decision F14,
  `docs/decisions.md:669-703`).

### A5. What Machines does on a VM today

All from Machines (roles under `workloads/workspace-vm/ansible/roles/`).

| Step | Behavior | Machines source |
| --- | --- | --- |
| Pin | Per guest in the owner overlay of the Organization's infra repository: `resident_bootstrap.artifacts.platform {version, source_commit, target, sha256, size}` plus `platform_attestation`. Observed pins: 0.1.4 and 0.1.5 | `workspace-vm/README.md:408-417`; overlay schema `owner-overlay.v1.schema.json:703-797` |
| Bytes | Custody transfer from the runner, never a download on the VM | `README.md:419-424`; `workspace_platform/tasks/main.yml:40-50` |
| Trust | Exact sha256 and size; `gh attestation verify --bundle`; if `gh` is missing or the trust root is unreachable the check is **skipped** and the pinned digest remains the authority | `tasks/main.yml:52-73`; `tasks/attestation.yml:2-44` |
| Install | `<staged>/lazurio install --base ~/.local/share/lazurio --json`, no `--service`, never `lazurio update` | `tasks/install.yml:4-8`, `:38-50`, `:87-94` |
| Newer operator version | Kept. The pin below the floor is a finding `ahead`, never a failure or a retry | `install.yml:70-85`, `:116-157`; `tasks/main.yml:208-213` |
| Folder | `lazurio machine folder-init` when absent, `machine folder-refresh` after every apply (from 0.1.3) | `tasks/folder.yml:15-24`; `tasks/refresh.yml`; `defaults/main.yml:56` |
| Launchpad | The **resident** (legacy root) Launchpad runs as `lazurio-launchpad.service` under Bun; the Platform installs no unit | `workspace_services` `resident-services.mjs:48-87`; `workspace_platform/tasks/main.yml:5-8` |
| npm | npm is a wrapper in `~/.local/bin`; the global prefix is `~/.local`, so `npm i -g` works without sudo and writes into `~/.local/bin` | `workspace_tools/tasks/npm.yml:2-7`; `README.md:198` |
| PATH entry for `lazurio` | **None found.** No role creates `~/.local/bin/lazurio` | search of Machines at `b5de591`; the Folder manual names the fallback `~/.local/share/lazurio/bin/lazurio` (`src/folder/manual.ts:668`) |
| OS | Debian family only; Platform pin must be `linux-x64` | `apply.yml:16`; `tasks/main.yml:19-20` |

### A6. What the generated manual tells agents on hosted Machines

The text is Platform product content, not Machines content (`src/folder/manual.ts:641-672`):

- "Do not run `lazurio update`, `lazurio update rollback` or `lazurio install` here.
  A product version you install yourself falls outside the pin …" (`manual.ts:651-652`).
- `update status` is allowed, outdated product is reported to the Principal, "the
  Machines operator updates the pin" (`manual.ts:655-660`).
- The workstation branch of the same function already describes the operator's own
  `lazurio update`, `--check`, `status`, `rollback` and the pill (`manual.ts:673-700`).

### A7. What does not exist in the Platform yet

- No Windows target, install base or lock (`src/update/base.ts:16`;
  `src/folder/native-lock.ts:7-8` throws "Unqualified lock platform" outside macOS and
  Linux).
- No `lazurio doctor`, although F17 and root 0161 describe a "`lazurio doctor` and
  `lazurio tools status` readback" (`docs/decisions.md:951-953`); no `doctor` command
  exists under `src/` (search at `3926999`). Doctor is an accepted direction only
  (`docs/legacy-adoption.md:35-55`).
- No content synchronization or Organization materialization (`docs/content-sync.md:3-6`).
- No workstation adoption of an existing directory: `folder-init` requires an
  **absent** Folder path on a workstation (`src/cli.ts` help text; 
  `src/folder/initialize-folder.ts:131-134`); only the hosted `machine folder-init`
  adopts an existing layout.
- The Launchpad reads one explicit `--organization-directory`, not every Organization
  under `organizations/` (`src/launchpad/server.ts:61-78`; `src/cli.ts` help text).
- The Platform Launchpad does not yet replace the resident one on VMs (F15,
  `docs/decisions.md:754-783`; hosted entry adapter implemented, canary switch pending,
  `docs/hosted-entry.md:3-8`).

## B. npm package: options and recommendation

**Recommendation: option 2, a thin launcher.** The npm package `lazurio` holds no
product bytes. It is the front door for the **first installation** and an optional
PATH entry. GitHub Releases stay the only product channel (F13), and `lazurio update`
stays the only updater. The npm organization `lazurio` owns the name.

### B1. Options compared

| | (1) Per-platform binaries as optional dependencies (Biome pattern) | (2) Thin launcher downloads the attested release (**recommended**) | (3) JS/TS source run by Bun or Node | (4) No npm; `install.sh` + `lazurio update` |
| --- | --- | --- | --- | --- |
| Operator types | `npm i -g lazurio` | `npx --yes lazurio@<v> install` (or `npm i -g lazurio && lazurio install`) | `npm i -g lazurio` | `curl … install.sh \| sh` |
| Prerequisite | Node + npm, for every invocation through the JS shim | Node + npm for the first install only; the product needs neither | Exact Bun: the core uses `bun:ffi` for locks (`src/platform/flock.ts:1`, `src/folder/native-lock.ts:1`) | `curl`, `sha256sum`/`shasum`; `gh` for real verification |
| Trust chain | npm provenance over each **tarball**; the binary inside is covered only if also attested and checked separately | npm provenance over the launcher tarball; the launcher checks the product's F13 attestation with the product's own verifier; later updates as today | npm provenance over source; no F13 at all | HTTPS + manifest digest; F13 only when `gh` is present (`install.sh:82-97`) |
| Updaters | **Two**: `npm update -g` replaces bytes outside floor, self-check and supervised activation, unless the launcher turns every new package into an offline update at an arbitrary later invocation | **One** (`lazurio update`). A newer launcher only prints a notice | **Two**, and none of F13 | One |
| Windows | Works once a Windows binary exists; bin must be a JS shim, because npm links only the top-level package's bins | Same; launcher refuses `target-unsupported` today | Would need Windows Bun + FFI port | No POSIX shell; needs an `install.ps1` |
| Offline / air-gapped | Works from a mirrored tarball | Needs GitHub for the first install; offline stays `lazurio install --base` from a staged binary (A3), as Machines does | Mirrored tarball | Staged binary + `install --base` |
| Supply chain | No lifecycle scripts needed; ~5 packages per release; `--omit=optional` breaks it | One package, no dependencies, no lifecycle scripts | Full dependency tree installed on every Machine | No npm exposure |
| Size | 63–82 MB unpacked per platform package (A1); registry limit undocumented | One bundled JS file; small (exact size **unverified** until built; it bundles the Sigstore verifier) | Source + dependencies | none |
| Effort | Medium: packaging of 4+ packages, launcher, reconciliation with the install base | Small–medium: one launcher entry reusing `src/update/*`, one publish job, name claim | Medium, and contradicts the product's no-runtime rule (`docs/environment-tools.md:133`; `docs/release-cycle.md:87-89`) | None |

Why not (1): it creates a second version truth (npm's) and a second copy of every
binary, and it puts Node in front of the repair tool. Why not (3): it is the legacy
root's model (`bun link`, D2) with the fragility the Principal wants
gone. (4) remains the path for Machines, air-gapped Machines and anyone without Node.

### B2. npm facts this rests on (checked 2026-09-28)

| Fact | Source |
| --- | --- |
| Provenance links a package to its source repository and workflow; needs a cloud-hosted runner (GitHub Actions or GitLab), `id-token: write`, a public `repository` | https://docs.npmjs.com/generating-provenance-statements |
| Provenance attests the **tarball** (`pkg:npm/…`, SHA-512), not files inside it | live attestation of `@esbuild/linux-x64@0.28.2` at `registry.npmjs.org/-/npm/v1/attestations/…` |
| Consumers check with `npm audit signatures`; `npm install` does not refuse a package without provenance (an absence in the docs, not an explicit statement) | https://docs.npmjs.com/viewing-package-provenance |
| Trusted publishing (OIDC, no token) needs npm ≥ 11.5.1, Node ≥ 22.14, GitHub-hosted runners; provenance is automatic; tokens can be disallowed while trusted publishers keep working | https://docs.npmjs.com/trusted-publishers |
| Whether a trusted publisher can be configured before the package exists: **unverified**; third-party guides publish a placeholder first. The root runbook assumes the same (root `manual/npm-cli-release.md:47-66`) | — |
| `os`, `cpu`, `libc` (`libc` only with `os: linux`) select optional dependencies | https://docs.npmjs.com/cli/v11/configuring-npm/package-json |
| npm 12 (2026-07-08) **blocks dependency lifecycle scripts by default**; pnpm 10+ and Bun do too | https://docs.npmjs.com/cli/v12/using-npm/changelog/ ; https://pnpm.io/blog/releases/11.0 ; https://bun.sh/docs/pm/lifecycle |
| pnpm 11 defaults `minimumReleaseAge` to one day: a fresh release is not installable through pnpm for a day | https://pnpm.io/blog/releases/11.0 |
| Biome ships a Node-shebang launcher and per-platform optional dependencies with **no** lifecycle scripts; esbuild keeps a `postinstall` fallback | Biome and esbuild `package.json` on GitHub |
| On Windows `npm i -g` writes `.cmd`, `.ps1` and sh shims per bin | https://github.com/npm/cmd-shim |
| Scoped packages publish private by default (`--access public`); a free organization has unlimited public packages; reserving a name without publishing is squatting under the disputes policy | https://docs.npmjs.com/creating-and-publishing-scoped-public-packages ; https://docs.npmjs.com/creating-an-organization ; https://docs.npmjs.com/policies/disputes |
| `npx` assumes `--yes` without a TTY in npm 12 | https://docs.npmjs.com/cli/v12/commands/npm-exec |
| `lazurio` is unpublished and the npm scope `lazurio` does not exist (`npm view lazurio` 404; `npm org ls lazurio` "Scope not found") | observed 2026-09-28 |
| `Lazurio/LazurioPlatform` is public, so provenance and free Sigstore attestations apply | `gh api repos/Lazurio/LazurioPlatform` on 2026-09-28 |

### B3. The recommended package

**Name.** Unscoped `lazurio`, owned by a new npm organization `lazurio` (which also
reserves `@lazurio/*`). The root runbook already planned this name for the legacy CLI
package `@lazurio/runtime` (root `manual/npm-cli-release.md:15-24`); that plan must be
withdrawn so the name carries only the Platform.

**Behavior of the launcher** (one bundled JS file, `#!/usr/bin/env node`, no
dependencies, no lifecycle scripts):

1. If the per-user install base has a working selector, exec it with all arguments
   and pass the exit status through. The launcher is then only a PATH entry.
2. Otherwise accept only `install [arguments of lazurio install]`, `--version` and
   `help`. Download `manifest.json`, the target binary and `lazurio.sigstore.json` of
   the tag equal to the launcher's own version (or `--release <tag>`), verify them with
   the **same** code as the product (`src/update/attestation.ts`, compiled-in origin
   and IDs), then run `<binary> install <arguments>`.
3. Never activate anything else. When the launcher is newer than the active product it
   prints one line: "Lazurio X.Y.Z is available: run `lazurio update`."
4. An unsupported target (Windows, Intel macOS today) ends `target-unsupported` before
   any download.

**Publishing.** One more job in `release.yml` after "Publish once", in the same
protected `release` environment: `npm publish --access public` through trusted
publishing, dist-tag `latest` for a final release and `next` for a prerelease. The
launcher's version equals the release version, so `lazurio@0.2.0` always bootstraps
exactly 0.2.0. The first publish of the name is a one-time manual step by the release
operator (unverified whether it can be avoided, B2).

**Exact commands.**

| Situation | Command |
| --- | --- |
| First install, macOS / Linux workstation | `npx --yes lazurio@<version> install` |
| Optional global entry | `npm install -g lazurio` |
| Update | `lazurio update` (or the Launchpad pill) |
| Version and floor | `lazurio update status --json` |
| Hosted VM | nothing from npm: Machines installs, the operator runs `lazurio update` (C) |
| Air-gapped | release assets copied in, `./lazurio-<target> install` (A3) |
| Verify the launcher | `npm audit signatures` in a scratch project that depends on `lazurio@<version>` |

**On VMs the npm package is not installed.** The global prefix there is `~/.local`
(A5), so `npm i -g lazurio` would write `~/.local/bin/lazurio`, the same entry the
product should own (C1). A Node-based shim would also put the operator's Node in front
of the repair tool. Whether npm refuses to overwrite an existing non-npm
`~/.local/bin/lazurio` or replaces it is **unverified**.

## C. Operator-driven update versus the Machines pin

**Recommendation: treat the installed Lazurio exactly like the operator's tools under
0161.** The baseline delivers the first installation and repairs a broken one. The
version then belongs to the operator, who runs `lazurio update`. The pin stops being
the owner of the product version and becomes the **repair version**.

Most of the mechanics already fit. The floor makes an old pin harmless: Machines
already records `ahead` and never downgrades (A5). The change is mostly text, one role
behavior and one missing PATH entry.

### C1. What changes and what stays

| Concern | Today | Proposed |
| --- | --- | --- |
| Who selects the product version on a VM | The Machines pin (`manual.ts:646-647`) | The operator, through `lazurio update` or the pill |
| What the pin means | Target version, moved by a pin bump (`workspace-vm/README.md:530-535`) | Repair version: installed when absent, or when the selector is missing or the active binary fails its self-check. Never moves a working installation |
| Forward push by rollout | Possible and normal | Not by default. Optional, only on the Principal's explicit decision for one release (question Q4) |
| Provider baseline in 0161 (1) | Includes "the installed release of LazurioPlatform" (root `decision-register.md:97`) | Includes "**an** installed, working release"; the version moves to the operator side, like tools in 0161 (2) |
| Attestation on the VM | Custody + `gh attestation verify`, skipped without `gh` (A5) | Unchanged for the repair path. Operator updates verify inside the product (F13) |
| Floor and high-water | Product-owned | Unchanged. It is what makes mixed fleets safe |
| Folder re-render after an update | Machines runs `folder-refresh` after every apply | The operator's update must be followed by `lazurio machine folder-refresh`, or new manuals never arrive (F14 forbids re-render inside activation, `decisions.md:698-703`). See C3 |
| `~/.local/bin/lazurio` | Absent | Created by `lazurio install` as a relative symlink to `bin/lazurio` (0161 point 6); Machines only verifies it |

### C2. Mixed versions across VMs

- **Different VMs, different versions.** Nothing couples VMs. Each Folder records its
  own `templateRevision` and is re-rendered by its own binary. A VM ahead of the pin
  reports `ahead` in Machines readback (A5), which is a fact, not drift.
- **Repair after the operator moved ahead.** The pin is below the floor, so
  `install --base` refuses and changes nothing (`install.ts:280-289`). The repair tier
  "binary broken" is covered by the high-water rule for a damaged selector: a pin
  **at or above** the mark repairs, a lower one is refused (`install.ts:230-244`;
  `docs/update.md:203-208`). **Gap:** a VM whose operator went ahead of the pin and
  then broke the selector cannot be repaired by the rollout until the pin is raised to
  at least the high-water mark. Recommended fix: Machines reads the mark with
  `update status --json` (it already does, `install.yml:125-157`) and, in repair mode,
  stages the release equal to the mark. That needs the release bytes in custody, or a
  network download on the VM through the product's own verified path (question Q5).
- **Rollback below a newer Folder.** An operator `update rollback` below the release
  that rendered the Folder leaves `template-upgrade-required` until the newer release
  is active again (`decisions.md:691-695`). A rollback below a release that wrote new
  Folder state fails its self-check and ends `rollback-unavailable` (F18,
  `decisions.md:1036-1055`). Both are safe: nothing is rewritten.

### C3. The Folder template revision

Today a new release reaches `AGENTS.md` and `manual/` only because Machines runs
`folder-refresh` after its apply. With operator updates:

- **Recommended:** `lazurio update` keeps its contract (it never writes the Folder).
  Its result and the pill name the next step when the Folder's recorded
  `templateRevision` is older than the active product's: "run
  `lazurio machine folder-refresh`" on a hosted Machine, "apply the profile
  unchanged" on a workstation. The Launchpad shows one button that runs it through the
  existing change path. This keeps F9 and F14 intact.
- Rejected: chaining the refresh inside `update`. It is the "second writer" F14
  rejected (`decisions.md:698-703`).

### C4. What the Launchpad shows

- Today on VMs the resident Launchpad runs, not the Platform one (A5), so the pill is
  not visible there. The operator uses the CLI until F15 lands.
- After F15 the pill is the same as on a workstation: available version, release
  notes, one action (`docs/update.md:283-294`). On a VM with the Platform unit
  installed by the product, the update is supervised and rolls back on failed health.
- Proposed addition: when the Folder's template revision is behind, the pill's
  success state carries the refresh action (C3).
- On `hosted-organization-team` the update affects every Principal sharing the
  account. The pill should say so before the click (question Q6).

### C5. Texts and code that would change

| Owner | Change |
| --- | --- |
| Platform `src/folder/manual.ts:641-672` | Hosted "Updates on this Machine": drop "Do not run `lazurio update` …" (`:651-652`) and "the Machines operator updates the pin" (`:659-660`); say the operator updates Lazurio with `lazurio update` on instruction, the rollout only repairs; keep the tool rules. New template revision (`base-instructions-9`), so every Folder re-renders on its next refresh |
| Platform `src/folder/manual.ts:162-163` | "the Machines operator's pin selects the product release" → "Machines installs and repairs; the operator updates" |
| Platform `src/update/install.ts` | Create or verify `~/.local/bin/lazurio` (C1); report it in the result |
| Platform `src/update/update.ts`, Launchpad pill | Report "Folder refresh needed" after an activation (C3) |
| Platform `docs/update.md:315-320` | "Observed" section: Machines readback observes, it does not own |
| Platform F17 text (`decisions.md:900-902`) | Platform moves from baseline-with-pin to baseline-first-install, operator-version |
| Root decision 0161 (`decision-register.md:97`) | Amendment: the Platform release joins the operator side for its version |
| Machines `workspace_platform` | Repair mode (install when absent or broken, never push forward by default); verify the PATH link; keep `ahead` as a fact; README "a pin bump and one ordinary apply" (`workspace-vm/README.md:530-535`) becomes the repair rule |
| Machines owner overlays | The pin's meaning changes; the fields do not |

## D. Migration from the root repository to the Lazurio Folder

**Recommendation: rename the old checkout aside, keep every working path.** The
root checkout `<home>/Lazurio` is renamed to `<home>/Lazurio.legacy-<date>`. A new
Folder is created at `<home>/Lazurio`. The directories `organizations/`,
`personalspace/` and `drafts/` are moved back into it by rename. Every Organization
repository, worktree, Personalspace and draft ends at **the same absolute path as
before**. So Git's absolute worktree links stay valid and no content is copied. Going
back is the same renames in reverse.

### D1. Topologies considered

| Topology | Assessment |
| --- | --- |
| In-place conversion (retire root files and `.git` inside `<home>/Lazurio`), selected earlier in `docs/migration-and-recovery.md:500-524` | Root and Folder both own `AGENTS.md` and `manual/`, so tracked root files must move aside anyway. Needs a workstation adoption command that does not exist. Going back means restoring files one by one. Rejected in this form |
| New Folder at a new path, repositories moved there | Every absolute path changes: linked worktrees break (`git worktree repair` everywhere), tool configs, agent histories and the `Conglomerate` aliases point at the old place. Rejected |
| **Rename aside, new Folder at the old path, mounts moved back** | Three directory renames on one filesystem plus one Platform command. No Git repair for Organization repositories. Going back is three renames. The legacy tree stays whole as recovery evidence. **Recommended** (question Q7, because it amends the earlier note) |

### D2. Inventory of the root checkout and its fate

Derived from the root checkout at `12497f46` (root `.gitignore`, `package.json`,
`lazurio/`, `launchpad/`, `scripts/`). Line numbers are the root's.

| What the user has | Where it is today | New world | Fate | Proof of success |
| --- | --- | --- | --- | --- |
| Root Git checkout: `AGENTS.md`, `ARCHITECTURE.md`, `MAP.md`, `manual/`, `guide/`, `launchpad/`, `lazurio/`, `scripts/`, `templates/`, `bridge/`, `distribution/`, `provisioning/`, launchers | tracked in `<home>/Lazurio` | Platform binary + generated Folder `AGENTS.md` and `manual/` (F14) | **Stays** in `Lazurio.legacy-<date>` as recovery evidence; deleted only on a later explicit instruction | Legacy `git status`, unpushed branches and stashes listed in the migration report |
| Organizations: nested repositories `organizations/<Org>/` with their modules, productionspace repos, worktrees, repository-db mounts, recovery stashes | gitignored (`.gitignore:98-99`) | `<home>/Lazurio/organizations/` (F16) | **Moves** as one directory by rename; contents never entered | Per repository: HEAD, `status --porcelain`, `stash list`, `worktree list` identical before and after |
| `personalspace/` | gitignored (`.gitignore:92-93`) | `<home>/Lazurio/personalspace/` | **Moves** as one directory by rename; never listed or read | Same device and inode before and after (`stat`), nothing more |
| `drafts/` (may hold clones with their own worktrees) | gitignored (`.gitignore:120`) | a workstation Folder keeps the operator's own top-level entries (`src/cli.ts` help text) | **Moves** by rename | `worktree list` of each clone unchanged |
| `launchpad.gen3.json` | tracked | none (F15) | **Dropped** (stays in legacy) | — |
| `launchpad.gen3.local.json`: `personalspace_owner`, `update_channel`, optional `planned_organizations` | gitignored (`.gitignore:29`; example `launchpad.gen3.local.example.json:2-12`) | owner and planned slots → Folder preferences under the environment-configuration owner (F15 point 2), **not implemented**; `update_channel` is read by no code and has no successor (F13) | **Re-created** when the preference exists; until then dropped | Folder preferences show the owner |
| Legacy Launchpad per-root state `launchpad/runtime`, `launchpad/logs` | gitignored (`.gitignore:49-51`) | Platform application state under the service manager (F8) | **Dropped** with legacy | — |
| Legacy Launchpad server state: `server.json`, `server-lifetime-*.lock` | OS state dir (`lazurio/core/server-locator-lib.mjs:10-43`): macOS `~/Library/Application Support/Lazurio`, Linux `~/.local/state/lazurio`, Windows `%LOCALAPPDATA%\Lazurio` | On macOS this is **the same directory as the Platform install base** (A3); the Platform tolerates unknown entries (`docs/update.md:163`) | **Stays** until the legacy Launchpad is gone, then removed by exact name | `lazurio update status` healthy with the entries present |
| Legacy `lazurio` CLI (`@lazurio/runtime`, `bin: cli.mjs`) linked with `bun link` into `~/.bun/bin/lazurio` | `lazurio/package.json:2-33`; `lazurio/cli-install-lib.mjs:256-259` | `~/.local/bin/lazurio` → Platform selector (C1) | **Unlinked last**, after proof; the name collides, and legacy `lazurio update` means content sync while Platform `lazurio update` means product update | `command -v lazurio` is `~/.local/bin/lazurio`; `lazurio --version --json` names origin `Lazurio/LazurioPlatform` |
| Root worktrees `.worktrees/root/*` with sidecars, `.worktrees/sweep`, `.worktrees/recovery` | gitignored (`.gitignore:123`) | none; root development ends with the archive | **Stay** with legacy; `git -C <legacy> worktree repair` keeps them usable there | Unpushed work listed and confirmed with the Principal before the rename |
| Root recovery stashes `lazurio-update:*` | root `refs/stash` (`lazurio-update-lib.mjs:1277-1297`) | none | **Stay** in legacy; never applied or dropped by the migration | Listed in the report |
| Root skills `.agents/skills` (`admin-pr-sweep`, `lazurio-workstation-install`, `worktree-development-discipline`) and the `.claude/skills` mirror | tracked; manifest `.agents/skills/manifest.json` | Folder manual (worktree discipline extracted, F14); skill generation into the Folder (F16) not built | **Dropped** from the migrated Machine; gap E | — |
| Organization skills and agent rules | inside each Organization repository | unchanged | **Move** with the Organization | — |
| Root manuals `manual/` and the Guide (`guide/`, Astro course) | tracked | Folder `manual/` (six files); the rest see E | **Stay** in legacy and in the archived repository | — |
| `.cache/lazurio/qmd` search index, `.hermes/`, `dist/` | untracked / excluded | no successor for legacy `lazurio search` | **Stay** in legacy | — |
| macOS app `~/Applications/Lazurio Launchpad.app` (its `root-path` names `<home>/Lazurio` and runs `Launchpad.command`) | `scripts/install-launchpad-macos.sh:8,219-336` | desktop packaging of the Platform Launchpad, **not built** | **Renamed aside**: after the migration it would start a file that no longer exists | The old app no longer launches the legacy tree |
| Windows Start Menu `Lazurio Launchpad.lnk` | `Install-LaunchpadShortcut.ps1:396-404` | same gap | **Renamed aside** | — |
| Compatibility aliases `<home>/Conglomerate`, `<home>/Conglomerate_GEN3` → `<home>/Lazurio` | home | kept as aliases (`docs/migration-and-recovery.md:60-64`) | **Stay**; they resolve to the new Folder because the path is unchanged | `readlink` unchanged |
| Other home entries that link into the tree (for example a tool config linked into Personalspace) | home | unchanged paths | **Stay**; the agent lists them by `readlink` only, without following | Links still resolve |
| Sign-ins and settings: `gh auth`, SSH keys, Git config, Codex and Claude config, MCP configs (per Organization, inside Organization repos), Composio | outside the root, or inside Organization repos | unchanged (F17: only the tool's own installer writes its home) | **Never touched** | `gh auth status`; `git ls-remote` of one Organization root |
| Agent histories and memory keyed by the working directory path | harness-owned | unchanged because the Folder keeps `<home>/Lazurio` (observed on one Machine; **unverified** as a harness contract) | **Never touched** | — |
| Toolchain (Git, `gh`, Node, Bun, Codex, Claude Code) | operator's PATH | operator's tools (F17) | **Never touched**; Bun is no longer needed by Lazurio itself, only by modules | `lazurio tools status` |
| Running legacy Launchpad and its session applications | processes | Platform Launchpad (`lazurio launchpad --folder`) | **Stopped** before the rename | No listener on the legacy port; no process with a working directory inside the tree |

Observed on one founder workstation, to size the real case: fifteen Organization
mounts, more than twenty registered root worktrees, more than two hundred local root
branches and several `lazurio-update:*` recovery stashes. The migration must list, not
clean, all of it.

### D3. Structure of the agent's migration manual

One manual with a shared core and three platform sections. It lives in the Platform
(`docs/` and a `lazurio migration prompt` output), because F14 makes the Platform the
authority; the root repository carries only a pointer to it before the archive.

**Preconditions (all platforms).**

1. The Principal's explicit instruction in the thread.
2. A supported target: `darwin-arm64`, `linux-x64` or `linux-arm64` (A4). Intel macOS
   and Windows stop here today.
3. A Platform release with workstation adoption (E, slice S5).
4. `gh auth status` succeeds; the legacy tree is on one filesystem with `<home>`
   (same device for `<home>/Lazurio` and `<home>`).
5. No merge, rebase, cherry-pick or `am` in progress in the root or any Organization
   repository; no `.lazurio/` already in `<home>/Lazurio`.
6. The agent runs with its working directory **outside** `<home>/Lazurio` (for example
   `<home>`), so the rename does not move its own shell.

**Ordered steps (all platforms).**

| # | Step | Check before the next step |
| --- | --- | --- |
| 0 | Read-only inventory: root HEAD, branches, stashes, worktrees with unpushed commits; per Organization repository HEAD, status, stash and worktree list; home links into the tree; running legacy processes. Write it as a JSON report outside the tree | The Principal confirms unpushed root work |
| 1 | Install the Platform: `npx --yes lazurio@<version> install` (or `install.sh`). Use `<install base>/bin/lazurio` by absolute path until step 8, because the legacy CLI may still be first on PATH | `--version --json` names the Platform origin; `update status` healthy |
| 2 | Quiesce: stop the legacy Launchpad and its applications; close editors and terminals inside the tree | No listener, no process with a working directory inside the tree |
| 3 | `mv <home>/Lazurio <home>/Lazurio.legacy-<date>` (one rename; it is also the lock against a second migration) | Legacy path exists; `<home>/Lazurio` absent |
| 4 | `mkdir <home>/Lazurio`; rename `organizations`, `personalspace`, `drafts` from legacy into it | Each moved directory has the same device and inode |
| 5 | `lazurio folder-init --folder <home>/Lazurio --adopt <profile choices>` (new, E): adopts `organizations/` and `personalspace/` without entering them, keeps `drafts/` | `.lazurio/`, `AGENTS.md`, `manual/` present; revision 1 |
| 6 | Parity: repeat the inventory of step 0 for Organization repositories; `git -C <legacy> worktree repair` for root worktrees | Identical to step 0 |
| 7 | Smoke: start the Platform Launchpad for one Organization; start a new agent in `<home>/Lazurio` and have it state which `AGENTS.md` it read | Launchpad reachable; agent names the Folder instructions |
| 8 | Switch the command: unlink the legacy CLI; ensure `~/.local/bin/lazurio` and its PATH entry | `command -v lazurio` and `--version --json` as in D2 |
| 9 | Rename the legacy desktop launcher aside | — |
| 10 | Report: what moved, what stayed, what is next. The legacy tree stays | — |

**Never touched:** contents of Organization repositories and Personalspace; sign-ins,
keys, tokens and tool configs; the operator's tools and their versions; any Git
history (no fetch, pull, reset, stash, clean, branch deletion or push); the legacy
tree except its root worktree links in step 6.

**Stop conditions:** any failed check in the table; another process holding the tree;
a different filesystem; an unknown state of `<home>/Lazurio` (neither the root checkout
nor a finished Folder); `target-unsupported`, `trust-unavailable` or any Platform
refusal; a root worktree with unpushed work the Principal has not confirmed. On stop
the agent reports the exact step and the state from D5 and does nothing else.

**Going back** (before or after step 10, as long as the new Folder holds no new work):
stop the Platform Launchpad; rename `organizations`, `personalspace`, `drafts` back
into the legacy tree; rename `<home>/Lazurio` to `<home>/Lazurio.failed-<date>`;
rename the legacy tree back to `<home>/Lazurio`; relink the legacy CLI
(`lazurio cli install` from the legacy checkout); rename the desktop launcher back.
The installed Platform can stay; it touches nothing outside its install base.

### D4. Platform differences

| | macOS localhost | Linux VM | Windows localhost |
| --- | --- | --- | --- |
| Case | Root Git checkout, legacy CLI through `bun link`, `.app` launcher | (a) Machines-delivered VM: the Folder already exists; the legacy part is the resident runtime and `launchpad.gen3*.json`. (b) A Linux Machine with a root Git checkout | Root Git checkout, Start Menu shortcut |
| Who migrates | Agent with the prompt below | (a) **Machines**, in the F15 release that switches `lazurio-launchpad.service` to the Platform, removes the resident and stops writing `launchpad.gen3*.json` (`docs/decisions.md:765-779`); the agent only verifies. (b) Agent, as macOS | Agent, **blocked** until a Windows target exists (E) |
| Install | `npx lazurio@<v> install` or `install.sh` | (a) Machines custody (A5). (b) `install.sh` or npx | — |
| Specifics | Install base shares its directory with the legacy server state (D2); PATH entry `~/.local/bin` may be missing from the login shell and is added only with the operator's consent (root decision 0140) | (b) legacy Buddy bridge or resident units running from the checkout (`bridge/run.ts:1-5`) are a stop condition and go to the hosted Buddy manual | Directory rename fails while any handle is open (terminals, editors, Explorer, antivirus scans); symlinks need privileges, so compatibility aliases are junctions; long paths; `%LOCALAPPDATA%\Lazurio` is both the legacy server state and the planned install base (`docs/release-cycle.md:98-100`) |
| Verification | D3 step 6–8 | (a) one listener on the Launchpad port, run by the Platform selector; no `launchpad.gen3*.json`; `~/.local/bin/lazurio` present | as macOS, natively |

### D5. Partial states, recognized from disk alone

| `<home>/Lazurio` | `Lazurio.legacy-*` | Meaning | Next action |
| --- | --- | --- | --- |
| Root checkout (`.git`, no `.lazurio`) | absent | Not started or stopped before step 3 | Start or stop cleanly |
| absent | present | Stopped between steps 3 and 4 | Continue at step 4, or rename back |
| Directory without `.lazurio`, some mounts moved | present | Stopped in step 4 | Finish moving, or move back |
| `.lazurio` with a pending initialization journal | present | Stopped in step 5 | `lazurio folder-resume --folder <home>/Lazurio` (existing recovery, `docs/machine-handover.md:329-336`) |
| Finished Folder | present | Steps 6–10 | Continue verification |

### D6. The prepared prompt

In the style of `toolPrompt` (`src/tools/catalog.ts:316-349`): task, first read the
real state, target state, what never happens, stop rule. Rendered in `cs` and `en` by
`lazurio migration prompt`. English text:

> Task: migrate this computer from the legacy Lazurio root checkout at
> `<home>/Lazurio` to a Lazurio Folder at the same path, following the Lazurio
> migration manual for this operating system.
>
> First read the actual state and change nothing: run the read-only inventory from
> step 0 of the manual, show me the report, and list every root worktree or branch
> with work that exists only on this computer. Start only after I confirm, and work
> with your working directory outside `<home>/Lazurio`.
>
> Target state: the Lazurio command on PATH is the installed Lazurio Platform;
> `<home>/Lazurio` is a Lazurio Folder; every Organization repository, Personalspace
> and draft is at the same path as before with the same Git state; the old checkout
> is kept, unchanged, at `<home>/Lazurio.legacy-<date>`.
>
> Never: read or list anything inside `personalspace/`; change the content or Git
> state of any Organization repository (no fetch, pull, reset, stash, clean, branch
> deletion or push); copy instead of rename; delete anything; touch sign-ins, keys,
> tokens or tool configuration; update or reinstall a tool that works; put a secret
> into chat, Git or a log.
>
> After every step run its check. If a check fails or the state is not one the manual
> names, stop, tell me the step and the exact state, and work around nothing. I decide
> whether to continue or go back.

## E. What must exist before the root repository can be archived

Archiving on GitHub makes the repository read-only. Its code can still be cloned and
fetched, and it can be unarchived
(https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories).
So the archive does not break a legacy checkout that has not migrated yet. It freezes
it: no fixes. The real gate is therefore "nobody needs a fix to the legacy tree any
more", not "every Machine has migrated".

Sizes: S = days, M = one to two weeks, L = more, for one agent with review. All sizes
are rough estimates.

### E1. Needed for the migration itself

| Capability in the root | Platform equivalent | Needed? | Home | Size |
| --- | --- | --- | --- | --- |
| Adoption of an existing directory on a workstation | Only hosted `machine folder-init` adopts; workstation `folder-init` requires an absent path (A7) | Yes | Platform: `folder-init --adopt` reusing the hosted adoption rules | S–M |
| A command on PATH | `install` returns a directory only (A3) | Yes | Platform: `~/.local/bin/lazurio` (C1) | S |
| npm front door | none | Yes (Principal) | Platform (B3) | S–M |
| Read-only migration inventory and prompt | `legacy-paths-inspect` covers three macOS path names only (`docs/migration-and-recovery.md:40-58`) | Yes | Platform: `lazurio migration inspect` + `migration prompt` | M |
| Windows install and Folder | none: no install base, no lock, no release target (A7) | For Windows users | Platform | L |
| Intel macOS | not built (`release.yml:84-89`) | Only if such users exist (**unknown**) | Platform: one build target + native qualification | S–M |

### E2. Needed for daily work after the migration

| Capability in the root | Platform equivalent | Needed? | Home | Size |
| --- | --- | --- | --- | --- |
| Launchpad over **all** Organizations (auto-discovery, root decision 0042) | one `--organization-directory` (A7) | Yes | Platform | M |
| Organizations in `legacy` or `transition` manifest state | Platform reads canonical `lazurio.organization.json` + inventory only (`src/cli.ts` help, "no GEN3 fallback"; F12) | Yes | **Each Organization repository** (decision 0145), not the Platform | per Organization, **unknown** |
| `lazurio organization install` (clone an Organization and its nested repos, repository-db mounts) | none (A7) | For new Machines, not for migration | Platform: content synchronization (F9, `docs/content-sync.md`) | L |
| Legacy `lazurio update` (ff-only sync of root, Organizations, nested repos) | none | Yes, but agents can use plain `git pull --ff-only` meanwhile, as the Folder manual already says (`docs/decisions.md:729-731`) | Platform: content synchronization | L (same work) |
| `lazurio doctor`, `doctor:task` | none; F17 already names a `lazurio doctor` readback that does not exist | Yes | Platform (`docs/legacy-adoption.md:35-55`) | M |
| `lazurio module status|start|open|stop` for agents | `app-request` needs a running Launchpad session URL on macOS (`src/cli.ts` help) | Yes: root rules tell agents to start apps this way | Platform: session-free CLI parity | M |
| Worktree discipline: `worktrees:create|status|check`, `pr:preflight` | Folder manual text only (F14) | Yes, as a mechanism (root rule: what a script can hold, text must not) | A Platform-generated skill in the Folder with its scripts, or `lazurio worktree …` | M |
| Skills package and `.claude/skills` mirror (root decision 0104) | none; F16 says "generated into the Folder by axis" | Yes | Platform | M |
| Claude Code entry file | the Folder generates `AGENTS.md` and `manual/*` only (`src/folder/outputs.ts:61-64`); whether Claude Code reads `AGENTS.md` directly is **unverified** (the root bridges it with `CLAUDE.md` → `@AGENTS.md`) | Yes (acceptance requires real Claude Code use, `AGENTS.md:53-54`) | Platform | S |
| Desktop Launchpad (`.app`, Start Menu) | none | Yes for non-technical operators | Platform | M |
| Launch from worktrees (root decision 0049) | **unverified** whether the Platform lifecycle selects a worktree source | Yes | Platform | **unknown** |
| Personalspace creation (`personalspace:create`) | none | Occasionally | Platform or the Personalspace template | S |
| Mission Control helpers (plan lookup in `worktree-create.mjs:91-92,156-159`, `mission-control:smoke`) | none | Yes where Organizations plan in Mission Control | The Mission Control module or its Organization template | **unknown** |
| `lazurio search` (qmd index) | none | **Unknown** consumer | Nowhere until a consumer asks | — |
| Guide (Astro course, `guide/`) | none | Product onboarding | A workspace module of the Organization that owns the website, or retired | S |
| GEN2 migration, runtime-manifest migration, Organization compiler scripts | none | No (migration code is deleted after completion) | Organization repositories or nowhere | — |
| Resident and Buddy distribution tooling (`resident:*`, `bridge/`, `distribution/`, `provisioning/`) | none | Until F15 retires the resident; the Buddy bridge's future owner is **unknown** | Machines or a Buddy repository | **unknown** |
| Root manuals of lasting value: integration runbooks, secret custody, hosted Buddy, Conglomerate Owner administration, Windows lab, first-client rollout | partly in the Folder manual | Yes | Product-generic → Platform docs or Folder manual; Organization-specific → Organization; operations → Machines | M |
| Decision register (0001–0162) cited by Platform documents | Platform `docs/decisions.md` (F-series) | Yes, as history | Frozen in the archive; new decisions in the Platform (question Q9) | S |
| 20 open issues and 15 open pull requests on the root repository | — | Must be closed, moved or finished before the archive | Owning repositories (issues can be transferred) | S–M |

What I could not determine: whether Machines or any Organization build depends on the
root repository beyond the resident artifact; whether Organization `AGENTS.md` files
instruct agents to run root scripts (`bun run doctor:task`, `pr:preflight`) — the root
rules require it for nested checkouts (root `AGENTS.md:335-356`), so it is likely, but
Organization repositories were not read; how many Windows and Intel macOS users exist.

## F. Risks and gaps of "repair forward" for this migration

The stance holds for most of this migration: every step is a rename, Organization and
Personalspace data never changes, and the legacy tree is the checkpoint. The
exceptions are below.

| Risk | Why Git or an agent cannot fix it | Mitigation |
| --- | --- | --- |
| Untracked and ignored data (Personalspace content, drafts, local secrets under Organization `private/`, stashes, unpushed branches, root worktrees) | Git history does not hold it; only the files on disk do | Rename, never copy or delete; the legacy tree stays; inventory before and after |
| npm publication | A published version number can never be reused; a mistaken launcher is public at once | Publish only from the protected `release` environment; first versions as prerelease under `next` |
| npm account or publish path compromised | A malicious launcher runs with the user's rights at the first `npx`, before any F13 check it would contain | Trusted publishing only, tokens disallowed, 2FA; the prompt pins an exact version; `npm audit signatures`; no lifecycle scripts to hide in. `install.sh` remains the non-npm path |
| The agent's own runtime | An agent cannot repair the harness it runs in. Renaming the tree under its working directory silently moves its shell; its histories may be keyed by the path | Working directory outside the tree (D3 precondition 6); the path `<home>/Lazurio` is kept; the harness and its config are never touched; the legacy CLI stays until step 8 |
| Broken PATH entry | `lazurio` itself is the repair tool | `~/.local/bin/lazurio` is a symlink to the native selector, not a Node shim; the manual names the absolute fallback (`src/folder/manual.ts:668`) |
| A product release with a bug in the updater | Only maintainers can publish the fix; the operator cannot "push a fix" to the Platform | `lazurio update rollback`; offline update from a newer staged binary (A3); `install.sh`/`npx` of the fixed release |
| A release that changes Folder state | Program rollback is not data rollback (`docs/update.md:53-55`; F18 boundary) | Forward repair by the next release, as F18 already specifies |
| Sigstore trust root unreachable on a cold cache | The launcher and the updater refuse (`trust-unavailable`) | Accepted by F13; retry later |
| Two migrations at once on one Machine | Two agents could interleave renames | Step 3's rename is atomic and the second agent's precondition 5 fails; D5 names every state |
| Legacy `lazurio update` running concurrently | It writes into the repositories being moved | Quiesce check in step 2 |
| Same command, new meaning | Agents that learned "run `lazurio update` first" from legacy rules now update the product instead of synchronizing content | Harmless for data (product update never touches repositories, F9); Organization `AGENTS.md` files need their own revision (E2) |
| Windows | Renames fail on open handles; symlink privileges; a shared `%LOCALAPPDATA%\Lazurio`; no product at all today | Windows waits for its target (E1); a failed rename is a clean stop with nothing moved |
| Team VM updated by one operator | Every Principal sharing the account gets the new version | Pill warns before the click (C4, Q6) |
| Operator ahead of the pin breaks the install | The pin is below the high-water mark and repair refuses (C2) | Repair stages the release equal to the mark (Q5) |
| Archive | Reversible on GitHub, but a frozen legacy tree gets no fixes | Archive only when no user needs a legacy fix (G, Q8) |

## G. Order of work and questions for the Principal

### G1. Slices, each reviewable and releasable alone

| # | Slice | Repository | Depends on | Result |
| --- | --- | --- | --- | --- |
| S1 | Decisions: amend 0161 and F17 (operator owns the Lazurio version), record the npm and migration choices | root register, Platform `docs/decisions.md` | Q1–Q10 | Text only |
| S2 | `install` creates `~/.local/bin/lazurio`; hosted manual "Updates on this Machine" rewritten (`base-instructions-9`); update result and pill say "Folder refresh needed" | Platform | S1 | Operators on VMs may run `lazurio update` |
| S3 | Repair-mode role: install when absent or broken, never push forward by default, verify the PATH link, repair at the high-water release | Machines | S2 released | Rollout is repair |
| S4 | npm launcher, `release.yml` publish job, npm organization and first publish | Platform + npm | S1; the first publish is a Publication by the Principal | `npx lazurio install` |
| S5 | Workstation adoption (`folder-init --adopt`), `migration inspect`, `migration prompt`, the manual of D3 | Platform | S2 | Migration can run |
| S6 | macOS canary: the Principal's own workstation, then one more | — | S4, S5 | Evidence; the go/no-go for others |
| S7 | Daily-work gaps, one slice each: multi-Organization Launchpad, session-free module CLI, doctor, skills and Claude Code entry, worktree mechanism, desktop Launchpad | Platform | S5 | Legacy not needed day to day |
| S8 | F15 on VMs: Platform unit, resident removed, no `launchpad.gen3*.json` | Machines + Platform | hosted entry (in progress) | Linux VMs migrated |
| S9 | Content synchronization and Organization materialization (F9) | Platform | S7 | New Machines without the root |
| S10 | Windows target and its migration section | Platform | S5 | Windows users can migrate |
| S11 | Archive: move manuals (E2), transfer or close issues and pull requests, root README becomes a pointer, archive | root + owners | S6, S8; S10 or Q8 | Root archived |

S2 and S3 can ship this week and do not depend on npm or the migration. S6 is the first
real proof and should precede any wider prompt.

### G2. Questions for the Principal

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Accept the thin launcher (option 2) under the unscoped name `lazurio`, owned by a new npm organization `lazurio`? | Yes. Claim the name only together with the first real launcher release (holding a name unpublished counts as squatting) |
| Q2 | Should the npm package also be installed on VMs? | No. VMs get `~/.local/bin/lazurio` → the native selector from the install itself; npm there would compete for the same entry and put Node in front of the repair tool |
| Q3 | Publish the launcher from `release.yml` with the same version as the product, approved once by the `release` environment reviewer (no second npm staged approval)? | Yes: one version number, one approval, one governed workflow |
| Q4 | May a rollout still move a working Lazurio forward? | Not by default. Only by your explicit decision for one named release, for example a security fix |
| Q5 | When an operator is ahead of the pin and the install breaks, may Machines stage the release equal to the high-water mark? | Yes; otherwise that VM cannot be repaired by the rollout |
| Q6 | On a shared Team VM, may any operator update Lazurio? | Yes, with a warning in the pill that everyone on the account is affected |
| Q7 | Accept "rename aside, same paths" (D1), amending the earlier in-place conversion note? | Yes |
| Q8 | Archive before Windows users can migrate? | Only if the Windows users accept a frozen legacy checkout (it keeps working, fetches still succeed, no fixes). Otherwise archive after S10 |
| Q9 | Where do the root decision register and the lasting root manuals go? | Register frozen in the archive; new decisions in Platform `docs/decisions.md`; product manuals into the Platform, Organization-specific ones into their Organizations, operations into Machines |
| Q10 | When is `<home>/Lazurio.legacy-<date>` deleted? | Never by the migration; by the operator on explicit instruction, after at least 30 days of daily use without it |
