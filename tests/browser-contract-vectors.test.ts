import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import * as node from "../src/browser/contract/node";
import * as pure from "../src/browser/contract/pure";

// The Environment browser's contract (decision F50 point 4): its executable
// vectors are its truth. This runs every case of
// `src/browser/contract/vectors/v1/` against the module, as the vectors'
// README describes the cases, fails when an export has no case or a case
// names no export, pins the module's exported names, as
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

type Case = Readonly<{
  name: string;
  call: string;
  args?: readonly unknown[];
  expect?: unknown;
  directory?: Readonly<Record<string, unknown>>;
  alive?: readonly number[];
  daemon?: Daemon;
  heard?: readonly string[];
  after?: Readonly<
    Record<string, Readonly<{ text?: string; json?: unknown; mode?: string }>>
  >;
  steps?: readonly Step[];
}>;

type Daemon = Readonly<{
  socket: string;
  reply: string | null;
  removes?: readonly string[];
  locks?: boolean;
  unreadable?: boolean;
}>;

type Step = Readonly<{
  directory?: Readonly<Record<string, unknown>>;
  expect?: unknown;
  write?: string;
  changed?: boolean;
  mkdir?: string;
  retry?: boolean;
}>;

type VectorFile = Readonly<{
  schema: string;
  contract: string;
  cases: readonly Case[];
}>;

const files: readonly (VectorFile & { file: string })[] = readdirSync(
  vectorDirectory,
)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(
      readFileSync(join(vectorDirectory, file), "utf8"),
    ) as VectorFile),
  }));

const exported: Readonly<Record<string, unknown>> = { ...pure, ...node };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a case of the Node part runs and what it was given. */
type Context = {
  dir: string;
  alive: readonly number[];
  changes: number;
};

const noContext = (): Context => ({ dir: "", alive: [], changes: 0 });

const idOf = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");

/** A value of a case as the module takes it, or gives it where the value is
 * no object: what the README's markers stand for. */
function decode(value: unknown, context: Context): unknown {
  if (typeof value === "string") {
    if (value === "$alive") return (pid: number) => context.alive.includes(pid);
    if (value === "$read")
      return (path: string) => readFile(join(context.dir, path), "utf8");
    if (value === "$pid") return process.pid;
    if (value === "$changed")
      return () => {
        context.changes += 1;
      };
    return value.startsWith("$dir")
      ? `${context.dir}${value.slice("$dir".length)}`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => decode(item, context));
  if (!isRecord(value)) return value;
  if ("$" in value) {
    if (value.$ === "undefined") return undefined;
    throw new Error(`No value stands for ${String(value.$)}`);
  }
  if ("$map" in value && isRecord(value.$map))
    return new Map(
      Object.entries(value.$map).map(([key, item]) => [
        key,
        decode(item, context),
      ]),
    );
  if ("$json" in value) return JSON.stringify(decode(value.$json, context));
  if ("$repeat" in value)
    return String(value.$repeat).repeat(Number(value.times));
  if ("$ids" in value)
    return Array.from({ length: Number(value.$ids) }, (_, n) => idOf(n + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item, context)]),
  );
}

/** The result and the expectation as they are compared (the README's
 * rule): an object by the members the case names, since a release may add
 * members within v1; a list and a Map entry by entry; a JSON text the case
 * gives as `{"$json": value}` by its value; anything else as it is. */
