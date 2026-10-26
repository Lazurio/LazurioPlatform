import { expect, test } from "bun:test";
import {
  composioNameStep,
  composioSceneLabel,
  composioScreen,
} from "../src/launchpad/composio-scene";
import { messages } from "../src/launchpad/messages";
import {
  answerWithin,
  composioConnectedLine,
  composioDialogView,
  composioPollDelay,
  composioPollMaxMs,
  composioPollNext,
  composioPollStartMs,
  composioSignInText,
  connectionLine,
  createLoginPoll,
  curatedActions,
  currentNotes,
  gitIdentityNote,
  installOutcome,
  type LoginView,
  loginCancelOffered,
  loginCloseAction,
  loginEndMessage,
  loginFlowState,
  loginLink,
  loginPollGivenUp,
  loginPollGraceMs,
  loginProgress,
  loginStepOrder,
  loginSteps,
  logoutOutcome,
  nextNotes,
  nextSelection,
  noteDraftView,
  noticeHolds,
  organizationChoices,
  parseLoginState,
  parseToolsOverview,
  qrImageSource,
  signedInMessage,
  signInLine,
  signInMode,
  sourceLink,
  sshOutcome,
  type ToolNotice,
  takesNote,
  teamInstallOutcome,
  toolChangeOutcome,
  toolDescription,
  toolGroups,
  toolGuideTargets,
  toolNoticeView,
  toolStatusView,
  updateAction,
  updateOutcome,
} from "../src/launchpad/tools-view";
import type { ToolOverview, ToolsOverview } from "../src/tools/overview";
import { qrMatrix, qrSvg } from "../src/tools/qr";

const tool = (overrides: Partial<ToolOverview> = {}): ToolOverview => ({
  name: "composio",
  command: "composio",
  tier: "recommended",
  setup: "launchpad",
  enabled: false,
  offered: true,
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
  // The Launchpad's older reading answered at once while it reads anew
  // (tools-reading.ts) says so, and only with `true`.
  const stale = { ...valid, stale: true as const };
  expect(parseToolsOverview(JSON.parse(JSON.stringify(stale)))).toEqual(stale);
  for (const broken of [
    { ...valid, stale: false },
    { ...valid, stale: "yes" },
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
    // Each tier's heading alone: what the tiers mean is the "?"'s
    // (decision F56's addendum of 2026-10-18).
    for (const group of groups)
      expect(Object.hasOwn(group, "note")).toBe(false);
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
    fix: false,
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
    fix: false,
  });
  // A link is shown with where it leads. A PATH entry elsewhere on a hosted
  // Machine says nothing a person would have to decode: the card offers "Fix
  // with an agent" (Matěj 2026-10-05).
  const elsewhere = tool({
    installed: true,
    version: "0.7.1",
    path: "/opt/bin/composio",
    realPath: "/opt/composio/0.7.1/composio",
    standardPath: false,
  });
  expect(toolStatusView(elsewhere, en, true)).toEqual({
    state: "ready",
    headline: "Installed, version 0.7.1",
    path: "/opt/bin/composio → /opt/composio/0.7.1/composio",
    notes: [],
    fix: true,
  });
  expect(toolStatusView(elsewhere, cs, true).notes).toEqual([]);
  expect([en.toolsFixWithAgent, cs.toolsFixWithAgent]).toEqual([
    "Fix with an agent",
    "Opravit s agentem",
  ]);
  // A Team's gh is the Organization's brokered gh, installed by the Machine
  // outside ~/.local/bin on purpose: nothing to fix there; another tool is.
  const brokered = tool({
    name: "gh",
    installed: true,
    version: "2.101.0",
    path: "/usr/local/bin/gh",
    realPath: "/usr/local/bin/gh",
    standardPath: false,
  });
  expect(toolStatusView(brokered, en, true, true).fix).toBe(false);
  expect(toolStatusView(brokered, en, true, false).fix).toBe(true);
  expect(toolStatusView(elsewhere, en, true, true).fix).toBe(true);
  // On a local workstation any tool on PATH is fine: nothing to fix.
  expect(toolStatusView(elsewhere, en, false)).toEqual({
    state: "ready",
    headline: "Installed, version 0.7.1",
    path: "/opt/bin/composio → /opt/composio/0.7.1/composio",
    notes: [],
    fix: false,
  });
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
    fix: false,
  });
});

// Lazurio's build of composio (decision F42, addendum (3)): a composio that
// is not that build says so in its Details and offers "Update" where the
// update can work, the person's click being the consent.
test("a tool that is not the build Lazurio pins says so, and offers Update only where it can work", () => {
  const installed = {
    installed: true,
    path: "/home/o/.local/bin/composio",
    realPath: "/home/o/.composio/composio",
    standardPath: true,
    pinned: "0.4.3-lazurio.3",
  } as const;
  const stock = tool({ ...installed, version: "0.4.3" });
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    expect(toolStatusView(stock, copy, true)).toEqual({
      state: "attention",
      headline: copy.toolsInstalled.replace("{version}", "0.4.3"),
      path: "/home/o/.local/bin/composio → /home/o/.composio/composio",
      notes: [copy.toolsNotPinned.replace("{pinned}", "0.4.3-lazurio.3")],
      fix: false,
    });
    expect(updateAction(stock, copy)).toEqual({
      label: copy.toolsUpdateAction,
      named: copy.toolsUpdateActionNamed.replace("{name}", "composio"),
    });
    // The previous pin, Lazurio's own earlier build, is not the build
    // Lazurio uses now either: the same note names the current one.
    const previous = tool({ ...installed, version: "0.4.3-lazurio.1" });
    expect(toolStatusView(previous, copy, true)).toMatchObject({
      state: "attention",
      notes: [copy.toolsNotPinned.replace("{pinned}", "0.4.3-lazurio.3")],
    });
    expect(updateAction(previous, copy)?.label).toBe(copy.toolsUpdateAction);
    // Signed in or not: the update keeps the sign-in. A version that could
    // not be read is not the pinned build either, and an older build of
    // the fork is not it.
    for (const other of [
      tool({ ...installed, version: "0.4.3", signIn: { state: "signed-in" } }),
      tool({ ...installed, versionError: "exit 7" }),
      tool({ ...installed, version: "0.4.2-lazurio.1" }),
    ])
      expect(updateAction(other, copy)?.label).toBe(copy.toolsUpdateAction);
    // The pinned build, a tool without a pin, one not installed, one
    // elsewhere on PATH (never shadowed by a second copy), one this
    // Environment does not offer, one the Organization does not allow, and
    // a tool an agent sets up: no "Update".
    for (const other of [
      tool({ ...installed, version: "0.4.3-lazurio.3" }),
      tool({
        installed: true,
        version: "0.4.3",
        path: "/home/o/.local/bin/composio",
        standardPath: true,
      }),
      tool({ pinned: "0.4.3-lazurio.3" }),
      tool({ ...installed, version: "0.4.3", standardPath: false }),
      tool({ ...installed, version: "0.4.3", offered: false }),
      tool({
        ...installed,
        version: "0.4.3",
        organization: { allowed: false },
      }),
      tool({ ...installed, version: "0.4.3", setup: "agent" }),
    ])
      expect(updateAction(other, copy)).toBeNull();
    expect(
      toolStatusView(
        tool({ ...installed, version: "0.4.3-lazurio.3" }),
        copy,
        true,
      ),
    ).toMatchObject({ state: "ready", notes: [] });
    // What the update answered, in one sentence; why it failed in Details.
    expect(
      updateOutcome(
        {
          kind: "tool-updated",
          tool: "composio",
          after: { version: "0.4.3-lazurio.3" },
          changed: true,
        },
        "composio",
        copy,
      ),
    ).toEqual({
      kind: "updated",
      reload: false,
      message: copy.toolsUpdatedNow
        .replace("{name}", "composio")
        .replace("{version}", "0.4.3-lazurio.3"),
    });
    expect(
      updateOutcome(
        {
          kind: "tool-update-failed",
          tool: "composio",
          output: "verify: version-mismatch",
        },
        "composio",
        copy,
      ),
    ).toEqual({
      kind: "failed",
      reload: false,
      message: copy.toolsUpdateFailed,
      detail: copy.toolsUpdateFailedDetail.replace(
        "{reason}",
        "verify: version-mismatch",
      ),
    });
    expect(
      updateOutcome({ kind: "blocked", reason: "busy" }, "composio", copy),
    ).toEqual({
      kind: "blocked",
      reload: false,
      message: copy.toolsInstallBusy,
    });
    expect(updateOutcome("<html>", "composio", copy)).toMatchObject({
      kind: "failed",
      message: copy.toolsFailed,
    });
    // The notice on the row says the same from the answer it got.
    expect(
      toolNoticeView(
        {
          name: "composio",
          revision: 4,
          act: {
            kind: "update",
            answer: {
              kind: "tool-update-failed",
              tool: "composio",
              output: "download: http-404",
            },
          },
          undo: null,
        },
        stock,
        copy,
      ).message,
    ).toBe(copy.toolsUpdateFailed);
  }
  expect([
    messages("en").toolsUpdateAction,
    messages("cs").toolsUpdateAction,
  ]).toEqual(["Update", "Aktualizovat"]);
  // The page takes the pin from the server's answer, only as text.
  const answer = { ...overview([stock]) };
  expect(parseToolsOverview(answer)?.tools[0]?.pinned).toBe("0.4.3-lazurio.3");
  expect(
    parseToolsOverview({ ...answer, tools: [{ ...stock, pinned: 4 }] }),
  ).toBeNull();
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

test("every answer of an update becomes one plain sentence; the revision travels for Undo, the technical part for Details", () => {
  const change = {
    name: "composio",
    action: "enable",
    installed: false,
  } as const;
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const named = (template: string) => template.replace("{name}", "composio");
    // A tool that is not installed yet is only switched on: its row says
    // that agents start using it once it is (Matěj 2026-10-09).
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
      message: copy.toolsSwitchedOn,
      reload: false,
      revision: 5,
      shared: true,
    });
    expect(
      toolChangeOutcome(
        { kind: "updated", revision: 5 },
        { ...change, installed: true },
        copy,
      ).message,
    ).toBe(named(copy.toolsEnabledDone));
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
        message: named(copy[key]),
        reload: false,
        revision: 5,
        shared: false,
      });
      // The revision is for Undo, never for the person.
      expect(outcome.message).not.toContain("5");
      expect(outcome.message).not.toContain("{");
    }
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
    // A drifted file, an unfinished change and a reason this page has no
    // sentence for say plainly that nothing was saved; the path, the command
    // and the code are named, never hidden: in the Details.
    for (const [answer, message, technical] of [
      [
        { kind: "blocked", reason: "drift", path: "AGENTS.md" },
        copy.toolsBlockedDrift,
        "AGENTS.md",
      ],
      [
        { kind: "blocked", reason: "incomplete-state" },
        copy.toolsBlockedIncomplete,
        "lazurio profile-resume",
      ],
      [
        { kind: "blocked", reason: "template-upgrade-required" },
        copy.toolsBlockedOther,
        "template-upgrade-required",
      ],
    ] as const) {
      const outcome = toolChangeOutcome(answer, change, copy);
      expect(outcome).toMatchObject({ kind: "blocked", message, reload: true });
      expect(outcome.message).not.toContain(technical);
      expect(outcome.detail).toContain(technical);
      expect(outcome.detail).not.toContain("{");
    }
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
        detail: copy.toolsFailedDetail,
        reload: true,
      });
  }
});

