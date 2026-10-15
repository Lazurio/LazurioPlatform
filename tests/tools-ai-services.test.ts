import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AiServices,
  aiServicesReady,
  refreshT3Providers,
  reloadAiServices,
  t3Mismatches,
  t3ProvidersAnswer,
} from "../src/tools/ai-services";
import type { ToolProcessResult, ToolRunner } from "../src/tools/status";
import {
  codexAppServerUnit,
  renderCodexAppServerUnit,
  restartCodexAppServer,
} from "../src/update/codex-app-server";

// After `lazurio tools login codex|claude` (root decision 0201 point 4, F19's
// addendum of 2026-10-15): the Codex app-server unit Lazurio manages is
// restarted, and T3 Code turns the signed-in providers on and reads them
// again (`t3 lazurio providers`, Lazurio/t3code#72), only where `t3 lazurio
// capabilities` says it can.

type Call = Readonly<{
  command: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

/** A runner that answers each command from `answers` by its arguments. */
function runner(answers: (command: readonly string[]) => ToolProcessResult): {
  run: ToolRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, _timeoutMs, env) => {
      calls.push({ command, env });
      return answers(command);
    },
  };
}

const ok = (stdout = "", stderr = ""): ToolProcessResult => ({
  exitCode: 0,
  stdout,
  stderr,
});
const failed = (stderr: string, exitCode = 1): ToolProcessResult => ({
  exitCode,
  stdout: "",
  stderr,
});

