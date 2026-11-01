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

/** A state document this version cannot read, with what a person needs to
 * see why: the condition, the document and the one field or output it is
 * about. `field` is the key as recorded, kept only when it has the shape of
 * a Folder-relative name, so it never quotes arbitrary content. */
export class FolderStateUnreadable extends Error {
  readonly condition: FolderStateCondition;
  readonly file: string | undefined;
  readonly field: string | undefined;
  /** The manifest's recorded template revision, unvalidated. */
  readonly templateRevision: unknown;
  constructor(
    condition: FolderStateCondition,
    details: Readonly<{
      file?: string | undefined;
      field?: unknown;
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
    this.field = printableStateKey(details.field);
    this.templateRevision = details.templateRevision;
  }
  /** The same condition, now knowing more about where it is. */
  with(
    details: Readonly<{
      condition?: FolderStateCondition;
      file?: string;
      templateRevision?: unknown;
    }>,
  ): FolderStateUnreadable {
    return new FolderStateUnreadable(details.condition ?? this.condition, {
      file: this.file ?? details.file,
      field: this.field,
      templateRevision: this.templateRevision ?? details.templateRevision,
    });
  }
}

/** A recorded key that may be shown: letters, digits and `._/-`, relative,
 * without `..`, at most 128 characters. Anything else is not shown. */
export function printableStateKey(key: unknown): string | undefined {
  return typeof key === "string" &&
    /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,127}$/.test(key) &&
    !key.split("/").includes("..")
    ? key
    : undefined;
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
  if (unknown !== undefined)
    throw new FolderStateUnreadable("unknown-field", { field: unknown });
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
