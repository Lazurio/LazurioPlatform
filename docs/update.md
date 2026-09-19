# Product update

Status: **accepted direction of the Principal (2026-09-19), implementation in
progress.** This document is the single contract for how an installed Lazurio
learns about, obtains and activates a new product version.

Authority boundary. Three older documents described this area and each now
carries a banner pointing here:

| Document | What stays binding there | What this contract supersedes |
| --- | --- | --- |
| [release cycle](release-cycle.md) | build, qualification and promotion lifecycle; the two test modes; signing, key-role, expiry and promotion requirements; install location | the proposed update commands, pending attempts, the metadata journal and replay, the double active record, "draining" as an unimplemented phase |
| [pilot repair](pilot-repair.md) | the preservation principles: prepare beside the active version, never delete or reset trusted metadata, never bootstrap an established installation again | the `product recover` runbook and the bounded manual repair procedure |
| [expired trust recovery](expired-trust-recovery.md) | its threat analysis of accepted-but-unpersisted role floors, which the Check step below answers | the deferred journal-reconstruction work package as a mechanism |

Until the implementing changes replace it, the code on `main` is still the pilot
installer (`product install|recover|status|activate`) with its journal and
replay. That code is the *current implementation*, this document is the
*accepted target*; the old mechanism is deleted only by the change that proves
the equivalence tests listed under Evidence, never by this document alone. Nothing is deployed to real clients on
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
  the rest of the attempt succeeds. The channel document is a TUF target, so
  its rollback is refused by the timestamp, snapshot and targets versions held
  there; it needs no floor of its own. Program rollback never touches trust.
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
trust/                                                  # durable verified TUF metadata
update/activation.json                                  # present only during an activation
update/previous.json                                    # what the last confirmed activation replaced
update/observed.json                                    # derived observation for UI, CLI and observers
update/launchpad-readiness.json                         # written by a running Launchpad, removed at clean exit
update/config.json                                      # channel, recorded service and Folder; tolerant, member by member
update/lock, update/activation.lock                     # flock files; content never read
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
refreshes in a scratch copy seeded from `trust/`. When the refresh ends —
success or failure — trust is captured durably in two ways, by temporary file,
file sync, rename and directory sync, root chain first, then timestamp,
snapshot, targets:

1. **Roles the client persisted.** The pinned `tuf-js` writes a role file only
   after its store accepted it (root: after signature and version checks, before
   expiry; the others: after all checks). Those files are promoted.
2. **Authenticated failure-state floors.** The client also authenticates a newer
   timestamp or snapshot *and then throws* when that role is expired; it keeps
   the role only in memory as its rollback floor and never writes it. Losing it
   would let a later, lower version pass. The fetcher therefore retains the raw
   bytes of every role it delivered; after a failed refresh the role delivered
   last is re-verified independently of the client — signature threshold under
   the promoted root, version not below the trusted one, and for a snapshot the
   version and hash recorded by the trusted timestamp — with expiry deliberately
   ignored. A role that passes is promoted **as a floor only**. Anything that
   fails re-verification is discarded.

Expired metadata never authorizes a target: every refresh re-checks expiry
before accepting the next role, and an expired local role is loaded only as a
version floor, exactly as the TUF specification's intermediate metadata.

A crash before promotion equals a refresh that never ran; a crash between
promotions leaves a newer root with older roles, which the next refresh
re-verifies under that root. This needs no change to the pinned `tuf-js`. The
old journal and replay remain the mechanism until the equivalence tests under
Evidence — interruption, expiry with a newer authenticated floor, repository
advance and key rotation — pass against this path. Then read the signed channel document,
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
reported; the user is back on a working version and the pill says why. A worker
that dies is started again by the service manager (`Restart=on-failure`, a
bounded start limit) and continues its own record under the original deadline.
A transient worker unit does not survive a **reboot**; what does is the record
and the Launchpad service. Every `lazurio` start — each CLI command and the
Launchpad service itself — resumes the record, and a Launchpad that starts with
a record open keeps looking until it is settled: once it has been up for the
stability period it confirms the activation itself, and past the deadline it
restores the previous version and restarts onto it. No human command is needed
in either direction. A CLI started meanwhile coordinates with a live worker
through the record and never undoes its switch.

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
needs it to start. A second `flock`, held by the worker for its whole life and
released by the kernel when it dies, is how every other process tells a live
activation from an abandoned one.