async function home(withT3 = true) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-ai-services-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  if (withT3) {
    await writeFile(join(bin, "t3"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "t3"), 0o755);
  }
  return {
    directory,
    bin,
    path: `${bin}:/usr/bin:/bin`,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

const capabilities = (providerRefresh: boolean) =>
  JSON.stringify({
    version: 1,
    managedFolder: true,
    modelRecommendation: true,
    ...(providerRefresh ? { providerRefresh: true } : {}),
  });
const refreshed = JSON.stringify({
  version: 1,
  providers: [
    {
      provider: "codex",
      instanceId: "codex",
      enabled: true,
      status: "ready",
      auth: "authenticated",
    },
    {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      enabled: true,
      status: "warning",
      auth: "unknown",
    },
  ],
});

test("T3 Code's answers are read field by field", () => {
  expect(t3ProvidersAnswer(refreshed)).toEqual([
    {
      provider: "codex",
      instanceId: "codex",
      enabled: true,
      status: "ready",
      auth: "authenticated",
    },
    {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      enabled: true,
      status: "warning",
      auth: "unknown",
    },
  ]);
  for (const answer of [
    "",
    "not json",
    JSON.stringify({ version: 2, providers: [] }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, providers: [{ provider: "codex" }] }),
  ])
    expect(t3ProvidersAnswer(answer)).toBeUndefined();
  // `t3`'s error line carries the service's 409 body.
  expect(
    t3Mismatches(
      'The live T3 service refused the provider refresh (409): {"error":"driver-mismatch","mismatches":[{"provider":"codex","instanceId":"codex","driver":"claudeAgent"}]}',
    ),
  ).toEqual([
    { provider: "codex", instanceId: "codex", driver: "claudeAgent" },
  ]);
  expect(
    t3Mismatches(
      'The live T3 service refused the provider refresh (403): {"error":"forbidden"}',
    ),
  ).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "T3 Code is asked to turn the signed-in providers on and read them again, only where it can",
  async () => {
    const scratch = await home();
    try {
      const input = {
        providers: ["claude", "codex"] as const,
        path: scratch.path,
        home: scratch.directory,
        platform: process.platform,
      };
      // Contract version 1 with the refresh: asked, in the CLIs' order.
      const asked = runner((command) =>
        command[2] === "capabilities"
          ? ok(capabilities(true))
          : ok(`${refreshed}\n`),
      );
      expect(await refreshT3Providers({ ...input, run: asked.run })).toEqual({
        state: "refreshed",
        providers: t3ProvidersAnswer(refreshed) ?? [],
      });
      expect(asked.calls.map((call) => call.command)).toEqual([
        [join(scratch.bin, "t3"), "lazurio", "capabilities"],
        [
          join(scratch.bin, "t3"),
          "lazurio",
          "providers",
          "--base-dir",
          join(scratch.directory, ".t3"),
          '{"providers":["codex","claude"],"enable":true}',
        ],
      ]);
      expect(asked.calls[1]?.env).toEqual({
        HOME: scratch.directory,
        PATH: scratch.path,
      });
      // An older T3 Code: not asked; it reads the sign-in at its own check.
      const older = runner(() => ok(capabilities(false)));
      expect(await refreshT3Providers({ ...input, run: older.run })).toEqual({
        state: "not-supported",
      });
      expect(older.calls).toHaveLength(1);
      // An instance under the default ID that runs another driver: a clear
      // failure, nothing turned on.
      const mismatch = runner((command) =>
        command[2] === "capabilities"
          ? ok(capabilities(true))
          : failed(
              'The live T3 service refused the provider refresh (409): {"error":"driver-mismatch","mismatches":[{"provider":"codex","instanceId":"codex","driver":"claudeAgent"}]}',
            ),
      );
      expect(await refreshT3Providers({ ...input, run: mismatch.run })).toEqual(
        {
          state: "driver-mismatch",
          mismatches: [
            { provider: "codex", instanceId: "codex", driver: "claudeAgent" },
          ],
        },
      );
      for (const [answer, reason] of [
        [
          failed("The T3 service must be running. Nothing was changed."),
          "not-running",
        ],
        [
          failed("The live T3 service refused the provider refresh (403): {}"),
          "refused",
        ],
        [ok("garbage"), "unreadable"],
        ["timeout", "timeout"],
      ] as const) {
        const other = runner((command) =>
          command[2] === "capabilities" ? ok(capabilities(true)) : answer,
        );
        expect(await refreshT3Providers({ ...input, run: other.run })).toEqual({
          state: "failed",
          reason,
        });
      }
    } finally {
      await scratch.close();
    }
    const without = await home(false);
    try {
      const nothing = runner(() => ok());
      expect(
        await refreshT3Providers({
          providers: ["codex"],
          path: without.path,
          home: without.directory,
          platform: process.platform,
          run: nothing.run,
        }),
      ).toEqual({ state: "not-installed" });
      expect(nothing.calls).toEqual([]);
    } finally {
      await without.close();
    }
  },
);

test("the Codex app-server is restarted through Lazurio's own unit, and nowhere else", async () => {
  const scratch = await home(false);
  try {
    const units = join(scratch.directory, ".config", "systemd", "user");
    const env = {
      HOME: scratch.directory,
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      SECRET: "never passed on",
    };
    const restart = runner(() => ok());
    // No unit of Lazurio's: nothing touched.
    expect(
      await restartCodexAppServer({ platform: "linux", env, run: restart.run }),
    ).toEqual({ state: "not-managed" });
    await mkdir(units, { recursive: true });
    await writeFile(
      join(units, codexAppServerUnit),
      "[Service]\nExecStart=/bin/true\n",
    );
    expect(
      await restartCodexAppServer({ platform: "linux", env, run: restart.run }),
    ).toEqual({ state: "not-managed" });
    expect(restart.calls).toEqual([]);
    await writeFile(
      join(units, codexAppServerUnit),
      renderCodexAppServerUnit(),
    );
    expect(
      await restartCodexAppServer({ platform: "linux", env, run: restart.run }),
    ).toEqual({ state: "restarted" });
    expect(restart.calls).toEqual([
      {
        command: ["systemctl", "--user", "restart", "--", codexAppServerUnit],
        env: {
          HOME: scratch.directory,
          PATH: "/usr/bin:/bin",
          XDG_RUNTIME_DIR: "/run/user/1000",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        },
      },
    ]);
    const refused = runner(() => failed("Failed to restart"));
    expect(
      await restartCodexAppServer({ platform: "linux", env, run: refused.run }),
    ).toEqual({ state: "failed" });
    // A workstation (macOS), or no user manager: not Lazurio's to restart.
    for (const [platform, without] of [
      ["darwin", env],
      ["linux", { ...env, XDG_RUNTIME_DIR: undefined }],
    ] as const)
      expect(
        await restartCodexAppServer({
          platform,
          env: without,
          run: restart.run,
        }),
      ).toEqual({ state: "not-managed" });
  } finally {
    await scratch.close();
  }
});

test("after codex the app-server and T3 Code, after claude T3 Code alone", async () => {
  const scratch = await home(false);
  try {
    const asked = runner(() => ok());
    const input = {
      signedIn: ["codex"] as const,
      path: scratch.path,
      home: scratch.directory,
      platform: "linux",
      run: asked.run,
      env: { HOME: scratch.directory },
    };
    expect(await reloadAiServices({ ...input, tool: "codex" })).toEqual({
      appServer: { state: "not-managed" },
      t3: { state: "not-installed" },
    });
    expect(
      await reloadAiServices({ ...input, tool: "claude", signedIn: [] }),
    ).toEqual({ t3: { state: "not-installed" } });
  } finally {
    await scratch.close();
  }
});

test("the services read the sign-in, or will by themselves, unless one clearly failed", () => {
  const ready: AiServices[] = [
    { t3: { state: "refreshed", providers: [] } },
    { appServer: { state: "restarted" }, t3: { state: "not-installed" } },
    { appServer: { state: "not-managed" }, t3: { state: "not-supported" } },
  ];
  const notReady: AiServices[] = [
    {
      appServer: { state: "failed" },
      t3: { state: "refreshed", providers: [] },
    },
    { t3: { state: "driver-mismatch", mismatches: [] } },
    { t3: { state: "failed", reason: "not-running" } },
    { t3: { state: "failed", reason: "timeout" } },
  ];
  for (const services of ready) expect(aiServicesReady(services)).toBe(true);
  for (const services of notReady)
    expect(aiServicesReady(services)).toBe(false);
});
