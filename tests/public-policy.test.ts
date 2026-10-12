import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedProofImport,
  forbiddenPath,
  proofInputViolations,
  recognizableCredential,
} from "../scripts/check-public";
import { runChild } from "./fixtures/run-child";

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
    expect(
      (await runChild(["git", "init", "--quiet"], { cwd: fixture })).exitCode,
    ).toBe(0);
    await writeFile(join(fixture, "example.txt"), synthetic);
    expect(
      (await runChild(["git", "add", "example.txt"], { cwd: fixture }))
        .exitCode,
    ).toBe(0);
    await writeFile(join(fixture, "example.txt"), "safe unstaged replacement");
    const rejected = await runChild([process.execPath, script], {
      cwd: fixture,
    });
    expect(rejected.exitCode).toBe(1);
    const output = rejected.stdout + rejected.stderr;
    expect(output).toContain("Credential pattern in index: example.txt");
    expect(output).not.toContain(synthetic);
    expect(
      (await runChild(["git", "add", "example.txt"], { cwd: fixture }))
        .exitCode,
    ).toBe(0);
    await writeFile(join(fixture, "example.txt"), "another safe unstaged edit");
    const accepted = await runChild([process.execPath, script], {
      cwd: fixture,
    });
    expect(accepted.exitCode).toBe(0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// Decision F50 point 6: the Environment browser's contract is MIT, so the
// forks can vendor it without becoming mixed-licence. Its own licence file
// names the licensor of NOTICE; NOTICE and docs/licensing.md name the
// exception's three parts, the copied functions by name; the root LICENSE
// stays Elastic-2.0.
test("the browser contract's MIT terms lie beside it, and NOTICE and the licensing page name the exception's three parts", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (path: string) => readFile(join(root, path), "utf8");
  const notice = await read("NOTICE");
  const licensor = /^Copyright 2026 (.+)$/m.exec(notice)?.[1];
  expect(licensor).toBeDefined();
  const mit = await read("src/browser/contract/LICENSE");
  expect(mit.split("\n")[0]).toBe("MIT License");
  expect(mit).toContain(`Copyright (c) 2026 ${licensor}\n`);
  expect(mit).toContain("Permission is hereby granted, free of charge");
  expect((await read("LICENSE")).split("\n")[0]).toBe("Elastic License 2.0");
  const copied = [
    "BootTime",
    "readBootClock",
    "parseBootTime",
    "RecordedTab",
    "LiveTabs",
    "parseLiveTabs",
    "keptTabs",
    "isStrip",
    "holderDirectory",
    "liveTabsPath",
    "parseHolder",
    "holderFileText",
    "parseHolderRecords",
    "replaceOwnerFile",
    "processAlive",
    "watchHolds",
    "watchDirectories",
  ];
  for (const text of [notice, await read("docs/licensing.md")])
    for (const part of [
      "src/browser/contract/",
      "browserContract",
      "src/browser/people/holds.ts",
      "49d54c9",
      "apps/server/src/lazurio/holders.ts",
      ...copied,
    ])
      expect(`${part}: ${text.includes(part)}`).toBe(`${part}: true`);
});
