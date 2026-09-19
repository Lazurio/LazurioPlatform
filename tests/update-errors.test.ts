import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  exitUpdateAvailable,
  exitUpToDate,
  updateErrors,
} from "../src/update/errors";

/** `src/update/errors.ts` is the ONE place where error codes and their exit
 * statuses live. The update work is developed on several stacked branches, and
 * two of them once claimed the same number: a merge resolves text, not
 * meaning. The runtime object cannot show a duplicated NAME — the later
 * property silently wins — so the table is also read as source text.
 */
test("the error table has no duplicate code name and no duplicate, reserved or retired exit status", async () => {
  const source = await readFile(
    join(import.meta.dir, "../src/update/errors.ts"),
    "utf8",
  );
  const table = source.slice(
    source.indexOf("export const updateErrors = {"),
    source.indexOf("} as const satisfies"),
  );
  const entries = [
    ...table.matchAll(
      /^\s*(?:"([a-z-]+)"|([a-z]+)):\s*\{\s*exit:\s*(\d+),\s*retryable:\s*(?:true|false)\s*\}/gm,
    ),
  ].map((match) => ({
    name: (match[1] ?? match[2]) as string,
    exit: Number(match[3]),
  }));
  // Every entry of the source was recognized: nothing escapes this test by
  // being written differently.
  expect(entries.length).toBe(Object.keys(updateErrors).length);
  expect(table.match(/exit:/g)?.length).toBe(entries.length);

  const duplicates = <T>(values: readonly T[]) =>
    values.filter((value, index) => values.indexOf(value) !== index);
  expect(duplicates(entries.map((entry) => entry.name))).toEqual([]);
  expect(duplicates(entries.map((entry) => entry.exit))).toEqual([]);
  const runtime: Record<string, { exit: number }> = updateErrors;
  for (const { name, exit } of entries) expect(runtime[name]?.exit).toBe(exit);

  // Statuses with another meaning, and numbers of codes that were removed:
  // a retired number is never given to a new code.
  const retired = [23, 26, 31];
  for (const comment of retired) expect(table).toContain(`${comment} was`);
  const forbidden = [0, 1, exitUpToDate, exitUpdateAvailable, ...retired];
  expect(entries.filter((entry) => forbidden.includes(entry.exit))).toEqual([]);
  expect(entries.every((entry) => entry.exit >= 2 && entry.exit <= 125)).toBe(
    true,
  );
});
