import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderBuddyLayer } from "../../src/folder/buddy";
import { buddyLayerPaths } from "../../src/folder/outputs";
import { readFolderState } from "../../src/folder/read-state";
import { instructionSource } from "../../src/folder/render";

/** Buddy GEN3's Lazurio layer in `.agents/buddy/` as an earlier release
 * wrote it into `folder`, rendered from the Folder's own preferences. The
 * Folder no longer writes it (plan LZD-0033), while Buddy GEN3's own code
 * in `src/buddy/` still reads such a copy until it is removed. */
export async function writeEarlierBuddyLayer(folder: string): Promise<void> {
  const { preferences } = await readFolderState(join(folder, ".lazurio"));
  const rendered = renderBuddyLayer(instructionSource(preferences));
  for (const path of buddyLayerPaths) {
    const file = join(folder, path);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, rendered[path], { mode: 0o600 });
  }
}
