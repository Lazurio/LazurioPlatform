import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { resumeInitialization } from "../src/folder/resume-initialization";
import { updateProfile } from "../src/folder/update-profile";
import { bindings } from "./fixtures/machine-bindings";

const profile = {
  os: executionOs(process.platform),
  access: "remote",
  purpose: "human",
  locale: "cs",
  detail: "technical",
  coordination: "direct",
};
const source = {
  preset: "hosted-organization-personal",
  machine: bindings.organization,
  profile,
} as const;
const initialized = {
  kind: "initialized",
  revision: 1,
  preset: {
    name: "hosted-organization-personal",
    version: 1,
    selection: "derived",
  },
} as const;
async function setup() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "handover-init-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  return { parent, folder };
}
for (const stop of [
  null,
  "journal",
  "instructions",
  "preferences",
  "manifest",
  "layout",
] as const) {
  test.skipIf(process.platform === "win32")(
    `empty handover initializes/resumes at ${stop ?? "completion"} without moving work directories`,
    async () => {
      const { parent, folder } = await setup();
      try {
        const before = await Promise.all(
          [
            folder,
            join(folder, "organizations"),
            join(folder, "personalspace"),
          ].map(async (path) => {
            const s = await lstat(path);
            return [s.dev, s.ino, s.mode];
          }),
        );
        const result = initializeHandoverFolder(
          folder,
          source,
          async (step) => {
            if (step === stop) throw new Error("interrupted");
          },
        );
        if (stop) await expect(result).rejects.toThrow("interrupted");
        else expect(await result).toEqual(initialized);
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        const after = await Promise.all(
          [
            folder,
            join(folder, "organizations"),
            join(folder, "personalspace"),
          ].map(async (path) => {
            const s = await lstat(path);
            return [s.dev, s.ino, s.mode];
          }),
        );
        expect(after).toEqual(before);
        await writeFile(
          join(folder, "organizations", "keep"),
          "synthetic work",
        );
        await writeFile(
          join(folder, "personalspace", "keep"),
          "synthetic personal work",
        );
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        await expect(
          initializeHandoverFolder(folder, source),
        ).rejects.toThrow();
        expect(
          await readFile(join(folder, "organizations", "keep"), "utf8"),
        ).toBe("synthetic work");
        expect(
          await readFile(join(folder, "personalspace", "keep"), "utf8"),
        ).toBe("synthetic personal work");
        expect(
          await updateProfile(folder, 1, {
            profile: { ...profile, locale: "en" },
          }),
        ).toEqual({ kind: "updated", revision: 2 });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}
for (const scenario of [
  "manifest",
  "organization-work",
  "personal-work",
  "state",
  "missing-directory",
  "symlink",
  "writable",
] as const) {
  test.skipIf(process.platform === "win32")(
    `handover refuses ${scenario} before creating state`,
    async () => {
      const { parent, folder } = await setup();
      try {
        if (scenario === "manifest")
          await writeFile(
            join(folder, "launchpad.gen3.json"),
            "existing resident",
          );
        if (scenario === "organization-work")
          await writeFile(join(folder, "organizations", "keep"), "work");
        if (scenario === "personal-work")
          await writeFile(join(folder, "personalspace", "keep"), "work");
        if (scenario === "state") await mkdir(join(folder, ".lazurio"));
        if (scenario === "missing-directory" || scenario === "symlink")
          await rename(join(folder, "organizations"), join(parent, "saved"));
        if (scenario === "symlink")
          await symlink(join(parent, "saved"), join(folder, "organizations"));
        if (scenario === "writable")
          await chmod(join(folder, "organizations"), 0o777);
        const before = await readdir(folder);
        await expect(
          initializeHandoverFolder(folder, source),
        ).rejects.toThrow();
        expect(await readdir(folder)).toEqual(before);
        if (scenario !== "state")
          await expect(lstat(join(folder, ".lazurio"))).rejects.toThrow();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}
test.skipIf(process.platform === "win32")(
  "handover resume refuses replaced directories before completing generated files",
  async () => {
    const { parent, folder } = await setup();
    try {
      await expect(
        initializeHandoverFolder(folder, source, async (step) => {
          if (step === "journal") throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      await rename(join(folder, "organizations"), join(parent, "original"));
      await mkdir(join(folder, "organizations"));
      await expect(resumeInitialization(folder)).rejects.toThrow(
        "Handover layout changed",
      );
      await expect(lstat(join(folder, "AGENTS.md"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform === "win32")(
  "concurrent handover initializers have exactly one winner",
  async () => {
    const { parent, folder } = await setup();
    try {
      const results = await Promise.allSettled([
        initializeHandoverFolder(folder, source),
        initializeHandoverFolder(folder, source),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
