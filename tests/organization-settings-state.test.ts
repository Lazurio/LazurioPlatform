import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppliedState,
  fileStateStore,
  settingsStateFile,
} from "../src/organization-settings/state";
import { commit } from "./fixtures/fake-relay";

// Decision F45: the last applied version is product state of the Folder,
// kept in the per-user install base beside the update state and the content
// locks (the Folder's `.lazurio/` admits no foreign entry, and releases
// before this one must keep reading it): one owner-only file per Folder,
// written durably. It is bookkeeping, never authority: what applies is what
// the Folder records. A record that cannot be read is said, never guessed.

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0))
    await rm(parent, { recursive: true, force: true });
});

async function base() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "organization-settings-state-")),
  );
  parents.push(parent);
  return join(parent, "share", "lazurio");
}

const state: AppliedState = {
  source: "dashboard",
  version: commit("a"),
  organization: { githubOrgId: 123, login: "Example" },
  settings: { integrations: { composio: { allowed: false } } },
  unsupported: ["future.limit"],
  appliedAt: "2026-10-09T20:00:01.000Z",
  items: [
    {
      key: "integrations.composio.allowed",
      outcome: "applied",
      detail: null,
    },
    { key: "future.limit", outcome: "unsupported", detail: null },
  ],
  lastError: null,
  checkedAt: "2026-10-09T20:00:01.000Z",
};

test.skipIf(process.platform === "win32")(
  "the record is the Folder's own, owner-only, in the install base, and reads back exactly",
  async () => {
    const installBase = await base();
    const folder = "/home/operator/Lazurio";
    const store = fileStateStore(installBase, folder);
    expect(await store.read()).toEqual({ kind: "absent" });
    await store.write(state);
    expect(await store.read()).toEqual({ kind: "state", state });
    const file = settingsStateFile(installBase, folder);
    expect(file.startsWith(join(installBase, "organization-settings"))).toBe(
      true,
    );
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(
      (await lstat(join(installBase, "organization-settings"))).mode & 0o777,
    ).toBe(0o700);
    // Another Folder has a record of its own.
    expect(settingsStateFile(installBase, "/home/other/Lazurio")).not.toBe(
      file,
    );
    expect(
      await fileStateStore(installBase, "/home/other/Lazurio").read(),
    ).toEqual({ kind: "absent" });
    // Rewritten in place, nothing left beside it.
    await store.write({ ...state, lastError: "dashboard_unreachable" });
    expect(
      await readdir(join(installBase, "organization-settings")),
    ).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "a record that is not exactly what was written reads as corrupt, never as state",
  async () => {
    const installBase = await base();
    const folder = "/home/operator/Lazurio";
    const store = fileStateStore(installBase, folder);
    await store.write(state);
    const file = settingsStateFile(installBase, folder);
    for (const content of [
      "not json",
      "{}",
      JSON.stringify({ schemaVersion: 1, ...state, extra: true }),
      JSON.stringify({ schemaVersion: 2, ...state }),
      JSON.stringify({ schemaVersion: 1, ...state, version: "abc" }),
      JSON.stringify({ schemaVersion: 1, ...state, lastError: "other" }),
      JSON.stringify({
        schemaVersion: 1,
        ...state,
        settings: { integrations: { composio: { allowed: "no" } } },
      }),
      '{"schemaVersion":1,"schemaVersion":1}',
      "x".repeat(70 * 1024),
    ]) {
      await writeFile(file, content, { mode: 0o600 });
      expect(await store.read()).toEqual({ kind: "corrupt" });
    }
    // A record others may write, or a link in its place, is not this
    // account's own.
    await writeFile(file, JSON.stringify({ schemaVersion: 1, ...state }), {
      mode: 0o600,
    });
    await chmod(file, 0o666);
    expect(await store.read()).toEqual({ kind: "corrupt" });
    await rm(file);
    const elsewhere = join(installBase, "elsewhere.json");
    await mkdir(installBase, { recursive: true });
    await writeFile(elsewhere, JSON.stringify({ schemaVersion: 1, ...state }), {
      mode: 0o600,
    });
    await symlink(elsewhere, file);
    expect(await store.read()).toEqual({ kind: "corrupt" });
    // The next write replaces what could not be read.
    await rm(file);
    await store.write(state);
    expect(await store.read()).toEqual({ kind: "state", state });
  },
);
