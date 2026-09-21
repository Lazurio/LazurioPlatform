import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** FIXTURE ONLY. A loopback stand-in for the release origin, serving a tree
 * written by `scripts/update-fixture.ts` (`<tree>/<tag>/<asset>`, and the text
 * file `<tree>/latest` naming the tag `latest` points at) in GitHub's real
 * multi-hop shape — verified read-only against a public release:
 *
 *   origin  /releases/latest/download/<asset> -> 302 origin /releases/download/<tag>/<asset>
 *   origin  /releases/download/<tag>/<asset>  -> 302 STORAGE /release-asset/<opaque>?sig=…
 *   storage /release-asset/<opaque>           -> the bytes
 *
 * Storage is ANOTHER listener (GitHub's is another host), and its URL names
 * neither the repository nor the tag: whoever reads the tag anywhere but in
 * the FIRST redirect finds nothing. Tests run it in-process and may intercept
 * a request; the qualification bundle compiles this file and runs it on the
 * Linux Machine.
 */
export type FixtureOrigin = Readonly<{
  baseUrl: string;
  storageUrl: string;
  /** Requests so far, in order: origin paths as requested, and storage
   * requests under the logical name `/storage/<tag>/<asset>`. */
  requests: readonly string[];
  close(): Promise<void>;
}>;

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const opaque = (tag: string, asset: string) =>
  Buffer.from(`${tag}/${asset}`).toString("hex");

export function createFixtureOrigin(input: {
  tree: string;
  port?: number;
  storagePort?: number;
  /** Answer instead of the tree; return undefined to let the tree answer. */
  intercept?: (
    path: string,
  ) => Response | undefined | Promise<Response | undefined>;
}): FixtureOrigin {
  const requests: string[] = [];
  const storage = Bun.serve({
    hostname: "127.0.0.1",
    port: input.storagePort ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const token = /^\/release-asset\/([0-9a-f]+)$/.exec(url.pathname)?.[1];
      const [tag, asset, ...rest] = Buffer.from(token ?? "", "hex")
        .toString()
        .split("/");
      if (
        !tag ||
        !asset ||
        rest.length > 0 ||
        !segment.test(tag) ||
        !segment.test(asset) ||
        !url.searchParams.has("sig")
      )
        return new Response(null, { status: 404 });
      const logical = `/storage/${tag}/${asset}`;
      requests.push(logical);
      const intercepted = await input.intercept?.(logical);
      if (intercepted) return intercepted;
      const file = Bun.file(join(input.tree, tag, asset));
      return (await file.exists())
        ? new Response(file)
        : new Response(null, { status: 404 });
    },
  });
  const storageUrl = `http://127.0.0.1:${storage.port}`;
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
      const redirect = (location: string) =>
        new Response(null, { status: 302, headers: { location } });
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
          : redirect(
              `${url.origin}/releases/download/${tag.trim()}/${parts[3]}`,
            );
      }
      if (
        parts.length === 4 &&
        parts[0] === "releases" &&
        parts[1] === "download"
      )
        return redirect(
          `${storageUrl}/release-asset/${opaque(parts[2] ?? "", parts[3] ?? "")}?sig=fixture`,
        );
      return new Response(null, { status: 404 });
    },
  });
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.port}`,
    storageUrl,
    requests,
    async close() {
      await server.stop(true);
      await storage.stop(true);
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
    storagePort: Number(values.port) + 1,
  });
  console.log(
    `FIXTURE release origin on ${origin.baseUrl}, asset storage on ${origin.storageUrl}`,
  );
}
