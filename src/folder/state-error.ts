import {
  instructionTemplateRevision,
  isOlderTemplateRevision,
  isTemplateRevision,
} from "./render";
import { FolderStateUnreadable, folderStateConditions } from "./state-fields";

/** What may be said about a Folder state this version cannot read: only
 * enumerated values, a state file's own name, a Folder-relative key of a
 * checked shape and template revisions of this product's form. Never an
 * error message, a path or other recorded content. */
export type FolderStateRefusal = Readonly<{
  condition: FolderStateUnreadable["condition"];
  file?: string;
  field?: string;
  /** The template revision the Folder records, and this version's. */
  recorded?: string;
  product: string;
  /** The Folder was rendered by a newer template than this version's. */
  newer?: true;
}>;

const stateFiles = new Set(["preferences.json", "instructions.json"]);

export function folderStateRefusal(
  error: unknown,
  product: string = instructionTemplateRevision,
): FolderStateRefusal {
  const known = error instanceof FolderStateUnreadable ? error : undefined;
  const recorded =
    typeof known?.templateRevision === "string" &&
    isTemplateRevision(known.templateRevision)
      ? known.templateRevision
      : undefined;
  return Object.freeze({
    condition: known?.condition ?? "invalid",
    ...(known?.file !== undefined && stateFiles.has(known.file)
      ? { file: known.file }
      : {}),
    ...(known?.field === undefined ? {} : { field: known.field }),
    ...(recorded === undefined ? {} : { recorded }),
    product,
    ...(recorded !== undefined && isOlderTemplateRevision(product, recorded)
      ? { newer: true as const }
      : {}),
  });
}

/** One line for a person: which file, what about it, and which template
 * wrote it when that explains it. */
export function describeFolderStateRefusal(refusal: FolderStateRefusal) {
  const where = [refusal.file, refusal.field].filter(Boolean).join(" ");
  const written =
    refusal.recorded === undefined
      ? ""
      : `; the Folder was rendered by ${refusal.recorded}, this version renders ${refusal.product}${refusal.newer ? ", an older one" : ""}`;
  return `${refusal.condition}${where === "" ? "" : ` (${where})`}${written}`;
}

/** Reads back what `folderStateRefusal` produced from another process's
 * output, keeping only values of the same checked shapes. */
export function parseFolderStateRefusal(
  input: unknown,
): FolderStateRefusal | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const conditions: readonly string[] = folderStateConditions;
  if (
    typeof value.condition !== "string" ||
    !conditions.includes(value.condition) ||
    typeof value.product !== "string" ||
    !isTemplateRevision(value.product)
  )
    return undefined;
  const error = new FolderStateUnreadable(
    value.condition as FolderStateRefusal["condition"],
    {
      ...(typeof value.file === "string" ? { file: value.file } : {}),
      field: value.field,
      templateRevision: value.recorded,
    },
  );
  // The product revision is the other version's, not this one's.
  return folderStateRefusal(error, value.product);
}
