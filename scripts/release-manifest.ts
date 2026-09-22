import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { productOrigin, updateTargets } from "../src/update/identity";
import {
  artifactFile,
  manifestFile,
  renderManifest,
  sha256Hex,
} from "../src/update/manifest";

/** Writes `manifest.json` of one release over the executables of EVERY target
 * in a directory (docs/update.md "Publishing"). The client parses exactly what
 * this writes: both sides share `src/update/manifest.ts`.
 *
 *   bun run scripts/release-manifest.ts --version <X.Y.Z> --commit <sha> --directory <absolute directory>
 */

/** The oldest installed version able to perform an update to this release:
 * the first release whose updater exists, `v0.1.0-rc.1`. A prerelease orders
 * below its final version (`0.1.0-rc.2 < 0.1.0`), so a value of `0.1.0` made
 * every release-candidate client report `reinstall-required` for `v0.1.0`
 * (evidence/release-v0.1.0-2026-09-22.md). Raise it ONLY when the update
 * protocol changes so that an older client can no longer verify or activate a
 * release; that client then reports `reinstall-required` instead of failing in
 * the middle.
 */
export const minimumUpdaterVersion = "0.1.0-rc.1";

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      directory: { type: "string" },
    },
  });
  const { version = "", commit = "", directory = "" } = values;
  if (!isAbsolute(directory))
    throw new Error(
      "Usage: --version <X.Y.Z> --commit <sha> --directory <absolute directory>",
    );
  const targets: Record<string, { sha256: string; size: number }> = {};
  for (const target of updateTargets) {
    const file = join(directory, artifactFile(target));
    targets[target] = {
      sha256: sha256Hex(await readFile(file)),
      size: (await stat(file)).size,
    };
  }
  await writeFile(
    join(directory, manifestFile),
    renderManifest({
      version,
      sourceCommit: commit,
      minimumUpdaterVersion,
      repository: productOrigin.repository,
      targets,
    }),
    { flag: "wx" },
  );
  console.log(`Wrote ${join(directory, manifestFile)} for ${version}`);
}
