# Process-bound Folder lock investigation

The current directory lock preserves evidence after process death but cannot prove
that an old owner is gone. Do not remove it based on age or a guessed PID.

`scripts/smoke-sqlite-lock.ts` is an isolated feasibility experiment using Bun's
built-in SQLite driver, not an adopted product lock or a new state database. Compile
and run it as a standalone executable in a disposable test environment:

```sh
bun build scripts/smoke-sqlite-lock.ts --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/sqlite-lock-probe
./dist/sqlite-lock-probe
for run in {1..10}; do ./dist/sqlite-lock-probe || exit 1; done
```

Do not run the TypeScript entrypoint directly: subprocesses use the executable path.
It creates only synthetic temporary data. It tests exclusive transaction contention,
owner SIGKILL, a confirmed successor excluding a subsequent contender, preserved sentinel data and refusal
of symlink/directory targets with `SQLITE_OPEN_NOFOLLOW`. This is not part of ordinary
product startup and does not change `withFolderOperationLock`.

The runner at source `2957a7231cc41b9a10f673d596ef003caf59bcef` passed one
native Linux ARM64 run, including NOFOLLOW and cleanup, in an existing isolated
Ubuntu 24.04 development clone. Its executable SHA-256 was
`9cc7a82866e920ae23b95eb8a0045ada768cdb92f6eb9dad4a3b56fac37f2e08`.
Independent repeated macOS runs subsequently exposed an unstable simultaneous-open
scenario: both contenders could report busy. The revised protocol confirms successor
acquisition before starting the excluded contender and checks continued exclusion
before killing the holder. It rejects watchdog expiry and verifies SIGKILL termination.
This proves bounded sequential takeover and exclusion, not fairness or guaranteed
progress among simultaneously opening contenders. The earlier Linux artifact does
not qualify this revised protocol. Windows and network filesystems remain unqualified;
none of these experiments establishes clean-install or product-runtime qualification.

## Integration conditions, not an implementation claim

- Retain one lock namespace: a second independent filename would let old and new
  writers run concurrently. Old directory locks must remain refused, never deleted
  or adopted automatically. A versioned transition remains necessary.
- A permanent lock file must not be unlinked during ordinary unlock. Qualify custody,
  inode stability, hardlinks, sidecars, partial initialization and competing recovery.
- Lock acquisition alone does not validate external files. Existing journal and
  creation-receipt checks must still decide whether forward completion is safe.
- Store no Organization records or duplicate profile state in a lock database.
  SQLite rollback of test rows is not rollback of a Folder migration.
- No installed format, runtime dependency, migration command or permission policy
  is adopted by this experiment.

References: [Bun SQLite](https://bun.com/docs/runtime/sqlite),
[SQLite locking](https://www.sqlite.org/lockingv3.html).
