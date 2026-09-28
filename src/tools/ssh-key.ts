import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { signInLabel, type ToolProcessResult } from "./status";

/** The SSH key of this Machine on the signed-in GitHub account (decision
 * F19, addendum 2026-09-28). The curated gh sign-in ends with a Machine that
 * can `git clone git@github.com:…` as the signed-in account: a key pair in
 * the default place, its public key registered on the account as an
 * authentication key, GitHub's published host keys in `known_hosts`, and the
 * greeting of `ssh -T git@github.com` naming the account. Nothing here ever
 * returns, logs or shows private key content; the only key facts that leave
 * this module are the path of the key and its public SHA-256 fingerprint. */

/** The scope that lets gh list, add and delete the account's SSH keys. */
export const sshKeyScope = "admin:public_key";

/** What makes a registered key Lazurio's: the title it was registered with.
 * Sign-out removes only a key of this Machine whose title starts so. */
export const sshKeyTitlePrefix = "Lazurio: ";

// The default key names Lazurio considers, in order. ed25519 first: it is the
// key Lazurio creates. Hardware-backed keys (`_sk`) need a touch and cannot
// be used unattended; DSA is no longer accepted by GitHub.
const keyNames = ["id_ed25519", "id_ecdsa", "id_rsa"] as const;

export type SshKeyFacts = Readonly<{
  /** The private key's path; the file itself is never read by Lazurio. */
  path: string;
  /** `SHA256:…`, as GitHub shows it in the account's settings. */
  fingerprint: string;
  /** Lazurio created the key pair in this run. */
  created: boolean;
}>;

export type SshLinkFailure =
  | "not-signed-in"
  | "scope-missing"
  | "keygen-missing"
  | "keygen-failed"
  | "key-passphrase"
  | "key-incomplete"
  | "key-unreadable"
  | "key-in-use"
  | "register-failed"
  | "host-keys-unavailable"
  | "host-key-mismatch"
  | "known-hosts-failed"
  | "ssh-missing"
  | "proof-failed"
  | "proof-other-account";

export const sshLinkFailures: readonly SshLinkFailure[] = [
  "not-signed-in",
  "scope-missing",
  "keygen-missing",
  "keygen-failed",
  "key-passphrase",
  "key-incomplete",
  "key-unreadable",
  "key-in-use",
  "register-failed",
  "host-keys-unavailable",
  "host-key-mismatch",
  "known-hosts-failed",
  "ssh-missing",
  "proof-failed",
  "proof-other-account",
];

/** The outcome of linking: linked only after the SSH greeting named the
 * signed-in account; otherwise the reason and the agent as the next step. */
export type SshLink =
  | Readonly<{
      state: "linked";
      key: SshKeyFacts;
      /** The public key was added now, or the account had it already. */
      registration: "added" | "already-registered";
      /** Published host keys added to `known_hosts` now, or all present. */
      knownHosts: "added" | "present";
    }>
  | Readonly<{
      state: "not-linked";
      reason: SshLinkFailure;
      key?: SshKeyFacts;
      /** The login GitHub greeted over SSH when it is another account. */
      provedAs?: string;
      fallback: "agent";
    }>;

/** The SSH part of gh's sign-in probe: cheap, one API call, and only when
 * the sign-in probes run at all. */
export type SshStatus = Readonly<{
  state: "linked" | "not-linked" | "unknown";
  reason?: "no-key" | "not-registered" | "scope-missing" | "unreadable";
  fingerprint?: string;
}>;

/** What sign-out did with this Machine's key on the account. */
export type SshKeyRemoval = Readonly<{
  state:
    | "removed"
    | "not-registered"
    | "no-key"
    | "kept-not-lazurio"
    | "not-removed";
  reason?: "scope-missing" | "tool-exit" | "unreadable";
  fingerprint?: string;
}>;

export type SshRunner = (
  command: readonly string[],
  timeoutMs: number,
) => Promise<ToolProcessResult>;

export type SshContext = Readonly<{
  home: string;
  gh: string;
  /** `ssh-keygen` and `ssh` as found on the PATH, when they are. */
  keygen: string | undefined;
  ssh: string | undefined;
  run: SshRunner;
  /** False once the owner of the run ended it (cancel, expiry, shutdown). */
  alive: () => boolean;
  machine: string;
}>;

