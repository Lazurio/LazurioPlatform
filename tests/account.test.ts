import { expect, test } from "bun:test";
import {
  accountDocumentPath,
  accountWriter,
  createAccountFavourites,
  favouritePath,
  parseAccount,
  readAccount,
} from "../src/launchpad/account";

// Root decision 0185 S12 and S18 (F37's account namespace): Apps reads the
// person's account from its own origin, `lazurio.account.v1`, only for where
// module apps open and the favourites of its Organization; when the account
// cannot be read (404 until the gateway relays it, a refusal, a slow answer)
// today's behaviour stays. Favourites are written at once and put back when
// the account does not take them.

const document = (extra: Record<string, unknown> = {}) => ({
  schema: "lazurio.account.v1",
  preferences: { openApps: "same" },
  favourites: {
    example: [
      { kind: "module", id: "deals" },
      { kind: "repository", id: "firmware" },
      { kind: "module", id: "knowledgebase" },
    ],
  },
  // Members Apps does not read: the shell library's.
  environments: [{ id: "vm-01" }],
  organizations: [],
  last: null,
  ...extra,
});

test("the account document: where apps open and the Organization's favourites, in the account's order", () => {
  const account = parseAccount(document());
  expect(account?.openApps).toBe("same");
  expect(account?.favourites.get("example")).toEqual([
    "m:deals",
    "r:firmware",
    "m:knowledgebase",
  ]);
  // Looked up by the slug whatever its case; a missing slug has none.
  expect(
    parseAccount(document({ favourites: { Example: [] } }))?.favourites.has(
      "example",
    ),
  ).toBe(true);
  expect(account?.favourites.get("northwind")).toBeUndefined();
});

test("read defensively: another schema is no account; anything else odd is the default", () => {
  expect(parseAccount(null)).toBeNull();
  expect(parseAccount([])).toBeNull();
  expect(parseAccount(document({ schema: "lazurio.shell.v1" }))).toBeNull();
  expect(parseAccount(document({ schema: undefined }))).toBeNull();
  for (const preferences of [
    { openApps: "frame" },
    { openApps: "SAME" },
    {},
    null,
    "same",
  ])
    expect(parseAccount(document({ preferences }))?.openApps).toBe("tab");
  expect(parseAccount(document({ preferences: undefined }))?.openApps).toBe(
    "tab",
  );
  const odd = parseAccount(
    document({
      favourites: {
        example: [
          { kind: "module", id: "deals" },
          { kind: "module", id: "deals" },
          { kind: "app", id: "x" },
          { kind: "module", id: "../etc" },
          { kind: "module", id: 7 },
          "m:orders",
          null,
          { kind: "repository", id: "connect" },
        ],
        broken: "not a list",
      },
    }),
  );
  expect(odd?.favourites.get("example")).toEqual(["m:deals", "r:connect"]);
  expect(odd?.favourites.get("broken")).toEqual([]);
  expect(
    parseAccount(document({ favourites: ["m:deals"] }))?.favourites.size,
  ).toBe(0);
});

const answer = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("read once from the page's own origin, without a token and never following a sign-in", async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const account = await readAccount(async (path, init) => {
    seen.push({ path, init });
    return answer(200, document());
  });
  expect(account?.openApps).toBe("same");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.path).toBe(accountDocumentPath);
  expect(seen[0]?.path).toBe("/.lazurio/account/environments");
  expect(seen[0]?.init.credentials).toBe("same-origin");
  expect(seen[0]?.init.redirect).toBe("error");
  expect(new Headers(seen[0]?.init.headers).has("authorization")).toBe(false);
});

test("unavailable is null, so today's behaviour stays: 404, a refusal, another schema, not JSON, a network error", async () => {
  for (const response of [
    answer(404, { error: "not-found" }),
    answer(401, { error: "denied" }),
    answer(502, "bad gateway"),
    answer(200, document({ schema: "lazurio.shell.v1" })),
    answer(200, "<!doctype html><title>Launchpad</title>"),
  ])
    expect(await readAccount(async () => response)).toBeNull();
  expect(
    await readAccount(async () => {
      throw new TypeError("redirect");
    }),
  ).toBeNull();
});

