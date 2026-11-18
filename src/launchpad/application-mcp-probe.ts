/**
 * Whether an Application's host admits MCP sign-in for it (plan LZD-0037,
 * Module Standard "Tools for agents"), checked before Apps offers to connect
 * it, beside the source's statement that the Application serves MCP
 * (`AccountApplication.mcp`). The probe cannot see behind the gateway: a host
 * answers the same for an App without `/mcp` until the gateway answers `/mcp`
 * only for an Application that declares it (HumanAndMachine-ai/Machines#1382),
 * so it guards against a stale or wrong origin, not a wrong statement. It
 * asks what any MCP client asks first:
 * `POST <origin>/mcp` without a token answers 401 with a Bearer challenge that
 * names the protected-resource metadata, and those metadata name exactly that
 * `/mcp` as their resource and at least one authorization server. It sends no
 * credential, follows no redirect and reaches only an Application's own
 * origin (`https://<module>.<organization>.lazurio.app`).
 */
import { isAccountApplicationOrigin } from "../shell/contract";

/** `admits`: the Application's host admits MCP sign-in for that origin.
 * It says nothing of the App behind the gateway (Machines#1382). */
export type McpProbeAnswer =
  | Readonly<{ admits: true }>
  | Readonly<{
      admits: false;
      reason: "not-an-application" | "unreachable" | "no-mcp-sign-in";
    }>;

const applicationsZone = ".lazurio.app";

/** Whether an origin is an Application's own: an account Application origin
 * on the Organizations' zone. */
export function isApplicationOrigin(origin: unknown): origin is string {
  if (!isAccountApplicationOrigin(origin)) return false;
  return new URL(origin).hostname.endsWith(applicationsZone);
}

/** The `resource_metadata` a Bearer challenge names, or null. */
function resourceMetadata(challenge: string | null): string | null {
  if (challenge === null || !/^\s*Bearer\b/i.test(challenge)) return null;
  const match = /resource_metadata="([^"]+)"/i.exec(challenge);
  return match?.[1] ?? null;
}

export async function probeApplicationMcp(
  origin: unknown,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<McpProbeAnswer> {
  if (!isApplicationOrigin(origin))
    return { admits: false, reason: "not-an-application" };
  const endpoint = `${origin}/mcp`;
  let challenge: string | null;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "lazurio-apps", version: "1" },
        },
      }),
    });
    await response.body?.cancel();
    if (response.status !== 401)
      return { admits: false, reason: "no-mcp-sign-in" };
    challenge = response.headers.get("www-authenticate");
  } catch {
    return { admits: false, reason: "unreachable" };
  }
  const metadata = resourceMetadata(challenge);
  if (metadata === null) return { admits: false, reason: "no-mcp-sign-in" };
  let metadataUrl: URL;
  try {
    metadataUrl = new URL(metadata);
  } catch {
    return { admits: false, reason: "no-mcp-sign-in" };
  }
  // The metadata are the Application's own, never another host's.
  if (metadataUrl.origin !== origin)
    return { admits: false, reason: "no-mcp-sign-in" };
  try {
    const response = await fetcher(metadataUrl.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { admits: false, reason: "no-mcp-sign-in" };
    }
    const value = (await response.json()) as {
      resource?: unknown;
      authorization_servers?: unknown;
    };
    const servers = value.authorization_servers;
    return value.resource === endpoint &&
      Array.isArray(servers) &&
      servers.length > 0 &&
      servers.every((server) => typeof server === "string")
      ? { admits: true }
      : { admits: false, reason: "no-mcp-sign-in" };
  } catch {
    return { admits: false, reason: "unreachable" };
  }
}

/** The probe with a short memory per origin, so an open page asks each
 * Application at most once in `ttlMs`. */
export function cachedMcpProbe(
  probe: (origin: unknown) => Promise<McpProbeAnswer> = probeApplicationMcp,
  ttlMs = 10 * 60 * 1000,
  now: () => number = Date.now,
) {
  const answers = new Map<string, { at: number; answer: McpProbeAnswer }>();
  return async (origin: unknown): Promise<McpProbeAnswer> => {
    if (!isApplicationOrigin(origin))
      return { admits: false, reason: "not-an-application" };
    const kept = answers.get(origin);
    if (kept !== undefined && now() - kept.at < ttlMs) return kept.answer;
    const answer = await probe(origin);
    // An unreachable Application is asked again next time.
    if (answer.admits || answer.reason !== "unreachable")
      answers.set(origin, { at: now(), answer });
    return answer;
  };
}
