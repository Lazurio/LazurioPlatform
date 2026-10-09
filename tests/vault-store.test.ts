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
  forgetSignIn,
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

// The custody of one Environment vault account (decision F43) and what is
// read from bw: exact shapes only, the password written once, nothing of an
// account file ever echoed.

const account: VaultAccount = {
  email: "vaultwarden@example.lazurio.io",
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

test("the account file is taken only in its exact form", () => {
  expect(parseAccount({ ...account })).toEqual(account);
  expect(parseAccount({ ...account, ...key })).toEqual({ ...account, ...key });
  for (const refused of [
    { ...account, extra: true },
    { ...account, clientId: key.clientId },
    { ...account, email: "someone@example.invalid" },
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

test("a refused registration leaves nothing; a disconnect keeps only the account", async () => {
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
    await writeRecord(t.paths, {
      fingerprint: "steep-flavor-uncut-scouring-unnoticed",
      organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
      collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
    });
    await writeFile(join(t.paths.data, "data.json"), "{}");
    await forgetSignIn(t.paths);
    expect(await readdir(t.paths.data)).toEqual(["lazurio-account.json"]);
    expect(await readRecord(t.paths)).toEqual({
      fingerprint: null,
      organizationId: null,
      collectionId: null,
    });
    // An unreadable record is no record; it is not secret.
    await writeFile(t.paths.record, "{broken");
    expect((await readRecord(t.paths)).collectionId).toBeNull();
    expect(await readFile(t.paths.account, "utf8")).toContain(key.clientSecret);
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
