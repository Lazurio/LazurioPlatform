import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTool } from "../../src/tools/status";
import { readConnection } from "../../src/vault/connection";
import {
  type BitwardenConnection,
  personalVaultContextOf,
} from "../../src/vault/context";
import { bitwardenRegions } from "../../src/vault/endpoints";
import type { VaultHost, VaultJournalEntry } from "../../src/vault/flow";
import type { BitwardenPin } from "../../src/vault/pin";
import {
  deriveMasterKey,
  encrypt,
  type Kdf,
  randomBytes as keyBytes,
  makeKeyPair,
  stretchMasterKey,
  symmetricKey,
} from "../../src/vault/register";
import { personalHandoverAt, stateDirectory } from "./fake-vault";

// A fake Bitwarden cloud for a personal Environment's own Bitwarden (root
// decision 0203 point 7): an identity host and an API host of their own, two
// loopback servers behind an injected fetch, for both regions (the region is
// the host the core asks, and is recorded). It keeps the cloud's rules this
// Platform depends on: API-key sign-ins only answer `client_credentials`
// (the password grant is refused as new-device verification would refuse
// it), accounts with PBKDF2 or Argon2id, `POST /organizations` wants
// `useSecretsManager` named and refuses a second Free organization of an
// account that owns or administers one ("You can only be an admin of one
// free organization."), the same rule at an invitation's acceptance and
// confirmation, at most two members of a Free organization, and an
// invitation e-mailed to an address with or without an account. bw is the
// same fake CLI as the Vaultwarden's (`fakeBw`), over the same files in
// `$HOME/bw-world`. Every name, address and value is invented.

export type FakeCloudAccount = {
  id: string;
  /** The region the account was created in: the other knows nothing of it. */
  region: "eu" | "us";
  email: string;
  kdf: Kdf;
  clientSecret: string;
  publicKey: string;
  protectedUserKey: string;
  encryptedPrivateKey: string;
};

export type FakeCloudMember = {
  /** The membership's id (`OrganizationUser`). */
  id: string;
  email: string;
  /** The account that accepted, once one did. */
  userId: string | null;
  /** 0 Owner, 1 Admin, 2 User. */
  type: number;
  /** -1 revoked, 0 invited, 1 accepted, 2 confirmed. */
  status: number;
  key: string | null;
  collections: unknown;
};

export type FakeCloudOrganization = {
  id: string;
  name: string;
  billingEmail: string;
  free: boolean;
  publicKey: string;
  encryptedPrivateKey: string;
  collections: { id: string; name: string }[];
};

export type FakeCloudRequest = {
  host: "identity" | "api" | "web";
  region: "eu" | "us";
  method: string;
  path: string;
  body: unknown;
};

