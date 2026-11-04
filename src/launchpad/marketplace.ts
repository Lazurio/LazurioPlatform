import { type StoneKey, stoneKeys } from "../shell/stones";
import builtInIndex from "./marketplace-index.json";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// The Marketplace of the Launchpad (plan DEV-6593, docs/marketplace.md): a
// small curated catalog with one section, Šablony aplikací. Its offers come
// from the registry `Lazurio/marketplace`, read at one exact commit
// (marketplace-registry.ts), and until a registry was read from the copy of
// its `index.json` built into this release (`marketplace-index.json`). No
// service, account, price or install count. An offer names releases of a
// public template repository; the catalog never holds a second copy of its
// source, and shows an offer only once a release of it has its exact commit
// (decided 2026-11-03): an announced template is the registry's, not a card. "Přidat do Organizace" adds nothing by itself: it hands an exact
// brief to the person's agent, who follows the release's own adoption guide
// (the standard scaffold, a merge that keeps the template as an ancestor, a
// PR, activation confirmed by a person). A listing is discovery information,
// never permission or consent.

/** The language of the offers' words: the registry carries both. */
export type MarketplaceLocale = "cs" | "en";
export type Localized = Readonly<Record<MarketplaceLocale, string>>;

/** The section of the pilot. */
export const marketplaceSections = ["app-templates"] as const;
export type MarketplaceSection = (typeof marketplaceSections)[number];

/** How the adopted module starts: empty, or with the release's invented
 * example where the offer has one. */
export const adoptionSeeds = ["empty", "sample"] as const;
export type AdoptionSeed = (typeof adoptionSeeds)[number];

/** One release of an offer and what it is built on: the app generation
 * `app/v<N>`, which names the data layer, the stack profile release
 * (`app-data@2026.11`, docs/stack-profiles.md), the stack the scaffold
 * creates (`lazurio module create --stack`) and the Bun it pins
 * (`packageManager`), which a generation transition or a release of the
 * stack profile changes. `commit` is the full
 * commit the release tag points to and `artifactDigest` the digest of its
 * attested artifact: both are filled in only once the release is published.
 * A tag or a branch alone is not an immutable identity. */
export type MarketplaceRelease = Readonly<{
  version: string;
  tag: string;
  generation: string;
  stackProfile: string;
  stack: string;
  bun: string;
  commit: string | null;
  artifactDigest: string | null;
}>;

/** A release whose exact commit is recorded: the only kind offered. */
export type PublishedRelease = MarketplaceRelease &
  Readonly<{ commit: string }>;

/** A start's words: the dialog's choice and the end of the brief's "Začni
 * s …" (in Czech the person's own words, tykání, root decision 0199). */
export type MarketplaceSeed = Readonly<{ label: Localized; brief: Localized }>;

export type MarketplaceOffer = Readonly<{
  id: string;
  section: MarketplaceSection;
  title: string;
  /** The module slug an adoption proposes; the agent confirms it against
   * the Organization's own modules. */
  module: string;
  /** The public repository of the releases, `owner/name` on GitHub. */
  repository: string;
  /** The GitHub Organization that publishes the releases. */
  publisher: string;
  /** SPDX identifier of the module's license. */
  license: string;
  /** The stone the adopted module shows in Apps (shell/stones.ts); a key
   * this release does not know shows the plain app stone. */
  stone: StoneKey;
  summary: Localized;
  features: readonly Readonly<{ title: Localized; text: Localized }>[];
  seeds: Readonly<{ empty: MarketplaceSeed; sample: MarketplaceSeed | null }>;
  /** Screens of the offered release, paths in its repository. */
  screenshots: readonly Readonly<{ path: string; alt: Localized }>[];
  /** Every release, newest first. */
  releases: readonly MarketplaceRelease[];
  /** The release offered: the newest whose commit is recorded. */
  release: PublishedRelease;
}>;

/** The offers the Launchpad shows and where they come from: a registry read
 * at `commit`, or the copy built into this release. */
export type MarketplaceCatalog = Readonly<{
  source: "registry" | "built-in";
  commit: string | null;
  offers: readonly MarketplaceOffer[];
}>;

const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An offer's id: a slug of at most `offerIdLength` characters, so that its
 * longest adoption prompt id (`adoptionPromptId`) stays within the 64 of a
 * prompt id Chat takes (`promptIdLength`, chat-view.ts). */
