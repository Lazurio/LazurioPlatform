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
3. When the user clicks, the update **dependably happens**: every failure is
   bounded, leaves the installed product working, and the same click works again
   once the outside condition (network, disk, a published compatible release)
   is restored. No failed attempt needs manual repair first.
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
  attempt possible. Delivery state is disposable: no pending download attempt,
  no `recover` command, no journal to replay. The only transaction record is
  the small activation record below, with a fixed set of transitions that any
  later start can finish or undo on its own.
- **Trust never rewinds.** TUF metadata verified during any attempt — above all
  a rotated root — is promoted into the durable trust directory whether or not
  the rest of the attempt succeeds. Channel sequence and document-digest floors
  are security state too and live beside it, not in the presentation state.
  Program rollback never touches either.
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
tolerates unrelated entries: it verifies only what it owns, so a stray file or a
neighbouring legacy runtime can never stop product commands. Owned security
state carries a schema version; a binary refuses a newer schema it cannot read
rather than guessing, and a version is offered for rollback only if it can read
the current one.

```text
bin/lazurio -> ../versions/<version>+<sha16>/lazurio   # the only active selector
versions/<version>+<sha16>/{lazurio,identity.json}      # immutable
trust/                                                  # durable verified TUF metadata + channel floors
update/activation.json                                  # present only during an activation
update/observed.json                                    # derived observation for UI, CLI and observers
update/scratch-*/                                       # always safe to delete
```

