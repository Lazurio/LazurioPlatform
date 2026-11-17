import { expect, test } from "bun:test";
import { createMemoryRoutes } from "../src/launchpad/memory-routes";
import {
  createGbrainReader,
  isLoopbackUrl,
  type MemoryHost,
  parseHandover,
  rpcEnvelope,
} from "../src/memory/gbrain-reader";
import {
  isMemorySlug,
  readMemoryGraph,
  readMemoryPage,
  splitFacts,
} from "../src/memory/graph";

// A fake GBrain: the stateless MCP endpoint of `gbrain serve --http` as
// v0.60.315.0 answers it (tool results as one SSE `message`, list_pages
// paged by `_meta.pagination.truncated`, links cut with `next_cursor`).
// Synthetic pages only.

const token = "test-read-key-0123456789abcdef";
const handover = JSON.stringify({ url: "http://127.0.0.1:47311", token });

type Page = Readonly<{
  slug: string;
  title: string;
  type: string;
  links: readonly string[];
  body?: string;
  tags?: readonly string[];
}>;

function fakeGbrain(
  pages: readonly Page[],
  options: Readonly<{
    status?: number;
    down?: boolean;
    refuse?: string;
    /** One tool refuses with this code; the others answer. */
    refuseTool?: Readonly<{ tool: string; code: string }>;
    json?: boolean;
  }> = {},
) {
  const calls: string[] = [];
  const result = (value: unknown, meta?: unknown, isError = false) => ({
    ...(meta === undefined ? {} : { _meta: meta }),
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  });
  const fetch = async (url: string, init: RequestInit) => {
    if (options.down) throw new TypeError("connection refused");
    expect(url).toBe("http://127.0.0.1:47311/mcp");
    const headers = init.headers as Record<string, string>;
    if (headers.authorization !== `Bearer ${token}`)
      return new Response("unauthorized", { status: 401 });
    if (options.status !== undefined)
      return new Response("nope", { status: options.status });
    const request = JSON.parse(String(init.body));
    const { name, arguments: args } = request.params;
    calls.push(name);
    let answer: unknown;
    if (options.refuse !== undefined)
      answer = result({ code: options.refuse }, undefined, true);
    else if (options.refuseTool?.tool === name)
      answer = result({ code: options.refuseTool?.code }, undefined, true);
    else if (name === "list_pages") {
      const offset = args.offset ?? 0;
      const slice = pages.slice(offset, offset + args.limit);
      answer = result(
        slice.map((page) => ({
          slug: page.slug,
          source_id: "default",
          type: page.type,
          title: page.title,
          updated_at_iso: "2026-11-17T11:00:00.000000Z",
        })),
        {
          pagination: {
            truncated: offset + args.limit < pages.length,
            limit: args.limit,
          },
        },
      );
    } else if (name === "get_links" || name === "get_backlinks") {
      const rows =
        name === "get_links"
          ? (pages.find((page) => page.slug === args.slug)?.links ?? []).map(
              (to) => ({ from_slug: args.slug, to_slug: to }),
            )
          : pages
              .filter((page) => page.links.includes(args.slug))
              .map((page) => ({ from_slug: page.slug, to_slug: args.slug }));
      // One row per call, so the cursor is followed.
      const start = args.cursor === undefined ? 0 : Number(args.cursor);
      const row = rows[start];
      answer = result(
        row === undefined
          ? []
          : [
              start + 1 < rows.length
                ? { ...row, truncated: true, next_cursor: String(start + 1) }
                : row,
            ],
      );
    } else if (name === "get_page") {
      const page = pages.find((item) => item.slug === args.slug);
      answer =
        page === undefined
          ? result({ code: "page_not_found" }, undefined, true)
          : result({
              slug: page.slug,
              title: page.title,
              type: page.type,
              tags: page.tags ?? [],
              compiled_truth: page.body ?? "",
              updated_at: "2026-11-17T11:00:00.000Z",
            });
    } else answer = result({ code: "unknown_tool" }, undefined, true);
    const envelope = { result: answer, jsonrpc: "2.0", id: request.id };
    return options.json
      ? Response.json(envelope)
      : new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
  };
  return { fetch, calls };
}

const host = (
  fake: ReturnType<typeof fakeGbrain>,
  over: Partial<{ handover: string | null; installed: boolean }> = {},
): MemoryHost => ({
  handover: async () =>
    over.handover === undefined ? handover : over.handover,
  installed: async () => over.installed ?? true,
  fetch: fake.fetch,
});

const sample: readonly Page[] = [
  {
    slug: "people/bob",
    title: "Bob",
    type: "person",
    links: ["companies/example", "people/alena", "projects/later"],
  },
  {
    slug: "people/alena",
    title: "Alena",
    type: "person",
    links: ["companies/example", "people/alena"],
  },
  { slug: "companies/example", title: "Example", type: "company", links: [] },
];

