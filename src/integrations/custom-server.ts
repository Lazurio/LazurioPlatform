import { canonicalEndpoint } from "./catalog-schema";

// A custom MCP server of Apps → Integrace → Vlastní (decision F42, addendum
// of 2026-10-11): the fields of Codex Desktop's "Connect to a custom MCP",
// the rules the page and the Launchpad's server both check, and how
// Executor 1.6.10 keeps them (docs/integrations.md "Custom MCP servers").
// Pure: the page checks as the person types, the server checks again before
// it asks Executor, and nothing here keeps a value.
//
// What is a key: every value of an environment variable, the Bearer token
// and every header value. Keys go only to Executor, as the server's one
// account (`org/default`) in Executor's secret store, and never come back:
// the reading, the edit form and the journal know their names only. The
// command, its arguments, the working directory and the address are the
// server's configuration and are shown again when it is edited; the address
// without userinfo or a query, which may carry a key.

export type CustomType = "stdio" | "http";

/** A key as the form sends it: its name and its value. On an edit, `null`
 * keeps the value Executor stores, which the page never sees. */
export type CustomKey = Readonly<{ name: string; value: string | null }>;

export type CustomServerInput =
  | Readonly<{
      type: "stdio";
      name: string;
      command: string;
      args: readonly string[];
      env: readonly CustomKey[];
      cwd: string | null;
    }>
  | Readonly<{
      type: "http";
      name: string;
      url: string;
      /** No token, a new one, or (`value: null`, on an edit) the stored one. */
      bearer: Readonly<{ value: string | null }> | null;
      headers: readonly CustomKey[];
    }>;

/** A custom server as its edit form opens: its configuration and the names
 * of its keys, never a value. */
export type CustomServerSettings =
  | Readonly<{
      kind: "custom-server";
      id: string;
      type: "stdio";
      name: string;
      command: string;
      args: readonly string[];
      cwd: string | null;
      env: readonly string[];
    }>
  | Readonly<{
      kind: "custom-server";
      id: string;
      type: "http";
      name: string;
      /** The address as the page shows it: scheme, host and path. */
      url: string;
      bearer: boolean;
      headers: readonly string[];
    }>;

/** What an edited server stores: the keys it may keep and the address the
 * page was shown (an unchanged address keeps the stored one). */
export type CustomStored = Readonly<{
  type: CustomType;
  bearer: boolean;
  /** The names of its environment variables or of its headers. */
  names: readonly string[];
  url: string | null;
}>;

export type CustomProblemKind =
  | "required"
  | "invalid"
  /** An address over plain http to another computer. */
  | "insecure"
  | "duplicate"
  /** The Authorization header beside a Bearer token, which sends it. */
  | "taken"
  /** A stored key must be entered again: another key changed. */
  | "again";

export type CustomProblem =
  | Readonly<{
      field: "name" | "command" | "url" | "cwd" | "bearer";
      problem: CustomProblemKind;
    }>
  | Readonly<{ field: "arg"; index: number; problem: CustomProblemKind }>
  | Readonly<{
      field: "env" | "header";
      index: number;
      part: "name" | "value";
      problem: CustomProblemKind;
    }>;

export const customLimits = Object.freeze({
  name: 64,
  command: 1024,
  cwd: 1024,
  url: 2048,
  args: 64,
  arg: 4096,
  keys: 32,
  keyName: 128,
  value: 4096,
});

const control = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** Executor's slug of an integration: a custom server's id. */
export const customServerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A POSIX environment variable name. */
export const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 `token`: what a header name may be on the wire. */
export const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Where Executor's Bearer token goes. */
export const bearerHeader = "Authorization";
const bearerPrefix = "Bearer ";
/** The slug of the auth method that carries a remote server's keys. */
export const keysTemplate = "apikey";
/** Executor's input of a single credential: the Bearer token's. */
const tokenVariable = "token";

/** One line of plain text of at most `max` characters, trimmed; null for
 * anything else (a control or bidirectional formatting character). */
export function plainLine(value: string, max: number): string | null {
  const trimmed = value.trim();
  return Array.from(trimmed).length > max || control.test(trimmed)
    ? null
    : trimmed;
}

