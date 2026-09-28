import { productOrigin } from "../update/identity";
import { type RecoveryEvidence, readableJson } from "./evidence";
import type { LeakKind, Sanitizer } from "./sanitize";

/** The GitHub issue a repair agent files for every entry into recovery
 * (docs/recovery-mode.md E.3-E.5). `lazurio recover` prepares it and files
 * nothing: filing is the agent's act under the standing mandate for issues
 * (root decision 0163), after a duplicate search. The body is English: the
 * repository is public. */
export const issueRepository = productOrigin.repository;

/** The bound of a tier-1 body (docs/recovery.md "Two tiers"). The body has
 * no free text to drop, so nothing is trimmed to meet it: a test holds the
 * largest body the evidence can produce under it, and a body above it (a bug)
 * is still prepared whole for `gh`, with a link that carries the title only. */
export const maxBodyBytes = 6 * 1024;
/** Longer links are cut by browsers and GitHub; the link then carries the
 * title only and the body is pasted. */
export const maxLinkLength = 8_000;

export type PreparedIssue = Readonly<{
  kind: "prepared";
  repository: string;
  title: string;
  body: string;
  /** Search before filing: `--state all`, so a closed match is found as a
   * regression. */
  search: readonly string[];
  /** Create with the body on standard input. */
  create: readonly string[];
  /** The same command as one shell text, with the body as a here-document. */
  shell: string;
  /** For a browser without gh; `bodyInLink` false when it carries only the
   * title. */
  link: string;
  bodyInLink: boolean;
}>;

export type RefusedIssue = Readonly<{
  kind: "refused";
  repository: string;
  /** What survived sanitization, by kind only. */
  found: readonly LeakKind[];
}>;

export const issueTitle = (evidence: RecoveryEvidence) =>
  `Recovery: ${evidence.check} (${evidence.code}) on ${evidence.product.running.target} [${evidence.fingerprint}]`;

// A fence longer than any run of backticks in its content.
function fenced(language: string, content: string): string {
  const longest = Math.max(
    2,
    ...[...content.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}

/** Tier 1 only (docs/recovery.md "Two tiers"): the structured fields of the
 * evidence. The journal tail and any other free text never enter the body;
 * they stay on the Machine and reach the issue only as a comment the repair
 * agent attaches after reading them. */
function bodyText(evidence: RecoveryEvidence) {
  const { journal: _, ...fields } = evidence;
  const running = evidence.product.running;
  return [
    `\`lazurio recover\` found the check \`${evidence.check}\`${
      evidence.rule === null ? "" : ` (${evidence.rule})`
    } failing with the code \`${evidence.code}\` on a Machine.`,
    "",
    `- Fingerprint: \`${evidence.fingerprint}\``,
    `- Detected: ${evidence.detectedAt}`,
    `- Product: ${running.version} (${running.target})`,
    `- Failed checks: ${evidence.failed.map((id) => `\`${id}\``).join(", ")}`,
    "",
    "Prepared by Lazurio and sanitized on the Machine. It carries structured fields only; the journal and other free text stayed on the Machine. A state the product could not handle is a missing test: this issue closes with a regression test.",
    "",
    `### Evidence (${evidence.schema})`,
    "",
    fenced("json", readableJson(fields)),
    "",
  ].join("\n");
}

/** The body, passed through `finish` (the sanitizer). */
export const issueBody = (
  evidence: RecoveryEvidence,
  finish: (text: string) => string = (text) => text,
): string => finish(bodyText(evidence));

/** One word for a POSIX shell. */
export const shellWord = (word: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;

function hereDocument(body: string): string {
  const lines = new Set(body.split("\n"));
  let marker = "LAZURIO_RECOVERY_BODY";
  for (let n = 1; lines.has(marker); n++) marker = `LAZURIO_RECOVERY_BODY_${n}`;
  return `<<'${marker}'\n${body.endsWith("\n") ? body : `${body}\n`}${marker}`;
}

/** Sanitize the whole body once more and pass the gate; only a clean body
 * becomes an issue to prepare. */
export function prepareIssue(
  evidence: RecoveryEvidence,
  sanitizer: Sanitizer,
): PreparedIssue | RefusedIssue {
  const title = sanitizer.sanitize(issueTitle(evidence));
  const body = issueBody(evidence, sanitizer.sanitize);
  const verdict = sanitizer.gate(`${title}\n${body}`);
  if (verdict.kind === "refused")
    return Object.freeze({
      kind: "refused",
      repository: issueRepository,
      found: verdict.found,
    });
  const search = Object.freeze([
    "gh",
    "issue",
    "list",
    "--repo",
    issueRepository,
    "--state",
    "all",
    "--search",
    `"${evidence.fingerprint}" in:title`,
  ]);
  const create = Object.freeze([
    "gh",
    "issue",
    "create",
    "--repo",
    issueRepository,
    "--title",
    title,
    "--body-file",
    "-",
  ]);
  const newIssue = `https://github.com/${issueRepository}/issues/new`;
  const withBody = `${newIssue}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  const bodyInLink =
    Buffer.byteLength(body) <= maxBodyBytes && withBody.length <= maxLinkLength;
  return Object.freeze({
    kind: "prepared",
    repository: issueRepository,
    title,
    body,
    search,
    create,
    shell: `${create.map(shellWord).join(" ")} ${hereDocument(body)}`,
    link: bodyInLink
      ? withBody
      : `${newIssue}?title=${encodeURIComponent(title)}`,
    bodyInLink,
  });
}

export const searchText = (issue: PreparedIssue) =>
  issue.search.map(shellWord).join(" ");
