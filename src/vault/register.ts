import { Buffer } from "node:buffer";
import { argon2, createHash, webcrypto } from "node:crypto";
import { vaultEndpoint } from "./endpoints";

// The technical account of an Environment in its network's vault (decisions
// F43 and F53): created here and signed in by its API key, so the stock
// Bitwarden CLI can run `bw login --apikey` and `bw unlock --passwordfile`,
// and the core can ask the vault's API as the account (`apiKeyLogin`,
// organization.ts). Verified end to end against Vaultwarden 1.37.1 and 1.37.4
// with the real bw (DEV-6631, the e2e report of 2026-10-09; the own vault
// against 1.37.4-lazurio.1 on 2026-10-13); the tests check the crypto against
// Bitwarden's own vectors and the requests against a fake vault.
//
// A personal Environment's agents' account in the person's own Bitwarden
// (root decision 0203 point 7) is not created here: the person enters it, and
// the same sign-in, unlock and organization requests reach the Bitwarden
// cloud's identity and API hosts (endpoints.ts). Such an account may derive
// its master key with Argon2id instead of PBKDF2.
//
// Server preconditions (Vaultwarden 1.37.x):
//  - the network pre-allowed exactly this address (`/admin/invite`, DEV-6631
//    contract C2; a 0197 pilot: an Admin of an organization invited it);
//  - SMTP is off: the server then returns the registration token directly.
//    SIGNUPS_ALLOWED=false is fine: the pre-allowance allows it.
//
// Crypto: Bitwarden "v1" account keys, WebCrypto and node:crypto only, no
// dependency.
//   masterKey          = PBKDF2-SHA256(password, salt = trimmed lowercased
//                        email, 600 000), the KDF of every account created
//                        here; an entered account's KDF is the vault's
//                        answer: PBKDF2-SHA256 with its iterations, or
//                        Argon2id(password, salt = SHA-256 of the trimmed
//                        lowercased email, its passes, its memory in MiB,
//                        its parallelism, 32 bytes)
//   masterPasswordHash = base64(PBKDF2-SHA256(masterKey, salt = password, 1)),
//                        the only thing derived from the password that the
//                        vault receives
//   stretched key      = HKDF-Expand(masterKey, "enc", 32) ||
//                        HKDF-Expand(masterKey, "mac", 32)
//   userKey            = 64 random bytes (AES-256 key || HMAC-SHA256 key)
//   Key                = EncString type 2 of userKey under the stretched key
//   key pair           = RSA-2048 OAEP-SHA1: public SPKI base64, private
//                        PKCS#8 as an EncString type 2 under userKey
// Any other key format (a v2 account cryptographic state) is refused, never
// guessed (`unsupported-keys`).

export const KDF_PBKDF2_SHA256 = 0;
export const KDF_ARGON2ID = 1;
export const PBKDF2_ITERATIONS = 600_000;

/** An account's key derivation, as its vault reports it. Argon2id's memory is
 * in MiB, as Bitwarden keeps it. */
export type Kdf =
  | Readonly<{ type: typeof KDF_PBKDF2_SHA256; iterations: number }>
  | Readonly<{
      type: typeof KDF_ARGON2ID;
      iterations: number;
      memory: number;
      parallelism: number;
    }>;

export const pbkdf2Kdf = (iterations = PBKDF2_ITERATIONS): Kdf =>
  Object.freeze({ type: KDF_PBKDF2_SHA256, iterations });

const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;

/** A KDF as a vault reports it (its type and parameters), within Bitwarden's
 * own bounds; null for any other: an unknown type, a parameter out of its
 * bounds or missing. PBKDF2-SHA256 of 5 000 to 10 000 000 iterations;
 * Argon2id of 2 to 10 passes, 15 to 1024 MiB and a parallelism of 1 to 16,
 * the ranges Bitwarden's clients and server accept. */
export function kdfOf(
  input: Readonly<{
    type: unknown;
    iterations: unknown;
    memory: unknown;
    parallelism: unknown;
  }>,
): Kdf | null {
  if (input.type === KDF_PBKDF2_SHA256)
    return whole(input.iterations, 5_000, 10_000_000)
      ? pbkdf2Kdf(input.iterations)
      : null;
  if (
    input.type === KDF_ARGON2ID &&
    whole(input.iterations, 2, 10) &&
    whole(input.memory, 15, 1024) &&
    whole(input.parallelism, 1, 16)
  )
    return Object.freeze({
      type: KDF_ARGON2ID,
      iterations: input.iterations,
      memory: input.memory,
      parallelism: input.parallelism,
    });
  return null;
}

