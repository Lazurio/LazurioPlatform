import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { folderStateSchemas } from "../folder/state";
import { readOwnedDeclarationBytes } from "../providers/owned-json";
import { activateStagedProduct, readActiveProduct } from "./activation";
import { pilotTargets } from "./channel";
import {
  prepareInstallLocation,
  resolveInstallLocation,
  verifyInstallLocation,
} from "./install-location";
import {
  downloadPilotUnderOwner,
  readPublishedPilotTrust,
  recoverPilotAttempts,
} from "./installation-state";
import { stagePilotCandidate } from "./staging";

/** `lazurio product <install|recover|status|activate>`: the explicit terminal
 * entry to the pilot distribution owner for this account's per-user location.
 * Network use happens only in `install`/`recover`; origins are explicit
 * arguments and there is no production default, `latest` or automatic check.
 */
export const productHelp = `product install --bootstrap-root <owned file> --metadata-url <https://.../metadata/>
  --target-url <https://.../targets/> [--loopback-fixture]
  Downloads the pilot channel's artifact for this Machine through TUF, stages it
  into the per-user product location and activates it through the stable
  entrypoint <base>/bin/lazurio. The bootstrap root is required only while no
  trust was ever published here and refused afterwards. --loopback-fixture
  permits only an explicit http://127.0.0.1 development origin.
product recover [--bootstrap-root <owned file>]
  [--metadata-url <https://.../metadata/> --target-url <https://.../targets/>]
  [--loopback-fixture]
  Reconciles pending attempts offline by default. Explicit URLs allow missing
  metadata/channel responses to be completed after reverifying the retained
  prefix. Expired or inconsistent evidence is not bypassed. Product artifacts
  are never downloaded or activated by recovery; then use product install.
product status
  Reports the location, published trust and active version without changes.
product activate --name <version+digest>
  Activates an already staged version; the previous name is retained.
The per-user location is derived from HOME (and XDG_DATA_HOME on Linux); it is
never a Lazurio Folder. Windows and PATH integration remain unqualified.`;

