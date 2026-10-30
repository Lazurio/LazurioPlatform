import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { outputPaths } from "../../src/folder/outputs";
import { instructionTemplateRevision } from "../../src/folder/render";
import { layout, readSelector } from "../../src/update/layout";
import {
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "../../src/update/self-check";

/** A Folder as an earlier release left it: its generated files carry that
 * revision and the manifest records exactly those bytes, so the one planner
 * can upgrade it. */
export async function renderedBy(folder: string, revision: string) {
  const path = join(folder, ".lazurio", "instructions.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const outputs: Record<string, string> = {};
  for (const output of outputPaths) {
    const content = `${(
      await readFile(join(folder, output), "utf8")
    ).replaceAll(
      instructionTemplateRevision,
      revision,
    )}\nText of an earlier release.\n`;
    await writeFile(join(folder, output), content);
    outputs[output] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(
    path,
    JSON.stringify({ ...manifest, templateRevision: revision, outputs }),
  );
}

/** What the Folder records: the template revision and the state revision. */
export async function recordedRevisions(folder: string) {
  const state = join(folder, ".lazurio");
  const manifest = JSON.parse(
    await readFile(join(state, "instructions.json"), "utf8"),
  );
  const preferences = JSON.parse(
    await readFile(join(state, "preferences.json"), "utf8"),
  );
  return {
    template: manifest.templateRevision as string,
    revision: preferences.revision as number,
  };
}

export type RefreshCall = Readonly<{
  /** The arguments after the selector. */
  command: readonly string[];
  /** The version the selector named when the refresh ran. */
  active: string | null;
}>;

/** A process runner for `lazurio update`: the selector's own commands are the
 * active version's refresh, run by this checkout's CLI in-process (its
 * templates are this revision's) unless `answer` scripts them; every other
 * command, a candidate's self-check, runs as the real process it is. */
export function refreshRunner(
  base: string,
  answer?: (
    command: readonly string[],
    call: number,
  ) => ProcessResult | undefined | Promise<ProcessResult | undefined>,
) {
  const calls: RefreshCall[] = [];
  const run: ProcessRunner = async (argv, timeoutMs, env) => {
    if (argv[0] !== layout(base).selector)
      return runProcess(argv, timeoutMs, env);
    const command = argv.slice(1);
    calls.push({ command, active: await readSelector(base) });
    const scripted = await answer?.(command, calls.length);
    if (scripted !== undefined) return scripted;
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => {
      lines.push(String(line));
    };
    let exitCode: number;
    try {
      exitCode = await runCli([...command]);
    } catch {
      exitCode = 1;
    } finally {
      console.log = log;
    }
    return { exitCode, stdout: lines.join("\n") };
  };
  return { run, calls };
}
