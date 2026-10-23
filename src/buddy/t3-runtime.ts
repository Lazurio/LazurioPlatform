import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

// Buddy's own `t3` (Machines `docs/workspace-application-entry.md`, "Buddy's
// T3 on a personal Environment"; F61's addendum of 2026-10-22): whatever runs
// `t3 … --base-dir ~/.t3-buddy`, the Launchpad's pairing on Buddy's origin and
// Delegace alike, runs the runtime that the unit of his T3 Code names in its
// `ExecStart`, `~/.t3-buddy/runtime/versions/<version>/t3`. Never the `t3` on
// PATH (`~/.local/bin/t3`): it follows the person's Chat T3 and may be newer
// after an update in the app, and a newer T3 Code migrates a home it opens
// forward. Machines render that unit (`workloads/workspace-vm/buddy-t3.ts`)
// and install exactly its pinned runtime; this reads the unit as Machines' own
// reader does (`t3_buddy_unit_version` in `t3-service.py`), and Delegace,
// which is Python, carries the same rule (`t3_runtime` in `delegace/delegace`).

/** The home of Buddy's T3 Code, under the user's home. */
export const buddyT3Home = ".t3-buddy";

/** The unit that runs Buddy's T3 Code, among the user's systemd units. */
export const buddyT3Unit = "lazurio-t3-buddy.service";

/** At most this much of the unit is read; Machines render about 1 KiB. */
const unitBytes = 64 * 1024;

/** A runtime's version as Machines' reader takes it (`T3_EXACT_VERSION`):
 * Semantic Versioning, so one path segment, never `.` or `..`. */
const exactVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The runtimes of Buddy's T3 home, for the user's `home`. */
export const buddyT3Runtimes = (home: string): string =>
  join(home, buddyT3Home, "runtime", "versions");

/** The runtime a unit's text names for the user's `home`, as Machines read
 * it: exactly one `ExecStart=` line, whose command is
 * `<home>/.t3-buddy/runtime/versions/<version>/t3` and whose first argument
 * is `serve`. Undefined for any other unit: none or two `ExecStart=`, a
 * prefix or a quote, another path, a version of another shape. Pure. */
export function buddyT3RuntimeOf(
  unit: string,
  home: string,
): string | undefined {
  const starts = unit
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ExecStart="));
  if (starts.length !== 1) return undefined;
  const [program, verb] = (starts[0] as string)
    .slice("ExecStart=".length)
    .trim()
    .split(" ");
  const prefix = `${buddyT3Runtimes(home)}/`;
  if (verb !== "serve" || program === undefined || !program.startsWith(prefix))
    return undefined;
  const [version, name, ...rest] = program.slice(prefix.length).split("/");
  return version !== undefined &&
    exactVersion.test(version) &&
    name === "t3" &&
    rest.length === 0
    ? program
    : undefined;
}

/** The text of the unit of Buddy's T3 Code: a regular file of at most
 * `unitBytes` in UTF-8, never through a link; undefined otherwise. */
async function readUnit(home: string): Promise<string | undefined> {
  try {
    const handle = await open(
      join(home, ".config", "systemd", "user", buddyT3Unit),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const buffer = Buffer.alloc(unitBytes + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > unitBytes) return undefined;
      }
      // A byte order mark stays a character, as Delegace's Python reads it.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, length),
      );
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Buddy's own `t3`: the runtime his T3 Code's unit names (`buddyT3RuntimeOf`)
 * for the user's absolute `home`, only while his T3 home, its `runtime` and
 * its `versions` are real directories of that home, no link on the way (as
 * Machines refuse such links, `t3_buddy_paths` and `t3_buddy_prune`), and the
 * runtime is an executable regular file inside them, a link among the
 * runtimes resolved. Undefined otherwise: no unit (a person without his T3
 * Code, a work Environment), a unit of another shape, a runtime missing or
 * not executable, a link out of the runtimes, or a T3 home or runtimes that
 * lead elsewhere, the Chat's among them. Nothing is ever run in its place. */
export async function buddyT3Runtime(
  home: string | undefined,
): Promise<string | undefined> {
  if (!home || !isAbsolute(home)) return undefined;
  const unit = await readUnit(home);
  const runtime = unit === undefined ? undefined : buddyT3RuntimeOf(unit, home);
  if (runtime === undefined) return undefined;
  try {
    const [user, runtimes, resolved] = await Promise.all([
      realpath(home),
      realpath(buddyT3Runtimes(home)),
      realpath(runtime),
    ]);
    if (
      runtimes !== buddyT3Runtimes(user) ||
      !resolved.startsWith(`${runtimes}${sep}`) ||
      !(await stat(resolved)).isFile()
    )
      return undefined;
    await access(resolved, constants.X_OK);
    return runtime;
  } catch {
    return undefined;
  }
}
