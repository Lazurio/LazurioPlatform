# Machines handover consumer — limited Linux pilot

Machines owns provisioning, networking, firewall, SSH and the infrastructure
gateway. Platform owns the environment inside the delivered Machine. This boundary
does not authorize deployment, restart, access changes or resident removal.

## One upstream contract

Machines writes `/etc/lazurio/lazurio.machine.json`, root-owned and non-shared,
after successful managed handover. Platform only reads it. The exact upstream
JSON Schema is vendored byte-for-byte in `src/machine/lazurio-machine.v1.schema.json`
from Machines release **v0.12.61** (tag `v0.12.61`, commit
`cb305ce22b3bf3aed5ea2fd6342a85d8a294a875`); adjacent `schema-provenance.json`
records the source tag, commit and byte digest, and a test fails when the vendored
bytes drift from it. Changes originate in Machines, then the consumer is re-pinned
and conformance tested. No runtime dependency on a private checkout. The test
fixtures are synthetic, not a customer's rendered identity.

The schema is a `oneOf` with exactly two branches, distinguished by `machine.kind`
and never mixing owner or host kinds:

| Branch | `machine.kind` | `owner` | `host` | `network` | `relationships` |
| --- | --- | --- | --- | --- | --- |
| Organization workspace VM | `workspace-vm` | `{kind: "organization", organization, organization_key?, team?, assignment?}` | `{kind: "virtualization-host", machine_id, custody_repository, provider}` | optional | optional, `zone: "work"` |
| Personal VM | `personal-vm`; `machine.name` is the DNS slug | `{kind: "principal", github_login, github_id}` | `{kind: "provider-estate", estate_id, custody_repository, record_path}` | required | optional, `zone: "personal"` |

`operator`, `installed` and `account` are shared; `operator.os_user` may differ from
`machine.name`. `MachineContext` in `src/machine/context.ts` is the union of the two
branches, and the conformance tests cover both with real-shaped fixtures.

