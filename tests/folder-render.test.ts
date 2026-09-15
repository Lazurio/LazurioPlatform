import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { planInstructions } from "../src/folder/reconcile";
import { renderInstructions } from "../src/folder/render";

test("all launch journeys render both languages without undefined fragments", () => {
  for (const journey of [
    { os: "windows", access: "local", purpose: "human" },
    { os: "macos", access: "local", purpose: "human" },
    { os: "linux", access: "remote", purpose: "human" },
    { os: "linux", access: "remote", purpose: "buddy" },
  ]) {
    for (const locale of ["cs", "en"]) {
      const input = {
        ...journey,
        locale,
        detail: "concise",
        coordination: "direct",
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
  const profile = {
    os: "linux",
    access: "remote",
    purpose: "buddy",
    locale: "cs",
    detail: "technical",
    coordination: "coordinator",
  };
  const cs = renderInstructions(profile);
  const en = renderInstructions({ ...profile, locale: "en" });
  expect(cs).toContain("Komunikuj česky");
  expect(en).toContain("Communicate in English");
  expect(cs).not.toEqual(en);
  const reordered = Object.fromEntries(Object.entries(profile).reverse());
  expect(renderInstructions(reordered)).toEqual(cs);
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
  expect(() => renderInstructions({ ...profile, locale: "invalid" })).toThrow();
});