test("the map is every page and the links between them, once per direction", async () => {
  const graph = await readMemoryGraph(
    createGbrainReader(host(fakeGbrain(sample))),
  );
  expect(graph.nodes.map((node) => node.id)).toEqual([
    "people/bob",
    "people/alena",
    "companies/example",
  ]);
  expect(graph.nodes[0]).toEqual({
    id: "people/bob",
    title: "Bob",
    type: "person",
    updated: "2026-11-17T11:00:00.000000Z",
  });
  // A link to a page the map does not have and a link to itself are left
  // out; links cut across calls are followed.
  expect(graph.links).toEqual([
    { source: "people/bob", target: "companies/example" },
    { source: "people/bob", target: "people/alena" },
    { source: "people/alena", target: "companies/example" },
  ]);
  expect(graph.truncated).toBe(false);
});

test("pages are read in pages of a hundred, and plain JSON answers too", async () => {
  const many = Array.from({ length: 230 }, (_, index) => ({
    slug: `notes/n${String(index).padStart(3, "0")}`,
    title: `N${index}`,
    type: "note",
    links: index > 0 ? [`notes/n${String(index - 1).padStart(3, "0")}`] : [],
  }));
  const fake = fakeGbrain(many, { json: true });
  const graph = await readMemoryGraph(createGbrainReader(host(fake)));
  expect(graph.nodes).toHaveLength(230);
  expect(graph.links).toHaveLength(229);
  expect(fake.calls.filter((call) => call === "list_pages")).toHaveLength(3);
});

test("each way the map cannot be read is named", async () => {
  const read = (fake: ReturnType<typeof fakeGbrain>, over = {}) =>
    readMemoryGraph(createGbrainReader(host(fake, over))).then(
      () => "read",
      (error) => error.fault,
    );
  expect(
    await read(fakeGbrain(sample), { handover: null, installed: false }),
  ).toBe("absent");
  expect(await read(fakeGbrain(sample), { handover: null })).toBe("no-access");
  // A handover that names anything but the loopback is no access at all.
  expect(
    await read(fakeGbrain(sample), {
      handover: JSON.stringify({ url: "https://example.com", token }),
    }),
  ).toBe("no-access");
  expect(
    await read(fakeGbrain(sample), {
      handover: JSON.stringify({
        url: "http://127.0.0.1:47311",
        token: "x".repeat(20),
      }),
    }),
  ).toBe("no-access");
  expect(await read(fakeGbrain(sample, { refuse: "insufficient_scope" }))).toBe(
    "no-access",
  );
  expect(await read(fakeGbrain(sample, { down: true }))).toBe("unreachable");
  expect(await read(fakeGbrain(sample, { status: 500 }))).toBe("failed");
});

test("a page for the panel: its text without the facts fence, live facts, links both ways", async () => {
  const body = [
    "# Bob",
    "",
    "Bob vede [Example](../companies/example.md).",
    "",
    "## Facts",
    "",
    "<!--- gbrain:facts:begin -->",
    "| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |",
    "|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|",
    "| 1 | Nechce schůzky před devátou \\| ráno. | preference | 1.0 | world | medium | 2026-11-17T11:42:57Z |  | test |  |",
    "| 2 | ~~Bydlí v Brně~~ | fact | 1.0 | world | medium | 2026-01-01 |  | test | forgotten: x |",
    "| 3 | Soukromé | fact | 1.0 | private | medium | 2026-01-01 |  | test |  |",
    "| 4 | Prošlé | fact | 1.0 | world | medium | 2025-01-01 | 2025-06-01 | test |  |",
    "<!--- gbrain:facts:end -->",
  ].join("\n");
  const pages = sample.map((page) =>
    page.slug === "people/bob" ? { ...page, body, tags: ["vlastnik"] } : page,
  );
  const reader = createGbrainReader(host(fakeGbrain(pages)));
  const page = await readMemoryPage(reader, "people/bob");
  expect(page?.body).toBe(
    "# Bob\n\nBob vede [Example](../companies/example.md).",
  );
  expect(page?.facts).toEqual([
    {
      text: "Nechce schůzky před devátou | ráno.",
      kind: "preference",
      since: "2026-11-17T11:42:57Z",
    },
  ]);
  expect(page?.tags).toEqual(["vlastnik"]);
  expect(page?.links).toEqual([
    "companies/example",
    "people/alena",
    "projects/later",
  ]);
  expect(page?.backlinks).toEqual([]);
  expect((await readMemoryPage(reader, "people/alena"))?.backlinks).toEqual([
    "people/bob",
  ]);
  expect(await readMemoryPage(reader, "nobody/here")).toBeNull();
});

