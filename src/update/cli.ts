import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DistributionTransport } from "../distribution/transport";
import { readOwnedDeclarationBytes } from "../providers/owned-json";
import {
  type ActivationEffects,
  type ActivationOutcome,
  type ActivationPolicy,
  resumeActivation,
  runActivationWorker,
} from "./activate";
import { parseServiceSpec } from "./activation-record";
import { resolveInstallBase } from "./base";
import { isUpdateChannel } from "./channel";
import { type CheckResult, checkForUpdate } from "./check";
import { changeUpdateConfig, readUpdateConfig } from "./config";
import {
  defaultArtifactOrigins,
  defaultMetadataBaseUrl,
  defaultTargetBaseUrl,
  embeddedTrustRoot,
} from "./defaults";
import { defaultDownloadPolicy } from "./download";
import { writeDurableFile } from "./durable-file";
import {
  type ErrorContext,
  exitUpdateAvailable,
  exitUpToDate,
  type UpdateErrorCode,
  updateError,
  updateErrors,
} from "./errors";
import { embeddedIdentity, type ProductIdentity } from "./identity";
import {
  defaultLaunchpadUnit,
  type InstallResult,
  performInstall,
  userUnitDirectory,
} from "./install";
import { layout } from "./layout";
import { type Observed, readObserved } from "./observed";
import { type ProcessRunner, selfCheckReport } from "./self-check";
import { ensureOwnedDirectory } from "./trust";
import {
  performRollback,
  performUpdate,
  type RollbackResult,
  type UpdateResult,
  type WorkerLauncher,
} from "./update";

/** `lazurio update …` and `lazurio --version`: terminal surface of the one
 * update core (docs/update.md "Surfaces"). The repository, the download
 * origins and the trust root are compiled in (`defaults.ts`), the channel is
 * read from `update/config.json`; every one of them has an explicit option
 * for a fork, a mirror or a fixture.
 */
export const updateHelp = `--version [--json]
  Prints the version, source commit and target this executable was built with.
install [--channel <stable|preview>] [--base <absolute directory>]
  [--service systemd-user --folder <absolute Folder> [--unit <name.service>]
   [--organization-directory <dir> [--bun-executable <bun>]]]
  [<repository options>] [--json]
  This executable installs ITSELF as the first version: it proves through signed
  metadata that its own bytes are a published artifact with the identity
  compiled into it, copies itself to versions/, and points bin/lazurio at it.
  It downloads nothing but signed metadata and its own signed identity.
  Refused when an installation exists (already-installed): versions change
  through update. All or nothing; shell profiles are not edited. With --service
  (Linux) it writes, enables and starts a systemd user unit for the Launchpad
  (default lazurio-launchpad.service) and refuses a unit of that name it did not
  write. The channel, the service and the Folder are recorded in
  update/config.json, so update needs no flag for them.
<repository options>, for install, update and update --check:
  [--metadata-url <https://.../metadata/> --target-url <https://.../targets/>
   [--artifact-origin <https://host>]...] [--bootstrap-root <owned file>]
  [--loopback-fixture]
  The signed repository, the origins a download may touch and the trust root are
  compiled into the executable; these flags only override them (a fork, a
  mirror, a fixture). --metadata-url and --target-url come together and name
  another repository as a whole: then only its origins and every
  --artifact-origin are contacted, never the compiled-in ones.
  --bootstrap-root replaces the compiled-in root as the supplied root. A supplied
  root seeds trust while none exists; afterwards it is ignored unless it is the
  verified direct successor of the trusted root. It is never a conflict. With no
  compiled-in root and no --bootstrap-root the answer is trust-missing and
  nothing is created.
update [--download-only] [--channel <stable|preview>] [--base <absolute directory>]
  [--folder <absolute Folder>] [--service <none|systemd-user> --unit <name.service>]
  [--deadline-ms <n>] [--stability-ms <n>] [<repository options>] [--json]
  Checks, downloads, verifies and stages the channel's version and activates it:
  the selector bin/lazurio is switched and the new version must confirm itself,
  otherwise the previous version is selected again. --download-only stops after
  staging. With --folder the candidate must prove it can read that Folder's state.
  --service systemd-user restarts the named user unit and waits for a fresh,
  stable Launchpad of the new version; none (default) manages no service.
  Channel, service and Folder default to what update/config.json records.
  The activation deadline (120000 ms) and stability period (10000 ms) can be
  shortened for qualification runs.
  Exit 0 updated, staged or nothing to do; an error prints its stable code.
update --check <same origin options> [--json]
  Verifies signed metadata and the channel document, records verified trust and
  rewrites the observation. Downloads and activates nothing.
  Exit 0 up to date, 10 update available; an error prints its stable code.
update rollback [--base <absolute directory>] [--folder ...] [--service ... --unit ...] [--json]
  Activates the version the last confirmed activation replaced, through the same
  confirmation. Refused when that version cannot read the current state schemas.
update channel [stable|preview] [--base <absolute directory>] [--json]
  Prints the channel, or selects it for later checks; the recorded service and
  Folder are kept. Switching never downgrades: a channel whose version is not
  newer than the installed one reports up to date.
update status [--base <absolute directory>] [--json]
  Prints the last observation without touching the network.
self-check [--json] [--folder <absolute Folder>]
  What this executable is and whether it can read the named Folder's state.
  Reads only. The updater runs it on a candidate before staging and activating.`;

