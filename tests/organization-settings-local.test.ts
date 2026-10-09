import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  operatorGit,
  readRepositorySettings,
} from "../src/organization-settings/local";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { writeOrganization } from "./fixtures/catalog-folder";
import { bindings } from "./fixtures/machine-bindings";
import { writeOwnedFixture } from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// Root decision 0194 point 3: an installation with the Organization's
// repository cloned reads the same document from Git. Decision F45: on an
// Organization's Environment without the relay, the Launchpad reads the
// settings of the Organization its handover names from that Organization's
// root in the Folder, at the root's commit: the version and the settings
// always belong together, and an uncommitted edit is not a setting.

const os = executionOs(process.platform);
const off = { integrations: { composio: { allowed: false } } } as const;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0))
    await rm(parent, { recursive: true, force: true });
});

async function git(directory: string, ...args: string[]) {
  const result = await runChild(
    [
      "git",
      "-C",
      directory,
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { env: { PATH: process.env.PATH, HOME: directory, LC_ALL: "C" } },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function environment() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "organization-settings-local-")),
  );
  parents.push(parent);
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  // A Team Environment of the Organization `example`: no relay yet.
  await initializeHandoverFolder(folder, {
    preset: "hosted-organization-team",
    machine: bindings.team,
    profile: presetProfile("hosted-organization-team", os),
  });
  const root = await writeOrganization(folder, "Example_GEN3", {
    slug: "example",
    state: "current",
    modules: [],
  });
  await git(root, "init", "--quiet", "--initial-branch=main");
  const manifest = join(root, "lazurio.organization.json");
  const document = JSON.parse(await readFile(manifest, "utf8"));
  const commitWith = async (settings: unknown) => {
    const next = settings === undefined ? document : { ...document, settings };
    await writeOwnedFixture(manifest, JSON.stringify(next));
    await git(root, "add", "--all");
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "settings");
    return git(root, "rev-parse", "HEAD");
  };
  const reader = operatorGit(
    toolsEnvironmentOf(
      { PATH: process.env.PATH, HOME: parent },
      process.platform,
    ),
  );
  return { folder, root, manifest, document, commitWith, reader };
}

test.skipIf(process.platform === "win32")(
  "the handover's Organization: its settings at the root's commit",
  async () => {
    const { folder, commitWith, reader } = await environment();
    const version = await commitWith(off);
    expect(await readRepositorySettings(folder, "example", reader)).toEqual({
      kind: "settings",
      settings: { organization: null, version, values: off, unsupported: [] },
    });
  },
);

test.skipIf(process.platform === "win32")(
  "an edit that is not committed is not a setting",
  async () => {
    const { folder, manifest, document, commitWith, reader } =
      await environment();
    const version = await commitWith(off);
    await writeOwnedFixture(
      manifest,
      JSON.stringify({
        ...document,
        settings: { integrations: { composio: { allowed: true } } },
      }),
    );
    expect(await readRepositorySettings(folder, "example", reader)).toEqual({
      kind: "settings",
      settings: { organization: null, version, values: off, unsupported: [] },
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a commit without the section governs nothing; a broken section is invalid at its commit",
  async () => {
    const { folder, commitWith, reader } = await environment();
    const plain = await commitWith(undefined);
    expect(await readRepositorySettings(folder, "example", reader)).toEqual({
      kind: "settings",
      settings: {
        organization: null,
        version: plain,
        values: {},
        unsupported: [],
      },
    });
    const broken = await commitWith({
      integrations: { composio: { allowed: "no" } },
    });
    expect(await readRepositorySettings(folder, "example", reader)).toEqual({
      kind: "invalid",
      version: broken,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "no root of that Organization, or no Git checkout, is no answer",
  async () => {
    const { folder, root, commitWith, reader } = await environment();
    await commitWith(off);
    expect(await readRepositorySettings(folder, "other", reader)).toEqual({
      kind: "failed",
      error: "repository_unavailable",
      detail: "organization-absent",
    });
    await rm(join(root, ".git"), { recursive: true, force: true });
    expect(await readRepositorySettings(folder, "example", reader)).toEqual({
      kind: "failed",
      error: "repository_unavailable",
      detail: "commit-unavailable",
    });
  },
);
