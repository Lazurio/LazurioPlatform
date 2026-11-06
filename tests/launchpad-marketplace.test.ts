import { expect, test } from "bun:test";
import { chatPromptHref, promptIdLength } from "../src/launchpad/chat-view";
import {
  adoptionOf,
  adoptionPrompt,
  adoptionPromptId,
  builtInMarketplace,
  catalogKey,
  catalogKeyLength,
  createCommand,
  isAdoptionPromptId,
  type MarketplaceCatalog,
  type MarketplaceOffer,
  offerById,
  offerIdLength,
  parseMarketplaceIndex,
  releaseUrl,
  screenshotsFor,
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
import {
  ModuleCreateUsageError,
  runModuleCreateCommand,
} from "../src/modules/module-create-cli";
import unreleasedIndex from "./fixtures/marketplace-index-unreleased.json";

// The Marketplace (plan DEV-6593): one section, offers read from the
// registry's index at one commit (or the copy built into this release), and
// only those with a published release: an exact commit, which "Přidat do
// Organizace" hands to the agent in a brief. Its behavior is tested on an
// index of the registry's shape in which no template is released yet
// (tests/fixtures/marketplace-index-unreleased.json). The copy built into
// this release is tested only as what it is, the registry's index read in
// full, and for its offers' words, so refreshing it leaves the behavior
// tests alone.

const cs = messages("cs");
const en = messages("en");
const commit = "0123456789abcdef0123456789abcdef01234567";

/** The fixture index with these offers' newest release published at
 * `commit` (all of them when none is named). */
const publishedIndex = (...ids: string[]) => ({
  ...unreleasedIndex,
  offers: unreleasedIndex.offers.map((offer) =>
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

/** A copy built into a release in which no template is released yet. */
const unreleasedBuiltIn: MarketplaceCatalog = {
  source: "built-in",
  commit: null,
  offers: parseMarketplaceIndex(unreleasedIndex) as readonly MarketplaceOffer[],
};

const released = offerById(
  catalogOf(...shown),
  "presentations",
) as MarketplaceOffer;

/** The fixture index with one offer's fields replaced. */
const indexWith = (id: string, fields: Record<string, unknown>) => ({
  ...unreleasedIndex,
  offers: unreleasedIndex.offers.map((offer) =>
    offer.id === id ? { ...offer, ...fields } : offer,
  ),
});

/** A release of the index with some fields replaced. */
const releaseWith = (fields: Record<string, unknown>) => ({
  version: "0.1.0",
  tag: "v0.1.0",
  generation: "app/v1",
  stackProfile: "app@2026.11",
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

test("the built-in copy is the registry's index, read in full: its three templates are released, so all three are shown at their commits", () => {
  expect(builtInMarketplace.source).toBe("built-in");
  expect(builtInMarketplace.commit).toBeNull();
  expect(builtInIndex.offers.map((offer) => offer.id)).toEqual([
    "design-system",
    "mission-control",
    "presentations",
  ]);
  // Every template of the copy is read and shown; none is left out.
  expect(builtInMarketplace.offers.map((offer) => offer.id)).toEqual(
    builtInIndex.offers.map((offer) => offer.id),
  );
  for (const offer of builtInMarketplace.offers) {
    // Each at a release the copy records, with its full commit and the
    // stack profile it is built on.
    const recorded: readonly unknown[] =
      builtInIndex.offers.find((entry) => entry.id === offer.id)?.releases ??
      [];
    expect(recorded).toContainEqual(offer.release);
    expect(offer.release.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(offer.release.stackProfile).toMatch(/^[a-z][a-z-]*@\d{4}\.\d{2}$/);
  }
  // LazurioTemplates publishes every template; the example Organization is
  // a subscriber that adopts them from the Marketplace like any other.
  expect(builtInMarketplace.offers.map((offer) => offer.publisher)).toEqual([
    "LazurioTemplates",
    "LazurioTemplates",
    "LazurioTemplates",
  ]);
  expect(JSON.stringify(builtInIndex)).not.toContain(
    "LazurioExampleOrganization",
  );
});

test("the fixture's templates once released: each offers its release and what it is built on", () => {
  expect(
    shown.map((offer) => [
      offer.id,
      offer.repository,
      offer.license,
      offer.stone,
      offer.release.version,
      offer.release.generation,
      offer.release.stackProfile,
      offer.release.stack,
      offer.release.bun,
      offer.screenshots.length,
    ]),
  ).toEqual([
    [
      "design-system",
      "LazurioTemplates/design-system",
      "MIT",
      "palette",
      "1.0.0",
      "app/v1",
      "content@2026.11",
      "astro",
      "1.4.4",
      5,
    ],
    [
      "mission-control",
      "LazurioTemplates/mission-control",
      "MIT",
      "control",
      "4.0.0",
      "app/v3",
      "app-data@2026.11",
      "vite-react",
      "1.4.4",
      4,
    ],
    [
      "presentations",
      "LazurioTemplates/presentations",
      "MIT",
      "presentation",
      "0.1.0",
      "app/v1",
      "app@2026.11",
      "vite-react",
      "1.4.4",
      4,
    ],
  ]);
  expect(releaseUrl(released)).toBe(
    "https://github.com/LazurioTemplates/presentations/releases/tag/v0.1.0",
  );
  expect(offerById(unreleasedBuiltIn, "presentations")).toBeNull();
  expect(offerById(catalogOf(...shown), "other")).toBeNull();
  expect(offerById(catalogOf(...shown), "__proto__")).toBeNull();
});

test("an index is read in full or refused: unknown schema, field or value, a duplicate id, a short commit, a price", () => {
  expect(parseMarketplaceIndex(unreleasedIndex)).toEqual([]);
  expect(parseMarketplaceIndex(publishedIndex())).toHaveLength(3);
  for (const index of [
    null,
    [],
    { ...unreleasedIndex, schemaVersion: "lazurio.marketplace.index.v2" },
    { ...unreleasedIndex, extra: true },
    indexWith("presentations", { installs: 12 }),
    indexWith("presentations", { pricing: "paid" }),
    indexWith("presentations", { section: "profiles" }),
    indexWith("presentations", { repository: "Other/presentations" }),
    indexWith("presentations", { id: "mission-control" }),
    // The generation, the stack profile, the stack and the Bun are a
    // release's, not the offer's.
    indexWith("presentations", { generation: "app/v1" }),
    indexWith("presentations", { stackProfile: "app@2026.11" }),
    indexWith("presentations", {
      releases: [releaseWith({ stackProfile: undefined })],
    }),
    indexWith("presentations", {
      releases: [releaseWith({ stackProfile: "app" })],
    }),
    indexWith("presentations", {
      releases: [releaseWith({ stackProfile: "vite-react@2026.11" })],
    }),
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
    `https://raw.githubusercontent.com/LazurioTemplates/presentations/${commit}/docs/a.webp`,
  );
});

/** A screen of the index's shape, in a language or none. */
const screen = (path: string, locale?: string) => ({
  path,
  alt: { cs: `Snímek ${path}`, en: `Screen ${path}` },
  ...(locale === undefined ? {} : { locale }),
});

/** Presentations of the fixture, released, with these screens; null when
 * the index is refused. */
const withScreens = (screenshots: unknown[]) =>
  parseMarketplaceIndex(
    indexWith("presentations", {
      screenshots,
      releases: [releaseWith({ commit })],
    }),
  )?.find((entry) => entry.id === "presentations") ?? null;

test("an index whose screens name no language reads as before: every screen in both languages, as the registry wrote it", () => {
  for (const entry of [...shown, ...builtInMarketplace.offers]) {
    for (const locale of ["cs", "en"] as const)
      expect(screenshotsFor(entry, locale)).toEqual(entry.screenshots);
    for (const shot of entry.screenshots)
      expect(Object.keys(shot)).toEqual(["path", "alt"]);
  }
  const plain = (count: number) =>
    Array.from({ length: count }, (_, i) => screen(`docs/${i}.webp`));
  expect(withScreens(plain(6))?.screenshots).toHaveLength(6);
  expect(withScreens(plain(7))).toBeNull();
});

test("screens per language: a page shows those in its language, else those without one, else any", () => {
  const cs = [screen("docs/cs/a.webp", "cs"), screen("docs/cs/b.webp", "cs")];
  const en = [screen("docs/en/a.webp", "en"), screen("docs/en/b.webp", "en")];
  const plain = [screen("docs/a.webp")];
  const offered = (screenshots: unknown[]) =>
    withScreens(screenshots) as MarketplaceOffer;
  const both = offered([...cs, ...en]);
  expect<unknown>(screenshotsFor(both, "cs")).toEqual(cs);
  expect<unknown>(screenshotsFor(both, "en")).toEqual(en);
  const czechAndPlain = offered([...cs, ...plain]);
  expect<unknown>(screenshotsFor(czechAndPlain, "cs")).toEqual(cs);
  expect<unknown>(screenshotsFor(czechAndPlain, "en")).toEqual(plain);
  expect<unknown>(screenshotsFor(offered(en), "cs")).toEqual(en);
  // Six per language; a seventh in one, an unknown language or a language
  // that is not a string refuses the index, as any field it cannot read.
  const six = (locale: string) =>
    Array.from({ length: 6 }, (_, i) =>
      screen(`docs/${locale}/${i}.webp`, locale),
    );
  expect(offered([...six("cs"), ...six("en")]).screenshots).toHaveLength(12);
  for (const screenshots of [
    [...six("cs"), screen("docs/cs/6.webp", "cs")],
    [screen("docs/de/a.webp", "de")],
    [{ ...screen("docs/a.webp"), locale: null }],
  ])
    expect(withScreens(screenshots)).toBeNull();
});

test("an offer's name: one string names it in both languages as before, `{cs, en}` in each its own", () => {
  const named = (title: unknown) =>
    parseMarketplaceIndex(
      indexWith("presentations", {
        title,
        releases: [releaseWith({ commit })],
      }),
    )?.find((entry) => entry.id === "presentations") ?? null;
  const organization = { name: "Example Company", login: "Example-Org" };
  // Today's records: one string, the same name on a Czech and an English page.
  const plain = named("Presentations") as MarketplaceOffer;
  expect(plain.title).toEqual({ cs: "Presentations", en: "Presentations" });
  for (const entry of builtInMarketplace.offers)
    expect(entry.title.cs).toBe(entry.title.en);
  // A bilingual template.
  const both = named({
    cs: "Evidence času",
    en: "Time Tracker",
  }) as MarketplaceOffer;
  expect(both.title).toEqual({ cs: "Evidence času", en: "Time Tracker" });
  expect(adoptionPrompt(both, "empty", organization, cs, "cs")).toContain(
    "šablonu aplikace Evidence času",
  );
  expect(adoptionPrompt(both, "empty", organization, en, "en")).toContain(
    "the app template Time Tracker",
  );
  // A name the release cannot read refuses the index.
  for (const title of [
    "",
    "x".repeat(61),
    { cs: "Evidence času" },
    { cs: "Evidence času", en: "" },
    { cs: "Evidence času", en: "Time Tracker", de: "Zeiterfassung" },
    7,
  ])
    expect(named(title)).toBeNull();
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
  const key = catalogKey(catalog);
  for (const [source, id] of [
    [unreleasedBuiltIn, "marketplace-presentations-empty-builtin"],
    [catalog, `marketplace-mission-control-empty-${key}`],
    [catalog, `marketplace-design-system-sample-${key}`],
  ] as const)
    expect(
      adoptionDocument([source], id, "/home/x/Lazurio", example, cs, "cs"),
    ).toBeNull();
  expect(
    adoptionDocument(
      [catalog],
      `marketplace-presentations-empty-${key}`,
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
      expect(text).toContain("LazurioTemplates/presentations v0.1.0");
      expect(text).toContain(commit);
      expect(text).toContain("MIT");
      expect(text).toContain("docs/adoption.md");
      expect(text).toContain(
        "`lazurio module create Example-Org/presentations --stack vite-react --teams <team,team> --dry-run`",
      );
      expect(text).toContain("`--confirm <plan>`");
      expect(text).not.toContain("--data");
      // An Organization that already has the module takes the release into
      // it, never a second one (#906).
      expect(text).toContain("docs/extending.md");
      expect(text).toContain("`--allow-unrelated-histories`");
      expect(text).not.toContain("{create}");
      expect(text).toContain(
        (seed === "sample" ? released.seeds.sample : released.seeds.empty)
          ?.brief[locale] as string,
      );
      expect(text).not.toMatch(/\{[a-z]+\}/);
    }
  }
  // A template with data of its own (generation app/v3 and later) is created
  // with --data, as its docs/adoption.md says.
  const missionControl = offerById(
    catalogOf(...shown),
    "mission-control",
  ) as MarketplaceOffer;
  for (const [copy, locale] of [
    [cs, "cs"],
    [en, "en"],
  ] as const)
    expect(
      adoptionPrompt(
        missionControl,
        "empty",
        { name: "A", login: "a" },
        copy,
        locale,
      ),
    ).toContain(
      "`lazurio module create a/mission-control --stack vite-react --teams <team,team> --data --dry-run`",
    );
  for (const [generation, data] of [
    ["app/v1", ""],
    ["app/v2", ""],
    ["app/v3", " --data"],
    ["app/v4", " --data"],
    ["app/v10", " --data"],
  ] as const)
    expect(
      createCommand(
        { ...released.release, generation },
        "Example-Org",
        "slides",
      ),
    ).toBe(
      `lazurio module create Example-Org/slides --stack vite-react --teams <team,team>${data} --dry-run`,
    );
  expect(
    adoptionPrompt(released, "empty", { name: "A", login: "a" }, cs, "cs"),
  ).toContain("Nic nemerguj ani neaktivuj bez mého výslovného pokynu.");
  expect(
    adoptionPrompt(released, "empty", { name: "A", login: "a" }, en, "en"),
  ).toContain("Merge or activate nothing without my explicit instruction.");
  // The document of an adoption names the catalog's release.
  expect(
    adoptionDocument(
      [catalogOf(released)],
      adoptionPromptId(catalogOf(released), released, "sample"),
      "/home/x/Lazurio",
      example,
      en,
      "en",
    )?.text,
  ).toContain(commit);
});

test("the brief's command is the one lazurio module create runs: with the Teams chosen, the dry run and then the confirmation (#905)", async () => {
  const missionControl = offerById(
    catalogOf(...shown),
    "mission-control",
  ) as MarketplaceOffer;
  /** The arguments of a command line after `lazurio`, as the CLI parses
   * them: past the parser, the run asks for its host, which this test does
   * not give (base-unknown, exit 1); a command it refuses throws its usage. */
  const runs = async (command: string) => {
    const args = command.split(" ");
    expect(args.shift()).toBe("lazurio");
    const said: string[] = [];
    const code = await runModuleCreateCommand(
      [...args, "--folder", "/nonexistent-lazurio-folder"],
      { cwd: "/" } as never,
      (line) => void said.push(line),
      () => {
        throw new Error("no host in this test");
      },
    );
    return { code, said };
  };
  for (const entry of [released, missionControl]) {
    const command = createCommand(entry.release, "Example-Org", entry.module);
    const chosen = command.replace("<team,team>", "core,design");
    for (const line of [
      chosen,
      chosen.replace("--dry-run", `--confirm sha256:${"a".repeat(64)}`),
    ])
      expect(await runs(line)).toEqual({
        code: 1,
        said: ["No per-user install base on this platform."],
      });
  }
  // The brief's earlier command, without the Organization's module and its
  // Teams, was refused with the usage.
  await expect(
    runs("lazurio module create --stack vite-react --data"),
  ).rejects.toBeInstanceOf(ModuleCreateUsageError);
  await expect(
    runs(
      createCommand(
        missionControl.release,
        "Example-Org",
        "mission-control",
      ).replace(" --teams <team,team>", ""),
    ),
  ).rejects.toBeInstanceOf(ModuleCreateUsageError);
});

test("the brief is the same whether the name is free or the Organization already has the module: the agent checks it live and never creates a second one (#906)", () => {
  const missionControl = offerById(
    catalogOf(...shown),
    "mission-control",
  ) as MarketplaceOffer;
  for (const entry of [released, missionControl]) {
    const catalog = catalogOf(entry);
    const id = adoptionPromptId(catalog, entry, "empty");
    expect(id.length).toBeLessThanOrEqual(promptIdLength);
    const having: BoundOrganization = {
      ...example,
      modules: [{ organization: "Example", module: entry.module }],
    } as unknown as BoundOrganization;
    for (const [copy, locale, never, otherwise] of [
      [cs, "cs", "druhý nikdy nezakládej", "Jinak se mnou domluv jiný název"],
      [
        en,
        "en",
        "never create a second one",
        "Otherwise agree another name with me",
      ],
    ] as const) {
      const free = adoptionDocument(
        [catalog],
        id,
        "/home/x/Lazurio",
        example,
        copy,
        locale,
      )?.text as string;
      expect(
        adoptionDocument([catalog], id, "/home/x/Lazurio", having, copy, locale)
          ?.text,
      ).toBe(free);
      expect(free).toContain(
        `\`${createCommand(entry.release, "Example-Org", entry.module)}\``,
      );
      expect(free).toContain(never);
      expect(free).toContain(otherwise);
      expect(free).toContain("docs/extending.md");
      expect(free).toContain("`--allow-unrelated-histories`");
      expect(free.includes("--data")).toBe(entry === missionControl);
      expect(free).not.toMatch(/\{[a-z]+\}/);
    }
  }
  // The dialog says it too where the Launchpad sees the module.
  expect(cs.marketTaken).toContain("vydání se převezme do něj");
  expect(cs.marketTaken).toContain("jinak s vámi agent domluví jiný název");
  expect(en.marketTaken).toContain("the release goes into it");
  expect(en.marketTaken).toContain(
    "otherwise the agent agrees another name with you",
  );
});

test("an adoption's prompt id carries the offer, the seed and the catalog shown, and nothing else is one", () => {
  const catalog = catalogOf(released);
  const key = "f".repeat(catalogKeyLength);
  expect(catalogKey(catalog)).toBe(key);
  expect(catalogKey(builtInMarketplace)).toBe("builtin");
  expect(adoptionPromptId(catalog, released, "empty")).toBe(
    `marketplace-presentations-empty-${key}`,
  );
  expect(
    adoptionOf([catalog], `marketplace-presentations-sample-${key}`)?.seed,
  ).toBe("sample");
  expect(
    adoptionOf([catalog], `marketplace-presentations-empty-${key}`)?.offer.id,
  ).toBe("presentations");
  for (const id of [
    "marketplace-presentations-empty",
    `marketplace-presentations-other-${key}`,
    `marketplace-other-empty-${key}`,
    `marketplace-presentations-empty-${"9".repeat(catalogKeyLength)}`,
    "marketplace-presentations-empty-builtin",
    `marketplace-presentations-empty-${"f".repeat(40)}`,
    "new-module",
    "",
  ])
    expect(adoptionOf([catalog], id)).toBeNull();
  // An offer without an example has only the empty start.
  const bare: MarketplaceOffer = {
    ...released,
    seeds: { empty: released.seeds.empty, sample: null },
  };
  expect(seedsOf(bare)).toEqual(["empty"]);
  expect(
    adoptionOf([catalogOf(bare)], `marketplace-presentations-sample-${key}`),
  ).toBeNull();
  expect(
    adoptionPrompt(bare, "sample", { name: "A", login: "a" }, cs, "cs"),
  ).toBeNull();
  expect(isAdoptionPromptId(`marketplace-notes-empty-${key}`)).toBe(true);
  expect(isAdoptionPromptId("marketplace-notes-sample-builtin")).toBe(true);
  expect(isAdoptionPromptId("marketplace-notes-empty")).toBe(false);
  expect(isAdoptionPromptId("marketplace-notes")).toBe(false);
  expect(isAdoptionPromptId("new-module")).toBe(false);
});

test("an offer id is at most 32 characters, so its longest prompt id is Chat's 64 and goes by link", () => {
  const longest = "a".repeat(offerIdLength);
  const read = parseMarketplaceIndex(
    indexWith("presentations", {
      id: longest,
      releases: [releaseWith({ commit })],
    }),
  );
  const offer = read?.find((entry) => entry.id === longest);
  expect(offer).toBeDefined();
  const id = adoptionPromptId(
    catalogOf(offer as MarketplaceOffer),
    offer as MarketplaceOffer,
    "sample",
  );
  expect(id).toHaveLength(promptIdLength);
  expect(isAdoptionPromptId(id)).toBe(true);
  expect(
    chatPromptHref("https://chat.example.test/", "https://chat.example.test", {
      id,
      organization: "Example-Org",
    }),
  ).toContain(`lazurio-prompt=${id}`);
  // One character more refuses the whole index.
  expect(
    parseMarketplaceIndex(
      indexWith("presentations", {
        id: `${longest}a`,
        releases: [releaseWith({ commit })],
      }),
    ),
  ).toBeNull();
  // Every offer of the built-in copy fits.
  for (const entry of builtInIndex.offers)
    expect(entry.id.length).toBeLessThanOrEqual(offerIdLength);
});

test("a prompt names the catalog shown: after the registry moved it is still that catalog's offer, field for field", () => {
  const shownCatalog = catalogOf(released);
  const id = adoptionPromptId(shownCatalog, released, "empty");
  // The registry moved on with the same release commit and version but
  // another repository and words: a different brief.
  const moved: MarketplaceCatalog = {
    source: "registry",
    commit: "e".repeat(40),
    offers: [
      {
        ...released,
        repository: "Example/other",
        summary: { cs: "Jiná", en: "Other" },
      },
    ],
  };
  // While the Launchpad still serves the catalog shown, the id gets that
  // catalog's offer, not the moved one.
  const both = [moved, shownCatalog, builtInMarketplace];
  expect(adoptionOf(both, id)?.offer).toBe(released);
  const document = adoptionDocument(
    both,
    id,
    "/home/x/Lazurio",
    example,
    en,
    "en",
  );
  expect(document?.id).toBe(id);
  expect(document?.text).toContain(released.repository);
  expect(document?.text).not.toContain("Example/other");
  // The new catalog's id gets the new offer.
  expect(
    adoptionOf(
      both,
      adoptionPromptId(moved, moved.offers[0] as MarketplaceOffer, "empty"),
    )?.offer.repository,
  ).toBe("Example/other");
  // Once the catalog shown is no longer served, its id is no prompt.
  expect(adoptionOf([moved, builtInMarketplace], id)).toBeNull();
  // Two served catalogs that share the key's characters answer neither.
  const twin: MarketplaceCatalog = {
    ...moved,
    commit: `${"f".repeat(catalogKeyLength)}${"0".repeat(40 - catalogKeyLength)}`,
  };
  expect(adoptionOf([shownCatalog, twin], id)).toBeNull();
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
      (offer) => offerById(catalogOf(...shown), offer)?.title.en,
    ),
  ).toEqual({
    heading: "Presentations",
    document: "Presentations · Marketplace — Lazurio",
  });
  // An offer the page does not show (unknown, or not released) is titled
  // Marketplace.
  expect(
    routeTitle({ view: "marketplace", offer: "unknown" }, cs).heading,
  ).toBe("Marketplace");
  for (const offer of ["unknown", "presentations"])
    expect(
      routeTitle(
        { view: "marketplace", offer },
        cs,
        undefined,
        (id) => offerById(unreleasedBuiltIn, id)?.title.en,
      ).heading,
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

test("the registry's offers' words say no price, no pilot, no Environment or computer, no rating and no install on a click", () => {
  // The registry's words as this release carries them.
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
    (key) =>
      key.startsWith("market") &&
      key !== "marketAdoptPrompt" &&
      key !== "marketRequestPrompt",
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
