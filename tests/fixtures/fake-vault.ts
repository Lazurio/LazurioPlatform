import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { parseMachineContext } from "../../src/machine/context";
import { runTool } from "../../src/tools/status";
import {
  type VaultContext,
  type VaultEnvironmentKind,
  vaultContextOf,
} from "../../src/vault/context";
import type { VaultHost, VaultJournalEntry } from "../../src/vault/flow";
import {
  type PilotContext,
  pilotContextOf,
} from "../../src/vault/legacy-0197/context";
import type { BitwardenPin } from "../../src/vault/pin";
import { handoverEntry } from "./machine-bindings";
import organization from "./machine-context.json";
import personal from "./machine-context-personal.json";

// A fake Vaultwarden and a fake Bitwarden CLI for the Environment's vault
// (decisions F43 and F53). Nothing here reaches a vendor or the network: the
// vault is a Bun.serve on loopback behind an injected fetch, the CLI a shell
// script that keeps its store in BITWARDENCLI_APPDATA_DIR and reads what the
// vault would sync from `$HOME/bw-world`, which the fake vault and the tests
// write. Every name, host and value is invented.

export const zone = "example.lazurio.io";
export const vaultOrigin = `https://vaultwarden.${zone}`;
/** The technical account the network pre-allowed for the personal
 * Environment `example` (contract C2's shape). */
export const ownAccount =
  "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgsa@example.lazurio.io";
/** The same for the work Environment `workspace` of the Organization
 * `example`. */
export const workAccount =
  "vaultwarden-q2wd5oyrbkmfx3czjh7tapi4ul@workspace.example.lazurio.io";
export const vaultName = "Example Osobní example";
/** The decrypted name of every vault's first collection, as bw shows it:
 * the fake CLI cannot decrypt (tests/vault-organization.test.ts proves the
 * real names decrypt to it). */
export const agents = "Agenti";
/** A person's organization, where a 0197 pilot was given a collection. */
export const organizationId = "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b";
export const collectionId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
export const otherCollectionId = "1f2e3d4c-5b6a-4f9e-8d7c-6b5a4f3e2d1c";

