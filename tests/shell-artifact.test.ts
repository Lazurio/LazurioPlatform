import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import ts from "typescript";
import {
  buildShellArtifact,
  shellArtifactFile,
} from "../scripts/release-shell";
import { privatePage, shellSource } from "../src/launchpad/page";
import * as contract from "../src/shell/contract";
import { shellFonts } from "../src/shell/fonts";
import { shellElementInterface } from "../src/shell/interface";
import { sha256Hex } from "../src/update/manifest";
import { accountDocument } from "./fixtures/account-document";

// Decision F36; docs/update.md "The shell artifact": every release attaches
// `lazurio-shell.tar.gz`, the shell of that release, for a host outside an
// Environment (the Lazurio Dashboard) to pin by its tag and digest. What such
// a host relies on: the bytes are the ones every Environment of the release
// serves, `artifact.json` lists them, a standard tar reads the archive, the
// contract runs and type-checks without a DOM, the same inputs give the same
// archive, and the release workflow attests and attaches it.

const posixTest = test.skipIf(process.platform === "win32");
const root = join(import.meta.dir, "..");
const vendor = join(root, "src", "shell", "vendor");
const release = {
  version: "1.2.3-rc.4",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
};

type Entry = Readonly<{
  header: Readonly<{
    path: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    type: string;
    magic: string;
    owner: string;
    group: string;
  }>;
  data: Uint8Array;
}>;

