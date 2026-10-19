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
// version.
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
    // Reserved for Buddy's bubble (root decision 0180); not defined yet.
    "lazurio-buddy": Object.freeze([] as string[]),
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
   * `{kind: "page" | "tab", tab, view}` or `{kind: "tool", id}`). */
  events: Object.freeze(["lazurio-navigate", "lazurio-app", "lazurio-new-tab"]),
  /** Attributes a host sets on its document (`<html>`) and their values:
   * `host` says the page provides that document itself (`provideShell`,
   * `provideAccount`) and the elements read nothing of it. */
  document: Object.freeze({
    "data-lazurio-shell": Object.freeze(["host"]),
    "data-lazurio-account": Object.freeze(["host"]),
  }),
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
  }),
  /** What the script exports to a host. */
  exports: Object.freeze([
    "provideShell",
    "provideAccount",
    "parseShell",
    "parseShellAccount",
    "parseShellSignedOut",
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
