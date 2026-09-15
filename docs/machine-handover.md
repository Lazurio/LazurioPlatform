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
remains null. Organization/provider binding, revision and live access must come
from the owner/provider; a slug is not a repository URL or access grant. Inspection
output contains private context: keep it in the owner's scope, not public logs.

## Consumer commands

Run the installed CLI as the declared operator, not root:

```sh
lazurio machine inspect
lazurio machine folder-init --locale cs --detail technical --coordination direct
```

The second command is the narrow Linux/remote/human pilot entrypoint. Locale,
detail and coordination are explicit choices, not inferred from identity. It binds
the declared user/home to `os.userInfo()` (not `$USER`/`$HOME`) and requires
`operator.lazurio_root` to be that user's `/home/<user>/Lazurio`. The wire name
remains `lazurio_root`; the product concept is **Lazurio Folder**. There is no CLI
override for the production identity path or UID.

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