test("a notice follows the live state of its tool: said once, only while it is true (Matěj 2026-10-09)", () => {
  const enable: ToolNotice = {
    name: "composio",
    revision: 4,
    act: {
      kind: "change",
      action: "enable",
      answer: { kind: "updated", revision: 4 },
    },
    undo: { tools: [], notes: {} },
  };
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const hint = copy.toolsEnabledNotInstalled.replace("{name}", "composio");
    const inUse = copy.toolsEnabledDone.replace("{name}", "composio");
    // What the row says: the line under the name and the notice under it.
    const row = (current: ToolOverview) => {
      const notice = toolNoticeView(enable, current, copy);
      return {
        line: connectionLine(current, copy).text,
        notice: notice.message,
        all: `${connectionLine(current, copy).text}\n${notice.message}\n${notice.detail ?? ""}`,
      };
    };
    // Switched on before it is installed: the row says once that agents
    // start using it once it is; nothing says they use it now.
    const before = row(tool({ enabled: true }));
    expect(before.line).toBe(hint);
    expect(before.notice).toBe(copy.toolsSwitchedOn);
    expect(before.all.split(hint).length - 1).toBe(1);
    expect(before.all).not.toContain(inUse);
    // The same notice after the installation and the sign-in: nothing says
    // it is not installed any more, and the notice says agents use it.
    const after = row(
      tool({
        enabled: true,
        installed: true,
        signIn: { state: "signed-in", account: "a@example.com" },
      }),
    );
    expect(after.line).toBe(
      copy.toolsSignedInAs.replace("{account}", "a@example.com"),
    );
    expect(after.notice).toBe(inUse);
    expect(after.all).not.toContain(hint);
    expect(after.all).not.toContain(copy.toolsNotAdded);
    // Switched off, or a required tool, which has no switch: only "not
    // added yet".
    expect(connectionLine(tool(), copy).text).toBe(copy.toolsNotAdded);
    expect(
      connectionLine(
        tool({ name: "gh", command: "gh", tier: "required", enabled: true }),
        copy,
      ).text,
    ).toBe(copy.toolsNotAdded);
    // A sign-out says what happened, from the answer it got.
    const signedOut = toolNoticeView(
      {
        name: "composio",
        revision: 4,
        act: {
          kind: "logout",
          answer: { kind: "logged-out", revocation: "local-only" },
        },
        undo: null,
      },
      tool({ installed: true }),
      copy,
    );
    expect(signedOut).toEqual({
      kind: "updated",
      reload: false,
      message: copy.toolsSignedOutLocal.replace("{name}", "composio"),
    });
  }
  // A notice holds while the page reads the revision it belongs to, and
  // ends at a reading of another one (the Folder changed elsewhere and its
  // Undo would be refused) or once its tool is no longer listed.
  expect(noticeHolds(enable, overview(catalog))).toBe(true);
  expect(noticeHolds(enable, { ...overview(catalog), revision: 5 })).toBe(
    false,
  );
  expect(noticeHolds(enable, overview([tool({ name: "wacli" })]))).toBe(false);
});

