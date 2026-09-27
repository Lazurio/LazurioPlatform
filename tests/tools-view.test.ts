import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  curatedActionLabel,
  currentNotes,
  nextNotes,
  nextSelection,
  noteDraftView,
  parseToolsOverview,
  signInLine,
  sourceLink,
  takesNote,
  toolChangeOutcome,
  toolGroups,
  toolStatusView,
} from "../src/launchpad/tools-view";
import type { ToolOverview, ToolsOverview } from "../src/tools/overview";

const tool = (overrides: Partial<ToolOverview> = {}): ToolOverview => ({
  name: "composio",
  command: "composio",
  tier: "recommended",
  setup: "launchpad",
  enabled: false,
  purpose: "Purpose.",
  usage: "Usage.",
  source: "https://docs.composio.dev/docs/cli",
  installed: false,
  prompt: "Task: install.",
  ...overrides,
});
const overview = (tools: readonly ToolOverview[]): ToolsOverview => ({
  kind: "tools-status",
  revision: 4,
  locale: "en",
  sharedEnvironment: false,
  hosted: true,
  mcpPrompt: "Task: connect.",
  tools,
});
const catalog = [
  tool({ name: "gh", command: "gh", tier: "required", enabled: true }),
  tool(),
  tool({ name: "wacli", command: "wacli", tier: "optional" }),
  tool({ name: "gogcli", command: "gog", tier: "optional", setup: "agent" }),
  tool({ name: "neon", command: "neon", tier: "optional", setup: "agent" }),
];