export const offerIdLength = 32;
const offerId = new RegExp(`^[a-z0-9][a-z0-9-]{0,${offerIdLength - 1}}$`);
const repository = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const login = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const spdx = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const generation = /^app\/v[1-9][0-9]{0,3}$/;
const stackProfile =
  /^(content|app|app-data|app-database)@\d{4}\.\d{2}(\.\d+)?$/;
const exactVersion = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const version =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const fullCommit = /^[0-9a-f]{40}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const screenshotPath =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}\.webp$/;

type Fields = Readonly<Record<string, unknown>>;

/** The object's fields when it has exactly these keys (the optional ones
 * may be absent), else null: an index this release cannot read in full is
 * not read at all. */
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const keys = Object.keys(value);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (keys.some((key) => !required.includes(key) && !optional.includes(key)))
    return null;
  return value as Fields;
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function localized(value: unknown, max: number): Localized | null {
  const fields = exact(value, ["cs", "en"]);
  return fields !== null && text(fields.cs, max) && text(fields.en, max)
    ? Object.freeze({ cs: fields.cs, en: fields.en })
    : null;
}

function seed(value: unknown): MarketplaceSeed | null {
  const fields = exact(value, ["label", "brief"]);
  const label = localized(fields?.label, 40);
  const brief = localized(fields?.brief, 160);
  return label === null || brief === null
    ? null
    : Object.freeze({ label, brief });
}

function release(value: unknown): MarketplaceRelease | null {
  const fields = exact(value, [
    "version",
    "tag",
    "generation",
    "stackProfile",
    "stack",
    "bun",
    "commit",
    "artifactDigest",
  ]);
  if (fields === null) return null;
  const { stack, bun, commit, artifactDigest } = fields;
  if (
    typeof fields.version !== "string" ||
    !version.test(fields.version) ||
    fields.tag !== `v${fields.version}` ||
    typeof fields.generation !== "string" ||
    !generation.test(fields.generation) ||
    typeof fields.stackProfile !== "string" ||
    !stackProfile.test(fields.stackProfile) ||
    typeof stack !== "string" ||
    !slug.test(stack) ||
    typeof bun !== "string" ||
    !exactVersion.test(bun) ||
    !(
      commit === null ||
      (typeof commit === "string" && fullCommit.test(commit))
    )
  )
    return null;
  if (
    !(
      artifactDigest === null ||
      (commit !== null &&
        typeof artifactDigest === "string" &&
        digest.test(artifactDigest))
    )
  )
    return null;
  return Object.freeze({
    version: fields.version,
    tag: fields.tag,
    generation: fields.generation,
    stackProfile: fields.stackProfile,
    stack,
    bun,
    commit,
    artifactDigest,
  });
}

const offerKeys = [
  "schemaVersion",
  "id",
  "section",
  "title",
  "module",
  "repository",
  "publisher",
  "license",
  "stone",
  "pricing",
  "summary",
  "features",
  "seeds",
  "screenshots",
  "releases",
] as const;

function list<T>(
  value: unknown,
  read: (item: unknown) => T | null,
  max: number,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items: T[] = [];
  for (const item of value) {
    const read_ = read(item);
    if (read_ === null) return null;
    items.push(read_);
  }
  return Object.freeze(items);
}

/** An offer of the index as read: its id, and the offer once a release of
 * it has its commit; while none has one it is announced, valid and not
 * shown. Null when it is not a valid offer at all. */
type ReadOffer = Readonly<{ id: string; offer: MarketplaceOffer | null }>;

const published = (entry: MarketplaceRelease): entry is PublishedRelease =>
  entry.commit !== null;

