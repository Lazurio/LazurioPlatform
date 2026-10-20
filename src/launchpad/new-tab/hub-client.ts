import {
  hubTabPath,
  hubTabsPath,
  hubTime,
  parseHubTab,
  type TabFacts,
} from "../../browser/contract/platform";
import { targetIdOf } from "../../browser/contract/pure";
import type { BrowserEntry } from "../../browser/units";

// The Launchpad's calls to the view's hub (decision F47 point 6): the four
// loopback requests on the view's recorded port (`entry.browser`), which
// exist only for a caller that sends no `Origin` and no `Sec-Fetch-Site`.
// Bun's fetch sends neither, and nothing here adds them. The hub runs as the
// same Unix user and is the only one that ends a tab; this client only asks.
// Its answers are bounded in size and time and read field by field: a value
// that is not of the hub's own shape is never passed on. The paths and the
// list's shape are the contract's C11 (src/browser/contract/platform.ts),
// one definition for the hub and this client.

export const hubCalls = Object.freeze({
  listTimeoutMs: 3_000,
  /** The hub waits up to 2 s for the browser to report a new tab. */
  openTimeoutMs: 5_000,
  actionTimeoutMs: 3_000,
  /** A tab's address may be long (Chrome allows 2 MiB): the list's bound
   * leaves room for one, and each address is cut below for display. */
  maxListBytes: 4 * 1024 * 1024,
  maxAnswerBytes: 16 * 1024,
  maxTabs: 500,
});

/** Why the hub did not do what was asked. `hub-unreachable` also covers an
 * answer that is not one of the hub's own, so nothing is guessed from it. */
export type HubRefusal = Readonly<{
  kind: "refused";
  reason:
    | "hub-unreachable"
    | "not-found"
    | "nothing-to-restore"
    | "invalid-request";
}>;

const refused = (reason: HubRefusal["reason"]): HubRefusal =>
  Object.freeze({ kind: "refused", reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The body, read to at most `limit` bytes as strict UTF-8; null past it. */
async function boundedText(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

/** One request to the hub on loopback: its status and JSON body, or null
 * when no answer came within `timeoutMs` (which bounds the answer's body
 * too) or it was not JSON within `maxBytes`. */
async function ask(
  entry: BrowserEntry,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  timeoutMs: number,
  maxBytes: number,
): Promise<Readonly<{ status: number; value: unknown }> | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${entry.listenPort}${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const text = await boundedText(response, maxBytes);
    if (text === null) return null;
    return { status: response.status, value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Every remote tab of the Environment as the hub lists it, with each tab's
 * JavaScript heap when `heap` (F47 point 7). Only a 200 with a list is one;
 * a hub that is down or not connected to the browser (its 503) is
 * unreachable. At most `maxTabs` tabs. */
export async function listTabs(
  entry: BrowserEntry,
  options: Readonly<{ heap: boolean }>,
  timeoutMs: number = hubCalls.listTimeoutMs,
): Promise<Readonly<{ kind: "tabs"; tabs: readonly TabFacts[] }> | HubRefusal> {
  const answer = await ask(
    entry,
    options.heap ? `${hubTabsPath}?heap=1` : hubTabsPath,
    "GET",
    undefined,
    timeoutMs,
    hubCalls.maxListBytes,
  );
  const tabs = isRecord(answer?.value) ? answer.value.tabs : undefined;
  if (answer?.status !== 200 || !Array.isArray(tabs))
    return refused("hub-unreachable");
  return Object.freeze({
    kind: "tabs",
    tabs: tabs.slice(0, hubCalls.maxTabs).flatMap((value: unknown) => {
      const tab = parseHubTab(value, options.heap);
      return tab === null ? [] : [tab];
    }),
  });
}

/** A new remote tab at `url` for `strip` (F47 points 3 and 6): its id. The
 * hub refuses an address its address bar may not open (`invalid-request`).
 * A tab of the strip that shows the page already is that tab (decision F57,
 * 200 with `reused`), and the answer says so. */
export async function openTab(
  entry: BrowserEntry,
  url: string,
  strip: string | null,
  timeoutMs: number = hubCalls.openTimeoutMs,
): Promise<
  Readonly<{ kind: "opened"; tab: string; reused?: true }> | HubRefusal
> {
  const answer = await ask(
    entry,
    hubTabsPath,
    "POST",
    { url, strip },
    timeoutMs,
    hubCalls.maxAnswerBytes,
  );
  if (answer?.status === 400) return refused("invalid-request");
  const tab = targetIdOf(isRecord(answer?.value) ? answer.value.id : undefined);
  const reused =
    answer?.status === 200 &&
    isRecord(answer.value) &&
    answer.value.reused === true;
  if ((answer?.status !== 201 && !reused) || tab === null)
    return refused("hub-unreachable");
  return Object.freeze(
    reused ? { kind: "opened", tab, reused: true } : { kind: "opened", tab },
  );
}

/** Closes a tab for everyone after the grace of Vrátit (F47 point 6): when
 * it ends unless restored. */
export async function closeTab(
  entry: BrowserEntry,
  id: string,
  timeoutMs: number = hubCalls.actionTimeoutMs,
): Promise<Readonly<{ kind: "closing"; closing: string }> | HubRefusal> {
  const tab = targetIdOf(id);
  if (tab === null) return refused("invalid-request");
  const answer = await ask(
    entry,
    hubTabPath(tab, "close"),
    "POST",
    undefined,
    timeoutMs,
    hubCalls.maxAnswerBytes,
  );
  if (answer?.status === 404) return refused("not-found");
  const closing = hubTime(
    isRecord(answer?.value) ? answer.value.closing : undefined,
  );
  if (answer?.status !== 202 || closing === null)
    return refused("hub-unreachable");
  return Object.freeze({ kind: "closing", closing });
}

/** Vrátit (F47 point 6): cancels a close for everyone or a grace. */
export async function restoreTab(
  entry: BrowserEntry,
  id: string,
  timeoutMs: number = hubCalls.actionTimeoutMs,
): Promise<Readonly<{ kind: "restored" }> | HubRefusal> {
  const tab = targetIdOf(id);
  if (tab === null) return refused("invalid-request");
  const answer = await ask(
    entry,
    hubTabPath(tab, "restore"),
    "POST",
    undefined,
    timeoutMs,
    hubCalls.maxAnswerBytes,
  );
  if (answer?.status === 404) return refused("not-found");
  if (answer?.status === 409) return refused("nothing-to-restore");
  if (
    answer?.status !== 200 ||
    !isRecord(answer.value) ||
    answer.value.restored !== true
  )
    return refused("hub-unreachable");
  return Object.freeze({ kind: "restored" });
}
