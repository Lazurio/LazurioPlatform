import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siblingOrigins } from "../src/modules/sibling-origins";
import { writeOrganization } from "./fixtures/catalog-folder";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";

// Which sibling modules a starting application gets an address for (root
// decision 0176, addendum of 2026-10-10; decision F26, addendum of
// 2026-10-10): exactly the `workspace/<slug>` modules of its own
// Organization it declares in `required_module_slots`, at the address their
// own declaration leases now. The consumer shape is a budgeting module that
// prices through a price-list module beside it. Synthetic names only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
let folder = "";
let gamma = "";
beforeAll(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), "sibling-origins-")));
  // gamma: `budgets` declares the price list, the stock module's data mount
  // only, a slot declared in the manifest but not checked out, a module only
  // another Organization has, itself, a root-level application slot and a
  // path into another Organization. `notes` is there, undeclared.
  gamma = await writeOrganization(folder, "gamma", {
    slug: "gamma",
    state: "current",
    modules: [
      {
        id: "budgets",
        runtime: {
          required_module_slots: [
            "workspace/prices",
            "workspace/stock/db",
            "workspace/absent",
            "workspace/remote",
            "workspace/budgets",
            "mission-control",
            "organizations/delta/workspace/remote",
          ],
        },
      },
      { id: "prices" },
      { id: "stock" },
      { id: "notes" },
      { id: "empty", apps: false },
      { id: "broken", broken: true },
      { id: "mission-control", path: "mission-control" },
    ],
    slots: [{ path: "workspace/absent", slug: "absent" }],
  });
  // delta: a module of the same name as gamma's price list, and one gamma
  // lacks; neither is ever gamma's sibling.
  await writeOrganization(folder, "delta", {
    slug: "delta",
    state: "current",
    modules: [{ id: "prices" }, { id: "remote" }],
  });
});
afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function lease(module: string, organization = gamma) {
  const manifest = JSON.parse(
    await readFile(
      join(organization, "workspace", module, "lazurio.module.json"),
      "utf8",
    ),
  );
  return manifest.port_leases[0] as { host: string; port: number };
}

async function moveLease(
  module: string,
  value: { host: string; port: number },
  organization = gamma,
) {
  const path = join(organization, "workspace", module, "lazurio.module.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.port_leases[0] = { id: "main", ...value };
  await writeFile(path, JSON.stringify(manifest));
}

const of = (slots: string[], module = "budgets") =>
  siblingOrigins({
    organizationDirectory: gamma,
    company: "gamma",
    module,
    slots,
  });

posixTest(
  "a declared sibling module of the same Organization: its default app's entrypoint, at its lease",
  async () => {
    const prices = await lease("prices");
    expect(await of(["workspace/prices"])).toEqual({
      prices: `http://127.0.0.1:${prices.port}`,
    });
  },
);

posixTest(
  "only `workspace/<slug>` of a module that is there with an HTTP default app: never a data mount, an undeclared, missing, app-less or broken module, the application itself, a root slot or another Organization's module",
  async () => {
    const prices = await lease("prices");
    const delta = join(folder, "organizations", "delta");
    expect((await lease("prices", delta)).port).not.toBe(prices.port);
    // The application's whole declaration: only the price list.
    expect(
      await of([
        "workspace/prices",
        "workspace/stock/db",
        "workspace/absent",
        "workspace/remote",
        "workspace/budgets",
        "mission-control",
        "organizations/delta/workspace/remote",
      ]),
    ).toEqual({ prices: `http://127.0.0.1:${prices.port}` });
    // Each refused form on its own.
    for (const slot of [
      "workspace/stock/db",
      "workspace/absent",
      "workspace/ghost",
      "workspace/remote",
      "workspace/empty",
      "workspace/broken",
      "workspace/budgets",
      "mission-control",
      "organizations/delta/workspace/remote",
      "workspace/prices/",
      "workspace/Prices",
    ])
      expect(await of([slot]), slot).toEqual({});
    // Undeclared modules of the Organization get nothing.
    expect(await of([])).toEqual({});
    // The application identity decides: a caller of another company gets
    // nothing from this Organization.
    expect(
      await siblingOrigins({
        organizationDirectory: gamma,
        company: "delta",
        module: "budgets",
        slots: ["workspace/prices"],
      }),
    ).toEqual({});
  },
);

posixTest(
  "read at every call: a moved lease is the next start's address; a loopback IPv6 lease is bracketed",
  async () => {
    const before = await lease("prices");
    try {
      await moveLease("prices", { host: "127.0.0.1", port: before.port + 50 });
      expect(await of(["workspace/prices"])).toEqual({
        prices: `http://127.0.0.1:${before.port + 50}`,
      });
      await moveLease("prices", { host: "::1", port: before.port + 51 });
      expect(await of(["workspace/prices"])).toEqual({
        prices: `http://[::1]:${before.port + 51}`,
      });
    } finally {
      await moveLease("prices", before);
    }
    expect(await of(["workspace/prices"])).toEqual({
      prices: `http://127.0.0.1:${before.port}`,
    });
  },
);

posixTest(
  "a sibling whose declaration cannot be read now has no address; it does not stop the others",
  async () => {
    const prices = await lease("prices");
    const stockApp = join(gamma, "workspace", "stock", "app", "package.json");
    const recorded = await readFile(stockApp, "utf8");
    await writeFile(stockApp, "{ not json");
    try {
      expect(await of(["workspace/prices", "workspace/stock"])).toEqual({
        prices: `http://127.0.0.1:${prices.port}`,
      });
    } finally {
      await writeFile(stockApp, recorded);
    }
    const stock = await lease("stock");
    expect(await of(["workspace/prices", "workspace/stock"])).toEqual({
      prices: `http://127.0.0.1:${prices.port}`,
      stock: `http://127.0.0.1:${stock.port}`,
    });
  },
);
