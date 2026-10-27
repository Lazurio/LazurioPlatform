import type {
  BuddyPersonaShown,
  PersonaSave,
  PersonaSaveAnswer,
} from "../buddy/persona-save";
import { type BuddySignIn, isBuddySignInHandle } from "../buddy/sign-in";
import {
  type BuddyFacts,
  type BuddyStatus,
  buddyStatus,
} from "../buddy/status";
import {
  type BuddyTelegram,
  isTelegramRequestHandle,
  type TelegramAnswer,
  type TelegramStatus,
} from "../buddy/telegram";
import type { FolderProfile } from "../folder/profile";
import { stateFields } from "../folder/state-fields";
import { buddyRoutePaths } from "./buddy-paths";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Buddy in the Launchpad (decision F63): his state, and his ChatGPT sign-in
// through his own Hermes gateway, over the one core `lazurio buddy` uses
// (src/buddy/sign-in.ts, src/buddy/status.ts), behind the admission of every
// `/api/*` route: the gateway's session revalidated and, for every POST, the
// hosted same-origin rule (Sec-Fetch-Site and Origin, hosted-trust.ts), the
// poll included, since it changes what this process holds. Only where the
// recorded entry names Buddy's origin (`buddyOrigin`, a personal VM, decision
// F60); elsewhere every route answers 404 `buddy-absent`.
//
//   GET  /api/buddy                 {kind: "buddy", state, reason?,
//                                   signIn: {state}, locale}
//   POST /api/buddy/sign-in/start   {} → pending {session, code, url,
//                                   expiresAt, pollMs} | failed {reason}
//   POST /api/buddy/sign-in/poll    {session} → pending | signed-in |
//                                   failed {reason} | none
//   POST /api/buddy/sign-in/cancel  {session} → cancelled | none
//   POST /api/buddy/sign-out        {} → signed-out | failed
//   POST /api/buddy/persona         {buddyName, address, user: {nominative,
//                                   accusative, dative}, revision, confirm?}
//                                   → persona {outcome, persona, applied}
//
// `GET /api/buddy` also names his persona (decision F65): his name, how he
// addresses the person, the person's name in three cases, whether the person
// confirmed them, the revision a change must name, and whether a change is
// still on its way to his running conversations (`pending`); null where
// there is none the installer would take. A change is written only while the
// persona's file is still at `revision` (null: there was none), else 409
// `persona-changed` with the persona as it is now; a member the installer
// would refuse is 400 `invalid-<member>` (`invalid-buddy-name`,
// `invalid-user-dative`, ...), `invalid-revision` or `invalid-confirm`; 409
// `persona-busy` or `persona-unsafe` write nothing either. Then F64's apply
// brings it to Buddy, as `lazurio buddy persona --apply` does: `applied` is
// what it did within a moment (`waiting` while Buddy is busy, which the
// Launchpad finishes once he is idle).
// A start where Buddy's Hermes does not advertise its OAuth cancellation
// contract (Lazurio/hermes-agent#17) starts nothing: 409 `blocked`
// `hermes-outdated` (Buddy needs an update before he can be signed in here).
// A start, a cancel and a sign-out that need a held sign-in to end change
// nothing while it may still complete: 409 `blocked` with `sign-in-running`
// (Hermes did not confirm the cancel) or `hermes-outdated` (a Hermes without
// the contract no longer holds it); without Buddy's gateway 503
// `buddy-unavailable` with its reason. Status and a sign-out without a held
// sign-in need no contract.
// Each POST takes exactly its fields, as JSON of at most 16 KiB (413),
// only as `application/json` (415); another method is 405 and any query 400.
// The code and the page go only to the holder of the session's handle. The
// core journals each operation, its outcome and its reason, never a code, a
// handle, a ticket or Hermes's session, and never a name or a revision of the
// persona.
//
// Telegram (decision F66), behind the same admission and rules:
//
//   POST /api/buddy/telegram/connect     {token} → telegram {state, …} |
//                                        400 invalid-token | failed {reason}
//   POST /api/buddy/telegram/approve     {request} → telegram {state, …} |
//                                        409 blocked request-gone
//   POST /api/buddy/telegram/disconnect  {} → telegram {state, …}
//
// and `GET /api/buddy` names `telegram: {state, reason?, bot?, botQr?,
// requests?, pending?}`, read live from Hermes. The token is a string of
// the request's body for the one connect; it is never journaled, written
// or answered, and Telegram's and Hermes's own words never leave the core.
// Without Buddy's gateway these answer 503 `buddy-unavailable`.

