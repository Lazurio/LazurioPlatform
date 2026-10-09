// One call of the Launchpad's Executor client in a process of its own, for
// tests/integrations-executor.test.ts: the test gives this process proxy
// variables that its own process must never carry (Bun's `fetch` keeps the
// proxy it once read, so a later test would be sent to a stopped proxy).
// Arguments: Executor's data directory and its port; the listener counts as
// this account's. Prints the call's result as one JSON line.
import { executorCall } from "../../src/integrations/executor-client";

const [dataDir, port] = process.argv.slice(2);
const result = await executorCall(
  {
    dataDir: dataDir ?? "",
    port: Number(port),
    uid: process.getuid?.() ?? 0,
    ownsListener: async () => true,
  },
  "GET",
  "/connections",
);
console.log(JSON.stringify(result));
