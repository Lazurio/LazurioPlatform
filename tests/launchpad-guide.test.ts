import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageGuide } from "../src/launchpad/guides";
import { messages } from "../src/launchpad/messages";
import type { PageRoute } from "../src/launchpad/routes";
import {
  type ShellEnvironmentKind,
  shellEnvironmentKinds,
} from "../src/shell/contract";
import {
  type GuideExplanation,
  pageGuideIn,
  parseGuides,
  principleIds,
  principleIn,
  shellMarks,
} from "../src/shell/guide-content";
import { guideTextFindings } from "./fixtures/guide-text";

// The Launchpad as the first host of the shell's guide (decision F56, plan
// DEV-6612 PR 4): Soubory has the "?" right after its heading, the first
// page to have one. It plays the shell's principle "files", and in a Team
// Environment the Launchpad's own explanation that the Team shares the
// folder, chosen by the Environment's kind alone (#499). Every mark a step
// points at is on the served page or one of the shell's own, and the
// sentences the "?" replaced are gone from the page in the same change, so
// the explanation is never missing. How it looks, moves and takes the focus
// is checked in a browser (root decision 0178).

type Element = Readonly<{
  tag: string;
  attributes: ReadonlyMap<string, string>;
  parent: Element | null;
}>;

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

/** Every element of the page in document order, each with its parent. */
async function parse(source: string): Promise<Element[]> {
  const elements: Element[] = [];
  const open: Element[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: Element = {
          tag: element.tagName,
          attributes: new Map(element.attributes),
          parent: open.at(-1) ?? null,
        };
        elements.push(node);
        if (element.canHaveContent && !element.selfClosing) {
          open.push(node);
          element.onEndTag(() => {
            open.pop();
          });
        }
      },
    })
    .transform(new Response(source))
    .text();
  return elements;
}

const elements = await parse(page);
const byId = (id: string) => {
  const found = elements.filter((node) => node.attributes.get("id") === id);
  expect(found).toHaveLength(1);
  return found[0] as Element;
};
const marks = new Set(
  elements.flatMap((node) => {
    const mark = node.attributes.get("data-guide");
    return mark === undefined ? [] : [mark];
  }),
);

const files: PageRoute = { view: "files", path: [] };
const kinds: readonly (ShellEnvironmentKind | null)[] = [
  null,
  ...shellEnvironmentKinds,
];

test('one "?" on the page, right after the heading of Soubory, and the shell\'s element it plays in', () => {
  const help = elements.filter((node) =>
    node.attributes.has("data-guide-help"),
  );
  expect(help).toHaveLength(1);
  const button = help[0] as Element;
  expect(button.tag).toBe("button");
  expect(button.attributes.get("type")).toBe("button");
  expect(button.attributes.get("id")).toBe("page-help");
  // Soubory only, in this release: every other page gets its "?" later.
  expect(button.attributes.get("data-view")).toBe("files");
  expect(button.attributes.get("data-guide-help")).toBe("files");
  // Right after the heading, in the breadcrumb's item of the page.
  const heading = byId("page-heading");
  expect(button.parent).toBe(heading.parent);
  const siblings = elements.filter((node) => node.parent === heading.parent);
  expect(siblings.indexOf(button)).toBe(siblings.indexOf(heading) + 1);
  const buddy = elements.filter((node) => node.tag === "lazurio-buddy");
  expect(buddy).toHaveLength(1);
  // Outside every view, so it is there on every route.
  for (let node = buddy[0]?.parent ?? null; node !== null; node = node.parent)
    expect(node.attributes.has("data-view")).toBe(false);
});

/** What a "?" plays: the shell's principle, or one the Launchpad hands
 * over. */
function played(
  id: string,
  guides: readonly GuideExplanation[],
  locale: "cs" | "en",
  kind: ShellEnvironmentKind | null,
): GuideExplanation | null {
  const principle = principleIn(id, locale, kind);
  if (principle !== null) return principle;
  const own = guides.find((guide) => guide.id === id);
  return own === undefined ? null : pageGuideIn(own, kind);
}

