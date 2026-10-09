import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { readFolderTools } from "../src/folder/inspect-tools-change";
import type { MachineBinding } from "../src/folder/machine-binding";
import { outputPaths } from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { parseFolderPreferences } from "../src/folder/state";
import {
  recordOrganizationSettings,
  refreshFolder,
  resumeProfileUpdate,
  updateProfile,
  updateTools,
} from "../src/folder/update-profile";
import {
  binding,
  bindings,
  workRelationships,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// Root decision 0194 points 4 and 5, decision F45: the Folder of an
// Organization's Environment records the Organization settings it applies,
// next to the Machine binding, and renders what they allow: the person's own
// selection of tools stays as it is, and the tools the Organization does not
// allow are left out of AGENTS.md and the manual while it does not, so that
// allowing them again restores the person's choice. A personal Environment
// never records Organization settings.

const os = executionOs(process.platform);
const forbidden = { integrations: { composio: { allowed: false } } } as const;
const allowed = { integrations: { composio: { allowed: true } } } as const;

async function withFolder(
  preset: PresetName,
  machine: MachineBinding,
  run: (folder: string) => Promise<void>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "folder-organization-settings-")),
  );
  const folder = join(parent, "Lazurio");
  try {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o700 });
    if (preset === "hosted-personal")
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile: presetProfile(preset, os),
    });
    await run(folder);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const read = (folder: string, path: string) =>
  readFile(join(folder, path), "utf8");
const preferences = async (folder: string) =>
  JSON.parse(await read(folder, ".lazurio/preferences.json"));
const composioLine = "- `composio` (";
const organizationLine = "The Organization does not allow Composio";

test.skipIf(process.platform === "win32")(
  "a work Environment records the Organization's settings and renders only the tools they allow",
  async () => {
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        expect(await updateTools(folder, 1, ["composio", "wacli"])).toEqual({
          kind: "updated",
          revision: 2,
        });
        const before = Object.fromEntries(
          await Promise.all(
            outputPaths.map(async (path) => [path, await read(folder, path)]),
          ),
        );
        expect(before["AGENTS.md"]).toContain(composioLine);

        expect(await recordOrganizationSettings(folder, forbidden)).toEqual({
          kind: "updated",
          revision: 3,
        });
        const recorded = await preferences(folder);
        // The person's own choice stays recorded.
        expect(recorded.tools).toEqual(["composio", "wacli"]);
        expect(recorded.organizationSettings).toEqual(forbidden);
        const agents = await read(folder, "AGENTS.md");
        expect(agents).not.toContain(composioLine);
        expect(agents).toContain("- `wacli` (");
        expect(agents).toContain(organizationLine);
        const manual = await read(folder, "manual/this-machine.md");
        expect(manual).not.toContain(composioLine);
        expect(manual).toContain(organizationLine);

        // The same settings again change nothing.
        expect(await recordOrganizationSettings(folder, forbidden)).toEqual({
          kind: "unchanged",
        });
        expect((await preferences(folder)).revision).toBe(3);

        // Allowed again: the person's choice is back, and nothing says the
        // Organization decides it.
        expect(await recordOrganizationSettings(folder, allowed)).toEqual({
          kind: "updated",
          revision: 4,
        });
        expect((await preferences(folder)).organizationSettings).toEqual(
          allowed,
        );
        const back = await read(folder, "AGENTS.md");
        expect(back).toContain(composioLine);
        expect(back).not.toContain(organizationLine);

        // Not governed any more: the Folder is byte for byte what it was.
        expect(await recordOrganizationSettings(folder, {})).toEqual({
          kind: "updated",
          revision: 5,
        });
        const ungoverned = await preferences(folder);
        expect("organizationSettings" in ungoverned).toBe(false);
        expect(ungoverned.tools).toEqual(["composio", "wacli"]);
        for (const path of outputPaths)
          expect(await read(folder, path)).toBe(before[path] as string);
      },
    );
  },
);

