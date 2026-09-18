// Synthetic child only; never loads a real module, environment or credentials.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("fixture"),
});
process.stdout.write(`${server.port}\n`);
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