/** Bitwarden DeviceType 21 = "SDK"; shown in the account's device list. */
export const DEVICE_TYPE_SDK = 21;

/** Byte arrays backed by a plain ArrayBuffer, what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;
/** AES-256-CBC key + HMAC-SHA256 key, 32 bytes each. */
export type SymmetricKey = Readonly<{ enc: Bytes; mac: Bytes }>;
export type Device = Readonly<{
  identifier: string;
  name: string;
  type: number;
}>;
export type Login = Readonly<{
  serverUrl: string;
  email: string;
  userId: string;
  accessToken: string;
  masterPasswordHash: string;
}>;

/** A fetch as the vault is asked; injectable so tests never reach a vault. */
export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;

const subtle = webcrypto.subtle;
const utf8 = (text: string): Bytes => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (text: string): Bytes =>
  new Uint8Array(Buffer.from(text, "base64"));
const concat = (...parts: Uint8Array[]): Bytes =>
  new Uint8Array(Buffer.concat(parts));
export const randomBytes = (length: number): Bytes =>
  webcrypto.getRandomValues(new Uint8Array(length));

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** 32 random bytes as base64url: 43 characters on one line (bw reads the
 * first line of `--passwordfile`). Generated on the Environment; no person
 * knows it. */
export const generateMasterPassword = () =>
  Buffer.from(randomBytes(32)).toString("base64url");

// ---------------------------------------------------------------------------
// Crypto primitives

async function pbkdf2(
  secret: Bytes,
  salt: Bytes,
  iterations: number,
): Promise<Bytes> {
  const key = await subtle.importKey("raw", secret, "PBKDF2", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    ),
  );
}

async function hmacSha256(key: Bytes, data: Bytes): Promise<Bytes> {
  const hmac = await subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", hmac, data));
}

/** Argon2id as Bitwarden derives a master key: the salt is the SHA-256 of
 * the normalized e-mail, the memory in KiB of its MiB, 32 bytes. The
 * asynchronous form, so the Launchpad keeps answering while it runs. */
function argon2id(
  password: string,
  email: string,
  kdf: Extract<Kdf, { type: typeof KDF_ARGON2ID }>,
): Promise<Bytes> {
  return new Promise((resolve, reject) =>
    argon2(
      "argon2id",
      {
        message: utf8(password),
        nonce: createHash("sha256")
          .update(utf8(normalizeEmail(email)))
          .digest(),
        parallelism: kdf.parallelism,
        tagLength: 32,
        memory: kdf.memory * 1024,
        passes: kdf.iterations,
      },
      (error, key) =>
        error === null ? resolve(new Uint8Array(key)) : reject(error),
    ),
  );
}

/** The master key of an account: PBKDF2-SHA256 of the password, salted by the
 * normalized e-mail (the KDF of every account created here), or Argon2id. */
export function deriveMasterKey(
  password: string,
  email: string,
  kdf: Kdf = pbkdf2Kdf(),
): Promise<Bytes> {
  return kdf.type === KDF_ARGON2ID
    ? argon2id(password, email, kdf)
    : pbkdf2(utf8(password), utf8(normalizeEmail(email)), kdf.iterations);
}

export async function makeMasterPasswordHash(
  masterKey: Bytes,
  password: string,
): Promise<string> {
  return b64(await pbkdf2(masterKey, utf8(password), 1));
}

/** HKDF-Expand only (RFC 5869, no extract step), the master key as PRK; 32
 * bytes = one HMAC block. */
export async function stretchMasterKey(
  masterKey: Bytes,
): Promise<SymmetricKey> {
  const expand = (info: string) =>
    hmacSha256(masterKey, concat(utf8(info), new Uint8Array([1])));
  return { enc: await expand("enc"), mac: await expand("mac") };
}

export function symmetricKey(bytes: Bytes): SymmetricKey {
  if (bytes.length !== 64)
    throw new Error(`symmetric key must be 64 bytes, got ${bytes.length}`);
  return { enc: bytes.slice(0, 32), mac: bytes.slice(32) };
}

/** EncString type 2 (AesCbc256_HmacSha256_B64):
 * "2.<iv>|<ciphertext>|<HMAC(mac, iv || ciphertext)>". */
