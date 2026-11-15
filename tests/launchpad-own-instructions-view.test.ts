import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  maxOwnInstructionsBytes,
  ownInstructionsNotice,
} from "../src/folder/own-instructions";
import { messages } from "../src/launchpad/messages";
import { ownInstructionsPanel } from "../src/launchpad/own-instructions-panel";
import {
  type OwnInstructionsView,
  ownInstructionsForm,
  ownInstructionsOutcome,
  parseOwnInstructionsView,
  personTextTooLarge,
  reconcileOwnInstructions,
  suggestionIssues,
  suggestionLink,
  suggestionTitle,
  suggestionTruncated,
  suggestionUrlLimit,
  utf8Bytes,
} from "../src/launchpad/own-instructions-view";
import { voicePanel } from "../src/launchpad/voice-panel";
import { FakeNode } from "./fixtures/fake-dialog-dom";

// Settings → Komunikace agentů → „Vlastní pokyny pro agenty“ as the page
// draws it (own-instructions-view.ts, own-instructions-panel.ts; root
// decision 0233, decision F14's addendum of 2026-11-06): the counter of
// UTF-8 bytes, the notice of a Work Environment before anything is saved, no
// form where an Environment has no own instructions, what a save answered
// and the link „Poslat Lazuriu jako podnět“. The panel runs on the small
// stand-in for the page's DOM; how it looks and wraps is checked in a
// browser, not here.

const cs = messages("cs");
const en = messages("en");
const idle = { busy: false, needsRefresh: false };

const personal: OwnInstructionsView = {
  allowed: true,
  ofOrganization: false,
  text: "",
  bytes: 0,
  maxBytes: maxOwnInstructionsBytes,
};
const work: OwnInstructionsView = { ...personal, ofOrganization: true };
// What the server answers on a Team Environment, an Environment with
// automations and a public one.
const absent: OwnInstructionsView = { ...personal, allowed: false };

test("the counter counts UTF-8 bytes, not characters", () => {
  expect(utf8Bytes("")).toBe(0);
  expect(utf8Bytes("abc")).toBe(3);
  expect(utf8Bytes("ěščřžýáíé")).toBe(18);
  expect(utf8Bytes("🙂")).toBe(4);
  expect("🙂").toHaveLength(2);
  const draft = reconcileOwnInstructions(personal);
  draft.text = "Piš věcně.";
  expect(ownInstructionsForm(draft, idle, "cs", cs)?.count).toBe(
    "13 z 4096 bajtů",
  );
  expect(ownInstructionsForm(draft, idle, "en", en)?.count).toBe(
    "13 of 4096 bytes",
  );
  // 2,048 Czech letters are exactly the bound; one more is over it.
  draft.text = "ě".repeat(2048);
  expect(ownInstructionsForm(draft, idle, "cs", cs)).toMatchObject({
    count: "4096 z 4096 bajtů",
    over: false,
    problem: null,
    save: true,
  });
  draft.text = `${"ě".repeat(2048)}a`;
  expect(ownInstructionsForm(draft, idle, "cs", cs)).toMatchObject({
    count: "4097 z 4096 bajtů",
    over: true,
    problem:
      "Text je delší než 4096 bajtů. Zkraťte ho; písmeno s diakritikou zabere dva bajty.",
    save: false,
    cancel: true,
    remove: true,
  });
});

