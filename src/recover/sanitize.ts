import { credentialShapes, longRun, plainText } from "../tools/redact";

/** The sanitizer of the recovery evidence (proposed decision F21,
 * docs/recovery.md "What may leave the Machine"): what a public issue in the
 * product repository may carry of this Machine's text.
 *
 * It lives beside `src/tools/redact.ts`, not in it, and reuses its credential
 * shapes and plain-text rule. The two answer different questions: redact.ts
 * decides what of a tool's output a person on this Machine may see when an
 * installation fails, and withholds every long run because a leaked token
 * costs a revocation. A public issue needs more (known identifiers of the
 * Machine replaced, addresses and hostnames replaced) and one thing less: the
 * commits and digests the product prints must survive, or most of a useful
 * journal is withheld. Loosening redact.ts for that would loosen the tools
 * screen too.
 *
 * Three steps, in this order, so that each works on what the previous left:
 * 1. every known private value is replaced by a stable placeholder;
 * 2. a line with a credential shape, or with a long run that is not a
 *    tolerated digest, is withheld whole;
 * 3. patterns replace what no list can know: IP addresses, e-mail addresses,
 *    `*.lazurio.io` hostnames other than the product's, other accounts' home
 *    directories.
 * Then the gate: the final text is refused, naming only the KIND of what
 * survived, when any known private value or pattern is still in it.
 */

/** Known private values of this Machine, in the priority in which one value
 * found under two kinds is named. */
export const privateKinds = [
  "folder",
  "install-base",
  "home",
  "user",
  "host",
  "organization",
  "repository",
  "machine",
  "team",
  "github-login",
  "github-id",
  "tailnet-node",
  "machine-host",
  "peer",
  "hostname",
] as const;
export type PrivateKind = (typeof privateKinds)[number];
export type PrivateValue = Readonly<{ kind: PrivateKind; value: string }>;

/** What the patterns and the line rule find without a list. */
export const patternKinds = [
  "credential",
  "key-material",
  "ip-address",
  "email",
  "lazurio-hostname",
  "account-path",
  "control-character",
] as const;
export type PatternKind = (typeof patternKinds)[number];
export type LeakKind = PrivateKind | PatternKind;

/** Bounds of a journal tail in the evidence (docs/recovery-mode.md E.2 4). */
export const journalLimits = Object.freeze({
  lines: 80,
  bytes: 8 * 1024,
  /** One line longer than this is cut after sanitization. */
  lineCharacters: 500,
});

export const withheldLine = "[line withheld]";

// Placeholders of the kinds that name one thing, and the short name of the
// numbered ones: `<org-1>`, `<repo-2>`, …
const single: Partial<Record<PrivateKind, string>> = {
  folder: "<folder>",
  "install-base": "<base>",
  home: "~",
  user: "<user>",
  host: "<host>",
};
const numbered: Record<PrivateKind, string> = {
  folder: "folder",
  "install-base": "base",
  home: "home",
  user: "user",
  host: "host",
  organization: "org",
  repository: "repo",
  machine: "machine",
  team: "team",
  "github-login": "login",
  "github-id": "github-id",
  "tailnet-node": "node",
  "machine-host": "machine-host",
  peer: "peer",
  hostname: "hostname",
};
const patternPlaceholders = [
  "<ip>",
  "<email>",
  "<lazurio-host>",
  "<account>",
] as const;

// Too short to identify anything, or the same on every Machine.
const minimumLength = 2;
const generic = new Set(["localhost", "localhost.localdomain"]);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A value is found as a whole word of a name: not inside a longer name.
const bounded = (alternatives: string) =>
  new RegExp(`(?<![A-Za-z0-9])(?:${alternatives})(?![A-Za-z0-9])`, "gi");

type Entry = Readonly<{
  kind: PrivateKind;
  value: string;
  placeholder: string;
}>;

