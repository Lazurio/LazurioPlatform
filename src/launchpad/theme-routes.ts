import { stateFields } from "../folder/state-fields";
import {
  environmentThemeChoice,
  environmentThemeChoices,
  isEnvironmentThemeId,
} from "../theme/palettes";
import type { EnvironmentThemeRecord, ThemeStore } from "../theme/record";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Settings → Obecné → Vzhled (root decision 0208, F36's addendum of
// 2026-10-18): the Environment's theme record over the one store the CLI's
// `lazurio theme` uses (src/theme/record.ts), behind the admission of every
// `/api/*` route (the local token and same origin, or the gateway's session
// and same origin for a write).
//
//   GET  /api/theme      the record and every theme it may take, with the
//                        values the apps get (`choices`); on every
//                        Environment, a public one included
//   POST /api/theme/set  {theme, revision}, both required: the theme, only
//                        while the record is still at `revision` (409
//                        `theme-changed` with the current record otherwise;
//                        409 `theme-busy` while another change holds it);
//                        the theme it has is `unchanged`. On a public
//                        Environment 403 `public-environment`, whatever is
//                        asked: its visitors share the one record (root
//                        decision 0208 point 6, decision F55), so none of
//                        them changes it for the others. A guardrail of the
//                        Launchpad's own interfaces, not a security boundary:
//                        the Environment is that (root decision 0172).
//
// The journal names the operation, the outcome, the theme and the revision.

export const themeRoutePaths = Object.freeze({
  read: "/api/theme",
  set: "/api/theme/set",
});

/** What both routes answer for a record. */
export function themeAnswer(record: EnvironmentThemeRecord) {
  return {
    kind: "theme" as const,
    theme: record.theme,
    label: environmentThemeChoice(record.theme).label,
    revision: record.revision,
    setAt: record.setAt,
    choices: environmentThemeChoices,
  };
}

export function createThemeRoutes(
  input: Readonly<{
    store: ThemeStore;
    headers: Readonly<Record<string, string>>;
    /** Whether the theme is fixed here: a public Environment's (decision
     * F55, `isPublicEnvironment` of the recorded entry). */
    fixed: () => boolean;
    journal?: (entry: Readonly<Record<string, string | number>>) => void;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const journal = (entry: Readonly<Record<string, string | number>>) =>
    input.journal?.({ scope: "environment-theme", operation: "set", ...entry });
  return Object.freeze({
    handles: (path: string) =>
      path === themeRoutePaths.read || path === themeRoutePaths.set,
    async handle(request: Request, url: URL): Promise<Response> {
      if ([...url.searchParams.keys()].length > 0)
        return response({ error: "invalid-query" }, 400);
      if (url.pathname === themeRoutePaths.read) {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        return response(themeAnswer(await input.store.read()));
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      // Before the body is read: nothing asked changes a fixed theme.
      if (input.fixed()) {
        journal({ outcome: "refused", reason: "public-environment" });
        return response({ kind: "blocked", reason: "public-environment" }, 403);
      }
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      let value: Record<string, unknown>;
      try {
        value = stateFields(await readJsonBody(request), ["theme", "revision"]);
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return response({ error: "body-too-large" }, 413);
        return response({ error: "invalid-request" }, 400);
      }
      const { theme, revision } = value;
      if (!isEnvironmentThemeId(theme))
        return response({ error: "invalid-theme" }, 400);
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      )
        return response({ error: "invalid-revision" }, 400);
      const change = await input.store.change(theme, revision);
      if (change.kind === "blocked") {
        journal({ outcome: "refused", reason: change.reason });
        return response(
          change.reason === "theme-changed"
            ? {
                kind: "blocked",
                reason: change.reason,
                current: themeAnswer(change.record),
              }
            : { kind: "blocked", reason: change.reason },
          409,
        );
      }
      journal({
        outcome: change.kind,
        theme: change.record.theme,
        revision: change.record.revision,
      });
      return response({
        ...themeAnswer(change.record),
        outcome: change.kind,
      });
    },
  });
}
