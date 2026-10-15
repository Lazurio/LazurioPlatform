import { join } from "node:path";
import { restartCodexAppServer } from "../update/codex-app-server";
import {
  type AiProvider,
  type AiServices,
  aiProviders,
  type T3Mismatch,
  type T3Provider,
  type T3Reload,
} from "./ai";
import { resolveOnPath, signInLabel, type ToolRunner } from "./status";

// After `lazurio tools login codex|claude` confirmed the sign-in, the running
// services read it again (root decision 0201 point 4, F19's addendum of
// 2026-10-15): a running Codex app-server never rereads `auth.json`, and T3
// Code checks its providers only about every five minutes. So Lazurio
// restarts the Codex app-server unit it manages and asks T3 Code to turn the
// signed-in providers on and read them again (`t3 lazurio providers`,
// Lazurio/t3code#72), where `t3 lazurio capabilities` says it can.

const capabilitiesMs = 15_000;
// The command waits up to 60 s for the service (`t3 lazurio providers`):
// reading a provider's sign-in starts its CLI.
const providersMs = 70_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The first JSON object in a text: the whole of it, or what follows the
 * first `{` (the service's body inside `t3`'s error line). */
function objectIn(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  for (const candidate of [text.trim(), start < 0 ? "" : text.slice(start)]) {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (isRecord(value)) return value;
    } catch {}
  }
  return undefined;
}

const label = (value: unknown, limit = 80) => {
  const text = signInLabel(value);
  return text === undefined ? undefined : text.slice(0, limit);
};

/** T3 Code's answer to `t3 lazurio providers` (`{version: 1, providers}`),
 * field by field; undefined when it is not that. */
export function t3ProvidersAnswer(
  stdout: string,
): readonly T3Provider[] | undefined {
  const value = objectIn(stdout);
  if (value?.version !== 1 || !Array.isArray(value.providers)) return undefined;
  const providers: T3Provider[] = [];
  for (const entry of value.providers.slice(0, 16)) {
    if (!isRecord(entry) || typeof entry.enabled !== "boolean")
      return undefined;
    const provider = label(entry.provider);
    const instanceId = label(entry.instanceId);
    const status = label(entry.status, 40);
    const auth = label(entry.auth, 40);
    if (
      provider === undefined ||
      instanceId === undefined ||
      status === undefined ||
      auth === undefined
    )
      return undefined;
    providers.push(
      Object.freeze({
        provider,
        instanceId,
        enabled: entry.enabled,
        status,
        auth,
      }),
    );
  }
  return Object.freeze(providers);
}

/** The service's 409 `driver-mismatch` in `t3`'s error output. */
export function t3Mismatches(
  output: string,
): readonly T3Mismatch[] | undefined {
  const value = objectIn(output);
  if (value?.error !== "driver-mismatch") return undefined;
  const mismatches: T3Mismatch[] = [];
  for (const entry of Array.isArray(value.mismatches)
    ? value.mismatches.slice(0, 16)
    : []) {
    if (!isRecord(entry)) continue;
    const provider = label(entry.provider);
    const instanceId = label(entry.instanceId);
    const driver = label(entry.driver);
    if (provider && instanceId && driver)
      mismatches.push(Object.freeze({ provider, instanceId, driver }));
  }
  return Object.freeze(mismatches);
}

/** Asks this Environment's T3 Code to turn `providers` on and read their
 * sign-in again. */
export async function refreshT3Providers(
  input: Readonly<{
    providers: readonly AiProvider[];
    path: string | undefined;
    home: string | undefined;
    platform: string;
    run: ToolRunner;
  }>,
): Promise<T3Reload> {
  const t3 = await resolveOnPath("t3", input.path, input.platform);
  if (t3 === undefined || !input.home)
    return Object.freeze({ state: "not-installed" });
  const env: Record<string, string> = { HOME: input.home };
  if (input.path) env.PATH = input.path;
  const capabilities = await input
    .run([t3, "lazurio", "capabilities"], capabilitiesMs, env, {
      maxBytes: 16 * 1024,
    })
    .catch(() => "timeout" as const);
  if (
    capabilities === "timeout" ||
    capabilities.exitCode !== 0 ||
    objectIn(capabilities.stdout)?.providerRefresh !== true
  )
    return Object.freeze({ state: "not-supported" });
  const request = JSON.stringify({
    providers: aiProviders.filter((tool) => input.providers.includes(tool)),
    enable: true,
  });
  const answer = await input
    .run(
      [
        t3,
        "lazurio",
        "providers",
        "--base-dir",
        join(input.home, ".t3"),
        request,
      ],
      providersMs,
      env,
      { maxBytes: 64 * 1024 },
    )
    .catch(() => "timeout" as const);
  if (answer === "timeout")
    return Object.freeze({ state: "failed", reason: "timeout" });
  if (answer.exitCode === 0) {
    const providers = t3ProvidersAnswer(answer.stdout);
    return providers === undefined
      ? Object.freeze({ state: "failed", reason: "unreadable" })
      : Object.freeze({ state: "refreshed", providers });
  }
  const output = `${answer.stderr}\n${answer.stdout}`;
  const mismatches = t3Mismatches(output);
  if (mismatches !== undefined)
    return Object.freeze({ state: "driver-mismatch", mismatches });
  return Object.freeze({
    state: "failed",
    reason: /must be running/i.test(output) ? "not-running" : "refused",
  });
}

/** After a confirmed sign-in of `tool`: the Codex app-server unit restarted
 * (codex only), then T3 Code asked about every AI CLI signed in now. */
export async function reloadAiServices(
  input: Readonly<{
    tool: AiProvider;
    signedIn: readonly AiProvider[];
    path: string | undefined;
    home: string | undefined;
    platform: string;
    run: ToolRunner;
    /** The process environment `systemctl --user` needs (its runtime
     * directory and bus). */
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<AiServices> {
  const appServer =
    input.tool === "codex"
      ? await restartCodexAppServer({
          platform: input.platform,
          env: input.env,
          run: input.run,
        }).catch(() => Object.freeze({ state: "failed" as const }))
      : undefined;
  const t3 = await refreshT3Providers({
    providers: input.signedIn.includes(input.tool)
      ? input.signedIn
      : [...input.signedIn, input.tool],
    path: input.path,
    home: input.home,
    platform: input.platform,
    run: input.run,
  }).catch(() =>
    Object.freeze({ state: "failed" as const, reason: "refused" as const }),
  );
  return Object.freeze({
    ...(appServer === undefined ? {} : { appServer }),
    t3,
  });
}
