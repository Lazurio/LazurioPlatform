import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveInstallBase } from "../../src/update/base";
import { nativeTarget, versionOfTag } from "../../src/update/identity";
import { layout, readHighWater, readSelector } from "../../src/update/layout";
import {
  artifactFile,
  bundleFile,
  manifestFile,
  parseManifest,
  sha256Hex,
} from "../../src/update/manifest";
import { compareVersions } from "../../src/update/version";

/** The journeys J1–J5 of the release qualification (docs/release-cycle.md
 * "Qualification and the canary") against the REAL release candidate: the
 * executable, manifest, Sigstore bundle and install.sh that `release.yml`
 * published for a `vX.Y.Z-rc.N` tag, through the real GitHub Release and
 * Sigstore path. `.github/workflows/qualify.yml` runs one journey per
 * disposable runner; J6 is the behavioural suite `tests/update-kill.test.ts`
 * at the candidate's commit.
 *
 *   LAZURIO_QUALIFY_DISPOSABLE=1 bun run scripts/qualify/journeys.ts <verify|J1|J2|J3|J4|J5> <candidate directory>
 *
 * `verify` holds the downloaded candidate against its manifest, its
 * attestation and the checked-out commit; run it first. HOME must be a
 * disposable directory that is not the account's home (qualify.yml: a
 * runner-owned temporary directory, with XDG_* under it). Everything the
 * journeys write lives under it — the install base, `~/Lazurio`,
 * `~/.local/bin`, the user units and the downloaded older releases — except
 * what the systemd user manager itself keeps under XDG_RUNTIME_DIR on Linux,
 * where the journeys use the REAL user manager exactly as a person's
 * installation does. They refuse without the variable above, with the
 * account's own home, and where an installation exists. `gh` (signed in)
 * downloads and verifies the older releases J2, J3 and J5 start from.
 */
const repository = "Lazurio/LazurioPlatform";
const unit = "lazurio-launchpad.service";
/** The last two final releases with program rollback: J5 starts from the
 * layout they leave. J5 is deleted together with the migration
 * (src/update/migrations/remove-rollback/README.md). */
const legacyReleases = ["v0.1.6", "v0.1.7"] as const;

const home = process.env.HOME ?? "";
const target = nativeTarget(process.platform, process.arch);
const supervised = process.platform === "linux";
const base =
  resolveInstallBase({
    platform: process.platform,
    env: process.env,
    homedir: home,
  }) ?? "";
const selector = layout(base).selector;
const folder = join(home, "Lazurio");
const entry = join(home, ".local", "bin", "lazurio");
/** Where the product writes user units: `${XDG_CONFIG_HOME:-~/.config}`. */
const unitFile = (name: string) =>
  join(
    process.env.XDG_CONFIG_HOME?.startsWith("/")
      ? process.env.XDG_CONFIG_HOME
      : join(home, ".config"),
    "systemd",
    "user",
    name,
  );
// The product refuses group-writable Folder parents; runners default to 002.
process.umask(0o077);

// What a person's shell has: no token of the harness reaches the product.
const productEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name !== "GH_TOKEN" && name !== "GITHUB_TOKEN",
  ),
);

type Result = { code: number; stdout: string; stderr: string };

