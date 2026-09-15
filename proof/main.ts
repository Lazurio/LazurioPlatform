import { parseArgs } from "node:util";
import { preview } from "./core";
import index from "./index.html";

try {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      purpose: { type: "string" },
      detail: { type: "string" },
      coordination: { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !["preview", "serve"].includes(positionals[0] ?? "")
  )
    throw new Error(
      "Use preview or serve with --purpose --detail --coordination",
    );
  const result = preview(values);
  if (positionals[0] === "preview") console.log(JSON.stringify(result));
  else {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
      routes: { "/": index, "/status": { GET: () => Response.json(result) } },
      fetch: () => new Response("Not found", { status: 404 }),
    });
    console.log(JSON.stringify({ url: server.url.href }));
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        server.stop(true);
        process.exit(0);
      });
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Invalid request",
    }),
  );
  process.exitCode = 1;
}
