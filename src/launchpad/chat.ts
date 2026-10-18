import { join } from "node:path";
import type { MachineEntry } from "../folder/machine-binding";
import { t3Offers } from "../tools/ai-services";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { type AdmittedPerson, isLazurioUsername, nobody } from "./hosted-trust";
import { ownerAnswerMs } from "./owner-answer";
import { isPublicEnvironment } from "./public-environment";

// Chat into T3 Code (launchpad-parity B8, slice P7): what the resident
// Launchpad does today (`R:launchpad/src/t3-chat-lib.mjs:56-90`), with every
// value from the recorded entry. The Launchpad runs as the same Machine user
// as T3 Code, so it mints a one-time pairing token with T3's own CLI and hands
// it over in the fragment of `<t3codeOrigin>/pair`; whoever holds a shell on
// the Machine can mint the same token, and this only shortens the path for a
// browser the gateway already admitted. Nothing is recorded; the token is
// never logged, never in an error and never in a URL query.
//
// The Environment pairs its own browser (decision of the Organization Admin,
// 2026-10-17, docs/launchpad-development.md "Chat entry"): T3 Code's web
// client asks `GET /.lazurio/chat/pairing` on its own origin whenever it has
// no session, so every way into Chat is paired, not only the Launchpad's
// click. Both are minted by `mintChatPairing`: T3's operator pairing where
// the installed T3 Code offers it, the standard one on a public Environment
// and on an older T3 Code. Which scopes either carries is T3's own word.

/** The public parts of the recorded entry (`GET /api/entry`): the origins the
 * page links to, so the page composes none. The admission values (auth
 * endpoint, cookie name, ports) stay on the server. `mausbotOrigin` only on a
 * Machine that runs Lazurio MausBot; `browserOrigin` only where the gateway
 * routes the Environment browser's view (decision F38): the page opens the
 * view through `/.lazurio/browser.json`, never by this origin alone.
 * `audience` only on a public Environment (root decision 0204, decision
 * F55): the page then runs the demo onboarding and has no Integrace and no
 * Trezor; the server withholds them by the same recorded entry. */
export type PublicEntry = Readonly<{
  launchpadOrigin: string;
  t3codeOrigin: string;
  moduleOriginTemplate: string;
  mausbotOrigin?: string;
  browserOrigin?: string;
  audience?: "public";
}>;

export function publicEntry(entry: MachineEntry | null): PublicEntry | null {
  if (entry === null) return null;
  return Object.freeze({
    launchpadOrigin: entry.externalOrigin,
    t3codeOrigin: entry.t3codeOrigin,
    moduleOriginTemplate: entry.moduleOriginTemplate,
    ...(entry.mausbotOrigin === undefined
      ? {}
      : { mausbotOrigin: entry.mausbotOrigin }),
    ...(entry.browserOrigin === undefined
      ? {}
      : { browserOrigin: entry.browserOrigin }),
    ...(entry.audience === undefined ? {} : { audience: entry.audience }),
  });
}

/** Where T3 Code's web client asks for a pairing on its own origin, a path
 * of the gateway's segment grammar it forwards here; answered for `GET`
 * only. */
export const chatPairingPath = "/.lazurio/chat/pairing";

/** The pairing call: T3's own CLI for T3's home `~/.t3` (Machines runs
 * `serve --base-dir ~/.t3`, `M:workloads/workspace-vm/tool-services.mjs:21`),
 * a 60-second single-use token, as the resident minted it
 * (`R:launchpad/src/t3-chat-lib.mjs:10-11`). */
export const chatPairing = Object.freeze({
  command: "t3",
  ttl: "60s",
  timeoutMs: 15_000,
});
const credentialPattern = /^[A-Za-z0-9_-]{8,128}$/;
// When the token expires, as T3 prints it (`toISOString`, UTC).
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** One browser's pairing, minted on this Machine: the answer of
 * `GET /.lazurio/chat/pairing` exactly, and the credential of the link
 * `POST /api/chat/pair` answers. */
export type ChatPairing = Readonly<{
  kind: "chat-pairing";
  credential: string;
  expiresAt: string;
}>;