function compared(
  actual: unknown,
  expected: unknown,
  context: Context,
): readonly [unknown, unknown] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [actual, decode(expected, context)];
    const pairs = Array.from(
      { length: Math.max(actual.length, expected.length) },
      (_, at) => compared(actual[at], expected[at], context),
    );
    return [pairs.map(([seen]) => seen), pairs.map(([, wanted]) => wanted)];
  }
  if (!isRecord(expected) || "$" in expected)
    return [actual, decode(expected, context)];
  if ("$repeat" in expected || "$ids" in expected)
    return [actual, decode(expected, context)];
  if ("$json" in expected) {
    if (typeof actual !== "string") return [actual, decode(expected, context)];
    let parsed: unknown;
    try {
      parsed = JSON.parse(actual);
    } catch {
      return [actual, decode(expected, context)];
    }
    return compared(parsed, expected.$json, context);
  }
  if ("$map" in expected && isRecord(expected.$map)) {
    if (!(actual instanceof Map)) return [actual, decode(expected, context)];
    const entries = expected.$map;
    const keys = [...new Set([...actual.keys(), ...Object.keys(entries)])];
    const pairs = keys.map(
      (key) => [key, compared(actual.get(key), entries[key], context)] as const,
    );
    return [
      new Map(pairs.map(([key, [seen]]) => [key, seen])),
      new Map(pairs.map(([key, [, wanted]]) => [key, wanted])),
    ];
  }
  if (!isRecord(actual)) return [actual, decode(expected, context)];
  const seen: Record<string, unknown> = {};
  const wanted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expected))
    [seen[key], wanted[key]] = compared(actual[key], value, context);
  return [seen, wanted];
}

/** The result as the case expects it. */
function expectMatch(actual: unknown, expected: unknown, context: Context) {
  const [seen, wanted] = compared(actual, expected, context);
  expect(seen).toEqual(wanted);
}

const throws = (value: unknown) => isRecord(value) && value.$ === "throws";

/** Lays out a directory as a case describes it, files first, then the
 * modes, so a file can live in a directory that cannot be listed. */
