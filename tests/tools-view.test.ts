import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  nextSelection,
  parseToolsOverview,
  previewedFiles,
  sourceLink,
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
  expect(toolStatusView(tool(), en)).toEqual({
    state: "missing",
    headline: "Not installed",
    path: null,
    notes: [],
  });
  expect(toolStatusView(tool(), cs).headline).toBe("Není nainstalováno");
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
  expect(toolStatusView(elsewhere, en)).toEqual({
    state: "attention",
    headline: "Installed, version 0.7.1",
    path: "/opt/bin/composio → /opt/composio/0.7.1/composio",
    notes: [en.toolsOutsideStandard],
  });
  expect(toolStatusView(elsewhere, cs).notes).toEqual([
    cs.toolsOutsideStandard,
  ]);
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

test("every answer of a preview or an update becomes one readable sentence", () => {
  const change = { name: "composio", enable: true, installed: false };
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const previewed = toolChangeOutcome(
      {
        kind: "profile-change",
        files: [
          { kind: "replace", path: "AGENTS.md" },
          { kind: "replace", path: "manual/this-machine.md" },
        ],
      },
      change,
      copy,
    );
    expect(previewed.kind).toBe("previewed");
    expect(previewed.reload).toBe(false);
    expect(previewed.message).toContain("composio");
    expect(previewed.message).toContain("AGENTS.md, manual/this-machine.md");
    expect(previewed.message).not.toContain("{");
    // Enabling a tool that is not there yet says so; disabling does not.
    expect(previewed.message).toContain(
      copy.toolsConfirmNotInstalled.replace("{name}", "composio"),
    );
    const disabling = toolChangeOutcome(
      { kind: "profile-change", files: [] },
      { ...change, enable: false },
      copy,
    );
    expect(disabling.message).toBe(
      copy.toolsConfirmDisable.replace("{name}", "composio"),
    );
    expect(
      toolChangeOutcome(
        { kind: "profile-change", files: [] },
        { ...change, installed: true },
        copy,
      ).message,
    ).toBe(copy.toolsConfirmEnable.replace("{name}", "composio"));

    expect(
      toolChangeOutcome({ kind: "updated", revision: 5 }, change, copy),
    ).toEqual({
      kind: "updated",
      message: copy.toolsEnabledDone
        .replace("{name}", "composio")
        .replace("{revision}", "5"),
      reload: false,
    });
    expect(
      toolChangeOutcome(
        { kind: "updated", revision: 5 },
        { ...change, enable: false },
        copy,
      ).message,
    ).toContain("5");
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
    // A refusal without a result, a lost answer, an unknown form.
    for (const unknown of [
      null,
      undefined,
      "updated",
      [],
      { error: "operation-failed", recoveryMayBeRequired: true },
      { kind: "updated" },
      { kind: "blocked" },
    ])
      expect(toolChangeOutcome(unknown, change, copy)).toEqual({
        kind: "failed",
        message: copy.toolsFailed,
        reload: true,
      });
  }
});

test("previewed files and source links are taken only in their expected form", () => {
  expect(
    previewedFiles({ files: [{ path: "AGENTS.md" }, { path: 7 }, null] }),
  ).toEqual(["AGENTS.md"]);
  expect(previewedFiles({ files: "AGENTS.md" })).toEqual([]);
  expect(previewedFiles(null)).toEqual([]);
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