function entries(values: readonly PrivateValue[]): readonly Entry[] {
  const seen = new Set<string>();
  const counters = new Map<PrivateKind, number>();
  const result: Entry[] = [];
  const ordered = [...values].sort(
    (a, b) => privateKinds.indexOf(a.kind) - privateKinds.indexOf(b.kind),
  );
  for (const { kind, value: raw } of ordered) {
    let value = raw.trim();
    // A path is the same path with or without its trailing slash.
    if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
    const key = value.toLowerCase();
    if (
      value.length < minimumLength ||
      /[\r\n\0]/.test(value) ||
      generic.has(key) ||
      seen.has(key)
    )
      continue;
    seen.add(key);
    const count = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, count);
    result.push({
      kind,
      value,
      placeholder: single[kind] ?? `<${numbered[kind]}-${count}>`,
    });
  }
  return Object.freeze(result);
}

// A 40- or 64-character lowercase hex run is a commit or a SHA-256 digest.
const digestShape = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// What the product prints right before a digest it means: `sha256:<hex>`,
// `commit <hex>`, `"commit": "<hex>"`. A Launchpad session URL
// (`http://127.0.0.1:<port>/#<64 hex>`) carries no such label and is withheld.
const digestLabel =
  /(?:\bsha256[:= ]|\bdigest[:= ]|\bcommit[:= ]|"(?:commit|sha256|digest|sourceCommit)"\s*:\s*")\s*$/i;
const allRuns = new RegExp(longRun.source, "g");
// The same runs without `/`: a path is split at its separators, a hex or
// base64url token is not, whatever a replacement did inside it.
const runsWithoutSlash = /[A-Za-z0-9+_=-]{32,}/g;

function untoleratedRun(
  line: string,
  pattern: RegExp,
  publicDigests: ReadonlySet<string>,
): boolean {
  for (const match of line.matchAll(pattern)) {
    const run = match[0];
    if (
      !digestShape.test(run) ||
      !(
        publicDigests.has(run) ||
        digestLabel.test(line.slice(0, match.index ?? 0))
      )
    )
      return true;
  }
  return false;
}

const credential = (line: string) =>
  credentialShapes.some((shape) => shape.test(line));

// `*.lazurio.io`: kept only when every label left of the product domain is a
// placeholder or `launchpad`, the one generic label of a hosted entry.
const lazurioHost =
  /(?<![A-Za-z0-9.<>-])((?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?|<[a-z0-9-]+>)\.)+)lazurio\.io(?![A-Za-z0-9-])/gi;
const genericLabel = /^(?:launchpad|<[a-z0-9-]+>)$/;
// Placeholders count as parts of an address, so one whose domain a value
// replaced is still found.
const addressPart = "(?:[A-Za-z0-9-]+|<[a-z0-9-]+>)";
const email = new RegExp(
  `(?:[A-Za-z0-9._%+-]|<[a-z0-9-]+>)+@${addressPart}(?:\\.${addressPart})*\\.(?:[A-Za-z]{2,}|<[a-z0-9-]+>)`,
  "g",
);
const genericEmail = new Set(["git@github.com"]);
const ipv4 =
  /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.[0-9])/g;
