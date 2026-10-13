import { expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bwFailureOf,
  parseBwStatus,
  parseCollections,
  parseOrganizations,
} from "../src/vault/bw";
import {
  completeAccount,
  createAccount,
  ensureVaultDirectories,
  forgetUnregisteredAccount,
  parseAccount,
  readAccount,
  readRecord,
  readSession,
  type VaultAccount,
  vaultPaths,
  writeRecord,
  writeSession,
} from "../src/vault/store";
import { ownAccount } from "./fixtures/fake-vault";

// The custody of one Environment vault account (decisions F43, F52) and what
// is read from bw: exact shapes only, the password written once, the own
// vault's record never guessed, nothing of an account file ever echoed.

const account: VaultAccount = {
  email: ownAccount,
  server: "https://vaultwarden.example.lazurio.io",
  deviceIdentifier: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
  masterPassword: "A".repeat(43),
  createdAt: "2026-10-09T08:00:00.000Z",
};
const key = {
  clientId: "user.6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
  clientSecret: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
};

async function temporary() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-store-")));
  const paths = vaultPaths(
    join(parent, "vault", "vaultwarden.example.lazurio.io"),
  );
  await ensureVaultDirectories(paths);
  return {
    parent,
    paths,
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

test("the account file is taken only in its exact form, an own account's or a 0197 pilot's", () => {
  expect(parseAccount({ ...account })).toEqual(account);
  expect(parseAccount({ ...account, ...key })).toEqual({ ...account, ...key });
  // A 0197 pilot's account file reads the same way; whose it is, each
  // caller checks against its own context.
  const pilot = { ...account, email: "vaultwarden@example.lazurio.io" };
  expect(parseAccount(pilot)).toEqual(pilot);
  for (const refused of [
    { ...account, extra: true },
    { ...account, clientId: key.clientId },
    { ...account, email: "Someone@Example.invalid" },
    { ...account, email: "someone" },
    { ...account, server: "http://vaultwarden.example.lazurio.io" },
    { ...account, masterPassword: "short" },
    { ...account, deviceIdentifier: "device" },
    [],
    null,
  ])
    expect(() => parseAccount(refused)).toThrow("Invalid vault account");
});

test("the password is written once, before the registration; the API key joins it once", async () => {
  const t = await temporary();
  try {
    await createAccount(t.paths, account);
    expect((await lstat(t.paths.account)).mode & 0o777).toBe(0o600);
    // Never replaced: a second creation fails and the first stays.
    await expect(
      createAccount(t.paths, { ...account, masterPassword: "B".repeat(43) }),
    ).rejects.toThrow();
    expect(await readAccount(t.paths)).toEqual(account);
    const ready = await completeAccount(t.paths, account, key);
    expect(ready).toEqual({ ...account, ...key });
    expect(await readAccount(t.paths)).toEqual({ ...account, ...key });
    expect((await lstat(t.paths.account)).mode & 0o777).toBe(0o600);
    // Only once, and only for the same password.
    await expect(completeAccount(t.paths, account, key)).rejects.toThrow(
      "The vault account changed",
    );
    // A ready account is never forgotten as unregistered.
    await forgetUnregisteredAccount(t.paths);
    expect(await readAccount(t.paths)).toEqual({ ...account, ...key });
    // No temporary file is left beside it.
    expect(await readdir(t.paths.data)).toEqual(["lazurio-account.json"]);
  } finally {
    await t.close();
  }
});

test("a refused registration leaves nothing; the session is written whole", async () => {
  const t = await temporary();
  try {
    await createAccount(t.paths, account);
    await forgetUnregisteredAccount(t.paths);
    expect(await readAccount(t.paths)).toBeNull();

    await createAccount(t.paths, account);
    await completeAccount(t.paths, account, key);
    const session = "Q".repeat(86).concat("==");
    await writeSession(t.paths, session);
    expect(await readSession(t.paths)).toBe(session);
    expect((await lstat(t.paths.session)).mode & 0o777).toBe(0o600);
    await expect(writeSession(t.paths, "not a session")).rejects.toThrow();
    expect(await readFile(t.paths.account, "utf8")).toContain(key.clientSecret);
  } finally {
    await t.close();
  }
});

test("the own vault's record is its IDs and a creation's receipt, and a damaged one is never taken for none", async () => {
  const t = await temporary();
  try {
    const empty = {
      organizationId: null,
      collectionId: null,
      pendingKey: null,
    };
    expect(await readRecord(t.paths)).toEqual(empty);
    const receipt = { ...empty, pendingKey: "A".repeat(392) };
    await writeRecord(t.paths, receipt);
    expect(await readRecord(t.paths)).toEqual(receipt);
    expect((await lstat(t.paths.record)).mode & 0o777).toBe(0o600);
    const vault = {
      organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
      collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
      pendingKey: null,
    };
    await writeRecord(t.paths, vault);
    expect(await readRecord(t.paths)).toEqual(vault);
    // Damaged, of another shape (a 0197 pilot's), or a collection without
    // its organization: refused, never read as no record.
    for (const damaged of [
      "{broken",
      JSON.stringify({
        fingerprint: null,
        organizationId: vault.organizationId,
        collectionId: vault.collectionId,
      }),
      JSON.stringify({ ...vault, organizationId: null }),
      JSON.stringify({ ...vault, pendingKey: "not a key" }),
      JSON.stringify({ ...vault, extra: 1 }),
    ]) {
      await writeFile(t.paths.record, damaged);
      await expect(readRecord(t.paths)).rejects.toThrow();
    }
  } finally {
    await t.close();
  }
});

test("bw's answers are read in their shapes and its failures by its fixed messages", () => {
  expect(
    parseBwStatus(
      '{"serverUrl":"https://vaultwarden.example.lazurio.io","lastSync":null,"userEmail":"vaultwarden@example.lazurio.io","userId":null,"status":"locked"}',
    ),
  ).toEqual({
    status: "locked",
    serverUrl: "https://vaultwarden.example.lazurio.io",
    userEmail: "vaultwarden@example.lazurio.io",
  });
  expect(parseBwStatus('{"status":"sleeping"}')).toBeNull();
  expect(
    parseOrganizations(
      '[{"object":"organization","id":"0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b","name":"Example","status":2,"type":2,"enabled":true}]',
    ),
  ).toEqual([
    { id: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b", name: "Example", status: 2 },
  ]);
  expect(
    parseOrganizations('[{"id":"x","name":"Example","status":2}]'),
  ).toBeNull();
  expect(
    parseCollections(
      '[{"object":"collection","id":"6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d","organizationId":"0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b","name":"Environmenty/Osobní · example","externalId":null}]',
    ),
  ).toEqual([
    {
      id: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
      organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
      name: "Environmenty/Osobní · example",
    },
  ]);
  expect(parseCollections("not json")).toBeNull();
  const failure = (stderr: string) =>
    bwFailureOf({ exitCode: 1, stdout: "", stderr });
  expect(failure("Vault is locked.")).toBe("locked");
  expect(failure("You are not logged in.")).toBe("unauthenticated");
  expect(failure("Too many login requests")).toBe("rate-limited");
  expect(failure("Logout required before server config update.")).toBe(
    "logout-required",
  );
  expect(failure("Incorrect client_secret")).toBe("invalid-credentials");
  expect(failure("invalid_grant")).toBe("invalid-credentials");
  expect(
    failure(
      "request to https://vaultwarden.example.lazurio.io/api/sync failed, reason: getaddrinfo ENOTFOUND",
    ),
  ).toBe("unreachable");
  expect(failure("something else")).toBe("failed");
  expect(bwFailureOf("timeout")).toBe("timeout");
});