export async function encrypt(
  data: Bytes | string,
  key: SymmetricKey,
): Promise<string> {
  const iv = randomBytes(16);
  const aes = await subtle.importKey("raw", key.enc, "AES-CBC", false, [
    "encrypt",
  ]);
  const plain = typeof data === "string" ? utf8(data) : data;
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-CBC", iv }, aes, plain),
  );
  const mac = await hmacSha256(key.mac, concat(iv, ciphertext));
  return `2.${b64(iv)}|${b64(ciphertext)}|${b64(mac)}`;
}

export async function decrypt(
  encString: string,
  key: SymmetricKey,
): Promise<Bytes> {
  const parts = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(encString);
  if (!parts) throw new Error("expected an EncString of type 2");
  const [iv, ciphertext, mac] = parts.slice(1).map(fromB64) as [
    Bytes,
    Bytes,
    Bytes,
  ];
  const hmac = await subtle.importKey(
    "raw",
    key.mac,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await subtle.verify("HMAC", hmac, mac, concat(iv, ciphertext))))
    throw new Error("EncString MAC mismatch");
  const aes = await subtle.importKey("raw", key.enc, "AES-CBC", false, [
    "decrypt",
  ]);
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-CBC", iv }, aes, ciphertext),
  );
}

const RSA_OAEP_SHA1 = { name: "RSA-OAEP", hash: "SHA-1" };

/** RSA-2048 key pair: public SPKI base64, private PKCS#8 wrapped as an
 * EncString type 2. */
