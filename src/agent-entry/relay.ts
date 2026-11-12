import { errorCode } from "../organization-settings/contract";
import type {
  RelayExchange,
  RelayTransport,
} from "../organization-settings/relay";
import {
  type AccountSharedApplication,
  isAccountApplicationOrigin,
  parseAccountSharedApplications,
} from "../shell/contract";

// The Folder's side of an agent's entry into a colleague's application
// (Lazurio Auth docs/agent-application-entry.md, "The Environment browser
// and the Folder"; plan LZD-0009 M9). Both calls go through the
// Environment's relay (src/organization-settings/relay.ts, Machines step 2
// of the contract), which attaches the Environment's own identity token
// for exactly that path; neither the Folder nor any agent holds one:
//
//   GET  /shared-applications     the Dashboard's list for this Environment
//   POST /agent-entry/hand-over   Lazurio Auth's one-time hand-over
//
// The list is for finding an application; Auth decides every hand-over and
// the hosting gateway every request. One attempt each, bounded in time and
// size: an agent asks again, and a lost hand-over expires by itself.

export const agentEntryRelayPaths = Object.freeze({
  shared: "/shared-applications",
  handOver: "/agent-entry/hand-over",
});

/** The Dashboard's answer of `GET /api/environment/v1/shared-applications`. */
export const environmentSharedApplicationsSchema =
  "lazurio.environment-shared-applications.v1";

/** The relay's own wait: past its deadlines upstream, as for the settings. */
const timeoutMs = 20_000;
/** At most 64 applications of at most a few hundred bytes each. */
const answerBytesMax = 64 * 1024;

/** The Dashboard verifier's refusals of the list read, in its order
 * ("The shared-applications read", checks 1 to 6). */
export const sharedReadRefusals = [
  "bearer_missing",
  "token_expired",
  "token_invalid",
  "scope_not_allowed_here",
  "insufficient_scope",
  "environment_unknown",
] as const;

/** Lazurio Auth's refusals of `hand-over` ("The route", checks 1 to 12, and
 * the route's own `503`). */
export const handOverRefusals = [
  "invalid_request",
  "unauthorized",
  "not_found",
  "agent_entry_identity_absent",
  "environment_state_conflict",
  "assignment_generation_conflict",
  "agent_entry_off",
  "agent_entry_own_environment",
  "agent_entry_other_organization",
  "agent_entry_not_member",
  "application_record_inconsistent",
  "agent_entry_no_role",
  "management_temporarily_unavailable",
] as const;

/** What the relay says about itself (Machines; DEV-6653 contract C3): it
 * has no token for this Environment yet. */
export const relayIdentityRefusal = "environment_identity_unavailable";

/** The Folder's own names for an answer that is no answer of the contract:
 * the relay did not answer (`relay-unreachable`), it has no such path yet
 * (`relay-unsupported`, before Machines step 2), or what came is not the
 * contract's (`relay-answer-invalid`); and a code of either upstream this
 * version does not know (`refused`). */
export type RelayRefusalReason =
  | (typeof sharedReadRefusals)[number]
  | (typeof handOverRefusals)[number]
  | typeof relayIdentityRefusal
  | "relay-unreachable"
  | "relay-unsupported"
  | "relay-answer-invalid"
  | "refused";

export type RelayRefusal = Readonly<{
  kind: "refused";
  reason: RelayRefusalReason;
  /** A short code for the details, never shown raw to people: the
   * transport's failure, the status or an unknown upstream code. */
  detail: string | null;
}>;

export type SharedApplicationsRead =
  | Readonly<{
      kind: "listed";
      /** The Assigned User's switch for this Environment; switched off, the
       * list is empty. */
      agentEntry: "on" | "off";
      sharedApplications: readonly AccountSharedApplication[];
    }>
  | RelayRefusal;

export type HandOver =
  | Readonly<{
      kind: "handed-over";
      /** Auth's answer exactly, to be opened unchanged. */
      url: string;
      expiresIn: number;
    }>
  | RelayRefusal;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refused = (
  reason: RelayRefusalReason,
  detail: string | null,
): RelayRefusal => Object.freeze({ kind: "refused", reason, detail });

/** A refusal by the upstream's code where this operation knows it, else by
 * what the relay says about itself; never a guess from the status alone
 * when a code is there. */
