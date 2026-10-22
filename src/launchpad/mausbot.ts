import type { MachineEntry } from "../folder/machine-binding";

// Lazurio MausBot, the Environment's bot-team app (DEV-6632, decision 0169),
// entered as Chat enters T3 Code: the Launchpad runs as the same Machine user
// as MausBot, so it mints a one-time pairing code with MausBot's own API on
// the recorded loopback port. OpenMausBot treats a loopback request without
// forwarded headers as its owner, exactly what `openmausbot pair` on the
// Machine does; this only shortens the path for a browser the gateway already
// admitted. The external origin is never called. Nothing is recorded; the
// code is never logged, never in an error and never in a URL query.
//
// Both ways in are minted by `mintMausbotPairing`. The Launchpad's click on
// Automate follows `<mausbotOrigin>/pair#code=…` (`POST /api/mausbot/pair`),
// whose form an older MausBot only prefills. And MausBot pairs its own
// browser as T3 Code does (the decision of 2026-10-17 and its addendum of
// 2026-10-22, docs/launchpad-development.md "Lazurio MausBot entry"): its web
// client asks `GET /.lazurio/mausbot/pairing` on its own origin whenever it
// has no session and redeems the code itself, so every way into Automate is
// paired, not only the Launchpad's click.

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

/** Where MausBot's web client asks for a pairing on its own origin, a path
 * of the gateway's segment grammar it forwards here; answered for `GET`
 * only. */
export const mausbotPairingPath = "/.lazurio/mausbot/pairing";

/** One browser's pairing, minted on this Machine: the answer of
 * `GET /.lazurio/mausbot/pairing` exactly, and the code of the link
 * `POST /api/mausbot/pair` answers. */
export type MausbotPairing = Readonly<{
  kind: "mausbot-pairing";
  code: string;
}>;

/** No pairing: no answer from the loopback port in time, or any other
 * answer than a code. */
export type MausbotPairingBlocked = Readonly<{
  kind: "blocked";
  reason: "mausbot-unreachable" | "mausbot-pairing-failed";
}>;

export type MausbotLink =
  | Readonly<{ kind: "mausbot-link"; url: string }>
  | MausbotPairingBlocked;

/** `<mausbotOrigin>/pair#code=<code>`: OpenMausBot's own pairing route, the
 * shape its server answers as `url`. */
export function mausbotPairUrl(mausbotOrigin: string, code: string): string {
  const url = new URL("/pair", mausbotOrigin);
  url.hash = new URLSearchParams([["code", code]]).toString();
  return url.href;
}

/** A fresh pairing code for this Machine's Lazurio MausBot, or why not: no
 * answer from the loopback port within the timeout is `mausbot-unreachable`;
 * any other answer than 200 with a code of the pairing shape is
 * `mausbot-pairing-failed`, and so is an entry that records no MausBot
 * (nothing is called). The answer can hold another credential and is never
 * passed on, only the code of the pairing shape. The address is always
 * loopback; `timeoutMs` bounds the call and its answer together. */
export async function mintMausbotPairing(
  entry: MachineEntry,
  timeoutMs: number = mausbotPairing.timeoutMs,
): Promise<MausbotPairing | MausbotPairingBlocked> {
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
  return Object.freeze({ kind: "mausbot-pairing", code });
}

/** A fresh pairing link for this Machine's Lazurio MausBot, minted by
 * `mintMausbotPairing`; without a pairing (`mausbot-unreachable`,
 * `mausbot-pairing-failed`) the page follows the plain MausBot origin
 * instead. */
export async function issueMausbotLink(
  entry: MachineEntry,
  timeoutMs: number = mausbotPairing.timeoutMs,
): Promise<MausbotLink> {
  const pairing = await mintMausbotPairing(entry, timeoutMs);
  if (pairing.kind === "blocked") return pairing;
  return Object.freeze({
    kind: "mausbot-link",
    // A pairing is minted only where the entry records MausBot's origin.
    url: mausbotPairUrl(entry.mausbotOrigin as string, pairing.code),
  });
}
