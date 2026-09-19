import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writtenSchemas } from "./activate";
import { type ServiceSpec, systemdUnitPattern } from "./activation-record";
import { type CheckInput, checkForUpdate } from "./check";
import { changeUpdateConfig } from "./config";
import { downloadSignedIdentity } from "./download";
import { writeDurableFile } from "./durable-file";
import {
  type ErrorContext,
  type UpdateError,
  type UpdateErrorCode,
  UpdateFailure,
  updateError,
} from "./errors";
import { layout, swapSelector, versionName } from "./layout";
import { type ProcessRunner, runProcess } from "./self-check";
import { serviceCommandTimeoutMs, serviceEnvironment } from "./service-control";
import { removeVersion, sha256File, stageCandidate } from "./stage";

/** `lazurio install`: the running executable stages ITSELF as the first
 * version (docs/update.md "Surfaces"). The model is "HTTPS bootstrap, then
 * TUF": a person or the hosting engine obtained this file over HTTPS; before
 * it installs anything it proves, through an ordinary trust refresh, that its
 * own bytes are a signed artifact of the repository and that the signed
 * identity is the identity compiled into it.
 *
 * All or nothing: every refusal — and a service manager that says no — leaves
 * no selector, no version, no unit of ours, and no base that was not there
 * before. It installs only once: with a selector present the answer is
 * `already-installed`; versions change through `lazurio update`.
 */
export const defaultLaunchpadUnit = "lazurio-launchpad.service";

export type LaunchpadServiceRequest = Readonly<{
  unit: string;
  /** Where user units live: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
  unitDirectory: string;
  /** The Launchpad's explicit arguments; there is no Folder discovery. */
  folder: string;
  organizationDirectory?: string | undefined;
  bunExecutable?: string | undefined;
}>;

export function userUnitDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const config =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : env.HOME && isAbsolute(env.HOME)
        ? join(env.HOME, ".config")
        : undefined;
  return config === undefined ? undefined : join(config, "systemd", "user");
}

/** One argument of an `ExecStart=` line. systemd splits on whitespace, expands
 * `%` specifiers and `$` variables and understands C-style escapes inside
 * double quotes; a path must survive all of that unchanged.
 */
export function systemdQuote(argument: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  if (argument === "" || /[\u0000-\u001f\u007f]/.test(argument))
    throw new UpdateFailure("invalid-request", { option: "unit-argument" });
  if (/^[A-Za-z0-9_@/.:=+-]+$/.test(argument)) return argument;
  return `"${argument
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")}"`;
}

export const unitMarker =
  "# Written by `lazurio install`. `lazurio update` restarts this unit by name.";

/** The whole unit, as a pure function of the decision. `ExecStart` is the
 * SELECTOR, so a restart runs whatever version is selected; the base is
 * explicit, so the Launchpad announces its readiness where the updater looks
 * whatever the service manager's environment says.
 */
