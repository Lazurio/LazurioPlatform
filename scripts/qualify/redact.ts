/** What the qualification prints into a PUBLIC job log passes through here
 * first (scripts/qualify/journeys.ts): a unit's status and journal carry the
 * Launchpad's startup line, whose local session URL holds a bearer token in
 * its fragment, and any other secret-shaped value is treated the same way.
 * Redaction happens before truncation, and the raw text is never printed.
 */
export const redacted = "<redacted>";

const secretKey =
  "[\\w.-]*(?:token|credential|secret|authorization|cookie)[\\w.-]*";

const rules: readonly [RegExp, string][] = [
  // (a) Any URL fragment: `…://host/path#fragment`.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>#]*)#[^\s"'<>]*/gi, `$1#${redacted}`],
  // (b) JSON members: "token": "…", "sessionToken": 1, "Set-Cookie": "…".
  [
    new RegExp(
      `("${secretKey}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\]\\s]+)`,
      "gi",
    ),
    `$1"${redacted}"`,
  ],
  // (b) Query parameters: ?token=…, &access_token=….
  [new RegExp(`([?&;]${secretKey}=)[^&\\s#"'<>]*`, "gi"), `$1${redacted}`],
  // (b) Header- or assignment-like fields to the end of the line:
  //     Set-Cookie: …, Authorization: Bearer …, SECRET_TOKEN=….
  [
    new RegExp(`\\b(${secretKey})(\\s*[:=]\\s*)(?!"?${redacted})[^\\n]*`, "gi"),
    `$1$2${redacted}`,
  ],
  [/\b(Bearer|Basic)\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+/g, `$1 ${redacted}`],
];

export function redact(text: string): string {
  return rules.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

/** The log lines of one output: redacted, then the last `lines` lines, each
 * at most 300 characters. */
export function logLines(text: string, lines = 30): string[] {
  return redact(text)
    .trim()
    .split("\n")
    .slice(-lines)
    .filter((line) => line !== "")
    .map((line) => line.slice(0, 300));
}

/** Stream a child's output into the log line by line, each line redacted
 * before it is written; a last line without a newline is flushed at the end.
 * For long-running commands whose output must appear as it happens. */
export async function streamRedacted(
  stream: ReadableStream<Uint8Array>,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) write(redact(line));
  }
  pending += decoder.decode();
  if (pending !== "") write(redact(pending));
}
