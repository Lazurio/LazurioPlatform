import type { ContentHost } from "../content/host";
import type { InstallRequest } from "../content/install";
import { createContentJobs } from "../content/jobs";
import { type ContentItemRef, githubLoginPattern } from "../content/model";
import { canPrepareRoot } from "../content/role";
import { contentStatus } from "../content/status";
import { ownDataValue, stateFields } from "../folder/state-fields";
import type { PersonalspaceHolderRead } from "../organizations/personalspace";
import { unpreparedCodes } from "./content-view";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Content installation in the Launchpad (decision F9, addendum of
// 2026-10-04), behind the same admission as every `/api/*` route (the local
// token and same origin, or the gateway's session and same origin for a
// write) and over the same core as `lazurio organization install` and
// `lazurio personalspace install`. The contract the Launchpad page is built
// against:
// - `GET /api/content`: the `contentStatus` of this Folder;
// - `POST /api/content/install` with `{}` (everything this Environment holds)
//   or `{ "items": [ { "kind": "organization", "login": "…" } |
//   { "kind": "personalspace" } ] }`: `202 { "job": "<id>" }`, `409` while a
//   job runs (`{ "error": "busy", "job": "<id>" }`; without `job` when the
//   Folder's content lock is held outside this Launchpad), `403` when this
//   Environment does not install that content (`{ "error": "not-allowed",
//   "reason": … }`), or not yet: `"reason": "ai-missing"` while the
//   Environment's AI is provably missing (root decision 0201 point 3,
//   `refuseInstall`);
// - `GET /api/content/jobs/<id>`: `{ id, state, steps, failure? }`;
// - `GET /api/content/jobs/latest`: the newest job of this Launchpad in the
//   same shape, `404` before the first one, so every browser of the
//   Environment sees the same last installation;
// - `GET /api/content/root-access?org=<login>`: `{ kind: "root-access",
//   write }`, whether this Environment's GitHub identity can prepare that
//   Organization's root (root decision 0201 point 8, `canPrepareRoot`):
//   where a stop that only the root's writers fix leads. Only for the
//   Organization whose installation, the newest of this Launchpad, stopped
//   because its root is not prepared (`unpreparedCodes`); for any other the
//   same `write: false`, without asking GitHub, so it tells nothing about
//   the identity's rights elsewhere.
// An Organization's scope follows the person's role, which the request does
// not carry: the core resolves it live from GitHub through gh (an Owner's
// membership, `maintain` or `write` on the root repository, or `read` on it
// with an active membership: a Reader) and fails closed with
// `role-unverified` when GitHub confirms none. A public Environment has no
// GitHub identity: it installs as a Reader without asking GitHub (decision
// F55's addendum of 2026-10-17).

const jobRoute = /^\/api\/content\/jobs\/([0-9a-f]{32})$/;

/** The body of `POST /api/content/install`, or null when it is not one. */
export function parseInstallBody(input: unknown): InstallRequest | null {
  try {
    if (ownDataValue(input, "items") === undefined) {
      stateFields(input, []);
      return {};
    }
    const value = stateFields(input, ["items"]);
    if (
      !Array.isArray(value.items) ||
      value.items.length === 0 ||
      value.items.length > 32
    )
      return null;
    const items: ContentItemRef[] = [];
    for (const entry of value.items) {
      if (ownDataValue(entry, "kind") === "personalspace") {
        stateFields(entry, ["kind"]);
        items.push({ kind: "personalspace" });
        continue;
      }
      const item = stateFields(entry, ["kind", "login"]);
      if (
        item.kind !== "organization" ||
        typeof item.login !== "string" ||
        !githubLoginPattern.test(item.login)
      )
        return null;
      items.push({ kind: "organization", login: item.login });
    }
    return { items };
  } catch {
    return null;
  }
}

export function createContentRoutes(
  input: Readonly<{
    folder: string;
    /** Composed on first use: nothing is resolved before a content route
     * is asked. */
    host: () => ContentHost;
    headers: Readonly<Record<string, string>>;
    /** Whose Personalspace this Environment holds (#186): the Launchpad's
     * remembered decision, which its catalog and module lifecycle share;
     * by default decided at each read through `host`. */
    personalspace?: PersonalspaceHolderRead | undefined;
    /** Why an installation may not start now, or null (root decision 0201
     * point 3: `ai-missing`); asked before every start. Trusted
     * composition, never HTTP input. */
    refuseInstall?: (() => Promise<string | null>) | undefined;
  }>,
) {
  let host: ContentHost | undefined;
  const resolved = () => {
    host ??= input.host();
    return host;
  };
  const jobs = createContentJobs({ folder: input.folder, host: resolved });
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  return Object.freeze({
    /** Whether this path is a content route. */
    handles: (path: string) =>
      path === "/api/content" ||
      path === "/api/content/install" ||
      path === "/api/content/root-access" ||
      path.startsWith("/api/content/jobs/"),
    async handle(
      request: Request,
      url: URL,
      extend: (seconds: number) => void,
    ): Promise<Response> {
      if (url.pathname === "/api/content") {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        // One GitHub read for gh's account, one more for the Personalspace
        // (remembered a minute by the Launchpad).
        extend(60);
        return response(
          await contentStatus(input.folder, resolved(), input.personalspace),
        );
      }
      if (url.pathname === "/api/content/root-access") {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        const keys = [...url.searchParams.keys()];
        const login = url.searchParams.get("org");
        if (
          keys.length !== 1 ||
          keys[0] !== "org" ||
          login === null ||
          !githubLoginPattern.test(login)
        )
          return response({ error: "invalid-request" }, 400);
        // Only the Organization of the stop it is asked for; anything else
        // gets the same "no" without a question to GitHub.
        const last = jobs.latest();
        const failure = last?.state === "failed" ? last.failure : undefined;
        if (
          failure === undefined ||
          failure.item.kind !== "organization" ||
          failure.item.login.toLowerCase() !== login.toLowerCase() ||
          !unpreparedCodes.includes(failure.code)
        )
          return response({ kind: "root-access", write: false });
        // Two GitHub reads: the membership and the conventional root.
        extend(30);
        const github = resolved().github;
        const [membership, root] = await Promise.all([
          github
            .membership(login)
            .catch(() => ({ kind: "unavailable" }) as const),
          github
            .repository(login, `${login}_GEN3`)
            .catch(() => ({ kind: "unavailable" }) as const),
        ]);
        return response({
          kind: "root-access",
          write: canPrepareRoot(
            membership,
            root.kind === "observed" ? root.repository.permission : null,
          ),
        });
      }
      if (url.pathname === "/api/content/install") {
        if (request.method !== "POST")
          return response({ error: "method-not-allowed" }, 405);
        if (request.headers.get("content-type") !== "application/json")
          return response({ error: "invalid-content-type" }, 415);
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          if (error instanceof BodyTooLarge)
            return response({ error: "body-too-large" }, 413);
          return response({ error: "invalid-request" }, 400);
        }
        const parsed = parseInstallBody(body);
        if (parsed === null) return response({ error: "invalid-items" }, 400);
        const refused = (await input.refuseInstall?.()) ?? null;
        if (refused !== null)
          return response({ error: "not-allowed", reason: refused }, 403);
        const started = await jobs.start(parsed);
        if (started.kind === "started")
          return response({ job: started.job }, 202);
        if (started.kind === "busy")
          return response(
            {
              error: "busy",
              ...(started.job === undefined ? {} : { job: started.job }),
            },
            409,
          );
        return response({ error: "not-allowed", reason: started.reason }, 403);
      }
      const job = jobRoute.exec(url.pathname);
      if (request.method !== "GET")
        return response({ error: "method-not-allowed" }, 405);
      const found =
        url.pathname === "/api/content/jobs/latest"
          ? jobs.latest()
          : job === null
            ? undefined
            : jobs.get(job[1] as string);
      return found === undefined
        ? response({ error: "not-found" }, 404)
        : response(found);
    },
    settled: () => jobs.settled(),
    /** The status as `GET /api/content` answers it: the shape of a content
     * reader's `list()`. */
    list: () => contentStatus(input.folder, resolved(), input.personalspace),
    /** The newest job as `GET /api/content/jobs/<id>` answers it, or null:
     * the shape of a content reader's `lastJob()`. */
    lastJob: async () => jobs.latest() ?? null,
  });
}
