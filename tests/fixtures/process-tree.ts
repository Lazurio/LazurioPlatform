// Invented cooperative process tree. The child inherits the launcher's group.
if (process.argv[2] === "--child") {
  let terms = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/failure")
        return new Response("fixture unavailable", { status: 503 });
      if (process.argv[4] === "slow") {
        await Bun.write(
          `${process.argv[3]}.request`,
          JSON.stringify({ pid: process.pid, port: server.port }),
        );
        await Bun.sleep(1000);
      }
      return Response.json({ terms });
    },
  });
  if (process.argv[4] === "ignore" || process.argv[4]?.startsWith("exit-"))
    process.on("SIGTERM", () => {
      terms++;
    });
  await Bun.write(
    process.argv[3] as string,
    JSON.stringify({ pid: process.pid, port: server.port }),
  );
} else {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      import.meta.path,
      "--child",
      process.argv[2] as string,
      process.argv[3] ?? "normal",
    ],
    { env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if (process.argv[3] === "ignore") process.on("SIGTERM", () => {});
  else if (process.argv[3] === "exit-grace")
    process.on("SIGTERM", () => process.exit(9));
  else
    process.on("SIGTERM", () => {
      void child.exited.then(() => process.exit(0));
    });
  if (process.argv[3] === "exit-before") {
    while (!(await Bun.file(process.argv[2] as string).exists()))
      await Bun.sleep(10);
    process.exit(9);
  }
  await child.exited;
}
