# OS-owned applications — native Linux ARM64 evidence, 2026-09-19

Public-safe transcript. Synthetic fixtures only; no Organization data, credentials,
addresses or host keys. This is evidence for one cell (`linux-arm64`), not for
`linux-x64`, macOS, Windows, a real Organization module or an installed product.

## Machine

- Disposable local virtual Machine cloned from a clean Ubuntu base image for this run
  and deleted afterwards. Ubuntu 24.04.4 LTS, Linux 7.0.0-30-generic, aarch64.
- `systemd 255 (255.4-1ubuntu8.17)`, cgroup v2. Account reached over SSH;
  `XDG_RUNTIME_DIR=/run/user/1000`; `systemctl --user is-system-running` → `running`;
  `loginctl show-user … -p Linger` → `Linger=no` (not changed).
- Source commit `5245b88` (clean tree). Cross-compiled on macOS with
  `bun build … --compile --target=bun-linux-arm64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig`.
  - `src/cli.ts` → SHA-256 `2672c4e2b97439656dd8582b9279bd4c373d58a106a21b09782a48f1ee07ae21`
  - `scripts/smoke-application-service.ts` → SHA-256 `5dbe871e4eb6b2bf1dbd58dc5f5ff57e2bac7d5b6c70aa197c5e045ff44b8f95`
- Module toolchain: Bun 1.4.2 `linux-aarch64`, copied into a private temporary
  directory. Nothing was installed system-wide; no package manager was run.

## What the real service manager exposed (before the design was fixed)

Probed with plain `systemd-run --user` and a shell fixture:

| Question | Observation | Consequence |
| --- | --- | --- |
| Does the manager expand command arguments? | `$HOME` and `${HOME}` arrived expanded; `%h` and `%%` arrived literally | `--expand-environment=no` (systemd ≥ 254); an older manager refuses an argument containing `$` |
| What environment does a user service get? | The manager's own: `HOME LANG LOGNAME PATH SHELL USER XDG_RUNTIME_DIR XDG_DATA_DIRS DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK …` plus `INVOCATION_ID MANAGERPID SYSTEMD_EXEC_PID MEMORY_PRESSURE_*` | An agent socket is an ambient credential: every undeclared manager variable is unset by name |
| Does `UnsetEnvironment=` give an exact environment? | Yes: only the declared names and `INVOCATION_ID` remained | Environment is an allowlist |
| `UMask=0077`? | Application reported `0077` | Same creation mask as the guard |
| Does stop reach a descendant that called `setsid`? | Yes; the control group directory disappeared, no process left | Stronger than process-group ownership |
| Crash (exit 3, or `SIGKILL`) | Unit stays `failed` with `Result=exit-code` / `signal`, `ControlGroup=` empty, `InvocationID` kept; user manager becomes `degraded` | Status reports the result; selection must accept `degraded` |
| Start while that failed record exists | Refused: "was already loaded or has a fragment file"; after `reset-failed` it starts | Start clears the record after proving the group empty |
| Clean exit (0) | Unit unloaded, no record | `not-managed` |
| Non-existent executable | `systemd-run` itself fails, no unit created | `launch-failed`, nothing to clean |
| `systemctl --user set-property --runtime` | `DropInPaths=` becomes non-empty; `Transient=yes`, `FragmentPath` under `$XDG_RUNTIME_DIR/systemd/transient/` | A hand-edited unit is detectable and refused |
| Unknown unit | `show` exits 0 with `LoadState=not-found` | State is parsed, not the exit code |
| Last login session ends, `Linger=no` | A running transient unit was `inactive` in the next session | Lingering is a Machine prerequisite for surviving logout; not set by Lazurio |

## Tests from source on the guest

`HOME` pointed at a fresh temporary directory; the real manager was reached only
through `XDG_RUNTIME_DIR`.

```text
bun test tests/systemd-user-integration.test.ts tests/systemd-user-runner.test.ts \
  tests/module-lifecycle.test.ts tests/guarded-process.test.ts tests/application-view.test.ts
(pass) a real user service survives its owner, is rediscovered by identity and stops
       with its control group [283.83ms]
 50 pass
 0 fail
 531 expect() calls
Ran 50 tests across 5 files. [81.33s]
```

The real-manager test observed, on real systemd: application environment exactly
`FIXTURE_PORT HOME INVOCATION_ID PATH`; arguments `$HOME`, `${XDG_RUNTIME_DIR}` and `%h`
delivered literally; umask `77`; `application-running` for preparation; the owner
closed and the application still answered; a new owner saw the same `InvocationID`;
stop → `group-stopped`, control group unpopulated, the `setsid` descendant gone, port
closed; a crashing application → `state: "ended"`, `result: "exit-code"`,
`ActiveState=failed`; the next start reset it and got a new `InvocationID`.

