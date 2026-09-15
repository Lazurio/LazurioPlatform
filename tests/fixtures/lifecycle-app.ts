// Synthetic module app: no ambient credentials or real Organization data.
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.FIXTURE_PORT),
  fetch: () => new Response("synthetic module"),
});
