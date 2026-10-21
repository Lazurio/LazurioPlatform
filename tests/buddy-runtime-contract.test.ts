import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  admitAdapterRequest,
  buddyRuntimeVectors,
  type Checked,
  checkClarifyAnswer,
  checkEmptyBody,
  checkErrorBody,
  checkEventsQuery,
  checkHistoryPage,
  checkHistoryQuery,
  checkMessageAccepted,
  checkMessageRequest,
  checkPageContext,
  checkRuntimeEvent,
  createSseReader,
  formatSseEvent,
  runtimeErrors,
  runtimeEventTypes,
  sameSecret,
} from "../src/buddy/contract/runtime";

// `lazurio.buddy-runtime.v1` (src/buddy/contract/README.md): its vectors are
// its truth, and the Hermes `lazurio_web` adapter runs the same files. This
// runs every case of `vectors/v1/` against the Platform's module.

const directory = join(
  import.meta.dir,
  "..",
  "src",
  "buddy",
  "contract",
  "vectors",
  "v1",
);

type Case = Readonly<{
  name: string;
  check: string;
  input: unknown;
  valid?: boolean;
  why?: string;
  expect?: unknown;
}>;
type VectorFile = Readonly<{
  file: string;
  schema: string;
  contract: string;
  adapter?: Readonly<{ port: number; secret: string }>;
  cases: readonly Case[];
}>;

/** The markers of the README: `$repeat`, `$concat` and `$base64`. */
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== "object") return value;
  const data = value as Record<string, unknown>;
  if (typeof data.$repeat === "string" && typeof data.times === "number")
    return data.$repeat.repeat(data.times);
  if (Array.isArray(data.$concat))
    return data.$concat.map((part) => expand(part) as string).join("");
  if (typeof data.$base64 === "number")
    return Buffer.alloc(data.$base64).toString("base64");
  return Object.fromEntries(
    Object.entries(data).map(([key, member]) => [key, expand(member)]),
  );
}

const files: VectorFile[] = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(directory, file), "utf8")) as Omit<
      VectorFile,
      "file"
    >),
  }));

const validations: Readonly<
  Record<string, (input: unknown) => Checked<unknown>>
> = {
  "page-context": checkPageContext,
  "message-request": checkMessageRequest,
  "message-accepted": checkMessageAccepted,
  "history-query": (input) => checkHistoryQuery(input as string),
  "history-page": checkHistoryPage,
  "events-query": (input) => checkEventsQuery(input as string),
  event: (input) => {
    const { event, data } = input as { event: string; data: unknown };
    return checkRuntimeEvent(event, data);
  },
  "clarify-answer": checkClarifyAnswer,
  "empty-body": checkEmptyBody,
  "error-body": checkErrorBody,
};

test("the vector files: one per contract, each of this schema, names unique", () => {
  expect(files.map((file) => file.file)).toEqual([
    "clarify.json",
    "context.json",
    "errors.json",
    "events.json",
    "history.json",
    "messages.json",
    "transport.json",
  ]);
  for (const file of files) {
    expect(file.schema).toBe(buddyRuntimeVectors);
    expect(`${file.contract}.json`).toBe(file.file);
    const names = file.cases.map((entry) => `${entry.check}: ${entry.name}`);
    expect(new Set(names).size).toBe(names.length);
  }
});

test("every validation has cases it admits and cases it refuses", () => {
  const cases = files.flatMap((file) => file.cases);
  for (const check of Object.keys(validations)) {
    const own = cases.filter((entry) => entry.check === check);
    expect(own.some((entry) => entry.valid === true)).toBe(true);
    expect(own.some((entry) => entry.valid === false)).toBe(true);
  }
  const known = new Set([...Object.keys(validations), "sse", "transport"]);
  expect(cases.filter((entry) => !known.has(entry.check))).toEqual([]);
});

for (const file of files)
  describe(file.file, () => {
    for (const entry of file.cases) {
      if (entry.check === "sse")
        test(`sse: ${entry.name}`, () => {
          const reader = createSseReader();
          const events = (entry.input as string[]).flatMap((piece) =>
            reader.push(piece),
          );
          expect(events).toEqual(entry.expect as never);
        });
      else if (entry.check === "transport")
        test(`transport: ${entry.name}`, () => {
          const adapter = file.adapter;
          if (adapter === undefined) throw new Error("No adapter");
          expect(
            admitAdapterRequest(
              entry.input as Parameters<typeof admitAdapterRequest>[0],
              adapter,
            ),
          ).toEqual(entry.expect as never);
        });
      else
        test(`${entry.check}: ${entry.name}`, () => {
          const check = validations[entry.check];
          if (check === undefined) throw new Error(`Unknown ${entry.check}`);
          const result = check(expand(entry.input));
          expect({ name: entry.name, ok: result.ok }).toEqual({
            name: entry.name,
            ok: entry.valid as boolean,
          });
        });
    }
  });

test("an event written by formatSseEvent reads back, in any pieces", () => {
  const data = {
    message_id: "m-3",
    text: "Dvě\nřádky „uvozovek“ a 😀",
  };
  const wire = formatSseEvent("e-1", "message.delta", data);
  for (let cut = 0; cut <= wire.length; cut++) {
    const reader = createSseReader();
    const events = [
      ...reader.push(wire.slice(0, cut)),
      ...reader.push(wire.slice(cut)),
    ];
    expect(events).toEqual([
      { id: "e-1", event: "message.delta", data: JSON.stringify(data) },
    ]);
    const [event] = events;
    expect(
      checkRuntimeEvent(event?.event ?? "", JSON.parse(event?.data ?? "")).ok,
    ).toBe(true);
  }
  expect(() => formatSseEvent("e 1", "status", { state: "idle" })).toThrow();
});

test("the event types and error codes the README names", () => {
  expect([...runtimeEventTypes]).toEqual([
    "turn.started",
    "message.delta",
    "message.final",
    "progress",
    "status",
    "clarify.request",
    "clarify.retired",
    "error",
  ]);
  expect(runtimeErrors).toEqual({
    "bad-request": 400,
    unauthorized: 401,
    forbidden: 403,
    "not-found": 404,
    "method-not-allowed": 405,
    conflict: 409,
    "cursor-expired": 409,
    "payload-too-large": 413,
    unavailable: 503,
    internal: 500,
  });
});

test("a secret compares equal only to itself, never when empty", () => {
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abd", "abc")).toBe(false);
  expect(sameSecret("ab", "abc")).toBe(false);
  expect(sameSecret("abcd", "abc")).toBe(false);
  expect(sameSecret("", "")).toBe(false);
});
