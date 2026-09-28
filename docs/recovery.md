# Recovery: `lazurio recover` and the sanitized evidence

Status: **first implementation slice of the proposed decision F21** ("Recovery mode
instead of rollback", shaped in `docs/recovery-mode.md` on the branch
`claude/DEV-6626-recovery-mode-shaping`; its section J.1, slice 2). F21 is not
accepted yet and is not recorded in [decisions](decisions.md); this document says
what exists after this slice and what does not. Nothing here changes how the product
updates, activates, restarts or supervises: the checks read, and the command files
nothing.

## What exists

`lazurio recover [--json] [--locale cs|en] [--folder <absolute Folder>]` (and
`--base`, like the update commands) runs the one use case `collectRecovery`
(`src/recover/recover.ts`). The Launchpad's Recovery page ([below](#the-recovery-page))
renders the same result; there is no second implementation.

It reads and never writes: no lock, no restart, no network, no file under the install
base or the Folder. When something is broken it prints

1. the checks,
2. the prompt for a repair agent in Czech or English (`--locale`, default the
   language the Folder records, else English), built from the facts of this run;
   its rerun of `lazurio recover --json` names the Folder this run read with
   `--folder`, so the proof of success reads the same Folder,
3. the sanitized body of an issue for the public product repository
   `Lazurio/LazurioPlatform`, structured fields only (tier 1, below), the exact
   `gh issue list` search for a duplicate and the exact `gh issue create` command
   with the body as a here-document, and a prefilled `issues/new` link for a
   browser without `gh`.

**Filing is not this command's act.** It is the repair agent's, under the standing
mandate for issues (root decision 0163): after a duplicate search, with a body that
passed the gate below, and shown to the operator in the chat. Closing and
prioritizing stay with the Principal.

**Exit status:** `0` healthy or nothing installed, `3` broken, `2` usage, `1` the
command itself failed (no reason printed: it could quote a private path). `3` is new
and distinct from the update commands' `1` and `10`, so automation can tell "Lazurio
needs a repair" from "the check could not run".

The Folder is `--folder`, else the supervised unit's (`[X-Lazurio]` of the unit
`lazurio install --service` wrote), else on a hosted Machine the declared operator's
from the handover, as for `update status`.

### The checks

Every check has one shape (`RecoveryCheck`, `src/recover/checks.ts`): a stable `id`,
the `rule` of F21's table it implements (or `null`), and an outcome `ok` with a
context, `failed` with a stable `code` and a context, or `skipped` with a `reason`.
Skipped is never "broken". Ids and codes are never renamed or reused.

