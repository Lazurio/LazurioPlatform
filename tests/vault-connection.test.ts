import { expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock } from "../src/platform/flock";
import {
  type ConnectionInput,
  type ConnectionRefusal,
  connectionValues,
  connectPersonalBitwarden,
  disconnectPersonalBitwarden,
  inviteeValue,
  invitePersonalBitwarden,
  readConnection,
} from "../src/vault/connection";
import { personalVaultName } from "../src/vault/context";
import {
  setUpAtStart,
  type VaultHost,
  type VaultJournalEntry,
  vaultEnv,
  vaultRefresh,
  vaultSecrets,
  vaultSecretsAdmission,
  vaultSetup,
  vaultStatus,
} from "../src/vault/flow";
import { vaultMembership } from "../src/vault/members";
import { agentsCollection } from "../src/vault/organization";
import {
  decrypt,
  deriveMasterKey,
  publicKeyOf,
  rsaDecrypt,
  stretchMasterKey,
  symmetricKey,
} from "../src/vault/register";
import { createSecretRequest } from "../src/vault/requests";
import {
  ensureVaultDirectories,
  readAccount,
  readRecord,
  readSession,
  type VaultRecord,
  vaultPaths,
  writeRecord,
} from "../src/vault/store";
import {
  cloudHost,
  type FakeBitwardenCloud,
  startFakeBitwardenCloud,
} from "./fixtures/fake-bitwarden-cloud";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownContext,
  pilotContext,
  startFakeVault,
  stateDirectory,
  workHandover,
  zipOf,
} from "./fixtures/fake-vault";

// A personal Environment's own Bitwarden through the vault's one core (root
// decision 0203 point 7, plan DEV-6631 task 775): the person connects a
// separate agents' account of the Bitwarden cloud with its API key and
// master password alone; the Environment finds the region that accepts the
// key, checks the account, keeps it in its custody and creates its vault (a
// Free organization for two). Once the person asks, it invites them as a
// User with Manage on Agenti, confirms them once they accepted, and forgets
// the account when they disconnect (F53's amendment of 2026-10-16, (2)).
// Against the fake Bitwarden cloud (separate identity and API hosts per
// region) and the fake bw; every name, address and value is invented.

const posix = process.platform !== "win32";
const agents = "agents.example+lazurio@example.com";
const person = "person.example@example.com";
const password = "Correct horse battery staple 7";
const argon2id = {
  type: 1,
  iterations: 2,
  memory: 16,
  parallelism: 1,
} as const;
const web = "https://vault.bitwarden.eu";
const people = { anonymous: { subject: null, username: null } } as const;

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-conn-")));
  const home = join(parent, "home");
  const cloud = await startFakeBitwardenCloud(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const host = cloudHost({
    home,
    cloud,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
  });
  return {
    parent,
    home,
    cloud,
    journal,
    host,
    paths: (account = agents) =>
      vaultPaths(stateDirectory(home, "vault.bitwarden.eu", account)),
    async close() {
      cloud.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** The form's values of an agents' account of the fake cloud: its API key
 * as copied (white space around it) and its master password. */
async function form(
  cloud: FakeBitwardenCloud,
  options: Readonly<{
    email?: string;
    kdf?: Parameters<FakeBitwardenCloud["account"]>[2];
    keys?: "v1" | "v2";
    region?: "eu" | "us";
  }> = {},
): Promise<ConnectionInput> {
  const key = await cloud.account(
    options.email ?? agents,
    password,
    options.kdf,
    options.keys,
    options.region,
  );
  return {
    clientId: ` ${key.clientId} `,
    clientSecret: key.clientSecret,
    masterPassword: password,
  };
}

/** An account's API key as the fake cloud keeps it. */
async function readAccountOf(cloud: FakeBitwardenCloud, email: string) {
  const account = cloud.accounts.get(email);
  if (account === undefined) throw new Error("No such account");
  return {
    clientId: `user.${account.id}`,
    clientSecret: account.clientSecret,
  };
}

/** The person's own address as they type it, to be invited. */
const invitation = { email: ` ${person.toUpperCase()} ` };

/** What the core asked the cloud, as `<host> <region> <path>`. */
const asked = (cloud: FakeBitwardenCloud) =>
  cloud.requests.map((entry) => `${entry.host} ${entry.region} ${entry.path}`);

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

/** Every file under a directory, by its path. */
async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []))
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  return found;
}

test("the form's values and the invitation's address are taken only in their exact form", () => {
  const good = {
    clientId: " USER.6A5F4E3D-2C1B-4A9F-8E7D-6C5B4A3F2E1D ",
    clientSecret: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    masterPassword: " a password with spaces, kept as typed ",
  };
  expect(connectionValues(good)).toEqual({
    ok: true,
    values: {
      clientId: "user.6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
      clientSecret: good.clientSecret,
      masterPassword: good.masterPassword,
    },
  });
  const refusals: [string, unknown, string][] = [
    [
      "clientId",
      "organization.6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
      "client-id-invalid",
    ],
    ["clientId", "user.", "client-id-invalid"],
    ["clientId", 7, "client-id-invalid"],
    ["clientSecret", "short", "client-secret-invalid"],
    ["clientSecret", "has spaces inside it", "client-secret-invalid"],
    ["masterPassword", "", "password-invalid"],
    ["masterPassword", "two\nlines", "password-invalid"],
    ["masterPassword", "x".repeat(1025), "password-invalid"],
    ["masterPassword", ["array"], "password-invalid"],
  ];
  for (const [field, value, reason] of refusals)
    expect([
      field,
      connectionValues({ ...good, [field]: value }) as unknown,
    ]).toEqual([field, { ok: false, reason }]);
  // The person's own address: trimmed and lowercased, as Bitwarden keeps it.
  expect(
    inviteeValue({ email: " Person.Example+Bitwarden@Example.COM " }),
  ).toBe("person.example+bitwarden@example.com");
  for (const email of [
    "no-at-sign",
    "a/b@example.com",
    "person@localhost",
    ".dot@example.com",
    "",
    7,
    null,
  ])
    expect([email, inviteeValue({ email })]).toEqual([email, null]);
});

