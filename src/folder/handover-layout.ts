import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "./owned-directory";
import { stateFields } from "./state";

const names = ["root", "organizations", "personalspace"] as const;
type Identity = Readonly<{ dev: string; ino: string }>;
export type HandoverLayout = Readonly<Record<(typeof names)[number], Identity>>;

export function parseHandoverLayout(value: unknown): HandoverLayout {
  const fields = stateFields(value, names);
  const result = {} as Record<(typeof names)[number], Identity>;
  for (const name of names) {
    const identity = stateFields(fields[name], ["dev", "ino"]);
    if (
      typeof identity.dev !== "string" ||
      typeof identity.ino !== "string" ||
      !/^\d+$/.test(identity.dev) ||
      !/^\d+$/.test(identity.ino)
    )
      throw new Error("Invalid handover directory identity");
    result[name] = Object.freeze({ dev: identity.dev, ino: identity.ino });
  }
  return Object.freeze(result);
}

export async function inspectHandoverLayout(
  folder: string,
): Promise<HandoverLayout> {
  const identities = {} as Record<(typeof names)[number], Identity>;
  for (const name of names) {
    const stat = await inspectOwnedDirectory(
      name === "root" ? folder : join(folder, name),
    );
    identities[name] = { dev: String(stat.dev), ino: String(stat.ino) };
  }
  if (names.some((name) => identities[name].dev !== identities.root.dev))
    throw new Error("Cross-filesystem handover layout");
  return parseHandoverLayout(identities);
}

export async function verifyHandoverLayout(
  folder: string,
  receipt: HandoverLayout,
) {
  const observed = await inspectHandoverLayout(folder);
  if (
    names.some(
      (name) =>
        observed[name].dev !== receipt[name].dev ||
        observed[name].ino !== receipt[name].ino,
    )
  )
    throw new Error("Handover layout changed; operator repair required");
}

// No traversal into Organization/Personalspace contents, no writes or cleanup.
export async function requireEmptyHandoverLayout(
  folder: string,
  claimed = false,
) {
  const entries = await readdir(folder);
  const allowed = claimed
    ? ["organizations", "personalspace", ".lazurio"]
    : ["organizations", "personalspace"];
  if (
    entries.length !== allowed.length ||
    entries.some((entry) => !allowed.includes(entry))
  )
    throw new Error(
      "Fresh handover requires exactly the empty standard layout",
    );
  for (const name of ["organizations", "personalspace"])
    if ((await readdir(join(folder, name))).length !== 0)
      throw new Error("Handover contains work; adoption is not supported");
}