/** Whether a host is this computer: plain http is allowed only there. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname)
  );
}

/** What is wrong with an address: https, or http on this computer only. */
export function urlProblem(value: string): CustomProblemKind | null {
  const trimmed = value.trim();
  if (trimmed === "") return "required";
  if (trimmed.length > customLimits.url || /\s/.test(trimmed)) return "invalid";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (url.protocol === "https:") return url.hostname === "" ? "invalid" : null;
  if (url.protocol === "http:")
    return isLoopbackHost(url.hostname) ? null : "insecure";
  return "invalid";
}

/** A working directory: absolute, or below the home (`~`, `~/…`). */
export function cwdProblem(value: string | null): CustomProblemKind | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = plainLine(value, customLimits.cwd);
  if (trimmed === null) return "invalid";
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("/")
    ? null
    : "invalid";
}

/** The working directory Executor gets: `~` resolved against the home of
 * this account, which Executor's service shares; null when there is none
 * to resolve it with. */
export function resolveCwd(
  value: string | null,
  home: string | undefined,
): string | null | "unresolved" {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (trimmed !== "~" && !trimmed.startsWith("~/")) return trimmed;
  if (home === undefined || !home.startsWith("/")) return "unresolved";
  const rest = trimmed.slice(1).replace(/^\/+/, "");
  return rest === "" ? home : `${home.replace(/\/+$/, "")}/${rest}`;
}

const keyValueProblem = (
  value: string,
  oneLine: boolean,
): CustomProblemKind | null => {
  if (value === "") return "required";
  if (value.length > customLimits.value || value.includes("\0"))
    return "invalid";
  return oneLine && /[\r\n]/.test(value) ? "invalid" : null;
};

const sameNames = (
  a: readonly string[],
  b: readonly string[],
  fold: (name: string) => string,
) => {
  const left = new Set(a.map(fold));
  const right = new Set(b.map(fold));
  return left.size === right.size && [...left].every((name) => right.has(name));
};

const keyName = (type: CustomType) =>
  type === "http"
    ? (name: string) => name.trim().toLowerCase()
    : (name: string) => name.trim();

/** Whether a server's keys change: a new value, a key added or removed, the
 * Bearer token added or removed, or a new address for a server that has
 * keys (the new address is probed and reached with them, and Executor never
 * returns a stored one). Executor keeps a server's keys together on its
 * account and never returns them, so then every key is sent again. A server
 * not yet added has nothing stored: all of its keys are new. */
export function keysChange(
  server: CustomServerInput,
  stored: CustomStored | null,
): boolean {
  if (stored === null) return true;
  if (server.type === "stdio")
    return (
      server.env.some((key) => key.value !== null) ||
      !sameNames(
        server.env.map((key) => key.name),
        stored.names,
        keyName("stdio"),
      )
    );
  const keyed = stored.bearer || stored.names.length > 0;
  return (
    (keyed && stored.url !== null && server.url.trim() !== stored.url) ||
    (server.bearer !== null) !== stored.bearer ||
    (server.bearer !== null && server.bearer.value !== null) ||
    server.headers.some((key) => key.value !== null) ||
    !sameNames(
      server.headers.map((key) => key.name),
      stored.names,
      keyName("http"),
    )
  );
}

/** Everything wrong with a server as the form has it, by field: what the
 * page says beside each field and what the server refuses. `stored` is the
 * edited server's, null for a new one. */
