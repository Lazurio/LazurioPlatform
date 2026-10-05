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

/** Where this origin keeps the last account document it read, so the rail
 * draws the person's spaces at once on the next page load and the fresh
 * answer replaces them when it arrives (Matěj 2026-10-05: the rail took
 * seconds to appear). A valid answer replaces it; a refusal (`401`, `403`)
 * or no relay (`404`) removes it; a slow or failed answer keeps it. It holds
 * only what the account document holds (names, addresses, avatars), never a
 * token, and is used only for the same operator (`cachedAccountFor`). */
export const accountCacheKey = "lazurio.account.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

function remember(value: unknown, store: Store | null): void {
  if (store === null || parseShellAccount(value) === null) return;
  try {
    store.setItem(accountCacheKey, JSON.stringify(value));
  } catch {}
}

function forget(store: Store | null): void {
  try {
    store?.removeItem(accountCacheKey);
  } catch {}
}

/** The last account document this origin read, when it belongs to
 * `login` (this Environment's operator) or no operator is known on either
 * side; otherwise, or when there is none or it no longer parses, null. */
export function cachedAccountFor(
  login: string | null,
  store: Store | null = browserStore(),
): ShellAccount | null {
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
  const cached = account.operator.login;
  if (
    login !== null &&
    cached !== null &&
    cached.toLowerCase() !== login.toLowerCase()
  )
    return null;
  return account;
}

/** Reads the account document's JSON once: the value, or null when it is
 * unavailable (any status but success, a network error, a timeout, not
 * JSON), with one debug line saying why. Never throws. The answer also
 * updates this origin's remembered document (`accountCacheKey`). */
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
    const value: unknown = await response.json();
    remember(value, store);
    return value;
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
