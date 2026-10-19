// The interface of the shell's elements that apps outside this repository
// build on: the T3 Code and MausBot forks place the elements in their own
// page, the Dashboard embeds them (decision F36, addendum of 2026-10-04).
// Version 1 is a promise: a Launchpad release may add attributes, values,
// events, document attributes, exports or properties and may change
// everything the elements draw, but it never renames or removes anything
// listed here. A change that would is a new version, decided like the
// contract and announced to the forks first. F36's addendum of 2026-10-05
// added, in version 1, what a host page that is no Environment's (the
// Dashboard) needs: the attributes the elements already read, the document
// attributes of a host that provides the documents, and the exports that
// hand them over. F36's addendum of 2026-10-06 added, in version 1, the
// export `parseShellSignedOut`: a host page with nobody signed in hands its
// signed-out document to the same `provideShell`, which accepts it besides
// `lazurio.shell.v1`. Decision F47 (2026-10-11) added, in version 1,
// `<lazurio-new-tab>` with its attributes and its event `lazurio-new-tab`.
// F39's addendum of 2026-10-12 added, in version 1, `<lazurio-environment>`
// with its attributes `environment`, `lang` and `space`. F36's addendum of
// 2026-10-13 (root decision 0200) added, in version 1, what the script
// declares in the app's document (`declares`): the brand fonts' faces, which
// it declared from the start, and the design system's tokens on the root
// with the mark `data-lazurio-theme="light"`, onto which the T3 Code fork maps
// its own tokens. Of the tokens, only the names `declares.tokens` lists are
// promised; adding one is an addition, removing or renaming one a new
// version. F36's addendum of 2026-10-18 (root decision 0208) added, in
// version 1, the Environment theme: what the script declares for it
// (`declares.environmentTheme`: its marks on `<html>`, the custom property
// `--lazurio-color-scheme`, declared with the tokens as `light` and by a
// theme's dark values as `dark`, and the class `dark` a host shows dark
// with), the host's attribute `data-lazurio-appearance` and the event
// `lazurio-theme`. The values a theme gives the promised names are never
// promised, only the names. Decision F56 (2026-10-18) added, in version 1,
// the guide: `<lazurio-buddy>` with its attribute `lang`, the attributes a
// host sets on elements of its page (`marks`: `data-guide`, the element a
// step points at, and `data-guide-help`, the "?" that plays the explanation
// it names), the event `lazurio-guide` and the export `provideGuides`.
// Without explanations handed over and without Buddy's origin the element
// draws nothing and listens to nothing. The ids, the marks and the texts of
// the shell's own explanations are not promised; the message protocol
// between Buddy's frame and the host is versioned on its own
// (guide-protocol.ts).
export const shellElementInterface = Object.freeze({
  version: 1,
  /** The script an app loads, on its own origin. */
  script: "/.lazurio/shell.js",
  /** Element names and the attributes a host may set on each. */
  elements: Object.freeze({
    "lazurio-rail": Object.freeze(["lang", "app", "space"]),
    "lazurio-column-head": Object.freeze([
      "active",
      "lang",
      "settings",
      "space",
    ]),
    // Where the guide draws (decision F56; the bubble of root decision 0180
    // comes later): the language of the guide.
    "lazurio-buddy": Object.freeze(["lang"]),
    // Nová karta (decision F47 point 2): the strip the tab is for, the app's
    // tools as JSON (`[{id, label, key?, icon?}]`), whether the address bar
    // takes the keys, and the language.
    "lazurio-new-tab": Object.freeze([
      "strip",
      "tools",
      "focus-address",
      "lang",
    ]),
    // One Environment named as the shell names it (F39's addendum of
    // 2026-10-12): its id (absent: the page's own) and the language.
    "lazurio-environment": Object.freeze(["environment", "lang", "space"]),
  }),
  /** Values of `active` on `<lazurio-column-head>`: the app the head sits
   * in, or `settings` inside the Settings its gear opens. */
  active: Object.freeze(["chat", "apps", "automate", "settings"]),
  /** Composed events: the first two are cancelable and a host may take them
   * over; `lazurio-new-tab` says what Nová karta became (`detail`:
   * `{kind: "page" | "tab", tab, view}` or `{kind: "tool", id}`).
   * `lazurio-theme`, on the document, follows every change of the
   * Environment theme the script declared (`detail`: `{id, revision, dark}`
   * of the theme now declared, or null for none). `lazurio-guide`, on
   * `<lazurio-buddy>`, says an explanation started, was done or was closed
   * (`detail`: `{type: "started" | "done" | "closed", explainer}`). */
  events: Object.freeze([
    "lazurio-navigate",
    "lazurio-app",
    "lazurio-new-tab",
    "lazurio-theme",
    "lazurio-guide",
  ]),
  /** Attributes a host sets on its document (`<html>`) and their values:
   * `host` says the page provides that document itself (`provideShell`,
   * `provideAccount`) and the elements read nothing of it;
   * `data-lazurio-appearance` says how the host shows an Environment
   * theme's dark values, besides the class `dark`: `device` with the
   * device's `prefers-color-scheme`, `dark` always, `light` never, as
   * without it. */
  document: Object.freeze({
    "data-lazurio-shell": Object.freeze(["host"]),
    "data-lazurio-account": Object.freeze(["host"]),
    "data-lazurio-appearance": Object.freeze(["device", "light", "dark"]),
  }),
  /** Attributes a host sets on elements of its page for the guide (decision
   * F56): `data-guide` names an element a step of an explanation points at;
   * `data-guide-help`, on the "?" beside a page's heading, names the
   * explanation its click plays. Their values are the host's (or the
   * principles' ids of the shell), never promised. */
  marks: Object.freeze(["data-guide", "data-guide-help"]),
  /** What the script declares in the document it is loaded into, once, and
   * not at all where the document has it already (F36's addendum of
   * 2026-10-13): the faces of the font families `fonts`, served at
   * `/.lazurio/fonts/` (the families `--lz-font-sans` and `--lz-font-mono`
   * name first); on the root, the vendored `tokens.css`, of which only the
   * custom properties `tokens` are promised, never their values (the design
   * system may change or drop any other `--lz-*` name); and, where those
   * hold, the attribute of `theme` on `<html>` with its value. The names
   * are those T3 Code's mapping needs: surfaces and ink, the accent and the
   * black buttons, the grey steps it uses, the signal colours with the
   * surfaces it shows, the type and the controls' radius. */
  declares: Object.freeze({
    fonts: Object.freeze(["Inter Tight Variable", "Geist Mono"]),
    tokens: Object.freeze([
      "--lz-surface",
      "--lz-paper",
      "--lz-ink",
      "--lz-ink-muted",
      "--lz-line",
      "--lz-accent",
      "--lz-accent-button",
      "--lz-accent-button-hover",
      "--lz-on-accent",
      "--lz-gray-50",
      "--lz-gray-100",
      "--lz-red-500",
      "--lz-danger",
      "--lz-danger-bg",
      "--lz-warning",
      "--lz-warning-bg",
      "--lz-green-500",
      "--lz-success",
      "--lz-info",
      "--lz-info-bg",
      "--lz-font-sans",
      "--lz-font-mono",
      "--lz-radius-sm",
    ]),
    theme: Object.freeze({ "data-lazurio-theme": Object.freeze(["light"]) }),
    /** The Environment theme (F36's addendum of 2026-10-18, root decision
     * 0208): the values of `lazurio.shell.v1`'s `theme` for the promised
     * colour names, light on the root, dark where the host shows dark
     * (`darkClass` on `<html>`, or `data-lazurio-appearance` of `document`);
     * where they hold, `marks` on `<html>`: the theme's id, and
     * `data-lazurio-theme-dark` (empty) where it has dark values. Of
     * `properties`, `--lazurio-color-scheme` is declared with the tokens as
     * `light` from the start and `dark` by dark values. */
    environmentTheme: Object.freeze({
      marks: Object.freeze([
        "data-lazurio-environment-theme",
        "data-lazurio-theme-dark",
      ]),
      properties: Object.freeze(["--lazurio-color-scheme"]),
      darkClass: "dark",
    }),
  }),
  /** What the script exports to a host. */
  exports: Object.freeze([
    "provideShell",
    "provideAccount",
    "parseShell",
    "parseShellAccount",
    "parseShellSignedOut",
    "provideGuides",
  ]),
  /** Custom properties: the rail sets the first on the document; a host may
   * set the second to override the detected tone. The rest are the colour
   * roles (F36, addendum of 2026-10-04, evening): a host fills them from its
   * own theme on its document (`:root`), each one optional; an unset role
   * keeps the design system's colour, and a set one wins over the tone. */
  properties: Object.freeze([
    "--lazurio-rail-width",
    "--lazurio-host-tone",
    "--lazurio-surface",
    "--lazurio-ink",
    "--lazurio-ink-muted",
    "--lazurio-line",
    "--lazurio-line-strong",
    "--lazurio-hover",
    "--lazurio-selected",
    "--lazurio-control",
    "--lazurio-raised",
    "--lazurio-overlay",
    "--lazurio-overlay-ink",
    "--lazurio-focus",
  ]),
});