test.skipIf(!posix)(
  "a personal Environment without a connection needs its person: nothing runs, nothing is asked, and the start never sets it up",
  async () => {
    const w = await world();
    try {
      const needs = {
        kind: "vault-status",
        state: "needs-connection",
      } as const;
      expect(await vaultStatus(w.host)).toEqual(needs);
      expect(await vaultSetup(w.host)).toEqual(needs);
      expect(await vaultRefresh(w.host)).toEqual(needs);
      expect(setUpAtStart(await vaultStatus(w.host))).toBe(false);
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      const application = { company: "example", personalspace: true };
      expect(await vaultSecretsAdmission(w.host, application)).toBe(
        "not-connected",
      );
      expect(
        await vaultSecrets(w.host, { ...application, names: ["EXAMPLE"] }),
      ).toEqual({ kind: "vault-secrets-refused", reason: "not-connected" });
      expect(
        await createSecretRequest(w.host, {
          item: "Example",
          need: "the example key",
          why: "For the example.",
          where: "In the example's settings.",
          fields: ["Key:secret"],
        }),
      ).toEqual({ kind: "vault-request-refused", reason: "not-connected" });
      expect(await vaultMembership(w.host, people.anonymous)).toEqual({
        kind: "vault-member-unknown",
        reason: "not-connected",
      });
      // Nothing installed, nothing asked of the cloud, no bw run.
      expect(w.cloud.requests).toHaveLength(0);
      expect(await w.cloud.calls()).toBe("");
      expect(
        await lstat(join(w.home, ".local", "share")).catch(() => null),
      ).toBeNull();
    } finally {
      await w.close();
    }
  },
  60_000,
);

