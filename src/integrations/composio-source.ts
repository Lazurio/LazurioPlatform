import type { ToolRunner } from "../tools/status";

// Composio as a source and a path of Integrace (decision F42): the person's
// own Composio account, signed in in Settings → Tools (decision F19), read
// and linked through its CLI `composio` 0.4.x. The commands and their output
// are the CLI's own (ComposioHQ/composio `ts/packages/cli`, read 2026-10-09):
// - `connections list` prints `{<toolkit>: [{status, alias?, word_id?,
//   permission_group}]}` on stdout: every status, an alias only where the
//   toolkit has several accounts, no ids;
// - `link <toolkit> --list` prints `{toolkit, total, items}` with the active
//   accounts, their ids, word ids and aliases (0.4.1 read 2026-10-11: the
//   JSON alone on stdout, an alias of null where the account has none);
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

/** One active account as `link <toolkit> --list` names it. */
export type ActiveComposioAccount = Readonly<{
  id: string;
  alias: string | null;
  /** Its word id; null where none is given or it is not a plain label. */
  wordId: string | null;
}>;

/** A toolkit's active accounts with their ids and names (`link <toolkit>
 * --list`), or null for any other answer. */
export async function activeComposioAccounts(
  input: ComposioEnvironment,
  command: string,
  toolkit: string,
): Promise<readonly ActiveComposioAccount[] | null> {
  if (!toolkitPattern.test(toolkit)) return null;
  const result = await runComposio(input, command, ["link", toolkit, "--list"]);
  if (result === null || result.exitCode !== 0) return null;
  const document = parseJsonObject(result.stdout);
  if (document === null || document.toolkit !== toolkit) return null;
  const items = document.items;
  if (!Array.isArray(items)) return null;
  const accounts: ActiveComposioAccount[] = [];
  for (const item of items) {
    const {
      id,
      alias,
      word_id: word,
    } = (item ?? {}) as { id?: unknown; alias?: unknown; word_id?: unknown };
    const name = optionalLabel(alias);
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      name === undefined
    )
      return null;
    accounts.push(
      Object.freeze({ id, alias: name, wordId: optionalLabel(word) ?? null }),
    );
  }
  return Object.freeze(accounts);
}

/** How many `link <toolkit> --list` run at once while accounts are named:
 * one `composio` process takes about 200 MB and a second (0.4.1, measured
 * 2026-10-11), and a Remote Environment may have little memory to spare
 * (8 GB, no swap: plan DEV-6656), so two at most. */
const namesAtOnce = 2;

/** How long the Launchpad keeps a name it read with `link <toolkit> --list`
 * (decision F42, addendum of 2026-10-11): far longer than the reading's
 * minute, because an account's word id is stable and its name changes only
 * when the person renames it in Composio. */
export const composioNamesFreshMs = 30 * 60_000;

/** Where a lookup of one toolkit started: the generations of forgetting,
 * every name's and the toolkit's own (`ComposioNames.since`). */
export type ComposioNamesSince = Readonly<{ all: number; toolkit: number }>;

/** The names of single Composio accounts the Launchpad has read, by toolkit
 * and word id (an alias, or null for an account Composio knows without
 * one), and the one place where their lookups run: two at a time for every
 * reading of the Launchpad together, so readings that overlap never run
 * more. "Zkontrolovat připojení" forgets every name; connecting or
 * disconnecting an account here forgets its toolkit's (`forget`). A lookup
 * that was running when they were forgotten keeps nothing: `set` stores an
 * answer only while nothing was forgotten since the lookup started
 * (`since`). */
export type ComposioNames = Readonly<{
  get(toolkit: string, wordId: string): string | null | undefined;
  /** Taken when a lookup of `toolkit` starts. */
  since(toolkit: string): ComposioNamesSince;
  set(
    toolkit: string,
    wordId: string,
    alias: string | null,
    since: ComposioNamesSince,
  ): void;
  /** Forgets one toolkit's names, or every name. */
  forget(toolkit?: string): void;
  /** Runs one lookup when one of the two places is free. */
  run(work: () => Promise<void>): Promise<void>;
}>;

