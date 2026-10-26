import type { Catalog, CatalogOrganization } from "../organizations/catalog";
import { stoneOf } from "../shell/stones";
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
} from "./marketplace";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The Marketplace page (plan DEV-6593, marketplace.ts): `/marketplace` is
// Šablony aplikací with the card of each offer, `/marketplace/<offer>` its
// detail: the stone and name its module will have in Apps, real screens of
// the app and what it does, nothing technical. "Přidat do Organizace" opens a
// dialog: the Organization, chosen only from those this Folder's catalog
// binds to GitHub (an address is never the target's authority), how the
// module starts and one sentence on what follows. "Pokračovat v Chatu"
// hands the exact brief to Chat as "+ Nový modul" does (ui.ts `handOver`),
// where the agent shows the plan to approve before anything changes; it
// creates nothing itself. While the offer's release has no recorded commit
// the button is disabled and says why. Every value is drawn with
// textContent.
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
  const dialog = find<HTMLDialogElement>("#market-dialog");
  const dialogTitle = find<HTMLHeadingElement>("#market-dialog-title");
  const dialogBody = find<HTMLDivElement>("#market-dialog-body");
  const dialogStatus = find<HTMLParagraphElement>("#market-dialog-status");
  const dialogClose = find<HTMLButtonElement>("#market-dialog-close");
  const dialogCancel = find<HTMLButtonElement>("#market-dialog-cancel");
  const dialogOk = find<HTMLButtonElement>("#market-dialog-ok");

  // The dialog's state, kept while it draws again (a catalog read, the
  // language): the offer it adds, the chosen Organization by its login,
  // the seed and the last outcome.
  let adding: MarketplaceOffer | null = null;
  let target: string | null = null;
  let seed: AdoptionSeed = "empty";
  let said: string | null = null;
  let busy = false;
  // The screen the detail shows large.
  let shown: string | null = null;

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
  const stone = (offer: MarketplaceOffer, size: number) => {
    const image = element("img", "market-stone");
    image.src = stoneOf(offer.stone).src;
    image.alt = "";
    image.width = size;
    image.height = size;
    image.decoding = "async";
    image.setAttribute("aria-hidden", "true");
    return image;
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
    if (route.view !== "marketplace") {
      if (dialog.open) dialog.close();
      return;
    }
    const offer = route.offer === undefined ? null : offerById(route.offer);
    // Another offer, or back on the catalog: the dialog closes.
    if (adding !== null && adding.id !== offer?.id && dialog.open)
      dialog.close();
    body.replaceChildren(
      route.offer === undefined
        ? catalogView()
        : offer === null
          ? missingView()
          : offerView(offer),
    );
    if (adding !== null && dialog.open) drawDialog(adding);
  }

  function catalogView() {
    const copy = options.copy();
    const view = element("div", "market-view");
    const head = element("header", "market-head");
    head.append(heading(copy.appsMarketplace));
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
    const words = element("span", "tile-body");
    words.append(
      element("span", "tile-name", offer.title),
      element("span", "tile-desc", copy[offer.copy.summary]),
    );
    text.append(stone(offer, 44), words);
    link.append(shot, text);
    return link;
  }

  function back() {
    const link = element("a", "back");
    link.href = "/marketplace";
    link.dataset.route = "";
    link.append(svg("chevron-left"), options.copy().marketBack);
    return link;
  }

  function missingView() {
    const copy = options.copy();
    const view = element("div", "market-view");
    view.append(
      back(),
      heading(copy.appsMarketplace),
      element("p", "empty", copy.marketNotFound),
    );
    return view;
  }

  function offerView(offer: MarketplaceOffer) {
    const copy = options.copy();
    const view = element("div", "market-view");

    const head = element("header", "market-detail-head");
    const title = element("div", "market-detail-title");
    title.append(
      heading(offer.title),
      element("p", "market-summary", copy[offer.copy.summary]),
    );
    const add = element("button", "primary market-add", copy.marketAdd);
    add.type = "button";
    add.setAttribute("aria-haspopup", "dialog");
    add.addEventListener("click", () => open(offer));
    head.append(stone(offer, 64), title, add);

    const shots = screens(offer);

    const features = element("ul", "market-features");
    for (const feature of offer.copy.features) {
      const item = element("li");
      item.append(
        element("h2", undefined, copy[feature.title]),
        element("p", undefined, copy[feature.text]),
      );
      features.append(item);
    }

    view.append(back(), head, shots, features);
    return view;
  }

  /** The app's real screens: one large, the others as thumbnails that
   * show it instead. */
  function screens(offer: MarketplaceOffer) {
    const copy = options.copy();
    const all = [
      [`${offer.id}-gallery`, copy.marketScreensGallery],
      [`${offer.id}-slide`, copy.marketScreensSlide],
    ] as const;
    if (!all.some(([name]) => name === shown)) shown = all[0][0];
    const view = element("div", "market-shots");
    const large = element("div", "market-shot-large");
    const current = all.find(([name]) => name === shown) ?? all[0];
    large.append(picture(current[0], current[1]));
    const thumbs = element("div", "market-thumbs");
    for (const [name, alt] of all) {
      const button = element("button", "market-thumb");
      button.type = "button";
      button.setAttribute("aria-label", alt);
      button.setAttribute("aria-pressed", String(name === shown));
      button.append(picture(name, ""));
      button.addEventListener("click", () => {
        shown = name;
        render();
        document
          .querySelector<HTMLButtonElement>(
            `.market-thumb[aria-label="${CSS.escape(alt)}"]`,
          )
          ?.focus();
      });
      thumbs.append(button);
    }
    view.append(large, thumbs);
    return view;
  }

  function open(offer: MarketplaceOffer) {
    if (adding?.id !== offer.id) {
      seed = "empty";
      target = null;
    }
    adding = offer;
    said = null;
    drawDialog(offer);
    if (!dialog.open) dialog.showModal();
    dialogTitle.focus();
  }

  dialog.addEventListener("close", () => {
    said = null;
  });
  for (const button of [dialogClose, dialogCancel])
    button.addEventListener("click", () => dialog.close());
  dialogOk.addEventListener("click", () => {
    const offer = adding;
    const chosen = chosenTarget();
    if (offer === null || chosen === null || busy) return;
    const text = adoptionPrompt(
      offer,
      seed,
      { name: organizationName(chosen), login: chosen.forgeLogin },
      options.copy(),
    );
    if (text === null) return;
    busy = true;
    drawDialog(offer);
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
        if (dialog.open) drawDialog(offer);
      });
  });

  /** The chosen Organization, the first one until a person picks. */
  function chosenTarget() {
    const choices = targets();
    if (
      target === null ||
      !choices.some((entry) => entry.forgeLogin === target)
    )
      target = choices[0]?.forgeLogin ?? null;
    return choices.find((entry) => entry.forgeLogin === target) ?? null;
  }

  function drawDialog(offer: MarketplaceOffer) {
    const copy = options.copy();
    dialogTitle.textContent = fill(copy.marketAddTitle, { title: offer.title });
    dialogClose.setAttribute("aria-label", copy.marketClose);
    dialogCancel.textContent = copy.marketCancel;
    dialogOk.textContent = copy.marketHandOver;

    const choices = targets();
    const chosen = chosenTarget();

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
        drawDialog(offer);
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
        drawDialog(offer);
        document
          .querySelector<HTMLInputElement>(
            `input[name="market-seed"][value="${value}"]`,
          )
          ?.focus();
      });
      label.append(
        input,
        element(
          "span",
          undefined,
          copy[value === "sample" ? "marketSeedSample" : "marketSeedEmpty"],
        ),
      );
      seeds.append(label);
    }

    const name = chosen === null ? "—" : organizationName(chosen);
    const what = element(
      "p",
      "market-what",
      fill(copy.marketWhat, { title: offer.title, name }),
    );
    const parts: HTMLElement[] = [field, seeds, what];
    if (chosen?.modules.some((module) => module.module === offer.module))
      parts.push(
        element(
          "p",
          "callout",
          fill(copy.marketTaken, { name, module: offer.module }),
        ),
      );
    dialogBody.replaceChildren(...parts);

    const ready = adoptable(offer);
    dialogOk.disabled = !ready || chosen === null || busy;
    dialogStatus.textContent =
      said ??
      (ready
        ? ""
        : fill(copy.marketNotYet, { version: offer.release.version }));
  }

  return { render };
}