for (const [label, kdf] of [
  ["PBKDF2", undefined],
  ["Argon2id", argon2id],
] as const)
  test.skipIf(!posix)(
    `an agents' account of ${label} connects by its API key and master password alone: found in the EU, checked, kept whole in custody, its vault created as a Free organization; the person, once they ask, invited as a User with Manage on Agenti and confirmed once they accept`,
    async () => {
      const w = await world();
      try {
        const values = await form(w.cloud, kdf === undefined ? {} : { kdf });
        expect(await connectPersonalBitwarden(w.host, values)).toEqual({
          kind: "vault-connected",
        });
        // Checked at the identity and API hosts of the EU region, which
        // accepted the key first, by the API key only; the US is never
        // asked, nor the web vault's host.
        expect(asked(w.cloud)).toEqual([
          "identity eu /connect/token",
          "api eu /accounts/profile",
        ]);
        expect(
          w.cloud.requests.every(
            (entry) =>
              entry.region === "eu" &&
              (entry.host !== "identity" ||
                entry.path !== "/connect/token" ||
                (entry.body as Record<string, unknown>).grant_type ===
                  "client_credentials"),
          ),
        ).toBe(true);
        // The account's credentials, whole, in the custody of the agents'
        // account; the connection beside it, not secret.
        const paths = w.paths();
        const account = await readAccount(paths);
        expect(account).toMatchObject({
          email: agents,
          server: web,
          masterPassword: password,
          clientId: values.clientId?.toString().trim(),
          clientSecret: values.clientSecret,
        });
        expect(await mode(paths.account)).toBe(0o600);
        expect(await mode(paths.directory)).toBe(0o700);
        expect(await readConnection(w.host.connection)).toEqual({
          region: "eu",
          account: agents,
          invitee: null,
        });
        expect(await mode(join(w.host.connection, "connection.json"))).toBe(
          0o600,
        );
        expect(await mode(w.host.connection)).toBe(0o700);
        // Not set up yet: the start sets it up.
        const before = await vaultStatus(w.host);
        expect(before).toMatchObject({
          state: "not-set-up",
          next: "install",
          origin: "own",
          region: "eu",
          account: agents,
          vault: web,
          name: personalVaultName("example"),
        });
        expect(setUpAtStart(before)).toBe(true);

        const setUp = await vaultSetup(w.host);
        const [organization] = (await w.cloud.organizationsOf(agents)).filter(
          (entry) => entry.name === "Osobní example",
        );
        if (organization === undefined) throw new Error("Expected the vault");
        const agentiId = organization.collections[0]?.id ?? "?";
        expect(setUp).toEqual({
          kind: "vault-status",
          state: "connected",
          vault: web,
          account: agents,
          name: "Osobní example",
          team: false,
          origin: "own",
          region: "eu",
          organizationId: organization.id,
          collectionId: agentiId,
          organization: "Osobní example",
          items: 0,
        });
        // Never registered: the cloud has only the account the person made.
        expect(
          w.cloud.requests.some((entry) => entry.path.includes("register")),
        ).toBe(false);
        // The organization: Free, the agents' account its Owner, created
        // with the request the cloud wants, its key encrypted to the
        // account's own public key, which the master password opens.
        const created = w.cloud.requests.find(
          (entry) => entry.host === "api" && entry.path === "/organizations",
        );
        expect(created?.body).toEqual({
          name: "Osobní example",
          billingEmail: agents,
          key: expect.stringMatching(/^4\./),
          keys: {
            publicKey: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
            encryptedPrivateKey: expect.stringMatching(/^2\./),
          },
          collectionName: expect.stringMatching(/^2\./),
          planType: 0,
          useSecretsManager: false,
        });
        const cloudAccount = w.cloud.accounts.get(agents);
        if (cloudAccount === undefined) throw new Error("Expected the account");
        const userKey = symmetricKey(
          await decrypt(
            cloudAccount.protectedUserKey,
            await stretchMasterKey(
              await deriveMasterKey(password, agents, cloudAccount.kdf),
            ),
          ),
        );
        const privateKey = await decrypt(
          cloudAccount.encryptedPrivateKey,
          userKey,
        );
        const owner = (await w.cloud.members(organization.id)).find(
          (member) => member.type === 0,
        );
        expect(owner).toMatchObject({ email: agents, status: 2 });
        const organizationKey = symmetricKey(
          await rsaDecrypt(privateKey, owner?.key ?? ""),
        );
        expect(
          new TextDecoder().decode(
            await decrypt(
              organization.collections[0]?.name ?? "",
              organizationKey,
            ),
          ),
        ).toBe(agentsCollection);
        expect(await publicKeyOf(privateKey)).toBe(cloudAccount.publicKey);
        // bw: the region's web vault, the API key, the master password
        // from a private file; never a value on its arguments.
        const calls = await w.cloud.calls();
        expect(calls).toContain(`config server ${web} --nointeraction`);
        expect(calls).toContain("login --apikey --nointeraction");
        for (const secret of [
          password,
          cloudAccount.clientSecret,
          person,
          (await readSession(paths)) ?? "?",
        ])
          expect(calls).not.toContain(secret);
        // Nobody is invited until the person asks: the vault is the agents'
        // alone, and the page offers the invitation.
        expect(w.cloud.mails).toEqual([]);
        expect(await w.cloud.members(organization.id)).toHaveLength(1);
        expect(await vaultMembership(w.host, people.anonymous)).toEqual({
          kind: "vault-member",
          state: "not-invited",
        });
        // The person asks, with their own address as they type it: kept, and
        // invited at once, by the cloud's e-mail, a User with Manage on
        // Agenti, never an Admin.
        expect(await invitePersonalBitwarden(w.host, invitation)).toEqual({
          kind: "vault-member",
          state: "invitation-pending",
        });
        expect(await readConnection(w.host.connection)).toEqual({
          region: "eu",
          account: agents,
          invitee: person,
        });
        expect(w.cloud.mails).toEqual([person]);
        const invited = (await w.cloud.members(organization.id)).find(
          (member) => member.email === person,
        );
        expect(invited).toMatchObject({
          type: 2,
          status: 0,
          collections: [
            {
              id: agentiId,
              readOnly: false,
              hidePasswords: false,
              manage: true,
            },
          ],
        });
        expect(await vaultMembership(w.host, people.anonymous)).toEqual({
          kind: "vault-member",
          state: "invitation-pending",
        });
        // The person accepts the e-mail; the next look confirms them.
        expect(await w.cloud.accept(person)).toBe("accepted");
        expect(await vaultMembership(w.host, people.anonymous)).toEqual({
          kind: "vault-member",
          state: "member",
        });
        expect(
          (await w.cloud.members(organization.id)).find(
            (member) => member.email === person,
          ),
        ).toMatchObject({ type: 2, status: 2 });
        // Set up again: nothing new, no second organization or invitation.
        expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
        expect(await w.cloud.organizationsOf(agents)).toHaveLength(1);
        expect(w.cloud.mails).toEqual([person]);
        expect(
          w.cloud.requests.filter(
            (entry) =>
              entry.host === "api" &&
              entry.method === "POST" &&
              entry.path === "/organizations",
          ),
        ).toHaveLength(1);
        // Agents read it as their own vault.
        const env = await vaultEnv(w.host);
        expect(env).toMatchObject({
          kind: "vault-env",
          env: {
            BITWARDENCLI_APPDATA_DIR: paths.data,
            LAZURIO_VAULT_ORGANIZATION_ID: organization.id,
            LAZURIO_VAULT_COLLECTION_ID: agentiId,
          },
        });
        // The journal: what happened, never a value or an address.
        expect(w.journal).toContainEqual({
          operation: "connect",
          outcome: "connected",
        });
        expect(w.journal).toContainEqual({
          operation: "members",
          outcome: "invitee-set",
        });
        expect(w.journal).toContainEqual({
          operation: "members",
          outcome: "invited",
        });
        expect(w.journal).toContainEqual({
          operation: "members",
          outcome: "confirmed",
        });
        const journal = JSON.stringify(w.journal);
        for (const value of [
          password,
          cloudAccount.clientSecret,
          person,
          agents,
          cloudAccount.id,
        ])
          expect(journal).not.toContain(value);
      } finally {
        await w.close();
      }
    },
    120_000,
  );

