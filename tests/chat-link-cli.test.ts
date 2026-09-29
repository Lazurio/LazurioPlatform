import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { chatPairing } from "../src/launchpad/chat";
import {
  type ChatContext,
  exitNotHosted,
  runChatCommand,
} from "../src/launchpad/chat-cli";
import { runTool, type ToolRunner } from "../src/tools/status";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import { commitOf, target } from "./fixtures/update-world";

// `lazurio chat link` (launchpad-parity B8's CLI, C.5 item 10): the pairing
// link `POST /api/chat/pair` answers, from the same recorded entry and the
// same `issueChatLink`. The T3 launcher is a fake on a private PATH; nothing
// of this computer's `t3` can answer.

const credential = "Pairing_Token-0123456789abcdef";
const t3codeOrigin = "https://t3code.workspace.example.lazurio.io";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

// A fake `t3 auth pairing create --json`, or a failing call whose stderr
// holds the credential.
async function fakeLauncher(bin: string, mode: "ok" | "fail") {
  const script = join(bin, "t3");
  await writeFile(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > "${join(bin, "t3.calls")}"
${
  mode === "ok"
    ? `echo '{"credential":"${credential}","label":"launchpad-chat"}'`
    : `echo 'could not pair ${credential}' >&2; exit 3`
}
`,
  );
  await chmod(script, 0o755);
}

async function world(kind: "hosted" | "workstation") {
  root = await realpath(await mkdtemp(join(tmpdir(), "chat-link-")));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  // The launcher's directory is outside the home, so the home can be
  // compared byte for byte.
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  if (kind === "hosted") {
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    await initializeHandoverFolder(folder, {
      preset,
      machine: organizationWithEntry(),
      profile: presetProfile(preset, executionOs(process.platform)),
    });
  } else {
    await rm(folder, { recursive: true });
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform)),
    );
  }
  const runs: string[][] = [];
  const run: ToolRunner = (command, timeoutMs, env) => {
    runs.push([...command]);
    return runTool(command, timeoutMs, env);
  };
  const context: ChatContext = {
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: { HOME: home, PATH: bin },
    executable: join(root, "unused"),
    toolRun: run,
    hostedFolder: undefined,
  };
  return { root, home, bin, folder, runs, context };
}

// Every file under a directory with its bytes: the before/after proof that
// the command writes nothing.
async function tree(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(directory, { recursive: true })) {
    const path = join(directory, name);
    try {
      files[name] = (await readFile(path)).toString("base64");
    } catch {
      files[name] = "directory";
    }
  }
  return files;
}

test.skipIf(process.platform === "win32")(
  "hosted: the pairing link of the recorded T3 Code origin, the resident's call, the token only in the link",
  async () => {
    const { home, bin, folder, runs, context } = await world("hosted");
    await fakeLauncher(bin, "ok");
    const before = await tree(home);
    const human = await runChatCommand(["link", "--folder", folder], context);
    const json = await runChatCommand(
      ["link", "--folder", folder, "--json"],
      context,
    );
    const url = `${t3codeOrigin}/pair#token=${credential}`;
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(url);
    expect(human.stderr).toBe(
      "A one-time link, valid for 60 seconds: hand it to the operator.",
    );
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout ?? "")).toEqual({
      kind: "chat-link",
      url,
      pairing: true,
    });
    expect(json.stderr).toBeUndefined();
    // The same call as POST /api/chat/pair: the launcher on PATH with the
    // resident's exact arguments.
    const call = [
      join(bin, "t3"),
      "auth",
      "pairing",
      "create",
      "--base-dir",
      join(home, ".t3"),
      "--ttl",
      chatPairing.ttl,
      "--label",
      chatPairing.label,
      "--json",
    ];
    expect(runs).toEqual([call, call]);
    expect(await tree(home)).toEqual(before);
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: without the launcher, a failed call or --plain it is the plain origin with the reason",
  async () => {
    const { bin, folder, runs, context } = await world("hosted");
    const missing = await runChatCommand(
      ["link", "--folder", folder, "--json"],
      context,
    );
    expect([missing.code, JSON.parse(missing.stdout ?? "")]).toEqual([
      0,
      {
        kind: "chat-link",
        url: t3codeOrigin,
        pairing: false,
        reason: "t3-launcher-missing",
      },
    ]);
    const missingHuman = await runChatCommand(
      ["link", "--folder", folder],
      context,
    );
    expect(missingHuman).toEqual({
      code: 0,
      stdout: t3codeOrigin,
      stderr:
        "No pairing: the T3 launcher t3 is not on PATH. The plain link opens T3 Code, which asks the browser to pair.",
    });
    expect(runs).toEqual([]);

    await fakeLauncher(bin, "fail");
    const failed = await runChatCommand(
      ["link", "--folder", folder, "--json"],
      context,
    );
    const failedHuman = await runChatCommand(
      ["link", "--folder", folder],
      context,
    );
    expect([failed.code, JSON.parse(failed.stdout ?? "")]).toEqual([
      0,
      {
        kind: "chat-link",
        url: t3codeOrigin,
        pairing: false,
        reason: "t3-pairing-failed",
      },
    ]);
    expect([failedHuman.code, failedHuman.stdout]).toEqual([0, t3codeOrigin]);
    // The call's output held the credential: it is in neither stream.
    for (const output of [failed, failedHuman])
      expect(JSON.stringify(output)).not.toContain(credential);
    expect(runs.length).toBe(2);

    // --plain asks for the plain link: nothing is run.
    await fakeLauncher(bin, "ok");
    const plain = await runChatCommand(
      ["link", "--plain", "--folder", folder, "--json"],
      context,
    );
    const plainHuman = await runChatCommand(
      ["link", "--plain", "--folder", folder],
      context,
    );
    expect([plain.code, JSON.parse(plain.stdout ?? "")]).toEqual([
      0,
      {
        kind: "chat-link",
        url: t3codeOrigin,
        pairing: false,
        reason: "plain-requested",
      },
    ]);
    expect([plainHuman.code, plainHuman.stdout]).toEqual([0, t3codeOrigin]);
    expect(runs.length).toBe(2);
  },
);

