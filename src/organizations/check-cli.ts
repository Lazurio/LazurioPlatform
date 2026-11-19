import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { expectedLegacyProjection } from "./legacy-projection";
import { organizationDocumentFiles } from "./read-documents";
import { resolveOrganizationRoot } from "./root-resolution";

/** `lazurio organization check` (LazurioPlatform#1094): the state of an
 * Organization root exactly as every Lazurio reader resolves it, and the
 * one supported way to bring its projection digest in line after an edit.
 *
 * On 2026-11-18 text changes to client roots edited `company.gen3.json` and
 * the same text inside `lazurio.organization.json` without recomputing
 * `compatibility.legacy_projection.sha256`. Every reader then resolved those
 * roots as `conflict` (`canonical_projection_hash_invalid`), the catalog lost
 * their names and the Launchpad sent long-working Environments back to
 * Začínáme. Nothing in Lazurio could tell the agent that made the change.
 * This command can: it uses the reader's own resolution and generator
 * (`resolveOrganizationRoot`, `expectedLegacyProjection`), never a second
 * implementation, so a root it calls fine is one the Launchpad runs.
 *
 * `--write` changes one value only: the declared digest, byte for byte in
 * place, and only where the canonical manifest is otherwise valid and the
 * digest is the one thing wrong. A projection that still does not match
 * (`normalized_semantics_conflict`) stays a conflict for a person to resolve:
 * the digest never papers over diverging documents. */
export const checkHelp = `organization check [<Organization directory>] [--write] [--json]
  The state of an Organization root as Lazurio resolves it for every reader
  (catalog, Launchpad, content install, Composio): transition, current,
  projection_drift (all run), or legacy, missing, conflict (not run), with
  the issues found. Run it in the root after editing lazurio.organization.json,
  company.gen3.json or modules.manifest.json, and in the root's CI. A
  conflict with canonical_projection_hash_invalid means the canonical
  manifest changed but compatibility.legacy_projection.sha256 was not
  recomputed: --write replaces that one value with the digest Lazurio
  computes, nothing else, and checks again. The directory defaults to the
  current one. Exit status: 0 runs, 1 does not run, 2 usage.`;

export class CheckUsageError extends Error {}

export type OrganizationCheckAnswer = Readonly<{
  kind: "organization-check";
  directory: string;
  /** The root's resolved state, or null when no documents were observed. */
  state: string | null;
  executable: boolean;
  issues: readonly string[];
  /** The digest Lazurio computes from the canonical manifest, when it could. */
  expectedDigest?: string;
  /** The digest the canonical manifest declares, when it declares one. */
  declaredDigest?: string;
  /** What `--write` did: rewrote the digest, or why it left the file. */
  write?:
    | "digest-rewritten"
    | "nothing-to-write"
    | "not-only-digest"
    | "digest-not-unique";
}>;

/** The expected and declared digests of a canonical manifest, when both can
 * be read. */
function digests(
  canonical: unknown,
  modules: unknown,
): { expected: string; declared: string } | null {
  try {
    const expected = expectedLegacyProjection(canonical, modules).hash;
    const declared = (
      canonical as { compatibility: { legacy_projection: { sha256: unknown } } }
    ).compatibility.legacy_projection.sha256;
    return typeof declared === "string" ? { expected, declared } : null;
  } catch {
    return null;
  }
}

type Inspection = {
  state: string | null;
  executable: boolean;
  issues: string[];
  expectedDigest?: string;
  declaredDigest?: string;
};

async function inspect(directory: string): Promise<Inspection> {
  const root = await resolveOrganizationRoot(directory);
  if (root.kind !== "root-resolved")
    return { state: null, executable: false, issues: [] };
  const { documents } = root;
  const pair =
    documents.canonical.kind === "present" &&
    documents.modules.kind === "present"
      ? digests(documents.canonical.value, documents.modules.value)
      : null;
  return {
    state: root.state as string,
    executable: root.executable,
    issues: [...root.issues],
    ...(pair === null
      ? {}
      : { expectedDigest: pair.expected, declaredDigest: pair.declared }),
  };
}

