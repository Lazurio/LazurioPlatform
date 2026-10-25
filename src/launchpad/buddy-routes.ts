import { type BuddySignIn, isBuddySignInHandle } from "../buddy/sign-in";
import {
  type BuddyFacts,
  type BuddyStatus,
  buddyStatus,
} from "../buddy/status";
import type { FolderProfile } from "../folder/profile";
import { stateFields } from "../folder/state-fields";
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
//
// A start, a cancel and a sign-out that need a held sign-in to end change
// nothing while it may still complete: 409 `blocked` with `sign-in-finishing`
// (Hermes no longer holds it, and its worker's last round may still save; try
// again in a few minutes) or `sign-in-running` (Hermes did not confirm the
// cancel); without Buddy's gateway 503 `buddy-unavailable` with its reason.
// Each POST takes exactly its fields, as JSON of at most 16 KiB (413),
// only as `application/json` (415); another method is 405 and any query 400.
// The code and the page go only to the holder of the session's handle. The
// core journals each operation, its outcome and its reason, never a code, a
// handle, a ticket or Hermes's session.

export const buddyRoutePaths = Object.freeze({
  read: "/api/buddy",
  start: "/api/buddy/sign-in/start",
  poll: "/api/buddy/sign-in/poll",
  cancel: "/api/buddy/sign-in/cancel",
  signOut: "/api/buddy/sign-out",
});

export type BuddyLocale = FolderProfile["locale"];

/** What `GET /api/buddy` and `lazurio buddy status` answer. */
export type BuddyAnswer = BuddyStatus &
  Readonly<{ kind: "buddy"; locale: BuddyLocale }>;

export const buddyAnswer = (
  status: BuddyStatus,
  locale: BuddyLocale,
): BuddyAnswer => Object.freeze({ kind: "buddy", ...status, locale });

const postFields: Readonly<Record<string, readonly string[]>> = {
  [buddyRoutePaths.start]: [],
  [buddyRoutePaths.poll]: ["session"],
  [buddyRoutePaths.cancel]: ["session"],
  [buddyRoutePaths.signOut]: [],
};

export function createBuddyRoutes(
  input: Readonly<{
    /** Whether the recorded entry names Buddy's origin. */
    present: () => boolean;
    signIn: BuddySignIn;
    facts: () => Promise<BuddyFacts>;
    /** The Folder's profile locale. */
    locale: () => Promise<BuddyLocale>;
    headers: Readonly<Record<string, string>>;
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
        const [facts, locale] = await Promise.all([
          input.facts(),
          input.locale(),
        ]);
        return response(buddyAnswer(buddyStatus(facts), locale));
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      let value: Record<string, unknown>;
      try {
        value = stateFields(
          await readJsonBody(request),
          postFields[url.pathname] ?? [],
        );
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return response({ error: "body-too-large" }, 413);
        return response({ error: "invalid-request" }, 400);
      }
      const signIn = input.signIn;
      const answered = (answer: Readonly<{ kind: string; reason?: string }>) =>
        answer.kind === "unavailable"
          ? response({ error: "buddy-unavailable", reason: answer.reason }, 503)
          : response(answer, answer.kind === "blocked" ? 409 : 200);
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
