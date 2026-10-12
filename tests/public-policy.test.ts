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
// forks can vendor it without becoming mixed-licence. Its own licence file is
// the MIT text naming the licensor of NOTICE; NOTICE lists exactly the
// exception's three parts and no wider path; the licensing page's exception
// names them too, the copied functions by name; the root LICENSE stays
// Elastic-2.0.
const copiedFunctions = [
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

const mitLicense = (licensor: string) => `MIT License

Copyright (c) 2026 ${licensor}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const repositoryText = (path: string) =>
  readFile(join(fileURLToPath(new URL("..", import.meta.url)), path), "utf8");

/** The paths a text names: tokens with a slash, as `src/browser/contract/`. */
const pathsIn = (text: string) =>
  [...new Set(text.match(/[\w.-]+(?:\/[\w.-]+)+\/?/g) ?? [])].sort();

test("the browser contract's licence file is the whole MIT text of NOTICE's licensor, and the root LICENSE stays Elastic-2.0", async () => {
  const licensor = /^Copyright 2026 (.+)$/m.exec(
    await repositoryText("NOTICE"),
  )?.[1];
  expect(licensor).toBeDefined();
  expect(await repositoryText("src/browser/contract/LICENSE")).toBe(
    mitLicense(licensor ?? ""),
  );
  expect((await repositoryText("LICENSE")).split("\n")[0]).toBe(
    "Elastic License 2.0",
  );
});

test("NOTICE lists exactly the exception's three parts, and no wider path", async () => {
  const notice = await repositoryText("NOTICE");
  const list = /The exception covers exactly:\n((?:(?:- | {2})[^\n]*\n)+)/.exec(
    notice,
  )?.[1];
  expect(list).toBeDefined();
  const parts = (list ?? "").split(/\n(?=- )/);
  expect(parts.length).toBe(3);
  expect(parts[0]).toStartWith("- the directory src/browser/contract/:");
  expect(parts[1]).toContain("under browserContract in its");
  expect(parts[2]).toContain(
    "copied from src/browser/people/holds.ts at\n  49d54c9 into apps/server/src/lazurio/holders.ts",
  );
  for (const name of copiedFunctions) expect(parts[2]).toContain(name);
  expect(pathsIn(list ?? "")).toEqual([
    "apps/server/src/lazurio/holders.ts",
    "src/browser/contract/",
    "src/browser/people/holds.ts",
  ]);
});

test("the licensing page's exception names its three parts, the copied functions by name", async () => {
  const page = await repositoryText("docs/licensing.md");
  const section =
    /\n## The Environment browser's contract: MIT\n([\s\S]*?)\n## /.exec(
      page,
    )?.[1];
  expect(section).toBeDefined();
  const parts =
    /exactly three parts:\n\n1\. ([\s\S]*?)\n2\. ([\s\S]*?)\n3\. ([\s\S]*?)\n\n/.exec(
      section ?? "",
    );
  expect(parts?.[1]).toContain("The directory `src/browser/contract/`");
  expect(parts?.[2]).toContain("`browserContract`");
  expect(parts?.[3]).toContain("`src/browser/people/holds.ts`");
  expect(parts?.[3]).toContain("49d54c9");
  expect(parts?.[3]).toContain("`apps/server/src/lazurio/holders.ts`");
  for (const name of copiedFunctions)
    expect(parts?.[3]).toContain(`\`${name}\``);
});