test("the main view of Nástroje says nothing technical; what support needs stays in Details (Matěj 2026-10-09)", () => {
  // The Folder, a revision, a CLI command, a path, a fingerprint, a
  // placeholder left unfilled.
  const technical =
    /Folder|[Rr]evi[sz]|\blazurio [a-z]|~\/|\.md\b|AGENTS|\bPATH\b|SHA256:|\{\w+\}/;
  const print = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const change = (answer: unknown, installed = false) =>
      toolChangeOutcome(
        answer,
        { name: "composio", action: "enable", installed },
        copy,
      );
    const outcomes = [
      change({ kind: "updated", revision: 12 }),
      change({ kind: "updated", revision: 12 }, true),
      change({ kind: "unchanged" }),
      change({ kind: "blocked", reason: "stale-revision" }),
      change({ kind: "blocked", reason: "drift", path: "manual/x.md" }),
      change({ kind: "blocked", reason: "incomplete-state" }),
      change({ kind: "blocked", reason: "custom-composition-unavailable" }),
      change(null),
      ...["removed", "kept-not-lazurio", "not-removed", "no-key"].map((state) =>
        logoutOutcome(
          {
            kind: "logged-out",
            revocation: "local-only",
            sshKey: { state, fingerprint: print },
          },
          "gh",
          copy,
        ),
      ),
      logoutOutcome({ kind: "logout-failed", reason: "tool-exit" }, "gh", copy),
      teamInstallOutcome(
        { kind: "installed", version: "2.101.0", onPath: false },
        "gh",
        copy,
      ),
      teamInstallOutcome(
        { kind: "unsupported-platform", platform: "win32", arch: "x64" },
        "gh",
        copy,
      ),
      teamInstallOutcome(
        { kind: "install-failed", stage: "checksum", reason: "mismatch" },
        "gh",
        copy,
      ),
    ];
    // A switched-on tool that is not installed says when agents start
    // using it, in plain words.
    expect(connectionLine(tool({ enabled: true }), copy).text).toBe(
      copy.toolsEnabledNotInstalled.replace("{name}", "composio"),
    );
    for (const said of [
      copy.toolsLoadFailed,
      connectionLine(tool({ enabled: true }), copy).text,
      ...outcomes.map((outcome) => outcome.message),
    ]) {
      expect(said).not.toMatch(technical);
      expect(said).not.toContain("12");
    }
    // The technical part is kept, under the tool's Details.
    const details = outcomes.map((outcome) => outcome.detail ?? "").join("\n");
    for (const kept of [
      "manual/x.md",
      "lazurio profile-resume",
      "custom-composition-unavailable",
      "lazurio recover",
      print,
      "tool-exit",
      "win32",
      "mismatch",
      "~/.local/bin",
    ])
      expect(details).toContain(kept);
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
    // Missing: "Install and sign in". Installed without a known sign-in:
    // "Sign in". Signed in: only "Sign out". An agent tool has none.
    expect(curatedActions(tool(), copy)).toEqual({
      primary: { mode: "install", label: copy.toolsInstallAction },
      logout: false,
      linkSsh: false,
    });
    for (const signIn of [
      undefined,
      { state: "signed-out" },
      { state: "unknown" },
    ] as const)
      expect(
        curatedActions(
          signIn === undefined ? installed : { ...installed, signIn },
          copy,
        ),
      ).toEqual({
        primary: { mode: "login", label: copy.toolsSignInAction },
        logout: false,
        linkSsh: false,
      });
    expect(
      curatedActions(
        { ...installed, signIn: { state: "signed-in", account: "octo" } },
        copy,
      ),
    ).toEqual({ primary: null, logout: true, linkSsh: false });
    // gh signed in: "· SSH key linked" or "· not linked" with "Link SSH key".
    const gh = tool({ name: "gh", command: "gh", installed: true });
    const withSsh = (state: "linked" | "not-linked" | "unknown") => ({
      ...gh,
      signIn: { state: "signed-in", account: "octo", ssh: { state } } as const,
    });
    expect(signInLine(withSsh("linked"), copy)).toBe(
      `${copy.toolsSignedInAs.replace("{account}", "octo")} · ${copy.toolsSshLinked}`,
    );
    expect(signInLine(withSsh("not-linked"), copy)).toBe(
      `${copy.toolsSignedInAs.replace("{account}", "octo")} · ${copy.toolsSshNotLinked}`,
    );
    expect(signInLine(withSsh("unknown"), copy)).toBe(
      `${copy.toolsSignedInAs.replace("{account}", "octo")} · ${copy.toolsSshUnknown}`,
    );
    expect(curatedActions(withSsh("linked"), copy).linkSsh).toBe(false);
    expect(curatedActions(withSsh("not-linked"), copy).linkSsh).toBe(true);
    expect(curatedActions(withSsh("unknown"), copy).linkSsh).toBe(true);
    expect(
      curatedActions(
        { ...gh, signIn: { state: "signed-in", account: "octo" } },
        copy,
      ).linkSsh,
    ).toBe(true);
    for (const agent of [
      tool({ setup: "agent" }),
      tool({ setup: "agent", installed: true, signIn: { state: "signed-in" } }),
    ])
      expect(curatedActions(agent, copy)).toEqual({
        primary: null,
        logout: false,
        linkSsh: false,
      });
  }
});

const handle = "0123456789abcdef0123456789abcdef";

test("a login answer is accepted only in its exact form, with links on their expected host", () => {
  expect(
    parseLoginState({
      kind: "pending",
      tool: "gh",
      session: handle,
      expiresAt: "2026-09-28T10:00:00.000Z",
      challenge: {
        kind: "device-code",
        url: "https://github.com/login/device",
        code: "WXYZ-9876",
      },
    }),
  ).toMatchObject({ kind: "pending", challenge: { code: "WXYZ-9876" } });
  const pending = (challenge: unknown, extra = {}) =>
    parseLoginState({
      kind: "pending",
      tool: "gh",
      session: handle,
      expiresAt: "x",
      challenge,
      ...extra,
    });
  for (const challenge of [
    {
      kind: "device-code",
      url: "https://evil.example/login/device",
      code: "WXYZ-9876",
    },
    {
      kind: "device-code",
      url: "http://github.com/login/device",
      code: "WXYZ-9876",
    },
    {
      kind: "device-code",
      url: "https://github.com/login/device",
      code: "<b>",
    },
    { kind: "url", url: "https://dashboard.composio.dev.evil.example/" },
    { kind: "url", url: "javascript:alert(1)" },
    { kind: "qr", payload: "x" },
    { kind: "pair-code", phone: "123", code: "ABCD-EFGH", sequence: 1 },
    { kind: "other" },
  ])
    expect(pending(challenge)).toBeNull();
  expect(
    pending({ kind: "url", url: "https://dashboard.composio.dev/?cliKey=k" }),
  ).toMatchObject({ challenge: { kind: "url" } });
  expect(pending(undefined)).toMatchObject({ kind: "pending" });
  expect(pending(undefined, { session: "../x" })).toBeNull();
  expect(
    parseLoginState({ kind: "failed", tool: "gh", reason: "secret" }),
  ).toBeNull();
  expect(
    parseLoginState({ kind: "signed-in", tool: "gh", account: 3 }),
  ).toBeNull();
  expect(parseLoginState({ kind: "expired", tool: "gh" })).toEqual({
    kind: "expired",
    tool: "gh",
  });
  expect(parseLoginState(null)).toBeNull();
  expect(loginLink("https://github.com/login/device", "github.com")).toBe(
    "https://github.com/login/device",
  );
  expect(loginLink("https://github.com:444/", "github.com")).toBeNull();
});

test("the QR image is taken only in the exact form the server draws", () => {
  const svg = qrSvg(qrMatrix("2@ref,key=,id=,adv="));
  const source = qrImageSource(svg);
  expect(source?.startsWith("data:image/svg+xml;base64,")).toBe(true);
  expect(atob((source as string).split(",")[1] as string)).toBe(svg);
  for (const bad of [
    undefined,
    "",
    svg.replace("</svg>", "<script>alert(1)</script></svg>"),
    svg.replace('fill="#000"', 'fill="#000" onload="x()"'),
    svg.replace("<path", '<image href="https://evil.example/x.png"/><path'),
    `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>`,
  ])
    expect(qrImageSource(bad)).toBeNull();
});