export function renderLaunchpadUnit(input: {
  base: string;
  service: LaunchpadServiceRequest;
}): string {
  const { service } = input;
  const command = [
    layout(input.base).selector,
    "launchpad",
    "--base",
    input.base,
    "--folder",
    service.folder,
    ...(service.organizationDirectory === undefined
      ? []
      : ["--organization-directory", service.organizationDirectory]),
    ...(service.bunExecutable === undefined
      ? []
      : ["--bun-executable", service.bunExecutable]),
  ];
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Launchpad",
    "",
    "[Service]",
    `ExecStart=${command.map(systemdQuote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export type InstallInput = CheckInput &
  Readonly<{
    /** `process.execPath`: the file that is running. */
    executable: string;
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    service?: LaunchpadServiceRequest | undefined;
    run?: ProcessRunner | undefined;
  }>;

export type InstallResult =
  | Readonly<{
      kind: "installed";
      version: string;
      name: string;
      /** Directory to put on PATH. Shell profiles are never edited. */
      path: string;
      service: ServiceSpec;
      /** What the channel offers beyond this version, if anything. */
      available: string | null;
    }>
  | (Readonly<{ kind: "error" }> & UpdateError);

const failed = (code: UpdateErrorCode, context: ErrorContext = {}) =>
  Object.freeze({ kind: "error" as const, ...updateError(code, context) });
const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

export async function performInstall(
  input: InstallInput,
): Promise<InstallResult> {
  const { base, service } = input;
  if (!isAbsolute(base) || resolve(base) !== base)
    return failed("invalid-request", { option: "base" });
  const paths = layout(base);
  // ANY entry at the selector — even one this product cannot read — belongs
  // to an installation: never adopted, never replaced.
  if (await present(paths.selector)) return failed("already-installed");
  const run = input.run ?? runProcess;

  // Everything about the service that can be refused is refused first.
  let unitFile: string | undefined;
  let unitText: string | undefined;
  if (service) {
    if (input.platform !== "linux")
      return failed("invalid-request", { option: "service" });
    const absolute = (value: string | undefined) =>
      value === undefined || (isAbsolute(value) && resolve(value) === value);
    if (
      !systemdUnitPattern.test(service.unit) ||
      !absolute(service.unitDirectory) ||
      !absolute(service.folder) ||
      !absolute(service.organizationDirectory) ||
      !absolute(service.bunExecutable)
    )
      return failed("invalid-request", { option: "service" });
    try {
      unitText = renderLaunchpadUnit({ base, service });
    } catch (error) {
      return error instanceof UpdateFailure
        ? failed(error.failure.code, error.failure.context)
        : failed("internal", { stage: "unit" });
    }
    unitFile = join(service.unitDirectory, service.unit);
    // A unit we did not write is someone else's — a hosting engine's resident
    // unit, a person's own. Identical content is this command repeated.
    const existing = await readFile(unitFile, "utf8").catch(() => undefined);
    if (
      (existing === undefined && (await present(unitFile))) ||
      (existing !== undefined && existing !== unitText)
    )
      return failed("unit-conflict", { unit: service.unit });
  }

  let sha256: string;
  let length: number;
  try {
    sha256 = await sha256File(input.executable);
    length = (await stat(input.executable)).size;
  } catch {
    return failed("unverified-executable", { reason: "unreadable" });
  }
  const name = versionName(input.identity.version, sha256);
  // Directories `mkdir -p` of the base will create, innermost first. An
  // undone installation removes the base and then each of them ONLY while it
  // is empty: nothing of anyone else's is ever deleted.
  const absent: string[] = [];
  for (let at = base; !(await present(at)); at = dirname(at)) {
    absent.push(at);
    if (dirname(at) === at) break;
  }
  const created: (() => Promise<void>)[] = [];
  const undo = async () => {
    for (const step of created.reverse()) await step().catch(() => undefined);
    if (absent[0] !== base) return;
    await rm(base, { recursive: true, force: true });
    for (const directory of absent.slice(1))
      if (
        !(await rmdir(directory).then(
          () => true,
          () => false,
        ))
      )
        break;
  };
  const spec: ServiceSpec = service
    ? { kind: "systemd-user", unit: service.unit }
    : { kind: "none" };

  const checked = await checkForUpdate(
    input,
    async (session) => {
      // 1. These bytes are a signed artifact…
      const artifact = {
        path: `artifacts/${sha256}/lazurio`,
        sha256,
        length,
      };
      const info = await session.updater.getTargetInfo(artifact.path);
      if (!info || info.length !== length || info.hashes.sha256 !== sha256)
        throw new UpdateFailure("unverified-executable", {
          reason: "unsigned",
        });
      // 2. …whose signed identity is the identity compiled into them.
      const { bytes, identity } = await downloadSignedIdentity(session, {
        target: input.identity.target,
        version: input.identity.version,
        artifact,
        requiredSchemas: writtenSchemas(),
      });
      if (identity.sourceCommit !== input.identity.commit)
        throw new UpdateFailure("identity-invalid", { reason: "commit" });
      // 3. Stage a COPY, and hold the copy against the digest: the file could
      // have changed since it was hashed.
      const copy = join(session.scratch, "artifact");
      await copyFile(input.executable, copy);
      if ((await sha256File(copy)) !== sha256)
        throw new UpdateFailure("unverified-executable", { reason: "changed" });
      for (const directory of [base, paths.update, join(base, "trust")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      }
      created.push(() => removeVersion(base, name));
      await stageCandidate({
        base,
        scratch: session.scratch,
        artifactFile: copy,
        identityBytes: bytes,
        identity,
        run,
      });
      // Recorded together with the channel this installation verified
      // against. An undone installation puts back exactly what was there — a
      // channel chosen beforehand is not ours to forget.
      const write = input.writeDurable ?? writeDurableFile;
      const replaced = await changeUpdateConfig(
        base,
        {
          channel: input.channel,
          service: spec,
          folder: service?.folder ?? null,
        },
        write,
      );
      created.push(() =>
        replaced === undefined
          ? rm(join(paths.update, "config.json"), { force: true })
          : write(paths.update, "config.json", replaced),
      );
      created.push(() => rm(paths.selector, { force: true }));
      await swapSelector(base, name);
      return name;
    },
    { always: true },
  );
  if (checked.kind === "error") {
    await undo();
    return checked;
  }

  if (service && unitFile !== undefined && unitText !== undefined) {
    const systemctl = async (...args: string[]) => {
      const result = await run(
        ["systemctl", "--user", ...args],
        serviceCommandTimeoutMs,
        serviceEnvironment(input.env),
      ).catch(() => "timeout" as const);
      if (result === "timeout" || result.exitCode !== 0)
        throw new UpdateFailure("service-failed", { command: args[0] ?? "" });
    };
    try {
      if (!(await present(unitFile))) {
        // The user's own directories are created, never re-moded.
        await mkdir(dirname(unitFile), { recursive: true });
        created.push(async () => {
          await rm(unitFile, { force: true });
          await systemctl("daemon-reload");
        });
        await writeDurableFile(
          dirname(unitFile),
          service.unit,
          Buffer.from(unitText),
        );
      }
      await systemctl("daemon-reload");
      created.push(() => systemctl("disable", "--now", service.unit));
      await systemctl("enable", "--now", service.unit);
    } catch (error) {
      await undo();
      return error instanceof UpdateFailure
        ? failed(error.failure.code, error.failure.context)
        : failed("service-failed", { command: "unit" });
    }
  }
  return Object.freeze({
    kind: "installed",
    version: input.identity.version,
    name,
    path: paths.bin,
    service: spec,
    available: checked.kind === "available" ? checked.version : null,
  });
}