export async function makeKeyPair(wrapWith: SymmetricKey) {
  const pair = await subtle.generateKey(
    {
      ...RSA_OAEP_SHA1,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["encrypt", "decrypt"],
  );
  const privateKey = new Uint8Array(
    await subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    publicKey: b64(
      new Uint8Array(await subtle.exportKey("spki", pair.publicKey)),
    ),
    encryptedPrivateKey: await encrypt(privateKey, wrapWith),
  };
}

/** EncString type 4 (Rsa2048_OaepSha1_B64): how an organization's key is
 * shared with a member's public key; the own vault's organization key is
 * handed to the account's own public key this way (organization.ts). */
export async function rsaEncrypt(
  publicKeyB64: string,
  data: Bytes,
): Promise<string> {
  const key = await subtle.importKey(
    "spki",
    fromB64(publicKeyB64),
    RSA_OAEP_SHA1,
    false,
    ["encrypt"],
  );
  return `4.${b64(new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, key, data)))}`;
}

export async function rsaDecrypt(
  privateKeyPkcs8: Bytes,
  encString: string,
): Promise<Bytes> {
  if (!encString.startsWith("4."))
    throw new Error("expected an EncString of type 4");
  const key = await subtle.importKey(
    "pkcs8",
    privateKeyPkcs8,
    RSA_OAEP_SHA1,
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await subtle.decrypt(
      { name: "RSA-OAEP" },
      key,
      fromB64(encString.slice(2)),
    ),
  );
}

/** The SPKI public key (base64) of an RSA private key in PKCS#8: the key
 * the account's own private key belongs to, so the organization key is
 * encrypted to a key this Environment can open, whatever the server says. */
export async function publicKeyOf(privateKeyPkcs8: Bytes): Promise<string> {
  const privateKey = await subtle.importKey(
    "pkcs8",
    privateKeyPkcs8,
    RSA_OAEP_SHA1,
    true,
    ["decrypt"],
  );
  const { n, e } = await subtle.exportKey("jwk", privateKey);
  if (n === undefined || e === undefined)
    throw new Error("expected an RSA private key");
  const publicKey = await subtle.importKey(
    "jwk",
    { kty: "RSA", n, e, alg: "RSA-OAEP", ext: true },
    RSA_OAEP_SHA1,
    true,
    ["encrypt"],
  );
  return b64(new Uint8Array(await subtle.exportKey("spki", publicKey)));
}

/** A key the vault keeps in Bitwarden's v1 account form: an EncString of
 * type 2 (AES-256-CBC with HMAC-SHA256). */
export const isAccountKey = (value: unknown): value is string =>
  typeof value === "string" && /^2\.[A-Za-z0-9+/=|]{1,20000}$/.test(value);

/** The account's private key from its master password and what the vault
 * keeps of it: the master-key-wrapped user key (`Key`) and the user-key-
 * wrapped private key (`PrivateKey`), as a client unlocks, with the
 * account's KDF. A user key that does not open is `wrong-password` (the
 * master password, salted by this e-mail, is not the account's); a key of
 * any form but Bitwarden's v1 account keys, or one that opens to something
 * else, is `unsupported-keys`. Never more is said, and nothing is kept. */
export async function unlockPrivateKey(
  input: Readonly<{
    email: string;
    password: string;
    protectedUserKey: string;
    encryptedPrivateKey: string;
    kdf: Kdf;
  }>,
): Promise<Bytes> {
  if (
    !isAccountKey(input.protectedUserKey) ||
    !isAccountKey(input.encryptedPrivateKey)
  )
    throw new VaultwardenError("unsupported-keys");
  const masterKey = await deriveMasterKey(
    input.password,
    input.email,
    input.kdf,
  );
  let userKey: Bytes;
  try {
    userKey = await decrypt(
      input.protectedUserKey,
      await stretchMasterKey(masterKey),
    );
  } catch {
    throw new VaultwardenError("wrong-password");
  }
  // A v2 account wraps a key of another form: refused, never guessed.
  if (userKey.length !== 64) throw new VaultwardenError("unsupported-keys");
  let privateKey: Bytes;
  try {
    privateKey = await decrypt(
      input.encryptedPrivateKey,
      symmetricKey(userKey),
    );
    await publicKeyOf(privateKey);
  } catch {
    throw new VaultwardenError("unsupported-keys");
  }
  return privateKey;
}

/** Everything register/finish needs; nothing here is stored outside the
 * request. */
export async function makeAccountKeys(
  email: string,
  password: string,
  iterations = PBKDF2_ITERATIONS,
) {
  const masterKey = await deriveMasterKey(
    password,
    email,
    pbkdf2Kdf(iterations),
  );
  const userKeyBytes = randomBytes(64);
  const keyPair = await makeKeyPair(symmetricKey(userKeyBytes));
  return {
    kdf: {
      kdfType: KDF_PBKDF2_SHA256,
      iterations,
      memory: null,
      parallelism: null,
    },
    masterPasswordHash: await makeMasterPasswordHash(masterKey, password),
    protectedUserKey: await encrypt(
      userKeyBytes,
      await stretchMasterKey(masterKey),
    ),
    ...keyPair,
  };
}

// ---------------------------------------------------------------------------
// HTTP

/** Why the vault refused or could not be asked, as a fixed code: never the
 * vault's text, which is not needed and is never logged. */
export type VaultwardenFailure =
  /** "Registration not allowed or user already exists": no invitation for
   * this address (or the account exists already). */
  | "not-invited"
  /** The vault's rate limit (HTTP 429). */
  | "rate-limited"
  /** HTTP 204 instead of a token: SMTP is on and a verification mail went
   * out, which an Environment account cannot receive. */
  | "smtp-enabled"
  /** The vault does not let this account create an organization
   * (`ORG_CREATION_USERS`). */
  | "organization-refused"
  /** The password login was refused. */
  | "invalid-credentials"
  /** "User does not exist": an invitation to an address without an account
   * in this vault (`INVITATIONS_ALLOWED=false`); the person signs in to the
   * network's vault once first (DEV-6631 task 638b). */
  | "no-account"
  /** "User already in organization": the address is a member already. */
  | "already-member"
  /** "SSO sign-in is required": the vault refuses every password path of
   * this address (`SSO_ONLY`, the address not exempt). */
  | "sso-required"
  /** "You can only be an admin of one free organization.": the Bitwarden
   * cloud refuses a second Free organization of an account that owns or
   * administers one (root decision 0203 point 7). */
  | "free-organization-limit"
  /** A KDF other than PBKDF2-SHA256 and Argon2id, or out of their bounds. */
  | "unsupported-kdf"
  /** The account's keys are not Bitwarden's v1 account keys (for example a
   * v2 account cryptographic state): refused, never guessed. */
  | "unsupported-keys"
  /** The master password does not open the account's user key. */
  | "wrong-password"
  /** No answer, a timeout, a 5xx or a non-https address. */
  | "unreachable"
  /** Any other answer. */
  | "unexpected";

export class VaultwardenError extends Error {
  constructor(
    readonly reason: VaultwardenFailure,
    readonly status?: number,
    /** For `invalid-credentials` of a token request: whether the identity
     * server answered, in its own words, that it does not know this client
     * (`unknownClientAnswer`). Any other refusal of a token request
     * (`invalid_request`, `invalid_grant`, an `access_denied`, another 4xx)
     * is not that, and nothing is concluded from it but the refusal. */
    readonly unknownClient = false,
  ) {
    super(reason);
    this.name = "VaultwardenError";
  }
}

/**
 * An identity server's answer to a token request whose client it does not
 * know, or whose secret does not match: HTTP 400 with the OAuth error
 * `invalid_client`, exactly. The Bitwarden cloud's Identity project
 * (bitwarden/server 0d707bf6842c05e523bc5d802e6d46a8dd62fedc,
 * `src/Identity/IdentityServer/DynamicClientStore.cs` and
 * `ClientProviders/UserClientProvider.cs`) finds no client for a
 * `user.<id>` it does not know and gives a known one its API key as the only
 * secret; Duende IdentityServer 7.4.6, which it pins
 * (DuendeSoftware/products tag `is-7.4.6`,
 * `identity-server/src/IdentityServer/Validation/Default/ClientSecretValidator.cs`),
 * fails both an unknown client and a secret that does not validate with
 * `invalid_client`, and its `TokenEndpoint` writes that as a
 * `TokenErrorResult`, status 400 and `{"error": "invalid_client"}`
 * (`Endpoints/Results/TokenErrorResult.cs`). Nothing else means that the
 * region does not know the key.
 */
export function unknownClientAnswer(status: number, data: unknown): boolean {
  return (
    status === 400 &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).error === "invalid_client"
  );
}

