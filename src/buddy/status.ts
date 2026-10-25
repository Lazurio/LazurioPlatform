import type { HermesGateway } from "./hermes-gateway";

// Buddy's state (decision F63): a pure function of facts read fresh on every
// question, with nothing stored: whether his gateway runs (`identify`) and
// whether Hermes's own status card for `openai-codex` says he is signed in
// (`GET /api/providers/oauth`, `status.logged_in`). Hermes's auth store is the
// one truth of the sign-in; the Launchpad keeps no copy of it.
//
//   works    the gateway is ready and Buddy is signed in
//   waits    the gateway is ready and Buddy is not signed in
//   unknown  the gateway does not run (reason `not-running`), or a read
//            failed: no claim either way
//
// There is no "needs attention" yet. Hermes's card cannot tell a sign-in
// whose refresh OpenAI refused from a working one or from none
// (Lazurio/hermes-agent#16): the card keeps `logged_in` alone, and a refused
// refresh on the singleton path persists nothing. Until it says so, a refused
// refresh reads as whatever the card says. The card's other members (a token
// preview, the source, the last refresh) are never passed on.

export type BuddyState = "works" | "waits" | "unknown";
export type BuddySignInState = "connected" | "none" | "unknown";

/** What one reading found. */
export type BuddyFacts =
  /** The gateway is ready; `loggedIn` as Hermes's card says it, undefined
   * when the card could not be read. */
  | Readonly<{ runtime: "ready"; loggedIn: boolean | undefined }>
  /** No gateway answers, or it is starting or stopping. */
  | Readonly<{ runtime: "not-running" }>
  /** The gateway could not be asked: an unsafe path, no answer in time, an
   * answer of no known shape, a ticket refused. */
  | Readonly<{ runtime: "unknown" }>;

export type BuddyStatus = Readonly<{
  state: BuddyState;
  reason?: "not-running";
  signIn: Readonly<{ state: BuddySignInState }>;
}>;

export function buddyStatus(facts: BuddyFacts): BuddyStatus {
  if (facts.runtime === "ready" && facts.loggedIn !== undefined)
    return facts.loggedIn
      ? { state: "works", signIn: { state: "connected" } }
      : { state: "waits", signIn: { state: "none" } };
  if (facts.runtime === "not-running")
    return {
      state: "unknown",
      reason: "not-running",
      signIn: { state: "unknown" },
    };
  return { state: "unknown", signIn: { state: "unknown" } };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One reading of the facts through Buddy's gateway. */
export async function readBuddyFacts(
  gateway: HermesGateway,
): Promise<BuddyFacts> {
  const answer = await gateway.request("GET", "/api/providers/oauth");
  if (!answer.ok)
    return ["no-socket", "not-ready", "draining"].includes(answer.reason)
      ? { runtime: "not-running" }
      : { runtime: "unknown" };
  const { status, body } = answer.value;
  const providers =
    status === 200 && isObject(body) && Array.isArray(body.providers)
      ? body.providers
      : [];
  const codex = providers.filter(
    (provider) => isObject(provider) && provider.id === "openai-codex",
  );
  const card = codex.length === 1 ? (codex[0] as Json).status : undefined;
  return {
    runtime: "ready",
    loggedIn:
      isObject(card) && typeof card.logged_in === "boolean"
        ? card.logged_in
        : undefined,
  };
}
