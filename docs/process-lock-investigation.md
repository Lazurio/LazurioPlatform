# Process-bound Folder lock investigation

The current directory lock preserves evidence after process death but cannot prove
that an old owner is gone. Do not remove it based on age or a guessed PID.

`scripts/smoke-sqlite-lock.ts` is an isolated feasibility experiment using Bun's
built-in SQLite driver, not an adopted product lock or a new state database. Compile
and run it as a standalone executable in a disposable test environment:

```sh
bun build scripts/smoke-sqlite-lock.ts --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/sqlite-lock-probe
./dist/sqlite-lock-probe
```

Do not run the TypeScript entrypoint directly: subprocesses use the executable path.
It creates only synthetic temporary data. It tests exclusive transaction contention,
owner SIGKILL, a pair of subsequent contenders, preserved sentinel data and refusal
of symlink/directory targets with `SQLITE_OPEN_NOFOLLOW`. This is not part of ordinary
product startup and does not change `withFolderOperationLock`.

The preceding isolated experiment passed on macOS ARM64 and Linux ARM64 for
contention and owner death. The added NOFOLLOW scenarios have only been exercised
on macOS so far. The checked-in runner also passed its standalone macOS execution
after adding bounded subprocess cleanup and canonical-path handling. Windows and
network filesystems are unqualified; the earlier Linux artifact does not qualify
these newer source changes.

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
