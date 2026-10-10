import type { ExecutorContext } from "../executor/flow";
import { ownDataValue, stateFields } from "../folder/state-fields";
import type { IntegrationsCatalog } from "../integrations/catalog-schema";
import {
  accountName,
  type ConnectHost,
  createConnectSessions,
} from "../integrations/connect";
import type { ExecutorEndpoint } from "../integrations/executor-client";
import type { ComposioPolicySource } from "../integrations/policy";
import { createIntegrationsReader } from "../integrations/read";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Apps → Integrace in the Launchpad (decision F42), behind the admission of
// every `/api/*` route (the local token and same origin, or the gateway's
// session and same origin for a write), over the same core as `lazurio
// integrations list`:
//
//   GET  /api/integrations[?refresh=1]      the Integrace of this Environment
//   POST /api/integrations/connect          {app, name?, account?}
//   POST /api/integrations/poll             {session}
//   POST /api/integrations/cancel           {session}
//   POST /api/integrations/disconnect       {app, path, account, confirm: true}
//   POST /api/integrations/custom/add       {name, kind, target, secretName?, secretValue?}
//   POST /api/integrations/custom/remove    {id, confirm: true}
//
// The reading answers 200 with each source's own state, so an Executor that
// is down or a Composio that is signed out never makes the page fail; only a
// Folder that cannot be read is a 500. A connect takes the app's path from
// the reading, never from the page. A link URL is answered only to the
// request that started it; a key goes to Executor and is never answered,
// logged or journaled.

export type IntegrationsSeams = Readonly<{
  /** The account's Executor; null where it has none. */
  executor: ExecutorEndpoint | null;
  /** Opens a URL in the Environment browser (a Remote Environment); null
   * on a workstation, where the person's own browser opens it. */
  environmentBrowser:
    | ((url: string) => Promise<Readonly<{ view: string }> | null>)
    | null;
  /** Whether Lazurio sets Executor up for this Environment (decision F44's
   * context); the Launchpad's Executor host answers it. */
  executorContext?: (() => Promise<ExecutorContext>) | undefined;
  /** Test and preview seam: whether Executor is part of this Environment,
   * instead of F44's context and its row in Settings → Tools. */
  executorPresent?: boolean | undefined;
  policy?: ComposioPolicySource | undefined;
  catalog?: IntegrationsCatalog | undefined;
  now?: (() => Date) | undefined;
}>;

