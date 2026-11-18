import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { ToolRunner } from "../tools/status";
import { writeDurableFile } from "../update/durable-file";
import type { ProcessRunner } from "../update/self-check";
import { systemctl } from "../update/service-control";
import { type BrainHttp, healthVersion, mcpTool } from "./admin";
import {
  type BrainState,
  ownerSession,
  readBrainState,
  writeBrainState,
} from "./keys";
import {
  type BrainPaths,
  brainKeyNames,
  brainRefreshTimer,
  brainUnit,
} from "./pin";

// The brain onto the person's private vault in the Personalspace
// (`personalspace/<login>_GEN3/gbrain`, the repository `personal.gen3.json`
// declares as `gbrain.repository`), as Machines' `Vault` puts it there today
// (HumanAndMachine-ai/Machines `workloads/workspace-vm/hermes-service.py`):
// the same reading of what is there, the same decision and the same steps,
// so a brain one of them connected is connected for the other.
//   waits    nothing declared yet, no GitHub sign-in, no branch yet, or Buddy
//            is working: the next run tries again
//   stop     something a person decides (pages off the vault, a checkout
//            with changes, another client, a public vault): reported only
//   rebuild  an empty brain is made again on the vault, with a copy of the
//            brain before that comes back whole if any step fails
//   ensure   the brain is on the vault; what is missing of `sync.on_commit`,
//            git durability and the refresh timer is switched on
// Every result is a closed label; no page, path of the person's or key.

export type VaultDeclaration =
  | Readonly<{ state: "none" | "ambiguous" }>
  | Readonly<{
      state: "unreadable" | "unknown-shape" | "foreign-owner";
      personalspace: string;
    }>
  | Readonly<{ state: "declared"; personalspace: string; repo: string }>;

const repoPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const githubRemote =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

/** owner/name of a GitHub remote as git stores it, lower-cased; else null. */
export function originRepo(url: string | null | undefined): string | null {
  const match = githubRemote.exec(url ?? "");
  return match?.[1] ? match[1].toLowerCase() : null;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/** The vault one Personalspace declares; `manifests` holds each
 * `personalspace/<login>_GEN3` with its parsed `personal.gen3.json` (null
 * where it is not JSON). */
export function vaultDeclarationOf(
  manifests: readonly (readonly [string, unknown])[],
): VaultDeclaration {
  if (manifests.length === 0) return { state: "none" };
  if (manifests.length > 1) return { state: "ambiguous" };
  const [personalspace, document] = manifests[0] as readonly [string, unknown];
  if (document === null) return { state: "unreadable", personalspace };
  const doc = record(document);
  const gbrain = record(doc?.gbrain);
  if (gbrain === null || !("repository" in gbrain)) return { state: "none" };
  const repository = record(gbrain.repository);
  const repo = repository?.github_repo;
  if (typeof repo !== "string" || !repoPattern.test(repo))
    return { state: "unknown-shape", personalspace };
  // The vault belongs to the account that owns the Personalspace, and it is
  // not the Personalspace repository itself.
  const named = record(doc?.owner)?.github_username;
  const owner =
    typeof named === "string" && named !== ""
      ? named
      : basename(personalspace).replace(/_GEN3$/, "");
  if ((repo.split("/")[0] as string).toLowerCase() !== owner.toLowerCase())
    return { state: "foreign-owner", personalspace };
  const own = record(doc?.repository)?.github_repo;
  if (typeof own === "string" && own.toLowerCase() === repo.toLowerCase())
    return { state: "foreign-owner", personalspace };
  return { state: "declared", personalspace, repo };
}

/** The one Personalspace manifest of the Folder `folder`. */
export async function vaultDeclaration(
  folder: string,
): Promise<VaultDeclaration> {
  const root = join(folder, "personalspace");
  const names = await readdir(root).catch(() => [] as string[]);
  const found: (readonly [string, unknown])[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith("_GEN3")) continue;
    const path = join(root, name, "personal.gen3.json");
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      document = null;
    }
    found.push([join(root, name), document]);
  }
  return vaultDeclarationOf(found);
}

