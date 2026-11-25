// The deliverer's contract for Lazurio's element on a page it serves (0248's
// addendum of 2026-11-15, 0249's of 2026-11-22, 0210's of 2026-11-25; plan
// LZD-0039 `task-2026-11-25-101`): the version of a page is named by
// whoever delivers it, never by the page. The Environment's gateway
// delivers a Module's app in STAGING through the Launchpad (`staging`), the
// application host's gateway an Application (`production`, Machines#1580),
// the module kit a page in DEV (`dev`).
//
// On an HTML page the deliverer:
// - sets `version` on every `<lazurio-buddy>` to its own value, replacing
//   any other, the page's own element and the module kit's included;
// - adds, once, before `</body>` (or at the document's end where there is
//   none), the shell script where the page does not load it and the element
//   where the page has none;
// - never adds a second element.
// Any other response is returned as it came.

/** The version a deliverer names. */
export type DeliveredVersion = "staging" | "production";

/** The shell's script, on the page's own origin. */
export const shellScriptSrc = "/.lazurio/shell.js";

/** Whether a response is an HTML page the contract applies to. */
export function isHtmlPage(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return /^\s*text\/html\s*(;|$)/i.test(type) && response.body !== null;
}

// The page's own shell only: a relative reference, or one to the page's
// own origin, both read here against a placeholder origin; the same path on
// another origin is not the page's shell (review of #1254).
const pageOrigin = "https://page.invalid";
const loadsShell = (src: string | null, own: string | null): boolean => {
  if (src === null) return false;
  try {
    const url = new URL(src, `${pageOrigin}/`);
    return (
      url.pathname === shellScriptSrc &&
      (url.origin === pageOrigin || (own !== null && url.origin === own))
    );
  } catch {
    return false;
  }
};

/** The delivered page's `Cache-Control` (review of #1254): never reused
 * without asking again (`no-cache`), and never more storable than the app
 * allowed: its `no-store` and `private` stay, its freshness lifetimes go. */
export function deliveredCaching(app: string | null): string {
  // `private`, also qualified (`private="Set-Cookie"`), becomes plain
  // `private`, the stronger restriction (review of #1254). The split on
  // commas may cut a qualified list; each piece of it is judged alone,
  // which can only add restrictions.
  const kept = (app ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase())
    .flatMap((directive) =>
      directive === "no-store" || directive.startsWith("no-store=")
        ? ["no-store"]
        : directive === "private" || /^private\s*=/.test(directive)
          ? ["private"]
          : [],
    );
  return [...new Set([...kept, "no-cache"])].join(", ");
}

/**
 * The page with Lazurio's element delivered as `version`; any other
 * response unchanged. The body is rewritten as it streams, so its length is
 * no longer known: `Content-Length` is dropped. The caller passes a body
 * already decoded (`Content-Encoding` is dropped too).
 */
export function deliverElement(
  response: Response,
  version: DeliveredVersion,
  /** The page's own origin, where an absolute reference to its shell is
   * its own; null when not known. */
  origin: string | null = null,
): Response {
  if (!isHtmlPage(response)) return response;
  let script = false;
  let element = false;
  let added = false;
  const missing = (): string => {
    added = true;
    return [
      script ? "" : `<script type="module" src="${shellScriptSrc}"></script>`,
      element ? "" : `<lazurio-buddy version="${version}"></lazurio-buddy>`,
    ].join("");
  };
  const rewriter = new HTMLRewriter()
    .on("script[src]", {
      element(node) {
        if (loadsShell(node.getAttribute("src"), origin)) script = true;
      },
    })
    .on("lazurio-buddy", {
      element(node) {
        element = true;
        node.setAttribute("version", version);
      },
    })
    .on("body", {
      element(node) {
        node.onEndTag((end) => {
          if (!added) end.before(missing(), { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (!added) end.append(missing(), { html: true });
      },
    });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  // The delivered page is not the app's bytes: no validator of the app's
  // may revalidate it, and a browser asks again.
  headers.delete("etag");
  headers.delete("last-modified");
  headers.set("cache-control", deliveredCaching(headers.get("cache-control")));
  return rewriter.transform(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}