test("the steps say installing, waiting for you, linking the SSH key, signed in, and where it stopped", () => {
  const copy = messages("en");
  const states = (
    mode: "install" | "login" | "ssh",
    phase: Parameters<typeof loginSteps>[1],
    at: "installing" | "waiting" | "linking" = "waiting",
    tool = "wacli",
    refresh = false,
  ) =>
    loginSteps(loginStepOrder({ mode, tool, refresh }), phase, at, copy).map(
      (step) => `${step.label}:${step.state}`,
    );
  expect(states("install", "confirm")).toEqual([
    "Installing:todo",
    "Waiting for you:todo",
    "Connected:todo",
  ]);
  expect(states("install", "installing")).toEqual([
    "Installing:current",
    "Waiting for you:todo",
    "Connected:todo",
  ]);
  expect(states("install", "waiting")).toEqual([
    "Installing:done",
    "Waiting for you:current",
    "Connected:todo",
  ]);
  expect(states("login", "signed-in")).toEqual([
    "Waiting for you:done",
    "Connected:done",
  ]);
  expect(states("install", "failed", "installing")).toEqual([
    "Installing:failed",
    "Waiting for you:todo",
    "Connected:todo",
  ]);
  expect(states("login", "failed")).toEqual([
    "Waiting for you:failed",
    "Connected:todo",
  ]);
  // gh links the SSH key as a step of its own.
  expect(states("login", "linking", "linking", "gh")).toEqual([
    "Waiting for you:done",
    "Linking the SSH key:current",
    "Connected:todo",
  ]);
  expect(states("install", "failed", "linking", "gh")).toEqual([
    "Installing:done",
    "Waiting for you:done",
    "Linking the SSH key:failed",
    "Connected:todo",
  ]);
  expect(states("ssh", "linking", "linking", "gh")).toEqual([
    "Linking the SSH key:current",
    "SSH key linked:todo",
  ]);
  expect(states("ssh", "waiting", "waiting", "gh", true)).toEqual([
    "Waiting for you:current",
    "Linking the SSH key:todo",
    "SSH key linked:todo",
  ]);
  expect(states("ssh", "signed-in", "linking", "gh", true)).toEqual([
    "Waiting for you:done",
    "Linking the SSH key:done",
    "SSH key linked:done",
  ]);
  // Composio's dialog draws no steps, while it installs, waits for the
  // browser or is signed in (decision F42 addendum (2), note of 2026-10-17).
  for (const phase of ["installing", "waiting", "signed-in", "failed"] as const)
    expect(states("install", phase, "waiting", "composio")).toEqual([]);
});

// Composio's sign-in dialog after the sign-in (decision F42, addendum (2)
// of 2026-10-13, note of 2026-10-17): one view per answer of
// /api/tools/composio/organizations.
test("Composio's dialog: create, rename, one sentence or connected, from the organizations' answer", () => {
  const copy = messages("cs");
  const named = (
    state: string,
    organizations = [
      { id: "org_1", name: "jana_workspace", current: true },
      { id: "org_2", name: "Acme", current: false },
    ],
  ) => ({
    kind: "composio-organizations",
    organizations,
    organization: { name: "Lazurio Example Organization", state },
  });
  // The name as Composio accepts it (note of 2026-10-17: "Only letters,
  // numbers, and underscores allowed."): the one the person types there and
  // reads in Composio, never "Lazurio Example Organization".
  expect(
    composioDialogView(named("missing"), "jana@example.com", copy),
  ).toEqual({ kind: "create", name: "LazurioExampleOrganization" });
  expect(
    composioDialogView(named("ambiguous"), "jana@example.com", copy),
  ).toEqual({ kind: "rename", name: "LazurioExampleOrganization" });
  expect(
    composioDialogView(named("elsewhere"), "jana@example.com", copy),
  ).toEqual({
    kind: "problem",
    message:
      "Composio se nepodařilo přepnout do vaší organizace „LazurioExampleOrganization“.",
  });
  // A name with nothing Composio accepts is never asked for.
  expect(
    composioDialogView(
      {
        kind: "composio-organizations",
        organizations: [{ id: "org_1", name: "jana_workspace", current: true }],
        organization: { name: "Пример", state: "missing" },
      },
      "jana@example.com",
      copy,
    ),
  ).toEqual({ kind: "problem", message: copy.toolsComposioOrgUnverified });
  // The organization of the line is the one the answer marks current after
  // the switch, as Composio names it, never the one the sign-in named.
  const matched = composioDialogView(
    named("matches", [
      { id: "org_1", name: "jana_workspace", current: false },
      { id: "org_2", name: "lazurio example organization", current: true },
    ]),
    "jana@example.com",
    copy,
  );
  expect(matched).toEqual({
    kind: "connected",
    account: "jana@example.com",
    organization: "lazurio example organization",
    choices: null,
  });
  if (matched.kind !== "connected") throw new Error("not connected");
  expect(composioConnectedLine(matched)).toBe(
    "jana@example.com · lazurio example organization",
  );
  // Unverified keeps the refusal, in one sentence.
  expect(
    composioDialogView(
      {
        kind: "composio-organizations",
        organizations: [],
        organization: { name: null, state: "unverified" },
      },
      null,
      copy,
    ),
  ).toEqual({ kind: "problem", message: copy.toolsComposioOrgUnverified });
  // An answer that cannot be read is one sentence too.
  for (const answer of [
    null,
    "<html>",
    { kind: "composio-organizations-failed", reason: "unreadable" },
  ])
    expect(composioDialogView(answer, "jana@example.com", copy)).toEqual({
      kind: "problem",
      message: copy.toolsComposioOrgUnavailable,
    });
  // Where the person chooses: connected, the choice only among several.
  const personal = (organizations: unknown[]) => ({
    kind: "composio-organizations",
    organizations,
    organization: null,
    personal: true,
  });
  expect(
    composioDialogView(
      personal([{ id: "org_1", name: "jana_workspace", current: true }]),
      "jana@example.com",
      copy,
    ),
  ).toEqual({
    kind: "connected",
    account: "jana@example.com",
    organization: "jana_workspace",
    choices: null,
  });
  const several = composioDialogView(
    personal([
      { id: "org_1", name: "jana_workspace", current: true },
      { id: "org_2", name: "Northwind", current: false },
    ]),
    null,
    copy,
  );
  expect(several).toEqual({
    kind: "connected",
    account: null,
    organization: "jana_workspace",
    choices: [
      { id: "org_1", label: "jana_workspace", current: true },
      { id: "org_2", label: "Northwind", current: false },
    ],
  });
  if (several.kind !== "connected") throw new Error("not connected");
  expect(composioConnectedLine(several)).toBe("jana_workspace");
  // No organization current is never connected: an empty list, or ones none
  // of which is current, personal or named alike. The dialog keeps reading.
  const none = {
    kind: "problem" as const,
    message: copy.toolsComposioOrgUnavailable,
  };
  for (const answer of [
    personal([]),
    personal([{ id: "org_1", name: "jana_workspace", current: false }]),
    personal([
      { id: "org_1", name: "jana_workspace", current: false },
      { id: "org_2", name: "Northwind", current: false },
    ]),
    named("matches", []),
    named("matches", [
      { id: "org_2", name: "Lazurio Example Organization", current: false },
    ]),
  ]) {
    const view = composioDialogView(answer, "bob@example.com", copy);
    expect(view).toEqual(none);
    expect(composioPollNext(view, { open: true, hidden: false })).toBe("read");
  }
});

test("in a Team Environment Nástroje names the Team's Composio account, elsewhere the person's own (decision F42, note of 2026-10-19)", () => {
  const cs = messages("cs");
  const en = messages("en");
  // The row's sentence: the reading's `sharedEnvironment` chooses it.
  expect(toolDescription(tool(), cs, true)).toBe(
    "Snadná cesta k mnoha aplikacím přes Composio, s týmovým účtem Composia. Aplikace připojíte v Apps → Integrace.",
  );
  expect(toolDescription(tool(), en, true)).toBe(
    "An easy way to many apps through Composio, with the Team's Composio account. You connect the apps in Apps → Integrations.",
  );
  for (const shared of [false, undefined])
    expect(toolDescription(tool(), cs, shared)).toBe(
      "Snadná cesta k mnoha aplikacím přes Composio, s vaším vlastním účtem. Aplikace připojíte v Apps → Integrace.",
    );
  // Only Composio's sentence differs; gh's stays the same in either.
  expect(toolDescription(tool({ name: "gh" }), cs, true)).toBe(
    toolDescription(tool({ name: "gh" }), cs, false),
  );
  // The sign-in dialog's line before the person signs in to Composio.
  expect(composioSignInText(cs, true)).toBe(
    "Přihlaste se do Composia v prohlížeči týmovým účtem Composia, ne osobním.",
  );
  expect(composioSignInText(en, true)).toBe(
    "Sign in to Composio in your browser with the Team's Composio account, not a personal one.",
  );
  expect(composioSignInText(cs, false)).toBe(
    "Přihlaste se do Composia v prohlížeči.",
  );
  expect(composioSignInText(en, false)).toBe(
    "Sign in to Composio in your browser.",
  );
});

