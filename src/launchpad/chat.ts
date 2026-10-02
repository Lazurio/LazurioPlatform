import { join } from "node:path";
import type { MachineEntry } from "../folder/machine-binding";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";

// Chat into T3 Code (launchpad-parity B8, slice P7): what the resident
// Launchpad does today (`R:launchpad/src/t3-chat-lib.mjs:56-90`), with every
// value from the recorded entry. The Launchpad runs as the same Machine user
// as T3 Code, so it mints a one-time pairing token with T3's own CLI and hands
// it over in the fragment of `<t3codeOrigin>/pair`; whoever holds a shell on
// the Machine can mint the same token, and this only shortens the path for a
// browser the gateway already admitted. Nothing is recorded; the token is
// never logged, never in an error and never in a URL query.

/** The public parts of the recorded entry (`GET /api/entry`): the origins the
 * page links to, so the page composes none. The admission values (auth
 * endpoint, cookie name, ports) stay on the server. `mausbotOrigin` only on a
 * Machine that runs Lazurio MausBot. */
export type PublicEntry = Readonly<{
  launchpadOrigin: string;
  t3codeOrigin: string;
  moduleOriginTemplate: string;
  mausbotOrigin?: string;
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
  });
}

/** The resident's pairing call, unchanged: T3's `auth pairing create` for
 * T3's home `~/.t3` (Machines runs `serve --base-dir ~/.t3`,
 * `M:workloads/workspace-vm/tool-services.mjs:21`), a 60-second single-use
 * token labelled `launchpad-chat` (`R:launchpad/src/t3-chat-lib.mjs:10-11`). */
export const chatPairing = Object.freeze({
  command: "t3",
  ttl: "60s",
  label: "launchpad-chat",
  timeoutMs: 15_000,
});
const credentialPattern = /^[A-Za-z0-9_-]{8,128}$/;

export type ChatLink =
  | Readonly<{ kind: "chat-link"; url: string }>
  | Readonly<{
      kind: "blocked";
      reason: "t3-launcher-missing" | "t3-pairing-failed";
    }>;

/** `<t3codeOrigin>/pair#token=<credential>`: T3 Code's own pairing route, the
 * resident's shape (`R:launchpad/src/t3-chat-lib.mjs:56-60`). */
export function t3PairUrl(t3codeOrigin: string, credential: string): string {
  const url = new URL("/pair", t3codeOrigin);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.href;
}

/** A fresh pairing link for this Machine's T3 Code. `t3` is the launcher on
 * this process's PATH (Machines DEV-6624, `~/.local/bin/t3`); without it the
 * answer is `t3-launcher-missing` and the page follows the plain T3 Code
 * origin instead. Any failure of the call is `t3-pairing-failed`: its output
 * can hold the credential and is never passed on. */
export async function issueChatLink(
  entry: MachineEntry,
  environment: ToolsEnvironment,
): Promise<ChatLink> {
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
  let credential: unknown;
  try {
    const result = await environment.run(
      [
        launcher,
        "auth",
        "pairing",
        "create",
        "--base-dir",
        join(environment.home, ".t3"),
        "--ttl",
        chatPairing.ttl,
        "--label",
        chatPairing.label,
        "--json",
      ],
      chatPairing.timeoutMs,
      env,
    );
    if (result === "timeout" || result.exitCode !== 0) return failed;
    credential = (JSON.parse(result.stdout) as { credential?: unknown })
      ?.credential;
  } catch {
    return failed;
  }
  if (typeof credential !== "string" || !credentialPattern.test(credential))
    return failed;
  return Object.freeze({
    kind: "chat-link",
    url: t3PairUrl(entry.t3codeOrigin, credential),
  });
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