/** No pairing: no `t3` on PATH (nothing run), or the call failed. */
export type ChatPairingBlocked = Readonly<{
  kind: "blocked";
  reason: "t3-launcher-missing" | "t3-pairing-failed";
}>;

export type ChatLink =
  | Readonly<{ kind: "chat-link"; url: string }>
  | ChatPairingBlocked;

/** `<t3codeOrigin>/pair#token=<credential>`: T3 Code's own pairing route, the
 * resident's shape (`R:launchpad/src/t3-chat-lib.mjs:56-60`). */
export function t3PairUrl(t3codeOrigin: string, credential: string): string {
  const url = new URL("/pair", t3codeOrigin);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.href;
}

/** The label of a minted pairing, which T3 Code's Settings → Connections
 * shows beside the session, so a person sees whose browser each one is:
 * `Lazurio · <username>` for the person the gateway's admission named, and
 * `Lazurio` where it names nobody (a session from before the Lazurio
 * username, `lazurio chat link` in a terminal). The username counts only by
 * its own rule (`isLazurioUsername`: 3 to 39 lowercase letters, digits and
 * single dashes), so the label is at most 49 characters of plain text that
 * no command line reads as an option; T3's `--label` takes any non-empty
 * trimmed text. */
export function chatPairingLabel(person: AdmittedPerson = nobody): string {
  return isLazurioUsername(person.username)
    ? `Lazurio · ${person.username}`
    : "Lazurio";
}

/** Whether a request is a page's own script fetching on its own origin, the
 * one request `GET /.lazurio/chat/pairing` answers: `Sec-Fetch-Site:
 * same-origin`, the mode of a script's fetch (`cors` or `same-origin`) in
 * `Sec-Fetch-Mode`, and no prefetch or prerender named by `Sec-Purpose` or
 * the older `Purpose`. A browser sets these headers itself; no page's script
 * can. So a navigation (a link, a bookmark, a typed address), a subresource
 * (`no-cors`), a speculative load, another site and a client that sends no
 * Fetch Metadata mint nothing. A rule after admission, never an access
 * decision: whom the gateway admits decides who may enter. */
export function isChatPairingFetch(headers: Headers): boolean {
  const mode = headers.get("sec-fetch-mode");
  const purpose = `${headers.get("sec-purpose") ?? ""};${headers.get("purpose") ?? ""}`;
  return (
    headers.get("sec-fetch-site") === "same-origin" &&
    (mode === "cors" || mode === "same-origin") &&
    !/\bpre(?:fetch|render)\b/i.test(purpose)
  );
}

/** A fresh pairing of one browser with this Machine's T3 Code, for `person`
 * (the label). `t3` is the launcher on this process's PATH (Machines
 * DEV-6624, `~/.local/bin/t3`); without it the answer is
 * `t3-launcher-missing` and nothing runs. Where the installed T3 Code says
 * it offers its operator pairing (`operatorPairing` in `t3 lazurio
 * capabilities`, read as the provider refresh reads it), that is `t3 lazurio
 * pairing`, Team Environments included; on a public Environment, and with a
 * T3 Code that does not say so, it is the standard `t3 auth pairing create`,
 * and a public Environment does not even ask. Both print the same JSON: the
 * standard one with `--json`, the operator one always, and it takes no
 * `--json` (Lazurio/t3code#84; T3's CLI refuses a flag it does not know).
 * Any failure is `t3-pairing-failed`: the output can hold the credential and
 * is never passed on. */