Retention: active, previous and any version still running are kept; everything
else, all scratch and superseded trust files are pruned after a confirmed
activation. Disk is checked before download.

## Surfaces

- **Launchpad.** Poller: first check shortly after start, then every few minutes
  with jitter (the check is one small signed document). Pill with version, notes
  and the single action appropriate to the status. The Launchpad shows when the
  running version differs from the active one.
- **CLI.** `lazurio install` (the running executable proves and stages itself
  as the first version; optionally writes the Launchpad's systemd user unit),
  `lazurio update` (check, download, activate), `lazurio update --check`,
  `lazurio update status [--json]`, `lazurio update rollback`,
  `lazurio update channel [stable|preview]`, `lazurio launchpad --base <dir>`
  (the base a service-managed Launchpad announces readiness in),
  `lazurio --version`.
  Other commands print a one-line notice from `observed.json`; they never touch the
  network for it. Every failure has a stable error code and a non-zero exit
  status that automation can classify.
- **Identity in the binary.** Version, commit and target are embedded at build
  time, together with the TUF root and the default origin. A local
  `update/config.json` holds the channel and what `lazurio install` recorded
  about this Machine: the service that owns the Launchpad and the Folder.

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
to point at the same bytes. The document's `sequence` is ordering information
for people and tools; replay of an older document is refused by TUF. Switching
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
always describes a complete repository. The download location of an executable
is part of its **signed** target metadata (`custom.url`); the client downloads
from that signed URL, verifies the signed length and digest as before, and
follows redirects only to origins on a short compiled-in list that is qualified
by test. A second origin is added only when a real consumer (a private fork, an
air-gapped customer) needs it; the transport already takes the origins as
configuration. Key custody, the one-time ceremony, rotation and the expiry
calendar are in [release keys](release-keys.md).

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
natively on Linux (x64, ARM64) and macOS ARM64 (including the floor case: an
authenticated newer-but-expired timestamp and snapshot are retained and a later
lower version is refused): A→B, confirmed restart, automatic
rollback of an unhealthy B, explicit retry, `kill -9` of the worker and reboot at
every step of every phase, expired timestamp, repository advancing mid-update,
root rotation accepted during a failed download and retained, full disk, unknown
files in the base, two concurrent updates, update while applications run. The
same journey then runs on a hosted canary Machine.

## Implemented so far

The implementation lives in `src/update/` (the old installer in
`src/distribution/` is untouched until the evidence above exists; only its
transport is shared). Two slices exist: **check** (embedded identity,
`lazurio --version`, durable trust promotion, `update/observed.json`,
`lazurio update --check`, `lazurio update status`) and **download → stage →
activate → confirm or roll back** for the CLI (`lazurio update`,
`--download-only`, `lazurio update rollback`, `lazurio self-check`, the internal
`lazurio update apply-worker`), plus **`lazurio install`**. Not built: the
Launchpad poller, pill and action, `restart-pending`, showing release notes
(they are published and signed, nothing reads them yet), the one-line notice of
other commands, `lazurio uninstall` and any repair of an existing installation,
launchd, and every piece of native evidence listed above except the first
native Linux run: the compiled journeys run on the developer's macOS ARM64
inside `bun run check`, and the `systemd-user` path was qualified on a real
systemd 255 on Ubuntu ARM64
([evidence](evidence/update-linux-arm64-2026-09-19.md)). Linux x64, a hosted
canary and an actual reboot are still open. That evidence run used the ad-hoc
loopback fixture; the qualification bundle now serves a repository produced by
the publisher (`scripts/update-fixture-server.ts`), and that bundle has **not**
been run on a Linux Machine yet.

A third slice adds the **publishing side** and the client's defaults: the
publisher core (`src/publish/`), the key tool and the publisher command line
(`scripts/release-keys.ts`, `scripts/release-publish.ts`), the release and
refresh workflows, the signed download location, the compiled-in repository,
origins and trust root (`src/update/defaults.ts`), and the recorded channel
with `lazurio update channel`. **None of it has run against GitHub**: no key
ceremony was performed, `release/root.json` does not exist, no secret,
environment, Pages site, DNS record, tag or release was created, and neither
workflow has ever executed. Until the ceremony every build embeds no root, and
`lazurio install` and `lazurio update` answer `trust-missing` — creating
nothing — without `--bootstrap-root`.

Concrete choices fixed so far:

- **`trust/` layout.** `root.json` is the current trusted root and the only
  anchor the TUF client is seeded with; `<N>.root.json` is the retained verified
  chain; `timestamp.json`, `snapshot.json`, `targets.json`. Only these names are
  read; anything else is ignored. Promotion order is the numbered chain,
  `root.json`, timestamp, snapshot, targets, and `trust/` always holds a prefix
  of that order.
- **No channel floors.** An earlier revision kept `channel-floors.json`. It was
  removed: an older channel document can only arrive under older targets
  metadata, which the TUF client refuses against `trust/` (proven by replaying
  a once-valid repository state and by substituting the older document alone).
  `sequence` stays in the signed document as ordering information.
- **Damaged trust never wedges.** A role file that cannot be read or is not
  JSON counts as absent: it is fetched again, verified under the root and
  replaced (a directory in its place is removed). A `root.json` that cannot be
  read or does not verify is restored from the retained chain: the newest
  `<N>.root.json` that carries its version, verifies itself and — when its
  predecessor is retained — verifies as that predecessor's successor. Nothing
  is lost and no rotation is rewound. Only without a usable retained root does
  a supplied root seed trust again (seeding no older role, so that one refresh
  runs without the old roles' rollback protection); without either the answer
  is the typed `trust-invalid`. Promotion rewrites `root.json` in every case.
- **When the pinned client persists.** Verified in the `tuf-js` 6.0.0 source
  and recorded with line references in `src/update/trust.ts`: timestamp,
  snapshot and targets are persisted only after complete verification including
  expiry; a root is persisted after complete authenticity verification but
  before the final-root expiry check, and is promoted regardless because a
  signed successor root must never be forgotten. Promotion re-verifies the root
  chain itself.
- **Authenticated failure-state floors.** The earlier rule "withhold the role
  delivered last in a failed refresh" is replaced. The fetcher retains the raw
  bytes of the role delivered last (only that one has a consumer); after a
  failed refresh promotion re-verifies it without the client and without
  expiry — timestamp: signature threshold under the promoted root, version
  above and snapshot version not below the trusted timestamp; snapshot: length
  and hashes recorded by the newest authenticated timestamp, signature
  threshold, exactly the version that timestamp names, no targets version below
  the trusted snapshot — and writes it as the ordinary role file. Verified in
  the pinned source, with line references in `src/update/trust.ts`: an expired
  LOCAL timestamp or snapshot is installed in memory before the expiry throw
  and the throw is swallowed (`store.js:89-91`, `:133-136`;
  `updater.js:195-206`, `:230-234`), so it acts as a version floor and nothing
  else, and the final expiry checks (`store.js:102`, `:145`, `:172`) run again
  before any target is looked up. Expired **targets** are different: the store
  checks expiry before installing (`:172-175`), so an expired local targets
  file is discarded without a trace and the floor of the targets version is the
  snapshot's `meta`. A targets role delivered last is therefore never captured.
  The floor is also captured on first contact and under an expired root: the
  root authenticated a signature, and a floor can only raise the bar. A floor
  that no longer verifies under a later root is not loaded by the client, so a
  revoked key cannot wedge a Machine with a fast-forwarded version.
- **Supplied root.** The caller supplies a root (today `--bootstrap-root`,
  later the root compiled into the executable, which is then supplied on every
  run). With no durable trust it seeds the first refresh and becomes durable
  only together with the first role it verified, so a wrong root can never
  wedge an installation. With durable trust it is **never a conflict**:
  identical, older, unrelated or unreadable, it is ignored; only the direct
  successor of the trusted root that verifies as its continuation is followed
  — what a newer executable is for when the repository no longer serves an
  old link. It can only move trust forward along the signed chain.
- **Channel document.** `channels/<stable|preview>.json`, exact fields
  `schemaVersion: 1`, `channel`, `sequence`, `version`, `minimumVersion`,
  `targets` (execution target → `artifacts/<sha256>/lazurio`). A check reads
  this one document and the signed length of the artifact, never the artifact.
  An update is available only when the channel version has higher Semantic
  Versioning precedence than the embedded version.
- **Error codes** are defined once, in `src/update/errors.ts`, together with
  their exit status and whether the same action can be retried. A check exits
  `0` when up to date and `10` when an update is available; `update`,
  `update --download-only` and `update rollback` exit `0` when they did what
  was asked. A response over its length limit (`response-too-large`) and a
  filesystem without `flock` (`lock-unsupported`, read from `errno`) have their
  own codes.
- **Locks.** `update/lock` (one step) and `update/activation.lock` (a live
  worker) are regular files locked with `flock`; creating them is atomic and
  their content is never read, so there is no initialization to interrupt. The
  step lock is polled until a timeout (`busy`). The Folder operation lock is
  unchanged; converging them is separate work.
- **Clock.** The injected clock stamps observations and activation deadlines.
  Metadata expiry is judged by the pinned TUF client against the system clock.
- **Download.** One step under the step lock together with the check, because
  its scratch directory is what the next lock holder deletes: resuming means
  resuming inside one operation (a broken connection continues with `Range`
  from the bytes on disk; a server that ignores the range restarts from zero),
  never across processes — delivery state stays disposable. The signed
  `artifacts/<sha256>/identity.json` (the document `scripts/artifact-identity.ts`
  writes, plus an optional `minimumUpdaterContract`) is fetched through the TUF
  client and checked **before** the large transfer: target, version, artifact
  digest and length, updater contract, and that the release reads the Folder
  state schemas the running product writes. Artifact URLs are TUF
  consistent-snapshot names; the mapping to release assets is one function
  (`artifactUrl`). Free space is checked first; `ENOSPC` later is the same
  `disk-full`. One deadline covers the transfer, retries and waits; an idle
  connection is retried; only attempts without progress count against the
  retry bound.
- **Self-check.** `lazurio self-check [--json] [--folder <dir>]` prints the
  embedded identity and, for a named Folder, parses both state documents by
  plain reads — it takes no lock, because taking the Folder lock writes. There
  is no implicit Folder discovery in this product, so the Folder is checked
  only when `--folder` is given to `lazurio update` — the same rule as every
  other command of this CLI (`folder-init`, `launchpad`, `profile-*` all take an
  explicit `--folder`; there is no default Folder location to share). When the
  product gains one, self-check follows it and `--folder` overrides. The updater runs the
  candidate at its own path inside scratch with an empty environment and a
  timeout that holds even against a grandchild keeping the pipe open, compares
  the answer with the signed identity, and only then renames the directory
  into `versions/`. A version that is already staged is not downloaded again,
  but its bytes are re-hashed against the signed digest and the self-check is
  run again: an explicit retry is the whole gate.
- **Activation record.** `update/activation.json`: `schemaVersion`, `operation`,
  `kind` (`update | rollback`), `previous`, `candidate`, `phase`
  (`switching | confirming`), `deadline` (wall clock), `switchedAt`, `service`
  and `folder` — everything a later process needs to finish or undo it without
  the worker. `resumeActivation()` runs at the start of **every** CLI command
  (for the base the environment resolves; `update …` for the base it was given;
  `self-check` is exempt because it promises to write nothing). Without a
  record it is one `lstat`; it prints one line on stderr only when it acted. A
  Launchpad additionally keeps looking while a record exists (`watchActivation`).
  With one and no live worker it decides from the record and the disk alone:
  unreadable → removed, selector untouched; `switching`, candidate missing or
  deadline past → previous restored; `confirming` → confirmed if the candidate
  confirms now, else (no service) previous restored or (service) left for a
  later start until the deadline. Undo is always selector first, record second;
  confirm is `previous.json` first, record second.
- **Worker.** `requestActivation` starts `versions/<selected>/lazurio update
  apply-worker …` — the selected immutable executable, never the candidate and
  never the binary that happens to run the command, and never while a record
  exists. Without a service it is a detached process in its own session; under
  `systemd-user` it is a transient unit (`systemd-run --user --collect --wait
  --pipe`), because a child of the Launchpad would die with the Launchpad's
  control group. The unit has `Restart=on-failure`, `RestartSec=1` and a start
  limit of 3 in 120 s. A worker that **answers** — a typed refusal included —
  exits 0; only a worker that died is restarted. A restarted worker adopts its
  own record (same operation and candidate) and continues under the original
  deadline; a record it can no longer carry is settled like any abandoned one
  and the operation is not begun again. Known window: a worker killed after it
  settled and before it exited is restarted with no record and begins the same
  requested activation once more, bounded by the start limit. The caller reads
  one JSON line (`--wait --pipe` survive the restart); if the worker is gone
  without one, the caller converges through `resumeActivation()`.
- **Service adapters.** `none`: nothing is restarted; the activation is
  confirmed by running the new executable's self-check **through the selector**
  and comparing identities. `systemd-user`: `systemctl --user restart <unit>`,
  then the readiness contract of `src/update/readiness.ts` — a Launchpad that
  runs from `versions/` writes `update/launchpad-readiness.json` with the
  SHA-256 of its own executable (computed, not copied), its pid and start time,
  and removes it at a clean exit; ready means that digest, a start time after
  the switch, a live pid, the same instance for the whole stability period. A
  failed activation restarts the service once more, onto the previous version.
  Every restart is preceded by `systemctl --user reset-failed <unit>`: a
  candidate that crash-looped leaves the unit in its start limit, where systemd
  refuses even a manual restart. launchd is not implemented.
- **`previous.json`.** The selector stays the only record of what is active.
  What the last confirmed activation replaced is remembered separately, for
  retention and for `update rollback`; missing or damaged means only that no
  rollback is offered. Writing it never blocks a confirmation: whatever
  occupies its place is cleared, and a write that still fails is dropped. Rollback is refused (`rollback-unavailable`) when that
  version's signed identity cannot read the schemas the current product writes.
- **Retention** after a confirmed activation: the active version, the previous
  one and the version whose digest a live Launchpad announces are kept; other
  version directories and all scratch are removed. Superseded numbered roots
  are **not** pruned: the verified chain is small and is kept.
- **Observation.** Reading `observed.json` makes it true now: `selected` is
  re-read from the selector; `checking`/`downloading` survive only while some
  process holds the step lock, `activating` only while a record exists, `ready`
  only while the staged version exists; otherwise the status collapses to the
  last stable one. `running` and `restart-pending` are still unwritten.
- **Install.** `lazurio install` is the running executable staging ITSELF as
  the first version — "HTTPS bootstrap, then TUF": a person or the hosting
  engine obtained the file over HTTPS; before it installs anything it proves
  through an ordinary trust refresh that the SHA-256 of `process.execPath` is a
  signed artifact (`unverified-executable` otherwise) and that the signed
  `identity.json` of that artifact is the identity compiled into it — version,
  target, commit, digest, length (`identity-invalid`). It need not be the
  channel's current version; it must be published. Then it creates the base,
  `bin/`, `versions/`, `trust/` and `update/` with an explicit `0700` whatever
  the umask, stages a copy of itself through the same gate as any candidate
  (re-hashed after copying, self-check of the copy, `0500`/`0400`, fsync,
  rename), and swaps in the selector. `previous.json` stays absent;
  `observed.json` is written by the check it ran. It refuses when anything
  exists at the selector (`already-installed`): reinstall and repair are not
  this command, versions change through `lazurio update`. **All or nothing:**
  any refusal, no network, or a service manager that says no leaves no
  selector, no version, no unit of ours, and — of the directories it created
  itself — none that is empty. It prints the `PATH` hint and never edits a
  shell profile.
- **Install `--service systemd-user`** (Linux). The unit is rendered by a pure
  function (`renderLaunchpadUnit`): `ExecStart` is the selector with the
  Launchpad's explicit arguments — `--base` (a service manager's environment
  need not be the person's, and the Launchpad announces readiness where the
  updater looks), `--folder`, optionally `--organization-directory` and
  `--bun-executable`; every argument is escaped for systemd's `%`, `$` and
  quoting rules — `Restart=on-failure`, `WantedBy=default.target`. The
  Launchpad has no port option today (it binds an ephemeral loopback port and
  prints a private session URL), so none is taken; under a service that URL is
  only in the journal. The unit goes to
  `${XDG_CONFIG_HOME:-~/.config}/systemd/user/<unit>` (default name
  `lazurio-launchpad.service`), then `daemon-reload` and `enable --now`. A
  unit of that name with other content is `unit-conflict` and is never
  touched, so the installer cannot fight a hosting engine's resident unit.
- **`update/config.json`** is the one owned file of local update choices:
  `{schemaVersion: 1, channel, service, folder}` — the channel
  (`lazurio update channel <name>`, or the `--channel` an installation
  verified against), and what the installer decided: the `ServiceSpec` and the
  Folder. `lazurio install`, `lazurio update` and `update rollback` therefore
  need no `--channel`, `--service` or `--folder` on that Machine; a flag
  overrides each. One module reads and writes it (`src/update/config.ts`); the
  writer changes only the members it is given, so choosing a channel keeps the
  service and the Folder, and an installation keeps a channel chosen before it
  (an undone installation puts back the bytes it replaced). Tolerant state,
  member by member: missing, damaged or of another schema means `stable`, no
  service, no Folder check. Switching the channel never downgrades, because a
  check never offers a version that is not newer than the running one. This
  also answers where self-check's Folder comes from: there is still no Folder
  discovery in this CLI, but an installation with a service has one recorded
  Folder.
- **Repository format.** One static tree: `metadata/<N>.root.json`,
  `metadata/<N>.targets.json`, `metadata/<N>.snapshot.json`,
  `metadata/timestamp.json`, and targets under their consistent-snapshot names
  `targets/<directory>/<sha256>.<file>`: `channels/<channel>.json`,
  `artifacts/<sha256>/identity.json`, `releases/<version>/notes.md` and, only
  when an executable is hosted by the repository itself,
  `artifacts/<sha256>/lazurio`. Each role has its own version counter. The
  loopback fixture builds every signed byte with the publisher's builders
  (`src/publish/metadata.ts`, `channel-document.ts`), so the format the client
  tests prove is the format the publisher writes; the fixture keeps only what a
  publisher must never do (expired, tampered, malformed, rewound).
- **Publisher core.** Every operation reads the tree and returns a *plan*: files
  to add, in order, the timestamp last. `applyPlan` decides for the whole plan
  before the first byte is written that no existing immutable path would get
  other bytes, then creates files exclusively and replaces only
  `timestamp.json`. Nothing is deleted. The tree is storage, not authority:
  before anything is planned, the published timestamp, snapshot and targets must
  verify under the published root, and numbered metadata above what the
  timestamp references is refused — forged entries are never adopted and signed
  again with the real targets key, and an interrupted local run is cleaned up by
  a person, not guessed around. Operations: `add-release` (repeatable: the same
  release is a no-op; an equal or lower version, other bytes under a reached
  version, the same artifact under another URL, or a dropped target are
  refused; an identity the client would refuse is never signed), `promote`
  (exact version required, same artifact paths, pre-releases refused), `refresh`
  (targets / snapshot / timestamp, each pulling the roles below it), `status`
  (margins root 60, targets 30, snapshot 20, timestamp 5 days; exit 3 below
  one), `verify` (tree objects by length and digest; the signed URL of every
  artifact a channel selects is downloaded through the client's own transport)
  and root installation (the successor of the published root is verified as a
  chain link and re-signs exactly the roles whose key changed; a root the tree
  already holds is a no-op; a gap or other bytes are refused). Lifetimes
  default to root 365, targets 90, snapshot 30, timestamp 7 days. A key is
  needed only for a role that is actually signed and must be one the current
  root names.
- **Signed download location.** `artifacts/<sha256>/lazurio` keeps its target
  path; the publisher puts the GitHub Release asset URL into the signed
  target's `custom.url`. A check carries it to the download; without it the
  repository-served consistent-snapshot name is used (fixture, mirrors). The
  URL is only a location: origin and redirect policy stay with the transport.
  Default origins (`src/update/defaults.ts`): `https://github.com`, and the
  asset storage it redirects to — `https://release-assets.githubusercontent.com`
  (observed 2026-09-19) and its predecessor
  `https://objects.githubusercontent.com`. GitHub documents that storage only as
  `*.githubusercontent.com`; the transport matches exact origins. An origin
  outside the list — in the signed URL or in a redirect from it — is refused at
  once with the typed, non-retryable `origin-refused` (no retry, no backoff:
  policy does not change by waiting), and the release workflow
  downloads every new asset through the same list before it publishes, so a
  host GitHub introduces later stops a release rather than installed Machines.
- **Compiled-in defaults.** Repository
  `https://releases.lazurio.io/{metadata,targets}/` — a domain the project
  controls, a CNAME to GitHub Pages of this repository, because the origin is
  compiled into every executable for good; the static tree can move behind the
  name, an installed Lazurio cannot be told another one. Further: channel
  `stable`, the artifact origins above, and the text of `release/root.json`
  embedded by `scripts/build-candidate.ts` through a build-time define (a root
  that does not verify under its own keys fails the build). `lazurio install`,
  `lazurio update` and `update --check` resolve all of it in one place
  (`resolveRepository` in `src/update/cli.ts`); flags only override. The
  compiled-in root is the **supplied root** of the seeding rule above — it
  seeds empty trust, and beside durable trust it is ignored unless it is the
  verified direct successor of the trusted root; never a conflict —
  and `--bootstrap-root` replaces it. Naming another repository
  (`--metadata-url` with `--target-url`) replaces the compiled-in origins
  entirely; only `--artifact-origin` values are added. With no compiled-in root
  and no `--bootstrap-root`, a Machine without a `trust/` directory gets
  `trust-missing` before anything is created — no base, no observation.
- **Install and the publisher agree on locations.** Install finds its own
  bytes by the target path `artifacts/<sha256>/lazurio` and its identity by
  `artifacts/<sha256>/identity.json`, fetched through the TUF client from the
  static tree. The signed `custom.url` changes neither path, and install never
  follows it: it downloads signed metadata, the channel document and its own
  identity, nothing else (proven against a publisher-made repository whose
  executable exists only as a release asset).
- **Minimum version.** The signed `minimumVersion` of `stable` changes only
  through the explicit `--minimum-version` of a promotion (workflow input
  `minimum_version`): never taken from `preview`, never derived, carried over
  otherwise. It can only rise and never above the promoted version; promoting
  the version `stable` already offers with a higher value raises it between
  releases.
- **Workflows.** `release.yml`: tag `v*.*.*` → `bun run check` on Linux and
  macOS → three native builds with the tag as version (each executable is asked
  for its version, target and commit) → one GitHub Release with generated notes
  against the previous tag of the same channel → `publish` in environment
  `release`: signs exactly the assets the release serves into `preview`,
  verifies, pushes one commit to `gh-pages` (with the `CNAME` file of the
  compiled-in domain; a tree published under another domain is refused), waits until the published origin
  answers the client's own `timestamp.json` URL with the new bytes (as seen from
  the runner; not a statement about every cache). `promote` and `renew-targets` are manual dispatches
  in the same environment; promotion never builds. An existing release is never
  replaced. `update-metadata-refresh.yml`: daily; renews timestamp and snapshot
  below their margins with only those two keys, deploys that first, and then
  fails — with a summary table — when targets or root is below its margin or
  when an artifact a channel selects can no longer be downloaded. No job uses a
  concurrency group: a job waiting for approval would hold it and a newer
  pending run would cancel an older one. A race between two runs is decided by
  the never-forced push; the loser fails and every operation is repeatable. All
  publishing jobs run only in `Lazurio/LazurioPlatform`, the repository whose
  Pages origin is compiled into the product. `scripts/update-tree.sh` refuses to
  push a commit that modifies or removes a published file other than the
  timestamp.
- **Evidence in the repository.** `tests/publish-repository.test.ts` (naming,
  timestamp last, refusal to rewrite, retention, promotion, refresh, margins,
  root rotation, the key tool, the append-only branch) and
  `tests/update-publish-journey.test.ts`: the tree the publisher wrote is served
  as static files on loopback and the real client checks and downloads release
  A, sees B behind a signed URL on a second origin that redirects to a third,
  is refused when that third origin is not listed, sees B on `stable` only
  after promotion, resolves a complete older repository from a cached older
  timestamp, and follows a rotated root and targets key; a real compiled CLI
  without `release/root.json` answers `trust-missing`, one with it needs no
  bootstrap root and is simply ignored on the second run, when durable trust
  has moved past it; `lazurio install` proves itself against the same
  repository; the client sees a raised minimum version.
  `tests/update-journey.test.ts` compiles real
  executables A, B and C of a TEST-ONLY product entry point (faults switched by
  a control file; product code has no test hook) and drives `bin/lazurio`
  against the signed loopback repository: A→B, rollback, retry without a
  second download, retention, failed self-check, failed confirmation with
  automatic rollback and retry, `kill -9` of caller and worker before and after
  the swap and while confirming, two concurrent updates, a refused rollback,
  and the Launchpad's readiness file. It runs inside `bun run check`.

Deviations from the contract text above — the first five accepted by the owner
of this work, the rest open until reviewed:

1. A rotated root is promoted before its own expiry is judged (see "When the
   pinned client persists").
2. The bootstrap root becomes durable only with the first role it verified.
3. The channel document has its own parser with `version` and
   `minimumVersion`, not the pilot's.
4. `running` is reported only by the Launchpad; a CLI check leaves it alone.
5. `checking` is never persisted: a check is short and ends in a stable status.
6. Channel floors were removed (see above); the invariants now say so.
7. "Resumable" means inside one operation. A killed download starts again;
   nothing about a download survives its process.
8. "Run the staged executable by its immutable path … only then rename into
   `versions/`": it is run at its final inode and own path **inside scratch**,
   then the directory is renamed. It is never run through the selector or from
   a copy.
9. The worker is "under the OS service manager" only with `systemd-user`; with
   `none` it is a detached process that nobody restarts, and the record waits
   for the next `lazurio` start. The reboot case is carried by the Launchpad
   service and every CLI start, not by a restarted worker (see "Activate").
10. Readiness proves instance, digest, liveness and stability. It does not yet
    report "Folder and protocol compatibility", and nothing distinguishes "a
    candidate that fails from a gateway that is down": no gateway is involved.
11. `update/previous.json` and `update/activation.lock` are state the layout
    above did not list. Neither selects what runs.
12. Superseded trust files are not pruned.
13. `minimumUpdaterContract` is an optional member of the signed identity
    (default 1); the updater's contract number is `1`.
14. `--deadline-ms` and `--stability-ms` shorten the accepted defaults
    (120 s, 10 s) for qualification and canary runs.
15. The contract has the fetcher retain the raw bytes of **every** delivered
    role; it retains the one delivered last, the only one promotion reads. The
    first slice's rule "withhold the role delivered last in a failed refresh"
    is gone: that role is now re-verified and, when authentic and newer, kept
    as a floor. Expired targets are deliberately never kept.
16. "The client maps `artifacts/<digest>/…` to the asset URL explicitly" became
    a **signed** URL in the target's `custom` metadata; "Publishing" now says
    so. No mapping rule exists in the client.
17. "One deployment replaces the whole tree" is one pushed commit on
    `gh-pages` with Pages deploying from that branch, followed by waiting until
    the origin serves the new timestamp. Between the commit and the end of the
    Pages deployment clients see the complete previous tree.
18. "The publisher uploads artifacts" is the release job; the publisher itself
    never uploads. It signs what the GitHub Release already serves and proves
    it by downloading it.
19. Targets metadata keeps every artifact ever released (a channel may still
    select it). Pruning old entries is not built.
20. Release notes are a signed target (`releases/<version>/notes.md`, at most
    256 KiB) rather than a member of the channel document, whose exact field
    set is unchanged.
21. Promotion refuses pre-release versions and requires the exact version;
    a release may not drop a target its channel currently serves. Neither rule
    is in the text above.
22. `renew-targets` exists although the contract names only snapshot and
    timestamp renewal: targets metadata expires after 90 days without a
    release and only the protected environment can re-sign it.
23. The contract has the client follow redirects "only to origins on a short
    compiled-in list"; a refusal is its own error code, `origin-refused`
    (exit 47, not retryable), which the contract's error vocabulary did not
    name.
24. `trust-missing` without any supplied root is answered before the base, the
    lock or the observation exist, so that one failure leaves no
    `observed.json` behind — unlike every other failed check.

## Removed by this contract

The write-ahead metadata journal, transcript replay, historical role floors,
recovery cycles, attempt history, `product recover`, the double active record and
the refusal of unrelated base entries — **after** the interruption, expiry and
rotation tests above prove that durable per-role promotion preserves the same
trust. Their security purpose is kept by a mechanism that is smaller and cannot
wedge.
