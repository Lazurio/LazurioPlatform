import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedProofImport,
  forbiddenPath,
  proofInputViolations,
  recognizableCredential,
} from "../scripts/check-public";

test("publication guard rejects secret paths and generated artifacts", () => {
  for (const path of [
    ".env",
    "proof/.env.local",
    "private/data.json",
    "secrets/token.txt",
    "key.pem",
    "dist/proof",
    "node_modules/pkg/index.js",
  ])
    expect(forbiddenPath(path)).toBe(true);
  expect(forbiddenPath("docs/development.md")).toBe(false);
});
test("credential signatures reject known tokens without embedding real secrets", () => {
  expect(
    recognizableCredential(["-----BEGIN", "PRIVATE KEY-----"].join(" ")),
  ).toBe(true);
  expect(recognizableCredential(`ghp_${"x".repeat(36)}`)).toBe(true);
  expect(recognizableCredential(`github_pat_${"x".repeat(60)}`)).toBe(true);
  expect(recognizableCredential("ordinary documentation")).toBe(false);
});
test("proof asset policy requires reviewed local inputs", () => {
  expect(allowedProofImport("./index.html")).toBe(true);
  expect(allowedProofImport("../.env")).toBe(false);
  expect(allowedProofImport("./secret.json")).toBe(false);
});

test("module parser rejects every unreviewed static dependency form", async () => {
  for (const source of [
    'import "../outside.ts";',
    'import value from "../outside.ts"; console.log(value);',
    'export * from "../outside.ts";',
    'export { value } from "../outside.ts";',
    'import value from "../outside.json" with { type: "json" }; console.log(value);',
    'import value from "../outside.txt" with { type: "file" }; console.log(value);',
    'const value = require("../outside.ts"); console.log(value);',
    'require.resolve("../outside.ts");',
    'import("../outside.ts");',
  ])
    expect(await proofInputViolations("proof/main.ts", source)).not.toEqual([]);
  expect(
    await proofInputViolations("proof/main.ts", 'import "./core.ts";'),
  ).toEqual([]);
  expect(
    await proofInputViolations("proof/main.ts", 'export * from "./core.ts";'),
  ).toEqual([]);
});

test("HTML parser rejects whitespace, unquoted and alternate asset forms", async () => {
  for (const source of [
    '<script src = "../outside.ts" type="module"></script>',
    "<script SRC=../outside.ts type=module></script>",
    '<script src="./ui.ts" type="module">import "../outside.ts";</script>',
    '<link rel="stylesheet" href = "../outside.css">',
    '<img srcset="../outside.png 1x">',
    '<style>@import "../outside.css";</style>',
    '<p style="background:url(../outside.png)">text</p>',
    '<script type="importmap">{"imports":{}}</script>',
  ])
    expect(await proofInputViolations("proof/index.html", source)).not.toEqual(
      [],
    );
  expect(
    await proofInputViolations(
      "proof/index.html",
      '<script src = "./ui.ts" type = "module"></script>',
    ),
  ).toEqual([]);
});

test("real Git index secret cannot be hidden by a safe unstaged replacement", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "platform-index-"));
  const script = fileURLToPath(
    new URL("../scripts/check-public.ts", import.meta.url),
  );
  const synthetic = `ghp_${"x".repeat(36)}`;
  try {
    for (const args of [["init", "--quiet"]])
      expect(Bun.spawnSync(["git", ...args], { cwd: fixture }).exitCode).toBe(
        0,
      );
    await writeFile(join(fixture, "example.txt"), synthetic);
    expect(
      Bun.spawnSync(["git", "add", "example.txt"], { cwd: fixture }).exitCode,
    ).toBe(0);
    await writeFile(join(fixture, "example.txt"), "safe unstaged replacement");
    const rejected = Bun.spawnSync([process.execPath, script], {
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rejected.exitCode).toBe(1);
    const output =
      new TextDecoder().decode(rejected.stdout) +
      new TextDecoder().decode(rejected.stderr);
    expect(output).toContain("Credential pattern in index: example.txt");
    expect(output).not.toContain(synthetic);
    expect(
      Bun.spawnSync(["git", "add", "example.txt"], { cwd: fixture }).exitCode,
    ).toBe(0);
    await writeFile(join(fixture, "example.txt"), "another safe unstaged edit");
    const accepted = Bun.spawnSync([process.execPath, script], {
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(accepted.exitCode).toBe(0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
