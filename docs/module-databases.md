# Module databases: the app/v4 contract

**Status: proposed contract, nothing here is implemented.** It answers
[#818](https://github.com/Lazurio/LazurioPlatform/issues/818): how an App of
generation `app/v4` gets its Dolt database. Parts of it are already decided and
this page only collects them; the rest is a proposal that waits for the
Operator's decision. Every section says which is which, and
[open questions](#open-questions) lists what has to be decided. This page
changes no running Environment and no Module, and it adds no requirement to the
[Module Standard](module-standard.md) until that standard is amended.

The contract in five sentences:

- An App declares that it needs a database with one member of `lazurio.runtime`;
  the database is named after the Module.
- The Organization's Admin decides which Environment reaches which database and
  at what level, in the Deployment Repo, and Machines creates the databases and
  one SQL user per Environment from that declaration.
- Lazurio hands the App's server its connection at every start through
  `LAZURIO_RUNTIME_DATABASE_*`. An App without a connection does not start, and
  the browser never gets one.
- People and agents work in the Environment's draft branch, a publication merges
  it into `main`, and every publication is a Dolt commit that names the Environment
  and, where it is known, the person.
- Migrations are an Admin's explicit step, never part of a start.

## What is decided and what is proposed

| Topic | Decided | Proposed here |
| --- | --- | --- |
| Generations | `app/v3` keeps records in repository-db, `app/v4` in Dolt, and there is no `app/v5`: Dolt elsewhere is another connection setting ([F69][f69], points 5 and 8) | How the setting reaches the App: [the connection](#2-the-connection) |
| Choosing a database | The Module's architect chooses repository-db or a database, the agent explains the trade-off ([0196][0196]) | Nothing |
| Where Dolt runs | The service kind `database` in the Organization's services Environment; a primary, and with a second server a hot standby by direct-to-standby replication; a failover only by a reviewed change in the Deployment Repo; not a production database ([0209][0209]) | The service's details in Machines, `docs/server-services-database.md` |
| Network | An Environment connects only to the services of its own server; the service of the server without the primary forwards writes; only services Environments talk across servers, over the tailnet of the Proxmox hosts, with a grant limited to those ports ([0209][0209]) | A TCP ingress: [network](#10-network) |
| Backups | The whole database with its drafts every 15 minutes to Google Cloud Storage in the Organization's own EU project, rotated through hourly and daily copies, with a dump of users and grants ([0209][0209]) | Restore and retention: [backups](#8-backups-and-restore) |
| Stack | Dolt 2.6.2 pinned by the services Environment, Kysely 0.29.8, `mysql2` 3.24.6, Zod 4.6.7 ([stack profile](stack-profiles.md#app-database)) | Nothing |
| Secrets | Never in `.env*`, and an App gets only what it declares ([0177][0177], [F46][f46], `MS-07`) | Where the password comes from: [question 1](#open-questions) |
| Data access | The Environment's ceiling comes first, the Module's server narrows it on every request, and the browser never reaches the store; the repository-db draft is shared per Environment ([0196][0196]) | SQL levels and branches: [access](#3-creating-databases-and-access), [drafts](#4-drafts-publication-and-branches) |
| Everything else | | Declaration, variables, migrations, audit, erasure, the move from `app/v3` |

## Scope

This contract covers Organization Modules whose App runs on an Environment of
one of the Organization's servers.

- **Not a Personal Module.** A personal Environment has no services Environment
  of its Organization, so a Personalspace App stays in `app/v3`
  ([question 8](#open-questions)).
- **Not your computer.** A person's own computer is not on a server's internal
  network, so it has no connection. Development there uses a local Dolt, see
  [development](#6-development-tests-and-ci).
- **Not a production database.** The systems that serve an Organization's
  customers stay outside Server services (0209). An App that uses such a database
  or any other outside store reads it through declared `secrets`, as today.
- **Not a new generation for several servers.** The same `app/v4` runs on every
  server of the Organization. Only the address it is given differs, and "v5"
  remains a name for that setting, not a directory.

## 1. The declaration

**Proposed.** An App declares its database in `lazurio.runtime`, beside `secrets`
and `required_module_slots`:

```json
"runtime": {
  "...": "...",
  "database": {
    "engine": "dolt",
    "tested_version": "2.6.2",
    "migrate_script": "db:migrate"
  }
}
```

| Field | Rule |
| --- | --- |
| `engine` | `dolt`, the only value |
| `tested_version` | the exact Dolt version the App's tests run against; it never pins the server |
| `migrate_script` | a script of the package that applies the App's migrations, see [migrations](#5-migrations) |

Rules around it:

- **One database per Module, named after the Module.** The database's name is the
  Module's `id`, so it is not declared and two Modules of an Organization cannot
  collide. `app/v3` and `app/v4` of one Module side by side do not share it:
  only `app/v4` declares it.
- **In `lazurio.runtime`, not in `lazurio.module.json`.** A database belongs to an
  App generation, as secrets do, and `lazurio.module.json` stays unchanged, so its
  closed parser does not change.
- **A static App declares no database**, as it declares no secrets: it has no
  server to hold the connection. `parseAppRuntime` refuses `database` beside
  `build_output` without `start_script`.
- **Another Module's database is out of reach.** An App reads a sibling of
  generation `app/v4` only through its API (`workspace/<slug>` and
  `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN`). `workspace/<slug>/db` keeps its meaning,
  a repository-db mount, and a Module without one does not offer that slot.
- **The schema lives in the App.** Its shape is the sequence of migrations in
  `app/v4/migrations/`, derived from the Zod schemas that stay the one source of
  the data's shape ([F69][f69], point 3).

The Organization's manifest needs no new field: the Module's slot declares the
Module and the App's declaration says it has a database. The database itself is
declared where Machines reads desired state, see
[who creates it](#3-creating-databases-and-access).

## 2. The connection

**Proposed.** At every start, a restart included, the Platform passes the App's
own server process these variables. It passes them to no other process: not to
the preparation, a build or a sibling.

| Variable | Value | Secret |
| --- | --- | --- |
| `LAZURIO_RUNTIME_DATABASE_HOST` | the name of the `database` service, which resolves to this Environment's own server | no |
| `LAZURIO_RUNTIME_DATABASE_PORT` | its port | no |
| `LAZURIO_RUNTIME_DATABASE_NAME` | the Module's database | no |
| `LAZURIO_RUNTIME_DATABASE_USER` | this Environment's SQL user | no |
| `LAZURIO_RUNTIME_DATABASE_PASSWORD` | this Environment's token for the service | **yes** |
| `LAZURIO_RUNTIME_DATABASE_TLS_CA` | the CA certificate that signs the service's certificate, as PEM text | no |
| `LAZURIO_RUNTIME_DATABASE_ACCESS` | `read` or `write`: this Environment's level on this database | no |

The password is the only secret, and the same rules hold for it as for a runtime
secret: never in a finding, a log, a file of the Platform, an error or a page.
The App sends it only to the service. A changed password applies from the next
start.

**Where the Platform reads them.** Machines hands the facts over in a new optional
member of the handover, and the token beside it:

```json
"database": {
  "service": "<service id>",
  "engine": "dolt",
  "engine_version": "2.6.2",
  "host": "<service name>",
  "port": 8440,
  "tls": { "ca_file": "<path>" },
  "user": "<Environment>",
  "token_file": "<path>",
  "databases": [
    { "name": "crm", "access": "write" },
    { "name": "mission-control", "access": "read" }
  ]
}
```

- **The token never goes into the handover.** `lazurio.machine.json` is mode 0644,
  every process of the Machine reads it and `lazurio machine inspect` prints it.
  The handover names only the file.
- **The token file** follows the AI pool's token: owned by root, group the
  Environment's account, mode 0640, rendered by Machines at each apply. The
  Platform refuses a link, a file another user may write or an empty file.
- **The Module's App gets the facts of its own database only**, and only when
  `databases` lists it.
- **Machines writes the member only for a pinned Platform that reads it**, by a
  gate like `PLATFORM_HANDOVER_SERVICES_MINIMUM`, because the handover schema is
  closed. The vendored schema is re-pinned first, as for every member.

Whether the token comes from this file or from the Environment's vault is
[question 1](#open-questions). The App's contract is the same in both cases, so the
answer changes no Module.

**TLS is required.** The service accepts only encrypted connections, and the App
verifies both the chain and the name. In `mysql2` that takes
`ssl: { ca, rejectUnauthorized: true, verifyIdentity: true }`: `rejectUnauthorized`
alone checks only the chain, `ssl.servername` has no effect, and `verifyIdentity`
compares the certificate with `host`, which therefore has to be a name and cannot
be an address. So `LAZURIO_RUNTIME_DATABASE_HOST` is one fixed name of the service,
the same on every server, and Machines resolves it on each Environment to the bridge
address of its own server's services Environment. The certificate of every node
carries that name under the same CA, so a failover changes nothing the App checks.
`@lazurio/module-kit`'s `database()` returns these options, so that no Module writes
them by hand.

**When the connection is missing.** A declared database without a usable
connection fails closed, on both sides.

| Who | What happens |
| --- | --- |
| The Platform | The App does not start. The finding `runtime-database-unavailable` names the reason: `workstation` (not an Environment on a server), `personalspace`, `other-organization`, `no-service` (the handover names no `database` service), `not-granted` (this Environment has no grant to this Module's database) or `credential-unreadable` (the token file is missing or unsafe). It holds no value. |
| The App | It reads the variables fail-closed, as listeners and secrets: without one it exits with code 2 and a message that names the variable. `@lazurio/module-kit` gets a `database()` reader for this, as `listener()` is for listeners. |

An Environment without access is a normal state, not an error of the Module: the
Launchpad shows the person that the Organization's Admin grants access to the
Module's data.

**When the service does not answer.** A running connection can drop, in a failover
or a restart of the services Environment. That is not a missing connection: the
App keeps running, answers the data routes with a typed 503, shows the person
that the data is unavailable for a moment, and reconnects on the next request with
a backoff. It never loops, and it never falls back to another store. Its health
path keeps answering 200: the process is healthy, and the Platform must not treat
a failover as an App that ended.

## 3. Creating databases and access

**Proposed.** Machines creates what the Deployment Repo declares. This keeps one
place of truth for what runs on a server, and it follows 0209: an Environment
reaches only what the Deployment Repo declares and permits.

| What | Who | When |
| --- | --- | --- |
| The Module and its `app/v4` | an Admin with an agent (`lazurio module create`, later with a `--database` flag) | when the Module or its `app/v4` is created |
| The database, its branch `main` and its branch permissions | Machines, from the `database` service's list of databases | at the apply of the services Environment, idempotently, on the primary |
| One SQL user per granted Environment, its privileges | Machines, from the Environment's `service_grants` | at the same apply, on every node |
| The handover member and the token file | Machines | at the apply of the Environment |
| The tables | the Module's migrations, run by an Admin | after the Module's pull request is merged |

The agent that creates a Module of `app/v4` prepares the Deployment Repo's pull
request too; a person with rights merges it. A Plan reads only its Deployment Repo
and its pinned Machines, so Machines does not read the Organization's manifest
itself, and the manifest stays the source the agent works from
([question 3](#open-questions)).

An apply never drops a database. Removing one is an Admin's separate, reviewed
step after its last backup is verified.

**One SQL user per Environment.** The user's name comes from the Environment's
Machine name, the one `X-Lazurio-Environment` carries for HTTP services. Its
password is the Environment's token, derived from the service's own client secret
in a separate domain (`lzdb-`), so it can be replaced without touching any other
Environment. A Team Environment has one user for all its people, as it has one
identity everywhere else.

**Levels.** The Deployment Repo names a level per database for each Environment,
and that level is the Environment's ceiling (0196). The Module's server narrows it
further by the verified identity of the person.

| Level | Rule of thumb | SQL |
| --- | --- | --- |
| none | the Environment's identity has no access to the Module's repository | no privilege on the database |
| `read` | it has read access | `SELECT` |
| `write` | it has write access | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `EXECUTE` on exactly the procedures `dolt_branch`, `dolt_commit`, `dolt_merge` and `dolt_revert` |
| `migrate` | an Admin's Environment | `write` for the App, and a second SQL user with `CREATE`, `ALTER`, `DROP`, `INDEX` and `write`'s privileges that only `lazurio module migrate` gets |

**Never `EXECUTE` on a whole database.** To Dolt its administrative procedures are
ordinary procedures: a user with `EXECUTE` on one database can call
`dolt_assume_cluster_role` and demote the primary. Each procedure is granted by name,
and with that grant `dolt_gc`, `dolt_backup`, `dolt_remote` and role changes are
refused.

**Branch permissions.** Dolt's default rule lets every user write to every branch.
Machines removes it at creation and writes explicit rules, which its own administrator
needs too: an Environment at the level `write` may write to `draft/<Environment>` and
`main`, and may create only the branch `draft/<Environment>`. A catch-all rule reserves
every other branch name, because without one the rules restrict nothing. So one
Environment cannot touch another's draft, and nobody at this level can force or delete
`main`.

**A known limit.** Publishing needs write access to `main`, and Dolt cannot narrow that
to merges. `dolt_reset` is not granted, but `dolt_commit('--amend')` on `main` can
replace its last commit. The Module's server never does that. Someone with the whole
Environment could, which is the trust 0196 already describes, and the backups are the
way back.

The rule of thumb comes from a Team's live grant on the Module's repository (0186):
whoever may work on a Module usually gets the same level on its data. It stays a
rule of review and not a derivation, because 0196 keeps data access a separate
decision of the Admin: code access and data access may differ on purpose.

**Taking access away.**

| Admin's step | Effect |
| --- | --- |
| Removes one database from the Environment's grant | The apply revokes the privileges on all nodes, and the App's next start reports `not-granted` |
| Removes the Environment's whole grant | The apply drops the SQL user on all nodes, the ingress stops admitting the Environment's address, and the token file is removed |
| Raises `token_generation` | The old password stops working at once; the apply gives the Environment a new one. It is the way to react to a leaked token |
| Takes away the GitHub grant to the Module | **No effect on the database.** The Environment no longer gets the Module's code, but its SQL user keeps its privileges until the Deployment Repo changes. The Admin has to do both ([question 4](#open-questions)) |

## 4. Drafts, publication and branches

**Proposed; the steps marked in [verified locally](#verified-locally) ran on Dolt
2.6.2.** Draft & Publish stays the interface it is in `app/v3`; the stack profile
promises exactly that.

| Operation | In Dolt |
| --- | --- |
| Published state | the branch `main` |
| Draft | one branch `draft/<Environment>` per Environment, created from `main`, because the draft is shared per Environment (0196) |
| Save | a SQL transaction on that branch, with the optimistic `baseRevision` of `app/v3`: Dolt has no fully serializable `SELECT … FOR UPDATE`. A save needs no commit: the branch's working set reaches the standby and the backups |
| The draft card | the diff of `main...draft/<Environment>` |
| Publish | one operation on the server: `DOLT_COMMIT` on the draft with the author and the summary, then `DOLT_MERGE` into `main` |
| A colleague published the same record first | `DOLT_MERGE` reports the conflict and rolls back, `main` does not move, and the App answers `record_changed` |
| Take over colleagues' work | a merge of `main` into the draft |
| Discard | a record: its row taken from `main`; the whole draft: `DOLT_BRANCH('-f', 'draft/<Environment>', 'main')`, which drops its working set too |
| Undo a publication | `DOLT_REVERT` on `main` |

An agent writes only to the draft and publishes only on a person's instruction, as
in `app/v3`.

**The branch of a connection.** The current branch is session state, so a pooled
connection can stay on another branch. An App keeps one pool per branch and names
the branch in the pool's database name, `<database>/<branch>` (for example
`crm/draft/team-sales`), so that a connection cannot leave it. A name of a branch
that does not exist yet is refused as "access denied", so the App creates its draft
branch first, on a connection to the database itself.

## 5. Migrations

**Proposed.** The schema changes only through Kysely migrations in
`app/v4/migrations/`, numbered files that export `up` (and `down` where going back
is safe), applied in order by Kysely's `Migrator` (imported from `kysely/migration`
since 0.29), which records them in `kysely_migration`. The Zod schemas stay the source of the data's shape; a
migration is written from them and a test holds the two together.

**Who runs them.** An Admin, with the command `lazurio module migrate
<Organization>/<module>`, from an Environment with the level `migrate`. The command
runs the declared `migrate_script` from the Module's checkout on `main` with the
migration user's connection, and the script ends with a `DOLT_COMMIT` on `main` that
names the migrations. A migration changes the data of everyone, so for an agent it
is a Publication: it runs one only on a person's instruction.

**Why not at a start or in the preparation.** The standard forbids both, for good
reasons: a start runs exactly one server and no migration; `prepare_script` makes no
network calls and receives no secrets. Several Environments would also race to
migrate one shared database.

**The order of a change.**

1. A pull request adds the migration and the code that needs it. Migrations are
   additive by default: new tables and new nullable columns, so that the code on
   other Environments keeps working.
2. After the merge an Admin runs the migration.
3. Environments pick up `main` and restart the App, each at its own time.
4. A destructive step, such as dropping a column, is a later pull request, once
   every Environment runs code that no longer uses it.

**The check at a start.** The App compares the last migration in its directory with
`kysely_migration` on `main`.

| State | What the App does |
| --- | --- |
| The same | It runs |
| The database has a newer migration | It runs: the migration is additive, and its own code is simply older. It logs the difference once |
| The database is behind the App | It starts, but its data routes answer the typed 503 `database-schema-behind` naming the missing migration, and the person sees that the Admin has to migrate. It checks again at most every 30 seconds, so it recovers without a restart |

Drafts take a new schema with the next merge of `main` into the draft, which is why
additive changes matter here too.

## 6. Development, tests and CI

**Proposed.**

- **On an Environment.** `dev_script` gets the same variables as the built App, so
  development runs against the real service and the Environment's own draft. A
  change stays in the draft until someone publishes it, as with a `db/` checkout in
  `app/v3`.
- **Without a grant or on your computer.** A separate script `dev:demo` starts the
  App against a local `dolt sql-server` with seed data; it is the Module's own and
  never the start path, which is what the standard says about a demo mode.
- **Tests.** The App's tests start a `dolt sql-server` at `tested_version` on a free
  loopback port with a temporary directory, apply the migrations and run
  `tests/store-contract.ts`. `bun run check` stays the one gate.
- **CI.** The Module's Linux workflow downloads that Dolt release, checks its
  published digest and runs `bun run check`. `check` needs no network beyond it and
  no secret.
- **The Dolt binary on an Environment.** The Platform provides the version the App
  names from its runtime cache, the way it provides the pinned Bun (F62). Until it
  does, the App's README tells how to get it.

## 7. History and audit

**Proposed.** `main`'s history is the audit: `dolt_log` lists every publication with
its identity, time and summary, and the diff tables show exactly what changed.

- **A commit names the Environment.** Without `--author`, Dolt writes the SQL user as
  the commit's committer and author, and that is the one identity the database itself
  checked. So the App passes no `--author`: Dolt replaces both fields with it, and
  nothing in the commit then shows who was connected.
- **A publication names the person in its message.** Where the verified identity of
  0196 is available, the Module's server adds a trailer `Lazurio-Person: <login>` to
  the summary. Where it is not, the commit names the Environment alone, which fits
  0196: data are reached by the Environment.
- **It remains information, not proof.** A user who may commit can pass `--author`, as
  no grant limits a procedure's arguments. The audit shows what an honest Module's
  server recorded; it does not hold against the Environment's own operator.
- **What Dolt adds over Git.** A draft's saves are visible as a diff before they are
  published, and a publication that was wrong is undone by a commit of its own.
- **What a commit does not hold.** A summary or a branch name holds no personal data,
  because it survives an erasure ([personal data](#9-personal-data)).

## 8. Backups and restore

**Decided**, with the details proposed in Machines: every 15 minutes `dolt backup`
of every database with all branches and drafts, to Google Cloud Storage in the
Organization's own EU project, rotated through hourly and daily copies, together
with a dump of users and grants. The Module does nothing for this.

A backup carries the branches and the uncommitted drafts, and it carries no users,
which is why the dump exists. A sync into a target that already holds a copy leaves
the old files there, so Machines proposes a new target for every copy, with old
copies expiring by age. That is also what makes [erasure](#9-personal-data) end.

Restoring is an Admin's step on the services Environment: the database and its users
come back from a chosen copy. What was written after that copy is lost. A Module sees
a restore as a short outage and its data at the restored point. A standby is not a
backup: it replicates a mistake within seconds.

## 9. Personal data

**Proposed; the method is [question 2](#open-questions).** 0196 names deletable
personal data as one reason to choose a database. Dolt alone does not give it: like
Git it keeps every commit, so `DELETE` removes a person from the current state and
leaves them in the history, the drafts, the standby and the backups.

| Way | What it does | Audit | Cost |
| --- | --- | --- | --- |
| **Rewriting the history** (recommended) | `dolt filter-branch` removes the rows from every commit of every branch and from the drafts; garbage collection removes the old data on each node; backups expire | Who, when and the summary stay; the erased content and the old commit hashes are gone; an erasure record says who erased what and when | A short write pause and an Admin's operation, implemented once for all Modules |
| Encrypting per person | Personal columns are encrypted with a key per person, kept outside the history; deleting the key makes every copy unreadable | Stays complete, hashes included | Every Module has to encrypt, personal columns cannot be searched, a lost key store loses data |
| Keeping personal data out of the history | Tables in `dolt_ignore` are never committed, so they have no history | Nothing about those columns | No draft, review or undo for them, and each branch has its own copy |

**Why rewriting.** It removes the data instead of access to it, in one operation
for every Module, while most Modules are written by agents and per-Module cryptography
is a poor default for them. What it costs the audit is what erasure asks for. The
old commit hashes are the only collateral loss, and nothing in this contract refers
to a commit by its hash.

What a Module has to do for it:

- Keep personal data in columns of rows it can name by a subject key, so that the
  erasure is one precise statement. The Module's `AGENTS.md` lists those tables.
- Keep personal data out of commit summaries and branch names.

The erasure itself is a Machines runbook, an Admin's step: stop the primary, run
`dolt filter-branch --all --apply-to-uncommitted`, run `dolt gc --full`, start it again,
let replication carry the rewritten branches, and run `dolt_gc` on the standby. The
person is then gone from every live copy. Backups hold them until the last copy from
before the erasure expires, 14 days with the proposed retention, and a restore from
such a copy has to repeat the erasure, so the erasure records are kept outside the
database.

## 10. Network

**Decided** in 0209: an Environment connects only to the `database` service of its
own server, over the server's internal network, without a tailnet.

**Proposed.** Services so far speak HTTP behind Caddy; a database needs a TCP path:

- The service listens on the server's bridge in the usual range 8400–8499, so the one
  existing firewall rule of a granted Environment already covers it and no client
  firewall changes.
- A TCP ingress admits only the bridge addresses of the Environments with a grant.
  The SQL user and its token identify the caller. An address alone is not enough, and
  neither is a token alone.
- TLS runs from the App to Dolt itself, through the ingress, on both servers.
- On the server without the primary, the ingress forwards the connection to the
  primary across the link between the services Environments. Reads go the same way
  for now ([question 5](#open-questions)).

## 11. Limits

**Proposed.** The service has required memory, CPU and process limits like every
service. The standard services Environment has no room for it, so an Organization
that uses `app/v4` enlarges it first, which restarts every service of the server for
about a minute. The numbers come from the pilot.

An App keeps a small pool: at most 5 connections per branch unless it has a measured
reason. Long transactions hold back everyone on that database's branch, and a large
import runs in batches. The database has a size limit in practice, its volume, and
the Admin sees its use in Služby serveru.

## 12. Moving a Module from app/v3 to app/v4

**Proposed.** A generation transition as the stack profile describes it: planned,
reviewed and reversible.

1. **The new App beside the old one.** `app/v4/` starts from `app/v3/`: `src/domain/`,
   `src/server/`, `src/ui/` and `tests/store-contract.ts` stay; `src/data/dolt-store.ts`
   implements the storage port. A Module keeps at most two generations.
2. **Tables from collections.** Each collection becomes a table. A record's `id`
   becomes the primary key, its flat fields columns and a named nested list a table of
   its own. The Zod schema decides the column types.
3. **The grant.** The Deployment Repo's pull request adds the database and the
   Environments' levels, and an Admin runs the first migration.
4. **The same tests.** `tests/store-contract.ts` passes against repository-db and
   against Dolt.
5. **The freeze.** Publication into the data repository stops at a recorded commit, and
   open drafts are published or discarded first: a draft does not move.
6. **The import.** `migrate:v3-to-v4` reads every record through the v3 store,
   validates it with the same Zod schemas, writes it to Dolt and makes one commit that
   names the data repository's commit. It proves the counts and a round trip of every
   record. The history before the import stays in the data repository.
7. **The switch.** `default_app` moves to `app/v4/package.json` on the decision of the
   Organization's Steward or the person, never as a conformance fix.
8. **The way back.** `export:v4-to-v3` writes `main` back into the data repository as
   one commit, and `default_app` returns. It works as long as `app/v3` is kept; it
   brings records, not Dolt's history or drafts.

## Verified locally

On 2026-11-05 on Linux x64, two `dolt sql-server` 2.6.2 nodes in a cluster with TLS on
one computer, driven with `mysql2` 3.24.6 and Kysely 0.29.8 under Bun 1.4.4, with
backups to a local directory. This shows the design is possible; it is not the
prototype of the phases below.

| Claim | Result |
| --- | --- |
| Encrypted connections only, chain and name verified | A plain connection, another CA and an address instead of the name are refused; `ssl.servername` is ignored |
| `read` | `SELECT` works; writes, commits, branches and DDL are refused |
| `write` | Works with per-procedure `EXECUTE`; DDL, `dolt_gc`, `dolt_backup`, `dolt_remote`, `CREATE USER` and role changes are refused. With `EXECUTE` on the database a user demoted the primary |
| Branch permissions | Another Environment's draft is refused, and so is creating another branch, forcing `main` or deleting a foreign draft |
| A connection on a branch, a database name with a hyphen | `crm/draft/env-a` and `mission-control/main` work |
| A commit's identity | Without `--author` the SQL user; with it, the given name in both fields |
| Conflicting publications | The second merge is refused and `main` does not move |
| Kysely | `Migrator` applies migrations and records them; queries work |
| Replication | `main`'s head, branches and working sets reach the standby, which refuses writes. Users, grants and branch permissions reach it too, on each change |
| Backup and restore | Branches and an uncommitted draft come back, users do not |
| Planned and emergency failover | No published commit lost in the planned one; a former primary returns as a standby of the higher epoch |
| Erasure | The marked person is gone from the storage of both nodes and from the drafts, messages and committers are kept, hashes change. A sync into the same target keeps the old data, and a new target does not have it |

Not verified: a TCP proxy in the path, Google Cloud Storage, `dolt_revert`, the cost of
anything at a real size, latency between servers, and `tests/store-contract.ts`.

Two findings differ from what the [register][0209] and Dolt's documentation say, and
neither changes a decision. Dolt 2.6.2 does replicate users and grants, though a new
standby gets them only with the next change, and a backup still does not carry them,
so the dump stays. And a copy does not fully overwrite its target, so rotation by
overwriting would keep erased data.

## Phases

1. **Decisions.** The 0209 amendment is in force for the service; this contract and
   the [open questions](#open-questions) follow.
2. **A prototype without servers.** Two `dolt sql-server` nodes at the pinned version
   in CI, and one alone: writes, replication, both failovers, forwarding, backup and
   restore with users, Kysely and `mysql2`.
3. **Machines.** The kind `database` with its grants, backups and runbooks.
4. **The Platform.** The declaration, the handover member, the variables, `lazurio
   module migrate` and the Dolt binary for tests; a release of `@lazurio/module-kit`;
   this closes #818. The stack profile then lists a template.
5. **The first template.** Mission Control `app/v4`, which needs the storage port of
   [LazurioTemplates/mission-control#14](https://github.com/LazurioTemplates/mission-control/issues/14) settled.
6. **A pilot in the reference Organization** on two real servers, with measured
   latencies, failovers and a restore.
7. **The other Organizations**, one by one, each with its Admin's consent and window.

## Open questions

Each has a recommendation; none is decided by this page.

1. **Where the token comes from.** (a) Recommended: Machines renders it into a file as
   it does the AI pool's token, because the grant is Machines' anyway, one apply
   rotates or revokes it, and no vault hand-over has to be built first. This needs an
   amendment of F46 and of the Module Standard, which call the vault the only source
   of an App's secrets. (b) Machines hands it to the Environment's vault and the
   Platform reads it as a runtime secret. It keeps one source, but needs that
   hand-over, a vault on every such Environment, and a second step for each rotation.
   Neither is safer: the same account reads both.
2. **How personal data is erased.** Recommended: rewriting the history, as above, with
   its conditions.
3. **Who creates a Module's database.** Recommended: Machines from the Deployment
   Repo, prepared by the agent that creates the Module. The alternative, a process in
   the services Environment that reads the Organization's manifest, saves a pull
   request but adds a moving part and a second truth, and the levels need the
   Deployment Repo's pull request anyway.
4. **Whether database access follows the GitHub grant by itself.** Recommended: not
   in the first version. An Admin changes both, and the Dashboard points that out.
   Later the Dashboard can prepare the Deployment Repo's pull request when an Admin
   changes a Module's access.
5. **Reads on the server without the primary.** Recommended: everything goes to the
   primary until the pilot's numbers say otherwise, because a read from the standby can
   miss what the same person has just saved.
6. **How long copies are kept.** Recommended: 24 hourly and 14 daily copies. This is
   also the time an erased person stays in backups.
7. **Who runs migrations.** Recommended: only an Environment with the level `migrate`,
   the Admin's; an agent only on a person's instruction.
8. **Personal Modules.** Recommended: they stay in `app/v3`. A Dolt on a personal
   Environment would need a contract of its own and has no current need.
9. **Who a commit names.** Recommended: the Environment, which the database checked,
   with the person in a trailer. The alternative, the person in `--author`, reads better
   in `dolt_log` but loses the Environment.

## Related

- [Stack profiles](stack-profiles.md#app-database), the profile `app-database`.
- [Module Standard](module-standard.md), to be amended when this contract is accepted.
- Machines `docs/server-services-database.md`: the service kind, its operation, backups
  and failover.

[0177]: decision-register.md#0177--secrets-an-app-needs-at-start-come-from-the-environment-vault-never-from-env-files
[0196]: decision-register.md#0196--module-data-the-environments-ceiling-narrowing-in-the-app-and-a-verified-identity-that-is-not-a-key
[0209]: decision-register.md#0209--server-services-one-services-machine-on-each-organization-server-entered-only-by-its-admins-with-one-container-per-service-and-the-ai-pool
[f46]: decisions.md#f46--runtime-secrets-declared-names-read-from-the-environment-vault-before-every-start-fail-closed
[f69]: decisions.md#f69--stack-profiles-the-exact-tools-a-module-is-built-with-changed-only-by-a-generation-transition-or-a-profile-release
