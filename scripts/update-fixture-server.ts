import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { folderStateSchemas } from "../src/folder/state";
import { generateSigner } from "../src/publish/keys";
import { addRelease, promote } from "../src/publish/repository";
import { initialRoot } from "../src/publish/root";
import { applyPlan, directoryTree, hashFile } from "../src/publish/tree";

/** A signed loopback repository as a long-running process, for native
 * qualification on a Machine where no test runner exists
 * (`scripts/qualify-update-linux.sh`).
 *
 * The repository is produced by the PUBLISHER (`src/publish/`), exactly as the
 * release workflow produces the real one: each release is `add-release` into
 * `preview` followed by `promote` to `stable`, written into a directory tree
 * that is then served as static files — what GitHub Pages does. Executables
 * are hosted inside the tree (no release-asset origin exists on loopback).
 * Keys are generated at start, live only in this process and sign nothing
 * real; everything is served on 127.0.0.1.
 *
 *   serve   --state <dir> --target <linux-arm64|…> --commit <40 hex>
 *           --artifact <version>=<file> [--artifact …]
 *           writes <dir>/root.json and <dir>/fixture.env, then serves until killed
 *   release --control <url> --version <version> --sequence <n>
 *           publishes <version> to preview and promotes it to stable; <n> is
 *           the stable sequence the caller expects and is checked, not chosen
 */
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  options: {
    state: { type: "string" },
    target: { type: "string" },
    commit: { type: "string" },
    artifact: { type: "string", multiple: true },
    control: { type: "string" },
    version: { type: "string" },
    sequence: { type: "string" },
  },
});

if (positionals[0] === "release") {
  if (!values.control || !values.version || !values.sequence)
    throw new Error("release needs --control, --version and --sequence");
  const response = await fetch(
    `${values.control}release?version=${encodeURIComponent(values.version)}&sequence=${encodeURIComponent(values.sequence)}`,
    { method: "POST" },
  );
  console.log(await response.text());
  process.exit(response.ok ? 0 : 1);
}

const state = values.state ?? "";
const target = values.target ?? "";
const commit = values.commit ?? "";
if (
  positionals[0] !== "serve" ||
  !isAbsolute(state) ||
  resolve(state) !== state ||
  !target ||
  !/^[0-9a-f]{40}$/.test(commit) ||
  !values.artifact?.length
)
  throw new Error("serve needs --state, --target, --commit and --artifact");

const files = new Map<string, string>();
for (const entry of values.artifact) {
  const [version, file] = entry.split("=", 2);
  if (!version || !file) throw new Error("--artifact <version>=<file>");
  files.set(version, file);
}

const signers = {
  root: generateSigner(),
  targets: generateSigner(),
  snapshot: generateSigner(),
  timestamp: generateSigner(),
};
const root = initialRoot({
  keys: {
    root: [signers.root.key],
    targets: [signers.targets.key],
    snapshot: [signers.snapshot.key],
    timestamp: [signers.timestamp.key],
  },
  rootSigner: signers.root,
  now: new Date(),
});
const treeDirectory = join(state, "tree");
await mkdir(treeDirectory, { recursive: true, mode: 0o700 });
const tree = directoryTree(treeDirectory);

/** What the release workflow does for one tag, then what `promote` does. */
async function release(version: string): Promise<number> {
  const file = files.get(version);
  if (!file) throw new Error("unknown version");
  const { sha256, length } = await hashFile(file);
  const options = { signers, now: new Date(), root };
  await applyPlan(
    treeDirectory,
    await addRelease(
      tree,
      {
        channel: "preview",
        version,
        notes: `Qualification release ${version}.`,
        artifacts: [
          {
            target,
            sha256,
            length,
            file,
            identity: Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                version,
                target,
                sourceCommit: commit,
                toolchain: `bun@${Bun.version}`,
                schemas: folderStateSchemas,
                artifactSha256: sha256,
                artifactBytes: length,
              }),
            ),
          },
        ],
      },
      options,
    ),
  );
  const promoted = await promote(tree, { version }, options);
  await applyPlan(treeDirectory, promoted);
  return promoted.result.sequence;
}

const repository = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.split("/").includes(".."))
      return new Response(null, { status: 400 });
    const file = Bun.file(join(treeDirectory, path));
    return (await file.exists())
      ? new Response(file)
      : new Response("not found", { status: 404 });
  },
});

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const version = url.searchParams.get("version") ?? "";
    const expected = Number(url.searchParams.get("sequence"));
    if (
      request.method !== "POST" ||
      url.pathname !== "/release" ||
      !files.has(version)
    )
      return new Response("refused", { status: 400 });
    try {
      const sequence = await release(version);
      if (sequence !== expected)
        return new Response(
          `released ${version}, but as stable sequence ${sequence}, not ${expected}`,
          { status: 409 },
        );
      return new Response(`released ${version} as stable sequence ${sequence}`);
    } catch (error) {
      return new Response(
        `refused: ${error instanceof Error ? error.message : "failed"}`,
        { status: 400 },
      );
    }
  },
});

await writeFile(join(state, "root.json"), root, { mode: 0o600 });
await writeFile(
  join(state, "fixture.env"),
  [
    `METADATA_URL=${repository.url}metadata/`,
    `TARGET_URL=${repository.url}targets/`,
    `CONTROL_URL=${control.url.href}`,
    "",
  ].join("\n"),
);
console.log("fixture ready");