/** At most `size` of the works at once; the others wait in turn. */
function limit(size: number): ComposioNames["run"] {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    while (running >= size)
      await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

export function createComposioNames(
  now: () => number = Date.now,
): ComposioNames {
  const entries = new Map<
    string,
    Readonly<{ toolkit: string; alias: string | null; at: number }>
  >();
  // How often every name, and each toolkit's, was forgotten.
  let all = 0;
  const forgotten = new Map<string, number>();
  const key = (toolkit: string, wordId: string) =>
    JSON.stringify([toolkit, wordId]);
  const fresh = (at: number) => now() - at < composioNamesFreshMs;
  return Object.freeze({
    get(toolkit: string, wordId: string) {
      const entry = entries.get(key(toolkit, wordId));
      return entry !== undefined && fresh(entry.at) ? entry.alias : undefined;
    },
    since(toolkit: string): ComposioNamesSince {
      return Object.freeze({ all, toolkit: forgotten.get(toolkit) ?? 0 });
    },
    set(
      toolkit: string,
      wordId: string,
      alias: string | null,
      since: ComposioNamesSince,
    ) {
      // Forgotten while the lookup ran: its answer is older than that.
      if (since.all !== all || since.toolkit !== (forgotten.get(toolkit) ?? 0))
        return;
      for (const [name, entry] of entries)
        if (!fresh(entry.at)) entries.delete(name);
      entries.set(
        key(toolkit, wordId),
        Object.freeze({ toolkit, alias, at: now() }),
      );
    },
    forget(toolkit?: string) {
      if (toolkit === undefined) {
        all += 1;
        entries.clear();
        return;
      }
      forgotten.set(toolkit, (forgotten.get(toolkit) ?? 0) + 1);
      for (const [name, entry] of entries)
        if (entry.toolkit === toolkit) entries.delete(name);
    },
    run: limit(namesAtOnce),
  });
}

/** The accounts, each toolkit's only active account with its name (decision
 * F42, addendum of 2026-10-11, #312). `connections list` prints an alias
 * only where a toolkit has several accounts, so where its only account is
 * active and has none there, its name is taken from `names` while they keep
 * it, and otherwise `link <toolkit> --list` is asked: once per such toolkit,
 * never for any other, two at a time (with `names`, for all readings
 * together). A call starts only within one Composio budget
 * (`composioTimeoutMs`) and runs within it, so naming adds at most two
 * budgets to a reading. The alias is taken only where `--list` lists exactly
 * one active account and, where both name a word id, the same one; that
 * answer, also no alias, is kept in `names` by the account's word id, unless
 * its names were forgotten while the lookup ran. Any other answer, a failure
 * or a timeout leaves the account unnamed and is not kept, and the page says
 * "účet"; so is an account without a word id, which is asked again at the
 * next reading. An account that is not active has no alias to read (`--list`
 * lists only active ones). */
export async function nameComposioAccounts(
  input: ComposioEnvironment,
  command: string,
  accounts: readonly ComposioAccount[],
  options: Readonly<{ names?: ComposioNames; now?: () => number }> = {},
): Promise<readonly ComposioAccount[]> {
  const known = options.names;
  const now = options.now ?? (() => performance.now());
  const counts = new Map<string, number>();
  for (const account of accounts)
    counts.set(account.toolkit, (counts.get(account.toolkit) ?? 0) + 1);
  const kept = (account: ComposioAccount) =>
    account.wordId === null
      ? undefined
      : known?.get(account.toolkit, account.wordId);
  const names = new Map<string, string | null>();
  const unnamed: ComposioAccount[] = [];
  for (const account of accounts) {
    if (
      counts.get(account.toolkit) !== 1 ||
      account.alias !== null ||
      account.state !== "connected"
    )
      continue;
    const alias = kept(account);
    if (alias === undefined) unnamed.push(account);
    else names.set(account.toolkit, alias);
  }
  const name = async (account: ComposioAccount) => {
    // Another reading may have read it meanwhile.
    const alias = kept(account);
    if (alias !== undefined) {
      names.set(account.toolkit, alias);
      return;
    }
    const since = known?.since(account.toolkit);
    const active = await activeComposioAccounts(
      input,
      command,
      account.toolkit,
    );
    const only = active?.length === 1 ? active[0] : undefined;
    if (only === undefined) return;
    if (
      account.wordId !== null &&
      only.wordId !== null &&
      only.wordId !== account.wordId
    )
      return;
    names.set(account.toolkit, only.alias);
    if (account.wordId !== null && since !== undefined)
      known?.set(account.toolkit, account.wordId, only.alias, since);
  };
  const run = known?.run ?? limit(namesAtOnce);
  const deadline = now() + composioTimeoutMs;
  await Promise.all(
    unnamed.map((account) =>
      run(async () => {
        if (now() < deadline) await name(account);
      }),
    ),
  );
  return [...names.values()].every((alias) => alias === null)
    ? accounts
    : Object.freeze(
        accounts.map((account) => {
          const alias = names.get(account.toolkit);
          return alias === undefined || alias === null
            ? account
            : Object.freeze({ ...account, alias });
        }),
      );
}

/** Composio's dashboard, where the person sees and changes their accounts. */
export const composioDashboard = "https://dashboard.composio.dev";

/** The page where the person sees and changes an account of `toolkit` in
 * Composio's dashboard. The dashboard has no page of one connected account,
 * so it is the closest: the toolkit's page in the person's Composio
 * organization, `/<organization name>/~/connect/apps/<toolkit>`, the path
 * the CLI builds when it links an account (`link.cmd.ts`), with the
 * organization's name as a path segment, encoded, and without the CLI's
 * `?open=true`, which would open the dialog that connects another account.
 * The name is the one `composio whoami` answers (`current_org_name`, read by
 * the sign-in probe of Settings → Tools). Where it is not known, the page is
 * asked under `~/org/`, which stands for the signed-in person's current
 * organization: a shortcut inferred from the links of Composio's
 * documentation (`/~/org/connect/clients`, `/~/org/settings/billing`), not
 * one documented for this page. A visitor who is not signed in to Composio
 * is sent to its sign-in and back to the page. */
export function composioManageUrl(
  organization: string | null,
  toolkit: string,
): string {
  return `${composioAppsUrl(organization)}/${encodeURIComponent(toolkit)}`;
}

/** The Apps section of the person's Composio organization in Composio's
 * dashboard, `/<organization name>/~/connect/apps` (decision F42, addendum
 * of 2026-10-14): where the person connects an app Lazurio's catalog does
 * not list and manages the ones they have, the page "Aplikace v Composiu"
 * opens. The organization's name is one encoded path segment; where it is
 * not known, `~/org/` as for `composioManageUrl`. */
export function composioAppsUrl(organization: string | null): string {
  return organization === null
    ? `${composioDashboard}/~/org/connect/apps`
    : `${composioDashboard}/${encodeURIComponent(organization)}/~/connect/apps`;
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
