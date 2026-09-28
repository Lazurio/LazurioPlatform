import { hostname, release, userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readMachineContext } from "../machine/context";
import {
  type CliContext,
  type CommandOutput,
  installBase,
  processContext,
} from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { embeddedFixture } from "../update/identity";
import { runProcess } from "../update/self-check";
import type { RecoveryCheck } from "./checks";
import { searchText } from "./issue";
import {
  collectRecovery,
  type RecoveryEnvironment,
  type RecoveryResult,
} from "./recover";

/** `lazurio recover`: the terminal surface of the recovery use case
 * (docs/recovery.md). It reads, prints and files nothing. */
export const recoverHelp = `recover [--json] [--locale cs|en] [--folder <absolute Folder>]
  Checks whether Lazurio on this Machine is broken: update state no crash can
  produce (R2), the Folder's state as this version reads it, the active
  executable's self-check (R5), and where a unit lazurio install --service
  wrote supervises the Launchpad, that unit (systemctl --user) and the
  Launchpad's health socket. Reads only: no lock, no restart, no network.
  When something is broken it prints the prompt for a repair agent (--locale,
  default the Folder's language) and the sanitized body of an issue for the
  public repository Lazurio/LazurioPlatform, with the exact gh commands to
  search for a duplicate and to create it. It files NOTHING: filing is the
  repair agent's act under the standing mandate for issues (root decision
  0163). A body in which a known private value of this Machine survives is
  refused, naming only the kind of value. The Folder is --folder, the
  supervised unit's, or on a hosted Machine the declared operator's.
  Exit status: 0 healthy or not installed, 3 broken, 2 usage, 1 failure.`;

/** Something is broken: distinct from a failure of the command itself. */
export const exitBroken = 3;

export type RecoverContext = CliContext &
  Readonly<{
    /** Tests only: the observations of the use case. */
    recovery?: Partial<RecoveryEnvironment> | undefined;
  }>;

const synopsis =
  "recover [--json] [--locale cs|en] [--folder <absolute Folder>]";

function account(env: Readonly<Record<string, string | undefined>>) {
  const names = [env.USER, env.LOGNAME];
  try {
    names.push(userInfo().username);
  } catch {}
  return names.filter((name): name is string => typeof name === "string");
}

/** The facts of the real process; tests supply their own. */
function processEnvironment(
  context: RecoverContext,
): Pick<RecoveryEnvironment, "machine" | "machineContext"> {
  return {
    machine: async () => ({
      home: context.env.HOME,
      user: account(context.env),
      hostname: hostname(),
      kernel: release(),
      arch: process.arch,
      bun: Bun.version,
    }),
    machineContext: () => readMachineContext().catch(() => null),
  };
}

/** The environment of the one use case, as `lazurio recover` builds it from
 * its options: the command and the Launchpad's Recovery page run the same. */
export function recoveryEnvironment(
  context: RecoverContext,
  options: Readonly<{
    base: string;
    folder?: string | undefined;
    locale?: "cs" | "en" | undefined;
  }>,
): RecoveryEnvironment {
  return {
    base: options.base,
    identity: context.identity,
    fixture: embeddedFixture() !== undefined,
    platform: context.platform,
    env: context.env,
    folder: options.folder,
    hostedFolder: context.hostedFolder,
    run: context.run ?? runProcess,
    now: () => new Date(),
    locale: options.locale,
    ...processEnvironment(context),
    ...context.recovery,
  };
}

/** What a Launchpad serves as `GET /api/recovery`: exactly `lazurio recover
 * --json --folder <its Folder>` (with `--base <its base>` when it has one).
 * One run at a time: a second request waits for the run in flight. Undefined
 * where this platform has no per-user install base. */
export function recoverySource(
  context: RecoverContext,
  options: Readonly<{ base?: string | undefined; folder: string }>,
): (() => Promise<RecoveryResult>) | undefined {
  let base: string;
  try {
    base = installBase(context, options.base);
  } catch {
    return undefined;
  }
  let running: Promise<RecoveryResult> | null = null;
  return () =>
    (running ??= collectRecovery(
      recoveryEnvironment(context, { base, folder: options.folder }),
    ).finally(() => {
      running = null;
    }));
}

const checkLine = (check: RecoveryCheck) =>
  [
    check.outcome.padEnd(8),
    `${check.id}${check.rule === null ? "" : ` (${check.rule})`}`.padEnd(29),
    check.outcome === "failed"
      ? check.code
      : check.outcome === "skipped"
        ? check.reason
        : "",
    ...Object.entries(check.outcome === "skipped" ? {} : check.context).map(
      ([key, value]) => `${key}=${value}`,
    ),
  ]
    .filter((part) => part !== "")
    .join(" ")
    .trimEnd();

function humanText(result: RecoveryResult, base: string): string {
  const head =
    result.verdict === "broken"
      ? "Lazurio recover: broken."
      : result.verdict === "healthy"
        ? "Lazurio recover: healthy."
        : `Lazurio recover: nothing is installed under ${base}.`;
  const lines = [head, ...result.checks.map(checkLine)];
  if (result.prompt !== null)
    lines.push(
      "",
      "Prompt for the repair agent (it stays on this Machine):",
      "",
      result.prompt,
    );
  const { issue } = result;
  if (issue?.kind === "refused")
    lines.push(
      "",
      `No issue body for ${issue.repository}: after sanitization it still contains ${issue.found.join(", ")}. Nothing may leave this Machine automatically.`,
    );
  if (issue?.kind === "prepared")
    lines.push(
      "",
      `Issue for the public repository ${issue.repository}. This command filed nothing; filing is the repair agent's act under the standing mandate for issues (root decision 0163).`,
      `Search for a duplicate first: ${searchText(issue)}`,
      "Then create it with exactly this command (the body is the text between the markers):",
      "",
      issue.shell,
      "",
      `Without gh: ${issue.link}${issue.bodyInLink ? "" : " (paste the body)"}`,
    );
  return lines.join("\n");
}

export async function runRecoverCommand(
  args: readonly string[],
  context: RecoverContext = processContext(),
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: ${synopsis}`,
  });
  let values: {
    json?: boolean | undefined;
    locale?: string | undefined;
    folder?: string | undefined;
    base?: string | undefined;
  };
  let base: string;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        locale: { type: "string" },
        folder: { type: "string" },
        base: { type: "string" },
      },
    });
    values = parsed.values;
    if (
      parsed.positionals.length > 0 ||
      (values.locale !== undefined &&
        values.locale !== "cs" &&
        values.locale !== "en") ||
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
    const result = await collectRecovery(
      recoveryEnvironment(context, {
        base,
        folder: values.folder,
        locale:
          values.locale === "cs" || values.locale === "en"
            ? values.locale
            : undefined,
      }),
    );
    return Object.freeze({
      code: result.verdict === "broken" ? exitBroken : exitOk,
      stdout:
        values.json === true ? JSON.stringify(result) : humanText(result, base),
    });
  } catch {
    // No reason is printed: it could quote a private path.
    return Object.freeze({ code: exitFailure, stderr: "Recover failed" });
  }
}