export type CommandOutput = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

const failure = (code: UpdateErrorCode, context: ErrorContext = {}) =>
  Object.freeze({ kind: "error" as const, ...updateError(code, context) });

export function versionCommand(
  args: readonly string[],
  identity: ProductIdentity = embeddedIdentity(),
): CommandOutput {
  if (args.length === 1 && args[0] === "--json")
    return { code: 0, stdout: JSON.stringify(identity), stderr: "" };
  if (args.length !== 0) return render(failure("invalid-request"), false);
  return {
    code: 0,
    stdout: `lazurio ${identity.version} (commit ${identity.commit}, target ${identity.target})`,
    stderr: "",
  };
}

function render(result: CheckResult, json: boolean): CommandOutput {
  const code =
    result.kind === "error"
      ? updateErrors[result.code].exit
      : result.kind === "available"
        ? exitUpdateAvailable
        : exitUpToDate;
  if (json) return { code, stdout: JSON.stringify(result), stderr: "" };
  if (result.kind === "error")
    return { code, stdout: "", stderr: `Update failed: ${result.code}` };
  return {
    code,
    stdout:
      result.kind === "available"
        ? `Update available: ${result.version} (channel sequence ${result.sequence}). Nothing was downloaded.`
        : `Up to date: ${result.version}.`,
    stderr: "",
  };
}

function renderStatus(observed: Observed, json: boolean): CommandOutput {
  if (json) return { code: 0, stdout: JSON.stringify(observed), stderr: "" };
  const lines = [
    `Status: ${observed.status}${observed.error ? ` (${observed.error.code})` : ""}`,
    `Channel: ${observed.channel ?? "unknown"}`,
    `Selected: ${observed.selected?.version ?? "none"}`,
    `Available: ${observed.available?.version ?? "none"}`,
    `Last authenticated check: ${observed.lastAuthenticatedCheckAt ?? "never"}`,
  ];
  return { code: 0, stdout: lines.join("\n"), stderr: "" };
}

type Rendered = UpdateResult | RollbackResult | ActivationOutcome;

function renderOperation(result: Rendered, json: boolean): CommandOutput {
  const code = result.kind === "error" ? updateErrors[result.code].exit : 0;
  if (json) return { code, stdout: JSON.stringify(result), stderr: "" };
  if (result.kind === "error") {
    const to = result.context.rolledBackTo;
    return {
      code,
      stdout: "",
      stderr: `Update failed: ${result.code}${
        typeof to === "string" && to ? ` (version ${to} is selected)` : ""
      }`,
    };
  }
  const text: Record<Exclude<Rendered["kind"], "error">, string> = {
    "up-to-date": `Up to date: ${result.version}.`,
    ready: `Version ${result.version} is downloaded and verified. Run \`lazurio update\` to activate it.`,
    updated: `Updated to ${result.version}.`,
    "rolled-back": `Rolled back to ${result.version}.`,
    confirmed: `Activated ${result.version}.`,
    "already-active": `Already active: ${result.version}.`,
  };
  return { code, stdout: text[result.kind], stderr: "" };
}

/** `lazurio self-check`: see `self-check.ts`. Exit 0, or the exit status of
 * `self-check-failed`; never a partial answer.
 */