test.skipIf(!posix)(
  "an API key both regions refuse, a wrong master password or keys of another form connect nothing",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud);
      const refused = async (input: ConnectionInput) => {
        const answer = await connectPersonalBitwarden(w.host, input);
        return answer.kind === "vault-connection-refused"
          ? answer.reason
          : answer.kind;
      };
      expect(await refused({ ...values, clientSecret: "wrongsecret1" })).toBe(
        "invalid-credentials",
      );
      expect(await refused({ ...values, masterPassword: `${password}!` })).toBe(
        "wrong-password",
      );
      const v2 = await form(w.cloud, {
        email: "agents.v2@example.com",
        keys: "v2",
      });
      expect(await refused(v2)).toBe("unsupported-keys");
      w.cloud.flags.rateLimit = true;
      expect(await refused(values)).toBe("rate-limited");
      w.cloud.flags.rateLimit = false;
      const unreachable: VaultHost = {
        ...w.host,
        fetch: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      };
      expect(await connectPersonalBitwarden(unreachable, values)).toEqual({
        kind: "vault-connection-refused",
        reason: "unreachable",
      });
      // Nothing written, nothing journaled but the refusals' fixed reasons.
      expect(await readConnection(w.host.connection)).toBeNull();
      expect(await files(join(w.home, ".local"))).toEqual([]);
      expect(await vaultStatus(w.host)).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      });
      expect(w.journal).toEqual(
        [
          "invalid-credentials",
          "wrong-password",
          "unsupported-keys",
          "rate-limited",
          "unreachable",
        ].map((reason) => ({
          operation: "connect",
          outcome: "refused",
          reason,
        })),
      );
    } finally {
      await w.close();
    }
  },
  60_000,
);

