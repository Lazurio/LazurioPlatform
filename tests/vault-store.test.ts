import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { findTool } from "../src/tools/catalog";
import { type ToolRunner, toolsStatus } from "../src/tools/status";
import {
  bwCli,
  bwFailureOf,
  parseBwStatus,
  parseCollections,
  parseOrganizations,
} from "../src/vault/bw";
import {
  completeAccount,
  createAccount,
  ensureVaultDirectories,
  forgetEnteredAccount,
  forgetUnregisteredAccount,
  parseAccount,
  readAccount,
  readRecord,
  readSession,
  type VaultAccount,
  vaultPaths,
  writeEnteredAccount,
  writeRecord,
  writeSession,
} from "../src/vault/store";
import { ownAccount } from "./fixtures/fake-vault";

// The custody of one Environment vault account (decisions F43, F53) and what
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

test("an account a person entered, in a Bitwarden cloud region, is theirs: any ordinary address and their own master password; written whole and forgotten with bw's store", async () => {
  const entered = {
    ...account,
    ...key,
    email: "agents.example+lazurio@example.com",
    server: "https://vault.bitwarden.eu",
    masterPassword: "Correct horse battery staple 7",
  };
  expect(parseAccount(entered)).toEqual(entered);
  expect(
    parseAccount({ ...entered, server: "https://vault.bitwarden.com" }),
  ).toMatchObject({ server: "https://vault.bitwarden.com" });
  for (const refused of [
    // An entered address names a directory: no slash, no white space, no
    // upper case (Bitwarden keeps it lowercased).
    { ...entered, email: "agents/example@example.com" },
    { ...entered, email: "Agents@Example.com" },
    { ...entered, email: "agents @example.com" },
    // The master password on one line, without control characters.
    { ...entered, masterPassword: "two\nlines" },
    { ...entered, masterPassword: "" },
    { ...entered, masterPassword: "x".repeat(1025) },
    // Only the cloud's regions take entered accounts: a Lazurio
    // Vaultwarden's accounts keep the rules of their generation.
    { ...entered, server: "https://vaultwarden.example.lazurio.io" },
    { ...entered, server: "https://vault.bitwarden.eu.example.com" },
  ])
    expect(() => parseAccount(refused)).toThrow("Invalid vault account");
  const t = await temporary();
  try {
    await writeEnteredAccount(t.paths, entered);
    expect(await readAccount(t.paths)).toEqual(entered);
    expect((await lstat(t.paths.account)).mode & 0o777).toBe(0o600);
    // Written whole again with what the person entered anew.
    const again = { ...entered, masterPassword: "Another one, 8 words long" };
    await writeEnteredAccount(t.paths, again);
    expect(await readAccount(t.paths)).toEqual(again);
    // A generated account is never written this way.
    await expect(
      writeEnteredAccount(t.paths, { ...account, ...key }),
    ).rejects.toThrow("Not an entered vault account");
    // Forgotten: the credentials, the session and whatever bw keeps go; the
    // record of the vault stays.
    await writeSession(t.paths, "Q".repeat(86).concat("=="));
    await writeFile(join(t.paths.data, "data.json"), "{}");
    await mkdir(join(t.paths.data, "more"));
    await writeRecord(t.paths, {
      organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
      collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
      pendingKey: null,
      pendingSince: null,
    });
    await forgetEnteredAccount(t.paths);
    expect(await readdir(t.paths.data)).toEqual(["lazurio-vault.json"]);
  } finally {
    await t.close();
  }
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

test("the own vault's record is its IDs and a creation's receipt with its time, and a damaged one is never taken for none", async () => {
  const t = await temporary();
  try {
    const empty = {
      organizationId: null,
      collectionId: null,
      pendingKey: null,
      pendingSince: null,
    };
    expect(await readRecord(t.paths)).toEqual(empty);
    const receipt = {
      ...empty,
      pendingKey: "A".repeat(392),
      pendingSince: "2026-10-13T21:00:00.000Z",
    };
    await writeRecord(t.paths, receipt);
    expect(await readRecord(t.paths)).toEqual(receipt);
    expect((await lstat(t.paths.record)).mode & 0o777).toBe(0o600);
    const vault = {
      organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
      collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
      pendingKey: null,
      pendingSince: null,
    };
    await writeRecord(t.paths, vault);
    expect(await readRecord(t.paths)).toEqual(vault);
    // Damaged, of another shape (a 0197 pilot's, or this one's before the
    // receipt had a time), a collection without its organization, or a
    // receipt without its time or a time in another form: refused, never
    // read as no record.
    for (const damaged of [
      "{broken",
      JSON.stringify({
        fingerprint: null,
        organizationId: vault.organizationId,
        collectionId: vault.collectionId,
      }),
      JSON.stringify({
        organizationId: null,
        collectionId: null,
        pendingKey: receipt.pendingKey,
      }),
      JSON.stringify({ ...vault, organizationId: null }),
      JSON.stringify({ ...vault, pendingKey: "not a key" }),
      JSON.stringify({ ...receipt, pendingSince: null }),
      JSON.stringify({ ...empty, pendingSince: receipt.pendingSince }),
      JSON.stringify({ ...receipt, pendingSince: "2026-10-13T21:00:00Z" }),
      JSON.stringify({ ...receipt, pendingSince: "yesterday" }),
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

// bw rewrites its store on every start, so a run without a data directory of
// its own would rewrite a default profile, a person's own bw included. No
// path of this product can start one: the vault's bw refuses before anything
// runs and sets its directory last on every run, and the version probe of
// Settings → Tools gives a bw on PATH a fresh temporary one.
test.skipIf(process.platform === "win32")(
  "bw never starts without a data directory of its own",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "vault-bw-data-")),
    );
    try {
      const home = join(parent, "home");
      const runs: {
        command: readonly string[];
        data: string | undefined;
        existed: boolean;
      }[] = [];
      const run: ToolRunner = async (command, _timeoutMs, env) => {
        const data = env.BITWARDENCLI_APPDATA_DIR;
        runs.push({
          command,
          data,
          existed:
            data !== undefined &&
            (await stat(data).then(
              (found) => found.isDirectory(),
              () => false,
            )),
        });
        return { exitCode: 0, stdout: "2026.7.0\n", stderr: "" };
      };
      const data = join(parent, "state", "bw");
      const binary = join(parent, "tools", "bw");
      for (const [path, directory] of [
        [binary, ""],
        [binary, "bw"],
        [binary, "./state/bw"],
        ["bw", data],
      ] as const)
        expect(() =>
          bwCli({ binary: path, data: directory, home, path: undefined, run }),
        ).toThrow();
      expect(runs).toEqual([]);
      const bw = bwCli({ binary, data, home, path: undefined, run });
      expect(await bw.version()).toBe("2026.7.0");
      expect((await bw.loginApiKey("user.example", "example")).ok).toBe(true);
      expect(runs.map((entry) => entry.data)).toEqual([data, data]);

      // Settings → Tools: a bw on PATH (a person's own) runs its version
      // command with a fresh temporary data directory, gone afterwards.
      runs.length = 0;
      const bin = join(parent, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "bw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const bitwarden = findTool("bitwarden");
      if (bitwarden === undefined) throw new Error("Expected bitwarden");
      expect(bitwarden.isolatedData).toBe("BITWARDENCLI_APPDATA_DIR");
      await toolsStatus({
        path: bin,
        home,
        platform: process.platform,
        run,
        catalog: [bitwarden],
      });
      expect(runs).toHaveLength(1);
      const probe = runs[0]?.data ?? "";
      expect(runs[0]?.command).toEqual([join(bin, "bw"), "--version"]);
      expect(runs[0]?.existed).toBe(true);
      expect(isAbsolute(probe)).toBe(true);
      expect(probe.startsWith(home)).toBe(false);
      expect(
        await stat(probe).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
