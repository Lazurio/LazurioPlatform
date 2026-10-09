import type { ToolRunner } from "../tools/status";

// Composio as a source and a path of Integrace (decision F42): the person's
// own Composio account, signed in in Settings → Tools (decision F19), read
// and linked through its CLI `composio` 0.4.x. The commands and their output
// are the CLI's own (ComposioHQ/composio `ts/packages/cli`, read 2026-10-09):
// - `connections list` prints `{<toolkit>: [{status, alias?, word_id?,
//   permission_group}]}` on stdout: every status, an alias only where the
//   toolkit has several accounts, no ids;
// - `link <toolkit> --list` prints `{toolkit, total, items}` with the active
//   accounts and their ids;
// - `link <toolkit> --no-wait --no-browser [--alias <name>]` prints
//   `{status: "pending", connected_account_id, redirect_url, toolkit}`, or,
//   for a toolkit without Composio-managed sign-in, only a URL of Composio's
//   dashboard; it refuses an alias in use, and a second account without an
//   alias only after it created the link;
// - `connections remove <selector>` asks for a confirmation and, without a
//   terminal, removes nothing; Lazurio removes only where the CLI offers
//   `--yes`, and never answers the prompt for the person.
// Every process gets only PATH, HOME, the XDG base directories and
// NO_COLOR, in its own process group, bounded; its raw output is never
// returned or logged.

export type ComposioEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  xdg?: Readonly<Record<string, string>> | undefined;
  run: ToolRunner;
}>;

/** One account of the person's Composio account. */
export type ComposioAccount = Readonly<{
  toolkit: string;
  state: "connected" | "expired" | "pending" | "failed";
  alias: string | null;
  /** Composio's selector of the account, where it names one. */
  wordId: string | null;
}>;

export const composioTimeoutMs = 15_000;
const toolkitPattern = /^[a-z0-9][a-z0-9_]{0,63}$/;
const labelPattern = /^[^\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]{1,64}$/u;

/** The four states of an account (PR #269's mapping, kept): ACTIVE is
 * connected; EXPIRED and REVOKED expired; INITIATED and INITIALIZING
 * pending; FAILED, INACTIVE and anything new failed. */
export function composioState(status: string): ComposioAccount["state"] {
  if (status === "ACTIVE") return "connected";
  if (status === "EXPIRED" || status === "REVOKED") return "expired";
  if (status === "INITIATED" || status === "INITIALIZING") return "pending";
  return "failed";
}

function environmentOf(input: ComposioEnvironment): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" };
  if (input.path) env.PATH = input.path;
  if (input.home) env.HOME = input.home;
  for (const [name, value] of Object.entries(input.xdg ?? {}))
    if (/^XDG_[A-Z_]+$/.test(name) && value) env[name] = value;
  return env;
}

export async function runComposio(
  input: ComposioEnvironment,
  command: string,
  args: readonly string[],
): Promise<Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> | null> {
  try {
    const result = await input.run(
      [command, ...args],
      composioTimeoutMs,
      environmentOf(input),
    );
    return result === "timeout" ? null : result;
  } catch {
    return null;
  }
}

const signedOut = (output: string) => /not logged in/i.test(output);

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const optionalLabel = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && labelPattern.test(value)
    ? value
    : undefined;
};

/** `connections list` as accounts, or null for any other shape. */
export function parseComposioConnections(
  stdout: string,
): readonly ComposioAccount[] | null {
  const document = parseJsonObject(stdout);
  if (document === null) return null;
  const accounts: ComposioAccount[] = [];
  for (const [toolkit, entries] of Object.entries(document)) {
    if (!toolkitPattern.test(toolkit) || !Array.isArray(entries)) return null;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return null;
      const {
        status,
        alias,
        word_id: wordId,
      } = entry as Record<string, unknown>;
      const label = optionalLabel(alias);
      const word = optionalLabel(wordId);
      if (
        typeof status !== "string" ||
        label === undefined ||
        word === undefined
      )
        return null;
      accounts.push(
        Object.freeze({
          toolkit,
          state: composioState(status),
          alias: label,
          wordId: word,
        }),
      );
    }
  }
  return Object.freeze(accounts);
}

export type ComposioReading =
  | Readonly<{ state: "ok"; accounts: readonly ComposioAccount[] }>
  | Readonly<{ state: "signed-out" | "unreadable" }>;