function offer(value: unknown): ReadOffer | null {
  const fields = exact(value, offerKeys, ["movedFrom"]);
  if (
    fields === null ||
    fields.schemaVersion !== "lazurio.marketplace.offer.v1" ||
    fields.section !== "app-templates" ||
    fields.pricing !== "free"
  )
    return null;
  const { id, title, module, publisher, license, stone } = fields;
  const source = fields.repository;
  if (
    typeof id !== "string" ||
    !offerId.test(id) ||
    !text(title, 60) ||
    typeof module !== "string" ||
    !slug.test(module) ||
    typeof source !== "string" ||
    !repository.test(source) ||
    typeof publisher !== "string" ||
    !login.test(publisher) ||
    source.split("/")[0]?.toLowerCase() !== publisher.toLowerCase() ||
    !(
      fields.movedFrom === undefined ||
      (typeof fields.movedFrom === "string" &&
        repository.test(fields.movedFrom))
    ) ||
    typeof license !== "string" ||
    !spdx.test(license) ||
    typeof stone !== "string" ||
    !slug.test(stone)
  )
    return null;
  const summary = localized(fields.summary, 160);
  const features = list(
    fields.features,
    (item) => {
      const feature = exact(item, ["title", "text"]);
      const name = localized(feature?.title, 40);
      const words = localized(feature?.text, 280);
      return name === null || words === null
        ? null
        : Object.freeze({ title: name, text: words });
    },
    4,
  );
  const seedFields = exact(fields.seeds, ["empty"], ["sample"]);
  const empty = seed(seedFields?.empty);
  const sample =
    seedFields?.sample === undefined ? null : seed(seedFields.sample);
  const screenshots = list(
    fields.screenshots,
    (item) => {
      const shot = exact(item, ["path", "alt"]);
      const alt = localized(shot?.alt, 160);
      return typeof shot?.path === "string" &&
        screenshotPath.test(shot.path) &&
        alt !== null
        ? Object.freeze({ path: shot.path, alt })
        : null;
    },
    6,
  );
  const releases = list(fields.releases, release, 100);
  if (
    summary === null ||
    features === null ||
    features.length === 0 ||
    empty === null ||
    (seedFields?.sample !== undefined && sample === null) ||
    screenshots === null ||
    releases === null ||
    releases.length === 0
  )
    return null;
  const offered = releases.find(published);
  if (offered === undefined) return Object.freeze({ id, offer: null });
  return Object.freeze({
    id,
    offer: Object.freeze({
      id,
      section: "app-templates",
      title,
      module,
      repository: source,
      publisher,
      license,
      stone: (stoneKeys as readonly string[]).includes(stone)
        ? (stone as StoneKey)
        : "app",
      summary,
      features,
      seeds: Object.freeze({ empty, sample }),
      screenshots,
      releases,
      release: offered,
    }),
  });
}

/** The offers the Launchpad shows from a registry's `index.json`
 * (`lazurio.marketplace.index.v1`), or null. The index is read in full or
 * refused: an unknown schema, field or value, or an id used twice, refuses
 * all of it, and the Launchpad keeps what it showed before. Of a valid
 * index only the offers with a published release are shown; an announced
 * one is neither a card nor a detail nor a prompt. */
export function parseMarketplaceIndex(
  value: unknown,
): readonly MarketplaceOffer[] | null {
  const index = exact(value, ["schemaVersion", "offers"]);
  if (index?.schemaVersion !== "lazurio.marketplace.index.v1") return null;
  const read = list(index.offers, offer, 200);
  if (read === null) return null;
  const ids = new Set(read.map((entry) => entry.id));
  if (ids.size !== read.length) return null;
  return Object.freeze(read.flatMap((entry) => entry.offer ?? []));
}

const builtInOffers = parseMarketplaceIndex(builtInIndex);
if (builtInOffers === null)
  throw new Error("The built-in Marketplace index is not readable");

/** The registry's `index.json` as this release carries it: what the
 * Launchpad shows until it has read the registry. */
export const builtInMarketplace: MarketplaceCatalog = Object.freeze({
  source: "built-in",
  commit: null,
  offers: builtInOffers,
});

export const offerById = (
  catalog: MarketplaceCatalog,
  id: string,
): MarketplaceOffer | null =>
  catalog.offers.find((entry) => entry.id === id) ?? null;

/** The starts an offer has: empty always, then its example. */
export const seedsOf = (entry: MarketplaceOffer): readonly AdoptionSeed[] =>
  entry.seeds.sample === null ? ["empty"] : adoptionSeeds;

const seedOf = (entry: MarketplaceOffer, chosen: AdoptionSeed) =>
  chosen === "sample" ? entry.seeds.sample : entry.seeds.empty;

export const sourceUrl = (entry: MarketplaceOffer): string =>
  `https://github.com/${entry.repository}`;

export const releaseUrl = (entry: MarketplaceOffer): string =>
  `${sourceUrl(entry)}/releases/tag/${entry.release.tag}`;

/** Where a screen of the offered release is: the template's repository at
 * its exact commit. */
export const screenshotUrl = (entry: MarketplaceOffer, path: string): string =>
  `https://raw.githubusercontent.com/${entry.repository}/${entry.release.commit}/${path}`;

