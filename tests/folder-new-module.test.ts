import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
import { inspectPreparation } from "../src/folder/inspect-preparation";
import { withFolderOperationLock } from "../src/folder/lock";
import { renderManual } from "../src/folder/manual";
import {
  manifestOutputPaths,
  manualPaths,
  outputPaths,
} from "../src/folder/outputs";
import {
  type PreparationStep,
  prepareFolderChangeLocked,
} from "../src/folder/prepare-profile-change";
import { presetProfile, workspacePreset } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  instructionTemplateRevision,
  newModuleLine,
} from "../src/folder/render";
import { retireIncompletePreparation } from "../src/folder/retire-preparation";
import {
  folderStateSchemas,
  instructionManifestSchema,
  parseInstructionManifest,
} from "../src/folder/state";
import {
  refreshFolder,
  resumeProfileUpdate,
} from "../src/folder/update-profile";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import { moduleScaffoldStacks } from "../src/modules/scaffold";
import { journeys } from "./fixtures/journeys";
import { binding } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";

// The Folder's page for a new module (decision F14, addendum of 2026-10-14):
// what an agent does when the person says "Chci postavit nový modul". The
// page is the seventh manual file, so a Folder an earlier release rendered
// (manifest schema 2, six manual files) gains it in its next upgrade.

const page = "manual/new-module.md" as const;

function rendered(journey: (typeof journeys)[number], locale: "cs" | "en") {
  return renderOutputs({
    preset: journey.preset,
    machine: journey.machine,
    profile: presetProfile(journey.preset, journey.os, { locale }),
  });
}

test("the new-module page is a manual file in both locales, after Working here, and a manifest of schema 2 does not own it", () => {
  expect(manualPaths).toContain(page);
  expect(outputPaths.indexOf(page)).toBe(
    outputPaths.indexOf("manual/working-here.md") + 1,
  );
  expect(manifestOutputPaths[3]).toEqual(outputPaths);
  expect(manifestOutputPaths[2]).toEqual(
    outputPaths.filter((path) => path !== page),
  );
  expect(instructionManifestSchema).toBe(3);
  expect(folderStateSchemas.manifest).toEqual([2, 3]);
});

test("every Environment renders the new-module page in its locale: the trigger, the interview first, the agent's technical choices, the confirmations and the route its presets allow", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = rendered(journey, locale);
      const text = outputs[page];
      const cs = locale === "cs";
      const personal =
        workspacePreset(journey.preset).personalspace === "present";
      const organizations = journey.preset !== "hosted-personal";
      expect(text.startsWith(cs ? "# Nový modul\n" : "# A new module\n")).toBe(
        true,
      );
      expect(text).toContain(`<!-- ${instructionTemplateRevision}; `);
      // The trigger in both languages, whatever the Folder's locale.
      expect(text).toContain("Chci postavit nový modul");
      expect(text).toContain("I want to build a new module");
      // The interview first, one question at a time, and a confirmed summary.
      const interview = text.indexOf(
        cs ? "## 1. Rozhovor o účelu" : "## 1. The interview about the purpose",
      );
      expect(interview).toBeGreaterThan(0);
      for (const phrase of cs
        ? [
            "jaký problém má modul vyřešit",
            "kdo ho bude používat a kde",
            "odkud se berou data",
            "co se má dít samo",
            "dobrá první verze",
            "**Jedna otázka v jedné zprávě**",
            "**Na techniku se neptej.**",
            "počkej na jeho „ano“",
          ]
        : [
            "what problem the module is to solve",
            "who will use it and where",
            "where the data comes from",
            "what should happen on its own",
            "a good first version",
            "**One question per message**",
            "**Do not ask about technology.**",
            "wait for their “yes”",
          ])
        expect(text.indexOf(phrase)).toBeGreaterThan(interview);
      // The stacks the agent chooses from are exactly the generator's, in its
      // order, each explained in one line.
      const stacks = [...text.matchAll(/^- `([a-z-]+)`: /gm)].map(
        (match) => match[1],
      );
      expect(stacks.slice(0, moduleScaffoldStacks.length)).toEqual([
        ...moduleScaffoldStacks,
      ]);
      // The personal route, only where this Environment has a Personalspace.
      for (const command of [
        "lazurio module create personalspace/<slug> --stack <stack> --name '",
        "--dry-run --json",
        "--confirm <plan> --json",
        'worktree add -b <branch> "$PWD/personalspace/.worktrees/<task>" main',
        "gh repo view <login>/<slug> --json isPrivate,owner",
        "lazurio module start personalspace/<slug> --json",
        "`plan-changed`",
        "`personalspace_root_on_main`",
        "`create-uncertain`",
      ])
        expect(text.includes(command)).toBe(personal);
      expect(text.includes("`personalspace-not-here`")).toBe(!personal);
      // An Organization's module: said plainly, never improvised.
      expect(text.includes("`organization-form-unavailable`")).toBe(
        organizations,
      );
      expect(text.includes("Lazurio/LazurioPlatform#267")).toBe(organizations);
      // AGENTS.md points to the page, and its manual index lists it.
      expect(outputs["AGENTS.md"]).toContain(newModuleLine[locale]);
      expect(outputs["AGENTS.md"]).toContain(
        cs
          ? "- [Nový modul](manual/new-module.md) — "
          : "- [A new module](manual/new-module.md) — ",
      );
    }
});

