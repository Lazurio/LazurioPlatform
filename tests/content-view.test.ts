import { expect, test } from "bun:test";
import {
  type ContentJob,
  type ContentList,
  parseContentJob,
  parseContentList,
} from "../src/launchpad/content-client";
import {
  contentCommand,
  contentFact,
  contentSteps,
  contentView,
  prepareContext,
  preparePrompt,
} from "../src/launchpad/content-view";
import { messages } from "../src/launchpad/messages";

// "Obsah Environmentu" (root decision 0188): the steps of the preparation in
// the wireframe's plain words, one sentence and the folded detail when it
// stops, and the prompt "Vyřešit v Chatu" hands to Chat.

const cs = messages("cs");
const en = messages("en");

const list = (value: unknown): ContentList => {
  const read = parseContentList(value);
  if (read === null) throw new Error("fixture");
  return read;
};
const job = (value: unknown): ContentJob => {
  const read = parseContentJob(value);
  if (read === null) throw new Error("fixture");
  return read;
};

const work = list({
  allowed: true,
  items: [
    {
      kind: "organization",
      login: "example",
      name: "Example",
      state: "absent",
    },
  ],
});
const personal = list({
  allowed: true,
  items: [
    {
      kind: "personalspace",
      login: "octocat",
      state: "absent",
      onGitHub: "exists",
    },
  ],
});
const org = { kind: "organization", login: "example" };
const running = job({
  id: "job-1",
  state: "running",
  steps: [
    { item: org, key: "access", state: "done" },
    { item: org, key: "root", state: "done" },
    { item: org, key: "modules", state: "running" },
  ],
});
const stopped = job({
  id: "job-1",
  state: "failed",
  steps: [
    { item: org, key: "access", state: "done" },
    { item: org, key: "root", state: "done" },
    { item: org, key: "modules", state: "done" },
    { item: org, key: "preparation", state: "failed" },
  ],
  failure: {
    item: org,
    key: "preparation",
    code: "preparation-failed",
    detail: "bun install in deals failed",
  },
});

test("an Organization's steps in plain words, done, running and next", () => {
  expect(
    contentSteps(work.items[0] as never, running, cs).map((step) => [
      step.label,
      step.mark,
    ]),
  ).toEqual([
    ["Ověřuji přístup", "done"],
    ["Stahuji Organizaci", "done"],
    ["Stahuji moduly", "running"],
    ["Instaluji", "next"],
    ["Kontroluji", "next"],
  ]);
  expect(
    contentSteps(work.items[0] as never, stopped, en).map((step) => step.mark),
  ).toEqual(["done", "done", "done", "failed", "next"]);
});

test("the Personalspace: “Zakládám” only where it is created", () => {
  const item = personal.items[0] as never;
  const labels = (value: ContentJob | null, entry = item) =>
    contentSteps(entry, value, cs).map((step) => step.label);
  // It exists on GitHub: found and downloaded, never created.
  expect(labels(null)).toEqual([
    "Hledám tvůj osobní prostor",
    "Stahuji",
    "Kontroluji",
  ]);
  const missing = list({
    allowed: true,
    items: [
      {
        kind: "personalspace",
        login: "octocat",
        state: "absent",
        onGitHub: "missing",
      },
    ],
  }).items[0] as never;
  expect(labels(null, missing)).toEqual([
    "Hledám tvůj osobní prostor",
    "Zakládám",
    "Stahuji",
    "Kontroluji",
  ]);
  // The job decides: a skipped step is left out, a created one shown.
  const ps = { kind: "personalspace" };
  expect(
    labels(
      job({
        id: "j",
        state: "running",
        steps: [
          { item: ps, key: "find", state: "done" },
          { item: ps, key: "create", state: "skipped" },
          { item: ps, key: "clone", state: "running" },
        ],
      }),
      missing,
    ),
  ).toEqual(["Hledám tvůj osobní prostor", "Stahuji", "Kontroluji"]);
  expect(
    labels(
      job({
        id: "j",
        state: "running",
        steps: [
          { item: ps, key: "find", state: "done" },
          { item: ps, key: "create", state: "running" },
        ],
      }),
    ),
  ).toEqual([
    "Hledám tvůj osobní prostor",
    "Zakládám",
    "Stahuji",
    "Kontroluji",
  ]);
  // A key this page does not know follows in plain words.
  expect(
    labels(
      job({
        id: "j",
        state: "running",
        steps: [{ item: ps, key: "verify-keys", state: "running" }],
      }),
    ).at(-1),
  ).toBe("Připravuji");
});

test("where the content stands: missing, failed while still not here, ready", () => {
  expect(contentFact("loading", null)).toEqual({ state: "loading" });
  // Unreadable is not "nothing to prepare".
  expect(contentFact(null, null)).toEqual({ state: "unknown" });
  expect(contentFact(list({ allowed: false, items: [] }), null)).toEqual({
    state: "none",
  });
  expect(contentFact(work, null)).toEqual({
    state: "missing",
    item: work.items[0] as never,
  });
  expect(contentFact(work, running).state).toBe("missing");
  expect(contentFact(work, stopped)).toMatchObject({
    state: "failed",
    item: work.items[0],
  });
  const here = list({
    allowed: true,
    items: [{ kind: "organization", login: "example", state: "present" }],
  });
  // The stop is over once the content is here.
  expect(contentFact(here, stopped)).toEqual({ state: "ready" });
});

