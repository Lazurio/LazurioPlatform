import { expect, test } from "bun:test";
import {
  adoptable,
  adoptionOf,
  adoptionPrompt,
  adoptionPromptId,
  builtInMarketplace,
  isAdoptionPromptId,
  type MarketplaceCatalog,
  type MarketplaceOffer,
  offerById,
  parseMarketplaceIndex,
  releaseUrl,
  screenshotUrl,
  seedsOf,
} from "../src/launchpad/marketplace";
import builtInIndex from "../src/launchpad/marketplace-index.json";
import { type MessageKey, messages } from "../src/launchpad/messages";
import {
  adoptionDocument,
  type BoundOrganization,
} from "../src/launchpad/prompts";
import {
  pageFrame,
  pagePaths,
  pageRoute,
  routeFrame,
  routePath,
  routeTitle,
} from "../src/launchpad/routes";

// The Marketplace (plan DEV-6593): one section, offers read from the
// registry's index at one commit (or the copy built into this release), an
// exact release, and "Přidat do Organizace" that hands a brief to the agent
// only once the release's commit is recorded.

const cs = messages("cs");
const en = messages("en");
const commit = "0123456789abcdef0123456789abcdef01234567";

const presentations = offerById(
  builtInMarketplace,
  "presentations",
) as MarketplaceOffer;

const released: MarketplaceOffer = {
  ...presentations,
  release: {
    version: "0.1.0",
    tag: "v0.1.0",
    commit,
    artifactDigest: null,
  },
};

const catalogOf = (...offers: MarketplaceOffer[]): MarketplaceCatalog => ({
  source: "registry",
  commit: "f".repeat(40),
  offers,
});

/** The built-in index with one offer's fields replaced. */
const indexWith = (id: string, fields: Record<string, unknown>) => ({
  ...builtInIndex,
  offers: builtInIndex.offers.map((offer) =>
    offer.id === id ? { ...offer, ...fields } : offer,
  ),
});

const example: BoundOrganization = {
  directory: "Example_GEN3",
  organization: "Example",
  displayName: "Example Company",
  forgeLogin: "Example-Org",
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules: [],
  repositories: [],
};

test("the built-in catalog is the registry's index: Mission Control and Presentations of the example Organization, MIT, each release 0.1.0 announced", () => {
  expect(builtInMarketplace.source).toBe("built-in");
  expect(builtInMarketplace.commit).toBeNull();
  expect(
    builtInMarketplace.offers.map((offer) => [
      offer.id,
      offer.section,
      offer.generation,
      offer.stone,
    ]),
  ).toEqual([
    ["mission-control", "app-templates", "app/v3", "control"],
    ["presentations", "app-templates", "app/v1", "presentation"],
  ]);
  expect(presentations.repository).toBe(
    "LazurioExampleOrganization/presentations",
  );
  expect(presentations.publisher).toBe("LazurioExampleOrganization");
  expect(presentations.license).toBe("MIT");
  expect(presentations.release).toEqual({
    version: "0.1.0",
    tag: "v0.1.0",
    commit: null,
    artifactDigest: null,
  });
  expect(releaseUrl(presentations)).toBe(
    "https://github.com/LazurioExampleOrganization/presentations/releases/tag/v0.1.0",
  );
  expect(offerById(builtInMarketplace, "other")).toBeNull();
  expect(offerById(builtInMarketplace, "__proto__")).toBeNull();
});