export { buddyRoutePaths };

export type BuddyLocale = FolderProfile["locale"];

/** What `GET /api/buddy` and `lazurio buddy status` answer. */
export type BuddyAnswer = BuddyStatus &
  Readonly<{ kind: "buddy"; locale: BuddyLocale }>;

export const buddyAnswer = (
  status: BuddyStatus,
  locale: BuddyLocale,
): BuddyAnswer => Object.freeze({ kind: "buddy", ...status, locale });

/** What `GET /api/buddy` answers: his state, his persona (F65) and his
 * Telegram (F66). */
export type BuddyReading = BuddyAnswer &
  Readonly<{ persona: BuddyPersonaShown | null; telegram: TelegramStatus }>;

const postFields: Readonly<Record<string, readonly string[]>> = {
  [buddyRoutePaths.start]: [],
  [buddyRoutePaths.poll]: ["session"],
  [buddyRoutePaths.cancel]: ["session"],
  [buddyRoutePaths.signOut]: [],
  [buddyRoutePaths.persona]: ["buddyName", "address", "user", "revision"],
  [buddyRoutePaths.telegramConnect]: ["token"],
  [buddyRoutePaths.telegramApprove]: ["request"],
  [buddyRoutePaths.telegramDisconnect]: [],
};

/** A Telegram answer and its status: 400 for a token of no bot's shape,
 * 409 for a request no longer there, 503 without Buddy's gateway. */
function telegramResponse(answer: TelegramAnswer): Readonly<{
  status: number;
  body: unknown;
}> {
  if (answer.kind === "invalid")
    return { status: 400, body: { error: answer.reason } };
  if (answer.kind === "unavailable")
    return {
      status: 503,
      body: { error: "buddy-unavailable", reason: answer.reason },
    };
  return { status: answer.kind === "blocked" ? 409 : 200, body: answer };
}

/** A persona's revision: the sha256 of its file, as F64 names it. */
const revisionShape = /^[0-9a-f]{64}$/;

type PersonaRequest =
  | Readonly<{
      update: Parameters<PersonaSave["save"]>[0];
      revision: string | null;
    }>
  | Readonly<{ error: string }>;

/** The persona's change from its fields: each name a string (its rules are
 * the installer's, in the core), the user's three cases exactly, the
 * revision the page read and `confirm` a boolean where it is sent. */
function personaRequest(value: Record<string, unknown>): PersonaRequest {
  const { buddyName, address, revision, confirm } = value;
  if (
    !(
      revision === null ||
      (typeof revision === "string" && revisionShape.test(revision))
    )
  )
    return { error: "invalid-revision" };
  if (confirm !== undefined && typeof confirm !== "boolean")
    return { error: "invalid-confirm" };
  if (typeof buddyName !== "string") return { error: "invalid-buddy-name" };
  if (typeof address !== "string") return { error: "invalid-address" };
  let user: Record<string, unknown>;
  try {
    user = stateFields(value.user, ["nominative", "accusative", "dative"]);
  } catch {
    return { error: "invalid-user" };
  }
  for (const name of ["nominative", "accusative", "dative"] as const)
    if (typeof user[name] !== "string")
      return { error: `invalid-user-${name}` };
  return {
    update: {
      buddyName,
      address,
      user: {
        nominative: user.nominative as string,
        accusative: user.accusative as string,
        dative: user.dative as string,
      },
      ...(confirm === true ? { confirm: true } : {}),
    },
    revision,
  };
}

/** A change's answer and its status: 400 for a refused member, 409 for
 * nothing written. */
const personaStatus = (answer: PersonaSaveAnswer): number =>
  answer.kind === "persona" ? 200 : answer.kind === "invalid" ? 400 : 409;

