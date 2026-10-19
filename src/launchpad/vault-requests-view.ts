import { isSecretRequestId, secretRequestPath } from "../vault/request-id";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// An agent's secret request on the page (root decision 0198 point 9 (c),
// decision F54; the wireframe's screens/SecretRequest.tsx and the section
// "Žádosti agentů" of EnvVault.tsx): what the person reads, in the agent's
// words, and what the routes answer, read as plain values. Pure: the panel
// (vault-requests-panel.ts) draws it as text, never as markup.

export type RequestField = Readonly<{ name: string; secret: boolean }>;

export type RequestView = Readonly<{
  id: string;
  item: string;
  need: string;
  why: string;
  where: string;
  fields: readonly RequestField[];
  state: "pending" | "saved" | "declined";
}>;

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** One request of the routes' answer, or null when it is not one. */
export function parseRequestView(value: unknown): RequestView | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    !isSecretRequestId(entry.id) ||
    !text(entry.item, 400) ||
    !text(entry.need, 800) ||
    !text(entry.why, 1200) ||
    !text(entry.where, 1200) ||
    !Array.isArray(entry.fields) ||
    entry.fields.length === 0 ||
    (entry.state !== "pending" &&
      entry.state !== "saved" &&
      entry.state !== "declined")
  )
    return null;
  const fields: RequestField[] = [];
  for (const field of entry.fields) {
    const named = field as Record<string, unknown> | null;
    if (
      typeof named !== "object" ||
      named === null ||
      !text(named.name, 240) ||
      typeof named.secret !== "boolean"
    )
      return null;
    fields.push(Object.freeze({ name: named.name, secret: named.secret }));
  }
  return Object.freeze({
    id: entry.id,
    item: entry.item,
    need: entry.need,
    why: entry.why,
    where: entry.where,
    fields: Object.freeze(fields),
    state: entry.state,
  });
}

/** `GET /api/vault/requests`: the requests that wait, or null when the
 * answer is not that. */
export function parseWaitingRequests(value: unknown): RequestView[] | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as Record<string, unknown>;
  if (answer.kind !== "vault-requests" || !Array.isArray(answer.requests))
    return null;
  const requests: RequestView[] = [];
  for (const entry of answer.requests) {
    const request = parseRequestView(entry);
    if (request === null) return null;
    if (request.state === "pending") requests.push(request);
  }
  return requests;
}

/** What the agent needs, as a title: "Klíč pro připojení k fakturaci". */
export const needTitle = (need: string): string =>
  `${need.charAt(0).toUpperCase()}${need.slice(1)}`;

/** The fields as a sentence lists them: "Client ID a Client secret",
 * "A, B a C". */
export function fieldList(fields: readonly RequestField[], copy: Copy): string {
  const names = fields.map((field) => field.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${copy.vaultRequestAnd} ${names.at(-1)}`;
}

/** Where the item goes, said once above the buttons. */
export const itemLine = (request: RequestView, copy: Copy): string =>
  copy.vaultRequestItem.replace("{item}", request.item);

/** The request's page in Nastavení → Trezor, which "Zadat" opens. */
export const requestHref = (request: RequestView): string =>
  secretRequestPath(request.id);

/** Whether every field has a value: only then can it be saved. */
export const isFilled = (
  request: RequestView,
  values: ReadonlyMap<string, string>,
): boolean =>
  request.fields.every((field) => (values.get(field.name) ?? "").trim() !== "");

/** What a refusal of the routes means for the person, in one sentence;
 * null where the page reads the request again (it was answered meanwhile,
 * or is gone). */
export function refusalText(reason: unknown, copy: Copy): string | null {
  switch (reason) {
    case "answered":
      return null;
    case "not-found":
      return copy.vaultRequestMissing;
    case "values-invalid":
      return copy.vaultRequestFill;
    case "busy":
    case "locked":
    case "unreachable":
      return copy.vaultRequestBusy;
    case "not-connected":
    case "pilot-0197":
      return copy.vaultRequestNotReady;
    // A public Organization's Environment has none, by design (DEV-6631).
    case "no-tailnet":
      return copy.vaultRequestNone;
    case "workstation":
    case "no-vault":
    case "folder-unreadable":
    case "handover-missing":
    case "handover-unreadable":
    case "not-operator":
      return copy.vaultRequestNoVault;
    default:
      return copy.vaultRequestFailed;
  }
}
