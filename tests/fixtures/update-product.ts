import { readFileSync, writeFileSync } from "node:fs";
import { runCli } from "../../src/cli";
import { runUpdateCommand } from "../../src/update/cli";
import { swapSelector } from "../../src/update/layout";
import { runProcess } from "../../src/update/self-check";

/** TEST-ONLY executable: the real product CLI plus faults that a test turns on
 * through a control file whose path is compiled in. Product code carries no
 * test hook; every fault below is injected here, through the same effect
 * seams the unit tests use. The file is read at each start, so one compiled
 * binary serves a failing attempt and the explicit retry after it.
 *
 *   self-check-fails                a candidate that cannot pass its gate
 *   self-check-fails-via-selector   passes staging, fails confirmation
 *   worker-stalls-before-swap       record written, selector not yet switched
 *   worker-stalls-after-swap        selector switched, record still `switching`
 *   worker-stalls-confirming        record `confirming`, step lock released
 *
 * A stalled worker writes its pid to `<control>.reached` and waits to be
 * killed.
 */
declare const LAZURIO_TEST_CONTROL: string | undefined;
const controlPath =
  typeof LAZURIO_TEST_CONTROL === "string" ? LAZURIO_TEST_CONTROL : undefined;
let control = "";
try {
  if (controlPath) control = readFileSync(controlPath, "utf8").trim();
} catch {
  // No control file: behave exactly like the product.
}
const stall = (): Promise<never> => {
  writeFileSync(`${controlPath}.reached`, String(process.pid));
  return new Promise<never>(() => {
    setInterval(() => undefined, 1_000);
  });
};
const args = process.argv.slice(2);
try {
  if (args[0] === "self-check") {
    if (control === "self-check-fails") process.exit(1);
    if (
      control === "self-check-fails-via-selector" &&
      process.argv0.endsWith("/bin/lazurio")
    )
      process.exit(1);
  }
  if (
    args[0] === "update" &&
    args[1] === "apply-worker" &&
    control.startsWith("worker-stalls-")
  ) {
    const output = await runUpdateCommand(args.slice(1), {
      activationEffects: {
        async swapSelector(base, name) {
          if (control === "worker-stalls-before-swap") await stall();
          await swapSelector(base, name);
          if (control === "worker-stalls-after-swap") await stall();
        },
        async run(command, timeoutMs, env) {
          if (control === "worker-stalls-confirming") await stall();
          return runProcess(command, timeoutMs, env);
        },
      },
    });
    console.log(output.stdout);
    process.exit(output.code);
  }
  process.exitCode = await runCli(args);
} catch {
  process.exitCode = 1;
}