export async function startFakeBitwardenCloud(home: string) {
  const world = join(home, "bw-world");
  await mkdir(world, { recursive: true });
  const accounts = new Map<string, FakeCloudAccount>();
  const organizations = new Map<string, FakeCloudOrganization>();
  const requests: FakeCloudRequest[] = [];
  /** The invitations the cloud e-mailed, by address. */
  const mails: string[] = [];
  const flags = {
    /** The token answer leaves the KDF out: the prelogin says it. */
    kdfInToken: true,
    rateLimit: false,
  };
  const membersFile = (organization: string) =>
    join(world, `members-${organization}`);
  // The members of an organization, in the file the fake bw reads and
  // confirms in (`<member id> <status> <type> <email>` a line), and the
  // rest beside it here.
  const extra = new Map<
    string,
    { userId: string | null; key: string | null; collections: unknown }
  >();
  async function readMembers(organization: string): Promise<FakeCloudMember[]> {
    const text = await readFile(membersFile(organization), "utf8").catch(
      () => "",
    );
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [id, status, type, email] = line.split(" ");
        const more = extra.get(String(id));
        return {
          id: String(id),
          status: Number(status),
          type: Number(type),
          email: String(email),
          userId: more?.userId ?? null,
          key: more?.key ?? null,
          collections: more?.collections ?? null,
        };
      });
  }
  async function writeMembers(
    organization: string,
    members: readonly FakeCloudMember[],
  ) {
    for (const member of members)
      extra.set(member.id, {
        userId: member.userId,
        key: member.key,
        collections: member.collections,
      });
    await writeFile(
      membersFile(organization),
      members
        .map(
          (member) =>
            `${member.id} ${member.status} ${member.type} ${member.email}\n`,
        )
        .join(""),
    );
  }
  const write = (name: string, value: unknown) =>
    writeFile(join(world, name), `${JSON.stringify(value)}\n`);
  /** Whether an account owns or administers a Free organization (the
   * cloud's `GetCountByFreeOrganizationAdminUserAsync`), leaving one out. */
  async function adminOfFree(userId: string, except?: string) {
    for (const organization of organizations.values()) {
      if (!organization.free || organization.id === except) continue;
      if (
        (await readMembers(organization.id)).some(
          (member) =>
            member.userId === userId && member.type <= 1 && member.status >= 1,
        )
      )
        return true;
    }
    return false;
  }
  /** What a sync brings an account: the organizations it is a confirmed
   * member of, with their collections as bw shows them. */
  async function syncWorld() {
    const own: FakeCloudOrganization[] = [];
    for (const organization of organizations.values())
      if (
        (await readMembers(organization.id)).some(
          (member) => member.status === 2 && member.userId !== null,
        )
      )
        own.push(organization);
    await write(
      "orgs.json",
      own.map((organization) => ({
        object: "organization",
        id: organization.id,
        name: organization.name,
        status: 2,
        type: 0,
        enabled: true,
      })),
    );
    await write(
      "collections.json",
      own.flatMap((organization) =>
        organization.collections.map((collection, index) => ({
          object: "collection",
          id: collection.id,
          organizationId: organization.id,
          name: index === 0 ? "Agenti" : `Collection ${index}`,
          externalId: null,
        })),
      ),
    );
  }
  async function writeApiKeys() {
    await writeFile(
      join(world, "apikeys"),
      [...accounts.values()]
        .map(
          (account) =>
            `user.${account.id} ${account.clientSecret} ${account.email}\n`,
        )
        .join(""),
    );
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const refusal = (message: string, status = 400) =>
    json(
      {
        message,
        validationErrors: null,
        exceptionMessage: null,
        exceptionStackTrace: null,
        innerExceptionMessage: null,
        object: "error",
      },
      status,
    );
  const kdfFields = (kdf: Kdf) =>
    kdf.type === 1
      ? {
          Kdf: 1,
          KdfIterations: kdf.iterations,
          KdfMemory: kdf.memory,
          KdfParallelism: kdf.parallelism,
        }
      : {
          Kdf: 0,
          KdfIterations: kdf.iterations,
          KdfMemory: null,
          KdfParallelism: null,
        };
  const bearer = (request: Request): FakeCloudAccount | undefined => {
    const header = request.headers.get("authorization") ?? "";
    let sub: unknown;
    try {
      sub = JSON.parse(
        Buffer.from(header.split(".")[1] ?? "", "base64url").toString("utf8"),
      ).sub;
    } catch {
      return undefined;
    }
    return [...accounts.values()].find((account) => account.id === sub);
  };
  async function body(request: Request): Promise<unknown> {
    const text = await request.text();
    if (
      request.headers
        .get("content-type")
        ?.includes("application/x-www-form-urlencoded") === true
    )
      return Object.fromEntries(new URLSearchParams(text));
    return text === "" ? null : JSON.parse(text);
  }

  const identity = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const value = ((await body(request)) ?? {}) as Record<string, unknown>;
      requests.push({
        host: "identity",
        region: regionOf(request),
        method: request.method,
        path: url.pathname,
        body: value,
      });
      if (flags.rateLimit) return refusal("Too many requests", 429);
      if (url.pathname === "/accounts/prelogin") {
        const known = accounts.get(String(value.email));
        const account = known?.region === regionOf(request) ? known : undefined;
        // An unknown address gets the defaults, never a refusal.
        const kdf: Kdf = account?.kdf ?? { type: 0, iterations: 600_000 };
        const fields = kdfFields(kdf);
        return json({
          kdf: fields.Kdf,
          kdfIterations: fields.KdfIterations,
          kdfMemory: fields.KdfMemory,
          kdfParallelism: fields.KdfParallelism,
        });
      }
      if (url.pathname === "/connect/token") {
        // A person's password grant meets new-device verification: never
        // what this Platform sends.
        if (value.grant_type !== "client_credentials")
          return json(
            {
              error: "invalid_grant",
              error_description: "new device verification required",
            },
            400,
          );
        const account = [...accounts.values()].find(
          (entry) =>
            `user.${entry.id}` === value.client_id &&
            entry.region === regionOf(request),
        );
        if (
          account === undefined ||
          value.scope !== "api" ||
          account.clientSecret !== value.client_secret ||
          typeof value.deviceIdentifier !== "string" ||
          value.deviceType !== "21"
        )
          return json({ error: "invalid_client" }, 400);
        return json({
          access_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: account.id })).toString("base64url")}.signature`,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "api",
          Key: account.protectedUserKey,
          PrivateKey: account.encryptedPrivateKey,
          ...(flags.kdfInToken ? kdfFields(account.kdf) : {}),
          ResetMasterPassword: false,
          ForcePasswordReset: false,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const value = ((await body(request)) ?? {}) as Record<string, unknown>;
      requests.push({
        host: "api",
        region: regionOf(request),
        method: request.method,
        path: url.pathname,
        body: value,
      });
      const account = bearer(request);
      if (account === undefined) return new Response(null, { status: 401 });
      if (url.pathname === "/accounts/profile") {
        const memberships = [];
        for (const organization of organizations.values())
          for (const member of await readMembers(organization.id))
            if (member.userId === account.id)
              memberships.push({
                object: "profileOrganization",
                id: organization.id,
                name: organization.name,
                status: member.status,
                type: member.type,
                key: member.key,
                productTierType: organization.free ? 0 : 1,
                enabled: true,
              });
        return json({
          object: "profile",
          id: account.id,
          email: account.email,
          organizations: memberships,
        });
      }
      if (url.pathname === "/organizations" && request.method === "POST") {
        const keys = value.keys as Record<string, unknown> | undefined;
        if (
          typeof value.name !== "string" ||
          value.name === "" ||
          value.name.length > 50 ||
          value.billingEmail !== account.email ||
          typeof value.key !== "string" ||
          !value.key.startsWith("4.") ||
          typeof keys?.publicKey !== "string" ||
          typeof keys.encryptedPrivateKey !== "string" ||
          !keys.encryptedPrivateKey.startsWith("2.") ||
          typeof value.collectionName !== "string" ||
          !value.collectionName.startsWith("2.") ||
          value.planType !== 0 ||
          value.useSecretsManager !== false
        )
          return refusal("The model state is invalid.");
        if (await adminOfFree(account.id))
          return refusal("You can only be an admin of one free organization.");
        const organization: FakeCloudOrganization = {
          id: randomUUID(),
          name: value.name,
          billingEmail: value.billingEmail,
          free: true,
          publicKey: keys.publicKey,
          encryptedPrivateKey: keys.encryptedPrivateKey,
          collections: [{ id: randomUUID(), name: value.collectionName }],
        };
        organizations.set(organization.id, organization);
        await writeMembers(organization.id, [
          {
            id: randomUUID(),
            email: account.email,
            userId: account.id,
            type: 0,
            status: 2,
            key: value.key,
            collections: null,
          },
        ]);
        await syncWorld();
        return json({
          object: "organization",
          id: organization.id,
          name: organization.name,
        });
      }
      const match =
        /^\/organizations\/([0-9a-f-]{36})(\/public-key|\/collections|\/users\/invite)?$/.exec(
          url.pathname,
        );
      const organization =
        match === null ? undefined : organizations.get(match[1] as string);
      if (match === null) return new Response("not found", { status: 404 });
      const members =
        organization === undefined ? [] : await readMembers(organization.id);
      const own = members.find((member) => member.userId === account.id);
      if (organization === undefined || own === undefined)
        return refusal("Resource not found.", 404);
      if (match[2] === "/public-key" && request.method === "GET")
        return json({
          object: "organizationPublicKey",
          publicKey: organization.publicKey,
        });
      if (match[2] === "/collections" && request.method === "GET")
        return json({
          object: "list",
          data: organization.collections.map((collection) => ({
            object: "collection",
            id: collection.id,
            organizationId: organization.id,
            name: collection.name,
            externalId: null,
          })),
          continuationToken: null,
        });
      if (match[2] === undefined && request.method === "PUT") {
        if (own.type !== 0) return refusal("Resource not found.", 404);
        organization.name = String(value.name);
        await syncWorld();
        return json({ object: "organization", id: organization.id });
      }
      if (match[2] === "/users/invite" && request.method === "POST") {
        if (own.type > 1) return refusal("Resource not found.", 404);
        const collections = value.collections;
        if (
          Object.keys(value).sort().join() !==
            "accessSecretsManager,collections,emails,groups,permissions,type" ||
          !Array.isArray(value.emails) ||
          !Array.isArray(collections) ||
          !collections.every((entry) => {
            const selection = entry as Record<string, unknown>;
            return (
              organization.collections.some(
                (collection) => collection.id === selection.id,
              ) &&
              Object.keys(selection).sort().join() ===
                "hidePasswords,id,manage,readOnly"
            );
          }) ||
          ![0, 1, 2].includes(Number(value.type))
        )
          return refusal("The model state is invalid.");
        const next = [...members];
        for (const entry of value.emails as unknown[]) {
          const email = String(entry);
          // An address that is a member already is skipped, as the cloud
          // does.
          if (next.some((member) => member.email === email)) continue;
          if (organization.free && next.length >= 2)
            return refusal(
              "You have reached the maximum number of users (2) for this organization.",
            );
          next.push({
            id: randomUUID(),
            email,
            userId: null,
            type: Number(value.type),
            status: 0,
            key: null,
            collections,
          });
          mails.push(email);
        }
        await writeMembers(organization.id, next);
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  /** The region a request was sent to, by the host the core asked. */
  function regionOf(request: Request): "eu" | "us" {
    return request.headers.get("x-fake-region") === "us" ? "us" : "eu";
  }
  const loopback = (server: { port?: number | undefined }) =>
    `http://127.0.0.1:${server.port}`;

  /** The cloud as the core asks it: the identity and API hosts of either
   * region to their loopback servers; the web vault's host answers nothing
   * (the core never asks it). Every other address is refused. */
  const fetch_: (url: string, init: RequestInit) => Promise<Response> = async (
    url,
    init,
  ) => {
    for (const region of ["eu", "us"] as const) {
      const endpoints = bitwardenRegions[region];
      for (const [host, server] of [
        [endpoints.identity, identity],
        [endpoints.api, api],
      ] as const)
        if (url.startsWith(`${host}/`))
          return fetch(url.replace(host, loopback(server)), {
            ...init,
            headers: { ...(init.headers as object), "x-fake-region": region },
          });
      if (url.startsWith(`${endpoints.web}/`)) {
        requests.push({
          host: "web",
          region,
          method: init.method ?? "GET",
          path: new URL(url).pathname,
          body: null,
        });
        return new Response("not found", { status: 404 });
      }
    }
    throw new Error(`fetch failed: ${url}`);
  };

  return {
    world,
    accounts,
    organizations,
    requests,
    mails,
    flags,
    fetch: fetch_,
    /**
     * An account as a person creates it on the cloud's web vault: its keys
     * from a password, an e-mail and a KDF, and its API key. `keys: "v2"`
     * gives it keys of another form (a v2 account cryptographic state).
     */
    async account(
      email: string,
      password: string,
      kdf: Kdf = { type: 0, iterations: 600_000 },
      keys: "v1" | "v2" = "v1",
      region: "eu" | "us" = "eu",
    ) {
      const masterKey = await deriveMasterKey(password, email, kdf);
      const userKey = keyBytes(64);
      const pair = await makeKeyPair(symmetricKey(userKey));
      const account: FakeCloudAccount = {
        id: randomUUID(),
        region,
        email,
        kdf,
        clientSecret: randomBytes(15).toString("hex"),
        publicKey: pair.publicKey,
        protectedUserKey:
          keys === "v1"
            ? await encrypt(userKey, await stretchMasterKey(masterKey))
            : "7.v2-account-cryptographic-state",
        encryptedPrivateKey:
          keys === "v1" ? pair.encryptedPrivateKey : "7.v2-private-key",
      };
      accounts.set(email, account);
      await writeApiKeys();
      return {
        clientId: `user.${account.id}`,
        clientSecret: account.clientSecret,
      };
    },
    /** The person creates a new API key for an account in the web vault:
     * the one before is refused from now on. */
    async rotateApiKey(email: string, secret: string) {
      const account = accounts.get(email);
      if (account === undefined) throw new Error("No such account");
      account.clientSecret = secret;
      await writeApiKeys();
    },
    /** An account that owns a Free organization already (its family's). */
    async ownsFreeOrganization(email: string) {
      const account = accounts.get(email);
      if (account === undefined) throw new Error("No such account");
      const organization: FakeCloudOrganization = {
        id: randomUUID(),
        name: "Family",
        billingEmail: email,
        free: true,
        publicKey: "x".repeat(120),
        encryptedPrivateKey: "2.a|b|c",
        collections: [{ id: randomUUID(), name: "2.a|b|c" }],
      };
      organizations.set(organization.id, organization);
      await writeMembers(organization.id, [
        {
          id: randomUUID(),
          email,
          userId: account.id,
          type: 0,
          status: 2,
          key: "4.x",
          collections: null,
        },
      ]);
      return organization.id;
    },
    /** The organizations an account is a member of. */
    async organizationsOf(email: string): Promise<FakeCloudOrganization[]> {
      const account = accounts.get(email);
      const found: FakeCloudOrganization[] = [];
      for (const organization of organizations.values())
        if (
          (await readMembers(organization.id)).some(
            (member) => account !== undefined && member.userId === account.id,
          )
        )
          found.push(organization);
      return found;
    },
    members: readMembers,
    /**
     * The person accepts the e-mailed invitation with their own account
     * (created then, when they had none): as the cloud does, refused for an
     * Owner or Admin invitation while they own or administer another Free
     * organization.
     */
    async accept(email: string): Promise<"accepted" | "refused"> {
      const person =
        accounts.get(email) ??
        (await (async () => {
          await this.account(email, `Their own password ${randomUUID()}`);
          return accounts.get(email) as FakeCloudAccount;
        })());
      for (const organization of organizations.values()) {
        const members = await readMembers(organization.id);
        const invited = members.find(
          (member) => member.email === email && member.status === 0,
        );
        if (invited === undefined) continue;
        if (
          organization.free &&
          invited.type <= 1 &&
          (await adminOfFree(person.id, organization.id))
        )
          return "refused";
        await writeMembers(
          organization.id,
          members.map((member) =>
            member === invited
              ? { ...member, status: 1, userId: person.id }
              : member,
          ),
        );
      }
      return "accepted";
    },
    /** A person removes the organization in the web vault (never this
     * Platform). */
    async deleteOrganization(id: string) {
      organizations.delete(id);
      await rm(membersFile(id), { force: true });
      await syncWorld();
    },
    async calls(): Promise<string> {
      return readFile(join(home, "bw.calls"), "utf8").catch(() => "");
    },
    unreachable: (on: boolean) =>
      on
        ? writeFile(join(world, "unreachable"), "")
        : rm(join(world, "unreachable"), { force: true }),
    stop() {
      identity.stop(true);
      api.stop(true);
    },
  };
}
export type FakeBitwardenCloud = Awaited<
  ReturnType<typeof startFakeBitwardenCloud>
