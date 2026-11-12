import {
  type ComputersHost,
  listComputers,
  type PairRefusal,
  pairComputer,
  pairInputRefusals,
  pairingRequest,
  removeComputer,
} from "../computers/computers";
import type { ShellEnvironmentKind } from "../shell/contract";
import { escapeHtml } from "../shell/offline-page";
import type { AdmittedPerson } from "./hosted-trust";
import { BodyTooLarge, jsonBodyLimit, readJsonBody } from "./json-body";
import { type MessageKey, messages } from "./messages";
import { fill } from "./update-view";

// People's computers for agents (Lazurio Agent Desktop, root decisions 0240
// and 0241, decision F73), behind the admission of every route (the
// gateway's session; a write same-origin from the Launchpad's own origin,
// which is the protection against a forged request):
//
//   GET  /connect/computer?name&os&pubkey&callback&state
//                          the page the application opens in the person's
//                          own browser: the computer's name, system and key
//                          fingerprint, what it allows, and one button. No
//                          script: the button posts the form below.
//   POST /api/computers    pairs the computer. A form (the page) is answered
//                          by a redirect to the application's callback on
//                          127.0.0.1 with `state` and `result`; JSON by
//                          {kind: "computer-paired", deviceId, ssh, agents,
//                          redirect?}.
//   GET  /api/computers    the paired computers (Settings → Connections)
//   POST /api/computers/remove  {deviceId}
//
// The journal names the operation, the outcome, the id and the key's public
// fingerprint, never the key.

export const computersRoutePaths = Object.freeze({
  page: "/connect/computer",
  api: "/api/computers",
  remove: "/api/computers/remove",
});

const statePattern = /^[A-Za-z0-9_-]{16,256}$/;
const callbackPathPattern = /^\/[A-Za-z0-9._~/-]{0,200}$/;

/** The application's callback: exactly `http://127.0.0.1:<port>/<path>`,
 * nothing else (no other host, user, query or fragment), or null. */
export function computerCallback(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !callbackPathPattern.test(url.pathname) ||
    raw !== url.href
  )
    return null;
  return url;
}

export const isComputerState = (value: unknown): value is string =>
  typeof value === "string" && statePattern.test(value);

/** The callback with the pairing's outcome (contract v0 section 1). */
export function callbackWith(
  callback: URL,
  state: string,
  outcome: Readonly<Record<string, string>>,
): string {
  const target = new URL(callback.href);
  target.searchParams.set("state", state);
  for (const [name, value] of Object.entries(outcome))
    target.searchParams.set(name, value);
  return target.href;
}

export type ComputersPage = Readonly<{
  locale: "cs" | "en";
  kind: ShellEnvironmentKind | null;
}>;

