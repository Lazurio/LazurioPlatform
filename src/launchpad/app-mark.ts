import type { CatalogIcon } from "../integrations/catalog-schema";
import { monogram } from "./integrations-view";

/**
 * The mark of an app or a tool: its bundled logo in a white square, else its
 * first letter. One drawing for Integrace and Settings → Tools, so the same
 * app looks the same on both pages.
 */
export function appMark(
  name: string,
  icon: CatalogIcon | undefined,
): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "integration-mark";
  holder.setAttribute("aria-hidden", "true");
  if (icon === undefined) {
    holder.classList.add("integration-mark-letter");
    holder.textContent = monogram(name);
    return holder;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", icon.path);
  path.setAttribute("fill", `#${icon.hex}`);
  svg.append(path);
  holder.append(svg);
  return holder;
}
