import type { MachineBinding, MachineEntry } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import type { Catalog } from "../organizations/catalog";
import type { Shell } from "../shell/contract";
import { bootElementId, bootJson, type LaunchpadBoot } from "./boot";
import { publicEntry } from "./chat";
import { type MessageKey, messages } from "./messages";
import { withOfflineGuide } from "./offline-guide";
import { shellDocument } from "./shell-document";

// The producer of the page's boot document (boot.ts, F36's addendum of
// 2026-10-08) and its place in the page a hosted Launchpad serves after the
// gateway's admission. Everything in it is what the page's first reads
// would answer the same admitted browser, computed from the Folder alone:
// no GitHub, no network, no tool. Never the Machine binding, the gateway's
// auth endpoint or cookie name, the person's account or a tool's output; a
// workstation's page, served without its token, gets none.

/** The boot document of this Environment's page: the shell document as
 * `/.lazurio/shell.json` answers it, without `setup` (null where the
 * producer refuses this Environment, as the route then does), the catalog
 * and the recorded entry's public parts. */
export function launchpadBoot(
  input: Readonly<{
    preset: PresetName;
    machine: MachineBinding | null;
    locale: "cs" | "en";
    catalog: Catalog;
    /** The recorded hosted entry of this Launchpad. */
    entry: MachineEntry | null;
    computer?: string;
    /** The tailnet control server of the handover (decision F41). */
    tailnet: string | null;
  }>,
): LaunchpadBoot {
  let shell: Shell | null = null;
  try {
    shell = withOfflineGuide(
      shellDocument({
        preset: input.preset,
        machine: input.machine,
        locale: input.locale,
        catalog: input.catalog,
        ...(input.computer === undefined ? {} : { computer: input.computer }),
      }),
      input.tailnet,
    );
  } catch {
    // An entry whose address has no base host has no identity
    // (shell-document.ts); the page reads the document and gets nothing.
  }
  return Object.freeze({
    locale: input.locale,
    shell,
    catalog: input.catalog,
    entry: publicEntry(input.entry),
  });
}

/** The page with its boot document at the end of `<head>`, its language on
 * `<html lang>`, and its words (every `data-message` element, the catalog's
 * first status line) in that language from the same messages as the page
 * script's: the first paint is in the Folder's language. */
export function withBoot(page: Response, boot: LaunchpadBoot): Response {
  const copy = messages(boot.locale);
  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute("lang", boot.locale);
      },
    })
    .on("[data-message]", {
      element(element) {
        const key = element.getAttribute("data-message");
        if (key !== null && Object.hasOwn(copy, key))
          element.setInnerContent(copy[key as MessageKey]);
      },
    })
    .on("#catalog-status", {
      element(element) {
        element.setInnerContent(copy.catalogLoading);
      },
    })
    .on("head", {
      element(element) {
        element.append(
          `<script type="application/json" id="${bootElementId}">${bootJson(boot)}</script>`,
          { html: true },
        );
      },
    })
    .transform(page);
}
