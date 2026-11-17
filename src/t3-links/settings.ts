import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readSettings, replaceIfUnchanged } from "../buddy/chat";

// The one member of the Chat's T3 Code settings that the links between T3
// Code servers own (root decision 0157, amended 2026-11-17; plan step R4c):
// `linkedEnvironmentsEnabled`, T3 Code's beta switch of linked
// environments, which defaults to off. It is on only where the Organization
// records the edge from the person's Personal Environment to their Work
// Environment (0246), on both ends, and goes back to off when the edge goes,
// but only where Lazurio turned it on: a switch the person set stays theirs.
//
// The running server watches `settings.json` and reloads it (T3 Code
// `serverSettings.ts`), and before each write of its own it reads the file
// again, so this member is written into the file and the server takes it
// without a restart. The file is replaced atomically and only while it still
// holds what was read (`replaceIfUnchanged`, as for Buddy's settings); every
// other member stays byte for byte as T3 Code wrote it. A file T3 Code could
// not decode, one with comments, a link or another kind of file is left as it
// is (`unsafe`). The tick that follows writes again whatever a concurrent
// write of the server replaced. Without the Chat's state directory (no T3
// Code here) nothing is created (`absent`).

export const linkedEnvironmentsKey = "linkedEnvironmentsEnabled";

export type LinkedSetting =
  | "unchanged"
  | "written"
  | "absent"
  | "unsafe"
  | "busy";

/** The Chat's T3 home, under the user's home. */
export const chatT3Home = ".t3";

const writeAttempts = 5;

async function isDirectory(path: string) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the Chat's beta switch is on now: true, false, or null when the
 * file cannot be read as T3 Code keeps it. */
export async function linkedEnvironmentsOn(
  home: string,
): Promise<boolean | null> {
  const directories = [
    join(home, chatT3Home),
    join(home, chatT3Home, "userdata"),
  ];
  const read = await readSettings(
    directories,
    join(home, chatT3Home, "userdata", "settings.json"),
  );
  if (read === "unsafe") return null;
  return read.document[linkedEnvironmentsKey] === true;
}

/** Sets the Chat's beta switch: on writes `true`, off removes the member,
 * which is T3 Code's default. A switch already where it should be is not
 * touched. */
export async function setLinkedEnvironments(
  home: string,
  on: boolean,
): Promise<LinkedSetting> {
  const directories = [
    join(home, chatT3Home),
    join(home, chatT3Home, "userdata"),
  ];
  if (!(await isDirectory(directories[1] as string))) return "absent";
  const path = join(directories[1] as string, "settings.json");
  for (let attempt = 0; attempt < writeAttempts; attempt += 1) {
    const read = await readSettings(directories, path);
    if (read === "unsafe") return "unsafe";
    const current = read.document[linkedEnvironmentsKey] === true;
    if (current === on) return "unchanged";
    const { [linkedEnvironmentsKey]: _removed, ...rest } = read.document;
    const next = on
      ? { ...read.document, [linkedEnvironmentsKey]: true }
      : rest;
    if (
      await replaceIfUnchanged(
        path,
        read.raw,
        `${JSON.stringify(next, null, 2)}\n`,
        async () => undefined,
      )
    )
      return "written";
  }
  return "busy";
}
