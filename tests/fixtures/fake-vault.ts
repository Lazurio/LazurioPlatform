import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { parseMachineContext } from "../../src/machine/context";
import { runTool } from "../../src/tools/status";
import { vaultContextOf } from "../../src/vault/context";
import type { VaultHost, VaultJournalEntry } from "../../src/vault/flow";
import type { BitwardenPin } from "../../src/vault/pin";
import { handoverEntry } from "./machine-bindings";
import personal from "./machine-context-personal.json";

// A fake Vaultwarden and a fake Bitwarden CLI for the Environment vault
// (decision F43). Nothing here reaches a vendor or the network: the vault is
// a Bun.serve on loopback behind an injected fetch, the CLI a shell script
// that keeps its store in BITWARDENCLI_APPDATA_DIR and reads what the vault
// would sync from `$HOME/bw-world`, which the fake vault and the tests
// write. Every name, host and value is invented.

export const zone = "example.lazurio.io";
export const vaultOrigin = `https://vaultwarden.${zone}`;
export const organizationId = "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b";
export const collectionId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
export const otherCollectionId = "1f2e3d4c-5b6a-4f9e-8d7c-6b5a4f3e2d1c";
export const fingerprint = "steep-flavor-uncut-scouring-unnoticed";

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
get)
  unlocked
  if [ "$2" = fingerprint ] && [ "$3" = me ]; then cat "$world/fingerprint"; exit 0; fi
  echo "Not found." >&2; exit 1;;
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

type FakeUser = {
  id: string;
  email: string;
  hash: string;
  publicKey: string;
  apiKey: string | null;
  devices: string[];
};

/** A fake Vaultwarden: the registration, password login and API key
 * endpoints with Vaultwarden's shapes and messages, and the membership the
 * tests move (invited, accepted on registration, confirmed, removed). */
export async function startFakeVault(home: string) {
  const world = join(home, "bw-world");
  await mkdir(world, { recursive: true });
  await writeFile(join(world, "fingerprint"), `${fingerprint}\n`);
  const invited = new Set<string>();
  const users = new Map<string, FakeUser>();
  const tokens = new Map<string, string>();
  const requests: { path: string; body: unknown; accept: string | null }[] = [];
  const flags = { smtp: false, rateLimit: false, plainToken: false };
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
        const user = users.get(String(value.username));
        for (const field of ["deviceIdentifier", "deviceName", "deviceType"])
          if (typeof value[field] !== "string" || value[field] === "")
            return refusal(`${field} cannot be blank`);
        if (
          value.grant_type !== "password" ||
          user === undefined ||
          user.hash !== value.password
        )
          return json(
            {
              error: "invalid_grant",
              error_description: "invalid_username_or_password",
              ErrorModel: {
                Message: "Username or password is incorrect. Try again",
              },
            },
            400,
          );
        if (!user.devices.includes(String(value.deviceIdentifier)))
          user.devices.push(String(value.deviceIdentifier));
        const claims = Buffer.from(JSON.stringify({ sub: user.id })).toString(
          "base64url",
        );
        return json({
          access_token: `eyJhbGciOiJub25lIn0.${claims}.signature`,
          token_type: "Bearer",
          Key: "2.redacted",
          PrivateKey: "2.redacted",
        });
      }
      if (url.pathname === "/api/accounts/api-key") {
        const bearer = request.headers.get("authorization") ?? "";
        const claims = JSON.parse(
          Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString(
            "utf8",
          ) || "{}",
        ) as { sub?: string };
        const user = [...users.values()].find(
          (entry) => entry.id === claims.sub,
        );
        if (user === undefined || value.masterPasswordHash !== user.hash)
          return refusal("Invalid password");
        user.apiKey ??= randomBytes(15).toString("hex");
        await writeFile(
          join(world, "apikeys"),
          [...users.values()]
            .filter((entry) => entry.apiKey !== null)
            .map((entry) => `user.${entry.id} ${entry.apiKey} ${entry.email}\n`)
            .join(""),
        );
        return json({ apiKey: user.apiKey, object: "apiKey" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const write = (name: string, value: unknown) =>
    writeFile(join(world, name), `${JSON.stringify(value)}\n`);
  const collection = (id: string, name: string) => ({
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
    /** The vault as the core asks it: the invented https origin mapped to
     * the loopback server. */
    fetch: (url: string, init: RequestInit) =>
      fetch(url.replace(vaultOrigin, origin), init),
    invite: (email: string) => invited.add(email),
    /** The Admin confirmed the member: the organization, its collections
     * and items are what a sync brings. */
    async confirm(
      collectionName: string,
      items = 3,
      extra: readonly string[] = [],
    ) {
      await write("orgs.json", [
        {
          object: "organization",
          id: organizationId,
          name: "Example Organization",
          status: 2,
          type: 2,
          enabled: true,
        },
      ]);
      await write("collections.json", [
        collection(collectionId, collectionName),
        ...extra.map((name) => collection(otherCollectionId, name)),
      ]);
      await write(
        "items.json",
        Array.from({ length: items }, (_, index) => ({
          object: "item",
          id: randomUUID(),
          name: `example-${index}`,
          login: { username: "example", password: "invented-value" },
        })),
      );
    },
    /** The Admin removed the member. */
    async remove() {
      for (const name of ["orgs.json", "collections.json", "items.json"])
        await rm(join(world, name), { force: true });
    },
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

/** The personal Remote Environment of `example` on a network whose control
 * server is `headscale.example.lazurio.io`. */
export const personalHandover = parseMachineContext(
  Buffer.from(
    JSON.stringify({
      ...personal,
      network: {
        ...personal.network,
        headscale_server_url: `https://headscale.${zone}`,
      },
      entry: handoverEntry("example.lazurio.io"),
    }),
  ),
);

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
    context:
      input.context ??
      (async () =>
        vaultContextOf({
          handover: personalHandover,
          kind: "personal",
          label: null,
        })),
    directory: (host) =>
      join(input.home, ".local", "state", "lazurio", "vault", host),
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
