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
  ownAccount,
  vaultMember,
  vaultName,
  workAccount,
} from "./fixtures/fake-vault";
import {
  assignments,
  binding,
  handoverEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// The production composition of the Environment vault's facts (decisions
// F43, F53) on real files: a root-issued handover and a hosted Folder under a
// private root, read as `lazurio vault` and the Launchpad read them. Only the
// handover's place and the operator's system record are this test's.

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;
const network = {
  headscale_server_url: "https://headscale.example.lazurio.io",
  headscale_hostname: "example",
};
const personalDocument = {
  ...personal,
  network,
  entry: handoverEntry("example.lazurio.io"),
};
const teamDocument = {
  ...organization,
  owner: { ...organization.owner, assignment: assignments.team },
  network: { ...network, headscale_hostname: "example-workspace" },
  entry: handoverEntry("workspace.example.lazurio.io"),
};
const documents = {
  personal: { ...personalDocument, vault: vaultMember() },
  team: {
    ...teamDocument,
    vault: vaultMember(workAccount, "Example Týmový workspace"),
  },
  // Handovers that name no vault yet: a 0197 pilot's derivation.
  personalPilot: personalDocument,
  teamPilot: teamDocument,
} as const;
const presets: Record<keyof typeof documents, PresetName> = {
  personal: "hosted-personal",
  team: "hosted-organization-team",
  personalPilot: "hosted-personal",
  teamPilot: "hosted-organization-team",
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
  if (presets[of] === "hosted-personal")
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
  "the declared operator of a hosted Folder on Linux gets its Environment's own vault, or a 0197 pilot's where the handover names none",
  async () => {
    const read = (vm: Awaited<ReturnType<typeof machine>>) =>
      readVaultContext({
        folder: vm.folder,
        platform: "linux",
        home: "/home/operator",
        sources: vm.sources(),
      });
    const vms = {
      personal: await machine("personal"),
      team: await machine("team"),
      personalPilot: await machine("personalPilot"),
      teamPilot: await machine("teamPilot"),
    };
    try {
      expect(await read(vms.personal)).toEqual({
        kind: "own",
        vault: "https://vaultwarden.example.lazurio.io",
        host: "vaultwarden.example.lazurio.io",
        account: ownAccount,
        name: vaultName,
        environment: "personal",
        organization: null,
        assignment: null,
      });
      expect(await read(vms.team)).toMatchObject({
        kind: "own",
        account: workAccount,
        name: "Example Týmový workspace",
        environment: "team",
        organization: "example",
      });
      expect(await read(vms.personalPilot)).toEqual({
        kind: "pilot",
        vault: "https://vaultwarden.example.lazurio.io",
        host: "vaultwarden.example.lazurio.io",
        address: "example.lazurio.io",
        account: "vaultwarden@example.lazurio.io",
        environment: "personal",
        organization: null,
      });
      expect(await read(vms.teamPilot)).toMatchObject({
        kind: "pilot",
        account: "vaultwarden@workspace.example.lazurio.io",
        environment: "team",
        organization: "example",
      });
    } finally {
      for (const vm of Object.values(vms)) await vm.close();
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
