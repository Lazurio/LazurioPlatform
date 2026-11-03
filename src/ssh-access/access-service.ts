import type {
  MachineBinding,
  MachinePeerHostKey,
} from "../folder/machine-binding";
import { isEnvironmentId, isHostname } from "../folder/machine-binding";

// The source side of root decision 0224: the access service on the home
// Conglomerate Host (`lazurio-access-service`, Machines
// `workloads/conglomerate-host/ACCESS-SERVICE.md`) derives every SSH access
// between the Environments of a Conglomerate from facts. A source
// Environment asks it two things, and nothing else:
//
// - `PUT /v1/source-key` registers the public part of its one key
//   (`~/.ssh/lazurio-environment-ed25519`, created inside the Environment);
// - `GET /v1/targets` answers its targets: Environment id, host name,
//   account, pinned host key and `valid_until`.
//
// The service knows the caller by its tailnet source address; there is no
// token. The Platform never derives where the service is from a name: the
// handover has to say it (`accessServiceOf`), and until Machines writes that
// member (HumanAndMachine-ai/Machines#1040) no Environment has one, so
// nothing here runs outside the tests. Every answer is validated whole; one
// that is not exactly the contract's shape counts as no answer (fails
// closed).

/** Where this Environment's home access service answers: `http://`, a
 * tailnet DNS name and a port, from the handover only. */
export type AccessServiceLocation = Readonly<{ origin: string }>;

const originPattern = /^http:\/\/([a-z0-9.-]+):([0-9]{1,5})$/;
export function isAccessServiceOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = originPattern.exec(value);
  if (match === null) return false;
  const port = Number(match[2]);
  return isTailnetName(match[1]) && port >= 1 && port <= 65535;
}

/** The access service of this Environment's home Conglomerate Host, as the
 * handover declares it. No handover member carries it yet
 * (HumanAndMachine-ai/Machines#1040), so this is null for every Machine:
 * the Environment keeps the handover's assigned peers and says that the
 * service is not declared. It never composes an address from a name. */
export function accessServiceOf(
  _machine: MachineBinding | null | undefined,
): AccessServiceLocation | null {
  return null;
}

/** One target of `GET /v1/targets`, checked. */
export type AccessTarget = Readonly<{
  environment: string;
  host: string;
  user: string;
  hostKeys: readonly MachinePeerHostKey[];
  /** RFC 3339 UTC, whole seconds: the edge ends then. */
  validUntil: string;
}>;

export type TargetsAnswer =
  | Readonly<{ kind: "answered"; targets: readonly AccessTarget[] }>
  /** The service does not know this Environment (403). */
  | Readonly<{ kind: "not-recognized" }>
  /** It answered that it cannot answer now (503). */
  | Readonly<{ kind: "unavailable" }>
  /** No answer: no route, refused connection, timeout. */
  | Readonly<{ kind: "unreachable" }>
  /** An answer that is not the contract's: another status or shape. */
  | Readonly<{ kind: "malformed" }>;

export type RegistrationAnswer =
  | Readonly<{ kind: "registered"; changed: boolean }>
  /** 409: a station key, a host admin key, or another source's key. */
  | Readonly<{
      kind: "refused";
      reason: "source-key-forbidden" | "source-key-taken";
    }>
  | Readonly<{ kind: "not-recognized" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "unreachable" }>
  | Readonly<{ kind: "malformed" }>;

export type AccessServiceFetch = (
  url: string,
  init: Readonly<{
    method: "GET" | "PUT";
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: "error";
  }>,
) => Promise<Response>;

export const accessServiceTimeoutMs = 10_000;
const maxAnswerBytes = 1024 * 1024;
const maxTargets = 1024;
const targetsSchema = "machines.access-targets.v1";
const receiptSchema = "machines.access-source-key-receipt.v1";

const account = /^[a-z_][a-z0-9_-]{0,31}$/;
const utcSecond = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
// One ed25519 public key as OpenSSH writes it: the type, then the blob of
// the type string and 32 key bytes, which always starts the same way.
const ed25519Line =
  /^ssh-ed25519 (AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43})$/;

// A tailnet DNS name, never an address literal: its last label is no
// number (the service renders `<node>.<MagicDNS domain>`).
const isTailnetName = (value: unknown): value is string =>
  isHostname(value) && /[a-z]/.test(value.slice(value.lastIndexOf(".") + 1));

/** The instant of an RFC 3339 UTC second, or null for anything else. */
export function utcInstant(value: unknown): number | null {
  if (typeof value !== "string" || !utcSecond.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) &&
    new Date(instant).toISOString() === `${value.slice(0, -1)}.000Z`
    ? instant
    : null;
}

