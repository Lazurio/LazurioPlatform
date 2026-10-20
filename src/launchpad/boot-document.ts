import type { MachineBinding, MachineEntry } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import type { Catalog } from "../organizations/catalog";
import {
  currentEnvironment,
  type Shell,
  type ShellTheme,
} from "../shell/contract";
import { environmentTheme, environmentThemeCss } from "../shell/theme";
import { type VaultHost, vaultAnswer } from "../vault/flow";
import { bootElementId, bootJson, type LaunchpadBoot } from "./boot";
import { publicEntry } from "./chat";
import { type MessageKey, messages } from "./messages";
import { withOfflineGuide } from "./offline-guide";
import { shellDocument } from "./shell-document";
import { appsTheme } from "./theme-view";
import { vaultListed } from "./vault-page-view";

// The producer of the page's boot document (boot.ts, F36's addendum of
// 2026-10-08) and its place in the page a hosted Launchpad serves after the
// gateway's admission. Everything in it is what the page's first reads
// would answer the same admitted browser, computed from the Folder alone
// (and, for Trezor in the Apps column, from the vault's local facts): no
// GitHub, no network, no tool. Never the Machine binding, the gateway's
// auth endpoint or cookie name, the person's account or a tool's output; a
// workstation's page, served without its token, gets none.

/** Whether the Apps column lists Trezor in this Environment (root decision
 * 0185's addendum of 2026-10-18; F53's addendum of 2026-10-18 (3)): the
 * vault core's answer as `lazurio vault status` resolves it (`vaultAnswer`),
 * on the rule `vaultListed`. Only local files: neither bw nor the vault is
 * asked. Listed where it cannot be read at all, so that a fault never hides
 * the page that says it; but on a public Environment (`isPublic`), where
 * Trezor is only where the core answers its own vault (plan DEV-6668 slice
 * 6), not listed, and the server then answers its page and API as absent. */
export async function vaultInAppsOf(
  host: VaultHost,
  isPublic = false,
): Promise<boolean> {
  try {
    return vaultListed(await vaultAnswer(host), isPublic);
  } catch {
    return !isPublic;
  }
}

/** The boot document of this Environment's page: the shell document as
 * `/.lazurio/shell.json` answers it, without `setup` (null where the
 * producer refuses this Environment, as the route then does), the catalog,
 * the recorded entry's public parts and whether the Apps column lists
 * Trezor (`vaultInAppsOf`; not said where it was not read). */
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
    /** The owning Organization's own slug the handover names, when it does
     * (shell-document.ts). */
    ownerKey?: string | null;
    /** The Environment's theme (root decision 0208), as the shell document
     * carries it. */
    theme?: ShellTheme;
    /** Whether the Apps column lists Trezor (`vaultInAppsOf`). */
    vaultInApps?: boolean | undefined;
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
        ownerKey: input.ownerKey ?? null,
        ...(input.theme === undefined ? {} : { theme: input.theme }),
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
    vaultInApps: input.vaultInApps ?? null,
  });
}

/** The page with its boot document at the end of `<head>`, its language on
 * `<html lang>`, and its words (every `data-message` element, the catalog's
 * first status line) in that language from the same messages as the page
 * script's: the first paint is in the Folder's language and names this
 * Environment's kind as the script does (decision F28's addendum of
 * 2026-10-18). With the shell document's theme (root decision 0208), also
 * the Environment's theme as Apps shows it (`appsTheme`, light only): its
 * values in `<style data-lazurio-environment-theme>` at the end of `<head>`,
 * after the page's own tokens (the bundler links them there), and its mark
 * on `<html>`, as the shell would declare them, so the first paint already
 * wears it. The style's text is the shell's own (`environmentThemeCss`), of
 * validated `#rrggbb` values only.
 * Where the Environment has no vault, Trezor's item in the Apps column is
 * hidden in it, as the page's script keeps it from the same member (F53's
 * addendum of 2026-10-18 (3)). */
export function withBoot(page: Response, boot: LaunchpadBoot): Response {
  const copy = messages(
    boot.locale,
    boot.shell === null ? null : (currentEnvironment(boot.shell)?.kind ?? null),
  );
  const theme =
    boot.shell?.theme === undefined ? null : appsTheme(boot.shell.theme);
  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute("lang", boot.locale);
        if (theme !== null)
          element.setAttribute(environmentTheme.attribute, theme.id);
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
    .on("#vault-nav", {
      element(element) {
        if (boot.vaultInApps === false) element.setAttribute("hidden", "");
      },
    })
    .on("head", {
      element(element) {
        if (theme !== null)
          element.append(
            `<style ${environmentTheme.attribute}>\n${environmentThemeCss(theme)}</style>`,
            { html: true },
          );
        element.append(
          `<script type="application/json" id="${bootElementId}">${bootJson(boot)}</script>`,
          { html: true },
        );
      },
    })
    .transform(page);
}
