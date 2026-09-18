# Product update

Status: **accepted direction of the Principal (2026-09-19), implementation in
progress.** This document is the single contract for how an installed Lazurio
learns about, obtains and activates a new product version. It supersedes the
update-related *proposals* in [release cycle](release-cycle.md) and the deferred
recovery designs in [pilot repair](pilot-repair.md) and
[expired trust recovery](expired-trust-recovery.md); trust, signing and promotion
requirements stated there remain binding. Nothing is deployed to real clients on
this codebase yet, so this contract is written without a compatibility burden.
After the first client deployment every change to it must be compatible.

## What the Principal asked for

1. Update is a **conscious step**. Lazurio never activates a new version behind
   the user's back.
2. Availability is shown **continuously**: a Machine never silently stays on an
   old version.
3. When the user clicks, the update **always and dependably happens**. A failed
   attempt never leaves a state that needs manual repair before the next click.
4. Small, clean mechanism. No machinery without a consumer.

The model for the user experience and the release workflow is T3 Code's desktop
updater: a small explicit state machine, a poller in the long-running app, a
pill in the UI (`available → downloading → ready → restart`), release notes,
failures that fall back to `available` with a retry, and a tag-driven CI release
that publishes every platform at once.

## Invariants

- **One core.** CLI and Launchpad call the same update use case. There is no
  second updater and no shell-script installer logic outside the product.
- **Explicit activation.** Checking and showing availability are automatic;
  download and activation start only from `lazurio update` or the Launchpad
  action. A managed policy may later request an update, never silently perform
  one on a Machine with a working person.
- **No wedge.** Every failure leaves the installed product usable and the next
  attempt possible. There is no pending-attempt state, no `recover` command and
  no journal that a later run must replay.
- **Trust never rewinds.** TUF metadata accepted during any attempt — above all
  a rotated root — is persisted durably the moment it is accepted, independently
  of whether the artifact download later succeeds. Program rollback never
  touches trust.
- **Program rollback is not data rollback.** A version is staged only when the
  signed identity proves it can read the current Folder state; rollback is
  offered only to a version that can still read what the newer one wrote.
- **Running work is never killed to finish an update.** The switch changes what
  future launches select; a running Launchpad keeps its immutable executable
  (`process.execPath` resolves to the versioned path, verified on macOS and
  Linux) until it restarts.
- **Self-hosted works alone.** No Human and Machine service is needed to check,
  download, verify or activate. Managed policy, fleet visibility and analytics
  are additive consumers of the same local state.

## State on disk

The install base stays per user and outside the Folder (see release cycle). It
tolerates unknown entries: it verifies only what it owns, so a stray file or a
neighbouring legacy runtime can never stop product commands, and an older binary
never refuses a newer layout.

```text
bin/lazurio -> ../versions/<version>+<sha16>/lazurio   # the only active selector
versions/<version>+<sha16>/{lazurio,identity.json}      # immutable
trust/                                                  # durable accepted TUF metadata
update/state.json                                       # what the user sees
update/intent.json                                      # present only during activation
update/quarantine.json                                  # artifact digests that failed their gate
update/scratch-*/                                       # always safe to delete
```

