import { join } from "node:path";
import { readSettings } from "../buddy/chat";

// The Chat's beta switch of linked environments, `linkedEnvironmentsEnabled`
// (T3 Code's default: off). The links read it from `settings.json` and never
// write the file: T3 Code owns its settings (decision F51), so the switch is
// changed only through the running server (`server.updateSettings`, see
// `rpc.ts`), which serialises its own writes.

export const linkedEnvironmentsKey = "linkedEnvironmentsEnabled";

/** The Chat's T3 home, under the user's home. */
export const chatT3Home = ".t3";

/** Whether the Chat's beta switch is on: true, false, or null when the file
 * cannot be read as T3 Code keeps it. */
export async function linkedEnvironmentsOn(
  home: string,
): Promise<boolean | null> {
  const read = await readSettings(
    [join(home, chatT3Home), join(home, chatT3Home, "userdata")],
    join(home, chatT3Home, "userdata", "settings.json"),
  );
  if (read === "unsafe") return null;
  return read.document[linkedEnvironmentsKey] === true;
}