export async function mintChatPairing(
  entry: MachineEntry,
  environment: ToolsEnvironment,
  person: AdmittedPerson = nobody,
): Promise<ChatPairing | ChatPairingBlocked> {
  const launcher = await resolveOnPath(
    chatPairing.command,
    environment.path,
    environment.platform,
  );
  if (launcher === undefined)
    return Object.freeze({ kind: "blocked", reason: "t3-launcher-missing" });
  const failed = Object.freeze({
    kind: "blocked" as const,
    reason: "t3-pairing-failed" as const,
  });
  if (!environment.home) return failed;
  const env: Record<string, string> = { HOME: environment.home };
  if (environment.path) env.PATH = environment.path;
  let answer: { credential?: unknown; expiresAt?: unknown } | null;
  try {
    const operator =
      !isPublicEnvironment(entry) &&
      (await t3Offers(launcher, env, environment.run, "operatorPairing"));
    const result = await environment.run(
      [
        launcher,
        ...(operator ? ["lazurio", "pairing"] : ["auth", "pairing", "create"]),
        "--base-dir",
        join(environment.home, ".t3"),
        "--ttl",
        chatPairing.ttl,
        "--label",
        chatPairingLabel(person),
        ...(operator ? [] : ["--json"]),
      ],
      chatPairing.timeoutMs,
      env,
    );
    if (result === "timeout" || result.exitCode !== 0) return failed;
    answer = JSON.parse(result.stdout);
  } catch {
    return failed;
  }
  const credential = answer?.credential;
  const expiresAt = answer?.expiresAt;
  if (
    typeof credential !== "string" ||
    !credentialPattern.test(credential) ||
    typeof expiresAt !== "string" ||
    !instantPattern.test(expiresAt) ||
    Number.isNaN(Date.parse(expiresAt))
  )
    return failed;
  return Object.freeze({ kind: "chat-pairing", credential, expiresAt });
}

/** A fresh pairing link for this Machine's T3 Code, minted for `person` by
 * `mintChatPairing`; without a pairing (`t3-launcher-missing`,
 * `t3-pairing-failed`) the page follows the plain T3 Code origin instead. */
export async function issueChatLink(
  entry: MachineEntry,
  environment: ToolsEnvironment,
  person: AdmittedPerson = nobody,
): Promise<ChatLink> {
  const pairing = await mintChatPairing(entry, environment, person);
  if (pairing.kind === "blocked") return pairing;
  return Object.freeze({
    kind: "chat-link",
    url: t3PairUrl(entry.t3codeOrigin, pairing.credential),
  });
}

// Whether Chat on this Environment takes a prepared prompt by link
// (Lazurio/t3code#35): "+ Nový modul" then opens Chat with the prompt's id
// in the link and copies nothing; otherwise the prompt goes to the clipboard
// as before. The one honest source is the T3 Code installed here: the
// Launchpad asks its own `t3` launcher for the version, as the pairing
// does, and only a Lazurio fork release from the first one with the
// hand-off on its channel says yes. Any failure, a vanilla upstream build or
// an unknown shape is no, so the clipboard is the fallback, never the guess.

/** The first releases of the Lazurio T3 Code fork whose Chat takes a
 * prepared prompt by link, per channel (`X.Y.Z-lazurio.N` stable,
 * `X.Y.Z-preview.YYYYMMDD.N` preview, the fork's release runbook). Set to the
 * first release that carries Lazurio/t3code#35: stable `v0.0.45-lazurio.2`,
 * released on 2026-10-04 from source 1e4cf23d, which contains the overlay of
 * Lazurio/t3code#36. No preview has carried it yet; the first one will be dated
 * 2026-10-04 or later. */
export const chatPromptsSince = Object.freeze({
  stable: "0.0.45-lazurio.2",
  preview: "0.0.45-preview.20261004.1",
});

const forkVersion =
  /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})-(?:lazurio\.(\d{1,6})|preview\.(\d{8})\.(\d{1,6}))$/;

function forkRelease(
  version: string,
): Readonly<{ channel: "stable" | "preview"; parts: number[] }> | null {
  const match = forkVersion.exec(version);
  if (match === null) return null;
  const base = [match[1], match[2], match[3]].map(Number);
  return match[4] !== undefined
    ? { channel: "stable", parts: [...base, Number(match[4])] }
    : {
        channel: "preview",
        parts: [...base, Number(match[5]), Number(match[6])],
      };
}

/** Whether a T3 Code version is a Lazurio fork release whose Chat takes a
 * prepared prompt by link: on its channel, not older than `chatPromptsSince`.
 * A vanilla upstream version and any other shape are no. */
