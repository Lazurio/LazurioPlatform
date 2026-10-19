// The name of an Environment's Composio organization (decision F42, addendum
// of 2026-10-13, note of 2026-10-17): the rule compares names by their
// letters and digits, and the person creates the organization under the form
// of the Organization's name that Composio accepts. Composio's create screen
// (the Organization Admin's screenshot of 2026-10-17) says "Must start with a
// letter. Only letters, numbers, and underscores allowed.", so "Lazurio
// Example Organization" cannot be created there; "LazurioExampleOrganization"
// can, and it matches the Organization. Composio stores the name in lower
// case: its create form says "Will be created as lazurioexampleorganization"
// (the end-to-end test of 2026-10-19), and its dashboard, its address and
// `orgs list` name it so. The dialog still offers the readable CamelCase
// form, which Composio accepts and lowercases; the rule ignores case, so
// both match. Pure, for the server's rule and the page's dialog alike
// (`composio-organization.ts` reads the Folder and cannot be part of the
// page).

/** A name as the rule compares it: without diacritics, in lower case, and
 * only its letters and digits, the ones Composio allows in a name; spaces,
 * punctuation and underscores do not count. So every name Composio allows
 * for an Organization matches it: "Human and Machine", "HumanAndMachine",
 * "human_and_machine" and "humanandmachine" are one name, `humanandmachine`.
 * A letter outside the English alphabet without a base letter (ł, ß) is
 * left out, as Composio has no way to write it. */
export function organizationKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

/** The name the person creates in Composio for an Organization of
 * `displayName`: its words without diacritics, each with only its letters
 * and digits, joined with the first letter of each in capitals and its other
 * capitals kept ("Lazurio Example Organization" is
 * "LazurioExampleOrganization", "Rozjedeme.ai" is "RozjedemeAi"); "Org"
 * before a name that would not start with a letter, as Composio asks ("3M
 * Česko" is "Org3MCesko"). Null where nothing of the name is left. */
export function composioOrganizationName(displayName: string): string | null {
  const name = displayName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .map((word) => word.replace(/[^A-Za-z0-9]/gu, ""))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  if (name === "") return null;
  return /^[A-Za-z]/u.test(name) ? name : `Org${name}`;
}

/** The keys an organization for an Organization of `displayName` may have in
 * Composio: its name's own and, where its Composio name had to start with
 * "Org", that one's too ("3M Česko" is `3mcesko` and `org3mcesko`). */
export function organizationKeys(displayName: string): readonly string[] {
  const own = organizationKey(displayName);
  const composio = organizationKey(composioOrganizationName(displayName) ?? "");
  return [own, composio].filter(
    (key, index, keys) => key !== "" && keys.indexOf(key) === index,
  );
}
