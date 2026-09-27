// What of a tool's own output may be shown when a curated installation fails
// (decision F19): a bounded tail of plain text, and no line that looks as if
// it carried a credential, a login key or a pairing code. The check is
// deliberately broad: a withheld harmless line costs nothing, a leaked token
// costs a revocation.
const tokenLike: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:uak|ak|sk|pk|ck)_[A-Za-z0-9_-]{8,}/,
  /\b(?:bearer|token|secret|password|passwd|api[_-]?key|authorization|cookie|clikey|session)\b/i,
  /[?&][A-Za-z_]*(?:key|token|code|secret|session)[A-Za-z_]*=/i,
  // Long runs of key material: base64, base64url or hex.
  /[A-Za-z0-9+/_=-]{32,}/,
  // A one-time code shape (ABCD-1234).
  /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
];

const tailLines = 12;
const tailCharacters = 1200;

/** Terminal escapes, control and text-direction characters removed. */
export function plainText(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the rule
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
        "",
      )
  );
}

export function looksSecret(line: string): boolean {
  return tokenLike.some((pattern) => pattern.test(line));
}

/** The last lines of an output, plain, bounded, each line that could carry a
 * secret replaced by a marker. */
export function safeTail(output: string): string {
  const lines = plainText(output)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-tailLines)
    .map((line) => (looksSecret(line) ? "[line withheld]" : line));
  const text = lines.join("\n");
  return text.length <= tailCharacters ? text : text.slice(-tailCharacters);
}
