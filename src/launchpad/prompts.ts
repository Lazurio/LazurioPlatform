import { resolve } from "node:path";
import type { Catalog, CatalogOrganization } from "../organizations/catalog";
import { newModulePrompt } from "./apps-view";
import { organizationName } from "./catalog-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// The prepared prompts a link may open in Chat (`GET /.lazurio/prompts/<id>
// ?org=<login>`, Lazurio/t3code#35). A link carries only a prompt's id and an
// Organization's GitHub login, never text: the T3 Code fork fetches the text
// from its own origin, where the gateway proxies `/.lazurio/*` to this
// Launchpad behind the same admission as every read, and puts it in a new
// thread's composer without sending it. Each prompt names who may get it;
// anyone else, and every id or Organization this Launchpad does not know, gets
// the same 404, so the answer never says more than the tile already showed.

export const promptSchema = "lazurio.prompt.v1";

/** Who may get a prompt. `organization-owner`: only where this Environment's
 * GitHub identity is an Owner of the Organization, GitHub's own live answer
 * (organization-owner.ts), the same rule as the "+ Nový modul" tile; a Team
 * Environment never is. */
export type PromptAudience = "organization-owner";

type PromptSource = Readonly<{
  who: PromptAudience;
  text: (
    organization: CatalogOrganization,
    login: string,
    copy: Copy,
  ) => string;
}>;

const prompts = {
  // "+ Nový modul" (decision F36 addendum of 2026-10-04): the wireframe's
  // brief for founding a module with an agent.
  "new-module": {
    who: "organization-owner",
    text: (organization, login, copy) =>
      newModulePrompt(organizationName(organization), login, copy),
  },
} as const satisfies Readonly<Record<string, PromptSource>>;

export type PromptId = keyof typeof prompts;

export const isPromptId = (id: string): id is PromptId =>
  Object.hasOwn(prompts, id);

/** Who may get the prompt `id`. */
export const promptAudience = (id: PromptId): PromptAudience => prompts[id].who;

/** The answer of the route, and what the fork accepts. */
export type PromptDocument = Readonly<{
  schema: typeof promptSchema;
  id: PromptId;
  text: string;
  /** The Organization's root on this Environment, absolute: Chat opens the
   * new thread in the project rooted here. */
  cwd: string;
}>;

const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** An Organization of the Folder whose manifest binds a GitHub login. */
export type BoundOrganization = CatalogOrganization & { forgeLogin: string };

/** The one Organization of the Folder bound to a GitHub login (compared
 * case-insensitively, as GitHub does), or null: a malformed login, none, or
 * more than one candidate bound to it. The Personalspace group is never one. */
export function promptOrganization(
  catalog: Catalog,
  login: string,
): BoundOrganization | null {
  if (!githubLogin.test(login)) return null;
  const key = login.toLowerCase();
  const bound = catalog.organizations.filter(
    (organization) => organization.forgeLogin?.toLowerCase() === key,
  );
  const [organization] = bound;
  return bound.length === 1 && organization?.forgeLogin !== undefined
    ? (organization as BoundOrganization)
    : null;
}

/** The document of the prompt `id` for one Organization of the Folder at
 * `folder`, in the person's language. Who may get it is the caller's to
 * check first (`promptAudience`). */
export function promptDocument(
  id: PromptId,
  folder: string,
  organization: BoundOrganization,
  copy: Copy,
): PromptDocument {
  return Object.freeze({
    schema: promptSchema,
    id,
    text: prompts[id].text(organization, organization.forgeLogin, copy),
    cwd: resolve(folder, "organizations", organization.directory),
  });
}