type CallOptions = Readonly<{
  /** GET without a body and POST with one, unless named. */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  json?: unknown;
  form?: Readonly<Record<string, string>>;
  token?: string;
}>;

const requestMs = 30_000;

export type VaultClient = Readonly<{ fetch?: VaultFetch | undefined }>;

/** One request to the vault: its answer as JSON (or text), or a
 * `VaultwardenError` with a fixed reason, never the vault's own words.
 * `serverUrl` is the vault's web address and `path` its identity's
 * (`/identity/…`) or API's (`/api/…`): a Vaultwarden serves both under its
 * own origin, a Bitwarden cloud region on its identity and API hosts
 * (endpoints.ts). */
export async function vaultRequest(
  client: VaultClient,
  serverUrl: string,
  path: string,
  options: CallOptions = {},
): Promise<unknown> {
  if (!serverUrl.startsWith("https://"))
    throw new VaultwardenError("unreachable");
  const url = vaultEndpoint(serverUrl, path);
  if (url === null) throw new VaultwardenError("unexpected");
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams({ ...options.form }).toString();
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestMs);
  let response: Response;
  let text: string;
  try {
    response = await (client.fetch ?? fetch)(url, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    throw new VaultwardenError("unreachable");
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = text === "" ? null : text;
  try {
    data = text === "" ? null : JSON.parse(text);
  } catch {
    // Plain text: 1.37.4 returns the registration token as text/plain
    // unless JSON is asked for.
  }
  if (!response.ok) {
    if (response.status === 429)
      throw new VaultwardenError("rate-limited", 429);
    if (response.status >= 500)
      throw new VaultwardenError("unreachable", response.status);
    const message = messageOf(data);
    if (/registration not allowed or user already exists/i.test(message))
      throw new VaultwardenError("not-invited", response.status);
    if (/too many/i.test(message))
      throw new VaultwardenError("rate-limited", response.status);
    if (/not allowed to create organizations/i.test(message))
      throw new VaultwardenError("organization-refused", response.status);
    if (/^user does not exist\b/i.test(message))
      throw new VaultwardenError("no-account", response.status);
    if (/^user already in organization\b/i.test(message))
      throw new VaultwardenError("already-member", response.status);
    if (/^sso sign-in is required\b/i.test(message))
      throw new VaultwardenError("sso-required", response.status);
    if (/only be an admin of one free organization/i.test(message))
      throw new VaultwardenError("free-organization-limit", response.status);
    if (
      path === "/identity/connect/token" ||
      /username or password is incorrect|invalid_grant/i.test(message)
    )
      throw new VaultwardenError(
        "invalid-credentials",
        response.status,
        path === "/identity/connect/token" &&
          unknownClientAnswer(response.status, data),
      );
    throw new VaultwardenError("unexpected", response.status);
  }
  return data;
}

function messageOf(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 300);
  if (data === null || typeof data !== "object") return "";
  const value = data as Record<string, unknown>;
  const model = value.ErrorModel as Record<string, unknown> | undefined;
  for (const candidate of [
    value.message,
    value.error_description,
    value.error,
    model?.Message,
  ])
    if (typeof candidate === "string" && candidate !== "") return candidate;
  return "";
}

