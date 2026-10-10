import { afterEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { acquireFolderOperationLock } from "../src/folder/lock";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { updateTools } from "../src/folder/update-profile";
import { applyOrganizationSettings } from "../src/organization-settings/apply";
import { bindings } from "./fixtures/machine-bindings";

// Decision F45, root decision 0194 point 4: the Environment applies the
// Organization's settings itself, safely again and again, and says how each
// one turned out. Applying is recording them in the Folder, which renders
// what they allow; an item the Folder cannot take is `failed` with its
// reason, a key this release does not know `unsupported`. The outcome says
// how the Folder answered: it took them, refused them with its reason, or
// gave no answer, after which the poller keeps the version applied before.

const os = executionOs(process.platform);
const key = "integrations.composio.allowed";
const off = { integrations: { composio: { allowed: false } } } as const;
const on = { integrations: { composio: { allowed: true } } } as const;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0))
    await rm(parent, { recursive: true, force: true });
});

async function workFolder() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "organization-settings-apply-")),
  );
  parents.push(parent);
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", os),
  });
  await updateTools(folder, 1, ["composio"]);
  return folder;
}

const agents = (folder: string) => readFile(join(folder, "AGENTS.md"), "utf8");
const preferences = async (folder: string) =>
  JSON.parse(
    await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
  );

test.skipIf(process.platform === "win32")(
  "applying is idempotent and reversible, and says how each setting turned out",
  async () => {
    const folder = await workFolder();
    const original = await agents(folder);
    const applied = [{ key, outcome: "applied" as const, detail: null }];
    expect(
      await applyOrganizationSettings(folder, { values: off, unsupported: [] }),
    ).toEqual({
      folder: "applied",
      reason: null,
      items: applied,
      changed: true,
    });
    expect(await agents(folder)).not.toContain("- `composio` (");
    // The same settings again: nothing written, still applied.
    expect(
      await applyOrganizationSettings(folder, { values: off, unsupported: [] }),
    ).toEqual({
      folder: "applied",
      reason: null,
      items: applied,
      changed: false,
    });
    // Allowed again: the person's choice is back.
    expect(
      await applyOrganizationSettings(folder, { values: on, unsupported: [] }),
    ).toEqual({
      folder: "applied",
      reason: null,
      items: applied,
      changed: true,
    });
    expect(await agents(folder)).toContain("- `composio` (");
    // No longer governed: removing it applied, and the Folder is as it was.
    expect(
      await applyOrganizationSettings(folder, { values: {}, unsupported: [] }),
    ).toEqual({
      folder: "applied",
      reason: null,
      items: applied,
      changed: true,
    });
    expect("organizationSettings" in (await preferences(folder))).toBe(false);
    expect(await agents(folder)).toBe(original);
    // Nothing governed now or before: nothing to say.
    expect(
      await applyOrganizationSettings(folder, { values: {}, unsupported: [] }),
    ).toEqual({ folder: "applied", reason: null, items: [], changed: false });
  },
);

test.skipIf(process.platform === "win32")(
  "a Folder edited by hand takes nothing and says why; once repaired, it applies",
  async () => {
    const folder = await workFolder();
    const original = await agents(folder);
    await appendFile(join(folder, "AGENTS.md"), "\nA local edit.\n");
    expect(
      await applyOrganizationSettings(folder, { values: off, unsupported: [] }),
    ).toEqual({
      folder: "refused",
      reason: "folder-drift",
      items: [{ key, outcome: "failed", detail: "folder-drift" }],
      changed: false,
    });
    expect("organizationSettings" in (await preferences(folder))).toBe(false);
    await writeFile(join(folder, "AGENTS.md"), original);
    expect(
      await applyOrganizationSettings(folder, { values: off, unsupported: [] }),
    ).toEqual({
      folder: "applied",
      reason: null,
      items: [{ key, outcome: "applied", detail: null }],
      changed: true,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a setting this release does not know is reported unsupported, the rest applied",
  async () => {
    const folder = await workFolder();
    expect(
      await applyOrganizationSettings(folder, {
        values: off,
        unsupported: [
          "future.limit",
          "integrations.company_apps.google.enabled",
        ],
      }),
    ).toEqual({
      folder: "applied",
      reason: null,
      items: [
        { key, outcome: "applied", detail: null },
        { key: "future.limit", outcome: "unsupported", detail: null },
        {
          key: "integrations.company_apps.google.enabled",
          outcome: "unsupported",
          detail: null,
        },
      ],
      changed: true,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a Folder another operation holds is waited for briefly, then reported busy",
  async () => {
    const folder = await workFolder();
    const lock = await acquireFolderOperationLock(join(folder, ".lazurio"));
    const sleeps: number[] = [];
    try {
      expect(
        await applyOrganizationSettings(
          folder,
          { values: off, unsupported: [] },
          {
            busyAttempts: 3,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
          },
        ),
      ).toEqual({
        folder: "unanswered",
        reason: "folder-busy",
        items: [{ key, outcome: "failed", detail: "folder-busy" }],
        changed: false,
      });
      expect(sleeps).toHaveLength(2);
    } finally {
      await lock.release();
    }
    expect(
      (
        await applyOrganizationSettings(folder, {
          values: off,
          unsupported: [],
        })
      ).changed,
    ).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "a Folder with an interrupted change gives no answer until it is resumed",
  async () => {
    const folder = await workFolder();
    // What a change that stopped half way leaves for `profile-resume`.
    const transaction = join(folder, ".lazurio", "transaction");
    await mkdir(transaction, { mode: 0o700 });
    expect(
      await applyOrganizationSettings(folder, { values: off, unsupported: [] }),
    ).toEqual({
      folder: "unanswered",
      reason: "folder-unavailable",
      items: [{ key, outcome: "failed", detail: "folder-unavailable" }],
      changed: false,
    });
    // Unreadable, the Folder cannot say what it governed before.
    expect(
      await applyOrganizationSettings(folder, { values: {}, unsupported: [] }),
    ).toEqual({
      folder: "unanswered",
      reason: "folder-unavailable",
      items: [],
      changed: false,
    });
    await rmdir(transaction);
    expect(
      await applyOrganizationSettings(folder, { values: off, unsupported: [] }),
    ).toMatchObject({ folder: "applied", changed: true });
  },
);
