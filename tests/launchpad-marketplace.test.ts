import { expect, test } from "bun:test";
import {
  adoptable,
  adoptionOf,
  adoptionPrompt,
  adoptionPromptId,
  type MarketplaceOffer,
  marketplaceOffers,
  offerById,
  releaseUrl,
} from "../src/launchpad/marketplace";
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

// The Marketplace's pilot (plan DEV-6593): one section, one offer, an exact
// release, and "Přidat do Organizace" that hands a brief to the agent only
// once the release's commit is recorded.

const cs = messages("cs");
const en = messages("en");

const released: MarketplaceOffer = {
  ...(offerById("presentations") as MarketplaceOffer),
  release: {
    version: "0.1.0",
    tag: "v0.1.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    artifactDigest: null,
  },
};

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

test("the pilot's catalog: Presentations alone in Šablony aplikací, MIT, release v0.1.0 of its public template", () => {
  expect(marketplaceOffers.map((offer) => [offer.id, offer.section])).toEqual([
    ["presentations", "app-templates"],
  ]);
  const offer = offerById("presentations") as MarketplaceOffer;
  expect(offer.repository).toBe("TemplatesRozjedeme-ai/Presentations");
  expect(offer.publisher).toBe("TemplatesRozjedeme-ai");
  expect(offer.license).toBe("MIT");
  expect(offer.release.version).toBe("0.1.0");
  expect(offer.release.tag).toBe("v0.1.0");
  expect(releaseUrl(offer)).toBe(
    "https://github.com/TemplatesRozjedeme-ai/Presentations/releases/tag/v0.1.0",
  );
  expect(offerById("other")).toBeNull();
  expect(offerById("__proto__")).toBeNull();
});

test("until its release's exact commit is recorded the offer cannot be adopted, and no brief or prompt exists", () => {
  const offer = offerById("presentations") as MarketplaceOffer;
  expect(offer.release.commit).toBeNull();
  expect(adoptable(offer)).toBe(false);
  expect(
    adoptionPrompt(offer, "empty", { name: "Example", login: "x" }, cs),
  ).toBeNull();
  expect(
    adoptionDocument(
      "marketplace-presentations-empty",
      "/home/x/Lazurio",
      example,
      cs,
    ),
  ).toBeNull();
  // A tag, a short or a malformed commit is no exact release.
  for (const commit of ["v0.1.0", "0123456", "G".repeat(40), ""])
    expect(
      adoptable({ ...released, release: { ...released.release, commit } }),
    ).toBe(false);
  expect(adoptable(released)).toBe(true);
});

test("the brief names the exact release, the Organization, the start and the boundaries, in both languages", () => {
  for (const copy of [cs, en]) {
    for (const seed of ["empty", "sample"] as const) {
      const text = adoptionPrompt(
        released,
        seed,
        { name: "Example Company", login: "Example-Org" },
        copy,
      ) as string;
      expect(text).toContain("Presentations");
      expect(text).toContain("Example Company (GitHub Example-Org)");
      expect(text).toContain("TemplatesRozjedeme-ai/Presentations v0.1.0");
      expect(text).toContain("0123456789abcdef0123456789abcdef01234567");
      expect(text).toContain("MIT");
      expect(text).toContain("docs/adoption.md");
      expect(text).toContain("`lazurio module create --stack vite-react`");
      expect(text).toContain(
        copy[
          seed === "sample" ? "marketSeedSampleBrief" : "marketSeedEmptyBrief"
        ],
      );
      expect(text).not.toMatch(/\{[a-z]+\}/);
    }
  }
  expect(
    adoptionPrompt(released, "empty", { name: "A", login: "a" }, cs),
  ).toContain("Nic nemerguj ani neaktivuj bez mého výslovného pokynu.");
  expect(
    adoptionPrompt(released, "empty", { name: "A", login: "a" }, en),
  ).toContain("Merge or activate nothing without my explicit instruction.");
});

test("an adoption's prompt id carries the offer and the seed, and nothing else is one", () => {
  expect(adoptionPromptId(released, "empty")).toBe(
    "marketplace-presentations-empty",
  );
  expect(adoptionOf("marketplace-presentations-sample")?.seed).toBe("sample");
  expect(adoptionOf("marketplace-presentations-empty")?.offer.id).toBe(
    "presentations",
  );
  for (const id of [
    "marketplace-presentations",
    "marketplace-presentations-other",
    "marketplace-other-empty",
    "new-module",
    "",
  ])
    expect(adoptionOf(id)).toBeNull();
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
});

test("the Marketplace's words say no price, no pilot, no Environment or computer, no badge or list of what it lacks, and no install on a click", () => {
  const shown = (Object.keys(cs) as MessageKey[]).filter(
    (key) => key.startsWith("market") && !key.startsWith("marketAdoptPrompt"),
  );
  expect(shown.length).toBeGreaterThan(20);
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
