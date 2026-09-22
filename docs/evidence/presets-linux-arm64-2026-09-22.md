# Workspace presets: native run on Linux ARM64 (2026-09-22)

Setting: fresh Tart clone of Ubuntu 24.04.4 (systemd 255), Linux ARM64. CLI compiled
from source commit `6481a4c62d7df2bd3705bbfdd1e24254621d2321` with
`scripts/build-candidate.ts --target linux-arm64` (development identity, fixture
build; not a release). Handover fixtures written by root to
`/etc/lazurio/lazurio.machine.json`, `root:root` mode `0644`, one per scenario, with
`operator.os_user: admin`; the CLI run as `admin` under umask `077`. Nothing below is
private: the handovers are the synthetic conformance fixtures of this repository
(`example`, `sample-team`, `Example/infra`).

Scenarios and outcome (all as expected): derived presets for the three handover
kinds; explicit allowed override (`--preset hosted-organization-team --locale cs
--detail technical`) recorded as `explicit`; adoption of a non-empty
`organizations/` and `personalspace/` with `launchpad.gen3.json` present; re-run
reports `already-adopted` with `AGENTS.md` byte-identical and `personalspace/`
untouched; `preset-not-allowed` for an Organization preset on a personal VM;
`folder-foreign-entry` naming the entry; `folder-personalspace-conflict` with nothing
deleted.

Two defects found on the way and fixed in the same PR, after this log was taken:

1. With Ubuntu's default umask `0002` a hand-created `~/Lazurio` (and its
   children) is `0775`; `folder-init` refused correctly but reported only the generic
   "Folder operation failed…" with exit 1. It now refuses before any mutation with
   `{"kind":"blocked","reason":"folder-directory-shared","entry":…}` and exit 2, and
   the resident precondition is documented in `docs/machine-handover.md`.
2. An unknown option (`machine folder-init --json`) ended in the same generic
   message. It is now a usage error: the `machine` help on stderr and exit 2.

Not proven by this run: a real Machines-delivered VM (the handovers were fixtures
written by hand as root), a native Launchpad preset change, and the fixed reporting
above on the VM (covered by unit tests on the head that fixes it).

## Verbatim log

