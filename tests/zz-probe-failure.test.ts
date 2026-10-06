import { expect, test } from "bun:test";

test("a deliberately failing probe", () => {
  expect(1).toBe(2);
});
