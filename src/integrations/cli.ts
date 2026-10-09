import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toolsEnvironmentOf } from "../tools/overview";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { operatorFolder } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import {
  type ExecutorEndpoint,
  processExecutorEndpoint,
} from "./executor-client";
import type { IntegrationApp, IntegrationsOverview } from "./model";
import { readIntegrations } from "./read";

/** `lazurio integrations`: the Integrace of this Environment for agents
 * (decision F42), the same reading as the Launchpad's Apps → Integrace. */
export const integrationsHelp = `integrations list [--folder <absolute Folder>] [--json]
  The Integrations of this Environment: every app of Lazurio's catalog with
  its one path (by its tool from Settings → Tools, directly through this
  Environment's Executor, or through Composio with the person's account),
  whether it is connected, its accounts and the link to its card in Apps →
  Integrations; the apps connected here that the catalog does not know; the
  custom MCP servers in Executor; and the state of each source (tools,
  Executor, Composio), so a source that cannot be read is never taken for
  "nothing connected". Use an Integration where it is connected, in the
  order tool → Executor → Composio; never connect one yourself: send the
  person the card's link. Read-only, but the tools' sign-in checks and
  Composio may reach the network. Without --folder, the Environment's own
  Folder. Exit status: 0 read, 2 usage or no Folder, 1 failure.`;

export type IntegrationsCliContext = CliContext &
  Readonly<{
    /** Test seam: the Executor API to read instead of this account's
     * (`executor` is the CLI context's Executor setup, decision F44). */
    executorEndpoint?: ExecutorEndpoint | null;
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

/** The overview in a few plain lines; `--json` has everything. */
export function integrationsText(overview: IntegrationsOverview): string {
  const connected = overview.apps.filter((app) => app.connected);
  const lines = [
    connected.length === 0
      ? "Connected: none."
      : ["Connected:", ...connected.map(connectedLine)].join("\n"),
  ];
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
  lines.push(
    overview.page === null
      ? "A missing app is connected by the person in the Launchpad under Apps → Integrations; --json lists every app with what it needs."
      : `A missing app is connected by the person on its card (${overview.page}/app/<id>); --json lists every app with its link.`,
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
  try {
    const overview = await readIntegrations({
      folder,
      tools: toolsEnvironmentOf(context.env, context.platform, runTool),
      executor:
        context.executorEndpoint !== undefined
          ? context.executorEndpoint
          : processExecutorEndpoint(context.env),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
    return {
      code: exitOk,
      stdout: json ? JSON.stringify(overview) : integrationsText(overview),
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
