import { expect, test } from "bun:test";
import { manifestOutputPaths, outputPaths } from "../src/folder/outputs";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { planOutputs } from "../src/folder/reconcile";
import { automateLine } from "../src/folder/render";
import { journeys } from "./fixtures/journeys";

// The Folder's skill `automate` (decision F14, proposed addendum of
// 2026-11-20): an automation is a bot of Lazurio MausBot with a routine or a
// webhook in Automate, never a harness's scheduler or cron; a trial run only
// on consent to run now; a webhook's secret never leaves the Environment.
// The same bytes for Codex and Claude Code, in the Folder's locale. A Folder
// of manifest schema 6 gains it by its next change, created only where
// nothing is at its path.

const codex = ".agents/skills/automate/SKILL.md" as const;
const claude = ".claude/skills/automate/SKILL.md" as const;

function rendered(journey: (typeof journeys)[number], locale: "cs" | "en") {
  return renderOutputs({
    preset: journey.preset,
    machine: journey.machine,
    profile: presetProfile(journey.preset, journey.os, { locale }),
  });
}

test("every Environment renders automate in its locale, the same bytes for both harnesses, with a description that turns the agent away from its own scheduler", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = rendered(journey, locale);
      const text = outputs[codex];
      expect(outputs[claude]).toBe(text);
      const match = /^---\nname: ([a-z-]+)\ndescription: (".*")\n---\n/.exec(
        text,
      );
      expect(match?.[1]).toBe("automate");
      const description = JSON.parse(match?.[2] ?? '""') as string;
      expect(description.length).toBeLessThan(1024);
      for (const word of locale === "cs"
        ? ["pravidelně", "Automate", "CronCreate", "cronem", "souhlasem"]
        : ["regularly", "Automate", "CronCreate", "cron", "consent"])
        expect([word, description.includes(word)]).toEqual([word, true]);
    }
});

test("automate waits for consent before a trial run and keeps a webhook's secret inside the Environment", () => {
  const journey = journeys[0];
  if (!journey) throw new Error("No journey");
  for (const locale of ["cs", "en"] as const) {
    const text = rendered(journey, locale)[codex];
    // Every command first as a dry run; an irreversible task starts paused.
    for (const phrase of [
      "--dry-run",
      "--paused",
      "omb routine show",
      "--secret-file",
      "ingress.baseUrl",
      "lazurio vault env",
      "agent-browser --cdp 9222",
      "batch",
      '"ignored": true',
      "401",
      "schedule_task",
      "crontab -l",
    ])
      expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
    // The secret is never printed, and a trial run asks first.
    expect(text).toContain(
      locale === "cs" ? "nikdy `--show-secret`" : "never `--show-secret`",
    );
    expect(text).toContain(
      locale === "cs"
        ? "Jen na souhlas spusť `omb routine run NAME`."
        : "Only on consent run `omb routine run NAME`.",
    );
    expect(text).toContain(
      locale === "cs"
        ? "**Jinak webhook nezakládej.**"
        : "**Otherwise create no webhook.**",
    );
  }
});

test("automate has the same sections and lines in both languages", () => {
  const journey = journeys[0];
  if (!journey) throw new Error("No journey");
  const shape = (locale: "cs" | "en") =>
    rendered(journey, locale)
      [codex].split("\n")
      .map((line) => /^#+ |^ *- |^\d+\. |^ {3}(?=\S)|^$/.exec(line)?.[0] ?? "");
  expect(shape("cs")).toEqual(shape("en"));
});

test("AGENTS.md points to automate on an Organization's personal work Environment and its Henry Environment, and the manual everywhere", () => {
  const carriers = new Set([
    "hosted-organization-personal",
    "hosted-organization-steward",
  ]);
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = rendered(journey, locale);
      expect([
        journey.preset,
        outputs["AGENTS.md"].includes(automateLine[locale]),
      ]).toEqual([journey.preset, carriers.has(journey.preset)]);
      expect(outputs["manual/lazurio.md"]).toContain(
        locale === "cs" ? "skillem `automate`" : "the skill `automate`",
      );
    }
});

test("a Folder of manifest schema 6 gains automate by its next change only where nothing is at its path", () => {
  const digest = "a".repeat(64);
  const previous = Object.fromEntries(
    manifestOutputPaths[6].map((path) => [path, digest]),
  );
  const desired = Object.fromEntries(
    outputPaths.map((path) => [path, digest]),
  ) as Record<(typeof outputPaths)[number], string>;
  expect(
    outputPaths.filter((path) => !manifestOutputPaths[6].includes(path)),
  ).toEqual([codex, claude]);
  const observed = (skill: "absent" | "regular") =>
    Object.fromEntries(
      outputPaths.map((path) => [
        path,
        path.includes("/automate/")
          ? skill === "absent"
            ? { kind: "absent" as const }
            : { kind: "regular" as const, digest: "c".repeat(64) }
          : { kind: "regular" as const, digest },
      ]),
    ) as Parameters<typeof planOutputs>[2];
  expect(planOutputs(previous, desired, observed("absent"))).toEqual({
    kind: "write",
    files: [
      { kind: "create", path: codex },
      { kind: "create", path: claude },
    ],
  });
  expect(planOutputs(previous, desired, observed("regular"))).toEqual({
    kind: "blocked",
    reason: "unowned-file",
    path: codex,
  });
});