/** What is there, read only. */
export type VaultObservation = Readonly<{
  declaration: VaultDeclaration;
  githubSignedIn: boolean;
  repoSeen: boolean;
  repoPrivate: boolean;
  /** git reaches the vault without a prompt. */
  gitReaches: boolean;
  remoteBranch: string | null;
  /** The brain's page count over MCP; null when it did not answer. */
  pages: number | null;
  /** The brain's default source's directory, resolved. */
  defaultPath: string | null;
  vaultDir: string | null;
  vaultExists: boolean;
  vaultIsGit: boolean;
  vaultOrigin: string | null;
  vaultClean: boolean;
  onCommit: boolean;
  /** git durability of the default source; null when not readable. */
  durability: boolean | null;
  timer: boolean;
  /** Active clients other than Lazurio's and Machines' own keys; null when
   * they cannot be listed. */
  otherClients: readonly string[] | null;
}>;

export type VaultReason =
  | "not-declared"
  | "declaration-ambiguous"
  | "declaration-unreadable"
  | "declaration-unknown-shape"
  | "declaration-foreign-owner"
  | "github-sign-in"
  | "page-count"
  | "not-private"
  | "not-seen"
  | "git-prompt"
  | "writer-status"
  | "connected"
  | "pages-off-vault"
  | "checkout-not-clean"
  | "no-branch"
  | "clients-unlisted"
  | "other-client"
  | "empty-brain";

export type VaultMissing = "onCommit" | "durability" | "timer";

export type VaultPlan =
  | Readonly<{ action: "waits" | "stop"; reason: VaultReason }>
  | Readonly<{ action: "nothing"; reason: "connected" }>
  | Readonly<{
      action: "ensure";
      reason: "connected";
      missing: readonly VaultMissing[];
    }>
  | Readonly<{ action: "rebuild"; reason: "empty-brain"; moveAside: boolean }>;

/** The decision over what is there; Machines' `vault_plan`. */
export function vaultPlan(seen: VaultObservation): VaultPlan {
  const { declaration } = seen;
  if (declaration.state === "none")
    return { action: "waits", reason: "not-declared" };
  if (declaration.state !== "declared")
    return { action: "stop", reason: `declaration-${declaration.state}` };
  if (!seen.githubSignedIn)
    return { action: "waits", reason: "github-sign-in" };
  if (seen.pages === null) return { action: "stop", reason: "page-count" };
  if (seen.repoSeen && !seen.repoPrivate)
    return { action: "stop", reason: "not-private" };
  const repo = declaration.repo.toLowerCase();
  const connected =
    seen.vaultDir !== null &&
    seen.defaultPath === seen.vaultDir &&
    seen.vaultIsGit &&
    originRepo(seen.vaultOrigin) === repo;
  if (connected) {
    if (!seen.repoSeen) return { action: "stop", reason: "not-seen" };
    if (seen.durability === null)
      return { action: "stop", reason: "writer-status" };
    const missing: VaultMissing[] = [];
    if (!seen.onCommit) missing.push("onCommit");
    if (!seen.durability) missing.push("durability");
    if (!seen.timer) missing.push("timer");
    if (missing.length > 0 && !seen.gitReaches)
      return { action: "stop", reason: "git-prompt" };
    return missing.length > 0
      ? { action: "ensure", reason: "connected", missing }
      : { action: "nothing", reason: "connected" };
  }
  if (seen.pages > 0) return { action: "stop", reason: "pages-off-vault" };
  let moveAside = false;
  if (seen.vaultExists) {
    if (
      !(
        seen.vaultIsGit &&
        originRepo(seen.vaultOrigin) === repo &&
        seen.vaultClean
      )
    )
      return { action: "stop", reason: "checkout-not-clean" };
    moveAside = true;
  }
  if (!seen.repoSeen) return { action: "stop", reason: "not-seen" };
  if (!seen.gitReaches) return { action: "stop", reason: "git-prompt" };
  if (seen.remoteBranch === null)
    return { action: "waits", reason: "no-branch" };
  if (seen.otherClients === null)
    return { action: "stop", reason: "clients-unlisted" };
  if (seen.otherClients.length > 0)
    return { action: "stop", reason: "other-client" };
  return { action: "rebuild", reason: "empty-brain", moveAside };
}

