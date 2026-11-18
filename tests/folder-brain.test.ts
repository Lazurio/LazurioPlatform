import { expect, test } from "bun:test";
import { renderOutputs } from "../src/folder/preview";
import { compositions } from "./fixtures/folder-compositions";

// The person's memory in the Folder's text (plan LZD-0033 R11a): in a
// Personal Remote Environment one line of AGENTS.md names the Brain and the
// manual's working-here.md holds its rules; every other Environment keeps
// the rule that gbrain is used only on the user's explicit instruction.

test("only a Personal Remote Environment gets the Brain: one line in AGENTS.md, its rules in working-here.md", () => {
  let personal = 0;
  for (const composition of compositions()) {
    const outputs = renderOutputs(composition);
    const agents = outputs["AGENTS.md"];
    const manual = outputs["manual/working-here.md"];
    const cs = composition.profile.locale === "cs";
    const brain =
      composition.preset === "hosted-personal" &&
      composition.machine?.entry?.audience !== "public";
    if (brain) personal += 1;
    expect([
      composition.preset,
      agents.includes("gbrain nepoužívej") ||
        agents.includes("Do not use gbrain"),
    ]).toEqual([composition.preset, !brain]);
    expect([
      composition.preset,
      manual.includes(cs ? "## Paměť: Brain" : "## Memory: the Brain"),
    ]).toEqual([composition.preset, brain]);
    if (!brain) continue;
    expect(agents).toContain("`manual/working-here.md`");
    // Every write is signed with the agent and the thread (Matěj's choice
    // „Jeden klíč, podpis u zápisu“), and an Organization's work stays in
    // the Organization.
    expect(manual).toContain("`provenance`");
    expect(manual).toContain("T3 thread <UUID>");
    expect(manual).toContain("(0180, 0246)");
  }
  expect(personal).toBeGreaterThan(0);
});