test("the buttons follow the draft as the voice form's do, and a text that is not plain or only white space cannot be saved", () => {
  const draft = reconcileOwnInstructions({
    ...personal,
    text: "Piš věcně.",
    bytes: 13,
  });
  // Nothing changed: nothing to save or cancel; the saved text can go.
  expect(ownInstructionsForm(draft, idle, "en", en)).toMatchObject({
    save: false,
    cancel: false,
    remove: true,
    problem: null,
  });
  draft.text = "";
  // Removed in the draft: saving it removes the instructions.
  expect(ownInstructionsForm(draft, idle, "en", en)).toMatchObject({
    count: "0 of 4096 bytes",
    save: true,
    cancel: true,
    remove: false,
    problem: null,
  });
  draft.text = "  \n";
  expect(ownInstructionsForm(draft, idle, "en", en)).toMatchObject({
    save: false,
    problem: en.ownBlank,
  });
  draft.text = "Write\u001b[31m plainly";
  expect(ownInstructionsForm(draft, idle, "cs", cs)).toMatchObject({
    save: false,
    problem: cs.ownNotPlain,
  });
  draft.text = "Write plainly.";
  expect(
    ownInstructionsForm(draft, { busy: true, needsRefresh: false }, "en", en),
  ).toMatchObject({ save: false, cancel: false, remove: false });
  expect(
    ownInstructionsForm(draft, { busy: false, needsRefresh: true }, "en", en),
  ).toMatchObject({ save: false, cancel: true, remove: true });
  // A reload keeps a text being written and takes an untouched one.
  expect(
    reconcileOwnInstructions({ ...personal, text: "Elsewhere" }, draft).text,
  ).toBe("Write plainly.");
  expect(
    reconcileOwnInstructions(
      { ...personal, text: "Elsewhere" },
      reconcileOwnInstructions(personal),
    ).text,
  ).toBe("Elsewhere");
});

test("a Work Environment's form says whose the instructions are before anything is saved, in the core's words; a Personal one says nothing; where there are none there is no form", () => {
  for (const [locale, copy] of [
    ["cs", cs],
    ["en", en],
  ] as const) {
    expect(
      ownInstructionsForm(reconcileOwnInstructions(work), idle, locale, copy)
        ?.notice,
    ).toBe(ownInstructionsNotice[locale]);
    expect(
      ownInstructionsForm(
        reconcileOwnInstructions(personal),
        idle,
        locale,
        copy,
      )?.notice,
    ).toBeNull();
    expect(
      ownInstructionsForm(reconcileOwnInstructions(absent), idle, locale, copy),
    ).toBeNull();
    // Whatever preset: a public Work Environment has none either.
    expect(
      ownInstructionsForm(
        reconcileOwnInstructions({ ...work, allowed: false }),
        idle,
        locale,
        copy,
      ),
    ).toBeNull();
  }
  expect(parseOwnInstructionsView(work)).toEqual(work);
  // An answer of a server that knows no own instructions draws no form.
  for (const value of [
    undefined,
    null,
    "text",
    [],
    { ...work, allowed: "yes" },
    { ...work, text: null },
    { ...work, maxBytes: 0 },
  ])
    expect(parseOwnInstructionsView(value)).toBeNull();
});