/** The person's Composio accounts, read with the CLI at `command`. */
export async function readComposioAccounts(
  input: ComposioEnvironment,
  command: string,
): Promise<ComposioReading> {
  const result = await runComposio(input, command, ["connections", "list"]);
  if (result === null) return { state: "unreadable" };
  if (signedOut(`${result.stdout}\n${result.stderr}`))
    return { state: "signed-out" };
  if (result.exitCode !== 0) return { state: "unreadable" };
  const accounts = parseComposioConnections(result.stdout);
  return accounts === null
    ? { state: "unreadable" }
    : { state: "ok", accounts };
}

/** A toolkit's active accounts with their ids and names (`link <toolkit>
 * --list`), or null for any other answer. */
export async function activeComposioAccounts(
  input: ComposioEnvironment,
  command: string,
  toolkit: string,
): Promise<readonly Readonly<{ id: string; alias: string | null }>[] | null> {
  if (!toolkitPattern.test(toolkit)) return null;
  const result = await runComposio(input, command, ["link", toolkit, "--list"]);
  if (result === null || result.exitCode !== 0) return null;
  const document = parseJsonObject(result.stdout);
  if (document === null || document.toolkit !== toolkit) return null;
  const items = document.items;
  if (!Array.isArray(items)) return null;
  const accounts: Readonly<{ id: string; alias: string | null }>[] = [];
  for (const item of items) {
    const { id, alias } = (item ?? {}) as { id?: unknown; alias?: unknown };
    const name = optionalLabel(alias);
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      name === undefined
    )
      return null;
    accounts.push(Object.freeze({ id, alias: name }));
  }
  return Object.freeze(accounts);
}

/** Whether a link URL is Composio's own: https on composio.dev. */
export function composioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !(host === "composio.dev" || host.endsWith(".composio.dev"))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export type ComposioLink =
  | Readonly<{
      kind: "link";
      url: string;
      /** The pending account the link completes; none for a toolkit whose
       * sign-in Composio does not manage (the dashboard's own page). */
      account: string | null;
    }>
  | Readonly<{
      kind: "refused";
      reason: "signed-out" | "name-taken" | "name-required" | "link-failed";
    }>;

/** Starts a connection of `toolkit`: the address the person opens. */
export async function linkComposio(
  input: ComposioEnvironment,
  command: string,
  toolkit: string,
  alias: string | null,
): Promise<ComposioLink> {
  if (!toolkitPattern.test(toolkit))
    return { kind: "refused", reason: "link-failed" };
  const result = await runComposio(input, command, [
    "link",
    toolkit,
    "--no-wait",
    "--no-browser",
    ...(alias === null ? [] : ["--alias", alias]),
  ]);
  if (result === null) return { kind: "refused", reason: "link-failed" };
  const output = `${result.stdout}\n${result.stderr}`;
  if (signedOut(output)) return { kind: "refused", reason: "signed-out" };
  if (/is already in use by connected account/i.test(output))
    return { kind: "refused", reason: "name-taken" };
  if (/Pass --alias to create another one/i.test(output))
    return { kind: "refused", reason: "name-required" };
  const document = parseJsonObject(result.stdout);
  if (document !== null) {
    const url = composioUrl(document.redirect_url);
    const account = document.connected_account_id;
    if (
      document.status === "pending" &&
      url !== null &&
      typeof account === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(account)
    )
      return { kind: "link", url, account };
    return { kind: "refused", reason: "link-failed" };
  }
  // A toolkit without Composio-managed sign-in: only the dashboard's URL.
  const lines = result.stdout.trim().split(/\r?\n/);
  const url = lines.length === 1 ? composioUrl(lines[0]) : null;
  if (url !== null && new URL(url).hostname === "dashboard.composio.dev")
    return { kind: "link", url, account: null };
  return { kind: "refused", reason: "link-failed" };
}

/** Whether this `composio` removes an account without a terminal. */
export async function composioRemovesWithoutPrompt(
  input: ComposioEnvironment,
  command: string,
): Promise<boolean> {
  const result = await runComposio(input, command, [
    "connections",
    "remove",
    "--help",
  ]);
  return (
    result !== null && result.exitCode === 0 && /--yes\b/.test(result.stdout)
  );
}

/** Removes one account by its exact selector; only where the CLI has
 * `--yes`. The caller reads the accounts again as the proof. */
export async function removeComposioAccount(
  input: ComposioEnvironment,
  command: string,
  selector: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(selector)) return false;
  if (!(await composioRemovesWithoutPrompt(input, command))) return false;
  const result = await runComposio(input, command, [
    "connections",
    "remove",
    selector,
    "--yes",
  ]);
  return result !== null && result.exitCode === 0;
}