async function exec(
  command: readonly string[],
  options: { quiet?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<Result> {
  if (!options.quiet) console.log(`$ ${command.join(" ")}`);
  const child = Bun.spawn([...command], {
    env: options.env ?? productEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (!options.quiet)
    for (const line of `${stdout}\n${stderr}`.trim().split("\n").slice(-30))
      if (line) console.log(`  > ${line.slice(0, 300)}`);
  return { code, stdout, stderr };
}

async function must(command: readonly string[], env?: Record<string, string>) {
  const result = await exec(command, env ? { env } : {});
  if (result.code !== 0)
    throw new Error(`${command[0]} ${command[1] ?? ""}: exit ${result.code}`);
  return result;
}

// biome-ignore lint/suspicious/noExplicitAny: product JSON, asserted below
async function json(command: readonly string[], quiet = false): Promise<any> {
  const result = await exec(command, { quiet });
  try {
    return { exit: result.code, ...JSON.parse(result.stdout) };
  } catch {
    throw new Error(`${command.slice(0, 2).join(" ")}: no JSON answer`);
  }
}

function same(label: string, actual: unknown, expected: unknown) {
  if (!Bun.deepEquals(actual, expected))
    throw new Error(
      `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  console.log(`  PASS ${label}: ${JSON.stringify(actual)}`);
}

async function waitFor(
  label: string,
  seconds: number,
  condition: () => Promise<boolean>,
) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await condition().catch(() => false))) {
    if (Date.now() > deadline)
      throw new Error(`${label}: not within ${seconds} s`);
    await Bun.sleep(500);
  }
  console.log(`  PASS ${label}`);
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const linkExists = (path: string) =>
  readlink(path).then(
    () => true,
    () => false,
  );
const versions = async () =>
  (await readdir(layout(base).versions)).filter(
    (name) => !name.startsWith("."),
  );

/** The account's home from the user database; `os.userInfo()` answers HOME. */
const accountHome = async () =>
  (
    await exec(["sh", "-c", 'eval "echo ~$(id -un)"'], {
      quiet: true,
      env: process.env,
    })
  ).stdout.trim();

// ---- The candidate and the releases it is qualified against ---------------

type Candidate = Readonly<{
  directory: string;
  tag: string;
  version: string;
  commit: string;
  executable: string;
}>;

async function candidateIn(directory: string): Promise<Candidate> {
  const manifest = parseManifest(await readFile(join(directory, manifestFile)));
  const executable = join(directory, artifactFile(target));
  await chmod(executable, 0o700);
  return Object.freeze({
    directory,
    tag: `v${manifest.version}`,
    version: manifest.version,
    commit: manifest.sourceCommit,
    executable,
  });
}

const attested = (file: string, bundle: string, tag: string) =>
  must(
    [
      "gh",
      "attestation",
      "verify",
      file,
      "--bundle",
      bundle,
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/.github/workflows/release.yml`,
      "--source-ref",
      `refs/tags/${tag}`,
    ],
    process.env as Record<string, string>,
  );

/** The downloaded candidate is what `release.yml` published at its tag, and
 * the harness is its source. */
async function verify(directory: string) {
  const candidate = await candidateIn(directory);
  same(
    "a release candidate",
    /^v\d+\.\d+\.\d+-rc\.\d+$/.test(candidate.tag),
    true,
  );
  const manifest = parseManifest(await readFile(join(directory, manifestFile)));
  same(
    `SHA-256 of ${artifactFile(target)}`,
    sha256Hex(await readFile(candidate.executable)),
    manifest.targets[target]?.sha256,
  );
  const head = await must(["git", "rev-parse", "HEAD"]);
  same(
    "the harness runs at the candidate's commit",
    head.stdout.trim(),
    candidate.commit,
  );
  for (const file of [manifestFile, artifactFile(target), "install.sh"])
    await attested(
      join(directory, file),
      join(directory, bundleFile),
      candidate.tag,
    );
  same(
    "the candidate names itself",
    (await json([candidate.executable, "--version", "--json"])).version,
    candidate.version,
  );
}

let scratch: string | undefined;
/** An older release, downloaded and verified the way a custody verifies a
 * staged executable: manifest digest and `gh attestation verify`. */
async function release(tag: string): Promise<string> {
  scratch ??= await mkdtemp(join(home, "qualify-releases-"));
  const directory = join(scratch, tag);
  await mkdir(directory);
  const file = artifactFile(target);
  await must(
    [
      "gh",
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--dir",
      directory,
      "--pattern",
      manifestFile,
      "--pattern",
      file,
      "--pattern",
      bundleFile,
    ],
    process.env as Record<string, string>,
  );
  const manifest = parseManifest(await readFile(join(directory, manifestFile)));
  same(`${tag}: manifest version`, manifest.version, versionOfTag(tag));
  const executable = join(directory, file);
  same(
    `${tag}: SHA-256 of ${file}`,
    sha256Hex(await readFile(executable)),
    manifest.targets[target]?.sha256,
  );
  for (const name of [manifestFile, file])
    await attested(join(directory, name), join(directory, bundleFile), tag);
  await chmod(executable, 0o700);
  return executable;
}

/** The highest published final release below the candidate. */
async function previousFinal(version: string): Promise<string> {
  const listed = await must(
    [
      "gh",
      "api",
      "--paginate",
      `repos/${repository}/releases?per_page=100`,
      "--jq",
      ".[] | select(.draft or .prerelease | not) | .tag_name",
    ],
    process.env as Record<string, string>,
  );
  const below = listed.stdout
    .split("\n")
    .map((tag) => versionOfTag(tag.trim()))
    .filter(
      (found): found is string =>
        found !== undefined && compareVersions(found, version) < 0,
    )
    .sort(compareVersions);
  const previous = below.at(-1);
  if (previous === undefined) throw new Error("No final release precedes it");
  console.log(`previous final release: v${previous}`);
  return `v${previous}`;
}

// ---- The installation under test ------------------------------------------

const folderInit = (executable: string) =>
  must([
    executable,
    "folder-init",
    "--folder",
    folder,
    "--access",
    "local",
    "--purpose",
    "human",
    "--locale",
    "en",
    "--detail",
    "concise",
    "--coordination",
    "direct",
  ]);

/** The staged way in (docs/update.md "Offline update"): supervised on Linux. */
const installStaged = (executable: string) =>
  json([
    executable,
    "install",
    ...(supervised ? ["--service", "systemd-user", "--folder", folder] : []),
    "--json",
  ]);

const systemctl = async (...args: string[]) =>
  (await exec(["systemctl", "--user", ...args], { quiet: true })).stdout.trim();
const unitProperty = (name: string) =>
  systemctl("show", unit, "-p", name, "--value");

/** The unit's live process IS that version's executable, and its health
 * socket exists. */
const launchpadOn = (version: string) => async () =>
  (await systemctl("is-active", unit)) === "active" &&
  (await readlink(`/proc/${await unitProperty("MainPID")}/exe`)) ===
    join(base, "versions", version, "lazurio") &&
  (await exists(layout(base).healthSocket));

const recover = (quiet = false) =>
  json([selector, "recover", "--json", "--folder", folder], quiet);
// biome-ignore lint/suspicious/noExplicitAny: product JSON
const checkOf = (result: any, id: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: product JSON
  result.checks.find((check: any) => check.id === id);

/** `lazurio recover` answers healthy; supervised, its unit and its
 * Launchpad's health socket are among the checks that passed. */
async function healthy() {
  // biome-ignore lint/suspicious/noExplicitAny: product JSON
  const passes = (result: any) =>
    result.exit === 0 &&
    result.verdict === "healthy" &&
    (!supervised ||
      (checkOf(result, "launchpad-unit")?.outcome === "ok" &&
        checkOf(result, "launchpad-health")?.outcome === "ok"));
  await waitFor("lazurio recover: healthy", 60, async () =>
    passes(await recover(true)),
  );
  const result = await recover();
  same("recover verdict", [result.exit, result.verdict], [0, "healthy"]);
}

/** An unsupervised Launchpad started once: its first line, the page's HTTP
 * status, and its exit on SIGTERM. The session token is never printed. */
async function launchpadOnce(executable: string) {
  const child = Bun.spawn([executable, "launchpad", "--folder", folder], {
    env: productEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 60_000;
  while (!text.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const { url, ...started } = JSON.parse(text.split("\n")[0] ?? "");
  const page = await fetch(new URL("/", url), {
    signal: AbortSignal.timeout(10_000),
  });
  await page.text();
  child.kill("SIGTERM");
  return { started, status: page.status, exit: await child.exited };
}

// ---- J1–J5 ----------------------------------------------------------------

/** J1: first installation by install.sh in its strict form at the exact tag,
 * then --version, self-check, a Folder, and the supervised Launchpad. */
async function firstInstall(candidate: Candidate) {
  const url = `https://github.com/${repository}/releases/download/${candidate.tag}/install.sh`;
  const served = new Uint8Array(await (await fetch(url)).arrayBuffer());
  same(
    "install.sh served at the tag is the attested asset",
    sha256Hex(served),
    sha256Hex(await readFile(join(candidate.directory, "install.sh"))),
  );
  // docs/update.md "First installation": the one command, one exact tag. The
  // harness's signed-in gh is kept, so the script's second check runs.
  const oneCommand = (...args: string[]) =>
    exec(
      [
        "sh",
        "-c",
        `url=$1 tag=$2; shift 2; curl --proto '=https' --tlsv1.2 -fsSL "$url" | LAZURIO_VERSION="$tag" sh -s -- "$@"`,
        "sh",
        url,
        candidate.tag,
        ...args,
      ],
      { env: process.env },
    );
  const first = await oneCommand();
  same("install.sh exit status", first.code, 0);
  same(
    "install.sh says what it installed",
    first.stdout.includes(`Lazurio ${candidate.version} is installed.`),
    true,
  );
  same(
    "the independent check by gh ran",
    first.stdout.includes("Checked by the GitHub CLI"),
    true,
  );
  same("selector", await readSelector(base), candidate.version);
  same(
    "~/.local/bin/lazurio names the selector",
    await readlink(entry),
    selector,
  );
  same("lazurio --version", await json([entry, "--version", "--json"]), {
    exit: 0,
    version: candidate.version,
    commit: candidate.commit,
    target,
  });
  const report = await json([entry, "self-check", "--json", "--base", base]);
  same(
    "self-check",
    [report.exit, report.fixture, report.base],
    [0, false, { active: candidate.version, highWater: null }],
  );
  await folderInit(entry);
  const probe = await json([
    entry,
    "self-check",
    "--json",
    "--base",
    base,
    "--folder",
    folder,
    "--launchpad",
  ]);
  same("the Launchpad probe on the new Folder", probe.launchpad, {
    probe: "ok",
  });
  if (supervised) {
    // The same one command with arguments: the supervised Launchpad.
    const service = await oneCommand(
      "--service",
      "systemd-user",
      "--folder",
      folder,
    );
    same("install.sh --service exit status", service.code, 0);
    same("unit enabled", await systemctl("is-enabled", unit), "enabled");
    await waitFor(
      "Launchpad on the candidate",
      60,
      launchpadOn(candidate.version),
    );
  } else {
    const launchpad = await launchpadOnce(entry);
    same(
      "Launchpad started",
      launchpad.started.scope,
      "local-development-profile-panel",
    );
    same("its page", launchpad.status, 200);
    same("stopped by SIGTERM", launchpad.exit, 0);
  }
  await healthy();
}

/** J2: the previous final release, installed and running on a Folder it
 * rendered, updates to the candidate through GitHub and Sigstore by its own
 * updater; the candidate's first command converges what it left. */
async function updateFromPrevious(candidate: Candidate) {
  const previous = await previousFinal(candidate.version);
  const from = versionOfTag(previous) as string;
  const old = await release(previous);
  await folderInit(old);
  same(
    "the previous release installed",
    (await installStaged(old)).kind,
    "installed",
  );
  if (supervised) await waitFor(`Launchpad on ${from}`, 60, launchpadOn(from));
  const updated = await json([
    selector,
    "update",
    "--version",
    candidate.tag,
    "--json",
  ]);
  same(
    "update to the candidate",
    [updated.exit, updated.kind, updated.from, updated.to],
    [0, "updated", from, candidate.version],
  );
  same("selector", await readSelector(base), candidate.version);
  same("high-water", await readHighWater(base), candidate.version);
  same(
    "the active executable",
    (await json([selector, "--version", "--json"])).commit,
    candidate.commit,
  );
  if (supervised)
    await waitFor(
      "Launchpad on the candidate",
      60,
      launchpadOn(candidate.version),
    );
  const again = await json([selector, "update", "--json"]);
  same("the candidate's own update: up to date", again.kind, "up-to-date");
  const status = await json([selector, "update", "status", "--json"]);
  same(
    "update status",
    [
      status.active,
      status.highWater,
      status.legacyRollbackState,
      status.stateInvalid,
    ],
    [candidate.version, candidate.version, false, null],
  );
  same("only the active version is kept", await versions(), [
    candidate.version,
  ]);
  await healthy();
}

/** J3: the candidate's Launchpad probe refuses before the switch — a Folder
 * with an interrupted transaction — and nothing changes; repaired, the same
 * candidate goes forward. Supervised, the candidate is the updater (the
 * offline update); unsupervised no updater probes, so the probe runs alone. */
async function probeRefusal(candidate: Candidate) {
  const previous = await previousFinal(candidate.version);
  const from = versionOfTag(previous) as string;
  const old = await release(previous);
  await folderInit(old);
  same(
    "the previous release installed",
    (await installStaged(old)).kind,
    "installed",
  );
  const pending = join(folder, ".lazurio", "transaction");
  await mkdir(pending);
  if (supervised) {
    await waitFor(`Launchpad on ${from}`, 60, launchpadOn(from));
    const pid = await unitProperty("MainPID");
    const refused = await json([candidate.executable, "install", "--json"]);
    same(
      "refused before the switch",
      [
        refused.exit,
        refused.code,
        refused.context?.reason,
        refused.context?.refusal,
      ],
      [
        1,
        "self-check-failed",
        "launchpad-refused",
        "folder-transaction-pending",
      ],
    );
    same("selector unchanged", await readSelector(base), from);
    same("the candidate was removed", await versions(), [from]);
    same("the Launchpad was not restarted", await unitProperty("MainPID"), pid);
  } else {
    const refused = await json([
      candidate.executable,
      "self-check",
      "--json",
      "--base",
      base,
      "--folder",
      folder,
      "--launchpad",
    ]);
    same(
      "the probe refuses",
      [refused.exit, refused.launchpadRefused],
      [1, "folder-transaction-pending"],
    );
    same("selector unchanged", await readSelector(base), from);
  }
  await rm(pending, { recursive: true });
  const updated = await json([candidate.executable, "install", "--json"]);
  same(
    "repaired, the candidate goes forward",
    [updated.exit, updated.kind, updated.to],
    [0, "updated", candidate.version],
  );
  same("selector", await readSelector(base), candidate.version);
  await healthy();
}

/** J4: a Folder this version cannot read (an unknown key: R1) puts the
 * Launchpad into Recovery mode instead of an exit, and `lazurio recover`
 * answers broken (exit 3) with the repair prompt and a prepared issue that
 * names nothing of this Machine; the repaired Folder starts normally. */
async function recoveryMode(candidate: Candidate) {
  await folderInit(candidate.executable);
  same(
    "the candidate installed",
    (await installStaged(candidate.executable)).kind,
    "installed",
  );
  await healthy();
  const preferences = join(folder, ".lazurio", "preferences.json");
  const original = await readFile(preferences, "utf8");
  await writeFile(
    preferences,
    JSON.stringify({ ...JSON.parse(original), fromTheFuture: true }),
  );
  if (supervised) {
    await systemctl("restart", unit);
    await waitFor("the Launchpad serves Recovery mode", 60, async () => {
      const result = await recover(true);
      return (
        checkOf(result, "launchpad-health")?.code === "launchpad-recovery-mode"
      );
    });
    const restarts = await unitProperty("NRestarts");
    await Bun.sleep(15_000);
    same(
      "the unit keeps running",
      await systemctl("is-active", unit),
      "active",
    );
    same(
      "Recovery mode does not exit (NRestarts)",
      await unitProperty("NRestarts"),
      restarts,
    );
  } else {
    const launchpad = await launchpadOnce(selector);
    same("Launchpad started", launchpad.started, {
      scope: "recovery-mode",
      check: "start-refused",
      reason: "folder-state-unreadable",
    });
    same("its page", launchpad.status, 503);
  }
  const broken = await recover();
  same("recover", [broken.exit, broken.verdict], [3, "broken"]);
  same(
    "the Folder check",
    [
      checkOf(broken, "folder-state")?.outcome,
      checkOf(broken, "folder-state")?.code,
    ],
    ["failed", "folder-state-unreadable"],
  );
  same(
    "a repair prompt",
    typeof broken.prompt === "string" && broken.prompt.length > 0,
    true,
  );
  same(
    "a prepared issue for the public repository",
    [broken.issue?.kind, broken.issue?.repository],
    ["prepared", repository],
  );
  for (const [what, value] of [
    ["home directory", home],
    ["hostname", hostname()],
  ] as const)
    same(
      `the issue body names no ${what}`,
      broken.issue.body.includes(value),
      false,
    );
  await writeFile(preferences, original);
  if (supervised) await systemctl("restart", unit);
  await healthy();
}

/** J5: a layout with program rollback — v0.1.6 updated offline to v0.1.7,
 * which leaves `previous` and, supervised, the rollback unit and `OnFailure=` —
 * updated to the candidate by the last updater with rollback; the candidate's
 * first mutating command removes all of it (docs/update.md "Migration from
 * releases with rollback"). */
async function migration(candidate: Candidate) {
  const [first, last] = legacyReleases;
  const older = await release(first);
  const newer = await release(last);
  await folderInit(older);
  same(`${first} installed`, (await installStaged(older)).kind, "installed");
  const offline = await json([newer, "install", "--json"]);
  same(
    `offline update to ${last}`,
    [offline.kind, offline.to],
    ["updated", versionOfTag(last)],
  );
  same("previous is left", await linkExists(join(base, "previous")), true);
  const rollbackUnit = unitFile("lazurio-rollback.service");
  if (supervised) {
    same("the rollback unit is left", await exists(rollbackUnit), true);
    same(
      "the Launchpad unit has OnFailure=",
      (await readFile(unitFile(unit), "utf8")).includes("OnFailure="),
      true,
    );
    await waitFor(
      `Launchpad on ${last}`,
      60,
      launchpadOn(versionOfTag(last) as string),
    );
  }
  const updated = await json([
    selector,
    "update",
    "--version",
    candidate.tag,
    "--json",
  ]);
  same(
    `${last}'s updater takes the candidate`,
    [updated.exit, updated.kind, updated.to],
    [0, "updated", candidate.version],
  );
  same(
    "legacy rollback state reported",
    (await json([selector, "update", "status", "--json"])).legacyRollbackState,
    true,
  );
  const converged = await json([selector, "update", "--json"]);
  same(
    "the candidate's own update",
    [converged.exit, converged.kind],
    [0, "up-to-date"],
  );
  same("previous removed", await linkExists(join(base, "previous")), false);
  same(
    "no activation marker",
    await exists(join(base, "update", "pending.json")),
    false,
  );
  same("only the active version is kept", await versions(), [
    candidate.version,
  ]);
  if (supervised) {
    same("the rollback unit removed", await exists(rollbackUnit), false);
    same(
      "the Launchpad unit rewritten without OnFailure=",
      (await readFile(unitFile(unit), "utf8")).includes("OnFailure="),
      false,
    );
    same("OnFailure (loaded)", await unitProperty("OnFailure"), "");
    same("Restart (loaded)", await unitProperty("Restart"), "always");
  }
  same(
    "legacy rollback state gone",
    (await json([selector, "update", "status", "--json"])).legacyRollbackState,
    false,
  );
  await healthy();
}

const journeys = {
  J1: firstInstall,
  J2: updateFromPrevious,
  J3: probeRefusal,
  J4: recoveryMode,
  J5: migration,
} as const;

if (import.meta.main) {
  const [name, directory, ...rest] = process.argv.slice(2);
  if (
    rest.length ||
    !directory ||
    !(name === "verify" || (name ?? "") in journeys)
  ) {
    console.error(
      "Usage: journeys.ts <verify|J1|J2|J3|J4|J5> <candidate directory>",
    );
    process.exit(2);
  }
  if (
    process.env.LAZURIO_QUALIFY_DISPOSABLE !== "1" ||
    !home.startsWith("/") ||
    !base ||
    home === (await accountHome())
  ) {
    console.error(
      "Refused: a disposable HOME only, never the account's own (see the header)",
    );
    process.exit(2);
  }
  try {
    if (name === "verify") await verify(directory);
    else {
      if (
        (await exists(base)) ||
        (await exists(folder)) ||
        (await exists(unitFile(unit)))
      )
        throw new Error("This Machine already has an installation");
      if (supervised) {
        const manager = await systemctl("is-system-running");
        if (manager !== "running" && manager !== "degraded")
          throw new Error(
            `No systemd user manager (${manager || "none"}); linger?`,
          );
      }
      await journeys[name as keyof typeof journeys](
        await candidateIn(directory),
      );
    }
    console.log(`${name}: ok`);
  } catch (error) {
    console.error(`${name}: FAILED — ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