test("Soubory's '?' plays a known explanation in every kind and language, chosen by the kind alone", () => {
  for (const locale of ["cs", "en"] as const)
    for (const kind of kinds) {
      const copy = messages(locale, kind);
      const guide = pageGuide(files, kind, copy);
      // What the Launchpad hands over is exactly what the shell keeps.
      const handed = parseGuides(guide.guides);
      expect(handed?.length).toBe(guide.guides.length);
      if (guide.help === null || handed === null)
        throw new Error("Soubory has a '?'");
      const explanation = played(guide.help, handed, locale, kind);
      expect({
        locale,
        kind,
        help: guide.help,
        known: explanation !== null,
      }).toEqual({ locale, kind, help: guide.help, known: true });
      expect(guide.help).toBe(kind === "team" ? "files-team" : "files");
    }
  // The principle in a Work Environment, the Team's own in a Team one.
  expect(pageGuide(files, "automated", messages("cs", "automated"))).toEqual(
    pageGuide(files, "work", messages("cs", "work")),
  );
  expect(pageGuide(files, "team", messages("cs", "team")).guides).toEqual([
    {
      id: "files-team",
      title: "Soubory",
      steps: [
        { text: "Soubor přetáhněte do chatu", at: "tab-chat" },
        { text: "Soubory ukazují, s čím agenti pracují", at: "files-list" },
        { text: "Číst a měnit je může celý Team", at: "files-list" },
      ],
    },
  ]);
  expect(principleIds).not.toContain("files-team");
});

test("every mark Soubory's explanations point at is on the served page or the shell's own", () => {
  const known = new Set<string>([...marks, ...shellMarks]);
  for (const locale of ["cs", "en"] as const)
    for (const kind of kinds) {
      const guide = pageGuide(files, kind, messages(locale, kind));
      const handed = parseGuides(guide.guides) ?? [];
      const explanation = played(guide.help ?? "", handed, locale, kind);
      for (const step of explanation?.steps ?? [])
        expect({ kind, at: step.at, known: known.has(step.at ?? "") }).toEqual({
          kind,
          at: step.at,
          known: true,
        });
    }
  // The Launchpad's own marks are on Soubory's elements.
  expect(byId("files-open").attributes.get("data-guide")).toBe("nav-files");
  expect(byId("files-body").attributes.get("data-guide")).toBe("files-list");
});

test("the Launchpad's explanations keep the guide's rules in both languages", () => {
  const found: string[] = [];
  for (const locale of ["cs", "en"] as const)
    for (const kind of kinds) {
      const guide = pageGuide(files, kind, messages(locale, kind));
      for (const own of parseGuides(guide.guides) ?? [])
        found.push(
          ...guideTextFindings(pageGuideIn(own, kind)).map(
            (line) => `${locale}/${kind}: ${line}`,
          ),
        );
    }
  expect(found).toEqual([]);
  const cs = pageGuide(files, "team", messages("cs", "team")).guides[0];
  const en = pageGuide(files, "team", messages("en", "team")).guides[0];
  expect(en?.steps.map((step) => step.at)).toEqual(
    cs?.steps.map((step) => step.at) ?? [],
  );
  expect(messages("en").pageHelp).toBe("How does it work?");
  expect(messages("cs").pageHelp).toBe("Jak to funguje?");
});

test("no other page has a '?' or an explanation yet", () => {
  const others: readonly PageRoute[] = [
    { view: "home" },
    { view: "organization", organization: "example" },
    { view: "vault" },
    { view: "marketplace" },
    { view: "settings", section: "general" },
    { view: "settings", section: "start" },
  ];
  for (const route of others)
    for (const kind of kinds)
      expect(pageGuide(route, kind, messages("cs", kind))).toEqual({
        help: null,
        guides: [],
      });
});

// The sentences the "?" of Soubory took over (the Lazurio prototype's
// REMOVED list for Soubory and the Launchpad's own sentences that said the
// same): the page's introduction, the Team note and the empty folder's
// explanation, in both languages.
const removed = [
  "S čím pracují vaši agenti.",
  "Celý Team může tyto soubory číst a měnit.",
  "Nahrajte podklady pro agenty.",
  "Agenti sem ukládají hotové soubory",
  "celý Team vidí a mění stejnou složku",
  "Agents save finished files here",
  "the whole Team sees and changes the same folder",
  "What your agents work with",
];

test("the sentences the '?' of Soubory replaced are gone from the page and its words", () => {
  const catalog = (["cs", "en"] as const).flatMap((locale) =>
    kinds.flatMap((kind) => Object.values(messages(locale, kind))),
  );
  for (const sentence of removed) {
    expect({ sentence, page: page.includes(sentence) }).toEqual({
      sentence,
      page: false,
    });
    expect({
      sentence,
      words: catalog.some((text) => text.includes(sentence)),
    }).toEqual({ sentence, words: false });
  }
  for (const id of ["files-shared"])
    expect(elements.some((node) => node.attributes.get("id") === id)).toBe(
      false,
    );
  for (const key of ["filesIntro", "filesShared"])
    expect(Object.hasOwn(messages("cs"), key)).toBe(false);
  expect(messages("cs").filesEmptyRoot).toBe("Zatím žádné soubory.");
  expect(messages("en").filesEmptyRoot).toBe("No files yet.");
});