test("the page accepts the server's answer only in its exact form", () => {
  const valid = overview(catalog);
  expect(parseToolsOverview(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  // The sign-in and the operator's note travel when the server sends them.
  const signed = overview([
    tool({
      installed: true,
      signIn: {
        state: "signed-in",
        account: "a@example.com",
        organization: "Org",
      },
      note: "Use it for mail.",
    }),
    tool({ name: "wacli", signIn: { state: "unknown" } }),
  ]);
  expect(parseToolsOverview(JSON.parse(JSON.stringify(signed)))).toEqual(
    signed,
  );
  // Unknown fields, a raw tool output among them, are not carried along.
  expect(
    parseToolsOverview({
      ...valid,
      extra: true,
      tools: [{ ...tool(), versionOutput: "raw", token: "x" }],
    }),
  ).toEqual(overview([tool()]));
  for (const broken of [
    null,
    [],
    "tools-status",
    { error: "operation-failed" },
    { ...valid, kind: "tools-list" },
    { ...valid, revision: 0 },
    { ...valid, revision: "4" },
    { ...valid, locale: "de" },
    { ...valid, sharedEnvironment: "no" },
    { ...valid, hosted: undefined },
    { ...valid, hosted: "yes" },
    { ...valid, tools: [{ ...tool(), note: 7 }] },
    { ...valid, tools: [{ ...tool(), signIn: "signed-in" }] },
    { ...valid, tools: [{ ...tool(), signIn: { state: "maybe" } }] },
    {
      ...valid,
      tools: [{ ...tool(), signIn: { state: "signed-in", account: 1 } }],
    },
    { ...valid, mcpPrompt: undefined },
    { ...valid, tools: "gh" },
    { ...valid, tools: [tool(), tool()] },
    { ...valid, tools: [{ ...tool(), name: "<b>x</b>" }] },
    { ...valid, tools: [{ ...tool(), tier: "mandatory" }] },
    { ...valid, tools: [{ ...tool(), setup: "manual" }] },
    { ...valid, tools: [{ ...tool(), enabled: "yes" }] },
    { ...valid, tools: [{ ...tool(), installed: 1 }] },
    { ...valid, tools: [{ ...tool(), path: 7 }] },
    { ...valid, tools: [{ ...tool(), standardPath: "no" }] },
    { ...valid, tools: [{ ...tool(), prompt: undefined }] },
  ])
    expect(parseToolsOverview(broken)).toBeNull();
});

test("three groups in the order Required, Recommended, Optional, in both languages", () => {
  for (const [locale, titles] of [
    ["en", ["Required", "Recommended", "Optional"]],
    ["cs", ["Povinné", "Doporučené", "Volitelné"]],
  ] as const) {
    const copy = messages(locale);
    const groups = toolGroups([...catalog].reverse(), copy);
    expect(groups.map((group) => group.title)).toEqual([...titles]);
    expect(
      groups.map((group) => group.tools.map((entry) => entry.name)),
    ).toEqual([["gh"], ["composio"], ["neon", "gogcli", "wacli"]]);
    for (const group of groups) expect(group.note.length).toBeGreaterThan(0);
  }
  // A tier without a tool has no heading.
  expect(
    toolGroups([tool()], messages("en")).map((group) => group.tier),
  ).toEqual(["recommended"]);
  expect(toolGroups([], messages("en"))).toEqual([]);
});

test("one status line per tool: version and path, or not installed, and what to look at", () => {
  const en = messages("en");
  const cs = messages("cs");
  expect(toolStatusView(tool(), en, true)).toEqual({
    state: "missing",
    headline: "Not installed",
    path: null,
    notes: [],
  });
  expect(toolStatusView(tool(), cs, true).headline).toBe("Není nainstalováno");
  expect(
    toolStatusView(
      tool({
        installed: true,
        version: "0.7.1",
        path: "/home/o/.local/bin/composio",
        realPath: "/home/o/.local/bin/composio",
        standardPath: true,
      }),
      en,
      true,
    ),
  ).toEqual({
    state: "ready",
    headline: "Installed, version 0.7.1",
    path: "/home/o/.local/bin/composio",
    notes: [],
  });
  // A link is shown with where it leads; a PATH entry elsewhere is a note.
  const elsewhere = tool({
    installed: true,
    version: "0.7.1",
    path: "/opt/bin/composio",
    realPath: "/opt/composio/0.7.1/composio",
    standardPath: false,
  });
  expect(toolStatusView(elsewhere, en, true)).toEqual({
    state: "attention",
    headline: "Installed, version 0.7.1",
    path: "/opt/bin/composio → /opt/composio/0.7.1/composio",
    notes: [en.toolsOutsideStandard],
  });
  expect(toolStatusView(elsewhere, cs, true).notes).toEqual([
    cs.toolsOutsideStandard,
  ]);
  // On a local workstation any tool on PATH is fine: no note, normal state.
  expect(toolStatusView(elsewhere, en, false)).toEqual({
    state: "ready",
    headline: "Installed, version 0.7.1",
    path: "/opt/bin/composio → /opt/composio/0.7.1/composio",
    notes: [],
  });
  expect(en.toolsOutsideStandard).toContain("~/.local/bin");
  expect(
    toolStatusView(
      tool({
        installed: true,
        path: "/home/o/.local/bin/composio",
        standardPath: true,
        versionError: "exit 7",
      }),
      en,
      false,
    ),
  ).toEqual({
    state: "attention",
    headline: "Installed, version unknown",
    path: "/home/o/.local/bin/composio",
    notes: ["The version check failed: exit 7."],
  });
});

test("a request carries the full next selection, sorted, without required tools", () => {
  const enabled = catalog.map((entry) =>
    ["wacli", "neon"].includes(entry.name)
      ? { ...entry, enabled: true }
      : entry,
  );
  expect(nextSelection(catalog, "composio", true)).toEqual(["composio"]);
  expect(nextSelection(enabled, "composio", true)).toEqual([
    "composio",
    "neon",
    "wacli",
  ]);
  expect(nextSelection(enabled, "wacli", false)).toEqual(["neon"]);
  expect(nextSelection(enabled, "neon", true)).toEqual(["neon", "wacli"]);
  expect(nextSelection(catalog, "composio", false)).toEqual([]);
});

test("every answer of an update becomes one readable sentence, with the revision for Undo", () => {
  const change = {
    name: "composio",
    action: "enable",
    installed: false,
  } as const;
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const fillIn = (template: string) =>
      template.replace("{name}", "composio").replace("{revision}", "5");
    // Enabling a tool that is not there yet says so; everything names the
    // rewritten instructions and the new revision.
    expect(
      toolChangeOutcome(
        {
          kind: "updated",
          revision: 5,
          warning: "shared-environment-sign-ins",
        },
        change,
        copy,
      ),
    ).toEqual({
      kind: "updated",
      message: `${fillIn(copy.toolsEnabledDone)} ${fillIn(copy.toolsEnabledNotInstalled)}`,
      reload: false,
      revision: 5,
      shared: true,
    });
    for (const [action, key] of [
      ["disable", "toolsDisabledDone"],
      ["note-save", "toolsNoteSaved"],
      ["note-clear", "toolsNoteCleared"],
      ["undo", "toolsUndone"],
    ] as const) {
      const outcome = toolChangeOutcome(
        { kind: "updated", revision: 5 },
        { ...change, action },
        copy,
      );
      expect(outcome).toEqual({
        kind: "updated",
        message: fillIn(copy[key]),
        reload: false,
        revision: 5,
        shared: false,
      });
      expect(outcome.message).toContain("5");
      expect(outcome.message).not.toContain("{");
    }
    expect(
      toolChangeOutcome(
        { kind: "updated", revision: 5 },
        { ...change, installed: true },
        copy,
      ).message,
    ).toBe(fillIn(copy.toolsEnabledDone));
    expect(copy.toolsEnabledDone).toContain(
      locale === "en" ? "agent instructions" : "instrukce pro agenty",
    );
    expect(toolChangeOutcome({ kind: "unchanged" }, change, copy)).toEqual({
      kind: "unchanged",
      message: copy.toolsUnchanged,
      reload: true,
    });
    expect(
      toolChangeOutcome(
        { kind: "blocked", reason: "stale-revision" },
        change,
        copy,
      ),
    ).toEqual({
      kind: "blocked",
      message: copy.toolsBlockedStale,
      reload: true,
    });
    const drift = toolChangeOutcome(
      { kind: "blocked", reason: "drift", path: "AGENTS.md" },
      change,
      copy,
    );
    expect(drift.kind).toBe("blocked");
    expect(drift.reload).toBe(true);
    expect(drift.message).toContain("AGENTS.md");
    expect(drift.message).not.toContain("{");
    expect(
      toolChangeOutcome(
        { kind: "blocked", reason: "incomplete-state" },
        change,
        copy,
      ).message,
    ).toContain("profile-resume");
    // A reason this page has no sentence for is named, never hidden.
    expect(
      toolChangeOutcome(
        { kind: "blocked", reason: "template-upgrade-required" },
        change,
        copy,
      ).message,
    ).toContain("template-upgrade-required");
    // A refusal without a result, a lost answer, an unknown form, a preview.
    for (const unknown of [
      null,
      undefined,
      "updated",
      [],
      { error: "operation-failed", recoveryMayBeRequired: true },
      { kind: "updated" },
      { kind: "updated", revision: 0 },
      { kind: "blocked" },
      { kind: "profile-change", files: [] },
    ])
      expect(toolChangeOutcome(unknown, change, copy)).toEqual({
        kind: "failed",
        message: copy.toolsFailed,
        reload: true,
      });
  }
});

test("the sign-in line and the curated action follow what the probe said", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const installed = tool({ installed: true });
    expect(signInLine(installed, copy)).toBe(copy.toolsSignInUnchecked);
    expect(
      signInLine(
        { ...installed, signIn: { state: "signed-in", account: "octo" } },
        copy,
      ),
    ).toBe(copy.toolsSignedInAs.replace("{account}", "octo"));
    expect(
      signInLine(
        {
          ...installed,
          signIn: {
            state: "signed-in",
            account: "a@b.c",
            organization: "Spectoda",
          },
        },
        copy,
      ),
    ).toBe(
      copy.toolsSignedInAsOrganization
        .replace("{account}", "a@b.c")
        .replace("{organization}", "Spectoda"),
    );
    expect(
      signInLine({ ...installed, signIn: { state: "signed-in" } }, copy),
    ).toBe(copy.toolsSignedIn);
    expect(
      signInLine({ ...installed, signIn: { state: "signed-out" } }, copy),
    ).toBe(copy.toolsSignedOut);
    expect(
      signInLine({ ...installed, signIn: { state: "unknown" } }, copy),
    ).toBe(copy.toolsSignInUnknown);
    // Installed and signed in: no curated button at all. Installed without a
    // known sign-in: "Sign in". Missing: "Install and sign in". An agent tool
    // has no curated action.
    expect(
      curatedActionLabel(
        { ...installed, signIn: { state: "signed-in", account: "octo" } },
        copy,
      ),
    ).toBeNull();
    expect(
      curatedActionLabel(
        { ...installed, signIn: { state: "signed-out" } },
        copy,
      ),
    ).toBe(copy.toolsSignInAction);
    expect(curatedActionLabel(installed, copy)).toBe(copy.toolsSignInAction);
    expect(curatedActionLabel(tool(), copy)).toBe(copy.toolsInstallAction);
    expect(curatedActionLabel(tool({ setup: "agent" }), copy)).toBeNull();
  }
});

