import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The person's memory as the Launchpad reads it (plan LZD-0033 R11b): the
// GBrain server of a Personal Environment, one HTTP server on the loopback
// with MCP at `/mcp`, which Machines installs and owns. The Launchpad is one
// more of its clients, read only: Machines mints it a key with the scope
// `read` over the server's admin API (the same way it mints Hermes's key)
// and hands it over in one file, 0600, beside the server's admin token. The
// key stays on the server side of the Launchpad; the browser only ever gets
// the pages and links this module returns. Nothing here writes to the
// memory, and nothing reads the admin token.
//
// Only what GBrain itself lets a `read` client see: a remote (untrusted)
// read leaves out `visibility: private` pages and facts, by GBrain's own
// rule, so the map does too.

/** The handover Machines writes for the Launchpad. */
export type MemoryHandover = Readonly<{ url: string; token: string }>;

/** Where GBrain lives in the person's home: its own directory, and the file
 * Machines hands the Launchpad's key over in. */
export function gbrainPaths(home: string = homedir()) {
  const root = join(home, ".gbrain");
  return Object.freeze({
    config: join(root, "config.json"),
    handover: join(root, "serve", "lazurio-launchpad.json"),
  });
}

/** Why the map cannot be read, in the words the page turns into a sentence:
 * `absent` no GBrain in this Environment, `no-access` GBrain is here but the
 * Launchpad has no key (yet) or the key is refused, `unreachable` the server
 * does not answer, `failed` it answered something this release cannot
 * read. */
export type MemoryFault = "absent" | "no-access" | "unreachable" | "failed";

export class MemoryUnavailable extends Error {
  constructor(readonly fault: MemoryFault) {
    super(`memory ${fault}`);
  }
}

/** A loopback http URL, the only kind the handover may name: the key never
 * leaves the Environment. */
export function isLoopbackUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** The handover as Machines wrote it, or null where it is missing or not
 * one (a wrong shape counts as missing: the page says the access is not
 * there yet). */
export function parseHandover(text: string): MemoryHandover | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { url, token } = value as Record<string, unknown>;
  if (typeof url !== "string" || !isLoopbackUrl(url)) return null;
  if (typeof token !== "string" || !/^[\x21-\x7e]{16,512}$/.test(token))
    return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** What the reader needs from the platform: files and HTTP. Trusted
 * composition; tests give their own. */
export type MemoryHost = Readonly<{
  /** The handover file's text, or null when it does not exist. */
  handover(): Promise<string | null>;
  /** Whether GBrain is installed here at all (its configuration exists). */
  installed(): Promise<boolean>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}>;

export function processMemoryHost(home: string = homedir()): MemoryHost {
  const paths = gbrainPaths(home);
  return Object.freeze({
    async handover() {
      try {
        return await readFile(paths.handover, "utf8");
      } catch {
        return null;
      }
    },
    async installed() {
      try {
        return (await stat(paths.config)).isFile();
      } catch {
        return false;
      }
    },
    fetch: (url: string, init: RequestInit) => fetch(url, init),
  });
}

/** One MCP tool call over GBrain's stateless Streamable HTTP: one POST, the
 * answer as JSON or as one server-sent event. Returns the tool's JSON text
 * parsed, with the result's `_meta`. */
export type ToolAnswer = Readonly<{ value: unknown; meta: unknown }>;

const callTimeoutMs = 15_000;

export function createGbrainReader(host: MemoryHost) {
  let id = 0;
  async function connection(): Promise<MemoryHandover> {
    const text = await host.handover();
    const handover = text === null ? null : parseHandover(text);
    if (handover !== null) return handover;
    throw new MemoryUnavailable(
      (await host.installed()) ? "no-access" : "absent",
    );
  }

  async function call(
    handover: MemoryHandover,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ToolAnswer> {
    id += 1;
    let response: Response;
    try {
      response = await host.fetch(`${handover.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handover.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: AbortSignal.timeout(callTimeoutMs),
        redirect: "error",
      });
    } catch {
      throw new MemoryUnavailable("unreachable");
    }
    if (response.status === 401 || response.status === 403)
      throw new MemoryUnavailable("no-access");
    if (!response.ok) throw new MemoryUnavailable("failed");
    const envelope = rpcEnvelope(
      await response.text(),
      response.headers.get("content-type") ?? "",
    );
    const result = envelope?.result as Record<string, unknown> | undefined;
    if (result === undefined || typeof result !== "object" || result === null)
      throw new MemoryUnavailable("failed");
    const text = firstText(result.content);
    if (text === null) throw new MemoryUnavailable("failed");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new MemoryUnavailable("failed");
    }
    if (result.isError === true) {
      const code = (value as Record<string, unknown> | null)?.code;
      // A key without the scope a tool needs is a missing access, not a
      // fault of the page.
      if (code === "insufficient_scope" || code === "unauthorized")
        throw new MemoryUnavailable("no-access");
      throw new ToolRefused(typeof code === "string" ? code : "error");
    }
    return { value, meta: result._meta };
  }

  return Object.freeze({
    connection,
    call,
  });
}

/** A tool answered with an error of its own (`page_not_found`, …). */
export class ToolRefused extends Error {
  constructor(readonly code: string) {
    super(`tool refused: ${code}`);
  }
}

export type GbrainReader = ReturnType<typeof createGbrainReader>;

/** The JSON-RPC envelope of a POST answer: the body itself, or the `data` of
 * its one `message` event. */
export function rpcEnvelope(
  body: string,
  contentType: string,
): Record<string, unknown> | null {
  const parse = (text: string) => {
    try {
      const value = JSON.parse(text);
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  if (!contentType.toLowerCase().includes("text/event-stream"))
    return parse(body);
  // Events are separated by a blank line; a data field may span lines.
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    const value = parse(data);
    if (value !== null && ("result" in value || "error" in value)) return value;
  }
  return null;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content)
    if (
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "text" &&
      typeof (item as Record<string, unknown>).text === "string"
    )
      return (item as Record<string, string>).text ?? null;
  return null;
}