Two fields are new since v0.12.59, both optional, both closed shapes with no
defaults, and both copied into the Machine binding exactly as written (absent stays
absent, so a Folder adopted from a v0.12.59 handover still matches its handover byte
for byte). Neither is part of the Machine identity: both follow the current handover
through [`folder-refresh`](#refresh-after-a-handover-rewrite):

- **`owner.assignment`** — Organization branch only; the personal branch refuses it.
  `{kind: "operator", github_login, github_id}` or `{kind: "team"}`, authored per guest
  in the owner Deployment Repo and copied by Machines, never inferred from names,
  Team names or Team size. It is **the** selector between the two Organization
  presets ([workspace presets](workspace-presets.md#derived-from-the-handover-confirmed-or-explicitly-overridden)).
- **`relationships`** — `{zone, peers[]}`: this Machine's tailnet peers from its own
  point of view, derived by Machines only from the home Conglomerate Host grants that
  name its Headscale node; omitted when the Deployment Repo declares no home
  Conglomerate Host. `zone` is the zone of the branch (`work` / `personal`, upstream
  decision 0155). Each peer is `{name, kind, zone, organization, ssh, https}`: the
  Headscale node name; `personal-vm` | `workspace-vm` | `client-device` |
  `conglomerate-host`; the peer's zone or `null`; its lowercase Organization login or
  `null`; `ssh` as `{host, user, direction}` (MagicDNS name, OS account or `null`,
  and `outbound` | `inbound` | `both` for TCP 22 relative to this Machine) or `null`;
  and `https`, the peer's gateway hostnames reachable from here over TCP 443. Names
  only: no node ids, machine keys, tailnet addresses or credentials. Platform renders
  it and enforces nothing; Headscale does.

The consumer rejects duplicate keys, unknown fields, invalid UTF-8, documents over
1 MiB, unsafe file ownership/modes, links and noncanonical parent custody. The
schema is bundled into standalone builds. Validation never coerces values, adds
defaults or fetches references. Missing context is not manufactured from hostnames,
environment variables or directory names.

`owner`, `team`, `host` and `network` describe context, not permission. `account`
remains null; a future Lazurio Account login does not change that until the upstream
contract defines the field ([hosted entry](hosted-entry.md)). Organization/provider binding, revision and live access must come
from the owner/provider; a slug is not a repository URL or access grant. Inspection
output contains private context: keep it in the owner's scope, not public logs.

## The operator is an OS account, not a person

`operator` names the OS execution account that owns the Lazurio Folder on this
Machine. It is not necessarily a human Principal, and the consumer never treats it as
one. Reconciled 2026-09-19 with [decision F2](decisions.md#f2--private-and-team-hosted-workspaces);
this section is accepted direction, and the implemented consumer below remains the
narrow Linux/remote/human pilot entrypoint.

- **Private hosted workspace:** one Principal uses the operator account and signs in
  with their own provider identity inside it.
- **Team hosted workspace:** the operator account is shared by the Principals who
  connect. It must never acquire anyone's personal credentials, sessions or
  Personalspace. Its provider identity is the brokered Organization identity; `team`
  in the handover is context for that, not a grant and not a roster.

The handover has no selected-preset field and needs none. The
[workspace preset](workspace-presets.md) is derived from its typed fields only:
`personal-vm` → `hosted-personal`; `workspace-vm` with `owner.assignment.kind`
`"operator"` → `hosted-organization-personal`, `"team"` → `hosted-organization-team`.
`owner.assignment` is the only selector between the two Organization presets; when it
is present nothing else is read. A `workspace-vm` handover **without** it proves only
one side: without `owner.team` it is one operator's (`hosted-organization-personal`,
as before v0.12.61); with `owner.team` it is ambiguous, because an Organization may
model one operator's VM as a Team named after them, and Platform derives no preset
from it. Never from the Machine name, the hostname, the Team name or the operator
account, and never from `relationships`. For such a handover the Machines resident
role passes the preset from the owner infrastructure. `folder-init` records the
derived preset, or an explicit `--preset` the handover allows, in the Environment
configuration together with the **Machine binding** (kind, name, owner, team,
assignment, tailnet node, host, relationships and the handover digest).
Machines does not rewrite the identity; a Folder adopted for a different Machine is
refused, never rewritten. Identity is kind, name, Owner (Organization and Team, or
Principal), tailnet node and host, and it is immutable. Machines rewrites the handover
on every apply (`installed`, the declared assignment, the derived relationships), so
the document digest is not identity: a re-apply of the same Machine keeps the Folder
adopted. The rest of the binding is handover-derived content, not a choice of the
Principal: `lazurio machine folder-refresh` re-records it from the current handover
and re-renders the generated files, keeping the recorded preset and profile.

A repeated infrastructure apply must preserve the Machine identity, the Folder
content and the Platform-selected product version; Machines does not reselect the
version after handover, and Platform does not rewrite the identity.

## Consumer commands

Run the installed CLI as the declared operator, not root. This is the exact command a
Machines resident role calls after handover:

```sh
lazurio machine folder-init
```

For a handover without `owner.assignment` that names a Team (`owner.team`), the
resident role passes the preset from the owner infrastructure, because the handover
does not decide it:

```sh
lazurio machine folder-init --preset <hosted-organization-personal|hosted-organization-team>
```

It reads the handover, derives the preset, adopts the Folder and prints one JSON
object: `{"kind":"initialized","revision":1,"preset":{"name":…,"version":1,"selection":"derived"},"machineContextDigest":"<sha256>"}`
on first use; `{"kind":"already-adopted","revision":<n>,"preset":{…},"machineContextDigest":…}`
on a re-run, which changes nothing; or exit status 2 with
`{"kind":"blocked","reason":…,"entry":…,"next":…}` where `reason` is one of
`folder-foreign-entry`, `folder-layout-missing`, `folder-personalspace-conflict`,
`folder-state-unrecognized`, `folder-binding-changed`, `folder-directory-shared`,
`preset-not-allowed`, `preset-ambiguous` or a Machine context code. `preset-ambiguous`
is the Team-bearing handover without `owner.assignment` and without `--preset` on a
not yet adopted Folder:
`{"kind":"blocked","reason":"preset-ambiguous","allowed":["hosted-organization-personal","hosted-organization-team"],"next":…}`;
a re-run on an adopted Folder is never ambiguous. Optional `--preset <name>` picks another preset the handover
allows (recorded as an explicit choice); optional `--locale`, `--detail` and
`--coordination` override the preset's defaults and stay changeable in the Launchpad.
`lazurio machine inspect` prints the validated handover and its digest.

### Refresh after a handover rewrite

`folder-init` on an adopted Folder changes nothing, and the profile commands carry the
recorded binding forward, so a handover rewritten with a new peer (for example the
operator's work VM added to the personal VM's `relationships`) never reached
`AGENTS.md` or `manual/this-machine.md` in v0.1.2. The Machines resident role runs,
as the declared operator, after every handover write on a Machine whose Folder exists:

```sh
lazurio machine folder-refresh
```

It takes no options: the handover, the operator and the Folder are bound exactly as
for `folder-init`, and no caller-held revision is needed because the refresh changes
no choice of the Principal; it plans under the Folder lock from the revision it
finds. It requires the same Machine identity (`folder-binding-changed` otherwise),
re-projects the binding from the current handover and plans with the recorded preset
and profile through the one Folder change planner and transaction that
`profile-update` uses: every owned output is checked against its recorded digest, all
are staged, replaced and archived as `history/revision-<n>`, and the revision is
bumped. It prints one JSON object with `machineContextDigest`:

| Result | Exit | Meaning |
| --- | --- | --- |
| `{"kind":"refreshed","revision":<n>}` | 0 | The rendered files changed; revision `n` records the new binding |
| `{"kind":"unchanged"}` | 0 | The current handover renders the same bytes (identical handover, or only `installed` rewritten); nothing is written, the recorded binding and revision stay |
| `{"kind":"blocked","reason":"folder-not-initialized",…}` | 2 | No Folder state: run `folder-init` first; nothing is created |
| `{"kind":"blocked","reason":"drift","path":…}` / `"unsafe-path"` | 2 | An owned file was edited, removed or replaced by a link; it is named and never overwritten, nothing is written |
| `{"kind":"blocked","reason":"folder-binding-changed",…}` / `"folder-state-unrecognized"` | 2 | Another Machine's handover, or pending/unrecognized state |
| `{"kind":"blocked","reason":"preset-derivation-changed"}` | 2 | The Folder's preset was derived and the handover's assignment now derives another one; the Principal chooses it with `profile-update --preset` |
| `{"kind":"blocked","reason":"template-upgrade-required"}` | 2 | The Folder was rendered by another template revision; see below |
| Machine context codes | 2 | As for `folder-init` |
| stderr `Folder operation failed…` | 1 | Operation failure; an interrupted refresh is completed with `lazurio profile-resume --folder ~/Lazurio --target-revision <n>` |

The Launchpad shows the refreshed binding on its next read; an open panel holding the
old revision gets `stale-revision` on apply, as after any concurrent change. The
refresh re-renders only what the handover changes. A product release that changes the
templates is still `template-upgrade-required`, for a refresh and a profile change
alike ([F14 deferred](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)).

A wrong invocation (unknown option, duplicate or invalid choice, unknown preset)
prints the `machine` help on stderr and exits 2 before any filesystem access.

**Precondition for the Machines resident role:** `~/Lazurio`, `organizations/` and
`personalspace/` must be owned by the operator and not group- or world-writable
(create them with mode `0755` or `0700`, as `workspace_baseline` does). Ubuntu's
default umask `0002` makes a directory created by hand `0775`; `folder-init` then
refuses before any mutation with `folder-directory-shared` naming the entry
(`.`, `organizations` or `personalspace`), and `chmod g-w,o-w` on that path
fixes it. Found on the native run of 2026-09-22
([evidence](evidence/presets-linux-arm64-2026-09-22.md)).

It binds the declared user/home to the actual UID's Linux NSS record (not
`$USER`/`$HOME`) and requires `operator.lazurio_root` to be that user's
`/home/<user>/Lazurio`. The wire name remains `lazurio_root`; the product concept is
**Lazurio Folder**. There is no CLI override for the production identity path or UID.

The Linux base system must provide root-owned `/usr/bin/getent`; it is called
without a shell, with a fixed `passwd <uid>` query and sanitized environment.
Missing/unsafe resolver or ambiguous output stops as `machine-operator-unavailable`.
We deliberately do not use Bun 1.4.2 `os.userInfo()` here: native ARM64 qualification
observed that its username depends on the ambient environment. No dependency on
a separately installed Bun is introduced by the system account lookup.

### Adoption of the delivered Folder

The initializer adopts a canonical operator-owned Folder. The Folder owns exactly
`AGENTS.md`, `manual/` and `.lazurio/` at the top level. `organizations/` (required, owned,
non-shared) and `personalspace/` may already hold work: they are never traversed,
listed beyond existence, moved or written, and their paths, filesystem identities and
modes remain unchanged. `launchpad.gen3.json` and `launchpad.gen3.local.json` are
tolerated by name and never read. Any other top-level entry — a legacy `AGENTS.md`,
a `manual/` without recorded digests, a checkout, a note — stops initialization and is
named in the refusal. A symlinked or
group/world-writable work directory is refused as before.

`hosted-personal` requires `personalspace/` to exist. The Organization presets never
have a Personalspace: the empty `personalspace/` that the `workspace_baseline` role
precreates is accepted and recorded, a used one is refused by name and nothing is
deleted or moved. Presence is checked by existence and emptiness only, never by
listing names.

Initialization exclusively creates `.lazurio` and `manual/`, journals the preexisting
layout identities and writes the generated outputs (`AGENTS.md`, the six manual files)
and preferences/manifest exclusively, one receipt per created file. Two
initializers cannot both claim state. A re-run on an adopted Folder holds only the
ephemeral operation lock, compares the recorded Machine identity with the live
handover and reports `already-adopted`; another Machine's handover is `binding-changed`,
pending or unrecognized state is `state-unrecognized` (complete it with
`folder-resume` or diagnose). No Organization is cloned yet: owner binding and
module delivery remain separate pilot gates.

### What the Folder renders

`AGENTS.md` is a deterministic projection of the preset, the recorded binding and
the profile: which Machine this is and whose, how it is assigned when the handover
says so (`assigned to operator <login>` / `shared by the Team`), who the Principal is
here, the Personalspace boundary, where Organization repositories live, the provider
identity mode and how work is done, with a pointer to the Organization's `AGENTS.md`
and to the agent manual in `manual/` ([decision F14](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)):
six English documents rendered from the same inputs, of which `this-machine.md`
carries the Machine, its preset and the zones of upstream decision 0155. Its
`Relationships` section is rendered only when the recorded binding carries the
handover's `relationships`: one line per peer with kind, zone, Organization, SSH
host, account and direction, and HTTPS hostnames, plus one sentence that Lazurio
enforces none of it (Headscale does). Nothing is rendered when the field is absent,
and no persona is rendered. The Owner line names the Team only under
`hosted-organization-team`, unchanged by the assignment.
After a handover rewrite `folder-refresh` renders the current assignment and
relationships ([refresh](#refresh-after-a-handover-rewrite)).
The Launchpad shows the binding, including the assignment and a compact read-only
list of the peers, and lets the Principal change the preset (within the allow-list)
and the communication axes through the ordinary preview → apply flow.

## Delivery by the Machines role (agreed 2026-09-23, Machines #199, v0.12.70)

The Machines resident role installs the Platform from a custody-staged, digest-pinned
binary and never from the network. The owner overlay of both hosted lanes
(workspace-vm and personal-vm) pins `resident_bootstrap.artifacts.platform =
{version, source_commit, target, sha256, size}` copied from the release's
`manifest.json`, and the sibling `resident_bootstrap.artifacts.platform_attestation =
{sha256, size}` for `lazurio.sigstore.json`. The role runs
`<staged>/lazurio install --base ~/.local/share/lazurio` (no `--service`), then
`lazurio machine folder-init` when the Folder is absent, forwarding `resident_bootstrap.folder.locale`
(`cs` | `en`) verbatim as `--locale` when the overlay declares it; absent, no flag is
passed and the preset default applies. The field is accepted only when a Platform
artifact is pinned. What the role treats as a **finding, not a failure**: `install`
on an existing tree (a no-op by design: versions change only through
`lazurio update`), an active version different from the pin after that no-op, and
`blocked folder-binding-changed` on a Folder adopted before this contract. The role
never runs `lazurio update`; the product's own update moves an installed Machine
forward. After writing the handover on a Machine whose Folder exists, the role runs
`lazurio machine folder-refresh` (added after v0.1.2; the role needs a pinned release
that has it): exit 0 `refreshed` or `unchanged` is success, exit 2 `blocked` is a
finding to report with its `reason` and `path`, not a failure to retry, and exit 1 is
an operation failure.

## Bounded diagnosis and repair

Inspection reports `machine-context-missing`, `machine-context-invalid`,
`machine-context-custody` or `machine-platform-unsupported`. Initialization also
checks `machine-operator-mismatch`. These failures do not write the handover or
initialize a Folder. Ask the Machines operator to verify managed handover; do not
rewrite identity to impersonate another user.

An interrupted initializer leaves state in place. If its complete journal and
creation receipts are intact, `folder-resume --folder <declared-path>` uses the
existing recovery core to finish forward. The handover journal has its own
version/kind and retained directory identities; precreated work directories are
not mistaken for out-of-order output. It never replaces/moves those directories
and preserves work subsequently added inside them. A missing/replaced directory,
edited output, damaged journal, partial write without a receipt or abandoned lock
requires operator diagnosis. No automatic cleanup or universal recovery is
promised. Recreating a disposable VM requires separate infrastructure approval.

Product update follows the [product update contract](update.md); until it is
implemented nothing installs a product release on a Machine: retain the previous
working product. Folder handover does not change that rule.
The local filesystem boundary assumes no hostile concurrent same-user/root
directory replacement; ownership checks are not a sandbox.

## Qualification boundary

A clean committed checkout can produce a Linux glibc candidate from the Mac:
`bun run scripts/build-candidate.ts /absolute/absent/output --target linux-x64`.
Use `linux-arm64` for the local ARM64 VM. The target and artifact digest in
`identity.json` describe the destination bytes, not the build host. The native
build remains available without `--target`. Cross-compilation is only packaging;
it does not qualify either architecture. See [Bun's executable targets](https://bun.sh/docs/bundler/executables).

Unit fixtures prove parsing/refusal of both handover branches including the
v0.12.61 fields (assignment on the Organization branch only, relationships in the
branch's zone, closed peer shapes), preset derivation from the assignment, that a
v0.12.59-shaped handover still reads, projects and derives exactly as before, the
rendered assignment and relationships, adoption (used work directories, legacy
files, foreign entries, idempotence, the Personalspace conflict), directory
preservation, recognized interruption completion, and the refresh: a personal
handover before and after a work VM peer is added renders that peer as outbound SSH
into the `cs` and `en` `AGENTS.md` and into `manual/this-machine.md` and keeps the
preset and profile; an identical or only-`installed`-rewritten handover is
`unchanged`; an edited or removed owned file is refused by path without a write;
another Machine and a changed derivation are refused; an interrupted refresh
completes through `profile-resume`. A native run of `folder-init`
with the compiled CLI on a fresh Ubuntu 24.04 ARM64 VM against root-issued
v0.12.59-shaped fixture handovers of all three kinds is recorded in
[evidence](evidence/presets-linux-arm64-2026-09-22.md); a native run with a
v0.12.61 handover carrying `owner.assignment` or `relationships`, and a native
`folder-refresh`, are not yet recorded.
They do not prove actual
Machines delivery, a real Machines-delivered VM, a native Launchpad preset change,
official release hosting and attestation, native Linux x64 execution,
Organization/module authorization, gateway operation, agent work, VM restart or the
second-VM repeat. Record those separately
at exact source/artifact revisions. The real pilot must exercise the installed
binary and root-issued file under the non-root operator account.
