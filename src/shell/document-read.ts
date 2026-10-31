// The page's own shell document as the elements read it: `GET
// /.lazurio/shell.json` on the page's origin, which the Environment's gateway
// relays to its Launchpad (decision F36). The rail and the column head draw
// nothing until it arrives, while the rail already keeps its width, so a read
// that fails once used to leave an empty column beside the app until the
// window was focused again. One bounded cycle per read, as the account's
// (account.ts): a timeout, a network failure, `408` and `5xx` (a Launchpad
// that restarts, a gateway between two answers) retry after short delays; a
// refusal (`401`, `403`, `404`), a redirect to a sign-in and an answer that is
// no JSON stop at once. A final failure logs one debug line, so a rail that
// stays empty says why in the browser's console; the page's later events
// (shown again, focus, back online) read again (elements.ts).

export const shellDocumentPath = "/.lazurio/shell.json";
/** One attempt's deadline: the document is computed from what the
 * Launchpad keeps and never waits for GitHub, so a slower answer is stuck. */
export const shellDocumentReadMs = 8_000;
/** The delays between attempts: five attempts within about 8 s besides
 * their own time, enough for a Launchpad restart. */
const shellDocumentRetryDelaysMs = [250, 750, 2_000, 5_000] as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Debug = (message: string) => void;

const debug: Debug = (message) => console.debug(message);

/** The document's JSON, or null after a refusal, an invalid answer or the
 * retries spent. Follows no redirect: a session the gateway no longer admits
 * is a refusal, never a sign-in page read as the document. */
export async function readShellDocumentJson(
  fetcher: Fetch = fetch,
  timeoutMs = shellDocumentReadMs,
  log: Debug = debug,
  retryDelaysMs: readonly number[] = shellDocumentRetryDelaysMs,
): Promise<unknown> {
  let reason = "unreachable";
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retry = false;
    try {
      const response = await fetcher(shellDocumentPath, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.ok) return (await response.json()) as unknown;
      void response.body?.cancel().catch(() => {});
      reason =
        response.type === "opaqueredirect"
          ? "redirected to a sign-in"
          : String(response.status);
      retry = response.status === 408 || response.status >= 500;
    } catch (error) {
      reason = controller.signal.aborted
        ? "timeout"
        : error instanceof SyntaxError
          ? "not JSON"
          : "unreachable";
      retry = !(error instanceof SyntaxError);
    } finally {
      clearTimeout(timer);
    }
    const delay = retryDelaysMs[attempt];
    if (!retry || delay === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  log(
    `Lazurio shell: no shell document (${reason}); the rail stays empty until the page is shown again.`,
  );
  return null;
}
