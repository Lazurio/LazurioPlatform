import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DistributionTransport } from "../src/distribution/transport";
import { PublishError } from "../src/publish/errors";
import {
  isRoleName,
  type RoleName,
  type Signer,
  signerFromPem,
} from "../src/publish/keys";
import { timestampPath } from "../src/publish/metadata";
import {
  addRelease,
  loadRepository,
  type PublishOptions,
  promote,
  type RefreshRole,
  type ReleaseArtifact,
  referencedObjects,
  refresh,
  repositoryStatus,
} from "../src/publish/repository";
import { applyPlan, directoryTree, hashFile } from "../src/publish/tree";
import { isUpdateChannel } from "../src/update/channel";
import {
  defaultArtifactOrigins,
  defaultMetadataBaseUrl,
  defaultRepositoryOrigin,
} from "../src/update/defaults";
import { updateTargets } from "../src/update/identity";

/** Command line of the publisher core (`src/publish/`), run by the release and
 * refresh workflows and by a person with a local tree. It works on a DIRECTORY
 * — the checked-out `gh-pages` tree; committing, pushing and deploying that
 * directory is the workflow's job. The only network use is `verify`, which
 * downloads the signed artifact locations exactly as a client would.
 *
 * Private keys are read from the environment variables below (GitHub Actions
 * secrets, by name) or from `--keys-dir` (files written by
 * `scripts/release-keys.ts generate`). A key is needed only for a role that
 * the operation actually signs.
 */
export const keyEnvironment: Readonly<
  Record<Exclude<RoleName, "root">, string>
> = Object.freeze({
  targets: "LAZURIO_TUF_TARGETS_KEY",
  snapshot: "LAZURIO_TUF_SNAPSHOT_KEY",
  timestamp: "LAZURIO_TUF_TIMESTAMP_KEY",
});

export const releasePublishHelp = `Common: --tree <absolute directory> [--root <release/root.json>] [--keys-dir <directory>]
  [--lifetime-days role=days,...] [--margin-days role=days,...] [--json]
  Keys: ${Object.values(keyEnvironment).join(", ")} (PKCS#8 PEM) or --keys-dir.
add-release --channel <preview|stable> --version <semver> --notes-file <file>
  --assets-dir <directory with lazurio-<target> and lazurio-<target>.identity.json>
  [--targets <target,...>] [--asset-url-base <https://.../releases/download/<tag>/>]
  [--minimum-version <semver>]
  Signs the artifacts, identities, notes and the channel document. With
  --asset-url-base the executables stay release assets and their URL is signed;
  without it they are published inside the tree. Every supported target must be
  present unless --targets names the ones this release has. Repeating it is a no-op.
promote --version <semver> [--minimum-version <semver>]
  New signed stable document naming the artifacts preview offers for exactly
  this version: the same digests, never a rebuild. --minimum-version is the ONLY
  way the signed minimum version of stable changes; it can only rise, never above
  the promoted version. Repeating a promotion with a higher one raises it alone.
refresh [--roles <targets,snapshot,timestamp>] [--when-low]
  Re-signs with a fresh expiry; no target changes. --when-low renews snapshot
  and timestamp only when below their margin. Without roles it only installs
  --root and re-signs what that root requires.
status
  Remaining validity of every role. Exit 3 when a role is below its margin.
verify [--all-urls] [--artifact-origin <origin>]... [--loopback-fixture]
  Proves every object the current metadata references: files inside the tree by
  length and digest, and the signed download location of every artifact a
  channel selects (--all-urls: of every artifact) over the network.
pages-domain
  Prints the host of the compiled-in repository origin: the content of the CNAME
  file GitHub Pages needs in the tree. Needs no --tree.
await-deployment [--metadata-url <https://.../metadata/>] [--timeout-seconds <n>]
  Waits until the published origin (default: the one compiled into the product)
  answers the client's own timestamp.json URL with the tree's bytes. It proves
  the origin as seen from where it runs, not every cache in the world.`;