test("an index is read in full or refused: unknown schema, field or value, a duplicate id, a short commit, a price", () => {
  expect(parseMarketplaceIndex(builtInIndex)).toHaveLength(2);
  for (const index of [
    null,
    [],
    { ...builtInIndex, schemaVersion: "lazurio.marketplace.index.v2" },
    { ...builtInIndex, extra: true },
    indexWith("presentations", { installs: 12 }),
    indexWith("presentations", { pricing: "paid" }),
    indexWith("presentations", { section: "profiles" }),
    indexWith("presentations", { repository: "Other/presentations" }),
    indexWith("presentations", { id: "mission-control" }),
    indexWith("presentations", { generation: "v1" }),
    indexWith("presentations", { summary: { cs: "Jen česky" } }),
    indexWith("presentations", {
      releases: [
        {
          version: "0.1.0",
          tag: "v0.1.0",
          commit: "abc",
          artifactDigest: null,
        },
      ],
    }),
    indexWith("presentations", {
      releases: [
        {
          version: "0.1.0",
          tag: "v0.1.0",
          commit: null,
          artifactDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
    }),
    indexWith("presentations", {
      screenshots: [{ path: "../x.webp", alt: { cs: "x", en: "x" } }],
    }),
    indexWith("presentations", { releases: [] }),
  ])
    expect(parseMarketplaceIndex(index)).toBeNull();
});

test("an unknown stone shows the plain app stone, and the offered release is the newest with a commit", () => {
  const offers = parseMarketplaceIndex(
    indexWith("presentations", {
      stone: "rocket",
      releases: [
        { version: "0.2.0", tag: "v0.2.0", commit: null, artifactDigest: null },
        { version: "0.1.0", tag: "v0.1.0", commit, artifactDigest: null },
      ],
    }),
  ) as readonly MarketplaceOffer[];
  const offer = offers.find((entry) => entry.id === "presentations");
  expect(offer?.stone).toBe("app");
  expect(offer?.release.version).toBe("0.1.0");
  expect(offer?.releases).toHaveLength(2);
  expect(offer !== undefined && adoptable(offer)).toBe(true);
});

test("screens come from the offered release's exact commit, none while it has none", () => {
  expect(screenshotUrl(presentations, "docs/a.webp")).toBeNull();
  expect(screenshotUrl(released, "docs/a.webp")).toBe(
    `https://raw.githubusercontent.com/LazurioExampleOrganization/presentations/${commit}/docs/a.webp`,
  );
});

test("until its release's exact commit is recorded the offer cannot be adopted, and no brief or prompt exists", () => {
  expect(presentations.release.commit).toBeNull();
  expect(adoptable(presentations)).toBe(false);
  expect(
    adoptionPrompt(
      presentations,
      "empty",
      { name: "Example", login: "x" },
      cs,
      "cs",
    ),
  ).toBeNull();
  expect(
    adoptionDocument(
      builtInMarketplace,
      "marketplace-presentations-empty",
      "/home/x/Lazurio",
      example,
      cs,
      "cs",
    ),
  ).toBeNull();
  // A tag, a short or a malformed commit is no exact release.
  for (const value of ["v0.1.0", "0123456", "G".repeat(40), ""])
    expect(
      adoptable({
        ...released,
        release: { ...released.release, commit: value },
      }),
    ).toBe(false);
  expect(adoptable(released)).toBe(true);
});

test("the brief names the exact release, the Organization, the start and the boundaries, in both languages", () => {
  for (const [copy, locale] of [
    [cs, "cs"],
    [en, "en"],
  ] as const) {
    for (const seed of ["empty", "sample"] as const) {
      const text = adoptionPrompt(
        released,
        seed,
        { name: "Example Company", login: "Example-Org" },
        copy,
        locale,
      ) as string;
      expect(text).toContain("Presentations");
      expect(text).toContain("Example Company (GitHub Example-Org)");
      expect(text).toContain("LazurioExampleOrganization/presentations v0.1.0");
      expect(text).toContain(commit);
      expect(text).toContain("MIT");
      expect(text).toContain("docs/adoption.md");
      expect(text).toContain("`lazurio module create --stack vite-react`");
      expect(text).toContain(
        (seed === "sample" ? released.seeds.sample : released.seeds.empty)
          ?.brief[locale] as string,
      );
      expect(text).not.toMatch(/\{[a-z]+\}/);
    }
  }
  expect(
    adoptionPrompt(released, "empty", { name: "A", login: "a" }, cs, "cs"),
  ).toContain("Nic nemerguj ani neaktivuj bez mého výslovného pokynu.");
  expect(
    adoptionPrompt(released, "empty", { name: "A", login: "a" }, en, "en"),
  ).toContain("Merge or activate nothing without my explicit instruction.");
  // The document of an adoption names the catalog's release.
  expect(
    adoptionDocument(
      catalogOf(released),
      "marketplace-presentations-sample",
      "/home/x/Lazurio",
      example,
      en,
      "en",
    )?.text,
  ).toContain(commit);
});

test("an adoption's prompt id carries the offer and the seed of the catalog, and nothing else is one", () => {
  const catalog = catalogOf(released);
  expect(adoptionPromptId(released, "empty")).toBe(
    "marketplace-presentations-empty",
  );
  expect(adoptionOf(catalog, "marketplace-presentations-sample")?.seed).toBe(
    "sample",
  );
  expect(adoptionOf(catalog, "marketplace-presentations-empty")?.offer.id).toBe(
    "presentations",
  );
  for (const id of [
    "marketplace-presentations",
    "marketplace-presentations-other",
    "marketplace-other-empty",
    "marketplace-mission-control-empty",
    "new-module",
    "",
  ])
    expect(adoptionOf(catalog, id)).toBeNull();
  // An offer without an example has only the empty start.
  const bare: MarketplaceOffer = {
    ...released,
    seeds: { empty: released.seeds.empty, sample: null },
  };
  expect(seedsOf(bare)).toEqual(["empty"]);
  expect(
    adoptionOf(catalogOf(bare), "marketplace-presentations-sample"),
  ).toBeNull();
  expect(
    adoptionPrompt(bare, "sample", { name: "A", login: "a" }, cs, "cs"),
  ).toBeNull();
  expect(isAdoptionPromptId("marketplace-notes-empty")).toBe(true);
  expect(isAdoptionPromptId("marketplace-notes")).toBe(false);
  expect(isAdoptionPromptId("new-module")).toBe(false);
});

test("the Marketplace's routes: its catalog and an offer's detail, one frame", () => {
  expect(pagePaths).toContain("/marketplace/:offer");
  expect(pageRoute("/marketplace")).toEqual({ view: "marketplace" });
  expect(pageRoute("/marketplace/presentations")).toEqual({
    view: "marketplace",
    offer: "presentations",
  });
  expect(pageRoute("/marketplace/presentations/")).toEqual({
    view: "marketplace",
    offer: "presentations",
  });
  // Deeper or unreadable paths open the catalog.
  expect(pageRoute("/marketplace/a/b")).toEqual({ view: "marketplace" });
  expect(pageRoute("/marketplace/%E0")).toEqual({ view: "marketplace" });
  expect(routePath({ view: "marketplace", offer: "presentations" })).toBe(
    "/marketplace/presentations",
  );
  for (const path of ["/marketplace/presentations", "/marketplace/unknown"])
    expect([path, pageFrame(path).frame]).toEqual([
      path,
      routeFrame(pageRoute(path)),
    ]);
  expect(
    routeTitle({ view: "marketplace", offer: "presentations" }, cs),
  ).toEqual({
    heading: "Presentations",
    document: "Presentations · Marketplace — Lazurio",
  });
  expect(
    routeTitle({ view: "marketplace", offer: "unknown" }, cs).heading,
  ).toBe("Marketplace");
  // An offer only the registry has is titled by the offers the page shows.
  expect(
    routeTitle(
      { view: "marketplace", offer: "notes" },
      cs,
      undefined,
      (offer) => (offer === "notes" ? "Notes" : undefined),
    ).heading,
  ).toBe("Notes");
});

test("the built-in offers' words say no price, no pilot, no Environment or computer, no rating and no install on a click", () => {
  for (const offer of builtInMarketplace.offers) {
    const words = [
      offer.summary,
      ...offer.features.flatMap((feature) => [feature.title, feature.text]),
      offer.seeds.empty.label,
      ...(offer.seeds.sample === null ? [] : [offer.seeds.sample.label]),
    ];
    for (const text of words) {
      expect(text.cs).not.toMatch(
        /pilot|cen[auy]\b|zdarma|Kč|Prostředí|počítač|nainstal(uje|ováno)|ověřen|neumí/i,
      );
      expect(text.en).not.toMatch(
        /pilot|price|free of charge|Environment|computer|installed|one click|verified|does not/i,
      );
    }
  }
});

test("the Marketplace's words say no price, no pilot, no Environment or computer, no badge or list of what it lacks, and no install on a click", () => {
  const shown = (Object.keys(cs) as MessageKey[]).filter(
    (key) => key.startsWith("market") && !key.startsWith("marketAdoptPrompt"),
  );
  expect(shown.length).toBeGreaterThan(15);
  for (const key of shown) {
    expect([key, cs[key]]).not.toEqual([
      key,
      expect.stringMatching(
        /pilot|cen[auy]\b|zdarma|Kč|Prostředí|Environment|počítač|nainstal(uje|ováno)|ověřen|neumí/i,
      ),
    ]);
    expect([key, en[key]]).not.toEqual([
      key,
      expect.stringMatching(
        /pilot|price|free of charge|Environment|computer|installed|one click|verified|does not/i,
      ),
    ]);
  }
});