// The fake CLI: the commands and messages of bw 2026.7.0 that the vault core
// uses. A session is valid while it is the last one `unlock` printed; every
// call appends its argv and whether BW_SESSION was set to `$HOME/bw.calls`.
export const fakeBw = String.raw`#!/bin/sh
data="$BITWARDENCLI_APPDATA_DIR"
if [ -z "$data" ]; then echo "fake bw: no BITWARDENCLI_APPDATA_DIR" >&2; exit 97; fi
world="$HOME/bw-world"
store="$data/fake"
mkdir -p "$store"
[ -f "$data/data.json" ] || echo '{}' > "$data/data.json"
printf '%s|session=%s\n' "$*" "$([ -n "$BW_SESSION" ] && echo yes || echo no)" >> "$HOME/bw.calls"
after() { want="$1"; shift; prev=""; for a in "$@"; do if [ "$prev" = "$want" ]; then echo "$a"; return 0; fi; prev="$a"; done; return 1; }
unlocked() {
  [ -f "$store/user" ] || { echo "You are not logged in." >&2; exit 1; }
  if [ -n "$BW_SESSION" ] && [ -f "$store/session" ] && [ "$BW_SESSION" = "$(cat "$store/session")" ]; then return 0; fi
  # The real bw asks for the master password unless told not to interact.
  if [ "$BW_NOINTERACTION" != "true" ]; then echo "? Master password: [input is hidden]" >&2; exit 1; fi
  echo "Vault is locked." >&2; exit 1
}
offline() {
  if [ -f "$world/unreachable" ]; then echo "request to $(cat "$store/server" 2>/dev/null) failed, reason: getaddrinfo ENOTFOUND" >&2; exit 1; fi
}
case "$1" in
--version) echo "2026.7.0"; exit 0;;
config)
  if [ -f "$store/user" ]; then echo "Logout required before server config update." >&2; exit 1; fi
  echo "$3" > "$store/server"; echo "Saved setting config."; exit 0;;
login)
  offline
  if [ -f "$world/ratelimit" ]; then echo "Too many login requests" >&2; exit 1; fi
  line=$(grep -F "$BW_CLIENTID $BW_CLIENTSECRET " "$world/apikeys" 2>/dev/null | head -n 1)
  if [ -z "$line" ]; then echo "Incorrect client_secret" >&2; exit 1; fi
  echo "$line" | awk '{ print $3 }' > "$store/email"
  echo "$BW_CLIENTID" | sed 's/^user[.]//' > "$store/user"
  rm -f "$store/session"
  echo "You are logged in!"
  echo 'export BW_SESSION="LockedSessionLockedSessionLockedSessionLockedSession00=="'
  exit 0;;
unlock)
  [ -f "$store/user" ] || { echo "You are not logged in." >&2; exit 1; }
  file=$(after --passwordfile "$@")
  password=$(head -n 1 "$file")
  if [ -f "$store/password" ]; then
    [ "$password" = "$(cat "$store/password")" ] || { echo "Invalid master password." >&2; exit 1; }
  else printf '%s' "$password" > "$store/password"; fi
  session=$(head -c 64 /dev/urandom | base64 | tr -d '\n')
  printf '%s' "$session" > "$store/session"
  echo "$session"; exit 0;;
lock) rm -f "$store/session"; echo "Your vault is locked."; exit 0;;
logout)
  [ -f "$store/user" ] || { echo "You are not logged in." >&2; exit 1; }
  rm -f "$store/user" "$store/email" "$store/session" "$store/orgs.json" "$store/collections.json" "$store/items.json"
  echo "You have logged out."; exit 0;;
status)
  server=$(cat "$store/server" 2>/dev/null)
  if [ ! -f "$store/user" ]; then state=unauthenticated
  elif [ -n "$BW_SESSION" ] && [ -f "$store/session" ] && [ "$BW_SESSION" = "$(cat "$store/session")" ]; then state=unlocked
  else state=locked; fi
  email=$(cat "$store/email" 2>/dev/null)
  printf '{"serverUrl":"%s","lastSync":null,"userEmail":"%s","userId":null,"status":"%s"}\n' "$server" "$email" "$state"
  exit 0;;
sync)
  unlocked
  offline
  if [ -f "$world/invalid-grant" ]; then echo "invalid_grant" >&2; exit 1; fi
  for list in orgs collections items; do
    if [ -f "$world/$list.json" ]; then cp "$world/$list.json" "$store/$list.json"; else echo '[]' > "$store/$list.json"; fi
  done
  echo "Syncing complete."; exit 0;;
list)
  unlocked
  case "$2" in
  organizations) cat "$store/orgs.json" 2>/dev/null || echo '[]';;
  collections) cat "$store/collections.json" 2>/dev/null || echo '[]';;
  items) cat "$store/items.json" 2>/dev/null || echo '[]';;
  *) echo "Unknown object." >&2; exit 1;;
  esac
  exit 0;;
esac
echo "fake bw: unknown command $1" >&2
exit 64
`;

/** One zip entry `bw`, deflated, with its Unix mode: the shape of the
 * official OSS release. */
