import { createHash } from "node:crypto";
import type { Microsoft365Setting } from "../organizations/organization-settings";
import {
  type ExecutorEndpoint,
  type ExecutorResult,
  executorCall,
} from "./executor-client";
import {
  type Microsoft365Part,
  microsoft365AuthTemplate,
  microsoft365Client,
  microsoft365Endpoints,
  microsoft365PartsOf,
  microsoft365Scopes,
  microsoft365Slug,
  microsoft365SpecId,
} from "./microsoft365";

// The Microsoft 365 company app in the Environment's Executor (decision F42
// addendum (c) of 2026-10-14; Executor 1.6.10, read from its source):
// - ONE OpenAPI integration `m365`: the Launchpad downloads the pinned spec
//   of every enabled part, checks its SHA-256, merges them into one
//   document and gives it to Executor as a blob (`POST /api/openapi/specs`,
//   or `POST …/m365/spec` in place), with the tenant's auth template whose
//   scopes are every part's; its description carries the document's id, so
//   applying again downloads nothing while it matches;
// - one manual OAuth client `microsoft365` of the Environment (`POST
//   /api/oauth/clients`, owner `org`, an empty secret: a public client with
//   PKCE), replaced only where its client id or tenant changed.
// Applying is idempotent, never signs anybody in and never touches a
// connection: an account signed in keeps working, Executor's tools follow
// the new document.

/** Executor parses a JSON spec of at most 32 MiB (`MAX_JSON_SPEC_CHARS`). */
export const executorSpecCharsMax = 32 * 1024 * 1024;
/** One pinned file is about 10 MB at most (files); a larger download is
 * refused before it is hashed. */
const specBytesMax = 16 * 1024 * 1024;
/** Adding a spec makes Executor parse and compile it: the merged document
 * has about 2,800 paths. */
const specTimeoutMs = 300_000;
const downloadTimeoutMs = 120_000;

export type Microsoft365Applied = Readonly<{
  outcome: "applied" | "failed";
  /** A short code of why it failed (a C2 report item's detail). */
  detail: string | null;
}>;

/** Why building the document failed, as a report item's detail. */
export type SpecFailure =
  | "spec-unavailable"
  | "spec-mismatch"
  | "spec-invalid"
  | "spec-conflict"
  | "spec-too-large";

export class Microsoft365SpecError extends Error {
  constructor(readonly detail: SpecFailure) {
    super(detail);
  }
}

class Failed extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

/** Downloads one pinned part's bytes; tests give their own. */
export type SpecFetch = (url: string) => Promise<Uint8Array>;

export const fetchPinnedSpec: SpecFetch = async (url) => {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(downloadTimeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > specBytesMax) throw new Error("too large");
  return readBounded(response, specBytesMax);
};

/** Reads a body chunk by chunk and stops the moment it passes `limit`:
 * `Content-Length` is optional, so the cap holds while streaming, never
 * after the whole body is in memory. */
export async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

/** One representation of a JSON value whatever the order of its keys. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) => {
    const record = object(member);
    return record === null
      ? member
      : Object.fromEntries(
          Object.keys(record)
            .sort()
            .map((key) => [key, record[key]]),
        );
  });
}

/**
 * The one document of the enabled parts: their paths and their components
 * merged, a component that several parts define identically kept once, any
 * other overlap a conflict that fails. Each part's own security scheme (the
 * curated specs declare `common` and their own scopes) is replaced by one
 * scheme with the union of the parts' scopes; the auth template Executor
 * gets names the tenant. Fails where the document would exceed what
 * Executor parses.
 */
