import { expect, test } from "bun:test";
import { failed, ok, skipped } from "../src/recover/checks";
import {
  fingerprint,
  type RecoveryEvidence,
  readableJson,
} from "../src/recover/evidence";
import {
  issueBody,
  maxBodyBytes,
  prepareIssue,
  type RefusedIssue,
} from "../src/recover/issue";
import { recoveryPrompt } from "../src/recover/prompt";
import { createSanitizer, type Sanitizer } from "../src/recover/sanitize";

// The repair agent's assignment and the issue it files, from fixed facts.

const check = failed("update-state-invalid", "state-invalid", {
  path: "update/high-water",
});
if (check.outcome !== "failed") throw new Error("fixture");
const evidence: RecoveryEvidence = {
  schema: "lazurio.recovery.v1",
  detectedAt: "2026-09-28T10:00:00.000Z",
  fingerprint: fingerprint(check, "linux-arm64"),
  check: check.id,
  rule: check.rule,
  code: check.code,
  context: check.context,
  failed: [check.id],
  checks: [
    check,
    ok("folder-state", { revision: 3 }),
    failed("self-check-failed", "self-check-failed", { reason: "exit" }),
    skipped("launchpad-unit", "no-user-manager"),
    skipped("launchpad-health", "not-supervised"),
  ],
  product: {
    running: {
      version: "0.2.0",
      commit: "a".repeat(40),
      target: "linux-arm64",
      fixture: false,
    },
    active: null,
  },
  platform: {
    os: "linux",
    kernel: "6.8.0",
    arch: "arm64",
    systemd: 255,
    bun: "1.4.2",
  },
  install: {
    active: "0.2.0",
    highWater: null,
    stateInvalid: "update/high-water",
    versions: ["0.1.9", "0.2.0"],
    supervised: false,
    legacyPrevious: true,
    legacyMarker: false,
  },
  unit: null,
  folder: null,
  lastCheck: { latest: "0.2.0", checkedAt: "2026-09-27T08:00:00.000Z" },
  journal: null,
};
const sanitizer = createSanitizer({
  values: [],
  publicDigests: ["a".repeat(40)],
});
const prepared = prepareIssue(evidence, sanitizer);

test("the prompt in English: task, evidence, mandate, never, proof, GitHub, stop", () => {
  if (prepared.kind !== "prepared")
    throw new Error("expected a prepared issue");
  const prompt = recoveryPrompt(
    { evidence, issue: prepared, folder: "/srv/Lazurio", supervised: false },
    "en",
  );
  const paragraphs = prompt.split("\n\n");
  expect(paragraphs[0]).toBe(
    "**Task:** Lazurio on this Machine needs a repair (check `update-state-invalid`, code `state-invalid`, detected 2026-09-28T10:00:00.000Z). Repair it forward. When you cannot, file everything needed for a fixed release as a GitHub Issue.",
  );
  expect(prompt).toContain(
    `\`\`\`json\n${readableJson({ ...evidence, journal: undefined })}\n\`\`\``,
  );
  expect(paragraphs.slice(3).map((paragraph) => paragraph.slice(0, 3))).toEqual(
    ["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. "],
  );
  // Unsupervised: no unit to converge or restart, no journal to read by hand.
  expect(prompt).not.toContain("systemctl");
  expect(prompt).toContain(
    "`lazurio update` to a release newer than the active one",
  );
  expect(prompt).toContain("editing files in the Folder (`/srv/Lazurio`)");
  expect(prompt).toContain(
    "**Never:** `lazurio update rollback` or any other way back to an earlier version",
  );
  expect(prompt).toContain("deleting update state to get past `state-invalid`");
  // The rerun reads the same Folder this run read: on a workstation only
  // --folder names it, and without it folder-state is skipped.
  expect(paragraphs[3]).toBe(
    "1. Read the current state yourself: `lazurio recover --json --folder /srv/Lazurio`.",
  );
  expect(paragraphs[8]).toStartWith(
    '6. **Success is proven** when `lazurio recover --json --folder /srv/Lazurio` answers `"verdict": "healthy"`',
  );
  expect(prompt).toContain(
    `\`gh issue list --repo Lazurio/LazurioPlatform --state all --search '"${evidence.fingerprint}" in:title'\``,
  );
  expect(prompt).toContain("root decision 0163");
  // Tier 2 stays here: the journal reaches the issue only as a comment.
  expect(paragraphs[9]).toContain(
    "The body carries structured fields only. `evidence.journal` (the sanitized tail of the Launchpad's journal) and any other free text stay on this Machine: you may attach them to the issue only as a comment, after you have read them yourself and judged them public-safe; never in the body you create the issue with.",
  );
  expect(prompt.endsWith("Stop there; work around nothing.")).toBe(true);
});

