import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** FIXTURE ONLY. A loopback stand-in for the release origin, serving a tree
 * written by `scripts/update-fixture.ts` (`<tree>/<tag>/<asset>`, and the text
 * file `<tree>/latest` naming the tag `latest` points at) the way GitHub does:
 *
 *   /releases/latest/download/<asset>  -> 302 /releases/download/<tag>/<asset>
 *   /releases/download/<tag>/<asset>   -> 302 /storage/<tag>/<asset>
 *   /storage/<tag>/<asset>             -> the bytes
 *
 * Tests run it in-process and may intercept a request; the qualification
 * bundle compiles this file and runs it on the Linux Machine.
 */
export type FixtureOrigin = Readonly<{
  baseUrl: string;
  /** Paths requested so far, in order. */
  requests: readonly string[];
  close(): Promise<void>;
}>;

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createFixtureOrigin(input: {
  tree: string;
  port?: number;
  /** Answer instead of the tree; return undefined to let the tree answer. */
  intercept?: (
    path: string,
  ) => Response | undefined | Promise<Response | undefined>;
}): FixtureOrigin {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const intercepted = await input.intercept?.(url.pathname);
      if (intercepted) return intercepted;
      const parts = url.pathname.split("/").slice(1);
      if (parts.slice(1).some((part) => !segment.test(part)))
        return new Response(null, { status: 404 });
      const redirect = (path: string) =>
        new Response(null, {
          status: 302,
          headers: { location: `${url.origin}${path}` },
        });
      if (
        parts.length === 4 &&
        parts[0] === "releases" &&
        parts[1] === "latest" &&
        parts[2] === "download"
      ) {
        const tag = await readFile(join(input.tree, "latest"), "utf8").catch(
          () => undefined,
        );
        return tag === undefined
          ? new Response(null, { status: 404 })
          : redirect(`/releases/download/${tag.trim()}/${parts[3]}`);
      }
      if (
        parts.length === 4 &&
        parts[0] === "releases" &&
        parts[1] === "download"
      )
        return redirect(`/storage/${parts[2]}/${parts[3]}`);
      if (parts.length === 3 && parts[0] === "storage") {
        const file = Bun.file(join(input.tree, parts[1] ?? "", parts[2] ?? ""));
        return (await file.exists())
          ? new Response(file)
          : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    },
  });
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    async close() {
      await server.stop(true);
    },
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { tree: { type: "string" }, port: { type: "string" } },
  });
  if (!values.tree || !/^[1-9][0-9]{1,4}$/.test(values.port ?? ""))
    throw new Error("Usage: --tree <directory> --port <port>");
  const origin = createFixtureOrigin({
    tree: values.tree,
    port: Number(values.port),
  });
  console.log(`FIXTURE release origin on ${origin.baseUrl}`);
}
