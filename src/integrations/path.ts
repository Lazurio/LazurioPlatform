// The one path of an Integrace in an Environment (root decision 0162,
// addendum of 2026-10-09; decision F42): its own tool from Settings → Tools
// ("nástrojem"), the Environment's Executor ("přímo") or the person's own
// Composio account ("přes Composio"). Ported from the approved wireframe's
// `choosePath` (prototypes-lazurio, `connections.ts`); pure, so the page, the
// route, `lazurio integrations list` and the Folder's order agree.

/** An app id as the Integrace catalog names it (Composio's toolkit slug
 * where Composio has the app): lowercase letters, digits, `_` and `-`, at
 * most 64 characters. */
export const integrationIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The tools of Settings → Tools made for one app (gh for GitHub, wacli for
 * WhatsApp, gogcli for Google on personal Environments, neon for Neon). */
export const appTools = ["gh", "wacli", "gogcli", "neon"] as const;
export type AppTool = (typeof appTools)[number];

/** How an app's official MCP server signs in through Executor, as the
 * catalog's probe verified it. `dcr` (dynamic client registration), `cimd`
 * (client ID metadata document) and `none` connect in one click; the other
 * three need an app registered by the company first: Google's or
 * Microsoft's company app, which an Admin sets up in the Dashboard, or the
 * app's own (`needs-app`, e.g. Slack). */
export const directAuths = [
  "dcr",
  "cimd",
  "none",
  "company-app:google",
  "company-app:microsoft",
  "needs-app",
] as const;
export type DirectAuth = (typeof directAuths)[number];

/** The way an account of an app goes. */
export type Path = "direct" | "composio";

/** What the path rule reads of a catalog app. */
export type PathApp = Readonly<{
  id: string;
  direct?: Readonly<{ auth: DirectAuth }>;
  /** Composio has the app (its toolkit). */
  composio: boolean;
  tool?: AppTool;
}>;

/** The rules an Environment connects by: its Organization's on a work,
 * Team or Automated Environment, the person's own on a personal Environment
 * and their own computer (root decision 0194 point 5). `companyApps` are the
 * company apps the Organization set up (Google Workspace, Microsoft 365, or
 * an app's own); none until the Dashboard sets them up (plan DEV-6626 task
 * 685). */
export type Rules = Readonly<{
  scope: "organization" | "personal";
  composio: boolean;
  companyApps: readonly string[];
  /** Whether the Environment has Executor at all; false where it was never
   * installed (Lazurio installs it on Remote Environments, decision F44),
   * and then nothing connects directly. Absent: it has. */
  direct?: boolean;
}>;

export type PathChoice =
  | Readonly<{ path: "tool"; tool: AppTool }>
  | Readonly<{ path: "direct" }>
  /** `signIn`: the person's Composio account is not signed in here yet. */
  | Readonly<{ path: "composio"; signIn: boolean }>
  | Readonly<{
      path: null;
      missing: "company-app";
      /** `google`, `microsoft`, or the app's own id for `needs-app`. */
      provider: string;
      /** The Admin sets it up in the Dashboard; anyone else asks the Admin. */
      action: "set-up" | "ask-admin";
    }>
  | Readonly<{
      path: null;
      missing: "composio";
      /** Whoever decides allows Composio; anyone else asks the Admin. */
      action: "allow" | "ask-admin";
    }>
  /** Only the app's own tool connects it, in Settings → Tools. */
  | Readonly<{ path: null; missing: "tool"; tool: AppTool }>
  /** Nothing connects the app in this Environment. */
  | Readonly<{ path: null; missing: "path" }>;

/** The company app an app's direct path needs, or none. */
export function companyAppOf(app: PathApp): string | null {
  const auth = app.direct?.auth;
  if (auth === "company-app:google") return "google";
  if (auth === "company-app:microsoft") return "microsoft";
  if (auth === "needs-app") return app.id;
  return null;
}

/** Whether the direct path connects in one click: an official MCP server
 * that registers itself, or one without sign-in. */
export const isOneClick = (app: PathApp): boolean =>
  app.direct !== undefined && companyAppOf(app) === null;

/**
 * The rule, in the agents' order (Matěj 2026-10-09). A connected tool made
 * for the app comes first. Then one app, one path: an app already connected
 * keeps its way, přímo before an older Composio one. Otherwise directly where
 * it is just as easy (an official MCP server that registers itself, or a
 * company app the Organization set up), else through Composio where it is
 * allowed. Without either, an Organization is pointed to its company app
 * first, as Lazurio recommends to companies; Composio comes after. On a
 * personal Environment the person decides alone and there is no company app.
 */
export function choosePath(
  input: Readonly<{
    app: PathApp;
    rules: Rules;
    /** The person's Composio account is signed in and on for agents here. */
    signedIn: boolean;
    /** The Organization's Admin or Owner; on a personal Environment the
     * person always decides. */
    admin: boolean;
    /** The tools for one app connected in this Environment. */
    tools?: readonly AppTool[];
    /** The ways the app's accounts already go here. */
    connected?: readonly Path[];
  }>,
): PathChoice {
  const { app, rules, signedIn, admin } = input;
  const tools = input.tools ?? [];
  const connected = input.connected ?? [];
  if (app.tool !== undefined && tools.includes(app.tool))
    return { path: "tool", tool: app.tool };
  const company = companyAppOf(app);
  const directHere =
    rules.direct !== false &&
    app.direct !== undefined &&
    (company === null || rules.companyApps.includes(company));
  const composioHere = app.composio && rules.composio;
  if (connected.includes("direct") && directHere) return { path: "direct" };
  if (connected.includes("composio") && composioHere)
    return { path: "composio", signIn: !signedIn };
  if (directHere) return { path: "direct" };
  if (composioHere) return { path: "composio", signIn: !signedIn };
  const decides = admin || rules.scope === "personal";
  if (company !== null && rules.scope === "organization")
    return {
      path: null,
      missing: "company-app",
      provider: company,
      action: decides ? "set-up" : "ask-admin",
    };
  if (app.composio)
    return {
      path: null,
      missing: "composio",
      action: decides ? "allow" : "ask-admin",
    };
  if (app.tool !== undefined)
    return { path: null, missing: "tool", tool: app.tool };
  return { path: null, missing: "path" };
}