async function layOut(
  context: Context,
  layout: Readonly<Record<string, unknown>>,
  locked: string[],
): Promise<void> {
  const unreadable: string[] = [];
  for (const [path, entry] of Object.entries(layout)) {
    const target = join(context.dir, path);
    if (path.endsWith("/")) {
      await mkdir(target, { recursive: true });
      if (isRecord(entry) && entry.unreadable === true) unreadable.push(target);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    if (isRecord(entry) && entry.unreadable === true) {
      await writeFile(target, String(entry.text ?? ""));
      unreadable.push(target);
    } else await writeFile(target, String(decode(entry, context)));
  }
  // Files before the directories that hold them.
  for (const path of unreadable.sort().reverse()) {
    await chmod(path, 0o000);
    locked.push(path);
  }
}

/** Every entry below the directory: files with their text, directories
 * with a slash, each with its mode. */
async function entriesOf(
  root: string,
  below = "",
): Promise<Record<string, Readonly<{ text?: string; mode: string }>>> {
  const found: Record<string, Readonly<{ text?: string; mode: string }>> = {};
  for (const name of (await readdir(join(root, below))).sort()) {
    const path = `${below}${name}`;
    const info = await lstat(join(root, path));
    const mode = (info.mode & 0o777).toString(8);
    if (info.isDirectory()) {
      found[`${path}/`] = { mode };
      Object.assign(found, await entriesOf(root, `${path}/`));
    } else
      found[path] = { text: await readFile(join(root, path), "utf8"), mode };
  }
  return found;
}

/** Starts the daemon a case describes, on its socket below the directory. */
async function listen(
  context: Context,
  daemon: Daemon,
  heard: string[],
  locked: string[],
): Promise<Server> {
  const path = join(context.dir, daemon.socket);
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      heard.push(buffer.slice(0, end));
      buffer = "";
      if (daemon.reply === null) {
        socket.end();
        return;
      }
      socket.write(`${daemon.reply}\n`);
      for (const file of daemon.removes ?? [])
        await rm(join(context.dir, file), { force: true });
      if (daemon.locks === true) {
        await chmod(context.dir, 0o000);
        locked.push(context.dir);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  if (daemon.unreadable === true) {
    await chmod(path, 0o000);
    locked.push(path);
  }
  return server;
}

/** Waits until `ready` or 5 s have passed, writing `path` meanwhile: a watch
 * may miss a change made the instant it starts (macOS). */
async function writeUntil(path: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (let n = 0; !ready(); n++) {
    if (Date.now() > deadline) throw new Error(`no change seen for ${path}`);
    await writeFile(path, `{"n":${n}}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Call = (...args: unknown[]) => unknown;

async function runNodeCase(entry: Case, call: Call): Promise<void> {
  const context: Context = {
    dir: await mkdtemp(join(tmpdir(), "browser-contract-")),
    alive: entry.alive ?? [],
    changes: 0,
  };
  const locked: string[] = [];
  const servers: Server[] = [];
  const heard: string[] = [];
  try {
    await layOut(context, entry.directory ?? {}, locked);
    if (entry.daemon !== undefined)
      servers.push(await listen(context, entry.daemon, heard, locked));
    const args = decode(entry.args ?? [], context) as unknown[];
    if (throws(entry.expect)) {
      let threw = false;
      try {
        await call(...args);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      return;
    }
    const result: unknown = await call(...args);
    if (entry.steps === undefined) expectMatch(result, entry.expect, context);
    else await runSteps(context, entry.steps, result);
    if (entry.heard !== undefined) expect(heard).toEqual([...entry.heard]);
    if (entry.after !== undefined) {
      const after = await entriesOf(context.dir);
      expect(Object.keys(after).sort()).toEqual(
        Object.keys(entry.after).sort(),
      );
      for (const [path, wanted] of Object.entries(entry.after)) {
        if (wanted.text !== undefined)
          expect(after[path]?.text).toBe(wanted.text);
        if (wanted.json !== undefined)
          expectMatch(after[path]?.text, { $json: wanted.json }, context);
        if (wanted.mode !== undefined)
          expect(after[path]?.mode).toBe(wanted.mode);
      }
    }
  } finally {
    for (const path of locked.reverse())
      await chmod(path, 0o700).catch(() => undefined);
    for (const server of servers)
      await new Promise((resolve) => server.close(resolve));
    await rm(context.dir, { recursive: true, force: true });
  }
}

async function runSteps(
  context: Context,
  steps: readonly Step[],
  result: unknown,
): Promise<void> {
  const watch = isRecord(result) ? result : null;
  try {
    for (const step of steps) {
      if (step.directory !== undefined) {
        for (const name of await readdir(context.dir))
          await rm(join(context.dir, name), { recursive: true, force: true });
        await layOut(context, step.directory, []);
      }
      if (typeof result === "function")
        expectMatch(await result(), step.expect, context);
      if (step.mkdir !== undefined)
        await mkdir(join(context.dir, step.mkdir), { recursive: true });
      if (step.retry === true && typeof watch?.retry === "function")
        watch.retry();
      if (step.write !== undefined) {
        const before = context.changes;
        await writeUntil(
          join(context.dir, step.write),
          () => step.changed !== true || context.changes > before,
        );
      }
    }
  } finally {
    if (typeof watch?.stop === "function") watch.stop();
  }
}

// A daemon listens on a Unix socket, which Windows lacks, as the other tests
// of letting go skip it.
const needsSockets = (entry: Case) => entry.daemon !== undefined;

for (const file of files)
  describe(`${file.contract} (${file.file})`, () => {
    for (const entry of file.cases) {
      const name = `${entry.call}: ${entry.name}`;
      const run = test.skipIf(
        process.platform === "win32" && needsSockets(entry),
      );
      run(
        name,
        async () => {
          const target = exported[entry.call];
          if (typeof target !== "function") {
            // A value export: the case expects the value.
            expect(entry.args).toBeUndefined();
            expectMatch(target, entry.expect, noContext());
            return;
          }
          const call = target as Call;
          if (entry.call in node) {
            await runNodeCase(entry, call);
            return;
          }
          // The pure part touches nothing: no directory, no daemon.
          const context = noContext();
          const args = decode(entry.args ?? [], context) as unknown[];
          if (throws(entry.expect)) {
            expect(() => call(...args)).toThrow();
            return;
          }
          expectMatch(call(...args), entry.expect, context);
        },
        30_000,
      );
    }
  });

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