export type VaultHost = Readonly<{
  paths: BrainPaths;
  /** The Folder, `~/Lazurio`. */
  folder: string;
  /** The gbrain command of the release the brain runs. */
  command: string;
  /** The person's gh, for git's credential in the vault only. */
  gh: string | undefined;
  run: ToolRunner;
  service: ProcessRunner;
  http: BrainHttp;
  base: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether Buddy is idle, so the brain may stop for a moment. */
  idle: () => Promise<boolean>;
  now?: () => Date;
  tries?: number;
  waitMs?: number;
}>;

export type VaultResult =
  | "local"
  | "waits"
  | "connected"
  | "rebuilt"
  | `stop:${string}`;

/** Names of keys of Lazurio and Machines, which are no other client. */
const ownKeyNames: ReadonlySet<string> = new Set([
  ...Object.values(brainKeyNames),
  "hermes-buddy",
]);

class VaultFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function environment(host: VaultHost): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME"])
    if (host.env[name] !== undefined) env[name] = host.env[name] as string;
  env.HOME = host.paths.home;
  env.GBRAIN_HOME = host.paths.home;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return env;
}

type Ran = Readonly<{ ok: boolean; stdout: string }>;

async function exec(
  host: VaultHost,
  command: readonly string[],
  timeoutMs = 120_000,
): Promise<Ran> {
  const result = await host
    .run(command, timeoutMs, environment(host))
    .catch(() => "timeout" as const);
  return result === "timeout"
    ? { ok: false, stdout: "" }
    : { ok: result.exitCode === 0, stdout: result.stdout };
}

const git = (host: VaultHost, args: readonly string[], timeoutMs?: number) =>
  exec(host, ["git", ...args], timeoutMs);