const stepTimeoutMs = 30_000;

// "type base64" of a public key line, when it is one.
export function publicKeyOf(line: string): string | undefined {
  const [type, blob] = line.trim().split(/\s+/);
  if (
    type === undefined ||
    blob === undefined ||
    !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-[a-z0-9@.-]+)$/.test(
      type,
    ) ||
    !/^[A-Za-z0-9+/]+={0,3}$/.test(blob)
  )
    return undefined;
  return `${type} ${blob}`;
}

/** `SHA256:…` of a public key, as `ssh-keygen -l` and GitHub print it. */
export function fingerprintOf(publicKey: string): string {
  const blob = publicKey.split(" ")[1] ?? "";
  return `SHA256:${createHash("sha256")
    .update(Buffer.from(blob, "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;
}

/** The title a key is registered with: Lazurio and the Machine's name. */
export function sshKeyTitle(machine: string): string {
  return `${sshKeyTitlePrefix}${machine}`;
}

/** The Machine's name for a key title: the host name of the system, which is
 * no secret, reduced to letters, digits, dot, dash and underscore. */
export function machineName(raw: string = hostname()): string {
  const name = raw
    .replace(/\.local$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 63);
  return name.length === 0 ? "machine" : name;
}

/** The token scopes of the active github.com account from the output of
 * `gh auth status --hostname github.com` ("- Token scopes: 'gist', …");
 * undefined when the output names none. */
export function ghTokenScopes(output: string): readonly string[] | undefined {
  const lines = output.split(/\r?\n/);
  const first = lines.findIndex((line) =>
    /Logged in to github\.com (?:account|as) /.test(line),
  );
  if (first === -1) return undefined;
  for (const line of lines.slice(first + 1)) {
    if (/Logged in to |Failed to log in /.test(line)) break;
    const match = /Token scopes:\s*(.*)$/.exec(line);
    if (match) {
      const listed = [...(match[1] ?? "").matchAll(/'([^']+)'/g)].map(
        (entry) => entry[1] as string,
      );
      return listed;
    }
  }
  return undefined;
}

const canManageKeys = (scopes: readonly string[] | undefined) =>
  scopes?.includes(sshKeyScope) === true;
const canReadKeys = (scopes: readonly string[] | undefined) =>
  scopes !== undefined &&
  ["admin:public_key", "write:public_key", "read:public_key"].some((scope) =>
    scopes.includes(scope),
  );

type LocalKey = Readonly<{
  name: (typeof keyNames)[number];
  privatePath: string;
  publicPath: string;
  /** "type base64" of the `.pub` file, when it has one. */
  publicKey: string | undefined;
}>;

const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** This Machine's key: the first default name that has a private key or a
 * public file, in the order ed25519, ecdsa, rsa. Only the `.pub` file is
 * read; a public file without its private key has no usable public key. */
export async function machineKey(home: string): Promise<LocalKey | undefined> {
  const directory = join(home, ".ssh");
  for (const name of keyNames) {
    const privatePath = join(directory, name);
    const publicPath = `${privatePath}.pub`;
    if (!(await exists(privatePath))) {
      // A public file without its private key: the name is taken. Creating
      // a key under it would overwrite that file, so it counts as a key
      // that is incomplete, and nothing is created beside or over it.
      if (await exists(publicPath))
        return { name, privatePath, publicPath, publicKey: undefined };
      continue;
    }
    let publicKey: string | undefined;
    try {
      const info = await stat(publicPath);
      if (info.isFile() && info.size <= 64 * 1024)
        publicKey = publicKeyOf(await readFile(publicPath, "utf8"));
    } catch {}
    return { name, privatePath, publicPath, publicKey };
  }
  return undefined;
}

// The account's authentication keys as `{ id, key, title }`, or undefined.
async function accountKeys(
  run: SshRunner,
  gh: string,
  timeoutMs = stepTimeoutMs,
): Promise<
  readonly Readonly<{ id: number; key: string; title: string }>[] | undefined
> {
  let result: ToolProcessResult;
  try {
    result = await run(
      [gh, "api", "user/keys?per_page=100", "--jq", "[.[] | {id, key, title}]"],
      timeoutMs,
    );
  } catch {
    return undefined;
  }
  if (result === "timeout" || result.exitCode !== 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const keys: { id: number; key: string; title: string }[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { id, key, title } = entry as Record<string, unknown>;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof key !== "string"
    )
      return undefined;
    const publicKey = publicKeyOf(key);
    if (publicKey === undefined) continue;
    keys.push({
      id,
      key: publicKey,
      title: typeof title === "string" ? title : "",
    });
  }
  return keys;
}

/** The SSH part of gh's sign-in probe, from the probe's own output and one
 * API call; the private key is not read and nothing connects over SSH. */
export async function sshStatus(
  home: string | undefined,
  gh: string,
  probeOutput: string,
  run: SshRunner,
): Promise<SshStatus> {
  if (home === undefined) return { state: "unknown", reason: "unreadable" };
  const key = await machineKey(home);
  if (key === undefined || key.publicKey === undefined)
    return { state: "not-linked", reason: "no-key" };
  const fingerprint = fingerprintOf(key.publicKey);
  if (!canReadKeys(ghTokenScopes(probeOutput)))
    return { state: "unknown", reason: "scope-missing", fingerprint };
  const keys = await accountKeys(run, gh, 10_000);
  if (keys === undefined)
    return { state: "unknown", reason: "unreadable", fingerprint };
  return keys.some((entry) => entry.key === key.publicKey)
    ? { state: "linked", fingerprint }
    : { state: "not-linked", reason: "not-registered", fingerprint };
}

/** The signed-in account and its token scopes, read with gh's own status. */
export async function ghAccount(
  run: SshRunner,
  gh: string,
): Promise<
  | Readonly<{ account: string; scopes: readonly string[] | undefined }>
  | undefined
> {
  let result: ToolProcessResult;
  try {
    result = await run(
      [gh, "auth", "status", "--hostname", "github.com"],
      stepTimeoutMs,
    );
  } catch {
    return undefined;
  }
  if (result === "timeout" || result.exitCode !== 0) return undefined;
  const output = `${result.stdout}\n${result.stderr}`;
  const account = signInLabel(
    /Logged in to github\.com (?:account|as) ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/.exec(
      output,
    )?.[1],
  );
  if (account === undefined) return undefined;
  return { account, scopes: ghTokenScopes(output) };
}

export const hasKeyScope = canManageKeys;

type Failure = Extract<SshLink, { state: "not-linked" }>;
const failed = (
  reason: SshLinkFailure,
  extra: Partial<Pick<Failure, "key" | "provedAs">> = {},
): Failure => ({ state: "not-linked", reason, ...extra, fallback: "agent" });

// Step 2: the key pair. An existing default key is used as it is, never
// overwritten or changed; without one an ed25519 key without a passphrase is
// created, so agents can use it unattended.
async function ensureKey(
  context: SshContext,
): Promise<{ key: SshKeyFacts; publicPath: string } | Failure | "gone"> {
  const existing = await machineKey(context.home);
  if (existing !== undefined) {
    if (existing.publicKey === undefined) return failed("key-incomplete");
    if (context.keygen === undefined) return failed("keygen-missing");
    // Derives the public key from the private one without a passphrase: this
    // proves the pair belongs together and needs no passphrase. Only the
    // public key comes back.
    let derived: ToolProcessResult;
    try {
      derived = await context.run(
        [context.keygen, "-y", "-P", "", "-f", existing.privatePath],
        stepTimeoutMs,
      );
    } catch {
      return failed("key-unreadable");
    }
    if (!context.alive()) return "gone";
    const facts: SshKeyFacts = {
      path: existing.privatePath,
      fingerprint: fingerprintOf(existing.publicKey),
      created: false,
    };
    if (derived === "timeout") return failed("key-unreadable", { key: facts });
    if (derived.exitCode !== 0)
      return failed(
        /passphrase/i.test(derived.stderr)
          ? "key-passphrase"
          : "key-unreadable",
        { key: facts },
      );
    if (publicKeyOf(derived.stdout) !== existing.publicKey)
      return failed("key-incomplete", { key: facts });
    return { key: facts, publicPath: existing.publicPath };
  }
  if (context.keygen === undefined) return failed("keygen-missing");
  const directory = join(context.home, ".ssh");
  try {
    if (!(await exists(directory))) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  } catch {
    return failed("keygen-failed");
  }
  const privatePath = join(directory, "id_ed25519");
  let created: ToolProcessResult;
  try {
    // ssh-keygen itself refuses to overwrite a file that appeared meanwhile:
    // it would ask, and its standard input is empty.
    created = await context.run(
      [
        context.keygen,
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `lazurio@${context.machine}`,
        "-f",
        privatePath,
      ],
      stepTimeoutMs,
    );
  } catch {
    return failed("keygen-failed");
  }
  if (!context.alive()) return "gone";
  if (created === "timeout" || created.exitCode !== 0)
    return failed("keygen-failed");
  const made = await machineKey(context.home);
  if (
    made === undefined ||
    made.privatePath !== privatePath ||
    made.publicKey === undefined
  )
    return failed("keygen-failed");
  try {
    const mode = (await stat(privatePath)).mode & 0o777;
    if ((mode & 0o077) !== 0) await chmod(privatePath, 0o600);
  } catch {
    return failed("keygen-failed");
  }
  return {
    key: {
      path: privatePath,
      fingerprint: fingerprintOf(made.publicKey),
      created: true,
    },
    publicPath: made.publicPath,
  };
}

/** GitHub's published SSH host keys (`gh api meta`, `ssh_keys`), each as
 * "type base64", or undefined when the answer is not exactly that. */
export function publishedHostKeys(
  stdout: string,
): readonly string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    return undefined;
  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const key = publicKeyOf(entry);
    if (key === undefined || key !== entry.trim()) return undefined;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The github.com entries `ssh-keygen -F github.com` found: their keys, and
 * whether any is not a plain entry (a marker such as `@revoked`). */
export function knownHostEntries(
  stdout: string,
): Readonly<{ keys: readonly string[]; marked: boolean }> {
  const keys: string[] = [];
  let marked = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0]?.startsWith("@")) {
      marked = true;
      continue;
    }
    const key = publicKeyOf(fields.slice(1).join(" "));
    if (key === undefined) marked = true;
    else keys.push(key);
  }
  return { keys, marked };
}

// Step 4: GitHub's published host keys in the user's known_hosts. Only
// missing entries are added; an entry that differs stops everything, and
// nothing is replaced or accepted.
async function ensureKnownHosts(
  context: SshContext,
): Promise<"added" | "present" | Failure | "gone"> {
  let meta: ToolProcessResult;
  try {
    meta = await context.run(
      [context.gh, "api", "meta", "--jq", ".ssh_keys"],
      stepTimeoutMs,
    );
  } catch {
    return failed("host-keys-unavailable");
  }
  if (!context.alive()) return "gone";
  const published =
    meta === "timeout" || meta.exitCode !== 0
      ? undefined
      : publishedHostKeys(meta.stdout);
  if (published === undefined) return failed("host-keys-unavailable");
  if (context.keygen === undefined) return failed("keygen-missing");
  const file = join(context.home, ".ssh", "known_hosts");
  let present: readonly string[] = [];
  if (await exists(file)) {
    let found: ToolProcessResult;
    try {
      // Finds plain and hashed entries alike.
      found = await context.run(
        [context.keygen, "-F", "github.com", "-f", file],
        stepTimeoutMs,
      );
    } catch {
      return failed("known-hosts-failed");
    }
    if (!context.alive()) return "gone";
    if (found === "timeout" || (found.exitCode !== 0 && found.exitCode !== 1))
      return failed("known-hosts-failed");
    const entries = knownHostEntries(found.stdout);
    if (entries.marked || entries.keys.some((key) => !published.includes(key)))
      return failed("host-key-mismatch");
    present = entries.keys;
  }
  const missing = published.filter((key) => !present.includes(key));
  if (missing.length === 0) return "present";
  try {
    const directory = join(context.home, ".ssh");
    if (!(await exists(directory))) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    let prefix = "";
    if (await exists(file)) {
      const current = await readFile(file);
      if (current.length > 0 && current[current.length - 1] !== 0x0a)
        prefix = "\n";
    }
    await appendFile(
      file,
      `${prefix}${missing.map((key) => `github.com ${key}`).join("\n")}\n`,
      { mode: 0o600 },
    );
  } catch {
    return failed("known-hosts-failed");
  }
  return "added";
}

/** The login GitHub greets over SSH ("Hi <login>! You've successfully
 * authenticated…"), when it does. */
export function sshGreeting(output: string): string | undefined {
  return /^Hi ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))! You've successfully authenticated/m.exec(
    output,
  )?.[1];
}

/** Steps 2 to 5 for a gh signed in as `account` with the key scope: the key
 * pair, its registration, the host keys and the proof. `gone` when the owner
 * ended the run meanwhile. */
export async function linkSshKey(
  context: SshContext,
  account: string,
): Promise<SshLink | "gone"> {
  const ensured = await ensureKey(context);
  if (ensured === "gone" || !context.alive()) return "gone";
  if ("state" in ensured) return ensured;
  const { key, publicPath } = ensured;
  // Step 3: gh's own command, which adds nothing when the account has the key.
  let added: ToolProcessResult;
  try {
    added = await context.run(
      [
        context.gh,
        "ssh-key",
        "add",
        publicPath,
        "--title",
        sshKeyTitle(context.machine),
        "--type",
        "authentication",
      ],
      stepTimeoutMs,
    );
  } catch {
    return failed("register-failed", { key });
  }
  if (!context.alive()) return "gone";
  if (added === "timeout") return failed("register-failed", { key });
  const addOutput = `${added.stdout}\n${added.stderr}`;
  if (added.exitCode !== 0)
    return failed(
      /key is already in use/i.test(addOutput)
        ? "key-in-use"
        : /admin:public_key|write:public_key/.test(addOutput)
          ? "scope-missing"
          : "register-failed",
      { key },
    );
  const registration = /already exists/i.test(addOutput)
    ? "already-registered"
    : "added";
  const knownHosts = await ensureKnownHosts(context);
  if (knownHosts === "gone" || !context.alive()) return "gone";
  if (typeof knownHosts === "object") return { ...knownHosts, key };
  // Step 5: the proof, as `git clone git@github.com:…` would connect.
  if (context.ssh === undefined) return failed("ssh-missing", { key });
  let proof: ToolProcessResult;
  try {
    proof = await context.run(
      [
        context.ssh,
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=15",
        "git@github.com",
      ],
      stepTimeoutMs,
    );
  } catch {
    return failed("proof-failed", { key });
  }
  if (!context.alive()) return "gone";
  if (proof === "timeout") return failed("proof-failed", { key });
  const greeted = sshGreeting(`${proof.stdout}\n${proof.stderr}`);
  if (greeted === undefined) return failed("proof-failed", { key });
  if (greeted.toLowerCase() !== account.toLowerCase())
    return failed("proof-other-account", { key, provedAs: greeted });
  return { state: "linked", key, registration, knownHosts };
}

/** Before `gh auth logout`: removes this Machine's key from the account when
 * Lazurio registered it (its title starts with the Lazurio marker) and the
 * token allows it. A key the operator registered by hand stays. */
export async function removeSshKey(
  context: Pick<SshContext, "home" | "gh" | "run">,
): Promise<SshKeyRemoval> {
  const key = await machineKey(context.home);
  if (key === undefined || key.publicKey === undefined)
    return { state: "no-key" };
  const fingerprint = fingerprintOf(key.publicKey);
  const signedIn = await ghAccount(context.run, context.gh);
  if (signedIn === undefined)
    return { state: "not-removed", reason: "unreadable", fingerprint };
  if (!canManageKeys(signedIn.scopes))
    return { state: "not-removed", reason: "scope-missing", fingerprint };
  const keys = await accountKeys(context.run, context.gh);
  if (keys === undefined)
    return { state: "not-removed", reason: "unreadable", fingerprint };
  const registered = keys.filter((entry) => entry.key === key.publicKey);
  if (registered.length === 0) return { state: "not-registered", fingerprint };
  const ours = registered.filter((entry) =>
    entry.title.startsWith(sshKeyTitlePrefix),
  );
  if (ours.length === 0) return { state: "kept-not-lazurio", fingerprint };
  for (const entry of ours) {
    let result: ToolProcessResult;
    try {
      result = await context.run(
        [context.gh, "ssh-key", "delete", String(entry.id), "--yes"],
        stepTimeoutMs,
      );
    } catch {
      return { state: "not-removed", reason: "tool-exit", fingerprint };
    }
    if (result === "timeout" || result.exitCode !== 0)
      return { state: "not-removed", reason: "tool-exit", fingerprint };
  }
  return { state: "removed", fingerprint };
}
