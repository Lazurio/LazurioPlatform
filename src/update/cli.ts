import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DistributionTransport } from "../distribution/transport";
import { readOwnedDeclarationBytes } from "../providers/owned-json";
import { resolveInstallBase } from "./base";
import { isUpdateChannel } from "./channel";
import { type CheckResult, checkForUpdate } from "./check";
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

/** `lazurio update …` and `lazurio --version`: terminal surface of the one
 * update core (docs/update.md "Surfaces"). Origins, channel and the bootstrap
 * root are explicit in this build; defaults arrive with the publisher.
 */
export const updateHelp = `--version [--json]
  Prints the version, source commit and target this executable was built with.
update --check --metadata-url <https://.../metadata/> --target-url <https://.../targets/>
  --channel <stable|preview> [--bootstrap-root <owned file>] [--base <absolute directory>]
  [--loopback-fixture] [--json]
  Verifies signed metadata and the channel document, records verified trust and
  rewrites the observation. Downloads and activates nothing. The bootstrap root
  is accepted only while no trust exists and refused afterwards.
  Exit 0 up to date, 10 update available; an error prints its stable code.
update status [--base <absolute directory>] [--json]
  Prints the last observation without touching the network.
update
  Download and activation are not implemented in this build (not-implemented).`;

export type CommandOutput = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

const failure = (
  code: UpdateErrorCode,
  context: ErrorContext = {},
): CheckResult =>
  Object.freeze({ kind: "error", ...updateError(code, context) });

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

/** Never throws: every refusal is a typed result with a stable exit status. */
export async function runUpdateCommand(
  args: readonly string[],
  environment: Readonly<{
    identity?: ProductIdentity;
    clock?: () => Date;
    platform?: string;
    env?: Readonly<Record<string, string | undefined>>;
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
        json: { type: "boolean" },
        "metadata-url": { type: "string" },
        "target-url": { type: "string" },
        channel: { type: "string" },
        "bootstrap-root": { type: "string" },
        base: { type: "string" },
        "loopback-fixture": { type: "boolean" },
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
    if (positionals.length === 1 && positionals[0] === "status") {
      if (!only(["json", "base"]))
        return render(failure("invalid-request"), json);
      return renderStatus(await readObserved(base, clock()), json);
    }
    if (positionals.length !== 0)
      return render(failure("invalid-request"), json);
    if (values.check !== true)
      // Explicit and typed: this build can only check. Nothing was attempted.
      return render(failure("not-implemented", { step: "download" }), json);
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
        60_000,
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
    return render(
      await checkForUpdate({
        base,
        metadataBaseUrl: values["metadata-url"],
        targetBaseUrl: values["target-url"],
        channel,
        identity: environment.identity ?? embeddedIdentity(),
        ...(bootstrapRoot === undefined ? {} : { bootstrapRoot }),
        transport,
        clock,
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