test("the view: one action, the steps while it runs, the stop in one sentence", () => {
  const idle = contentView(work, null, cs, { github: "connected" });
  expect(idle.action).toEqual({ label: "Stáhnout", disabled: false });
  expect(idle.rows[0]).toMatchObject({
    name: "Example",
    status: "Ještě tu není",
    steps: null,
    failure: null,
  });
  expect(
    contentView(personal, null, cs, { github: "connected" }).action,
  ).toEqual({ label: "Připravit", disabled: false });
  // Without GitHub the action waits and says why.
  const noGithub = contentView(work, null, cs, { github: "missing" });
  expect(noGithub.action?.disabled).toBe(true);
  expect(noGithub.note).toBe("Nejdřív připoj GitHub v Nástrojích.");
  // Running: no action, the steps, the status.
  const busy = contentView(work, running, cs, { github: "connected" });
  expect(busy.action).toBeNull();
  expect(busy.rows[0]?.status).toBe("Stahuji…");
  expect(busy.rows[0]?.steps?.length).toBe(5);
  // Stopped: try again, the sentence, the command and the detail folded.
  const failed = contentView(work, stopped, cs, { github: "connected" });
  expect(failed.action?.label).toBe("Zkusit znovu");
  expect(failed.resolve).toBe(true);
  expect(failed.rows[0]?.status).toBe("Zastavilo se");
  expect(failed.rows[0]?.failure).toEqual({
    sentence: "Moduly se nepodařilo nainstalovat. Agent v Chatu to opraví.",
    details:
      "lazurio organization install example\nbun install in deals failed\n(preparation-failed)",
  });
  // Several missing: "Stáhnout vše"; present ones say so, with modules.
  const both = list({
    allowed: true,
    items: [
      {
        kind: "organization",
        login: "example",
        name: "Example",
        state: "present",
      },
      { kind: "organization", login: "other", state: "absent" },
      {
        kind: "personalspace",
        login: null,
        state: "blocked",
        reason: "no-access",
      },
    ],
  });
  const view = contentView(both, null, cs, {
    github: "connected",
    modules: (login) => (login === "example" ? 5 : null),
    pluralModules: (count) => `${count} modulů`,
  });
  expect(view.action?.label).toBe("Stáhnout vše");
  expect(view.rows.map((row) => row.status)).toEqual([
    "Připraveno · 5 modulů",
    "Ještě tu není",
    "Teď to připravit nejde",
  ]);
  expect(view.rows[2]?.reason).toBe("no-access");
  // All here: nothing to do.
  expect(
    contentView(
      list({
        allowed: true,
        items: [{ kind: "personalspace", login: null, state: "present" }],
      }),
      null,
      cs,
      { github: "connected" },
    ).action,
  ).toBeNull();
});

test("the prompt: the wireframe's brief, the step that stopped and its detail", () => {
  const context = prepareContext(work, stopped, cs);
  expect(context).toEqual({
    target: { kind: "organization", name: "Example", login: "example" },
    failure: { step: "Instaluji", detail: "bun install in deals failed" },
    login: "example",
  });
  if (context === null) throw new Error("context");
  expect(preparePrompt(context.target, context.failure, cs)).toBe(
    [
      "Příprava Organizace Example (GitHub example) v tomhle Environmentu se zastavila u kroku „Instaluji“:",
      "bun install in deals failed",
      "",
      "Dotáhni prosím instalaci se vším všudy:",
      "1. Zjisti příčinu chyby a oprav ji v tomhle Environmentu.",
      "2. Dokonči přípravu stejným příkazem, jaký spouští Launchpad: `lazurio organization install example`.",
      "3. Ověř výsledek: `lazurio doctor`, a u modulů, které mají testy, jejich testy.",
      "4. Řekni mi stručně, co bylo špatně, co jsi udělal a co jsi ověřil. Kdyby oprava potřebovala změnu mimo tenhle Environment (třeba v repozitáři), nejdřív se zeptej.",
    ].join("\n"),
  );
  const english = preparePrompt({ kind: "personalspace" }, null, en);
  expect(english.split("\n")[0]).toBe(
    "The preparation of my personal space (Personalspace) in this Environment stopped.",
  );
  expect(english).toContain("`lazurio personalspace install`");
  expect(english).toContain("`lazurio doctor`");
  expect(english).toContain("ask me first");
  // The Personalspace names the person's login for the link.
  const ps = { kind: "personalspace" };
  expect(
    prepareContext(
      personal,
      job({
        id: "j",
        state: "failed",
        steps: [],
        failure: { item: ps, key: "clone", code: "x", detail: "denied" },
      }),
      cs,
    ),
  ).toEqual({
    target: { kind: "personalspace" },
    failure: { step: "Stahuji", detail: "denied" },
    login: "octocat",
  });
  // Nothing stopped: nothing to resolve.
  expect(prepareContext(work, running, cs)).toBeNull();
  expect(prepareContext(work, null, cs)).toBeNull();
  expect(contentCommand({ kind: "personalspace", login: null })).toBe(
    "lazurio personalspace install",
  );
});