`update/state.json` is the whole user-visible truth, deliberately shaped like
T3 Code's: `status` (`idle | checking | up-to-date | available | downloading |
ready | activating | restart-pending | error`), `channel`, `currentVersion`,
`availableVersion`, `stagedVersion`, `releaseNotes`, `downloadPercent`,
`lastAttemptAt`, `lastAuthenticatedCheckAt`, `lastActivationAt`, `error`
(`code`, `context`, `message`) and `canRetry`. Four timestamps stay separate on
purpose: a successful check does not imply a converged Machine.

The active version is recorded once, by the symlink. `update/intent.json`
(`previous`, `candidate`, `phase`) exists only between the decision to switch and
the confirmed health of the new version; any later start of any `lazurio` reads
it and either completes the confirmation or restores `previous`. Intent decides
recovery; logs only explain it.

## The three steps

**Check** (automatic, cheap, no mutation of the product). Refresh TUF metadata
against the durable `trust/` directory, persisting each accepted role atomically
(root chain first). Read the signed channel document. Compare with the embedded
version. Write `state.json`. Network or expiry failures produce a typed error and
leave everything else untouched.

**Download** (explicit). Resumable ranged download with bounded retries and one
total deadline, into scratch. Verify length and digest against signed targets,
verify the signed identity (target, version, schema read-compatibility, minimum
updater contract). Run the **staged executable by its immutable path** in
self-check mode: it must report the embedded identity that matches the signed
one and read the current Folder state without writing. Only then rename into
`versions/`. A digest in quarantine is never downloaded again; identical bad
bytes do not become good because a sequence advanced.

**Activate** (explicit, part of the same click unless the user chose "download
only"). Write intent, swap the symlink by rename, then converge the running
Launchpad:

- no applications running → the Launchpad restarts itself (exit under its
  supervisor, re-exec otherwise); a short-lived observer started from the *new*
  binary waits for a readiness response carrying the expected artifact digest;
- applications running → status `restart-pending`; the UI offers "Restart now"
  naming what will stop. Module applications are owned by guards that stop when
  their Launchpad exits; giving them independent OS supervision so they survive
  a restart is a separate, later change and is not faked here;
- readiness not confirmed within the bound → restore `previous`, restart it,
  quarantine the candidate, report a typed error. The user is back on a working
  version and the pill says why.

One lock covers a whole step, acquired blocking with a timeout; lock
initialization is crash-safe; the lock works on any local filesystem that
provides `flock`.

Retention: active, previous and any version still running are kept; everything
else, all scratch and superseded trust files are pruned after a confirmed
activation. Disk is checked before download.

## Surfaces

- **Launchpad.** Poller: first check shortly after start, then every few minutes
  with jitter (the check is one small signed document). Pill with version, notes
  and the single action appropriate to the status. The Launchpad shows when the
  running version differs from the active one.
- **CLI.** `lazurio update` (check, download, activate), `lazurio update --check`,
  `lazurio update status [--json]`, `lazurio update rollback`, `lazurio --version`.
  Other commands print a one-line notice from `state.json`; they never touch the
  network for it. Every failure has a stable error code and a non-zero exit
  status that automation can classify.
- **Identity in the binary.** Version, commit and target are embedded at build
  time, together with the TUF root and the default origin. A local
  `update/config.json` holds only the channel.

## Never silently stale

1. Local: the pill and the CLI notice, fed by the poller.
2. Signed: the channel document carries `minimum_version`; below it the
   Launchpad shows a prominent, non-blocking notice. A disconnected Machine
   cannot learn newer policy, therefore:
3. Observed: `state.json` is the contract that an outside observer reads. A
   missing or old `lastAuthenticatedCheckAt`, a version behind the channel, or a
   long `restart-pending` is a failure for whoever watches the fleet. Today that
   observer is the Machines readback on hosted Machines; later it is the
   managed service once a Machine is enrolled through Lazurio Account. An
   unused installation that nobody observes gets an OS-scheduled check only when
   a real consumer needs it; it is not part of the first delivery.

## Foundations for the managed product (not built now)

Lazurio Account login in the Launchpad, a Machine profile selected in the
Dashboard and internal usage analytics all use one direction of authority:
the service expresses **desired state with a revision**, the Machine-local core
pulls it, validates it like any other input and applies it through the same use
cases the CLI uses; the Machine reports **observed state** (`state.json`, profile
digest, coarse consented usage). Login never becomes local authority, analytics
can never block an update, and measurement stays default-off and consent-bound
as in [profile evidence](profile-evidence.md). The update work lays exactly two
foundations for this: the observed-state document and typed, revisioned inputs.
It adds no enrollment, no heartbeat and no generic maintenance framework.

## Publishing

Tag-driven workflow modelled on T3 Code: quality gates, deterministic builds for
the supported targets, one GitHub Release with all artifacts and generated
notes, then publication of signed metadata.
Channels are `stable` and `preview`; promotion edits the signed channel document
to point at the same bytes. Each channel has its own sequence floor; switching
channel is explicit and never downgrades.

TUF stays (accepted decision; rotation, expiry and rollback protection are not
worth re-implementing). Root is offline with the Principal. The targets key
authorizes releases and lives behind a protected CI environment with a required
approver. Snapshot and timestamp keys serve freshness only and are renewed by a
scheduled job **well before** expiry, with monitoring of every role's remaining
validity; a lapsed timestamp would stop every Machine from updating.

There is one origin and no new infrastructure: GitHub Releases of this public
repository. Each product release carries its artifacts; one fixed metadata
release carries the TUF metadata and channel documents as replaceable assets at
stable URLs. The client maps `artifacts/<digest>/…` to the asset URL explicitly
and the redirect origins are qualified by test, not assumed. A second origin is
added only when a real consumer (a private fork, an air-gapped customer) needs
it; the transport already takes the origin as configuration.

## Deliberately narrow

Elegance here means a small number of paths that are each proven, not coverage
of every combination.

- **Targets:** `linux-x64` (hosted Machines) and `darwin-arm64` (workstations)
  are supported; `linux-arm64` is built because the local qualification VM is
  ARM64. Intel macOS, musl and Windows are not built until a real user needs
  them; Windows gets its own activation design then, not a port of this one.
- **Install scope:** per user only. No system-wide install, no multi-user
  sharing of one base. A hosted Team Workspace is one Machine with one OS user,
  so it is the same case as a private workspace.
- **One channel document format, two channels, one origin.**
- **One supervisor per OS:** a systemd user unit on Linux, a launchd agent on
  macOS, or the terminal that started the Launchpad. Nothing else is detected.
- **No automatic activation, no OS scheduler, no enrollment, no heartbeat** in
  this delivery. Each arrives with its first real consumer.
- **No migration of the legacy installer state.** Nothing is deployed, so the
  pilot layout (`active.json`, attempts, history, generations) is removed, not
  adopted.

## Evidence required before any Machine depends on this

CI builds two real versions and proves, against a fixture repository and then
natively on Linux (x64, ARM64) and macOS ARM64: A→B, confirmed restart, automatic
rollback of an unhealthy B and quarantine, B′ after quarantine, `kill -9` at
every step of every phase, expired timestamp, repository advancing mid-update,
root rotation accepted during a failed download and retained, full disk, unknown
files in the base, two concurrent updates, update while applications run. The
same journey then runs on a hosted canary Machine.

## Removed by this contract

The write-ahead metadata journal, transcript replay, historical role floors,
recovery cycles, attempt history, `product recover`, the double active record and
the refusal of unknown base entries. Their security purpose — never losing
accepted trust — is kept by durable per-role persistence, which is smaller and
cannot wedge.