export function zipOf(name: string, text: string): Uint8Array {
  const file = new TextEncoder().encode(name);
  const raw = new TextEncoder().encode(text);
  const body = new Uint8Array(deflateRawSync(raw));
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, 8, true);
  local.setUint32(18, body.length, true);
  local.setUint32(22, raw.length, true);
  local.setUint16(26, file.length, true);
  const record = new DataView(new ArrayBuffer(46));
  record.setUint32(0, 0x02014b50, true);
  record.setUint16(4, (3 << 8) | 20, true);
  record.setUint16(10, 8, true);
  record.setUint32(20, body.length, true);
  record.setUint32(24, raw.length, true);
  record.setUint16(28, file.length, true);
  record.setUint32(38, (0o100755 << 16) >>> 0, true);
  record.setUint32(42, 0, true);
  const directorySize = 46 + file.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, 30 + file.length + body.length, true);
  const parts = [
    new Uint8Array(local.buffer),
    file,
    body,
    new Uint8Array(record.buffer),
    file,
    new Uint8Array(end.buffer),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A pin of the fake release: the digest of the fake zip, a release on an
 * invented host the injected download serves. */
export function fakePin(zip: Uint8Array, version = "2026.7.0"): BitwardenPin {
  const asset = {
    name: `bw-oss-test-${version}.zip`,
    sha256: createHash("sha256").update(zip).digest("hex"),
  };
  return {
    version,
    release: `https://releases.example.invalid/cli-v${version}`,
    assets: {
      "linux-x64": asset,
      "linux-arm64": asset,
      "darwin-x64": asset,
      "darwin-arm64": asset,
    },
  };
}

/** The download of the fake release: only the pinned asset's address
 * answers; every request is counted. */
export function fakeRelease(pin: BitwardenPin, zip: Uint8Array) {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url: string) => {
      requests.push(url);
      return url === `${pin.release}/${pin.assets["linux-x64"].name}`
        ? new Response(new Uint8Array(zip))
        : new Response("not found", { status: 404 });
    },
  };
}

export type FakeUser = {
  id: string;
  email: string;
  hash: string;
  publicKey: string;
  /** The master-key-wrapped user key and the user-key-wrapped private key
   * the registration sent: what a token answer hands back. */
  protectedUserKey: string;
  encryptedPrivateKey: string;
  apiKey: string | null;
  devices: string[];
};

export type FakeOrganization = {
  id: string;
  name: string;
  billingEmail: string;
  publicKey: string;
  encryptedPrivateKey: string;
  /** By user id: the organization key encrypted to the member, its type
   * (0 Owner) and status (2 confirmed). */
  members: Map<string, { key: string; type: number; status: number }>;
  /** The collections, their names as the vault keeps them (encrypted). */
  collections: { id: string; name: string }[];
};

export type FakeRequest = {
  method: string;
  path: string;
  body: unknown;
  accept: string | null;
};

/** A fake Vaultwarden: the registration, password and API-key logins, the
 * API key, the account's profile and the organization endpoints the
 * Environment's own vault uses, with Vaultwarden's shapes and messages; and
 * what a 0197 pilot's person did in their own organization (`confirm`,
 * `remove`), which the tests move. */
