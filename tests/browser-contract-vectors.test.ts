import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import * as node from "../src/browser/contract/node";
import * as pure from "../src/browser/contract/pure";
import {
  describeVectors,
  readVectorFiles,
} from "./fixtures/browser-contract-vectors";

// The Environment browser's contract (decision F50 point 4): its executable
// vectors are its truth. This runs every case of
// `src/browser/contract/vectors/v1/` against the module, as the vectors'
// README describes the cases (the runner is
// tests/fixtures/browser-contract-vectors.ts), fails when an export has no
// case or a case names no export, pins the module's exported names, as
// tests/shell-interface.test.ts pins interface v1, and keeps the module's
// boundary (points 1 and 6). A fork runs the same files against its copy.

const moduleDirectory = join(
  import.meta.dir,
  "..",
  "src",
  "browser",
  "contract",
);
const vectorDirectory = join(moduleDirectory, "vectors", "v1");

const files = readVectorFiles(vectorDirectory);

const exported: Readonly<Record<string, unknown>> = { ...pure, ...node };

describeVectors(files, { pure, node });

test("every vector file is a v1 vector file of its contract, and each case names its call once", () => {
  expect(files.map((file) => file.file)).toEqual([
    "agent-browser.json",
    "boot-clock.json",
    "holder-files.json",
    "live-tabs.json",
    "remote-tab-ids.json",
    "strips.json",
    "view-addresses.json",
  ]);
  for (const file of files) {
    expect(file.schema).toBe("lazurio.browser-vectors.v1");
    expect(`${file.contract}.json`).toBe(file.file);
    expect(file.cases.length).toBeGreaterThan(0);
    const named = file.cases.map((entry) => `${entry.call}: ${entry.name}`);
    expect(new Set(named).size).toBe(named.length);
    for (const entry of file.cases) {
      expect(typeof entry.name).toBe("string");
      expect("expect" in entry || entry.steps !== undefined).toBe(true);
      // A function is called with its arguments; a value has none.
      expect(Array.isArray(entry.args)).toBe(
        typeof exported[entry.call] === "function",
      );
    }
  }
});

test("every export of the contract has a case, and every case names an export", () => {
  const called = new Set(
    files.flatMap((file) => file.cases.map((entry) => entry.call)),
  );
  expect(Object.keys(exported).filter((name) => !called.has(name))).toEqual([]);
  expect([...called].filter((name) => !(name in exported))).toEqual([]);
  // The two parts name nothing twice.
  expect(Object.keys(pure).filter((name) => name in node)).toEqual([]);
});

// Decision F50 point 1: the module's exported names are pinned, as
// tests/shell-interface.test.ts pins interface v1. Within v1 a release may
// add names (with their cases), never rename or remove one.
test("the contract's exported names are exactly these", () => {
  expect(Object.keys(pure).sort()).toEqual([
    "browserViewUrl",
    "environmentIdOf",
    "holderFileText",
    "holderSchema",
    "isEnvironmentId",
    "isStrip",
    "isTargetId",
    "isViewHost",
    "keptTabs",
    "launchpadStrip",
    "liveTabsSchema",
    "liveTabsText",
    "parseBootTime",
    "parseHolder",
    "parseHolderRecords",
    "parseLiveTabs",
    "stripAppOf",
    "stripPrefixes",
    "targetIdOf",
    "threadSession",
    "viewAddressOf",
    "viewPath",
    "viewPathTab",
  ]);
  expect(Object.keys(node).sort()).toEqual([
    "agentBrowserSocketDirectory",
    "askDaemonSocket",
    "holderDirectory",
    "holdsReader",
    "liveTabsPath",
    "noHolds",
    "noHoldsMemory",
    "processAlive",
    "readBootClock",
    "readHolds",
    "replaceOwnerFile",
    "stopSessionDaemon",
    "unreadableHolderFiles",
    "watchHolds",
    "writeLiveTabs",
  ]);
});

// Decision F50 points 1 and 6: everything the forks take lies inside the
// module's directory, so it imports nothing from outside it. Its pure part
// imports nothing at all and its Node part only `node:` built-ins and the pure
// part.
test("the module imports nothing from outside its directory, and its pure part nothing", () => {
  const sources = readdirSync(moduleDirectory)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  expect(sources).toEqual(["node.ts", "pure.ts"]);
  const importsOf = (file: string) =>
    new Bun.Transpiler({ loader: "ts" })
      .scan(readFileSync(join(moduleDirectory, file), "utf8"))
      .imports.map((found) => found.path);
  expect(importsOf("pure.ts")).toEqual([]);
  expect(
    importsOf("node.ts").filter(
      (path) => !path.startsWith("node:") && path !== "./pure",
    ),
  ).toEqual([]);
});

// The pure part runs in a page, in Node and in Bun: it type-checks with the
// language alone and the standard URL, without the DOM's, Node's or Bun's
// declarations, so it reads no `process`, `Buffer`, `Bun` or `document`.
test("the pure part needs no runtime built-in but URL", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "browser-contract-types-"));
  try {
    const url = join(scratch, "url.d.ts");
    await writeFile(
      url,
      [
        "declare class URL {",
        "  constructor(url: string, base?: string);",
        "  readonly href: string;",
        "  readonly origin: string;",
        "  readonly protocol: string;",
        "  readonly username: string;",
        "  readonly password: string;",
        "  readonly host: string;",
        "  readonly hostname: string;",
        "  readonly port: string;",
        "  readonly pathname: string;",
        "  readonly search: string;",
        "  readonly hash: string;",
        "}",
        "",
      ].join("\n"),
    );
    const program = ts.createProgram([join(moduleDirectory, "pure.ts"), url], {
      lib: ["lib.es2022.d.ts"],
      types: [],
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        ),
    ).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);
