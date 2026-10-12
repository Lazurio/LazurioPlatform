import {
  type ComputerAnswer,
  computerSettings,
  readHostKey,
  type SshAccessHost,
} from "./host";
import {
  addDeviceKey,
  addedByLabel,
  deviceName,
  type FileRefusal,
  type KeyRefusal,
  type ListedKey,
  listKeys,
  parseDeviceKey,
  type RemoveKeyResult,
  removeDeviceKey,
} from "./keys";

// Settings → SSH from your devices (decision F49), one use case for the
// Launchpad's routes: the keys of this account, the settings a computer
// writes, adding a device's key and removing one the Launchpad added.

/** What the section shows. `keys` is null when the file cannot be read
 * here (`problem` says why) and on Windows, which this does not handle. */
export type SshAccessOverview = Readonly<{
  kind: "ssh-access";
  supported: boolean;
  keys: readonly ListedKey[] | null;
  problem: FileRefusal | null;
  computer: ComputerAnswer;
}>;

const supported = (host: SshAccessHost) => host.platform !== "win32";

/** The settings a computer writes, read live. */
export async function computerOf(host: SshAccessHost): Promise<ComputerAnswer> {
  const [tailnet, hostKey] = await Promise.all([
    host.tailnet(),
    readHostKey(host.hostKeyPath),
  ]);
  return computerSettings({ user: host.user, tailnet, hostKey });
}

export async function sshAccessOverview(
  host: SshAccessHost,
): Promise<SshAccessOverview> {
  if (!supported(host))
    return {
      kind: "ssh-access",
      supported: false,
      keys: null,
      problem: null,
      computer: await computerOf(host),
    };
  const [listed, computer] = await Promise.all([
    listKeys(host),
    computerOf(host),
  ]);
  return {
    kind: "ssh-access",
    supported: true,
    keys: "keys" in listed ? listed.keys : null,
    problem: "refused" in listed ? listed.refused : null,
    computer,
  };
}

/** Why adding a device is refused: what was sent, or the file. */
export type AddRefusal =
  | KeyRefusal
  | "invalid-name"
  | "invalid-added-by"
  | FileRefusal
  | "unsupported-platform";

export type AddAnswer =
  | Readonly<{
      kind: "ssh-key-added";
      outcome: "added" | "already-present";
      key: ListedKey;
      computer: ComputerAnswer;
    }>
  | Readonly<{ kind: "blocked"; reason: AddRefusal }>;

/** Refusals of what was sent, as opposed to the state of the file. */
export const inputRefusals: ReadonlySet<AddRefusal> = new Set<AddRefusal>([
  "key-missing",
  "private-key",
  "multiple-lines",
  "options-not-allowed",
  "unsupported-type",
  "invalid-key",
  "not-a-public-key",
  "invalid-name",
  "invalid-added-by",
]);

/** Adds a device's key: its name, its one public key line and, when the
 * page knows it, the login of the Lazurio account that is signed in there. */
export async function addDevice(
  host: SshAccessHost,
  input: Readonly<{ device: unknown; publicKey: unknown; addedBy: unknown }>,
): Promise<AddAnswer> {
  const key = parseDeviceKey(input.publicKey);
  if ("refused" in key) return { kind: "blocked", reason: key.refused };
  const device = deviceName(input.device);
  if (device === null) return { kind: "blocked", reason: "invalid-name" };
  const addedBy = addedByLabel(input.addedBy);
  if (addedBy === null) return { kind: "blocked", reason: "invalid-added-by" };
  if (!supported(host))
    return { kind: "blocked", reason: "unsupported-platform" };
  const result = await addDeviceKey(host, {
    key,
    device,
    addedBy,
    date: host.today(),
  });
  if (result.kind === "blocked") return result;
  return { ...result, computer: await computerOf(host) };
}

/** Removes a key the Launchpad added, by its fingerprint. */
export async function removeDevice(
  host: SshAccessHost,
  fingerprint: string,
): Promise<
  | RemoveKeyResult
  | Readonly<{ kind: "blocked"; reason: "unsupported-platform" }>
> {
  if (!supported(host))
    return { kind: "blocked", reason: "unsupported-platform" };
  return removeDeviceKey(host, fingerprint);
}
