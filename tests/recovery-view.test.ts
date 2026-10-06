import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  parseRecovery,
  recoveryModeAnswer,
  recoveryModeView,
  recoveryView,
} from "../src/launchpad/recovery-view";
import { startRefusals } from "../src/launchpad/start-check";
import type { RecoveryEvidence } from "../src/recover/evidence";
import type { RecoveryResult } from "../src/recover/recover";

// The Recovery page as the browser draws it (docs/recovery.md "The Recovery
// page"), without a DOM: the reason in words, the tier-1 evidence, the
// journal only behind the operator's toggle, the two copy actions and the
// sentence that nothing was filed.

const journal = "Sep 28 10:00:00 <host> lazurio[1]: JOURNAL-LINE-CANARY";

const evidence = {
  schema: "lazurio.recovery.v1",
  detectedAt: "2026-09-28T10:00:00.000Z",
  fingerprint: "rf-0123456789ab",
  check: "folder-state",
  rule: null,
  code: "folder-state-pending",
  context: {},
  failed: ["folder-state"],
  checks: [],
  product: {
    running: {
      version: "1.0.0",
      commit: "a".repeat(40),
      target: "linux-x64",
      fixture: false,
    },
    active: null,
  },
  platform: {
    os: "linux",
    kernel: "6.8.0",
    arch: "x64",
    systemd: null,
    bun: "1.4.2",
  },
  install: {
    active: "1.0.0",
    highWater: "1.0.0",
    stateInvalid: null,
    versions: ["1.0.0"],
    supervised: false,
    legacyPrevious: false,
    legacyMarker: false,
  },
  unit: null,
  folder: null,
  lastCheck: null,
  journal,
} as unknown as RecoveryEvidence;

const broken: RecoveryResult = {
  kind: "recovery",
  verdict: "broken",
  checks: [
    {
      id: "update-state-invalid",
      rule: "R2",
      outcome: "ok",
      context: {},
    },
    {
      id: "folder-state",
      rule: null,
      outcome: "failed",
      code: "folder-state-pending",
      context: { revision: 1 },
    },
    {
      id: "launchpad-unit",
      rule: null,
      outcome: "skipped",
      reason: "no-user-manager",
    },
  ],
  evidence,
  prompt: "**Task:** Lazurio on this Machine needs a repair.",
  issue: {
    kind: "prepared",
    repository: "Lazurio/LazurioPlatform",
    title:
      "Recovery: folder-state (folder-state-pending) on linux-x64 [rf-0123456789ab]",
    body: "`lazurio recover` found the check …",
    search: ["gh", "issue", "list"],
    create: ["gh", "issue", "create"],
    shell:
      "gh issue create --repo Lazurio/LazurioPlatform <<'LAZURIO_RECOVERY_BODY'",
    link: "https://github.com/Lazurio/LazurioPlatform/issues/new?title=Recovery",
    bodyInLink: true,
  },
};

test("a refused API route names Recovery mode; nothing else does", () => {
  const answer = {
    error: "recovery-mode",
    check: "start-refused",
    reason: "folder-transaction-pending",
  };
  expect(recoveryModeAnswer(503, answer)).toEqual({
    check: "start-refused",
    reason: "folder-transaction-pending",
  });
  expect(recoveryModeAnswer(409, answer)).toBeNull();
  expect(recoveryModeAnswer(503, { error: "update-unavailable" })).toBeNull();
  expect(recoveryModeAnswer(503, { ...answer, reason: "<script>" })).toBeNull();
  expect(recoveryModeAnswer(503, null)).toBeNull();
});

test("the check and the reason by id and in words, in both languages", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    for (const reason of startRefusals) {
      const view = recoveryModeView({ check: "start-refused", reason }, copy);
      expect(view.title).toBe(copy.recoveryModeTitle);
      expect(view.rows.map((row) => row.id)).toEqual(["start-refused", reason]);
      const text = view.rows[1]?.text;
      expect(text).toBeString();
      expect(text).not.toBe(copy.recoveryReasonUnknown);
    }
  }
  expect(
    recoveryModeView(
      { check: "start-refused", reason: "from-the-future" },
      messages("en"),
    ).rows[1],
  ).toEqual({
    label: "Reason",
    id: "from-the-future",
    text: "A reason this page does not know.",
  });
  expect(
    recoveryModeView(
      { check: "start-refused", reason: "folder-transaction-pending" },
      messages("cs"),
    ).rows[1]?.text,
  ).toBe(
    "Změna profilu nebo nástrojů ve Folderu byla přerušena a není dokončená.",
  );
});