const pageStyle = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d2433;--muted:#5b6475;--card:#fff;--line:#dfe3ea;--accent:#2457d6;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ef;--muted:#a3abb9;--card:#1c2027;--line:#2c323c;--accent:#7aa2ff;--accent-fg:#0d1117}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
main{width:100%;max-width:34rem;display:grid;gap:16px;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:12px}
h1{margin:0;font-size:20px;line-height:1.3}
p,ul,dl{margin:0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.note{color:var(--muted);font-size:14px}
h2{margin:0;font-size:15px}
ul{padding-left:20px;display:grid;gap:4px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,a.button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);text-decoration:none;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
`;

function document(locale: "cs" | "en", title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageStyle}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

/** The page's words for a refusal: the reason's code in the sentence, so
 * that the person and an agent can name it. */
function refusalPage(
  page: ComputersPage,
  reason: PairRefusal | "invalid-request",
): string {
  const copy = messages(page.locale, page.kind);
  const text =
    reason === "not-here"
      ? copy.connectComputerNotHere
      : pairInputRefusals.has(reason as PairRefusal) ||
          reason === "invalid-request"
        ? copy.connectComputerInvalid
        : fill(copy.connectComputerFailed, { reason: escapeHtml(reason) });
  return document(
    page.locale,
    copy.connectComputerTitle,
    `<h1>${escapeHtml(copy.connectComputerTitle)}</h1><p>${escapeHtml(text)}</p>`,
  );
}

/** The confirmation page for a valid request. */
export function confirmationPage(
  page: ComputersPage,
  request: Readonly<{
    name: string;
    os: "macos" | "windows";
    fingerprint: string;
    publicKey: string;
    callback: URL;
    state: string;
  }>,
): string {
  const copy = messages(page.locale, page.kind);
  const t = (key: MessageKey) => escapeHtml(copy[key]);
  const field = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const cancel = callbackWith(request.callback, request.state, {
    error: "cancelled",
  });
  return document(
    page.locale,
    copy.connectComputerTitle,
    `<h1>${t("connectComputerTitle")}</h1>
<p>${escapeHtml(fill(copy.connectComputerLead, { name: request.name }))}</p>
<dl>
<dt>${t("connectComputerSystem")}</dt><dd>${request.os === "macos" ? "macOS" : "Windows"}</dd>
<dt>${t("connectComputerFingerprint")}</dt><dd><code>${escapeHtml(request.fingerprint)}</code></dd>
</dl>
<p class="note">${t("connectComputerFingerprintNote")}</p>
<h2>${t("connectComputerPromiseHeading")}</h2>
<ul>
<li>${t("connectComputerPromise1")}</li>
<li>${t("connectComputerPromise2")}</li>
<li>${t("connectComputerPromise3")}</li>
<li>${t("connectComputerPromise4")}</li>
<li>${t("connectComputerPromise5")}</li>
</ul>
<form method="post" action="${computersRoutePaths.api}" class="actions">
${field("name", request.name)}
${field("os", request.os)}
${field("publicKey", request.publicKey)}
${field("callback", request.callback.href)}
${field("state", request.state)}
<button type="submit" class="primary">${t("connectComputerAllow")}</button>
<a class="button" href="${escapeHtml(cancel)}">${t("connectComputerCancel")}</a>
</form>`,
  );
}

/** A page's own headers: nothing loads, no script runs, the form posts only
 * here and the redirect after it only to the callback's origin. */
const pageHeaders = (
  headers: Readonly<Record<string, string>>,
  callback: URL | null,
) => ({
  ...headers,
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callback === null ? "" : ` ${callback.origin}`}; frame-ancestors 'none'; base-uri 'none'`,
});