| Id | Rule | What it reads | Failed codes | Skipped |
| --- | --- | --- | --- | --- |
| `update-state-invalid` | R2 | `readStatus` of the update core, the reader an outside observer uses | `state-invalid` (context `path`, relative to the base) | never |
| `folder-state` | (R1's cause) | The Folder's `.lazurio/` as this version reads it: the two state documents parsed without the lock, like the self-check | `folder-state-absent`, `-pending` (a transaction), `-unrecognized` (an entry this version does not know, or no operation lock), `-unreadable` | `no-folder` |
| `self-check-failed` | R5 | The ACTIVE executable's `self-check --json --base --folder`, run once by its immutable path and judged by the updater's own rule (`requireSelfCheck`) | `self-check-failed` (context `reason`, `exitCode`) | `not-installed` |
| `launchpad-unit` | (R4's evidence) | `systemctl --user show` of `lazurio-launchpad.service`, only when that unit carries the installer's marker and a user manager exists (Linux, `XDG_RUNTIME_DIR`) | `unit-not-loaded`, `unit-failed`, `unit-restarting` (`auto-restart`), `unit-inactive` | `no-user-manager`, `not-supervised`, `user-manager-unreachable`, `unit-state-unknown` |
| `launchpad-health` | (R4's evidence) | `GET /health` on the socket under the base | `launchpad-not-answering` (supervised only), `launchpad-version-mismatch`, `launchpad-recovery-mode` (the `503 {mode, check, reason}` answer of a Launchpad in Recovery mode; context `check` `start-refused` and `refusal`, why its start was refused) | `not-installed`, `not-supervised` |

When several fail, the issue is about the first in this order, the one closest to the
cause; all failed ids are listed. R1 `start-refused`, R3 `activation-unhealthy` and
R4 `launchpad-not-running` are added by later slices as new ids with their codes, in
the same shape.

### The evidence bundle

`lazurio.recovery.v1` (`src/recover/evidence.ts`): the failed check with its code
and context, all checks, the running and the active executable (version, commit,
target, fixture), the platform (OS, kernel release, architecture, systemd version
where a user manager exists, Bun), the install state (active, high-water mark,
`stateInvalid`, installed versions, supervised, whether a legacy `previous` link or
`update/pending.json` exists), the unit's `LoadState`, `ActiveState`, `SubState`,
`Result`, `NRestarts`, `ExecMainStatus` and the last failed `lazurio-update` run's
code, the Folder's preset, Machine kind, revision, recorded and product template
revision, schema versions and a pending transaction, the last verified check, and a
bounded tail of the Launchpad unit's journal (80 lines, 8 KB, lines cut at 500
characters), which stays on the Machine (tier 2, below).

Never collected: the Folder's files, preferences contents, the handover, environment
variables, tool sign-in state, anything under `personalspace/`.

The **fingerprint** `rf-<12 hex>` is SHA-256 over the check, its code, the one detail
of its context (`reason` and `refusal` together when present, else `path`, else `stage`) and the target,
without the version, so one fault meets its issue across releases. The title ends in
`[rf-…]`; the search uses `--state all`, so a closed match is found as a regression.

## What may leave the Machine

### Two tiers

The shaping's decision on what leaves (Q4, `docs/recovery-mode.md` E.1 and E.3)
splits the bundle in two:

- **Tier 1, the automatic structured body.** The prepared issue body carries only
  structured, non-free-text fields: versions, digests, target and platform names,
  the ids of failed checks and their codes, unit states and counters, Folder and
  template revisions, timestamps. Every field has its own validator
  (`src/recover/evidence.ts`, `observe.ts`, `recover.ts`), and an id-valued field
  admits only finite product-defined values, never a shape. A string copied from
  the Folder is an enumerated literal (preset, Machine kind) or a revision of the
  product's form (`base-instructions-<n>`), else the literal `invalid`, never the
  recorded value; its revision and schema versions are numbers. A version the
  Machine recorded (active, high-water mark, installed, the active executable's,
  the last check's latest) is kept in the release form `X.Y.Z` or `X.Y.Z-rc.N`
  (`docs/release-cycle.md`), digits only, else `invalid`. The unit's states are
  systemd's own values or `unknown`. The kernel release keeps only its numbers
  (`6.8.0` of `6.8.0-45-generic`); the last check's time is re-written as ISO 8601.
  This body is what the repair agent files without asking.

  A `context` (of every check and of the last failed `lazurio-update` run, which
  is read back from that unit's journal) keeps only these keys, each with a value
  from its finite product-defined list or of its numeric form:

  | Keys | Value | Source of the list |
  | --- | --- | --- |
  | `reason` | a reason the product emits | `updateErrorReasons` (`src/update/errors.ts`) and `healthReasons` (`src/recover/observe.ts`) |
  | `code` | an update error code | `updateErrorCodes` (`src/update/errors.ts`) |
  | `stage` | a stage the update code emits | `updateErrorStages` (`src/update/errors.ts`) |
  | `resource` | a release resource | `updateErrorResources` (`src/update/errors.ts`) |
  | `check` | a recovery check id, or the check a Launchpad's health socket names in Recovery mode | `recoveryCheckIds` (`src/recover/checks.ts`), `healthSocketChecks` (`src/launchpad/recovery-mode.ts`) |
  | `refusal` | why a Launchpad start or probe was refused | `startRefusals` (`src/launchpad/start-check.ts`) |
  | `path` | an update state name | `updateStatePaths` (`src/update/layout.ts`) |
  | `activeState`, `subState`, `result` | systemd's value, or `unknown` | `unitActiveStates`, `serviceSubStates`, `serviceResults` (`src/recover/observe.ts`) |
  | `target` | a release target | `updateTargets` (`src/update/identity.ts`) |
  | `errno` | an errno name | `os.constants.errno` of the runtime |
  | `version`, `expected`, `actual`, `reported`, `active`, `latest`, `from`, `to` | a version in the release form | `isReleaseVersion` (`src/recover/evidence.ts`) |
  | `revision`, `recorded`, `product` | an integer or `base-instructions-<n>` | `isTemplateRevision` (`src/folder/render.ts`) |
  | `exitCode`, `httpStatus`, `nRestarts`, `execMainStatus` | an integer | |

  Every other key (`message`, `note`, `detail`, `error`, …) and every value outside
  its list is dropped before sanitization. The helpers that build an update
  context take these lists as types, and a test holds every `reason`, `stage`,
  `resource` and `check` literal written in `src/update/`, `src/recover/` and the
  update pill to its list, so a new value cannot pass the allowlist silently or be
  dropped unnoticed.
- **Tier 2, free text.** The journal tail and any other free text never leave the
  Machine automatically. `evidence.journal` stays in the `--json` output on this
  Machine; it is not in the body, the here-document or the link. It reaches the
  issue only as a comment the repair agent attaches after reading it under the
  sanitizer and judging it public-safe.

The sanitizer and the gate below hold for both tiers.

### The sanitizer

The sanitizer (`src/recover/sanitize.ts`) sits **beside** `src/tools/redact.ts` and
reuses its credential shapes and its plain-text rule, which now have one exported
home there. It does not change redact.ts's behaviour: redact.ts decides what of a
tool's output a person on this Machine may see and withholds every long run; a
public issue needs known identifiers replaced and must keep the commits and digests
the product prints. Loosening redact.ts for that would loosen the tools screen too.

Per line, in this order:

1. A line with a credential shape (private key header, `gh*_` and `github_pat_`
   tokens, `uak_`/`ak_`-style keys, the words token, secret, password, bearer,
   authorization, cookie, session, a key or code in a query string, a one-time code
   shape) is withheld whole: `[line withheld]`.
2. IP addresses (IPv4 and IPv6, tailnet `100.64.0.0/10` included; loopback kept) and
   e-mail addresses become `<ip>` and `<email>`. This runs before step 3 because a
   known value that is also a label or a number would break the pattern and leave
   the rest of the address behind.
3. Known private values of this Machine become stable placeholders, matched as whole
   names, case-insensitively, longest first, in one pass: the Folder path
   `<folder>`, the install base `<base>`, the home `~`, the account `<user>`, the
   host name and its short form `<host>`, and numbered `<org-n>`, `<repo-n>`,
   `<machine-n>`, `<team-n>`, `<login-n>`, `<github-id-n>`, `<node-n>`,
   `<machine-host-n>`, `<peer-n>`, `<hostname-n>`. Sources: the process (home,
   `USER`, `LOGNAME`, the account name, the host name), the names under the
   Folder's `organizations/` and under each Organization's `workspace/`,
   `productionspace/` and legacy `modules/` (names only, at most 256 Organizations
   and 2048 repositories), each Organization's slug, GitHub login and root
   repository as its `lazurio.organization.json` or legacy `company.gen3.json`
   declares them (the checkout directory need not be the login, `<Owner>_GEN3`;
   nothing else of those files is read), the Machine binding the Folder records and the Machine
   handover (Machine, Owner, Team, assignment login and id, tailnet node, host,
   custody repository, peers and their hosts, the hosted entry's hostnames).
4. A long run (32 or more of `[A-Za-z0-9+/_=-]`) withholds the line unless it is
   exactly a 40- or 64-character lowercase hex digest that is either the running or
   active executable's commit or directly follows a label the product prints
   (`sha256:`, `commit `, `digest `, `"commit": "`, `"sha256": "`). It is checked on
   the substituted line and, without `/`, on the line before substitution, so a
   replacement inside a token cannot split it into short pieces. The Launchpad's
   session URL (`http://127.0.0.1:<port>/#<64 hex>`) is exactly such an unlabelled
   run and is withheld.
5. `*.lazurio.io` hostnames are kept only when every label left of the product domain
   is `launchpad` or a placeholder (`launchpad.<machine-1>.<org-1>.lazurio.io`);
   otherwise the whole host becomes `<lazurio-host>`. Other accounts' homes
   (`/home/x`, `/Users/x`) become `/home/<account>`.

The **gate** is the last function before anything leaves: over the title and the
final body it looks for every known value (outside the placeholders it wrote), every
credential shape, every untolerated long run, every pattern and any control
character. If anything is found, the result is a typed refusal naming the kinds
(`organization`, `ip-address`, …), never the value; no body, command or link is
prepared, and the prompt tells the agent to send nothing. The tier-1 body is bounded
to 6 KB after sanitization; it has no free text to drop, so nothing is trimmed: a
test holds the largest body the evidence can produce under the bound, and a body
above it (a bug) is still prepared whole for `gh`, with a link that carries the title
only. A link longer than 8000 characters carries the title only too.

Known limits, stated rather than hidden:

- A person's GitHub login is known only from the Machine binding or the handover. On a
  workstation it is not read from `gh` (that would be a sign-in probe and possibly
  network); where it equals the account name it is covered by that.
- Values shorter than two characters and `localhost` are not treated as private.
- A private value that is a common word replaces that word everywhere (safe, less
  readable); a name with a credential word in it (`secret-plans`) withholds its line.
- The prompt stays on this Machine and names the real Folder path in its commands;
  its evidence is the tier-1 fields of the sanitized bundle.

## The Recovery page

The Launchpad shows the same result in two places, read-only:

- **In Recovery mode** (the start was refused on a named condition,
  [update](update.md#recovery-mode)) it is the whole page: the bundled page this
  executable carries, which needs nothing of the Folder, without the sidebar,
  Settings, the update pill or applications. Every page path serves it (still with
  status `503`; its scripts and styles answer `200`). When the page does not serve
  completely (`asset-missing`, or its bundle fails the same check a normal start
  makes), every page path answers the check and the reason as plain text instead.
- **In normal mode** it is Settings → Recovery (`/settings/recovery`), in the T3 Code
  settings pattern of the other sections, so operators can find it. On a healthy
  installation it shows the checks and says so. It runs only when the section is
  opened and on "Check again", because the check runs the active executable's
  self-check.

What the page shows:

1. In Recovery mode, the check `start-refused` and the reason, each by its id and in
   words (Czech or English; in Recovery mode the browser's language, because the
   Folder's recorded one may not be readable).
2. The verdict and every check with its outcome, code or skip reason and context.
3. When broken: the prompt for a repair agent with **Copy the prompt** (on a hosted
   Machine it goes into a new chat in T3 Code, on a workstation into the agent app
   the operator uses; decided 2026-09-28, Q3 of the shaping), the prepared issue
   (title, body preview, **Copy the gh command**, which copies `issue.shell`, and the
   prefilled `issues/new` link opening in a new tab) or, when the gate refused the
   body, only the kinds of what survived, the tier-1 evidence exactly as the issue
   carries it, and the sentence that nothing was filed.
4. The journal tail (tier 2) never appears unless the operator presses **Show journal
   (stays on this Machine)**; it is not in the page until then.

`GET /api/recovery` returns exactly the object `lazurio recover --json --folder
<the Launchpad's Folder>` prints (with `--base <its base>` when it was started with
one, otherwise the default install base, as the command uses), built by the same
function (`recoveryEnvironment`, `src/recover/cli.ts`); one run at a time. There is no
route that changes anything: nothing is filed, nothing is written, nothing reaches
the network, and every other API route still answers Recovery mode's typed refusal.

**Admission.** Hosted, the page and `/api/recovery` sit behind the gateway's
admission, as the normal page does; Recovery mode answers through the gateway only
when the Folder's recorded entry still reads, otherwise on an ephemeral loopback
port nothing proxies to. Locally the link `lazurio launchpad` prints carries a
fragment token, and `/api/recovery` requires it (and this listener's own Host), as
every read of the normal page does; the plain-text reason and the typed refusals of
the other routes carry only enumerated ids and need none.

Filing stays the repair agent's act (root decision 0163); the page gives the operator
the same prompt and body the agent would use, and Q2 (an issue on every entry into
Recovery mode) is met by the agent's step 7, not by the page.

## What does not exist yet

Recovery mode itself (R1 instead of exiting, health `503`, admission from the recorded
entry), the pre-switch probe and activation without undo exist
([update](update.md#recovery-mode)), and so does the Recovery page above. Missing:

- R1 `start-refused` and R3 `activation-unhealthy` as check ids of this command. A
  Launchpad in Recovery mode is named through `launchpad-health`
  (`launchpad-recovery-mode`, context `check: start-refused` and the `refusal`
  that says why), which the fingerprint tells apart per refusal; where no
  Launchpad answers, the refusal is not in the evidence.
- Opening T3 Code with the prompt in a new thread: T3 Code has no released way yet
  (the shaping's slice 7); the page copies the prompt.
- R4 `launchpad-not-running` as its own check and the hosted gateway's static page.
- Writing the bundle to `<base>/recovery/<timestamp>.json` when there is no network
  (E.5): this slice writes nothing.
- The issue template and label `recovery`, `tests/recovery/<fingerprint>/` and the
  release gates: slice 5.

`docs/update.md` still says there is "no `recover` command"; that sentence is about
download recovery and belongs to the contract the proposed decision F21 amends.
