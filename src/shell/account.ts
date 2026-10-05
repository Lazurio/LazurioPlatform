import { parseShellAccount, type ShellAccount } from "./contract";

// The person's account as the shell reads it (F37 and its addendum of
// 2026-10-04): `GET /.lazurio/account/environments` on the page's own
// origin, which the Environment's gateway relays to the Dashboard with the
// person's own token (`lazurio.account.v1`). The shell sends no token and
// follows no redirect: an expired session is a refusal, never a sign-in page
// to follow. Read once per page load, alongside `/.lazurio/shell.json`, and
// never polled. Whatever goes wrong (no relay yet, which is `404` on today's
// gateways; a refusal, `401` or `403`; a slow answer; anything but a valid
// document) the result is null and the rail is exactly this Environment's,
// with no error shown and one debug line. The Launchpad's Apps reads the
// same answer (`src/launchpad/account.ts`), so the page asks once.

export const accountDocumentPath = "/.lazurio/account/environments";
/** How long the shell waits for the account before it keeps the local rail. */
export const accountReadMs = 4_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Debug = (message: string) => void;

const debug: Debug = (message) => console.debug(message);

/** Where this origin keeps the last account document its operator read, so
 * the rail draws the person's spaces at once on the next page load and the
 * fresh answer replaces them when it arrives (Matěj 2026-10-05: the rail took
 * seconds to appear). Only an Environment that belongs to one person keeps
 * one: the account's operator must be this Environment's (the owner of a
 * personal Remote Environment, the assigned operator of a work one, the
 * responsible operator of an Automated one), when it is written and when it
 * is read. A Team Environment and a workstation name no operator, so they
 * neither keep nor use one: another person may open a shared origin, and
 * only the fresh answer is theirs. A refusal (`401`, `403`) or no relay
 * (`404`) removes it; a slow or failed answer keeps it. It holds only the
 * members `parseShellAccount` reads, never anything else the answer carried,
 * so never a token. */
export const accountCacheKey = "lazurio.account.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

function forget(store: Store | null): void {
  try {
    store?.removeItem(accountCacheKey);
  } catch {}
}

/** Whether the account is `login`'s own (case aside). An unknown login on
 * either side is never a match. */
const ownAccount = (account: ShellAccount, login: string | null): boolean =>
  login !== null &&
  account.operator.login !== null &&
  account.operator.login.toLowerCase() === login.toLowerCase();

/** Keeps a fresh account as this origin's remembered one when it is the
 * account of `login`, this Environment's operator; otherwise removes what
 * this origin kept, which is no longer this person's to show. Writes only
 * the parsed members (`ShellAccount`), whatever else the answer carried. */
export function rememberAccount(
  account: ShellAccount,
  login: string | null,
  store: Store | null = browserStore(),
): void {
  if (!ownAccount(account, login)) {
    forget(store);
    return;
  }
  try {
    store?.setItem(accountCacheKey, JSON.stringify(account));
  } catch {}
}

/** The account this origin remembered, when it is `login`'s own (this
 * Environment's operator); otherwise, without a known `login`, or when
 * there is none or it no longer parses, null. */
export function cachedAccountFor(
  login: string | null,
  store: Store | null = browserStore(),
): ShellAccount | null {
  if (login === null) return null;
  let raw: string | null = null;
  try {
    raw = store?.getItem(accountCacheKey) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let account: ShellAccount | null = null;
  try {
    account = parseShellAccount(JSON.parse(raw));
  } catch {
    account = null;
  }
  if (account === null) {
    forget(store);
    return null;
  }
  return ownAccount(account, login) ? account : null;
}

/** Reads the account document's JSON once: the value, or null when it is
 * unavailable (any status but success, a network error, a timeout, not
 * JSON), with one debug line saying why. Never throws. A refusal or no
 * relay also removes this origin's remembered account (`accountCacheKey`);
 * keeping a fresh one is the shell's, which knows the operator
 * (`rememberAccount`). */
export async function readAccountJson(
  fetcher: Fetch = fetch,
  timeoutMs = accountReadMs,
  log: Debug = debug,
  store: Store | null = browserStore(),
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(accountDocumentPath, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      // A refusal or no relay: the remembered rail is no longer this
      // person's to show. Anything else may pass; keep it.
      if ([401, 403, 404].includes(response.status)) forget(store);
      log(
        `Lazurio shell: no account (${response.status}); the rail shows this Environment only.`,
      );
      return null;
    }
    return (await response.json()) as unknown;
  } catch (error) {
    log(
      `Lazurio shell: no account (${controller.signal.aborted ? "timeout" : error instanceof SyntaxError ? "not JSON" : "unreachable"}); the rail shows this Environment only.`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the account document: the parsed `lazurio.account.v1`, or null. */
export async function readShellAccount(
  read: () => Promise<unknown> = () => readAccountJson(),
  log: Debug = debug,
): Promise<ShellAccount | null> {
  const value = await read();
  if (value === null) return null;
  const account = parseShellAccount(value);
  if (account === null)
    log(
      "Lazurio shell: the account document is not lazurio.account.v1; the rail shows this Environment only.",
    );
  return account;
}

let pageRead: Promise<unknown> | null = null;

/** The account document's JSON of this page: read on the first call, the
 * same answer for every later one (one request per page load). */
export function pageAccountJson(): Promise<unknown> {
  pageRead ??= readAccountJson();
  return pageRead;
}