export function mergeMicrosoft365Specs(
  documents: readonly Readonly<{ key: string; text: string }>[],
  parts: readonly Microsoft365Part[],
  charsMax: number = executorSpecCharsMax,
): string {
  let base: Json | null = null;
  const paths: Json = {};
  const components: Record<string, Json> = {};
  for (const document of documents) {
    let parsed: Json | null;
    try {
      parsed = object(JSON.parse(document.text));
    } catch {
      parsed = null;
    }
    const docPaths = object(parsed?.paths);
    if (
      parsed === null ||
      docPaths === null ||
      typeof parsed.openapi !== "string" ||
      !parsed.openapi.startsWith("3.")
    )
      throw new Microsoft365SpecError("spec-invalid");
    if (base === null) base = parsed;
    else if (
      parsed.openapi !== base.openapi ||
      canonical(parsed.servers) !== canonical(base.servers)
    )
      throw new Microsoft365SpecError("spec-conflict");
    for (const [path, item] of Object.entries(docPaths)) {
      if (
        Object.hasOwn(paths, path) &&
        canonical(paths[path]) !== canonical(item)
      )
        throw new Microsoft365SpecError("spec-conflict");
      paths[path] = item;
    }
    for (const [section, value] of Object.entries(
      object(parsed.components) ?? {},
    )) {
      if (section === "securitySchemes") continue;
      const entries = object(value);
      if (entries === null) throw new Microsoft365SpecError("spec-invalid");
      const merged: Json = components[section] ?? {};
      components[section] = merged;
      for (const [name, entry] of Object.entries(entries)) {
        if (
          Object.hasOwn(merged, name) &&
          canonical(merged[name]) !== canonical(entry)
        )
          throw new Microsoft365SpecError("spec-conflict");
        merged[name] = entry;
      }
    }
  }
  if (base === null) throw new Microsoft365SpecError("spec-invalid");
  const scopes = microsoft365Scopes(parts);
  const text = JSON.stringify({
    openapi: base.openapi,
    info: {
      title: "Microsoft 365",
      version: object(base.info)?.version ?? "v1.0",
      description:
        "Microsoft Graph for Outlook, OneDrive and SharePoint, merged by Lazurio from Executor's curated specs.",
    },
    servers: base.servers,
    paths,
    components: {
      ...components,
      securitySchemes: {
        microsoftOAuth2: {
          type: "oauth2",
          description:
            "Microsoft Entra ID (delegated), the Organization's company app.",
          flows: {
            authorizationCode: {
              ...microsoft365Endpoints("organizations"),
              scopes: Object.fromEntries(scopes.map((scope) => [scope, ""])),
            },
          },
        },
      },
    },
    security: [{ microsoftOAuth2: [...scopes] }],
  });
  if (text.length > charsMax) throw new Microsoft365SpecError("spec-too-large");
  return text;
}

/** Downloads every part, checks each against its pinned SHA-256 and merges
 * them. */
export async function buildMicrosoft365Spec(
  parts: readonly Microsoft365Part[],
  fetchSpec: SpecFetch = fetchPinnedSpec,
): Promise<string> {
  const documents: { key: string; text: string }[] = [];
  for (const item of parts) {
    let bytes: Uint8Array;
    try {
      bytes = await fetchSpec(item.url);
    } catch {
      throw new Microsoft365SpecError("spec-unavailable");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== item.sha256)
      throw new Microsoft365SpecError("spec-mismatch");
    documents.push({
      key: item.key,
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    });
  }
  return mergeMicrosoft365Specs(documents, parts);
}

function answer(result: ExecutorResult, ...ok: number[]): unknown {
  if (result.kind === "unavailable") throw new Failed("executor-unavailable");
  if (result.kind !== "answer") throw new Failed("executor-failed");
  if (!ok.includes(result.status)) throw new Failed("executor-refused");
  return result.body;
}

const record = (value: unknown): Record<string, unknown> => object(value) ?? {};

/** Whether a stored auth template signs in as `wanted` does: the same slug,
 * kind, endpoints and scopes (Executor may add its own optional fields). */
function sameTemplate(
  stored: unknown,
  wanted: ReturnType<typeof microsoft365AuthTemplate>,
): boolean {
  const value = record(stored);
  return (
    value.slug === wanted.slug &&
    value.kind === wanted.kind &&
    value.authorizationUrl === wanted.authorizationUrl &&
    value.tokenUrl === wanted.tokenUrl &&
    Array.isArray(value.scopes) &&
    value.scopes.length === wanted.scopes.length &&
    value.scopes.every((scope, index) => scope === wanted.scopes[index])
  );
}

/** The integration's description, which names the document it holds. */
export const microsoft365Description = (id: string) =>
  `Microsoft 365 (Outlook, OneDrive, SharePoint) through the Organization's company app; spec ${id}`;

