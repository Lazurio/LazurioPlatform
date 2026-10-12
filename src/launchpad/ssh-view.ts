import type { SshAccessOverview } from "../ssh-access/access";
import type { ComputerAnswer, ComputerMissing } from "../ssh-access/host";
import type { FileRefusal, ListedKey } from "../ssh-access/keys";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

// Settings → SSH from your devices (decision F49), the page's pure part:
// what the server's answers say, in the page's words, and the prompt the
// person gives the agent on their own computer. `ssh-panel.ts` draws it.

type Copy = Readonly<Record<MessageKey, string>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length <= max;
const nullableText = (value: unknown, max = 512): value is string | null =>
  value === null || text(value, max);

function parseKey(value: unknown): ListedKey | null {
  if (!isRecord(value)) return null;
  if (value.origin === "launchpad") {
    if (
      !text(value.type, 64) ||
      !text(value.fingerprint, 64) ||
      !text(value.device, 40) ||
      !text(value.addedBy, 39) ||
      !text(value.added, 10)
    )
      return null;
    return value as ListedKey;
  }
  if (
    value.origin === "outside" &&
    nullableText(value.type, 64) &&
    nullableText(value.fingerprint, 64) &&
    nullableText(value.comment, 100)
  )
    return value as ListedKey;
  return null;
}

/** The computer's settings in an answer, or null when it has none. */
export function parseComputer(value: unknown): ComputerAnswer | null {
  if (!isRecord(value)) return null;
  if (
    value.state === "ready" &&
    text(value.alias, 63) &&
    text(value.keyPath, 128) &&
    text(value.config, 2048) &&
    text(value.knownHosts, 1024)
  )
    return value as ComputerAnswer;
  if (
    value.state === "unavailable" &&
    Array.isArray(value.missing) &&
    value.missing.every((entry) => text(entry, 64))
  )
    return value as ComputerAnswer;
  return null;
}

/** `GET /api/ssh`'s answer, or null when it is not one. */
export function parseSshOverview(value: unknown): SshAccessOverview | null {
  if (!isRecord(value) || value.kind !== "ssh-access") return null;
  if (typeof value.supported !== "boolean") return null;
  const computer = parseComputer(value.computer);
  if (computer === null) return null;
  let keys: ListedKey[] | null = null;
  if (value.keys !== null) {
    if (!Array.isArray(value.keys) || value.keys.length > 1000) return null;
    keys = [];
    for (const entry of value.keys) {
      const key = parseKey(entry);
      if (key === null) return null;
      keys.push(key);
    }
  }
  if (!nullableText(value.problem, 64)) return null;
  return {
    kind: "ssh-access",
    supported: value.supported,
    keys,
    problem: value.problem as FileRefusal | null,
    computer,
  };
}

const problemKeys: Readonly<Record<string, MessageKey>> = {
  "ssh-directory-unsafe": "sshProblemDirectory",
  "authorized-keys-symlink": "sshProblemSymlink",
  "authorized-keys-not-file": "sshProblemNotFile",
  "authorized-keys-foreign-owner": "sshProblemForeignOwner",
  "authorized-keys-too-large": "sshProblemTooLarge",
};

/** Why the keys cannot be read or written here. */
export function problemText(reason: string, copy: Copy): string {
  const key = problemKeys[reason];
  return key === undefined ? copy.sshAddFailed : copy[key];
}

const refusalKeys: Readonly<Record<string, MessageKey>> = {
  "key-missing": "sshRefusedKeyMissing",
  "private-key": "sshRefusedPrivateKey",
  "multiple-lines": "sshRefusedMultipleLines",
  "options-not-allowed": "sshRefusedOptions",
  "unsupported-type": "sshRefusedType",
  "invalid-key": "sshRefusedInvalidKey",
  "not-a-public-key": "sshRefusedNotKey",
  "invalid-name": "sshRefusedName",
  "invalid-added-by": "sshRefusedAddedBy",
  "key-restricted-outside": "sshRefusedKeyRestricted",
  "unsupported-platform": "sshUnsupported",
};

