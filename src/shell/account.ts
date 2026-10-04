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

/** Reads the account document's JSON once: the value, or null when it is
 * unavailable (any status but success, a network error, a timeout, not
 * JSON), with one debug line saying why. Never throws. */
export async function readAccountJson(
  fetcher: Fetch = fetch,
  timeoutMs = accountReadMs,
  log: Debug = debug,
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
      log(
        `Lazurio shell: no account (${response.status}); the rail shows this Environment only.`,
      );
      return null;
    }
    return await response.json();
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