/** The entries of the archive as an independent reader sees them. */
function entries(archive: Uint8Array): Entry[] {
  const tar = new Uint8Array(gunzipSync(archive));
  const text = (block: Uint8Array, start: number, length: number) => {
    const bytes = block.subarray(start, start + length);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(
      end === -1 ? bytes : bytes.subarray(0, end),
    );
  };
  const octal = (block: Uint8Array, start: number, length: number) =>
    Number.parseInt(text(block, start, length), 8);
  const found: Entry[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = octal(block, 124, 12);
    found.push({
      header: {
        path: text(block, 0, 100),
        mode: octal(block, 100, 8),
        uid: octal(block, 108, 8),
        gid: octal(block, 116, 8),
        mtime: octal(block, 136, 12),
        type: text(block, 156, 1),
        magic: new TextDecoder().decode(block.subarray(257, 265)),
        owner: text(block, 265, 32),
        group: text(block, 297, 32),
      },
      data: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

let archive: Uint8Array = new Uint8Array();
let packed = new Map<string, Uint8Array>();
let scratch = "";
beforeAll(async () => {
  archive = await buildShellArtifact(release);
  packed = new Map(
    entries(archive).map((entry) => [entry.header.path, entry.data]),
  );
  scratch = await mkdtemp(join(tmpdir(), "shell-artifact-"));
}, 60_000);
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function bytesOf(path: string): Uint8Array {
  const bytes = packed.get(path);
  if (bytes === undefined) throw new Error(`${path} is not packed`);
  return bytes;
}

// A `lazurio.shell.v1` document of a workstation with one Organization,
// with example names only.
const shellDocument = () => ({
  schema: "lazurio.shell.v1",
  locale: "en",
  current: "local",
  operator: { initials: null, login: null, avatar: null },
  environments: [
    {
      id: "local",
      label: null,
      kind: "workstation",
      organizations: ["example"],
      assignee: null,
      apps: { apps: "/", chat: null, automate: null },
    },
  ],
  organizations: [
    {
      slug: "example",
      name: "Example Works",
      avatar: null,
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: "https://dashboard.lazurio.ai/add-organization",
});

test("the packed shell.js is the script the Launchpad embeds, byte for byte", () => {
  // `shellSource` is the macro's string, built when this test loaded the
  // page module; the asset calls the same function plainly.
  expect(sha256Hex(bytesOf("shell.js"))).toBe(
    sha256Hex(new TextEncoder().encode(shellSource)),
  );
});

posixTest(
  "the packed script and fonts are the bytes the Launchpad serves under /.lazurio/",
  async () => {
    await privatePage(async (get) => {
      const served = async (path: string) => {
        const answer = await get(path);
        expect(answer.status).toBe(200);
        return sha256Hex(new Uint8Array(await answer.arrayBuffer()));
      };
      expect(await served("/.lazurio/shell.js")).toBe(
        sha256Hex(bytesOf("shell.js")),
      );
      for (const { file } of shellFonts)
        expect(await served(`/.lazurio/fonts/${file}`)).toBe(
          sha256Hex(bytesOf(`fonts/${file}`)),
        );
    });
  },
);

test("the fonts are the vendored files with their licences, beside the licences of the Platform and of Iconoir", async () => {
  const fontLicences = (await readdir(join(vendor, "fonts"))).filter((name) =>
    name.startsWith("LICENSE-"),
  );
  expect(fontLicences.length).toBeGreaterThan(0);
  const sources: Record<string, string> = {
    LICENSE: join(root, "LICENSE"),
    NOTICE: join(root, "NOTICE"),
    "LICENSE-iconoir.txt": join(vendor, "LICENSE-iconoir.txt"),
    ...Object.fromEntries(
      [...shellFonts.map(({ file }) => file), ...fontLicences].map((name) => [
        `fonts/${name}`,
        join(vendor, "fonts", name),
      ]),
    ),
  };
  for (const [path, source] of Object.entries(sources))
    expect(`${path} ${sha256Hex(bytesOf(path))}`).toBe(
      `${path} ${sha256Hex(await readFile(source))}`,
    );
  // Besides them only the shell's own files and the listing.
  expect([...packed.keys()].sort()).toEqual(
    [
      ...Object.keys(sources),
      "artifact.json",
      "contract.d.ts",
      "contract.js",
      "shell.js",
    ].sort(),
  );
});

test("artifact.json names the release and lists every other packed file with its SHA-256", () => {
  expect(
    JSON.parse(new TextDecoder().decode(bytesOf("artifact.json"))),
  ).toEqual({
    schema: "lazurio.shell-artifact.v1",
    version: release.version,
    sourceCommit: release.sourceCommit,
    interface: shellElementInterface.version,
    files: Object.fromEntries(
      [...packed]
        .filter(([path]) => path !== "artifact.json")
        .map(([path, bytes]) => [path, sha256Hex(bytes)]),
    ),
  });
});

test("the same inputs give the same archive: sorted regular files, 0644, owner 0, time 0, a gzip header without time or operating system", async () => {
  const headers = entries(archive).map((entry) => entry.header);
  const paths = headers.map((header) => header.path);
  expect(paths).toEqual([...paths].sort());
  expect(headers).toEqual(
    paths.map((path) => ({
      path,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: 0,
      type: "0",
      magic: "ustar\u000000",
      owner: "",
      group: "",
    })),
  );
  // gzip: no time, no flags, no name, and 255, an unknown operating system.
  expect([...archive.subarray(0, 10)]).toEqual([
    0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255,
  ]);
  expect(sha256Hex(await buildShellArtifact(release))).toBe(sha256Hex(archive));
}, 60_000);

posixTest(
  "a standard tar unpacks exactly the packed files, without a warning",
  async () => {
    const directory = join(scratch, "unpacked");
    await mkdir(directory);
    const file = join(scratch, shellArtifactFile);
    await writeFile(file, archive);
    const result = Bun.spawnSync(["tar", "-xzf", file, "-C", directory], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const unpacked = [
      ...new Bun.Glob("**").scanSync({ cwd: directory, dot: true }),
    ].sort();
    expect(unpacked).toEqual([...packed.keys()].sort());
    for (const path of unpacked)
      expect(sha256Hex(await readFile(join(directory, path)))).toBe(
        sha256Hex(bytesOf(path)),
      );
  },
);

test("contract.js reads the documents in code without a DOM, as the source does", async () => {
  // The guard of this test: no DOM here, so any access would throw.
  expect("document" in globalThis).toBe(false);
  // One module on its own: nothing imported, so nothing of the elements.
  expect(
    new Bun.Transpiler({ loader: "js" }).scan(
      new TextDecoder().decode(bytesOf("contract.js")),
    ).imports,
  ).toEqual([]);
  const directory = join(scratch, "contract");
  await mkdir(directory);
  await writeFile(join(directory, "contract.js"), bytesOf("contract.js"));
  const packedContract = await import(join(directory, "contract.js"));
  expect(Object.keys(packedContract).sort()).toEqual(
    Object.keys(contract).sort(),
  );
  const shell = shellDocument();
  expect(packedContract.parseShell(shell)).not.toBeNull();
  expect(packedContract.parseShell(shell)).toEqual(contract.parseShell(shell));
  expect(
    packedContract.parseShell({ ...shell, schema: "lazurio.shell.v0" }),
  ).toBeNull();
  const account = accountDocument();
  expect(packedContract.parseShellAccount(account)).not.toBeNull();
  expect(packedContract.parseShellAccount(account)).toEqual(
    contract.parseShellAccount(account),
  );
  expect(
    packedContract.parseShellAccount(
      accountDocument({ schema: "lazurio.account.v0" }),
    ),
  ).toBeNull();
  // A host page with nobody signed in (F36's addendum of 2026-10-06).
  const signedOut = {
    schema: "lazurio.shell-signed-out.v1",
    locale: "en",
    signIn: "/auth/sign-in",
  };
  expect(packedContract.parseShellSignedOut(signedOut)).not.toBeNull();
  expect(packedContract.parseShellSignedOut(signedOut)).toEqual(
    contract.parseShellSignedOut(signedOut),
  );
  expect(packedContract.parseShellSignedOut(shell)).toBeNull();
  expect(packedContract.parseShell(signedOut)).toBeNull();
  expect(packedContract.dashboardSlug("Example")).toBe(
    contract.dashboardSlug("Example"),
  );
});

test("contract.d.ts types every export of contract.js for a host with neither DOM nor Bun types", async () => {
  const directory = join(scratch, "typed");
  await mkdir(directory);
  await writeFile(join(directory, "contract.js"), bytesOf("contract.js"));
  await writeFile(join(directory, "contract.d.ts"), bytesOf("contract.d.ts"));
  // A host module that imports every export by name and uses the types.
  const names = Object.keys(contract).sort().join(", ");
  const host = join(directory, "host.ts");
  await writeFile(
    host,
    [
      `import { ${names}, type Shell, type ShellAccount, type ShellSignedOut } from "./contract.js";`,
      `export const used = [${names}];`,
      "export const read = (value: unknown): readonly [Shell | null, ShellAccount | null, ShellSignedOut | null] =>",
      "  [parseShell(value), parseShellAccount(value), parseShellSignedOut(value)];",
      "",
    ].join("\n"),
  );
  const program = ts.createProgram([host], {
    lib: ["lib.esnext.d.ts"],
    types: [],
    strict: true,
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
}, 30_000);

test("the command writes the asset once into an absolute directory and refuses anything else", async () => {
  const place = join(scratch, "command");
  await mkdir(place);
  const run = (...args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(root, "scripts", "release-shell.ts"),
        ...args,
      ],
      { cwd: place, stdout: "pipe", stderr: "pipe" },
    ).exitCode;
  const named = [
    "--version",
    release.version,
    "--commit",
    release.sourceCommit,
  ];
  const out = join(place, "release");
  // As the publishing job runs it: the bytes of the build above.
  expect(run(...named, "--out", out)).toBe(0);
  expect(sha256Hex(await readFile(join(out, shellArtifactFile)))).toBe(
    sha256Hex(archive),
  );
  // A second run never replaces the asset.
  await writeFile(join(out, shellArtifactFile), "earlier");
  expect(run(...named, "--out", out)).not.toBe(0);
  expect(await readFile(join(out, shellArtifactFile), "utf8")).toBe("earlier");
  // Refused before anything is built or written.
  for (const args of [
    [...named, "--out", "relative"],
    [...named],
    [
      "--version",
      "v1.2.3",
      "--commit",
      release.sourceCommit,
      "--out",
      join(place, "a"),
    ],
    [
      "--version",
      release.version,
      "--commit",
      "abc1234",
      "--out",
      join(place, "b"),
    ],
    [...named, "--out", join(place, "c"), "--target", "linux-x64"],
  ])
    expect(run(...args)).not.toBe(0);
  expect(await readdir(place)).toEqual(["release"]);
}, 60_000);

type Step = Readonly<{
  uses?: string;
  run?: string;
  with?: Readonly<Record<string, string>>;
}>;

// A narrow static check of the trust entry point: the asset is built in the
// publishing job before its one attestation, is among that attestation's
// subjects, and is attached to the release.
test("the release workflow builds the asset before its one attestation, attests it and attaches it", async () => {
  const workflow = Bun.YAML.parse(
    await readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: { publish: { steps: Step[] } } };
  const steps = workflow.jobs.publish.steps;
  const built = steps.findIndex(
    ({ run }) => run?.includes("bun run scripts/release-shell.ts") ?? false,
  );
  const attest = steps.findIndex(
    ({ uses }) => uses?.startsWith("actions/attest@") ?? false,
  );
  expect(
    steps.filter(({ uses }) => uses?.startsWith("actions/attest@")).length,
  ).toBe(1);
  expect(built).toBeGreaterThan(-1);
  expect(built).toBeLessThan(attest);
  expect(steps[built]?.run).toContain(
    '--version "$VERSION" --commit "$GITHUB_SHA"',
  );
  expect(steps[built]?.run).toContain('--out "$RUNNER_TEMP/release"');
  expect(steps[attest]?.with?.["subject-path"]?.split("\n")).toContain(
    `\${{ runner.temp }}/release/${shellArtifactFile}`,
  );
  expect(
    steps.find(({ run }) => run?.includes("gh release create"))?.run,
  ).toContain(`"$RUNNER_TEMP/release/${shellArtifactFile}"`);
});
