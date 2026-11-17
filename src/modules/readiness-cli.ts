import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assessReadiness,
  type Readiness,
  readReadinessInput,
} from "./readiness";

export const moduleReadinessHelp = `module readiness <absolute module directory> [--app <package>] [--json]
  Checks, without running anything and without the network, whether the
  Module is ready as an Application (decision 0249, docs/module-readiness.md):
  its generation V0-V4 by where its data are, its findings and its verdict.
  no-application: a Module without an app (V0). not-ready: a blocker, the
  Application cannot run from it. ready-for-trial: it can run, but live use
  still needs something (CI, contract tests, a release tag). ready-for-live:
  nothing found. Host conditions (a static build, sibling data, a sibling
  API) are what the application host must support; they are listed apart
  and do not lower the Module's verdict. It changes nothing: an agent fixes
  the findings in the Module. Exit 0 unless the verdict is not-ready (1).`;

export class ModuleReadinessUsageError extends Error {}

export function describeReadiness(result: Readiness): string {
  const lines = [
    `${result.module ?? "(unknown module)"}${result.app ? ` ${result.app}` : ""}: ${result.verdict}${result.generation ? ` (${result.generation})` : ""}`,
    ...result.findings.map(
      (item) => `  ${item.level}  ${item.id}: ${item.message}`,
    ),
    ...result.hostConditions.map(
      (item) => `  host     ${item.id}: ${item.detail}`,
    ),
  ];
  return lines.join("\n");
}

export async function runModuleReadinessCommand(
  args: readonly string[],
): Promise<Readonly<{ code: number; text: string; result: Readiness }>> {
  let values: { app?: string | undefined; json?: boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { app: { type: "string" }, json: { type: "boolean" } },
    }));
  } catch (error) {
    throw new ModuleReadinessUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const [noun, verb, directory, ...rest] = positionals;
  if (
    noun !== "module" ||
    verb !== "readiness" ||
    directory === undefined ||
    rest.length !== 0 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory
  )
    throw new ModuleReadinessUsageError("Usage:");
  const result = assessReadiness(
    await readReadinessInput(directory, values.app),
  );
  return Object.freeze({
    code: result.verdict === "not-ready" ? 1 : 0,
    text:
      values.json === true ? JSON.stringify(result) : describeReadiness(result),
    result,
  });
}
