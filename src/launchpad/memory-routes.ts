import {
  createGbrainReader,
  type MemoryFault,
  type MemoryHost,
  MemoryUnavailable,
} from "../memory/gbrain-reader";
import {
  isMemorySlug,
  type MemoryGraph,
  type MemoryPage,
  readMemoryGraph,
  readMemoryPage,
} from "../memory/graph";

// Apps → Brain, the map of the person's memory (plan LZD-0033 R11b; "Brain"
// is a working name, so code and paths say "memory"): behind the admission
// of every `/api/*` route, only on a Personal Environment (elsewhere both
// answer 404 `memory-absent`, as the page has no item there), read only:
//
//   GET /api/memory              the map: its pages and links, or why there
//                                is none (`state`)
//   GET /api/memory/page?slug=…  one page for the panel: its text, the facts
//                                GBrain keeps about it, links and backlinks
//
// GBrain's key never leaves this server (memory/gbrain-reader.ts).

export const memoryRoutePaths = Object.freeze({
  map: "/api/memory",
  page: "/api/memory/page",
});

/** `GET /api/memory`. `empty`: GBrain answers and has no page yet. */
export type MemoryAnswer =
  | (Readonly<{ kind: "memory"; state: "ready" }> & MemoryGraph)
  | Readonly<{ kind: "memory"; state: "empty" | MemoryFault }>;

/** `GET /api/memory/page`. */
export type MemoryPageAnswer =
  | (Readonly<{ kind: "memory-page"; state: "ready" }> & MemoryPage)
  | Readonly<{ kind: "memory-page"; state: "missing" | MemoryFault }>;

/** How long one reading of the map serves the page (and its Refresh, which
 * asks again only after it). */
const mapTtlMs = 15_000;

export function createMemoryRoutes(
  input: Readonly<{
    /** Whether this Environment has the item at all: a Personal one. */
    here: () => Promise<boolean>;
    host: () => MemoryHost;
    headers: Readonly<Record<string, string>>;
    now?: () => number;
  }>,
) {
  const now = input.now ?? Date.now;
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  let kept: Readonly<{ at: number; answer: MemoryAnswer }> | null = null;
  let reading: Promise<MemoryAnswer> | null = null;

  async function readMap(): Promise<MemoryAnswer> {
    try {
      const graph = await readMemoryGraph(createGbrainReader(input.host()));
      return graph.nodes.length === 0
        ? { kind: "memory", state: "empty" }
        : { kind: "memory", state: "ready", ...graph };
    } catch (error) {
      return {
        kind: "memory",
        state: error instanceof MemoryUnavailable ? error.fault : "failed",
      };
    }
  }

  /** The map, one reading at a time and kept a little while; a fault is
   * never kept, so the next look asks again. */
  async function map(fresh: boolean): Promise<MemoryAnswer> {
    if (!fresh && kept !== null && now() - kept.at < mapTtlMs)
      return kept.answer;
    reading ??= readMap().finally(() => {
      reading = null;
    });
    const answer = await reading;
    kept =
      answer.state === "ready" || answer.state === "empty"
        ? { at: now(), answer }
        : null;
    return answer;
  }

  async function page(slug: string): Promise<MemoryPageAnswer> {
    try {
      const found = await readMemoryPage(
        createGbrainReader(input.host()),
        slug,
      );
      return found === null
        ? { kind: "memory-page", state: "missing" }
        : { kind: "memory-page", state: "ready", ...found };
    } catch (error) {
      return {
        kind: "memory-page",
        state: error instanceof MemoryUnavailable ? error.fault : "failed",
      };
    }
  }

  return Object.freeze({
    handles: (path: string) =>
      path === memoryRoutePaths.map || path === memoryRoutePaths.page,
    async handle(request: Request, url: URL): Promise<Response> {
      if (request.method !== "GET")
        return response({ error: "method-not-allowed" }, 405);
      if (!(await input.here()))
        return response({ error: "memory-absent" }, 404);
      const keys = [...url.searchParams.keys()];
      if (url.pathname === memoryRoutePaths.map) {
        const fresh = url.searchParams.get("fresh");
        if (
          keys.some((key) => key !== "fresh") ||
          (fresh !== null && fresh !== "1")
        )
          return response({ error: "invalid-query" }, 400);
        return response(await map(fresh === "1"));
      }
      const slug = url.searchParams.get("slug");
      if (
        keys.length !== 1 ||
        url.searchParams.getAll("slug").length !== 1 ||
        slug === null ||
        !isMemorySlug(slug)
      )
        return response({ error: "invalid-query" }, 400);
      return response(await page(slug));
    },
  });
}
