// Disposable feasibility consumer: no filesystem, provider, identity or permissions.
export const purposes = ["human", "buddy", "ai_colleague"] as const;
export const details = ["concise", "technical"] as const;
export const coordination = ["direct", "coordinator"] as const;
type Purpose = (typeof purposes)[number];
type Detail = (typeof details)[number];
type Coordination = (typeof coordination)[number];
export type Profile = Readonly<{
  purpose: Purpose;
  detail: Detail;
  coordination: Coordination;
}>;
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new Error(`Invalid ${field}`);
  return value as T;
}
export function parseProfile(input: unknown): Profile {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid profile");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["purpose", "detail", "coordination"].includes(key),
    )
  )
    throw new Error("Unknown profile field");
  return Object.freeze({
    purpose: choice(record.purpose, purposes, "purpose"),
    detail: choice(record.detail, details, "detail"),
    coordination: choice(record.coordination, coordination, "coordination"),
  });
}
export function preview(input: unknown) {
  const profile = parseProfile(input);
  return {
    kind: "platform-proof" as const,
    profile,
    instructions: [
      "# Generated profile preview — no activation",
      `Purpose: ${profile.purpose}`,
      `Explanation detail: ${profile.detail}`,
      profile.coordination === "coordinator"
        ? "Understand the task, delegate only through available capabilities, monitor, verify and finish."
        : "Perform the task directly within available capabilities.",
      "Profile preferences grant no access or publication authority.",
      "Buddy acts for a human principal; an AI colleague has its own seat.",
      "",
    ].join("\n"),
  };
}
