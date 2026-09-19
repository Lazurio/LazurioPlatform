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
import { defaultDownloadPolicy } from "./download";
import {
  type ErrorContext,
  exitUpdateAvailable,
  exitUpToDate,
  type UpdateErrorCode,
  updateError,
  updateErrors,
} from "./errors";
import { embeddedIdentity, type ProductIdentity } from "./identity";
import { type Observed, readObserved } from "./observed";
import { selfCheckReport } from "./self-check";
import {
  performRollback,
  performUpdate,
  type RollbackResult,
  type UpdateResult,
  type WorkerLauncher,
} from "./update";

/** `lazurio update …` and `lazurio --version`: terminal surface of the one
 * update core (docs/update.md "Surfaces"). Origins, channel and the bootstrap
 * root are explicit in this build; defaults arrive with the publisher.
 */
export const updateHelp = `--version [--json]
  Prints the version, source commit and target this executable was built with.
update [--download-only] --metadata-url <https://.../metadata/> --target-url <https://.../targets/>
  --channel <stable|preview> [--bootstrap-root <owned file>] [--base <absolute directory>]
  [--folder <absolute Folder>] [--service <none|systemd-user> --unit <name.service>]
  [--deadline-ms <n>] [--stability-ms <n>] [--loopback-fixture] [--json]
  Checks, downloads, verifies and stages the channel's version and activates it:
  the selector bin/lazurio is switched and the new version must confirm itself,
  otherwise the previous version is selected again. --download-only stops after
  staging. With --folder the candidate must prove it can read that Folder's state.
  --service systemd-user restarts the named user unit and waits for a fresh,
  stable Launchpad of the new version; none (default) manages no service.
  The activation deadline (120000 ms) and stability period (10000 ms) can be
  shortened for qualification runs.
  Exit 0 updated, staged or nothing to do; an error prints its stable code.
update --check <same origin options> [--json]
  Verifies signed metadata and the channel document, records verified trust and
  rewrites the observation. Downloads and activates nothing. The bootstrap root
  seeds trust while none exists; afterwards it is ignored unless it is the
  verified direct successor of the trusted root.
  Exit 0 up to date, 10 update available; an error prints its stable code.
update rollback [--base <absolute directory>] [--folder ...] [--service ... --unit ...] [--json]
  Activates the version the last confirmed activation replaced, through the same
  confirmation. Refused when that version cannot read the current state schemas.
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

/** Never throws: every refusal is a typed result with a stable exit status. */
export async function runUpdateCommand(
  args: readonly string[],
  environment: Readonly<{
    identity?: ProductIdentity;
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
      if (supplied.has(token.name))
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
    const folder = values.folder;
    if (
      folder !== undefined &&
      (!isAbsolute(folder) || resolve(folder) !== folder)
    )
      return render(failure("invalid-request", { option: "folder" }), json);
    const service = parseServiceSpec(
      values.unit === undefined
        ? { kind: values.service ?? "none" }
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
        "loopback-fixture",
        ...(checking ? ["check"] : ["download-only", ...serviceOptions]),
      ])
    )
      return render(failure("invalid-request"), json);
    const channel = values.channel;
    if (
      !isUpdateChannel(channel) ||
      !values["metadata-url"] ||
      !values["target-url"]
    )
      return render(failure("invalid-request"), json);
    let transport: DistributionTransport;
    try {
      transport = new DistributionTransport(
        [
          ...new Set([
            new URL(values["metadata-url"]).origin,
            new URL(values["target-url"]).origin,
          ]),
        ],
        // One transport per operation: a check is short, a download is
        // bounded by its own deadline inside this outer limit.
        checking ? 60_000 : defaultDownloadPolicy.deadlineMs + 300_000,
        new AbortController().signal,
        values["loopback-fixture"] === true,
      );
    } catch {
      return render(failure("invalid-request", { option: "url" }), json);
    }
    let bootstrapRoot: Uint8Array | undefined;
    if (values["bootstrap-root"] !== undefined)
      try {
        // A trust anchor is read only from a caller-owned, non-shared file.
        bootstrapRoot = await readOwnedDeclarationBytes(
          values["bootstrap-root"],
        );
      } catch {
        return render(
          failure("invalid-request", { option: "bootstrap-root" }),
          json,
        );
      }
    const checkInput = {
      base,
      metadataBaseUrl: values["metadata-url"],
      targetBaseUrl: values["target-url"],
      channel,
      identity: environment.identity ?? embeddedIdentity(),
      ...(bootstrapRoot === undefined ? {} : { bootstrapRoot }),
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