test("what a save answered is said in one clear sentence in both languages", () => {
  const said = (
    ok: boolean,
    value: unknown,
    copy = cs,
    removed = false,
  ): unknown => ownInstructionsOutcome(ok, value, removed, 4096, copy);
  expect(said(true, { kind: "updated", revision: 2 })).toEqual({
    saved: true,
    notice: "Uloženo. Nové konverzace se budou řídit těmito pokyny.",
    needsRefresh: false,
  });
  expect(said(true, { kind: "unchanged" }, en)).toEqual({
    saved: true,
    notice: "Saved. New conversations will follow these instructions.",
    needsRefresh: false,
  });
  expect(said(true, { kind: "updated", revision: 3 }, cs, true)).toEqual({
    saved: true,
    notice: "Vlastní pokyny jsou odebrané. Nové konverzace je už nedostanou.",
    needsRefresh: false,
  });
  const budget = {
    kind: "blocked",
    reason: "person-text-too-large",
    voiceBytes: 6000,
    instructionsBytes: 3395,
    maxBytes: 8192,
  };
  // A shorter text can be saved at once: no reload.
  expect(said(false, budget)).toEqual({
    saved: false,
    notice:
      "Vlastní tón a vlastní pokyny sdílejí jeden limit 8192 bajtů: tón má 6000 bajtů a oddíl vlastních pokynů 3395. Zkraťte pokyny, nebo vlastní tón a uložte znovu.",
    needsRefresh: false,
  });
  expect(personTextTooLarge(budget, en)).toBe(
    "The custom voice and the own instructions share one limit of 8192 bytes: the voice takes 6000 bytes and the section of own instructions 3395. Shorten the instructions or the custom voice and save again.",
  );
  // Without its sizes it is not that sentence.
  expect(
    personTextTooLarge({ reason: "person-text-too-large" }, en),
  ).toBeNull();
  expect(personTextTooLarge({ reason: "stale-revision" }, en)).toBeNull();
  expect(
    said(false, { kind: "blocked", reason: "voice-context-too-large" }),
  ).toEqual({
    saved: false,
    notice: cs.ownContextLarge,
    needsRefresh: false,
  });
  expect(
    said(false, { kind: "blocked", reason: "own-instructions-unavailable" }),
  ).toEqual({ saved: false, notice: cs.ownUnavailable, needsRefresh: true });
  expect(cs.ownUnavailable).toStartWith(
    "Toto Prostředí vlastní pokyny nemá. Má je váš počítač, Osobní Prostředí",
  );
  expect(messages("cs", "team").ownUnavailable).toStartWith(
    "Toto Týmové Prostředí vlastní pokyny nemá",
  );
  expect(said(false, { kind: "blocked", reason: "stale-revision" })).toEqual({
    saved: false,
    notice: cs.voiceStale,
    needsRefresh: true,
  });
  for (const [problem, notice] of [
    ["too-long", "The text is longer than 4096 bytes."],
    ["not-plain-text", "Own instructions are plain text."],
    ["blank", "The text is only white space."],
  ] as const) {
    const outcome = ownInstructionsOutcome(
      false,
      { error: "invalid-own-instructions", problem, maxBytes: 4096 },
      false,
      4096,
      en,
    );
    expect(outcome.saved).toBe(false);
    expect(outcome.needsRefresh).toBe(false);
    expect(outcome.notice).toStartWith(notice);
  }
  // Anything else is the form's general failure, with a reload.
  for (const value of [
    { error: "operation-failed" },
    { kind: "blocked", reason: "drift" },
    null,
    "no",
  ])
    expect(said(false, value)).toEqual({
      saved: false,
      notice: cs.voiceFailed,
      needsRefresh: true,
    });
  // A success that is not one is not said as saved.
  expect(said(false, { kind: "updated" })).toMatchObject({ saved: false });
});

const bodyOf = (href: string) => new URL(href).searchParams.get("body") ?? "";