// ---------------------------------------------------------------------------
// Flow

/** Creates the account; `not-invited` without an invitation (the vault
 * refuses a second registration of the same address the same way). */
export async function registerAccount(
  client: VaultClient,
  options: Readonly<{
    serverUrl: string;
    email: string;
    password: string;
    name?: string | undefined;
  }>,
): Promise<Readonly<{ email: string; publicKey: string }>> {
  const email = normalizeEmail(options.email);
  const token = await vaultRequest(
    client,
    options.serverUrl,
    "/identity/accounts/register/send-verification-email",
    {
      json: {
        email,
        name: options.name ?? null,
        receiveMarketingEmails: false,
      },
    },
  );
  // HTTP 204: the server mailed a verification link instead (SMTP on).
  if (typeof token !== "string" || token === "")
    throw new VaultwardenError("smtp-enabled");
  const keys = await makeAccountKeys(email, options.password);
  await vaultRequest(
    client,
    options.serverUrl,
    "/identity/accounts/register/finish",
    {
      json: {
        email,
        emailVerificationToken: token,
        masterPasswordHint: null,
        userAsymmetricKeys: {
          publicKey: keys.publicKey,
          encryptedPrivateKey: keys.encryptedPrivateKey,
        },
        masterPasswordAuthentication: {
          kdf: keys.kdf,
          salt: email,
          masterPasswordAuthenticationHash: keys.masterPasswordHash,
        },
        masterPasswordUnlock: {
          kdf: keys.kdf,
          salt: email,
          masterKeyWrappedUserKey: keys.protectedUserKey,
        },
      },
    },
  );
  return { email, publicKey: keys.publicKey };
}

/** grant_type=password with the Environment's one device identifier (each
 * new identifier adds a device to the account). */
export async function passwordLogin(
  client: VaultClient,
  options: Readonly<{
    serverUrl: string;
    email: string;
    password: string;
    device: Device;
  }>,
): Promise<Login> {
  const { serverUrl, password, device } = options;
  const email = normalizeEmail(options.email);
  const kdf = await prelogin(client, serverUrl, email);
  const masterKey = await deriveMasterKey(password, email, kdf);
  const masterPasswordHash = await makeMasterPasswordHash(masterKey, password);
  const token = (await vaultRequest(
    client,
    serverUrl,
    "/identity/connect/token",
    {
      form: {
        grant_type: "password",
        scope: "api offline_access",
        client_id: "cli",
        username: email,
        password: masterPasswordHash,
        deviceType: String(device.type),
        deviceIdentifier: device.identifier,
        deviceName: device.name,
      },
    },
  )) as Record<string, unknown> | null;
  const accessToken = token?.access_token;
  if (typeof accessToken !== "string") throw new VaultwardenError("unexpected");
  const userId = subjectOf(accessToken);
  return { serverUrl, email, userId, accessToken, masterPasswordHash };
}

/** The account id an access token was issued for (its `sub`). */
function subjectOf(accessToken: string): string {
  let userId: unknown;
  try {
    userId = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(
        "utf8",
      ),
    ).sub;
  } catch {
    throw new VaultwardenError("unexpected");
  }
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/.test(userId))
    throw new VaultwardenError("unexpected");
  return userId;
}

/** The personal API key for BW_CLIENTID / BW_CLIENTSECRET: created on the
 * first call, then stable. */
export async function fetchApiKey(
  client: VaultClient,
  login: Login,
): Promise<Readonly<{ clientId: string; clientSecret: string }>> {
  const result = (await vaultRequest(
    client,
    login.serverUrl,
    "/api/accounts/api-key",
    {
      token: login.accessToken,
      json: { masterPasswordHash: login.masterPasswordHash },
    },
  )) as Record<string, unknown> | null;
  const secret = result?.apiKey;
  if (typeof secret !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(secret))
    throw new VaultwardenError("unexpected");
  return { clientId: `user.${login.userId}`, clientSecret: secret };
}

/** A sign-in with the account's personal API key: what an access token for
 * the vault's API costs once the account is ready, without its master
 * password and also where the vault requires SSO of people
 * (`SSO_ONLY_API_KEY` exempts the Environment's address shape, 0197 point 4).
 * The answer also carries what unlocking the account's keys needs. */
