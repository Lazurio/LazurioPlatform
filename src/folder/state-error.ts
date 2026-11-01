import { manifestOutputPaths } from "./outputs";
import {
  instructionTemplateRevision,
  isOlderTemplateRevision,
  isTemplateRevision,
} from "./render";
import {
  type FolderOutputArea,
  FolderStateUnreadable,
  folderOutputAreaPaths,
  folderOutputAreas,
  folderStateConditions,
} from "./state-fields";

/** What may be said about a Folder state this version cannot read: only
 * values the product itself defines. The condition, the state file, the
 * field or output as one of the product's own names, an output's fixed
 * area, template revisions of the product's form and whether the Folder's is
 * newer. Never an error message, a path, a recorded key or other content
 * (docs/recovery.md "Two tiers", #787 review). */
export type FolderStateRefusal = Readonly<{
  condition: FolderStateUnreadable["condition"];
  file?: string;
  field?: string;
  area?: FolderOutputArea;
  /** The template revision the Folder records, and this version's. */
  recorded?: string;
  product: string;
  /** The Folder was rendered by a newer template than this version's. */
  newer?: true;
}>;

export const folderStateFiles = Object.freeze([
  "preferences.json",
  "instructions.json",
] as const);

/** The names of the two state documents' own fields and of every output a
 * manifest of this product records. A field outside this list is not named. */
export const folderStateFields: readonly string[] = Object.freeze([
  ...new Set([
    "schemaVersion",
    "revision",
    "preset",
    "machine",
    "profile",
    "customInstructions",
    "agentVoice",
    "tools",
    "toolNotes",
    "organizationSettings",
    "chatgptAppsAllowed",
    "preferenceRevision",
    "templateRevision",
    "outputs",
    ...Object.values(manifestOutputPaths).flat(),
  ]),
]);

const oneOf =
  (list: readonly unknown[]) =>
  (value: unknown): boolean =>
    list.includes(value);

/** The tier-1 rules of the refusal's own keys, for Recovery's and Doctor's
 * allowlists (`contextRules`); `recorded` and `product` are already there. */
export const folderStateContextRules: Readonly<
  Record<string, (value: unknown) => boolean>
> = Object.freeze({
  condition: oneOf(folderStateConditions),
  file: oneOf(folderStateFiles),
  field: oneOf(folderStateFields),
  area: oneOf(folderOutputAreas),
  newer: (value: unknown) => value === true,
});

function refusalOf(
  input: Readonly<{
    condition: FolderStateUnreadable["condition"];
    file?: unknown;
    field?: unknown;
    area?: unknown;
    recorded?: unknown;
  }>,
  product: string,
): FolderStateRefusal {
  const keep = (key: string, value: unknown) =>
    folderStateContextRules[key]?.(value) ? { [key]: value as string } : {};
  const recorded =
    typeof input.recorded === "string" && isTemplateRevision(input.recorded)
      ? input.recorded
      : undefined;
  return Object.freeze({
    condition: input.condition,
    ...keep("file", input.file),
    ...keep("field", input.field),
    ...keep("area", input.area),
    ...(recorded === undefined ? {} : { recorded }),
    product,
    ...(recorded !== undefined && isOlderTemplateRevision(product, recorded)
      ? { newer: true as const }
      : {}),
  }) as FolderStateRefusal;
}

export function folderStateRefusal(
  error: unknown,
  product: string = instructionTemplateRevision,
): FolderStateRefusal {
  if (!(error instanceof FolderStateUnreadable))
    // An error that is not a refusal says only that the state is invalid.
    return refusalOf({ condition: "invalid" }, product);
  return refusalOf(
    {
      condition: error.condition,
      file: error.file,
      field: error.field,
      area: error.area,
      recorded: error.templateRevision,
    },
    product,
  );
}

const areaWords = (area: FolderOutputArea) =>
  area === "top-level"
    ? "an output at the Folder's top level"
    : area === "other"
      ? "an output elsewhere in the Folder"
      : `an output in ${folderOutputAreaPaths[area]}`;

/** One line for a person: which file, what about it, and which template
 * wrote it when that explains it. */
export function describeFolderStateRefusal(refusal: FolderStateRefusal) {
  const about = [
    refusal.file,
    refusal.field,
    refusal.area === undefined ? undefined : areaWords(refusal.area),
  ]
    .filter(Boolean)
    .join(", ");
  const written =
    refusal.recorded === undefined
      ? ""
      : `; the Folder was rendered by ${refusal.recorded}, this version renders ${refusal.product}${refusal.newer ? ", an older one" : ""}`;
  return `${refusal.condition}${about === "" ? "" : ` (${about})`}${written}`;
}

/** Reads back what `folderStateRefusal` produced in another process,
 * keeping only the values this version itself defines. */
export function parseFolderStateRefusal(
  input: unknown,
): FolderStateRefusal | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !folderStateContextRules.condition?.(value.condition) ||
    typeof value.product !== "string" ||
    !isTemplateRevision(value.product)
  )
    return undefined;
  // The product revision is the other version's, not this one's.
  return refusalOf(
    {
      condition: value.condition as FolderStateUnreadable["condition"],
      file: value.file,
      field: value.field,
      area: value.area,
      recorded: value.recorded,
    },
    value.product,
  );
}