test("„Poslat Lazuriu jako podnět“ is a link to GitHub's new issue of this repository with the saved text, encoded whole", () => {
  const text =
    "Odpovídej stručně & věcně.\n#1: 100 % jistoty? Ne + nikdy.\n```sh\nlazurio update\n```\n🙂 „česky“";
  const link = suggestionLink(text);
  expect(link.truncated).toBe(false);
  expect(link.href).toStartWith(
    "https://github.com/Lazurio/LazurioPlatform/issues/new?title=Own%20instructions%20as%20a%20product%20suggestion&body=",
  );
  // Nothing of the text is left outside the two parameters: no raw space,
  // line end, "&", "#" or "+" that an address would read as its own.
  const query = link.href.slice(suggestionIssues.length + 1);
  expect(query).toMatch(/^title=[^&#+\s]*&body=[^&#+\s]*$/u);
  const url = new URL(link.href);
  expect(`${url.origin}${url.pathname}`).toBe(suggestionIssues);
  expect([...url.searchParams.keys()]).toEqual(["title", "body"]);
  expect(url.searchParams.get("title")).toBe(suggestionTitle);
  expect(url.hash).toBe("");
  // One sentence that the person chose to share it, then the text in a
  // fence it cannot close, as the Folder builds it: the text has a run of
  // three backticks, so the fence is of tildes.
  expect(bodyOf(link.href)).toBe(
    `I chose to share the own instructions for agents that I saved in Lazurio's Settings as a product suggestion.\n\n~~~text\n${text}\n~~~`,
  );
  expect(bodyOf(suggestionLink("~~~\n```").href)).toEndWith(
    "\n\n````text\n~~~\n```\n````",
  );
  expect(bodyOf(suggestionLink("Be brief.").href)).toEndWith(
    "\n\n```text\nBe brief.\n```",
  );
});

test("a text too long for an address is cut at a whole character with a visible marker, and the link stays under the cap", () => {
  // The worst real texts: the longest Czech one, the longest of emoji, the
  // longest of characters an address escapes, and the longest plain one.
  for (const text of [
    "ě".repeat(2048),
    "🙂".repeat(1024),
    "% ".repeat(2048),
    "Odpovídej stručně a věcně, vždy česky.\n".repeat(80),
    "`".repeat(4096),
    "x".repeat(4096),
  ]) {
    expect(utf8Bytes(text)).toBeLessThanOrEqual(maxOwnInstructionsBytes);
    const link = suggestionLink(text);
    expect(link.href.length).toBeLessThanOrEqual(suggestionUrlLimit);
    const body = bodyOf(link.href);
    if (!link.truncated) {
      expect(body).toContain(text);
      expect(body).not.toContain(suggestionTruncated);
      continue;
    }
    expect(body).toEndWith(`\n\n${suggestionTruncated}`);
    // What the issue holds is the beginning of the text, whole characters
    // only, inside its fence.
    const match = /\n\n(`{3,}|~{3,})text\n([\s\S]*)\n\1\n\n\[… truncated/u.exec(
      body,
    );
    expect(match).not.toBeNull();
    const kept = match?.[2] ?? "";
    expect(kept.length).toBeGreaterThan(0);
    expect(text.startsWith(kept)).toBe(true);
    // No half of a pair of surrogates: an address refuses to encode one.
    expect(() => encodeURIComponent(kept)).not.toThrow();
    expect(kept).not.toMatch(/[\ud800-\udbff]$/u);
    // As much as fits: one character more would be over the cap.
    const more = Array.from(text)
      .slice(0, Array.from(kept).length + 1)
      .join("");
    expect(
      `${suggestionIssues}?title=${encodeURIComponent(suggestionTitle)}&body=${encodeURIComponent(body.replace(kept, more))}`
        .length,
    ).toBeGreaterThan(suggestionUrlLimit);
  }
  expect(suggestionLink("x".repeat(4096)).truncated).toBe(false);
  expect(suggestionLink("ě".repeat(2048)).truncated).toBe(true);
});

test("the page itself carries nothing of the form: it is drawn only where the Environment has own instructions", async () => {
  const page = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  const ids: string[] = [];
  const messagesNamed: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const id = element.getAttribute("id");
        if (id !== null) ids.push(id);
        const message = element.getAttribute("data-message");
        if (message !== null) messagesNamed.push(message);
      },
    })
    .transform(new Response(page))
    .text();
  expect(ids).toContain("voice-form");
  expect(ids).toContain("section-communication");
  expect(ids.filter((id) => id.startsWith("own-"))).toEqual([]);
  expect(messagesNamed.filter((name) => name.startsWith("own"))).toEqual([]);
  for (const words of [en.ownTitle, cs.ownTitle, en.ownSuggest, cs.ownSuggest])
    expect(page).not.toContain(words);
});

// --- The panel on the stand-in for the page's DOM ------------------------

const hadDocument = "document" in globalThis;
const original = globalThis.document;
afterEach(() => {
  if (hadDocument) globalThis.document = original;
  else Reflect.deleteProperty(globalThis, "document");
});

/** The stand-in's element with what the panel also uses: where it stands,
 * so that it can leave the page. */
class PageNode extends FakeNode {
  parent: PageNode | null = null;
  id = "";
  hidden = false;
  override append(...nodes: (FakeNode | string)[]) {
    super.append(...nodes);
    for (const node of nodes) if (node instanceof PageNode) node.parent = this;
  }
  remove() {
    const siblings = this.parent?.children;
    if (siblings?.includes(this)) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
}

const settled = () => Bun.sleep(1);

type Posted = { path: string; body: unknown };

/** The communication section with the panel in it, its saves answered by
 * the test. */
function page(copy = cs) {
  const host = new PageNode("section");
  globalThis.document = {
    createElement: (tag: string) => new PageNode(tag),
    createElementNS: (_space: string, tag: string) => new PageNode(tag),
  } as unknown as Document;
  const posted: Posted[] = [];
  let answer: { ok: boolean; value: unknown } = {
    ok: true,
    value: { kind: "updated", revision: 2 },
  };
  let profile: {
    revision: number;
    profile: Record<string, string>;
    ownInstructions?: unknown;
  } = { revision: 1, profile: { locale: copy === cs ? "cs" : "en" } };
  const panel = ownInstructionsPanel({
    host: () => host as unknown as HTMLElement,
    copy: () => copy,
    post: async (path, body) => {
      posted.push({ path, body });
      return answer;
    },
    // The page reads the profile again, as ui.ts does.
    changed: async () => {
      panel.load(profile);
    },
  });
  const all = () => [...host.walk()] as PageNode[];
  const byId = (id: string) => {
    const found = all().filter((node) => node.id === id);
    expect(found).toHaveLength(1);
    return found[0] as PageNode;
  };
  const buttons = () => all().filter((node) => node.tagName === "button");
  const button = (label: string) => {
    const found = buttons().filter((node) => node.textContent === label);
    expect(found).toHaveLength(1);
    return found[0] as PageNode;
  };
  return {
    host,
    posted,
    all,
    byId,
    button,
    /** Everything the section says that is shown. */
    says() {
      const shown = (node: PageNode): string[] =>
        node.hidden
          ? []
          : [
              ...(node.textContent ? [node.textContent] : []),
              ...(node.children as PageNode[]).flatMap(shown),
            ];
      return shown(host);
    },
    link: () => all().find((node) => node.tagName === "a") as PageNode,
    /** The profile as it is read from now on, and read once. */
    load(view: unknown, revision = profile.revision) {
      profile = { ...profile, revision, ownInstructions: view };
      panel.load(profile);
    },
    /** What the server records after the next save. */
    records(view: unknown, revision: number) {
      profile = { ...profile, revision, ownInstructions: view };
    },
    answers(ok: boolean, value: unknown) {
      answer = { ok, value };
    },
    type(value: string) {
      const text = byId("own-text");
      text.value = value;
      text.dispatch("input");
    },
    async submit() {
      byId("own-form").dispatch("submit");
      await settled();
    },
  };
}

test("on a Work Environment the notice stands in the form, above the buttons, before anything is saved; on a Personal one it does not", () => {
  const at = page();
  at.load(work);
  // Nothing was sent to draw it.
  expect(at.posted).toEqual([]);
  const notice = at.byId("own-notice");
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toBe(ownInstructionsNotice.cs);
  expect(notice.className).toBe("callout");
  // Inside the form's fields, after the text and before the buttons.
  const fields = at.byId("own-form").children[0] as PageNode;
  expect(fields.tagName).toBe("fieldset");
  const order = fields.children.map((node) =>
    node === notice ? "notice" : node.className || node.tagName,
  );
  expect(order).toEqual([
    "legend",
    "card voice-card",
    "notice",
    "voice-actions",
  ]);
  // Read with the field by a screen reader.
  const text = at.byId("own-text");
  expect(text.attributes.get("aria-describedby")).toBe(
    "own-hint own-notice own-count own-error",
  );
  expect(at.says()).toContain(cs.ownHint);
  expect(at.says()).toContain("0 z 4096 bajtů");
  expect(cs.ownHint).toBe(
    "Řekněte agentům, jak s vámi mají pracovat: jak odpovídat, na co se ptát, co dělat vždy. Nic tím neudělujete; při střetu platí pravidla Lazuria a Organizace.",
  );
  // The same in English, from the core.
  const english = page(en);
  english.load(work);
  expect(english.byId("own-notice").textContent).toBe(ownInstructionsNotice.en);

  const own = page();
  own.load(personal);
  expect(own.byId("own-notice").hidden).toBe(true);
  expect(own.says()).not.toContain(ownInstructionsNotice.cs);
  expect(own.byId("own-text").attributes.get("aria-describedby")).toBe(
    "own-hint own-count own-error",
  );
  // The field has its label and its error is a live region from the start.
  const label = own.all().find((node) => node.tagName === "label") as PageNode;
  expect((label as unknown as { htmlFor: string }).htmlFor).toBe("own-text");
  expect(label.textContent).toBe("Vlastní pokyny pro agenty");
  expect(own.byId("own-error").attributes.get("aria-live")).toBe("polite");
  expect(own.byId("own-error").textContent).toBe("");
});

test("where the Environment has no own instructions nothing of the form is in the page, and a form leaves it when the Environment stops having them", () => {
  for (const view of [absent, { ...work, allowed: false }, undefined, null]) {
    const at = page();
    at.load(view);
    expect(at.host.children).toEqual([]);
  }
  const at = page();
  at.load(work);
  expect(at.host.children).toHaveLength(1);
  at.type("Rozepsaný text");
  // The preset changed to a Team Environment's elsewhere.
  at.load(absent, 2);
  expect(at.host.children).toEqual([]);
  // Back again: an empty form, not the text written before.
  at.load(work, 3);
  expect(at.host.children).toHaveLength(1);
  expect(at.byId("own-text").value).toBe("");
});

test("typing counts bytes; over the bound the counter is an error, Save is off and nothing is sent", async () => {
  const at = page();
  at.load(personal);
  expect(at.button(cs.voiceSave).disabled).toBe(true);
  expect(at.button(cs.voiceCancel).disabled).toBe(true);
  expect(at.button(cs.ownRemove).disabled).toBe(true);
  at.type("Říkej mi Matěji.");
  expect(at.byId("own-count").textContent).toBe("19 z 4096 bajtů");
  expect(Object.hasOwn(at.byId("own-count").dataset, "over")).toBe(false);
  expect(at.button(cs.voiceSave).disabled).toBe(false);
  expect(at.says()).toContain(cs.voiceDirty);
  at.type("ě".repeat(2049));
  expect(at.byId("own-count").textContent).toBe("4098 z 4096 bajtů");
  expect(Object.hasOwn(at.byId("own-count").dataset, "over")).toBe(true);
  expect(at.byId("own-error").textContent).toBe(
    "Text je delší než 4096 bajtů. Zkraťte ho; písmeno s diakritikou zabere dva bajty.",
  );
  expect(at.byId("own-text").attributes.get("aria-invalid")).toBe("true");
  expect(at.button(cs.voiceSave).disabled).toBe(true);
  await at.submit();
  expect(at.posted).toEqual([]);
  // Cancel puts the saved text back.
  at.button(cs.voiceCancel).click();
  expect(at.byId("own-text").value).toBe("");
  expect(at.byId("own-error").textContent).toBe("");
  expect(at.byId("own-text").attributes.has("aria-invalid")).toBe(false);
  expect(Object.hasOwn(at.byId("own-count").dataset, "over")).toBe(false);
});

test("a save sends the text alone at the page's revision, says it is saved and only then offers the suggestion; Remove and a save take the instructions away", async () => {
  const at = page();
  at.load(work);
  // Never offered by itself: not for a text saved earlier either.
  at.load({ ...work, text: "Dříve uložené.", bytes: 18 });
  expect(at.link().hidden || at.link().parent?.hidden).toBe(true);
  expect(at.link().attributes.has("href")).toBe(false);
  const text = "Odpovídej stručně.";
  at.type(text);
  at.records({ ...work, text, bytes: utf8Bytes(text) }, 2);
  await at.submit();
  expect(at.posted).toEqual([
    {
      path: "/api/own-instructions/update",
      body: { expectedRevision: 1, text },
    },
  ]);
  expect(at.says()).toContain(
    "Uloženo. Nové konverzace se budou řídit těmito pokyny.",
  );
  expect(at.button(cs.voiceSave).disabled).toBe(true);
  const link = at.link();
  expect(link.parent?.hidden).toBe(false);
  const anchor = link as unknown as {
    href: string;
    target: string;
    rel: string;
  };
  expect(anchor.href).toBe(suggestionLink(text).href);
  expect(anchor.target).toBe("_blank");
  expect(anchor.rel).toBe("noopener noreferrer");
  expect(at.says()).toContain("Poslat Lazuriu jako podnět");
  // Said before the click: opening the link already hands the text over.
  expect(at.says()).toContain(
    "Odkaz otevře GitHub a uložený text mu předá v adrese hned při otevření. Veřejný bude, až tam issue sami odešlete.",
  );
  // The repository is public and the text is the Organization's.
  expect(at.says()).toContain(
    "Odesíláte text, který patří Organizaci; pošlete jen to, co smí být veřejné.",
  );
  expect(at.says()).not.toContain(cs.ownSuggestTruncated);
  // Writing on takes the offer away: it was for the saved text.
  at.type(`${text} A věcně.`);
  expect(at.link().parent?.hidden).toBe(true);
  expect(at.link().attributes.has("href")).toBe(false);
  at.button(cs.voiceCancel).click();
  expect(at.link().parent?.hidden).toBe(false);
  // Remove empties the draft; saving it sends null, at the new revision.
  at.button(cs.ownRemove).click();
  expect(at.byId("own-text").value).toBe("");
  expect(at.button(cs.ownRemove).disabled).toBe(true);
  at.records(work, 3);
  at.answers(true, { kind: "updated", revision: 3 });
  await at.submit();
  expect(at.posted[1]).toEqual({
    path: "/api/own-instructions/update",
    body: { expectedRevision: 2, text: null },
  });
  expect(at.says()).toContain(cs.ownRemoved);
  expect(at.link().parent?.hidden).toBe(true);

  // On a Personal Environment the offer has no sentence about the
  // Organization; a text too long for the link says that it is cut.
  const own = page(en);
  own.load(personal);
  const long = "ě".repeat(2048);
  own.type(long);
  own.records({ ...personal, text: long, bytes: 4096 }, 2);
  await own.submit();
  expect(own.says()).toContain("Send to Lazurio as a suggestion");
  expect(own.says()).toContain(
    "The link opens GitHub and hands it the saved text in the address as soon as it opens. It becomes public once you submit the issue there yourself.",
  );
  expect(own.says()).not.toContain(en.ownSuggestOrganization);
  expect(own.says()).toContain(en.ownSuggestTruncated);
  expect(
    (own.link() as unknown as { href: string }).href.length,
  ).toBeLessThanOrEqual(suggestionUrlLimit);
});

test("a refused save keeps the text: a stale revision asks for the current settings, a text too large next to the voice says the three sizes", async () => {
  const at = page();
  at.load(personal);
  at.type("Odpovídej stručně.");
  at.answers(false, { kind: "blocked", reason: "stale-revision" });
  await at.submit();
  expect(at.says()).toContain(cs.voiceStale);
  expect(at.byId("own-text").value).toBe("Odpovídej stručně.");
  expect(at.button(cs.voiceSave).disabled).toBe(true);
  const refresh = at.button(cs.voiceRefresh);
  expect(refresh.hidden).toBe(false);
  // Nothing is offered for a text that was not saved.
  expect(at.link().parent?.hidden).toBe(true);
  // The current settings: another text was saved elsewhere, at revision 5.
  at.records({ ...personal, text: "Jinde.", bytes: 6 }, 5);
  refresh.click();
  await settled();
  expect(at.button(cs.voiceRefresh).hidden).toBe(true);
  // The text being written stays; the next save is at the new revision.
  expect(at.byId("own-text").value).toBe("Odpovídej stručně.");
  at.answers(false, {
    kind: "blocked",
    reason: "person-text-too-large",
    voiceBytes: 8000,
    instructionsBytes: 420,
    maxBytes: 8192,
  });
  await at.submit();
  expect(at.posted.at(-1)).toEqual({
    path: "/api/own-instructions/update",
    body: { expectedRevision: 5, text: "Odpovídej stručně." },
  });
  expect(at.says()).toContain(
    "Vlastní tón a vlastní pokyny sdílejí jeden limit 8192 bajtů: tón má 8000 bajtů a oddíl vlastních pokynů 420. Zkraťte pokyny, nebo vlastní tón a uložte znovu.",
  );
  // A shorter text can be saved at once.
  expect(at.button(cs.voiceRefresh).hidden).toBe(true);
  at.type("Stručně.");
  expect(at.button(cs.voiceSave).disabled).toBe(false);
  expect(at.says()).not.toContain(cs.voiceStale);
});

test("the voice form says the shared budget too, where it showed its general failure", async () => {
  const nodes = new Map<string, PageNode>();
  globalThis.document = {
    getElementById(id: string) {
      const known = nodes.get(id) ?? new PageNode("div");
      nodes.set(id, known);
      return known;
    },
  } as unknown as Document;
  const node = (id: string) => nodes.get(id) as PageNode;
  let answer: { ok: boolean; value: unknown } = { ok: true, value: {} };
  const posted: Posted[] = [];
  const panel = voicePanel({
    copy: () => en,
    post: async (path, body) => {
      posted.push({ path, body });
      return answer;
    },
    changed: async () => {},
  });
  panel.load({
    revision: 4,
    profile: { locale: "en" },
    preset: { name: "local" },
    voice: {
      locale: "en",
      mode: "default",
      text: "Default",
      defaultText: "Default",
      maxBytes: 8192,
    },
  });
  const type = (value: string) => {
    node("voice-text").value = value;
    node("voice-text").dispatch("input");
  };
  const submit = async () => {
    node("voice-form").dispatch("submit");
    await settled();
  };
  type("A long voice");
  answer = {
    ok: false,
    value: {
      kind: "blocked",
      reason: "person-text-too-large",
      voiceBytes: 8000,
      instructionsBytes: 420,
      maxBytes: 8192,
    },
  };
  await submit();
  expect(posted).toHaveLength(1);
  expect(node("voice-status").textContent).toBe(
    "The custom voice and the own instructions share one limit of 8192 bytes: the voice takes 8000 bytes and the section of own instructions 420. Shorten the instructions or the custom voice and save again.",
  );
  // The revision is still the Folder's: a shorter voice saves at once.
  expect(node("voice-refresh").hidden).toBe(true);
  type("A voice");
  expect(node("voice-save").disabled).toBe(false);
  expect(node("voice-status").textContent).toBe(en.voiceDirty);
  // Every other refusal is what it was.
  answer = { ok: false, value: { kind: "blocked", reason: "stale-revision" } };
  await submit();
  expect(node("voice-status").textContent).toBe(en.voiceStale);
  expect(node("voice-refresh").hidden).toBe(false);
  expect(node("voice-save").disabled).toBe(true);
});
