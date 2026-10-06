import type { MachineEntry } from "../folder/machine-binding";

// Lazurio MausBot, the Environment's bot-team app (DEV-6632, decision 0169),
// entered as Chat enters T3 Code: the Launchpad runs as the same Machine user
// as MausBot, so it mints a one-time pairing code with MausBot's own API on
// the recorded loopback port and hands it over in the fragment of
// `<mausbotOrigin>/pair`. OpenMausBot's pairing form only prefills it from
// there: one Connect click pairs the browser (auto-submit would be a fork
// change, left for later). OpenMausBot treats a loopback request without
// forwarded headers as its owner, exactly what `openmausbot pair` on the
// Machine does; this only shortens the path for a browser the gateway already
// admitted. The external origin is never called. Nothing is recorded; the
// code is never logged, never in an error and never in a URL query.

/** OpenMausBot's `POST /api/auth/pairing` (`server/index.ts`): a single-use
 * code of about five minutes, labelled for the sessions list. */
export const mausbotPairing = Object.freeze({
  path: "/api/auth/pairing",
  label: "launchpad",
  timeoutMs: 10_000,
  maxAnswerBytes: 64 * 1024,
});
// `formatPairingCode`: twelve symbols of the pairing alphabet in groups of four.
const codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export type MausbotLink =
  | Readonly<{ kind: "mausbot-link"; url: string }>
  | Readonly<{
      kind: "blocked";
      reason: "mausbot-unreachable" | "mausbot-pairing-failed";
    }>;

/** `<mausbotOrigin>/pair#code=<code>`: OpenMausBot's own pairing route, the
 * shape its server answers as `url`. */
export function mausbotPairUrl(mausbotOrigin: string, code: string): string {
  const url = new URL("/pair", mausbotOrigin);
  url.hash = new URLSearchParams([["code", code]]).toString();
  return url.href;
}

/** A fresh pairing link for this Machine's Lazurio MausBot, or why not: no
 * answer from the loopback port within the timeout is `mausbot-unreachable`;
 * any other answer than 200 with a code of the pairing shape is
 * `mausbot-pairing-failed`. The answer can hold the code and is never passed
 * on. The address is always loopback; `timeoutMs` bounds the call and its
 * answer together. */
export async function issueMausbotLink(
  entry: MachineEntry,
  timeoutMs: number = mausbotPairing.timeoutMs,
): Promise<MausbotLink> {
  const failed = Object.freeze({
    kind: "blocked" as const,
    reason: "mausbot-pairing-failed" as const,
  });
  const { mausbotOrigin, mausbotListenPort } = entry;
  if (mausbotOrigin === undefined || mausbotListenPort === undefined)
    return failed;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(
      new URL(mausbotPairing.path, `http://127.0.0.1:${mausbotListenPort}`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: mausbotPairing.label }),
        redirect: "manual",
        signal,
      },
    );
  } catch {
    return Object.freeze({ kind: "blocked", reason: "mausbot-unreachable" });
  }
  let code: unknown;
  try {
    if (response.status !== 200) {
      await response.body?.cancel();
      return failed;
    }
    const text = await response.text();
    if (text.length > mausbotPairing.maxAnswerBytes) return failed;
    code = (JSON.parse(text) as { code?: unknown } | null)?.code;
  } catch {
    return failed;
  }
  if (typeof code !== "string" || !codePattern.test(code)) return failed;
  return Object.freeze({
    kind: "mausbot-link",
    url: mausbotPairUrl(mausbotOrigin, code),
  });
}
