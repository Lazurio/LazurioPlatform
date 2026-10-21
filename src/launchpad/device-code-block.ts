// A one-time code and the provider's page where the person enters it, on any
// device: one block for gh's sign-in in its dialog (tools-panel.ts, decision
// F19) and ChatGPT's sign-in by code in Začínáme (start-panel.ts, root
// decision 0201 point 10). Every value is drawn with textContent, and the
// code reaches the clipboard only when the person clicks its button.

/** A code drawn large, spelled out for assistive technology. */
export function codeBox(value: string, label: string): HTMLParagraphElement {
  const box = document.createElement("p");
  box.className = "tools-code";
  box.setAttribute("aria-label", `${label}: ${value.split("").join(" ")}`);
  box.textContent = value;
  return box;
}

/** The provider's page as the primary button (the wireframe's "Otevřít
 * GitHub"), in a new tab. */
export function pageButton(href: string, label: string): HTMLParagraphElement {
  const anchor = document.createElement("a");
  anchor.className = "button primary tools-open";
  anchor.textContent = label;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  const row = document.createElement("p");
  row.className = "tool-actions";
  row.append(anchor);
  return row;
}

/** The code with a button that copies it, then its page (none when the page
 * is not one to show). */
export function deviceCodeBlock(
  input: Readonly<{
    code: string;
    url: string | null;
    labels: Readonly<{
      code: string;
      copy: string;
      copied: string;
      open: string;
    }>;
  }>,
): HTMLElement[] {
  const row = document.createElement("div");
  row.className = "tools-code-row";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = input.labels.copy;
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(input.code).then(
      () => {
        copy.textContent = input.labels.copied;
      },
      () => undefined,
    );
  });
  row.append(codeBox(input.code, input.labels.code), copy);
  return [
    row,
    ...(input.url === null ? [] : [pageButton(input.url, input.labels.open)]),
  ];
}
