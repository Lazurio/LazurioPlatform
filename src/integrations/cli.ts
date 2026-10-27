import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ExecutorHost } from "../executor/flow";
import { toolsEnvironmentOf } from "../tools/overview";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { operatorFolder } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { composioOrganizationName } from "./composio-organization-name";
import {
  type ExecutorEndpoint,
  processExecutorEndpoint,
} from "./executor-client";
import type {
  IntegrationApp,
  IntegrationsOverview,
  UnknownReason,
} from "./model";
import { readIntegrations } from "./read";

/** `lazurio integrations`: the Integrace of this Environment for agents
 * (decision F42), the same reading as the Launchpad's Apps → Integrace. */
export const integrationsHelp = `integrations list [--folder <absolute Folder>] [--json]
  The Integrations of this Environment: every app of Lazurio's catalog with
  its one path (by its tool from Settings → Tools, directly through this
  Environment's Executor, or through Composio with the user's account),
  whether it is connected (null, with the reason in "unknown", where a
  source that could connect it was not read or verified now: never "not
  connected"), its accounts and the link to its card in Apps →
  Integrations; the apps connected here that the catalog does not know; the
  custom MCP servers in Executor; and the state of each source (tools,
  Executor, Composio), so a source that cannot be read is never taken for
  "nothing connected". Use an Integration where it is connected, in the
  order tool → Executor → Composio; never connect one yourself: send the
  user the card's link. It connects and removes nothing. On an
  Organization's Environment it makes the user's Composio organization of
  the Organization's name current where another one is, and says so on
  stderr (the operation and its outcome, never a name or an id); the tools'
  sign-in checks and Composio may reach the network. Without --folder, the
  Environment's own Folder. Exit status: 0 read, 2 usage or no Folder, 1
  failure.`;

export type IntegrationsCliContext = CliContext &
  Readonly<{
    /** Test seam: the Executor API to read instead of this account's
     * (`executor` is the CLI context's Executor setup, decision F44). */
    executorEndpoint?: ExecutorEndpoint | null;
    /** Test seam: whether Executor is part of this Environment, instead of
     * its row in Settings → Tools (decision F44). */
    executorPresent?: boolean;
    now?: () => Date;
  }>;

function connectedLine(app: IntegrationApp): string {
  const path = app.path;
  const way =
    path.path === "tool"
      ? `through ${path.tool}`
      : path.path === "direct"
        ? "directly (Executor)"
        : path.path === "composio"
          ? "through Composio"
          : "";
  const attention = app.accounts.filter(
    (account) => !account.spare && account.state !== "connected",
  );
  return `  ${app.name} (${app.id}) — ${way}${
    attention.length > 0
      ? ` · ${attention.map((account) => account.state).join(", ")}`
      : ""
  }`;
}

/** What a source not read or not verified is, by the reason it leaves an
 * app unknown (decision F42, addendum of 2026-10-27). */
const unknownWhy: Readonly<Record<UnknownReason, string>> = {
  "tools-unavailable": "the tools could not be asked",
  "tools-unreadable":
    "the tools, or the sign-in of its tool, could not be read",
  "executor-unavailable": "Executor did not answer",
  "executor-unreadable": "Executor's answer could not be read",
  "composio-unreadable": "Composio's sign-in or connections could not be read",
  "composio-unverified":
    "this Environment's Composio organization could not be verified",
  "composio-elsewhere":
    "Composio could not be switched to this Environment's organization",
};

