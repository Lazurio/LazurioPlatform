import { defineShellElements } from "./elements";

// The entry of `/.lazurio/shell.js` (decision F36): the script an app of the
// Environment loads to get the Lazurio rail and app switch. It defines the
// elements and nothing else; without it the elements stay undefined and the
// app is unchanged. A host that provides the documents itself
// (`<html data-lazurio-shell="host">`, and since F36's addendum of
// 2026-10-05 `<html data-lazurio-account="host">`) parses them with the same
// parsers and hands them over; these four exports are part of interface v1
// (`interface.ts`).
export { parseShell, parseShellAccount } from "./contract";
export { provideAccount, provideShell } from "./elements";

defineShellElements();