type Output = Readonly<{ code: number; stdout: string; stderr: string }>;
export const exitValidityLow = 3;

function roleDays(value: string | undefined, option: string) {
  const days: Partial<Record<RoleName, number>> = {};
  for (const part of value?.split(",") ?? []) {
    const match = /^([a-z]+)=([1-9]\d{0,3})$/.exec(part);
    if (!match || !isRoleName(match[1]))
      throw new PublishError("invalid-input", option);
    days[match[1]] = Number(match[2]);
  }
  return days;
}

async function loadSigners(
  keysDirectory: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Partial<Record<RoleName, Signer>>> {
  const signers: Partial<Record<RoleName, Signer>> = {};
  for (const role of ["targets", "snapshot", "timestamp"] as const) {
    let pem = env[keyEnvironment[role]];
    if (!pem && keysDirectory !== undefined) {
      const path = join(keysDirectory, `${role}.private.pem`);
      const stat = await lstat(path).catch(() => undefined);
      if (stat) {
        if (!stat.isFile() || (stat.mode & 0o077) !== 0)
          throw new PublishError("key-invalid", `${role} key file mode`);
        pem = await readFile(path, "utf8");
      }
    }
    if (pem) signers[role] = signerFromPem(pem);
  }
  return signers;
}

/** The build's `identity.json` wraps the identity in its "unsigned candidate"
 * statement (`scripts/build-candidate.ts`); what gets signed is the identity.
 */
async function releaseArtifacts(
  directory: string,
  urlBase: string | undefined,
  targets: readonly string[],
): Promise<ReleaseArtifact[]> {
  if (
    (urlBase !== undefined && !urlBase.endsWith("/")) ||
    targets.length === 0 ||
    targets.some(
      (target) => !(updateTargets as readonly string[]).includes(target),
    )
  )
    throw new PublishError("invalid-input", "targets or asset-url-base");
  const artifacts: ReleaseArtifact[] = [];
  for (const target of targets) {
    const file = join(directory, `lazurio-${target}`);
    // A target that silently went missing would strand its Machines.
    if (!(await lstat(file).catch(() => undefined))?.isFile())
      throw new PublishError("invalid-input", `missing lazurio-${target}`);
    const built = JSON.parse(
      await readFile(`${file}.identity.json`, "utf8"),
    ) as { identity?: unknown } | null;
    if (!built?.identity || typeof built.identity !== "object")
      throw new PublishError("invalid-input", `identity ${target}`);
    artifacts.push({
      target,
      ...(await hashFile(file)),
      identity: Buffer.from(JSON.stringify(built.identity)),
      ...(urlBase === undefined
        ? { file }
        : { url: `${urlBase}lazurio-${target}` }),
    });
  }
  return artifacts;
}

async function verifyUrl(
  transport: DistributionTransport,
  object: Readonly<{ url: string; length: number; sha256: string }>,
): Promise<void> {
  const response = await transport.openRange(
    object.url,
    0,
    new AbortController().signal,
  );
  const hash = createHash("sha256");
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > object.length) break;
      hash.update(chunk);
    }
  } finally {
    response.close();
  }
  if (length !== object.length || hash.digest("hex") !== object.sha256)
    throw new PublishError("unreachable", object.url);
}

