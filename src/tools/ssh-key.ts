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
import { ghStatus } from "./gh-status";
import type { ToolProcessResult } from "./status";

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

/** The SSH part of gh's sign-in probe (decision F19, addendum 2026-10-19,
 * #515): whether this Environment reaches GitHub over SSH as the signed-in
 * account, by the sign-in's own proof (`proveSsh`). `linked` only when the
 * proof passed; `not-linked` with `no-key`, `not-registered` (the account
 * does not list the key), `proof-failed` or `other-account` (ssh greeted
 * another login); `unknown` (`unreadable`) only when GitHub could not be
 * reached or read, or this home is not known. */
export type SshStatus = Readonly<{
  state: "linked" | "not-linked" | "unknown";
  reason?: SshStatusReason;
  fingerprint?: string;
}>;

export type SshStatusReason =
  | "no-key"
  | "not-registered"
  | "proof-failed"
  | "other-account"
  | "unreadable";

export const sshStatusReasons: readonly SshStatusReason[] = [
  "no-key",
  "not-registered",
  "proof-failed",
  "other-account",
  "unreadable",
];

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
  /** Asked before every step that writes (the key's creation, its
   * registration, `known_hosts`): false ends the run as `gone`, because its
   * owner refused it meanwhile (the Environment became a Team one). */
  proceed?: () => Promise<boolean>;
  machine: string;
}>;

const stepTimeoutMs = 30_000;

// Before a step that writes: the owner still wants the run.
const proceed = async (context: SshContext) =>
  (context.proceed === undefined || (await context.proceed())) &&
  context.alive();

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

/** `SHA256:…` of a public key, as `ssh-keygen -l` and GitHub print it.
 * Hashed with Bun's own SHA-256, not `node:crypto`: Settings → Nástroje's
 * page takes this module for its failure list, and an import of
 * `node:crypto` puts its browser stand-in, half a megabyte with
 * `node:stream` and `node:buffer`, into the page's script wherever Bun
 * bundles it for the browser (plan DEV-6656). Only the server calls it. */