export async function selfCheckCommand(
  args: readonly string[],
  identity: ProductIdentity = embeddedIdentity(),
): Promise<CommandOutput> {
  const refused = (code: UpdateErrorCode): CommandOutput => ({
    code: updateErrors[code].exit,
    stdout: "",
    stderr: `Self-check failed: ${code}`,
  });
  let values: { json?: boolean; folder?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { json: { type: "boolean" }, folder: { type: "string" } },
    }));
  } catch {
    return refused("invalid-request");
  }
  if (
    values.folder !== undefined &&
    (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder)
  )
    return refused("invalid-request");
  try {
    const report = await selfCheckReport(values.folder, identity);
    return {
      code: 0,
      stdout: values.json
        ? JSON.stringify(report)
        : `lazurio ${report.identity.version} can start${
            report.folder ? " and read the Folder state" : ""
          }.`,
      stderr: "",
    };
  } catch {
    return refused("self-check-failed");
  }
}

const positiveInteger = (value: string | undefined): number | undefined =>
  value !== undefined && /^[1-9]\d{0,9}$/.test(value)
    ? Number(value)
    : undefined;

type RepositoryOptions = Readonly<{
  "metadata-url"?: string | undefined;
  "target-url"?: string | undefined;
  "artifact-origin"?: string[] | undefined;
  "bootstrap-root"?: string | undefined;
  "loopback-fixture"?: boolean | undefined;
}>;

/** Where `install`, `update` and `update --check` look and whom they trust:
 * the ONE place that turns the compiled-in defaults and their overriding
 * flags into the inputs of a check.
 *
 * Another repository is named as a whole, and then ONLY what the caller named
 * is contacted: a fixture or a mirror never falls back to the compiled-in
 * origins, and the compiled-in repository never accepts extra origins. The
 * supplied root is the caller's `--bootstrap-root`, else the compiled-in one,
 * else none — and then a check without durable trust is `trust-missing`.
 */
async function resolveRepository(
  values: RepositoryOptions,
  timeoutMs: number,
  embeddedRoot: Uint8Array | undefined = embeddedTrustRoot(),
): Promise<
  | Readonly<{ invalid: string }>
  | Readonly<{
      transport: DistributionTransport;
      source: Readonly<{
        metadataBaseUrl: string;
        targetBaseUrl: string;
        bootstrapRoot?: Uint8Array;
      }>;
    }>
> {
  const explicit =
    values["metadata-url"] !== undefined || values["target-url"] !== undefined;
  const metadataBaseUrl = explicit
    ? values["metadata-url"]
    : defaultMetadataBaseUrl;
  const targetBaseUrl = explicit ? values["target-url"] : defaultTargetBaseUrl;
  if (
    !metadataBaseUrl ||
    !targetBaseUrl ||
    (!explicit && values["artifact-origin"] !== undefined)
  )
    return { invalid: "repository" };
  let transport: DistributionTransport;
  try {
    transport = new DistributionTransport(
      [
        ...new Set([
          new URL(metadataBaseUrl).origin,
          new URL(targetBaseUrl).origin,
          ...(explicit
            ? (values["artifact-origin"] ?? [])
            : defaultArtifactOrigins),
        ]),
      ],
      timeoutMs,
      new AbortController().signal,
      values["loopback-fixture"] === true,
    );
  } catch {
    return { invalid: "url" };
  }
  let bootstrapRoot = embeddedRoot;
  if (values["bootstrap-root"] !== undefined)
    try {
      // A trust anchor is read only from a caller-owned, non-shared file.
      bootstrapRoot = await readOwnedDeclarationBytes(values["bootstrap-root"]);
    } catch {
      return { invalid: "bootstrap-root" };
    }
  return {
    transport,
    source: {
      metadataBaseUrl,
      targetBaseUrl,
      ...(bootstrapRoot === undefined ? {} : { bootstrapRoot }),
    },
  };
}

