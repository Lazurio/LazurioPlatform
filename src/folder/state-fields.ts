/** Why a state document could not be read, as an enumerated condition. */
export const folderStateConditions = [
  "absent",
  "unsafe",
  "unreadable",
  "not-json",
  "not-an-object",
  "unknown-field",
  "missing-field",
  "accessor-field",
  "unknown-output",
  "missing-output",
  "unsupported-schema",
  "invalid",
] as const;
export type FolderStateCondition = (typeof folderStateConditions)[number];

/** Where an output this version does not render lies: a fixed area, never
 * the recorded path, which is content of the Folder (#787 review). */
export const folderOutputAreas = [
  "agents-skills",
  "claude-skills",
  "manual",
  "top-level",
  "other",
] as const;
export type FolderOutputArea = (typeof folderOutputAreas)[number];

/** Where in the Folder each named area is, for a person. */
export const folderOutputAreaPaths: Readonly<
  Record<Exclude<FolderOutputArea, "top-level" | "other">, string>
> = Object.freeze({
  "agents-skills": ".agents/skills/",
  "claude-skills": ".claude/skills/",
  manual: "manual/",
});

export function folderOutputArea(key: unknown): FolderOutputArea {
  if (typeof key !== "string") return "other";
  for (const [area, path] of Object.entries(folderOutputAreaPaths))
    if (key.startsWith(path)) return area as FolderOutputArea;
  return key.includes("/") ? "other" : "top-level";
}

/** A state document this version cannot read, with what a person needs to
 * see why: the condition, the document, and the field or output it is about
 * when that is one of the product's own names. A key read from the Folder
 * (an unknown field or output) is never carried: its name is Folder content
 * and could be anything. An unknown output carries only its fixed area. */
export class FolderStateUnreadable extends Error {
  readonly condition: FolderStateCondition;
  readonly file: string | undefined;
  /** One of the expected keys the parser was given, never a recorded one. */
  readonly field: string | undefined;
  readonly area: FolderOutputArea | undefined;
  /** The manifest's recorded template revision, unvalidated. */
  readonly templateRevision: unknown;
  constructor(
    condition: FolderStateCondition,
    details: Readonly<{
      file?: string | undefined;
      field?: string | undefined;
      area?: FolderOutputArea | undefined;
      templateRevision?: unknown;
    }> = {},
  ) {
    // The same words as the file reader's refusal of an unsafe file.
    super(
      condition === "unsafe"
        ? "Unsafe Folder state file"
        : `Unreadable Folder state: ${condition}`,
    );
    this.name = "FolderStateUnreadable";
    this.condition = condition;
    this.file = details.file;
    this.field = details.field;
    this.area = details.area;
    this.templateRevision = details.templateRevision;
  }
  /** The same condition, now knowing more about where it is. */
  with(
    details: Readonly<{
      condition?: FolderStateCondition;
      file?: string;
      area?: FolderOutputArea;
      templateRevision?: unknown;
    }>,
  ): FolderStateUnreadable {
    return new FolderStateUnreadable(details.condition ?? this.condition, {
      file: this.file ?? details.file,
      field: this.field,
      area: this.area ?? details.area,
      templateRevision: this.templateRevision ?? details.templateRevision,
    });
  }
}

// Exact-key, data-only field extraction shared by every Folder state parser.
// Accessor and inherited fields are refused without being executed.
export function stateFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new FolderStateUnreadable("not-an-object");
  const ownKeys = Reflect.ownKeys(input);
  const unknown = ownKeys.find(
    (key) => typeof key !== "string" || !keys.includes(key),
  );
  // Its name is the Folder's content, not the product's: never carried.
  if (unknown !== undefined) throw new FolderStateUnreadable("unknown-field");
  const missing = keys.find((key) => !ownKeys.includes(key));
  if (missing !== undefined)
    throw new FolderStateUnreadable("missing-field", { field: missing });
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor))
      throw new FolderStateUnreadable("accessor-field", { field: key });
    result[key] = descriptor.value;
  }
  return result;
}

// The own data value of one key, or undefined; never executes an accessor.
export function ownDataValue(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
