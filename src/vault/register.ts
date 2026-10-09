import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";

// The account of an Environment in its network's vault (decision F43):
// created here and signed in by its API key, so the stock Bitwarden CLI can
// run `bw login --apikey` and `bw unlock --passwordfile`. Verified end to end
// against Vaultwarden 1.37.1 and 1.37.4 with the real bw (DEV-6631, the e2e
// report of 2026-10-09); the tests check the crypto against Bitwarden's own
// vectors and the requests against a fake vault.
//
// Server preconditions (Vaultwarden 1.37.x):
//  - an Admin or Owner of the vault's organization invited exactly this
//    address;
//  - SMTP is off: the server then returns the registration token directly
//    and, on registration, accepts the pending invitation (Invited 0 →
//    Accepted 1). SIGNUPS_ALLOWED=false is fine: the invitation allows it.
// The Admin still confirms the member in their own client (the organization's
// key is handed over end to end; Accepted 1 → Confirmed 2).
//
// Crypto: Bitwarden "v1" account keys, WebCrypto only, no dependency.
//   masterKey          = PBKDF2-SHA256(password, salt = trimmed lowercased
//                        email, 600 000)
//   masterPasswordHash = base64(PBKDF2-SHA256(masterKey, salt = password, 1)),
//                        the only thing derived from the password that the
//                        vault receives
//   stretched key      = HKDF-Expand(masterKey, "enc", 32) ||
//                        HKDF-Expand(masterKey, "mac", 32)
//   userKey            = 64 random bytes (AES-256 key || HMAC-SHA256 key)
//   Key                = EncString type 2 of userKey under the stretched key
//   key pair           = RSA-2048 OAEP-SHA1: public SPKI base64, private
//                        PKCS#8 as an EncString type 2 under userKey

export const KDF_PBKDF2_SHA256 = 0;
export const PBKDF2_ITERATIONS = 600_000;
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

export function deriveMasterKey(
  password: string,
  email: string,
  iterations = PBKDF2_ITERATIONS,
) {
  return pbkdf2(utf8(password), utf8(normalizeEmail(email)), iterations);
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
 * shared with a member's public key. Used by the tests as the Admin. */
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

/** Everything register/finish needs; nothing here is stored outside the
 * request. */
export async function makeAccountKeys(
  email: string,
  password: string,
  iterations = PBKDF2_ITERATIONS,
) {
  const masterKey = await deriveMasterKey(password, email, iterations);
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
  /** The password login was refused. */
  | "invalid-credentials"
  /** A KDF other than PBKDF2-SHA256. */
  | "unsupported-kdf"
  /** No answer, a timeout, a 5xx or a non-https address. */
  | "unreachable"
  /** Any other answer. */
  | "unexpected";

export class VaultwardenError extends Error {
  constructor(
    readonly reason: VaultwardenFailure,
    readonly status?: number,
  ) {
    super(reason);
    this.name = "VaultwardenError";
  }
}

type CallOptions = Readonly<{
  json?: unknown;
  form?: Readonly<Record<string, string>>;
  token?: string;
}>;

const requestMs = 30_000;

export type VaultClient = Readonly<{ fetch?: VaultFetch | undefined }>;

async function call(
  client: VaultClient,
  serverUrl: string,
  path: string,
  options: CallOptions = {},
): Promise<unknown> {
  if (!serverUrl.startsWith("https://"))
    throw new VaultwardenError("unreachable");
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
    // String concatenation keeps a path prefix of the server (…/vault).
    response = await (client.fetch ?? fetch)(
      serverUrl.replace(/\/+$/, "") + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      },
    );
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
    if (
      path === "/identity/connect/token" ||
      /username or password is incorrect|invalid_grant/i.test(message)
    )
      throw new VaultwardenError("invalid-credentials", response.status);
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
  const token = await call(
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
  await call(client, options.serverUrl, "/identity/accounts/register/finish", {
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
  });
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
  const prelogin = (await call(
    client,
    serverUrl,
    "/identity/accounts/prelogin",
    {
      json: { email },
    },
  )) as Record<string, unknown> | null;
  if (prelogin?.kdf !== KDF_PBKDF2_SHA256)
    throw new VaultwardenError("unsupported-kdf");
  const iterations = prelogin.kdfIterations;
  if (
    typeof iterations !== "number" ||
    !Number.isSafeInteger(iterations) ||
    iterations < 5_000 ||
    iterations > 10_000_000
  )
    throw new VaultwardenError("unsupported-kdf");
  const masterKey = await deriveMasterKey(password, email, iterations);
  const masterPasswordHash = await makeMasterPasswordHash(masterKey, password);
  const token = (await call(client, serverUrl, "/identity/connect/token", {
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
  })) as Record<string, unknown> | null;
  const accessToken = token?.access_token;
  if (typeof accessToken !== "string") throw new VaultwardenError("unexpected");
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
  return { serverUrl, email, userId, accessToken, masterPasswordHash };
}

/** The personal API key for BW_CLIENTID / BW_CLIENTSECRET: created on the
 * first call, then stable. */
export async function fetchApiKey(
  client: VaultClient,
  login: Login,
): Promise<Readonly<{ clientId: string; clientSecret: string }>> {
  const result = (await call(client, login.serverUrl, "/api/accounts/api-key", {
    token: login.accessToken,
    json: { masterPasswordHash: login.masterPasswordHash },
  })) as Record<string, unknown> | null;
  const secret = result?.apiKey;
  if (typeof secret !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(secret))
    throw new VaultwardenError("unexpected");
  return { clientId: `user.${login.userId}`, clientSecret: secret };
}