/** Never throws: every refusal is a typed result with a stable exit status. */
export async function runUpdateCommand(
  args: readonly string[],
  environment: Readonly<{
    identity?: ProductIdentity;
    /** Stands in for the compiled-in root (`defaults.ts`). */
    embeddedRoot?: Uint8Array;
    clock?: () => Date;
    platform?: string;
    env?: Readonly<Record<string, string | undefined>>;
    /** Concise progress for a person; silent with `--json`. */
    progress?: (line: string) => void;
    /** Test seams of the activation: how the worker is started and the
     * effects and policy it and a resume run with. */
    launchWorker?: WorkerLauncher;
    activationEffects?: Partial<ActivationEffects>;
    activationPolicy?: Partial<ActivationPolicy>;
  }> = {},
): Promise<CommandOutput> {
  let json = args.includes("--json");
  try {
    const { values, positionals, tokens } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        check: { type: "boolean" },
        "download-only": { type: "boolean" },
        json: { type: "boolean" },
        "metadata-url": { type: "string" },
        "target-url": { type: "string" },
        channel: { type: "string" },
        "bootstrap-root": { type: "string" },
        "artifact-origin": { type: "string", multiple: true },
        base: { type: "string" },
        folder: { type: "string" },
        service: { type: "string" },
        unit: { type: "string" },
        "loopback-fixture": { type: "boolean" },
        // Worker only; written by `workerArguments`.
        candidate: { type: "string" },
        operation: { type: "string" },
        kind: { type: "string" },
        "deadline-ms": { type: "string" },
        "stability-ms": { type: "string" },
      },
    });
    json = values.json === true;
    const supplied = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name) && token.name !== "artifact-origin")
        return render(failure("invalid-request"), json);
      supplied.add(token.name);
    }
    const clock = environment.clock ?? (() => new Date());
    const env = environment.env ?? process.env;
    const base =
      values.base ??
      resolveInstallBase({
        platform: environment.platform ?? process.platform,
        env,
        homedir: env.HOME,
      });
    if (!base || !isAbsolute(base) || resolve(base) !== base)
      return render(failure("invalid-request", { option: "base" }), json);
    const only = (allowed: readonly string[]) =>
      [...supplied].every((name) => allowed.includes(name));
    // What `lazurio install` recorded about this Machine; a flag overrides it.
    const recorded = await readUpdateConfig(base);
    const folder =
      values.folder ??
      (positionals[0] === "apply-worker" || positionals[0] === "status"
        ? undefined
        : (recorded.folder ?? undefined));
    if (
      folder !== undefined &&
      (!isAbsolute(folder) || resolve(folder) !== folder)
    )
      return render(failure("invalid-request", { option: "folder" }), json);
    const service =
      values.service === undefined && values.unit === undefined
        ? recorded.service
        : parseServiceSpec(
            values.unit === undefined
              ? { kind: values.service }
              : { kind: values.service, unit: values.unit },
          );
    if (!service)
      return render(failure("invalid-request", { option: "service" }), json);
    const activation: {
      effects?: Partial<ActivationEffects>;
      policy?: Partial<ActivationPolicy>;
    } = {
      ...(environment.activationEffects || environment.clock
        ? {
            effects: {
              ...(environment.clock ? { clock: environment.clock } : {}),
              ...environment.activationEffects,
            },
          }
        : {}),
      ...(environment.activationPolicy
        ? { policy: environment.activationPolicy }
        : {}),
    };
    const serviceOptions = [
      "service",
      "unit",
      "folder",
      "deadline-ms",
      "stability-ms",
    ];
    // Qualification and canary runs shorten the accepted defaults.
    const requested = {
      deadlineMs: positiveInteger(values["deadline-ms"]),
      stabilityMs: positiveInteger(values["stability-ms"]),
    };
    if (
      (values["deadline-ms"] !== undefined &&
        requested.deadlineMs === undefined) ||
      (values["stability-ms"] !== undefined &&
        requested.stabilityMs === undefined)
    )
      return render(failure("invalid-request", { option: "deadline" }), json);
    if (
      requested.deadlineMs !== undefined ||
      requested.stabilityMs !== undefined
    )
      activation.policy = {
        ...activation.policy,
        ...(requested.deadlineMs === undefined
          ? {}
          : { deadlineMs: requested.deadlineMs }),
        ...(requested.stabilityMs === undefined
          ? {}
          : { stabilityMs: requested.stabilityMs }),
      };

    if (positionals.length === 1 && positionals[0] === "apply-worker") {
      // Internal: started by `requestActivation` from the selected version.
      const deadlineMs = positiveInteger(values["deadline-ms"]);
      const stabilityMs = positiveInteger(values["stability-ms"]);
      if (
        !only([
          "base",
          "candidate",
          "operation",
          "kind",
          "deadline-ms",
          "stability-ms",
          ...serviceOptions,
        ]) ||
        values.base === undefined ||
        values.candidate === undefined ||
        values.operation === undefined ||
        (values.kind !== "update" && values.kind !== "rollback") ||
        deadlineMs === undefined ||
        stabilityMs === undefined
      )
        return renderOperation(failure("invalid-request"), true);
      // An answer — a typed refusal included — is a finished worker: exit 0.
      // Only a worker that DIED is a failure its supervisor restarts.
      return {
        ...renderOperation(
          await runActivationWorker({
            base,
            candidate: values.candidate,
            operation: values.operation,
            kind: values.kind,
            service,
            folder,
            policy: { ...activation.policy, deadlineMs, stabilityMs },
            effects: activation.effects,
          }),
          true,
        ),
        code: 0,
      };
    }
    if (positionals[0] === "channel" && positionals.length <= 2) {
      if (!only(["json", "base"]))
        return render(failure("invalid-request"), json);
      const wanted = positionals[1];
      if (wanted !== undefined) {
        if (!isUpdateChannel(wanted))
          return render(
            failure("invalid-request", { option: "channel" }),
            json,
          );
        try {
          await mkdir(base, { recursive: true, mode: 0o700 });
          await ensureOwnedDirectory(layout(base).update);
          await changeUpdateConfig(base, { channel: wanted }, writeDurableFile);
        } catch {
          return render(
            failure("storage-unavailable", { stage: "config" }),
            json,
          );
        }
      }
      const selected = (await readUpdateConfig(base)).channel;
      return {
        code: 0,
        stdout: json
          ? JSON.stringify({ channel: selected })
          : `Channel: ${selected}`,
        stderr: "",
      };
    }
    if (positionals.length === 1 && positionals[0] === "status") {
      if (!only(["json", "base"]))
        return render(failure("invalid-request"), json);
      // Any start converges an activation whose worker died.
      await resumeActivation({ base, ...activation });
      return renderStatus(await readObserved(base, clock()), json);
    }
    if (positionals.length === 1 && positionals[0] === "rollback") {
      if (!only(["json", "base", ...serviceOptions]))
        return render(failure("invalid-request"), json);
      return renderOperation(
        await performRollback({
          base,
          service,
          folder,
          ...activation,
          launchWorker: environment.launchWorker,
        }),
        json,
      );
    }
    if (positionals.length !== 0)
      return render(failure("invalid-request"), json);
    const checking = values.check === true;
    if (
      !only([
        "json",
        "base",
        "metadata-url",
        "target-url",
        "channel",
        "bootstrap-root",
        "artifact-origin",
        "loopback-fixture",
        ...(checking ? ["check"] : ["download-only", ...serviceOptions]),
      ])
    )
      return render(failure("invalid-request"), json);
    const channel = values.channel ?? recorded.channel;
    if (!isUpdateChannel(channel))
      return render(failure("invalid-request"), json);
    const repository = await resolveRepository(
      values,
      // One transport per operation: a check is short, a download is bounded
      // by its own deadline inside this outer limit.
      checking ? 60_000 : defaultDownloadPolicy.deadlineMs + 300_000,
      environment.embeddedRoot,
    );
    if ("invalid" in repository)
      return render(
        failure("invalid-request", { option: repository.invalid }),
        json,
      );
    const { transport } = repository;
    const checkInput = {
      base,
      channel,
      identity: environment.identity ?? embeddedIdentity(),
      ...repository.source,
      transport,
      clock,
    };
    if (checking) {
      // Any start converges an activation whose worker died.
      await resumeActivation({ base, ...activation });
      return render(await checkForUpdate(checkInput), json);
    }
    const say = json ? undefined : environment.progress;
    let announced = -1;
    return renderOperation(
      await performUpdate({
        ...checkInput,
        service,
        openRange: (url, offset, signal) =>
          transport.openRange(url, offset, signal),
        downloadOnly: values["download-only"] === true,
        ...(folder === undefined ? {} : { folder }),
        ...(activation.effects
          ? { activationEffects: activation.effects }
          : {}),
        ...(activation.policy ? { activationPolicy: activation.policy } : {}),
        ...(environment.launchWorker
          ? { launchWorker: environment.launchWorker }
          : {}),
        onEvent(event) {
          if (!say) return;
          if (event.kind !== "downloading")
            say(
              event.kind === "staging"
                ? `Verifying ${event.version}…`
                : `Activating ${event.version}…`,
            );
          else if (event.percent >= announced + 10 || event.percent === 100) {
            announced = event.percent;
            say(`Downloading ${event.version}: ${event.percent} %`);
          }
        },
      }),
      json,
    );
  } catch (error) {
    // `parseArgs` refusals are usage errors; anything else is a defect.
    const usage =
      typeof (error as { code?: unknown } | undefined)?.code === "string" &&
      String((error as { code: string }).code).startsWith("ERR_PARSE_ARGS");
    return render(failure(usage ? "invalid-request" : "internal"), json);
  }
}