export async function startFakeVault(home: string) {
  const world = join(home, "bw-world");
  await mkdir(world, { recursive: true });
  const invited = new Set<string>();
  const users = new Map<string, FakeUser>();
  const tokens = new Map<string, string>();
  const organizations = new Map<string, FakeOrganization>();
  const requests: FakeRequest[] = [];
  const flags = {
    smtp: false,
    rateLimit: false,
    plainToken: false,
    /** `ORG_CREATION_USERS` leaves this account out. */
    organizationRefused: false,
  };
  /** The person's organization of a 0197 pilot, as a sync brings it. */
  let pilotWorld: {
    orgs: unknown[];
    collections: unknown[];
  } = { orgs: [], collections: [] };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const refusal = (message: string, status = 400) =>
    json(
      {
        message,
        validationErrors: { "": [message] },
        ErrorModel: { Message: message, Object: "error" },
        error: "",
        error_description: "",
        object: "error",
      },
      status,
    );
  const write = (name: string, value: unknown) =>
    writeFile(join(world, name), `${JSON.stringify(value)}\n`);
  /** What a sync brings: the person's organization of a pilot, and every
   * organization an account of this vault is a confirmed member of, with its
   * first collection under the name bw would show. */
  async function syncWorld() {
    const own = [...organizations.values()].filter((organization) =>
      [...organization.members.values()].some((member) => member.status === 2),
    );
    await write("orgs.json", [
      ...pilotWorld.orgs,
      ...own.map((organization) => ({
        object: "organization",
        id: organization.id,
        name: organization.name,
        status: 2,
        type: 0,
        enabled: true,
      })),
    ]);
    await write("collections.json", [
      ...pilotWorld.collections,
      ...own.flatMap((organization) =>
        organization.collections.map((collection, index) => ({
          object: "collection",
          id: collection.id,
          organizationId: organization.id,
          name: index === 0 ? agents : `Collection ${index}`,
          externalId: null,
        })),
      ),
    ]);
  }
  const claims = (user: FakeUser) =>
    Buffer.from(JSON.stringify({ sub: user.id })).toString("base64url");
  const tokenAnswer = (user: FakeUser) =>
    json({
      access_token: `eyJhbGciOiJub25lIn0.${claims(user)}.signature`,
      token_type: "Bearer",
      expires_in: 7200,
      Key: user.protectedUserKey,
      PrivateKey: user.encryptedPrivateKey,
      Kdf: 0,
      KdfIterations: 600_000,
      scope: "api",
    });
  const bearer = (request: Request): FakeUser | undefined => {
    const header = request.headers.get("authorization") ?? "";
    let sub: unknown;
    try {
      sub = JSON.parse(
        Buffer.from(header.split(".")[1] ?? "", "base64url").toString("utf8"),
      ).sub;
    } catch {
      return undefined;
    }
    return [...users.values()].find((user) => user.id === sub);
  };
  const organizationJson = (organization: FakeOrganization) => ({
    object: "organization",
    id: organization.id,
    name: organization.name,
    billingEmail: organization.billingEmail,
    hasPublicAndPrivateKeys: true,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const body: unknown =
        request.headers
          .get("content-type")
          ?.includes("application/x-www-form-urlencoded") === true
          ? Object.fromEntries(new URLSearchParams(text))
          : text === ""
            ? null
            : JSON.parse(text);
      requests.push({
        method: request.method,
        path: url.pathname,
        body,
        accept: request.headers.get("accept"),
      });
      const value = (body ?? {}) as Record<string, unknown>;
      if (
        flags.rateLimit &&
        [
          "/identity/connect/token",
          "/identity/accounts/register/send-verification-email",
        ].includes(url.pathname)
      )
        return refusal("Too many login requests", 429);
      if (
        url.pathname === "/identity/accounts/register/send-verification-email"
      ) {
        const email = String(value.email);
        if (!invited.has(email) || users.has(email))
          return refusal("Registration not allowed or user already exists");
        if (flags.smtp) return new Response(null, { status: 204 });
        const token = `eyJ.${randomBytes(12).toString("hex")}.sig`;
        tokens.set(token, email);
        return request.headers.get("accept") === "application/json" &&
          !flags.plainToken
          ? json(token)
          : new Response(token, { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/identity/accounts/register/finish") {
        const email = String(value.email);
        const auth = value.masterPasswordAuthentication as Record<
          string,
          unknown
        >;
        const unlock = value.masterPasswordUnlock as Record<string, unknown>;
        const keys = value.userAsymmetricKeys as Record<string, unknown>;
        const kdf = {
          kdfType: 0,
          iterations: 600_000,
          memory: null,
          parallelism: null,
        };
        if (
          tokens.get(String(value.emailVerificationToken)) !== email ||
          JSON.stringify(auth.kdf) !== JSON.stringify(kdf) ||
          JSON.stringify(unlock.kdf) !== JSON.stringify(kdf) ||
          auth.salt !== email ||
          unlock.salt !== email ||
          typeof auth.masterPasswordAuthenticationHash !== "string" ||
          !/^[A-Za-z0-9+/]{43}=$/.test(auth.masterPasswordAuthenticationHash) ||
          typeof unlock.masterKeyWrappedUserKey !== "string" ||
          !unlock.masterKeyWrappedUserKey.startsWith("2.") ||
          typeof keys.encryptedPrivateKey !== "string" ||
          !keys.encryptedPrivateKey.startsWith("2.") ||
          typeof keys.publicKey !== "string" ||
          value.masterPasswordHint !== null
        )
          return refusal("Invalid registration", 422);
        users.set(email, {
          id: randomUUID(),
          email,
          hash: auth.masterPasswordAuthenticationHash,
          publicKey: keys.publicKey,
          protectedUserKey: unlock.masterKeyWrappedUserKey,
          encryptedPrivateKey: keys.encryptedPrivateKey,
          apiKey: null,
          devices: [],
        });
        invited.delete(email);
        return json({ object: "registerFinish" });
      }
      if (url.pathname === "/identity/accounts/prelogin")
        return json({
          kdf: 0,
          kdfIterations: 600_000,
          kdfMemory: null,
          kdfParallelism: null,
        });
      if (url.pathname === "/identity/connect/token") {
        for (const field of ["deviceIdentifier", "deviceName", "deviceType"])
          if (typeof value[field] !== "string" || value[field] === "")
            return refusal(`${field} cannot be blank`);
        const invalid = () =>
          json(
            {
              error: "invalid_grant",
              error_description: "invalid_username_or_password",
              ErrorModel: {
                Message: "Username or password is incorrect. Try again",
              },
            },
            400,
          );
        let user: FakeUser | undefined;
        if (value.grant_type === "password") {
          user = users.get(String(value.username));
          if (user === undefined || user.hash !== value.password)
            return invalid();
        } else if (value.grant_type === "client_credentials") {
          user = [...users.values()].find(
            (entry) => `user.${entry.id}` === value.client_id,
          );
          if (
            value.scope !== "api" ||
            user === undefined ||
            user.apiKey === null ||
            user.apiKey !== value.client_secret
          )
            return refusal("Incorrect client_secret");
        } else return invalid();
        if (!user.devices.includes(String(value.deviceIdentifier)))
          user.devices.push(String(value.deviceIdentifier));
        return tokenAnswer(user);
      }
      if (url.pathname === "/api/accounts/api-key") {
        const user = bearer(request);
        if (user === undefined || value.masterPasswordHash !== user.hash)
          return refusal("Invalid password");
        user.apiKey ??= randomBytes(15).toString("hex");
        await writeApiKeys();
        return json({ apiKey: user.apiKey, object: "apiKey" });
      }
      if (url.pathname.startsWith("/api/")) {
        const user = bearer(request);
        if (user === undefined) return new Response(null, { status: 401 });
        if (url.pathname === "/api/accounts/profile")
          return json({
            object: "profile",
            id: user.id,
            email: user.email,
            organizations: [...organizations.values()].flatMap(
              (organization) => {
                const member = organization.members.get(user.id);
                return member === undefined || member.status !== 2
                  ? []
                  : [
                      {
                        object: "profileOrganization",
                        id: organization.id,
                        name: organization.name,
                        type: member.type,
                        status: member.status,
                        key: member.key,
                        enabled: true,
                      },
                    ];
              },
            ),
          });
        if (
          url.pathname === "/api/organizations" &&
          request.method === "POST"
        ) {
          if (flags.organizationRefused)
            return refusal("User not allowed to create organizations");
          const keys = value.keys as Record<string, unknown> | undefined;
          if (
            typeof value.name !== "string" ||
            value.name === "" ||
            value.billingEmail !== user.email ||
            typeof value.key !== "string" ||
            !value.key.startsWith("4.") ||
            typeof keys?.publicKey !== "string" ||
            typeof keys.encryptedPrivateKey !== "string" ||
            !keys.encryptedPrivateKey.startsWith("2.") ||
            typeof value.collectionName !== "string" ||
            !value.collectionName.startsWith("2.") ||
            value.planType !== 0
          )
            return refusal("Invalid organization", 422);
          const organization: FakeOrganization = {
            id: randomUUID(),
            name: value.name,
            billingEmail: value.billingEmail,
            publicKey: keys.publicKey,
            encryptedPrivateKey: keys.encryptedPrivateKey,
            members: new Map([
              [user.id, { key: value.key, type: 0, status: 2 }],
            ]),
            collections: [{ id: randomUUID(), name: value.collectionName }],
          };
          organizations.set(organization.id, organization);
          await syncWorld();
          return json(organizationJson(organization));
        }
        const match =
          /^\/api\/organizations\/([0-9a-f-]{36})(\/public-key|\/collections)?$/.exec(
            url.pathname,
          );
        const organization =
          match === null ? undefined : organizations.get(match[1] as string);
        const member = organization?.members.get(user.id);
        if (match !== null) {
          if (organization === undefined || member === undefined)
            return refusal("Organization not found", 404);
          if (match[2] === "/public-key" && request.method === "GET")
            return json({
              object: "organizationPublicKey",
              publicKey: organization.publicKey,
            });
          if (match[2] === "/collections" && request.method === "GET")
            return member.type > 1
              ? refusal("Resource not found.", 404)
              : json({
                  object: "list",
                  continuationToken: null,
                  data: organization.collections.map((collection) => ({
                    object: "collection",
                    id: collection.id,
                    organizationId: organization.id,
                    name: collection.name,
                    externalId: null,
                    type: 0,
                  })),
                });
          if (match[2] === undefined && request.method === "PUT") {
            if (member.type !== 0) return refusal("Owner required", 404);
            if (typeof value.name !== "string" || value.name === "")
              return refusal("Invalid organization", 422);
            organization.name = value.name;
            organization.billingEmail = String(value.billingEmail);
            await syncWorld();
            return json(organizationJson(organization));
          }
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  async function writeApiKeys() {
    await writeFile(
      join(world, "apikeys"),
      [...users.values()]
        .filter((entry) => entry.apiKey !== null)
        .map((entry) => `user.${entry.id} ${entry.apiKey} ${entry.email}\n`)
        .join(""),
    );
  }
  const origin = `http://127.0.0.1:${server.port}`;
  const pilotCollection = (id: string, name: string) => ({
    object: "collection",
    id,
    organizationId,
    name,
    externalId: null,
  });
  return {
    world,
    requests,
    flags,
    users,
    organizations,
    /** The vault as the core asks it: the invented https origin mapped to
     * the loopback server. */
    fetch: (url: string, init: RequestInit) =>
      fetch(url.replace(vaultOrigin, origin), init),
    /** The network pre-allows an address (`/admin/invite`, contract C2); a
     * 0197 pilot's person invited it the same way. */
    allow: (email: string) => invited.add(email),
    /** The organizations the account of `email` belongs to. */
    organizationsOf(email: string): FakeOrganization[] {
      const user = users.get(email);
      return [...organizations.values()].filter(
        (organization) =>
          user !== undefined && organization.members.has(user.id),
      );
    },
    /** The requests of one path (and method). */
    of(path: string, method?: string): FakeRequest[] {
      return requests.filter(
        (entry) =>
          entry.path === path &&
          (method === undefined || entry.method === method),
      );
    },
    /** The network's operator deletes an organization (`/admin`). */
    async deleteOrganization(id: string) {
      organizations.delete(id);
      await syncWorld();
    },
    /** An Owner or Admin adds a collection. */
    async addCollection(id: string) {
      organizations
        .get(id)
        ?.collections.push({ id: randomUUID(), name: "2.added|x|y" });
      await syncWorld();
    },
    /** The account's API key is rotated (or the account removed): the one
     * the Environment keeps is refused from now on. */
    async rotateApiKey(email: string) {
      const user = users.get(email);
      if (user !== undefined) user.apiKey = randomBytes(15).toString("hex");
      await writeApiKeys();
    },
    /** A 0197 pilot's person confirmed the member: their organization, its
     * collections and items are what a sync brings. */
    async confirm(
      collectionName: string,
      items = 3,
      extra: readonly string[] = [],
    ) {
      pilotWorld = {
        orgs: [
          {
            object: "organization",
            id: organizationId,
            name: "Example Organization",
            status: 2,
            type: 2,
            enabled: true,
          },
        ],
        collections: [
          pilotCollection(collectionId, collectionName),
          ...extra.map((name) => pilotCollection(otherCollectionId, name)),
        ],
      };
      await syncWorld();
      await write(
        "items.json",
        Array.from({ length: items }, (_, index) => ({
          object: "item",
          id: randomUUID(),
          name: `example-${index}`,
          organizationId,
          collectionIds: [collectionId],
          login: { username: "example", password: "invented-value" },
        })),
      );
    },
    /** The pilot's person removed the member. */
    async remove() {
      pilotWorld = { orgs: [], collections: [] };
      await syncWorld();
      await rm(join(world, "items.json"), { force: true });
    },
    /** The items a sync brings. */
    items: (list: readonly unknown[]) => write("items.json", list),
    unreachable: (on: boolean) =>
      on
        ? writeFile(join(world, "unreachable"), "")
        : rm(join(world, "unreachable"), { force: true }),
    async calls(): Promise<string> {
      return readFile(join(home, "bw.calls"), "utf8").catch(() => "");
    },
    stop: () => server.stop(true),
  };
}
export type FakeVault = Awaited<ReturnType<typeof startFakeVault>>;

/** The handover's `vault` member of an Environment in the fake network. */
export const vaultMember = (account = ownAccount, name = vaultName) => ({
  server_url: vaultOrigin,
  account,
  name,
});

/** The personal Remote Environment at `<host>`, on a network whose control
 * server is `headscale.example.lazurio.io`, with or without its vault. */
export function personalHandoverAt(
  host: string,
  vault: ReturnType<typeof vaultMember> | null = vaultMember(),
) {
  return parseMachineContext(
    Buffer.from(
      JSON.stringify({
        ...personal,
        network: {
          ...personal.network,
          headscale_server_url: `https://headscale.${zone}`,
        },
        entry: handoverEntry(host),
        ...(vault === null ? {} : { vault }),
      }),
    ),
  );
}

/** The personal Remote Environment of `example`, with its own vault. */
export const personalHandover = personalHandoverAt("example.lazurio.io");

/** The work Environment `workspace` of the Organization `example`. */
export function workHandover(
  vault: ReturnType<typeof vaultMember> | null = vaultMember(
    workAccount,
    "Example Pracovní workspace",
  ),
) {
  const { team: _, ...owner } = organization.owner;
  return parseMachineContext(
    Buffer.from(
      JSON.stringify({
        ...organization,
        owner,
        network: {
          ...organization.network,
          headscale_server_url: `https://headscale.${zone}`,
        },
        entry: handoverEntry("workspace.example.lazurio.io"),
        ...(vault === null ? {} : { vault }),
      }),
    ),
  );
}

/** The own vault's context of a handover. */
export function ownContext(
  handover = personalHandover,
  environment: VaultEnvironmentKind = "personal",
): VaultContext {
  const context = vaultContextOf({ handover, environment });
  if (context.kind !== "own") throw new Error("Expected an own vault");
  return context;
}

/** The 0197 pilot's context of a handover without a vault. */
export function pilotContext(
  handover = personalHandoverAt("example.lazurio.io", null),
  environment: VaultEnvironmentKind = "personal",
): PilotContext {
  const context = pilotContextOf({ handover, environment });
  if (context === null) throw new Error("Expected a pilot");
  return context;
}

/** The state directory of one account under a fake home. */
export const stateDirectory = (home: string, host: string, key: string) =>
  join(home, ".local", "state", "lazurio", "vault", host, key);

/** A vault host on a private home with the fake vault and release. */
export function fakeHost(
  input: Readonly<{
    home: string;
    vault: FakeVault;
    pin: BitwardenPin;
    download: (url: string) => Promise<Response>;
    journal?: VaultJournalEntry[];
    context?: VaultHost["context"];
  }>,
): VaultHost {
  return {
    context: input.context ?? (async () => ownContext()),
    directory: (host, key) => stateDirectory(input.home, host, key),
    base: join(input.home, ".local", "share", "lazurio"),
    bin: join(input.home, ".local", "bin"),
    home: input.home,
    path: "/usr/bin:/bin",
    platform: "linux",
    arch: "x64",
    run: runTool,
    fetch: input.vault.fetch,
    download: input.download,
    pin: input.pin,
    journal: (entry) => input.journal?.push(entry),
    lockMs: 2_000,
  };
}
