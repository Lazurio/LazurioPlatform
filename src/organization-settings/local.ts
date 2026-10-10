import { dirname, join } from "node:path";
import { readFolderCatalog } from "../organizations/catalog";
import { selectCatalogOrganization } from "../organizations/catalog-selection";
import { organizationSettings } from "../organizations/organization-settings";
import { parseUniqueJson } from "../providers/unique-json";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { isCommitId } from "./contract";
import { canonicalSettings } from "./governance";
import type { SourceRead } from "./poller";

// Root decision 0194 point 3: an installation with the Organization's
// repository cloned reads the same document from Git. Decision F45: on an
// Organization's Environment without the relay, the Launchpad reads the
// settings of the Organization its handover names from that Organization's
// root in the Folder (`organizations/<directory>`, the one the catalog
// selects by the Organization's slug), at the commit of its `main`, with the
// operator's own git: the version and the settings belong together, as in
// the Dashboard's answer, and an uncommitted edit is not a setting. It is as
// fresh as the checkout; nothing here fetches.

/** One read-only git command in a directory; its output, or null. */
export type GitReader = (
  directory: string,
  args: readonly string[],
) => Promise<string | null>;

/** The operator's git from the operator's PATH, never above the root:
 * `GIT_CEILING_DIRECTORIES` keeps it from finding another repository around
 * a root that is not a checkout. */
export function operatorGit(tools: ToolsEnvironment): GitReader {
  let located: Promise<string | undefined> | undefined;
  return async (directory, args) => {
    located ??= resolveOnPath("git", tools.path, tools.platform);
    const git = await located;
    if (git === undefined) return null;
    try {
      const result = await tools.run([git, "-C", directory, ...args], 10_000, {
        ...(tools.path === undefined ? {} : { PATH: tools.path }),
        ...(tools.home === undefined ? {} : { HOME: tools.home }),
        GIT_CEILING_DIRECTORIES: dirname(directory),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      });
      return result !== "timeout" && result.exitCode === 0
        ? result.stdout
        : null;
    } catch {
      return null;
    }
  };
}

const failed = (detail: string): SourceRead => ({
  kind: "failed",
  error: "repository_unavailable",
  detail,
});

/** The settings of `organization` (its slug, as the handover names it) in
 * the Folder's root of it, at the commit of its `main`. */
export async function readRepositorySettings(
  folder: string,
  organization: string,
  git: GitReader,
): Promise<SourceRead> {
  let directory: string;
  try {
    const selection = selectCatalogOrganization(
      await readFolderCatalog(folder),
      organization,
    );
    if (selection.kind !== "found") return failed("organization-absent");
    directory = join(folder, "organizations", selection.organization.directory);
  } catch {
    return failed("catalog-unavailable");
  }
  const head = (
    await git(directory, [
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/main^{commit}",
    ])
  )?.trim();
  if (head === undefined || !isCommitId(head))
    return failed("commit-unavailable");
  const listed = await git(directory, [
    "ls-tree",
    "--name-only",
    head,
    "--",
    "lazurio.organization.json",
  ]);
  if (listed === null) return failed("commit-unavailable");
  // A root without the canonical manifest at that commit governs nothing,
  // as the Dashboard answers for it.
  if (listed.trim() === "")
    return {
      kind: "settings",
      settings: {
        organization: null,
        version: head,
        values: {},
        unsupported: [],
      },
    };
  const text = await git(directory, [
    "show",
    `${head}:lazurio.organization.json`,
  ]);
  if (text === null) return failed("manifest-unreadable");
  let manifest: unknown;
  try {
    manifest = parseUniqueJson(text);
  } catch {
    return { kind: "invalid", version: head };
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  )
    return { kind: "invalid", version: head };
  const verdict = organizationSettings(
    manifest as Readonly<Record<string, unknown>>,
  );
  if (verdict.status === "invalid") return { kind: "invalid", version: head };
  return {
    kind: "settings",
    settings: {
      organization: null,
      version: head,
      values: canonicalSettings(verdict.values),
      unsupported: [],
    },
  };
}