/** git with the person's gh as its credential, for this command only. */
const gitWithGh = (
  host: VaultHost,
  args: readonly string[],
  timeoutMs?: number,
) =>
  exec(
    host,
    [
      "git",
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=!${host.gh} auth git-credential`,
      ...args,
    ],
    timeoutMs,
  );

const gbrain = (
  host: VaultHost,
  args: readonly string[],
  timeoutMs = 300_000,
) => exec(host, [host.command, ...args], timeoutMs);

/** The JSON object a `gbrain … --json` command printed after any banner. */
function gbrainJson(text: string): Readonly<Record<string, unknown>> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (
    let end = text.length;
    end > start;
    end = text.lastIndexOf("}", end - 1)
  ) {
    try {
      return record(JSON.parse(text.slice(start, end + 1)));
    } catch {}
    if (end <= 0) break;
  }
  return null;
}

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function probeToken(paths: BrainPaths): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.probeKey, "utf8")) as {
      token?: unknown;
    };
    return typeof value.token === "string" ? value.token : undefined;
  } catch {
    return undefined;
  }
}

async function durability(host: VaultHost): Promise<boolean | null> {
  const status = await gbrain(
    host,
    ["sources", "writer", "status", "default", "--json"],
    60_000,
  );
  const bindings = gbrainJson(status.stdout)?.bindings;
  const binding = Array.isArray(bindings) ? record(bindings[0]) : null;
  if (!status.ok || binding === null) return null;
  return (
    binding.git_durability === "enabled" &&
    binding.git_durability_state === "on"
  );
}

async function timerActive(host: VaultHost): Promise<boolean> {
  return systemctl(
    { run: host.service, env: host.env },
    "is-active",
    "--quiet",
    brainRefreshTimer,
  );
}

/** What is there, read only: the declaration, GitHub, the brain's own
 * answer about its pages and default source (the probe key, metadata only),
 * the vault's checkout and what of the connection is on. */
export async function observeVault(
  host: VaultHost,
  state: BrainState,
): Promise<VaultObservation> {
  const declaration = await vaultDeclaration(host.folder);
  const seen = {
    declaration,
    githubSignedIn: false,
    repoSeen: false,
    repoPrivate: false,
    gitReaches: false,
    remoteBranch: null as string | null,
    pages: null as number | null,
    defaultPath: null as string | null,
    vaultDir: null as string | null,
    vaultExists: false,
    vaultIsGit: false,
    vaultOrigin: null as string | null,
    vaultClean: false,
    onCommit: false,
    durability: null as boolean | null,
    timer: false,
    otherClients: null as readonly string[] | null,
  };
  if (declaration.state !== "declared") return Object.freeze(seen);
  const { repo } = declaration;
  const vaultPath = join(declaration.personalspace, "gbrain");
  const vaultDir = await realpath(vaultPath).catch(() => vaultPath);
  seen.vaultDir = vaultDir;
  if (
    host.gh !== undefined &&
    (await exec(host, [host.gh, "auth", "status", "--hostname", "github.com"]))
      .ok
  ) {
    seen.githubSignedIn = true;
    const view = await exec(host, [
      host.gh,
      "repo",
      "view",
      repo,
      "--json",
      "nameWithOwner,visibility",
    ]);
    const answer = view.ok ? (gbrainJson(view.stdout) ?? {}) : {};
    seen.repoSeen =
      String(answer.nameWithOwner ?? "").toLowerCase() === repo.toLowerCase();
    seen.repoPrivate = seen.repoSeen && answer.visibility === "PRIVATE";
  }
  const token = await probeToken(host.paths);
  if (token !== undefined) {
    const identity = await mcpTool(
      host.http,
      host.base,
      token,
      "get_brain_identity",
    );
    const sources = await mcpTool(host.http, host.base, token, "sources_list");
    if (identity !== null && Number.isInteger(identity.page_count))
      seen.pages = identity.page_count as number;
    const list = sources?.sources;
    const source = Array.isArray(list)
      ? list.map(record).find((item) => item?.id === "default")
      : undefined;
    if (typeof source?.local_path === "string")
      seen.defaultPath = await realpath(source.local_path).catch(
        () => source.local_path as string,
      );
  }
  if (await present(vaultPath)) {
    seen.vaultExists = true;
    const top = await git(host, [
      "--no-optional-locks",
      "-C",
      vaultDir,
      "rev-parse",
      "--show-toplevel",
    ]);
    if (top.ok && top.stdout.trim() === vaultDir) {
      seen.vaultIsGit = true;
      const origin = await git(host, [
        "--no-optional-locks",
        "-C",
        vaultDir,
        "config",
        "--get",
        "remote.origin.url",
      ]);
      seen.vaultOrigin = origin.stdout.trim() || null;
      const unpushed = await git(host, [
        "--no-optional-locks",
        "-C",
        vaultDir,
        "log",
        "--branches",
        "--not",
        "--remotes",
        "--oneline",
      ]);
      const stash = await git(host, ["-C", vaultDir, "stash", "list"]);
      const status = await git(host, [
        "--no-optional-locks",
        "-C",
        vaultDir,
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      const changes = status.stdout
        .split("\n")
        .filter((line) => line !== "" && line.slice(3) !== ".gitignore");
      seen.vaultClean =
        unpushed.ok &&
        unpushed.stdout.trim() === "" &&
        stash.ok &&
        stash.stdout.trim() === "" &&
        status.ok &&
        changes.length === 0;
    }
  }
  if (seen.githubSignedIn) {
    const listing =
      seen.vaultIsGit && seen.defaultPath === vaultDir
        ? await git(
            host,
            ["-C", vaultDir, "ls-remote", "--symref", "origin", "HEAD"],
            60_000,
          )
        : seen.vaultIsGit
          ? await gitWithGh(
              host,
              ["-C", vaultDir, "ls-remote", "--symref", "origin", "HEAD"],
              60_000,
            )
          : await gitWithGh(
              host,
              [
                "ls-remote",
                "--symref",
                `https://github.com/${repo}.git`,
                "HEAD",
              ],
              60_000,
            );
    if (listing.ok) {
      seen.gitReaches = true;
      for (const line of listing.stdout.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (
          fields.length === 3 &&
          fields[0] === "ref:" &&
          fields[2] === "HEAD"
        ) {
          seen.remoteBranch = (fields[1] as string).replace(
            /^refs\/heads\//,
            "",
          );
          break;
        }
      }
    }
  }
  if (seen.defaultPath === vaultDir) seen.durability = await durability(host);
  seen.onCommit =
    state.vault?.repo === repo && state.vault.onCommit !== undefined;
  seen.timer = await timerActive(host);
  if (seen.pages === 0) {
    const admin = await ownerSession(host.paths, host.http, host.base);
    const clients = admin === null ? null : await admin.clients();
    seen.otherClients =
      clients === null
        ? null
        : [
            ...new Set(
              clients
                .filter(
                  (client) =>
                    client.active &&
                    !(
                      client.kind === "api_key" && ownKeyNames.has(client.name)
                    ),
                )
                .map((client) => client.name),
            ),
          ].sort();
  }
  return Object.freeze(seen);
}

