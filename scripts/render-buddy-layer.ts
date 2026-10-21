// Renders Buddy's Lazurio layer, the files a Folder holds in `.agents/buddy/`
// (decision F14's addendum of 2026-10-21), into a new or empty directory:
//
//   bun run scripts/render-buddy-layer.ts --out <directory> [--locale cs|en]
//
// The bytes are the ones every Environment's Folder renders for that locale,
// whatever its voice (tests/folder-buddy.test.ts holds them equal), so an
// install that places them before its Folder renders the layer itself is
// adopted unchanged. Prints the written paths, relative to the directory, as
// JSON.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderBuddyLayer } from "../src/folder/buddy";
import { buddyLayerPaths } from "../src/folder/outputs";
import { presetProfile } from "../src/folder/presets";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    locale: { type: "string", default: "cs" },
  },
  strict: true,
});
const locale = values.locale;
if (values.out === undefined || (locale !== "cs" && locale !== "en")) {
  console.error(
    "Usage: bun run scripts/render-buddy-layer.ts --out <directory> [--locale cs|en]",
  );
  process.exit(2);
}
const out = isAbsolute(values.out) ? values.out : resolve(values.out);
await mkdir(out, { recursive: true, mode: 0o700 });
if ((await readdir(out)).length !== 0) {
  console.error(`Refusing a non-empty directory: ${out}`);
  process.exit(2);
}
const rendered = renderBuddyLayer({
  preset: "local",
  machine: null,
  profile: presetProfile("local", "linux", { locale }),
});
const prefix = ".agents/buddy/";
for (const path of buddyLayerPaths) {
  const target = join(out, path.slice(prefix.length));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, rendered[path], { flag: "wx", mode: 0o600 });
}
console.log(
  JSON.stringify({
    directory: out,
    files: buddyLayerPaths.map((path) => path.slice(prefix.length)),
  }),
);
