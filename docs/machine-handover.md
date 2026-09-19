# Machines handover consumer — limited Linux pilot

Machines owns provisioning, networking, firewall, SSH and the infrastructure
gateway. Platform owns the environment inside the delivered Machine. This boundary
does not authorize deployment, restart, access changes or resident removal.

## One upstream contract

Machines writes `/etc/lazurio/lazurio.machine.json`, root-owned and non-shared,
after successful managed handover. Platform only reads it. The exact upstream
JSON Schema is vendored in `src/machine/lazurio-machine.v1.schema.json`; adjacent
`schema-provenance.json` records the authorized source commit and byte digest.
Changes originate in Machines, then the consumer is re-pinned and conformance
tested. No runtime dependency on a private checkout. The test fixture is synthetic,
not a customer's rendered identity. The pin is a PR candidate, not evidence that
the Machines change has been merged/deployed.

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

The handover has no selected-preset field. Platform does not derive `hosted-private`
or `hosted-team` from the presence of `team`, the Machine name, the hostname or the
operator name. The [workspace preset](workspace-presets.md) is chosen explicitly at
setup and stored in the Environment configuration. If preset provenance must appear in
this file, that is an upstream schema change in Machines followed by a re-pin and
conformance test here, exactly like any other field.

A repeated infrastructure apply must preserve the Machine identity, the Folder
content and the Platform-selected product version; Machines does not reselect the
version after handover, and Platform does not rewrite the identity.

## Consumer commands

Run the installed CLI as the declared operator, not root:

```sh
lazurio machine inspect
lazurio machine folder-init --locale cs --detail technical --coordination direct
```

The second command is the narrow Linux/remote/human pilot entrypoint. Locale,
detail and coordination are explicit choices, not inferred from identity. It binds
the declared user/home to the actual UID's Linux NSS record (not `$USER`/`$HOME`) and requires
`operator.lazurio_root` to be that user's `/home/<user>/Lazurio`. The wire name
remains `lazurio_root`; the product concept is **Lazurio Folder**. There is no CLI
override for the production identity path or UID.

The Linux base system must provide root-owned `/usr/bin/getent`; it is called
without a shell, with a fixed `passwd <uid>` query and sanitized environment.
Missing/unsafe resolver or ambiguous output stops as `machine-operator-unavailable`.
We deliberately do not use Bun 1.4.2 `os.userInfo()` here: native ARM64 qualification
observed that its username depends on the ambient environment. No dependency on
a separately installed Bun is introduced by the system account lookup.

The shared Folder initializer accepts exactly a canonical operator-owned Folder
with empty `organizations/` and `personalspace/`, both owned and non-shared. Their
paths, filesystem identities and modes remain unchanged. A manifest, checkout,
instructions, existing `.lazurio`, extra entry, symlink or nonempty work directory
stops initialization. No resident cleanup/adoption. Normal `folder-init` remains
fresh-path-only; this is a narrow explicit entry into the same core.

Initialization exclusively creates `.lazurio`, journals the preexisting layout
identities and writes new instructions/preferences/manifest exclusively. Two
initializers cannot both claim state. No Organization is cloned yet: owner binding
and module delivery remain separate pilot gates.

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

Product update repair follows [pilot repair](pilot-repair.md): retain accepted TUF
trust and the previous working product. Folder handover does not change that rule.
The local filesystem boundary assumes no hostile concurrent same-user/root
directory replacement; ownership checks are not a sandbox.

## Qualification boundary

A clean committed checkout can produce a Linux glibc candidate from the Mac:
`bun run scripts/build-candidate.ts /absolute/absent/output --target linux-x64`.
Use `linux-arm64` for the local ARM64 VM. The target and artifact digest in
`identity.json` describe the destination bytes, not the build host. The native
build remains available without `--target`. Cross-compilation is only packaging;
it does not qualify either architecture. See [Bun's executable targets](https://bun.sh/docs/bundler/executables).

Unit fixtures prove parsing/refusal, directory preservation and recognized
interruption completion. They do not prove actual Machines delivery, official
HTTPS/TUF hosting, native Linux x64 execution, Organization/module authorization,
gateway operation, agent work, VM restart or the second-VM repeat. Record those
separately at exact source/artifact revisions. The real pilot must exercise the
installed binary and root-issued file under the non-root operator account.