export function fingerprintOf(publicKey: string): string {
  const blob = publicKey.split(" ")[1] ?? "";
  return `SHA256:${new Bun.CryptoHasher("sha256")
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

/** The SSH part of gh's sign-in probe (decision F19, addendum 2026-10-19,
 * #515): the sign-in's own proof, run only where it can pass, and kept by
 * `proofs` where the caller has them. Without a key, or with a key the
 * account does not list, nothing connects over SSH: it cannot work, and the
 * reason says why. A token that cannot read the account's keys leaves the
 * proof alone to decide. The private key is never read. */
export async function sshStatus(
  input: Readonly<{
    home: string | undefined;
    gh: string;
    /** The signed-in login, whose greeting the proof expects. */
    account: string | undefined;
    scopes: readonly string[] | undefined;
    keygen: string | undefined;
    ssh: string | undefined;
    run: SshRunner;
    /** Passing proofs kept for a while (`createSshProofs`); without them
     * every reading proves again. */
    proofs?: SshProofs | undefined;
  }>,
): Promise<SshStatus> {
  if (input.home === undefined)
    return { state: "unknown", reason: "unreadable" };
  const key = await machineKey(input.home);
  if (key === undefined || key.publicKey === undefined)
    return { state: "not-linked", reason: "no-key" };
  const fingerprint = fingerprintOf(key.publicKey);
  if (input.account === undefined)
    return { state: "unknown", reason: "unreadable", fingerprint };
  if (canReadKeys(input.scopes)) {
    const keys = await accountKeys(input.run, input.gh, statusStepMs);
    if (keys === undefined)
      return { state: "unknown", reason: "unreadable", fingerprint };
    if (!keys.some((entry) => entry.key === key.publicKey))
      return { state: "not-linked", reason: "not-registered", fingerprint };
  }
  const account = input.account;
  const prove = () =>
    proveSsh(
      {
        home: input.home as string,
        gh: input.gh,
        keygen: input.keygen,
        ssh: input.ssh,
        run: input.run,
        alive: () => true,
      },
      account,
      { timeoutMs: statusStepMs },
    ).then((proof) => (proof === "gone" ? unreachable : proof));
  const proof =
    input.proofs === undefined
      ? await prove()
      : await input.proofs.prove(fingerprint, account, prove);
  if (proof.state === "proved") return { state: "linked", fingerprint };
  if (proof.state === "unreachable")
    return { state: "unknown", reason: "unreadable", fingerprint };
  return {
    state: "not-linked",
    reason:
      proof.reason === "proof-other-account" ? "other-account" : "proof-failed",
    fingerprint,
  };
}

// Each step of the status's proof: 20 s, above ssh's own ConnectTimeout of
// 15 s; the sign-in gives each of its steps 30 s.
const statusStepMs = 20_000;
const unreachable: SshProof = {
  state: "unreachable",
  reason: "ssh-unreachable",
};

/** The proof (`proveSsh`), kept where it passed: per key and account, for a
 * bounded time, in the memory of the process that reads the status (the
 * Launchpad). A reading of the status is frequent (every load of the page,
 * Refresh status, the shell document's setup) and the proof is a network
 * round trip (GitHub's published keys over HTTPS, then an SSH connection),
 * so a passing proof is kept for `passMs` (5 minutes): a working link
 * changes only when its key, its account, GitHub's list of keys or the host
 * keys change, and a change of key or account is another entry. A failure,
 * or GitHub out of reach, is kept only for `failMs` (20 s), so a burst of
 * readings asks once while a fix shows on the next reading after it.
 * Readings that meet share one proof. A sign-in or link of this process
 * keeps what it proved (`passed`), and one that starts, or a sign-out,
 * forgets everything (`forget`). */
export function createSshProofs(
  options: Readonly<{
    passMs?: number;
    failMs?: number;
    now?: () => number;
  }> = {},
) {
  const passMs = options.passMs ?? 5 * 60_000;
  const failMs = options.failMs ?? 20_000;
  const now = options.now ?? Date.now;
  const kept = new Map<string, Readonly<{ proof: SshProof; at: number }>>();
  const running = new Map<string, Promise<SshProof>>();
  // A proof that started before a `forget` is not kept.
  let generation = 0;
  // GitHub's logins are case-insensitive; a fingerprint is exact.
  const keyOf = (fingerprint: string, account: string) =>
    `${fingerprint} ${account.toLowerCase()}`;
  return {
    /** The proof for `fingerprint` and `account`: a kept one while it is
     * fresh, else `prove()` now, one at a time per key and account. */
    async prove(
      fingerprint: string,
      account: string,
      prove: () => Promise<SshProof>,
    ): Promise<SshProof> {
      const key = keyOf(fingerprint, account);
      const known = kept.get(key);
      if (
        known !== undefined &&
        now() - known.at < (known.proof.state === "proved" ? passMs : failMs)
      )
        return known.proof;
      const asked = running.get(key);
      if (asked !== undefined) return asked;
      const started = generation;
      const proving = prove()
        .catch((): SshProof => unreachable)
        .then((proof) => {
          if (started === generation) kept.set(key, { proof, at: now() });
          return proof;
        })
        .finally(() => {
          if (running.get(key) === proving) running.delete(key);
        });
      running.set(key, proving);
      return proving;
    },
    /** The sign-in or link of this process proved it just now. */
    passed(fingerprint: string, account: string): void {
      kept.set(keyOf(fingerprint, account), {
        proof: { state: "proved" },
        at: now(),
      });
    },
    /** A sign-in or sign-out started: nothing kept holds any more. */
    forget(): void {
      generation += 1;
      kept.clear();
      running.clear();
    },
  };
}

export type SshProofs = ReturnType<typeof createSshProofs>;

/** The signed-in account and its token scopes, read with gh's own status
 * (the JSON form first, `gh-status.ts`). */
export async function ghAccount(
  run: SshRunner,
  gh: string,
): Promise<
  | Readonly<{ account: string; scopes: readonly string[] | undefined }>
  | undefined
> {
  const { signIn, scopes } = await ghStatus(run, gh, stepTimeoutMs);
  if (signIn.state !== "signed-in" || signIn.account === undefined)
    return undefined;
  return { account: signIn.account, scopes };
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
  // Before the key is created.
  if (!(await proceed(context))) return "gone";
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

/** What the proof reads and needs of an SshContext: it writes nothing. */
export type ProofContext = Pick<
  SshContext,
  "home" | "gh" | "keygen" | "ssh" | "run" | "alive"
>;

// GitHub's published host keys, over HTTPS through gh (`gh api meta`), or
// undefined when GitHub did not answer them.
async function githubHostKeys(
  context: ProofContext,
  timeoutMs: number,
): Promise<readonly string[] | undefined | "gone"> {
  let meta: ToolProcessResult;
  try {
    meta = await context.run(
      [context.gh, "api", "meta", "--jq", ".ssh_keys"],
      timeoutMs,
    );
  } catch {
    return undefined;
  }
  if (!context.alive()) return "gone";
  return meta === "timeout" || meta.exitCode !== 0
    ? undefined
    : publishedHostKeys(meta.stdout);
}

// What `known_hosts` holds for github.com, against GitHub's published keys:
// the published keys it has, or `host-key-mismatch` when an entry is not
// one of them or carries a marker. Read only.
async function knownGithubHosts(
  context: ProofContext,
  published: readonly string[],
  timeoutMs: number,
): Promise<
  | Readonly<{ present: readonly string[] }>
  | Extract<
      SshLinkFailure,
      "keygen-missing" | "known-hosts-failed" | "host-key-mismatch"
    >
  | "gone"
> {
  if (context.keygen === undefined) return "keygen-missing";
  const file = join(context.home, ".ssh", "known_hosts");
  if (!(await exists(file))) return { present: [] };
  let found: ToolProcessResult;
  try {
    // Finds plain and hashed entries alike.
    found = await context.run(
      [context.keygen, "-F", "github.com", "-f", file],
      timeoutMs,
    );
  } catch {
    return "known-hosts-failed";
  }
  if (!context.alive()) return "gone";
  if (found === "timeout" || (found.exitCode !== 0 && found.exitCode !== 1))
    return "known-hosts-failed";
  const entries = knownHostEntries(found.stdout);
  if (entries.marked || entries.keys.some((key) => !published.includes(key)))
    return "host-key-mismatch";
  return { present: entries.keys };
}

// Step 4: GitHub's published host keys in the user's known_hosts. Only
// missing entries are added; an entry that differs stops everything, and
// nothing is replaced or accepted. Answers the published keys for the proof
// that follows.
async function ensureKnownHosts(
  context: SshContext,
): Promise<
  | Readonly<{ knownHosts: "added" | "present"; published: readonly string[] }>
  | Failure
  | "gone"
> {
  const published = await githubHostKeys(context, stepTimeoutMs);
  if (published === "gone") return "gone";
  if (published === undefined) return failed("host-keys-unavailable");
  const known = await knownGithubHosts(context, published, stepTimeoutMs);
  if (known === "gone") return "gone";
  if (typeof known === "string") return failed(known);
  const file = join(context.home, ".ssh", "known_hosts");
  const missing = published.filter((key) => !known.present.includes(key));
  if (missing.length === 0) return { knownHosts: "present", published };
  // Before `known_hosts` is written.
  if (!(await proceed(context))) return "gone";
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
  return { knownHosts: "added", published };
}

/** The login GitHub greets over SSH ("Hi <login>! You've successfully
 * authenticated…"), when it does. */
export function sshGreeting(output: string): string | undefined {
  return /^Hi ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))! You've successfully authenticated/m.exec(
    output,
  )?.[1];
}

/** Whether `ssh` said that it did not reach GitHub at all: the name did not
 * resolve, no route, a refused or timed-out connection, one closed before
 * the key exchange. Then nothing is known about the key. A refused key or a
 * refused host key is an answer, not this. */
export function sshUnreachable(output: string): boolean {
  if (
    /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      output,
    )
  )
    return false;
  return /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|Network is unreachable|No route to host|Connection refused|Connection timed out|Operation timed out|Connection closed by|Connection reset by|kex_exchange_identification|ssh_exchange_identification/i.test(
    output,
  );
}

/** The outcome of the proof: `proved`, `failed` with the reason (and the
 * login GitHub greeted when it is another account), or `unreachable` when
 * GitHub could not be reached or read (its published keys, or the SSH
 * connection itself). */
export type SshProof =
  | Readonly<{ state: "proved" }>
  | Readonly<{
      state: "failed";
      reason: Extract<
        SshLinkFailure,
        | "keygen-missing"
        | "known-hosts-failed"
        | "host-key-mismatch"
        | "ssh-missing"
        | "proof-failed"
        | "proof-other-account"
      >;
      provedAs?: string;
    }>
  | Readonly<{
      state: "unreachable";
      reason: "host-keys-unavailable" | "ssh-unreachable";
    }>;

/** The proof that `git clone git@github.com:…` works here as `account`
 * (decision F19, addendum 2026-09-28 step 5 and addendum 2026-10-19): every
 * github.com entry of `known_hosts` is one of GitHub's published host keys
 * (`gh api meta`, unless the caller has them), and `ssh -T` with BatchMode
 * and StrictHostKeyChecking=yes greets `account`. It writes nothing: the
 * sign-in adds the missing host keys before it (`ensureKnownHosts`), the
 * status (`sshStatus`) runs it as it is, and `UpdateHostKeys=no` keeps ssh
 * from adding keys the server advertises after the authentication (on by
 * default in OpenSSH). One function for both, so the status says linked
 * exactly when the sign-in would. */
export async function proveSsh(
  context: ProofContext,
  account: string,
  options: Readonly<{ published?: readonly string[]; timeoutMs: number }>,
): Promise<SshProof | "gone"> {
  const published =
    options.published ?? (await githubHostKeys(context, options.timeoutMs));
  if (published === "gone") return "gone";
  if (published === undefined)
    return { state: "unreachable", reason: "host-keys-unavailable" };
  const known = await knownGithubHosts(context, published, options.timeoutMs);
  if (known === "gone") return "gone";
  if (typeof known === "string") return { state: "failed", reason: known };
  if (context.ssh === undefined)
    return { state: "failed", reason: "ssh-missing" };
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
        "UpdateHostKeys=no",
        "-o",
        "ConnectTimeout=15",
        "git@github.com",
      ],
      options.timeoutMs,
    );
  } catch {
    return { state: "failed", reason: "proof-failed" };
  }
  if (!context.alive()) return "gone";
  if (proof === "timeout")
    return { state: "unreachable", reason: "ssh-unreachable" };
  const output = `${proof.stdout}\n${proof.stderr}`;
  const greeted = sshGreeting(output);
  if (greeted === undefined)
    return sshUnreachable(output)
      ? { state: "unreachable", reason: "ssh-unreachable" }
      : { state: "failed", reason: "proof-failed" };
  if (greeted.toLowerCase() !== account.toLowerCase())
    return {
      state: "failed",
      reason: "proof-other-account",
      provedAs: greeted,
    };
  return { state: "proved" };
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
  if (!(await proceed(context))) return "gone";
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
  const hosts = await ensureKnownHosts(context);
  if (hosts === "gone" || !context.alive()) return "gone";
  if ("state" in hosts) return { ...hosts, key };
  // Step 5: the proof, as `git clone git@github.com:…` would connect: the
  // one the status runs too (`proveSsh`), with the host keys just read.
  const proof = await proveSsh(context, account, {
    published: hosts.published,
    timeoutMs: stepTimeoutMs,
  });
  if (proof === "gone" || !context.alive()) return "gone";
  if (proof.state === "unreachable")
    return failed(
      proof.reason === "host-keys-unavailable"
        ? "host-keys-unavailable"
        : "proof-failed",
      { key },
    );
  if (proof.state === "failed")
    return failed(proof.reason, {
      key,
      ...(proof.provedAs === undefined ? {} : { provedAs: proof.provedAs }),
    });
  return { state: "linked", key, registration, knownHosts: hosts.knownHosts };
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
