import { request } from "node:http";

// The brain server's own HTTP API on loopback (gbrain `serve --http`): its
// health, an MCP handshake that tells whether a key works, and the owner's
// admin API that mints and revokes keys. Only `lazurio brain setup` and
// doctor use the admin part, never the Launchpad's HTTP process: the owner
// credential (`~/.gbrain/serve/admin-token`) is read by them alone. Raw
// `node:http`, so no proxy of the environment ever sees a key. Nothing here
// logs or returns a token except the one minted, to its caller.

export type HttpAnswer = Readonly<{
  status: number;
  body: string;
  cookie?: string;
}>;

export type BrainHttp = (
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) => Promise<HttpAnswer | null>;

export const brainHttp: BrainHttp = (method, url, body, headers) =>
  new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      url,
      {
        method,
        headers: {
          accept: "application/json, text/event-stream",
          ...(data === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }),
          ...headers,
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const cookie = res.headers["set-cookie"]
            ?.map((value) => value.split(";")[0])
            .join("; ");
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(cookie ? { cookie } : {}),
          });
        });
        // A cut or malformed answer is no answer.
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    if (data !== undefined) req.write(data);
    req.end();
  });

/** The version /health answers with, or null. */
export async function healthVersion(
  http: BrainHttp,
  base: string,
): Promise<string | null> {
  const answer = await http("GET", `${base}/health`);
  if (answer === null || answer.status !== 200) return null;
  try {
    const value = JSON.parse(answer.body) as {
      status?: unknown;
      version?: unknown;
    };
    return value.status === "ok" &&
      typeof value.version === "string" &&
      value.version !== ""
      ? value.version
      : null;
  } catch {
    return null;
  }
}

/** Whether a key opens an MCP session. */
export async function keyWorks(
  http: BrainHttp,
  base: string,
  token: string,
): Promise<boolean> {
  const answer = await http(
    "POST",
    `${base}/mcp`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lazurio", version: "1" },
      },
    },
    { authorization: `Bearer ${token}` },
  );
  return answer !== null && answer.status === 200;
}

/** One MCP tool's answer as JSON, called with `token` (gbrain's MCP over
 * HTTP is stateless: no session to open first); null when it does not
 * answer or answers no JSON object. Used for metadata only (page counts,
 * sources), never for a page. */
export async function mcpTool(
  http: BrainHttp,
  base: string,
  token: string,
  name: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const answer = await http(
    "POST",
    `${base}/mcp`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    },
    { authorization: `Bearer ${token}` },
  );
  if (answer === null || answer.status !== 200) return null;
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const raw = answer.body.trimStart();
  // A JSON answer, or Server-Sent Events whose last data line is the answer.
  const message = raw.startsWith("{")
    ? json(raw)
    : json(
        raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1) ?? "",
      );
  const content = (message as { result?: { content?: unknown } } | undefined)
    ?.result?.content;
  const text =
    Array.isArray(content) &&
    typeof (content[0] as { text?: unknown } | undefined)?.text === "string"
      ? ((content[0] as { text: string }).text as string)
      : "";
  const value = json(text);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export type AdminKey = Readonly<{
  id: string;
  name: string;
  status: string;
}>;

/** An owner session of the admin API, or null when the owner credential is
 * refused or the server does not answer. */
export async function adminSession(
  http: BrainHttp,
  base: string,
  adminToken: string,
): Promise<Readonly<{
  keys(): Promise<readonly AdminKey[] | null>;
  mint(
    name: string,
    scopes: readonly string[],
  ): Promise<Readonly<{ id: string; token: string }> | null>;
  revoke(id: string): Promise<boolean>;
  /** Every client of the brain, keys and OAuth clients alike: its name,
   * kind and whether it is active; null when it cannot be listed. */
  clients(): Promise<readonly AdminClient[] | null>;
}> | null> {
  const login = await http("POST", `${base}/admin/login`, {
    token: adminToken,
  });
  if (login === null || login.status !== 200 || login.cookie === undefined)
    return null;
  const cookie = { cookie: login.cookie };
  return Object.freeze({
    async keys() {
      const answer = await http(
        "GET",
        `${base}/admin/api/api-keys`,
        undefined,
        cookie,
      );
      if (answer === null || answer.status !== 200) return null;
      try {
        const list = JSON.parse(answer.body) as unknown;
        if (!Array.isArray(list)) return null;
        return list.flatMap((item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as AdminKey).id === "string" &&
          typeof (item as AdminKey).name === "string"
            ? [
                Object.freeze({
                  id: (item as AdminKey).id,
                  name: (item as AdminKey).name,
                  status: String((item as AdminKey).status ?? "active"),
                }),
              ]
            : [],
        );
      } catch {
        return null;
      }
    },
    async mint(name, scopes) {
      const answer = await http(
        "POST",
        `${base}/admin/api/api-keys`,
        { name, scopes: [...scopes] },
        cookie,
      );
      if (answer === null || (answer.status !== 200 && answer.status !== 201))
        return null;
      try {
        const value = JSON.parse(answer.body) as {
          id?: unknown;
          token?: unknown;
        };
        return typeof value.id === "string" &&
          typeof value.token === "string" &&
          value.token.length >= 16
          ? Object.freeze({ id: value.id, token: value.token })
          : null;
      } catch {
        return null;
      }
    },
    async revoke(id) {
      const answer = await http(
        "POST",
        `${base}/admin/api/api-keys/revoke`,
        { id },
        cookie,
      );
      return answer !== null && answer.status === 200;
    },
    async clients() {
      const answer = await http(
        "GET",
        `${base}/admin/api/agents`,
        undefined,
        cookie,
      );
      if (answer === null || answer.status !== 200) return null;
      try {
        const list = JSON.parse(answer.body) as unknown;
        if (!Array.isArray(list)) return null;
        const clients: AdminClient[] = [];
        for (const item of list) {
          const value = item as Record<string, unknown> | null;
          const name = value?.name ?? value?.id;
          // One client it cannot name makes the whole list unreadable.
          if (typeof value !== "object" || value === null) return null;
          if (typeof name !== "string" || name === "") return null;
          clients.push(
            Object.freeze({
              name,
              kind: value.auth_type === "oauth" ? "oauth" : "api_key",
              active: String(value.status ?? "active") !== "revoked",
            }),
          );
        }
        return Object.freeze(clients);
      } catch {
        return null;
      }
    },
  });
}

export type AdminClient = Readonly<{
  name: string;
  kind: "api_key" | "oauth";
  active: boolean;
}>;
