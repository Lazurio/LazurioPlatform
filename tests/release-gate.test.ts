import { expect, test } from "bun:test";
import { blockingRelease } from "../scripts/release-gate";

const release = (
  tagName: string,
  flags: Partial<{ isDraft: boolean; isPrerelease: boolean }> = {},
) => ({
  tagName,
  isDraft: false,
  isPrerelease: false,
  ...flags,
});

test("a final version must be greater than every published final release", () => {
  const published = [
    release("v1.2.0"),
    release("v1.10.0"),
    release("v2.0.0-rc.1", { isPrerelease: true }),
    release("v3.0.0", { isDraft: true }),
    release("nightly"),
  ];
  expect(blockingRelease("1.10.1", published)).toBeUndefined();
  expect(blockingRelease("2.0.0", published)).toBeUndefined();
  // Equal and lower are refused; 1.9.0 is below 1.10.0 numerically.
  expect(blockingRelease("1.10.0", published)).toBe("v1.10.0");
  expect(blockingRelease("1.9.0", published)).toBe("v1.10.0");
  expect(blockingRelease("1.1.0", published)).toBe("v1.2.0");
  // Drafts, prereleases and foreign tags order nothing.
  expect(
    blockingRelease("1.0.0", [release("v3.0.0", { isDraft: true })]),
  ).toBeUndefined();
  // A prerelease is never ordered: it is reached only by name.
  expect(blockingRelease("1.0.0-rc.1", published)).toBeUndefined();
  expect(() => blockingRelease("v1.0.0", published)).toThrow();
});