export function createBuddyRoutes(
  input: Readonly<{
    /** Whether the recorded entry names Buddy's origin. */
    present: () => boolean;
    signIn: BuddySignIn;
    facts: () => Promise<BuddyFacts>;
    /** His persona: read and changed (F65, `persona-save.ts`). */
    persona: Pick<PersonaSave, "read" | "save">;
    /** His Telegram: read and changed through Hermes (F66). */
    telegram: Pick<
      BuddyTelegram,
      "read" | "connect" | "approve" | "disconnect"
    >;
    /** The Folder's profile locale. */
    locale: () => Promise<BuddyLocale>;
    headers: Readonly<Record<string, string>>;
    /** His step changed: a sign-in finished, he was signed out, or his
     * names were written. The shell document's `setup` is read anew, so his
     * bubble in Chat and Automate follows (decision F60's addendum of
     * 2026-10-26). */
    changed?: (() => void) | undefined;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  return Object.freeze({
    handles: (path: string) =>
      path === buddyRoutePaths.read || Object.hasOwn(postFields, path),
    async handle(
      request: Request,
      url: URL,
      timeout: (seconds: number) => void,
    ): Promise<Response> {
      if (!input.present()) return response({ error: "buddy-absent" }, 404);
      if ([...url.searchParams.keys()].length > 0)
        return response({ error: "invalid-query" }, 400);
      // The socket and the API, a ticket and one replaced ticket: within a
      // minute.
      timeout(60);
      if (url.pathname === buddyRoutePaths.read) {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        const [facts, locale, persona, telegram] = await Promise.all([
          input.facts(),
          input.locale(),
          input.persona.read(),
          input.telegram.read(),
        ]);
        const reading: BuddyReading = Object.freeze({
          ...buddyAnswer(buddyStatus(facts), locale),
          persona,
          telegram,
        });
        return response(reading);
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      let value: Record<string, unknown>;
      try {
        const body = await readJsonBody(request);
        const fields = postFields[url.pathname] ?? [];
        // `confirm` is the persona's one optional field.
        value = stateFields(
          body,
          url.pathname === buddyRoutePaths.persona &&
            body !== null &&
            typeof body === "object" &&
            Object.hasOwn(body, "confirm")
            ? [...fields, "confirm"]
            : fields,
        );
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return response({ error: "body-too-large" }, 413);
        return response({ error: "invalid-request" }, 400);
      }
      if (url.pathname === buddyRoutePaths.telegramConnect) {
        // The token goes to the core as it came, for its one connect.
        const { token } = value;
        if (typeof token !== "string" || token.length > 256)
          return response({ error: "invalid-token" }, 400);
        const { status, body } = telegramResponse(
          await input.telegram.connect(token.trim()),
        );
        return response(body, status);
      }
      if (url.pathname === buddyRoutePaths.telegramApprove) {
        if (!isTelegramRequestHandle(value.request))
          return response({ error: "invalid-request" }, 400);
        const { status, body } = telegramResponse(
          await input.telegram.approve(value.request),
        );
        return response(body, status);
      }
      if (url.pathname === buddyRoutePaths.telegramDisconnect) {
        const { status, body } = telegramResponse(
          await input.telegram.disconnect(),
        );
        return response(body, status);
      }
      if (url.pathname === buddyRoutePaths.persona) {
        const asked = personaRequest(value);
        if ("error" in asked) return response({ error: asked.error }, 400);
        const answer = await input.persona.save(asked.update, asked.revision);
        if (answer.kind === "persona" && answer.outcome === "written")
          input.changed?.();
        return answer.kind === "invalid"
          ? response({ error: answer.reason }, 400)
          : response(answer, personaStatus(answer));
      }
      const signIn = input.signIn;
      const answered = (
        answer: Readonly<{ kind: string; reason?: string }>,
      ) => {
        if (answer.kind === "signed-in" || answer.kind === "signed-out")
          input.changed?.();
        return answer.kind === "unavailable"
          ? response({ error: "buddy-unavailable", reason: answer.reason }, 503)
          : response(answer, answer.kind === "blocked" ? 409 : 200);
      };
      if (url.pathname === buddyRoutePaths.start)
        return answered(await signIn.start());
      if (url.pathname === buddyRoutePaths.signOut)
        return answered(await signIn.signOut());
      if (!isBuddySignInHandle(value.session))
        return response({ error: "invalid-session" }, 400);
      return answered(
        url.pathname === buddyRoutePaths.poll
          ? await signIn.poll(value.session)
          : await signIn.cancel(value.session),
      );
    },
  });
}
