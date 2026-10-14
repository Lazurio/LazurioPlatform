import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
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
import {
  manifestOutputPaths,
  manualPaths,
  outputPaths,
  skillPaths,
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
import { renderSkills } from "../src/folder/skills";
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

// The Folder's agent skills (decision F14, addendum of 2026-10-14): the skill
// `new-module` as one SKILL.md for Codex (`.agents/skills/`) and the same
// bytes for Claude Code (`.claude/skills/`). They are new outputs, so a
// Folder an earlier release rendered (manifest schema 2: AGENTS.md and the
// manual) gains them, and their directories, in its next upgrade.

const codex = ".agents/skills/new-module/SKILL.md" as const;
const claude = ".claude/skills/new-module/SKILL.md" as const;

function rendered(journey: (typeof journeys)[number], locale: "cs" | "en") {
  return renderOutputs({
    preset: journey.preset,
    machine: journey.machine,
    profile: presetProfile(journey.preset, journey.os, { locale }),
  });
}

// The YAML frontmatter both harnesses read: `name` and a double-quoted
// `description`.
function frontmatter(text: string) {
  const match = /^---\nname: ([a-z-]+)\ndescription: (".*")\n---\n/.exec(text);
  if (!match) throw new Error("No frontmatter");
  return {
    name: match[1],
    description: JSON.parse(match[2] ?? "") as string,
  };
}

test("the skills are outputs after the manual, one file per harness, and a manifest of schema 2 owns none of them", () => {
  expect(skillPaths).toEqual([codex, claude]);
  expect(outputPaths).toEqual(["AGENTS.md", ...manualPaths, ...skillPaths]);
  expect(manualPaths).not.toContain("manual/new-module.md" as never);
  expect(manifestOutputPaths[3]).toEqual(outputPaths);
  expect(manifestOutputPaths[2]).toEqual(["AGENTS.md", ...manualPaths]);
  expect(instructionManifestSchema).toBe(3);
  expect(folderStateSchemas.manifest).toEqual([2, 3]);
});

test("every Environment renders the skill new-module in its locale, the same bytes for Codex and Claude Code: what a module is, the interview first, the agent's technical choices, the plan and the route its preset allows", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = rendered(journey, locale);
      const text = outputs[codex];
      const cs = locale === "cs";
      const personal =
        workspacePreset(journey.preset).personalspace === "present";
      const organizations = journey.preset !== "hosted-personal";
      expect(outputs[claude]).toBe(text);
      // The frontmatter: the name and a description that triggers on a new
      // module, app, tool, overview or website and on the brief.
      const { name, description } = frontmatter(text);
      expect(name).toBe("new-module");
      for (const word of cs
        ? ["modul", "aplikaci", "nástroj", "přehled", "web", "+ Nový modul"]
        : ["module", "app", "tool", "overview", "website", "+ Nový modul"])
        expect([word, description.includes(word)]).toEqual([word, true]);
      expect(description.length).toBeLessThan(1024);
      expect(text).toContain(cs ? "\n# Nový modul\n" : "\n# A new module\n");
      expect(text).toContain(`<!-- ${instructionTemplateRevision}; `);
      // What a module is and why, before the interview.
      const what = text.indexOf(
        cs ? "## Co je modul a proč" : "## What a module is and why",
      );
      const interview = text.indexOf(
        cs ? "## 1. Rozhovor o účelu" : "## 1. The interview about the purpose",
      );
      expect(what).toBeGreaterThan(0);
      expect(interview).toBeGreaterThan(what);
      for (const phrase of cs
        ? [
            "**Rozhraní pro lidi.**",
            "**Místo pro data a pro agenty.**",
            "**Vlastní procesy a skilly.**",
            "`.agents/skills/`",
            "**samostatný Git repozitář**",
            "Nikdy ho nezakládej ručně",
          ]
        : [
            "**A UI for people.**",
            "**A place for data and for agents.**",
            "**Processes and skills of its own.**",
            "`.agents/skills/`",
            "**a Git repository of its own**",
            "Never create it by hand",
          ]) {
        expect([phrase, text.indexOf(phrase) > what]).toEqual([phrase, true]);
        expect([phrase, text.indexOf(phrase) < interview]).toEqual([
          phrase,
          true,
        ]);
      }
      // The interview: one non-technical question at a time, a summary and
      // a "yes".
      for (const phrase of cs
        ? [
            "jaký problém má modul vyřešit",
            "kdo ho bude používat a kde",
            "odkud se berou data",
            "co se má dít samo",
            "dobrá první verze",
            "**Jedna otázka v jedné zprávě**",
            "jen na to, co člověk ještě neřekl",
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
            "only about what the person has not said yet",
            "**Do not ask about technology.**",
            "wait for their “yes”",
          ])
        expect([phrase, text.indexOf(phrase) > interview]).toEqual([
          phrase,
          true,
        ]);
      // The stacks the agent chooses from are exactly the generator's, in its
      // order, each explained in one line.
      const stacks = [...text.matchAll(/^- `([a-z-]+)`: /gm)].map(
        (match) => match[1],
      );
      expect(stacks.slice(0, moduleScaffoldStacks.length)).toEqual([
        ...moduleScaffoldStacks,
      ]);
      // The data in repository-db first; a database (Neon) only later, never
      // for a new module (root decision 0196 point 8).
      for (const phrase of [
        "github:Lazurio/repository-db#v3.x.y",
        "`<slug>-data`",
        "`db/`",
        "**Neon**",
        "0196",
        cs
          ? "**U nového modulu databázi nikdy nezakládej.**"
          : "**Never create a database for a new module.**",
      ])
        expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
      // The plan before anything is created.
      expect(text).toContain(
        cs ? "## 4. Plán k potvrzení" : "## 4. The plan to confirm",
      );
      // The personal route, only where this Environment has a Personalspace.
      for (const command of [
        "lazurio module create personalspace/<slug> --stack <stack> --name '",
        "--confirm <plan> --json",
        'worktree add -b <branch> "$PWD/personalspace/.worktrees/<task>" main',
        "gh repo view <login>/<slug> --json isPrivate,owner",
        "lazurio module start personalspace/<slug> --json",
        "`plan-changed`",
        "`personalspace_root_on_main`",
        "`create-uncertain`",
      ])
        expect([command, text.includes(command)]).toEqual([command, personal]);
      expect(text.includes("`personalspace-not-here`")).toBe(!personal);
      // An Organization's module by the Organization form, only where the
      // preset holds Organizations (F52 addendum of 2026-10-14).
      for (const command of [
        "lazurio module create <",
        "--teams <team,team>",
        '.worktrees/root/<task>" main',
        "`organization-owner-required`",
        "`teams-required`",
      ])
        expect([command, text.includes(command)]).toEqual([
          command,
          organizations,
        ]);
      expect(text).not.toContain("organization-form-unavailable");
      // The data repository by --data, in both forms; never by hand.
      for (const phrase of [
        "`--data`",
        "`data-init-failed`",
        "`data_needs_bun_app`",
        "`data-repository-exists`",
        "docs/app-contract.md",
      ])
        expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
      expect(text).not.toContain("--create-remote");
      // AGENTS.md points to the skill; the manual has no page for it.
      expect(outputs["AGENTS.md"]).toContain(newModuleLine[locale]);
      expect(outputs["AGENTS.md"]).not.toContain("manual/new-module.md");
    }
});

