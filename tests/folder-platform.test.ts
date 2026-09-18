import { expect, test } from "bun:test";
import { executionOs } from "../src/folder/platform";

test("execution OS mapping is explicit and rejects unqualified systems", () => {
  expect(executionOs("darwin")).toBe("macos");
  expect(executionOs("linux")).toBe("linux");
  expect(executionOs("win32")).toBe("windows");
  expect(() => executionOs("freebsd")).toThrow("Unsupported execution OS");
});