test("Composio's dialog reads again calmly while the person works in Composio, and stops once connected, closed or hidden", () => {
  expect(composioPollDelay(0)).toBe(composioPollStartMs);
  expect(composioPollStartMs).toBe(4_000);
  expect([1, 2, 3, 4].map(composioPollDelay)).toEqual([
    6_000, 9_000, 13_500, 20_250,
  ]);
  expect(composioPollDelay(5)).toBe(composioPollMaxMs);
  expect(composioPollDelay(50)).toBe(30_000);
  const open = { open: true, hidden: false };
  for (const view of [
    { kind: "create", name: "Acme" },
    { kind: "rename", name: "Acme" },
    { kind: "problem", message: "x" },
  ] as const) {
    expect(composioPollNext(view, open)).toBe("read");
    expect(composioPollNext(view, { open: true, hidden: true })).toBe("pause");
    expect(composioPollNext(view, { open: false, hidden: false })).toBe("stop");
  }
  const connected = {
    kind: "connected",
    account: null,
    organization: "Acme",
    choices: null,
  } as const;
  expect(composioPollNext(connected, open)).toBe("stop");
  expect(composioPollNext(connected, { open: true, hidden: true })).toBe(
    "stop",
  );
});

// The drawing of Composio's dashboard (decision F42, note of 2026-10-17),
// matched again to the dashboard on 2026-10-19: the card at the bottom left
// is the person's own (their name and current organization), and it opens a
// menu whose top row, "Organization" with the current one, opens the list
// with "Create Org". The drawing went from a card straight to the list; it
// now draws the menu as its own step, so the name is the fifth.
test("the drawing goes through the person's menu: FOR YOU, the account, Organization, Create Org, then the name", () => {
  expect(composioSceneLabel(messages("cs"), "LazurioExampleOrganization")).toBe(
    "V Composiu: 1. FOR YOU, 2. váš účet vlevo dole, 3. Organization, 4. Create Org, 5. jméno LazurioExampleOrganization a Create organization.",
  );
  expect(composioSceneLabel(messages("en"), "LazurioExampleOrganization")).toBe(
    "In Composio: 1. FOR YOU, 2. your account at the bottom left, 3. Organization, 4. Create Org, 5. the name LazurioExampleOrganization and Create organization.",
  );
  // The dialog's name box carries the number of the step it belongs to.
  expect(composioNameStep).toBe(5);
  // Composio's own words, as its dashboard writes them; the person and the
  // organizations are fictional, the current one last.
  expect(composioScreen).toMatchObject({
    forYou: "FOR YOU",
    organization: "Organization",
    logOut: "Log out",
    findOrg: "Find Org...",
    createOrg: "Create Org",
    person: "Jana",
    organizations: ["Acme", "Northwind", "jana_workspace"],
  });
});

test("the Git identity of a gh sign-in is read only in its exact form and becomes one sentence for people", () => {
  const signedIn = (gitIdentity: unknown) =>
    parseLoginState({
      kind: "signed-in",
      tool: "gh",
      account: "octocat",
      gitIdentity,
    });
  const identity = {
    name: "The Octocat",
    email: "583231+octocat@users.noreply.github.com",
  };
  const set = signedIn({
    state: "set",
    fields: ["user.name", "user.email"],
    identity,
  });
  expect(set).toMatchObject({ gitIdentity: { state: "set", identity } });
  expect(gitIdentityNote(set as LoginView, messages("cs"))).toEqual({
    set: true,
    message:
      "Vaše commity v tomto Prostředí ponesou jméno The Octocat <583231+octocat@users.noreply.github.com>.",
  });
  const unset = signedIn({
    state: "not-set",
    reason: "viewer-unavailable",
    missing: ["user.email"],
  });
  expect(gitIdentityNote(unset as LoginView, messages("en"))).toEqual({
    set: false,
    message: messages("en").toolsGitIdentityNotSet,
  });
  // One field written (git had the other): no name is claimed.
  expect(
    gitIdentityNote(
      signedIn({ state: "set", fields: ["user.email"], identity }) as LoginView,
      messages("en"),
    ),
  ).toEqual({ set: true, message: messages("en").toolsGitIdentityCompleted });
  // A partial write is read exactly and is "not set" for people.
  const partial = signedIn({
    state: "set",
    fields: ["user.name"],
    identity,
    incomplete: { reason: "write-failed", missing: ["user.email"] },
  });
  expect(partial).toMatchObject({
    gitIdentity: {
      fields: ["user.name"],
      incomplete: { reason: "write-failed", missing: ["user.email"] },
    },
  });
  expect(gitIdentityNote(partial as LoginView, messages("en"))).toEqual({
    set: false,
    message: messages("en").toolsGitIdentityNotSet,
  });
  // Present needs no word, and neither does a sign-in without the step.
  expect(
    gitIdentityNote(
      signedIn({ state: "present" }) as LoginView,
      messages("en"),
    ),
  ).toBeNull();
  expect(
    gitIdentityNote(signedIn(undefined) as LoginView, messages("en")),
  ).toBeNull();
  for (const gitIdentity of [
    { state: "set", fields: ["user.signingkey"], identity },
    { state: "set", fields: ["user.name"] },
    { state: "set", fields: [], identity },
    {
      state: "set",
      fields: ["user.name"],
      identity,
      incomplete: { reason: "secret", missing: ["user.email"] },
    },
    {
      state: "set",
      fields: ["user.name"],
      identity,
      incomplete: { reason: "write-failed", missing: [] },
    },
    { state: "not-set", reason: "secret" },
    { state: "not-set", reason: "write-failed", missing: "user.name" },
    { state: "maybe" },
    "set",
  ])
    expect(signedIn(gitIdentity)).toBeNull();
});

test("the SSH outcome of a gh sign-in is read only in its exact form and becomes plain sentences", () => {
  const fingerprint = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
  const key = { path: "/home/o/.ssh/id_ed25519", fingerprint, created: true };
  const linked = parseLoginState({
    kind: "signed-in",
    tool: "gh",
    account: "octocat",
    ssh: { state: "linked", key, registration: "added", knownHosts: "added" },
  });
  expect(linked).toMatchObject({ ssh: { state: "linked", key } });
  const notLinked = parseLoginState({
    kind: "signed-in",
    tool: "gh",
    account: "octocat",
    ssh: {
      state: "not-linked",
      reason: "proof-other-account",
      key: { ...key, created: false },
      provedAs: "someone-else",
      fallback: "agent",
    },
  });
  expect(notLinked).toMatchObject({
    ssh: { state: "not-linked", provedAs: "someone-else" },
  });
  for (const ssh of [
    { state: "linked", key, registration: "added" },
    {
      state: "linked",
      key: { ...key, fingerprint: "MD5:aa" },
      registration: "added",
      knownHosts: "added",
    },
    { state: "not-linked", reason: "secret", fallback: "agent" },
    { state: "not-linked", reason: "proof-failed" },
    { state: "maybe" },
  ])
    expect(
      parseLoginState({ kind: "signed-in", tool: "gh", account: "o", ssh }),
    ).toBeNull();
  expect(
    parseLoginState({
      kind: "pending",
      tool: "gh",
      session: handle,
      expiresAt: "x",
      step: "ssh-key",
    }),
  ).toMatchObject({ step: "ssh-key" });
  expect(
    parseLoginState({
      kind: "pending",
      tool: "gh",
      session: handle,
      expiresAt: "x",
      step: "other",
    }),
  ).toBeNull();
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    expect(sshOutcome(linked as NonNullable<typeof linked>, copy)).toEqual({
      linked: true,
      message: copy.toolsSshLinkedDone.replace("{account}", "octocat"),
      detail: copy.toolsSshKeyCreated
        .replace("{path}", key.path)
        .replace("{fingerprint}", fingerprint),
    });
    expect(
      sshOutcome(notLinked as NonNullable<typeof notLinked>, copy),
    ).toEqual({
      linked: false,
      message: copy.toolsSshNotLinkedDone.replace("{account}", "octocat"),
      detail: copy.toolsSshFailureProofOtherAccount.replace(
        "{account}",
        "someone-else",
      ),
    });
    expect(
      sshOutcome({ kind: "signed-in", tool: "composio" }, copy),
    ).toBeNull();
    // A gh sign-in that says nothing of the key is not a plain success:
    // not linked, as far as this Launchpad knows (Pablo's review of #524).
    expect(
      sshOutcome({ kind: "signed-in", tool: "gh", account: "octocat" }, copy),
    ).toEqual({
      linked: false,
      message: copy.toolsSshNotLinkedDone.replace("{account}", "octocat"),
      detail: copy.toolsSshFailureUnverified,
    });
    expect(
      loginEndMessage(
        { kind: "failed", tool: "gh", reason: "not-signed-in" },
        copy,
      ),
    ).toEqual({
      message: copy.toolsLoginFailureNotSignedIn,
      agent: false,
      retry: true,
    });
    // Sign-out says what happened to the key on the account; its
    // fingerprint is for the Details (Matěj 2026-10-09).
    const out = (sshKey: unknown) =>
      logoutOutcome(
        { kind: "logged-out", revocation: "local-only", sshKey },
        "gh",
        copy,
      );
    const local = copy.toolsSignedOutLocal.replace("{name}", "gh");
    const printed = copy.toolsSshKeyFingerprint.replace(
      "{fingerprint}",
      fingerprint,
    );
    expect(out({ state: "removed", fingerprint })).toMatchObject({
      message: `${local} ${copy.toolsSshRemoved}`,
      detail: printed,
    });
    expect(out({ state: "kept-not-lazurio", fingerprint })).toMatchObject({
      message: `${local} ${copy.toolsSshRemovalKept}`,
      detail: printed,
    });
    expect(out({ state: "not-removed", reason: "scope-missing" })).toEqual({
      kind: "updated",
      reload: false,
      message: `${local} ${copy.toolsSshRemovalFailed}`,
    });
    expect(out({ state: "no-key" }).message).toBe(
      `${local} ${copy.toolsSshRemovalNoKey}`,
    );
    expect(out({ state: "<b>" }).message).toBe(
      `${local} ${copy.toolsSshRemovalFailed}`,
    );
  }
});

