import type { Catalog } from "../organizations/catalog";
import { parseShell, type Shell } from "../shell/contract";
import { parseCatalog } from "./catalog-view";
import type { PublicEntry } from "./chat";
import { parseEntryAnswer } from "./chat-view";

// The boot document of the Launchpad page (F36's addendum of 2026-10-08):
// what the page would otherwise read with its first requests, carried in the
// page itself, so that its first paint is already the final page. Only a
// hosted Launchpad writes one, into the page it serves after the gateway's
// admission (boot-document.ts): there the request that brings the page is
// already admitted, while a workstation's page is served without the token
// its reads need. `<script type="application/json" id="lazurio-boot">`
// holds `{schema, locale, shell, catalog, entry}`: the Folder's language,
// the `lazurio.shell.v1` document of `/.lazurio/shell.json` without `setup`
// (which waits for GitHub), the catalog of `POST /api/catalog` and the
// recorded entry's public parts of `GET /api/entry`. Every member is checked
// by the same parser as the answer it stands for; one that does not parse is
// read by the page as before.

export const bootSchema = "lazurio.launchpad-boot.v1";

/** The id of the element that carries the document. */
export const bootElementId = "lazurio-boot";

export type LaunchpadBoot = Readonly<{
  locale: "cs" | "en";
  /** Null where the Launchpad has no shell document to give: the page then
   * reads `/.lazurio/shell.json` itself, which fails the same way. */
  shell: Shell | null;
  catalog: Catalog | null;
  entry: PublicEntry | null;
}>;

/** The document as the text of its `<script type="application/json">`:
 * JSON in which every `<` is escaped, so no `</script>` or `<!--` in a
 * value ends or opens anything, and so are the line and paragraph
 * separators. `JSON.parse` reads it back unchanged. */
export function bootJson(boot: LaunchpadBoot): string {
  return JSON.stringify({ schema: bootSchema, ...boot })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The page's boot document, or null when there is none or it is not one:
 * not JSON, another schema, another language. A member its parser refuses
 * is null. */
export function parseBoot(
  text: string | null | undefined,
): LaunchpadBoot | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const input = value as Record<string, unknown>;
  if (
    input.schema !== bootSchema ||
    (input.locale !== "cs" && input.locale !== "en")
  )
    return null;
  return Object.freeze({
    locale: input.locale,
    shell: input.shell == null ? null : parseShell(input.shell),
    catalog: input.catalog == null ? null : parseCatalog(input.catalog),
    entry:
      input.entry == null
        ? null
        : parseEntryAnswer({ kind: "entry", entry: input.entry }),
  });
}