// The region is never asked for: the API key signs in at the EU's identity
// host first and at the US's only where the EU's refuses it as unknown (F53's
// amendment of 2026-10-16, (2)). A host that does not answer stops there: the
// other region is never tried in its place.
test.skipIf(!posix)(
  "an agents' account of bitwarden.com connects after the EU refuses its key: the US region is recorded, and the vault and the invitation are on the US hosts",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud, { region: "us" });
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connected",
      });
      expect(asked(w.cloud)).toEqual([
        "identity eu /connect/token",
        "identity us /connect/token",
        "api us /accounts/profile",
      ]);
      expect(await readConnection(w.host.connection)).toEqual({
        region: "us",
        account: agents,
        invitee: null,
      });
      // Kept in the custody of the US web vault's host.
      const paths = vaultPaths(
        stateDirectory(w.home, "vault.bitwarden.com", agents),
      );
      expect(await readAccount(paths)).toMatchObject({
        email: agents,
        server: "https://vault.bitwarden.com",
      });
      expect(await vaultStatus(w.host)).toMatchObject({
        state: "not-set-up",
        region: "us",
        vault: "https://vault.bitwarden.com",
      });
      const before = w.cloud.requests.length;
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "connected",
        region: "us",
      });
      expect(await invitePersonalBitwarden(w.host, invitation)).toEqual({
        kind: "vault-member",
        state: "invitation-pending",
      });
      expect(w.cloud.mails).toEqual([person]);
      // Everything after the connection asked the US hosts only.
      expect(
        w.cloud.requests
          .slice(before)
          .every((entry) => entry.region === "us" && entry.host !== "web"),
      ).toBe(true);
      expect(await w.cloud.calls()).toContain(
        "config server https://vault.bitwarden.com --nointeraction",
      );
    } finally {
      await w.close();
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "a key both regions refuse is invalid-credentials; a region that does not answer is unreachable and the other is never tried in its place",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud);
      const answer = async (host: VaultHost, input = values) => {
        w.cloud.requests.length = 0;
        const connected = await connectPersonalBitwarden(host, input);
        return [
          connected.kind === "vault-connection-refused"
            ? connected.reason
            : connected.kind,
          asked(w.cloud),
        ];
      };
      // Neither region knows it.
      expect(
        await answer(w.host, { ...values, clientSecret: "wrongsecret1" }),
      ).toEqual([
        "invalid-credentials",
        ["identity eu /connect/token", "identity us /connect/token"],
      ]);
      // The EU's identity host does not answer (no connection, or a 5xx):
      // the US is never asked in its place.
      const failing = (
        region: "eu" | "us",
        fail: () => Promise<Response>,
      ): VaultHost => ({
        ...w.host,
        fetch: (url, init) =>
          url.startsWith(
            `https://identity.bitwarden.${region === "eu" ? "eu" : "com"}/`,
          )
            ? fail()
            : w.cloud.fetch(url, init),
      });
      expect(
        await answer(
          failing("eu", async () => {
            throw new Error("connect ECONNREFUSED");
          }),
        ),
      ).toEqual(["unreachable", []]);
      expect(
        await answer(
          failing("eu", async () => new Response("", { status: 502 })),
        ),
      ).toEqual(["unreachable", []]);
      // The EU refuses it as unknown and the US does not answer: unreachable,
      // never "the key is wrong".
      const us = await form(w.cloud, {
        email: "agents.us@example.com",
        region: "us",
      });
      expect(
        await answer(
          failing("us", async () => {
            throw new Error("connect ETIMEDOUT");
          }),
          us,
        ),
      ).toEqual(["unreachable", ["identity eu /connect/token"]]);
      // The EU's rate limit stops there too.
      w.cloud.flags.rateLimit = true;
      expect(await answer(w.host, us)).toEqual([
        "rate-limited",
        ["identity eu /connect/token"],
      ]);
      w.cloud.flags.rateLimit = false;
      // Nothing was written by any of them.
      expect(await readConnection(w.host.connection)).toBeNull();
      expect(await files(join(w.home, ".local"))).toEqual([]);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an agents' account whose KDF the token answer leaves out unlocks with the prelogin's",
  async () => {
    const w = await world();
    try {
      w.cloud.flags.kdfInToken = false;
      const values = await form(w.cloud, { kdf: argon2id });
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connected",
      });
      expect(
        w.cloud.requests.map((entry) => `${entry.host} ${entry.path}`),
      ).toEqual([
        "identity /connect/token",
        "api /accounts/profile",
        "identity /accounts/prelogin",
      ]);
      expect(w.cloud.requests.at(-1)?.body).toEqual({ email: agents });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "only a personal Environment without a vault or a connection connects: a connected one, a 0197 pilot, a Lazurio Vaultwarden and a work Environment are refused",
  async () => {
    const w = await world();
    const vault = await startFakeVault(join(w.parent, "vault-home"));
    try {
      const values = await form(w.cloud);
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connected",
      });
      const before = w.cloud.requests.length;
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connection-refused",
        reason: "connected",
      });
      const zip = zipOf("bw", fakeBw);
      const pin = fakePin(zip);
      for (const [context, reason] of [
        [pilotContext(), "pilot-0197"],
        [ownContext(), "not-offered"],
        [ownContext(workHandover(), "work"), "not-offered"],
        [{ kind: "unsupported", reason: "no-vault" } as const, "not-offered"],
        [
          { kind: "unsupported", reason: "workstation" } as const,
          "not-offered",
        ],
      ] as const) {
        const other = fakeHost({
          home: join(w.parent, "vault-home"),
          vault,
          pin,
          download: fakeRelease(pin, zip).fetch,
          context: async () => context,
        });
        expect(await connectPersonalBitwarden(other, values)).toEqual({
          kind: "vault-connection-refused",
          reason,
        });
        expect(await disconnectPersonalBitwarden(other)).toEqual({
          kind: "vault-connection-refused",
          reason: "not-connected",
        });
      }
      // Refused before the cloud is asked.
      expect(w.cloud.requests).toHaveLength(before);
    } finally {
      vault.stop();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an agents' account that owns a Free organization already is refused before anything is written; one that comes to own one stops at the vault; a fresh account connects",
  async () => {
    const w = await world();
    try {
      // Owning a Free organization (the person's main account, or one used
      // before): not a separate agents' account, and the cloud would refuse
      // it a second Free organization. Nothing is written.
      const values = await form(w.cloud);
      await w.cloud.ownsFreeOrganization(agents);
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connection-refused",
        reason: "owns-organization",
      });
      expect(await readConnection(w.host.connection)).toBeNull();
      expect(await readAccount(w.paths())).toBeNull();
      // One that comes to own one between connecting and the setup: the
      // cloud refuses the vault, and the setup says why.
      const late = "agents.late@example.com";
      expect(
        await connectPersonalBitwarden(
          w.host,
          await form(w.cloud, { email: late }),
        ),
      ).toEqual({ kind: "vault-connected" });
      await w.cloud.ownsFreeOrganization(late);
      const stopped = await vaultSetup(w.host);
      expect(stopped).toMatchObject({
        state: "failed",
        stage: "vault",
        reason: "free-organization-limit",
        region: "eu",
      });
      expect(setUpAtStart(stopped)).toBe(false);
      // Nothing created and no receipt left.
      expect(await w.cloud.organizationsOf(late)).toHaveLength(1);
      expect(await readRecord(w.paths(late))).toEqual({
        organizationId: null,
        collectionId: null,
        pendingKey: null,
        pendingSince: null,
      });
      // The person disconnects it and connects a fresh agents' account.
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-disconnected",
      });
      const fresh = await form(w.cloud, { email: "agents.fresh@example.com" });
      expect(await connectPersonalBitwarden(w.host, fresh)).toEqual({
        kind: "vault-connected",
      });
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "connected",
        account: "agents.fresh@example.com",
      });
      // The person owns a Free organization of their own too: invited as a
      // User, they can still join, which an Admin invitation would not let
      // them (the cloud's rule at acceptance).
      await w.cloud.account(person, "Their own password 1");
      await w.cloud.ownsFreeOrganization(person);
      expect(await invitePersonalBitwarden(w.host, invitation)).toEqual({
        kind: "vault-member",
        state: "invitation-pending",
      });
      expect(await w.cloud.accept(person)).toBe("accepted");
      expect(await vaultMembership(w.host, people.anonymous)).toEqual({
        kind: "vault-member",
        state: "member",
      });
    } finally {
      await w.close();
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "an interrupted creation resumes by its receipt: the lost answer is found, one vault exists, and nobody is invited until the person asks",
  async () => {
    const w = await world();
    try {
      expect(
        await connectPersonalBitwarden(w.host, await form(w.cloud)),
      ).toEqual({ kind: "vault-connected" });
      let lose = true;
      const lossy: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          const answer = await w.cloud.fetch(url, init);
          if (lose && url === "https://api.bitwarden.eu/organizations")
            throw new Error("connection reset");
          return answer;
        },
      };
      expect(await vaultSetup(lossy)).toMatchObject({ state: "unreachable" });
      expect(await vaultStatus(w.host)).toMatchObject({ state: "creating" });
      lose = false;
      expect(await vaultSetup(lossy)).toMatchObject({ state: "connected" });
      expect(await w.cloud.organizationsOf(agents)).toHaveLength(1);
      expect(w.cloud.mails).toEqual([]);
    } finally {
      await w.close();
    }
  },
  120_000,
);

