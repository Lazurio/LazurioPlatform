import { readFileSync } from "node:fs";
import { join } from "node:path";

// The text of a vendored brand file, inlined where the shell is bundled: a
// macro (imported with `{ type: "macro" }`), because a browser bundle turns
// an imported stylesheet into a stylesheet of the page, never into text, and
// the elements need the text inside their shadow roots.
export function vendorText(file: "tokens.css" | "symbol-color.svg"): string {
  return readFileSync(join(import.meta.dir, "vendor", "lazurio", file), "utf8");
}
