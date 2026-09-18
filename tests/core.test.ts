import { expect, test } from "bun:test";
import { coordination, details, preview, purposes } from "../proof/core";

test("all independent profile combinations render deterministically without privileges", () => {
  for (const purpose of purposes)
    for (const detail of details)
      for (const mode of coordination) {
        const input = { purpose, detail, coordination: mode };
        const result = preview(input);
        expect(preview({ coordination: mode, detail, purpose })).toEqual(
          result,
        );
        expect(result.instructions).toContain(
          "grant no access or publication authority",
        );
        expect(input).toEqual(result.profile);
      }
});
test("untrusted inputs fail closed", () => {
  for (const input of [
    null,
    [],
    {},
    { purpose: "linux", detail: "concise", coordination: "direct" },
    { purpose: "human", detail: "admin", coordination: "direct" },
    { purpose: "human", detail: "concise", coordination: "autonomous_merge" },
    {
      purpose: "human",
      detail: "concise",
      coordination: "direct",
      grant: "admin",
    },
  ]) {
    expect(() => preview(input)).toThrow();
  }
});