// The invitation (F53's amendment of 2026-10-16, (2)): the person asks for it
// on the page once the vault exists, with the address of their own
// Bitwarden account; never the agents' account, one address per connection.
test.skipIf(!posix)(
  "the person asks to be invited once the vault exists: their own address only, one address, the same one again only looks again, and the lock or a missing vault refuse before anything is written",
  async () => {
    const w = await world();
    try {
      const refusal = async (input: { email: unknown }) => {
        const answer = await invitePersonalBitwarden(w.host, input);
        return answer.kind === "vault-connection-refused"
          ? answer.reason
          : answer.kind;
      };
      // Nothing connected: nobody to invite into anything.
      expect(await refusal(invitation)).toBe("not-connected");
      // Connected, but the setup has not created the vault yet.
      expect(
        await connectPersonalBitwarden(w.host, await form(w.cloud)),
      ).toEqual({ kind: "vault-connected" });
      expect(await refusal(invitation)).toBe("not-connected");
      expect(await vaultMembership(w.host, people.anonymous)).toEqual({
        kind: "vault-member-unknown",
        reason: "not-connected",
      });
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      expect(await vaultMembership(w.host, people.anonymous)).toEqual({
        kind: "vault-member",
        state: "not-invited",
      });
      // Not an address, or the agents' own account (in any case).
      expect(await refusal({ email: "not an address" })).toBe("email-invalid");
      expect(await refusal({ email: 7 })).toBe("email-invalid");
      expect(await refusal({ email: ` ${agents.toUpperCase()} ` })).toBe(
        "same-account",
      );
      // Another request holds the connection's lock: busy.
      const lock = await acquireFileLock(join(w.host.connection, "lock"), {
        timeoutMs: 1_000,
      });
      try {
        expect(await refusal(invitation)).toBe("busy");
      } finally {
        await lock.release();
      }
      // None of these wrote anything or asked the cloud to invite anyone.
      expect((await readConnection(w.host.connection))?.invitee).toBeNull();
      expect(w.cloud.mails).toEqual([]);
      // The person's own address: kept and invited.
      expect(await invitePersonalBitwarden(w.host, invitation)).toEqual({
        kind: "vault-member",
        state: "invitation-pending",
      });
      expect(w.cloud.mails).toEqual([person]);
      // The same address again only looks again; another is refused.
      expect(await invitePersonalBitwarden(w.host, { email: person })).toEqual({
        kind: "vault-member",
        state: "invitation-pending",
      });
      expect(await refusal({ email: "someone.else@example.com" })).toBe(
        "invited",
      );
      expect(w.cloud.mails).toEqual([person]);
      expect((await readConnection(w.host.connection))?.invitee).toBe(person);
      // Accepted, then confirmed by the next look.
      expect(await w.cloud.accept(person)).toBe("accepted");
      expect(await vaultMembership(w.host, people.anonymous)).toEqual({
        kind: "vault-member",
        state: "member",
      });
      // Disconnected and connected again: nobody to invite until they ask
      // again; the same address finds its membership.
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-disconnected",
      });
      expect(await refusal(invitation)).toBe("not-connected");
      expect(
        await connectPersonalBitwarden(w.host, {
          clientId: (await readAccountOf(w.cloud, agents)).clientId,
          clientSecret: (await readAccountOf(w.cloud, agents)).clientSecret,
          masterPassword: password,
        }),
      ).toEqual({ kind: "vault-connected" });
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      expect(await vaultMembership(w.host, people.anonymous)).toEqual({
        kind: "vault-member",
        state: "not-invited",
      });
      expect(await invitePersonalBitwarden(w.host, invitation)).toEqual({
        kind: "vault-member",
        state: "member",
      });
      expect(w.cloud.mails).toEqual([person]);
      // The journal: what happened, never the address.
      expect(
        w.journal.filter((entry) => entry.outcome === "invitee-set"),
      ).toHaveLength(2);
      expect(JSON.stringify(w.journal)).not.toContain(person);
      expect(await w.cloud.calls()).not.toContain(person);
    } finally {
      await w.close();
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "only a connected personal Environment's own Bitwarden takes an invitation",
  async () => {
    const w = await world();
    const vault = await startFakeVault(join(w.parent, "vault-home"));
    try {
      const zip = zipOf("bw", fakeBw);
      const pin = fakePin(zip);
      for (const [context, reason] of [
        [pilotContext(), "pilot-0197"],
        [ownContext(), "not-offered"],
        [ownContext(workHandover(), "work"), "not-offered"],
        [{ kind: "unsupported", reason: "no-vault" } as const, "not-offered"],
        [
          { kind: "unsupported", reason: "connection-unreadable" } as const,
          "not-connected",
        ],
        [
          { kind: "needs-connection", name: "Osobní example" } as const,
          "not-connected",
        ],
      ] as const) {
        const other = fakeHost({
          home: join(w.parent, "vault-home"),
          vault,
          pin,
          download: fakeRelease(pin, zip).fetch,
          context: async () => context,
        });
        expect(await invitePersonalBitwarden(other, invitation)).toEqual({
          kind: "vault-connection-refused",
          reason,
        });
      }
      expect(w.cloud.requests).toHaveLength(0);
    } finally {
      vault.stop();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "disconnecting forgets the account here and keeps the organization; the same account connected again finds its vault",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud);
      await connectPersonalBitwarden(w.host, values);
      const first = await vaultSetup(w.host);
      if (first.state !== "connected") throw new Error("Expected connected");
      const paths = w.paths();
      const record = await readRecord(paths);
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-disconnected",
      });
      // Signed out, the credentials, the session and bw's store gone; the
      // record of the vault stays, and so does the organization.
      expect(await w.cloud.calls()).toContain("logout --nointeraction");
      for (const path of [
        paths.account,
        paths.session,
        join(paths.data, "data.json"),
        join(w.host.connection, "connection.json"),
      ])
        expect([path, await lstat(path).catch(() => null)]).toEqual([
          path,
          null,
        ]);
      expect(await readRecord(paths)).toEqual(record);
      expect(await w.cloud.organizationsOf(agents)).toHaveLength(1);
      expect(w.cloud.requests.some((entry) => entry.method === "DELETE")).toBe(
        false,
      );
      expect(await vaultStatus(w.host)).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      });
      // No custody file holds a value any more.
      for (const file of await files(join(w.home, ".local", "state"))) {
        const text = await readFile(file, "utf8");
        for (const value of [password, values.clientSecret as string])
          expect([file, text.includes(value)]).toEqual([file, false]);
      }
      expect(w.journal).toContainEqual({
        operation: "disconnect",
        outcome: "disconnected",
      });
      // Nothing to disconnect now.
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-connection-refused",
        reason: "not-connected",
      });
      // Connected again: its own vault, by the record; never a second one.
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connected",
      });
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "connected",
        organizationId: first.organizationId,
        collectionId: first.collectionId,
      });
      expect(await w.cloud.organizationsOf(agents)).toHaveLength(1);
    } finally {
      await w.close();
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "an agents' account file lost after connecting is never registered: the person reconnects it",
  async () => {
    const w = await world();
    try {
      await connectPersonalBitwarden(w.host, await form(w.cloud));
      await rm(w.paths().account);
      const missing = {
        state: "failed",
        stage: "account",
        reason: "account-missing",
      };
      expect(await vaultStatus(w.host)).toMatchObject(missing);
      expect(setUpAtStart(await vaultStatus(w.host))).toBe(false);
      expect(await vaultSetup(w.host)).toMatchObject(missing);
      expect(
        w.cloud.requests.filter((entry) => entry.path.includes("register")),
      ).toHaveLength(0);
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-disconnected",
      });
      expect(await vaultStatus(w.host)).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a vault the person deleted in Bitwarden reads as revoked, and connecting the same account again creates a new one; a rotated API key reconnects to the same vault",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud);
      await connectPersonalBitwarden(w.host, values);
      const first = await vaultSetup(w.host);
      if (first.state !== "connected") throw new Error("Expected connected");
      // The person deletes the vault in the web vault: never recreated by a
      // setup on its own.
      await w.cloud.deleteOrganization(first.organizationId);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "revoked" });
      expect(await vaultSetup(w.host)).toMatchObject({ state: "revoked" });
      expect(await w.cloud.organizationsOf(agents)).toHaveLength(0);
      // Connecting again is the person's decision: the record of the gone
      // vault is forgotten and the setup creates a new one.
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-disconnected",
      });
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connected",
      });
      expect(w.journal).toContainEqual({
        operation: "connect",
        outcome: "record-discarded",
      });
      const second = await vaultSetup(w.host);
      expect(second).toMatchObject({ state: "connected" });
      if (second.state !== "connected") throw new Error("Expected connected");
      expect(second.organizationId).not.toBe(first.organizationId);
      expect(await w.cloud.organizationsOf(agents)).toHaveLength(1);
      // A rotated API key: the old one is refused (revoked); the new one,
      // connected again, finds the same vault and keeps its record.
      await w.cloud.rotateApiKey(agents, "rotatedsecret0123456789");
      expect(await vaultSetup(w.host)).toMatchObject({ state: "revoked" });
      await disconnectPersonalBitwarden(w.host);
      const before = w.journal.filter(
        (entry) => entry.outcome === "record-discarded",
      ).length;
      expect(
        await connectPersonalBitwarden(w.host, {
          ...values,
          clientSecret: "rotatedsecret0123456789",
        }),
      ).toEqual({ kind: "vault-connected" });
      expect(
        w.journal.filter((entry) => entry.outcome === "record-discarded"),
      ).toHaveLength(before);
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "connected",
        organizationId: second.organizationId,
      });
    } finally {
      await w.close();
    }
  },
  120_000,
);

