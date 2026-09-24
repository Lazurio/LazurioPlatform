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
import { parseHostedEntry } from "../src/launchpad/hosted-trust";
import { bindings } from "./fixtures/machine-bindings";

const entry = parseHostedEntry({
  externalOrigin: "https://launchpad.workspace.example.lazurio.io",
  authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
  authCookieName: "__Secure-lazurio-workspace",
  listenPort: 20000,
});
const withEntry = { ...bindings.organization, entry };

test("the entry is a declaration on the binding: parsed exactly, round-tripped, outside the identity", () => {
  expect(parseMachineBinding(withEntry)).toEqual(withEntry);
  expect(parseMachineBinding(JSON.parse(JSON.stringify(withEntry)))).toEqual(
    withEntry,
  );
  expect(parseMachineBinding(bindings.organization)?.entry).toBeUndefined();
  expect(() =>
    parseMachineBinding({ ...withEntry, entry: { ...entry, listenPort: 0 } }),
  ).toThrow();
  expect(() => parseMachineBinding({ ...withEntry, entry: null })).toThrow();
  expect(machineIdentity(withEntry)).toEqual(
    machineIdentity(bindings.organization),
  );
  const preferences = parseFolderPreferences({
    schemaVersion: 2,
    revision: 1,
    preset: {
      name: "hosted-organization-personal",
      version: 1,
      selection: "derived",
    },
    machine: withEntry,
    profile: presetProfile("hosted-organization-personal", "linux"),
    customInstructions: "",
  });
  expect(preferences.machine?.entry).toEqual(entry);
});

test.skipIf(process.platform === "win32")(
  "a handover that gains or loses the entry re-renders the Folder through folder-refresh and the manual shows it",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "folder-entry-")),
    );
    const folder = join(parent, "Lazurio");
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o755 });
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
      const preset = "hosted-organization-personal";
      const profile = presetProfile(preset, executionOs(process.platform));
      await initializeHandoverFolder(folder, {
        preset,
        machine: bindings.organization,
        profile,
      });
      const thisMachine = join(folder, "manual", "this-machine.md");
      expect(await readFile(thisMachine, "utf8")).not.toContain("- Entry:");
      // Machines re-applied with the entry: the same Machine, re-rendered.
      expect(await refreshFolder(folder, withEntry)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      const preferences = parseFolderPreferences(
        JSON.parse(
          await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
        ),
      );
      expect(preferences.machine?.entry).toEqual(entry);
      expect(await readFile(thisMachine, "utf8")).toContain(
        "- Entry: this Machine's Launchpad is reached at `https://launchpad.workspace.example.lazurio.io`",
      );
      expect(await refreshFolder(folder, withEntry)).toEqual({
        kind: "unchanged",
      });
      // Removed again: re-rendered without it.
      expect(await refreshFolder(folder, bindings.organization)).toEqual({
        kind: "refreshed",
        revision: 3,
      });
      expect(await readFile(thisMachine, "utf8")).not.toContain("- Entry:");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
