import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { runThemeCommand, type ThemeContext } from "../src/theme/cli";
import {
  fileThemeStore,
  memoryThemeStore,
  type ThemeStore,
} from "../src/theme/record";
import { installBase } from "../src/update/cli";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import { commitOf, target } from "./fixtures/update-world";

// `lazurio theme show|set` (root decision 0208 point 1): the Environment's
// theme for its agents, over the same record and change as Settings →
// Obecné. JSON on stdout; on a public Environment the theme is fixed, so
// `set` is refused there with the reason on stderr and `show` still answers.

const posixTest = test.skipIf(process.platform === "win32");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function world(
  kind: "workstation" | "hosted" | "public",
  locale: "cs" | "en" = "en",
) {
  root = await realpath(await mkdtemp(join(tmpdir(), "theme-cli-")));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const folder = join(home, "Lazurio");
  if (kind === "workstation")
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform), { locale }),
    );
  else {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    await initializeHandoverFolder(folder, {
      preset,
      machine: organizationWithEntry(
        20000,
        "workspace.example.lazurio.io",
        false,
        false,
        kind === "public",
      ),
      profile: presetProfile(preset, executionOs(process.platform), {
        locale,
      }),
    });
  }
  const context: ThemeContext = {
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: { HOME: home, PATH: "" },
    executable: join(root, "unused"),
    hostedFolder: undefined,
  };
  return { home, folder, context };
}

const json = (output: { stdout?: string }) => JSON.parse(output.stdout ?? "");

posixTest(
  "show and set through the install base's record: the same record the Launchpad reads",
  async () => {
    const { folder, context } = await world("workstation");
    const shown = await runThemeCommand(["show", "--folder", folder], context);
    expect(shown.code).toBe(0);
    expect(json(shown)).toEqual({
      kind: "theme",
      theme: "lazurio",
      label: "Lazurio",
      revision: 0,
      setAt: null,
      themes: [
        { id: "lazurio", label: "Lazurio" },
        { id: "grove", label: "Grove" },
        { id: "ocean", label: "Ocean" },
        { id: "ember", label: "Ember" },
        { id: "iris", label: "Iris" },
      ],
    });
    const set = await runThemeCommand(
      ["set", "ocean", "--folder", folder],
      context,
    );
    expect(set.code).toBe(0);
    expect(json(set)).toMatchObject({
      kind: "theme",
      outcome: "set",
      theme: "ocean",
      label: "Ocean",
      revision: 1,
    });
    // The Launchpad's store of this Folder in the same base sees it.
    const launchpad = fileThemeStore(installBase(context, undefined), folder);
    expect(await launchpad.read()).toMatchObject({
      theme: "ocean",
      revision: 1,
    });
    // The record is the base's, never the Folder's.
    expect(await readdir(join(folder, ".lazurio"))).not.toContain("theme.json");
    // The same theme again: unchanged, nothing written.
    const again = await runThemeCommand(
      ["set", "ocean", "--folder", folder],
      context,
    );
    expect(json(again)).toMatchObject({ outcome: "unchanged", revision: 1 });
  },
);

posixTest(
  "with --expected-revision only at that revision, else the current record",
  async () => {
    const { folder, context } = await world("hosted");
    const store = memoryThemeStore();
    const stores: ThemeContext = { ...context, store: () => store };
    expect(
      json(
        await runThemeCommand(
          ["set", "grove", "--expected-revision", "0", "--folder", folder],
          stores,
        ),
      ),
    ).toMatchObject({ outcome: "set", theme: "grove", revision: 1 });
    const stale = await runThemeCommand(
      ["set", "iris", "--expected-revision", "0", "--folder", folder],
      stores,
    );
    expect(stale.code).toBe(1);
    expect(json(stale)).toMatchObject({
      kind: "blocked",
      reason: "theme-changed",
      theme: "grove",
      revision: 1,
    });
    expect((await store.read()).theme).toBe("grove");
  },
);

for (const locale of ["en", "cs"] as const)
  posixTest(
    `a public Environment's theme is fixed: set refused with the reason (${locale}), show still answers`,
    async () => {
      const { folder, context } = await world("public", locale);
      let changes = 0;
      const store = memoryThemeStore();
      const watched: ThemeStore = {
        read: store.read,
        change: async (...asked) => {
          changes += 1;
          return store.change(...asked);
        },
      };
      const stores: ThemeContext = { ...context, store: () => watched };
      const refused = await runThemeCommand(
        ["set", "ocean", "--folder", folder],
        stores,
      );
      expect(refused.code).toBe(1);
      expect(json(refused)).toEqual({
        kind: "blocked",
        reason: "public-environment",
      });
      expect(refused.stderr).toBe(
        locale === "cs"
          ? "Toto Prostředí je veřejné a sdílí ho jeho návštěvníci, proto má pevné téma. Nic se nezměnilo."
          : "This Environment is public and shared by its visitors, so its theme is fixed. Nothing was changed.",
      );
      expect(changes).toBe(0);
      const shown = await runThemeCommand(["show", "--folder", folder], stores);
      expect(shown.code).toBe(0);
      expect(json(shown)).toMatchObject({ theme: "lazurio", revision: 0 });
    },
  );

posixTest("a wrong invocation is the usage, and nothing is read", async () => {
  const { folder, context } = await world("workstation");
  let asked = 0;
  const stores: ThemeContext = {
    ...context,
    store: () => {
      asked += 1;
      return memoryThemeStore();
    },
  };
  for (const args of [
    [],
    ["list"],
    ["show", "ocean"],
    ["show", "--expected-revision", "1"],
    ["set"],
    ["set", "t3-chat"],
    ["set", "Ocean"],
    ["set", "ocean", "iris"],
    ["set", "ocean", "--expected-revision", "-1"],
    ["set", "ocean", "--expected-revision", "01"],
    ["set", "ocean", "--expected-revision", "x"],
    ["set", "ocean", "--folder", "relative/Lazurio"],
    ["set", "ocean", "--folder", `${folder}/../Lazurio`],
    ["set", "ocean", "--folder", folder, "--folder", folder],
    ["set", "ocean", "--unknown"],
  ]) {
    const output = await runThemeCommand(args, stores);
    expect([args.join(" "), output.code]).toEqual([args.join(" "), 2]);
    expect(output.stderr).toContain("Usage: theme show");
  }
  expect(asked).toBe(0);
});

posixTest(
  "without a Folder or with an unreadable one: unavailable, nothing changed",
  async () => {
    const { home, context } = await world("workstation");
    const none = await runThemeCommand(["show"], context);
    expect(none.code).toBe(1);
    expect(json(none)).toEqual({
      kind: "theme",
      state: "unavailable",
      reason: "no-folder",
    });
    const missing = join(home, "Missing");
    const unreadable = await runThemeCommand(
      ["set", "ocean", "--folder", missing],
      context,
    );
    expect(unreadable.code).toBe(1);
    expect(json(unreadable)).toEqual({
      kind: "theme",
      state: "unavailable",
      reason: "folder-unreadable",
    });
  },
);
