import { defineShellElements } from "./elements";

// The entry of `/.lazurio/shell.js` (decision F36): the script an app of the
// Environment loads to get the Lazurio rail and app switch. It defines the
// elements and nothing else; without it the elements stay undefined and the
// app is unchanged.
export { parseShell } from "./contract";
export { provideShell } from "./elements";

defineShellElements();