`update/observed.json` is an observation, never an authority. It is shaped
like T3 Code's update state — `status` (`idle | checking | up-to-date |
available | downloading | ready | activating | restart-pending | error`),
`channel`, `releaseNotes`, `downloadPercent`, `error` (`code`, `context`) and
`canRetry` — and keeps four facts apart because a successful check does not
imply a converged Machine: the **selected** artifact (the symlink), the
**running** Launchpad artifact, the **verified available** target and the
**last healthy activation**, each with its time. It carries a schema version,
an observation time and the operation identity, holds error codes rather than
localized prose, and is rebuilt from the selector, the verified artifacts and
the service manager after any crash, so a stale `downloading` can never stick.
Fleet observers read a sanitized subset.

The active version is recorded once, by the symlink. `update/activation.json`
(`previous`, `candidate`, `phase`, `deadline`) exists only between the decision
to switch and the confirmed health of the new version. Its transitions are
fixed: `switching → confirming → confirmed | rolled-back`. It decides recovery;
logs only explain it.

## The three steps

**Check** (automatic, cheap, no mutation of the product). The TUF client
refreshes in a scratch copy seeded from `trust/`; it writes a role file only
after verifying it. When the refresh ends — success or failure — every newly
verified role is promoted into `trust/` by temporary file, file sync, rename and
directory sync, root chain first, then timestamp, snapshot, targets. A crash
before promotion equals a refresh that never ran; a crash between promotions
leaves a newer root with older roles, which the next refresh re-verifies under
that root. This needs no change to the pinned `tuf-js` and is proven by
interruption, expiry, repository-advance and key-rotation tests before the old
journal and replay code is deleted. Then read the signed channel document,
compare with the embedded version and rewrite `observed.json`. Network or
expiry failures produce a typed error and leave everything else untouched.

**Download** (explicit). Resumable ranged download with bounded retries and one
total deadline, into scratch. Verify length and digest against signed targets,
verify the signed identity (target, version, schema read-compatibility, minimum
updater contract). Run the **staged executable by its immutable path** in
self-check mode: it must report the embedded identity that matches the signed
one and read the current Folder state without writing. Only then rename into
`versions/`. A candidate that failed its gate is not offered again
automatically; an explicit retry re-runs the full cryptographic and readiness
gate, so a transient environmental failure is not a permanent verdict and bad
bytes still never pass.

**Activate** (explicit, part of the same click unless the user chose "download
only"). The activation is driven by a short-lived **activation worker started
from the previous, known-good immutable binary**, outside the Launchpad's
termination group and under the OS service manager, because a candidate that
cannot start cannot supervise its own rollback. The worker writes the activation
record, swaps the symlink by rename and restarts the Launchpad service. It then
requires readiness from a **fresh instance**: a new process that reports the
expected artifact digest, Folder and protocol compatibility, and stays healthy
for a bounded stability period; an old process answering, or a bare HTTP 200,
proves nothing. It distinguishes a candidate that fails from a gateway that is
down. Confirmed → record removed, retention applied. Not confirmed within the
deadline → symlink restored to `previous`, service restarted, typed error
reported; the user is back on a working version and the pill says why. After a
reboot mid-activation the service manager restarts the worker, which finishes
from the record. A CLI started meanwhile coordinates with the worker through the
record and never undoes its switch.

The Launchpad restart is harmless because long-running module applications are
owned by the OS service manager, not by the Launchpad process (see
[module adoption](module-adoption.md); on Linux systemd user services). Where
that ownership is not yet available (macOS workstations run applications for
the Launchpad session), running applications turn the step into
`restart-pending` and the UI offers "Restart now" naming what will stop.

No Folder data is written in a new format until the activation is confirmed, so
the rollback window never needs a data downgrade.

One lock covers a step, acquired blocking with a timeout; lock initialization is
crash-safe; the lock works on any local filesystem that provides `flock`. The
lock is released before the worker waits for the restarted Launchpad, which
needs it to start.

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
  Other commands print a one-line notice from `observed.json`; they never touch the
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
3. Observed: `observed.json` is the contract that an outside observer reads. A
   missing or old `lastAuthenticatedCheckAt`, a version behind the channel, or a
   long `restart-pending` is a failure for whoever watches the fleet. Today that
   observer is the Machines readback on hosted Machines; later it is the
   managed service once a Machine is enrolled through Lazurio Account. An
   unused installation that nobody observes gets an OS-scheduled check only when
   a real consumer needs it; it is not part of the first delivery.

## Foundations for the managed product (not built now)

Lazurio Account login in the Launchpad, a Machine profile selected in the
Dashboard and internal usage analytics all use one direction of authority:
the service sends **typed, resource-specific requests with an expected local
revision** (a profile revision, a channel, never a generic desired-state
document), the Machine-local core
pulls it, validates it like any other input and applies it through the same use
cases the CLI uses; the Machine reports **observed state** (`observed.json`, profile
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

Publishing is atomic and needs no new infrastructure. The TUF repository uses
**consistent snapshots**: numbered roots, snapshots and targets and
hash-addressed artifacts are immutable and never replaced. Artifacts are assets
of the product's GitHub Release. Metadata and channel documents are a static
tree published through GitHub Pages of this repository, where one deployment
replaces the whole tree at once; the publisher uploads artifacts, verifies that
everything the new metadata references is reachable, and only then publishes the
tree, timestamp last. Old referenced objects are retained so a cached timestamp
always describes a complete repository. The client maps `artifacts/<digest>/…`
to the asset URL explicitly and qualifies the redirect origins by test. A second
origin is added only when a real consumer (a private fork, an air-gapped
customer) needs it; the transport already takes the origin as configuration.

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
- **One supervisor per OS:** systemd user services on Linux own the Launchpad,
  the activation worker and module applications. On macOS the Launchpad and its
  applications are session-scoped until a workstation consumer needs more.
- **No automatic activation, no OS scheduler, no enrollment, no heartbeat** in
  this delivery. Each arrives with its first real consumer.
- **No migration of the legacy installer state.** Nothing is deployed, so the
  pilot layout (`active.json`, attempts, history, generations) is removed, not
  adopted.

## Evidence required before any Machine depends on this

CI builds two real versions and proves, against a fixture repository and then
natively on Linux (x64, ARM64) and macOS ARM64: A→B, confirmed restart, automatic
rollback of an unhealthy B, explicit retry, `kill -9` of the worker and reboot at
every step of every phase, expired timestamp, repository advancing mid-update,
root rotation accepted during a failed download and retained, full disk, unknown
files in the base, two concurrent updates, update while applications run. The
same journey then runs on a hosted canary Machine.

## Removed by this contract

The write-ahead metadata journal, transcript replay, historical role floors,
recovery cycles, attempt history, `product recover`, the double active record and
the refusal of unrelated base entries — **after** the interruption, expiry and
rotation tests above prove that durable per-role promotion preserves the same
trust. Their security purpose is kept by a mechanism that is smaller and cannot
wedge.
