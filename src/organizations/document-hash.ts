import { createHash } from "node:crypto";

// Existing sha256-canonical-json-v1 wire behavior: recursively sort object keys,
// preserve array order, then use JSON.stringify (including its numeric-key order).
// This is NOT RFC 8785, a signature, schema validation or an access grant.
export function organizationDocumentHash(input: unknown): string {
  const ancestors = new Set<object>();
  const snapshot = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value))
      throw new Error("JSON document data required");
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== null &&
      prototype !== Object.prototype &&
      prototype !== Array.prototype
    )
      throw new Error("JSON document data required");
    ancestors.add(value);
    try {
      const fields = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string"))
        throw new Error("JSON document data required");
      if (Array.isArray(value)) {
        if (keys.length !== value.length + 1)
          throw new Error("Dense JSON array required");
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const field = fields[String(index)];
          if (!field || !("value" in field) || !field.enumerable)
            throw new Error("JSON array data required");
          result.push(snapshot(field.value));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of (keys as string[]).sort()) {
        const field = fields[key];
        if (!field || !("value" in field) || !field.enumerable)
          throw new Error("JSON object data required");
        result[key] = snapshot(field.value);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot(input)))
    .digest("hex")}`;
}