/** `lazurio install`: see `install.ts`. Never throws. */
export async function runInstallCommand(
  args: readonly string[],
  environment: Readonly<{
    identity?: ProductIdentity;
    /** Stands in for the compiled-in root (`defaults.ts`). */
    embeddedRoot?: Uint8Array;
    clock?: () => Date;
    platform?: string;
    env?: Readonly<Record<string, string | undefined>>;
    executable?: string;
    run?: ProcessRunner;
  }> = {},
): Promise<CommandOutput> {
  let json = args.includes("--json");
  const refuse = (code: UpdateErrorCode, context: ErrorContext = {}) =>
    renderInstall(failure(code, context), json);
  try {
    const { values, tokens } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        json: { type: "boolean" },
        "metadata-url": { type: "string" },
        "target-url": { type: "string" },
        channel: { type: "string" },
        "bootstrap-root": { type: "string" },
        "artifact-origin": { type: "string", multiple: true },
        base: { type: "string" },
        "loopback-fixture": { type: "boolean" },
        service: { type: "string" },
        unit: { type: "string" },
        folder: { type: "string" },
        "organization-directory": { type: "string" },
        "bun-executable": { type: "string" },
      },
    });
    json = values.json === true;
    const names: string[] = tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      new Set(names).size !==
      names.filter((name) => name !== "artifact-origin").length +
        (names.includes("artifact-origin") ? 1 : 0)
    )
      return refuse("invalid-request");
    const env = environment.env ?? process.env;
    const platform = environment.platform ?? process.platform;
    const base =
      values.base ?? resolveInstallBase({ platform, env, homedir: env.HOME });
    if (!base || !isAbsolute(base) || resolve(base) !== base)
      return refuse("invalid-request", { option: "base" });
    // A channel chosen before the installation is kept; a flag overrides it
    // and is what gets recorded.
    const channel = values.channel ?? (await readUpdateConfig(base)).channel;
    if (!isUpdateChannel(channel)) return refuse("invalid-request");
    // The Launchpad's arguments belong to the service and to nothing else.
    const wantsService = values.service !== undefined;
    const unitDirectory = userUnitDirectory(env);
    if (
      (wantsService &&
        (values.service !== "systemd-user" ||
          values.folder === undefined ||
          unitDirectory === undefined ||
          (values["bun-executable"] !== undefined &&
            values["organization-directory"] === undefined))) ||
      (!wantsService &&
        ["unit", "folder", "organization-directory", "bun-executable"].some(
          (name) => names.includes(name),
        ))
    )
      return refuse("invalid-request", { option: "service" });
    const repository = await resolveRepository(
      values,
      120_000,
      environment.embeddedRoot,
    );
    if ("invalid" in repository)
      return refuse("invalid-request", { option: repository.invalid });
    return renderInstall(
      await performInstall({
        base,
        channel,
        identity: environment.identity ?? embeddedIdentity(),
        ...repository.source,
        transport: repository.transport,
        clock: environment.clock ?? (() => new Date()),
        executable: environment.executable ?? process.execPath,
        platform,
        env,
        run: environment.run,
        service:
          wantsService && unitDirectory !== undefined
            ? {
                unit: values.unit ?? defaultLaunchpadUnit,
                unitDirectory,
                folder: values.folder as string,
                organizationDirectory: values["organization-directory"],
                bunExecutable: values["bun-executable"],
              }
            : undefined,
      }),
      json,
    );
  } catch (error) {
    const usage =
      typeof (error as { code?: unknown } | undefined)?.code === "string" &&
      String((error as { code: string }).code).startsWith("ERR_PARSE_ARGS");
    return refuse(usage ? "invalid-request" : "internal");
  }
}

function renderInstall(result: InstallResult, json: boolean): CommandOutput {
  const code = result.kind === "error" ? updateErrors[result.code].exit : 0;
  if (json) return { code, stdout: JSON.stringify(result), stderr: "" };
  if (result.kind === "error")
    return { code, stdout: "", stderr: `Install failed: ${result.code}` };
  return {
    code,
    stdout: [
      `Installed lazurio ${result.version}.`,
      result.service.kind === "systemd-user"
        ? `The Launchpad runs as the user service ${result.service.unit}.`
        : "No Launchpad service is managed on this Machine.",
      ...(result.available
        ? [`Version ${result.available} is available: run \`lazurio update\`.`]
        : []),
      // A hint, not an edit: shell profiles belong to the person.
      `Add it to your PATH: export PATH="${result.path}:$PATH"`,
    ].join("\n"),
    stderr: "",
  };
}