/** Which field a refusal of "Add device" belongs to. */
export type RefusalField = "device" | "publicKey" | "form";

/** What a refused "Add device" says, and beside which field. */
export function addRefusal(
  reason: unknown,
  copy: Copy,
): Readonly<{ field: RefusalField; text: string }> {
  const name = typeof reason === "string" ? reason : "";
  const key = refusalKeys[name];
  if (key !== undefined)
    return {
      field:
        name === "invalid-name"
          ? "device"
          : name === "invalid-added-by" || name === "unsupported-platform"
            ? "form"
            : "publicKey",
      text: copy[key],
    };
  if (Object.hasOwn(problemKeys, name))
    return { field: "form", text: problemText(name, copy) };
  return { field: "form", text: copy.sshAddFailed };
}

/** What a refused "Remove" says. */
export function removeRefusal(reason: unknown, copy: Copy): string {
  if (reason === "not-found") return copy.sshRemoveNotFound;
  if (reason === "not-launchpad-key") return copy.sshRemoveNotOwn;
  if (reason === "unsupported-platform") return copy.sshUnsupported;
  if (typeof reason === "string" && Object.hasOwn(problemKeys, reason))
    return problemText(reason, copy);
  return copy.sshRemoveFailed;
}

const missingKeys: Readonly<Record<ComputerMissing, MessageKey>> = {
  "tailscale-missing": "sshMissingTailscale",
  "tailscale-failed": "sshMissingTailscaleFailed",
  "tailnet-not-running": "sshMissingNotRunning",
  "no-dns-name": "sshMissingDnsName",
  "host-key-missing": "sshMissingHostKey",
  "user-invalid": "sshMissingUser",
};

/** Each thing a computer's settings still lack, one sentence each. */
export function missingTexts(
  missing: readonly string[],
  copy: Copy,
): readonly string[] {
  return missing.map((reason) =>
    Object.hasOwn(missingKeys, reason)
      ? copy[missingKeys[reason as ComputerMissing]]
      : reason,
  );
}

/** One listed key in the page's words: its title, the facts under it, and
 * whether it may be removed here. */
export type KeyView = Readonly<{
  title: string;
  facts: readonly string[];
  fingerprint: string | null;
  removable: boolean;
}>;

export function keyView(key: ListedKey, copy: Copy): KeyView {
  if (key.origin === "launchpad")
    return {
      title: key.device,
      facts: [
        key.addedBy === "local"
          ? fill(copy.sshAddedLocal, { date: key.added })
          : fill(copy.sshAddedBy, { date: key.added, who: key.addedBy }),
        `${key.type} · ${key.fingerprint}`,
      ],
      fingerprint: key.fingerprint,
      removable: true,
    };
  if (key.fingerprint === null || key.type === null)
    return {
      title: copy.sshOutsideUnreadable,
      facts: [],
      fingerprint: null,
      removable: false,
    };
  return {
    title: key.comment ?? copy.sshOutsideUntitled,
    facts: [`${key.type} · ${key.fingerprint}`],
    fingerprint: key.fingerprint,
    removable: false,
  };
}

/** The keys in two groups: those the Launchpad added, in the file's order,
 * and those added outside it. */
export function keyGroups(keys: readonly ListedKey[]): Readonly<{
  devices: readonly ListedKey[];
  outside: readonly ListedKey[];
}> {
  return {
    devices: keys.filter((key) => key.origin === "launchpad"),
    outside: keys.filter((key) => key.origin === "outside"),
  };
}

/** The prompt the person gives the agent on their own computer: this
 * Environment's page, the key, the four steps, and the rules. */
export function sshPrompt(
  input: Readonly<{ url: string; alias: string; keyPath: string }>,
  copy: Copy,
): string {
  return fill(copy.sshPromptText, {
    url: input.url,
    alias: input.alias,
    keyPath: input.keyPath,
    windowsKeyPath: `%USERPROFILE%\\.ssh\\${input.alias}-ed25519`,
  });
}