// A word with a colon in it. An IPv6 address is searched inside it at its
// colons, because a key often touches it: `addr:fd7a::1`, `{Addr:fd7a::1 …}`,
// `tailscale0:fd7a:…`.
const colonWord = /(?<![0-9A-Za-z:])[0-9A-Za-z:]*:[0-9A-Za-z:]*/g;
// `ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`
const ipv6MaximumLength = 39;
const accountPath = /(\/(?:home|Users)\/)(?!<)([^/\s"'`<>:]+)/g;

function isIpv4(parts: readonly string[]): boolean {
  return parts.every((part) => Number(part) <= 255);
}
function isLoopbackIpv4(parts: readonly string[]): boolean {
  return parts[0] === "127" || parts.every((part) => Number(part) === 0);
}
function isIpv6(candidate: string): boolean {
  const compressed = candidate.split("::").length - 1;
  if (compressed > 1) return false;
  const groups = candidate.split(":");
  const named = groups.filter((group) => group !== "");
  if (!named.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return false;
  if (compressed === 1)
    return (
      named.length <= 7 &&
      // Only the one `::` may leave empty groups.
      !/(^:[^:])|([^:]:$)/.test(candidate)
    );
  return groups.length === 8;
}
const loopbackIpv6 = new Set(["::1", "::"]);

/** Every IPv6 address in a colon word, the leftmost and longest first, each
 * starting at the word's start or after a colon and ending at its end or
 * before a colon. */
function replaceIpv6(word: string, found: Set<PatternKind>): string {
  let result = "";
  let start = 0;
  let copied = 0;
  while (start < word.length) {
    let end = Math.min(word.length, start + ipv6MaximumLength);
    let address: string | undefined;
    for (; end > start; end--) {
      if (end < word.length && word[end] !== ":") continue;
      const candidate = word.slice(start, end);
      if (isIpv6(candidate)) {
        address = candidate;
        break;
      }
    }
    if (address !== undefined) {
      if (!loopbackIpv6.has(address)) {
        found.add("ip-address");
        result += `${word.slice(copied, start)}<ip>`;
        copied = end;
      }
      start = end;
    }
    const colon = word.indexOf(":", start);
    if (colon < 0) break;
    start = colon + 1;
  }
  return result + word.slice(copied);
}

/** Replace what the patterns find; the replaced kinds are reported.
 *
 * Addresses and e-mail addresses are replaced BEFORE the known values: a
 * value that is also a label or a number (an Organization called `example`,
 * a GitHub id `77`) would otherwise break the pattern and leave the rest of
 * the address behind. A `*.lazurio.io` hostname is judged label by label:
 * `launchpad` and a known value (or, after the substitution, its
 * placeholder) are kept, so the hosted entry stays recognizable as
 * `launchpad.<machine-1>.<org-1>.lazurio.io`; any other label replaces the
 * whole host. Other accounts' homes are replaced after the known home. */
function replaceAddresses(line: string, found: Set<PatternKind>): string {
  return line
    .replace(email, (address) => {
      if (genericEmail.has(address.toLowerCase())) return address;
      found.add("email");
      return "<email>";
    })
    .replace(ipv4, (address, ...parts: string[]) => {
      const octets = parts.slice(0, 4);
      if (!isIpv4(octets) || isLoopbackIpv4(octets)) return address;
      found.add("ip-address");
      return "<ip>";
    })
    .replace(colonWord, (word) => replaceIpv6(word, found));
}

function replaceHosts(
  line: string,
  found: Set<PatternKind>,
  keptLabel: (label: string) => boolean,
): string {
  return line.replace(lazurioHost, (host, labels: string) => {
    const kept = labels
      .slice(0, -1)
      .split(".")
      .every((label) => keptLabel(label.toLowerCase()));
    if (kept) return host;
    found.add("lazurio-hostname");
    return "<lazurio-host>";
  });
}

function replaceAccounts(line: string, found: Set<PatternKind>): string {
  return line.replace(accountPath, (_path, prefix: string) => {
    found.add("account-path");
    return `${prefix}<account>`;
  });
}

/** Everything the patterns replace after the known values. */
const replaceLate = (line: string, found: Set<PatternKind>) =>
  replaceAccounts(
    replaceHosts(replaceAddresses(line, found), found, (label) =>
      genericLabel.test(label),
    ),
    found,
  );

export type GateResult =
  | Readonly<{ kind: "clean"; text: string }>
  /** What survived, by kind only: the value itself is never repeated. */
  | Readonly<{ kind: "refused"; found: readonly LeakKind[] }>;

export type Sanitizer = Readonly<{
  /** Every line sanitized; a withheld line becomes `[line withheld]`. */
  sanitize(text: string): string;
  /** The bounded, sanitized tail of a journal or another output. */
  journalTail(output: string): string;
  /** The final check of text that would leave the Machine. */
  gate(text: string): GateResult;
}>;

export function createSanitizer(
  input: Readonly<{
    values: readonly PrivateValue[];
    /** Commits and digests the product itself printed and may keep. */
    publicDigests?: readonly string[] | undefined;
  }>,
): Sanitizer {
  const known = entries(input.values);
  const publicDigests: ReadonlySet<string> = new Set(
    (input.publicDigests ?? []).filter((digest) => digestShape.test(digest)),
  );
  const byValue = new Map(
    known.map((entry) => [entry.value.toLowerCase(), entry]),
  );
  // One pass, longest first: a placeholder is never scanned again, and the
  // longest known value wins where two overlap (the Folder before the home).
  const matcher =
    known.length === 0
      ? null
      : bounded(
          [...known]
            .sort((a, b) => b.value.length - a.value.length)
            .map((entry) => escapeRegExp(entry.value))
            .join("|"),
        );
  const substitute = (line: string) =>
    matcher === null
      ? line
      : line.replace(
          matcher,
          (value) => byValue.get(value.toLowerCase())?.placeholder ?? value,
        );

  const knownLabel = (label: string) =>
    genericLabel.test(label) || byValue.has(label);
  const sanitizeLine = (raw: string): string => {
    if (credential(raw)) return withheldLine;
    const addressed = replaceHosts(
      replaceAddresses(raw, new Set()),
      new Set(),
      knownLabel,
    );
    const line = substitute(addressed);
    if (
      credential(line) ||
      untoleratedRun(line, allRuns, publicDigests) ||
      untoleratedRun(addressed, runsWithoutSlash, publicDigests)
    )
      return withheldLine;
    return replaceLate(line, new Set());
  };

  const sanitize = (text: string) =>
    plainText(text).split("\n").map(sanitizeLine).join("\n");

  const journalTail = (output: string) => {
    const lines = plainText(output)
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-journalLimits.lines)
      .map(sanitizeLine)
      .map((line) =>
        line.length <= journalLimits.lineCharacters
          ? line
          : `${line.slice(0, journalLimits.lineCharacters)}…`,
      );
    while (
      lines.length > 0 &&
      Buffer.byteLength(lines.join("\n")) > journalLimits.bytes
    )
      lines.shift();
    return lines.join("\n");
  };

  // Placeholders this sanitizer writes; they are removed before the gate looks
  // for values, so a value that is also part of a placeholder's name (a user
  // called `user`) is not found in `<user>`.
  const placeholders = [
    ...new Set([
      ...known.map((entry) => entry.placeholder),
      ...patternPlaceholders,
      withheldLine,
    ]),
  ].sort((a, b) => b.length - a.length);

  const gate = (text: string): GateResult => {
    const found = new Set<LeakKind>();
    let rest = text;
    for (const placeholder of placeholders)
      rest = rest.replaceAll(placeholder, " ");
    if (matcher !== null)
      for (const match of rest.matchAll(matcher)) {
        const entry = byValue.get(match[0].toLowerCase());
        if (entry) found.add(entry.kind);
      }
    for (const line of text.split("\n")) {
      if (line === withheldLine) continue;
      if (credential(line)) found.add("credential");
      if (
        untoleratedRun(line, allRuns, publicDigests) ||
        untoleratedRun(line, runsWithoutSlash, publicDigests)
      )
        found.add("key-material");
    }
    const patterns = new Set<PatternKind>();
    replaceLate(text, patterns);
    for (const kind of patterns) found.add(kind);
    // Anything plainText would remove is not plain text.
    if (plainText(text) !== text) found.add("control-character");
    if (found.size === 0) return Object.freeze({ kind: "clean", text });
    return Object.freeze({
      kind: "refused",
      found: Object.freeze(
        [...privateKinds, ...patternKinds].filter((kind) => found.has(kind)),
      ),
    });
  };

  return Object.freeze({ sanitize, journalTail, gate });
}