test("install, login end, organizations and logout answers become one sentence each", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    expect(
      installOutcome(
        {
          kind: "installed",
          tool: "gh",
          version: "2.101.0",
          path: "/h/.local/bin/gh",
          onPath: false,
        },
        "gh",
        copy,
      ),
    ).toEqual({
      ok: true,
      agent: false,
      message: copy.toolsInstalledNow
        .replace("{name}", "gh")
        .replace("{version}", "2.101.0"),
      // Where agents look for tools is for the Details (Matěj 2026-10-09).
      detail: copy.toolsInstallNotOnPath,
    });
    expect(installOutcome({ kind: "already-installed" }, "gh", copy).ok).toBe(
      true,
    );
    expect(
      installOutcome(
        {
          kind: "install-failed",
          stage: "checksum",
          reason: "checksum-mismatch",
          fallback: "agent",
        },
        "gh",
        copy,
      ),
    ).toEqual({
      ok: false,
      agent: true,
      message: copy.toolsInstallFailed,
      detail: copy.toolsInstallFailedDetail
        .replace("{stage}", "checksum")
        .replace("{reason}", "checksum-mismatch"),
    });
    expect(
      installOutcome(
        { kind: "unsupported-platform", platform: "win32", arch: "x64" },
        "gh",
        copy,
      ),
    ).toEqual({
      ok: false,
      agent: true,
      message: copy.toolsInstallUnsupported,
      detail: copy.toolsInstallUnsupportedDetail
        .replace("{platform}", "win32")
        .replace("{arch}", "x64"),
    });
    expect(
      installOutcome({ kind: "blocked", reason: "busy" }, "gh", copy),
    ).toEqual({
      ok: false,
      agent: false,
      message: copy.toolsInstallBusy,
    });
    expect(installOutcome("<html>", "gh", copy).message).toBe(
      copy.toolsLoginUnreadable,
    );
    expect(
      loginEndMessage(
        { kind: "failed", tool: "gh", reason: "unexpected-url" },
        copy,
      ),
    ).toEqual({ message: copy.toolsLoginFailureUrl, agent: true, retry: true });
    expect(
      loginEndMessage(
        { kind: "failed", tool: "wacli", reason: "invalid-phone" },
        copy,
      ).agent,
    ).toBe(false);
    expect(loginEndMessage({ kind: "expired", tool: "gh" }, copy).message).toBe(
      copy.toolsLoginExpired,
    );
    expect(
      signedInMessage(
        {
          kind: "signed-in",
          tool: "composio",
          account: "a@b.c",
          organization: "Org",
        },
        copy,
      ),
    ).toBe(
      copy.toolsLoginSignedInAs
        .replace("{name}", "composio")
        .replace("{account}", "a@b.c (Org)"),
    );
    // The select names the organizations; the current one is its value.
    expect(
      organizationChoices({
        kind: "composio-organizations",
        organizations: [
          { id: "org_1", name: "First", current: true },
          { id: "org_2", name: "Second", current: false },
        ],
      }),
    ).toEqual([
      { id: "org_1", label: "First", current: true },
      { id: "org_2", label: "Second", current: false },
    ]);
    expect(
      organizationChoices({
        kind: "composio-organizations",
        organizations: [{ id: "a b", name: "x", current: true }],
      }),
    ).toBeNull();
    expect(
      logoutOutcome(
        { kind: "logged-out", revocation: "local-only" },
        "gh",
        copy,
      ).message,
    ).toBe(copy.toolsSignedOutLocal.replace("{name}", "gh"));
    expect(
      logoutOutcome({ kind: "logged-out", revocation: "remote" }, "wacli", copy)
        .message,
    ).toBe(copy.toolsSignedOutRemote.replace("{name}", "wacli"));
    expect(
      logoutOutcome({ kind: "logout-failed", reason: "tool-exit" }, "gh", copy),
    ).toEqual({
      kind: "failed",
      reload: false,
      message: copy.toolsSignOutFailed.replace("{name}", "gh"),
      detail: copy.toolsSignOutFailedDetail.replace("{reason}", "tool-exit"),
    });
  }
});

// The end-to-end test of 2026-10-19: "Odpojit" on Composio's card said
// "composio: odhlášeno v tomto Prostředí. Poskytovatel přihlášení eviduje…".
// The sentence stands on the tool's own card, so it names no tool id, and
// it says in plain words what happened, for every tool alike.
test("a sign-out says what happened in the person's words, without the tool's id", () => {
  const answers = [
    [{ kind: "logged-out", revocation: "local-only" }, "composio"],
    [{ kind: "logged-out", revocation: "local-only" }, "gh"],
    [{ kind: "logged-out", revocation: "remote" }, "wacli"],
    [{ kind: "logout-failed", reason: "tool-exit" }, "gh"],
  ] as const;
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale);
    for (const [answer, name] of answers) {
      const { message } = logoutOutcome(answer, name, copy);
      expect(message).not.toContain(name);
      expect(message).not.toContain("{");
      expect(message.charAt(0)).toBe(message.charAt(0).toUpperCase());
    }
  }
  expect(
    logoutOutcome(
      { kind: "logged-out", revocation: "local-only" },
      "composio",
      messages("cs"),
    ).message,
  ).toBe(
    "Odpojeno v tomto Prostředí. Ve vašem účtu u poskytovatele zůstane přístup povolený, dokud ho tam nezrušíte.",
  );
  expect(
    logoutOutcome(
      { kind: "logged-out", revocation: "local-only" },
      "composio",
      messages("en"),
    ).message,
  ).toBe(
    "Disconnected in this Environment. Your account with the provider keeps the access allowed until you remove it there.",
  );
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

