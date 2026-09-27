// The operator's note for agents about one catalog tool (decision F18,
// addendum 2026-09-27): plain text the operator writes when they installed a
// tool with an intent ("use it for the ClickUp and Gmail of Spectoda"), which
// the generated manual quotes for agents. Pure and dependency-free, so the
// Launchpad page checks a note with exactly the rules the Folder state does.

export const toolNoteLimits = Object.freeze({ characters: 600, lines: 6 });

export type ToolNoteProblem =
  | "empty"
  | "not-normalized"
  | "too-long"
  | "too-many-lines"
  | "control";

// Control characters other than the line feed (C0, DEL, C1), the Unicode line
// and paragraph separators, the byte-order mark and the bidirectional
// embedding, override and isolate controls: nothing that could reorder,
// hide or break a line of the rendered note.
const forbidden =
  // Every control character except the newline, every format character
  // (zero-width and direction marks, embeddings, overrides, isolates, the
  // byte-order mark, soft hyphen, tags) and the line and paragraph separators.
  /[^\P{Cc}\n]|\p{Cf}|\p{Zl}|\p{Zp}/u;

// The one stored form of a note typed by a person: line endings as LF and the
// whole text trimmed. Surfaces normalize input with this before they send it;
// the Folder state accepts only the normalized form.
export function normalizeToolNote(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

// Why a note in its stored form is not acceptable, or null when it is. The
// length counts Unicode code points.
export function toolNoteProblem(note: string): ToolNoteProblem | null {
  if (forbidden.test(note)) return "control";
  if (note.length === 0) return "empty";
  if (note !== normalizeToolNote(note)) return "not-normalized";
  if (Array.from(note).length > toolNoteLimits.characters) return "too-long";
  if (note.split("\n").length > toolNoteLimits.lines) return "too-many-lines";
  return null;
}

// One note as Markdown blockquote lines, each prefixed with `> ` (an empty
// line is `>`), so the note stays one quoted block of the generated file:
// - HTML angle brackets become `&lt;` and `&gt;`: no tag, comment or
//   generated-file marker (`<!-- … -->`) can be forged, and no line starts a
//   nested quote; an `&` that already starts an entity becomes `&amp;`;
// - a line whose first character after up to three spaces would start a
//   heading (`#`), a code fence (``` or ~~~) or a setext heading underline
//   (a line of only `=` or `-`), or is a backslash, gets a backslash before
//   that character, so it stays literal text.
// Together with the refused control characters, a note can never end the
// block, forge a heading, an instruction section or a marker. The quoting is
// injective: two different notes never render the same bytes, so a changed
// note is always a changed Folder.
export function quoteToolNote(note: string): string[] {
  return note.split("\n").map((raw) => {
    const line = raw
      .replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/^( {0,3})(\\|#|```|~~~|[=-](?=[ =-]*$))/, "$1\\$2");
    return line.length === 0 ? ">" : `> ${line}`;
  });
}
