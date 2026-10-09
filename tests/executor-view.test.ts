import { expect, test } from "bun:test";
import type { ExecutorStatus } from "../src/executor/flow";
import {
  executorAction,
  executorFacts,
  executorRowLine,
  parseExecutorSettingUp,
  parseExecutorStatus,
} from "../src/launchpad/executor-view";
import { messages } from "../src/launchpad/messages";
import { toolGroups } from "../src/launchpad/tools-view";
import type { ToolOverview } from "../src/tools/overview";

// Executor's row on the tools screen (decision F44): the server's answer only
// in its exact form, one plain line and one action per state, and the
// technical facts only in Details.

const running: ExecutorStatus = {
  kind: "executor-status",
  state: "running",
  version: "1.6.10",
  installed: "1.6.10",
  address: "127.0.0.1:4789",
  entry: "lazurio",
  service: "running",
  settings: "current",
  answering: true,
  linger: "yes",
  agents: { codex: "registered", claude: "absent" },
};

test("the status is accepted only in its exact form", () => {
  expect(parseExecutorStatus(running)).toEqual(running);
  const failed = {
    ...running,
    state: "not-running",
    answering: false,
    failure: { stage: "service", reason: "health-not-answering" },
  };
  expect(parseExecutorStatus(failed)).toEqual(failed as ExecutorStatus);
  expect(
    parseExecutorStatus({
      kind: "executor-status",
      state: "unsupported",
      reason: "workstation",
    }),
  ).toEqual({
    kind: "executor-status",
    state: "unsupported",
    reason: "workstation",
  });
  for (const broken of [
    null,
    "running",
    { ...running, kind: "vault-status" },
    { ...running, state: "fine" },
    { ...running, address: "0.0.0.0:4789" },
    { ...running, version: "latest" },
    { ...running, installed: "<script>" },
    { ...running, service: "maybe" },
    { ...running, agents: { codex: "registered" } },
    { ...running, agents: { codex: "registered", claude: "admin" } },
    { ...running, failure: { stage: "service", reason: "Has Spaces" } },
    { ...running, failure: { stage: "elsewhere", reason: "x" } },
    { kind: "executor-status", state: "unsupported", reason: "other" },
  ])
    expect(parseExecutorStatus(broken)).toBeNull();
  expect(
    parseExecutorSettingUp({
      kind: "executor-setting-up",
      job: "a".repeat(32),
      phase: "service",
    }),
  ).toEqual({ job: "a".repeat(32), phase: "service" });
  for (const broken of [
    { kind: "executor-setting-up", job: "x", phase: "service" },
    { kind: "executor-setting-up", job: "a".repeat(32), phase: "reboot" },
    { kind: "vault-connecting", job: "a".repeat(32), phase: "install" },
  ])
    expect(parseExecutorSettingUp(broken)).toBeNull();
});

test("one plain line and at most one action per state, in both languages", () => {
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale);
    const of = (status: ExecutorStatus | null) => ({
      line: executorRowLine(status, null, copy),
      action: executorAction(status, copy),
    });
    expect(of(null)).toEqual({
      line: { text: copy.executorRowChecking, state: "unknown" },
      action: null,
    });
    expect(of(running)).toEqual({
      line: { text: copy.executorRowRunning, state: "signed-in" },
      action: null,
    });
    const cases: readonly [
      ExecutorStatus,
      string,
      { kind: "setup" | "agent"; label: string } | null,
    ][] = [
      [
        { ...running, state: "not-installed", installed: null },
        copy.executorRowNotInstalled,
        { kind: "setup", label: copy.executorActionInstall },
      ],
      [
        { ...running, state: "outdated", installed: "1.6.9" },
        copy.executorRowOutdated,
        { kind: "setup", label: copy.executorActionUpdate },
      ],
      [
        { ...running, state: "not-running", answering: false },
        copy.executorRowNotRunning,
        { kind: "setup", label: copy.executorActionRepair },
      ],
      [
        { ...running, state: "incomplete", settings: "missing" },
        copy.executorRowIncomplete,
        { kind: "setup", label: copy.executorActionRepair },
      ],
      [
        { ...running, state: "conflict", entry: "conflict" },
        copy.executorRowConflict,
        { kind: "agent", label: copy.executorActionResolve },
      ],
    ];
    for (const [status, text, action] of cases)
      expect(of(status)).toEqual({
        line: { text, state: "signed-out" },
        action,
      });
    // Where it is not offered: a computer is the second wave.
    expect(
      of({
        kind: "executor-status",
        state: "unsupported",
        reason: "workstation",
      }),
    ).toEqual({
      line: { text: copy.executorRowSecondWave, state: "unknown" },
      action: null,
    });
    expect(
      executorRowLine(
        {
          kind: "executor-status",
          state: "unsupported",
          reason: "not-operator",
        },
        null,
        copy,
      ).text,
    ).toBe(copy.executorRowUnavailable);
    // While a setup runs the line says its step, whatever was read before.
    expect(executorRowLine(running, "service", copy)).toEqual({
      text: copy.executorPhaseService,
      state: "unknown",
    });
  }
});