export function createComputersRoutes(
  input: Readonly<{
    host: () => ComputersHost | Promise<ComputersHost>;
    page: () => Promise<ComputersPage>;
    headers: Readonly<Record<string, string>>;
    journal?: (entry: Readonly<Record<string, string>>) => void;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const html = (body: string, status: number, callback: URL | null) =>
    new Response(body, {
      status,
      headers: pageHeaders(input.headers, callback),
    });
  const journal = (entry: Record<string, string>) =>
    input.journal?.({ scope: "computers", ...entry });

  // A form's fields, bounded like a JSON body.
  async function formFields(
    request: Request,
  ): Promise<Record<string, string> | null> {
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > jsonBodyLimit) return null;
    const text = await request.text();
    if (text.length > jsonBodyLimit) return null;
    const fields: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(text)) {
      if (Object.hasOwn(fields, name)) return null;
      fields[name] = value;
    }
    return fields;
  }

  async function pair(
    request: Request,
    person: AdmittedPerson,
  ): Promise<Response> {
    const type = request.headers.get("content-type");
    const form = type === "application/x-www-form-urlencoded";
    if (!form && type !== "application/json")
      return response({ error: "invalid-content-type" }, 415);
    let value: Record<string, unknown>;
    try {
      if (form) {
        const fields = await formFields(request);
        if (fields === null) return response({ error: "invalid-request" }, 400);
        value = fields;
      } else {
        const body = await readJsonBody(request);
        if (body === null || typeof body !== "object" || Array.isArray(body))
          return response({ error: "invalid-request" }, 400);
        value = body as Record<string, unknown>;
      }
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return response({ error: "body-too-large" }, 413);
      return response({ error: "invalid-request" }, 400);
    }
    const callback =
      value.callback === undefined ? null : computerCallback(value.callback);
    const state = value.state;
    const withReturn =
      value.callback !== undefined || value.state !== undefined;
    const page = form ? await input.page() : null;
    if ((form || withReturn) && (callback === null || !isComputerState(state)))
      return page === null
        ? response({ error: "invalid-callback" }, 400)
        : html(refusalPage(page, "invalid-request"), 400, null);
    const answer = await pairComputer(await input.host(), {
      name: value.name,
      os: value.os,
      publicKey: value.publicKey,
      addedBy: person.username ?? undefined,
    });
    if (answer.kind === "blocked") {
      journal({ operation: "pair", outcome: "refused", reason: answer.reason });
      const status = pairInputRefusals.has(answer.reason) ? 400 : 409;
      return page === null
        ? response(answer, status)
        : html(refusalPage(page, answer.reason), status, null);
    }
    journal({
      operation: "pair",
      outcome: answer.outcome,
      device: answer.deviceId,
      agents: answer.agents,
    });
    const result = Buffer.from(
      JSON.stringify({ deviceId: answer.deviceId, ssh: answer.ssh }),
      "utf8",
    ).toString("base64url");
    const redirect =
      callback === null || typeof state !== "string"
        ? null
        : callbackWith(callback, state, { result });
    if (page !== null && redirect !== null)
      return new Response(null, {
        status: 303,
        headers: { ...input.headers, Location: redirect },
      });
    return response({
      kind: answer.kind,
      outcome: answer.outcome,
      deviceId: answer.deviceId,
      ssh: answer.ssh,
      agents: answer.agents,
      ...(redirect === null ? {} : { redirect }),
    });
  }

  return Object.freeze({
    handles: (path: string) =>
      path === computersRoutePaths.api ||
      path.startsWith(`${computersRoutePaths.api}/`),
    handlesPage: (path: string) => path === computersRoutePaths.page,

    /** The confirmation page, GET only. */
    async page(request: Request, url: URL): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD")
        return response({ error: "method-not-allowed" }, 405);
      const page = await input.page();
      const parameters = url.searchParams;
      const names = [...parameters.keys()];
      const callback = computerCallback(parameters.get("callback"));
      const state = parameters.get("state");
      const checked = pairingRequest({
        name: parameters.get("name"),
        os: parameters.get("os"),
        publicKey: parameters.get("pubkey"),
      });
      if (
        new Set(names).size !== names.length ||
        callback === null ||
        !isComputerState(state) ||
        "refused" in checked
      )
        return html(refusalPage(page, "invalid-request"), 400, null);
      const host = await input.host();
      if (!(await host.allowed()))
        return html(refusalPage(page, "not-here"), 409, null);
      return html(
        confirmationPage(page, {
          ...checked,
          publicKey: parameters.get("pubkey") as string,
          callback,
          state,
        }),
        200,
        callback,
      );
    },

    async handle(
      request: Request,
      url: URL,
      person: AdmittedPerson,
    ): Promise<Response> {
      if (url.pathname === computersRoutePaths.api) {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0)
            return response({ error: "invalid-query" }, 400);
          return response(await listComputers(await input.host()));
        }
        if (request.method === "POST") return pair(request, person);
        return response({ error: "method-not-allowed" }, 405);
      }
      if (url.pathname === computersRoutePaths.remove) {
        if (request.method !== "POST")
          return response({ error: "method-not-allowed" }, 405);
        if (request.headers.get("content-type") !== "application/json")
          return response({ error: "invalid-content-type" }, 415);
        let deviceId: unknown;
        try {
          const body = await readJsonBody(request);
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return response({ error: "invalid-request" }, 400);
          const keys = Object.keys(body);
          if (keys.length !== 1 || keys[0] !== "deviceId")
            return response({ error: "invalid-request" }, 400);
          deviceId = (body as Record<string, unknown>).deviceId;
        } catch (error) {
          if (error instanceof BodyTooLarge)
            return response({ error: "body-too-large" }, 413);
          return response({ error: "invalid-request" }, 400);
        }
        const answer = await removeComputer(await input.host(), deviceId);
        if (answer.kind === "blocked") {
          journal({
            operation: "remove",
            outcome: "refused",
            reason: answer.reason,
          });
          return response(
            answer,
            answer.reason === "invalid-id"
              ? 400
              : answer.reason === "not-found"
                ? 404
                : 409,
          );
        }
        journal({
          operation: "remove",
          outcome: "removed",
          device: answer.deviceId,
          agents: answer.agents,
        });
        return response(answer);
      }
      return response({ error: "not-found" }, 404);
    },
  });
}