test("the new-module page has the same sections in both languages on every preset", () => {
  for (const journey of journeys) {
    const page = (locale: "cs" | "en") =>
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      })["manual/new-module.md"].split("\n");
    const cs = page("cs");
    const en = page("en");
    expect(cs.length).toBe(en.length);
    expect(cs.map((line) => /^#+ /.exec(line)?.[0] ?? "")).toEqual(
      en.map((line) => /^#+ /.exec(line)?.[0] ?? ""),
    );
  }
});

test("a manifest of schema 2 owns exactly the outputs before the new-module page; schema 3 owns every output", () => {
  const digest = "a".repeat(64);
  const digests = (paths: readonly string[]) =>
    Object.fromEntries(paths.map((path) => [path, digest]));
  const manifest = (schemaVersion: number, paths: readonly string[]) => ({
    schemaVersion,
    preferenceRevision: 1,
    templateRevision: "base-instructions-50",
    outputs: digests(paths),
  });
  const older = parseInstructionManifest(manifest(2, manifestOutputPaths[2]));
  expect(older.schemaVersion).toBe(2);
  expect(Object.keys(older.outputs)).toEqual([...manifestOutputPaths[2]]);
  expect(parseInstructionManifest(manifest(3, outputPaths)).outputs[page]).toBe(
    digest,
  );
  // Each schema has one set: no page in a schema 3 manifest, or one in a
  // schema 2 manifest, and no other schema.
  expect(() => parseInstructionManifest(manifest(2, outputPaths))).toThrow();
  expect(() =>
    parseInstructionManifest(manifest(3, manifestOutputPaths[2])),
  ).toThrow();
  expect(() => parseInstructionManifest(manifest(4, outputPaths))).toThrow();
});

// A personal Remote Environment's Folder, as in the refresh tests.
const machine = binding(personal);
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

async function setup(locale: "cs" | "en" = "en") {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "folder-new-module-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeMachineFolder(folder, machine, { ...noChoices, locale });
  return { parent, folder };
}

