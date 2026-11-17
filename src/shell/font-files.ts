import type { ShellFontFile } from "./fonts";
import geistLatin from "./vendor/fonts/geist-mono-latin-400-normal.woff2" with {
  type: "file",
};
import geistLatinExt from "./vendor/fonts/geist-mono-latin-ext-400-normal.woff2" with {
  type: "file",
};
import interLatinExt from "./vendor/fonts/inter-latin-ext-wght-normal.woff2" with {
  type: "file",
};
import interLatin from "./vendor/fonts/inter-latin-wght-normal.woff2" with {
  type: "file",
};
import interTightLatinExt from "./vendor/fonts/inter-tight-latin-ext-wght-normal.woff2" with {
  type: "file",
};
import interTightLatin from "./vendor/fonts/inter-tight-latin-wght-normal.woff2" with {
  type: "file",
};

// The server's side of the brand fonts: each vendored file, embedded in the
// compiled executable like the page's own assets, by the name the shell
// requests it under.
export const shellFontPaths: Readonly<Record<ShellFontFile, string>> = {
  "inter-latin-wght-normal.woff2": interLatin,
  "inter-latin-ext-wght-normal.woff2": interLatinExt,
  "inter-tight-latin-wght-normal.woff2": interTightLatin,
  "inter-tight-latin-ext-wght-normal.woff2": interTightLatinExt,
  "geist-mono-latin-400-normal.woff2": geistLatin,
  "geist-mono-latin-ext-400-normal.woff2": geistLatinExt,
};