test("the prompt in Czech, supervised, with the same facts", () => {
  if (prepared.kind !== "prepared")
    throw new Error("expected a prepared issue");
  const prompt = recoveryPrompt(
    { evidence, issue: prepared, folder: undefined, supervised: true },
    "cs",
  );
  expect(
    prompt.startsWith(
      "**Úkol:** Lazurio na téhle Mašině potřebuje opravu (kontrola `update-state-invalid`, kód `state-invalid`",
    ),
  ).toBe(true);
  expect(prompt).toContain(
    "`lazurio install --service systemd-user --folder <Folder>`",
  );
  expect(prompt).toContain(
    "`systemctl --user restart lazurio-launchpad.service`",
  );
  expect(prompt).toContain(
    "`journalctl --user --unit lazurio-launchpad.service --lines 80`",
  );
  expect(prompt).toContain("**Nikdy:** `lazurio update rollback`");
  expect(prompt).toContain(
    "Tělo nese jen strukturovaná pole. `evidence.journal` (sanitizovaný konec journalu Launchpadu) a jakýkoli jiný volný text zůstávají na téhle Mašině: k issue je smíš přidat jen jako komentář, až si je sám přečteš a usoudíš, že jsou veřejně bezpečné; nikdy ne do těla, se kterým issue zakládáš.",
  );
  // No Folder was read: the rerun detects it the same way.
  expect(prompt).toContain("sám: `lazurio recover --json`.");
  // A Folder path is one shell word in every command that names it.
  const spaced = recoveryPrompt(
    { evidence, issue: prepared, folder: "/srv/My Lazurio", supervised: true },
    "en",
  );
  expect(spaced).toContain(
    "`lazurio recover --json --folder '/srv/My Lazurio'`",
  );
  expect(spaced).toContain(
    "`lazurio install --service systemd-user --folder '/srv/My Lazurio'`",
  );
  expect(prompt).toContain(evidence.fingerprint);
  expect(prompt).toContain("Tam skonči; nic neobcházej.");
  // The English prompt is not mixed in.
  expect(prompt).not.toContain("**Task:**");
});

test("a refused body: the prompt says send nothing and names only the kinds", () => {
  const refused: RefusedIssue = {
    kind: "refused",
    repository: "Lazurio/LazurioPlatform",
    found: ["organization", "ip-address"],
  };
  for (const locale of ["en", "cs"] as const) {
    const prompt = recoveryPrompt(
      { evidence, issue: refused, folder: undefined, supervised: false },
      locale,
    );
    expect(prompt).toContain("`organization`, `ip-address`");
    expect(prompt).not.toContain("gh issue");
  }
});

test("prepareIssue refuses what the gate refuses and prepares nothing of it", () => {
  // A sanitizer that forgot to replace: the gate is the last line.
  const leaky = createSanitizer({
    values: [{ kind: "organization", value: "globex" }],
  });
  const careless: Sanitizer = { ...leaky, sanitize: (text) => text };
  const result = prepareIssue(
    { ...evidence, context: { path: "globex", peer: "100.64.0.3" } },
    careless,
  );
  expect(result).toEqual({
    kind: "refused",
    repository: "Lazurio/LazurioPlatform",
    found: ["organization", "ip-address"],
  });
  expect(JSON.stringify(result)).not.toContain("globex");
});