test("the small readers", () => {
  expect(isLoopbackUrl("http://127.0.0.1:3131")).toBe(true);
  expect(isLoopbackUrl("http://[::1]:3131")).toBe(true);
  expect(isLoopbackUrl("http://localhost:3131")).toBe(false);
  expect(isLoopbackUrl("https://127.0.0.1:3131")).toBe(false);
  expect(isLoopbackUrl("http://user:pw@127.0.0.1:3131")).toBe(false);
  expect(
    parseHandover(`{"url":"http://127.0.0.1:3131/","token":"${token}"}`),
  ).toEqual({
    url: "http://127.0.0.1:3131",
    token,
  });
  expect(parseHandover("not json")).toBeNull();
  expect(
    rpcEnvelope(
      'event: message\ndata: {"result":{},"id":1}\n\n',
      "text/event-stream",
    ),
  ).toEqual({ result: {}, id: 1 });
  expect(rpcEnvelope('{"result":{}}', "application/json")).toEqual({
    result: {},
  });
  expect(isMemorySlug("people/bob")).toBe(true);
  expect(isMemorySlug("/etc/passwd")).toBe(false);
  expect(isMemorySlug("a\nb")).toBe(false);
  expect(isMemorySlug("")).toBe(false);
  expect(splitFacts("# Jen text").facts).toEqual([]);
});

const routes = (
  fake: ReturnType<typeof fakeGbrain>,
  here = true,
  now = () => 0,
) =>
  createMemoryRoutes({
    here: async () => here,
    host: () => host(fake),
    headers: { "cache-control": "no-store" },
    now,
  });
const get = (
  memory: ReturnType<typeof createMemoryRoutes>,
  path: string,
  method = "GET",
) => {
  const url = new URL(path, "http://launchpad.test");
  return memory.handle(new Request(url, { method }), url);
};

test("GET /api/memory answers the map, kept a while; the page answers by slug", async () => {
  const fake = fakeGbrain(sample);
  let clock = 0;
  const memory = routes(fake, true, () => clock);
  const first = await (await get(memory, "/api/memory")).json();
  expect(first.state).toBe("ready");
  expect(first.nodes).toHaveLength(3);
  const calls = fake.calls.length;
  await get(memory, "/api/memory");
  expect(fake.calls.length).toBe(calls);
  clock = 20_000;
  await get(memory, "/api/memory");
  expect(fake.calls.length).toBeGreaterThan(calls);
  const page = await (
    await get(memory, "/api/memory/page?slug=people%2Fbob")
  ).json();
  expect(page).toMatchObject({
    kind: "memory-page",
    state: "ready",
    title: "Bob",
  });
  const missing = await (
    await get(memory, "/api/memory/page?slug=x%2Fy")
  ).json();
  expect(missing).toEqual({ kind: "memory-page", state: "missing" });
});

test("an empty memory and a fault are states, not errors", async () => {
  expect(
    await (await get(routes(fakeGbrain([])), "/api/memory")).json(),
  ).toEqual({
    kind: "memory",
    state: "empty",
  });
  expect(
    await (
      await get(routes(fakeGbrain(sample, { down: true })), "/api/memory")
    ).json(),
  ).toEqual({ kind: "memory", state: "unreachable" });
});

test("not on this Environment, a wrong method or query", async () => {
  const absent = await get(routes(fakeGbrain(sample), false), "/api/memory");
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: "memory-absent" });
  const memory = routes(fakeGbrain(sample));
  expect((await get(memory, "/api/memory", "POST")).status).toBe(405);
  expect((await get(memory, "/api/memory?x=1")).status).toBe(400);
  expect((await get(memory, "/api/memory/page")).status).toBe(400);
  expect((await get(memory, "/api/memory/page?slug=a&slug=b")).status).toBe(
    400,
  );
  expect((await get(memory, "/api/memory/page?slug=%2Fetc")).status).toBe(400);
  expect(memory.handles("/api/memory")).toBe(true);
  expect(memory.handles("/api/memory/x")).toBe(false);
});

test("only a missing page counts as missing; any other refusal is a failed reading", async () => {
  const read = (fake: ReturnType<typeof fakeGbrain>) =>
    readMemoryGraph(createGbrainReader(host(fake))).then(
      (graph) => `read ${graph.links.length}`,
      (error) => error.fault,
    );
  // A page gone between the listing and its links: read, without its links.
  expect(
    await read(
      fakeGbrain(sample, {
        refuseTool: { tool: "get_links", code: "page_not_found" },
      }),
    ),
  ).toBe("read 0");
  expect(
    await read(
      fakeGbrain(sample, {
        refuseTool: { tool: "get_links", code: "unknown_tool" },
      }),
    ),
  ).toBe("failed");
  const page = (fake: ReturnType<typeof fakeGbrain>) =>
    readMemoryPage(createGbrainReader(host(fake)), "people/bob").then(
      (found) => (found === null ? "missing" : "read"),
      (error) => error.fault,
    );
  expect(
    await page(
      fakeGbrain(sample, {
        refuseTool: { tool: "get_page", code: "page_not_found" },
      }),
    ),
  ).toBe("missing");
  expect(
    await page(
      fakeGbrain(sample, {
        refuseTool: { tool: "get_page", code: "internal_error" },
      }),
    ),
  ).toBe("failed");
  expect(
    await page(
      fakeGbrain(sample, {
        refuseTool: { tool: "get_backlinks", code: "unknown_tool" },
      }),
    ),
  ).toBe("failed");
});
