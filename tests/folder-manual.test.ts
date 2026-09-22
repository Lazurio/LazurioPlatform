import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
import { FolderAdoptionError } from "../src/folder/handover-layout";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { renderManual } from "../src/folder/manual";
import { manualPaths, outputFile, outputPaths } from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { resumeInitialization } from "../src/folder/resume-initialization";
import { updateProfile } from "../src/folder/update-profile";
import { bindings } from "./fixtures/machine-bindings";
import { journeys } from "./folder-render.test";

const os = executionOs(process.platform);

// The manual is English on every Machine and in both profile locales; only
// `this-machine.md` differs between presets. Review the snapshots when the
// wording changes deliberately.
test("the manual is the same English text in both locales and names no legacy source", () => {
  for (const journey of journeys) {
    const render = (locale: "cs" | "en") =>
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
    const en = render("en");
    expect(render("cs")).toEqual(en);
    for (const path of manualPaths) {
      expect(Object.keys(en)).toContain(path);
      expect(en[path]).not.toContain("undefined");
      expect(en[path].endsWith("\n")).toBe(true);
    }
  }
  // The Platform manual is the authority for an agent on the Machine; it never
  // points at the retired root repository (decision F14).
  for (const journey of journeys) {
    const outputs = renderOutputs({
      preset: journey.preset,
      machine: journey.machine,
      profile: presetProfile(journey.preset, journey.os),
    });
    for (const path of outputPaths)
      expect(outputs[path]).not.toMatch(/HumanAndMachines\/Lazurio/);
    // The PR lifecycle never prescribes GitHub's draft state for every
    // repository: "Draft" is the editable work, the owning repository's rule
    // decides the PR state, and a snapshot alone cannot reintroduce it.
    const workingHere = outputs["manual/working-here.md"];
    expect(workingHere).not.toContain("as a GitHub Draft PR");
    expect(workingHere).not.toMatch(/open pull requests as/);
    expect(workingHere).toContain("repository's own rule wins");
    expect(workingHere).toContain("visible as an open pull request");
    expect(workingHere).toContain("ready for review yourself");
  }
});

for (const journey of journeys.filter((entry) => entry.os !== "windows"))
  test(`rendered manual/this-machine.md snapshot: ${journey.preset}`, () => {
    expect(
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os),
      })["manual/this-machine.md"],
    ).toMatchSnapshot();
  });

for (const path of manualPaths.filter((p) => p !== "manual/this-machine.md"))
  test(`rendered ${path} snapshot`, () => {
    expect(
      renderManual({
        preset: "local",
        machine: null,
        profile: presetProfile("local", "linux"),
      })[path],
    ).toMatchSnapshot();
  });

test("this-machine.md renders relationships only when the binding carries them", () => {
  const profile = presetProfile("hosted-organization-personal", "linux");
  const plain = renderManual({
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    profile,
  })["manual/this-machine.md"];
  expect(plain).not.toContain("## Relationships");
  const related = renderManual({
    preset: "hosted-organization-personal",
    machine: {
      ...bindings.organization,
      relationships: [
        {
          machine: "example-laptop",
          kind: "personal-client",
          access: "inbound",
        },
      ],
    },
    profile,
  })["manual/this-machine.md"];
  expect(related).toContain("## Relationships");
  expect(related).toContain(
    "`example-laptop` (personal client): may reach this Machine.",
  );
});

test.skipIf(process.platform === "win32")(
  "initialization writes the manual with recorded digests; a hand-edited manual file is refused by name and never overwritten",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "manual-")));
    const folder = join(parent, "Lazurio");
    const profile = presetProfile("local", os);
    try {
      await initializeFolder(folder, profile);
      // The six documents and the hidden marker of the initialization.
      expect((await readdir(join(folder, "manual"))).sort()).toEqual(
        [
          ".lazurio-generated",
          ...manualPaths.map((path) => outputFile(folder, path).name),
        ].sort(),
      );
      const manifest = JSON.parse(
        await readFile(join(folder, ".lazurio", "instructions.json"), "utf8"),
      );
      for (const path of outputPaths)
        expect(manifest.outputs[path]).toBe(
          createHash("sha256")
            .update(await readFile(join(folder, path)))
            .digest("hex"),
        );
      // Idempotent: the same inputs change nothing.
      expect(await updateProfile(folder, 1, { profile })).toEqual({
        kind: "unchanged",
      });
      // A preset-independent file survives a locale change byte for byte.
      const roles = await readFile(join(folder, "manual", "roles.md"), "utf8");
      expect(
        await updateProfile(folder, 1, {
          profile: { ...profile, locale: "cs" },
        }),
      ).toEqual({ kind: "updated", revision: 2 });
      expect(await readFile(join(folder, "manual", "roles.md"), "utf8")).toBe(
        roles,
      );
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        "## Manuál",
      );
      // An edit is refused with the file's path and preserved.
      await writeFile(
        join(folder, "manual", "roles.md"),
        `${roles}\nMy note\n`,
      );
      expect(await updateProfile(folder, 2, { profile })).toEqual({
        kind: "blocked",
        reason: "drift",
        path: "manual/roles.md",
      });
      expect(await readFile(join(folder, "manual", "roles.md"), "utf8")).toBe(
        `${roles}\nMy note\n`,
      );
      expect(await readdir(join(folder, ".lazurio"))).not.toContain(
        "transaction",
      );
      // A removed file is drift as well; nothing is recreated behind the user.
      await rm(join(folder, "manual", "glossary.md"));
      expect(await updateProfile(folder, 2, { profile })).toEqual({
        kind: "blocked",
        reason: "drift",
        path: "manual/roles.md",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "adoption refuses a foreign manual/ by name, then adopts and resumes with the manual in place",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "manual-adopt-")),
    );
    const folder = join(parent, "Lazurio");
    const source = {
      preset: "hosted-organization-personal" as const,
      machine: bindings.organization,
      profile: presetProfile("hosted-organization-personal", os),
    };
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await mkdir(join(folder, "manual"), { mode: 0o700 });
      await writeFile(join(folder, "manual", "notes.md"), "operator notes");
      await expect(initializeHandoverFolder(folder, source)).rejects.toThrow(
        new FolderAdoptionError("foreign-entry", "manual"),
      );
      expect(await readFile(join(folder, "manual", "notes.md"), "utf8")).toBe(
        "operator notes",
      );
      await rm(join(folder, "manual"), { recursive: true });
      await expect(
        initializeHandoverFolder(folder, source, async (step) => {
          if (step === "manual") throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
      expect(await initializeHandoverFolder(folder, source)).toMatchObject({
        kind: "already-adopted",
        revision: 1,
      });
      const machine = await readFile(
        join(folder, "manual", "this-machine.md"),
        "utf8",
      );
      expect(machine).toContain("hosted-organization-personal");
      expect(machine).toContain(`\`${bindings.organization.name}\``);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