/** Replaces the declared digest in the canonical manifest's text: exactly
 * one occurrence of the declared value, written next to it and renamed into
 * place, so the rest of the file keeps its bytes. */
async function rewriteDigest(
  directory: string,
  declared: string,
  expected: string,
): Promise<"digest-rewritten" | "digest-not-unique"> {
  const path = join(directory, organizationDocumentFiles.canonical);
  const text = await readFile(path, "utf8");
  const quoted = JSON.stringify(declared);
  const first = text.indexOf(quoted);
  if (first === -1 || text.indexOf(quoted, first + quoted.length) !== -1)
    return "digest-not-unique";
  const next =
    text.slice(0, first) +
    JSON.stringify(expected) +
    text.slice(first + quoted.length);
  const temporary = `${path}.lazurio-check-${process.pid}`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, path);
  return "digest-rewritten";
}

export async function runOrganizationCheck(
  directory: string,
  write: boolean,
): Promise<OrganizationCheckAnswer> {
  let found = await inspect(directory);
  let outcome: OrganizationCheckAnswer["write"];
  if (write) {
    const onlyDigest =
      found.state === "conflict" &&
      found.issues.length === 1 &&
      found.issues[0] === "canonical_projection_hash_invalid" &&
      found.expectedDigest !== undefined &&
      found.declaredDigest !== undefined;
    if (
      found.issues.includes("canonical_projection_hash_invalid") &&
      !onlyDigest
    )
      outcome = "not-only-digest";
    else if (!onlyDigest) outcome = "nothing-to-write";
    else {
      outcome = await rewriteDigest(
        directory,
        found.declaredDigest as string,
        found.expectedDigest as string,
      );
      if (outcome === "digest-rewritten") found = await inspect(directory);
    }
  }
  return Object.freeze({
    kind: "organization-check" as const,
    directory,
    ...found,
    issues: Object.freeze(found.issues),
    ...(outcome === undefined ? {} : { write: outcome }),
  });
}

const writeSentence: Record<
  NonNullable<OrganizationCheckAnswer["write"]>,
  string
> = {
  "digest-rewritten":
    "compatibility.legacy_projection.sha256 rewritten to the digest Lazurio computes.",
  "nothing-to-write": "The digest is right; nothing was written.",
  "not-only-digest":
    "Not written: the digest is not the only problem. Resolve the other issues first.",
  "digest-not-unique":
    "Not written: the declared digest does not occur exactly once in lazurio.organization.json.",
};

export function checkText(answer: OrganizationCheckAnswer): string {
  const lines = [
    answer.state === null
      ? `${answer.directory}: no Organization documents could be read here.`
      : `${answer.directory}: ${answer.state}${answer.executable ? " (runs)" : " (does not run)"}`,
  ];
  for (const issue of answer.issues) lines.push(`  issue: ${issue}`);
  if (
    answer.issues.includes("canonical_projection_hash_invalid") &&
    answer.write === undefined
  )
    lines.push(
      "  The canonical manifest changed without its projection digest. Run: lazurio organization check --write",
    );
  if (answer.write !== undefined)
    lines.push(`  ${writeSentence[answer.write]}`);
  return lines.join("\n");
}

export async function runOrganizationCheckCommand(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<{ code: number; text: string }> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: args.slice(2) as string[],
      strict: true,
      allowPositionals: true,
      options: {
        write: { type: "boolean" },
        json: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new CheckUsageError((error as Error).message);
  }
  if (parsed.positionals.length > 1)
    throw new CheckUsageError(
      "Usage: organization check [<Organization directory>] [--write] [--json]",
    );
  const given = parsed.positionals[0];
  const directory =
    given === undefined ? cwd : isAbsolute(given) ? given : resolve(cwd, given);
  const answer = await runOrganizationCheck(
    directory,
    parsed.values.write === true,
  );
  return {
    code: answer.executable ? 0 : 1,
    text:
      parsed.values.json === true ? JSON.stringify(answer) : checkText(answer),
  };
}
