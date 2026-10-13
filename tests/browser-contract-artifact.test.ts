import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  browserContractDirectory,
  buildShellArtifact,
} from "../scripts/release-shell";
import * as node from "../src/browser/contract/node";
import * as pure from "../src/browser/contract/pure";
import { sha256Hex } from "../src/update/manifest";
import {
  describeVectors,
  readVectorFiles,
} from "./fixtures/browser-contract-vectors";
import { tarEntries } from "./fixtures/ustar";

// Decision F50 point 5: the forks take the Environment browser's contract
// from the release's shell artifact. This builds the archive as the release
// does, unpacks into a directory of its own only the regular files that
// artifact.json lists under browserContract, each checked against the SHA-256
// `files` lists for it, as a fork's vendoring does, imports both parts from
// there and runs every vector the archive carries against them.

const archive = await buildShellArtifact({
  version: "1.2.3-rc.4",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
});
const entries = new Map(
  tarEntries(archive).map((entry) => [entry.header.path, entry]),
);
const listing = JSON.parse(
  new TextDecoder().decode(entries.get("artifact.json")?.data),
) as {
  browserContract: { major: number; files: string[] };
  files: Record<string, string>;
};

const unpacked = await mkdtemp(join(tmpdir(), "browser-contract-artifact-"));
afterAll(() => rm(unpacked, { recursive: true, force: true }));
for (const path of listing.browserContract.files) {
  const entry = entries.get(path);
  if (
    entry?.header.type !== "0" ||
    sha256Hex(entry.data) !== listing.files[path]
  )
    throw new Error(`${path} is not the regular file artifact.json lists`);
  await mkdir(dirname(join(unpacked, path)), { recursive: true });
  await writeFile(join(unpacked, path), entry.data);
}

const contract = join(unpacked, browserContractDirectory);
const packed = {
  pure: (await import(join(contract, "pure.js"))) as Record<string, unknown>,
  node: (await import(join(contract, "node.js"))) as Record<string, unknown>,
};
const vectors = readVectorFiles(
  join(contract, "vectors", `v${listing.browserContract.major}`),
);

describeVectors(vectors, packed, "the shell artifact's module");

test("the packed parts export exactly the module's names, and their vectors are the module's", () => {
  expect(Object.keys(packed.pure).sort()).toEqual(Object.keys(pure).sort());
  expect(Object.keys(packed.node).sort()).toEqual(Object.keys(node).sort());
  expect(listing.browserContract.major).toBe(1);
  expect(vectors.map((file) => file.file)).toEqual(
    readVectorFiles(
      join(
        import.meta.dir,
        "..",
        "src",
        "browser",
        "contract",
        "vectors",
        "v1",
      ),
    ).map((file) => file.file),
  );
});