export async function runProductCommand(args: string[]): Promise<{
  code: number;
  result: unknown;
}> {
  const command = args[0];
  const { values, positionals, tokens } = parseArgs({
    args: args.slice(1),
    strict: true,
    tokens: true,
    options: {
      "bootstrap-root": { type: "string" },
      "metadata-url": { type: "string" },
      "target-url": { type: "string" },
      "loopback-fixture": { type: "boolean" },
      name: { type: "string" },
    },
  });
  const supplied = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (supplied.has(token.name)) throw new Error("Duplicate product option");
    supplied.add(token.name);
  }
  if (positionals.length !== 0) throw new Error("Unexpected product argument");
  const allowed: Record<string, readonly string[]> = {
    install: [
      "bootstrap-root",
      "metadata-url",
      "target-url",
      "loopback-fixture",
    ],
    recover: [
      "bootstrap-root",
      "metadata-url",
      "target-url",
      "loopback-fixture",
    ],
    status: [],
    activate: ["name"],
  };
  if (!command || !Object.hasOwn(allowed, command))
    throw new Error("Expected product command");
  for (const option of supplied)
    if (!(allowed[command] as readonly string[]).includes(option))
      throw new Error("Option does not belong to this product command");
  const platform = process.platform;
  const executionTarget = `${platform === "win32" ? "windows" : platform}-${process.arch}`;
  if (!pilotTargets.has(executionTarget) || platform === "win32")
    throw new Error("Unqualified execution target");
  if (!process.env.HOME) throw new Error("Account home required");
  const resolved = resolveInstallLocation({
    platform,
    env: process.env,
    homedir: process.env.HOME,
  });
  const entrypoint = join(resolved.base, "bin", "lazurio");
  if (command === "status" && !(await exists(resolved.base)))
    return {
      code: 0,
      result: {
        kind: "product-status",
        base: resolved.base,
        executionTarget,
        published: null,
        active: null,
        entrypoint,
      },
    };
  const bootstrap = async (): Promise<string> => {
    const path = values["bootstrap-root"];
    if (path === undefined) throw new Error("Bootstrap root file required");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readOwnedDeclarationBytes(path),
    );
  };
  // Every argument is validated before the location is created or verified.
  const network =
    command === "install" ||
    (command === "recover" &&
      ["metadata-url", "target-url", "loopback-fixture"].some((key) =>
        supplied.has(key),
      ))
      ? distributionInputs(values)
      : undefined;
  if (command === "activate" && !values.name)
    throw new Error("Explicit staged version name required");
  // The bootstrap file is read (with custody checks) before any location
  // exists; whether it is required or refused is decided afterwards.
  const bootstrapRoot =
    values["bootstrap-root"] === undefined ? undefined : await bootstrap();
  if (
    command === "install" &&
    bootstrapRoot === undefined &&
    !(await exists(resolved.base))
  )
    throw new Error("First installation requires --bootstrap-root");
  // Only install may create the location; every other command verifies it.
  const location =
    command === "install"
      ? await prepareInstallLocation(resolved)
      : await verifyInstallLocation(resolved);
  if (command === "status") {
    const published = await readPublishedPilotTrust(location.owner);
    const active = await readActiveProduct(location);
    return {
      code: 0,
      result: {
        kind: "product-status",
        base: location.base,
        executionTarget,
        published: published
          ? {
              generation: published.generation,
              channel: published.trust.channel,
            }
          : null,
        active: active
          ? {
              name: active.name,
              artifactSha256: active.artifactSha256,
              previous: active.previous,
            }
          : null,
        entrypoint,
      },
    };
  }
  if (command === "activate") {
    const active = await activateStagedProduct({
      location,
      name: values.name as string,
      executionTarget,
    });
    return {
      code: 0,
      result: {
        kind: "product-activated",
        name: active.name,
        previous: active.previous,
        alreadyActive: active.alreadyActive,
        entrypoint,
      },
    };
  }
  if (command === "recover") {
    const recovered = await recoverPilotAttempts({
      root: location.owner,
      ...(bootstrapRoot === undefined ? {} : { bootstrapRoot }),
      executionTarget,
      ...(network
        ? {
            network: {
              metadataBaseUrl: network.metadataBaseUrl.href,
              targetBaseUrl: network.targetBaseUrl.href,
              allowedOrigins: network.origins,
              loopbackFixture: network.loopbackFixture,
              timeoutMs: 120_000,
              signal: new AbortController().signal,
            },
          }
        : {}),
    });
    return {
      code: 0,
      result: { kind: "product-recovered", attempts: recovered },
    };
  }
  if (!network) throw new Error("Expected product command");
  const { metadataBaseUrl, targetBaseUrl, loopbackFixture, origins } = network;
  const published = await readPublishedPilotTrust(location.owner);
  if (published && values["bootstrap-root"] !== undefined)
    throw new Error("Trust already established; bootstrap root refused");
  if (!published && values["bootstrap-root"] === undefined)
    throw new Error("First installation requires --bootstrap-root");
  const downloaded = await downloadPilotUnderOwner({
    root: location.owner,
    ...(published ? {} : { bootstrapRoot: bootstrapRoot as string }),
    executionTarget,
    metadataBaseUrl: metadataBaseUrl.href,
    targetBaseUrl: targetBaseUrl.href,
    allowedOrigins: origins,
    timeoutMs: 120_000,
    signal: new AbortController().signal,
    maxArtifactBytes: 512 * 1024 * 1024,
    loopbackFixture,
  });
  const staged = await stagePilotCandidate({
    location,
    attempt: downloaded.attempt,
    executionTarget,
    requiredSchemas: folderStateSchemas,
  });
  const active = await activateStagedProduct({
    location,
    name: staged.name,
    executionTarget,
  });
  return {
    code: 0,
    result: {
      kind: "product-installed",
      base: location.base,
      attempt: downloaded.attempt,
      channelSequence: downloaded.published.trust.channel.sequence,
      staged: staged.name,
      version: staged.identity.version,
      artifactSha256: staged.identity.artifactSha256,
      active: { name: active.name, previous: active.previous },
      entrypoint,
    },
  };
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function distributionInputs(values: {
  "metadata-url"?: string;
  "target-url"?: string;
  "loopback-fixture"?: boolean;
}) {
  const metadataBaseUrl = distributionUrl(values["metadata-url"]);
  const targetBaseUrl = distributionUrl(values["target-url"]);
  const loopbackFixture = values["loopback-fixture"] === true;
  const origins = [...new Set([metadataBaseUrl.origin, targetBaseUrl.origin])];
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol === "https:") continue;
    if (
      loopbackFixture &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1"
    )
      continue;
    throw new Error("Distribution origin must be HTTPS");
  }
  return { metadataBaseUrl, targetBaseUrl, loopbackFixture, origins };
}

function distributionUrl(input: string | undefined) {
  if (!input) throw new Error("Explicit distribution URL required");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid distribution URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/")
  )
    throw new Error("Distribution URL must be a plain base path ending with /");
  return url;
}