const sessionPattern = /^[0-9a-f]{32}$/;
const appPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const selectorPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,383}$/;
const headerPattern = /^[A-Za-z0-9-]{1,64}$/;
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function createIntegrationsRoutes(
  input: Readonly<{
    folder: string;
    tools: ToolsEnvironment;
    seams: () => IntegrationsSeams;
    headers: Readonly<Record<string, string>>;
    journal?: (entry: Readonly<Record<string, string>>) => void;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const reader = createIntegrationsReader(() => {
    const seams = input.seams();
    return {
      folder: input.folder,
      tools: input.tools,
      executor: seams.executor,
      ...(seams.executorContext === undefined
        ? {}
        : { executorContext: seams.executorContext }),
      ...(seams.executorPresent === undefined
        ? {}
        : { executorPresent: seams.executorPresent }),
      ...(seams.policy === undefined ? {} : { policy: seams.policy }),
      ...(seams.catalog === undefined ? {} : { catalog: seams.catalog }),
      ...(seams.now === undefined ? {} : { now: seams.now }),
    };
  });
  const sessions = createConnectSessions((): ConnectHost => {
    const seams = input.seams();
    return {
      executor: seams.executor,
      composio: async () => {
        const command = await resolveOnPath(
          "composio",
          input.tools.path,
          input.tools.platform,
        );
        return command === undefined ? null : { env: input.tools, command };
      },
      environmentBrowser: seams.environmentBrowser,
      ...(seams.catalog === undefined ? {} : { catalog: seams.catalog }),
      ...(input.journal === undefined ? {} : { journal: input.journal }),
    };
  });

  /** One POST body with exactly these keys (and these optional ones). */
  async function body(
    request: Request,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Promise<Record<string, unknown> | Response> {
    if (request.method !== "POST")
      return response({ error: "method-not-allowed" }, 405);
    if (request.headers.get("content-type") !== "application/json")
      return response({ error: "invalid-content-type" }, 415);
    try {
      const value = await readJsonBody(request);
      const present = optional.filter(
        (key) => ownDataValue(value, key) !== undefined,
      );
      return stateFields(value, [...required, ...present]);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return response({ error: "body-too-large" }, 413);
      return response({ error: "invalid-request" }, 400);
    }
  }

  return Object.freeze({
    /** Something changed outside these routes (the Organization's settings,
     * decision F45): the next reading reads again. */
    forget: () => reader.forget(),
    handles: (path: string) =>
      path === "/api/integrations" || path.startsWith("/api/integrations/"),
    async handle(
      request: Request,
      url: URL,
      extend: (seconds: number) => void,
    ): Promise<Response> {
      if (url.pathname === "/api/integrations") {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        const keys = [...url.searchParams.keys()];
        const refresh = url.searchParams.get("refresh");
        if (
          keys.some((key) => key !== "refresh") ||
          keys.length > 1 ||
          (refresh !== null && refresh !== "1")
        )
          return response({ error: "invalid-query" }, 400);
        extend(120);
        try {
          return response(await reader.overview(refresh === "1"));
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (url.pathname === "/api/integrations/connect") {
        const value = await body(request, ["app"], ["name", "account"]);
        if (value instanceof Response) return value;
        const name = accountName(value.name);
        if (typeof value.app !== "string" || !appPattern.test(value.app))
          return response({ error: "invalid-app" }, 400);
        if (name === "invalid") return response({ error: "invalid-name" }, 400);
        if (
          value.account !== undefined &&
          (typeof value.account !== "string" ||
            !selectorPattern.test(value.account))
        )
          return response({ error: "invalid-account" }, 400);
        extend(180);
        let overview: Awaited<ReturnType<typeof reader.overview>>;
        try {
          overview = await reader.overview();
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
        const app = overview.apps.find((item) => item.id === value.app);
        if (app === undefined)
          return response({ kind: "blocked", reason: "app-unknown" }, 409);
        const path = app.path;
        if (path.path === "composio" && path.signIn)
          return response(
            { kind: "blocked", reason: "composio-signed-out" },
            409,
          );
        if (path.path !== "direct" && path.path !== "composio")
          return response({ kind: "blocked", reason: "path-unavailable" }, 409);
        const started = await sessions.start(
          app.id,
          path.path,
          name,
          path.path === "direct" && typeof value.account === "string"
            ? value.account
            : undefined,
        );
        if (started.kind === "connected") reader.forget();
        return response(started, started.kind === "blocked" ? 409 : 200);
      }
      if (
        url.pathname === "/api/integrations/poll" ||
        url.pathname === "/api/integrations/cancel"
      ) {
        const value = await body(request, ["session"]);
        if (value instanceof Response) return value;
        if (
          typeof value.session !== "string" ||
          !sessionPattern.test(value.session)
        )
          return response({ error: "invalid-session" }, 400);
        extend(60);
        if (url.pathname === "/api/integrations/cancel") {
          const known = await sessions.cancel(value.session);
          return known
            ? response({ kind: "cancelled" })
            : response({ kind: "blocked", reason: "session-unknown" }, 404);
        }
        const progress = await sessions.poll(value.session);
        if (progress === null)
          return response({ kind: "blocked", reason: "session-unknown" }, 404);
        if (progress.kind === "connected") reader.forget();
        return response(progress);
      }
      if (url.pathname === "/api/integrations/disconnect") {
        const value = await body(request, [
          "app",
          "path",
          "account",
          "confirm",
        ]);
        if (value instanceof Response) return value;
        if (value.confirm !== true)
          return response({ error: "confirm-required" }, 400);
        if (
          typeof value.app !== "string" ||
          !appPattern.test(value.app) ||
          (value.path !== "direct" && value.path !== "composio") ||
          typeof value.account !== "string" ||
          !selectorPattern.test(value.account)
        )
          return response({ error: "invalid-account" }, 400);
        extend(120);
        const result = await sessions.disconnect(
          value.app,
          value.path,
          value.account,
        );
        reader.forget();
        return response(result, result.kind === "blocked" ? 409 : 200);
      }
      if (url.pathname === "/api/integrations/custom/add") {
        const value = await body(
          request,
          ["name", "kind", "target"],
          ["secretName", "secretValue"],
        );
        if (value instanceof Response) return value;
        const name = accountName(value.name);
        const withSecret = value.secretName !== undefined;
        if (
          name === null ||
          name === "invalid" ||
          (value.kind !== "url" && value.kind !== "command") ||
          typeof value.target !== "string" ||
          value.target.trim() === "" ||
          value.target.length > 2048 ||
          withSecret !== (value.secretValue !== undefined)
        )
          return response({ error: "invalid-server" }, 400);
        if (value.kind === "url") {
          try {
            const target = new URL(value.target);
            if (target.protocol !== "https:" && target.protocol !== "http:")
              throw new Error("scheme");
          } catch {
            return response({ error: "invalid-server" }, 400);
          }
        }
        if (
          withSecret &&
          (typeof value.secretName !== "string" ||
            !(value.kind === "url" ? headerPattern : variablePattern).test(
              value.secretName,
            ) ||
            typeof value.secretValue !== "string" ||
            value.secretValue === "" ||
            value.secretValue.length > 4096)
        )
          return response({ error: "invalid-secret" }, 400);
        extend(180);
        const result = await sessions.addCustom({
          name,
          kind: value.kind,
          target: value.target.trim(),
          secret: withSecret
            ? {
                name: value.secretName as string,
                value: value.secretValue as string,
              }
            : null,
        });
        reader.forget();
        return response(result, result.kind === "blocked" ? 409 : 200);
      }
      if (url.pathname === "/api/integrations/custom/remove") {
        const value = await body(request, ["id", "confirm"]);
        if (value instanceof Response) return value;
        if (value.confirm !== true)
          return response({ error: "confirm-required" }, 400);
        if (typeof value.id !== "string" || !appPattern.test(value.id))
          return response({ error: "invalid-server" }, 400);
        extend(60);
        const result = await sessions.removeCustom(value.id);
        reader.forget();
        return response(result, result.kind === "blocked" ? 409 : 200);
      }
      return response({ error: "not-found" }, 404);
    },
  });
}
