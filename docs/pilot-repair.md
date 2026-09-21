# Controlled pilot: bounded update failure and explicit repair

> **Superseded for product update (2026-09-19).** The accepted contract for
> checking, downloading, activating and rolling back a product version is
> [product update](update.md). This runbook and `product recover` describe the pilot installer that is still the code on `main`; they are not the target mechanism and are removed together with that code (decision F13: there is no product-held trust metadata any more). The preservation principles below (prepare beside the active version, never reset trusted metadata, never bootstrap an established installation again) remain binding.

Accepted scope decision, 2026-09-15. This replaces a requirement to finish general
automatic expired/inconsistent-transcript recovery before the first usable pilot.
It is a contract and runbook boundary, not evidence that all scenarios already pass.

## Product contract

1. Prepare and verify the candidate beside the active immutable version. Preparing
   an update must not change the active record, stable entrypoint or working data.
2. A failed preparation stops with a diagnosis. The previous product remains usable.
   On first install, where no previous product exists, report incomplete installation;
   do not claim there is a working version to fall back to.
3. Retry only through supported commands under the existing installation owner.
   When ordinary retry is insufficient, an agent follows an explicit repair procedure.
4. General automatic recovery across repeated failures, metadata expiry and changing
   repositories is deferred. Preserve completed safety checks; do not weaken trust
   verification to make retry succeed.

One-way migration of the old source checkout/Lazurio Folder is a separate operation.
It does not authorize damaging a working product during an unsuccessful update.
Activation remains explicit and separately qualified; preparation failure is not an
activation transaction and must not require rolling the active product back.

## Bounded procedure for an agent

- Inspect the selected installation with read-only status and record the exact active
  version, pending attempt, error stage and diagnostic result. Do not collect secrets.
- Distinguish download/network/resource failure from damaged installation custody,
  inconsistent active records, missing trusted selection or failed verification.
- For an environmental failure, repair only the identified cause (for example restore
  connectivity, free unrelated disposable space or correct a verified clock problem).
  Never backdate time to accept expired metadata or bypass TLS/signature checks.
- Use the existing supported recovery/retry path with the same owner-bound trust.
  Confirm the previous product is still callable before retry and after a refusal.
- Temporary-file cleanup requires a specific, documented ownership and dependency
  check: exact paths, no live writer/reference, no accepted-trust or recovery evidence.
  Naming a file `tmp`, `cache` or `pending` is not sufficient. There is no blanket
  permission or generic delete command in this runbook.
- If the state cannot be repaired by an implemented and tested procedure, stop the
  update, retain evidence and escalate with a precise diagnosis. Continue using the
  old product if independently verified intact. Do not synthesize a trusted state.

Never delete/reset trusted metadata, selected generations, channel high-water,
pending received-metadata journals or original trust inputs to unblock installation.
Never bootstrap an established installation again, edit signatures/expiry or adopt
an arbitrary cache. Preserve Organizations, Personalspace and all working data.
Damaged installation state is not a fresh install or disposable failed download.

## Pilot evidence still required

### Qualified development case: interrupted snapshot delivery

The installed-journey runner now exercises this bounded procedure with still-valid
metadata from an unchanged loopback repository:

1. An installed CLI encounters a transport refusal after receiving the next
   timestamp, before receiving its snapshot. Record the failure and inspect
   `lazurio product status`; verify the existing entrypoint still runs.
2. Restore only the verified transport fault. An ordinary `product install`
   retry is expected to refuse the retained pending attempt; do not delete it.
3. Use `lazurio product recover --metadata-url <same approved metadata URL>
   --target-url <same approved target URL>`. Do not supply a bootstrap root to
   an established installation. This reverifies the retained prefix and completes
   its missing responses; it does not activate a product.
4. Check status, then repeat `product install` with those same approved origins.
   If recovery refuses expired, changed, damaged or otherwise unsupported evidence,
   stop and escalate. This procedure does not authorize a trust reset or cleanup.

In the isolated macOS ARM64 development run, active-record bytes, executable
digest, entrypoint link, generated AGENTS.md and two fixture work files remained
unchanged through failure and recovery; the existing CLI, Folder and declared
Bun-module lifecycle remained usable. The next authenticated channel sequence used
the same artifact: this is not a new-version switch test. The fixture uses an
explicit `--loopback-fixture` flag; real pilot origins must use HTTPS without it.
This is not Linux, live hosted-module, restart or official-delivery evidence.
Current CLI failure text is generic; actionable stage-specific diagnosis remains
an open pilot requirement, not something this successful recovery test proves.

Prove the full clean installation path and a subsequent update on supported native
pilot targets. Inject failed preparation (transport, insufficient resources, invalid
signature/expired metadata) and prove the active version, entrypoint and working data
remain unchanged and usable. Exercise a supported explicit repair/retry case and an
unsupported case that stops safely. Report clear distinctions between these outcomes.

Do not relabel this document or existing helper tests as that acceptance evidence.
No release, Machine activation, key operation or deletion is authorized by this file.
