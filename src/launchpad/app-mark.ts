import type { CatalogIcon } from "../integrations/catalog-schema";
import type { MarkSvg } from "../tools/icons";
import { monogram } from "./integrations-view";

/**
 * The mark of an app or a tool: its bundled logo in a white square, else its
 * first letter. One drawing for Integrace and Settings → Tools, so the same
 * app looks the same on both pages. A logo is a simple-icons path in its
 * colour, or a vendor's own bundled SVG (Composio).
 */
export function appMark(
  name: string,
  icon: CatalogIcon | MarkSvg | undefined,
): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "integration-mark";
  holder.setAttribute("aria-hidden", "true");
  if (icon === undefined) {
    holder.classList.add("integration-mark-letter");
    holder.textContent = monogram(name);
    return holder;
  }
  if ("svg" in icon) {
    // A bundled constant, parsed as an SVG document, never as HTML.
    const parsed = new DOMParser().parseFromString(icon.svg, "image/svg+xml");
    holder.append(document.importNode(parsed.documentElement, true));
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
