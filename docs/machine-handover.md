# Machines handover consumer — limited Linux pilot

> **Approved target update, 2026-10-06 (root 0192):** [Account and Environment access](environment-access.md) refines organizational admission: Lazurio membership and full/app grants, optional GitHub for visitors, Admin approval of the exact Headscale device, and delegated same-Organization sharing. Conflicting older target statements below are superseded; implemented behavior and evidence remain baseline only until a qualified migration. No runtime changes in this documentation update.

Machines owns provisioning, networking, firewall, SSH and the infrastructure
gateway. Platform owns the environment inside the delivered Machine. This boundary
does not authorize deployment, restart, access changes or resident removal.

## One upstream contract

Machines writes `/etc/lazurio/lazurio.machine.json`, root-owned and non-shared,
after successful managed handover. Platform only reads it. The exact upstream
JSON Schema is vendored in `src/machine/lazurio-machine.v1.schema.json`
from the head of Machines pull request **#449** (commit
`04d47bfdfb004830d77bdb3874e6bf3950f4d9f7`, SHA-256
`fbbd159b8e6dfc8580a7b8460ddb4a2b2d3158a1b74ab2a420d8ff68005ae53f`), which adds the
optional `entry.environment_relay` ([below](#the-hosted-entry-decision-f16), root
decision 0194, decision F45) and changes nothing else. The pull request is not merged
yet: its merge commit, with the same digest, replaces the commit here, and a digest
other than this one is a new re-pin. No Machines release carries it yet, so the
provenance names no version and no tag. Before it, the pin was the merge of Machines
pull request **#398** into `main` (commit `b831308f153519747ebcb4d2d9690c1b9a865a9b`,
SHA-256 `475c5197b7c2d812dda960aa30f23a709837dca0560579e5c1c5d4f822d1506e`), which
added the optional `entry.browser` (decision F38); before that, the merge of
Machines pull request **#304** (commit `3d49ac09dd01868805bfb44bc1d99f8140d3bfe9`,
SHA-256 `b9f9a127bc50c290f99f8332120f0efe2ef42482815d1d79dda7810fb656cfd7`), which
added the optional `entry.mausbot`; before that, the merge of Machines
pull request **#277** (commit `e41eb68453f3f8a6568f99c523aeaaf8cfa5ea0a`, SHA-256
`0313169bb859aa7ee8372a96425c44e6b113bdeb4bcbd0bd490de76630f6479a`), which added the
third `owner.assignment` kind `automation` to the v0.12.93 schema. The previous pin was
Machines **v0.12.93** (tag commit `ab84f387f517dd6bd06b2af2939a9a746a02533b`, the
merge of pull request #243; SHA-256
`1ccce08bd774aea62367085b13bb4afcc8c443f07a4b645f0ae7ebcd16aaf09d`), which added the
optional `entry` to the v0.12.61 schema; its `origin_template` description says the
reader substitutes the gateway label of a module id, never the id itself. Adjacent
`schema-provenance.json` records the source version, pull request, commit, tag and
byte digest, and a test fails when the vendored bytes drift from it. Changes
originate in Machines, then the consumer is re-pinned and conformance tested. No runtime dependency on a private checkout. The test
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
  `{kind: "operator", github_login, github_id}`, `{kind: "team"}` or, since Machines
  #277, `{kind: "automation", github_login, github_id}` (the responsible operator of
  an Automated Environment, decision 0169, never the persona), authored per guest in
  the owner Deployment Repo and copied by Machines, never inferred from names, Team
  names or Team size. It is **the** selector between the Organization presets, and
  when present the only preset a new choice may take is the one it derives
  ([workspace presets](workspace-presets.md#derived-from-the-handover-confirmed-or-explicitly-overridden)).
  The binding records `automation` as `{kind: "automation", githubLogin, githubId}`.
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

One field is new in 0.12.93, optional on both branches, closed and without defaults:
**`entry`**, how the Machine is entered through its workspace gateway
(`launchpad`, `t3code`, `modules`). It is projected into the binding member by member
and is not part of the identity either; see [the hosted entry](#the-hosted-entry-decision-f16).
A handover without it reads, projects and renders exactly as before.

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
Machine. It is not necessarily a person, and the consumer never treats it as
one. Reconciled 2026-09-19 with [decision F2](decisions.md#f2--private-and-team-hosted-workspaces);
this section is accepted direction, and the implemented consumer below remains the
narrow Linux/remote/human pilot entrypoint.

- **Private hosted workspace:** one person uses the operator account and signs in
  with their own provider identity inside it.
- **Team hosted workspace:** the operator account is shared by the people who
  connect. It must never acquire anyone's personal credentials, sessions or
  Personalspace. Its provider identity is the brokered Organization identity; `team`
  in the handover is context for that, not a grant and not a roster.

The handover has no selected-preset field and needs none. The
[workspace preset](workspace-presets.md) is derived from its typed fields only:
`personal-vm` → `hosted-personal`; `workspace-vm` with `owner.assignment.kind`
`"operator"` → `hosted-organization-personal`, `"team"` → `hosted-organization-team`,
`"automation"` → `hosted-organization-steward`.
`owner.assignment` is the only selector between the Organization presets; when it
is present nothing else is read, and a new choice (`--preset`, a profile change, the
Launchpad) may take only the derived preset; a preset the Folder already recorded
stays valid, and rerunning the `folder-init` that adopted the Folder reports it
`already-adopted` instead of refusing that preset (issue #107). A `workspace-vm` handover **without** it proves only
one side: without `owner.team` it is one operator's (`hosted-organization-personal`,
as before v0.12.61); with `owner.team` it is ambiguous, because an Organization may
model one operator's VM as a Team named after them, and Platform derives no preset
from it. Never from the Machine name, the hostname, the Team name or the operator
account, and never from `relationships`. For such a handover the Machines resident
role passes the preset from the owner infrastructure. `folder-init` records the
derived preset, or an explicit `--preset` the handover offers, in the Environment
configuration together with the **Machine binding** (kind, name, owner, team,
assignment, tailnet node, host, relationships, entry and the handover digest).
Machines does not rewrite the identity; a Folder adopted for a different Machine is
refused, never rewritten. Identity is kind, name, Owner (Organization and Team, or
a person), tailnet node and host, and it is immutable. Machines rewrites the handover
on every apply (`installed`, the declared assignment, the derived relationships), so
the document digest is not identity: a re-apply of the same Machine keeps the Folder
adopted. The rest of the binding is handover-derived content, not a choice of the
Operator: `lazurio machine folder-refresh` re-records it from the current handover
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
lazurio machine folder-init --preset <hosted-organization-personal|hosted-organization-team|hosted-organization-steward>
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
`{"kind":"blocked","reason":"preset-ambiguous","allowed":["hosted-organization-personal","hosted-organization-team","hosted-organization-steward"],"next":…}`;
a re-run on an adopted Folder is never ambiguous. Optional `--preset <name>` picks another preset the handover
offers (recorded as an explicit choice): on a handover that states `owner.assignment`
only the derived one, so any other is `preset-not-allowed` with `allowed` naming it;
without it any preset of the machine kind; optional `--locale`, `--detail` and
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

The handover, the operator and the Folder are bound exactly as for `folder-init`, and
no caller-held revision is needed: the refresh keeps the recorded choices and plans
under the Folder lock from the revision it finds. Its one option, `--preset <name>`,
takes the preset the current handover derives after `preset-derivation-changed`
(below); it records that preset with the new binding in the same revision, as
`derived`, and refuses any other preset with `preset-not-allowed` (issue #107). It requires the same Machine identity (`folder-binding-changed` otherwise),
re-projects the binding from the current handover and plans with the recorded preset
and profile through the one Folder change planner and transaction that
`profile-update` uses: every owned output is checked against its recorded digest, all
are staged, replaced and archived as `history/revision-<n>`, and the revision is
bumped. It prints one JSON object with `machineContextDigest`:

| Result | Exit | Meaning |
| --- | --- | --- |
| `{"kind":"refreshed","revision":<n>}` | 0 | The rendered files changed; revision `n` records the new binding |
| `{"kind":"unchanged"}` | 0 | The current handover renders the same bytes and declares the same entry (identical handover, or only `installed` rewritten); nothing is written, the recorded binding and revision stay. A changed entry is recorded (`refreshed`) even when no rendered text names the changed value, because the Launchpad acts on it |
| `{"kind":"blocked","reason":"folder-not-initialized",…}` | 2 | No Folder state: run `folder-init` first; nothing is created |
| `{"kind":"blocked","reason":"drift","path":…}` / `"unsafe-path"` | 2 | An owned file was edited, removed or replaced by a link; it is named and never overwritten, nothing is written |
| `{"kind":"blocked","reason":"folder-binding-changed",…}` / `"folder-state-unrecognized"` | 2 | Another Machine's handover, or pending/unrecognized state |
| `{"kind":"blocked","reason":"folder-foreign-entry","entry":…}` | 2 | A top-level entry the Folder neither owns nor tolerates; refused by name before any journal is written |
| `{"kind":"blocked","reason":"preset-derivation-changed"}` | 2 | The Folder's preset was derived and the handover's assignment now derives another one; take it with `lazurio machine folder-refresh --preset <derived preset>`. The profile change cannot: it plans against the recorded binding, which offers only the old preset |
| `{"kind":"blocked","reason":"preset-not-allowed"}` | 2 | `--preset` is not the preset the current handover derives; nothing is written |
| `{"kind":"blocked","reason":"template-upgrade-required"}` | 2 | The Folder was rendered by a newer (or unknown) template revision than this product renders; nothing is downgraded, see below |
| Machine context codes | 2 | As for `folder-init` |
| stderr `Folder operation failed…` | 1 | Operation failure; an interrupted refresh is completed with `lazurio profile-resume --folder ~/Lazurio --target-revision <n>` |

The running Launchpad reads its entry only when it starts. So a `refreshed` answer
that recorded a different entry than the Folder held before also restarts the
supervised Launchpad (the installer's `lazurio-launchpad.service` of this base that
starts this Folder) and waits until it answers with the active version, as an update
activation does. Modules, T3 Code and Codex keep running. The answer then carries
`"launchpad"`:
- `restarted`;
- `restart-failed`: the Folder is refreshed, and the unit keeps restarting on its own;
- `not-supervised`: no such unit, and the Launchpad takes the entry at its next start.

An unchanged entry restarts nothing and adds nothing to the answer (decision F38,
addendum 2026-10-06).

Like adoption and initialization recovery, the shared update transaction re-checks
the claimed boundary of a hosted Folder (`requireFolderBoundary`): before its journal
is written, before every single replacement, and in `profile-resume` before anything
is applied or archived. A foreign top-level entry
that appears while a refresh or profile update is interrupted is refused by name
(`profile-resume` exits 2 with `folder-foreign-entry`); the journal and every output
stay exactly as the interruption left them, and the resume completes once the entry
is gone. A workstation Folder (no handover binding) keeps its existing rule: the
Operator's own top-level files beside the generated ones are preserved, never read
or written.

The Launchpad shows the refreshed binding on its next read; an open panel holding the
old revision gets `stale-revision` on apply, as after any concurrent change. The
refresh re-renders what the handover changes, and everything when the active product
renders a newer template revision than the Folder records: after Machines installs a
release with new templates, or the operator runs `lazurio update` (which then reports
"Folder refresh needed"), the next `folder-refresh` is `refreshed` with the new
`AGENTS.md` and `manual/`, provided no generated file was edited (otherwise `drift`
and its path, nothing written). A Folder rendered by a newer revision than the active
product stays `template-upgrade-required` and is never downgraded
([F14](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)). There is no
program rollback any more ([product update](update.md), change of 2026-09-28), so an
active product older than the Folder's revision arises only on an installation that a
release before that change rolled back; the newer Folder keeps its files intact, and
only `folder-refresh` and profile changes answer `template-upgrade-required` until a
product at least that new is active again. Machines records it as a finding, not a
failure.

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
says so (`assigned to Operator <login>` / `shared by the Team`), who the Operator is
here, the Personalspace boundary, where Organization repositories live, the provider
identity mode and how work is done (including the two working rules of upstream
decision 0163: open questions go to GitHub Issues and do not stop the work, and
review findings are taken with judgment), with a pointer to the Organization's `AGENTS.md`
and to the agent manual in `manual/` ([decision F14](decisions.md#f14--agent-manuals-live-in-the-lazurio-folder)):
six documents in the Folder locale (`cs` or `en`, amendment of 2026-09-24) rendered from the same inputs, of which `this-machine.md`
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
list of the peers, and lets the Operator change the preset (to the recorded one or a
preset the handover offers as a new choice) and the communication axes through the
ordinary preview → apply flow.

## The hosted entry (decision F16)

Since Machines 0.12.93 the handover may carry the Machine's **entry**, rendered by
Machines from the same route catalog as its gateway (Machines `docs/machine-identity.md`,
section Entry). Machines writes it only to a Machine that runs a Platform release that
reads it: a Platform vendoring the earlier schema refuses the whole handover.

```json
"entry": {
  "launchpad": { "external_origin": "https://launchpad.<vm>.<org>.lazurio.io",
                 "auth_check_url": "https://<vm>.<org>.lazurio.io/oauth2/auth",
                 "auth_cookie_name": "__Secure-lazurio-workspace",
                 "listen_port": 20000 },
  "t3code":    { "external_origin": "https://t3code.<vm>.<org>.lazurio.io" },
  "modules":   { "origin_template": "https://{module}.<vm>.<org>.lazurio.io" },
  "mausbot":   { "external_origin": "https://mausbot.<vm>.<org>.lazurio.io",
                 "listen_port": 4102 },
  "browser":   { "external_origin": "https://browser.<vm>.<org>.lazurio.io",
                 "listen_port": 4848 },
  "environment_relay": { "socket": "/run/lazurio-environment/relay.sock" }
}
```

`mausbot` is optional and present only on a Machine that runs Lazurio MausBot
(DEV-6632, decision 0169; pending the Machines pull request that writes it, see
[the pin](#one-upstream-contract)). Absent, the Machine has no MausBot and the
Launchpad shows nothing for it.

`browser` is optional and present only on a Machine whose gateway roster routes the
Environment browser's view (root decision 0191, [F38](decisions.md#f38--the-environment-browser-of-a-remote-environment-one-chromium-a-window-per-thread-a-view-behind-the-gateway)):
the view's origin and the loopback port the people's view service listens on (F39).
It is also the
signal the installer converges the browser's units on. Absent, the Environment has no
Environment browser.

`environment_relay` is optional and present only on an Organization work VM that
declares its own identity at the Lazurio issuer (root decision 0194, Machines
`docs/environment-identity.md`): the unix socket, reachable only by the operator
account, on which the Launchpad asks the Dashboard for the Organization's settings
and posts what it applied, as this Environment (contract C3, decision F45). The
Environment's key and tokens stay with the gateway; the Launchpad holds no credential
for it. Machines writes it only for a pinned Platform at least its
`PLATFORM_ENTRY_ENVIRONMENT_RELAY_MINIMUM`, the first release that reads it. Absent,
this Machine has no relay and the Launchpad asks no Dashboard.

On a personal VM the Machine hostname has no Organization label
(`https://launchpad.<login>.lazurio.io`, `https://{module}.<login>.lazurio.io`).

The binding records it one member to one, as `entry` next to the relationships:

| Handover | Binding (`entry.`) | Rule (the schema's, checked again on the binding) |
| --- | --- | --- |
| `launchpad.external_origin` | `externalOrigin` | `https://<hostname>`: lowercase DNS labels, no port, path, query or trailing slash |
| `launchpad.auth_check_url` | `authCheckUrl` | https hostname and a non-empty path, no port or query |
| `launchpad.auth_cookie_name` | `authCookieName` | `[A-Za-z0-9_-]{1,128}` |
| `launchpad.listen_port` | `listenPort` | integer 1024–65535, never 0 |
| `t3code.external_origin` | `t3codeOrigin` | as `externalOrigin` |
| `modules.origin_template` | `moduleOriginTemplate` | `{module}` exactly once, as the whole first label; https, no port, path or query |
| `mausbot.external_origin` | `mausbotOrigin` (optional) | as `externalOrigin` |
| `mausbot.listen_port` | `mausbotListenPort` (optional) | as `listenPort` |
| `browser.external_origin` | `browserOrigin` (optional) | as `externalOrigin` |
| `browser.listen_port` | `browserListenPort` (optional) | as `listenPort` |
| `environment_relay.socket` | `environmentRelaySocket` (optional) | `/run/<directory>/<name>.sock`, lowercase letters, digits and `-`, at most 100 characters |

The relay's socket is recorded only when the handover carries it; it is never rendered
into the Folder and never part of the Launchpad's public entry. The two MausBot fields, like the two browser fields, are recorded both or neither, and absent (never `null`) when the
handover has no `mausbot`, so an entry recorded from an older handover is unchanged
byte for byte. A present but invalid `mausbot` refuses the whole handover
(`machine-context-invalid`), as every other entry value does.

The entry's values are kept exactly as written; nothing is normalized. The projection checks every
value by the same rules the schema imposes and refuses the handover
(`machine-context-invalid`) otherwise; a recorded binding whose entry is anything a
handover could not carry (for example only the four Launchpad values) is not read.
`lazurio machine inspect` prints the handover as written, `entry` included, after the
same projection.

The entry is declaration, not identity: a re-apply that adds, changes or removes it
keeps the Folder adopted, and `folder-refresh` records it. A changed entry is recorded
even when no rendered text changes (for example only the T3 Code origin), because the
Launchpad acts on the recorded values; an unchanged entry and the same rendered bytes
stay `unchanged`. `manual/this-machine.md` shows the Launchpad origin and loopback port
(through the Organization's gateway on a work VM, through the Machine's own gateway on
a personal VM).

`lazurio launchpad --folder` serves hosted from the recorded `externalOrigin`,
`authCheckUrl`, `authCookieName` and `listenPort` when the entry is present
([hosted entry](hosted-entry.md)); it reads them when it starts, so a changed entry
takes effect at its next start. `moduleOriginTemplate` gives the module links;
`t3codeOrigin` is the Chat entry's link to T3 Code
([Chat entry](launchpad-development.md#chat-entry)), used as recorded; `mausbotOrigin`
is the Lazurio MausBot entry's link and `mausbotListenPort` the loopback port its
pairing code is minted on ([Lazurio MausBot entry](launchpad-development.md#lazurio-mausbot-entry)). The Platform composes
nothing but one substitution: `moduleOrigin` (`src/launchpad/hosted-entry.ts`) fills
the one `{module}` slot with `moduleLabel(id)`, the label the gateway serves the module
at. That rule is the gateway's, not the Platform's, and textually the same as
`moduleLabel` in Machines `workloads/workspace-vm/machine-entry.ts` (the gateway
catalog's `MODULE_ID`, `label()` and `RESERVED`): an id that is not a valid
lazurio.module.v1 id (`^[a-z0-9][a-z0-9-]*$`, at most 128 characters) is refused
(`module-label-invalid`) and never lowercased or rewritten, because the gateway serves
nothing for it; otherwise runs of `-` collapse to one, `-` at both ends is stripped,
the result is cut to 63 characters and a trailing `-` stripped again, so `my--notes`
is served and linked as `my-notes`; an empty label or a name the gateway reserves
(`oauth2`, `api`, `well-known`) is refused. The template states the rule, not that a hostname is served: the gateway's
catalog decides that (it refuses a conflicting port, and two ids with the same label
share one hostname). The Platform never composes a URL from a hostname convention and
reads no environment for it.

One writer, and writing is not switching. Only the Machines role writes the entry.
With Machines #248 (Draft, not released) it writes it to every Machine whose pinned
Platform reads it (Machines' "Entry" gate: the pin is at least the first Platform tag
that projects the entry), Machines whose `lazurio-launchpad.service` is still the
resident Launchpad included. The switch of that unit to the installer-written one
(exactly one listener on the port, observed) is a separate declaration of the
Machines apply ([Launchpad parity](launchpad-parity.md#c2-the-apply-in-order), M2).
The Platform records the entry whenever the handover carries it, switched or not,
because it is declaration, not identity. On a Machine that has not switched, the
resident keeps the Launchpad port, and the recorded entry serves the CLI's module
links and `lazurio doctor`. Until a Machines release writes it, no Folder records an
entry and the Launchpad stays local.

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
artifact is pinned. The role does not pass `--verify-release`: that is the downloaded
way in of a person's computer and needs Sigstore's trust root from the network
([first installation](update.md#first-installation)); here the pin is the authority,
exactly as before. On an existing installation the same command is the
[offline update](update.md#offline-update): a newer pinned binary is staged,
self-checked and activated by the update contract's own steps
(`{"kind":"updated","from","to",…}`), the same version is `installed` and changes
nothing, and a pin lower than the active version or the high-water mark is refused
(`release-invalid`, `below-floor`) — which the role records as a finding, never
retries with force. Also a **finding, not a failure**: `blocked folder-binding-changed`
on a Folder adopted before the identity-based comparison. The role never runs
`lazurio update`: that is the operator's command (below). After writing the handover
on a Machine whose Folder exists (and after `updated`), the role runs
`lazurio machine folder-refresh` (added after v0.1.2; the role needs a pinned release
that has it) so the Folder follows the current handover: exit 0 `refreshed` or
`unchanged` is success, exit 2 `blocked` is a finding to report with its `reason` and
`path`, not a failure to retry, and exit 1 is an operation failure.

### What the Machines role does with the Lazurio version (F17 addendum 2026-09-28)

The operator owns the version of Lazurio on their Machine and updates it with
`lazurio update`; the pin in the owner overlay is a **minimum**
([F17 addendum 2026-09-28](decisions.md#f17--operator-tools-belong-to-the-operator-the-rollout-pins-the-baseline-and-repairs)).
This is the contract for the Machines role; this repository does not change Machines.
Every step below uses only what the product already answers.

| Situation the role reads | What the role does |
| --- | --- |
| No installation (`<base>/bin/lazurio` absent and no `update/high-water`) | Install the pinned release: `<staged>/lazurio install --base <base> --json`, result `installed` |
| Broken installation: the selector `<base>/bin/lazurio` is missing or not a link of its shape, while `update/high-water` survives | Repair with the pinned release when it is at or above the mark (`install` self-checks it and switches); a pin **below** the mark is refused `below-floor` and is a finding: that Machine is repaired only by a release at or above the mark (question Q5 of the distribution shaping) |
| Selector present but dangling, or its executable damaged (`<base>/bin/lazurio --version --json` fails) | Not repaired by `install` of the same version today: it answers `installed` and changes nothing; a lower pin is refused, and only a higher one moves it, as in the next row. A finding for a person; an open gap of the product, not something the role works around |
| Working installation below the pin (`update status --json`: `active` lower than the pinned version) | Raise it: the same `install --base` is the offline update, result `updated` |
| Working installation at or above the pin | Nothing. `install --base` with a lower pin answers `release-invalid` / `below-floor`, which the role records as the fact `ahead`, never a failure, retry or force |
| Any case | Never lower a version; never run `lazurio update` (the operator's command) |
| `install` over a supervised installation answers `activation-unhealthy` | A Recovery-mode finding for the readback, never a retry: the new version stays active, nothing was undone, and the repair is forward (a fixed release, or the condition the Launchpad's Recovery mode names) |
| After `installed` or `updated` | Run `lazurio machine folder-refresh` as today (above) |
| PATH entry | Verify, do not create: `install --json` returns `entry`. `state` `created`, `present` or `replaced` is correct; `conflict` or `failed` is a finding with `entry.next` in the readback, and the role never replaces the occupant. A Machine without the entry is repaired by the next `install`, not by a link the role writes itself. The operator's login shell has `~/.local/bin` on PATH (`workspace_tools` already provides it for npm); `entry.shadowedBy` not `null` is a finding |
| Readback | `lazurio update status --json`: `active`, `highWater`, `lastCheck` and `folderRefresh` are facts to report; an active version above the pin is not drift |

The role keeps its custody-staged, digest-pinned bytes and its attestation check for
installing and raising. The operator's own `lazurio update` verifies inside the product
(F13). The meaning of the overlay fields changes, not their shape.

### What the Machines role must stop expecting (no program rollback, 2026-09-28)

From the first release without rollback (the change of 2026-09-28 in
[product update](update.md); decision [F21](decisions.md#f21--recovery-mode-instead-of-rollback)):

- **No previous version.** After `updated` only the active version is on disk;
  there is no `<base>/previous` link and `update status --json` has no `previous`
  field (it has `legacyRollbackState` until the first `install` or `update` of a
  release without rollback removed what an older release left).
- **No rollback unit.** `lazurio install --service systemd-user` writes
  `lazurio-launchpad.service` (`Restart=always`, `RestartSec=5`, no start rate
  limit, no `OnFailure=`, `PATH` with `~/.local/bin` first) and, on a hosted Machine,
  `lazurio-codex-app-server.service` (below), and removes a
  `lazurio-rollback.service` it wrote earlier. The role does not pass `--service`
  today, so its Machines have none of these units.
- **Never run `lazurio update rollback`.** The command no longer exists (usage
  error, exit 2), and no executable of an earlier version may be copied or
  selected by hand. "Its owner rolled back" is no longer a reason for `ahead`:
  after such a release the active version equals the floor unless the selector is
  damaged, so `ahead` means only that the operator updated beyond the pin.
- **The update TO the first release without rollback is still performed by the
  old updater** (the installed `v0.1.x`): it records `previous` and may switch back
  if the new release's Launchpad is unhealthy. The first `install` or `update` the
  new release runs removes that state.

### The Codex app-server unit (F29)

A supervised Launchpad on a hosted Machine has a second installer unit,
`lazurio-codex-app-server.service`, which runs the operator's own
`~/.local/bin/codex app-server daemon start` at boot so a Codex client connecting over
SSH (the Codex app, for example) finds the daemon ([product update](update.md#state-on-disk),
[F29](decisions.md#f29--entry-units-of-a-remote-environment-the-launchpad-t3-code-and-the-operators-codex-app-server)).
The Platform converges it itself: the switch's `install --service systemd-user` (C.2
step 6 of [Launchpad parity](launchpad-parity.md#c2-the-apply-in-order)) writes it, and
so does every later `install --base <base> --json` **without** `--service` that raises
the pin, and every `lazurio update` of the operator, whenever the base's Launchpad unit
is the installer's unit of that base. So Machines switched before this release get it
from their next apply; the role adds no step and keeps passing `--service` only at the
switch. `serviceInstalled` still says only whether `--service` was given, so the
role's assertion that a pin raise has `serviceInstalled` not `true` holds. "Hosted" is
the handover the role writes: the unit is ensured only when the process is the
declared operator of a readable handover. It never blocks: it is ensured after the
Launchpad unit is in place, and whatever becomes of it — no Codex yet (the unit's
condition skips the start), a unit of that name the installer did not write (left
unchanged), a failing `enable` or `start` — the result is still `installed` or
`updated`, and on a supervised base `codexAppServer` says what happened (`enabled`,
`skipped-not-hosted`, `foreign-unit` with `next`, `failed` with `step` and `next`); an
unsupervised base is left alone and has no such key. The role records `foreign-unit` and `failed` as findings, never
retries with force and never writes, masks, restarts or stops the unit itself: a
restart ends the operator's live Codex sessions. Codex stays the operator's
([environment tools](environment-tools.md#operator-tools-are-the-operators-decision-0161-f17));
the role never installs or updates it for this unit. The readback lists both units
(`systemctl --user is-enabled` / `is-active` of each) and reads `lazurio doctor --json`,
where `codex-app-server` is `ok`, `warn` or `skipped` and never `fail`, so it never
stops the C.2 preflight.

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

Product update follows the [product update contract](update.md): the operator runs
`lazurio update`; the Machines role installs, repairs and raises to its pin (above).
Folder handover does not change that rule.
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
branch's zone, closed peer shapes) and the 0.12.93 `entry` on both branches (its
projection into the binding, refusal of a port below 1024, an http origin or a
module template whose first label is not the whole `{module}`, a changed entry
recorded by the refresh, and the gateway's label of a module id: normalized,
reserved and empty), the #277 `automation` assignment (a synthetic Automated
Environment handover read as written, its refusals, its projection and round-trip
through the binding, the responsible operator withheld from recovery evidence),
preset derivation from the assignment and the narrowing of new choices to it
(`folder-init --preset`, the profile change, the Launchpad offer, the refresh after a
re-assignment, a recorded preset kept valid), that a v0.12.59-shaped
handover still reads, projects and derives exactly as before, the
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
v0.12.61 handover carrying `owner.assignment` or `relationships` or a 0.12.93
handover carrying `entry`, and a native `folder-refresh`, are not yet recorded.
They do not prove actual
Machines delivery, a real Machines-delivered VM, a native Launchpad preset change,
official release hosting and attestation, native Linux x64 execution,
Organization/module authorization, gateway operation, agent work, VM restart or the
second-VM repeat. Record those separately
at exact source/artifact revisions. The real pilot must exercise the installed
binary and root-issued file under the non-root operator account.