test.skipIf(process.platform === "win32")(
  "while the Organization does not allow a tool, its choice cannot change; every other tool can",
  async () => {
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        expect(await updateTools(folder, 1, ["composio"])).toEqual({
          kind: "updated",
          revision: 2,
        });
        await recordOrganizationSettings(folder, forbidden);
        // Turning it off is the Organization's decision now, not a change of
        // the person's choice.
        expect(await updateTools(folder, 3, [])).toEqual({
          kind: "blocked",
          reason: "organization-governed",
          tool: "composio",
        });
        // Another tool changes; the governed one is carried as it is.
        expect(await updateTools(folder, 3, ["composio", "neon"])).toEqual({
          kind: "updated",
          revision: 4,
        });
        const tools = await readFolderTools(folder);
        expect(tools.enabled).toEqual(["composio", "neon"]);
        expect(tools.governed).toEqual({ composio: { allowed: false } });
        expect(await read(folder, "AGENTS.md")).not.toContain(composioLine);
      },
    );
    // A tool the person never chose cannot be turned on either.
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        await recordOrganizationSettings(folder, forbidden);
        expect(await updateTools(folder, 2, ["composio"])).toEqual({
          kind: "blocked",
          reason: "organization-governed",
          tool: "composio",
        });
      },
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a profile change and a handover refresh carry the recorded settings forward",
  async () => {
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        await updateTools(folder, 1, ["composio"]);
        await recordOrganizationSettings(folder, forbidden);
        const profile = presetProfile("hosted-organization-personal", os, {
          locale: "cs",
        });
        expect(await updateProfile(folder, 3, { profile })).toEqual({
          kind: "updated",
          revision: 4,
        });
        expect((await preferences(folder)).organizationSettings).toEqual(
          forbidden,
        );
        const czech = await read(folder, "AGENTS.md");
        expect(czech).not.toContain(composioLine);
        expect(czech).toContain("Composio na tomhle Environmentu Organizace");
        const { team: _, ...withoutTeam } = organization.owner;
        // The handover gained the work VM's peers: the Folder renders them.
        const refreshed = await refreshFolder(
          folder,
          binding({
            ...organization,
            owner: withoutTeam,
            relationships: workRelationships,
          }),
        );
        expect(refreshed.kind).toBe("refreshed");
        expect((await preferences(folder)).organizationSettings).toEqual(
          forbidden,
        );
      },
    );
  },
);

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `a settings change interrupted after ${stop} completes by profile-resume`,
    async () => {
      await withFolder(
        "hosted-organization-team",
        bindings.team,
        async (folder) => {
          await updateTools(folder, 1, ["composio"]);
          await expect(
            recordOrganizationSettings(folder, forbidden, async (step) => {
              if (step === stop) throw new Error("interrupted");
            }),
          ).rejects.toThrow("interrupted");
          expect(await resumeProfileUpdate(folder, 3)).toEqual({
            kind: "recovered",
            revision: 3,
          });
          expect((await preferences(folder)).organizationSettings).toEqual(
            forbidden,
          );
          expect(await read(folder, "AGENTS.md")).not.toContain(composioLine);
        },
      );
    },
  );

test.skipIf(process.platform === "win32")(
  "a personal Environment never records Organization settings",
  async () => {
    await withFolder("hosted-personal", bindings.personal, async (folder) => {
      await updateTools(folder, 1, ["composio"]);
      expect(await recordOrganizationSettings(folder, forbidden)).toEqual({
        kind: "blocked",
        reason: "organization-settings-not-governed",
      });
      expect(await recordOrganizationSettings(folder, {})).toEqual({
        kind: "unchanged",
      });
      expect("organizationSettings" in (await preferences(folder))).toBe(false);
      expect(await read(folder, "AGENTS.md")).toContain(composioLine);
    });
  },
);

test("recorded settings are read exactly, only where an Organization governs", () => {
  const stored = {
    schemaVersion: 2,
    revision: 3,
    preset: {
      name: "hosted-organization-personal",
      version: 1,
      selection: "derived",
    },
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", "linux"),
    customInstructions: "",
    tools: ["composio"],
    organizationSettings: forbidden,
  };
  expect(parseFolderPreferences(stored).organizationSettings).toEqual(
    forbidden,
  );
  for (const bad of [
    {},
    { integrations: {} },
    { integrations: { composio: {} } },
    { integrations: { composio: { allowed: "no" } } },
    { integrations: { composio: { allowed: false, extra: true } } },
    { other: true },
    null,
    [],
  ])
    expect(() =>
      parseFolderPreferences({ ...stored, organizationSettings: bad }),
    ).toThrow();
  expect(() =>
    parseFolderPreferences({
      ...stored,
      preset: { name: "hosted-personal", version: 1, selection: "derived" },
      machine: bindings.personal,
      profile: presetProfile("hosted-personal", "linux"),
    }),
  ).toThrow();
});

const governed = [
  ["hosted-organization-personal", bindings.organizationEntry],
  ["hosted-organization-team", bindings.teamEntry],
  ["hosted-organization-steward", bindings.automatedEntry],
] as const;
for (const [preset, machine] of governed)
  for (const locale of ["cs", "en"] as const)
    test(`${preset} (${locale}) renders the tools the Organization allows and says why one is missing`, () => {
      const base = {
        preset,
        machine,
        profile: presetProfile(preset, "linux", { locale }),
        tools: ["composio", "wacli"],
        toolNotes: { composio: "Our team account." },
      };
      const free = renderOutputs(base);
      const none = renderOutputs({ ...base, organizationSettings: {} });
      const yes = renderOutputs({ ...base, organizationSettings: allowed });
      const no = renderOutputs({ ...base, organizationSettings: forbidden });
      for (const path of outputPaths) {
        // Absent and allowed render exactly what an ungoverned Folder does.
        expect(none[path]).toBe(free[path]);
        expect(yes[path]).toBe(free[path]);
      }
      expect(free["AGENTS.md"]).toContain(composioLine);
      expect(no["AGENTS.md"]).not.toContain(composioLine);
      expect(no["manual/this-machine.md"]).not.toContain(composioLine);
      // The person's note on it is not quoted while it is not used.
      expect(no["manual/this-machine.md"]).not.toContain("Our team account.");
      expect(no["AGENTS.md"]).toContain("- `wacli` (");
      const line =
        locale === "cs"
          ? "Composio na tomhle Environmentu Organizace nepovoluje"
          : organizationLine;
      expect(no["AGENTS.md"]).toContain(line);
      expect(no["manual/this-machine.md"]).toContain(line);
    });

test("a personal Environment's composition refuses Organization settings", () => {
  for (const [preset, machine] of [
    ["hosted-personal", bindings.personal],
    ["local", null],
  ] as const)
    expect(() =>
      renderOutputs({
        preset,
        machine,
        profile: presetProfile(preset, preset === "local" ? "macos" : "linux"),
        tools: ["composio"],
        organizationSettings: forbidden,
      }),
    ).toThrow();
});