test("Details: the version, the loopback address, the service, the agents and where a setup stopped; never a path or the console", () => {
  const copy = messages("en");
  expect(executorFacts(running, copy)).toEqual([
    { label: "Version", value: "1.6.10" },
    { label: "Address", value: "127.0.0.1:4789 (this Environment only)" },
    { label: "Service", value: "running" },
    {
      label: "Agents",
      value: "Codex: connected · Claude Code: not installed",
    },
  ]);
  const stopped = executorFacts(
    {
      ...running,
      state: "not-running",
      installed: "1.6.9",
      service: "failed",
      answering: false,
      agents: { codex: "conflict", claude: "missing" },
      failure: { stage: "service", reason: "install-timeout" },
    },
    copy,
  );
  expect(stopped).toEqual([
    { label: "Version", value: "1.6.9 (Lazurio pins 1.6.10)" },
    { label: "Address", value: "127.0.0.1:4789 (this Environment only)" },
    { label: "Service", value: "failed" },
    {
      label: "Agents",
      value:
        "Codex: has another server named executor · Claude Code: not connected yet",
    },
    {
      label: "What happened",
      value: "The setup did not finish (service: install-timeout).",
    },
  ]);
  expect(
    executorFacts(
      { ...running, state: "not-installed", installed: null },
      copy,
    )[0],
  ).toEqual({
    label: "Version",
    value: "1.6.10 is installed by the next setup",
  });
  for (const fact of [...executorFacts(running, copy), ...stopped])
    expect(fact.value).not.toMatch(/\/home|\.local|_token|http:\/\//);
  expect(
    executorFacts(
      { kind: "executor-status", state: "unsupported", reason: "workstation" },
      copy,
    ),
  ).toEqual([]);
});

const tool = (overrides: Partial<ToolOverview>): ToolOverview => ({
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
  prompt: "Task.",
  ...overrides,
});

test("a tool this Environment does not offer is listed only while it is on, or when its own row says why", () => {
  const copy = messages("en");
  const names = (tools: readonly ToolOverview[]) =>
    toolGroups(tools, copy).flatMap((group) =>
      group.tools.map((entry) => entry.name),
    );
  expect(
    names([
      tool({ name: "gh", tier: "required", enabled: true }),
      // Executor and the vault on a computer: their own rows say "soon".
      tool({
        name: "executor",
        tier: "required",
        enabled: true,
        offered: false,
      }),
      tool({ name: "bitwarden", offered: false }),
      // gogcli on a work Environment: hidden, unless it is still on.
      tool({
        name: "gogcli",
        tier: "optional",
        setup: "agent",
        offered: false,
      }),
      tool({ name: "neon", tier: "optional", setup: "agent" }),
    ]),
  ).toEqual(["gh", "executor", "bitwarden", "neon"]);
  expect(
    names([
      tool({
        name: "gogcli",
        tier: "optional",
        setup: "agent",
        offered: false,
        enabled: true,
      }),
    ]),
  ).toEqual(["gogcli"]);
});