/** The blob of exactly one `ssh-ed25519 <blob>` line, else null. */
export function ed25519Blob(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const blob = ed25519Line.exec(value)?.[1];
  if (blob === undefined) return null;
  // The blob decodes to the type string and exactly 32 key bytes.
  const bytes = Buffer.from(blob, "base64");
  return bytes.length === 51 && bytes.toString("base64") === blob ? blob : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** The targets of one answer of `GET /v1/targets` at `now`: the whole
 * answer exactly as the contract shapes it, each Environment id once, or
 * null. A target whose `valid_until` has passed is dropped, never kept. */
export function parseTargets(
  document: unknown,
  now: number,
): readonly AccessTarget[] | null {
  if (
    !isRecord(document) ||
    !hasExactly(document, ["schema_version", "targets"]) ||
    document.schema_version !== targetsSchema ||
    !Array.isArray(document.targets) ||
    document.targets.length > maxTargets
  )
    return null;
  const seen = new Set<string>();
  const targets: AccessTarget[] = [];
  for (const item of document.targets as unknown[]) {
    if (
      !isRecord(item) ||
      !hasExactly(item, [
        "environment",
        "host",
        "user",
        "host_key",
        "valid_until",
      ]) ||
      !isEnvironmentId(item.environment) ||
      !isTailnetName(item.host) ||
      typeof item.user !== "string" ||
      !account.test(item.user) ||
      seen.has(item.environment)
    )
      return null;
    const blob = ed25519Blob(item.host_key);
    const until = utcInstant(item.valid_until);
    if (blob === null || until === null) return null;
    seen.add(item.environment);
    if (until <= now) continue;
    targets.push(
      Object.freeze({
        environment: item.environment,
        host: item.host,
        user: item.user,
        hostKeys: Object.freeze([
          Object.freeze({ type: "ssh-ed25519" as const, key: blob }),
        ]),
        validUntil: item.valid_until as string,
      }),
    );
  }
  return Object.freeze(targets);
}

// The body of an answer, read chunk by chunk and never past `limit` bytes:
// past it the stream is cancelled at once and the answer is null, so an
// oversized or endless answer costs at most the limit (and the request's
// time bound), never the whole stream.
async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const stream = response.body;
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type Exchange =
  | Readonly<{ kind: "unreachable" }>
  | Readonly<{ kind: "answer"; status: number; body: unknown }>;

// One request with a bound in time and size; no redirect is followed and
// nothing of the answer is echoed anywhere.
async function exchange(
  location: AccessServiceLocation,
  path: string,
  init: Readonly<{ method: "GET" | "PUT"; body?: string }>,
  fetchImpl: AccessServiceFetch,
): Promise<Exchange> {
  if (!isAccessServiceOrigin(location.origin)) return { kind: "unreachable" };
  let response: Response;
  try {
    response = await fetchImpl(`${location.origin}${path}`, {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: init.body,
          }),
      signal: AbortSignal.timeout(accessServiceTimeoutMs),
      redirect: "error",
    });
  } catch {
    return { kind: "unreachable" };
  }
  let text: string;
  try {
    const bytes = await readBounded(response, maxAnswerBytes);
    if (bytes === null)
      return { kind: "answer", status: response.status, body: undefined };
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "unreachable" };
  }
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { kind: "answer", status: response.status, body };
}

/** `GET /v1/targets` for this Environment. */
export async function askTargets(
  location: AccessServiceLocation,
  now: () => number,
  fetchImpl: AccessServiceFetch = fetch,
): Promise<TargetsAnswer> {
  const answer = await exchange(
    location,
    "/v1/targets",
    { method: "GET" },
    fetchImpl,
  );
  if (answer.kind === "unreachable") return answer;
  if (answer.status === 403) return { kind: "not-recognized" };
  if (answer.status === 503) return { kind: "unavailable" };
  if (answer.status !== 200) return { kind: "malformed" };
  const targets = parseTargets(answer.body, now());
  return targets === null
    ? { kind: "malformed" }
    : { kind: "answered", targets };
}

/** `PUT /v1/source-key` with this Environment's public key line
 * (`ssh-ed25519 <blob>`, without a comment). */
export async function registerSourceKey(
  location: AccessServiceLocation,
  publicKey: string,
  fetchImpl: AccessServiceFetch = fetch,
): Promise<RegistrationAnswer> {
  if (ed25519Blob(publicKey) === null) return { kind: "malformed" };
  const answer = await exchange(
    location,
    "/v1/source-key",
    { method: "PUT", body: JSON.stringify({ ssh_public_key: publicKey }) },
    fetchImpl,
  );
  if (answer.kind === "unreachable") return answer;
  const body = answer.body;
  if (answer.status === 200)
    return isRecord(body) &&
      hasExactly(body, ["schema_version", "changed"]) &&
      body.schema_version === receiptSchema &&
      typeof body.changed === "boolean"
      ? { kind: "registered", changed: body.changed }
      : { kind: "malformed" };
  if (answer.status === 409) {
    const reason = isRecord(body) ? body.error : undefined;
    return reason === "source-key-forbidden" || reason === "source-key-taken"
      ? { kind: "refused", reason }
      : { kind: "malformed" };
  }
  if (answer.status === 403) return { kind: "not-recognized" };
  if (answer.status === 503) return { kind: "unavailable" };
  return { kind: "malformed" };
}
