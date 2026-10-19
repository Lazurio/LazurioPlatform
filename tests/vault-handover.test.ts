import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { machineIdentity } from "../src/folder/machine-binding";
import { machineBinding } from "../src/machine/binding";
import {
  MachineContextError,
  parseMachineContext,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import { contextValues } from "../src/recover/private-values";
import { createSanitizer } from "../src/recover/sanitize";
import { ownAccount, vaultMember, workAccount } from "./fixtures/fake-vault";
import { handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// DEV-6631 contract C2: Machines writes the optional, closed member
// `vault: {server_url, account, name}` into lazurio.machine.json on both
// branches, only for a Platform release that reads it, and the Environment
// takes its own vault from it (decision F53). Invented hosts and names only.

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const { team: _, ...withoutTeam } = organization.owner;
const documents = {
  personal: {
    ...personal,
    entry: handoverEntry("example.lazurio.io"),
    vault: vaultMember(),
  },
  work: {
    ...organization,
    owner: withoutTeam,
    entry: handoverEntry("workspace.example.lazurio.io"),
    vault: vaultMember(workAccount, "Example Pracovní workspace"),
  },
};

test("the vendored schema is Machines #500's: the member with a work and a personal account shape", () => {
  // Re-pinned since to Machines #543, which adds only `entry.sign_out`
  // (tests/shell-sign-out.test.ts), and then to Machines #560, which adds
  // only `entry.audience` (tests/public-environment.test.ts).
  expect(provenance.source_pull_request).toBe(
    "https://github.com/HumanAndMachine-ai/Machines/pull/560",
  );
  const defs = (
    schema as unknown as {
      $defs: Record<
        string,
        { properties?: Record<string, unknown> } & Record<string, unknown>
      >;
    }
  ).$defs;
  expect(defs.organization_workspace_vm?.properties?.vault).toEqual({
    $ref: "#/$defs/vault_work",
  });
  expect(defs.personal_vm?.properties?.vault).toEqual({
    $ref: "#/$defs/vault_personal",
  });
  for (const name of ["vault_work", "vault_personal"])
    expect(defs[name]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["server_url", "account", "name"],
    });
  // A work Environment's account is of its <vm>.<org> address, a personal
  // one's of its <login> address; neither takes the other's.
  expect(() =>
    parseMachineContext(
      bytes({ ...documents.personal, vault: vaultMember(workAccount) }),
    ),
  ).toThrow("machine-context-invalid");
  expect(() =>
    parseMachineContext(
      bytes({ ...documents.work, vault: vaultMember(ownAccount) }),
    ),
  ).toThrow("machine-context-invalid");
});

test("the member is read exactly as written on both branches", () => {
  for (const document of Object.values(documents)) {
    const context = parseMachineContext(bytes(document));
    expect(JSON.stringify(context)).toBe(JSON.stringify(document));
    expect(context.vault).toEqual(document.vault);
    expect(Object.isFrozen(context.vault)).toBe(true);
  }
});

test("the member is closed and every part keeps its shape", () => {
  const refused = (vault: unknown) => {
    try {
      parseMachineContext(bytes({ ...documents.personal, vault }));
    } catch (error) {
      return (
        error instanceof MachineContextError &&
        error.code === "machine-context-invalid"
      );
    }
    return false;
  };
  const member = vaultMember();
  for (const [name, vault] of Object.entries({
    "another member": { ...member, collection: "Agenti" },
    "no name": { server_url: member.server_url, account: member.account },
    "a 0197 address": {
      ...member,
      account: "vaultwarden@example.lazurio.io",
    },
    "upper-case base32": {
      ...member,
      account: "vaultwarden-NDBRMZVJPWXTT3Q7M2E4FIHGSA@example.lazurio.io",
    },
    "25 characters": {
      ...member,
      account: "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgs@example.lazurio.io",
    },
    "not base32": {
      ...member,
      account: "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgs1@example.lazurio.io",
    },
    "a person's address": {
      ...member,
      account: "petr@account.lazurio.ai",
    },
    "plain http": {
      ...member,
      server_url: "http://vaultwarden.example.lazurio.io",
    },
    "a path": {
      ...member,
      server_url: "https://vaultwarden.example.lazurio.io/",
    },
    "another host": { ...member, server_url: "https://vault.example.invalid" },
    "two spaces": { ...member, name: "Example  Osobní" },
    "a slash": { ...member, name: "Example/Osobní" },
    "a middle dot": { ...member, name: "Example · Osobní" },
    "a trailing space": { ...member, name: "Example Osobní " },
    empty: { ...member, name: "" },
    "51 characters": { ...member, name: "a".repeat(51) },
  }))
    expect([name, refused(vault)]).toEqual([name, true]);
  // Letters of any language, digits and single spaces, at most 50.
  for (const name of [
    "Example Osobní example",
    "Žluťoučký kůň 2",
    "a".repeat(50),
  ])
    expect(
      parseMachineContext(
        bytes({ ...documents.personal, vault: { ...member, name } }),
      ).vault?.name,
    ).toBe(name);
});

test("a Platform whose vendored schema predates the member refuses the whole handover that carries it, which is why Machines writes it only for a Platform that reads it", () => {
  // The schema of the Platform before this member: the same, without it.
  const earlier = structuredClone(schema) as unknown as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
  for (const branch of ["organization_workspace_vm", "personal_vm"])
    delete earlier.$defs[branch]?.properties?.vault;
  for (const name of [
    "vault_work",
    "vault_personal",
    "vault_server_url",
    "vault_name",
  ])
    delete earlier.$defs[name];
  const validate = new Ajv2020({ strict: true }).compile(earlier);
  for (const document of Object.values(documents)) {
    const { vault: __, ...without } = document;
    expect(validate(without)).toBe(true);
    // The member is unknown to it: not ignored, the whole document fails,
    // and with it the Launchpad entry and everything else the handover
    // carries.
    expect(validate(document)).toBe(false);
  }
  // This Platform refuses an unknown member the same way.
  expect(() =>
    parseMachineContext(bytes({ ...documents.personal, vault_v2: {} })),
  ).toThrow("machine-context-invalid");
});

test("the member is outside the Machine's identity and its Folder binding", () => {
  // The same digest for both: only the projection is compared.
  const digest = "0".repeat(64);
  for (const document of Object.values(documents)) {
    const { vault: __, ...without } = document;
    const withVault = machineBinding(
      parseMachineContext(bytes(document)),
      digest,
    );
    const plain = machineBinding(parseMachineContext(bytes(without)), digest);
    expect(withVault).toEqual(plain);
    expect(machineIdentity(withVault)).toEqual(machineIdentity(plain));
  }
});

test("recovery evidence withholds the account, the vault's name and the vault's host", () => {
  const context = parseMachineContext(bytes(documents.personal));
  const values = contextValues(context);
  expect(values).toEqual(
    expect.arrayContaining([
      { kind: "vault-account", value: ownAccount },
      { kind: "vault-name", value: "Example Osobní example" },
      { kind: "hostname", value: "vaultwarden.example.lazurio.io" },
    ]),
  );
  const sanitizer = createSanitizer({ values });
  const output = sanitizer.sanitize(
    [
      `registering ${ownAccount}`,
      "vault Example Osobní example renamed",
      "GET https://vaultwarden.example.lazurio.io/api/sync 502",
    ].join("\n"),
  );
  expect(output).not.toContain(ownAccount);
  expect(output).not.toContain("ndbrmzvjpwxtt3q7m2e4fihgsa");
  expect(output).not.toContain("Example Osobní example");
  expect(output).not.toContain("vaultwarden.example.lazurio.io");
  expect(sanitizer.gate(output)).toEqual({ kind: "clean", text: output });
});
