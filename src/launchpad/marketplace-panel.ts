import type { Catalog, CatalogOrganization } from "../organizations/catalog";
import type { NewModuleOutcome, NewModulePrompt } from "./catalog-panel";
import { organizationName } from "./catalog-view";
import {
  type AdoptionSeed,
  adoptable,
  adoptionPrompt,
  adoptionPromptId,
  adoptionSeeds,
  type MarketplaceOffer,
  marketplaceOffers,
  offerById,
  releaseUrl,
  sourceUrl,
} from "./marketplace";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The Marketplace page (plan DEV-6593, marketplace.ts): `/marketplace` is
// Šablony aplikací with the card of each offer, `/marketplace/<offer>` its
// detail, and on the detail "Přidat do Organizace" opens the form under it:
// the Organization, chosen only from those this Folder's catalog binds to
// GitHub (an address is never the target's authority), how the module
// starts, what will happen and the technical details. "Předat agentovi"
// hands the exact brief to Chat as "+ Nový modul" does (ui.ts `handOver`)
// and says truthfully what happened; it creates nothing itself. While the
// offer's release has no recorded commit the button is disabled and says
// why. Every value is drawn with textContent.
export function createMarketplacePanel(
  options: Readonly<{
    copy: () => Copy;
    route: () => PageRoute;
    /** This Folder's catalog, or null until it is read. */
    catalog: () => Catalog | null;
    handOver: (prompt: NewModulePrompt) => Promise<NewModuleOutcome>;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing Marketplace UI");
    return element;
  };
  const body = find<HTMLDivElement>("#market-body");
  const pictures = find<HTMLDivElement>("#market-pictures");

  // The form's state, kept while the page draws again (a catalog read, the
  // language): open, the chosen Organization by its login, the seed and
  // the last outcome.
  let adding = false;
  let target: string | null = null;
  let seed: AdoptionSeed = "empty";
  let said: string | null = null;
  let busy = false;
  let shownOffer: string | null = null;
  // Which of the offer's technical details are open, kept as well.
  const opened = new Set<string>();

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = (name: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };
  const fill = (text: string, values: Readonly<Record<string, string>>) =>
    Object.entries(values).reduce(
      (result, [key, value]) => result.replaceAll(`{${key}}`, value),
      text,
    );
  const picture = (name: string, alt: string) => {
    const source = pictures.querySelector<HTMLImageElement>(
      `img[data-picture="${name}"]`,
    );
    const image = (source?.cloneNode() ?? element("img")) as HTMLImageElement;
    image.alt = alt;
    image.className = "market-shot";
    return image;
  };
  const disclosure = (name: string, label: string) => {
    const details = element("details", "technical");
    details.open = opened.has(name);
    details.addEventListener("toggle", () => {
      if (details.open) opened.add(name);
      else opened.delete(name);
    });
    details.append(element("summary", undefined, label));
    return details;
  };
  const heading = (text: string) => {
    const node = element("h1", "apps-title", text);
    node.tabIndex = -1;
    node.dataset.pageHeading = "";
    return node;
  };

  /** The Organizations an offer may go to: those of this Folder bound to a
   * GitHub login, as the prompt route accepts them (prompts.ts). */
  const targets = (): readonly (CatalogOrganization & {
    forgeLogin: string;
  })[] =>
    (options.catalog()?.organizations ?? []).filter(
      (
        organization,
      ): organization is CatalogOrganization & {
        forgeLogin: string;
      } =>
        organization.forgeLogin !== undefined &&
        organization.organization !== null,
    );

  function render(route: PageRoute = options.route()) {
    if (route.view !== "marketplace") return;
    const offer = route.offer === undefined ? null : offerById(route.offer);
    // Another offer, or back on the catalog: the form starts closed.
    const showing = offer?.id ?? null;
    if (showing !== shownOffer) {
      shownOffer = showing;
      adding = false;
      said = null;
      opened.clear();
    }
    body.replaceChildren(
      route.offer === undefined
        ? catalogView()
        : offer === null
          ? missingView()
          : offerView(offer),
    );
  }

  function catalogView() {
    const copy = options.copy();
    const view = element("div", "market-view");
    const head = element("header", "market-head");
    const mark = element("span", "market-icon");
    mark.append(svg("shop"));
    const text = element("div", "module-head-text");
    text.append(
      heading(copy.appsMarketplace),
      element("p", "module-meta", copy.marketIntro),
    );
    head.append(mark, text);
    const section = element("section", "group");
    section.setAttribute("aria-labelledby", "market-section-app-templates");
    const sectionHead = element("div", "group-head");
    const title = element("h2", undefined, copy.marketAppTemplates);
    title.id = "market-section-app-templates";
    sectionHead.append(title);
    const grid = element("div", "market-grid");
    for (const offer of marketplaceOffers) grid.append(card(offer));
    section.append(sectionHead, grid);
    view.append(head, section);
    return view;
  }

  function card(offer: MarketplaceOffer) {
    const copy = options.copy();
    const link = element("a", "market-card");
    link.href = `/marketplace/${encodeURIComponent(offer.id)}`;
    link.dataset.route = "";
    const shot = element("span", "market-card-shot");
    shot.append(picture(`${offer.id}-gallery`, ""));
    const text = element("span", "market-card-body");
    text.append(
      element("span", "market-card-name", offer.title),
      badge(),
      element("span", "market-card-desc", copy[offer.copy.summary]),
    );
    link.append(shot, text);
    return link;
  }

  function badge() {
    const node = element("span", "market-badge");
    node.append(svg("check"), options.copy().marketBadge);
    return node;
  }

  function missingView() {
    const copy = options.copy();
    const view = element("div", "market-view");
    const back = element("a", "back");
    back.href = "/marketplace";
    back.dataset.route = "";
    back.append(svg("chevron-left"), copy.marketBack);
    view.append(
      back,
      heading(copy.appsMarketplace),
      element("p", "empty", copy.marketNotFound),
    );
    return view;
  }

  function offerView(offer: MarketplaceOffer) {
    const copy = options.copy();
    const view = element("div", "market-view");
    const back = element("a", "back");
    back.href = "/marketplace";
    back.dataset.route = "";
    back.append(svg("chevron-left"), copy.marketBack);

    const head = element("header", "market-detail-head");
    const text = element("div", "module-head-text");
    text.append(
      heading(offer.title),
      badge(),
      element(
        "p",
        "module-meta",
        `${fill(copy.marketVersion, { version: offer.release.version })} · ${fill(
          copy.marketLicense,
          { license: offer.license },
        )}`,
      ),
    );
    const add = element("button", "primary market-add", copy.marketAdd);
    add.type = "button";
    add.setAttribute("aria-expanded", String(adding));
    add.setAttribute("aria-controls", "market-add");
    add.addEventListener("click", () => {
      adding = !adding;
      said = null;
      render();
      if (adding)
        document
          .querySelector<HTMLElement>("#market-add h2")
          ?.focus({ preventScroll: false });
    });
    head.append(text, add);

    const shots = element("div", "market-shots");
    for (const [name, alt] of [
      ["gallery", copy.marketScreensGallery],
      ["slide", copy.marketScreensSlide],
    ] as const) {
      const figure = element("figure", "market-figure");
      figure.append(
        picture(`${offer.id}-${name}`, alt),
        element("figcaption", undefined, alt),
      );
      shots.append(figure);
    }

    const about = element("section", "market-about");
    about.append(element("p", "market-lead", copy[offer.copy.description]));
    const contains = element("div", "market-list");
    contains.append(element("h2", undefined, copy.marketWhatIs));
    const list = element("ul");
    for (const key of offer.copy.contents)
      list.append(element("li", undefined, copy[key]));
    contains.append(list);
    const limits = element("div", "market-list");
    limits.append(element("h2", undefined, copy.marketWhatNot));
    for (const key of offer.copy.limits)
      limits.append(element("p", undefined, copy[key]));
    about.append(contains, limits);

    view.append(back, head, shots, about, technical(offer));
    if (adding) view.append(form(offer));
    return view;
  }

  function technical(offer: MarketplaceOffer) {
    const copy = options.copy();
    const details = disclosure("offer", copy.marketTechnical);
    const rows = element("dl", "card market-facts");
    const row = (label: string, value: Node | string) => {
      const item = element("div", "row market-fact");
      const term = element("dt", undefined, label);
      const description = element("dd");
      description.append(value);
      item.append(term, description);
      rows.append(item);
    };
    row(
      copy.marketRequirements,
      fill(copy.marketRequirementsText, { bun: offer.bun }),
    );
    row(copy.marketData, copy[offer.copy.data]);
    row(
      copy.marketCompatibility,
      fill(copy.marketCompatibilityText, { stack: offer.stack }),
    );
    const source = element("a", undefined, offer.repository);
    source.href = sourceUrl(offer);
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    row(copy.marketSource, source);
    const release = offer.release;
    if (release.commit === null)
      row(
        copy.marketRelease,
        fill(copy.marketReleasePending, { tag: release.tag }),
      );
    else {
      const link = element(
        "a",
        undefined,
        fill(copy.marketReleaseCommit, {
          tag: release.tag,
          commit: release.commit.slice(0, 12),
        }),
      );
      link.href = releaseUrl(offer);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row(copy.marketRelease, link);
    }
    details.append(rows);
    return details;
  }

  function form(offer: MarketplaceOffer) {
    const copy = options.copy();
    const section = element("section", "card market-form");
    section.id = "market-add";
    const title = element(
      "h2",
      undefined,
      fill(copy.marketAddTitle, { title: offer.title }),
    );
    title.tabIndex = -1;
    section.append(title, element("p", "intro", copy.marketAddIntro));

    const choices = targets();
    if (
      target === null ||
      !choices.some((entry) => entry.forgeLogin === target)
    )
      target = choices[0]?.forgeLogin ?? null;
    const chosen = choices.find((entry) => entry.forgeLogin === target) ?? null;

    const field = element("div", "market-field");
    if (options.catalog() === null)
      field.append(element("p", "module-meta", copy.catalogLoading));
    else if (choices.length === 0)
      field.append(element("p", "callout", copy.marketTargetNone));
    else {
      const label = element("label", undefined, copy.marketTarget);
      label.htmlFor = "market-target";
      const select = element("select");
      select.id = "market-target";
      for (const entry of choices) {
        const option = element("option", undefined, organizationName(entry));
        option.value = entry.forgeLogin;
        option.selected = entry.forgeLogin === target;
        select.append(option);
      }
      select.addEventListener("change", () => {
        target = select.value;
        said = null;
        render();
        document.querySelector<HTMLSelectElement>("#market-target")?.focus();
      });
      field.append(label, select);
    }

    const seeds = element("fieldset", "market-seeds");
    seeds.append(element("legend", undefined, copy.marketStart));
    for (const value of adoptionSeeds) {
      const label = element("label", "market-seed");
      const input = element("input");
      input.type = "radio";
      input.name = "market-seed";
      input.value = value;
      input.checked = seed === value;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        seed = value;
        said = null;
        render();
        document
          .querySelector<HTMLInputElement>(
            `input[name="market-seed"][value="${value}"]`,
          )
          ?.focus();
      });
      const words = element("span");
      words.append(
        element(
          "span",
          undefined,
          copy[value === "sample" ? "marketSeedSample" : "marketSeedEmpty"],
        ),
      );
      if (value === "sample")
        words.append(element("span", "module-meta", copy.marketSeedSampleNote));
      label.append(input, words);
      seeds.append(label);
    }

    const plan = element("div", "market-plan");
    plan.append(element("h3", undefined, copy.marketPlan));
    const steps = element("ul");
    const name = chosen === null ? "—" : organizationName(chosen);
    for (const text of [
      fill(copy.marketPlanRelease, {
        tag: offer.release.tag,
        repository: offer.repository,
        license: offer.license,
      }),
      fill(copy.marketPlanTarget, { title: offer.title, name }),
      fill(copy.marketPlanRepository, { module: offer.module }),
      copy.marketPlanTeams,
      copy.marketPlanCode,
      copy.marketPlanRights,
    ])
      steps.append(element("li", undefined, text));
    plan.append(steps);
    if (chosen?.modules.some((module) => module.module === offer.module))
      plan.append(
        element(
          "p",
          "callout",
          fill(copy.marketTaken, { module: offer.module }),
        ),
      );

    const details = disclosure("form", copy.marketTechnical);
    const facts = element("dl", "card market-facts");
    for (const [label, value] of [
      [copy.marketTechnicalSlug, offer.module],
      [copy.marketTechnicalRepository, copy.marketTechnicalRepositoryValue],
    ] as const) {
      const item = element("div", "row market-fact");
      item.append(
        element("dt", undefined, label),
        element("dd", undefined, value),
      );
      facts.append(item);
    }
    details.append(facts);

    const actions = element("div", "market-actions");
    const ready = adoptable(offer);
    const button = element("button", "primary", copy.marketHandOver);
    button.type = "button";
    button.disabled = !ready || chosen === null || busy;
    if (!ready) {
      const why = element(
        "p",
        "module-meta",
        fill(copy.marketNotYet, { tag: offer.release.tag }),
      );
      why.id = "market-not-yet";
      button.setAttribute("aria-describedby", why.id);
      actions.append(button, why);
    } else actions.append(button);
    button.addEventListener("click", () => {
      if (chosen === null) return;
      const text = adoptionPrompt(
        offer,
        seed,
        { name: organizationName(chosen), login: chosen.forgeLogin },
        copy,
      );
      if (text === null) return;
      busy = true;
      render();
      void options
        .handOver({
          id: adoptionPromptId(offer, seed),
          organization: chosen.forgeLogin,
          text,
        })
        .then(
          (outcome) => outcome,
          (): NewModuleOutcome => "failed",
        )
        .then((outcome) => {
          busy = false;
          const now = options.copy();
          said = fill(
            {
              "handed-over": now.marketHandedOver,
              copied: now.marketCopied,
              failed: now.marketCopyFailed,
              "needs-ai": now.appsNewModuleNeedsAi,
            }[outcome],
            { title: offer.title },
          );
          render();
        });
    });
    const status = element("p", "market-status", said ?? "");
    status.setAttribute("role", "status");

    section.append(field, seeds, plan, details, actions, status);
    return section;
  }

  return { render };
}
