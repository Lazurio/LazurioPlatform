import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AiServices } from "../src/tools/ai";
import {
  hostedSignInPage,
  runToolsCommand,
  ToolsUsageError,
  toolsHelp,
} from "../src/tools/cli";
import {
  codeOfPage,
  fakeAi,
  fakeAiClis,
  returnFromPage,
} from "./fixtures/fake-ai-clis";
import { bindings } from "./fixtures/machine-bindings";

// `lazurio tools login codex|claude` in a terminal or for an agent (root
// decision 0201 point 4: the Launchpad, agents and the terminal call the same
// command; F19's addendum of 2026-10-15): where the page opens, what it
// prints, the code typed in a terminal and the exit status.

const posixTest = test.skipIf(process.platform === "win32");
const view =
  "https://browser.workspace.example.lazurio.io/t/0123456789ABCDEF0123456789ABCDEF";

async function scratch() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "lazurio-ai-cli-")));
  const bin = await fakeAiClis(home);
  const lines: string[] = [];
  return {
    home,
    lines,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    close: () => rm(home, { recursive: true, force: true }),
  };
}

/** A Remote Environment's operator Folder: with the Environment browser's
 * view or without it. */
async function hostedFolder(
  home: string,
  machine:
    | typeof bindings.organizationBrowser
    | typeof bindings.organizationEntry,
) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  return folder;
}

const reloaded: AiServices = {
  appServer: { state: "restarted" },
  t3: {
    state: "refreshed",
    providers: [
      {
        provider: "codex",
        instanceId: "codex",
        enabled: true,
        status: "ready",
        auth: "authenticated",
      },
    ],
  },
};

posixTest(
  "where the page opens: the computer's own browser, the Environment browser, none there, or not known",
  async () => {
    const opened = await scratch();
    try {
      const open = async () => ({ view });
      expect(await hostedSignInPage(undefined, open)).toEqual({ kind: "own" });
      expect(await hostedSignInPage(async () => undefined, open)).toEqual({
        kind: "own",
      });
      const withBrowser = await hostedFolder(
        join(opened.home, "a"),
        bindings.organizationBrowser,
      );
      const page = await hostedSignInPage(async () => withBrowser, open);
      expect(page).toMatchObject({ kind: "environment" });
      const without = await hostedFolder(
        join(opened.home, "b"),
        bindings.organizationEntry,
      );
      expect(await hostedSignInPage(async () => without, open)).toEqual({
        kind: "none",
      });
      // Without a way to open a page, the Environment browser is no place.
      expect(
        await hostedSignInPage(async () => withBrowser, undefined),
      ).toEqual({ kind: "none" });
      // A hosted context that cannot be read is never a workstation.
      expect(
        await hostedSignInPage(async () => {
          throw new Error("handover");
        }, open),
      ).toBe("unreadable");
      expect(
        await hostedSignInPage(async () => join(opened.home, "missing"), open),
      ).toBe("unreadable");
    } finally {
      await opened.close();
    }
  },
);

