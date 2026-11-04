import type { StoneKey } from "../shell/stones";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// The Marketplace of the Launchpad (plan DEV-6593, docs/marketplace.md): a
// small curated catalog with one section, Šablony aplikací, and in its pilot
// one offer, Presentations. The catalog is this record, built into the
// product: no service, account, price or install count. An offer names one
// release of a public template repository; the catalog never holds a second
// copy of its source. "Přidat do Organizace" adds nothing by itself: it hands
// an exact brief to the person's agent, who follows the release's own
// adoption guide (the standard scaffold, a merge that keeps the template as
// an ancestor, a PR, activation confirmed by a person). A listing is
// discovery information, never permission or consent.

/** The section of the pilot. */
export const marketplaceSections = ["app-templates"] as const;
export type MarketplaceSection = (typeof marketplaceSections)[number];

/** How the adopted module starts: an empty library, or with the release's
 * synthetic example presentation. */
export const adoptionSeeds = ["empty", "sample"] as const;
export type AdoptionSeed = (typeof adoptionSeeds)[number];

/** The exact release an offer names. `commit` is the full commit the release
 * tag points to and `artifactDigest` the digest of its attested artifact:
 * both are filled in only once the release is published, and until the
 * commit is known the offer cannot be adopted (`adoptable`). A tag or a
 * branch alone is not an immutable identity. */
export type MarketplaceRelease = Readonly<{
  version: string;
  tag: string;
  commit: string | null;
  artifactDigest: string | null;
}>;

export type MarketplaceOffer = Readonly<{
  id: string;
  section: MarketplaceSection;
  title: string;
  /** The module slug an adoption proposes; the agent confirms it against
   * the Organization's own modules. */
  module: string;
  /** The public repository of the release, `owner/name` on GitHub. */
  repository: string;
  /** The GitHub Organization that publishes the release. */
  publisher: string;
  /** SPDX identifier of the module's license. */
  license: string;
  release: MarketplaceRelease;
  /** The stack the scaffold creates (`lazurio module create --stack`). */
  stack: string;
  /** The Bun the template pins (`packageManager`). */
  bun: string;
  /** The stone the adopted module shows in Apps (shell/stones.ts). */
  stone: StoneKey;
  /** The words of its card and detail, by message key: one line, and what
   * the app does, each a short title with its sentence. */
  copy: Readonly<{
    summary: MessageKey;
    features: readonly Readonly<{ title: MessageKey; text: MessageKey }>[];
  }>;
}>;

/** The catalog of the pilot: Presentations, the first template of the
 * TemplatesRozjedeme-ai Organization (MIT, decided 2026-10-26), released
 * from its clean public repository, never from the private working one. Its release
 * v0.1.0 is not published yet: the commit and digest stay null until it is,
 * and the offer cannot be adopted before. */
export const marketplaceOffers: readonly MarketplaceOffer[] = [
  {
    id: "presentations",
    section: "app-templates",
    title: "Presentations",
    module: "presentations",
    repository: "TemplatesRozjedeme-ai/Presentations",
    publisher: "TemplatesRozjedeme-ai",
    license: "MIT",
    release: {
      version: "0.1.0",
      tag: "v0.1.0",
      commit: null,
      artifactDigest: null,
    },
    stack: "vite-react",
    bun: "1.4.2",
    stone: "presentation",
    copy: {
      summary: "marketPresentationsSummary",
      features: [
        {
          title: "marketPresentationsLibrary",
          text: "marketPresentationsLibraryText",
        },
        {
          title: "marketPresentationsPlayback",
          text: "marketPresentationsPlaybackText",
        },
        {
          title: "marketPresentationsAgent",
          text: "marketPresentationsAgentText",
        },
      ],
    },
  },
];

export const offerById = (id: string): MarketplaceOffer | null =>
  marketplaceOffers.find((offer) => offer.id === id) ?? null;

const fullCommit = /^[0-9a-f]{40}$/;

/** Whether an offer may be handed to an agent: only a release whose exact
 * commit is recorded. */
export const adoptable = (offer: MarketplaceOffer): boolean =>
  offer.release.commit !== null && fullCommit.test(offer.release.commit);

export const sourceUrl = (offer: MarketplaceOffer): string =>
  `https://github.com/${offer.repository}`;

export const releaseUrl = (offer: MarketplaceOffer): string =>
  `${sourceUrl(offer)}/releases/tag/${offer.release.tag}`;

/** The prompt id of an adoption (prompts.ts): one per offer and seed, as a
 * link carries only an id and the Organization's login. */
export type AdoptionPromptId = `marketplace-${string}-${AdoptionSeed}`;

export const adoptionPromptId = (
  offer: MarketplaceOffer,
  seed: AdoptionSeed,
): AdoptionPromptId => `marketplace-${offer.id}-${seed}`;

/** The offer and seed of an adoption prompt id, or null. */
export function adoptionOf(
  id: string,
): Readonly<{ offer: MarketplaceOffer; seed: AdoptionSeed }> | null {
  for (const offer of marketplaceOffers)
    for (const seed of adoptionSeeds)
      if (adoptionPromptId(offer, seed) === id) return { offer, seed };
  return null;
}

/** The brief "Přidat do Organizace" hands to the agent: the person's own
 * words (in Czech tykání, root decision 0199), the exact release and the
 * Organization, and the release's adoption guide, which holds the steps.
 * Null while the offer cannot be adopted. */
export function adoptionPrompt(
  offer: MarketplaceOffer,
  seed: AdoptionSeed,
  organization: Readonly<{ name: string; login: string }>,
  copy: Copy,
): string | null {
  if (!adoptable(offer) || offer.release.commit === null) return null;
  return copy.marketAdoptPrompt
    .replaceAll("{title}", offer.title)
    .replaceAll("{name}", organization.name)
    .replaceAll("{login}", organization.login)
    .replaceAll("{repository}", offer.repository)
    .replaceAll("{tag}", offer.release.tag)
    .replaceAll("{commit}", offer.release.commit)
    .replaceAll("{license}", offer.license)
    .replaceAll("{module}", offer.module)
    .replaceAll("{stack}", offer.stack)
    .replaceAll(
      "{seed}",
      copy[
        seed === "sample" ? "marketSeedSampleBrief" : "marketSeedEmptyBrief"
      ],
    );
}
