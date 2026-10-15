import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// How an Environment uses Composio (decision F42, addendum of 2026-10-13),
// drawn for people: their one Composio account; in it an organization of
// their own for each Organization, named as the Organization is, and their
// default one; each organization to its Environments. A grid of text, so it
// reads in order, wraps and follows the page's type and colours; nothing in
// it is a value from a server but the Organization's name, set as text.

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The figure; `organization` is the name of this Environment's
 * Organization, or null where the person chooses the organization. */
export function composioModel(
  copy: Copy,
  organization: string | null,
): HTMLElement {
  const figure = element("figure", "composio-model");
  figure.append(element("figcaption", "", copy.composioModelTitle));
  const grid = element("div", "composio-model-grid");
  const account = element("div", "composio-model-account");
  account.append(
    element("strong", "", copy.composioModelAccount),
    element("span", "", copy.composioModelAccountNote),
  );
  grid.append(account);
  const rows: [string, string, boolean][] = [
    ...(organization === null
      ? []
      : ([
          [
            fill(copy.composioModelOrganization, { name: organization }),
            fill(copy.composioModelEnvironments, { name: organization }),
            true,
          ],
        ] as [string, string, boolean][])),
    [copy.composioModelOthers, copy.composioModelOtherEnvironments, false],
    [copy.composioModelDefault, copy.composioModelPersonal, false],
  ];
  // Where each cell stands on a wide figure; short of room the cells flow
  // instead (index.html, .composio-model-grid).
  account.style.setProperty("--model-row", `1 / ${rows.length + 1}`);
  account.style.setProperty("--model-column", "1");
  rows.forEach(([organizationLabel, environments, here], index) => {
    const row = String(index + 1);
    const cells = [
      element("span", "composio-model-arrow", "→"),
      element("span", "composio-model-node", organizationLabel),
      element("span", "composio-model-arrow", "→"),
      element("span", "composio-model-node", environments),
    ];
    cells.forEach((cell, column) => {
      cell.style.setProperty("--model-row", row);
      cell.style.setProperty("--model-column", String(column + 2));
      if (cell.classList.contains("composio-model-arrow"))
        cell.setAttribute("aria-hidden", "true");
      else if (here) cell.classList.add("is-here");
    });
    grid.append(...cells);
  });
  figure.append(
    grid,
    element("p", "composio-model-caption", copy.composioModelCaption),
  );
  return figure;
}