posixTest(
  "codex on a Remote Environment: the page opens where `lazurio browser open` opens one, the link is printed, and the services read the sign-in",
  async () => {
    const opened = await scratch();
    try {
      const folder = await hostedFolder(
        join(opened.home, "env"),
        bindings.organizationBrowser,
      );
      const pages: string[] = [];
      const reloads: unknown[] = [];
      const output = await runToolsCommand(["login", "codex"], {
        env: opened.env,
        platform: process.platform,
        write: (line) => opened.lines.push(line),
        hostedFolder: async () => folder,
        openPage: async (url) => {
          pages.push(url);
          // The person signs in there a moment later.
          setTimeout(() => void returnFromPage(url), 200);
          return { view };
        },
        login: {
          firstChallengeMs: 5_000,
          reload: async (tool, signedIn) => {
            reloads.push([tool, signedIn]);
            return reloaded;
          },
        },
      });
      expect(output.code).toBe(0);
      expect(output.result).toEqual({
        kind: "signed-in",
        tool: "codex",
        services: reloaded,
      });
      expect(pages).toHaveLength(1);
      expect(new URL(pages[0] as string).hostname).toBe("auth.openai.com");
      expect(reloads).toEqual([["codex", ["codex"]]]);
      expect(opened.lines).toEqual([
        `Sign in to ChatGPT in the Environment browser: ${view}`,
        "Waiting for you to finish the sign-in. Ctrl-C cancels.",
        "Signed in. Asking the running services (the Codex app-server, Chat) to use the new sign-in…",
        "codex: signed in.",
        "The Codex app-server was restarted, so Codex clients of this Environment use the new sign-in.",
        "Chat (T3 Code) turned on and read again: codex ready.",
      ]);
      // The page's address itself is never printed on a Remote Environment.
      expect(opened.lines.join("\n").includes(pages[0] as string)).toBe(false);
    } finally {
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "nothing starts without the Environment browser, where the Organization provides AI, or where the Environment cannot be read",
  async () => {
    const opened = await scratch();
    try {
      const without = await hostedFolder(
        join(opened.home, "env"),
        bindings.organizationEntry,
      );
      const base = {
        env: opened.env,
        platform: process.platform,
        write: (line: string) => opened.lines.push(line),
        openPage: async () => ({ view }),
      };
      const none = await runToolsCommand(["login", "claude", "--json"], {
        ...base,
        hostedFolder: async () => without,
      });
      expect(none.code).toBe(2);
      expect(opened.lines.map((line) => JSON.parse(line))).toEqual([
        { kind: "blocked", tool: "claude", reason: "no-environment-browser" },
      ]);
      opened.lines.length = 0;
      // Codex itself says the Organization's provider needs no sign-in.
      await writeFile(join(opened.home, "codex.provided"), "");
      const provided = await runToolsCommand(["login", "codex"], base);
      expect(provided.code).toBe(2);
      expect(provided.result).toEqual({
        kind: "blocked",
        tool: "codex",
        reason: "organization-provided",
      });
      expect(opened.lines).toEqual([
        "Your Organization provides AI in this Environment: Codex uses its provider and needs no ChatGPT sign-in. Nothing was started.",
      ]);
      const unreadable = await runToolsCommand(["login", "codex", "--json"], {
        ...base,
        hostedFolder: async () => {
          throw new Error("handover");
        },
      });
      expect(unreadable.code).toBe(1);
      expect(unreadable.result).toEqual({
        kind: "failed",
        tool: "codex",
        reason: "environment-unreadable",
      });
      // `codex login` never ran; only Codex's own answer about its provider.
      const calls = (await readFile(join(opened.home, "codex.calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).args);
      expect(calls).toEqual([["app-server"]]);
    } finally {
      await opened.close();
    }
  },
  30_000,
);

posixTest(
  "claude on a computer of one's own: the code its code page shows is pasted in the terminal",
  async () => {
    const opened = await scratch();
    try {
      const input = new PassThrough();
      const run = runToolsCommand(["login", "claude", "--json"], {
        env: opened.env,
        platform: process.platform,
        write: (line) => {
          opened.lines.push(line);
          const state = JSON.parse(line) as {
            challenge?: { url?: string; code?: boolean };
          };
          // The person opens the printed page and copies the code.
          if (state.challenge?.code === true && state.challenge.url)
            setTimeout(() => {
              input.write("not the whole code\n");
              input.write(`${codeOfPage(state.challenge?.url as string)}\n`);
            }, 100);
        },
        input,
        login: { firstChallengeMs: 5_000 },
      });
      const output = await run;
      expect(output.code).toBe(0);
      expect(output.result).toMatchObject({
        kind: "signed-in",
        tool: "claude",
        account: "person@example.com",
      });
      // Only the session's states, each a JSON object: the printed code page
      // with its field, then signed in.
      const states = opened.lines.map(
        (line) => JSON.parse(line) as { kind: string; challenge?: unknown },
      );
      expect(states[0]).toMatchObject({
        kind: "pending",
        challenge: { kind: "page", code: true },
      });
      expect(states.at(-1)).toMatchObject({ kind: "signed-in" });
    } finally {
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "a T3 Code that runs another driver under the provider's ID is a clear failure, after the sign-in",
  async () => {
    const opened = await scratch();
    try {
      const output = await runToolsCommand(["login", "codex"], {
        env: opened.env,
        platform: process.platform,
        write: (line) => {
          opened.lines.push(line);
          const match = /open: (\S+)$/.exec(line);
          if (match)
            setTimeout(() => void returnFromPage(match[1] as string), 100);
        },
        login: {
          firstChallengeMs: 5_000,
          reload: async () => ({
            appServer: { state: "not-managed" },
            t3: {
              state: "driver-mismatch",
              mismatches: [
                {
                  provider: "codex",
                  instanceId: "codex",
                  driver: "claudeAgent",
                },
              ],
            },
          }),
        },
      });
      expect(output.code).toBe(1);
      expect(output.result).toMatchObject({ kind: "signed-in", tool: "codex" });
      expect(opened.lines.at(-1)).toBe(
        'Chat (T3 Code) did NOT turn on codex: its provider "codex" runs the driver claudeAgent, not codex. Change or remove that provider in Chat\'s Settings → Providers, then sign in again.',
      );
    } finally {
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "T3 Code's answer must name an enabled instance of the CLI: an empty list exits 1 with why, one still checking exits 0 (Pablo's review of #441)",
  async () => {
    const opened = await scratch();
    try {
      // A `t3` with the refresh, answering what the test puts in t3.answer.
      const t3 = join(opened.home, "bin", "t3");
      await writeFile(
        t3,
        [
          "#!/bin/sh",
          '[ "$1" = lazurio ] || exit 2',
          'case "$2" in',
          '  capabilities) echo \'{"version":1,"managedFolder":true,"modelRecommendation":true,"providerRefresh":true}\' ;;',
          '  providers) cat "$HOME/t3.answer" ;;',
          "  *) exit 2 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(t3, 0o755);
      const answer = (providers: readonly object[]) =>
        writeFile(
          join(opened.home, "t3.answer"),
          `${JSON.stringify({ version: 1, providers })}\n`,
        );
      const signIn = () =>
        runToolsCommand(["login", "codex"], {
          env: opened.env,
          platform: process.platform,
          write: (line) => {
            opened.lines.push(line);
            const match = /open: (\S+)$/.exec(line);
            if (match)
              setTimeout(() => void returnFromPage(match[1] as string), 100);
          },
          login: { firstChallengeMs: 5_000 },
        });
      // No codex instance in T3's registry: an empty list.
      await answer([]);
      const empty = await signIn();
      expect(empty.code).toBe(1);
      expect(empty.result).toMatchObject({
        kind: "signed-in",
        tool: "codex",
        services: {
          t3: { state: "failed", reason: "not-enabled", providers: ["codex"] },
        },
      });
      expect(opened.lines.at(-1)).toBe(
        "Chat (T3 Code) did NOT turn on codex: it answered without an enabled codex provider. Check the providers in Chat's Settings → Providers, then sign in again.",
      );
      // Codex's instance still off.
      opened.lines.length = 0;
      await answer([
        {
          provider: "codex",
          instanceId: "codex",
          enabled: false,
          status: "disabled",
          auth: "unknown",
        },
      ]);
      expect((await signIn()).code).toBe(1);
      // Turned on and still checking its sign-in right after: that is on.
      opened.lines.length = 0;
      await answer([
        {
          provider: "codex",
          instanceId: "codex",
          enabled: true,
          status: "warning",
          auth: "unknown",
        },
      ]);
      const checking = await signIn();
      expect(checking.code).toBe(0);
      expect(opened.lines.at(-1)).toBe(
        "Chat (T3 Code) turned on and read again: codex turned on, its sign-in still being checked.",
      );
    } finally {
      await opened.close();
    }
  },
  30_000,
);

// ChatGPT's sign-in by code (root decision 0201 point 10, F19's addendum of
// 2026-10-21): the same command with `--device-code`, the browser sign-in's
// fallback, for codex only.

posixTest(
  "codex --device-code: without the Environment browser too, the page and the code are printed with the setting it needs, and the code entered signs it in",
  async () => {
    const opened = await scratch();
    try {
      const without = await hostedFolder(
        join(opened.home, "env"),
        bindings.organizationEntry,
      );
      const pages: string[] = [];
      const output = await runToolsCommand(
        ["login", "codex", "--device-code"],
        {
          env: opened.env,
          platform: process.platform,
          write: (line) => {
            opened.lines.push(line);
            // The person enters the printed code on OpenAI's page.
            if (line.includes(fakeAi.deviceCode))
              setTimeout(
                () => void writeFile(join(opened.home, "codex.approve"), ""),
                100,
              );
          },
          hostedFolder: async () => without,
          openPage: async (url) => {
            pages.push(url);
            return { view };
          },
          login: { firstChallengeMs: 5_000, reload: async () => reloaded },
        },
      );
      expect(output.code).toBe(0);
      expect(output.result).toEqual({
        kind: "signed-in",
        tool: "codex",
        services: reloaded,
      });
      // Nothing opened in an Environment browser.
      expect(pages).toEqual([]);
      expect(opened.lines).toEqual([
        "Sign in to ChatGPT on any device (phone or computer):",
        "  1. Open https://auth.openai.com/codex/device",
        `  2. Enter the code  ${fakeAi.deviceCode}`,
        "The code is valid for 15 minutes. If ChatGPT's page refuses it, turn sign-in with a code on in your ChatGPT security settings (for a work account, its admin allows it) and enter it again.",
        "Waiting for you to enter the code. Ctrl-C cancels.",
        "Signed in. Asking the running services (the Codex app-server, Chat) to use the new sign-in…",
        "codex: signed in.",
        "The Codex app-server was restarted, so Codex clients of this Environment use the new sign-in.",
        "Chat (T3 Code) turned on and read again: codex ready.",
      ]);
      const calls = (await readFile(join(opened.home, "codex.calls"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { args: string[]; browser: string | null },
        )
        .filter(
          (call) => call.args[0] === "login" && call.args[1] !== "status",
        );
      expect(calls).toEqual([
        { args: ["login", "--device-auth"], browser: null },
      ]);
    } finally {
      await opened.close();
    }
  },
  20_000,
);

posixTest(
  "--device-code is codex's alone, and only of login; the help says the browser sign-in is the default and the code its fallback",
  async () => {
    const opened = await scratch();
    try {
      const base = {
        env: opened.env,
        platform: process.platform,
        write: (line: string) => opened.lines.push(line),
      };
      const claude = await runToolsCommand(
        ["login", "claude", "--device-code"],
        base,
      );
      expect(claude.code).toBe(2);
      expect(claude.result).toEqual({
        kind: "blocked",
        reason: "device-code-codex-only",
        tool: "claude",
      });
      expect(claude.text).toBe(
        "--device-code applies to codex only (ChatGPT's sign-in with a code).",
      );
      const gh = await runToolsCommand(
        ["login", "gh", "--device-code", "--json"],
        base,
      );
      expect(gh.code).toBe(2);
      expect(JSON.parse(gh.text)).toEqual({
        kind: "blocked",
        reason: "device-code-codex-only",
        tool: "gh",
      });
      for (const args of [
        ["status", "--device-code"],
        ["logout", "codex", "--device-code"],
      ])
        await expect(runToolsCommand(args, base)).rejects.toBeInstanceOf(
          ToolsUsageError,
        );
      // Neither CLI ran.
      expect(
        await readFile(join(opened.home, "claude.calls"), "utf8").catch(
          () => "",
        ),
      ).toBe("");
      expect(opened.lines).toEqual([]);
      expect(toolsHelp).toContain(
        "tools login <tool> [--phone <+number>] [--ssh-key] [--device-code] [--json]",
      );
      expect(toolsHelp).not.toContain("never its device code");
      expect(toolsHelp.replace(/\s+/g, " ")).toContain(
        "--device-code (codex only) is the fallback",
      );
    } finally {
      await opened.close();
    }
  },
  20_000,
);