export function customProblems(
  server: CustomServerInput,
  stored: CustomStored | null,
): CustomProblem[] {
  const problems: CustomProblem[] = [];
  const name = server.name.trim();
  if (name === "") problems.push({ field: "name", problem: "required" });
  else if (plainLine(name, customLimits.name) === null)
    problems.push({ field: "name", problem: "invalid" });
  const changed = keysChange(server, stored);
  const fold = keyName(server.type);
  const storedNames = new Set((stored?.names ?? []).map(fold));
  const keys = server.type === "stdio" ? server.env : server.headers;
  const field = server.type === "stdio" ? "env" : "header";
  const seen = new Set<string>();
  keys.forEach((key, index) => {
    const keyNameText = key.name.trim();
    if (keyNameText === "")
      problems.push({ field, index, part: "name", problem: "required" });
    else if (
      keyNameText.length > customLimits.keyName ||
      !(server.type === "stdio" ? envNamePattern : headerNamePattern).test(
        keyNameText,
      )
    )
      problems.push({ field, index, part: "name", problem: "invalid" });
    else if (seen.has(fold(keyNameText)))
      problems.push({ field, index, part: "name", problem: "duplicate" });
    else if (
      server.type === "http" &&
      server.bearer !== null &&
      fold(keyNameText) === bearerHeader.toLowerCase()
    )
      problems.push({ field, index, part: "name", problem: "taken" });
    if (keyNameText !== "") seen.add(fold(keyNameText));
    if (key.value === null) {
      if (!storedNames.has(fold(keyNameText)))
        problems.push({ field, index, part: "value", problem: "required" });
      else if (changed)
        problems.push({ field, index, part: "value", problem: "again" });
      return;
    }
    const valueProblem = keyValueProblem(key.value, server.type === "http");
    if (valueProblem !== null)
      problems.push({ field, index, part: "value", problem: valueProblem });
  });
  if (keys.length > customLimits.keys)
    problems.push({
      field,
      index: customLimits.keys,
      part: "name",
      problem: "invalid",
    });
  if (server.type === "stdio") {
    const command = server.command.trim();
    if (command === "")
      problems.push({ field: "command", problem: "required" });
    else if (plainLine(command, customLimits.command) === null)
      problems.push({ field: "command", problem: "invalid" });
    server.args.forEach((arg, index) => {
      if (
        index >= customLimits.args ||
        arg.length > customLimits.arg ||
        arg.includes("\0")
      )
        problems.push({ field: "arg", index, problem: "invalid" });
    });
    const cwd = cwdProblem(server.cwd);
    if (cwd !== null) problems.push({ field: "cwd", problem: cwd });
    return problems;
  }
  // An unchanged address keeps the stored one, as it was added.
  if (stored === null || server.url.trim() !== stored.url) {
    const url = urlProblem(server.url);
    if (url !== null) problems.push({ field: "url", problem: url });
  }
  if (server.bearer !== null) {
    if (server.bearer.value === null) {
      if (stored === null || !stored.bearer)
        problems.push({ field: "bearer", problem: "required" });
      else if (changed) problems.push({ field: "bearer", problem: "again" });
    } else {
      const bearer = keyValueProblem(server.bearer.value, true);
      if (bearer !== null) problems.push({ field: "bearer", problem: bearer });
    }
  }
  return problems;
}

/** The headers a remote server's keys put on each request, as Executor
 * renders them; null while a key is kept (its value is Executor's). */
export function keyHeaders(
  server: Extract<CustomServerInput, { type: "http" }>,
): Record<string, string> | null {
  const headers: Record<string, string> = {};
  if (server.bearer !== null) {
    if (server.bearer.value === null) return null;
    headers[bearerHeader] = `${bearerPrefix}${server.bearer.value}`;
  }
  for (const key of server.headers) {
    if (key.value === null) return null;
    headers[key.name.trim()] = key.value;
  }
  return headers;
}

/** Executor's auth method for a remote server's keys, `Authorization:
 * Bearer <token>` and one input per header, with the account's values; null
 * without keys or while one is kept. `input` is the request-shaped dialect
 * `POST /api/mcp/servers` takes, `stored` the canonical placements a config
 * holds (`POST /api/mcp/servers/<slug>/config`). */
export function keysMethod(
  server: Extract<CustomServerInput, { type: "http" }>,
): Readonly<{
  input: Readonly<Record<string, unknown>>;
  stored: Readonly<Record<string, unknown>>;
  values: Readonly<Record<string, string>>;
}> | null {
  if (server.bearer === null && server.headers.length === 0) return null;
  const headers: Record<string, unknown> = {};
  const placements: Record<string, string>[] = [];
  const values: Record<string, string> = {};
  if (server.bearer !== null) {
    if (server.bearer.value === null) return null;
    headers[bearerHeader] = [
      bearerPrefix,
      { type: "variable", name: tokenVariable },
    ];
    placements.push({
      carrier: "header",
      name: bearerHeader,
      prefix: bearerPrefix,
    });
    values[tokenVariable] = server.bearer.value;
  }
  for (const key of server.headers) {
    if (key.value === null) return null;
    const name = key.name.trim();
    // One input per header, named after it: unique, as header names are,
    // and never the Bearer token's.
    const variable = `header-${name.toLowerCase()}`;
    headers[name] = [{ type: "variable", name: variable }];
    placements.push({ carrier: "header", name, variable });
    values[variable] = key.value;
  }
  return {
    input: { slug: keysTemplate, type: "apiKey", headers },
    stored: { slug: keysTemplate, kind: "apikey", placements },
    values,
  };
}

