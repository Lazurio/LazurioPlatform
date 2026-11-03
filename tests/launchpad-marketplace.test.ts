import { expect, test } from "bun:test";
import {
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
// registry's index at one commit (or the copy built into this release), and
// only those with a published release: an exact commit, which "Přidat do
// Organizace" hands to the agent in a brief.

const cs = messages("cs");
const en = messages("en");
const commit = "0123456789abcdef0123456789abcdef01234567";

/** The built-in index with these offers' newest release published at
 * `commit` (all of them when none is named). */
const publishedIndex = (...ids: string[]) => ({
  ...builtInIndex,
  offers: builtInIndex.offers.map((offer) =>
    ids.length > 0 && !ids.includes(offer.id)
      ? offer
      : {
          ...offer,
          releases: offer.releases.map((release, i) =>
            i === 0 ? { ...release, commit } : release,
          ),
        },
  ),
});

const shown = parseMarketplaceIndex(
  publishedIndex(),
) as readonly MarketplaceOffer[];

const catalogOf = (...offers: MarketplaceOffer[]): MarketplaceCatalog => ({
  source: "registry",
  commit: "f".repeat(40),
  offers,
});

const released = offerById(
  catalogOf(...shown),
  "presentations",
) as MarketplaceOffer;

/** The built-in index with one offer's fields replaced. */
const indexWith = (id: string, fields: Record<string, unknown>) => ({
  ...builtInIndex,
  offers: builtInIndex.offers.map((offer) =>
    offer.id === id ? { ...offer, ...fields } : offer,
  ),
});

/** A release of the index with some fields replaced. */
const releaseWith = (fields: Record<string, unknown>) => ({
  version: "0.1.0",
  tag: "v0.1.0",
  generation: "app/v1",
  stack: "vite-react",
  bun: "1.4.4",
  commit: null,
  artifactDigest: null,
  ...fields,
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

test("the built-in copy is the registry's index: three templates of the example Organization, none released yet, so none shown", () => {
  expect(builtInMarketplace.source).toBe("built-in");
  expect(builtInMarketplace.commit).toBeNull();
  expect(builtInMarketplace.offers).toEqual([]);
  expect(builtInIndex.offers.map((offer) => offer.id)).toEqual([
    "design-system",
    "mission-control",
    "presentations",
  ]);
  // Once released, each offers its release and what it is built on.
  expect(
    shown.map((offer) => [
      offer.id,
      offer.repository,
      offer.license,
      offer.stone,
      offer.release.version,
      offer.release.generation,
      offer.release.stack,
      offer.release.bun,
      offer.screenshots.length,
    ]),
  ).toEqual([
    [
      "design-system",
      "LazurioExampleOrganization/design-system",
      "MIT",
      "palette",
      "1.0.0",
      "app/v1",
      "astro",
      "1.4.4",
      5,
    ],
    [
      "mission-control",
      "LazurioExampleOrganization/mission-control",
      "MIT",
      "control",
      "4.0.0",
      "app/v3",
      "vite-react",
      "1.4.4",
      4,
    ],
    [
      "presentations",
      "LazurioExampleOrganization/presentations",
      "MIT",
      "presentation",
      "0.1.0",
      "app/v1",
      "vite-react",
      "1.4.4",
      4,
    ],
  ]);
  // Mission Control has one public source.
  expect(JSON.stringify(builtInIndex)).not.toContain("Lazurio/mission-control");
  expect(releaseUrl(released)).toBe(
    "https://github.com/LazurioExampleOrganization/presentations/releases/tag/v0.1.0",
  );
  expect(offerById(builtInMarketplace, "presentations")).toBeNull();
  expect(offerById(catalogOf(...shown), "other")).toBeNull();
  expect(offerById(catalogOf(...shown), "__proto__")).toBeNull();
});

test("an index is read in full or refused: unknown schema, field or value, a duplicate id, a short commit, a price", () => {
  expect(parseMarketplaceIndex(builtInIndex)).toEqual([]);
  expect(parseMarketplaceIndex(publishedIndex())).toHaveLength(3);
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
    // The generation, the stack and the Bun are a release's, not the offer's.
    indexWith("presentations", { generation: "app/v1" }),
    indexWith("presentations", { bun: "1.4.4" }),
    indexWith("presentations", { stack: "vite-react" }),
    indexWith("presentations", {
      releases: [releaseWith({ generation: "v1" })],
    }),
    indexWith("presentations", { releases: [releaseWith({ bun: "1.4" })] }),
    indexWith("presentations", {
      releases: [releaseWith({ stack: "Vite React" })],
    }),
    indexWith("presentations", {
      releases: [releaseWith({ generation: undefined })],
    }),
    indexWith("presentations", { summary: { cs: "Jen česky" } }),
    indexWith("presentations", { releases: [releaseWith({ commit: "abc" })] }),
    indexWith("presentations", {
      releases: [releaseWith({ artifactDigest: `sha256:${"a".repeat(64)}` })],
    }),
    indexWith("presentations", {
      screenshots: [{ path: "../x.webp", alt: { cs: "x", en: "x" } }],
    }),
    indexWith("presentations", { releases: [] }),
  ])
    expect(parseMarketplaceIndex(index)).toBeNull();
});

test("only offers with a published release are shown; an unknown stone shows the app stone; the offered release is the newest with a commit", () => {
  const offers = parseMarketplaceIndex(
    indexWith("presentations", {
      stone: "rocket",
      releases: [
        releaseWith({ version: "0.2.0", tag: "v0.2.0", bun: "1.4.5" }),
        releaseWith({ commit }),
      ],
    }),
  ) as readonly MarketplaceOffer[];
  expect(offers.map((entry) => entry.id)).toEqual(["presentations"]);
  const offer = offers[0];
  expect(offer?.stone).toBe("app");
  expect(offer?.release.version).toBe("0.1.0");
  expect(offer?.release.bun).toBe("1.4.4");
  expect(offer?.releases).toHaveLength(2);
});

test("screens come from the offered release's exact commit", () => {
  expect(screenshotUrl(released, "docs/a.webp")).toBe(
    `https://raw.githubusercontent.com/LazurioExampleOrganization/presentations/${commit}/docs/a.webp`,
  );
});

test("an offer without a published release has no card, no detail and no prompt", () => {
  const catalog: MarketplaceCatalog = {
    source: "registry",
    commit: "f".repeat(40),
    offers: parseMarketplaceIndex(
      publishedIndex("presentations"),
    ) as readonly MarketplaceOffer[],
  };
  expect(catalog.offers.map((offer) => offer.id)).toEqual(["presentations"]);
  expect(offerById(catalog, "mission-control")).toBeNull();
  for (const [source, id] of [
    [builtInMarketplace, "marketplace-presentations-empty"],
    [catalog, "marketplace-mission-control-empty"],
    [catalog, "marketplace-design-system-sample"],
  ] as const)
    expect(
      adoptionDocument(source, id, "/home/x/Lazurio", example, cs, "cs"),
    ).toBeNull();
  expect(
    adoptionDocument(
      catalog,
      "marketplace-presentations-empty",
      "/home/x/Lazurio",
      example,
      cs,
      "cs",
    )?.text,
  ).toContain(commit);
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
      expect(text).not.toContain("{stack}");
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
    routeTitle(
      { view: "marketplace", offer: "presentations" },
      cs,
      undefined,
      (offer) => offerById(catalogOf(...shown), offer)?.title,
    ),
  ).toEqual({
    heading: "Presentations",
    document: "Presentations · Marketplace — Lazurio",
  });
  // An offer the page does not show (unknown, or not released in the
  // built-in copy) is titled Marketplace.
  for (const offer of ["unknown", "presentations"])
    expect(routeTitle({ view: "marketplace", offer }, cs).heading).toBe(
      "Marketplace",
    );
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

test("the registry's offers' words say no price, no pilot, no Environment or computer, no rating and no install on a click", () => {
  for (const offer of shown) {
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