function refusalOf(
  answer: RelayExchange,
  known: readonly string[],
): RelayRefusal {
  if (answer.kind === "failed")
    return answer.reason === "too-large"
      ? refused("relay-answer-invalid", answer.reason)
      : refused("relay-unreachable", answer.reason);
  const code = errorCode(parseJson(answer.text));
  if (code !== null && known.includes(code))
    return refused(code as RelayRefusalReason, `status-${answer.status}`);
  if (code === relayIdentityRefusal)
    return refused(relayIdentityRefusal, `status-${answer.status}`);
  if (code === null && [502, 503, 504].includes(answer.status))
    return refused("relay-unreachable", `status-${answer.status}`);
  // A relay without the path answers its own 404, without the upstream's
  // `{"error": …}`.
  if (code === null && answer.status === 404)
    return refused("relay-unsupported", "status-404");
  if (answer.status >= 200 && answer.status < 400)
    return refused("relay-answer-invalid", `status-${answer.status}`);
  return refused("refused", code ?? `status-${answer.status}`);
}

const environmentClientId = /^environment-[a-z0-9][a-z0-9-]{0,100}$/;

/** The Dashboard's list for this Environment, in its exact shape: the
 * schema, the Environment's entry client, its switch, and every entry as
 * the account's `AccountSharedApplication` (`parseAccountSharedApplications`,
 * the one reader of the list). Anything else is no list. */
export function parseSharedApplicationsAnswer(
  input: unknown,
): Extract<SharedApplicationsRead, { kind: "listed" }> | null {
  if (
    !isRecord(input) ||
    input.schema !== environmentSharedApplicationsSchema ||
    typeof input.environment !== "string" ||
    !environmentClientId.test(input.environment) ||
    (input.agentEntry !== "on" && input.agentEntry !== "off") ||
    !Array.isArray(input.sharedApplications)
  )
    return null;
  const sharedApplications = parseAccountSharedApplications(
    input.sharedApplications,
    null,
  );
  if (sharedApplications === false || sharedApplications === undefined)
    return null;
  return Object.freeze({
    kind: "listed",
    agentEntry: input.agentEntry,
    sharedApplications,
  });
}

/** 32 random bytes, base64url without padding. */
const handOverValue = /^[A-Za-z0-9_-]{43}$/;

/** Auth's hand-over address for `origin`, exactly
 * `<origin>/.lazurio/agent-entry?hand_over=<value>`, and nothing else: no
 * other host, path or parameter. The string is returned as given, so what
 * is opened is what Auth answered. */
export function handOverUrlFor(origin: string, value: unknown): string | null {
  if (typeof value !== "string" || !isAccountApplicationOrigin(origin))
    return null;
  const prefix = `${origin}/.lazurio/agent-entry?hand_over=`;
  return value.startsWith(prefix) &&
    handOverValue.test(value.slice(prefix.length))
    ? value
    : null;
}

export type AgentEntryRelay = Readonly<{
  /** The applications colleagues share with this Environment's person. */
  sharedApplications(): Promise<SharedApplicationsRead>;
  /** A one-time hand-over for the application at `origin` (an entry's
   * `url`), with the generation this Environment bound (null on a `v2`
   * Work Environment). */
  handOver(origin: string, generation: number | null): Promise<HandOver>;
}>;

export function createAgentEntryRelay(
  transport: RelayTransport,
): AgentEntryRelay {
  return Object.freeze({
    async sharedApplications() {
      const answer = await transport({
        method: "GET",
        path: agentEntryRelayPaths.shared,
        headers: { accept: "application/json" },
        body: null,
        timeoutMs,
        maxBytes: answerBytesMax,
      });
      if (answer.kind === "answer" && answer.status === 200) {
        const listed = parseSharedApplicationsAnswer(parseJson(answer.text));
        return listed ?? refused("relay-answer-invalid", "answer-invalid");
      }
      return refusalOf(answer, sharedReadRefusals);
    },
    async handOver(origin, generation) {
      const answer = await transport({
        method: "POST",
        path: agentEntryRelayPaths.handOver,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ origin, generation }),
        timeoutMs,
        maxBytes: answerBytesMax,
      });
      // Only Auth's 200 hands over; a redirect is never followed and any
      // other success is no hand-over.
      if (answer.kind === "answer" && answer.status === 200) {
        const body = parseJson(answer.text);
        const url = isRecord(body) ? handOverUrlFor(origin, body.url) : null;
        const expiresIn = isRecord(body) ? body.expiresIn : undefined;
        if (
          url === null ||
          typeof expiresIn !== "number" ||
          !Number.isInteger(expiresIn) ||
          expiresIn < 1 ||
          expiresIn > 60
        )
          return refused("relay-answer-invalid", "answer-invalid");
        return Object.freeze({ kind: "handed-over", url, expiresIn });
      }
      return refusalOf(answer, handOverRefusals);
    },
  });
}
