import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import {
  machineIdentity,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { parseFolderPreferences } from "../src/folder/state";
import { refreshFolder } from "../src/folder/update-profile";
import { machineBinding } from "../src/machine/binding";
import type { MachineContext } from "../src/machine/context";
import { binding, bindings, entries } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

const { team: _, ...withoutTeam } = organization.owner;
const organizationHandover = { ...organization, owner: withoutTeam };
const entry = bindings.organizationEntry.entry;

test("the handover entry is projected into the binding one member to one, on both lanes", () => {
  expect(bindings.organizationEntry.entry).toEqual({
    externalOrigin: "https://launchpad.workspace.example.lazurio.io",
    authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
    authCookieName: "__Secure-lazurio-workspace",
    listenPort: 20000,
    t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
    moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
  });
  // A personal VM: the Machine hostname has no Organization label.
  expect(bindings.personalEntry.entry).toEqual({
    externalOrigin: "https://launchpad.example.lazurio.io",
    authCheckUrl: "https://example.lazurio.io/oauth2/auth",
    authCookieName: "__Secure-lazurio-workspace",
    listenPort: 20000,
    t3codeOrigin: "https://t3code.example.lazurio.io",
    moduleOriginTemplate: "https://{module}.example.lazurio.io",
  });
  expect(Object.isFrozen(bindings.organizationEntry.entry)).toBe(true);
  // Without the entry, nothing changes: the binding has no `entry` key at all.
  expect(Object.keys(bindings.organization)).not.toContain("entry");
  expect(Object.keys(bindings.personal)).not.toContain("entry");
  // Everything else of the binding is the same as without the entry.
  const { entry: __, ...rest } = bindings.organizationEntry;
  expect(rest).toEqual({
    ...bindings.organization,
    contextDigest: rest.contextDigest,
  });
});

test("the entry is a declaration on the binding: parsed exactly, round-tripped, outside the identity", () => {
  for (const withEntry of [
    bindings.organizationEntry,
    bindings.personalEntry,
  ]) {
    expect(parseMachineBinding(withEntry)).toEqual(withEntry);
    expect(parseMachineBinding(JSON.parse(JSON.stringify(withEntry)))).toEqual(
      withEntry,
    );
  }
  expect(machineIdentity(bindings.organizationEntry)).toEqual(
    machineIdentity(bindings.organization),
  );
  expect(machineIdentity(bindings.personalEntry)).toEqual(
    machineIdentity(bindings.personal),
  );
  const preferences = parseFolderPreferences({
    schemaVersion: 2,
    revision: 1,
    preset: {
      name: "hosted-organization-personal",
      version: 1,
      selection: "derived",
    },
    machine: bindings.organizationEntry,
    profile: presetProfile("hosted-organization-personal", "linux"),
    customInstructions: "",
  });
  expect(preferences.machine?.entry).toEqual(entry);
});

test("a recorded entry is refused unless it is what a valid handover projects", () => {
  if (entry === undefined) throw new Error("The fixture has an entry");
  const { t3codeOrigin: _t3, moduleOriginTemplate: _m, ...launchpad } = entry;
  for (const bad of [
    null,
    // Only the Launchpad's four values: a handover never carries that.
    launchpad,
    { ...entry, extra: 1 },
    { ...entry, listenPort: 0 },
    { ...entry, listenPort: 1023 },
    { ...entry, listenPort: 65536 },
    {
      ...entry,
      externalOrigin: "http://launchpad.workspace.example.lazurio.io",
    },
    { ...entry, externalOrigin: `${entry.externalOrigin}:8443` },
    { ...entry, authCheckUrl: "https://workspace.example.lazurio.io" },
    { ...entry, authCookieName: "lazurio.workspace" },
    { ...entry, t3codeOrigin: "http://t3code.workspace.example.lazurio.io" },
    { ...entry, t3codeOrigin: `${entry.t3codeOrigin}/` },
    { ...entry, moduleOriginTemplate: "https://workspace.example.lazurio.io" },
    {
      ...entry,
      moduleOriginTemplate: "https://app-{module}.workspace.example.lazurio.io",
    },
    {
      ...entry,
      moduleOriginTemplate: "https://workspace.{module}.example.lazurio.io",
    },
    {
      ...entry,
      moduleOriginTemplate: "https://{module}.{module}.example.lazurio.io",
    },
    {
      ...entry,
      moduleOriginTemplate: "http://{module}.workspace.example.lazurio.io",
    },
  ])
    expect(() =>
      parseMachineBinding({ ...bindings.organization, entry: bad }),
    ).toThrow();
});

test("a projection that would not read back refuses the handover", () => {
  // The schema refuses these first; the projection holds the same rules for
  // any context that reaches it.
  for (const change of [
    { listen_port: 0 },
    { external_origin: "http://launchpad.workspace.example.lazurio.io" },
  ]) {
    const context = {
      ...organizationHandover,
      entry: {
        ...entries.organization,
        launchpad: { ...entries.organization.launchpad, ...change },
      },
    } as unknown as MachineContext;
    expect(() => machineBinding(context, "a".repeat(64))).toThrow(
      "machine-context-invalid",
    );
  }
  const template = {
    ...organizationHandover,
    entry: {
      ...entries.organization,
      modules: { origin_template: "https://workspace.example.lazurio.io" },
    },
  } as unknown as MachineContext;
  expect(() => machineBinding(template, "a".repeat(64))).toThrow(
    "machine-context-invalid",
  );
});

async function withFolder(run: (folder: string) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "folder-entry-")));
  const folder = join(parent, "Lazurio");
  try {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await run(folder);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const recorded = async (folder: string) =>
  parseFolderPreferences(
    JSON.parse(
      await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
    ),
  );

test.skipIf(process.platform === "win32")(
  "folder-init records the entry; a changed entry is refreshed and recorded even when the Folder renders the same bytes",
  async () => {
    const preset = "hosted-organization-personal";
    await withFolder(async (folder) => {
      await initializeHandoverFolder(folder, {
        preset,
        machine: bindings.organizationEntry,
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      expect((await recorded(folder)).machine?.entry).toEqual(entry);
      const thisMachine = join(folder, "manual", "this-machine.md");
      const rendered = await readFile(thisMachine, "utf8");
      expect(rendered).toContain(
        "- Entry: this Machine's Launchpad is reached at `https://launchpad.workspace.example.lazurio.io` through the Organization's gateway (decision F16)",
      );
      // The same handover again: nothing to record.
      expect(await refreshFolder(folder, bindings.organizationEntry)).toEqual({
        kind: "unchanged",
      });
      // Machines renders another T3 Code route: no rendered text names it, yet
      // the declaration changed, so it is recorded (declaration, not identity).
      const moved = binding({
        ...organizationHandover,
        entry: {
          ...entries.organization,
          t3code: {
            external_origin: "https://code.workspace.example.lazurio.io",
          },
        },
      });
      expect(await refreshFolder(folder, moved)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      expect(await readFile(thisMachine, "utf8")).toBe(rendered);
      expect((await recorded(folder)).machine?.entry?.t3codeOrigin).toBe(
        "https://code.workspace.example.lazurio.io",
      );
      expect(await refreshFolder(folder, moved)).toEqual({ kind: "unchanged" });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a handover that gains or loses the entry re-renders the Folder through folder-refresh and the manual shows it",
  async () => {
    const preset = "hosted-organization-personal";
    await withFolder(async (folder) => {
      await initializeHandoverFolder(folder, {
        preset,
        machine: bindings.organization,
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      const thisMachine = join(folder, "manual", "this-machine.md");
      expect(await readFile(thisMachine, "utf8")).not.toContain("- Entry:");
      // Machines re-applied with the entry: the same Machine, re-rendered.
      expect(await refreshFolder(folder, bindings.organizationEntry)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      expect((await recorded(folder)).machine?.entry).toEqual(entry);
      expect(await readFile(thisMachine, "utf8")).toContain(
        "- Entry: this Machine's Launchpad is reached at `https://launchpad.workspace.example.lazurio.io`",
      );
      expect(await refreshFolder(folder, bindings.organizationEntry)).toEqual({
        kind: "unchanged",
      });
      // Removed again: re-rendered and recorded without it.
      expect(await refreshFolder(folder, bindings.organization)).toEqual({
        kind: "refreshed",
        revision: 3,
      });
      expect(await readFile(thisMachine, "utf8")).not.toContain("- Entry:");
      expect(Object.keys((await recorded(folder)).machine ?? {})).not.toContain(
        "entry",
      );
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a personal VM records its entry and the manual names its own gateway, not an Organization's",
  async () => {
    const preset = "hosted-personal";
    await withFolder(async (folder) => {
      await initializeHandoverFolder(folder, {
        preset,
        machine: bindings.personal,
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      expect(await refreshFolder(folder, bindings.personalEntry)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      expect((await recorded(folder)).machine?.entry).toEqual(
        bindings.personalEntry.entry,
      );
      const rendered = await readFile(
        join(folder, "manual", "this-machine.md"),
        "utf8",
      );
      expect(rendered).toContain(
        "- Entry: this Machine's Launchpad is reached at `https://launchpad.example.lazurio.io` through this Machine's gateway (decision F16)",
      );
      expect(rendered).not.toContain("Organization's gateway");
    });
  },
);
