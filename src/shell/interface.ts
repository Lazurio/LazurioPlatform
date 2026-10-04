// The interface of the shell's elements that apps outside this repository
// build on: the T3 Code and MausBot forks place the elements in their own
// page, the Dashboard embeds them (decision F36, addendum of 2026-10-04).
// Version 1 is a promise: a Launchpad release may add attributes, events or
// properties and may change everything the elements draw, but it never
// renames or removes anything listed here. A change that would is a new
// version, decided like the contract and announced to the forks first.
export const shellElementInterface = Object.freeze({
  version: 1,
  /** The script an app loads, on its own origin. */
  script: "/.lazurio/shell.js",
  /** Element names and the attributes a host may set on each. */
  elements: Object.freeze({
    "lazurio-rail": Object.freeze(["lang"]),
    "lazurio-column-head": Object.freeze(["active", "lang"]),
    // Reserved for Buddy's bubble (root decision 0180); not defined yet.
    "lazurio-buddy": Object.freeze([] as string[]),
  }),
  /** Values of `active` on `<lazurio-column-head>`. */
  active: Object.freeze(["chat", "apps", "automate"]),
  /** Cancelable, composed events a host may take over. */
  events: Object.freeze(["lazurio-navigate", "lazurio-app"]),
  /** Custom properties: the rail sets the first on the document; a host may
   * set the second to override the detected tone. */
  properties: Object.freeze(["--lazurio-rail-width", "--lazurio-host-tone"]),
});
