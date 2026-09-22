// Exact-key, data-only field extraction shared by every Folder state parser.
// Accessor and inherited fields are refused without being executed.
export function stateFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid Folder state");
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("Unknown or missing Folder state field");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Executable Folder state field");
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