export async function runReleasePublish(
  args: readonly string[],
  environment: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    now?: () => Date;
  }> = {},
): Promise<Output> {
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        tree: { type: "string" },
        root: { type: "string" },
        "keys-dir": { type: "string" },
        "lifetime-days": { type: "string" },
        "margin-days": { type: "string" },
        json: { type: "boolean" },
        channel: { type: "string" },
        version: { type: "string" },
        "notes-file": { type: "string" },
        "assets-dir": { type: "string" },
        "asset-url-base": { type: "string" },
        "minimum-version": { type: "string" },
        targets: { type: "string" },
        roles: { type: "string" },
        "when-low": { type: "boolean" },
        "all-urls": { type: "boolean" },
        "artifact-origin": { type: "string", multiple: true },
        "loopback-fixture": { type: "boolean" },
        "metadata-url": { type: "string" },
        "timeout-seconds": { type: "string" },
      },
    });
    json = values.json === true;
    const command = positionals[0];
    if (command === "pages-domain" && positionals.length === 1)
      return {
        code: 0,
        stdout: new URL(defaultRepositoryOrigin).host,
        stderr: "",
      };
    const directory = values.tree;
    if (
      positionals.length !== 1 ||
      !directory ||
      !isAbsolute(directory) ||
      resolve(directory) !== directory
    )
      return { code: 2, stdout: "", stderr: releasePublishHelp };
    const tree = directoryTree(directory);
    const now = (environment.now ?? (() => new Date()))();
    const margins = roleDays(values["margin-days"], "margin-days");
    const loopback = values["loopback-fixture"] === true;
    const options = async (): Promise<PublishOptions> => ({
      signers: await loadSigners(
        values["keys-dir"],
        environment.env ?? process.env,
      ),
      now,
      lifetimes: roleDays(values["lifetime-days"], "lifetime-days"),
      ...(values.root === undefined
        ? {}
        : { root: await readFile(values.root) }),
    });
    const done = (result: object, text: string): Output => ({
      code: 0,
      stdout: json ? JSON.stringify(result) : text,
      stderr: "",
    });

    if (command === "add-release") {
      if (
        !isUpdateChannel(values.channel) ||
        !values.version ||
        !values["notes-file"] ||
        !values["assets-dir"]
      )
        return { code: 2, stdout: "", stderr: releasePublishHelp };
      const plan = await addRelease(
        tree,
        {
          channel: values.channel,
          version: values.version,
          notes: await readFile(values["notes-file"], "utf8"),
          artifacts: await releaseArtifacts(
            values["assets-dir"],
            values["asset-url-base"],
            values.targets?.split(",") ?? updateTargets,
          ),
          ...(values["minimum-version"] === undefined
            ? {}
            : { minimumVersion: values["minimum-version"] }),
          allowLoopbackUrls: loopback,
        },
        await options(),
      );
      const written = await applyPlan(directory, plan);
      return done(
        { ...plan.result, written },
        `${plan.result.kind}: ${plan.result.channel} ${plan.result.version} (sequence ${plan.result.sequence}); ${written.length} files written`,
      );
    }
    if (command === "promote") {
      if (!values.version)
        return { code: 2, stdout: "", stderr: releasePublishHelp };
      const plan = await promote(
        tree,
        {
          version: values.version,
          ...(values["minimum-version"] === undefined
            ? {}
            : { minimumVersion: values["minimum-version"] }),
        },
        await options(),
      );
      const written = await applyPlan(directory, plan);
      return done(
        { ...plan.result, written },
        `${plan.result.kind}: stable ${plan.result.version} (sequence ${plan.result.sequence}); ${written.length} files written`,
      );
    }
    if (command === "refresh") {
      let roles = (
        values.roles?.split(",") ??
        (values["when-low"] === true ? ["snapshot", "timestamp"] : [])
      ).map((role) => {
        if (!["targets", "snapshot", "timestamp"].includes(role))
          throw new PublishError("invalid-input", "roles");
        return role as RefreshRole;
      });
      if (values["when-low"] === true) {
        const repository = await loadRepository(tree);
        const low = repository?.timestamp
          ? repositoryStatus(repository, now, margins).low
          : [];
        roles = roles.filter((role) => low.includes(role));
      }
      const plan = await refresh(tree, roles, await options());
      const written = await applyPlan(directory, plan);
      return done(
        { written },
        written.length
          ? `re-signed: ${written.join(", ")}`
          : "nothing to renew",
      );
    }
    if (command === "status") {
      const repository = await loadRepository(tree);
      if (!repository) throw new PublishError("repository-invalid", "empty");
      const status = repositoryStatus(repository, now, margins);
      const lines = [
        "| role | version | expires | days left | margin | state |",
        "| --- | --- | --- | --- | --- | --- |",
        ...status.roles.map(
          (role) =>
            `| ${role.role} | ${role.version} | ${role.expires} | ${role.remainingDays} | ${role.marginDays} | ${role.low ? "LOW" : "ok"} |`,
        ),
        ...(status.low.length
          ? [
              "",
              `Below margin: ${status.low.join(", ")}. Snapshot and timestamp are renewed by the scheduled refresh; targets needs the protected \`release\` environment; root needs the offline root key (docs/release-keys.md).`,
            ]
          : []),
      ];
      return {
        code: status.low.length ? exitValidityLow : 0,
        stdout: json ? JSON.stringify(status) : lines.join("\n"),
        stderr: "",
      };
    }
    if (command === "verify") {
      const referenced = await referencedObjects(tree);
      const origins = [
        ...new Set([
          ...(loopback ? [] : defaultArtifactOrigins),
          ...(values["artifact-origin"] ?? []),
        ]),
      ];
      if (origins.length === 0)
        throw new PublishError("invalid-input", "artifact-origin");
      // The client's own transport: same origin list, same redirect policy.
      const transport = new DistributionTransport(
        origins,
        30 * 60_000,
        new AbortController().signal,
        loopback,
      );
      const urls = referenced.external.filter(
        (object) =>
          values["all-urls"] === true ||
          referenced.selected.includes(object.path),
      );
      for (const object of urls) {
        try {
          await verifyUrl(transport, object);
        } catch (error) {
          if (error instanceof PublishError) throw error;
          throw new PublishError("unreachable", object.url);
        }
      }
      return done(
        { verifiedUrls: urls.map((object) => object.url) },
        `verified: the tree and ${urls.length} download locations`,
      );
    }
    if (command === "await-deployment") {
      const url = new URL(
        "timestamp.json",
        values["metadata-url"] ?? defaultMetadataBaseUrl,
      );
      const seconds = values["timeout-seconds"] ?? "1200";
      if (!/^[1-9]\d{0,4}$/.test(seconds))
        throw new PublishError("invalid-input", "timeout-seconds");
      const expected = await tree.read(timestampPath);
      if (!expected) throw new PublishError("repository-invalid", "empty");
      const transport = new DistributionTransport(
        [url.origin],
        Number(seconds) * 1000 + 60_000,
        new AbortController().signal,
        loopback,
      );
      const deadline = performance.now() + Number(seconds) * 1000;
      for (;;) {
        // The exact URL a client asks for, caches included: a cache that
        // still answers with the previous timestamp is what clients see.
        const served = await transport
          .downloadBytes(url.href, 1024 * 1024)
          .catch(() => undefined);
        if (served?.equals(expected))
          return done({ deployed: true }, `deployed: ${url.href}`);
        if (performance.now() >= deadline)
          throw new PublishError("unreachable", url.href);
        await Bun.sleep(loopback ? 50 : 10_000);
      }
    }
    return { code: 2, stdout: "", stderr: releasePublishHelp };
  } catch (error) {
    const code = error instanceof PublishError ? error.code : "failed";
    const detail =
      error instanceof PublishError
        ? error.detail
        : ((error as NodeJS.ErrnoException | undefined)?.code ?? "");
    return {
      code: 1,
      stdout: json ? JSON.stringify({ kind: "error", code, detail }) : "",
      stderr: `Refused: ${code}${detail ? ` (${detail})` : ""}`,
    };
  }
}

if (import.meta.main) {
  const output = await runReleasePublish(process.argv.slice(2));
  if (output.stdout) console.log(output.stdout);
  if (output.stderr) console.error(output.stderr);
  process.exitCode = output.code;
}