async function answers(host: VaultHost): Promise<boolean> {
  for (let i = 0; i < (host.tries ?? 45); i++) {
    if ((await healthVersion(host.http, host.base)) !== null) return true;
    await sleep(host.waitMs ?? 2000);
  }
  return false;
}

const service = (host: VaultHost, ...args: string[]) =>
  systemctl({ run: host.service, env: host.env }, ...args);

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** `sync.on_commit` with the server stopped, once (it holds PGLite). */
async function switchOnCommit(host: VaultHost): Promise<boolean> {
  if (!(await service(host, "stop", brainUnit))) {
    await service(host, "start", brainUnit);
    return false;
  }
  const set = await gbrain(
    host,
    ["config", "set", "sync.on_commit", "true"],
    60_000,
  );
  const started = await service(host, "start", brainUnit);
  return set.ok && started && (await answers(host));
}

async function switchDurability(host: VaultHost): Promise<boolean> {
  if (
    !(await gbrain(host, ["sources", "refresh", "default", "--json"], 600_000))
      .ok
  )
    return false;
  const status = await gbrain(
    host,
    ["sources", "writer", "status", "default", "--json"],
    60_000,
  );
  const adminState = gbrainJson(status.stdout)?.admin_state;
  if (!status.ok || adminState === undefined) return false;
  const enabled = await gbrain(host, [
    "sources",
    "writer",
    "git-durability",
    "default",
    "--enable",
    "--admin-intent",
    "writer_git_durability",
    "--expected-state",
    String(adminState),
    "--json",
  ]);
  return enabled.ok && (await durability(host)) === true;
}

const switchTimer = async (host: VaultHost) =>
  (await service(host, "enable", "--now", brainRefreshTimer)) &&
  (await timerActive(host));

/** gbrain's own files that the vault does not track stay out of its
 * commits, locally (`.git/info/exclude`); with `onlyPresent`, only those
 * that are there now. */
async function excludeOwn(
  host: VaultHost,
  vaultDir: string,
  names: readonly string[],
  onlyPresent: boolean,
): Promise<void> {
  const exclude = join(vaultDir, ".git", "info", "exclude");
  if (!(await present(join(vaultDir, ".git")))) return;
  const lines = (await readFile(exclude, "utf8").catch(() => "")).split("\n");
  const added: string[] = [];
  for (const name of names) {
    const bare = name.replace(/\/$/, "");
    if (lines.includes(`/${name}`)) continue;
    if (onlyPresent && !(await present(join(vaultDir, bare)))) continue;
    if (
      (
        await git(host, [
          "--no-optional-locks",
          "-C",
          vaultDir,
          "ls-files",
          "--error-unmatch",
          bare,
        ])
      ).ok
    )
      continue;
    added.push(`/${name}`);
  }
  if (added.length === 0) return;
  await mkdir(join(vaultDir, ".git", "info"), { recursive: true });
  const text = lines.join("\n");
  await writeDurableFile(
    join(vaultDir, ".git", "info"),
    "exclude",
    Buffer.from(
      `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${added.join("\n")}\n`,
    ),
  );
}

/** An empty brain made again on the vault. `backup` holds the brain before
 * (its owner credential is carried over, so every key stays the owner's). */
