import { expect, test } from "bun:test";
import { manifestOutputPaths, outputPaths } from "../src/folder/outputs";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { planOutputs } from "../src/folder/reconcile";
import { uiCraftLine } from "../src/folder/render";
import { renderSkills } from "../src/folder/skills";
import { journeys } from "./fixtures/journeys";

// The Folder's skill `ui-craft` (decision F14, addendum of 2026-10-21): the
// craft bar for every interface an agent builds or changes, the same bytes
// for Codex and Claude Code, in the Folder's locale, with the project's own
// rules first. A Folder of manifest schema 3 (new-module only) gains it by
// its next change, created only where nothing is at its path.

const codex = ".agents/skills/ui-craft/SKILL.md" as const;
const claude = ".claude/skills/ui-craft/SKILL.md" as const;

function rendered(journey: (typeof journeys)[number], locale: "cs" | "en") {
  return renderOutputs({
    preset: journey.preset,
    machine: journey.machine,
    profile: presetProfile(journey.preset, journey.os, { locale }),
  });
}

test("every Environment renders ui-craft in its locale, the same bytes for both harnesses, with the project's rules first and a pointer in AGENTS.md and new-module", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = rendered(journey, locale);
      const text = outputs[codex];
      const cs = locale === "cs";
      expect(outputs[claude]).toBe(text);
      const match = /^---\nname: ([a-z-]+)\ndescription: (".*")\n---\n/.exec(
        text,
      );
      expect(match?.[1]).toBe("ui-craft");
      const description = JSON.parse(match?.[2] ?? '""') as string;
      expect(description.length).toBeLessThan(1024);
      for (const word of cs
        ? ["rozhraní", "web", "animaci", "telefonu", "design systému"]
        : ["interface", "website", "animation", "phone", "design system"])
        expect([word, description.includes(word)]).toEqual([word, true]);
      // The project's rules come before every default.
      const first = text.indexOf(
        cs
          ? "**Pravidla projektu mají přednost.**"
          : "**The project's rules come first.**",
      );
      const motion = text.indexOf(
        cs ? "## 1. Má se to vůbec hýbat?" : "## 1. Should it move at all?",
      );
      expect(first).toBeGreaterThan(0);
      expect(motion).toBeGreaterThan(first);
      for (const phrase of [
        "prefers-reduced-motion",
        "(hover: hover) and (pointer: fine)",
        "transition: all",
        "100svh",
        "env(safe-area-inset-*)",
        "Intl.PluralRules",
        "emilkowalski/skills",
      ])
        expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
      expect(text).not.toContain('user-scalable=no"');
      // AGENTS.md and the skill new-module both lead to it.
      expect(outputs["AGENTS.md"]).toContain(uiCraftLine[locale]);
      expect(outputs[".agents/skills/new-module/SKILL.md"]).toContain(
        "`ui-craft`",
      );
    }
});

test("ui-craft has the same sections and lines in both languages", () => {
  const journey = journeys[0];
  if (!journey) throw new Error("No journey");
  const skill = (locale: "cs" | "en") =>
    renderSkills({
      preset: journey.preset,
      machine: journey.machine,
      profile: presetProfile(journey.preset, journey.os, { locale }),
    })[codex].split("\n");
  const cs = skill("cs");
  const en = skill("en");
  expect(cs.length).toBe(en.length);
  expect(cs.map((line) => /^#+ |^- |^$/.exec(line)?.[0] ?? "")).toEqual(
    en.map((line) => /^#+ |^- |^$/.exec(line)?.[0] ?? ""),
  );
});

test("ui-craft does not promise that CSS or WAAPI motion always runs off the main thread", () => {
  const journey = journeys[0];
  if (!journey) throw new Error("No journey");
  const skill = (locale: "cs" | "en") =>
    renderSkills({
      preset: journey.preset,
      machine: journey.machine,
      profile: presetProfile(journey.preset, journey.os, { locale }),
    })[codex];
  const cs = skill("cs");
  const en = skill("en");
  expect(en).not.toContain("it runs off the main thread, so");
  expect(en).toContain("animate on the main thread like anything else");
  expect(en).toContain("Verify smoothness under load by profiling");
  expect(cs).not.toContain("běží mimo hlavní vlákno, takže");
  expect(cs).toContain("se animují na hlavním vlákně");
  expect(cs).toContain("Plynulost při zátěži ověř profilováním");
  expect(en).not.toContain("the browser composites them without new layout or paint");
  expect(en).toContain("depends on the browser and the element, so verify it by profiling");
  expect(cs).not.toContain("ty prohlížeč skládá bez nového rozvržení a kreslení");
  expect(cs).toContain("záleží ale na prohlížeči a prvku, takže to ověř profilováním");
});

test("ui-craft's durations do not contradict each other: a dialog may take up to 500 ms", () => {
  const journey = journeys[0];
  if (!journey) throw new Error("No journey");
  const skill = (locale: "cs" | "en") =>
    renderSkills({
      preset: journey.preset,
      machine: journey.machine,
      profile: presetProfile(journey.preset, journey.os, { locale }),
    })[codex];
  const cs = skill("cs");
  const en = skill("en");
  expect(en).toContain("a dialog or panel 200–500 ms");
  expect(en).not.toContain("Keep an interface element under 300 ms");
  expect(en).toContain("so it may take up to 500 ms");
  expect(cs).toContain("dialog a panel 200–500 ms");
  expect(cs).not.toContain("Prvek rozhraní drž pod 300 ms");
  expect(cs).toContain("proto smějí mít až 500 ms");
});

test("a Folder of schema 3 gains ui-craft where nothing is there and is refused where something is", () => {
  const digest = "b".repeat(64);
  const previous = Object.fromEntries(
    manifestOutputPaths[3].map((path) => [path, digest]),
  );
  const desired = Object.fromEntries(
    outputPaths.map((path) => [path, digest]),
  ) as Record<(typeof outputPaths)[number], string>;
  const observed = (ui: "absent" | "regular") =>
    Object.fromEntries(
      outputPaths.map((path) => [
        path,
        path.includes("/ui-craft/")
          ? ui === "absent"
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
