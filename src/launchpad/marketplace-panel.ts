import type { Catalog, CatalogOrganization } from "../organizations/catalog";
import { stoneOf } from "../shell/stones";
import type { NewModuleOutcome, NewModulePrompt } from "./catalog-panel";
import { organizationName } from "./catalog-view";
import {
  type AdoptionSeed,
  adoptionPrompt,
  adoptionPromptId,
  builtInMarketplace,
  type MarketplaceCatalog,
  type MarketplaceLocale,
  type MarketplaceOffer,
  offerById,
  screenshotUrl,
  seedsOf,
} from "./marketplace";
import {
  createMarketplaceRefresh,
  type MarketplaceAnswer,
} from "./marketplace-refresh";
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
// creates nothing itself. Only offers with a published release are in the
// catalog (marketplace.ts), so every one can be added. The offers are the
// Launchpad's answer (`POST /api/marketplace`: the registry at one commit, or
// the built-in copy), read each time the page is entered and again while it
// stays open (marketplace-refresh.ts); until the first answer the built-in
// copy. "Pokračovat v Chatu" hands over at once, still within the click
// (Chat's tab and the clipboard need it), the offer of the catalog the page
// shows: its prompt id names that catalog, so Chat gets that offer field for
// field even when the Launchpad has read a newer one since. An offer that
// changes while its dialog is open is drawn again and the dialog says so.
// A hand-over says how it ended only in the dialog that started it: one
// closed, opened on another offer or drawn again for a newer version of its
// offer in the meantime keeps what it shows and says. Every value is drawn
// with textContent.
export function createMarketplacePanel(
  options: Readonly<{
    copy: () => Copy;
    locale: () => MarketplaceLocale;
    route: () => PageRoute;
    /** The Launchpad's offers, or null when they could not be read. */
    load: () => Promise<MarketplaceAnswer | null>;
    /** The offers changed: titles that name one are drawn again. */
    changed: () => void;
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
  // Each showing of the dialog has its own number: a new one when it opens,
  // when it closes and when a read replaces the offer it shows with another
  // version. A hand-over's outcome belongs to the showing that started it.
  let showing = 0;
  // The screen the detail shows large.
  let shown: string | null = null;
  // The offers shown: the built-in copy until the Launchpad's answer.
  let offers: MarketplaceCatalog = builtInMarketplace;
  // Whether a read ended at all, so that "not found" and "no templates"
  // are said only then.
  let loaded = false;
  const refresh = createMarketplaceRefresh({
    load: options.load,
    answered: (read, changed) => {
      const first = !loaded;
      loaded = true;
      if (read === null || !changed) {
        if (first) render();
        return;
      }
      offers = read;
      if (adding !== null) {
        const now = offerById(offers, adding.id);
        if (now !== null && JSON.stringify(now) !== JSON.stringify(adding)) {
          showing += 1;
          if (dialog.open)
            said = fill(options.copy().marketChanged, { title: now.title });
        }
        adding = now ?? adding;
      }
      render();
      options.changed();
    },
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh.wake();
  });

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
  const remote = (url: string, alt: string) => {
    const image = element("img", "market-shot");
    image.src = url;
    image.alt = alt;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    return image;
  };
  /** An offer's screens, each a key, its image and its words: those of the
   * offered release, from its exact commit. */
  const shotsOf = (offer: MarketplaceOffer) => {
    const locale = options.locale();
    return offer.screenshots.map((shot) => {
      const url = screenshotUrl(offer, shot.path);
      return {
        key: shot.path,
        alt: shot.alt[locale],
        image: (alt: string) => remote(url, alt),
      };
    });
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
      refresh.leave();
      return;
    }
    refresh.enter();
    const offer =
      route.offer === undefined ? null : offerById(offers, route.offer);
    // Another offer, or back on the catalog: the dialog closes.
    if (adding !== null && adding.id !== offer?.id && dialog.open)
      dialog.close();
    body.replaceChildren(
      route.offer === undefined
        ? catalogView()
        : offer === null
          ? missingView(loaded)
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
    for (const offer of offers.offers) grid.append(card(offer));
    section.append(sectionHead, grid);
    // No published template yet: said once the Launchpad's offers are read.
    if (offers.offers.length === 0 && loaded)
      section.append(element("p", "empty", copy.marketEmpty));
    view.append(head, section);
    return view;
  }

  function card(offer: MarketplaceOffer) {
    const link = element("a", "market-card");
    link.href = `/marketplace/${encodeURIComponent(offer.id)}`;
    link.dataset.route = "";
    const first = shotsOf(offer)[0];
    if (first !== undefined) {
      const shot = element("span", "market-card-shot");
      shot.append(first.image(""));
      link.append(shot);
    }
    const text = element("span", "market-card-body");
    const words = element("span", "tile-body");
    words.append(
      element("span", "tile-name", offer.title),
      element("span", "tile-desc", offer.summary[options.locale()]),
    );
    text.append(stone(offer, 44), words);
    link.append(text);
    return link;
  }

  function back() {
    const link = element("a", "back");
    link.href = "/marketplace";
    link.dataset.route = "";
    link.append(svg("chevron-left"), options.copy().marketBack);
    return link;
  }

  /** An offer the catalog does not have; until the Launchpad's offers
   * are read it may still come, so nothing is said yet. */
  function missingView(known: boolean) {
    const copy = options.copy();
    const view = element("div", "market-view");
    view.append(back(), heading(copy.appsMarketplace));
    if (known) view.append(element("p", "empty", copy.marketNotFound));
    return view;
  }

  function offerView(offer: MarketplaceOffer) {
    const copy = options.copy();
    const locale = options.locale();
    const view = element("div", "market-view");

    const head = element("header", "market-detail-head");
    const title = element("div", "market-detail-title");
    title.append(
      heading(offer.title),
      element("p", "market-summary", offer.summary[locale]),
    );
    const add = element("button", "primary market-add", copy.marketAdd);
    add.type = "button";
    add.setAttribute("aria-haspopup", "dialog");
    add.addEventListener("click", () => open(offer));
    head.append(stone(offer, 64), title, add);

    const shots = screens(offer);

    const features = element("ul", "market-features");
    for (const feature of offer.features) {
      const item = element("li");
      item.append(
        element("h2", undefined, feature.title[locale]),
        element("p", undefined, feature.text[locale]),
      );
      features.append(item);
    }

    view.append(back(), head);
    if (shots !== null) view.append(shots);
    view.append(features);
    return view;
  }

  /** The app's real screens: one large, the others as thumbnails that
   * show it instead. */
  function screens(offer: MarketplaceOffer) {
    const all = shotsOf(offer);
    const first = all[0];
    if (first === undefined) return null;
    if (!all.some((entry) => entry.key === shown)) shown = first.key;
    const view = element("div", "market-shots");
    const large = element("div", "market-shot-large");
    const current = all.find((entry) => entry.key === shown) ?? first;
    large.append(current.image(current.alt));
    const thumbs = element("div", "market-thumbs");
    if (all.length > 1)
      for (const { key: name, alt, image } of all) {
        const button = element("button", "market-thumb");
        button.type = "button";
        button.setAttribute("aria-label", alt);
        button.setAttribute("aria-pressed", String(name === shown));
        button.append(image(""));
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
    showing += 1;
    drawDialog(offer);
    if (!dialog.open) dialog.showModal();
    dialogTitle.focus();
  }

  dialog.addEventListener("close", () => {
    showing += 1;
    said = null;
  });
  for (const button of [dialogClose, dialogCancel])
    button.addEventListener("click", () => dialog.close());
  dialogOk.addEventListener("click", () => {
    const chosen = chosenTarget();
    // The offer as the catalog the page shows has it now; gone from it, the
    // page is drawn again and the dialog closes.
    const offer = adding === null ? null : offerById(offers, adding.id);
    if (adding !== null && offer === null) {
      render();
      return;
    }
    if (offer === null || chosen === null || busy) return;
    const text = adoptionPrompt(
      offer,
      seed,
      { name: organizationName(chosen), login: chosen.forgeLogin },
      options.copy(),
      options.locale(),
    );
    if (text === null) return;
    busy = true;
    const started = showing;
    drawDialog(offer);
    void options
      .handOver({
        id: adoptionPromptId(offers, offer, seed),
        organization: chosen.forgeLogin,
        text,
      })
      .then(
        (outcome) => outcome,
        (): NewModuleOutcome => "failed",
      )
      .then((outcome) => {
        busy = false;
        // Said only in the showing that handed over. Whatever the dialog
        // shows now, the offer as this catalog has it, is drawn again with
        // its own words, so that its button works again; it never goes back
        // to the offer handed over.
        if (showing === started) {
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
        }
        if (dialog.open && adding !== null) drawDialog(adding);
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

    const starts = seedsOf(offer);
    if (!starts.includes(seed)) seed = "empty";
    const seeds = element("fieldset", "market-seeds");
    seeds.append(element("legend", undefined, copy.marketStart));
    for (const value of starts) {
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
          (value === "sample" ? offer.seeds.sample : offer.seeds.empty)?.label[
            options.locale()
          ] ?? "",
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
    // An offer with one start has nothing to choose.
    const parts: HTMLElement[] =
      starts.length > 1 ? [field, seeds, what] : [field, what];
    if (chosen?.modules.some((module) => module.module === offer.module))
      parts.push(
        element(
          "p",
          "callout",
          fill(copy.marketTaken, { name, module: offer.module }),
        ),
      );
    dialogBody.replaceChildren(...parts);

    dialogOk.disabled = chosen === null || busy;
    dialogStatus.textContent = said ?? "";
  }

  return {
    render,
    /** An offer's title in the offers shown, by its id. */
    title: (id: string) => offerById(offers, id)?.title,
  };
}