// An unresolved creation's receipt (decision F53 point 3) exempts exactly one
// organization from "owns or administers another organization": the one
// whose public key the cloud's API shows as that receipt, by the setup's own
// test (`carriesReceipt`). Everything else is refused before anything is
// written (Pablo's review of #450 at 386f4f58).

/** A receipt as the setup records it before asking for a creation: the new
 * organization's public key and the time. */
const receipt = "ReceiptKey".repeat(15);

/** The agents' account's custody holding an unresolved creation's receipt,
 * as an interrupted setup of an earlier connection left it. */
async function pendingReceipt(
  paths: ReturnType<typeof vaultPaths>,
): Promise<VaultRecord> {
  await ensureVaultDirectories(paths);
  const record: VaultRecord = {
    organizationId: null,
    collectionId: null,
    pendingKey: receipt,
    pendingSince: new Date().toISOString(),
  };
  await writeRecord(paths, record);
  return record;
}

test.skipIf(!posix)(
  "a pending receipt does not exempt another organization the agents' account owns: refused before anything is written",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud);
      const record = await pendingReceipt(w.paths());
      // A Free organization of its own, whose key is not the receipt's.
      const family = await w.cloud.ownsFreeOrganization(agents);
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connection-refused",
        reason: "owns-organization",
      });
      // Told apart by its key, asked as the agents' account.
      expect(
        w.cloud.requests.some(
          (entry) =>
            entry.host === "api" &&
            entry.method === "GET" &&
            entry.path === `/organizations/${family}/public-key`,
        ),
      ).toBe(true);
      // Nothing written: no credentials, no connection, the receipt as it was.
      expect(await readAccount(w.paths())).toBeNull();
      expect(await readConnection(w.host.connection)).toBeNull();
      expect(await readRecord(w.paths())).toEqual(record);
      expect(w.journal).toEqual([
        {
          operation: "connect",
          outcome: "refused",
          reason: "owns-organization",
        },
      ]);
      expect(await vaultStatus(w.host)).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a pending receipt exempts exactly the organization that carries it: reconnected after a lost creation answer, the setup finds that vault and makes no second one",
  async () => {
    const w = await world();
    try {
      const values = await form(w.cloud);
      await connectPersonalBitwarden(w.host, values);
      // The creation reaches the cloud and its answer is lost: the receipt
      // stays unresolved.
      const lossy: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          const answer = await w.cloud.fetch(url, init);
          if (url === "https://api.bitwarden.eu/organizations")
            throw new Error("connection reset");
          return answer;
        },
      };
      expect(await vaultSetup(lossy)).toMatchObject({ state: "unreachable" });
      expect(await vaultStatus(w.host)).toMatchObject({ state: "creating" });
      const [created] = await w.cloud.organizationsOf(agents);
      if (created === undefined) throw new Error("Expected the creation");
      const pending = await readRecord(w.paths());
      expect(pending.pendingKey).toBe(created.publicKey);
      // The person disconnects and connects the same account again: the one
      // organization it owns carries the receipt, so it connects.
      expect(await disconnectPersonalBitwarden(w.host)).toEqual({
        kind: "vault-disconnected",
      });
      expect(await connectPersonalBitwarden(w.host, values)).toEqual({
        kind: "vault-connected",
      });
      expect(
        w.cloud.requests.filter(
          (entry) =>
            entry.method === "GET" &&
            entry.path === `/organizations/${created.id}/public-key`,
        ).length,
      ).toBeGreaterThan(0);
      // The setup resolves the receipt to it: one vault, one creation.
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "connected",
        organizationId: created.id,
      });
      expect(await w.cloud.organizationsOf(agents)).toHaveLength(1);
      expect(
        w.cloud.requests.filter(
          (entry) =>
            entry.host === "api" &&
            entry.method === "POST" &&
            entry.path === "/organizations",
        ),
      ).toHaveLength(1);
      expect(await readRecord(w.paths())).toMatchObject({
        organizationId: created.id,
        pendingKey: null,
      });
    } finally {
      await w.close();
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "with a pending receipt, two organizations that carry it, or one whose key cannot be read, refuse before anything is written",
  async () => {
    const w = await world();
    try {
      const refusedNothingWritten = async (
        host: VaultHost,
        values: ConnectionInput,
        account: string,
        record: VaultRecord,
        reason: ConnectionRefusal,
      ) => {
        expect(await connectPersonalBitwarden(host, values)).toEqual({
          kind: "vault-connection-refused",
          reason,
        });
        expect(await readAccount(w.paths(account))).toBeNull();
        expect(await readConnection(w.host.connection)).toBeNull();
        expect(await readRecord(w.paths(account))).toEqual(record);
      };
      // Two organizations carry the receipt: not one that is provably this
      // Environment's vault.
      const twice = "agents.twice@example.com";
      const twiceValues = await form(w.cloud, { email: twice });
      const twiceRecord = await pendingReceipt(w.paths(twice));
      await w.cloud.ownsFreeOrganization(twice, receipt);
      await w.cloud.ownsFreeOrganization(twice, receipt);
      await refusedNothingWritten(
        w.host,
        twiceValues,
        twice,
        twiceRecord,
        "owns-organization",
      );
      // One that carries it, but whose key the cloud will not show, or does
      // not answer for: unproven, so refused (fail closed).
      const hidden = "agents.hidden@example.com";
      const hiddenValues = await form(w.cloud, { email: hidden });
      const hiddenRecord = await pendingReceipt(w.paths(hidden));
      const organization = await w.cloud.ownsFreeOrganization(hidden, receipt);
      const keyAnswer = (status: number): VaultHost => ({
        ...w.host,
        fetch: async (url, init) =>
          url ===
          `https://api.bitwarden.eu/organizations/${organization}/public-key`
            ? Response.json({ message: "Resource not found." }, { status })
            : w.cloud.fetch(url, init),
      });
      await refusedNothingWritten(
        keyAnswer(404),
        hiddenValues,
        hidden,
        hiddenRecord,
        "owns-organization",
      );
      await refusedNothingWritten(
        keyAnswer(503),
        hiddenValues,
        hidden,
        hiddenRecord,
        "unreachable",
      );
      // The same, its key readable: the one organization that carries the
      // receipt is this Environment's own vault, and it connects.
      expect(await connectPersonalBitwarden(w.host, hiddenValues)).toEqual({
        kind: "vault-connected",
      });
      // Only fixed reasons in the journal, never an address or a key.
      const journal = JSON.stringify(w.journal);
      for (const value of [twice, hidden, receipt, organization])
        expect(journal).not.toContain(value);
    } finally {
      await w.close();
    }
  },
  120_000,
);
