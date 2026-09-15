import { expect, test } from "bun:test";
import { candidateTarget } from "../scripts/candidate-target";

test("cross-build identity uses destination, not build host", () => {
  expect(candidateTarget("linux-x64", "darwin", "arm64")).toEqual({
    target: "linux-x64",
    bunTarget: "bun-linux-x64",
    filename: "lazurio",
  });
  expect(candidateTarget("linux-arm64", "darwin", "arm64").target).toBe(
    "linux-arm64",
  );
  expect(candidateTarget(undefined, "darwin", "arm64")).toEqual({
    target: "darwin-arm64",
    bunTarget: null,
    filename: "lazurio",
  });
  expect(candidateTarget(undefined, "win32", "x64").filename).toBe(
    "lazurio.exe",
  );
  for (const value of [
    "linux-x86_64",
    "linux-x64-musl",
    "windows-x64",
    "",
    "--flag",
  ])
    expect(() => candidateTarget(value, "darwin", "arm64")).toThrow();
});
