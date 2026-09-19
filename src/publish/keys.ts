import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { Key, Signature } from "@tufjs/models";
import { PublishError } from "./errors";

/** The four top-level TUF roles; the repository uses no delegations. */
export const roleNames = ["root", "targets", "snapshot", "timestamp"] as const;
export type RoleName = (typeof roleNames)[number];

export function isRoleName(value: unknown): value is RoleName {
  return (roleNames as readonly unknown[]).includes(value);
}

/** A private key in memory together with the public TUF key it answers for.
 * Nothing in this module logs, prints or serializes `secret`; the only export
 * of private material is `privateKeyPem`, called by the key tool when it
 * writes a new key file.
 */
export type Signer = Readonly<{ key: Key; secret: KeyObject }>;

/** Public half as it appears in root metadata and in `<role>.public.json`. */
export type PublicKeyDocument = Readonly<{
  schemaVersion: 1;
  keyid: string;
  keytype: "ed25519";
  scheme: "ed25519";
  keyval: Readonly<{ public: string }>;
}>;

/** Raw 32-byte Ed25519 public key as hex, the TUF specification's `keyval`
 * form. The SubjectPublicKeyInfo of Ed25519 is a fixed 12-byte prefix followed
 * by the key.
 */
function publicHex(secretOrPublic: KeyObject): string {
  const spki = createPublicKey(secretOrPublic).export({
    type: "spki",
    format: "der",
  });
  if (spki.length !== 44) throw new PublishError("key-invalid");
  return spki.subarray(12).toString("hex");
}

/** Deterministic and unique per key: SHA-256 of the raw public key. The pinned
 * client never recomputes a key id; it only matches ids inside one root.
 */
const keyIdOf = (hex: string) =>
  createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

function tufKey(hex: string, keyId = keyIdOf(hex)): Key {
  return new Key({
    keyID: keyId,
    keyType: "ed25519",
    scheme: "ed25519",
    keyVal: { public: hex },
  });
}

function signerOf(secret: KeyObject, keyId?: string): Signer {
  if (secret.type !== "private" || secret.asymmetricKeyType !== "ed25519")
    throw new PublishError("key-invalid");
  return Object.freeze({ secret, key: tufKey(publicHex(secret), keyId) });
}

/** A fresh Ed25519 key. `keyId` overrides the derived id (fixtures only). */
export function generateSigner(keyId?: string): Signer {
  return signerOf(generateKeyPairSync("ed25519").privateKey, keyId);
}

/** Load a PKCS#8 PEM private key. A refusal never echoes the input. */
export function signerFromPem(pem: string): Signer {
  let secret: KeyObject;
  try {
    secret = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new PublishError("key-invalid");
  }
  return signerOf(secret);
}

export function privateKeyPem(signer: Signer): string {
  return signer.secret.export({ type: "pkcs8", format: "pem" }).toString();
}

export function publicKeyDocument(signer: Signer): PublicKeyDocument {
  return Object.freeze({
    schemaVersion: 1,
    keyid: signer.key.keyID,
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: Object.freeze({ public: signer.key.keyVal.public as string }),
  });
}

/** Parse `<role>.public.json`; the key id must be the derived one, so a
 * document can never bind a foreign id to a key.
 */
export function keyFromDocument(value: unknown): Key {
  const record = value as Partial<PublicKeyDocument> | null;
  const hex = record?.keyval?.public;
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== 1 ||
    record.keytype !== "ed25519" ||
    record.scheme !== "ed25519" ||
    typeof hex !== "string" ||
    !/^[0-9a-f]{64}$/.test(hex) ||
    record.keyid !== keyIdOf(hex)
  )
    throw new PublishError("key-invalid");
  return tufKey(hex);
}

export function signatureOf(signer: Signer, bytes: Buffer): Signature {
  return new Signature({
    keyID: signer.key.keyID,
    sig: sign(null, bytes, signer.secret).toString("hex"),
  });
}
