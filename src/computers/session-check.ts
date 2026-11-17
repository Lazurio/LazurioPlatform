import type { AttachIdentity, GatewayProof } from "./attach-ws";
import { computerIdPattern } from "./state";

// The Launchpad's side of a computer's session on contract v3 (Agent
// Desktop's channel, variant B; HumanAndMachine-ai/Auth
// docs/device-channel-entry.md, "The Launchpad"). The Environment's gateway
// admitted the computer from an approved device of the Assigned User and its
// helper redeemed the one-time hand-over at Lazurio Auth; with the upgraded
// connection it passes one header of its own, the session proof. The
// Launchpad trusts no forwarded identity (decision F16), so it checks the
// proof itself, server to server, at the helper's check endpoint, whose
// address comes from the Machine's binding and never from a request:
//
//   GET <checkUrl>  X-Lazurio-Computer-Session: <proof>
//   200 {"subject": "<uuid>", "deviceId": "<id>", "expiresIn": <0..300>}
//       a confirmation, when the subject is the Assigned User, the device id
//       fits `computerIdPattern` and `expiresIn` is from 1 to 300
//   anything else: not confirmed; 5xx, a timeout or no answer: unavailable
//
// `expiresIn` is the seconds until the helper's current token expires, so it
// is the session's deadline here. The Launchpad checks again at least every
// 60 seconds and before that deadline; anything but a confirmation of the
// same person ends the session.

/** The header the gateway sets, and the only one read from the request. */
export const computerSessionHeader = "x-lazurio-computer-session";

/** A proof is 32 random bytes in base64url. */
const proofPattern = /^[A-Za-z0-9_-]{43}$/;
/** A Lazurio Auth subject, as the gateway names it: a lowercase UUID. */
const subjectPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxExpiresIn = 300;
const maxBodyBytes = 4096;

export type ComputerSessionCheckOptions = Readonly<{
  /** The helper's check endpoint, from the Machine's binding. */
  checkUrl: string;
  /** The Environment's Assigned User, the subject a proof must name. */
  assignedSubject: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  now?: () => number;
}>;

/** What the helper answered about one proof. */
export type CheckAnswer =
  | Readonly<{
      kind: "confirmed";
      subject: string;
      deviceId: string;
      expiresIn: number;
    }>
  | Readonly<{ kind: "unconfirmed" }>
  | Readonly<{ kind: "unavailable" }>;

/** Reads the helper's answer by the rules above, never trusting more. */
export function readCheckAnswer(
  status: number,
  body: unknown,
  assignedSubject: string,
): CheckAnswer {
  if (status >= 500) return { kind: "unavailable" };
  if (status !== 200) return { kind: "unconfirmed" };
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { kind: "unconfirmed" };
  const { subject, deviceId, expiresIn } = body as Record<string, unknown>;
  if (
    typeof subject !== "string" ||
    !subjectPattern.test(subject) ||
    subject !== assignedSubject ||
    typeof deviceId !== "string" ||
    !computerIdPattern.test(deviceId) ||
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > maxExpiresIn
  )
    return { kind: "unconfirmed" };
  return { kind: "confirmed", subject, deviceId, expiresIn };
}

/** Checks session proofs at the helper. `verifyGatewayProof` is the
 * attach route's admission on contract v3 (`AttachHost`). */
export function createComputerSessionCheck(
  options: ComputerSessionCheckOptions,
) {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const now = options.now ?? Date.now;
  if (!subjectPattern.test(options.assignedSubject))
    throw new Error("Invalid assigned subject");

  async function check(proof: string): Promise<CheckAnswer> {
    let response: Response;
    try {
      response = await fetcher(options.checkUrl, {
        method: "GET",
        headers: { [computerSessionHeader]: proof },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: "unavailable" };
    }
    let body: unknown = null;
    if (response.status === 200) {
      try {
        const text = await response.text();
        body = text.length > maxBodyBytes ? null : JSON.parse(text);
      } catch {
        body = null;
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    return readCheckAnswer(response.status, body, options.assignedSubject);
  }

  /** The session of one confirmed proof: its deadline moves with every
   * confirmation of the same person and device, anything else ends it. */
  function identityOf(
    proof: string,
    first: Extract<CheckAnswer, { kind: "confirmed" }>,
  ): AttachIdentity {
    let deadline = now() + first.expiresIn * 1000;
    return {
      device: first.deviceId,
      name: first.deviceId,
      deadline: () => deadline,
      stillAllowed: async () => {
        if (now() >= deadline) return false;
        const answer = await check(proof);
        if (
          answer.kind !== "confirmed" ||
          answer.subject !== first.subject ||
          answer.deviceId !== first.deviceId
        )
          return false;
        deadline = now() + answer.expiresIn * 1000;
        return true;
      },
    };
  }

  return Object.freeze({
    check,
    async verifyGatewayProof(request: Request): Promise<GatewayProof> {
      const proof = request.headers.get(computerSessionHeader);
      if (proof === null || !proofPattern.test(proof))
        return { ok: false, status: 401, reason: "no-proof" };
      const answer = await check(proof);
      // The attach route answers 503 when the check throws.
      if (answer.kind === "unavailable")
        throw new Error("The helper's check could not be made");
      if (answer.kind === "unconfirmed")
        return { ok: false, status: 403, reason: "proof-not-confirmed" };
      return { ok: true, identity: identityOf(proof, answer) };
    },
  });
}
