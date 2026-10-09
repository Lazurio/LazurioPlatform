import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ExecutorHost } from "../executor/flow";
import { columns } from "../organizations/cli";
import {
  exitBroken,
  type RecoverContext,
  recoveryEnvironment,
} from "../recover/cli";
import { toolsEnvironmentOf } from "../tools/overview";
import type { ToolRunner } from "../tools/status";
import { type CommandOutput, installBase, processContext } from "../update/cli";
import {
  exitFailure,
  exitOk,
  exitUpdateAvailable,
  exitUsage,
} from "../update/errors";
import {
  collectDoctor,
  type DoctorCheck,
  type DoctorGroup,
  type DoctorResult,
  type DoctorVerdict,
  doctorGroupOf,
  doctorGroups,
} from "./doctor";

/** `lazurio doctor`: the terminal surface of the doctor use case
 * (launchpad-parity B9, P8). It reads, prints and changes nothing. */
export const doctorHelp = `doctor [--folder <absolute Folder>] [--sign-in] [--json]
  The Environment's state in one read-only answer, every check one the
  product already makes: product (update state, running and active version,
  the active executable's self-check, a verified newer release, a needed
  Folder refresh, the Folder's template revision), Folder (its state as this
  version reads it, preset, a pending transaction; in a Remote Environment
  the recorded binding against the live handover), tools (required missing is a
  failure, recommended or enabled missing needs attention; Executor of a
  Remote Environment has its own check executor: installed version, service,
  loopback answer and the agents' MCP server, which needs attention when it
  is not running and never makes the Environment broken), Organizations and
  modules (every catalog entry, executable or the typed reason), Launchpad
  (the supervised unit and its health socket) and Environment (in a Remote
  Environment whether the entry is recorded). Reads only: the Folder's tool
  selection under the read lock, no write, no restart, no network; --sign-in
  also runs each installed tool's sign-in probe, which may contact its
  provider. --json prints {kind, verdict, locale, checks}; every check is
  {id, outcome ok|warn|fail|skipped, reason?, context?} of enumerated ids,
  without paths or text. The Folder is --folder, the supervised unit's, or in
  a Remote Environment the declared operator's. A broken product is repaired
  through lazurio recover. Exit status: 0 ok, 10 attention, 3 broken,
  2 usage, 1 failure.`;

export const exitAttention = exitUpdateAvailable;

export type DoctorContext = RecoverContext &
  Readonly<{
    /** Tests only: the runner of the tools' version and sign-in commands. */
    toolRun?: ToolRunner | undefined;
    /** Tests only: where Executor is read (decision F44). */
    executorHost?: ExecutorHost | undefined;
  }>;

const synopsis = "doctor [--folder <absolute Folder>] [--sign-in] [--json]";

const exitCodes: Readonly<Record<DoctorVerdict, number>> = {
  ok: exitOk,
  attention: exitAttention,
  broken: exitBroken,
};

const texts = {
  en: {
    verdict: {
      ok: "Lazurio doctor: ok.",
      attention: "Lazurio doctor: needs attention.",
      broken: "Lazurio doctor: broken; lazurio recover prepares the repair.",
    },
    groups: {
      product: "Product",
      folder: "Folder",
      tools: "Tools",
      organizations: "Organizations and modules",
      launchpad: "Launchpad",
      machine: "Environment",
    },
    footer: "Read only; nothing was changed.",
  },
  cs: {
    verdict: {
      ok: "Lazurio doctor: v pořádku.",
      attention: "Lazurio doctor: vyžaduje pozornost.",
      broken: "Lazurio doctor: rozbité; opravu připraví lazurio recover.",
    },
    groups: {
      product: "Produkt",
      folder: "Folder",
      tools: "Nástroje",
      organizations: "Organizace a moduly",
      launchpad: "Launchpad",
      machine: "Environment",
    },
    footer: "Jen čtení; nic se nezměnilo.",
  },
} as const satisfies Record<
  "cs" | "en",
  {
    verdict: Record<DoctorVerdict, string>;
    groups: Record<DoctorGroup, string>;
    footer: string;
  }
>;

// The subject of a check about one tool, Organization or module.
const subjectKeys = ["tool", "organization", "module"] as const;
const subject = (entry: DoctorCheck) => {
  const context = entry.context ?? {};
  if (context.tool !== undefined) return String(context.tool);
  if (context.module !== undefined)
    return `${context.organization}/${context.module}`;
  return context.organization === undefined ? "" : String(context.organization);
};

/** One row per check: outcome, id, subject, reason, the rest of its context. */
export const checkRow = (entry: DoctorCheck): string[] => [
  entry.outcome,
  entry.id,
  subject(entry),
  entry.reason ?? "",
  Object.entries(entry.context ?? {})
    .filter(([key]) => !(subjectKeys as readonly string[]).includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(" "),
];

export function doctorText(result: DoctorResult): string {
  const text = texts[result.locale];
  const lines: string[] = [text.verdict[result.verdict]];
  for (const group of doctorGroups) {
    const checks = result.checks.filter(
      (entry) => doctorGroupOf[entry.id] === group,
    );
    if (checks.length === 0) continue;
    lines.push(
      "",
      text.groups[group],
      ...columns(checks.map(checkRow)).map((line) => `  ${line}`.trimEnd()),
    );
  }
  lines.push("", text.footer);
  return lines.join("\n");
}

export async function runDoctorCommand(
  args: readonly string[],
  context: DoctorContext = processContext(),
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: ${synopsis}`,
  });
  let values: {
    json?: boolean | undefined;
    folder?: string | undefined;
    base?: string | undefined;
    "sign-in"?: boolean | undefined;
  };
  let base: string;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        folder: { type: "string" },
        base: { type: "string" },
        "sign-in": { type: "boolean" },
      },
    });
    values = parsed.values;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      parsed.positionals.length > 0 ||
      new Set(names).size !== names.length ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      return usage;
    base = installBase(context, values.base);
  } catch {
    return usage;
  }
  try {
    const result = await collectDoctor({
      ...recoveryEnvironment(context, { base, folder: values.folder }),
      tools: toolsEnvironmentOf(context.env, context.platform, context.toolRun),
      signIn: values["sign-in"] === true,
      executor: context.executorHost,
    });
    return Object.freeze({
      code: exitCodes[result.verdict],
      stdout:
        values.json === true ? JSON.stringify(result) : doctorText(result),
    });
  } catch {
    // No reason is printed: it could quote a private path.
    return Object.freeze({ code: exitFailure, stderr: "Doctor failed" });
  }
}
