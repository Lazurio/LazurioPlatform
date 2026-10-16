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
// handover's place and the operator's system record are this test's. A
// personal Environment whose handover names no vault keeps its vault in its
// person's own Bitwarden (root decision 0203 point 7): connected, a
// connected 0197 pilot as before, or waiting for its person.

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
  // The custody of the accounts and the personal connection.
  const state = join(parent, "state");
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
    directory: (host: string, key: string) => join(state, host, key),
    connection: join(state, "personal"),
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

/** A file of the custody, as the Platform writes it. */
async function custody(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
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
        directory: vm.directory,
        connection: vm.connection,
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
      // A personal Environment that was never connected the 0197 way: its
      // person connects their own Bitwarden.
      expect(await read(vms.personalPilot)).toEqual({
        kind: "needs-connection",
      });
      // Connected the 0197 way: the pilot, read as before.
      const pilot = vms.personalPilot.directory(
        "vaultwarden.example.lazurio.io",
        "example.lazurio.io",
      );
      await custody(join(pilot, "bw", "lazurio-account.json"), {
        email: "vaultwarden@example.lazurio.io",
        server: "https://vaultwarden.example.lazurio.io",
        deviceIdentifier: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
        masterPassword: "a".repeat(43),
        createdAt: "2026-10-01T00:00:00.000Z",
        clientId: "user.6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
        clientSecret: "a1b2c3d4e5f6a1b2",
      });
      await custody(join(pilot, "bw", "lazurio-vault.json"), {
        organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
        collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
        fingerprint: "invented-fingerprint-phrase",
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
      await rm(pilot, { recursive: true });
      // Connected to its person's own Bitwarden: the agents' account in the
      // region, the organization "Osobní <owner's login>", the person's
      // own account to invite.
      const connection = join(vms.personalPilot.connection, "connection.json");
      await custody(connection, {
        region: "eu",
        account: "agents.example+lazurio@example.com",
        invitee: "person@example.com",
      });
      expect(await read(vms.personalPilot)).toEqual({
        kind: "own",
        vault: "https://vault.bitwarden.eu",
        host: "vault.bitwarden.eu",
        account: "agents.example+lazurio@example.com",
        name: "Osobní example",
        environment: "personal",
        organization: null,
        assignment: null,
        bitwarden: { region: "eu", invitee: "person@example.com" },
      });
      // A connection that does not read is never guessed.
      await writeFile(connection, '{"region":"eu"}');
      expect(await read(vms.personalPilot)).toEqual({
        kind: "unsupported",
        reason: "connection-unreadable",
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
          directory: vm.directory,
          connection: vm.connection,
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