test("where both places exist, an Organization's module continues at its own route: steps 5 to 7 are the personal module's only", () => {
  let checked = 0;
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const personal =
        workspacePreset(journey.preset).personalspace === "present";
      const organizations = journey.preset !== "hosted-personal";
      const text = rendered(journey, locale)[codex];
      const cs = locale === "cs";
      const route = text.indexOf(
        cs ? "**Modul Organizace.**" : "**An Organization's module.**",
      );
      const stop = text.indexOf(
        cs
          ? "**Modul Organizace pokračuje tady, ne kroky 5 až 7 níže.**"
          : "**An Organization's module continues here, not with steps 5 to 7 below.**",
      );
      expect(stop > route && route > 0).toBe(personal && organizations);
      if (!(personal && organizations)) continue;
      checked += 1;
      // The Organization's bar follows its stop, before the personal steps.
      const step5 = text.indexOf(
        cs
          ? "## 5. Založení osobního modulu"
          : "## 5. Founding a personal module",
      );
      // The first version runs from the worktree; the module starts by the
      // CLI only after both pull requests are merged.
      const wait = text.indexOf(
        cs
          ? "`lazurio module start` teď nepoužívej"
          : "Do not use `lazurio module start` yet",
      );
      const bar = text.indexOf(
        cs
          ? "lazurio module start <Organizace>/<slug> --json"
          : "lazurio module start <Organization>/<slug> --json",
      );
      expect(stop < wait && wait < bar && bar < step5).toBe(true);
      // Every heading after the plan says whose steps they are.
      for (const heading of cs
        ? [
            "## 6. První verze osobního modulu",
            "## 7. Publikace osobního modulu",
          ]
        : [
            "## 6. A personal module's first version",
            "## 7. Publishing a personal module",
          ])
        expect(text.indexOf(heading)).toBeGreaterThan(step5);
      // Between the Organization's route and the personal steps, no command
      // creates anything in the personal space; the personal run comes only
      // after.
      const between = text.slice(route, step5);
      for (const command of [
        "personalspace/.worktrees",
        "gh repo view <login>/<slug>",
      ])
        expect([command, between.includes(command)]).toEqual([command, false]);
      expect(
        text.indexOf("personalspace/<slug> --stack <stack> --name '<"),
      ).toBeLessThan(route);
      expect(
        text.lastIndexOf("lazurio module create personalspace/<slug> --stack"),
      ).toBeGreaterThan(step5);
    }
  expect(checked).toBeGreaterThan(0);
});

