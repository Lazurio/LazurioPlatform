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

test("a failed write does not undo a later click on the same favourite", async () => {
  const pending: ((ok: boolean) => void)[] = [];
  const favourites = createAccountFavourites(
    new Map(),
    () => new Promise<boolean>((resolve) => pending.push(resolve)),
  );
  const first = favourites.toggle("example", "m:deals");
  const second = favourites.toggle("example", "m:deals");
  expect(favourites.list("example")).toEqual([]);
  pending[0]?.(false);
  pending[1]?.(true);
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(favourites.list("example")).toEqual([]);
});