The unchanged session contract also passed on Linux (`module-lifecycle`,
`guarded-process`), and the existing `scripts/smoke-application-native.ts` passed with
the explicit `session` runner.

## Qualification through the compiled CLI

`./service-qualification /tmp/lazurio --module-bun <private bun>` — three consecutive
runs, all `exit=0`, 7.4–7.7 s wall time each. One run, verbatim (unit digests are
masked by the script):

```json
{"pass":true,"platform":"linux","arch":"arm64","systemd":"systemd 255 (255.4-1ubuntu8.17)","userManager":"running","cliSha256":"2672c4e2b97439656dd8582b9279bd4c373d58a106a21b09782a48f1ee07ae21","runner":"systemd-user","unit":"lazurio-app-<digest>-example.fixture.app-<digest>.service","sameInvocationAcross":["graceful Launchpad exit (SIGTERM)","new Launchpad","Launchpad crash (SIGKILL)","third Launchpad"],"applicationEnvironment":["HOME","INVOCATION_ID","LAZURIO_RUNTIME_LISTENER_WEB_HOST","LAZURIO_RUNTIME_LISTENER_WEB_PORT","NODE","PATH","PWD","SHLVL","_","npm_command","npm_config_local_prefix","npm_config_user_agent","npm_execpath","npm_lifecycle_event","npm_lifecycle_script","npm_node_execpath","npm_package_json","npm_package_name"],"preparationWhileRunning":"application-running","crashRecovery":"stale dependency-owner lock of the killed Launchpad removed by the operator","controlGroupGoneAfterStop":true,"timings":{"startMs":1278,"startToHealthyMs":97,"gracefulLaunchpadExitMs":2,"rediscoveryMs":100,"stopMs":100},"note":"real systemd user manager and compiled CLI with a declared Bun module; transient units only. Not reboot persistence, lingering, product activation, hosted entry or a real Organization module."}
```

Sequence asserted by the script: `folder-init` → canonical Organization fixture with a
declared Bun module → `launchpad --application-runner systemd-user` → `app-request`
prepare/start → healthy status naming `runner: "systemd-user"` and an `InvocationID`
equal to `systemctl --user show` → open → page fetched → prepare refused with
`application-running` → Launchpad `SIGTERM` (exit 0) → page still answers, same
`InvocationID` → second Launchpad reports it healthy under the same `InvocationID`,
`start` → `already-managed` → Launchpad `SIGKILL` → page still answers → third Launchpad
reports the same `InvocationID` → stop → `LoadState=not-found`, control group
unpopulated, port closed, `not-managed` → a new start has a **different**
`InvocationID` → stop → Launchpad `SIGTERM` exit 0.

| Timing (3 runs) | ms |
| --- | --- |
| `start` request, including the module's declared start check | 1278 / 1297 / 1285 |
| started → declared health and control-group ownership observed | 97 / 104 / 99 |
| graceful Launchpad exit with a running application | 2 / 2 / 2 |
| new Launchpad → same application reported healthy | 100 / 110 / 108 |
| stop → control group confirmed gone | 100 / 80 / 72 |

The application's environment shows the declared names plus what `bun run` itself adds
for a package script (`npm_*`, `NODE`, `PWD`, `SHLVL`, `_`). Nothing from the manager
except `INVOCATION_ID`: no session bus, no agent socket, no login environment.

## Not dependable / not shown

- **Launchpad crash.** After `SIGKILL` the application and status were unaffected, but
  the first Stop through the next Launchpad failed (`operation-failed`): the killed
  Launchpad's retained dependency-owner `.operation-lock` is never reclaimed
  automatically (pre-existing, documented). The script removed that empty lock as an
  explicit operator step — it knew the owner was dead because it had killed it — and
  Stop then succeeded. A graceful exit releases the lock and needs nothing.
- `Linger=no`: the application ends with the account's last login session.
- Not exercised: reboot, reboot persistence, lingering enabled, product activation,
  two live owners operating concurrently, `linux-x64`, systemd older than 254 (the `$`
  refusal is unit-tested only), a real Organization module, hosted entry.

## Cleanup

After the runs: no `lazurio-app-*` unit loaded, no temporary qualification home left,
`~/.config/systemd` never existed. The guest was synced and powered off from inside,
and the disposable clone was deleted.