// The Folder as the release before this page left it: manifest schema 2,
// six manual files with that release's revision and text this product cannot
// render, and nothing at `manual/new-module.md`.
async function renderedBeforeThePage(folder: string) {
  const path = join(folder, ".lazurio", "instructions.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await rm(join(folder, page));
  const outputs: Record<string, string> = {};
  for (const output of manifestOutputPaths[2]) {
    const content = `${(await readFile(join(folder, output), "utf8"))
      .replaceAll(instructionTemplateRevision, "base-instructions-50")
      .replaceAll(newModuleLine.cs, "")
      .replaceAll(newModuleLine.en, "")}\nText of an earlier release.\n`;
    await writeFile(join(folder, output), content);
    outputs[output] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(
    path,
    JSON.stringify({
      ...manifest,
      schemaVersion: 2,
      templateRevision: "base-instructions-50",
      outputs,
    }),
  );
}

// Every output and both state files as they are, an absent output as null.
async function snapshot(folder: string) {
  const files: Record<string, string | null> = {};
  for (const path of outputPaths)
    files[path] = await readFile(join(folder, path), "utf8").catch(() => null);
  for (const name of ["preferences.json", "instructions.json"])
    files[name] = await readFile(join(folder, ".lazurio", name), "utf8");
  return files;
}

async function expectCurrent(folder: string) {
  const preferences = JSON.parse(
    await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
  );
  const current = renderOutputs({
    preset: preferences.preset.name,
    machine: preferences.machine,
    profile: preferences.profile,
  });
  for (const path of outputPaths)
    expect(await readFile(join(folder, path), "utf8")).toBe(current[path]);
  const manifest = JSON.parse(
    await readFile(join(folder, ".lazurio", "instructions.json"), "utf8"),
  );
  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.templateRevision).toBe(instructionTemplateRevision);
  expect(Object.keys(manifest.outputs)).toEqual([...outputPaths]);
}

for (const locale of ["cs", "en"] as const)
  test.skipIf(process.platform === "win32")(
    `a Folder an earlier release rendered gains the new-module page in ${locale} by the next refresh, and a second refresh is unchanged`,
    async () => {
      const { parent, folder } = await setup(locale);
      try {
        await renderedBeforeThePage(folder);
        expect((await readdir(join(folder, "manual"))).sort()).not.toContain(
          "new-module.md",
        );
        expect(await refreshMachineFolder(folder, machine)).toEqual({
          code: 0,
          result: { kind: "refreshed", revision: 2 },
        });
        await expectCurrent(folder);
        expect(await readFile(join(folder, page), "utf8")).toContain(
          "Chci postavit nový modul",
        );
        expect(await refreshMachineFolder(folder, machine)).toEqual({
          code: 0,
          result: { kind: "unchanged" },
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "a file of the person's at manual/new-module.md is never replaced: the upgrade is refused by path and nothing is written",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeThePage(folder);
      await writeFile(join(folder, page), "My own notes\n", { mode: 0o600 });
      const before = await snapshot(folder);
      expect(await refreshMachineFolder(folder, machine)).toEqual({
        code: 2,
        result: { kind: "blocked", reason: "unowned-file", path: page },
      });
      expect(await snapshot(folder)).toEqual(before);
      expect(await readdir(join(folder, ".lazurio"))).not.toContain(
        "transaction",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `an upgrade that creates the page, interrupted after ${stop}, completes by profile-resume`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await renderedBeforeThePage(folder);
        await expect(
          refreshFolder(folder, machine, async (step) => {
            if (step === stop) throw new Error("interrupted");
          }),
        ).rejects.toThrow("interrupted");
        expect(await resumeProfileUpdate(folder, 2)).toEqual({
          kind: "recovered",
          revision: 2,
        });
        await expectCurrent(folder);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

// Prepare the upgrade under the Folder's lock, as the refresh does, and stop.
async function prepareUpgrade(
  folder: string,
  checkpoint?: (step: PreparationStep) => Promise<void>,
) {
  return withFolderOperationLock(join(folder, ".lazurio"), (assertHeld) =>
    prepareFolderChangeLocked(
      folder,
      { kind: "handover", machine },
      assertHeld,
      checkpoint,
    ),
  );
}

for (const stop of [
  null,
  "renamed:manual/working-here.md",
  "renamed:manual/new-module.md",
  "manual/new-module.md",
  "renamed:instructions.json",
] as const)
  test.skipIf(process.platform === "win32")(
    `the activation that creates the page resumes after ${stop ?? "no interruption"}`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await renderedBeforeThePage(folder);
        expect((await prepareUpgrade(folder)).kind).toBe("prepared");
        // The prepared upgrade is inspected as consistent before activation.
        expect(
          (await inspectPreparation(folder)).previousIdentities[page],
        ).toBeNull();
        if (stop)
          await expect(
            applyPreparation(folder, async (step) => {
              if (step === stop) throw new Error("Injected interruption");
            }),
          ).rejects.toThrow("Injected interruption");
        expect(await applyPreparation(folder)).toEqual({
          kind: "applied-journal-retained",
          revision: 2,
        });
        await finalizePreparation(folder, 2);
        await expectCurrent(folder);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "a file that appears at manual/new-module.md after the upgrade was prepared stops it, and the file is kept",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeThePage(folder);
      expect((await prepareUpgrade(folder)).kind).toBe("prepared");
      await writeFile(join(folder, page), "Written meanwhile\n", {
        mode: 0o600,
      });
      await expect(inspectPreparation(folder)).rejects.toThrow(
        "no longer matches",
      );
      await expect(applyPreparation(folder)).rejects.toThrow("conflicts");
      expect(await readFile(join(folder, page), "utf8")).toBe(
        "Written meanwhile\n",
      );
      expect(
        JSON.parse(
          await readFile(join(folder, ".lazurio", "instructions.json"), "utf8"),
        ).schemaVersion,
      ).toBe(2);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const stop of [
  "before",
  "preferences",
  "manifest",
  "instructions",
  "manual",
] as const)
  test.skipIf(process.platform === "win32")(
    `an upgrade interrupted while staging at ${stop} is retired without writing the page, and the next refresh creates it`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await renderedBeforeThePage(folder);
        const before = await snapshot(folder);
        await expect(
          prepareUpgrade(folder, async (step) => {
            if (step === stop) throw new Error("Interrupted");
          }),
        ).rejects.toThrow("Interrupted");
        expect(
          (await retireIncompletePreparation(folder, 1, "c".repeat(32))).kind,
        ).toBe("incomplete-preparation-retained");
        expect(await snapshot(folder)).toEqual(before);
        await expect(lstat(join(folder, page))).rejects.toThrow();
        expect(await refreshMachineFolder(folder, machine)).toEqual({
          code: 0,
          result: { kind: "refreshed", revision: 2 },
        });
        await expectCurrent(folder);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
