// Internal development contract, not a persisted preferences schema or support matrix.
// Execution OS is supplied by the machine adapter, never inferred from remote clients.
const choices = {
  os: ["windows", "macos", "linux"],
  access: ["local", "remote"],
  purpose: ["human", "buddy", "ai_colleague"],
  locale: ["cs", "en"],
  detail: ["concise", "technical"],
  coordination: ["direct", "coordinator"],
} as const;

export type FolderProfile = Readonly<{
  [K in keyof typeof choices]: (typeof choices)[K][number];
}>;

export function parseFolderProfile(input: unknown): FolderProfile {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid Folder profile");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(choices) as (keyof typeof choices)[];
  if (
    Reflect.ownKeys(record).some(
      (key) =>
        typeof key !== "string" || !keys.includes(key as keyof typeof choices),
    )
  )
    throw new Error("Unknown Folder profile field");
  const result: Record<string, string> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error(`Missing or accessor profile field: ${key}`);
    const value: unknown = descriptor.value;
    if (
      typeof value !== "string" ||
      !(choices[key] as readonly string[]).includes(value)
    )
      throw new Error(`Invalid profile field: ${key}`);
    result[key] = value;
  }
  return Object.freeze(result) as FolderProfile;
}