/** An environment variable's values as Executor's one-shot `env`; null
 * while one is kept. */
export function envValues(
  server: Extract<CustomServerInput, { type: "stdio" }>,
): Readonly<Record<string, string>> | null {
  const env: Record<string, string> = {};
  for (const key of server.env) {
    if (key.value === null) return null;
    env[key.name.trim()] = key.value;
  }
  return env;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** How a remote server authenticates as its config declares it: the method
 * its account binds (`template`), else its first. */
export function remoteAuthOf(
  config: Readonly<Record<string, unknown>>,
  template: string | null,
): Readonly<
  | { kind: "keys"; bearer: boolean; headers: readonly string[] }
  | { kind: "oauth2" | "none" }
> {
  const methods = (
    Array.isArray(config.authenticationTemplate)
      ? config.authenticationTemplate
      : []
  ).map(record);
  const method =
    methods.find((item) => template !== null && item.slug === template) ??
    methods[0];
  if (method?.kind === "oauth2") return { kind: "oauth2" };
  if (method?.kind !== "apikey") return { kind: "none" };
  let bearer = false;
  const headers: string[] = [];
  for (const placement of (Array.isArray(method.placements)
    ? method.placements
    : []
  ).map(record)) {
    if (placement.carrier !== "header" || typeof placement.name !== "string")
      continue;
    if (
      placement.name.toLowerCase() === bearerHeader.toLowerCase() &&
      typeof placement.prefix === "string" &&
      placement.prefix.toLowerCase() === bearerPrefix.toLowerCase()
    )
      bearer = true;
    else headers.push(placement.name);
  }
  return { kind: "keys", bearer, headers };
}

/** The names of a command server's environment variables (its `stdio_env`
 * method). */
export function envNamesOf(
  config: Readonly<Record<string, unknown>>,
): readonly string[] {
  const method = (
    Array.isArray(config.authenticationTemplate)
      ? config.authenticationTemplate
      : []
  )
    .map(record)
    .find((item) => item.kind === "stdio_env");
  return (Array.isArray(method?.vars) ? method.vars : []).filter(
    (name): name is string => typeof name === "string",
  );
}

/** The edit form of a server Executor answers (`GET /api/mcp/servers/<slug>`
 * `.config`), with the template its account binds; null for a config of
 * another shape. Values never enter it. */
export function settingsOf(
  id: string,
  name: string,
  config: Readonly<Record<string, unknown>>,
  template: string | null,
): CustomServerSettings | null {
  if (config.transport === "stdio" && typeof config.command === "string") {
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return {
      kind: "custom-server",
      id,
      type: "stdio",
      name,
      command: config.command,
      args,
      cwd: typeof config.cwd === "string" ? config.cwd : null,
      env: envNamesOf(config),
    };
  }
  if (config.transport === "remote" && typeof config.endpoint === "string") {
    const url = canonicalEndpoint(config.endpoint);
    if (url === null) return null;
    const auth = remoteAuthOf(config, template);
    return {
      kind: "custom-server",
      id,
      type: "http",
      name,
      url,
      bearer: auth.kind === "keys" && auth.bearer,
      headers: auth.kind === "keys" ? auth.headers : [],
    };
  }
  return null;
}

/** What an edit may keep, from the server's settings. */
export function storedOf(settings: CustomServerSettings): CustomStored {
  return settings.type === "stdio"
    ? { type: "stdio", bearer: false, names: settings.env, url: null }
    : {
        type: "http",
        bearer: settings.bearer,
        names: settings.headers,
        url: settings.url,
      };
}