async function rebuildCore(
  host: VaultHost,
  input: Readonly<{
    backup: string;
    vaultDir: string;
    origin: string;
    branch: string;
  }>,
): Promise<void> {
  const { backup, vaultDir, origin, branch } = input;
  const need = (ran: Ran, code: string) => {
    if (!ran.ok) throw new VaultFailure(code);
  };
  need(
    await gbrain(host, [
      "init",
      "--pglite",
      "--no-embedding",
      "--non-interactive",
      "--content-root",
      vaultDir,
      "--git",
      "--json",
    ]),
    "init",
  );
  try {
    const admin = await readFile(join(backup, "serve", "admin-token"));
    await mkdir(join(host.paths.brain, "serve"), {
      recursive: true,
      mode: 0o700,
    });
    await writeDurableFile(
      join(host.paths.brain, "serve"),
      "admin-token",
      admin,
    );
  } catch {
    throw new VaultFailure("credential");
  }
  need(
    await git(host, ["-C", vaultDir, "remote", "add", "origin", origin]),
    "remote",
  );
  if (origin.startsWith("https://")) {
    // git in the vault uses the person's gh sign-in, in this repo only.
    need(
      await git(host, [
        "-C",
        vaultDir,
        "config",
        "--local",
        "--replace-all",
        "credential.https://github.com.helper",
        "",
      ]),
      "credential",
    );
    need(
      await git(host, [
        "-C",
        vaultDir,
        "config",
        "--local",
        "--add",
        "credential.https://github.com.helper",
        `!${host.gh} auth git-credential`,
      ]),
      "credential",
    );
  }
  need(
    await git(host, ["-C", vaultDir, "fetch", "-q", "origin", branch], 900_000),
    "fetch",
  );
  const tree = await git(host, [
    "-C",
    vaultDir,
    "ls-tree",
    "-r",
    "--name-only",
    `origin/${branch}`,
  ]);
  need(tree, "fetch");
  // gbrain's own untracked files that the vault tracks would block the
  // checkout: the vault's win, gbrain's go into the copy.
  const tracked = new Set(
    tree.stdout
      .split("\n")
      .filter((name) =>
        /^(LICENSE|README\.md|skillpack\.json|skills\/)/.test(name),
      )
      .map((name) => name.split("/")[0] as string),
  );
  for (const name of [...tracked].sort())
    if (await present(join(vaultDir, name)))
      await rename(join(vaultDir, name), join(backup, `content-root-${name}`));
  need(
    await git(host, [
      "-C",
      vaultDir,
      "checkout",
      "-q",
      "-B",
      branch,
      `origin/${branch}`,
    ]),
    "checkout",
  );
  need(
    await git(host, [
      "-C",
      vaultDir,
      "branch",
      "-q",
      `--set-upstream-to=origin/${branch}`,
      branch,
    ]),
    "checkout",
  );
  const kept = await readFile(
    join(backup, "vault-checkout", ".gitignore"),
  ).catch(() => undefined);
  if (kept !== undefined) {
    await writeDurableFile(vaultDir, ".gitignore", kept);
    await chmod(join(vaultDir, ".gitignore"), 0o644);
  }
  await excludeOwn(
    host,
    vaultDir,
    [".gbrain-owner.json", "LICENSE", "README.md", "skillpack.json", "skills/"],
    true,
  );
  need(
    await gbrain(
      host,
      ["sync", "--source", "default", "--no-pull", "--json"],
      3_600_000,
    ),
    "sync",
  );
  need(
    await gbrain(host, ["config", "set", "sync.on_commit", "true"], 60_000),
    "on-commit",
  );
  if (!(await service(host, "start", brainUnit)) || !(await answers(host)))
    throw new VaultFailure("start");
}

/** The brain before comes back whole; the failed attempt is kept aside. */
async function restore(
  host: VaultHost,
  backup: string,
  vaultDir: string,
  at: string,
): Promise<boolean> {
  const { brain, home } = host.paths;
  const aside = join(home, `.gbrain.failed-${at}`);
  await service(host, "stop", brainUnit);
  await mkdir(aside, { recursive: true, mode: 0o700 });
  if (await present(brain)) await rename(brain, join(aside, "gbrain"));
  if (await present(vaultDir))
    await rename(vaultDir, join(aside, "content-root"));
  for (const name of await readdir(backup))
    if (name.startsWith("content-root-"))
      await rename(join(backup, name), join(aside, name));
  if (await present(join(backup, "vault-checkout")))
    await rename(join(backup, "vault-checkout"), vaultDir);
  await rename(backup, brain);
  return (await service(host, "start", brainUnit)) && (await answers(host));
}

/** Puts the brain on the vault; a rebuild or a stop of the server happens
 * only while Buddy is idle. The keys are not touched here: a rebuilt brain
 * has none, and setup converges them right after. */
