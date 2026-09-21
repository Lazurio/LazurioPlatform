// Synthetic service application: no ambient credentials or Organization data.
// Reports only environment variable NAMES and its own arguments, and owns one
// descendant in a separate session so that only a control-group stop reaches it.
if (process.env.FIXTURE_EXIT) process.exit(Number(process.env.FIXTURE_EXIT));
const descendant = Bun.spawn(["/usr/bin/setsid", "/usr/bin/sleep", "600"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.FIXTURE_PORT),
  fetch: (request) =>
    new URL(request.url).pathname === "/evidence"
      ? Response.json({
          environment: Object.keys(process.env).sort(),
          arguments: process.argv.slice(2),
          descendant: descendant.pid,
          umask: process.umask().toString(8),
        })
      : new Response("synthetic service application"),
});
