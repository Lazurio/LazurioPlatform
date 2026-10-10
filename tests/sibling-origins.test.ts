import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RequiredSlotRefused,
  requiredSlotOrigins,
} from "../src/modules/sibling-origins";
import { writeOrganization } from "./fixtures/catalog-folder";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The slots a starting application requires (root decision 0176 point 4) and
// the sibling modules it gets an address for (root decision 0176, addendum of
// 2026-10-10; decision F26, addendum of 2026-10-10): every required slot must
// be declared, active and checked out, or the start is refused; among them,
// exactly the `workspace/<slug>` modules of the application's own
// Organization with an HTTP default app get their lease's loopback origin.
// The consumer shape is a budgeting module that prices through a price-list
// module beside it. Synthetic names only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
let folder = "";
let gamma = "";
beforeAll(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), "sibling-origins-")));
  // gamma: `budgets` beside its price list, a module whose data mount is
  // declared and checked out, an app-less module, a module whose runtime is
  // broken, a root-level application, `notes` (undeclared by anyone), a
  // planned slot and a declared slot that is not checked out.
  gamma = await writeOrganization(folder, "gamma", {
    slug: "gamma",
    state: "current",
    modules: [
      { id: "budgets" },
      { id: "prices" },
      { id: "stock" },
      { id: "notes" },
      { id: "empty", apps: false },
      { id: "broken", broken: true },
      { id: "mission-control", path: "mission-control" },
    ],
    slots: [
      { path: "workspace/stock/db" },
      { path: "workspace/absent", slug: "absent" },
      { path: "workspace/later", slug: "later", status: "planned_slot" },
    ],
  });
  await mkdir(join(gamma, "workspace", "stock", "db"));
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
  requiredSlotOrigins({
    organizationDirectory: gamma,
    company: "gamma",
    module,
    slots,
  });

async function refusal(slots: string[]) {
  try {
    await of(slots);
  } catch (error) {
    if (error instanceof RequiredSlotRefused)
      return { reason: error.reason, slot: error.slot };
    throw error;
  }
  return null;
}

posixTest(
  "a declared sibling module of the same Organization: its default app's entrypoint, at its lease",
  async () => {
    const prices = await lease("prices");
    const delta = join(folder, "organizations", "delta");
    expect((await lease("prices", delta)).port).not.toBe(prices.port);
    expect(await of(["workspace/prices"])).toEqual({
      prices: `http://127.0.0.1:${prices.port}`,
    });
  },
);

posixTest(
  "required slots that are there but give no address: a data mount, an app-less or broken module, the application itself and a root-level application; an undeclared module gets nothing",
  async () => {
    const prices = await lease("prices");
    expect(
      await of([
        "workspace/prices",
        "workspace/stock/db",
        "workspace/empty",
        "workspace/broken",
        "workspace/budgets",
        "mission-control",
      ]),
    ).toEqual({ prices: `http://127.0.0.1:${prices.port}` });
    for (const slot of [
      "workspace/stock/db",
      "workspace/empty",
      "workspace/broken",
      "workspace/budgets",
      "mission-control",
    ])
      expect(await of([slot]), slot).toEqual({});
    expect(await of([])).toEqual({});
    // The application identity decides: a caller of another company is not
    // this Organization's application.
    await expect(
      requiredSlotOrigins({
        organizationDirectory: gamma,
        company: "delta",
        module: "budgets",
        slots: ["workspace/prices"],
      }),
    ).rejects.toThrow();
  },
);

posixTest(
  "a required slot that is not there refuses the start (root decision 0176 point 4): undeclared, planned or not checked out, also beside a sibling that is there",
  async () => {
    expect(await refusal(["workspace/ghost"])).toEqual({
      reason: "required-slot-undeclared",
      slot: "workspace/ghost",
    });
    // Another Organization's module is never this one's slot.
    expect(await refusal(["workspace/remote"])).toEqual({
      reason: "required-slot-undeclared",
      slot: "workspace/remote",
    });
    expect(await refusal(["organizations/delta/workspace/remote"])).toEqual({
      reason: "required-slot-undeclared",
      slot: "organizations/delta/workspace/remote",
    });
    expect(await refusal(["workspace/later"])).toEqual({
      reason: "required-slot-planned",
      slot: "workspace/later",
    });
    expect(await refusal(["workspace/prices", "workspace/absent"])).toEqual({
      reason: "required-slot-missing",
      slot: "workspace/absent",
    });
    // A declared data mount that is not checked out.
    await rm(join(gamma, "workspace", "stock", "db"), { recursive: true });
    try {
      expect(await refusal(["workspace/stock/db"])).toEqual({
        reason: "required-slot-missing",
        slot: "workspace/stock/db",
      });
    } finally {
      await mkdir(join(gamma, "workspace", "stock", "db"));
    }
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
  "a sibling that is there but whose declaration cannot be read now has no address and does not refuse the start",
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
