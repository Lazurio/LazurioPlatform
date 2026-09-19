import type { Key } from "@tufjs/models";
import { PublishError } from "./errors";
import type { RoleName, Signer } from "./keys";
import {
  buildRoot,
  defaultLifetimeDays,
  expiryAfter,
  parseMetadata,
  verifiesUnder,
} from "./metadata";

/** Root metadata is made OFFLINE by the holder of the root key
 * (docs/release-keys.md); these functions are what `scripts/release-keys.ts`
 * runs there. The publishing workflows only ever install the result.
 */
export type RoleKeys = Readonly<Record<RoleName, readonly Key[]>>;

/** Root version 1, signed by the root key it names. */
export function initialRoot(input: {
  keys: RoleKeys;
  rootSigner: Signer;
  now: Date;
  lifetimeDays?: number;
}): Buffer {
  if (!input.keys.root.some((key) => key.keyID === input.rootSigner.key.keyID))
    throw new PublishError("key-unauthorized", "root");
  return buildRoot({
    version: 1,
    expires: expiryAfter(
      input.now,
      input.lifetimeDays ?? defaultLifetimeDays.root,
    ),
    keys: input.keys,
    signers: [input.rootSigner],
  });
}

/** Root N+1. It is signed by the outgoing root key(s) — so every installation
 * that trusts root N accepts it — and by the incoming ones it names. The same
 * call with unchanged keys renews an expiring root. The result is verified
 * exactly as a client will verify it before it is returned.
 */
export function nextRoot(input: {
  current: Uint8Array;
  keys: RoleKeys;
  /** Outgoing and incoming root signers; one signer when the key stays. */
  rootSigners: readonly Signer[];
  now: Date;
  lifetimeDays?: number;
}): Buffer {
  const current = parseMetadata("root", input.current);
  if (!verifiesUnder(current, "root", current))
    throw new PublishError("root-chain", "current root does not verify");
  const unique = new Map(
    input.rootSigners.map((signer) => [signer.key.keyID, signer]),
  );
  const bytes = buildRoot({
    version: current.signed.version + 1,
    expires: expiryAfter(
      input.now,
      input.lifetimeDays ?? defaultLifetimeDays.root,
    ),
    keys: input.keys,
    signers: [...unique.values()],
  });
  const next = parseMetadata("root", bytes);
  if (!verifiesUnder(current, "root", next))
    throw new PublishError("root-chain", "outgoing root key missing");
  if (!verifiesUnder(next, "root", next))
    throw new PublishError("root-chain", "incoming root key missing");
  return bytes;
}

/** The keys a root names for each role, to carry unchanged roles over. */
export function rootRoleKeys(rootBytes: Uint8Array): RoleKeys {
  const root = parseMetadata("root", rootBytes).signed;
  const keysOf = (role: RoleName) =>
    (root.roles[role]?.keyIDs ?? []).map((id) => {
      const key = root.keys[id];
      if (!key) throw new PublishError("repository-invalid", "root keys");
      return key;
    });
  return {
    root: keysOf("root"),
    targets: keysOf("targets"),
    snapshot: keysOf("snapshot"),
    timestamp: keysOf("timestamp"),
  };
}
