import { vendorText } from "./vendor-text" with { type: "macro" };

/** The design system's `tokens.css`, vendored byte for byte
 * (src/shell/vendor/README.md): applied to `:host` inside every element
 * (base-styles.ts) and read for the tokens the shell declares on the app's
 * document (tokens.ts). In a module of its own, used by neither here, so the
 * bundled script carries the text once. */
export const designTokens = vendorText("tokens.css");