test("a note request carries the full next set of notes, sorted; a draft is checked like the Folder state", () => {
  const noted = [
    tool({
      name: "gh",
      command: "gh",
      tier: "required",
      enabled: true,
      note: "Only the Spectoda org.",
    }),
    tool({ enabled: true, note: "Mail of Spectoda." }),
    tool({ name: "wacli", command: "wacli", tier: "optional" }),
  ];
  expect(currentNotes(noted)).toEqual({
    composio: "Mail of Spectoda.",
    gh: "Only the Spectoda org.",
  });
  expect(Object.keys(nextNotes(noted, "composio", undefined))).toEqual(["gh"]);
  expect(Object.keys(nextNotes(noted, "wacli", "x"))).toEqual([
    "composio",
    "gh",
    "wacli",
  ]);
  expect(nextNotes(noted, "gh", "New.")).toEqual({
    composio: "Mail of Spectoda.",
    gh: "New.",
  });
  expect(noted.map(takesNote)).toEqual([true, true, false]);

  const en = messages("en");
  expect(noteDraftView("  Use it for ClickUp.\r\n", undefined, en)).toEqual({
    note: "Use it for ClickUp.",
    count: "19 / 600 characters",
    problem: null,
    savable: true,
  });
  // The recorded text is not saved again; an empty draft is what Clear does.
  expect(noteDraftView("Same.", "Same.", en).savable).toBe(false);
  expect(noteDraftView("   ", "Same.", en)).toMatchObject({
    problem: null,
    savable: false,
  });
  expect(noteDraftView("x".repeat(601), undefined, en)).toMatchObject({
    count: "601 / 600 characters",
    problem: "The note is longer than 600 characters.",
    savable: false,
  });
  expect(noteDraftView("1\n2\n3\n4\n5\n6\n7", undefined, en)).toMatchObject({
    problem: "The note has more than 6 lines.",
    savable: false,
  });
  expect(
    noteDraftView(`a${String.fromCharCode(7)}b`, undefined, en).problem,
  ).toBe(en.toolsNoteControl);
  expect(
    noteDraftView(`a${String.fromCharCode(0x202e)}b`, undefined, en).problem,
  ).toBe(en.toolsNoteControl);
  // Characters are code points: an emoji counts once.
  expect(noteDraftView("👍", undefined, en).count).toBe("1 / 600 characters");
});

test("source links are taken only in their expected form", () => {
  expect(sourceLink("https://github.com/cli/cli#installation")).toBe(
    "https://github.com/cli/cli#installation",
  );
  expect(sourceLink("http://example.com/")).toBeNull();
  expect(sourceLink("javascript:alert(1)")).toBeNull();
  expect(sourceLink("not a url")).toBeNull();
});

test("every tools message exists in both languages and differs where it is a sentence", () => {
  const en = messages("en");
  const cs = messages("cs");
  const keys = (Object.keys(en) as (keyof typeof en)[]).filter((key) =>
    key.startsWith("tools"),
  );
  expect(keys.length).toBeGreaterThan(40);
  for (const key of keys) {
    expect(cs[key].length).toBeGreaterThan(0);
    expect(cs[key]).not.toBe(en[key]);
    // The same placeholders on both sides.
    expect(cs[key].match(/\{\w+\}/g)?.sort() ?? []).toEqual(
      en[key].match(/\{\w+\}/g)?.sort() ?? [],
    );
  }
});