/** How much of the registry's commit an adoption prompt id carries, and
 * what it carries for the copy built into this release, which has none. */
export const catalogKeyLength = 12;
const builtInKey = "builtin";

/** The catalog a page shows, as a prompt id names it: the registry's commit
 * (its first `catalogKeyLength` characters), whose `index.json` fixes every
 * field of every offer, or `builtin`. */
export const catalogKey = (catalog: MarketplaceCatalog): string =>
  catalog.commit === null
    ? builtInKey
    : catalog.commit.slice(0, catalogKeyLength);

/** The prompt id of an adoption (prompts.ts): one per offer and seed of the
 * catalog the page shows, as a link carries only an id and the
 * Organization's login. The catalog is named exactly, so Chat's brief is
 * that catalog's offer, field for field, even when the Launchpad has read a
 * newer one since (`adoptionOf`). At most 64 characters (`offerIdLength`). */
export type AdoptionPromptId =
  `marketplace-${string}-${AdoptionSeed}-${string}`;

export const adoptionPromptId = (
  catalog: MarketplaceCatalog,
  entry: MarketplaceOffer,
  chosen: AdoptionSeed,
): AdoptionPromptId =>
  `marketplace-${entry.id}-${chosen}-${catalogKey(catalog)}`;

/** The offer and seed of an adoption prompt id among the catalogs the
 * Launchpad still serves (the current one and those it replaced within the
 * hour, `MarketplaceRegistry.catalogs`), or null: an unknown catalog, offer
 * or seed, and a key two of them share. */
export function adoptionOf(
  catalogs: readonly MarketplaceCatalog[],
  id: string,
): Readonly<{ offer: MarketplaceOffer; seed: AdoptionSeed }> | null {
  const found = new Map<
    string,
    { offer: MarketplaceOffer; seed: AdoptionSeed }
  >();
  const keys = new Set<string>();
  let shared = false;
  for (const catalog of catalogs) {
    const key = `${catalog.source}:${catalog.commit ?? ""}`;
    if (keys.has(key)) continue;
    keys.add(key);
    for (const entry of catalog.offers)
      for (const chosen of seedsOf(entry))
        if (adoptionPromptId(catalog, entry, chosen) === id) {
          if (found.size > 0) shared = true;
          found.set(key, { offer: entry, seed: chosen });
        }
  }
  return shared ? null : ([...found.values()][0] ?? null);
}

/** Whether an id has the shape of an adoption's, whichever catalog. */
export const isAdoptionPromptId = (id: string): boolean =>
  new RegExp(
    `^marketplace-[a-z0-9][a-z0-9-]{0,${offerIdLength - 1}}-(empty|sample)-([0-9a-f]{${catalogKeyLength}}|${builtInKey})$`,
  ).test(id);

/** Whether a release's App keeps data of its own: the generation names the
 * data layer, so from `app/v3` on (repository-db in v3, Dolt in v4). */
export const keepsData = (release: MarketplaceRelease): boolean =>
  Number(release.generation.slice("app/v".length)) >= 3;

/** The command the brief has the agent create the module with: the
 * release's stack, and `--data` from generation `app/v3` on, as the
 * template's own docs/adoption.md says. */
export const createCommand = (release: MarketplaceRelease): string =>
  `lazurio module create --stack ${release.stack}${keepsData(release) ? " --data" : ""}`;

/** The brief "Přidat do Organizace" hands to the agent: the person's own
 * words (in Czech tykání, root decision 0199), the exact release and the
 * Organization, and the release's adoption guide, which holds the steps.
 * Null when the offer has no such start. */
export function adoptionPrompt(
  entry: MarketplaceOffer,
  chosen: AdoptionSeed,
  organization: Readonly<{ name: string; login: string }>,
  copy: Copy,
  locale: MarketplaceLocale,
): string | null {
  const start = seedOf(entry, chosen);
  if (start === null) return null;
  return copy.marketAdoptPrompt
    .replaceAll("{title}", entry.title)
    .replaceAll("{name}", organization.name)
    .replaceAll("{login}", organization.login)
    .replaceAll("{repository}", entry.repository)
    .replaceAll("{tag}", entry.release.tag)
    .replaceAll("{commit}", entry.release.commit)
    .replaceAll("{license}", entry.license)
    .replaceAll("{module}", entry.module)
    .replaceAll("{create}", createCommand(entry.release))
    .replaceAll("{seed}", start.brief[locale]);
}
