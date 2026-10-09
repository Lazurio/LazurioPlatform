import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { machineContextPath } from "../src/machine/context";
import type { HostedOperatorSources } from "../src/machine/operator";
import type {
  VaultUnsupported,
  VaultUnsupportedReason,
} from "../src/vault/context";
import { readVaultContext } from "../src/vault/host";
import {
  assignments,
  binding,
  handoverEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// The production composition of the Environment vault's facts (decision
// F43) on real files: a root-issued handover and a hosted Folder under a
// private root, read as `lazurio vault` and the Launchpad read them. Only the
// handover's place and the operator's system record are this test's.

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;
const network = {
  headscale_server_url: "https://headscale.example.lazurio.io",
  headscale_hostname: "example",
};
const documents = {
  personal: {
    ...personal,
    network,
    entry: handoverEntry("example.lazurio.io"),
  },
  team: {
    ...organization,
    owner: { ...organization.owner, assignment: assignments.team },
    network: { ...network, headscale_hostname: "example-workspace" },
    entry: handoverEntry("workspace.example.lazurio.io"),
  },
} as const;
const presets: Record<keyof typeof documents, PresetName> = {
  personal: "hosted-personal",
  team: "hosted-organization-team",
};

async function machine(of: keyof typeof documents, handover = true) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-host-")));
  const root = join(parent, "machine");
  await mkdir(root, { mode: 0o755 });
  if (handover) {
    const file = join(root, machineContextPath);
    await mkdir(dirname(file), { recursive: true, mode: 0o755 });
    await writeFile(file, JSON.stringify(documents[of]), { mode: 0o644 });
  }
  const folder = join(root, "home", "operator", "Lazurio");
  await mkdir(join(folder, "organizations"), { recursive: true, mode: 0o700 });
  // The personal preset's layout holds the Personalspace mount too.
  if (of === "personal")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset: presets[of],
    machine: binding(documents[of]),
    profile: presetProfile(presets[of], executionOs(process.platform)),
  });
  const sources = (username = "operator"): HostedOperatorSources => ({
    handover: { platform: "linux", root, custodian: uid },
    operator: async () =>
      Object.freeze({
        platform: "linux",
        uid: 1000,
        username,
        homedir: `/home/${username}`,
      }),
  });
  return {
    folder,
    sources,
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

test.skipIf(!posix || uid === 0)(
  "the declared operator of a hosted Folder on Linux gets the vault facts of its Environment",
  async () => {
    const personalVm = await machine("personal");
    const teamVm = await machine("team");
    try {
      expect(
        await readVaultContext({
          folder: personalVm.folder,
          platform: "linux",
          home: "/home/operator",
          sources: personalVm.sources(),
        }),
      ).toMatchObject({
        vault: "https://vaultwarden.example.lazurio.io",
        account: "vaultwarden@example.lazurio.io",
        kind: "personal",
        collection: "Environmenty/Osobní · example",
      });
      // A Team Environment whose Folder does not hold its Organization yet
      // is named by its kind, as the rail names it.
      expect(
        await readVaultContext({
          folder: teamVm.folder,
          platform: "linux",
          home: "/home/operator",
          sources: teamVm.sources(),
        }),
      ).toMatchObject({
        account: "vaultwarden@workspace.example.lazurio.io",
        kind: "team",
        collection: "Environmenty/Týmový · workspace",
      });
    } finally {
      await personalVm.close();
      await teamVm.close();
    }
  },
);

test.skipIf(!posix || uid === 0)(
  "anything but the declared operator of a readable hosted Folder on Linux has no vault account",
  async () => {
    const vm = await machine("personal");
    const missing = await machine("personal", false);
    try {
      const read = (
        input: Partial<Parameters<typeof readVaultContext>[0]> = {},
      ) =>
        readVaultContext({
          folder: vm.folder,
          platform: "linux",
          home: "/home/operator",
          sources: vm.sources(),
          ...input,
        });
      const refused = (reason: VaultUnsupportedReason): VaultUnsupported => ({
        kind: "unsupported",
        reason,
      });
      expect(await read({ platform: "darwin" })).toEqual(
        refused("workstation"),
      );
      expect(await read({ folder: undefined })).toEqual(refused("workstation"));
      expect(await read({ home: "/home/somebody" })).toEqual(
        refused("not-operator"),
      );
      expect(await read({ sources: vm.sources("somebody") })).toEqual(
        refused("not-operator"),
      );
      expect(await read({ folder: join(vm.folder, "missing") })).toEqual(
        refused("folder-unreadable"),
      );
      expect(
        await read({ folder: missing.folder, sources: missing.sources() }),
      ).toEqual(refused("handover-missing"));
    } finally {
      await vm.close();
      await missing.close();
    }
  },
);