test("broken: the evidence without the journal, the prompt and the issue to copy, nothing filed", () => {
  const copy = messages("en");
  const view = recoveryView(broken, copy);
  expect(view.summary).toBe("Lazurio in this Environment needs a repair.");
  expect(view.checks).toEqual([
    {
      id: "update-state-invalid (R2)",
      outcome: "ok",
      state: "ok",
      detail: "",
    },
    {
      id: "folder-state",
      outcome: "failed",
      state: "failed",
      detail: "folder-state-pending revision=1",
    },
    {
      id: "launchpad-unit",
      outcome: "skipped",
      state: "skipped",
      detail: "no-user-manager",
    },
  ]);
  // The journal is on the page only behind the explicit toggle.
  expect(JSON.stringify(view)).not.toContain("JOURNAL-LINE-CANARY");
  expect(view.journal).toBeNull();
  expect(view.journalToggle).toBe("Show journal (stays in this Environment)");
  expect(JSON.parse(view.evidence ?? "{}")).toMatchObject({
    fingerprint: "rf-0123456789ab",
  });
  expect(view.evidence).not.toContain('"journal"');
  // The two copy actions, with their texts.
  expect(view.actions).toEqual([
    { control: "copy-prompt", label: "Copy the prompt" },
    { control: "copy-gh", label: "Copy the gh command" },
  ]);
  expect(view.prompt).toBe(broken.prompt);
  expect(view.issue).toEqual({
    kind: "prepared",
    text: "For the public repository Lazurio/LazurioPlatform. The repair agent files it after a search for a duplicate.",
    title: broken.issue?.kind === "prepared" ? broken.issue.title : "",
    body: "`lazurio recover` found the check …",
    command:
      "gh issue create --repo Lazurio/LazurioPlatform <<'LAZURIO_RECOVERY_BODY'",
    link: "https://github.com/Lazurio/LazurioPlatform/issues/new?title=Recovery",
    linkLabel: "Open the prefilled issue in the browser",
  });
  expect(view.nothingFiled).toBe(
    "Nothing was filed. This page only prepares the issue; nothing leaves this Environment automatically.",
  );

  const shown = recoveryView(broken, copy, { journal: true });
  expect(shown.journal).toBe(journal);
  expect(shown.journalToggle).toBe("Hide journal");
  expect(shown.evidence).toBe(view.evidence);
  // A workstation (no recorded entry): no T3 Code link.
  expect(view.chat).toBeNull();
});

test("hosted: the prompt comes with the recorded T3 Code origin as a plain link; never without a prompt", () => {
  const t3codeOrigin = "https://t3code.workspace.example.lazurio.io";
  const hosted = recoveryView(broken, messages("en"), {
    journal: false,
    t3codeOrigin,
  });
  expect(hosted.chat).toEqual({ href: t3codeOrigin, label: "Open T3 Code" });
  // The link is the recorded origin as given: nothing appended or composed.
  expect(
    recoveryView(broken, messages("cs"), { journal: false, t3codeOrigin }).chat,
  ).toEqual({ href: t3codeOrigin, label: "Otevřít T3 Code" });
  // Nothing to hand over, no link.
  expect(
    recoveryView({ ...broken, prompt: null }, messages("en"), {
      journal: false,
      t3codeOrigin,
    }).chat,
  ).toBeNull();
  expect(
    recoveryView(broken, messages("en"), { journal: false, t3codeOrigin: null })
      .chat,
  ).toBeNull();
});

test("a refused issue names the kinds only, and offers no gh command", () => {
  const view = recoveryView(
    {
      ...broken,
      issue: {
        kind: "refused",
        repository: "Lazurio/LazurioPlatform",
        found: ["organization", "ip-address"],
      },
    },
    messages("en"),
  );
  expect(view.issue).toEqual({
    kind: "refused",
    text: "No issue body was prepared: after sanitization it still contained organization, ip-address. Nothing may leave this Environment automatically.",
  });
  expect(view.actions).toEqual([
    { control: "copy-prompt", label: "Copy the prompt" },
  ]);
  expect(view.nothingFiled).not.toBeNull();
});

test("healthy: the checks, and nothing to copy or file", () => {
  const healthy: RecoveryResult = {
    kind: "recovery",
    verdict: "healthy",
    checks: [
      {
        id: "launchpad-health",
        rule: null,
        outcome: "ok",
        context: { version: "1.0.0" },
      },
    ],
    evidence: null,
    prompt: null,
    issue: null,
  };
  const view = recoveryView(healthy, messages("cs"));
  expect(view).toEqual({
    verdict: "healthy",
    summary: "Lazurio na tomhle Environmentu je v pořádku.",
    checks: [
      {
        id: "launchpad-health",
        outcome: "ok",
        state: "v pořádku",
        detail: "version=1.0.0",
      },
    ],
    evidence: null,
    journalToggle: null,
    journal: null,
    prompt: null,
    chat: null,
    issue: null,
    nothingFiled: null,
    actions: [],
  });
  expect(parseRecovery(healthy)).toBe(healthy);
  expect(
    parseRecovery({ kind: "recovery", verdict: "maybe", checks: [] }),
  ).toBeNull();
  expect(parseRecovery({ error: "recovery-unavailable" })).toBeNull();
});