>;

/** The personal Environment `example` without a vault in its handover, as
 * the production composition reads it (src/vault/host.ts): its person's
 * own Bitwarden as connected, or waiting for its person. */
export async function personalContext(connection: string) {
  let recorded: BitwardenConnection | null;
  try {
    recorded = await readConnection(connection);
  } catch {
    return Object.freeze({
      kind: "unsupported" as const,
      reason: "connection-unreadable" as const,
    });
  }
  if (recorded === null)
    return Object.freeze({ kind: "needs-connection" as const });
  const context = personalVaultContextOf({
    handover: personalHandoverAt("example.lazurio.io", null),
    connection: recorded,
  });
  if (context === null) throw new Error("Expected a personal Environment");
  return context;
}

/** A vault host on a private home with the fake cloud and release, whose
 * context is the personal Environment `example`. */
export function cloudHost(
  input: Readonly<{
    home: string;
    cloud: FakeBitwardenCloud;
    pin: BitwardenPin;
    download: (url: string) => Promise<Response>;
    journal?: VaultJournalEntry[];
  }>,
): VaultHost {
  const connection = join(
    input.home,
    ".local",
    "state",
    "lazurio",
    "vault",
    "personal",
  );
  return {
    context: () => personalContext(connection),
    directory: (host, key) => stateDirectory(input.home, host, key),
    connection,
    base: join(input.home, ".local", "share", "lazurio"),
    bin: join(input.home, ".local", "bin"),
    home: input.home,
    path: "/usr/bin:/bin",
    platform: "linux",
    arch: "x64",
    run: runTool,
    fetch: input.cloud.fetch,
    download: input.download,
    pin: input.pin,
    journal: (entry) => input.journal?.push(entry),
    lockMs: 2_000,
  };
}