test("the skill has the same sections in both languages on every preset", () => {
  for (const journey of journeys) {
    const skill = (locale: "cs" | "en") =>
      renderSkills({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      })[codex].split("\n");
    const cs = skill("cs");
    const en = skill("en");
    expect(cs.length).toBe(en.length);
    expect(cs.map((line) => /^#+ /.exec(line)?.[0] ?? "")).toEqual(
      en.map((line) => /^#+ /.exec(line)?.[0] ?? ""),
    );
  }
});

test("a manifest of schema 2 owns exactly AGENTS.md and the manual; schema 3 owns every output", () => {
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
  expect(
    parseInstructionManifest(manifest(3, outputPaths)).outputs[claude],
  ).toBe(digest);
  // Each schema has one set: no skills in a schema 3 manifest, or skills in
  // a schema 2 manifest, and no other schema.
  expect(() => parseInstructionManifest(manifest(2, outputPaths))).toThrow();
  expect(() =>
    parseInstructionManifest(manifest(3, manifestOutputPaths[2])),
  ).toThrow();
  expect(() => parseInstructionManifest(manifest(4, outputPaths))).toThrow();
});

// A personal Remote Environment's Folder, as in the refresh tests: hosted, so
// its top level is checked against the claimed boundary on every change.
const machine = binding(personal);
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

async function setup(locale: "cs" | "en" = "en") {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "folder-skills-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeMachineFolder(folder, machine, { ...noChoices, locale });
  return { parent, folder };
}

// The Folder as the release before the skills left it: manifest schema 2,
// AGENTS.md and the six manual files with that release's revision and text
// this product cannot render, and no `.agents/` or `.claude/` at all.
async function renderedBeforeTheSkills(folder: string) {
  const path = join(folder, ".lazurio", "instructions.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await rm(join(folder, ".agents"), { recursive: true });
  await rm(join(folder, ".claude"), { recursive: true });
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

test.skipIf(process.platform === "win32")(
  "a new Folder carries the skills from its initialization, in owner-only directories",
  async () => {
    const { parent, folder } = await setup("cs");
    try {
      await expectCurrent(folder);
      for (const directory of [
        ".agents",
        ".agents/skills",
        ".agents/skills/new-module",
        ".claude",
        ".claude/skills",
        ".claude/skills/new-module",
      ])
        expect((await lstat(join(folder, directory))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const locale of ["cs", "en"] as const)
  test.skipIf(process.platform === "win32")(
    `a Folder an earlier release rendered gains the skills in ${locale} by the next refresh, and a second refresh is unchanged`,
    async () => {
      const { parent, folder } = await setup(locale);
      try {
        await renderedBeforeTheSkills(folder);
        expect(await refreshMachineFolder(folder, machine)).toEqual({
          code: 0,
          result: { kind: "refreshed", revision: 2 },
        });
        await expectCurrent(folder);
        expect(
          frontmatter(await readFile(join(folder, claude), "utf8")),
        ).toEqual(frontmatter(await readFile(join(folder, codex), "utf8")));
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
  "what a harness or the person keeps in .claude/ and .agents/ stays: the upgrade writes beside it, also in a group-writable directory",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeTheSkills(folder);
      await mkdir(join(folder, ".claude"));
      await chmod(join(folder, ".claude"), 0o775);
      await writeFile(join(folder, ".claude", "settings.local.json"), "{}\n");
      await mkdir(join(folder, ".agents", "skills", "my-own"), {
        recursive: true,
      });
      await writeFile(
        join(folder, ".agents", "skills", "my-own", "SKILL.md"),
        "My own skill\n",
      );
      expect(await refreshMachineFolder(folder, machine)).toEqual({
        code: 0,
        result: { kind: "refreshed", revision: 2 },
      });
      await expectCurrent(folder);
      expect(
        await readFile(join(folder, ".claude", "settings.local.json"), "utf8"),
      ).toBe("{}\n");
      expect(
        await readFile(
          join(folder, ".agents", "skills", "my-own", "SKILL.md"),
          "utf8",
        ),
      ).toBe("My own skill\n");
      expect((await lstat(join(folder, ".claude"))).mode & 0o777).toBe(0o775);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a file of the person's at a skill's path is never replaced: the upgrade is refused by path and nothing is written",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeTheSkills(folder);
      await mkdir(join(folder, ".claude", "skills", "new-module"), {
        recursive: true,
      });
      await writeFile(join(folder, claude), "My own notes\n", { mode: 0o600 });
      const before = await snapshot(folder);
      expect(await refreshMachineFolder(folder, machine)).toEqual({
        code: 2,
        result: { kind: "blocked", reason: "unowned-file", path: claude },
      });
      expect(await snapshot(folder)).toEqual(before);
      await expect(lstat(join(folder, ".agents"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a symlinked .claude/ is never followed: the upgrade is refused as an unsafe path and nothing is written",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeTheSkills(folder);
      const elsewhere = join(parent, "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await symlink(elsewhere, join(folder, ".claude"));
      const before = await snapshot(folder);
      expect(await refreshMachineFolder(folder, machine)).toEqual({
        code: 2,
        result: { kind: "blocked", reason: "unsafe-path", path: claude },
      });
      expect(await snapshot(folder)).toEqual(before);
      await expect(lstat(join(elsewhere, "skills"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `an upgrade that creates the skills, interrupted after ${stop}, completes by profile-resume`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await renderedBeforeTheSkills(folder);
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
  "renamed:manual/troubleshooting.md",
  `renamed:${codex}`,
  codex,
  `renamed:${claude}`,
  "renamed:instructions.json",
] as const)
  test.skipIf(process.platform === "win32")(
    `the activation that creates the skills resumes after ${stop ?? "no interruption"}`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await renderedBeforeTheSkills(folder);
        expect((await prepareUpgrade(folder)).kind).toBe("prepared");
        // The prepared upgrade is inspected as consistent before activation.
        const previous = (await inspectPreparation(folder)).previousIdentities;
        expect([previous[codex], previous[claude]]).toEqual([null, null]);
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
  "the activation resumes when it created a skill's directories but not the file",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeTheSkills(folder);
      expect((await prepareUpgrade(folder)).kind).toBe("prepared");
      // An interruption between the directories and the rename.
      await mkdir(join(folder, ".claude", "skills", "new-module"), {
        recursive: true,
        mode: 0o700,
      });
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
  "a file that appears at a skill's path after the upgrade was prepared stops it, and the file is kept",
  async () => {
    const { parent, folder } = await setup();
    try {
      await renderedBeforeTheSkills(folder);
      expect((await prepareUpgrade(folder)).kind).toBe("prepared");
      await mkdir(join(folder, ".claude", "skills", "new-module"), {
        recursive: true,
      });
      await writeFile(join(folder, claude), "Written meanwhile\n", {
        mode: 0o600,
      });
      await expect(inspectPreparation(folder)).rejects.toThrow(
        "no longer matches",
      );
      await expect(applyPreparation(folder)).rejects.toThrow("conflicts");
      expect(await readFile(join(folder, claude), "utf8")).toBe(
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
    `an upgrade interrupted while staging at ${stop} is retired without writing the skills, and the next refresh creates them`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await renderedBeforeTheSkills(folder);
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
        await expect(lstat(join(folder, ".agents"))).rejects.toThrow();
        await expect(lstat(join(folder, ".claude"))).rejects.toThrow();
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