/** The overview in a few plain lines; `--json` has everything. */
export function integrationsText(overview: IntegrationsOverview): string {
  const connected = overview.apps.filter((app) => app.connected === true);
  // Accounts on the app's way here, none of them working (signed out or
  // failing): the person signs in again on the app's card.
  const notWorking = overview.apps.filter(
    (app) =>
      app.connected === false && app.accounts.some((account) => !account.spare),
  );
  // Apps whose source was not read or verified: never "not connected".
  const unknown = new Map<UnknownReason, number>();
  for (const app of overview.apps)
    if (app.connected === null && app.unknown !== undefined)
      unknown.set(app.unknown, (unknown.get(app.unknown) ?? 0) + 1);
  const lines = [
    connected.length > 0
      ? ["Connected:", ...connected.map(connectedLine)].join("\n")
      : unknown.size > 0
        ? "Connected: none that could be verified now."
        : "Connected: none.",
  ];
  if (notWorking.length > 0)
    lines.push(
      [
        "Not working (the user signs in again on the card):",
        ...notWorking.map(connectedLine),
      ].join("\n"),
    );
  if (unknown.size > 0)
    lines.push(
      [
        `Not verified now (--json: "connected": null and why in "unknown"); never tell the user these are not connected. Read again in a moment, or use the app through its path (never Composio while its organization is not verified) and report only a concrete failure:`,
        ...[...unknown].map(
          ([reason, count]) =>
            `  ${count} ${count === 1 ? "app" : "apps"}: ${unknownWhy[reason]} (${reason})`,
        ),
      ].join("\n"),
    );
  if (overview.custom.length > 0)
    lines.push(
      [
        "Custom MCP servers in Executor:",
        ...overview.custom.map(
          (server) =>
            `  ${server.name} (${server.id}) — ${server.kind === "remote" ? (server.target ?? "remote") : "command"}`,
        ),
      ].join("\n"),
    );
  lines.push(
    `Sources: tools ${overview.sources.tools} · Executor ${overview.sources.executor} · Composio ${overview.sources.composio}.`,
  );
  // Composio not in the organization of this Environment's Organization's
  // name (decision F42, addendum (2) of 2026-10-13): the person sees to it,
  // under the name Composio accepts (note of 2026-10-17). The account's
  // default organization (addendum of 2026-10-26) by the name Composio gives
  // it.
  const target = overview.composio.organization;
  const composio =
    target?.name == null
      ? null
      : target.default === true
        ? target.name
        : (composioOrganizationName(target.name) ?? target.name);
  if (target !== null && target.state !== "matches")
    lines.push(
      target.state === "unverified" || target.name === null
        ? "Composio: the name of this Environment's Organization could not be read, so its Composio organization cannot be checked; nothing connects through Composio from here now, and its apps are not verified, which does not mean they are not connected. Read again in a moment (a running lazurio update may be rewriting the Organization); if it stays so, check this Environment's Folder (lazurio doctor)."
        : target.state === "missing"
          ? `Composio: the user's account has no organization named "${composio}" (this Environment's Organization "${target.name}", named as Composio accepts it), so Composio works in their current organization meanwhile. Send them to Apps → Integrations to create it.`
          : target.state === "ambiguous"
            ? `Composio: the user's account has more than one organization named "${composio}", so Composio works in their current organization meanwhile. Send them to Apps → Integrations to keep one.`
            : `Composio: it could not be switched to the organization "${composio}"; nothing connects through Composio from here now and its apps are not verified, and reading again (or "Check connections" in Apps → Integrations) tries again.`,
    );
  // Composio not the build Lazurio pins (decision F42, addendum (b) of
  // 2026-10-14): the person updates it; an agent only on their instruction.
  if (overview.composio.update)
    lines.push(
      "Composio should be updated: the user does it in the Launchpad under Settings → Tools (Update); until then accounts cannot be disconnected from here and some have no name. Do not update it yourself unless they ask you to.",
    );
  lines.push(
    overview.page === null
      ? "A missing app is connected by the user in the Launchpad under Apps → Integrations; --json lists every app with what it needs."
      : `A missing app is connected by the user on its card (${overview.page}/app/<id>); --json lists every app with its link.`,
  );
  // Composio's own Apps, for an app the catalog does not list (decision
  // F42, addendum of 2026-10-14).
  if (overview.composio.apps !== null)
    lines.push(
      `An app the catalog does not list is connected by the user in Composio (${overview.composio.apps}); it then shows here.`,
    );
  return lines.join("\n");
}

export async function runIntegrationsCommand(
  args: readonly string[],
  context: IntegrationsCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: integrations list [--folder <absolute Folder>] [--json]\n${integrationsHelp}`,
  });
  let values: { folder?: string | undefined; json?: boolean | undefined };
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { folder: { type: "string" }, json: { type: "boolean" } },
    });
    if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "list")
      return usage;
    values = parsed.values;
  } catch {
    return usage;
  }
  if (
    values.folder !== undefined &&
    (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder)
  )
    return usage;
  const json = values.json === true;
  const folder = values.folder ?? (await operatorFolder(context));
  if (folder === undefined)
    return {
      code: exitUsage,
      ...(json
        ? {
            stdout: JSON.stringify({
              kind: "blocked",
              reason: "folder-unknown",
            }),
          }
        : {
            stderr: "No Folder known: name it with --folder <absolute Folder>.",
          }),
    };
  // The Composio organization the reading makes current, journaled as the
  // Launchpad journals it (decision F42, addendum (2) of 2026-10-13).
  const journaled: string[] = [];
  try {
    const overview = await readIntegrations({
      folder,
      journal: (entry) => journaled.push(JSON.stringify(entry)),
      tools: toolsEnvironmentOf(context.env, context.platform, runTool),
      executor:
        context.executorEndpoint !== undefined
          ? context.executorEndpoint
          : processExecutorEndpoint(context.env),
      ...(context.executor === undefined
        ? {}
        : {
            executorContext: () =>
              (context.executor as () => ExecutorHost)().context(),
          }),
      ...(context.executorPresent === undefined
        ? {}
        : { executorPresent: context.executorPresent }),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
    return {
      code: exitOk,
      stdout: json ? JSON.stringify(overview) : integrationsText(overview),
      ...(journaled.length === 0 ? {} : { stderr: journaled.join("\n") }),
    };
  } catch {
    return {
      code: exitFailure,
      ...(json
        ? {
            stdout: JSON.stringify({
              kind: "blocked",
              reason: "folder-unreadable",
            }),
          }
        : { stderr: "The Folder's Integrations could not be read." }),
    };
  }
}
