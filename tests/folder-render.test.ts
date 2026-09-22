import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { presetProfile } from "../src/folder/presets";
import { planInstructions } from "../src/folder/reconcile";
import { renderInstructions } from "../src/folder/render";
import { bindings } from "./fixtures/machine-bindings";

// Every preset on every OS it is offered for, in both languages.
export const journeys = [
  { preset: "local", machine: null, os: "windows" },
  { preset: "local", machine: null, os: "macos" },
  { preset: "hosted-personal", machine: bindings.personal, os: "linux" },
  {
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    os: "linux",
  },
  { preset: "hosted-organization-team", machine: bindings.team, os: "linux" },
] as const;

test("all launch journeys render both languages without undefined fragments", () => {
  for (const journey of journeys) {
    for (const locale of ["cs", "en"] as const) {
      const input = {
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      };
      const output = renderInstructions(input);
      expect(output).not.toContain("undefined");
      expect(output).toEqual(renderInstructions(input));
      expect(output).toContain(
        locale === "cs"
          ? "Profil neuděluje přístup"
          : "A profile grants no access",
      );
      expect(output.endsWith("\n")).toBe(true);
    }
  }
});

test("localized profile output deterministically feeds reconciliation", () => {
  const profile = presetProfile("hosted-organization-team", "linux", {
    locale: "cs",
    detail: "technical",
    coordination: "coordinator",
  });
  const source = {
    preset: "hosted-organization-team",
    machine: bindings.team,
    profile,
  };
  const cs = renderInstructions(source);
  const en = renderInstructions({
    ...source,
    profile: { ...profile, locale: "en" },
  });
  expect(cs).toContain("Komunikuj česky");
  expect(en).toContain("Communicate in English");
  expect(cs).not.toEqual(en);
  const reordered = Object.fromEntries(Object.entries(profile).reverse());
  expect(renderInstructions({ ...source, profile: reordered })).toEqual(cs);
  for (const output of [cs, en]) {
    expect(output).toContain("Organizations");
    expect(output).toContain("Personalspace");
    const digest = createHash("sha256").update(output).digest("hex");
    expect(planInstructions(null, digest, { kind: "absent" })).toEqual({
      kind: "create",
      path: "AGENTS.md",
    });
    expect(
      planInstructions(digest, digest, { kind: "regular", digest }),
    ).toEqual({ kind: "unchanged" });
  }
  expect(() =>
    renderInstructions({
      ...source,
      profile: { ...profile, locale: "invalid" },
    }),
  ).toThrow();
  // A preset the Machine does not allow never renders.
  expect(() =>
    renderInstructions({ ...source, preset: "hosted-personal" }),
  ).toThrow("not allowed");
  expect(() => renderInstructions({ ...source, machine: null })).toThrow(
    "not allowed",
  );
});

// The generated document per preset and language, on the OS each preset is
// offered for. Review the snapshot when the wording changes deliberately.
for (const journey of journeys.filter((entry) => entry.os !== "windows"))
  for (const locale of ["cs", "en"] as const)
    test(`rendered AGENTS.md snapshot: ${journey.preset} / ${locale}`, () => {
      expect(
        renderInstructions({
          preset: journey.preset,
          machine: journey.machine,
          profile: presetProfile(journey.preset, journey.os, { locale }),
        }),
      ).toMatchSnapshot();
    });

test("relationships render only when the recorded binding carries them", () => {
  const profile = presetProfile("hosted-personal", "linux");
  const plain = renderInstructions({
    preset: "hosted-personal",
    machine: bindings.personal,
    profile,
  });
  expect(plain).not.toContain("Related Machines");
  const related = renderInstructions({
    preset: "hosted-personal",
    machine: {
      ...bindings.personal,
      relationships: [
        { machine: "example-laptop", kind: "personal-client", access: "both" },
        { machine: "example-work", kind: "workspace-vm", access: "outbound" },
      ],
    },
    profile,
  });
  expect(related).toContain("### Related Machines");
  expect(related).toContain("`example-work` (work VM): reachable from here.");
  expect(related).toMatchSnapshot();
});

// The real canary shape: a Team-bearing handover on an individual work VM,
// adopted with the explicit personal preset. The binding keeps the Team; the
// Owner line names it only under hosted-organization-team.
test("the Owner line names the Team only under hosted-organization-team", () => {
  for (const locale of ["cs", "en"] as const) {
    const personal = renderInstructions({
      preset: "hosted-organization-personal",
      machine: bindings.team,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
    });
    expect(personal).toContain(
      locale === "cs"
        ? "- Owner: Organizace `example`.\n"
        : "- Owner: Organization `example`.\n",
    );
    expect(personal).not.toContain("sample-team");
    expect(personal).toEqual(
      renderInstructions({
        preset: "hosted-organization-personal",
        machine: bindings.organization,
        profile: presetProfile("hosted-organization-personal", "linux", {
          locale,
        }),
      }),
    );
    expect(
      renderInstructions({
        preset: "hosted-organization-team",
        machine: bindings.team,
        profile: presetProfile("hosted-organization-team", "linux", { locale }),
      }),
    ).toContain("Team `sample-team`");
  }
  expect(
    renderInstructions({
      preset: "hosted-organization-personal",
      machine: bindings.team,
      profile: presetProfile("hosted-organization-personal", "linux"),
    }),
  ).toMatchSnapshot();
});
