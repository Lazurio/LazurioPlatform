import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  answerWithin,
  curatedActions,
  currentNotes,
  installOutcome,
  loginEndMessage,
  loginLink,
  loginProgress,
  loginStepOrder,
  loginSteps,
  logoutOutcome,
  nextNotes,
  nextSelection,
  noteDraftView,
  organizationChoices,
  parseLoginState,
  parseToolsOverview,
  qrImageSource,
  signedInMessage,
  signInLine,
  sourceLink,
  sshOutcome,
  takesNote,
  toolChangeOutcome,
  toolGroups,
  toolStatusView,
} from "../src/launchpad/tools-view";
import type { ToolOverview, ToolsOverview } from "../src/tools/overview";
import { qrMatrix, qrSvg } from "../src/tools/qr";

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
    tool = "composio",
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
    // Sign-out says what happened to the key on the account.
    const out = (sshKey: unknown) =>
      logoutOutcome(
        { kind: "logged-out", revocation: "local-only", sshKey },
        "gh",
        copy,
      ).message;
    const local = copy.toolsSignedOutLocal.replace("{name}", "gh");
    expect(out({ state: "removed", fingerprint })).toBe(
      `${local} ${copy.toolsSshRemoved.replace("{fingerprint}", fingerprint)}`,
    );
    expect(out({ state: "kept-not-lazurio", fingerprint })).toBe(
      `${local} ${copy.toolsSshRemovalKept.replace("{fingerprint}", fingerprint)}`,
    );
    expect(out({ state: "not-removed", reason: "scope-missing" })).toBe(
      `${local} ${copy.toolsSshRemovalFailed}`,
    );
    expect(out({ state: "no-key" })).toBe(
      `${local} ${copy.toolsSshRemovalNoKey}`,
    );
    expect(out({ state: "<b>" })).toBe(
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
      message: `${copy.toolsInstalledNow.replace("{name}", "gh").replace("{version}", "2.101.0")} ${copy.toolsInstallNotOnPath}`,
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
      message: copy.toolsInstallFailed
        .replace("{stage}", "checksum")
        .replace("{reason}", "checksum-mismatch"),
    });
    expect(
      installOutcome(
        { kind: "unsupported-platform", platform: "win32", arch: "x64" },
        "gh",
        copy,
      ).agent,
    ).toBe(true);
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
    expect(
      organizationChoices(
        {
          kind: "composio-organizations",
          organizations: [
            { id: "org_1", name: "First", current: true },
            { id: "org_2", name: "Second", current: false },
          ],
        },
        copy,
      ),
    ).toEqual([
      {
        id: "org_1",
        label: copy.toolsComposioOrgCurrent.replace("{name}", "First"),
        current: true,
      },
      { id: "org_2", label: "Second", current: false },
    ]);
    expect(
      organizationChoices(
        {
          kind: "composio-organizations",
          organizations: [{ id: "a b", name: "x", current: true }],
        },
        copy,
      ),
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
      message: copy.toolsSignOutFailed
        .replace("{name}", "gh")
        .replace("{reason}", "tool-exit"),
    });
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
