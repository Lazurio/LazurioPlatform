import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createUpdateFixture } from "./update-fixture";

/** The signed loopback fixture repository as a long-running process, for
 * native qualification on a Machine where no test runner exists
 * (`scripts/qualify-update-linux.sh`). Keys are generated at start and never
 * leave the process; everything is served on 127.0.0.1. Not a publisher.
 *
 *   serve   --state <dir> --target <linux-arm64|…> --commit <40 hex>
 *           --artifact <version>=<file> [--artifact …]
 *           writes <dir>/root.json and <dir>/fixture.env, then serves until killed
 *   release --control <url> --version <version> --sequence <n>
 *           publishes a new generation whose stable channel names <version>
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

if (
  positionals[0] !== "serve" ||
  !values.state ||
  !values.target ||
  !/^[0-9a-f]{40}$/.test(values.commit ?? "") ||
  !values.artifact?.length
)
  throw new Error("serve needs --state, --target, --commit and --artifact");

const fixture = createUpdateFixture({ executionTarget: values.target });
const digests = new Map<string, string>();
for (const entry of values.artifact) {
  const [version, file] = entry.split("=", 2);
  if (!version || !file) throw new Error("--artifact <version>=<file>");
  const artifact = fixture.addArtifact({
    bytes: await readFile(file),
    version,
    identity: { sourceCommit: values.commit, toolchain: `bun@${Bun.version}` },
  });
  digests.set(version, artifact.sha256);
}
fixture.publish();

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const version = url.searchParams.get("version") ?? "";
    const sequence = Number(url.searchParams.get("sequence"));
    const artifactSha256 = digests.get(version);
    if (
      request.method !== "POST" ||
      url.pathname !== "/release" ||
      !artifactSha256 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      return new Response("refused", { status: 400 });
    fixture.release("stable", { sequence, version, artifactSha256 });
    return new Response(
      `released ${version} as stable sequence ${sequence} (generation ${fixture.version()})`,
    );
  },
});

await writeFile(join(values.state, "root.json"), fixture.bootstrapRoot, {
  mode: 0o600,
});
await writeFile(
  join(values.state, "fixture.env"),
  [
    `METADATA_URL=${fixture.metadataBaseUrl}`,
    `TARGET_URL=${fixture.targetBaseUrl}`,
    `CONTROL_URL=${control.url.href}`,
    "",
  ].join("\n"),
);
console.log("fixture ready");