test.skipIf(process.platform === "win32")(
  "workstation: no recorded entry, no link, exit 10; the launcher is never run",
  async () => {
    const { bin, folder, runs, context } = await world("workstation");
    await fakeLauncher(bin, "ok");
    const json = await runChatCommand(
      ["link", "--folder", folder, "--json"],
      context,
    );
    expect([json.code, JSON.parse(json.stdout ?? "")]).toEqual([
      exitNotHosted,
      { kind: "chat-link", url: null, pairing: false, reason: "not-hosted" },
    ]);
    expect(exitNotHosted).toBe(10);
    const human = await runChatCommand(["link", "--folder", folder], context);
    expect(human).toEqual({
      code: 10,
      stderr:
        "No T3 Code link: this Folder has no recorded hosted entry, so T3 Code runs wherever the operator runs it.",
    });
    // No Folder at all (a workstation without a supervised unit): the same.
    const none = await runChatCommand(["link", "--json"], context);
    expect([none.code, JSON.parse(none.stdout ?? "").reason]).toEqual([
      10,
      "not-hosted",
    ]);
    expect(runs).toEqual([]);
  },
);

test("usage and an unreadable Folder", async () => {
  const { root: directory, context } = await world("workstation");
  for (const args of [
    [],
    ["pair"],
    ["link", "extra"],
    ["link", "--json", "--json"],
    ["link", "--folder", "relative"],
    ["link", "--folder", `${directory}/../x`],
    ["link", "--token"],
  ])
    expect([args, await runChatCommand(args, context)]).toEqual([
      args,
      {
        code: 2,
        stderr:
          "Usage: chat link [--folder <absolute Folder>] [--plain] [--json]",
      },
    ]);
  // Not a Folder: the enumerated start refusal, never the path.
  const missing = join(directory, "missing");
  const failed = await runChatCommand(["link", "--folder", missing], context);
  expect(failed).toEqual({
    code: 1,
    stderr:
      "Chat link failed: the Folder could not be read (folder-state-unreadable)",
  });
});

test.skipIf(process.platform === "win32")(
  "lazurio chat link runs from the command line with a temporary home: the link alone on stdout",
  async () => {
    const { root: directory, home, bin, folder } = await world("hosted");
    await fakeLauncher(bin, "ok");
    const xdg = join(directory, "xdg");
    const cli = async (...args: string[]) => {
      const child = Bun.spawn(
        [process.execPath, resolve("src/cli.ts"), "chat", "link", ...args],
        {
          // Only the fake launcher: nothing of this computer's can answer.
          env: {
            HOME: home,
            PATH: bin,
            XDG_CONFIG_HOME: join(xdg, "config"),
            XDG_STATE_HOME: join(xdg, "state"),
            XDG_DATA_HOME: join(xdg, "data"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const url = `${t3codeOrigin}/pair#token=${credential}`;
    const human = await cli("--folder", folder);
    expect([human.code, human.stdout]).toEqual([0, `${url}\n`]);
    expect(human.stderr).not.toContain(credential);
    const json = await cli("--folder", folder, "--json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      kind: "chat-link",
      url,
      pairing: true,
    });
    expect(json.stderr).not.toContain(credential);
    const plain = await cli("--folder", folder, "--plain");
    expect([plain.code, plain.stdout]).toEqual([0, `${t3codeOrigin}\n`]);
    // The usage error of the real command line.
    const usage = await cli("--folder", "relative");
    expect([usage.code, usage.stdout]).toEqual([2, ""]);
  },
);
