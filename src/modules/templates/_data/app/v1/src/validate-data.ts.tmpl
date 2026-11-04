// The validation of this Module's data, part of `bun run check`: every
// document of the directories given is a record of a collection of
// src/domain/collections.ts and matches its schema.
//
//   bun run validate:data   the records this repository carries (seed/)
//   bun run validate:db     the records of db/ before a publication; db/ is a
//                           repository of its own that CI does not check out
//
// A directory is laid out like db/data/: one subdirectory per collection, one
// document <id>.yaml each, with the envelope of repository-db
// (schemaVersion, id, record). Every other entry is a problem, a name with a
// leading dot too (`.hidden.yaml` is the record `.hidden`); only the empty
// placeholder `.gitkeep` that keeps an empty directory in Git is left out.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type CollectionSpec, collections } from "./domain/collections";

export type DataCheck = Readonly<{ documents: number; problems: readonly string[] }>;

/** The placeholder that keeps an empty directory in Git; no record. */
const placeholder = ".gitkeep";

export function validateDataDirectory(
  root: string,
  specs: Readonly<Record<string, CollectionSpec>> = collections,
): DataCheck {
  if (!existsSync(root))
    return { documents: 0, problems: [`${root}: the directory does not exist`] };
  const problems: string[] = [];
  let documents = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === placeholder && entry.isFile()) continue;
    const directory = join(root, entry.name);
    if (!entry.isDirectory()) {
      problems.push(`${directory}: not a collection directory`);
      continue;
    }
    const spec = specs[entry.name];
    if (spec === undefined) {
      problems.push(`${directory}: the collection has no schema in src/domain/collections.ts`);
      continue;
    }
    for (const file of readdirSync(directory)) {
      if (file === placeholder) continue;
      const path = join(directory, file);
      documents += 1;
      if (!file.endsWith(".yaml")) {
        problems.push(`${path}: not a document <id>.yaml`);
        continue;
      }
      problems.push(...validateDocument(path, decodeURIComponent(file.slice(0, -5)), spec));
    }
  }
  return { documents, problems };
}

function validateDocument(path: string, id: string, spec: CollectionSpec): string[] {
  let document: unknown;
  try {
    document = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [`${path}: not YAML (${error instanceof Error ? error.message : String(error)})`];
  }
  if (document === null || typeof document !== "object" || Array.isArray(document))
    return [`${path}: the document is not a mapping`];
  const envelope = document as Record<string, unknown>;
  const problems: string[] = [];
  if (envelope.schemaVersion !== spec.schemaVersion)
    problems.push(
      `${path}: schemaVersion is ${JSON.stringify(envelope.schemaVersion)}, expected ${JSON.stringify(spec.schemaVersion)}`,
    );
  if (envelope.id !== id)
    problems.push(
      `${path}: id is ${JSON.stringify(envelope.id)}, the file name says ${JSON.stringify(id)}`,
    );
  const record = spec.record.safeParse(envelope.record);
  if (!record.success) problems.push(`${path}: ${z.prettifyError(record.error)}`);
  return problems;
}

if (import.meta.main) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("Usage: bun run src/validate-data.ts <data directory>...");
    process.exit(2);
  }
  const checks = roots.map((root) => validateDataDirectory(root));
  const problems = checks.flatMap((check) => check.problems);
  for (const problem of problems) console.error(problem);
  const documents = checks.reduce((sum, check) => sum + check.documents, 0);
  if (problems.length > 0) process.exit(1);
  console.log(`Data valid: ${documents} document(s) in ${roots.join(", ")}.`);
}
