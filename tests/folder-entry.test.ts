import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { parseFolderPreferences } from "../src/folder/state";
import { updateEntry, updateProfile } from "../src/folder/update-profile";
import { parseHostedEntry } from "../src/launchpad/hosted-trust";
import { bindings } from "./fixtures/machine-bindings";

const entry = parseHostedEntry({
  externalOrigin: "https://launchpad.workspace.example.lazurio.io",
  authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
  authCookieName: "__Secure-lazurio-workspace",
  listenPort: 20000,
});
const os = executionOs(process.platform);

test("preferences read without an entry as null, round-trip a recorded one, and refuse one without a Machine", () => {
  const base = {
    schemaVersion: 2,
    revision: 1,
    preset: {
      name: "hosted-organization-personal",
      version: 1,
      selection: "derived",
    },
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", "linux"),
    customInstructions: "",
  };
  expect(parseFolderPreferences(base).entry).toBeNull();
  expect(parseFolderPreferences({ ...base, entry: null }).entry).toBeNull();
  const recorded = parseFolderPreferences({ ...base, entry });
  expect(recorded.entry).toEqual(entry);
  expect(parseFolderPreferences(JSON.parse(JSON.stringify(recorded)))).toEqual(
    recorded,
  );
  expect(() =>
    parseFolderPreferences({ ...base, entry: { ...entry, listenPort: 0 } }),
  ).toThrow();
  expect(() =>
    parseFolderPreferences({
      ...base,
      preset: { name: "local", version: 1, selection: "derived" },
      machine: null,
      profile: presetProfile("local", "linux"),
      entry,
    }),
  ).toThrow("Machine binding");
});

test.skipIf(process.platform === "win32")(
  "entry-update records the hosted entry at the expected revision through the one transaction and the manual shows it",
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
      const profile = presetProfile(preset, os);
      await initializeHandoverFolder(folder, {
        preset,
        machine: bindings.organization,
        profile,
      });
      const thisMachine = join(folder, "manual", "this-machine.md");
      expect(await readFile(thisMachine, "utf8")).not.toContain("- Entry:");
      // Stale revision: blocked, nothing written.
      expect(await updateEntry(folder, 2, entry)).toMatchObject({
        kind: "blocked",
        reason: "stale-revision",
      });
      expect(await updateEntry(folder, 1, entry)).toEqual({
        kind: "updated",
        revision: 2,
      });
      const preferences = parseFolderPreferences(
        JSON.parse(
          await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
        ),
      );
      expect(preferences.revision).toBe(2);
      expect(preferences.entry).toEqual(entry);
      expect(preferences.profile).toEqual(profile);
      expect(await readFile(thisMachine, "utf8")).toContain(
        "- Entry: this Machine's Launchpad is reached at `https://launchpad.workspace.example.lazurio.io`",
      );
      // The same entry again renders the same bytes: unchanged, revision stays.
      expect(await updateEntry(folder, 2, entry)).toEqual({
        kind: "unchanged",
      });
      // A profile change carries the entry forward.
      expect(
        await updateProfile(folder, 2, {
          profile: { ...profile, locale: "cs" },
        }),
      ).toEqual({ kind: "updated", revision: 3 });
      const after = parseFolderPreferences(
        JSON.parse(
          await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
        ),
      );
      expect(after.entry).toEqual(entry);
      expect(await readFile(thisMachine, "utf8")).toContain("- Entry:");
      // Clearing it is a change too.
      expect(await updateEntry(folder, 3, null)).toEqual({
        kind: "updated",
        revision: 4,
      });
      expect(await readFile(thisMachine, "utf8")).not.toContain("- Entry:");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a workstation Folder without a handover cannot record a hosted entry",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "folder-entry-local-")),
    );
    const folder = join(parent, "Lazurio");
    try {
      await initializeFolder(folder, presetProfile("local", os));
      expect(await updateEntry(folder, 1, entry)).toMatchObject({
        kind: "blocked",
        reason: "entry-requires-machine",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