test("a slow account is given up after the timeout and is null", async () => {
  let aborted = false;
  const started = Date.now();
  const account = await readAccount(
    (_path, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    50,
  );
  expect(account).toBeNull();
  expect(aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("the path of one favourite, only with segments the gateway passes", () => {
  expect(favouritePath("example", "m:deals")).toBe(
    "/.lazurio/account/favourites/example/module/deals",
  );
  expect(favouritePath("Example-Co.v2", "r:firmware")).toBe(
    "/.lazurio/account/favourites/Example-Co.v2/repository/firmware",
  );
  expect(favouritePath("example", "x:deals")).toBeNull();
  expect(favouritePath("ex ample", "m:deals")).toBeNull();
  expect(favouritePath("example/other", "m:deals")).toBeNull();
  expect(favouritePath("..", "m:deals")).toBeNull();
  expect(favouritePath("example", "m:..")).toBeNull();
  expect(favouritePath("příklad", "m:deals")).toBeNull();
});

test("a write is a plain same-origin JSON request; anything but success is not taken", async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const write = accountWriter(async (path, init) => {
    seen.push({ path, init });
    return new Response(null, { status: 204 });
  });
  expect(
    await write("PUT", "/.lazurio/account/favourites/example/module/deals"),
  ).toBe(true);
  expect(seen[0]?.init.method).toBe("PUT");
  expect(seen[0]?.init.credentials).toBe("same-origin");
  expect(new Headers(seen[0]?.init.headers).get("content-type")).toBe(
    "application/json",
  );
  expect(await accountWriter(async () => answer(422, {}))("DELETE", "/x")).toBe(
    false,
  );
  expect(
    await accountWriter(async () => {
      throw new TypeError("offline");
    })("DELETE", "/x"),
  ).toBe(false);
  expect(
    await accountWriter(
      (_path, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
      30,
    )("PUT", "/x"),
  ).toBe(false);
});

test("a star shows at once and is written: PUT appends at the end, DELETE removes", async () => {
  const writes: string[] = [];
  const favourites = createAccountFavourites(
    parseAccount(document())?.favourites ?? new Map(),
    async (method, path) => {
      writes.push(`${method} ${path}`);
      return true;
    },
  );
  const adding = favourites.toggle("example", "m:orders");
  // Optimistic: before the account answers.
  expect(favourites.list("example")).toEqual([
    "m:deals",
    "r:firmware",
    "m:knowledgebase",
    "m:orders",
  ]);
  expect(await adding).toBe(true);
  expect(await favourites.toggle("Example", "r:firmware")).toBe(true);
  expect(favourites.list("example")).toEqual([
    "m:deals",
    "m:knowledgebase",
    "m:orders",
  ]);
  expect(writes).toEqual([
    "PUT /.lazurio/account/favourites/example/module/orders",
    "DELETE /.lazurio/account/favourites/Example/repository/firmware",
  ]);
});

test("a write the account does not take is put back in its place", async () => {
  const favourites = createAccountFavourites(
    parseAccount(document())?.favourites ?? new Map(),
    async () => false,
  );
  const removing = favourites.toggle("example", "r:firmware");
  expect(favourites.list("example")).toEqual(["m:deals", "m:knowledgebase"]);
  expect(await removing).toBe(false);
  expect(favourites.list("example")).toEqual([
    "m:deals",
    "r:firmware",
    "m:knowledgebase",
  ]);
  expect(await favourites.toggle("example", "m:orders")).toBe(false);
  expect(favourites.list("example")).toEqual([
    "m:deals",
    "r:firmware",
    "m:knowledgebase",
  ]);
  // A favourite the gateway could not carry is never sent and is put back.
  const unsent: string[] = [];
  const odd = createAccountFavourites(new Map(), async (_method, path) => {
    unsent.push(path);
    return true;
  });
  expect(await odd.toggle("ex ample", "m:deals")).toBe(false);
  expect(odd.list("ex ample")).toEqual([]);
  expect(unsent).toEqual([]);
});

// Clicks on one favourite while its writes are under way (Pablo's review of
// #159): one write per favourite at a time, in the order of the clicks, so
// the account ends as the last click wants; a failure is put back only when
// no later click wants something else, and a later success stands.
type Write = { method: string; path: string; answer: (ok: boolean) => void };
function pendingWrites(initial: ReadonlyMap<string, readonly string[]>) {
  const writes: Write[] = [];
  const favourites = createAccountFavourites(
    initial,
    (method, path) =>
      new Promise<boolean>((answer) => writes.push({ method, path, answer })),
  );
  return { writes, favourites };
}
const settle = () => new Promise((done) => setTimeout(done, 0));
const methods = (writes: readonly Write[]) =>
  writes.map((write) => write.method);

test("three quick clicks starring a favourite: the first failure does not undo the last click", async () => {
  const { writes, favourites } = pendingWrites(new Map());
  const clicks = [1, 2, 3].map(() => favourites.toggle("example", "m:deals"));
  // Visibly starred at once; one write is under way, the rest wait for it.
  expect(favourites.list("example")).toEqual(["m:deals"]);
  expect(methods(writes)).toEqual(["PUT"]);
  writes[0]?.answer(false);
  await settle();
  // The last click still wants the star: it stays and is written again.
  expect(favourites.list("example")).toEqual(["m:deals"]);
  expect(methods(writes)).toEqual(["PUT", "PUT"]);
  writes[1]?.answer(true);
  expect(await Promise.all(clicks)).toEqual([true, true, true]);
  expect(favourites.list("example")).toEqual(["m:deals"]);
  expect(writes[1]?.path).toBe(
    "/.lazurio/account/favourites/example/module/deals",
  );
});

test("three quick clicks unstarring a favourite: it ends unstarred", async () => {
  const { writes, favourites } = pendingWrites(
    new Map([["example", ["m:deals", "m:orders"]]]),
  );
  const clicks = [1, 2, 3].map(() => favourites.toggle("example", "m:deals"));
  expect(favourites.list("example")).toEqual(["m:orders"]);
  expect(methods(writes)).toEqual(["DELETE"]);
  writes[0]?.answer(false);
  await settle();
  expect(favourites.list("example")).toEqual(["m:orders"]);
  expect(methods(writes)).toEqual(["DELETE", "DELETE"]);
  writes[1]?.answer(true);
  expect(await Promise.all(clicks)).toEqual([true, true, true]);
  expect(favourites.list("example")).toEqual(["m:orders"]);
});

test("a click undone before its write answers sends nothing more", async () => {
  const { writes, favourites } = pendingWrites(new Map());
  const clicks = [
    favourites.toggle("example", "m:deals"),
    favourites.toggle("example", "m:deals"),
  ];
  expect(favourites.list("example")).toEqual([]);
  // The account took the star the person no longer wants: it is taken back.
  writes[0]?.answer(true);
  await settle();
  expect(methods(writes)).toEqual(["PUT", "DELETE"]);
  writes[1]?.answer(true);
  expect(await Promise.all(clicks)).toEqual([true, true]);
  expect(favourites.list("example")).toEqual([]);
  // Refused instead: what the account holds is what the person wants.
  const refused = pendingWrites(new Map());
  const again = [
    refused.favourites.toggle("example", "m:deals"),
    refused.favourites.toggle("example", "m:deals"),
  ];
  refused.writes[0]?.answer(false);
  expect(await Promise.all(again)).toEqual([true, true]);
  expect(methods(refused.writes)).toEqual(["PUT"]);
  expect(refused.favourites.list("example")).toEqual([]);
});

test("the last click's failure puts back what the account holds, in its place", async () => {
  const { writes, favourites } = pendingWrites(new Map());
  const first = favourites.toggle("example", "m:deals");
  const second = favourites.toggle("example", "m:deals");
  writes[0]?.answer(true);
  await settle();
  // The account holds the star; taking it back fails and no click follows.
  expect(methods(writes)).toEqual(["PUT", "DELETE"]);
  writes[1]?.answer(false);
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(favourites.list("example")).toEqual(["m:deals"]);
  // A favourite removed and starred again while the removal fails stays
  // where the account keeps it, not at the end.
  const placed = pendingWrites(new Map([["example", ["m:a", "m:b", "m:c"]]]));
  const out = placed.favourites.toggle("example", "m:b");
  const back = placed.favourites.toggle("example", "m:b");
  expect(placed.favourites.list("example")).toEqual(["m:a", "m:c", "m:b"]);
  placed.writes[0]?.answer(false);
  expect(await Promise.all([out, back])).toEqual([true, true]);
  expect(methods(placed.writes)).toEqual(["DELETE"]);
  expect(placed.favourites.list("example")).toEqual(["m:a", "m:b", "m:c"]);
});

test("two favourites are written independently", async () => {
  const { writes, favourites } = pendingWrites(new Map());
  const deals = favourites.toggle("example", "m:deals");
  const orders = favourites.toggle("example", "m:orders");
  // Neither waits for the other.
  expect(writes.map((write) => write.path)).toEqual([
    "/.lazurio/account/favourites/example/module/deals",
    "/.lazurio/account/favourites/example/module/orders",
  ]);
  writes[1]?.answer(false);
  expect(await orders).toBe(false);
  expect(favourites.list("example")).toEqual(["m:deals"]);
  writes[0]?.answer(true);
  expect(await deals).toBe(true);
  expect(favourites.list("example")).toEqual(["m:deals"]);
  // The same id in another Organization is another favourite.
  const other = favourites.toggle("other", "m:deals");
  expect(writes).toHaveLength(3);
  writes[2]?.answer(true);
  expect(await other).toBe(true);
  expect(favourites.list("other")).toEqual(["m:deals"]);
  expect(favourites.list("example")).toEqual(["m:deals"]);
});