test("the sign-in of gh may carry its SSH state, only in its exact form", () => {
  const gh = (ssh: unknown) =>
    parseToolsOverview({
      ...overview([
        tool({
          name: "gh",
          command: "gh",
          tier: "required",
          enabled: true,
          installed: true,
        }),
      ]),
      tools: [
        {
          ...tool({
            name: "gh",
            command: "gh",
            tier: "required",
            enabled: true,
            installed: true,
          }),
          signIn: { state: "signed-in", account: "octo", ssh },
        },
      ],
    });
  expect(
    gh({
      state: "linked",
      fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    })?.tools[0]?.signIn?.ssh,
  ).toEqual({
    state: "linked",
    fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  });
  expect(
    gh({ state: "not-linked", reason: "no-key" })?.tools[0]?.signIn?.ssh,
  ).toEqual({ state: "not-linked", reason: "no-key" });
  for (const bad of [
    "linked",
    { state: "linked", fingerprint: "ssh-ed25519 AAAA" },
    { state: "not-linked", reason: "other" },
    { state: "maybe" },
  ])
    expect(gh(bad)).toBeNull();
});

test("a starting sign-in never shows the same sentence as status and detail; no challenge in time ends with what to do", () => {
  const pending = {
    kind: "pending",
    tool: "wacli",
    session: "0".repeat(32),
    expiresAt: "2026-09-29T12:00:00.000Z",
  } as const;
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    // Before the first answer and while the tool shows nothing to act on.
    for (const state of [null, pending]) {
      const progress = loginProgress(state, copy);
      expect(progress.status).toBe(copy.toolsLoginStarting);
      expect(progress.detail).toBe(copy.toolsLoginStartingDetail);
      expect(progress.detail).not.toBe(progress.status);
    }
    expect(
      loginProgress(
        { ...pending, challenge: { kind: "qr", payload: "x", sequence: 1 } },
        copy,
      ),
    ).toEqual({ status: copy.toolsLoginWaiting, detail: null });
    const failed = parseLoginState({
      kind: "failed",
      tool: "wacli",
      reason: "no-challenge",
    });
    expect(failed).toEqual({
      kind: "failed",
      tool: "wacli",
      reason: "no-challenge",
    });
    expect(loginEndMessage(failed as NonNullable<typeof failed>, copy)).toEqual(
      { message: copy.toolsLoginFailureNoChallenge, agent: true, retry: true },
    );
    // Every end of a sign-in that did not start, ended early or showed
    // nothing says what to do next, distinct from the starting sentence.
    for (const key of [
      "toolsLoginFailureNotInstalled",
      "toolsLoginFailureSpawn",
      "toolsLoginFailureExit",
      "toolsLoginFailureNoChallenge",
      "toolsLoginNoAnswer",
    ] as const) {
      expect(copy[key].split(". ").length).toBeGreaterThan(1);
      expect(copy[key]).not.toBe(copy.toolsLoginStarting);
    }
  }
});

test("a dialog request that never settles is not answered within its bound", async () => {
  expect(
    await answerWithin(Promise.resolve({ value: { kind: "none" } }), 1_000),
  ).toEqual({ answered: true, value: { kind: "none" } });
  expect(await answerWithin(Promise.reject(new Error("x")), 1_000)).toEqual({
    answered: true,
    value: null,
  });
  const began = Date.now();
  expect(await answerWithin(new Promise(() => undefined), 50)).toEqual({
    answered: false,
  });
  expect(Date.now() - began).toBeLessThan(1_000);
});

test("a tool signed in before the sign-in says so, in both languages", () => {
  const already = parseLoginState({
    kind: "signed-in",
    tool: "wacli",
    account: "420000000000",
    already: true,
  });
  expect(already).toEqual({
    kind: "signed-in",
    tool: "wacli",
    account: "420000000000",
    already: true,
  });
  expect(
    parseLoginState({ kind: "signed-in", tool: "wacli", already: "yes" }),
  ).toBeNull();
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    expect(signedInMessage(already as NonNullable<typeof already>, copy)).toBe(
      copy.toolsLoginAlreadySignedInAs
        .replace("{name}", "wacli")
        .replace("{account}", "420000000000"),
    );
    expect(
      signedInMessage(
        { kind: "signed-in", tool: "wacli", already: true },
        copy,
      ),
    ).toBe(copy.toolsLoginAlreadySignedIn.replace("{name}", "wacli"));
    expect(copy.toolsLoginAlreadySignedIn).not.toBe(copy.toolsLoginSignedIn);
  }
});

// What the guide of Nástroje's "?" can point at (decision F56's addendum (2)
// of 2026-10-18; Pablo's review of #503): a sign-in or a connection someone
// made, and a switch the person can move; nothing where there is none, so
// the guide leaves those steps out.
test("the guide's targets on connecting and on the switch are only what a person can use there", () => {
  const en = messages("en");
  const signedIn = {
    installed: true,
    signIn: { state: "signed-in", account: "a@example.com" },
  } as const;
  const gh = tool({ name: "gh", command: "gh", tier: "required", ...signedIn });
  const targets = (tools: readonly ToolOverview[], brokered = false) =>
    toolGuideTargets(toolGroups(tools, en), en, brokered);
  // A sign-in to make: its button, and the first switch.
  expect(
    targets([
      gh,
      tool({ installed: true }),
      tool({ name: "wacli", command: "wacli", tier: "optional" }),
    ]),
  ).toEqual({
    connect: { tool: "composio", part: "action" },
    agents: { tool: "composio" },
  });
  // Adding and connecting counts too.
  expect(targets([tool()]).connect).toEqual({
    tool: "composio",
    part: "action",
  });
  // Everything connected: the first connection made, as its line says it.
  expect(
    targets([
      gh,
      tool(signedIn),
      tool({ name: "wacli", command: "wacli", tier: "optional", ...signedIn }),
    ]),
  ).toEqual({
    connect: { tool: "gh", part: "state" },
    agents: { tool: "composio" },
  });
  // A Team Environment: gh works as the Organization's identity and signs
  // nobody in; a team account connected here is the connection.
  expect(targets([gh, tool(signedIn)], true)).toEqual({
    connect: { tool: "composio", part: "state" },
    agents: { tool: "composio" },
  });
  // A Team Environment with gh alone: nothing to connect, no switch.
  expect(targets([gh], true)).toEqual({ connect: null, agents: null });
  // gh missing on a Team Environment is installed only, never signed in.
  expect(
    targets([tool({ name: "gh", command: "gh", tier: "required" })], true),
  ).toEqual({ connect: null, agents: null });
  // A tool the Organization does not allow: neither connected nor switched
  // here.
  expect(
    targets([tool({ ...signedIn, organization: { allowed: false } })]),
  ).toEqual({ connect: null, agents: null });
  // The vault's and Executor's rows, an agent's tool and a tool not offered
  // here are none of a person's sign-ins.
  expect(
    targets([
      tool({ name: "bitwarden", command: "bw", installed: true }),
      tool({ name: "executor", command: "executor", tier: "required" }),
      tool({ name: "neon", command: "neon", setup: "agent" }),
      tool({ name: "wacli", command: "wacli", offered: false }),
    ]).connect,
  ).toBeNull();
  expect(targets([])).toEqual({ connect: null, agents: null });
});

// #515 (F19's addendum of 2026-10-19): Nástroje never draws gh connected in
// the success colour while this Environment does not reach GitHub over SSH
// as its account, and it names a key it could not verify.
test("Nástroje: gh connected but SSH not working is not drawn as connected, and an unverified key is named", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const gh = (state: "linked" | "not-linked" | "unknown", brokered = false) =>
      connectionLine(
        tool({
          name: "gh",
          command: "gh",
          tier: "required",
          installed: true,
          signIn: { state: "signed-in", account: "octo", ssh: { state } },
        }),
        copy,
        brokered,
      );
    const who = copy.toolsSignedInAs.replace("{account}", "octo");
    // Only a working link is "signed-in", the success colour of the line.
    expect(gh("linked")).toEqual({ text: who, state: "signed-in", ssh: null });
    expect(gh("not-linked")).toEqual({
      text: who,
      state: "incomplete",
      ssh: copy.toolsSshNotLinked,
    });
    expect(gh("unknown")).toEqual({
      text: who,
      state: "unverified",
      ssh: copy.toolsSshUnknown,
    });
    // A Team Environment works through Lazurio for GitHub: its line names
    // that, never a person's key.
    expect(gh("not-linked", true).ssh).toBe(copy.toolsSshTeam);
    // A signed-in gh whose status has no SSH part (its shape allows that) is
    // not known to work either: never the success colour (Pablo's review of
    // #524). A Team Environment's and another tool's line stay as they are.
    const withoutSsh = (name: string, brokered = false) =>
      connectionLine(
        tool({
          name,
          command: name,
          installed: true,
          signIn: { state: "signed-in", account: "octo" },
        }),
        copy,
        brokered,
      );
    expect(withoutSsh("gh")).toEqual({
      text: who,
      state: "unverified",
      ssh: copy.toolsSshUnknown,
    });
    expect(withoutSsh("gh", true)).toMatchObject({
      state: "signed-in",
      ssh: null,
    });
    expect(withoutSsh("composio")).toMatchObject({
      state: "signed-in",
      ssh: null,
    });
  }
  expect(messages("cs").toolsSshNotLinked).toBe("SSH klíč nepropojený");
  expect(messages("cs").toolsSshUnknown).toBe("SSH klíč neověřený");
});