export type ApiKeyLogin = Readonly<{
  serverUrl: string;
  userId: string;
  accessToken: string;
  /** `Key`: the user key wrapped by the master key (EncString type 2). */
  protectedUserKey: string;
  /** `PrivateKey`: the private key wrapped by the user key. */
  encryptedPrivateKey: string;
  /** The KDF of the master key as the answer carries it (`Kdf`,
   * `KdfIterations`, `KdfMemory`, `KdfParallelism`); null when it carries
   * none, and then the vault's prelogin says it (`accountKdf`). */
  kdf: Kdf | null;
}>;

/** An account's KDF as the vault's prelogin reports it for its e-mail, the
 * way every Bitwarden client learns it before deriving the master key. */
export async function prelogin(
  client: VaultClient,
  serverUrl: string,
  email: string,
): Promise<Kdf> {
  const answer = await vaultRequest(
    client,
    serverUrl,
    "/identity/accounts/prelogin",
    { json: { email: normalizeEmail(email) } },
  );
  const value =
    typeof answer === "object" && answer !== null && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : null;
  const kdf =
    value === null
      ? null
      : kdfOf({
          type: value.kdf,
          iterations: value.kdfIterations,
          memory: value.kdfMemory,
          parallelism: value.kdfParallelism,
        });
  if (kdf === null) throw new VaultwardenError("unsupported-kdf");
  return kdf;
}

/** The KDF of a signed-in account: the API-key answer's, or the prelogin's
 * for the account's e-mail where the answer carried none. */
export const accountKdf = (
  client: VaultClient,
  login: ApiKeyLogin,
  email: string,
): Promise<Kdf> =>
  login.kdf === null
    ? prelogin(client, login.serverUrl, email)
    : Promise.resolve(login.kdf);

export async function apiKeyLogin(
  client: VaultClient,
  options: Readonly<{
    serverUrl: string;
    clientId: string;
    clientSecret: string;
    device: Device;
  }>,
): Promise<ApiKeyLogin> {
  const { serverUrl, device } = options;
  const token = (await vaultRequest(
    client,
    serverUrl,
    "/identity/connect/token",
    {
      form: {
        grant_type: "client_credentials",
        scope: "api",
        client_id: options.clientId,
        client_secret: options.clientSecret,
        deviceType: String(device.type),
        deviceIdentifier: device.identifier,
        deviceName: device.name,
      },
    },
  )) as Record<string, unknown> | null;
  const accessToken = token?.access_token;
  if (typeof accessToken !== "string") throw new VaultwardenError("unexpected");
  const userId = subjectOf(accessToken);
  if (options.clientId !== `user.${userId}`)
    throw new VaultwardenError("unexpected");
  // The KDF the answer carries, when it carries one: a KDF of another type
  // or out of its bounds is refused, never guessed.
  let kdf: Kdf | null = null;
  if (token?.Kdf !== undefined) {
    kdf = kdfOf({
      type: token?.Kdf,
      iterations: token?.KdfIterations,
      memory: token?.KdfMemory,
      parallelism: token?.KdfParallelism,
    });
    if (kdf === null) throw new VaultwardenError("unsupported-kdf");
  }
  const key = token?.Key;
  const privateKey = token?.PrivateKey;
  if (typeof key !== "string" || typeof privateKey !== "string")
    throw new VaultwardenError("unexpected");
  // Keys of another form than Bitwarden's v1 account keys (a v2 account
  // cryptographic state) are refused, never guessed.
  if (!isAccountKey(key) || !isAccountKey(privateKey))
    throw new VaultwardenError("unsupported-keys");
  return Object.freeze({
    serverUrl,
    userId,
    accessToken,
    protectedUserKey: key,
    encryptedPrivateKey: privateKey,
    kdf,
  });
}

/** The vault's API as one account, signed in with its API key only when the
 * first request needs it and then reused: the vault's rate limit counts
 * sign-ins, not requests. */
export function accountApi(
  client: VaultClient,
  input: Readonly<{
    serverUrl: string;
    clientId: string;
    clientSecret: string;
    device: Device;
  }>,
): (path: string, options?: CallOptions) => Promise<unknown> {
  let token: string | null = null;
  return async (path, options = {}) => {
    token ??= (await apiKeyLogin(client, input)).accessToken;
    return vaultRequest(client, input.serverUrl, path, { ...options, token });
  };
}
