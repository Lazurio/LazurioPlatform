import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { runTool } from "../src/tools/status";
import {
  ownPaths,
  vaultSecrets,
  vaultSecretsAdmission,
  vaultSetup,
} from "../src/vault/flow";
import { processVaultHost } from "../src/vault/host";
import { readRecord } from "../src/vault/store";
import {
  configureWorkstationVault,
  disconnectWorkstationVault,
  workstationVaultContext,
} from "../src/vault/workstation";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  startFakeVault,
  zipOf,
} from "./fixtures/fake-vault";

const server = "https://vaultwarden.example.lazurio.io";
const input = { organization: "Example", server, name: "Example computer" };
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "workstation-vault-")),
  );
  const folder = join(root, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  const directory = join(root, ".local/state/lazurio/vault/workstation");
  const host = processVaultHost({
    folder: async () => folder,
    platform: "darwin",
    env: { HOME: root },
    run: runTool,
  });
  return {
    root,
    folder,
    directory,
    host,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("Mac module admission selects only its explicit Organization, never Personalspace or the first binding", async () => {
  const f = await fixture();
  try {
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Example",
        personalspace: false,
      }),
    ).toBe("workstation");
    const one = await configureWorkstationVault(f.directory, input);
    const [again, other] = await Promise.all([
      configureWorkstationVault(f.directory, input),
      configureWorkstationVault(f.directory, {
        ...input,
        organization: "Other",
      }),
    ]);
    expect(again).toEqual(one);
    expect(other.account).not.toBe(one.account);
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "EXAMPLE",
        personalspace: false,
      }),
    ).toBeNull();
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Missing",
        personalspace: false,
      }),
    ).toBe("workstation");
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Example",
        personalspace: true,
      }),
    ).toBe("workstation");
    expect(await f.host.context()).toEqual({
      kind: "unsupported",
      reason: "workstation",
    });
    await expect(
      configureWorkstationVault(f.directory, {
        ...input,
        server: "https://different.example.com",
      }),
    ).rejects.toThrow();
    await disconnectWorkstationVault(f.directory, "example");
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Example",
        personalspace: false,
      }),
    ).toBe("workstation");
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Other",
        personalspace: false,
      }),
    ).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("invalid or symlinked workstation bindings fail closed before a provider runs", async () => {
  const f = await fixture();
  try {
    await configureWorkstationVault(f.directory, input);
    const file = join(f.directory, "bindings.json");
    await writeFile(file, '{"schema":1,"schema":1,"bindings":[]}');
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Example",
        personalspace: false,
      }),
    ).toBe("no-vault-identity");
    await rm(file);
    await symlink(join(f.root, "missing.json"), file);
    expect(
      await vaultSecretsAdmission(f.host, {
        company: "Example",
        personalspace: false,
      }),
    ).toBe("no-vault-identity");
    await expect(
      configureWorkstationVault(f.directory, {
        ...input,
        organization: "../foreign",
      }),
    ).rejects.toThrow();
    await expect(
      configureWorkstationVault(f.directory, {
        ...input,
        server: "http://vault.example.com",
      }),
    ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test("a generated workstation identity uses existing own-vault setup and re-reads rotation without exposing unrelated items", async () => {
  const f = await fixture();
  const vault = await startFakeVault(f.root);
  try {
    const binding = await configureWorkstationVault(f.directory, input);
    const context = await workstationVaultContext(
      f.directory,
      input.organization,
    );
    if (context === null) throw new Error("Missing test binding");
    const zip = zipOf("bw", fakeBw);
    const pin = fakePin(zip);
    const host = fakeHost({
      home: f.root,
      vault,
      pin,
      download: fakeRelease(pin, zip).fetch,
      context: async () => context,
    });
    vault.allow(binding.account);
    expect(await vaultSetup(host)).toMatchObject({ state: "connected" });
    const record = await readRecord(ownPaths(host, context));
    const organizationId = record.organizationId;
    const collectionId = record.collectionId;
    const application = {
      company: "example",
      personalspace: false,
      names: ["EXTERNAL_API_KEY"],
    };
    for (const value of ["invented-first-key", "invented-rotated-key"]) {
      vault.items([
        {
          object: "item",
          id: crypto.randomUUID(),
          type: 1,
          name: "EXTERNAL_API_KEY",
          organizationId,
          collectionIds: [collectionId],
          login: { password: value },
        },
      ]);
      const result = await vaultSecrets(host, application);
      expect(result.kind).toBe("vault-secrets");
      if (result.kind === "vault-secrets")
        expect(result.secrets.get("EXTERNAL_API_KEY")).toEqual({
          kind: "value",
          value,
        });
    }
    expect(
      await vaultSecrets(host, { ...application, company: "different" }),
    ).toEqual({ kind: "vault-secrets-refused", reason: "other-organization" });
  } finally {
    vault.stop();
    await f.dispose();
  }
}, 30000);

test("CLI onboarding is explicit and idempotent, and status selects that Organization", async () => {
  const { runVaultCommand } = await import("../src/vault/cli");
  const { embeddedIdentity } = await import("../src/update/identity");
  const f = await fixture();
  try {
    const context = {
      identity: embeddedIdentity(),
      platform: "darwin",
      env: { HOME: f.root },
      executable: process.execPath,
    };
    const selectors = [
      "--folder",
      f.folder,
      "--organization",
      "Example",
      "--json",
    ];
    const args = [
      "connect-workstation",
      ...selectors,
      "--server",
      server,
      "--name",
      input.name,
    ];
    const first = await runVaultCommand(args, context);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout ?? "{}")).toMatchObject({
      kind: "workstation-vault-configured",
      organization: "example",
      server,
    });
    const repeated = await runVaultCommand(args, context);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout ?? "{}")).toEqual(
      JSON.parse(first.stdout ?? "{}"),
    );
    const status = await runVaultCommand(["status", ...selectors], context);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout ?? "{}")).toMatchObject({
      state: "not-set-up",
      account: JSON.parse(first.stdout ?? "{}").account,
    });
    expect(
      (
        await runVaultCommand(
          ["connect-workstation", "--organization", "Example"],
          context,
        )
      ).code,
    ).toBe(2);
    expect(
      (await runVaultCommand(args, { ...context, platform: "linux" })).code,
    ).toBe(2);
    expect(
      (await runVaultCommand(["disconnect-workstation", ...selectors], context))
        .code,
    ).toBe(0);
    expect(await workstationVaultContext(f.directory, "Example")).toBeNull();
  } finally {
    await f.dispose();
  }
});