// #515: Začínáme, the line in Apps and a start request open GitHub's
// sign-in by `signInMode`: for a signed-in gh whose SSH does not work here
// that is its SSH link.
test("opening a tool's sign-in from outside its row: its flow, or the SSH link of a signed-in gh", () => {
  const copy = messages("cs");
  const gh = (signIn?: ToolOverview["signIn"], installed = true) =>
    tool({
      name: "gh",
      command: "gh",
      tier: "required",
      installed,
      ...(signIn === undefined ? {} : { signIn }),
    });
  expect(signInMode(gh(undefined, false), copy)).toBe("install");
  expect(signInMode(gh({ state: "signed-out" }), copy)).toBe("login");
  expect(
    signInMode(
      gh({ state: "signed-in", account: "o", ssh: { state: "not-linked" } }),
      copy,
    ),
  ).toBe("ssh");
  expect(
    signInMode(
      gh({ state: "signed-in", account: "o", ssh: { state: "linked" } }),
      copy,
    ),
  ).toBeNull();
  // Without an SSH part it is not known to work: its SSH link (Pablo's
  // review of #524).
  expect(signInMode(gh({ state: "signed-in", account: "o" }), copy)).toBe(
    "ssh",
  );
  // A Team Environment's gh is never signed in from here.
  expect(signInMode(gh(undefined, false), copy, true)).toBeNull();
  expect(signInMode(gh({ state: "signed-out" }), copy, true)).toBeNull();
  expect(signInMode(tool({ installed: true }), copy)).toBe("login");
});

// #516 (F19's addendum of 2026-10-19): closing the shared sign-in dialog (its
// ×, Escape) never ends a sign-in that runs; it detaches it. Only "Zrušit"
// cancels, offered only while a code, link or QR code waits for the person.
test("closing the sign-in dialog detaches a running sign-in and ends nothing; Zrušit only while a code waits", () => {
  expect(loginCloseAction("waiting")).toBe("detach");
  expect(loginCloseAction("linking")).toBe("detach");
  for (const phase of ["confirm", "installing", "signed-in", "failed"] as const)
    expect([phase, loginCloseAction(phase)]).toEqual([phase, "close"]);
  expect(loginCancelOffered({ phase: "waiting", challenge: true })).toBe(true);
  // Starting, before the code: nothing to cancel yet; the SSH key's steps
  // after the code: no cancel at all.
  expect(loginCancelOffered({ phase: "waiting", challenge: false })).toBe(
    false,
  );
  for (const phase of [
    "confirm",
    "installing",
    "linking",
    "signed-in",
    "failed",
  ] as const)
    expect(loginCancelOffered({ phase, challenge: true })).toBe(false);
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    // While the sign-in finishes, the dialog never says it is connected: it
    // says it finishes, and that the window may be closed.
    const linking = loginProgress(
      {
        kind: "pending",
        tool: "gh",
        session: "0".repeat(32),
        expiresAt: "2026-10-19T12:00:00.000Z",
        step: "ssh-key",
      },
      copy,
    );
    expect(linking).toEqual({
      status: copy.toolsLoginLinking,
      detail: copy.toolsLoginFinishingDetail,
    });
    expect(linking.status).not.toMatch(/Připojeno|Connected/);
  }
  expect(messages("cs").toolsLoginLinking).toBe("Dokončuji připojení…");
  expect(messages("cs").toolsLoginFinishingDetail).toBe(
    "Okno můžete zavřít, Lazurio připojení dokončí samo.",
  );
  expect(messages("cs").toolsLoginCancel).toBe("Zrušit");
  expect(messages("en").toolsLoginCancel).toBe("Cancel");
});

// #516: a poll that gets no answer ends nothing; the page asks again until
// the session's own end has surely passed. Začínáme sees a sign-in the page
// runs as waiting for the person or finishing.
test("a missed poll ends nothing until the session's own end has passed; a running sign-in waits or finishes", () => {
  const end = Date.parse("2026-10-19T12:15:00.000Z");
  expect(loginPollGivenUp(end, end - 1_000)).toBe(false);
  expect(loginPollGivenUp(end, end + loginPollGraceMs)).toBe(false);
  expect(loginPollGivenUp(end, end + loginPollGraceMs + 1)).toBe(true);
  expect(loginPollGivenUp(null, end + 3_600_000)).toBe(false);
  expect(loginFlowState("waiting")).toBe("waiting");
  expect(loginFlowState("linking")).toBe("finishing");
  for (const phase of ["confirm", "installing", "signed-in", "failed"] as const)
    expect(loginFlowState(phase)).toBeNull();
});

// #516, the Integrace thread's note: a session answers its end only once, so
// the sign-in the dialog holds has one poll loop across its window hiding
// and showing again. Showing it again while a poll is under way starts no
// second one; that poll's answer, the end included, comes once.
test("one poll loop per sign-in: showing it again while a poll is under way asks once, and its end comes once", async () => {
  const timers: { action: () => void; ms: number }[] = [];
  const asked: ((value: unknown) => void)[] = [];
  const answers: unknown[] = [];
  const loop = createLoginPoll({
    ask: () =>
      new Promise((resolve) =>
        asked.push((value) => resolve({ answered: true, value })),
      ),
    answered: (answer) =>
      answers.push(answer.answered ? answer.value : "no answer"),
    setTimer: (action, ms) => {
      const timer = { action, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index !== -1) timers.splice(index, 1);
    },
  });
  const fire = () => timers.shift()?.action();
  // The first poll after the interval; a second schedule plans nothing more.
  loop.schedule();
  loop.schedule();
  expect(timers.map((timer) => timer.ms)).toEqual([2_000]);
  fire();
  expect(asked).toHaveLength(1);
  // The window hides and shows again while that poll is under way: no
  // second poll.
  loop.now();
  loop.schedule();
  expect(timers).toEqual([]);
  expect(asked).toHaveLength(1);
  // Its answer, the end, comes once.
  asked[0]?.({ kind: "signed-in", tool: "gh" });
  await Bun.sleep(0);
  expect(answers).toEqual([{ kind: "signed-in", tool: "gh" }]);
  // Showing it again between polls asks at once, in place of the planned one.
  loop.schedule();
  loop.now();
  expect(timers.map((timer) => timer.ms)).toEqual([0]);
  fire();
  expect(asked).toHaveLength(2);
  // Stopped (a new start, Zrušit, the end): an answer under way counts for
  // nothing, and nothing is planned again.
  loop.stop();
  asked[1]?.({ kind: "none", tool: "gh" });
  await Bun.sleep(0);
  expect(answers).toHaveLength(1);
  loop.schedule();
  loop.now();
  expect(timers).toEqual([]);
  // A failed request is no answer, which the dialog asks again after.
  const failing = createLoginPoll({
    ask: () => Promise.reject(new Error("offline")),
    answered: (answer) => answers.push(answer.answered ? "answer" : "none"),
    setTimer: (action) => {
      action();
      return null;
    },
    clearTimer: () => undefined,
  });
  failing.schedule();
  await Bun.sleep(0);
  expect(answers.at(-1)).toBe("none");
});