export function chatTakesPromptsAt(version: string): boolean {
  const release = forkRelease(version);
  const since = release && forkRelease(chatPromptsSince[release.channel]);
  if (release === null || since === null) return false;
  for (const [index, part] of release.parts.entries()) {
    const floor = since.parts[index] ?? 0;
    if (part !== floor) return part > floor;
  }
  return true;
}

/** The version `t3 --version` prints (`t3 v0.0.45-lazurio.1`): its one token
 * of a fork release's shape, or null. */
export function t3Version(stdout: string): string | null {
  const tokens = stdout
    .split(/\s+/)
    .filter(
      (token) => forkVersion.test(token) || /^v?\d+\.\d+\.\d+$/.test(token),
    );
  return tokens.length === 1 ? (tokens[0] as string).replace(/^v/, "") : null;
}

/** Whether this Environment's Chat takes a prepared prompt by link, from
 * `t3 --version` of the launcher on this process's PATH (the one the pairing
 * runs). Kept as long as an Owner answer; one call at a time. */
export function createChatPromptCheck(
  environment: ToolsEnvironment,
  now: () => number = Date.now,
  cacheMs = ownerAnswerMs,
) {
  let known: Readonly<{ accepted: boolean; until: number }> | null = null;
  let asking: Promise<boolean> | null = null;
  async function ask(): Promise<boolean> {
    const launcher = await resolveOnPath(
      chatPairing.command,
      environment.path,
      environment.platform,
    );
    if (launcher === undefined || !environment.home) return false;
    const env: Record<string, string> = { HOME: environment.home };
    if (environment.path) env.PATH = environment.path;
    try {
      const result = await environment.run(
        [launcher, "--version"],
        chatPairing.timeoutMs,
        env,
      );
      if (result === "timeout" || result.exitCode !== 0) return false;
      const version = t3Version(result.stdout);
      return version !== null && chatTakesPromptsAt(version);
    } catch {
      return false;
    }
  }
  return {
    async accepted(): Promise<boolean> {
      if (known !== null && known.until > now()) return known.accepted;
      asking ??= ask()
        .catch(() => false)
        .then((accepted) => {
          known = { accepted, until: now() + cacheMs };
          asking = null;
          return accepted;
        });
      return asking;
    },
  };
}

/** Why `lazurio chat link` answers without a pairing: asked for the plain
 * link, the launcher missing or the call refused (the pairing route's own
 * reasons), or no recorded entry. A contract for automation: never renamed
 * or reused. */
export const chatLinkReasons = [
  "plain-requested",
  "t3-launcher-missing",
  "t3-pairing-failed",
  "not-hosted",
] as const;
export type ChatLinkReason = (typeof chatLinkReasons)[number];

/** The answer of `lazurio chat link` (B8's CLI, C.5 item 10): the pairing
 * link `POST /api/chat/pair` answers, from the same `issueChatLink`; without
 * one the plain T3 Code origin the page then follows, with the reason; no
 * link at all without a recorded entry. */
export type ChatLinkAnswer =
  | Readonly<{ kind: "chat-link"; url: string; pairing: true }>
  | Readonly<{
      kind: "chat-link";
      url: string;
      pairing: false;
      reason: Exclude<ChatLinkReason, "not-hosted">;
    }>
  | Readonly<{
      kind: "chat-link";
      url: null;
      pairing: false;
      reason: "not-hosted";
    }>;

export async function chatLinkAnswer(
  entry: MachineEntry | null,
  environment: ToolsEnvironment,
  options: Readonly<{ plain: boolean }>,
): Promise<ChatLinkAnswer> {
  const recorded = publicEntry(entry);
  if (entry === null || recorded === null)
    return Object.freeze({
      kind: "chat-link",
      url: null,
      pairing: false,
      reason: "not-hosted",
    });
  const plain = (reason: Exclude<ChatLinkReason, "not-hosted">) =>
    Object.freeze({
      kind: "chat-link" as const,
      url: recorded.t3codeOrigin,
      pairing: false as const,
      reason,
    });
  if (options.plain) return plain("plain-requested");
  const link = await issueChatLink(entry, environment);
  if (link.kind === "blocked") return plain(link.reason);
  return Object.freeze({ kind: "chat-link", url: link.url, pairing: true });
}