```text

== A. personal-vm handover, personalspace with content, launchpad.gen3.json present
{"kind":"machine-context-observed","context":{"schema_version":"lazurio.machine.v1","machine":{"id":"example-personal","kind":"personal-vm","name":"example","vmid":901},"owner":{"kind":"principal","github_login":"example","github_id":12345},"operator":{"os_user":"admin","home":"/home/admin","lazurio
{"kind":"initialized","revision":1,"preset":{"name":"hosted-personal","version":1,"selection":"derived"},"machineContextDigest":"a8e5817d69ef8724c66dfd1cdeba58b35cae0c5b3d40441d3c66f1833be3529e"}
exit=0
--- top level:
.lazurio
AGENTS.md
launchpad.gen3.json
organizations
personalspace
--- AGENTS.md head:
# Lazurio
<!-- base-instructions-2; {"preset":"hosted-personal","profile":{"os":"linux","access":"remote","purpose":"human","locale":"en","detail":"concise","coordination":"direct"}} -->
## This Machine
- Preset: `hosted-personal` (version 1).
- Machine: `example` (personal-vm).
- Owner: the Principal with GitHub login `example` (id 12345). This is their one personal hosted Machine.
- Principal: the Machine's Owner. Agents here act for them within their rights; a Buddy is an optional resident of this same Machine.
- Tailnet: Headscale node `example`.
- Host: provider-estate `example-estate`; a higher administration and recovery domain than this Machine.
## Boundaries
- Personalspace: `personalspace/` is the intimate space of exactly one Principal and their optional Buddy. Nobody else reads it and it is never shared.
- Organizations: no Organization repositories are mounted on a personal Machine. Organization work happens on Machines the Organization owns.
- Identity: the Principal's own sign-ins; GitHub is the only access authority.
## How work is done here
- Communicate in English unless the user requests otherwise.
- Lead with the outcome and explain concisely.
- Work directly within task scope and available tools.
- Your work is a Draft in a worktree and a pull request; Publication (merge, deploy, send) belongs to the Principal and needs their explicit instruction in the current thread.
- Before Organization work, load its current AGENTS.md; the overarching rules are the Lazurio root (`HumanAndMachines/Lazurio`, AGENTS.md). This document does not replace them.
- Verify the execution Machine's OS (linux); remote access changes neither identity nor permissions. Verify live identity and rights for connected operations; a local checkout is not proof of permission.
- A profile grants no access, publication mandate or background-work authority. Do not read another Principal's Personalspace or copy credentials.
- Preserve existing Organizations and Personalspace paths and content. Profile language neither renames folders nor translates user data.
- Report missing tools, unverified rights and unknown state; do not invent available capabilities or successful completion.
--- .lazurio:
history
instructions.json
preferences.json
{"schemaVersion":2,"revision":1,"preset":{"name":"hosted-personal","version":1,"selection":"derived"},"machine":{"contextDigest":"a8e5817d69ef8724c66dfd1cdeba58b35cae0c5b3d40441d3c66f1833be3529e","kind":"personal-vm","name":"example","owner":{"kind":"principal","githubLogin":"example","githubId":12345},"network":{"headscaleHostname":"example"},"host":{"kind":"provider-estate","id":"example-estate"}},"profile":{"os":"linux","access":"remote","purpose":"human","locale":"en","detail":"concise","coordination":"direct"},"customInstructions":""}
== A2. re-run: already-adopted, nothing changed
{"kind":"already-adopted","revision":1,"preset":{"name":"hosted-personal","version":1,"selection":"derived"},"machineContextDigest":"a8e5817d69ef8724c66dfd1cdeba58b35cae0c5b3d40441d3c66f1833be3529e"}
exit=0
AGENTS.md unchanged
notes.md

== A3. explicit organization preset on a personal-vm handover must be refused
{"kind":"blocked","reason":"preset-not-allowed","derived":"hosted-personal","allowed":["hosted-personal"],"next":"Choose a preset the handover allows, or omit --preset for the derived one."}
exit=2

== A4. foreign top-level entry refused by name
{"kind":"blocked","reason":"folder-foreign-entry","entry":"stray.txt","next":"Move this entry out of the Folder; only organizations/, personalspace/ and the two legacy launchpad files may be present."}
exit=2

== B. workspace-vm with team → hosted-organization-team; empty personalspace precreated
{"kind":"initialized","revision":1,"preset":{"name":"hosted-organization-team","version":1,"selection":"derived"},"machineContextDigest":"d0d020cec48833df53f17eb75f97e9e7b3a14e4a74f29f6dda58682aada87791"}
exit=0
<!-- base-instructions-2; {"preset":"hosted-organization-team","profile":{"os":"linux","access":"remote","purpose":"human","locale":"en","detail":"concise","coordination":"direct"}} -->
- Preset: `hosted-organization-team` (version 1).
- Owner: Organization `example`, Team `sample-team`.
"name":"hosted-organization-team"
"name":"workspace"

== B2. used personalspace on an organization preset → refused, nothing deleted
{"kind":"blocked","reason":"folder-personalspace-conflict","entry":"personalspace","next":"An Organization preset never has a Personalspace; move it away yourself, nothing is deleted."}
exit=2
keep.md

== C. workspace-vm without team → hosted-organization-personal; explicit team preset allowed
{"kind":"initialized","revision":1,"preset":{"name":"hosted-organization-personal","version":1,"selection":"derived"},"machineContextDigest":"dfcf8e659f8d250e0cdc0b0d73d59ff017a6bf40d0015d54183d4efcc5473932"}
exit=0
"name":"hosted-organization-personal"
{"kind":"initialized","revision":1,"preset":{"name":"hosted-organization-team","version":1,"selection":"explicit"},"machineContextDigest":"dfcf8e659f8d250e0cdc0b0d73d59ff017a6bf40d0015d54183d4efcc5473932"}
exit=0
# Lazurio
<!-- base-instructions-2; {"preset":"hosted-organization-team","profile":{"os":"linux","access":"remote","purpose":"human","locale":"cs","detail":"technical","coordination":"direct"}} -->
## Tahle Mašina
- Preset: `hosted-organization-team` (verze 1).
- Mašina: `workspace` (workspace-vm).
- Owner: Organizace `example`.
- Principál: Kolega, který se právě připojil. OS účet je sdílený členy Teamu a není osoba; změny se připisují Teamu přes brokerovanou identitu Organizace.
- Tailnet: Headscale node `example-workspace`.
- Host: virtualization-host `example-host`; vyšší doména správy a obnovy než tahle Mašina.
## Hranice
- Personalspace: na Mašině vlastněné Organizací nikdy není. Nezakládej ho, nemountuj ho a nekopíruj sem osobní data ani přihlášení.
- Organizace: repozitáře žijí v `organizations/<org>/`; každá Organizace je vlastní access hranice a vlastní git repozitář.

== D. --version
lazurio 0.0.0-development (commit 0000000000000000000000000000000000000000, target linux-arm64)
```
