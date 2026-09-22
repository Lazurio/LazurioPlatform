import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPreparation,
  finalizePreparation,
} from "../src/folder/apply-preparation";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { executionOs } from "../src/folder/platform";
import { prepareProfileChange } from "../src/folder/prepare-profile-change";
import { previewFolder } from "../src/folder/preview";
import { retireIncompletePreparation } from "../src/folder/retire-preparation";

// Compile this fixture runner for the target OS. It accepts no user path and
// only creates/removes its own fresh temporary directory; it is not an installer.
assert.equal(process.argv.length, 2, "No arguments supported");
const folder = await realpath(
  await mkdtemp(join(tmpdir(), "lazurio-transaction-smoke-")),
);
try {
  const state = join(folder, ".lazurio");
  await mkdir(state, { mode: 0o700 });
  const profile = {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  };
  const initial = await previewFolder(
    { preset: "local", machine: null, profile },
    null,
    async () => ({ kind: "absent" }),
  );
  await writeFile(join(folder, "AGENTS.md"), initial.desired.content, {
    mode: 0o600,
  });
  await writeFile(
    join(state, "preferences.json"),
    JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      preset: { name: "local", version: 1, selection: "derived" },
      machine: null,
      profile,
      customInstructions: "",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(state, "instructions.json"),
    JSON.stringify({
      schemaVersion: 1,
      preferenceRevision: 1,
      templateRevision: initial.templateRevision,
      output: { path: "AGENTS.md", digest: initial.desired.digest },
    }),
    { mode: 0o600 },
  );
  for (const name of ["organizations", "personalspace"]) {
    await mkdir(join(folder, name));
    await writeFile(join(folder, name, "owned-work"), `Synthetic ${name} work`);
  }
  const requested = { profile: { ...profile, locale: "cs" } };
  await assert.rejects(
    prepareProfileChange(folder, 1, requested, async (step) => {
      if (step === "manifest")
        throw new Error("Injected preparation interruption");
    }),
    /Injected preparation interruption/,
  );
  assert.equal(
    (await retireIncompletePreparation(folder, 1, "c".repeat(32))).kind,
    "incomplete-preparation-retained",
  );
  assert.equal(
    await readFile(join(folder, "AGENTS.md"), "utf8"),
    initial.desired.content,
  );
  assert.equal(
    (await prepareProfileChange(folder, 1, requested)).kind,
    "prepared",
  );
  await assert.rejects(
    applyPreparation(folder, async (step) => {
      if (step === "renamed:AGENTS.md")
        throw new Error("Injected application interruption");
    }),
    /Injected application interruption/,
  );
  assert.equal((await applyPreparation(folder)).revision, 2);
  await assert.rejects(
    finalizePreparation(folder, 2, async (step) => {
      if (step === "archived") throw new Error("Injected archive interruption");
    }),
    /Injected archive interruption/,
  );
  assert.equal((await finalizePreparation(folder, 2)).kind, "finalized");
  assert.equal(
    (await inspectProfileChange(folder, 2, requested)).kind,
    "unchanged",
  );
  assert.equal(
    (await prepareProfileChange(folder, 2, { profile })).kind,
    "prepared",
  );
  await writeFile(join(folder, "AGENTS.md"), "Manual edit must survive");
  await assert.rejects(applyPreparation(folder), /conflicts/);
  assert.equal(
    await readFile(join(folder, "AGENTS.md"), "utf8"),
    "Manual edit must survive",
  );
  assert.equal(
    JSON.parse(await readFile(join(state, "preferences.json"), "utf8"))
      .revision,
    2,
  );
  for (const name of ["organizations", "personalspace"]) {
    assert.equal(
      await readFile(join(folder, name, "owned-work"), "utf8"),
      `Synthetic ${name} work`,
    );
  }
  console.log(
    `PASS: ${process.platform}/${process.arch} fixture prepare/retire/apply/resume/finalize, drift refusal and unrelated-byte preservation`,
  );
} finally {
  await rm(folder, { recursive: true, force: true });
}
