import { vendorText } from "../shell/vendor-text" with { type: "macro" };

/** The design system's dark scheme Grafit, `tokens-dark.css`, vendored byte
 * for byte (src/shell/vendor/README.md): one `[data-scheme="dark"]` rule over
 * the names of `tokens.css`. Read only for the dark values of the theme
 * Lazurio (palettes.ts); never put into a document, where the theme's own
 * style gives the dark values of the promised names. */
export const designTokensDark = vendorText("tokens-dark.css");