test("the prepared issue is tier 1: no journal line, even when the evidence has a journal", () => {
  const journal = [
    "Started Lazurio Launchpad on this Machine.",
    "error: the Folder state could not be read",
    "```",
    "Main process exited, code=exited, status=1/FAILURE",
  ].join("\n");
  const issue = prepareIssue({ ...evidence, journal }, sanitizer);
  if (issue.kind !== "prepared") throw new Error("expected a prepared issue");
  const leaving = [
    issue.title,
    issue.body,
    issue.shell,
    decodeURIComponent(issue.link),
  ].join("\n");
  for (const line of journal.split("\n").filter((line) => line !== "```"))
    expect([line, leaving.includes(line)]).toEqual([line, false]);
  expect(leaving).not.toContain('"journal"');
  // The same body as without a journal: the JSON is the evidence without it.
  expect(issue.body).toBe(issueBody(evidence, sanitizer.sanitize));
  const json = /```json\n([\s\S]*?)\n```/.exec(issue.body)?.[1] ?? "";
  const { journal: _, ...fields } = evidence;
  expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(fields)));
});

test("the largest tier-1 body stays within its bound, untrimmed", () => {
  // Every check failed with its widest context, the last failed update run,
  // the Folder, the active executable and a long list of installed versions.
  const version = "10.20.30-rc.40";
  const word = "x".repeat(64);
  const checks = [
    failed("update-state-invalid", "state-invalid", {
      path: "update/pending.json",
    }),
    failed("folder-state", "folder-state-unrecognized"),
    failed("self-check-failed", "self-check-failed", {
      reason: "identity-mismatch",
      exitCode: 255,
    }),
    failed("launchpad-unit", "unit-restarting", {
      activeState: "activating",
      subState: "auto-restart",
      result: "exit-code",
      nRestarts: 999_999_999,
      execMainStatus: 999_999_999,
    }),
    failed("launchpad-health", "launchpad-version-mismatch", {
      reported: version,
      active: version,
    }),
  ];
  const executable = {
    version,
    commit: "a".repeat(40),
    target: "darwin-arm64",
    fixture: false,
  };
  const widest: RecoveryEvidence = {
    ...evidence,
    failed: checks.map((entry) => entry.id),
    checks,
    product: { running: executable, active: executable },
    platform: { ...evidence.platform, kernel: word },
    install: {
      ...evidence.install,
      active: version,
      highWater: version,
      stateInvalid: "update/pending.json",
      versions: Array.from({ length: 12 }, () => version),
      supervised: true,
      legacyMarker: true,
    },
    unit: {
      loadState: "loaded",
      activeState: "activating",
      subState: "auto-restart",
      result: "exit-code",
      nRestarts: 999_999_999,
      execMainStatus: 999_999_999,
      lastUpdateFailure: {
        code: "rollback-unavailable",
        context: { resource: word, reason: word, stage: word, detail: word },
      },
    },
    folder: {
      preset: "hosted-personal",
      machineKind: "workspace-vm",
      revision: 999_999_999,
      recordedTemplateRevision: word,
      productTemplateRevision: word,
      preferencesSchema: 99,
      manifestSchema: 99,
      pendingTransaction: true,
    },
    journal: "y".repeat(8 * 1024),
  };
  const issue = prepareIssue(widest, sanitizer);
  if (issue.kind !== "prepared") throw new Error("expected a prepared issue");
  expect(Buffer.byteLength(issue.body)).toBeLessThanOrEqual(maxBodyBytes);
  expect(issue.body).not.toContain("yyyy");
});

test("the fingerprint ignores the version and tells faults apart", () => {
  const other = failed("update-state-invalid", "state-invalid", {
    path: "update/pending.json",
  });
  if (other.outcome !== "failed") throw new Error("fixture");
  expect(fingerprint(check, "linux-arm64")).toMatch(/^rf-[0-9a-f]{12}$/);
  expect(fingerprint(check, "linux-arm64")).toBe(
    fingerprint(check, "linux-arm64"),
  );
  expect(fingerprint(other, "linux-arm64")).not.toBe(
    fingerprint(check, "linux-arm64"),
  );
  expect(fingerprint(check, "linux-x64")).not.toBe(
    fingerprint(check, "linux-arm64"),
  );
});
