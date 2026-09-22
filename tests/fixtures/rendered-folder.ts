import { join } from "node:path";
import { outputFile, outputPaths } from "../../src/folder/outputs";
import { outputDigests, previewFolder } from "../../src/folder/preview";
import { mkdirOwnedFixture, writeOwnedFixture } from "./owned-files";

// A hand-built Folder at revision 1 as the initializer would leave it: every
// generated output at its place, `.lazurio/` with preferences and manifest.
// Tests that exercise the transaction directly start from this.
export async function writeRenderedFolder(
  folder: string,
  source: { preset: string; machine: unknown; profile: unknown },
) {
  const state = join(folder, ".lazurio");
  const preview = await previewFolder(source, null, async () => ({
    kind: "absent",
  }));
  await mkdirOwnedFixture(join(folder, "manual"));
  for (const path of outputPaths) {
    const { directory, name } = outputFile(folder, path);
    await writeOwnedFixture(
      join(directory, name),
      preview.desired[path].content,
    );
  }
  const preferences = JSON.stringify({
    schemaVersion: 2,
    revision: 1,
    preset: { name: source.preset, version: 1, selection: "derived" },
    machine: source.machine,
    profile: source.profile,
    customInstructions: "",
  });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    preferenceRevision: 1,
    templateRevision: preview.templateRevision,
    outputs: outputDigests(preview.desired),
  });
  await writeOwnedFixture(join(state, "preferences.json"), preferences);
  await writeOwnedFixture(join(state, "instructions.json"), manifest);
  return { preview, preferences, manifest };
}