/** The one integration, there and as this release and setting want it. */
async function ensureSpec(
  executor: ExecutorEndpoint,
  parts: readonly Microsoft365Part[],
  tenantId: string,
  fetchSpec: SpecFetch,
): Promise<void> {
  const template = microsoft365AuthTemplate(parts, tenantId);
  const description = microsoft365Description(microsoft365SpecId(parts));
  const listed = answer(
    await executorCall(executor, "GET", "/integrations"),
    200,
  );
  const present = (Array.isArray(listed) ? listed : [])
    .map(record)
    .find((entry) => entry.slug === microsoft365Slug);
  // The slug is the company app's identity: another kind of integration
  // under it is never reused or replaced.
  if (present !== undefined && present.kind !== "openapi")
    throw new Failed("integration-conflict");
  if (present === undefined) {
    const value = await buildMicrosoft365Spec(parts, fetchSpec);
    answer(
      await executorCall(
        executor,
        "POST",
        "/openapi/specs",
        {
          spec: { kind: "blob", value },
          slug: microsoft365Slug,
          name: "Microsoft 365",
          description,
          authenticationTemplate: [template],
        },
        specTimeoutMs,
      ),
      200,
    );
    return;
  }
  const path = `/openapi/integrations/${microsoft365Slug}`;
  if (present.description !== description) {
    const value = await buildMicrosoft365Spec(parts, fetchSpec);
    answer(
      await executorCall(
        executor,
        "POST",
        `${path}/spec`,
        { spec: { kind: "blob", value } },
        specTimeoutMs,
      ),
      200,
    );
    answer(
      await executorCall(
        executor,
        "PATCH",
        `/integrations/${microsoft365Slug}`,
        {
          description,
        },
      ),
      200,
    );
  }
  const config = record(
    answer(await executorCall(executor, "GET", `${path}/config`), 200),
  );
  const templates = Array.isArray(config.authenticationTemplate)
    ? config.authenticationTemplate
    : [];
  if (templates.length !== 1 || !sameTemplate(templates[0], template))
    answer(
      await executorCall(executor, "POST", `${path}/config`, {
        authenticationTemplate: [template],
        mode: "replace",
      }),
      200,
    );
}

/** The one client, as the setting names it: replaced where it differs. */
async function ensureClient(
  executor: ExecutorEndpoint,
  setting: Microsoft365Setting,
): Promise<void> {
  const endpoints = microsoft365Endpoints(setting.tenant_id);
  const listed = answer(
    await executorCall(executor, "GET", "/oauth/clients"),
    200,
  );
  const current = (Array.isArray(listed) ? listed : [])
    .map(record)
    .find(
      (entry) => entry.owner === "org" && entry.slug === microsoft365Client,
    );
  if (
    current !== undefined &&
    current.clientId === setting.client_id &&
    current.authorizationUrl === endpoints.authorizationUrl &&
    current.tokenUrl === endpoints.tokenUrl &&
    current.grant === "authorization_code" &&
    record(current.origin).kind === "manual"
  )
    return;
  answer(
    await executorCall(executor, "POST", "/oauth/clients", {
      owner: "org",
      slug: microsoft365Client,
      ...endpoints,
      grant: "authorization_code",
      clientId: setting.client_id,
      // No secret: a public client, PKCE only. The secret's absence is
      // what makes it one to Executor.
      clientSecret: "",
      resource: null,
      originIntegration: microsoft365Slug,
    }),
    200,
  );
}

/** Applies the company app to this Environment's Executor: the one
 * integration of the apps the setting turns on, and the client. */
export async function applyMicrosoft365(
  executor: ExecutorEndpoint | null,
  setting: Microsoft365Setting,
  fetchSpec: SpecFetch = fetchPinnedSpec,
  /** The pinned parts of the setting's apps; tests give their own. */
  parts: readonly Microsoft365Part[] = microsoft365PartsOf(setting.apps),
): Promise<Microsoft365Applied> {
  if (executor === null)
    return { outcome: "failed", detail: "executor-unavailable" };
  try {
    if (parts.length === 0) return { outcome: "applied", detail: null };
    await ensureSpec(executor, parts, setting.tenant_id, fetchSpec);
    await ensureClient(executor, setting);
    return { outcome: "applied", detail: null };
  } catch (error) {
    return {
      outcome: "failed",
      detail:
        error instanceof Failed || error instanceof Microsoft365SpecError
          ? error.detail
          : "executor-failed",
    };
  }
}
