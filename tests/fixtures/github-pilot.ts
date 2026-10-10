import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeHandoverFolder } from "../../src/folder/initialize-folder";
import type { MachineBinding } from "../../src/folder/machine-binding";
import { executionOs } from "../../src/folder/platform";
import { type PresetName, presetProfile } from "../../src/folder/presets";
import {
  type PilotOrganization,
  type PilotPaths,
  pilotPaths,
  pilotSchema,
  writePilot,
} from "../../src/github/pilot";
import { signInSchema, writeStoredSignIn } from "../../src/github/store";
import type { FakeGithub } from "./fake-github";
import { bindings } from "./machine-bindings";

// A home of an Environment user for the GitHub sign-in pilot (decision F46):
// its own HOME, PATH and Git configuration (never the machine's), and a
// hosted Folder of the chosen preset for the Work Environment gate.

export const gitPath = async () => {
  const found = Bun.which("git");
  if (found === null) throw new Error("git is required by these tests");
  return dirname(found);
};

export type PilotWorld = Readonly<{
  root: string;
  home: string;
  bin: string;
  env: Record<string, string>;
  paths: PilotPaths;
  folder: string | undefined;
  hostedFolder: () => Promise<string | undefined>;
  cleanup: () => Promise<void>;
}>;

export async function pilotWorld(
  options: Readonly<{
    preset?: PresetName | null;
    machine?: MachineBinding;
  }> = {},
): Promise<PilotWorld> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-github-pilot-")),
  );
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o755 });
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${bin}:${await gitPath()}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C",
  };
  const paths = pilotPaths(env) as PilotPaths;
  const preset =
    options.preset === undefined
      ? "hosted-organization-personal"
      : options.preset;
  let folder: string | undefined;
  if (preset !== null) {
    folder = join(home, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    if (preset === "hosted-personal")
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeHandoverFolder(folder, {
      preset,
      machine:
        options.machine ??
        (preset === "hosted-personal"
          ? bindings.personal
          : preset === "hosted-organization-team"
            ? bindings.assignedTeam
            : bindings.assignedOperator),
      profile: presetProfile(preset, executionOs(process.platform)),
    });
  }
  return Object.freeze({
    root,
    home,
    bin,
    env,
    paths,
    folder,
    hostedFolder: async () => folder,
    cleanup: () => rm(root, { recursive: true, force: true }),
  });
}

export const exampleOrganization: PilotOrganization = Object.freeze({
  login: "Example",
  clientId: "Iv23liFixture0000001",
});
export const otherOrganization: PilotOrganization = Object.freeze({
  login: "Other",
  clientId: "Iv23liFixture0000002",
});

export async function enablePilot(
  world: PilotWorld,
  organizations: readonly PilotOrganization[] = [exampleOrganization],
): Promise<void> {
  await writePilot(world.paths, {
    schema: pilotSchema,
    organizations,
    wiring: null,
  });
}

/** A finished sign-in, its tokens issued by the fake GitHub. */
export async function storeSignIn(
  world: PilotWorld,
  github: FakeGithub,
  organization: PilotOrganization,
  times: Readonly<{
    now?: number;
    accessMs?: number;
    refreshMs?: number;
  }> = {},
) {
  const now = times.now ?? Date.now();
  const pair = github.issue();
  await writeStoredSignIn(world.paths, {
    schema: signInSchema,
    organization: { login: organization.login, id: 4242 },
    clientId: organization.clientId,
    installationId: 777,
    account: { login: "example", id: 12345 },
    accessToken: pair.access,
    accessTokenExpiresAt: new Date(
      now + (times.accessMs ?? 8 * 3600 * 1000),
    ).toISOString(),
    refreshToken: pair.refresh,
    refreshTokenExpiresAt: new Date(
      now + (times.refreshMs ?? 180 * 24 * 3600 * 1000),
    ).toISOString(),
    signedInAt: new Date(now).toISOString(),
    refreshedAt: null,
  });
  return pair;
}

/** A stand-in for the official gh: a script that records its arguments and
 * the GH_TOKEN it got, and exits with `GH_FAKE_EXIT` (default 0). */
export async function fakeGh(directory: string, name = "gh"): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "# fake official gh",
      `printf "%s\\n" "token=\${GH_TOKEN:-none}" "github_token=\${GITHUB_TOKEN:-none}" "args=$*" > "\${GH_FAKE_RECORD:-/dev/null}"`,
      `exit "\${GH_FAKE_EXIT:-0}"`,
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}
