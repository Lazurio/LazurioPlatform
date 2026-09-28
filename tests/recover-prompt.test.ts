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
    { ...evidence, journal: "error in globex from 100.64.0.3" },
    careless,
  );
  expect(result).toEqual({
    kind: "refused",
    repository: "Lazurio/LazurioPlatform",
    found: ["organization", "ip-address"],
  });
  expect(JSON.stringify(result)).not.toContain("globex");
});

test("the body stays within its bound by dropping the oldest journal lines", () => {
  const journal = Array.from(
    { length: 80 },
    (_, n) => `${n} ${"x ".repeat(48)}`,
  ).join("\n");
  const body = issueBody({ ...evidence, journal });
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes);
  expect(body).toContain(`79 ${"x ".repeat(48)}`.trimEnd());
  expect(body).not.toContain(`\n0 ${"x ".repeat(48)}`.trimEnd());
  // The JSON of the body is the evidence without its journal.
  const json = /```json\n([\s\S]*?)\n```/.exec(body)?.[1] ?? "";
  const { journal: _, ...fields } = evidence;
  expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(fields)));
  // A journal line with backticks cannot close the fence early.
  const fenced = issueBody({ ...evidence, journal: "```\nnot the end" });
  expect(fenced).toContain("````text\n```\nnot the end\n````");
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
