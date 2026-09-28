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
(`src/recover/recover.ts`). The Launchpad's recovery page of a later slice renders
the same result; there is no second implementation.

It reads and never writes: no lock, no restart, no network, no file under the install
base or the Folder. When something is broken it prints

1. the checks,
2. the prompt for a repair agent in Czech or English (`--locale`, default the
   language the Folder records, else English), built from the facts of this run,
3. the sanitized body of an issue for the public product repository
   `Lazurio/LazurioPlatform`, the exact `gh issue list` search for a duplicate and
   the exact `gh issue create` command with the body as a here-document, and a
   prefilled `issues/new` link for a browser without `gh`.

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
| `launchpad-health` | (R4's evidence) | `GET /health` on the socket under the base | `launchpad-not-answering` (supervised only), `launchpad-version-mismatch`, `launchpad-recovery-mode` (the `503 {mode, check}` answer of a later slice) | `not-installed`, `not-supervised` |

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
characters).

Never collected: the Folder's files, preferences contents, the handover, environment
variables, tool sign-in state, anything under `personalspace/`.

The **fingerprint** `rf-<12 hex>` is SHA-256 over the check, its code, the one detail
of its context (`reason`, else `path`, else `stage`) and the target, without the
version, so one fault meets its issue across releases. The title ends in
`[rf-…]`; the search uses `--state all`, so a closed match is found as a regression.

## What may leave the Machine

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
prepared, and the prompt tells the agent to send nothing. The body is bounded to
6 KB after sanitization by dropping the oldest journal lines; a link longer than
8000 characters carries the title only.

Known limits, stated rather than hidden:

- A person's GitHub login is known only from the Machine binding or the handover. On a
  workstation it is not read from `gh` (that would be a sign-in probe and possibly
  network); where it equals the account name it is covered by that.
- Values shorter than two characters and `localhost` are not treated as private.
- A private value that is a common word replaces that word everywhere (safe, less
  readable); a name with a credential word in it (`secret-plans`) withholds its line.
- The prompt stays on this Machine and names the real Folder path in its commands;
  its evidence is the sanitized bundle.

## What does not exist yet

- The Launchpad's Recovery mode (R1 instead of exiting, the one-action page, health
  `503`, admission from the handover) and the Folder manual's "Recovery mode"
  section: slice 3.
- Activation without undo, the pre-switch probe, `activation-unhealthy` (R3), the
  unit without `OnFailure=` and removal of `lazurio update rollback`: slice 4. Until
  then the product still has program rollback; the repair prompt nevertheless forbids
  it.
- R4 `launchpad-not-running` as its own check and the hosted gateway's static page.
- Writing the bundle to `<base>/recovery/<timestamp>.json` when there is no network
  (E.5): this slice writes nothing.
- The issue template and label `recovery`, `tests/recovery/<fingerprint>/` and the
  release gates: slice 5.

`docs/update.md` still says there is "no `recover` command"; that sentence is about
download recovery and belongs to the contract the proposed decision F21 amends.