export async function convergeVault(host: VaultHost): Promise<VaultResult> {
  const state = await readBrainState(host.paths);
  const seen = await observeVault(host, state);
  const plan = vaultPlan(seen);
  const { declaration } = seen;
  const repo = declaration.state === "declared" ? declaration.repo : undefined;
  const now = () => (host.now ?? (() => new Date()))();
  let vault = { ...(state.vault ?? {}) };
  const save = async () => {
    const current = await readBrainState(host.paths);
    await writeBrainState(host.paths, {
      ...current,
      vault: Object.freeze({ ...vault }),
    });
  };
  if (repo !== undefined && vault.repo !== repo) vault = { repo };
  let result: VaultResult;
  switch (plan.action) {
    case "waits":
      result = plan.reason === "not-declared" ? "local" : "waits";
      break;
    case "stop":
      result = `stop:${plan.reason}`;
      break;
    case "nothing":
      result = "connected";
      break;
    case "ensure": {
      if (plan.missing.includes("onCommit") && !(await host.idle())) {
        result = "waits";
        break;
      }
      const failures: string[] = [];
      for (const missing of plan.missing) {
        const on =
          missing === "onCommit"
            ? await switchOnCommit(host)
            : missing === "durability"
              ? await switchDurability(host)
              : await switchTimer(host);
        if (!on) failures.push(missing);
        else if (missing === "onCommit") vault.onCommit = now().toISOString();
        else if (missing === "durability")
          vault.durability = now().toISOString();
      }
      result =
        failures.length > 0 ? `stop:${failures.join(",")}-not-on` : "connected";
      break;
    }
    case "rebuild": {
      if (!(await host.idle())) {
        result = "waits";
        break;
      }
      const vaultDir = seen.vaultDir as string;
      const at = stamp(now());
      const backup = join(host.paths.home, `.gbrain.bak-${at}`);
      const origin = plan.moveAside
        ? (seen.vaultOrigin as string)
        : `https://github.com/${repo}.git`;
      // The brain is moved only once its server is down: PGLite is held by
      // a running server. A move that fails puts back what it moved.
      if (!(await service(host, "stop", brainUnit))) {
        await service(host, "start", brainUnit);
        result = "stop:rebuild-stop";
        break;
      }
      try {
        await rename(host.paths.brain, backup);
        if (plan.moveAside)
          await rename(vaultDir, join(backup, "vault-checkout"));
      } catch {
        if (await present(join(backup, "vault-checkout")))
          await rename(join(backup, "vault-checkout"), vaultDir).catch(
            () => undefined,
          );
        if (!(await present(host.paths.brain)) && (await present(backup)))
          await rename(backup, host.paths.brain).catch(() => undefined);
        await service(host, "start", brainUnit);
        result = "stop:rebuild-move";
        break;
      }
      vault.rebuild = {
        state: "started",
        at: now().toISOString(),
        backup: basename(backup),
      };
      await save();
      try {
        await rebuildCore(host, {
          backup,
          vaultDir,
          origin,
          branch: seen.remoteBranch as string,
        });
      } catch (error) {
        const code = error instanceof VaultFailure ? error.code : "unexpected";
        const back = await restore(host, backup, vaultDir, at).catch(
          () => false,
        );
        vault.rebuild = {
          state: back
            ? `restored-after-${code}`
            : `restore-failed-after-${code}`,
          at: now().toISOString(),
        };
        result = `stop:rebuild-${code}`;
        break;
      }
      vault.rebuild = {
        state: "done",
        at: now().toISOString(),
        backup: basename(backup),
      };
      vault.onCommit = now().toISOString();
      const failures: string[] = [];
      if (await switchDurability(host)) vault.durability = now().toISOString();
      else failures.push("durability");
      if (!(await switchTimer(host))) failures.push("timer");
      result =
        failures.length > 0 ? `stop:${failures.join(",")}-not-on` : "rebuilt";
      break;
    }
  }
  if (
    (result === "connected" || result === "rebuilt") &&
    seen.vaultDir !== null
  )
    await excludeOwn(host, seen.vaultDir, ["AGENTS.md", "RESOLVER.md"], false);
  await save();
  return result;
}
